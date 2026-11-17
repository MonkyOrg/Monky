import {
  getScreenH264ProfileLevelId, getScreenAv1MinimumLevelIndex, type NativeScreenVideoProfile, type ScreenCodec,
} from '@monky/shared';

export class BrowserScreenCodecError extends Error {
  override name = 'BrowserScreenCodecError';
}

/**
 * Why a browser receiver failed (#858): a screen it cannot decode is `unsupported`, so the viewer is told the
 * format and where to watch it; anything else is the connection. Read by name, as the error crosses modules.
 */
export function browserScreenFailureReason(error: unknown): 'unsupported' | 'connection-failed' {
  return error instanceof Error && error.name === 'BrowserScreenCodecError' ? 'unsupported' : 'connection-failed';
}

const fmtpParameters = (value: string): Record<string, string> => Object.fromEntries(value.split(';').flatMap(part => {
  const at = part.indexOf('=');
  return at === -1 ? [] : [[part.slice(0, at).trim(), part.slice(at + 1).trim()]];
}));

interface Av1Parameters { profile: number; level: number; tier: number }

function av1Parameters(parameters: Readonly<Record<string, unknown>>): Av1Parameters | null {
  const integer = (key: string, fallback: number, maximum: number): number | null => {
    const raw = parameters[key];
    const value = raw === undefined ? fallback : typeof raw === 'number' ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  };
  // AV1 RTP §7.2 defaults: profile=0, level-idx=5 (3.1), tier=0.
  const profile = integer('profile', 0, 2), level = integer('level-idx', 5, 23), tier = integer('tier', 0, 1);
  return profile === null || level === null || tier === null ? null : { profile, level, tier };
}

export function supportsBrowserAv1Level(
  video: Readonly<NativeScreenVideoProfile>, parameters: Readonly<Record<string, unknown>>,
): boolean {
  const av1 = av1Parameters(parameters);
  return av1 !== null && av1.level >= getScreenAv1MinimumLevelIndex(video);
}

/**
 * The AV1 `level-idx` a receiver advertises for a screen profile, or null when
 * the level it already offers covers it. Chromium always advertises libwebrtc's
 * default, level 3.1, although its decoder (dav1d) decodes the higher levels
 * that `mediaCapabilities` reports, 1080p60 included. Like `h264MaxReceiveLevel`,
 * it is raised only after that WebRTC decoder probe admitted the profile.
 */
export function av1ReceiveLevel(parameters: Readonly<Record<string, unknown>>, video: Readonly<NativeScreenVideoProfile>): number | null {
  const av1 = av1Parameters(parameters);
  const minimum = getScreenAv1MinimumLevelIndex(video);
  return av1 !== null && av1.level < minimum ? minimum : null;
}

const h264Receiver = (codec: { mimeType: string; sdpFmtpLine?: string }, profile: RegExp): boolean =>
  codec.mimeType.toLowerCase() === 'video/h264'
  && profile.test(/(?:^|;)\s*profile-level-id=([0-9a-f]{6})(?:;|$)/i.exec(codec.sdpFmtpLine ?? '')?.[1] ?? '')
  && /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(codec.sdpFmtpLine ?? '');

/**
 * Whether this browser plays H.264 Main through its Constrained High receiver. Safari, on the iPhone and iPad
 * included, lists Constrained High (`640c`) but not Main, although its hardware decoder plays Main. The Main
 * that screens send is real time, progressive and without B-frames (WebRTC, and the desktop's encoders with
 * frame reordering off), a stream Constrained High covers. Such a receiver negotiates the screen's Main
 * payloads under the Constrained High name and answers with the original profile (`aliasH264MainOffer`).
 */
export function browserAliasesH264Main(): boolean {
  const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  return !codecs.some(codec => h264Receiver(codec, /^4d/i)) && codecs.some(codec => h264Receiver(codec, /^640c/i));
}

/** Whether this browser receives H.264 Main, what the desktop app and the web's better format send. */
export function browserReceivesH264Main(): boolean {
  return RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec => h264Receiver(codec, /^4d/i))
    || browserAliasesH264Main();
}

/** The payload types renamed from H.264 Main to Constrained High, each with the Main `profile_idc` and `profile-iop` it had. */
export type H264MainAliases = ReadonlyMap<number, string>;

/** A Main `profile-level-id` under the Constrained High name, at the same level; null when it is not Main. */
export function aliasH264MainProfile(profileLevelId: unknown): string | null {
  return typeof profileLevelId === 'string' && /^4d[0-9a-f]{4}$/i.test(profileLevelId) ? `640c${profileLevelId.slice(4)}` : null;
}

/** The Main `profile-level-id` back from its Constrained High alias, keeping the level the receiver chose. */
export function restoreH264MainProfile(profileLevelId: unknown, main: string): string | null {
  return typeof profileLevelId === 'string' && /^640c[0-9a-f]{2}$/i.test(profileLevelId)
    ? `${main.slice(0, 4)}${profileLevelId.slice(4)}` : null;
}

function rewriteH264Profiles(sdp: string, rewrite: (payload: number, profileLevelId: string) => string | null): string {
  let video = false;
  const h264 = new Set<string>();
  return sdp.split('\r\n').map(line => {
    if (line.startsWith('m=')) { video = line.startsWith('m=video '); h264.clear(); }
    const codec = /^a=rtpmap:(\d+) H264\//i.exec(line);
    if (codec) h264.add(codec[1]);
    const fmtp = video ? /^a=fmtp:(\d+) (.+)$/.exec(line) : null;
    if (!fmtp || !h264.has(fmtp[1])) return line;
    return `a=fmtp:${fmtp[1]} ${fmtp[2].replace(/(^|;)(\s*profile-level-id=)([0-9a-f]{6})(?=;|$)/i,
      (match: string, start: string, key: string, value: string) => {
        const next = rewrite(Number(fmtp[1]), value);
        return next ? `${start}${key}${next}` : match;
      })}`;
  }).join('\r\n');
}

