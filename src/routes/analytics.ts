import { and, countDistinct, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "@/db";
import { datastoreConfigs, projects, robloxConnections } from "@/db/schema";
import { ok } from "@/lib/http";
import type { Env } from "@/middleware/auth";

// Statistik dashboard workspace. Angka migrasi/backup menyusul di fase berikut (fiturnya belum ada).
export const analyticsRoutes = new Hono<Env>().get("/overview", async (c) => {
  const wsId = c.get("workspace").id;
  const [[p], [conn], [active], [ds]] = await Promise.all([
    db.select({ n: countDistinct(projects.id) }).from(projects).where(eq(projects.workspaceId, wsId)),
    db.select({ n: countDistinct(robloxConnections.id) }).from(robloxConnections).where(eq(robloxConnections.workspaceId, wsId)),
    db
      .select({ n: countDistinct(robloxConnections.id) })
      .from(robloxConnections)
      .where(and(eq(robloxConnections.workspaceId, wsId), eq(robloxConnections.status, "active"))),
    db
      .select({ configs: countDistinct(datastoreConfigs.id), universes: countDistinct(datastoreConfigs.universeId) })
      .from(datastoreConfigs)
      .where(eq(datastoreConfigs.workspaceId, wsId)),
  ]);
  return ok(c, {
    projects: p?.n ?? 0,
    connections: conn?.n ?? 0,
    activeConnections: active?.n ?? 0,
    datastores: ds?.configs ?? 0,
    experiences: ds?.universes ?? 0,
  });
});
