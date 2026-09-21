'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createContext, argumentsFor, execute: executeBootstrap, preflight, childEnvironment,
  ownerDocument, validateConfig, validateState, safeGitConfig, parseLocalConfig,
  spawnRunner, selectExecutable, dependencyEntry, inspectCompletedSources, constants,
} = require('../scripts/native-rtc/bootstrap.cjs');
const pins = require('../scripts/native-rtc/pins.json');
const { VC_FILES, VS_FILES } = require('../scripts/windowsToolchain.cjs');
const toolsDirectory = path.resolve(__dirname, '..', 'scripts', 'native-rtc');

const OWNER_ID = '11111111-2222-3333-4444-555555555555';
const DEP_SHA = '1234567890123456789012345678901234567890';
const DEP_URL = 'https://chromium.googlesource.com/chromium/src/buildtools.git';
// Real M140 DEPS identities serialized by the pinned gclient's dependency classes.
const CIPD_KEY = 'src/buildtools/win:gn/gn/windows-amd64';
const CIPD_URL = 'https://chrome-infra-packages.appspot.com/gn/gn/windows-amd64@git_revision:3a4f5cea73eca32e9586e8145f97b04cbd4a1aee';
const GCS_PATH = 'src/third_party/test_fonts/test_fonts';
const GCS_OBJECT = 'a28b222b79851716f8358d2800157d9ffe117b3545031ae51f69b7e1e1b9a969';
const GCS_KEY = `${GCS_PATH}:${GCS_OBJECT}`;
const GCS_URL = `gs://chromium-fonts/${GCS_OBJECT}`;
const fixtureRuntimes = new WeakMap();
const clone = value => JSON.parse(JSON.stringify(value));

function execute(context, options = {}) {
  return executeBootstrap(context, { gclientPython: fixtureRuntimes.get(context), ...options });
}

