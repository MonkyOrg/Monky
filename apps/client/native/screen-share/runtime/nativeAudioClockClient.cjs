'use strict';

const { boundedCleanup } = require('./frameSink.cjs');

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const toMicroseconds = value => {
  if (!nonnegative(value) || !Number.isSafeInteger(Math.round(value * 1000))) {
    throw new Error('Invalid renderer clock measurement.');
  }
  return Math.round(value * 1000);
};
const aborted = () => new DOMException('Native audio clock stopped.', 'AbortError');

class NativeAudioClockClient {
  constructor({ epoch, requestProbe, calibrate, sendFeedback, onError,
    now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer), timeoutMs = 1000 }) {
    if (!positive(epoch) || [requestProbe, calibrate, sendFeedback, onError, now, setTimer, clearTimer]
      .some(value => typeof value !== 'function') || !positive(timeoutMs) || timeoutMs > 60000) {
      throw new Error('Native audio calibration requires its epoch and real FIFO control transport.');
    }
    Object.assign(this, { epoch, requestProbe, calibrate, sendFeedback, onError, now, setTimer, clearTimer, timeoutMs });
    this.started = false;
    this.stopped = false;
    this.nextProbeId = 1;
    this.refreshWork = null;
    this.timer = null;
    this.cancelRetry = null;
    this.calibration = null;
    this.lastCalibrationId = 0;
    this.calibrationUnavailableReason = null;
    this.lastRejectedProbe = null;
    this.lastStaleCalibration = null;
    this.lastNowUs = null;
    this.errors = [];
    this.stats = { probes: 0, rejectedProbes: 0, calibrations: 0, staleCalibrations: 0,
      availableFeedback: 0, unavailableFeedback: 0, staleFeedback: 0 };
    this.lastUnavailableReason = 'not-calibrated';
  }

  nowUs() {
    const value = toMicroseconds(this.now());
    if (this.lastNowUs !== null && value < this.lastNowUs) throw new Error('Renderer monotonic clock moved backwards.');
    this.lastNowUs = value;
    return value;
  }

  fail(value) {
    const error = value instanceof Error ? value : new Error(String(value));
    this.errors.push(error);
    this.stop();
    try { this.onError(error); }
    catch (observerError) { console.error('Native clock error observer failed:', observerError); }
  }

  async start() {
    if (this.started || this.stopped) throw new Error('Native audio calibration cannot reuse an output epoch.');
    this.started = true;
    try {
      const deadlineUs = this.nowUs() + this.timeoutMs * 1000;
      while (!(await this.refresh())) {
        if (this.stopped) throw aborted();
        const remainingUs = deadlineUs - this.nowUs();
        if (remainingUs <= 0) throw new Error('Native audio clock could not obtain an admissible startup calibration.');
        await new Promise((resolve, reject) => {
          this.cancelRetry = reject;
          this.timer = this.setTimer(() => {
            this.timer = null;
            this.cancelRetry = null;
            resolve();
          }, Math.min(100, Math.ceil(remainingUs / 1000)));
        });
        if (this.nowUs() >= deadlineUs) throw new Error('Native audio clock could not obtain an admissible startup calibration.');
      }
      if (this.stopped) throw aborted();
      this.schedule();
      return this.getStats();
    } catch (error) {
      if (!(this.stopped && error?.name === 'AbortError')) this.fail(error);
      throw error;
    }
  }

  refresh() {
    if (!this.started || this.stopped) return Promise.reject(aborted());
    if (!this.refreshWork) {
      const work = this.measure();
      this.refreshWork = work;
      void work.then(
        () => { if (this.refreshWork === work) this.refreshWork = null; },
        () => { if (this.refreshWork === work) this.refreshWork = null; },
      );
    }
    return this.refreshWork;
  }

  async measure() {
    if (!positive(this.nextProbeId)) throw new Error('Native audio clock probe IDs are exhausted.');
    const probeId = this.nextProbeId++;
    const rendererBeforeUs = this.nowUs();
    this.stats.probes++;
    const pendingProbe = this.requestProbe({ epoch: this.epoch, probeId });
    if (typeof pendingProbe?.then !== 'function') throw new Error('Native clock probe must return the actual roundtrip Promise.');
    const probe = await boundedCleanup(pendingProbe, 'Native clock probe did not complete.', this.timeoutMs);
    const rendererAfterUs = this.nowUs();
    if (this.stopped) throw aborted();
    if (probe?.epoch !== this.epoch || probe.probeId !== probeId
      || !Number.isSafeInteger(probe.rtcBeforeUs) || probe.rtcBeforeUs < 0
      || !Number.isSafeInteger(probe.rtcAfterUs) || probe.rtcAfterUs < probe.rtcBeforeUs) {
      throw new Error('Native clock probe returned an uncorrelated observation.');
    }
    const rendererRoundtripUs = rendererAfterUs - rendererBeforeUs;
    const rtcSpanUs = probe.rtcAfterUs - probe.rtcBeforeUs;
    if (rtcSpanUs > 20000) throw new Error('Native audio clock observation exceeded its native span bound.');
    const uncertaintyUs = Math.floor((rendererRoundtripUs + rtcSpanUs + 1) / 2) + 16000;
    if (rendererRoundtripUs > 8000 || uncertaintyUs > 20000) {
      // Reject the observation, not the media. Native admission retains these same strict bounds.
      this.stats.rejectedProbes++;
      this.lastRejectedProbe = { probeId, rendererBeforeUs, rendererAfterUs, rendererRoundtripUs,
        rtcBeforeUs: probe.rtcBeforeUs, rtcAfterUs: probe.rtcAfterUs, uncertaintyUs,
        reason: rendererRoundtripUs > 8000 ? 'renderer-roundtrip' : 'combined-uncertainty' };
      this.calibration = null;
      this.lastUnavailableReason = this.calibrationUnavailableReason = 'clock-probe-rejected';
      return false;
    }
    // Only the renderer bracket crosses back; the native side owns its RTC observations.
    const pendingCalibration = this.calibrate({ epoch: this.epoch, probeId, rendererBeforeUs, rendererAfterUs });
    if (typeof pendingCalibration?.then !== 'function') throw new Error('Native calibration must return its actual result Promise.');
    const result = await boundedCleanup(pendingCalibration, 'Native clock calibration did not complete.', this.timeoutMs);
    const receivedAtUs = this.nowUs();
    if (this.stopped) throw aborted();
    if (result?.epoch !== this.epoch || !positive(result.calibrationId)
      || !Number.isFinite(result.offsetUs) || Math.abs(result.offsetUs) > Number.MAX_SAFE_INTEGER
      || !nonnegative(result.uncertaintyUs) || result.uncertaintyUs > 20000
      || result.calibrationId <= this.lastCalibrationId) {
      throw new Error('Native audio calibration is invalid, stale or too uncertain.');
    }
    this.lastCalibrationId = result.calibrationId;
    if (receivedAtUs - rendererBeforeUs > 200000) {
      this.stats.staleCalibrations++;
      this.lastStaleCalibration = { calibrationId: result.calibrationId, rendererBeforeUs, receivedAtUs };
      this.calibration = null;
      this.lastUnavailableReason = this.calibrationUnavailableReason = 'calibration-reply-stale';
      return false;
    }
    this.calibration = {
      id: result.calibrationId, observedAtUs: rendererBeforeUs,
      offsetUs: result.offsetUs, uncertaintyUs: result.uncertaintyUs,
    };
    this.calibrationUnavailableReason = null;
    this.stats.calibrations++;
    return true;
  }

  schedule() {
    if (this.stopped || this.timer !== null) return;
    // Refresh clock calibration, not PCM pacing. Audio credits still come only from the worklet.
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.stopped) return;
      void this.refresh().then(() => this.schedule(), error => {
        if (!(this.stopped && error?.name === 'AbortError')) this.fail(error);
      });
    }, 100);
  }

  feedback(feedback) {
    if (!this.started) throw new Error('Native audio clock has not been started.');
    if (this.stopped) { this.stats.staleFeedback++; return false; }
    if (!positive(feedback?.epoch) || typeof feedback.available !== 'boolean') {
      throw new Error('Native physical feedback has no valid epoch/state.');
    }
    if (feedback.epoch < this.epoch) { this.stats.staleFeedback++; return false; }
    if (feedback.epoch !== this.epoch) throw new Error('Native physical feedback belongs to another output epoch.');
    const nowUs = this.nowUs();
    let payload = { epoch: this.epoch, available: false };
    if (!feedback.available) {
      this.lastUnavailableReason = typeof feedback.reason === 'string' ? feedback.reason : 'output-clock-unavailable';
    } else {
      const atPerformanceTimeUs = toMicroseconds(feedback.atPerformanceTimeMs);
      if (!positive(feedback.clockEpoch) || atPerformanceTimeUs > nowUs
        || !Number.isFinite(feedback.estimatedPlayoutFrame) || Math.abs(feedback.estimatedPlayoutFrame) > Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(feedback.confirmedPcmEnd) || feedback.confirmedPcmEnd < 0
        || feedback.estimatedPlayoutFrame > feedback.confirmedPcmEnd
        || !nonnegative(feedback.feedbackAgeMs) || !nonnegative(feedback.outputClockAgeMs)) {
        throw new Error('Invalid measured native physical audio feedback.');
      }
      // New native calibration can precede its reply. Never send the old ID during that roundtrip.
      if (Math.max(feedback.feedbackAgeMs, feedback.outputClockAgeMs) * 1000 + nowUs - atPerformanceTimeUs > 200000) {
        this.lastUnavailableReason = 'physical-feedback-stale';
      } else if (this.refreshWork) this.lastUnavailableReason = 'calibration-in-progress';
      else if (!this.calibration || nowUs - this.calibration.observedAtUs > 200000) {
        this.lastUnavailableReason = this.calibrationUnavailableReason ?? 'calibration-stale';
      } else {
        payload = {
          epoch: this.epoch, available: true, clockEpoch: feedback.clockEpoch, calibrationId: this.calibration.id,
          atPerformanceTimeUs, estimatedPlayoutFrame: feedback.estimatedPlayoutFrame,
          confirmedPcmEnd: feedback.confirmedPcmEnd,
          feedbackAgeUs: Math.ceil(feedback.feedbackAgeMs * 1000),
          outputClockAgeUs: Math.ceil(feedback.outputClockAgeMs * 1000),
        };
        this.lastUnavailableReason = null;
      }
    }
    if (payload.available) this.stats.availableFeedback++;
    else this.stats.unavailableFeedback++;
    let sent;
    try { sent = this.sendFeedback(payload); }
    catch (error) { this.fail(error); throw error; }
    if (typeof sent?.then === 'function') void sent.catch(error => this.fail(error));
    return sent;
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const cancelRetry = this.cancelRetry;
    this.cancelRetry = null;
    cancelRetry?.(aborted());
    this.calibration = null;
  }

  getStats() {
    return {
      ...this.stats, epoch: this.epoch, stopped: this.stopped, calibrating: this.refreshWork !== null,
      calibrationId: this.calibration?.id ?? null, uncertaintyUs: this.calibration?.uncertaintyUs ?? null,
      lastRejectedProbe: this.lastRejectedProbe && { ...this.lastRejectedProbe },
      lastStaleCalibration: this.lastStaleCalibration && { ...this.lastStaleCalibration },
      lastUnavailableReason: this.lastUnavailableReason, errors: this.errors.map(error => error.message),
    };
  }
}

module.exports = { NativeAudioClockClient };
