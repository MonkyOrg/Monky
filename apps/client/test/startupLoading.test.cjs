const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const shared = require('@monky/shared');

const filename = path.resolve(__dirname, '..', 'src', 'preload', 'preload.ts');
const mainRoot = path.resolve(__dirname, '..', 'src', 'main');

/**
 * Packages a TypeScript module loads as soon as it is required, following its
 * relative imports: `import type`, imports of types only and `import()` load nothing.
 */
function eagerPackages(entry) {
  const packages = new Map();
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    for (const statement of source.statements) {
      const declaration = ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
        ? statement : null;
      if (!declaration || !ts.isStringLiteral(declaration.moduleSpecifier)) continue;
      const clause = ts.isImportDeclaration(declaration) ? declaration.importClause : null;
      if (clause?.isTypeOnly || (ts.isExportDeclaration(declaration) && declaration.isTypeOnly)) continue;
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0
        && named.elements.every(element => element.isTypeOnly)) continue;
      const specifier = declaration.moduleSpecifier.text;
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        const resolved = [`${target}.ts`, path.join(target, 'index.ts')].find(candidate => fs.existsSync(candidate));
        if (resolved) visit(resolved);
      } else if (!packages.has(specifier)) {
        packages.set(specifier, path.relative(mainRoot, file));
      }
    }
  };
  visit(entry);
  return packages;
}

test('opening Monky never loads the hosted server, electron-updater or the whole bot SDK into Main', () => {
  const packages = eagerPackages(path.join(mainRoot, 'main.ts'));
  assert.ok(packages.has('@monky/shared') && packages.has('electron'), 'the import graph of main.ts is followed');
  for (const lazy of ['@monky/server', 'electron-updater', '@monky/bot-sdk']) {
    assert.ok(!packages.has(lazy), `${packages.get(lazy)} loads ${lazy} at startup; load it when it is first used`);
  }
});

/** Runs the real preload against fake Electron and Node APIs, recording every module it requires. */
function loadPreload() {
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const requested = [];
  const rendererCalls = [];
  const marks = [];
  let api = null;
  const screenRenderer = {
    createNativeScreenPresentation() {
      rendererCalls.push('presentation');
      return { attach: async () => {}, attachPreview: async () => {}, stop: async () => {}, sample: async () => null, close: async () => {} };
    },
    registerNativeAudioPortReceiver() {
      rendererCalls.push('audio');
      return { getStats: () => ({}), dispose: async () => {} };
    },
  };
  const modules = new Map([
    ['electron', {
      contextBridge: { exposeInMainWorld: (key, value) => { if (key === 'api') api = value; } },
      ipcRenderer: { invoke: async () => null, send() {}, on() {}, removeListener() {} },
      sharedTexture: {},
    }],
    ['node:fs', { readFileSync: () => 'registerProcessor("fixture", class {});' }],
    ['@monky/shared', shared],
    ['@monky/screen-share/renderer', screenRenderer],
  ]);
  function fakeRequire(request) {
    requested.push(request);
    if (modules.has(request)) return modules.get(request);
    throw new Error(`The preload required an unexpected module: ${request}`);
  }
  fakeRequire.resolve = request => {
    assert.equal(request, '@monky/screen-share/runtime/nativePcmPlayout.worklet.js');
    return path.join('C:\\', 'fixture', 'nativePcmPlayout.worklet.js');
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: fakeRequire, console, Blob,
    process: { argv: [], platform: 'win32' },
    window: { localStorage: { getItem: () => null }, addEventListener() {} },
    document: {},
    performance: { mark: name => marks.push(name) },
    URL: { createObjectURL: () => 'blob:fixture-worklet', revokeObjectURL() {} },
  }, { filename });
  return { api, requested, rendererCalls, marks };
}

test('the preload leaves the native screen runtime unloaded until its window watches a native screen (E-MAIN-8)', async () => {
  const preload = loadPreload();
  assert.ok(preload.api, 'the preload exposes the window API');
  assert.deepEqual([...new Set(preload.requested)].sort(), ['@monky/shared', 'electron', 'node:fs'],
    'opening a window loads only Electron, the file system and the shared contracts');
  assert.deepEqual(preload.marks, ['monky:preload'], 'the end of the preload is marked for the startup timing');

  await preload.api.nativeScreenCommand({ action: 'watch' });
  await preload.api.attachNativeScreenPresentation({ presentationId: 'fixture' });
  await preload.api.stopNativeScreenPresentation('fixture');
  await preload.api.nativeScreenCommand({ action: 'watch' });
  assert.deepEqual(preload.requested.filter(request => request.startsWith('@monky/screen-share')), ['@monky/screen-share/renderer'],
    'watching loads only the renderer half of the runtime, once');
  assert.deepEqual(preload.rendererCalls, ['audio', 'presentation']);
});

test('the renderer entry of the native runtime carries presentation and audio, never capture, transport or processes', () => {
  const nativeRoot = path.resolve(__dirname, '..', 'native', 'screen-share');
  const probe = `
    const Module = require('node:module');
    const builtins = new Set();
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (Module.isBuiltin(request)) builtins.add(request.replace(/^node:/, ''));
      return load.call(this, request, ...rest);
    };
    const entry = require('@monky/screen-share/renderer');
    process.stdout.write(JSON.stringify({ exports: Object.keys(entry).sort(), files: Object.keys(require.cache), builtins: [...builtins] }));
  `;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', probe], { cwd: nativeRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stdout);
  assert.deepEqual(loaded.exports, ['createNativeScreenPresentation', 'registerNativeAudioPortReceiver']);
  const runtime = loaded.files.filter(file => file.startsWith(path.join(nativeRoot, 'runtime') + path.sep))
    .map(file => path.relative(path.join(nativeRoot, 'runtime'), file));
  for (const mainOnly of ['nativeEndpoint.cjs', 'nativeP2pBroker.cjs', 'nativeSfuBroker.cjs', 'nativeScreenPublisher.cjs',
    'captureBridge.cjs', 'runtimeFiles.cjs', path.join('mac', 'index.cjs')]) {
    assert.ok(!runtime.includes(mainOnly), `the renderer entry loaded ${mainOnly}`);
  }
  assert.ok(!loaded.builtins.includes('child_process'), 'the renderer entry must not start processes');

  const full = require(path.join(nativeRoot, 'index.cjs'));
  const renderer = require(path.join(nativeRoot, 'renderer.cjs'));
  assert.equal(renderer.createNativeScreenPresentation, full.createNativeScreenPresentation);
  assert.equal(renderer.registerNativeAudioPortReceiver, full.registerNativeAudioPortReceiver);
});
