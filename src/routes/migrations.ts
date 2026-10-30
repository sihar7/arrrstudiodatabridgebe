import { aliasedTable, and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { CONFLICT_STRATEGIES, ITEM_STATUS, datastoreConfigs, migrationItems, migrationLogs, migrations, projects, robloxConnections } from "@/db/schema";
import { ApiError, body, notFound, ok } from "@/lib/http";
import { requirePermission, type Env } from "@/middleware/auth";
import { destinationKey, log, recount } from "@/migrations/engine";
import { enqueueMigration } from "@/migrations/queue";
import { capabilitiesOf, universesOf } from "@/roblox/openCloud";
import { assertWithin, limitFor, planOf } from "@/lib/plans";

// Migration API (PRD §6): buat → validasi → dry run → start → pause/resume/cancel → progress/items/logs → retry gagal.

const uuid = z.string().uuid();
const key = z.string().trim().min(1).max(50);
const baseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  projectId: uuid,
  sourceConfigId: uuid,
  destinationConfigId: uuid,
  mode: z.enum(["full", "selected", "prefix"]).default("full"),
  selectedKeys: z.array(key).max(10_000).nullish(),
  prefix: z.string().trim().max(50).nullish(),
  conflictStrategy: z.enum(CONFLICT_STRATEGIES).default("skip_existing"),
  renamePattern: z.string().trim().max(50).nullish(),
  verify: z.boolean().default(true),
});
const createSchema = baseSchema.superRefine((v, ctx) => {
  if (v.mode === "selected" && !v.selectedKeys?.length) ctx.addIssue({ code: "custom", path: ["selectedKeys"], message: "Add at least one key" });
  if (v.mode === "prefix" && !v.prefix) ctx.addIssue({ code: "custom", path: ["prefix"], message: "Enter a prefix" });
  if (v.conflictStrategy === "rename_key" && !v.renamePattern?.includes("{key}"))
    ctx.addIssue({ code: "custom", path: ["renamePattern"], message: "Pattern must contain {key}" });
});
const startSchema = z.object({ confirm: z.string().optional() }).default({});

const src = aliasedTable(datastoreConfigs, "src");
const dst = aliasedTable(datastoreConfigs, "dst");

async function loadMigration(workspaceId: string, id: string) {
  const [m] = await db
    .select()
    .from(migrations)
    .where(and(eq(migrations.id, uuid.parse(id)), eq(migrations.workspaceId, workspaceId)))
    .limit(1);
  if (!m) throw notFound("Migration");
  return m;
}

/** Baris lengkap untuk klien: migrasi + ringkasan sumber/tujuan + persentase + kecepatan. */
async function present(workspaceId: string, ids?: string[]) {
  const rows = await db
    .select({ m: migrations, src, dst, projectName: projects.name })
    .from(migrations)
    .innerJoin(src, eq(src.id, migrations.sourceConfigId))
    .innerJoin(dst, eq(dst.id, migrations.destinationConfigId))
    .innerJoin(projects, eq(projects.id, migrations.projectId))
    .where(and(eq(migrations.workspaceId, workspaceId), ids ? inArray(migrations.id, ids) : undefined))
    .orderBy(desc(migrations.createdAt));
  const side = (c: typeof src.$inferSelect) => ({ id: c.id, label: c.label, universeId: c.universeId, universeName: c.universeName, datastoreName: c.datastoreName, scope: c.scope });
  return rows.map(({ m, src: s, dst: d, projectName }) => {
    const elapsed = m.startedAt ? ((m.finishedAt ?? new Date()).getTime() - m.startedAt.getTime()) / 1000 : 0;
    const { runToken: _r, enumCursor: _c, ...rest } = m;
    return {
      ...rest,
      projectName,
      source: side(s),
      destination: side(d),
      progress: {
        total: m.totalKeys,
        processed: m.processed,
        success: m.successCount,
        skipped: m.skippedCount,
        conflicts: m.conflictCount,
        failed: m.failedCount,
        percentage: m.totalKeys ? Math.min(100, Math.round((m.processed / m.totalKeys) * 1000) / 10) : m.status === "completed" ? 100 : 0,
        keysPerSecond: elapsed > 0 ? Math.round((m.processed / elapsed) * 10) / 10 : 0,
        enumerating: !m.enumDone,
      },
    };
  });
}

