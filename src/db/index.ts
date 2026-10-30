import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";
import { config } from "@/config";
import * as schema from "./schema";

// Driver: DATABASE_URL (Railway Postgres) → node-postgres; kosong (dev lokal/tes) → PGlite di ./.data/pglite
// atau "memory://" untuk tes. Keduanya dialek PostgreSQL yang sama, jadi query & migrasi identik.

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let closeFn: () => Promise<void> = async () => {};
let runMigrations: () => Promise<void>;

async function create(): Promise<Db> {
  const url = config.databaseUrl;
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    const d = drizzlePg(pool, { schema });
    runMigrations = () => migratePg(d, { migrationsFolder: MIGRATIONS });
    closeFn = async () => void (await pool?.end());
    return d;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = url === "memory://" ? undefined : url || path.join(process.cwd(), ".data", "pglite");
  // PGlite tidak membuat folder induk secara rekursif
  if (dir) mkdirSync(path.dirname(dir), { recursive: true });
  const client = new PGlite(dir);
  const d = drizzle(client, { schema });
  runMigrations = () => migrate(d, { migrationsFolder: MIGRATIONS });
  closeFn = () => client.close();
  // API query builder identik; tipe disamakan ke node-postgres
  return d as unknown as Db;
}

export const db: Db = await create();

export async function migrate() {
  await runMigrations();
}

export async function pingDb(): Promise<number> {
  const t = performance.now();
  await db.execute(sql`select 1`);
  return Math.round(performance.now() - t);
}

export async function closeDb() {
  await closeFn();
}
