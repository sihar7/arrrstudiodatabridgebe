process.env.DATABASE_URL = "memory://";
process.env.NODE_ENV = "test";
process.env.EMAIL_SIGNUP_ENABLED = "true";
process.env.ROBLOX_LOGIN_ENABLED = "true";
process.env.OC_RPS_PER_UNIVERSE = "1000";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

// Tes migration engine + explorer — Roblox Open Cloud v2 dipalsukan di memori (pagination, konflik, galat).
const { app } = await import("@/app");
const { db, migrate, closeDb } = await import("@/db");
const { workspaces } = await import("@/db/schema");

const realFetch = globalThis.fetch;
const KEY = "rbx-test-key-PHASE2-ABCDEFGHIJKLMNOPQRSTUV-9999";

type Rec = { value: unknown; users: string[]; attributes: Record<string, unknown> | null };
const stores = new Map<string, Map<string, Rec>>();
const store = (u: string, ds: string, scope = "global") => {
  const k = `${u}/${ds}/${scope}`;
  if (!stores.has(k)) stores.set(k, new Map());
  return stores.get(k)!;
};
let failKey: string | null = "Bad_1";
let writes = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.pathname === "/api-keys/v1/introspect") {
    return Response.json({
      name: "phase2",
      enabled: true,
      expired: false,
      scopes: [
        { name: "universe-datastores.objects", operations: ["list", "read", "create", "update"], universeIds: ["111111", "222222"] },
        { name: "universe-datastores.control", operations: ["list"], universeIds: ["111111", "222222"] },
      ],
    });
  }
  const m = url.pathname.match(/^\/cloud\/v2\/universes\/(\d+)\/data-stores\/([^/]+)\/scopes\/([^/]+)\/entries(?:\/(.+))?$/);
  if (m) {
    const [, u, ds, scope, rawKey] = m;
    const s = store(u!, decodeURIComponent(ds!), decodeURIComponent(scope!));
    const key = rawKey ? decodeURIComponent(rawKey) : url.searchParams.get("id");
    if (method === "GET" && !rawKey) {
      const prefix = url.searchParams.get("filter")?.match(/startsWith\("(.*)"\)/)?.[1] ?? "";
      const keys = [...s.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("pageToken") || 0);
      const page = keys.slice(start, start + 3); // halaman kecil → uji checkpoint cursor
      const next = start + 3 < keys.length ? String(start + 3) : "";
      return Response.json({ dataStoreEntries: page.map((k) => ({ id: k, path: `x/entries/${k}` })), nextPageToken: next });
    }
    if (method === "GET") {
      if (key === failKey) return Response.json({ message: "Forbidden" }, { status: 403 });
      const r = s.get(key!);
      return r ? Response.json({ id: key, ...r, revisionId: "r1" }) : Response.json({ message: "NOT_FOUND" }, { status: 404 });
    }
    const body = JSON.parse(String(init?.body)) as Rec;
    if (method === "POST") {
      if (s.has(key!)) return Response.json({ message: "Entry already exists" }, { status: 400 });
      writes++;
      s.set(key!, { value: body.value, users: body.users ?? [], attributes: body.attributes ?? null });
      return Response.json({ id: key, ...s.get(key!) });
    }
    if (method === "PATCH") {
      writes++;
      s.set(key!, { value: body.value, users: body.users ?? [], attributes: body.attributes ?? null });
      return Response.json({ id: key, ...s.get(key!) });
    }
  }
  if (url.pathname.startsWith("/cloud/v2/universes/")) return Response.json({ displayName: "Game" });
  return realFetch(input, init);
}) as typeof fetch;

let cookie = "";
let ws = "";
async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-requested-with": "databridge", cookie, "x-workspace-id": ws };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as { data?: any; meta?: any; error?: { code: string; details?: any } }, res };
}
async function waitDone(id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await call("GET", `/migrations/${id}`);
    if (!["queued", "running", "cancelling"].includes(r.json.data.status)) return r.json.data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("migration did not finish");
}

