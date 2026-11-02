'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, digest, withBuildLock } = require('./buildTools.cjs');
const windowsToolchain = require('./windowsToolchain.cjs');
const rtc = require('./rtcBuildCommon.cjs');

function ownedDirectory(directory) {
  return rtc.ownedDirectory(directory, '.monky-screen-build.json',
    { root, directory: path.resolve(directory), revision: rtc.revision });
}

function options(argv) {
  const result = { webrtcRoot: process.env.MONKY_WEBRTC_SOURCE, python: process.env.PYTHON, jobs: 4 };
  const seen = new Set();
  for (const argument of argv) {
    const at = argument.indexOf('=');
    const key = argument.slice(0, at), value = argument.slice(at + 1);
    assert.ok(at > 0 && value && !seen.has(key), 'Use unique --webrtc-root=, --python=, --jobs=, --vs-install=, --sdk-root= and --vswhere= options.');
    seen.add(key);
    if (key === '--webrtc-root') result.webrtcRoot = value;
    else if (key === '--python') result.python = value;
    else if (key === '--jobs') result.jobs = Number(value);
    else if (!windowsToolchain.selectionOption(result, key, value)) throw new Error(`Unknown native RTC build option: ${key}`);
  }
  assert.ok(result.webrtcRoot && path.isAbsolute(result.webrtcRoot), 'Set MONKY_WEBRTC_SOURCE to the pinned WebRTC source checkout.');
  assert.ok(result.python && path.isAbsolute(result.python), 'Set PYTHON to the provisioned Python 3.11 executable.');
  assert.ok(Number.isInteger(result.jobs) && result.jobs >= 1 && result.jobs <= 16, 'Native build jobs must be 1..16.');
  return result;
}

