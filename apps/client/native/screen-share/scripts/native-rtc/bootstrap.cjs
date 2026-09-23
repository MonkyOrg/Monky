'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const windowsToolchain = require('../windowsToolchain.cjs');

const OWNER = '.native-rtc-owner.json';
const STATE = '.native-rtc-state.json';
const LOCK = '.native-rtc-lock.json';
const OWNER_NAME = 'monky-native-rtc-source-bootstrap';
const REPOSITORIES = ['depot_tools', 'webrtc', 'libmediasoupclient', 'libsdptransform'];
const DIRECTORIES = {
  depot_tools: 'depot_tools',
  webrtc: path.join('webrtc', 'src'),
  libmediasoupclient: 'libmediasoupclient',
  libsdptransform: 'libsdptransform',
};
const SHA = /^[0-9a-f]{40}$/u;
const MAX_TEXT = 1024 * 1024;
const MAX_GIT_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_REPOSITORIES = 1024;

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new BootstrapError(code, message);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function inside(root, value) {
  const relative = path.relative(root, value);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function version(value, minimum) {
  const parts = String(value).split('.').map(Number);
  if (parts.length < minimum.length || parts.some(part => !Number.isSafeInteger(part) || part < 0)) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

function httpsSource(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
}

function validateManifest(manifest) {
  requireValue(manifest.schemaVersion === 1 && manifest.scope === 'source-dependencies',
    'ERR_RTC_MANIFEST', 'Expected the pinned native source dependency manifest.');
  requireValue(Object.keys(manifest.repositories).sort().join() === [...REPOSITORIES].sort().join(),
    'ERR_RTC_MANIFEST', 'The manifest must contain exactly the four explicitly selected repositories.');
  for (const name of REPOSITORIES) {
    const repo = manifest.repositories[name];
    requireValue(SHA.test(repo.commit) && httpsSource(repo.url) &&
      typeof repo.directory === 'string' &&
      path.win32.normalize(repo.directory).toLowerCase() === path.win32.normalize(DIRECTORIES[name]).toLowerCase() &&
      repo.license?.file === 'LICENSE',
    'ERR_RTC_MANIFEST', `Invalid immutable pin/source/directory/license for ${name}.`);
  }
  requireValue(manifest.bootstrap.solutionName === 'src' && manifest.bootstrap.managed === false &&
    manifest.bootstrap.runHooks === false && manifest.bootstrap.depotToolsUpdate === '0' &&
    manifest.bootstrap.depotToolsWinToolchain === '0',
  'ERR_RTC_MANIFEST', 'The bootstrap must remain unmanaged, frozen and source-only.');
  const runtime = manifest.bootstrap.gclientRuntime;
  requireValue(runtime?.python?.join('.') === '3.11' && runtime.pointerBits === 64 &&
    runtime.includeSystemSitePackages === false && Array.isArray(runtime.requirements) &&
    runtime.requirements.length === 2 && runtime.requirements.every(requirement =>
      ['httplib2', 'six'].includes(requirement.distribution) && requirement.module === requirement.distribution &&
      typeof requirement.version === 'string' && Array.isArray(requirement.imports) &&
      requirement.imports.length <= 8 && requirement.imports.every(name => /^[a-z_][a-z0-9_.]*$/u.test(name))),
  'ERR_RTC_MANIFEST', 'Missing pinned, separately provisioned gclient runtime requirements.');
}

function layout(moduleDir) {
  const clientRoot = path.resolve(moduleDir, '..', '..', '..', '..');
  const repository = path.resolve(clientRoot, '..', '..');
  const expectedModule = path.join(clientRoot, 'native', 'screen-share', 'scripts', 'native-rtc');
  requireValue(samePath(moduleDir, expectedModule), 'ERR_RTC_LAYOUT', 'Unexpected bootstrap source layout.');
  const artifacts = path.join(repository, '.native-screen');
  return { moduleDir: path.resolve(moduleDir), clientRoot, repository, artifacts,
    workspace: path.join(artifacts, 'rtc') };
}

function createContext(overrides = {}) {
  const io = overrides.fs || fs;
  const moduleDir = overrides.moduleDir || __dirname;
  const manifest = overrides.manifest || JSON.parse(io.readFileSync(path.join(moduleDir, 'pins.json'), 'utf8'));
  validateManifest(manifest);
  const paths = layout(moduleDir);
  const pinHash = digest(JSON.stringify({
    repositories: REPOSITORIES.map(name => ({ name, url: manifest.repositories[name].url,
      commit: manifest.repositories[name].commit, directory: DIRECTORIES[name] })),
    solution: 'src', managed: false, hooks: false, platform: 'win32', arch: 'x64',
    gclientRuntime: manifest.bootstrap.gclientRuntime, dependencyStateVersion: 2,
  }));
  return {
    fs: io, manifest, paths, pinHash,
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    nodeVersion: overrides.nodeVersion || process.versions.node,
    env: { ...(overrides.env || process.env) },
    runner: overrides.runner || spawnRunner,
    log: overrides.log || (() => {}),
    randomId: overrides.randomId || crypto.randomUUID,
    tools: {},
    options: {},
    downloadCommands: 0,
  };
}

function exists(context, filename) {
  try { context.fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function boundedText(context, filename, limit = MAX_TEXT) {
  const entry = context.fs.lstatSync(filename);
  requireValue(entry.isFile() && !entry.isSymbolicLink() && entry.size <= limit,
    'ERR_RTC_FILE', `Expected a bounded, non-linked file: ${filename}`);
  return context.fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, '');
}

function jsonFile(context, filename) {
  try { return JSON.parse(boundedText(context, filename)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new BootstrapError('ERR_RTC_JSON', `Invalid JSON; not overwritten: ${filename}`);
    throw error;
  }
}

function inspectPath(context, filename, root = context.paths.repository) {
  const absolute = path.resolve(filename);
  requireValue(inside(root, absolute), 'ERR_RTC_PATH', 'A bootstrap path escapes its dedicated repository/workspace.');
  const entries = [];
  let current = absolute;
  while (true) {
    entries.push(current);
    if (samePath(current, root)) break;
    const parent = path.dirname(current);
    requireValue(parent !== current, 'ERR_RTC_PATH', 'Cannot establish path ancestry.');
    current = parent;
  }
  for (const entry of entries.reverse()) {
    if (!exists(context, entry)) continue;
    const stat = context.fs.lstatSync(entry);
    requireValue(!stat.isSymbolicLink() && samePath(context.fs.realpathSync(entry), entry),
      'ERR_RTC_PATH_ALIAS', `Symlink, junction or path alias is not accepted: ${entry}`);
  }
}

function envValue(env, name) {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function childEnvironment(context) {
  const result = {};
  const clean = windowsToolchain.cleanWindowsEnvironment(context.env);
  for (const [key, value] of Object.entries(clean)) {
    if (/^(GIT_|GCM_|PYTHON|DEPOT_TOOLS_|VPYTHON_|CIPD_|GCLIENT_|GYP_|GN_)/iu.test(key) ||
        /^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|TEMP|TMP|INCLUDE|LIB|LIBPATH|VIRTUAL_ENV|__PYVENV_LAUNCHER__|ELECTRON_RUN_AS_NODE)$/iu.test(key)) continue;
    result[key] = value;
  }
  const cache = path.join(context.paths.workspace, 'cache');
  const home = path.join(cache, 'home');
  const pathParts = [
    context.tools.gclientPython && path.dirname(context.tools.gclientPython),
    context.tools.git && path.dirname(context.tools.git),
    context.tools.python && path.dirname(context.tools.python),
    path.join(context.paths.workspace, 'depot_tools'),
    clean.PATH,
  ].filter(Boolean);
  Object.assign(result, {
    PATH: pathParts.join(path.delimiter),
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.slice(0, 2),
    HOMEPATH: home.slice(2), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TEMP: path.join(cache, 'tmp'), TMP: path.join(cache, 'tmp'),
    CIPD_CACHE_DIR: path.join(cache, 'cipd'),
    VPYTHON_VIRTUALENV_ROOT: path.join(cache, 'vpython'),
    DEPOT_TOOLS_UPDATE: '0', DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(context.paths.workspace, '.hooks-disabled'),
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.untrackedCache', GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'credential.helper', GIT_CONFIG_VALUE_3: '',
    GIT_CONFIG_KEY_4: 'core.longpaths', GIT_CONFIG_VALUE_4: 'true',
    PYTHONDONTWRITEBYTECODE: '1',
  });
  if (context.tools.windowsToolchain) {
    const selected = windowsToolchain.buildEnvironment(context.tools.windowsToolchain,
      context.tools.gclientPython || context.tools.python, result);
    Object.assign(result, selected, { PATH: result.PATH });
  }
  if (context.tools.gclientPython) result.VIRTUAL_ENV = path.dirname(path.dirname(context.tools.gclientPython));
  return result;
}

function spawnRunner(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(request.exe, request.args, {
      cwd: request.cwd, env: request.env, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let failure = null;
    let truncated = false;
    const cancel = error => {
      if (failure) return;
      failure = error;
      // The guarded child's private job contains only this invocation's descendants.
      if (request.guarded) child.stdin.end();
      else child.kill();
    };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', chunk => {
        const joined = Buffer.concat([buffers[name], chunk]);
        if (joined.length > request.maxOutputBytes) {
          if (!request.tail) {
            cancel(new BootstrapError('ERR_RTC_OUTPUT_LIMIT', `Bounded output exceeded: ${request.label}`));
          }
          truncated = true;
          buffers[name] = joined.subarray(joined.length - request.maxOutputBytes);
        } else buffers[name] = joined;
      });
    }
    const timer = setTimeout(() => {
      cancel(new BootstrapError('ERR_RTC_COMMAND_TIMEOUT', `Command deadline exceeded: ${request.label}`));
      if (request.guarded) child.kill();
    }, request.timeoutMs);
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') cancel(error);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, signal, stdout: buffers.stdout.toString('utf8'),
        stderr: buffers.stderr.toString('utf8'), truncated });
    });
    if (!request.guarded) child.stdin.end(request.input || '');
  });
}

