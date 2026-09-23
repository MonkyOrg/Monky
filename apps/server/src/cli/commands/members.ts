import { RoleRecord, UserRecord } from '../../domain/entities';
import { ANSI, color } from '../constants';
import { CliContext } from '../context';
import { formatDate, formatBool, pad } from '../formatters';
import { t } from '../i18n/index';
import { ask, askChoice } from '../prompts';

export async function resolveUser(ctx: CliContext, query: string): Promise<UserRecord> {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error(t('members.enterQuery'));
  }

  const byClientId = await ctx.userRepo.findByClientId(normalized);
  if (byClientId) {
    return byClientId;
  }

  const byNickname = await ctx.userRepo.findByNickname(normalized);
  if (byNickname) {
    return byNickname;
  }

  throw new Error(t('members.notFound', { query: normalized }));
}

export async function getRolesByUserId(ctx: CliContext): Promise<Map<string, RoleRecord[]>> {
  const roles = await ctx.roleRepo.listAll();
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const userRoles = await ctx.roleRepo.listUserRoles();
  const grouped = new Map<string, RoleRecord[]>();

  for (const entry of userRoles) {
    const role = rolesById.get(entry.roleId);
    if (!role) continue;
    const list = grouped.get(entry.userId) ?? [];
    list.push(role);
    grouped.set(entry.userId, list);
  }

  for (const list of grouped.values()) {
    list.sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
  }

  return grouped;
}

export async function listMembers(ctx: CliContext): Promise<void> {
  const users = (await ctx.userRepo.listAll()).sort((a, b) => a.nickname.localeCompare(b.nickname));
  const rolesByUser = await getRolesByUserId(ctx);

  if (users.length === 0) {
    console.log(color(t('members.noMembers'), ANSI.yellow));
    return;
  }

  const idWidth = Math.max(t('label.id').length, ...users.map((user) => user.id.length));
  const nickWidth = Math.max(t('label.nickname').length, ...users.map((user) => user.nickname.length));
  const clientWidth = Math.max(t('label.clientId').length, ...users.map((user) => user.clientId.length));

  console.log(
    `${color(pad(t('label.id'), idWidth), ANSI.cyan)}  ${color(pad(t('label.nickname'), nickWidth), ANSI.cyan)}  ${color(
      pad(t('label.clientId'), clientWidth),
      ANSI.cyan
    )}  ${color(t('label.roles'), ANSI.cyan)}`
  );

  for (const user of users) {
    const roleNames = (rolesByUser.get(user.id) ?? []).map((role) => role.name).join(', ') || '-';
    console.log(
      `${pad(user.id, idWidth)}  ${pad(user.nickname, nickWidth)}  ${pad(user.clientId, clientWidth)}  ${roleNames}`
    );
  }
}

export async function showMemberInfo(ctx: CliContext, query: string): Promise<void> {
  const normalized = query.trim() || (await ask(t('members.askNickname')));
  const user = await resolveUser(ctx, normalized);
  const roles = await ctx.roleRepo.listRolesForUser(user.id);
  const server = await ctx.serverRepo.getServer();

  console.log(color(t('members.info', { nickname: user.nickname }), ANSI.bold));
  console.log(`${t('label.id')}: ${user.id}`);
  console.log(`${t('label.clientId')}: ${user.clientId}`);
  console.log(`${t('label.publicKey')}: ${user.publicKey ?? '-'}`);
  console.log(`${t('label.avatarPath')}: ${user.avatarPath ?? '-'}`);
  console.log(`${t('label.createdAt')}: ${formatDate(user.createdAt)}`);
  console.log(`${t('label.lastSeenAt')}: ${formatDate(user.lastSeenAt)}`);
  console.log(`${t('label.owner')}: ${formatBool(server?.ownerUserId === user.id)}`);
  console.log(`${t('label.roles')}: ${roles.map((role) => role.name).join(', ') || '-'}`);
}

export async function selectUser(ctx: CliContext, question: string, query?: string): Promise<UserRecord> {
  if (query?.trim()) {
    return resolveUser(ctx, query);
  }

  const users = (await ctx.userRepo.listAll()).sort((a, b) => a.nickname.localeCompare(b.nickname));
  if (users.length === 0) {
    throw new Error(t('members.noMembers'));
  }

  const labels = users.map((u) => `${u.nickname} (${u.clientId})`);
  const selected = await askChoice(question, labels);
  return users[labels.indexOf(selected)];
}

export async function changeAdminRole(ctx: CliContext, query: string, assign: boolean): Promise<void> {
  const user = await selectUser(
    ctx,
    assign ? t('members.selectToGrant') : t('members.selectToRevoke'),
    query
  );
  const adminRole = await ctx.roleRepo.findByName('Admin');
  if (!adminRole) {
    throw new Error(t('create.adminRoleNotFound'));
  }

  if (assign) {
    await ctx.roleRepo.assignRole(user.id, adminRole.id);
    console.log(color(t('members.adminGranted', { nickname: user.nickname }), ANSI.green));
    return;
  }

  await ctx.roleRepo.unassignRole(user.id, adminRole.id);
  console.log(color(t('members.adminRevoked', { nickname: user.nickname }), ANSI.green));
}