type Issue = { code: string; detail?: string };

/** Validasi konfigurasi sebelum dry run / start (PRD §3.1 safety). */
async function validate(m: typeof migrations.$inferSelect, real: boolean, plan = "free") {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const cfgs = await db
    .select({ cfg: datastoreConfigs, conn: robloxConnections })
    .from(datastoreConfigs)
    .innerJoin(robloxConnections, eq(robloxConnections.id, datastoreConfigs.connectionId))
    .where(inArray(datastoreConfigs.id, [m.sourceConfigId, m.destinationConfigId]));
  const s = cfgs.find((x) => x.cfg.id === m.sourceConfigId);
  const d = cfgs.find((x) => x.cfg.id === m.destinationConfigId);
  if (!s || !d) return { ok: false, errors: [{ code: "CONFIG_MISSING" }], warnings };

  const sameStore = s.cfg.universeId === d.cfg.universeId && s.cfg.datastoreName === d.cfg.datastoreName && s.cfg.scope === d.cfg.scope;
  if (sameStore && m.conflictStrategy !== "rename_key") errors.push({ code: "SAME_DATASTORE" });
  if (s.cfg.universeId === d.cfg.universeId && !sameStore) warnings.push({ code: "SAME_UNIVERSE" });

  for (const [role, x] of [["source", s], ["destination", d]] as const) {
    if (x.conn.status !== "active") errors.push({ code: "CONNECTION_INACTIVE", detail: `${role}: ${x.conn.name}` });
    if (!x.conn.keyInfo) continue;
    const caps = capabilitiesOf(x.conn.keyInfo);
    const unis = universesOf(x.conn.keyInfo);
    if (!unis.all && unis.ids.length && !unis.ids.includes(x.cfg.universeId)) errors.push({ code: "NO_UNIVERSE_ACCESS", detail: `${role}: ${x.cfg.universeId}` });
    if (!caps.read) errors.push({ code: "MISSING_READ", detail: role });
    if (role === "source" && m.mode !== "selected" && !caps.listKeys) errors.push({ code: "MISSING_LIST", detail: role });
    if (role === "destination" && real && !caps.create) errors.push({ code: "MISSING_CREATE", detail: role });
    if (role === "destination" && real && m.conflictStrategy === "overwrite" && !caps.update) errors.push({ code: "MISSING_UPDATE", detail: role });
  }
  // Fitur per paket (tabel banding /pricing)
  const p = planOf(plan);
  if (!p.selectiveModes && m.mode !== "full") errors.push({ code: "PLAN_FEATURE", detail: "mode" });
  if (!p.allConflictStrategies && m.conflictStrategy !== "skip_existing") errors.push({ code: "PLAN_FEATURE", detail: "conflictStrategy" });
  if (!p.crossExperience && s.cfg.universeId !== d.cfg.universeId) errors.push({ code: "PLAN_FEATURE", detail: "crossExperience" });
  if (m.conflictStrategy === "overwrite") warnings.push({ code: "OVERWRITE" });
  if (!m.verify) warnings.push({ code: "NO_VERIFY" });
  if (real) warnings.push({ code: "LIVE_DATA" });
  return { ok: errors.length === 0, errors, warnings };
}

/** Reset hasil run sebelumnya lalu antrekan run baru (dry run atau sungguhan). */
async function queueRun(id: string, dryRun: boolean) {
  await db.delete(migrationItems).where(eq(migrationItems.migrationId, id));
  await db
    .update(migrations)
    .set({
      status: "queued",
      dryRun,
      enumCursor: null,
      enumDone: false,
      totalKeys: 0,
      processed: 0,
      successCount: 0,
      skippedCount: 0,
      conflictCount: 0,
      failedCount: 0,
      bytesRead: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      currentOperation: "queued",
    })
    .where(eq(migrations.id, id));
  await log(id, "info", dryRun ? "Dry run queued" : "Migration queued");
  await enqueueMigration(id);
}

const ACTIVE = ["queued", "running", "cancelling"] as const;
const isActive = (s: string) => (ACTIVE as readonly string[]).includes(s);

