'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { NATIVE_SCREEN_TEXTURE_IPC, nativeScreenTexturePortInfoSchema } = require('@monky/shared');
const { sendTexture, registerTextureTransferReceiver } = require('../runtime/textureTransfer.cjs');
const { NativePresentationBridge } = require('../runtime/nativePresentationBridge.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Port extends EventEmitter {
  held = false;
  queued = [];
  start() {}
  postMessage(data) {
    queueMicrotask(() => {
      if (this.peer.held) this.peer.queued.push(data);
      else this.peer.emit('message', { data });
    });
  }
  resume() {
    this.held = false;
    for (const data of this.queued.splice(0)) this.emit('message', { data });
  }
  close() { queueMicrotask(() => this.peer.emit('close')); }
}

function fixture({ failToken = false } = {}) {
  const ipc = new EventEmitter(), errors = [], syncTokens = [];
  const metadata = { frameId: 1, timestampUs: 123, presentationId: randomUUID() };
  const transfer = { pixelFormat: 'nv12', codedSize: { width: 1280, height: 720 },
    visibleRect: { x: 0, y: 0, width: 1280, height: 720 }, timestamp: metadata.timestampUs,
    syncToken: Buffer.alloc(24).toString('base64'), transfer: Buffer.alloc(96).toString('base64') };
  let finishDrawing, gpuRelease, releaseCalls = 0, gpuFinished = false;
  const drawing = new Promise(resolve => { finishDrawing = resolve; });
  const source = { startTransferSharedTexture: () => transfer, setReleaseSyncToken: token => syncTokens.push(token) };
  const imported = { subtle: source };
  const channels = [];
  const createChannel = () => {
    const port1 = new Port(), port2 = new Port();
    port1.peer = port2; port2.peer = port1;
    channels.push({ port1, port2 });
    return { port1, port2 };
  };
  const detach = registerTextureTransferReceiver({ subtle: {
    finishTransferSharedTexture(value) {
      assert.deepEqual(value, transfer);
      return { getFrameCreationSyncToken() {
        if (failToken) throw new Error('Modeled creation-token failure after import.');
        return { syncToken: transfer.syncToken };
      },
        getVideoFrame: () => ({ close() {} }),
        release(callback) { releaseCalls++; gpuRelease = callback; } };
    },
  } }, ipc, async () => drawing, error => errors.push(error));
  const destination = { isDestroyed: () => false,
    postMessage(channel, value, ports) { ipc.emit(channel, { ports }, value); } };
  return { ipc, errors, syncTokens, metadata, transfer, source, imported, channels, createChannel, destination,
    detach, finishDrawing, get releaseCalls() { return releaseCalls; }, get gpuFinished() { return gpuFinished; },
    finishGpu() { assert.equal(typeof gpuRelease, 'function'); gpuFinished = true; gpuRelease(); } };
}

test('texture transfer waits for the renderer GPU receipt, not just import or VideoFrame close', async () => {
  const f = fixture();
  f.metadata.presentationId = `screen-${randomUUID()}`;
  let done = false;
  const work = sendTexture(f.imported, f.destination, f.metadata, error => f.errors.push(error),
    { createChannel: f.createChannel }).then(() => { done = true; });
  await tick();
  assert.deepEqual(f.syncTokens, [{ syncToken: f.transfer.syncToken }]);
  assert.equal(done, false);
  f.finishDrawing();
  await tick();
  assert.equal(f.releaseCalls, 1);
  assert.equal(done, false);
  f.finishGpu();
  await work;
  await f.detach();
  assert.equal(f.channels[0].port1.listenerCount('message'), 0);
  assert.equal(f.ipc.listenerCount(NATIVE_SCREEN_TEXTURE_IPC.port), 0);
  assert.deepEqual(f.errors, []);
});

test('late texture receipts remain live after acquisition timeout and do not authorize early release', async () => {
  const f = fixture();
  f.destination.postMessage = (channel, value, ports) => {
    f.channels[0].port1.held = true;
    f.ipc.emit(channel, { ports }, value);
  };
  let done = false;
  const work = sendTexture(f.imported, f.destination, f.metadata, error => f.errors.push(error),
    { createChannel: f.createChannel, timeoutMs: 10 }).then(() => { done = true; });
  await delay(30);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /timed out.*remain owned/);
  assert.equal(done, false);
  f.finishDrawing();
  await tick();
  f.finishGpu();
  await tick();
  assert.equal(done, false);
  f.channels[0].port1.resume();
  await work;
  await f.detach();
  assert.equal(done, true);
  assert.equal(f.errors.length, 1);
});

test('a texture port closing without a receipt reports retained ownership, never successful retirement', async () => {
  const f = fixture();
  let done = false;
  const work = sendTexture(f.imported, f.destination, f.metadata, error => f.errors.push(error),
    { createChannel: f.createChannel }).then(() => { done = true; });
  await tick();
  f.channels[0].port1.emit('close');
  assert.equal(done, false);
  assert.match(f.errors[0].message, /without its GPU retirement receipt/);
  f.finishDrawing();
  await tick();
  f.finishGpu();
  await work;
  await f.detach();
});

