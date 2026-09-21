'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { NATIVE_SCREEN_PREVIEW_IPC, nativeScreenPreviewPacketSchema } = require('@monky/shared');
const { NativeScreenPreviewBridge, MAX_PACKETS, MAX_BYTES } = require('../runtime/nativeScreenPreviewBridge.cjs');
const { EncodedPreviewRenderer, h264Codec } = require('../runtime/encodedPreviewRenderer.cjs');
const { createNativeScreenPresentation } = require('../runtime/nativePresentationRenderer.cjs');
const { within } = require('../runtime/nativeDeadline.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
const sps = new Uint8Array([0, 0, 0, 1, 0x67, 0x4d, 0, 0x33, 0x80, 0, 0, 1, 0x65, 0x80]);
const info = () => ({ callId: randomUUID(), shareId: 'owned-screen', sourceInstanceId: randomUUID(), presentationId: randomUUID() });
const packet = (sequence = 1, pipelineId = randomUUID()) => ({
  type: 'packet', sequence, pipelineId, video, timestampUs: sequence * 8333, keyframe: true, data: sps,
});

class Port extends EventEmitter {
  messages = [];
  closed = false;
  start() {}
  postMessage(value) { this.messages.push(value); }
  receive(value) { this.emit('message', { data: value }); }
  addEventListener(...args) { this.on(...args); }
  removeEventListener(...args) { this.off(...args); }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}

function bridgeFixture() {
  const port = new Port(), remote = new Port(), states = [], errors = [], scope = info();
  const bridge = new NativeScreenPreviewBridge({
    info: scope, createMessageChannel: () => ({ port1: port, port2: remote }),
    frame: { postMessage(channel, value, ports) {
      assert.equal(channel, NATIVE_SCREEN_PREVIEW_IPC.port);
      assert.deepEqual(value, scope);
      assert.deepEqual(ports, [remote]);
    } },
    onState: state => states.push(state), onError: error => errors.push(error),
  });
  return { bridge, port, states, errors };
}

function decoderPlatform(configuration) {
  const decoders = [];
  class VideoDecoder {
    state = 'unconfigured';
    chunks = [];
    constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
    static async isConfigSupported(config) {
      await configuration;
      return { supported: true, config };
    }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { assert.equal(this.state, 'configured'); this.chunks.push(chunk); }
    close() { this.state = 'closed'; }
  }
  class EncodedVideoChunk { constructor(value) { Object.assign(this, value); } }
  return { decoders, VideoDecoder, EncodedVideoChunk };
}

test('local preview derives its codec from the original Annex-B SPS', () => {
  assert.equal(h264Codec(sps), 'avc1.4d0033');
  assert.equal(h264Codec(sps.subarray(1)), 'avc1.4d0033');
  assert.throws(() => h264Codec(new Uint8Array([0, 0, 1, 0x65, 1, 2, 3, 4, 5])), /original H.264 SPS/);
});

test('preview accepts ordinary IPC buffers without requiring browser SharedArrayBuffer access', () => {
  assert.equal(nativeScreenPreviewPacketSchema.safeParse({ ...packet(), data: new Uint8Array(new SharedArrayBuffer(16)) }).success, false);
  const original = globalThis.SharedArrayBuffer;
  try {
    globalThis.SharedArrayBuffer = undefined;
    assert.equal(nativeScreenPreviewPacketSchema.safeParse(packet()).success, true);
  } finally { globalThis.SharedArrayBuffer = original; }
});

test('preview packet credits never block the publisher and recover only at a real keyframe', () => {
  const f = bridgeFixture(), pipelineId = randomUUID();
  for (let index = 0; index < MAX_PACKETS + 1; index++)
    f.bridge.offer({ ...packet(index + 1), keyframe: index === 0 }, pipelineId, video);
  assert.equal(f.port.messages.length, MAX_PACKETS);
  assert.equal(f.bridge.pending.size, MAX_PACKETS);
  f.port.receive({ sequence: 1, rendered: true, needsKeyframe: false });
  assert.deepEqual(f.states, ['playing']);
  f.bridge.offer({ ...packet(), keyframe: false }, pipelineId, video);
  assert.equal(f.port.messages.length, MAX_PACKETS);
  f.bridge.offer(packet(), pipelineId, video);
  assert.equal(f.port.messages.length, MAX_PACKETS + 1);
  assert.deepEqual(f.errors, []);
  f.bridge.close();
  assert.equal(f.bridge.bytes, 0);
  assert.equal(f.port.listenerCount('message'), 0);
});

test('preview enforces its byte bound and rejects replayed or forged receipts', () => {
  for (const receipt of [1, 1234]) {
    const f = bridgeFixture(), pipelineId = randomUUID();
    const frame = { ...packet(), data: new Uint8Array(3 * 1024 * 1024) };
    for (let index = 0; index < 3; index++) f.bridge.offer(frame, pipelineId, video);
    assert.equal(f.port.messages.length, 2);
    assert.ok(f.bridge.bytes <= MAX_BYTES);
    f.port.receive({ sequence: 1, rendered: false, needsKeyframe: false });
    f.port.receive({ sequence: receipt, rendered: false, needsKeyframe: false });
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].message, /outstanding packet/);
    assert.equal(f.bridge.closed, true);
    assert.equal(f.bridge.pending.size, 0);
    assert.deepEqual(f.states, ['unavailable']);
  }
});

