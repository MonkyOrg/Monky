'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { archiveResponse, readRecipe, safeArchiveEntries, assertPinnedSubmodules } = require('../scripts/fetchObs.cjs');

function archiveRequests(t, respond) {
  const requests = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    const specification = respond(url, requests.length);
    assert.ok(specification, 'Unexpected archive request');
    const request = new EventEmitter();
    const response = specification.response ?? Readable.from(specification.body ?? []);
    Object.assign(response, { statusCode: specification.status, headers: specification.headers ?? {} });
    requests.push({ url: url.href, options, response });
    queueMicrotask(() => {
      if (specification.error) request.emit('error', specification.error);
      else callback(response);
    });
    return request;
  });
  return requests;
}

test('native archive streams follow bounded HTTPS redirects without transforming archive bytes', async t => {
  const requests = archiveRequests(t, (_url, index) => [
    { status: 302, headers: { location: '/mirror' }, body: ['redirect'] },
    { status: 307, headers: { location: 'https://mirror.example/source.tar.gz' } },
    { status: 200, body: [Buffer.from([0, 255, 10]), Buffer.from([128, 1])] },
  ][index]);
  const signal = new AbortController().signal;
  const response = await archiveResponse('https://source.example/download', signal);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 10, 128, 1]));
  assert.deepEqual(requests.map(request => request.url), [
    'https://source.example/download', 'https://source.example/mirror', 'https://mirror.example/source.tar.gz',
  ]);
  assert.ok(requests.every(request => request.options.signal === signal
    && request.options.headers['Accept-Encoding'] === 'identity'));
  assert.ok(requests.every(request => request.response.readableEnded));
});

test('native archive streams reject unsafe redirects, unsuccessful statuses and transport failures', async t => {
  for (const [name, response, message] of [
    ['HTTP downgrade', { status: 302, headers: { location: 'http://mirror.example/archive.zip' } }, /HTTPS/],
    ['credentials', { status: 302, headers: { location: 'https://user:password@mirror.example/archive.zip' } }, /credentials/],
    ['missing location', { status: 302 }, /location/],
    ['redirect loop', { status: 301, headers: { location: '/again' } }, /limit/],
    ['HTTP error', { status: 503, body: ['unavailable'] }, /503/],
    ['connection failure', { error: new Error('fixture connection failure') }, /connection failure/],
  ]) {
    await t.test(name, async child => {
      const requests = archiveRequests(child, () => response);
      await assert.rejects(archiveResponse('https://source.example/archive.zip', new AbortController().signal), message);
      assert.ok(requests.length <= 11);
    });
  }
});

test('native archive body errors propagate to the consumer instead of completing a partial source', async t => {
  const response = new Readable({
    read() { this.destroy(new Error('fixture incomplete archive')); },
  });
  archiveRequests(t, () => ({ status: 200, response }));
  const stream = await archiveResponse('https://source.example/archive.zip', new AbortController().signal);
  await assert.rejects(async () => {
    for await (const chunk of stream) assert.fail(`Unexpected data: ${chunk.length}`);
  }, /incomplete archive/);
});

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
