const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const main = path.join(__dirname, '..', 'src', 'main');

function loadIpcSender() {
  const exports = {};
  const output = ts.transpileModule(fs.readFileSync(path.join(main, 'ipcSender.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, { exports, Error }, { filename: 'ipcSender.cjs' });
  return exports;
}

test('privileged handlers run only for the main window top frame', async () => {
  const { mainFrameHandle } = loadIpcSender();
  const handlers = new Map();
  const contents = { mainFrame: { id: 'top' } };
  let destroyed = false;
  const window = {
    isDestroyed: () => destroyed,
    get webContents() {
      if (destroyed) throw new Error('A destroyed window must not be read');
      return contents;
    },
  };
  const handle = mainFrameHandle({ handle: (channel, listener) => handlers.set(channel, listener) }, window);
  const calls = [];
  handle('identity:sign-challenge', (event, nonce) => { calls.push(nonce); return `signed:${nonce}`; });
  const listener = handlers.get('identity:sign-challenge');
  assert.equal(await listener({ sender: contents, senderFrame: contents.mainFrame }, 'abc'), 'signed:abc');
  const overlay = { mainFrame: {} };
  for (const [label, event] of [
    ['overlay window', { sender: overlay, senderFrame: overlay.mainFrame }],
    ['embedded frame', { sender: contents, senderFrame: { id: 'iframe' } }],
    ['detached frame', { sender: contents, senderFrame: null }],
  ]) {
    assert.throws(() => listener(event, 'abc'), /only answers the main window/, label);
  }
  destroyed = true;
  assert.throws(() => listener({ sender: contents, senderFrame: contents.mainFrame }, 'abc'), /only answers the main window/);
  assert.deepEqual(calls, ['abc'], 'Rejected senders never reach the handler');
});

test('identity, backup, hosting, media files, downloads and auto-start are wired through the guard', () => {
  const filename = path.join(main, 'ipcHandlers.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const registrations = new Map();
  let guardFactory = null;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const [channel] = node.arguments;
      if ((callee === 'ipcMain.handle' || callee === 'handleFromMainFrame') && channel) {
        const name = ts.isStringLiteral(channel) ? channel.text : channel.getText(source);
        assert.ok(!registrations.has(name), `${name} is registered once`);
        registrations.set(name, callee);
      }
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleFromMainFrame') {
      guardFactory = node.initializer?.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(guardFactory, 'mainFrameHandle(ipcMain, mainWindow)');
  const sensitive = [
    'identity:has', 'identity:get', 'identity:get-client-id', 'identity:sign-challenge',
    'identity:export', 'identity:import', 'identity:logout',
    'backup:encrypt', 'backup:decrypt', 'backup:save-file', 'backup:open-file',
    'server-host:start', 'server-host:stop', 'server-host:status', 'server-host:logs',
    'server-host:clear-logs', 'server-host:stats', 'server-host:delete-data', 'lan:start', 'lan:stop',
    'soundboard:list-sounds', 'soundboard:read-sound', 'dialog:select-sound-file',
    'stickers:list', 'stickers:read', 'stickers:save', 'dialog:select-stickers-folder',
    'app:download-file', 'app:save-csv-file', 'app:get-auto-start', 'app:set-auto-start',
    'MEDIA_FOLDERS_IPC.adopt',
  ];
  for (const channel of sensitive) {
    assert.equal(registrations.get(channel), 'handleFromMainFrame', `${channel} must only answer the main window`);
  }
});
