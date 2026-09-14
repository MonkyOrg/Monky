import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appEvents } from '../src/renderer/core/EventBus';
import { ConnectionStore, connectionStore, type SavedServer } from '../src/renderer/stores/connectionStore';
import { favoritesStore } from '../src/renderer/stores/favoritesStore';
import { SettingsStore, settingsStore } from '../src/renderer/stores/settingsStore';
import { autoEntryServerKey, restoreAutoEntryServerKeys } from '../src/renderer/utils/autoEntry';
import { parseHomeVoicePreview } from '../src/renderer/utils/voicePreview';

function withStorage(run: (storage: Storage) => void): void {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  settingsStore.load(false);
  favoritesStore.load();
  try { run(storage); } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    settingsStore.load(false);
    favoritesStore.load();
    connectionStore.loadSavedServers();
  }
}

const saved = (host = 'example.test', port = 3000, lastConnected = 1): SavedServer =>
  ({ host, port, name: host, lastConnected, password: 'fixture-only' });

test('automatic entry defaults off on fresh, migrated, malformed and subsequently replaced settings', () => {
  withStorage(storage => {
    const server = saved();
    for (const raw of [null, '{}', '{"onboardingCompleted":true}', '{bad', 'null', '[]',
      '{"autoEntryServerKeys":true}', '{"autoEntryServerKeys":{"example.test":true}}']) {
      if (raw === null) storage.removeItem('monky_settings');
      else storage.setItem('monky_settings', raw);
      const settings = new SettingsStore();
      assert.equal(settings.isServerAutoEntryEnabled(server), false);
      assert.deepEqual(settings.autoEntryServerKeys, []);
    }
    const settings = new SettingsStore();
    settings.setServerAutoEntry(server, true);
    storage.setItem('monky_settings', '{}');
    settings.load();
    assert.equal(settings.isServerAutoEntryEnabled(server), false);
    settings.setServerAutoEntry(server, true);
    storage.removeItem('monky_settings');
    settings.load();
    assert.equal(settings.isServerAutoEntryEnabled(server), false);
  });
});

test('only one startup server persists, identified by canonical address rather than name or position', () => {
  withStorage(() => {
    const first = saved(' WSS://Example.TEST ');
    const otherPort = saved('example.test', 4000);
    const settings = new SettingsStore();
    settings.setServerAutoEntry(first, true);
    const renamed = { ...saved(), name: 'Renamed' };
    assert.equal(new SettingsStore().isServerAutoEntryEnabled(renamed), true);
    settings.setServerAutoEntry(otherPort, true);
    const restored = new SettingsStore();
    assert.equal(restored.isServerAutoEntryEnabled(renamed), false);
    assert.equal(restored.isServerAutoEntryEnabled(otherPort), true);
    assert.deepEqual(restored.autoEntryServerKeys, [autoEntryServerKey(otherPort)]);
    restored.setServerAutoEntry(saved(), false);
    assert.equal(new SettingsStore().isServerAutoEntryEnabled(first), false);
    assert.equal(new SettingsStore().isServerAutoEntryEnabled(otherPort), true);
    restored.clearServerAutoEntry();
    assert.deepEqual(new SettingsStore().autoEntryServerKeys, []);
    assert.equal(autoEntryServerKey(saved('[::1]')), autoEntryServerKey(saved('::1')));
  });
});

test('legacy multi-server settings retain only the most recently chosen valid address', () => {
  withStorage(storage => {
    const first = autoEntryServerKey(saved('first.test'));
    const last = autoEntryServerKey(saved('last.test'));
    assert.deepEqual(restoreAutoEntryServerKeys([first, last, null, '{bad']), [last]);
    assert.deepEqual(restoreAutoEntryServerKeys([first, last, first]), [first]);
    storage.setItem('monky_settings', JSON.stringify({ autoEntryServerKeys: [first, last] }));
    const settings = new SettingsStore();
    assert.deepEqual(settings.autoEntryServerKeys, [last]);
    settings.save();
    assert.deepEqual(new SettingsStore().autoEntryServerKeys, [last]);
    settings.retainAutoEntryServers([saved('first.test')]);
    assert.deepEqual(settings.autoEntryServerKeys, [], 'removing the chosen server never revives an older choice');
  });
});

