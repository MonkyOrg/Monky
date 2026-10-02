const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

test('automatic PiP grants activation only to an owned live video in the main frame', async () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipcHandlers.ts'), 'utf8');
  const start = file.indexOf('let screenPipWindowInactive =');
  const end = file.indexOf("ipcMain.handle('window:minimize'", start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(file.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const requestId = '0bb2238a-3560-4dc1-bb1c-72b6978aa96a';
  let focused = true, minimized = false, destroyed = false, handler, grants = 0, opens = 0;
  const events = new Map(), notifications = [];
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
    isDestroyed: () => destroyed, isFocused: () => focused, isMinimized: () => minimized,
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
  vm.runInNewContext(code, { mainWindow, ipcMain: { handle: (channel, callback) => {
    assert.equal(channel, 'screen-pip:open'); handler = callback;
  } } });
  const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  events.get('blur')();
  assert.deepEqual(notifications, [], 'Blur cannot announce inactivity while the native window is still focused');
  focused = false;
  events.get('blur')();
  minimized = true;
  events.get('minimize')();
  assert.deepEqual(notifications, ['window:inactive'], 'Blur and minimize are one inactive period');
  focused = true;
  events.get('focus')();
  assert.equal(notifications.length, 1, 'Minimized windows never announce a visible stage return');
  minimized = false;
  events.get('restore')();
  events.get('focus')();
  assert.deepEqual(notifications, ['window:inactive', 'window:active'], 'Restore and focus are one return');
  assert.equal(await handler(event, requestId, true), false, 'DOM blur inside a focused app is not Alt+Tab');
  assert.equal(grants, 0);
  focused = false;
  assert.equal(await handler(event, requestId, true), true);
  focused = true; minimized = true;
  assert.equal(await handler(event, requestId, true), true);
  minimized = false;
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
  events.get('blur')();
  events.get('focus')();
  assert.equal(notifications.length, 2, 'Destroyed windows never send activity notifications');
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