async function command(context, exe, args, options = {}) {
  requireValue(path.isAbsolute(exe) && exe.toLowerCase().endsWith('.exe'),
    'ERR_RTC_EXECUTABLE', 'Only an explicit absolute executable may be spawned; shell/batch fallback is forbidden.');
  const guarded = options.mutating === true;
  const timeoutSeconds = context.options.commandTimeoutSeconds || 1800;
  const effectiveArgs = guarded
    ? ['-I', '-S', '-B', path.join(context.paths.moduleDir, 'owned_process.py'),
      '--cwd', options.cwd || context.paths.workspace,
      '--timeout-seconds', String(timeoutSeconds), '--', exe, ...args]
    : args;
  const result = await context.runner({
    exe: guarded ? context.tools.python : exe,
    args: effectiveArgs,
    cwd: options.cwd || context.paths.repository,
    env: childEnvironment(context),
    timeoutMs: guarded ? timeoutSeconds * 1000 + 10000 : 15000,
    maxOutputBytes: options.maxOutputBytes || (guarded ? 128 * 1024 : 8 * 1024 * 1024),
    tail: guarded, guarded, input: options.input,
    label: options.label || path.basename(exe),
  });
  requireValue(result && typeof result.stdout === 'string' && typeof result.stderr === 'string',
    'ERR_RTC_RUNNER', 'The command runner did not return a valid result.');
  if (result.code !== 0) {
    throw new BootstrapError('ERR_RTC_COMMAND',
      `${options.label || path.basename(exe)} failed (exit ${result.code ?? 'none'}${result.signal ? `, ${result.signal}` : ''}). ` +
      result.stderr.slice(-2000).trim());
  }
  return result.stdout;
}

function parseJsonOutput(value, name) {
  try { return JSON.parse(value.replace(/^\uFEFF/u, '')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new BootstrapError('ERR_RTC_TOOL_OUTPUT', `${name} returned invalid JSON.`);
    throw error;
  }
}

function executable(context, explicit, names, label) {
  const candidates = explicit ? [explicit] : (envValue(context.env, 'PATH') || '')
    .split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.join(directory, name)));
  const python = names.includes('python.exe');
  if (python && !explicit) {
    // Python Manager's bin/python.exe can install a runtime. Never execute it.
    // Discover only already installed sibling runtimes relative to that PATH entry.
    for (const candidate of [...candidates]) {
      const directory = path.dirname(candidate);
      const manager = path.dirname(directory);
      if (path.basename(directory).toLowerCase() !== 'bin' ||
          path.basename(manager).toLowerCase() !== 'python' || !exists(context, manager)) continue;
      const entries = context.fs.readdirSync(manager);
      requireValue(entries.length <= 128, 'ERR_RTC_TOOL_SELECTION', 'Python runtime directory enumeration exceeds its bound.');
      for (const entry of entries) {
        if (/^pythoncore-[0-9.]+-64$/iu.test(entry)) candidates.push(path.join(manager, entry, 'python.exe'));
      }
    }
  }
  const selected = new Map();
  for (const filename of candidates) {
    if (!path.isAbsolute(filename) || !names.includes(path.basename(filename).toLowerCase()) ||
        /[\\/]WindowsApps[\\/]/iu.test(filename) || !exists(context, filename)) continue;
    const stat = context.fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) continue;
    const canonical = context.fs.realpathSync(filename);
    if (python && !windowsToolchain.installedPython(canonical, context.fs)) continue;
    const identity = stat.ino ? `${stat.dev}:${stat.ino}` : canonical.toLowerCase();
    selected.set(identity, canonical);
  }
  requireValue(selected.size === 1, 'ERR_RTC_TOOL_SELECTION',
    `${label}: expected one real installed executable; found ${selected.size}. Select it explicitly if missing/ambiguous.`);
  return [...selected.values()][0];
}

