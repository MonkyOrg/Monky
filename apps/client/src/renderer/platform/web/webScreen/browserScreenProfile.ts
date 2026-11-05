import { getScreenShareProfile, nativeScreenVideoProfileSchema, type NativeScreenVideoProfile } from '@monky/shared';

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

/** H.264 Main in non-interleaved mode: what every screen receiver, native or browser, decodes. */
export function isScreenH264(codec: CodecCapability): boolean {
  return codec.mimeType.toLowerCase() === 'video/h264' && /^4d[0-9a-f]{4}$/i.test(fmtp(codec, 'profile-level-id') ?? '')
    && fmtp(codec, 'packetization-mode') === '1';
}

/**
 * The video codecs a browser screen sender offers, in order: H.264 Main and its retransmission. Viewers
 * accept nothing else for a source announced as H.264, so an empty list means this browser cannot share.
 */
export function screenSenderCodecs<T extends CodecCapability>(codecs: readonly T[]): T[] {
  const h264 = codecs.filter(isScreenH264);
  if (!h264.length) return [];
  return [...h264, ...codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/rtx')];
}
