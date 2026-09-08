import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserSummary } from '@monky/shared';
import { createServerStore } from '../src/renderer/stores/serverStore';
import { SessionManager } from '../src/renderer/core/SessionManager';
import { EventBus } from '../src/renderer/core/EventBus';

const self: UserSummary = {
  id: 'self', clientId: 'identity', nickname: 'Self', status: 'ONLINE', joinedAt: 1,
  sessionId: 'self:device', invisible: false,
};
const other: UserSummary = {
  id: 'other', clientId: 'other-identity', nickname: 'Other', status: 'ONLINE', joinedAt: 1,
};

function seededStore(invisible = false) {
  const store = createServerStore();
  store.bus = new EventBus();
  const current = { ...self, invisible };
  store.setServerDetails({
    id: 'server', name: 'Presence', createdAt: 1, maxUsers: 10, channels: [], voiceStates: {},
    members: [current, { ...other }],
  }, current);
  return store;
}

test('self is in the offline section when invisible without mutating the live connection status', () => {
  const store = seededStore();
  store.updateCurrentUser({ ...self, invisible: true });
  const members = store.getAllMembersInDisplayOrder();
  assert.deepEqual(members.map((member) => member.id), ['other', 'self']);
  assert.equal(members[1].status, 'DISCONNECTED');
  assert.equal(members[1].invisible, true);
  assert.equal(store.currentUser?.status, 'ONLINE');
  assert.equal(store.currentUser?.sessionId, 'self:device');
  store.updateCurrentUser({ ...self, invisible: false });
  assert.equal(store.getAllMembersInDisplayOrder().find((member) => member.id === 'self')?.status, 'ONLINE');
});

test('connecting already invisible renders self offline immediately', () => {
  const store = seededStore(true);
  assert.equal(store.getAllMembersInDisplayOrder().find((member) => member.id === self.id)?.status, 'DISCONNECTED');
  assert.equal(store.currentUser?.invisible, true);
});

test('masked profile updates keep members offline while preserving refreshed names', () => {
  const store = seededStore();
  store.updateMember({ ...other, status: 'DISCONNECTED', nickname: 'Updated privately' });
  assert.equal(store.serverDetails?.members.some((member) => member.id === other.id), false);
  assert.equal(store.getAllMembersInDisplayOrder().find((member) => member.id === other.id)?.status, 'DISCONNECTED');
  assert.equal(store.knownMembers.get(other.id)?.nickname, 'Updated privately');
  store.updateMember({ ...other, status: 'ONLINE' });
  assert.equal(store.serverDetails?.members.some((member) => member.id === other.id), true);
});

test('visibility is applied to every authenticated server, not just the foreground', (t) => {
  const manager = new SessionManager();
  const foreground = manager.create('foreground', 1000, 'Self');
  const background = manager.create('background', 1001, 'Self');
  const disconnected = manager.create('disconnected', 1002, 'Self');
  for (const session of manager.getAll()) session.serverStore.currentUser = { ...self };
  t.mock.method(foreground.client, 'getStatus', () => 'CONNECTED');
  t.mock.method(background.client, 'getStatus', () => 'CONNECTED');
  t.mock.method(disconnected.client, 'getStatus', () => 'DISCONNECTED');
  const sent = manager.getAll().map((session) => t.mock.method(session.client, 'send', () => {}));
  manager.setAppearOffline(true);
  assert.equal(sent[0].mock.callCount(), 1);
  assert.equal(sent[1].mock.callCount(), 1);
  assert.equal(sent[2].mock.callCount(), 0);
  assert.deepEqual(sent[0].mock.calls[0].arguments[1], { appearOffline: true });
  assert.ok(manager.getAll().every((session) => session.serverStore.currentUser?.invisible));
  manager.setAppearOffline(false);
  assert.ok(manager.getAll().every((session) => session.serverStore.currentUser?.invisible === false));
});
