import {
  CameraEffectError, CameraFrameAdmission, applyChromaKey, fitCameraEffectSize, needsBackgroundImage,
  needsPersonSegmentation, restoreCameraEffectSettings, type CameraEffectSettings,
} from '../../utils/cameraEffects';
import type { CameraEffectOutputLimits, CameraEffectRequest, CameraEffectResponse } from './cameraEffectProtocol';
import type { CameraBackgroundImage } from '../../utils/cameraBackgroundImage';
import type { RvmPersonMatting } from './RvmPersonMatting';
import { CameraGpuCompositor } from './CameraGpuCompositor';

declare const self: {
  readonly location: Location;
  addEventListener(type: 'message', listener: (event: MessageEvent<CameraEffectRequest>) => void): void;
  postMessage(message: CameraEffectResponse, transfer?: Transferable[]): void;
  close(): void;
};

function context2d(canvas: OffscreenCanvas, readPixels = false): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: readPixels });
  if (!context) throw new CameraEffectError('unsupported');
  return context;
}

/** The output track was stopped while a processed frame was being written. */
class OutputClosedError extends Error {
  public constructor(cause: unknown) {
    super('Camera effect output closed', { cause });
  }
}

interface WorkerPipeline {
  reader: ReadableStreamDefaultReader<VideoFrame>;
  writer: WritableStreamDefaultWriter<VideoFrame>;
  limits: CameraEffectOutputLimits;
  readonly admission: CameraFrameAdmission;
  width: number;
  height: number;
}

class CameraEffectWorker {
  private settings: CameraEffectSettings | null = null;
  /** Latest revision announced by the renderer; frames of any other revision are never output. */
  private revision = 0;
  private configuredRevision = -1;
  private matting: RvmPersonMatting | null = null;
  private background: ImageBitmap | null = null;
  private backgroundId: string | null = null;
  private readonly output = new OffscreenCanvas(2, 2);
  private readonly foreground = new OffscreenCanvas(2, 2);
  private readonly outputContext = context2d(this.output, true);
  private readonly foregroundContext = context2d(this.foreground, true);
  private gpu: CameraGpuCompositor | null = null;
  private compositorInitialized = false;
  private frameWidth = 0;
  private frameHeight = 0;
  private pipeline: WorkerPipeline | null = null;
  private frameCopy: OffscreenCanvas | null = null;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  public receive(message: CameraEffectRequest): void {
    // Revision changes take effect on arrival, so a frame already being processed is dropped.
    if (message.type === 'configure' || message.type === 'suspend') this.revision = message.revision;
    if (message.type === 'suspend') return;
    if (message.type === 'limits') {
      if (this.pipeline) this.pipeline.limits = message.limits;
      return;
    }
    if (message.type === 'pipeline') {
      this.startPipeline(message.readable, message.writable, message.limits);
      return;
    }
    const revision = message.type === 'dispose' ? this.revision : message.revision;
    void this.run(revision, async () => {
      if (message.type === 'dispose') {
        await this.dispose();
        self.postMessage({ type: 'disposed' });
        self.close();
      } else if (message.type === 'configure') {
        await this.configure(message.settings, message.image);
        this.configuredRevision = message.revision;
        this.pipeline?.admission.reset();
        if (message.revision === this.revision) self.postMessage({ type: 'configured', revision: message.revision });
      } else {
        await this.process(message);
      }
    }, () => { if (message.type === 'frame') message.bitmap.close(); });
  }

  /** Serializes configuration and processing; reports a failure and returns false. */
  private run(revision: number, task: () => Promise<void>, skipped?: () => void): Promise<boolean> {
    const result = this.queue.then(async () => {
      if (this.disposed) {
        skipped?.();
        return false;
      }
      try {
        await task();
        return true;
      } catch (error) {
        const code = error instanceof CameraEffectError ? error.code : 'processing';
        if (!(error instanceof OutputClosedError)) console.error('[CameraEffectsWorker]', error);
        self.postMessage({ type: 'error', revision, code });
        return false;
      }
    });
    this.queue = result.then(() => undefined);
    return result;
  }

  private isCurrent(revision: number): boolean {
    return !this.disposed && !!this.settings && revision === this.revision && revision === this.configuredRevision;
  }

