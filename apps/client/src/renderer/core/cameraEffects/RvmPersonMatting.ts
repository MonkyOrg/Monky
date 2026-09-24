import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import { MathBackendWebGL } from '@tensorflow/tfjs-backend-webgl';
import { MathBackendCPU } from '@tensorflow/tfjs-backend-cpu';
import modelUrl from '../../assets/camera-effects/rvm-model.json?url';
import weightsUrl from '../../assets/camera-effects/rvm-mobilenetv3.bin?url';
import { CameraEffectError, needsPersonSegmentation, type CameraEffectSettings } from '../../utils/cameraEffects';
import { CameraGpuCompositor } from './CameraGpuCompositor';

export class RvmPersonMatting {
  private recurrent: tf.Tensor[] = [];
  private ratio: tf.Scalar | null = null;
  private size = '';
  private disposed = false;
  private readonly compositor: CameraGpuCompositor;

  public static async create(): Promise<RvmPersonMatting> {
    let model: GraphModel | undefined;
    try {
      if (!tf.findBackendFactory('cpu')) tf.registerBackend('cpu', () => new MathBackendCPU(), 1);
      if (!tf.findBackendFactory('webgl')) tf.registerBackend('webgl', () => new MathBackendWebGL(), 2);
      if (!await tf.setBackend('webgl')) throw new CameraEffectError('unsupported');
      await tf.ready();
      const backend = tf.backend();
      if (!(backend instanceof MathBackendWebGL)) throw new CameraEffectError('unsupported');
      model = await loadGraphModel(new URL(modelUrl, self.location.href).href, {
        weightUrlConverter: async name => {
          if (name !== 'group1-shard1of1.bin') throw new CameraEffectError('model');
          return new URL(weightsUrl, self.location.href).href;
        },
      });
      return new RvmPersonMatting(model, backend);
    } catch (error) {
      model?.dispose();
      tf.removeBackend('webgl');
      if (error instanceof CameraEffectError) throw error;
      throw new CameraEffectError('model', { cause: error });
    }
  }

  private constructor(private readonly model: GraphModel, private readonly backend: MathBackendWebGL) {
    this.compositor = CameraGpuCompositor.forMatting(backend.getGPGPUContext().gl);
    this.reset();
  }

  public reset(): void {
    tf.dispose(this.recurrent);
    this.ratio?.dispose();
    this.ratio = null;
    this.recurrent = [tf.scalar(0), tf.scalar(0), tf.scalar(0), tf.scalar(0)];
    this.size = '';
  }

  private async waitForGpu(): Promise<void> {
    const gpu = this.backend.getGPGPUContext();
    if (gpu.gl.isContextLost()) throw new CameraEffectError('processing');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gpu.createAndWaitForFence(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CameraEffectError('processing')), 6000);
        }),
      ]);
      if (gpu.gl.isContextLost()) throw new CameraEffectError('processing');
    } finally { clearTimeout(timer); }
  }

  public async render(bitmap: ImageBitmap, settings: CameraEffectSettings, background: ImageBitmap | null): Promise<ImageBitmap> {
    if (this.disposed || !needsPersonSegmentation(settings.mode)) throw new CameraEffectError('processing');
    const size = `${bitmap.width}x${bitmap.height}`;
    if (size !== this.size) {
      this.reset();
      this.ratio = tf.scalar(Math.min(1, 480 / Math.max(bitmap.width, bitmap.height)));
      this.size = size;
    }
    if (!this.ratio) throw new CameraEffectError('processing');
    let source: tf.Tensor | undefined;
    let rgba: tf.Tensor | undefined;
    let results: tf.Tensor[] = [];
    let data: tf.GPUData | undefined;
    try {
      source = tf.tidy(() => tf.div(tf.expandDims(tf.browser.fromPixels(bitmap), 0), 255));
      const result = await this.model.executeAsync({
        src: source, downsample_ratio: this.ratio,
        r1i: this.recurrent[0], r2i: this.recurrent[1], r3i: this.recurrent[2], r4i: this.recurrent[3],
      }, ['fgr', 'pha', 'r1o', 'r2o', 'r3o', 'r4o']);
      results = Array.isArray(result) ? result : [result];
      if (results.length !== 6) throw new CameraEffectError('processing');
      const [foreground, alpha, ...next] = results;
      if (foreground.shape.join(',') !== `1,${bitmap.height},${bitmap.width},3`
        || alpha.shape.join(',') !== `1,${bitmap.height},${bitmap.width},1`) throw new CameraEffectError('processing');
      rgba = tf.tidy(() => tf.squeeze(tf.concat([foreground, alpha], -1), [0]));
      data = rgba.dataToGPU({ customTexShape: [bitmap.height, bitmap.width] });
      if (!data.texture) throw new CameraEffectError('processing');
      const output = await this.compositor.renderMatting(bitmap, settings, data.texture, background, () => this.waitForGpu());
      tf.dispose(this.recurrent);
      this.recurrent = next;
      results = [foreground, alpha];
      return output;
    } finally {
      data?.tensorRef.dispose();
      source?.dispose(); rgba?.dispose(); tf.dispose(results);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (!this.backend.getGPGPUContext().gl.isContextLost()) await this.waitForGpu();
    } finally {
      // TensorFlow can reuse this context on the next AI/chroma transition.
      // Do not leave a deleted program current in that shared context.
      this.backend.getGPGPUContext().gl.useProgram(null);
      tf.dispose(this.recurrent); this.recurrent = [];
      this.ratio?.dispose(); this.ratio = null;
      this.compositor.dispose(); this.model.dispose();
      tf.removeBackend('webgl');
      tf.removeBackend('cpu');
    }
  }
}