async function prerequisites(context, options, report) {
  const { baseline } = context.manifest;
  requireValue(context.platform === baseline.platform && context.arch === baseline.architecture,
    'ERR_RTC_PLATFORM', 'This source bootstrap requires Windows x64; no download or mutation was attempted.');
  requireValue(version(context.nodeVersion, [baseline.nodeMinimumMajor]),
    'ERR_RTC_NODE', `Node ${baseline.nodeMinimumMajor}+ is required for this wrapper.`);
  context.tools.git = executable(context, options.git, ['git.exe'], 'Git');
  context.tools.python = executable(context, options.python, ['python.exe', 'python3.exe'], 'Python 3');
  const gitVersion = await command(context, context.tools.git, ['--version'], { label: 'Git version' });
  const matched = /^git version ([0-9]+(?:\.[0-9]+)+)/mu.exec(gitVersion);
  requireValue(matched && version(matched[1], baseline.gitMinimum),
    'ERR_RTC_GIT_VERSION', 'Git 2.31+ is required for isolated per-child configuration.');
  report.tools.git = { path: context.tools.git, version: matched[1] };
  const metadata = parseJsonOutput(await command(context, context.tools.python,
    windowsToolchain.metadataArguments(options),
    { label: 'Read-only Windows SDK/Python metadata' }), 'Windows metadata');
  requireValue(Array.isArray(metadata.pythonVersion) && version(metadata.pythonVersion.join('.'), baseline.pythonMinimum),
    'ERR_RTC_PYTHON_VERSION', 'A preinstalled Python 3.8+ is required; no interpreter is bootstrapped automatically.');
  requireValue(metadata.pythonPointerBits === 64, 'ERR_RTC_PYTHON_ARCH',
    'A 64-bit Python interpreter is required by the private job guardian; nothing was created or downloaded.');
  report.tools.python = { path: context.tools.python, version: metadata.pythonVersion.join('.'), pointerBits: 64 };
  await gclientPrerequisite(context, options, report);

  const request = windowsToolchain.vswhereRequest(options, context.env, context.fs);
  const instances = parseJsonOutput(await command(context, request.executable, request.args,
    { label: 'VS2022 C++/ATL/MFC component metadata' }), 'vswhere');
  const selected = windowsToolchain.inspectWindowsToolchain(instances, metadata, options, context.fs);
  context.tools.windowsToolchain = selected;
  Object.assign(report.tools, { visualStudio: selected.visualStudio, sdk: selected.sdk,
    rejectedVisualStudioInstallations: selected.rejected });
}

async function gclientPrerequisite(context, options, report) {
  requireValue(options.gclientPython, 'ERR_RTC_GCLIENT_PYTHON',
    'Select --gclient-python=<preprovisioned venv\\Scripts\\python.exe>; no runtime or packages are installed automatically.');
  const selected = path.resolve(options.gclientPython);
  const venv = path.dirname(path.dirname(selected));
  requireValue(path.basename(selected).toLowerCase() === 'python.exe' &&
    path.basename(path.dirname(selected)).toLowerCase() === 'scripts' &&
    inside(context.paths.artifacts, venv) && !samePath(context.paths.artifacts, venv) &&
    !inside(context.paths.workspace, venv) && !inside(venv, context.paths.workspace),
  'ERR_RTC_GCLIENT_VENV', 'gclient venv must be in the ignored native cache, separate from the source workspace.');
  inspectPath(context, selected);
  requireValue(exists(context, selected) && context.fs.lstatSync(selected).isFile(),
    'ERR_RTC_GCLIENT_VENV', 'The selected gclient venv interpreter is missing.');
  const configPath = path.join(venv, 'pyvenv.cfg');
  requireValue(exists(context, configPath), 'ERR_RTC_GCLIENT_VENV', 'The selected gclient runtime has no pyvenv.cfg.');
  const config = boundedText(context, configPath, 16384);
  const values = [...config.matchAll(/^\s*include-system-site-packages\s*=\s*(\S+)\s*$/gimu)];
  requireValue(values.length === 1 && values[0][1].toLowerCase() === 'false',
    'ERR_RTC_GCLIENT_VENV', 'gclient venv must explicitly set include-system-site-packages=false.');
  await git(context, context.paths.repository, ['check-ignore', '--no-index', '--', selected],
    { label: 'Verify separate gclient runtime is ignored' });
  context.tools.gclientPython = selected;
  const observed = parseJsonOutput(await command(context, selected,
    ['-B', '-E', '-s', path.join(context.paths.moduleDir, 'windows_support.py'), 'gclient-runtime'],
    { input: JSON.stringify(context.manifest.bootstrap.gclientRuntime),
      label: 'Validate provisioned gclient runtime/imports before any source acquisition' }), 'gclient runtime');
  const expected = context.manifest.bootstrap.gclientRuntime;
  requireValue(Array.isArray(observed.pythonVersion) &&
    observed.pythonVersion.slice(0, 2).join('.') === expected.python.join('.') &&
    observed.pythonImplementation === 'cpython' &&
    observed.pythonPointerBits === expected.pointerBits &&
    observed.includeSystemSitePackages === false &&
    [observed.prefix, observed.executable, observed.basePrefix].every(value => typeof value === 'string' && path.isAbsolute(value)) &&
    samePath(observed.prefix, venv) &&
    samePath(observed.executable, selected) && !samePath(observed.basePrefix, venv) &&
    Array.isArray(observed.requirements) && observed.requirements.length === expected.requirements.length &&
    expected.requirements.every(requirement => observed.requirements.some(actual =>
      actual.distribution === requirement.distribution && actual.version === requirement.version &&
      actual.module === requirement.module && typeof actual.origin === 'string' &&
      inside(path.join(venv, 'Lib', 'site-packages'), actual.origin))),
  'ERR_RTC_GCLIENT_RUNTIME', 'gclient runtime does not match the isolated Python/dependency specification.');
  report.tools.gclientPython = { path: selected, venv, version: observed.pythonVersion.join('.'),
    pointerBits: observed.pythonPointerBits, requirements: observed.requirements };
}

function git(context, directory, args, options = {}) {
  return command(context, context.tools.git, ['--no-optional-locks', '--no-pager', '-C', directory, ...args],
    { cwd: directory, ...options });
}

async function literal(context, text) {
  return parseJsonOutput(await command(context, context.tools.python,
    ['-I', '-S', '-B', path.join(context.paths.moduleDir, 'windows_support.py'), 'literal'],
    { input: text, label: 'Read-only literal configuration validation', maxOutputBytes: MAX_TEXT }), 'Literal parser');
}

function validateConfig(config, url) {
  const allowed = ['solutions', 'cache_dir', 'target_os'];
  requireValue(config && Object.keys(config).every(key => allowed.includes(key)) &&
    Object.hasOwn(config, 'cache_dir') && config.cache_dir === null &&
    (!Object.hasOwn(config, 'target_os') || (Array.isArray(config.target_os) && !config.target_os.length)) &&
    Array.isArray(config.solutions) && config.solutions.length === 1,
  'ERR_RTC_GCLIENT_CONFIG', 'Existing .gclient must explicitly disable the shared Git cache (cache_dir=None) and contain no executable/extra/ambiguous configuration; it will not be overwritten.');
  const solution = config.solutions[0];
  const fields = ['name', 'url', 'deps_file', 'managed', 'custom_deps', 'custom_vars', 'safesync_url'];
  requireValue(solution && Object.keys(solution).every(key => fields.includes(key)) &&
    solution.name === 'src' && solution.url === url && solution.deps_file === 'DEPS' && solution.managed === false &&
    (!Object.hasOwn(solution, 'safesync_url') || solution.safesync_url === '') &&
    ['custom_deps', 'custom_vars'].every(key => !Object.hasOwn(solution, key) ||
      (solution[key] && !Array.isArray(solution[key]) && typeof solution[key] === 'object' && !Object.keys(solution[key]).length)),
  'ERR_RTC_GCLIENT_CONFIG', 'Existing .gclient does not describe the exact unmanaged, unmodified pinned solution.');
}

