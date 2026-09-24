import { DEFAULT_CUSTOM_PROFILE, NATIVE_SCREEN_VIDEO_LIMITS, type QualityProfile } from '@monky/shared';

export type QualityNumberKey = Exclude<keyof QualityProfile, 'name'>;

export const CUSTOM_QUALITY_FIELDS: readonly QualityNumberKey[] = [
  'audioBitrateKbps', 'cameraWidth', 'cameraHeight', 'screenWidth', 'screenHeight',
  'cameraBitrateKbps', 'screenBitrateKbps', 'cameraFps', 'screenFps',
];

export function customVideoFpsLimit(width: number, height: number): number {
  return width >= NATIVE_SCREEN_VIDEO_LIMITS.width || height >= NATIVE_SCREEN_VIDEO_LIMITS.height
    ? 60 : NATIVE_SCREEN_VIDEO_LIMITS.fps;
}

export function customQualityBounds(key: QualityNumberKey, profile: QualityProfile): { min: number; max: number; step: number } {
  if (key.endsWith('Width')) return { min: key === 'screenWidth' ? 4 : 1, max: NATIVE_SCREEN_VIDEO_LIMITS.width, step: 1 };
  if (key.endsWith('Height')) return { min: key === 'screenHeight' ? 2 : 1, max: NATIVE_SCREEN_VIDEO_LIMITS.height, step: 1 };
  if (key === 'cameraFps') return { min: 1, max: customVideoFpsLimit(profile.cameraWidth, profile.cameraHeight), step: 1 };
  if (key === 'screenFps') return { min: 1, max: customVideoFpsLimit(profile.screenWidth, profile.screenHeight), step: 1 };
  if (key === 'audioBitrateKbps') return { min: 6, max: 510, step: 1 };
  return { min: key === 'screenBitrateKbps' ? 150 : 1, max: NATIVE_SCREEN_VIDEO_LIMITS.maxBitrateKbps,
    step: key === 'screenBitrateKbps' ? 50 : 1 };
}

export function normalizeCustomQualityProfile(profile: QualityProfile): QualityProfile {
  const normalized = { ...profile };
  // Resolve dimensions before the FPS ceiling, including profiles saved by older clients.
  for (const key of CUSTOM_QUALITY_FIELDS) {
    const { min, max, step } = customQualityBounds(key, normalized);
    const value = Number.isFinite(profile[key]) ? profile[key] : DEFAULT_CUSTOM_PROFILE[key];
    normalized[key] = Math.max(min, Math.min(max, Math.floor(value / step) * step));
  }
  return normalized;
}
