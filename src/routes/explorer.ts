import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { datastoreConfigs, projects, robloxConnections } from "@/db/schema";
import { notFound, ok } from "@/lib/http";
import { rateLimit } from "@/lib/rateLimit";
import type { Env } from "@/middleware/auth";
import { authFor } from "@/roblox/credentials";
import { getEntry, listEntryKeys, md5 } from "@/roblox/openCloud";

// Data Explorer (read-only, PRD §3.4): daftar key dengan pagination + isi entry & metadata. Tidak ada edit/hapus.

async function loadConfig(workspaceId: string, id: string) {
  const [row] = await db
    .select({ cfg: datastoreConfigs, conn: robloxConnections })
    .from(datastoreConfigs)
    .innerJoin(robloxConnections, eq(robloxConnections.id, datastoreConfigs.connectionId))
    .where(and(eq(datastoreConfigs.id, z.string().uuid().parse(id)), eq(datastoreConfigs.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw notFound("DataStore config");
  return { ref: { universeId: row.cfg.universeId, datastore: row.cfg.datastoreName, scope: row.cfg.scope }, conn: row.conn };
}

export const explorerRoutes = new Hono<Env>()
  // Semua konfigurasi DataStore di workspace (sidebar explorer & wizard migrasi)
  .get("/configs", async (c) => {
    const rows = await db
      .select({ cfg: datastoreConfigs, projectName: projects.name, connectionName: robloxConnections.name, connectionStatus: robloxConnections.status })
      .from(datastoreConfigs)
      .innerJoin(projects, eq(projects.id, datastoreConfigs.projectId))
      .innerJoin(robloxConnections, eq(robloxConnections.id, datastoreConfigs.connectionId))
      .where(eq(datastoreConfigs.workspaceId, c.get("workspace").id))
      .orderBy(projects.name, datastoreConfigs.createdAt);
    return ok(
      c,
      rows.map((r) => ({ ...r.cfg, projectName: r.projectName, connection: { id: r.cfg.connectionId, name: r.connectionName, status: r.connectionStatus } })),
    );
  })
  .get("/:configId/keys", rateLimit({ key: "explore-keys", windowMs: 60_000, max: 60 }), async (c) => {
    const { ref, conn } = await loadConfig(c.get("workspace").id, c.req.param("configId"));
    const r = await listEntryKeys(await authFor(conn), ref, {
      pageToken: c.req.query("pageToken") || undefined,
      prefix: c.req.query("prefix") || undefined,
      pageSize: 100,
    });
    return ok(c, r.keys, 200, { nextPageToken: r.nextPageToken });
  })
  .get("/:configId/entry", rateLimit({ key: "explore-entry", windowMs: 60_000, max: 120 }), async (c) => {
    const { ref, conn } = await loadConfig(c.get("workspace").id, c.req.param("configId"));
    const key = z.string().min(1).max(50).parse(c.req.query("key"));
    const entry = await getEntry(await authFor(conn), ref, key);
    if (!entry) throw notFound("Entry");
    return ok(c, { ...entry, size: Buffer.byteLength(JSON.stringify(entry.value ?? null)), checksum: md5(entry.value) });
  });
