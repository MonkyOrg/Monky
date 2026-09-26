'use strict';

const { boundedCleanup } = require('./frameSink.cjs');
const { NativeRtcCommands, isNativeRtcCommandsForEngine, assertNativeRtcEngineClosed } = require('./nativeRtcCommands.cjs');

const owners = new WeakMap();
const invalidationReasons = new Set(['owner-stop', 'engine-close', 'transport-detached', 'setup-failed', 'mixer-failure']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const thenable = value => value !== null && value !== undefined && typeof value.then === 'function';
const asError = value => value instanceof Error ? value : new Error(String(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const aborted = () => {
  const error = new Error('Native audio output was stopped; a new output epoch is required.');
  error.name = 'AbortError';
  return error;
};

function fields(value, names, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(description);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(description);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length
    || names.some(name => !descriptors[name] || !Object.hasOwn(descriptors[name], 'value'))) {
    throw new Error(description);
  }
  return Object.fromEntries(names.map(name => [name, descriptors[name].value]));
}

function requirePromise(value, description) {
  if (!thenable(value)) throw new Error(description);
  return value;
}

function outputFailure(data) {
  const output = fields(data, ['epoch', 'code', 'message', 'status', 'hresult', 'terminal'], 'Malformed native output error.');
  if (!positive(output.epoch) || typeof output.code !== 'string' || !output.code
    || typeof output.message !== 'string' || !output.message
    || !Number.isSafeInteger(output.status) || !Number.isSafeInteger(output.hresult) || output.terminal !== false) {
    throw new Error('Malformed native output error.');
  }
  return Object.assign(new Error(output.message), output);
}

// renderer.start performs the selected-graph handshake through configureOutput;
// enqueue resolves FIFO admission only. No method here owns engine.close or a peer.
class NativeAudioOutputOwner {
  #engine;
  #commands;
  #renderer;
  #onError;
  #timeoutMs;
  #current = null;
  #lastRecord = null;
  #lastEpoch = 0;
  #retiredThrough = 0;
  #engineCloseRequested = false;
  #engineClosed = false;
  #closed = deferred();
  #errors = [];
  #lastClockRejection = null;
  #counts = {
    starts: 0, readyOutputs: 0, retiredOutputs: 0, grantAttempts: 0, acceptedGrants: 0,
    packets: 0, pcmFrames: 0, enqueuedPackets: 0, stalePackets: 0, stoppingPackets: 0,
    staleControls: 0, outputErrors: 0, staleOutputErrors: 0, probes: 0, expiredProbes: 0, calibrations: 0,
    outputInvalidations: 0, staleOutputInvalidations: 0,
    availableFeedback: 0, unavailableFeedback: 0, rejectedClockObservations: 0, errorCount: 0, observerErrors: 0,
  };

  constructor(engine, commands, renderer, onError, { timeoutMs = 5000 } = {}) {
    if (['grantAudioCredits', 'audioClockProbe', 'calibrateAudioClock', 'setAudioOutputFeedback']
      .some(name => typeof engine?.[name] !== 'function')
      || !(commands instanceof NativeRtcCommands)
      || !isNativeRtcCommandsForEngine(commands, engine)
      || commands.engine !== engine
      || ['start', 'stop', 'enqueue'].some(name => typeof renderer?.[name] !== 'function')
      || typeof onError !== 'function' || !positive(timeoutMs) || timeoutMs > 60000) {
      throw new Error('Native audio requires same-engine NativeRtcCommands, a renderer carrier and an error observer.');
    }
    if (owners.has(engine)) throw new Error('One global audio output owner must persist for the lifetime of each engine.');
    this.#engine = engine;
    this.#commands = commands;
    this.#renderer = renderer;
    this.#onError = onError;
    this.#timeoutMs = timeoutMs;
    owners.set(engine, this);
  }

  static isForEngine(owner, engine) {
    return owner !== null && typeof owner === 'object' && #engine in owner && owner.#engine === engine;
  }

  assertStopped(engine) {
    if (engine !== this.#engine || this.#current !== null) {
      throw new Error('The selected native audio output still retains native or renderer ownership.');
    }
  }

  receiveEpoch(engine) {
    if (engine !== this.#engine) throw new Error('Native audio output belongs to a different engine.');
    const record = this.#current;
    return record?.ready && record.nativeConfigured && positive(record.calibrationId)
      && !record.stopping && !this.#engineCloseRequested ? record.epoch : null;
  }

  async start(sinkId, signal) {
    if (typeof sinkId !== 'string' || sinkId.length > 512 || sinkId.includes('\0')
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw new Error('An explicit Chromium sinkId and an optional AbortSignal are required.');
    }
    if (signal?.aborted) throw aborted();
    if (this.#engineCloseRequested) throw new Error('Native engine closure has been requested; output cannot restart.');
    if (this.#current) throw new Error('The previous global audio output still owns startup, native output or renderer retirement.');
    if (!positive(this.#lastEpoch + 1)) throw new Error('Native audio output epochs are exhausted.');
    const record = {
      epoch: ++this.#lastEpoch, config: null, phase: 'starting', ready: false, stopping: false, retired: false,
      controller: new AbortController(), cancellation: deferred(), abortReason: null, externalSignal: signal,
      externalAbort: null, rendererStarted: false, rendererStart: null, rendererStartSettled: false,
      rendererStartDrain: null, rendererRetired: true, rendererStop: null,
      nativeConfig: null, nativeConfigDrain: null, nativeConfigSettled: false, prepareWork: null,
      nativeAttempted: false, nativeConfigured: false, nativeRetired: true, nativeStop: null,
      nativeIdentityUncertain: false, awaitingEngineClose: false, stopWork: null,
      outputInvalidationReason: null,
      creditFrames: 0, lastGrantSequence: 0, grantAdmissionUncertain: false,
      nextSequence: 0, nextPlayoutFrame: 0, enqueues: new Set(), enqueueUncertain: false,
      probes: new Map(), lastProbeId: 0, calibrationId: null, lastCalibrationId: 0, lastClockEpoch: 0,
      pcmSignal: { frames: 0, nonzeroFrames: 0, leftSquareSum: 0, rightSquareSum: 0,
        crossProductSum: 0, leftPeak: 0, rightPeak: 0 },
    };
    record.config = Object.freeze({ epoch: record.epoch, sinkId, sampleRate: 48000, channels: 2 });
    this.#current = this.#lastRecord = record;
    this.#counts.starts++;
    record.rendererStart = Promise.resolve().then(() => {
      this.#assertLive(record);
      record.rendererStarted = true;
      record.rendererRetired = false;
      return requirePromise(this.#renderer.start(record.config, record.controller.signal),
        'Renderer start must return its actual readiness Promise.');
    }).then(result => {
      const ready = fields(result, ['epoch', 'sinkId', 'sampleRate', 'channels'], 'Renderer returned invalid audio readiness.');
      if (Object.keys(ready).some(name => ready[name] !== record.config[name])) {
        throw new Error('Renderer did not prove readiness of the exact selected output.');
      }
      return result;
    });
    record.rendererStartDrain = record.rendererStart.then(
      () => { record.rendererStartSettled = true; this.#continueRetirement(record); },
      error => {
        record.rendererStartSettled = true;
        if (!this.#isCancellation(record, error)) this.#fail(record, error, 'renderer.start');
        this.#continueRetirement(record);
      },
    );
    if (signal) {
      record.externalAbort = () => { this.#stopRecord(record, aborted()); };
      signal.addEventListener('abort', record.externalAbort, { once: true });
    }
    try {
      await this.#duringStartup(record, record.rendererStart, 'Renderer audio readiness timed out; ownership is retained.');
      this.#assertLive(record);
      if (!record.nativeConfig) throw new Error('Renderer readiness omitted the required prepareOutput handshake.');
      await this.#duringStartup(record, record.nativeConfig, 'Native output configuration timed out; ownership is retained.');
      this.#assertLive(record);
      if (!record.nativeConfigured) throw new Error('Native output configuration has not completed.');
      record.ready = true;
      record.phase = 'running';
      this.#counts.readyOutputs++;
      return record.config;
    } catch (value) {
      const error = asError(value);
      if (!record.stopping) this.#fail(record, error, 'start');
      try { await this.#stopRecord(record, error); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native audio startup and retirement failed.'); }
      throw error;
    }
  }

  async configureOutput(data) {
    const { record, payload } = this.#control(data, ['epoch', 'sinkId', 'sampleRate', 'channels'], 'configureOutput');
    try {
      if (!record.rendererStarted || Object.keys(payload).some(name => payload[name] !== record.config[name])) {
        throw new Error('prepareOutput must match the exact renderer startup selection.');
      }
      if (record.prepareWork) return await record.prepareWork;
      // The native operation and renderer startup are separate from wrappers that await cleanup.
      record.nativeConfig = Promise.resolve().then(() => {
        this.#assertLive(record);
        record.nativeAttempted = true;
        record.nativeRetired = false;
        return this.#commands.request('audio.configureOutput', 0, { epoch: record.epoch });
      }).then(result => {
        if (result?.epoch !== record.epoch) record.nativeIdentityUncertain = true;
        const configured = fields(result, ['epoch', 'sampleRate', 'channels'], 'Native returned invalid output configuration.');
        if (configured.epoch !== record.epoch || configured.sampleRate !== 48000 || configured.channels !== 2) {
          throw new Error('Native output configuration does not match its requested epoch and format.');
        }
        return result;
      });
      record.nativeConfigDrain = record.nativeConfig.then(
        () => {
          record.nativeConfigSettled = true;
          if (!this.#engineClosed && record.outputInvalidationReason === null) record.nativeConfigured = true;
          this.#continueRetirement(record);
        },
        error => {
          record.nativeConfigSettled = true;
          if (record.nativeAttempted || !this.#isCancellation(record, error)) this.#fail(record, error, 'native.configure');
          this.#continueRetirement(record);
        },
      );
      record.prepareWork = this.#duringStartup(record, record.nativeConfig,
        'Native output preparation timed out; ownership is retained.').then(result => {
        this.#assertLive(record);
        return result;
      });
      return await record.prepareWork;
    } catch (error) {
      if (!record.stopping) this.#fail(record, error, 'configureOutput');
      throw error;
    }
  }

  grantCredits(data) {
    const { record, payload } = this.#control(data, ['epoch', 'grantSequence', 'frames'], 'grantCredits', true);
    if (!record) return false;
    try {
      this.#assertConfigured(record);
      if (!positive(payload.grantSequence) || payload.grantSequence !== record.lastGrantSequence + 1
        || ![480, 960].includes(payload.frames)
        || record.creditFrames + record.enqueues.size * 480 + payload.frames > 1920) {
        throw new Error('Invalid, duplicate or over-capacity native audio credit.');
      }
      record.lastGrantSequence = payload.grantSequence;
      record.creditFrames += payload.frames;
      this.#counts.grantAttempts++;
      try {
        // Reserve before direct native admission: it can synchronously publish PCM.
        const result = this.#engine.grantAudioCredits(payload);
        return this.#receiveNative(result, record, 'grantCredits', receipt => {
          if (receipt !== undefined) throw new Error('Native audio credit admission must return void.');
          this.#assertLive(record);
          this.#counts.acceptedGrants++;
          return true;
        });
      } catch (error) {
        record.grantAdmissionUncertain = true;
        throw error;
      }
    } catch (error) { this.#fail(record, error, 'grantCredits'); throw error; }
  }

  probe(data) {
    const { record, payload } = this.#control(data, ['epoch', 'probeId'], 'probe');
    try {
      this.#assertConfigured(record);
      if (!positive(payload.probeId) || payload.probeId <= record.lastProbeId || record.probes.size >= 16) {
        throw new Error('Invalid, reused or over-capacity native audio clock probe.');
      }
      record.lastProbeId = payload.probeId;
      record.probes.set(payload.probeId, null);
      const result = this.#engine.audioClockProbe(payload);
      return this.#receiveNative(result, record, 'probe', receipt => {
        const observation = fields(receipt, ['epoch', 'probeId', 'rtcBeforeUs', 'rtcAfterUs'], 'Invalid native clock observation.');
        if (observation.epoch !== record.epoch || observation.probeId !== payload.probeId
          || !nonnegative(observation.rtcBeforeUs) || !nonnegative(observation.rtcAfterUs)
          || observation.rtcAfterUs < observation.rtcBeforeUs
          || observation.rtcAfterUs - observation.rtcBeforeUs > 20000) throw new Error('Uncorrelated native audio clock observation.');
        this.#assertLive(record);
        // OutputClock::Probe expires observations using this same native bracket.
        for (const [id, rtcAfterUs] of record.probes) {
          if (nonnegative(rtcAfterUs) && observation.rtcBeforeUs - rtcAfterUs > 200000) {
            record.probes.delete(id);
            this.#counts.expiredProbes++;
          }
        }
        record.probes.set(payload.probeId, observation.rtcAfterUs);
        this.#counts.probes++;
        return receipt;
      });
    } catch (error) { this.#fail(record, error, 'probe'); throw error; }
  }

  calibrate(data) {
    const { record, payload } = this.#control(data,
      ['epoch', 'probeId', 'rendererBeforeUs', 'rendererAfterUs'], 'calibrate');
    try {
      this.#assertConfigured(record);
      if (!positive(payload.probeId) || !nonnegative(record.probes.get(payload.probeId))
        || !nonnegative(payload.rendererBeforeUs) || !nonnegative(payload.rendererAfterUs)
        || payload.rendererAfterUs < payload.rendererBeforeUs) throw new Error('Calibration requires an owned native probe and real renderer bracket.');
      record.probes.delete(payload.probeId);
      record.calibrationId = null;
      const result = this.#engine.calibrateAudioClock(payload);
      return this.#receiveNative(result, record, 'calibrate', receipt => {
        const calibration = fields(receipt, ['epoch', 'calibrationId', 'offsetUs', 'uncertaintyUs'], 'Invalid native clock calibration.');
        if (calibration.epoch !== record.epoch || !positive(calibration.calibrationId)
          || calibration.calibrationId <= record.lastCalibrationId
          || !Number.isFinite(calibration.offsetUs) || Math.abs(calibration.offsetUs) > Number.MAX_SAFE_INTEGER
          || !Number.isFinite(calibration.uncertaintyUs) || calibration.uncertaintyUs < 0 || calibration.uncertaintyUs > 20000) {
          throw new Error('Uncorrelated or invalid native audio clock calibration.');
        }
        this.#assertLive(record);
        record.calibrationId = record.lastCalibrationId = calibration.calibrationId;
        this.#counts.calibrations++;
        return receipt;
      });
    } catch (error) {
      if (!this.#rejectClockObservation(record, error, 'calibrate')) this.#fail(record, error, 'calibrate');
      throw error;
    }
  }

  feedback(data) {
    const available = Object.getOwnPropertyDescriptor(data ?? {}, 'available')?.value;
    const { record, payload } = this.#control(data, available === true
      ? ['epoch', 'available', 'clockEpoch', 'calibrationId', 'atPerformanceTimeUs', 'estimatedPlayoutFrame',
        'confirmedPcmEnd', 'feedbackAgeUs', 'outputClockAgeUs']
      : ['epoch', 'available'], 'feedback', true);
    if (!record) return false;
    let nativeFeedback = null;
    try {
      this.#assertConfigured(record);
      if (typeof payload.available !== 'boolean') throw new Error('Native audio feedback requires an explicit availability state.');
      if (payload.available && (!positive(payload.clockEpoch) || payload.clockEpoch < record.lastClockEpoch
        || !positive(payload.calibrationId) || payload.calibrationId !== record.calibrationId
        || !nonnegative(payload.atPerformanceTimeUs) || !Number.isFinite(payload.estimatedPlayoutFrame)
        || Math.abs(payload.estimatedPlayoutFrame) > Number.MAX_SAFE_INTEGER
        || !nonnegative(payload.confirmedPcmEnd) || payload.confirmedPcmEnd > record.nextPlayoutFrame
        || payload.estimatedPlayoutFrame > payload.confirmedPcmEnd
        || !nonnegative(payload.feedbackAgeUs) || !nonnegative(payload.outputClockAgeUs))) {
        throw new Error('Invalid or uncalibrated physical native audio feedback.');
      }
      if (payload.available) record.lastClockEpoch = payload.clockEpoch;
      nativeFeedback = { ...payload };
      const result = this.#engine.setAudioOutputFeedback(payload);
      return this.#receiveNative(result, record, 'feedback', receipt => {
        if (receipt !== undefined) throw new Error('Native audio feedback admission must return void.');
        this.#assertLive(record);
        record.lastFeedback = { ...payload };
        this.#counts[payload.available ? 'availableFeedback' : 'unavailableFeedback']++;
        return true;
      }, nativeFeedback);
    } catch (error) {
      if (nativeFeedback) record.rejectedFeedback = nativeFeedback;
      if (nativeFeedback && this.#rejectClockObservation(record, error, 'feedback')) return false;
      this.#fail(record, error, 'feedback');
      throw error;
    }
  }

  handleNativeEvent(event) {
    if (event?.type === 'audio.outputInvalidated') return this.#invalidateOutput(event);
    if (!['audio.playout', 'audio.outputError'].includes(event?.type)) return false;
    const record = this.#current;
    try {
      if (event.target !== 0 || !positive(event.data?.epoch)) throw new Error('Native audio event has an invalid target or epoch.');
      const epoch = event.data.epoch;
      if (epoch <= this.#retiredThrough) {
        this.#counts[event.type === 'audio.playout' ? 'stalePackets' : 'staleOutputErrors']++;
        if (event.type === 'audio.outputError') {
          // Its preceding invalidation can finish cleanup before this diagnostic arrives.
          try { this.#report(outputFailure(event.data), 'audio.outputError', epoch); }
          catch (error) { this.#report(error, 'audio.outputError', epoch); }
        }
        return true;
      }
      if (!record || epoch !== record.epoch) throw new Error('Native audio event belongs to an unconfigured future epoch.');
      if (event.type === 'audio.outputError') {
        const error = outputFailure(event.data);
        this.#counts.outputErrors++;
        this.#fail(record, error, 'audio.outputError');
        return true;
      }
      const packet = fields(event.data, ['epoch', 'sequence', 'firstPlayoutFrame', 'frames', 'sampleRate', 'channels', 'samples'],
        'Malformed native PCM packet.');
      if (!nonnegative(packet.sequence) || !positive(packet.sequence + 1)
        || !nonnegative(packet.firstPlayoutFrame) || !positive(packet.firstPlayoutFrame + 480)
        || packet.frames !== 480 || packet.sampleRate !== 48000 || packet.channels !== 2
        || !(packet.samples instanceof Float32Array) || packet.samples.length !== 960
        || packet.samples.buffer instanceof SharedArrayBuffer) throw new Error('Invalid native PCM format, samples or position.');
      for (const sample of packet.samples) if (!Number.isFinite(sample)) throw new Error('Native PCM contains a non-finite sample.');
      if (record.stopping) { this.#counts.stoppingPackets++; return true; }
      this.#assertConfigured(record);
      if (packet.sequence !== record.nextSequence || packet.firstPlayoutFrame !== record.nextPlayoutFrame
        || record.creditFrames < 480 || record.enqueues.size >= 4) throw new Error('Discontinuous, uncredited or over-capacity native PCM packet.');
      const entry = deferred();
      record.enqueues.add(entry);
      record.creditFrames -= 480;
      record.nextSequence++;
      record.nextPlayoutFrame += 480;
      this.#counts.packets++;
      this.#counts.pcmFrames += 480;
      const signal = record.pcmSignal;
      signal.frames += packet.frames;
      for (let index = 0; index < packet.samples.length; index += 2) {
        const left = packet.samples[index], right = packet.samples[index + 1];
        signal.leftSquareSum += left * left;
        signal.rightSquareSum += right * right;
        signal.crossProductSum += left * right;
        signal.leftPeak = Math.max(signal.leftPeak, Math.abs(left));
        signal.rightPeak = Math.max(signal.rightPeak, Math.abs(right));
        if (left !== 0 || right !== 0) signal.nonzeroFrames++;
      }
      entry.drain = entry.promise.then(
        () => { record.enqueues.delete(entry); this.#counts.enqueuedPackets++; this.#tryRetire(record); },
        error => {
          record.enqueues.delete(entry);
          record.enqueueUncertain = true;
          this.#fail(record, error, 'renderer.enqueue');
          this.#tryRetire(record);
        },
      );
      try {
        entry.resolve(requirePromise(this.#renderer.enqueue(packet), 'Renderer enqueue must return its actual FIFO enqueue Promise.'));
      } catch (error) { entry.reject(error); }
    } catch (error) {
      this.#fail(record, error, event.type);
    }
    return true;
  }

  #invalidateOutput(event) {
    let epoch = null;
    try {
      const envelope = fields(event, ['type', 'target', 'data'], 'Malformed native output invalidation.');
      const output = fields(envelope.data, ['epoch', 'reason'], 'Malformed native output invalidation.');
      if (envelope.target !== 0 || !positive(output.epoch) || !invalidationReasons.has(output.reason)) {
        throw new Error('Invalid native output retirement target, epoch or reason.');
      }
      epoch = output.epoch;
      if (epoch <= this.#retiredThrough) {
        this.#counts.staleOutputInvalidations++;
        return true;
      }
      const record = this.#current;
      if (!record || record.epoch !== epoch) throw new Error('Native output invalidation targets an unallocated epoch.');
      if (record.outputInvalidationReason !== null) return true;
      const expected = record.stopping || (this.#engineCloseRequested && output.reason === 'engine-close');
      const error = Object.assign(new Error(`Native audio output was retired (${output.reason}).`), {
        code: 'ERR_NATIVE_AUDIO_OUTPUT_INVALIDATED', epoch, reason: output.reason,
      });
      record.outputInvalidationReason = output.reason;
      record.nativeConfigured = false;
      this.#counts.outputInvalidations++;
      // Withdraw readiness before observers or the causal ACK; neither is Renderer-close proof.
      this.#stopRecord(record, expected ? aborted() : error);
      if (!expected) this.#report(error, 'audio.outputInvalidated', epoch);
    } catch (error) { this.#report(error, 'audio.outputInvalidated', epoch); }
    return true;
  }

  async stop(epoch = this.#current?.epoch) {
    if (epoch === undefined) return this.getStats();
    if (!positive(epoch) || epoch > this.#lastEpoch) {
      const error = new Error('Cannot stop an invalid or unallocated native audio output epoch.');
      this.#report(error, 'stop', positive(epoch) ? epoch : null);
      throw error;
    }
    if (epoch <= this.#retiredThrough) return false;
    const record = this.#current;
    if (!record || record.epoch !== epoch) throw new Error('The requested native audio output is not owned.');
    record.awaitingEngineClose = false;
    return await this.#stopRecord(record, aborted());
  }

  finishAfterEngineClose(realClosePromise) {
    if (!thenable(realClosePromise)) return Promise.reject(new Error('The actual native engine.close Promise is required.'));
    this.#engineCloseRequested = true;
    const record = this.#current;
    if (record) {
      record.awaitingEngineClose = true;
      this.#markStopping(record, aborted());
    }
    const work = Promise.resolve().then(async () => {
      const proof = boundedCleanup(realClosePromise, 'Native engine close proof timed out; ownership is retained.', this.#timeoutMs)
        .then(() => {
          assertNativeRtcEngineClosed(this.#commands, this.#engine);
          this.#engineClosed = true;
          this.#closed.resolve();
          if (record) this.#retireNativeState(record);
        });
      const results = await Promise.allSettled([
        proof, ...(record ? [this.#retireRenderer(record), this.#drainEnqueues(record)] : []),
      ]);
      if (record) this.#tryRetire(record);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Native engine proof or renderer retirement failed.');
      return this.getStats();
    });
    void work.then(undefined, error => this.#report(error, 'finishAfterEngineClose', record?.epoch ?? null));
    return work;
  }

  #control(data, names, phase, ignoreStale = false) {
    let payload;
    try {
      payload = fields(data, names, `Invalid native audio ${phase} payload.`);
      if (!positive(payload.epoch)) throw new Error('Native audio control has no valid output epoch.');
      const record = this.#current;
      if (payload.epoch <= this.#retiredThrough || (record?.epoch === payload.epoch && record.stopping)) {
        this.#counts.staleControls++;
        if (ignoreStale) return { record: null, payload };
        throw new Error('Native audio control belongs to a stopped or retired epoch.');
      }
      if (!record || payload.epoch !== record.epoch) throw new Error('Native audio control belongs to an unconfigured future epoch.');
      return { record, payload };
    } catch (error) {
      this.#report(error, phase, positive(payload?.epoch) ? payload.epoch : null);
      throw error;
    }
  }

  #assertLive(record) {
    if (record.stopping || this.#current !== record || this.#engineClosed) throw record.abortReason ?? aborted();
  }

  #assertConfigured(record) {
    this.#assertLive(record);
    if (!record.nativeConfigured) throw new Error('Native output must finish prepareOutput before audio credits or clock controls.');
  }

  #isCancellation(record, error) {
    return record.stopping && (error === record.abortReason || error?.name === 'AbortError');
  }

  #duringStartup(record, work, description) {
    return boundedCleanup(Promise.race([
      work, record.cancellation.promise.then(error => { throw error; }),
    ]), description, this.#timeoutMs);
  }

  #requireDirect(result, record, phase) {
    if (!thenable(result)) return;
    void Promise.resolve(result).then(undefined, error => this.#fail(record, error, phase));
    throw new Error('Native audio metadata methods must be synchronous, not synthetic asynchronous acknowledgements.');
  }

  #receiveNative(result, record, phase, accept, feedback = null) {
    if (this.#engine.asynchronousNative !== true) {
      this.#requireDirect(result, record, phase);
      return accept(result);
    }
    if (!thenable(result)) throw new Error('The isolated native operation requires its real child acknowledgement.');
    return Promise.resolve(result).then(accept).catch(error => {
      if (this.#isCancellation(record, error)) {
        if (phase === 'grantCredits' || phase === 'feedback') return false;
        throw error;
      }
      if (phase === 'grantCredits') record.grantAdmissionUncertain = true;
      if (feedback) record.rejectedFeedback = feedback;
      if (['calibrate', 'feedback'].includes(phase) && this.#rejectClockObservation(record, error, phase)) {
        if (phase === 'feedback') return false;
      } else this.#fail(record, error, phase);
      throw error;
    });
  }

  #markStopping(record, reason) {
    if (record.stopping) return;
    record.stopping = true;
    record.ready = false;
    record.phase = 'stopping';
    record.abortReason = asError(reason);
    record.calibrationId = null;
    record.probes.clear();
    record.cancellation.resolve(record.abortReason);
    record.controller.abort(record.abortReason);
    if (record.externalSignal && record.externalAbort) {
      record.externalSignal.removeEventListener('abort', record.externalAbort);
      record.externalAbort = null;
    }
  }

  #stopRecord(record, reason) {
    this.#markStopping(record, reason);
    if (record.retired) return Promise.resolve(this.getStats());
    if (record.stopWork) return record.stopWork;
    const work = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        this.#retireRenderer(record), this.#retireNative(record), this.#drainEnqueues(record),
      ]);
      this.#tryRetire(record);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Native audio output retirement failed; unresolved ownership is retained.');
      if (!record.retired) throw new Error('Native audio output still has unresolved retirement obligations.');
      return this.getStats();
    });
    record.stopWork = work;
    void work.then(
      () => {
        if (record.stopWork === work) record.stopWork = null;
        this.#continueRetirement(record);
      },
      error => {
        if (record.stopWork === work) record.stopWork = null;
        this.#report(error, 'stop', record.epoch);
        this.#continueRetirement(record);
      },
    );
    return work;
  }

  #beginRendererStop(record) {
    if (!record.rendererStarted || record.rendererRetired) return null;
    if (record.rendererStop && !record.rendererStop.settled) return record.rendererStop;
    const attempt = { afterStart: record.rendererStartSettled, settled: false, work: null };
    record.rendererStop = attempt;
    attempt.work = Promise.resolve().then(() => requirePromise(this.#renderer.stop(record.epoch),
      'Renderer stop must return its actual context-retirement Promise.'));
    void attempt.work.then(
      () => {
        attempt.settled = true;
        if (attempt.afterStart) record.rendererRetired = true;
        this.#continueRetirement(record);
      },
      error => { attempt.settled = true; this.#report(error, 'renderer.stop', record.epoch); },
    );
    return attempt;
  }

  async #retireRenderer(record) {
    const first = this.#beginRendererStop(record);
    const results = await Promise.allSettled([
      ...(first ? [boundedCleanup(first.work, 'Renderer output stop timed out; ownership is retained.', this.#timeoutMs)] : []),
      boundedCleanup(record.rendererStartDrain, 'Renderer startup has not drained; output ownership is retained.', this.#timeoutMs),
    ]);
    if (record.rendererStartSettled && record.rendererStarted && !record.rendererRetired
      && first?.settled && !first.afterStart) {
      const final = this.#beginRendererStop(record);
      results.push(...await Promise.allSettled([
        boundedCleanup(final.work, 'Late renderer output stop timed out; ownership is retained.', this.#timeoutMs),
      ]));
    }
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Renderer audio retirement failed.');
  }

  async #retireNative(record) {
    if (this.#engineClosed) { this.#retireNativeState(record); return; }
    if (record.awaitingEngineClose) {
      await boundedCleanup(this.#closed.promise, 'Complete native engine closure is not proven.', this.#timeoutMs);
      this.#retireNativeState(record);
      return;
    }
    if (record.nativeConfig) {
      await boundedCleanup(Promise.race([record.nativeConfigDrain, this.#closed.promise]),
        'Native output configuration has not drained; ownership is retained.', this.#timeoutMs);
    }
    if (this.#engineClosed) { this.#retireNativeState(record); return; }
    if (!record.nativeAttempted || record.nativeRetired) return;
    if (!record.nativeStop || record.nativeStop.settled) {
      const attempt = { settled: false, work: null };
      record.nativeStop = attempt;
      attempt.work = Promise.resolve().then(async () => {
        if (this.#engineClosed) return;
        const result = await this.#commands.request('audio.stopOutput', 0, { epoch: record.epoch });
        fields(result, [], 'Native stopOutput returned no valid retirement result.');
        if (record.nativeIdentityUncertain) throw new Error('Native output identity is uncertain; complete engine closure is required.');
        this.#retireNativeState(record);
      });
      void attempt.work.then(
        () => { attempt.settled = true; this.#tryRetire(record); },
        error => { attempt.settled = true; this.#report(error, 'native.stop', record.epoch); },
      );
    }
    await boundedCleanup(Promise.race([record.nativeStop.work, this.#closed.promise]),
      'Native stopOutput timed out; ownership is retained.', this.#timeoutMs);
  }

  async #drainEnqueues(record) {
    const results = await boundedCleanup(Promise.allSettled([...record.enqueues].map(entry => entry.promise)),
      'Renderer FIFO enqueues have not drained; ownership is retained.', this.#timeoutMs);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Renderer FIFO enqueue retirement failed.');
  }

  #retireNativeState(record) {
    record.nativeRetired = true;
    record.nativeConfigured = false;
    record.creditFrames = 0;
    record.calibrationId = null;
    record.probes.clear();
    this.#tryRetire(record);
  }

  #tryRetire(record) {
    if (record.retired || !record.stopping || !record.rendererStartSettled || !record.rendererRetired
      || !record.nativeRetired || record.enqueues.size !== 0
      || (record.nativeConfig && !record.nativeConfigSettled && !this.#engineClosed)) return;
    record.retired = true;
    record.phase = 'retired';
    this.#retiredThrough = record.epoch;
    this.#counts.retiredOutputs++;
    if (this.#current === record) this.#current = null;
  }

  #continueRetirement(record) {
    this.#tryRetire(record);
    if (!record.stopping || record.retired || record.stopWork) return;
    const lateNative = !record.awaitingEngineClose && !this.#engineClosed && record.nativeConfigSettled
      && record.nativeAttempted && !record.nativeRetired && !record.nativeStop;
    const lateRenderer = record.rendererStartSettled && record.rendererStarted && !record.rendererRetired
      && record.rendererStop?.settled && !record.rendererStop.afterStart;
    if (lateNative || lateRenderer) this.#stopRecord(record, record.abortReason);
  }

  #rejectClockObservation(record, error, phase) {
    if (record.stopping || error?.code !== 'ERR_RTC_AUDIO_CLOCK_OBSERVATION' || error.status !== 8) return false;
    this.#counts.rejectedClockObservations++;
    this.#lastClockRejection = { epoch: record.epoch, phase, code: error.code, message: error.message };
    return true;
  }

  #fail(record, value, phase) {
    const error = asError(value);
    this.#report(error, phase, record?.epoch ?? null);
    if (record && !record.retired) this.#stopRecord(record, error);
  }

  #remember(error, phase, epoch) {
    this.#counts.errorCount++;
    this.#errors.push({ message: error.message, phase, epoch, ...(typeof error.code === 'string' ? { code: error.code } : {}) });
    if (this.#errors.length > 64) this.#errors.shift();
  }

  #report(value, phase, epoch) {
    const error = asError(value);
    this.#remember(error, phase, epoch);
    const observerFailed = failure => {
      const observerError = asError(failure);
      this.#counts.observerErrors++;
      this.#remember(observerError, 'onError', epoch);
      console.error('Native audio output error observer failed:', observerError);
    };
    try {
      const result = this.#onError(error, Object.freeze({ epoch, phase }));
      if (thenable(result)) void Promise.resolve(result).then(undefined, observerFailed);
    } catch (failure) { observerFailed(failure); }
  }

  getStats() {
    const record = this.#current ?? this.#lastRecord;
    const signal = record?.pcmSignal;
    return {
      ...this.#counts, epoch: record?.epoch ?? null, activeEpoch: this.#current?.epoch ?? null,
      lastEpoch: this.#lastEpoch, retiredThrough: this.#retiredThrough, sinkId: record?.config.sinkId ?? null,
      state: this.#engineClosed && !this.#current ? 'closed' : record?.phase ?? 'idle',
      ready: record?.ready ?? false, stopped: this.#current === null,
      engineCloseRequested: this.#engineCloseRequested, engineClosed: this.#engineClosed,
      nativeConfigureAttempted: record?.nativeAttempted ?? false,
      nativeConfigurationPending: Boolean(record?.nativeConfig && !record.nativeConfigSettled),
      nativeConfigured: record?.nativeConfigured ?? false, nativeRetired: record?.nativeRetired ?? true,
      outputInvalidationReason: record?.outputInvalidationReason ?? null,
      rendererStartupPending: Boolean(record && !record.rendererStartSettled), rendererRetired: record?.rendererRetired ?? true,
      pendingEnqueues: record?.enqueues.size ?? 0, outstandingCreditFrames: record?.creditFrames ?? 0,
      reservedFrames: (record?.creditFrames ?? 0) + (record?.enqueues.size ?? 0) * 480,
      lastGrantSequence: record?.lastGrantSequence ?? 0, grantAdmissionUncertain: record?.grantAdmissionUncertain ?? false,
      enqueueUncertain: record?.enqueueUncertain ?? false, nextSequence: record?.nextSequence ?? 0,
      nextPlayoutFrame: record?.nextPlayoutFrame ?? 0, pendingProbes: record?.probes.size ?? 0,
      calibrationId: record?.calibrationId ?? null, errors: this.#errors.map(error => ({ ...error })),
      lastClockRejection: this.#lastClockRejection ? { ...this.#lastClockRejection } : null,
      lastFeedback: record?.lastFeedback ? { ...record.lastFeedback } : null,
      rejectedFeedback: record?.rejectedFeedback ? { ...record.rejectedFeedback } : null,
      pcmSignal: signal ? {
        ...signal, measurementPoint: 'native-mixer-output-before-renderer',
        leftRms: signal.frames ? Math.sqrt(signal.leftSquareSum / signal.frames) : null,
        rightRms: signal.frames ? Math.sqrt(signal.rightSquareSum / signal.frames) : null,
        normalizedCrossCorrelation: signal.leftSquareSum > 0 && signal.rightSquareSum > 0
          ? signal.crossProductSum / Math.sqrt(signal.leftSquareSum * signal.rightSquareSum) : null,
      } : null,
    };
  }
}

const isNativeAudioOutputOwnerForEngine = NativeAudioOutputOwner.isForEngine;
const verifyStopped = Function.prototype.call.bind(NativeAudioOutputOwner.prototype.assertStopped);
const readReceiveEpoch = Function.prototype.call.bind(NativeAudioOutputOwner.prototype.receiveEpoch);
function assertNativeAudioOutputStopped(owner, engine) {
  verifyStopped(owner, engine);
}
function nativeAudioOutputReceiveEpoch(owner, engine) {
  return readReceiveEpoch(owner, engine);
}

module.exports = {
  NativeAudioOutputOwner, isNativeAudioOutputOwnerForEngine, assertNativeAudioOutputStopped, nativeAudioOutputReceiveEpoch,
};
