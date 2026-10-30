import type { Role } from "@/db/schema";

// Matriks izin per role workspace. Owner = semua; viewer = baca saja.
export type Permission =
  | "workspace.update"
  | "members.manage"
  | "connections.manage"
  | "projects.manage"
  | "datastores.manage"
  | "migrations.run";

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: ["workspace.update", "members.manage", "connections.manage", "projects.manage", "datastores.manage", "migrations.run"],
  admin: ["workspace.update", "members.manage", "connections.manage", "projects.manage", "datastores.manage", "migrations.run"],
  developer: ["projects.manage", "datastores.manage", "migrations.run"],
  viewer: [],
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm);
}

export function permissionsOf(role: Role): readonly Permission[] {
  return MATRIX[role];
}
