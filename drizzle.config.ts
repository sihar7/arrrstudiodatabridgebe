import { defineConfig } from "drizzle-kit";

// `npm run db:generate` → SQL migrasi di ./drizzle (dijalankan otomatis saat API start)
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
