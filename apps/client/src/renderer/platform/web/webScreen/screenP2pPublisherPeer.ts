import { nativeScreenP2pControlSchema, type NativeScreenP2pControl } from '@monky/shared';
import { sameMediaBinding, type ScreenMediaBinding } from './screenSdp';

export type ScreenMediaKind = 'video' | 'audio';
export interface ScreenIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/** The browser peer connection under a screen publication, reduced to what the protocol drives. */
export interface ScreenPeerPort {
  /** Creates and applies a local offer or answer; resolves the SDP to send. */
  createLocal(type: 'offer' | 'answer'): Promise<string>;
  setRemote(type: 'offer' | 'answer', sdp: string): Promise<void>;
  addIceCandidate(candidate: ScreenIceCandidate): Promise<void>;
  /** What the applied local description sends for `kind`, once it has one. */
  binding(kind: ScreenMediaKind): ScreenMediaBinding | null;
  /** Starts or stops sending `kind` without renegotiating. */
  setSending(kind: ScreenMediaKind, sending: boolean): Promise<void>;
  close(): void;
}

export interface ScreenP2pPublisherPeerOptions {
  readonly sessionId: string;
  readonly viewerSessionId: string;
  readonly channelId: string;
  readonly shareId: string;
  /** The screen's instance: the P2P call ID and the stream its media share. */
  readonly sourceInstanceId: string;
  readonly audio: boolean;
  /** The viewer's subscription, which names this connection. */
  readonly connectionId: string;
  readonly generation: number;
  readonly port: ScreenPeerPort;
  readonly send: (control: NativeScreenP2pControl) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

type ControlBody<T = NativeScreenP2pControl> = T extends NativeScreenP2pControl
  ? Omit<T, 'protocol' | 'version' | 'callId' | 'channelId' | 'connectionId' | 'generation'> : never;
type WatchControl = Extract<NativeScreenP2pControl, { type: 'watch' }>;
type TurnPhase = 'creating-offer' | 'await-offer' | 'answering' | 'await-answer' | 'applying-answer' | 'await-applied' | 'await-done';
interface Publication {
  readonly kind: ScreenMediaKind;
  readonly publicationId: number;
  readonly publicationVersion: number;
  metadataVersion: number;
  binding: ScreenMediaBinding | null;
  announcedVersion: number;
  lastWatchRevision: number;
  watch: WatchControl | null;
  sending: boolean;
}

export const SCREEN_P2P_LIMITS = Object.freeze({
  turnTimeoutMs: 30000, disconnectedGraceMs: 10000, queue: 64, queueBytes: 4 * 1024 * 1024, pendingIce: 128,
});

/**
 * The publisher's half of `monky-native-screen-p2p` for one viewer (#858), the inverse of the browser
 * receiver: it announces the screen's publications, negotiates in turns granted by the pair leader (the
 * lexically smaller session) and sends each medium only while the viewer watches it, sound bound to video.
 * Every control runs in order; a failure retires the connection through `onError`.
 */
export class ScreenP2pPublisherPeer {
  private readonly leader: boolean;
  private readonly version: 1 | 2;
  private readonly publications = new Map<ScreenMediaKind, Publication>();
  private readonly pendingIce: Extract<NativeScreenP2pControl, { type: 'ice' }>[] = [];
  private readonly sending = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private dirty = false;
  private remoteDirty = false;
  private pumpScheduled = false;
  private requestOutstanding = false;
  private localRequestVersion = 0;
  private remoteRequestVersion = 0;
  private sequence = 0;
  private completedTurn = 0;
  private lastOfferer: string;
  private remoteDescriptionTurn = 0;
  private localDescriptionTurn = 0;
  private turn: { sequence: number; offerer: string; phase: TurnPhase; timer: ReturnType<typeof setTimeout> } | null = null;
  private grantTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private failed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: ScreenP2pPublisherPeerOptions) {
    if (options.sessionId === options.viewerSessionId) throw new Error('A screen cannot be published to its own session.');
    this.leader = options.sessionId < options.viewerSessionId;
    this.version = options.audio ? 2 : 1;
    this.lastOfferer = options.viewerSessionId;
    const kinds: ScreenMediaKind[] = options.audio ? ['video', 'audio'] : ['video'];
    kinds.forEach((kind, index) => this.publications.set(kind, {
      kind, publicationId: index + 1, publicationVersion: index + 1, metadataVersion: 1, binding: null,
      announcedVersion: 0, lastWatchRevision: 0, watch: null, sending: false,
    }));
  }

