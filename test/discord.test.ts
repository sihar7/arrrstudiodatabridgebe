process.env.DATABASE_URL = "memory://";
process.env.NODE_ENV = "test";
process.env.DISCORD_CLIENT_ID = "dc-client";
process.env.DISCORD_CLIENT_SECRET = "dc-secret";
process.env.ADMIN_EMAIL = "boss@arrrstudio.com";
process.env.ADMIN_PASSWORD = "correct-horse-battery";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

// Login Discord (user), daftar email ditutup untuk user, link undangan workspace.
const { app } = await import("@/app");
const { migrate, closeDb } = await import("@/db");
const { ensureAdmin } = await import("@/lib/admin");

const realFetch = globalThis.fetch;
let nextDiscordUser = { id: "111", username: "builder_one", global_name: "Builder One", avatar: "abc" };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/oauth2/token")) {
    const p = new URLSearchParams(String(init?.body));
    assert.equal(p.get("client_secret"), "dc-secret");
    return Response.json({ access_token: `tok-${nextDiscordUser.id}`, token_type: "Bearer" });
  }
  if (url.endsWith("/users/@me")) return Response.json(nextDiscordUser);
  if (url.endsWith("/oauth2/token/revoke")) return new Response("", { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;

const H = { "x-requested-with": "databridge", "content-type": "application/json" };
const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

async function discordLogin(next?: string) {
  const start = await app.request(`/api/v1/auth/discord/start${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  const loc = new URL(start.headers.get("location")!);
  assert.equal(loc.hostname, "discord.com");
  assert.equal(loc.searchParams.get("scope"), "identify", "email is never requested");
  const cb = await app.request(`/api/v1/auth/discord/callback?code=c&state=${loc.searchParams.get("state")}`, { headers: { cookie: cookieOf(start, "dbr_discord")! } });
  return { location: cb.headers.get("location")!, cookie: cookieOf(cb, "dbr_session")! };
}
const call = async (cookie: string, method: string, path: string, body?: unknown, ws?: string) => {
  const r = await app.request(`/api/v1${path}`, { method, headers: { ...H, cookie, ...(ws ? { "x-workspace-id": ws } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as any };
};

before(async () => {
  await migrate();
  await ensureAdmin();
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

describe("Discord login & email signup", () => {
  test("Discord login creates an account with a workspace; never admin", async () => {
    const a = await discordLogin();
    assert.match(a.location, /\/dashboard$/);
    const me = await call(a.cookie, "GET", "/auth/me");
    assert.equal(me.json.data.user.discord.username, "builder_one");
    assert.equal(me.json.data.user.email, null);
    assert.equal(me.json.data.user.isAdmin, false);
    assert.equal(me.json.data.workspaces.length, 1);
    const again = await discordLogin(); // login ulang = akun yang sama
    assert.equal((await call(again.cookie, "GET", "/auth/me")).json.data.user.id, me.json.data.user.id);
  });

  test("email signup is closed for users; email login only works for the admin", async () => {
    const reg = await call("", "POST", "/auth/register", { name: "X", email: "x@example.com", password: "supersecret1" });
    assert.equal(reg.json.error.code, "EMAIL_SIGNUP_DISABLED");
    const admin = await call("", "POST", "/auth/login", { email: "boss@arrrstudio.com", password: "correct-horse-battery" });
    assert.equal(admin.status, 200);
    const p = await call("", "GET", "/auth/providers");
    assert.deepEqual(p.json.data, { discord: true, roblox: false, robloxConnect: false, emailSignup: false });
  });
});

describe("invite links", () => {
  test("owner creates a link; another Discord user previews and joins with its role; revoked link stops working", async () => {
    nextDiscordUser = { id: "222", username: "owner_two", global_name: "Owner", avatar: "" };
    const owner = await discordLogin();
    const ws = (await call(owner.cookie, "GET", "/auth/me")).json.data.workspaces[0].id;
    // paket free = 1 seat → naikkan lewat admin agar ada kursi
    const admin = await app.request("/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ email: "boss@arrrstudio.com", password: "correct-horse-battery" }) });
    await call(cookieOf(admin, "dbr_session")!, "PATCH", `/admin/workspaces/${ws}`, { plan: "studio", planExpiresAt: null });

    const link = await call(owner.cookie, "POST", `/workspaces/${ws}/invite-links`, { role: "developer", days: 7, maxUses: 1 });
    assert.equal(link.status, 201);
    assert.match(link.json.data.url, /\/invite\//);
    const token = link.json.data.token as string;

    const preview = await call("", "GET", `/invites/${token}`);
    assert.equal(preview.json.data.role, "developer");

    nextDiscordUser = { id: "333", username: "joiner", global_name: "Joiner", avatar: "" };
    const joiner = await discordLogin(`/invite/${token}`);
    assert.match(joiner.location, new RegExp(`/invite/${token}$`), "returns to the invite after login");
    const acc = await call(joiner.cookie, "POST", `/invites/${token}/accept`);
    assert.equal(acc.json.data.workspaceId, ws);
    const me = await call(joiner.cookie, "GET", "/auth/me");
    assert.ok(me.json.data.workspaces.some((w: { id: string; role: string }) => w.id === ws && w.role === "developer"));

    // maxUses 1 sudah terpakai
    assert.equal((await call("", "GET", `/invites/${token}`)).json.error.code, "INVITE_USED_UP");
    const link2 = await call(owner.cookie, "POST", `/workspaces/${ws}/invite-links`, { role: "viewer" });
    await call(owner.cookie, "DELETE", `/workspaces/${ws}/invite-links/${link2.json.data.id}`);
    assert.equal((await call("", "GET", `/invites/${link2.json.data.token}`)).json.error.code, "INVITE_INVALID");
  });
});
