'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const shared = require('@monky/shared');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');

const quiet = { console: { ...console, warn: () => {}, error: () => {} } };

function fixture({ identity = true } = {}) {
  const calls = [];
  let flushed = 0;
  let options = null;
  class DmError extends Error {
    constructor(code, message) { super(message); this.code = code; this.details = {}; }
  }
  class DmService {
    constructor(value) { options = value; }
    snapshot() { calls.push(['snapshot']); return { friends: [] }; }
    getConversation(...args) { calls.push(['conversation', ...args]); return { messages: [] }; }
    ingest(item) { calls.push(['ingest', item]); return { sent: [] }; }
    removeFriend(peer) { calls.push(['remove', peer]); throw new DmError('not-found', 'No such friend'); }
    block() { throw new Error('modeled disk failure'); }
    flush() { flushed++; }
  }
  const { registerDmIpc } = loadMain('dm/dmIpc', {
    globals: quiet,
    packages: { electron: { app: { getPath: () => 'C:\\modeled-profile' }, dialog: {} } },
    local: {
      identityService: { createDmKeyring: () => identity ? { identityPublicKey: Buffer.alloc(32, 7) } : null },
      'dm/dmService': { DmService, DmError },
    },
  });
  const { IpcRegistry } = loadMain('ipc/registry', { globals: quiet });
  const ipc = fakeIpcMain();
  const sent = [];
  const contents = { mainFrame: {}, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const registry = new IpcRegistry(ipc, { main: () => contents, overlay: () => null });
  registerDmIpc(registry, { webContents: contents, isDestroyed: () => false }, name => name);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const call = (channel, ...args) => ipc.handlers.get(channel)(event, ...args);
  return { ipc, registry, call, calls, sent, contents, options: () => options, flushed: () => flushed };
}

test('every DM channel answers the main window as data, and anyone else with forbidden', async () => {
  const f = fixture();
  const channels = Object.values(shared.DM_IPC);
  assert.deepEqual([...f.ipc.handlers.keys()].sort(), [...channels].sort(), 'One handler per DM channel');
  for (const channel of channels) {
    const refused = await f.ipc.handlers.get(channel)({ sender: f.contents, senderFrame: {} }, 'peer');
    assert.deepEqual(refused, { ok: false, error: { code: 'forbidden', message: 'Forbidden', details: {} } }, channel);
  }
  assert.deepEqual(f.calls, [], 'A refused frame never reaches the store');
  assert.deepEqual(await f.call(shared.DM_IPC.snapshot), { ok: true, value: { friends: [] } });
  assert.deepEqual(await f.call(shared.DM_IPC.conversation, 'peer', 42, 'ten'), { ok: true, value: { messages: [] } });
  assert.deepEqual(f.calls.at(-1), ['conversation', 'peer', null, undefined], 'Only well-typed paging arguments reach the store');
  assert.deepEqual(await f.call(shared.DM_IPC.removeFriend, 'peer'),
    { ok: false, error: { code: 'not-found', message: 'No such friend', details: {} } });
  assert.deepEqual(await f.call(shared.DM_IPC.block, 'peer'),
    { ok: false, error: { code: 'unavailable', message: 'modeled disk failure', details: {} } });
});

test('relayed items reach the store only with a kind the server relays', async () => {
  const f = fixture();
  assert.deepEqual(await f.call(shared.DM_IPC.ingest, { from: 'peer', kind: 'unknown', data: 'x' }), { ok: true, value: {} });
  assert.equal(f.calls.length, 0);
  await f.call(shared.DM_IPC.ingest, { from: 'peer', kind: 'envelope', data: 'x' });
  assert.deepEqual(f.calls, [['ingest', { from: 'peer', kind: 'envelope', data: 'x' }]]);
});

test('without an identity the store is unavailable, and events and disposal follow the window', async () => {
  const none = fixture({ identity: false });
  assert.deepEqual(await none.call(shared.DM_IPC.snapshot),
    { ok: false, error: { code: 'unavailable', message: 'No identity', details: {} } });
  const f = fixture();
  await f.call(shared.DM_IPC.snapshot);
  f.options().onEvent({ type: 'changed' });
  assert.deepEqual(f.sent, [[shared.DM_EVENT, { type: 'changed' }]]);
  f.registry.dispose();
  assert.equal(f.ipc.handlers.size, 0);
  assert.equal(f.flushed(), 1, 'Disposal writes what the store still holds');
  f.options().onEvent({ type: 'late' });
  assert.equal(f.sent.length, 1, 'A disposed window receives no DM events');
});
