import {
  screenFormatSchema, getScreenShareProfile, nativeScreenVideoProfileSchema,
  type ScreenFormat, type NativeScreenVideoProfile,
} from '@monky/shared';

/** What a captured video track reports of itself (`MediaStreamTrack.getSettings()`). */
export interface CapturedVideoSettings {
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
}

/**
 * The largest rendition a browser capture announces (#858): the chosen quality, shrunk to the captured
 * surface without changing its shape and never enlarged, so viewers never ask for pixels nobody captured.
 */
export function browserScreenProfile(
  requested: Readonly<NativeScreenVideoProfile>, captured: CapturedVideoSettings,
): Readonly<NativeScreenVideoProfile> {
  const limit = nativeScreenVideoProfileSchema.parse(requested);
  const measured = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
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
