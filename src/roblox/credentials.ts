import { eq } from "drizzle-orm";
import { db } from "@/db";
import { robloxConnections } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { refreshTokens } from "./oauth";
import { OpenCloudError, type OcAuth } from "./openCloud";

// Kredensial Open Cloud sebuah koneksi: API key → x-api-key; OAuth → Bearer access token.
// Refresh token OAuth sekali pakai, jadi refresh diserialkan: mutex in-process + row lock (FOR UPDATE)
// sehingga dua proses/worker tidak me-refresh bersamaan dan membakar token satu sama lain.

type Conn = typeof robloxConnections.$inferSelect;
const inflight = new Map<string, Promise<OcAuth>>();
const SKEW_MS = 60_000;

export async function authFor(conn: Conn): Promise<OcAuth> {
  if (conn.authType === "api_key") {
    if (!conn.encryptedApiKey) throw new OpenCloudError("auth", 0, "Connection has no API key");
    return { apiKey: decryptSecret(conn.encryptedApiKey) };
  }
  if (conn.encryptedAccessToken && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - SKEW_MS > Date.now()) {
    return { bearer: decryptSecret(conn.encryptedAccessToken) };
  }
  const running = inflight.get(conn.id);
  if (running) return running;
  const p = refreshLocked(conn.id).finally(() => inflight.delete(conn.id));
  inflight.set(conn.id, p);
  return p;
}

async function refreshLocked(connectionId: string): Promise<OcAuth> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.select().from(robloxConnections).where(eq(robloxConnections.id, connectionId)).for("update");
      if (!row) throw new OpenCloudError("not_found", 404, "Connection not found");
      // Proses lain mungkin sudah me-refresh selagi kita menunggu lock
      if (row.encryptedAccessToken && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() - SKEW_MS > Date.now()) {
        return { bearer: decryptSecret(row.encryptedAccessToken) };
      }
      if (!row.encryptedRefreshToken) throw new OpenCloudError("auth", 0, "Roblox authorization missing — reconnect");
      const t = await refreshTokens(decryptSecret(row.encryptedRefreshToken));
      await tx
        .update(robloxConnections)
        .set({
          encryptedAccessToken: encryptSecret(t.accessToken),
          encryptedRefreshToken: encryptSecret(t.refreshToken),
          accessTokenExpiresAt: t.expiresAt,
          status: "active",
          lastError: null,
        })
        .where(eq(robloxConnections.id, connectionId));
      return { bearer: t.accessToken };
    });
  } catch (e) {
    // Di luar transaksi agar tidak ikut ter-rollback: izin dicabut user / refresh token kedaluwarsa (90 hari)
    if (e instanceof OpenCloudError && e.kind === "auth") {
      await db.update(robloxConnections).set({ status: "expired", lastError: "OAUTH_REVOKED" }).where(eq(robloxConnections.id, connectionId));
    }
    throw e;
  }
}
