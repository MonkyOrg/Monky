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
  const bundled = { 'h264-profile-level-id': '2.3.3', debug: '4.4.3', ms: '2.1.3' };
  const cli = buildCliPackageJson(server, shared, '9.0.0', bundled);
  assert.equal(cli.license, license);
  // Every bundled package must be declared, or npm expects it inside the tarball without installing it.
  assert.deepEqual(cli.bundleDependencies, ['@monky/shared', ...Object.keys(bundled)]);
  for (const [name, version] of Object.entries(bundled)) assert.equal(cli.dependencies[name], version);
});

test('standalone CLI bundles the patched ISC H264 dependency instead of reinstalling an unpatched parser', t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-h264-bundle-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const bundled = bundleH264Dependency(destination);
  const require = createRequire(import.meta.url);
  const source = path.dirname(require.resolve('h264-profile-level-id/package.json'));
  const bundledDir = path.join(destination, 'node_modules', 'h264-profile-level-id');
  for (const name of ['LICENSE', 'package.json', path.join('lib', 'index.js'), path.join('lib', 'index.d.ts')])
    assert.deepEqual(fs.readFileSync(path.join(bundledDir, name)), fs.readFileSync(path.join(source, name)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(bundledDir, 'package.json'), 'utf8')).license, 'ISC');
  assert.equal(bundled['h264-profile-level-id'], '2.3.3');
});

test('standalone CLI bundles the H264 parser runtime dependency closure, since npm never fetches it', t => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-h264-closure-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const bundled = bundleH264Dependency(destination);
  assert.ok(bundled.debug && bundled.ms, 'debug and its ms dependency must travel with the parser.');
  for (const [name, version] of Object.entries(bundled)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(manifest.version, version);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      assert.ok(dependency in bundled, `${name} -> ${dependency} must be bundled too.`);
  }
  const fromParser = createRequire(path.join(destination, 'node_modules', 'h264-profile-level-id', 'lib', 'index.js'));
  assert.equal(path.relative(destination, fromParser.resolve('debug')).split(path.sep)[1], 'debug');
});
