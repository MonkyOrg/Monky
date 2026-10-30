import {
  nativeErrorCodes, type ScreenCodec, type ScreenCodecPreference, type ScreenEncoder, type ScreenEncodingAvailability,
  type ScreenEncodingMode, type ScreenEncodingSelection, type ScreenEncodingStrategy,
} from '@monky/shared';

const hardwareEncoders: Readonly<Record<ScreenCodec, readonly ScreenEncoder[]>> = {
  av1: ['av1_texture_amf', 'obs_nvenc_av1_tex'],
  h264: ['h264_texture_amf', 'obs_nvenc_h264_tex', 'apple_vt_h264'],
};

/** Only a positive unsupported diagnosis permits falling back to software. */
export function isUnsupportedScreenEncoder(error: unknown): boolean {
  if (error instanceof AggregateError) return false; // Retirement/driver errors must remain actionable.
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && [
    'ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED', 'ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED',
    'ERR_SCREEN_CAPTURE_NO_ENCODER', 'ERR_SCREEN_CAPTURE_ENCODER_UNAVAILABLE',
    'ERR_MAC_VIDEO_PROFILE_UNSUPPORTED', 'ERR_MAC_VIDEO_ENCODER_UNSUPPORTED',
  ].includes(error.code);
}

/**
 * Why a hardware candidate was left behind: another candidate is tried next, the encoder is unsupported (software
 * may follow), or verification failed and explicit Software continues without hardware.
 */
export type HardwareRefusal = 'next-candidate' | 'unsupported' | 'failed';

/** Every refused hardware candidate is reported once, so Main logs why a share fell back to software. */
export async function selectScreenEncoding(
  strategy: ScreenEncodingStrategy, mode: ScreenEncodingMode, preference: ScreenCodecPreference, compiled: readonly ScreenEncoder[],
  probe: (selection: ScreenEncodingSelection) => Promise<void>, inspectHardware = true,
  onHardwareProbeFailure: (selection: ScreenEncodingSelection, error: unknown, outcome: HardwareRefusal) => void =
  (selection, _error, outcome) => {
    console.warn(`[ScreenShare] Hardware encoder probe failed (${outcome}):`, selection.encoder);
  },
): Promise<ScreenEncodingAvailability> {
  if (strategy === 'manual' && preference === 'auto') throw new Error('Manual encoding requires an exact codec.');
  if (strategy === 'automatic') { mode = 'hardware'; preference = 'auto'; }
  let hardware: ScreenEncodingSelection | null = null;
  let hardwareError = false;
  let hardwareFailure: Error | null = null;
  let reason = 'No compatible hardware encoder is compiled into this runtime.';
  let reasonCodes: string[] = [];
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
              onHardwareProbeFailure(candidate, error, 'next-candidate');
              hardwareFailure ??= error;
              continue;
            }
            if (mode !== 'software' || error instanceof AggregateError
              || (error instanceof Error && error.name === 'AbortError')) throw error;
            onHardwareProbeFailure(candidate, error, 'failed');
            hardwareError = true;
            reason = error instanceof Error ? error.message.slice(0, 1024) : 'Hardware verification failed.';
            reasonCodes = nativeErrorCodes(error);
            break discovery;
          }
          onHardwareProbeFailure(candidate, error, 'unsupported');
          reason = error instanceof Error ? error.message.slice(0, 1024) : 'Hardware encoder is unsupported.';
          reasonCodes = nativeErrorCodes(error);
        }
      }
      if (hardware) break;
    }
  }
  const hardwareAvailability = { available: !!hardware, reason: hardware ? null : reason,
    ...(!hardware && reasonCodes.length ? { codes: reasonCodes } : {}), ...(hardwareError ? { error: true } : {}) };
  if (mode === 'hardware' && hardware)
    return { selection: hardware, hardware: { available: true, reason: null }, fallback: false };
  if (hardwareFailure) throw hardwareFailure;
  if (strategy === 'manual' && mode === 'hardware')
    return { selection: null, hardware: hardwareAvailability, fallback: false, reason };
  const codec = preference === 'av1' ? 'av1' : 'h264';
  const encoder = codec === 'av1' ? 'monky_aom_av1'
    : compiled.includes('apple_vt_h264_software') ? 'apple_vt_h264_software' : 'obs_x264';
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
