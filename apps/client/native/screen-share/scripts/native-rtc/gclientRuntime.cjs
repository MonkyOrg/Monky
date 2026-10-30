'use strict';

// gclient runs from a private venv with httplib2 and six. pip installs them only from the exact
// wheels pinned in pins.json: each file is downloaded from its pinned URL and refused unless its
// SHA-256 matches (--require-hashes), and nothing else is resolved or installed (--no-deps). The
// Windows and macOS preparation scripts both install through this helper.
const assert = require('node:assert/strict');
const path = require('node:path');

const WHEEL_HOST = 'files.pythonhosted.org';

function wheelRequirements(manifest) {
  const { requirements } = manifest.bootstrap.gclientRuntime;
  const files = manifest.bootstrap.gclientWheels?.files;
  assert.ok(Array.isArray(files) && files.length === requirements.length,
    'Pin exactly one wheel for each gclient runtime requirement.');
  return requirements.map(({ distribution, version }) => {
    const pinned = files.filter(file => file.distribution === distribution);
    assert.equal(pinned.length, 1, `Pin exactly one wheel for ${distribution}.`);
    const [{ url, sha256 }] = pinned;
    let source = null;
    try { source = new URL(url); } catch {}
    assert.ok(source?.protocol === 'https:' && source.host === WHEEL_HOST && !source.username && !source.password &&
      !source.search && !source.hash, `${distribution} must be pinned to a wheel on https://${WHEEL_HOST}.`);
    const wheel = path.posix.basename(source.pathname);
    assert.ok(wheel.startsWith(`${distribution.replace(/[-_.]+/gu, '_')}-${version}-`) && wheel.endsWith('.whl'),
      `${distribution} must be pinned to its ${version} wheel, not ${wheel}.`);
    assert.match(sha256, /^[a-f0-9]{64}$/u, `${distribution} needs the SHA-256 of its wheel.`);
    return `${distribution} @ ${url}#sha256=${sha256}`;
  });
}

function pipInstallArguments(manifest = require('./pins.json')) {
  return ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-warn-script-location',
    '--require-hashes', '--no-deps', ...wheelRequirements(manifest)];
}

module.exports = { pipInstallArguments };
