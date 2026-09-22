import { MessageType, getScreenShareQualities, screenShareQualitySchema, type BotScreen, type NativeScreenSource } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { networkClient } from '../core/NetworkClient';
import { callClient, leaveCurrentCall } from '../core/serverConnection';
import { participantManager, ParticipantViewModel } from '../core/ParticipantManager';
import { screenAudioService } from '../core/ScreenAudioService';
import { stopLocalScreenShares } from '../core/screenShareControls';
import { getActiveServerStore, serverStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore, VoiceStore } from '../stores/voiceStore';
import { audioProcessor } from '../core/AudioProcessor';
import { videoService } from '../core/VideoService';
import { webRtcManager } from '../core/WebRtcManager';
import { soundEffects } from '../core/SoundEffects';
import { getAvatarUrl } from '../utils/avatar';
import { peerFailureTooltip } from '../utils/peerFailureHint';
import { isParticipantSpeaking, participantConnectionIndicators, voiceConnectionIndicator } from '../utils/voiceConnection';
import { getVoiceControlModeration, isViewingCallServer, toggleAudioDeafen, toggleMicrophoneMute } from '../core/voiceControls';
import { renderAudioMuteIndicators, renderAudioStateIcon, updateAudioStateIcon } from './AudioStateIcon';
import { bindStageControlsMotion } from './FooterControlsMotion';
import { showAlert, showConfirm } from './Dialog';
import { userContextMenu } from './UserContextMenu';
import { setButtonLoading, isButtonLoading } from '../utils/buttonLoading';
import { soundboardModal } from './SoundboardModal';
import { overlayConfigModal } from './OverlayConfigModal';
import { overlayBridgeService } from '../core/OverlayBridgeService';
import { VideoDiagnosticsSampler } from '../core/webrtc/videoDiagnostics';
import { NativeDecoderDiagnosticsSampler } from '../core/webrtc/nativeDecoderDiagnostics';
import { formatVideoTelemetry, serializeVideoTelemetry, VideoTelemetrySnapshot } from './VideoTelemetry';
import { showCopyToast } from './CopyToast';
import { t } from '../i18n';
import { reportCameraError, setLocalCameraState } from '../core/CameraPublication';
import { isCameraOperationCancelled } from '../utils/cameraEffects';
import { getBotVoiceContext, type BotVoiceContext } from '../utils/botVoice';
import { replaceAroundLiveChild } from '../utils/preserveLiveChild';
import { BotScreenView } from './BotScreenView';
import type { VoiceBotScreensUpdated } from '../stores/botScreenStore';
import { showInfoToast } from './CopyToast';

/**
 * A single renderable tile on the stage. A participant contributes one tile per
 * active media source, so someone sharing camera + screen at once shows up as
 * two independent tiles (#26). Participants with no video get a single 'voice'
 * (avatar) tile.
 */
interface ParticipantStageTile {
  p: ParticipantViewModel;
  kind: 'voice' | 'camera' | 'screen';
  key: string; // `${sessionId}:${kind}` (+ `:${shareId}` for screens) — stable identity for focus/DOM keys
  /** Which screen share this tile renders, for 'screen' tiles only (#253). */
  shareId?: string;
}
type StageTile = ParticipantStageTile | { kind: 'miniapp'; key: string; screen: BotScreen };

/** Tiles address a connection rather than a person: someone may join twice (#309). */
function sidOf(p: ParticipantViewModel): string {
  return p.user.sessionId || p.user.id;
}

/**
 * Share id used for peers that only announce the legacy `isScreenSharing`
 * boolean (clients older than #253). They can only ever have one share, so a
 * fixed key is enough to give their tile a stable identity.
 */
const LEGACY_SHARE_ID = 'legacy';

/**
 * Share ids come from other clients and are interpolated into DOM ids and data
 * attributes, so only MediaStream-shaped ids are accepted. Anything else is
 * treated as a hostile payload and ignored.
 */