function parseLocalConfig(text) {
  const values = new Map();
  for (const record of text.split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\n');
    requireValue(separator > 0, 'ERR_RTC_GIT_CONFIG', 'Malformed local Git configuration output.');
    const key = record.slice(0, separator).toLowerCase();
    const value = record.slice(separator + 1);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  return values;
}

function safeGitConfig(values, expectedUrl) {
  const safe = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks|longpaths|autocrlf|fscache|precomposeunicode)|gc\.(auto|autodetach)|remote\.origin\.(url|fetch|tagopt)|branch\.[^.]+\.(remote|merge)|extensions\.objectformat)$/u;
  const gclientSettings = new Map([
    ['blame.ignorerevsfile', '.git-blame-ignore-revs'],
    ['diff.ignoresubmodules', 'dirty'],
    ['fetch.recursesubmodules', 'off'],
    ['push.recursesubmodules', 'off'],
  ]);
  for (const [key, value] of values) {
    if (gclientSettings.has(key)) {
      requireValue(value.length === 1 && value[0] === gclientSettings.get(key),
        'ERR_RTC_GIT_CONFIG', `Unexpected value for gclient's local Git setting (${key}).`);
      continue;
    }
    requireValue(safe.test(key), 'ERR_RTC_GIT_CONFIG',
      `Unsupported local Git configuration (${key}); no includes, filters, hooks, alternate worktrees or partial clones are adopted.`);
    if (key === 'core.bare') requireValue(value.length === 1 && value[0] === 'false', 'ERR_RTC_GIT_CONFIG', 'Bare checkouts are not accepted.');
    if (key === 'extensions.objectformat') requireValue(value.length === 1 && value[0] === 'sha1', 'ERR_RTC_GIT_CONFIG', 'Unexpected Git object format.');
  }
  const urls = values.get('remote.origin.url');
  requireValue(urls?.length === 1 && urls[0] === expectedUrl, 'ERR_RTC_ORIGIN', 'Origin does not match the recorded source identity.');
}

async function inspectCheckout(context, directory, expected, repositories = []) {
  inspectPath(context, directory, context.paths.workspace);
  const gitDirectory = path.join(directory, '.git');
  requireValue(exists(context, gitDirectory) && context.fs.lstatSync(gitDirectory).isDirectory(),
    'ERR_RTC_CHECKOUT_PARTIAL', `Expected an independent, complete Git checkout: ${directory}`);
  inspectPath(context, gitDirectory, context.paths.workspace);
  for (const name of ['objects\\info\\alternates', 'info\\grafts', 'commondir']) {
    requireValue(!exists(context, path.join(gitDirectory, ...name.split('\\'))), 'ERR_RTC_GIT_SHARED',
      'Shared objects, grafts and linked worktree metadata are not accepted.');
  }
  const values = parseLocalConfig(await git(context, directory,
    ['config', '--local', '--no-includes', '--null', '--list'], { label: 'Read local Git identity/configuration' }));
  safeGitConfig(values, expected.url);
  const top = (await git(context, directory, ['rev-parse', '--show-toplevel'], { label: 'Read checkout root' })).trim();
  const common = (await git(context, directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { label: 'Read independent Git directory' })).trim();
  requireValue(samePath(top, directory) && samePath(common, gitDirectory),
    'ERR_RTC_GIT_SHARED', 'Checkout resolves to another worktree or shared Git directory.');
  const head = (await git(context, directory, ['rev-parse', '--verify', 'HEAD^{commit}'],
    { label: 'Read immutable checkout HEAD' })).trim();
  requireValue(SHA.test(head) && (!expected.commit || head === expected.commit),
    'ERR_RTC_HEAD', 'Checkout HEAD differs from its immutable pin; no checkout/reset is attempted.');
  const entries = await git(context, directory, ['ls-files', '-v', '-z'], {
    label: 'Inspect hidden index flags', maxOutputBytes: MAX_GIT_INDEX_BYTES });
  requireValue(entries.split('\0').every(entry => !entry || entry.startsWith('H ')),
    'ERR_RTC_HIDDEN_INDEX', 'Assume-unchanged, skip-worktree, sparse or unmerged index entries are not accepted.');
  const status = await git(context, directory,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    { label: 'Read-only clean-worktree check' });
  // Gclient nests independent Git roots that their parent may report as untracked.
  // Each declared child is inspected independently; no files inside it are exempt.
  const nested = new Set(repositories.map(entry => path.join(context.paths.workspace, entry.directory))
    .filter(child => inside(directory, child) && !samePath(directory, child))
    .map(child => `?? ${path.relative(directory, child).split(path.sep).join('/')}/`));
  requireValue(status.length === 0 || (status.endsWith('\0') &&
    status.slice(0, -1).split('\0').every(entry => nested.has(entry))),
  'ERR_RTC_DIRTY', `Checkout has staged, unstaged or untracked changes; nothing will be reset: ${directory}`);
  return { directory: path.relative(context.paths.workspace, directory), url: expected.url, commit: head };
}

function ownerDocument(context, id) {
  return { schemaVersion: 1, owner: OWNER_NAME, id, repository: context.paths.repository,
    workspace: context.paths.workspace, pinsHash: context.pinHash };
}

function validateOwner(context, owner) {
  requireValue(owner && Object.keys(owner).sort().join() ===
    ['schemaVersion', 'owner', 'id', 'repository', 'workspace', 'pinsHash'].sort().join() &&
    owner.schemaVersion === 1 && owner.owner === OWNER_NAME &&
    /^[0-9a-f-]{36}$/u.test(owner.id) && samePath(owner.repository, context.paths.repository) &&
    samePath(owner.workspace, context.paths.workspace) && owner.pinsHash === context.pinHash,
  'ERR_RTC_OWNERSHIP', 'Workspace ownership/path/pins do not match; no directory or checkout is adopted.');
}

function validateState(context, owner, state) {
  requireValue(state?.schemaVersion === 2 && state.ownerId === owner.id &&
    state.pinsHash === context.pinHash && state.completed === true &&
    Array.isArray(state.repositories) && state.repositories.length >= 4 &&
    state.repositories.length <= MAX_REPOSITORIES &&
    Array.isArray(state.artifacts) && state.artifacts.length <= MAX_REPOSITORIES &&
    /^[0-9a-f]{64}$/u.test(state.configHash) && /^[0-9a-f]{64}$/u.test(state.entriesHash),
  'ERR_RTC_STATE', 'Completed source state is missing, malformed or belongs to other pins.');
  const directories = new Set();
  for (const entry of state.repositories) {
    const resolved = typeof entry.directory === 'string'
      ? path.resolve(context.paths.workspace, entry.directory) : context.paths.repository;
    const sourceRoot = path.join(context.paths.workspace, DIRECTORIES.webrtc);
    requireValue(typeof entry.directory === 'string' && !path.isAbsolute(entry.directory) &&
      inside(context.paths.workspace, resolved) &&
      entry.directory === path.relative(context.paths.workspace, resolved) &&
      (Object.values(DIRECTORIES).some(value => samePath(value, entry.directory)) ||
       (inside(sourceRoot, resolved) && !samePath(sourceRoot, resolved))) &&
      SHA.test(entry.commit) && httpsSource(entry.url),
    'ERR_RTC_STATE', 'State contains an unsafe checkout identity or path.');
    const key = resolved.toLowerCase();
    requireValue(!directories.has(key), 'ERR_RTC_STATE', 'Duplicate checkout in completed state.');
    directories.add(key);
  }
  for (const name of REPOSITORIES) {
    const expected = context.manifest.repositories[name];
    const actual = state.repositories.find(entry => samePath(entry.directory, DIRECTORIES[name]));
    requireValue(actual && actual.url === expected.url && actual.commit === expected.commit,
      'ERR_RTC_STATE', 'Completed state does not retain every top-level immutable pin.');
  }
  const artifacts = new Set();
  for (const entry of state.artifacts) {
    requireValue(entry && typeof entry === 'object', 'ERR_RTC_STATE', 'Invalid typed dependency record.');
    const expected = dependencyEntry(entry.entry, entry.url ?? null);
    requireValue(expected.kind !== 'git' && JSON.stringify(entry) === JSON.stringify(expected),
      'ERR_RTC_STATE', 'Completed state contains an invalid typed dependency identity.');
    const key = `${entry.directory.toLowerCase()}:${entry.entry.slice(entry.entry.indexOf(':') + 1)}`;
    requireValue(!artifacts.has(key), 'ERR_RTC_STATE', 'Duplicate artifact in completed state.');
    artifacts.add(key);
  }
}

