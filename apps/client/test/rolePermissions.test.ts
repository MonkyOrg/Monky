import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PERMISSIONS, Permission, type ChannelCategory, type ChannelSummary, type Role, type UserSummary } from '@monky/shared';
import { accessSignature, createServerStore } from '../src/renderer/stores/serverStore';
import { EventBus } from '../src/renderer/core/EventBus';

const member: UserSummary = { id: 'member', clientId: 'member-key', nickname: 'Member', status: 'ONLINE', joinedAt: 1 };
const role = (id: string, permissions: number, deny?: number): Role =>
  ({ id, name: id, color: null, position: 1, permissions, deny, isDefault: false });

function storeWith(features: string[] | undefined, roles: Role[]) {
  const store = createServerStore();
  store.bus = new EventBus();
  store.setServerDetails({
    id: 'server', name: 'Roles', createdAt: 1, maxUsers: 0, channels: [], voiceStates: {}, members: [member],
    everyonePermissions: DEFAULT_PERMISSIONS,
    protocol: features ? { version: 36, minimumVersion: 35, features } : undefined,
  }, member);
  store.updateRoles(roles, [{ userId: member.id, roleIds: roles.map(entry => entry.id) }]);
  return store;
}

test('roles only add grants over Everyone when the server negotiates role-grants', () => {
  const store = storeWith(['role-deny', 'role-grants'], [role('mod', Permission.KICK_MEMBERS), role('quiet', 0)]);
  assert.equal(store.roleModel, 'grants');
  assert.equal(store.getUserPermissions(member.id), DEFAULT_PERMISSIONS | Permission.KICK_MEMBERS,
    'a role with nothing on never takes away what Everyone or another role grants');
});

test('36.1 servers keep their allow/deny roles, where any denial wins', () => {
  const store = storeWith(['role-deny'], [role('mod', Permission.KICK_MEMBERS, 0), role('quiet', 0, Permission.SEND_MESSAGES)]);
  assert.equal(store.roleModel, 'deny');
  assert.equal(store.getUserPermissions(member.id), (DEFAULT_PERMISSIONS | Permission.KICK_MEMBERS) & ~Permission.SEND_MESSAGES);
});

test('servers without role-deny keep the former full-mask intersection even before any role exists', () => {
  const empty = storeWith([], []);
  assert.equal(empty.roleModel, 'legacy', 'role creation on older servers must send full masks');
  const store = storeWith([], [role('a', DEFAULT_PERMISSIONS | Permission.KICK_MEMBERS), role('b', DEFAULT_PERMISSIONS)]);
  assert.equal(store.getUserPermissions(member.id), DEFAULT_PERMISSIONS);
});

test('without negotiated protocol details the role shape decides the format', () => {
  assert.equal(storeWith(undefined, [role('a', Permission.KICK_MEMBERS, 0)]).roleModel, 'deny');
  assert.equal(storeWith(undefined, [role('a', DEFAULT_PERMISSIONS)]).roleModel, 'legacy');
});

test('a role change redraws once, and resent unchanged channels or categories do not redraw again', () => {
  const store = storeWith(['role-deny', 'role-grants'], []);
  const channel: ChannelSummary = { id: 'general', serverId: 'server', name: 'General', type: 'TEXT', position: 0, createdAt: 1,
    isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true };
  const category: ChannelCategory = { id: 'lobby', serverId: 'server', name: 'Lobby', position: 0, createdAt: 1, isPrivate: false, allowedRoleIds: [] };
  store.addChannel(channel);
  store.setCategories([category]);
  let redraws = 0;
  store.bus.on('server.updated', () => { redraws++; });

  const access = accessSignature(store);
  store.updateRoles([role('mod', Permission.KICK_MEMBERS)], [{ userId: 'someone-else', roleIds: ['mod'] }]);
  store.setCategories([{ ...category }]);
  store.updateChannel({ ...channel });
  assert.equal(redraws, 1, 'only the role list itself redraws the sidebar');
  assert.equal(accessSignature(store), access, 'another member\'s role leaves this member\'s access as it was');

  store.updateChannel({ ...channel, name: 'Renamed' });
  store.setCategories([{ ...category, name: 'Hall' }]);
  assert.equal(redraws, 3, 'real edits still redraw');

  store.updateRoles([role('mod', Permission.KICK_MEMBERS)], [{ userId: member.id, roleIds: ['mod'] }]);
  assert.notEqual(accessSignature(store), access, 'a role of one\'s own changes the access signature');
});
