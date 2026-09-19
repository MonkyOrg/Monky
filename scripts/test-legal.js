import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { license, copyMonkyLicenses } from './legal.cjs';
import { buildCliPackageJson, buildSharedPackageJson } from './pack-cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('first-party workspace manifests use GPL and retain the original MIT notice', () => {
  assert.equal(license, 'GPL-3.0-or-later');
  for (const relative of [
    'package.json', 'apps/client/package.json', 'apps/server/package.json',
    'packages/shared/package.json', 'packages/bot-sdk/package.json',
    'apps/client/native/screen-audio/package.json', 'apps/client/native/screen-share/package.json',
  ]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    assert.equal(manifest.license, license, relative);
  }
  const gpl = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.ok(gpl.includes('GNU GENERAL PUBLIC LICENSE') && gpl.includes('17. Interpretation of Sections 15 and 16.'));
  assert.ok(gpl.length > 30_000);
  const original = fs.readFileSync(path.join(root, 'LICENSE-MIT'), 'utf8');
  assert.ok(original.includes('MIT License') && original.includes('Copyright') &&
    original.includes('The above copyright notice and this permission notice'));
});

test('packaging copies both notices without changing any legal text', t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-legal-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  copyMonkyLicenses(destination);
  for (const name of ['LICENSE', 'LICENSE-MIT'])
    assert.deepEqual(fs.readFileSync(path.join(destination, name)), fs.readFileSync(path.join(root, name)));
});

test('standalone CLI and bundled shared metadata declare GPL rather than inheriting historical MIT', () => {
  const shared = { name: '@monky/shared', version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts', license: 'MIT' };
  const server = { name: '@monky/server', version: '1.0.0', main: 'dist/index.js', bin: { monky: 'dist/cli/index.js' } };
  assert.equal(buildSharedPackageJson(shared).license, license);
  assert.equal(buildCliPackageJson(server, shared, '9.0.0').license, license);
});
