import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { datastoreConfigs, projects, robloxConnections } from "@/db/schema";
import { authFor } from "@/roblox/credentials";
import { ApiError, body, notFound, ok } from "@/lib/http";
import { assertWithin } from "@/lib/plans";
import { requirePermission, type Env } from "@/middleware/auth";
import { getUniverse } from "@/roblox/openCloud";

const projectSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).nullish() });
const numericId = z.string().regex(/^\d{1,20}$/, "Must be a numeric id");
// Batas Roblox: nama DataStore, key & scope maks 50 karakter
const dsName = z.string().trim().min(1).max(50);
const configSchema = z.object({
  label: z.string().trim().min(1).max(80),
  connectionId: z.string().uuid(),
  universeId: numericId,
  placeId: numericId.nullish(),
  datastoreName: dsName,
  scope: dsName.default("global"),
  datastoreType: z.enum(["standard", "ordered"]).default("standard"),
});
const uuidParam = z.string().uuid();

async function loadProject(workspaceId: string, id: string) {
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, uuidParam.parse(id)), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  if (!p) throw notFound("Project");
  return p;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code === "23505" || err.cause?.code === "23505";
}

export const projectRoutes = new Hono<Env>()
  .get("/", async (c) => {
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        sourceType: projects.sourceType,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        datastoreCount: count(datastoreConfigs.id),
      })
      .from(projects)
      .leftJoin(datastoreConfigs, eq(datastoreConfigs.projectId, projects.id))
      .where(eq(projects.workspaceId, c.get("workspace").id))
      .groupBy(projects.id)
      .orderBy(desc(projects.updatedAt));
    return ok(c, rows);
  })
  .post("/", requirePermission("projects.manage"), async (c) => {
    const input = await body(c, projectSchema);
    await assertWithin(c.get("workspace"), "projects");
    const [p] = await db.insert(projects).values({ ...input, workspaceId: c.get("workspace").id }).returning();
    return ok(c, p, 201);
  })
  .get("/:id", async (c) => ok(c, await loadProject(c.get("workspace").id, c.req.param("id"))))
  .patch("/:id", requirePermission("projects.manage"), async (c) => {
    const p = await loadProject(c.get("workspace").id, c.req.param("id"));
    const input = await body(c, projectSchema.partial());
    const [u] = await db.update(projects).set(input).where(eq(projects.id, p.id)).returning();
    return ok(c, u);
  })
  .delete("/:id", requirePermission("projects.manage"), async (c) => {
    const p = await loadProject(c.get("workspace").id, c.req.param("id"));
    await db.delete(projects).where(eq(projects.id, p.id));
    return ok(c, { ok: true });
  })
  .get("/:id/datastores", async (c) => {
    const ws = c.get("workspace");
    const p = await loadProject(ws.id, c.req.param("id"));
    const rows = await db
      .select({ config: datastoreConfigs, connectionName: robloxConnections.name, connectionStatus: robloxConnections.status })
      .from(datastoreConfigs)
      .innerJoin(robloxConnections, eq(robloxConnections.id, datastoreConfigs.connectionId))
      .where(and(eq(datastoreConfigs.projectId, p.id), eq(datastoreConfigs.workspaceId, ws.id)))
      .orderBy(datastoreConfigs.createdAt);
    return ok(
      c,
      rows.map((r) => ({ ...r.config, connection: { id: r.config.connectionId, name: r.connectionName, status: r.connectionStatus } })),
    );
  })
  .post("/:id/datastores", requirePermission("datastores.manage"), async (c) => {
    const ws = c.get("workspace");
    const p = await loadProject(ws.id, c.req.param("id"));
    const input = await body(c, configSchema);
    // Koneksi harus milik workspace yang sama (tenant isolation)
    const [conn] = await db
      .select()
      .from(robloxConnections)
      .where(and(eq(robloxConnections.id, input.connectionId), eq(robloxConnections.workspaceId, ws.id)))
      .limit(1);
    if (!conn) throw notFound("Connection");
    let universeName: string | null = null;
    try {
      universeName = (await getUniverse(await authFor(conn), input.universeId)).displayName || null;
    } catch {
      // Nama experience opsional (butuh izin baca universe)
    }
    try {
      const [row] = await db
        .insert(datastoreConfigs)
        .values({ ...input, placeId: input.placeId ?? null, universeName, workspaceId: ws.id, projectId: p.id })
        .returning();
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, p.id));
      return ok(c, row, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, "DUPLICATE_DATASTORE", "This DataStore is already configured in this project");
      throw e;
    }
  })
  .delete("/:id/datastores/:configId", requirePermission("datastores.manage"), async (c) => {
    const ws = c.get("workspace");
    const p = await loadProject(ws.id, c.req.param("id"));
    const configId = uuidParam.parse(c.req.param("configId"));
    const r = await db
      .delete(datastoreConfigs)
      .where(and(eq(datastoreConfigs.id, configId), eq(datastoreConfigs.projectId, p.id), eq(datastoreConfigs.workspaceId, ws.id)))
      .returning({ id: datastoreConfigs.id });
    if (!r.length) throw notFound("DataStore config");
    return ok(c, { ok: true });
  });
