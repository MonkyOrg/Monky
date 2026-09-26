'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ObsHostBridge } = require('./captureProcess.cjs');
const protocol = require('./capturePackets.cjs');

class CaptureBridge extends ObsHostBridge {
  constructor(options, dependencies = {}) {
    const { host, runtime, runId, runDirectory, onPacket, onNotice } = options;
    assert.equal(host?.kind, 'verified-native-screen-capture-host');
    assert.ok(path.isAbsolute(runDirectory));
    assert.equal(path.basename(runDirectory), `monky-screen-capture-${runId}`);
    const video = Object.freeze(protocol.normalizedVideo(options.video));
    const encoder = protocol.validateEncoder(options.encoder ?? 'auto');
    const bitrateCeilingKbps = options.bitrateCeilingKbps ?? 80000;
    assert.ok(Number.isSafeInteger(bitrateCeilingKbps) && bitrateCeilingKbps >= video.bitrateKbps
      && bitrateCeilingKbps <= 80000 && bitrateCeilingKbps % 50 === 0, 'Invalid capture bitrate ceiling.');
    assert.equal(typeof onPacket, 'function'); assert.equal(typeof onNotice, 'function');
    let owner;
    super({
      ...options,
      protocol: { ...protocol, maxLineBytes: protocol.MAX_LINE_BYTES, allowUnpreparedStop: true,
        validateMessage: (message, expected) => protocol.validateMessage(message, { ...expected, video, encoder }),
        errorDetails: message => message.error },
      argumentsForSource: (source, id) => [
        `--runtime=${runtime.stockDirectory}`, `--run-directory=${runDirectory}`, `--run-id=${id}`,
        ...protocol.argumentsForTarget(source), ...(source.kind || encoder !== 'auto' ? [`--encoder=${encoder}`] : []),
        `--width=${video.width}`,
        `--height=${video.height}`, `--fps=${video.fps}`, `--bitrate=${video.bitrateKbps}`,
        `--scale-mode=${video.scaleMode}`,
        ...(encoder === 'obs_nvenc_av1_tex' ? [`--bitrate-ceiling=${bitrateCeilingKbps}`] : []),
      ],
      validateRetirement: bridge => {
        const terminal = bridge.stopped ?? bridge.failure;
        for (const field of protocol.RETIREMENT_FIELDS) assert.equal(terminal?.retirement[field], true);
        assert.equal(bridge.liveEof, true); assert.ok(bridge.liveFrames.closed);
        assert.equal(bridge.liveFrames.closed.packets, terminal.observation.outputPackets);
        assert.equal(Object.hasOwn(terminal, 'recording'), false);
      },
    }, {
      ...dependencies, deadlines: { stop: 20000, ...dependencies.deadlines },
      spawnProcess(executable, args, spawnOptions) {
        const child = (dependencies.spawnProcess ?? spawn)(executable, args,
          { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
        owner.attachLive(child);
        return child;
      },
    });
    owner = this; this.onPacket = onPacket; this.onNotice = onNotice;
    this.bitrateCeilingKbps = bitrateCeilingKbps;
    this.isSourcePaused = options.isSourcePaused ?? null;
    assert.ok(this.isSourcePaused === null || typeof this.isSourcePaused === 'function');
    this.liveSequence = 0; this.liveRequests = new Map(); this.liveEof = false;
    this.liveFrames = new protocol.LiveFrames(message => this.receiveLive(message), video.fps);
  }

  observeRequest(promise, verb) {
    if (verb !== 'start' || !this.isSourcePaused) return super.observeRequest(promise, verb);
    return new Promise((resolve, reject) => {
      let timer, settled = false, activeMs = 0, last = this.now(), wasPaused = true;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); callback(value);
      };
      const sample = () => {
        if (settled) return;
        try {
          const now = this.now(), paused = this.isSourcePaused();
          if (!paused && !wasPaused) activeMs += now - last;
          last = now; wasPaused = paused;
          if (activeMs >= this.deadlines.start)
            throw Object.assign(new Error(this.source?.kind === 'game'
              ? 'Game Capture produced no frames. Keep game protections/Trusted Mode enabled and explicitly select the same window in WGC instead.'
              : 'OBS host start acknowledgement timed out while the selected window was available.'),
            { code: this.source?.kind === 'game' ? 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE' : 'ERR_SCREEN_CAPTURE_FIRST_AU_TIMEOUT' });
          timer = setTimeout(sample, 50);
        } catch (error) { finish(reject, error); }
      };
      void promise.then(value => finish(resolve, value), error => finish(reject, error));
      sample();
    });
  }

  attachLive(child) {
    assert.ok(child.stdio[3]?.readable && child.stdio[4]?.writable, 'Live inherited pipes are missing.');
    this.bind(child.stdio[3], 'data', bytes => {
      try {
        if (!this.liveFrames.push(bytes)) {
          this.packetBackpressured = true;
          child.stdio[3].pause();
        }
      } catch (error) { this.fail(error); }
    });
    this.bind(child.stdio[3], 'end', () => {
      try { this.liveFrames.end(); this.liveEof = true; } catch (error) { this.fail(error); }
    });
    this.bind(child.stdio[3], 'error', error => this.fail(error));
    this.bind(child.stdio[4], 'error', error => { if (!this.processExit) this.fail(error); });
    this.bind(child, 'close', () => {
      for (const request of this.liveRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new DOMException('Live feedback owner exited.', 'AbortError'));
      }
      this.liveRequests.clear();
    });
  }

  receiveLive(message) {
    if (message.type === 'packet') {
      assert.ok(this.liveHello, 'Live AU preceded host identity.');
      const result = this.onPacket(this.prepared?.configuration?.codec === 'av1'
        ? { ...message.frame, codec: 'av1' } : message.frame);
      assert.ok(result === undefined || result === false, 'Live AU admission must be synchronous, without a JS frame queue.');
      return result;
    }
    const value = message.value;
    if (value.kind === 'hello') {
      assert.equal(this.liveHello, undefined);
      assert.equal(value.runId, this.runId); assert.equal(value.processId, this.child.pid);
      assert.equal(value.protocol, 1); assert.equal(value.transmitterReencode, false);
      assert.equal(value.timestampSemantics, 'obs-system-pts');
      this.liveHello = value;
    } else if (message.type === 'closed') {
      assert.equal(value.runId, this.runId);
      if (value.failure !== undefined && value.failure !== null) {
        protocol.validateFailure(value.failure);
        this.nativeError ??= Object.assign(new Error(value.failure.message), { code: value.failure.code });
        this.fail(this.nativeError);
      } else if (!this.stopping) {
        this.fail(Object.assign(new Error('The native capture host stopped its media pipe without STOP.'),
          { code: 'ERR_SCREEN_CAPTURE_UNEXPECTED_STOP' }));
      }
    } else {
      assert.ok(value.kind === 'idr-request' || value.kind === 'bitrate-settings', 'Unknown live host notice.');
      const request = this.liveRequests.get(value.sequence);
      assert.ok(request, 'Unsolicited live feedback acknowledgement.');
      if (value.kind === 'bitrate-settings') {
        assert.equal(request.verb, 'bitrate'); assert.equal(value.bitrateKbps, request.value);
        assert.equal(value.settingsAccepted, true); assert.equal(value.hardwareApplicationConfirmed, false);
        assert.equal(value.fpsApplied, null);
      } else {
        assert.equal(request.verb, 'idr'); assert.equal(value.keyframeConfirmed, false);
        assert.equal(value.mode, 'next-real-idr'); assert.equal(value.maximumWaitMs, 1500);
      }
      this.liveRequests.delete(value.sequence); clearTimeout(request.timer); request.resolve(value);
    }
    assert.equal(this.onNotice(value), undefined, 'Live metadata observers must not create an unbounded async queue.');
  }

  feedback(verb, value) {
    assert.ok(verb === 'bitrate' || verb === 'idr');
    assert.ok(this.prepared && this.child && !this.stopping && !this.firstError && this.liveHello);
    assert.ok(this.liveSequence < Number.MAX_SAFE_INTEGER && this.liveRequests.size < 4, 'Capture feedback queue exceeded its bound.');
    if (verb === 'bitrate') assert.ok(Number.isInteger(value) && value >= 50 && value <= 80000 && value % 50 === 0);
    else assert.equal(value, 0);
    const sequence = ++this.liveSequence, stream = this.child.stdio[4];
    assert.ok(stream.writableLength < 4096, 'Live feedback pipe is backpressured.');
    return new Promise((resolve, reject) => {
      const request = { verb, value, resolve, reject, timer: null };
      request.timer = setTimeout(() => {
        this.liveRequests.delete(sequence);
        const error = new Error('OBS live feedback acknowledgement exceeded2s.');
        reject(error); this.fail(error);
      }, 2000);
      this.liveRequests.set(sequence, request);
      stream.write(`${sequence} ${verb} ${value}\n`, error => {
        if (!error) return;
        clearTimeout(request.timer); this.liveRequests.delete(sequence); reject(error); this.fail(error);
      });
    });
  }
  setBitrate(bitrateKbps) {
    assert.ok(bitrateKbps <= this.bitrateCeilingKbps, 'Live bitrate exceeds the capture ceiling.');
    return this.feedback('bitrate', bitrateKbps);
  }
  requestKeyFrame() { return this.feedback('idr', 0); }

  // Preparation proves the pinned probe/texture configuration, not successful
  // transmission. Only READY proves an initialized hardware session produced H264.
  getCapabilities() {
    if (!this.prepared?.capability) return null;
    return Object.freeze({ ...this.prepared.capability,
      mode: protocol.ENCODERS[this.prepared.capability.encoderId].mode,
      hardwareSessionConfirmed: protocol.ENCODERS[this.prepared.capability.encoderId].mode === 'hardware' &&
        this.events.ready === 1, hardwareQualified: false });
  }

  resumePackets() {
    if (!this.packetBackpressured) return;
    if (this.liveFrames.drain()) {
      this.packetBackpressured = false;
      this.child.stdio[3].resume();
    }
  }

  stop() {
    if (this.liveStopTask) return this.liveStopTask;
    for (const request of this.liveRequests.values()) {
      clearTimeout(request.timer); request.reject(new DOMException('Live host feedback stopped.', 'AbortError'));
    }
    this.resumePackets();
    this.liveStopTask = super.stop().catch(error => {
      // A media error is not proof that teardown failed. Keep that error, but
      // independently verify native retirement before displaying capture OFF.
      try {
        assert.equal(this.closed, true); assert.notEqual(this.forcedTermination, true);
        assert.deepEqual(this.exit, { code: this.failure ? 1 : 0, signal: null });
        assert.deepEqual(this.processExit, this.exit);
        assert.deepEqual(this.eof, { stdout: true, stderr: true });
        this.validateRetirement(this);
      } catch (retirementError) {
        throw new AggregateError([this.nativeError ?? error, retirementError],
          'Live host failure and native retirement could not both be accounted for.');
      }
      this.nativeClosed = true; this.closeReason = this.failure ? 'failed' : 'requested-after-error';
      if (!this.nativeError && error.name === 'AbortError' && this.signal?.aborted && this.signal.reason?.name === 'AbortError') {
        this.cancelled = true;
        return this.snapshot();
      }
      throw this.nativeError ?? error;
    });
    return this.liveStopTask;
  }

  snapshot() {
    const snapshot = super.snapshot();
    return { ...snapshot,
      capability: this.getCapabilities(),
      cancelled: this.cancelled === true, live: { hello: this.liveHello ?? null, packets: this.liveFrames.packets,
      lastPacket: this.liveFrames.lastFrame ?? null, closed: this.liveFrames.closed ?? null,
      eof: this.liveEof, pendingFeedback: this.liveRequests.size, feedbackCommands: this.liveSequence,
      packetBackpressured: this.packetBackpressured === true, framingBufferedBytes: this.liveFrames.pending.length,
      queuedJavaScriptFrames: 0 } };
  }
}

function validateProbeRetirement(bridge) {
  assert.equal(bridge.closed, true);
  assert.notEqual(bridge.forcedTermination, true, 'Forced termination is not verified encoder-probe retirement.');
  assert.deepEqual(bridge.exit, { code: bridge.failure ? 1 : 0, signal: null });
  assert.deepEqual(bridge.processExit, bridge.exit);
  assert.deepEqual(bridge.eof, { stdout: true, stderr: true });
  const terminal = bridge.stopped ?? bridge.failure;
  assert.ok(terminal, 'Encoder probe ended without terminal retirement evidence.');
  for (const field of protocol.RETIREMENT_FIELDS) assert.equal(terminal.retirement[field], true);
  assert.equal(terminal.sourceCaptured, false); assert.equal(terminal.outputPackets, 0);
}

// Initializes, but never starts, a hardware encoder. The caller owns the same
// private nonce-bound run directory as CaptureBridge, including its cleanup.
async function probeCaptureCapabilities(options, signal, dependencies = {}) {
  protocol.exact(options, ['host', 'runtime', 'runId', 'runDirectory', 'video',
    ...(Object.hasOwn(options, 'encoder') ? ['encoder'] : [])], 'source-free encoder probe options');
  const { host, runtime, runId, runDirectory } = options;
  assert.equal(host?.kind, 'verified-native-screen-capture-host');
  assert.ok(path.isAbsolute(runDirectory) && path.isAbsolute(runtime?.stockDirectory));
  assert.equal(path.basename(runDirectory), `monky-screen-capture-${runId}`);
  const video = Object.freeze(protocol.normalizedVideo(options.video));
  const encoder = protocol.validateEncoder(options.encoder ?? 'auto');
  let failure;
  const bridge = new ObsHostBridge({
    host, runtime, runId, onError: error => { failure ??= error; },
    protocol: {
      maxLineBytes: protocol.MAX_LINE_BYTES, allowUnpreparedStop: true,
      validateSource: source => { assert.equal(source, null, 'Encoder probing cannot select a source.'); },
      cloneSource: () => null,
      validateMessage: (message, expected) => protocol.validateEncoderProbeMessage(message, { ...expected, video, encoder }),
      validateProgress: protocol.validateEncoderProbeProgress,
      errorDetails: message => message.error,
      command: (sequence, verb) => {
        assert.equal(verb, 'stop', 'Encoder probing cannot issue a capture command.');
        return protocol.command(sequence, verb);
      },
    },
    argumentsForSource: () => [
      `--runtime=${runtime.stockDirectory}`, `--run-directory=${runDirectory}`, `--run-id=${runId}`,
      '--probe=encoder', `--encoder=${encoder}`, `--width=${video.width}`, `--height=${video.height}`,
      `--fps=${video.fps}`, `--bitrate=${video.bitrateKbps}`,
      `--scale-mode=${video.scaleMode}`,
      ...(encoder === 'obs_nvenc_av1_tex' ? [`--bitrate-ceiling=${video.bitrateKbps}`] : []),
    ],
    validateRetirement: validateProbeRetirement,
  }, { ...dependencies, deadlines: { stop: 20000, ...dependencies.deadlines } });
  let prepared, preparationError;
  try { prepared = await bridge.prepare(null, signal); }
  catch (error) { preparationError = error instanceof Error ? error : new Error(String(error)); }
  try { await bridge.stop(); }
  catch (stopError) {
    if (bridge.spawnFailed) throw preparationError ?? failure ?? stopError;
    try { validateProbeRetirement(bridge); }
    catch (retirementError) {
      throw new AggregateError([preparationError ?? failure ?? stopError, retirementError],
        'Encoder probe failure and native retirement could not both be accounted for.');
    }
    throw preparationError ?? failure ?? stopError;
  }
  if (preparationError) throw preparationError;
  if (failure) throw failure;
  assert.equal(prepared?.encoderInitialized, true);
  return Object.freeze({
    ...prepared.capability, mode: protocol.ENCODERS[prepared.capability.encoderId].mode,
    encoderInitialized: true, hardwareSessionConfirmed: false,
    hardwareQualified: false, sourceCaptured: false,
    captureKinds: Object.freeze([...prepared.captureKinds]), video,
  });
}

module.exports = { CaptureBridge, probeCaptureCapabilities };