test('invalid endpoints and malformed opt-in keys never become connection targets', () => {
  for (const host of ['', 'http://example.test', 'example.test/path', 'user@example.test', 'a?b', 'a#b', 'a b']) {
    assert.equal(autoEntryServerKey(saved(host)), null, host);
  }
  for (const port of [0, -1, 3000.5, 65536, NaN, Infinity]) assert.equal(autoEntryServerKey(saved('a.test', port)), null);
  const key = autoEntryServerKey(saved());
  assert.deepEqual(restoreAutoEntryServerKeys([null, true, '{bad', '["example.test","3000"]', '["",3000]', key, key]), [key]);
  assert.deepEqual(restoreAutoEntryServerKeys(Array(16).fill(key)), []);
});

test('failed persistence rolls back the switch and never publishes an unsaved preference', () => {
  withStorage(storage => {
    const settings = new SettingsStore();
    let notifications = 0;
    const off = appEvents.on('settings.updated', () => { notifications++; });
    try {
      settings.setServerAutoEntry(saved(), true);
      const previous = storage.getItem('monky_settings');
      storage.setItem = () => { throw new Error('Storage full'); };
      assert.throws(() => settings.setServerAutoEntry(saved(), false), /Storage full/);
      assert.equal(settings.isServerAutoEntryEnabled(saved()), true);
      assert.equal(storage.getItem('monky_settings'), previous);
      assert.equal(notifications, 1);
      assert.throws(() => settings.retainAutoEntryServers([]), /Storage full/);
      assert.equal(settings.isServerAutoEntryEnabled(saved()), true);
      assert.throws(() => settings.setServerAutoEntry(saved('other.test'), true), /Storage full/);
      assert.deepEqual(settings.autoEntryServerKeys, [autoEntryServerKey(saved())]);
      assert.throws(() => settings.clearServerAutoEntry(), /Storage full/);
      assert.equal(settings.isServerAutoEntryEnabled(saved()), true);
    } finally { off(); }
  });
});

test('renames preserve opt-ins, while endpoint edits, removals and the saved-list cap discard them', () => {
  withStorage(() => {
    const connection = new ConnectionStore();
    connection.addSavedServer(saved());
    settingsStore.setServerAutoEntry(saved(), true);
    favoritesStore.toggleServer(saved());
    connection.updateSavedServerMeta('example.test', 3000, { name: 'Renamed', iconUrl: '/avatars/new.png' });
    assert.equal(settingsStore.isServerAutoEntryEnabled(saved()), true);
    favoritesStore.toggleServer(saved());
    assert.equal(settingsStore.isServerAutoEntryEnabled(saved()), true, 'stars and startup preference are independent');
    connection.updateSavedServer('example.test', 3000, saved('other.test'));
    assert.deepEqual(settingsStore.autoEntryServerKeys, [], 'a new endpoint must be explicitly opted in');
    settingsStore.setServerAutoEntry(saved('other.test'), true);
    connection.removeSavedServer('other.test', 3000);
    assert.deepEqual(new SettingsStore().autoEntryServerKeys, []);
    connection.addSavedServer(saved());
    settingsStore.setServerAutoEntry(saved(), true);
    for (let index = 0; index < 15; index++) connection.addSavedServer(saved(`server${index}.test`, 3000, 10 + index));
    assert.equal(connection.savedServers.length, 15);
    assert.equal(settingsStore.isServerAutoEntryEnabled(saved()), false);
  });
});

test('reloading a replaced saved-server list prunes stale preferences without affecting survivors', () => {
  withStorage(storage => {
    const connection = new ConnectionStore();
    const first = saved('one.test');
    const second = saved('two.test');
    connection.addSavedServer(first);
    connection.addSavedServer(second);
    settingsStore.setServerAutoEntry(first, true);
    settingsStore.setServerAutoEntry(second, true);
    storage.setItem('monky_saved_servers', JSON.stringify([second]));
    connection.loadSavedServers();
    assert.equal(settingsStore.isServerAutoEntryEnabled(first), false);
    assert.equal(new SettingsStore().isServerAutoEntryEnabled(second), true);
  });
});