function put(filename, contents = 'fixture') {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function solution(url = pins.repositories.webrtc.url) {
  return { solutions: [{ name: 'src', url, deps_file: 'DEPS', managed: false,
    custom_deps: {}, custom_vars: {} }], cache_dir: null };
}

function configText(value = solution()) {
  const cache = Object.hasOwn(value, 'cache_dir')
    ? `cache_dir = ${value.cache_dir === null ? 'None' : JSON.stringify(value.cache_dir)}\n` : '';
  return `solutions = ${JSON.stringify(value.solutions).replace(/:false/gu, ':False').replace(/:true/gu, ':True')}\n${cache}`;
}

class Fixture {
  constructor(t) {
    const temporary = fs.realpathSync.native(os.tmpdir());
    this.root = fs.mkdtempSync(path.join(temporary, 'monky-rtc-bootstrap-'));
    t.after(() => {
      assert.equal(path.dirname(this.root), temporary);
      assert.ok(path.basename(this.root).startsWith('monky-rtc-bootstrap-'));
      fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    this.repository = path.join(this.root, 'repo');
    this.moduleDir = path.join(this.repository, 'apps', 'client', 'native', 'screen-share', 'scripts', 'native-rtc');
    this.workspace = path.join(this.repository, '.native-screen', 'rtc');
    this.toolDir = path.join(this.root, 'tools');
    this.sdk = path.join(this.root, 'sdk');
    this.vs = path.join(this.root, 'VS 2022');
    this.programFiles = path.join(this.root, 'Program Files x86');
    this.vswhere = path.join(this.programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    this.git = path.join(this.toolDir, 'git.exe');
    this.python = path.join(this.toolDir, 'python.exe');
    this.gclientVenv = path.join(path.dirname(this.workspace), 'gclient-runtime');
    this.gclientPython = path.join(this.gclientVenv, 'Scripts', 'python.exe');
    this.calls = [];
    this.writes = [];
    this.repos = new Map();
    this.ignored = true;
    this.vsInstances = [{ installationPath: this.vs, installationVersion: '17.14.1000.0', isComplete: true }];
    this.sdkVersions = {
      'bin\\10.0.26100.0\\x64\\rc.exe': '10.0.26100.7705',
      'Debuggers\\x64\\dbghelp.dll': '10.0.26100.3323',
      'Debuggers\\x64\\dbgcore.dll': '10.0.26100.3323',
    };
    this.failSync = false;
    this.failFetch = false;
    this.mutateAfterSync = false;
    this.pythonPointerBits = 64;
    this.runtimeFailure = null;
    this.runtimeVersion = [3, 11, 9];
    this.runtimePointerBits = 64;
    this.extraEntries = {};
    this.runtimeRequirements = pins.bootstrap.gclientRuntime.requirements.map(requirement => ({
      distribution: requirement.distribution, version: requirement.version, module: requirement.module,
      origin: path.join(this.gclientVenv, 'Lib', 'site-packages', `${requirement.module}.py`),
    }));
    put(path.join(this.moduleDir, 'pins.json'), JSON.stringify(pins));
    put(this.git);
    put(this.python);
    put(path.join(this.toolDir, 'python3.dll'));
    put(path.join(this.toolDir, 'Lib', 'os.py'));
    put(this.gclientPython);
    put(path.join(this.gclientVenv, 'pyvenv.cfg'), `home = ${this.toolDir}\ninclude-system-site-packages = false\n`);
    put(this.vswhere);
    put(path.join(this.vs, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'), '14.44.35207');
    for (const file of VC_FILES) {
      put(path.join(this.vs, 'VC', 'Tools', 'MSVC', '14.44.35207', ...file.split('\\')));
    }
    for (const file of VS_FILES) put(path.join(this.vs, ...file.split('\\')));
    put(path.join(this.vs, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt'), '14.44.35112');
    for (const file of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
      put(path.join(this.vs, 'VC', 'Redist', 'MSVC', '14.44.35112', 'x64', 'Microsoft.VC143.CRT', file));
    for (const file of [
      'Include\\10.0.26100.0\\um\\Windows.h', 'Include\\10.0.26100.0\\shared\\sdkddkver.h',
      'Include\\10.0.26100.0\\ucrt\\stdio.h', 'Lib\\10.0.26100.0\\um\\x64\\kernel32.lib',
      'Lib\\10.0.26100.0\\ucrt\\x64\\ucrt.lib', ...Object.keys(this.sdkVersions),
    ]) put(path.join(this.sdk, ...file.split('\\')));
    const mutators = new Set(['mkdirSync', 'writeFileSync', 'openSync', 'unlinkSync',
      'renameSync', 'rmSync', 'rmdirSync', 'fsyncSync']);
    const io = new Proxy(fs, {
      get: (target, property) => {
        const value = target[property];
        if (!mutators.has(property)) return value;
        return (...args) => { this.writes.push({ method: property, args }); return value(...args); };
      },
    });
    this.context = createContext({
      fs: io, moduleDir: this.moduleDir, manifest: clone(pins),
      platform: 'win32', arch: 'x64', nodeVersion: '24.19.0',
      env: { PATH: this.toolDir, 'ProgramFiles(x86)': this.programFiles,
        SystemRoot: envSystemRoot(), DEPOT_TOOLS_UPDATE: '1', DEPOT_TOOLS_WIN_TOOLCHAIN: '1',
        GIT_DIR: 'foreign', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'unsafe',
        GIT_CONFIG_VALUE_0: 'foreign', PYTHONPATH: 'foreign', GCLIENT_FILE: 'foreign',
        HOME: 'foreign', USERPROFILE: 'foreign' },
      runner: request => this.run(request),
      randomId: () => OWNER_ID,
    });
    fixtureRuntimes.set(this.context, this.gclientPython);
  }

  own() {
    fs.mkdirSync(this.workspace, { recursive: true });
    put(path.join(this.workspace, constants.OWNER), JSON.stringify(ownerDocument(this.context, OWNER_ID)));
  }

  repo(directory, url, commit) {
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    put(path.join(directory, '.git', 'config'));
    put(path.join(directory, 'LICENSE'), 'A fixture license marker, not an upstream license copy.');
    const value = {
      directory, url, commit, dirty: '', index: 'H tracked.cc\0',
      config: { 'core.repositoryformatversion': '0', 'core.bare': 'false',
        'remote.origin.url': url, 'remote.origin.fetch': '+refs/heads/*:refs/remotes/origin/*' },
    };
    this.repos.set(directory, value);
    return value;
  }

  pinned(name) {
    const definition = pins.repositories[name];
    return this.repo(path.join(this.workspace, constants.DIRECTORIES[name]), definition.url, definition.commit);
  }

  answer(stdout = '', code = 0, stderr = '') {
    return { stdout, stderr, code, signal: null };
  }

  async run(request) {
    this.calls.push(request);
    let exe = request.exe;
    let args = request.args;
    if (request.guarded) {
      assert.equal(exe, this.python);
      assert.equal(path.basename(args[3]), 'owned_process.py');
      const boundary = args.indexOf('--');
      assert.ok(boundary > 3);
      exe = args[boundary + 1];
      args = args.slice(boundary + 2);
    }
    if (exe === this.vswhere) return this.answer(JSON.stringify(this.vsInstances));
    if (exe === this.python && args.includes('metadata')) {
      return this.answer(JSON.stringify({ pythonVersion: [3, 12, 10], pythonPointerBits: this.pythonPointerBits, sdkRoots: [this.sdk],
        selectedSdkRoot: this.sdk, sdkFileVersions: this.sdkVersions }));
    }
    if (exe === this.gclientPython && args.includes('gclient-runtime')) {
      assert.deepEqual(args.slice(0, 3), ['-B', '-E', '-s']);
      assert.equal(args.includes('-I'), false);
      assert.equal(args.includes('-S'), false);
      if (this.runtimeFailure) return this.answer('', 1, this.runtimeFailure);
      return this.answer(JSON.stringify({
        pythonVersion: this.runtimeVersion, pythonPointerBits: this.runtimePointerBits,
        pythonImplementation: 'cpython',
        prefix: this.gclientVenv, basePrefix: this.toolDir, executable: this.gclientPython,
        includeSystemSitePackages: false, requirements: this.runtimeRequirements,
      }));
    }
    if (exe === this.python && args.includes('literal')) {
      try {
        if (request.input.startsWith('solutions = ')) {
          const [definition, ...settings] = request.input.trim().split('\n');
          const document = { solutions: JSON.parse(definition.slice(12).trim()
            .replace(/\bFalse\b/gu, 'false').replace(/\bTrue\b/gu, 'true')) };
          for (const setting of settings) {
            if (!setting.startsWith('cache_dir = ') || Object.hasOwn(document, 'cache_dir')) {
              return this.answer('', 1, 'Executable or ambiguous literal rejected');
            }
            document.cache_dir = JSON.parse(setting.slice(12).trim().replace(/^None$/u, 'null'));
          }
          return this.answer(JSON.stringify(document));
        }
        if (request.input.startsWith('entries = ')) {
          return this.answer(JSON.stringify({ entries: JSON.parse(request.input.slice(10).trim()) }));
        }
        return this.answer('', 1, 'Executable or ambiguous literal rejected');
      } catch {
        return this.answer('', 1, 'Invalid literal fixture');
      }
    }
    if (exe === this.gclientPython && args.some(argument => argument.endsWith(`${path.sep}gclient.py`))) {
      assert.deepEqual(args.slice(0, 3), ['-B', '-E', '-s']);
      const start = args.findIndex(argument => argument.endsWith(`${path.sep}gclient.py`));
      const command = args[start + 1];
      if (command === 'config') {
        assert.equal(fs.existsSync(path.join(request.cwd, '.gclient')), false);
        assert.ok(args.includes('--cache-dir=None'), 'Gclient must not discover a global/shared Git mirror.');
        put(path.join(request.cwd, '.gclient'), configText());
        return this.answer();
      }
      assert.equal(command, 'sync');
      this.pinned('webrtc').dirty = '?? buildtools/\0';
      if (this.failSync) return this.answer('', 1, 'Explicit injected sync failure');
      this.repo(path.join(request.cwd, 'src', 'buildtools'), DEP_URL, DEP_SHA);
      put(path.join(request.cwd, '.gclient_entries'), `entries = ${JSON.stringify({
        src: `${pins.repositories.webrtc.url}@${pins.repositories.webrtc.commit}`,
        'src/buildtools': `${DEP_URL}@${DEP_SHA}`,
        [CIPD_KEY]: CIPD_URL,
        [GCS_KEY]: GCS_URL,
        ...this.extraEntries,
      })}\n`);
      fs.mkdirSync(path.join(request.cwd, '.cipd'));
      put(path.join(request.cwd, 'src', 'buildtools', 'win', 'gn.exe'), 'non-executable fixture data');
      put(path.join(request.cwd, ...GCS_PATH.split('/'), 'font-fixture.data'));
      put(path.join(request.cwd, '.gcs_entries'), JSON.stringify({ src: { [GCS_PATH]: [GCS_OBJECT] } }));
      put(path.join(request.cwd, 'src', 'tools', 'clang', 'scripts', 'update.py'),
        `CLANG_REVISION = '${pins.baseline.clang.revision}'\nCLANG_SUB_REVISION = 14\n`);
      put(path.join(request.cwd, 'src', 'buildtools', 'third_party', 'libc++', '__config_site'),
        '#define _LIBCPP_ABI_VERSION 2\n#define _LIBCPP_ABI_NAMESPACE __Cr\n');
      if (this.mutateAfterSync) this.repos.get(path.join(this.workspace, 'depot_tools')).dirty = ' M gclient.py\n';
      return this.answer();
    }
    assert.equal(exe, this.git, `Unexpected executable ${exe}`);
    if (args.length === 1 && args[0] === '--version') return this.answer('git version 2.50.1.windows.1\n');
    assert.deepEqual(args.slice(0, 3), ['--no-optional-locks', '--no-pager', '-C']);
    const directory = args[3];
    const command = args[4];
    const rest = args.slice(5);
    if (directory === this.repository) {
      if (command === 'rev-parse') return this.answer(`${this.repository}\n`);
      assert.equal(command, 'check-ignore');
      return this.ignored ? this.answer(`${rest.at(-1)}\n`) : this.answer('', 1, 'not ignored');
    }
    if (command === 'init') {
      assert.equal(this.repos.has(directory), false);
      this.repo(directory, '', '');
      return this.answer();
    }
    const repo = this.repos.get(directory);
    assert.ok(repo, `Unknown fixture checkout: ${directory}`);
    if (command === 'remote') {
      assert.deepEqual(rest.slice(0, 2), ['add', 'origin']);
      repo.url = rest[2];
      repo.config['remote.origin.url'] = rest[2];
      return this.answer();
    }
    if (command === 'fetch') {
      if (this.failFetch) return this.answer('', 1, 'Explicit injected fetch failure');
      repo.fetched = rest.at(-1);
      return this.answer();
    }
    if (command === 'checkout') {
      assert.equal(rest[0], '--detach');
      assert.equal(rest[1], repo.fetched);
      repo.commit = rest[1];
      if (directory.endsWith(`${path.sep}depot_tools`)) {
        put(path.join(directory, 'gclient.py'), '# --unmanaged --cache-dir --revision --no-history --nohooks --noprehooks');
      }
      return this.answer();
    }
    if (command === 'config') return this.answer(Object.entries(repo.config).map(([key, value]) => `${key}\n${value}\0`).join(''));
    if (command === 'rev-parse') {
      if (rest.includes('--show-toplevel')) return this.answer(`${repo.top || directory}\n`);
      if (rest.includes('--git-common-dir')) return this.answer(`${repo.common || path.join(directory, '.git')}\n`);
      return this.answer(`${repo.commit}\n`);
    }
    if (command === 'ls-files') return this.answer(repo.index);
    if (command === 'status') {
      assert.ok(rest.includes('-z'));
      assert.ok(rest.includes('--ignore-submodules=none'));
      return this.answer(repo.dirty);
    }
    throw new Error(`Unexpected Git operation: ${command}`);
  }

  operations() {
    return this.calls.filter(call => call.guarded).map(call => {
      const boundary = call.args.indexOf('--');
      return { exe: call.args[boundary + 1], args: call.args.slice(boundary + 2), call };
    });
  }
}

function envSystemRoot() { return process.env.SystemRoot || path.parse(process.cwd()).root; }

test('source dependency pins do not opt into downloads or claim a binary build', () => {
  assert.equal(pins.repositories.webrtc.commit, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  assert.equal(pins.repositories.libmediasoupclient.commit, 'c2bf26f046d176b205134a9803b18ac3fdcbb97e');
  assert.equal(pins.repositories.libsdptransform.commit, 'e33aba7005c563286b19a8c90b9520a4384cc259');
  assert.equal(pins.repositories.depot_tools.commit, 'd85491b0a1dcb82dd8e124a876ecd7e3d50dc5e8');
  assert.equal(pins.scope, 'source-dependencies');
  assert.equal(argumentsFor([]).action, 'check');
  assert.equal(argumentsFor(['--json']).action, 'check');
  assert.equal(argumentsFor(['fetch']).action, 'fetch');
  const runtime = path.resolve('native-tools', 'venv', 'Scripts', 'python.exe');
  assert.equal(argumentsFor([`--gclient-python=${runtime}`]).gclientPython, runtime);
  for (const args of [['sync'], ['--workspace=C:\\rtc'], ['fetch', 'fetch'], ['--git=relative.exe'],
    ['--gclient-python=relative.exe'],
    ['--command-timeout-seconds=0'], ['--command-timeout-seconds=7201'], ['fetch', '--help']]) {
    assert.throws(() => argumentsFor(args));
  }
});

test('default check is offline and does not create the workspace or write files', async t => {
  const fixture = new Fixture(t);
  const report = await execute(fixture.context);
  assert.equal(report.mode, 'check');
  assert.equal(report.readOnly, true);
  assert.equal(report.status, 'ready-for-explicit-fetch', JSON.stringify(report.issues));
  assert.equal(report.rtcBuildReady, false);
  assert.equal(report.sourceBootstrapComplete, false);
  assert.equal(report.downloadCommandsExecuted, 0);
  assert.equal(fs.existsSync(fixture.workspace), false);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.operations(), []);
});

test('platform, ambiguous tools, components and SDK patch block before writes/downloads', async t => {
  for (const scenario of ['platform', 'ambiguous', 'python-arch', 'components', 'sdk-version', 'sdk-file']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      if (scenario === 'platform') fixture.context.platform = 'linux';
      if (scenario === 'ambiguous') put(path.join(fixture.toolDir, 'python3.exe'));
      if (scenario === 'python-arch') fixture.pythonPointerBits = 32;
      if (scenario === 'components') fixture.vsInstances = [];
      if (scenario === 'sdk-version') fixture.sdkVersions['bin\\10.0.26100.0\\x64\\rc.exe'] = '10.0.26100.1';
      if (scenario === 'sdk-file') fs.unlinkSync(path.join(fixture.sdk, 'Debuggers', 'x64', 'dbgcore.dll'));
      const report = await execute(fixture.context, { action: 'fetch' });
      assert.equal(report.status, 'blocked');
      assert.equal(report.canFetch, false);
      assert.equal(report.downloadCommandsExecuted, 0);
      assert.equal(fs.existsSync(fixture.workspace), false);
      assert.deepEqual(fixture.writes, []);
      assert.deepEqual(fixture.operations(), []);
      const expected = { platform: 'ERR_RTC_PLATFORM', ambiguous: 'ERR_RTC_TOOL_SELECTION',
        'python-arch': 'ERR_RTC_PYTHON_ARCH', components: 'ERR_RTC_VS_COMPONENTS',
        'sdk-version': 'ERR_RTC_SDK_SERVICING', 'sdk-file': 'ERR_RTC_SDK_FILES' }[scenario];
      assert.ok(report.issues.some(issue => issue.code === expected), JSON.stringify(report.issues));
    });
  }
});

test('a gclient runtime must be explicitly selected, isolated and complete before any acquisition', async t => {
  for (const scenario of ['missing-flag', 'host-python', 'inside-workspace', 'missing-config', 'system-site',
    'duplicate-config', 'python-version', 'python-arch', 'missing-dependency', 'dependency-version', 'foreign-import']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      const options = { action: 'fetch' };
      if (scenario === 'missing-flag') options.gclientPython = undefined;
      if (scenario === 'host-python') options.gclientPython = fixture.python;
      if (scenario === 'inside-workspace') options.gclientPython = path.join(fixture.workspace, 'venv', 'Scripts', 'python.exe');
      const config = path.join(fixture.gclientVenv, 'pyvenv.cfg');
      if (scenario === 'missing-config') fs.unlinkSync(config);
      if (scenario === 'system-site') put(config, 'include-system-site-packages = true\n');
      if (scenario === 'duplicate-config') put(config,
        'include-system-site-packages = false\ninclude-system-site-packages = false\n');
      if (scenario === 'python-version') fixture.runtimeVersion = [3, 14, 4];
      if (scenario === 'python-arch') fixture.runtimePointerBits = 32;
      if (scenario === 'missing-dependency') fixture.runtimeFailure = 'No module named httplib2';
      if (scenario === 'dependency-version') fixture.runtimeRequirements[0].version = '0.22.0';
      if (scenario === 'foreign-import') fixture.runtimeRequirements[0].origin =
        path.join(fixture.toolDir, 'Lib', 'site-packages', 'httplib2.py');
      const report = await execute(fixture.context, options);
      assert.equal(report.status, 'blocked', JSON.stringify(report));
      assert.equal(report.canFetch, false);
      assert.equal(report.downloadCommandsExecuted, 0);
      assert.equal(fs.existsSync(fixture.workspace), false);
      assert.deepEqual(fixture.writes, []);
      assert.deepEqual(fixture.operations(), []);
      if (scenario === 'missing-flag') assert.equal(report.issues[0].code, 'ERR_RTC_GCLIENT_PYTHON');
      if (scenario === 'missing-dependency') assert.match(report.issues[0].message, /httplib2/u);
    });
  }
});

test('multiple Git installations require one explicit executable before acquisition', async t => {
  const fixture = new Fixture(t);
  const other = path.join(fixture.root, 'other-git');
  put(path.join(other, 'git.exe'));
  fixture.context.env.PATH = [fixture.toolDir, other].join(path.delimiter);
  const ambiguous = await execute(fixture.context);
  assert.equal(ambiguous.canFetch, false);
  assert.ok(ambiguous.issues.some(issue => issue.code === 'ERR_RTC_TOOL_SELECTION'));
  const selected = await execute(fixture.context, { git: fixture.git });
  assert.equal(selected.canFetch, true, JSON.stringify(selected.issues));
  assert.equal(selected.tools.git.path, fixture.git);
  assert.equal(selected.downloadCommandsExecuted, 0);
  assert.deepEqual(fixture.writes, []);
});

test('shared Debuggers allow newer families while rc.exe retains its SDK family', async t => {
  for (const scenario of ['newer-debuggers', 'wrong-rc-family', 'old-debugger', 'malformed-debugger']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      fixture.sdkVersions['Debuggers\\x64\\dbghelp.dll'] = '10.0.28000.1';
      fixture.sdkVersions['Debuggers\\x64\\dbgcore.dll'] = '10.0.28000.1';
      if (scenario === 'wrong-rc-family') fixture.sdkVersions['bin\\10.0.26100.0\\x64\\rc.exe'] = '10.0.28000.1';
      if (scenario === 'old-debugger') fixture.sdkVersions['Debuggers\\x64\\dbgcore.dll'] = '10.0.26100.3322';
      if (scenario === 'malformed-debugger') fixture.sdkVersions['Debuggers\\x64\\dbgcore.dll'] = '10..28000.1';
      const report = await execute(fixture.context);
      assert.equal(report.canFetch, scenario === 'newer-debuggers', JSON.stringify(report.issues));
      assert.deepEqual(fixture.writes, []);
      assert.deepEqual(fixture.operations(), []);
    });
  }
});

test('unowned or wrong-owner workspaces are never adopted, even if empty', async t => {
  for (const scenario of ['empty', 'owner', 'pins', 'path', 'extra']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      fixture.own();
      const filename = path.join(fixture.workspace, constants.OWNER);
      const owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (scenario === 'empty') fs.unlinkSync(filename);
      if (scenario === 'owner') owner.owner = 'another-tool';
      if (scenario === 'pins') owner.pinsHash = 'different';
      if (scenario === 'path') owner.workspace = fixture.root;
      if (scenario === 'extra') put(path.join(fixture.workspace, 'foreign.txt'));
      if (!['empty', 'extra'].includes(scenario)) put(filename, JSON.stringify(owner));
      const report = await execute(fixture.context, { action: 'fetch' });
      assert.equal(report.canFetch, false);
      assert.equal(fixture.operations().length, 0);
      assert.deepEqual(fixture.writes, []);
    });
  }
});

test('dirty, wrong HEAD/origin, linked Git metadata and hidden index flags block before fetch', async t => {
  for (const scenario of ['dirty', 'head', 'origin', 'common', 'index', 'config', 'alternates']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      fixture.own();
      const repo = fixture.pinned('libmediasoupclient');
      if (scenario === 'dirty') repo.dirty = ' M existing.cpp\n';
      if (scenario === 'head') repo.commit = DEP_SHA;
      if (scenario === 'origin') repo.config['remote.origin.url'] = 'https://example.invalid/other.git';
      if (scenario === 'common') repo.common = path.join(fixture.root, 'foreign.git');
      if (scenario === 'index') repo.index = 'h hidden.cpp\0';
      if (scenario === 'config') repo.config['include.path'] = path.join(fixture.root, 'foreign.config');
      if (scenario === 'alternates') put(path.join(repo.directory, '.git', 'objects', 'info', 'alternates'), fixture.root);
      const report = await execute(fixture.context, { action: 'fetch' });
      assert.equal(report.canFetch, false);
      assert.equal(fixture.operations().length, 0);
      assert.deepEqual(fixture.writes, []);
    });
  }
});

