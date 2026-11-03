import type { QualityProfile } from '@monky/shared';
import type { CameraEffectsSnapshot } from '../../stores/cameraEffectsStore';
import {
  CAMERA_EFFECT_LIMITS, CameraEffectError, CameraFrameAdmission, cameraEffectFrameRate, cameraOperationCancelled,
  fitCameraEffectSize, isCameraOperationCancelled,
} from '../../utils/cameraEffects';
import type { CameraEffectOutputLimits, CameraEffectRequest, CameraEffectResponse } from './cameraEffectProtocol';

// Cold Metal shader compilation can exceed 30s; steady-state frames keep their 8s deadline.
const STARTUP_TIMEOUT_MS = 60000;

declare const MediaStreamTrackProcessor: {
  new(options: { track: MediaStreamTrack; maxBufferSize: number }): { readable: ReadableStream<VideoFrame> };
} | undefined;

declare const MediaStreamTrackGenerator: {
  new(options: { kind: 'video' }): MediaStreamTrack & { readonly writable: WritableStream<VideoFrame> };
} | undefined;

interface PendingConfiguration {
  revision: number;
  resolve: (stream: MediaStream) => void;
  reject: (error: unknown) => void;
}

function isCanvasTrack(track: MediaStreamTrack | undefined): track is CanvasCaptureMediaStreamTrack {
  return !!track && 'requestFrame' in track && typeof track.requestFrame === 'function';
}

function waitForVideo(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('resize', ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', cancelled);
    };
    const ready = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      cleanup();
      resolve();
    };
    const failed = () => { cleanup(); reject(new CameraEffectError('camera')); };
    const cancelled = () => { cleanup(); reject(cameraOperationCancelled()); };
    if (signal.aborted) {
      cancelled();
      return;
    }
    video.addEventListener('loadeddata', ready);
    video.addEventListener('resize', ready);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', cancelled, { once: true });
    timeout = setTimeout(failed, 8000);
    ready();
  });
}

export class CameraEffectProcessor {
  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private output: MediaStream | null = null;
  private outputTrack: MediaStreamTrack | null = null;
  private canvasTrack: CanvasCaptureMediaStreamTrack | null = null;
  /** The worker reads camera frames and writes the output track itself, off the main thread. */
  private pipeline = false;
  private outputWidth = 0;
  private outputHeight = 0;
  private readonly abort = new AbortController();
  private revision = 0;
  private pending: PendingConfiguration | null = null;
  private stopped = false;
  private started = false;
  private active = false;
  private inFlightRevision: number | null = null;
  private frameCallback: number | null = null;
  private animationFrame: number | null = null;
  private configurationTimeout: ReturnType<typeof setTimeout> | undefined;
  private frameTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly admission = new CameraFrameAdmission();
  private lastVideoTime = -1;
  private limitQuality = false;
  private targetFps: number;

  public constructor(
    private readonly source: MediaStream,
    private profile: QualityProfile,
    private readonly onFailure: (error: CameraEffectError) => void,
  ) {
    this.targetFps = cameraEffectFrameRate(profile.cameraFps, this.limitQuality);
  }

