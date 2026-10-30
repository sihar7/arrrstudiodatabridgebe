import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { config } from "@/config";
import { db } from "@/db";
import { datastoreConfigs, migrationItems, migrationLogs, migrations, robloxConnections, workspaces, type ItemStatus } from "@/db/schema";
import { effectivePlan, limitFor } from "@/lib/plans";
import { authFor } from "@/roblox/credentials";
import { OpenCloudError, canonical, createEntry, getEntry, listEntryKeys, md5, upsertEntry, type Entry, type OcAuth, type StoreRef } from "@/roblox/openCloud";

// Migration engine. Alur per key: baca sumber → cek konflik → tulis tujuan → baca ulang & verifikasi.
// Semua state di Postgres (checkpoint enumerasi + status per key), jadi job aman dilanjutkan setelah
// worker mati, dan "retry failed" hanya mengulang key gagal. Dry run = semua langkah kecuali tulis.
// Migrasi lintas DataStore TIDAK atomik — lihat docs cutover.

type Migration = typeof migrations.$inferSelect;
class PlanLimitError extends Error {}
type Ctx = {
  m: Migration;
  src: { ref: StoreRef; conn: typeof robloxConnections.$inferSelect };
  dst: { ref: StoreRef; conn: typeof robloxConnections.$inferSelect };
};

export async function log(migrationId: string, level: "info" | "warn" | "error", message: string) {
  await db.insert(migrationLogs).values({ migrationId, level, message: message.slice(0, 500) });
}

async function loadCtx(id: string): Promise<Ctx | null> {
  const [m] = await db.select().from(migrations).where(eq(migrations.id, id)).limit(1);
  if (!m) return null;
  const cfgs = await db
    .select({ cfg: datastoreConfigs, conn: robloxConnections })
    .from(datastoreConfigs)
    .innerJoin(robloxConnections, eq(robloxConnections.id, datastoreConfigs.connectionId))
    .where(inArray(datastoreConfigs.id, [m.sourceConfigId, m.destinationConfigId]));
  const s = cfgs.find((x) => x.cfg.id === m.sourceConfigId);
  const d = cfgs.find((x) => x.cfg.id === m.destinationConfigId);
  if (!s || !d) return null;
  const ref = (c: typeof s.cfg): StoreRef => ({ universeId: c.universeId, datastore: c.datastoreName, scope: c.scope, type: c.datastoreType });
  return { m, src: { ref: ref(s.cfg), conn: s.conn }, dst: { ref: ref(d.cfg), conn: d.conn } };
}

async function currentStatus(id: string) {
  const [r] = await db.select({ status: migrations.status }).from(migrations).where(eq(migrations.id, id)).limit(1);
  return r?.status;
}

/** Status run ini; "superseded" bila run lain sudah mengklaim migrasi (token berbeda). */
async function runState(id: string, token: string) {
  const [r] = await db.select({ status: migrations.status, runToken: migrations.runToken }).from(migrations).where(eq(migrations.id, id)).limit(1);
  if (!r) return "missing";
  if (r.runToken !== token) return "superseded";
  return r.status;
}

export function destinationKey(m: Pick<Migration, "conflictStrategy" | "renamePattern">, key: string) {
  if (m.conflictStrategy !== "rename_key" || !m.renamePattern) return key;
  return m.renamePattern.replaceAll("{key}", key).slice(0, 50);
}

