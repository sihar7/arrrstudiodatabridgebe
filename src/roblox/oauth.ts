import { createHash } from "node:crypto";
import { config } from "@/config";
import { randomToken } from "@/lib/crypto";
import { OpenCloudError } from "./openCloud";

// Roblox OAuth 2.0 (authorization code + PKCE S256, confidential client).
// Docs: create.roblox.com/docs/cloud/auth/oauth2-reference — access token 15 mnt, refresh token 90 hari & sekali pakai.

const OAUTH = "https://apis.roblox.com/oauth/v1";

export const redirectUri = () => `${config.appUrl.replace(/\/$/, "")}/api/v1/auth/roblox/callback`;

export function pkce() {
  const verifier = randomToken(48); // 64 karakter base64url (43–128 sesuai spesifikasi)
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(opts: { scope: string; state: string; challenge: string; prompt?: string }) {
  const q = new URLSearchParams({
    client_id: config.roblox.clientId,
    redirect_uri: redirectUri(),
    scope: opts.scope,
    response_type: "code",
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  if (opts.prompt) q.set("prompt", opts.prompt);
  return `${OAUTH}/authorize?${q}`;
}

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: Date; scope: string };

async function form<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${OAUTH}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: config.roblox.clientId, client_secret: config.roblox.clientSecret }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) throw new OpenCloudError("upstream", 0, "Roblox OAuth is unreachable");
  const text = await res.text();
  if (!res.ok) {
    let msg = `OAuth responded ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      msg = j.error_description || j.error || msg;
    } catch {
      // bukan JSON
    }
    throw new OpenCloudError(res.status === 400 || res.status === 401 ? "auth" : "upstream", res.status, msg.slice(0, 300));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

type RawToken = { access_token: string; refresh_token: string; expires_in: number; scope: string };
const toSet = (r: RawToken): TokenSet => ({
  accessToken: r.access_token,
  refreshToken: r.refresh_token,
  expiresAt: new Date(Date.now() + (r.expires_in || 900) * 1000),
  scope: r.scope ?? "",
});

export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  return toSet(await form<RawToken>("/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri() }));
}

/** Refresh token sekali pakai: simpan refresh token BARU dari respons ini. */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return toSet(await form<RawToken>("/token", { grant_type: "refresh_token", refresh_token: refreshToken }));
}

export async function revokeToken(refreshToken: string): Promise<void> {
  await form("/token/revoke", { token: refreshToken }).catch(() => {});
}

export type RobloxProfile = { userId: string; username: string | null; displayName: string | null; avatarUrl: string | null };

export async function userInfo(accessToken: string): Promise<RobloxProfile> {
  const res = await fetch(`${OAUTH}/userinfo`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new OpenCloudError("auth", res.status, "Could not read Roblox profile");
  const j = (await res.json()) as { sub: string; preferred_username?: string; name?: string; nickname?: string; picture?: string | null };
  return { userId: String(j.sub), username: j.preferred_username ?? null, displayName: j.name ?? j.nickname ?? null, avatarUrl: j.picture ?? null };
}

/** Universe yang diizinkan user pada consent screen (POST /token/resources). */
export async function grantedUniverses(accessToken: string): Promise<string[]> {
  const r = await form<{ resource_infos?: { resources?: { universe?: { ids?: string[] } } }[] }>("/token/resources", { token: accessToken });
  const ids = new Set<string>();
  for (const info of r.resource_infos ?? []) for (const u of info.resources?.universe?.ids ?? []) ids.add(String(u));
  return [...ids];
}

/* ── API publik Roblox (tanpa auth): cari user dari username + avatar ── */

export type RobloxUser = { userId: string; username: string; displayName: string; avatarUrl: string | null };

export async function findUserByUsername(username: string): Promise<RobloxUser | null> {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) throw new OpenCloudError("upstream", res?.status ?? 0, "Roblox user lookup failed");
  const j = (await res.json()) as { data?: { id: number; name: string; displayName: string }[] };
  const u = j.data?.[0];
  if (!u) return null;
  return { userId: String(u.id), username: u.name, displayName: u.displayName, avatarUrl: await avatarOf(String(u.id)) };
}

export async function avatarOf(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`, {
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await res.json()) as { data?: { imageUrl?: string; state?: string }[] };
    const img = j.data?.[0];
    return img?.state === "Completed" && img.imageUrl ? img.imageUrl : null;
  } catch {
    return null;
  }
}
