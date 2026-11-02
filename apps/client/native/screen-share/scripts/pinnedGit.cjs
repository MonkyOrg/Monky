'use strict';

// One acquisition policy for every pinned Git source, on Windows and macOS: the OBS trees (fetchObs),
// the macOS WebRTC toolchain (prepareMacRtc) and the Windows RTC bootstrap. Git runs isolated from the
// user's and the machine's configuration, credentials and hooks; only an exact SHA is fetched, into a
// private temporary directory, and the checkout is verified before it is renamed into place. An
// interrupted acquisition therefore never leaves a half-made tree under the final name.
//
// The algorithm is written once, as a generator of commands. Build scripts run it synchronously
// (spawnSync); the Windows bootstrap runs the same steps through its guarded asynchronous runner.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execute, transientNetworkFailure, sleepSync, NETWORK_RETRY } = require('./buildTools.cjs');

const SHA = /^[a-f0-9]{40}$/u;
// What a developer shell or CI image can set to redirect Git, Python, depot_tools, CIPD or GN.
const FOREIGN_TOOL_VARIABLE = /^(GIT_|GCM_|PYTHON|DEPOT_TOOLS_|VPYTHON_|CIPD_|GCLIENT_|GYP_|GN_)/iu;
const INHERITED_LOCATION = /^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|INCLUDE|LIB|LIBPATH|VIRTUAL_ENV|__PYVENV_LAUNCHER__|ELECTRON_RUN_AS_NODE)$/iu;
const WORKSPACE_DIRECTORIES = ['.hooks-disabled', 'cache', ['cache', 'home'], ['cache', 'home', 'AppData'],
  ['cache', 'home', 'AppData', 'Local'], ['cache', 'home', 'AppData', 'Roaming'],
  ['cache', 'tmp'], ['cache', 'cipd'], ['cache', 'vpython']];

function exists(io, filename) {
  try { io.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** The private Git configuration, hooks, home and caches of a tool workspace (Windows RTC, macOS RTC). */
function workspaceIsolation(workspace) {
  const cache = path.join(workspace, 'cache');
  return {
    hooks: path.join(workspace, '.hooks-disabled'), globalConfig: path.join(cache, 'empty-gitconfig'),
    cache, home: path.join(cache, 'home'), temporary: path.join(cache, 'tmp'),
    directories: WORKSPACE_DIRECTORIES.map(relative => path.join(workspace, ...[relative].flat())),
  };
}

// Git for Windows 2.56 rejects GIT_CONFIG_GLOBAL=NUL and macOS has no NUL: an owned empty file isolates
// every Git version. Per-child settings disable hooks, filesystem monitors, credential helpers and file:// remotes.
function gitVariables({ globalConfig, hooks }) {
  const settings = [['core.hooksPath', hooks], ['core.fsmonitor', 'false'], ['core.untrackedCache', 'false'],
    ['credential.helper', ''], ['core.longpaths', 'true'], ['protocol.file.allow', 'never']];
  return Object.assign({
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_COUNT: String(settings.length),
  }, ...settings.map(([key, value], index) => ({ [`GIT_CONFIG_KEY_${index}`]: key, [`GIT_CONFIG_VALUE_${index}`]: value })));
}

/** `env` without any inherited Git or credential-manager variable, plus the isolated Git settings. */
function gitEnvironment(env, isolation) {
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(GIT_|GCM_)/iu.test(key)));
  return Object.assign(result, gitVariables(isolation));
}

/**
 * Environment of the source tools (Git, gclient, CIPD, vpython): nothing that redirects them is
 * inherited, and home, temporary files and caches stay inside the workspace. `paths` precede the
 * inherited PATH. Creating the environment never creates its directories.
 */
