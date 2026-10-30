import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { migrations, projects, robloxConnections, workspaceInvites, workspaceMembers } from "@/db/schema";
import { ApiError } from "./http";

// Batas & fitur per paket — SAMA dengan tabel banding di web (web/src/i18n/plans.ts). Infinity = tanpa batas.
export const PLANS = {
  free: { priceIdr: 0, connections: 1, projects: 1, seats: 1, keysPerMigration: 1_000, concurrentJobs: 1, selectiveModes: false, crossExperience: false, allConflictStrategies: false },
  developer: { priceIdr: 49_000, connections: 3, projects: 5, seats: 1, keysPerMigration: 100_000, concurrentJobs: 2, selectiveModes: true, crossExperience: true, allConflictStrategies: true },
  studio: { priceIdr: 149_000, connections: 10, projects: Infinity, seats: 5, keysPerMigration: 1_000_000, concurrentJobs: 5, selectiveModes: true, crossExperience: true, allConflictStrategies: true },
  enterprise: { priceIdr: 0, connections: Infinity, projects: Infinity, seats: Infinity, keysPerMigration: Infinity, concurrentJobs: Infinity, selectiveModes: true, crossExperience: true, allConflictStrategies: true },
} as const;

export type PlanId = keyof typeof PLANS;
type NumericLimit = "connections" | "projects" | "seats" | "keysPerMigration" | "concurrentJobs";

/** Paket berbayar yang lewat masa aktif dihitung "free". */
export function effectivePlan(plan: string, expiresAt: Date | null): PlanId {
  const p = (plan in PLANS ? plan : "free") as PlanId;
  if (p !== "free" && expiresAt && expiresAt.getTime() < Date.now()) return "free";
  return p;
}

export function planOf(plan: string) {
  return PLANS[(plan in PLANS ? plan : "free") as PlanId];
}

export function limitFor(plan: string, key: NumericLimit): number {
  return planOf(plan)[key];
}

/** Lempar 402 PLAN_LIMIT bila penambahan resource melewati batas paket workspace. */
export async function assertWithin(ws: { id: string; plan: string }, key: "connections" | "projects" | "seats" | "concurrentJobs", adding = 1) {
  const limit = limitFor(ws.plan, key);
  if (!Number.isFinite(limit)) return;
  let used = 0;
  if (key === "connections") [{ n: used } = { n: 0 }] = await db.select({ n: count() }).from(robloxConnections).where(eq(robloxConnections.workspaceId, ws.id));
  if (key === "projects") [{ n: used } = { n: 0 }] = await db.select({ n: count() }).from(projects).where(eq(projects.workspaceId, ws.id));
  if (key === "seats") {
    const [[m], [i]] = await Promise.all([
      db.select({ n: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id)),
      db.select({ n: count() }).from(workspaceInvites).where(eq(workspaceInvites.workspaceId, ws.id)),
    ]);
    used = (m?.n ?? 0) + (i?.n ?? 0);
  }
  if (key === "concurrentJobs") {
    [{ n: used } = { n: 0 }] = await db
      .select({ n: count() })
      .from(migrations)
      .where(and(eq(migrations.workspaceId, ws.id), inArray(migrations.status, ["queued", "running", "cancelling"])));
  }
  if (used + adding > limit) throw new ApiError(402, "PLAN_LIMIT", `Your plan allows ${limit} ${key}`, { limit: key, max: limit });
}
