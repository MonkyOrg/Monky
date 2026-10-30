'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { root, digest, regularFiles, verify } = require('./buildTools.cjs');
const { verifiedFile } = require('../runtime/runtimeFiles.cjs');
const { copyMonkyLicenses } = require('../../../../../scripts/legal.cjs');

// Vite bundles these into dist; their licenses travel in dist/THIRD_PARTY_NOTICES.txt.
const RENDERER_ONLY_PACKAGES = [
  '@codemirror/commands', '@codemirror/lang-markdown', '@codemirror/language', '@codemirror/state',
  '@codemirror/view', '@lezer/markdown', '@sapphi-red/web-noise-suppressor', '@tensorflow/tfjs-backend-cpu',
  '@tensorflow/tfjs-backend-webgl', '@tensorflow/tfjs-converter', '@tensorflow/tfjs-core', 'highlight.js',
  'jsqr', 'material-symbols', 'mediasoup-client', 'qrcode',
];

/**
 * node-gyp addons the application loads, by package: screen-audio requires build/Release/screen_audio.node
 * by name, and uiohook-napi loads it through node-gyp-build, which takes the first .node in build/Release.
 */
const NODE_GYP_ADDONS = Object.freeze({ '@monky/screen-audio': 'screen_audio.node', 'uiohook-napi': 'uiohook_napi.node' });

function requiredApplicationFiles(platform) {
  return [
    // The hosted server's database engine and SFU worker.
    'node_modules/sql.js/dist/sql-wasm.js',
    'node_modules/sql.js/dist/sql-wasm.wasm',
    `node_modules/mediasoup/worker/out/Release/mediasoup-worker${platform === 'win32' ? '.exe' : ''}`,
    // Fonts the main process embeds in the crash and local-execution pages.
    'node_modules/@fontsource/inter/package.json',
    ...[400, 500, 600, 700].map(weight => `node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`),
    'node_modules/@fontsource/jetbrains-mono/package.json',
    'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
    // Notices build.files must keep while it prunes these packages; the worker's
    // are extensionless, which is why its exclusions only match names with a dot.
    'node_modules/sql.js/LICENSE',
    'node_modules/sql.js/AUTHORS',
    'node_modules/mediasoup/LICENSE',
    'node_modules/mediasoup/worker/deps/libwebrtc/LICENSE',
    'node_modules/mediasoup/worker/deps/libwebrtc/PATENTS',
    'node_modules/mediasoup/worker/src/RTC/SCTP/LICENSE',
    'node_modules/mediasoup/worker/src/Utils/README_BASE64_UTILS',
    'node_modules/@fontsource/inter/LICENSE',
    'node_modules/@fontsource/jetbrains-mono/LICENSE',
    ...Object.entries(NODE_GYP_ADDONS).map(([name, addon]) => `node_modules/${name}/build/Release/${addon}`),
    'dist/THIRD_PARTY_NOTICES.txt',
  ];
}

/**
 * The build folder of a node-gyp addon may hold only the addon. This is a list of what is allowed, not of
 * known leftovers: nothing else there is ever loaded, while MSBuild and make each leave their own,
 * changing intermediates (link-time code generation data, program databases, import libraries, logs,
 * makefiles, the node-gyp Python link) that would otherwise ship in every update.
 */
function verifyNativeAddonBuilds(app) {
  for (const [name, addon] of Object.entries(NODE_GYP_ADDONS)) {
    const build = path.join(app, 'node_modules', ...name.split('/'), 'build');
    const leftovers = fs.readdirSync(build, { recursive: true }).map(String).filter(relative =>
      relative !== path.join('Release', addon) && !fs.lstatSync(path.join(build, relative)).isDirectory());
    assert.deepEqual(leftovers, [], `node_modules/${name}/build must hold only Release/${addon}; build.files let through `
      + leftovers.slice(0, 6).map(relative => relative.split(path.sep).join('/')).join(', ')
      + (leftovers.length > 6 ? ` and ${leftovers.length - 6} more` : ''));
  }
}

