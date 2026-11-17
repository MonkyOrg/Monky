/** The binding of one sent medium in an SDP, as screen publications announce it. */
export interface ScreenMediaBinding {
  readonly trackId: string;
  readonly mid: string | null;
  readonly streamIds: readonly string[];
}

const sections = (sdp: string): string[] => sdp.split(/\r\n(?=m=)/);

/** The RTP extension that marks a picture's rotation instead of rotating its pixels (CVO). */
export const VIDEO_ORIENTATION_EXTENSION = 'urn:3gpp:video-orientation';

/**
 * The SDP without the video orientation extension. Where it is negotiated, WebKit sends a turned phone's
 * screen unrotated with only a rotation mark, which not every receiver applies (the desktop decoder only
 * carries it along); without it, the sending browser rotates the pixels itself and every receiver shows them.
 */
export function withoutVideoOrientation(sdp: string): string {
  return sdp.split('\r\n')
    .filter(line => /^a=extmap:\d+(?:\/\w+)?\s+(\S+)/.exec(line)?.[1] !== VIDEO_ORIENTATION_EXTENSION).join('\r\n');
}

/**
 * Names the sent stream `streamId` instead of the random one the browser chose. Viewers group a screen's
 * video and sound by the stream they arrive in, which must be the screen's own instance (its sync group).
 */
export function withScreenStreamId(sdp: string, localStreamId: string, streamId: string): string {
  if (!localStreamId || localStreamId === streamId) return sdp;
  return sdp.split('\r\n').map(line => {
    const msid = /^a=msid:(\S+)( .*)?$/.exec(line);
    if (msid?.[1] === localStreamId) return `a=msid:${streamId}${msid[2] ?? ''}`;
    const ssrc = /^(a=ssrc:\d+ msid:)(\S+)( .*)?$/.exec(line);
    if (ssrc?.[2] === localStreamId) return `${ssrc[1]}${streamId}${ssrc[3] ?? ''}`;
    return line;
  }).join('\r\n');
}

/** The track and streams an SDP sends in the media section `mid`, or null when it sends none there. */
export function sentMediaBinding(sdp: string, mid: string): ScreenMediaBinding | null {
  for (const section of sections(sdp)) {
    const lines = section.split('\r\n');
    if (!lines.includes(`a=mid:${mid}`)) continue;
    let trackId: string | null = null;
    const streamIds: string[] = [];
    for (const line of lines) {
      const msid = /^a=msid:(\S+) (\S+)$/.exec(line);
      if (!msid) continue;
      if (msid[1] !== '-' && !streamIds.includes(msid[1])) streamIds.push(msid[1]);
      trackId ??= msid[2];
    }
    return trackId ? { trackId, mid, streamIds } : null;
  }
  return null;
}

/** Whether two bindings name the same track, section and streams. */
export function sameMediaBinding(left: ScreenMediaBinding | null, right: ScreenMediaBinding | null): boolean {
  if (!left || !right) return left === right;
  return left.trackId === right.trackId && left.mid === right.mid && left.streamIds.length === right.streamIds.length
    && left.streamIds.every(id => right.streamIds.includes(id));
}
