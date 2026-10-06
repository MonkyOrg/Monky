import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { license, copyMonkyLicenses } from './legal.cjs';
import { buildCliPackageJson, buildSharedPackageJson, bundleH264Dependency } from './pack-cli.js';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('first-party workspace manifests and the project license use GPL', () => {
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
});

test('first-party packaging copies only the GPL license without changing its text', t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-legal-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  copyMonkyLicenses(destination);
  assert.deepEqual(fs.readdirSync(destination), ['LICENSE']);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'LICENSE')), fs.readFileSync(path.join(root, 'LICENSE')));
});

test('standalone CLI and bundled shared metadata declare GPL rather than inheriting unrelated metadata', () => {
  const shared = { name: '@monky/shared', version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts', license: 'UNLICENSED' };
  const server = { name: '@monky/server', version: '1.0.0', main: 'dist/index.js', bin: { monky: 'dist/cli/index.js' } };
  assert.equal(buildSharedPackageJson(shared).license, license);
  assert.equal(buildCliPackageJson(server, shared, '9.0.0').license, license);
  assert.ok(buildCliPackageJson(server, shared, '9.0.0').bundleDependencies.includes('h264-profile-level-id'));
});

test('standalone CLI bundles the patched ISC H264 dependency instead of reinstalling an unpatched parser', t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-h264-bundle-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  bundleH264Dependency(destination);
  const require = createRequire(import.meta.url);
  const source = path.dirname(require.resolve('h264-profile-level-id/package.json'));
  const bundled = path.join(destination, 'node_modules', 'h264-profile-level-id');
  for (const name of ['LICENSE', 'package.json', path.join('lib', 'index.js'), path.join('lib', 'index.d.ts')])
    assert.deepEqual(fs.readFileSync(path.join(bundled, name)), fs.readFileSync(path.join(source, name)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(bundled, 'package.json'), 'utf8')).license, 'ISC');
});
