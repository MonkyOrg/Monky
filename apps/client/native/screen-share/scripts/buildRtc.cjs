'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, digest, regularFiles } = require('./buildTools.cjs');
const windowsToolchain = require('./windowsToolchain.cjs');

const source = path.join(root, 'src', 'rtc');
const revision = '36ea4535a500ac137dbf1f577ce40dc1aaa774ef';

function ownedDirectory(directory) {
  const marker = path.join(directory, '.monky-screen-build.json');
  const expected = { root, directory: path.resolve(directory), revision };
  if (fs.existsSync(directory)) {
    assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'Build directories cannot be aliases.');
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), expected, 'Build directory belongs to another checkout.');
  } else {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify(expected) + '\n', { flag: 'wx' });
  }
  return directory;
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
  assert.equal(execute('git', ['--no-pager', '-C', sdk, 'rev-parse', 'HEAD'], { env, capture: true }), revision,
    'WebRTC revision differs from the pinned native media toolchain.');
  const level6 = JSON.parse(fs.readFileSync(path.join(source, 'level6-upstream.json'), 'utf8'));
  assert.equal(level6.revision, revision);
  for (const file of level6.files) {
    assert.equal(digest(fs.readFileSync(path.join(sdk, ...file.path.split('/')))), file.sha256,
      `The maintained Level6 overlay requires its exact upstream source: ${file.path}`);
  }

  const key = digest(fs.realpathSync(root).toLowerCase()).slice(0, 6);
  const inputs = ownedDirectory(path.join(sdk, 'out', `ms${key}i`));
  const output = ownedDirectory(path.join(sdk, 'out', `ms${key}`));
  const localBuild = ownedDirectory(path.join(root, 'build', 'rtc-production'));
  const lock = path.join(localBuild, 'rtc.lock');
  const lockHandle = fs.openSync(lock, 'wx');
  try {
    const sourceFiles = regularFiles(source).map(relative => {
      const bytes = fs.readFileSync(path.join(source, relative));
      write(path.join(inputs, relative), bytes);
      return { path: relative, sha256: digest(bytes) };
    });
    write(path.join(inputs, 'pinned_timestamp.py'), fs.readFileSync(path.join(__dirname, 'pinned_timestamp.py')));
    const epoch = execute('git', ['--no-pager', '-C', sdk, 'show', '--no-patch', '--format=%ct', revision], { env, capture: true });
    assert.match(epoch, /^\d{1,10}$/u);
    write(path.join(inputs, 'pinned_epoch.txt'), `${epoch}\n`);

    const overlayFiles = sourceFiles.filter(file => file.path.startsWith(path.join('inputs', 'sdk') + path.sep));
    const vfs = {
      version: 0, 'case-sensitive': false, 'use-external-names': false,
      roots: overlayFiles.map(file => ({
        type: 'file', name: path.join(sdk, path.relative(path.join('inputs', 'sdk'), file.path)),
        'external-contents': path.join(inputs, file.path),
      })),
    };
    const vfsPath = path.join(inputs, 'sdk-vfs.json');
    write(vfsPath, JSON.stringify(vfs, null, 2) + '\n');
    const wrapper = path.join(inputs, 'inputs', 'build', 'rtc_overlay_compiler.py');
    const overlayHash = digest(JSON.stringify(overlayFiles) + digest(fs.readFileSync(wrapper)));
    const rootTarget = `//out/${path.basename(inputs)}`;
    const gnValues = {
      target_os: 'win', target_cpu: 'x64', is_debug: false, is_component_build: false, is_official_build: false,
      is_clang: true, use_lld: true, use_custom_libcxx: true, use_custom_libcxx_for_host: true,
      use_rtti: true, use_thin_lto: false, symbol_level: 0, treat_warnings_as_errors: false,
      use_siso: false, use_remoteexec: false, clang_use_chrome_plugins: false,
      rtc_include_tests: false, rtc_build_examples: false, rtc_build_tools: false,
      rtc_enable_protobuf: false, rtc_use_h264: false, rtc_use_h265: false,
      enable_libaom: true, enable_rust: false, enable_rust_cxx: false, enable_chromium_prelude: false,
      compute_build_timestamp: `${rootTarget}/pinned_timestamp.py`,
      cc_wrapper: `"${python}" -I -S -B "${wrapper}" "${vfsPath}" ${overlayHash} --`,
    };
    write(path.join(output, 'args.gn'), Object.entries(gnValues)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n');
    const gn = path.join(sdk, 'buildtools', 'win', 'gn.exe');
    const ninja = path.join(sdk, 'third_party', 'ninja', 'ninja.exe');
    const clang = path.join(sdk, 'third_party', 'llvm-build', 'Release+Asserts', 'bin', 'clang-cl.exe');
    assert.match(execute(clang, ['--version'], { env, capture: true }), /21\.0\.0git[\s\S]*bd809ffb/u);
    const graphArgs = [`--root=${sdk}`, `--root-target=${rootTarget}`, `--script-executable=${python}`, '--threads=1'];
    execute(gn, ['gen', output, '--fail-on-unused-args', ...graphArgs], { cwd: sdk, env });
    const graph = JSON.parse(execute(gn, ['desc', output, `${rootTarget}:*`, '--format=json', ...graphArgs],
      { cwd: sdk, env, capture: true }));
    for (const target of ['monky_screen_rtc', 'monky_rtc_engine_core', 'monky_mf_rtc_adapters']) {
      const description = graph[`${rootTarget}:${target}`];
      assert.ok(description.cflags.includes('/MT') && !description.cflags.includes('/MD') &&
        description.cflags_cc.includes('/EHsc') && description.cflags_cc.includes('/std:c++20') &&
        description.cflags_cc.some(flag => flag.includes('libc++')),
      `Native DLL compiler/CRT configuration drift: ${target}`);
    }
    execute(ninja, ['-C', output, `-j${config.jobs}`, 'monky_screen_rtc', 'monky_av1', 'monky_rtc_engine_contract_probe', 'monky_msvc_job'],
      { cwd: sdk, env });
    const contracts = JSON.parse(execute(path.join(output, 'monky_rtc_engine_contract_probe.exe'), [], { env, capture: true }));
    assert.ok(contracts.checks > 85000 && contracts.devicesOpened === false, 'Native device-free contract checks did not complete.');
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
    for (const file of sourceFiles)
      assert.equal(digest(fs.readFileSync(path.join(source, file.path))), file.sha256, `Source changed during compilation: ${file.path}`);

    const bin = path.join(root, 'bin', 'win32-x64');
    fs.mkdirSync(bin, { recursive: true });
    const binaries = [dll, addon, path.join(output, 'monky_av1.dll'),
      path.join(addonBuild, 'build', 'Release', 'monky_native_handles.node')].map(filename => {
      const bytes = fs.readFileSync(filename);
      write(path.join(bin, path.basename(filename)), bytes);
      return { name: path.basename(filename), bytes: bytes.length, sha256: digest(bytes) };
    });
    const report = { schemaVersion: 1, webrtcRevision: revision, sourceFiles, binaries, capabilities, contracts };
    write(path.join(bin, 'rtc-build.json'), JSON.stringify(report, null, 2) + '\n');
    require(path.resolve(root, '..', '..', '..', '..', 'scripts', 'legal.cjs')).copyMonkyLicenses(root);
    write(path.join(root, 'build', 'tools', 'monky_msvc_job.exe'), fs.readFileSync(path.join(output, 'monky_msvc_job.exe')));
    console.log(JSON.stringify({ nativeRtcBuilt: true, contractChecks: contracts.checks, binaries }));
    return report;
  } finally {
    fs.closeSync(lockHandle);
    fs.unlinkSync(lock);
  }
}

module.exports = { options, build };
if (require.main === module) {
  try { build(options(process.argv.slice(2))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
