import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_PERMISSIONS, CHANNEL_PERMISSIONS, DEFAULT_PERMISSIONS, Permission,
  canAccessChannel, channelPrivacy, getChannelPermissions, hasChannelPermission, resolveChannelPermissions, withChannelPrivacy,
  resolveMemberPermissions, resolveRoleDenyMemberPermissions, resolveLegacyMemberPermissions, legacyRoleMask, legacyRoleGrants,
  toLegacyRoles, toRoleDenyRoles, withVoicePresence, type ChannelPermissionOverwrite,
} from '../src/permissions';
import { channelPermissionOverwritesSchema, roleCreateSchema, roleUpdateSchema } from '../src/validators';

const rules = (permissionOverwrites: ChannelPermissionOverwrite[]) => ({
  isPrivate: false, allowedRoleIds: [], permissionOverwrites,
});

test('server roles only grant: a member has what Everyone or any of their roles turns on', () => {
  const base = DEFAULT_PERMISSIONS & ~Permission.SPEAK;
  assert.equal(resolveMemberPermissions(base, []), base);
  assert.equal(resolveMemberPermissions(base, [{ permissions: 0 }]), base, 'a role with everything off changes nothing');
  assert.equal(resolveMemberPermissions(base, [{ permissions: Permission.SPEAK }]), DEFAULT_PERMISSIONS);
  assert.equal(resolveMemberPermissions(base, [{ permissions: 0 }, { permissions: Permission.SPEAK }]), DEFAULT_PERMISSIONS,
    'one role turning a permission on is enough, whatever the other roles say');
  const strayDeny = [{ permissions: 0, deny: Permission.SPEAK }];
  assert.equal(resolveMemberPermissions(DEFAULT_PERMISSIONS, strayDeny), DEFAULT_PERMISSIONS,
    'a stray deny from a 36.1 client never takes anything away');
  assert.equal(resolveMemberPermissions(Permission.ADMINISTRATOR | Permission.SPEAK, []), Permission.SPEAK);
  assert.equal(resolveMemberPermissions(0, [{ permissions: 0 }, { permissions: Permission.ADMINISTRATOR }]), ADMIN_PERMISSIONS);
});

test('36.1 role rules still resolve with a denial winning, and grants sent to them resolve to the same union', () => {
  assert.equal(resolveRoleDenyMemberPermissions(DEFAULT_PERMISSIONS, [
    { permissions: Permission.SPEAK, deny: 0 }, { permissions: 0, deny: Permission.SPEAK },
  ]), DEFAULT_PERMISSIONS & ~Permission.SPEAK);
  const everyone = DEFAULT_PERMISSIONS & ~Permission.ATTACH_FILES;
  const roles = [
    { id: 'a', permissions: Permission.ATTACH_FILES },
    { id: 'b', permissions: Permission.MANAGE_CHANNELS | Permission.SPEAK },
  ];
  const sent = toRoleDenyRoles(roles);
  assert.deepEqual(sent.map(role => role.deny), [0, 0]);
  assert.equal(resolveRoleDenyMemberPermissions(everyone, sent), resolveMemberPermissions(everyone, roles));
});

test('clients before 36.1 get full masks that round-trip to the same grants', () => {
  const everyone = DEFAULT_PERMISSIONS & ~Permission.ATTACH_FILES;
  for (const grants of [0, Permission.ATTACH_FILES, Permission.CONFIGURE_BOTS | Permission.SPEAK, Permission.MANAGE_ROLES]) {
    const mask = legacyRoleMask(grants, everyone);
    assert.equal(mask, everyone | grants);
    assert.equal(resolveLegacyMemberPermissions(everyone, [{ permissions: mask }]), resolveMemberPermissions(everyone, [{ permissions: grants }]));
    assert.equal(legacyRoleGrants(mask, everyone, grants), grants, 'saving an untouched mask keeps every grant');
  }
  assert.equal(legacyRoleGrants(DEFAULT_PERMISSIONS | Permission.MANAGE_ROLES, everyone), Permission.ATTACH_FILES | Permission.MANAGE_ROLES);
  assert.equal(legacyRoleGrants(everyone & ~Permission.SPEAK, everyone, Permission.SPEAK), 0,
    'turning off a bit Everyone has only drops the role grant');
  assert.equal(legacyRoleMask(ADMIN_PERMISSIONS, everyone), ADMIN_PERMISSIONS);
  assert.equal(legacyRoleGrants(ADMIN_PERMISSIONS, everyone), ADMIN_PERMISSIONS);
  const [legacy] = toLegacyRoles([{ id: 'r', permissions: Permission.SPEAK, deny: Permission.ATTACH_FILES }], everyone);
  assert.deepEqual(legacy, { id: 'r', permissions: everyone | Permission.SPEAK });
});