const SAFE_SHARE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * How many tiles can sit in the focus area at once (#253). Two side-by-side
 * panes stay readable on a normal screen; beyond that the grid is the better
 * layout anyway.
 */
const MAX_FOCUSED_TILES = 2;

/** Zoom bounds for the focused screen share (#271). */
const FOCUS_ZOOM_MAX_SCALE = 4;
const FOCUS_ZOOM_STEP = 0.25;
const MAX_TELEMETRY_SAMPLES = 20;

export class VoiceStageView {
  private container: HTMLElement;
  private currentChannelId: string | null = null;
  private unbindEvents: Array<() => void> = [];
  private focusedTileKeys: string[] = [];
  private focusEpoch = 0;
  private focusError: HTMLElement | null = null;
  private readonly seenScreenStarts = new WeakSet<MediaStream>();
  private readonly pendingScreenFocus = new Map<string, { tileKey: string; isCurrent: () => boolean }>();
  /** Zoom/pan state of the focused screen share, reset when focus changes (#271). */
  private focusZoom = { scale: 1, x: 0, y: 0 };
  private focusZoomTileKey: string | null = null;
  private suppressCardClickUntil = 0;
  private pingInterval: any = null;
  private telemetryInterval: number | null = null;
  private telemetryEpoch = 0;
  private telemetryRefreshInFlight = false;
  private telemetrySnapshots = new Map<string, VideoTelemetrySnapshot>();
  private telemetryHistory = new Map<string, VideoTelemetrySnapshot[]>();
  private telemetrySampler = new VideoDiagnosticsSampler();
  private nativeDecoderSampler = new NativeDecoderDiagnosticsSampler();
  private nativeTelemetryTargets = new Map<string, object>();
  private telemetryEndpoints = new Map<object, number>();
  private nextTelemetryEndpoint = 1;
  private telemetryCopyRequest = 0;
  private clearTelemetryToast: (() => void) | null = null;
  private unbindTelemetryButtons: Array<() => void> = [];
  private videoLoadingListeners = new WeakMap<HTMLVideoElement, () => void>();
  // Caches the current live-banner content so updateControlsUI() only rebuilds
  // it when the broadcast state actually changes, preventing the pulse dot from
  // flickering on frequent voice.state_updated events (#70).
  private broadcastBannerSignature: string | null = null;
  private cameraToggleEpoch = 0;
  private cameraTogglePending = false;
  private botScreens = new Map<string, BotScreenView>();
  private botVoiceContext: BotVoiceContext | null = null;
  private botScreenLayoutObserver: ResizeObserver | null = null;
  private clearMiniappToast: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public setChannel(channelId: string | null): void {
    if (channelId === this.currentChannelId && this.container.querySelector('.voice-stage-container')) {
      this.refreshBotScreens();
      return;
    }
    this.focusEpoch++;
    this.pendingScreenFocus.clear();
    this.clearFocusError();
    this.closeBotScreens();
    if (channelId !== this.currentChannelId) this.stopTelemetryMonitor();
    this.currentChannelId = channelId;
    this.focusedTileKeys = [];
    if (!channelId) {
      this.stopTelemetryMonitor();
    }
    this.render();
  }

  public hasOpenBotScreen(): boolean { return [...this.botScreens.values()].some((view) => view.isWatching); }

  public isWatchingBotScreen(id: string): boolean { return this.botScreens.get(id)?.isWatching ?? false; }

  public watchBotScreen(id: string, focus = false): void {
    this.refreshBotScreens();
    const view = this.botScreens.get(id);
    if (!view) return;
    const open = () => {
      if (this.botScreens.get(id) !== view) return;
      try {
        view.open();
        if (view.isWatching) this.botVoiceContext?.session.botScreenStore.setInvitationDismissed(id, false);
        this.positionBotScreens();
        appEvents.emit('stage.bot_screens_changed');
      } catch (error: unknown) {
        console.warn('[Voice stage] Could not open the miniapp.', error);
        void showAlert({ title: t('common.error'), message: t('botScreen.openError'), variant: 'danger' });
      }
    };
    if (focus) this.setFocusedTiles([`miniapp:${id}`], { afterRender: open });
    else open();
  }

  private closeBotScreen(id: string): void {
    const view = this.botScreens.get(id);
    if (!view?.isWatching) return;
    this.botVoiceContext?.session.botScreenStore.setInvitationDismissed(id, true);
    view.leave();
    this.positionBotScreens();
    appEvents.emit('stage.bot_screens_changed');
  }

  private closeBotScreens(): void {
    this.clearMiniappToast?.();
    this.clearMiniappToast = null;
    this.botScreenLayoutObserver?.disconnect();
    for (const view of this.botScreens.values()) view.destroy();
    const changed = this.botScreens.size > 0;
    this.botScreens.clear();
    this.botVoiceContext = null;
    this.focusedTileKeys = this.focusedTileKeys.filter((key) => !key.startsWith('miniapp:'));
    if (changed) appEvents.emit('stage.bot_screens_changed');
  }

  private notifyMiniappEnded({ key, removed }: VoiceBotScreensUpdated): void {
    if (removed?.reason !== 'ended') return;
    const context = getBotVoiceContext();
    const previous = this.botVoiceContext;
    const view = this.botScreens.get(removed.id);
    if (!context || !previous || context.session !== previous.session || context.session.key !== key ||
        context.user.sessionId !== previous.user.sessionId || context.channelId !== removed.channelId ||
        this.currentChannelId !== removed.channelId || context.session.serverStore !== getActiveServerStore() ||
        !view?.isWatching || view.isEnding || view.snapshot.instanceId !== removed.instanceId) return;
    this.clearMiniappToast?.();
    this.clearMiniappToast = showInfoToast(t('botScreen.endedNotice', { title: view.snapshot.title }));
  }

  private refreshBotScreens(): void {
    const context = getBotVoiceContext();
    const previous = this.botVoiceContext;
    if (!context || context.channelId !== this.currentChannelId ||
        context.session.serverStore !== getActiveServerStore()) {
      this.closeBotScreens();
      return;
    }
    if (previous && (context.session !== previous.session || context.channelId !== previous.channelId ||
        context.user.sessionId !== previous.user.sessionId)) this.closeBotScreens();
    const host = this.container.querySelector<HTMLElement>('#stage-bot-screens');
    if (!host) return;
    this.botVoiceContext = context;
    const screens = context.session.botScreenStore.list(context.channelId);
    for (const [id, view] of this.botScreens) {
      if (!screens.some((screen) => screen.id === id && screen.instanceId === view.snapshot.instanceId)) {
        view.destroy();
        this.botScreens.delete(id);
        this.focusedTileKeys = this.focusedTileKeys.filter((key) => key !== `miniapp:${id}`);
      }
    }
    for (const screen of screens) {
      let view = this.botScreens.get(screen.id);
      if (!view) {
        view = new BotScreenView(screen, context,
          () => this.watchBotScreen(screen.id),
          () => this.closeBotScreen(screen.id),
          () => {
            const key = `miniapp:${screen.id}`;
            if (this.focusedTileKeys.includes(key)) this.setFocusedTiles([]);
            else this.toggleFocus(key);
          });
        this.botScreens.set(screen.id, view);
      } else view.update(screen);
      if (view.element.parentElement !== host) host.append(view.element);
    }
    host.hidden = this.botScreens.size === 0;
  }

  private syncBotScreenLayout(): void {
    const area = this.container.querySelector<HTMLElement>('#stage-content-area');
    if (!area) return;
    for (const [id, view] of this.botScreens) {
      view.setLayout(this.focusedTileKeys.includes(`miniapp:${id}`),
        this.focusedTileKeys.length > 0 && !this.focusedTileKeys.includes(`miniapp:${id}`));
    }
    this.botScreenLayoutObserver?.disconnect();
    if (this.botScreens.size > 0) {
      this.botScreenLayoutObserver ??= new ResizeObserver(() => this.positionBotScreens());
      this.botScreenLayoutObserver.observe(area);
      for (const slot of area.querySelectorAll('[data-bot-screen-slot]')) this.botScreenLayoutObserver.observe(slot);
    }
    this.positionBotScreens();
  }

  private positionBotScreens(): void {
    const area = this.container.querySelector<HTMLElement>('#stage-content-area');
    if (!area) return;
    const bounds = area.getBoundingClientRect();
    for (const [id, view] of this.botScreens) {
      if (document.fullscreenElement === view.element) {
        Object.assign(view.element.style, { left: '0', top: '0', width: '100vw', height: '100vh', clipPath: 'none' });
        continue;
      }
      const slot = area.querySelector<HTMLElement>(`[data-bot-screen-slot="${CSS.escape(id)}"]`);
      if (!slot) { view.element.hidden = true; continue; }
      const rect = slot.getBoundingClientRect();
      const viewport = (slot.closest('.stage-focused-strip, .stage-grid') ?? area).getBoundingClientRect();
      const top = Math.max(bounds.top, viewport.top);
      const right = Math.min(bounds.right, viewport.right);
      const bottom = Math.min(bounds.bottom, viewport.bottom);
      const left = Math.max(bounds.left, viewport.left);
      view.element.hidden = rect.width === 0 || rect.height === 0 || rect.right <= left ||
        rect.left >= right || rect.bottom <= top || rect.top >= bottom;
      // Grid/focus/filmstrip own the slots. Anchoring the live views here avoids
      // reparenting an iframe, which destroys its browsing context in Chromium.
      Object.assign(view.element.style, {
        left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
        clipPath: `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)`,
      });
    }
  }

  /**
   * Opts into a remote screen share from outside the stage (#282). Clicking the
   * sidebar notice is itself the explicit consent required by #150, so the
   * broadcast starts unblurred and focused. Must run after the stage DOM exists
   * (i.e. after `setChannel`), since it re-renders the participant tiles.
   */
  public watchScreenShare(sessionId: string): void {
    if (!isViewingCallServer() || this.currentChannelId !== voiceStore.currentVoiceChannelId) return;
    const participant = participantManager
      .getInVoiceChannel(this.currentChannelId ?? '')
      .find((p) => sidOf(p) === sessionId);
    if (!participant) return;

    // The notice covers the participant, not a specific share, so opt into all
    // of their shares and focus the first one (#253).
    const shareIds = this.getShareIds(participant, false);
    if (shareIds.length === 0) return;

    this.setFocusedTiles([`${sessionId}:screen:${shareIds[0]}`], { beforeRender: () => {
      for (const shareId of shareIds) {
        webRtcManager.setRemoteScreenWatching(sessionId, shareId, true);
      }
    } });
  }

  public render(): void {
    this.releaseStageVideos(this.container);
    if (this.focusError) this.focusError.textContent = t('stage.fullscreenExitError');
    this.stopPingMonitor();
    this.stopTelemetryMonitor();
    this.unbindListeners();

    if (!this.currentChannelId || !serverStore.serverDetails) {
      this.pendingScreenFocus.clear();
      this.closeBotScreens();
      this.container.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); gap: 12px;">
          <span class="material-symbols-outlined md-36" style="color: var(--text-dim); font-size: 48px;">volume_up</span>
          <div style="font-size: 16px; font-weight: 600; color: var(--text-secondary);">${t('stage.noChannelTitle')}</div>
          <div style="font-size: 13px;">${t('stage.noChannelSubtitle')}</div>
        </div>
      `;
      return;
    }

    const channel = serverStore.serverDetails.channels.find((c) => c.id === this.currentChannelId);
    const channelName = channel ? channel.name : 'Geral';

    // Fresh DOM below means the (empty) banner wrapper must be repopulated by
    // updateControlsUI(), so drop the cached signature (#70).
    this.broadcastBannerSignature = null;
    const markup = `
      <div class="voice-stage-container">
        <div class="content-header">
          <div class="channel-title-container">
            <span class="material-symbols-outlined" style="color: var(--success); font-size: 20px;">volume_up</span>
            <span class="channel-title">${escapeHtml(channelName)}</span>
          </div>

          <div style="display: flex; align-items: center; gap: 10px;">
            <!-- Ping / Latency Badge -->
            <div id="stage-ping-badge" class="stage-ping-badge good" tabindex="0" data-tooltip-source="ping-tooltip-content">
              <span class="ping-dot"></span>
              <span id="stage-ping-text">-- ms</span>
              <div id="ping-tooltip-content" hidden>${t('stage.pingCalculating')}</div>
            </div>

            <div id="stage-header-mode-badge-wrapper">
              ${
                webRtcManager.isSfuMode()
                  ? `<div class="header-status-badge sfu-mode-badge" style="background-color: rgba(88, 101, 242, 0.15); color: var(--accent-primary); display: flex; align-items: center; gap: 6px;" title="${t('stage.sfuModeTooltip')}">
                       <span class="material-symbols-outlined md-14">hub</span>
                       <span>${t('stage.connectedSfu')}</span>
                     </div>`
                  : `<div class="header-status-badge p2p-mode-badge" style="background-color: rgba(35, 165, 90, 0.15); color: var(--success); display: flex; align-items: center; gap: 6px;" title="${t('stage.p2pModeTooltip')}">
                       <span class="material-symbols-outlined md-14">wifi_tethering</span>
                       <span>${t('stage.connectedMesh')}</span>
                     </div>`
              }
            </div>
          </div>
        </div>

        <!-- Live Broadcast Top Banner Container -->
        <div id="stage-broadcast-banner-wrapper" style="display: none;"></div>

        <!-- Participants Container (Grid or Focused) -->
        <div id="stage-content-area">
          <div id="stage-participants-area"></div>
          <div id="stage-bot-screens" class="stage-bot-screen-layer" hidden></div>
        </div>

        <!-- Stage Bottom Controls Bar -->
        <div class="stage-call-controls">
          <button id="stage-btn-mic" class="btn btn-icon ${voiceStore.isMuted || voiceStore.isDeafened ? 'danger-active' : ''}" aria-pressed="${voiceStore.isMuted}" title="${voiceStore.isMuted ? t('stage.unmuteMic') : t('stage.muteMic')}">
            ${renderAudioStateIcon('mic', false, 24)}
          </button>
          <button id="stage-btn-deafen" class="btn btn-icon ${voiceStore.isDeafened ? 'danger-active' : ''}" aria-pressed="${voiceStore.isDeafened}" title="${voiceStore.isDeafened ? t('stage.undeafen') : t('stage.deafen')}">
            ${renderAudioStateIcon('headphones', false, 24)}
          </button>
          <button id="stage-btn-camera" class="btn btn-icon ${voiceStore.isCameraOn ? 'broadcasting-pulse active' : ''}" title="${voiceStore.isCameraOn ? t('stage.cameraOff') : t('stage.cameraOn')}">
            <span class="material-symbols-outlined">${voiceStore.isCameraOn ? 'videocam_off' : 'videocam'}</span>
          </button>
          <button id="stage-btn-screen" class="btn btn-icon ${voiceStore.isScreenSharing ? 'broadcasting-pulse active' : ''}" title="${voiceStore.isScreenSharing ? t('stage.stopScreenShare') : t('main.shareScreen')}">
            <span class="material-symbols-outlined">${voiceStore.isScreenSharing ? 'stop_screen_share' : 'screen_share'}</span>
            <span class="material-symbols-outlined screen-audio-badge" style="font-size: 12px; position: absolute; bottom: 2px; right: 2px; color: var(--success);" hidden>volume_up</span>
          </button>
          <button id="stage-btn-overlay" class="btn btn-icon ${overlayBridgeService.isActive() ? 'broadcasting-pulse active' : ''}" title="${t('overlay.openOverlay')}">
            <span class="material-symbols-outlined">picture_in_picture_alt</span>
          </button>
          <button id="stage-btn-soundboard" class="btn btn-icon" title="${t('main.openSoundboard')}">
            <span class="material-symbols-outlined">music_note</span>
          </button>
          <button id="stage-btn-stop-share" class="btn btn-danger" style="display: ${voiceStore.isScreenSharing ? 'inline-flex' : 'none'}; margin-left: 12px; padding: 0 16px; height: 38px;" title="${t('stage.stopScreenShare')}">
            <span class="material-symbols-outlined md-18" style="margin-right: 4px;">stop_screen_share</span>
            <span>${t('screenShare.stopSharing')}</span>
          </button>
          <button id="stage-btn-leave" class="btn btn-danger" style="margin-left: 12px; padding: 0 16px; height: 38px;" title="${t('stage.leaveChannel')}">
            <span class="material-symbols-outlined md-18" style="margin-right: 4px;">call_end</span>
            <span>${t('stage.leaveVoice')}</span>
          </button>
        </div>
      </div>
    `;
    if (!this.hasOpenBotScreen() ||
        !replaceAroundLiveChild(this.container, markup, '.voice-stage-container', '#stage-content-area')) {
      this.closeBotScreens();
      this.container.innerHTML = markup;
    }

    this.renderParticipants();
    this.updateControlsUI();
    this.attachEvents();
    this.startPingMonitor();
    this.syncTelemetryMonitor();
  }

  public updateControlsUI(): void {
    const moderation = getVoiceControlModeration();
    const btnMic = document.getElementById('stage-btn-mic');
    if (btnMic) {
      const muted = voiceStore.isMuted || voiceStore.isDeafened;
      btnMic.className = `btn btn-icon ${muted ? 'danger-active' : ''}`;
      const blocked = moderation.serverMuted || moderation.serverDeafened;
      btnMic.setAttribute('aria-pressed', String(voiceStore.isMuted));
      btnMic.title = [t(voiceStore.isMuted ? 'stage.unmuteMic' : 'stage.muteMic'), moderation.muteReason].filter(Boolean).join('. ');
      updateAudioStateIcon(btnMic, muted ? 'mic_off' : 'mic', blocked);
    }

    const btnDeafen = document.getElementById('stage-btn-deafen');
    if (btnDeafen) {
      btnDeafen.className = `btn btn-icon ${voiceStore.isDeafened ? 'danger-active' : ''}`;
      btnDeafen.setAttribute('aria-pressed', String(voiceStore.isDeafened));
      btnDeafen.title = [t(voiceStore.isDeafened ? 'stage.undeafen' : 'stage.deafen'), moderation.deafenReason].filter(Boolean).join('. ');
      updateAudioStateIcon(btnDeafen, voiceStore.isDeafened ? 'headset_off' : 'headphones', moderation.serverDeafened);
    }

    const btnCam = document.getElementById('stage-btn-camera');
    if (btnCam) {
      btnCam.className = `btn btn-icon ${voiceStore.isCameraOn ? 'broadcasting-pulse active' : ''}`;
      btnCam.title = voiceStore.isCameraOn ? t('stage.cameraOff') : t('stage.cameraOn');
      const icon = btnCam.querySelector(':scope > .material-symbols-outlined');
      const name = voiceStore.isCameraOn ? 'videocam_off' : 'videocam';
      if (icon && icon.textContent !== name) icon.textContent = name;
    }

    const btnScreen = document.getElementById('stage-btn-screen');
    if (btnScreen) {
      const hasScreenAudio = voiceStore.screenAudioShareId !== null || screenAudioService.getIsCapturing();
      btnScreen.className = `btn btn-icon ${voiceStore.isScreenSharing ? 'broadcasting-pulse active' : ''}`;
      btnScreen.title = voiceStore.isScreenSharing
        ? (hasScreenAudio ? t('stage.stopScreenShareWithAudio') : t('stage.stopScreenShare'))
        : t('main.shareScreen');
      const icon = btnScreen.querySelector(':scope > .material-symbols-outlined');
      const name = voiceStore.isScreenSharing ? 'stop_screen_share' : 'screen_share';
      if (icon && icon.textContent !== name) icon.textContent = name;
      const badge = btnScreen.querySelector<HTMLElement>('.screen-audio-badge');
      if (badge) badge.hidden = !hasScreenAudio;
    }

    const btnOverlay = document.getElementById('stage-btn-overlay');
    if (btnOverlay) {
      const isOverlayActive = overlayBridgeService.isActive();
      btnOverlay.className = `btn btn-icon ${isOverlayActive ? 'broadcasting-pulse active' : ''}`;
      btnOverlay.title = isOverlayActive ? t('overlay.overlayActive') : t('overlay.openOverlay');
    }

    const btnStopShare = document.getElementById('stage-btn-stop-share') as HTMLButtonElement | null;
    const btnLeave = document.getElementById('stage-btn-leave') as HTMLButtonElement | null;

    if (btnStopShare) {
      const hasScreenAudio = voiceStore.screenAudioShareId !== null || screenAudioService.getIsCapturing();
      btnStopShare.style.display = voiceStore.isScreenSharing ? 'inline-flex' : 'none';
      btnStopShare.title = hasScreenAudio ? t('stage.stopScreenShareWithAudio') : t('stage.stopScreenShare');
    }
    if (btnLeave) {
      btnLeave.style.marginLeft = '12px';
    }

    // Top broadcast banner
    const bannerWrapper = document.getElementById('stage-broadcast-banner-wrapper');
    if (bannerWrapper) {
      const isBroadcasting = voiceStore.isCameraOn || voiceStore.isScreenSharing;
      const hasScreenAudio = voiceStore.screenAudioShareId !== null || screenAudioService.getIsCapturing();
      // Only touch the DOM when the banner's content would actually change, so
      // the live-pulse animation isn't restarted on every state update (#70).
      const signature = isBroadcasting
        ? `${voiceStore.isScreenSharing ? 'screen' : 'cam'}:${hasScreenAudio ? 'audio' : 'noaudio'}`
        : 'off';
      if (signature !== this.broadcastBannerSignature) {
        this.broadcastBannerSignature = signature;
        if (isBroadcasting) {
          bannerWrapper.style.display = 'block';
          bannerWrapper.innerHTML = `
            <div class="stage-broadcast-banner">
              <div style="display: flex; align-items: center; gap: 10px;">
                <span class="live-pulse-dot"></span>
                <span style="font-weight: 600; font-size: 12px; color: #ffffff;">
                  ${voiceStore.isScreenSharing
                    ? (hasScreenAudio ? t('stage.bannerScreenWithAudio') : t('stage.bannerScreen'))
                    : t('stage.bannerCamera')}
                </span>
              </div>
              <button id="btn-stage-quick-stop" class="btn btn-secondary" style="font-size: 11px; padding: 4px 12px; height: 26px; border-color: rgba(242, 63, 67, 0.5); color: #ff7b72;">
                <span class="material-symbols-outlined md-14" style="margin-right: 4px;">stop_circle</span>
                ${voiceStore.isScreenSharing ? t('stage.stopScreen') : t('stage.cameraOff')}
              </button>
            </div>
          `;
          const btnQuickStop = document.getElementById('btn-stage-quick-stop');
          btnQuickStop?.addEventListener('click', () => this.handleStopStreaming());
        } else {
          bannerWrapper.style.display = 'none';
          bannerWrapper.innerHTML = '';
        }
      }
    }
  }

  private updateSpeakingClasses(): void {
    for (const card of this.container.querySelectorAll<HTMLElement>('[data-session-id][data-kind]')) {
      if (card.dataset.sessionId) this.setCardSpeaking(card.dataset.sessionId);
    }
  }

  private setCardSpeaking(sessionId: string): void {
    // Update every non-screen tile for the session (it may show a voice or
    // camera tile; the screen tile never pulses on speech — #26).
    const isSpeaking = this.currentChannelId === voiceStore.currentVoiceChannelId
      && isParticipantSpeaking(participantManager.get(sessionId));
    const cards = this.container.querySelectorAll(`[data-session-id="${CSS.escape(sessionId)}"]:is([data-kind="voice"], [data-kind="camera"])`);
    cards.forEach((card) => {
      if (isSpeaking) {
        card.classList.add('speaking');
      } else {
        card.classList.remove('speaking');
      }

    });
  }

  private releaseStageVideos(root: HTMLElement): void {
    for (const video of root.querySelectorAll<HTMLVideoElement>('video.stage-video-element')) {
      this.videoLoadingListeners.get(video)?.();
      video.pause();
      video.srcObject = null;
    }
  }

  /**
   * Expands the flat participant list into renderable tiles. Camera + screen
   * are independent, so a participant broadcasting both yields two tiles (#26);
   * a participant sharing two screens yields one tile per share (#253);
   * participants with no video yield a single avatar ('voice') tile.
   */
  private buildStageTiles(participants: ParticipantViewModel[], currentSessionId?: string): StageTile[] {
    const tiles: StageTile[] = [];
    for (const p of participants) {
      const isLocal = sidOf(p) === currentSessionId;
      const isCamOn = isLocal ? voiceStore.isCameraOn : (p.voiceState?.isCameraOn ?? false);
      const shareIds = this.getShareIds(p, isLocal);
      if (isCamOn) tiles.push({ p, kind: 'camera', key: `${sidOf(p)}:camera` });
      for (const shareId of shareIds) {
        tiles.push({ p, kind: 'screen', key: `${sidOf(p)}:screen:${shareId}`, shareId });
      }
      if (!isCamOn && shareIds.length === 0) tiles.push({ p, kind: 'voice', key: `${sidOf(p)}:voice` });
    }
    for (const [id, view] of this.botScreens) {
      tiles.push({ kind: 'miniapp', key: `miniapp:${id}`, screen: view.snapshot });
    }
    return tiles;
  }

  /**
   * Screen shares to render for a participant (#253). Falls back to a single
   * synthetic share when the peer only reports the legacy `isScreenSharing`
   * boolean, so older clients still show up as one tile.
   *
   * Share ids arrive from other clients and end up in DOM ids and attributes,
   * so anything that isn't a plain MediaStream-style id is dropped here — this
   * is the single choke point every tile goes through.
   */
  private getShareIds(p: ParticipantViewModel, isLocal: boolean): string[] {
    if (isLocal) return [...voiceStore.screenShareIds];
    const announced = p.voiceState?.screenShareIds;
    if (announced && announced.length > 0) {
      const safe = announced.filter((id) => SAFE_SHARE_ID.test(id));
      if (safe.length > 0) return safe.slice(0, VoiceStore.MAX_SCREEN_SHARES);
    }
    return p.voiceState?.isScreenSharing ? [LEGACY_SHARE_ID] : [];
  }

  /**
   * Focus toggle (#253). When any tile is already focused, clicking another
   * tile adds it to focus (multi-pane) instead of replacing. Clicking a
   * focused tile removes it. This makes multi-pane the natural default
   * without requiring Shift.
   */
  private toggleFocus(tileKey: string): void {
    const isFocused = this.focusedTileKeys.includes(tileKey);
    this.setFocusedTiles(isFocused
      ? this.focusedTileKeys.filter((key) => key !== tileKey)
      : [...this.focusedTileKeys, tileKey].slice(-MAX_FOCUSED_TILES));
  }

  private clearFocusError(): void {
    this.focusError?.remove();
    this.focusError = null;
  }

  private queueScreenStartFocus({ shareId, stream }: { shareId: string; stream: MediaStream }): void {
    if (!SAFE_SHARE_ID.test(shareId) || this.seenScreenStarts.has(stream)) return;
    this.seenScreenStarts.add(stream);
    const channelId = this.currentChannelId;
    const displayedServer = getActiveServerStore();
    const sessionId = displayedServer.currentUser?.sessionId || displayedServer.currentUser?.id;
    const voiceSessionKey = voiceStore.voiceSessionKey;
    if (!channelId || !sessionId || channelId !== voiceStore.currentVoiceChannelId || !isViewingCallServer()) return;
    this.pendingScreenFocus.set(shareId, {
      tileKey: `${sessionId}:screen:${shareId}`,
      isCurrent: () => this.currentChannelId === channelId && voiceStore.currentVoiceChannelId === channelId
        && voiceStore.voiceSessionKey === voiceSessionKey && getActiveServerStore() === displayedServer
        && (displayedServer.currentUser?.sessionId || displayedServer.currentUser?.id) === sessionId
        && videoService.getScreenStream(shareId) === stream,
    });
    this.focusStartedScreens();
  }

  private focusStartedScreens(tiles?: StageTile[]): boolean {
    for (const [shareId, intent] of this.pendingScreenFocus) {
      if (!intent.isCurrent()) this.pendingScreenFocus.delete(shareId);
    }
    if (!this.pendingScreenFocus.size || !this.currentChannelId) return false;
    const availableTiles = tiles ?? this.buildStageTiles(
      participantManager.getInVoiceChannel(this.currentChannelId),
      serverStore.currentUser?.sessionId || serverStore.currentUser?.id,
    );
    const ready = [...this.pendingScreenFocus].filter(([, intent]) =>
      availableTiles.some(tile => tile.key === intent.tileKey));
    if (!ready.length) return false;
    const keys = [...new Set([...this.focusedTileKeys, ...ready.map(([, intent]) => intent.tileKey)])]
      .filter(key => availableTiles.some(tile => tile.key === key)).slice(-MAX_FOCUSED_TILES);
    const consume = () => {
      for (const [shareId, intent] of ready) {
        if (this.pendingScreenFocus.get(shareId) === intent) this.pendingScreenFocus.delete(shareId);
      }
    };
    // Capture starts before the roster changes. Consume its intent only when the
    // tile exists, and keep it cancellable while native fullscreen is exiting.
    this.setFocusedTiles(keys, {
      screenStart: true,
      isCurrent: () => ready.every(([shareId, intent]) => this.pendingScreenFocus.get(shareId) === intent
        && intent.isCurrent() && voiceStore.screenShareIds.includes(shareId)),
      beforeRender: consume,
      onFailure: consume,
    });
    return true;
  }

  private setFocusedTiles(
    tileKeys: string[],
    hooks?: {
      beforeRender?: () => void; afterRender?: () => void; onFailure?: () => void;
      isCurrent?: () => boolean; screenStart?: boolean;
    },
  ): void {
    if (!hooks?.screenStart) this.pendingScreenFocus.clear();
    const root = this.container.querySelector('.voice-stage-container');
    if (!root) return;
    const epoch = ++this.focusEpoch;
    const channelId = this.currentChannelId;
    const displayedServer = getActiveServerStore();
    const sessionId = displayedServer.currentUser?.sessionId;
    const voiceSessionKey = voiceStore.voiceSessionKey;
    const current = () => epoch === this.focusEpoch && this.currentChannelId === channelId
      && getActiveServerStore() === displayedServer && displayedServer.currentUser?.sessionId === sessionId
      && voiceStore.voiceSessionKey === voiceSessionKey
      && root.isConnected && this.container.querySelector('.voice-stage-container') === root
      && hooks?.isCurrent?.() !== false;
    const commit = () => {
      if (!current()) return;
      this.clearFocusError();
      this.focusedTileKeys = tileKeys;
      hooks?.beforeRender?.();
      this.renderParticipants();
      hooks?.afterRender?.();
    };
    const changingLayout = tileKeys.length !== this.focusedTileKeys.length
      || this.focusedTileKeys.some((key, index) => tileKeys[index] !== key);
    const fullscreen = document.fullscreenElement;
    if (!changingLayout || !fullscreen ||
        (!this.container.contains(fullscreen) && !fullscreen.contains(root))) {
      commit();
      return;
    }
    // Preserve live content and the current layout until native fullscreen has actually exited.
    void Promise.resolve().then(() => {
      if (current() && document.fullscreenElement === fullscreen) return document.exitFullscreen();
    }).then(() => {
      if (!current()) return;
      const active = document.fullscreenElement;
      if (active && (this.container.contains(active) || active.contains(root))) {
        throw new Error('The voice stage is still in fullscreen.');
      }
      commit();
    }).catch((error: unknown) => {
      console.warn('[VoiceStageView] Could not exit fullscreen before changing focus:', error);
      if (!current()) return;
      this.clearFocusError();
      this.focusError = document.createElement('p');
      this.focusError.className = 'bot-error stage-focus-error';
      this.focusError.setAttribute('role', 'alert');
      this.focusError.textContent = t('stage.fullscreenExitError');
      (this.container.contains(fullscreen) ? fullscreen : root).append(this.focusError);
      hooks?.onFailure?.();
    });
  }

  /**
   * Resolves the remote stream backing a screen tile. Pre-#253 peers announce
   * their real MediaStream id over `screen-video-meta` but never publish a
   * `screenShareIds` list, so their tile is keyed by LEGACY_SHARE_ID and has to
   * fall back to whichever single screen stream arrived for that user.
   */
  private getRemoteScreenStream(tile: ParticipantStageTile): MediaStream | undefined {
    const streams = tile.p.remoteScreenStreams;
    if (tile.shareId === LEGACY_SHARE_ID) {
      return streams.values().next().value;
    }
    return streams.get(tile.shareId!);
  }

  /** Stable, unique DOM id fragment for a tile — screens differ by share (#253). */
  private tileDomId(tile: StageTile): string {
    if (tile.kind === 'miniapp') return `bot-screen-${tile.screen.id}`;
    return tile.kind === 'screen'
      ? `${sidOf(tile.p)}-screen-${tile.shareId}`
      : `${sidOf(tile.p)}-${tile.kind}`;
  }

  private tileAttributes(tile: StageTile): string {
    const common = `id="card-${escapeHtml(this.tileDomId(tile))}" data-kind="${tile.kind}" data-tile-key="${escapeHtml(tile.key)}"`;
    return tile.kind === 'miniapp'
      ? `${common} data-bot-screen-slot="${escapeHtml(tile.screen.id)}" aria-hidden="true"`
      : `${common} data-session-id="${escapeHtml(sidOf(tile.p))}"`;
  }

  private isWatchingScreen(sessionId: string, shareId: string): boolean {
    return isViewingCallServer() && this.currentChannelId === voiceStore.currentVoiceChannelId
      && voiceStore.isWatchingScreen(sessionId, shareId);
  }

  private isTileSpeaking(tile: StageTile): boolean {
    // The speaking glow reflects the microphone; a pure screen tile shouldn't
    // pulse when the user talks (their camera/voice tile already does).
    if (tile.kind === 'screen' || tile.kind === 'miniapp') return false;
    return this.currentChannelId === voiceStore.currentVoiceChannelId && isParticipantSpeaking(tile.p);
  }

  public renderParticipants(): void {
    this.refreshBotScreens();
    const area = this.container.querySelector<HTMLElement>('#stage-participants-area');
    if (!area || !this.currentChannelId) return;

    const participants = participantManager.getInVoiceChannel(this.currentChannelId);
    if (participants.length === 0) {
      this.unbindTelemetryControls();
      this.releaseStageVideos(area);
      area.innerHTML = `
        <div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-muted);">
          Aguardando outros amigos entrarem na chamada...
        </div>
      `;
      return;
    }

    const currentSessionId = serverStore.currentUser?.sessionId || serverStore.currentUser?.id;

    // A participant sharing camera + screens contributes one tile per source
    // (#26, #253); focus, speaking and DOM keys are keyed per tile.
    const tiles = this.buildStageTiles(participants, currentSessionId);
    if (this.focusStartedScreens(tiles)) return;
    this.unbindTelemetryControls();
    this.releaseStageVideos(area);

    // Drop focus entries whose tile disappeared (share ended, peer left).
    this.focusedTileKeys = this.focusedTileKeys.filter((key) =>
      tiles.some((tile) => tile.key === key)
    );

    if (this.focusedTileKeys.length > 0) {
      const focusedTiles = this.focusedTileKeys
        .map((key) => tiles.find((tile) => tile.key === key)!)
        .filter(Boolean);
      const otherTiles = tiles.filter((tile) => !this.focusedTileKeys.includes(tile.key));

      area.innerHTML = `
        <div class="stage-focused-layout">
          <div class="stage-focused-stack ${focusedTiles.length > 1 ? 'stage-focused-stack--split' : ''}">
            ${focusedTiles.map((focusedTile) => `
              <div class="stage-focused-main ${this.isTileSpeaking(focusedTile) ? 'speaking' : ''}" ${this.tileAttributes(focusedTile)}>
                ${focusedTile.kind === 'miniapp' ? '' : `<div class="stage-focus-hint-badge">
                  <span class="material-symbols-outlined md-14">zoom_in</span>
                  <span>${t('stage.focusMode')}</span>
                </div>`}
                ${this.renderCardContent(focusedTile, true)}
              </div>
            `).join('')}
          </div>

          ${otherTiles.length > 0 ? `
            <div class="stage-focused-strip">
              ${otherTiles.map((tile) => {
                return `
                  <div class="stage-mini-card ${tile.kind === 'voice' ? '' : 'stage-mini-card--video'} ${this.isTileSpeaking(tile) ? 'speaking' : ''}" ${this.tileAttributes(tile)} title="${t('stage.focusOn', { name: escapeHtml(tile.kind === 'miniapp' ? tile.screen.title : participantManager.displayName(tile.p)) })}">
                    ${this.renderCardContent(tile, false, true)}
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}
        </div>
      `;
    } else {
      area.innerHTML = `
        <div class="stage-grid" id="stage-grid">
          ${tiles.map((tile) => {
            return `
              <div class="stage-card ${tile.kind === 'voice' ? '' : 'stage-card--video'} ${this.isTileSpeaking(tile) ? 'speaking' : ''}" ${this.tileAttributes(tile)} title="${t('stage.focusHint')}">
                ${this.renderCardContent(tile, false, false)}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Attach click listeners to cards for focus toggle & right-click for volume adjustment
    const allCards = area.querySelectorAll('[data-session-id]');
    allCards.forEach((card) => {
      card.addEventListener('click', (e: Event) => {
        // Don't toggle focus when the click originates from an interactive
        // overlay (volume/fullscreen), nor right after a slider drag whose
        // pointer-up may land outside the controls (#75).
        if (Date.now() < this.suppressCardClickUntil) return;
        if ((e.target as HTMLElement).closest('.stage-card-controls')) return;
        // While zoomed in, a click pans instead of dropping out of focus (#271).
        if (this.focusZoom.scale > 1 && card.classList.contains('stage-focused-main')) return;
        const tileKey = card.getAttribute('data-tile-key');
        if (tileKey) {
          this.toggleFocus(tileKey);
        }
      });

      card.addEventListener('contextmenu', (e: Event) => {
        const mouseEvent = e as MouseEvent;
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        const sessionId = card.getAttribute('data-session-id');
        if (!sessionId) return;
        const participant = participantManager.get(sessionId);
        if (participant?.user) {
          userContextMenu.open(mouseEvent.clientX, mouseEvent.clientY, participant.user);
        }
      });
    });

    // Fullscreen buttons on video tiles (#68)
    const fsButtons = area.querySelectorAll('.stage-fullscreen-btn');
    fsButtons.forEach((btn) => {
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const targetId = btn.getAttribute('data-fullscreen-target');
        if (targetId) this.toggleVideoFullscreen(targetId);
      });
    });

    area.querySelectorAll<HTMLButtonElement>('.stage-diagnostics-btn').forEach(button => {
      const onCopy = (event: MouseEvent): void => {
        event.stopPropagation();
        const tileKey = button.dataset.diagnosticsKey;
        if (tileKey) void this.copyTelemetry(tileKey, button);
      };
      button.addEventListener('click', onCopy);
      this.unbindTelemetryButtons.push(() => button.removeEventListener('click', onCopy));
    });

    this.setupFocusedScreenZoom(area);

    // #150: "Assistir transmissão" — opt into a gated remote screen share.
    // Starts video + audio and auto-focuses the broadcaster.
    const watchBtns = area.querySelectorAll('.stage-watch-btn') as NodeListOf<HTMLButtonElement>;
    watchBtns.forEach((btn) => {
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const sessionId = btn.getAttribute('data-watch-session');
        const shareId = btn.getAttribute('data-watch-share');
        if (!sessionId || !shareId) return;
        if (!isViewingCallServer() || this.currentChannelId !== voiceStore.currentVoiceChannelId) return;
        this.setFocusedTiles([`${sessionId}:screen:${shareId}`], { beforeRender: () => {
          webRtcManager.setRemoteScreenWatching(sessionId, shareId, true);
        } });
      });
    });

    // Stop changes the transport subscription, not just playback or styling.
    const stopWatchBtns = area.querySelectorAll('.stage-stopwatch-btn') as NodeListOf<HTMLButtonElement>;
    stopWatchBtns.forEach((btn) => {
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const sessionId = btn.getAttribute('data-stopwatch-session');
        const shareId = btn.getAttribute('data-stopwatch-share');
        if (!sessionId || !shareId) return;
        const tileKey = `${sessionId}:screen:${shareId}`;
        if (!isViewingCallServer() || this.currentChannelId !== voiceStore.currentVoiceChannelId) return;
        this.setFocusedTiles(this.focusedTileKeys.filter((key) => key !== tileKey), {
          beforeRender: () => { webRtcManager.setRemoteScreenWatching(sessionId, shareId, false); },
        });
      });
    });

    area.querySelectorAll<HTMLButtonElement>('.stage-quality-button').forEach(button => {
      const menu = button.parentElement?.querySelector<HTMLElement>('.stage-quality-menu');
      if (!menu) return;
      button.addEventListener('click', event => {
        event.stopPropagation();
        menu.hidden = !menu.hidden;
        button.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden) menu.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
      });
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          menu.hidden = true;
          button.setAttribute('aria-expanded', 'false');
          button.focus();
        }
      });
      menu.querySelectorAll<HTMLButtonElement>('[data-screen-quality]').forEach(choice => {
        choice.addEventListener('click', event => {
          event.stopPropagation();
          const sessionId = menu.dataset.sessionId, shareId = menu.dataset.shareId;
          const quality = screenShareQualitySchema.parse(choice.dataset.screenQuality);
          if (!sessionId || !shareId || !this.isWatchingScreen(sessionId, shareId)) return;
          voiceStore.setScreenQuality(sessionId, shareId, quality);
          for (const option of menu.querySelectorAll('[data-screen-quality]'))
            option.setAttribute('aria-pressed', String(option === choice));
          menu.hidden = true;
          button.setAttribute('aria-expanded', 'false');
          button.focus();
        });
      });
    });

    // Screen audio volume sliders (#75)
    const volSliders = area.querySelectorAll('.stage-screen-volume-slider') as NodeListOf<HTMLInputElement>;
    volSliders.forEach((slider) => {
      slider.addEventListener('input', () => {
        const sessionId = slider.getAttribute('data-session-id');
        if (!sessionId) return;
        const vol = parseInt(slider.value, 10);
        // Persisted per device, not per person (#363): the same person sharing
        // from two machines gets one slider each.
        settingsStore.setScreenAudioVolume(sessionId, vol);
      });
    });

    // Volume button click → toggle mute screen audio
    const volButtons = area.querySelectorAll('.stage-volume-btn') as NodeListOf<HTMLButtonElement>;
    volButtons.forEach((btn) => {
      // Sync the button icon + popup visibility with the current (possibly
      // persisted) mute state of the underlying <audio> element on each
      // render, so a muted share doesn't come back showing "volume_up" (#159).
      const initWrapper = btn.closest('.stage-volume-wrapper');
      const initSlider = initWrapper?.querySelector('.stage-screen-volume-slider') as HTMLInputElement | null;
      const initSessionId = initSlider?.getAttribute('data-session-id');
      if (initSessionId && voiceStore.isScreenAudioMuted(initSessionId)) {
        const initIcon = btn.querySelector('.material-symbols-outlined');
        if (initIcon) initIcon.textContent = 'volume_off';
        btn.title = t('stage.screenAudioMuted');
        initWrapper?.classList.add('screen-audio-muted');
      }

      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const wrapper = btn.closest('.stage-volume-wrapper');
        const slider = wrapper?.querySelector('.stage-screen-volume-slider') as HTMLInputElement | null;
        if (!slider) return;
        const sessionId = slider.getAttribute('data-session-id');
        if (!sessionId) return;
        const icon = btn.querySelector('.material-symbols-outlined');
        if (voiceStore.isScreenAudioMuted(sessionId)) {
          webRtcManager.setScreenAudioMuted(sessionId, false);
          if (icon) icon.textContent = 'volume_up';
          btn.title = t('stage.screenAudioVolume');
          wrapper?.classList.remove('screen-audio-muted');
        } else {
          webRtcManager.setScreenAudioMuted(sessionId, true);
          if (icon) icon.textContent = 'volume_off';
          btn.title = t('stage.screenAudioMuted');
          wrapper?.classList.add('screen-audio-muted');
        }
      });
    });

    // Volume controls must not toggle card focus (which re-renders and drops
    // fullscreen). Suppress the card click that follows any control interaction,
    // and keep the slider popup open + tracking the pointer while dragging, even
    // when the mouse leaves the small popup area (#75).
    const controlBars = area.querySelectorAll('.stage-card-controls');
    controlBars.forEach((bar) => {
      bar.addEventListener('pointerdown', () => {
        this.suppressCardClickUntil = Date.now() + 800;
      });
    });

    const volWrappers = area.querySelectorAll('.stage-volume-wrapper');
    volWrappers.forEach((wrapper) => {
      const slider = wrapper.querySelector('.stage-screen-volume-slider') as HTMLInputElement | null;
      if (!slider) return;
      slider.addEventListener('pointerdown', (e: Event) => {
        wrapper.classList.add('dragging');
        try { slider.setPointerCapture((e as PointerEvent).pointerId); } catch { /* ignore */ }
      });
      const endDrag = () => {
        wrapper.classList.remove('dragging');
        // Keep suppressing briefly so the trailing click can't reach the card.
        this.suppressCardClickUntil = Date.now() + 400;
      };
      slider.addEventListener('pointerup', endDrag);
      slider.addEventListener('lostpointercapture', endDrag);
    });

    // Attach media streams to the per-tile video elements cleanly. Camera rides
    // remoteStream / cameraStream; each screen share rides its own stream keyed
    // by share id so every tile shows independent video (#26, #253).
    tiles.forEach((tile) => {
      if (tile.kind === 'voice' || tile.kind === 'miniapp') return;
      const isLocal = sidOf(tile.p) === currentSessionId;
      if (!isLocal && tile.kind === 'screen' && !this.isWatchingScreen(sidOf(tile.p), tile.shareId!)) return;
      const stream = isLocal
        ? (tile.kind === 'screen' ? videoService.getScreenStream(tile.shareId!) : videoService.getCameraState().stream)
        : (tile.kind === 'screen' ? this.getRemoteScreenStream(tile) : tile.p.remoteStream);
      if (!stream) return;
      const suffix = tile.kind === 'screen' ? `screen-${tile.shareId}` : tile.kind;
      const ids = [`video-${sidOf(tile.p)}-${suffix}`, `video-mini-${sidOf(tile.p)}-${suffix}`];
      ids.forEach((id) => {
        const el = document.getElementById(id) as HTMLVideoElement | null;
        if (el && el.srcObject !== stream) {
          el.muted = true;
          el.srcObject = stream;
          this.hideVideoLoadingWhenReady(el, id);
          el.play().catch(() => {});
        }
      });
    });

    this.applyTelemetryOverlayState();
    this.syncTelemetryMonitor();
    this.syncBotScreenLayout();
    this.refreshNativeScreenState();
  }

  private renderScreenQuality(source: NativeScreenSource, sessionId: string): string {
    const selected = voiceStore.getScreenQuality(sessionId, source.shareId);
    return `<div class="stage-quality-wrapper">
      <button type="button" class="stage-quality-button" aria-expanded="false" title="${t('stage.screenQuality')}" aria-label="${t('stage.screenQuality')}">
        <span class="material-symbols-outlined md-18">tune</span>
      </button>
      <div class="stage-quality-menu" hidden role="group" aria-label="${t('stage.screenQuality')}"
        data-session-id="${escapeHtml(sessionId)}" data-share-id="${escapeHtml(source.shareId)}">
        ${getScreenShareQualities(source.video).map(({ quality, profile }) => `
          <button type="button" data-screen-quality="${quality}" aria-pressed="${selected === quality}">
            ${quality === 'source' ? `<strong>${t('stage.screenQualitySource')}</strong>` : ''}
            <span>${t('stage.screenQualityOption', {
              width: profile.width, height: profile.height, fps: profile.fps, bitrate: profile.maxBitrateKbps,
            })}</span>
          </button>`).join('')}
      </div>
    </div>`;
  }

  private refreshNativeScreenState(): void {
    for (const card of this.container.querySelectorAll<HTMLElement>('[data-kind="screen"][data-session-id]')) {
      const sessionId = card.dataset.sessionId;
      const shareId = card.dataset.tileKey?.split(':screen:')[1];
      if (!sessionId || !shareId) continue;
      const badge = card.querySelector<HTMLElement>('.stage-capture-mode-badge');
      if (badge) {
        const native = badge.dataset.nativeScreen === 'true'
          || (serverStore.isMySession(sessionId) ? videoService.getNativeScreenCapture(shareId)
            : webRtcManager.getNativeScreenSource(sessionId, shareId)) !== null;
        if (native) badge.dataset.nativeScreen = 'true';
        const mode = native ? webRtcManager.getScreenCaptureMode(sessionId, shareId) : 'normal';
        badge.hidden = mode === null;
        const text = mode === null ? '' : t(mode === 'game' ? 'stage.captureModeGame' : 'stage.captureModeNormal');
        const label = mode === null ? '' : t('stage.captureModeLabel', { mode: text });
        if (mode === null) badge.removeAttribute('data-capture-mode');
        else if (badge.dataset.captureMode !== mode) badge.dataset.captureMode = mode;
        if (badge.textContent !== text) badge.textContent = text;
        if (badge.getAttribute('aria-label') !== label) badge.setAttribute('aria-label', label);
        if (badge.title !== label) badge.title = label;
      }
      if (sessionId && shareId && serverStore.isMySession(sessionId) && videoService.getNativeScreenCapture(shareId)) {
        const state = webRtcManager.getLocalScreenPreviewState(shareId);
        card.dataset.previewState = state;
        const placeholder = card.querySelector<HTMLElement>('.stage-native-thumbnail');
        if (placeholder) {
          placeholder.hidden = state === 'playing';
          const label = placeholder.querySelector('span');
          if (label) label.textContent = t(state === 'unavailable' ? 'stage.nativePreviewUnavailable'
            : state === 'paused' ? 'stage.nativePreviewPaused' : 'stage.nativeThumbnail');
        }
        continue;
      }
      if (!sessionId || !shareId || !this.isWatchingScreen(sessionId, shareId)) continue;
      if (!webRtcManager.getNativeScreenSource(sessionId, shareId)) continue;
      const video = card.querySelector<HTMLVideoElement>('video.stage-video-element');
      const stream = participantManager.get(sessionId)?.remoteScreenStreams.get(shareId) ?? null;
      if (video && video.srcObject !== stream) {
        this.videoLoadingListeners.get(video)?.();
        video.pause();
        video.srcObject = stream;
        if (stream) {
          video.muted = true;
          this.hideVideoLoadingWhenReady(video, video.id);
          void video.play().catch((error: unknown) => console.warn('[VoiceStage] Could not show the screen:', error));
        }
      }
      const state = webRtcManager.getNativeScreenWatchState(sessionId, shareId);
      const existing = card.querySelector('.stage-native-error');
      if (state?.state !== 'unavailable') { existing?.remove(); continue; }
      if (existing) continue;
      card.querySelector('.stage-loading-overlay')?.remove();
      const error = document.createElement('div');
      error.className = 'stage-native-error';
      error.setAttribute('role', 'alert');
      const text = document.createElement('span');
      text.textContent = t(`screenShare.nativeFailure.${state.reason ?? 'connection-failed'}`);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary';
      retry.textContent = t('stage.screenRetry');
      retry.addEventListener('click', event => {
        event.stopPropagation();
        if (this.isWatchingScreen(sessionId, shareId)) webRtcManager.retryNativeScreen(sessionId, shareId);
      });
      error.append(text, retry);
      card.append(error);
    }
  }

  private refreshLocalCameraVideo(): void {
    const user = serverStore.currentUser;
    if (!user) return;
    const sessionId = user.sessionId || user.id;
    const state = videoService.getCameraState();
    for (const id of [`video-${sessionId}-camera`, `video-mini-${sessionId}-camera`]) {
      const video = document.getElementById(id);
      if (!(video instanceof HTMLVideoElement) || !this.container.contains(video)) continue;
      const stream = voiceStore.isCameraOn ? state.stream : null;
      if (video.srcObject === stream) continue;
      video.pause();
      video.srcObject = stream;
      if (stream) {
        video.muted = true;
        this.hideVideoLoadingWhenReady(video, id);
        void video.play().catch((error: unknown) => console.warn('[VoiceStage] Could not show the local camera:', error));
      }
    }
  }

  /** Removes the "loading video" overlay once the stream actually renders (#48). */
  private hideVideoLoadingWhenReady(videoEl: HTMLVideoElement, videoId: string): void {
    this.videoLoadingListeners.get(videoEl)?.();
    const overlay = document.getElementById(`loading-${videoId}`);
    if (!overlay) return;
    const cleanup = (): void => {
      videoEl.removeEventListener('playing', hide);
      videoEl.removeEventListener('loadeddata', hide);
      this.videoLoadingListeners.delete(videoEl);
    };
    const hide = (): void => { cleanup(); overlay.remove(); };
    if (videoEl.readyState >= 2) {
      hide();
      return;
    }
    this.videoLoadingListeners.set(videoEl, cleanup);
    videoEl.addEventListener('playing', hide, { once: true });
    videoEl.addEventListener('loadeddata', hide, { once: true });
  }

  /**
   * Ctrl+scroll zooms the focused screen share towards the pointer, dragging
   * pans the zoomed image and a double-click resets it (#271). Re-attached on
   * every render because the stage markup is rebuilt from scratch.
   */
  private setupFocusedScreenZoom(area: HTMLElement): void {
    // Zoom/pan targets a single pane; with the focus area split in two (#253)
    // there is no unambiguous target, so it stays disabled until one is left.
    const mains = area.querySelectorAll('.stage-focused-main');
    const main = (mains.length === 1 ? mains[0] : null) as HTMLElement | null;
    const video = main?.querySelector(
      'video.stage-video-element.screen-share:not(.screen-locked)'
    ) as HTMLElement | null;
    const tileKey = main?.getAttribute('data-tile-key') ?? null;

    if (!main || !video || !tileKey) {
      this.focusZoomTileKey = null;
      this.focusZoom = { scale: 1, x: 0, y: 0 };
      return;
    }

    if (this.focusZoomTileKey !== tileKey) {
      this.focusZoomTileKey = tileKey;
      this.focusZoom = { scale: 1, x: 0, y: 0 };
    }

    const clampPan = () => {
      const rect = main.getBoundingClientRect();
      const maxX = (rect.width * (this.focusZoom.scale - 1)) / 2;
      const maxY = (rect.height * (this.focusZoom.scale - 1)) / 2;
      this.focusZoom.x = Math.min(maxX, Math.max(-maxX, this.focusZoom.x));
      this.focusZoom.y = Math.min(maxY, Math.max(-maxY, this.focusZoom.y));
    };

    const apply = () => {
      const { scale, x, y } = this.focusZoom;
      video.style.transform = scale > 1 ? `translate(${x}px, ${y}px) scale(${scale})` : '';
      main.classList.toggle('is-zoomed', scale > 1);
    };

    apply();

    main.addEventListener('wheel', (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();

      const previous = this.focusZoom.scale;
      const next = Math.min(
        FOCUS_ZOOM_MAX_SCALE,
        Math.max(1, previous - Math.sign(e.deltaY) * FOCUS_ZOOM_STEP)
      );
      if (next === previous) return;

      // Keep the pixel under the cursor anchored while the scale changes.
      const rect = main.getBoundingClientRect();
      const cursorX = e.clientX - rect.left - rect.width / 2;
      const cursorY = e.clientY - rect.top - rect.height / 2;
      const anchorX = (cursorX - this.focusZoom.x) / previous;
      const anchorY = (cursorY - this.focusZoom.y) / previous;

      this.focusZoom.scale = next;
      this.focusZoom.x = cursorX - anchorX * next;
      this.focusZoom.y = cursorY - anchorY * next;
      clampPan();
      apply();
    }, { passive: false });

    let panning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panOriginX = 0;
    let panOriginY = 0;

    main.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || this.focusZoom.scale <= 1) return;
      if ((e.target as HTMLElement).closest('.stage-card-controls')) return;
      panning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panOriginX = this.focusZoom.x;
      panOriginY = this.focusZoom.y;
      main.classList.add('is-panning');
      main.setPointerCapture(e.pointerId);
    });

    main.addEventListener('pointermove', (e: PointerEvent) => {
      if (!panning) return;
      this.focusZoom.x = panOriginX + (e.clientX - panStartX);
      this.focusZoom.y = panOriginY + (e.clientY - panStartY);
      clampPan();
      apply();
    });

    const endPan = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      main.classList.remove('is-panning');
      if (main.hasPointerCapture(e.pointerId)) main.releasePointerCapture(e.pointerId);
      // The pointer-up turns into a click that would otherwise leave focus mode.
      this.suppressCardClickUntil = Date.now() + 200;
    };

    main.addEventListener('pointerup', endPan);
    main.addEventListener('pointercancel', endPan);

    main.addEventListener('dblclick', (e: MouseEvent) => {
      if (this.focusZoom.scale <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      this.focusZoom = { scale: 1, x: 0, y: 0 };
      apply();
      this.suppressCardClickUntil = Date.now() + 200;
    });
  }

  /** Toggles native fullscreen for a stage video tile (#68).
   *  Fullscreens the whole card (a <div>), not the bare <video>, so Chromium's
   *  native video controls don't appear — they act on the muted <video> element
   *  and can't reach the screen-audio <audio> element. Keeping the card in
   *  fullscreen preserves the stage's real volume/mute controls (#75). */
  private async toggleVideoFullscreen(videoId: string): Promise<void> {
    const videoEl = document.getElementById(videoId) as HTMLVideoElement | null;
    if (!videoEl) return;
    const target = (videoEl.closest('.stage-card, .stage-focused-main, .stage-mini-card') as HTMLElement | null) ?? videoEl;
    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
      } else {
        await target.requestFullscreen();
      }
    } catch (err) {
      console.warn('[VoiceStageView] Fullscreen request failed:', err);
    }
  }

  private renderCardContent(tile: StageTile, isFocused: boolean = false, isMini: boolean = false): string {
    if (tile.kind === 'miniapp') return '';
    const p = tile.p;
    const isLocal = serverStore.isMySession(p.user.sessionId);
    const isLocalCall = isLocal && isViewingCallServer() && !!voiceStore.currentVoiceChannelId;
    const isCamOn = isLocal ? voiceStore.isCameraOn : (p.voiceState?.isCameraOn ?? false);
    const isScreenOn = isLocal ? voiceStore.isScreenSharing : (p.voiceState?.isScreenSharing ?? false);
    const isServerMuted = isLocalCall ? voiceStore.serverMuted : (p.voiceState?.serverMuted ?? false);
    const isServerDeafened = isLocalCall ? voiceStore.serverDeafened : (p.voiceState?.serverDeafened ?? false);
    const isSelfMuted = isLocalCall ? voiceStore.isMuted : (p.voiceState?.isMuted ?? false);
    const isSelfDeafened = isLocalCall ? voiceStore.isDeafened : (p.voiceState?.isDeafened ?? false);
    const isSfu = serverStore.serverDetails?.voiceMode === 'sfu';
    const { isPeerFailed, isConnecting, isRelayed } = participantConnectionIndicators(p, isSfu, isLocal);
    const avatarSrc = getAvatarUrl(p.user.avatarUrl);

    const isVideoTile = tile.kind === 'camera' || tile.kind === 'screen';
    const isScreenTile = tile.kind === 'screen';
    const tileSuffix = isScreenTile ? `screen-${tile.shareId}` : tile.kind;
    const videoId = isMini ? `video-mini-${sidOf(p)}-${tileSuffix}` : `video-${sidOf(p)}-${tileSuffix}`;
    const isRemoteScreen = isScreenTile && !isLocal;
    const localNative = isScreenTile && isLocal && tile.shareId ? videoService.getNativeScreenCapture(tile.shareId) : null;
    const remoteNative = isRemoteScreen && tile.shareId
      ? p.voiceState?.nativeScreenShares?.find(source => source.shareId === tile.shareId) : undefined;
    const isWatching = !!tile.shareId && this.isWatchingScreen(sidOf(p), tile.shareId);
    // An unrequested source is only a placeholder; no remote payload is needed.
    const isLocked = isRemoteScreen && !isWatching;
    // Distinguish the two tiles of a camera + screen sharer with a "· Tela"
    // suffix on the screen tile label (#26); when the same person shares two
    // screens at once, number them so the tiles stay tellable apart (#253).
    const shareIds = isScreenTile ? this.getShareIds(p, isLocal) : [];
    const shareIndex = isScreenTile ? shareIds.indexOf(tile.shareId!) : -1;
    const screenLabel = shareIds.length > 1 && shareIndex >= 0
      ? t('stage.screenLabelNumbered', { index: String(shareIndex + 1) })
      : t('stage.screenLabel');
    const label = isScreenTile
      ? `${escapeHtml(participantManager.displayName(p))} · ${screenLabel}`
      : escapeHtml(participantManager.displayName(p));

    return `
      ${isVideoTile ? `
        <video id="${videoId}" data-video-tile-key="${escapeHtml(tile.key)}" class="stage-video-element ${isScreenTile ? 'screen-share' : ''}${isLocked ? ' screen-locked' : ''}" autoplay playsinline muted></video>
        ${isScreenTile ? `<span class="stage-capture-mode-badge" data-native-screen="${!!(localNative || remoteNative)}"
          role="status" aria-live="polite" aria-atomic="true" hidden></span>` : ''}
        ${localNative ? `<div class="stage-native-thumbnail">
          ${localNative.thumbnail ? `<img src="${escapeHtml(localNative.thumbnail)}" alt="">` : ''}
          <span>${t('stage.nativeThumbnail')}</span>
        </div>` : ''}
        ${!isLocked && !localNative ? `
          <div class="stage-loading-overlay${isMini ? ' stage-loading-overlay--mini' : ''}" id="loading-${videoId}">
            <div class="reconnect-spinner"></div>
            ${isMini ? '' : `<span>${isScreenTile ? t('stage.loadingScreen') : t('stage.loadingCamera')}</span>`}
          </div>
        ` : ''}
        ${(isVideoTile && !isLocked && !isMini) ? `
          <div
            class="telemetry-overlay position-${settingsStore.screenShareTelemetryPosition}${settingsStore.screenShareTelemetryEnabled ? '' : ' is-hidden'}"
            data-telemetry-key="${escapeHtml(tile.key)}"
          >${escapeHtml(this.getTelemetryText(tile.key))}</div>
        ` : ''}
        ${isLocked ? `
          <div class="stage-watch-overlay${isMini ? ' stage-watch-overlay--mini' : ''}">
            <button class="stage-watch-btn" data-watch-session="${sidOf(p)}" data-watch-share="${tile.shareId}"${isMini ? ` title="${t('stage.watchBroadcast')}" aria-label="${t('stage.watchBroadcast')}"` : ''}>
              <span class="material-symbols-outlined">smart_display</span>
              ${isMini ? '' : `<span>${t('stage.watchBroadcast')}</span>`}
            </button>
            ${isMini ? '' : `<div class="stage-watch-caption">${t('stage.watchCaption', { name: escapeHtml(participantManager.displayName(p)) })}</div>`}
          </div>
        ` : `
          <div class="stage-card-controls">
            ${isRemoteScreen ? `
              ${remoteNative && !isMini ? this.renderScreenQuality(remoteNative, sidOf(p)) : ''}
              <div class="stage-volume-wrapper">
                <div class="stage-volume-popup">
                  <input type="range" class="stage-screen-volume-slider" data-session-id="${sidOf(p)}" min="0" max="200" value="${settingsStore.getScreenAudioVolume(sidOf(p), p.user.clientId)}" />
                </div>
                <button class="stage-volume-btn" title="${t('stage.screenAudioVolume')}" aria-label="${t('stage.volumeAria')}">
                  <span class="material-symbols-outlined md-18">volume_up</span>
                </button>
              </div>
              <button class="stage-stopwatch-btn" data-stopwatch-session="${sidOf(p)}" data-stopwatch-share="${tile.shareId}" title="${t('stage.stopWatching')}" aria-label="${t('stage.stopWatching')}">
                <span class="material-symbols-outlined md-18">visibility_off</span>
              </button>
            ` : ''}
            ${!isMini ? `
              <button type="button" class="stage-diagnostics-btn" data-diagnostics-key="${escapeHtml(tile.key)}" ${settingsStore.screenShareTelemetryEnabled ? '' : 'hidden'}
                title="${escapeHtml(t('stage.telemetryCopy'))}" aria-label="${escapeHtml(t('stage.telemetryCopy'))}">
                <span class="material-symbols-outlined md-18">content_copy</span>
              </button>
            ` : ''}
            <button class="stage-fullscreen-btn" data-fullscreen-target="${videoId}" title="${t('stage.fullscreen')}" aria-label="${t('stage.fullscreen')}">
              <span class="material-symbols-outlined md-18">fullscreen</span>
            </button>
          </div>
        `}
      ` : `
        <div class="stage-avatar-wrapper">
          <img class="stage-avatar-img" src="${avatarSrc}" data-fallback="avatar">
          ${!isMini ? `
            <div class="stage-participant-name">${escapeHtml(participantManager.displayName(p))} ${isLocal ? `(${t('common.you')})` : ''}</div>
          ` : ''}
        </div>
      `}

      <div class="stage-badges-overlay">
        <span>${label}</span>
        ${isPeerFailed ? `<span class="material-symbols-outlined md-14 stage-peer-failed-icon" title="${isSfu ? t('main.sfuConnectionFailed') : peerFailureTooltip('stage.peerConnectionFailed')}">link_off</span>` : ''}
        ${isConnecting ? `<span class="material-symbols-outlined md-14 stage-peer-connecting-icon" title="${t(isSfu ? 'main.sfuConnecting' : 'stage.peerConnecting')}">sync</span>` : ''}
        ${isRelayed ? `<span class="material-symbols-outlined md-14" style="color: var(--warning, #f0b232);" title="${t('stage.peerRelayed')}">swap_horiz</span>` : ''}
        ${renderAudioMuteIndicators({ ...p.voiceState, isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened })}
        ${isCamOn ? '<span class="material-symbols-outlined md-14" style="color: var(--accent-primary);">videocam</span>' : ''}
        ${isScreenOn ? '<span class="material-symbols-outlined md-14" style="color: var(--success);">screen_share</span>' : ''}
      </div>
      ${(!isLocal && p.isReconnecting) ? `
        <div class="stage-reconnecting-overlay">
          <div class="reconnect-spinner"></div>
          <span>${t('main.reconnecting')}</span>
        </div>
      ` : ''}
    `;
  }

  /** Telemetry is keyed by tile, so each share reports its own numbers (#340). */
  private getTelemetryText(tileKey: string): string {
    const snapshot = this.telemetrySnapshots.get(tileKey);
    return snapshot
      ? formatVideoTelemetry(snapshot, settingsStore.screenShareTelemetryMode)
      : t('stage.telemetryCollecting');
  }

  private async copyTelemetry(tileKey: string, button: HTMLButtonElement): Promise<void> {
    const snapshot = this.telemetrySnapshots.get(tileKey);
    if (!snapshot || !settingsStore.screenShareTelemetryEnabled) {
      void showAlert({ message: t('stage.telemetryCollecting') });
      return;
    }
    const request = ++this.telemetryCopyRequest;
    this.clearTelemetryToast?.();
    this.clearTelemetryToast = null;
    try {
      await navigator.clipboard.writeText(serializeVideoTelemetry(snapshot, navigator.userAgent, this.telemetryHistory.get(tileKey)));
    } catch (error) {
      console.warn('[VoiceStageView] Could not copy video diagnostics', error);
      if (request === this.telemetryCopyRequest && button.isConnected) {
        void showAlert({ message: t('stage.telemetryCopyFailed'), variant: 'danger' });
      }
      return;
    }
    if (request === this.telemetryCopyRequest && button.isConnected) {
      this.clearTelemetryToast = showCopyToast(t('stage.telemetryCopied'));
    }
  }

  private applyTelemetryOverlayState(): void {
    this.container.querySelectorAll<HTMLButtonElement>('.stage-diagnostics-btn').forEach(button => {
      button.hidden = !settingsStore.screenShareTelemetryEnabled;
      const snapshot = this.telemetrySnapshots.get(button.dataset.diagnosticsKey ?? '');
      button.title = snapshot
        ? `${formatVideoTelemetry(snapshot, 'complete')}\n\n${t('stage.telemetryCopy')}`
        : t('stage.telemetryCopy');
    });
    const overlays = this.container.querySelectorAll('.telemetry-overlay');
    overlays.forEach((overlay) => {
      overlay.classList.remove(
        'position-top-left',
        'position-top-right',
        'position-bottom-left',
        'position-bottom-right'
      );
      overlay.classList.add(`position-${settingsStore.screenShareTelemetryPosition}`);
      overlay.classList.toggle('is-hidden', !settingsStore.screenShareTelemetryEnabled);
      const tileKey = overlay.getAttribute('data-telemetry-key');
      if (tileKey) {
        overlay.textContent = this.getTelemetryText(tileKey);
      }
    });
  }

  /**
   * Video tiles currently on the stage — every screen share plus every camera
   * (#493). Built the same way as `buildStageTiles` so the keys match the
   * overlays already in the DOM (#340).
   */
  private getTelemetryTiles(): ParticipantStageTile[] {
    if (!this.currentChannelId) return [];
    const tiles: ParticipantStageTile[] = [];
    for (const p of participantManager.getInVoiceChannel(this.currentChannelId)) {
      const isLocal = serverStore.isMySession(p.user.sessionId);
      const isCamOn = isLocal ? voiceStore.isCameraOn : (p.voiceState?.isCameraOn ?? false);
      if (isCamOn) tiles.push({ p, kind: 'camera', key: `${sidOf(p)}:camera` });
      for (const shareId of this.getShareIds(p, isLocal)) {
        const key = `${sidOf(p)}:screen:${shareId}`;
        if (isLocal || this.isWatchingScreen(sidOf(p), shareId)) {
          tiles.push({ p, kind: 'screen', key, shareId });
        }
      }
    }
    return tiles;
  }

  private hasTelemetryTiles(): boolean {
    return this.getTelemetryTiles().length > 0;
  }

  private syncTelemetryMonitor(): void {
    if (!this.currentChannelId || !settingsStore.screenShareTelemetryEnabled || !this.hasTelemetryTiles()) {
      this.stopTelemetryMonitor();
      this.applyTelemetryOverlayState();
      return;
    }

    if (this.telemetryInterval !== null) {
      this.applyTelemetryOverlayState();
      return;
    }

    const tick = () => {
      void this.refreshTelemetry();
    };

    tick();
    this.telemetryInterval = window.setInterval(tick, 1500);
  }

  private async refreshTelemetry(): Promise<void> {
    if (this.telemetryRefreshInFlight || !this.currentChannelId || !settingsStore.screenShareTelemetryEnabled) {
      return;
    }

    const epoch = this.telemetryEpoch;
    this.telemetryRefreshInFlight = true;
    try {
      const videoTiles = this.getTelemetryTiles();
      if (videoTiles.length === 0) {
        this.stopTelemetryMonitor();
        this.applyTelemetryOverlayState();
        return;
      }

      const targets = new Set<object>();
      const samples = await Promise.all(videoTiles.map(async tile => ({
        key: tile.key,
        snapshot: await this.collectTelemetrySnapshot(tile, epoch, targets),
      })));
      if (epoch !== this.telemetryEpoch) return;

      const nextSnapshots = new Map<string, VideoTelemetrySnapshot>();
      for (const sample of samples) {
        if (sample.snapshot) {
          nextSnapshots.set(sample.key, sample.snapshot);
          const history = this.telemetryHistory.get(sample.key) ?? [];
          history.push(sample.snapshot);
          if (history.length > MAX_TELEMETRY_SAMPLES) history.shift();
          this.telemetryHistory.set(sample.key, history);
        }
      }
      for (const key of this.telemetryHistory.keys()) {
        if (!nextSnapshots.has(key)) this.telemetryHistory.delete(key);
      }
      this.telemetrySnapshots = nextSnapshots;
      this.telemetrySampler.retainTargets(targets);
      this.nativeDecoderSampler.retainTargets(targets);
      for (const [key, target] of this.nativeTelemetryTargets) {
        if (!targets.has(target)) this.nativeTelemetryTargets.delete(key);
      }
      for (const target of this.telemetryEndpoints.keys()) {
        if (!targets.has(target)) this.telemetryEndpoints.delete(target);
      }
      this.applyTelemetryOverlayState();
    } finally {
      if (epoch === this.telemetryEpoch) this.telemetryRefreshInFlight = false;
    }
  }

  private getTelemetryTrack(tile: ParticipantStageTile): MediaStreamTrack | null {
    if (tile.kind === 'voice') return null;
    const isLocal = serverStore.isMySession(tile.p.user.sessionId);
    const stream = isLocal
      ? tile.kind === 'camera' ? videoService.getCameraStream()
        : tile.shareId ? videoService.getScreenStream(tile.shareId) : null
      : tile.kind === 'camera' ? tile.p.remoteStream : this.getRemoteScreenStream(tile);
    return stream?.getVideoTracks()[0] ?? null;
  }

  private telemetryEndpoint(target: object): number {
    let endpoint = this.telemetryEndpoints.get(target);
    if (endpoint === undefined) {
      endpoint = this.nextTelemetryEndpoint++;
      this.telemetryEndpoints.set(target, endpoint);
    }
    return endpoint;
  }

  private nativeTelemetryTarget(key: string, targets: Set<object>): object {
    let target = this.nativeTelemetryTargets.get(key);
    if (!target) { target = {}; this.nativeTelemetryTargets.set(key, target); }
    targets.add(target);
    return target;
  }

  private nativeTelemetrySource(tile: ParticipantStageTile): NativeScreenSource | null {
    if (tile.kind !== 'screen' || !tile.shareId) return null;
    return serverStore.isMySession(tile.p.user.sessionId)
      ? videoService.getNativeScreenCapture(tile.shareId)?.source ?? null
      : webRtcManager.getNativeScreenSource(sidOf(tile.p), tile.shareId);
  }

  private async collectTelemetrySnapshot(
    tile: ParticipantStageTile,
    epoch: number,
    targets: Set<object>
  ): Promise<VideoTelemetrySnapshot | null> {
    const track = this.getTelemetryTrack(tile);
    const nativeSource = this.nativeTelemetrySource(tile);
    if ((!track || track.readyState !== 'live') && !nativeSource) return null;
    const isLocal = serverStore.isMySession(tile.p.user.sessionId);
    const profile = videoService.getProfile();
    const settings = isLocal && !nativeSource ? track?.getSettings() : null;
    const isCamera = tile.kind === 'camera';
    const snapshot: VideoTelemetrySnapshot = {
      kind: isLocal ? 'sender' : 'receiver',
      media: isCamera ? 'camera' : 'screen',
      transport: webRtcManager.isSfuMode() ? 'sfu' : 'p2p',
      sampledAt: new Date().toISOString(),
      documentVisibility: document.visibilityState,
      requested: nativeSource ? { width: nativeSource.video.width, height: nativeSource.video.height,
        fps: nativeSource.video.fps, bitrateKbps: nativeSource.video.maxBitrateKbps } : isLocal ? {
        width: isCamera ? profile.cameraWidth : profile.screenWidth,
        height: isCamera ? profile.cameraHeight : profile.screenHeight,
        fps: isCamera ? profile.cameraFps : profile.screenFps,
        bitrateKbps: isCamera ? profile.cameraBitrateKbps : profile.screenBitrateKbps,
      } : null,
      capture: settings && track ? {
        width: settings.width ?? null,
        height: settings.height ?? null,
        configuredFps: settings.frameRate ?? null,
        contentHint: track.contentHint,
        readyState: track.readyState,
      } : null,
      streams: [],
      playback: null,
      readErrors: 0,
    };

    const videos = Array.from(this.container.querySelectorAll<HTMLVideoElement>('[data-video-tile-key]'))
      .filter(video => video.dataset.videoTileKey === tile.key);
    const video = videos.find(element => !element.closest('.stage-mini-card')) ?? videos[0];
    if (track && video?.srcObject instanceof MediaStream
      && video.srcObject.getVideoTracks().some(playingTrack => playingTrack.id === track.id)
      && typeof video.getVideoPlaybackQuality === 'function') {
      targets.add(video);
      const quality = video.getVideoPlaybackQuality();
      snapshot.playback = this.telemetrySampler.samplePlayback(video, {
        timestampMs: performance.now(),
        totalFrames: quality.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames,
        sourceKey: track.id,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
      });
    }

    if (nativeSource && tile.shareId) {
      try {
        const diagnostics = await webRtcManager.getScreenVideoDiagnostics(sidOf(tile.p), tile.shareId);
        if (epoch !== this.telemetryEpoch || this.nativeTelemetrySource(tile)?.instanceId !== nativeSource.instanceId
          || this.getTelemetryTrack(tile) !== track) return null;
        if (!diagnostics) return snapshot;
        if (diagnostics.source.instanceId !== nativeSource.instanceId) return null;
        snapshot.nativeScreen = { receiver: isLocal ? null : diagnostics.backend,
          waitingForViewers: diagnostics.backend === 'native' && diagnostics.viewers === 0, decoders: [] };
        if (diagnostics.backend === 'browser') {
          const { target, reports, profile: selected } = diagnostics;
          snapshot.requested = { width: selected.width, height: selected.height, fps: selected.fps, bitrateKbps: selected.maxBitrateKbps };
          targets.add(target);
          if (reports) snapshot.streams = this.telemetrySampler.sampleInbound(target, reports, nativeSource.instanceId)
            .map(data => ({ endpoint: this.telemetryEndpoint(target), data }));
        } else {
          for (const observation of diagnostics.endpoints) {
            snapshot.readErrors += observation.readErrors;
            const selected = observation.profile;
            if (!isLocal) {
              snapshot.requested = { width: selected.width, height: selected.height, fps: selected.fps, bitrateKbps: selected.maxBitrateKbps };
              const target = this.nativeTelemetryTarget(`decoder:${observation.pipelineId}`, targets);
              snapshot.nativeScreen.decoders.push({ endpoint: this.telemetryEndpoint(target),
                data: this.nativeDecoderSampler.sample(target, observation.decoders) });
            }
            for (const observationRtp of observation.rtp) {
              const target = this.nativeTelemetryTarget(`rtp:${observation.pipelineId}:${observationRtp.id}`, targets);
              const reports = new Map(observationRtp.reports.map(report => [report.id, report]));
              const streams = isLocal
                ? this.telemetrySampler.sampleOutbound(target, reports, {
                  encodings: [{ maxBitrate: selected.maxBitrateKbps * 1000, maxFramerate: selected.fps }],
                }, nativeSource.instanceId)
                : this.telemetrySampler.sampleInbound(target, reports, nativeSource.instanceId);
              snapshot.streams.push(...streams.map(data => ({ endpoint: this.telemetryEndpoint(target), data })));
            }
          }
        }
      } catch (error) {
        if (epoch === this.telemetryEpoch) {
          snapshot.readErrors++;
          console.warn('[VoiceStageView] Could not read native screen diagnostics', error);
        }
      }
      return epoch === this.telemetryEpoch && this.nativeTelemetrySource(tile)?.instanceId === nativeSource.instanceId
        && this.getTelemetryTrack(tile) === track ? snapshot : null;
    }

    if (!track) return null;
    if (isLocal) {
      const getSenders = (): RTCRtpSender[] => isCamera
        ? webRtcManager.getCameraSenders()
        : tile.shareId ? webRtcManager.getScreenSendersForShare(tile.shareId) : [];
      const streams = await Promise.all(getSenders().map(async sender => {
        targets.add(sender);
        const endpoint = this.telemetryEndpoint(sender);
        const sendingTrack = sender.track;
        try {
          const stats = await sender.getStats();
          if (epoch !== this.telemetryEpoch || sender.track !== sendingTrack
            || this.getTelemetryTrack(tile) !== track || !getSenders().includes(sender)) return [];
          return this.telemetrySampler.sampleOutbound(sender, stats, sender.getParameters(), track.id)
            .map(data => ({ endpoint, data }));
        } catch (error) {
          if (epoch === this.telemetryEpoch) {
            snapshot.readErrors++;
            console.warn('[VoiceStageView] Could not read sender diagnostics', error);
          }
          return [];
        }
      }));
      snapshot.streams = streams.flat();
    } else {
      const receiver = webRtcManager.getReceiverForTrack(sidOf(tile.p), track.id);
      if (receiver) {
        targets.add(receiver);
        const endpoint = this.telemetryEndpoint(receiver);
        try {
          const stats = await receiver.getStats();
          if (epoch !== this.telemetryEpoch || this.getTelemetryTrack(tile) !== track
            || webRtcManager.getReceiverForTrack(sidOf(tile.p), track.id) !== receiver) return null;
          snapshot.streams = this.telemetrySampler.sampleInbound(receiver, stats, track.id)
            .map(data => ({ endpoint, data }));
        } catch (error) {
          if (epoch === this.telemetryEpoch) {
            snapshot.readErrors++;
            console.warn('[VoiceStageView] Could not read receiver diagnostics', error);
          }
        }
      }
    }
    return epoch === this.telemetryEpoch && this.getTelemetryTrack(tile) === track ? snapshot : null;
  }

  private stopTelemetryMonitor(): void {
    this.telemetryEpoch++;
    this.telemetryRefreshInFlight = false;
    if (this.telemetryInterval !== null) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
    this.telemetrySnapshots.clear();
    this.telemetryHistory.clear();
    this.telemetrySampler.clear();
    this.nativeDecoderSampler.clear();
    this.nativeTelemetryTargets.clear();
    this.telemetryEndpoints.clear();
    this.nextTelemetryEndpoint = 1;
    this.telemetryCopyRequest++;
    this.clearTelemetryToast?.();
    this.clearTelemetryToast = null;
  }

  private startPingMonitor(): void {
    this.stopPingMonitor();

    const updatePing = async () => {
      const pingBadge = document.getElementById('stage-ping-badge');
      const pingText = document.getElementById('stage-ping-text');
      const tooltipContent = document.getElementById('ping-tooltip-content');

      if (!pingBadge || !pingText || !this.currentChannelId) return;

      if (voiceStore.isConnecting || voiceStore.isReconnecting) {
        pingText.textContent = t(voiceStore.isConnecting ? 'main.connecting' : 'main.reconnecting');
        pingBadge.className = `stage-ping-badge ${voiceStore.isConnecting ? 'connecting' : 'medium'}`;
        if (tooltipContent) tooltipContent.textContent = t(voiceStore.isConnecting ? 'main.connectingTitle' : 'main.reconnectingTitle');
        return;
      }

      const isSfu = webRtcManager.isSfuMode();
      const participants = participantManager.getInVoiceChannel(this.currentChannelId);
      const isSolo = participants.length <= 1;

      if (isSolo && !isSfu) {
        pingBadge.className = 'stage-ping-badge good';
        pingText.textContent = '0 ms';
        if (tooltipContent) {
          tooltipContent.innerHTML = `
            ${t('stage.tooltipSolo')}
          `;
        }
        return;
      }

      const avgPing = await webRtcManager.getAverageP2pPing();
      if (!pingBadge.isConnected || voiceStore.isConnecting || voiceStore.isReconnecting) return;
      const indicator = voiceConnectionIndicator(avgPing, voiceStore.isReconnecting);

      if (avgPing !== null) {
        pingText.textContent = `${avgPing} ms`;

        let quality = t('stage.qualityExcellentShort');
        if (indicator.quality === 'good') {
          pingBadge.className = 'stage-ping-badge good';
          quality = t('stage.qualityExcellent');
        } else if (indicator.quality === 'medium') {
          pingBadge.className = 'stage-ping-badge medium';
          quality = t('stage.qualityGood');
        } else {
          pingBadge.className = 'stage-ping-badge bad';
          quality = t('stage.qualityPoor');
        }

        if (tooltipContent) {
          const tooltipKey = isSfu ? 'stage.tooltipPingSfu' : 'stage.tooltipPing';
          tooltipContent.innerHTML = `
            ${t(tooltipKey, { ping: avgPing, quality })}
          `;
        }
      } else {
        pingText.textContent = isSfu ? 'SFU' : 'P2P';
        pingBadge.className = 'stage-ping-badge unknown';
        if (tooltipContent) {
          tooltipContent.innerHTML = isSfu ? t('stage.tooltipEstablishingSfu') : t('stage.tooltipEstablishing');
        }
      }
    };

    updatePing();
    this.pingInterval = setInterval(updatePing, 2000);
  }

  private stopPingMonitor(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Leaves the current voice call. Public so it can also be triggered from the
   * sidebar voice-connection row (#60). No confirmation is shown (#59).
   */
  public leaveVoice(): void {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId) return;
    this.stopPingMonitor();
    this.stopTelemetryMonitor();
    soundEffects.play('leave_voice');
    leaveCurrentCall();
    this.setChannel(null);
  }

  private async handleStopStreaming(): Promise<void> {
    if (voiceStore.isScreenSharing) {
      try {
        await stopLocalScreenShares(screenAudioService);
      } catch (error) {
        await showAlert({
          title: t('screenShare.errorTitle'),
          message: t('screenShare.errorMessage', { error: error instanceof Error ? error.message : String(error) }),
          variant: 'danger',
        });
      }
    } else if (voiceStore.isCameraOn) {
      this.cameraToggleEpoch++;
      this.cameraTogglePending = false;
      setLocalCameraState(false);
      videoService.stopCamera();
      await webRtcManager.setLocalCameraTrack(null);
    }
    this.updateControlsUI();
    this.renderParticipants();
  }

  /**
   * Toggles the local camera. Extracted so it can be triggered both from the
   * stage controls and from the sidebar media bar (#29). Camera and screen
   * share are independent (#26): toggling the camera never stops an active
   * screen share. Cleanly reverts state if the camera fails to start (e.g. no
   * camera plugged in).
   */
  public async toggleCamera(): Promise<void> {
    const epoch = ++this.cameraToggleEpoch;
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const isCurrentCall = () => this.cameraToggleEpoch === epoch && channelId !== null
      && voiceStore.currentVoiceChannelId === channelId && voiceStore.voiceSessionKey === sessionKey;
    if (!channelId) return;
    if (voiceStore.isCameraOn || this.cameraTogglePending) {
      this.cameraTogglePending = false;
      setLocalCameraState(false);
      videoService.stopCamera();
      try {
        await webRtcManager.setLocalCameraTrack(null);
      } catch (error) {
        reportCameraError(error);
      }
    } else {
      this.cameraTogglePending = true;
      try {
        const stream = await videoService.startCamera();
        const track = stream.getVideoTracks()[0];
        const isCurrent = () => isCurrentCall() && videoService.getCameraStream() === stream;
        if (!track || !isCurrent()) throw new DOMException('Camera start was cancelled', 'AbortError');
        await webRtcManager.setLocalCameraTrack(track, isCurrent);
        if (isCurrent()) setLocalCameraState(true);
      } catch (error) {
        if (isCurrentCall() && !isCameraOperationCancelled(error)) {
          setLocalCameraState(false);
          videoService.stopCamera();
          await webRtcManager.setLocalCameraTrack(null).catch(reportCameraError);
          reportCameraError(error);
        }
      } finally {
        if (this.cameraToggleEpoch === epoch) this.cameraTogglePending = false;
      }
    }
    this.updateControlsUI();
    this.renderParticipants();
  }

  private attachEvents(): void {
    for (const shareId of voiceStore.screenShareIds) {
      const stream = videoService.getScreenStream(shareId);
      if (stream) this.seenScreenStarts.add(stream);
    }
    this.unbindEvents.push(bindStageControlsMotion(this.container));
    const btnMic = document.getElementById('stage-btn-mic');
    const btnDeafen = document.getElementById('stage-btn-deafen');
    const btnCam = document.getElementById('stage-btn-camera');
    const btnScreen = document.getElementById('stage-btn-screen');
    const btnStopShare = document.getElementById('stage-btn-stop-share');
    const btnLeave = document.getElementById('stage-btn-leave');

    btnMic?.addEventListener('click', () => {
      toggleMicrophoneMute();
      this.updateControlsUI();
      this.renderParticipants();
    });

    btnDeafen?.addEventListener('click', () => {
      toggleAudioDeafen();
      this.updateControlsUI();
      this.renderParticipants();
    });

    btnCam?.addEventListener('click', async () => {
      if (isButtonLoading(btnCam)) return;
      setButtonLoading(btnCam, true);
      try {
        await this.toggleCamera();
      } finally {
        setButtonLoading(btnCam, false);
      }
    });

    btnScreen?.addEventListener('click', () => {
      if (isButtonLoading(btnScreen)) return;
      // Show a loading state until the picker modal is actually open (#48).
      setButtonLoading(btnScreen, true);
      window.setTimeout(() => setButtonLoading(btnScreen, false), 10000);
      // Always open the picker: when not sharing, to start; when already
      // sharing, to switch source. Stopping lives on the dedicated button (#264).
      appEvents.emit('modal.open_screenshare_picker');
    });

    btnStopShare?.addEventListener('click', async () => {
      if (isButtonLoading(btnStopShare)) return;
      setButtonLoading(btnStopShare, true);
      try {
        await this.handleStopStreaming();
      } finally {
        setButtonLoading(btnStopShare, false);
      }
    });

    const btnOverlay = document.getElementById('stage-btn-overlay');
    btnOverlay?.addEventListener('click', () => {
      overlayConfigModal.open();
    });

    const btnSoundboard = document.getElementById('stage-btn-soundboard');
    btnSoundboard?.addEventListener('click', () => {
      soundboardModal.open();
    });

    btnLeave?.addEventListener('click', () => this.leaveVoice());

    // Listeners that do NOT destroy the DOM
    const u1 = appEvents.on('participants.updated', () => {
      this.renderParticipants();
    });

    const u2 = appEvents.on('voice.state_updated', () => {
      this.updateControlsUI();
      this.updateSpeakingClasses();
      this.applyTelemetryOverlayState();
      this.syncTelemetryMonitor();
      this.refreshLocalCameraVideo();
      this.focusStartedScreens();
    });

    const u3 = appEvents.on('participants.speaking_changed', (data: { sessionId: string; speaking: boolean }) => {
      this.setCardSpeaking(data.sessionId);
    });

    const u4 = appEvents.on('voice.speaking_changed', () => {
      this.updateSpeakingClasses();
    });

    // Clear the screen-share button loading once the picker modal is open (or
    // closed, as a safety) — loading should last only until the modal opens (#48).
    const clearScreenLoading = () => setButtonLoading(btnScreen, false);
    const u5 = appEvents.on('modal.screenshare_picker_opened', clearScreenLoading);
    const u6 = appEvents.on('modal.screenshare_picker_closed', clearScreenLoading);
    const u7 = appEvents.on('settings.updated', () => {
      this.applyTelemetryOverlayState();
      this.syncTelemetryMonitor();
    });

    const u8 = appEvents.on('local.screen_audio_started', () => this.updateControlsUI());
    const u9 = appEvents.on('local.screen_audio_stopped', () => this.updateControlsUI());
    const u10 = appEvents.on('overlay.state_changed', () => this.updateControlsUI());
    // Arming "open on leaving the stage" turns the overlay on without opening a
    // window, so the stage controls have to follow the setting too (#169).
    const u13 = appEvents.on('overlay_settings.updated', () => this.updateControlsUI());

    const u11 = appEvents.on('voice.mode_switched', () => {
      this.stopTelemetryMonitor();
      this.updateHeaderModeBadge();
      this.renderParticipants();
    });
    const u12 = appEvents.on('server.meta_updated', () => {
      this.updateHeaderModeBadge();
    });

    // `remote.peer_failed` / `remote.peer_recovered` are not handled here on
    // purpose: WebRtcManager writes the flag straight into the participant
    // manager of the server hosting the call. Doing it from a view would both
    // lose the warning whenever the stage happens to be unmounted and, while
    // browsing another server during a call (#400), write it onto the wrong
    // server's participants (#426).

    const u14 = appEvents.on('voice.connection_changed', () => this.startPingMonitor());
    const u15 = appEvents.on('server.voice_restrictions_updated', () => this.updateControlsUI());
    const u16 = appEvents.on('camera.state_changed', () => this.refreshLocalCameraVideo());
    const u17 = appEvents.on<VoiceBotScreensUpdated | undefined>('voice.bot_screens_updated', (update) => {
      if (update) this.notifyMiniappEnded(update);
      this.renderParticipants();
    });
    const u18 = appEvents.on('voice.channel_changed', () => {
      this.focusEpoch++;
      this.pendingScreenFocus.clear();
      this.clearFocusError();
      this.renderParticipants();
    });
    const u19 = appEvents.on('session.voice_context_updated', () => this.renderParticipants());
    const u20 = appEvents.on('server.updated', () => this.renderParticipants());
    const u21 = appEvents.on('server.roles_updated', () => this.renderParticipants());
    const u22 = appEvents.on('voice.screen_watch_changed', () => this.renderParticipants());
    const u23 = appEvents.on('native_screen.updated', () => this.refreshNativeScreenState());
    const u24 = appEvents.on('local.screen_started', (start: { shareId: string; stream: MediaStream }) => this.queueScreenStartFocus(start));
    const u25 = appEvents.on('local.screen_stopped', (shareId: string) => this.pendingScreenFocus.delete(shareId));
    this.unbindEvents.push(u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12, u13, u14, u15, u16, u17, u18, u19, u20, u21, u22, u23, u24, u25);
    const area = this.container.querySelector('#stage-content-area');
    const position = () => {
      this.positionBotScreens();
      if (!document.fullscreenElement) this.clearFocusError();
    };
    area?.addEventListener('scroll', position, true);
    document.addEventListener('fullscreenchange', position);
    this.unbindEvents.push(() => {
      area?.removeEventListener('scroll', position, true);
      document.removeEventListener('fullscreenchange', position);
    });
  }

  private updateHeaderModeBadge(): void {
    const wrapper = document.getElementById('stage-header-mode-badge-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = webRtcManager.isSfuMode()
      ? `<div class="header-status-badge sfu-mode-badge" style="background-color: rgba(88, 101, 242, 0.15); color: var(--accent-primary); display: flex; align-items: center; gap: 6px;" title="${t('stage.sfuModeTooltip')}">
           <span class="material-symbols-outlined md-14">hub</span>
           <span>${t('stage.connectedSfu')}</span>
         </div>`
      : `<div class="header-status-badge p2p-mode-badge" style="background-color: rgba(35, 165, 90, 0.15); color: var(--success); display: flex; align-items: center; gap: 6px;" title="${t('stage.p2pModeTooltip')}">
           <span class="material-symbols-outlined md-14">wifi_tethering</span>
           <span>${t('stage.connectedMesh')}</span>
         </div>`;
  }

  private unbindTelemetryControls(): void {
    this.unbindTelemetryButtons.forEach(unbind => unbind());
    this.unbindTelemetryButtons = [];
  }

  private unbindListeners(): void {
    this.botScreenLayoutObserver?.disconnect();
    this.unbindTelemetryControls();
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
  }

  public destroy(): void {
    this.releaseStageVideos(this.container);
    this.focusEpoch++;
    this.pendingScreenFocus.clear();
    this.clearFocusError();
    this.stopPingMonitor();
    this.stopTelemetryMonitor();
    this.unbindListeners();
    this.closeBotScreens();
  }
}
