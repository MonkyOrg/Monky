import { v4 as uuidv4 } from 'uuid';
import { RoleRecord } from '../../domain/entities';
import { ADMIN_ROLE_NAME, customRoleRecord, parseNewRole, roleNameProblem, type RoleProblem } from '../../domain/roles';
import { ANSI, color, PERMISSION_OPTIONS } from '../constants';
import { CliContext } from '../context';
import {
  encodePermissions,
  formatBool,
  normalizeRoleColor,
  parsePermissionNames,
  permissionLabel,
} from '../formatters';
import { t } from '../i18n/index';
import { ask, askChoice, askMultiChoice, confirm } from '../prompts';
import { selectUser } from './members';

export async function resolveRole(ctx: CliContext, query: string): Promise<RoleRecord> {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error(t('roles.enterRole'));
  }

  const byId = await ctx.roleRepo.findById(normalized);
  if (byId) return byId;

  const byName = await ctx.roleRepo.findByName(normalized);
  if (byName) return byName;

  throw new Error(t('roles.notFound', { query: normalized }));
}

export async function selectRole(
  ctx: CliContext,
  question: string,
  query?: string,
  rolesOverride?: RoleRecord[]
): Promise<RoleRecord> {
  if (query?.trim()) {
    return resolveRole(ctx, query);
  }

  const roles = rolesOverride ?? (await ctx.roleRepo.listAll());
  if (roles.length === 0) {
    throw new Error(t('roles.noRoles'));
  }

  const labels = roles.map((r) => `${r.name} (${r.id})`);
  const selected = await askChoice(question, labels);
  return roles[labels.indexOf(selected)];
}

export async function listRoles(ctx: CliContext): Promise<void> {
  const roles = await ctx.roleRepo.listAll();
  const userRoles = await ctx.roleRepo.listUserRoles();
  const counts = new Map<string, number>();

  for (const entry of userRoles) {
    counts.set(entry.roleId, (counts.get(entry.roleId) ?? 0) + 1);
  }

  if (roles.length === 0) {
    console.log(color(t('roles.noRoles'), ANSI.yellow));
    return;
  }

  for (const role of roles) {
    console.log(color(`${role.name} (${role.id})`, ANSI.bold));
    console.log(`  ${t('label.color')}: ${role.color ?? '-'}`);
    console.log(`  ${t('label.position')}: ${role.position}`);
    console.log(`  ${t('label.permissions')}: ${role.permissions}`);
    console.log(`  ${t('label.isDefault')}: ${formatBool(role.isDefault)}`);
    console.log(`  ${t('label.members')}: ${counts.get(role.id) ?? 0}`);
  }
}

/** The CLI's words for a role the server rules refuse. */
function describeRoleProblem(problem: RoleProblem): string {
  if (problem.code === 'reserved-name') return t('roles.nameReserved', { name: ADMIN_ROLE_NAME });
  if (problem.field === 'name') return t('roles.nameInvalid');
  return t('roles.invalid', { reason: problem.message });
}

/** Creates a custom role by the same rules as the server (`domain/roles`). */
export async function createRoleInteractive(ctx: CliContext, args: string[]): Promise<void> {
  const inlineName = args[0];
  const inlineColor = args[1];
  const inlinePermissions = args.slice(2).join(' ');

  const name = inlineName?.trim() || (await ask(t('roles.askName')));
  // Refused before the remaining questions are asked.
  const nameProblem = roleNameProblem(name);
  if (nameProblem) {
    throw new Error(describeRoleProblem(nameProblem));
  }

  const colorInput = inlineColor !== undefined ? inlineColor : await ask(t('roles.askColor'));
  const roleColor = normalizeRoleColor(colorInput || '');

  const selectedPermissions = inlinePermissions.trim()
    ? parsePermissionNames(inlinePermissions)
    : await askMultiChoice(
        t('roles.permissionsLabel'),
        PERMISSION_OPTIONS.map((entry) => `${permissionLabel(entry.name)} (${entry.name})`)
      );

  const permissions = inlinePermissions.trim()
    ? encodePermissions(selectedPermissions)
    : encodePermissions(
        selectedPermissions.map((entry) => (entry.includes('(') ? entry.slice(0, entry.indexOf(' (')) : entry))
      );

  const parsed = parseNewRole({ name, color: roleColor, permissions });
  if (!parsed.ok) {
    throw new Error(describeRoleProblem(parsed.problem));
  }
  const role = customRoleRecord(parsed.role, parsed.role.permissions, uuidv4(), Date.now());

  await ctx.roleRepo.create(role);
  console.log(color(t('roles.created', { name: role.name }), ANSI.green));
}

export async function assignRoleInteractive(ctx: CliContext, args: string[], unassign: boolean): Promise<void> {
  const user = await selectUser(ctx, t('members.selectToGrant'), args[0]);
  const availableRoles = unassign ? await ctx.roleRepo.listRolesForUser(user.id) : await ctx.roleRepo.listAll();

  if (availableRoles.length === 0) {
    console.log(color(unassign ? t('roles.noRemovableRoles') : t('roles.noAvailable'), ANSI.yellow));
    return;
  }

  const role = await selectRole(
    ctx,
    unassign ? t('roles.selectToRemove') : t('roles.selectToAssign'),
    args[1],
    availableRoles
  );

  if (unassign && role.isDefault) {
    throw new Error(t('roles.defaultCannotRemove'));
  }

  if (unassign) {
    await ctx.roleRepo.unassignRole(user.id, role.id);
    console.log(color(t('roles.unassigned', { role: role.name, user: user.nickname }), ANSI.green));
    return;
  }

  await ctx.roleRepo.assignRole(user.id, role.id);
  console.log(color(t('roles.assigned', { role: role.name, user: user.nickname }), ANSI.green));
}

export async function deleteRoleInteractive(ctx: CliContext, args: string[]): Promise<void> {
  const role = await selectRole(ctx, t('roles.selectToRemove'), args[0]);
  const accepted = await confirm(t('roles.confirmDelete', { name: role.name }), false);
  if (!accepted) {
    console.log(color(t('prompt.cancelled'), ANSI.yellow));
    return;
  }

  await ctx.roleRepo.delete(role.id);
  console.log(color(t('roles.deleted', { name: role.name }), ANSI.green));
}
