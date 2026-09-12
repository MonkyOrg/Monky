import type { QualityProfile } from '@monky/shared';
import type { CameraEffectsSnapshot } from '../../stores/cameraEffectsStore';
import {
  CAMERA_EFFECT_LIMITS, CameraEffectError, cameraEffectFrameRate, cameraOperationCancelled, fitCameraEffectSize,
  isCameraOperationCancelled,
} from '../../utils/cameraEffects';
import type { CameraEffectRequest, CameraEffectResponse } from './cameraEffectProtocol';

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
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private output: MediaStream | null = null;
  private outputTrack: CanvasCaptureMediaStreamTrack | null = null;
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
  private nextFrameAt = -Infinity;
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
    track.enabled = false;
    track.contentHint = 'motion';
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
    this.video.srcObject = this.source;
    await Promise.all([this.video.play(), waitForVideo(this.video, this.abort.signal)]);
    if (this.stopped) throw cameraOperationCancelled();
    const stream = await this.update(snapshot);
    if (this.stopped) throw cameraOperationCancelled();
    this.started = true;
    return stream;
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
      this.configurationTimeout = setTimeout(() => this.fail(new CameraEffectError('model')), 15000);
      try {
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
    this.nextFrameAt = -Infinity;
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
      this.outputTrack?.requestFrame();
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
      timeout = setTimeout(terminate, 250);
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
    if (message.type === 'frame') {
      try {
        if (!this.stopped && this.active && message.revision === this.revision
          && this.canvas && this.context && this.outputTrack && this.output) {
          if (this.canvas.width !== message.bitmap.width || this.canvas.height !== message.bitmap.height) {
            this.canvas.width = message.bitmap.width;
            this.canvas.height = message.bitmap.height;
          }
          this.context.drawImage(message.bitmap, 0, 0);
          this.outputTrack.enabled = true;
          this.outputTrack.requestFrame();
          if (this.pending?.revision === message.revision) {
            clearTimeout(this.configurationTimeout);
            this.pending.resolve(this.output);
            this.pending = null;
          }
        }
      } catch (error) {
        this.fail(new CameraEffectError('processing', { cause: error }));
      } finally {
        message.bitmap.close();
        this.completeFrame(message.revision);
      }
    } else if (message.revision === this.revision && !this.stopped) {
      this.active = true;
      this.nextFrameAt = -Infinity;
      this.lastVideoTime = -1;
      this.scheduleFrame();
    }
  }

  private scheduleFrame(): void {
    if (!this.active || this.stopped || !this.video || this.inFlightRevision !== null
      || this.frameCallback !== null || this.animationFrame !== null) return;
    const frame = (now: number) => {
      this.frameCallback = null;
      this.animationFrame = null;
      if (!this.active || this.stopped || !this.video) return;
      const interval = 1000 / this.targetFps;
      const tolerance = Math.min(1, interval / 10);
      if (now + tolerance < this.nextFrameAt || this.video.currentTime === this.lastVideoTime) {
        this.scheduleFrame();
        return;
      }
      // Keep cadence and tolerate sub-millisecond callback jitter without
      // accidentally dropping every other frame at the camera's own FPS.
      this.nextFrameAt = Number.isFinite(this.nextFrameAt)
        ? this.nextFrameAt + (Math.floor(Math.max(0, now - this.nextFrameAt) / interval) + 1) * interval
        : now + interval;
      this.lastVideoTime = this.video.currentTime;
      const revision = this.revision;
      this.inFlightRevision = revision;
      this.frameTimeout = setTimeout(() => this.fail(new CameraEffectError('processing')), 8000);
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

  private async captureFrame(revision: number, timestamp: number): Promise<void> {
    if (!this.video) throw cameraOperationCancelled();
    const size = fitCameraEffectSize(
      this.video.videoWidth, this.video.videoHeight,
      this.limitQuality ? Math.min(this.profile.cameraWidth, CAMERA_EFFECT_LIMITS.maxWidth) : this.profile.cameraWidth,
      this.limitQuality ? Math.min(this.profile.cameraHeight, CAMERA_EFFECT_LIMITS.maxHeight) : this.profile.cameraHeight,
    );
    const bitmap = await createImageBitmap(this.video, { resizeWidth: size.width, resizeHeight: size.height });
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
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    this.stop();
    if (!pending) this.onFailure(error);
  }
}
