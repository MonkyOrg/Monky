'use strict';

class NativePcmPlayoutQueue {
  constructor({ epoch, capacityFrames = 1920, targetFrames = 960 } = {}) {
    if (!Number.isSafeInteger(epoch) || epoch < 1
      || !Number.isInteger(capacityFrames) || capacityFrames < 1440 || capacityFrames > 4800
      || !Number.isInteger(targetFrames) || targetFrames < 960 || targetFrames + 480 > capacityFrames
      || targetFrames % 480 !== 0) {
      throw new Error('Invalid bounded native PCM playout configuration.');
    }
    this.channels = 2;
    this.sampleRate = 48000;
    this.blockFrames = 480;
    this.capacityFrames = capacityFrames;
    this.targetFrames = targetFrames;
    this.ring = new Float32Array(capacityFrames * this.channels);
    this.clockEpoch = 0;
    this.stats = { acceptedFrames: 0, renderedFrames: 0, silenceFrames: 0,
      underruns: 0, stalePackets: 0, discardedFrames: 0,
      contextDiscontinuities: 0, skippedContextFrames: 0, repeatedContextFrames: 0 };
    this.beginEpoch(epoch);
  }

  beginEpoch(epoch) {
    this.epoch = epoch;
    this.clockEpoch++;
    this.state = 'buffering';
    this.available = 0;
    this.reserved = 0;
    this.writeOffset = 0;
    this.readOffset = 0;
    this.nextSequence = null;
    this.nextWriteFrame = null;
    this.nextReadFrame = null;
    this.lastContextFrame = null;
    this.lastContextEnd = null;
    this.contextStalled = false;
    this.grantSequence = 0;
    this.ring.fill(0);
  }

  reset(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) {
      throw new Error('Native playout reset requires a new monotonic epoch.');
    }
    this.stats.discardedFrames += this.available;
    this.beginEpoch(epoch);
  }

  stop() {
    this.stats.discardedFrames += this.available;
    this.available = 0;
    this.reserved = 0;
    this.state = 'stopped';
    this.nextReadFrame = null;
    this.ring.fill(0);
  }

  reject(code, message) {
    this.stop();
    this.state = 'failed';
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  reserveCredits() {
    if (this.state === 'failed' || this.state === 'stopped') return null;
    // Refill before a whole 10 ms block is missing; native mixing and IPC need that headroom.
    const frames = Math.ceil((this.targetFrames - this.available - this.reserved) / this.blockFrames)
      * this.blockFrames;
    if (frames <= 0) return null;
    this.reserved += frames;
    return { epoch: this.epoch, grantSequence: ++this.grantSequence, frames };
  }

  enqueue(packet) {
    if (this.state === 'stopped' || this.state === 'failed') {
      this.stats.stalePackets++;
      return false;
    }
    if (!packet || !Number.isSafeInteger(packet.epoch) || packet.epoch < 1) {
      this.reject('ERR_NATIVE_AUDIO_PACKET', 'Native PCM packet has no valid epoch.');
    }
    if (packet.epoch < this.epoch) {
      this.stats.stalePackets++;
      return false;
    }
    if (packet.epoch !== this.epoch) {
      this.reject('ERR_NATIVE_AUDIO_EPOCH', 'Native PCM arrived before its playout epoch was configured.');
    }
    if (!Number.isSafeInteger(packet.sequence) || packet.sequence < 0
      || !Number.isSafeInteger(packet.sequence + 1)
      || !Number.isSafeInteger(packet.firstPlayoutFrame) || packet.firstPlayoutFrame < 0
      || !Number.isSafeInteger(packet.firstPlayoutFrame + this.blockFrames)
      || packet.sampleRate !== this.sampleRate || packet.channels !== this.channels
      || packet.frames !== this.blockFrames || !(packet.samples instanceof Float32Array)
      || packet.samples.length !== this.blockFrames * this.channels
      || !(packet.samples.buffer instanceof ArrayBuffer)) {
      this.reject('ERR_NATIVE_AUDIO_PACKET', 'Invalid native 10 ms stereo PCM packet.');
    }
    if (this.nextSequence !== null && (packet.sequence !== this.nextSequence
      || packet.firstPlayoutFrame !== this.nextWriteFrame)) {
      this.reject('ERR_NATIVE_AUDIO_SEQUENCE', 'Native PCM playout sequence or sample position is discontinuous.');
    }
    if (this.reserved < packet.frames || this.available + packet.frames > this.capacityFrames) {
      this.reject('ERR_NATIVE_AUDIO_CREDIT', 'Native PCM arrived without bounded playout credit.');
    }
    for (const sample of packet.samples) {
      if (!Number.isFinite(sample)) this.reject('ERR_NATIVE_AUDIO_SAMPLE', 'Native PCM contains a non-finite sample.');
    }
    for (let index = 0; index < packet.samples.length; index++) {
      this.ring[this.writeOffset] = packet.samples[index];
      this.writeOffset = (this.writeOffset + 1) % this.ring.length;
    }
    if (this.nextReadFrame === null) this.nextReadFrame = packet.firstPlayoutFrame;
    this.nextSequence = packet.sequence + 1;
    this.nextWriteFrame = packet.firstPlayoutFrame + packet.frames;
    this.reserved -= packet.frames;
    this.available += packet.frames;
    this.stats.acceptedFrames += packet.frames;
    return true;
  }

  render(output, contextFrame) {
    if (!Array.isArray(output) || output.length !== this.channels
      || !(output[0] instanceof Float32Array) || !(output[1] instanceof Float32Array)
      || output[0].length !== output[1].length || output[0].length < 1
      || output[0].length > this.blockFrames
      || !Number.isSafeInteger(contextFrame) || contextFrame < 0
      || !Number.isSafeInteger(contextFrame + output[0].length)) {
      this.reject('ERR_NATIVE_AUDIO_QUANTUM', 'Invalid native audio render quantum.');
    }
    const frames = output[0].length;
    output[0].fill(0);
    output[1].fill(0);
    const repeated = contextFrame === this.lastContextFrame;
    const gap = this.lastContextEnd !== null && contextFrame > this.lastContextEnd;
    if (this.lastContextEnd !== null && contextFrame < this.lastContextEnd && !repeated) {
      this.reject('ERR_NATIVE_AUDIO_CLOCK',
        `AudioContext sample clock regressed: expected ${this.lastContextEnd}, observed ${contextFrame}.`);
    }
    let underrun = false;
    if ((repeated || gap) && this.state !== 'stopped' && this.state !== 'failed') {
      if (repeated) this.stats.repeatedContextFrames += frames;
      if (gap) this.stats.skippedContextFrames += contextFrame - this.lastContextEnd;
      // Chromium can skip its try-locked currentFrame update while the graph advances.
      // Withdraw the anchor once; keep in-flight credits and buffer until a real advance.
      if (!this.contextStalled) {
        this.stats.contextDiscontinuities++;
        this.stats.discardedFrames += this.available;
        this.stats.underruns++;
        this.clockEpoch++;
        this.state = 'buffering';
        this.available = 0;
        this.readOffset = this.writeOffset;
        this.nextReadFrame = this.nextWriteFrame;
        this.ring.fill(0);
        underrun = true;
      }
    }
    this.lastContextFrame = contextFrame;
    this.lastContextEnd = contextFrame + frames;
    this.contextStalled = repeated;
    let firstPlayoutFrame = null, mediaFrames = 0;
    if (this.state === 'buffering' && !repeated && this.available >= this.targetFrames) this.state = 'running';
    if (this.state === 'running') {
      if (this.available < frames) {
        this.state = 'buffering';
        this.clockEpoch++;
        this.stats.underruns++;
        underrun = true;
      } else {
        firstPlayoutFrame = this.nextReadFrame;
        for (let index = 0; index < frames; index++) {
          for (let channel = 0; channel < this.channels; channel++) {
            output[channel][index] = this.ring[this.readOffset];
            this.readOffset = (this.readOffset + 1) % this.ring.length;
          }
        }
        this.available -= frames;
        this.nextReadFrame += frames;
        this.stats.renderedFrames += frames;
        mediaFrames = frames;
      }
    }
    this.stats.silenceFrames += frames - mediaFrames;
    return {
      epoch: this.epoch, clockEpoch: this.clockEpoch, state: this.state,
      contextFrame, frames, firstPlayoutFrame, mediaFrames, underrun,
      queuedFrames: this.available, outstandingFrames: this.reserved,
    };
  }

  snapshot() {
    return { ...this.stats, epoch: this.epoch, clockEpoch: this.clockEpoch, state: this.state,
      queuedFrames: this.available, outstandingFrames: this.reserved,
      capacityFrames: this.capacityFrames, targetFrames: this.targetFrames };
  }
}

