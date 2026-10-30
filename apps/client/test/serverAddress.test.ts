import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionKeyFor } from '../src/renderer/core/SessionManager';
import { ConnectionStore } from '../src/renderer/stores/connectionStore';
import { savedServerFavoriteKey } from '../src/renderer/stores/favoritesStore';
import { settingsStore } from '../src/renderer/stores/settingsStore';
import { toAbsoluteServerIconUrl } from '../src/renderer/utils/avatar';
import { captureHostedServerLeaveState } from '../src/renderer/utils/hostedServer';
import {
  isLoopbackHost, normalizeHost, parseServerUrl, sameServerAddress, serverAddressKey, toHttpBase, toWsUrl,
} from '../src/renderer/utils/serverAddress';

function withGlobal(name: 'localStorage' | 'window', value: unknown, run: () => void | Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  const restore = () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  };
  return Promise.resolve().then(run).finally(restore);
}

function storageWith(values: Record<string, unknown>): Storage {
  const map = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    get length() { return map.size; },
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear(),
    key: index => [...map.keys()][index] ?? null,
  };
}

test('every spelling of an address gives the key that favorites and automatic entry already persist', () => {
  const spellings = [
    ['example.test', ' Example.TEST ', 'ws://example.test', 'WSS://EXAMPLE.test'],
    ['::1', '[::1]', ' ws://[::1] ', 'WS://[::1]'],
    ['127.0.0.1', ' 127.0.0.1', 'wss://127.0.0.1'],
  ];
  for (const group of spellings) {
    const keys = group.map(host => serverAddressKey({ host, port: 3000 }));
    assert.equal(new Set(keys).size, 1, `${group.join(' | ')} are the same server`);
    assert.equal(keys[0], JSON.stringify([normalizeHost(group[0]), 3000]), 'the persisted format never changes');
    assert.deepEqual(group.map(host => savedServerFavoriteKey({ host, port: 3000 })), keys);
    assert.ok(group.every(host => sameServerAddress({ host, port: 3000 }, { host: group[0], port: 3000 })));
  }
  assert.notEqual(serverAddressKey({ host: 'example.test', port: 3000 }), serverAddressKey({ host: 'example.test', port: 3001 }));
  assert.equal(sameServerAddress({ host: 'example.test', port: 3000 }, { host: 'example.test', port: 3001 }), false);
});

test('the loopback list is one and accepts IPv6 with or without brackets', () => {
  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', 'ws://[::1]', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['example.test', '192.168.0.2', '[::2]', '']) assert.equal(isLoopbackHost(host), false, host);
});

test('URLs put IPv6 between brackets, drop schemes and keep the host as typed', () => {
  assert.equal(toWsUrl({ host: '::1', port: 3000 }), 'ws://[::1]:3000');
  assert.equal(toWsUrl({ host: '[::1]', port: 3000 }), 'ws://[::1]:3000');
  assert.equal(toWsUrl({ host: ' WS://Example.test ', port: 3000 }), 'ws://Example.test:3000');
  assert.equal(toHttpBase({ host: 'fe80::1', port: 4000 }), 'http://[fe80::1]:4000');
  assert.equal(toHttpBase({ host: 'http://example.test', port: 4000 }), 'http://example.test:4000');
  assert.equal(toAbsoluteServerIconUrl('::1', 3000, '/avatars/icon.png'), 'http://[::1]:3000/avatars/icon.png');
  assert.equal(toAbsoluteServerIconUrl('[::1]', 3000, '/avatars/icon.png'), 'http://[::1]:3000/avatars/icon.png');
  assert.equal(toAbsoluteServerIconUrl('MyHost', 3000, '/avatars/icon.png'), 'http://MyHost:3000/avatars/icon.png');
  for (const url of ['not a url', 'ws://example.test:99999']) assert.equal(parseServerUrl(url), null, url);
  assert.deepEqual(parseServerUrl('ws://[::1]:3000'), { host: '[::1]', port: 3000 });
  assert.deepEqual(parseServerUrl('ws://example.test:3001'), { host: 'example.test', port: 3001 });
  assert.deepEqual(parseServerUrl('wss://example.test'), { host: 'example.test', port: 443 });
});

test('one session key per server, whatever spelling opened it', () => {
  assert.equal(sessionKeyFor('example.test', 5101), 'ws://example.test:5101', 'plain hosts keep their key');
  assert.equal(sessionKeyFor(' WS://Example.TEST ', 5101), 'ws://example.test:5101');
  assert.equal(sessionKeyFor('::1', 3000), 'ws://[::1]:3000');
  assert.equal(sessionKeyFor('[::1]', 3000), 'ws://[::1]:3000');
});

test('saved servers are found by address: an IPv6 or differently typed host still gets its name and icon', async () => {
  const saved = (host: string, port: number, lastConnected: number) => ({ host, port, name: `${host}:${port}`, lastConnected });
  const storage = storageWith({
    monky_saved_servers: [saved('[::1]', 3000, 3), saved('Example.test', 4000, 2), saved('LOCALHOST', 3001, 1)],
    monky_rail_layout: [{ type: 'server', host: 'example.TEST', port: 4000 }],
  });
  await withGlobal('localStorage', storage, () => {
    const store = new ConnectionStore();
    store.updateSavedServerMeta('::1', 3000, { name: 'IPv6', iconUrl: toAbsoluteServerIconUrl('::1', 3000, '/avatars/v6.png') });
    assert.equal(store.findSavedServer({ host: '[::1]', port: 3000 })?.name, 'IPv6');
    assert.equal(store.findSavedServer({ host: '[::1]', port: 3000 })?.iconUrl, 'http://[::1]:3000/avatars/v6.png');

    store.addSavedServer({ host: 'example.test', port: 4000, name: 'Renamed', lastConnected: 10 });
    assert.equal(store.savedServers.filter(server => server.port === 4000).length, 1, 'a new spelling does not duplicate the entry');
    assert.deepEqual(store.getOrderedServers().map(server => server.name), ['Renamed', 'IPv6', 'LOCALHOST:3001'],
      'the rail node keeps pointing at its server');

    assert.equal(store.nextFreeLocalPort(3000), 3002, 'IPv6 and capitalized loopback entries hold their local ports');
    store.removeSavedServer('EXAMPLE.test', 4000);
    assert.equal(store.findSavedServer({ host: 'example.test', port: 4000 }), undefined);
  });
});

test('leaving an empty server hosted on IPv6 loopback still offers to shut it down', async () => {
  const previous = settingsStore.askShutdownOnLastLeave;
  settingsStore.askShutdownOnLastLeave = true;
  const api = {
    hostServerStatus: async () => ({ servers: [{ port: 3000, serverId: 'mine' }] }),
    hostServerStats: async () => ({ serverName: 'Meu servidor', onlineUsers: 1 }),
  };
  try {
    await withGlobal('window', { api }, async () => {
      assert.deepEqual(await captureHostedServerLeaveState('ws://[::1]:3000'), { serverName: 'Meu servidor', port: 3000 });
      assert.equal(await captureHostedServerLeaveState('ws://example.test:3000'), null, 'only this machine hosts');
    });
  } finally {
    settingsStore.askShutdownOnLastLeave = previous;
  }
});
