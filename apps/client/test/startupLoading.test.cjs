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

test('opening Monky never loads the hosted server, electron-updater, the whole bot SDK or the native screen runtime into Main', () => {
  const packages = eagerPackages(path.join(mainRoot, 'main.ts'));
  assert.ok(packages.has('@monky/shared') && packages.has('electron'), 'the import graph of main.ts is followed');
  for (const lazy of ['@monky/server', 'electron-updater', '@monky/bot-sdk', '@monky/screen-share']) {
    assert.ok(!packages.has(lazy), `${packages.get(lazy)} loads ${lazy} at startup; load it when it is first used`);
  }
  assert.ok(packages.has('@monky/screen-share/target'), 'listing sources validates targets through the light entry (#851)');
});

test('the target entry of the native runtime only validates capture targets (#851)', () => {
  const nativeRoot = path.resolve(__dirname, '..', 'native', 'screen-share');
  const probe = `
    const entry = require('@monky/screen-share/target');
    process.stdout.write(JSON.stringify({ exports: Object.keys(entry).sort(), files: Object.keys(require.cache) }));
  `;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', probe], { cwd: nativeRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stdout);
  assert.deepEqual(loaded.exports, ['validateCaptureTarget']);
  const runtime = loaded.files.filter(file => file.startsWith(path.join(nativeRoot, 'runtime') + path.sep))
    .map(file => path.relative(path.join(nativeRoot, 'runtime'), file)).sort();
  assert.deepEqual(runtime, ['captureProtocol.cjs', 'captureTarget.cjs', path.join('mac', 'target.cjs')].sort());
  const full = require(path.join(nativeRoot, 'index.cjs'));
  assert.equal(require(path.join(nativeRoot, 'target.cjs')).validateCaptureTarget, full.validateCaptureTarget);
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

/** Stylesheets a page links, each followed through its local `@import`s, in cascade order. */
function pageStylesheets(page) {
  const renderer = path.resolve(__dirname, '..', 'src', 'renderer');
  const sheets = [];
  const visit = file => {
    sheets.push(path.relative(renderer, file).split(path.sep).join('/'));
    for (const [, target] of fs.readFileSync(file, 'utf8').matchAll(/@import\s+'(\.[^']+)'/g)) visit(path.resolve(path.dirname(file), target));
  };
  const html = fs.readFileSync(path.join(renderer, page), 'utf8');
  for (const [, href] of html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)">/g)) visit(path.join(renderer, href));
  return sheets;
}

test('the overlay window loads its own stylesheet, never the whole app theme (#852)', () => {
  const overlay = pageStylesheets('overlay.html');
  assert.deepEqual(overlay, ['styles/fonts.css', 'styles/overlay.css', 'styles/base.css', 'styles/audioStateIcon.css',
    'styles/overlayStage.css']);
  const app = pageStylesheets('index.html');
  assert.ok(app.includes('styles/theme.css') && app.includes('styles/base.css') && app.includes('styles/audioStateIcon.css'),
    'the app and the overlay share the tokens and the audio state icons from one place');
  assert.ok(!app.includes('styles/overlayStage.css'), 'the main window never draws the overlay stage');
});

/** Local modules the renderer entry loads before its first paint: `import()` and type-only imports load nothing. */
function rendererStartupModules(entry) {
  const renderer = path.resolve(__dirname, '..', 'src', 'renderer');
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      const resolved = [`${target}.ts`, path.join(target, 'index.ts'), target].find(candidate =>
        fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (resolved) visit(resolved);
    }
  };
  visit(path.join(renderer, entry));
  return new Set([...seen].map(file => path.relative(renderer, file).split(path.sep).join('/')));
}

test('the rare server screens and their stylesheets load with their first opening, not with the app (#852)', () => {
  const startup = rendererStartupModules('main.ts');
  assert.ok(startup.has('views/MainView.ts') && startup.has('views/main/ServerHeader.ts'), 'the renderer graph is followed');
  for (const lazy of ['views/ServerSettingsModal.ts', 'views/ServerMonitorModal.ts', 'views/ServerAuditModal.ts',
    'styles/serverAudit.css', 'styles/serverMonitor.css', 'views/serverSettings/serverSettingsImmediate.css']) {
    assert.ok(!startup.has(lazy), `${lazy} is loaded at startup; load it with import() when the screen first opens`);
  }
});
