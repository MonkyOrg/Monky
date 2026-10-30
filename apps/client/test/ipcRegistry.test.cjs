'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');

const logged = { warn: [], error: [] };
const { IpcRegistry, sendEvent, windowContents } = loadMain('ipc/registry', {
  globals: { console: { warn: (...args) => logged.warn.push(args), error: (...args) => logged.error.push(args) } },
});

/** A page with a top frame; `destroy()` makes it behave like an Electron WebContents that is gone. */
function page(name) {
  let destroyed = false;
  const sent = [];
  return {
    name, sent, mainFrame: { name: `${name} top frame` },
    isDestroyed: () => destroyed,
    send: (...args) => {
      if (destroyed) throw new Error('Object has been destroyed');
      sent.push(args);
    },
    destroy: () => { destroyed = true; },
  };
}

function fixture() {
  const ipc = fakeIpcMain();
  const pages = { main: page('main'), overlay: page('overlay') };
  const owners = { main: () => pages.main, overlay: () => pages.overlay };
  const registry = new IpcRegistry(ipc, { main: () => owners.main(), overlay: () => owners.overlay() });
  const top = name => ({ sender: pages[name], senderFrame: pages[name].mainFrame });
  return { ipc, pages, owners, registry, top };
}

test('a channel answers only the top frame of the windows its policy names', async () => {
  const f = fixture();
  const calls = [];
  f.registry.handle('identity:sign-challenge', 'main', (_event, nonce) => { calls.push(nonce); return `signed:${nonce}`; });
  const listener = f.ipc.handlers.get('identity:sign-challenge');
  assert.equal(await listener(f.top('main'), 'abc'), 'signed:abc');
  logged.warn.length = 0;
  for (const [label, event] of [
    ['overlay window', f.top('overlay')],
    ['embedded frame', { sender: f.pages.main, senderFrame: { name: 'iframe' } }],
    ['detached frame', { sender: f.pages.main, senderFrame: null }],
    ['unknown window', { sender: page('popup'), senderFrame: {} }],
  ]) {
    assert.throws(() => listener(event, 'abc'), /'identity:sign-challenge' only answers the main window\./, label);
  }
  f.pages.main.destroy();
  assert.throws(() => listener(f.top('main'), 'abc'), /only answers the main window/, 'A page that is gone is no sender');
  f.owners.main = () => null;
  assert.throws(() => listener({ sender: null, senderFrame: null }, 'abc'), /only answers the main window/);
  assert.deepEqual(calls, ['abc'], 'Refused senders never reach the handler');
  assert.equal(logged.warn.length, 6, 'Every refusal is logged');
  assert.match(String(logged.warn[0][0]), /Refused 'identity:sign-challenge'/);
});

test('the overlay reaches only the channels that name it', () => {
  const f = fixture();
  f.registry.handle('overlay:layout-cards', 'overlay', () => ({ x: 0, y: 0, width: 1, height: 1 }));
  f.registry.handle('overlay:close', ['main', 'overlay'], () => ({ success: true }));
  const layout = f.ipc.handlers.get('overlay:layout-cards');
  const close = f.ipc.handlers.get('overlay:close');
  assert.deepEqual(layout(f.top('overlay'), {}), { x: 0, y: 0, width: 1, height: 1 });
  assert.throws(() => layout(f.top('main'), {}), /'overlay:layout-cards' only answers the overlay\./);
  assert.deepEqual(close(f.top('main')), { success: true });
  assert.deepEqual(close(f.top('overlay')), { success: true });
  // The overlay window is replaced on every open: the policy follows the current one.
  const previous = f.pages.overlay;
  f.pages.overlay = page('overlay 2');
  assert.throws(() => close({ sender: previous, senderFrame: previous.mainFrame }),
    /'overlay:close' only answers the main window or the overlay\./);
  assert.deepEqual(close(f.top('overlay')), { success: true });
});

test('a channel with a result union answers refused senders with its refusal', async () => {
  const f = fixture();
  let ran = false;
  f.registry.handle('soundboard:edit-read', { from: 'main', refused: { status: 'failed', reason: 'invalid_request' } },
    async () => { ran = true; return { status: 'ok', value: new Uint8Array() }; });
  const listener = f.ipc.handlers.get('soundboard:edit-read');
  assert.deepEqual(await listener(f.top('overlay'), {}), { status: 'failed', reason: 'invalid_request' });
  assert.equal(ran, false);
  assert.equal((await listener(f.top('main'), {})).status, 'ok');
});

