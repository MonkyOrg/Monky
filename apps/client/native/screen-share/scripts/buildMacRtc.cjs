'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, digest, fingerprint, withBuildLock } = require('./buildTools.cjs');
const { workspace, checkSpace } = require('./prepareMacRtc.cjs');
const rtc = require('./rtcBuildCommon.cjs');

// Every device-free engine contract group except the Windows Media Foundation ones (contract_probe.cc).
const MAC_CONTRACT_GROUPS = [
  'signalingAndResources', 'presentationLease', 'operationCompletion', 'receiveMids', 'receiveRoutes',
  'receiverLifecycle', 'receiveFramePolicy', 'captureClock', 'externalH264', 'softwareAV1', 'peerStartupBitrate',
  'peerScreenCongestionRecovery', 'peerVideoPlayout', 'sfuVideoStartupBitrate', 'nodeEventQueue',
  'audioFoundations', 'audioOperationalPolicies', 'rtcSendDrops', 'rtcReceiveDiagnostics', 'rtcReceiveSdk',
  'surfaceRecycler', 'binaryLayout',
];

// Copies the owned inputs and generates the GN graph; notices only need this graph, not compiled objects.
function configure({ arch = process.arch } = {}) {
  assert.equal(process.platform, 'darwin');
  assert.ok(['arm64', 'x64'].includes(arch));
  const sdk = path.join(workspace, 'webrtc', 'src');
  const python = path.join(workspace, 'python-3.11', 'bin', 'python3');
  const revision = rtc.revision;
  rtc.checkSdk({ sdk, compiler: path.join(sdk, 'third_party', 'llvm-build', 'Release+Asserts', 'bin', 'clang++') });
  checkSpace();
  const source = path.join(root, 'src');
  const key = digest(fs.realpathSync(root)).slice(0, 8);
  const owner = { root: fs.realpathSync(root), revision };
  const inputs = rtc.ownedDirectory(path.join(sdk, 'out', `monky-${key}-inputs`), '.monky-owner.json', owner);
  const output = rtc.ownedDirectory(path.join(sdk, 'out', `monky-${key}-${arch}`), '.monky-owner.json', owner);
  const { sourceFiles, rootTarget, ccWrapper } = rtc.stageInputs({ sdk, inputs, source,
    directories: ['rtc', 'mac'], base: 'rtc', caseSensitive: true });
  rtc.writeGnArgs(output, { targetOs: 'mac', targetCpu: arch, ccWrapper: ccWrapper(python),
    platformArgs: { mac_deployment_target: '14.0', mac_min_system_version: '14.0' } });
  const env = { ...process.env, PATH: `${path.dirname(python)}:${process.env.PATH}`,
    DEPOT_TOOLS_UPDATE: '0', DEPOT_TOOLS_WIN_TOOLCHAIN: '0' };
  delete env.FORCE_MAC_TOOLCHAIN;
  rtc.generate({ gn: path.join(sdk, 'buildtools', 'mac', 'gn'), sdk, output, rootTarget, python, env });
  return { sdk, python, revision, source, output, sourceFiles, env };
}

