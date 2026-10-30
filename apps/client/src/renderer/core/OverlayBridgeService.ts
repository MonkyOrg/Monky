import {
  getOverlayCardSize,
  overlaySignalSchema,
  type OverlayConfig,
  type OverlayParticipantState,
  type OverlaySignal,
  type OverlaySyncState,
  type NativeScreenCaptureMode,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { sessionManager } from './SessionManager';
import { participantManager, ParticipantViewModel } from './ParticipantManager';
import { serverStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { isParticipantSpeaking } from '../utils/voiceConnection';
import { videoService } from './VideoService';
import { resolveAvatarUrl } from '../utils/avatar';
import { networkClient } from './NetworkClient';
import { preferVideoCodec } from './webrtc/codecPreferences';
import { waitForIceGatheringComplete } from './webrtc/iceGathering';
import { updateRtpSenderParameters } from './webrtc/rtpSenderParameters';
import { overlayFrameRestriction, type FrameRestriction } from '../utils/overlayLayout';

const MAX_VIDEO_SLOTS = 8;
/** The cards are small: past 30 fps the overlay only adds encoder and decoder work. */
const OVERLAY_MAX_FRAMERATE = 30;
/** Loopback host candidates arrive at once; the offer never waits longer than this for them. */
const ICE_GATHERING_TIMEOUT_MS = 300;

function sidOf(p: ParticipantViewModel): string {
  return p.user.sessionId || p.user.id;
}

export class OverlayBridgeService {
  private isOpen = false;
  private isWebRtcReady = false;
  private localPeerConnection: RTCPeerConnection | null = null;
  /**
   * Names the current connection in every signal: the overlay pairs one
   * connection with each session, and answers to a replaced one are dropped.
   */
  private linkSession: string | null = null;
  private offeredSession: string | null = null;
  private videoSenders: RTCRtpSender[] = [];
  private pendingVideoUpdates = new WeakMap<RTCRtpSender, { track: MediaStreamTrack; task: Promise<void> }>();
  private appliedEncodings = new WeakMap<RTCRtpSender, string>();
  /** The overlay's own pixel ratio, reported with `scale`; until then, this window's. */
  private overlayPixelRatio: number | null = null;
  private retiredVideoTracks = new WeakSet<MediaStreamTrack>();
  private cameraSubscriptions: Array<() => void> = [];
  private dummyTrack: MediaStreamTrack | null = null;
  private unbindListeners: Array<() => void> = [];
  private lastActiveSpeakerSessionId: string | null = null;
  private syncThrottleTimer: number | null = null;
  private isStageVisible = false;
  private isWindowFocused = true;
  private wasAutoOpened = false;
  private userManuallyClosed = false;
  private captureModeFor: ((sessionId: string, shareId: string) => NativeScreenCaptureMode | null) | null = null;

  public init(captureModeFor: (sessionId: string, shareId: string) => NativeScreenCaptureMode | null): void {
    this.captureModeFor = captureModeFor;
    if (!window.api?.onOverlayStateChanged) return;

    this.unbindListeners.push(
      window.api.onOverlayStateChanged((isOpen) => {
        const wasOpen = this.isOpen;
        this.isOpen = isOpen;
        if (isOpen) {
          if (!wasOpen) {
            this.initLocalPeerConnection();
          }
          this.syncState();
        } else {
          this.teardownLocalPeerConnection();
        }
        appEvents.emit('overlay.state_changed', isOpen);
      })
    );

    this.unbindListeners.push(
      window.api.onOverlaySignalReceived((value) => {
        const signal = overlaySignalSchema.safeParse(value);
        if (!signal.success) {
          console.warn('[OverlayBridge] Ignoring an invalid overlay signal.');
          return;
        }
        void this.handleOverlaySignal(signal.data);
      })
    );

    this.unbindListeners.push(
      window.api.onOverlayConfigUpdated((config) => {
        settingsStore.setOverlayConfig(config);
      })
    );

    // Eventos do app para sincronizar estado em tempo real
    const triggerSync = () => {
      if (this.isOpen) {
        this.throttledSyncState();
      }
    };

    appEvents.on('voice.channel_changed', (channelId) => {
      if (!channelId) {
        if (this.isOpen) {
          this.close(true);
        }
      } else {
        this.userManuallyClosed = false;
        triggerSync();
        this.evaluateAutoOverlay();
      }
    });

    appEvents.on('stage.visibility_changed', (visible) => {
      this.isStageVisible = !!visible;
      this.userManuallyClosed = false;
      this.evaluateAutoOverlay();
    });

    const onFocus = () => {
      this.isWindowFocused = true;
      this.userManuallyClosed = false;
      this.evaluateAutoOverlay();
    };

    const onBlur = () => {
      this.isWindowFocused = false;
      this.userManuallyClosed = false;
      this.evaluateAutoOverlay();
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    this.unbindListeners.push(() => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    });

    appEvents.on('voice.state_updated', triggerSync);
    appEvents.on('voice.speaking_changed', triggerSync);
    appEvents.on('participants.updated', triggerSync);
    this.unbindListeners.push(appEvents.on('native_screen.updated', triggerSync));
    this.unbindListeners.push(appEvents.on('voice.screen_watch_changed', triggerSync));
    appEvents.on('participants.speaking_changed', triggerSync);
    appEvents.on('settings.updated', triggerSync);
    appEvents.on('overlay_settings.updated', () => {
      triggerSync();
      this.evaluateAutoOverlay();
    });

    window.api.isOverlayOpen().then((open) => {
      this.isOpen = open;
      if (open) {
        this.initLocalPeerConnection();
      }
    }).catch(() => {});
  }

  public evaluateAutoOverlay(): void {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId) return;

    const config = settingsStore.getOverlayConfig();
    if (!config.autoOpenOnLeaveStage) return;

    const isFocusedOnStage = this.isStageVisible && this.isWindowFocused;

    if (isFocusedOnStage) {
      // Usuário está com o Monky em foco no palco da chamada: fecha a sobreposição
      if (this.isOpen) {
        this.close(true);
      }
    } else {
      // Usuário saiu do palco (ex: chat) ou janela do Monky perdeu o foco/minimizou
      if (!this.isOpen && !this.userManuallyClosed) {
        this.wasAutoOpened = true;
        this.open(config);
      }
    }
  }

  public async open(config?: OverlayConfig): Promise<boolean> {
    if (!window.api?.openOverlay) return false;
    const targetConfig = config || settingsStore.getOverlayConfig();

    if (this.isOpen) {
      if (window.api.setOverlayConfig) {
        await window.api.setOverlayConfig(targetConfig);
      }
      this.syncState();
      return true;
    }

    const result = await window.api.openOverlay(targetConfig);
    if (result.success) {
      this.isOpen = true;
      this.userManuallyClosed = false;
      this.initLocalPeerConnection();
      this.syncState();
    }
    return result.success;
  }

  public async close(isAutomatic: boolean = false): Promise<boolean> {
    if (!isAutomatic) {
      this.userManuallyClosed = true;
    }
    this.wasAutoOpened = false;
    if (!window.api?.closeOverlay) return false;
    const result = await window.api.closeOverlay();
    this.isOpen = false;
    this.teardownLocalPeerConnection();
    return result.success;
  }

  public getIsOpen(): boolean {
    return this.isOpen;
  }

  /**
   * Whether the overlay is on as far as the user is concerned: either showing
   * right now, or armed to appear as soon as they leave the stage. Without the
   * second half the stage controls claim the overlay is off at the exact moment
   * "open on leaving the stage" keeps it hidden — while on the stage (#169).
   */
  public isActive(): boolean {
    return this.isOpen || !!settingsStore.getOverlayConfig().autoOpenOnLeaveStage;
  }

  /**
   * Turns the overlay off for good: closing an armed overlay would otherwise
   * pop right back up the moment the stage loses focus.
   */
  public async deactivate(): Promise<boolean> {
    if (settingsStore.getOverlayConfig().autoOpenOnLeaveStage) {
      settingsStore.setOverlayConfig({ autoOpenOnLeaveStage: false });
    }
    return this.close();
  }

  private throttledSyncState(): void {
    if (this.syncThrottleTimer !== null) return;
    this.syncThrottleTimer = window.setTimeout(() => {
      this.syncThrottleTimer = null;
      this.syncState();
    }, 50);
  }

  private updateVideoSender(index: number, track: MediaStreamTrack): void {
    const sender = this.videoSenders[index];
    const connection = this.localPeerConnection;
    if (!this.isWebRtcReady || !sender || !connection) return;
    const pending = this.pendingVideoUpdates.get(sender);
    if (pending?.track === track || (!pending && sender.track === track)) return;
    const apply = async () => {
      if (!this.isWebRtcReady || this.localPeerConnection !== connection || this.videoSenders[index] !== sender
        || this.pendingVideoUpdates.get(sender) !== update) return;
      await sender.replaceTrack(track.readyState === 'live' && !this.retiredVideoTracks.has(track) ? track : this.getOrCreateDummyTrack());
    };
    const task = (pending?.task ?? Promise.resolve()).then(apply, apply);
    const update = { track, task };
    this.pendingVideoUpdates.set(sender, update);
    const clear = () => {
      if (this.pendingVideoUpdates.get(sender) === update) this.pendingVideoUpdates.delete(sender);
    };
    void task.then(clear, (error: unknown) => {
      clear();
      if (this.localPeerConnection === connection) console.error(`[OverlayBridge] Could not replace video slot ${index}:`, error);
    });
  }

  public async retireScreenStream(stream: MediaStream): Promise<void> {
    const tracks = new Set<MediaStreamTrack>(stream.getVideoTracks());
    for (const track of tracks) this.retiredVideoTracks.add(track);
    const connection = this.localPeerConnection;
    await Promise.all(this.videoSenders.map(async sender => {
      const pending = this.pendingVideoUpdates.get(sender);
      if (pending && tracks.has(pending.track)) await pending.task;
      if (this.localPeerConnection === connection && sender.track && tracks.has(sender.track))
        await sender.replaceTrack(this.getOrCreateDummyTrack());
    }));
  }

  private getOrCreateDummyTrack(): MediaStreamTrack {
    if (this.dummyTrack && this.dummyTrack.readyState === 'live') {
      return this.dummyTrack;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#0e1117';
      ctx.fillRect(0, 0, 320, 240);
    }
    const stream = canvas.captureStream(5);
    this.dummyTrack = stream.getVideoTracks()[0];
    return this.dummyTrack;
  }

  /**
   * Caps one slot's frame at what its card can show, and at 30 fps: the link is
   * loopback, so nothing else would keep the encoder from sending every camera
   * and screen at full resolution only to have the overlay shrink it (R-MEDIA-2).
   */
  private applyVideoEncoding(index: number, restriction: FrameRestriction): void {
    const sender = this.videoSenders[index];
    const connection = this.localPeerConnection;
    if (!this.isWebRtcReady || !sender || !connection) return;
    const key = `${restriction.maxWidth}x${restriction.maxHeight}`;
    if (this.appliedEncodings.get(sender) === key) return;
    this.appliedEncodings.set(sender, key);
    updateRtpSenderParameters(sender, (parameters) => {
      const [encoding] = parameters.encodings;
      if (!encoding) return false;
      encoding.maxFramerate = OVERLAY_MAX_FRAMERATE;
      encoding.scaleResolutionDownTo = { ...restriction };
      return true;
    }).catch((error: unknown) => {
      if (this.appliedEncodings.get(sender) === key) this.appliedEncodings.delete(sender);
      if (this.localPeerConnection === connection) console.warn(`[OverlayBridge] Could not size video slot ${index}:`, error);
    });
  }

  private initLocalPeerConnection(): void {
    this.teardownLocalPeerConnection();
    const sync = () => this.throttledSyncState();
    this.cameraSubscriptions.push(
      appEvents.on('camera.state_changed', sync),
      appEvents.on('local.camera_replaced', sync),
    );

    try {
      const connection = new RTCPeerConnection({ iceServers: [] });
      this.localPeerConnection = connection;
      this.isWebRtcReady = false;
      this.videoSenders = [];

      const dummyTrack = this.getOrCreateDummyTrack();

      // Cria N transceivers de vídeo inicializados com dummyTrack para negociar codecs e canais de mídia válidos.
      // A offer é enviada quando o overlay emitir o sinal 'ready'.
      for (let i = 0; i < MAX_VIDEO_SLOTS; i++) {
        const dummyStream = new MediaStream([dummyTrack]);
        const transceiver = connection.addTransceiver(dummyTrack, {
          direction: 'sendonly',
          streams: [dummyStream],
        });
        this.videoSenders.push(transceiver.sender);
      }
      // Loopback: compression buys nothing, the encoder is the whole cost.
      preferVideoCodec(connection, 'video/VP8');
      const session = crypto.randomUUID();
      this.linkSession = session;
      this.offeredSession = null;
      // An overlay already on screen kept its connection to the one just
      // replaced (a reload of this window, or a second open): ask it to pair
      // again. A starting overlay announces itself instead (R-MEDIA-2).
      if (this.isOpen) void this.sendSignal({ kind: 'hello', session });
    } catch (e) {
      console.warn('[OverlayBridge] Falha ao inicializar RTCPeerConnection:', e);
    }
  }

  private sendSignal(signal: OverlaySignal): Promise<void> {
    if (!window.api?.sendOverlaySignal) return Promise.resolve();
    return window.api.sendOverlaySignal({ target: 'overlay', signal }).catch((error: unknown) => {
      console.warn(`[OverlayBridge] Could not send the overlay ${signal.kind}:`, error);
    });
  }

  private async handleOverlaySignal(signal: OverlaySignal): Promise<void> {
    const connection = this.localPeerConnection;
    const session = this.linkSession;
    if (!this.isOpen || !connection || !session) return;
    try {
      if (signal.kind === 'ready') {
        if (signal.session === null && this.offeredSession === session) {
          // An overlay that started over lost the connection it had answered.
          this.initLocalPeerConnection();
          return;
        }
        // A reply to an older hello, or a repeat for a connection already offered.
        if ((signal.session !== null && signal.session !== session) || this.offeredSession === session) return;
        this.offeredSession = session;
        await this.sendOffer(connection, session);
      } else if (signal.kind === 'answer') {
        if (signal.session !== session || connection.signalingState !== 'have-local-offer') return;
        await connection.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        if (this.localPeerConnection !== connection) return;
        this.isWebRtcReady = true;
        this.syncState();
      } else if (signal.kind === 'scale') {
        if (signal.session !== session || signal.pixelRatio === this.overlayPixelRatio) return;
        this.overlayPixelRatio = signal.pixelRatio;
        this.syncState();
      }
    } catch (e) {
      console.warn('[OverlayBridge] Erro ao processar sinal do overlay:', e);
    }
  }

  /** Offers the current connection, with its ICE candidates, to the overlay that said it is ready. */
  private async sendOffer(connection: RTCPeerConnection, session: string): Promise<void> {
    const offer = await connection.createOffer();
    if (this.localPeerConnection !== connection) return;
    await connection.setLocalDescription(offer);
    await waitForIceGatheringComplete(connection, ICE_GATHERING_TIMEOUT_MS);
    const sdp = connection.localDescription?.sdp ?? offer.sdp;
    if (this.localPeerConnection !== connection || !sdp) return;
    await this.sendSignal({ kind: 'offer', session, sdp });
  }

  private teardownLocalPeerConnection(): void {
    this.cameraSubscriptions.forEach((unsubscribe) => unsubscribe());
    this.cameraSubscriptions = [];
    if (this.localPeerConnection) {
      try {
        this.localPeerConnection.close();
      } catch {}
      this.localPeerConnection = null;
    }
    this.isWebRtcReady = false;
    this.linkSession = null;
    this.offeredSession = null;
    this.overlayPixelRatio = null;
    this.videoSenders = [];
    this.pendingVideoUpdates = new WeakMap();
    this.appliedEncodings = new WeakMap();
    this.dummyTrack?.stop();
    this.dummyTrack = null;
  }

  public syncState(): void {
    if (!this.isOpen || !window.api?.sendOverlaySyncState) return;

    const channelId = voiceStore.currentVoiceChannelId;
    const call = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
    const callStore = voiceStore.voiceSessionKey ? call?.serverStore : serverStore;
    const callParticipants = voiceStore.voiceSessionKey ? call?.participants : participantManager;
    // Avatar paths belong to the call's server, not to the one on screen.
    const callBaseUrl = (voiceStore.voiceSessionKey ? call?.client : networkClient)?.getHttpBaseUrl() ?? '';
    if (!channelId || !callStore?.serverDetails || !callParticipants) return;

    const channel = callStore.serverDetails.channels.find((c) => c.id === channelId);
    const channelName = channel ? channel.name : 'Voz';

    const participants = callParticipants.getInVoiceChannel(channelId);
    const currentSessionId = callStore.currentUser?.sessionId || callStore.currentUser?.id;
    const config = settingsStore.getOverlayConfig();

    // "Hide me" keeps the local user out of the overlay entirely, so they don't
    // waste a slot (and screen space) watching themselves (#169).
    const visibleParticipants = config.hideSelf
      ? participants.filter((p) => sidOf(p) !== currentSessionId)
      : participants;

    let nextSlotIndex = 0;
    // What a card can show is all a slot needs to send (R-MEDIA-2), in the overlay's device pixels.
    const card = getOverlayCardSize(config);
    const fit = config.preserveAspectRatio !== false ? 'contain' : 'cover';
    const pixelRatio = this.overlayPixelRatio ?? window.devicePixelRatio;
    const assignSlot = (track: MediaStreamTrack): number => {
      const index = nextSlotIndex++;
      this.updateVideoSender(index, track);
      this.applyVideoEncoding(index, overlayFrameRestriction(card, pixelRatio, fit, track.getSettings()));
      return index;
    };
    const participantStates: OverlayParticipantState[] = visibleParticipants.map((p) => {
      const isLocal = sidOf(p) === currentSessionId;
      const isCamOn = isLocal
        ? voiceStore.isCameraOn && videoService.getCameraState().status === 'ready'
        : (p.voiceState?.isCameraOn ?? false);
      const isSpeaking = isParticipantSpeaking(p, callStore);
      const isMuted = isLocal ? voiceStore.getEffectiveMuted() : ((p.voiceState?.isMuted ?? false) || (p.voiceState?.permissionMuted ?? false));
      const isDeafened = isLocal ? voiceStore.getEffectiveDeafened() : (p.voiceState?.isDeafened ?? false);
      const serverMuted = isLocal ? voiceStore.serverMuted : (p.voiceState?.serverMuted ?? false);
      const serverDeafened = isLocal ? voiceStore.serverDeafened : (p.voiceState?.serverDeafened ?? false);

      let shareIds: string[] = [];
      if (isLocal) {
        shareIds = [...voiceStore.screenShareIds];
      } else if (p.voiceState?.screenShareIds && p.voiceState.screenShareIds.length > 0) {
        shareIds = [...p.voiceState.screenShareIds];
      } else if (p.voiceState?.isScreenSharing) {
        shareIds = ['legacy'];
      }

      let videoSlotIndex: number | undefined;
      const screenSlotIndexes: Record<string, number> = {};
      const screenCaptureModes: Record<string, NativeScreenCaptureMode> = {};

      // No modo minimalista, vídeo é desnecessário
      if (!config.minimalistMode) {
        // Atribuir slot para Câmera
        if (isCamOn && nextSlotIndex < MAX_VIDEO_SLOTS) {
          const stream = isLocal ? videoService.getCameraState().stream : p.remoteStream;
          const videoTrack = stream?.getVideoTracks()[0] || null;
          if (videoTrack && videoTrack.readyState === 'live') {
            videoSlotIndex = assignSlot(videoTrack);
          }
        }

        // Atribuir slot para Compartilhamento de Telas (se habilitado)
        if (config.mode === 'cameras-and-screens') {
          for (const shareId of shareIds) {
            if (!isLocal && !voiceStore.isWatchingScreen(sidOf(p), shareId)) continue;
            if (nextSlotIndex < MAX_VIDEO_SLOTS) {
              const stream = isLocal
                ? videoService.getScreenStream(shareId)
                : (shareId === 'legacy'
                    ? p.remoteScreenStreams.values().next().value
                    : p.remoteScreenStreams.get(shareId));
              const videoTrack = stream?.getVideoTracks()[0] || null;
              if (videoTrack && videoTrack.readyState === 'live') {
                screenSlotIndexes[shareId] = assignSlot(videoTrack);
                const native = isLocal ? !!videoService.getNativeScreenCapture(shareId)
                  : p.voiceState?.nativeScreenShares?.some(source => source.shareId === shareId) === true;
                const captureMode = native ? this.captureModeFor?.(sidOf(p), shareId) : 'normal';
                if (captureMode) screenCaptureModes[shareId] = captureMode;
              }
            }
          }
        }
      }

      return {
        sessionId: sidOf(p),
        userId: p.user.id,
        displayName: callParticipants.displayName(p),
        avatarUrl: resolveAvatarUrl(p.user.avatarUrl, callBaseUrl),
        isSpeaking,
        isMuted,
        isDeafened,
        serverMuted,
        serverDeafened,
        isCameraOn: isCamOn,
        screenShareIds: shareIds,
        isLocal,
        videoSlotIndex,
        screenSlotIndexes,
        screenCaptureModes,
      };
    }).filter(p => !config.hideInactiveParticipants || p.isCameraOn
      || (config.mode === 'cameras-and-screens' && p.screenShareIds.length > 0));

    const speaking = participantStates.find(p => p.isSpeaking);
    if (speaking) this.lastActiveSpeakerSessionId = speaking.sessionId;
    const currentSpeakerSessionId = speaking?.sessionId
      ?? participantStates.find(p => p.sessionId === this.lastActiveSpeakerSessionId)?.sessionId
      ?? participantStates[0]?.sessionId ?? null;

    // Limpa slots não utilizados trocando de volta para a dummyTrack
    if (this.isWebRtcReady) {
      const dummyTrack = this.getOrCreateDummyTrack();
      for (let i = nextSlotIndex; i < MAX_VIDEO_SLOTS; i++) {
        this.updateVideoSender(i, dummyTrack);
      }
    }

    const syncState: OverlaySyncState = {
      channelId,
      channelName,
      participants: participantStates,
      activeSpeakerSessionId: currentSpeakerSessionId,
      config,
    };

    window.api.sendOverlaySyncState(syncState).catch(() => {});
  }
}

export const overlayBridgeService = new OverlayBridgeService();
