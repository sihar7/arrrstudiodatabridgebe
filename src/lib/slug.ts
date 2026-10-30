import { randomBytes } from "node:crypto";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  return `${base || "workspace"}-${randomBytes(3).toString("hex")}`;
}