function build({ arch = process.arch, jobs = 4 } = {}) {
  assert.equal(process.platform, 'darwin');
  assert.ok(['arm64', 'x64'].includes(arch));
  const localBuild = path.join(root, 'build', `rtc-mac-${arch}`);
  fs.mkdirSync(localBuild, { recursive: true });
  return withBuildLock(path.join(localBuild, 'compile.lock'), () => {
    const { sdk, python, source, output, sourceFiles, env } = configure({ arch });
    rtc.compile({ ninja: path.join(sdk, 'third_party', 'ninja', 'ninja'), sdk, output, jobs, env,
      targets: ['monky_screen_rtc', 'monky_av1', 'monky_rtc_engine_contract_probe'] });
    checkSpace();
    // The shared engine code is checked on macOS too, not only on Windows. x64 runs under Rosetta.
    const contracts = rtc.checkContracts(JSON.parse(execute(path.join(output, 'monky_rtc_engine_contract_probe'), [],
      { capture: true })), { minimum: 90000, groups: MAC_CONTRACT_GROUPS });
    const library = path.join(output, 'libmonky_screen_rtc.dylib');
    const addonDirectory = path.join(localBuild, 'node');
    write(path.join(addonDirectory, 'binding.gyp'), JSON.stringify({ targets: [{
      target_name: 'monky_screen_rtc',
      sources: [path.relative(addonDirectory, path.join(source, 'rtc', 'inputs', 'engine', 'node', 'napi_engine.cc'))],
      include_dirs: [path.join(source, 'rtc', 'inputs', 'engine')],
      defines: ['NAPI_VERSION=8'],
      libraries: [library],
      xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20', GCC_ENABLE_CPP_EXCEPTIONS: 'YES',
        MACOSX_DEPLOYMENT_TARGET: '14.0', OTHER_LDFLAGS: ['-Wl,-rpath,@loader_path'] },
    }, {
      target_name: 'monky_native_surfaces',
      sources: [path.relative(addonDirectory, path.join(source, 'rtc', 'inputs', 'engine', 'node', 'napi_surfaces.mm'))],
      defines: ['NAPI_VERSION=8'],
      libraries: ['-framework IOSurface', '-framework CoreFoundation', '-lbsm'],
      xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20', MACOSX_DEPLOYMENT_TARGET: '14.0' },
    }] }, null, 2) + '\n');
    execute(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--release',
      `--arch=${arch}`, `--python=${python}`, `--directory=${addonDirectory}`, `--jobs=${jobs}`], { env });
    const destination = path.join(root, 'bin', `darwin-${arch}`);
    const binaries = rtc.installBinaries([library, path.join(output, 'libmonky_av1.dylib'),
      ...['monky_screen_rtc.node', 'monky_native_surfaces.node'].map(name => path.join(addonDirectory, 'build', 'Release', name))],
    destination, { sign: filename => execute('codesign', ['--force', '--sign', '-', filename]) });
    const probe = path.join(localBuild, 'rtc-capabilities');
    execute('xcrun', ['clang++', '-std=c++20', '-mmacosx-version-min=14.0',
      '-arch', arch === 'x64' ? 'x86_64' : arch,
      path.join(source, 'rtc', 'inputs', 'engine', 'capabilities_main.cc'),
      library, `-Wl,-rpath,${output}`, '-o', probe]);
    // Cross-built support must come from the actual target library, never from
    // another architecture's descriptor. arm64 hosts need Rosetta for x64 here.
    const capabilities = JSON.parse(execute(probe, [], { capture: true }));
    require('../runtime/nativeRtc/engine/node/encoded.cjs').validateCapabilities(capabilities, 'darwin');
    if (arch === process.arch) {
      const addon = path.join(destination, 'monky_screen_rtc.node');
      const nodeCapabilities = JSON.parse(execute(process.execPath, ['-e',
        'console.log(JSON.stringify(require(process.argv[1]).capabilities()))', addon], { capture: true }));
      assert.deepEqual(capabilities, nodeCapabilities);
    }
    rtc.assertUnchanged(source, sourceFiles);
    // The runtime pins the exact recipe that built it: this script and the steps it shares with Windows.
    const manifest = rtc.writeManifest(destination, {
      platform: { platform: 'darwin', arch, minimumMacOS: '14.0' }, sourceFiles,
      recipes: { sourceRecipe: fingerprint(__filename), sharedRecipe: fingerprint(require.resolve('./rtcBuildCommon.cjs')) },
      binaries, capabilities, contracts });
    console.log(JSON.stringify({ macRtcBuilt: true, arch, binaries, capabilities, contractChecks: contracts.checks }));
    return manifest;
  });
}

module.exports = { build, configure, MAC_CONTRACT_GROUPS };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const configureOnly = args.at(-1) === '--configure';
    const rest = configureOnly ? args.slice(0, -1) : args;
    assert.ok(rest.length <= 1 && (!rest.length || /^--arch=(x64|arm64)$/.test(rest[0])));
    (configureOnly ? configure : build)(rest.length ? { arch: rest[0].slice(7) } : {});
  } catch (error) { console.error(error); process.exitCode = 1; }
}
