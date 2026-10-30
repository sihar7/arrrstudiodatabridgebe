import { serve } from "@hono/node-server";
import { app } from "@/app";
import { config } from "@/config";
import { closeDb, migrate } from "@/db";
import { ensureAdmin } from "@/lib/admin";
import { closeQueue, startQueue } from "@/migrations/queue";

// ARRR DataBridge API — entry point (Railway: `npm start`, healthcheck /health).

await migrate();
await ensureAdmin();
await startQueue();
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port} (web: ${config.appUrl})`);
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[api] ${signal} → shutting down`);
  server.close();
  await closeQueue();
  await closeDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