test('invalid sync token sizes are rejected before calling Electron native code', async () => {
  const f = fixture();
  f.destination.postMessage = () => {};
  const work = sendTexture(f.imported, f.destination, f.metadata, error => f.errors.push(error),
    { createChannel: f.createChannel });
  const port = f.channels[0].port1;
  port.emit('message', { data: { kind: 'imported', syncToken: Buffer.alloc(4).toString('base64') } });
  assert.equal(f.syncTokens.length, 0);
  assert.equal(f.errors.length, 1);
  port.emit('message', { data: { kind: 'imported', syncToken: f.transfer.syncToken } });
  port.emit('message', { data: { kind: 'retired' } });
  await work;
  await f.detach();
});

test('document detach waits for actual GPU callbacks even after the sink has returned', async () => {
  const f = fixture();
  const work = sendTexture(f.imported, f.destination, f.metadata, error => f.errors.push(error),
    { createChannel: f.createChannel });
  f.finishDrawing();
  await tick();
  let detached = false;
  const closing = f.detach().then(() => { detached = true; });
  await tick();
  assert.equal(detached, false);
  f.finishGpu();
  await Promise.all([work, closing]);
  assert.deepEqual(f.errors, []);
});

test('renderer failure after import still requires its GPU callback before Main can retire', async () => {
  const f = fixture({ failToken: true });
  let done = false;
  const work = sendTexture(f.imported, f.destination, f.metadata, error => f.errors.push(error),
    { createChannel: f.createChannel }).then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  assert.equal(f.releaseCalls, 1);
  assert.ok(f.errors.every(error => /creation-token failure/.test(error.message)));
  assert.equal(f.syncTokens.length, 0);
  f.finishGpu();
  await work;
  await f.detach();
});

test('the real presentation bridge releases Main then RTC only after renderer GPU retirement', async () => {
  const f = fixture();
  let releaseMain = 0, resolveRtc;
  const rtcRetired = new Promise(resolve => { resolveRtc = resolve; });
  const bridge = new NativePresentationBridge({
    request() {}, submitFrame() {},
    releaseFrame(frameId, reason) {
      assert.equal(f.gpuFinished, true);
      assert.equal(releaseMain, 1);
      assert.equal(reason, 'all-references-released');
      return rtcRetired.then(() => ({ frameId, ok: true }));
    },
  }, {
    importSharedTexture({ allReferencesReleased }) {
      return { subtle: f.source, release() { releaseMain++; allReferencesReleased(); } };
    },
    sendSharedTexture() { assert.fail('The fixed-timeout Electron convenience API must not be used.'); },
  }, error => f.errors.push(error), { createTextureChannel: f.createChannel });
  const event = { type: 'frame', target: 1, data: { frameId: 1, timestampUs: 123,
    format: 'NV12', gpuCopy: true, width: 1280, height: 720, codedWidth: 1280, codedHeight: 720,
    textureInfo: { pixelFormat: 'nv12', timestamp: 123, handle: { ntHandle: Buffer.alloc(8) },
      codedSize: f.transfer.codedSize, visibleRect: f.transfer.visibleRect,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' } } } };
  const work = bridge.publish(event, { frame: f.destination, presentationId: f.metadata.presentationId });
  f.finishDrawing();
  await tick();
  assert.equal(releaseMain, 0);
  assert.equal(bridge.getStats().delivered, 1);
  f.finishGpu();
  await work;
  await tick();
  assert.equal(bridge.getStats().outstandingLeases, 1);
  resolveRtc();
  await bridge.stop();
  await f.detach();
  assert.equal(bridge.getStats().outstandingLeases, 0);
  assert.equal(bridge.getStats().retired, 1);
  assert.deepEqual(f.errors, []);
});

test('texture wire schemas reject malformed geometry, opaque data, timestamps and metadata', () => {
  const f = fixture(), valid = { metadata: f.metadata, transfer: f.transfer };
  for (const value of [
    { ...valid, metadata: { ...f.metadata, frameId: 0 } },
    { ...valid, metadata: { ...f.metadata, presentationId: 'invalid:route' } },
    { ...valid, transfer: { ...f.transfer, timestamp: 124 } },
    { ...valid, transfer: { ...f.transfer, syncToken: '!!!!' } },
    { ...valid, transfer: { ...f.transfer, transfer: 'A'.repeat(16388) } },
    { ...valid, transfer: { ...f.transfer, visibleRect: { ...f.transfer.visibleRect, x: 1280 } } },
    { ...valid, transfer: { ...f.transfer, codedSize: { width: 1279, height: 720 } } },
  ]) assert.equal(nativeScreenTexturePortInfoSchema.safeParse(value).success, false);
});
