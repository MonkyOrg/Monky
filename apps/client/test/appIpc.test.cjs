'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');

const quiet = { console: { ...console, warn: () => {} } };

function fixture() {
  const sockets = [], opened = [];
  class Socket extends EventEmitter {
    constructor() { super(); sockets.push(this); }
    setTimeout() {}
    connect(port, host) {
      this.target = [port, host];
      if (port === undefined) throw new RangeError('modeled invalid port');
      queueMicrotask(() => this.emit('connect'));
    }
    destroy() { this.destroyed = true; }
  }
  const { registerAppIpc } = loadMain('ipc/appIpc', {
    globals: quiet,
    packages: {
      electron: {
        app: { getVersion: () => '9.9.9', getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {} },
        powerMonitor: { getSystemIdleTime: () => 7 },
        shell: { openExternal: async url => { opened.push(url); } },
      },
      'node:net': { Socket },
    },
    local: { i18n: { setMainLanguage() {} }, linkPreview: { fetchLinkPreview: async () => null } },
  });
  const { IpcRegistry } = loadMain('ipc/registry', { globals: quiet });
  const ipc = fakeIpcMain();
  const contents = { mainFrame: {}, isDestroyed: () => false };
  const registry = new IpcRegistry(ipc, { main: () => contents, overlay: () => null });
  registerAppIpc(registry, { steamPresence: { setEnabled() {}, getCurrent: () => null } });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const call = (channel, ...args) => ipc.handlers.get(channel)(event, ...args);
  return { call, sockets, opened, registry, ipc };
}

test('the reachability probe never falls back to this computer when the host is not a name', async () => {
  const f = fixture();
  for (const host of [undefined, null, 42, '', { toString: () => 'localhost' }]) {
    assert.deepEqual(await f.call('net:probe-server', host, 5000), { reachable: false, reason: 'unreachable' });
  }
  assert.equal(f.sockets.length, 0, 'An invalid host opens no socket: without one, Node connects to localhost');
  assert.deepEqual(await f.call('net:probe-server', 'example.test', 5000), { reachable: true, reason: 'online' });
  assert.deepEqual(f.sockets[0].target, [5000, 'example.test']);
  assert.deepEqual(await f.call('net:probe-server', 'example.test', undefined), { reachable: false, reason: 'unreachable' },
    'A port the socket refuses reads as unreachable');
  assert.ok(f.sockets.every(socket => socket.destroyed), 'Every probe closes its socket');
});

test('only plain web links reach the system browser', async () => {
  const f = fixture();
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'javascript:alert(1)', 'not a url', 42]) {
    assert.deepEqual(await f.call('app:open-external', url), { success: false });
  }
  assert.deepEqual(f.opened, []);
  assert.deepEqual(await f.call('app:open-external', 'https://monky.app/docs'), { success: true });
  assert.deepEqual(f.opened, ['https://monky.app/docs']);
  f.registry.dispose();
  assert.equal(f.ipc.handlers.size, 0);
});
