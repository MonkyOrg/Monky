'use strict';

const assert = require('node:assert/strict');
const STARTUP_BITRATE_KBPS = 150;
const RECOVERY_REASONS = new Set(['rtc-unconsumed', 'input-expired', 'publication-expired', 'codec-expired']);

class LiveSenderFlow {
  constructor({ engine, sourceId, onError, initialBitrateKbps, now = () => performance.now() }) {
    assert.equal(typeof engine?.submitEncodedFrame, 'function');
    assert.ok(Number.isSafeInteger(sourceId) && sourceId > 0);
    assert.equal(typeof onError, 'function');
    assert.ok(Number.isInteger(initialBitrateKbps) && initialBitrateKbps >= 50 &&
      initialBitrateKbps <= 20000 && initialBitrateKbps % 50 === 0);
    Object.assign(this, { engine, sourceId, onError, now });
    this.demand = false; this.connected = false; this.needsIdr = true; this.paused = false;
    this.capturePaused = false;
    this.currentKbps = initialBitrateKbps; this.desiredKbps = initialBitrateKbps; this.lastUpdateAt = -Infinity;
    this.applyingKbps = null;
    this.feedbackSequence = 0; this.waitingSince = null; this.peakRtcArrivalFps = null;
    this.counts = { observed: 0, admitted: 0, notWatched: 0, pausedPackets: 0, awaitingIdr: 0,
      bitrateSettingsUpdates: 0, keyframeRequests: 0, actualIdrsAdmitted: 0, cancelledFeedbackRequests: 0,
      nativeCopiesReleased: 0, inputBackpressure: 0, nativeRecoveryRequests: 0, nativeRecoveryRejections: 0,
      sourcePausedPackets: 0 };
    this.inFlight = new Set();
    this.errors = [];
  }
  fail(error) {
    this.errors.push(error.message); this.onError(error);
  }
  bind(host) {
    assert.equal(this.host, undefined);
    assert.equal(typeof host.setBitrate, 'function'); assert.equal(typeof host.requestKeyFrame, 'function');
    this.host = host; this.scheduleRate();
  }
  setDemand(value) {
    assert.equal(typeof value, 'boolean');
    if (this.demand !== value) { this.needsIdr = true; this.waitingSince = null; }
    this.demand = value;
  }
  setConnected(value) {
    assert.equal(typeof value, 'boolean');
    if (this.connected !== value) { this.needsIdr = true; this.waitingSince = null; }
    this.connected = value;
  }
  setCapturePaused(value) {
    assert.equal(typeof value, 'boolean');
    if (this.capturePaused !== value) { this.needsIdr = true; this.waitingSince = null; }
    this.capturePaused = value;
  }
  feedback(event) {
    if (this.closing) return;
    const data = event.data;
    assert.equal(event.target, this.sourceId); assert.equal(data.sourceId, this.sourceId);
    assert.ok(Number.isSafeInteger(data.sequence) && data.sequence > this.feedbackSequence);
    this.feedbackSequence = data.sequence;
    assert.equal(data.keyframeConfirmed, false);
    if (data.kind === 'keyframe' || data.kind === 'recovery') {
      assert.equal(data.mode, 'next-real-idr'); assert.equal(data.maximumWaitMs, 1500);
      if (data.kind === 'recovery') {
        assert.ok(RECOVERY_REASONS.has(data.reason));
        assert.ok(Number.isSafeInteger(data.frameId) && data.frameId > 0);
        assert.ok(Number.isSafeInteger(data.generation) && data.generation > 0);
        this.counts.nativeRecoveryRequests++; this.lastRecovery = { ...data };
      }
      this.needsIdr = true; this.waitingSince ??= this.now();
      this.requestIdr();
      return;
    }
    assert.ok(data.kind === 'rate' || data.kind === 'encoder-closed');
    assert.equal(data.fpsApplied, null); assert.equal(data.bitrateCeilingBps, 20000000);
    assert.ok(Number.isFinite(data.requestedFps) && data.requestedFps >= 0 && data.requestedFps <= 0xffffffff,
      'RTC arrival-rate estimate is outside the finite uint32 bound.');
    this.peakRtcArrivalFps = Math.max(this.peakRtcArrivalFps ?? 0, data.requestedFps);
    assert.equal(typeof data.paused, 'boolean');
    assert.ok(Number.isInteger(data.bitrateBps) && data.bitrateBps >= 0 && data.bitrateBps <= 20000000);
    if (data.kind === 'encoder-closed' && data.bitrateBps === 0 && !data.paused) {
      // A new codec is initialized by its first frame. No remaining encoder is
      // not a zero-rate network allocation; retain the applied setting for IDR bootstrap.
      this.paused = false; this.needsIdr = true; this.waitingSince = null;
      this.desiredKbps = this.applyingKbps ?? this.currentKbps;
      this.lastFeedback = { ...data, hostSelectedKbps: this.desiredKbps };
      return;
    }
    const selected = Math.floor(data.bitrateBps / 50000) * 50;
    const paused = data.paused || selected < STARTUP_BITRATE_KBPS;
    if (paused !== this.paused) { this.needsIdr = true; this.waitingSince = null; }
    this.paused = paused;
    if (!paused) {
      // Stock AMF Flush/ReInit is costly. Keep 10% headroom and require a
      // 10% increase; an exceeded allocation always wins.
      const reference = this.applyingKbps ?? this.currentKbps;
      const target = Math.max(STARTUP_BITRATE_KBPS, Math.floor(data.bitrateBps * 90 / 5000000) * 50);
      this.desiredKbps = reference > selected || target * 10 >= reference * 11 ? target : reference;
      this.scheduleRate();
    }
    this.lastFeedback = { ...data, allocationKbps: selected, hostSelectedKbps: paused ? null : this.desiredKbps };
  }
  scheduleRate() {
    if (this.closing || !this.host || this.paused || this.rateWork ||
        this.desiredKbps === this.currentKbps) return;
    const reduction = this.desiredKbps < this.currentKbps;
    if (this.rateTimer) {
      if (!reduction) return;
      clearTimeout(this.rateTimer); this.rateTimer = null;
    }
    // Coalesce growth only; never delay a reduction to the current budget.
    const wait = reduction ? 0 : Math.max(0, 1000 - (this.now() - this.lastUpdateAt));
    if (wait > 0) {
      this.rateTimer = setTimeout(() => { this.rateTimer = null; this.scheduleRate(); }, wait);
      return;
    }
    const selected = this.desiredKbps;
    this.applyingKbps = selected;
    const work = (async () => {
      const result = await this.host.setBitrate(selected);
      assert.equal(result.bitrateKbps, selected); assert.equal(result.settingsAccepted, true);
      assert.equal(result.hardwareApplicationConfirmed, false);
      // Already emitted AUs remain a valid chain through Flush/ReInit and its
      // new IDR. RTC paces them; a settings acknowledgement is not a lost frame.
      this.currentKbps = selected; this.lastUpdateAt = this.now(); this.counts.bitrateSettingsUpdates++;
    })();
    this.rateWork = work;
    void work.then(() => {
      this.rateWork = null; this.applyingKbps = null; this.scheduleRate();
    }, error => {
      this.rateWork = null; this.applyingKbps = null;
      if (!this.closing || error.name !== 'AbortError') this.fail(error);
    });
  }
  requestIdr() {
    if (this.closing || !this.host) return Promise.resolve();
    if (this.idrWork) return this.idrWork;
    const work = this.host.requestKeyFrame().then(result => {
      assert.equal(result.mode, 'next-real-idr'); assert.equal(result.keyframeConfirmed, false);
      this.counts.keyframeRequests++;
    });
    this.idrWork = work;
    void work.then(() => { this.idrWork = null; }, error => {
      this.idrWork = null; if (!this.closing || error.name !== 'AbortError') this.fail(error);
    });
    return work;
  }
  packet(frame) {
    if (this.closing || !this.connected || !this.demand) {
      this.counts.observed++; this.counts.notWatched++; this.needsIdr = true; this.waitingSince = null; return;
    }
    assert.deepEqual(this.errors, [], 'Live source admission follows an earlier failure.');
    if (this.capturePaused) {
      this.counts.observed++; this.counts.sourcePausedPackets++; this.needsIdr = true; this.waitingSince = null; return;
    }
    if (this.paused) {
      this.counts.observed++; this.counts.pausedPackets++; this.needsIdr = true; this.waitingSince = null; return;
    }
    if (this.needsIdr && !frame.keyframe) {
      this.waitingSince ??= this.now();
      assert.ok(this.now() - this.waitingSince <= 1500, 'No real IDR arrived within the live recovery bound.');
      this.counts.observed++; this.counts.awaitingIdr++; return;
    }
    if (this.inFlight.size === 16) { this.counts.inputBackpressure++; return false; }
    assert.ok(!this.inFlight.has(frame.frameId), 'An already admitted AU cannot be submitted twice.');
    let result;
    try {
      result = this.engine.submitEncodedFrame(this.sourceId, {
        frameId: frame.frameId, data: frame.data, keyframe: frame.keyframe, timestampUs: frame.timestampUs,
        durationUs: frame.durationUs, ntpTimeMs: frame.ntpTimeMs, pts: frame.pts, dts: frame.dts,
        timebaseNumerator: frame.timebaseNumerator, timebaseDenominator: frame.timebaseDenominator,
      });
    } catch (error) {
      if (error.code === 'ERR_RTC_ENCODED_RECOVERY' && error.status === 8) {
        this.counts.observed++; this.counts.nativeRecoveryRejections++;
        this.needsIdr = true; this.waitingSince ??= this.now();
        assert.ok(this.now() - this.waitingSince <= 1500, 'Native input did not recover through a fresh IDR within1500ms.');
        this.requestIdr();
        return;
      }
      // QUEUE_FULL means no copy was admitted. Keep that AU in the bounded
      // pipe framer until an actual native retirement returns its credit.
      if (error.code !== 'ERR_RTC_ENCODED_INPUT' || error.status !== 3 || !this.inFlight.size) throw error;
      this.counts.inputBackpressure++;
      return false;
    }
    assert.equal(result.copied, true); assert.equal(result.frameId, frame.frameId);
    assert.equal(result.sourceId, this.sourceId); assert.equal(result.networkDeliveryConfirmed, false);
    this.inFlight.add(frame.frameId);
    this.counts.observed++; this.counts.admitted++; if (frame.keyframe) this.counts.actualIdrsAdmitted++;
    this.needsIdr = false; this.waitingSince = null;
  }
  released(event) {
    assert.equal(event.target, this.sourceId); assert.equal(event.data.sourceId, this.sourceId);
    assert.equal(event.data.nativeCopyRetired, true); assert.equal(event.data.networkDeliveryConfirmed, false);
    assert.equal(this.inFlight.delete(event.data.frameId), true, 'Unknown or duplicate native copy retirement.');
    this.counts.nativeCopiesReleased++;
  }
  async close() {
    this.closing = true; clearTimeout(this.rateTimer); this.rateTimer = null;
    const outcomes = await Promise.allSettled([this.rateWork, this.idrWork].filter(Boolean));
    const rejected = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
    this.counts.cancelledFeedbackRequests = rejected.filter(error => error.name === 'AbortError').length;
    const failures = rejected.filter(error => error.name !== 'AbortError');
    if (failures.length) throw new AggregateError(failures, 'Live feedback did not retire cleanly.');
  }
  snapshot() {
    return { ...this.counts, demand: this.demand, connected: this.connected, paused: this.paused, capturePaused: this.capturePaused,
      awaitingRealIdr: this.needsIdr, currentSettingsKbps: this.currentKbps, desiredSettingsKbps: this.desiredKbps,
      bitratePolicy: { targetHeadroomPercent: 10, minimumIncreasePercent: 10 },
      feedback: this.lastFeedback ?? null, errors: [...this.errors], queuedJavaScriptFrames: 0,
      peakRtcArrivalFps: this.peakRtcArrivalFps,
      recovery: this.lastRecovery ?? null,
      retainedNativeCopies: this.inFlight.size,
      transmitterDecoding: false, transmitterReencoding: false, nativeCopyAdmissionIsDeliveryProof: false };
  }
}

module.exports = { LiveSenderFlow, STARTUP_BITRATE_KBPS };