test('role payloads accept the deny bits 36.1 clients send, without overlapping grants', () => {
  assert.equal(roleCreateSchema.parse({ name: 'Mods', permissions: Permission.MANAGE_CHANNELS, deny: 0 }).deny, 0);
  assert.equal(roleCreateSchema.parse({ name: 'Grants', permissions: Permission.MANAGE_CHANNELS }).deny, undefined);
  assert.equal(roleCreateSchema.safeParse({ name: 'Both', permissions: Permission.SPEAK, deny: Permission.SPEAK }).success, false);
  assert.equal(roleUpdateSchema.safeParse({ roleId: 'r', permissions: Permission.SPEAK, deny: Permission.SPEAK }).success, false);
});

test('channel role rules override Everyone, while a denial from any assigned role wins over another role', () => {
  const channel = rules([
    { roleId: null, allow: 0, deny: Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL },
    { roleId: 'writer', allow: Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL, deny: 0 },
    { roleId: 'muted', allow: 0, deny: Permission.SEND_MESSAGES },
    { roleId: 'color', allow: 0, deny: 0 },
  ]);
  assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES), false);
  assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, []), false);
  assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, ['writer']), true, 'a role allowed in opens a private channel');
  assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['writer', 'color'], Permission.SEND_MESSAGES), true);
  for (const ids of [['writer', 'muted'], ['muted', 'writer']]) {
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ids, Permission.SEND_MESSAGES), false);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ids, Permission.READ_MESSAGES), true);
  }
  assert.equal(getChannelPermissions(channel, ADMIN_PERMISSIONS, ['muted']), ADMIN_PERMISSIONS);
});

test('a rule for the member themself wins over their roles in either direction, whatever the order', () => {
  const base = { roleId: null, allow: 0, deny: Permission.SEND_MESSAGES };
  const personal = { userId: 'reader', allow: Permission.SEND_MESSAGES, deny: 0 };
  const denied = { roleId: 'muted', allow: 0, deny: Permission.SEND_MESSAGES };
  for (const entries of [[base, personal, denied], [denied, personal, base], [personal, denied, base]]) {
    const channel = rules(entries);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES, false, 'reader'), true);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES, false, 'someone-else'), false);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['muted'], Permission.SEND_MESSAGES, false, 'reader'), true);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['muted'], Permission.SEND_MESSAGES, false, 'someone-else'), false);
  }
  for (const entries of [
    [{ roleId: 'writer', allow: Permission.SEND_MESSAGES, deny: 0 }, { userId: 'reader', allow: 0, deny: Permission.SEND_MESSAGES }],
    [{ userId: 'reader', allow: 0, deny: Permission.SEND_MESSAGES }, { roleId: 'writer', allow: Permission.SEND_MESSAGES, deny: 0 }],
  ]) {
    const channel = rules(entries);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['writer'], Permission.SEND_MESSAGES, false, 'reader'), false);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['writer'], Permission.SEND_MESSAGES, false, 'other'), true);
    assert.equal(hasChannelPermission(channel, ADMIN_PERMISSIONS, ['writer'], Permission.SEND_MESSAGES, false, 'reader'), true);
  }
  const inherit = rules([denied, { userId: 'reader', allow: 0, deny: 0 }]);
  assert.equal(hasChannelPermission(inherit, DEFAULT_PERMISSIONS, ['muted'], Permission.SEND_MESSAGES, false, 'reader'), false,
    'Herdar on the member keeps what their roles decided');
});
test('roles and members are distinct targets even with identical IDs; invalid and duplicate members are rejected', () => {
  const entries = [
    { roleId: 'same', allow: Permission.SEND_MESSAGES, deny: 0 },
    { userId: 'same', allow: 0, deny: Permission.SEND_MESSAGES },
  ];
  assert.equal(channelPermissionOverwritesSchema.safeParse(entries).success, true);
  assert.equal(hasChannelPermission(rules(entries), DEFAULT_PERMISSIONS, ['same'], Permission.SEND_MESSAGES, false, 'other'), true);
  assert.equal(hasChannelPermission(rules(entries), DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES, false, 'same'), false);
  for (const invalid of [
    [{ userId: '', allow: 0, deny: 0 }],
    [{ userId: 'same', roleId: null, allow: 0, deny: 0 }],
    [{ userId: 'same', roleId: 'role', allow: 0, deny: 0 }],
    [{ allow: 0, deny: 0 }],
    [entries[1], entries[1]],
  ]) assert.equal(channelPermissionOverwritesSchema.safeParse(invalid).success, false);
});

