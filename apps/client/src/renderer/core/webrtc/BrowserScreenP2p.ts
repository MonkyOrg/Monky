import {
  nativeScreenP2pControlSchema, type NativeScreenCall, type NativeScreenP2pControl, type NativeScreenSource,
} from '@monky/shared';
import { withBrowserScreenReceiveParameters } from './browserScreenCodecs';

type ControlBody<T = NativeScreenP2pControl> = T extends NativeScreenP2pControl
  ? Omit<T, 'protocol' | 'version' | 'callId' | 'channelId' | 'connectionId' | 'generation'> : never;
type Publication = Extract<NativeScreenP2pControl, { type: 'publication' }>;
type PublicationWatch = { publication: Publication; subscriptionId: number; revision: number; retired: boolean };
type IncomingTrack = {
  track: MediaStreamTrack; receiver: RTCRtpReceiver; transceiver: RTCRtpTransceiver; streamIds: string[]; admitted: boolean;
};

export interface BrowserScreenP2pOptions {
  call: NativeScreenCall;
  publisherSessionId: string;
  source: NativeScreenSource;
  subscriptionId: string;
  generation: number;
  muted: boolean;
  send: (control: NativeScreenP2pControl) => Promise<void>;
  onTrack: (track: MediaStreamTrack, receiver: RTCRtpReceiver) => void;
  onError: (error: unknown) => void;
}

