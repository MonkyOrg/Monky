import { isHexColor } from './colors';
export { isHexColor } from './colors';

export const CAMERA_EFFECT_MODES = ['off', 'blur', 'color', 'image', 'chroma'] as const;
export type CameraEffectMode = typeof CAMERA_EFFECT_MODES[number];
export type CameraBackgroundSource = 'color' | 'image';

export interface CameraEffectSettings {
  mode: CameraEffectMode;
  backgroundColor: string;
  backgroundSource: CameraBackgroundSource;
  blurRadius: number;
  personThreshold: number;
  edgeSoftness: number;
  keyColor: string;
  keyTolerance: number;
  keySoftness: number;
  spillReduction: number;
  limitQuality: boolean;
}

export const DEFAULT_CAMERA_EFFECT_SETTINGS: Readonly<CameraEffectSettings> = Object.freeze({
  mode: 'off',
  backgroundColor: '#263238',
  backgroundSource: 'color',
  blurRadius: 16,
  personThreshold: 55,
  edgeSoftness: 10,
  keyColor: '#00ff00',
  keyTolerance: 25,
  keySoftness: 10,
  spillReduction: 50,
  limitQuality: false,
});

export const CAMERA_EFFECT_LIMITS = Object.freeze({
  maxWidth: 1280,
  maxHeight: 720,
  optionalFpsCap: 30,
  maxImageBytes: 8 * 1024 * 1024,
  maxStoredImageBytes: 2 * 1024 * 1024,
  maxImagePixels: 24 * 1024 * 1024,
  maxImageDimension: 8192,
});

export type CameraEffectErrorCode =
  | 'unsupported'
  | 'model'
  | 'processing'
  | 'imageMissing'
  | 'imageType'
  | 'imageSize'
  | 'imageDecode'
  | 'storage'
  | 'settings'
  | 'privacyBlocked'
  | 'permission'
  | 'device'
  | 'camera';

export class CameraEffectError extends Error {
  public constructor(public readonly code: CameraEffectErrorCode, options?: ErrorOptions) {
    super(`Camera effect: ${code}`, options);
    this.name = 'CameraEffectError';
  }
}

