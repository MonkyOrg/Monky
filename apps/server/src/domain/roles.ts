import { roleCreateSchema, roleNameSchema, stripAdministrator, type RoleCreatePayload } from '@monky/shared';
import type { z } from 'zod';
import type { RoleRecord } from './entities';

/**
 * Rules for creating a custom role, shared by `RoleService` (the desktop over
 * the WebSocket) and `monky roles create`. The CLI used to build the record by
 * hand: it took names over 32 characters, a second role named "Admin", and
 * ADMINISTRATOR, which the next start stripped while promoting every member
 * holding the role to Admin (SHARED-CLI-9).
 */

/** Name of the built-in role that grants admin rights (#277). */
export const ADMIN_ROLE_NAME = 'Admin';

/** Whether a custom role would pass for the built-in Admin role (#277). */
export function usesReservedAdminName(name: string): boolean {
  return name.trim().toLowerCase() === ADMIN_ROLE_NAME.toLowerCase();
}

export type NewRole = z.infer<typeof roleCreateSchema>;

/** Why a role cannot be created; `field` names what the schema refused. */
export type RoleProblem =
  | { code: 'reserved-name' }
  | { code: 'invalid'; field: string | undefined; message: string };

function invalid(error: z.ZodError, field?: string): RoleProblem {
  const issue = error.errors[0];
  const path = issue?.path[0];
  return {
    code: 'invalid',
    field: field ?? (path === undefined ? undefined : String(path)),
    message: issue?.message || 'Cargo inválido',
  };
}

/** The problem with a custom role's name, or null when it may be used. */
export function roleNameProblem(name: string): RoleProblem | null {
  const parsed = roleNameSchema.safeParse(name);
  if (!parsed.success) return invalid(parsed.error, 'name');
  return usesReservedAdminName(parsed.data) ? { code: 'reserved-name' } : null;
}

/** Checks a new custom role against the protocol schema and the reserved name. */
export function parseNewRole(payload: RoleCreatePayload): { ok: true; role: NewRole } | { ok: false; problem: RoleProblem } {
  const parsed = roleCreateSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, problem: invalid(parsed.error) };
  if (usesReservedAdminName(parsed.data.name)) return { ok: false, problem: { code: 'reserved-name' } };
  return { ok: true, role: parsed.data };
}

/**
 * How a new custom role is stored. `grants` are the bits it grants; admin
 * rights come exclusively from the Admin role, so ADMINISTRATOR is dropped
 * (#277).
 */
export function customRoleRecord(role: NewRole, grants: number, id: string, now: number): RoleRecord {
  return {
    id,
    name: role.name,
    color: role.color ?? null,
    permissions: stripAdministrator(grants),
    position: role.position ?? now,
    isDefault: role.isDefault ?? false,
    createdAt: now,
  };
}
