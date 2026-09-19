'use strict';

const { boundedCleanup } = require('./frameSink.cjs');
const { NativeAudioOutputClock } = require('./nativeAudioOutputClock.cjs');

class NativePcmAudioSink {
  constructor({ epoch, sinkId, workletUrl, prepareOutput, onCredits, onFeedback, onError,
    createContext = options => new AudioContext(options),
    createWorklet = (context, options) => new AudioWorkletNode(context, 'native-pcm-playout', options),
    now = () => performance.now(), timeoutMs = 5000 }) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || typeof sinkId !== 'string' || sinkId.length > 512
      || typeof workletUrl !== 'string' || workletUrl.length < 1 || workletUrl.length > 4096
      || [prepareOutput, onCredits, onFeedback, onError, createContext, createWorklet, now]
        .some(value => typeof value !== 'function')
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      throw new Error('Invalid native audio presentation configuration.');
    }
    this.epoch = epoch;
    this.sinkId = sinkId;
    this.workletUrl = workletUrl;
    this.prepareOutput = prepareOutput;
    this.startAbort = new AbortController();
    this.preparingOutput = false;
    this.onCredits = onCredits;
    this.onFeedback = onFeedback;
    this.onError = onError;
    this.createContext = createContext;
    this.createWorklet = createWorklet;
    this.timeoutMs = timeoutMs;
    this.clock = new NativeAudioOutputClock({ epoch, now });
    this.started = false;
    this.ready = false;
    this.stopping = false;
    this.context = null;
    this.node = null;
    this.closeWork = null;
    this.contextClosed = false;
    this.disconnected = false;
    this.portClosed = false;
    this.lastGrant = 0;
    this.creditFrames = 0;
    this.nextSequence = null;
    this.nextPlayoutFrame = null;
    this.stats = { acceptedFrames: 0, stalePackets: 0, outputSamples: 0 };
    this.playout = null;
    this.lastUnderrun = null;
    this.errors = [];
    this.onStateChange = () => {
      if (!this.stopping && (this.ready || this.preparingOutput) && this.context?.state !== 'running') {
        this.fail(new Error('Native audio output stopped; a new playout epoch is required before resuming.'));
      }
    };
    this.onSinkChange = () => {
      if (!this.stopping && (this.ready || this.preparingOutput)) {
        this.fail(new Error('Native audio output changed; recreate its clock and playout epoch.'));
      }
    };
  }

  notify(callback, value) {
    try {
      const result = callback(value);
      if (result && typeof result.then === 'function') void result.catch(error => this.fail(error));
    } catch (error) { this.fail(error); }
  }

  fail(value) {
    const error = value instanceof Error ? value : new Error(String(value));
    this.errors.push(error);
    if (this.stopping) return;
    this.stopping = true;
    try { this.onError(error); }
    catch (observerError) { console.error('Native audio error observer failed:', observerError); }
    void this.stop().catch(cleanupError => {
      this.errors.push(cleanupError);
      console.error('Native audio cleanup failed:', cleanupError);
    });
  }

  assertStarting() {
    if (this.stopping) throw new DOMException('Native audio presentation was cancelled.', 'AbortError');
  }

  async start() {
    if (this.started || this.stopping) throw new Error('A native audio sink cannot be reused.');
    this.started = true;
    try {
      const context = this.createContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.context = context;
      if (context.sampleRate !== 48000 || typeof context.setSinkId !== 'function'
        || typeof context.getOutputTimestamp !== 'function' || typeof context.audioWorklet?.addModule !== 'function') {
        throw new Error('Native audio requires an exact 48 kHz graph, selectable output and a physical output clock.');
      }
      context.addEventListener('statechange', this.onStateChange);
      context.addEventListener('sinkchange', this.onSinkChange);
      await context.setSinkId(this.sinkId);
      this.assertStarting();
      if (context.sinkId !== this.sinkId) throw new Error('Native audio did not select the requested output device.');
      await context.audioWorklet.addModule(this.workletUrl);
      this.assertStarting();
      await context.resume();
      this.assertStarting();
      if (context.state !== 'running') throw new Error('Native audio output did not start.');
      this.preparingOutput = true;
      try {
        await this.prepareOutput({ epoch: this.epoch, sinkId: this.sinkId, sampleRate: 48000, channels: 2 },
          this.startAbort.signal);
      } finally { this.preparingOutput = false; }
      this.assertStarting();
      if (context.state !== 'running') throw new Error('Native audio output stopped during preparation.');
      this.node = this.createWorklet(context, {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
        channelCountMode: 'explicit', processorOptions: { epoch: this.epoch, capacityFrames: 1920, targetFrames: 960 },
      });
      this.node.port.onmessage = event => {
        if (this.stopping) return;
        try { this.handleMessage(event.data); }
        catch (error) { this.fail(error); }
      };
      this.node.onprocessorerror = () => this.fail(new Error('Native PCM AudioWorklet processing failed.'));
      this.node.connect(context.destination);
      this.ready = true;
      return { epoch: this.epoch, sinkId: this.sinkId, sampleRate: 48000, channels: 2 };
    } catch (error) {
      try { await this.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native audio startup and cleanup failed.'); }
      throw error;
    }
  }

  handleMessage(message) {
    if (message?.type === 'error') {
      const error = new Error(typeof message.message === 'string' ? message.message : 'Native PCM playout failed.');
      error.code = message.code;
      throw error;
    }
    if (!Number.isSafeInteger(message?.epoch) || message.epoch < 1) throw new Error('Native audio feedback has no epoch.');
    if (message.epoch < this.epoch) return;
    if (message.epoch !== this.epoch) throw new Error('Native audio feedback belongs to an unconfigured future epoch.');
    if (message.type === 'credits') {
      if (!Number.isSafeInteger(message.grantSequence) || message.grantSequence !== this.lastGrant + 1
        || !Number.isInteger(message.frames) || message.frames < 480 || message.frames > 960
        || message.frames % 480 !== 0 || this.creditFrames + message.frames > 960) {
        throw new Error('Native PCM playout granted invalid or duplicate credit.');
      }
      this.lastGrant = message.grantSequence;
      this.creditFrames += message.frames;
      this.notify(this.onCredits, { epoch: this.epoch, grantSequence: message.grantSequence, frames: message.frames });
    } else if (message.type === 'feedback') {
      if (!this.clock.update(message)) return;
      this.observePlayout(message);
      this.stats.outputSamples++;
      this.notify(this.onFeedback, this.clock.sample(this.context));
    } else {
      throw new Error('Unknown native PCM worklet feedback.');
    }
  }

  observePlayout(message) {
    if (!Object.hasOwn(message, 'playout')) return;
    const value = message.playout;
    const counters = ['acceptedFrames', 'renderedFrames', 'silenceFrames', 'underruns', 'stalePackets', 'discardedFrames',
      'contextDiscontinuities', 'skippedContextFrames'];
    const numbers = [...counters, 'epoch', 'clockEpoch', 'queuedFrames', 'outstandingFrames', 'capacityFrames', 'targetFrames'];
    if (!value || numbers.some(name => !Number.isSafeInteger(value[name]) || value[name] < 0)
      || value.epoch !== this.epoch || value.clockEpoch !== message.clockEpoch || value.state !== message.state
      || value.queuedFrames !== message.queuedFrames || value.outstandingFrames !== message.outstandingFrames
      || value.capacityFrames !== 1920 || value.targetFrames !== 960 || value.outstandingFrames > 960
      || value.queuedFrames + value.outstandingFrames > value.capacityFrames
      || value.acceptedFrames > this.stats.acceptedFrames || value.acceptedFrames % 480 !== 0
      || value.acceptedFrames !== value.renderedFrames + value.queuedFrames + value.discardedFrames
      || typeof message.underrun !== 'boolean'
      || (message.underrun && (value.state !== 'buffering' || value.underruns < 1))
      || (this.playout && counters.some(name => value[name] < this.playout[name]))) {
      throw new Error('Invalid native worklet playout diagnostics.');
    }
    this.playout = {
      ...Object.fromEntries(numbers.map(name => [name, value[name]])), state: value.state,
      contextFrame: message.contextFrame, observedAtPerformanceTimeMs: this.clock.latest.receivedAt,
    };
    if (message.underrun) this.lastUnderrun = { ...this.playout };
  }

  acceptPacket(packet) {
    if (this.stopping) { this.stats.stalePackets++; return false; }
    if (!Number.isSafeInteger(packet?.epoch) || packet.epoch < 1) throw new Error('Native PCM packet has no epoch.');
    if (packet.epoch < this.epoch) { this.stats.stalePackets++; return false; }
    if (packet.epoch !== this.epoch || !this.node
      || !Number.isSafeInteger(packet.sequence) || packet.sequence < 0 || !Number.isSafeInteger(packet.sequence + 1)
      || !Number.isSafeInteger(packet.firstPlayoutFrame) || packet.firstPlayoutFrame < 0
      || !Number.isSafeInteger(packet.firstPlayoutFrame + 480)
      || packet.frames !== 480 || packet.sampleRate !== 48000 || packet.channels !== 2
      || !(packet.samples instanceof Float32Array) || packet.samples.length !== 960
      || !(packet.samples.buffer instanceof ArrayBuffer) || this.creditFrames < 480
      || (this.nextSequence !== null && (packet.sequence !== this.nextSequence || packet.firstPlayoutFrame !== this.nextPlayoutFrame))) {
      throw new Error('Invalid or uncredited native PCM output packet.');
    }
    for (const sample of packet.samples) if (!Number.isFinite(sample)) throw new Error('Native PCM contains a non-finite sample.');
    const samples = new Float32Array(packet.samples);
    this.node.port.postMessage({
      type: 'pcm',
      packet: { epoch: this.epoch, sequence: packet.sequence, firstPlayoutFrame: packet.firstPlayoutFrame,
        frames: 480, sampleRate: 48000, channels: 2, samples },
    }, [samples.buffer]);
    this.creditFrames -= 480;
    this.nextSequence = packet.sequence + 1;
    this.nextPlayoutFrame = packet.firstPlayoutFrame + 480;
    this.stats.acceptedFrames += 480;
    return true;
  }

  sampleClock() {
    if (this.stopping || !this.context) return { available: false, epoch: this.epoch, reason: 'stopped' };
    return this.clock.sample(this.context);
  }

  async stop() {
    this.stopping = true;
    this.startAbort.abort(new DOMException('Native audio output preparation was cancelled.', 'AbortError'));
    this.ready = false;
    if (!this.closeWork) {
      const closing = this.cleanup();
      this.closeWork = closing;
      void closing.catch(() => { if (this.closeWork === closing) this.closeWork = null; });
    }
    await this.closeWork;
    return this.getStats();
  }

  async cleanup() {
    const failures = [];
    if (this.node && !this.portClosed) {
      this.node.port.onmessage = null;
      this.node.onprocessorerror = null;
      try { this.node.port.postMessage({ type: 'stop', epoch: this.epoch }); }
      catch (error) { failures.push(error); }
      try { this.node.port.close(); this.portClosed = true; }
      catch (error) { failures.push(error); }
    }
    if (this.node && !this.disconnected) {
      try { this.node.disconnect(); this.disconnected = true; }
      catch (error) { failures.push(error); }
    }
    if (this.context && !this.contextClosed) {
      this.context.removeEventListener('statechange', this.onStateChange);
      this.context.removeEventListener('sinkchange', this.onSinkChange);
      try {
        if (this.context.state !== 'closed') await boundedCleanup(this.context.close(),
          'Native AudioContext close timed out; output ownership is retained.', this.timeoutMs);
        if (this.context.state !== 'closed') throw new Error('Native AudioContext did not prove closed output.');
        this.contextClosed = true;
      } catch (error) { failures.push(error); }
    }
    this.notify(this.onFeedback, { available: false, epoch: this.epoch, reason: 'stopped' });
    if (failures.length) throw new AggregateError(failures, 'Native audio presentation cleanup failed.');
  }

  getStats() {
    return {
      ...this.stats, epoch: this.epoch, sinkId: this.sinkId, ready: this.ready,
      stopped: this.contextClosed || (this.stopping && this.context === null),
      outstandingCreditFrames: this.creditFrames, errors: this.errors.map(error => error.message),
      playout: this.playout && { ...this.playout }, lastUnderrun: this.lastUnderrun && { ...this.lastUnderrun },
      outputClock: this.clock.getStats(),
    };
  }
}

module.exports = { NativePcmAudioSink };
