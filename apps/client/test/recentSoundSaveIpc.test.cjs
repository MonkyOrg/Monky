const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const shared = require('@monky/shared');

test('recent sound save validates audio, supports confirmed overwrite and tears down', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-recent-sound-ipc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map();
  const dialogs = [];
  let selection = { canceled: false, filePath: path.join(directory, 'saved.wav') };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'recentSoundSaveIpc.ts'), 'utf8');
  const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
  const output = ts.transpileModule(source, { compilerOptions }).outputText;
  const senders = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipcSender.ts'), 'utf8'),
    { compilerOptions }).outputText, { exports: senders });
  const exports = {};
  vm.runInNewContext(output, {
    exports, Buffer, console,
    require: (name) => {
      if (name === '@monky/shared') return shared;
      if (name === 'node:fs/promises' || name === 'node:path') return require(name);
      if (name === './ipcSender') return senders;
      if (name === 'electron') return {
        app: { getPath: () => directory },
        dialog: { showSaveDialog: async (_window, options) => { dialogs.push(options); return selection; } },
        ipcMain: {
          handle: (channel, handler) => handlers.set(channel, handler),
          removeHandler: channel => handlers.delete(channel),
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const contents = { mainFrame: {} };
  const owner = { sender: contents, senderFrame: contents.mainFrame };
  const dispose = exports.setupRecentSoundSaveIpc({ webContents: contents, isDestroyed: () => false },
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
  dispose();
  assert.equal(handlers.size, 0);
});
