import { isMotionQualityPreset } from '@monky/shared';
import { settingsStore } from '../../stores/settingsStore';

/**
 * Camera codec prioritization for WebRTC peer connections. A preference only
 * reorders the offered codecs, so the call can still negotiate a fallback:
 * - auto: AV1 -> VP9 -> VP8 -> H.264, except on 60+ FPS presets (see below)
 * - av1 / vp9 / vp8 / h264: that codec first, then the automatic order
 */

export type PreferredVideoCodec = 'auto' | 'av1' | 'vp9' | 'vp8' | 'h264';

export const VIDEO_CODEC_PRIORITY_ORDER = [
  'video/av1',
  'video/vp9',
  'video/vp8',
  'video/h264',
] as const;

export interface CodecCapabilityLike {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
  preferredPayloadType?: number;
  payloadType?: number;
}

function compatibleSendingVideoCodecs(): RTCRtpCodec[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpReceiver === 'undefined'
    || typeof RTCRtpSender.getCapabilities !== 'function' || typeof RTCRtpReceiver.getCapabilities !== 'function') return [];
  const send = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const receive = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  // Use encodable capabilities that setCodecPreferences also accepts. In
  // Electron 34 H.264 High is 640020 on send but 64001f on receive; passing
  // the unfiltered send list rejects the entire setting.
  return send.filter((codec) => receive.some((other) =>
    codec.mimeType.toLowerCase() === other.mimeType.toLowerCase()
    && codec.clockRate === other.clockRate && codec.channels === other.channels
    && codec.sdpFmtpLine === other.sdpFmtpLine));
}

/**
 * Whether "auto" should favour a codec the GPU can encode instead of the one
 * with the best compression.
 *
 * AV1 and VP9 have no hardware encoder on most desktops, so WebRTC encodes them
 * on the CPU — at 1080p60 that is enough work to steal frames from the game
 * being shared (#526). H.264 is the only codec with near-universal NVENC /
 * QuickSync / AMF support, which is also what Discord and OBS lean on. Every
 * named preset from 60 FPS up (1080p60 to 4K120) is at least that demanding.
 */
export function shouldPreferHardwareEncoding(): boolean {
  const preset = settingsStore?.qualityPreset;
  return preset !== undefined && isMotionQualityPreset(preset);
}

export function getPriorityListForCodec(
  preferred: PreferredVideoCodec,
  preferHardwareEncoding = false
): string[] {
  switch (preferred) {
    case 'av1':
      return ['video/av1', 'video/vp9', 'video/vp8', 'video/h264'];
    case 'vp9':
      return ['video/vp9', 'video/av1', 'video/vp8', 'video/h264'];
    case 'vp8':
      return ['video/vp8', 'video/av1', 'video/vp9', 'video/h264'];
    case 'h264':
      return ['video/h264', 'video/av1', 'video/vp9', 'video/vp8'];
    case 'auto':
    default:
      return preferHardwareEncoding
        ? ['video/h264', 'video/av1', 'video/vp9', 'video/vp8']
        : ['video/av1', 'video/vp9', 'video/vp8', 'video/h264'];
  }
}

/**
 * Sorts an array of WebRTC video codec capabilities according to the preference order.
 * Codecs not explicitly listed (e.g. rtx, red, ulpfec) maintain their relative position after primary codecs.
 */
export function sortVideoCodecs<T extends CodecCapabilityLike>(
  codecs: T[],
  preferred: PreferredVideoCodec = 'auto',
  preferHardwareEncoding = false
): T[] {
  const priorityList = getPriorityListForCodec(preferred, preferHardwareEncoding);
  const getPriority = (mimeType: string): number => {
    const lower = mimeType.toLowerCase();
    const index = priorityList.findIndex((pref) => lower === pref);
    return index !== -1 ? index : 999;
  };

  return [...codecs].sort((a, b) => {
    const prioA = getPriority(a.mimeType);
    const prioB = getPriority(b.mimeType);
    return prioA - prioB;
  });
}

/**
 * Retrieves the supported video codecs from the WebRTC runtime, sorted by preference.
 */
export function getPrioritizedVideoCodecs(
  preferred: PreferredVideoCodec = settingsStore?.preferredVideoCodec ?? 'auto'
): RTCRtpCodec[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return [];
  }
  return sortVideoCodecs(compatibleSendingVideoCodecs(), preferred, shouldPreferHardwareEncoding());
}

/**
 * Orders the codecs of local video senders. Remote-only transceivers keep the
 * remote sender's choices.
 */
export function applyVideoCodecPreferences(
  pc: RTCPeerConnection,
  preferred: PreferredVideoCodec = settingsStore?.preferredVideoCodec ?? 'auto',
): void {
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.sender.track?.kind !== 'video') continue;
    const codecs = getPrioritizedVideoCodecs(preferred);
    if (!codecs.length) continue;
    try {
      transceiver.setCodecPreferences(codecs);
    } catch {
      // A preference is best-effort: the default order still negotiates.
    }
  }
}
