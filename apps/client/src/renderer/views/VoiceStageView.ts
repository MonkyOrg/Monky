import { MessageType } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { networkClient } from '../core/NetworkClient';
import { callClient } from '../core/serverConnection';
import { participantManager, ParticipantViewModel } from '../core/ParticipantManager';
import { screenAudioService } from '../core/ScreenAudioService';
import { serverStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore, VoiceStore } from '../stores/voiceStore';
import { audioProcessor } from '../core/AudioProcessor';
import { videoService } from '../core/VideoService';
import { webRtcManager } from '../core/WebRtcManager';
import { soundEffects } from '../core/SoundEffects';
import { getAvatarUrl } from '../utils/avatar';
import { peerFailureTooltip } from '../utils/peerFailureHint';
import { participantConnectionIndicators, voiceConnectionIndicator } from '../utils/voiceConnection';
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
import { formatVideoTelemetry, serializeVideoTelemetry, VideoTelemetrySnapshot } from './VideoTelemetry';
import { showCopyToast } from './CopyToast';
import { t } from '../i18n';

/**
 * A single renderable tile on the stage. A participant contributes one tile per
 * active media source, so someone sharing camera + screen at once shows up as
 * two independent tiles (#26). Participants with no video get a single 'voice'
 * (avatar) tile.
 */