async function workspaceState(context, report) {
  const workspace = context.paths.workspace;
  inspectPath(context, workspace);
  const top = (await git(context, context.paths.repository, ['rev-parse', '--show-toplevel'],
    { label: 'Verify containing repository' })).trim();
  requireValue(samePath(top, context.paths.repository), 'ERR_RTC_LAYOUT', 'Source location is not the expected repository root.');
  await git(context, context.paths.repository, ['check-ignore', '--no-index', '--', path.join(workspace, OWNER)],
    { label: 'Verify dedicated workspace is ignored' });
  if (!exists(context, workspace)) return { owner: null, state: null };
  requireValue(context.fs.lstatSync(workspace).isDirectory(), 'ERR_RTC_OWNERSHIP', 'Workspace path is not a directory.');
  const ownerPath = path.join(workspace, OWNER);
  requireValue(exists(context, ownerPath), 'ERR_RTC_OWNERSHIP', 'An existing workspace without this bootstrap owner is not adopted, even if empty.');
  const owner = jsonFile(context, ownerPath);
  validateOwner(context, owner);
  const allowed = new Set([OWNER, STATE, LOCK, '.hooks-disabled', 'cache',
    'depot_tools', 'webrtc', 'libmediasoupclient', 'libsdptransform']);
  requireValue(context.fs.readdirSync(workspace).every(name => allowed.has(name)),
    'ERR_RTC_WORKSPACE_CONTENT', 'Unexpected workspace content; no cleanup or adoption is attempted.');
  for (const relative of ['.hooks-disabled', 'cache', 'cache\\home', 'cache\\tmp', 'cache\\cipd', 'cache\\vpython',
    ...Object.values(DIRECTORIES)]) inspectPath(context, path.join(workspace, ...relative.split('\\')), workspace);
  const hooks = path.join(workspace, '.hooks-disabled');
  requireValue(!exists(context, hooks) || context.fs.readdirSync(hooks).length === 0,
    'ERR_RTC_HOOKS', 'The isolated disabled-hooks directory must remain empty.');
  if (exists(context, path.join(workspace, LOCK))) {
    report.issues.push({ code: 'ERR_RTC_LOCKED',
      message: 'Workspace has a live or failed-operation lock. No PID guessing, automatic unlock or retry is performed.' });
  }
  const configFile = path.join(workspace, 'webrtc', '.gclient');
  if (exists(context, configFile)) {
    await validateConfig(await literal(context, boundedText(context, configFile)), context.manifest.repositories.webrtc.url);
  }
  const stateFile = path.join(workspace, STATE);
  const state = exists(context, stateFile) ? jsonFile(context, stateFile) : null;
  if (state) {
    validateState(context, owner, state);
    requireValue(exists(context, configFile) && digest(boundedText(context, configFile)) === state.configHash &&
      digest(boundedText(context, path.join(workspace, 'webrtc', '.gclient_entries'))) === state.entriesHash,
    'ERR_RTC_GCLIENT_DRIFT', 'gclient configuration/entries changed since completion; nothing is overwritten.');
    const entries = await dependencyEntries(context, boundedText(context, path.join(workspace, 'webrtc', '.gclient_entries')));
    const gitEntries = entries.filter(entry => entry.kind === 'git');
    const artifacts = entries.filter(entry => entry.kind !== 'git');
    requireValue(gitEntries.length === state.repositories.length - 3 &&
      gitEntries.every(entry => state.repositories.some(record =>
        record.directory === entry.directory && record.url === entry.url &&
        (!entry.revision || !SHA.test(entry.revision) || record.commit === entry.revision))) &&
      JSON.stringify(artifacts) === JSON.stringify(state.artifacts),
    'ERR_RTC_STATE', 'Completed state does not cover every Git/CIPD/GCS/excluded gclient entry.');
    for (const entry of state.repositories) {
      await inspectCheckout(context, path.join(workspace, entry.directory), entry, state.repositories);
    }
    inspectArtifacts(context, artifacts);
    report.dependencyCounts = dependencyCounts(entries);
    report.artifactContentIntegrityVerified = false;
    report.sourceBootstrapComplete = true;
  } else {
    requireValue(!exists(context, path.join(workspace, DIRECTORIES.webrtc)) &&
      !exists(context, path.join(workspace, 'webrtc', '.gclient_entries')),
    'ERR_RTC_PARTIAL_SYNC', 'An existing/partial WebRTC source tree is never resynced automatically. Review it manually.');
    for (const name of REPOSITORIES.filter(value => value !== 'webrtc')) {
      const directory = path.join(workspace, DIRECTORIES[name]);
      if (exists(context, directory)) await inspectCheckout(context, directory, context.manifest.repositories[name]);
    }
    const webrtcRoot = path.join(workspace, 'webrtc');
    requireValue(!exists(context, webrtcRoot) ||
      context.fs.readdirSync(webrtcRoot).every(name => name === '.gclient'),
    'ERR_RTC_PARTIAL_SYNC', 'Unexpected preexisting gclient workspace; no sync or cleanup is attempted.');
  }
  report.workspaceOwned = true;
  return { owner, state };
}

async function preflight(context, options = {}) {
  options = { action: 'check', commandTimeoutSeconds: 1800, ...options };
  requireValue(['check', 'fetch'].includes(options.action) &&
    Number.isSafeInteger(options.commandTimeoutSeconds) && options.commandTimeoutSeconds >= 1 &&
    options.commandTimeoutSeconds <= 7200, 'ERR_RTC_ARGUMENT', 'Invalid action or bounded command deadline.');
  for (const key of ['git', 'python', 'gclientPython', 'vswhere', 'vsInstall', 'sdkRoot']) {
    requireValue(options[key] === undefined || (typeof options[key] === 'string' && path.isAbsolute(options[key])),
      'ERR_RTC_ARGUMENT', 'Tool selections must be explicit absolute paths.');
  }
  context.options = options;
  const report = { schemaVersion: 1, mode: options.action || 'check', readOnly: true,
    workspace: context.paths.workspace, pinsHash: context.pinHash,
    workspaceOwned: false, sourceBootstrapComplete: false,
    canFetch: false, rtcBuildReady: false,
    downloadCommandsExecuted: 0, tools: {}, issues: [], limitations: context.manifest.limitations };
  let ownership = { owner: null, state: null };
  try {
    inspectPath(context, context.paths.workspace);
    await prerequisites(context, options, report);
    ownership = await workspaceState(context, report);
  } catch (error) {
    if (!(error instanceof BootstrapError) && !(error instanceof windowsToolchain.WindowsToolchainError)) throw error;
    report.issues.push({ code: error.code, message: error.message });
  }
  report.canFetch = report.issues.length === 0;
  if (!report.canFetch) report.sourceBootstrapComplete = false;
  report.status = report.canFetch ? (report.sourceBootstrapComplete ? 'sources-complete' : 'ready-for-explicit-fetch') : 'blocked';
  return { report, ...ownership };
}

