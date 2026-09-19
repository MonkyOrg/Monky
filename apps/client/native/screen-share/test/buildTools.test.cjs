'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { redistributableCrt } = require('../scripts/buildTools.cjs');

test('app-local CRT comes from the release redistributable, never System32 or debug_nonredist', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-screen-crt-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const metadata = path.join(fixture, 'VC', 'Auxiliary', 'Build');
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, 'Microsoft.VCRedistVersion.default.txt'), '14.44.35112\r\n');
  const directory = path.join(fixture, 'VC', 'Redist', 'MSVC', '14.44.35112', 'x64', 'Microsoft.VC143.CRT');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'unrelated.txt'])
    fs.writeFileSync(path.join(directory, name), name);
  const result = redistributableCrt(fixture);
  assert.equal(result.version, '14.44.35112');
  assert.equal(result.files.size, 3);
  for (const filename of result.files.values()) assert.equal(path.dirname(filename), directory);
  fs.unlinkSync(path.join(directory, 'vcruntime140_1.dll'));
  assert.throws(() => redistributableCrt(fixture), /Missing release CRT/);
  fs.writeFileSync(path.join(metadata, 'Microsoft.VCRedistVersion.default.txt'), '..\\debug_nonredist');
  assert.throws(() => redistributableCrt(fixture), /Invalid Visual C\+\+/);
});
