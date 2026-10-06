import { CameraEffectError, type CameraEffectSettings } from '../../utils/cameraEffects';

export class CameraCpuBackgroundBlur {
  private readonly source = new OffscreenCanvas(2, 2);
  private readonly context: OffscreenCanvasRenderingContext2D;

  public constructor() {
    const context = this.source.getContext('2d');
    if (!context) throw new CameraEffectError('unsupported');
    this.context = context;
  }

  public draw(
    target: OffscreenCanvasRenderingContext2D,
    bitmap: ImageBitmap,
    mask: OffscreenCanvas,
    settings: CameraEffectSettings,
  ): void {
    const { width, height } = bitmap;
    if (this.source.width !== width || this.source.height !== height) {
      this.source.width = width;
      this.source.height = height;
    }
    this.context.globalCompositeOperation = 'copy';
    this.context.drawImage(bitmap, 0, 0, width, height);
    this.context.globalCompositeOperation = 'destination-out';
    this.context.imageSmoothingQuality = 'high';
    this.context.drawImage(mask, 0, 0, width, height);
    target.globalCompositeOperation = 'copy';
    target.filter = `blur(${settings.blurRadius * height / 720}px)`;
    target.drawImage(this.source, 0, 0);
    target.filter = 'none';
    target.globalCompositeOperation = 'source-over';

    // Canvas filters premultiplied RGBA. Reading straight RGB divides out
    // the blurred background weight, without blurring foreground into it.
    const pixels = target.getImageData(0, 0, width, height);
    const background = [1, 3, 5].map(offset => parseInt(settings.backgroundColor.slice(offset, offset + 2), 16));
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      if (pixels.data[offset + 3] === 0) {
        pixels.data[offset] = background[0];
        pixels.data[offset + 1] = background[1];
        pixels.data[offset + 2] = background[2];
      }
      pixels.data[offset + 3] = 255;
    }
    target.putImageData(pixels, 0, 0);
  }

  public dispose(): void {
    this.source.width = this.source.height = 1;
  }
}