if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
  class NativePcmPlayoutProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      if (sampleRate !== 48000) throw new Error('Native PCM playout requires a 48 kHz AudioContext.');
      this.queue = new NativePcmPlayoutQueue(options.processorOptions);
      this.feedbackFrames = 0;
      this.failed = false;
      this.port.onmessage = event => {
        if (this.failed) return;
        try {
          const message = event.data;
          if (message?.type === 'pcm') this.queue.enqueue(message.packet);
          else if (message?.type === 'reset' || message?.type === 'stop') {
            if (!Number.isSafeInteger(message.epoch) || message.epoch < 1) {
              throw new Error('Native PCM control has no valid epoch.');
            }
            if (message.type === 'reset' && message.epoch > this.queue.epoch) {
              this.queue.reset(message.epoch);
              this.feedbackFrames = 0;
            } else if (message.type === 'stop' && message.epoch === this.queue.epoch) {
              this.queue.stop();
            }
          } else {
            throw new Error('Unknown native PCM playout message.');
          }
        } catch (error) { this.fail(error); }
      };
    }

    fail(error) {
      this.failed = true;
      this.queue.stop();
      this.port.postMessage({ type: 'error',
        code: typeof error?.code === 'string' ? error.code : 'ERR_NATIVE_AUDIO_PLAYOUT',
        message: error instanceof Error ? error.message : String(error) });
    }

    process(_inputs, outputs) {
      if (this.failed || this.queue.state === 'stopped') {
        for (const output of outputs) for (const channel of output) channel.fill(0);
        return false;
      }
      try {
        const feedback = this.queue.render(outputs[0], currentFrame);
        const credit = this.queue.reserveCredits();
        if (credit) this.port.postMessage({ type: 'credits', ...credit });
        this.feedbackFrames += feedback.frames;
        if (feedback.underrun || this.feedbackFrames >= this.queue.blockFrames) {
          this.feedbackFrames %= this.queue.blockFrames;
          // This anchors rendered graph samples, not their physical speaker time.
          const playout = this.queue.snapshot();
          this.port.postMessage({ type: 'feedback', ...feedback,
            outstandingFrames: playout.outstandingFrames, playout });
        }
      } catch (error) {
        for (const output of outputs) for (const channel of output) channel.fill(0);
        this.fail(error);
        return false;
      }
      return true;
    }
  }
  registerProcessor('native-pcm-playout', NativePcmPlayoutProcessor);
}

if (typeof module !== 'undefined') module.exports = { NativePcmPlayoutQueue };
