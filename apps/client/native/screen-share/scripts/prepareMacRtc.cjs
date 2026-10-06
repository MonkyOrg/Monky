'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, withNetworkRetries } = require('./buildTools.cjs');
const pins = require('./native-rtc/pins.json');

const workspace = path.resolve(root, '..', '..', '..', '..', '.native-screen', 'mac-rtc');
const reserveBytes = 4 * 1024 ** 3;

function checkSpace(directory = workspace) {
  const space = fs.statfsSync(directory);
  assert.ok(space.bavail * space.bsize >= reserveBytes,
    'Native macOS preparation stopped: preserve at least 4 GiB of free disk space.');
}

function checkout(name, directory, env) {
  const pin = pins.repositories[name];
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    execute('git', ['init', '--quiet', directory], { env });
    execute('git', ['-C', directory, 'remote', 'add', 'origin', pin.url], { env });
  }
  assert.equal(execute('git', ['-C', directory, 'remote', 'get-url', 'origin'], { env, capture: true }), pin.url);
  const head = execute('git', ['-C', directory, 'rev-parse', '--verify', '--quiet', '--end-of-options',
    `${pin.commit}^{commit}`], { env, capture: true });
  assert.equal(head, pin.commit);
  execute('git', ['-C', directory, 'checkout', '--quiet', '--detach', pin.commit], { env });
}

function prepare({ python = 'python3.11' } = {}) {
  assert.equal(process.platform, 'darwin', 'The macOS RTC toolchain requires macOS.');
  assert.ok(['arm64', 'x64'].includes(process.arch));
  assert.equal(execute(python, ['-I', '-c',
    'import sys; print(".".join(map(str, sys.version_info[:2])))'], { capture: true }), '3.11',
  'Use Python 3.11 for the pinned gclient toolchain.');
  fs.mkdirSync(workspace, { recursive: true });
  assert.ok(!fs.lstatSync(workspace).isSymbolicLink());
  const marker = path.join(workspace, '.monky-owner.json');
  const owner = { root: fs.realpathSync(root), webrtcRevision: pins.repositories.webrtc.commit };
  if (fs.existsSync(marker)) assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), owner);
  else fs.writeFileSync(marker, JSON.stringify(owner) + '\n', { flag: 'wx' });
  checkSpace();
  const lock = path.join(workspace, 'prepare.lock');
  const handle = fs.openSync(lock, 'wx');
  try {
    const depot = path.join(workspace, 'depot_tools');
    const env = { ...process.env, DEPOT_TOOLS_UPDATE: '0', DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', PYTHONDONTWRITEBYTECODE: '1',
      CIPD_CACHE_DIR: path.join(workspace, 'cipd-cache'),
      PATH: `${path.join(workspace, 'python-3.11', 'bin')}:${depot}:${process.env.PATH}` };
    const venv = path.join(workspace, 'python-3.11');
    if (!fs.existsSync(venv)) execute(python, ['-m', 'venv', venv], { env });
    const interpreter = path.join(venv, 'bin', 'python3');
    execute(interpreter, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check',
      'install', ...pins.bootstrap.gclientRuntime.requirements.map(item => `${item.distribution}==${item.version}`)], { env });
    for (const [name, directory] of [
      ['depot_tools', depot], ['webrtc', path.join(workspace, 'webrtc', 'src')],
    ]) {
      checkSpace();
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
        execute('git', ['init', '--quiet', directory], { env });
        execute('git', ['-C', directory, 'remote', 'add', 'origin', pins.repositories[name].url], { env });
      }
      assert.equal(execute('git', ['-C', directory, 'remote', 'get-url', 'origin'], { env, capture: true }),
        pins.repositories[name].url);
      assert.equal(execute('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=no'],
        { env, capture: true }), '', `Native SDK source has local modifications: ${name}`);
      withNetworkRetries(() => execute('git', ['-C', directory, 'fetch', '--quiet', '--depth=1', 'origin',
        pins.repositories[name].commit], { env, capture: true }), { label: `Source fetch ${name}` });
      checkout(name, directory, env);
    }
    const solution = path.join(workspace, 'webrtc');
    write(path.join(solution, '.gclient'), `solutions = [{
  "name": "src",
  "url": ${JSON.stringify(pins.repositories.webrtc.url)},
  "managed": False,
  "custom_deps": {},
  "custom_vars": { "checkout_android": False, "checkout_ios": False },
}]
target_os = ["mac"]
`);
    checkSpace();
    execute(interpreter, ['-B', path.join(depot, 'gclient.py'), 'sync', '--no-history', '--nohooks',
      '--noprehooks', '--jobs=2', `--revision=src@${pins.repositories.webrtc.commit}`],
    { cwd: solution, env });
    checkSpace();
    const clangUpdate = path.join(solution, 'src', 'tools', 'clang', 'scripts', 'update.py');
    for (const args of [[], ['--package=objdump']]) {
      execute(interpreter, ['-I', clangUpdate, ...args], { env });
      checkSpace();
    }
    console.log(JSON.stringify({ macRtcSources: path.join(solution, 'src'),
      revision: pins.repositories.webrtc.commit, python: interpreter }));
    return { source: path.join(solution, 'src'), python: interpreter, env };
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}

module.exports = { prepare, checkSpace, workspace };
if (require.main === module) {
  try { prepare(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