test('authenticated identity survives metadata updates and invalidates opt-in when a server is replaced', () => {
  withStorage(() => {
    const connection = new ConnectionStore();
    const server = { ...saved(), serverId: 'verified-server' };
    connection.addSavedServer(server);
    settingsStore.setServerAutoEntry(server, true);
    connection.addSavedServer({ ...saved(), name: 'Renamed' });
    assert.equal(connection.savedServers[0].serverId, 'verified-server');
    assert.equal(settingsStore.isServerAutoEntryEnabled(server), true);
    connection.addSavedServer({ ...saved(), serverId: 'replacement-server' });
    assert.equal(connection.savedServers[0].serverId, 'replacement-server');
    assert.equal(settingsStore.isServerAutoEntryEnabled(server), false);
    settingsStore.setServerAutoEntry(server, true);
    connection.invalidateSavedServerIdentity(server.host, server.port);
    assert.equal(connection.savedServers[0].serverId, undefined);
    assert.equal(settingsStore.isServerAutoEntryEnabled(server), false);
    connection.rememberSavedServerIdentity(server.host, server.port, 'manually-verified');
    assert.equal(connection.savedServers[0].serverId, 'manually-verified');
    settingsStore.setServerAutoEntry(server, true);
    connection.rememberSavedServerIdentity(server.host, server.port, 'manually-verified-replacement');
    assert.equal(connection.savedServers[0].serverId, 'manually-verified-replacement');
    assert.equal(settingsStore.isServerAutoEntryEnabled(server), false, 'fresh auth can refresh identity but never inherit its opt-in');
    connection.updateSavedServer(server.host, server.port, { ...saved('elsewhere.test'), serverId: 'manually-verified' });
    assert.equal(connection.savedServers[0].serverId, undefined, 'changing the endpoint cannot move verified identity');
  });
});

test('invalid optional identity metadata does not delete an otherwise valid legacy favorite', () => {
  withStorage(storage => {
    for (const serverId of [null, 123, '', {}, 'x'.repeat(257)]) {
      storage.setItem('monky_saved_servers', JSON.stringify([{ ...saved(), serverId }]));
      const connection = new ConnectionStore();
      assert.equal(connection.savedServers.length, 1);
      assert.equal(connection.savedServers[0].serverId, undefined);
      assert.equal(settingsStore.isServerAutoEntryEnabled(connection.savedServers[0]), false);
    }
  });
});

test('Home uses voice occupancy only, with no fallback to online people, devices or status cosmetics', () => {
  const voiceUser = { nickname: 'Same person on two devices', avatarUrl: null };
  const result = parseHomeVoicePreview({
    userCount: 8, users: [{ nickname: 'Not in voice', status: 'ONLINE' }],
    voiceUserCount: 1, voiceUsers: [voiceUser], memberCount: 30, maxUsers: 50,
  });
  assert.deepEqual(result, { count: 1, users: [voiceUser], memberCount: 30, maxUsers: 50 });
  assert.equal(parseHomeVoicePreview({ userCount: 8, users: [voiceUser] }).count, null);
  assert.deepEqual(parseHomeVoicePreview({ userCount: 8, voiceUserCount: 0, voiceUsers: [voiceUser] }).users, []);
  assert.equal(parseHomeVoicePreview({ voiceUserCount: 2, voiceUsers: [] }).count, 2, 'hidden voices count without exposing avatars');
});

test('voice previews reject malformed counts, limit avatars, and keep distinct people with equal nicknames', () => {
  for (const voiceUserCount of [-1, 1.2, NaN, Infinity, '2', null, undefined]) {
    assert.equal(parseHomeVoicePreview({ voiceUserCount, voiceUsers: [{ nickname: 'Online' }] }).count, null);
  }
  const users = Array.from({ length: 8 }, () => ({ nickname: 'Equal name', avatarUrl: '/avatars/fixture.png' }));
  assert.equal(parseHomeVoicePreview({ voiceUserCount: 8, voiceUsers: users }).users.length, 5);
  assert.equal(parseHomeVoicePreview({ voiceUserCount: 2, voiceUsers: users }).users.length, 2);
  assert.deepEqual(parseHomeVoicePreview(null), { count: null, users: [], memberCount: null, maxUsers: null });
});
