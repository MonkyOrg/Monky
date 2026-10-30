import { isMotionQualityPreset } from '@monky/shared';
import { settingsStore } from '../../stores/settingsStore';

/**
 * Camera codec order for WebRTC peer connections and SFU producers. Only the
 * order of the offered codecs changes, so a call can still negotiate a
 * fallback: AV1 -> VP9 -> VP8 -> H.264, or H.264 first on 60+ FPS presets.
 *
 * There is no user choice here: the camera codec selector left with #717, and
 * a choice saved before then must not keep deciding the codec unseen.
 */

const COMPRESSION_FIRST = ['video/av1', 'video/vp9', 'video/vp8', 'video/h264'] as const;
const HARDWARE_FIRST = ['video/h264', 'video/av1', 'video/vp9', 'video/vp8'] as const;

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
 * Whether the camera should favour a codec the GPU can encode instead of the
 * one with the best compression.
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

/**
 * Sorts video codec capabilities by the camera order. Codecs outside it (e.g.
 * rtx, red, ulpfec) keep their relative position after the primary codecs.
 */
export function sortVideoCodecs<T extends CodecCapabilityLike>(codecs: T[], preferHardwareEncoding = false): T[] {
  const priorityList: readonly string[] = preferHardwareEncoding ? HARDWARE_FIRST : COMPRESSION_FIRST;
  const getPriority = (mimeType: string): number => {
    const index = priorityList.indexOf(mimeType.toLowerCase());
    return index !== -1 ? index : 999;
  };
  return [...codecs].sort((a, b) => getPriority(a.mimeType) - getPriority(b.mimeType));
}

/** The video codecs this runtime can send, in the camera order. */
export function getPrioritizedVideoCodecs(): RTCRtpCodec[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return [];
  }
  return sortVideoCodecs(compatibleSendingVideoCodecs(), shouldPreferHardwareEncoding());
}

/**
 * Orders the codecs of local video senders. Remote-only transceivers keep the
 * remote sender's choices.
 */
export function applyVideoCodecPreferences(pc: RTCPeerConnection): void {
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.sender.track?.kind !== 'video') continue;
    const codecs = getPrioritizedVideoCodecs();
    if (!codecs.length) continue;
    try {
      transceiver.setCodecPreferences(codecs);
    } catch {
      // A preference is best-effort: the default order still negotiates.
    }
  }
}

/**
 * Puts one codec first on every local video sender, the rest of the encodable
 * list following as a fallback. For a link where the encoder, not bandwidth,
 * is the cost: the overlay's loopback measured cheapest with VP8 (R-MEDIA-2).
 */
export function preferVideoCodec(pc: RTCPeerConnection, mimeType: string): void {
  const target = mimeType.toLowerCase();
  const codecs = compatibleSendingVideoCodecs();
  const ordered = [
    ...codecs.filter((codec) => codec.mimeType.toLowerCase() === target),
    ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== target),
  ];
  if (!ordered.length) return;
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.sender.track?.kind !== 'video') continue;
    try {
      transceiver.setCodecPreferences(ordered);
    } catch {
      // A preference is best-effort: the default order still negotiates.
    }
  }
}
