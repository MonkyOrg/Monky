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
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

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

test('pausing preview resets the decoder and a late receipt cannot restore the playing state', () => {
  const f = bridgeFixture(), pipelineId = randomUUID();
  f.bridge.offer(packet(), pipelineId, video);
  f.bridge.reset('paused');
  assert.deepEqual(f.port.messages.at(-1), { type: 'reset' });
  f.port.receive({ sequence: 1, rendered: true, needsKeyframe: false });
  assert.deepEqual(f.states, ['paused']);
  f.bridge.offer({ ...packet(), keyframe: false }, pipelineId, video);
  assert.equal(f.bridge.pending.size, 0);
  f.bridge.offer(packet(), pipelineId, video);
  f.port.receive({ sequence: 2, rendered: true, needsKeyframe: false });
  assert.deepEqual(f.states, ['paused', 'playing']);
  f.bridge.close();
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

function presentationFixture(t, { blocked = false, writeFailure = null } = {}) {
  const platform = decoderPlatform(), ipc = new EventEmitter(), port = new Port(), errors = [];
  let resolveAbort, rejectWrite, pending = false, frameClosed = 0, released = false;
  const abortGate = new Promise(resolve => { resolveAbort = resolve; });
  const writer = {
    write() {
      if (track.readyState === 'ended') return Promise.reject(new DOMException('Stream closed', 'InvalidStateError'));
      if (writeFailure) return Promise.reject(writeFailure);
      if (!blocked) return Promise.resolve();
      pending = true;
      return new Promise((_resolve, reject) => { rejectWrite = error => { pending = false; reject(error); }; });
    },
    async abort(reason) {
      if (blocked) await abortGate;
      rejectWrite?.(reason);
    },
    releaseLock() { assert.equal(pending, false); released = true; },
  };
  class Track {
    readyState = 'live';
    writable = { getWriter: () => writer };
    stop() {
      this.readyState = 'ended';
      if (pending) rejectWrite(new DOMException('Stream closed', 'InvalidStateError'));
    }
  }
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getVideoTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
  }
  for (const [name, value] of Object.entries({ VideoDecoder: platform.VideoDecoder,
    EncodedVideoChunk: platform.EncodedVideoChunk, MediaStreamTrackGenerator: Track, MediaStream: Stream })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const owner = { id: randomUUID(), nodeName: 'VIDEO', srcObject: null, async play() {}, pause() {} };
  const controller = createNativeScreenPresentation({ setSharedTextureReceiver() {} }, {
    getElementById: () => owner, querySelectorAll: () => [owner],
  }, (_id, error) => errors.push(error), ipc);
  t.after(async () => { resolveAbort(); await controller.close(); });
  const scope = info(), input = packet();
  let track;
  return { controller, scope, port, errors, platform, owner, resolveAbort, rejectPending: error => rejectWrite(error),
    get track() { return track; }, get pending() { return pending; },
    get frameClosed() { return frameClosed; }, get released() { return released; },
    async start() {
      await controller.attachPreview({ presentationId: scope.presentationId, elementId: owner.id });
      track = owner.srcObject.getVideoTracks()[0];
      ipc.emit(NATIVE_SCREEN_PREVIEW_IPC.port, { ports: [port] }, scope);
      port.receive(input);
      await tick();
    },
    output() {
      platform.decoders[0].callbacks.output({
        timestamp: input.timestampUs, codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080,
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 }, close() { frameClosed++; },
      });
    },
  };
}

test('real VideoService source replacement does not stop the preload-owned generator before its decoder', async t => {
  const f = presentationFixture(t);
  await f.start();
  const filename = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'core', 'VideoService.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'VideoService');
  const method = declaration?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === 'stopScreenShare');
  assert.ok(method, 'Exercise the actual native/browser track ownership boundary.');
  const compiled = ts.transpileModule(`class Owner { ${method.getText(source)} }; Owner;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const Owner = vm.runInNewContext(compiled, { clientLog: { info() {} }, appEvents: { emit() {} } });
  const owner = { screenStreams: new Map([['native', f.owner.srcObject]]), screenSourceIds: new Map([['native', 'owned-hwnd']]),
    nativeScreenCaptures: new Map([['native', { source: { shareId: 'native' } }]]) };
  Owner.prototype.stopScreenShare.call(owner, 'native');
  f.output();
  await tick();
  assert.deepEqual(f.errors, [], 'Source removal closed the generator before a still-active decoded frame reached its writer.');
  assert.equal(f.track.readyState, 'live', 'Only the preload presentation owner may stop its generator.');
  assert.equal(owner.screenStreams.size, 0);
  await f.controller.stop(f.scope.presentationId);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.platform.decoders[0].state, 'closed');
  let browserStops = 0;
  const browserTrack = { stop() { browserStops++; } };
  owner.screenStreams.set('browser', { getVideoTracks: () => [browserTrack], getTracks: () => [browserTrack] });
  Owner.prototype.stopScreenShare.call(owner, 'browser');
  assert.equal(browserStops, 1, 'Browser captures remain owned and stopped by VideoService.');
});

test('live quality never applies browser constraints to a borrowed native preview track', async () => {
  const filename = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'core', 'VideoService.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'VideoService');
  const method = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === 'applyQualityPreset');
  const compiled = ts.transpileModule(`class Owner { ${method.getText(source)} }; Owner;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const warnings = [], constraints = [];
  const Owner = vm.runInNewContext(compiled, { clientLog: { warn: (...values) => warnings.push(values) } });
  const native = { readyState: 'live', applyConstraints() { throw new Error('Native generator is not a browser capture device.'); } };
  const browser = { readyState: 'live', async applyConstraints(value) { constraints.push(value); } };
  await Owner.prototype.applyQualityPreset.call({
    getProfile: () => ({ screenWidth: 1920, screenHeight: 1080, screenFps: 120 }),
    nativeScreenCaptures: new Map([['native', {}]]),
    screenStreams: new Map([['native', { getVideoTracks: () => [native] }], ['browser', { getVideoTracks: () => [browser] }]]),
  }, 'CUSTOM');
  assert.deepEqual(warnings, []);
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].frameRate.max, 120);
  assert.equal(browser.contentHint, 'motion');
  assert.equal(native.contentHint, undefined);
});

