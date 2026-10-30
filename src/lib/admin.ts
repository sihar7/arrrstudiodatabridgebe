import { and, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import { config } from "@/config";
import { db } from "@/db";
import {
  auditLogs,
  billingOrders,
  datastoreConfigs,
  migrations,
  projects,
  robloxConnections,
  sessions,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";
import { slugify } from "./slug";

// Akun & data admin platform. Admin = email di env + password; tidak pernah tertaut Roblox.

/** Semua user admin yang ada di DB (email cocok env). */
async function adminUsers() {
  if (!config.adminEmails.length) return [];
  return db.select().from(users).where(inArray(users.email, config.adminEmails));
}

/** Workspace milik admin (owner) → Enterprise tanpa batas waktu; admin tanpa workspace dibuatkan satu. */
export async function promoteAdminWorkspaces() {
  for (const u of await adminUsers()) {
    const owned = await db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, u.id), eq(workspaceMembers.role, "owner")));
    if (!owned.length) {
      const [ws] = await db
        .insert(workspaces)
        .values({ name: "ARRR Admin", slug: slugify("arrr-admin"), type: "studio", plan: "enterprise" })
        .returning({ id: workspaces.id });
      await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    } else {
      await db
        .update(workspaces)
        .set({ plan: "enterprise", planExpiresAt: null })
        .where(inArray(workspaces.id, owned.map((w) => w.id)));
    }
  }
}

/**
 * ADMIN_EMAIL + ADMIN_PASSWORD (env) → akun admin dibuat bila belum ada; password disamakan dengan env
 * (ganti env = ganti password). Tautan Roblox pada akun admin selalu dilepas.
 */
export async function ensureAdmin() {
  const b = config.bootstrapAdmin;
  if (b) {
    const [existing] = await db.select().from(users).where(eq(users.email, b.email)).limit(1);
    if (!existing) {
      await db.insert(users).values({ name: "ARRR Admin", email: b.email, passwordHash: await hashPassword(b.password) });
      console.log(`[admin] akun admin dibuat: ${b.email}`);
    } else if (!existing.passwordHash || !(await verifyPassword(b.password, existing.passwordHash))) {
      await db.update(users).set({ passwordHash: await hashPassword(b.password) }).where(eq(users.id, existing.id));
      // Password berubah → semua sesi lama admin dicabut
      await db.delete(sessions).where(eq(sessions.userId, existing.id));
      console.log(`[admin] password admin diperbarui dari env: ${b.email}`);
    }
  }
  if (config.adminEmails.length) {
    await db
      .update(users)
      .set({ robloxUserId: null, robloxUsername: null, robloxDisplayName: null, robloxAvatarUrl: null })
      .where(and(inArray(users.email, config.adminEmails), isNotNull(users.robloxUserId)));
  }
  await promoteAdminWorkspaces();
}

/**
 * Hapus SEMUA data platform kecuali akun admin & sesi admin yang sedang dipakai.
 * Urutan eksplisit (FK restrict antara konfigurasi DataStore & koneksi). Workspace admin dibuat ulang (Enterprise).
 */
export async function resetAllData(keepSessionId: string) {
  const admins = (await adminUsers()).map((u) => u.id);
  const counts = await db.transaction(async (tx) => {
    const c = {
      migrations: (await tx.delete(migrations).returning({ id: migrations.id })).length,
      datastores: (await tx.delete(datastoreConfigs).returning({ id: datastoreConfigs.id })).length,
      projects: (await tx.delete(projects).returning({ id: projects.id })).length,
      connections: (await tx.delete(robloxConnections).returning({ id: robloxConnections.id })).length,
      invites: (await tx.delete(workspaceInvites).returning({ id: workspaceInvites.id })).length,
      orders: (await tx.delete(billingOrders).returning({ id: billingOrders.id })).length,
      audit: (await tx.delete(auditLogs).returning({ id: auditLogs.id })).length,
      members: (await tx.delete(workspaceMembers).returning({ id: workspaceMembers.id })).length,
      workspaces: (await tx.delete(workspaces).returning({ id: workspaces.id })).length,
      sessions: (await tx.delete(sessions).where(ne(sessions.id, keepSessionId)).returning({ id: sessions.id })).length,
      users: (await tx.delete(users).where(admins.length ? notInArray(users.id, admins) : undefined).returning({ id: users.id })).length,
    };
    return c;
  });
  await promoteAdminWorkspaces();
  return counts;
}
