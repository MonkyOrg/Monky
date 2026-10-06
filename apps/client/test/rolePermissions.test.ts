import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PERMISSIONS, Permission, type Role, type UserSummary } from '@monky/shared';
import { createServerStore } from '../src/renderer/stores/serverStore';
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