type StageTileKind = 'voice' | 'camera' | 'screen';
interface StageTile {
  p: ParticipantViewModel;
  kind: StageTileKind;
  key: string; // `${sessionId}:${kind}` (+ `:${shareId}` for screens) — stable identity for focus/DOM keys
  /** Which screen share this tile renders, for 'screen' tiles only (#253). */
  shareId?: string;
}

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
  /** Zoom/pan state of the focused screen share, reset when focus changes (#271). */
  private focusZoom = { scale: 1, x: 0, y: 0 };
  private focusZoomTileKey: string | null = null;
  private suppressCardClickUntil = 0;
  // #150: remote screen shares are gated behind an explicit "Assistir
  // transmissão". Keyed by stage tile key (`${sessionId}:screen:${shareId}`) so
  // each of a peer's shares is opted into separately (#253). These sets survive
  // innerHTML re-renders (instance state).
  private watchingShareKeys: Set<string> = new Set();
  // Screen audio is capped at one stream per participant (#253), so the
  // explicit mute stays keyed by user id — it matches the <audio> element.
  private mutedScreenSessionIds: Set<string> = new Set();
  private pingInterval: any = null;
  private telemetryInterval: number | null = null;
  private telemetryEpoch = 0;
  private telemetryRefreshInFlight = false;
  private telemetrySnapshots = new Map<string, VideoTelemetrySnapshot>();
  private telemetryHistory = new Map<string, VideoTelemetrySnapshot[]>();
  private telemetrySampler = new VideoDiagnosticsSampler();
  private telemetryEndpoints = new Map<object, number>();
  private nextTelemetryEndpoint = 1;
  private telemetryCopyRequest = 0;
  private clearTelemetryToast: (() => void) | null = null;
  private unbindTelemetryButtons: Array<() => void> = [];
  // Caches the current live-banner content so updateControlsUI() only rebuilds
  // it when the broadcast state actually changes, preventing the pulse dot from
  // flickering on frequent voice.state_updated events (#70).
  private broadcastBannerSignature: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public setChannel(channelId: string | null): void {
    if (channelId !== this.currentChannelId) this.stopTelemetryMonitor();
    this.currentChannelId = channelId;
    this.focusedTileKeys = [];
    if (!channelId) {
      this.stopTelemetryMonitor();
    }
    this.render();
  }

  /**
   * Opts into a remote screen share from outside the stage (#282). Clicking the
   * sidebar notice is itself the explicit consent required by #150, so the
   * broadcast starts unblurred and focused. Must run after the stage DOM exists
   * (i.e. after `setChannel`), since it re-renders the participant tiles.
   */
  public watchScreenShare(sessionId: string): void {
    const participant = participantManager
      .getInVoiceChannel(this.currentChannelId ?? '')
      .find((p) => sidOf(p) === sessionId);
    if (!participant) return;

    // The notice covers the participant, not a specific share, so opt into all
    // of their shares and focus the first one (#253).
    const shareIds = this.getShareIds(participant, false);
    if (shareIds.length === 0) return;

    for (const shareId of shareIds) {
      this.watchingShareKeys.add(`${sessionId}:screen:${shareId}`);
    }
    this.mutedScreenSessionIds.delete(sessionId);
    this.focusedTileKeys = [`${sessionId}:screen:${shareIds[0]}`];
    this.renderParticipants();
  }

  public render(): void {
    this.stopPingMonitor();
    this.stopTelemetryMonitor();
    this.unbindListeners();

    if (!this.currentChannelId || !serverStore.serverDetails) {
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
    this.container.innerHTML = `
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
        <div id="stage-content-area" style="flex: 1; min-height: 0; display: flex; flex-direction: column;"></div>

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
      const hasScreenAudio = screenAudioService.getIsCapturing();
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
      const hasScreenAudio = screenAudioService.getIsCapturing();
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
      const hasScreenAudio = screenAudioService.getIsCapturing();
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
    if (!this.currentChannelId) return;
    const participants = participantManager.getInVoiceChannel(this.currentChannelId);
    participants.forEach((p) => {
      const isLocal = serverStore.isMySession(p.user.sessionId);
      const isSpeaking = isLocal ? voiceStore.isSpeaking : p.isSpeaking;
      this.setCardSpeaking(sidOf(p), isSpeaking);
    });
  }

  private setCardSpeaking(sessionId: string, isSpeaking: boolean): void {
    // Update every non-screen tile for the session (it may show a voice or
    // camera tile; the screen tile never pulses on speech — #26).
    const cards = document.querySelectorAll(`[data-session-id="${sessionId}"][data-kind]:not([data-kind="screen"])`);
    cards.forEach((card) => {
      if (isSpeaking) {
        card.classList.add('speaking');
      } else {
        card.classList.remove('speaking');
      }
    });
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

    if (this.focusedTileKeys.length > 0) {
      if (isFocused) {
        this.focusedTileKeys = this.focusedTileKeys.filter((key) => key !== tileKey);
      } else {
        this.focusedTileKeys = [...this.focusedTileKeys, tileKey].slice(-MAX_FOCUSED_TILES);
      }
      return;
    }

    this.focusedTileKeys = [tileKey];
  }

  /**
   * Resolves the remote stream backing a screen tile. Pre-#253 peers announce
   * their real MediaStream id over `screen-video-meta` but never publish a
   * `screenShareIds` list, so their tile is keyed by LEGACY_SHARE_ID and has to
   * fall back to whichever single screen stream arrived for that user.
   */
  private getRemoteScreenStream(tile: StageTile): MediaStream | undefined {
    const streams = tile.p.remoteScreenStreams;
    if (tile.shareId === LEGACY_SHARE_ID) {
      return streams.values().next().value;
    }
    return streams.get(tile.shareId!);
  }

  /** Stable, unique DOM id fragment for a tile — screens differ by share (#253). */
  private tileDomId(tile: StageTile): string {
    return tile.kind === 'screen'
      ? `${sidOf(tile.p)}-screen-${tile.shareId}`
      : `${sidOf(tile.p)}-${tile.kind}`;
  }

  /** True when at least one of the participant's shares was opted into (#253). */
  private isWatchingAnyShare(p: ParticipantViewModel): boolean {
    return this.getShareIds(p, false).some((shareId) =>
      this.watchingShareKeys.has(`${sidOf(p)}:screen:${shareId}`)
    );
  }

  private isTileSpeaking(tile: StageTile): boolean {
    // The speaking glow reflects the microphone; a pure screen tile shouldn't
    // pulse when the user talks (their camera/voice tile already does).
    if (tile.kind === 'screen') return false;
    return serverStore.isMySession(tile.p.user.sessionId) ? voiceStore.isSpeaking : tile.p.isSpeaking;
  }

  public renderParticipants(): void {
    this.unbindTelemetryControls();
    const area = document.getElementById('stage-content-area');
    if (!area || !this.currentChannelId) return;

    const participants = participantManager.getInVoiceChannel(this.currentChannelId);
    if (participants.length === 0) {
      area.innerHTML = `
        <div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-muted);">
          Aguardando outros amigos entrarem na chamada...
        </div>
      `;
      return;
    }

    const currentSessionId = serverStore.currentUser?.sessionId || serverStore.currentUser?.id;

    // #150: reset watch-state for any share that is no longer being broadcast
    // so a fresh broadcast is gated behind "Assistir transmissão" again; also
    // drop the broadcaster's explicit screen-audio mute once they stop entirely.
    const liveShareKeys = new Set<string>();
    for (const p of participants) {
      if (sidOf(p) === currentSessionId) continue;
      for (const shareId of this.getShareIds(p, false)) {
        liveShareKeys.add(`${sidOf(p)}:screen:${shareId}`);
      }
    }
    for (const watchedKey of [...this.watchingShareKeys]) {
      if (!liveShareKeys.has(watchedKey)) {
        this.watchingShareKeys.delete(watchedKey);
      }
    }
    for (const mutedSessionId of [...this.mutedScreenSessionIds]) {
      const stillSharing = [...liveShareKeys].some((key) => key.startsWith(`${mutedSessionId}:screen:`));
      if (!stillSharing) this.mutedScreenSessionIds.delete(mutedSessionId);
    }

    // A participant sharing camera + screens contributes one tile per source
    // (#26, #253); focus, speaking and DOM keys are keyed per tile.
    const tiles = this.buildStageTiles(participants, currentSessionId);

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
              <div class="stage-focused-main ${this.isTileSpeaking(focusedTile) ? 'speaking' : ''}" id="card-${this.tileDomId(focusedTile)}" data-session-id="${sidOf(focusedTile.p)}" data-kind="${focusedTile.kind}" data-tile-key="${focusedTile.key}">
                <div class="stage-focus-hint-badge">
                  <span class="material-symbols-outlined md-14">zoom_in</span>
                  <span>${t('stage.focusMode')}</span>
                </div>
                ${this.renderCardContent(focusedTile, true)}
              </div>
            `).join('')}
          </div>

          ${otherTiles.length > 0 ? `
            <div class="stage-focused-strip">
              ${otherTiles.map((tile) => {
                return `
                  <div class="stage-mini-card ${tile.kind === 'voice' ? '' : 'stage-mini-card--video'} ${this.isTileSpeaking(tile) ? 'speaking' : ''}" id="card-${this.tileDomId(tile)}" data-session-id="${sidOf(tile.p)}" data-kind="${tile.kind}" data-tile-key="${tile.key}" title="${t('stage.focusOn', { name: escapeHtml(participantManager.displayName(tile.p)) })}">
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
              <div class="stage-card ${tile.kind === 'voice' ? '' : 'stage-card--video'} ${this.isTileSpeaking(tile) ? 'speaking' : ''}" id="card-${this.tileDomId(tile)}" data-session-id="${sidOf(tile.p)}" data-kind="${tile.kind}" data-tile-key="${tile.key}" title="${t('stage.focusHint')}">
                ${this.renderCardContent(tile, false, false)}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // #150: gate remote screen audio behind the "Assistir transmissão" opt-in
    // while preserving explicit per-user mutes. The <audio> elements are created
    // by WebRtcManager on document.body and persist across these re-renders.
    participants.forEach((p) => {
      if (sidOf(p) === currentSessionId) return;
      if (this.getShareIds(p, false).length === 0) return;
      const audioEl = document.querySelector(`audio[data-screen-audio-session="${sidOf(p)}"]`) as HTMLAudioElement | null;
      if (!audioEl) return;
      webRtcManager.setScreenAudioMuted(sidOf(p), !this.isWatchingAnyShare(p) || this.mutedScreenSessionIds.has(sidOf(p)));
    });

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
          this.renderParticipants();
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
        this.watchingShareKeys.add(`${sessionId}:screen:${shareId}`);
        this.mutedScreenSessionIds.delete(sessionId);
        this.focusedTileKeys = [`${sessionId}:screen:${shareId}`];
        this.renderParticipants();
      });
    });

    // #150: "Parar de assistir" — re-gate the broadcast (blur + silence) and
    // drop back to the grid.
    const stopWatchBtns = area.querySelectorAll('.stage-stopwatch-btn') as NodeListOf<HTMLButtonElement>;
    stopWatchBtns.forEach((btn) => {
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const sessionId = btn.getAttribute('data-stopwatch-session');
        const shareId = btn.getAttribute('data-stopwatch-share');
        if (!sessionId || !shareId) return;
        const tileKey = `${sessionId}:screen:${shareId}`;
        this.watchingShareKeys.delete(tileKey);
        this.focusedTileKeys = this.focusedTileKeys.filter((key) => key !== tileKey);
        this.renderParticipants();
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
      if (initSessionId && this.mutedScreenSessionIds.has(initSessionId)) {
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
        if (this.mutedScreenSessionIds.has(sessionId)) {
          this.mutedScreenSessionIds.delete(sessionId);
          webRtcManager.setScreenAudioMuted(sessionId, false);
          if (icon) icon.textContent = 'volume_up';
          btn.title = t('stage.screenAudioVolume');
          wrapper?.classList.remove('screen-audio-muted');
        } else {
          this.mutedScreenSessionIds.add(sessionId);
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
      if (tile.kind === 'voice') return;
      const isLocal = sidOf(tile.p) === currentSessionId;
      const stream = isLocal
        ? (tile.kind === 'screen' ? videoService.getScreenStream(tile.shareId!) : videoService.getCameraStream())
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
  }

  /** Removes the "loading video" overlay once the stream actually renders (#48). */
  private hideVideoLoadingWhenReady(videoEl: HTMLVideoElement, videoId: string): void {
    const overlay = document.getElementById(`loading-${videoId}`);
    if (!overlay) return;
    const hide = () => overlay.remove();
    if (videoEl.readyState >= 2) {
      hide();
      return;
    }
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
    const isWatching = this.watchingShareKeys.has(tile.key);
    // #150: a remote screen the local user has not opted into watching is
    // rendered blurred + silent behind an "Assistir transmissão" CTA. Applies
    // to screen tiles only — the camera tile always plays normally (#26).
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
        ${!isLocked ? `
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
        ${renderAudioMuteIndicators({ isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened })}
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
  private getTelemetryTiles(): StageTile[] {
    if (!this.currentChannelId) return [];
    const tiles: StageTile[] = [];
    for (const p of participantManager.getInVoiceChannel(this.currentChannelId)) {
      const isLocal = serverStore.isMySession(p.user.sessionId);
      const isCamOn = isLocal ? voiceStore.isCameraOn : (p.voiceState?.isCameraOn ?? false);
      if (isCamOn) tiles.push({ p, kind: 'camera', key: `${sidOf(p)}:camera` });
      for (const shareId of this.getShareIds(p, isLocal)) {
        const key = `${sidOf(p)}:screen:${shareId}`;
        if (isLocal || this.watchingShareKeys.has(key)) {
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
      for (const target of this.telemetryEndpoints.keys()) {
        if (!targets.has(target)) this.telemetryEndpoints.delete(target);
      }
      this.applyTelemetryOverlayState();
    } finally {
      if (epoch === this.telemetryEpoch) this.telemetryRefreshInFlight = false;
    }
  }

  private getTelemetryTrack(tile: StageTile): MediaStreamTrack | null {
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

  private async collectTelemetrySnapshot(
    tile: StageTile,
    epoch: number,
    targets: Set<object>
  ): Promise<VideoTelemetrySnapshot | null> {
    const track = this.getTelemetryTrack(tile);
    if (!track || track.readyState !== 'live') return null;
    const isLocal = serverStore.isMySession(tile.p.user.sessionId);
    const profile = videoService.getProfile();
    const settings = isLocal ? track.getSettings() : null;
    const isCamera = tile.kind === 'camera';
    const snapshot: VideoTelemetrySnapshot = {
      kind: isLocal ? 'sender' : 'receiver',
      media: isCamera ? 'camera' : 'screen',
      transport: webRtcManager.isSfuMode() ? 'sfu' : 'p2p',
      sampledAt: new Date().toISOString(),
      documentVisibility: document.visibilityState,
      requested: isLocal ? {
        width: isCamera ? profile.cameraWidth : profile.screenWidth,
        height: isCamera ? profile.cameraHeight : profile.screenHeight,
        fps: isCamera ? profile.cameraFps : profile.screenFps,
        bitrateKbps: isCamera ? profile.cameraBitrateKbps : profile.screenBitrateKbps,
      } : null,
      capture: settings ? {
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
    if (video?.srcObject instanceof MediaStream
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
    if (!this.currentChannelId) return;
    this.stopPingMonitor();
    this.stopTelemetryMonitor();
    soundEffects.play('leave_voice');
    callClient().send(MessageType.VOICE_LEAVE, { channelId: this.currentChannelId });
    audioProcessor.stopMicrophone();
    videoService.stopCamera();
    videoService.stopScreenShare();
    webRtcManager.clearLocalScreenTracks();
    webRtcManager.closeAllPeers();
    voiceStore.reset();
    this.setChannel(null);
  }

  private async handleStopStreaming(): Promise<void> {
    if (voiceStore.isScreenSharing) {
      videoService.stopScreenShare();
      await webRtcManager.removeAllLocalScreenTracks();
      voiceStore.setScreenSharing(false);
      callClient().send(MessageType.VOICE_STATE_UPDATE, {
        screenShareIds: [],
        isScreenSharing: false,
      });
      if (screenAudioService.getIsCapturing()) {
        await screenAudioService.stop();
      }
    } else if (voiceStore.isCameraOn) {
      videoService.stopCamera();
      await webRtcManager.setLocalCameraTrack(null);
      voiceStore.setCameraOn(false);
      callClient().send(MessageType.VOICE_STATE_UPDATE, { isCameraOn: false });
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
    if (voiceStore.isCameraOn) {
      videoService.stopCamera();
      await webRtcManager.setLocalCameraTrack(null);
      voiceStore.setCameraOn(false);
      callClient().send(MessageType.VOICE_STATE_UPDATE, { isCameraOn: false });
    } else {
      try {
        const stream = await videoService.startCamera();
        const track = stream.getVideoTracks()[0];
        await webRtcManager.setLocalCameraTrack(track);
        voiceStore.setCameraOn(true);
        callClient().send(MessageType.VOICE_STATE_UPDATE, { isCameraOn: true });
      } catch (err: any) {
        // Fully revert local camera state (screen share, if any, is untouched).
        videoService.stopCamera();
        await webRtcManager.setLocalCameraTrack(null);
        voiceStore.setCameraOn(false);
        callClient().send(MessageType.VOICE_STATE_UPDATE, { isCameraOn: false });
        await showAlert({
          title: t('stage.cameraErrorTitle'),
          message: t('stage.cameraErrorMessage', { error: err?.message || err }),
          variant: 'danger',
        });
      }
    }
    this.updateControlsUI();
    this.renderParticipants();
  }

  private attachEvents(): void {
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
    });

    const u3 = appEvents.on('participants.speaking_changed', (data: { sessionId: string; speaking: boolean }) => {
      this.setCardSpeaking(data.sessionId, data.speaking);
    });

    const u4 = appEvents.on('voice.speaking_changed', (speaking: boolean) => {
      if (serverStore.currentUser) {
        this.setCardSpeaking(serverStore.currentUser.sessionId || serverStore.currentUser.id, speaking);
      }
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
    this.unbindEvents.push(u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12, u13, u14, u15);
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
    this.unbindTelemetryControls();
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
  }

  public destroy(): void {
    this.stopPingMonitor();
    this.stopTelemetryMonitor();
    this.unbindListeners();
  }
}
