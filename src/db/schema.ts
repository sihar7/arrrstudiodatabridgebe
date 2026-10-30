import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Skema PostgreSQL ARRR DataBridge — UUID, created_at/updated_at, tenant scoping lewat workspace_id.
// Fase 1: auth, workspace, koneksi Open Cloud, project, konfigurasi DataStore.

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const ROLES = ["owner", "admin", "developer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const CONNECTION_STATUS = ["untested", "active", "invalid", "expired", "disabled"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUS)[number];

export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  // Akun "Masuk dengan Roblox" tidak punya email/password
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  locale: text("locale").notNull().default("en"),
  // Akun Roblox tertaut (OAuth openid): dipakai untuk login & undangan berdasarkan username
  robloxUserId: text("roblox_user_id").unique(),
  robloxUsername: text("roblox_username"),
  robloxDisplayName: text("roblox_display_name"),
  robloxAvatarUrl: text("roblox_avatar_url"),
  // Login utama user: Discord (identify). Email Discord TIDAK disimpan (akun Discord tidak pernah bisa jadi admin)
  discordUserId: text("discord_user_id").unique(),
  discordUsername: text("discord_username"),
  discordAvatarUrl: text("discord_avatar_url"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Hanya hash SHA-256 token yang disimpan; token mentah hanya ada di cookie
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type", { enum: ["individual", "studio"] }).notNull().default("individual"),
  plan: text("plan", { enum: ["free", "developer", "studio", "enterprise"] }).notNull().default("free"),
  // Paket berbayar aktif sampai tanggal ini; lewat → efektif "free" (null = tanpa batas waktu, mis. enterprise)
  planExpiresAt: timestamp("plan_expires_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workspace_members_unique").on(t.workspaceId, t.userId), index("workspace_members_user_idx").on(t.userId)],
);

export const robloxConnections = pgTable(
  "roblox_connections",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // api_key = API key Open Cloud ditempel user; oauth = "Connect with Roblox" (token akses + refresh)
    authType: text("auth_type", { enum: ["api_key", "oauth"] }).notNull().default("api_key"),
    // AES-256-GCM "v1:<iv>:<tag>:<ciphertext>" — tidak pernah dikirim balik ke klien
    encryptedApiKey: text("encrypted_api_key"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    encryptedAccessToken: text("encrypted_access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    // Pemberi izin OAuth (Roblox user id)
    robloxUserId: text("roblox_user_id"),
    // Sidik jari non-rahasia (SHA-256 terpotong) + 4 karakter terakhir untuk ditampilkan ter-mask
    keyFingerprint: text("key_fingerprint").notNull(),
    keyHint: text("key_hint").notNull(),
    status: text("status", { enum: CONNECTION_STATUS }).notNull().default("untested"),
    // Hasil introspect terakhir (nama key, scope & resource) — tanpa rahasia
    keyInfo: jsonb("key_info").$type<KeyInfo | null>(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("roblox_connections_ws_idx").on(t.workspaceId),
    uniqueIndex("roblox_connections_fp_unique").on(t.workspaceId, t.keyFingerprint),
  ],
);

export type KeyInfo = {
  name: string;
  authorizedUserId: string | null;
  enabled: boolean;
  expired: boolean;
  expiresAt: string | null;
  scopes: { name: string; operations: string[]; universeIds: string[]; datastores: { universeId: string; datastoreName: string }[] }[];
};

export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sourceType: text("source_type", { enum: ["open_cloud"] }).notNull().default("open_cloud"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_ws_idx").on(t.workspaceId)],
);

export const datastoreConfigs = pgTable(
  "datastore_configs",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => robloxConnections.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    // Universe ID & Place ID disimpan sebagai teks (angka Roblox bisa melebihi int53 di masa depan)
    universeId: text("universe_id").notNull(),
    universeName: text("universe_name"),
    placeId: text("place_id"),
    datastoreName: text("datastore_name").notNull(),
    scope: text("scope").notNull().default("global"),
    // Standard atau Ordered (leaderboard) — kolom teks, enum hanya di TS jadi tanpa migrasi SQL
    datastoreType: text("datastore_type", { enum: ["standard", "ordered"] }).notNull().default("standard"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("datastore_configs_ws_idx").on(t.workspaceId),
    index("datastore_configs_project_idx").on(t.projectId),
    uniqueIndex("datastore_configs_unique").on(t.projectId, t.connectionId, t.universeId, t.datastoreName, t.scope),
  ],
);

/** Undangan berdasarkan username Roblox — aktif otomatis saat orang itu masuk/menautkan akun Roblox. */
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    robloxUserId: text("roblox_user_id").notNull(),
    robloxUsername: text("roblox_username").notNull(),
    robloxDisplayName: text("roblox_display_name"),
    robloxAvatarUrl: text("roblox_avatar_url"),
    role: text("role", { enum: ROLES }).notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workspace_invites_unique").on(t.workspaceId, t.robloxUserId), index("workspace_invites_roblox_idx").on(t.robloxUserId)],
);

/** Link undangan workspace: token acak (hanya hash disimpan), role, masa berlaku, batas pakai, bisa dicabut. */
export const workspaceInviteLinks = pgTable(
  "workspace_invite_links",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role", { enum: ROLES }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("workspace_invite_links_ws_idx").on(t.workspaceId)],
);

export const MIGRATION_STATUS = [
  "draft",
  "queued",
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "completed_with_errors",
  "failed",
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUS)[number];
export const CONFLICT_STRATEGIES = ["skip_existing", "overwrite", "fail_on_conflict", "rename_key"] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];
export const ITEM_STATUS = ["pending", "reading", "writing", "verifying", "success", "skipped", "conflict", "failed"] as const;
export type ItemStatus = (typeof ITEM_STATUS)[number];

