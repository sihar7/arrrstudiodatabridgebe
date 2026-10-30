process.env.DATABASE_URL = "memory://";
process.env.NODE_ENV = "test";
process.env.ROBLOX_OAUTH_CLIENT_ID = "test-client";
process.env.ROBLOX_OAUTH_CLIENT_SECRET = "test-secret";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

// Tes alur OAuth Roblox (login, undangan berdasarkan username, Connect with Roblox) dengan endpoint Roblox palsu.
const { app } = await import("@/app");
const { db, migrate, closeDb } = await import("@/db");
const { workspaces, robloxConnections } = await import("@/db/schema");

const realFetch = globalThis.fetch;
let tokenCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/oauth/v1/token")) {
    tokenCalls++;
    const p = new URLSearchParams(String(init?.body));
    assert.equal(p.get("client_secret"), "test-secret");
    const scope = p.get("code") === "connect-code" ? "openid profile universe-datastores.objects:read universe-datastores.objects:list universe-datastores.objects:create" : "openid profile";
    return Response.json({ access_token: `at-${tokenCalls}`, refresh_token: `rt-${tokenCalls}`, expires_in: 899, scope, token_type: "Bearer" });
  }
  if (url.endsWith("/oauth/v1/userinfo")) return Response.json({ sub: "777", preferred_username: "ArrBuilder", name: "Arr Builder", picture: "https://tr.rbxcdn.com/x/150/150/AvatarHeadshot/Png" });
  if (url.endsWith("/oauth/v1/token/resources")) return Response.json({ resource_infos: [{ owner: { id: "777", type: "User" }, resources: { universe: { ids: ["555"] } } }] });
  if (url.endsWith("/oauth/v1/token/revoke")) return new Response("", { status: 200 });
  if (url.includes("users.roblox.com/v1/usernames/users")) return Response.json({ data: [{ id: 777, name: "ArrBuilder", displayName: "Arr Builder" }] });
  if (url.includes("thumbnails.roblox.com")) return Response.json({ data: [{ state: "Completed", imageUrl: "https://tr.rbxcdn.com/x.png" }] });
  return realFetch(input, init);
}) as typeof fetch;

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

/** start → (Roblox) → callback; kembalikan respons callback. */
async function oauthRoundTrip(query: string, code: string, sessionCookie?: string) {
  const start = await app.request(`/api/v1/auth/roblox/start?${query}`, { headers: sessionCookie ? { cookie: sessionCookie } : {} });
  assert.equal(start.status, 302, await start.clone().text());
  const loc = new URL(start.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, "https://apis.roblox.com/oauth/v1/authorize");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  const state = loc.searchParams.get("state")!;
  const stateCookie = cookieOf(start, "dbr_oauth")!;
  return app.request(`/api/v1/auth/roblox/callback?code=${code}&state=${state}`, {
    headers: { cookie: [stateCookie, sessionCookie].filter(Boolean).join("; ") },
  });
}

let owner = { cookie: "", ws: "" };
before(async () => {
  await migrate();
  const r = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: { "x-requested-with": "databridge", "content-type": "application/json" },
    body: JSON.stringify({ name: "Owner", email: "owner@example.com", password: "supersecret1" }),
  });
  owner = { cookie: r.headers.get("set-cookie")!.split(";")[0]!, ws: ((await r.json()) as any).data.workspaces[0].id };
  await db.update(workspaces).set({ plan: "studio" }).where(eq(workspaces.id, owner.ws));
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

describe("Roblox OAuth", () => {
  test("invite by Roblox username → pending; Sign in with Roblox accepts it", async () => {
    const inv = await app.request(`/api/v1/workspaces/${owner.ws}/invites`, {
      method: "POST",
      headers: { "x-requested-with": "databridge", "content-type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ username: "ArrBuilder", role: "developer" }),
    });
    const ij = (await inv.json()) as any;
    assert.equal(ij.data.type, "invite");
    assert.equal(ij.data.username, "ArrBuilder");

    const cb = await oauthRoundTrip("intent=login", "login-code");
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get("location")!, /\/dashboard$/);
    const session = cookieOf(cb, "dbr_session")!;
    const me = (await (await app.request("/api/v1/auth/me", { headers: { cookie: session } })).json()) as any;
    assert.equal(me.data.user.roblox.username, "ArrBuilder");
    assert.equal(me.data.user.email, null);
    assert.ok(me.data.workspaces.some((w: { id: string; role: string }) => w.id === owner.ws && w.role === "developer"), "invite accepted");
  });

  test("tampered state is rejected", async () => {
    const start = await app.request("/api/v1/auth/roblox/start?intent=login");
    const stateCookie = cookieOf(start, "dbr_oauth")!;
    const cb = await app.request(`/api/v1/auth/roblox/callback?code=x&state=forged`, { headers: { cookie: stateCookie } });
    assert.match(cb.headers.get("location")!, /error=OAUTH_STATE/);
  });

  test("Connect with Roblox creates an OAuth connection with granted universes", async () => {
    const cb = await oauthRoundTrip(`intent=connect&workspaceId=${owner.ws}`, "connect-code", owner.cookie);
    assert.match(cb.headers.get("location")!, /\/dashboard\/connections\?connected=/);
    const [conn] = await db.select().from(robloxConnections).where(eq(robloxConnections.workspaceId, owner.ws));
    assert.equal(conn!.authType, "oauth");
    assert.ok(conn!.encryptedRefreshToken && !conn!.encryptedRefreshToken.includes("rt-"), "tokens encrypted");
    const list = (await (await app.request("/api/v1/connections", { headers: { cookie: owner.cookie, "x-workspace-id": owner.ws } })).json()) as any;
    assert.deepEqual(list.data[0].key.universes.ids, ["555"]);
    assert.equal(list.data[0].key.capabilities.read, true);
    assert.equal(list.data[0].keyHint, "@ArrBuilder");
  });
});
