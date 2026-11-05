import type { NativeScreenCall } from '@monky/shared';
import { screenSenderCodecs } from './browserScreenProfile';
import { sentMediaBinding, withScreenStreamId, type ScreenMediaBinding } from './screenSdp';
import type { ScreenIceCandidate, ScreenMediaKind, ScreenPeerPort } from './screenP2pPublisherPeer';

export interface BrowserScreenPeerOptions {
  readonly iceServers: NativeScreenCall['iceServers'];
  /** The screen's instance: the stream id viewers group its video and sound by. */
  readonly streamId: string;
  readonly video: MediaStreamTrack;
  readonly audio: MediaStreamTrack | null;
  readonly maxBitrateBps: number;
  readonly maxFramerate: number;
  readonly audioBitrateBps: number;
  readonly onCandidate: (candidate: ScreenIceCandidate) => void;
  readonly onState: (state: RTCPeerConnectionState) => void;
}

/**
 * A send-only browser connection for one viewer of a screen (#858). Both media start muted at the encoder
 * (`active: false`) and only flow while the protocol says the viewer watches them.
 */
export class BrowserScreenPeer implements ScreenPeerPort {
  private readonly peer: RTCPeerConnection;
  private readonly stream: MediaStream;
  private readonly transceivers = new Map<ScreenMediaKind, RTCRtpTransceiver>();
  private closed = false;

  constructor(private readonly options: BrowserScreenPeerOptions) {
    this.peer = new RTCPeerConnection({ iceServers: options.iceServers.map(server => ({ ...server, urls: [...server.urls] })) });
    this.stream = new MediaStream();
    const video = this.peer.addTransceiver(options.video, {
      direction: 'sendonly', streams: [this.stream],
      sendEncodings: [{ active: false, maxBitrate: options.maxBitrateBps, maxFramerate: options.maxFramerate }],
    });
    const codecs = screenSenderCodecs(RTCRtpSender.getCapabilities('video')?.codecs ?? []);
    if (!codecs.length) {
      this.peer.close();
      throw new Error('This browser cannot send the H.264 Main video screen viewers receive.');
    }
    video.setCodecPreferences(codecs);
    this.transceivers.set('video', video);
    if (options.audio) {
      this.transceivers.set('audio', this.peer.addTransceiver(options.audio, {
        direction: 'sendonly', streams: [this.stream], sendEncodings: [{ active: false, maxBitrate: options.audioBitrateBps }],
      }));
    }
    this.peer.onicecandidate = event => {
      if (this.closed || !event.candidate?.candidate) return;
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
      options.onCandidate({ candidate, sdpMid, sdpMLineIndex });
    };
    this.peer.onconnectionstatechange = () => { if (!this.closed) options.onState(this.peer.connectionState); };
  }

  public async createLocal(type: 'offer' | 'answer'): Promise<string> {
    const created = type === 'offer' ? await this.peer.createOffer() : await this.peer.createAnswer();
    const sdp = withScreenStreamId(created.sdp ?? '', this.stream.id, this.options.streamId);
    await this.peer.setLocalDescription({ type, sdp });
    const applied = this.peer.localDescription?.sdp;
    if (!applied) throw new Error('The browser did not apply its screen description.');
    return applied;
  }

  public setRemote(type: 'offer' | 'answer', sdp: string): Promise<void> {
    return this.peer.setRemoteDescription({ type, sdp });
  }

  public addIceCandidate(candidate: ScreenIceCandidate): Promise<void> {
    return this.peer.addIceCandidate(candidate);
  }

  public binding(kind: ScreenMediaKind): ScreenMediaBinding | null {
    const mid = this.transceivers.get(kind)?.mid;
    const sdp = this.peer.localDescription?.sdp;
    return mid && sdp ? sentMediaBinding(sdp, mid) : null;
  }

  public async setSending(kind: ScreenMediaKind, sending: boolean): Promise<void> {
    const sender = this.transceivers.get(kind)?.sender;
    if (!sender) throw new Error(`The screen connection has no ${kind} sender.`);
    const parameters = sender.getParameters();
    if (!parameters.encodings.length) throw new Error(`The ${kind} screen sender has no encoding.`);
    for (const encoding of parameters.encodings) encoding.active = sending;
    await sender.setParameters(parameters);
  }

  public stats(): Promise<RTCStatsReport> {
    return this.peer.getStats();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer.onicecandidate = null;
    this.peer.onconnectionstatechange = null;
    // The tracks belong to the screen's renditions: the connection only stops sending them.
    this.peer.close();
  }
}
