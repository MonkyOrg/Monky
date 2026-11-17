import { isHexColor } from './colors';
export { isHexColor } from './colors';

export const CAMERA_EFFECT_MODES = ['off', 'blur', 'color', 'image', 'chroma'] as const;
export type CameraEffectMode = typeof CAMERA_EFFECT_MODES[number];
export type CameraBackgroundSource = 'color' | 'image';
export const CAMERA_PERSON_FOCUS = ['all', 'main'] as const;
export type CameraPersonFocus = typeof CAMERA_PERSON_FOCUS[number];

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
  /** Flips the transmitted video horizontally; the replacement background is not flipped. */
  mirror: boolean;
  personFocus: CameraPersonFocus;
  /** Percentage over the size that covers the frame (100 = cover). */
  backgroundZoom: number;
  /** CSS object-position percentages of the background image inside the frame. */
  backgroundPositionX: number;
  backgroundPositionY: number;
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
  mirror: false,
  personFocus: 'all',
  backgroundZoom: 100,
  backgroundPositionX: 50,
  backgroundPositionY: 50,
});

export const CAMERA_BACKGROUND_ZOOM = Object.freeze({ min: 100, max: 400 });

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
    || (Object.hasOwn(value, 'maxFps') && !numberInRange(value.maxFps, 5, 24))
    || !optional(value, 'mirror', mirror => typeof mirror === 'boolean')
    || !optional(value, 'personFocus', focus => CAMERA_PERSON_FOCUS.some(option => option === focus))
    || !optional(value, 'backgroundZoom', zoom => numberInRange(zoom, CAMERA_BACKGROUND_ZOOM.min, CAMERA_BACKGROUND_ZOOM.max))
    || !optional(value, 'backgroundPositionX', position => numberInRange(position, 0, 100))
    || !optional(value, 'backgroundPositionY', position => numberInRange(position, 0, 100))) {
    throw new CameraEffectError('settings');
  }
  const defaults = DEFAULT_CAMERA_EFFECT_SETTINGS;
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
    // Choices added later are absent from older saves and start at their defaults.
    mirror: typeof value.mirror === 'boolean' ? value.mirror : defaults.mirror,
    personFocus: value.personFocus === 'main' ? 'main' : defaults.personFocus,
    backgroundZoom: typeof value.backgroundZoom === 'number' ? value.backgroundZoom : defaults.backgroundZoom,
    backgroundPositionX: typeof value.backgroundPositionX === 'number' ? value.backgroundPositionX : defaults.backgroundPositionX,
    backgroundPositionY: typeof value.backgroundPositionY === 'number' ? value.backgroundPositionY : defaults.backgroundPositionY,
  };
}

/** A missing field is accepted, but a present one must be valid. */
function optional(record: Record<string, unknown>, key: string, valid: (value: unknown) => boolean): boolean {
  return !Object.hasOwn(record, key) || valid(record[key]);
}

/** The camera needs the processor whenever its pixels differ from the raw capture. */
export function needsCameraProcessing(settings: CameraEffectSettings): boolean {
  return settings.mode !== 'off' || settings.mirror;
}

export const CAMERA_FRAMING_KEYS = Object.freeze(['backgroundZoom', 'backgroundPositionX', 'backgroundPositionY'] as const);
export type CameraBackgroundFraming = Pick<CameraEffectSettings, typeof CAMERA_FRAMING_KEYS[number]>;

/** Framing only places the chosen picture: it never decides which camera pixels are shown. */
export function isCameraFramingPatch(patch: Partial<CameraEffectSettings>): boolean {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every(key => (CAMERA_FRAMING_KEYS as readonly string[]).includes(key));
}
export interface CameraImageRect { x: number; y: number; width: number; height: number }

/**
 * Places the background image like CSS `object-fit: cover` plus a zoom and an
 * `object-position`, so the editor preview and the transmitted frame always agree.
 */
export function backgroundImageRect(
  frameWidth: number,
  frameHeight: number,
  imageWidth: number,
  imageHeight: number,
  settings: CameraBackgroundFraming,
): CameraImageRect {
  if (![frameWidth, frameHeight, imageWidth, imageHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new CameraEffectError('processing');
  }
  const scale = Math.max(frameWidth / imageWidth, frameHeight / imageHeight) * settings.backgroundZoom / 100;
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (frameWidth - width) * settings.backgroundPositionX / 100,
    y: (frameHeight - height) * settings.backgroundPositionY / 100,
    width,
    height,
  };
}

/**
 * The position (0..100) that places the image at `offset` pixels from the frame edge,
 * the inverse of `backgroundImageRect` used while dragging. A fully covering image has
 * no slack along that axis, so its position stays centered.
 */
export function backgroundPositionForOffset(frameSize: number, imageSize: number, offset: number): number {
  const slack = frameSize - imageSize;
  if (slack > -0.5) return 50;
  return Math.max(0, Math.min(100, offset / slack * 100));
}

/**
 * The framing after zooming to `zoom` around a point of the frame (in frame pixels): the
 * part of the image under that point stays under it, like zooming in an image editor.
 */
export function zoomBackgroundAt(
  frameWidth: number,
  frameHeight: number,
  imageWidth: number,
  imageHeight: number,
  settings: CameraBackgroundFraming,
  zoom: number,
  pointX: number,
  pointY: number,
): CameraBackgroundFraming {
  const before = backgroundImageRect(frameWidth, frameHeight, imageWidth, imageHeight, settings);
  const backgroundZoom = Math.max(CAMERA_BACKGROUND_ZOOM.min, Math.min(CAMERA_BACKGROUND_ZOOM.max, zoom));
  const ratio = backgroundZoom / settings.backgroundZoom;
  const axis = (frameSize: number, size: number, offset: number, point: number) =>
    backgroundPositionForOffset(frameSize, size * ratio, point - (point - offset) * ratio);
  return {
    backgroundZoom,
    backgroundPositionX: axis(frameWidth, before.width, before.x, pointX),
    backgroundPositionY: axis(frameHeight, before.height, before.y, pointY),
  };
}

export function cameraEffectFrameRate(profileFps: number, limitQuality: boolean): number {
  if (!Number.isFinite(profileFps) || profileFps <= 0) throw new CameraEffectError('settings');
  return limitQuality ? Math.min(profileFps, CAMERA_EFFECT_LIMITS.optionalFpsCap) : profileFps;
}

/**
 * Admits camera frames at a target rate from their own capture timestamps (ms), so late
 * or batched delivery never changes the cadence and no frame is duplicated.
 */
export class CameraFrameAdmission {
  private nextAt = -Infinity;

  public reset(): void {
    this.nextAt = -Infinity;
  }

  public admit(now: number, fps: number): boolean {
    const interval = 1000 / fps;
    if (now + Math.min(1, interval / 10) < this.nextAt) return false;
    this.nextAt = Number.isFinite(this.nextAt)
      ? this.nextAt + (Math.floor(Math.max(0, now - this.nextAt) / interval) + 1) * interval
      : now + interval;
    return true;
  }
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

export function stabilizePersonMask(current: Float32Array, previous: Float32Array | null): Float32Array {
  if (!previous || previous.length !== current.length) previous = new Float32Array(current);
  for (let index = 0; index < current.length; index++) {
    const value = current[index];
    if (!Number.isFinite(value)) throw new CameraEffectError('processing');
    // Smooth uncertain stationary edges, but follow motion immediately to avoid trails.
    const stable = Math.abs(value - previous[index]) < 0.12 && value > 0.05 && value < 0.95;
    previous[index] = stable ? previous[index] * 0.6 + value * 0.4 : value;
  }
  return previous;
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
