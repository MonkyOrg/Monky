import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_PERMISSIONS, CHANNEL_PERMISSIONS, DEFAULT_PERMISSIONS, Permission,
  canAccessChannel, channelPrivacy, getChannelPermissions, hasChannelPermission, resolveChannelPermissions, withChannelPrivacy,
  resolveMemberPermissions, type ChannelPermissionOverwrite,
} from '../src/permissions';
import { channelPermissionOverwritesSchema } from '../src/validators';

const rules = (permissionOverwrites: ChannelPermissionOverwrite[]) => ({
  isPrivate: false, allowedRoleIds: [], permissionOverwrites,
});

test('Everyone is automatic; ordinary role switches override it and denials win between roles', () => {
  const base = DEFAULT_PERMISSIONS & ~Permission.SPEAK;
  assert.equal(resolveMemberPermissions(base, []), base);
  assert.equal(resolveMemberPermissions(base, [{ permissions: DEFAULT_PERMISSIONS }]), DEFAULT_PERMISSIONS);
  assert.equal(resolveMemberPermissions(DEFAULT_PERMISSIONS, [
    { permissions: DEFAULT_PERMISSIONS }, { permissions: base },
  ]), base);
  assert.equal(resolveMemberPermissions(0, [{ permissions: 0 }, { permissions: Permission.ADMINISTRATOR }]), ADMIN_PERMISSIONS);
});

test('channel role grants override Everyone, while a denial from any assigned role wins', () => {
  const channel = rules([
    { roleId: null, allow: 0, deny: Permission.SEND_MESSAGES },
    { roleId: 'writer', allow: Permission.SEND_MESSAGES, deny: 0 },
    { roleId: 'muted', allow: 0, deny: Permission.SEND_MESSAGES },
    { roleId: 'color', allow: 0, deny: 0 },
  ]);
  assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES), false);
  assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['writer', 'color'], Permission.SEND_MESSAGES), true);
  for (const ids of [['writer', 'muted'], ['muted', 'writer']]) {
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ids, Permission.SEND_MESSAGES), false);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ids, Permission.READ_MESSAGES), true);
  }
  assert.equal(getChannelPermissions(channel, ADMIN_PERMISSIONS, ['muted']), ADMIN_PERMISSIONS);
});

test('member rules override Everyone but denials win between a member and their roles in either order', () => {
  const base = { roleId: null, allow: 0, deny: Permission.SEND_MESSAGES };
  const personal = { userId: 'reader', allow: Permission.SEND_MESSAGES, deny: 0 };
  const denied = { roleId: 'muted', allow: 0, deny: Permission.SEND_MESSAGES };
  for (const entries of [[base, personal, denied], [denied, personal, base]]) {
    const channel = rules(entries);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES, false, 'reader'), true);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, [], Permission.SEND_MESSAGES, false, 'someone-else'), false);
    assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['muted'], Permission.SEND_MESSAGES, false, 'reader'), false);
    assert.equal(hasChannelPermission(channel, ADMIN_PERMISSIONS, ['muted'], Permission.SEND_MESSAGES, false, 'reader'), true);
  }
  const channel = rules([
    { roleId: 'writer', allow: Permission.SEND_MESSAGES, deny: 0 },
    { userId: 'reader', allow: 0, deny: Permission.SEND_MESSAGES },
  ]);
  assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['writer'], Permission.SEND_MESSAGES, false, 'reader'), false);
  assert.equal(hasChannelPermission(channel, DEFAULT_PERMISSIONS, ['writer'], Permission.SEND_MESSAGES, false, 'other'), true);
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
