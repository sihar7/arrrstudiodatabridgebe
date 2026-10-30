process.env.DATABASE_URL = "memory://";
process.env.NODE_ENV = "test";
process.env.EMAIL_SIGNUP_ENABLED = "true";
process.env.ROBLOX_LOGIN_ENABLED = "true";
process.env.ADMIN_EMAIL = "owner@arrrstudio.com";
process.env.ADMIN_PASSWORD = "correct-horse-battery";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

// Admin hanya email+password dari env: bootstrap, Enterprise, tidak bisa lewat Roblox, reset semua data.
const { app } = await import("@/app");
const { db, migrate, closeDb } = await import("@/db");
const { users, workspaces } = await import("@/db/schema");
const { ensureAdmin } = await import("@/lib/admin");

const H = { "x-requested-with": "databridge", "content-type": "application/json" };
async function login(email: string, password: string) {
  const r = await app.request("/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ email, password }) });
  return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "", json: (await r.json()) as any };
}
const get = async (cookie: string, path: string) => (await (await app.request(`/api/v1${path}`, { headers: { cookie } })).json()) as any;

before(async () => {
  await migrate();
  await ensureAdmin();
});
after(() => closeDb());

describe("platform admin", () => {
  test("bootstrap creates admin from env with an Enterprise workspace", async () => {
    const l = await login("owner@arrrstudio.com", "correct-horse-battery");
    assert.equal(l.status, 200);
    assert.equal(l.json.data.user.isAdmin, true);
    assert.equal(l.json.data.workspaces[0].plan, "enterprise");
    assert.equal((await login("owner@arrrstudio.com", "wrong-password")).status, 401);
  });

  test("an admin account with a Roblox link is never treated as admin", async () => {
    await db.update(users).set({ robloxUserId: "999", robloxUsername: "Hijack" }).where(eq(users.email, "owner@arrrstudio.com"));
    const l = await login("owner@arrrstudio.com", "correct-horse-battery");
    assert.equal(l.json.data.user.isAdmin, false);
    assert.equal((await app.request("/api/v1/admin/stats", { headers: { cookie: l.cookie } })).status, 404);
    await ensureAdmin(); // bootstrap melepas tautan Roblox dari akun admin
    const again = await login("owner@arrrstudio.com", "correct-horse-battery");
    assert.equal(again.json.data.user.isAdmin, true);
  });

  test("reset all data keeps only the admin (with a fresh Enterprise workspace)", async () => {
    const reg = await app.request("/api/v1/auth/register", { method: "POST", headers: H, body: JSON.stringify({ name: "Player", email: "p@example.com", password: "supersecret1" }) });
    const userCookie = reg.headers.get("set-cookie")!.split(";")[0]!;
    const denied = await app.request("/api/v1/admin/reset", { method: "POST", headers: { ...H, cookie: userCookie }, body: JSON.stringify({ confirm: "RESET ALL DATA" }) });
    assert.equal(denied.status, 404);

    const admin = await login("owner@arrrstudio.com", "correct-horse-battery");
    const bad = await app.request("/api/v1/admin/reset", { method: "POST", headers: { ...H, cookie: admin.cookie }, body: JSON.stringify({ confirm: "yes" }) });
    assert.equal(bad.status, 400);
    const r = await app.request("/api/v1/admin/reset", { method: "POST", headers: { ...H, cookie: admin.cookie }, body: JSON.stringify({ confirm: "RESET ALL DATA" }) });
    const counts = ((await r.json()) as any).data;
    assert.ok(counts.users >= 1);

    const left = await db.select().from(users);
    assert.deepEqual(left.map((u) => u.email), ["owner@arrrstudio.com"]);
    const me = await get(admin.cookie, "/auth/me");
    assert.equal(me.data.user.isAdmin, true, "admin session survives reset");
    assert.equal(me.data.workspaces.length, 1);
    assert.equal(me.data.workspaces[0].plan, "enterprise");
    assert.equal((await db.select().from(workspaces)).length, 1);
    assert.equal((await app.request("/api/v1/auth/me", { headers: { cookie: userCookie } })).status, 401);
  });
});
