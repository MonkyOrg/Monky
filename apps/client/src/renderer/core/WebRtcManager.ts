import {
  IceServerConfig,
  MessageType,
  nativeScreenFailureReason,
  QUALITY_PRESETS,
  QualityPresetType,
  QualityProfile,
  screenViewersResultSchema,
  WebRtcSignalPayload,
  type NativeScreenCapabilities,
  type NativeScreenSource,
  type NativeScreenPreviewState,
  type NativeScreenCaptureKind,
  type NativeScreenCaptureMode,
  type VoiceStateUpdatePayload,
} from '@monky/shared';
import { appEvents } from './EventBus';
import type { NetworkClient } from './NetworkClient';
import type { ParticipantManager } from './ParticipantManager';
import { callServerOrClosed, captureCall } from './callScope';
import { currentEventOrigin, emitOutsideRouting } from './sessionRouting';
import { clientLog } from './ClientLogService';
import { settingsStore } from '../stores/settingsStore';
import type { ServerStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';
import { videoService } from './VideoService';
import { RemoteMediaRouter } from './webrtc/RemoteMediaRouter';
import { RemoteMediaSink } from './webrtc/RemoteMediaSink';
import { RemoteVadMonitor } from './webrtc/RemoteVadMonitor';
import { P2pMeshTransport } from './webrtc/p2p/P2pMeshTransport';
import { SfuCallSession } from './webrtc/sfu/SfuCallSession';
import type { VoiceTransport } from './webrtc/VoiceTransport';
import { t } from '../i18n';
import {
  NativeScreenController, nativeScreenProfile, type NativeScreenCallContext, type NativeScreenWatchState,
  type ScreenVideoDiagnostics, type NativeScreenSourceWarning,
} from './webrtc/NativeScreenController';
import { overlayBridgeService } from './OverlayBridgeService';
import { effectiveAudioOutput, registerAudioOutputConsumer } from './audioOutputRouting';

/**
 * The call's media, for every view and service: a facade over the transport
 * the call runs on — the P2P mesh (P2pMeshTransport) or the SFU — and over the
 * remote media sink and the native screens. The views keep one API whichever
 * transport carries the call.
 */
export class WebRtcManager {
  /**
   * How often the call's links are measured. One `getStats()` per link feeds
   * both the relay indicator (#466) and the ping the stage and the sidebar
   * show — before, each view polled every peer on its own (R-VOICEUI-7).
   */
  private static readonly CALL_STATS_INTERVAL_MS = 2000;

  private p2p: P2pMeshTransport;
  private sfu: SfuCallSession;
  private mediaRouter: RemoteMediaRouter;
  private vadMonitor: RemoteVadMonitor;
  private remoteMedia: RemoteMediaSink;
  private nativeScreens: NativeScreenController;

  /** Timer of the call-wide link measurement, running while the call has links. */
  private callStatsTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped on teardown so a measurement still awaiting stats is discarded. */
  private callStatsEpoch = 0;
  private callStatsSampling = false;
  /** Last measured ping of the call, shared by every view that shows it. */
  private callPing: number | null = null;
  private localAudioTrack: MediaStreamTrack | null = null;
  private localCameraTrack: MediaStreamTrack | null = null;
  private cameraTrackRevision = 0;
  private cameraTrackChange: { track: MediaStreamTrack | null; task: Promise<void> } | null = null;
  private currentPreset: QualityPresetType = settingsStore.qualityPreset;
  private qualityRevision = 0;
  private currentSessionId: string = '';
  private isDeafened: boolean = false;
  private isMigratingVoiceMode: boolean = false;
  /**
   * Transport the current call actually runs on, decided when the call starts
   * or migrates and cleared when it ends. `isSfuMode()` only says what the
   * server is configured for (R-VOICE-3).
   */
  private activeTransport: 'p2p' | 'sfu' | null = null;
  private voiceReconnectSuspended = false;

  /** ICE servers advertised by the server we just signed in to (#425); see P2pMeshTransport. */
  public setIceServers(iceServers: IceServerConfig[] | undefined): void {
    this.p2p.setIceServers(iceServers);
  }

  constructor() {
    this.mediaRouter = new RemoteMediaRouter(() => this.voiceParticipants);
    this.vadMonitor = new RemoteVadMonitor(
      () => this.voiceParticipants,
      peerSessionId => this.mediaRouter.getVoiceAudioLevel(peerSessionId),
    );
    this.remoteMedia = new RemoteMediaSink(
      () => this.voiceParticipants, this.mediaRouter, this.vadMonitor,
      peerSessionId => this.isOwnOtherDevice(peerSessionId),
      deviceId => this.nativeScreens.setOutputDeviceId(deviceId),
    );
    this.p2p = new P2pMeshTransport({
      client: () => this.signalClient,
      participants: () => this.voiceParticipants,
      selfSessionId: () => this.currentSessionId,
      channelId: () => voiceStore.currentVoiceChannelId,
      isPeerInCall: peerSessionId => this.isPeerInOurCall(peerSessionId),
      microphone: () => this.localAudioTrack,
      camera: () => this.localCameraTrack,
      media: this.remoteMedia,
      applyQuality: () => { void this.applyBitrateConstraints(); },
      linkConnected: () => this.startCallStats(),
      reconnect: (peerSessionId, initiator) => this.connectToPeer(peerSessionId, initiator),
      removePeer: peerSessionId => this.removePeer(peerSessionId),
    });
    this.sfu = new SfuCallSession({
      client: () => this.signalClient,
      selfSessionId: () => this.currentSessionId,
      isSfuMode: () => this.isSfuMode(),
      isSuspended: () => this.voiceReconnectSuspended,
      participants: () => this.voiceParticipants,
      microphone: () => this.localAudioTrack,
      camera: () => this.localCameraTrack,
      media: this.remoteMedia,
      rosterChanged: () => this.reconcileScreenSources(),
      microphoneEnded: track => this.dropEndedMicrophone(track),
      cameraFailed: (track, error) => this.dropFailedCamera(track, error),
      applyQuality: () => this.applyBitrateConstraints(),
      mediaFlowing: () => this.startCallStats(),
    });
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
   * going to the right server no matter what is on screen; a call whose server
   * session is gone sends nothing at all (R-VOICE-8).
   */
  private get signalClient(): NetworkClient {
    return callServerOrClosed().client;
  }

  /** Participants of the server hosting the call — see `signalClient` (#400). */
  private get voiceParticipants(): ParticipantManager {
    return callServerOrClosed().participants;
  }

  /** State of the server hosting the call — see `signalClient` (#400). */
  private get voiceServerStore(): ServerStore {
    return callServerOrClosed().serverStore;
  }

  private nativeScreenContext(): NativeScreenCallContext | null {
    const call = captureCall();
    const channelId = call.channelId;
    if (!channelId || !call.server || this.voiceReconnectSuspended) return null;
    const { client, participants, serverStore: store } = call.server;
    const sessionId = store.currentUser?.sessionId ?? this.currentSessionId;
    if (!sessionId || client.getStatus() !== 'CONNECTED') return null;
    const connectionId = client.getConnectionId();
    const mode = this.isSfuMode() ? 'sfu' : 'p2p';
    const isCurrent = () => call.isCurrent() && !this.voiceReconnectSuspended && client.getStatus() === 'CONNECTED'
      && client.getConnectionId() === connectionId && this.isSfuMode() === (mode === 'sfu')
      && (store.currentUser?.sessionId ?? this.currentSessionId) === sessionId;
    return { client, participants, channelId, sessionId, mode, isCurrent,
      announceSources: () => { if (isCurrent()) client.send(MessageType.VOICE_STATE_UPDATE, this.getLocalScreenState()); } };
  }

  public getLocalScreenState(): VoiceStateUpdatePayload {
    const screenShareIds = [...voiceStore.screenShareIds];
    const nativeScreenShares = videoService.getNativeScreenCaptures()
      .map(capture => voiceStore.permissionMuted ? { ...capture.source, audio: false } : capture.source)
      .filter(source => screenShareIds.includes(source.shareId));
    return { screenShareIds, nativeScreenShares, isScreenSharing: voiceStore.isScreenSharing,
      isSharingScreenAudio: !voiceStore.permissionMuted && nativeScreenShares.some(source => source.audio) };
  }

  public getNativeScreenCapabilities(): Promise<NativeScreenCapabilities> {
    return this.nativeScreens.capabilities();
  }

  public async getScreenViewers(publisherSessionId: string, shareId: string): Promise<string[]> {
    const context = this.nativeScreenContext();
    const getSource = () => this.voiceParticipants.get(publisherSessionId)?.voiceState;
    const state = getSource();
    const sourceInstanceId = state?.nativeScreenShares?.find(source => source.shareId === shareId)?.instanceId ?? null;
    if (!context || state?.channelId !== context.channelId || !state.screenShareIds?.includes(shareId))
      throw new DOMException('The screen share was retired.', 'AbortError');
    const result = screenViewersResultSchema.parse(await context.client.sendRequest<unknown>(
      MessageType.SCREEN_VIEWERS_GET,
      { channelId: context.channelId, publisherSessionId, shareId, sourceInstanceId },
    ));
    const current = getSource();
    if (!context.isCurrent() || current?.channelId !== context.channelId || !current.screenShareIds?.includes(shareId)
      || (current.nativeScreenShares?.find(source => source.shareId === shareId)?.instanceId ?? null) !== sourceInstanceId)
      throw new DOMException('The screen share was replaced.', 'AbortError');
    if (result.publisherSessionId !== publisherSessionId || result.channelId !== context.channelId
      || result.shareId !== shareId || result.sourceInstanceId !== sourceInstanceId)
      throw new Error('Screen viewers response belongs to another source.');
    return result.viewerSessionIds;
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

  public getLocalScreenSourceWarning(shareId: string): NativeScreenSourceWarning | null {
    return this.nativeScreens.getLocalSourceWarning(shareId);
  }

  public getScreenCaptureMode(sessionId: string, shareId: string): NativeScreenCaptureMode | null {
    return this.nativeScreens.getCaptureMode(sessionId, shareId);
  }

  public async startNativeScreenShare(
    desktopSourceId: string, audio: boolean, isWanted: () => boolean,
    captureKind: NativeScreenCaptureKind = 'window',
    preserveAspectRatio = true,
    audioReplacement?: { shareIds: readonly string[]; retirePrevious: () => Promise<void> },
    audience?: NativeScreenSource['audience'],
  ): Promise<MediaStream> {
    if (this.voiceReconnectSuspended) throw new Error(t('screenCodec.reconnecting'));
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
        shareId: stream.id, desktopSourceId, captureKind, preserveAspectRatio, video, audio, audience,
        audioBitrateKbps: profile.audioBitrateKbps,
        ...(audioReplacement?.shareIds.length ? { replacesAudioShareIds: audioReplacement.shareIds } : {}),
      });
      if (!isWanted()) throw new DOMException('Screen selection was cancelled.', 'AbortError');
      videoService.registerNativeScreenShare(stream, {
        source, desktopSourceId, captureKind, preserveAspectRatio, audioBitrateKbps: profile.audioBitrateKbps,
      });
      // Admission/preflight does not acquire PCM. Its former owners give up their
      // audio before preview demand can activate the replacement's selected capture.
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

  /** Keeps a local share on air without its audio, e.g. when a whole screen takes the sound over (#253). */
  public async withdrawScreenAudio(shareId: string): Promise<void> {
    await this.nativeScreens.withdrawAudio(shareId);
    voiceStore.removeScreenAudioShare(shareId);
  }

  // Resolves with the active native shares now using the profile, or null after a reported failure.
  public setQualityPreset(preset: QualityPresetType): Promise<number | null> {
    this.assertScreenSharingSettings(preset === 'CUSTOM' ? settingsStore.customProfile : QUALITY_PRESETS[preset]);
    this.currentPreset = preset;
    videoService.applyQualityPreset(preset).catch((err) => {
      clientLog.warn('WEBRTC', 'Error applying quality preset to videoService', { error: String(err) });
    });
    this.applyBitrateConstraints();
    return this.nativeScreens.applyQuality(this.getQualityProfile()).catch(error => {
      this.nativeScreens.report(error);
      // The same reasons the native runtime reports, so the notice has a message the user can read.
      appEvents.emit('native_screen.source_failed', { reason: nativeScreenFailureReason(error) });
      return null;
    });
  }

  public assertScreenSharingSettings(profile: QualityProfile, codec = settingsStore.preferredScreenCodec): void {
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

    appEvents.on('voice.screen_watch_changed', () => {
      this.updateScreenAudio();
      void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
    });
    appEvents.on('voice.screen_quality_changed', () => {
      void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
    });
    appEvents.on('voice.screen_audio_mute_changed', () => {
      this.updateScreenAudio();
    });
  }

  /**
   * Moves a P2P call onto the SFU once its server switches to SFU.
   *
   * The decision reads the transport the call actually runs on. An SFU call
   * that is still joining, or that sits between two rungs of its rejoin ladder,
   * has no ready engine either; read as "not on the SFU", that state got
   * "migrated" whenever an admin changed any server setting: every peer, screen
   * and camera was torn down and the backoff started over (R-VOICE-3).
   *
   * SFU -> P2P has a server-authorized leave/rejoin lifecycle instead, never a
   * hot swap of transports whose old membership has already been evicted.
   */
  public async handleVoiceModeUpdate(): Promise<void> {
    const call = captureCall();
    const channelId = call.channelId;
    if (!channelId || this.voiceReconnectSuspended || this.activeTransport !== 'p2p' || !this.isSfuMode()) return;
    const isCurrent = () => call.isCurrent() && this.isSfuMode();

    if (this.isMigratingVoiceMode) {
      console.log('[WebRTC] Voice mode migration already in flight, skipping duplicate call.');
      return;
    }

    this.isMigratingVoiceMode = true;
    console.log('[WebRTC] Dynamic voice mode transition starting: P2P -> SFU. Migrating active call...');
    clientLog.info('WEBRTC', 'Dynamic voice mode transition starting: P2P -> SFU');

    try {
      // 1. Cleanly tear down previous session connections and media router elements
      this.closeAllPeers();
      // The call stays admitted: it keeps being measured on its new transport.
      this.activeTransport = 'sfu';
      this.startCallStats();

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

      // 4. Join the SFU room
      await this.initSfuForCurrentChannel();

      // 5. Notify UI of the mode switch
      if (isCurrent()) appEvents.emit('voice.mode_switched', { mode: 'sfu' });
      console.log('[WebRTC] Dynamic voice mode transition completed: P2P -> SFU');
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
      sfuReconnectAttempts: this.sfu.reconnectAttempts,
      channelId: voiceStore.currentVoiceChannelId,
      isSfuReady: this.sfu.engine.isReady(),
      isSfuConnected: this.sfu.engine.isChannelConnected(),
      connectedP2pPeers: this.p2p.peerIds(),
      localAudioTrackId: this.localAudioTrack?.id,
    };
  }

  /** Joins the call's SFU room, unless a session or its rejoin ladder already owns it. */
  public initSfuForCurrentChannel(): Promise<void> {
    return this.sfu.ensureJoined();
  }

  /** The transport the call's server runs: every operation both transports have goes through it. */
  private transport(): VoiceTransport {
    return this.isSfuMode() ? this.sfu : this.p2p;
  }

  /**
   * Keeps the call going listen-only when its microphone track ended under it.
   *
   * A rejoin cannot revive a capture track, so treating this as a broken link
   * made every rung publish the same dead track and fail again, dropping all
   * the call's audio each time (R-VOICE-12). The user is told instead; picking
   * an input device then publishes a fresh microphone.
   */
  private dropEndedMicrophone(track: MediaStreamTrack): void {
    if (this.localAudioTrack !== track) return;
    this.localAudioTrack = null;
    clientLog.warn('AUDIO', 'The microphone track ended during the call; continuing listen-only');
    const error = t('voiceJoin.noAudioTrack');
    emitOutsideRouting(() => appEvents.emit('voice.microphone_failed', { error }));
  }

  /** A camera the call still wanted could not be published when the SFU room was joined. */
  private dropFailedCamera(track: MediaStreamTrack, error: unknown): void {
    if (this.localCameraTrack !== track) return;
    this.localCameraTrack = null;
    videoService.stopCamera();
    appEvents.emit('camera.publication_failed', error);
  }

  /**
   * Screen audio plays through the native screen owner, which mutes it for the
   * user's own mute or deafen. Writing the playback state anywhere else races it.
   */
  private updateScreenAudio(): void {
    void this.nativeScreens.updateAudio().catch(error => this.nativeScreens.report(error));
  }

  public setRemoteScreenWatching(peerSessionId: string, shareId: string, watching: boolean): void {
    if (watching && (!this.isPeerInOurCall(peerSessionId) || peerSessionId === this.currentSessionId
      || !this.voiceParticipants.get(peerSessionId)?.voiceState?.screenShareIds?.includes(shareId))) return;
    voiceStore.setScreenWatching(peerSessionId, shareId, watching);
  }

  /** Source discovery is voice metadata, independent of whether RTP is flowing. */
  public reconcileScreenSources(): void {
    const channelId = voiceStore.currentVoiceChannelId;
    voiceStore.reconcileScreenShares(new Map(channelId
      ? this.voiceParticipants.getInVoiceChannel(channelId).flatMap(participant => {
        const state = participant.voiceState;
        return state?.sessionId && state.sessionId !== this.currentSessionId
          ? [[state.sessionId, state.screenShareIds ?? []] as const] : [];
      })
      : []));
    void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
  }

  /**
   * Measures the call now and keeps measuring it until the call ends: the ping
   * every view shows and, on P2P, each peer's relay indicator (#466).
   *
   * It runs from admission, not from the first connected link. The stage and
   * the sidebar only re-evaluate the ping when a sample arrives, so a call
   * whose links are still connecting, or never connect behind a NAT without
   * TURN (#426), has to keep publishing its empty samples; otherwise the
   * views keep showing the moment the caller was alone. Idempotent.
   */
  private startCallStats(): void {
    if (!this.callStatsTimer) {
      this.callStatsTimer = setInterval(() => { void this.sampleCallStats(); }, WebRtcManager.CALL_STATS_INTERVAL_MS);
    }
    void this.sampleCallStats();
  }

  private stopCallStats(): void {
    if (this.callStatsTimer) clearInterval(this.callStatsTimer);
    this.callStatsTimer = null;
    this.callStatsEpoch++;
    this.callStatsSampling = false;
    if (this.callPing !== null) this.publishCallPing(null);
  }

  /**
   * One measurement of the whole call, shared by the stage and the sidebar.
   * P2P averages the peers it is connected to; the SFU reports the worse of
   * its two transports, which lead to the same server.
   */
  private async sampleCallStats(): Promise<void> {
    if (this.callStatsSampling) return;
    const epoch = this.callStatsEpoch;
    this.callStatsSampling = true;
    try {
      const sfu = (this.activeTransport ?? (this.isSfuMode() ? 'sfu' : 'p2p')) === 'sfu';
      const ping = await (sfu ? this.sfu : this.p2p).samplePing();
      if (epoch === this.callStatsEpoch) this.publishCallPing(ping);
    } finally {
      if (epoch === this.callStatsEpoch) this.callStatsSampling = false;
    }
  }

  private publishCallPing(ping: number | null): void {
    this.callPing = ping;
    emitOutsideRouting(() => appEvents.emit('voice.ping_updated', ping));
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
   * Another device of our own in the same call. We still link up with it so its
   * camera works — only the microphone is dropped, since playing it would feed
   * the speakers of one device into the microphone of the other (#309).
   */
  private isOwnOtherDevice(peerSessionId: string): boolean {
    const myUserId = this.voiceServerStore.currentUser?.id;
    if (!myUserId || peerSessionId === this.currentSessionId) return false;
    return this.voiceParticipants.get(peerSessionId)?.user.id === myUserId;
  }

  public syncBotVoiceReception(peerSessionId: string): void {
    this.p2p.syncBotVoiceReception(peerSessionId);
  }

  public async connectToPeer(peerSessionId: string, isInitiator: boolean): Promise<void> {
    if (this.voiceReconnectSuspended) return;
    await this.transport().addParticipant(peerSessionId, isInitiator);
  }

  private async handleIncomingSignal(payload: WebRtcSignalPayload): Promise<void> {
    if (this.voiceReconnectSuspended || this.isSfuMode()) return;
    await this.p2p.handleSignal(payload);
  }

  /** Initial recovery and raw fallback; normal switches retain the processed track. */
  public async replaceMicrophoneTrack(track: MediaStreamTrack, signal: AbortSignal): Promise<() => Promise<void>> {
    const previous = this.localAudioTrack;
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const sfuEpoch = this.sfu.joinEpoch;
    const sameSession = () => voiceStore.currentVoiceChannelId === channelId &&
      voiceStore.voiceSessionKey === sessionKey && this.sfu.joinEpoch === sfuEpoch;
    const ensureCurrent = () => {
      if (this.voiceReconnectSuspended || signal.aborted || !sameSession() || this.localAudioTrack !== previous) {
        throw new DOMException('Microphone replacement was cancelled', 'AbortError');
      }
    };
    ensureCurrent();
    const restorePublication = await this.transport().replaceMicrophone({ track, previous, ensureCurrent, sameSession });
    this.localAudioTrack = track;
    return async () => {
      // Publication and graph commit are separate awaits; cancellation can land between them.
      if (this.localAudioTrack !== track) return;
      await restorePublication();
      if (sameSession() && this.localAudioTrack === track) this.localAudioTrack = previous;
    };
  }

  /** Publishes the SFU microphone that was withheld while Speak was denied. */
  public syncMicrophonePublication(): Promise<void> {
    return this.sfu.syncMicrophonePublication();
  }

  public async setLocalAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    this.localAudioTrack = track;
    if (this.voiceReconnectSuspended) return;
    await this.transport().setMicrophone(track);
  }

  public async setLocalCameraTrack(track: MediaStreamTrack | null, isCurrent: () => boolean = () => true): Promise<void> {
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const pending = this.cameraTrackChange;
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
        // A stop closes the SFU camera whatever the call runs on now: its
        // producer can outlive a re-admission or a change of transport.
        if (!track) this.sfu.closeCamera();
        if (this.voiceReconnectSuspended) return;
        const transport = this.transport();
        // On the SFU, closing it was the whole stop.
        if (!track && transport === this.sfu) return;
        await transport.setCamera(track, ensureCurrent);
        ensureCurrent();
      } catch (error) {
        if (revision === this.cameraTrackRevision) this.localCameraTrack = null;
        if (track) {
          await this.sfu.detachCamera(track);
          await this.p2p.detachCamera(track);
        }
        throw error;
      }
    };
    // Keep an old asynchronous replacement from winning after a newer effect/device.
    const task = (pending?.task ?? Promise.resolve()).then(apply, apply);
    const change = { track, task };
    this.cameraTrackChange = change;
    try {
      await task;
    } finally {
      if (this.cameraTrackChange === change) this.cameraTrackChange = null;
    }
  }

  public removeNativeScreenSource(shareId: string): Promise<void> {
    return this.nativeScreens.removeSource(shareId);
  }

  public setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    this.mediaRouter.setDeafened(deafened);
    void this.nativeScreens.updateAudio().catch(error => this.nativeScreens.report(error));
  }

  public setScreenAudioMuted(peerSessionId: string, muted: boolean): void {
    voiceStore.setScreenAudioMuted(peerSessionId, muted);
    this.updateScreenAudio();
  }

  /**
   * Output devices of voices and screen audio; see RemoteMediaSink.setOutputDevices.
   * Selections reach it through the output registry (audioOutputRouting.ts).
   */
  public async setOutputDeviceIds(voiceDeviceId: string, screenDeviceId: string): Promise<void> {
    await this.remoteMedia.setOutputDevices(voiceDeviceId, screenDeviceId);
  }

  private getQualityProfile(): QualityProfile {
    return { ...(this.currentPreset === 'CUSTOM' ? settingsStore.customProfile
      : QUALITY_PRESETS[this.currentPreset] || QUALITY_PRESETS.NORMAL) };
  }

  private async applyBitrateConstraints(): Promise<void> {
    const revision = ++this.qualityRevision;
    const preset = this.currentPreset;
    const profile = this.getQualityProfile();
    const isCurrent = () => revision === this.qualityRevision;
    await this.p2p.applyQuality(preset, profile, isCurrent);
    if (this.isSfuMode()) await this.sfu.applyQuality(preset, profile, isCurrent);
  }

  /**
   * The call's last measured ping in milliseconds, or null until one is
   * measured. Views read it on `voice.ping_updated` instead of each polling
   * every link (R-VOICEUI-7).
   */
  public getCallPing(): number | null {
    return this.callPing;
  }

  public getPeerConnection(peerSessionId: string): RTCPeerConnection | null {
    return this.p2p.getPeerConnection(peerSessionId);
  }

  /**
   * Every sender publishing the local camera — one per peer. Scoping
   * `getStats()` to them keeps the rest of the call out of the camera tile's
   * numbers (#493).
   */
  public getCameraSenders(): RTCRtpSender[] {
    return this.transport().cameraSenders();
  }

  /**
   * Receiver carrying a specific remote track, so the stage can read the camera's
   * inbound stats without picking up the rest of the peer's media (#340).
   */
  public getReceiverForTrack(peerSessionId: string, trackId: string): RTCRtpReceiver | null {
    return this.transport().receiverForTrack(peerSessionId, trackId);
  }

  public setPeerVolume(peerSessionId: string, volume: number): void {
    this.mediaRouter.setPeerVolume(peerSessionId, volume);
  }

  /** The person left the call: their link, their media and their indicators go. */
  public removePeer(peerSessionId: string, preserveWatchIntent = false): void {
    if (!preserveWatchIntent) voiceStore.retainScreenShares(peerSessionId, []);
    this.p2p.remove(peerSessionId);
    this.remoteMedia.peerGone(peerSessionId);
  }

  public suspendForVoiceReconnect(preserveLocalTracks = false): void {
    this.endCallMedia();
    this.voiceReconnectSuspended = true;
    if (preserveLocalTracks) return;
    this.localAudioTrack = null;
    this.localCameraTrack = null;
  }

  /** The call was admitted: media starts on the transport its server runs now. */
  public resumeAfterVoiceReconnect(): void {
    this.voiceReconnectSuspended = false;
    this.activeTransport = this.isSfuMode() ? 'sfu' : 'p2p';
    this.startCallStats();
    void this.nativeScreens.sync().catch(error => this.nativeScreens.report(error));
  }

  public async prepareForQuit(): Promise<void> {
    await this.nativeScreens.prepareShutdown();
  }

  /** Ends the call's media for good: leaving, being kicked, a new sign-in, or moving to the SFU. */
  public closeAllPeers(): void {
    this.endCallMedia();
    // Whatever was suspended belonged to the call that just ended.
    this.voiceReconnectSuspended = false;
  }

  private endCallMedia(): void {
    void this.nativeScreens.close().catch(error => this.nativeScreens.report(error));
    this.cameraTrackRevision++;
    this.cameraTrackChange = null;
    this.activeTransport = null;
    this.stopCallStats();
    this.sfu.close();
    const peerIds = this.p2p.peerIds();
    clientLog.info('WEBRTC', `Closing all peers (${peerIds.length} active)`);
    for (const peerSessionId of peerIds) this.removePeer(peerSessionId, true);
    this.p2p.closeAll();
    this.remoteMedia.closeAll();
  }
}

export const webRtcManager = new WebRtcManager();
// The call's voices and screens follow the voice and screen outputs.
registerAudioOutputConsumer(() =>
  webRtcManager.setOutputDeviceIds(effectiveAudioOutput('voice'), effectiveAudioOutput('screen')));
