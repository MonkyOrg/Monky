const assert = require('node:assert/strict');
const { test } = require('node:test');
const { nativeEditingCommands, dispatchKey } = require('./fixtures/nativeKeyboard.cjs');

test('native editing resolves Cocoa commands without changing Windows or Linux shortcuts', () => {
  for (const [code, modifiers, commands] of [
    ['KeyZ', 4, ['undo']], ['KeyZ', 12, ['redo']],
    ['KeyC', 4, ['copy']], ['KeyV', 4, ['paste']],
    ['KeyZ', 2, []], ['KeyZ', 0, []], ['KeyC', 12, []], ['Enter', 4, []],
  ]) {
    assert.deepEqual(nativeEditingCommands(code, modifiers, 'darwin'), commands);
    for (const platform of ['win32', 'linux']) {
      assert.deepEqual(nativeEditingCommands(code, modifiers, platform), []);
    }
  }
});

test('all editor suites use paired native events and preserve optional text', async () => {
  const calls = [];
  const window = { webContents: { debugger: { sendCommand: async (method, event) => calls.push({ method, event }) } } };
  await dispatchKey(window, 'z', 'KeyZ', 90, 4);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === 'Input.dispatchKeyEvent'));
  assert.equal(calls[0].event.type, 'rawKeyDown');
  assert.deepEqual(calls[0].event.commands, nativeEditingCommands('KeyZ', 4));
  assert.equal(calls[1].event.type, 'keyUp');
  await dispatchKey(window, 'Enter', 'Enter', 13, 0, '\r');
  assert.equal(calls[2].event.type, 'keyDown');
  assert.equal(calls[2].event.text, '\r');
  assert.equal(calls[2].event.unmodifiedText, '\r');
});
