'use strict';

const { VideoFrameSink, boundedCleanup } = require('./frameSink.cjs');

const browserPlatform = {
  createTrack: () => new MediaStreamTrackGenerator({ kind: 'video' }),
  createStream: track => new MediaStream([track]),
  createFrame: (frame, options) => new VideoFrame(frame, options),
};

class NativeVideoPresentationSink extends VideoFrameSink {
  constructor(video, onError, platform = browserPlatform) {
    super();
    if (video?.nodeName !== 'VIDEO' || typeof video.play !== 'function' || typeof video.pause !== 'function') {
      throw new Error('A native presentation target must be a video element.');
    }
    if (typeof onError !== 'function') throw new Error('Native presentation requires an error handler.');
    this.video = video;
    this.onError = onError;
    this.platform = platform;
    this.track = null;
    this.stream = null;
    this.observation = null;
    this.presentationBaseline = null;
    this.hasPresentationCallbacks = typeof video.requestVideoFrameCallback === 'function'
      && typeof video.cancelVideoFrameCallback === 'function';
    this.presentedFrames = this.hasPresentationCallbacks ? 0 : null;
    this.lastMediaTimeSeconds = null;
    this.playbackStarted = false;
    this.playbackError = null;
    this.lastNativeFrameId = null;
    this.lastNativeRenderDeadlineUs = null;
    this.outOfOrderDrops = 0;
    this.displaySizeCorrections = 0;
  }