test('config validation never accepts additional solutions, code, managed mode or custom hooks', async t => {
  const fixture = new Fixture(t);
  for (const document of [
    { ...solution(), unknown: true },
    { ...solution(), cache_dir: 'foreign' },
    { ...solution(), solutions: [...solution().solutions, ...solution().solutions] },
    { ...solution(), solutions: [{ ...solution().solutions[0], managed: true }] },
    { ...solution(), solutions: [{ ...solution().solutions[0], custom_deps: { x: null } }] },
    { ...solution(), solutions: [{ ...solution().solutions[0], url: 'https://example.invalid/other.git' }] },
  ]) assert.throws(() => validateConfig(document, pins.repositories.webrtc.url));
  fixture.own();
  put(path.join(fixture.workspace, 'webrtc', '.gclient'), "import os\nos.system('no')\n");
  const report = await execute(fixture.context, { action: 'fetch' });
  assert.equal(report.canFetch, false);
  assert.equal(fixture.operations().length, 0);
  assert.deepEqual(fixture.writes, []);
});

test('gclient Git cache must be explicitly disabled before any acquisition', async t => {
  const fixture = new Fixture(t);
  fixture.own();
  put(path.join(fixture.workspace, 'webrtc', '.gclient'), configText({ solutions: solution().solutions }));
  const report = await execute(fixture.context, { action: 'fetch' });
  assert.equal(report.canFetch, false);
  assert.ok(report.issues.some(issue => issue.code === 'ERR_RTC_GCLIENT_CONFIG'));
  assert.equal(fixture.operations().length, 0);
  assert.deepEqual(fixture.writes, []);
  assert.doesNotThrow(() => validateConfig(solution(), pins.repositories.webrtc.url));
});

