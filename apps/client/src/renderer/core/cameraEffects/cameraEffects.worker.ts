import {
  CameraEffectError, applyChromaKey, needsBackgroundImage, needsPersonSegmentation,
  restoreCameraEffectSettings, type CameraEffectSettings,
} from '../../utils/cameraEffects';
import type { CameraEffectRequest, CameraEffectResponse } from './cameraEffectProtocol';
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

class CameraEffectWorker {
  private settings: CameraEffectSettings | null = null;
  private revision = 0;
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
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  public enqueue(message: CameraEffectRequest): void {
    this.queue = this.queue.then(async () => {
      if (this.disposed) {
        if (message.type === 'frame') message.bitmap.close();
        return;
      }
      try {
        if (message.type === 'dispose') {
          await this.dispose();
          self.postMessage({ type: 'disposed' });
          self.close();
        } else if (message.type === 'configure') {
          this.revision = message.revision;
          await this.configure(message.settings, message.image);
          self.postMessage({ type: 'configured', revision: this.revision });
        } else {
          await this.process(message);
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

  private async process(message: Extract<CameraEffectRequest, { type: 'frame' }>): Promise<void> {
    const { bitmap } = message;
    try {
      if (message.revision !== this.revision || !this.settings) return;
      const settings = this.settings;
      if (needsPersonSegmentation(settings.mode)) {
        if (!this.matting) throw new CameraEffectError('model');
        const output = await this.matting.render(bitmap, settings, this.background);
        try {
          self.postMessage({ type: 'frame', revision: this.revision, bitmap: output }, [output]);
        } finally { output.close(); }
        return;
      }
      if (bitmap.width !== this.frameWidth || bitmap.height !== this.frameHeight) {
        this.frameWidth = bitmap.width;
        this.frameHeight = bitmap.height;
        if (!this.gpu) {
          this.output.width = this.foreground.width = bitmap.width;
          this.output.height = this.foreground.height = bitmap.height;
        }
      }
      const width = bitmap.width;
      const height = bitmap.height;
      if (!this.gpu) {
        this.foregroundContext.globalCompositeOperation = 'copy';
        this.foregroundContext.drawImage(bitmap, 0, 0, width, height);
        this.foregroundContext.globalCompositeOperation = 'source-over';
      }

      if (settings.mode === 'chroma' && !this.gpu) {
        const pixels = this.foregroundContext.getImageData(0, 0, width, height);
        applyChromaKey(pixels.data, settings);
        this.foregroundContext.putImageData(pixels, 0, 0);
      }

      if (this.gpu) {
        const output = this.gpu.render(bitmap, settings, null, this.background);
        try {
          self.postMessage({ type: 'frame', revision: this.revision, bitmap: output }, [output]);
        } finally { output.close(); }
        return;
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

  private async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.matting?.dispose(); }
    finally {
      this.matting = null;
      this.gpu?.dispose();
      this.gpu = null;
      this.background?.close();
      this.background = null;
      this.backgroundId = null;
      this.settings = null;
      for (const canvas of [this.output, this.foreground]) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
  }
}

const worker = new CameraEffectWorker();
self.addEventListener('message', (event) => worker.enqueue(event.data));
