import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config } from "@/config";
import { db } from "@/db";
import { robloxConnections, sessions, users, workspaceInvites, workspaceMembers, workspaces } from "@/db/schema";
import { assertWithin } from "@/lib/plans";
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { can } from "@/lib/rbac";
import { rateLimit } from "@/lib/rateLimit";
import type { Env } from "@/middleware/auth";
import { authorizeUrl, exchangeCode, grantedUniverses, pkce, revokeToken, userInfo, type RobloxProfile } from "@/roblox/oauth";
import { createAccount, startSession } from "./auth";
import { keyInfoFromOAuth } from "./connections";

// "Masuk dengan Roblox" (login), "Tautkan akun Roblox" (link) dan "Connect with Roblox" (koneksi OAuth).
// Alur: /start → set cookie state terenkripsi (state, PKCE verifier, intent) → Roblox consent → /callback.
// Semua hasil diakhiri redirect ke web dengan ?error=KODE bila gagal (diterjemahkan di web).

const STATE_COOKIE = "dbr_oauth";
const LOGIN_SCOPE = "openid profile";

type Intent = "login" | "link" | "connect";
type OAuthState = { state: string; verifier: string; intent: Intent; userId?: string; workspaceId?: string; connectionId?: string; next?: string; exp: number };

const startQuery = z.object({
  intent: z.enum(["login", "link", "connect"]).default("login"),
  workspaceId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
  next: z.string().optional(),
});

const web = (path: string) => `${config.appUrl.replace(/\/$/, "")}${path}`;
const safeNext = (n?: string) => (n && n.startsWith("/") && !n.startsWith("//") ? n : undefined);

async function sessionUser(c: Context): Promise<typeof users.$inferSelect | null> {
  const token = getCookie(c, config.sessionCookie);
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row?.user ?? null;
}

/** Undangan berdasarkan Roblox user id → jadi anggota workspace (dipanggil saat login/tautkan). */
export async function acceptInvites(userId: string, robloxUserId: string) {
  const invites = await db.select().from(workspaceInvites).where(eq(workspaceInvites.robloxUserId, robloxUserId));
  for (const inv of invites) {
    await db.insert(workspaceMembers).values({ workspaceId: inv.workspaceId, userId, role: inv.role }).onConflictDoNothing();
    await db.delete(workspaceInvites).where(eq(workspaceInvites.id, inv.id));
  }
  return invites.length;
}

const profileFields = (p: RobloxProfile) => ({
  robloxUserId: p.userId,
  robloxUsername: p.username,
  robloxDisplayName: p.displayName,
  robloxAvatarUrl: p.avatarUrl,
});

