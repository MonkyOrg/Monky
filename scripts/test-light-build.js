import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { nativeBuildPlan, findCmake } from './build-light.js';

const base = { root: path.resolve('fixture-repository'), nodeExecutable: process.execPath, jobs: 2 };

test('Windows builds use the existing Visual Studio toolchain and an isolated x64 directory', () => {
  const plan = nativeBuildPlan({ ...base, platform: 'win32', architecture: 'x64' });
  assert.equal(plan.buildDirectory, path.join(base.root, 'apps', 'light', 'build', 'windows-x64'));
  assert.deepEqual(plan.configure.slice(-4), ['-G', 'Visual Studio 17 2022', '-A', 'x64']);
  assert.ok(plan.configure.includes('-DMONKY_LIGHT_TARGET_ARCH:STRING=x64'));
  assert.deepEqual(plan.build, ['--build', plan.buildDirectory, '--config', 'Release', '--parallel', '2']);
});

test('macOS Intel and Apple Silicon builds do not share CMake caches', () => {
  const intel = nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'x64' });
  const silicon = nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'x64', args: ['--arch', 'arm64'] });
  assert.notEqual(intel.buildDirectory, silicon.buildDirectory);
  assert.ok(intel.configure.includes('-DCMAKE_OSX_ARCHITECTURES=x86_64'));
  assert.ok(silicon.configure.includes('-DCMAKE_OSX_ARCHITECTURES=arm64'));
});

test('requested CMake targets are passed as separate process arguments', () => {
  const plan = nativeBuildPlan({
    ...base, platform: 'win32', architecture: 'x64',
    args: ['--target', 'monky-light-platform-test'],
  });
  assert.deepEqual(plan.build.slice(-2), ['--target', 'monky-light-platform-test']);
  assert.ok(plan.configure.includes(`-DMONKY_NODE_EXECUTABLE:FILEPATH=${process.execPath}`));
});

test('unsupported platforms, architectures and malformed arguments fail instead of selecting a fallback', () => {
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'linux', architecture: 'x64' }), /initial Monky Light targets/);
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'win32', architecture: 'arm64' }), /Unsupported/);
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'ia32' }), /Unsupported/);
  for (const args of [['--unknown', 'x64'], ['--arch'], ['--arch', '--target'], ['--arch', 'x64', '--arch', 'arm64'], ['--target', 'a;b']]) {
    assert.throws(() => nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'arm64', args }));
  }
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'arm64', jobs: 0 }), /parallelism/);
});

test('pinned downloads retry transport errors, verify content and reuse only valid cache entries', { timeout: 60000 }, async context => {
  const cmake = findCmake();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-download-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = Buffer.from('Authored Monky download fixture\n');
  const hash = createHash('sha256').update(source).digest('hex');
  let failures = 2, requests = 0, body = source;
  const server = createServer((_request, response) => {
    requests++;
    response.statusCode = failures-- > 0 ? 503 : 200;
    response.end(response.statusCode === 200 ? body : 'Temporary fixture failure');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => { server.closeAllConnections(); server.close(); });
  const destination = path.join(directory, 'cache', `${hash}.txt`);
  const script = path.join(directory, 'download.cmake');
  const helper = fileURLToPath(new URL('../apps/light/cmake/VerifiedDownload.cmake', import.meta.url));
  fs.writeFileSync(script, `include([=[${helper}]=])\nmonky_download_verified([=[http://127.0.0.1:${server.address().port}/source]=] [=[${destination}]=] ${hash})\n`);
  const download = () => new Promise((resolve, reject) => {
    const child = spawn(cmake, ['-P', script], { timeout: 15000 });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
  let result = await download();
  assert.equal(result.code, 0, result.output);
  assert.equal(requests, 3);
  assert.deepEqual(fs.readFileSync(destination), source);
  requests = 0;
  failures = 3;
  result = await download();
  assert.equal(result.code, 0, result.output);
  assert.equal(requests, 0, 'A verified cache hit must work without the upstream service');
  fs.writeFileSync(destination, 'Corrupt cached fixture');
  failures = 0;
  result = await download();
  assert.equal(result.code, 0, result.output);
  assert.equal(requests, 1, 'A corrupt cache entry must be restored, not trusted');
  assert.deepEqual(fs.readFileSync(destination), source);
  fs.rmSync(destination);
  failures = 3;
  requests = 0;
  result = await download();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /failed after 3 attempts/);
  assert.equal(requests, 3);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(`${destination}.partial`), false);
  failures = 0;
  requests = 0;
  body = Buffer.from('Different authored fixture');
  result = await download();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /hash mismatch/);
  assert.equal(requests, 1);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(`${destination}.partial`), false);
});

test('the FieldTrials mirror preserves the qualified source bytes and upstream provenance', () => {
  const { webrtc } = JSON.parse(fs.readFileSync(new URL('../apps/light/dependencies.json', import.meta.url), 'utf8'));
  assert.equal(webrtc.fieldTrials.gitBlob, 'fc896e1258acdfa2a98fe9aa5c3c872a41b67750');
  assert.equal(webrtc.fieldTrials.sha256, 'b5f82993430c8a1365e5416036b8a2f5dfaa6bf2709e2e2764812927fe358b3c');
  assert.match(webrtc.fieldTrials.url, /^https:\/\/raw\.githubusercontent\.com\/webrtc-mirror\/webrtc\/[a-f0-9]{40}\/api\/field_trials\.cc$/);
  assert.equal(webrtc.fieldTrials.upstreamUrl,
    `https://webrtc.googlesource.com/src/+show/${webrtc.revision}/api/field_trials.cc?format=TEXT`);
});