export function isCameraEffectMode(value: unknown): value is CameraEffectMode {
  return CAMERA_EFFECT_MODES.some((mode) => value === mode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** A corrupt saved privacy choice must never be restored as an unprocessed camera. */
export function restoreCameraEffectSettings(value: unknown): CameraEffectSettings {
  if (!isRecord(value)
    || !isCameraEffectMode(value.mode)
    || !isHexColor(value.backgroundColor)
    || (value.backgroundSource !== 'color' && value.backgroundSource !== 'image')
    || !numberInRange(value.blurRadius, 4, 32)
    || !numberInRange(value.personThreshold, 30, 90)
    || !numberInRange(value.edgeSoftness, 0, 20)
    || !isHexColor(value.keyColor)
    || !numberInRange(value.keyTolerance, 5, 60)
    || !numberInRange(value.keySoftness, 1, 30)
    || !numberInRange(value.spillReduction, 0, 100)
    || (Object.hasOwn(value, 'limitQuality')
      ? typeof value.limitQuality !== 'boolean'
      : !Object.hasOwn(value, 'limitFpsTo30') && !Object.hasOwn(value, 'maxFps'))
    || (Object.hasOwn(value, 'limitFpsTo30') && typeof value.limitFpsTo30 !== 'boolean')
    || (Object.hasOwn(value, 'maxFps') && !numberInRange(value.maxFps, 5, 24))) {
    throw new CameraEffectError('settings');
  }
  return {
    mode: value.mode,
    backgroundColor: value.backgroundColor.toLowerCase(),
    backgroundSource: value.backgroundSource,
    blurRadius: value.blurRadius,
    personThreshold: value.personThreshold,
    edgeSoftness: value.edgeSoftness,
    keyColor: value.keyColor.toLowerCase(),
    keyTolerance: value.keyTolerance,
    keySoftness: value.keySoftness,
    spillReduction: value.spillReduction,
    // Preserve the explicit legacy switch; older numeric caps stay removed.
    limitQuality: typeof value.limitQuality === 'boolean' ? value.limitQuality : value.limitFpsTo30 === true,
  };
}

export function cameraEffectFrameRate(profileFps: number, limitQuality: boolean): number {
  if (!Number.isFinite(profileFps) || profileFps <= 0) throw new CameraEffectError('settings');
  return limitQuality ? Math.min(profileFps, CAMERA_EFFECT_LIMITS.optionalFpsCap) : profileFps;
}

export function needsPersonSegmentation(mode: CameraEffectMode): boolean {
  return mode === 'blur' || mode === 'color' || mode === 'image';
}

export function needsBackgroundImage(settings: CameraEffectSettings): boolean {
  return settings.mode === 'image' || (settings.mode === 'chroma' && settings.backgroundSource === 'image');
}

export function fitCameraEffectSize(
  width: number,
  height: number,
  maxWidth: number = CAMERA_EFFECT_LIMITS.maxWidth,
  maxHeight: number = CAMERA_EFFECT_LIMITS.maxHeight,
): { width: number; height: number } {
  if (![width, height, maxWidth, maxHeight].every((value) => Number.isFinite(value) && value >= 1)) {
    throw new CameraEffectError('processing');
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.floor(width * scale / 2) * 2),
    height: Math.max(1, Math.floor(height * scale / 2) * 2),
  };
}

export function smoothStep(low: number, high: number, value: number): number {
  if (high <= low) return value >= high ? 1 : 0;
  const amount = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return amount * amount * (3 - 2 * amount);
}

export function writePersonMask(
  confidence: Float32Array,
  rgba: Uint8ClampedArray,
  threshold: number,
  softness: number,
): void {
  if (rgba.length !== confidence.length * 4) throw new CameraEffectError('processing');
  const low = threshold / 100 - softness / 100;
  const high = threshold / 100 + softness / 100;
  for (let index = 0; index < confidence.length; index++) {
    const value = confidence[index];
    if (!Number.isFinite(value)) throw new CameraEffectError('processing');
    const offset = index * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = Math.round(smoothStep(low, high, value) * 255);
  }
}

/** Chromatic keys tolerate lighting changes; neutral keys also distinguish brightness. */
export function applyChromaKey(rgba: Uint8ClampedArray, settings: CameraEffectSettings): void {
  if (!isHexColor(settings.keyColor)) throw new CameraEffectError('settings');
  if (rgba.length % 4 !== 0) throw new CameraEffectError('processing');
  const keyR = parseInt(settings.keyColor.slice(1, 3), 16);
  const keyG = parseInt(settings.keyColor.slice(3, 5), 16);
  const keyB = parseInt(settings.keyColor.slice(5, 7), 16);
  const keySum = keyR + keyG + keyB;
  const neutralKey = Math.max(keyR, keyG, keyB) - Math.min(keyR, keyG, keyB) < 16;
  const red = neutralKey ? 0 : keyR / keySum;
  const green = neutralKey ? 0 : keyG / keySum;
  const blue = neutralKey ? 0 : keyB / keySum;
  const tolerance = settings.keyTolerance / 100;
  const softness = settings.keySoftness / 100;
  const spill = settings.spillReduction / 100;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const sum = r + g + b;
    if (!neutralKey && (Math.max(r, g, b) < 8 || Math.max(r, g, b) - Math.min(r, g, b) < 12)) {
      rgba[offset + 3] = 255;
      continue;
    }
    // Normalizing gray RGB would make white, gray and black indistinguishable.
    // Absolute channel differences retain luminance and remain defined at black.
    const distance = neutralKey
      ? Math.max(Math.abs(r - keyR), Math.abs(g - keyG), Math.abs(b - keyB)) / 255
      : Math.hypot(r / sum - red, g / sum - green, b / sum - blue) / Math.SQRT2;
    const alpha = smoothStep(tolerance, tolerance + softness, distance);
    rgba[offset + 3] = Math.round(alpha * 255);
    if (!neutralKey && keyG > keyR && keyG > keyB && g > Math.max(r, b)) {
      const fringe = 1 - smoothStep(tolerance, tolerance + softness + 0.2, distance);
      rgba[offset + 1] = Math.round(g - (g - Math.max(r, b)) * spill * fringe);
    }
  }
}

export function cameraCaptureError(error: unknown): CameraEffectError {
  if (error instanceof CameraEffectError) return error;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return new CameraEffectError('permission', { cause: error });
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError' || error.name === 'NotReadableError') {
      return new CameraEffectError('device', { cause: error });
    }
  }
  return new CameraEffectError('camera', { cause: error });
}

export function cameraOperationCancelled(): DOMException {
  return new DOMException('Camera operation cancelled', 'AbortError');
}

export function isCameraOperationCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
