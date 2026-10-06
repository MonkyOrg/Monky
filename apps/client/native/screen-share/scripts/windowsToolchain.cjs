'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, redistributableCrt } = require('./buildTools.cjs');
const { baseline } = require('./native-rtc/pins.json');

const SDK_FILES = [
  `Include\\${baseline.sdkDirectoryVersion}\\um\\Windows.h`,
  `Include\\${baseline.sdkDirectoryVersion}\\shared\\sdkddkver.h`,
  `Include\\${baseline.sdkDirectoryVersion}\\ucrt\\stdio.h`,
  `Lib\\${baseline.sdkDirectoryVersion}\\um\\x64\\kernel32.lib`,
  `Lib\\${baseline.sdkDirectoryVersion}\\ucrt\\x64\\ucrt.lib`,
  `bin\\${baseline.sdkDirectoryVersion}\\x64\\rc.exe`,
  'Debuggers\\x64\\dbghelp.dll', 'Debuggers\\x64\\dbgcore.dll',
];
const SDK_VERSION_FILES = SDK_FILES.slice(-3);
const VC_FILES = [
  'include\\vector', 'bin\\Hostx64\\x64\\cl.exe', 'bin\\Hostx64\\x64\\link.exe', 'bin\\Hostx64\\x64\\lib.exe',
  'bin\\Hostx64\\x64\\dumpbin.exe', 'atlmfc\\include\\atlbase.h',
  'atlmfc\\include\\afxwin.h', 'atlmfc\\lib\\x64\\atls.lib',
];
const VS_FILES = [
  'VC\\Auxiliary\\Build\\vcvars64.bat', 'VC\\Auxiliary\\Build\\vcvarsall.bat',
  'MSBuild\\Current\\Bin\\MSBuild.exe',
  'MSBuild\\Microsoft\\VC\\v170\\Platforms\\x64\\PlatformToolsets\\v143\\Toolset.props',
];
const SELECTIONS = new Map([['--vs-install', 'vsInstall'], ['--sdk-root', 'sdkRoot'], ['--vswhere', 'vswhere']]);
const VS_ACTION = 'Install/modify Visual Studio 2022 (17.x) with C++ x64/x86, v143 and ATL/MFC, or select it with --vs-install=<absolute path>. VS2026 is not supported by these pins.';
const SDK_ACTION = `Install Windows SDK ${baseline.sdkDirectoryVersion}, serviced to ${baseline.sdkMinimumServicingVersion} or newer, including x64 Debugging Tools; use --sdk-root=<absolute path> if needed.`;
const VERSION = /^\d+(?:\.\d+){1,3}$/u;

class WindowsToolchainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function requireValue(condition, code, message) {
  if (!condition) throw new WindowsToolchainError(code, message);
}