function toolEnvironment(env, workspace, { paths = [], platform = process.platform } = {}) {
  const isolation = workspaceIsolation(workspace);
  const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  const result = Object.fromEntries(Object.entries(env)
    .filter(([key]) => !FOREIGN_TOOL_VARIABLE.test(key) && !INHERITED_LOCATION.test(key)));
  const home = isolation.home;
  Object.assign(result, {
    PATH: [...paths, inheritedPath].filter(Boolean).join(platform === 'win32' ? ';' : ':'),
    HOME: home, TEMP: isolation.temporary, TMP: isolation.temporary, TMPDIR: isolation.temporary,
    CIPD_CACHE_DIR: path.join(isolation.cache, 'cipd'),
    VPYTHON_VIRTUALENV_ROOT: path.join(isolation.cache, 'vpython'),
    DEPOT_TOOLS_UPDATE: '0', DEPOT_TOOLS_WIN_TOOLCHAIN: '0', PYTHONDONTWRITEBYTECODE: '1',
  }, gitVariables(isolation));
  if (platform === 'win32') Object.assign(result, {
    USERPROFILE: home, HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
  });
  return result;
}

function assertIsolation({ globalConfig, hooks }, io = fs) {
  const config = io.lstatSync(globalConfig), disabled = io.lstatSync(hooks);
  assert.ok(config.isFile() && config.size === 0, 'The isolated global Git configuration must remain an empty file.');
  assert.ok(disabled.isDirectory() && io.readdirSync(hooks).length === 0, 'The disabled Git hooks directory must remain empty.');
}

/** Creates the empty Git configuration and hooks directory if needed, and checks that they are still empty. */
function prepareIsolation(isolation, io = fs) {
  for (const directory of [isolation.hooks, path.dirname(isolation.globalConfig)])
    if (!exists(io, directory)) io.mkdirSync(directory, { recursive: true });
  if (!exists(io, isolation.globalConfig)) io.closeSync(io.openSync(isolation.globalConfig, 'wx'));
  assertIsolation(isolation, io);
  return isolation;
}

function assertPinnedSubmodules(state) {
  for (const line of state.split(/\r?\n/u).filter(Boolean))
    assert.match(line, /^ ?[a-f0-9]{40} .+$/u, 'Missing or modified source submodule.');
}

const git = (directory, args, label, mutating) => ({ directory, args, label, mutating });

function* withNetworkRetries(command, log) {
  const { attempts, delaysMs } = NETWORK_RETRY;
  for (let attempt = 1; ; attempt++) {
    try { return yield command; }
    catch (error) {
      if (attempt >= attempts || !transientNetworkFailure(error)) throw error;
      const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      log(`${command.label}: transient network failure on attempt ${attempt}/${attempts}; retrying in ${delay / 1000}s.`);
      yield { sleep: delay };
    }
  }
}

function* verification(directory, { url, commit, submodules, gclientRoot, io }) {
  const tree = io.lstatSync(directory), metadata = io.lstatSync(path.join(directory, '.git'));
  assert.ok(tree.isDirectory() && !tree.isSymbolicLink() && metadata.isDirectory() && !metadata.isSymbolicLink(),
    `A pinned source must be a real directory with its own Git directory: ${directory}`);
  const read = (args, label) => git(directory, args, label, false);
  assert.equal((yield read(['remote', 'get-url', 'origin'], 'Read source origin')).trim(), url,
    `Source origin changed: ${directory}`);
  assert.equal((yield read(['rev-parse', '--verify', 'HEAD^{commit}'], 'Read source revision')).trim(), commit,
    `Source revision changed: ${directory}. Remove it to acquire the pinned revision again.`);
  // A gclient root holds its DEPS checkouts inside it; gclient itself pins and checks those.
  const status = gclientRoot ? ['--untracked-files=no', '--ignore-submodules=dirty']
    : ['--untracked-files=all', '--ignore-submodules=none'];
  assert.equal(yield read(['status', '--porcelain=v1', '-z', ...status], 'Check source tree is clean'), '',
    `Source tree is not clean: ${directory}`);
  if (submodules) assertPinnedSubmodules(yield read(['submodule', 'status', '--recursive'], 'Check source submodules'));
  return directory;
}

function* rename(io, from, to) {
  for (let attempt = 1; ; attempt++) {
    try { return io.renameSync(from, to); }
    catch (error) {
      // An antivirus or indexer can briefly hold a file of the fresh Windows checkout open.
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      yield { sleep: 1000 * attempt };
    }
  }
}

