'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const tools = require('../scripts/windowsToolchain.cjs');
const pins = require('../scripts/native-rtc/pins.json');

function put(filename, contents = 'device-free fixture') {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function installation(directory, version = '14.44.35207', release = '17.14.37614.0') {
  put(path.join(directory, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'), version);
  put(path.join(directory, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt'), '14.44.35112');
  for (const file of tools.VC_FILES) put(path.join(directory, 'VC', 'Tools', 'MSVC', version, ...file.split('\\')));
  for (const file of tools.VS_FILES) put(path.join(directory, ...file.split('\\')));
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
    put(path.join(directory, 'VC', 'Redist', 'MSVC', '14.44.35112', 'x64', 'Microsoft.VC143.CRT', name));
  return { installationPath: directory, installationVersion: release, isComplete: true,
    isPrerelease: false, isLaunchable: true, isRebootRequired: false };
}

function fixture(t) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'monky-windows-toolchain-'));
  t.after(() => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith('monky-windows-toolchain-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const result = { root, calls: [], mutations: [], vs: path.join(root, 'VS 2022 Build Tools'),
    sdk: path.join(root, 'Windows Kits', '10'), python: path.join(root, 'Python 311', 'python.exe'),
    vswhere: path.join(root, 'Program Files x86', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe') };
  put(result.python); put(result.vswhere);
  put(path.join(path.dirname(result.python), 'python3.dll'));
  put(path.join(path.dirname(result.python), 'Lib', 'os.py'));
  result.instances = [installation(result.vs)];
  for (const file of tools.SDK_FILES) put(path.join(result.sdk, ...file.split('\\')));
  result.metadata = { pythonVersion: [3, 11, 9], pythonPointerBits: 64, sdkRoots: [result.sdk],
    selectedSdkRoot: result.sdk, sdkFileVersions: Object.fromEntries(tools.SDK_FILES.slice(-3)
      .map(file => [file, '10.0.26100.3323'])) };
  result.env = { 'ProgramFiles(x86)': path.join(root, 'Program Files x86'),
    ComSpec: path.join(root, 'Windows', 'System32', 'cmd.exe'), PATH: path.join(root, 'Git', 'cmd') };
  result.io = new Proxy(fs, { get(target, name) {
    if (!['mkdirSync', 'writeFileSync', 'openSync', 'unlinkSync', 'rmSync', 'renameSync'].includes(name)) return target[name];
    return (...args) => { result.mutations.push([name, ...args]); assert.fail(`Unexpected toolchain mutation: ${name}`); };
  } });
  result.run = (exe, args, options) => {
    result.calls.push({ exe, args, options });
    if (exe === result.vswhere) return JSON.stringify(result.instances);
    if (exe === result.python && args.includes('metadata')) return JSON.stringify(result.metadata);
    assert.fail(`Unexpected process in device-free toolchain test: ${exe}`);
  };
  result.dependencies = { io: result.io, run: result.run, env: result.env, platform: 'win32', arch: 'x64' };
  result.resolve = options => tools.resolveWindowsToolchain({ python: result.python, ...options }, result.dependencies);
  result.vcvars = (exe, args, options) => {
    result.calls.push({ exe, args, options });
    assert.equal(exe, result.env.ComSpec);
    return JSON.stringify({ ...options.env, VSINSTALLDIR: result.vs + path.sep,
      VCToolsInstallDir: path.join(result.vs, 'VC', 'Tools', 'MSVC', '14.44.35207') + path.sep,
      WindowsSdkDir: result.sdk + path.sep, UniversalCRTSdkDir: result.sdk + path.sep,
      VSCMD_ARG_HOST_ARCH: 'x64', VSCMD_ARG_TGT_ARCH: 'x64',
      INCLUDE: path.join(result.vs, 'VC', 'Tools', 'MSVC', '14.44.35207', 'include'),
      LIB: path.join(result.sdk, 'Lib'), LIBPATH: path.join(result.sdk, 'Lib'),
      ...result.vcvarsOverrides });
  };
  return result;
}

function script(name, overrides, extra = {}) {
  const filename = path.resolve(__dirname, '..', 'scripts', name);
  const localRequire = createRequire(filename);
  const requireFixture = id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id);
  requireFixture.resolve = localRequire.resolve;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: requireFixture, module, exports: module.exports,
    __dirname: path.dirname(filename), __filename: filename, Buffer,
    process: { platform: 'win32', arch: 'x64', execPath: process.execPath, env: {}, argv: [] },
    console: { log() {}, error() {} }, ...extra,
  }, { filename });
  return module.exports;
}

test('VS2022 remains selected when a newer Visual Studio is installed, including paths with spaces', t => {
  const f = fixture(t);
  f.instances.unshift({ ...f.instances[0], installationPath: path.join(f.root, 'VS 2026'), installationVersion: '18.2.1.0' });
  const chosen = f.resolve();
  assert.equal(chosen.visualStudio.path, f.vs);
  assert.equal(chosen.visualStudio.toolsVersion, '14.44.35207');
  assert.equal(chosen.crt.version, '14.44.35112');
  assert.equal(chosen.sdk.directoryVersion, '10.0.26100.0');
  assert.deepEqual(f.calls[0].args, ['-all', '-products', '*', '-version', '[17.0,18.0)',
    '-requires', ...pins.baseline.visualStudioComponents, '-format', 'json', '-utf8']);
  assert.deepEqual(f.calls[1].args.slice(0, 3), ['-I', '-S', '-B']);
  assert.ok(f.calls.every(call => call.options.timeout === 30000 && call.options.capture === true));
  assert.deepEqual(f.mutations, []);
});

test('only newer VS, old VS, incomplete and preview installs fail without writes or tool installation', t => {
  for (const changes of [
    { installationVersion: '18.0.0.0' }, { installationVersion: '16.11.0.0' },
    { isComplete: false }, { isPrerelease: true }, { isLaunchable: false }, { isRebootRequired: true },
    { installationVersion: 17.14 },
  ]) {
    const f = fixture(t);
    Object.assign(f.instances[0], changes);
    assert.throws(() => f.resolve(), error => error.code === 'ERR_RTC_VS_COMPONENTS'
      && /Visual Studio 2022/u.test(error.message) && /VS2026/u.test(error.message));
    assert.deepEqual(f.mutations, []);
    assert.equal(f.calls.length, 2);
  }
});

test('v143 version bounds reject old, future and malformed MSVC even inside VS2022', t => {
  for (const version of ['14.29.30133', '14.45.10000', '14.50.10000', '15.0.10000', '14..35207', '..\\other']) {
    const f = fixture(t);
    put(path.join(f.vs, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'), version);
    assert.throws(() => f.resolve(), error => error.code === 'ERR_RTC_VC_VERSION' && /14.30\.\.14.44/u.test(error.message));
    assert.deepEqual(f.mutations, []);
  }
  for (const version of ['14.30.30705', '14.43.34808', '14.44.35207']) assert.equal(tools.compatibleTools(version), true);
  assert.equal(pins.baseline.visualStudioReference, '17.13.4');
  assert.equal(pins.baseline.msvcToolset, 'v143');
});

test('missing tools, v143 MSBuild integration and release CRT fail before any build', t => {
  for (const filename of [
    path.join('VC', 'Tools', 'MSVC', '14.44.35207', 'bin', 'Hostx64', 'x64', 'cl.exe'),
    path.join('VC', 'Tools', 'MSVC', '14.44.35207', 'bin', 'Hostx64', 'x64', 'lib.exe'),
    path.join('VC', 'Tools', 'MSVC', '14.44.35207', 'atlmfc', 'include', 'afxwin.h'),
    path.join('MSBuild', 'Microsoft', 'VC', 'v170', 'Platforms', 'x64', 'PlatformToolsets', 'v143', 'Toolset.props'),
    path.join('VC', 'Redist', 'MSVC', '14.44.35112', 'x64', 'Microsoft.VC143.CRT', 'vcruntime140.dll'),
  ]) {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.vs, filename));
    assert.throws(() => f.resolve(), error => ['ERR_RTC_VC_FILES', 'ERR_RTC_CRT'].includes(error.code)
      && /Install\/modify Visual Studio 2022/u.test(error.message));
    assert.deepEqual(f.mutations, []);
  }
});

test('release CRT versions remain independent from MSVC tool versions', t => {
  const f = fixture(t);
  put(path.join(f.vs, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt'), '14.50.10000');
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
    put(path.join(f.vs, 'VC', 'Redist', 'MSVC', '14.50.10000', 'x64', 'Microsoft.VC143.CRT', name));
  const selected = f.resolve();
  assert.equal(selected.visualStudio.toolsVersion, '14.44.35207');
  assert.equal(selected.crt.version, '14.50.10000');
  assert.ok([...selected.crt.files.values()].every(filename => filename.startsWith(path.join(f.vs, 'VC', 'Redist'))));
});

test('selection is deterministic and an invalid explicit installation never falls back', t => {
  const f = fixture(t);
  const other = installation(path.join(f.root, 'Older VS 2022'), '14.43.34808', '17.13.4.0');
  f.instances.unshift(other);
  assert.equal(f.resolve().visualStudio.path, f.vs);
  assert.equal(f.resolve({ vsInstall: other.installationPath }).visualStudio.path, other.installationPath);
  assert.throws(() => f.resolve({ vsInstall: path.join(f.root, 'Absent VS') }), { code: 'ERR_RTC_VS_COMPONENTS' });
  put(path.join(f.vs, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'), '14.50.1');
  assert.throws(() => f.resolve({ vsInstall: f.vs }), { code: 'ERR_RTC_VC_VERSION' });
  const compatible = f.resolve();
  assert.equal(compatible.visualStudio.path, other.installationPath);
  assert.equal(compatible.rejected.length, 1);
  assert.equal(compatible.rejected[0].path, f.vs);
  assert.equal(compatible.rejected[0].code, 'ERR_RTC_VC_VERSION');
});

test('SDK root, required files, rc family and servicing are checked without substituting a newer SDK', t => {
  for (const change of ['missing-root', 'explicit-root', 'header', 'library', 'rc', 'debugger', 'servicing', 'family']) {
    const f = fixture(t);
    if (change === 'missing-root') f.metadata.selectedSdkRoot = null;
    const removals = { header: tools.SDK_FILES[0], library: tools.SDK_FILES[3],
      rc: tools.SDK_FILES[5], debugger: tools.SDK_FILES[7] };
    if (removals[change]) fs.unlinkSync(path.join(f.sdk, ...removals[change].split('\\')));
    if (change === 'servicing') f.metadata.sdkFileVersions[tools.SDK_FILES[5]] = '10.0.26100.3322';
    if (change === 'family') f.metadata.sdkFileVersions[tools.SDK_FILES[5]] = '10.0.28000.5000';
    const options = change === 'explicit-root' ? { sdkRoot: path.join(f.root, 'another SDK') } : {};
    assert.throws(() => f.resolve(options), error => /^ERR_RTC_SDK_/u.test(error.code));
    assert.deepEqual(f.mutations, []);
  }
  const f = fixture(t);
  f.metadata.sdkFileVersions[tools.SDK_FILES[6]] = '10.0.28000.1';
  f.metadata.sdkFileVersions[tools.SDK_FILES[7]] = '10.0.28000.1';
  assert.equal(f.resolve({ sdkRoot: f.sdk }).sdk.root, f.sdk);
  assert.deepEqual(f.calls[1].args.slice(-2), ['--sdk-root', f.sdk]);
});

test('Python Manager, Store aliases and incompatible Python cannot trigger tool downloads', t => {
  for (const relative of [path.join('WindowsApps', 'python.exe'), path.join('Python', 'bin', 'python.exe'), 'py.exe']) {
    const f = fixture(t), python = path.join(f.root, relative);
    put(python);
    assert.throws(() => f.resolve({ python }), { code: 'ERR_RTC_PYTHON_VERSION' });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.mutations, []);
  }
  const f = fixture(t);
  f.metadata.pythonVersion = [3, 14, 0];
  assert.throws(() => f.resolve(), { code: 'ERR_RTC_PYTHON_VERSION' });
  f.metadata.pythonVersion = [3, 11, 9]; f.metadata.pythonPointerBits = 32;
  assert.throws(() => f.resolve(), { code: 'ERR_RTC_PYTHON_VERSION' });
  const venv = path.join(f.root, 'private venv');
  put(path.join(venv, 'Scripts', 'python.exe'));
  put(path.join(venv, 'pyvenv.cfg'), `home = ${path.dirname(f.python)}\r\ninclude-system-site-packages = false\r\n`);
  assert.equal(tools.installedPython(path.join(venv, 'Scripts', 'python.exe'), fs, true), true);
  assert.equal(tools.installedPython(path.join(venv, 'Scripts', 'python.exe'), fs, false), false);
  const sourcePython = path.join(f.root, 'prepared CPython', 'PCbuild', 'amd64');
  put(path.join(sourcePython, 'python3.dll'));
  put(path.join(sourcePython, '..', '..', 'Lib', 'os.py'));
  put(path.join(sourcePython, '..', '..', 'PC', 'pyconfig.h'));
  put(path.join(venv, 'pyvenv.cfg'), `home = ${sourcePython}\r\ninclude-system-site-packages = false\r\n`);
  assert.equal(tools.installedPython(path.join(venv, 'Scripts', 'python.exe'), fs, true), true);
  fs.unlinkSync(path.join(sourcePython, '..', '..', 'PC', 'pyconfig.h'));
  assert.equal(tools.installedPython(path.join(venv, 'Scripts', 'python.exe'), fs, true), false);
});

test('inherited VS/SDK/compiler/npm overrides are removed case-insensitively without modifying the caller', t => {
  const f = fixture(t), selected = f.resolve();
  const other = path.join(f.root, 'custom incompatible tools');
  const inherited = { ...f.env, Path: [path.join(other, 'VC', 'bin'),
    path.join(f.root, 'Windows Kits', '11', 'bin'), f.env.PATH].join(path.delimiter),
  vcinstallDIR: path.join(other, 'VC'), VSINSTALLDIR: other, VSCMD_VER: '18.0',
  __VSCMD_PREINIT_PATH: other, VS180COMNTOOLS: other, vs2026_install: other,
  INCLUDE: other, LIB: other, LIBPATH: other, VCToolsVersion: '14.50.1', VCTargetsPath: other,
  WindowsSdkDir: path.join(f.root, 'Windows Kits', '11'), WindowsSDKVersion: '10.0.28000.0',
  UniversalCRTSdkDir: other, UCRTVersion: '10.0.28000.0', GYP_MSVS_VERSION: '2026',
  MSBUILD_EXE_PATH: path.join(other, 'MSBuild.exe'), MSBuildSDKsPath: other,
  nPm_CoNfIg_msvs_version: '2026', npm_config_python: 'py.exe', npm_config_target: '999.0.0',
  npm_config_node_gyp: 'global', NODE_GYP_FORCE_PYTHON: 'py.exe', PYTHONPATH: other,
  CL: '/DWRONG_TOOLSET', _LINK_: '/DEBUG', CC: 'foreign', NODE_OPTIONS: '--require=foreign' };
  delete inherited.PATH;
  const before = { ...inherited };
  const env = tools.buildEnvironment(selected, f.python, inherited);
  assert.deepEqual(inherited, before);
  assert.equal(env.vs2022_install, f.vs); assert.equal(env.GYP_MSVS_OVERRIDE_PATH, f.vs);
  assert.equal(env.VCToolsVersion, '14.44.35207'); assert.equal(env.WindowsSDKVersion, '10.0.26100.0\\');
  assert.equal(env.PYTHON, f.python); assert.equal(env.NODE_GYP_FORCE_PYTHON, f.python);
  for (const key of ['VCINSTALLDIR', 'VSINSTALLDIR', 'VSCMD_VER', '__VSCMD_PREINIT_PATH', 'vs2026_install',
    'VS180COMNTOOLS', 'MSBUILD_EXE_PATH', 'MSBuildSDKsPath', 'npm_config_msvs_version', 'npm_config_target',
    'npm_config_python', 'npm_config_node_gyp', 'INCLUDE', 'LIB', 'LIBPATH', 'PYTHONPATH', 'CL', '_LINK_', 'CC', 'NODE_OPTIONS'])
    assert.equal(tools.envValue(env, key), undefined, key);
  assert.equal(env.PATH.split(path.delimiter)[0], selected.compilerDirectory);
  assert.equal(env.PATH.includes(other), false);
  assert.equal(env.PATH.includes(path.join('Windows Kits', '11')), false);
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['PATH']);
});

test('vcvars uses the exact selected MSVC and SDK, preserves spaces, and rejects effective-env drift', t => {
  const f = fixture(t), selected = f.resolve();
  const env = tools.msvcEnvironment(selected, f.env, f.vcvars);
  const invocation = f.calls.at(-1);
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(invocation.args[3],
    `"call "${selected.vcvars}" 10.0.26100.0 -vcvars_ver=14.44.35207 >nul && "${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))""`);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.equal(env.VSINSTALLDIR, f.vs + path.sep);
  assert.deepEqual(tools.msbuildArguments(selected), ['/p:PlatformToolset=v143',
    '/p:VCToolsVersion=14.44.35207', '/p:WindowsTargetPlatformVersion=10.0.26100.0',
    `/p:WindowsSdkDir=${f.sdk}${path.sep}`, `/p:UniversalCRTSdkDir=${f.sdk}${path.sep}`, '/p:UCRTVersion=10.0.26100.0']);
  for (const changes of [
    { VSINSTALLDIR: path.join(f.root, 'VS 2026') }, { VCToolsVersion: '14.50.1' },
    { WindowsSDKVersion: '10.0.28000.0\\' }, { UCRTVersion: '10.0.28000.0' },
    { UniversalCRTSdkDir: path.join(f.root, 'wrong kit') }, { VSCMD_ARG_TGT_ARCH: 'x86' }, { INCLUDE: '' },
  ]) {
    f.vcvarsOverrides = changes;
    assert.throws(() => tools.msvcEnvironment(selected, f.env, f.vcvars), { code: 'ERR_RTC_TOOLCHAIN_ENV' });
  }
  f.vcvarsOverrides = { MONKY_TEST_TEXT: 'Unicode \u00e3 and embedded\nVSINSTALLDIR=not-an-override' };
  const unicode = tools.msvcEnvironment(selected, f.env, f.vcvars);
  assert.equal(unicode.MONKY_TEST_TEXT, f.vcvarsOverrides.MONKY_TEST_TEXT);
  assert.equal(unicode.VSINSTALLDIR, f.vs + path.sep);
});

test('toolchain options are explicit, shared, bounded and do not accept command metacharacters', t => {
  const f = fixture(t);
  const args = [`--python=${f.python}`, `--vs-install=${f.vs}`, `--sdk-root=${f.sdk}`, `--vswhere=${f.vswhere}`];
  const result = tools.options(args);
  assert.deepEqual(result, { python: f.python, vsInstall: f.vs, sdkRoot: f.sdk, vswhere: f.vswhere });
  assert.deepEqual(tools.selectionArguments(result), args.slice(1));
  for (const bad of [['--latest'], ['--vs-install=relative'], [`--vs-install=${f.vs};other`],
    [`--sdk-root=${f.sdk}%KIT%`], [...args, args[1]], ['--python=py.exe'], ['--force=true']])
    assert.throws(() => tools.options(bad));
  for (const name of ['prepare.cjs', 'buildRtc.cjs', 'buildCapture.cjs']) {
    const module = require(path.join('..', 'scripts', name));
    const required = name === 'buildRtc.cjs' ? [`--webrtc-root=${f.root}`]
      : name === 'buildCapture.cjs' ? [`--obs-root=${f.root}`, `--deps-root=${f.root}`] : [];
    const parsed = module.options([...args, ...required]);
    assert.equal(parsed.vsInstall, f.vs); assert.equal(parsed.sdkRoot, f.sdk); assert.equal(parsed.vswhere, f.vswhere);
  }
});

test('all four build entrypoints stop before writes, venv, pip, downloads or compilation on incompatible toolchains', async t => {
  for (const name of ['prepare.cjs', 'buildRtc.cjs', 'buildCapture.cjs', 'buildScreenAudio.cjs']) {
    for (const fault of ['vs', 'msvc', 'sdk']) {
      const f = fixture(t);
      if (fault === 'vs') f.instances[0].installationVersion = '18.0.0.0';
      if (fault === 'msvc') put(path.join(f.vs, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'), '14.50.1');
      if (fault === 'sdk') f.metadata.selectedSdkRoot = null;
      const expensive = [];
      const module = script(name, {
        'node:fs': f.io,
        './buildTools.cjs': { ...require('../scripts/buildTools.cjs'), execute(...args) {
          expensive.push(args); assert.fail('Tool command started before a valid preflight');
        } },
        './windowsToolchain.cjs': { ...tools, resolveWindowsToolchain: config =>
          tools.resolveWindowsToolchain(config, f.dependencies) },
        './fetchObs.cjs': { cache: path.join(f.root, '.native-screen'), fetchObs() { expensive.push('download'); } },
      });
      await assert.rejects(async () => (module.prepare ?? module.build)({ python: f.python }),
        { code: { vs: 'ERR_RTC_VS_COMPONENTS', msvc: 'ERR_RTC_VC_VERSION', sdk: 'ERR_RTC_SDK_SELECTION' }[fault] });
      assert.deepEqual(f.mutations, [], name);
      assert.deepEqual(expensive, [], name);
      assert.equal(f.calls.length, 2, name);
    }
  }
});

test('preparation preserves the selected installation and SDK through bootstrap, RTC and capture', async t => {
  const f = fixture(t), selected = f.resolve(), calls = [], writes = [];
  const packageRoot = path.join(f.root, 'apps', 'client', 'native', 'screen-share');
  const env = tools.msvcEnvironment(selected, f.env, f.vcvars);
  const module = script('prepare.cjs', {
    'node:fs': { existsSync: () => false, mkdirSync: (...args) => writes.push(args) },
    './buildTools.cjs': { root: packageRoot, execute: (exe, args, opts) => calls.push({ exe, args, opts }) },
    './windowsToolchain.cjs': { ...tools, resolveWindowsToolchain: () => selected, msvcEnvironment: () => env },
    './fetchObs.cjs': { cache: path.join(f.root, '.native-screen'),
      fetchObs: async () => ({ stock: path.join(f.root, 'obs'), dependencies: path.join(f.root, 'deps') }) },
    './notices.cjs': { generateNotices() { calls.push({ name: 'notices' }); } },
    './buildRtc.cjs': { build: config => calls.push({ name: 'rtc', config }) },
    './buildCapture.cjs': { build: config => calls.push({ name: 'capture', config }) },
    [path.join(packageRoot, 'index.cjs')]: { loadRuntime: () =>
      ({ obs: { version: '32.1.1' }, rtc: { capabilities: () => ({ contractRevision: 'fixture' }) } }) },
  });
  await module.prepare({ python: f.python, jobs: 2, vswhere: f.vswhere });
  assert.equal(writes.length, 1);
  const bootstrap = calls.find(call => call.args?.includes('fetch'));
  assert.ok(bootstrap.args.includes(`--vs-install=${f.vs}`));
  assert.ok(bootstrap.args.includes(`--sdk-root=${f.sdk}`));
  assert.ok(bootstrap.args.includes(`--vswhere=${f.vswhere}`));
  for (const call of calls.filter(value => value.exe)) assert.equal(call.opts.env, env);
  for (const name of ['rtc', 'capture']) {
    const config = calls.find(call => call.name === name).config;
    assert.equal(config.vsInstall, f.vs); assert.equal(config.sdkRoot, f.sdk); assert.equal(config.vswhere, f.vswhere);
    assert.equal(config.python, path.join(f.root, '.native-screen', 'python', 'Scripts', 'python.exe'));
  }
});

test('screen-audio uses installed Electron/local node-gyp and exact MSBuild properties inside the owned job', t => {
  const f = fixture(t), selected = f.resolve(), calls = [];
  const env = tools.msvcEnvironment(selected, f.env, f.vcvars);
  const packageRoot = path.join(f.root, 'apps', 'client', 'native', 'screen-share');
  const module = script('buildScreenAudio.cjs', {
    'node:fs': { existsSync: () => true, lstatSync: () => ({ isFile: () => true }) },
    './buildTools.cjs': { root: packageRoot, execute(exe, args, opts) {
      calls.push({ exe, args, opts });
      return 'MONKY_MSVC_CLEANUP {"msbuildExitCode":0,"remainingOwnedHelpers":0}\n';
    } },
    './windowsToolchain.cjs': { ...tools, resolveWindowsToolchain: () => selected, msvcEnvironment: () => env },
    'electron/package.json': { version: '44.4.3' },
  });
  module.build({ python: f.python });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].exe, process.execPath);
  assert.equal(calls[0].args[0], require.resolve('node-gyp/bin/node-gyp.js'));
  for (const argument of ['configure', '--target=44.4.3', '--arch=x64', `--msvs_version=${f.vs}`, `--python=${f.python}`])
    assert.ok(calls[0].args.includes(argument), argument);
  assert.equal(calls[1].exe, path.join(packageRoot, 'build', 'tools', 'monky_msvc_job.exe'));
  assert.deepEqual([...calls[1].args.slice(0, 2)], [selected.compilerDirectory, selected.msbuild]);
  for (const argument of ['/nr:false', '/t:Rebuild', ...tools.msbuildArguments(selected)])
    assert.ok(calls[1].args.includes(argument), argument);
  for (const call of calls) assert.equal(call.opts.env, env);
});

function modelBuilder(name, f, selected, env, paths = path) {
  const real = require('../scripts/buildTools.cjs');
  const packageRoot = paths.join(f.root, 'modeled package');
  const files = new Map(), directories = new Set(), calls = [];
  const stopped = new Error('Modeled command captured; no compiler was executed');
  const source = paths.join(packageRoot, 'src');
  const realSource = path.join(real.root, 'src');
  const save = (filename, bytes) => files.set(filename, Buffer.from(bytes));
  const io = {
    realpathSync: value => value,
    existsSync: value => files.has(value) || directories.has(value),
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    mkdirSync: value => directories.add(value), writeFileSync: save,
    readFileSync(filename, encoding) {
      let bytes = files.get(filename);
      if (filename === paths.join(source, 'rtc', 'level6-upstream.json')) {
        bytes = Buffer.from(JSON.stringify({ revision: pins.repositories.webrtc.commit, files: [
          { path: 'api/video_codecs/h264_profile_level_id.h', sha256: real.digest('modeled build input') },
          { path: 'api/video_codecs/h264_profile_level_id.cc', sha256: real.digest('modeled build input') },
        ] }));
      }
      if (!bytes) {
        const relative = paths.relative(source, filename);
        if (!relative.startsWith('..') && !paths.isAbsolute(relative))
          bytes = fs.readFileSync(path.join(realSource, ...relative.split(paths.sep)));
        else bytes = Buffer.from('modeled build input');
      }
      return encoding ? bytes.toString(encoding) : bytes;
    },
    openSync: () => 1, closeSync() {}, unlinkSync: filename => files.delete(filename),
  };
  save(paths.join(packageRoot, 'build', 'tools', 'monky_msvc_job.exe'), 'modeled job: never executed');
  const inputs = {};
  for (const relative of [paths.join('vendor', 'obs', 'sources.json'),
    paths.join('vendor', 'obs', 'runtime-inputs.json'), paths.join('capture', 'runtime-additions.json')])
    inputs[paths.join(source, relative)] = require(path.join(realSource, ...relative.split(paths.sep)));
  const module = script(name, {
    ...inputs, 'node:fs': io, 'node:path': paths,
    './windowsToolchain.cjs': { ...tools, resolveWindowsToolchain: () => selected, msvcEnvironment: () => env },
    './buildTools.cjs': { ...real, root: packageRoot, write: save, regularFiles: () => [],
      fingerprint: () => ({ bytes: 1, sha256: '0'.repeat(64) }), verify() {},
      execute(exe, args, options) {
        calls.push({ exe, args, options });
        const base = paths.basename(exe);
        if (base === 'monky_msvc_job.exe') throw stopped;
        if (exe === 'git') return args.includes('rev-parse') ? pins.repositories.webrtc.commit : '1700000000';
        if (base === 'clang-cl.exe') return 'clang version 21.0.0git bd809ffb';
        if (base === 'gn.exe') {
          if (args[0] === 'gen') return '';
          const prefix = args.find(value => value.startsWith('--root-target=')).slice('--root-target='.length);
          return JSON.stringify(Object.fromEntries(['monky_screen_rtc', 'monky_rtc_engine_core', 'monky_mf_rtc_adapters']
            .map(target => [`${prefix}:${target}`, { cflags: ['/MT'], cflags_cc: ['/EHsc', '/std:c++20', 'libc++'] }])));
        }
        if (base === 'ninja.exe') return '';
        if (base === 'monky_rtc_engine_contract_probe.exe') return JSON.stringify({ checks: 85160, devicesOpened: false });
        if (exe === f.python && args.some(value => value.endsWith('licenses.py'))) return '';
        if (exe === process.execPath && args.includes('configure')) return '';
        if (base === 'dumpbin.exe' && args.includes('/exports')) return Array.from({ length: 60 },
          (_, index) => `    ${index + 1} 0 1234 fixture_export_${index}`).join('\r\n') + '\r\n 60 number of names\r\n';
        if (base === 'lib.exe') return '';
        assert.fail(`Unmodeled build command: ${exe} ${args.join(' ')}`);
      } },
  });
  return { module, calls, files, stopped, packageRoot };
}

test('RTC GN, node-gyp and the MSVC job retain one verified installation/toolset/SDK', t => {
  const f = fixture(t), selected = f.resolve(), env = tools.msvcEnvironment(selected, f.env, f.vcvars);
  const modeled = modelBuilder('buildRtc.cjs', f, selected, env);
  assert.throws(() => modeled.module.build({ python: f.python, webrtcRoot: path.join(f.root, 'WebRTC SDK'), jobs: 1 }),
    error => error === modeled.stopped);
  const gn = modeled.calls.find(call => path.basename(call.exe) === 'gn.exe');
  assert.equal(gn.options.env.vs2022_install, f.vs);
  assert.equal(gn.options.env.GYP_MSVS_OVERRIDE_PATH, f.vs);
  assert.equal(gn.options.env.WindowsSDKVersion, '10.0.26100.0\\');
  const configure = modeled.calls.find(call => call.args.includes('configure'));
  assert.ok(configure.args.includes(`--msvs_version=${f.vs}`));
  assert.equal(configure.args[0], require.resolve('node-gyp/bin/node-gyp.js'));
  const build = modeled.calls.at(-1);
  assert.equal(path.basename(build.exe), 'monky_msvc_job.exe');
  assert.deepEqual([...build.args.slice(0, 2)], [selected.compilerDirectory, selected.msbuild]);
  for (const argument of tools.msbuildArguments(selected)) assert.ok(build.args.includes(argument), argument);
  assert.ok(modeled.calls.every(call => call.options.env === env));
});

test('RTC uses the resolved Python consistently when its programmatic caller relies on the prepared interpreter', t => {
  const f = fixture(t), selected = f.resolve(), env = tools.msvcEnvironment(selected, f.env, f.vcvars);
  const modeled = modelBuilder('buildRtc.cjs', f, selected, env);
  assert.throws(() => modeled.module.build({ webrtcRoot: path.join(f.root, 'WebRTC SDK'), jobs: 1 }),
    error => error === modeled.stopped);
  for (const call of modeled.calls.filter(value => path.basename(value.exe) === 'gn.exe'))
    assert.ok(call.args.includes(`--script-executable=${f.python}`));
  const gnArgs = [...modeled.files].find(([filename]) => path.basename(filename) === 'args.gn')[1].toString('utf8');
  assert.ok(gnArgs.includes(JSON.stringify(f.python).slice(1, -1)));
  assert.equal(gnArgs.includes('undefined'), false);
  assert.ok(modeled.calls.some(call => call.exe === f.python && call.args.some(value => value.endsWith('licenses.py'))));
});

test('capture imports and the owned cl job preserve Windows pins on Windows and POSIX hosts', async t => {
  const f = fixture(t), selected = f.resolve(), env = tools.msvcEnvironment(selected, f.env, f.vcvars);
  for (const [name, paths] of [['Windows', path.win32], ['POSIX', path.posix]]) await t.test(name, () => {
    const modeled = modelBuilder('buildCapture.cjs', f, selected, env, paths);
    const stock = paths.join(f.root, 'pinned OBS runtime');
    assert.throws(() => modeled.module.build({ python: f.python,
      stock, dependencies: paths.join(f.root, 'pinned OBS dependencies') }), error => error === modeled.stopped);
    const compiler = selected.compilerDirectory;
    for (const call of modeled.calls.slice(0, -1))
      assert.ok([paths.join(compiler, 'dumpbin.exe'), paths.join(compiler, 'lib.exe')].includes(call.exe));
    assert.equal(modeled.calls[0].args.at(-1), paths.join(stock, 'bin', '64bit', 'obs.dll'));
    const build = modeled.calls.at(-1);
    assert.equal(build.exe, paths.join(modeled.packageRoot, 'build', 'tools', 'monky_msvc_job.exe'));
    assert.deepEqual([...build.args.slice(0, 2)], [compiler, paths.join(compiler, 'cl.exe')]);
    assert.equal(build.args[2], `@${paths.join(modeled.packageRoot, 'build', 'capture-production', 'module.rsp')}`);
    assert.ok(modeled.calls.every(call => call.options.env === env));
    assert.equal(env.WindowsSDKVersion, '10.0.26100.0\\');
  });
});