  async start() {
    if (this.track || this.stopping) throw new Error('Native presentation cannot be started twice.');
    if (this.video.srcObject || this.video.currentSrc || this.video.getAttribute?.('src')) {
      throw new Error('The presentation target already belongs to another stream.');
    }
    try {
      this.track = this.platform.createTrack();
      this.track.contentHint = 'motion';
      this.writer = this.track.writable.getWriter();
      this.stream = this.platform.createStream(this.track);
      this.previousVideoState = { muted: this.video.muted, playsInline: this.video.playsInline };
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = this.stream;
      this.observePresentation();
      // play() needs a first frame. Waiting here would deadlock a source waiting for readiness.
      this.playObserver = Promise.resolve(this.video.play()).then(() => {
        if (!this.stopping) this.playbackStarted = true;
      }, error => {
        if (this.stopping && error?.name === 'AbortError') return;
        this.playbackError = error instanceof Error ? error : new Error(String(error));
        this.stopAccepting();
        this.fail(this.playbackError);
      });
      await Promise.resolve();
      if (this.stopping) {
        throw this.playbackError ?? new DOMException('Native presentation start cancelled.', 'AbortError');
      }
      return { kind: 'native-video-presentation', encoding: false, readyForFrames: true };
    } catch (error) {
      try { await this.stop(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native presentation startup and cleanup failed.');
      }
      throw error;
    }
  }

  fail(error) {
    const value = error instanceof Error ? error : new Error(String(error));
    this.errors.push(value.message);
    this.onError(value);
  }

  async acceptFrame(frame, timestampUs, metadata) {
    if (!this.writer || this.stopping) { frame.close(); return false; }
    if (!Number.isSafeInteger(metadata?.frameId) || metadata.frameId < 1
      || !Number.isSafeInteger(timestampUs) || timestampUs < -1 || frame.timestamp !== timestampUs) {
      frame.close();
      throw new Error('Invalid native presentation frame identity or RTC deadline.');
    }
    if (this.lastNativeFrameId !== null && metadata.frameId <= this.lastNativeFrameId) {
      this.outOfOrderDrops++;
      frame.close();
      return false;
    }
    this.lastNativeFrameId = metadata.frameId;
    this.lastNativeRenderDeadlineUs = timestampUs;
    const rect = frame.visibleRect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height, frame.codedWidth, frame.codedHeight]
      .every(Number.isSafeInteger) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
      || rect.x + rect.width > frame.codedWidth || rect.y + rect.height > frame.codedHeight) {
      frame.close();
      throw new Error('Invalid native presentation visible geometry.');
    }
    if (frame.displayWidth !== rect.width || frame.displayHeight !== rect.height) {
      const original = frame;
      try {
        // The admitted decoded modes use square pixels. Electron can preserve
        // the crop but expose coded padding as display size; wrap metadata only.
        frame = (this.platform.createFrame ?? browserPlatform.createFrame)(original,
          { displayWidth: rect.width, displayHeight: rect.height });
        this.displaySizeCorrections++;
      } finally { original.close(); }
    }
    // RTC has already smoothed delivery. Deadlines may repeat, move or be 0/-1;
    // they are not capture timestamps and must not be rewritten into a fake clock.
    return this.queueFrame(frame);
  }

  observePresentation() {
    if (!this.hasPresentationCallbacks || this.stopping) return;
    this.observation = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.observation = null;
      if (this.stopping) return;
      if (this.video.srcObject !== this.stream) {
        this.stopAccepting();
        this.fail(new Error('Native presentation target was replaced.'));
        return;
      }
      if (!Number.isSafeInteger(metadata.presentedFrames) || metadata.presentedFrames < 0
        || !Number.isFinite(metadata.mediaTime)) {
        this.stopAccepting();
        this.fail(new Error('Invalid native presentation timing metadata.'));
        return;
      }
      if (this.presentationBaseline === null) this.presentationBaseline = metadata.presentedFrames - 1;
      this.presentedFrames = metadata.presentedFrames - this.presentationBaseline;
      this.lastMediaTimeSeconds = metadata.mediaTime;
      this.observePresentation();
    });
  }

  async sample() {
    return {
      kind: 'native-video-presentation', encoding: false, outbound: [], inbound: [],
      timestampSemantics: 'rtc-render-deadline-or-immediate-us',
      presentationScheduling: 'native-delivery-no-extra-timer',
      counters: {
        framesSubmitted: this.framesSubmitted, bridgeBusyDrops: this.bridgeBusyDrops,
        presentedFrames: this.presentedFrames, lastMediaTimeSeconds: this.lastMediaTimeSeconds,
        outOfOrderDrops: this.outOfOrderDrops, lastNativeRenderDeadlineUs: this.lastNativeRenderDeadlineUs,
        displaySizeCorrections: this.displaySizeCorrections,
      },
      playbackStarted: this.playbackStarted,
      errors: [...this.errors],
    };
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopAccepting();
    const stopping = this.teardown();
    this.stopPromise = stopping;
    void stopping.catch(() => { if (this.stopPromise === stopping) this.stopPromise = null; });
    return stopping;
  }

  async teardown() {
    const writer = this.writer;
    const track = this.track;
    const previousWriterError = this.writerError;
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => {
        if (this.observation !== null) this.video.cancelVideoFrameCallback(this.observation);
        this.observation = null;
        if (this.stream && this.video.srcObject === this.stream) {
          this.video.pause();
          this.video.srcObject = null;
          this.video.muted = this.previousVideoState.muted;
          this.video.playsInline = this.previousVideoState.playsInline;
        }
      }),
      boundedCleanup(Promise.resolve().then(() => writer?.abort('pipeline-stopped')),
        'Native presentation writer did not abort.'),
      boundedCleanup(this.writeInFlight ?? Promise.resolve(), 'Native presentation frame did not finish during stop.'),
    ]);
    const released = await Promise.allSettled([Promise.resolve().then(() => {
      // Ending the generator first closes its writable underneath an in-flight
      // frame. Retain both owners if that frame still needs cancellation/retry.
      if (outcomes[2].status === 'rejected') return;
      track?.stop();
      if (this.track === track) this.track = null;
      writer?.releaseLock();
      if (this.writer === writer) this.writer = null;
    })]);
    if (this.video.srcObject !== this.stream) this.stream = null;
    const failures = [...outcomes, ...released]
      .filter(result => result.status === 'rejected' && result.reason !== 'pipeline-stopped')
      .map(result => result.reason);
    if (this.writerError && this.writerError !== previousWriterError) failures.push(this.writerError);
    if (failures.length) {
      for (const error of failures) this.errors.push(error instanceof Error ? error.message : String(error));
      throw new AggregateError(failures, 'Native presentation cleanup failed.');
    }
    return this.sample();
  }
}

module.exports = { NativeVideoPresentationSink };
