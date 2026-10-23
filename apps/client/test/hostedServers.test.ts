import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionStore, DEFAULT_FOLDER_COLOR, type CreatedServer } from '../src/renderer/stores/connectionStore';

function withStorage(values: Record<string, unknown>, run: (storage: Map<string, string>) => void): void {
  const map = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
  const storage: Storage = {
    get length() { return map.size; },
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear(),
    key: index => [...map.keys()][index] ?? null,
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { run(map); } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

const created = (id: string, name: string, port: number, lastStarted: number): CreatedServer => ({
  id, name, port, voiceChannel: 'Geral', textChannel: 'geral', createdAt: lastStarted, lastStarted,
});

test('servers created on the same port are separated without losing either one', () => {
  withStorage({
    monky_created_servers: [created('created-old', 'Antigo', 3000, 1), created('created-new', 'Novo', 3000, 2)],
    monky_saved_servers: [
      { host: '127.0.0.1', port: 3000, name: 'Antigo', lastConnected: 5 },
      { host: 'localhost', port: 3001, name: 'Outro local', lastConnected: 4 },
    ],
  }, (storage) => {
    const store = new ConnectionStore();
    const byId = new Map(store.createdServers.map(server => [server.id, server.port]));
    assert.equal(byId.get('created-new'), 3000, 'the server started last keeps its port');
    assert.equal(byId.get('created-old'), 3002, 'the other one moves past ports used by any local server');
    const persisted = JSON.parse(storage.get('monky_created_servers') ?? '[]') as CreatedServer[];
    assert.deepEqual(persisted.map(server => [server.id, server.port]), [['created-new', 3000], ['created-old', 3002]]);
    const local = store.savedServers.filter(server => server.host === '127.0.0.1').map(server => [server.port, server.name]);
    assert.deepEqual(local.sort(), [[3000, 'Novo'], [3002, 'Antigo']], 'each server gets its own entry on the rail');
    assert.equal(store.nextFreeLocalPort(), 3003);
    assert.equal(store.createdServerOnPort(3002)?.id, 'created-old');
    assert.equal(store.createdServerOnPort(3002, 'created-old'), undefined, 'a server never conflicts with itself');
  });
});

test('servers are grouped into folders Discord-style and folders give way below two servers', () => {
  const saved = (port: number) => ({ host: 'srv.test', port, name: `S${port}`, lastConnected: 10_000 - port });
  withStorage({
    monky_saved_servers: [saved(1), saved(2), saved(3)].map(server => ({ ...server, port: server.port + 4000 })),
    monky_rail_layout: [
      { type: 'folder', id: 'legacy-empty', name: 'Old', collapsed: false, children: [] },
      { type: 'folder', id: 'bad-color', name: 'x'.repeat(300), color: 'red', collapsed: true, children: [
        { type: 'server', host: 'srv.test', port: 4001 }, { type: 'server', host: 'srv.test', port: 4002 },
      ] },
    ],
  }, () => {
    const store = new ConnectionStore();
    const shape = () => store.railLayout.map(node => node.type === 'server' ? node.port : node.children.map(child => child.port));
    assert.deepEqual(shape(), [[4001, 4002], 4003], 'a legacy empty folder disappears');
    const legacy = store.findFolder('bad-color');
    assert.equal(legacy?.color, undefined, 'an invalid stored colour is dropped');
    assert.equal(legacy?.name.length, 100);

    store.updateFolder('bad-color', { name: '  Amigos ', color: '#E91E63' });
    assert.equal(store.findFolder('bad-color')?.name, 'Amigos');
    assert.equal(store.findFolder('bad-color')?.color, '#e91e63');
    store.updateFolder('bad-color', { color: 'javascript:alert(1)' });
    assert.equal(store.findFolder('bad-color')?.color, '#e91e63', 'only #rrggbb colours are accepted');
    store.updateFolder('bad-color', { color: DEFAULT_FOLDER_COLOR });
    assert.equal(store.findFolder('bad-color')?.color, undefined, 'the default colour is not stored');

    store.moveServerToFolder('srv.test', 4001, null, 0);
    assert.deepEqual(shape(), [4001, 4002, 4003], 'a folder left with one server dissolves into it');

    const id = store.groupServers({ host: 'srv.test', port: 4003 }, { host: 'srv.test', port: 4001 });
    assert.ok(id);
    assert.deepEqual(shape(), [4002, [4003, 4001]], 'dropping on a loose server makes a folder in its place');
    assert.equal(store.findFolder(id ?? '')?.name, '', 'new folders start unnamed');
    assert.equal(store.groupServers({ host: 'srv.test', port: 4001 }, { host: 'srv.test', port: 4002 }), id);
    assert.deepEqual(shape(), [[4003, 4001, 4002]], 'dropping on a server inside a folder joins that folder after it');
    assert.equal(store.groupServers({ host: 'srv.test', port: 4001 }, { host: 'srv.test', port: 4001 }), null);

    store.collapseAllFolders();
    assert.ok(store.railLayout.every(node => node.type !== 'folder' || node.collapsed));
    store.deleteFolder(id ?? '');
    assert.deepEqual(shape(), [4003, 4001, 4002], 'ungrouping keeps the order');
  });
});