test('dispose removes every channel and runs the cleanups, so a new window registers them again', () => {
  const f = fixture();
  const order = [];
  f.registry.handle('window:minimize', 'main', () => undefined);
  f.registry.handle('overlay:close', ['main', 'overlay'], () => ({ success: true }));
  f.registry.onDispose(() => order.push('first'));
  f.registry.onDispose(() => { order.push('failing'); throw new Error('modeled cleanup failure'); });
  f.registry.onDispose(() => order.push('last'));
  assert.throws(() => f.registry.handle('window:minimize', 'main', () => undefined), /already registered/);
  logged.error.length = 0;
  f.registry.dispose();
  assert.deepEqual([...f.ipc.handlers.keys()], [], 'Every channel of the registry is removed');
  assert.deepEqual(order, ['last', 'failing', 'first'], 'Cleanups run newest first, and one failure stops none');
  assert.equal(logged.error.length, 1);
  f.registry.dispose();
  assert.equal(order.length, 3, 'Disposing twice runs nothing again');
  assert.equal(f.registry.send('main', 'window:active'), false, 'A disposed registry sends nothing');
  assert.throws(() => f.registry.handle('window:maximize', 'main', () => undefined), /disposed/);
  assert.throws(() => f.registry.onDispose(() => {}), /disposed/);

  const next = new IpcRegistry(f.ipc, { main: () => f.pages.main, overlay: () => null });
  next.handle('window:minimize', 'main', () => undefined);
  next.handle('overlay:close', ['main', 'overlay'], () => ({ success: true }));
  assert.deepEqual([...f.ipc.handlers.keys()], ['window:minimize', 'overlay:close']);
});

test('a scope is disposed on its own or together with its registry', () => {
  const f = fixture();
  f.registry.handle('window:minimize', 'main', () => undefined);
  const scope = f.registry.scope();
  let released = 0;
  scope.handle('native-screen:invoke', 'main', async () => ({ kind: 'ok' }));
  scope.onDispose(() => released++);
  scope.dispose();
  assert.deepEqual([...f.ipc.handlers.keys()], ['window:minimize'], 'Only the scope channels leave');
  assert.equal(released, 1);
  const other = f.registry.scope();
  other.handle('native-screen:reply', 'main', () => undefined);
  other.onDispose(() => released++);
  f.registry.dispose();
  assert.deepEqual([...f.ipc.handlers.keys()], []);
  assert.equal(released, 2, 'The parent disposes the scopes still alive, and only those');
});

test('events reach the current page of a window and are skipped once it is gone', () => {
  const f = fixture();
  assert.equal(f.registry.send('main', 'lan:found', { host: 'h', port: 1, serverName: 's', version: '1' }), true);
  assert.equal(f.registry.send('overlay', 'overlay:resize-state-changed', true), true);
  assert.deepEqual(f.pages.main.sent, [['lan:found', { host: 'h', port: 1, serverName: 's', version: '1' }]]);
  assert.deepEqual(f.pages.overlay.sent, [['overlay:resize-state-changed', true]]);
  f.pages.main.destroy();
  assert.equal(f.registry.send('main', 'window:active'), false, 'A destroyed page never throws "Object has been destroyed"');
  f.owners.overlay = () => null;
  assert.equal(f.registry.send('overlay', 'overlay:close-requested'), false);
  assert.equal(sendEvent(null, 'window:active'), false);
});

test('a destroyed window is never asked for its page', () => {
  let destroyed = false;
  const contents = page('main');
  const window = {
    isDestroyed: () => destroyed,
    get webContents() {
      if (destroyed) throw new Error('Object has been destroyed');
      return contents;
    },
  };
  assert.equal(windowContents(window), contents);
  contents.destroy();
  assert.equal(windowContents(window), null, 'A page that is gone is not returned');
  destroyed = true;
  assert.equal(windowContents(window), null);
  assert.equal(windowContents(null), null);
});
