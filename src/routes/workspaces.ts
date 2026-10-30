import { and, count, desc, eq, isNull } from "drizzle-orm";
import { config } from "@/config";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { ROLES, users, workspaceInviteLinks, workspaceInvites, workspaceMembers, workspaces, type Role } from "@/db/schema";
import { randomToken, sha256 } from "@/lib/crypto";
import { ApiError, body, forbidden, notFound, ok } from "@/lib/http";
import { permissionsOf } from "@/lib/rbac";
import { slugify } from "@/lib/slug";
import { requirePermission, workspaceFromParam, type Env } from "@/middleware/auth";
import { workspacesOf } from "./auth";
import { findUserByUsername } from "@/roblox/oauth";
import { rateLimit } from "@/lib/rateLimit";
import { assertWithin } from "@/lib/plans";

const createSchema = z.object({ name: z.string().trim().min(1).max(80), type: z.enum(["individual", "studio"]).default("studio") });
const updateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), type: z.enum(["individual", "studio"]).optional() });
const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(ROLES).default("developer") });
const roleSchema = z.object({ role: z.enum(ROLES) });
// Username Roblox: 3–20 karakter, huruf/angka/underscore
const robloxInviteSchema = z.object({ username: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, "Invalid Roblox username"), role: z.enum(ROLES).default("developer") });

const userIdParam = z.string().uuid();

async function ownerCount(workspaceId: string) {
  const [r] = await db
    .select({ n: count() })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")));
  return r?.n ?? 0;
}

async function memberRole(workspaceId: string, userId: string): Promise<Role | null> {
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return m?.role ?? null;
}

/** Hanya owner yang boleh memberi/mengubah/menghapus role owner. */
function guardOwnerChange(actor: Role, from: Role | null, to: Role | null) {
  if ((from === "owner" || to === "owner") && actor !== "owner") throw forbidden("Only an owner can manage owners");
}

