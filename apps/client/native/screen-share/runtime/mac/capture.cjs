'use strict';
const assert = require('node:assert/strict');
const { failure } = require('./host.cjs');
const { acquireMacHost } = require('./hostPool.cjs');
const { validateMacTarget } = require('./target.cjs');
const { normalizedVideo } = require('../captureProtocol.cjs');

class MacVideoCapture {
  constructor({ target, video, mode, codec = 'h264', onPacket, onError, directory }, dependencies = {}) {
    assert.ok(mode === 'hardware' || mode === 'software');
    assert.ok(codec === 'h264' || codec === 'av1' && mode === 'software');
    assert.equal(typeof onPacket, 'function');
    assert.equal(typeof onError, 'function');
    this.target = validateMacTarget(target);
    this.video = Object.freeze({ ...normalizedVideo(video), mode, codec });
    this.errors = [];
    this.onError = onError;
    this.firstFrame = new Promise((resolve, reject) => {
      this.firstReady = resolve; this.firstFailed = reject;
    });
    void this.firstFrame.catch(() => {});
    const runtime = dependencies.runtime ?? require('./index.cjs').loadMacCaptureRuntime(directory);
    const options = {
      onVideo: frame => {
        if (this.closing) return;
        assert.equal(frame.codec, codec, 'Native capture must not substitute the admitted codec.');
        this.firstReady();
        return onPacket(frame);
      },
      onError: error => {
        this.firstFailed(error);
        if (this.errors.length < 16) this.errors.push(error);
        try { onError(error); } catch (observerError) { console.error('[MacVideoCapture] Error observer failed:', observerError); }
      },
    };
    this.host = (dependencies.hostFactory ?? acquireMacHost)(
      runtime.executable, options);
  }
  start({ signal } = {}) {
    assert.equal(this.started, undefined, 'Native capture cannot restart an old owner.');
    this.started = true;
    this.starting = (async () => {
      const abort = () => this.host.fail(new DOMException('Native capture was cancelled.', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => this.host.fail(failure('ERR_MAC_CAPTURE_FIRST_FRAME',
        'Native macOS capture produced no first access unit.')), 15000);
      try {
        signal?.throwIfAborted();
        const result = await this.host.request('media.start', { target: this.target, video: this.video }, signal);
        assert.equal(result.value.captureStarted, true);
        assert.deepEqual(result.value.source, this.target);
        assert.deepEqual(result.value.video, this.video);
        await this.firstFrame;
        signal?.throwIfAborted();
        if (this.host.failure) throw this.host.failure;
        assert.ok(!this.closing);
        return { codec: this.video.codec, mode: this.video.mode, firstAccessUnitObserved: true,
          hardwareSessionConfirmed: this.video.mode === 'hardware' };
      } catch (error) {
        await this.close();
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    })();
    return this.starting;
  }
  async setBitrate(bitrateKbps) {
    assert.ok(!this.closing && this.started);
    assert.ok(Number.isSafeInteger(bitrateKbps) && bitrateKbps >= 50 && bitrateKbps <= 80000 && bitrateKbps % 50 === 0);
    const { value } = await this.host.request('media.bitrate', { bitrateKbps });
    assert.equal(value.bitrateKbps, bitrateKbps);
    assert.equal(value.settingsAccepted, true);
    assert.equal(value.hardwareApplicationConfirmed, false);
    assert.equal(value.fpsApplied, null);
    return value;
  }
  async requestKeyFrame() {
    assert.ok(!this.closing && this.started);
    const { value } = await this.host.request('media.keyframe');
    assert.equal(value.mode, 'next-real-idr');
    assert.equal(value.keyframeConfirmed, false);
    assert.equal(value.maximumWaitMs, 1500);
    return value;
  }
  resumePackets() { this.host.resumeVideo(); }
  close() {
    if (this.closing) return this.closing;
    this.firstFailed(new DOMException('Native capture was retired.', 'AbortError'));
    this.closing = (async () => {
      try { await this.host.close(); }
      catch (error) {
        // Encoded byte copies are the only exported payload. No consumer holds
        // a surface from this capture process after its confirmed OS exit.
        if (!this.host.exited || this.host.pending.size) throw error;
        if (!this.errors.includes(error)) {
          this.errors.push(error);
          try { this.onError(error); }
          catch (observerError) { console.error('[MacVideoCapture] Error observer failed:', observerError); }
        }
      }
      assert.ok(this.host.nativeClosed === true || this.host.exited === true);
      return { nativeClosed: true, hostExited: this.host.exited === true, retiredWithErrors: this.errors.length > 0 };
    })();
    return this.closing;
  }
}
module.exports = { MacVideoCapture };
