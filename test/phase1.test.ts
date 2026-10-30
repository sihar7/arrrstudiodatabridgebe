process.env.DATABASE_URL = "memory://";
process.env.NODE_ENV = "test";
process.env.EMAIL_SIGNUP_ENABLED = "true";
process.env.ROBLOX_LOGIN_ENABLED = "true";

import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { after, before, describe, test } from "node:test";

// Tes integrasi Fase 1 — DB PGlite in-memory, Open Cloud di-mock lewat global fetch.
const { app } = await import("@/app");
const { db, migrate, closeDb } = await import("@/db");
const { robloxConnections, workspaces } = await import("@/db/schema");

const realFetch = globalThis.fetch;
const FAKE_KEY = "rbx-test-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ-1234";

// Mock Roblox: introspect sukses untuk FAKE_KEY, 401 untuk key lain
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api-keys/v1/introspect")) {
    const { apiKey } = JSON.parse(String(init?.body));
    if (apiKey !== FAKE_KEY) return new Response(JSON.stringify({ message: "Invalid API Key" }), { status: 401 });
    return Response.json({
      name: "DataBridge test",
      authorizedUserId: 42,
      enabled: true,
      expired: false,
      expirationTimeUtc: null,
      scopes: [
        { name: "universe-datastores.objects", operations: ["list", "read", "create", "update"], universeDatastores: [{ universeId: "111111", datastoreName: "*" }] },
        { name: "universe-datastores.control", operations: ["list"], universeIds: ["111111"] },
      ],
    });
  }
  if (url.includes("/cloud/v2/universes/111111/data-stores")) {
    return Response.json({ dataStores: [{ id: "PlayerData_V1", createTime: "2026-01-01T00:00:00Z" }], nextPageToken: "" });
  }
  if (url.includes("/cloud/v2/universes/")) return Response.json({ displayName: "Test Experience" });
  return realFetch(input, init);
}) as typeof fetch;

type Session = { cookie: string; ws: string };

