'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MacScreenProvider, sourceIdentity } = require('../runtime/mac/index.cjs');
const { loadMacCaptureRuntime } = require('../runtime/mac/index.cjs');
const { MacNativeHost } = require('../runtime/mac/host.cjs');
const { encode, Decoder } = require('../runtime/mac/wire.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCA5YAAAAASUVORK5CYII=', 'base64');
const goodImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const windowSource = { name: 'Owned test window', kind: 'window', windowId: 123,
  processId: 456, processStartTimeUs: '1234567890', width: 640, height: 360 };
const monitor = { name: 'Display', kind: 'monitor', displayId: 99,
  displayUuid: '00000000-0000-0000-0000-000000000001', width: 2560, height: 1440,
  bounds: { x: -2560, y: 0, width: 2560, height: 1440 } };
function fixture() {
  let sources = [windowSource, monitor], payload = goodImage;
  const requests = [];
  const host = { exited: false, request: async (method, data) => {
    requests.push({ method, data });
    if (method === 'list') return { value: { sources } };
    if (method === 'resolve') return { value: { target: data.target } };
    if (method === 'thumbnail') return { value: { mimeType: 'image/png' }, payload };
    if (method === 'capabilities') return { value: {
      platform: 'darwin', minimumMacOS: '14.0', enumeration: 'ScreenCaptureKit',
      thumbnails: 'SCScreenshotManager', capture: false, encoder: null,
      transport: false, receive: false, audio: false,
    } };
    assert.fail(method);
  }, close: async () => { host.exited = true; } };
  const provider = new MacScreenProvider({ excludeProcessIds: [] }, { runtime: {}, hostFactory: () => host });
  return { provider, requests, host, sources: value => { sources = value; }, payload: value => { payload = value; } };
}
test('Mac source identities bind process birth and full monitor topology using existing opaque IPC formats', async () => {
  const f = fixture(), rows = await f.provider.listSources();
  assert.match(rows[0].id, /^window:123:[a-f0-9]{64}$/);
  assert.match(rows[1].id, /^native-monitor:[a-f0-9]{64}$/);
  assert.equal(f.requests.length, 1);
  assert.ok(rows.every(source => source.thumbnailState === 'pending' && source.thumbnailDataUrl === ''));
  const target = await f.provider.resolveTarget(rows[0].id, 'window');
  assert.equal(target.expectedProcessStartTimeUs, windowSource.processStartTimeUs);
  f.sources([{ ...windowSource, processStartTimeUs: '1234567891' },
    { ...monitor, bounds: { ...monitor.bounds, x: 0 } }]);
  const changed = await f.provider.listSources();
  assert.notEqual(changed[0].id, rows[0].id);
  assert.notEqual(changed[1].id, rows[1].id);
  await assert.rejects(f.provider.resolveTarget(rows[0].id, 'window'), { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
  await f.provider.close();
});
test('Mac native metadata never advertises an unimplemented transport or video encoder as supported', async () => {
  const f = fixture(), capability = await f.provider.capabilities();
  assert.equal(capability.enumeration, 'ScreenCaptureKit');
  assert.equal(capability.capture, false);
  assert.equal(capability.transport, false);
  assert.equal(capability.receive, false);
  assert.equal(capability.encoder, null);
});
test('Mac thumbnail captures the original registered target and checks bounded image dimensions', async () => {
  const f = fixture(), [row] = await f.provider.listSources();
  assert.deepEqual(await f.provider.thumbnail(row.id), goodImage);
  assert.deepEqual(f.requests.at(-1).data.target, sourceIdentity(windowSource));
  const tooLarge = Buffer.from(goodImage); tooLarge.writeUInt32BE(500, 16);
  for (const bad of [image, tooLarge, Buffer.from('not png')]) {
    f.payload(bad);
    await assert.rejects(f.provider.thumbnail(row.id));
  }
  await f.provider.close();
  await assert.rejects(f.provider.thumbnail(row.id), { code: 'ERR_MAC_PROVIDER_CLOSED' });
});
test('duplicate native Mac identities and malformed process or monitor metadata fail explicitly', async () => {
  const f = fixture();
  f.sources([windowSource, windowSource]);
  await assert.rejects(f.provider.listSources(), /duplicate/);
  for (const invalid of [{ ...windowSource, processStartTimeUs: '0' }, { ...windowSource, processId: 0 },
    { ...monitor, displayUuid: '-'.repeat(36) }, { ...monitor, bounds: { ...monitor.bounds, width: 0 } }])
    assert.throws(() => sourceIdentity(invalid));
});
function hostFixture(t, { hello = true } = {}) {
  const child = new EventEmitter();
  child.pid = 100; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.kill = signal => { child.kills.push(signal); return true; };
  const host = new MacNativeHost('owned-mac-host', {}, { spawn: () => child });
  host.onError = () => {};
  const output = (header, payload) => child.stdout.write(encode(header, payload));
  if (hello) output({ type: 'hello', protocol: 1, platform: 'darwin', pid: 100 });
  t.after(() => { child.stdout.end(); child.emit('close', 0, null); });
  return { host, child, output };
}
test('Mac cancellation does not release callbacks or request credits before actual host exit', async t => {
  const f = hostFixture(t), abort = new AbortController();
  let settled = false;
  const job = f.host.request('thumbnail', {}, abort.signal);
  const rejected = assert.rejects(job, { name: 'AbortError' }).then(() => { settled = true; });
  await tick();
  abort.abort(); await tick();
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal(settled, false); assert.equal(f.host.pending.size, 1);
  f.child.emit('close', null, 'SIGTERM');
  await rejected; assert.equal(f.host.pending.size, 0);
});
test('Mac close requires native cleanup response, stdout completion and actual normal process exit', async t => {
  const f = hostFixture(t);
  const work = f.host.close();
  await tick();
  f.output({ type: 'result', id: 1, value: { nativeClosed: true } });
  f.child.stdout.end();
  await tick();
  f.child.emit('close', 0, null);
  assert.deepEqual(await work, { nativeClosed: true, hostExited: true });
});
test('malformed Mac replies retain the original pending request until isolated host exit', async t => {
  const f = hostFixture(t), job = f.host.request('list');
  const rejected = assert.rejects(job);
  await tick();
  f.output({ type: 'result', id: 1, error: { code: 'PRIVATE arbitrary message', nativeStatus: 0 } });
  assert.equal(f.host.pending.size, 1);
  f.child.emit('close', 1, null); await rejected;
});
test('native Mac framing accepts fragmented packets and rejects truncated or oversized output', () => {
  const received = [], wire = encode({ type: 'result', id: 1 }, goodImage);
  const decoder = new Decoder((header, payload) => { received.push({ header, payload }); });
  for (const byte of wire) decoder.push(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(received[0].payload, goodImage);
  const broken = new Decoder(() => {});
  broken.push(wire.subarray(0, wire.length - 1));
  assert.throws(() => broken.end(), /truncated/);
  const tooLarge = Buffer.from(wire); tooLarge.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => new Decoder(() => {}).push(tooLarge), /bounds/);
});
test('native Mac manifest binds the executable bytes, architecture and supported platform', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-mac-provider-'));
  const executable = path.join(directory, 'monky-screen-mac'), manifest = path.join(directory, 'mac-capture-build.json');
  t.after(() => { fs.unlinkSync(executable); fs.unlinkSync(manifest); fs.rmdirSync(directory); });
  const bytes = Buffer.from('test executable identity');
  fs.writeFileSync(executable, bytes);
  fs.writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1, platform: 'darwin', arch: 'arm64', minimumMacOS: '14.0',
    executable: { name: 'monky-screen-mac', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') },
  }));
  assert.equal(loadMacCaptureRuntime(directory, 'darwin', 'arm64').executable, executable);
  assert.throws(() => loadMacCaptureRuntime(directory, 'win32', 'arm64'), { code: 'ERR_MAC_PLATFORM' });
  assert.throws(() => loadMacCaptureRuntime(directory, 'darwin', 'x64'));
  fs.writeFileSync(executable, Buffer.alloc(bytes.length));
  assert.throws(() => loadMacCaptureRuntime(directory, 'darwin', 'arm64'));
});
test('native Mac source IDs from an exited process are not adopted by a fresh host', async () => {
  const f = fixture(), [row] = await f.provider.listSources();
  f.host.exited = true;
  await assert.rejects(f.provider.thumbnail(row.id), { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
  assert.equal(f.requests.length, 1);
});
test('Mac close retains a separate control credit when all sixteen image requests are pending', async t => {
  const f = hostFixture(t), work = Array.from({ length: 16 }, () => f.host.request('thumbnail'));
  const completed = Promise.all(work);
  await tick();
  const close = f.host.close();
  await tick();
  assert.equal(f.host.pending.size, 17);
  assert.deepEqual(f.child.kills, []);
  for (let id = 1; id <= 16; ++id) f.output({ type: 'result', id, value: { mimeType: 'image/png' } }, goodImage);
  await completed;
  f.output({ type: 'result', id: 17, value: { nativeClosed: true } });
  f.child.stdout.end();
  await tick(); f.child.emit('close', 0, null);
  assert.equal((await close).hostExited, true);
});
test('Mac cancellation during startup terminates the original owner without waiting for a hello', async t => {
  const f = hostFixture(t, { hello: false }), abort = new AbortController();
  const request = f.host.request('list', {}, abort.signal);
  let settled = false;
  const result = assert.rejects(request, { name: 'AbortError' }).then(() => { settled = true; });
  abort.abort();
  await tick();
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal(settled, false);
  f.child.emit('close', null, 'SIGTERM');
  await result;
});
test('Mac shutdown escalates to SIGKILL while retaining pending requests until the OS close event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = hostFixture(t), abort = new AbortController();
  const request = f.host.request('list', {}, abort.signal);
  const result = assert.rejects(request, { name: 'AbortError' });
  await tick();
  abort.abort();
  t.mock.timers.tick(1000);
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.host.pending.size, 1);
  f.child.emit('close', null, 'SIGKILL');
  await result;
});