function build(config) {
  assert.equal(process.platform, 'win32', 'Native screen RTC currently builds on Windows.');
  assert.equal(process.arch, 'x64', 'Native screen RTC requires x64.');
  const toolchain = windowsToolchain.resolveWindowsToolchain(config);
  const python = toolchain.python;
  const env = windowsToolchain.msvcEnvironment(toolchain);
  console.log(JSON.stringify({ windowsToolchain: windowsToolchain.summary(toolchain) }));
  const sdk = fs.realpathSync(config.webrtcRoot);
  const clang = path.join(sdk, 'third_party', 'llvm-build', 'Release+Asserts', 'bin', 'clang-cl.exe');
  rtc.checkSdk({ sdk, compiler: clang, env });

  const key = digest(fs.realpathSync(root).toLowerCase()).slice(0, 6);
  const inputs = ownedDirectory(path.join(sdk, 'out', `ms${key}i`));
  const output = ownedDirectory(path.join(sdk, 'out', `ms${key}`));
  const localBuild = ownedDirectory(path.join(root, 'build', 'rtc-production'));
  return withBuildLock(path.join(localBuild, 'rtc.lock'), () => {
    const { source, sourceFiles, rootTarget, ccWrapper } = rtc.stageInputs({ sdk, inputs,
      source: path.join(root, 'src', 'rtc'), directories: ['.'], base: '', caseSensitive: false });
    // Windows pins the build timestamp to the WebRTC commit, so rebuilds of the same inputs match.
    write(path.join(inputs, 'pinned_timestamp.py'), fs.readFileSync(path.join(__dirname, 'pinned_timestamp.py')));
    const epoch = execute('git', ['--no-pager', '-C', sdk, 'show', '--no-patch', '--format=%ct', rtc.revision], { env, capture: true });
    assert.match(epoch, /^\d{1,10}$/u);
    write(path.join(inputs, 'pinned_epoch.txt'), `${epoch}\n`);
    rtc.writeGnArgs(output, { targetOs: 'win', targetCpu: 'x64', ccWrapper: ccWrapper(python),
      platformArgs: { use_lld: true, compute_build_timestamp: `${rootTarget}/pinned_timestamp.py` } });
    const gn = path.join(sdk, 'buildtools', 'win', 'gn.exe');
    const ninja = path.join(sdk, 'third_party', 'ninja', 'ninja.exe');
    const graphArgs = rtc.generate({ gn, sdk, output, rootTarget, python, env, extraArgs: ['--threads=1'] });
    const graph = JSON.parse(execute(gn, ['desc', output, `${rootTarget}:*`, '--format=json', ...graphArgs],
      { cwd: sdk, env, capture: true }));
    for (const target of ['monky_screen_rtc', 'monky_rtc_engine_core', 'monky_mf_rtc_adapters']) {
      const description = graph[`${rootTarget}:${target}`];
      assert.ok(description.cflags.includes('/MT') && !description.cflags.includes('/MD') &&
        description.cflags_cc.includes('/EHsc') && description.cflags_cc.includes('/std:c++20') &&
        description.cflags_cc.some(flag => flag.includes('libc++')),
      `Native DLL compiler/CRT configuration drift: ${target}`);
    }
    rtc.compile({ ninja, sdk, output, jobs: config.jobs, env,
      targets: ['monky_screen_rtc', 'monky_av1', 'monky_rtc_engine_contract_probe', 'monky_msvc_job'] });
    const contracts = rtc.checkContracts(JSON.parse(execute(path.join(output, 'monky_rtc_engine_contract_probe.exe'), [],
      { env, capture: true })), { minimum: 85000 });
    execute(python, ['-I', path.join(__dirname, 'native-rtc', 'licenses.py'),
      `--sdk=${sdk}`, `--output=${output}`, `--root-target=${rootTarget}`,
      `--licenses=${path.join(root, 'licenses', 'webrtc')}`], { cwd: sdk, env });

    const addonBuild = path.join(localBuild, 'node');
    const engineDirectory = path.join(source, 'inputs', 'engine');
    const dll = path.join(output, 'monky_screen_rtc.dll');
    const importLibrary = path.join(output, 'monky_screen_rtc.dll.lib');
    write(path.join(addonBuild, 'binding.gyp'), JSON.stringify({ targets: [{
      target_name: 'monky_screen_rtc', sources: [path.join(engineDirectory, 'node', 'napi_engine.cc')],
      include_dirs: [engineDirectory, path.join(engineDirectory, 'node')],
      defines: ['NAPI_VERSION=8', 'NOMINMAX', 'WIN32_LEAN_AND_MEAN', '_HAS_EXCEPTIONS=1'],
      'defines!': ['_HAS_EXCEPTIONS=0'], libraries: [importLibrary],
      configurations: {
        Release: { msbuild_toolset: 'v143', msvs_settings: { VCCLCompilerTool: { RuntimeLibrary: 2 } } },
      },
      msvs_settings: {
        VCCLCompilerTool: {
          AdditionalOptions: ['/std:c++20', '/permissive-', '/Zc:__cplusplus'],
          ExceptionHandling: 1, MultiProcessorCompilation: 'false', RuntimeLibrary: 2,
        },
        VCLinkerTool: { AdditionalOptions: ['/guard:cf'], GenerateDebugInformation: 'false' },
      },
    }, {
      target_name: 'monky_native_handles', sources: [path.join(engineDirectory, 'node', 'napi_handles.cc')],
      defines: ['NAPI_VERSION=8', 'NOMINMAX', 'WIN32_LEAN_AND_MEAN'],
      msvs_settings: {
        VCCLCompilerTool: { AdditionalOptions: ['/std:c++20', '/permissive-'], RuntimeLibrary: 2 },
        VCLinkerTool: { AdditionalOptions: ['/guard:cf'], GenerateDebugInformation: 'false' },
      },
    }] }, null, 2) + '\n');
    execute(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'configure', '--release',
      '--jobs=1', `--msvs_version=${toolchain.visualStudio.path}`, `--directory=${addonBuild}`], { env });
    execute(path.join(output, 'monky_msvc_job.exe'), [
      toolchain.compilerDirectory, toolchain.msbuild,
      path.join(addonBuild, 'build', 'binding.sln'), '/nologo', '/clp:Verbosity=minimal', '/m:1', '/nr:false',
      '/t:Build', '/p:Configuration=Release;Platform=x64', ...windowsToolchain.msbuildArguments(toolchain),
    ], { cwd: addonBuild, env });
    const addon = path.join(addonBuild, 'build', 'Release', 'monky_screen_rtc.node');
    fs.copyFileSync(dll, path.join(path.dirname(addon), 'monky_screen_rtc.dll'));
    const capabilities = JSON.parse(execute(process.execPath, ['-e',
      'console.log(JSON.stringify(require(process.argv[1]).capabilities()))', addon], { env, capture: true }));
    require(path.join(root, 'runtime', 'nativeRtc', 'engine', 'node', 'encoded.cjs')).validateCapabilities(capabilities);
    rtc.assertUnchanged(source, sourceFiles);

    const bin = path.join(root, 'bin', 'win32-x64');
    const binaries = rtc.installBinaries([dll, addon, path.join(output, 'monky_av1.dll'),
      path.join(addonBuild, 'build', 'Release', 'monky_native_handles.node')], bin);
    const report = rtc.writeManifest(bin, { sourceFiles, binaries, capabilities, contracts });
    require(path.resolve(root, '..', '..', '..', '..', 'scripts', 'legal.cjs')).copyMonkyLicenses(root);
    write(path.join(root, 'build', 'tools', 'monky_msvc_job.exe'), fs.readFileSync(path.join(output, 'monky_msvc_job.exe')));
    console.log(JSON.stringify({ nativeRtcBuilt: true, contractChecks: contracts.checks, binaries }));
    return report;
  });
}

module.exports = { options, build };
if (require.main === module) {
  try { build(options(process.argv.slice(2))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
