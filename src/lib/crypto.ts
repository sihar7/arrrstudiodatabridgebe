import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "@/config";

// Enkripsi credential at rest: AES-256-GCM, format "v1:<iv>:<tag>:<ciphertext>" (base64url).
// Rotasi: kunci baru di ENCRYPTION_KEY, kunci lama di ENCRYPTION_KEYS_PREVIOUS → tetap bisa dibaca.

export function encryptSecret(plain: string, key = config.encryptionKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
}

export function decryptSecret(payload: string): string {
  const [v, iv, tag, data] = payload.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Format credential tidak dikenal");
  for (const key of [config.encryptionKey, ...config.previousKeys]) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
    } catch {
      // coba kunci berikutnya
    }
  }
  throw new Error("Credential tidak bisa didekripsi (kunci enkripsi berubah?)");
}

/** Sidik jari non-rahasia untuk mendeteksi key duplikat & ditampilkan di UI. */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
