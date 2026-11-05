import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionKeyFor } from '../src/renderer/core/SessionManager';
import { ConnectionStore } from '../src/renderer/stores/connectionStore';
import { savedServerFavoriteKey } from '../src/renderer/stores/favoritesStore';
import { settingsStore } from '../src/renderer/stores/settingsStore';
import { toAbsoluteServerIconUrl } from '../src/renderer/utils/avatar';
import { captureHostedServerLeaveState } from '../src/renderer/utils/hostedServer';
import {
  isIpLiteralHost, isLoopbackHost, isSecureServer, normalizeHost, parseServerHostInput, parseServerUrl, sameServerAddress, serverAddressKey,
  setServerTransport, toHttpBase, toWsUrl,
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

test('IP literals are told apart from names resolved by DNS (#883)', () => {
  for (const host of ['147.15.118.243', ' 10.0.0.1 ', '::ffff:93.184.216.34', '[2001:db8::1]', 'wss://[::1]']) {
    assert.equal(isIpLiteralHost(host), true, host);
  }
  for (const host of ['147-15-118-243.sslip.io', 'chat.example', 'localhost', '1.2.3', '']) {
    assert.equal(isIpLiteralHost(host), false, host);
  }
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

test('a typed scheme picks the transport; without one the address stays plain', () => {
  assert.deepEqual(parseServerHostInput(' wss://Monky.example '), { host: 'Monky.example', secure: true });
  assert.deepEqual(parseServerHostInput('HTTPS://monky.example'), { host: 'monky.example', secure: true });
  assert.deepEqual(parseServerHostInput('ws://[::1]'), { host: '[::1]', secure: false });
  assert.deepEqual(parseServerHostInput('http://example.test'), { host: 'example.test', secure: false });
  assert.deepEqual(parseServerHostInput(' 192.168.0.2 '), { host: '192.168.0.2' });
});

test('a server reached over TLS derives wss and https everywhere, under the same session key', () => {
  const server = { host: 'Proxy.Example', port: 443 };
  assert.equal(toWsUrl(server), 'ws://Proxy.Example:443', 'plain until told otherwise');
  setServerTransport({ host: 'proxy.example', port: 443 }, true);
  try {
    assert.equal(isSecureServer(server), true, 'any spelling of the address');
    assert.equal(toWsUrl(server), 'wss://Proxy.Example:443');
    assert.equal(toHttpBase(server), 'https://Proxy.Example:443');
    assert.equal(toAbsoluteServerIconUrl('proxy.example', 443, '/avatars/icon.png'), 'https://proxy.example:443/avatars/icon.png');
    assert.equal(sessionKeyFor('proxy.example', 443), 'ws://proxy.example:443', 'the session key ignores the transport');
    assert.equal(toWsUrl({ ...server, secure: false }), 'ws://Proxy.Example:443', 'an explicit transport wins');
    assert.equal(toWsUrl({ host: 'proxy.example', port: 444 }), 'ws://proxy.example:444', 'another port is another server');
  } finally {
    setServerTransport(server, false);
  }
  assert.equal(toHttpBase(server), 'http://Proxy.Example:443');
});

test('saved servers keep their transport across restarts, edits and removal', async () => {
  const storage = storageWith({
    monky_saved_servers: [
      { host: 'tls.example', port: 443, name: 'TLS', lastConnected: 3, secure: true },
      { host: 'plain.example', port: 3000, name: 'Plain', lastConnected: 2, secure: 'yes' },
    ],
  });
  await withGlobal('localStorage', storage, () => {
    const store = new ConnectionStore();
    try {
      assert.equal(toWsUrl({ host: 'tls.example', port: 443 }), 'wss://tls.example:443', 'loaded saved servers connect over TLS');
      assert.equal(store.findSavedServer({ host: 'plain.example', port: 3000 })?.secure, undefined, 'only true means TLS');
      assert.equal(toWsUrl({ host: 'plain.example', port: 3000 }), 'ws://plain.example:3000');

      // Joined over TLS (typed wss:// or a TLS invitation): saved that way.
      setServerTransport({ host: 'new.example', port: 8443 }, true);
      store.addSavedServer({ host: 'new.example', port: 8443, name: 'New', lastConnected: 4 });
      assert.equal(store.findSavedServer({ host: 'new.example', port: 8443 })?.secure, true);
      assert.equal(JSON.parse(storage.getItem('monky_saved_servers') ?? '[]')[0].secure, true, 'persisted');

      store.updateSavedServer('tls.example', 443, { host: 'tls.example', port: 443, name: 'TLS', lastConnected: 3, secure: false });
      assert.equal(store.findSavedServer({ host: 'tls.example', port: 443 })?.secure, undefined);
      assert.equal(toWsUrl({ host: 'tls.example', port: 443 }), 'ws://tls.example:443', 'editing to plain switches it back');

      store.removeSavedServer('new.example', 8443);
      assert.equal(toWsUrl({ host: 'new.example', port: 8443 }), 'ws://new.example:8443', 'a removed server is forgotten');
    } finally {
      store.clearAccountData();
    }
  });
});