function writeExclusive(context, filename, value) {
  const descriptor = context.fs.openSync(filename, 'wx');
  try {
    context.fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    context.fs.fsyncSync(descriptor);
  } finally { context.fs.closeSync(descriptor); }
}

function createDirectory(context, directory) {
  inspectPath(context, directory);
  context.fs.mkdirSync(directory);
}

function licenseRecord(context, directory, definition) {
  const text = boundedText(context, path.join(directory, definition.license.file), 256 * 1024);
  requireValue(text.trim().length > 0, 'ERR_RTC_LICENSE', 'Pinned checkout has an empty license file.');
  return { expectedSpdx: definition.license.expectedSpdx, file: definition.license.file,
    sha256: digest(text), legalAuditCompleted: false };
}

async function acquire(context, name) {
  const definition = context.manifest.repositories[name];
  const directory = path.join(context.paths.workspace, DIRECTORIES[name]);
  if (!exists(context, directory)) {
    createDirectory(context, directory);
    requireValue(context.fs.readdirSync(directory).length === 0, 'ERR_RTC_CHECKOUT_RACE', 'New checkout directory is no longer empty.');
    await git(context, directory, ['init', '--template', path.join(context.paths.workspace, '.hooks-disabled'), '--'],
      { mutating: true, label: `Initialize new ${name}` });
    await git(context, directory, ['remote', 'add', 'origin', definition.url],
      { mutating: true, label: `Record official ${name} origin` });
    context.log(`FETCH ${name} ${definition.commit} from ${definition.url}`);
    ++context.downloadCommands;
    await git(context, directory, ['fetch', '--no-tags', '--depth=1', 'origin', definition.commit],
      { mutating: true, label: `Fetch exact ${name} SHA (not HEAD)` });
    await git(context, directory, ['checkout', '--detach', definition.commit],
      { mutating: true, label: `Check out newly fetched ${name} SHA` });
  }
  const identity = await inspectCheckout(context, directory, definition);
  return { ...identity, license: licenseRecord(context, directory, definition) };
}

function dependencyPath(relative) {
  requireValue(typeof relative === 'string' && relative.length <= 2048 &&
    /^src(?:\/[^/]+)*$/u.test(relative) && relative.split('/').every(part =>
      part.length <= 255 && !/[<>:"\\|?*\u0000-\u001f]/u.test(part) &&
      !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)),
  'ERR_RTC_ENTRIES', 'Unsafe gclient dependency filesystem path.');
  return path.join('webrtc', ...relative.split('/'));
}

function dependencyEntry(entry, source) {
  requireValue(typeof entry === 'string' && entry.length <= 4096,
    'ERR_RTC_ENTRIES', 'Invalid gclient entry name.');
  const separator = entry.indexOf(':');
  const relative = separator < 0 ? entry : entry.slice(0, separator);
  const directory = dependencyPath(relative);
  if (separator < 0) {
    if (source === null) return { kind: 'excluded', entry, directory };
    requireValue(typeof source === 'string', 'ERR_RTC_ENTRIES', 'Unknown Git dependency identity representation.');
    const revisionAt = source.lastIndexOf('@');
    const url = revisionAt < 0 ? source : source.slice(0, revisionAt);
    const revision = revisionAt < 0 ? null : source.slice(revisionAt + 1);
    requireValue(httpsSource(url) && (revision === null || /^[A-Za-z0-9_./+-]{1,256}$/u.test(revision)),
      'ERR_RTC_ENTRIES', 'A Git dependency does not have a valid HTTPS/revision identity.');
    return { kind: 'git', entry, directory, url, revision };
  }
  const identity = entry.slice(separator + 1);
  // The suffix is an upstream package/object identity, never a Windows path.
  const expandedShape = identity.replace(/\$\{[a-z][a-z0-9_]*\}/gu, 'placeholder');
  requireValue(identity.length <= 1024 && expandedShape.split('/').every(part =>
    /^[A-Za-z0-9_.+-]+$/u.test(part) && part !== '.' && part !== '..') && typeof source === 'string',
  'ERR_RTC_ENTRIES', 'Invalid composite package/object identity.');
  const service = 'https://chrome-infra-packages.appspot.com/';
  if (source.startsWith(service)) {
    const prefix = `${service}${identity}@`;
    requireValue(source.startsWith(prefix) && /^[A-Za-z0-9_.:+=@-]{1,512}$/u.test(source.slice(prefix.length)),
      'ERR_RTC_ENTRIES', 'CIPD entry name, package and version do not agree.');
    return { kind: 'cipd', entry, directory, url: source, package: identity, version: source.slice(prefix.length) };
  }
  const gcs = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,221})\/(.+)$/u.exec(source);
  requireValue(gcs && gcs[2] === identity && !identity.includes('$'),
    'ERR_RTC_ENTRIES', 'GCS entry name, bucket and object do not agree.');
  return { kind: 'gcs', entry, directory, url: source, bucket: gcs[1], object: identity };
}

async function dependencyEntries(context, entriesText) {
  const document = await literal(context, entriesText);
  requireValue(document && Object.keys(document).length === 1 && document.entries &&
    typeof document.entries === 'object' && !Array.isArray(document.entries),
  'ERR_RTC_ENTRIES', 'Unexpected gclient dependency entries format.');
  const entries = Object.entries(document.entries);
  requireValue(entries.length && entries.length <= MAX_REPOSITORIES,
    'ERR_RTC_ENTRIES', 'gclient dependency inventory exceeds its bound.');
  const results = entries.map(([entry, source]) => dependencyEntry(entry, source))
    .sort((left, right) => left.entry < right.entry ? -1 : left.entry > right.entry ? 1 : 0);
  const root = results.find(entry => entry.entry === 'src');
  requireValue(root?.kind === 'git' && root.url === context.manifest.repositories.webrtc.url,
    'ERR_RTC_ENTRIES', 'gclient did not record the pinned root source.');
  return results;
}

function inspectArtifacts(context, artifacts) {
  const root = path.join(context.paths.workspace, 'webrtc');
  if (artifacts.some(entry => entry.kind === 'cipd')) {
    const registry = path.join(root, '.cipd');
    inspectPath(context, registry, context.paths.workspace);
    requireValue(exists(context, registry) && context.fs.lstatSync(registry).isDirectory(),
      'ERR_RTC_ARTIFACT', 'CIPD installation metadata is missing; no package is treated as a Git checkout.');
  }
  const installedGcs = new Set();
  if (artifacts.some(entry => entry.kind === 'gcs')) {
    const registry = path.join(root, '.gcs_entries');
    requireValue(exists(context, registry), 'ERR_RTC_ARTIFACT', 'GCS installation registry is missing.');
    const document = jsonFile(context, registry);
    requireValue(document && typeof document === 'object' && !Array.isArray(document) &&
      Object.keys(document).length <= MAX_REPOSITORIES, 'ERR_RTC_ARTIFACT', 'Invalid GCS installation registry.');
    let count = 0;
    for (const [checkout, paths] of Object.entries(document)) {
      dependencyPath(checkout);
      requireValue(paths && typeof paths === 'object' && !Array.isArray(paths),
        'ERR_RTC_ARTIFACT', 'Invalid GCS checkout registry.');
      for (const [relative, objects] of Object.entries(paths)) {
        dependencyPath(relative);
        requireValue(Array.isArray(objects), 'ERR_RTC_ARTIFACT', 'Invalid GCS object registry.');
        for (const object of objects) {
          requireValue(++count <= MAX_REPOSITORIES && typeof object === 'string' && object.length <= 1024,
            'ERR_RTC_ARTIFACT', 'GCS registry exceeds its object bound.');
          installedGcs.add(`${relative}:${object}`);
        }
      }
    }
  }
  for (const entry of artifacts) {
    const directory = path.join(context.paths.workspace, entry.directory);
    inspectPath(context, directory, context.paths.workspace);
    if (entry.kind === 'excluded') {
      requireValue(!exists(context, path.join(directory, '.git')),
        'ERR_RTC_ENTRIES', 'A Git checkout has no recorded gclient source identity.');
      continue;
    }
    requireValue(exists(context, directory) && context.fs.lstatSync(directory).isDirectory() &&
      context.fs.readdirSync(directory).length > 0,
    'ERR_RTC_ARTIFACT', `A ${entry.kind} install directory is absent or empty: ${entry.directory}`);
    if (entry.kind === 'gcs') requireValue(installedGcs.has(entry.entry),
      'ERR_RTC_ARTIFACT', 'A GCS object is absent from the upstream installation registry.');
  }
}

