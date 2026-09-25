const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');

test('native editing commands are restricted to the owning main frame, validated and removed on teardown', () => {
  const handlers = new Map();
  const calls = [];
  const frame = {};
  let destroyed = false;
  const contents = { mainFrame: frame, isDestroyed: () => destroyed };
  for (const command of shared.EDITOR_COMMANDS) contents[command] = () => calls.push(command);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'editorCommands.ts'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const warnings = [];
  vm.runInNewContext(output, {
    exports, console: { warn: message => warnings.push(message) },
    require: name => {
      if (name === '@monky/shared') return shared;
      if (name === 'electron') return { ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: channel => handlers.delete(channel),
      } };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const dispose = exports.setupEditorCommands({ webContents: contents });
  const handler = handlers.get(shared.EDITOR_COMMAND_IPC);
  const event = { sender: contents, senderFrame: frame };
  for (const command of shared.EDITOR_COMMANDS) assert.equal(handler(event, command).success, true);
  assert.deepEqual(calls, [...shared.EDITOR_COMMANDS]);
  for (const value of ['executeJavaScript', 'loadURL', undefined, null, {}, 1]) assert.equal(handler(event, value).success, false);
  assert.equal(handler({ ...event, sender: {} }, 'paste').success, false);
  assert.equal(handler({ ...event, senderFrame: {} }, 'copy').success, false);
  destroyed = true;
  assert.equal(handler(event, 'selectAll').success, false);
  assert.equal(calls.length, shared.EDITOR_COMMANDS.length);
  assert.equal(warnings.length, 9);
  dispose();
  assert.equal(handlers.size, 0);
});
