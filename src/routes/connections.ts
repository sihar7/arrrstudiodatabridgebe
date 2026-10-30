import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { datastoreConfigs, robloxConnections, type ConnectionStatus, type KeyInfo } from "@/db/schema";
import { decryptSecret, encryptSecret, fingerprint } from "@/lib/crypto";
import { ApiError, body, notFound, ok } from "@/lib/http";
import { assertWithin } from "@/lib/plans";
import { rateLimit } from "@/lib/rateLimit";
import { requirePermission, type Env } from "@/middleware/auth";
import { authFor } from "@/roblox/credentials";
import { findUserByUsername, grantedUniverses, revokeToken } from "@/roblox/oauth";
import { OpenCloudError, capabilitiesOf, getUniverse, introspectKey, listDataStores, universeOfPlace, universesOf } from "@/roblox/openCloud";

// Koneksi Roblox Open Cloud per workspace: API key (ditempel) atau OAuth ("Connect with Roblox").
// Kredensial dienkripsi dan tidak pernah dikembalikan plaintext (AC-02).

const apiKey = z.string().trim().min(20, "This does not look like an Open Cloud API key").max(4096);
const createSchema = z.object({ name: z.string().trim().min(1).max(80), apiKey });
const updateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), apiKey: apiKey.optional() });
const numericId = z.string().regex(/^\d{1,20}$/, "Must be a numeric id");
const uuidParam = z.string().uuid();

type Conn = typeof robloxConnections.$inferSelect;

/** Bentuk aman untuk klien — tanpa kredensial terenkripsi. */
export function presentConnection(row: Conn) {
  const info = row.keyInfo;
  return {
    id: row.id,
    name: row.name,
    authType: row.authType,
    keyHint: row.authType === "api_key" ? `••••${row.keyHint}` : row.keyHint,
    keyFingerprint: row.keyFingerprint,
    status: row.status,
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    key: info
      ? {
          name: info.name,
          enabled: info.enabled,
          expired: info.expired,
          expiresAt: info.expiresAt,
          capabilities: capabilitiesOf(info),
          universes: universesOf(info),
          scopes: info.scopes.map((s) => ({ name: s.name, operations: s.operations })),
        }
      : null,
  };
}

/** Scope string OAuth ("universe-datastores.objects:read ...") + universe yang diizinkan → bentuk KeyInfo. */
export function keyInfoFromOAuth(scope: string, universes: string[], label: string): KeyInfo {
  const byName = new Map<string, Set<string>>();
  for (const s of scope.split(/\s+/)) {
    const [name, op] = s.split(":");
    if (!name || !op) continue;
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name)!.add(op);
  }
  return {
    name: label,
    authorizedUserId: null,
    enabled: true,
    expired: false,
    expiresAt: null,
    scopes: [...byName].map(([name, ops]) => ({ name, operations: [...ops], universeIds: universes, datastores: [] })),
  };
}

function statusOf(info: KeyInfo): ConnectionStatus {
  if (info.expired) return "expired";
  if (!info.enabled) return "disabled";
  return "active";
}