function dependencyCounts(entries) {
  return Object.fromEntries(['git', 'cipd', 'gcs', 'excluded'].map(kind =>
    [kind, entries.filter(entry => entry.kind === kind).length]));
}

async function dependencyIdentities(context, entriesText) {
  const entries = await dependencyEntries(context, entriesText);
  const gitEntries = entries.filter(value => value.kind === 'git');
  const repositories = [];
  for (const entry of gitEntries) {
    const expected = entry.entry === 'src' ? context.manifest.repositories.webrtc
      : { url: entry.url, commit: entry.revision && SHA.test(entry.revision) ? entry.revision : null };
    repositories.push(await inspectCheckout(context, path.join(context.paths.workspace, entry.directory), expected, gitEntries));
  }
  const artifacts = entries.filter(entry => entry.kind !== 'git');
  inspectArtifacts(context, artifacts);
  return { repositories, artifacts, counts: dependencyCounts(entries) };
}

function sourceToolchain(context) {
  const src = path.join(context.paths.workspace, DIRECTORIES.webrtc);
  const clang = boundedText(context, path.join(src, 'tools', 'clang', 'scripts', 'update.py'));
  const revision = /^\s*CLANG_REVISION\s*=\s*['"]([^'"]+)['"]/mu.exec(clang)?.[1];
  const subRevision = /^\s*CLANG_SUB_REVISION\s*=\s*(\d+)/mu.exec(clang)?.[1];
  const config = boundedText(context, path.join(src, 'buildtools', 'third_party', 'libc++', '__config_site'));
  requireValue(revision === context.manifest.baseline.clang.revision &&
    Number(subRevision) === context.manifest.baseline.clang.subRevision &&
    /^\s*#\s*define\s+_LIBCPP_ABI_VERSION\s+2\b/mu.test(config) &&
    /^\s*#\s*define\s+_LIBCPP_ABI_NAMESPACE\s+__Cr\b/mu.test(config),
  'ERR_RTC_TOOLCHAIN_PIN', 'Pinned source compiler/libc++ metadata does not match the declared baseline.');
  return { clangPackagePin: context.manifest.baseline.clang.packagePin,
    libcxxNamespace: 'std::__Cr', libcxxAbi: 2, sourceMetadataMatched: true,
    compilerBinaryVerified: false, rtcBuildExecuted: false, windowsLinkVerified: false };
}

async function inspectCompletedSources(context, owner) {
  const { workspace } = context.paths;
  const currentOwner = jsonFile(context, path.join(workspace, OWNER));
  validateOwner(context, currentOwner);
  requireValue(currentOwner.id === owner.id, 'ERR_RTC_OWNERSHIP', 'Source inspection owner changed.');
  const configText = boundedText(context, path.join(workspace, 'webrtc', '.gclient'));
  validateConfig(await literal(context, configText), context.manifest.repositories.webrtc.url);
  const repositories = [];
  for (const name of ['depot_tools', 'libmediasoupclient', 'libsdptransform']) {
    const definition = context.manifest.repositories[name];
    const directory = path.join(workspace, DIRECTORIES[name]);
    const identity = await inspectCheckout(context, directory, definition);
    identity.license = licenseRecord(context, directory, definition);
    repositories.push(identity);
  }
  const entriesText = boundedText(context, path.join(workspace, 'webrtc', '.gclient_entries'));
  const dependencies = await dependencyIdentities(context, entriesText);
  repositories.push(...dependencies.repositories);
  const root = repositories.find(entry => samePath(entry.directory, DIRECTORIES.webrtc));
  root.license = licenseRecord(context, path.join(workspace, DIRECTORIES.webrtc), context.manifest.repositories.webrtc);
  const toolchain = sourceToolchain(context);
  for (const entry of repositories) {
    await inspectCheckout(context, path.join(workspace, entry.directory), entry, repositories);
  }
  const state = { schemaVersion: 2, ownerId: owner.id, pinsHash: context.pinHash, completed: true,
    configHash: digest(configText), entriesHash: digest(entriesText), repositories,
    artifacts: dependencies.artifacts, sourceToolchain: toolchain };
  validateState(context, owner, state);
  return { state, dependencyCounts: dependencies.counts, sourceToolchain: toolchain,
    artifactContentIntegrityVerified: false };
}

