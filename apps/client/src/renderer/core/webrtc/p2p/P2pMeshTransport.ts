import {
  type IceServerConfig, MessageType, type QualityPresetType, type QualityProfile, type WebRtcSignalPayload,
  isReceivingBotVoice,
} from '@monky/shared';
import type { NetworkClient } from '../../NetworkClient';
import type { ParticipantManager } from '../../ParticipantManager';
import { clientLog } from '../../ClientLogService';
import { applyVideoCodecPreferences } from '../codecPreferences';
import { applyMediaEncodingPolicy, getMediaEncodingPolicy } from '../mediaEncodingPolicy';
import type { RemoteMediaSink, RemoteTrack } from '../RemoteMediaSink';
import { averageRoundTrip, candidateRoute, type CandidateRoute } from '../rtcStats';
import { updateRtpSenderParameters } from '../rtpSenderParameters';
import type { MicrophoneChange, Rollback, VoiceTransport } from '../VoiceTransport';
import {
  cameraTransceiver, closeLink, hasUnnegotiatedSenders, microphoneTransceiver, type PeerLink, type PeerNegotiation,
} from './PeerLink';
import { P2pRecovery } from './P2pRecovery';

/** What the mesh needs from the call it carries. */
export interface P2pMeshHost {
  /** Signalling of the call (#400). */
  client(): NetworkClient;
  /** Roster of the server hosting the call. */
  participants(): ParticipantManager;
  /** Our session id: the tie-breaker for who is polite on each link (#309). */
  selfSessionId(): string;
  channelId(): string | null;
  /** Whether a peer is in the very call we are in (#466). */
  isPeerInCall(peerSessionId: string): boolean;
  /** What the call publishes. */
  microphone(): MediaStreamTrack | null;
  camera(): MediaStreamTrack | null;
  readonly media: RemoteMediaSink;
  /** New senders exist: they get the call's quality policy. */
  applyQuality(): void;
  /** A link connected: the call is measured at once (#466). */
  linkConnected(): void;
  /** Rebuilds a link through the call, which may have moved on meanwhile. */
  reconnect(peerSessionId: string, initiator: boolean): Promise<void>;
  /** Takes out a participant whose link cannot be kept, as if they had left. */
  removePeer(peerSessionId: string): void;
}

/**
 * The P2P transport: a full mesh where each participant keeps a direct
 * RTCPeerConnection to every other participant in the voice channel.
 *
 * Traffic and encode/upload cost therefore grow as O(N²). This is intentional
 * and adequate for the project's scope (small groups of friends), bounded by
 * MAX_PARTICIPANTS_PER_CHANNEL_DEFAULT = 10. Scaling significantly beyond that
 * is what the SFU is for.
 *
 * Every link negotiates with perfect negotiation (polite/impolite roles), one
 * description or candidate at a time, and recovers through P2pRecovery.
 */
export class P2pMeshTransport implements VoiceTransport {
  /**
   * Bound on ICE candidates held for a peer before its first description.
   * Legitimate peers send a few dozen; this is what the bot SDK and the Light
   * allow too, and it keeps a buggy or hostile peer from growing it forever.
   */
  private static readonly MAX_PENDING_ICE_CANDIDATES = 256;

  public readonly mode = 'p2p';
  public readonly peers = new Map<string, PeerLink>();
  private readonly nativeTasks = new WeakMap<PeerLink, Promise<void>>();
  private readonly recovery: P2pRecovery;