export async function loadConnection(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(robloxConnections)
    .where(and(eq(robloxConnections.id, uuidParam.parse(id)), eq(robloxConnections.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw notFound("Connection");
  return row;
}

async function assertUniqueKey(workspaceId: string, fp: string, exceptId?: string) {
  const [dup] = await db
    .select({ id: robloxConnections.id })
    .from(robloxConnections)
    .where(and(eq(robloxConnections.workspaceId, workspaceId), eq(robloxConnections.keyFingerprint, fp)))
    .limit(1);
  if (dup && dup.id !== exceptId) throw new ApiError(409, "DUPLICATE_KEY", "This API key is already connected in this workspace");
}

/** Introspect API key → status + info; galat Open Cloud dipetakan ke status (kode di lastError, diterjemahkan web). */
async function probeKey(key: string): Promise<{ status: ConnectionStatus; info: KeyInfo | null; error: string | null }> {
  try {
    const info = await introspectKey(key);
    const status = statusOf(info);
    const caps = capabilitiesOf(info);
    const error = status === "expired" ? "KEY_EXPIRED" : status === "disabled" ? "KEY_DISABLED" : !caps.listKeys && !caps.read ? "KEY_NO_READ" : null;
    return { status, info, error };
  } catch (e) {
    if (e instanceof OpenCloudError && (e.kind === "auth" || e.kind === "validation" || e.kind === "permission")) {
      return { status: "invalid", info: null, error: "KEY_REJECTED" };
    }
    throw e;
  }
}

/** Tes koneksi OAuth: refresh token bila perlu + baca ulang universe yang diizinkan. */
async function probeOAuth(row: Conn): Promise<Partial<Conn>> {
  try {
    const auth = await authFor(row);
    const universes = "bearer" in auth ? await grantedUniverses(auth.bearer) : [];
    const scope = (row.keyInfo?.scopes ?? []).flatMap((s) => s.operations.map((o) => `${s.name}:${o}`)).join(" ");
    return { status: "active", lastError: null, keyInfo: keyInfoFromOAuth(scope, universes, row.keyInfo?.name ?? row.name) };
  } catch (e) {
    if (e instanceof OpenCloudError && e.kind === "auth") return { status: "expired", lastError: "OAUTH_REVOKED" };
    throw e;
  }
}

export const connectionRoutes = new Hono<Env>()
  .get("/", async (c) => {
    const rows = await db
      .select()
      .from(robloxConnections)
      .where(eq(robloxConnections.workspaceId, c.get("workspace").id))
      .orderBy(desc(robloxConnections.createdAt));
    return ok(c, rows.map(presentConnection));
  })
  .post("/", requirePermission("connections.manage"), rateLimit({ key: "conn-create", windowMs: 60_000, max: 10 }), async (c) => {
    const ws = c.get("workspace");
    const input = await body(c, createSchema);
    const fp = fingerprint(input.apiKey);
    await assertUniqueKey(ws.id, fp);
    await assertWithin(ws, "connections");
    // Dites langsung saat dibuat agar status awal akurat
    const result = await probeKey(input.apiKey);
    const [row] = await db
      .insert(robloxConnections)
      .values({
        workspaceId: ws.id,
        name: input.name,
        authType: "api_key",
        encryptedApiKey: encryptSecret(input.apiKey),
        keyFingerprint: fp,
        keyHint: input.apiKey.slice(-4),
        status: result.status,
        keyInfo: result.info,
        lastError: result.error,
        lastTestedAt: new Date(),
        createdBy: c.get("user").id,
      })
      .returning();
    return ok(c, presentConnection(row!), 201);
  })
  .get("/:id", async (c) => ok(c, presentConnection(await loadConnection(c.get("workspace").id, c.req.param("id")))))
  .post("/:id/test", requirePermission("connections.manage"), rateLimit({ key: "conn-test", windowMs: 60_000, max: 20 }), async (c) => {
    const row = await loadConnection(c.get("workspace").id, c.req.param("id"));
    let patch: Partial<Conn>;
    if (row.authType === "oauth") {
      patch = await probeOAuth(row);
    } else {
      const r = await probeKey(decryptSecret(row.encryptedApiKey!));
      patch = { status: r.status, keyInfo: r.info ?? row.keyInfo, lastError: r.error };
    }
    const [updated] = await db
      .update(robloxConnections)
      .set({ ...patch, lastTestedAt: new Date() })
      .where(eq(robloxConnections.id, row.id))
      .returning();
    return ok(c, presentConnection(updated!));
  })
  .patch("/:id", requirePermission("connections.manage"), async (c) => {
    const ws = c.get("workspace");
    const row = await loadConnection(ws.id, c.req.param("id"));
    const input = await body(c, updateSchema);
    const patch: Partial<typeof robloxConnections.$inferInsert> = {};
    if (input.name) patch.name = input.name;
    // Rotasi key (hanya koneksi API key): key baru dites dulu; sidik jari & hint diperbarui
    if (input.apiKey) {
      if (row.authType !== "api_key") throw new ApiError(409, "OAUTH_CONNECTION", "Reconnect with Roblox to refresh this connection");
      const fp = fingerprint(input.apiKey);
      await assertUniqueKey(ws.id, fp, row.id);
      const result = await probeKey(input.apiKey);
      Object.assign(patch, {
        encryptedApiKey: encryptSecret(input.apiKey),
        keyFingerprint: fp,
        keyHint: input.apiKey.slice(-4),
        status: result.status,
        keyInfo: result.info,
        lastError: result.error,
        lastTestedAt: new Date(),
      });
    }
    if (!Object.keys(patch).length) return ok(c, presentConnection(row));
    const [updated] = await db.update(robloxConnections).set(patch).where(eq(robloxConnections.id, row.id)).returning();
    return ok(c, presentConnection(updated!));
  })
  .delete("/:id", requirePermission("connections.manage"), async (c) => {
    const row = await loadConnection(c.get("workspace").id, c.req.param("id"));
    const [used] = await db.select({ n: count() }).from(datastoreConfigs).where(eq(datastoreConfigs.connectionId, row.id));
    if ((used?.n ?? 0) > 0) {
      throw new ApiError(409, "CONNECTION_IN_USE", `Used by ${used!.n} DataStore config(s), remove them first`, { count: used!.n });
    }
    // OAuth: cabut sesi otorisasi di Roblox juga
    if (row.authType === "oauth" && row.encryptedRefreshToken) await revokeToken(decryptSecret(row.encryptedRefreshToken));
    await db.delete(robloxConnections).where(eq(robloxConnections.id, row.id));
    return ok(c, { ok: true });
  })
  // Universe yang bisa diakses: dari scope introspect / consent OAuth; "*" = semua → Universe ID manual
  .get("/:id/universes", async (c) => {
    const row = await loadConnection(c.get("workspace").id, c.req.param("id"));
    if (!row.keyInfo) throw new ApiError(409, "NOT_TESTED", "Test this connection first");
    const auth = await authFor(row);
    const { ids, all } = universesOf(row.keyInfo);
    const universes = await Promise.all(
      ids.slice(0, 50).map(async (id) => {
        try {
          return { id, name: (await getUniverse(auth, id)).displayName || null };
        } catch {
          // Kredensial khusus DataStore biasanya tanpa izin baca universe → nama tidak tersedia
          return { id, name: null };
        }
      }),
    );
    return ok(c, { universes, allUniverses: all });
  })
  .get("/:id/universes/:universeId/datastores", rateLimit({ key: "ds-list", windowMs: 60_000, max: 60 }), async (c) => {
    const row = await loadConnection(c.get("workspace").id, c.req.param("id"));
    const universeId = numericId.parse(c.req.param("universeId"));
    const r = await listDataStores(await authFor(row), universeId, {
      pageToken: c.req.query("pageToken") || undefined,
      prefix: c.req.query("prefix") || undefined,
    });
    return ok(c, r.dataStores, 200, { nextPageToken: r.nextPageToken });
  });

/** Utilitas Roblox tanpa kredensial: Place ID → Universe ID, pratinjau user dari username. */
export const robloxRoutes = new Hono<Env>()
  .get("/places/:placeId/universe", rateLimit({ key: "place", windowMs: 60_000, max: 30 }), async (c) => {
    const placeId = numericId.parse(c.req.param("placeId"));
    return ok(c, { placeId, universeId: await universeOfPlace(placeId) });
  })
  .get("/users/lookup", rateLimit({ key: "rbx-lookup", windowMs: 60_000, max: 40 }), async (c) => {
    const username = z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/).parse(c.req.query("username") ?? "");
    const u = await findUserByUsername(username);
    if (!u) throw new ApiError(404, "ROBLOX_USER_NOT_FOUND", "No Roblox user with this username");
    return ok(c, u);
  });
