'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, withBuildLock } = require('./buildTools.cjs');
const pinnedGit = require('./pinnedGit.cjs');
const { pipInstallArguments } = require('./native-rtc/gclientRuntime.cjs');
const pins = require('./native-rtc/pins.json');

const workspace = path.resolve(root, '..', '..', '..', '..', '.native-screen', 'mac-rtc');
const reserveBytes = 4 * 1024 ** 3;

function checkSpace(directory = workspace) {
  const space = fs.statfsSync(directory);
  assert.ok(space.bavail * space.bsize >= reserveBytes,
    'Native macOS preparation stopped: preserve at least 4 GiB of free disk space.');
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
  return withBuildLock(path.join(workspace, 'prepare.lock'), () => {
    const depot = path.join(workspace, 'depot_tools');
    const venv = path.join(workspace, 'python-3.11');
    // The same isolation as the Windows bootstrap: Git, gclient, CIPD and pip see neither the user's
    // configuration nor their home, and keep caches and temporary files inside this workspace.
    const isolation = pinnedGit.workspaceIsolation(workspace);
    for (const directory of isolation.directories) fs.mkdirSync(directory, { recursive: true });
    pinnedGit.prepareIsolation(isolation);
    const env = pinnedGit.toolEnvironment(process.env, workspace, { paths: [path.join(venv, 'bin'), depot] });
    if (!fs.existsSync(venv)) execute(python, ['-m', 'venv', venv], { env });
    const interpreter = path.join(venv, 'bin', 'python3');
    execute(interpreter, pipInstallArguments(), { env });
    const git = pinnedGit.gitCommand(isolation, { env });
    for (const [name, directory, gclientRoot] of [
      ['depot_tools', depot, false], ['webrtc', path.join(workspace, 'webrtc', 'src'), true],
    ]) {
      checkSpace();
      const { url, commit } = pins.repositories[name];
      pinnedGit.acquireSync({ directory, url, commit, isolation, git, gclientRoot });
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
  });
}

module.exports = { prepare, checkSpace, workspace };
if (require.main === module) {
  try { prepare(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
