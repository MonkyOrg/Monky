'use strict';

const { boundedCleanup } = require('./frameSink.cjs');
const { NativeRtcCommands, isNativeRtcCommandsForEngine, assertNativeRtcEngineClosed } = require('./nativeRtcCommands.cjs');
const { NativePcmCaptureHub } = require('./nativePcmCaptureHub.cjs');

const MAX_NATIVE_PACKETS = 8;
// Capture retains each of its 32 delivery credits until every subscriber has
// admitted the packet. Queue occupancy alone cannot bound a TSFN callback burst.
const MAX_PENDING_PACKETS = MAX_NATIVE_PACKETS + 32;

const unsigned = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => unsigned(value) && value > 0;
const text = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0
  && Buffer.byteLength(value, 'utf8') <= 256 && !value.includes('\0');
const cancellation = () => new DOMException('Native PCM capture was cancelled.', 'AbortError');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function nativeFormat(format) {
  if (format?.encoding !== 'float32-interleaved' || !positive(format.sampleRate)
    || !positive(format.channels) || format.channels > 32
    || (format.channelMask !== null && (!unsigned(format.channelMask) || format.channelMask > 0xffffffff))
    || !positive(format.sourceBitsPerSample) || format.sourceBitsPerSample > 64
    || !positive(format.sourceValidBitsPerSample) || format.sourceValidBitsPerSample > format.sourceBitsPerSample) {
    throw new Error('Invalid original PCM capture format.');
  }
  return {
    sampleRate: format.sampleRate, channels: format.channels, channelMask: format.channelMask,
    sourceBitsPerSample: format.sourceBitsPerSample, sourceValidBitsPerSample: format.sourceValidBitsPerSample,
  };
}

function validatePacket(packet, sessionId) {
  nativeFormat(packet?.format);
  if (!text(packet.sessionId) || (sessionId !== null && packet.sessionId !== sessionId)
    || !text(packet.epoch) || !unsigned(packet.sequence) || !unsigned(packet.frameIndex)
    || !positive(packet.frames) || !unsigned(packet.frameIndex + packet.frames)
    || !Buffer.isBuffer(packet.pcm) || packet.pcm.buffer instanceof SharedArrayBuffer
    || packet.pcm.byteLength !== packet.frames * packet.format.channels * 4 || packet.pcm.byteLength > 1048576
    || (packet.qpcTimestampUs !== null && !unsigned(packet.qpcTimestampUs))
    || (packet.devicePosition !== null && !unsigned(packet.devicePosition))
    || !unsigned(packet.flags?.raw) || packet.flags.raw > 0xffffffff
    || ['silent', 'dataDiscontinuity', 'timestampError'].some(key => typeof packet.flags[key] !== 'boolean')
    || (packet.flags.timestampError && (packet.qpcTimestampUs !== null || packet.devicePosition !== null))) {
    throw new Error('Invalid original PCM capture packet.');
  }
}

class NativePcmCaptureBridge {
  constructor(engine, commands, captureModule, onError, { timeoutMs = 12000, captureHub = null } = {}) {
    if (typeof engine?.submitAudioPacket !== 'function' || !(commands instanceof NativeRtcCommands)
      || !isNativeRtcCommandsForEngine(commands, engine) || commands.engine !== engine
      || typeof captureModule?.createPacketCapture !== 'function'
      || typeof onError !== 'function' || !positive(timeoutMs) || timeoutMs > 60000) {
      throw new Error('Native PCM input requires its engine, commands, external packet capture and error observer.');
    }
    Object.assign(this, { engine, commands, captureModule, onError, timeoutMs });
    this.captureHub = captureHub;
    this.started = false;
    this.stopping = false;
    this.enabled = false;
    this.engineRetired = false;
    this.capture = null;
    this.sessionId = null;
    this.sourceId = null;
    this.sourceCreation = null;
    this.sourceClosing = null;
    this.captureStopping = null;
    this.enabling = null;
    this.activation = null;
    this.epoch = null;
    this.lastSequence = null;
    this.lastPacket = null;
    this.previousPacket = null;
    this.packetTail = Promise.resolve();
    this.packets = new Map();
    this.errors = [];
    this.captured = 0;
    this.submitted = 0;
    this.retired = 0;
    this.dropped = 0;
    this.cancelledBeforeAdmission = 0;
    this.maximumOutstanding = 0;
  }

