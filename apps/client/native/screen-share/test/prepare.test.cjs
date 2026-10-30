'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { options } = require('../scripts/prepare.cjs');
const { pipInstallArguments } = require('../scripts/native-rtc/gclientRuntime.cjs');
const { createContext } = require('../scripts/native-rtc/bootstrap.cjs');
const pins = require('../scripts/native-rtc/pins.json');

const clone = value => JSON.parse(JSON.stringify(value));

test('native preparation requires explicit Python and bounded build parallelism', () => {
  const python = path.resolve('tools', 'python.exe');
  assert.deepEqual(options([`--python=${python}`, '--jobs=2']), { python, jobs: 2 });
  for (const args of [
    ['--python=relative'], [`--python=${python}`, '--jobs=0'],
    [`--python=${python}`, '--jobs=17'], [`--python=${python}`, '--unknown=true'],
    [`--python=${python}`, '--jobs=2', '--jobs=3'], ['--python'],
  ]) assert.throws(() => options(args));
});

test('native preparation can select Git explicitly without accepting ambiguous or relative arguments', () => {
  const python = path.resolve('tools', 'python.exe');
  const git = path.resolve('tools', 'git.exe');
  assert.deepEqual(options([`--python=${python}`, `--git=${git}`]), { python, git, jobs: 4 });
  assert.throws(() => options([`--python=${python}`, '--git=relative.exe']));
  assert.throws(() => options([`--python=${python}`, `--git=${git}`, `--git=${git}`]));
});

test('native preparation can stop after fetching the pinned sources for verified cached binaries', () => {
  const python = path.resolve('tools', 'python.exe');
  assert.deepEqual(options([`--python=${python}`, '--fetch-only']), { python, jobs: 4, fetchOnly: true });
  assert.equal(options([`--python=${python}`]).fetchOnly, undefined);
  assert.throws(() => options([`--python=${python}`, '--fetch-only', '--fetch-only']));
  assert.throws(() => options([`--python=${python}`, '--fetch-only=true']));
});

test('the gclient venv installs only the pinned wheels, each checked against its SHA-256', () => {
  const args = pipInstallArguments();
  assert.deepEqual(args.slice(0, 9), ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install',
    '--no-warn-script-location', '--require-hashes', '--no-deps']);
  const { requirements } = pins.bootstrap.gclientRuntime;
  assert.equal(args.length, 9 + requirements.length, 'Nothing but the pinned wheels is installed.');
  for (const { distribution, version } of requirements) {
    const [wheel, ...others] = pins.bootstrap.gclientWheels.files.filter(file => file.distribution === distribution);
    assert.deepEqual(others, []);
    assert.match(wheel.url, new RegExp(`^https://files\\.pythonhosted\\.org/packages/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{60}/${
      distribution}-${version.replaceAll('.', '\\.')}-[\\w.]+-none-any\\.whl$`, 'u'));
    assert.match(wheel.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(args.includes(`${distribution} @ ${wheel.url}#sha256=${wheel.sha256}`), distribution);
  }
});

test('a wheel pin that does not match its pinned requirement is refused before pip runs', () => {
  const corrupt = [
    manifest => { manifest.bootstrap.gclientWheels.files[0].sha256 = 'ab'.repeat(31); },
    manifest => { manifest.bootstrap.gclientWheels.files[0].sha256 = 'AB'.repeat(32); },
    manifest => { delete manifest.bootstrap.gclientWheels.files[1].sha256; },
    manifest => { manifest.bootstrap.gclientRuntime.requirements[0].version = '0.14.0'; },
    manifest => { manifest.bootstrap.gclientWheels.files[0].url = manifest.bootstrap.gclientWheels.files[0].url.replace('.whl', '.tar.gz'); },
    manifest => { manifest.bootstrap.gclientWheels.files[0].url = manifest.bootstrap.gclientWheels.files[0].url.replace('https:', 'http:'); },
    manifest => { manifest.bootstrap.gclientWheels.files[0].url = manifest.bootstrap.gclientWheels.files[0].url.replace('files.pythonhosted.org', 'example.com'); },
    manifest => { manifest.bootstrap.gclientWheels.files[0].url += '?mirror=1'; },
    manifest => { manifest.bootstrap.gclientWheels.files[0].url += '#sha256=' + '0'.repeat(64); },
    manifest => { manifest.bootstrap.gclientWheels.files[1].distribution = 'httplib2'; },
    manifest => { manifest.bootstrap.gclientWheels.files.pop(); },
    manifest => { manifest.bootstrap.gclientWheels.files.push(clone(manifest.bootstrap.gclientWheels.files[0])); },
    manifest => { delete manifest.bootstrap.gclientWheels; },
  ];
  for (const [index, change] of corrupt.entries()) {
    const manifest = clone(pins);
    change(manifest);
    assert.throws(() => pipInstallArguments(manifest), { code: 'ERR_ASSERTION' }, `case ${index}`);
  }
});

test('Windows and macOS preparation install the gclient runtime only through the hash-checked helper', () => {
  const scripts = path.join(__dirname, '..', 'scripts');
  for (const name of ['prepare.cjs', 'prepareMacRtc.cjs']) {
    const source = fs.readFileSync(path.join(scripts, name), 'utf8');
    assert.match(source, /execute\(interpreter, (?:pipInstallArguments\(\)|install), \{ env \}\)/u, name);
    assert.doesNotMatch(source, /'pip'/u, `${name} must not build a pip command of its own.`);
  }
});

test('wheel pins do not change the pin hash that identifies prepared RTC workspaces', () => {
  const pinned = createContext({ manifest: clone(pins) }).pinHash;
  const without = clone(pins);
  delete without.bootstrap.gclientWheels;
  assert.equal(createContext({ manifest: without }).pinHash, pinned,
    'Hashing the same wheel versions must not orphan workspaces that are already prepared.');
  const rehashed = clone(pins);
  rehashed.bootstrap.gclientWheels.files[0].sha256 = 'f'.repeat(64);
  assert.equal(createContext({ manifest: rehashed }).pinHash, pinned);
  const upgraded = clone(pins);
  upgraded.bootstrap.gclientRuntime.requirements[0].version = '0.14.0';
  assert.notEqual(createContext({ manifest: upgraded }).pinHash, pinned, 'A different version is a different runtime.');
});