async function fetchWorkspace(context, checked) {
  requireValue(context.options.action === 'fetch' && checked.report.canFetch,
    'ERR_RTC_FETCH_GUARD', 'Fetch requires an explicit action and a clean preflight before any mutation/download.');
  if (checked.state) return { ...checked.report, mode: 'fetch', noOp: true };
  const { workspace, artifacts, clientRoot } = context.paths;
  for (const directory of [path.join(clientRoot, 'dist-test'), artifacts]) {
    if (!exists(context, directory)) createDirectory(context, directory);
  }
  let owner = checked.owner;
  if (!exists(context, workspace)) {
    createDirectory(context, workspace);
    owner = ownerDocument(context, context.randomId());
    writeExclusive(context, path.join(workspace, OWNER), owner);
  }
  const lockPath = path.join(workspace, LOCK);
  const lock = { schemaVersion: 1, ownerId: owner.id, operation: 'fetch',
    id: context.randomId(), pid: process.pid, failedLocksRequireManualReview: true };
  writeExclusive(context, lockPath, lock);
  let completed = false;
  try {
    validateOwner(context, jsonFile(context, path.join(workspace, OWNER)));
    requireValue(!exists(context, path.join(workspace, STATE)), 'ERR_RTC_STATE_RACE', 'Completed state appeared while locking.');
    for (const relative of ['.hooks-disabled', 'cache', 'cache\\home', 'cache\\home\\AppData',
      'cache\\home\\AppData\\Local', 'cache\\home\\AppData\\Roaming', 'cache\\tmp', 'cache\\cipd', 'cache\\vpython']) {
      const directory = path.join(workspace, ...relative.split('\\'));
      if (!exists(context, directory)) createDirectory(context, directory);
      else inspectPath(context, directory);
    }
    requireValue(context.fs.readdirSync(path.join(workspace, '.hooks-disabled')).length === 0,
      'ERR_RTC_HOOKS', 'The disabled-hooks directory changed before acquisition.');
    // Recheck all existing top-level trees/configuration before the first download.
    for (const name of REPOSITORIES.filter(value => value !== 'webrtc')) {
      const directory = path.join(workspace, DIRECTORIES[name]);
      if (exists(context, directory)) await inspectCheckout(context, directory, context.manifest.repositories[name]);
    }
    requireValue(!exists(context, path.join(workspace, DIRECTORIES.webrtc)),
      'ERR_RTC_PARTIAL_SYNC', 'A WebRTC tree appeared before its initial pinned sync.');
    const webrtcRoot = path.join(workspace, 'webrtc');
    if (exists(context, path.join(webrtcRoot, '.gclient'))) {
      validateConfig(await literal(context, boundedText(context, path.join(webrtcRoot, '.gclient'))),
        context.manifest.repositories.webrtc.url);
    }
    for (const name of ['depot_tools', 'libmediasoupclient', 'libsdptransform']) {
      await acquire(context, name);
    }
    const gclient = path.join(workspace, 'depot_tools', 'gclient.py');
    const clientText = boundedText(context, gclient, 4 * MAX_TEXT);
    for (const flag of ['--unmanaged', '--cache-dir', '--no-history', '--revision', '--nohooks', '--noprehooks']) {
      requireValue(clientText.includes(flag), 'ERR_RTC_GCLIENT_FLAGS', `Pinned gclient does not expose required ${flag}; no fallback.`);
    }
    if (!exists(context, webrtcRoot)) createDirectory(context, webrtcRoot);
    requireValue(context.fs.readdirSync(webrtcRoot).every(name => name === '.gclient'),
      'ERR_RTC_PARTIAL_SYNC', 'gclient root changed before configuration.');
    const configPath = path.join(webrtcRoot, '.gclient');
    const pythonArgs = ['-B', '-E', '-s', gclient];
    if (!exists(context, configPath)) {
      await command(context, context.tools.gclientPython,
        [...pythonArgs, 'config', '--unmanaged', '--cache-dir=None', '--name', 'src', context.manifest.repositories.webrtc.url],
        { mutating: true, cwd: webrtcRoot, label: 'Create new unmanaged gclient configuration' });
    }
    validateConfig(await literal(context, boundedText(context, configPath)), context.manifest.repositories.webrtc.url);
    context.log('FETCH WebRTC pinned solution + DEPS Git/CIPD/GCS; pre/post hooks and builds are disabled.');
    ++context.downloadCommands;
    await command(context, context.tools.gclientPython,
      [...pythonArgs, 'sync', '--revision', `src@${context.manifest.repositories.webrtc.commit}`,
        '--no-history', '--nohooks', '--noprehooks'],
      { mutating: true, cwd: webrtcRoot, label: 'Initial pinned WebRTC/DEPS sync (never current HEAD first)' });
    const sources = await inspectCompletedSources(context, owner);
    writeExclusive(context, path.join(workspace, STATE), sources.state);
    completed = true;
    return { ...checked.report, readOnly: false, mode: 'fetch', status: 'sources-complete',
      workspaceOwned: true, sourceBootstrapComplete: true, downloadCommandsExecuted: context.downloadCommands,
      dependencyCounts: sources.dependencyCounts, artifactContentIntegrityVerified: false,
      sourceToolchain: sources.sourceToolchain, noOp: false };
  } finally {
    if (completed) {
      const current = jsonFile(context, lockPath);
      requireValue(current.ownerId === lock.ownerId && current.id === lock.id && current.pid === lock.pid,
        'ERR_RTC_LOCK_CHANGED', 'Ownership lock changed during the operation; it is not removed.');
      context.fs.unlinkSync(lockPath);
    }
    else context.log('FETCH failed: the ownership lock and any partial trees are retained for manual review. No reset/delete/retry is performed.');
  }
}

function argumentsFor(argv) {
  const result = { action: 'check', json: false, commandTimeoutSeconds: 1800 };
  let action = false;
  const flags = new Map([['git', 'git'], ['python', 'python'], ['gclient-python', 'gclientPython'], ['vswhere', 'vswhere'],
    ['vs-install', 'vsInstall'], ['sdk-root', 'sdkRoot']]);
  const seen = new Set();
  for (const argument of argv) {
    if ((argument === 'check' || argument === 'fetch') && !action) { result.action = argument; action = true; continue; }
    if (argument === '--json' && !seen.has('json')) { result.json = true; seen.add('json'); continue; }
    if (argument === '--help' && !seen.has('help')) { result.help = true; seen.add('help'); continue; }
    const matched = /^--([^=]+)=(.+)$/u.exec(argument);
    requireValue(matched && !seen.has(matched[1]), 'ERR_RTC_ARGUMENT', 'Unknown, missing or duplicate bootstrap argument.');
    seen.add(matched[1]);
    if (matched[1] === 'command-timeout-seconds') {
      requireValue(/^\d{1,4}$/u.test(matched[2]) && Number(matched[2]) >= 1 && Number(matched[2]) <= 7200,
        'ERR_RTC_ARGUMENT', 'Command deadline must be 1..7200 seconds; it is not a duration estimate.');
      result.commandTimeoutSeconds = Number(matched[2]);
    } else {
      const name = flags.get(matched[1]);
      requireValue(name && path.isAbsolute(matched[2]), 'ERR_RTC_ARGUMENT', 'Tool selections must be explicit absolute paths.');
      result[name] = path.resolve(matched[2]);
    }
  }
  requireValue(!result.help || (!action && seen.size === 1), 'ERR_RTC_ARGUMENT', 'Use --help by itself.');
  return result;
}

async function execute(context, options = {}) {
  const selected = { action: 'check', commandTimeoutSeconds: 1800, ...options };
  requireValue(selected.action === 'check' || selected.action === 'fetch', 'ERR_RTC_ARGUMENT', 'Unknown bootstrap action.');
  const checked = await preflight(context, selected);
  if (selected.action !== 'fetch' || !checked.report.canFetch) return checked.report;
  return fetchWorkspace(context, checked);
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.help) {
    console.log('Usage: node bootstrap.cjs [check|fetch] [--json] [--git=<absolute git.exe>] [--python=<absolute python.exe>]');
    console.log('       --gclient-python=<separate provisioned CPython 3.11 x64 venv\\Scripts\\python.exe>');
    console.log('       [--vswhere=<absolute vswhere.exe>] [--vs-install=<absolute VS2022 root>] [--sdk-root=<absolute SDK root>]');
    console.log('       [--command-timeout-seconds=1..7200]');
    console.log('Default check is read-only/offline. Explicit fetch downloads pinned sources and DEPS; it never builds RTC or runs hooks.');
    return 0;
  }
  const context = createContext({ log: message => console.error(message) });
  const report = await execute(context, options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.mode.toUpperCase()}: ${report.status}`);
    console.log(`Workspace: ${report.workspace}`);
    for (const issue of report.issues) console.log(`${issue.code}: ${issue.message}`);
    console.log('Source acquisition does not compile or verify binaries; run the separate native build after provisioning.');
  }
  return report.canFetch ? 0 : 1;
}

module.exports = {
  BootstrapError, createContext, argumentsFor, execute, preflight, fetchWorkspace,
  childEnvironment, spawnRunner, ownerDocument, validateOwner, validateConfig,
  selectExecutable: executable,
  validateState, safeGitConfig, parseLocalConfig, dependencyEntry, dependencyIdentities, sourceToolchain, inspectCompletedSources,
  constants: { OWNER, STATE, LOCK, OWNER_NAME, DIRECTORIES, REPOSITORIES },
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ code: error.code || 'ERR_RTC_BOOTSTRAP', message: error.message }));
    process.exitCode = 2;
  });
}