export const migrations = pgTable(
  "migrations",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceConfigId: uuid("source_config_id")
      .notNull()
      .references(() => datastoreConfigs.id, { onDelete: "restrict" }),
    destinationConfigId: uuid("destination_config_id")
      .notNull()
      .references(() => datastoreConfigs.id, { onDelete: "restrict" }),
    status: text("status", { enum: MIGRATION_STATUS }).notNull().default("draft"),
    mode: text("mode", { enum: ["full", "selected", "prefix"] }).notNull().default("full"),
    selectedKeys: jsonb("selected_keys").$type<string[] | null>(),
    prefix: text("prefix"),
    conflictStrategy: text("conflict_strategy", { enum: CONFLICT_STRATEGIES }).notNull().default("skip_existing"),
    // rename_key: pola nama key tujuan, {key} = key sumber
    renamePattern: text("rename_pattern"),
    verify: boolean("verify").notNull().default(true),
    // Run yang sedang/terakhir berjalan: dry run (tanpa tulis) atau run sungguhan
    dryRun: boolean("dry_run").notNull().default(true),
    // Checkpoint enumerasi key (pageToken Open Cloud) — job bisa dilanjutkan setelah worker mati
    enumCursor: text("enum_cursor"),
    enumDone: boolean("enum_done").notNull().default(false),
    totalKeys: integer("total_keys").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    conflictCount: integer("conflict_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    bytesRead: bigint("bytes_read", { mode: "number" }).notNull().default(0),
    currentOperation: text("current_operation"),
    // Token run aktif: klaim baru mengganti token → loop lama berhenti sendiri (cegah dua loop paralel)
    runToken: text("run_token"),
    lastError: text("last_error"),
    lastDryRunAt: timestamp("last_dry_run_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("migrations_ws_idx").on(t.workspaceId, t.createdAt), index("migrations_status_idx").on(t.status)],
);

export const migrationItems = pgTable(
  "migration_items",
  {
    id: id(),
    migrationId: uuid("migration_id")
      .notNull()
      .references(() => migrations.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    destinationKey: text("destination_key").notNull(),
    status: text("status", { enum: ITEM_STATUS }).notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    // MD5 base64 dari nilai yang ditulis (sama format dengan content-md5 Roblox)
    checksum: text("checksum"),
    size: integer("size"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("migration_items_unique").on(t.migrationId, t.sourceKey), index("migration_items_status_idx").on(t.migrationId, t.status)],
);

export const migrationLogs = pgTable(
  "migration_logs",
  {
    id: id(),
    migrationId: uuid("migration_id")
      .notNull()
      .references(() => migrations.id, { onDelete: "cascade" }),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("migration_logs_idx").on(t.migrationId, t.createdAt)],
);

export const ORDER_STATUS = ["pending", "awaiting_review", "paid", "rejected", "cancelled"] as const;

/** Order paket via QRIS manual: user bayar + unggah bukti → admin menyetujui → paket workspace aktif. */
export const billingOrders = pgTable(
  "billing_orders",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    plan: text("plan", { enum: ["developer", "studio"] }).notNull(),
    months: integer("months").notNull(),
    // Nominal = harga × bulan + kode unik 3 digit (memudahkan mencocokkan mutasi QRIS)
    amountIdr: integer("amount_idr").notNull(),
    uniqueCode: integer("unique_code").notNull(),
    status: text("status", { enum: ORDER_STATUS }).notNull().default("pending"),
    proofData: text("proof_data"), // base64, maks 2 MB
    proofMime: text("proof_mime"),
    note: text("note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("billing_orders_ws_idx").on(t.workspaceId, t.createdAt), index("billing_orders_status_idx").on(t.status)],
);

// Disiapkan untuk fase berikut (Audit di luar MVP) — belum ditulis oleh fitur mana pun
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_ws_idx").on(t.workspaceId, t.createdAt)],
);