  /** Whether the viewer currently receives `kind`. */
  public isSending(kind: ScreenMediaKind): boolean {
    return this.publications.get(kind)?.sending ?? false;
  }

  /** Starts negotiating the screen's media with the viewer. */
  public start(): void {
    this.dirty = true;
    this.schedulePump();
  }

  private current(): void {
    if (this.stopping) throw new DOMException('The screen connection was retired.', 'AbortError');
  }

  private fail(error: unknown): void {
    if (this.stopping || this.failed) return;
    this.failed = true;
    this.options.onError(error);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => { this.current(); return work(); });
    this.queue = run.catch(error => this.fail(error));
    return run;
  }

  private send(body: ControlBody): Promise<void> {
    this.current();
    const { channelId, sourceInstanceId, connectionId, generation } = this.options;
    const control = nativeScreenP2pControlSchema.parse({
      protocol: 'monky-native-screen-p2p', version: this.version,
      callId: sourceInstanceId, channelId, connectionId, generation, ...body,
    });
    const work = this.options.send(control);
    this.sending.add(work);
    void work.then(() => this.sending.delete(work), () => this.sending.delete(work));
    return work;
  }

  /** A control the viewer sent through the server. */
  public receive(value: NativeScreenP2pControl): Promise<void> {
    const control = nativeScreenP2pControlSchema.parse(value);
    const { channelId, sourceInstanceId, connectionId, generation } = this.options;
    if (control.channelId !== channelId || control.callId !== sourceInstanceId || control.connectionId !== connectionId
      || control.generation !== generation || control.version !== this.version)
      return Promise.reject(new Error('The screen control does not belong to this viewer connection.'));
    const bytes = new TextEncoder().encode(JSON.stringify(control)).byteLength;
    if (this.queued >= SCREEN_P2P_LIMITS.queue || this.queuedBytes + bytes > SCREEN_P2P_LIMITS.queueBytes)
      return Promise.reject(new Error('The screen signaling queue exceeded its limit.'));
    this.queued++; this.queuedBytes += bytes;
    const work = this.enqueue(() => this.handle(control));
    void work.catch(() => {}).finally(() => { this.queued--; this.queuedBytes -= bytes; });
    return work;
  }

  /** A local ICE candidate of the browser connection. */
  public localCandidate(candidate: ScreenIceCandidate): void {
    if (this.stopping || !this.localDescriptionTurn) return;
    const turn = this.localDescriptionTurn;
    void this.send({ type: 'ice', turn, ...candidate }).catch(error => this.fail(error));
  }

  /** The browser connection changed state: a failure retires it, a disconnection waits for it to return. */
  public connectionState(state: RTCPeerConnectionState): void {
    if (this.stopping) return;
    if (state === 'failed' || state === 'closed') this.fail(new Error('The screen viewer connection failed.'));
    if (state === 'disconnected' && !this.disconnectedTimer)
      this.disconnectedTimer = setTimeout(() => this.fail(new Error('The screen viewer did not reconnect.')),
        SCREEN_P2P_LIMITS.disconnectedGraceMs);
    if (state === 'connected' && this.disconnectedTimer) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
  }

  private schedulePump(): void {
    if (this.stopping || this.pumpScheduled) return;
    this.pumpScheduled = true;
    void this.enqueue(async () => {
      this.pumpScheduled = false;
      await this.pump();
    }).catch(() => {});
  }

  private async pump(): Promise<void> {
    if (this.turn || (!this.dirty && !this.remoteDirty)) return;
    const { sessionId, viewerSessionId } = this.options;
    if (!this.leader) {
      if (this.dirty && !this.requestOutstanding) {
        this.requestOutstanding = true;
        this.grantTimer = setTimeout(() => this.fail(new Error('The screen viewer did not grant a negotiation turn.')),
          SCREEN_P2P_LIMITS.turnTimeoutMs);
        await this.send({ type: 'negotiate', requestVersion: ++this.localRequestVersion });
      }
      return;
    }
    let offerer = this.dirty ? sessionId : viewerSessionId;
    // Both sides need a turn: the one that offered last waits.
    if (this.dirty && this.remoteDirty && this.lastOfferer === sessionId) offerer = viewerSessionId;
    if (offerer === viewerSessionId) this.remoteDirty = false;
    this.startTurn(this.sequence + 1, offerer);
    await this.send({ type: 'turn', turn: this.sequence, offererSessionId: offerer });
    if (offerer === sessionId) await this.offer();
  }

  private startTurn(sequence: number, offerer: string): void {
    this.sequence = sequence;
    this.lastOfferer = offerer;
    this.turn = {
      sequence, offerer, phase: offerer === this.options.sessionId ? 'creating-offer' : 'await-offer',
      timer: setTimeout(() => this.fail(new Error(`Screen negotiation turn ${sequence} did not finish.`)),
        SCREEN_P2P_LIMITS.turnTimeoutMs),
    };
  }

  private async offer(): Promise<void> {
    const turn = this.turn;
    if (!turn) throw new Error('No screen negotiation turn was granted.');
    this.dirty = false;
    this.requestOutstanding = false;
    if (this.grantTimer) clearTimeout(this.grantTimer);
    this.grantTimer = null;
    const sdp = await this.options.port.createLocal('offer');
    this.current();
    this.localDescriptionTurn = turn.sequence;
    // The viewer learns which track carries each medium before the track arrives.
    await this.announce();
    await this.send({ type: 'offer', turn: turn.sequence, sdp });
    turn.phase = 'await-answer';
  }

  private async announce(): Promise<void> {
    for (const publication of this.publications.values()) {
      const binding = this.options.port.binding(publication.kind);
      if (!binding || (publication.announcedVersion && sameMediaBinding(binding, publication.binding))) continue;
      if (this.version === 2 && !binding.streamIds.includes(this.options.sourceInstanceId))
        throw new Error('The screen sender left its synchronization group.');
      if (publication.announcedVersion) publication.metadataVersion++;
      publication.binding = binding;
      await this.send({
        type: 'publication', shareId: this.options.shareId, publicationId: publication.publicationId,
        publicationVersion: publication.publicationVersion, metadataVersion: publication.metadataVersion,
        trackId: binding.trackId, mid: binding.mid, streamIds: [...binding.streamIds],
        ...(this.version === 2 ? { kind: publication.kind, syncGroup: this.options.sourceInstanceId } : {}),
      });
      publication.announcedVersion = publication.metadataVersion;
      await this.syncSending(publication);
    }
  }

  private async remoteDescription(turn: number): Promise<void> {
    this.remoteDescriptionTurn = turn;
    for (let index = 0; index < this.pendingIce.length;) {
      const ice = this.pendingIce[index];
      if (ice.turn > turn) { index++; continue; }
      this.pendingIce.splice(index, 1);
      await this.options.port.addIceCandidate({ candidate: ice.candidate, sdpMid: ice.sdpMid, sdpMLineIndex: ice.sdpMLineIndex });
      this.current();
    }
  }

  private async finishTurn(): Promise<void> {
    if (!this.turn) throw new Error('No screen negotiation turn can be completed.');
    await this.send({ type: 'turn-done', turn: this.turn.sequence });
    this.completeTurn();
  }

  private completeTurn(): void {
    if (!this.turn) throw new Error('No screen negotiation turn can be completed.');
    clearTimeout(this.turn.timer);
    this.completedTurn = this.turn.sequence;
    this.turn = null;
    this.schedulePump();
  }

  private async handle(control: NativeScreenP2pControl): Promise<void> {
    const { sessionId, viewerSessionId, shareId } = this.options;
    if ((control.type === 'offer' || control.type === 'answer' || control.type === 'turn-applied'
      || control.type === 'turn-done') && control.turn <= this.completedTurn) return;
    switch (control.type) {
      case 'negotiate':
        if (!this.leader) throw new Error('Only the screen pair leader receives negotiation requests.');
        if (control.requestVersion <= this.remoteRequestVersion) return;
        this.remoteRequestVersion = control.requestVersion;
        this.remoteDirty = true;
        this.schedulePump();
        return;
      case 'turn':
        if (this.leader) throw new Error('Only the screen pair leader grants negotiation turns.');
        if (control.turn <= this.completedTurn) return;
        if (this.turn || control.turn !== this.sequence + 1 || ![sessionId, viewerSessionId].includes(control.offererSessionId))
          throw new Error('Unexpected or overlapping screen negotiation turn.');
        this.startTurn(control.turn, control.offererSessionId);
        if (control.offererSessionId === sessionId) await this.offer();
        return;
      case 'offer': {
        const turn = this.turn;
        if (turn?.sequence !== control.turn || turn.offerer !== viewerSessionId || turn.phase !== 'await-offer')
          throw new Error('The screen offer does not match its granted turn.');
        turn.phase = 'answering';
        await this.options.port.setRemote('offer', control.sdp);
        this.current();
        await this.remoteDescription(control.turn);
        const sdp = await this.options.port.createLocal('answer');
        this.current();
        this.localDescriptionTurn = control.turn;
        await this.announce();
        await this.send({ type: 'answer', turn: control.turn, sdp });
        turn.phase = this.leader ? 'await-applied' : 'await-done';
        return;
      }
      case 'answer': {
        const turn = this.turn;
        if (turn?.sequence !== control.turn || turn.offerer !== sessionId || turn.phase !== 'await-answer')
          throw new Error('The screen answer does not match the outstanding turn.');
        turn.phase = 'applying-answer';
        await this.options.port.setRemote('answer', control.sdp);
        this.current();
        await this.remoteDescription(control.turn);
        if (this.leader) await this.finishTurn();
        else {
          await this.send({ type: 'turn-applied', turn: control.turn });
          turn.phase = 'await-done';
        }
        return;
      }
      case 'turn-applied':
        if (!this.leader || this.turn?.sequence !== control.turn || this.turn.offerer !== viewerSessionId
          || this.turn.phase !== 'await-applied') throw new Error('Unexpected screen answer acknowledgement.');
        await this.finishTurn();
        return;
      case 'turn-done':
        if (this.leader || this.turn?.sequence !== control.turn || this.turn.phase !== 'await-done')
          throw new Error('The screen turn completed before its answer.');
        this.completeTurn();
        return;
      case 'ice':
        if (control.turn > this.sequence + (this.turn ? 0 : 1)) throw new Error('Screen ICE refers to a future turn.');
        if (this.remoteDescriptionTurn && control.turn <= this.remoteDescriptionTurn)
          await this.options.port.addIceCandidate({
            candidate: control.candidate, sdpMid: control.sdpMid, sdpMLineIndex: control.sdpMLineIndex,
          });
        else {
          if (this.pendingIce.length >= SCREEN_P2P_LIMITS.pendingIce) throw new Error('Screen ICE exceeded its pending limit.');
          this.pendingIce.push(control);
        }
        return;
      case 'watch': {
        const publication = this.publications.get(control.version === 1 ? 'video' : control.kind);
        if (!publication || control.shareId !== shareId || control.publicationId !== publication.publicationId
          || control.publicationVersion !== publication.publicationVersion
          || control.metadataVersion !== publication.metadataVersion
          || publication.announcedVersion !== publication.metadataVersion
          || control.revision <= publication.lastWatchRevision) return;
        publication.lastWatchRevision = control.revision;
        publication.watch = control;
        await this.syncSending(publication);
        const audio = this.publications.get('audio');
        if (publication.kind === 'video' && audio) await this.syncSending(audio);
        return;
      }
      default: throw new Error('A screen publisher does not receive publications from its viewer.');
    }
  }

  /** The viewer watches the current metadata of `publication`; sound only together with the video it is bound to. */
  private desired(publication: Publication): boolean {
    const watch = publication.watch;
    if (!watch?.watching || watch.metadataVersion !== publication.metadataVersion
      || publication.announcedVersion !== publication.metadataVersion) return false;
    if (publication.kind === 'video') return true;
    const video = this.publications.get('video');
    const bound = 'video' in watch ? watch.video : null;
    return !!video && !!bound && this.desired(video) && bound.publicationId === video.publicationId
      && bound.publicationVersion === video.publicationVersion && bound.metadataVersion === video.metadataVersion
      && bound.subscriptionId === video.watch?.subscriptionId && bound.revision === video.watch.revision;
  }

  private async syncSending(publication: Publication): Promise<void> {
    const desired = this.desired(publication);
    if (publication.sending === desired) return;
    await this.options.port.setSending(publication.kind, desired);
    this.current();
    publication.sending = desired;
  }

  public close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    if (this.turn) clearTimeout(this.turn.timer);
    if (this.grantTimer) clearTimeout(this.grantTimer);
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.turn = null;
    this.grantTimer = null;
    this.disconnectedTimer = null;
    this.pendingIce.length = 0;
    this.options.port.close();
    this.closing = Promise.allSettled([this.queue, ...this.sending]).then(() => {});
    return this.closing;
  }
}
