process.env.DATABASE_URL = "memory://";
process.env.NODE_ENV = "test";
process.env.DISCORD_CLIENT_ID = "dc-client";
process.env.DISCORD_CLIENT_SECRET = "dc-secret";
process.env.DISCORD_GUILD_ID = "999";
process.env.DISCORD_BOT_TOKEN = "bot-token";
process.env.DISCORD_INVITE_URL = "https://discord.gg/test";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

// Wajib member server Discord: bot memasukkan user otomatis; gagal → NOT_MEMBER, tanpa akun/sesi.
const { app } = await import("@/app");
const { migrate, closeDb } = await import("@/db");

const realFetch = globalThis.fetch;
let joinStatus = 201;
let nextUser = { id: "501", username: "member_one", global_name: "Member", avatar: "" };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/oauth2/token")) return Response.json({ access_token: `tok-${nextUser.id}`, token_type: "Bearer" });
  if (url.endsWith("/users/@me")) return Response.json(nextUser);
  if (url.endsWith("/oauth2/token/revoke")) return new Response("", { status: 200 });
  if (url.includes("/guilds/999/members/")) {
    assert.equal(init?.method, "PUT");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bot bot-token");
    assert.equal(JSON.parse(String(init?.body)).access_token, `tok-${nextUser.id}`);
    return new Response(joinStatus === 204 ? null : "{}", { status: joinStatus });
  }
  return realFetch(input, init);
}) as typeof fetch;

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

async function discordLogin() {
  const start = await app.request("/api/v1/auth/discord/start");
  const loc = new URL(start.headers.get("location")!);
  assert.equal(loc.searchParams.get("scope"), "identify guilds.join");
  const cb = await app.request(`/api/v1/auth/discord/callback?code=c&state=${loc.searchParams.get("state")}`, { headers: { cookie: cookieOf(start, "dbr_discord")! } });
  return { location: cb.headers.get("location")!, cookie: cookieOf(cb, "dbr_session") };
}

before(async () => {
  await migrate();
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

describe("Discord server membership", () => {
  test("providers expose the invite link", async () => {
    const r = await app.request("/api/v1/auth/providers");
    assert.equal(((await r.json()) as any).data.discordInvite, "https://discord.gg/test");
  });

  test("joined (201) or already a member (204) → signed in", async () => {
    joinStatus = 201;
    const a = await discordLogin();
    assert.match(a.location, /\/dashboard$/);
    assert.ok(a.cookie);
    joinStatus = 204;
    nextUser = { id: "502", username: "member_two", global_name: "Two", avatar: "" };
    assert.match((await discordLogin()).location, /\/dashboard$/);
  });

  test("bot can't add the user → NOT_MEMBER, no session", async () => {
    joinStatus = 403;
    nextUser = { id: "503", username: "outsider", global_name: "Out", avatar: "" };
    const a = await discordLogin();
    assert.match(a.location, /\/login\?error=NOT_MEMBER$/);
    assert.equal(a.cookie, undefined);
  });
});
