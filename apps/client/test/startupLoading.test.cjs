const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const { loadPreload } = require('./preloadFixture.cjs');

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

test('the preload leaves the native screen runtime unloaded until its window watches a native screen (E-MAIN-8)', async () => {
  const preload = loadPreload();
  assert.ok(preload.api, 'the preload exposes the window API');
  assert.deepEqual([...new Set(preload.requested)].sort(),
    ['@monky/screen-share/runtime/nativePcmPlayout.worklet.js?raw', '@monky/shared', 'electron'],
    'opening a window loads only Electron, the shared contracts and the worklet source its bundle embeds');
  assert.deepEqual(preload.marks, ['monky:preload'], 'the end of the preload is marked for the startup timing');

  await preload.api.nativeScreenCommand({ action: 'watch' });
  await preload.api.attachNativeScreenPresentation({ presentationId: 'fixture' });
  await preload.api.stopNativeScreenPresentation('fixture');
  await preload.api.nativeScreenCommand({ action: 'watch' });
  assert.deepEqual(preload.requested.filter(request => request === '@monky/screen-share/renderer'), ['@monky/screen-share/renderer'],
    'watching loads only the renderer half of the runtime, once');
  assert.deepEqual(preload.rendererCalls, ['audio', 'presentation']);
});

test('the renderer entry of the native runtime carries presentation and audio, never capture, transport or processes', () => {
  const nativeRoot = path.resolve(__dirname, '..', 'native', 'screen-share');
  const probe = `
    const Module = require('node:module');
    const builtins = new Set();
    const load = Module._load;
    Module._load = function (request, parent, ...rest) {
      // Packages such as the shared contracts are bundled with their browser build.
      if (Module.isBuiltin(request) && !parent?.filename?.includes('node_modules')) builtins.add(request.replace(/^node:/, ''));
      return load.call(this, request, parent, ...rest);
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
  assert.deepEqual(loaded.builtins, [], 'a sandboxed preload bundles this entry and can require no Node built-in module');

  const full = require(path.join(nativeRoot, 'index.cjs'));
  const renderer = require(path.join(nativeRoot, 'renderer.cjs'));
  assert.equal(renderer.createNativeScreenPresentation, full.createNativeScreenPresentation);
  assert.equal(renderer.registerNativeAudioPortReceiver, full.registerNativeAudioPortReceiver);
});
