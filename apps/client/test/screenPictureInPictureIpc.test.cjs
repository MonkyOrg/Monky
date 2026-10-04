const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

test('automatic PiP grants activation only to an owned live video in the main frame', async () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipcHandlers.ts'), 'utf8');
  const start = file.indexOf('const isWindowAway =');
  const end = file.indexOf("ipcMain.handle('window:minimize'", start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(file.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const requestId = '0bb2238a-3560-4dc1-bb1c-72b6978aa96a';
  let focused = true, minimized = false, visible = true, destroyed = false, handler, grants = 0, opens = 0;
  const events = new Map(), notifications = [], handlers = new Map();
  class MediaStream {
    getVideoTracks() { return [{ readyState: 'live' }]; }
  }
  class HTMLVideoElement {
    readyState = 2;
    srcObject = new MediaStream();
    async requestPictureInPicture() { opens++; }
  }
  const video = new HTMLVideoElement();
  let available = true;
  const mainWindow = {
    isDestroyed: () => destroyed, isFocused: () => focused, isMinimized: () => minimized, isVisible: () => visible,
    on: (name, callback) => events.set(name, callback),
    webContents: {
      isDestroyed: () => destroyed,
      send: name => notifications.push(name),
      mainFrame: {},
      executeJavaScript: async (source, activation) => {
        assert.equal(activation, true);
        grants++;
        return vm.runInNewContext(source, {
          HTMLVideoElement, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, MediaStream,
          document: { querySelector: selector => {
            assert.equal(selector, `video[data-monky-screen-pip="${requestId}"]`);
            return available ? video : null;
          } },
        });
      },
    },
  };
  vm.runInNewContext(code, { mainWindow, ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } });
  assert.deepEqual([...handlers.keys()], ['screen-pip:open', 'screen-pip:return']);
  handler = handlers.get('screen-pip:open');
  const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  assert.equal(events.has('blur'), false, 'Losing focus is never a reason for automatic PiP');
  focused = false;
  events.get('focus')();
  assert.deepEqual(notifications, [], 'A visible, unfocused window is still on screen');
  minimized = true;
  events.get('minimize')();
  events.get('hide')();
  assert.deepEqual(notifications, ['window:inactive'], 'Minimize and hide are one inactive period');
  focused = true;
  events.get('focus')();
  assert.equal(notifications.length, 1, 'Minimized windows never announce a visible stage return');
  minimized = false;
  events.get('restore')();
  events.get('show')();
  assert.deepEqual(notifications, ['window:inactive', 'window:active'], 'Restore and show are one return');
  visible = false;
  events.get('hide')();
  assert.deepEqual(notifications, ['window:inactive', 'window:active', 'window:inactive'], 'Hiding to the tray leaves the screen');
  visible = true;
  events.get('show')();
  assert.equal(notifications.length, 4);
  assert.equal(await handler(event, requestId, true), false, 'A focused window is not away');
  focused = false;
  assert.equal(await handler(event, requestId, true), false, 'Alt+Tab keeps the window on screen');
  assert.equal(grants, 0);
  minimized = true;
  assert.equal(await handler(event, requestId, true), true);
  minimized = false; visible = false;
  assert.equal(await handler(event, requestId, true), true);
  visible = true; focused = true;
  assert.equal(await handler(event, requestId, false), true, 'Navigation works while the app remains focused');
  assert.equal(opens, 3);
  const validGrants = grants;
  for (const [sender, token, inactive] of [
    [{ ...event, sender: {} }, requestId, false],
    [{ ...event, senderFrame: {} }, requestId, false],
    [event, 'invalid"); alert(1)', false],
    [event, requestId, 'false'],
  ]) await assert.rejects(handler(sender, token, inactive), /Invalid screen/);
  destroyed = true;
  events.get('minimize')();
  events.get('restore')();
  assert.equal(notifications.length, 4, 'Destroyed windows never send activity notifications');
  await assert.rejects(handler(event, requestId, false), /Invalid screen/);
  assert.equal(grants, validGrants, 'Invalid requests never execute renderer JavaScript');
  destroyed = false; available = false;
  await assert.rejects(handler(event, requestId, false), /no longer available/);
  available = true; video.readyState = 0;
  await assert.rejects(handler(event, requestId, false), /no longer available/);
  video.readyState = 2; video.srcObject.getVideoTracks = () => [{ readyState: 'ended' }];
  await assert.rejects(handler(event, requestId, false), /no longer available/);
  assert.equal(opens, 3, 'Stale or ended presentations never open');
});

test('PiP back to tab restores, shows and focuses only the owning main window', async () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipcHandlers.ts'), 'utf8');
  const start = file.indexOf('const isWindowAway =');
  const end = file.indexOf("ipcMain.handle('window:minimize'", start);
  const code = ts.transpileModule(file.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let minimized = true, visible = true, focused = false, destroyed = false;
  const calls = [], handlers = new Map();
  const mainWindow = {
    isDestroyed: () => destroyed, isMinimized: () => minimized, isVisible: () => visible, isFocused: () => focused,
    on: () => {},
    restore: () => { calls.push('restore'); minimized = false; },
    show: () => { calls.push('show'); visible = true; },
    focus: () => { calls.push('focus'); focused = true; },
    webContents: { isDestroyed: () => destroyed, send: () => {}, mainFrame: {} },
  };
  vm.runInNewContext(code, { mainWindow, ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } });
  const returnToMonky = handlers.get('screen-pip:return');
  const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  await returnToMonky(event);
  assert.deepEqual(calls, ['restore', 'focus'], 'A minimized window is restored and focused');
  minimized = false; visible = false; focused = false; calls.length = 0;
  await returnToMonky(event);
  assert.deepEqual(calls, ['show', 'focus'], 'A window hidden in the tray is shown and focused');
  calls.length = 0;
  await returnToMonky(event);
  assert.deepEqual(calls, ['focus'], 'A visible window is only focused');
  calls.length = 0;
  for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: {} }]) {
    assert.throws(() => returnToMonky(invalid), /Invalid screen/);
  }
  destroyed = true;
  assert.throws(() => returnToMonky(event), /Invalid screen/);
  assert.deepEqual(calls, [], 'Foreign frames or a destroyed window never move the main window');
});