export const robloxAuthRoutes = new Hono<Env>()
  .get("/start", rateLimit({ key: "oauth-start", windowMs: 60_000, max: 20 }), async (c) => {
    const q = startQuery.safeParse(c.req.query());
    const fail = (code: string, path = "/login") => c.redirect(web(`${path}?error=${code}`));
    if (!config.roblox.enabled) return fail("ROBLOX_DISABLED");
    if (!q.success) return fail("VALIDATION_ERROR");
    const { intent, workspaceId, connectionId } = q.data;
    let userId: string | undefined;

    if (intent !== "login") {
      const u = await sessionUser(c);
      if (!u) return fail("UNAUTHENTICATED");
      userId = u.id;
    }
    if (intent === "connect") {
      if (!config.roblox.connectEnabled) return fail("ROBLOX_CONNECT_DISABLED", "/dashboard/connections");
      if (!workspaceId) return fail("WORKSPACE_REQUIRED", "/dashboard/connections");
      const [m] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId!)))
        .limit(1);
      if (!m || !can(m.role, "connections.manage")) return fail("FORBIDDEN", "/dashboard/connections");
    }

    const { verifier, challenge } = pkce();
    const st: OAuthState = {
      state: randomToken(24),
      verifier,
      intent,
      userId,
      workspaceId,
      connectionId,
      next: safeNext(q.data.next),
      exp: Date.now() + 10 * 60_000,
    };
    // Terenkripsi AES-GCM (rahasia + anti-ubah); SameSite=Lax tetap terkirim pada redirect GET dari Roblox
    setCookie(c, STATE_COOKIE, encryptSecret(JSON.stringify(st)), { httpOnly: true, secure: config.cookieSecure, sameSite: "Lax", path: "/", maxAge: 600 });
    const scope = intent === "connect" ? config.roblox.connectScopes : LOGIN_SCOPE;
    // Connect: paksa layar consent agar user bisa memilih experience
    return c.redirect(authorizeUrl({ scope, state: st.state, challenge, prompt: intent === "connect" ? "consent" : undefined }));
  })

  .get("/callback", async (c) => {
    const raw = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    let st: OAuthState | null = null;
    try {
      st = raw ? (JSON.parse(decryptSecret(raw)) as OAuthState) : null;
    } catch {
      st = null;
    }
    const back = st?.intent === "connect" ? "/dashboard/connections" : st?.intent === "link" ? "/dashboard/settings" : "/login";
    const fail = (code: string) => c.redirect(web(`${back}?error=${code}`));
    const state = c.req.query("state") ?? "";
    if (!st || st.exp < Date.now() || !safeEqual(st.state, state)) return fail("OAUTH_STATE");
    if (c.req.query("error")) return fail("ROBLOX_DENIED");
    const code = c.req.query("code");
    if (!code) return fail("OAUTH_STATE");

    let tokens;
    let profile: RobloxProfile;
    try {
      tokens = await exchangeCode(code, st.verifier);
      profile = await userInfo(tokens.accessToken);
    } catch {
      return fail("ROBLOX_OAUTH_FAILED");
    }

    /* ── Masuk dengan Roblox ── */
    if (st.intent === "login") {
      await revokeToken(tokens.refreshToken); // login tidak butuh token Open Cloud
      let [u] = await db.select().from(users).where(eq(users.robloxUserId, profile.userId)).limit(1);
      if (u) {
        [u] = await db.update(users).set(profileFields(profile)).where(eq(users.id, u.id)).returning();
      } else {
        u = await createAccount({ name: profile.displayName || profile.username || "Roblox user", ...profileFields(profile) });
      }
      await acceptInvites(u!.id, profile.userId);
      await startSession(c, u!.id);
      return c.redirect(web(st.next ?? "/dashboard"));
    }

    /* ── Tautkan akun Roblox ke akun yang sedang masuk ── */
    if (st.intent === "link") {
      await revokeToken(tokens.refreshToken);
      const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.robloxUserId, profile.userId)).limit(1);
      if (taken && taken.id !== st.userId) return fail("ROBLOX_IN_USE");
      await db.update(users).set(profileFields(profile)).where(eq(users.id, st.userId!));
      const joined = await acceptInvites(st.userId!, profile.userId);
      return c.redirect(web(`/dashboard/settings?linked=1${joined ? `&joined=${joined}` : ""}`));
    }

    /* ── Connect with Roblox: koneksi OAuth untuk Open Cloud ── */
    let universes: string[] = [];
    try {
      universes = await grantedUniverses(tokens.accessToken);
    } catch {
      // daftar universe bisa dibaca ulang lewat "Tes"
    }
    const handle = profile.username ? `@${profile.username}` : `Roblox ${profile.userId}`;
    const keyInfo = keyInfoFromOAuth(tokens.scope, universes, handle);
    const fp = `oauth:${profile.userId}`;
    const values = {
      authType: "oauth" as const,
      encryptedApiKey: null,
      encryptedAccessToken: encryptSecret(tokens.accessToken),
      encryptedRefreshToken: encryptSecret(tokens.refreshToken),
      accessTokenExpiresAt: tokens.expiresAt,
      robloxUserId: profile.userId,
      keyFingerprint: fp,
      keyHint: handle,
      status: "active" as const,
      keyInfo,
      lastError: null,
      lastTestedAt: new Date(),
    };
    // Satu koneksi OAuth per akun Roblox per workspace: hubungkan ulang = perbarui token & experience
    const [existing] = await db
      .select({ id: robloxConnections.id })
      .from(robloxConnections)
      .where(and(eq(robloxConnections.workspaceId, st.workspaceId!), eq(robloxConnections.keyFingerprint, fp)))
      .limit(1);
    const targetId = st.connectionId ?? existing?.id;
    let id: string;
    if (targetId) {
      const [row] = await db
        .update(robloxConnections)
        .set(values)
        .where(and(eq(robloxConnections.id, targetId), eq(robloxConnections.workspaceId, st.workspaceId!)))
        .returning({ id: robloxConnections.id });
      if (!row) return fail("NOT_FOUND");
      id = row.id;
    } else {
      const [ws] = await db.select({ id: workspaces.id, plan: workspaces.plan }).from(workspaces).where(eq(workspaces.id, st.workspaceId!)).limit(1);
      try {
        await assertWithin(ws!, "connections");
      } catch {
        await revokeToken(tokens.refreshToken);
        return fail("PLAN_LIMIT");
      }
      const [row] = await db
        .insert(robloxConnections)
        .values({ ...values, workspaceId: st.workspaceId!, name: `Roblox · ${handle}`, createdBy: st.userId })
        .returning({ id: robloxConnections.id });
      id = row!.id;
    }
    // Tautkan profil Roblox ke user bila belum tertaut & belum dipakai akun lain
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.robloxUserId, profile.userId)).limit(1);
    if (!owner) await db.update(users).set(profileFields(profile)).where(and(eq(users.id, st.userId!), isNull(users.robloxUserId)));
    return c.redirect(web(`/dashboard/connections?connected=${id}`));
  });
