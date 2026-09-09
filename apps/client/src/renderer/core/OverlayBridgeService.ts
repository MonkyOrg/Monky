import type {
  OverlayConfig,
  OverlayParticipantState,
  OverlaySyncState,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { participantManager, ParticipantViewModel } from './ParticipantManager';
import { serverStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { videoService } from './VideoService';
import { getAvatarUrl } from '../utils/avatar';
import { applyVideoCodecPreferences } from './webrtc/codecPreferences';

const MAX_VIDEO_SLOTS = 8;

function sidOf(p: ParticipantViewModel): string {
  return p.user.sessionId || p.user.id;
}

export class OverlayBridgeService {
  private isOpen = false;
  private isWebRtcReady = false;
  private localPeerConnection: RTCPeerConnection | null = null;
  private videoSenders: RTCRtpSender[] = [];
  private dummyTrack: MediaStreamTrack | null = null;
  private currentAssignedTracks: Array<string | null> = new Array(MAX_VIDEO_SLOTS).fill(null);
  private unbindListeners: Array<() => void> = [];
  private lastActiveSpeakerSessionId: string | null = null;
  private syncThrottleTimer: number | null = null;
  private isStageVisible = false;
  private isWindowFocused = true;
  private wasAutoOpened = false;
  private userManuallyClosed = false;

  public init(): void {
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
      window.api.onOverlaySignalReceived(async (signalJson) => {
        if (!this.isOpen || !this.localPeerConnection) return;
        try {
          const signal = JSON.parse(signalJson);
          if (signal.type === 'ready') {
            await this.sendOffer();
          } else if (signal.type === 'answer') {
            await this.localPeerConnection.setRemoteDescription(new RTCSessionDescription(signal));
            this.isWebRtcReady = true;
            this.currentAssignedTracks = new Array(MAX_VIDEO_SLOTS).fill(null);
            this.syncState();
          }
        } catch (e) {
          console.warn('[OverlayBridge] Erro ao processar sinal de resposta:', e);
        }
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

  private initLocalPeerConnection(): void {
    this.teardownLocalPeerConnection();

    try {
      this.localPeerConnection = new RTCPeerConnection({ iceServers: [] });
      this.isWebRtcReady = false;
      this.videoSenders = [];
      this.currentAssignedTracks = new Array(MAX_VIDEO_SLOTS).fill(null);

      const dummyTrack = this.getOrCreateDummyTrack();

      // Cria N transceivers de vídeo inicializados com dummyTrack para negociar codecs e canais de mídia válidos.
      // A offer é enviada quando o overlay emitir o sinal 'ready'.
      for (let i = 0; i < MAX_VIDEO_SLOTS; i++) {
        const dummyStream = new MediaStream([dummyTrack]);
        const transceiver = this.localPeerConnection.addTransceiver(dummyTrack, {
          direction: 'sendonly',
          streams: [dummyStream],
        });
        this.videoSenders.push(transceiver.sender);
      }
      applyVideoCodecPreferences(this.localPeerConnection);
    } catch (e) {
      console.warn('[OverlayBridge] Falha ao inicializar RTCPeerConnection:', e);
    }
  }

  /**
   * Cria a offer SDP com candidatos ICE embutidos e envia ao overlay.
   * Só deve ser chamado quando o overlay já estiver pronto (sinal 'ready').
   */
  private async sendOffer(): Promise<void> {
    if (!this.localPeerConnection) return;

    try {
      applyVideoCodecPreferences(this.localPeerConnection);
      const offer = await this.localPeerConnection.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false,
      });
      await this.localPeerConnection.setLocalDescription(offer);

      // Aguarda colheita completa dos candidatos host no localhost
      await new Promise<void>((resolve) => {
        if (this.localPeerConnection?.iceGatheringState === 'complete') {
          resolve();
        } else {
          const handler = () => {
            if (this.localPeerConnection?.iceGatheringState === 'complete') {
              this.localPeerConnection?.removeEventListener('icegatheringstatechange', handler);
              resolve();
            }
          };
          this.localPeerConnection?.addEventListener('icegatheringstatechange', handler);
          setTimeout(resolve, 300);
        }
      });

      const completeOffer = this.localPeerConnection.localDescription || offer;
      if (window.api?.sendOverlaySignal) {
        await window.api.sendOverlaySignal({
          target: 'overlay',
          signal: JSON.stringify(completeOffer),
        });
      }
    } catch (e) {
      console.warn('[OverlayBridge] Falha ao enviar offer:', e);
    }
  }

  private teardownLocalPeerConnection(): void {
    if (this.localPeerConnection) {
      try {
        this.localPeerConnection.close();
      } catch {}
      this.localPeerConnection = null;
    }
    this.isWebRtcReady = false;
    this.videoSenders = [];
    this.currentAssignedTracks = new Array(MAX_VIDEO_SLOTS).fill(null);
  }

  public syncState(): void {
    if (!this.isOpen || !window.api?.sendOverlaySyncState) return;

    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId || !serverStore.serverDetails) return;

    const channel = serverStore.serverDetails.channels.find((c) => c.id === channelId);
    const channelName = channel ? channel.name : 'Voz';

    const participants = participantManager.getInVoiceChannel(channelId);
    const currentSessionId = serverStore.currentUser?.sessionId || serverStore.currentUser?.id;
    const config = settingsStore.getOverlayConfig();

    // "Hide me" keeps the local user out of the overlay entirely, so they don't
    // waste a slot (and screen space) watching themselves (#169).
    const visibleParticipants = config.hideSelf
      ? participants.filter((p) => sidOf(p) !== currentSessionId)
      : participants;

    // Detectar orador ativo
    let currentSpeakerSessionId: string | null = null;
    for (const p of visibleParticipants) {
      const isLocal = sidOf(p) === currentSessionId;
      const isSpeaking = isLocal ? voiceStore.isSpeaking : p.isSpeaking;
      if (isSpeaking) {
        currentSpeakerSessionId = sidOf(p);
        this.lastActiveSpeakerSessionId = currentSpeakerSessionId;
        break;
      }
    }

    if (!currentSpeakerSessionId && this.lastActiveSpeakerSessionId) {
      const exists = visibleParticipants.some((p) => sidOf(p) === this.lastActiveSpeakerSessionId);
      if (exists) {
        currentSpeakerSessionId = this.lastActiveSpeakerSessionId;
      }
    }

    if (!currentSpeakerSessionId && visibleParticipants.length > 0) {
      currentSpeakerSessionId = sidOf(visibleParticipants[0]);
    }

    let nextSlotIndex = 0;
    const nextAssignedTracks: Array<string | null> = new Array(MAX_VIDEO_SLOTS).fill(null);

    const participantStates: OverlayParticipantState[] = visibleParticipants.map((p) => {
      const isLocal = sidOf(p) === currentSessionId;
      const isCamOn = isLocal ? voiceStore.isCameraOn : (p.voiceState?.isCameraOn ?? false);
      const isSpeaking = isLocal ? voiceStore.isSpeaking : p.isSpeaking;
      const isMuted = isLocal ? voiceStore.getEffectiveMuted() : (p.voiceState?.isMuted ?? false);
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

      // No modo minimalista, vídeo é desnecessário
      if (!config.minimalistMode) {
        // Atribuir slot para Câmera
        if (isCamOn && nextSlotIndex < MAX_VIDEO_SLOTS) {
          const stream = isLocal ? videoService.getCameraStream() : p.remoteStream;
          const videoTrack = stream?.getVideoTracks()[0] || null;
          if (videoTrack && videoTrack.readyState === 'live') {
            videoSlotIndex = nextSlotIndex;
            nextAssignedTracks[nextSlotIndex] = videoTrack.id;

            if (this.isWebRtcReady && this.videoSenders[nextSlotIndex]) {
              const currentSenderTrack = this.videoSenders[nextSlotIndex].track;
              if (!currentSenderTrack || currentSenderTrack.id !== videoTrack.id || this.currentAssignedTracks[nextSlotIndex] !== videoTrack.id) {
                this.videoSenders[nextSlotIndex].replaceTrack(videoTrack).catch((err) => {
                  console.error(`[OverlayBridge] replaceTrack FAILED slot=${nextSlotIndex}:`, err);
                });
              }
            }
            nextSlotIndex++;
          }
        }

        // Atribuir slot para Compartilhamento de Telas (se habilitado)
        if (config.mode === 'cameras-and-screens') {
          for (const shareId of shareIds) {
            if (nextSlotIndex < MAX_VIDEO_SLOTS) {
              const stream = isLocal
                ? videoService.getScreenStream(shareId)
                : (shareId === 'legacy'
                    ? p.remoteScreenStreams.values().next().value
                    : p.remoteScreenStreams.get(shareId));
              const videoTrack = stream?.getVideoTracks()[0] || null;
              if (videoTrack && videoTrack.readyState === 'live') {
                screenSlotIndexes[shareId] = nextSlotIndex;
                nextAssignedTracks[nextSlotIndex] = videoTrack.id;

                if (this.isWebRtcReady && this.videoSenders[nextSlotIndex]) {
                  const currentSenderTrack = this.videoSenders[nextSlotIndex].track;
                  if (!currentSenderTrack || currentSenderTrack.id !== videoTrack.id || this.currentAssignedTracks[nextSlotIndex] !== videoTrack.id) {
                    this.videoSenders[nextSlotIndex].replaceTrack(videoTrack).catch(() => {});
                  }
                }
                nextSlotIndex++;
              }
            }
          }
        }
      }

      return {
        sessionId: sidOf(p),
        userId: p.user.id,
        displayName: participantManager.displayName(p),
        avatarUrl: getAvatarUrl(p.user.avatarUrl),
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
      };
    });

    // Limpa slots não utilizados trocando de volta para a dummyTrack
    if (this.isWebRtcReady) {
      const dummyTrack = this.getOrCreateDummyTrack();
      for (let i = nextSlotIndex; i < MAX_VIDEO_SLOTS; i++) {
        if (this.videoSenders[i]) {
          const currentSenderTrack = this.videoSenders[i].track;
          if (currentSenderTrack?.id !== dummyTrack.id) {
            this.videoSenders[i].replaceTrack(dummyTrack).catch(() => {});
          }
        }
        nextAssignedTracks[i] = null;
      }
    }

    this.currentAssignedTracks = nextAssignedTracks;

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