  private async configure(settings: CameraEffectSettings, image: CameraBackgroundImage | null): Promise<void> {
    this.settings = restoreCameraEffectSettings(settings);
    if (this.settings.mode === 'off') throw new CameraEffectError('settings');
    if (this.settings.mode === 'chroma' && !this.compositorInitialized) {
      this.gpu = CameraGpuCompositor.create();
      this.compositorInitialized = true;
    }
    if (needsBackgroundImage(this.settings)) {
      if (!image) throw new CameraEffectError('imageMissing');
      if (this.backgroundId !== image.id) {
        this.background?.close();
        this.background = null;
        this.backgroundId = null;
        try {
          this.background = await createImageBitmap(image.blob, { premultiplyAlpha: 'none' });
          this.backgroundId = image.id;
        } catch (error) {
          throw new CameraEffectError('imageDecode', { cause: error });
        }
      }
    } else {
      this.background?.close();
      this.background = null;
      this.backgroundId = null;
    }
    if (needsPersonSegmentation(this.settings.mode)) {
      if (!this.matting) {
        const { RvmPersonMatting } = await import('./RvmPersonMatting');
        this.matting = await RvmPersonMatting.create();
      } else this.matting.reset();
    } else if (this.matting) {
      this.matting.reset();
    }
  }

  /** Renders one frame; the result is either a bitmap or a canvas valid until the next frame. */
  private async compose(bitmap: ImageBitmap, settings: CameraEffectSettings): Promise<ImageBitmap | OffscreenCanvas> {
    if (needsPersonSegmentation(settings.mode)) {
      if (!this.matting) throw new CameraEffectError('model');
      return await this.matting.render(bitmap, settings, this.background);
    }
    if (this.gpu) return this.gpu.renderCanvas(bitmap, settings, null, this.background);
    const { width, height } = bitmap;
    if (width !== this.frameWidth || height !== this.frameHeight) {
      this.frameWidth = width;
      this.frameHeight = height;
      this.output.width = this.foreground.width = width;
      this.output.height = this.foreground.height = height;
    }
    this.foregroundContext.globalCompositeOperation = 'copy';
    this.foregroundContext.drawImage(bitmap, 0, 0, width, height);
    this.foregroundContext.globalCompositeOperation = 'source-over';
    if (settings.mode === 'chroma') {
      const pixels = this.foregroundContext.getImageData(0, 0, width, height);
      applyChromaKey(pixels.data, settings);
      this.foregroundContext.putImageData(pixels, 0, 0);
    }
    this.outputContext.globalCompositeOperation = 'source-over';
    this.outputContext.filter = 'none';
    this.outputContext.fillStyle = settings.backgroundColor;
    this.outputContext.fillRect(0, 0, width, height);
    if (needsBackgroundImage(settings)) {
      if (!this.background) throw new CameraEffectError('imageMissing');
      const scale = Math.max(width / this.background.width, height / this.background.height);
      const drawnWidth = this.background.width * scale;
      const drawnHeight = this.background.height * scale;
      this.outputContext.drawImage(
        this.background, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight,
      );
    }
    this.outputContext.drawImage(this.foreground, 0, 0);
    return this.output;
  }

  private async process(message: Extract<CameraEffectRequest, { type: 'frame' }>): Promise<void> {
    const { bitmap } = message;
    let output: ImageBitmap | OffscreenCanvas;
    try {
      if (!this.isCurrent(message.revision) || !this.settings) return;
      output = await this.compose(bitmap, this.settings);
    } finally {
      bitmap.close();
    }
    const image = output instanceof ImageBitmap ? output : output.transferToImageBitmap();
    try {
      self.postMessage({ type: 'frame', revision: message.revision, bitmap: image }, [image]);
    } finally {
      image.close();
    }
  }

  private startPipeline(
    readable: ReadableStream<VideoFrame>, writable: WritableStream<VideoFrame>, limits: CameraEffectOutputLimits,
  ): void {
    if (this.pipeline || this.disposed) {
      void readable.cancel().catch(() => undefined);
      void writable.abort().catch(() => undefined);
      return;
    }
    const pipeline: WorkerPipeline = {
      reader: readable.getReader(), writer: writable.getWriter(), limits,
      admission: new CameraFrameAdmission(), width: 0, height: 0,
    };
    this.pipeline = pipeline;
    void this.pump(pipeline);
  }

