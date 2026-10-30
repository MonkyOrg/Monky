'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Platform } = require('app-builder-lib');
const { FileMatcher, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');
const { computeNodeModuleFileSets } = require('app-builder-lib/out/util/appFileCopier');
const { root: nativeRoot } = require('../scripts/buildTools.cjs');
const {
  RENDERER_ONLY_PACKAGES, NODE_GYP_ADDONS, requiredApplicationFiles, runtimeSourceFiles, verifyApplicationContents,
  verifyNativeAddonBuilds, verifyPackagedRuntimeSources, verifyScreenAudioAddon, windowsImportedLibraries,
} = require('../scripts/checkPackage.cjs');
const { packageRootOf, renderNotices, thirdPartyNotices } = require('../../../scripts/thirdPartyNotices.cjs');
const { build, dependencies, devDependencies } = require('../../../package.json');

function temporary(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, relative, contents = 'fixture') {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function packagedApplication(t, platform) {
  const app = temporary(t, 'monky-packaged-app-');
  for (const relative of requiredApplicationFiles(platform)) write(app, relative);
  write(app, 'dist/THIRD_PARTY_NOTICES.txt', RENDERER_ONLY_PACKAGES.map(name => `${name} 1.0.0\nLicense: MIT\n`).join('\n'));
  return app;
}

/** Whether electron-builder copies a dependency file, using its own matcher and directory pruning. */
function copiesDependency(relative) {
  const root = path.resolve(os.tmpdir(), 'monky-builder-root');
  const negations = build.files.filter(pattern => pattern.startsWith('!'));
  const filter = new FileMatcher(root, root, value => value, ['**/*', ...negations]).createFilter();
  const parts = relative.split('/');
  const directory = { isDirectory: () => true };
  for (let index = 1; index < parts.length; index++) {
    if (!filter(path.join(root, ...parts.slice(0, index)), directory)) return false;
  }
  return filter(path.join(root, ...parts), { isDirectory: () => false });
}

/** What node-gyp leaves beside an addon: MSBuild on Windows, make on macOS, and on either a Debug build. */
function nodeGypLeftovers(target) {
  return [
    `build/${target}.vcxproj`, `build/${target}.vcxproj.filters`, 'build/binding.sln', 'build/config.gypi',
    `build/Release/${target}.iobj`, `build/Release/${target}.ipdb`, `build/Release/${target}.pdb`,
    `build/Release/${target}.lib`, `build/Release/${target}.exp`, `build/Release/obj/${target}/${target}.node.recipe`,
    `build/Release/obj/${target}/${target}.tlog/CL.read.1.tlog`, `build/Release/obj/${target}/addon.obj`,
    'build/Makefile', 'build/binding.Makefile', `build/${target}.target.mk`, 'build/gyp-mac-tool',
    `build/Release/.deps/Release/obj.target/${target}/addon.o.d`, `build/Release/obj.target/${target}/addon.o`,
    'build/node_gyp_bins/python3', 'build/Release/.forge-meta', `build/Debug/${target}.node`,
  ];
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SCREEN_AUDIO_RUNTIME = ['index.js', 'native_binding.js', 'package.json', 'packet_capture.js'];
const UIOHOOK_RUNTIME = ['LICENSE', 'dist/index.js', 'libuiohook/src/windows/input_hook.c', 'package.json',
  'prebuilds/darwin-arm64/uiohook-napi.node', 'prebuilds/win32-x64/uiohook-napi.node', 'src/lib/addon.c'];

test('renderer-only packages stay out of the production dependencies electron-builder packages', () => {
  for (const name of RENDERER_ONLY_PACKAGES) {
    assert.equal(dependencies[name], undefined, `${name} is bundled by Vite and must not be a runtime dependency.`);
    assert.ok(devDependencies[name], `${name} must stay installed for the renderer build.`);
  }
  assert.equal(build.asar, false, 'Workspace packages are junctions outside apps/client, which asar cannot package.');
});

test('build.files drops source maps, TypeScript, compiled tests, unused sql.js builds and worker sources', () => {
  for (const relative of [
    'node_modules/zod/dist/index.js.map', 'apps/server/dist/index.js.map', 'node_modules/@monky/server/dist/index.js.map',
    'node_modules/zod/src/index.ts', 'node_modules/zod/index.d.cts', 'apps/server/src/server.ts',
    'apps/server/dist/test-bots.js', 'node_modules/@monky/server/dist/test-voice.js', 'apps/server/dist/testFixtures/bots.js',
    'packages/shared/dist-test/src/index.js', 'node_modules/@monky/shared/dist-test/test/validators.test.js',
    'apps/server/dist-test/local-execution-sdk.test.js',
    'node_modules/sql.js/dist/sql-asm.js', 'node_modules/sql.js/dist/sqljs-all.zip', 'node_modules/sql.js/dist/sql-wasm-debug.wasm',
    'node_modules/mediasoup/worker/meson.build', 'node_modules/mediasoup/worker/src/RTC/Transport.cpp',
    'node_modules/mediasoup/worker/include/RTC/Transport.hpp', 'node_modules/mediasoup/worker/fuzzer/src/FuzzerRtp.cpp',
    'node_modules/mediasoup/worker/subprojects/abseil-cpp.wrap',
    'node_modules/@fontsource/inter/latin-400.css', 'node_modules/@fontsource/inter/scss/mixins.scss',
    'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff', 'node_modules/@fontsource/inter/files/inter-latin-ext-400-normal.woff2',
    'node_modules/@fontsource/inter/files/inter-latin-400-italic.woff2', 'node_modules/@fontsource/inter/files/inter-cyrillic-400-normal.woff2',
  ]) assert.equal(copiesDependency(relative), false, relative);
});

test('build.files keeps every runtime file and the notices of the packages it prunes', () => {
  for (const relative of [
    'apps/server/dist/index.js', 'apps/server/dist/infrastructure/database/migrations/057_foreign_key_integrity.sql',
    'node_modules/zod/index.cjs', 'packages/bot-sdk/dist/localRuntime/index.js',
    'node_modules/sql.js/package.json', 'node_modules/sql.js/dist/sql-wasm.js', 'node_modules/sql.js/dist/sql-wasm.wasm',
    'node_modules/sql.js/LICENSE', 'node_modules/sql.js/AUTHORS',
    'node_modules/mediasoup/node/lib/index.js', 'node_modules/mediasoup/LICENSE',
    'node_modules/mediasoup/worker/out/Release/mediasoup-worker', 'node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe',
    'node_modules/mediasoup/worker/deps/libwebrtc/LICENSE', 'node_modules/mediasoup/worker/deps/libwebrtc/PATENTS',
    'node_modules/mediasoup/worker/src/RTC/SCTP/LICENSE', 'node_modules/mediasoup/worker/src/Utils/README_BASE64_UTILS',
    'node_modules/@fontsource/inter/package.json', 'node_modules/@fontsource/inter/LICENSE',
    'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2', 'node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2',
    'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
    'node_modules/@monky/screen-share/index.cjs', 'node_modules/@monky/screen-share/renderer.cjs',
  ]) assert.equal(copiesDependency(relative), true, relative);
  const application = new FileMatcher(path.resolve(os.tmpdir(), 'monky-app'), '/out', value => value, build.files).createFilter();
  const file = { isDirectory: () => false };
  const appFile = relative => application(path.resolve(os.tmpdir(), 'monky-app', ...relative.split('/')), file);
  assert.equal(appFile('dist-electron/main/main.js'), true);
  assert.equal(appFile('dist/THIRD_PARTY_NOTICES.txt'), true);
  assert.equal(appFile('dist-electron/main/main.js.map'), false);
});

test('every runtime file afterPack compares survives build.files in both workspace layouts', () => {
  const compared = runtimeSourceFiles().map(relative => relative.split(path.sep).join('/'));
  assert.ok(compared.includes('index.cjs') && compared.includes('renderer.cjs') && compared.includes('runtime/mac/index.cjs'));
  for (const layout of ['native/screen-share', 'node_modules/@monky/screen-share'])
    for (const relative of compared)
      assert.equal(copiesDependency(`${layout}/${relative}`), true, `afterPack compares ${relative}, but build.files drops it`);
});

test('build.files keeps only the addon from the build folder of each node-gyp module, in both workspace layouts', () => {
  for (const [root, target] of [['native/screen-audio', 'screen_audio'], ['node_modules/@monky/screen-audio', 'screen_audio'],
    ['node_modules/uiohook-napi', 'uiohook_napi']]) {
    assert.equal(copiesDependency(`${root}/build/Release/${target}.node`), true, root);
    for (const leftover of nodeGypLeftovers(target))
      assert.equal(copiesDependency(`${root}/${leftover}`), false, `${root}/${leftover}`);
  }
  for (const root of ['native/screen-audio', 'node_modules/@monky/screen-audio']) {
    for (const relative of SCREEN_AUDIO_RUNTIME) assert.equal(copiesDependency(`${root}/${relative}`), true, `${root}/${relative}`);
    for (const relative of ['src/packet_capture.cpp', 'src/mac/packet_source.mm', 'test/packetCapture.test.cjs'])
      assert.equal(copiesDependency(`${root}/${relative}`), false, `${root}/${relative}`);
  }
  for (const relative of UIOHOOK_RUNTIME)
    assert.equal(copiesDependency(`node_modules/uiohook-napi/${relative}`), true, relative);
});

test('the real packager ships only the addon of each node-gyp build folder on Windows and macOS', async t => {
  const directory = temporary(t, 'monky-node-gyp-');
  const app = path.join(directory, 'apps', 'client');
  const screenAudio = { name: '@monky/screen-audio', target: 'screen_audio', runtime: SCREEN_AUDIO_RUNTIME,
    sources: ['index.d.ts', 'binding.gyp', 'src/packet_capture.cpp', 'src/mac/packet_source.mm', 'test/README.md'] };
  const modules = [
    { ...screenAudio, dir: path.join(app, 'native', 'screen-audio') },
    { ...screenAudio, dir: path.join(directory, 'node_modules', '@monky', 'screen-audio') },
    { name: 'uiohook-napi', target: 'uiohook_napi', runtime: UIOHOOK_RUNTIME, sources: ['binding.gyp'],
      dir: path.join(directory, 'node_modules', 'uiohook-napi') },
  ];
  for (const { dir, target, runtime, sources } of modules)
    for (const relative of [...runtime, ...sources, `build/Release/${target}.node`, ...nodeGypLeftovers(target)]) write(dir, relative);
  const info = {
    config: build, appInfo: { type: 'commonjs' }, debugLogger: { isEnabled: false },
    getNodeDependencyInfo: () => ({ value: Promise.resolve(modules.map(({ name, dir }) => ({ name, dir }))) }),
  };
  const matcher = getNodeModuleFileMatcher(app, path.join(directory, 'output'), value => value, {}, info);
  for (const platform of [Platform.WINDOWS, Platform.MAC]) {
    const sets = await computeNodeModuleFileSets({ info, config: build, platform }, matcher);
    const shipped = sets.map((set, index) =>
      set.files.map(file => path.relative(modules[index].dir, file).split(path.sep).join('/')).sort());
    for (const [index, { target, runtime }] of modules.entries())
      assert.deepEqual(shipped[index], [...runtime, `build/Release/${target}.node`].sort(), `${platform.name}: ${modules[index].dir}`);
    for (const layout of [0, 1]) {
      const packaged = path.join(directory, 'packaged', platform.name, String(layout));
      for (const index of [layout, 2])
        for (const relative of shipped[index]) write(path.join(packaged, 'node_modules', ...modules[index].name.split('/')), relative);
      verifyNativeAddonBuilds(packaged);
    }
  }
});

test('afterPack accepts the runtime the real packager copies for Windows and macOS', async t => {
  const directory = temporary(t, 'monky-packaged-runtime-');
  const app = path.join(directory, 'apps', 'client');
  const files = ['package.json', ...runtimeSourceFiles()];
  const modules = [
    { name: '@monky/screen-share', dir: path.join(app, 'native', 'screen-share') },
    { name: '@monky/screen-share', dir: path.join(directory, 'node_modules', '@monky', 'screen-share') },
  ];
  for (const { dir } of modules) for (const relative of files) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.copyFileSync(path.join(nativeRoot, relative), path.join(dir, relative));
  }
  const info = {
    config: build, appInfo: { type: 'commonjs' }, debugLogger: { isEnabled: false },
    getNodeDependencyInfo: () => ({ value: Promise.resolve(modules) }),
  };
  const matcher = getNodeModuleFileMatcher(app, path.join(directory, 'output'), value => value, {}, info);
  for (const platform of [Platform.WINDOWS, Platform.MAC]) {
    const sets = await computeNodeModuleFileSets({ info, config: build, platform }, matcher);
    assert.equal(sets.length, modules.length);
    for (const [index, set] of sets.entries()) {
      const packaged = path.join(directory, 'packaged', platform.name, String(index));
      for (const file of set.files) {
        const destination = path.join(packaged, path.relative(modules[index].dir, file));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file, destination);
      }
      verifyPackagedRuntimeSources(packaged);
    }
  }
});

test('the afterPack guard accepts a complete application on every platform', t => {
  for (const platform of ['win32', 'darwin']) verifyApplicationContents(packagedApplication(t, platform), platform);
  assert.ok(requiredApplicationFiles('win32').includes('node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe'));
  assert.ok(requiredApplicationFiles('darwin').includes('node_modules/mediasoup/worker/out/Release/mediasoup-worker'));
  for (const relative of ['node_modules/sql.js/dist/sql-wasm.wasm', 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2',
    'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
    'node_modules/mediasoup/worker/src/Utils/README_BASE64_UTILS', 'dist/THIRD_PARTY_NOTICES.txt'])
    assert.ok(requiredApplicationFiles('win32').includes(relative), relative);
  for (const platform of ['win32', 'darwin'])
    for (const relative of ['node_modules/@monky/screen-audio/build/Release/screen_audio.node',
      'node_modules/uiohook-napi/build/Release/uiohook_napi.node'])
      assert.ok(requiredApplicationFiles(platform).includes(relative), `${platform}: ${relative}`);
});

test('the afterPack guard requires each node-gyp addon and rejects anything else in its build folder', t => {
  const app = packagedApplication(t, 'win32');
  for (const [name, addon] of Object.entries(NODE_GYP_ADDONS)) {
    const module = path.join(app, 'node_modules', ...name.split('/'));
    for (const leftover of nodeGypLeftovers(addon.slice(0, -'.node'.length))) {
      write(module, leftover);
      assert.throws(() => verifyApplicationContents(app, 'win32'), new RegExp(
        `node_modules/${escapeRegExp(name)}/build must hold only Release/${escapeRegExp(addon)}; `
        + `build\\.files let through ${escapeRegExp(leftover.slice('build/'.length))}(?:\\n|$)`), leftover);
      fs.rmSync(path.join(module, ...leftover.split('/')));
    }
  }
  verifyApplicationContents(app, 'win32');
  for (const [name, addon] of Object.entries(NODE_GYP_ADDONS)) {
    const missing = packagedApplication(t, 'darwin');
    fs.rmSync(path.join(missing, 'node_modules', ...name.split('/'), 'build', 'Release', addon));
    assert.throws(() => verifyApplicationContents(missing, 'darwin'),
      new RegExp(`Missing packaged file: node_modules/${escapeRegExp(name)}/build/Release/${escapeRegExp(addon)}`));
  }
});

test('the afterPack guard rejects returning renderer packages, missing runtime files and incomplete notices', t => {
  const app = packagedApplication(t, 'win32');
  write(app, 'node_modules/highlight.js/package.json', '{}');
  assert.throws(() => verifyApplicationContents(app, 'win32'), /highlight\.js is bundled into the renderer/);
  fs.rmSync(path.join(app, 'node_modules', 'highlight.js'), { recursive: true });
  for (const relative of ['node_modules/sql.js/dist/sql-wasm.wasm', 'node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe',
    'node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2', 'node_modules/mediasoup/worker/deps/libwebrtc/LICENSE']) {
    const file = path.join(app, ...relative.split('/'));
    fs.renameSync(file, `${file}.moved`);
    assert.throws(() => verifyApplicationContents(app, 'win32'), new RegExp(`Missing packaged file: ${relative.replace(/[.]/g, '\\.')}`));
    fs.renameSync(`${file}.moved`, file);
  }
  write(app, 'dist/THIRD_PARTY_NOTICES.txt', 'qrcode-terminal 1.0.0\n@tensorflow/tfjs-core-extra 1.0.0\n');
  assert.throws(() => verifyApplicationContents(app, 'win32'), /notices omit @codemirror\/commands/);
});

/** A minimal PE32+ image whose import directory names the given libraries. */
function peImage(libraries) {
  const image = Buffer.alloc(0x600);
  const header = 0x80, optional = header + 24, section = optional + 240, raw = 0x400, rva = 0x1000;
  image.writeUInt32LE(header, 0x3c);
  image.writeUInt32LE(0x4550, header);
  image.writeUInt16LE(1, header + 6);
  image.writeUInt16LE(240, header + 20);
  image.writeUInt16LE(0x20b, optional);
  for (const [field, value] of [[8, 0x200], [12, rva], [16, 0x200], [20, raw]]) image.writeUInt32LE(value, section + field);
  if (!libraries.length) return image;
  image.writeUInt32LE(rva, optional + 112 + 8);
  let name = raw + (libraries.length + 1) * 20;
  libraries.forEach((library, index) => {
    image.writeUInt32LE(rva + name - raw, raw + index * 20 + 12);
    name += image.write(`${library}\0`, name, 'latin1');
  });
  return image;
}

test('the afterPack guard reads the libraries a Windows binary needs at load time', () => {
  assert.deepEqual(windowsImportedLibraries(peImage(['KERNEL32.dll', 'VCRUNTIME140_1.dll'])), ['KERNEL32.dll', 'VCRUNTIME140_1.dll']);
  assert.deepEqual(windowsImportedLibraries(peImage([])), []);
  assert.throws(() => windowsImportedLibraries(Buffer.alloc(0x200)), /Not a Windows PE image/);
});

test('the packaged audio addon must not need a Visual C++ runtime that Windows and Electron do not ship', t => {
  const app = temporary(t, 'monky-packaged-addon-');
  const addon = 'node_modules/@monky/screen-audio/build/Release/screen_audio.node';
  for (const runtime of ['MSVCP140.dll', 'VCRUNTIME140.dll', 'vcruntime140_1.dll', 'CONCRT140.dll']) {
    write(app, addon, peImage(['KERNEL32.dll', runtime, 'api-ms-win-crt-runtime-l1-1-0.dll']));
    assert.throws(() => verifyScreenAudioAddon(app), new RegExp(`statically: ${runtime.replace('.', '\\.')}`));
  }
  write(app, addon, peImage(['KERNEL32.dll', 'USER32.dll', 'api-ms-win-core-winrt-l1-1-0.dll']));
  verifyScreenAudioAddon(app);
});

const builtAddon = path.join(__dirname, '..', '..', 'screen-audio', 'build', 'Release', 'screen_audio.node');
test('the locally built audio addon passes the same Visual C++ runtime check as the packaged one', {
  skip: (process.platform !== 'win32' || !fs.existsSync(builtAddon)) && 'Needs the addon built on Windows',
}, t => {
  const bytes = fs.readFileSync(builtAddon);
  assert.ok(windowsImportedLibraries(bytes).includes('KERNEL32.dll'), 'The PE reader must see the real imports');
  // The afterPack check itself, so a build from before binding.gyp switched to /MT fails with its rebuild hint.
  const app = temporary(t, 'monky-local-addon-');
  write(app, 'node_modules/@monky/screen-audio/build/Release/screen_audio.node', bytes);
  verifyScreenAudioAddon(app);
});

test('renderer notices are keyed by the package directory of each bundled module', () => {
  const root = path.resolve('/repo').replace(/\\/g, '/');
  assert.equal(packageRootOf(`${root}/node_modules/qrcode/lib/browser.js`), `${root}/node_modules/qrcode`);
  assert.equal(packageRootOf(`${root}/node_modules/@codemirror/view/dist/index.js?v=1`), `${root}/node_modules/@codemirror/view`);
  assert.equal(packageRootOf(`\0${root}/node_modules/qrcode/lib/browser.js?commonjs-proxy`), `${root}/node_modules/qrcode`);
  assert.equal(packageRootOf(`${root}/node_modules/qrcode/node_modules/dijkstrajs/dijkstra.js`), `${root}/node_modules/qrcode/node_modules/dijkstrajs`);
  assert.equal(packageRootOf('C:\\repo\\node_modules\\jsqr\\dist\\jsQR.js'), 'C:/repo/node_modules/jsqr');
  assert.equal(packageRootOf(`${root}/apps/client/src/renderer/main.ts`), null);
  assert.equal(packageRootOf(`${root}/node_modules/@scope`), null);
  assert.equal(packageRootOf('\0vite/modulepreload-polyfill.js'), null);
});

test('renderer notices reproduce each bundled package license once, in a stable order', t => {
  const root = temporary(t, 'monky-notices-');
  write(root, 'node_modules/zeta/package.json', JSON.stringify({ name: 'zeta', version: '2.0.0', license: 'MIT' }));
  write(root, 'node_modules/zeta/LICENSE', 'MIT License\r\nCopyright zeta\r\n');
  write(root, 'node_modules/@scope/alpha/package.json', JSON.stringify({ name: '@scope/alpha', version: '1.0.0', license: { type: 'Apache-2.0' } }));
  write(root, 'node_modules/@scope/alpha/LICENSE.md', 'Apache License text');
  write(root, 'node_modules/@scope/alpha/NOTICE', 'Alpha notice');
  write(root, 'node_modules/zeta/node_modules/beta/package.json', JSON.stringify({ name: 'beta', version: '0.1.0', license: 'ISC' }));
  const id = relative => path.join(root, ...relative.split('/'));
  const notices = renderNotices([
    id('node_modules/zeta/index.js'), id('node_modules/zeta/lib/other.js'), id('node_modules/@scope/alpha/index.js'),
    id('node_modules/zeta/node_modules/beta/index.js'), id('apps/client/src/renderer/main.ts'),
  ]);
  const headers = [...notices.matchAll(/^(\S+ \S+)\nLicense: (.+)$/gm)].map(match => `${match[1]} (${match[2]})`);
  assert.deepEqual(headers, ['@scope/alpha 1.0.0 (Apache-2.0)', 'beta 0.1.0 (ISC)', 'zeta 2.0.0 (MIT)']);
  assert.ok(notices.includes('--- LICENSE.md ---\n\nApache License text') && notices.includes('--- NOTICE ---\n\nAlpha notice'));
  assert.ok(notices.includes('MIT License\nCopyright zeta') && !notices.includes('\r'));
  assert.ok(notices.includes('The package ships no license file; it declares the ISC license.'));
});

test('the notices plugin joins worker builds and assets watched relative to the Vite root', t => {
  const root = temporary(t, 'monky-notices-plugin-');
  write(root, 'node_modules/page-lib/package.json', JSON.stringify({ name: 'page-lib', version: '1.0.0', license: 'MIT' }));
  write(root, 'node_modules/page-lib/LICENSE', 'page license');
  write(root, 'node_modules/worker-lib/package.json', JSON.stringify({ name: 'worker-lib', version: '3.0.0', license: 'Apache-2.0' }));
  write(root, 'node_modules/font-lib/package.json', JSON.stringify({ name: 'font-lib', version: '5.0.0', license: 'OFL-1.1' }));
  const viteRoot = path.join(root, 'apps', 'client', 'src', 'renderer');
  const notices = thirdPartyNotices();
  const [worker] = notices.workerPlugins();
  worker.configResolved({ root: viteRoot });
  notices.plugin.configResolved({ root: viteRoot });
  worker.buildEnd.call({ getModuleIds: () => [path.join(root, 'node_modules', 'worker-lib', 'index.js')].values(), getWatchFiles: () => [] });
  const emitted = [];
  notices.plugin.generateBundle.call({
    getModuleIds: () => [path.join(root, 'node_modules', 'page-lib', 'index.js'), path.join(viteRoot, 'main.ts')].values(),
    getWatchFiles: () => ['../../../../node_modules/font-lib/files/font.woff2'],
    emitFile: file => emitted.push(file),
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'asset');
  assert.equal(emitted[0].fileName, 'THIRD_PARTY_NOTICES.txt');
  for (const header of ['font-lib 5.0.0', 'page-lib 1.0.0', 'worker-lib 3.0.0']) assert.match(emitted[0].source, new RegExp(`^${header}$`, 'm'));

  const firstParty = thirdPartyNotices();
  const nothing = [];
  firstParty.plugin.configResolved({ root: viteRoot });
  firstParty.plugin.generateBundle.call({
    getModuleIds: () => [path.join(viteRoot, 'main.ts')].values(), getWatchFiles: () => ['./LICENSE'], emitFile: file => nothing.push(file),
  });
  assert.deepEqual(nothing, [], 'A bundle without third-party code gets no empty notices file');
});
