import { createHash } from "node:crypto";
import { config } from "@/config";
import type { KeyInfo } from "@/db/schema";

// Klien Roblox Open Cloud (v2 untuk DataStore). Kredensial (API key / token OAuth) tidak pernah di-log.
// Galat diklasifikasikan (auth/permission/not_found/rate_limited/validation/upstream) agar UI & worker
// bisa membedakan; 429/5xx/jaringan di-retry dengan exponential backoff (mulai 1 dtk, hormati Retry-After).
// Request ber-`universe` melewati limiter per universe (kuota DataStore dibagi dengan server live).

const BASE = config.ocBase;
const TIMEOUT_MS = 15_000;

export type OcAuth = { apiKey: string } | { bearer: string };
export type OpenCloudErrorKind = "auth" | "permission" | "not_found" | "rate_limited" | "validation" | "conflict" | "upstream";

export class OpenCloudError extends Error {
  constructor(
    public kind: OpenCloudErrorKind,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function kindOf(status: number): OpenCloudErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "validation";
  return "upstream";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── Limiter per universe & jenis (baca/tulis/list): interval minimum antar request (in-process) ── */
const nextSlot = new Map<string, number>();
async function throttle(universe: string) {
  const gap = 1000 / config.ocRps;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(universe) ?? 0);
  nextSlot.set(universe, slot + gap);
  if (slot > now) await sleep(slot - now);
}

type ReqInit = { auth?: OcAuth; method?: string; body?: unknown; universe?: string; attempts?: number };

async function request<T>(path: string, init: ReqInit = {}): Promise<T> {
  const attempts = init.attempts ?? 3;
  let lastErr: OpenCloudError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Kuota DataStore Roblox per experience terpisah untuk baca / tulis / list → antrean limiter terpisah
    if (init.universe) {
      const kind = (init.method ?? "GET") !== "GET" ? "write" : /\/entries\/[^?]/.test(path) ? "read" : "list";
      // Ordered punya kuota sendiri → tidak mengantre di belakang migrasi Standard yang sedang jalan
      const family = path.includes("/ordered-data-stores/") ? "ordered" : "std";
      await throttle(`${init.universe}:${family}:${kind}`);
    }
    let res: Response;
    try {
      const headers: Record<string, string> = {};
      if (init.auth && "apiKey" in init.auth) headers["x-api-key"] = init.auth.apiKey;
      if (init.auth && "bearer" in init.auth) headers.authorization = `Bearer ${init.auth.bearer}`;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      res = await fetch(BASE + path, {
        method: init.method ?? "GET",
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      lastErr = new OpenCloudError("upstream", 0, "Roblox Open Cloud is unreachable");
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const kind = kindOf(res.status);
    const message = await readError(res);
    lastErr = new OpenCloudError(kind, res.status, message);
    if (kind !== "rate_limited" && kind !== "upstream") throw lastErr;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt);
  }
  throw lastErr ?? new OpenCloudError("upstream", 0, "Open Cloud request failed");
}

/** Pesan galat Roblox dipersingkat; tidak pernah menyertakan header/body request (berisi kredensial). */
async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: string; error?: string; errors?: { message?: string }[] };
    const msg = j.message || j.errors?.[0]?.message || j.error;
    if (msg) return String(msg).slice(0, 300);
  } catch {
    // body bukan JSON
  }
  return `Open Cloud responded ${res.status}`;
}

/* ── API key introspect ── */

type RawIntrospect = {
  name?: string;
  authorizedUserId?: number | string;
  enabled?: boolean;
  expired?: boolean;
  expirationTimeUtc?: string | null;
  scopes?: { name: string; operations?: string[]; universeIds?: string[]; universeDatastores?: { universeId: string; datastoreName: string }[] }[];
};

/** Info API key (nama, scope, resource, status) — POST /api-keys/v1/introspect. */
export async function introspectKey(apiKey: string): Promise<KeyInfo> {
  const raw = await request<RawIntrospect>("/api-keys/v1/introspect", { method: "POST", body: { apiKey } });
  return {
    name: raw.name ?? "",
    authorizedUserId: raw.authorizedUserId != null ? String(raw.authorizedUserId) : null,
    enabled: raw.enabled ?? true,
    expired: raw.expired ?? false,
    expiresAt: raw.expirationTimeUtc ?? null,
    scopes: (raw.scopes ?? []).map((s) => ({
      name: s.name,
      operations: s.operations ?? [],
      universeIds: [...new Set([...(s.universeIds ?? []), ...(s.universeDatastores ?? []).map((d) => String(d.universeId))])],
      datastores: (s.universeDatastores ?? []).map((d) => ({ universeId: String(d.universeId), datastoreName: d.datastoreName })),
    })),
  };
}

