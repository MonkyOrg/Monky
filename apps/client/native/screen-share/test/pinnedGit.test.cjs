'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const pinnedGit = require('../scripts/pinnedGit.cjs');

const URL = 'https://example.org/pinned/source.git';
const COMMIT = 'a'.repeat(40);

// A Git double over a real directory tree: enough to check the order of commands and the files left behind.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-pinned-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const isolation = pinnedGit.prepareIsolation(pinnedGit.workspaceIsolation(path.join(root, 'workspace')));
  const state = { calls: [], sleeps: [], failures: [], repos: new Map(), dirty: '' };
  const repoOf = directory => {
    const found = state.repos.get(directory)
      ?? [...state.repos.values()].find(repo => fs.existsSync(path.join(directory, '.git', repo.id)));
    assert.ok(found, `Unknown fixture checkout: ${directory}`);
    return found;
  };
  const git = ({ directory, args, mutating }) => {
    state.calls.push({ directory, args, mutating });
    const failure = state.failures.find(entry => entry.command === args[0] && entry.times > 0);
    if (failure) {
      failure.times--;
      throw new Error(failure.message);
    }
    const [command, ...rest] = args;
    if (command === 'init') {
      const id = `fixture-${state.repos.size}`;
      fs.mkdirSync(path.join(directory, '.git', id), { recursive: true });
      state.repos.set(directory, { id, url: '', commit: '' });
      return '';
    }
    const repo = repoOf(directory);
    if (command === 'remote' && rest[0] === 'add') { repo.url = rest[2]; return ''; }
    if (command === 'remote') return `${repo.url}\n`;
    if (command === 'fetch') { repo.fetched = rest.at(-1); return ''; }
    if (command === 'checkout') { repo.commit = repo.fetched; return ''; }
    if (command === 'rev-parse') return `${repo.commit}\n`;
    if (command === 'status') return state.dirty;
    if (command === 'config' || command === 'submodule') return '';
    throw new Error(`Unexpected Git command: ${command}`);
  };
  const options = { url: URL, commit: COMMIT, isolation, git, sleep: ms => state.sleeps.push(ms), log() {},
    directory: path.join(root, 'sources', 'source') };
  return { root, isolation, state, options };
}

test('a pinned source is fetched by SHA into a private directory and renamed into place once verified', t => {
  const { state, options } = fixture(t);
  assert.deepEqual(pinnedGit.acquireSync(options), { directory: options.directory, acquired: true });
  const directories = new Set(state.calls.map(call => call.directory));
  assert.equal(directories.size, 1);
  const [temporary] = directories;
  assert.equal(path.dirname(temporary), path.dirname(options.directory));
  assert.match(path.basename(temporary), /^\.source\.partial-/u);
  assert.deepEqual(state.calls.filter(call => call.mutating).map(call => call.args), [
    ['init', '--quiet', `--template=${options.isolation.hooks}`],
    ['remote', 'add', 'origin', URL],
    ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', COMMIT],
    ['checkout', '--quiet', '--detach', COMMIT],
  ]);
  assert.deepEqual(state.calls.filter(call => !call.mutating).map(call => call.args[0]), ['remote', 'rev-parse', 'status']);
  assert.deepEqual(fs.readdirSync(path.dirname(options.directory)), ['source']);
  assert.ok(fs.lstatSync(path.join(options.directory, '.git')).isDirectory());
});

test('an existing checkout is only verified, never fetched into, reset or replaced', t => {
  const { state, options } = fixture(t);
  pinnedGit.acquireSync(options);
  state.calls.length = 0;
  assert.deepEqual(pinnedGit.acquireSync(options), { directory: options.directory, acquired: false });
  assert.ok(state.calls.every(call => !call.mutating && call.directory === options.directory));
  state.dirty = ' M local.cc\0';
  assert.throws(() => pinnedGit.acquireSync(options), /Source tree is not clean/u);
  state.dirty = '';
  state.repos.values().next().value.commit = 'b'.repeat(40);
  assert.throws(() => pinnedGit.acquireSync(options), /Source revision changed: .*Remove it/u);
});

