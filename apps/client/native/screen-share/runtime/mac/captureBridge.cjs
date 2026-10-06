'use strict';

const assert = require('node:assert/strict');
const { acquireMacHost } = require('./hostPool.cjs');
const { MacVideoCapture } = require('./capture.cjs');
const { validateMacTarget } = require('./target.cjs');
const { normalizedVideo } = require('../captureProtocol.cjs');

const ENCODERS = Object.freeze({
  apple_vt_h264: Object.freeze({ codec: 'h264', mode: 'hardware' }),
  apple_vt_h264_software: Object.freeze({ codec: 'h264', mode: 'software' }),
  monky_aom_av1: Object.freeze({ codec: 'av1', mode: 'software' }),
});
function encoderProfile(encoder) {
  assert.ok(Object.hasOwn(ENCODERS, encoder), 'The macOS backend requires an explicit native encoder.');
  return ENCODERS[encoder];
}
async function probe(host, video, encoder, signal) {
  const { mode, codec } = encoderProfile(encoder);
  const { value } = await host.request('media.probe', { video: { ...normalizedVideo(video), mode, codec } }, signal);
  assert.equal(value.captureStarted, false);
  assert.equal(value.nativeClosed, true);
  assert.equal(value.hardwareExecutionObserved, null);
  assert.equal(value.sessionUsesHardware, mode === 'hardware');
  assert.equal(value.syntheticFrameEncoded, true, 'Encoder availability needs a real synthetic access unit.');
  assert.equal(value.codec, codec);
  if (codec === 'av1') {
    assert.equal(value.profileLevelId, null);
    assert.equal(value.sequenceVerified, true);
  } else assert.match(value.profileLevelId, /^4d[0-9a-f]{4}$/u);
  return Object.freeze({ encoderId: encoder, codec, mode, probe: codec === 'av1' ? 'libaom-session' : 'videotoolbox-session',
    probeVerified: true, textureInput: codec === 'h264', dynamicBitrate: true, hardwareSessionConfirmed: false,
    hardwareQualified: false });
}
async function probeCaptureCapabilities(options, signal, dependencies = {}) {
  assert.equal(options.host?.kind, 'verified-screencapturekit-host');
  const host = (dependencies.hostFactory ?? acquireMacHost)(options.host.executable);
  let capability, failure;
  try { capability = await probe(host, options.video, options.encoder, signal); }
  catch (error) { failure = error; }
  try { await host.close(); }
  catch (error) {
    if (!host.exited) throw new AggregateError([failure, error].filter(Boolean), 'Native encoder probe retirement is unconfirmed.');
    throw failure ?? error;
  }
  if (failure) throw failure;
  return Object.freeze({ ...capability, encoderInitialized: true, sourceCaptured: false,
    captureKinds: Object.freeze(['window', 'monitor']), video: Object.freeze(normalizedVideo(options.video)) });
}

class MacCaptureBridge {
  #capture;
  #closed = false;
  constructor(options, dependencies = {}) {
    assert.equal(options.host?.kind, 'verified-screencapturekit-host');
    assert.equal(typeof options.onPacket, 'function');
    assert.equal(typeof options.onError, 'function');
    this.options = options;
    this.dependencies = dependencies;
    this.mode = encoderProfile(options.encoder).mode;
    this.codec = encoderProfile(options.encoder).codec;
    this.video = Object.freeze(normalizedVideo(options.video));
    this.ceiling = options.bitrateCeilingKbps ?? 80000;
    this.sequence = 0;
    assert.ok(Number.isInteger(this.ceiling) && this.ceiling >= this.video.bitrateKbps && this.ceiling <= 80000);
  }
  get child() { return this.#capture?.host.child; }
  async prepare(target, signal) {
    assert.ok(!this.#capture && !this.stopping, 'A retired or prepared macOS capture owner cannot be reused.');
    this.target = Object.freeze(structuredClone(validateMacTarget(target)));
    this.#capture = new MacVideoCapture({ target: this.target, video: this.video, mode: this.mode, codec: this.codec,
      onPacket: this.options.onPacket, onError: this.options.onError },
    { ...this.dependencies, runtime: this.options.host });
    const { value } = await this.#capture.host.request('resolve', { target: this.target }, signal);
    assert.deepEqual(value.target, this.target);
    this.capability = await probe(this.#capture.host, this.video, this.options.encoder, signal);
    return this.capability;
  }
  async start(target, signal) {
    assert.deepEqual(target, this.target);
    assert.ok(this.capability && !this.stopping);
    const proof = await this.#capture.start({ signal });
    this.ready = true;
    return proof;
  }
  getCapabilities() {
    return this.capability ? Object.freeze({ ...this.capability,
      hardwareSessionConfirmed: this.mode === 'hardware' && this.ready === true }) : null;
  }
  async setBitrate(bitrateKbps) {
    assert.ok(bitrateKbps <= this.ceiling, 'Capture bitrate exceeds its admitted profile.');
    const sequence = ++this.sequence;
    return { ...await this.#capture.setBitrate(bitrateKbps), kind: 'bitrate-settings', sequence };
  }
  async requestKeyFrame() {
    const sequence = ++this.sequence;
    return { ...await this.#capture.requestKeyFrame(), kind: 'idr-request', sequence };
  }
  resumePackets() { this.#capture?.resumePackets(); }
  async getStats() {
    const native = this.#capture ? (await this.#capture.host.request('media.stats')).value : null;
    return { backend: 'ScreenCaptureKit', packets: this.#capture?.host.mediaSequence ?? 0,
      lastTimestampUs: this.#capture?.host.lastVideoTimestamp ?? null, native };
  }
  snapshot() {
    return { nativeClosed: this.#closed,
      forcedTermination: this.#capture?.host.forcedTermination ?? !!this.#capture?.host.failure,
      capability: this.getCapabilities(), live: { packets: this.#capture?.host.mediaSequence ?? 0,
        queuedJavaScriptFrames: 0 } };
  }
  stop() {
    if (!this.stopping) this.stopping = (async () => {
      if (this.#capture) {
        await this.#capture.close();
        assert.ok(this.#capture.host.nativeClosed === true || this.#capture.host.exited === true);
      }
      this.#closed = true;
      return this.snapshot();
    })();
    return this.stopping;
  }
  assertClosed() {
    assert.ok(this.#closed, 'The original macOS capture lease has not proved retirement.');
  }
}

const assertMacCaptureBridgeClosed = Function.prototype.call.bind(MacCaptureBridge.prototype.assertClosed);
module.exports = { MacCaptureBridge, probeCaptureCapabilities, encoderProfile, assertMacCaptureBridgeClosed };