test('only the exact non-executing Git settings generated by gclient are accepted', () => {
  const settings = new Map([
    ['remote.origin.url', [DEP_URL]],
    ['blame.ignorerevsfile', ['.git-blame-ignore-revs']],
    ['diff.ignoresubmodules', ['dirty']],
    ['fetch.recursesubmodules', ['off']],
    ['push.recursesubmodules', ['off']],
  ]);
  assert.doesNotThrow(() => safeGitConfig(settings, DEP_URL));
  for (const key of [...settings.keys()].filter(key => key !== 'remote.origin.url')) {
    const changed = new Map(settings);
    changed.set(key, ['foreign']);
    assert.throws(() => safeGitConfig(changed, DEP_URL), /Unexpected value/u);
    changed.set(key, [...settings.get(key), ...settings.get(key)]);
    assert.throws(() => safeGitConfig(changed, DEP_URL), /Unexpected value/u);
  }
});

test('partial WebRTC sync, stale lock and nonignored paths never trigger a repair', async t => {
  for (const scenario of ['partial', 'lock', 'ignore']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      fixture.own();
      if (scenario === 'partial') fixture.pinned('webrtc');
      if (scenario === 'lock') put(path.join(fixture.workspace, constants.LOCK), '{}');
      if (scenario === 'ignore') fixture.ignored = false;
      const report = await execute(fixture.context, { action: 'fetch' });
      assert.equal(report.canFetch, false);
      assert.equal(fixture.operations().length, 0);
      assert.deepEqual(fixture.writes, []);
    });
  }
});