/** Receive-only participant in the screen protocol, backed by a real browser PC. */
export class BrowserScreenP2p {
  private readonly peer: RTCPeerConnection;
  private readonly leader: boolean;
  private readonly publications = new Map<'video' | 'audio', PublicationWatch>();
  private readonly tracks = new Map<string, IncomingTrack>();
  private readonly pendingIce: Extract<NativeScreenP2pControl, { type: 'ice' }>[] = [];
  private readonly sending = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private sequence = 0;
  private completedTurn = 0;
  private remoteDescriptionTurn = 0;
  private localDescriptionTurn = 0;
  private remoteRequest = 0;
  private remoteDirty = false;
  private turn: { number: number; phase: 'offer' | 'answering' | 'applied' | 'done' } | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSubscription = 0;
  private revision = 0;
  private muted: boolean;
  private stopping = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: BrowserScreenP2pOptions) {
    this.leader = options.call.sessionId < options.publisherSessionId;
    this.muted = options.muted;
    this.peer = new RTCPeerConnection({ iceServers: options.call.iceServers.map(server => ({ ...server, urls: [...server.urls] })) });
    this.peer.onicecandidate = event => {
      if (this.stopping || !event.candidate || !this.localDescriptionTurn) return;
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
      void this.send({ type: 'ice', turn: this.localDescriptionTurn, candidate, sdpMid, sdpMLineIndex })
        .catch(error => this.fail(error));
    };
    this.peer.ontrack = event => {
      if (this.stopping) { event.track.stop(); return; }
      const previous = this.tracks.get(event.track.id);
      if (previous && previous.track !== event.track) {
        event.track.stop();
        this.fail(new Error('A screen track changed identity without changing its ID.'));
        return;
      }
      event.track.enabled = false;
      if (this.tracks.size >= 4 && !this.tracks.has(event.track.id)) {
        event.track.stop();
        this.fail(new Error('The screen peer exceeded its receive-track limit.'));
        return;
      }
      this.tracks.set(event.track.id, { track: event.track, receiver: event.receiver, transceiver: event.transceiver,
        streamIds: event.streams.map(stream => stream.id), admitted: previous?.admitted ?? false });
      this.routeTracks();
    };
    this.peer.onconnectionstatechange = () => {
      if (this.stopping) return;
      if (this.peer.connectionState === 'failed' || this.peer.connectionState === 'closed')
        this.fail(new Error('The screen peer connection failed.'));
      if (this.peer.connectionState === 'disconnected' && !this.disconnectedTimer)
        this.disconnectedTimer = setTimeout(() => this.fail(new Error('The screen peer did not reconnect.')), 10000);
      if (this.peer.connectionState === 'connected' && this.disconnectedTimer) {
        clearTimeout(this.disconnectedTimer);
        this.disconnectedTimer = null;
      }
    };
  }

  private current(): void {
    if (this.stopping) throw new DOMException('The browser screen peer was retired.', 'AbortError');
  }

  private fail(error: unknown): void {
    if (!this.stopping) this.options.onError(error);
  }

  private send(body: ControlBody): Promise<void> {
    this.current();
    const { call, source, subscriptionId, generation } = this.options;
    const control = nativeScreenP2pControlSchema.parse({
      protocol: 'monky-native-screen-p2p', version: source.audio ? 2 : 1,
      callId: source.instanceId, channelId: call.channelId, connectionId: subscriptionId, generation, ...body,
    });
    const work = this.options.send(control);
    this.sending.add(work);
    void work.then(() => this.sending.delete(work), () => this.sending.delete(work));
    return work;
  }

  public receive(value: NativeScreenP2pControl): Promise<void> {
    const control = nativeScreenP2pControlSchema.parse(value);
    const { call, source, subscriptionId, generation } = this.options;
    if (control.channelId !== call.channelId || control.callId !== source.instanceId
      || control.connectionId !== subscriptionId || control.generation !== generation
      || control.version !== (source.audio ? 2 : 1))
      return Promise.reject(new Error('The browser control does not belong to this screen subscription.'));
    const bytes = new TextEncoder().encode(JSON.stringify(control)).byteLength;
    if (this.queued >= 64 || this.queuedBytes + bytes > 4 * 1024 * 1024)
      return Promise.reject(new Error('The screen signaling queue exceeded its limit.'));
    this.queued++; this.queuedBytes += bytes;
    const work = this.queue.then(() => { this.current(); return this.handle(control); });
    this.queue = work.catch(error => this.fail(error)).finally(() => { this.queued--; this.queuedBytes -= bytes; });
    return work;
  }

  private startTurn(number: number): void {
    if (this.turn || number !== this.sequence + 1) throw new Error('Screen negotiation turns overlapped.');
    this.sequence = number;
    this.turn = { number, phase: 'offer' };
    this.turnTimer = setTimeout(() => this.fail(new Error('Screen negotiation did not complete.')), 30000);
  }

  private async grantTurn(): Promise<void> {
    if (!this.leader || this.turn || !this.remoteDirty) return;
    this.remoteDirty = false;
    this.startTurn(this.sequence + 1);
    // This connection is receive-only, so only the publisher mutates sending SDP.
    await this.send({ type: 'turn', turn: this.sequence, offererSessionId: this.options.publisherSessionId });
  }

  private async finishTurn(): Promise<void> {
    if (!this.turn) throw new Error('No screen negotiation turn can be completed.');
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.completedTurn = this.turn.number;
    this.turn = null;
    await this.grantTurn();
  }

  private async handle(control: NativeScreenP2pControl): Promise<void> {
    if ('turn' in control && control.type !== 'ice' && control.turn <= this.completedTurn) return;
    switch (control.type) {
      case 'negotiate':
        if (!this.leader) throw new Error('Only the screen pair leader can grant turns.');
        if (control.requestVersion <= this.remoteRequest) return;
        this.remoteRequest = control.requestVersion;
        this.remoteDirty = true;
        await this.grantTurn();
        break;
      case 'turn':
        if (this.leader || control.offererSessionId !== this.options.publisherSessionId)
          throw new Error('The screen publisher must offer its receive-only browser connection.');
        this.startTurn(control.turn);
        break;
      case 'offer': {
        if (!this.turn || this.turn.number !== control.turn || this.turn.phase !== 'offer')
          throw new Error('The screen offer does not match its granted turn.');
        this.turn.phase = 'answering';
        await this.peer.setRemoteDescription({ type: 'offer', sdp: control.sdp });
        this.current();
        this.remoteDescriptionTurn = control.turn;
        for (let index = 0; index < this.pendingIce.length;) {
          const ice = this.pendingIce[index];
          if (ice.turn > control.turn) { index++; continue; }
          this.pendingIce.splice(index, 1);
          await this.peer.addIceCandidate(this.candidate(ice));
          this.current();
        }
        this.routeTracks();
        const answer = await this.peer.createAnswer();
        this.current();
        this.localDescriptionTurn = control.turn;
        await this.peer.setLocalDescription({ type: 'answer',
          sdp: withBrowserScreenReceiveParameters(answer.sdp ?? '', this.options.source.audio) });
        this.current();
        if (!this.peer.localDescription?.sdp) throw new Error('The browser did not produce a screen answer.');
        await this.send({ type: 'answer', turn: control.turn, sdp: this.peer.localDescription.sdp });
        this.current();
        this.turn.phase = this.leader ? 'applied' : 'done';
        break;
      }
      case 'turn-applied':
        if (!this.leader || this.turn?.number !== control.turn || this.turn.phase !== 'applied')
          throw new Error('Unexpected screen answer acknowledgement.');
        await this.send({ type: 'turn-done', turn: control.turn });
        await this.finishTurn();
        break;
      case 'turn-done':
        if (this.leader || this.turn?.number !== control.turn || this.turn.phase !== 'done')
          throw new Error('The screen turn completed before its answer.');
        await this.finishTurn();
        break;
      case 'ice':
        if (control.turn > this.sequence + (this.turn ? 0 : 1)) throw new Error('Screen ICE refers to a future turn.');
        if (this.remoteDescriptionTurn && control.turn <= this.remoteDescriptionTurn)
          await this.peer.addIceCandidate(this.candidate(control));
        else {
          if (this.pendingIce.length >= 128) throw new Error('Screen ICE exceeded its pending limit.');
          this.pendingIce.push(control);
        }
        break;
      case 'publication': {
        if (control.shareId !== this.options.source.shareId) throw new Error('Publication belongs to another screen.');
        const kind = control.version === 1 ? 'video' : control.kind;
        if (control.version === 2 && control.syncGroup !== this.options.source.instanceId)
          throw new Error('The screen A/V group changed.');
        const old = this.publications.get(kind);
        if (old && (old.publication.publicationVersion > control.publicationVersion
          || (old.publication.publicationVersion === control.publicationVersion
            && (old.retired || old.publication.metadataVersion > control.metadataVersion)))) return;
        if (old && old.publication.publicationVersion === control.publicationVersion) {
          if (old.publication.publicationId !== control.publicationId) throw new Error('A screen publication changed identity.');
          if (old.publication.metadataVersion === control.metadataVersion) {
            if (old.publication.trackId !== control.trackId || old.publication.mid !== control.mid
              || !this.sameStreams(old.publication.streamIds, control.streamIds))
              throw new Error('A screen publication changed its binding without a metadata revision.');
            return;
          }
        }
        for (const [otherKind, other] of this.publications) {
          if (otherKind === kind || other.retired) continue;
          if (other.publication.publicationId === control.publicationId || other.publication.trackId === control.trackId
            || (control.mid !== null && other.publication.mid === control.mid))
            throw new Error('Different screen media cannot share a publication, track or MID.');
        }
        this.publications.set(kind, { publication: control, revision: 0, retired: false,
          subscriptionId: old?.publication.publicationVersion === control.publicationVersion
            ? old.subscriptionId : ++this.nextSubscription });
        await this.sendWatches();
        this.routeTracks();
        break;
      }
      case 'unpublish': {
        if (control.shareId !== this.options.source.shareId) throw new Error('Unpublish belongs to another screen.');
        const kind = control.version === 1 ? 'video' : control.kind;
        const old = this.publications.get(kind);
        if (old?.publication.publicationId !== control.publicationId
          || old.publication.publicationVersion !== control.publicationVersion) return;
        old.retired = true;
        for (const incoming of this.tracks.values()) if (incoming.track.kind === kind) incoming.track.stop();
        this.routeTracks();
        break;
      }
      default: throw new Error('A receive-only screen connection cannot publish or answer an offer.');
    }
  }

  private candidate(control: Extract<NativeScreenP2pControl, { type: 'ice' }>): RTCIceCandidateInit {
    return { candidate: control.candidate, sdpMid: control.sdpMid, sdpMLineIndex: control.sdpMLineIndex };
  }

  private async sendWatches(): Promise<void> {
    const video = this.publications.get('video');
    if (!video || video.retired) return;
    const watch = (entry: PublicationWatch) => ({
      shareId: entry.publication.shareId, publicationId: entry.publication.publicationId,
      publicationVersion: entry.publication.publicationVersion, metadataVersion: entry.publication.metadataVersion,
      subscriptionId: entry.subscriptionId, revision: entry.revision = ++this.revision,
    });
    const selectedVideo = watch(video);
    await this.send({ type: 'watch', ...selectedVideo, watching: true, ...(this.options.source.audio ? { kind: 'video' as const } : {}) });
    const audio = this.publications.get('audio');
    if (audio && !audio.retired) {
      const { shareId: _shareId, ...binding } = selectedVideo;
      await this.send({ type: 'watch', kind: 'audio', ...watch(audio), watching: !this.muted, video: binding });
    }
  }

  private routeTracks(): void {
    if (this.stopping) return;
    for (const incoming of this.tracks.values()) {
      if (incoming.track.readyState !== 'live') continue;
      const kind = incoming.track.kind;
      if (kind !== 'video' && kind !== 'audio') continue;
      const entry = this.publications.get(kind), video = this.publications.get('video');
      const publication = entry?.publication;
      if (!publication || entry.retired || (kind === 'audio' && (!video || video.retired))
        || publication.trackId !== incoming.track.id
        || (publication.mid !== null && publication.mid !== incoming.transceiver.mid)
        || !this.sameStreams(publication.streamIds, incoming.streamIds)) {
        incoming.track.enabled = false;
        continue;
      }
      if (kind === 'audio' && !this.options.source.audio) { incoming.track.stop(); continue; }
      incoming.track.enabled = true;
      if (!incoming.admitted) {
        incoming.admitted = true;
        this.options.onTrack(incoming.track, incoming.receiver);
      }
    }
  }

  private sameStreams(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && new Set(left).size === left.length
      && new Set(right).size === right.length && left.every(id => right.includes(id));
  }

  public setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    const work = this.queue.then(() => { this.current(); return this.sendWatches(); });
    this.queue = work.catch(error => this.fail(error));
    return work;
  }

  public stats(): Promise<RTCStatsReport> { return this.peer.getStats(); }

  public close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.peer.ontrack = null;
    this.peer.onicecandidate = null;
    this.peer.onconnectionstatechange = null;
    for (const receiver of this.peer.getReceivers()) receiver.track.stop();
    for (const incoming of this.tracks.values()) incoming.track.stop();
    this.peer.close();
    this.closing = Promise.allSettled([this.queue, ...this.sending]).then(() => {
      this.tracks.clear(); this.publications.clear(); this.pendingIce.length = 0;
      if (this.peer.signalingState !== 'closed') throw new Error('The browser screen peer retained its connection.');
    });
    return this.closing;
  }
}
