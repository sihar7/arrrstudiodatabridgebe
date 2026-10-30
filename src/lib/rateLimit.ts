import type { MiddlewareHandler } from "hono";
import { ApiError } from "./http";

// Rate limit fixed-window di memori per IP (satu instance Railway). Fase 2 pindah ke Redis bila API di-scale.
export function rateLimit(opts: { windowMs: number; max: number; key: string }): MiddlewareHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, opts.windowMs).unref();
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
    const k = `${opts.key}:${ip}`;
    const now = Date.now();
    const cur = hits.get(k);
    const entry = cur && cur.reset > now ? cur : { n: 0, reset: now + opts.windowMs };
    entry.n++;
    hits.set(k, entry);
    if (entry.n > opts.max) {
      c.header("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      throw new ApiError(429, "RATE_LIMITED", "Too many requests, try again shortly");
    }
    await next();
  };
}