test('a junction cannot redirect the dedicated workspace into another directory', async t => {
  const fixture = new Fixture(t);
  const target = path.join(fixture.root, 'foreign');
  fs.mkdirSync(target);
  fs.mkdirSync(path.dirname(fixture.workspace), { recursive: true });
  fs.symlinkSync(target, fixture.workspace, 'junction');
  const report = await execute(fixture.context, { action: 'fetch' });
  assert.equal(report.canFetch, false);
  assert.equal(report.issues[0].code, 'ERR_RTC_PATH_ALIAS');
  assert.deepEqual(fs.readdirSync(target), []);
  assert.deepEqual(fixture.writes, []);
});

test('child environment freezes tools and isolates caches without mutating the caller', async t => {
  const fixture = new Fixture(t);
  const before = clone(fixture.context.env);
  await execute(fixture.context);
  assert.deepEqual(fixture.context.env, before);
  for (const call of fixture.calls) {
    assert.equal(call.env.DEPOT_TOOLS_UPDATE, '0');
    assert.equal(call.env.DEPOT_TOOLS_WIN_TOOLCHAIN, '0');
    assert.equal(call.env.GIT_DIR, undefined);
    assert.equal(call.env.PYTHONPATH, undefined);
    assert.equal(call.env.GCLIENT_FILE, undefined);
    assert.equal(call.env.GIT_CONFIG_GLOBAL, 'NUL');
    assert.equal(call.env.GIT_CONFIG_COUNT, '5');
    assert.equal(call.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(call.env.HOME, path.join(fixture.workspace, 'cache', 'home'));
    const firstDirectory = call.env.VIRTUAL_ENV ? path.dirname(fixture.gclientPython) : fixture.toolDir;
    assert.ok(call.env.PATH.startsWith(`${firstDirectory}${path.delimiter}`));
    assert.equal(call.guarded, false);
    if (call.exe === fixture.python && (call.args.includes('metadata') || call.args.includes('literal'))) {
      assert.deepEqual(call.args.slice(0, 3), ['-I', '-S', '-B']);
    }
  }
});

test('explicit fetch uses immutable SHAs, private jobs and initial pinned no-history sync', async t => {
  const fixture = new Fixture(t);
  const report = await execute(fixture.context, { action: 'fetch', commandTimeoutSeconds: 60 });
  assert.equal(report.canFetch, true, JSON.stringify(report.issues));
  assert.equal(report.sourceBootstrapComplete, true);
  assert.equal(report.rtcBuildReady, false);
  assert.equal(Object.hasOwn(report, 'productionApproved'), false);
  assert.equal(report.downloadCommandsExecuted, 4);
  assert.equal(fs.existsSync(path.join(fixture.workspace, constants.LOCK)), false);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.workspace, constants.STATE), 'utf8'));
  assert.equal(state.repositories.length, 5);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.artifacts.length, 2);
  assert.deepEqual(report.dependencyCounts, { git: 2, cipd: 1, gcs: 1, excluded: 0 });
  assert.equal(report.artifactContentIntegrityVerified, false);
  assert.equal(state.artifacts.find(entry => entry.kind === 'cipd').package, 'gn/gn/windows-amd64');
  assert.equal(state.artifacts.find(entry => entry.kind === 'gcs').object, GCS_OBJECT);
  assert.ok(state.repositories.every(entry => !entry.directory.includes(':')));
  assert.equal(state.sourceToolchain.clangPackagePin, pins.baseline.clang.packagePin);
  const operations = fixture.operations();
  assert.equal(operations.length, 14);
  for (const operation of operations) {
    assert.equal(operation.call.env.DEPOT_TOOLS_UPDATE, '0');
    assert.equal(operation.call.env.DEPOT_TOOLS_WIN_TOOLCHAIN, '0');
    assert.ok(operation.call.args.includes('60'));
    assert.ok(operation.call.args.includes('--'));
    assert.deepEqual(operation.call.args.slice(0, 3), ['-I', '-S', '-B']);
    assert.equal(operation.args.includes('reset'), false);
    assert.equal(operation.args.includes('clone'), false);
    assert.equal(operation.args.includes('--hard'), false);
    assert.equal(operation.args.includes('pull'), false);
  }
  const fetched = operations.filter(operation => operation.exe === fixture.git && operation.args[4] === 'fetch');
  assert.deepEqual(fetched.map(operation => operation.args.at(-1)), [
    pins.repositories.depot_tools.commit, pins.repositories.libmediasoupclient.commit, pins.repositories.libsdptransform.commit,
  ]);
  const config = operations.find(operation => operation.args.includes('config') && operation.exe === fixture.gclientPython);
  assert.deepEqual(config.args.slice(-6),
    ['config', '--unmanaged', '--cache-dir=None', '--name', 'src', pins.repositories.webrtc.url]);
  const sync = operations.find(operation => operation.args.includes('sync'));
  assert.deepEqual(sync.args.slice(-6), ['sync', '--revision',
    `src@${pins.repositories.webrtc.commit}`, '--no-history', '--nohooks', '--noprehooks']);
  assert.equal(sync.exe, fixture.gclientPython);
  assert.deepEqual(sync.args.slice(0, 3), ['-B', '-E', '-s']);
  const validatedAt = fixture.calls.findIndex(call => call.args.includes('gclient-runtime'));
  const firstMutation = fixture.calls.findIndex(call => call.guarded);
  assert.ok(validatedAt >= 0 && validatedAt < firstMutation);
});

test('a completed pinned workspace is checked but not synced, checked out or rewritten again', async t => {
  const fixture = new Fixture(t);
  await execute(fixture.context, { action: 'fetch' });
  fixture.calls = [];
  fixture.writes = [];
  const second = await execute(fixture.context, { action: 'fetch' });
  assert.equal(second.sourceBootstrapComplete, true);
  assert.equal(second.noOp, true);
  assert.equal(second.readOnly, true);
  assert.equal(fixture.operations().length, 0);
  assert.deepEqual(fixture.writes, []);
});

test('completed source inspection reuses all identity guards without writing or acquiring', async t => {
  const fixture = new Fixture(t);
  await execute(fixture.context, { action: 'fetch' });
  const owner = JSON.parse(fs.readFileSync(path.join(fixture.workspace, constants.OWNER), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(fixture.workspace, constants.STATE), 'utf8'));
  fixture.calls = [];
  fixture.writes = [];
  const inspected = await inspectCompletedSources(fixture.context, owner);
  assert.deepEqual(inspected.state, state);
  assert.equal(inspected.artifactContentIntegrityVerified, false);
  assert.deepEqual(fixture.operations(), []);
  assert.deepEqual(fixture.writes, []);
  fixture.repos.get(path.join(fixture.workspace, 'webrtc', 'src', 'buildtools')).dirty = ' M local-edit\n';
  await assert.rejects(inspectCompletedSources(fixture.context, owner), /staged|unstaged|untracked/u);
  assert.deepEqual(fixture.writes, []);
});

