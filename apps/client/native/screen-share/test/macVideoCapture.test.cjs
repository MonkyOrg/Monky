'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MacVideoCapture, validateMacTarget } = require('../runtime/mac/index.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const target = { platform: 'darwin', kind: 'window', windowId: 12,
  expectedProcessId: 34, expectedProcessStartTimeUs: '123456789' };
const video = { width: 320, height: 180, fps: 30, bitrateKbps: 1000, scaleMode: 'fit' };
function fixture() {
  let options, allowExit;
  const exited = new Promise(resolve => { allowExit = resolve; });
  const packets = [], errors = [], requests = [];
  const host = {
    pending: new Map(), exited: false,
    async request(method, data) {
      requests.push({ method, data });
      return { value: { captureStarted: true, source: data.target, video: data.video } };
    },
    fail(error) { host.failure = error; options.onError(error); },
    async close() { await exited; host.exited = true; if (host.failure) throw host.failure; },
    resumeVideo() {},
  };
  const capture = new MacVideoCapture({
    target, video, mode: 'hardware', onPacket: frame => { packets.push(frame); }, onError: error => errors.push(error),
  }, { runtime: { executable: 'owned-host' }, hostFactory: (_executable, config) => { options = config; return host; } });
  const frame = { frameId: 1, timestampUs: 123000, durationUs: 33333, keyframe: true,
    codec: 'h264', ntpTimeMs: -1, data: Buffer.from([0, 0, 0, 1, 0x65]) };
  return { capture, host, requests, errors, packets, allowExit, frame: () => options.onVideo(frame) };
}
test('Mac capture does not report a running encoder until its first real access unit arrives', async () => {
  const f = fixture();
  let ready = false;
  const start = f.capture.start().then(result => { ready = true; return result; });
  await tick();
  assert.equal(ready, false);
  assert.deepEqual(f.requests[0], { method: 'media.start', data: { target, video: { ...video, mode: 'hardware' } } });
  f.frame();
  assert.equal((await start).hardwareSessionConfirmed, true);
  assert.equal(f.packets.length, 1);
  let closed = false;
  const close = f.capture.close().then(result => { closed = true; return result; });
  await tick(); assert.equal(closed, false);
  f.allowExit();
  assert.deepEqual(await close, { nativeClosed: true, hostExited: true, retiredWithErrors: false });
});
test('closing Mac capture while waiting for first pixels waits for the original process before settling startup', async () => {
  const f = fixture();
  let settled = false;
  const start = assert.rejects(f.capture.start(), { name: 'AbortError' }).then(() => { settled = true; });
  await tick();
  const close = f.capture.close();
  await tick(); assert.equal(settled, false);
  f.allowExit();
  await Promise.all([start, close]);
  assert.equal(f.host.exited, true);
});
test('Mac capture cancellation preserves its original owner until termination and reports earlier failure', async () => {
  const f = fixture(), abort = new AbortController();
  let settled = false;
  const start = assert.rejects(f.capture.start({ signal: abort.signal }), { name: 'AbortError' })
    .then(() => { settled = true; });
  await tick();
  abort.abort();
  await tick(); assert.equal(settled, false);
  f.allowExit();
  await start;
  assert.equal((await f.capture.close()).retiredWithErrors, true);
  assert.equal(f.errors.length, 1);
  assert.equal(f.host.exited, true);
});
test('Mac source binding rejects Windows handles, missing birth identity and additional executable paths', () => {
  for (const invalid of [{ ...target, hwnd: 1 }, { ...target, expectedProcessStartTimeUs: '' },
    { ...target, platform: 'win32' }, { ...target, executable: 'PRIVATE_PATH' }])
    assert.throws(() => validateMacTarget(invalid));
  assert.deepEqual(validateMacTarget(target), target);
  assert.ok(Object.isFrozen(validateMacTarget(target)));
});
