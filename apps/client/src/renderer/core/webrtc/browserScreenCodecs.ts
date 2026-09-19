import type { NativeScreenVideoProfile } from '@monky/shared';

export async function supportsBrowserScreenCodec(profile: Readonly<NativeScreenVideoProfile>): Promise<boolean> {
  const main = RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec =>
    codec.mimeType.toLowerCase() === 'video/h264'
      && /(?:^|;)\s*profile-level-id=4d[0-9a-f]{4}(?:;|$)/i.test(codec.sdpFmtpLine ?? '')
      && /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(codec.sdpFmtpLine ?? ''));
  if (!main || !navigator.mediaCapabilities?.decodingInfo) return false;
  const capability = await navigator.mediaCapabilities.decodingInfo({
    type: 'webrtc',
    video: {
      contentType: 'video/H264;profile-level-id=4d0033;packetization-mode=1',
      width: profile.width, height: profile.height, framerate: profile.fps, bitrate: profile.maxBitrateKbps * 1000,
    },
  });
  return capability.supported;
}

export function withBrowserScreenReceiveParameters(sdp: string, stereo: boolean): string {
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
    const profile = parameters.get('profile-level-id');
    if (media === 'video' && kind === 'h264' && profile && /^4d[0-9a-f]{4}$/i.test(profile)
      && Number.parseInt(profile.slice(4), 16) < 51) {
      // RFC 6184: extend receive capacity only after the WebRTC decoder capability probe.
      // Keep Chromium's default profile/level rather than pretending it negotiated another one.
      parameters.set('max-recv-level', '0033');
    } else if (media === 'audio' && kind === 'opus' && stereo) {
      parameters.set('stereo', '1');
    } else return line;
    return `a=fmtp:${fmtp[1]} ${[...parameters].map(([key, value]) => value ? `${key}=${value}` : key).join(';')}`;
  }).join('\r\n');
}
