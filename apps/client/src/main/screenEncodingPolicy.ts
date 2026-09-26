import type {
  ScreenCodec, ScreenCodecPreference, ScreenEncoder, ScreenEncodingAvailability, ScreenEncodingMode, ScreenEncodingSelection,
  ScreenEncodingStrategy,
} from '@monky/shared';

const hardwareEncoders: Readonly<Record<ScreenCodec, readonly ScreenEncoder[]>> = {
  av1: ['av1_texture_amf', 'obs_nvenc_av1_tex'],
  h264: ['h264_texture_amf', 'obs_nvenc_h264_tex'],
};

/** Only a positive unsupported diagnosis permits falling back to software. */
export function isUnsupportedScreenEncoder(error: unknown): boolean {
  if (error instanceof AggregateError) return false; // Retirement/driver errors must remain actionable.
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && [
    'ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED', 'ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED',
    'ERR_SCREEN_CAPTURE_NO_ENCODER', 'ERR_SCREEN_CAPTURE_ENCODER_UNAVAILABLE',
  ].includes(error.code);
}

export async function selectScreenEncoding(
  strategy: ScreenEncodingStrategy, mode: ScreenEncodingMode, preference: ScreenCodecPreference, compiled: readonly ScreenEncoder[],
  probe: (selection: ScreenEncodingSelection) => Promise<void>, inspectHardware = true,
  onHardwareProbeFailure: (selection: ScreenEncodingSelection, error: Error) => void = (selection) => {
    console.warn('[ScreenShare] Hardware encoder probe failed; trying another hardware candidate:', selection.encoder);
  },
): Promise<ScreenEncodingAvailability> {
  if (strategy === 'manual' && preference === 'auto') throw new Error('Manual encoding requires an exact codec.');
  if (strategy === 'automatic') { mode = 'hardware'; preference = 'auto'; }
  let hardware: ScreenEncodingSelection | null = null;
  let hardwareError = false;
  let hardwareFailure: Error | null = null;
  let reason = 'No compatible hardware encoder is compiled into this runtime.';
  if (mode === 'hardware' || inspectHardware) {
    discovery: for (const codec of preference === 'auto' ? ['av1', 'h264'] as const : [preference]) {
      for (const encoder of hardwareEncoders[codec]) {
        if (!compiled.includes(encoder)) continue;
        const candidate: ScreenEncodingSelection = { mode: 'hardware', codec, encoder };
        try { await probe(candidate); hardware = candidate; break; }
        catch (error) {
          if (!isUnsupportedScreenEncoder(error)) {
            if (strategy === 'automatic' && error instanceof Error && !(error instanceof AggregateError)
              && 'code' in error && [
                'ERR_SCREEN_CAPTURE_AMF_UNAVAILABLE', 'ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE',
                'ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION',
              ].includes(String(error.code))) {
              // The source-free probe returns these only after proving retirement.
              // A failed AV1 candidate must not prevent a real H264 hardware probe.
              onHardwareProbeFailure(candidate, error);
              hardwareFailure ??= error;
              continue;
            }
            if (mode !== 'software' || error instanceof AggregateError
              || (error instanceof Error && error.name === 'AbortError')) throw error;
            hardwareError = true;
            reason = error instanceof Error ? error.message.slice(0, 1024) : 'Hardware verification failed.';
            break discovery;
          }
          reason = error instanceof Error ? error.message.slice(0, 1024) : 'Hardware encoder is unsupported.';
        }
      }
      if (hardware) break;
    }
  }
  const hardwareAvailability = { available: !!hardware, reason: hardware ? null : reason,
    ...(hardwareError ? { error: true } : {}) };
  if (mode === 'hardware' && hardware)
    return { selection: hardware, hardware: { available: true, reason: null }, fallback: false };
  if (hardwareFailure) throw hardwareFailure;
  if (strategy === 'manual' && mode === 'hardware')
    return { selection: null, hardware: hardwareAvailability, fallback: false, reason };
  const codec = preference === 'av1' ? 'av1' : 'h264';
  const encoder = codec === 'av1' ? 'monky_aom_av1' : 'obs_x264';
  const selection: ScreenEncodingSelection = { mode: 'software', codec, encoder };
  if (!compiled.includes(encoder))
    return { selection: null, hardware: hardwareAvailability, fallback: false, reason: 'The selected software encoder is not compiled into this runtime.' };
  try { await probe(selection); }
  catch (error) {
    if (!isUnsupportedScreenEncoder(error)) throw error;
    return { selection: null, hardware: hardwareAvailability, fallback: false,
      reason: error instanceof Error ? error.message.slice(0, 1024) : 'The selected software encoder is unsupported.' };
  }
  return { selection, hardware: hardwareAvailability, fallback: mode === 'hardware' };
}
