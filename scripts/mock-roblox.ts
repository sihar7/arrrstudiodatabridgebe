import { serve } from "@hono/node-server";
import { Hono } from "hono";

// Server Roblox Open Cloud + OAuth TIRUAN untuk dev & rekaman demo (BUKAN untuk produksi).
// Jalankan: npm run mock:roblox → set OC_BASE_URL=http://localhost:8090 di api/.env (diabaikan saat produksi).
// Data contoh: 2 experience, PlayerData_V1 (240 key) → PlayerData_V2 (beberapa key sudah ada).

const PORT = Number(process.env.MOCK_PORT ?? 8090);
const LATENCY = Number(process.env.MOCK_LATENCY_MS ?? 40);
const UNIVERSES: Record<string, string> = { "4812233190": "Obby Remake", "5590012345": "Obby Remake 2" };

type Rec = { value: unknown; users: string[]; attributes: Record<string, unknown> | null; created: string; updated: string; rev: number };
const stores = new Map<string, Map<string, Rec>>();
const store = (u: string, ds: string, scope = "global") => {
  const k = `${u}/${ds}/${scope}`;
  if (!stores.has(k)) stores.set(k, new Map());
  return stores.get(k)!;
};
const now = () => new Date().toISOString();
const put = (s: Map<string, Rec>, key: string, value: unknown, users: string[] = [], attributes: Record<string, unknown> | null = null) =>
  s.set(key, { value, users, attributes, created: s.get(key)?.created ?? now(), updated: now(), rev: (s.get(key)?.rev ?? 0) + 1 });

// Seed
const src = store("4812233190", "PlayerData_V1");
for (let i = 1; i <= 240; i++) {
  const id = 100000 + i * 37;
  put(src, `Player_${id}`, { coins: (i * 137) % 9000, level: 1 + (i % 60), inventory: ["Sword", i % 3 ? "Shield" : "Bow"], settings: { music: i % 2 === 0 } }, [String(id)], { schema: 1 });
}
store("4812233190", "Settings");
store("4812233190", "Leaderboard_Wins");
const dst = store("5590012345", "PlayerData_V2");
put(dst, "Player_100037", { coins: 50, level: 1 }, ["100037"]);
put(dst, "Player_100074", { coins: 12, level: 1 }, ["100074"]);

const app = new Hono();
app.use(async (_c, next) => {
  await new Promise((r) => setTimeout(r, LATENCY * (0.6 + Math.random() * 0.8)));
  await next();
});

const SCOPES = [
  { name: "universe-datastores.objects", operations: ["list", "read", "create", "update"], universeIds: Object.keys(UNIVERSES) },
  { name: "universe-datastores.control", operations: ["list"], universeIds: Object.keys(UNIVERSES) },
];

app.post("/api-keys/v1/introspect", async (c) => {
  const { apiKey } = await c.req.json<{ apiKey: string }>();
  if (!apiKey.startsWith("demo")) return c.json({ message: "Invalid API Key" }, 401);
  return c.json({ name: "DataBridge demo", authorizedUserId: 777, enabled: true, expired: false, expirationTimeUtc: null, scopes: SCOPES });
});

app.get("/universes/v1/places/:placeId/universe", (c) => c.json({ universeId: Number(Object.keys(UNIVERSES)[0]) }));
app.get("/cloud/v2/universes/:u", (c) => {
  const name = UNIVERSES[c.req.param("u")];
  return name ? c.json({ path: `universes/${c.req.param("u")}`, displayName: name }) : c.json({ message: "NOT_FOUND" }, 404);
});
app.get("/cloud/v2/universes/:u/data-stores", (c) => {
  const u = c.req.param("u");
  const ids = [...stores.keys()].filter((k) => k.startsWith(`${u}/`)).map((k) => k.split("/")[1]!);
  return c.json({ dataStores: [...new Set(ids)].map((id) => ({ id, createTime: now() })), nextPageToken: "" });
});

const entries = "/cloud/v2/universes/:u/data-stores/:ds/scopes/:scope/entries";
app.get(entries, (c) => {
  const s = store(c.req.param("u"), c.req.param("ds"), c.req.param("scope"));
  const prefix = c.req.query("filter")?.match(/startsWith\("(.*)"\)/)?.[1] ?? "";
  const keys = [...s.keys()].filter((k) => k.startsWith(prefix)).sort();
  const size = Math.min(Number(c.req.query("maxPageSize") ?? 10), 100);
  const start = Number(c.req.query("pageToken") || 0);
  const next = start + size < keys.length ? String(start + size) : "";
  return c.json({ dataStoreEntries: keys.slice(start, start + size).map((id) => ({ id, path: `entries/${id}` })), nextPageToken: next });
});
app.get(`${entries}/:key`, (c) => {
  const r = store(c.req.param("u"), c.req.param("ds"), c.req.param("scope")).get(c.req.param("key"));
  if (!r) return c.json({ message: "NOT_FOUND" }, 404);
  return c.json({ id: c.req.param("key"), value: r.value, users: r.users, attributes: r.attributes, revisionId: `r${r.rev}`, createTime: r.created, revisionCreateTime: r.updated, state: "ACTIVE" });
});
app.post(entries, async (c) => {
  const s = store(c.req.param("u"), c.req.param("ds"), c.req.param("scope"));
  const key = c.req.query("id")!;
  if (s.has(key)) return c.json({ message: "Entry already exists" }, 400);
  const b = await c.req.json<{ value: unknown; users?: string[]; attributes?: Record<string, unknown> }>();
  put(s, key, b.value, b.users ?? [], b.attributes ?? null);
  return c.json({ id: key, value: b.value });
});
app.patch(`${entries}/:key`, async (c) => {
  const s = store(c.req.param("u"), c.req.param("ds"), c.req.param("scope"));
  const b = await c.req.json<{ value: unknown; users?: string[]; attributes?: Record<string, unknown> }>();
  put(s, c.req.param("key"), b.value, b.users ?? [], b.attributes ?? null);
  return c.json({ id: c.req.param("key"), value: b.value });
});

// OAuth tiruan: consent otomatis disetujui
app.get("/oauth/v1/authorize", (c) => {
  const q = new URL(c.req.url).searchParams;
  return c.redirect(`${q.get("redirect_uri")}?code=${q.get("scope")?.includes("datastores") ? "connect" : "login"}&state=${q.get("state")}`);
});
app.post("/oauth/v1/token", async (c) => {
  const p = new URLSearchParams(await c.req.text());
  const scope = p.get("code") === "connect" || p.get("grant_type") === "refresh_token" ? "openid profile universe-datastores.objects:list universe-datastores.objects:read universe-datastores.objects:create universe-datastores.objects:update universe-datastores.control:list" : "openid profile";
  return c.json({ access_token: `demo-at-${Date.now()}`, refresh_token: `demo-rt-${Date.now()}`, expires_in: 899, scope, token_type: "Bearer" });
});
app.get("/oauth/v1/userinfo", (c) => c.json({ sub: "777", preferred_username: "ArrBuilder", name: "Arr Builder", picture: null }));
app.post("/oauth/v1/token/resources", (c) => c.json({ resource_infos: [{ owner: { id: "777", type: "User" }, resources: { universe: { ids: Object.keys(UNIVERSES) } } }] }));
app.post("/oauth/v1/token/revoke", (c) => c.body(null, 200));

serve({ fetch: app.fetch, port: PORT }, () => console.log(`[mock-roblox] http://localhost:${PORT} (${src.size} keys seeded)`));
