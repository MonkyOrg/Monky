'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute } = require('./buildTools.cjs');
const { cache, fetchObs } = require('./fetchObs.cjs');
const { generateNotices } = require('./notices.cjs');

function options(argv) {
  const result = { python: process.env.PYTHON, jobs: 4 };
  const seen = new Set();
  for (const argument of argv) {
    const at = argument.indexOf('='), key = argument.slice(0, at), value = argument.slice(at + 1);
    assert.ok(at > 0 && value && !seen.has(key), 'Use unique --python= and --jobs= options.');
    seen.add(key);
    if (key === '--python') result.python = value;
    else if (key === '--jobs') result.jobs = Number(value);
    else throw new Error(`Unknown native preparation option: ${key}`);
  }
  assert.ok(result.python && path.isAbsolute(result.python),
    'Provide --python=<absolute CPython 3.11 executable>, or set PYTHON. Python launchers are not supported.');
  assert.ok(Number.isInteger(result.jobs) && result.jobs >= 1 && result.jobs <= 16, 'Native build jobs must be 1..16.');
  return result;
}

async function prepare(config) {
  assert.equal(process.platform, 'win32', 'Native screen preparation requires Windows.');
  assert.equal(process.arch, 'x64', 'Native screen preparation requires x64.');
  const python = JSON.parse(execute(config.python, ['-I', '-c',
    'import json,struct,sys; print(json.dumps([*sys.version_info[:2],struct.calcsize("P")*8]))'], { capture: true }));
  assert.deepEqual(python, [3, 11, 64], 'Use CPython 3.11 x64, not a launcher or another Python version.');
  fs.mkdirSync(cache, { recursive: true });
  const venv = path.join(cache, 'python');
  const interpreter = path.join(venv, 'Scripts', 'python.exe');
  if (!fs.existsSync(venv)) {
    execute(config.python, ['-I', '-m', 'venv', '--copies', venv]);
    const requirements = require('./native-rtc/pins.json').bootstrap.gclientRuntime.requirements
      .map(requirement => `${requirement.distribution}==${requirement.version}`);
    execute(interpreter, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check',
      'install', '--no-warn-script-location', ...requirements]);
  }
  execute(process.execPath, [path.join(__dirname, 'native-rtc', 'bootstrap.cjs'), 'fetch',
    `--python=${config.python}`, `--gclient-python=${interpreter}`]);
  const capture = await fetchObs();
  require('./buildRtc.cjs').build({
    webrtcRoot: path.join(cache, 'rtc', 'webrtc', 'src'), python: interpreter, jobs: config.jobs,
  });
  require('./buildCapture.cjs').build({ stock: capture.stock, dependencies: capture.dependencies });
  generateNotices();
  const runtime = require(path.join(root, 'index.cjs')).loadRuntime();
  console.log(JSON.stringify({
    nativeScreenReady: true, obsVersion: runtime.obs.version,
    contractRevision: runtime.rtc.capabilities().contractRevision,
  }));
}

module.exports = { options, prepare };
if (require.main === module) prepare(options(process.argv.slice(2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
