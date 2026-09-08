import { settingsStore } from '../../stores/settingsStore';

/**
 * Video codec prioritization for WebRTC peer connections.
 *
 * Supports user-customizable preferred codecs with automatic hardware fallback:
 * - auto: prioritized as AV1 -> VP9 -> VP8 -> H.264, except on the Gaming preset
 *   (see below)
 * - av1 / vp9 / vp8 / h264: places chosen codec first, keeping all others as fallback
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
}

/**
 * Whether "auto" should favour a codec the GPU can encode instead of the one
 * with the best compression.
 *
 * AV1 and VP9 have no hardware encoder on most desktops, so WebRTC encodes them
 * on the CPU — at 1080p60 that is enough work to steal frames from the game
 * being shared (#526). H.264 is the only codec with near-universal NVENC /
 * QuickSync / AMF support, which is also what Discord and OBS lean on.
 */
export function shouldPreferHardwareEncoding(): boolean {
  return settingsStore?.qualityPreset === 'GAMING';
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
): CodecCapabilityLike[] {
  if (typeof RTCRtpReceiver === 'undefined' || typeof (RTCRtpReceiver as any).getCapabilities !== 'function') {
    return [];
  }
  const capabilities = (RTCRtpReceiver as any).getCapabilities('video');
  if (!capabilities || !Array.isArray(capabilities.codecs) || capabilities.codecs.length === 0) {
    return [];
  }
  return sortVideoCodecs(capabilities.codecs, preferred, shouldPreferHardwareEncoding());
}

/**
 * Extracts the ordered list of video codec names from the first `m=video`
 * section of an SDP, in the payload-type order that actually drives codec
 * selection. Purely diagnostic: it lets us see which codec a (re)negotiation
 * prioritised at runtime, e.g. to catch H.264 falling back to AV1 after a
 * SFU -> P2P switch (#566). Supporting codecs (rtx/red/ulpfec/flexfec) are
 * dropped so only the real video codecs remain.
 */
export function getSdpVideoCodecOrder(sdp: string): string[] {
  if (!sdp) return [];
  const lines = sdp.split(/\r\n|\r|\n/);
  const videoIndex = lines.findIndex((line) => line.startsWith('m=video'));
  if (videoIndex === -1) return [];

  const payloadOrder = lines[videoIndex].split(' ').slice(3);
  const codecNameByPayload = new Map<string, string>();
  for (let i = videoIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('m=')) break; // reached the next media section
    const match = /^a=rtpmap:(\d+)\s+([^/]+)\//.exec(lines[i]);
    if (match) codecNameByPayload.set(match[1], match[2].toLowerCase());
  }

  const supporting = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03']);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const payload of payloadOrder) {
    const name = codecNameByPayload.get(payload);
    if (!name || supporting.has(name) || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

/**
 * Applies the prioritized video codecs to all video transceivers on a given RTCPeerConnection.
 */
export function applyVideoCodecPreferences(
  pc: RTCPeerConnection,
  preferred: PreferredVideoCodec = settingsStore?.preferredVideoCodec ?? 'auto'
): void {
  try {
    const prioritizedCodecs = getPrioritizedVideoCodecs(preferred);
    if (prioritizedCodecs.length === 0) return;

    for (const transceiver of pc.getTransceivers()) {
      const isVideo =
        transceiver.receiver?.track?.kind === 'video' ||
        transceiver.sender?.track?.kind === 'video' ||
        (transceiver as any).kind === 'video';

      if (isVideo && typeof (transceiver as any).setCodecPreferences === 'function') {
        try {
          (transceiver as any).setCodecPreferences(prioritizedCodecs);
        } catch {
          // If browser/device rejects the preferences array, leave default negotiation intact
        }
      }
    }
  } catch {
    // Gracefully ignore environments without getTransceivers / setCodecPreferences
  }
}