test('a gclient root is checked without its nested DEPS checkouts and submodules are checked when declared', t => {
  const { state, options } = fixture(t);
  pinnedGit.acquireSync({ ...options, gclientRoot: true });
  assert.deepEqual(state.calls.find(call => call.args[0] === 'status').args,
    ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty']);
  state.calls.length = 0;
  pinnedGit.acquireSync({ ...options, directory: path.join(path.dirname(options.directory), 'modules'), submodules: true });
  assert.deepEqual(state.calls.find(call => call.args[0] === 'status').args,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  assert.deepEqual(state.calls.filter(call => call.args[0] === 'submodule').map(call => call.args),
    [['submodule', 'update', '--quiet', '--init', '--recursive', '--depth=1'], ['submodule', 'status', '--recursive']]);
});

test('transient upstream failures are retried with backoff; a real failure leaves no partial checkout', t => {
  const { state, options } = fixture(t);
  state.failures.push({ command: 'fetch', times: 2, message: 'error: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504' });
  pinnedGit.acquireSync(options);
  assert.deepEqual(state.sleeps, [10_000, 30_000]);
  assert.equal(state.calls.filter(call => call.args[0] === 'fetch').length, 3);

  const other = { ...options, directory: path.join(path.dirname(options.directory), 'other') };
  state.failures.push({ command: 'fetch', times: 1, message: 'fatal: remote error: upload-pack: not our ref' });
  state.sleeps.length = 0;
  assert.throws(() => pinnedGit.acquireSync(other), /not our ref/u);
  assert.deepEqual(state.sleeps, [], 'A missing pinned revision is never retried.');
  assert.deepEqual(fs.readdirSync(path.dirname(options.directory)), ['source'],
    'Neither the final directory nor the temporary one remains.');

  state.failures.push({ command: 'checkout', times: 1, message: 'error: checkout failed' });
  assert.throws(() => pinnedGit.acquireSync(other), /checkout failed/u);
  assert.deepEqual(fs.readdirSync(path.dirname(options.directory)), ['source']);
});

test('the asynchronous driver runs the same acquisition for the Windows bootstrap', async t => {
  const { state, options } = fixture(t);
  const sync = fixture(t);
  pinnedGit.acquireSync(sync.options);
  const sleeps = [];
  state.failures.push({ command: 'fetch', times: 1, message: 'fatal: the remote end hung up unexpectedly' });
  const result = await pinnedGit.acquireAsync({ ...options,
    git: async command => options.git(command), sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(result, { directory: options.directory, acquired: true });
  assert.deepEqual(sleeps, [10_000]);
  const shape = calls => calls.filter(call => call.args[0] !== 'fetch')
    .map(call => [call.args.join(' '), call.mutating]);
  assert.deepEqual(shape(state.calls), shape(sync.state.calls).map(([args, mutating]) =>
    [args.replace(sync.options.isolation.hooks, options.isolation.hooks), mutating]));
});

test('acquisition refuses non-HTTPS sources, branch names and a used isolation', t => {
  const { options } = fixture(t);
  assert.throws(() => pinnedGit.acquireSync({ ...options, url: 'file:///C:/source.git' }), /HTTPS/u);
  assert.throws(() => pinnedGit.acquireSync({ ...options, commit: 'main' }), /full commit SHA/u);
  fs.writeFileSync(options.isolation.globalConfig, '[core]\n\thooksPath = elsewhere\n');
  assert.throws(() => pinnedGit.acquireSync(options), /global Git configuration must remain an empty file/u);
  fs.writeFileSync(options.isolation.globalConfig, '');
  fs.writeFileSync(path.join(options.isolation.hooks, 'post-checkout'), '#!/bin/sh\n');
  assert.throws(() => pinnedGit.prepareIsolation(options.isolation), /hooks directory must remain empty/u);
});

test('source tools inherit nothing that redirects them and keep home, temporary files and caches private', () => {
  const workspace = path.resolve('workspace');
  const inherited = { Path: 'C:\\inherited', GIT_DIR: 'foreign', git_config_count: '1', GCM_INTERACTIVE: 'Always',
    PYTHONPATH: 'foreign', PYTHONHOME: 'foreign', DEPOT_TOOLS_UPDATE: '1', GYP_DEFINES: 'foreign', GN_ARGS: 'x',
    CIPD_CACHE_DIR: 'foreign', GCLIENT_FILE: 'foreign', HOME: 'foreign', TMPDIR: 'foreign', VIRTUAL_ENV: 'foreign',
    SystemRoot: 'C:\\Windows', LANG: 'en_US.UTF-8' };
  const isolation = pinnedGit.workspaceIsolation(workspace);
  for (const platform of ['win32', 'darwin']) {
    const env = pinnedGit.toolEnvironment(inherited, workspace, { paths: ['first', 'second'], platform });
    for (const key of ['GIT_DIR', 'git_config_count', 'PYTHONPATH', 'PYTHONHOME', 'GYP_DEFINES', 'GN_ARGS',
      'GCLIENT_FILE', 'VIRTUAL_ENV', 'Path']) assert.equal(env[key], undefined, key);
    assert.equal(env.PATH, ['first', 'second', 'C:\\inherited'].join(platform === 'win32' ? ';' : ':'));
    assert.equal(env.HOME, isolation.home);
    assert.equal(env.TMPDIR, isolation.temporary);
    assert.equal(env.CIPD_CACHE_DIR, path.join(isolation.cache, 'cipd'));
    assert.equal(env.DEPOT_TOOLS_UPDATE, '0');
    assert.equal(env.GIT_CONFIG_GLOBAL, isolation.globalConfig);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GCM_INTERACTIVE, 'Never');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.LANG, 'en_US.UTF-8');
    assert.equal(env.USERPROFILE, platform === 'win32' ? isolation.home : undefined);
    const settings = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) },
      (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]));
    assert.deepEqual(settings, { 'core.hooksPath': isolation.hooks, 'core.fsmonitor': 'false',
      'core.untrackedCache': 'false', 'credential.helper': '', 'core.longpaths': 'true', 'protocol.file.allow': 'never' });
  }
  const git = pinnedGit.gitEnvironment(inherited, isolation);
  assert.equal(git.GIT_DIR, undefined);
  assert.equal(git.git_config_count, undefined);
  assert.equal(git.HOME, 'foreign', 'A Git-only environment leaves the rest of the inherited environment alone.');
  assert.equal(git.GIT_CONFIG_COUNT, '6');
  assert.equal(fs.existsSync(workspace), false, 'Creating an environment never creates its directories.');
});

test('fetchObs, prepareMacRtc and the Windows bootstrap acquire pinned Git sources only through pinnedGit', () => {
  const scripts = path.join(__dirname, '..', 'scripts');
  const sources = Object.fromEntries(['fetchObs.cjs', 'prepareMacRtc.cjs', path.join('native-rtc', 'bootstrap.cjs')]
    .map(name => [name, fs.readFileSync(path.join(scripts, name), 'utf8')]));
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /pinnedGit\.acquire(?:Sync|Async)\(/u, name);
    assert.doesNotMatch(source, /'fetch', '--/u, `${name} must not fetch on its own.`);
    assert.doesNotMatch(source, /GIT_CONFIG_(?:GLOBAL|NOSYSTEM|COUNT)/u, `${name} must not build its own Git isolation.`);
  }
  assert.match(sources['prepareMacRtc.cjs'], /pinnedGit\.toolEnvironment\(process\.env, workspace/u);
});