  /**
   * ICE servers used for every peer connection.
   *
   * These are defaults: a server that runs its own TURN relay overrides the
   * whole list at login through `setIceServers()` (#425). They stay hardcoded
   * as the fallback so a server released before TURN support — or one with the
   * relay off — keeps working exactly as before.
   */
  public rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    iceCandidatePoolSize: 4,
  };

  constructor(private readonly host: P2pMeshHost) {
    this.recovery = new P2pRecovery({
      link: peerSessionId => this.peers.get(peerSessionId),
      sendOffer: (link, iceRestart) => this.sendOffer(link, iceRestart),
      retire: link => this.retire(link),
      reconnect: (peerSessionId, initiator) => this.host.reconnect(peerSessionId, initiator),
      participants: () => this.host.participants(),
      channelId: () => this.host.channelId(),
      selfSessionId: () => this.host.selfSessionId(),
      client: () => this.host.client(),
    });
  }

  /**
   * Adopts the ICE servers advertised by the server we just signed in to (#425).
   *
   * Only affects connections opened from here on: an `RTCPeerConnection` reads
   * its configuration when it is created, so peers already talking keep the
   * servers they started with. That is fine — the relay matters while a link is
   * being established, and a live link by definition already found a path.
   */
  public setIceServers(iceServers: IceServerConfig[] | undefined): void {
    if (!iceServers || iceServers.length === 0) return;

    this.rtcConfig = {
      ...this.rtcConfig,
      iceServers: iceServers.map((entry) => ({
        urls: entry.urls,
        ...(entry.username ? { username: entry.username } : {}),
        ...(entry.credential ? { credential: entry.credential } : {}),
      })),
    };

    const hasRelay = iceServers.some((entry) => entry.urls.some((url) => url.startsWith('turn:')));
    const stunCount = iceServers.filter((e) => e.urls.some((u) => u.startsWith('stun:'))).length;
    const turnCount = iceServers.filter((e) => e.urls.some((u) => u.startsWith('turn:'))).length;
    const hasCredentials = iceServers.some((e) => !!e.username && !!e.credential);
    clientLog.info('WEBRTC', `ICE servers updated (STUN: ${stunCount}, TURN: ${turnCount}, relay ${hasRelay ? 'available' : 'unavailable'})`, {
      serverCount: iceServers.length,
      hasRelay,
      hasCredentials,
      urls: iceServers.flatMap((e) => e.urls),
    });
    if (hasRelay && !hasCredentials) {
      clientLog.warn('WEBRTC', 'TURN server configured but no credentials provided — relay will not work');
    }
    console.log(`[WebRTC] ICE servers updated by the server (relay ${hasRelay ? 'available' : 'unavailable'})`);
  }

  public peerIds(): string[] {
    return [...this.peers.keys()];
  }

  public getPeerConnection(peerSessionId: string): RTCPeerConnection | null {
    return this.peers.get(peerSessionId)?.pc ?? null;
  }

  private isCurrent(link: PeerLink): boolean {
    return this.peers.get(link.peerSessionId) === link && link.pc.signalingState !== 'closed';
  }

  public addParticipant(peerSessionId: string, initiator: boolean): Promise<void> {
    return this.connect(peerSessionId, initiator);
  }

  private async connect(peerSessionId: string, isInitiator: boolean): Promise<void> {
    clientLog.info('WEBRTC', `Connecting to peer ${peerSessionId} (initiator: ${isInitiator})`, {
      iceServersCount: this.rtcConfig.iceServers?.length ?? 0,
    });
    const existing = this.peers.get(peerSessionId);
    if (existing) {
      if (existing.pc.connectionState !== 'closed' && existing.pc.connectionState !== 'failed') return;
      this.retire(existing);
    }

    // The clock towards the "no direct connection" warning starts on the first
    // attempt and keeps running across every retry for this peer (#426).
    this.recovery.beginFailureCountdown(peerSessionId);

    const pc = new RTCPeerConnection(this.rtcConfig);
    const isPolite = this.host.selfSessionId().localeCompare(peerSessionId) < 0;
    const participant = this.host.participants().get(peerSessionId);
    const botPeer = peerSessionId.startsWith('bot:') || participant?.user.isBot === true;
    const link: PeerLink = {
      peerSessionId,
      botPeer,
      receiveOnly: botPeer && !isReceivingBotVoice(participant?.voiceState),
      pc,
      isPolite,
      makingOffer: false,
      candidateQueue: [],
      subscriptionId: crypto.randomUUID(),
      iceRestartAttempts: 0,
      reconnectAttempts: 0,
      isRecovering: false,
    };
    this.peers.set(peerSessionId, link);

    const microphone = this.host.microphone();
    if (link.botPeer) {
      // An answerer must attach to the offered m-line. Pre-creating sendonly
      // here makes Chromium retain an unassociated second microphone.
      if (isInitiator) {
        const transceiver = pc.addTransceiver('audio', { direction: this.botAudioDirection(link) });
        link.audioSender = transceiver.sender;
        if (!link.receiveOnly && microphone) await transceiver.sender.replaceTrack(microphone);
      }
    } else if (microphone) {
      link.audioSender = pc.addTrack(microphone, new MediaStream([microphone]));
    } else {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
    }

    // The camera. Screens never ride this connection: the native screen owner
    // publishes and receives them on its own (#689).
    if (!link.botPeer) {
      const camera = this.host.camera();
      if (camera) {
        link.videoSender = pc.addTrack(camera, new MediaStream([camera]));
      } else {
        pc.addTransceiver('video', { direction: 'sendrecv' });
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && this.peers.get(peerSessionId) === link) {
        clientLog.info('WEBRTC', `ICE candidate generated for ${peerSessionId}`, {
          type: event.candidate.type,
          protocol: event.candidate.protocol,
          address: event.candidate.address ? '***' : null,
        });
        this.host.client().send(MessageType.RTC_SIGNAL, {
          targetSessionId: peerSessionId,
          fromSessionId: this.host.selfSessionId(),
          signalType: 'candidate',
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      }
    };

    // Remote microphone and camera: their rules live in the sink (R-VOICE-5).
    pc.ontrack = (event) => {
      if (!this.isCurrent(link)) {
        event.track.stop();
        return;
      }
      console.log(`[WebRTC] Received remote track (${event.track.kind}) from ${peerSessionId}`);
      const remote: RemoteTrack = {
        peerSessionId, kind: event.track.kind === 'audio' ? 'mic' : 'camera', track: event.track,
        receiver: () => this.isCurrent(link) ? event.receiver : null,
      };
      this.host.media.trackArrived(remote);
      event.track.onended = () => {
        if (this.isCurrent(link)) this.host.media.trackEnded(peerSessionId, remote.kind, event.track);
      };
      event.track.onunmute = () => {
        if (this.isCurrent(link)) this.host.media.trackUnmuted(peerSessionId, remote.kind, event.track);
      };
    };

    pc.oniceconnectionstatechange = () => {
      if (!this.isCurrent(link)) return;
      const iceState = pc.iceConnectionState;
      clientLog.info('WEBRTC', `Peer ${peerSessionId} ICE state: ${iceState}`);
      console.log(`[WebRTC] Peer ${peerSessionId} ICE state: ${iceState}`);
      this.recovery.iceStateChanged(link);
    };

    pc.onconnectionstatechange = () => {
      if (!this.isCurrent(link)) return;
      const state = pc.connectionState;
      clientLog.info('WEBRTC', `Peer ${peerSessionId} connection state: ${state}`);
      console.log(`[WebRTC] Peer ${peerSessionId} state: ${state}`);
      this.recovery.connectionStateChanged(link);
      if (state !== 'connected') return;
      this.host.applyQuality();
      // Measured at once: the relay indicator follows ICE as it settles
      // (#466), and the ping does not wait for the next sample.
      this.host.linkConnected();
      // A change held up while the link was down goes out now (R-VOICE-4).
      void this.renegotiateIfNeeded(link);
    };

    applyVideoCodecPreferences(pc);
    if (this.peers.get(peerSessionId) !== link) return;

    // Watchdog to ensure connection establishes within a reasonable time
    this.recovery.watch(link);

    if (isInitiator) await this.sendOffer(link);
  }

  public async sendOffer(link: PeerLink, iceRestart = false): Promise<void> {
    if (!this.isCurrent(link)) return;
    // Native "stable" fires before the answer promise resolves and is sent.
    for (let pending = this.nativeTasks.get(link); pending; pending = this.nativeTasks.get(link)) {
      await pending;
      if (!this.isCurrent(link)) return;
    }
    const client = this.host.client();
    const localSessionId = this.host.selfSessionId();
    const negotiation: PeerNegotiation = {};
    link.negotiation = negotiation;
    const isCurrent = () => this.isCurrent(link) && link.negotiation === negotiation;
    try {
      link.makingOffer = true;
      applyVideoCodecPreferences(link.pc);
      // The offer describes every local change made up to this point.
      link.negotiationNeeded = false;
      const offer = await link.pc.createOffer({
        ...(!link.botPeer ? { offerToReceiveAudio: true, offerToReceiveVideo: true } : {}),
        iceRestart,
      });
      if (!isCurrent()) return;
      await link.pc.setLocalDescription(offer);
      if (!isCurrent()) return;
      const description = link.pc.localDescription;
      if (!description) throw new Error('The offer left no local description to send.');

      client.send(MessageType.RTC_SIGNAL, {
        targetSessionId: link.peerSessionId,
        fromSessionId: localSessionId,
        signalType: 'offer',
        subscriptionId: link.subscriptionId,
        sdp: description.toJSON ? description.toJSON() : description,
      });
    } catch (err) {
      // Nothing reached the peer: keep the change owed for the next offer.
      if (isCurrent()) link.negotiationNeeded = true;
      clientLog.error('WEBRTC', `Error sending offer to ${link.peerSessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[WebRTC] Error sending offer to ${link.peerSessionId}:`, err);
    } finally {
      if (link.negotiation === negotiation) link.makingOffer = false;
    }
  }

  private async sendAnswer(link: PeerLink, negotiation: PeerNegotiation): Promise<boolean> {
    const client = this.host.client();
    const localSessionId = this.host.selfSessionId();
    const isCurrent = () => this.isCurrent(link) && link.negotiation === negotiation;
    if (!isCurrent()) return false;
    applyVideoCodecPreferences(link.pc);
    // An answer carries the local direction of every m-line the offer has, so
    // it settles changes still owed; a brand-new m-line still needs an offer.
    link.negotiationNeeded = false;
    try {
      const answer = await link.pc.createAnswer();
      if (!isCurrent()) return false;
      await link.pc.setLocalDescription(answer);
      if (!isCurrent()) return false;
      client.send(MessageType.RTC_SIGNAL, {
        targetSessionId: link.peerSessionId,
        fromSessionId: localSessionId,
        signalType: 'answer',
        subscriptionId: link.subscriptionId,
        sdp: answer,
      });
      return true;
    } catch (error) {
      if (isCurrent()) link.negotiationNeeded = true;
      throw error;
    }
  }

  /**
   * A signal from a peer of the call: the facade already checked that the call
   * runs on P2P and is not suspended.
   */
  public async handleSignal(payload: WebRtcSignalPayload): Promise<void> {
    const { fromSessionId, signalType } = payload;
    // An offer is the one signal that builds a link out of nothing, so every
    // signal is checked against the call we are actually in. Signalling is
    // asynchronous: an offer sent just before somebody left the channel — or
    // before we left it — still lands here afterwards, and answering it opened
    // a peer connection nobody was on the other end of. That connection then
    // sat there until the 20s countdown expired and pinned "no direct
    // connection" on a person sitting in a different voice channel, where there
    // is no link to fail in the first place (#466).
    if (!this.host.isPeerInCall(fromSessionId)) return;
    // The protocol keeps the `screen-*` signals, but no client sends them since #689:
    // native screens publish and negotiate through their own owner.
    if (signalType !== 'offer' && signalType !== 'answer' && signalType !== 'candidate') return;

    let link = this.peers.get(fromSessionId);
    if (!link && signalType === 'offer') {
      await this.connect(fromSessionId, false);
      link = this.peers.get(fromSessionId);
    }
    if (!link) return;

    const peer = link;
    try {
      // Every description names the connection it belongs to (PeerLink.subscriptionId).
      if ((signalType === 'offer' || signalType === 'answer') && !payload.subscriptionId) return;
      // Candidates share the queue of descriptions, so none reaches the
      // connection ahead of the description it follows (R-VOICE-7).
      const changed = await this.runTask(peer, () => this.applySignal(peer, payload));
      if (!changed || !this.isCurrent(peer)) return;
      this.host.applyQuality();
      // Follow-up offers must run outside the incoming-description queue.
      await this.renegotiateIfNeeded(peer);
    } catch (error) {
      clientLog.error('WEBRTC', `Could not finish negotiation with ${fromSessionId}`, {
        signalType, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applySignal(link: PeerLink, payload: WebRtcSignalPayload): Promise<boolean> {
    if (!this.isCurrent(link)) return false;
    const { fromSessionId, signalType, sdp, candidate } = payload;
    try {
      if (signalType === 'offer' && sdp) {
        const offerCollision = link.makingOffer || link.pc.signalingState !== 'stable';
        // The impolite side keeps its own offer; the candidates that follow
        // the dropped one are then expected not to apply.
        link.ignoreOffer = offerCollision && !link.isPolite;
        if (link.ignoreOffer) {
          console.log(`[WebRTC] Impolite peer ignoring offer collision from ${fromSessionId}`);
          return false;
        }
        if (offerCollision) {
          console.log(`[WebRTC] Polite peer rolling back for offer from ${fromSessionId}`);
        }
        const negotiation: PeerNegotiation = {};
        link.negotiation = negotiation;
        link.makingOffer = false;
        if (offerCollision && link.pc.signalingState === 'have-local-offer') {
          await link.pc.setLocalDescription({ type: 'rollback' });
        }

        if (!this.isCurrent(link) || link.negotiation !== negotiation) return false;
        await link.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (!this.isCurrent(link) || link.negotiation !== negotiation) return false;
        await this.flushCandidates(link);

        const microphone = this.host.microphone();
        if (link.botPeer) {
          link.receiveOnly = !isReceivingBotVoice(this.host.participants().get(fromSessionId)?.voiceState);
          const primary = microphoneTransceiver(link);
          if (primary) {
            primary.direction = this.botAudioDirection(link);
            await primary.sender.replaceTrack(link.receiveOnly ? null : microphone);
            link.audioSender = primary.sender;
          }
        }
        // 1. The answer carries the microphone on the connection's audio m-line.
        if (!link.receiveOnly && microphone) {
          const audio = microphoneTransceiver(link);
          if (audio) await audio.sender.replaceTrack(microphone);
          else link.audioSender = link.pc.addTrack(microphone, new MediaStream([microphone]));
        }

        // 2. ...and the camera on its only video m-line.
        const camera = link.botPeer ? null : this.host.camera();
        const video = cameraTransceiver(link);
        if (video) {
          video.direction = link.botPeer ? 'inactive' : camera ? 'sendrecv' : 'recvonly';
          await video.sender.replaceTrack(camera);
          link.videoSender = video.sender;
        } else if (camera) {
          link.videoSender = link.pc.addTrack(camera, new MediaStream([camera]));
        }

        return await this.sendAnswer(link, negotiation);
      } else if (signalType === 'answer' && sdp) {
        if (link.pc.signalingState === 'have-local-offer') {
          link.ignoreOffer = false;
          await link.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          if (!this.isCurrent(link)) return false;
          await this.flushCandidates(link);
          return true;
        }
      } else if (signalType === 'candidate' && candidate) {
        if (link.pc.remoteDescription?.type) await this.addCandidate(link, candidate);
        else this.queueCandidate(link, candidate);
      }
    } catch (err) {
      clientLog.error('WEBRTC', `Signal handling error from ${fromSessionId}`, {
        signalType,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[WebRTC] Signal handling error from ${fromSessionId}:`, err);
    }
    return false;
  }

  /** Holds a candidate until the first remote description arrives, within a bound (R-VOICE-7). */
  private queueCandidate(link: PeerLink, candidate: RTCIceCandidateInit): void {
    if (link.candidateQueue.length < P2pMeshTransport.MAX_PENDING_ICE_CANDIDATES) {
      link.candidateQueue.push(candidate);
      return;
    }
    if (link.candidatesDropped) return;
    link.candidatesDropped = true;
    clientLog.warn('WEBRTC', `Dropping ICE candidates from ${link.peerSessionId}: `
      + `${P2pMeshTransport.MAX_PENDING_ICE_CANDIDATES} are already waiting for a description`);
  }

  private async flushCandidates(link: PeerLink): Promise<void> {
    const queued = link.candidateQueue.splice(0);
    link.candidatesDropped = false;
    for (const candidate of queued) {
      if (!this.isCurrent(link)) return;
      await this.addCandidate(link, candidate);
    }
  }

  /**
   * Applies a remote candidate. Only those following an offer dropped in a
   * collision are expected to fail; any other failure is a real ICE problem,
   * so it is logged instead of swallowed (#426).
   */
  private async addCandidate(link: PeerLink, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await link.pc.addIceCandidate(candidate);
    } catch (error) {
      if (link.ignoreOffer || !this.isCurrent(link)) return;
      clientLog.warn('WEBRTC', `Could not apply an ICE candidate from ${link.peerSessionId}`, {
        type: /\btyp (\S+)/.exec(candidate.candidate ?? '')?.[1] ?? null,
        sdpMid: candidate.sdpMid ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** One native operation at a time per link: descriptions and candidates in arrival order. */
  private async runTask<T>(link: PeerLink, operation: () => Promise<T>): Promise<T> {
    const previous = this.nativeTasks.get(link) ?? Promise.resolve();
    const task = previous.then(operation);
    // The caller receives failures; the queue must still admit later updates.
    const settled = task.then(() => {}, () => {});
    this.nativeTasks.set(link, settled);
    try {
      return await task;
    } finally {
      if (this.nativeTasks.get(link) === settled) this.nativeTasks.delete(link);
    }
  }

  /**
   * Sends an offer once the link can take one, when it owes the peer a local
   * change: a flagged one (`negotiationNeeded`), or a track whose offer was
   * dropped by a glare/rollback (see hasUnnegotiatedSenders). A failed link is
   * left to its ICE restart or rebuild, whose offer carries the change anyway.
   */
  private async renegotiateIfNeeded(link: PeerLink): Promise<void> {
    const pc = link.pc;
    if (!this.isCurrent(link) || pc.signalingState !== 'stable' || link.makingOffer
      || pc.connectionState === 'failed') return;
    if (!link.negotiationNeeded && !hasUnnegotiatedSenders(pc)) return;
    console.log(`[WebRTC] Re-negotiating pending local changes for ${link.peerSessionId}`);
    await this.sendOffer(link);
  }

  private botAudioDirection(link: PeerLink): RTCRtpTransceiverDirection {
    const publish = this.host.participants().get(link.peerSessionId)?.voiceState?.botVoicePermissions?.publish !== false;
    return link.receiveOnly ? publish ? 'recvonly' : 'inactive' : publish ? 'sendrecv' : 'sendonly';
  }

  public syncBotVoiceReception(peerSessionId: string): void {
    const link = this.peers.get(peerSessionId);
    if (!link?.botPeer) return;
    link.receiveOnly = !isReceivingBotVoice(this.host.participants().get(peerSessionId)?.voiceState);
    link.botAudioSync = (link.botAudioSync ?? Promise.resolve()).then(async () => {
      if (!this.isCurrent(link)) return;
      const primary = microphoneTransceiver(link);
      if (!primary) return;
      link.receiveOnly = !isReceivingBotVoice(this.host.participants().get(peerSessionId)?.voiceState);
      primary.direction = this.botAudioDirection(link);
      await primary.sender.replaceTrack(link.receiveOnly ? null : this.host.microphone());
      if (this.isCurrent(link)) await this.renegotiateIfNeeded(link);
    }).catch((error: unknown) => {
      clientLog.error('WEBRTC', 'Could not apply bot microphone reception permission', { error: String(error) });
      if (this.isCurrent(link)) this.host.removePeer(peerSessionId);
    });
  }

  /**
   * Points every link at another microphone, as one change: if any link
   * refuses it, the ones already switched go back (`ensureCurrent` may cancel
   * between links). Resolves with how to undo the switch afterwards.
   */
  public async replaceMicrophone({ track, ensureCurrent }: MicrophoneChange): Promise<Rollback> {
    const replaced: Array<{ sender: RTCRtpSender; previous: MediaStreamTrack | null; pc: RTCPeerConnection }> = [];
    const rollback: Rollback = async () => {
      const restored = await Promise.allSettled(replaced.filter(({ pc }) => pc.connectionState !== 'closed')
        .map(({ sender, previous }) => sender.replaceTrack(previous)));
      if (restored.some((result) => result.status === 'rejected')) {
        console.warn('[WebRTC] Some microphone senders could not be restored');
      }
    };
    try {
      for (const link of this.peers.values()) {
        ensureCurrent();
        if (link.receiveOnly || link.pc.connectionState === 'closed') continue;
        const sender = link.audioSender ?? microphoneTransceiver(link)?.sender;
        if (!sender) {
          // A bot that calls us gets its microphone m-line from its own offer,
          // which attaches the microphone of that moment: it has nothing to swap
          // yet, and must not fail the switch for everyone else (R-VOICE-4).
          if (link.botPeer) continue;
          throw new Error('Microphone sender is unavailable');
        }
        const previous = sender.track;
        await sender.replaceTrack(track);
        replaced.push({ sender, previous, pc: link.pc });
      }
      ensureCurrent();
    } catch (error) {
      await rollback();
      throw error;
    }
    return rollback;
  }

  /** Attaches a microphone to every link that sends one, and offers it where it is new. */
  public async setMicrophone(track: MediaStreamTrack | null): Promise<void> {
    for (const link of this.peers.values()) {
      if (link.receiveOnly) continue;
      try {
        const audio = microphoneTransceiver(link);
        if (audio) await audio.sender.replaceTrack(track);
        else if (track) link.audioSender = link.pc.addTrack(track, new MediaStream([track]));
        if (link.pc.signalingState === 'stable') await this.sendOffer(link);
      } catch (err) {
        console.warn(`[WebRTC] Error updating audio track for peer ${link.peerSessionId}:`, err);
      }
    }
  }

  /**
   * Points every peer's camera m-line at `track`.
   *
   * The direction and the track apply locally at once; telling a peer about a
   * new direction takes an offer/answer, which a peer that is reconnecting, not
   * seeing us yet or past recovery can hold up for good. That wait belongs to
   * the stuck link alone: it is flagged and renegotiates as soon as it can
   * take an offer. Waiting on every peer in turn let one silent peer fail the
   * camera for everybody, and turned it off with an error (R-VOICE-4).
   */
  public async setCamera(track: MediaStreamTrack | null, ensureCurrent: () => void): Promise<void> {
    const links = [...this.peers.values()].filter(link => !link.botPeer && this.isCurrent(link)
      && link.pc.connectionState !== 'closed');
    const failures: unknown[] = [];
    for (const link of links) {
      ensureCurrent();
      if (!this.isCurrent(link)) continue;
      try {
        await this.attachCamera(link, track);
      } catch (error) {
        if (!this.isCurrent(link)) continue;
        clientLog.warn('VIDEO', `Could not update the camera for peer ${link.peerSessionId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        failures.push(error);
      }
    }
    ensureCurrent();
    // Only a change no peer could take is the publication's own failure.
    if (failures.length > 0 && failures.length === links.length) throw failures[0];
    await Promise.all(links.map(link => this.renegotiateIfNeeded(link)));
  }

  private async attachCamera(link: PeerLink, track: MediaStreamTrack | null): Promise<void> {
    const transceiver = cameraTransceiver(link);
    if (transceiver) {
      const direction = track ? 'sendrecv' : 'recvonly';
      if (transceiver.direction !== direction) {
        transceiver.direction = direction;
        link.negotiationNeeded = true;
      }
      link.videoSender = transceiver.sender;
      if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
    } else if (track) {
      link.videoSender = link.pc.addTrack(track, new MediaStream([track]));
      link.negotiationNeeded = true;
    }
  }

  /** Takes a camera that failed to publish off every link still sending it. */
  public async detachCamera(track: MediaStreamTrack): Promise<void> {
    const cleanup = await Promise.allSettled([...this.peers.values()].map(async (link) => {
      const sender = cameraTransceiver(link)?.sender ?? link.videoSender;
      if (sender?.track === track && link.pc.connectionState !== 'closed') await sender.replaceTrack(null);
    }));
    if (cleanup.some((result) => result.status === 'rejected')) {
      clientLog.error('VIDEO', 'Could not detach every failed camera sender');
    }
  }

  /** Every sender publishing the local camera — one per peer (#493). */
  public cameraSenders(): RTCRtpSender[] {
    const senders: RTCRtpSender[] = [];
    for (const link of this.peers.values()) {
      if (link.videoSender) senders.push(link.videoSender);
    }
    return senders;
  }

  public receiverForTrack(peerSessionId: string, trackId: string): RTCRtpReceiver | null {
    const link = this.peers.get(peerSessionId);
    if (!link) return null;
    return link.pc.getReceivers().find((receiver) => receiver.track?.id === trackId) ?? null;
  }

  /** The shared encoding policy on every sender of every link, until `isCurrent` says a newer one won. */
  public async applyQuality(preset: QualityPresetType, profile: QualityProfile, isCurrent: () => boolean): Promise<void> {
    for (const link of this.peers.values()) {
      for (const sender of link.pc.getSenders()) {
        if (!isCurrent()) return;
        if (!sender.track) continue;
        const policy = getMediaEncodingPolicy(sender.track.kind === 'audio' ? 'audio' : 'camera', preset, profile);
        try {
          await updateRtpSenderParameters(sender, params =>
            isCurrent() && this.isCurrent(link) && !!sender.track && applyMediaEncodingPolicy(params, policy));
        } catch (error) {
          if (this.isCurrent(link) && sender.track?.readyState === 'live') {
            clientLog.warn('WEBRTC', 'Could not apply sender quality parameters', {
              peer: link.peerSessionId, error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }

  /** The ping of the mesh: the average of the links carrying media. */
  public async samplePing(): Promise<number | null> {
    return averageRoundTrip(await Promise.all([...this.peers.values()]
      .filter(link => link.pc.connectionState === 'connected')
      .map(link => this.sampleRoute(link))));
  }

  /**
   * Reads the route of a peer link and keeps its relay indicator current (#425).
   *
   * ICE picks the relay on its own, and only when no direct path exists, so
   * this is read from the candidate pair actually carrying media rather than
   * assumed from whether a TURN server was offered. It is sampled for the whole
   * call rather than once: relay pairs have the lowest priority but the
   * shortest round trip, so ICE regularly connects through the relay and then
   * promotes the direct pair a moment later. Reading it once at `connected`
   * left calls that had gone direct permanently labelled as relayed (#466).
   */
  private async sampleRoute(link: PeerLink): Promise<number | null> {
    const peerSessionId = link.peerSessionId;
    let route: CandidateRoute | null;
    try {
      route = candidateRoute(await link.pc.getStats());
    } catch (error) {
      if (this.isCurrent(link)) {
        clientLog.warn('WEBRTC', `Failed to read the route of peer ${peerSessionId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
    if (!route || !this.isCurrent(link)) return null;
    if ((route.local || route.remote) && link.isRelayed !== route.relayed) {
      link.isRelayed = route.relayed;
      this.host.participants().setPeerRelayed(peerSessionId, route.relayed);
      clientLog.info(
        'WEBRTC',
        route.relayed
          ? `Peer ${peerSessionId} is going through the TURN relay`
          : `Peer ${peerSessionId} is connected directly (P2P)`,
        { localType: route.local?.type, remoteType: route.remote?.type }
      );
      console.log(
        `[WebRTC] Peer ${peerSessionId} route: ${route.relayed ? 'TURN relay' : 'direct'} (${route.local?.type} / ${route.remote?.type})`
      );
    }
    return route.rttMs;
  }

  /** A dead link goes before it is rebuilt; playback waits for the new one. */
  private retire(link: PeerLink): void {
    if (this.peers.get(link.peerSessionId) === link) this.peers.delete(link.peerSessionId);
    closeLink(link);
    this.host.media.linkLost(link.peerSessionId);
  }

  /** The person left: their link and everything it showed go with it. */
  public remove(peerSessionId: string): void {
    this.recovery.forget(peerSessionId);
    const link = this.peers.get(peerSessionId);
    if (!link) return;
    this.peers.delete(peerSessionId);
    closeLink(link);
  }

  public closeAll(): void {
    for (const peerSessionId of this.peerIds()) this.remove(peerSessionId);
    this.recovery.reset();
  }
}
