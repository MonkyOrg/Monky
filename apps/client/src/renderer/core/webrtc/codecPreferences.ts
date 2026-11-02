/**
 * Camera codec order for WebRTC peer connections and SFU producers. Only the
 * order of the offered codecs changes, so a call can still negotiate a
 * fallback.
 *
 * The order depends on how many encoders the camera runs, not on the quality
 * preset (#835). In P2P every peer has its own encoder, and AV1 is encoded on
 * the CPU: four peers at 720p measured 2.3 cores in AV1 against 0.9 in H.264,
 * which the GPU encodes. An SFU call runs a single encoder, cheap even in AV1,
 * so it keeps the codec with the best quality per kbps.
 *
 * There is no user choice here: the camera codec selector left with #717, and
 * a choice saved before then must not keep deciding the codec unseen.
 */

export type CameraTransport = 'p2p' | 'sfu';

const CAMERA_CODEC_ORDER: Record<CameraTransport, readonly string[]> = {
  p2p: ['video/h264', 'video/av1', 'video/vp9', 'video/vp8'],
  sfu: ['video/av1', 'video/vp9', 'video/vp8', 'video/h264'],
};

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
 * Among H.264 entries, Baseline 42001f with packetization-mode=1 goes first:
 * it is the profile the Windows hardware encoder (Media Foundation) accepts,
 * while Constrained Baseline 42e01f falls back to OpenH264 on the CPU (#835).
 * Entries without an fmtp line (mediasoup capabilities) keep their order.
 */
function h264ProfileRank(codec: CodecCapabilityLike): number {
  const fmtp = codec.sdpFmtpLine;
  if (fmtp === undefined || codec.mimeType.toLowerCase() !== 'video/h264') return 0;
  const singleNal = !/(?:^|;)\s*packetization-mode=1(?:;|$)/.test(fmtp);
  if (singleNal) return 2;
  return /(?:^|;)\s*profile-level-id=42001f(?:;|$)/i.test(fmtp) ? 0 : 1;
}

/**
 * Sorts video codec capabilities by the camera order of a transport. Codecs
 * outside it (e.g. rtx, red, ulpfec) keep their relative position after the
 * primary codecs.
 */
export function sortVideoCodecs<T extends CodecCapabilityLike>(codecs: T[], transport: CameraTransport): T[] {
  const priorityList = CAMERA_CODEC_ORDER[transport];
  const getPriority = (codec: T): number => {
    const index = priorityList.indexOf(codec.mimeType.toLowerCase());
    return index !== -1 ? index : 999;
  };
  return [...codecs].sort((a, b) => getPriority(a) - getPriority(b) || h264ProfileRank(a) - h264ProfileRank(b));
}

/** The video codecs this runtime can send, in the P2P camera order. */
export function getPrioritizedVideoCodecs(): RTCRtpCodec[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return [];
  }
  return sortVideoCodecs(compatibleSendingVideoCodecs(), 'p2p');
}

/**
 * Orders the codecs of local video senders of a P2P link. Remote-only
 * transceivers keep the remote sender's choices.
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