function compareVersion(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); ++index) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function compatibleTools(version) {
  return typeof version === 'string' && /^14\.\d+\.\d+$/u.test(version)
    && compareVersion(version, baseline.msvcToolsMinimum.join('.')) >= 0
    && compareVersion(version, baseline.msvcToolsMaximumExclusive.join('.')) < 0;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function absolutePath(value, label) {
  requireValue(typeof value === 'string' && path.isAbsolute(value) && !/["%!\r\n;]/u.test(value),
    'ERR_RTC_TOOLCHAIN_PATH', `${label} must be an absolute path without command/property metacharacters.`);
  return path.resolve(value);
}

function envValue(env, name) {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function regularFile(io, filename, code, action) {
  let stat;
  try { stat = io.lstatSync(filename); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    throw new WindowsToolchainError(code, `Missing ${filename}. ${action}`);
  }
  requireValue(stat.isFile() && !stat.isSymbolicLink(), code, `Expected a regular file: ${filename}. ${action}`);
  return stat;
}

function installedPython(filename, io = fs, allowVenv = false) {
  const directory = path.dirname(filename);
  if (/[\\/]WindowsApps[\\/]/iu.test(filename)) return false;
  const hasRuntime = location => {
    if (!io.existsSync(path.join(location, 'python3.dll'))) return false;
    if (io.existsSync(path.join(location, 'Lib', 'os.py'))) return true;
    return path.basename(path.dirname(location)).toLowerCase() === 'pcbuild'
      && ['amd64', 'win32'].includes(path.basename(location).toLowerCase())
      && io.existsSync(path.join(location, '..', '..', 'Lib', 'os.py'))
      && io.existsSync(path.join(location, '..', '..', 'PC', 'pyconfig.h'));
  };
  if (hasRuntime(directory)) return true;
  if (!allowVenv || path.basename(directory).toLowerCase() !== 'scripts') return false;
  const config = path.join(directory, '..', 'pyvenv.cfg');
  if (!io.existsSync(config)) return false;
  const stat = io.lstatSync(config);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
  const homes = [...io.readFileSync(config, 'utf8').matchAll(/^home\s*=\s*([^\r\n]+)$/gmu)];
  return homes.length === 1 && path.isAbsolute(homes[0][1].trim()) && hasRuntime(homes[0][1].trim());
}

function parseMetadata(output, label) {
  try { return JSON.parse(output.replace(/^\uFEFF/u, '')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new WindowsToolchainError('ERR_RTC_TOOL_OUTPUT', `${label} returned invalid JSON.`);
  }
}

function selectionOption(config, key, value) {
  const name = SELECTIONS.get(key);
  if (!name) return false;
  config[name] = absolutePath(value, key);
  return true;
}

function selectionArguments(config) {
  return [...SELECTIONS].filter(([, name]) => config[name] !== undefined)
    .map(([key, name]) => `${key}=${absolutePath(config[name], key)}`);
}

function vswhereRequest(options = {}, env = process.env, io = fs) {
  selectionArguments(options);
  const installer = envValue(env, 'ProgramFiles(x86)');
  const executable = absolutePath(options.vswhere ?? (installer &&
    path.join(installer, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')), 'vswhere.exe');
  regularFile(io, executable, 'ERR_RTC_VSWHERE', VS_ACTION);
  return { executable, args: ['-all', '-products', '*', '-version',
    `[${baseline.visualStudioMajor}.0,${baseline.visualStudioMajor + 1}.0)`,
    '-requires', ...baseline.visualStudioComponents, '-format', 'json', '-utf8'] };
}

function metadataArguments(options = {}) {
  return ['-I', '-S', '-B', path.join(__dirname, 'native-rtc', 'windows_support.py'), 'metadata',
    ...(options.sdkRoot ? ['--sdk-root', absolutePath(options.sdkRoot, '--sdk-root')] : [])];
}

function inspectInstallation(instance, io) {
  const directory = absolutePath(instance.installationPath, 'Visual Studio');
  const versionFile = path.join(directory, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt');
  const stat = regularFile(io, versionFile, 'ERR_RTC_VC_VERSION', VS_ACTION);
  requireValue(stat.size <= 128, 'ERR_RTC_VC_VERSION', `Invalid VC tools version file: ${versionFile}. ${VS_ACTION}`);
  const toolsVersion = io.readFileSync(versionFile, 'utf8').replace(/^\uFEFF/u, '').trim();
  requireValue(compatibleTools(toolsVersion), 'ERR_RTC_VC_VERSION',
    `Unsupported MSVC ${toolsVersion} in ${directory}; these pins require v143 14.30..14.44. ${VS_ACTION}`);
  const toolsRoot = path.join(directory, 'VC', 'Tools', 'MSVC', toolsVersion);
  for (const relative of VC_FILES)
    regularFile(io, path.join(toolsRoot, ...relative.split('\\')), 'ERR_RTC_VC_FILES', VS_ACTION);
  for (const relative of VS_FILES)
    regularFile(io, path.join(directory, ...relative.split('\\')), 'ERR_RTC_VC_FILES', VS_ACTION);
  let crt;
  try { crt = redistributableCrt(directory, io); }
  catch (error) {
    if (!(error instanceof assert.AssertionError) && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    throw new WindowsToolchainError('ERR_RTC_CRT', `Missing/invalid VS2022 release redistributable in ${directory}: ${error.message}. ${VS_ACTION}`);
  }
  return {
    visualStudio: { path: directory, version: instance.installationVersion, toolsVersion,
      toolset: baseline.msvcToolset, components: [...baseline.visualStudioComponents] },
    compilerDirectory: path.join(toolsRoot, 'bin', 'Hostx64', 'x64'),
    vcvars: path.join(directory, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'),
    msbuild: path.join(directory, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'), crt,
  };
}

function inspectWindowsToolchain(instances, metadata, options = {}, io = fs) {
  selectionArguments(options);
  requireValue(Array.isArray(instances) && instances.length <= 128,
    'ERR_RTC_VS_OUTPUT', 'vswhere must return a bounded instance array.');
  const candidates = instances.filter(instance => instance && instance.isComplete === true
    && instance.isLaunchable !== false && instance.isPrerelease !== true && instance.isRebootRequired !== true
    && typeof instance.installationPath === 'string' && typeof instance.installationVersion === 'string'
    && VERSION.test(instance.installationVersion)
    && Number(instance.installationVersion.split('.')[0]) === baseline.visualStudioMajor
    && (!options.vsInstall || samePath(instance.installationPath, options.vsInstall)))
    .sort((a, b) => compareVersion(b.installationVersion, a.installationVersion)
      || a.installationPath.localeCompare(b.installationPath));
  requireValue(candidates.length > 0, 'ERR_RTC_VS_COMPONENTS',
    `No complete, non-preview VS2022 installation satisfies the requested components${options.vsInstall ? ` at ${options.vsInstall}` : ''}. ${VS_ACTION}`);
  let selected;
  const rejected = [];
  for (const instance of candidates) {
    try { selected = inspectInstallation(instance, io); break; }
    catch (error) {
      if (!(error instanceof WindowsToolchainError)) throw error;
      rejected.push({ path: instance.installationPath, code: error.code, message: error.message });
    }
  }
  if (!selected) throw new WindowsToolchainError(rejected[0].code, rejected.map(value => value.message).join('\n'));
  requireValue(metadata && Array.isArray(metadata.sdkRoots), 'ERR_RTC_SDK_OUTPUT', 'Invalid SDK root metadata.');
  requireValue(metadata.selectedSdkRoot, 'ERR_RTC_SDK_SELECTION', `SDK root is missing or ambiguous. ${SDK_ACTION}`);
  const sdkRoot = absolutePath(metadata.selectedSdkRoot, 'Windows SDK');
  requireValue(!options.sdkRoot || samePath(options.sdkRoot, sdkRoot), 'ERR_RTC_SDK_SELECTION',
    'SDK metadata did not preserve the explicitly selected root.');
  for (const relative of SDK_FILES)
    regularFile(io, path.join(sdkRoot, ...relative.split('\\')), 'ERR_RTC_SDK_FILES', SDK_ACTION);
  const observed = metadata.sdkFileVersions;
  requireValue(observed && typeof observed === 'object', 'ERR_RTC_SDK_OUTPUT', 'Invalid SDK file-version metadata.');
  for (const relative of SDK_VERSION_FILES) {
    const value = observed[relative];
    requireValue(typeof value === 'string' && /^\d+\.\d+\.\d+\.\d+$/u.test(value)
      && (relative !== SDK_VERSION_FILES[0] || value.startsWith('10.0.26100.'))
      && compareVersion(value, baseline.sdkMinimumServicingVersion) >= 0, 'ERR_RTC_SDK_SERVICING',
    `${relative} has incompatible version ${value}; rc.exe must retain the 26100 family. ${SDK_ACTION}`);
  }
  return { ...selected, rejected, sdk: { root: sdkRoot, directoryVersion: baseline.sdkDirectoryVersion,
    requiredServicing: baseline.sdkMinimumServicingVersion, fileVersions: { ...observed } } };
}

function cleanWindowsEnvironment(source = process.env) {
  const result = {};
  const roots = Object.entries(source).filter(([key, value]) =>
    /^(?:VSINSTALLDIR|VCINSTALLDIR|VCToolsInstallDir|WindowsSdkDir|WindowsSdkBinPath|WindowsSdkVerBinPath|UniversalCRTSdkDir|VS\d+_INSTALL)$/iu.test(key)
    && typeof value === 'string' && path.isAbsolute(value)).map(([, value]) => path.resolve(value).toLowerCase());
  for (const [key, value] of Object.entries(source)) {
    if (/^(?:VS\d|VSINSTALLDIR$|VCINSTALLDIR$|VCTOOLS|VCTARGETS|VSCMD|__VSCMD|WINDOWSSDK|WINDOWSTARGETPLATFORM|WINDOWSLIBPATH$|UNIVERSALCRT|UCRTVERSION$|EXTENSIONSDK|NETFXSDK|FRAMEWORK|MSBUILD|GYP_|RBE_|RECLIENT_|SISO_|GOMA_|DISTCC_|CCACHE_|PYTHON|NODE_GYP|npm_config_)/iu.test(key)
      || /^(?:PATH|INCLUDE|LIB|LIBPATH|DEVENVDIR|VISUALSTUDIOVERSION|COMMANDPROMPTTYPE|PLATFORM|PREFERREDTOOLARCHITECTURE|WDK_DIR|CC|CXX|CL|_CL_|LINK|_LINK_|CFLAGS|CXXFLAGS|LDFLAGS|CPATH|CPLUS_INCLUDE_PATH|C_INCLUDE_PATH|LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/iu.test(key))
      continue;
    result[key] = value;
  }
  const paths = (envValue(source, 'PATH') ?? '').split(path.delimiter).filter(Boolean).filter(value => {
    const normalized = path.resolve(value.replace(/^"|"$/gu, '')).toLowerCase();
    return !roots.some(directory => normalized === directory || normalized.startsWith(directory + path.sep))
      && !/(?:^|[\\/])(?:Microsoft Visual Studio|Windows Kits|MSBuild)(?:[\\/]|$)|[\\/]VC[\\/]Tools[\\/]MSVC[\\/]|[\\/]Common7[\\/](?:IDE|Tools)(?:[\\/]|$)/iu.test(normalized);
  });
  result.PATH = paths.join(path.delimiter);
  return result;
}

function buildEnvironment(toolchain, python, source = process.env) {
  const env = cleanWindowsEnvironment(source);
  const { visualStudio: vs, sdk } = toolchain;
  Object.assign(env, {
    PATH: [toolchain.compilerDirectory, path.dirname(toolchain.msbuild),
      path.join(sdk.root, 'bin', sdk.directoryVersion, 'x64'), path.dirname(process.execPath),
      python && path.dirname(python), env.PATH].filter(Boolean).join(path.delimiter),
    DEPOT_TOOLS_WIN_TOOLCHAIN: '0', DEPOT_TOOLS_UPDATE: '0',
    GYP_MSVS_OVERRIDE_PATH: vs.path, vs2022_install: vs.path, GYP_MSVS_VERSION: '2022',
    VCToolsVersion: vs.toolsVersion, WindowsSdkDir: sdk.root,
    WindowsSDKVersion: sdk.directoryVersion + '\\', WindowsTargetPlatformVersion: sdk.directoryVersion,
    UniversalCRTSdkDir: sdk.root, UCRTVersion: sdk.directoryVersion,
    MSBUILDDISABLENODEREUSE: '1', VSCMD_SKIP_SENDTELEMETRY: '1',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', SETUPTOOLS_USE_DISTUTILS: 'stdlib',
  });
  if (python) Object.assign(env, { PYTHON: python, NODE_GYP_FORCE_PYTHON: python });
  return env;
}

function resolveWindowsToolchain(options = {}, dependencies = {}) {
  const { io = fs, run = execute, env = process.env, platform = process.platform, arch = process.arch } = dependencies;
  requireValue(platform === 'win32' && arch === 'x64', 'ERR_RTC_PLATFORM', 'The native Windows toolchain requires Windows x64.');
  const python = absolutePath(options.python ?? envValue(env, 'PYTHON') ??
    path.resolve(root, '..', '..', '..', '..', '.native-screen', 'python', 'Scripts', 'python.exe'),
  'Python 3.11 (--python= or PYTHON)');
  const pythonFile = regularFile(io, python, 'ERR_RTC_PYTHON_VERSION',
    'Provide --python=<installed CPython 3.11 x64 executable>, not a launcher.');
  requireValue(pythonFile.size > 0 && ['python.exe', 'python3.exe'].includes(path.basename(python).toLowerCase())
    && installedPython(python, io, true), 'ERR_RTC_PYTHON_VERSION',
  'Select the installed CPython 3.11 x64 executable or its existing venv, not Python Manager/Store/py.exe; no launcher was executed.');
  const request = vswhereRequest(options, env, io);
  const child = cleanWindowsEnvironment(env);
  const invocation = { env: child, capture: true, timeout: 30000 };
  const instances = parseMetadata(run(request.executable, request.args, invocation), 'vswhere');
  const metadata = parseMetadata(run(python, metadataArguments(options), invocation), 'Python/SDK metadata');
  requireValue(metadata && Array.isArray(metadata.pythonVersion) && metadata.pythonVersion.slice(0, 2).join('.') === '3.11'
    && metadata.pythonPointerBits === 64, 'ERR_RTC_PYTHON_VERSION', 'Use installed CPython 3.11 x64; no interpreter or tools were installed.');
  return { ...inspectWindowsToolchain(instances, metadata, options, io), python };
}

function msvcEnvironment(toolchain, source = process.env, run = execute) {
  const env = buildEnvironment(toolchain, toolchain.python, source);
  const comspec = absolutePath(envValue(env, 'ComSpec'), 'ComSpec');
  const node = absolutePath(process.execPath, 'Node.js');
  // JSON preserves Unicode and multiline values instead of cmd's OEM-encoded `set` output.
  const command = `"call "${toolchain.vcvars}" ${toolchain.sdk.directoryVersion} -vcvars_ver=${toolchain.visualStudio.toolsVersion} >nul && "${node}" -e "process.stdout.write(JSON.stringify(process.env))""`;
  const output = run(comspec, ['/d', '/s', '/c', command],
    { env, capture: true, timeout: 30000, windowsVerbatimArguments: true });
  const loaded = parseMetadata(output, 'vcvars environment');
  requireValue(loaded && typeof loaded === 'object' && !Array.isArray(loaded)
    && Object.values(loaded).every(value => typeof value === 'string'),
  'ERR_RTC_TOOLCHAIN_ENV', 'vcvars returned an invalid environment.');
  const expectedPaths = {
    VSINSTALLDIR: toolchain.visualStudio.path,
    VCToolsInstallDir: path.resolve(toolchain.compilerDirectory, '..', '..', '..'),
    WindowsSdkDir: toolchain.sdk.root, UniversalCRTSdkDir: toolchain.sdk.root,
  };
  for (const [name, expected] of Object.entries(expectedPaths)) {
    const actual = envValue(loaded, name);
    requireValue(actual && samePath(actual, expected), 'ERR_RTC_TOOLCHAIN_ENV',
      `vcvars selected an unexpected ${name}; expected ${expected}, received ${actual}. Open a clean PowerShell and check the selected VS2022/SDK installation.`);
  }
  for (const [name, expected] of Object.entries({
    VCToolsVersion: toolchain.visualStudio.toolsVersion,
    WindowsSDKVersion: toolchain.sdk.directoryVersion,
    UCRTVersion: toolchain.sdk.directoryVersion,
    VSCMD_ARG_HOST_ARCH: 'x64', VSCMD_ARG_TGT_ARCH: 'x64',
  })) {
    requireValue(envValue(loaded, name)?.replace(/[\\/]$/u, '') === expected, 'ERR_RTC_TOOLCHAIN_ENV',
      `vcvars did not retain ${name}=${expected}; refusing a different toolset or SDK.`);
  }
  requireValue(envValue(loaded, 'INCLUDE') && envValue(loaded, 'LIB') && envValue(loaded, 'LIBPATH'),
    'ERR_RTC_TOOLCHAIN_ENV', 'vcvars did not initialize the C++ include/library paths; repair the selected VS2022 installation.');
  return loaded;
}

function msbuildArguments(toolchain) {
  return [`/p:PlatformToolset=${toolchain.visualStudio.toolset}`,
    `/p:VCToolsVersion=${toolchain.visualStudio.toolsVersion}`,
    `/p:WindowsTargetPlatformVersion=${toolchain.sdk.directoryVersion}`,
    `/p:WindowsSdkDir=${toolchain.sdk.root}${path.sep}`, `/p:UniversalCRTSdkDir=${toolchain.sdk.root}${path.sep}`,
    `/p:UCRTVersion=${toolchain.sdk.directoryVersion}`];
}

function summary(toolchain) {
  return { visualStudio: toolchain.visualStudio, sdk: toolchain.sdk,
    compilerDirectory: toolchain.compilerDirectory, msbuild: toolchain.msbuild,
    crtVersion: toolchain.crt.version, rejected: toolchain.rejected };
}

function options(argv) {
  const result = {};
  const seen = new Set();
  for (const argument of argv) {
    const at = argument.indexOf('='), key = argument.slice(0, at), value = argument.slice(at + 1);
    requireValue(at > 0 && value && !seen.has(key), 'ERR_RTC_ARGUMENT', 'Use unique --python=, --vs-install=, --sdk-root= and --vswhere= options.');
    seen.add(key);
    if (key === '--python') result.python = absolutePath(value, key);
    else requireValue(selectionOption(result, key, value), 'ERR_RTC_ARGUMENT', `Unknown toolchain option: ${key}`);
  }
  return result;
}

module.exports = {
  WindowsToolchainError, SDK_FILES, VC_FILES, VS_FILES, compatibleTools, envValue, installedPython,
  selectionOption, selectionArguments, vswhereRequest, metadataArguments, inspectWindowsToolchain,
  cleanWindowsEnvironment, buildEnvironment, resolveWindowsToolchain, msvcEnvironment,
  msbuildArguments, summary, options,
};

if (require.main === module) {
  try {
    const toolchain = resolveWindowsToolchain(options(process.argv.slice(2)));
    msvcEnvironment(toolchain);
    console.log(JSON.stringify({ windowsToolchainReady: true, ...summary(toolchain),
      buildsStarted: false, downloadsStarted: false }, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
