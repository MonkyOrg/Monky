import { t, type TranslationKey } from '../i18n';
import { cameraCaptureError, type CameraEffectErrorCode } from './cameraEffects';

const errorKeys: Record<CameraEffectErrorCode, TranslationKey> = {
  unsupported: 'cameraEffects.errorUnsupported',
  model: 'cameraEffects.errorModel',
  processing: 'cameraEffects.errorProcessing',
  imageMissing: 'cameraEffects.errorImageMissing',
  imageType: 'cameraEffects.errorImageType',
  imageSize: 'cameraEffects.errorImageSize',
  imageDecode: 'cameraEffects.errorImageDecode',
  storage: 'cameraEffects.errorStorage',
  settings: 'cameraEffects.errorSettings',
  privacyBlocked: 'cameraEffects.errorPrivacyBlocked',
  permission: 'cameraEffects.errorPermission',
  device: 'cameraEffects.errorDevice',
  camera: 'cameraEffects.errorCamera',
};

export function cameraEffectErrorMessage(error: unknown): string {
  return t(errorKeys[cameraCaptureError(error).code]);
}