test('Git index inspection has a bounded budget large enough for pinned Chromium third_party', async t => {
  const fixture = new Fixture(t);
  await execute(fixture.context, { action: 'fetch' });
  const inspections = fixture.calls.filter(call => call.label === 'Inspect hidden index flags');
  assert.ok(inspections.length > 0);
  for (const call of inspections) {
    assert.ok(call.maxOutputBytes >= 18806688);
    assert.equal(call.maxOutputBytes, 32 * 1024 * 1024);
    assert.equal(call.tail, false);
  }
});

for (const status of [
  '?? buildtools-extra/\0',
  '?? buildtools/local.cc\0',
  ' M buildtools/\0',
  '?? buildtools/\0?? local.cc\0',
  '?? buildtools/\n',
]) {
  test(`nested checkout allowance rejects unrelated or malformed parent status ${JSON.stringify(status)}`, async t => {
    const fixture = new Fixture(t);
    await execute(fixture.context, { action: 'fetch' });
    fixture.repos.get(path.join(fixture.workspace, 'webrtc', 'src')).dirty = status;
    fixture.calls = [];
    fixture.writes = [];
    const result = await execute(fixture.context, { action: 'fetch' });
    assert.equal(result.canFetch, false);
    assert.ok(result.issues.some(issue => issue.code === 'ERR_RTC_DIRTY'));
    assert.deepEqual(fixture.operations(), []);
    assert.deepEqual(fixture.writes, []);
  });
}

test('a declared nested repository still rejects its own untracked files', async t => {
  const fixture = new Fixture(t);
  await execute(fixture.context, { action: 'fetch' });
  fixture.repos.get(path.join(fixture.workspace, 'webrtc', 'src', 'buildtools')).dirty = '?? local.cc\0';
  fixture.calls = [];
  fixture.writes = [];
  const result = await execute(fixture.context, { action: 'fetch' });
  assert.equal(result.canFetch, false);
  assert.ok(result.issues.some(issue => issue.code === 'ERR_RTC_DIRTY'));
  assert.deepEqual(fixture.operations(), []);
  assert.deepEqual(fixture.writes, []);
});

test('typed entry parsing follows pinned upstream formats without using identity suffixes as paths', () => {
  const cipd = dependencyEntry(CIPD_KEY, CIPD_URL);
  assert.equal(cipd.kind, 'cipd');
  assert.equal(cipd.directory, path.join('webrtc', 'src', 'buildtools', 'win'));
  assert.equal(cipd.version, 'git_revision:3a4f5cea73eca32e9586e8145f97b04cbd4a1aee');
  const gcs = dependencyEntry(GCS_KEY, GCS_URL);
  assert.equal(gcs.kind, 'gcs');
  assert.equal(gcs.bucket, 'chromium-fonts');
  assert.equal(gcs.directory, path.join('webrtc', ...GCS_PATH.split('/')));
  const templated = dependencyEntry('src/buildtools/reclient:infra/rbe/client/${platform}',
    'https://chrome-infra-packages.appspot.com/infra/rbe/client/${platform}@version:fixture');
  assert.equal(templated.package, 'infra/rbe/client/${platform}');
  const ninja = dependencyEntry('src/third_party/ninja:infra/3pp/tools/ninja/${platform}',
    'https://chrome-infra-packages.appspot.com/infra/3pp/tools/ninja/${platform}@version:3@1.12.1.chromium.4');
  assert.equal(ninja.package, 'infra/3pp/tools/ninja/${platform}');
  assert.equal(ninja.version, 'version:3@1.12.1.chromium.4');
  assert.equal(dependencyEntry('src/disabled', null).kind, 'excluded');
  assert.equal(dependencyEntry('src/third_party/llvm-build/Release+Asserts:Win/clang.tar.xz',
    'gs://chromium-browser-clang/Win/clang.tar.xz').object, 'Win/clang.tar.xz');
  for (const [entry, source] of [
    ['src/../escape:gn/gn/windows-amd64', CIPD_URL],
    ['src\\escape:gn/gn/windows-amd64', CIPD_URL],
    ['src/buildtools/win.:gn/gn/windows-amd64', CIPD_URL],
    ['src/AUX:gn/gn/windows-amd64', CIPD_URL],
    ['src/buildtools/win:../escape', 'https://chrome-infra-packages.appspot.com/../escape@version:1'],
    [CIPD_KEY, CIPD_URL.replace('/gn/gn/', '/different/')],
    [CIPD_KEY, `${CIPD_URL}#other`],
    [GCS_KEY, GCS_URL.replace(GCS_OBJECT, 'different-object')],
    ['src/fonts:../../escape', 'gs://chromium-fonts/../../escape'],
    [GCS_KEY, 'https://example.invalid/object'],
    [CIPD_KEY, null],
    [`src/fonts:${'a'.repeat(1025)}`, `gs://chromium-fonts/${'a'.repeat(1025)}`],
  ]) assert.throws(() => dependencyEntry(entry, source));
});

test('multiple CIPD identities may share one directory and remain complete on a read-only no-op', async t => {
  const fixture = new Fixture(t);
  fixture.extraEntries['src/buildtools/win:infra/rbe/client/${platform}'] =
    'https://chrome-infra-packages.appspot.com/infra/rbe/client/${platform}@version:3@fixture';
  const first = await execute(fixture.context, { action: 'fetch' });
  assert.equal(first.sourceBootstrapComplete, true);
  assert.equal(first.dependencyCounts.cipd, 2);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.workspace, constants.STATE), 'utf8'));
  const packages = state.artifacts.filter(entry => entry.kind === 'cipd');
  assert.equal(packages[0].directory, packages[1].directory);
  assert.notEqual(packages[0].package, packages[1].package);
  fixture.calls = [];
  fixture.writes = [];
  const second = await execute(fixture.context, { action: 'fetch' });
  assert.equal(second.sourceBootstrapComplete, true, JSON.stringify(second.issues));
  assert.equal(second.noOp, true);
  assert.equal(second.dependencyCounts.cipd, 2);
  assert.deepEqual(fixture.operations(), []);
  assert.deepEqual(fixture.writes, []);
});

test('missing package materialization, registry or state coverage blocks a completed no-op', async t => {
  for (const scenario of ['cipd-directory', 'cipd-registry', 'gcs-directory', 'gcs-registry', 'gcs-object',
    'state-omission', 'state-duplicate', 'entry-drift', 'old-state-schema']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      await execute(fixture.context, { action: 'fetch' });
      const root = path.join(fixture.workspace, 'webrtc');
      if (scenario === 'cipd-directory') fs.unlinkSync(path.join(root, 'src', 'buildtools', 'win', 'gn.exe'));
      if (scenario === 'cipd-registry') fs.rmdirSync(path.join(root, '.cipd'));
      if (scenario === 'gcs-directory') fs.unlinkSync(path.join(root, ...GCS_PATH.split('/'), 'font-fixture.data'));
      if (scenario === 'gcs-registry') fs.unlinkSync(path.join(root, '.gcs_entries'));
      if (scenario === 'gcs-object') put(path.join(root, '.gcs_entries'), JSON.stringify({ src: { [GCS_PATH]: [] } }));
      if (scenario.startsWith('state-') || scenario === 'old-state-schema') {
        const file = path.join(fixture.workspace, constants.STATE);
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (scenario === 'state-omission') state.artifacts.shift();
        if (scenario === 'state-duplicate') state.artifacts.push(clone(state.artifacts[0]));
        if (scenario === 'old-state-schema') state.schemaVersion = 1;
        put(file, JSON.stringify(state));
      }
      if (scenario === 'entry-drift') fs.appendFileSync(path.join(root, '.gclient_entries'), '# drift\n');
      fixture.calls = [];
      fixture.writes = [];
      const report = await execute(fixture.context, { action: 'fetch' });
      assert.equal(report.canFetch, false, JSON.stringify(report));
      assert.equal(report.sourceBootstrapComplete, false);
      assert.deepEqual(fixture.operations(), []);
      assert.deepEqual(fixture.writes, []);
    });
  }
});