test('private categories inherit member access without confusing it with Everyone or legacy role grants', () => {
  const overwrites = [
    { roleId: null, allow: 0, deny: Permission.VIEW_CHANNEL },
    { userId: 'member', allow: Permission.VIEW_CHANNEL, deny: Permission.SEND_MESSAGES },
  ];
  const category = { ...rules(overwrites), ...channelPrivacy(overwrites) };
  assert.deepEqual(category.allowedRoleIds, []);
  const channel = resolveChannelPermissions({ ...rules([]), categoryId: 'category' }, category);
  assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, [], false, 'member'), true);
  assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, [], false, 'other'), false);
  assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, [], true, 'member'), false);
  const toggled = withChannelPrivacy(overwrites, true, []);
  assert.deepEqual(toggled, overwrites);
  assert.equal(channelPrivacy([{ userId: 'member', allow: Permission.VIEW_CHANNEL, deny: 0 }]).isPrivate, false);
});

test('visibility and reading are independent; channel managers cannot bypass explicit rules', () => {
  const channel = rules([{ roleId: null, allow: 0, deny: Permission.READ_MESSAGES }]);
  assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, []), true);
  assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, [], Permission.READ_MESSAGES), false);
  const hidden = rules([{ roleId: null, allow: 0, deny: Permission.VIEW_CHANNEL }]);
  assert.equal(canAccessChannel(hidden, DEFAULT_PERMISSIONS | Permission.MANAGE_CHANNELS, []), false);
  assert.equal(hasChannelPermission(hidden, DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES), false);
  assert.equal(canAccessChannel(hidden, Permission.ADMINISTRATOR, []), true);
});

test('inheritance snapshots every rule and fails closed when the parent disappears', () => {
  const category = rules([{ roleId: 'writer', allow: Permission.SEND_MESSAGES, deny: Permission.ATTACH_FILES }]);
  const channel = { ...rules([]), categoryId: 'category' };
  const resolved = resolveChannelPermissions(channel, category);
  assert.deepEqual(resolved.permissionOverwrites, category.permissionOverwrites);
  assert.notEqual(resolved.permissionOverwrites, category.permissionOverwrites);
  assert.deepEqual(resolveChannelPermissions({ ...channel, inheritCategoryPermissions: false }, category), rules([]));
  assert.equal(canAccessChannel(resolveChannelPermissions(channel, null), DEFAULT_PERMISSIONS, ['writer']), false);
});

test('channel rules cannot grant administrative server rights, duplicate targets or contradictory bits', () => {
  assert.equal(channelPermissionOverwritesSchema.safeParse([{ roleId: null, allow: CHANNEL_PERMISSIONS, deny: 0 }]).success, true);
  for (const allow of [Permission.ADMINISTRATOR, Permission.MANAGE_SERVER, Permission.MANAGE_ROLES,
    Permission.MANAGE_CHANNELS, Permission.MOVE_MEMBERS, 0xFFFFFFFF]) {
    assert.equal(channelPermissionOverwritesSchema.safeParse([{ roleId: null, allow, deny: 0 }]).success, false);
  }
  assert.equal(channelPermissionOverwritesSchema.safeParse([{ roleId: null, allow: 256, deny: 256 }]).success, false);
  assert.equal(channelPermissionOverwritesSchema.safeParse([
    { roleId: null, allow: 0, deny: 0 }, { roleId: null, allow: 0, deny: 0 },
  ]).success, false);
});

test('events and live actions are server permissions; legacy channel bits are accepted but dropped', () => {
  assert.equal((CHANNEL_PERMISSIONS & Permission.MANAGE_EVENTS), 0);
  assert.equal((CHANNEL_PERMISSIONS & Permission.EMIT_LIVE_ACTIONS), 0);
  const legacyBits = Permission.MANAGE_EVENTS | Permission.EMIT_LIVE_ACTIONS;
  const parsed = channelPermissionOverwritesSchema.safeParse([
    { roleId: null, allow: Permission.SEND_MESSAGES | legacyBits, deny: 0 },
    { roleId: 'host', allow: 0, deny: legacyBits },
  ]);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success && parsed.data, [
    { roleId: null, allow: Permission.SEND_MESSAGES, deny: 0 },
    { roleId: 'host', allow: 0, deny: 0 },
  ]);
  const stored = rules([
    { roleId: null, allow: legacyBits, deny: 0 },
    { roleId: 'host', allow: 0, deny: legacyBits },
  ]);
  assert.equal(hasChannelPermission(stored, DEFAULT_PERMISSIONS, [], Permission.MANAGE_EVENTS), false);
  assert.equal(hasChannelPermission(stored, DEFAULT_PERMISSIONS | legacyBits, ['host'], Permission.MANAGE_EVENTS), true);
  assert.equal(hasChannelPermission(stored, DEFAULT_PERMISSIONS | legacyBits, ['host'], Permission.EMIT_LIVE_ACTIONS), true);
});