/** Hitung ulang counter dari status item (idempoten, akurat setelah crash/retry). */
export async function recount(id: string) {
  const rows = await db
    .select({ status: migrationItems.status, n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${migrationItems.size}),0)::bigint` })
    .from(migrationItems)
    .where(eq(migrationItems.migrationId, id))
    .groupBy(migrationItems.status);
  const by = (s: ItemStatus) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  const counts = {
    totalKeys: total,
    successCount: by("success"),
    skippedCount: by("skipped"),
    conflictCount: by("conflict"),
    failedCount: by("failed"),
    bytesRead: rows.reduce((a, r) => a + Number(r.bytes), 0),
  };
  const processed = counts.successCount + counts.skippedCount + counts.conflictCount + counts.failedCount;
  await db.update(migrations).set({ ...counts, processed }).where(eq(migrations.id, id));
  return { ...counts, processed };
}

/** Tahap 1: enumerasi key sumber ke migration_items (checkpoint pageToken tiap halaman). */
async function enumerate(ctx: Ctx, auth: () => Promise<OcAuth>, token: string): Promise<"done" | "stopped"> {
  const { m } = ctx;
  const insertKeys = async (keys: string[]) => {
    if (!keys.length) return;
    await db
      .insert(migrationItems)
      .values(keys.map((k) => ({ migrationId: m.id, sourceKey: k, destinationKey: destinationKey(m, k) })))
      .onConflictDoNothing();
  };
  if (m.mode === "selected") {
    await insertKeys([...new Set((m.selectedKeys ?? []).map((k) => k.trim()).filter(Boolean))]);
    await db.update(migrations).set({ enumDone: true }).where(eq(migrations.id, m.id));
    await recount(m.id);
    return "done";
  }
  let cursor = m.enumCursor ?? undefined;
  for (;;) {
    if ((await runState(m.id, token)) !== "running") return "stopped";
    const page = await listEntryKeys(await auth(), ctx.src.ref, { pageToken: cursor, prefix: m.mode === "prefix" ? (m.prefix ?? "") : undefined });
    await insertKeys(page.keys);
    cursor = page.nextPageToken ?? undefined;
    await db.update(migrations).set({ enumCursor: cursor ?? null, enumDone: !cursor }).where(eq(migrations.id, m.id));
    await recount(m.id);
    if (!cursor) return "done";
  }
}

async function setItem(id: string, patch: Partial<typeof migrationItems.$inferInsert>) {
  await db.update(migrationItems).set(patch).where(eq(migrationItems.id, id));
}

const sameUsers = (a: string[], b: string[]) => canonical([...a].sort()) === canonical([...b].sort());

/** Tahap 2: proses satu key. Tidak pernah melempar — hasil dicatat di item. */
async function processItem(ctx: Ctx, item: typeof migrationItems.$inferSelect, srcAuth: OcAuth, dstAuth: OcAuth) {
  const { m } = ctx;
  const finish = (status: ItemStatus, extra: Partial<typeof migrationItems.$inferInsert> = {}) =>
    setItem(item.id, { status, errorCode: null, errorMessage: null, ...extra });
  try {
    await setItem(item.id, { status: "reading", attempts: item.attempts + 1 });
    const src = await getEntry(srcAuth, ctx.src.ref, item.sourceKey);
    if (!src) return finish("failed", { errorCode: "SOURCE_MISSING", errorMessage: "Key no longer exists in the source" });
    const size = Buffer.byteLength(JSON.stringify(src.value ?? null));
    const checksum = md5(src.value);

    // Tanpa GET cek-tujuan (hemat 1 request/key): overwrite → upsert; selain itu create atomik —
    // Roblox menolak bila key sudah ada, lalu strategi konflik diterapkan.
    await setItem(item.id, { status: "writing" });
    const body = { value: src.value, users: src.users, attributes: src.attributes };
    try {
      if (m.conflictStrategy === "overwrite") await upsertEntry(dstAuth, ctx.dst.ref, item.destinationKey, body);
      else await createEntry(dstAuth, ctx.dst.ref, item.destinationKey, body);
    } catch (e) {
      if (e instanceof OpenCloudError && e.kind === "conflict") {
        return finish(m.conflictStrategy === "skip_existing" ? "skipped" : "conflict", { size, checksum, errorCode: "EXISTS" });
      }
      throw e;
    }

    if (m.verify) {
      await setItem(item.id, { status: "verifying" });
      const back: Entry | null = await getEntry(dstAuth, ctx.dst.ref, item.destinationKey);
      if (!back || canonical(back.value) !== canonical(src.value) || !sameUsers(back.users, src.users)) {
        return finish("failed", { size, checksum, errorCode: "VERIFY_MISMATCH", errorMessage: "Read-back value differs from source" });
      }
    }
    return finish("success", { size, checksum });
  } catch (e) {
    const code = e instanceof OpenCloudError ? `ROBLOX_${e.kind.toUpperCase()}` : "INTERNAL";
    const msg = e instanceof Error ? e.message : String(e);
    return finish("failed", { errorCode: code, errorMessage: msg.slice(0, 300) });
  }
}

/**
 * Dry run kilat: daftar SEMUA key tujuan (256 key/request) lalu cocokkan dengan key sumber di memori —
 * tanpa membaca isi tiap key. 42 rb key ≈ ±330 request (bukan ±84 rb). Tidak menulis apa pun.
 */
async function dryRunFast(ctx: Ctx, token: string, dstAuth: () => Promise<OcAuth>): Promise<"done" | "stopped"> {
  const { m } = ctx;
  const existing = new Set<string>();
  let cursor: string | undefined;
  do {
    if ((await runState(m.id, token)) !== "running") return "stopped";
    const page = await listEntryKeys(await dstAuth(), ctx.dst.ref, { pageToken: cursor });
    for (const k of page.keys) existing.add(k);
    cursor = page.nextPageToken ?? undefined;
  } while (cursor);
  await log(m.id, "info", `Destination already has ${existing.size} key(s)`);

  for (;;) {
    if ((await runState(m.id, token)) !== "running") return "stopped";
    const batch = await db
      .select({ id: migrationItems.id, destinationKey: migrationItems.destinationKey })
      .from(migrationItems)
      .where(and(eq(migrationItems.migrationId, m.id), eq(migrationItems.status, "pending")))
      .limit(2000);
    if (!batch.length) return "done";
    const groups: Record<"success" | "skipped" | "conflict", string[]> = { success: [], skipped: [], conflict: [] };
    for (const it of batch) {
      if (!existing.has(it.destinationKey) || m.conflictStrategy === "overwrite") groups.success.push(it.id);
      else groups[m.conflictStrategy === "skip_existing" ? "skipped" : "conflict"].push(it.id);
    }
    for (const [status, ids] of Object.entries(groups) as [ItemStatus, string[]][]) {
      if (!ids.length) continue;
      await db
        .update(migrationItems)
        .set({ status, errorCode: status === "success" ? null : "EXISTS", errorMessage: null })
        .where(inArray(migrationItems.id, ids));
    }
    await recount(m.id);
  }
}

/** Jalankan (atau lanjutkan) satu migrasi. Aman dipanggil ulang; berhenti saat status bukan running. */
export async function runMigration(id: string): Promise<void> {
  const token = randomUUID();
  const [claimed] = await db
    .update(migrations)
    .set({ status: "running", runToken: token, startedAt: sql`coalesce(${migrations.startedAt}, now())`, lastError: null })
    .where(and(eq(migrations.id, id), eq(migrations.status, "queued")))
    .returning({ id: migrations.id });
  if (!claimed) return; // sudah diambil worker lain / dijeda / dibatalkan
  const ctx = await loadCtx(id);
  if (!ctx) return;
  const { m } = ctx;
  const srcAuth = () => authFor(ctx.src.conn);
  const dstAuth = () => authFor(ctx.dst.conn);
  await log(id, "info", m.dryRun ? "Dry run started — nothing will be written" : "Migration started");

  try {
    if (!m.enumDone) {
      await db.update(migrations).set({ currentOperation: "enumerating" }).where(eq(migrations.id, id));
      if ((await enumerate(ctx, srcAuth, token)) === "stopped") return await settleStop(id, token);
      const c = await recount(id);
      await log(id, "info", `Found ${c.totalKeys} key(s) in the source`);
      const [ws] = await db.select({ plan: workspaces.plan, exp: workspaces.planExpiresAt }).from(workspaces).where(eq(workspaces.id, m.workspaceId)).limit(1);
      const max = limitFor(effectivePlan(ws?.plan ?? "free", ws?.exp ?? null), "keysPerMigration");
      if (c.totalKeys > max) throw new PlanLimitError(`PLAN_LIMIT: ${c.totalKeys} keys exceed your plan limit of ${max} per migration`);
    }

    await db.update(migrations).set({ currentOperation: m.dryRun ? "simulating" : "copying" }).where(eq(migrations.id, id));
    if (m.dryRun && (await dryRunFast(ctx, token, dstAuth)) === "stopped") return await settleStop(id, token);
    const batchSize = config.migrationConcurrency * 4;
    for (;;) {
      if ((await runState(id, token)) !== "running") return await settleStop(id, token);
      const batch = await db
        .select()
        .from(migrationItems)
        .where(and(eq(migrationItems.migrationId, id), eq(migrationItems.status, "pending")))
        .orderBy(migrationItems.createdAt, migrationItems.id)
        .limit(batchSize);
      if (!batch.length) break;
      const [sa, da] = await Promise.all([srcAuth(), dstAuth()]);
      // Concurrency terbatas; limiter per universe di klien Open Cloud menahan laju request
      let i = 0;
      await Promise.all(
        Array.from({ length: Math.min(config.migrationConcurrency, batch.length) }, async () => {
          while (i < batch.length) {
            const item = batch[i++]!;
            await processItem(ctx, item, sa, da);
          }
        }),
      );
      await recount(id);
    }

    const c = await recount(id);
    const problems = c.failedCount + c.conflictCount;
    const status = problems > 0 ? "completed_with_errors" : "completed";
    await db
      .update(migrations)
      .set({ status, finishedAt: new Date(), currentOperation: null, ...(m.dryRun ? { lastDryRunAt: new Date() } : {}) })
      .where(eq(migrations.id, id));
    await log(
      id,
      problems ? "warn" : "info",
      `${m.dryRun ? "Dry run" : "Migration"} finished: ${c.successCount} ${m.dryRun ? "to write" : "written"}, ${c.skippedCount} skipped, ${c.conflictCount} conflict(s), ${c.failedCount} failed`,
    );
  } catch (e) {
    // Galat tingkat job (mis. enumerasi ditolak / kredensial dicabut) — item yang sudah selesai tetap tercatat
    const msg = e instanceof OpenCloudError ? `ROBLOX_${e.kind.toUpperCase()}: ${e.message}` : e instanceof Error ? e.message : String(e);
    await db.update(migrations).set({ status: "failed", lastError: msg.slice(0, 500), finishedAt: new Date(), currentOperation: null }).where(eq(migrations.id, id));
    await log(id, "error", `Job failed: ${msg}`);
  }
}

/** Dijeda/dibatalkan di tengah jalan: item yang sedang diproses dikembalikan ke pending. */
async function settleStop(id: string, token: string) {
  // Run lain sudah mengambil alih → jangan sentuh item yang sedang ia proses
  if ((await runState(id, token)) === "superseded") return;
  await db
    .update(migrationItems)
    .set({ status: "pending" })
    .where(and(eq(migrationItems.migrationId, id), inArray(migrationItems.status, ["reading", "writing", "verifying"])));
  const st = await currentStatus(id);
  if (st === "cancelling") {
    await recount(id);
    await db.update(migrations).set({ status: "cancelled", finishedAt: new Date(), currentOperation: null }).where(eq(migrations.id, id));
    await log(id, "warn", "Migration cancelled — keys already written stay in the destination");
  } else if (st === "paused") {
    await db.update(migrations).set({ currentOperation: null }).where(eq(migrations.id, id));
    await log(id, "info", "Migration paused");
  }
}

/** Worker mati di tengah job → saat start: running jadi queued, item setengah jalan jadi pending. */
export async function recoverInterrupted(): Promise<string[]> {
  const stuck = await db
    .select({ id: migrations.id, status: migrations.status })
    .from(migrations)
    .where(inArray(migrations.status, ["running", "queued", "cancelling"]));
  for (const s of stuck) {
    await db
      .update(migrationItems)
      .set({ status: "pending" })
      .where(and(eq(migrationItems.migrationId, s.id), inArray(migrationItems.status, ["reading", "writing", "verifying"])));
    if (s.status === "cancelling") {
      await db.update(migrations).set({ status: "cancelled", finishedAt: new Date(), currentOperation: null }).where(eq(migrations.id, s.id));
    } else {
      await db.update(migrations).set({ status: "queued" }).where(eq(migrations.id, s.id));
    }
  }
  return stuck.filter((s) => s.status !== "cancelling").map((s) => s.id);
}
