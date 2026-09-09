import {
  IceServerConfig,
  MessageType,
  QUALITY_PRESETS,
  QualityPresetType,
  WebRtcSignalPayload,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { networkClient, type NetworkClient } from './NetworkClient';
import { participantManager, type ParticipantManager } from './ParticipantManager';
import { sessionManager } from './SessionManager';
import { currentEventOrigin } from './sessionRouting';
import { clientLog } from './ClientLogService';
import { settingsStore } from '../stores/settingsStore';
import { serverStore, type ServerStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';
import { videoService } from './VideoService';
import { RemoteMediaRouter } from './webrtc/RemoteMediaRouter';
import { RemoteVadMonitor } from './webrtc/RemoteVadMonitor';
import { RtcDiagnosticsCollector } from './webrtc/RtcDiagnosticsCollector';
import { applyVideoCodecPreferences, getSdpVideoCodecOrder } from './webrtc/codecPreferences';
import { SfuClientEngine, SfuConsumerTrackEvent } from './webrtc/SfuClientEngine';

export interface PeerSession {
  peerSessionId: string;
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  /** Remote screen streams keyed by share id (#253: up to MAX_SCREEN_SHARES). */
  remoteScreenStreams: Map<string, MediaStream>;
  isPolite: boolean;
  makingOffer: boolean;
  candidateQueue: RTCIceCandidateInit[];
  audioSender?: RTCRtpSender | null;
  videoSender?: RTCRtpSender | null;
  /** Dedicated screen video senders keyed by share id (#253). */
  screenVideoSenders: Map<string, RTCRtpSender>;
  screenAudioSender?: RTCRtpSender | null;
  // Auto-recovery and retry management
  iceRestartAttempts: number;
  reconnectAttempts: number;
  watchdogTimer?: any;
  disconnectGraceTimer?: any;
  isRecovering: boolean;
  /**
   * Last relay verdict pushed to the participant list, so the periodic sample
   * only writes (and logs) when the route actually changes (#466).
   */
  isRelayed?: boolean;
  /**
   * True once an audio track from this peer has been classified as the
   * microphone (#467).
   *
   * The "second audio track is the screen" heuristic below normally reads this
   * off `remoteStream`, but the microphone of our own other device never lands
   * there — it is dropped on arrival. Without remembering that it came, the
   * screen audio that follows would look like the first audio track and be
   * mistaken for a microphone.
   */
  micTrackSeen?: boolean;
}

/**
 * WebRtcManager implements a full-mesh topology: each participant maintains a
 * direct RTCPeerConnection to every other participant in the voice channel.
 * Traffic and encode/upload cost therefore grow as O(N²). This is intentional
 * and adequate for the project's scope (small groups of friends), bounded by
 * MAX_PARTICIPANTS_PER_CHANNEL_DEFAULT = 10. Scaling significantly beyond that
 * would require an SFU (Selective Forwarding Unit) instead of a mesh.
 */
export class WebRtcManager {
  /**
   * How long a peer may stay unconnected before the user is told the direct
   * link is not happening (#426).
   *
   * This is deliberately independent of the recovery ladder: waiting for the
   * ICE restarts and hard reconnects to run out took over two minutes, and any
   * momentary `connected` reset the counters and started it over, so the
   * warning could never show. The ladder still runs in the background — this
   * only decides when to warn.
   */
  private static readonly PEER_FAILURE_THRESHOLD_MS = 20000;

  /**
   * How often the route to each connected peer is re-read (#466).
   *
   * Cheap enough to keep running for the whole call — `getStats()` on a handful
   * of peers every few seconds — and short enough that the indicator catches up
   * with an ICE upgrade well before anyone reads anything into it.
   */
  private static readonly RELAY_SAMPLE_INTERVAL_MS = 5000;

  /**
   * Ceiling for the SFU rejoin backoff.
   *
   * Unlike a peer link, the SFU has nothing to degrade to: if it is down the
   * call is down. So the ladder never gives up while the user sits in the
   * channel — it backs off to this delay and keeps retrying from there.
   */
  private static readonly SFU_RECONNECT_MAX_DELAY_MS = 15000;
  /**
   * Failed rejoins before the user is told, which is deliberately later than
   * the first attempt: a transport that drops and comes straight back should
   * not raise an alert nobody needs to act on.
   */
  private static readonly SFU_RECONNECT_WARN_AFTER = 3;

  private peers: Map<string, PeerSession> = new Map();
  private mediaRouter: RemoteMediaRouter;
  private vadMonitor: RemoteVadMonitor;
  private diagnosticsCollector: RtcDiagnosticsCollector;
  private sfuEngine: SfuClientEngine;
  private sfuReconnectAttempts: number = 0;
  private sfuReconnectTimer: any = null;
  private isSfuJoining: boolean = false;
  /**
   * A join was asked for while another was running. The one in flight captured
   * the channel as it was when it started, so it cannot serve a request made
   * after the state moved: it runs again once the current one unwinds.
   */
  private sfuJoinRequested: boolean = false;
  /**
   * Bumped whenever the SFU session is torn down or a new join starts. A join
   * takes several round-trips, and the user can leave the channel or a newer
   * join can begin while an older one is still awaiting; comparing the epoch
   * it started with is what tells the stale join to undo itself instead of
   * finishing and reviving a session nobody is in.
   */
  private sfuJoinEpoch: number = 0;

  private screenAudioStreamIds: Set<string> = new Set();
  private screenVideoStreamIds: Set<string> = new Set();
  // Tracks received before screen-audio-meta arrived, keyed by streamId
  private pendingScreenAudioTracks: Map<string, { track: MediaStreamTrack; peerSessionId: string }> = new Map();
  // Screen video tracks received before screen-video-meta arrived, keyed by streamId
  private pendingScreenVideoTracks: Map<string, { track: MediaStreamTrack; peerSessionId: string }> = new Map();

  /**
   * One-shot timers that flag a peer as unreachable (#426).
   *
   * Keyed by session id rather than stored on the `PeerSession`, because a hard
   * reconnect throws the session away and builds a new one: a budget living on
   * the session would restart from zero on every retry and the warning would
   * never fire.
   */
  private peerFailureTimers: Map<string, any> = new Map();
  /** Peers already flagged as unreachable, so the warning is raised once (#426). */
  private failedPeers: Set<string> = new Set();
  /**
   * Peers we have talked to at least once in this call (#426).
   *
   * Separates "never managed to connect" from "connected and dropped": only the
   * former is reported the moment ICE gives up, since a drop on a link that was
   * working is usually a blip worth waiting out.
   */
  private everConnectedPeers: Set<string> = new Set();
  /** Interval timers that keep the relay indicator honest, per peer (#466). */
  private relayMonitors: Map<string, any> = new Map();
  private localAudioTrack: MediaStreamTrack | null = null;
  private localCameraTrack: MediaStreamTrack | null = null;
  /** Local screen video tracks keyed by share id (#253). */
  private localScreenTracks: Map<string, MediaStreamTrack> = new Map();
  /** The MediaStream wrapper announced to peers for each local share (#253). */
  private localScreenStreams: Map<string, MediaStream> = new Map();
  private localScreenAudioTrack: MediaStreamTrack | null = null;
  private screenAudioStream: MediaStream | null = null;
  private screenAudioStreamId: string | null = null;
  private currentPreset: QualityPresetType = settingsStore.qualityPreset;
  private currentSessionId: string = '';
  private isDeafened: boolean = false;
  private isMigratingVoiceMode: boolean = false;
  private migrationDebounceTimer: any = null;

  /**
   * ICE servers used for every peer connection.
   *
   * These are defaults: a server that runs its own TURN relay overrides the
   * whole list at login through `setIceServers()` (#425). They stay hardcoded
   * as the fallback so a server released before TURN support — or one with the
   * relay off — keeps working exactly as before.
   */
  private rtcConfig: RTCConfiguration = {
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

  constructor() {
    this.mediaRouter = new RemoteMediaRouter(() => this.voiceParticipants);
    this.vadMonitor = new RemoteVadMonitor(() => this.voiceParticipants);
    this.diagnosticsCollector = new RtcDiagnosticsCollector();
    this.sfuEngine = new SfuClientEngine(
      () => this.signalClient,
      () => this.currentSessionId,
      {
        onHealthChanged: (health) => voiceStore.setConnectionHealth(health),
        onRoster: (channelId, participants) => {
          if (voiceStore.currentVoiceChannelId === channelId) {
            this.voiceParticipants.reconcileVoiceChannel(channelId, participants);
          }
        },
        onConsumerTrack: (event) => this.handleSfuConsumerTrack(event),
        onConsumerClosed: (sessionId, mediaType, shareId) => this.handleSfuConsumerClosed(sessionId, mediaType, shareId),
        onConnectionFailed: (reason) => this.handleSfuConnectionFailure(reason),
        onConnected: () => this.handleSfuConnected(),
      }
    );
    this.setupSignalListeners();
  }

  /** Our own session id: the tie-breaker for who initiates each peer link (#309). */
  public setCurrentSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /**
   * Connection that carries the signalling for the current call.
   *
   * The call lives on one server even while the user browses another (#400),
   * and much of the signalling fires from async callbacks (ICE candidates,
   * renegotiation) — long after the routing context of the originating event is
   * gone. Resolving the client from the call itself keeps offers and candidates
   * going to the right server no matter what is on screen.
   */
  private get signalClient(): NetworkClient {
    const key = voiceStore.voiceSessionKey;
    const session = key ? sessionManager.get(key) : undefined;
    return session ? session.client : networkClient;
  }

  /** Participants of the server hosting the call — see `signalClient` (#400). */
  private get voiceParticipants(): ParticipantManager {
    const key = voiceStore.voiceSessionKey;
    const session = key ? sessionManager.get(key) : undefined;
    return session ? session.participants : participantManager;
  }

  /** State of the server hosting the call — see `signalClient` (#400). */
  private get voiceServerStore(): ServerStore {
    const key = voiceStore.voiceSessionKey;
    const session = key ? sessionManager.get(key) : undefined;
    return session ? session.serverStore : serverStore;
  }

  public setQualityPreset(preset: QualityPresetType): void {
    this.currentPreset = preset;
    videoService.applyQualityPreset(preset).catch((err) => {
      clientLog.warn('WEBRTC', 'Error applying quality preset to videoService', { error: String(err) });
    });
    this.applyBitrateConstraints();
  }

  private setupSignalListeners(): void {
    appEvents.on(`message.${MessageType.RTC_SIGNAL}`, async (payload: WebRtcSignalPayload) => {
      // Only the server hosting the call may drive the peer mesh; a signal from
      // any other connected server would tear down or duplicate peers (#400).
      const voiceKey = voiceStore.voiceSessionKey;
      const origin = currentEventOrigin();
      if (voiceKey && origin && origin !== voiceKey) return;
      await this.handleIncomingSignal(payload);
    });

    appEvents.on('user_volume.changed', (data: { sessionId: string; volume: number }) => {
      this.mediaRouter.setPeerVolume(data.sessionId, data.volume);
    });

    appEvents.on('screen_audio_volume.changed', (data: { sessionId: string; volume: number }) => {
      this.mediaRouter.setScreenAudioVolume(data.sessionId, data.volume);
    });

    appEvents.on('participants.updated', () => {
      this.mediaRouter.applyUserVolumes();
    });

    appEvents.on('server.meta_updated', () => {
      if (this.migrationDebounceTimer) {
        clearTimeout(this.migrationDebounceTimer);
      }
      this.migrationDebounceTimer = setTimeout(() => {
        this.migrationDebounceTimer = null;
        void this.handleVoiceModeUpdate();
      }, 100);
    });
  }

  private async handleVoiceModeUpdate(): Promise<void> {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId) return;

    const isSfu = this.voiceServerStore.serverDetails?.voiceMode === 'sfu';
    const currentlyRunningSfu = this.sfuEngine.isReady() || this.sfuEngine.isChannelConnected();
    const targetIsSfu = isSfu;

    if (currentlyRunningSfu === targetIsSfu) {
      return;
    }

    if (this.isMigratingVoiceMode) {
      console.log('[WebRTC] Voice mode migration already in flight, skipping duplicate call.');
      return;
    }

    this.isMigratingVoiceMode = true;
    const fromMode = currentlyRunningSfu ? 'SFU' : 'P2P';
    const toMode = targetIsSfu ? 'SFU' : 'P2P';

    console.log(`[WebRTC] Dynamic voice mode transition starting: ${fromMode} -> ${toMode}. Migrating active call...`);
    clientLog.info('WEBRTC', `Dynamic voice mode transition starting: ${fromMode} -> ${toMode}`);

    try {
      // 1. Cleanly tear down previous session connections and media router elements
      this.closeAllPeers();

      // 2. Clear remote participant media streams so views do not retain closed tracks
      const participants = this.voiceParticipants.getInVoiceChannel(channelId);
      for (const p of participants) {
        const sid = p.user.sessionId || p.user.id;
        if (sid && sid !== this.currentSessionId) {
          this.voiceParticipants.setRemoteStream(sid, new MediaStream());
        }
      }

      // 3. Pause briefly so both server and remote peers complete their teardown before new handshakes
      await new Promise((resolve) => setTimeout(resolve, 150));

      // 4. Re-initialize in the new target mode
      this.resetSfuReconnect();
      if (targetIsSfu) {
        await this.initSfuForCurrentChannel();
      } else {
        this.connectToAllParticipants();
      }

      // 5. Notify UI of the mode switch
      appEvents.emit('voice.mode_switched', { mode: targetIsSfu ? 'sfu' : 'p2p' });
      console.log(`[WebRTC] Dynamic voice mode transition completed: ${fromMode} -> ${toMode}`);
    } catch (err) {
      console.error('[WebRTC] Error during dynamic voice mode migration:', err);
    } finally {
      this.isMigratingVoiceMode = false;
    }
  }

  public isSfuMode(): boolean {
    return this.voiceServerStore.serverDetails?.voiceMode === 'sfu';
  }

  public getVoiceStatus(): {
    mode: 'SFU' | 'P2P';
    serverVoiceModeConfig: string;
    sfuReconnectAttempts: number;
    channelId: string | null;
    isSfuReady: boolean;
    isSfuConnected: boolean;
    connectedP2pPeers: string[];
    localAudioTrackId?: string;
  } {
    const isSfu = this.isSfuMode();
    return {
      mode: isSfu ? 'SFU' : 'P2P',
      serverVoiceModeConfig: this.voiceServerStore.serverDetails?.voiceMode || 'p2p',
      sfuReconnectAttempts: this.sfuReconnectAttempts,
      channelId: voiceStore.currentVoiceChannelId,
      isSfuReady: this.sfuEngine.isReady(),
      isSfuConnected: this.sfuEngine.isChannelConnected(),
      connectedP2pPeers: Array.from(this.peers.keys()),
      localAudioTrackId: this.localAudioTrack?.id,
    };
  }

  public async initSfuForCurrentChannel(): Promise<void> {
    // A rejoin ladder already owns the connection: joining again from here
    // would race it and strand a second set of transports on the server. This
    // path is reached from every `connectToPeer` call, so an SFU that is down
    // would otherwise get one extra join per participant, ignoring the backoff.
    if (this.sfuReconnectTimer) return;
    await this.performSfuJoin();
  }

  /**
   * Builds the SFU session for the channel the user is in and publishes
   * whatever is being captured locally.
   *
   * Everything after the first await can outlive what asked for it: joining
   * takes several round-trips, during which the user can leave the channel,
   * the server can be switched to P2P, or a rejoin can tear the session down.
   * A join that resumes into any of those would rebuild transports for a
   * session nobody is in, leaving the engine reporting itself connected to a
   * channel that was already left — so it checks the epoch it started with and
   * undoes itself instead.
   */
  private async performSfuJoin(): Promise<void> {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId || !this.isSfuMode()) return;
    // Two joins in flight interleave their assignments inside the engine and
    // can leave it holding a send transport from one and a recv transport from
    // the other, whose server-side peer is already gone. The request is not
    // dropped, though: the running join captured the channel as it was when it
    // started, so a state change since then may be exactly what it is missing.
    // Switching voice channels does both at once — the join for the old
    // channel is still in flight when the join for the new one is asked for —
    // and dropping the second one left the client in the new channel with no
    // session at all, because the first then discarded itself for being stale.
    if (this.isSfuJoining) {
      this.sfuJoinRequested = true;
      return;
    }

    const epoch = ++this.sfuJoinEpoch;
    this.isSfuJoining = true;
    try {
      const ok = await this.sfuEngine.join(channelId);
      if (this.isSfuJoinStale(epoch, channelId)) {
        this.sfuEngine.leave();
        return;
      }
      if (!ok) {
        this.handleSfuConnectionFailure('Could not join the SFU room for this channel');
        return;
      }

      if (this.localAudioTrack) {
        await this.sfuEngine.produceMic(this.localAudioTrack);
      }
      if (this.localCameraTrack) {
        await this.sfuEngine.produceCamera(this.localCameraTrack);
      }
      for (const [shareId, track] of this.localScreenTracks.entries()) {
        await this.sfuEngine.produceScreenVideo(track, shareId);
      }
      if (this.localScreenAudioTrack) {
        await this.sfuEngine.produceScreenAudio(this.localScreenAudioTrack, 'default');
      }

      // Freshly created SFU producers start with no bitrate/degradation caps, so
      // push the active quality profile onto them so screen share keeps its
      // resolution under motion (#568).
      await this.applyBitrateConstraints();

      if (this.isSfuJoinStale(epoch, channelId)) {
        this.sfuEngine.leave();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      clientLog.error('SFU', 'SFU join threw', { error: message });
      // Without this the ladder would end here: the throw is what the retry
      // exists for, and nothing else would schedule the next attempt.
      if (!this.isSfuJoinStale(epoch, channelId)) {
        this.handleSfuConnectionFailure(message);
      }
    } finally {
      this.isSfuJoining = false;
      // Only re-run when the finished join did not already serve the request:
      // it may well have been for this very channel, and rebuilding a healthy
      // session closes the producers everyone is consuming — a room-wide audio
      // gap every time someone new arrives mid-join. The ladder is left alone
      // for the same reason `initSfuForCurrentChannel` refuses to run under it.
      const queued = this.sfuJoinRequested;
      this.sfuJoinRequested = false;
      if (queued && !this.sfuReconnectTimer && !this.sfuEngine.isReady()) {
        await this.performSfuJoin();
      }
    }
  }

  /**
   * Whether the join that started at `epoch` still describes the session the
   * user is actually in.
   */
  private isSfuJoinStale(epoch: number, channelId: string): boolean {
    return (
      this.sfuJoinEpoch !== epoch ||
      voiceStore.currentVoiceChannelId !== channelId ||
      !this.isSfuMode()
    );
  }

  public connectToAllParticipants(): void {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId) return;
    const participants = this.voiceParticipants.getInVoiceChannel(channelId);
    for (const p of participants) {
      const sid = p.user.sessionId || p.user.id;
      if (sid && sid !== this.currentSessionId) {
        const isInitiator = this.currentSessionId.localeCompare(sid) > 0;
        void this.connectToPeer(sid, isInitiator);
      }
    }
  }

  private handleSfuConsumerTrack(event: SfuConsumerTrackEvent): void {
    const { producerSessionId, mediaType, track, shareId, rtpReceiver } = event;
    console.log(`[SFU Client] Routing consumer track: mediaType=${mediaType}, from session=${producerSessionId}, trackId=${track.id}, enabled=${track.enabled}, readyState=${track.readyState}`);

    if (this.isOwnOtherDevice(producerSessionId) && mediaType === 'mic') {
      console.log(`[SFU] Dropping microphone from our own other device (${producerSessionId})`);
      return;
    }

    if (mediaType === 'mic') {
      const stream = new MediaStream([track]);
      console.log(`[SFU Client] Attaching remote mic stream for ${producerSessionId} to RemoteMediaRouter...`);
      const audioEl = this.mediaRouter.ensureVoiceAudioElement(producerSessionId, stream);
      console.log(`[SFU Client] Attached remote mic audio element for ${producerSessionId}. Element volume: ${audioEl.volume}, muted: ${audioEl.muted}`);
      this.vadMonitor.setupRemoteReceiverVad(producerSessionId, () => rtpReceiver);
    } else if (mediaType === 'camera') {
      const stream = new MediaStream([track]);
      this.voiceParticipants.setRemoteStream(producerSessionId, stream);

      const videoEl = document.getElementById(`video-${producerSessionId}-camera`) as HTMLVideoElement;
      if (videoEl) {
        videoEl.muted = true;
        videoEl.srcObject = stream;
        videoEl.play().catch(() => {});
      }
      const miniVideoEl = document.getElementById(`video-mini-${producerSessionId}-camera`) as HTMLVideoElement;
      if (miniVideoEl) {
        miniVideoEl.muted = true;
        miniVideoEl.srcObject = stream;
        miniVideoEl.play().catch(() => {});
      }
    } else if (mediaType === 'screen_video') {
      this.routeScreenVideoTrack(producerSessionId, track, shareId || 'default');
    } else if (mediaType === 'screen_audio') {
      this.routeScreenAudioTrack(producerSessionId, track);
    }
  }

  private handleSfuConsumerClosed(producerSessionId: string, mediaType: string, shareId?: string): void {
    if (mediaType === 'camera') {
      const current = this.voiceParticipants.get(producerSessionId)?.remoteStream;
      if (current) {
        current.getVideoTracks().forEach((t: MediaStreamTrack) => {
          try { t.stop(); } catch {}
          current.removeTrack(t);
        });
      }
    } else if (mediaType === 'screen_video') {
      this.voiceParticipants.removeRemoteScreenStream(producerSessionId, shareId || 'default');
    } else if (mediaType === 'screen_audio') {
      // Only the screen audio goes: `cleanupPeerMedia` would also tear down the
      // peer's voice <audio> element and its amplification pipeline, which is
      // how ending a screen share used to mute the sharer for everyone else.
      this.mediaRouter.cleanupScreenAudio(producerSessionId);
    }
  }

  /**
   * The SFU link is down, so rebuild it — there is nothing to fall back to.
   *
   * An earlier version dropped the call into a P2P mesh here. It could not
   * work: only the side whose transport failed switched protocol, while the
   * other kept answering as an SFU client and discarded the incoming offer in
   * `connectToPeer`, so the mesh never formed and the call went silent behind
   * a reassuring "contingency active" notice. Retrying the SFU is both simpler
   * and honest about what is happening.
   */
  private handleSfuConnectionFailure(reason: string): void {
    if (!this.isSfuMode() || !voiceStore.currentVoiceChannelId) return;
    // Send and recv transports usually fail together; one ladder covers both.
    if (this.sfuReconnectTimer) return;

    this.sfuReconnectAttempts++;
    const attempt = this.sfuReconnectAttempts;
    const delay = Math.min(
      WebRtcManager.SFU_RECONNECT_MAX_DELAY_MS,
      1000 * Math.pow(2, attempt - 1)
    );

    clientLog.warn('SFU', `SFU connection failed — rejoin #${attempt} in ${delay}ms`, { reason });
    console.warn(`[SFU] Connection failed (${reason}). Rejoin #${attempt} in ${delay}ms.`);
    voiceStore.setReconnecting(true);

    if (attempt === WebRtcManager.SFU_RECONNECT_WARN_AFTER) {
      appEvents.emit('sfu.reconnecting', { reason });
    }

    this.sfuReconnectTimer = setTimeout(() => {
      this.sfuReconnectTimer = null;
      void this.rejoinSfu();
    }, delay);
  }

  /** Tears the SFU session down and builds it again from scratch. */
  private async rejoinSfu(): Promise<void> {
    if (!voiceStore.currentVoiceChannelId || !this.isSfuMode()) return;
    // A join from an earlier rung is still running. Cutting it off here would
    // leave nobody to schedule the next one, so let it finish and take the
    // following rung instead.
    if (this.isSfuJoining) {
      this.handleSfuConnectionFailure('A previous SFU join is still in flight');
      return;
    }

    this.abandonSfuSession();
    // Calls the inner join directly: it schedules the next rung on its own if
    // this attempt fails.
    await this.performSfuJoin();
  }

  /** Closes the ladder once media is flowing again. */
  private handleSfuConnected(): void {
    if (this.sfuReconnectTimer) {
      clearTimeout(this.sfuReconnectTimer);
      this.sfuReconnectTimer = null;
    }
    const wasRecovering = this.sfuReconnectAttempts > 0;
    this.sfuReconnectAttempts = 0;
    voiceStore.setReconnecting(false);
    if (wasRecovering) {
      clientLog.info('SFU', 'SFU connection restored');
      appEvents.emit('sfu.reconnected', {});
    }
  }

  /**
   * Drops the SFU session and disowns any join still in flight, so one that
   * resumes afterwards undoes itself rather than rebuilding what was just
   * torn down.
   */
  private abandonSfuSession(): void {
    this.sfuJoinEpoch++;
    this.sfuEngine.leave();
  }

  /**
   * Stops the reconnection ladder. It deliberately does not touch
   * `isSfuJoining`: clearing a mutex a running join still owns is how two of
   * them end up interleaved.
   */
  private resetSfuReconnect(): void {
    if (this.sfuReconnectTimer) {
      clearTimeout(this.sfuReconnectTimer);
      this.sfuReconnectTimer = null;
    }
    this.sfuReconnectAttempts = 0;
  }

  /**
   * Route a screen audio track to a dedicated <audio> element for a peer.
   */
  private routeScreenAudioTrack(peerSessionId: string, track: MediaStreamTrack): void {
    this.mediaRouter.routeScreenAudioTrack(peerSessionId, track);
  }

  /**
   * Route a screen video track into a per-share MediaStream so the stage can
   * render it as a separate tile from the camera (#26) and from the peer's
   * other screen share (#253).
   */
  private routeScreenVideoTrack(peerSessionId: string, track: MediaStreamTrack, shareId: string): void {
    this.mediaRouter.routeScreenVideoTrack(peerSessionId, track, shareId, this.peers.get(peerSessionId));
  }

  /**
   * True when the sender carries one of this peer's screen shares, so the
   * camera-transceiver lookups never pick a screen m-line by mistake (#253).
   */
  private isScreenVideoSender(session: PeerSession, sender: RTCRtpSender): boolean {
    for (const screenSender of session.screenVideoSenders.values()) {
      if (screenSender === sender) return true;
    }
    return false;
  }

  /** True when the track is one of the local screen shares (#253). */
  private isLocalScreenTrack(track: MediaStreamTrack): boolean {
    for (const screenTrack of this.localScreenTracks.values()) {
      if (screenTrack === track) return true;
    }
    return false;
  }

  /**
   * Wait for a peer connection's signaling state to become 'stable'.
   * Returns immediately if already stable, otherwise waits up to timeoutMs.
   */
  private waitForStable(pc: RTCPeerConnection, timeoutMs = 5000): Promise<boolean> {
    if (pc.signalingState === 'stable') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onStateChange = () => {
        if (pc.signalingState === 'stable') {
          pc.removeEventListener('signalingstatechange', onStateChange);
          clearTimeout(timer);
          resolve(true);
        }
      };
      const timer = setTimeout(() => {
        pc.removeEventListener('signalingstatechange', onStateChange);
        resolve(pc.signalingState === 'stable');
      }, timeoutMs);
      pc.addEventListener('signalingstatechange', onStateChange);
    });
  }

  /**
   * True if any local sender track sits on a transceiver that has never been
   * negotiated (mid === null). This happens when an offer that would have
   * negotiated the track was discarded by an offer-collision rollback — leaving
   * e.g. the screen-audio track added locally but never sent over the wire.
   */
  private hasUnnegotiatedSenders(pc: RTCPeerConnection): boolean {
    return pc.getTransceivers().some((t) => !!t.sender.track && t.mid === null);
  }

  /**
   * Re-send an offer when the connection is stable but still has a local track
   * that was never negotiated (see hasUnnegotiatedSenders). This recovers the
   * screen-audio track after a glare/rollback during screen sharing, where the
   * video and audio renegotiations collide and the audio offer is dropped.
   */
  private async renegotiateIfNeeded(session: PeerSession): Promise<void> {
    const pc = session.pc;
    if (pc.signalingState === 'stable' && !session.makingOffer && this.hasUnnegotiatedSenders(pc)) {
      console.log(`[WebRTC] Re-negotiating dropped track(s) for ${session.peerSessionId}`);
      await this.sendOffer(session);
    }
  }

  private clearPeerTimers(session: PeerSession): void {
    if (session.watchdogTimer) {
      clearTimeout(session.watchdogTimer);
      session.watchdogTimer = undefined;
    }
    if (session.disconnectGraceTimer) {
      clearTimeout(session.disconnectGraceTimer);
      session.disconnectGraceTimer = undefined;
    }
  }

  private startConnectionWatchdog(session: PeerSession, timeoutMs = 12000): void {
    if (session.watchdogTimer) {
      clearTimeout(session.watchdogTimer);
    }
    session.watchdogTimer = setTimeout(() => {
      session.watchdogTimer = undefined;
      const state = session.pc.connectionState;
      const iceState = session.pc.iceConnectionState;
      if (state !== 'connected' && state !== 'closed') {
        clientLog.warn('WEBRTC', `Watchdog timeout (${timeoutMs}ms) for peer ${session.peerSessionId}`, { state, iceState });
        console.warn(
          `[WebRTC] Watchdog timeout (${timeoutMs}ms) for peer ${session.peerSessionId} (state=${state}, iceState=${iceState}). Triggering recovery.`
        );
        this.recoverPeerConnection(session, 'watchdog_timeout');
      }
    }, timeoutMs);
  }

  private async triggerIceRestart(session: PeerSession, reason: string): Promise<void> {
    if (session.isRecovering || session.pc.connectionState === 'closed') {
      return;
    }

    session.isRecovering = true;
    session.iceRestartAttempts++;
    clientLog.warn('WEBRTC', `ICE restart #${session.iceRestartAttempts} for peer ${session.peerSessionId}`, { reason });
    console.log(
      `[WebRTC] Attempting ICE restart #${session.iceRestartAttempts} for peer ${session.peerSessionId} (reason: ${reason})`
    );

    try {
      const isStable = await this.waitForStable(session.pc, 3000);
      if (!isStable && session.pc.signalingState !== 'stable') {
        throw new Error(`PeerConnection not stable (current: ${session.pc.signalingState})`);
      }
      if (typeof session.pc.restartIce === 'function') {
        session.pc.restartIce();
      }
      await this.sendOffer(session, true);
      this.startConnectionWatchdog(session, 10000);
    } catch (err) {
      clientLog.error('WEBRTC', `ICE restart failed for ${session.peerSessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.warn(`[WebRTC] ICE restart failed for ${session.peerSessionId}:`, err);
      await this.hardReconnectPeer(session.peerSessionId);
    } finally {
      session.isRecovering = false;
    }
  }

  private async hardReconnectPeer(peerSessionId: string): Promise<void> {
    const existing = this.peers.get(peerSessionId);
    const attempts = (existing?.reconnectAttempts || 0) + 1;

    if (attempts > 3) {
      clientLog.error('WEBRTC', `Max hard reconnect attempts (3) reached for peer ${peerSessionId} — giving up`);
      console.warn(`[WebRTC] Max hard reconnect attempts reached for peer ${peerSessionId}. Aborting recovery.`);
      this.markPeerFailed(peerSessionId, existing);
      return;
    }

    clientLog.warn('WEBRTC', `Hard reconnect #${attempts} for peer ${peerSessionId}`);
    console.log(`[WebRTC] Performing Hard Reconnect #${attempts} for peer ${peerSessionId}...`);

    if (existing) {
      this.clearPeerTimers(existing);
      this.stopRelayMonitor(peerSessionId);
      this.vadMonitor.cleanupRemoteVad(peerSessionId);
      try {
        existing.pc.close();
      } catch (e) {}
      this.peers.delete(peerSessionId);
    }

    // Exponential backoff delay (1s, 2s, 4s)
    const backoffMs = Math.min(4000, 1000 * Math.pow(2, attempts - 1));
    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    if (!voiceStore.currentVoiceChannelId) return;
    const isPeerStillInVoice =
      this.voiceParticipants.get(peerSessionId)?.voiceState?.channelId === voiceStore.currentVoiceChannelId;
    if (!isPeerStillInVoice) return;

    const isInitiator = this.currentSessionId.localeCompare(peerSessionId) < 0;
    await this.connectToPeer(peerSessionId, isInitiator);

    const newSession = this.peers.get(peerSessionId);
    if (newSession) {
      newSession.reconnectAttempts = attempts;
    }
  }

  /**
   * Collects ICE candidate-pair stats from a (possibly failed) peer connection
   * and sends an RTC_DIAGNOSTICS_REPORT to the server so the admin can
   * diagnose NAT/connectivity problems from the server log.
   */
  private async sendDiagnosticsReport(peerSessionId: string, session: PeerSession | undefined): Promise<void> {
    await this.diagnosticsCollector.sendDiagnosticsReport(peerSessionId, session, this.signalClient);
  }

  private recoverPeerConnection(session: PeerSession, reason: string): void {
    clientLog.warn('WEBRTC', `Recovery triggered for peer ${session.peerSessionId}`, {
      reason,
      iceRestartAttempts: session.iceRestartAttempts,
      connectionState: session.pc.connectionState,
      iceState: session.pc.iceConnectionState,
    });
    // Any degradation reopens the window that decides whether to warn the user,
    // so a peer that drops long after connecting is reported too (#426).
    this.beginPeerFailureCountdown(session.peerSessionId);
    if (session.iceRestartAttempts < 2) {
      this.triggerIceRestart(session, reason);
    } else {
      this.hardReconnectPeer(session.peerSessionId);
    }
  }

  /**
   * Starts counting down to the "no direct connection" warning for a peer.
   *
   * Idempotent: an already running countdown is left alone so the elapsed time
   * survives every ICE restart and hard reconnect in between.
   */
  private beginPeerFailureCountdown(peerSessionId: string): void {
    if (this.peerFailureTimers.has(peerSessionId) || this.failedPeers.has(peerSessionId)) return;

    // Both entry points for this countdown (first attempt and recovery) are
    // exactly the moments when media is not flowing yet, which is what the
    // "connecting" indicator reports (#433).
    this.voiceParticipants.setPeerConnecting(peerSessionId, true);

    const timer = setTimeout(() => {
      this.peerFailureTimers.delete(peerSessionId);
      const session = this.peers.get(peerSessionId);
      if (session?.pc.connectionState === 'connected') return;
      this.markPeerFailed(peerSessionId, session);
    }, WebRtcManager.PEER_FAILURE_THRESHOLD_MS);

    this.peerFailureTimers.set(peerSessionId, timer);
  }

  private clearPeerFailureCountdown(peerSessionId: string): void {
    const timer = this.peerFailureTimers.get(peerSessionId);
    if (timer) {
      clearTimeout(timer);
      this.peerFailureTimers.delete(peerSessionId);
    }
  }

  /**
   * Flags a peer as unreachable and reports the ICE candidates to the server.
   *
   * The participant state is written here, at the source, instead of relying on
   * a view listening to the event: the failure often happens while the user is
   * somewhere other than the voice stage, and a warning nobody was mounted to
   * receive was silently lost (#426).
   */
  private markPeerFailed(peerSessionId: string, session: PeerSession | undefined): void {
    if (this.failedPeers.has(peerSessionId)) return;
    clientLog.error('WEBRTC', `Peer ${peerSessionId} marked as unreachable`, {
      connectionState: session?.pc.connectionState,
      iceState: session?.pc.iceConnectionState,
      iceRestartAttempts: session?.iceRestartAttempts,
      reconnectAttempts: session?.reconnectAttempts,
    });
    this.failedPeers.add(peerSessionId);
    this.clearPeerFailureCountdown(peerSessionId);
    this.voiceParticipants.setPeerConnecting(peerSessionId, false);
    this.voiceParticipants.setPeerConnectionFailed(peerSessionId, true);
    void this.sendDiagnosticsReport(peerSessionId, session);
    appEvents.emit('remote.peer_failed', { sessionId: peerSessionId });
  }

  /**
   * Reports a peer the moment ICE gives up, but only if it never connected.
   *
   * `failed` is ICE's own verdict that every candidate pair was exhausted, so
   * for a link that never worked there is nothing left to wait for — warning
   * right away beats sitting on the timer. A link that had been up keeps the
   * grace period so a brief network blip does not flash the warning (#426).
   */
  private reportIfNeverConnected(peerSessionId: string, session: PeerSession): void {
    if (this.everConnectedPeers.has(peerSessionId)) return;
    this.markPeerFailed(peerSessionId, session);
  }

  /** Clears the warning once the peer is reachable again (#426). */
  private markPeerReachable(peerSessionId: string): void {
    this.clearPeerFailureCountdown(peerSessionId);
    if (!this.failedPeers.delete(peerSessionId)) return;
    this.voiceParticipants.setPeerConnectionFailed(peerSessionId, false);
    appEvents.emit('remote.peer_recovered', { sessionId: peerSessionId });
  }

  /**
   * Wipes everything this manager knows about a peer link (#466).
   *
   * The indicators describe a link, not a person, so they have to go the moment
   * the link does. Leaving them behind is what kept the relay badge on somebody
   * after the call ended, and showed "no direct connection" next to a person
   * sitting in a different voice channel — where there is no link at all.
   */
  private forgetPeerFailureState(peerSessionId: string): void {
    this.clearPeerFailureCountdown(peerSessionId);
    this.stopRelayMonitor(peerSessionId);
    this.voiceParticipants.setPeerConnecting(peerSessionId, false);
    this.voiceParticipants.setPeerConnectionFailed(peerSessionId, false);
    this.voiceParticipants.setPeerRelayed(peerSessionId, false);
    this.failedPeers.delete(peerSessionId);
    this.everConnectedPeers.delete(peerSessionId);
  }

  /**
   * Checks whether the established link is going through a TURN relay (#425).
   *
   * ICE picks the relay on its own, and only when no direct path exists, so
   * this is read from the candidate pair actually carrying media rather than
   * assumed from whether a TURN server was offered. Either endpoint being of
   * type `relay` means the media is being forwarded by the server.
   *
   * Sampled repeatedly rather than once, because the first pair to succeed is
   * frequently not the final one: relay pairs have the lowest priority but the
   * shortest round trip, so ICE regularly connects through the relay and then
   * promotes the direct pair a moment later. Reading it once at `connected`
   * froze that first instant and left calls that had gone direct permanently
   * labelled as relayed (#466).
   */
  private async sampleRelayUsage(peerSessionId: string, session: PeerSession): Promise<void> {
    try {
      const stats = await session.pc.getStats();
      const pair = WebRtcManager.selectedCandidatePair(stats);
      if (!pair) return;

      const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
      const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined;
      if (!local && !remote) return;

      const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      if (session.isRelayed === relayed) return;
      session.isRelayed = relayed;
      this.voiceParticipants.setPeerRelayed(peerSessionId, relayed);

      clientLog.info(
        'WEBRTC',
        relayed
          ? `Peer ${peerSessionId} is going through the TURN relay`
          : `Peer ${peerSessionId} is connected directly (P2P)`,
        { localType: local?.candidateType, remoteType: remote?.candidateType }
      );
      console.log(
        `[WebRTC] Peer ${peerSessionId} route: ${relayed ? 'TURN relay' : 'direct'} (${local?.candidateType} / ${remote?.candidateType})`
      );
    } catch (error) {
      clientLog.warn('WEBRTC', `Failed to detect relay usage for peer ${peerSessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn('[WebRTC] Failed to determine whether the peer is relayed:', error);
    }
  }

  /**
   * The candidate pair currently carrying media, or undefined while ICE has not
   * settled on one.
   *
   * `transport.selectedCandidatePairId` is the authoritative answer. The
   * `nominated` fallback exists for engines that omit it, but it is a weaker
   * signal: nomination shows up in the stats at different moments on each side
   * of a call, which is how the very same link ended up flagged as relayed on
   * one machine and as direct on the other (#466).
   */
  private static selectedCandidatePair(stats: RTCStatsReport): any | undefined {
    for (const report of stats.values()) {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        const pair = stats.get(report.selectedCandidatePairId);
        if (pair) return pair;
      }
    }
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) {
        return report;
      }
    }
    return undefined;
  }

  /** Keeps the relay indicator following the route ICE is actually using (#466). */
  private startRelayMonitor(peerSessionId: string, session: PeerSession): void {
    // A recovery throws the RTCPeerConnection away and builds a new one under
    // the same key, so this always rebinds to the session that just connected
    // rather than leaving the indicator tied to a connection that is gone.
    this.stopRelayMonitor(peerSessionId);
    void this.sampleRelayUsage(peerSessionId, session);

    const timer = setInterval(() => {
      if (this.peers.get(peerSessionId) !== session || session.pc.connectionState === 'closed') {
        clearInterval(timer);
        if (this.relayMonitors.get(peerSessionId) === timer) {
          this.relayMonitors.delete(peerSessionId);
        }
        return;
      }
      void this.sampleRelayUsage(peerSessionId, session);
    }, WebRtcManager.RELAY_SAMPLE_INTERVAL_MS);

    this.relayMonitors.set(peerSessionId, timer);
  }

  private stopRelayMonitor(peerSessionId: string): void {
    const timer = this.relayMonitors.get(peerSessionId);
    if (timer) {
      clearInterval(timer);
      this.relayMonitors.delete(peerSessionId);
    }
  }

  /**
   * Whether this peer is in the very call we are in right now (#466).
   *
   * The server relays RTC signals by session id alone, without checking voice
   * channels, so this is the only place that can tell an offer belonging to our
   * call apart from one left over from a call that has already moved on.
   * Requiring a known voice state on our own channel is safe because the join
   * broadcast always reaches us before any signal from that peer: both travel
   * the same socket, and the server queues the broadcast while handling the
   * join, before the peer could even send its first offer.
   */
  private isPeerInOurCall(peerSessionId: string): boolean {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId) return false;
    return this.voiceParticipants.get(peerSessionId)?.voiceState?.channelId === channelId;
  }

  /**
   * Another device of our own in the same call. We still link up with it so
   * camera and screen share work, and its screen audio is played like anyone
   * else's (#467) — only the microphone is dropped, since playing it would
   * feed the speakers of one device into the microphone of the other (#309).
   */
  private isOwnOtherDevice(peerSessionId: string): boolean {
    const myUserId = this.voiceServerStore.currentUser?.id;
    if (!myUserId || peerSessionId === this.currentSessionId) return false;
    return this.voiceParticipants.get(peerSessionId)?.user.id === myUserId;
  }

  public async connectToPeer(peerSessionId: string, isInitiator: boolean): Promise<void> {
    if (this.isSfuMode()) {
      if (!this.sfuEngine.isReady()) {
        await this.initSfuForCurrentChannel();
      }
      return;
    }
    clientLog.info('WEBRTC', `Connecting to peer ${peerSessionId} (initiator: ${isInitiator})`, {
      iceServersCount: this.rtcConfig.iceServers?.length ?? 0,
    });
    const existingSession = this.peers.get(peerSessionId);
    if (existingSession) {
      if (existingSession.pc.connectionState !== 'closed' && existingSession.pc.connectionState !== 'failed') {
        return;
      }
      this.clearPeerTimers(existingSession);
      this.stopRelayMonitor(peerSessionId);
      try {
        existingSession.pc.close();
      } catch (e) {}
      this.peers.delete(peerSessionId);
    }

    // The clock towards the "no direct connection" warning starts on the first
    // attempt and keeps running across every retry for this peer (#426).
    this.beginPeerFailureCountdown(peerSessionId);

    const pc = new RTCPeerConnection(this.rtcConfig);
    const remoteStream = new MediaStream();
    const isPolite = this.currentSessionId.localeCompare(peerSessionId) < 0;

    const session: PeerSession = {
      peerSessionId,
      pc,
      remoteStream,
      remoteScreenStreams: new Map(),
      isPolite,
      makingOffer: false,
      candidateQueue: [],
      screenVideoSenders: new Map(),
      iceRestartAttempts: 0,
      reconnectAttempts: 0,
      isRecovering: false,
    };
    this.peers.set(peerSessionId, session);

    // Setup Audio Transceiver
    if (this.localAudioTrack) {
      session.audioSender = pc.addTrack(this.localAudioTrack, new MediaStream([this.localAudioTrack]));
    } else {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
    }

    // Setup Video Transceiver (Camera on the primary video m-line). Screen
    // share now rides its own second sender (see below) so camera + screen can
    // be sent simultaneously as two independent tiles (#26).
    if (this.localCameraTrack) {
      session.videoSender = pc.addTrack(this.localCameraTrack, new MediaStream([this.localCameraTrack]));
    } else {
      pc.addTransceiver('video', { direction: 'sendrecv' });
    }

    // Setup Screen Video Tracks as dedicated extra senders (if currently
    // sharing). Announce each stream ID first so the receiver can tell them
    // apart from the camera track and from each other (mirrors the
    // screen-audio-meta mechanism) — #26, #253.
    for (const [shareId, screenTrack] of this.localScreenTracks) {
      const stream = this.localScreenStreams.get(shareId);
      if (!stream) continue;
      this.signalClient.send(MessageType.RTC_SIGNAL, {
        targetSessionId: peerSessionId,
        fromSessionId: this.currentSessionId,
        signalType: 'screen-video-meta',
        streamId: shareId,
      });
      session.screenVideoSenders.set(shareId, pc.addTrack(screenTrack, stream));
    }

    // Setup Screen Audio Track (if currently sharing)
    if (this.localScreenAudioTrack && this.screenAudioStream) {
      // Announce stream ID before adding track
      this.signalClient.send(MessageType.RTC_SIGNAL, {
        targetSessionId: peerSessionId,
        fromSessionId: this.currentSessionId,
        signalType: 'screen-audio-meta',
        streamId: this.screenAudioStreamId,
      });
      session.screenAudioSender = pc.addTrack(this.localScreenAudioTrack, this.screenAudioStream);
    }

    applyVideoCodecPreferences(pc);

    // ICE Candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        clientLog.info('WEBRTC', `ICE candidate generated for ${peerSessionId}`, {
          type: event.candidate.type,
          protocol: event.candidate.protocol,
          address: event.candidate.address ? '***' : null,
        });
        this.signalClient.send(MessageType.RTC_SIGNAL, {
          targetSessionId: peerSessionId,
          fromSessionId: this.currentSessionId,
          signalType: 'candidate',
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      }
    };

    // Remote Track handler (Audio & Video)
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track (${event.track.kind}) from ${peerSessionId}`);

      // Check if this is a screen audio track — either by known stream ID
      // or by detecting it as a 2nd audio track (the first is the mic).
      const incomingStreamId = event.streams?.[0]?.id;
      const isKnownScreenAudio = event.track.kind === 'audio' && incomingStreamId && this.screenAudioStreamIds.has(incomingStreamId);
      const existingMicAudio = remoteStream.getAudioTracks().length > 0 || session.micTrackSeen === true;
      const isExtraAudioTrack = event.track.kind === 'audio' && existingMicAudio && incomingStreamId && !remoteStream.getTrackById(event.track.id);

      if (isKnownScreenAudio || isExtraAudioTrack) {
        console.log(`[WebRTC] Routing screen audio track from ${peerSessionId} (known=${isKnownScreenAudio}, extra=${isExtraAudioTrack}, streamId=${incomingStreamId})`);
        // If meta hasn't arrived yet, store for potential reclassification
        if (!isKnownScreenAudio && incomingStreamId) {
          this.pendingScreenAudioTracks.set(incomingStreamId, { track: event.track, peerSessionId });
        }
        this.routeScreenAudioTrack(peerSessionId, event.track);
        return;
      }

      // What is left of the audio is the microphone. Coming from our own other
      // device it has to be dropped, or the speakers of one device feed the
      // microphone of the other (#309) — but only the microphone: the screen
      // audio classified above is a broadcast like anyone else's and is worth
      // hearing from the machine sharing it (#467).
      if (event.track.kind === 'audio') {
        session.micTrackSeen = true;
        if (this.isOwnOtherDevice(peerSessionId)) {
          console.log(`[WebRTC] Dropping microphone from our own other device (${peerSessionId})`);
          return;
        }
      }

      // Check if this is a screen VIDEO track — either by known stream ID or by
      // detecting it as a 2nd video track (the first is the camera). Screen
      // video is announced via screen-video-meta before the track arrives, so
      // isKnownScreenVideo is reliable even when the peer has no camera (#26).
      const isKnownScreenVideo =
        event.track.kind === 'video' && !!incomingStreamId && this.screenVideoStreamIds.has(incomingStreamId);
      const existingCameraVideo = remoteStream.getVideoTracks().length > 0;
      const isExtraVideoTrack =
        event.track.kind === 'video' && existingCameraVideo && !!incomingStreamId && !remoteStream.getTrackById(event.track.id);

      if (isKnownScreenVideo || isExtraVideoTrack) {
        console.log(`[WebRTC] Routing screen video track from ${peerSessionId} (known=${isKnownScreenVideo}, extra=${isExtraVideoTrack}, streamId=${incomingStreamId})`);
        if (!isKnownScreenVideo && incomingStreamId) {
          this.pendingScreenVideoTracks.set(incomingStreamId, { track: event.track, peerSessionId });
        }
        this.routeScreenVideoTrack(peerSessionId, event.track, incomingStreamId!);
        return;
      }

      // If new video track, remove any old ended video tracks
      if (event.track.kind === 'video') {
        remoteStream.getVideoTracks().forEach((old) => {
          if (old.id !== event.track.id) {
            remoteStream.removeTrack(old);
          }
        });
      }

      remoteStream.addTrack(event.track);
      this.voiceParticipants.setRemoteStream(peerSessionId, remoteStream);

      if (event.track.kind === 'audio') {
        this.mediaRouter.ensureVoiceAudioElement(peerSessionId, remoteStream);
        this.vadMonitor.setupRemoteVad(peerSessionId, () => this.peers.get(peerSessionId));
      }

      if (event.track.kind === 'video') {
        const videoEl = document.getElementById(`video-${peerSessionId}-camera`) as HTMLVideoElement;
        if (videoEl) {
          // Audio is routed exclusively through the dedicated <audio> element so
          // it can honour per-user volume, deafen and speaker selection. Keep
          // stage video elements muted to avoid a duplicate, un-deafenable
          // audio path when a peer shares camera/screen.
          videoEl.muted = true;
          videoEl.srcObject = remoteStream;
          videoEl.play().catch((e) => console.warn('[WebRTC] Video play error:', e));
        }
        const miniVideoEl = document.getElementById(`video-mini-${peerSessionId}-camera`) as HTMLVideoElement;
        if (miniVideoEl) {
          miniVideoEl.muted = true;
          miniVideoEl.srcObject = remoteStream;
          miniVideoEl.play().catch(() => {});
        }
      }

      event.track.onended = () => {
        remoteStream.removeTrack(event.track);
        this.voiceParticipants.setRemoteStream(peerSessionId, remoteStream);
      };

      event.track.onunmute = () => {
        this.voiceParticipants.setRemoteStream(peerSessionId, remoteStream);
        if (event.track.kind === 'audio') {
          this.mediaRouter.ensureVoiceAudioElement(peerSessionId, remoteStream);
        } else if (event.track.kind === 'video') {
          const videoEl = document.getElementById(`video-${peerSessionId}-camera`) as HTMLVideoElement;
          if (videoEl) {
            videoEl.muted = true;
            videoEl.srcObject = remoteStream;
            videoEl.play().catch(() => {});
          }
          const miniVideoEl = document.getElementById(`video-mini-${peerSessionId}-camera`) as HTMLVideoElement;
          if (miniVideoEl) {
            miniVideoEl.muted = true;
            miniVideoEl.srcObject = remoteStream;
            miniVideoEl.play().catch(() => {});
          }
        }
      };
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      clientLog.info('WEBRTC', `Peer ${peerSessionId} ICE state: ${iceState}`);
      console.log(`[WebRTC] Peer ${peerSessionId} ICE state: ${iceState}`);

      if (iceState === 'connected' || iceState === 'completed') {
        this.clearPeerTimers(session);
        session.iceRestartAttempts = 0;
        session.reconnectAttempts = 0;
      } else if (iceState === 'disconnected') {
        if (!session.disconnectGraceTimer) {
          session.disconnectGraceTimer = setTimeout(() => {
            session.disconnectGraceTimer = undefined;
            if (pc.iceConnectionState === 'disconnected') {
              console.warn(`[WebRTC] Peer ${peerSessionId} ICE remained disconnected for 4s. Recovering.`);
              this.recoverPeerConnection(session, 'ice_disconnected');
            }
          }, 4000);
        }
      } else if (iceState === 'failed') {
        this.clearPeerTimers(session);
        console.warn(`[WebRTC] Peer ${peerSessionId} ICE state failed. Recovering immediately.`);
        clientLog.error('WEBRTC', `ICE state failed for peer ${peerSessionId}`);
        this.reportIfNeverConnected(peerSessionId, session);
        this.recoverPeerConnection(session, 'ice_failed');
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      clientLog.info('WEBRTC', `Peer ${peerSessionId} connection state: ${state}`);
      console.log(`[WebRTC] Peer ${peerSessionId} state: ${state}`);

      if (state === 'connected') {
        this.clearPeerTimers(session);
        this.voiceParticipants.setPeerConnecting(peerSessionId, false);
        session.iceRestartAttempts = 0;
        session.reconnectAttempts = 0;
        this.applyBitrateConstraints();
        this.voiceParticipants.setRemoteStream(peerSessionId, remoteStream);
        this.everConnectedPeers.add(peerSessionId);
        this.markPeerReachable(peerSessionId);
        this.startRelayMonitor(peerSessionId, session);
      } else if (state === 'failed') {
        this.clearPeerTimers(session);
        appEvents.emit('remote.peer_degraded', { sessionId: peerSessionId });
        this.reportIfNeverConnected(peerSessionId, session);
        this.recoverPeerConnection(session, 'connection_failed');
      } else if (state === 'disconnected') {
        appEvents.emit('remote.peer_degraded', { sessionId: peerSessionId });
        if (!session.disconnectGraceTimer) {
          session.disconnectGraceTimer = setTimeout(() => {
            session.disconnectGraceTimer = undefined;
            if (pc.connectionState === 'disconnected') {
              console.warn(`[WebRTC] Peer ${peerSessionId} connection remained disconnected for 4s. Recovering.`);
              this.recoverPeerConnection(session, 'connection_disconnected');
            }
          }, 4000);
        }
      }
    };

    // Watchdog to ensure connection establishes within a reasonable time
    this.startConnectionWatchdog(session);

    // Initial offer if initiator
    if (isInitiator) {
      await this.sendOffer(session);
    }
  }

  private async sendOffer(session: PeerSession, iceRestart = false): Promise<void> {
    if (session.pc.connectionState === 'closed') return;
    try {
      session.makingOffer = true;
      applyVideoCodecPreferences(session.pc);
      const offer = await session.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        iceRestart,
      });
      await session.pc.setLocalDescription(offer);

      // #566 diagnostics: record which video codec the offer actually
      // prioritised. H.264 explicitly chosen but negotiating AV1 after a
      // SFU -> P2P switch shows up here as "av1" leading the order.
      const offerVideoCodecOrder = getSdpVideoCodecOrder(session.pc.localDescription?.sdp ?? '');
      if (offerVideoCodecOrder.length > 0) {
        clientLog.info('WEBRTC', 'P2P offer video codec order', {
          peer: session.peerSessionId,
          preferred: settingsStore.preferredVideoCodec,
          qualityPreset: settingsStore.qualityPreset,
          codecOrder: offerVideoCodecOrder,
        });
      }

      this.signalClient.send(MessageType.RTC_SIGNAL, {
        targetSessionId: session.peerSessionId,
        fromSessionId: this.currentSessionId,
        signalType: 'offer',
        sdp: session.pc.localDescription?.toJSON ? session.pc.localDescription.toJSON() : session.pc.localDescription,
      });
    } catch (err) {
      clientLog.error('WEBRTC', `Error sending offer to ${session.peerSessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[WebRTC] Error sending offer to ${session.peerSessionId}:`, err);
    } finally {
      session.makingOffer = false;
    }
  }

  private async handleIncomingSignal(payload: WebRtcSignalPayload): Promise<void> {
    const { fromSessionId, signalType, sdp, candidate, streamId } = payload;

    // Handle screen-audio-meta: register the stream ID so ontrack can route it
    if (signalType === 'screen-audio-meta') {
      if (streamId) {
        this.screenAudioStreamIds.add(streamId);
        // If ontrack already fired before this meta arrived, reclassify the pending track
        const pending = this.pendingScreenAudioTracks.get(streamId);
        if (pending) {
          console.log(`[WebRTC] Reclassifying pending track as screen audio for ${pending.peerSessionId}`);
          this.pendingScreenAudioTracks.delete(streamId);
          // Already routed by ontrack — no further action needed
        }
      }
      return;
    }

    // Handle screen-video-meta: register the stream ID so ontrack can route it
    // to the dedicated screen tile instead of the camera tile (#26).
    if (signalType === 'screen-video-meta') {
      if (streamId) {
        this.screenVideoStreamIds.add(streamId);
        const pending = this.pendingScreenVideoTracks.get(streamId);
        if (pending) {
          console.log(`[WebRTC] Reclassifying pending track as screen video for ${pending.peerSessionId}`);
          this.pendingScreenVideoTracks.delete(streamId);
          this.routeScreenVideoTrack(pending.peerSessionId, pending.track, streamId);
        }
      }
      return;
    }

    let session = this.peers.get(fromSessionId);
    if (!session && signalType === 'offer') {
      // An offer is the one signal that builds a link out of nothing, so it is
      // also the one that has to be checked against the call we are actually
      // in. Signalling is asynchronous: an offer sent just before somebody left
      // the channel — or before we left it — still lands here afterwards, and
      // answering it opened a peer connection nobody was on the other end of.
      // That connection then sat there until the 20s countdown expired and
      // pinned "no direct connection" on a person sitting in a different voice
      // channel, where there is no link to fail in the first place (#466).
      if (!this.isPeerInOurCall(fromSessionId)) {
        clientLog.info('WEBRTC', `Ignoring offer from ${fromSessionId}: not in our voice channel`);
        console.log(`[WebRTC] Ignoring stale offer from ${fromSessionId} — not in our call.`);
        return;
      }
      await this.connectToPeer(fromSessionId, false);
      session = this.peers.get(fromSessionId);
    }

    if (!session) return;

    try {
      if (signalType === 'offer' && sdp) {
        const offerCollision =
          session.makingOffer || session.pc.signalingState !== 'stable';

        if (offerCollision) {
          if (!session.isPolite) {
            console.log(`[WebRTC] Impolite peer ignoring offer collision from ${fromSessionId}`);
            return;
          }
          console.log(`[WebRTC] Polite peer rolling back for offer from ${fromSessionId}`);
          await session.pc.setRemoteDescription({ type: 'rollback' } as any);
        }

        await session.pc.setRemoteDescription(new RTCSessionDescription(sdp));

        // Flush any queued candidates
        while (session.candidateQueue.length > 0) {
          const c = session.candidateQueue.shift();
          if (c) {
            await session.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        }

        // 1. Ensure local audio track is attached to audio transceiver
        if (this.localAudioTrack) {
          const transceivers = session.pc.getTransceivers();
          const audioTransceiver = transceivers.find(
            (t) => t.receiver.track.kind === 'audio' || t.sender.track?.kind === 'audio'
          );
          if (audioTransceiver) {
            await audioTransceiver.sender.replaceTrack(this.localAudioTrack);
          } else {
            const senders = session.pc.getSenders();
            let audioSender = senders.find((s) => s.track?.kind === 'audio');
            if (audioSender) {
              await audioSender.replaceTrack(this.localAudioTrack);
            } else {
              session.audioSender = session.pc.addTrack(this.localAudioTrack, new MediaStream([this.localAudioTrack]));
            }
          }
        }

        // 2. Ensure the primary (camera) local video track is attached in the
        //    answer. The camera m-line is always created first, so the first
        //    video transceiver that isn't the screen sender is the camera one.
        //    Screen shares ride their own extra senders and are negotiated
        //    separately (via screen-video-meta + renegotiateIfNeeded).
        const cameraTrack = this.localCameraTrack;
        const transceivers = session.pc.getTransceivers();
        const videoTransceiver = transceivers.find(
          (t) =>
            (t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video') &&
            !this.isScreenVideoSender(session, t.sender)
        );
        if (videoTransceiver) {
          videoTransceiver.direction = cameraTrack ? 'sendrecv' : 'recvonly';
          await videoTransceiver.sender.replaceTrack(cameraTrack);
          session.videoSender = videoTransceiver.sender;
        } else if (cameraTrack) {
          session.videoSender = session.pc.addTrack(cameraTrack, new MediaStream([cameraTrack]));
        }

        applyVideoCodecPreferences(session.pc);

        const answer = await session.pc.createAnswer();
        await session.pc.setLocalDescription(answer);

        this.signalClient.send(MessageType.RTC_SIGNAL, {
          targetSessionId: fromSessionId,
          fromSessionId: this.currentSessionId,
          signalType: 'answer',
          sdp: session.pc.localDescription?.toJSON ? session.pc.localDescription.toJSON() : session.pc.localDescription,
        });

        this.applyBitrateConstraints();
        // After answering a remote offer the connection is stable again; if a
        // local track (e.g. screen audio) was left un-negotiated by a prior
        // offer collision, re-offer it now.
        await this.renegotiateIfNeeded(session);
      } else if (signalType === 'answer' && sdp) {
        if (session.pc.signalingState === 'have-local-offer') {
          await session.pc.setRemoteDescription(new RTCSessionDescription(sdp));

          // Flush queued candidates
          while (session.candidateQueue.length > 0) {
            const c = session.candidateQueue.shift();
            if (c) {
              await session.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
          }

          this.applyBitrateConstraints();
          // Connection is stable after applying the answer; re-offer any track
          // that is still un-negotiated (recovers dropped screen-audio track).
          await this.renegotiateIfNeeded(session);
        }
      } else if (signalType === 'candidate' && candidate) {
        if (session.pc.remoteDescription && session.pc.remoteDescription.type) {
          try {
            await session.pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {}
        } else {
          // Buffer candidate until remoteDescription is set
          session.candidateQueue.push(candidate);
        }
      }
    } catch (err) {
      clientLog.error('WEBRTC', `Signal handling error from ${fromSessionId}`, {
        signalType,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[WebRTC] Signal handling error from ${fromSessionId}:`, err);
    }
  }

  /** Initial recovery and raw fallback; normal switches retain the processed track. */
  public async replaceMicrophoneTrack(track: MediaStreamTrack, signal: AbortSignal): Promise<() => Promise<void>> {
    const previous = this.localAudioTrack;
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const sfuEpoch = this.sfuJoinEpoch;
    const sameSession = () => voiceStore.currentVoiceChannelId === channelId &&
      voiceStore.voiceSessionKey === sessionKey && this.sfuJoinEpoch === sfuEpoch;
    const ensureCurrent = () => {
      if (signal.aborted || !sameSession() || this.localAudioTrack !== previous) {
        throw new DOMException('Microphone replacement was cancelled', 'AbortError');
      }
    };
    let restorePublication: () => Promise<void>;
    ensureCurrent();
    if (this.isSfuMode()) {
      if (!previous) {
        // The user may have joined receive-only after capture failed.
        if (!this.sfuEngine.isReady()) throw new Error('SFU microphone transport is not ready');
        const producer = await this.sfuEngine.produceMic(track);
        restorePublication = async () => {
          if (sameSession()) this.sfuEngine.closeProducer('mic');
          else producer?.close();
        };
        try {
          ensureCurrent();
          if (!producer) throw new Error('Could not publish SFU microphone');
        } catch (error) {
          await restorePublication();
          throw error;
        }
      } else {
        if (!await this.sfuEngine.replaceTrack('mic', track)) throw new Error('Could not replace SFU microphone');
        restorePublication = async () => {
          if (sameSession() && !await this.sfuEngine.replaceTrack('mic', previous)) {
            console.warn('[WebRTC] Could not restore the previous SFU microphone');
          }
        };
        try {
          ensureCurrent();
        } catch (error) {
          await restorePublication();
          throw error;
        }
      }
    } else {
      const replaced: Array<{ sender: RTCRtpSender; previous: MediaStreamTrack | null; pc: RTCPeerConnection }> = [];
      restorePublication = async () => {
        const restored = await Promise.allSettled(replaced.filter(({ pc }) => pc.connectionState !== 'closed')
          .map(({ sender, previous: oldTrack }) => sender.replaceTrack(oldTrack)));
        if (restored.some((result) => result.status === 'rejected')) {
          console.warn('[WebRTC] Some microphone senders could not be restored');
        }
      };
      try {
        for (const session of this.peers.values()) {
          ensureCurrent();
          if (session.pc.connectionState === 'closed') continue;
          const sender = session.audioSender ?? session.pc.getTransceivers().find(
            (transceiver) => transceiver.receiver.track.kind === 'audio' && transceiver.sender !== session.screenAudioSender,
          )?.sender;
          if (!sender) throw new Error('Microphone sender is unavailable');
          const oldTrack = sender.track;
          await sender.replaceTrack(track);
          replaced.push({ sender, previous: oldTrack, pc: session.pc });
        }
        ensureCurrent();
      } catch (error) {
        await restorePublication();
        throw error;
      }
    }
    this.localAudioTrack = track;
    return async () => {
      // Publication and graph commit are separate awaits; cancellation can land between them.
      if (this.localAudioTrack !== track) return;
      await restorePublication();
      if (sameSession() && this.localAudioTrack === track) this.localAudioTrack = previous;
    };
  }

  public async setLocalAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    this.localAudioTrack = track;
    if (this.isSfuMode()) {
      if (!this.sfuEngine.isReady()) {
        await this.initSfuForCurrentChannel();
      } else if (track) {
        await this.sfuEngine.produceMic(track);
      } else {
        this.sfuEngine.closeProducer('mic');
      }
      return;
    }
    for (const session of this.peers.values()) {
      try {
        const transceivers = session.pc.getTransceivers();
        const audioTransceiver = transceivers.find(
          (t) => t.receiver.track.kind === 'audio' || t.sender.track?.kind === 'audio'
        );
        if (audioTransceiver) {
          await audioTransceiver.sender.replaceTrack(track);
        } else {
          const senders = session.pc.getSenders();
          let sender = senders.find((s) => s.track?.kind === 'audio');
          if (sender) {
            await sender.replaceTrack(track);
          } else if (track) {
            session.audioSender = session.pc.addTrack(track, new MediaStream([track]));
          }
        }

        if (session.pc.signalingState === 'stable') {
          await this.sendOffer(session);
        }
      } catch (err) {
        console.warn(`[WebRTC] Error updating audio track for peer ${session.peerSessionId}:`, err);
      }
    }
  }

  public async setLocalCameraTrack(track: MediaStreamTrack | null): Promise<void> {
    this.localCameraTrack = track;
    if (this.isSfuMode()) {
      if (!this.sfuEngine.isReady()) {
        await this.initSfuForCurrentChannel();
      } else if (track) {
        await this.sfuEngine.produceCamera(track);
      } else {
        this.sfuEngine.closeProducer('camera');
      }
      return;
    }
    // Camera rides the primary video sender only; screen share has its own
    // dedicated sender so both can be sent at once (#26).
    await this.updateVideoTrackAcrossPeers(track);
  }

  /**
   * Add a local screen video track as a dedicated extra sender on every peer
   * (mirrors setLocalScreenAudioTrack). Announces the stream ID via
   * screen-video-meta before adding the track so receivers render it as its own
   * tile, separate from the camera (#26) and from the other share (#253).
   */
  public async addLocalScreenTrack(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    // The share id IS the MediaStream id, which is also what gets announced
    // over the wire, so both ends key the share by the same value.
    const shareId = stream.id;
    this.localScreenTracks.set(shareId, track);
    this.localScreenStreams.set(shareId, stream);

    if (this.isSfuMode()) {
      await this.sfuEngine.produceScreenVideo(track, shareId);
      return;
    }

    // Announce stream ID to all peers BEFORE adding the track.
    for (const session of this.peers.values()) {
      this.signalClient.send(MessageType.RTC_SIGNAL, {
        targetSessionId: session.peerSessionId,
        fromSessionId: this.currentSessionId,
        signalType: 'screen-video-meta',
        streamId: shareId,
      });
    }

    // Add track to all peers — wait for stable signaling state before
    // renegotiating, since a camera change may have just triggered an offer.
    for (const session of this.peers.values()) {
      try {
        await this.waitForStable(session.pc);
        const existing = session.screenVideoSenders.get(shareId);
        if (existing) {
          await existing.replaceTrack(track);
        } else {
          session.screenVideoSenders.set(shareId, session.pc.addTrack(track, stream));
        }
        await this.sendOffer(session);
        // Wait for the answer, then verify the track was actually negotiated.
        await this.waitForStable(session.pc);
        await this.renegotiateIfNeeded(session);
      } catch (err) {
        console.warn(`[WebRTC] Error adding screen video track for ${session.peerSessionId}:`, err);
      }
    }
    this.applyBitrateConstraints();
  }

  /**
   * Remove one local screen share from every peer (#253).
   */
  public async removeLocalScreenTrack(shareId: string): Promise<void> {
    this.localScreenTracks.delete(shareId);
    this.localScreenStreams.delete(shareId);

    if (this.isSfuMode()) {
      this.sfuEngine.closeProducer(`screen_video:${shareId}`);
      return;
    }

    for (const session of this.peers.values()) {
      const sender = session.screenVideoSenders.get(shareId);
      if (!sender) continue;
      try {
        await this.waitForStable(session.pc);
        session.pc.removeTrack(sender);
        session.screenVideoSenders.delete(shareId);
        await this.sendOffer(session);
      } catch (err) {
        console.warn(`[WebRTC] Error removing screen video track for ${session.peerSessionId}:`, err);
      }
    }
  }

  /**
   * Tear down every local screen share (leaving the channel, camera swap, …).
   */
  public async removeAllLocalScreenTracks(): Promise<void> {
    for (const shareId of [...this.localScreenTracks.keys()]) {
      await this.removeLocalScreenTrack(shareId);
    }
  }

  /**
   * Drops the local screen bookkeeping without renegotiating, for paths where
   * the call itself is over and the peer connections are being torn down
   * (leaving voice, kicked, socket dropped). Without this the stale tracks
   * would be re-announced and re-added to every peer on the next join (#253).
   * Note this must NOT run on reconnect, where the share is meant to survive.
   */
  public clearLocalScreenTracks(): void {
    this.localScreenTracks.clear();
    this.localScreenStreams.clear();
  }

  /**
   * Set the local screen audio track (from native capture) and add it to all peers.
   * Announces the stream ID via screen-audio-meta signaling before adding the track.
   */
  public async setLocalScreenAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    this.localScreenAudioTrack = track;

    if (this.isSfuMode()) {
      if (track) {
        await this.sfuEngine.produceScreenAudio(track, 'default');
      } else {
        this.sfuEngine.closeProducer('screen_audio:default');
      }
      return;
    }

    if (track) {
      // Wrap in a dedicated MediaStream so receivers can identify it.
      // Store the stream so late-joining peers reuse the same ID.
      const stream = new MediaStream([track]);
      this.screenAudioStream = stream;
      this.screenAudioStreamId = stream.id;

      // Announce stream ID to all peers BEFORE adding the track
      for (const session of this.peers.values()) {
        this.signalClient.send(MessageType.RTC_SIGNAL, {
          targetSessionId: session.peerSessionId,
          fromSessionId: this.currentSessionId,
          signalType: 'screen-audio-meta',
          streamId: this.screenAudioStreamId,
        });
      }

      // Add track to all peers — wait for stable signaling state before
      // renegotiating, since screen video may have just triggered an offer.
      for (const session of this.peers.values()) {
        try {
          await this.waitForStable(session.pc);
          session.screenAudioSender = session.pc.addTrack(track, stream);
          await this.sendOffer(session);
          // Wait for the answer, then verify the track was actually negotiated.
          // If a glare/rollback dropped the offer, re-send it now.
          await this.waitForStable(session.pc);
          await this.renegotiateIfNeeded(session);
        } catch (err) {
          console.warn(`[WebRTC] Error adding screen audio track for ${session.peerSessionId}:`, err);
        }
      }
    } else {
      // Remove screen audio track from all peers
      for (const session of this.peers.values()) {
        if (session.screenAudioSender) {
          try {
            await this.waitForStable(session.pc);
            session.pc.removeTrack(session.screenAudioSender);
            session.screenAudioSender = null;
            await this.sendOffer(session);
          } catch (err) {
            console.warn(`[WebRTC] Error removing screen audio track for ${session.peerSessionId}:`, err);
          }
        }
      }
      this.screenAudioStream = null;
      this.screenAudioStreamId = null;
    }
  }

  private async updateVideoTrackAcrossPeers(track: MediaStreamTrack | null): Promise<void> {
    for (const session of this.peers.values()) {
      try {
        const transceivers = session.pc.getTransceivers();
        // Find the primary (camera) video transceiver, never a screen sender.
        const videoTransceiver = transceivers.find(
          (t) =>
            (t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video') &&
            !this.isScreenVideoSender(session, t.sender)
        );

        if (videoTransceiver) {
          videoTransceiver.direction = track ? 'sendrecv' : 'recvonly';
          await videoTransceiver.sender.replaceTrack(track);
        } else if (track) {
          session.videoSender = session.pc.addTrack(track, new MediaStream([track]));
        }

        if (session.pc.signalingState === 'stable') {
          await this.sendOffer(session);
        }
      } catch (err) {
        console.warn(`[WebRTC] Error updating video track for peer ${session.peerSessionId}:`, err);
      }
    }
  }

  public setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    this.mediaRouter.setDeafened(deafened);
  }

  public setScreenAudioMuted(peerSessionId: string, muted: boolean): void {
    this.mediaRouter.setScreenAudioMuted(peerSessionId, muted);
  }

  public async setSpeakerDeviceId(deviceId: string): Promise<void> {
    await this.mediaRouter.setSpeakerDeviceId(deviceId);
  }

  private async applyBitrateConstraints(): Promise<void> {
    const profile = this.currentPreset === 'CUSTOM' ? settingsStore.customProfile : (QUALITY_PRESETS[this.currentPreset] || QUALITY_PRESETS.NORMAL);
    for (const session of this.peers.values()) {
      for (const sender of session.pc.getSenders()) {
        if (!sender.track) continue;

        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }

          if (sender.track.kind === 'audio') {
            params.encodings[0].maxBitrate = profile.audioBitrateKbps * 1000;
          } else if (sender.track.kind === 'video') {
            const isScreen = this.isLocalScreenTrack(sender.track);
            params.encodings[0].maxBitrate =
              (isScreen ? profile.screenBitrateKbps : profile.cameraBitrateKbps) * 1000;
            params.encodings[0].maxFramerate = isScreen ? profile.screenFps : profile.cameraFps;

            if (this.currentPreset === 'GAMING') {
              // Gaming mode prioritizes fluid motion (drops resolution before framerate)
              params.degradationPreference = 'maintain-framerate';
            } else {
              // Ultra, High, Custom and Normal prioritize resolution fidelity (maintains resolution without downscaling)
              params.degradationPreference = 'maintain-resolution';
            }
          }

          await sender.setParameters(params);
        } catch (err) {}
      }
    }

    if (this.isSfuMode()) {
      // In SFU mode there are no peer connections to iterate — media flows
      // through the mediasoup send transport — so the loop above is a no-op.
      // Push the same caps onto the SFU producers, otherwise screen share loses
      // resolution under motion (#568).
      await this.sfuEngine.applyQualityParams(this.currentPreset, profile);
    }
  }

  public async getPeerPing(peerSessionId: string): Promise<number | null> {
    return this.diagnosticsCollector.getPeerPing(this.peers.get(peerSessionId));
  }

  public async getAverageP2pPing(): Promise<number | null> {
    if (this.isSfuMode()) {
      return this.sfuEngine.getPing();
    }
    return this.diagnosticsCollector.getAverageP2pPing(this.peers);
  }

  public getPeerConnection(peerSessionId: string): RTCPeerConnection | null {
    return this.peers.get(peerSessionId)?.pc || null;
  }

  public getPeerConnections(): RTCPeerConnection[] {
    return Array.from(this.peers.values()).map((session) => session.pc);
  }

  /**
   * Every sender publishing one local screen share — one per peer (#340).
   * Scoping `getStats()` to these senders is what lets the stage report each
   * share separately instead of merging both into the connection's totals.
   */
  public getScreenSendersForShare(shareId: string): RTCRtpSender[] {
    if (this.isSfuMode()) {
      const sender = this.sfuEngine.getScreenSender(shareId);
      return sender ? [sender] : [];
    }
    const senders: RTCRtpSender[] = [];
    for (const session of this.peers.values()) {
      const sender = session.screenVideoSenders.get(shareId);
      if (sender) senders.push(sender);
    }
    return senders;
  }

  /**
   * Every sender publishing the local camera — one per peer. Same reasoning as
   * `getScreenSendersForShare`: scoping `getStats()` to the camera senders
   * keeps the screen shares out of the camera tile's numbers (#493).
   */
  public getCameraSenders(): RTCRtpSender[] {
    if (this.isSfuMode()) {
      const sender = this.sfuEngine.getCameraSender();
      return sender ? [sender] : [];
    }
    const senders: RTCRtpSender[] = [];
    for (const session of this.peers.values()) {
      if (session.videoSender) senders.push(session.videoSender);
    }
    return senders;
  }

  /**
   * Receiver carrying a specific remote track, so the stage can read one
   * screen share's inbound stats without picking up the peer's other share or
   * their camera (#340).
   */
  public getReceiverForTrack(peerSessionId: string, trackId: string): RTCRtpReceiver | null {
    if (this.isSfuMode()) {
      return this.sfuEngine.getReceiverForTrack(trackId);
    }
    const session = this.peers.get(peerSessionId);
    if (!session) return null;
    return session.pc.getReceivers().find((receiver) => receiver.track?.id === trackId) ?? null;
  }

  public setPeerVolume(peerSessionId: string, volume: number): void {
    this.mediaRouter.setPeerVolume(peerSessionId, volume);
  }

  public applyUserVolumes(): void {
    this.mediaRouter.applyUserVolumes();
  }

  public async reapplyCodecPreferences(): Promise<void> {
    for (const session of this.peers.values()) {
      try {
        applyVideoCodecPreferences(session.pc);
        if (session.pc.signalingState === 'stable' && (this.localCameraTrack || this.localScreenTracks.size > 0)) {
          await this.sendOffer(session);
        }
      } catch (err) {
        console.warn(`[WebRTC] Error reapplying codec preferences for ${session.peerSessionId}:`, err);
      }
    }
  }

  public removePeer(peerSessionId: string): void {
    this.vadMonitor.cleanupRemoteVad(peerSessionId);
    this.forgetPeerFailureState(peerSessionId);
    this.clearPeerFailureCountdown(peerSessionId);

    // Stop and clear any pending screen audio tracks for this peer
    for (const [streamId, item] of this.pendingScreenAudioTracks.entries()) {
      if (item.peerSessionId === peerSessionId) {
        try {
          item.track.stop();
        } catch {}
        this.pendingScreenAudioTracks.delete(streamId);
      }
    }

    // Stop and clear any pending screen video tracks for this peer
    for (const [streamId, item] of this.pendingScreenVideoTracks.entries()) {
      if (item.peerSessionId === peerSessionId) {
        try {
          item.track.stop();
        } catch {}
        this.pendingScreenVideoTracks.delete(streamId);
      }
    }

    const session = this.peers.get(peerSessionId);
    this.mediaRouter.cleanupPeerMedia(peerSessionId, session);

    if (session) {
      this.clearPeerTimers(session);
      try {
        session.pc.close();
      } catch {}
      this.peers.delete(peerSessionId);
    }
  }

  public closeAllPeers(): void {
    this.abandonSfuSession();
    this.resetSfuReconnect();
    const peerCount = this.peers.size;
    clientLog.info('WEBRTC', `Closing all peers (${peerCount} active)`);
    for (const [peerSessionId] of Array.from(this.peers.entries())) {
      this.removePeer(peerSessionId);
    }
    this.peers.clear();

    // Cancel all running peer failure timers
    for (const timer of this.peerFailureTimers.values()) {
      clearTimeout(timer);
    }
    this.peerFailureTimers.clear();
    this.failedPeers.clear();
    this.everConnectedPeers.clear();

    for (const timer of this.relayMonitors.values()) {
      clearInterval(timer);
    }
    this.relayMonitors.clear();

    // Stop any remaining pending tracks
    for (const item of this.pendingScreenAudioTracks.values()) {
      try {
        item.track.stop();
      } catch {}
    }
    this.pendingScreenAudioTracks.clear();

    for (const item of this.pendingScreenVideoTracks.values()) {
      try {
        item.track.stop();
      } catch {}
    }
    this.pendingScreenVideoTracks.clear();

    this.screenAudioStreamIds.clear();
    this.screenVideoStreamIds.clear();

    this.mediaRouter.closeAllMedia();
    this.vadMonitor.cleanupAll();
  }
}

export const webRtcManager = new WebRtcManager();