async function call(method: string, path: string, opts: { body?: unknown; s?: Session; csrf?: boolean; ws?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.csrf !== false) headers["x-requested-with"] = "databridge";
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.s) headers.cookie = opts.s.cookie;
  const ws = opts.ws ?? opts.s?.ws;
  if (ws) headers["x-workspace-id"] = ws;
  const res = await app.request(`/api/v1${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const json = (await res.json()) as { data?: any; error?: { code: string } };
  return { status: res.status, json, res };
}

async function register(name: string, email: string, plan?: "studio"): Promise<Session> {
  const r = await call("POST", "/auth/register", { body: { name, email, password: "supersecret1" } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const cookie = r.res.headers.get("set-cookie")!.split(";")[0]!;
  const ws = r.json.data.workspaces[0].id;
  if (plan) await db.update(workspaces).set({ plan }).where(eq(workspaces.id, ws));
  return { cookie, ws };
}

let alice: Session;
let bob: Session;

before(async () => {
  await migrate();
  alice = await register("Alice Dev", "alice@example.com", "studio");
  bob = await register("Bob Studio", "bob@example.com", "studio");
});

after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

describe("auth & workspace (AC-01)", () => {
  test("register creates owner workspace; me works; duplicate email rejected", async () => {
    const me = await call("GET", "/auth/me", { s: alice });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.user.email, "alice@example.com");
    assert.equal(me.json.data.workspaces[0].role, "owner");
    const dup = await call("POST", "/auth/register", { body: { name: "X", email: "ALICE@example.com", password: "supersecret1" } });
    assert.equal(dup.json.error?.code, "EMAIL_TAKEN");
  });

  test("login with wrong password → INVALID_CREDENTIALS; right password → session", async () => {
    const bad = await call("POST", "/auth/login", { body: { email: "alice@example.com", password: "nope-nope" } });
    assert.equal(bad.status, 401);
    const good = await call("POST", "/auth/login", { body: { email: "alice@example.com", password: "supersecret1" } });
    assert.equal(good.status, 200);
    assert.match(good.res.headers.get("set-cookie") ?? "", /HttpOnly/i);
  });

  test("mutations without CSRF header are rejected", async () => {
    const r = await call("POST", "/workspaces", { s: alice, body: { name: "No CSRF" }, csrf: false });
    assert.equal(r.json.error?.code, "CSRF");
  });

  test("create studio workspace & invite member with role", async () => {
    const ws = await call("POST", "/workspaces", { s: alice, body: { name: "Arrr Studio", type: "studio" } });
    assert.equal(ws.status, 201);
    // Paket free = 1 seat → undangan ditolak sampai paket dinaikkan
    const blocked = await call("POST", `/workspaces/${ws.json.data.id}/members`, { s: alice, body: { email: "bob@example.com", role: "viewer" } });
    assert.equal(blocked.json.error?.code, "PLAN_LIMIT");
    await db.update(workspaces).set({ plan: "studio" }).where(eq(workspaces.id, ws.json.data.id));
    const inv = await call("POST", `/workspaces/${ws.json.data.id}/members`, { s: alice, body: { email: "bob@example.com", role: "viewer" } });
    assert.equal(inv.status, 201);
    const members = await call("GET", `/workspaces/${ws.json.data.id}/members`, { s: bob });
    assert.equal(members.json.data.length, 2);
    // Viewer tidak boleh membuat project di workspace itu
    const p = await call("POST", "/projects", { s: bob, ws: ws.json.data.id, body: { name: "Nope" } });
    assert.equal(p.status, 403);
    // Owner terakhir tidak bisa diturunkan
    const me = await call("GET", "/auth/me", { s: alice });
    const demote = await call("PATCH", `/workspaces/${ws.json.data.id}/members/${me.json.data.user.id}`, { s: alice, body: { role: "admin" } });
    assert.equal(demote.json.error?.code, "LAST_OWNER");
  });
});

describe("connections (AC-02, AC-03)", () => {
  let connId = "";

  test("create connection: key tested, encrypted, never returned", async () => {
    const r = await call("POST", "/connections", { s: alice, body: { name: "Main key", apiKey: FAKE_KEY } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    connId = r.json.data.id;
    assert.equal(r.json.data.status, "active");
    assert.equal(r.json.data.keyHint, "••••1234");
    assert.equal(r.json.data.key.capabilities.read, true);
    assert.deepEqual(r.json.data.key.universes.ids, ["111111"]);
    assert.ok(!JSON.stringify(r.json).includes(FAKE_KEY), "plaintext key leaked in response");
    const rows = await db.select().from(robloxConnections);
    assert.ok(rows.every((row) => !(row.encryptedApiKey ?? "").includes(FAKE_KEY)), "plaintext key stored");
  });

  test("duplicate key rejected; invalid key stored as invalid", async () => {
    const dup = await call("POST", "/connections", { s: alice, body: { name: "Again", apiKey: FAKE_KEY } });
    assert.equal(dup.json.error?.code, "DUPLICATE_KEY");
    const bad = await call("POST", "/connections", { s: alice, body: { name: "Bad", apiKey: "rbx-wrong-key-000000000000000000" } });
    assert.equal(bad.json.data.status, "invalid");
  });

  test("test + universes + datastores listing", async () => {
    const t = await call("POST", `/connections/${connId}/test`, { s: alice });
    assert.equal(t.json.data.status, "active");
    const u = await call("GET", `/connections/${connId}/universes`, { s: alice });
    assert.deepEqual(u.json.data.universes, [{ id: "111111", name: "Test Experience" }]);
    const d = await call("GET", `/connections/${connId}/universes/111111/datastores`, { s: alice });
    assert.equal(d.json.data[0].id, "PlayerData_V1");
  });

  test("project + datastore config; connection in use cannot be deleted", async () => {
    const p = await call("POST", "/projects", { s: alice, body: { name: "Obby Remake" } });
    assert.equal(p.status, 201);
    const cfg = await call("POST", `/projects/${p.json.data.id}/datastores`, {
      s: alice,
      body: { label: "Source", connectionId: connId, universeId: "111111", placeId: "999", datastoreName: "PlayerData_V1" },
    });
    assert.equal(cfg.status, 201, JSON.stringify(cfg.json));
    assert.equal(cfg.json.data.universeName, "Test Experience");
    assert.equal(cfg.json.data.scope, "global");
    const dup = await call("POST", `/projects/${p.json.data.id}/datastores`, {
      s: alice,
      body: { label: "Again", connectionId: connId, universeId: "111111", datastoreName: "PlayerData_V1" },
    });
    assert.equal(dup.json.error?.code, "DUPLICATE_DATASTORE");
    const del = await call("DELETE", `/connections/${connId}`, { s: alice });
    assert.equal(del.json.error?.code, "CONNECTION_IN_USE");
    const list = await call("GET", "/projects", { s: alice });
    assert.equal(list.json.data[0].datastoreCount, 1);
    const stats = await call("GET", "/analytics/overview", { s: alice });
    assert.deepEqual(stats.json.data, { projects: 1, connections: 2, activeConnections: 1, datastores: 1, experiences: 1 });
  });
});

describe("tenant isolation (AC-12)", () => {
  test("bob cannot see or use alice's workspace resources", async () => {
    const conns = await call("GET", "/connections", { s: bob, ws: alice.ws });
    assert.equal(conns.status, 404);
    const aliceConns = await call("GET", "/connections", { s: alice });
    const id = aliceConns.json.data[0].id;
    const viaOwn = await call("GET", `/connections/${id}`, { s: bob });
    assert.equal(viaOwn.status, 404);
    const projects = await call("GET", "/projects", { s: alice });
    const pid = projects.json.data[0].id;
    const steal = await call("GET", `/projects/${pid}/datastores`, { s: bob });
    assert.equal(steal.status, 404);
    // Bob tidak bisa memakai koneksi alice di project miliknya sendiri
    const bp = await call("POST", "/projects", { s: bob, body: { name: "Bob game" } });
    const cross = await call("POST", `/projects/${bp.json.data.id}/datastores`, {
      s: bob,
      body: { label: "X", connectionId: id, universeId: "111111", datastoreName: "PlayerData_V1" },
    });
    assert.equal(cross.status, 404);
  });

  test("unauthenticated requests rejected", async () => {
    const r = await call("GET", "/projects", { ws: alice.ws });
    assert.equal(r.status, 401);
  });
});