test('Stop closes preview admission/decoder then drains an aborted writer before stopping its generator', async t => {
  const f = presentationFixture(t, { blocked: true });
  await f.start(); f.output(); await tick();
  assert.equal(f.pending, true);
  let stopped = false;
  const stopping = f.controller.stop(f.scope.presentationId).then(() => { stopped = true; });
  try {
    await tick();
    assert.equal(f.platform.decoders[0].state, 'closed');
    assert.equal(f.port.closed, true);
    assert.equal(stopped, false);
    assert.equal(f.track.readyState, 'live', 'Stopping the generator races the outstanding writer with Stream closed.');
    assert.equal(f.released, false);
    f.output();
    assert.equal(f.frameClosed, 1, 'A late decoder output must close without entering the writer.');
  } finally {
    f.resolveAbort();
    await stopping;
  }
  assert.equal(f.frameClosed, 2);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.released, true);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.port.messages, [], 'Stop cannot acknowledge rendering or release a fictitious frame receipt.');
});

test('an active presentation still reports genuine writer failures and closes its decoder', async t => {
  const failure = new Error('Actual active writer failure');
  const f = presentationFixture(t, { writeFailure: failure });
  await f.start(); f.output(); await tick();
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.frameClosed, 1);
  assert.equal(f.platform.decoders[0].state, 'closed');
  assert.deepEqual(f.port.messages, []);
  await f.controller.stop(f.scope.presentationId);
  assert.equal(f.released, true);
});

test('an unrelated pending write failure during Stop remains observable, not a cancellation receipt', async t => {
  const f = presentationFixture(t, { blocked: true }), failure = new Error('Actual writer failure during retirement');
  await f.start(); f.output(); await tick();
  const stopping = f.controller.stop(f.scope.presentationId);
  await tick();
  f.rejectPending(failure);
  f.resolveAbort();
  await assert.rejects(stopping, error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(error => error instanceof AggregateError && error.errors.includes(failure)));
    return true;
  });
  assert.equal(f.frameClosed, 1);
  assert.deepEqual(f.port.messages, []);
  await f.controller.stop(f.scope.presentationId);
  assert.equal(f.released, true);
});

test('a blocked writer timeout retains its generator and frame until an acknowledged retirement retry', async t => {
  const f = presentationFixture(t, { blocked: true });
  await f.start(); f.output(); await tick();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = f.controller.stop(f.scope.presentationId);
  const rejected = assert.rejects(stopping, /owners did not retire/);
  await tick();
  t.mock.timers.tick(5001);
  await rejected;
  assert.equal(f.track.readyState, 'live');
  assert.equal(f.pending, true);
  assert.equal(f.frameClosed, 0);
  assert.equal(f.released, false);
  assert.deepEqual(f.port.messages, []);
  f.resolveAbort();
  await tick();
  await f.controller.stop(f.scope.presentationId);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.frameClosed, 1);
  assert.equal(f.released, true);
});

test('a detached preview port callback cannot retain new packets after Stop', async () => {
  const platform = decoderPlatform(), port = new Port(), errors = [];
  const renderer = new EncodedPreviewRenderer({ acceptFrame() { assert.fail('No stopped output can be admitted.'); } },
    error => errors.push(error), platform);
  renderer.attach(port);
  const staleMessage = renderer.message;
  await renderer.stop();
  staleMessage({ data: packet() });
  await renderer.tail;
  assert.equal(renderer.pending.size, 0);
  assert.equal(platform.decoders.length, 0);
  assert.deepEqual(port.messages, []);
  assert.deepEqual(errors, []);
});