  private async pump(pipeline: WorkerPipeline): Promise<void> {
    for (;;) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await pipeline.reader.read();
      } catch (error) {
        if (this.disposed) return;
        console.error('[CameraEffectsWorker] Camera frames failed:', error);
        self.postMessage({ type: 'error', revision: this.revision, code: 'camera' });
        return;
      }
      const frame = result.value;
      if (result.done || !frame) {
        if (!this.disposed) self.postMessage({ type: 'error', revision: this.revision, code: 'camera' });
        return;
      }
      try {
        // Frames that arrive while nothing current is configured are dropped without spending the cadence.
        if (!this.isCurrent(this.revision) || !pipeline.admission.admit(frame.timestamp / 1000, pipeline.limits.fps)) continue;
        const revision = this.revision;
        // A failure of the current revision ends the pipeline; the renderer stops on its error.
        if (!await this.run(revision, () => this.present(pipeline, frame)) && revision === this.revision) return;
      } finally {
        frame.close();
      }
    }
  }

  private async present(pipeline: WorkerPipeline, frame: VideoFrame): Promise<void> {
    const revision = this.revision;
    if (!this.isCurrent(revision) || !this.settings) return;
    const size = fitCameraEffectSize(frame.displayWidth, frame.displayHeight, pipeline.limits.width, pipeline.limits.height);
    if (size.width !== pipeline.width || size.height !== pipeline.height) {
      // A new tensor shape needs cold shaders; the renderer extends its deadline.
      self.postMessage({ type: 'resizing', revision });
    }
    const bitmap = await createImageBitmap(frame, { resizeWidth: size.width, resizeHeight: size.height });
    let output: ImageBitmap | OffscreenCanvas;
    try {
      output = await this.compose(bitmap, this.settings);
    } finally {
      bitmap.close();
    }
    if (!this.isCurrent(revision)) {
      if (output instanceof ImageBitmap) output.close();
      return;
    }
    const processed = this.videoFrame(output, frame.timestamp);
    try {
      await pipeline.writer.write(processed);
    } catch (error) {
      // The renderer stops the output track first when it tears the camera down.
      throw new OutputClosedError(error);
    } finally {
      processed.close();
    }
    pipeline.width = size.width;
    pipeline.height = size.height;
    self.postMessage({ type: 'presented', revision, width: size.width, height: size.height });
  }

  private videoFrame(output: ImageBitmap | OffscreenCanvas, timestamp: number): VideoFrame {
    try {
      if (!this.frameCopy) {
        try {
          return new VideoFrame(output, { timestamp });
        } catch (error) {
          // Some GPU-backed images cannot be wrapped directly; copy them from now on.
          console.warn('[CameraEffectsWorker] Direct video frame unavailable; copying processed frames.', error);
          this.frameCopy = new OffscreenCanvas(output.width, output.height);
        }
      }
      if (this.frameCopy.width !== output.width || this.frameCopy.height !== output.height) {
        this.frameCopy.width = output.width;
        this.frameCopy.height = output.height;
      }
      const context = context2d(this.frameCopy);
      context.globalCompositeOperation = 'copy';
      context.drawImage(output, 0, 0);
      return new VideoFrame(this.frameCopy, { timestamp });
    } finally {
      if (output instanceof ImageBitmap) output.close();
    }
  }

  private async dispose(): Promise<void> {
    this.disposed = true;
    const pipeline = this.pipeline;
    this.pipeline = null;
    try {
      if (pipeline) {
        await Promise.allSettled([pipeline.reader.cancel(), pipeline.writer.close()]);
      }
      await this.matting?.dispose();
    } finally {
      this.matting = null;
      this.gpu?.dispose();
      this.gpu = null;
      this.background?.close();
      this.background = null;
      this.backgroundId = null;
      this.settings = null;
      for (const canvas of [this.output, this.foreground, this.frameCopy]) {
        if (!canvas) continue;
        canvas.width = 1;
        canvas.height = 1;
      }
      this.frameCopy = null;
    }
  }
}

const worker = new CameraEffectWorker();
self.addEventListener('message', (event) => worker.receive(event.data));
