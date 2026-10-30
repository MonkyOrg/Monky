const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const shared = require('@monky/shared');
const { loadPreload } = require('./preloadFixture.cjs');

const mainRoot = path.resolve(__dirname, '..', 'src', 'main');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** The channel a registration names: a literal, a shared constant or a `const` of the same file. */
function channelOf(node, source, constants) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return typeof shared[node.text] === 'string' ? shared[node.text] : constants.get(node.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const group = shared[node.expression.text];
    return group && typeof group[node.name.text] === 'string' ? group[node.name.text] : undefined;
  }
  return undefined;
}

/** Every invoke channel Main answers, wherever it is registered. */
function mainHandlers() {
  const handled = new Set();
  for (const filename of sourceFiles(mainRoot)) {
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const constants = new Map();
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = ts.isSatisfiesExpression(node.initializer) ? node.initializer.expression : node.initializer;
        if (ts.isStringLiteralLike(value)) constants.set(node.name.text, value.text);
      }
      if (ts.isCallExpression(node) && node.arguments.length >= 2) {
        const callee = node.expression.getText(source);
        if (callee === 'handle' || callee.endsWith('.handle')) {
          const channel = channelOf(node.arguments[0], source, constants);
          if (channel) handled.add(channel);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return handled;
}

test('every channel the main window preload invokes has a handler in Main', async () => {
  const handled = mainHandlers();
  const preload = loadPreload();
  const noop = () => {};
  for (const [name, value] of Object.entries(preload.api)) {
    if (name === 'dm' || name === 'botStorage') {
      for (const [member, method] of Object.entries(value)) await method(member.startsWith('on') ? noop : 'fixture');
    } else if (typeof value === 'function') {
      await value(name.startsWith('on') ? noop : undefined);
    }
  }
  const invoked = new Set(preload.invoked.map(([channel]) => channel));
  // Main answers these with `handle` too; they only come from the preload's own work.
  assert.ok(invoked.has(shared.MEDIA_FOLDERS_IPC.adopt) && invoked.has(shared.CRASH_RECOVERY_IPC.ready));
  assert.ok(invoked.size > 150, `the preload was exercised (${invoked.size} channels)`);
  assert.deepEqual([...invoked].filter(channel => !handled.has(channel)), [],
    'a channel without a handler only fails at runtime, with "No handler registered"');
  assert.deepEqual(preload.sent.map(([channel]) => channel), [shared.APP_RENDERER_READY]);
});

test('the preload forwards every argument its channel declares', async () => {
  const preload = loadPreload();
  const last = () => preload.invoked.at(-1);
  await preload.api.openScreenPictureInPicture('0bb2238a-3560-4dc1-bb1c-72b6978aa96a', true, 16 / 9);
  assert.deepEqual(last(), ['screen-pip:open', '0bb2238a-3560-4dc1-bb1c-72b6978aa96a', true, 16 / 9]);
  await preload.api.exportIdentity('password', 'extras', 'history');
  assert.deepEqual(last(), ['identity:export', 'password', 'extras', 'history']);
  await preload.api.saveCsvFile('a,b', 'responses.csv');
  assert.deepEqual(last(), ['app:save-csv-file', 'a,b', 'responses.csv']);
  await preload.api.dm.conversation('peer');
  assert.deepEqual(last(), [shared.DM_IPC.conversation, 'peer', null, undefined]);
  await preload.api.dm.hello(true);
  assert.deepEqual(last(), [shared.DM_IPC.hello, true, true]);
});
