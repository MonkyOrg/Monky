import {
  getScreenH264ProfileLevelId, getScreenAv1MinimumLevelIndex, type NativeScreenVideoProfile, type ScreenCodec,
} from '@monky/shared';

export class BrowserScreenCodecError extends Error {}

const fmtpParameters = (value: string): Record<string, string> => Object.fromEntries(value.split(';').flatMap(part => {
  const at = part.indexOf('=');
  return at === -1 ? [] : [[part.slice(0, at).trim(), part.slice(at + 1).trim()]];
}));

export function supportsBrowserAv1Level(
  video: Readonly<NativeScreenVideoProfile>, parameters: Readonly<Record<string, unknown>>,
): boolean {
  const integer = (key: string, fallback: number, maximum: number): number | null => {
    const raw = parameters[key];
    const value = raw === undefined ? fallback : typeof raw === 'number' ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  };
  // AV1 RTP §7.2 defaults: profile=0, level-idx=5 (3.1), tier=0. Never inflate Chromium's advertised level.
  const profile = integer('profile', 0, 2), level = integer('level-idx', 5, 23), tier = integer('tier', 0, 1);
  return profile !== null && level !== null && tier !== null && level >= getScreenAv1MinimumLevelIndex(video);
}

export async function supportsBrowserScreenCodec(
  profile: Readonly<NativeScreenVideoProfile>, selected: ScreenCodec = 'h264',
): Promise<boolean> {
  const main = RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec =>
    selected === 'av1' ? codec.mimeType.toLowerCase() === 'video/av1'
      && supportsBrowserAv1Level(profile, fmtpParameters(codec.sdpFmtpLine ?? ''))
      : codec.mimeType.toLowerCase() === 'video/h264'
      && /(?:^|;)\s*profile-level-id=4d[0-9a-f]{4}(?:;|$)/i.test(codec.sdpFmtpLine ?? '')
      && /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(codec.sdpFmtpLine ?? ''));
  if (!main || !navigator.mediaCapabilities?.decodingInfo) return false;
  const capability = await navigator.mediaCapabilities.decodingInfo({
    type: 'webrtc',
    video: {
      contentType: selected === 'av1' ? `video/AV1;profile=0;level-idx=${getScreenAv1MinimumLevelIndex(profile)};tier=0`
        : `video/H264;profile-level-id=${getScreenH264ProfileLevelId(profile)};packetization-mode=1`,
      width: profile.width, height: profile.height, framerate: profile.fps, bitrate: profile.maxBitrateKbps * 1000,
    },
  });
  return capability.supported;
}

export function assertBrowserScreenCodec(
  sdp: string, selected: ScreenCodec, profile?: Readonly<NativeScreenVideoProfile>,
): void {
  const videoSections = sdp.split(/(?=^m=)/m).filter(section => section.startsWith('m=video '));
  for (const section of videoSections) {
    const [media, ...lines] = section.split(/\r?\n/);
    if (media.split(' ')[1] === '0') continue;
    const payloads = new Set(media.split(' ').slice(3));
    const mediaCodecs = lines.flatMap(line => {
      const match = /^a=rtpmap:(\d+) ([^/]+)/.exec(line);
      return match && payloads.has(match[1]) && !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(match[2].toLowerCase())
        ? [match[2].toLowerCase()] : [];
    });
    if (!mediaCodecs.length || mediaCodecs.some(codec => codec !== selected))
      throw new Error(`The negotiated screen video codec does not match the advertised ${selected.toUpperCase()} source.`);
    if (selected === 'av1' && profile) {
      for (const line of lines) {
        const codec = /^a=rtpmap:(\d+) AV1\//i.exec(line);
        if (!codec || !payloads.has(codec[1])) continue;
        const fmtp = lines.find(value => value.startsWith(`a=fmtp:${codec[1]} `));
        if (!supportsBrowserAv1Level(profile, fmtpParameters(fmtp?.slice(fmtp.indexOf(' ') + 1) ?? '')))
          throw new BrowserScreenCodecError('The negotiated AV1 receive level is insufficient for the selected screen profile.');
      }
    }
  }
}

/**
 * The `max-recv-level` an H.264 Main receiver advertises for a screen profile,
 * or null when the level it already offers decodes it (RFC 6184). P2P writes it
 * into the answer and the SFU into the consumer's capabilities: one rule, so a
 * high-resolution screen never decodes on one transport and fails on the other.
 *
 * Only raised after the WebRTC decoder capability probe; Chromium's own
 * profile and level are kept rather than pretending another was negotiated.
 */
export function h264MaxReceiveLevel(profileLevelId: unknown, video: Readonly<NativeScreenVideoProfile>): string | null {
  const receiveLevel = getScreenH264ProfileLevelId(video).slice(2);
  return typeof profileLevelId === 'string' && /^4d[0-9a-f]{4}$/i.test(profileLevelId)
    && Number.parseInt(profileLevelId.slice(4), 16) < Number.parseInt(receiveLevel.slice(2), 16) ? receiveLevel : null;
}

export function withBrowserScreenReceiveParameters(
  sdp: string, stereo: boolean, profile: Readonly<NativeScreenVideoProfile>,
  selected: ScreenCodec = 'h264',
): string {
  let media = '';
  const codecs = new Map<string, string>();
  return sdp.split('\r\n').map(line => {
    if (line.startsWith('m=')) { media = line.slice(2).split(' ')[0]; codecs.clear(); }
    const codec = /^a=rtpmap:(\d+) ([^/]+)/.exec(line);
    if (codec) codecs.set(codec[1], codec[2].toLowerCase());
    const fmtp = /^a=fmtp:(\d+) (.+)$/.exec(line);
    if (!fmtp) return line;
    const kind = codecs.get(fmtp[1]);
    const parameters = new Map(fmtp[2].split(';').map(value => {
      const at = value.indexOf('=');
      return at < 0 ? [value.trim(), ''] : [value.slice(0, at).trim(), value.slice(at + 1).trim()];
    }));
    const maxReceiveLevel = selected === 'h264' && media === 'video' && kind === 'h264'
      ? h264MaxReceiveLevel(parameters.get('profile-level-id'), profile) : null;
    if (maxReceiveLevel) {
      parameters.set('max-recv-level', maxReceiveLevel);
    } else if (media === 'audio' && kind === 'opus' && stereo) {
      parameters.set('stereo', '1');
    } else return line;
    return `a=fmtp:${fmtp[1]} ${[...parameters].map(([key, value]) => value ? `${key}=${value}` : key).join(';')}`;
  }).join('\r\n');
}