let srcCfg = "";
let dstCfg = "";
let projectId = "";

before(async () => {
  await migrate();
  const r = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: { "x-requested-with": "databridge", "content-type": "application/json" },
    body: JSON.stringify({ name: "Engine", email: "engine@example.com", password: "supersecret1" }),
  });
  cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  ws = ((await r.json()) as any).data.workspaces[0].id;
  await db.update(workspaces).set({ plan: "studio" }).where(eq(workspaces.id, ws));

  const src = store("111111", "PlayerData_V1");
  for (let i = 1; i <= 5; i++) src.set(`Player_${i}`, { value: { coins: i * 100, inv: ["sword"], nested: { lvl: i } }, users: [String(i)], attributes: { v: 1 } });
  src.set("Bad_1", { value: 1, users: [], attributes: null });
  src.set("Guild_1", { value: "guild", users: [], attributes: null });
  // Sudah ada di tujuan → konflik
  store("222222", "PlayerData_V2").set("Player_3", { value: { coins: 999 }, users: ["3"], attributes: null });

  const conn = await call("POST", "/connections", { name: "Key", apiKey: KEY });
  const p = await call("POST", "/projects", { name: "Engine test" });
  projectId = p.json.data.id;
  srcCfg = (await call("POST", `/projects/${projectId}/datastores`, { label: "Source", connectionId: conn.json.data.id, universeId: "111111", datastoreName: "PlayerData_V1" })).json.data.id;
  dstCfg = (await call("POST", `/projects/${projectId}/datastores`, { label: "Dest", connectionId: conn.json.data.id, universeId: "222222", datastoreName: "PlayerData_V2" })).json.data.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