test('an artifact junction cannot redirect read-only materialization checks', async t => {
  const fixture = new Fixture(t);
  await execute(fixture.context, { action: 'fetch' });
  const directory = path.join(fixture.workspace, 'webrtc', 'src', 'buildtools', 'win');
  fs.unlinkSync(path.join(directory, 'gn.exe'));
  fs.rmdirSync(directory);
  const foreign = path.join(fixture.root, 'foreign-artifact');
  put(path.join(foreign, 'gn.exe'), 'must remain untouched');
  fs.symlinkSync(foreign, directory, 'junction');
  fixture.writes = [];
  fixture.calls = [];
  const report = await execute(fixture.context, { action: 'fetch' });
  assert.equal(report.canFetch, false);
  assert.ok(report.issues.some(issue => issue.code === 'ERR_RTC_PATH_ALIAS'));
  assert.deepEqual(fixture.operations(), []);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fs.readFileSync(path.join(foreign, 'gn.exe'), 'utf8'), 'must remain untouched');
});

test('dependency edits and completed config drift are never silently resynced', async t => {
  for (const scenario of ['dependency', 'config']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      await execute(fixture.context, { action: 'fetch' });
      if (scenario === 'dependency') fixture.repos.get(path.join(fixture.workspace, 'webrtc', 'src', 'buildtools')).dirty = ' M file\n';
      else fs.appendFileSync(path.join(fixture.workspace, 'webrtc', '.gclient'), '\n# changed\n');
      fixture.calls = [];
      fixture.writes = [];
      const report = await execute(fixture.context, { action: 'fetch' });
      assert.equal(report.canFetch, false);
      assert.equal(fixture.operations().length, 0);
      assert.deepEqual(fixture.writes, []);
    });
  }
});

test('failed acquisition retains its exact owned lock/partial tree and does not auto-retry', async t => {
  for (const scenario of ['fetch', 'sync']) {
    await t.test(scenario, async child => {
      const fixture = new Fixture(child);
      fixture.failFetch = scenario === 'fetch';
      fixture.failSync = scenario === 'sync';
      await assert.rejects(execute(fixture.context, { action: 'fetch' }), /injected/u);
      assert.equal(fs.existsSync(path.join(fixture.workspace, constants.LOCK)), true);
      assert.equal(fs.existsSync(path.join(fixture.workspace, constants.STATE)), false);
      fixture.calls = [];
      fixture.writes = [];
      const again = await execute(fixture.context, { action: 'fetch' });
      assert.equal(again.canFetch, false);
      assert.deepEqual(fixture.operations(), []);
      assert.deepEqual(fixture.writes, []);
    });

  }
});

test('changes during sync cannot be sealed into a completed state', async t => {
  const fixture = new Fixture(t);
  fixture.mutateAfterSync = true;
  await assert.rejects(execute(fixture.context, { action: 'fetch' }), /staged|unstaged|untracked/u);
  assert.equal(fs.existsSync(path.join(fixture.workspace, constants.STATE)), false);
  assert.equal(fs.existsSync(path.join(fixture.workspace, constants.LOCK)), true);
});

test('programmatic invalid deadlines fail before spawning tools or writing files', async t => {
  const fixture = new Fixture(t);
  for (const deadline of [0, -1, NaN, Infinity, 7201]) {
    await assert.rejects(execute(fixture.context, { action: 'fetch', commandTimeoutSeconds: deadline }),
      /bounded command deadline/u);
  }
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.writes, []);
});

test('Git config parsing rejects helpers/includes/promisors rather than reading a foreign setup', () => {
  const good = parseLocalConfig('core.bare\nfalse\0remote.origin.url\nhttps://example.invalid/source.git\0');
  safeGitConfig(good, 'https://example.invalid/source.git');
  for (const key of ['include.path', 'filter.lfs.process', 'remote.origin.promisor',
    'core.worktree', 'core.fsmonitor', 'url.bad.insteadof', 'credential.helper']) {
    const values = new Map(good);
    values.set(key, ['foreign']);
    assert.throws(() => safeGitConfig(values, 'https://example.invalid/source.git'));
  }
});

test('state rejects path traversal and a changed pin', t => {
  const fixture = new Fixture(t);
  const owner = ownerDocument(fixture.context, OWNER_ID);
  const base = { schemaVersion: 2, ownerId: OWNER_ID, pinsHash: fixture.context.pinHash, artifacts: [],
    completed: true, configHash: 'a'.repeat(64), entriesHash: 'b'.repeat(64),
    repositories: Object.entries(pins.repositories).map(([name, definition]) =>
      ({ directory: constants.DIRECTORIES[name], url: definition.url, commit: definition.commit })) };
  validateState(fixture.context, owner, base);
  const changed = clone(base);
  changed.repositories[0].commit = DEP_SHA;
  assert.throws(() => validateState(fixture.context, owner, changed));
  const traversal = clone(base);
  traversal.repositories.push({ directory: path.join('webrtc', 'src', '..', '..', '..', 'foreign'),
    url: DEP_URL, commit: DEP_SHA });
  assert.throws(() => validateState(fixture.context, owner, traversal));
  const alias = clone(base);
  alias.repositories.push({ directory: 'webrtc\\src\\..\\..\\libmediasoupclient',
    url: DEP_URL, commit: DEP_SHA });
  assert.throws(() => validateState(fixture.context, owner, alias));
});

test('environment creation itself never creates cache directories', t => {
  const fixture = new Fixture(t);
  const before = { ...process.env };
  const child = childEnvironment(fixture.context);
  assert.equal(child.DEPOT_TOOLS_UPDATE, '0');
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'Parent environment changed.');
  assert.equal(fs.existsSync(fixture.workspace), false);
});

