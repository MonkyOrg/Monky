import {
  CameraEffectError, applyChromaKey, needsBackgroundImage, needsPersonSegmentation,
  restoreCameraEffectSettings, writePersonMask, type CameraEffectSettings,
} from '../../utils/cameraEffects';
import type { CameraEffectRequest, CameraEffectResponse } from './cameraEffectProtocol';
import type { CameraBackgroundImage } from '../../utils/cameraBackgroundImage';
import type { MediaPipePersonSegmenter } from './MediaPipePersonSegmenter';

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

class CameraEffectWorker {
  private settings: CameraEffectSettings | null = null;
  private revision = 0;
  private segmenter: MediaPipePersonSegmenter | null = null;
  private background: ImageBitmap | null = null;
  private backgroundId: string | null = null;
  private readonly output = new OffscreenCanvas(2, 2);
  private readonly foreground = new OffscreenCanvas(2, 2);
  private readonly mask = new OffscreenCanvas(2, 2);
  private readonly outputContext = context2d(this.output);
  private readonly foregroundContext = context2d(this.foreground, true);
  private readonly maskContext = context2d(this.mask);
  private maskPixels: ImageData | null = null;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private timestamp = 0;

  public enqueue(message: CameraEffectRequest): void {
    this.queue = this.queue.then(async () => {
      if (this.disposed) {
        if (message.type === 'frame') message.bitmap.close();
        return;
      }
      try {
        if (message.type === 'dispose') {
          this.dispose();
          self.postMessage({ type: 'disposed' });
          self.close();
        } else if (message.type === 'configure') {
          this.revision = message.revision;
          await this.configure(message.settings, message.image);
          self.postMessage({ type: 'configured', revision: this.revision });
        } else {
          this.process(message);
        }
      } catch (error) {
        const code = error instanceof CameraEffectError ? error.code : 'processing';
        console.error('[CameraEffectsWorker]', error);
        self.postMessage({ type: 'error', revision: this.revision, code });
      }
    });
  }

  private async configure(settings: CameraEffectSettings, image: CameraBackgroundImage | null): Promise<void> {
    this.settings = restoreCameraEffectSettings(settings);
    if (this.settings.mode === 'off') throw new CameraEffectError('settings');
    if (needsBackgroundImage(this.settings)) {
      if (!image) throw new CameraEffectError('imageMissing');
      if (this.backgroundId !== image.id) {
        this.background?.close();
        this.background = null;
        this.backgroundId = null;
        try {
          this.background = await createImageBitmap(image.blob);
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
    if (needsPersonSegmentation(this.settings.mode) && !this.segmenter) {
      // The SDK consumes its ESM loader factory once. Keep one lazy segmenter
      // per worker, idle in chroma, and release it when the worker is disposed.
      try {
        const { MediaPipePersonSegmenter } = await import('./MediaPipePersonSegmenter');
        this.segmenter = await MediaPipePersonSegmenter.create();
      } catch (error) {
        this.closeSegmenter();
        throw new CameraEffectError('model', { cause: error });
      }
    }
  }

  private process(message: Extract<CameraEffectRequest, { type: 'frame' }>): void {
    const { bitmap } = message;
    try {
      if (message.revision !== this.revision || !this.settings) return;
      const settings = this.settings;
      if (bitmap.width !== this.output.width || bitmap.height !== this.output.height) {
        this.output.width = this.foreground.width = bitmap.width;
        this.output.height = this.foreground.height = bitmap.height;
      }
      const width = this.output.width;
      const height = this.output.height;
      this.foregroundContext.globalCompositeOperation = 'copy';
      this.foregroundContext.drawImage(bitmap, 0, 0, width, height);
      this.foregroundContext.globalCompositeOperation = 'source-over';

      if (settings.mode === 'chroma') {
        const pixels = this.foregroundContext.getImageData(0, 0, width, height);
        applyChromaKey(pixels.data, settings);
        this.foregroundContext.putImageData(pixels, 0, 0);
      } else {
        if (!this.segmenter) throw new CameraEffectError('model');
        this.timestamp = Math.max(this.timestamp + 1, message.timestamp);
        this.segmenter.segment(bitmap, this.timestamp, (confidence, maskWidth, maskHeight) => {
          this.applyPersonMask(confidence, maskWidth, maskHeight, settings);
        });
      }

      this.outputContext.globalCompositeOperation = 'source-over';
      this.outputContext.filter = 'none';
      this.outputContext.fillStyle = settings.backgroundColor;
      this.outputContext.fillRect(0, 0, width, height);
      if (settings.mode === 'blur') {
        const radius = settings.blurRadius * height / 720;
        const margin = Math.ceil(radius * 2);
        this.outputContext.filter = `blur(${radius}px)`;
        this.outputContext.drawImage(bitmap, -margin, -margin, width + margin * 2, height + margin * 2);
        this.outputContext.filter = 'none';
      } else if (needsBackgroundImage(settings)) {
        if (!this.background) throw new CameraEffectError('imageMissing');
        const scale = Math.max(width / this.background.width, height / this.background.height);
        const drawnWidth = this.background.width * scale;
        const drawnHeight = this.background.height * scale;
        this.outputContext.drawImage(
          this.background, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight,
        );
      }
      this.outputContext.drawImage(this.foreground, 0, 0);
      const output = this.output.transferToImageBitmap();
      try {
        self.postMessage({ type: 'frame', revision: this.revision, bitmap: output }, [output]);
      } finally {
        output.close();
      }
    } finally {
      bitmap.close();
    }
  }

  private applyPersonMask(confidence: Float32Array, width: number, height: number, settings: CameraEffectSettings): void {
    if (!this.maskPixels || this.mask.width !== width || this.mask.height !== height) {
      this.mask.width = width;
      this.mask.height = height;
      this.maskPixels = this.maskContext.createImageData(width, height);
    }
    writePersonMask(confidence, this.maskPixels.data, settings.personThreshold, settings.edgeSoftness);
    this.maskContext.putImageData(this.maskPixels, 0, 0);
    this.foregroundContext.globalCompositeOperation = 'destination-in';
    this.foregroundContext.drawImage(this.mask, 0, 0, this.foreground.width, this.foreground.height);
    this.foregroundContext.globalCompositeOperation = 'source-over';
  }

  private closeSegmenter(): void {
    this.segmenter?.close();
    this.segmenter = null;
  }

  private dispose(): void {
    this.disposed = true;
    this.closeSegmenter();
    this.background?.close();
    this.background = null;
    this.backgroundId = null;
    this.maskPixels = null;
    this.settings = null;
    for (const canvas of [this.output, this.foreground, this.mask]) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

const worker = new CameraEffectWorker();
self.addEventListener('message', (event) => worker.enqueue(event.data));
