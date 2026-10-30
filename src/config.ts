import dotenv from "dotenv";
import { z } from "zod";

// Tes harus hermetik: .env dev (mock URL, admin, OAuth) tidak dimuat saat NODE_ENV=test
if (process.env.NODE_ENV !== "test") dotenv.config({ quiet: true });

// Konfigurasi API — semua nilai dari env, divalidasi sekali saat start.
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  APP_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional().default(""),
  ENCRYPTION_KEY: z.string().optional().default(""),
  ENCRYPTION_KEYS_PREVIOUS: z.string().optional().default(""),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  // Roblox OAuth 2.0 app (Creator Dashboard → OAuth 2.0 Apps). Kosong = tombol Roblox disembunyikan.
  ROBLOX_OAUTH_CLIENT_ID: z.string().optional().default(""),
  ROBLOX_OAUTH_CLIENT_SECRET: z.string().optional().default(""),
  // Scope "Connect with Roblox" (harus juga dicentang di konfigurasi app). Bisa disesuaikan tanpa ubah kode.
  ROBLOX_OAUTH_CONNECT_SCOPES: z
    .string()
    .optional()
    .default(
      "openid profile universe-datastores.control:list universe-datastores.objects:list universe-datastores.objects:read universe-datastores.objects:create universe-datastores.objects:update",
    ),
  // Login user via Discord (Developer Portal → OAuth2). Redirect: <APP_URL>/api/v1/auth/discord/callback
  DISCORD_CLIENT_ID: z.string().optional().default(""),
  DISCORD_CLIENT_SECRET: z.string().optional().default(""),
  // Daftar/login email untuk user biasa (default mati: user pakai Discord; admin tetap email+password)
  EMAIL_SIGNUP_ENABLED: z.enum(["true", "false"]).optional().default("false"),
  // "Masuk dengan Roblox" untuk user (default mati)
  ROBLOX_LOGIN_ENABLED: z.enum(["true", "false"]).optional().default("false"),
  // "Hubungkan dengan Roblox" (OAuth untuk DataStore) hanya bila app OAuth diizinkan scope universe-datastores.*.
  // Default mati: banyak app hanya boleh openid/profile → akses DataStore lewat API key.
  ROBLOX_OAUTH_CONNECT_ENABLED: z.enum(["true", "false"]).optional().default("false"),
  // Antrean migrasi: Redis (Railway) → BullMQ; kosong → runner in-process (dev/tes)
  REDIS_URL: z.string().optional().default(""),
  // Jalankan worker migrasi di proses API (default ya; set false bila worker jadi service terpisah)
  RUN_WORKER: z.enum(["true", "false"]).optional().default("true"),
  // Batas request Open Cloud per universe per detik (kuota DataStore dibagi dengan server live)
  OC_RPS_PER_UNIVERSE: z.coerce.number().positive().default(4),
  // Key paralel per job migrasi
  MIGRATION_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  // Hanya dev/demo: arahkan Open Cloud & OAuth ke server tiruan (scripts/mock-roblox.ts). Produksi: kosong.
  OC_BASE_URL: z.string().url().optional(),
  // Admin platform (panel /admin) — HANYA email + password, tidak pernah lewat Roblox.
  // ADMIN_EMAIL + ADMIN_PASSWORD: akun admin dibuat/diperbarui otomatis saat API start (workspace Enterprise).
  ADMIN_EMAIL: z.string().trim().toLowerCase().email().optional(),
  ADMIN_PASSWORD: z.string().min(12, "ADMIN_PASSWORD minimal 12 karakter").optional(),
  // Admin tambahan (opsional, dipisah koma) — tetap harus login dengan email & password
  ADMIN_EMAILS: z.string().optional().default(""),
  // Gambar QRIS statis untuk pembayaran manual (URL publik, mis. /brand/qris.png di web)
  QRIS_IMAGE_URL: z.string().optional().default(""),
  QRIS_MERCHANT_NAME: z.string().optional().default("ARRR Studio"),
});

const env = schema.parse(process.env);
const isProd = env.NODE_ENV === "production";

/** Kunci AES-256 dari base64. Toleran salah tempel di dashboard: spasi, tanda kutip, awalan "ENCRYPTION_KEY=". */
function parseKey(raw: string, name = "ENCRYPTION_KEY"): Buffer {
  const b64 = raw
    .trim()
    .replace(/^[A-Z_]+=/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    // Nilai kunci tidak pernah ditulis ke log — hanya panjangnya
    throw new Error(`${name} harus 32 byte base64 (44 karakter, diakhiri "="); terbaca ${b64.length} karakter → ${key.length} byte`);
  }
  return key;
}

if (isProd && !env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY wajib di produksi");
if (isProd && !env.DATABASE_URL) throw new Error("DATABASE_URL wajib di produksi");

export const config = {
  isProd,
  port: env.PORT,
  appUrl: env.APP_URL ?? (isProd ? "https://databridge.arrrstudio.com" : "http://localhost:3000"),
  ocBase: (isProd ? undefined : env.OC_BASE_URL) ?? "https://apis.roblox.com",
  databaseUrl: env.DATABASE_URL,
  // Dev tanpa kunci → kunci tetap khusus dev (JANGAN dipakai produksi; dicegah di atas)
  encryptionKey: env.ENCRYPTION_KEY ? parseKey(env.ENCRYPTION_KEY) : Buffer.alloc(32, 7),
  previousKeys: env.ENCRYPTION_KEYS_PREVIOUS.split(",")
    .filter((k) => k.trim())
    .map((k) => parseKey(k, "ENCRYPTION_KEYS_PREVIOUS")),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : isProd,
  sessionCookie: "dbr_session",
  roblox: {
    clientId: env.ROBLOX_OAUTH_CLIENT_ID,
    clientSecret: env.ROBLOX_OAUTH_CLIENT_SECRET,
    connectScopes: env.ROBLOX_OAUTH_CONNECT_SCOPES,
    enabled: !!(env.ROBLOX_OAUTH_CLIENT_ID && env.ROBLOX_OAUTH_CLIENT_SECRET),
    loginEnabled: !!(env.ROBLOX_OAUTH_CLIENT_ID && env.ROBLOX_OAUTH_CLIENT_SECRET) && env.ROBLOX_LOGIN_ENABLED === "true",
    connectEnabled: !!(env.ROBLOX_OAUTH_CLIENT_ID && env.ROBLOX_OAUTH_CLIENT_SECRET) && env.ROBLOX_OAUTH_CONNECT_ENABLED === "true",
  },
  discord: { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET, enabled: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) },
  emailSignup: env.EMAIL_SIGNUP_ENABLED === "true",
  redisUrl: env.REDIS_URL,
  runWorker: env.RUN_WORKER === "true",
  ocRps: env.OC_RPS_PER_UNIVERSE,
  migrationConcurrency: env.MIGRATION_CONCURRENCY,
  adminEmails: [...new Set([env.ADMIN_EMAIL ?? "", ...env.ADMIN_EMAILS.split(",")].map((x) => x.trim().toLowerCase()).filter(Boolean))],
  bootstrapAdmin: env.ADMIN_EMAIL && env.ADMIN_PASSWORD ? { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } : null,
  qris: { imageUrl: env.QRIS_IMAGE_URL, merchant: env.QRIS_MERCHANT_NAME },
  sessionTtlDays: 30,
};