/** Scope DataStore yang dibutuhkan fitur MVP (baca/list untuk sumber, tulis untuk tujuan). */
export const DATASTORE_SCOPES = {
  listStores: ["universe-datastores.control", "list"],
  listKeys: ["universe-datastores.objects", "list"],
  read: ["universe-datastores.objects", "read"],
  create: ["universe-datastores.objects", "create"],
  update: ["universe-datastores.objects", "update"],
} as const;

export type Capabilities = Record<keyof typeof DATASTORE_SCOPES, boolean>;

export function capabilitiesOf(info: KeyInfo, ordered = false): Capabilities {
  if (ordered) {
    // Scope Ordered (universe.ordered-data-store.scope.entry: read/write). Bila key tak mencantumkan scope
    // ordered sama sekali (format introspect berbeda), biarkan Roblox yang menolak saat request.
    const os = info.scopes.filter((s) => s.name.includes("ordered"));
    if (!os.length) return { listStores: true, listKeys: true, read: true, create: true, update: true };
    const op = (...ops: string[]) => os.some((s) => s.operations.some((o) => o === "*" || ops.includes(o)));
    const read = op("read", "list"), write = op("write", "create", "update");
    return { listStores: false, listKeys: read, read, create: write, update: write };
  }
  const has = ([scope, op]: readonly [string, string]) =>
    info.scopes.some((s) => s.name === scope && (s.operations.includes(op) || s.operations.includes("*")));
  return Object.fromEntries(Object.entries(DATASTORE_SCOPES).map(([k, v]) => [k, has(v)])) as Capabilities;
}

/** Universe yang disebut eksplisit di scope DataStore; "*" = semua universe milik pemilik key. */
export function universesOf(info: KeyInfo): { ids: string[]; all: boolean } {
  const ids = new Set<string>();
  let all = false;
  for (const s of info.scopes) {
    if (!s.name.startsWith("universe-datastores") && !s.name.includes("ordered")) continue;
    for (const u of s.universeIds) (u === "*" ? (all = true) : ids.add(u));
  }
  return { ids: [...ids], all };
}

/* ── Universe & DataStore ── */

export async function getUniverse(auth: OcAuth, universeId: string): Promise<{ id: string; displayName: string }> {
  const u = await request<{ displayName?: string }>(`/cloud/v2/universes/${encodeURIComponent(universeId)}`, { auth });
  return { id: universeId, displayName: u.displayName ?? "" };
}

