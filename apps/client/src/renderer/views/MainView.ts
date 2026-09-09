import { MessageType, Permission, UserSummary, canAccessChannel } from '@monky/shared';
import type { ChannelType } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { networkClient } from '../core/NetworkClient';
import { sessionManager } from '../core/SessionManager';
import { isForegroundEvent } from '../core/sessionRouting';
import { callClient } from '../core/serverConnection';
import { participantManager } from '../core/ParticipantManager';
import { serverStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';
import { chatStore } from '../stores/chatStore';
import { settingsStore, ChatSoundMode } from '../stores/settingsStore';
import { connectionStore, SavedServer } from '../stores/connectionStore';
import { audioProcessor } from '../core/AudioProcessor';
import { webRtcManager } from '../core/WebRtcManager';
import { videoService } from '../core/VideoService';
import { screenAudioService } from '../core/ScreenAudioService';
import { ChatView } from './ChatView';
import { bindPttIndicators, renderMicrophoneButton } from './PttIndicator';
import { bindAudioDevicePopovers } from './AudioDevicePopover';
import { bindFooterControlsMotion } from './FooterControlsMotion';
import { renderAudioMuteIndicators, renderAudioStateIcon, updateAudioStateIcon } from './AudioStateIcon';
import { toggleAudioDeafen, toggleMicrophoneMute } from '../core/voiceControls';
import { VoiceStageView } from './VoiceStageView';
import { createChannelModal } from './CreateChannelModal';
import { editChannelModal } from './EditChannelModal';
import { settingsModal } from './SettingsModal';
import { serverSettingsModal } from './ServerSettingsModal';
import { serverMonitorModal } from './ServerMonitorModal';
import { inviteModal } from './InviteModal';
import { contextMenu, ContextMenuItem } from './ContextMenu';
import { showConfirm, showAlert } from './Dialog';
import { setButtonLoading, withButtonLoading } from '../utils/buttonLoading';
import { checkServerOnline } from '../utils/serverStatus';
import { warnIfMoveBlocked } from '../utils/channelAccess';
import { captureHostedServerLeaveState, promptShutdownAfterLeave } from '../utils/hostedServer';
import { userContextMenu } from './UserContextMenu';
import { soundboardModal } from './SoundboardModal';
import { soundEffects } from '../core/SoundEffects';
import { getAvatarUrl, toAbsoluteServerIconUrl } from '../utils/avatar';
import { peerFailureTooltip } from '../utils/peerFailureHint';
import { participantConnectionIndicators, voiceConnectionIndicator } from '../utils/voiceConnection';
import { serverRailView } from './ServerRailView';
import { soundboardPlayersBar } from './SoundboardPlayersBar';
import { overlayBridgeService } from '../core/OverlayBridgeService';
import logoUrl from '../assets/Logo.png';
import { t, tCount } from '../i18n';

export class MainView {
  private container: HTMLElement;
  private chatView: ChatView | null = null;
  public voiceStageView: VoiceStageView | null = null;
  private unbindEvents: Array<() => void> = [];
  private activeContentView: 'chat' | 'stage' = 'chat';
  private sidebarPingInterval: number | null = null;
  // Caches the rendered screen-share notice so the frequent (per-frame)
  // 'participants.updated' events don't rebuild it on every speaking change,
  // which would flicker the button and drop its listener (#282).
  private screenShareNoticeSignature: string | null = null;
  private textChannelDragHoverTimer: number | null = null;
  private textChannelDragHoverId: string | null = null;
  // Measures the floating user card so the server rail can reserve room for it
  // (#473).
  private userCardObserver: ResizeObserver | null = null;

  public setActiveContentView(view: 'chat' | 'stage'): void {
    const changed = this.activeContentView !== view;
    this.activeContentView = view;
    if (changed) {
      appEvents.emit('stage.visibility_changed', view === 'stage');
    }
  }

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public render(): void {
    this.unbindListeners();
    this.stopSidebarPing();

    if (!serverStore.serverDetails || !serverStore.currentUser) {
      return;
    }

    const s = serverStore.serverDetails;
    const u = serverStore.currentUser;
    const canManageChannels = serverStore.hasPermission(Permission.MANAGE_CHANNELS);
    const canManageServer = serverStore.hasPermission(Permission.MANAGE_SERVER);
    const canManageRoles = serverStore.hasPermission(Permission.MANAGE_ROLES);
    const canManageBots = serverStore.hasPermission(Permission.MANAGE_BOTS);

    this.container.innerHTML = `
      <div class="main-layout">
        <!-- Server Rail: saved servers + home (#29) -->
        <div class="server-rail" id="server-rail"></div>

        <!-- Left Sidebar: Channels & User Controls -->
        <div class="channels-sidebar">
          <div class="channels-resizer" id="channels-resizer" title="${t('main.resizeHandle')}"></div>
          <div class="server-header">
            <button id="server-dropdown-toggle" class="server-dropdown-toggle" title="${t('main.serverOptions')}">
              <img id="server-header-icon" src="${s.iconUrl ? getAvatarUrl(s.iconUrl) : logoUrl}" alt="${t('serverSettings.iconAlt')}" style="width: 22px; height: 22px; object-fit: cover; border-radius: 4px; flex-shrink: 0;">
              <span id="server-name-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 700;">${escapeHtml(s.name)}</span>
              <span class="material-symbols-outlined md-18 server-dropdown-caret">expand_more</span>
            </button>
            <div id="server-dropdown-menu" class="server-dropdown-menu" style="display: none;">
              <button id="btn-server-settings" class="server-dropdown-item" title="${t('main.serverSettingsTitle')}" style="${canManageServer || canManageRoles || canManageBots ? '' : 'display: none;'}">
                <span class="material-symbols-outlined md-18">settings</span>
                <span>${t('serverSettings.title')}</span>
              </button>
              <button id="btn-server-monitor" class="server-dropdown-item" title="${t('serverMonitor.title')}" style="display: none;">
                <span class="material-symbols-outlined md-18">monitoring</span>
                <span>${t('serverMonitor.title')}</span>
              </button>
              <button id="btn-invite-friends" class="server-dropdown-item" title="${t('main.inviteTitle')}">
                <span class="material-symbols-outlined md-18">person_add</span>
                <span>${t('invite.title')}</span>
              </button>
            </div>
          </div>

          <div class="channels-list-container">
            <!-- Text Channels -->
            <div class="channel-category">
              <div class="category-title">
                <span>${t('main.textChannels')}</span>
                ${canManageChannels ? `<button id="btn-add-text-channel" class="category-add-btn" title="${t('main.createTextChannel')}">
                  <span class="material-symbols-outlined md-14">add</span>
                </button>` : ''}
              </div>
              <div id="text-channels-list"></div>
            </div>

            <!-- Voice Channels -->
            <div class="channel-category">
              <div class="category-title">
                <span>${t('main.voiceChannels')}</span>
                ${canManageChannels ? `<button id="btn-add-voice-channel" class="category-add-btn" title="${t('main.createVoiceChannel')}">
                  <span class="material-symbols-outlined md-14">add</span>
                </button>` : ''}
              </div>
              <div id="voice-channels-list"></div>
            </div>
          </div>

          <!-- Bottom User Bar -->
          <div class="user-control-bar">
            <div id="soundboard-players-slot" class="sb-notice-slot"></div>
            <div id="screenshare-notice-slot"></div>
            <div id="overlay-notice-slot"></div>
            <div id="voice-connection-row-slot"></div>
            <div class="user-media-bar" id="user-media-bar">
              <button id="media-btn-camera" class="btn btn-icon media-bar-btn-lg ${voiceStore.isCameraOn ? 'broadcasting-pulse active' : ''}" title="${t('main.toggleCamera')}">
                <span class="material-symbols-outlined md-18">${voiceStore.isCameraOn ? 'videocam_off' : 'videocam'}</span>
              </button>
              <button id="media-btn-screen" class="btn btn-icon media-bar-btn-lg ${voiceStore.isScreenSharing ? 'broadcasting-pulse active' : ''}" title="${t('main.shareScreen')}">
                <span class="material-symbols-outlined md-18">${voiceStore.isScreenSharing ? 'stop_screen_share' : 'screen_share'}</span>
              </button>
              <button id="media-btn-soundboard" class="btn btn-icon media-bar-btn-lg" title="${t('main.openSoundboard')}">
                <span class="material-symbols-outlined md-18">music_note</span>
              </button>
            </div>
            <div class="user-control-main">
              <div id="user-profile-btn" class="user-profile-summary" title="${t('main.profileSettings')}">
                <div class="user-avatar-container">
                  <img id="main-user-avatar" class="user-avatar-main ${voiceStore.isSpeaking ? 'speaking' : ''}" src="${getAvatarUrl(u.avatarUrl)}" data-fallback="avatar">
                  <span id="main-user-status-dot" class="status-indicator ${settingsStore.appearOffline ? 'invisible' : 'online'}" role="img" aria-label="${settingsStore.appearOffline ? t('main.statusInvisible') : t('main.statusOnline')}"></span>
                </div>
                <div class="user-info-text">
                  <span id="main-user-name" class="user-name-display">${escapeHtml(u.nickname)}</span>
                  <span id="main-user-status-text" class="user-status-text">${settingsStore.appearOffline ? t('main.statusInvisible') : t('main.statusOnline')}</span>
                </div>
              </div>

              <div class="user-quick-actions">
                <div class="audio-control-group">
                  ${renderMicrophoneButton()}
                  <button type="button" class="audio-device-trigger" data-audio-device="input" aria-label="${t('settings.microphone')}" title="${t('settings.microphone')}">
                    <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
                  </button>
                </div>
                <div class="audio-control-group">
                  <button id="bar-btn-deafen" class="btn btn-icon ${voiceStore.getEffectiveDeafened() ? 'danger-active' : ''}" title="${voiceStore.serverDeafened ? t('permissions.serverDeafened') : voiceStore.getEffectiveDeafened() ? t('main.undeafen') : t('main.deafen')}">
                    ${renderAudioStateIcon(voiceStore.serverDeafened ? 'headphones' : voiceStore.getEffectiveDeafened() ? 'headset_off' : 'headphones', voiceStore.serverDeafened)}
                  </button>
                  <button type="button" class="audio-device-trigger" data-audio-device="output" aria-label="${t('settings.outputDevice')}" title="${t('settings.outputDevice')}">
                    <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
                  </button>
                </div>
                <button id="bar-btn-settings" class="btn btn-icon" title="${t('connection.settingsTitle')}">
                  <span class="material-symbols-outlined md-18">settings</span>
                </button>
                <button id="bar-btn-disconnect" class="btn btn-icon" style="color: var(--danger);" title="${t('main.disconnectTitle')}">
                  <span class="material-symbols-outlined md-18">logout</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Center: Chat Feed or Voice Stage -->
        <div id="main-center-stage" class="main-content-area"></div>

        <!-- Right Sidebar: Connected Members -->
        <div class="members-sidebar">
          <div class="members-header">
            <span id="members-count-label">${t('main.membersCount', { count: 0 })}</span>
          </div>
          <div id="members-list-items" class="members-list"></div>
        </div>
      </div>
    `;

    this.renderChannels();
    this.renderMembers();
    serverRailView.render();
    this.setupChannelsResizer();
    this.observeUserCardHeight();

    const centerStageEl = document.getElementById('main-center-stage')!;
    // Re-rendering happens on every server switch now (#400), so the previous
    // views must be torn down or their event listeners and ping timers would
    // pile up on each switch.
    this.chatView?.destroy();
    this.voiceStageView?.destroy();
    this.chatView = new ChatView(centerStageEl);
    this.voiceStageView = new VoiceStageView(centerStageEl);

    // A re-render (e.g. after switching languages, #16) must not drop someone
    // who is watching the voice stage back into the text channel. The session
    // check keeps the stage hidden when the call belongs to another server the
    // user has walked away from (#400).
    if (this.activeContentView === 'stage' && this.callIsHere()) {
      this.voiceStageView.setChannel(voiceStore.currentVoiceChannelId);
    } else if (serverStore.activeTextChannelId) {
      this.setActiveContentView('chat');
      this.chatView.setChannel(serverStore.activeTextChannelId);
    }

    this.attachEvents();
    this.updateVoiceConnectionRow();
    // Fresh DOM below means the (empty) slot must be repopulated, so drop the
    // cached signature (#282).
    this.screenShareNoticeSignature = null;
    this.updateScreenShareNotice();
    this.updateOverlayNotice();

    const soundboardSlot = document.getElementById('soundboard-players-slot');
    if (soundboardSlot) soundboardPlayersBar.mount(soundboardSlot);
  }

  /**
   * True when the ongoing call belongs to the server currently on screen. The
   * call survives a server switch (#400), so anything that draws call UI inside
   * the server view has to ask this first.
   */
  private callIsHere(): boolean {
    return (
      voiceStore.currentVoiceChannelId !== null &&
      voiceStore.voiceSessionKey === sessionManager.getActiveKey()
    );
  }

  /**
   * Builds (or clears) the sidebar voice-connection row shown only while the
   * user is in a voice channel: channel name, ping and a leave button (#60).
   */
  private updateVoiceConnectionRow(): void {
    const slot = document.getElementById('voice-connection-row-slot');
    if (!slot) return;

    const vc = serverStore.serverDetails?.channels.find((c) => c.id === voiceStore.currentVoiceChannelId);
    if (!voiceStore.currentVoiceChannelId || !vc) {
      slot.innerHTML = '';
      this.stopSidebarPing();
      return;
    }

    const reconnecting = voiceStore.isReconnecting;
    const connecting = voiceStore.isConnecting;
    const connectionClass = reconnecting ? 'reconnecting' : connecting ? 'connecting' : '';
    const serverName = serverStore.serverDetails?.name ?? '';
    const { quality, icon } = voiceConnectionIndicator(null, reconnecting, connecting);
    const statusText = reconnecting ? t('main.reconnecting') : connecting ? t('main.connecting') : t('main.voiceConnected');

    slot.innerHTML = `
      <div class="voice-connection-row ${connectionClass}" id="voice-connection-row">
        <div class="voice-conn-info">
          <span class="material-symbols-outlined md-16 voice-conn-signal ${quality}" aria-hidden="true">${icon}</span>
          <div class="voice-conn-text">
            <span class="voice-conn-status" role="status">${statusText}</span>
            <span class="voice-conn-channel" id="sidebar-voice-channel">${escapeHtml(vc.name)}</span>
            ${serverName ? `<span class="voice-conn-server">${escapeHtml(serverName)}</span>` : ''}
          </div>
          <span class="voice-conn-ping" id="sidebar-voice-ping" title="${t('main.averagePing')}">-- ms</span>
        </div>
        <div class="voice-conn-actions">
          <button id="sidebar-btn-rnnoise" class="btn btn-icon voice-conn-rnnoise ${settingsStore.noiseSuppressionEnabled ? 'rnnoise-active' : ''}" title="${settingsStore.noiseSuppressionEnabled ? t('main.rnnoiseOn') : t('main.rnnoiseOff')}">
            <span class="material-symbols-outlined md-18">graphic_eq</span>
          </button>
          <button id="sidebar-btn-leave-voice" class="btn btn-icon voice-conn-leave" title="${t('main.leaveCall')}">
            <span class="material-symbols-outlined md-18">call_end</span>
          </button>
        </div>
      </div>
    `;

    const btnRnnoise = document.getElementById('sidebar-btn-rnnoise');
    btnRnnoise?.addEventListener('click', async () => {
      const enabled = !settingsStore.noiseSuppressionEnabled;
      settingsStore.noiseSuppressionEnabled = enabled;
      settingsStore.save();
      await audioProcessor.setNoiseSuppression(enabled);

      if (btnRnnoise) {
        btnRnnoise.className = `btn btn-icon voice-conn-rnnoise ${enabled ? 'rnnoise-active' : ''}`;
        btnRnnoise.setAttribute('title', enabled ? t('main.rnnoiseOn') : t('main.rnnoiseOff'));
      }
    });

    document.getElementById('sidebar-btn-leave-voice')?.addEventListener('click', () => {
      this.voiceStageView?.leaveVoice();
    });

    this.startSidebarPing();
  }

  private startSidebarPing(): void {
    this.stopSidebarPing();
    const update = async () => {
      const pingEl = document.getElementById('sidebar-voice-ping');
      if (!pingEl) return;
      const isSfu = webRtcManager.isSfuMode();
      const channelId = voiceStore.currentVoiceChannelId;
      const participants = participantManager.getInVoiceChannel(voiceStore.currentVoiceChannelId || '');
      const pending = voiceStore.isConnecting || voiceStore.isReconnecting;
      const avg = pending ? null : participants.length <= 1 && !isSfu ? 0 : await webRtcManager.getAverageP2pPing();
      if (!pingEl.isConnected || channelId !== voiceStore.currentVoiceChannelId) return;
      pingEl.textContent = avg !== null ? `${avg} ms` : '-- ms';
      const { quality, icon } = voiceConnectionIndicator(avg, voiceStore.isReconnecting, voiceStore.isConnecting);
      const signal = document.querySelector<HTMLElement>('.voice-conn-signal');
      if (signal) {
        signal.textContent = icon;
        signal.className = `material-symbols-outlined md-16 voice-conn-signal ${quality}`;
      }
      const label = voiceStore.isReconnecting ? t('main.reconnecting')
        : voiceStore.isConnecting ? t('main.connecting')
        : quality === 'good' ? t('stage.qualityExcellent')
        : quality === 'medium' ? t('stage.qualityGood')
        : quality === 'bad' ? t('stage.qualityPoor') : t('stage.pingCalculating');
      const info = document.querySelector<HTMLElement>('.voice-conn-info');
      if (info) info.title = voiceStore.isReconnecting ? t('main.reconnectingTitle')
        : voiceStore.isConnecting ? t('main.connectingTitle')
        : `${isSfu ? 'SFU' : 'P2P'} · ${pingEl.textContent} · ${label}`;
    };
    update();
    this.sidebarPingInterval = window.setInterval(update, 2000);
  }

  private stopSidebarPing(): void {
    if (this.sidebarPingInterval) {
      clearInterval(this.sidebarPingInterval);
      this.sidebarPingInterval = null;
    }
  }

  /**
   * Remote participants broadcasting their screen in the voice channel the
   * local user is currently connected to (#282).
   */
  private getRemoteScreenSharers(): Array<{ id: string; nickname: string }> {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId) return [];
    return participantManager
      .getInVoiceChannel(channelId)
      .filter((p) => !serverStore.isMySession(p.user.sessionId) && (p.voiceState?.isScreenSharing ?? false))
      .map((p) => ({
        id: p.user.sessionId || p.user.id,
        nickname: participantManager.displayName(p),
      }));
  }

  /**
   * Sidebar notice shown while someone in the call is sharing their screen and
   * the user is looking at a text channel instead of the stage (#282). With a
   * single broadcaster the button opts straight into watching; with several it
   * only opens the stage, since there is no way to guess which one to watch.
   */
  private updateScreenShareNotice(): void {
    const slot = document.getElementById('screenshare-notice-slot');
    if (!slot) return;

    const sharers = this.getRemoteScreenSharers();
    const isSelfSharing = voiceStore.isScreenSharing;
    const signature = `${this.activeContentView}|${isSelfSharing}|${sharers.map((s) => `${s.id}:${s.nickname}`).join(',')}`;
    if (signature === this.screenShareNoticeSignature) return;
    this.screenShareNoticeSignature = signature;

    if (this.activeContentView === 'stage' || (sharers.length === 0 && !isSelfSharing)) {
      slot.innerHTML = '';
      return;
    }

    const parts: string[] = [];

    // Local user sharing notice with stop button (#416)
    if (isSelfSharing) {
      parts.push(`
        <div class="screenshare-notice screenshare-notice--self">
          <span class="material-symbols-outlined md-16 screenshare-notice-icon">screen_share</span>
          <span class="screenshare-notice-text">${t('main.screenShareSelfNotice')}</span>
          <button id="screenshare-self-stop-btn" class="screenshare-notice-btn screenshare-notice-btn--danger">${t('screenShare.stopSharing')}</button>
        </div>
      `);
    }

    // Remote sharers notice
    if (sharers.length > 0) {
      const names = sharers.map((s) => escapeHtml(s.nickname));
      let label: string;
      if (names.length === 1) {
        label = t('main.screenShareNoticeOne', { name: names[0] });
      } else if (names.length === 2) {
        label = t('main.screenShareNoticeTwo', { first: names[0], second: names[1] });
      } else {
        label = tCount('main.screenShareNoticeMany', names.length - 2, {
          first: names[0],
          second: names[1],
        });
      }

      const single = sharers.length === 1;
      parts.push(`
        <div class="screenshare-notice">
          <span class="material-symbols-outlined md-16 screenshare-notice-icon">screen_share</span>
          <span class="screenshare-notice-text" title="${label}">${label}</span>
          <button id="screenshare-notice-btn" class="screenshare-notice-btn">${single ? t('main.screenShareWatch') : t('main.screenShareGoToStage')}</button>
        </div>
      `);
    }

    slot.innerHTML = parts.join('');

    // Stop self-sharing handler
    document.getElementById('screenshare-self-stop-btn')?.addEventListener('click', async () => {
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
      this.updateScreenShareNotice();
    });

    // Watch remote sharer handler
    if (sharers.length > 0) {
      const single = sharers.length === 1;
      document.getElementById('screenshare-notice-btn')?.addEventListener('click', () => {
        this.openVoiceStage(single ? sharers[0].id : undefined);
      });
    }
  }

  /**
   * Sidebar line mirroring the screen-share notice, but for the overlay: it
   * tells the user the overlay is on and carries the stop button, so the overlay
   * no longer needs a stop control on the stage. Unlike the screen-share notice,
   * it stays visible on the stage too — the overlay keeps running there, so its
   * indicator should as well.
   */
  private updateOverlayNotice(): void {
    const slot = document.getElementById('overlay-notice-slot');
    if (!slot) return;

    if (!overlayBridgeService.isActive()) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `
      <div class="screenshare-notice screenshare-notice--self">
        <span class="material-symbols-outlined md-16 screenshare-notice-icon">picture_in_picture_alt</span>
        <span class="screenshare-notice-text">${t('overlay.overlayActive')}</span>
        <button id="overlay-notice-stop-btn" class="screenshare-notice-btn screenshare-notice-btn--danger">${t('overlay.stopOverlayBtn')}</button>
      </div>
    `;

    document.getElementById('overlay-notice-stop-btn')?.addEventListener('click', () => {
      void overlayBridgeService.deactivate();
    });
  }

  /**
   * Switches the center area to the voice stage, optionally opting into a
   * specific remote screen share on the way in (#282).
   */
  private openVoiceStage(watchSessionId?: string): void {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId) return;
    this.setActiveContentView('stage');
    this.voiceStageView?.setChannel(channelId);
    if (watchSessionId) this.voiceStageView?.watchScreenShare(watchSessionId);
    this.renderChannels();
    this.updateScreenShareNotice();
  }

  private closeServerDropdown(): void {
    const menu = document.getElementById('server-dropdown-menu');
    const toggle = document.getElementById('server-dropdown-toggle');
    if (menu) menu.style.display = 'none';
    toggle?.classList.remove('open');
  }

  private ensureInVoiceChannel(): boolean {
    if (!voiceStore.currentVoiceChannelId) {
      showAlert({
        title: t('main.joinVoiceFirstTitle'),
        message: t('main.joinVoiceFirstMessage'),
        variant: 'warning',
      });
      return false;
    }
    return true;
  }

  private setupChannelsResizer(): void {
    const resizer = document.getElementById('channels-resizer');
    const sidebar = this.container.querySelector('.channels-sidebar') as HTMLElement | null;
    if (!resizer || !sidebar) return;

    // Restore a previously persisted width.
    try {
      const saved = localStorage.getItem('monky_channels_width');
      if (saved) {
        const w = parseInt(saved, 10);
        if (!isNaN(w)) sidebar.style.width = `${this.clampSidebarWidth(w)}px`;
      }
    } catch (e) {}

    let startX = 0;
    let startWidth = 0;

    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = this.clampSidebarWidth(startWidth + delta);
      sidebar.style.width = `${newWidth}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('monky_channels_width', String(parseInt(sidebar.style.width, 10)));
      } catch (e) {}
    };

    resizer.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  private clampSidebarWidth(width: number): number {
    const min = 280;
    const max = Math.max(min, Math.floor(window.innerWidth * 0.35));
    return Math.min(max, Math.max(min, width));
  }

  private activateTextChannel(channelId: string): void {
    this.clearTextChannelDragHover();
    serverStore.setActiveTextChannel(channelId);
    this.setActiveContentView('chat');
    this.chatView?.setChannel(channelId);
    this.renderChannels();
    this.updateScreenShareNotice();
  }

  private isFileDrag(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  }

  private clearTextChannelDragHover(): void {
    if (this.textChannelDragHoverTimer !== null) {
      window.clearTimeout(this.textChannelDragHoverTimer);
      this.textChannelDragHoverTimer = null;
    }

    if (this.textChannelDragHoverId) {
      const previousItem = this.container.querySelector(
        `.channel-item[data-channel-id="${this.textChannelDragHoverId}"][data-channel-type="TEXT"]`
      ) as HTMLElement | null;
      previousItem?.classList.remove('drag-hover');
    }

    this.textChannelDragHoverId = null;
  }

  private arePermissionsResolved(): boolean {
    return serverStore.myPermissions > 0 || serverStore.ownerId !== null;
  }

  private canReadTextChannels(): boolean {
    return !this.arePermissionsResolved() || serverStore.hasPermission(Permission.READ_MESSAGES);
  }

  private canSpeakInVoiceChannels(): boolean {
    return !this.arePermissionsResolved() || serverStore.hasPermission(Permission.SPEAK);
  }

  private showVoicePermissionDenied(): void {
    void showAlert({
      title: t('main.voicePermissionDeniedTitle'),
      message: t('main.voicePermissionDeniedMessage'),
      variant: 'warning',
    });
  }

  private scheduleTextChannelAutoSwitch(item: HTMLElement, channelId: string): void {
    if (this.textChannelDragHoverId !== channelId) {
      this.clearTextChannelDragHover();
      this.textChannelDragHoverId = channelId;
      item.classList.add('drag-hover');
    }

    if (this.textChannelDragHoverTimer !== null) return;

    this.textChannelDragHoverTimer = window.setTimeout(() => {
      this.textChannelDragHoverTimer = null;
      if (this.textChannelDragHoverId !== channelId) return;
      if (serverStore.activeTextChannelId === channelId && this.activeContentView === 'chat') return;
      this.activateTextChannel(channelId);
    }, 500);
  }

  private renderChannels(): void {
    if (!serverStore.serverDetails) return;

    const textListEl = document.getElementById('text-channels-list');
    const voiceListEl = document.getElementById('voice-channels-list');
    const canReadTextChannels = this.canReadTextChannels();
    const canSpeakInVoiceChannels = this.canSpeakInVoiceChannels();
    const permissionsResolved = this.arePermissionsResolved();

    const textChannels = canReadTextChannels
      ? serverStore.serverDetails.channels.filter((c) => c.type === 'TEXT')
      : [];
    const voiceChannels = serverStore.serverDetails.channels.filter((c) => c.type === 'VOICE');

    if (textListEl) {
      textListEl.innerHTML = textChannels.map((c) => `
        <div class="channel-item ${c.id === serverStore.activeTextChannelId && this.activeContentView === 'chat' ? 'active' : ''}" data-channel-id="${c.id}" data-channel-type="TEXT">
          <span class="material-symbols-outlined md-16 channel-icon" style="color: var(--text-muted);">tag</span>
          <span class="channel-name">${escapeHtml(c.name)}</span>
          ${c.isPrivate ? `<span class="material-symbols-outlined md-16 channel-private-icon" title="${t('main.privateChannelBadge')}">lock_person</span>` : ''}
          ${chatStore.hasMention(c.id)
            ? `<span class="channel-mention-badge" title="${t('main.mentionBadge')}">@</span>`
            : chatStore.hasUnread(c.id)
              ? `<span class="channel-unread-dot" title="${t('main.unreadBadge')}"></span>`
              : ''}
          <button class="channel-menu-btn" data-menu-channel="${c.id}" title="${t('common.moreOptions')}">
            <span class="material-symbols-outlined md-16">more_vert</span>
          </button>
        </div>
      `).join('');
    }

    if (voiceListEl) {
      voiceListEl.innerHTML = voiceChannels.map((c) => {
        const inVoice = participantManager.getInVoiceChannel(c.id);
        const isActive = c.id === voiceStore.currentVoiceChannelId;
        const showRestrictedIcon = permissionsResolved && !canSpeakInVoiceChannels;
        const isRestricted = showRestrictedIcon && !isActive;

        return `
          <div class="voice-channel-group" data-channel-id="${c.id}" style="display: flex; flex-direction: column;">
            <div class="channel-item ${isActive ? 'active' : ''} ${isRestricted ? 'restricted' : ''}" data-channel-id="${c.id}" data-channel-type="VOICE">
              <span class="material-symbols-outlined md-16 channel-icon" style="color: ${isActive ? 'var(--success)' : 'var(--text-muted)'};">volume_up</span>
              <span class="channel-name">${escapeHtml(c.name)}</span>
              ${c.isPrivate ? `<span class="material-symbols-outlined md-16 channel-private-icon" title="${t('main.privateChannelBadge')}">lock_person</span>` : ''}
              ${showRestrictedIcon ? `<span class="material-symbols-outlined md-16 channel-restricted-icon" title="${t('main.voiceChannelRestricted')}">lock</span>` : ''}
              ${isActive ? `<span style="font-size: 11px; color: var(--success); font-weight: 600; margin-left: auto;">(${t('common.you')})</span>` : ''}
              <button class="channel-menu-btn" data-menu-channel="${c.id}" title="${t('common.moreOptions')}">
                <span class="material-symbols-outlined md-16">more_vert</span>
              </button>
            </div>

            ${inVoice.length > 0 ? `
              <div class="voice-participants-sublist">
                ${inVoice.map((p) => {
                  const sessionId = p.user.sessionId || p.user.id;
                  const isLocal = serverStore.isMySession(p.user.sessionId);
                  const isSpeaking = isLocal ? voiceStore.isSpeaking : p.isSpeaking;
                  const isServerDeafened = isLocal ? voiceStore.serverDeafened : (p.voiceState?.serverDeafened ?? false);
                  const isServerMuted = isLocal ? voiceStore.serverMuted : (p.voiceState?.serverMuted ?? false);
                  const isSelfDeafened = isLocal ? voiceStore.isDeafened : (p.voiceState?.isDeafened ?? false);
                  const isSelfMuted = isLocal ? voiceStore.isMuted : (p.voiceState?.isMuted ?? false);
                  const avatar = getAvatarUrl(p.user.avatarUrl);
                  const displayName = participantManager.displayName(p);
                  const isSfu = serverStore.serverDetails?.voiceMode === 'sfu';
                  const { isPeerFailed, isConnecting, isRelayed } = participantConnectionIndicators(p, isSfu, isLocal);

                  return `
                    <div id="voice-mini-user-${sessionId}" class="voice-participant-mini ${isSpeaking ? 'speaking' : ''}" data-session-id="${sessionId}" title="${escapeHtml(displayName)} (${t(isLocal ? 'common.you' : 'main.rightClickVolumeShort')})">
                      <img class="voice-mini-avatar" src="${avatar}" data-fallback="avatar">
                      <span class="voice-mini-name">${escapeHtml(displayName)}</span>
                      ${isPeerFailed ? `<span class="material-symbols-outlined md-14 voice-mini-icon peer-failed" title="${isSfu ? t('main.sfuConnectionFailed') : peerFailureTooltip('main.peerConnectionFailed')}">link_off</span>` : ''}
                      ${isConnecting ? `<span class="material-symbols-outlined md-14 voice-mini-icon peer-connecting" title="${t(isSfu ? 'main.sfuConnecting' : 'main.peerConnecting')}">sync</span>` : ''}
                      ${isRelayed ? `<span class="material-symbols-outlined md-14 voice-mini-icon relayed" title="${t('main.peerRelayed')}">swap_horiz</span>` : ''}
                      ${renderAudioMuteIndicators({ isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened })}
                      ${p.voiceState?.isScreenSharing ? `<span class="material-symbols-outlined md-14 voice-mini-icon live" title="${t('main.sharingScreen')}">screen_share</span>` : ''}
                      ${p.voiceState?.isCameraOn ? `<span class="material-symbols-outlined md-14 voice-mini-icon" title="${t('main.cameraOn')}">videocam</span>` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }

    // Attach right-click context menu listeners to voice mini participant items
    this.container.querySelectorAll('.voice-participant-mini').forEach((miniEl) => {
      miniEl.addEventListener('contextmenu', (e: Event) => {
        const mouseEvent = e as MouseEvent;
        mouseEvent.preventDefault();
        const sessionId = miniEl.getAttribute('data-session-id');
        if (!sessionId) return;
        const participant = participantManager.get(sessionId);
        if (participant?.user) {
          userContextMenu.open(mouseEvent.clientX, mouseEvent.clientY, participant.user);
        }
      });

      // Drag-and-drop users between voice channels (#248)
      if (serverStore.hasPermission(Permission.MOVE_MEMBERS)) {
        const el = miniEl as HTMLElement;
        el.draggable = true;
        el.addEventListener('dragstart', (e: Event) => {
          const de = e as DragEvent;
          const sessionId = el.getAttribute('data-session-id');
          if (sessionId) {
            de.dataTransfer?.setData('text/monky-session-id', sessionId);
            de.dataTransfer!.effectAllowed = 'move';
            el.classList.add('dragging');
          }
        });
        el.addEventListener('dragend', () => { el.classList.remove('dragging'); });
      }
    });

    // Voice channel drop targets for user drag-and-drop (#248, #357)
    if (serverStore.hasPermission(Permission.MOVE_MEMBERS)) {
      this.container.querySelectorAll('.voice-channel-group').forEach((item) => {
        const el = item as HTMLElement;
        el.addEventListener('dragover', (e: Event) => {
          const de = e as DragEvent;
          if (de.dataTransfer?.types.includes('text/monky-session-id')) {
            de.preventDefault();
            de.dataTransfer!.dropEffect = 'move';
            el.classList.add('drop-target');
          }
        });
        el.addEventListener('dragleave', (e: Event) => {
          const de = e as DragEvent;
          const next = de.relatedTarget as Node | null;
          if (next && el.contains(next)) return;
          el.classList.remove('drop-target');
        });
        el.addEventListener('drop', (e: Event) => {
          const de = e as DragEvent;
          de.preventDefault();
          el.classList.remove('drop-target');
          const sessionId = de.dataTransfer?.getData('text/monky-session-id');
          const channelId = el.getAttribute('data-channel-id');
          if (sessionId && channelId) {
            const currentParticipant = participantManager.get(sessionId);
            if (currentParticipant?.voiceState?.channelId !== channelId) {
              const targetUser = currentParticipant?.user;
              if (targetUser && warnIfMoveBlocked(targetUser.id, targetUser.nickname, channelId)) return;
              void networkClient.sendRequest(MessageType.ADMIN_MOVE_USER, {
                targetSessionId: sessionId,
                channelId,
              }).catch((err: unknown) => {
                void showAlert({
                  title: t('common.error'),
                  message: (err as Error)?.message || t('userMenu.actionFailed'),
                  variant: 'danger',
                });
              });
            }
          }
        });
      });
    }

    // Attach click listeners to channel items
    this.container.querySelectorAll('.channel-item').forEach((item) => {
      item.addEventListener('click', async (e) => {
        if ((e.target as HTMLElement).closest('.channel-menu-btn')) return;
        const channelId = item.getAttribute('data-channel-id')!;
        const type = item.getAttribute('data-channel-type')!;

        if (type === 'TEXT') {
          this.activateTextChannel(channelId);
        } else if (type === 'VOICE') {
          if (channelId !== voiceStore.currentVoiceChannelId && this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SPEAK)) {
            item.classList.add('restricted-feedback');
            window.setTimeout(() => item.classList.remove('restricted-feedback'), 600);
            this.showVoicePermissionDenied();
            return;
          }
          // Show a loading spinner on the channel while the voice join happens (#48).
          const iconEl = item.querySelector('.channel-icon');
          if (iconEl) {
            iconEl.textContent = 'progress_activity';
            iconEl.classList.add('channel-loading');
          }
          item.classList.add('joining');
          try {
            await this.handleJoinVoiceChannel(channelId);
            this.setActiveContentView('stage');
            this.voiceStageView?.setChannel(channelId);
            this.updateScreenShareNotice();
          } finally {
            this.renderChannels();
          }
        }
      });
    });

    this.container.querySelectorAll('.channel-item[data-channel-type="TEXT"]').forEach((item) => {
      const el = item as HTMLElement;
      const channelId = el.getAttribute('data-channel-id');
      if (!channelId) return;

      const handleDragHover = (e: Event) => {
        const dragEvent = e as DragEvent;
        if (!this.isFileDrag(dragEvent)) return;
        dragEvent.preventDefault();
        if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'copy';
        this.scheduleTextChannelAutoSwitch(el, channelId);
      };

      el.addEventListener('dragenter', handleDragHover);
      el.addEventListener('dragover', handleDragHover);
      el.addEventListener('dragleave', (e) => {
        const dragEvent = e as DragEvent;
        if (!this.isFileDrag(dragEvent)) return;
        const nextTarget = dragEvent.relatedTarget as Node | null;
        if (nextTarget && el.contains(nextTarget)) return;
        if (this.textChannelDragHoverId === channelId) {
          this.clearTextChannelDragHover();
        }
      });
      el.addEventListener('drop', () => this.clearTextChannelDragHover());
    });

    // Right-clicking a channel opens the same options menu as the ⋮ button (#151).
    this.container.querySelectorAll('.channel-item').forEach((item) => {
      item.addEventListener('contextmenu', (e) => {
        const mouseEvent = e as MouseEvent;
        mouseEvent.preventDefault();
        const channelId = item.getAttribute('data-channel-id');
        if (!channelId) return;
        this.openChannelMenu(channelId, mouseEvent.clientX, mouseEvent.clientY);
      });
    });

    // Attach "more options" menu listeners (#151). Delete now lives inside a
    // dropdown so more per-channel actions can be added later, and the same menu
    // is also reachable by right-clicking the channel above.
    this.container.querySelectorAll('.channel-menu-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const channelId = btn.getAttribute('data-menu-channel');
        if (!channelId) return;
        const rect = (btn as HTMLElement).getBoundingClientRect();
        this.openChannelMenu(channelId, rect.left, rect.bottom + 4);
      });
    });

    this.setupChannelReorder();
  }

  /**
   * Lets managers drag channels into a new order (#471).
   *
   * Text and voice are reordered independently, so a drag only ever finds drop
   * targets inside its own list. The dragged element carries its type in the
   * drag data, which is what keeps a voice channel from landing among the text
   * ones — the check has to happen on `dragover` (there is no way to reject a
   * drop after the fact) and the payload itself is unreadable there, so the type
   * travels as part of the MIME type.
   */
  private setupChannelReorder(): void {
    if (!serverStore.hasPermission(Permission.MANAGE_CHANNELS)) return;

    const lists: Array<{ el: HTMLElement | null; type: ChannelType }> = [
      { el: document.getElementById('text-channels-list'), type: 'TEXT' },
      { el: document.getElementById('voice-channels-list'), type: 'VOICE' },
    ];

    for (const { el: listEl, type } of lists) {
      if (!listEl) continue;
      const mime = `text/monky-channel-${type.toLowerCase()}`;
      // A voice channel and its participants live in a wrapper; a text channel
      // is the item itself. Dragging and dropping act on whichever is the direct
      // child of the list, so the participants travel with their channel.
      const rows = Array.from(listEl.children) as HTMLElement[];

      for (const row of rows) {
        const handle = (row.matches('.channel-item') ? row : row.querySelector('.channel-item')) as HTMLElement | null;
        if (!handle) continue;
        const channelId = handle.getAttribute('data-channel-id');
        if (!channelId) continue;

        handle.draggable = true;
        // Dragging is invisible without a hint, and the row has no title of its
        // own to lose.
        if (!handle.title) handle.title = t('main.channelReorderHint');
        handle.addEventListener('dragstart', (e: Event) => {
          const de = e as DragEvent;
          de.dataTransfer?.setData(mime, channelId);
          de.dataTransfer!.effectAllowed = 'move';
          row.classList.add('channel-dragging');
        });
        handle.addEventListener('dragend', () => {
          row.classList.remove('channel-dragging');
          listEl.querySelectorAll('.channel-drop-before, .channel-drop-after').forEach((n) => {
            n.classList.remove('channel-drop-before', 'channel-drop-after');
          });
        });

        row.addEventListener('dragover', (e: Event) => {
          const de = e as DragEvent;
          if (!de.dataTransfer?.types.includes(mime)) return;
          de.preventDefault();
          de.stopPropagation();
          de.dataTransfer.dropEffect = 'move';
          const rect = row.getBoundingClientRect();
          const after = de.clientY > rect.top + rect.height / 2;
          row.classList.toggle('channel-drop-before', !after);
          row.classList.toggle('channel-drop-after', after);
        });
        row.addEventListener('dragleave', (e: Event) => {
          const next = (e as DragEvent).relatedTarget as Node | null;
          if (next && row.contains(next)) return;
          row.classList.remove('channel-drop-before', 'channel-drop-after');
        });
        row.addEventListener('drop', (e: Event) => {
          const de = e as DragEvent;
          const draggedId = de.dataTransfer?.getData(mime);
          const after = row.classList.contains('channel-drop-after');
          row.classList.remove('channel-drop-before', 'channel-drop-after');
          if (!draggedId) return;
          de.preventDefault();
          de.stopPropagation();
          if (draggedId === channelId) return;
          this.commitChannelOrder(type, draggedId, channelId, after);
        });
      }

      // Dropping on the empty space below the list sends the channel to the end.
      listEl.addEventListener('dragover', (e: Event) => {
        const de = e as DragEvent;
        if (!de.dataTransfer?.types.includes(mime)) return;
        de.preventDefault();
        de.dataTransfer.dropEffect = 'move';
      });
      listEl.addEventListener('drop', (e: Event) => {
        const de = e as DragEvent;
        const draggedId = de.dataTransfer?.getData(mime);
        if (!draggedId) return;
        de.preventDefault();
        this.commitChannelOrder(type, draggedId, null, true);
      });
    }
  }

  /**
   * Sends the reordered list to the server (#471).
   *
   * The new order is applied locally right away so the drop feels instant, and
   * the broadcast that comes back simply confirms it. A failure re-renders from
   * the store, which still holds the order the server knows about.
   */
  private commitChannelOrder(
    type: ChannelType,
    draggedId: string,
    targetId: string | null,
    after: boolean
  ): void {
    const channels = serverStore.serverDetails?.channels.filter((c) => c.type === type) ?? [];
    const ids = channels.map((c) => c.id).filter((id) => id !== draggedId);
    if (ids.length === channels.length) return;

    let index = ids.length;
    if (targetId) {
      const at = ids.indexOf(targetId);
      if (at === -1) return;
      index = after ? at + 1 : at;
    }
    ids.splice(index, 0, draggedId);

    serverStore.applyChannelPositions(ids.map((channelId, position) => ({ channelId, position })));

    void networkClient
      .sendRequest(MessageType.CHANNEL_REORDER, { type, orderedIds: ids })
      .catch((err: unknown) => {
        void showAlert({
          title: t('common.error'),
          message: (err as Error)?.message || t('main.channelReorderFailed'),
          variant: 'danger',
        });
        this.renderChannels();
      });
  }

  /** Opens the per-channel options menu at the given screen coordinates (#151). */
  private openChannelMenu(channelId: string, x: number, y: number): void {
    const channel = serverStore.serverDetails?.channels.find((c) => c.id === channelId);
    const items: ContextMenuItem[] = [];

    // Chat-sound notifications only apply to text channels (#153).
    if (channel?.type === 'TEXT') {
      items.push({
        label: t('channelMenu.notifications'),
        icon: 'notifications',
        onClick: () => this.openChannelNotificationMenu(channelId, x, y),
      });

      // Only offered when there is actually something to clear (#263).
      if (chatStore.hasUnread(channelId) || chatStore.hasMention(channelId)) {
        items.push({
          label: t('channelMenu.markAsRead'),
          icon: 'mark_chat_read',
          onClick: () => {
            chatStore.clearUnread(channelId);
            if (chatStore.hasMention(channelId)) {
              chatStore.clearMention(channelId);
              networkClient.send(MessageType.CHAT_MENTIONS_READ, { channelId });
            }
          },
        });
      }
    }

    if (serverStore.hasPermission(Permission.MANAGE_CHANNELS)) {
      items.push({
        label: t('main.editChannel'),
        icon: 'settings',
        onClick: () => {
          editChannelModal.open(channelId);
        },
      });
      items.push({
        label: t('main.deleteChannel'),
        icon: 'delete',
        danger: true,
        onClick: () => {
          void this.handleDeleteChannel(channelId);
        },
      });
    }

    contextMenu.open(x, y, items);
  }

  /** Submenu to pick the per-channel chat-sound mode, overriding server/global (#153). */
  private openChannelNotificationMenu(channelId: string, x: number, y: number): void {
    const current = settingsStore.getChannelChatSoundOverride(channelId);
    const item = (mode: ChatSoundMode, label: string) => ({
      label,
      icon: current === mode ? 'check' : undefined,
      onClick: () => settingsStore.setChannelChatSoundOverride(channelId, mode),
    });
    contextMenu.open(x, y, [
      item('inherit', t('chatSound.inheritServer')),
      item('all', t('chatSound.all')),
      item('mentions', t('chatSound.mentions')),
      item('none', t('chatSound.none')),
    ]);
  }

  private async handleJoinVoiceChannel(channelId: string, silent: boolean = false): Promise<void> {
    if (voiceStore.currentVoiceChannelId === channelId) {
      // Already in this channel, just switch view to stage
      this.setActiveContentView('stage');
      this.voiceStageView?.setChannel(channelId);
      this.updateScreenShareNotice();
      return;
    }

    if (this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SPEAK)) {
      if (!silent) this.showVoicePermissionDenied();
      return;
    }

    // If in another channel, close the current mesh locally; the server-side
    // join handler updates the stored voice state to the new room directly.
    if (voiceStore.currentVoiceChannelId) {
      // Switching rooms ends any screen share (#565): it belongs to the room it
      // started in and must not follow us into the next one.
      await this.stopLocalScreenSharesForChannelChange();
      webRtcManager.closeAllPeers();
      // The call lives on a single server (#400). Joining voice somewhere else
      // means leaving the previous one for real, otherwise the old server would
      // keep us listed in a channel we can no longer hear.
      const previousKey = voiceStore.voiceSessionKey;
      if (previousKey && previousKey !== sessionManager.getActiveKey()) {
        sessionManager.get(previousKey)?.client.send(MessageType.VOICE_LEAVE, {
          channelId: voiceStore.currentVoiceChannelId,
        });
      }
    }

    // Start local mic
    try {
      const stream = await audioProcessor.startMicrophone();
      const audioTrack = stream.getAudioTracks()[0];
      webRtcManager.setLocalAudioTrack(audioTrack);
    } catch (err) {
      console.warn('Microphone permission or hardware error:', err);
    }

    voiceStore.setChannel(channelId, sessionManager.getActiveKey());
    // The peer mesh keys off our session id on the server hosting the call, so
    // it has to follow the call when it moves between servers (#400).
    const mySessionId = serverStore.currentUser?.sessionId || serverStore.currentUser?.id;
    if (mySessionId) webRtcManager.setCurrentSessionId(mySessionId);
    if (!silent) soundEffects.play('join_voice');
    networkClient.send(MessageType.VOICE_JOIN, {
      channelId,
      isMuted: voiceStore.isMuted,
      isDeafened: voiceStore.isDeafened,
    });

    if (webRtcManager.isSfuMode()) {
      await webRtcManager.initSfuForCurrentChannel();
    } else {
      // Connect to all peers already in this voice channel
      const peersInChannel = participantManager.getInVoiceChannel(channelId);
      for (const peer of peersInChannel) {
        const peerSessionId = peer.user.sessionId || peer.user.id;
        if (!serverStore.isMySession(peer.user.sessionId)) {
          await webRtcManager.connectToPeer(peerSessionId, true);
        }
      }
    }
  }

  public async rejoinVoiceChannel(channelId: string): Promise<void> {
    // Being moved to another room ends any screen share (#565); stop the local
    // capture and producers before tearing the mesh down, otherwise the stale
    // tracks would be re-announced into the destination on the next join.
    await this.stopLocalScreenSharesForChannelChange();
    // Close existing peer connections before moving (#248)
    webRtcManager.closeAllPeers();
    // Reset the stored voice channel so handleJoinVoiceChannel performs a full
    // (re)join instead of early-returning, then reconnect the mesh.
    voiceStore.setChannel(null);
    this.setActiveContentView('stage');
    await this.handleJoinVoiceChannel(channelId, true);
    this.voiceStageView?.setChannel(channelId);
    this.renderChannels();
    this.updateScreenShareNotice();
  }

  /**
   * Fully stops every local screen share because the participant's voice
   * channel is changing (moved by an admin or switching rooms). Stops the OS
   * capture (which plays the stop cue and auto-stops screen audio), removes the
   * WebRTC producers/senders so nothing is re-announced into the new room, and
   * clears the derived store flags. No-ops when nothing is being shared (#565).
   */
  private async stopLocalScreenSharesForChannelChange(): Promise<void> {
    if (videoService.getScreenShareCount() === 0 && !voiceStore.isScreenSharing) {
      return;
    }
    videoService.stopScreenShare();
    await webRtcManager.removeAllLocalScreenTracks();
    voiceStore.setScreenSharing(false);
  }

  private async handleDeleteChannel(channelId: string): Promise<void> {
    if (!serverStore.serverDetails) return;
    const channel = serverStore.serverDetails.channels.find((c) => c.id === channelId);
    if (!channel) return;

    const isText = channel.type === 'TEXT';
    const confirmed = await showConfirm({
      title: isText ? t('main.deleteTextChannelTitle') : t('main.deleteVoiceChannelTitle'),
      message: isText
        ? t('main.deleteTextChannelMessage', { name: channel.name })
        : t('main.deleteVoiceChannelMessage', { name: channel.name }),
      confirmLabel: t('main.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;

    // If we are currently in this voice channel, leave it first locally. The
    // session check keeps a call on another server untouched (#400).
    if (
      channel.type === 'VOICE' &&
      voiceStore.currentVoiceChannelId === channelId &&
      voiceStore.voiceSessionKey === sessionManager.getActiveKey()
    ) {
      networkClient.send(MessageType.VOICE_LEAVE, { channelId });
      webRtcManager.closeAllPeers();
      audioProcessor.stopMicrophone();
      voiceStore.reset();
      this.voiceStageView?.setChannel(null);
      this.setActiveContentView('chat');
    }

    networkClient.send(MessageType.CHANNEL_DELETE, { channelId });
  }

  // Re-evaluate UI elements that depend on the current user's permissions (#246)
  private updatePermissionDependentUI(): void {
    const canManageServer = serverStore.hasPermission(Permission.MANAGE_SERVER);
    const canManageRoles = serverStore.hasPermission(Permission.MANAGE_ROLES);
    const canManageBots = serverStore.hasPermission(Permission.MANAGE_BOTS);
    const btnSettings = document.getElementById('btn-server-settings');
    if (btnSettings) {
      (btnSettings as HTMLElement).style.display = (canManageServer || canManageRoles || canManageBots) ? '' : 'none';
    }
  }

  private renderMembers(): void {
    if (!serverStore.serverDetails) return;

    const listEl = document.getElementById('members-list-items');
    const countEl = document.getElementById('members-count-label');

    const allMembers = serverStore.getAllMembersInDisplayOrder();
    const onlineMembers = allMembers.filter((m) => m.status !== 'DISCONNECTED');
    const offlineMembers = allMembers.filter((m) => m.status === 'DISCONNECTED');

    // For private channel visibility: determine which voice channels the local
    // user can see, so members in invisible private channels appear as offline.
    const myRoleIds = serverStore.getUserRoleIds(serverStore.currentUser?.id ?? '');
    const myPerms = serverStore.myPermissions;
    const visibleChannelIds = new Set(
      (serverStore.serverDetails.channels ?? [])
        .filter((ch) => canAccessChannel(ch, myPerms, myRoleIds))
        .map((ch) => ch.id)
    );

    if (countEl) {
      countEl.innerText = t('main.membersCount', { count: allMembers.length });
    }

    const renderMemberItem = (m: UserSummary, isOffline: boolean): string => {
      const isLocal = m.id === serverStore.currentUser?.id;
      const vm = participantManager.getByUserId(m.id);
      const voiceState = vm?.voiceState;
      // If the member is in a private channel the local user cannot access,
      // mask them as offline so their presence is not leaked (#401).
      const inPrivateHiddenChannel = voiceState && !visibleChannelIds.has(voiceState.channelId);
      const effectiveOffline = isOffline || inPrivateHiddenChannel;
      const inVoice = !!voiceState && !inPrivateHiddenChannel;
      const isReconnecting = !effectiveOffline && participantManager.isUserReconnecting(m.id);
      const avatar = getAvatarUrl(m.avatarUrl);
      const isServerDeafened = !effectiveOffline && (isLocal ? voiceStore.serverDeafened : (voiceState?.serverDeafened ?? false));
      const isServerMuted = !effectiveOffline && (isLocal ? voiceStore.serverMuted : (voiceState?.serverMuted ?? false));
      const isSelfDeafened = !effectiveOffline && (isLocal ? voiceStore.isDeafened : (voiceState?.isDeafened ?? false));
      const isSelfMuted = !effectiveOffline && (isLocal ? voiceStore.isMuted : (voiceState?.isMuted ?? false));

      const statusClass = m.invisible ? 'invisible' : (isReconnecting ? 'reconnecting' : (inVoice ? 'voice' : (effectiveOffline ? 'offline' : 'online')));
      const statusText = m.invisible ? t('main.statusInvisible') : isReconnecting
        ? t('main.reconnecting')
        : (inVoice ? t('main.inVoiceChannel') : (effectiveOffline ? t('main.statusOffline') : t('main.statusOnline')));

      return `
        <div class="member-item ${effectiveOffline ? 'member-offline' : ''} ${isReconnecting ? 'reconnecting' : ''}" data-user-id="${m.id}" title="${escapeHtml(m.nickname)} ${isLocal ? `(${t('common.you')})` : `(${t('main.rightClickVolume')})`}">
          <div class="member-avatar-wrapper">
            <img class="member-avatar-img" src="${avatar}" data-fallback="avatar">
            <span class="status-indicator ${statusClass}" role="img" aria-label="${statusText}"></span>
          </div>
          <div class="member-info">
            <div class="member-name-row">
              <span class="member-name">${escapeHtml(m.nickname)}</span>
              ${isLocal ? `<span class="member-badge-you">${t('common.you')}</span>` : ''}
              ${m.id === serverStore.ownerId ? `<span class="member-badge-you">${t('roles.ownerBadge')}</span>` : ''}
              ${m.isBot ? `<span class="member-badge-bot" title="Bot">BOT</span>` : ''}
              ${isReconnecting ? `<span class="member-reconnecting-badge" title="${t('main.reconnectingTitle')}"><span class="material-symbols-outlined md-14 spin">sync</span></span>` : ''}
              ${(!effectiveOffline && voiceState?.isScreenSharing) ? `<span class="member-live-badge" title="${t('main.sharingScreen')}">LIVE</span>` : ''}
              ${(!effectiveOffline && voiceState?.isCameraOn) ? `<span class="material-symbols-outlined md-14 member-cam-icon" title="${t('main.cameraOn')}">videocam</span>` : ''}
              ${renderAudioMuteIndicators({ isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened }, { showMicrophone: inVoice || isServerMuted })}
            </div>
            ${(() => {
              // With public badges off, a role tag is only rendered for members
              // who hold that same role — except for admins, who moderate the
              // server and therefore always see every badge (#530).
              const badgesArePublic = serverStore.serverDetails?.showRoleBadgesToEveryone !== false;
              const canSeeAllBadges = badgesArePublic || serverStore.hasPermission(Permission.ADMINISTRATOR);
              const myRoleIds = canSeeAllBadges ? [] : serverStore.getUserRoleIds(serverStore.currentUser?.id || '');
              const userRoles = serverStore
                .getUserRoles(m.id)
                .filter((r) => !r.isDefault && (canSeeAllBadges || myRoleIds.includes(r.id)));
              return userRoles.length ? `<div class="member-role-tags">${userRoles.map((role) => `<span class="member-role-tag" style="${role.color ? `--role-color: ${role.color}` : ''}">${escapeHtml(role.name)}</span>`).join('')}</div>` : '';
            })()}
            <span class="member-subtext">${statusText}</span>
          </div>
        </div>
      `;
    };

    if (listEl) {
      const sections: string[] = [];

      if (onlineMembers.length > 0) {
        sections.push(`
          <div class="member-section-header">${t('main.membersOnline')} — ${onlineMembers.length}</div>
          ${onlineMembers.map((m) => renderMemberItem(m, false)).join('')}
        `);
      }

      if (offlineMembers.length > 0) {
        sections.push(`
          <div class="member-section-header">${t('main.membersOffline')} — ${offlineMembers.length}</div>
          ${offlineMembers.map((m) => renderMemberItem(m, true)).join('')}
        `);
      }

      listEl.innerHTML = sections.join('');

      // Attach contextmenu listeners to member items
      listEl.querySelectorAll('.member-item').forEach((item) => {
        item.addEventListener('contextmenu', (e: Event) => {
          const mouseEvent = e as MouseEvent;
          mouseEvent.preventDefault();
          const userId = item.getAttribute('data-user-id');
          if (!userId) return;
          const member = serverStore.knownMembers.get(userId) ?? serverStore.serverDetails?.members.find((u) => u.id === userId);
          if (member) {
            userContextMenu.open(mouseEvent.clientX, mouseEvent.clientY, member);
          }
        });
      });
    }
  }

  private async refreshServerMonitorVisibility(): Promise<void> {
    const btn = document.getElementById('btn-server-monitor');
    if (!btn) return;

    // Only makes sense for the server this machine is hosting (#GUI retirement).
    let isHosting = false;
    try {
      const status = await window.api?.hostServerStatus?.();
      isHosting = Boolean(status?.isRunning);
    } catch {
      isHosting = false;
    }
    btn.style.display = isHosting ? '' : 'none';
  }

  private attachEvents(): void {
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
    this.unbindEvents.push(bindPttIndicators(this.container));
    this.unbindEvents.push(bindAudioDevicePopovers(this.container));
    this.unbindEvents.push(bindFooterControlsMotion(this.container));

    const btnAddText = document.getElementById('btn-add-text-channel');
    const btnAddVoice = document.getElementById('btn-add-voice-channel');
    const btnInvite = document.getElementById('btn-invite-friends');
    const btnServerSettings = document.getElementById('btn-server-settings');
    const btnServerMonitor = document.getElementById('btn-server-monitor');
    const btnProfile = document.getElementById('user-profile-btn');
    const btnSettings = document.getElementById('bar-btn-settings');
    const btnMic = document.getElementById('bar-btn-mic');
    const btnDeafen = document.getElementById('bar-btn-deafen');
    const btnDisconnect = document.getElementById('bar-btn-disconnect');

    btnAddText?.addEventListener('click', (e) => withButtonLoading(e.currentTarget as HTMLElement, () => createChannelModal.open('TEXT')));
    btnAddVoice?.addEventListener('click', (e) => withButtonLoading(e.currentTarget as HTMLElement, () => createChannelModal.open('VOICE')));
    btnInvite?.addEventListener('click', (e) => { this.closeServerDropdown(); withButtonLoading(e.currentTarget as HTMLElement, () => inviteModal.open()); });
    btnServerSettings?.addEventListener('click', (e) => { this.closeServerDropdown(); withButtonLoading(e.currentTarget as HTMLElement, () => serverSettingsModal.open()); });
    btnServerMonitor?.addEventListener('click', (e) => { this.closeServerDropdown(); withButtonLoading(e.currentTarget as HTMLElement, () => serverMonitorModal.open()); });
    void this.refreshServerMonitorVisibility();
    btnProfile?.addEventListener('click', (e) => withButtonLoading(e.currentTarget as HTMLElement, () => settingsModal.open()));
    const openOwnUserMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (serverStore.currentUser) {
        userContextMenu.open(event.clientX, event.clientY, serverStore.currentUser);
      }
    };
    btnProfile?.addEventListener('contextmenu', openOwnUserMenu);
    this.unbindEvents.push(() => btnProfile?.removeEventListener('contextmenu', openOwnUserMenu));
    btnSettings?.addEventListener('click', (e) => withButtonLoading(e.currentTarget as HTMLElement, () => settingsModal.open()));

    const dropdownToggle = document.getElementById('server-dropdown-toggle');
    dropdownToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('server-dropdown-menu');
      if (!menu) return;
      const isOpen = menu.style.display !== 'none';
      menu.style.display = isOpen ? 'none' : 'flex';
      dropdownToggle.classList.toggle('open', !isOpen);
    });
    const outsideClickHandler = (e: MouseEvent) => {
      const menu = document.getElementById('server-dropdown-menu');
      const toggle = document.getElementById('server-dropdown-toggle');
      if (!menu || menu.style.display === 'none') return;
      if (!menu.contains(e.target as Node) && !toggle?.contains(e.target as Node)) {
        this.closeServerDropdown();
      }
    };
    document.addEventListener('click', outsideClickHandler);
    this.unbindEvents.push(() => document.removeEventListener('click', outsideClickHandler));

    const clearTextChannelDragHover = () => this.clearTextChannelDragHover();
    document.addEventListener('drop', clearTextChannelDragHover);
    document.addEventListener('dragend', clearTextChannelDragHover);
    this.unbindEvents.push(
      () => document.removeEventListener('drop', clearTextChannelDragHover),
      () => document.removeEventListener('dragend', clearTextChannelDragHover)
    );

    const mediaCam = document.getElementById('media-btn-camera');
    const mediaScreen = document.getElementById('media-btn-screen');
    mediaCam?.addEventListener('click', async () => {
      if (!this.ensureInVoiceChannel()) return;
      if ((mediaCam as HTMLButtonElement).dataset.loading === '1') return;
      setButtonLoading(mediaCam, true);
      try {
        await this.voiceStageView?.toggleCamera();
      } finally {
        setButtonLoading(mediaCam, false);
      }
    });
    mediaScreen?.addEventListener('click', () => {
      if (!this.ensureInVoiceChannel()) return;
      if ((mediaScreen as HTMLButtonElement).dataset.loading === '1') return;
      // Show loading until the picker modal is actually open (#48).
      setButtonLoading(mediaScreen, true);
      window.setTimeout(() => setButtonLoading(mediaScreen, false), 10000);
      appEvents.emit('modal.open_screenshare_picker');
    });
    const clearScreenLoading = () => setButtonLoading(mediaScreen, false);
    const usL1 = appEvents.on('modal.screenshare_picker_opened', clearScreenLoading);
    const usL2 = appEvents.on('modal.screenshare_picker_closed', clearScreenLoading);
    this.unbindEvents.push(usL1, usL2);

    const mediaSoundboard = document.getElementById('media-btn-soundboard');
    mediaSoundboard?.addEventListener('click', () => {
      soundboardModal.open();
    });

    btnMic?.addEventListener('click', toggleMicrophoneMute);
    btnDeafen?.addEventListener('click', toggleAudioDeafen);
    this.unbindEvents.push(() => {
      btnMic?.removeEventListener('click', toggleMicrophoneMute);
      btnDeafen?.removeEventListener('click', toggleAudioDeafen);
    });

    btnDisconnect?.addEventListener('click', async () => {
      const confirmed = await showConfirm({
        title: t('main.disconnect'),
        message: t('main.disconnectMessage'),
        confirmLabel: t('main.disconnect'),
        variant: 'danger',
      });
      if (confirmed) {
        // Captured before the socket closes: afterwards there is no way to tell
        // whether this user was hosting the server they just left (#334).
        const leaveState = await captureHostedServerLeaveState();
        soundEffects.play('leave_voice');
        // Microphone and peer mesh are shared by every session (#400): tearing
        // them down while the call lives on another server would kill the audio
        // and still leave the user listed in that server's voice channel.
        if (this.callIsHere()) {
          audioProcessor.stopMicrophone();
          webRtcManager.closeAllPeers();
        }
        networkClient.disconnect();
        if (leaveState) await promptShutdownAfterLeave(leaveState);
      }
    });

    const u1 = appEvents.on('server.updated', () => {
      this.renderChannels();
      this.renderMembers();
      this.updatePermissionDependentUI();
    });

    const u2 = appEvents.on('participants.updated', () => {
      this.renderChannels();
      this.renderMembers();
      this.updateScreenShareNotice();
    });

    const u3 = appEvents.on('user.updated', (user) => {
      const avatarEl = document.getElementById('main-user-avatar') as HTMLImageElement;
      const nameEl = document.getElementById('main-user-name');
      if (avatarEl) avatarEl.src = getAvatarUrl(user.avatarUrl);
      if (nameEl) nameEl.innerText = user.nickname;
      this.renderMembers();
    });

    let lastLocalMuted = voiceStore.isMuted;
    let lastLocalDeafened = voiceStore.isDeafened;
    let lastServerMuted = voiceStore.serverMuted;
    let lastServerDeafened = voiceStore.serverDeafened;
    let lastVoiceChannelId = voiceStore.currentVoiceChannelId;
    const u4 = appEvents.on('voice.state_updated', () => {
      const avatarEl = document.getElementById('main-user-avatar');
      if (avatarEl) {
        if (voiceStore.isSpeaking) avatarEl.classList.add('speaking');
        else avatarEl.classList.remove('speaking');
      }

      const btnDeafenEl = document.getElementById('bar-btn-deafen');
      if (btnDeafenEl) {
        btnDeafenEl.className = `btn btn-icon ${voiceStore.getEffectiveDeafened() ? 'danger-active' : ''}`;
        btnDeafenEl.title = voiceStore.serverDeafened ? t('permissions.serverDeafened') : voiceStore.getEffectiveDeafened() ? t('main.undeafen') : t('main.deafen');
        updateAudioStateIcon(btnDeafenEl, voiceStore.serverDeafened ? 'headphones' : voiceStore.getEffectiveDeafened() ? 'headset_off' : 'headphones', voiceStore.serverDeafened);
      }

      const mediaCamEl = document.getElementById('media-btn-camera');
      if (mediaCamEl) {
        mediaCamEl.className = `btn btn-icon media-bar-btn-lg ${voiceStore.isCameraOn ? 'broadcasting-pulse active' : ''}`;
        const icon = mediaCamEl.querySelector(':scope > .material-symbols-outlined');
        const name = voiceStore.isCameraOn ? 'videocam_off' : 'videocam';
        if (icon && icon.textContent !== name) icon.textContent = name;
      }
      const mediaScreenEl = document.getElementById('media-btn-screen');
      if (mediaScreenEl) {
        mediaScreenEl.className = `btn btn-icon media-bar-btn-lg ${voiceStore.isScreenSharing ? 'broadcasting-pulse active' : ''}`;
        const icon = mediaScreenEl.querySelector(':scope > .material-symbols-outlined');
        const name = voiceStore.isScreenSharing ? 'stop_screen_share' : 'screen_share';
        if (icon && icon.textContent !== name) icon.textContent = name;
      }

      // Keep the local user's mute/deafen icons in the channel sidebar in sync,
      // but only re-render when those actually change (not on every VAD/speaking
      // update, which also emits this event) (#58).
      if (voiceStore.isMuted !== lastLocalMuted || voiceStore.isDeafened !== lastLocalDeafened
        || voiceStore.serverMuted !== lastServerMuted || voiceStore.serverDeafened !== lastServerDeafened) {
        lastLocalMuted = voiceStore.isMuted;
        lastLocalDeafened = voiceStore.isDeafened;
        lastServerMuted = voiceStore.serverMuted;
        lastServerDeafened = voiceStore.serverDeafened;
        this.renderChannels();
        this.renderMembers();
      }

      // Show/hide the sidebar voice-connection row when joining/leaving a call (#60).
      // Hanging up via VoiceStageView.leaveVoice() goes through voiceStore.reset(),
      // which only emits 'voice.state_updated', so the screen-share notice has to
      // be cleared here too — otherwise it lingers until the server echo (#282).
      if (voiceStore.currentVoiceChannelId !== lastVoiceChannelId) {
        lastVoiceChannelId = voiceStore.currentVoiceChannelId;
        this.updateVoiceConnectionRow();
        this.updateScreenShareNotice();
      }
    });

    const u5 = appEvents.on('voice.speaking_changed', (speaking: boolean) => {
      const avatarEl = document.getElementById('main-user-avatar');
      if (avatarEl) {
        if (speaking) avatarEl.classList.add('speaking');
        else avatarEl.classList.remove('speaking');
      }
      if (serverStore.currentUser) {
        const mySessionId = serverStore.currentUser.sessionId || serverStore.currentUser.id;
        const miniEl = document.getElementById(`voice-mini-user-${mySessionId}`);
        if (miniEl) {
          if (speaking) miniEl.classList.add('speaking');
          else miniEl.classList.remove('speaking');
        }
      }
    });

    const u6 = appEvents.on('participants.speaking_changed', (data: { sessionId: string; speaking: boolean }) => {
      const miniEl = document.getElementById(`voice-mini-user-${data.sessionId}`);
      if (miniEl) {
        if (data.speaking) miniEl.classList.add('speaking');
        else miniEl.classList.remove('speaking');
      }
    });

    const u7 = appEvents.on(`message.${MessageType.SERVER_SETTINGS_UPDATED}`, (payload: any) => {
      serverStore.updateServerMeta(payload.name, payload.hasPassword, payload.allowSoundboard, payload.iconUrl, payload.attachmentStorage, payload.maxUsers, payload.turnEnabled, payload.allowEveryoneMention, payload.allowMessageEdit, payload.voiceMode, payload.showRoleBadgesToEveryone);
      serverStore.setTurnAvailability(payload.turnAvailability);
      // The store above is the one of whichever server sent this. Everything
      // below writes to the screen and to the saved-server list, so it may only
      // run for the server actually being looked at (#400).
      if (!isForegroundEvent()) return;
      const titleEl = document.getElementById('server-name-title');
      if (titleEl) titleEl.innerText = payload.name;
      const iconEl = document.getElementById('server-header-icon') as HTMLImageElement;
      if (iconEl) iconEl.src = payload.iconUrl ? getAvatarUrl(payload.iconUrl) : logoUrl;
      // Persist the rename and the icon on the saved server entry. Only the icon
      // was written back, so Home and the sidebar kept the old name until the
      // next connection (#85).
      const url = networkClient.getCurrentServerUrl();
      if (url) {
        const match = url.match(/\/\/([^:]+):(\d+)/);
        if (match) {
          const host = match[1];
          const port = parseInt(match[2], 10);
          connectionStore.updateSavedServerMeta(host, port, {
            name: payload.name,
            iconUrl: toAbsoluteServerIconUrl(host, port, payload.iconUrl),
          });
          // A server hosted from this machine also has an entry in "Meus
          // Servidores", with its own copy of the name.
          if (host === '127.0.0.1' || host === 'localhost') {
            connectionStore.renameCreatedServerByPort(port, payload.name);
          }
        }
      }
      serverRailView.render();
    });

    const u7b = appEvents.on('connection.saved_servers_changed', () => {
      serverRailView.render();
    });

    // Badges for servers kept alive in the background: the call marker and the
    // unread dot both live on the rail (#400).
    const u7c = appEvents.on('session.background_activity', () => {
      serverRailView.render();
    });

    const u7d = appEvents.on('session.changed', (payload: { key: string | null }) => {
      // A null key means every server is gone and the connection screen is
      // taking over. The DOM check covers the mirror case: while the connection
      // screen is up, activating a session (a connection starting) must not
      // paint the server view over it. And a session with no details yet is one
      // still connecting — rendering it would blank the screen and unbind every
      // listener while the user waits (#400).
      if (!payload?.key || !serverStore.serverDetails) return;
      if (!document.getElementById('main-center-stage')) return;
      this.render();
    });

    const u8 = appEvents.on(`message.${MessageType.CHANNEL_DELETED}`, () => {
      // If the text channel currently shown was removed, fall back to the
      // remaining active channel so the chat view is never left orphaned.
      if (
        this.activeContentView === 'chat' &&
        serverStore.activeTextChannelId &&
        this.chatView
      ) {
        this.chatView.setChannel(serverStore.activeTextChannelId);
      }
    });

    // Joining/leaving a voice channel emits `voice.channel_changed` (not
    // `voice.state_updated`), so update the sidebar voice-connection row and the
    // channel list highlight here — otherwise the row only appeared by luck when
    // a later state update happened to fire (#60).
    const u9 = appEvents.on('voice.channel_changed', () => {
      lastVoiceChannelId = voiceStore.currentVoiceChannelId;
      this.updateVoiceConnectionRow();
      this.renderChannels();
      this.updateScreenShareNotice();
      // Keeps the "call is here" marker on the rail in sync (#400).
      serverRailView.render();
    });

    const u10 = appEvents.on('settings.updated', () => {
      const btnRnnoise = document.getElementById('sidebar-btn-rnnoise');
      if (btnRnnoise) {
        const enabled = settingsStore.noiseSuppressionEnabled;
        btnRnnoise.className = `btn btn-icon voice-conn-rnnoise ${enabled ? 'rnnoise-active' : ''}`;
        btnRnnoise.setAttribute('title', enabled ? t('main.rnnoiseOn') : t('main.rnnoiseOff'));
      }
      // Update the user status indicator when appear-offline changes (#561).
      const dot = document.getElementById('main-user-status-dot');
      if (dot) {
        dot.className = `status-indicator ${settingsStore.appearOffline ? 'invisible' : 'online'}`;
        dot.setAttribute('aria-label', settingsStore.appearOffline ? t('main.statusInvisible') : t('main.statusOnline'));
      }
      const statusText = document.getElementById('main-user-status-text');
      if (statusText) statusText.textContent = settingsStore.appearOffline ? t('main.statusInvisible') : t('main.statusOnline');
    });

    const u11 = appEvents.on('server.members_updated', () => {
      this.renderMembers();
    });

    // Re-render the channel list when an @-mention arrives or is cleared so the
    // red indicator on the text channel appears/disappears immediately (#14).
    const u12 = appEvents.on('chat.mentions_updated', () => {
      this.renderChannels();
    });

    // Same for the unread-messages dot (#263).
    const u13 = appEvents.on('chat.unread_updated', () => {
      this.renderChannels();
    });

    // Keep the sidebar overlay notice in sync: `state_changed` covers the window
    // opening/closing, `overlay_settings.updated` covers the "open on leaving the
    // stage" arm/disarm that also counts as active (#169).
    const u14 = appEvents.on('overlay.state_changed', () => this.updateOverlayNotice());
    const u15 = appEvents.on('overlay_settings.updated', () => this.updateOverlayNotice());

    // Repaint the sidebar voice row when the call flips in/out of reconnecting
    // so the icon, colour and status text track the live state (#553).
    const u16 = appEvents.on('voice.connection_changed', () => this.updateVoiceConnectionRow());

    this.unbindEvents.push(u1, u2, u3, u4, u5, u6, u7, u7b, u7c, u7d, u8, u9, u10, u11, u12, u13, u14, u15, u16);
  }

  /** True when the given text channel is the one currently visible on screen (#14). */
  public isViewingTextChannel(channelId: string): boolean {
    return (
      this.activeContentView === 'chat' &&
      serverStore.activeTextChannelId === channelId
    );
  }

  /**
   * Keeps the server rail clear of the floating user card (#473).
   *
   * The card overlaps the bottom of the rail, so without reserving room the
   * last servers in a long list would sit behind it, unreachable. The height is
   * measured instead of hardcoded because it changes with the screen-share
   * notice and the voice connection row.
   */
  private observeUserCardHeight(): void {
    this.userCardObserver?.disconnect();
    this.userCardObserver = null;

    const layout = this.container.querySelector('.main-layout') as HTMLElement | null;
    const card = this.container.querySelector('.user-control-bar') as HTMLElement | null;
    if (!layout || !card) return;

    const apply = () => {
      layout.style.setProperty('--user-card-height', `${Math.ceil(card.getBoundingClientRect().height)}px`);
    };
    apply();

    if (typeof ResizeObserver === 'undefined') return;
    this.userCardObserver = new ResizeObserver(apply);
    this.userCardObserver.observe(card);
  }

  private unbindListeners(): void {
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
  }

  public destroy(): void {
    this.stopSidebarPing();
    this.clearTextChannelDragHover();
    this.unbindListeners();
    soundboardPlayersBar.unmount();
    this.userCardObserver?.disconnect();
    this.userCardObserver = null;
    this.chatView?.destroy();
    this.voiceStageView?.destroy();
  }
}
