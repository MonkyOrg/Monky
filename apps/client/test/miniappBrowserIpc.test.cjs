const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');
const { MINIAPP_BROWSER_IPC } = require('@monky/shared');

test('browser IPC admits only owner and trusted toolbar top frames and validates consent before opening', async () => {
  const ipc = fakeIpcMain();
  const page = () => Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false, send() {},
  });
  const main = page(), toolbar = page(), site = page();
  const owner = Object.assign(new EventEmitter(), { webContents: main, isDestroyed: () => false });
  const calls = [];
  class Browsers {
    controls() { return [toolbar]; }
    open(input) { calls.push(['open', input]); }
    control(sender, input) { calls.push(['control', sender, input]); return null; }
    close(id) { calls.push(['close', id]); }
    placement(id, bounds, clip, visible) { calls.push(['placement', id, bounds, clip, visible]); }
    appearance(id, appearance) { calls.push(['appearance', id, appearance]); }
    captureSourceId(id) { calls.push(['capture', id]); return 'scoped-tab-source'; }
    broadcasting(id, active) { calls.push(['broadcasting', id, active]); }
    closeAll() { return Promise.resolve(); }
    dispose() { calls.push(['dispose']); return Promise.resolve(); }
  }
  const { registerMiniappBrowserIpc } = loadMain('ipc/miniappBrowserIpc', {
    packages: { electron: { ipcMain: ipc } },
    local: { miniappBrowserWindows: { MiniappBrowserWindows: Browsers } },
  });
  registerMiniappBrowserIpc(owner);
  const top = sender => ({ sender, senderFrame: sender.mainFrame });
  const open = ipc.handlers.get(MINIAPP_BROWSER_IPC.open);
  const input = { requestId: '00000000-0000-4000-8000-000000000001', serverKey: 'server', botId: 'bot', screenId: 'browser',
    instanceId: 'instance', channelId: 'voice', viewerId: 'alice', viewerSessionId: 'device', policyVersion: 1, title: 'Browser', locale: 'en' };
  for (const event of [top(site), top(toolbar), { sender: main, senderFrame: {} }]) {
    assert.throws(() => open(event, input), /only answers/);
  }
  for (const patch of [{ instanceId: '' }, { policyVersion: 2 }, { url: 'file:///secret' }, { viewerSessionId: '' }]) {
    assert.throws(() => open(top(main), { ...input, ...patch }));
  }
  assert.equal(calls.length, 0);
  await open(top(main), input);
  const control = ipc.handlers.get(MINIAPP_BROWSER_IPC.control);
  for (const event of [top(main), top(site), { sender: toolbar, senderFrame: {} }]) {
    assert.throws(() => control(event, { action: 'back' }), /only answers/);
  }
  assert.throws(() => control(top(toolbar), { action: 'navigate', url: 42 }));
  await control(top(toolbar), { action: 'back' });
  assert.equal(calls[1][1], toolbar);
  const close = ipc.handlers.get(MINIAPP_BROWSER_IPC.owner);
  assert.throws(() => close(top(site), { requestId: input.requestId, action: 'close' }), /only answers/);
  close(top(main), { requestId: input.requestId, action: 'close' });
  assert.deepEqual(calls[2], ['close', input.requestId]);
  const bounds = { x: 10, y: 20, width: 600, height: 400 };
  assert.throws(() => close(top(site), { requestId: input.requestId, action: 'placement', bounds, clip: bounds, visible: true }), /only answers/);
  assert.throws(() => close(top(main), { requestId: input.requestId, action: 'placement', bounds: { ...bounds, width: Infinity }, clip: bounds, visible: true }));
  close(top(main), { requestId: input.requestId, action: 'placement', bounds, clip: bounds, visible: true });
  assert.deepEqual(calls[3], ['placement', input.requestId, bounds, bounds, true]);
  const appearance = { fontFamily: 'Inter, sans-serif', colors: { '--bg-sidebar': '#112233' } };
  assert.throws(() => close(top(site), { requestId: input.requestId, action: 'appearance', appearance }), /only answers/);
  assert.throws(() => close(top(main), { requestId: input.requestId, action: 'appearance',
    appearance: { ...appearance, colors: { '--arbitrary-css': 'url(https://example.com)' } } }));
  close(top(main), { requestId: input.requestId, action: 'appearance', appearance });
  assert.deepEqual(calls[4], ['appearance', input.requestId, appearance]);
  const capture = ipc.handlers.get(MINIAPP_BROWSER_IPC.capture);
  for (const event of [top(site), top(toolbar), { sender: main, senderFrame: {} }])
    assert.throws(() => capture(event, input.requestId), /only answers/);
  assert.throws(() => capture(top(main), 'not-a-request'));
  assert.equal(capture(top(main), input.requestId), 'scoped-tab-source');
  close(top(main), { requestId: input.requestId, action: 'broadcasting', active: true });
  assert.deepEqual(calls[6], ['broadcasting', input.requestId, true]);
  owner.emit('closed');
  assert.equal(ipc.handlers.size, 0);
  assert.deepEqual(calls[7], ['dispose']);
});
