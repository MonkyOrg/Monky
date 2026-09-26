'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute } = require('./buildTools.cjs');
const { cache, fetchObs } = require('./fetchObs.cjs');
const { generateNotices } = require('./notices.cjs');
const windowsToolchain = require('./windowsToolchain.cjs');

function options(argv) {
  const result = { python: process.env.PYTHON, jobs: 4 };
  const seen = new Set();
  for (const argument of argv) {
    const at = argument.indexOf('='), key = argument.slice(0, at), value = argument.slice(at + 1);
    assert.ok(at > 0 && value && !seen.has(key), 'Use unique --python=, --git=, --jobs=, --vs-install=, --sdk-root= and --vswhere= options.');
    seen.add(key);
    if (key === '--python') result.python = value;
    else if (key === '--git') result.git = value;
    else if (key === '--jobs') result.jobs = Number(value);
    else if (!windowsToolchain.selectionOption(result, key, value)) throw new Error(`Unknown native preparation option: ${key}`);
  }
  assert.ok(result.python && path.isAbsolute(result.python),
    'Provide --python=<absolute CPython 3.11 executable>, or set PYTHON. Python launchers are not supported.');
  assert.ok(result.git === undefined || path.isAbsolute(result.git), 'Select Git with an absolute executable path.');
  assert.ok(Number.isInteger(result.jobs) && result.jobs >= 1 && result.jobs <= 16, 'Native build jobs must be 1..16.');
  return result;
}

async function prepare(config) {
  assert.equal(process.platform, 'win32', 'Native screen preparation requires Windows.');
  assert.equal(process.arch, 'x64', 'Native screen preparation requires x64.');
  const toolchain = windowsToolchain.resolveWindowsToolchain(config);
  const env = windowsToolchain.msvcEnvironment(toolchain);
  const selected = { vsInstall: toolchain.visualStudio.path, sdkRoot: toolchain.sdk.root,
    ...(config.vswhere ? { vswhere: config.vswhere } : {}) };
  console.log(JSON.stringify({ windowsToolchain: windowsToolchain.summary(toolchain) }));
  fs.mkdirSync(cache, { recursive: true });
  const venv = path.join(cache, 'python');
  const interpreter = path.join(venv, 'Scripts', 'python.exe');
  if (!fs.existsSync(venv)) {
    execute(toolchain.python, ['-I', '-m', 'venv', '--copies', venv], { env });
    const requirements = require('./native-rtc/pins.json').bootstrap.gclientRuntime.requirements
      .map(requirement => `${requirement.distribution}==${requirement.version}`);
    execute(interpreter, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check',
      'install', '--no-warn-script-location', ...requirements], { env });
  }
  execute(process.execPath, [path.join(__dirname, 'native-rtc', 'bootstrap.cjs'), 'fetch',
    `--python=${toolchain.python}`, `--gclient-python=${interpreter}`,
    ...windowsToolchain.selectionArguments(selected),
    ...(config.git ? [`--git=${config.git}`] : [])], { env });
  const capture = await fetchObs();
  require('./buildRtc.cjs').build({
    webrtcRoot: path.join(cache, 'rtc', 'webrtc', 'src'), python: interpreter, jobs: config.jobs, ...selected,
  });
  require('./buildCapture.cjs').build({ stock: capture.stock, dependencies: capture.dependencies,
    python: interpreter, ...selected });
  const thumbnails = require('./buildThumbnails.cjs');
  thumbnails.build({ ...thumbnails.options([]), python: interpreter, ...selected });
  generateNotices();
  const runtime = require(path.join(root, 'index.cjs')).loadRuntime();
  require(path.join(root, 'index.cjs')).loadThumbnailRuntime();
  console.log(JSON.stringify({
    nativeScreenReady: true, obsVersion: runtime.obs.version,
    contractRevision: runtime.rtc.capabilities().contractRevision,
  }));
}

module.exports = { options, prepare };
if (require.main === module) prepare(options(process.argv.slice(2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
