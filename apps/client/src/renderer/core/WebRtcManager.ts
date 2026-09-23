import {
  IceServerConfig,
  MessageType,
  QUALITY_PRESETS,
  QualityPresetType,
  QualityProfile,
  ScreenWatchSignalPayload,
  screenWatchSignalSchema,
  WebRtcSignalPayload,
  type NativeScreenCapabilities,
  type NativeScreenSource,
  type NativeScreenPreviewState,
  type NativeScreenCaptureKind,
  type NativeScreenCaptureMode,
  type VoiceStateUpdatePayload,
  isReceivingBotVoice,
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
import {
  applyVideoCodecPreferences, assertScreenCodecNegotiated, explicitScreenCodecMime, getScreenVideoCodecs,
  getSdpVideoCodecOrder, ScreenCodecError, type PreferredVideoCodec,
} from './webrtc/codecPreferences';
import { t } from '../i18n';
import { SfuClientEngine, SfuConsumerTrackEvent } from './webrtc/SfuClientEngine';
import { applyMediaEncodingPolicy, getMediaEncodingPolicy } from './webrtc/mediaEncodingPolicy';
import { updateRtpSenderParameters } from './webrtc/rtpSenderParameters';
import {
  NativeScreenController, nativeScreenProfile, type NativeScreenCallContext, type NativeScreenWatchState,
  type ScreenVideoDiagnostics,
} from './webrtc/NativeScreenController';
import { overlayBridgeService } from './OverlayBridgeService';

interface ScreenCodecNegotiation {
  preferred: PreferredVideoCodec;
}

interface LocalScreenShare {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  pending: boolean;
}

export interface PeerSession {
  /** Bots may receive one authorized microphone, never camera or screen media. */
  botPeer?: boolean;
  receiveOnly?: boolean;
  botAudioSync?: Promise<void>;
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
  screenSubscriptionId: string;
  remoteSubscriptionId?: string;
  screenWatchState: Map<string, { watching: boolean; revision: number }>;
  screenNegotiation?: ScreenCodecNegotiation;
  offeredScreenNegotiation?: ScreenCodecNegotiation;
  negotiatedScreenNegotiation?: ScreenCodecNegotiation;
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
  private codecUpdateTask: Promise<void> | null = null;
  private nativeTasks = new WeakMap<PeerSession, Promise<void>>();
  private screenSubscriptionTasks = new WeakMap<PeerSession, Promise<void>>();
  private remoteScreenSubscriptions = new Map<string, Map<string, { id: string; revision: number; published: boolean }>>();
  private mediaRouter: RemoteMediaRouter;
  private vadMonitor: RemoteVadMonitor;
  private diagnosticsCollector: RtcDiagnosticsCollector;
  private sfuEngine: SfuClientEngine;
  private nativeScreens: NativeScreenController;
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
  private cameraTrackRevision = 0;
  private cameraTrackChange: {
    track: MediaStreamTrack | null;
    channelId: string | null;
    sessionKey: string | null;
    task: Promise<void>;
  } | null = null;
  /** Desired publications survive transport rebuilds; VideoService owns capture. */
  private localScreenShares = new Map<string, LocalScreenShare>();
  private localScreenAudioTrack: MediaStreamTrack | null = null;
  private screenAudioStream: MediaStream | null = null;
  private screenAudioStreamId: string | null = null;
  private sfuScreenAudioPublication: {
    track: MediaStreamTrack;
    epoch: number;
    task: ReturnType<SfuClientEngine['produceScreenAudio']>;
  } | null = null;
  private currentPreset: QualityPresetType = settingsStore.qualityPreset;
  private qualityRevision = 0;
  private currentSessionId: string = '';
  private isDeafened: boolean = false;
  private isMigratingVoiceMode: boolean = false;
  private migrationDebounceTimer: any = null;
  private voiceReconnectSuspended = false;

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
    this.vadMonitor = new RemoteVadMonitor(
      () => this.voiceParticipants,
      peerSessionId => this.mediaRouter.getVoiceAudioLevel(peerSessionId),
    );
    this.diagnosticsCollector = new RtcDiagnosticsCollector();
    this.sfuEngine = new SfuClientEngine(
      () => this.signalClient,
      () => this.currentSessionId,
      {
        onHealthChanged: (health) => voiceStore.setConnectionHealth(health),
        onRoster: (channelId, participants) => {
          if (voiceStore.currentVoiceChannelId === channelId) {
            this.voiceParticipants.reconcileVoiceChannel(channelId, participants);
            this.reconcileScreenSources();
          }
        },
        isScreenWatched: (sessionId, shareId) => shareId
          ? voiceStore.isWatchingScreen(sessionId, shareId) : voiceStore.isWatchingAnyScreen(sessionId),
        onConsumerTrack: (event) => this.handleSfuConsumerTrack(event),
        onConsumerClosed: (sessionId, mediaType, shareId, track) => this.handleSfuConsumerClosed(sessionId, mediaType, shareId, track),
        onConnectionFailed: (reason) => this.handleSfuConnectionFailure(reason),
        onConnected: () => this.handleSfuConnected(),
      }
    );
    this.nativeScreens = new NativeScreenController(
      () => this.nativeScreenContext(), stream => overlayBridgeService.retireScreenStream(stream), this.mediaRouter,
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

  private nativeScreenContext(): NativeScreenCallContext | null {
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const session = sessionKey ? sessionManager.get(sessionKey) : sessionManager.getActive();
    if (!channelId || this.voiceReconnectSuspended || (sessionKey && !session)) return null;
    const client = session?.client ?? this.signalClient;
    const participants = session?.participants ?? this.voiceParticipants;
    const store = session?.serverStore ?? this.voiceServerStore;
    const sessionId = store.currentUser?.sessionId ?? this.currentSessionId;
    if (!sessionId || client.getStatus() !== 'CONNECTED') return null;
    const connectionId = client.getConnectionId();
    const mode = this.isSfuMode() ? 'sfu' : 'p2p';
    const isCurrent = () => !this.voiceReconnectSuspended && voiceStore.currentVoiceChannelId === channelId
      && voiceStore.voiceSessionKey === sessionKey && client.getStatus() === 'CONNECTED'
      && client.getConnectionId() === connectionId && this.isSfuMode() === (mode === 'sfu')
      && (!sessionKey || sessionManager.get(sessionKey) === session)
      && (store.currentUser?.sessionId ?? this.currentSessionId) === sessionId;
    return { client, participants, channelId, sessionId, mode, isCurrent,
      announceSources: () => { if (isCurrent()) client.send(MessageType.VOICE_STATE_UPDATE, this.getLocalScreenState()); } };
  }

  public getLocalScreenState(): VoiceStateUpdatePayload {
    const screenShareIds = [...voiceStore.screenShareIds];
    const nativeScreenShares = videoService.getNativeScreenCaptures()
      .map(capture => capture.source).filter(source => screenShareIds.includes(source.shareId));
    return { screenShareIds, nativeScreenShares, isScreenSharing: voiceStore.isScreenSharing,
      isSharingScreenAudio: this.localScreenAudioTrack !== null || nativeScreenShares.some(source => source.audio) };
  }

  public getNativeScreenCapabilities(): Promise<NativeScreenCapabilities> {
    return this.nativeScreens.capabilities();
  }

  public getNativeScreenSource(sessionId: string, shareId: string): NativeScreenSource | null {
    return this.voiceParticipants.get(sessionId)?.voiceState?.nativeScreenShares?.find(source => source.shareId === shareId) ?? null;
  }

  public getNativeScreenWatchState(sessionId: string, shareId: string): NativeScreenWatchState | null {
    return this.nativeScreens.getWatchState(sessionId, shareId);
  }

  public getScreenVideoDiagnostics(sessionId: string, shareId: string): Promise<ScreenVideoDiagnostics | null> {
    return this.nativeScreens.diagnostics(sessionId, shareId);
  }

  public retryNativeScreen(sessionId: string, shareId: string): void {
    void this.nativeScreens.retry(sessionId, shareId).catch(error => this.nativeScreens.report(error));
  }

  public getLocalScreenPreviewState(shareId: string): NativeScreenPreviewState {
    return this.nativeScreens.getLocalPreviewState(shareId);
  }

  public getScreenCaptureMode(sessionId: string, shareId: string): NativeScreenCaptureMode | null {
    return this.nativeScreens.getCaptureMode(sessionId, shareId);
  }

  public async startNativeScreenShare(
    desktopSourceId: string, audio: boolean, thumbnail: string, isWanted: () => boolean,
    captureKind: NativeScreenCaptureKind = 'window',
    preserveAspectRatio = false,
    audioReplacement?: { shareId?: string; retirePrevious: () => Promise<void> },
  ): Promise<MediaStream> {
    if (this.voiceReconnectSuspended) throw new Error(t('screenCodec.reconnecting'));
    if (settingsStore.preferredVideoCodec !== 'auto' && settingsStore.preferredVideoCodec !== 'h264')
      throw new Error(t('screenShare.codecsSoon'));
    const profile = videoService.getProfile();
    const video = nativeScreenProfile(profile);
    const capabilities = await this.nativeScreens.capabilities();
    if (!isWanted()) throw new DOMException('Screen selection was cancelled.', 'AbortError');
    if (!video || (!capabilities.capture && !capabilities.requiresSelectionProbe) || (audio && !capabilities.captureAudio))
      throw new Error(t('screenShare.nativeUnavailable'));
    if (!(capabilities.captureKinds ?? (capabilities.capture ? ['window'] : [])).includes(captureKind))
      throw new Error(t('screenShare.nativeUnavailable'));
    const stream = new MediaStream();
    try {
      const source = await this.nativeScreens.addSource({
        shareId: stream.id, desktopSourceId, captureKind, preserveAspectRatio, video, audio, thumbnail,
        audioBitrateKbps: profile.audioBitrateKbps,
        ...(audioReplacement?.shareId ? { replacesAudioShareId: audioReplacement.shareId } : {}),
      });
      if (!isWanted()) throw new DOMException('Screen selection was cancelled.', 'AbortError');
      videoService.registerNativeScreenShare(stream, {
        source, desktopSourceId, captureKind, preserveAspectRatio, thumbnail, audioBitrateKbps: profile.audioBitrateKbps,
      });
      // Admission/preflight does not acquire PCM. Retire its exact former owner
      // before preview demand can activate the replacement's selected capture.
      if (audioReplacement) {
        await audioReplacement.retirePrevious();
        if (!isWanted()) throw new DOMException('Screen selection was cancelled.', 'AbortError');
      }
      try {
        await this.nativeScreens.attachLocalPreview(stream.id);
        if (!isWanted()) throw new DOMException('Screen selection was cancelled.', 'AbortError');
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        this.nativeScreens.report(error);
      }
      return stream;
    } catch (error) {
      if (videoService.getScreenStream(stream.id) === stream) videoService.stopScreenShare(stream.id);
      try { await this.nativeScreens.removeSource(stream.id); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native source preparation and cleanup failed.'); }
      throw error;
    }
  }

  public setQualityPreset(preset: QualityPresetType): void {
    this.assertScreenSharingSettings(preset === 'CUSTOM' ? settingsStore.customProfile : QUALITY_PRESETS[preset]);
    this.currentPreset = preset;
    videoService.applyQualityPreset(preset).catch((err) => {
      clientLog.warn('WEBRTC', 'Error applying quality preset to videoService', { error: String(err) });
    });
    this.applyBitrateConstraints();
    void this.nativeScreens.applyQuality(this.getQualityProfile()).catch(error => {
      this.nativeScreens.report(error);
      appEvents.emit('native_screen.source_failed', { reason: 'unsupported' });
    });
  }

  public assertScreenSharingSettings(profile: QualityProfile, codec = settingsStore.preferredVideoCodec): void {
    const issue = this.nativeScreens.settingsIssue(profile, codec);
    if (issue) throw new Error(t(issue === 'codec' ? 'screenShare.nativeCodecChangeBlocked' : 'screenShare.nativeProfileChangeBlocked'));
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
      void this.nativeScreens.updateAudio().catch(error => this.nativeScreens.report(error));
    });

    appEvents.on('participants.updated', () => {
      this.mediaRouter.applyUserVolumes();
    });

    appEvents.on('voice.screen_watch_changed', (event: { sessionId: string; shareId: string }) => {
      this.sendScreenWatch(event.sessionId, event.shareId);
      void this.sfuEngine.syncScreenSubscriptions();
      this.applyScreenAudioMute(event.sessionId);
      void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
    });
    appEvents.on('voice.screen_quality_changed', () => {
      void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
    });
    appEvents.on('voice.screen_audio_mute_changed', (event: { sessionId: string }) => {
      this.applyScreenAudioMute(event.sessionId);
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

  public async handleVoiceModeUpdate(): Promise<void> {
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    if (!channelId || this.voiceReconnectSuspended) return;

    const isSfu = this.voiceServerStore.serverDetails?.voiceMode === 'sfu';
    const currentlyRunningSfu = this.sfuEngine.isReady() || this.sfuEngine.isChannelConnected();
    const targetIsSfu = isSfu;
    // SFU -> P2P has a server-authorized leave/rejoin lifecycle, never a hot
    // swap of transports whose old membership has already been evicted.
    if (!targetIsSfu) return;
    const isCurrent = () => voiceStore.currentVoiceChannelId === channelId
      && voiceStore.voiceSessionKey === sessionKey && this.isSfuMode();

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
      if (!isCurrent()) return;

      // 4. Re-initialize in the new target mode
      this.resetSfuReconnect();
      if (targetIsSfu) {
        await this.initSfuForCurrentChannel();
      } else {
        this.connectToAllParticipants();
      }

      // 5. Notify UI of the mode switch
      if (isCurrent()) appEvents.emit('voice.mode_switched', { mode: 'sfu' });
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
    if (this.voiceReconnectSuspended || this.signalClient.getStatus() !== 'CONNECTED' || this.sfuEngine.isReady()) return;
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
    if (!channelId || !this.isSfuMode() || this.voiceReconnectSuspended
      || this.signalClient.getStatus() !== 'CONNECTED') return;
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

      // Seed the common policy before any new sender starts publishing.
      await this.applyBitrateConstraints();
      if (this.isSfuJoinStale(epoch, channelId)) {
        this.sfuEngine.leave();
        return;
      }
      if (this.localAudioTrack) {
        const producer = await this.sfuEngine.produceMic(this.localAudioTrack);
        if (this.isSfuJoinStale(epoch, channelId)) return;
        if (!producer) {
          this.handleSfuConnectionFailure('Could not publish the microphone to the SFU');
          return;
        }
      }
      if (this.localCameraTrack) {
        if (this.isSfuJoinStale(epoch, channelId)) {
          this.sfuEngine.leave();
          return;
        }
        const track = this.localCameraTrack;
        try {
          const producer = await this.sfuEngine.produceCamera(track);
          if (!producer) throw new Error('SFU camera transport is unavailable');
        } catch (error) {
          if (!this.isSfuJoinStale(epoch, channelId) && this.localCameraTrack === track) {
            this.localCameraTrack = null;
            videoService.stopCamera();
            appEvents.emit('camera.publication_failed', error);
          }
        }
      }
      await this.restoreSfuScreenShares(() => !this.isSfuJoinStale(epoch, channelId));
      if (this.isSfuJoinStale(epoch, channelId)) {
        this.sfuEngine.leave();
        return;
      }
      if (this.localScreenAudioTrack) {
        await this.publishSfuScreenAudio(this.localScreenAudioTrack);
      }

      // A user may have changed the profile while publication was awaiting SDP.
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
      this.voiceReconnectSuspended ||
      this.signalClient.getStatus() !== 'CONNECTED' ||
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

  private handleSfuConsumerClosed(producerSessionId: string, mediaType: string, shareId?: string, track?: MediaStreamTrack): void {
    if (mediaType === 'camera') {
      const current = this.voiceParticipants.get(producerSessionId)?.remoteStream;
      if (current) {
        current.getVideoTracks().forEach((t: MediaStreamTrack) => {
          if (track && t !== track) return;
          try { t.stop(); } catch {}
          current.removeTrack(t);
        });
      }
    } else if (mediaType === 'screen_video') {
      this.mediaRouter.cleanupScreenVideo(producerSessionId, shareId || 'default', track);
    } else if (mediaType === 'screen_audio') {
      // Only the screen audio goes: `cleanupPeerMedia` would also tear down the
      // peer's voice <audio> element and its amplification pipeline, which is
      // how ending a screen share used to mute the sharer for everyone else.
      this.mediaRouter.cleanupScreenAudio(producerSessionId, track);
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
    if (!this.isSfuMode() || !voiceStore.currentVoiceChannelId || this.voiceReconnectSuspended
      || this.signalClient.getStatus() !== 'CONNECTED') return;
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
    if (!voiceStore.currentVoiceChannelId || !this.isSfuMode() || this.voiceReconnectSuspended
      || this.signalClient.getStatus() !== 'CONNECTED') return;
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
    if (!voiceStore.currentVoiceChannelId || this.voiceReconnectSuspended
      || this.signalClient.getStatus() !== 'CONNECTED') return;
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
    this.applyScreenAudioMute(peerSessionId);
  }

  private applyScreenAudioMute(peerSessionId: string): void {
    this.mediaRouter.setScreenAudioMuted(peerSessionId,
      !voiceStore.isWatchingAnyScreen(peerSessionId) || voiceStore.isScreenAudioMuted(peerSessionId));
    void this.nativeScreens.updateAudio().catch(error => this.nativeScreens.report(error));
  }

  public setRemoteScreenWatching(peerSessionId: string, shareId: string, watching: boolean): void {
    if (watching && (!this.isPeerInOurCall(peerSessionId) || peerSessionId === this.currentSessionId
      || !this.voiceParticipants.get(peerSessionId)?.voiceState?.screenShareIds?.includes(shareId))) return;
    voiceStore.setScreenWatching(peerSessionId, shareId, watching);
  }

  /** Source discovery is voice metadata, independent of whether RTP is flowing. */
  public reconcileScreenSources(): void {
    for (const [sessionId] of voiceStore.getScreenWatchers()) {
      const state = this.voiceParticipants.get(sessionId)?.voiceState;
      voiceStore.retainScreenShares(sessionId,
        state?.channelId === voiceStore.currentVoiceChannelId ? state?.screenShareIds ?? [] : []);
    }
    for (const [sessionId, shares] of this.remoteScreenSubscriptions) {
      const state = this.voiceParticipants.get(sessionId)?.voiceState;
      for (const [shareId, subscription] of shares) {
        if (state?.channelId === voiceStore.currentVoiceChannelId && state.screenShareIds?.includes(shareId)) {
          subscription.published = true;
        } else if (subscription.published || state?.channelId !== voiceStore.currentVoiceChannelId) {
          shares.delete(shareId);
          this.screenVideoStreamIds.delete(shareId);
          const peer = this.peers.get(sessionId);
          const stream = peer?.remoteScreenStreams.get(shareId);
          peer?.remoteScreenStreams.delete(shareId);
          stream?.getTracks().forEach(track => {
            track.onended = null;
            track.stop();
          });
          this.voiceParticipants.removeRemoteScreenStream(sessionId, shareId);
        }
      }
      if (!shares.size) this.remoteScreenSubscriptions.delete(sessionId);
    }
    void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
  }

  private sendScreenWatch(peerSessionId: string, shareId: string): void {
    if (this.getNativeScreenSource(peerSessionId, shareId)) return;
    if (this.isSfuMode() || this.voiceReconnectSuspended || !this.isPeerInOurCall(peerSessionId)) return;
    const subscription = this.remoteScreenSubscriptions.get(peerSessionId)?.get(shareId);
    const session = this.peers.get(peerSessionId);
    if (!subscription || !session || subscription.id !== session.remoteSubscriptionId) return;
    this.signalClient.send(MessageType.RTC_SIGNAL, {
      fromSessionId: this.currentSessionId, targetSessionId: peerSessionId,
      signalType: 'screen-watch', streamId: shareId, subscriptionId: subscription.id,
      watcherSubscriptionId: session.screenSubscriptionId,
      subscriptionRevision: ++subscription.revision,
      watching: voiceStore.isWatchingScreen(peerSessionId, shareId),
    } satisfies ScreenWatchSignalPayload);
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
    for (const share of this.localScreenShares.values()) {
      if (share.track === track) return true;
    }
    return false;
  }

  /**
   * Wait for a peer connection's signaling state to become 'stable'.
   * Returns immediately if already stable, otherwise waits up to timeoutMs.
   */
  private waitForStable(pc: RTCPeerConnection, timeoutMs = 5000): Promise<boolean> {
    if (pc.signalingState === 'stable') return Promise.resolve(true);
    if (pc.signalingState === 'closed') return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const onStateChange = () => {
        if (pc.signalingState === 'stable' || pc.signalingState === 'closed') {
          pc.removeEventListener('signalingstatechange', onStateChange);
          clearTimeout(timer);
          resolve(pc.signalingState === 'stable');
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

  private botAudioDirection(session: PeerSession): RTCRtpTransceiverDirection {
    const publish = this.voiceParticipants.get(session.peerSessionId)?.voiceState?.botVoicePermissions?.publish !== false;
    return session.receiveOnly ? publish ? 'recvonly' : 'inactive' : publish ? 'sendrecv' : 'sendonly';
  }

  public syncBotVoiceReception(peerSessionId: string): void {
    const session = this.peers.get(peerSessionId);
    if (!session?.botPeer) return;
    session.receiveOnly = !isReceivingBotVoice(this.voiceParticipants.get(peerSessionId)?.voiceState);
    session.botAudioSync = (session.botAudioSync ?? Promise.resolve()).then(async () => {
      if (!this.isCurrentPeer(session)) return;
      const primary = session.pc.getTransceivers().find((entry) => entry.receiver.track.kind === 'audio');
      if (!primary) return;
      session.receiveOnly = !isReceivingBotVoice(this.voiceParticipants.get(peerSessionId)?.voiceState);
      primary.direction = this.botAudioDirection(session);
      await primary.sender.replaceTrack(session.receiveOnly ? null : this.localAudioTrack);
      if (this.isCurrentPeer(session)) await this.renegotiateIfNeeded(session);
    }).catch((error: unknown) => {
      clientLog.error('WEBRTC', 'Could not apply bot microphone reception permission', { error: String(error) });
      if (this.isCurrentPeer(session)) this.removePeer(peerSessionId);
    });
  }

  public async connectToPeer(peerSessionId: string, isInitiator: boolean): Promise<void> {
    if (this.voiceReconnectSuspended) return;
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

    const participant = this.voiceParticipants.get(peerSessionId);
    const botPeer = peerSessionId.startsWith('bot:') || participant?.user.isBot === true;
    const session: PeerSession = {
      peerSessionId,
      botPeer,
      receiveOnly: botPeer && !isReceivingBotVoice(participant?.voiceState),
      pc,
      remoteStream,
      remoteScreenStreams: new Map(),
      isPolite,
      makingOffer: false,
      candidateQueue: [],
      screenVideoSenders: new Map(),
      screenSubscriptionId: crypto.randomUUID(),
      screenWatchState: new Map(),
      iceRestartAttempts: 0,
      reconnectAttempts: 0,
      isRecovering: false,
    };
    this.peers.set(peerSessionId, session);

    // Setup Audio Transceiver
    if (session.botPeer) {
      // An answerer must attach to the offered m-line. Pre-creating sendonly
      // here makes Chromium retain an unassociated second microphone.
      if (isInitiator) {
        const transceiver = pc.addTransceiver('audio', { direction: this.botAudioDirection(session) });
        session.audioSender = transceiver.sender;
        if (!session.receiveOnly && this.localAudioTrack) await transceiver.sender.replaceTrack(this.localAudioTrack);
      }
    } else if (this.localAudioTrack) {
      session.audioSender = pc.addTrack(this.localAudioTrack, new MediaStream([this.localAudioTrack]));
    } else {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
    }

    // Setup Video Transceiver (Camera on the primary video m-line). Screen
    // share now rides its own second sender (see below) so camera + screen can
    // be sent simultaneously as two independent tiles (#26).
    if (!session.botPeer) {
      if (this.localCameraTrack) {
        session.videoSender = pc.addTrack(this.localCameraTrack, new MediaStream([this.localCameraTrack]));
      } else {
        pc.addTransceiver('video', { direction: 'sendrecv' });
      }
    }

    // Setup Screen Video Tracks as dedicated extra senders (if currently
    // sharing). Announce each stream ID first so the receiver can tell them
    // apart from the camera track and from each other (mirrors the
    // screen-audio-meta mechanism) — #26, #253.
    for (const [shareId, share] of this.localScreenShares) {
      if (session.botPeer) break;
      if (share.track.readyState === 'live') this.ensureP2pScreenSender(session, shareId, share);
    }

    // Setup Screen Audio Track (if currently sharing)
    if (!session.botPeer && this.localScreenAudioTrack && this.screenAudioStream) {
      // Announce stream ID before adding track
      this.signalClient.send(MessageType.RTC_SIGNAL, {
        targetSessionId: peerSessionId,
        fromSessionId: this.currentSessionId,
        signalType: 'screen-audio-meta',
        streamId: this.screenAudioStreamId,
        subscriptionId: session.screenSubscriptionId,
      });
      session.screenAudioSender = pc.addTransceiver('audio', {
        direction: 'sendonly', streams: [this.screenAudioStream],
        sendEncodings: [{ active: false }],
      }).sender;
    }

    // ICE Candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate && this.peers.get(peerSessionId) === session) {
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
      if (!this.isCurrentPeer(session)) {
        event.track.stop();
        return;
      }
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
        this.vadMonitor.setupRemoteReceiverVad(peerSessionId, () =>
          this.isCurrentPeer(session) ? event.receiver : null);
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
        if (!this.isCurrentPeer(session)) return;
        remoteStream.removeTrack(event.track);
        this.voiceParticipants.setRemoteStream(peerSessionId, remoteStream);
      };

      event.track.onunmute = () => {
        if (!this.isCurrentPeer(session) || !remoteStream.getTrackById(event.track.id)) return;
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
      if (!this.isCurrentPeer(session)) return;
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
      if (!this.isCurrentPeer(session)) return;
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

    try {
      applyVideoCodecPreferences(pc, settingsStore.preferredVideoCodec, session.screenVideoSenders.values());
    } catch (error) {
      for (const shareId of [...session.screenVideoSenders.keys()]) {
        await this.failLocalScreenShare(shareId, error, !this.localScreenShares.get(shareId)?.pending, false);
      }
    }
    if (this.peers.get(peerSessionId) !== session) return;

    // Watchdog to ensure connection establishes within a reasonable time
    this.startConnectionWatchdog(session);

    // Initial offer if initiator
    if (isInitiator) {
      await this.sendOffer(session);
    }
  }

  private async sendOffer(session: PeerSession, iceRestart = false, propagateError = false): Promise<void> {
    if (!this.isCurrentPeer(session)) return;
    // Native "stable" fires before the answer promise resolves and is sent.
    for (let pending = this.nativeTasks.get(session); pending; pending = this.nativeTasks.get(session)) {
      await pending;
      if (!this.isCurrentPeer(session)) return;
    }
    const client = this.signalClient;
    const localSessionId = this.currentSessionId;
    const preferred = settingsStore.preferredVideoCodec;
    const qualityPreset = settingsStore.qualityPreset;
    const negotiation = { preferred };
    session.screenNegotiation = negotiation;
    const isCurrent = () => this.isCurrentPeer(session) && session.screenNegotiation === negotiation;
    try {
      session.makingOffer = true;
      this.announceScreenSources(session);
      await this.prepareScreenEncodings(session, negotiation);
      if (!isCurrent()) return;
      applyVideoCodecPreferences(session.pc, preferred, session.screenVideoSenders.values());
      const offer = await session.pc.createOffer({
        ...(!session.botPeer ? { offerToReceiveAudio: true, offerToReceiveVideo: true } : {}),
        iceRestart,
      });
      if (!isCurrent()) return;
      await session.pc.setLocalDescription(offer);
      if (!isCurrent()) return;
      session.offeredScreenNegotiation = negotiation;

      const screenCodecs = [...session.screenVideoSenders].map(([shareId, sender]) => {
        const mid = session.pc.getTransceivers().find((entry) => entry.sender === sender)?.mid;
        return { shareId, mid, codecs: mid === null || mid === undefined ? [] : getSdpVideoCodecOrder(session.pc.localDescription?.sdp ?? '', mid) };
      });
      if (screenCodecs.length > 0) {
        clientLog.info('WEBRTC', 'P2P offer video codec order', {
          peer: session.peerSessionId,
          preferred,
          qualityPreset,
          screenCodecs,
        });
      }

      client.send(MessageType.RTC_SIGNAL, {
        targetSessionId: session.peerSessionId,
        fromSessionId: localSessionId,
        signalType: 'offer',
        subscriptionId: session.screenSubscriptionId,
        sdp: session.pc.localDescription?.toJSON ? session.pc.localDescription.toJSON() : session.pc.localDescription,
      });
    } catch (err) {
      clientLog.error('WEBRTC', `Error sending offer to ${session.peerSessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[WebRTC] Error sending offer to ${session.peerSessionId}:`, err);
      if (err instanceof ScreenCodecError && isCurrent()) {
        for (const shareId of [...session.screenVideoSenders.keys()]) {
          await this.failLocalScreenShare(shareId, err, !this.localScreenShares.get(shareId)?.pending, false);
        }
        if (session.screenVideoSenders.size === 0 && session.pc.signalingState === 'stable') {
          queueMicrotask(() => { void this.sendOffer(session); });
        }
      }
      if (propagateError) throw err;
    } finally {
      if (session.screenNegotiation === negotiation) session.makingOffer = false;
    }
  }

  private async sendAnswer(session: PeerSession, negotiation: ScreenCodecNegotiation): Promise<boolean> {
    const client = this.signalClient;
    const localSessionId = this.currentSessionId;
    const isCurrent = () => this.isCurrentPeer(session) && session.screenNegotiation === negotiation;
    if (!isCurrent()) return false;
    const { preferred } = negotiation;
    this.announceScreenSources(session);
    applyVideoCodecPreferences(session.pc, preferred, session.screenVideoSenders.values());
    const answer = await session.pc.createAnswer();
    if (!isCurrent()) return false;
    const previousNegotiation = session.negotiatedScreenNegotiation;
    session.negotiatedScreenNegotiation = negotiation;
    try {
      await session.pc.setLocalDescription(answer);
    } catch (error) {
      if (isCurrent()) session.negotiatedScreenNegotiation = previousNegotiation;
      throw error;
    }
    if (!isCurrent()) return false;
    client.send(MessageType.RTC_SIGNAL, {
      targetSessionId: session.peerSessionId,
      fromSessionId: localSessionId,
      signalType: 'answer',
      subscriptionId: session.screenSubscriptionId,
      sdp: answer,
    });
    return true;
  }

  private async handleIncomingSignal(payload: WebRtcSignalPayload): Promise<void> {
    if (this.voiceReconnectSuspended) return;
    const { fromSessionId, signalType, streamId } = payload;
    if (!this.isPeerInOurCall(fromSessionId) || this.isSfuMode()) return;

    if (signalType === 'screen-watch') {
      const parsed = screenWatchSignalSchema.safeParse(payload);
      const session = this.peers.get(fromSessionId);
      if (!parsed.success || !session || parsed.data.subscriptionId !== session.screenSubscriptionId
        || parsed.data.watcherSubscriptionId !== session.remoteSubscriptionId
        || !this.localScreenShares.has(parsed.data.streamId)) return;
      const previous = session.screenWatchState.get(parsed.data.streamId);
      if (previous && previous.revision >= parsed.data.subscriptionRevision) return;
      session.screenWatchState.set(parsed.data.streamId, {
        watching: parsed.data.watching, revision: parsed.data.subscriptionRevision,
      });
      await this.syncPeerScreenSubscriptions(session);
      if (parsed.data.watching && this.isCurrentPeer(session)) await this.renegotiateIfNeeded(session);
      return;
    }

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
      if (streamId && payload.subscriptionId) {
        const subscriptions = this.remoteScreenSubscriptions.get(fromSessionId)
          ?? new Map<string, { id: string; revision: number; published: boolean }>();
        const previous = subscriptions.get(streamId);
        if (previous?.id !== payload.subscriptionId) {
          const liveIds = this.voiceParticipants.get(fromSessionId)?.voiceState?.screenShareIds ?? [];
          if (!previous && subscriptions.size >= 2) {
            const obsolete = [...subscriptions.keys()].find(id => !liveIds.includes(id));
            if (obsolete) {
              subscriptions.delete(obsolete);
              this.screenVideoStreamIds.delete(obsolete);
            }
            else return;
          }
          subscriptions.set(streamId, {
            id: payload.subscriptionId, revision: 0, published: liveIds.includes(streamId),
          });
        }
        this.remoteScreenSubscriptions.set(fromSessionId, subscriptions);
        this.sendScreenWatch(fromSessionId, streamId);
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

    const peer = session;
    try {
      if (signalType === 'offer' || signalType === 'answer') {
        if (!payload.subscriptionId) return;
        if (peer.remoteSubscriptionId !== payload.subscriptionId) {
          peer.remoteSubscriptionId = payload.subscriptionId;
          peer.screenWatchState.clear();
          // The same device/session ID can reconnect with a new call. Its old
          // consent must be revoked before SDP makes that connection usable.
          await this.syncPeerScreenSubscriptions(peer);
        }
      }
      const apply = () => this.applyIncomingSignal(peer, payload);
      const changed = signalType === 'offer' || signalType === 'answer'
        ? await this.runNativeTask(peer, apply) : await apply();
      if (!changed || !this.isCurrentPeer(peer)) return;
      await this.checkSessionScreenCodecs(peer);
      this.applyBitrateConstraints();
      // Follow-up offers must run outside the incoming-description queue.
      await this.renegotiateIfNeeded(peer);
      for (const shareId of this.remoteScreenSubscriptions.get(fromSessionId)?.keys() ?? []) {
        this.sendScreenWatch(fromSessionId, shareId);
      }
    } catch (error) {
      clientLog.error('WEBRTC', `Could not finish negotiation with ${fromSessionId}`, {
        signalType, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyIncomingSignal(session: PeerSession, payload: WebRtcSignalPayload): Promise<boolean> {
    if (!this.isCurrentPeer(session)) return false;
    const { fromSessionId, signalType, sdp, candidate } = payload;
    const incomingNegotiation = { preferred: settingsStore.preferredVideoCodec };
    try {
      if (signalType === 'offer' && sdp) {
        const offerCollision =
          session.makingOffer || session.pc.signalingState !== 'stable';

        if (offerCollision) {
          if (!session.isPolite) {
            console.log(`[WebRTC] Impolite peer ignoring offer collision from ${fromSessionId}`);
            return false;
          }
          console.log(`[WebRTC] Polite peer rolling back for offer from ${fromSessionId}`);
        }
        session.screenNegotiation = incomingNegotiation;
        session.makingOffer = false;
        if (offerCollision) {
          if (session.pc.signalingState === 'have-local-offer') {
            await session.pc.setLocalDescription({ type: 'rollback' });
          }
        }

        await this.prepareScreenEncodings(session, incomingNegotiation);
        if (!this.isCurrentPeer(session) || session.screenNegotiation !== incomingNegotiation) return false;
        await session.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (!this.isCurrentPeer(session) || session.screenNegotiation !== incomingNegotiation) return false;
        const { preferred } = incomingNegotiation;
        if (preferred !== 'auto') {
          for (const [shareId, sender] of [...session.screenVideoSenders]) {
            const transceiver = session.pc.getTransceivers().find((entry) => entry.sender === sender);
            if (transceiver?.mid === null || !transceiver) continue;
            const offered = getSdpVideoCodecOrder(sdp.sdp ?? '', transceiver.mid);
            if (!offered.includes(preferred)) {
              // A rejected screen m-line must not strand the microphone in
              // have-remote-offer. Stop this sender, then answer the other media.
              await this.failLocalScreenShare(shareId,
                new ScreenCodecError(preferred, 'incompatible'),
                !this.localScreenShares.get(shareId)?.pending, false);
            }
          }
        }

        // Flush any queued candidates
        while (session.candidateQueue.length > 0) {
          const c = session.candidateQueue.shift();
          if (c) {
            await session.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        }

        if (session.botPeer) {
          session.receiveOnly = !isReceivingBotVoice(this.voiceParticipants.get(fromSessionId)?.voiceState);
          const primary = session.pc.getTransceivers().find((entry) => entry.receiver.track.kind === 'audio');
          if (primary) {
            primary.direction = this.botAudioDirection(session);
            await primary.sender.replaceTrack(session.receiveOnly ? null : this.localAudioTrack);
            session.audioSender = primary.sender;
          }
        }
        // 1. Ensure local audio track is attached to audio transceiver
        if (!session.receiveOnly && this.localAudioTrack) {
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
        const cameraTrack = session.botPeer ? null : this.localCameraTrack;
        const transceivers = session.pc.getTransceivers();
        const videoTransceiver = transceivers.find(
          (t) =>
            (t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video') &&
            !this.isScreenVideoSender(session, t.sender)
        );
        if (videoTransceiver) {
          videoTransceiver.direction = session.botPeer ? 'inactive' : cameraTrack ? 'sendrecv' : 'recvonly';
          await videoTransceiver.sender.replaceTrack(cameraTrack);
          session.videoSender = videoTransceiver.sender;
        } else if (cameraTrack) {
          session.videoSender = session.pc.addTrack(cameraTrack, new MediaStream([cameraTrack]));
        }

        return await this.sendAnswer(session, incomingNegotiation);
      } else if (signalType === 'answer' && sdp) {
        if (session.pc.signalingState === 'have-local-offer') {
          const negotiation = session.offeredScreenNegotiation;
          const previousNegotiation = session.negotiatedScreenNegotiation;
          session.negotiatedScreenNegotiation = negotiation;
          try {
            await session.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          } catch (error) {
            if (session.screenNegotiation === negotiation) session.negotiatedScreenNegotiation = previousNegotiation;
            throw error;
          }
          if (!this.isCurrentPeer(session)) return false;

          // Flush queued candidates
          while (session.candidateQueue.length > 0) {
            const c = session.candidateQueue.shift();
            if (c) {
              await session.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
          }

          return true;
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
      if (err instanceof ScreenCodecError && this.isCurrentPeer(session)
        && session.screenNegotiation === incomingNegotiation) {
        for (const shareId of [...session.screenVideoSenders.keys()]) {
          await this.failLocalScreenShare(shareId, err, !this.localScreenShares.get(shareId)?.pending, false);
        }
        if (session.pc.signalingState === 'have-remote-offer') {
          try {
            return await this.sendAnswer(session, incomingNegotiation);
          } catch (answerError) {
            clientLog.error('WEBRTC', 'Could not answer after rejecting an unsupported screen codec', {
              error: answerError instanceof Error ? answerError.message : String(answerError),
            });
          }
        }
      }
    }
    return false;
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
      if (this.voiceReconnectSuspended || signal.aborted || !sameSession() || this.localAudioTrack !== previous) {
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
          if (session.receiveOnly || session.pc.connectionState === 'closed') continue;
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
    if (this.voiceReconnectSuspended) return;
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
      if (session.receiveOnly) continue;
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

  public async setLocalCameraTrack(track: MediaStreamTrack | null, isCurrent: () => boolean = () => true): Promise<void> {
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const pending = this.cameraTrackChange;
    if (!track && pending?.track === null && pending.channelId === channelId && pending.sessionKey === sessionKey) {
      return pending.task;
    }
    if (track && (track.kind !== 'video' || track.readyState !== 'live' || !isCurrent())) {
      throw new DOMException('Camera publication was cancelled', 'AbortError');
    }
    const revision = ++this.cameraTrackRevision;
    this.localCameraTrack = track;
    const ensureCurrent = () => {
      if (revision !== this.cameraTrackRevision || voiceStore.currentVoiceChannelId !== channelId ||
          voiceStore.voiceSessionKey !== sessionKey || (track && (
            this.voiceReconnectSuspended || track.readyState !== 'live' || !isCurrent()))) {
        throw new DOMException('Camera publication was cancelled', 'AbortError');
      }
    };
    const apply = async () => {
      try {
        ensureCurrent();
        if (!track) this.sfuEngine.closeProducer('camera');
        if (this.voiceReconnectSuspended) return;
        if (this.isSfuMode()) {
          if (!track) return;
          if (!this.sfuEngine.isReady()) await this.initSfuForCurrentChannel();
          ensureCurrent();
          if (!this.sfuEngine.isReady()) throw new Error('SFU camera transport is not ready');
          const current = this.sfuEngine.getCameraTrack();
          if (current !== track) {
            if (current) {
              if (!await this.sfuEngine.replaceTrack('camera', track)) throw new Error('Could not replace SFU camera');
            } else if (!await this.sfuEngine.produceCamera(track)) {
              throw new Error('Could not publish SFU camera');
            }
          }
        } else {
          await this.updateVideoTrackAcrossPeers(track, ensureCurrent);
        }
        ensureCurrent();
      } catch (error) {
        if (revision === this.cameraTrackRevision) this.localCameraTrack = null;
        if (track) {
          if (this.sfuEngine.getCameraTrack() === track) this.sfuEngine.closeProducer('camera');
          const cleanup = await Promise.allSettled([...this.peers.values()].map(async (session) => {
            const sender = this.cameraTransceiver(session)?.sender ?? session.videoSender;
            if (sender?.track === track && session.pc.connectionState !== 'closed') await sender.replaceTrack(null);
          }));
          if (cleanup.some((result) => result.status === 'rejected')) {
            clientLog.error('VIDEO', 'Could not detach every failed camera sender');
          }
        }
        throw error;
      }
    };
    // Keep an old asynchronous replacement from winning after a newer effect/device.
    const task = (pending?.task ?? Promise.resolve()).then(apply, apply);
    const change = { track, channelId, sessionKey, task };
    this.cameraTrackChange = change;
    try {
      await task;
    } finally {
      if (this.cameraTrackChange === change) this.cameraTrackChange = null;
    }
  }

  /** Preflight before requesting capture; each transport supplies its actual codec capabilities. */
  public assertScreenShareSupported(): void {
    if (this.voiceReconnectSuspended) throw new Error(t('screenCodec.reconnecting'));
    if (this.isSfuMode()) this.sfuEngine.assertScreenShareSupported();
    else getScreenVideoCodecs();
  }

  /** Common admission, cancellation and failure handling; only publication differs by transport. */
  public async addLocalScreenTrack(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const shareId = stream.id;
    const share: LocalScreenShare = { stream, track, pending: true };
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const sfu = this.isSfuMode();
    const isCurrent = () => voiceStore.currentVoiceChannelId === channelId
      && voiceStore.voiceSessionKey === sessionKey && this.localScreenShares.get(shareId) === share
      && track.readyState === 'live' && !this.voiceReconnectSuspended && this.isSfuMode() === sfu;
    try {
      if (this.voiceReconnectSuspended) throw new Error(t('screenCodec.reconnecting'));
      this.localScreenShares.set(shareId, share);
      for (const session of this.peers.values()) session.screenWatchState.delete(shareId);
      let published: PreferredVideoCodec;
      do {
        if (sfu) published = await this.publishSfuScreenShare(shareId, share, isCurrent);
        else {
          await this.publishP2pScreenShare(shareId, share, isCurrent);
          published = settingsStore.preferredVideoCodec;
        }
        if (!isCurrent()) throw new DOMException('Screen share was cancelled', 'AbortError');
        await this.applyBitrateConstraints();
        if (!isCurrent()) throw new DOMException('Screen share was cancelled', 'AbortError');
      } while (sfu && published !== settingsStore.preferredVideoCodec);
    } catch (error) {
      if (this.localScreenShares.get(shareId) === share) {
        await this.failLocalScreenShare(shareId, error, false);
      } else if (!this.localScreenShares.has(shareId)
        && videoService.getScreenStream(shareId)?.getVideoTracks()[0] === track) {
        videoService.stopScreenShare(shareId);
      }
      if (this.localScreenShares.get(shareId)?.track !== track) track.stop();
      throw error;
    } finally {
      if (this.localScreenShares.get(shareId) === share) share.pending = false;
    }
  }

  private ensureP2pScreenSender(session: PeerSession, shareId: string, share: LocalScreenShare): RTCRtpSender {
    this.signalClient.send(MessageType.RTC_SIGNAL, {
      targetSessionId: session.peerSessionId, fromSessionId: this.currentSessionId,
      signalType: 'screen-video-meta', streamId: shareId,
      subscriptionId: session.screenSubscriptionId,
    });
    const existing = session.screenVideoSenders.get(shareId);
    if (existing) return existing;
    const policy = getMediaEncodingPolicy('screen', this.currentPreset, this.getQualityProfile());
    // A dedicated sending m-line must never constrain an unrelated remote camera/screen.
    const sender = session.pc.addTransceiver('video', {
      direction: 'sendonly', streams: [share.stream],
      sendEncodings: [{ ...policy.encoding, active: false }],
    }).sender;
    session.screenVideoSenders.set(shareId, sender);
    return sender;
  }

  public announcePublishedScreenSources(shareIds: readonly string[]): void {
    if (!voiceStore.currentVoiceChannelId || this.voiceReconnectSuspended || this.isSfuMode() || !shareIds.length) return;
    for (const session of this.peers.values()) {
      if (this.isCurrentPeer(session) && this.isPeerInOurCall(session.peerSessionId)) {
        this.announceScreenSources(session, shareIds);
      }
    }
  }

  private announceScreenSources(
    session: PeerSession,
    shareIds: Iterable<string> = this.localScreenShares.keys(),
  ): void {
    if (session.botPeer) return;
    for (const shareId of shareIds) {
      const share = this.localScreenShares.get(shareId);
      if (!share || share.track.readyState !== 'live') continue;
      this.signalClient.send(MessageType.RTC_SIGNAL, {
        targetSessionId: session.peerSessionId, fromSessionId: this.currentSessionId,
        signalType: 'screen-video-meta', streamId: shareId, subscriptionId: session.screenSubscriptionId,
      });
    }
    if (this.localScreenAudioTrack?.readyState === 'live' && this.screenAudioStreamId) {
      this.signalClient.send(MessageType.RTC_SIGNAL, {
        targetSessionId: session.peerSessionId, fromSessionId: this.currentSessionId,
        signalType: 'screen-audio-meta', streamId: this.screenAudioStreamId,
        subscriptionId: session.screenSubscriptionId,
      });
    }
  }

  private async publishP2pScreenShare(
    shareId: string,
    share: LocalScreenShare,
    isCurrent: () => boolean,
  ): Promise<void> {
    // SFU validates its negotiated send capabilities instead of this P2P capability set.
    getScreenVideoCodecs();
    const { track } = share;
    for (const session of [...this.peers.values()]) {
      if (session.botPeer) continue;
      try {
        const stable = await this.waitForStable(session.pc);
        if (!this.isCurrentPeer(session)) continue;
        if (!stable) throw new Error(t('voiceReconnect.timeout'));
        if (!isCurrent()) throw new DOMException('Screen share was cancelled', 'AbortError');
        const existing = session.screenVideoSenders.get(shareId);
        if (existing) {
          for (let pending = this.nativeTasks.get(session); pending; pending = this.nativeTasks.get(session)) {
            await pending;
            if (!this.isCurrentPeer(session)) break;
          }
          if (!this.isCurrentPeer(session)) continue;
          const negotiation = { preferred: settingsStore.preferredVideoCodec };
          session.screenNegotiation = negotiation;
          session.makingOffer = false;
          await this.prepareScreenEncodings(session, negotiation);
          if (!this.isCurrentPeer(session)) continue;
          if (!isCurrent()) throw new DOMException('Screen share was cancelled', 'AbortError');
          await existing.replaceTrack(this.peerWatchesScreen(session, shareId) ? track : null);
          if (!this.isCurrentPeer(session)) continue;
        }
        this.ensureP2pScreenSender(session, shareId, share);
        await this.sendOffer(session);
        const answered = await this.waitForStable(session.pc);
        if (!this.isCurrentPeer(session)) continue;
        if (!answered) throw new Error(t('voiceReconnect.timeout'));
        await this.renegotiateIfNeeded(session);
        if (!this.isCurrentPeer(session)) continue;
        const sender = session.screenVideoSenders.get(shareId);
        const transceiver = session.pc.getTransceivers().find((entry) => entry.sender === sender);
        if (!transceiver || !isCurrent()) throw new ScreenCodecError(settingsStore.preferredVideoCodec, 'incompatible');
        if (session.pc.signalingState === 'stable' && session.negotiatedScreenNegotiation) {
          assertScreenCodecNegotiated(transceiver, session.negotiatedScreenNegotiation.preferred, this.screenAnswerSdp(session.pc));
        }
      } catch (error) {
        if (!this.isCurrentPeer(session)) continue;
        throw error;
      }
    }
  }

  private isCurrentPeer(session: PeerSession): boolean {
    return this.peers.get(session.peerSessionId) === session && session.pc.signalingState !== 'closed';
  }

  private peerWatchesScreen(session: PeerSession, shareId: string): boolean {
    return this.isCurrentPeer(session) && session.screenWatchState.get(shareId)?.watching === true
      && this.localScreenShares.get(shareId)?.track.readyState === 'live';
  }

  private peerWatchesAnyScreen(session: PeerSession): boolean {
    return [...session.screenWatchState.keys()].some(shareId => this.peerWatchesScreen(session, shareId));
  }

  private async syncPeerScreenSubscriptions(session: PeerSession): Promise<void> {
    const previous = this.screenSubscriptionTasks.get(session) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (!this.isCurrentPeer(session)) return;
      const updates: Promise<void>[] = [];
      for (const [shareId, sender] of session.screenVideoSenders) {
        const desired = () => this.peerWatchesScreen(session, shareId)
          ? this.localScreenShares.get(shareId)?.track ?? null : null;
        updates.push(this.syncScreenSender(session, sender, desired, false));
      }
      if (session.screenAudioSender) {
        const desired = () => this.peerWatchesAnyScreen(session) ? this.localScreenAudioTrack : null;
        updates.push(this.syncScreenSender(session, session.screenAudioSender, desired, true));
      }
      const results = await Promise.allSettled(updates);
      await this.checkSessionScreenCodecs(session);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    const settled = task.catch(error => {
      clientLog.error('WEBRTC', 'Could not update screen subscription', {
        peerSessionId: session.peerSessionId, error: error instanceof Error ? error.message : String(error),
      });
    });
    this.screenSubscriptionTasks.set(session, settled);
    try { await settled; }
    finally {
      if (this.screenSubscriptionTasks.get(session) === settled) this.screenSubscriptionTasks.delete(session);
    }
  }

  private async syncScreenSender(
    session: PeerSession,
    sender: RTCRtpSender,
    desiredTrack: () => MediaStreamTrack | null,
    audio: boolean,
  ): Promise<void> {
    if (!this.isCurrentPeer(session)) return;
    try {
      if (!desiredTrack() || sender.track !== desiredTrack()) {
        await updateRtpSenderParameters(sender, parameters => {
          for (const encoding of parameters.encodings) encoding.active = false;
          return parameters.encodings.length > 0;
        });
        if (!this.isCurrentPeer(session)) return;
        await sender.replaceTrack(desiredTrack());
        if (!this.isCurrentPeer(session)) return;
        // Stop may arrive while replaceTrack is pending. Never restore its track.
        if (!desiredTrack() && sender.track) await sender.replaceTrack(null);
      }
      if (this.isCurrentPeer(session)) {
        await updateRtpSenderParameters(sender, parameters => {
          if (!this.isCurrentPeer(session)) return false;
          applyMediaEncodingPolicy(parameters, getMediaEncodingPolicy(
            audio ? 'audio' : 'screen', this.currentPreset, this.getQualityProfile()));
          if (audio) for (const encoding of parameters.encodings) encoding.active = !!desiredTrack();
          return parameters.encodings.length > 0;
        });
      }
    } catch (error) {
      // Failing setParameters/replaceTrack must fail closed, not keep sending.
      if (this.isCurrentPeer(session)) {
        session.pc.removeTrack(sender);
        const transceiver = session.pc.getTransceivers().find(entry => entry.sender === sender);
        if (transceiver) transceiver.direction = 'sendonly';
      }
      throw error;
    }
  }

  private async runNativeTask<T>(key: PeerSession, operation: () => Promise<T>): Promise<T> {
    const previous = this.nativeTasks.get(key) ?? Promise.resolve();
    const task = previous.then(operation);
    // The caller receives failures; the queue must still admit later updates.
    const settled = task.then(() => {}, () => {});
    this.nativeTasks.set(key, settled);
    try {
      return await task;
    } finally {
      if (this.nativeTasks.get(key) === settled) this.nativeTasks.delete(key);
    }
  }

  private async prepareScreenEncodings(session: PeerSession, negotiation: ScreenCodecNegotiation): Promise<void> {
    for (const [shareId, sender] of [...session.screenVideoSenders]) {
      const isCurrent = () => this.isCurrentPeer(session) && session.screenNegotiation === negotiation
        && session.screenVideoSenders.get(shareId) === sender && this.localScreenShares.get(shareId)?.track.readyState === 'live';
      if (!isCurrent()) continue;
      try {
        await updateRtpSenderParameters(sender, parameters => {
          if (!isCurrent()) return false;
          let changed = false;
          for (const encoding of parameters.encodings) {
            changed ||= encoding.active !== false || encoding.codec !== undefined;
            encoding.active = false;
            delete encoding.codec;
          }
          return changed;
        });
      } catch (error) {
        if (isCurrent()) throw new ScreenCodecError(negotiation.preferred, 'notApplied', error);
      }
    }
  }

  private async checkSessionScreenCodecs(session: PeerSession): Promise<void> {
    const negotiation = session.negotiatedScreenNegotiation;
    if (!negotiation) return;
    const { preferred } = negotiation;
    const isCurrent = () => this.isCurrentPeer(session) && session.pc.signalingState === 'stable'
      && session.screenNegotiation === negotiation && session.negotiatedScreenNegotiation === negotiation;
    if (!isCurrent()) return;
    for (const [shareId, sender] of [...session.screenVideoSenders]) {
      if (!isCurrent()) return;
      const isCurrentSender = () => isCurrent() && session.screenVideoSenders.get(shareId) === sender
        && this.localScreenShares.get(shareId)?.track === sender.track && sender.track?.readyState === 'live';
      if (!isCurrentSender()) continue;
      const transceiver = session.pc.getTransceivers().find((entry) => entry.sender === sender);
      if (!transceiver || transceiver.mid === null) continue;
      try {
        // A new preference belongs to the next negotiation, not this answer.
        assertScreenCodecNegotiated(transceiver, preferred, this.screenAnswerSdp(session.pc));
        const canActivate = () => isCurrentSender() && this.peerWatchesScreen(session, shareId)
          && settingsStore.preferredVideoCodec === preferred;
        const mime = explicitScreenCodecMime(preferred);
        await updateRtpSenderParameters(sender, parameters => {
          if (!canActivate()) return false;
          const codec = mime ? parameters.codecs.find(entry => entry.mimeType.toLowerCase() === mime) : undefined;
          if (mime && !codec) throw new ScreenCodecError(preferred, 'incompatible');
          if (!parameters.encodings.length) throw new ScreenCodecError(preferred, 'notApplied');
          // setCodecPreferences controls reception. Pin the actual encoder
          // before resuming, even when a remote offer prefers another codec.
          for (const encoding of parameters.encodings) {
            if (codec) encoding.codec = codec;
            else delete encoding.codec;
            encoding.active = true;
          }
          return true;
        }, parameters => {
          if (canActivate() && parameters.encodings.some(encoding =>
            mime ? encoding.codec?.mimeType.toLowerCase() !== mime : encoding.codec !== undefined)) {
            throw new ScreenCodecError(preferred, 'notApplied');
          }
        });
      } catch (error) {
        if (!isCurrentSender() || settingsStore.preferredVideoCodec !== preferred) continue;
        const failure = error instanceof ScreenCodecError ? error : new ScreenCodecError(preferred, 'notApplied', error);
        await this.failLocalScreenShare(shareId, failure, !this.localScreenShares.get(shareId)?.pending);
      }
    }
  }

  private screenAnswerSdp(pc: RTCPeerConnection): string {
    return pc.currentLocalDescription?.type === 'answer'
      ? pc.currentLocalDescription.sdp : pc.currentRemoteDescription?.type === 'answer' ? pc.currentRemoteDescription.sdp : '';
  }

  private async failLocalScreenShare(shareId: string, reason: unknown, notify = true, renegotiate = true): Promise<void> {
    const stream = this.localScreenShares.get(shareId)?.stream;
    if (!stream) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    clientLog.error('SCREEN_SHARE', 'Screen codec could not be honored', { shareId, error: error.message });
    const stopAudio = voiceStore.screenAudioShareId === shareId;
    videoService.stopScreenShare(shareId);
    stream.getTracks().forEach((track) => track.stop());
    voiceStore.removeScreenShare(shareId);
    this.signalClient.send(MessageType.VOICE_STATE_UPDATE, {
      isScreenSharing: voiceStore.isScreenSharing, screenShareIds: voiceStore.screenShareIds,
    });
    const removal = this.removeLocalScreenTrack(shareId, renegotiate);
    appEvents.emit('screen.codec_failed', { error: error.message, notify, stopAudio });
    await removal;
  }

  /**
   * Remove one local screen share from every peer (#253).
   */
  public async removeLocalScreenTrack(shareId: string, renegotiate = true): Promise<void> {
    this.localScreenShares.delete(shareId);
    // Retire any actual publication, including one from the mode being replaced.
    this.sfuEngine.closeProducer(`screen_video:${shareId}`);

    for (const session of this.peers.values()) {
      session.screenWatchState.delete(shareId);
      void this.syncPeerScreenSubscriptions(session);
      const sender = session.screenVideoSenders.get(shareId);
      if (!sender) continue;
      try {
        session.pc.removeTrack(sender);
        session.pc.getTransceivers().find((entry) => entry.sender === sender)?.stop();
        session.screenVideoSenders.delete(shareId);
        if (renegotiate && await this.waitForStable(session.pc)) await this.sendOffer(session);
      } catch (err) {
        console.warn(`[WebRTC] Error removing screen video track for ${session.peerSessionId}:`, err);
      }
    }
  }

  /**
   * Tear down every local screen share (leaving the channel, camera swap, …).
   */
  public async removeAllLocalScreenTracks(): Promise<void> {
    for (const shareId of [...this.localScreenShares.keys()]) {
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
    this.localScreenShares.clear();
  }

  public removeNativeScreenSource(shareId: string): Promise<void> {
    return this.nativeScreens.removeSource(shareId);
  }

  /**
   * Set the call's screen audio source and announce its identity before attaching
   * it to peers that explicitly watch at least one of our screens.
   */
  public async setLocalScreenAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    const stream = track ? new MediaStream([track]) : null;
    this.localScreenAudioTrack = track;
    // Desired audio and its stream identity belong to the share, not to P2P.
    this.screenAudioStream = stream;
    this.screenAudioStreamId = stream?.id ?? null;
    if (!track) {
      this.sfuScreenAudioPublication = null;
      this.sfuEngine.closeProducer('screen_audio:default');
    }
    if (this.voiceReconnectSuspended) return;

    const sfu = this.isSfuMode();
    const isCurrent = () => this.localScreenAudioTrack === track && this.screenAudioStream === stream
      && (!track || track.readyState === 'live') && !this.voiceReconnectSuspended && this.isSfuMode() === sfu;
    if (sfu && track) {
      const producer = await this.publishSfuScreenAudio(track);
      if (!isCurrent()) throw new DOMException('Screen audio was cancelled', 'AbortError');
      if (!producer) {
        this.localScreenAudioTrack = null;
        this.screenAudioStream = null;
        this.screenAudioStreamId = null;
        throw new Error(t('screenCodec.reconnecting'));
      }
      return;
    }

    if (track && stream) {
      // Announce stream ID to all peers BEFORE adding the track
      for (const session of this.peers.values()) {
        if (session.botPeer) continue;
        this.signalClient.send(MessageType.RTC_SIGNAL, {
          targetSessionId: session.peerSessionId,
          fromSessionId: this.currentSessionId,
          signalType: 'screen-audio-meta',
          streamId: this.screenAudioStreamId,
          subscriptionId: session.screenSubscriptionId,
        });
      }

      // Add track to all peers — wait for stable signaling state before
      // renegotiating, since screen video may have just triggered an offer.
      for (const session of this.peers.values()) {
        if (session.botPeer) continue;
        try {
          const stable = await this.waitForStable(session.pc);
          if (!this.isCurrentPeer(session)) continue;
          if (!isCurrent()) throw new DOMException('Screen audio was cancelled', 'AbortError');
          if (!stable) throw new Error(t('voiceReconnect.timeout'));
          if (session.screenAudioSender) {
            session.screenAudioSender.setStreams(stream);
          } else {
            const policy = getMediaEncodingPolicy('audio', this.currentPreset, this.getQualityProfile());
            session.screenAudioSender = session.pc.addTransceiver('audio', {
              direction: 'sendonly', streams: [stream],
              sendEncodings: [{ ...policy.encoding, active: false }],
            }).sender;
          }
          await this.syncPeerScreenSubscriptions(session);
          if (!this.isCurrentPeer(session)) continue;
          if (!isCurrent()) throw new DOMException('Screen audio was cancelled', 'AbortError');
          await this.sendOffer(session);
          // Wait for the answer, then verify the track was actually negotiated.
          // If a glare/rollback dropped the offer, re-send it now.
          await this.waitForStable(session.pc);
          await this.renegotiateIfNeeded(session);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          console.warn(`[WebRTC] Error adding screen audio track for ${session.peerSessionId}:`, err);
        }
      }
      if (!isCurrent()) throw new DOMException('Screen audio was cancelled', 'AbortError');
      await this.applyBitrateConstraints();
    } else {
      // Remove screen audio track from all peers
      for (const session of this.peers.values()) {
        if (session.screenAudioSender) {
          const sender = session.screenAudioSender;
          try {
            await this.waitForStable(session.pc);
            if (!this.isCurrentPeer(session) || this.localScreenAudioTrack
              || session.screenAudioSender !== sender) continue;
            session.pc.removeTrack(sender);
            session.pc.getTransceivers().find(entry => entry.sender === sender)?.stop();
            session.screenAudioSender = null;
            await this.sendOffer(session);
          } catch (err) {
            console.warn(`[WebRTC] Error removing screen audio track for ${session.peerSessionId}:`, err);
          }
        }
      }
    }
  }

  private async publishSfuScreenAudio(track: MediaStreamTrack): ReturnType<SfuClientEngine['produceScreenAudio']> {
    const pending = this.sfuScreenAudioPublication;
    if (pending?.track === track && pending.epoch === this.sfuJoinEpoch) return pending.task;
    const publication = {
      track, epoch: this.sfuJoinEpoch, task: this.sfuEngine.produceScreenAudio(track, 'default'),
    };
    this.sfuScreenAudioPublication = publication;
    try {
      return await publication.task;
    } finally {
      if (this.sfuScreenAudioPublication === publication) this.sfuScreenAudioPublication = null;
    }
  }

  private cameraTransceiver(session: PeerSession): RTCRtpTransceiver | undefined {
    return session.pc.getTransceivers().find((transceiver) =>
      (transceiver.receiver.track.kind === 'video' || transceiver.sender.track?.kind === 'video')
      && !this.isScreenVideoSender(session, transceiver.sender));
  }

  private async updateVideoTrackAcrossPeers(track: MediaStreamTrack | null, ensureCurrent: () => void): Promise<void> {
    for (const session of this.peers.values()) {
      ensureCurrent();
      if (session.botPeer || session.pc.connectionState === 'closed') continue;
      try {
        const videoTransceiver = this.cameraTransceiver(session);
        let negotiate = false;
        if (videoTransceiver) {
          const direction = track ? 'sendrecv' : 'recvonly';
          negotiate = videoTransceiver.direction !== direction;
          videoTransceiver.direction = direction;
          session.videoSender = videoTransceiver.sender;
          if (videoTransceiver.sender.track !== track) await videoTransceiver.sender.replaceTrack(track);
        } else if (track) {
          session.videoSender = session.pc.addTrack(track, new MediaStream([track]));
          negotiate = true;
        }
        ensureCurrent();
        if (negotiate) {
          if (!await this.waitForStable(session.pc)) throw new Error('Camera negotiation did not become ready');
          ensureCurrent();
          if (!this.isCurrentPeer(session)) continue;
          await this.sendOffer(session, false, true);
        }
      } catch (err) {
        if (!this.isCurrentPeer(session)) continue;
        console.warn(`[WebRTC] Error updating video track for peer ${session.peerSessionId}:`, err);
        throw err;
      }
    }
  }

  public setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    this.mediaRouter.setDeafened(deafened);
    void this.nativeScreens.updateAudio().catch(error => this.nativeScreens.report(error));
  }

  public setScreenAudioMuted(peerSessionId: string, muted: boolean): void {
    voiceStore.setScreenAudioMuted(peerSessionId, muted);
    this.applyScreenAudioMute(peerSessionId);
  }

  public async setSpeakerDeviceId(deviceId: string): Promise<void> {
    await this.mediaRouter.setSpeakerDeviceId(deviceId);
    await this.nativeScreens.setOutputDeviceId(deviceId);
  }

  public async setOutputDeviceIds(voiceDeviceId: string, screenDeviceId: string): Promise<void> {
    await this.mediaRouter.setOutputDeviceIds(voiceDeviceId, screenDeviceId);
    await this.nativeScreens.setOutputDeviceId(screenDeviceId);
  }

  private getQualityProfile(): QualityProfile {
    return { ...(this.currentPreset === 'CUSTOM' ? settingsStore.customProfile
      : QUALITY_PRESETS[this.currentPreset] || QUALITY_PRESETS.NORMAL) };
  }

  private async applyBitrateConstraints(): Promise<void> {
    const revision = ++this.qualityRevision;
    const preset = this.currentPreset;
    const profile = this.getQualityProfile();
    for (const session of this.peers.values()) {
      for (const sender of session.pc.getSenders()) {
        if (revision !== this.qualityRevision) return;
        if (!sender.track) continue;
        const kind = sender.track.kind === 'audio' ? 'audio'
          : this.isLocalScreenTrack(sender.track) ? 'screen' : 'camera';
        const policy = getMediaEncodingPolicy(kind, preset, profile);
        try {
          await updateRtpSenderParameters(sender, params =>
            revision === this.qualityRevision && this.isCurrentPeer(session) && !!sender.track
            && applyMediaEncodingPolicy(params, policy));
        } catch (error) {
          if (this.isCurrentPeer(session) && sender.track?.readyState === 'live') {
            clientLog.warn('WEBRTC', 'Could not apply sender quality parameters', {
              peer: session.peerSessionId, error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    if (revision === this.qualityRevision && this.isSfuMode()) {
      await this.sfuEngine.applyQualityParams(preset, profile);
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
    this.assertScreenSharingSettings(this.getQualityProfile());
    const previous = this.codecUpdateTask;
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const sfu = this.isSfuMode();
    const isCurrent = () => voiceStore.currentVoiceChannelId === channelId
      && voiceStore.voiceSessionKey === sessionKey && this.isSfuMode() === sfu && !this.voiceReconnectSuspended;
    const task = (async () => {
      if (previous) await previous;
      if (!isCurrent()) return;
      if (sfu) await this.restoreSfuScreenShares(isCurrent);
      else await this.reapplyP2PCodecPreferences();
    })();
    const settled = task.then(() => {}, () => {});
    this.codecUpdateTask = settled;
    try {
      await task;
    } finally {
      if (this.codecUpdateTask === settled) this.codecUpdateTask = null;
    }
  }

  private async restoreSfuScreenShares(isCurrent: () => boolean): Promise<void> {
    for (const [shareId, share] of [...this.localScreenShares]) {
      if (!isCurrent()) return;
      // Startup owns its publication and already follows changes to the selected codec.
      if (share.pending || this.localScreenShares.get(shareId) !== share || share.track.readyState !== 'live') continue;
      const preferred = settingsStore.preferredVideoCodec;
      try {
        await this.publishSfuScreenShare(shareId, share, isCurrent);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') continue;
        if (!isCurrent() || this.localScreenShares.get(shareId) !== share
          || settingsStore.preferredVideoCodec !== preferred) continue;
        await this.failLocalScreenShare(shareId, error, !share.pending);
      }
    }
  }

  private async publishSfuScreenShare(
    shareId: string,
    share: LocalScreenShare,
    isContextCurrent: () => boolean,
  ): Promise<PreferredVideoCodec> {
    const isCurrent = () => isContextCurrent() && this.isSfuMode()
      && this.localScreenShares.get(shareId) === share && share.track.readyState === 'live';
    while (isCurrent()) {
      const preferred = settingsStore.preferredVideoCodec;
      try {
        await this.sfuEngine.produceScreenVideo(share.track, shareId);
      } catch (error) {
        if (isCurrent() && settingsStore.preferredVideoCodec !== preferred) continue;
        throw error;
      }
      if (isCurrent() && settingsStore.preferredVideoCodec === preferred) return preferred;
    }
    throw new DOMException('Screen share was cancelled', 'AbortError');
  }

  private async reapplyP2PCodecPreferences(): Promise<void> {
    for (const session of [...this.peers.values()]) {
      try {
        const stable = await this.waitForStable(session.pc);
        if (!this.isCurrentPeer(session)) continue;
        if (!stable) throw new Error(t('voiceReconnect.timeout'));
        if (this.localCameraTrack || this.localScreenShares.size > 0) {
          await this.sendOffer(session);
          const answered = await this.waitForStable(session.pc);
          if (!this.isCurrentPeer(session)) continue;
          if (!answered) throw new Error(t('voiceReconnect.timeout'));
          await this.checkSessionScreenCodecs(session);
        }
      } catch (err) {
        if (!this.isCurrentPeer(session)) continue;
        for (const shareId of [...session.screenVideoSenders.keys()]) await this.failLocalScreenShare(shareId, err);
      }
    }
  }

  public removePeer(peerSessionId: string, preserveWatchIntent = false): void {
    if (!preserveWatchIntent) voiceStore.retainScreenShares(peerSessionId, []);
    this.remoteScreenSubscriptions.delete(peerSessionId);
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
    if (session) {
      // Retire authority before stopping tracks: queued native callbacks must
      // never recreate playback for this session after a leave or replacement.
      this.peers.delete(peerSessionId);
      this.clearPeerTimers(session);
      session.pc.ontrack = null;
      session.pc.onicecandidate = null;
      session.pc.oniceconnectionstatechange = null;
      session.pc.onconnectionstatechange = null;
      for (const stream of [session.remoteStream, ...session.remoteScreenStreams.values()]) {
        for (const track of stream.getTracks()) {
          track.onended = null;
          track.onunmute = null;
        }
      }
    }
    this.mediaRouter.cleanupPeerMedia(peerSessionId, session);
    session?.pc.close();
  }

  public suspendForVoiceReconnect(preserveLocalTracks = false): void {
    this.closeAllPeers();
    this.voiceReconnectSuspended = true;
    if (preserveLocalTracks) return;
    this.localAudioTrack = null;
    this.localCameraTrack = null;
    this.localScreenAudioTrack = null;
    this.screenAudioStream = null;
    this.screenAudioStreamId = null;
    this.clearLocalScreenTracks();
  }

  public resumeAfterVoiceReconnect(): void {
    this.voiceReconnectSuspended = false;
    void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
  }

  public closeAllPeers(): void {
    void this.nativeScreens.close().catch(error => this.nativeScreens.report(error));
    this.cameraTrackRevision++;
    this.cameraTrackChange = null;
    this.sfuScreenAudioPublication = null;
    this.voiceReconnectSuspended = false;
    this.abandonSfuSession();
    this.resetSfuReconnect();
    const peerCount = this.peers.size;
    clientLog.info('WEBRTC', `Closing all peers (${peerCount} active)`);
    for (const [peerSessionId] of Array.from(this.peers.entries())) {
      this.removePeer(peerSessionId, true);
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
    this.remoteScreenSubscriptions.clear();

    this.mediaRouter.closeAllMedia();
    this.vadMonitor.cleanupAll();
  }
}

export const webRtcManager = new WebRtcManager();