/**
 * Commands that make `directory` the verified checkout of `url` at `commit`. An existing directory is
 * only verified: it is never fetched into, reset or replaced.
 */
function* acquisition({ directory, url, commit, isolation, submodules = false, gclientRoot = false,
  localConfig = [], io = fs, randomId = crypto.randomUUID, log = console.log }) {
  assert.ok(typeof url === 'string' && url.startsWith('https://'), 'Pinned sources come from HTTPS URLs.');
  assert.match(commit, SHA, 'Pinned sources are fetched by full commit SHA.');
  const options = { url, commit, submodules, gclientRoot, io };
  if (exists(io, directory)) return { directory: yield* verification(directory, options), acquired: false };
  assertIsolation(isolation, io);
  const parent = path.dirname(directory), name = path.basename(directory);
  io.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.${name}.partial-${randomId()}`);
  io.mkdirSync(temporary);
  let complete = false;
  try {
    log(`Source: ${url} @ ${commit}`);
    yield git(temporary, ['init', '--quiet', `--template=${isolation.hooks}`], `Initialize ${name}`, true);
    for (const [key, value] of localConfig)
      yield git(temporary, ['config', '--local', key, value], `Configure ${name}`, true);
    yield git(temporary, ['remote', 'add', 'origin', url], `Record ${name} origin`, true);
    yield* withNetworkRetries(git(temporary, ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', commit],
      `Fetch exact ${name} SHA ${commit}`, true), log);
    yield git(temporary, ['checkout', '--quiet', '--detach', commit], `Check out ${name} SHA`, true);
    if (submodules) yield* withNetworkRetries(git(temporary, ['submodule', 'update', '--quiet', '--init',
      '--recursive', '--depth=1'], `Fetch ${name} submodules`, true), log);
    yield* verification(temporary, options);
    assert.ok(!exists(io, directory), `Another acquisition created ${directory} meanwhile.`);
    yield* rename(io, temporary, directory);
    complete = true;
    return { directory, acquired: true };
  } finally {
    if (!complete) {
      try { io.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); }
      catch (error) { log(`Could not remove the partial checkout ${temporary}: ${error.message}`); }
    }
  }
}

function runSync(steps, { git: run, sleep = sleepSync }) {
  for (let next = steps.next(); ;) {
    if (next.done) return next.value;
    let value, failed = false;
    try { value = next.value.sleep === undefined ? run(next.value) : sleep(next.value.sleep); }
    catch (error) { value = error; failed = true; }
    next = failed ? steps.throw(value) : steps.next(value);
  }
}

async function runAsync(steps, { git: run, sleep }) {
  for (let next = steps.next(); ;) {
    if (next.done) return next.value;
    let value, failed = false;
    try { value = next.value.sleep === undefined ? await run(next.value) : await sleep(next.value.sleep); }
    catch (error) { value = error; failed = true; }
    next = failed ? steps.throw(value) : steps.next(value);
  }
}

/** Runs one isolated Git command with spawnSync; `config` holds per-command content settings (line endings). */
function gitCommand(isolation, { config = [], env = process.env } = {}) {
  const environment = gitEnvironment(env, isolation);
  const flags = config.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  return ({ directory, args }) => execute('git', ['--no-pager', ...flags, '-C', directory, ...args],
    { cwd: directory, env: environment, capture: true });
}

/** Synchronous acquisition, for build scripts. `git` defaults to the isolated spawnSync runner. */
function acquireSync(options) {
  return runSync(acquisition(options), { git: options.git ?? gitCommand(options.isolation), sleep: options.sleep });
}

/** Asynchronous acquisition; `git` and `sleep` return promises (the Windows bootstrap's guarded runner). */
function acquireAsync(options) {
  return runAsync(acquisition(options), options);
}

module.exports = {
  workspaceIsolation, gitVariables, gitEnvironment, toolEnvironment, prepareIsolation, assertIsolation,
  assertPinnedSubmodules, gitCommand, acquisition, acquireSync, acquireAsync,
};
