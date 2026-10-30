import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ZodError, z } from "zod";
import { pingDb } from "@/db";
import { ApiError } from "@/lib/http";
import { csrf, requireAdmin, requireAuth, requireWorkspace, type Env } from "@/middleware/auth";
import { OpenCloudError } from "@/roblox/openCloud";
import { adminRoutes } from "@/routes/admin";
import { analyticsRoutes } from "@/routes/analytics";
import { billingRoutes } from "@/routes/billing";
import { explorerRoutes } from "@/routes/explorer";
import { migrationRoutes } from "@/routes/migrations";
import { authRoutes } from "@/routes/auth";
import { robloxAuthRoutes } from "@/routes/robloxAuth";
import { connectionRoutes, robloxRoutes } from "@/routes/connections";
import { projectRoutes } from "@/routes/projects";
import { workspaceRoutes } from "@/routes/workspaces";

// Aplikasi Hono (dipisah dari server.ts agar bisa dites tanpa membuka port).
// Web (Next.js) mem-proxy /api/v1/* ke sini, jadi cookie sesi tetap milik domain web.

const ROBLOX_STATUS = { auth: 422, permission: 422, not_found: 404, rate_limited: 429, validation: 422, conflict: 409, upstream: 502 } as const;

export const app = new Hono<Env>();

app.use(secureHeaders());

app.get("/health", async (c) => {
  try {
    return c.json({ ok: true, dbMs: await pingDb() });
  } catch {
    return c.json({ ok: false, error: "database unreachable" }, 503);
  }
});

const v1 = new Hono<Env>();
v1.use(csrf);
v1.route("/auth/roblox", robloxAuthRoutes);
v1.route("/auth", authRoutes);
v1.use("/workspaces/*", requireAuth);
v1.use("/workspaces", requireAuth);
v1.route("/workspaces", workspaceRoutes);
// Rute fitur: wajib login + header X-Workspace-Id (anggota)
for (const p of ["/connections", "/projects", "/analytics", "/migrations", "/explorer", "/billing"]) {
  v1.use(p, requireAuth, requireWorkspace);
  v1.use(`${p}/*`, requireAuth, requireWorkspace);
}
v1.route("/connections", connectionRoutes);
v1.route("/projects", projectRoutes);
v1.route("/analytics", analyticsRoutes);
v1.route("/migrations", migrationRoutes);
v1.route("/explorer", explorerRoutes);
v1.route("/billing", billingRoutes);
v1.use("/admin/*", requireAuth, requireAdmin);
v1.route("/admin", adminRoutes);
v1.use("/roblox/*", requireAuth);
v1.route("/roblox", robloxRoutes);

app.route("/api/v1", v1);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Endpoint not found" } }, 404));
app.onError((e, c) => {
  if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status);
  if (e instanceof ZodError) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Some fields are invalid", details: z.flattenError(e).fieldErrors } }, 422);
  }
  if (e instanceof OpenCloudError) {
    return c.json({ error: { code: `ROBLOX_${e.kind.toUpperCase()}`, message: e.message } }, ROBLOX_STATUS[e.kind]);
  }
  // Galat tak terduga: log hanya nama & pesan (tanpa body request yang bisa berisi API key)
  console.error("[api]", e instanceof Error ? `${e.name}: ${e.message}` : e);
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong on our side" } }, 500);
});
