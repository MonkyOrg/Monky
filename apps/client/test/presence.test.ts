import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageType, type CustomStatus, type UserSummary } from '@monky/shared';
import { createServerStore } from '../src/renderer/stores/serverStore';
import { currentPresenceStatus, SessionManager } from '../src/renderer/core/SessionManager';
import { EventBus } from '../src/renderer/core/EventBus';
import { settingsStore } from '../src/renderer/stores/settingsStore';

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

test('presence status is one choice: BRB only reaches servers that negotiated it and invisible clears it', (t) => {
  const manager = new SessionManager();
  const modern = manager.create('modern', 1000, 'Self');
  const legacy = manager.create('legacy', 1001, 'Self');
  for (const session of manager.getAll()) session.serverStore.currentUser = { ...self };
  modern.serverStore.serverDetails = { id: 'm', name: 'Modern', createdAt: 1, maxUsers: 10, channels: [], voiceStates: {}, members: [],
    protocol: { version: 40, minimumVersion: 35, features: ['user-brb'] } };
  legacy.serverStore.serverDetails = { id: 'l', name: 'Legacy', createdAt: 1, maxUsers: 10, channels: [], voiceStates: {}, members: [],
    protocol: { version: 40, minimumVersion: 35, features: [] } };
  for (const session of manager.getAll()) t.mock.method(session.client, 'getStatus', () => 'CONNECTED');
  const [modernSent, legacySent] = manager.getAll().map((session) => t.mock.method(session.client, 'send', () => {}));
  const previous = { appearOffline: settingsStore.appearOffline, brb: settingsStore.brb };
  t.mock.method(settingsStore, 'save', () => {});
  t.after(() => Object.assign(settingsStore, previous));
  settingsStore.appearOffline = false;
  settingsStore.brb = false;

  manager.setPresenceStatus('brb');
  assert.equal(currentPresenceStatus(), 'brb');
  assert.deepEqual(modernSent.mock.calls.map((call) => call.arguments), [[MessageType.USER_UPDATE_BRB, { brb: true }]]);
  assert.equal(legacySent.mock.callCount(), 0, 'a server without user-brb would answer with an error');

  manager.setPresenceStatus('brb');
  assert.equal(modernSent.mock.callCount(), 1, 'choosing the current status sends nothing');

  manager.setPresenceStatus('invisible');
  assert.equal(currentPresenceStatus(), 'invisible');
  assert.equal(settingsStore.brb, false);
  assert.deepEqual(modernSent.mock.calls.slice(1).map((call) => call.arguments), [
    [MessageType.USER_UPDATE_BRB, { brb: false }],
    [MessageType.USER_UPDATE_VISIBILITY, { appearOffline: true }],
  ]);
  assert.deepEqual(legacySent.mock.calls.map((call) => call.arguments), [[MessageType.USER_UPDATE_VISIBILITY, { appearOffline: true }]]);

  manager.setPresenceStatus('online');
  assert.equal(currentPresenceStatus(), 'online');
});

test('the custom status is a fourth choice: saved, published where negotiated and replaced by any other', (t) => {
  const manager = new SessionManager();
  const modern = manager.create('modern', 1000, 'Self');
  const legacy = manager.create('legacy', 1001, 'Self');
  for (const session of manager.getAll()) session.serverStore.currentUser = { ...self };
  modern.serverStore.serverDetails = { id: 'm', name: 'Modern', createdAt: 1, maxUsers: 10, channels: [], voiceStates: {}, members: [],
    protocol: { version: 40, minimumVersion: 35, features: ['user-brb', 'custom-status'] } };
  legacy.serverStore.serverDetails = { id: 'l', name: 'Legacy', createdAt: 1, maxUsers: 10, channels: [], voiceStates: {}, members: [],
    protocol: { version: 40, minimumVersion: 35, features: ['user-brb'] } };
  for (const session of manager.getAll()) t.mock.method(session.client, 'getStatus', () => 'CONNECTED');
  const [modernSent, legacySent] = manager.getAll().map((session) => t.mock.method(session.client, 'send', () => {}));
  const previous = {
    appearOffline: settingsStore.appearOffline, brb: settingsStore.brb,
    customStatus: settingsStore.customStatus, customStatusActive: settingsStore.customStatusActive,
  };
  t.mock.method(settingsStore, 'save', () => {});
  t.after(() => Object.assign(settingsStore, previous));
  Object.assign(settingsStore, { appearOffline: false, brb: false, customStatus: null, customStatusActive: false });
  const sentBy = (sent: typeof modernSent) => sent.mock.calls.map((call) => call.arguments);

  manager.setPresenceStatus('custom');
  assert.equal(currentPresenceStatus(), 'online', 'nothing to show before a custom status is saved');

  const lunch: CustomStatus = { text: 'Almoçando', emoji: '🍔', color: '#22aa66', showEmoji: true, showTag: true };
  manager.saveCustomStatus(lunch);
  assert.equal(currentPresenceStatus(), 'custom');
  assert.deepEqual(sentBy(modernSent), [[MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: lunch }]]);

  const edited = { ...lunch, text: 'Volto às 14h' };
  manager.saveCustomStatus(edited);
  assert.deepEqual(sentBy(modernSent).at(-1), [MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: edited }],
    'editing the current status republishes it');

  manager.setPresenceStatus('brb');
  assert.equal(currentPresenceStatus(), 'brb');
  assert.equal(settingsStore.customStatusActive, false);
  assert.deepEqual(settingsStore.customStatus, edited, 'the definition is kept to be picked again');
  assert.deepEqual(sentBy(modernSent).at(-1), [MessageType.USER_UPDATE_BRB, { brb: true }],
    'one message: the server ends the custom status itself');

  manager.setPresenceStatus('custom');
  assert.deepEqual(sentBy(modernSent).at(-1), [MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: edited }]);
  assert.ok(!sentBy(legacySent).some(([type]) => type === MessageType.USER_UPDATE_CUSTOM_STATUS),
    'a server without custom-status would answer with an error');

  manager.setPresenceStatus('online');
  assert.deepEqual(sentBy(modernSent).at(-1), [MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: null }]);

  manager.setPresenceStatus('custom');
  manager.saveCustomStatus(null);
  assert.equal(currentPresenceStatus(), 'online');
  assert.equal(settingsStore.customStatus, null);
  assert.deepEqual(sentBy(modernSent).at(-1), [MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: null }],
    'deleting the current status clears it everywhere');
});
