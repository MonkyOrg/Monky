'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const { loadMain } = require('./mainModules.cjs');

const mainRoot = path.resolve(__dirname, '..', 'src', 'main');

function sources(directory = mainRoot) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith('.ts') ? [file] : [];
  });
}

/** The `webPreferences` of every `new BrowserWindow({...})` written in Main. */
function windowPreferences() {
  const found = [];
  for (const file of sources()) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const visit = node => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'BrowserWindow') {
        const options = node.arguments?.[0];
        const property = options && ts.isObjectLiteralExpression(options) && options.properties
          .find(entry => ts.isPropertyAssignment(entry) && entry.name.getText(source) === 'webPreferences');
        found.push({ file: path.relative(mainRoot, file), value: property?.initializer ?? null, source });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test('every Main window with a preload gets it through isolatedWebPreferences, sandboxed (#826)', () => {
  const preloads = new Map();
  for (const { file, value, source } of windowPreferences()) {
    assert.ok(value, `${file} creates a window without webPreferences`);
    if (ts.isCallExpression(value) && value.expression.getText(source) === 'isolatedWebPreferences') {
      const [name] = value.arguments;
      assert.ok(ts.isStringLiteral(name), `${file} names its preload literally`);
      preloads.set(name.text, file);
      continue;
    }
    assert.ok(ts.isObjectLiteralExpression(value), `${file} builds its webPreferences in place`);
    const entries = new Map(value.properties.filter(ts.isPropertyAssignment)
      .map(entry => [entry.name.getText(source), entry.initializer.getText(source)]));
    assert.ok(!entries.has('preload'), `${file} loads a preload outside isolatedWebPreferences`);
    assert.equal(entries.get('sandbox'), 'true', `${file} must keep its window sandboxed`);
    assert.equal(entries.get('contextIsolation'), 'true', `${file} must keep its window isolated`);
  }
  assert.deepEqual(Object.fromEntries(preloads), {
    preload: 'main.ts',
    overlayPreload: 'overlayManager.ts',
    crashRecoveryPreload: 'crashRecovery.ts',
    localPreparationDialog: path.join('localExecution', 'preparationWindow.ts'),
  });
});

test('window options cannot turn the sandbox, isolation or Node integration back off', () => {
  const { isolatedWebPreferences } = loadMain('windowPreferences');
  const preferences = isolatedWebPreferences('preload', {
    sandbox: false, contextIsolation: false, nodeIntegration: true, nodeIntegrationInSubFrames: true, webSecurity: false,
    preload: 'elsewhere.js', backgroundThrottling: false, additionalArguments: ['--monky-prepared-qa'],
  });
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInSubFrames, false);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.preload, path.join(mainRoot, '..', 'preload', 'preload.cjs'), 'the bundle beside the compiled Main');
  assert.equal(preferences.backgroundThrottling, false);
  assert.deepEqual(preferences.additionalArguments, ['--monky-prepared-qa']);
});
