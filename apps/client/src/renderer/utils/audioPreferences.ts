export const NOISE_SUPPRESSION_MODES = ['rnnoise', 'speex', 'gtcrn', 'browser', 'off'] as const;
export type NoiseSuppressionMode = typeof NOISE_SUPPRESSION_MODES[number];
export type WorkletNoiseSuppressionMode = Exclude<NoiseSuppressionMode, 'browser' | 'off'>;

export function isNoiseSuppressionMode(value: unknown): value is NoiseSuppressionMode {
  return NOISE_SUPPRESSION_MODES.some((mode) => mode === value);
}

export function restoreNoiseSuppressionMode(mode: unknown, legacyEnabled: unknown): NoiseSuppressionMode {
  if (isNoiseSuppressionMode(mode)) return mode;
  // The old switch disabled RNNoise, not Chromium's built-in suppression.
  return legacyEnabled === false ? 'browser' : 'rnnoise';
}

export const AUDIO_OUTPUT_CATEGORIES = ['voice', 'screen', 'media'] as const;
export type AudioOutputCategory = typeof AUDIO_OUTPUT_CATEGORIES[number];
export type AudioOutputDevices = Record<AudioOutputCategory, string | null>;

export interface AudioOutputPreferences {
  selectedSpeakerId: string;
  advancedAudioOutputs: boolean;
  audioOutputDevices: AudioOutputDevices;
}

export function normalizeAudioOutputId(deviceId: string): string {
  return deviceId === 'default' ? '' : deviceId;
}

export function restoreAudioOutputDevices(value: unknown): AudioOutputDevices {
  const result: AudioOutputDevices = { voice: null, screen: null, media: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const category of AUDIO_OUTPUT_CATEGORIES) {
    const deviceId: unknown = Reflect.get(value, category);
    if (typeof deviceId === 'string') result[category] = normalizeAudioOutputId(deviceId);
  }
  return result;
}

export function resolveAudioOutput(preferences: AudioOutputPreferences, category: AudioOutputCategory): string {
  const override = preferences.advancedAudioOutputs ? preferences.audioOutputDevices[category] : null;
  return normalizeAudioOutputId(override ?? preferences.selectedSpeakerId);
}

export function copyAudioOutputPreferences(preferences: AudioOutputPreferences): AudioOutputPreferences {
  return {
    selectedSpeakerId: normalizeAudioOutputId(preferences.selectedSpeakerId),
    advancedAudioOutputs: preferences.advancedAudioOutputs,
    audioOutputDevices: { ...preferences.audioOutputDevices },
  };
}
