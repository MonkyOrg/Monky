import { settingsStore } from '../../stores/settingsStore';
import { t } from '../../i18n';

/**
 * Video codec prioritization for WebRTC peer connections.
 *
 * Automatic mode can negotiate fallback codecs. An explicit screen codec is
 * a constraint, not just a position in an SDP preference list (#566):
 * - auto: prioritized as AV1 -> VP9 -> VP8 -> H.264, except on the Gaming preset
 *   (see below)
 * - av1 / vp9 / vp8 / h264: screens advertise only that codec and its RTX;
 *   WebRtcManager also selects the outgoing encoder with encodings.codec
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

export class ScreenCodecError extends Error {
  constructor(
    public readonly preferred: PreferredVideoCodec,
    reason: 'unsupported' | 'incompatible' | 'notApplied',
    public override readonly cause?: unknown
  ) {
    const codec = preferred === 'h264' ? 'H.264' : preferred.toUpperCase();
    super(t(`screenCodec.${reason}`, { codec }));
    this.name = 'ScreenCodecError';
  }
}

export function explicitScreenCodecMime(preferred: PreferredVideoCodec): string | null {
  return preferred === 'auto' ? null : `video/${preferred}`;
}

/** Capabilities omit RTX's apt in Chromium; RTP/router capabilities may include it. */
export function selectScreenVideoCodecs<T extends CodecCapabilityLike>(
  codecs: T[],
  preferred: PreferredVideoCodec,
  preferHardwareEncoding = false
): T[] {
  const mime = explicitScreenCodecMime(preferred);
  if (!mime) return sortVideoCodecs(codecs, 'auto', preferHardwareEncoding);
  const primary = codecs.filter((codec) => codec.mimeType.toLowerCase() === mime);
  if (!primary.length) throw new ScreenCodecError(preferred, 'unsupported');
  const payloads = new Set(primary.map((codec) => codec.preferredPayloadType ?? codec.payloadType));
  const repairs = codecs.filter((codec) => {
    if (codec.mimeType.toLowerCase() !== 'video/rtx') return false;
    const apt = /(?:^|;)\s*apt=(\d+)(?:;|$)/i.exec(codec.sdpFmtpLine ?? '');
    return !apt || payloads.has(Number(apt[1]));
  });
  return [...primary, ...repairs];
}

export function getScreenVideoCodecs(
  preferred: PreferredVideoCodec = settingsStore.preferredVideoCodec
): RTCRtpCodec[] {
  const codecs = compatibleSendingVideoCodecs();
  if (!codecs.length && preferred !== 'auto') throw new ScreenCodecError(preferred, 'unsupported');
  return selectScreenVideoCodecs(codecs, preferred, shouldPreferHardwareEncoding());
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
): RTCRtpCodec[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return [];
  }
  return sortVideoCodecs(compatibleSendingVideoCodecs(), preferred, shouldPreferHardwareEncoding());
}

/**
 * Reads one video m-line without modifying the SDP. A MID selects the screen,
 * rather than the first video m-line (usually the camera). Supporting codecs
 * are omitted; codecId-linked RTP stats are still required to prove output.
 */
export function getSdpVideoCodecOrder(sdp: string, mid?: string): string[] {
  if (!sdp) return [];
  const lines = sdp.split(/\r\n|\r|\n/);
  const videoIndex = lines.findIndex((line, index) => {
    if (!line.startsWith('m=video ')) return false;
    if (mid === undefined) return true;
    for (let i = index + 1; i < lines.length && !lines[i].startsWith('m='); i++) {
      if (lines[i] === `a=mid:${mid}`) return true;
    }
    return false;
  });
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
 * Only local screens are constrained. Camera keeps its preference/fallback
 * semantics, and remote-only transceivers keep the remote sender's choices.
 */
export function applyVideoCodecPreferences(
  pc: RTCPeerConnection,
  preferred: PreferredVideoCodec = settingsStore?.preferredVideoCodec ?? 'auto',
  screenSenders: Iterable<RTCRtpSender> = []
): void {
  const screens = new Set(screenSenders);
  for (const transceiver of pc.getTransceivers()) {
    if (screens.has(transceiver.sender)) {
      const codecs = getScreenVideoCodecs(preferred);
      if (preferred === 'auto' && !codecs.length) continue;
      try {
        transceiver.setCodecPreferences(codecs);
      } catch (error) {
        if (preferred === 'auto') {
          try { transceiver.setCodecPreferences([]); } catch {}
          continue;
        }
        throw new ScreenCodecError(preferred, 'notApplied', error);
      }
    } else if (transceiver.sender.track?.kind === 'video') {
      const codecs = getPrioritizedVideoCodecs(preferred);
      if (!codecs.length) continue;
      try {
        transceiver.setCodecPreferences(codecs);
      } catch {
        // Camera remains best-effort; the strict choice belongs to screens.
      }
    }
  }
}

/** Validate the accepted answer's screen m-line, never the camera or capabilities. */
export function assertScreenCodecNegotiated(
  transceiver: RTCRtpTransceiver,
  preferred: PreferredVideoCodec,
  answerSdp: string
): void {
  if (transceiver.mid === null) return;
  const mime = explicitScreenCodecMime(preferred);
  if (!mime) return;
  // This checks compatibility, not the active encoder. On an answerer,
  // Chromium can send a codec from the remote offer that is absent here;
  // the sender must also select its encoding.codec explicitly.
  const primary = getSdpVideoCodecOrder(answerSdp, transceiver.mid);
  if ((transceiver.currentDirection !== 'sendonly' && transceiver.currentDirection !== 'sendrecv')
    || primary.length === 0 || primary.some((codec) => `video/${codec}` !== mime)) {
    throw new ScreenCodecError(preferred, 'incompatible');
  }
}
