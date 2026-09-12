import type { CameraBackgroundImage } from '../../utils/cameraBackgroundImage';
import type { CameraEffectErrorCode, CameraEffectSettings } from '../../utils/cameraEffects';

export type CameraEffectRequest =
  | { type: 'configure'; revision: number; settings: CameraEffectSettings; image: CameraBackgroundImage | null }
  | { type: 'frame'; revision: number; bitmap: ImageBitmap; timestamp: number }
  | { type: 'dispose' };

export type CameraEffectResponse =
  | { type: 'configured'; revision: number }
  | { type: 'frame'; revision: number; bitmap: ImageBitmap }
  | { type: 'error'; revision: number; code: CameraEffectErrorCode }
  | { type: 'disposed' };
