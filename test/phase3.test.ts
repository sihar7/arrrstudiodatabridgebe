process.env.DATABASE_URL = "memory://";
process.env.NODE_ENV = "test";
process.env.ADMIN_EMAILS = "boss@arrrstudio.com";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

// Tes billing QRIS manual + panel admin.
const { app } = await import("@/app");
const { db, migrate, closeDb } = await import("@/db");
const { workspaces } = await import("@/db/schema");

type S = { cookie: string; ws: string };
async function register(email: string): Promise<S> {
  const r = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: { "x-requested-with": "databridge", "content-type": "application/json" },
    body: JSON.stringify({ name: "User", email, password: "supersecret1" }),
  });
  return { cookie: r.headers.get("set-cookie")!.split(";")[0]!, ws: ((await r.json()) as any).data.workspaces[0].id };
}
async function call(s: S, method: string, path: string, body?: unknown | FormData) {
  const headers: Record<string, string> = { "x-requested-with": "databridge", cookie: s.cookie, "x-workspace-id": s.ws };
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers["content-type"] = "application/json";
  const res = await app.request(`/api/v1${path}`, { method, headers, body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, json: ct.includes("json") ? ((await res.json()) as any) : null, res };
}

let user: S;
let admin: S;
before(async () => {
  await migrate();
  user = await register("dev@example.com");
  admin = await register("boss@arrrstudio.com");
});
after(() => closeDb());

describe("billing (QRIS manual)", () => {
  let orderId = "";
  test("price, order with unique code, proof upload", async () => {
    const b = await call(user, "GET", "/billing");
    assert.equal(b.json.data.plan, "free");
    assert.equal(b.json.data.prices.developer["1"], 49000);
    assert.equal(b.json.data.prices.studio["12"], 1520000); // 149k × 12 − 15%
    const o = await call(user, "POST", "/billing/orders", { plan: "studio", months: 1 });
    assert.equal(o.status, 201);
    orderId = o.json.data.id;
    assert.equal(o.json.data.amountIdr, 149000 + o.json.data.uniqueCode);
    const bad = new FormData();
    bad.append("file", new File(["hi"], "x.txt", { type: "text/plain" }));
    assert.equal((await call(user, "POST", `/billing/orders/${orderId}/proof`, bad)).status, 422);
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], "proof.png", { type: "image/png" }));
    const p = await call(user, "POST", `/billing/orders/${orderId}/proof`, fd);
    assert.equal(p.json.data.status, "awaiting_review");
    assert.equal(p.json.data.hasProof, true);
    assert.equal(p.json.data.proofData, undefined, "proof bytes never returned in lists");
  });

  test("admin approves → plan active with expiry; non-admin cannot see admin", async () => {
    assert.equal((await call(user, "GET", "/admin/stats")).status, 404);
    const me = await call(admin, "GET", "/auth/me");
    assert.equal(me.json.data.user.isAdmin, true);
    const stats = await call(admin, "GET", "/admin/stats");
    assert.equal(stats.json.data.pendingOrders, 1);
    const proof = await call(admin, "GET", `/admin/orders/${orderId}/proof`);
    assert.equal(proof.res.headers.get("content-type"), "image/png");
    const ap = await call(admin, "POST", `/admin/orders/${orderId}/approve`);
    assert.equal(ap.json.data.status, "paid");
    const b = await call(user, "GET", "/billing");
    assert.equal(b.json.data.plan, "studio");
    assert.ok(new Date(b.json.data.planExpiresAt) > new Date());
    assert.equal((await call(admin, "POST", `/admin/orders/${orderId}/approve`)).json.error.code, "INVALID_STATE");
  });

  test("expired paid plan falls back to free limits", async () => {
    await db.update(workspaces).set({ plan: "studio", planExpiresAt: new Date(Date.now() - 1000) }).where(eq(workspaces.id, user.ws));
    const b = await call(user, "GET", "/billing");
    assert.equal(b.json.data.plan, "free");
    await call(user, "POST", "/projects", { name: "One" });
    const second = await call(user, "POST", "/projects", { name: "Two" });
    assert.equal(second.json.error.code, "PLAN_LIMIT");
  });

  test("admin can change a workspace plan and reject orders", async () => {
    const w = await call(admin, "PATCH", `/admin/workspaces/${user.ws}`, { plan: "enterprise", planExpiresAt: null });
    assert.equal(w.json.data.plan, "enterprise");
    const o = await call(user, "POST", "/billing/orders", { plan: "developer", months: 3 });
    const r = await call(admin, "POST", `/admin/orders/${o.json.data.id}/reject`, { note: "Nominal tidak cocok" });
    assert.equal(r.json.data.status, "rejected");
    const list = await call(admin, "GET", "/admin/workspaces?q=User");
    assert.ok(list.json.data.length >= 1);
  });
});
