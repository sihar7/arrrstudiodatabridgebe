import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "@/config";
import { db } from "@/db";
import { users } from "@/db/schema";
import { decryptSecret, encryptSecret, randomToken, safeEqual } from "@/lib/crypto";
import { rateLimit } from "@/lib/rateLimit";
import type { Env } from "@/middleware/auth";
import { createAccount, startSession } from "./auth";

// "Masuk dengan Discord" — login utama user (authorization code, scope identify).
// Email Discord tidak diminta/disimpan, sehingga akun Discord tidak pernah bisa cocok dengan email admin.

const API = "https://discord.com/api/v10";
const STATE_COOKIE = "dbr_discord";

const web = (path: string) => `${config.appUrl.replace(/\/$/, "")}${path}`;
const redirectUri = () => web("/api/v1/auth/discord/callback");
const safeNext = (n?: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : undefined);

type DiscordUser = { id: string; username: string; global_name?: string | null; avatar?: string | null };

export const discordAuthRoutes = new Hono<Env>()
  .get("/start", rateLimit({ key: "discord-start", windowMs: 60_000, max: 20 }), (c) => {
    if (!config.discord.enabled) return c.redirect(web("/login?error=DISCORD_DISABLED"));
    const state = randomToken(24);
    const next = safeNext(c.req.query("next"));
    setCookie(c, STATE_COOKIE, encryptSecret(JSON.stringify({ state, next, exp: Date.now() + 10 * 60_000 })), {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    const q = new URLSearchParams({ client_id: config.discord.clientId, redirect_uri: redirectUri(), response_type: "code", scope: "identify", state, prompt: "none" });
    return c.redirect(`https://discord.com/oauth2/authorize?${q}`);
  })
  .get("/callback", async (c) => {
    const raw = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    let st: { state: string; next?: string; exp: number } | null = null;
    try {
      st = raw ? JSON.parse(decryptSecret(raw)) : null;
    } catch {
      st = null;
    }
    const fail = (code: string) => c.redirect(web(`/login?error=${code}`));
    if (!st || st.exp < Date.now() || !safeEqual(st.state, c.req.query("state") ?? "")) return fail("OAUTH_STATE");
    if (c.req.query("error")) return fail("DISCORD_DENIED");
    const code = c.req.query("code");
    if (!code) return fail("OAUTH_STATE");

    let profile: DiscordUser;
    try {
      const tok = await fetch(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const t = (await tok.json().catch(() => ({}))) as { access_token?: string };
      if (!tok.ok || !t.access_token) return fail("DISCORD_FAILED");
      const me = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) });
      if (!me.ok) return fail("DISCORD_FAILED");
      profile = (await me.json()) as DiscordUser;
      // Token hanya untuk membaca profil sekali — langsung dicabut
      void fetch(`${API}/oauth2/token/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.access_token, client_id: config.discord.clientId, client_secret: config.discord.clientSecret }),
      }).catch(() => {});
    } catch {
      return fail("DISCORD_FAILED");
    }

    const fields = {
      discordUserId: profile.id,
      discordUsername: profile.username,
      discordAvatarUrl: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128` : null,
    };
    let [u] = await db.select().from(users).where(eq(users.discordUserId, profile.id)).limit(1);
    if (u) [u] = await db.update(users).set(fields).where(eq(users.id, u.id)).returning();
    else u = await createAccount({ name: profile.global_name || profile.username, ...fields });
    await startSession(c, u!.id);
    return c.redirect(web(st.next ?? "/dashboard"));
  });
