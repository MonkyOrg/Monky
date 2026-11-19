import {
  getScreenShareProfile, type NativeScreenVideoProfile, type ScreenCodec, type ScreenShareQuality,
} from '@monky/shared';
import type { CapturedVideoSettings } from './browserScreenProfile';

/**
 * The frame an upright source's rendition encodes in: the quality's limits applied long side to long side.
 * The announced profile keeps the protocol's landscape limits, so every peer still names the rendition alike,
 * but encoding inside it squeezed an iPhone's 480p down to 220×480.
 */
export function renditionFrame(
  source: Readonly<NativeScreenVideoProfile>, quality: ScreenShareQuality, codec: ScreenCodec = 'h264',
): Readonly<NativeScreenVideoProfile> {
  if (source.height <= source.width) return getScreenShareProfile(source, quality, codec);
  const turned = getScreenShareProfile({ ...source, width: source.height, height: source.width }, quality, codec);
  return Object.freeze({ ...turned, width: turned.height, height: turned.width });
}

/**
 * The size limits that hold a capture inside its rendition in the orientation it has now. A rendition is a
 * size, not a landscape or upright frame: a phone turned sideways keeps the same pixels, rotated.
 */
export function renditionConstraints(
  captured: CapturedVideoSettings, profile: Readonly<NativeScreenVideoProfile>,
): MediaTrackConstraints {
  const long = Math.max(profile.width, profile.height);
  const short = Math.min(profile.width, profile.height);
  const upright = (captured.height ?? 0) > (captured.width ?? 0);
  return {
    width: { max: upright ? short : long }, height: { max: upright ? long : short }, frameRate: { max: profile.fps },
  };
}

const sizeOf = (settings: CapturedVideoSettings): string => `${settings.width ?? 0}x${settings.height ?? 0}`;

/**
 * Tells when a capture changes size, as a phone that turns does. Safari fires no event on the track itself,
 * so its settings are read on a light interval until `signal` aborts.
 */
export function watchCaptureSize(
  track: Pick<MediaStreamTrack, 'getSettings' | 'readyState'>, onResize: (settings: CapturedVideoSettings) => void,
  signal: AbortSignal, intervalMs = 1000,
): void {
  if (signal.aborted) return;
  let last = sizeOf(track.getSettings());
  const timer = setInterval(() => {
    if (track.readyState === 'ended') return;
    const settings = track.getSettings();
    const size = sizeOf(settings);
    if (size === last) return;
    last = size;
    onResize(settings);
  }, intervalMs);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