describe("migration engine", () => {
  let id = "";

  test("create + validate; start requires a dry run (AC-05)", async () => {
    const r = await call("POST", "/migrations", { name: "V1 → V2", projectId, sourceConfigId: srcCfg, destinationConfigId: dstCfg });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    id = r.json.data.id;
    const v = await call("POST", `/migrations/${id}/validate?real=1`);
    assert.equal(v.json.data.ok, true, JSON.stringify(v.json.data));
    const s = await call("POST", `/migrations/${id}/start`, {});
    assert.equal(s.json.error?.code, "DRY_RUN_REQUIRED");
  });

  test("dry run writes nothing and reports conflicts (AC-06, AC-07)", async () => {
    const before = writes;
    await call("POST", `/migrations/${id}/dry-run`);
    const m = await waitDone(id);
    assert.equal(writes, before, "dry run must not write");
    assert.equal(m.progress.total, 7);
    assert.equal(m.progress.success, 6); // akan ditulis (dry run kilat tidak membaca isi key)
    assert.equal(m.progress.skipped, 1); // Player_3 sudah ada
    assert.equal(m.progress.failed, 0);
    assert.ok(m.lastDryRunAt);
  });

  test("real run copies value + users + attributes, verifies, skips existing (AC-08, AC-10, AC-11)", async () => {
    await call("POST", `/migrations/${id}/start`, {});
    const m = await waitDone(id);
    assert.equal(m.status, "completed_with_errors");
    assert.equal(m.progress.success, 5);
    assert.equal(m.progress.failed, 1);
    const dst = store("222222", "PlayerData_V2");
    assert.deepEqual(dst.get("Player_1"), { value: { coins: 100, inv: ["sword"], nested: { lvl: 1 } }, users: ["1"], attributes: { v: 1 } });
    assert.deepEqual(dst.get("Player_3")!.value, { coins: 999 }, "existing key must not be overwritten");
    assert.equal(store("111111", "PlayerData_V1").size, 7, "source untouched");
    const failed = await call("GET", `/migrations/${id}/items?status=failed`);
    assert.equal(failed.json.data[0].sourceKey, "Bad_1");
    assert.equal(failed.json.data[0].errorCode, "ROBLOX_PERMISSION");
    const logs = await call("GET", `/migrations/${id}/logs`);
    assert.ok(logs.json.data.length >= 3);
  });

  test("retry failed only re-processes failed keys (AC-09)", async () => {
    failKey = null;
    const before = writes;
    await call("POST", `/migrations/${id}/retry-failed`);
    const m = await waitDone(id);
    assert.equal(m.status, "completed"); // key yang dilewati (sudah ada) bukan galat
    assert.equal(m.progress.failed, 0);
    assert.equal(m.progress.success, 6);
    assert.equal(writes - before, 1, "only the failed key is written again");
  });

  test("overwrite needs explicit confirmation; rename_key writes to new keys", async () => {
    const o = await call("POST", "/migrations", { name: "Overwrite", projectId, sourceConfigId: srcCfg, destinationConfigId: dstCfg, mode: "selected", selectedKeys: ["Player_3"], conflictStrategy: "overwrite" });
    await call("POST", `/migrations/${o.json.data.id}/dry-run`);
    await waitDone(o.json.data.id);
    const noConfirm = await call("POST", `/migrations/${o.json.data.id}/start`, {});
    assert.equal(noConfirm.json.error?.code, "CONFIRM_OVERWRITE");
    await call("POST", `/migrations/${o.json.data.id}/start`, { confirm: "OVERWRITE" });
    const om = await waitDone(o.json.data.id);
    assert.equal(om.status, "completed");
    assert.deepEqual(store("222222", "PlayerData_V2").get("Player_3")!.value, { coins: 300, inv: ["sword"], nested: { lvl: 3 } });

    const r = await call("POST", "/migrations", { name: "Rename", projectId, sourceConfigId: srcCfg, destinationConfigId: dstCfg, mode: "prefix", prefix: "Guild_", conflictStrategy: "rename_key", renamePattern: "v2_{key}" });
    await call("POST", `/migrations/${r.json.data.id}/dry-run`);
    await waitDone(r.json.data.id);
    await call("POST", `/migrations/${r.json.data.id}/start`, {});
    const rm = await waitDone(r.json.data.id);
    assert.equal(rm.progress.success, 1);
    assert.equal(store("222222", "PlayerData_V2").get("v2_Guild_1")!.value, "guild");
  });

  test("same DataStore as source and destination is rejected", async () => {
    const r = await call("POST", "/migrations", { name: "Same", projectId, sourceConfigId: srcCfg, destinationConfigId: srcCfg });
    const v = await call("POST", `/migrations/${r.json.data.id}/validate`);
    assert.equal(v.json.data.ok, false);
    assert.equal(v.json.data.errors[0].code, "SAME_DATASTORE");
  });

  test("free plan: selective modes are a paid feature", async () => {
    await db.update(workspaces).set({ plan: "free" }).where(eq(workspaces.id, ws));
    const r = await call("POST", "/migrations", { name: "Prefix", projectId, sourceConfigId: srcCfg, destinationConfigId: dstCfg, mode: "prefix", prefix: "Player_" });
    const d = await call("POST", `/migrations/${r.json.data.id}/dry-run`);
    assert.equal(d.json.error?.code, "MIGRATION_INVALID");
    assert.ok(d.json.error?.details.errors.some((e: { code: string }) => e.code === "PLAN_FEATURE"));
    await db.update(workspaces).set({ plan: "studio" }).where(eq(workspaces.id, ws));
  });
});

describe("data explorer (read-only)", () => {
  test("lists keys with pagination and reads an entry", async () => {
    const p1 = await call("GET", `/explorer/${srcCfg}/keys`);
    assert.equal(p1.json.data.length, 3);
    assert.ok(p1.json.meta.nextPageToken);
    const e = await call("GET", `/explorer/${srcCfg}/entry?key=Player_2`);
    assert.deepEqual(e.json.data.value, { coins: 200, inv: ["sword"], nested: { lvl: 2 } });
    assert.deepEqual(e.json.data.users, ["2"]);
    assert.ok(e.json.data.size > 0);
  });
});
