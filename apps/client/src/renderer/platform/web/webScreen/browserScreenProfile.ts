import {
  screenFormatSchema, getScreenShareProfile, nativeScreenVideoProfileSchema, compatibleScreenProfile,
  type ScreenFormat, type NativeScreenVideoProfile,
} from '@monky/shared';
import { runsOnWebKit } from '../../../utils/browserEngine';

/** What a captured video track reports of itself (`MediaStreamTrack.getSettings()`). */
export interface CapturedVideoSettings {
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
}

const measured = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * The largest rendition a browser capture announces (#858): the chosen quality, shrunk to the captured
 * surface without changing its shape and never enlarged, so viewers never ask for pixels nobody captured.
 */
export function browserScreenProfile(
  requested: Readonly<NativeScreenVideoProfile>, captured: CapturedVideoSettings,
): Readonly<NativeScreenVideoProfile> {
  const limit = nativeScreenVideoProfileSchema.parse(requested);
  const width = measured(captured.width) ?? limit.width;
  const height = measured(captured.height) ?? limit.height;
  const scale = Math.min(1, limit.width / width, limit.height / height);
  const frameRate = measured(captured.frameRate);
  return getScreenShareProfile(nativeScreenVideoProfileSchema.parse({
    width: Math.max(4, Math.floor(width * scale / 4) * 4),
    height: Math.max(2, Math.floor(height * scale / 2) * 2),
    fps: Math.max(1, Math.min(limit.fps, frameRate === null ? limit.fps : Math.round(frameRate))),
    maxBitrateKbps: limit.maxBitrateKbps,
  }), 'source', 'h264');
}

/** H.264 Level 3.1 (Annex A, table A-1): macroblocks of a frame and of a second, and the bit rate. */
const H264_LEVEL_31 = Object.freeze({ frameMacroblocks: 3600, macroblocksPerSecond: 108000, maxBitrateKbps: 14000 });
const macroblocks = (width: number, height: number): number => Math.ceil(width / 16) * Math.ceil(height / 16);

/**
 * A screen inside H.264 Level 3.1, keeping its shape: 720p at 30 FPS, or the same area in any shape. WebKit
 * sets its H.264 encoder to the level its sender lists, 3.1, and that encoder emits no frame above it: an
 * iPhone's whole screen, or a 1080p one, reached viewers as a picture that never loaded.
 */
export function h264Level31Profile(profile: Readonly<NativeScreenVideoProfile>): Readonly<NativeScreenVideoProfile> {
  const video = nativeScreenVideoProfileSchema.parse(profile);
  let scale = Math.min(1, Math.sqrt(H264_LEVEL_31.frameMacroblocks / macroblocks(video.width, video.height)));
  const fitted = (): { width: number; height: number } => ({
    width: Math.max(4, Math.floor(video.width * scale / 4) * 4),
    height: Math.max(2, Math.floor(video.height * scale / 2) * 2),
  });
  let size = fitted();
  // Rounding up to whole macroblocks can still overshoot the square-root estimate by a row.
  while (macroblocks(size.width, size.height) > H264_LEVEL_31.frameMacroblocks) { scale *= 0.99; size = fitted(); }
  return Object.freeze(nativeScreenVideoProfileSchema.parse({
    ...size,
    fps: Math.max(1, Math.min(video.fps, Math.floor(H264_LEVEL_31.macroblocksPerSecond / macroblocks(size.width, size.height)))),
    maxBitrateKbps: Math.min(video.maxBitrateKbps, H264_LEVEL_31.maxBitrateKbps),
  }));
}

/**
 * The profile a browser capture publishes in `format` (#858): the chosen quality fitted to the capture, the
 * compatible format's frame-rate limit and, on WebKit, the level its encoder works at.
 */
export function browserSourceProfile(
  requested: Readonly<NativeScreenVideoProfile>, captured: CapturedVideoSettings, format: ScreenFormat,
): Readonly<NativeScreenVideoProfile> {
  const fitted = browserScreenProfile(requested, captured);
  const profile = format === 'compatible' ? compatibleScreenProfile(fitted) : fitted;
  return runsOnWebKit() ? h264Level31Profile(profile) : profile;
}

/**
 * How much the encoder shrinks a rendition's copy of the capture. Browsers resize the copy to the rendition
 * through `applyConstraints`, but Safari ignores it and would encode the whole capture, beyond its level; the
 * encoder then scales the copy down to the rendition itself.
 */
export function encoderScaleDown(captured: CapturedVideoSettings, profile: Readonly<NativeScreenVideoProfile>): number {
  const width = measured(captured.width);
  const height = measured(captured.height);
  return width === null || height === null ? 1 : Math.max(1, width / profile.width, height / profile.height);
}

/** The codec entries of `RTCRtpSender.getCapabilities()` this module reads. */
export interface CodecCapability {
  readonly mimeType: string;
  readonly sdpFmtpLine?: string;
}

const fmtp = (codec: CodecCapability, key: string): string | undefined =>
  codec.sdpFmtpLine?.split(';').map(part => part.trim().split('=')).find(([name]) => name === key)?.[1];

/**
 * Whether a sender codec encodes a browser format (#858): H.264 in non-interleaved mode, as Constrained
 * Baseline (42e0..) for `compatible`, which every receiver decodes, or as Main (4d..) for `main`.
 */
export function isScreenCodec(codec: CodecCapability, format: ScreenFormat): boolean {
  const profile = format === 'main' ? /^4d[0-9a-f]{4}$/i : /^42e0[0-9a-f]{2}$/i;
  return codec.mimeType.toLowerCase() === 'video/h264' && profile.test(fmtp(codec, 'profile-level-id') ?? '')
    && fmtp(codec, 'packetization-mode') === '1';
}

/**
 * The video codecs a browser screen sender offers for `format`, in order: the format's codec and its
 * retransmission. An empty list means this browser cannot share in that format.
 */
export function screenSenderCodecs<T extends CodecCapability>(codecs: readonly T[], format: ScreenFormat): T[] {
  const matching = codecs.filter(codec => isScreenCodec(codec, format));
  if (!matching.length) return [];
  return [...matching, ...codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/rtx')];
}

/** The formats this browser can share in, the compatible one first. */
export function browserScreenFormats(codecs: readonly CodecCapability[]): ScreenFormat[] {
  return screenFormatSchema.options.filter(format => screenSenderCodecs(codecs, format).length > 0);
}
