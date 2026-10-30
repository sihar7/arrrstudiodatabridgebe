import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { z } from "zod";
import { config } from "@/config";
import { db } from "@/db";
import { sessions, users, workspaceMembers, workspaces } from "@/db/schema";
import { randomToken, sha256 } from "@/lib/crypto";
import { ApiError, body, ok } from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/password";
import { rateLimit } from "@/lib/rateLimit";
import { effectivePlan } from "@/lib/plans";
import { permissionsOf } from "@/lib/rbac";
import { slugify } from "@/lib/slug";
import { promoteAdminWorkspaces } from "@/lib/admin";
import { isAdminUser, presentUser, requireAuth, type Env } from "@/middleware/auth";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, "At least 8 characters").max(200);
const locale = z.enum(["en", "id"]);

const registerSchema = z.object({ name: z.string().trim().min(1).max(80), email, password, locale: locale.optional() });
const loginSchema = z.object({ email, password: z.string().min(1).max(200) });
const updateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), locale: locale.optional() });

// Hash dummy agar waktu respons login sama untuk email terdaftar/tidak (cegah enumerasi akun)
const DUMMY_HASH = await hashPassword(randomToken());

export async function startSession(c: Context, userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 864e5);
  await db.insert(sessions).values({ userId, tokenHash: sha256(token), expiresAt });
  // Bersihkan sesi kedaluwarsa milik user ini (ringan, tanpa job terjadwal)
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));
  setCookie(c, config.sessionCookie, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Akun baru + workspace pribadi (owner). */
export async function createAccount(values: typeof users.$inferInsert) {
  return db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values(values).returning();
    const wsName = `${values.name.split(" ")[0]}'s workspace`;
    const [ws] = await tx.insert(workspaces).values({ name: wsName, slug: slugify(wsName), type: "individual" }).returning({ id: workspaces.id });
    await tx.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: "owner" });
    return u!;
  });
}

export async function workspacesOf(userId: string) {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      type: workspaces.type,
      plan: workspaces.plan,
      planExpiresAt: workspaces.planExpiresAt,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.createdAt);
  return rows.map((w) => ({ ...w, plan: effectivePlan(w.plan, w.planExpiresAt), permissions: permissionsOf(w.role) }));
}

export const authRoutes = new Hono<Env>()
  .post("/register", rateLimit({ key: "register", windowMs: 60 * 60_000, max: 10 }), async (c) => {
    const input = await body(c, registerSchema);
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    if (exists) throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists");
    const passwordHash = await hashPassword(input.password);
    // Setiap akun baru mendapat workspace pribadi sebagai owner
    const u = await createAccount({ name: input.name, email: input.email, passwordHash, locale: input.locale ?? "en" });
    if (isAdminUser(u)) await promoteAdminWorkspaces();
    await startSession(c, u.id);
    return ok(c, { user: presentUser(u), workspaces: await workspacesOf(u.id) }, 201);
  })
  .post("/login", rateLimit({ key: "login", windowMs: 15 * 60_000, max: 20 }), async (c) => {
    const input = await body(c, loginSchema);
    const [u] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    const valid = await verifyPassword(input.password, u?.passwordHash ?? DUMMY_HASH);
    if (!u || !valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    if (isAdminUser(u)) await promoteAdminWorkspaces();
    await startSession(c, u.id);
    return ok(c, { user: presentUser(u), workspaces: await workspacesOf(u.id) });
  })
  .post("/logout", async (c) => {
    const token = getCookie(c, config.sessionCookie);
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
    deleteCookie(c, config.sessionCookie, { path: "/" });
    return ok(c, { ok: true });
  })
  .get("/me", requireAuth, async (c) => {
    const user = c.get("user");
    return ok(c, { user, workspaces: await workspacesOf(user.id) });
  })
  .patch("/me", requireAuth, async (c) => {
    const input = await body(c, updateSchema);
    const [u] = await db
      .update(users)
      .set(input)
      .where(eq(users.id, c.get("user").id))
      .returning();
    return ok(c, { user: presentUser(u!) });
  })
  // Penyedia login yang aktif (tombol "Masuk dengan Roblox" hanya tampil bila app OAuth dikonfigurasi)
  .get("/providers", (c) => ok(c, { roblox: config.roblox.enabled, robloxConnect: config.roblox.connectEnabled }))
  // Lepas tautan Roblox — hanya bila akun punya password (agar tidak terkunci)
  .delete("/roblox", requireAuth, async (c) => {
    const me = c.get("user");
    if (!me.hasPassword) throw new ApiError(409, "NEEDS_PASSWORD", "Set an email and password before unlinking Roblox");
    const [u] = await db
      .update(users)
      .set({ robloxUserId: null, robloxUsername: null, robloxDisplayName: null, robloxAvatarUrl: null })
      .where(eq(users.id, me.id))
      .returning();
    return ok(c, { user: presentUser(u!) });
  });