test('changing the actual rendition ignores old receipts and waits for its own keyframe', () => {
  const f = bridgeFixture(), first = randomUUID(), next = randomUUID();
  f.bridge.offer(packet(), first, video);
  f.bridge.offer({ ...packet(), keyframe: false }, next, video);
  f.port.receive({ sequence: 1, rendered: true, needsKeyframe: false });
  assert.deepEqual(f.states, []);
  f.bridge.offer(packet(), next, video);
  f.port.receive({ sequence: 2, rendered: true, needsKeyframe: false });
  assert.deepEqual(f.states, ['playing']);
  f.bridge.reset();
  assert.deepEqual(f.port.messages.at(-1), { type: 'reset' });
  assert.deepEqual(f.states, ['playing', 'waiting']);
  f.bridge.close();
});

test('reset during asynchronous codec discovery cannot create a late decoder', async () => {
  let release;
  const platform = decoderPlatform(new Promise(resolve => { release = resolve; }));
  const port = new Port(), errors = [];
  const renderer = new EncodedPreviewRenderer({ acceptFrame() { assert.fail('No decoded frame was admitted.'); } },
    error => errors.push(error), platform);
  renderer.attach(port);
  port.receive(packet());
  await tick();
  port.receive({ type: 'reset' });
  release();
  await renderer.tail;
  assert.equal(platform.decoders.length, 0);
  assert.deepEqual(port.messages, [{ sequence: 1, rendered: false, needsKeyframe: false }]);
  await renderer.stop();
  assert.equal(port.listenerCount('message'), 0);
  assert.equal(port.closed, true);
  assert.deepEqual(errors, []);
});

test('a failed preview receipt retires the decoder without an unobserved rejection', async () => {
  const platform = decoderPlatform(), port = new Port(), errors = [];
  const renderer = new EncodedPreviewRenderer({
    async acceptFrame(frame) { frame.close(); return true; },
  }, error => errors.push(error), platform);
  renderer.attach(port);
  const input = packet();
  port.receive(input);
  await renderer.tail;
  let closed = 0;
  port.postMessage = () => { throw new Error('Owned port is unavailable.'); };
  platform.decoders[0].callbacks.output({ timestamp: input.timestampUs, close() { closed++; } });
  await tick();
  await renderer.stop();
  assert.equal(closed, 1);
  assert.equal(errors.length, 1);
  assert.equal(platform.decoders[0].state, 'closed');
  assert.equal(renderer.pending.size, 0);
  assert.equal(port.closed, true);
});

test('presentation retirement aborts a blocked preview writer and releases aliased stage streams', async t => {
  const platform = decoderPlatform(), ipc = new EventEmitter(), port = new Port(), errors = [];
  let rejectWrite, released = false;
  const writer = {
    write() { return new Promise((_resolve, reject) => { rejectWrite = reject; }); },
    async abort(reason) { rejectWrite?.(reason); },
    releaseLock() { released = true; },
  };
  class MediaStreamTrackGenerator {
    readyState = 'live';
    writable = { getWriter: () => writer };
    stop() { this.readyState = 'ended'; }
  }
  class MediaStream {
    constructor(tracks) { this.tracks = tracks; }
    getVideoTracks() { return this.tracks; }
  }
  const globals = { ...platform, MediaStreamTrackGenerator, MediaStream };
  delete globals.decoders;
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const owner = { id: randomUUID(), nodeName: 'VIDEO', srcObject: null, async play() {}, pause() {} };
  const alias = { srcObject: null, paused: false, pause() { this.paused = true; } };
  const other = { srcObject: new MediaStream([]), pause() { assert.fail('An unrelated player was paused.'); } };
  const controller = createNativeScreenPresentation({ setSharedTextureReceiver() {} }, {
    getElementById: id => id === owner.id ? owner : null, querySelectorAll: () => [owner, alias, other],
  }, (_id, error) => errors.push(error), ipc);
  t.after(() => controller.close());
  const scope = info();
  await controller.attachPreview({ presentationId: scope.presentationId, elementId: owner.id });
  const track = owner.srcObject.getVideoTracks()[0];
  alias.srcObject = new MediaStream([track]);
  ipc.emit(NATIVE_SCREEN_PREVIEW_IPC.port, { ports: [port] }, scope);
  const input = packet();
  port.receive(input);
  await tick();
  assert.equal(platform.decoders[0].config.codec, 'avc1.4d0033');
  let closed = 0;
  platform.decoders[0].callbacks.output({
    timestamp: input.timestampUs, codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080,
    visibleRect: { x: 0, y: 0, width: 1920, height: 1080 }, close() { closed++; },
  });
  await tick();
  assert.equal(typeof rejectWrite, 'function');
  await within(controller.stop(scope.presentationId), 1000, 'Preview teardown waited for its own blocked writer.');
  assert.equal(closed, 1);
  assert.equal(released, true);
  assert.equal(track.readyState, 'ended');
  assert.equal(owner.srcObject, null);
  assert.equal(alias.srcObject, null);
  assert.equal(alias.paused, true);
  assert.equal(port.closed, true);
  assert.equal(platform.decoders[0].state, 'closed');
  assert.deepEqual(errors, []);
  await controller.close();
  assert.equal(ipc.listenerCount(NATIVE_SCREEN_PREVIEW_IPC.port), 0);
});
