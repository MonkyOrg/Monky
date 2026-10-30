/**
 * Voice activity, measured the same way by the call's gate (AudioProcessor) and
 * by the level meter of the settings, so what the user calibrates is what the
 * call does. Pure: the callers own their analysers and their loops.
 */

/** Bins of a 256-point FFT at 48 kHz that hold speech: up to 6.75 kHz. */
const SPEECH_BINS = 36;
/** Top of the sensitivity slider. */
export const VAD_SENSITIVITY_MAX = 160;

export interface SpeechLevel {
  /** Mean magnitude (0-255) of the speech bins. */
  average: number;
  /** Strongest speech bin (0-255). */
  peak: number;
}

/** The speech band of a snapshot from `AnalyserNode.getByteFrequencyData`. */
export function speechLevel(bins: Uint8Array): SpeechLevel {
  const count = Math.min(SPEECH_BINS, bins.length);
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < count; index++) {
    sum += bins[index];
    if (bins[index] > peak) peak = bins[index];
  }
  return { average: count ? sum / count : 0, peak };
}

/** The saved sensitivity within the slider's range; an unreadable value is the most sensitive. */
export function vadSensitivity(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(VAD_SENSITIVITY_MAX, value)) : 0;
}

/**
 * Whether a level is speech at this sensitivity: calibrated to filter background
 * hiss while activating reliably when talking.
 */
export function isVoiceActive({ average, peak }: SpeechLevel, sensitivity: number): boolean {
  const threshold = vadSensitivity(sensitivity);
  const targetAverage = Math.max(16, threshold * 0.8);
  const targetPeak = Math.max(42, threshold * 1.8);
  return (average > targetAverage && peak > targetPeak) || average > targetAverage * 1.4;
}