export const workspaceRoutes = new Hono<Env>()
  .get("/", async (c) => ok(c, await workspacesOf(c.get("user").id)))
  .post("/", async (c) => {
    const input = await body(c, createSchema);
    const ws = await db.transaction(async (tx) => {
      const [w] = await tx.insert(workspaces).values({ ...input, slug: slugify(input.name) }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: w!.id, userId: c.get("user").id, role: "owner" });
      return w!;
    });
    return ok(c, { ...ws, role: "owner", permissions: permissionsOf("owner") }, 201);
  })
  .use("/:id", workspaceFromParam)
  .use("/:id/*", workspaceFromParam)
  .get("/:id", (c) => {
    const ws = c.get("workspace");
    return ok(c, { ...ws, permissions: permissionsOf(ws.role) });
  })
  .patch("/:id", requirePermission("workspace.update"), async (c) => {
    const input = await body(c, updateSchema);
    const [w] = await db.update(workspaces).set(input).where(eq(workspaces.id, c.get("workspace").id)).returning();
    return ok(c, w);
  })
  .get("/:id/members", async (c) => {
    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.createdAt,
        robloxUsername: users.robloxUsername,
        robloxAvatarUrl: users.robloxAvatarUrl,
        discordUsername: users.discordUsername,
        discordAvatarUrl: users.discordAvatarUrl,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, c.get("workspace").id))
      .orderBy(workspaceMembers.createdAt);
    return ok(c, rows);
  })
  .post("/:id/members", requirePermission("members.manage"), async (c) => {
    const input = await body(c, inviteSchema);
    const ws = c.get("workspace");
    guardOwnerChange(ws.role, null, input.role);
    const [u] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.email, input.email)).limit(1);
    // Tanpa layanan email di MVP: anggota harus sudah punya akun DataBridge
    if (!u) throw new ApiError(404, "USER_NOT_FOUND", "No DataBridge account uses this email yet — ask them to sign up first");
    if (await memberRole(ws.id, u.id)) throw new ApiError(409, "ALREADY_MEMBER", "This person is already a member");
    await assertWithin(ws, "seats");
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: input.role });
    return ok(c, { userId: u.id, name: u.name, email: u.email, role: input.role }, 201);
  })
  // Undangan berdasarkan username Roblox (seperti collaborator Roblox)
  .get("/:id/invites", async (c) => {
    const rows = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.workspaceId, c.get("workspace").id))
      .orderBy(workspaceInvites.createdAt);
    return ok(
      c,
      rows.map((r) => ({ id: r.id, robloxUserId: r.robloxUserId, username: r.robloxUsername, displayName: r.robloxDisplayName, avatarUrl: r.robloxAvatarUrl, role: r.role, createdAt: r.createdAt })),
    );
  })
  .post("/:id/invites", requirePermission("members.manage"), rateLimit({ key: "invite", windowMs: 60_000, max: 20 }), async (c) => {
    const ws = c.get("workspace");
    const input = await body(c, robloxInviteSchema);
    guardOwnerChange(ws.role, null, input.role);
    await assertWithin(ws, "seats");
    const rbx = await findUserByUsername(input.username);
    if (!rbx) throw new ApiError(404, "ROBLOX_USER_NOT_FOUND", "No Roblox user with this username");
    // Sudah punya akun DataBridge tertaut → langsung jadi anggota
    const [linked] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.robloxUserId, rbx.userId)).limit(1);
    if (linked) {
      if (await memberRole(ws.id, linked.id)) throw new ApiError(409, "ALREADY_MEMBER", "This person is already a member");
      await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: linked.id, role: input.role });
      return ok(c, { type: "member", userId: linked.id, name: linked.name, email: linked.email, role: input.role, robloxUsername: rbx.username, robloxAvatarUrl: rbx.avatarUrl }, 201);
    }
    const [inv] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: ws.id,
        robloxUserId: rbx.userId,
        robloxUsername: rbx.username,
        robloxDisplayName: rbx.displayName,
        robloxAvatarUrl: rbx.avatarUrl,
        role: input.role,
        invitedBy: c.get("user").id,
      })
      .onConflictDoUpdate({ target: [workspaceInvites.workspaceId, workspaceInvites.robloxUserId], set: { role: input.role } })
      .returning();
    return ok(c, { type: "invite", id: inv!.id, robloxUserId: rbx.userId, username: rbx.username, displayName: rbx.displayName, avatarUrl: rbx.avatarUrl, role: inv!.role }, 201);
  })
  .delete("/:id/invites/:inviteId", requirePermission("members.manage"), async (c) => {
    const inviteId = userIdParam.parse(c.req.param("inviteId"));
    const r = await db
      .delete(workspaceInvites)
      .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, c.get("workspace").id)))
      .returning({ id: workspaceInvites.id });
    if (!r.length) throw notFound("Invite");
    return ok(c, { ok: true });
  })
  // Link undangan (dibagikan lewat Discord/WA) — token hanya ditampilkan sekali saat dibuat
  .get("/:id/invite-links", requirePermission("members.manage"), async (c) => {
    const rows = await db
      .select()
      .from(workspaceInviteLinks)
      .where(and(eq(workspaceInviteLinks.workspaceId, c.get("workspace").id), isNull(workspaceInviteLinks.revokedAt)))
      .orderBy(desc(workspaceInviteLinks.createdAt));
    return ok(c, rows.map(({ tokenHash: _t, ...r }) => ({ ...r, active: r.expiresAt > new Date() && (r.maxUses == null || r.uses < r.maxUses) })));
  })
  .post("/:id/invite-links", requirePermission("members.manage"), rateLimit({ key: "invite-link", windowMs: 60_000, max: 20 }), async (c) => {
    const ws = c.get("workspace");
    const input = await body(
      c,
      z.object({
        role: z.enum(ROLES).default("developer"),
        days: z.coerce.number().int().min(1).max(30).default(7),
        maxUses: z.coerce.number().int().min(1).max(100).nullish(),
      }),
    );
    guardOwnerChange(ws.role, null, input.role);
    const token = randomToken(24);
    const [row] = await db
      .insert(workspaceInviteLinks)
      .values({
        workspaceId: ws.id,
        tokenHash: sha256(token),
        role: input.role,
        expiresAt: new Date(Date.now() + input.days * 864e5),
        maxUses: input.maxUses ?? null,
        createdBy: c.get("user").id,
      })
      .returning();
    const { tokenHash: _t, ...rest } = row!;
    return ok(c, { ...rest, token, url: `${config.appUrl.replace(/\/$/, "")}/invite/${token}` }, 201);
  })
  .delete("/:id/invite-links/:linkId", requirePermission("members.manage"), async (c) => {
    const r = await db
      .update(workspaceInviteLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceInviteLinks.id, userIdParam.parse(c.req.param("linkId"))), eq(workspaceInviteLinks.workspaceId, c.get("workspace").id)))
      .returning({ id: workspaceInviteLinks.id });
    if (!r.length) throw notFound("Invite link");
    return ok(c, { ok: true });
  })
  .patch("/:id/members/:userId", requirePermission("members.manage"), async (c) => {
    const ws = c.get("workspace");
    const userId = userIdParam.parse(c.req.param("userId"));
    const { role } = await body(c, roleSchema);
    const current = await memberRole(ws.id, userId);
    if (!current) throw notFound("Member");
    guardOwnerChange(ws.role, current, role);
    if (current === "owner" && role !== "owner" && (await ownerCount(ws.id)) <= 1) {
      throw new ApiError(409, "LAST_OWNER", "A workspace needs at least one owner");
    }
    await db.update(workspaceMembers).set({ role }).where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)));
    return ok(c, { userId, role });
  })
  .delete("/:id/members/:userId", async (c) => {
    const ws = c.get("workspace");
    const userId = userIdParam.parse(c.req.param("userId"));
    const self = userId === c.get("user").id;
    // Anggota boleh keluar sendiri; menghapus orang lain butuh members.manage
    if (!self && !permissionsOf(ws.role).includes("members.manage")) throw forbidden();
    const current = await memberRole(ws.id, userId);
    if (!current) throw notFound("Member");
    if (!self) guardOwnerChange(ws.role, current, null);
    if (current === "owner" && (await ownerCount(ws.id)) <= 1) throw new ApiError(409, "LAST_OWNER", "A workspace needs at least one owner");
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)));
    return ok(c, { ok: true });
  });