test('Python Manager is never launched or used to install an absent interpreter', t => {
  const fixture = new Fixture(t);
  const manager = path.join(fixture.root, 'Python');
  const bin = path.join(manager, 'bin');
  put(path.join(bin, 'python.exe'));
  fixture.context.env.PATH = bin;
  assert.throws(() => selectExecutable(fixture.context, undefined, ['python.exe', 'python3.exe'], 'Python'));
  const installed = path.join(manager, 'pythoncore-3.14-64');
  put(path.join(installed, 'python.exe'));
  put(path.join(installed, 'python3.dll'));
  put(path.join(installed, 'Lib', 'os.py'));
  assert.equal(selectExecutable(fixture.context, undefined, ['python.exe', 'python3.exe'], 'Python'),
    path.join(installed, 'python.exe'));
  const second = path.join(manager, 'pythoncore-3.13-64');
  put(path.join(second, 'python.exe'));
  put(path.join(second, 'python3.dll'));
  put(path.join(second, 'Lib', 'os.py'));
  assert.throws(() => selectExecutable(fixture.context, undefined, ['python.exe', 'python3.exe'], 'Python'));
  assert.equal(selectExecutable(fixture.context, path.join(installed, 'python.exe'),
    ['python.exe', 'python3.exe'], 'Python'), path.join(installed, 'python.exe'));
  assert.deepEqual(fixture.calls, []);
});

test('real Python literal helper stays offline and does not execute configuration',
  { skip: process.platform !== 'win32' }, async () => {
  const python = selectExecutable(createContext(), process.env.PYTHON, ['python.exe', 'python3.exe'], 'Python');
  const result = await spawnRunner({
    exe: python, args: ['-I', '-S', '-B', path.join(toolsDirectory, 'windows_support.py'), 'self-test'],
    cwd: __dirname, env: { ...process.env }, timeoutMs: 15000, maxOutputBytes: 65536, guarded: false,
    label: 'Offline literal helper self-test',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { success: true, tests: 6, network: false, mutations: false });
});

test('real offline venv probe validates imports, versions, origins and isolation without pip',
  { skip: process.platform !== 'win32' }, async t => {
  const fixture = new Fixture(t);
  const python = selectExecutable(createContext(), process.env.PYTHON, ['python.exe', 'python3.exe'], 'Python');
  const run = (exe, args, input) => spawnRunner({
    exe, args, input, cwd: fixture.root,
    env: { ...process.env, PYTHONPATH: path.join(fixture.root, 'foreign'), PYTHONDONTWRITEBYTECODE: '1' },
    timeoutMs: 15000, maxOutputBytes: 65536, guarded: false, label: 'Offline venv fixture contract',
  });
  const base = await run(python, ['-I', '-S', '-B', '-c',
    'import json, sys; print(json.dumps(list(sys.version_info[:2])))']);
  assert.equal(base.code, 0, base.stderr);
  const venv = path.join(fixture.root, 'offline-venv');
  const created = await run(python, ['-I', '-S', '-B', '-m', 'venv', '--without-pip', venv]);
  assert.equal(created.code, 0, created.stderr);
  const selected = path.join(venv, 'Scripts', 'python.exe');
  const site = path.join(venv, 'Lib', 'site-packages');
  const module = path.join(site, 'rtc_fixture_dependency.py');
  const metadata = path.join(site, 'rtc_fixture_dependency-1.0.0.dist-info', 'METADATA');
  const dependencyMetadata = 'Metadata-Version: 2.1\nName: rtc-fixture-dependency\nVersion: 1.0.0\n';
  put(module, 'VALUE = "owned fixture only"\n');
  put(metadata, dependencyMetadata);
  const specification = {
    python: JSON.parse(base.stdout), pointerBits: 64,
    requirements: [{ distribution: 'rtc-fixture-dependency', version: '1.0.0',
      module: 'rtc_fixture_dependency', imports: [] }],
  };
  const args = ['-B', '-E', '-s', path.join(toolsDirectory, 'windows_support.py'), 'gclient-runtime'];
  const probe = (changes = {}, flags = args, executable = selected) =>
    run(executable, flags, JSON.stringify({ ...specification, ...changes }));
  const good = await probe();
  assert.equal(good.code, 0, good.stderr);
  const observed = JSON.parse(good.stdout);
  assert.equal(path.resolve(observed.prefix).toLowerCase(), venv.toLowerCase());
  assert.equal(observed.pythonImplementation, 'cpython');
  assert.equal(observed.includeSystemSitePackages, false);
  assert.equal(observed.requirements[0].version, '1.0.0');
  assert.equal(fs.existsSync(path.join(site, '__pycache__')), false);
  assert.equal(fs.existsSync(path.join(site, 'pip')), false);

  const host = await probe({}, args, python);
  assert.notEqual(host.code, 0);
  assert.match(host.stderr, /venv/u);
  const wrongPython = await probe({ python: [3, 0] });
  assert.notEqual(wrongPython.code, 0);
  for (const flag of ['-I', '-S']) {
    const isolatedWrongly = await probe({}, [flag, ...args]);
    assert.notEqual(isolatedWrongly.code, 0);
  }
  const configPath = path.join(venv, 'pyvenv.cfg');
  const config = fs.readFileSync(configPath, 'utf8');
  put(configPath, config.replace('include-system-site-packages = false', 'include-system-site-packages = true'));
  const globalSite = await probe();
  assert.notEqual(globalSite.code, 0);
  assert.match(globalSite.stderr, /site-packages/u);
  put(configPath, config);
  put(metadata, dependencyMetadata.replace('1.0.0', '2.0.0'));
  const wrongDependency = await probe();
  assert.notEqual(wrongDependency.code, 0);
  assert.match(wrongDependency.stderr, /Wrong gclient dependency version/u);
  put(metadata, dependencyMetadata);
  fs.unlinkSync(module);
  const missingModule = await probe();
  assert.notEqual(missingModule.code, 0);
  assert.match(missingModule.stderr, /No module named/u);
  const foreign = path.join(fixture.root, 'foreign');
  put(path.join(foreign, 'rtc_fixture_dependency.py'), 'VALUE = "must not be accepted"\n');
  put(path.join(site, 'foreign.pth'), `${foreign}\n`);
  const foreignModule = await probe();
  assert.notEqual(foreignModule.code, 0);
  assert.match(foreignModule.stderr, /outside its dedicated venv/u);
});

test('private Windows job executes only a small owned Node command without a shell',
  { skip: process.platform !== 'win32' }, async t => {
  const fixture = new Fixture(t);
  const python = selectExecutable(createContext(), process.env.PYTHON, ['python.exe', 'python3.exe'], 'Python');
  const result = await spawnRunner({
    exe: python,
    args: ['-I', '-S', '-B', path.join(toolsDirectory, 'owned_process.py'),
      '--cwd', fixture.root, '--timeout-seconds', '5', '--',
      process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'space and "quote"'],
    cwd: fixture.root, env: { ...process.env }, timeoutMs: 15000, maxOutputBytes: 65536, guarded: true,
    label: 'Owned offline process/argument contract',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['space and "quote"']);
});

test('private job deadline closes only its own non-media Node process',
  { skip: process.platform !== 'win32' }, async t => {
  const fixture = new Fixture(t);
  const python = selectExecutable(createContext(), process.env.PYTHON, ['python.exe', 'python3.exe'], 'Python');
  const result = await spawnRunner({
    exe: python,
    args: ['-I', '-S', '-B', path.join(toolsDirectory, 'owned_process.py'),
      '--cwd', fixture.root, '--timeout-seconds', '1', '--',
      process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    cwd: fixture.root, env: { ...process.env }, timeoutMs: 10000, maxOutputBytes: 65536, guarded: true,
    label: 'Owned offline process deadline contract',
  });
  assert.equal(result.code, 125);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.code, 'ERR_RTC_OWNED_PROCESS');
  assert.match(failure.message, /deadline/u);
});
