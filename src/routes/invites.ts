import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "@/db";
import { workspaceInviteLinks, workspaceMembers, workspaces } from "@/db/schema";
import { sha256 } from "@/lib/crypto";
import { ApiError, ok } from "@/lib/http";
import { assertWithin, effectivePlan } from "@/lib/plans";
import { requireAuth, type Env } from "@/middleware/auth";

// Link undangan publik: pratinjau (tanpa login) & terima (setelah login Discord).

async function loadLink(token: string) {
  const [row] = await db
    .select({ link: workspaceInviteLinks, wsName: workspaces.name, wsPlan: workspaces.plan, wsExp: workspaces.planExpiresAt })
    .from(workspaceInviteLinks)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInviteLinks.workspaceId))
    .where(and(eq(workspaceInviteLinks.tokenHash, sha256(token)), isNull(workspaceInviteLinks.revokedAt)))
    .limit(1);
  if (!row) throw new ApiError(404, "INVITE_INVALID", "This invite link is invalid or was revoked");
  const l = row.link;
  if (l.expiresAt < new Date()) throw new ApiError(410, "INVITE_EXPIRED", "This invite link has expired");
  if (l.maxUses != null && l.uses >= l.maxUses) throw new ApiError(410, "INVITE_USED_UP", "This invite link has been used up");
  return row;
}

export const inviteRoutes = new Hono<Env>()
  .get("/:token", async (c) => {
    const r = await loadLink(c.req.param("token"));
    return ok(c, { workspaceName: r.wsName, role: r.link.role, expiresAt: r.link.expiresAt });
  })
  .post("/:token/accept", requireAuth, async (c) => {
    const r = await loadLink(c.req.param("token"));
    const userId = c.get("user").id;
    const [existing] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, r.link.workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    if (!existing) {
      await assertWithin({ id: r.link.workspaceId, plan: effectivePlan(r.wsPlan, r.wsExp) }, "seats");
      await db.insert(workspaceMembers).values({ workspaceId: r.link.workspaceId, userId, role: r.link.role }).onConflictDoNothing();
      await db.update(workspaceInviteLinks).set({ uses: sql`${workspaceInviteLinks.uses} + 1` }).where(eq(workspaceInviteLinks.id, r.link.id));
    }
    return ok(c, { workspaceId: r.link.workspaceId, workspaceName: r.wsName, alreadyMember: !!existing });
  });