  report(value) {
    const error = value instanceof Error ? value : new Error(String(value));
    this.errors.push(error);
    this.stopAccepting(error);
    this.beginCaptureStop();
    try { this.onError(error); }
    catch (observerError) { console.error('Native PCM capture error observer failed:', observerError); }
  }

  async start(options, syncGroup, signal) {
    signal?.throwIfAborted();
    if (this.started || this.stopping) throw new Error('A native PCM capture bridge cannot be reused.');
    if (!options || typeof options !== 'object' || Array.isArray(options) || !text(syncGroup)
      || Object.keys(options).some(key => !['excludePid', 'includeWindowId', 'expectedProcessId'].includes(key))
      || (options.excludePid !== undefined && options.excludePid !== process.pid)
      || (options.includeWindowId !== undefined && !positive(options.includeWindowId))
      || (options.expectedProcessId !== undefined && (options.includeWindowId === undefined
        || !positive(options.expectedProcessId) || options.expectedProcessId > 0xffffffff))) {
      throw new Error('Invalid native PCM capture selection.');
    }
    this.started = true;
    this.syncGroup = syncGroup;
    this.startup = deferred();
    void this.startup.promise.catch(() => {});
    const abort = () => {
      this.stopAccepting(signal.reason ?? cancellation());
      this.beginCaptureStop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (this.captureHub === null) this.captureHub = new NativePcmCaptureHub(this.captureModule, options, error => {
        if (!this.stopping) this.report(error);
      });
      if (!NativePcmCaptureHub.matches(this.captureHub, this.captureModule, options))
        throw new Error('The native PCM subscriber does not belong to this capture selection and module.');
      this.capture = this.captureHub.subscribe({ ...options }, event =>
        Promise.resolve().then(() => this.onCaptureEvent(event)).catch(error => this.report(error)));
      if (this.capture?.kind !== 'native-pcm-subscription' || typeof this.capture.detach !== 'function'
        || typeof this.capture.getStats !== 'function' || typeof this.capture.ready?.then !== 'function'
        || typeof this.capture.detached?.then !== 'function') {
        throw new Error('Native PCM capture did not return its owned subscription lifecycle.');
      }
      void this.capture.ready.catch(error => {
        if (!this.stopping) this.report(error);
        else this.startup.reject(error);
      });
      void this.capture.detached.then(() => {
        if (!this.stopping) this.report(new Error('Native PCM subscription detached unexpectedly.'));
      }, error => this.report(error));
      if (signal?.aborted) abort();
      return await boundedCleanup(this.startup.promise, 'Native PCM capture startup timed out.', this.timeoutMs);
    } catch (error) {
      this.stopAccepting(error);
      try { await this.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native PCM startup and cleanup failed.'); }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  onCaptureEvent(event) {
    if (event?.type === 'packet') return this.onPacket(event);
    if (event?.type === 'error') throw event.error;
    if (event?.type === 'closed') {
      if (!this.stopping) throw new Error('Native PCM capture closed unexpectedly.');
      return;
    }
    if (event?.type !== 'ready') throw new Error('Unknown native PCM capture event.');
    if (this.stopping) return;
    if (this.sourceCreation || !text(event.sessionId)) throw new Error('Invalid or repeated native PCM readiness.');
    const format = nativeFormat(event.format);
    this.sessionId = event.sessionId;
    this.sourceCreation = this.commands.request('source.createAudio', 0, {
      sessionId: this.sessionId, syncGroup: this.syncGroup, format,
    }).then(async result => {
      if (!positive(result?.sourceId) || result.kind !== 'audio') throw new Error('Native RTC returned an invalid audio source.');
      this.sourceId = result.sourceId;
      if (this.stopping) {
        await this.closeSource();
        throw cancellation();
      }
      const ready = { sourceId: this.sourceId, sessionId: this.sessionId, syncGroup: this.syncGroup, kind: 'audio', format };
      this.startup.resolve(ready);
      return ready;
    });
    void this.sourceCreation.catch(error => {
      if (this.stopping && error?.name === 'AbortError') this.startup.reject(error);
      else this.report(error);
    });
  }

  arm() {
    if (this.stopping || !positive(this.sourceId)) throw new Error('Native PCM source is unavailable.');
    if (!this.enabling) {
      this.activation = deferred();
      this.enabling = this.activation.promise;
      void this.enabling.catch(() => {});
    }
  }

  enable() {
    try { this.arm(); }
    catch (error) { return Promise.reject(error); }
    if (!this.activationWait) {
      this.activationWait = boundedCleanup(this.enabling,
        'Native PCM activation needs its first actual capture epoch.', this.timeoutMs).catch(error => {
        if (!this.stopping) this.report(error);
        throw error;
      });
    }
    return this.activationWait;
  }

  onPacket(packet) {
    validatePacket(packet, this.sessionId);
    this.captured++;
    this.previousPacket = this.lastPacket;
    this.lastPacket = {
      epoch: packet.epoch, sequence: packet.sequence, frameIndex: packet.frameIndex, frames: packet.frames,
      devicePosition: packet.devicePosition, qpcTimestampUs: packet.qpcTimestampUs, flags: packet.flags.raw,
    };
    if (this.lastSequence !== null && packet.sequence <= this.lastSequence) {
      throw new Error('Duplicate or reordered PCM capture packet; earlier processing ownership is retained.');
    }
    this.lastSequence = packet.sequence;
    if (this.stopping || !this.enabling || this.sourceId === null) { this.dropped++; return; }
    if (this.packets.size >= MAX_PENDING_PACKETS)
      throw new Error('Native PCM admission exceeded its bounded capture burst and processing capacity.');
    const retired = deferred();
    const record = {
      key: `${packet.epoch}\0${packet.sequence}`, packet, sourceId: this.sourceId,
      epoch: packet.epoch, sequence: packet.sequence, frameIndex: packet.frameIndex, frames: packet.frames,
      submitted: false, retired: retired.promise, resolveRetired: retired.resolve,
    };
    this.packets.set(record.key, record);
    this.maximumOutstanding = Math.max(this.maximumOutstanding, this.packets.size);
    const queued = this.packetTail.then(() => this.submit(record));
    this.packetTail = queued.catch(error => {
      if (!record.submitted) this.retire(record);
      if (!record.submitted && this.stopping && error?.code === 'ERR_RTC_CANCELLED') {
        this.cancelledBeforeAdmission++;
        return;
      }
      this.report(error);
    });
    // This acknowledges admission/copy only. The distinct native processing
    // receipt remains owned in this.packets until it has actually retired.
    return this.packetTail;
  }

  async submit(record) {
    if (this.stopping) { this.retire(record); return; }
    const processing = [...this.packets.values()].filter(value => value.submitted);
    if (processing.length >= MAX_NATIVE_PACKETS) {
      await boundedCleanup(Promise.race(processing.map(value => value.retired)),
        'Native PCM processing did not return its admission credit.', this.timeoutMs);
      if (this.stopping) { this.retire(record); return; }
    }
    if (this.epoch !== record.epoch) {
      // Reset only at an actual capture epoch, after prior native processing is accounted for.
      const previous = [...this.packets.values()].filter(value => value.submitted && value.epoch !== record.epoch);
      await boundedCleanup(Promise.all(previous.map(value => value.retired)),
        'Prior native PCM processing has not retired.', this.timeoutMs);
      if (this.stopping) { this.retire(record); return; }
      const packet = record.packet;
      const result = await this.commands.request('source.beginAudioEpoch', record.sourceId, {
        epoch: record.epoch, firstSequence: record.sequence, firstFrameIndex: record.frameIndex,
        format: nativeFormat(packet.format),
      });
      if (result?.sourceId !== record.sourceId || result.epoch !== record.epoch) {
        throw new Error('Native PCM epoch acknowledgement does not match its source.');
      }
      this.epoch = record.epoch;
    }
    if (this.stopping) { this.retire(record); return; }
    if (!this.enabled) {
      const result = await this.commands.request('source.setEnabled', record.sourceId, { enabled: true });
      if (result?.enabled !== true) throw new Error('Native audio source did not confirm activation.');
      if (this.stopping) { this.retire(record); return; }
      this.enabled = true;
      this.activation.resolve(true);
    }
    record.submitted = true;
    this.submitted++;
    let completed;
    try {
      completed = this.engine.submitAudioPacket(record.sourceId, record.packet);
      if (typeof completed?.then !== 'function') throw new Error('Native PCM input did not return a processing Promise.');
    } catch (error) {
      this.rejectInput(record, error);
      return;
    } finally {
      // Direct N-API copies synchronously; the process adapter first serializes
      // its bounded IPC copy. Either way this caller no longer lends JS memory.
      record.packet = null;
    }
    void completed.then(result => {
      if (result?.ok !== true || !this.matches(record, result)) {
        this.report(new Error('Native PCM retirement has no matching processing identity.'));
        return;
      }
      this.retire(record);
    }, error => this.rejectInput(record, error));
  }

  matches(record, value) {
    return value?.sourceId === record.sourceId && value.epoch === record.epoch
      && value.sequence === record.sequence && value.frameIndex === record.frameIndex && value.frames === record.frames;
  }

  rejectInput(record, error) {
    if (error?.nativeOwnershipRetained === false && error.processingPending === false && this.matches(record, error)) {
      this.retire(record);
    }
    this.report(error);
  }

  retire(record) {
    if (this.packets.get(record.key) !== record) return;
    this.packets.delete(record.key);
    record.packet = null;
    if (record.submitted) this.retired++;
    else this.dropped++;
    record.resolveRetired();
  }

  stopAccepting(reason = cancellation()) {
    this.stopping = true;
    this.enabled = false;
    this.startup?.reject(reason);
    this.activation?.reject(reason);
  }

  beginCaptureStop() {
    if (!this.captureStopping && this.capture) {
      const stopping = Promise.resolve().then(() => this.capture.detach());
      this.captureStopping = stopping;
      void stopping.catch(error => {
        if (this.captureStopping === stopping) this.captureStopping = null;
        this.errors.push(error instanceof Error ? error : new Error(String(error)));
        try { this.onError(error); }
        catch (observerError) { console.error('Native PCM stop observer failed:', observerError); }
      });
    }
    return this.captureStopping ?? Promise.resolve();
  }

  closeSource() {
    if (this.engineRetired) { this.sourceId = null; return Promise.resolve(); }
    if (this.sourceId === null) return Promise.resolve();
    if (!this.sourceClosing) {
      this.sourceClosing = this.commands.request('resource.close', this.sourceId, {}).then(result => {
        this.sourceId = null;
        return result;
      }, error => { this.sourceClosing = null; throw error; });
    }
    return this.sourceClosing;
  }

  async stop() {
    this.stopAccepting();
    await boundedCleanup(this.beginCaptureStop(), 'Native PCM capture stop is still pending.', this.timeoutMs);
    if (this.sourceCreation) await boundedCleanup(Promise.allSettled([this.sourceCreation]),
      'Native audio source creation remains pending.', this.timeoutMs);
    if (this.enabling) await boundedCleanup(Promise.allSettled([this.enabling]),
      'Native audio source activation remains pending.', this.timeoutMs);
    await boundedCleanup(this.closeSource(), 'Native audio source close remains pending.', this.timeoutMs);
    await boundedCleanup(this.packetTail, 'Native PCM admission queue remains pending.', this.timeoutMs);
    await boundedCleanup(Promise.all([...this.packets.values()].map(record => record.retired)),
      'Native PCM processing retirement remains unproven.', this.timeoutMs);
    return this.getStats();
  }

  async finishAfterEngineClose(closed) {
    if (typeof closed?.then !== 'function') throw new Error('Native PCM needs the complete engine-close Promise.');
    this.stopAccepting();
    await closed;
    assertNativeRtcEngineClosed(this.commands, this.engine);
    this.engineRetired = true;
    for (const record of this.packets.values()) this.retire(record);
    this.sourceId = null;
    return this.stop();
  }

  getStats() {
    return {
      kind: 'native-pcm-capture', sessionId: this.sessionId, sourceId: this.sourceId, epoch: this.epoch,
      enabled: this.enabled, armed: this.enabling !== null && !this.stopping,
      stopping: this.stopping, engineRetired: this.engineRetired,
      captured: this.captured, submitted: this.submitted, retired: this.retired, dropped: this.dropped,
      cancelledBeforeAdmission: this.cancelledBeforeAdmission,
      outstanding: this.packets.size, queued: [...this.packets.values()].filter(record => !record.submitted).length,
      maximumOutstanding: this.maximumOutstanding, capture: this.capture?.getStats().capture ?? null,
      subscription: this.capture?.getStats() ?? null,
      lastPacket: this.lastPacket ? { ...this.lastPacket } : null,
      previousPacket: this.previousPacket ? { ...this.previousPacket } : null,
      errors: this.errors.map(error => error.message),
    };
  }
}

module.exports = { NativePcmCaptureBridge, MAX_NATIVE_PACKETS, MAX_PENDING_PACKETS };