export const migrationRoutes = new Hono<Env>()
  .get("/", async (c) => ok(c, await present(c.get("workspace").id)))
  .post("/", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const input = await body(c, createSchema);
    // Project & kedua konfigurasi harus milik workspace ini (tenant isolation)
    const cfgs = await db
      .select({ id: datastoreConfigs.id })
      .from(datastoreConfigs)
      .where(and(eq(datastoreConfigs.workspaceId, ws.id), eq(datastoreConfigs.projectId, input.projectId), inArray(datastoreConfigs.id, [input.sourceConfigId, input.destinationConfigId])));
    if (cfgs.length !== (input.sourceConfigId === input.destinationConfigId ? 1 : 2)) throw notFound("DataStore config");
    if (input.mode === "selected" && input.selectedKeys!.length > limitFor(ws.plan, "keysPerMigration")) {
      throw new ApiError(402, "PLAN_LIMIT", "Too many keys for your plan", { limit: "keysPerMigration" });
    }
    const [m] = await db
      .insert(migrations)
      .values({ ...input, workspaceId: ws.id, createdBy: c.get("user").id, status: "draft" })
      .returning({ id: migrations.id });
    await log(m!.id, "info", "Migration created");
    return ok(c, (await present(ws.id, [m!.id]))[0], 201);
  })
  .get("/:id", async (c) => {
    const m = await loadMigration(c.get("workspace").id, c.req.param("id"));
    return ok(c, (await present(c.get("workspace").id, [m.id]))[0]);
  })
  .patch("/:id", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    if (isActive(m.status)) throw new ApiError(409, "MIGRATION_ACTIVE", "Pause or cancel the migration first");
    const input = await body(c, baseSchema.partial().omit({ projectId: true, sourceConfigId: true, destinationConfigId: true }));
    // Konfigurasi berubah → hasil dry run lama tidak berlaku
    await db.update(migrations).set({ ...input, status: "draft", lastDryRunAt: null }).where(eq(migrations.id, m.id));
    return ok(c, (await present(ws.id, [m.id]))[0]);
  })
  .delete("/:id", requirePermission("migrations.run"), async (c) => {
    const m = await loadMigration(c.get("workspace").id, c.req.param("id"));
    if (isActive(m.status)) throw new ApiError(409, "MIGRATION_ACTIVE", "Cancel the migration first");
    await db.delete(migrations).where(eq(migrations.id, m.id));
    return ok(c, { ok: true });
  })
  .post("/:id/validate", async (c) => {
    const m = await loadMigration(c.get("workspace").id, c.req.param("id"));
    return ok(c, await validate(m, c.req.query("real") === "1", c.get("workspace").plan));
  })
  .post("/:id/dry-run", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    if (isActive(m.status)) throw new ApiError(409, "MIGRATION_ACTIVE", "This migration is already running");
    const v = await validate(m, false, ws.plan);
    if (!v.ok) throw new ApiError(422, "MIGRATION_INVALID", "Fix the configuration first", v);
    await assertWithin(ws, "concurrentJobs");
    await queueRun(m.id, true);
    return ok(c, (await present(ws.id, [m.id]))[0]);
  })
  .post("/:id/start", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    if (isActive(m.status)) throw new ApiError(409, "MIGRATION_ACTIVE", "This migration is already running");
    // Wajib dry run sukses dulu (dan konfigurasi tidak berubah sesudahnya)
    if (!m.lastDryRunAt) throw new ApiError(409, "DRY_RUN_REQUIRED", "Run a dry run first");
    const { confirm } = await body(c, startSchema).catch(() => ({ confirm: undefined }));
    if (m.conflictStrategy === "overwrite" && confirm !== "OVERWRITE") throw new ApiError(409, "CONFIRM_OVERWRITE", "Type OVERWRITE to confirm");
    const v = await validate(m, true, ws.plan);
    if (!v.ok) throw new ApiError(422, "MIGRATION_INVALID", "Fix the configuration first", v);
    await assertWithin(ws, "concurrentJobs");
    await queueRun(m.id, false);
    return ok(c, (await present(ws.id, [m.id]))[0]);
  })
  .post("/:id/pause", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    if (m.status !== "running" && m.status !== "queued") throw new ApiError(409, "INVALID_STATE", "Only running migrations can be paused");
    await db.update(migrations).set({ status: "paused", currentOperation: "pausing" }).where(eq(migrations.id, m.id));
    return ok(c, (await present(ws.id, [m.id]))[0]);
  })
  .post("/:id/resume", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    if (m.status !== "paused") throw new ApiError(409, "INVALID_STATE", "Only paused migrations can be resumed");
    await db.update(migrations).set({ status: "queued", currentOperation: "queued" }).where(eq(migrations.id, m.id));
    await log(m.id, "info", "Migration resumed");
    await enqueueMigration(m.id);
    return ok(c, (await present(ws.id, [m.id]))[0]);
  })
  .post("/:id/cancel", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    if (m.status === "running") {
      await db.update(migrations).set({ status: "cancelling", currentOperation: "cancelling" }).where(eq(migrations.id, m.id));
    } else if (m.status === "queued" || m.status === "paused") {
      await recount(m.id);
      await db.update(migrations).set({ status: "cancelled", finishedAt: new Date(), currentOperation: null }).where(eq(migrations.id, m.id));
      await log(m.id, "warn", "Migration cancelled");
    } else throw new ApiError(409, "INVALID_STATE", "Nothing to cancel");
    return ok(c, (await present(ws.id, [m.id]))[0]);
  })
  .post("/:id/retry-failed", requirePermission("migrations.run"), async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    if (isActive(m.status)) throw new ApiError(409, "MIGRATION_ACTIVE", "This migration is already running");
    if (m.dryRun) throw new ApiError(409, "DRY_RUN_RESULT", "Retry applies to real runs — start the migration instead");
    const r = await db
      .update(migrationItems)
      .set({ status: "pending", errorCode: null, errorMessage: null })
      .where(and(eq(migrationItems.migrationId, m.id), eq(migrationItems.status, "failed")))
      .returning({ id: migrationItems.id });
    if (!r.length) throw new ApiError(409, "NOTHING_TO_RETRY", "No failed keys");
    await recount(m.id);
    // Key sukses tidak diulang; enumerasi tidak diulang
    await db.update(migrations).set({ status: "queued", finishedAt: null, currentOperation: "queued" }).where(eq(migrations.id, m.id));
    await log(m.id, "info", `Retrying ${r.length} failed key(s)`);
    await enqueueMigration(m.id);
    return ok(c, (await present(ws.id, [m.id]))[0]);
  })
  .get("/:id/progress", async (c) => {
    const ws = c.get("workspace");
    const m = await loadMigration(ws.id, c.req.param("id"));
    const logs = await db.select().from(migrationLogs).where(eq(migrationLogs.migrationId, m.id)).orderBy(desc(migrationLogs.createdAt)).limit(15);
    return ok(c, { ...(await present(ws.id, [m.id]))[0], recentLogs: logs });
  })
  .get("/:id/items", async (c) => {
    const m = await loadMigration(c.get("workspace").id, c.req.param("id"));
    const status = z.enum(ITEM_STATUS).optional().parse(c.req.query("status") || undefined);
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    const where = and(eq(migrationItems.migrationId, m.id), status ? eq(migrationItems.status, status) : undefined);
    const [rows, [cnt]] = await Promise.all([
      db.select().from(migrationItems).where(where).orderBy(migrationItems.createdAt, migrationItems.id).limit(limit).offset(offset),
      db.select({ n: sql<number>`count(*)::int` }).from(migrationItems).where(where),
    ]);
    return ok(c, rows, 200, { total: Number(cnt?.n ?? 0), limit, offset });
  })
  .get("/:id/logs", async (c) => {
    const m = await loadMigration(c.get("workspace").id, c.req.param("id"));
    const rows = await db.select().from(migrationLogs).where(eq(migrationLogs.migrationId, m.id)).orderBy(desc(migrationLogs.createdAt)).limit(200);
    return ok(c, rows);
  })
  // Pratinjau nama key tujuan untuk pola rename
  .get("/preview/rename", (c) => {
    const pattern = c.req.query("pattern") ?? "{key}";
    const sample = c.req.query("key") ?? "Player_123";
    return ok(c, { destination: destinationKey({ conflictStrategy: "rename_key", renamePattern: pattern }, sample) });
  });