  public get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  public async start(snapshot: CameraEffectsSnapshot): Promise<MediaStream> {
    if (this.stopped) throw cameraOperationCancelled();
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
      throw new CameraEffectError('unsupported');
    }
    const { default: CameraWorker } = await import('./cameraEffects.worker?worker');
    if (this.stopped) throw cameraOperationCancelled();
    this.worker = new CameraWorker();
    this.worker.onmessage = (event: MessageEvent<CameraEffectResponse>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new CameraEffectError('processing', { cause: event.message }));
    };
    this.worker.onmessageerror = () => this.fail(new CameraEffectError('processing'));
    const sourceTrack = this.source.getVideoTracks()[0];
    if (!sourceTrack) throw new CameraEffectError('camera');
    if (!this.startWorkerPipeline(this.worker, sourceTrack)) await this.startMainThreadCapture(sourceTrack);
    if (this.stopped) throw cameraOperationCancelled();
    const stream = await this.update(snapshot);
    if (this.stopped) throw cameraOperationCancelled();
    this.started = true;
    return stream;
  }

  /** Hands camera frames and the output track to the worker, so main-thread stalls never freeze the call. */
  private startWorkerPipeline(worker: Worker, sourceTrack: MediaStreamTrack): boolean {
    if (typeof MediaStreamTrackProcessor !== 'function' || typeof MediaStreamTrackGenerator !== 'function'
      || typeof VideoFrame !== 'function') return false;
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    generator.enabled = false;
    generator.contentHint = 'motion';
    let readable: ReadableStream<VideoFrame> | null = null;
    try {
      readable = new MediaStreamTrackProcessor({ track: sourceTrack, maxBufferSize: 1 }).readable;
      const { writable } = generator;
      const message: CameraEffectRequest = { type: 'pipeline', readable, writable, limits: this.outputLimits() };
      worker.postMessage(message, [readable, writable]);
    } catch (error) {
      generator.stop();
      if (readable && !readable.locked) void readable.cancel().catch(() => undefined);
      console.warn('[CameraEffects] Worker camera pipeline unavailable; processing frames on the main thread.', error);
      return false;
    }
    this.pipeline = true;
    this.outputTrack = generator;
    this.output = new MediaStream([generator]);
    return true;
  }

  private async startMainThreadCapture(sourceTrack: MediaStreamTrack): Promise<void> {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!this.context || typeof this.canvas.captureStream !== 'function') throw new CameraEffectError('unsupported');
    this.context.fillStyle = '#000000';
    this.context.fillRect(0, 0, 2, 2);
    this.output = this.canvas.captureStream(0);
    const track = this.output.getVideoTracks()[0];
    if (!isCanvasTrack(track)) throw new CameraEffectError('unsupported');
    this.outputTrack = track;
    this.canvasTrack = track;
    track.enabled = false;
    track.contentHint = 'motion';
    if (typeof MediaStreamTrackProcessor === 'function') {
      // Read capture frames directly: a hidden video's compositor callbacks can throttle to 1 FPS.
      this.reader = new MediaStreamTrackProcessor({ track: sourceTrack, maxBufferSize: 1 }).readable.getReader();
    } else {
      console.warn('[CameraEffects] Direct camera frames unavailable; using video callback capture.');
      this.video = document.createElement('video');
      this.video.autoplay = true;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.setAttribute('aria-hidden', 'true');
      this.video.srcObject = this.source;
      await Promise.all([this.video.play(), waitForVideo(this.video, this.abort.signal)]);
    }
  }

  public update(snapshot: CameraEffectsSnapshot): Promise<MediaStream> {
    if (this.stopped) return Promise.reject(cameraOperationCancelled());
    if (!this.worker || !this.output) return Promise.reject(new CameraEffectError('processing'));
    this.suspend();
    this.limitQuality = snapshot.settings.limitQuality;
    this.targetFps = cameraEffectFrameRate(this.profile.cameraFps, this.limitQuality);
    const revision = this.revision;
    const operation = new Promise<MediaStream>((resolve, reject) => {
      this.pending = { revision, resolve, reject };
      this.configurationTimeout = setTimeout(() => this.fail(new CameraEffectError('model')), STARTUP_TIMEOUT_MS);
      try {
        if (this.pipeline) this.send({ type: 'limits', limits: this.outputLimits() });
        this.send({
          type: 'configure', revision, settings: { ...snapshot.settings },
          image: snapshot.image,
        });
      } catch (error) {
        this.fail(new CameraEffectError('processing', { cause: error }));
      }
    });
    return operation;
  }

  public setProfile(profile: QualityProfile): void {
    this.targetFps = cameraEffectFrameRate(profile.cameraFps, this.limitQuality);
    this.profile = profile;
    this.admission.reset();
    if (this.pipeline && !this.stopped) {
      try {
        this.send({ type: 'limits', limits: this.outputLimits() });
      } catch (error) {
        this.fail(new CameraEffectError('processing', { cause: error }));
      }
    }
  }

  /** Stop exposing frames synchronously, before an asynchronous settings/image operation. */
  public suspend(): void {
    this.revision++;
    this.active = false;
    this.cancelScheduledFrame();
    clearTimeout(this.configurationTimeout);
    this.pending?.reject(cameraOperationCancelled());
    this.pending = null;
    if (this.outputTrack) this.outputTrack.enabled = false;
    if (this.context && this.canvas) {
      this.context.fillStyle = '#000000';
      this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvasTrack?.requestFrame();
    }
    if (this.pipeline && this.worker && !this.stopped) {
      clearTimeout(this.frameTimeout);
      // The output is already disabled; this only stops the worker from spending effort on stale frames.
      this.worker.postMessage({ type: 'suspend', revision: this.revision } satisfies CameraEffectRequest);
    }
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.suspend();
    this.abort.abort();
    clearTimeout(this.frameTimeout);
    this.output?.getTracks().forEach((track) => track.stop());
    this.output = null;
    this.outputTrack = null;
    this.canvasTrack = null;
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      void reader.cancel().catch(error => console.warn('[CameraEffects] Capture reader teardown failed:', error))
        .finally(() => reader.releaseLock());
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
      this.video = null;
    }
    if (this.canvas) {
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.canvas.remove();
      this.canvas = null;
      this.context = null;
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        clearTimeout(timeout);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      };
      worker.onmessage = (event: MessageEvent<CameraEffectResponse>) => {
        if (event.data.type === 'frame') event.data.bitmap.close();
        if (event.data.type === 'disposed') terminate();
      };
      worker.onerror = terminate;
      worker.onmessageerror = terminate;
      timeout = setTimeout(terminate, 2000);
      try {
        worker.postMessage({ type: 'dispose' } satisfies CameraEffectRequest);
      } catch (error) {
        console.warn('[CameraEffects] Worker could not acknowledge teardown:', error);
        terminate();
      }
    }
  }

  private send(message: CameraEffectRequest, transfer: Transferable[] = []): void {
    if (!this.worker || this.stopped) {
      if (message.type === 'frame') message.bitmap.close();
      throw cameraOperationCancelled();
    }
    this.worker.postMessage(message, transfer);
  }

  private receive(message: CameraEffectResponse): void {
    if (message.type === 'disposed') return;
    if (message.type === 'error') {
      this.completeFrame(message.revision);
      if (message.revision === this.revision && !this.stopped) this.fail(new CameraEffectError(message.code));
      return;
    }
    if (message.type === 'presented') {
      this.present(message.revision, message.width, message.height);
      return;
    }
    if (message.type === 'resizing') {
      if (message.revision === this.revision && this.active && !this.stopped) this.armFrameTimeout(true);
      return;
    }
    if (message.type === 'frame') {
      try {
        if (!this.stopped && this.active && message.revision === this.revision
          && this.canvas && this.context && this.canvasTrack && this.output) {
          if (this.canvas.width !== message.bitmap.width || this.canvas.height !== message.bitmap.height) {
            this.canvas.width = message.bitmap.width;
            this.canvas.height = message.bitmap.height;
          }
          this.context.drawImage(message.bitmap, 0, 0);
          this.present(message.revision, message.bitmap.width, message.bitmap.height);
          this.canvasTrack.requestFrame();
        }
      } catch (error) {
        this.fail(new CameraEffectError('processing', { cause: error }));
      } finally {
        message.bitmap.close();
        this.completeFrame(message.revision);
      }
    } else if (message.revision === this.revision && !this.stopped) {
      this.active = true;
      this.admission.reset();
      this.lastVideoTime = -1;
      if (this.pipeline) this.armFrameTimeout(this.pending?.revision === message.revision);
      else this.scheduleFrame();
    }
  }

  /** A processed frame of the current configuration reached the output track: expose it. */
  private present(revision: number, width: number, height: number): void {
    if (this.stopped || !this.active || revision !== this.revision || !this.outputTrack || !this.output) return;
    this.outputWidth = width;
    this.outputHeight = height;
    this.outputTrack.enabled = true;
    if (this.pipeline) this.armFrameTimeout(false);
    if (this.pending?.revision === revision) {
      clearTimeout(this.configurationTimeout);
      this.pending.resolve(this.output);
      this.pending = null;
    }
  }

  private outputLimits(): CameraEffectOutputLimits {
    return {
      fps: this.targetFps,
      width: this.limitQuality ? Math.min(this.profile.cameraWidth, CAMERA_EFFECT_LIMITS.maxWidth) : this.profile.cameraWidth,
      height: this.limitQuality ? Math.min(this.profile.cameraHeight, CAMERA_EFFECT_LIMITS.maxHeight) : this.profile.cameraHeight,
    };
  }

  private scheduleFrame(): void {
    if (!this.active || this.stopped || (!this.video && !this.reader) || this.inFlightRevision !== null
      || this.frameCallback !== null || this.animationFrame !== null) return;
    if (this.reader) {
      const revision = this.revision;
      this.inFlightRevision = revision;
      this.armFrameTimeout(this.pending?.revision === revision);
      void this.captureSourceFrame(this.reader, revision).catch((error: unknown) => {
        this.completeFrame(revision);
        if (revision === this.revision && !isCameraOperationCancelled(error)) {
          this.fail(error instanceof CameraEffectError ? error : new CameraEffectError('processing', { cause: error }));
        }
      });
      return;
    }
    if (!this.video) return;
    const frame = (now: number) => {
      this.frameCallback = null;
      this.animationFrame = null;
      if (!this.active || this.stopped || !this.video) return;
      if (this.video.currentTime === this.lastVideoTime || !this.admitFrame(now)) {
        this.scheduleFrame();
        return;
      }
      this.lastVideoTime = this.video.currentTime;
      const revision = this.revision;
      this.inFlightRevision = revision;
      this.armFrameTimeout(this.pending?.revision === revision);
      void this.captureFrame(revision, now).catch((error: unknown) => {
        this.completeFrame(revision);
        if (revision === this.revision && !isCameraOperationCancelled(error)) {
          this.fail(error instanceof CameraEffectError ? error : new CameraEffectError('processing', { cause: error }));
        }
      });
    };
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.frameCallback = this.video.requestVideoFrameCallback(frame);
    } else {
      this.animationFrame = requestAnimationFrame(frame);
    }
  }

  private admitFrame(now: number): boolean {
    return this.admission.admit(now, this.targetFps);
  }

  private armFrameTimeout(initializing: boolean): void {
    clearTimeout(this.frameTimeout);
    this.frameTimeout = setTimeout(() => this.fail(new CameraEffectError('processing', {
      cause: new Error(initializing ? 'Camera frame initialization timed out' : 'Camera frame processing timed out'),
    })), initializing ? STARTUP_TIMEOUT_MS : 8000);
  }

  private async captureSourceFrame(reader: ReadableStreamDefaultReader<VideoFrame>, revision: number): Promise<void> {
    const { value: frame, done } = await reader.read();
    try {
      if (this.stopped || !this.active || revision !== this.revision) {
        this.completeFrame(revision);
        return;
      }
      if (done || !frame) throw new CameraEffectError('camera');
      const timestamp = performance.now();
      // Capture cadence must not depend on jitter in main-thread delivery.
      if (!this.admitFrame(frame.timestamp / 1000)) {
        this.completeFrame(revision);
        return;
      }
      await this.captureBitmap(frame, frame.displayWidth, frame.displayHeight, revision, timestamp);
    } finally { frame?.close(); }
  }

  private async captureFrame(revision: number, timestamp: number): Promise<void> {
    if (!this.video) throw cameraOperationCancelled();
    await this.captureBitmap(this.video, this.video.videoWidth, this.video.videoHeight, revision, timestamp);
  }

  private async captureBitmap(
    source: HTMLVideoElement | VideoFrame, width: number, height: number, revision: number, timestamp: number,
  ): Promise<void> {
    const limits = this.outputLimits();
    const size = fitCameraEffectSize(width, height, limits.width, limits.height);
    // A new tensor shape also needs cold shaders when the capture/profile resizes.
    if (this.canvas && (size.width !== this.canvas.width || size.height !== this.canvas.height)) {
      this.armFrameTimeout(true);
    }
    const bitmap = await createImageBitmap(source, { resizeWidth: size.width, resizeHeight: size.height });
    if (this.stopped || !this.active || revision !== this.revision) {
      bitmap.close();
      this.completeFrame(revision);
      return;
    }
    try {
      this.send({ type: 'frame', revision, bitmap, timestamp }, [bitmap]);
    } catch (error) {
      bitmap.close();
      throw error;
    }
  }

  private completeFrame(revision: number): void {
    if (this.inFlightRevision === revision) {
      clearTimeout(this.frameTimeout);
      this.inFlightRevision = null;
    }
    this.scheduleFrame();
  }

  private cancelScheduledFrame(): void {
    if (this.frameCallback !== null && this.video) this.video.cancelVideoFrameCallback(this.frameCallback);
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.frameCallback = null;
    this.animationFrame = null;
  }

  private fail(error: CameraEffectError): void {
    if (this.stopped) return;
    console.error('[CameraEffects] Processing stopped:', error, error.cause);
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    this.stop();
    if (!pending) this.onFailure(error);
  }
}
