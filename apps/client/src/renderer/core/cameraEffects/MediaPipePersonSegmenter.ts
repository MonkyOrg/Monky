import { ImageSegmenter, type ImageSegmenterResult } from '@mediapipe/tasks-vision';
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import modelUrl from '../../assets/camera-effects/selfie_segmenter_landscape.tflite?url';
import { CameraEffectError } from '../../utils/cameraEffects';

function localAssetUrl(path: string): string {
  const url = new URL(path, self.location.href);
  if (url.origin !== self.location.origin) throw new CameraEffectError('model');
  return url.href;
}

export class MediaPipePersonSegmenter {
  private constructor(
    private readonly segmenter: ImageSegmenter,
    private readonly canvas: OffscreenCanvas,
  ) {}

  public static async create(): Promise<MediaPipePersonSegmenter> {
    const canvas = new OffscreenCanvas(1, 1);
    try {
      const segmenter = await ImageSegmenter.createFromOptions({
        wasmLoaderPath: localAssetUrl(wasmLoaderUrl),
        wasmBinaryPath: localAssetUrl(wasmBinaryUrl),
      }, {
        baseOptions: { modelAssetPath: localAssetUrl(modelUrl), delegate: 'CPU' },
        canvas,
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      return new MediaPipePersonSegmenter(segmenter, canvas);
    } catch (error) {
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.width = 1;
      canvas.height = 1;
      throw new CameraEffectError('model', { cause: error });
    }
  }

  public segment(
    bitmap: ImageBitmap,
    timestamp: number,
    applyMask: (confidence: Float32Array, width: number, height: number) => void,
  ): void {
    this.segmenter.segmentForVideo(bitmap, timestamp, (result: ImageSegmenterResult) => {
      // The pinned model has one "selfie" foreground confidence output.
      const confidence = result.confidenceMasks;
      if (!confidence || confidence.length !== 1) throw new CameraEffectError('model');
      const person = confidence[0];
      applyMask(person.getAsFloat32Array(), person.width, person.height);
      // Callback masks belong to MediaPipe and are freed on return.
    });
  }

  public close(): void {
    try {
      this.segmenter.close();
    } finally {
      this.canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
  }
}
