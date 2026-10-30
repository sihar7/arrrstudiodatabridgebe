import { randomInt } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "@/config";
import { db } from "@/db";
import { billingOrders, workspaces } from "@/db/schema";
import { ApiError, body, notFound, ok } from "@/lib/http";
import { PLANS } from "@/lib/plans";
import { rateLimit } from "@/lib/rateLimit";
import { requirePermission, type Env } from "@/middleware/auth";

// Billing QRIS manual: buat order → bayar QRIS (nominal + kode unik) → unggah bukti → admin menyetujui.

const MONTHS = [1, 3, 12] as const;
// Diskon langganan panjang: 3 bln −5%, 12 bln −15%
const DISCOUNT: Record<number, number> = { 1: 0, 3: 0.05, 12: 0.15 };
const PROOF_MAX = 2 * 1024 * 1024;
const PROOF_TYPES = ["image/png", "image/jpeg", "image/webp"];

const orderSchema = z.object({ plan: z.enum(["developer", "studio"]), months: z.coerce.number().refine((m) => (MONTHS as readonly number[]).includes(m), "1, 3 or 12") });

export function priceOf(plan: "developer" | "studio", months: number) {
  return Math.round((PLANS[plan].priceIdr * months * (1 - (DISCOUNT[months] ?? 0))) / 1000) * 1000;
}

export function presentOrder(o: typeof billingOrders.$inferSelect) {
  const { proofData: _d, ...rest } = o;
  return { ...rest, hasProof: !!o.proofData };
}

async function loadOrder(workspaceId: string, id: string) {
  const [o] = await db
    .select()
    .from(billingOrders)
    .where(and(eq(billingOrders.id, z.string().uuid().parse(id)), eq(billingOrders.workspaceId, workspaceId)))
    .limit(1);
  if (!o) throw notFound("Order");
  return o;
}

export const billingRoutes = new Hono<Env>()
  .get("/", async (c) => {
    const ws = c.get("workspace");
    const orders = await db.select().from(billingOrders).where(eq(billingOrders.workspaceId, ws.id)).orderBy(desc(billingOrders.createdAt)).limit(20);
    return ok(c, {
      plan: ws.plan,
      planExpiresAt: ws.planExpiresAt,
      qris: config.qris,
      prices: Object.fromEntries((["developer", "studio"] as const).map((p) => [p, Object.fromEntries(MONTHS.map((m) => [m, priceOf(p, m)]))])),
      orders: orders.map(presentOrder),
    });
  })
  .post("/orders", requirePermission("workspace.update"), rateLimit({ key: "order", windowMs: 60 * 60_000, max: 10 }), async (c) => {
    const ws = c.get("workspace");
    const input = await body(c, orderSchema);
    // Satu order terbuka per workspace — order lama dibatalkan otomatis
    await db
      .update(billingOrders)
      .set({ status: "cancelled" })
      .where(and(eq(billingOrders.workspaceId, ws.id), eq(billingOrders.status, "pending")));
    const uniqueCode = randomInt(101, 999);
    const [o] = await db
      .insert(billingOrders)
      .values({ workspaceId: ws.id, plan: input.plan, months: input.months, amountIdr: priceOf(input.plan, input.months) + uniqueCode, uniqueCode, createdBy: c.get("user").id })
      .returning();
    return ok(c, presentOrder(o!), 201);
  })
  .post("/orders/:id/proof", requirePermission("workspace.update"), rateLimit({ key: "proof", windowMs: 60 * 60_000, max: 20 }), async (c) => {
    const o = await loadOrder(c.get("workspace").id, c.req.param("id"));
    if (!["pending", "awaiting_review", "rejected"].includes(o.status)) throw new ApiError(409, "INVALID_STATE", "This order can no longer be updated");
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) throw new ApiError(422, "VALIDATION_ERROR", "Upload an image", { file: ["Upload an image"] });
    if (!PROOF_TYPES.includes(file.type)) throw new ApiError(422, "VALIDATION_ERROR", "PNG, JPG or WebP only", { file: ["PNG, JPG or WebP only"] });
    if (file.size > PROOF_MAX) throw new ApiError(413, "FILE_TOO_LARGE", "Max 2 MB", { file: ["Max 2 MB"] });
    const data = Buffer.from(await file.arrayBuffer()).toString("base64");
    const [u] = await db
      .update(billingOrders)
      .set({ proofData: data, proofMime: file.type, status: "awaiting_review", note: null })
      .where(eq(billingOrders.id, o.id))
      .returning();
    return ok(c, presentOrder(u!));
  })
  .post("/orders/:id/cancel", requirePermission("workspace.update"), async (c) => {
    const o = await loadOrder(c.get("workspace").id, c.req.param("id"));
    if (!["pending", "awaiting_review"].includes(o.status)) throw new ApiError(409, "INVALID_STATE", "This order can no longer be cancelled");
    const [u] = await db.update(billingOrders).set({ status: "cancelled" }).where(eq(billingOrders.id, o.id)).returning();
    return ok(c, presentOrder(u!));
  });

/** Persetujuan order oleh admin: paket aktif, masa aktif diperpanjang dari sisa masa aktif yang ada. */
export async function approveOrder(orderId: string, adminId: string) {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(billingOrders).where(eq(billingOrders.id, orderId)).for("update");
    if (!o) throw notFound("Order");
    if (!["awaiting_review", "pending"].includes(o.status)) {
      throw new ApiError(409, "INVALID_STATE", "Order is not awaiting review");
    }
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, o.workspaceId));
    // Paket sama & masih aktif → perpanjang; lainnya mulai dari sekarang
    const base = ws!.plan === o.plan && ws!.planExpiresAt && ws!.planExpiresAt > new Date() ? ws!.planExpiresAt : new Date();
    const until = new Date(base);
    until.setMonth(until.getMonth() + o.months);
    await tx.update(workspaces).set({ plan: o.plan, planExpiresAt: until }).where(eq(workspaces.id, o.workspaceId));
    const [u] = await tx.update(billingOrders).set({ status: "paid", reviewedBy: adminId, reviewedAt: new Date() }).where(eq(billingOrders.id, o.id)).returning();
    return u!;
  });
}