const quote = (s: string) => s.replace(/["\\]/g, "");

export async function listDataStores(
  auth: OcAuth,
  universeId: string,
  opts: { pageToken?: string; prefix?: string; pageSize?: number } = {},
): Promise<{ dataStores: { id: string; createTime: string | null }[]; nextPageToken: string | null }> {
  const q = new URLSearchParams({ maxPageSize: String(opts.pageSize ?? 50) });
  if (opts.pageToken) q.set("pageToken", opts.pageToken);
  if (opts.prefix) q.set("filter", `id.startsWith("${quote(opts.prefix)}")`);
  const r = await request<{ dataStores?: { id: string; createTime?: string }[]; nextPageToken?: string }>(
    `/cloud/v2/universes/${encodeURIComponent(universeId)}/data-stores?${q}`,
    { auth, universe: universeId },
  );
  return {
    dataStores: (r.dataStores ?? []).map((d) => ({ id: d.id, createTime: d.createTime ?? null })),
    nextPageToken: r.nextPageToken || null,
  };
}

/** `type` kosong = Standard. Ordered memakai endpoint `ordered-data-stores` (nilai integer, tanpa users/attributes). */
export type StoreRef = { universeId: string; datastore: string; scope: string; type?: "standard" | "ordered" };
const isOrdered = (ref: StoreRef) => ref.type === "ordered";
export type Entry = {
  key: string;
  value: unknown;
  users: string[];
  attributes: Record<string, unknown> | null;
  revisionId: string | null;
  createTime: string | null;
  revisionCreateTime: string | null;
  etag: string | null;
};

function entriesPath(ref: StoreRef) {
  const kind = isOrdered(ref) ? "ordered-data-stores" : "data-stores";
  return `/cloud/v2/universes/${encodeURIComponent(ref.universeId)}/${kind}/${encodeURIComponent(ref.datastore)}/scopes/${encodeURIComponent(ref.scope)}/entries`;
}

/** Id entry dari field `id` atau segmen terakhir `path`. */
function entryId(e: { id?: string; path?: string }): string {
  if (e.id) return e.id;
  const last = e.path?.split("/entries/")[1] ?? "";
  return decodeURIComponent(last);
}

export async function listEntryKeys(
  auth: OcAuth,
  ref: StoreRef,
  opts: { pageToken?: string; prefix?: string; pageSize?: number } = {},
): Promise<{ keys: string[]; nextPageToken: string | null }> {
  if (isOrdered(ref)) {
    // Ordered: maks 100/halaman, urut nilai menurun; filter Roblox hanya rentang nilai → prefix disaring di sini
    const q = new URLSearchParams({ maxPageSize: String(Math.min(opts.pageSize ?? 100, 100)), orderBy: "value desc" });
    if (opts.pageToken) q.set("pageToken", opts.pageToken);
    const r = await request<{ orderedDataStoreEntries?: { id?: string; path?: string }[]; nextPageToken?: string }>(`${entriesPath(ref)}?${q}`, {
      auth,
      universe: ref.universeId,
      attempts: 6,
    });
    const keys = (r.orderedDataStoreEntries ?? []).map(entryId).filter(Boolean);
    return { keys: opts.prefix ? keys.filter((k) => k.startsWith(opts.prefix!)) : keys, nextPageToken: r.nextPageToken || null };
  }
  const q = new URLSearchParams({ maxPageSize: String(opts.pageSize ?? 256) });
  if (opts.pageToken) q.set("pageToken", opts.pageToken);
  if (opts.prefix) q.set("filter", `id.startsWith("${quote(opts.prefix)}")`);
  const r = await request<{ dataStoreEntries?: { id?: string; path?: string }[]; nextPageToken?: string }>(`${entriesPath(ref)}?${q}`, {
    auth,
    universe: ref.universeId,
    attempts: 6,
  });
  return { keys: (r.dataStoreEntries ?? []).map(entryId).filter(Boolean), nextPageToken: r.nextPageToken || null };
}

type RawEntry = {
  id?: string;
  path?: string;
  value?: unknown;
  users?: string[];
  attributes?: Record<string, unknown> | null;
  revisionId?: string;
  createTime?: string;
  revisionCreateTime?: string;
  etag?: string;
  state?: string;
};

function toEntry(key: string, r: RawEntry): Entry {
  return {
    key,
    value: r.value ?? null,
    users: r.users ?? [],
    attributes: r.attributes ?? null,
    revisionId: r.revisionId ?? null,
    createTime: r.createTime ?? null,
    revisionCreateTime: r.revisionCreateTime ?? null,
    etag: r.etag ?? null,
  };
}

/** Ambil entry; null bila tidak ada / sudah dihapus. */
export async function getEntry(auth: OcAuth, ref: StoreRef, key: string): Promise<Entry | null> {
  try {
    const r = await request<RawEntry>(`${entriesPath(ref)}/${encodeURIComponent(key)}`, { auth, universe: ref.universeId, attempts: 6 });
    if (r?.state === "DELETED") return null;
    return toEntry(key, r);
  } catch (e) {
    if (e instanceof OpenCloudError && e.kind === "not_found") return null;
    throw e;
  }
}

type WriteBody = { value: unknown; users: string[]; attributes: Record<string, unknown> | null };

/** Body tulis: Ordered hanya menerima nilai integer. */
function writePayload(ref: StoreRef, body: WriteBody) {
  if (isOrdered(ref)) {
    const n = Number(body.value);
    if (!Number.isInteger(n)) throw new OpenCloudError("validation", 400, "Ordered DataStore value must be an integer");
    return { value: n };
  }
  return { value: body.value, users: body.users, ...(body.attributes ? { attributes: body.attributes } : {}) };
}

/** Buat entry baru; gagal (conflict) bila key sudah ada — konflik dicek atomik di sisi Roblox. */
export async function createEntry(auth: OcAuth, ref: StoreRef, key: string, body: WriteBody): Promise<Entry> {
  try {
    const r = await request<RawEntry>(`${entriesPath(ref)}?id=${encodeURIComponent(key)}`, {
      auth,
      universe: ref.universeId,
      method: "POST",
      body: writePayload(ref, body),
      attempts: 6,
    });
    return toEntry(key, r);
  } catch (e) {
    if (e instanceof OpenCloudError && (e.kind === "conflict" || (e.kind === "validation" && /exist/i.test(e.message)))) {
      throw new OpenCloudError("conflict", e.status, "Entry already exists");
    }
    throw e;
  }
}

/** Timpa entry (atau buat bila belum ada). users/attributes selalu dikirim agar tidak terhapus. */
export async function upsertEntry(auth: OcAuth, ref: StoreRef, key: string, body: WriteBody): Promise<Entry> {
  const r = await request<RawEntry>(`${entriesPath(ref)}/${encodeURIComponent(key)}?allowMissing=true`, {
    auth,
    universe: ref.universeId,
    method: "PATCH",
    body: writePayload(ref, body),
    attempts: 6,
  });
  return toEntry(key, r);
}

/** JSON kanonik (key objek diurutkan) → perbandingan verifikasi tidak terpengaruh urutan field. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function md5(v: unknown): string {
  return createHash("md5").update(canonical(v)).digest("base64");
}

/** Place ID → Universe ID (endpoint publik). Place ID ≠ Universe ID — UI menampilkan keduanya. */
export async function universeOfPlace(placeId: string): Promise<string> {
  const r = await request<{ universeId?: number | null }>(`/universes/v1/places/${encodeURIComponent(placeId)}/universe`);
  if (!r.universeId) throw new OpenCloudError("not_found", 404, "Place not found");
  return String(r.universeId);
}