/** A screen offer whose H.264 Main payloads read as Constrained High, for a receiver that aliases Main. */
export function aliasH264MainOffer(sdp: string): { sdp: string; aliases: H264MainAliases } {
  const aliases = new Map<number, string>();
  const aliased = rewriteH264Profiles(sdp, (payload, profileLevelId) => {
    const alias = aliasH264MainProfile(profileLevelId);
    if (alias) aliases.set(payload, profileLevelId.slice(0, 4));
    return alias;
  });
  return { sdp: aliased, aliases };
}

/** The answer to an aliased offer as the publisher must read it: its payloads back under their Main profile. */
export function restoreH264MainAnswer(sdp: string, aliases: H264MainAliases): string {
  if (!aliases.size) return sdp;
  return rewriteH264Profiles(sdp, (payload, profileLevelId) => {
    const main = aliases.get(payload);
    return main ? restoreH264MainProfile(profileLevelId, main) : null;
  });
}

/** H.264 Level 5.2, the highest WebKit's WebRTC reads: 4K at 60 FPS. */
const H264_HIGHEST_WEBKIT_LEVEL = 0x34;

/**
 * A remote description whose H.264 levels above 5.2 read as 5.2. WebKit's SDP parser predates Level 6 and
 * drops a codec offered at it, so Safari, sharing to a desktop viewer whose renegotiation offers its Level 6
 * receiver, rejected its own screen and failed the answer. A viewer's level only bounds what it is sent,
 * which a browser screen never takes above 5.2.
 */
export function withH264LevelsWebKitReads(sdp: string): string {
  return rewriteH264Profiles(sdp, (_payload, profileLevelId) =>
    Number.parseInt(profileLevelId.slice(4), 16) > H264_HIGHEST_WEBKIT_LEVEL
      ? `${profileLevelId.slice(0, 4)}${H264_HIGHEST_WEBKIT_LEVEL.toString(16)}` : null);
}

/**
 * Whether this browser's WebRTC receiver lists the codec of Monky screens at all: AV1 profile 0, or H.264 as
 * Main or as the Constrained Baseline the web shares by default (Firefox lists only the latter; Safari aliases Main).
 */
export function browserReceivesScreenCodec(selected: ScreenCodec = 'h264'): boolean {
  return RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec =>
    selected === 'av1' ? codec.mimeType.toLowerCase() === 'video/av1'
      && av1Parameters(fmtpParameters(codec.sdpFmtpLine ?? ''))?.profile === 0
      : h264Receiver(codec, /^(4d|42e0)/i)) ?? false;
}

/**
 * What to tell a browser about a screen in `codec` it could not decode: `unwatchable`, a format it does not
 * decode (Firefox facing H.264 Main or AV1), so it watches elsewhere or asks for the compatible
 * format; `switch`, another codec the publisher can change to the H.264 it receives; `null`, nothing codec-specific.
 */
export function browserScreenRefusal(codec: ScreenCodec): 'unwatchable' | 'switch' | null {
  const main = browserReceivesH264Main();
  if (codec !== 'h264' && main) return 'switch';
  if (!main || !browserReceivesScreenCodec(codec)) return 'unwatchable';
  return null;
}

export async function supportsBrowserScreenCodec(
  profile: Readonly<NativeScreenVideoProfile>, selected: ScreenCodec = 'h264',
): Promise<boolean> {
  // For AV1 the advertised level is only a default: the decoder probe below decides.
  if (!browserReceivesScreenCodec(selected) || !navigator.mediaCapabilities?.decodingInfo) return false;
  // A browser without Main is probed with the profile it negotiates instead, at the same level.
  const h264 = getScreenH264ProfileLevelId(profile);
  const profileLevelId = browserAliasesH264Main() ? `640c${h264.slice(4)}`
    : browserReceivesH264Main() ? h264 : `42e0${h264.slice(4)}`;
  const capability = await navigator.mediaCapabilities.decodingInfo({
    type: 'webrtc',
    video: {
      contentType: selected === 'av1' ? `video/AV1;profile=0;level-idx=${getScreenAv1MinimumLevelIndex(profile)};tier=0`
        : `video/H264;profile-level-id=${profileLevelId};packetization-mode=1`,
      width: profile.width, height: profile.height, framerate: profile.fps, bitrate: profile.maxBitrateKbps * 1000,
    },
  });
  return capability.supported;
}

export function assertBrowserScreenCodec(
  sdp: string, selected: ScreenCodec, profile?: Readonly<NativeScreenVideoProfile>,
): void {
  const videoSections = sdp.split(/(?=^m=)/m).filter(section => section.startsWith('m=video '));
  // A receiver that shares no codec with the screen answers its video rejected (port 0): that is the codec.
  if (videoSections.length && videoSections.every(section => section.split(' ')[1] === '0'))
    throw new BrowserScreenCodecError(`This browser receives no ${selected.toUpperCase()} profile the screen offers.`);
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
    const av1Level = selected === 'av1' && media === 'video' && kind === 'av1'
      ? av1ReceiveLevel(Object.fromEntries(parameters), profile) : null;
    if (maxReceiveLevel) {
      parameters.set('max-recv-level', maxReceiveLevel);
    } else if (av1Level !== null) {
      parameters.set('level-idx', String(av1Level));
    } else if (media === 'audio' && kind === 'opus' && stereo) {
      parameters.set('stereo', '1');
    } else return line;
    return `a=fmtp:${fmtp[1]} ${[...parameters].map(([key, value]) => value ? `${key}=${value}` : key).join(';')}`;
  }).join('\r\n');
}