/** Fails when renderer-only weight returns to the package or a runtime file or notice goes missing. */
function verifyApplicationContents(app, platform) {
  for (const name of RENDERER_ONLY_PACKAGES)
    assert.ok(!fs.existsSync(path.join(app, 'node_modules', name)),
      `${name} is bundled into the renderer; keep it in devDependencies instead of packaging it.`);
  for (const relative of requiredApplicationFiles(platform))
    assert.ok(fs.statSync(path.join(app, relative), { throwIfNoEntry: false })?.isFile(), `Missing packaged file: ${relative}`);
  verifyNativeAddonBuilds(app);
  const notices = fs.readFileSync(path.join(app, 'dist', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const name of RENDERER_ONLY_PACKAGES)
    assert.match(notices, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} `, 'm'),
      `The renderer third-party notices omit ${name}.`);
}

/** Libraries a Windows PE image needs at load time, from its import directory. */
function windowsImportedLibraries(image) {
  const header = image.readUInt32LE(0x3c);
  assert.equal(image.readUInt32LE(header), 0x4550, 'Not a Windows PE image.');
  const sectionCount = image.readUInt16LE(header + 6);
  const optional = header + 24;
  const imports = image.readUInt32LE(optional + (image.readUInt16LE(optional) === 0x20b ? 112 : 96) + 8);
  const sections = optional + image.readUInt16LE(header + 20);
  const offset = rva => {
    for (let index = 0; index < sectionCount; index++) {
      const section = sections + index * 40;
      const start = image.readUInt32LE(section + 12);
      if (rva >= start && rva < start + Math.max(image.readUInt32LE(section + 8), image.readUInt32LE(section + 16)))
        return rva - start + image.readUInt32LE(section + 20);
    }
    throw new Error('A PE import points outside every section.');
  };
  const names = [];
  if (!imports) return names;
  for (let entry = offset(imports); image.readUInt32LE(entry + 12); entry += 20) {
    const start = offset(image.readUInt32LE(entry + 12));
    names.push(image.toString('latin1', start, image.indexOf(0, start)));
  }
  return names;
}

/**
 * The audio addon loads into the main process at startup and also lists windows and monitors. Electron
 * ships no Visual C++ runtime, so the addon links it statically instead of failing on systems without
 * the redistributable.
 */
function verifyScreenAudioAddon(app) {
  const addon = path.join(app, 'node_modules', '@monky', 'screen-audio', 'build', 'Release', 'screen_audio.node');
  const runtime = windowsImportedLibraries(fs.readFileSync(addon))
    .filter(name => /^(?:msvcp|vcruntime|concrt|vccorlib)\d/iu.test(name));
  assert.deepEqual(runtime, [], `The screen-audio addon must link the Visual C++ runtime statically: ${runtime.join(', ')}. `
    + 'A build from before binding.gyp switched to /MT is stale: rebuild apps/client/native/screen-audio with node-gyp.');
}

function verifySourceInputs() {
  const bin = path.join(root, 'bin', 'win32-x64');
  const rtc = JSON.parse(fs.readFileSync(path.join(bin, 'rtc-build.json'), 'utf8'));
  const capture = JSON.parse(fs.readFileSync(path.join(bin, 'capture-build.json'), 'utf8'));
  const thumbnails = JSON.parse(fs.readFileSync(path.join(bin, 'thumbnail-build.json'), 'utf8'));
  assert.equal(capture.schemaVersion, 5, 'Rebuild capture for hardware/software H264 and AV1.');
  verify(path.join(root, 'scripts', 'captureSourceBindings.cjs'), capture.sourceBindingRecipe);
  assert.equal(thumbnails.schemaVersion, 1);
  verify(path.join(root, 'scripts', 'buildThumbnails.cjs'), thumbnails.sourceRecipe);
  for (const [directory, records] of [
    [path.join(root, 'src', 'rtc'), rtc.sourceFiles],
    [path.join(root, 'src', 'capture'), capture.sourceFiles],
    [path.join(root, 'src', 'thumbnail'), thumbnails.sourceFiles],
  ]) {
    assert.ok(Array.isArray(records) && records.length > 0, 'Rebuild native screen sharing before packaging.');
    assert.deepEqual(records.map(file => file.path).sort(), regularFiles(directory),
      'Native source inventory changed since compilation. Run npm run prepare:native-screen.');
    for (const file of records) {
      assert.equal(digest(fs.readFileSync(path.join(directory, file.path))), file.sha256,
        `Native source changed since compilation: ${file.path}`);
    }
  }
  const obs = require('../src/vendor/obs/sources.json');
  for (const file of obs.files) verify(path.join(root, 'src', 'vendor', 'obs', file.path), file);
}

function verifyMacSourceInputs(arch) {
  assert.ok(['arm64', 'x64'].includes(arch));
  const bin = path.join(root, 'bin', `darwin-${arch}`);
  const capture = JSON.parse(fs.readFileSync(path.join(bin, 'mac-capture-build.json'), 'utf8'));
  const rtc = JSON.parse(fs.readFileSync(path.join(bin, 'rtc-build.json'), 'utf8'));
  verify(path.join(root, 'scripts', 'buildMac.cjs'), capture.sourceRecipe);
  verify(path.join(root, 'scripts', 'buildMacRtc.cjs'), rtc.sourceRecipe);
  assert.equal(capture.tests?.deviceFree, true, 'The target capture executable must pass its device-free self-test.');
  assert.deepEqual(capture.sourceFiles.map(file => file.path).sort(), regularFiles(path.join(root, 'src', 'mac')));
  for (const file of capture.sourceFiles) verify(path.join(root, 'src', 'mac', file.path), file);
  for (const file of capture.sharedSourceFiles) verify(path.join(root, file.path), file);
  const sources = ['rtc', 'mac'].flatMap(name => regularFiles(path.join(root, 'src', name))
    .map(file => path.join(name, file))).sort();
  assert.deepEqual(rtc.sourceFiles.map(file => file.path).sort(), sources);
  for (const file of rtc.sourceFiles)
    assert.equal(digest(fs.readFileSync(path.join(root, 'src', file.path))), file.sha256,
      `Native macOS source changed since compilation: ${file.path}`);
}

function verifyMacRuntime(directory, arch) {
  require('../runtime/mac/index.cjs').loadMacCaptureRuntime(directory, 'darwin', arch);
  const rtc = JSON.parse(fs.readFileSync(path.join(directory, 'rtc-build.json'), 'utf8'));
  assert.equal(rtc.schemaVersion, 1);
  assert.equal(rtc.platform, 'darwin');
  assert.equal(rtc.arch, arch);
  assert.equal(rtc.minimumMacOS, '14.0');
  assert.equal(rtc.webrtcRevision, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  assert.deepEqual(rtc.binaries.map(file => file.name).sort(),
    ['libmonky_av1.dylib', 'libmonky_screen_rtc.dylib', 'monky_native_surfaces.node', 'monky_screen_rtc.node']);
  for (const file of rtc.binaries) verifiedFile(directory, { ...file, path: file.name });
  require('../runtime/nativeRtc/engine/node/encoded.cjs').validateCapabilities(rtc.capabilities, 'darwin');
}

function verifyLegalFiles(directory, platform = 'win32') {
  const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'licenses', 'catalog.json'), 'utf8'));
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.license, 'GPL-3.0-or-later');
  assert.equal(catalog.webrtcRevision, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  if (platform === 'darwin') assert.equal(catalog.platform, 'darwin');
  else assert.equal(catalog.obsRevision, '7272af1375b38bc3cf4e0f98a5d999e8b76e9309');
  assert.ok(Array.isArray(catalog.files) && catalog.files.length >= (platform === 'darwin' ? 6 : 40),
    'Native third-party notices are incomplete.');
  for (const record of catalog.files) verifiedFile(directory, record);
  const libraries = JSON.parse(fs.readFileSync(path.join(directory, 'licenses', 'webrtc', 'libraries.json'), 'utf8'));
  for (const name of ['libaom', 'dav1d'])
    assert.ok(libraries.includes(name), `Missing compiled AV1 dependency notices: ${name}`);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'LICENSE')), fs.readFileSync(path.join(root, 'LICENSE')));
  const notice = fs.readFileSync(path.join(directory, 'THIRD_PARTY_NOTICES'), 'utf8');
  assert.ok(notice.includes('Corresponding Source:') &&
    notice.includes(platform === 'darwin' ? 'VideoToolbox' : 'Microsoft Visual C++'));
  assert.ok(fs.statSync(path.join(directory, 'README.md')).isFile());
  return catalog;
}

function detachPackagedHardLinks(directory) {
  // electron-builder hard-links files on CI; signing must not change build inputs.
  for (const relative of regularFiles(directory)) {
    const filename = path.join(directory, relative);
    if (fs.lstatSync(filename).nlink < 2) continue;
    const temporary = fs.mkdtempSync(path.join(path.dirname(filename), '.monky-package-'));
    try {
      const copy = path.join(temporary, 'copy');
      fs.copyFileSync(filename, copy, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      fs.renameSync(copy, filename);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

/**
 * Runtime files the package must carry unchanged. Type declarations are left
 * out: nothing executes them, and build.files drops them along with the other
 * TypeScript (electron-builder always drops *.d.ts).
 */
function runtimeSourceFiles() {
  return ['index.cjs', 'renderer.cjs', ...regularFiles(path.join(root, 'runtime')).map(file => path.join('runtime', file))]
    .filter(relative => !/\.d\.[cm]?ts$/.test(relative));
}

function verifyPackagedRuntimeSources(directory) {
  for (const relative of runtimeSourceFiles())
    assert.deepEqual(fs.readFileSync(path.join(directory, relative)), fs.readFileSync(path.join(root, relative)),
      `Packaged native runtime differs from the verified source: ${relative}`);
}

async function afterPack(context) {
  const platform = context.electronPlatformName;
  const contents = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
    : context.appOutDir;
  const licenseDirectory = platform === 'darwin' ? path.join(contents, 'Resources') : contents;
  assert.deepEqual(fs.readFileSync(path.join(licenseDirectory, 'LICENSE')),
    fs.readFileSync(path.resolve(root, '..', '..', '..', '..', 'LICENSE')), 'Missing packaged Monky GPL notice.');
  const app = path.join(contents, platform === 'darwin' ? 'Resources' : 'resources', 'app');
  verifyApplicationContents(app, platform);
  if (platform === 'win32') verifyScreenAudioAddon(app);
  const modules = path.join(app, 'node_modules', '@monky');
  assert.ok(!fs.existsSync(path.join(modules, 'server', 'data')), 'Server user data must never be packaged.');
  const directory = path.join(modules, 'screen-share');
  assert.ok(fs.lstatSync(directory).isDirectory(), 'The packaged native screen module must be a real directory.');
  assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(contents) + path.sep),
    'The packaged native runtime must not alias the source checkout.');
  for (const name of ['build', 'src', 'scripts', 'test'])
    assert.ok(!fs.existsSync(path.join(directory, name)), `Native build/source-only material leaked into the application: ${name}`);
  detachPackagedHardLinks(directory);
  copyMonkyLicenses(directory);
  if (!['win32', 'darwin'].includes(platform)) return;
  const arch = require('builder-util').Arch[context.arch];
  if (platform === 'darwin') verifyMacSourceInputs(arch);
  else {
    assert.equal(arch, 'x64', 'The native Windows screen runtime requires x64.');
    verifySourceInputs();
  }
  const packagedRequire = createRequire(path.join(directory, 'index.cjs'));
  const h264Path = packagedRequire.resolve('h264-profile-level-id');
  assert.ok(h264Path.startsWith(path.resolve(modules, '..') + path.sep),
    'Packaged H264 negotiation dependency escaped the application.');
  assert.equal(packagedRequire('h264-profile-level-id').parseProfileLevelId('4d003c')?.level, 60,
    'Packaged H264 negotiation dependency is missing the maintained Level 6 patch.');
  verifyLegalFiles(root, platform);
  fs.cpSync(path.join(root, 'licenses'), path.join(directory, 'licenses'), { recursive: true });
  for (const name of ['README.md', 'README.en.md', 'THIRD_PARTY_NOTICES'])
    fs.copyFileSync(path.join(root, name), path.join(directory, name));
  verifyPackagedRuntimeSources(directory);
  verifyLegalFiles(directory, platform);
  for (const other of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
    if (other === `${platform}-${arch}`) continue;
    const unused = path.join(directory, 'bin', other);
    if (fs.existsSync(unused)) {
      assert.ok(fs.lstatSync(unused).isDirectory() && !fs.lstatSync(unused).isSymbolicLink());
      fs.rmSync(unused, { recursive: true });
    }
  }
  if (platform === 'darwin') verifyMacRuntime(path.join(directory, 'bin', `darwin-${arch}`), arch);
  if (platform !== 'darwin' || arch === process.arch) require(path.join(directory, 'index.cjs')).loadRuntime();
  if (platform === 'win32') require(path.join(directory, 'index.cjs')).loadThumbnailRuntime();
  console.log('Packaged native screen runtime, source fingerprints and third-party notices verified.');
}

module.exports = afterPack;
module.exports.RENDERER_ONLY_PACKAGES = RENDERER_ONLY_PACKAGES;
module.exports.NODE_GYP_ADDONS = NODE_GYP_ADDONS;
module.exports.requiredApplicationFiles = requiredApplicationFiles;
module.exports.verifyApplicationContents = verifyApplicationContents;
module.exports.verifyNativeAddonBuilds = verifyNativeAddonBuilds;
module.exports.windowsImportedLibraries = windowsImportedLibraries;
module.exports.verifyScreenAudioAddon = verifyScreenAudioAddon;
module.exports.runtimeSourceFiles = runtimeSourceFiles;
module.exports.verifyPackagedRuntimeSources = verifyPackagedRuntimeSources;
module.exports.verifySourceInputs = verifySourceInputs;
module.exports.verifyLegalFiles = verifyLegalFiles;
module.exports.verifyMacSourceInputs = verifyMacSourceInputs;
module.exports.verifyMacRuntime = verifyMacRuntime;
module.exports.detachPackagedHardLinks = detachPackagedHardLinks;
