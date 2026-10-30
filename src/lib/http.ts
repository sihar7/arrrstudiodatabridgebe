import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

// Envelope konsisten: sukses { data, meta? } · gagal { error: { code, message, details? } }

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const forbidden = (msg = "You don't have permission for this action") => new ApiError(403, "FORBIDDEN", msg);
export const conflict = (msg: string) => new ApiError(409, "CONFLICT", msg);

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200, meta?: Record<string, unknown>) {
  return c.json(meta ? { data, meta } : { data }, status);
}

/** Parse & validasi body JSON; galat zod → 422 VALIDATION_ERROR berisi field yang salah. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "BAD_JSON", "Request body must be valid JSON");
  }
  return parse(schema, raw);
}

export function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Some fields are invalid", z.flattenError(r.error).fieldErrors);
  }
  return r.data;
}
