'use strict';

class NativeAudioOutputClock {
  constructor({ epoch, now = () => performance.now(), maximumAgeMs = 200 }) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || typeof now !== 'function'
      || !Number.isFinite(maximumAgeMs) || maximumAgeMs < 1 || maximumAgeMs > 1000) {
      throw new Error('Invalid native audio output clock configuration.');
    }
    this.epoch = epoch;
    this.now = now;
    this.maximumAgeMs = maximumAgeMs;
    this.latest = null;
    this.lastAccepted = null;
    this.lastUnavailableReason = 'no-render-anchor';
    this.regressedObservations = 0;
  }

  reset(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) {
      throw new Error('Audio output clock reset requires a new epoch.');
    }
    this.epoch = epoch;
    this.latest = null;
    this.lastAccepted = null;
    this.lastUnavailableReason = 'no-render-anchor';
  }

  update(feedback) {
    if (!feedback || !Number.isSafeInteger(feedback.epoch) || feedback.epoch < 1) {
      throw new Error('Invalid native audio feedback epoch.');
    }
    if (feedback.epoch < this.epoch) return false;
    if (feedback.epoch !== this.epoch || !Number.isSafeInteger(feedback.clockEpoch) || feedback.clockEpoch < 1
      || !['buffering', 'running', 'stopped', 'failed'].includes(feedback.state)
      || !Number.isSafeInteger(feedback.contextFrame) || feedback.contextFrame < 0
      || !Number.isInteger(feedback.frames) || feedback.frames < 1 || feedback.frames > 480
      || !Number.isInteger(feedback.queuedFrames) || feedback.queuedFrames < 0 || feedback.queuedFrames > 4800) {
      throw new Error('Invalid native audio sample-clock feedback.');
    }
    const running = feedback.state === 'running';
    if ((running && (!Number.isSafeInteger(feedback.firstPlayoutFrame) || feedback.firstPlayoutFrame < 0
      || feedback.mediaFrames !== feedback.frames
      || !Number.isSafeInteger(feedback.firstPlayoutFrame + feedback.frames + feedback.queuedFrames)))
      || (!running && (feedback.firstPlayoutFrame !== null || feedback.mediaFrames !== 0))) {
      throw new Error('Native audio feedback does not describe a valid PCM render anchor.');
    }
    if (this.latest && (feedback.clockEpoch < this.latest.clockEpoch
      || (feedback.clockEpoch === this.latest.clockEpoch && feedback.contextFrame <= this.latest.contextFrame))) {
      return false;
    }
    const receivedAt = this.now();
    if (!Number.isFinite(receivedAt) || receivedAt < 0
      || (this.latest && receivedAt < this.latest.receivedAt)) {
      throw new Error('Invalid browser monotonic clock.');
    }
    this.latest = {
      epoch: feedback.epoch, clockEpoch: feedback.clockEpoch, state: feedback.state,
      contextFrame: feedback.contextFrame, frames: feedback.frames,
      firstPlayoutFrame: feedback.firstPlayoutFrame, queuedFrames: feedback.queuedFrames, receivedAt,
    };
    return true;
  }

  sample(context) {
    const unavailable = reason => {
      this.lastUnavailableReason = reason;
      return { available: false, epoch: this.epoch, reason };
    };
    if (!this.latest) return unavailable('no-render-anchor');
    if (this.latest.state !== 'running') return unavailable(this.latest.state);
    if (context.state !== 'running') return unavailable('context-not-running');
    if (typeof context.getOutputTimestamp !== 'function') return unavailable('output-clock-unavailable');
    if (context.sampleRate !== 48000) return unavailable('incompatible-output-format');
    const timestamp = context.getOutputTimestamp();
    const now = this.now();
    if (!Number.isFinite(now) || now < this.latest.receivedAt) return unavailable('browser-clock-discontinuity');
    if (now - this.latest.receivedAt > this.maximumAgeMs) return unavailable('stale-render-feedback');
    if (!Number.isFinite(timestamp?.contextTime) || timestamp.contextTime < 0
      || !Number.isFinite(timestamp.performanceTime) || timestamp.performanceTime < 0
      || (timestamp.contextTime === 0 && timestamp.performanceTime === 0)
      || timestamp.performanceTime > now) {
      return unavailable('invalid-output-clock');
    }
    if (now - timestamp.performanceTime > this.maximumAgeMs) return unavailable('stale-output-clock');
    const contextFrame = (timestamp.contextTime + (now - timestamp.performanceTime) / 1000) * 48000;
    const estimatedPlayoutFrame = this.latest.firstPlayoutFrame + contextFrame - this.latest.contextFrame;
    const knownQueuedEnd = this.latest.firstPlayoutFrame + this.latest.frames + this.latest.queuedFrames;
    // Do not extrapolate past PCM actually queued: an unseen underrun may follow it.
    if (!Number.isFinite(estimatedPlayoutFrame) || estimatedPlayoutFrame > knownQueuedEnd) {
      return unavailable('beyond-confirmed-pcm');
    }
    if (this.lastAccepted?.clockEpoch === this.latest.clockEpoch
      && (Math.round(now * 1000) <= Math.round(this.lastAccepted.atPerformanceTimeMs * 1000)
        || estimatedPlayoutFrame < this.lastAccepted.estimatedPlayoutFrame
        || knownQueuedEnd < this.lastAccepted.confirmedPcmEnd)) {
      // The physical output estimate may regress while the device settles.
      // Withdraw the measurement; never clamp its cursor or invent an epoch.
      this.regressedObservations++;
      return unavailable('regressing-output-clock');
    }
    this.lastAccepted = {
      clockEpoch: this.latest.clockEpoch, atPerformanceTimeMs: now, estimatedPlayoutFrame,
      confirmedPcmEnd: knownQueuedEnd,
    };
    this.lastUnavailableReason = null;
    return {
      available: true, epoch: this.epoch, clockEpoch: this.latest.clockEpoch,
      atPerformanceTimeMs: now, estimatedPlayoutFrame, confirmedPcmEnd: knownQueuedEnd,
      renderAnchor: { firstPlayoutFrame: this.latest.firstPlayoutFrame, contextFrame: this.latest.contextFrame },
      outputContextTime: timestamp.contextTime, outputPerformanceTimeMs: timestamp.performanceTime,
      feedbackAgeMs: now - this.latest.receivedAt, outputClockAgeMs: now - timestamp.performanceTime,
    };
  }

  getStats() {
    return {
      epoch: this.epoch, regressedObservations: this.regressedObservations,
      lastUnavailableReason: this.lastUnavailableReason,
      lastAccepted: this.lastAccepted ? { ...this.lastAccepted } : null,
    };
  }
}

module.exports = { NativeAudioOutputClock };
