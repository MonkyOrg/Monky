import type { CameraBackgroundImage } from '../../utils/cameraBackgroundImage';
import type { CameraEffectErrorCode, CameraEffectSettings } from '../../utils/cameraEffects';

/** Output cadence and size bound applied to camera frames before processing. */
export interface CameraEffectOutputLimits {
  fps: number;
  width: number;
  height: number;
}

export type CameraEffectRequest =
  | { type: 'configure'; revision: number; settings: CameraEffectSettings; image: CameraBackgroundImage | null }
  | { type: 'frame'; revision: number; bitmap: ImageBitmap; timestamp: number }
  // Worker pipeline: the worker reads camera frames and writes processed frames itself.
  | { type: 'pipeline'; readable: ReadableStream<VideoFrame>; writable: WritableStream<VideoFrame>; limits: CameraEffectOutputLimits }
  | { type: 'limits'; limits: CameraEffectOutputLimits }
  | { type: 'suspend'; revision: number }
  | { type: 'dispose' };

export type CameraEffectResponse =
  | { type: 'configured'; revision: number }
  | { type: 'frame'; revision: number; bitmap: ImageBitmap }
  | { type: 'presented'; revision: number; width: number; height: number }
  | { type: 'resizing'; revision: number }
  | { type: 'error'; revision: number; code: CameraEffectErrorCode }
  | { type: 'disposed' };
