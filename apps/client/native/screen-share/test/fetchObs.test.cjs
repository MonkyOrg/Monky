'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readRecipe, safeArchiveEntries, assertPinnedSubmodules } = require('../scripts/fetchObs.cjs');

test('source recipes are parsed as data, without evaluating downloaded PowerShell', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-obs-recipes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'checksums'));
  const recipe = [
    'param(',
    "  [string] $Name = 'sample',",
    "  [string] $Version = '1.2.3',",
    "  [string] $Uri = 'https://example.org/sample.git',",
    `  [string] $Hash = '${'a'.repeat(40)}'`,
    ')',
    'function Setup { throw "Downloaded functions must never execute" }',
  ].join('\n');
  const filename = path.join(directory, 'sample.ps1');
  fs.writeFileSync(filename, recipe);
  assert.deepEqual(readRecipe(directory, 'sample.ps1'), {
    name: 'sample', version: '1.2.3', url: 'https://example.org/sample.git',
    revision: 'a'.repeat(40), recipe: 'sample.ps1',
  });
  fs.writeFileSync(filename, recipe.replace(`[string] $Hash = '${'a'.repeat(40)}'`,
    `[hashtable] $Hashes = @{\n x64 = '${'b'.repeat(40)}'\n arm64 = '${'c'.repeat(40)}'\n }`));
  assert.equal(readRecipe(directory, 'sample.ps1').revision, 'b'.repeat(40));
  const archive = recipe.replace('sample.git', 'sample.zip')
    .replace(`'${'a'.repeat(40)}'`, '"${PSScriptRoot}/checksums/sample.zip.sha256"');
  fs.writeFileSync(filename, archive);
  fs.writeFileSync(path.join(directory, 'checksums', 'sample.zip.sha256'),
    `<Objs><S N="Algorithm">SHA256</S><S N="Hash">${'B'.repeat(64)}</S></Objs>`);
  assert.equal(readRecipe(directory, 'sample.ps1').sha256, 'b'.repeat(64));
  fs.writeFileSync(filename, archive.replace("'sample'", '$(Invoke-Expression "not allowed")'));
  assert.throws(() => readRecipe(directory, 'sample.ps1'), /Missing literal Name/);
});

test('native archive paths reject parent traversal, absolute paths and Windows alternate streams', () => {
  assert.deepEqual(safeArchiveEntries('./source/\n./source/LICENSE\n'), ['./source/', './source/LICENSE']);
  for (const entry of ['../outside', 'source/../../outside', 'source\\..\\outside', '/absolute', '\\absolute', 'C:\\absolute', 'file:stream'])
    assert.throws(() => safeArchiveEntries(entry), /Unsafe native archive/);
  assert.throws(() => safeArchiveEntries(''), /Empty native source/);
});

test('source submodule verification accepts clean numeric SHAs and rejects absent, changed or conflicted pins', () => {
  assertPinnedSubmodules('');
  assertPinnedSubmodules('2a3e2c5ea053c14b745dbdf41f609b1edc6a72fa framework (2a3e2c5)');
  assertPinnedSubmodules(` ${'a'.repeat(40)} first\n ${'0'.repeat(40)} nested/second`);
  for (const prefix of ['-', '+', 'U'])
    assert.throws(() => assertPinnedSubmodules(`${prefix}${'a'.repeat(40)} framework`), /source submodule/);
});
