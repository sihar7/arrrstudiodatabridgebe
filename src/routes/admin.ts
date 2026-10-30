import { count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "@/config";
import { db, pingDb } from "@/db";
import { billingOrders, migrations, robloxConnections, users, workspaceMembers, workspaces } from "@/db/schema";
import { body, notFound, ok } from "@/lib/http";
import { effectivePlan } from "@/lib/plans";
import type { Env } from "@/middleware/auth";
import { approveOrder, presentOrder } from "./billing";

// Panel admin platform: ringkasan, order QRIS (setujui/tolak), user, workspace (ubah paket), migrasi, sistem.
// Akses: requireAdmin (ADMIN_EMAILS / ADMIN_ROBLOX_USERNAMES) — dipasang di app.ts.

const page = (c: { req: { query: (k: string) => string | undefined } }) => ({
  limit: Math.min(Number(c.req.query("limit")) || 50, 200),
  offset: Math.max(Number(c.req.query("offset")) || 0, 0),
  q: (c.req.query("q") ?? "").trim(),
});

export const adminRoutes = new Hono<Env>()
  .get("/stats", async (c) => {
    const [[u], [w], plans, migs, [pending]] = await Promise.all([
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(workspaces),
      db.select({ plan: workspaces.plan, n: count() }).from(workspaces).groupBy(workspaces.plan),
      db.select({ status: migrations.status, n: count() }).from(migrations).groupBy(migrations.status),
      db.select({ n: count() }).from(billingOrders).where(eq(billingOrders.status, "awaiting_review")),
    ]);
    const [revenue] = await db.select({ sum: sql<number>`coalesce(sum(${billingOrders.amountIdr}),0)::int` }).from(billingOrders).where(eq(billingOrders.status, "paid"));
    return ok(c, {
      users: u?.n ?? 0,
      workspaces: w?.n ?? 0,
      plans: Object.fromEntries(plans.map((p) => [p.plan, p.n])),
      migrations: Object.fromEntries(migs.map((m) => [m.status, m.n])),
      pendingOrders: pending?.n ?? 0,
      revenueIdr: revenue?.sum ?? 0,
    });
  })
  .get("/orders", async (c) => {
    const { limit, offset } = page(c);
    const status = c.req.query("status");
    const rows = await db
      .select({ order: billingOrders, workspaceName: workspaces.name, userName: users.name, userEmail: users.email })
      .from(billingOrders)
      .innerJoin(workspaces, eq(workspaces.id, billingOrders.workspaceId))
      .leftJoin(users, eq(users.id, billingOrders.createdBy))
      .where(status ? eq(billingOrders.status, status as typeof billingOrders.$inferSelect.status) : undefined)
      .orderBy(desc(billingOrders.createdAt))
      .limit(limit)
      .offset(offset);
    return ok(c, rows.map((r) => ({ ...presentOrder(r.order), workspaceName: r.workspaceName, userName: r.userName, userEmail: r.userEmail })));
  })
  .get("/orders/:id/proof", async (c) => {
    const [o] = await db.select().from(billingOrders).where(eq(billingOrders.id, z.string().uuid().parse(c.req.param("id")))).limit(1);
    if (!o?.proofData) throw notFound("Proof");
    return new Response(Buffer.from(o.proofData, "base64"), {
      headers: { "content-type": o.proofMime ?? "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  })
  .post("/orders/:id/approve", async (c) => {
    const o = await approveOrder(z.string().uuid().parse(c.req.param("id")), c.get("user").id);
    return ok(c, presentOrder(o));
  })
  .post("/orders/:id/reject", async (c) => {
    const { note } = await body(c, z.object({ note: z.string().trim().min(1).max(300) }));
    const [o] = await db
      .update(billingOrders)
      .set({ status: "rejected", note, reviewedBy: c.get("user").id, reviewedAt: new Date() })
      .where(eq(billingOrders.id, z.string().uuid().parse(c.req.param("id"))))
      .returning();
    if (!o) throw notFound("Order");
    return ok(c, presentOrder(o));
  })
  .get("/users", async (c) => {
    const { limit, offset, q } = page(c);
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        robloxUsername: users.robloxUsername,
        robloxAvatarUrl: users.robloxAvatarUrl,
        createdAt: users.createdAt,
        workspaces: sql<number>`(select count(*)::int from ${workspaceMembers} where ${workspaceMembers.userId} = ${users.id})`,
      })
      .from(users)
      .where(q ? or(ilike(users.name, `%${q}%`), ilike(users.email, `%${q}%`), ilike(users.robloxUsername, `%${q}%`)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);
    return ok(c, rows);
  })
  .get("/workspaces", async (c) => {
    const { limit, offset, q } = page(c);
    const rows = await db
      .select({
        ws: workspaces,
        members: sql<number>`(select count(*)::int from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id})`,
        connections: sql<number>`(select count(*)::int from ${robloxConnections} where ${robloxConnections.workspaceId} = ${workspaces.id})`,
        migrationsCount: sql<number>`(select count(*)::int from ${migrations} where ${migrations.workspaceId} = ${workspaces.id})`,
      })
      .from(workspaces)
      .where(q ? or(ilike(workspaces.name, `%${q}%`), ilike(workspaces.slug, `%${q}%`)) : undefined)
      .orderBy(desc(workspaces.createdAt))
      .limit(limit)
      .offset(offset);
    return ok(c, rows.map((r) => ({ ...r.ws, effectivePlan: effectivePlan(r.ws.plan, r.ws.planExpiresAt), members: r.members, connections: r.connections, migrations: r.migrationsCount })));
  })
  .patch("/workspaces/:id", async (c) => {
    const input = await body(
      c,
      z.object({ plan: z.enum(["free", "developer", "studio", "enterprise"]), planExpiresAt: z.coerce.date().nullish() }),
    );
    const [w] = await db
      .update(workspaces)
      .set({ plan: input.plan, planExpiresAt: input.plan === "free" ? null : (input.planExpiresAt ?? null) })
      .where(eq(workspaces.id, z.string().uuid().parse(c.req.param("id"))))
      .returning();
    if (!w) throw notFound("Workspace");
    return ok(c, w);
  })
  .get("/migrations", async (c) => {
    const { limit, offset } = page(c);
    const rows = await db
      .select({
        id: migrations.id,
        name: migrations.name,
        status: migrations.status,
        dryRun: migrations.dryRun,
        totalKeys: migrations.totalKeys,
        processed: migrations.processed,
        failedCount: migrations.failedCount,
        lastError: migrations.lastError,
        createdAt: migrations.createdAt,
        workspaceName: workspaces.name,
      })
      .from(migrations)
      .innerJoin(workspaces, eq(workspaces.id, migrations.workspaceId))
      .orderBy(desc(migrations.createdAt))
      .limit(limit)
      .offset(offset);
    return ok(c, rows);
  })
  .get("/system", async (c) => {
    let dbMs: number | null = null;
    try {
      dbMs = await pingDb();
    } catch {
      dbMs = null;
    }
    return ok(c, {
      dbMs,
      database: config.databaseUrl ? "postgres" : "pglite",
      queue: config.redisUrl ? "bullmq" : "in-process",
      worker: config.runWorker,
      robloxOAuth: config.roblox.enabled,
      qrisConfigured: !!config.qris.imageUrl,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  });
