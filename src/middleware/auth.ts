import { and, eq, gt } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { config } from "@/config";
import { db } from "@/db";
import { sessions, users, workspaceMembers, workspaces, type Role } from "@/db/schema";
import { sha256 } from "@/lib/crypto";
import { ApiError, forbidden } from "@/lib/http";
import { effectivePlan } from "@/lib/plans";
import { can, type Permission } from "@/lib/rbac";

export type AuthUser = {
  id: string;
  name: string;
  email: string | null;
  locale: string;
  hasPassword: boolean;
  isAdmin: boolean;
  roblox: { userId: string; username: string | null; displayName: string | null; avatarUrl: string | null } | null;
  discord: { userId: string; username: string | null; avatarUrl: string | null } | null;
};
export type WorkspaceCtx = { id: string; name: string; slug: string; type: string; plan: string; planExpiresAt: Date | null; role: Role };
export type Env = { Variables: { user: AuthUser; sessionId: string; workspace: WorkspaceCtx } };

/**
 * Admin = email terdaftar di env + punya password + TIDAK tertaut Roblox.
 * Akun dari "Masuk dengan Roblox" tidak punya email (dan tidak bisa menambahkannya) → tidak mungkin jadi admin.
 */
export function isAdminUser(u: Pick<typeof users.$inferSelect, "email" | "passwordHash" | "robloxUserId" | "discordUserId">): boolean {
  return !!u.email && !!u.passwordHash && !u.robloxUserId && !u.discordUserId && config.adminEmails.includes(u.email.toLowerCase());
}

/** Bentuk user aman untuk klien (tanpa hash password). */
export function presentUser(u: typeof users.$inferSelect): AuthUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    locale: u.locale,
    hasPassword: !!u.passwordHash,
    isAdmin: isAdminUser(u),
    roblox: u.robloxUserId
      ? { userId: u.robloxUserId, username: u.robloxUsername, displayName: u.robloxDisplayName, avatarUrl: u.robloxAvatarUrl }
      : null,
    discord: u.discordUserId ? { userId: u.discordUserId, username: u.discordUsername, avatarUrl: u.discordAvatarUrl } : null,
  };
}

/** CSRF: metode yang mengubah data wajib membawa header kustom (browser tidak bisa mengirimnya lintas situs tanpa CORS). */
export const csrf: MiddlewareHandler = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("x-requested-with") !== "databridge") {
    throw new ApiError(403, "CSRF", "Missing request header");
  }
  await next();
};

export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const token = getCookie(c, config.sessionCookie);
  if (!token) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  const [row] = await db
    .select({ sessionId: sessions.id, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) throw new ApiError(401, "UNAUTHENTICATED", "Session expired, sign in again");
  const { sessionId, user } = row;
  c.set("user", presentUser(user));
  c.set("sessionId", sessionId);
  await next();
};

/** Tenant isolation: workspace aktif dari header X-Workspace-Id, harus anggota. Semua query fitur di-scope ke id ini. */
export const requireWorkspace: MiddlewareHandler<Env> = async (c, next) => {
  await loadWorkspace(c, c.req.header("x-workspace-id") ?? "");
  await next();
};

/** Sama dengan requireWorkspace tetapi id dari path param :id (rute /workspaces/:id/...). */
export const workspaceFromParam: MiddlewareHandler<Env> = async (c, next) => {
  await loadWorkspace(c, c.req.param("id") ?? "");
  await next();
};

async function loadWorkspace(c: Context<Env>, wsId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(wsId)) throw new ApiError(400, "WORKSPACE_REQUIRED", "A valid workspace id is required");
  const [row] = await db
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
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, c.get("user").id)))
    .limit(1);
  // 404 (bukan 403) agar keberadaan workspace lain tidak bocor
  if (!row) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
  // Batas & fitur memakai paket efektif (paket lewat masa aktif = free)
  c.set("workspace", { ...row, plan: effectivePlan(row.plan, row.planExpiresAt) });
}

/** Panel admin platform — admin hanya email + password (lihat isAdminUser). Non-admin = 404. */
export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get("user").isAdmin) throw new ApiError(404, "NOT_FOUND", "Endpoint not found");
  await next();
};

export function requirePermission(perm: Permission): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!can(c.get("workspace").role, perm)) throw forbidden();
    await next();
  };
}