test('server-level permissions ignore legacy channel overwrites', () => {
  assert.equal((CHANNEL_PERMISSIONS & Permission.MANAGE_CHANNELS), 0);
  assert.equal((CHANNEL_PERMISSIONS & Permission.MOVE_MEMBERS), 0);
  const legacy = rules([
    { roleId: null, allow: Permission.MANAGE_CHANNELS | Permission.MOVE_MEMBERS, deny: Permission.SPEAK },
    { roleId: 'speaker', allow: Permission.SPEAK, deny: Permission.MOVE_MEMBERS },
  ]);
  assert.equal(hasChannelPermission(legacy, DEFAULT_PERMISSIONS, ['speaker'], Permission.MANAGE_CHANNELS), false);
  assert.equal(hasChannelPermission(legacy, DEFAULT_PERMISSIONS | Permission.MANAGE_CHANNELS, ['speaker'], Permission.MANAGE_CHANNELS), true);
  assert.equal(hasChannelPermission(legacy, DEFAULT_PERMISSIONS | Permission.MOVE_MEMBERS, ['speaker'], Permission.MOVE_MEMBERS), true);
  assert.equal(hasChannelPermission(legacy, DEFAULT_PERMISSIONS & ~Permission.SPEAK, ['speaker'], Permission.SPEAK), true);
});

test('a bot capability ceiling cannot be expanded by an Everyone grant', () => {
  const channel = rules([{ roleId: null, allow: Permission.SEND_MESSAGES, deny: 0 }]);
  const approved = Permission.VIEW_CHANNEL | Permission.READ_MESSAGES;
  assert.equal(hasChannelPermission(channel, approved, [], Permission.SEND_MESSAGES, true), false);
});

test('unrelated permission changes preserve the bot exclusion of migrated Member audiences', () => {
  const previous = { ...rules([{ roleId: null, allow: Permission.VIEW_CHANNEL, deny: 0 }]), isPrivate: true };
  const changed = [{ roleId: null, allow: Permission.VIEW_CHANNEL, deny: Permission.SEND_MESSAGES }];
  assert.equal(channelPrivacy(changed, previous).isPrivate, true);
  assert.equal(channelPrivacy(changed, { ...previous, isPrivate: false }).isPrivate, false);
  assert.equal(channelPrivacy([], previous).isPrivate, false, 'an explicit visibility change replaces the legacy flag');
});

test('a member inside a voice room keeps seeing it while every other rule still applies', () => {
  const hidden = rules([
    { roleId: null, allow: 0, deny: Permission.VIEW_CHANNEL },
    { userId: 'guest', allow: Permission.READ_MESSAGES, deny: Permission.SPEAK | Permission.VIEW_CHANNEL },
  ]);
  assert.equal(canAccessChannel(hidden, DEFAULT_PERMISSIONS, [], false, 'guest'), false);
  const present = withVoicePresence(hidden, 'guest');
  assert.equal(canAccessChannel(present, DEFAULT_PERMISSIONS, [], false, 'guest'), true);
  assert.equal(hasChannelPermission(present, DEFAULT_PERMISSIONS, [], Permission.READ_MESSAGES, false, 'guest'), true);
  assert.equal(hasChannelPermission(present, DEFAULT_PERMISSIONS, [], Permission.SPEAK, false, 'guest'), false, 'their own denial is kept');
  assert.equal(canAccessChannel(present, DEFAULT_PERMISSIONS, [], false, 'other'), false, 'nobody else gains the view');
  const legacyPrivate = { isPrivate: true, allowedRoleIds: ['vip'] };
  assert.equal(canAccessChannel(withVoicePresence(legacyPrivate, 'guest'), DEFAULT_PERMISSIONS, [], false, 'guest'), true);
  assert.equal(canAccessChannel(withVoicePresence(legacyPrivate, 'guest'), DEFAULT_PERMISSIONS, [], true, 'guest'), false,
    'bots never enter private rooms through presence');
  assert.equal(hasChannelPermission(withVoicePresence({ isPrivate: false, allowedRoleIds: [] }, 'guest'),
    DEFAULT_PERMISSIONS, [], Permission.SPEAK, false, 'guest'), true, 'legacy public rooms keep their base permissions');
});
