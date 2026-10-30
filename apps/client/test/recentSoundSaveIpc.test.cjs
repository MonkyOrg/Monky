const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');

test('recent sound save validates audio, supports confirmed overwrite and tears down', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-recent-sound-ipc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ipc = fakeIpcMain();
  const handlers = ipc.handlers;
  const dialogs = [];
  let selection = { canceled: false, filePath: path.join(directory, 'saved.wav') };
  const quiet = { globals: { console: { ...console, warn: () => {} } } };
  const { registerRecentSoundSaveIpc } = loadMain('recentSoundSaveIpc', { ...quiet, packages: { electron: {
    app: { getPath: () => directory },
    dialog: { showSaveDialog: async (_window, options) => { dialogs.push(options); return selection; } },
  } } });
  const { IpcRegistry } = loadMain('ipc/registry', quiet);
  const contents = { mainFrame: {}, isDestroyed: () => false };
  const registry = new IpcRegistry(ipc, { main: () => contents, overlay: () => null });
  const owner = { sender: contents, senderFrame: contents.mainFrame };
  registerRecentSoundSaveIpc(registry, { webContents: contents, isDestroyed: () => false },
    (name) => path.basename(name).replace(/[^\w.-]/g, '_'));
  const handler = handlers.get('app:save-recent-sound');
  assert.equal(typeof handler, 'function');
  const input = {
    fileName: '../QA tone',
    mimeType: 'audio/wav',
    base64: Buffer.from('valid-audio-bytes').toString('base64'),
  };
  // The overlay, a popup or an embedded frame never opens a save dialog for audio it chose.
  for (const intruder of [{ sender: {}, senderFrame: {} }, { sender: contents, senderFrame: {} }]) {
    const refused = await handler(intruder, input);
    assert.equal(refused.success, false);
    assert.equal(refused.error, 'Unavailable sender');
  }
  assert.equal(dialogs.length, 0);
  assert.equal((await handler(owner, input)).success, true);
  assert.equal(fs.readFileSync(selection.filePath, 'utf8'), 'valid-audio-bytes');
  fs.writeFileSync(selection.filePath, 'old');
  assert.equal((await handler(owner, input)).success, true);
  assert.equal(fs.readFileSync(selection.filePath, 'utf8'), 'valid-audio-bytes');
  assert.equal(dialogs[0].defaultPath, path.join(directory, 'QA_tone.wav'));
  assert.equal(dialogs[0].filters[0].extensions.length, 1);
  assert.equal(dialogs[0].filters[0].extensions[0], 'wav');
  selection = { canceled: true };
  assert.equal((await handler(owner, input)).canceled, true);
  const beforeInvalid = dialogs.length;
  assert.equal((await handler(owner, { ...input, mimeType: 'text/html' })).success, false);
  assert.equal((await handler(owner, { ...input, base64: 'not base64' })).success, false);
  assert.equal(dialogs.length, beforeInvalid);
  registry.dispose();
  assert.equal(handlers.size, 0);
});
