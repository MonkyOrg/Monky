import { MessageType, Permission, UserSummary, canAccessChannel, type ChannelDeletedPayload } from '@monky/shared';
import { categoryModal } from './CategoryModal';
import './channelCategories.css';
import { escapeHtml } from '../utils/html';
import { activityIconSrc } from '../utils/activityIcon';
import { animateEnter, cancelSurfaceMotion, hideWithMotion, positionAnchoredSurface, showWithMotion } from '../utils/surfaceMotion';
import { replaceAroundLiveChild } from '../utils/preserveLiveChild';
import { appEvents } from '../core/EventBus';
import { networkClient } from '../core/NetworkClient';
import { sessionManager } from '../core/SessionManager';
import { isForegroundEvent } from '../core/sessionRouting';
import { callClient, isVoiceAdmissionPending, joinCallOnSession, leaveCurrentCall, rejoinCallOnSession, showHome } from '../core/serverConnection';
import { participantManager } from '../core/ParticipantManager';
import { serverStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';
import { chatStore } from '../stores/chatStore';
import { settingsStore, ChatSoundMode } from '../stores/settingsStore';
import { connectionStore, SavedServer } from '../stores/connectionStore';
import { audioProcessor } from '../core/AudioProcessor';
import { selectNoiseSuppression } from '../core/AudioDeviceService';
import { webRtcManager } from '../core/WebRtcManager';
import { screenAudioService } from '../core/ScreenAudioService';
import { stopLocalScreenShares } from '../core/screenShareControls';
import { ChatView } from './ChatView';
import type { HomeView } from './home/HomeView';
import { bindPttIndicators, renderMicrophoneButton } from './PttIndicator';
import { bindAudioDevicePopovers } from './AudioDevicePopover';
import { bindFooterControlsMotion } from './FooterControlsMotion';
import { renderAudioMuteIndicators, renderAudioStateIcon, updateAudioStateIcon } from './AudioStateIcon';
import { getVoiceControlModeration, isViewingCallServer, toggleAudioDeafen, toggleMicrophoneMute } from '../core/voiceControls';
import { VoiceStageView } from './VoiceStageView';
import { createChannelModal } from './CreateChannelModal';
import { editChannelModal } from './EditChannelModal';
import { settingsModal } from './SettingsModal';
import { noiseSuppressionToggleTitle } from './settings/NoiseSuppressionControl';
import { serverSettingsModal } from './ServerSettingsModal';
import { serverMonitorModal } from './ServerMonitorModal';
import { recentSoundsModal } from './RecentSoundsModal';
import '../styles/connectionTransition.css';
import { inviteModal } from './InviteModal';
import { contextMenu, type ContextMenuEntry } from './ContextMenu';
import { showConfirm, showAlert } from './Dialog';
import { setButtonLoading, withButtonLoading } from '../utils/buttonLoading';
import { checkServerOnline } from '../utils/serverStatus';
import { warnIfMoveBlocked } from '../utils/channelAccess';
import { captureHostedServerLeaveState, promptShutdownAfterLeave } from '../utils/hostedServer';
import { userContextMenu } from './UserContextMenu';
import { soundboardModal } from './SoundboardModal';
import { soundEffects } from '../core/SoundEffects';
import { getAvatarUrl, toAbsoluteServerIconUrl } from '../utils/avatar';
import { ownAvatarSource } from '../core/profileSync';
import { peerFailureTooltip } from '../utils/peerFailureHint';
import { isParticipantSpeaking, participantConnectionIndicators, voiceConnectionIndicator } from '../utils/voiceConnection';
import { serverRailView } from './ServerRailView';
import { soundboardPlayersBar } from './SoundboardPlayersBar';
import { overlayBridgeService } from '../core/OverlayBridgeService';
import logoUrl from '../assets/Logo.png';
import { t, tCount } from '../i18n';
import { getBotVoiceContext } from '../utils/botVoice';
import { ServerCommunityView } from './ServerCommunityView';
import { MessageSearch } from './MessageSearch';
import { ForumView } from './ForumView';
import type { MessageSearchResultPayload } from '@monky/shared';

export class MainView {
  private container: HTMLElement;
  private chatView: ChatView | null = null;
  private communityView: ServerCommunityView | null = null;
  private messageSearch: MessageSearch | null = null;
  private forumView: ForumView | null = null;
  private chatInForum = false;
  private voiceChatView: ChatView | null = null;
  private voiceChatChannelId: string | null = null;
  private voiceChatResizeCleanup: (() => void) | null = null;
  private viewedVoiceChannelId: string | null = null;
  private viewedVoiceSessionKey: string | null = null;
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
  private displayedChannelId: string | null = null;
  private navigationKey: string | null = null;
  // Measures the floating user card so the server rail can reserve room for it
  // (#473).
  private userCardObserver: ResizeObserver | null = null;

  public setActiveContentView(view: 'chat' | 'stage'): void {
    const changed = this.activeContentView !== view;
    if (changed && view === 'chat') this.voiceStageView?.openAutomaticPictureInPicture();
    this.activeContentView = view;
    const tools = this.container.querySelector<HTMLElement>('#server-tools');
    if (tools) tools.hidden = view !== 'chat';
    if (view === 'stage') this.messageSearch?.close();
    if (changed) {
      if (view === 'chat') {
        this.voiceStageView?.destroy();
        this.closeVoiceChannelChat(false);
      }
      else this.chatView?.destroy();
      this.forumView?.destroy();
      this.forumView = null;
      const stage = this.container.querySelector<HTMLElement>('#main-center-stage');
      if (stage) animateEnter(stage, 'view');
      appEvents.emit('stage.visibility_changed', view === 'stage');
    }
  }

  constructor(container: HTMLElement, private readonly homeView?: HomeView) {
    this.container = container;
  }

  public render(preserveBotScreen = false): void {
    const home = sessionManager.isHome();
    const preserve = !home && preserveBotScreen && this.activeContentView === 'stage' && this.callIsHere() && this.voiceStageView?.hasOpenBotScreen();
    this.homeView?.suspend();
    this.unbindListeners();
    this.communityView?.destroy();
    this.forumView?.destroy();
    this.forumView = null;
    this.voiceChatView?.destroy();
    this.voiceChatView = null;
    this.messageSearch?.destroy();
    this.communityView = this.messageSearch = null;
    this.stopSidebarPing();

    if (home) {
      this.renderHomeShell();
      return;
    }

    if (!serverStore.serverDetails || !serverStore.currentUser) {
      return;
    }
    const activeSessionKey = sessionManager.getActiveKey();
    if (this.viewedVoiceSessionKey !== activeSessionKey) {
      this.viewedVoiceSessionKey = null;
      this.viewedVoiceChannelId = null;
      this.voiceChatChannelId = null;
    }
    if (this.viewedVoiceChannelId &&
        serverStore.getChannel(this.viewedVoiceChannelId)?.type !== 'VOICE') {
      this.viewedVoiceChannelId = null;
      this.viewedVoiceSessionKey = null;
      this.voiceChatChannelId = null;
    }
    if (this.activeContentView === 'stage' && !this.viewedVoiceChannelId && this.callIsHere()) {
      this.viewedVoiceChannelId = voiceStore.currentVoiceChannelId;
      this.viewedVoiceSessionKey = activeSessionKey;
    }

    const s = serverStore.serverDetails;
    const u = serverStore.currentUser;
    const canManageServer = serverStore.hasPermission(Permission.MANAGE_SERVER);
    const canManageRoles = serverStore.hasPermission(Permission.MANAGE_ROLES);
    const canManageBots = serverStore.hasPermission(Permission.MANAGE_BOTS);
    const moderation = getVoiceControlModeration();
    const navigationKey = home ? 'home' : sessionManager.getActiveKey();
    const navigating = this.navigationKey !== navigationKey;
    if (navigating && this.activeContentView === 'stage') this.voiceStageView?.openAutomaticPictureInPicture();
    this.navigationKey = navigationKey;

    const markup = `
      <div class="main-layout${home ? ' main-layout--home' : ''}">
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
            <div id="server-dropdown-menu" class="server-dropdown-menu" role="menu" aria-labelledby="server-dropdown-toggle" hidden>
              <button id="btn-server-settings" class="server-dropdown-item" title="${t('main.serverSettingsTitle')}" style="${canManageServer || canManageRoles || canManageBots || serverStore.hasPermission(Permission.MANAGE_EVENTS) ? '' : 'display: none;'}">
                <span class="material-symbols-outlined md-18">settings</span>
                <span>${t('serverSettings.title')}</span>
              </button>
              <button id="btn-server-monitor" class="server-dropdown-item" title="${t('serverMonitor.title')}" style="display: none;">
                <span class="material-symbols-outlined md-18">monitoring</span>
                <span>${t('serverMonitor.title')}</span>
              </button>
              <button id="btn-recent-sounds" class="server-dropdown-item" title="${t('recentSounds.title')}"
                style="${s.recentSoundCacheEnabled && s.protocol?.features.includes('recent-sounds') ? '' : 'display: none;'}">
                <span class="material-symbols-outlined md-18">history</span>
                <span>${t('recentSounds.title')}</span>
              </button>
              <button id="btn-invite-friends" class="server-dropdown-item" title="${t('main.inviteTitle')}">
                <span class="material-symbols-outlined md-18">person_add</span>
                <span>${t('invite.title')}</span>
              </button>
            </div>
          </div>

          <div class="channels-list-container" tabindex="0">
            <div id="server-community" hidden></div>
            <div id="channel-categories-list"></div>
          </div>

          <!-- Bottom User Bar -->
          <div class="user-control-bar">
            <div id="soundboard-players-slot" class="sb-notice-slot"></div>
            <div id="screenshare-notice-slot"></div>
            <div id="overlay-notice-slot"></div>
            <div id="voice-connection-row-slot"></div>
            <div class="user-media-bar" id="user-media-bar">
              <div class="audio-control-group camera-control-group">
                <button id="media-btn-camera" class="btn btn-icon media-bar-btn-lg ${voiceStore.isCameraOn ? 'broadcasting-pulse active' : ''}" title="${t('main.toggleCamera')}">
                  <span class="material-symbols-outlined md-18">${voiceStore.isCameraOn ? 'videocam_off' : 'videocam'}</span>
                </button>
                <button type="button" class="audio-device-trigger" data-audio-device="camera" aria-label="${t('cameraEffects.quickOptions')}" title="${t('cameraEffects.quickOptions')}">
                  <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
                </button>
              </div>
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
                  ${home ? `<span class="user-status-text" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>` : ''}
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
                  <button id="bar-btn-deafen" class="btn btn-icon ${voiceStore.isDeafened ? 'danger-active' : ''}" aria-pressed="${voiceStore.isDeafened}" title="${escapeHtml([t(voiceStore.isDeafened ? 'main.undeafen' : 'main.deafen'), moderation.deafenReason].filter(Boolean).join('. '))}">
                    ${renderAudioStateIcon(voiceStore.isDeafened ? 'headset_off' : 'headphones', moderation.serverDeafened)}
                  </button>
                  <button type="button" class="audio-device-trigger" data-audio-device="output" aria-label="${t('settings.outputDevice')}" title="${t('settings.outputDevice')}">
                    <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
                  </button>
                </div>
                <button id="bar-btn-settings" class="btn btn-icon" title="${t('connection.settingsTitle')}">
                  <span class="material-symbols-outlined md-18">settings</span>
                </button>
                <button id="bar-btn-disconnect" class="btn btn-icon" style="color: var(--danger);" title="${escapeHtml(t('main.disconnectFrom', { name: s.name }))}">
                  <span class="material-symbols-outlined md-18">logout</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Center: Chat Feed or Voice Stage -->
        <div class="main-center-column">
          <div id="server-tools" class="server-tools" ${this.activeContentView === 'stage' ? 'hidden' : ''}></div>
          <div id="main-center-stage" class="main-content-area"></div>
        </div>

        <!-- Right Sidebar: Connected Members -->
        <aside id="voice-channel-chat-panel" class="voice-channel-chat-panel" aria-label="${t('chat.voiceChannelBadge')}" hidden></aside>
        <div class="members-sidebar">
          <div class="members-header">
            <span id="members-count-label">${t('main.membersCount', { count: 0 })}</span>
          </div>
          <div id="members-list-items" class="members-list"></div>
        </div>
      </div>
    `;
    const preserved = preserve && replaceAroundLiveChild(this.container, markup, '.main-layout', '#main-center-stage');
    if (!preserved) {
      this.voiceStageView?.destroy();
      this.container.innerHTML = markup;
    }

    if (!home) {
      this.renderChannels();
      this.renderMembers();
    }
    serverRailView.render();
    if (!home) this.setupChannelsResizer();
    this.observeUserCardHeight();

    const centerStageEl = document.getElementById('main-center-stage')!;
    // Re-rendering happens on every server switch now (#400), so the previous
    // views must be torn down or their event listeners and ping timers would
    // pile up on each switch.
    if (preserved) this.voiceStageView?.render();
    else {
      this.chatView?.destroy();
      this.chatView = new ChatView(centerStageEl);
      this.chatInForum = false;
      this.chatView.onOpenForum = id => this.activateTextChannel(id);
      this.voiceStageView = new VoiceStageView(centerStageEl);
    }
    const voiceStageView = this.voiceStageView;
    if (!voiceStageView) throw new Error('The voice stage view was not initialized');
    voiceStageView.onToggleChat = channelId => this.toggleVoiceChannelChat(channelId);
    voiceStageView.onJoinChannel = async channelId => {
      if (!await this.handleJoinVoiceChannel(channelId)) return;
      if (voiceStore.currentVoiceChannelId !== channelId ||
          voiceStore.voiceSessionKey !== sessionManager.getActiveKey()) return;
      this.viewedVoiceChannelId = channelId;
      this.viewedVoiceSessionKey = sessionManager.getActiveKey();
      this.setActiveContentView('stage');
      this.voiceStageView?.setChannel(channelId);
      this.renderChannels();
      this.updateScreenShareNotice();
    };

    // A re-render (e.g. after switching languages, #16) must not drop someone
    // who is watching the voice stage back into the text channel. The session
    // check keeps the stage hidden when the call belongs to another server the
    // user has walked away from (#400).
    if (home) {
      if (!this.homeView) throw new Error('The Home view was not provided to the connected layout');
      appEvents.emit('stage.visibility_changed', false);
      const sidebarRoot = this.container.querySelector<HTMLElement>('#home-sidebar-root');
      if (sidebarRoot) this.homeView.render(sidebarRoot, centerStageEl);
    } else if (this.activeContentView === 'stage' &&
        (this.viewedVoiceChannelId || this.callIsHere())) {
      const channelId = this.viewedVoiceChannelId ?? voiceStore.currentVoiceChannelId;
      this.viewedVoiceChannelId = channelId;
      this.viewedVoiceSessionKey = sessionManager.getActiveKey();
      this.voiceStageView?.setChannel(channelId);
    } else if (serverStore.activeTextChannelId) {
      this.setActiveContentView('chat');
      this.showSelectedChannel(serverStore.activeTextChannelId);
    }

    this.attachEvents();
    if (this.activeContentView === 'stage' && this.voiceChatChannelId &&
        this.viewedVoiceSessionKey === sessionManager.getActiveKey()) {
      this.mountVoiceChannelChat(this.voiceChatChannelId, false);
    }
    const session = sessionManager.getActive();
    const communityRoot = this.container.querySelector<HTMLElement>('#server-community');
    const tools = this.container.querySelector<HTMLElement>('#server-tools');
    const center = this.container.querySelector<HTMLElement>('.main-center-column');
    if (!home && session && communityRoot && tools && center) {
      this.communityView = new ServerCommunityView(communityRoot, session.community, async channelId => {
        if (sessionManager.getActive() !== session) return;
        if (await this.handleJoinVoiceChannel(channelId)) {
          this.viewedVoiceChannelId = channelId;
          this.viewedVoiceSessionKey = session.key;
          this.setActiveContentView('stage');
          this.voiceStageView?.setChannel(channelId);
        }
      }, this.container.querySelector<HTMLElement>('.server-header') ?? undefined, channelId => {
        if (sessionManager.getActive() !== session) throw new Error(t('community.changed'));
        this.activateTextChannel(channelId);
      });
      this.messageSearch = new MessageSearch(tools, center, {
        channels: () => session.serverStore.serverDetails?.channels.filter(channel =>
          session.serverStore.hasPermission(Permission.READ_MESSAGES, channel.id)) ?? [],
        users: () => [...session.serverStore.knownMembers.values()],
        currentChannelId: () => this.activeContentView === 'chat'
          ? session.serverStore.activeTextChannelId
          : this.voiceChatChannelId,
        canRead: () => !!session.serverStore.serverDetails?.channels.some(channel =>
          session.serverStore.hasPermission(Permission.READ_MESSAGES, channel.id)),
        isCurrent: () => sessionManager.getActive() === session && !sessionManager.isHome() && session.client.getStatus() === 'CONNECTED',
        search: async (payload, signal) => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const id = crypto.randomUUID();
          const cancel = () => session.client.cancelRequest(id);
          signal.addEventListener('abort', cancel, { once: true });
          try { return await session.client.sendRequest<MessageSearchResultPayload>(MessageType.CHAT_SEARCH, payload, id); }
          finally { signal.removeEventListener('abort', cancel); }
        },
        navigate: (channelId, messageId) => {
          const channel = session.serverStore.getChannel(channelId);
          if (channel?.type === 'VOICE') {
            this.openVoiceChannelChat(channelId);
            void this.voiceChatView?.jumpToMessage(messageId);
          } else {
            this.activateTextChannel(channelId);
            void this.chatView?.jumpToMessage(messageId);
          }
        },
        setExpanded: expanded => {
          this.container.querySelector('.main-layout')?.classList.toggle('main-layout--search-open', expanded);
        },
        watch: invalidate => {
          const detach = session.client.onEvent(event => {
            if (event === 'network.status' || [
              MessageType.CHANNEL_UPDATED, MessageType.CHANNEL_CREATED, MessageType.CHANNEL_DELETED,
              MessageType.CATEGORIES_UPDATED, MessageType.ROLES_LIST, MessageType.CHAT_MESSAGE_UPDATED,
            ].some(type => event === `message.${type}`)) invalidate();
          });
          const locale = appEvents.on('i18n.language_changed', invalidate);
          return () => { detach(); locale(); };
        },
      });
    }
    this.updateVoiceConnectionRow();
    // Fresh DOM below means the (empty) slot must be repopulated, so drop the
    // cached signature (#282).
    this.screenShareNoticeSignature = null;
    this.updateScreenShareNotice();
    this.updateOverlayNotice();

    const soundboardSlot = document.getElementById('soundboard-players-slot');
    if (soundboardSlot) soundboardPlayersBar.mount(soundboardSlot);
    if (navigating) this.animateServerEntry();
  }

  private renderHomeShell(): void {
    if (!this.homeView) throw new Error('The Home view was not provided to the main layout');
    const navigationKey = 'home';
    const navigating = this.navigationKey !== navigationKey;
    this.navigationKey = navigationKey;
    this.activeContentView = 'chat';
    appEvents.emit('stage.visibility_changed', false);

    const nickname = connectionStore.savedNickname.trim() || t('home.defaultNickname');
    const avatar = ownAvatarSource();
    const moderation = getVoiceControlModeration();
    const markup = `
      <div class="main-layout main-layout--home">
        <div class="server-rail" id="server-rail"></div>
        <aside class="home-sidebar-shell" aria-label="${t('home.sidebarLabel')}">
          <div id="home-sidebar-root" class="home-sidebar-root"></div>
          <div class="user-control-bar">
            <div id="soundboard-players-slot" class="sb-notice-slot"></div>
            <div id="screenshare-notice-slot"></div>
            <div id="overlay-notice-slot"></div>
            <div id="voice-connection-row-slot"></div>
            <div class="user-media-bar" id="user-media-bar">
              <div class="audio-control-group camera-control-group">
                <button id="media-btn-camera" class="btn btn-icon media-bar-btn-lg ${voiceStore.isCameraOn ? 'broadcasting-pulse active' : ''}" title="${t('main.toggleCamera')}">
                  <span class="material-symbols-outlined md-18">${voiceStore.isCameraOn ? 'videocam_off' : 'videocam'}</span>
                </button>
                <button type="button" class="audio-device-trigger" data-audio-device="camera" aria-label="${t('cameraEffects.quickOptions')}" title="${t('cameraEffects.quickOptions')}">
                  <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
                </button>
              </div>
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
                  <img id="main-user-avatar" class="user-avatar-main ${voiceStore.isSpeaking ? 'speaking' : ''}" src="${getAvatarUrl(avatar)}" data-fallback="avatar">
                  <span id="main-user-status-dot" class="status-indicator ${settingsStore.appearOffline ? 'invisible' : 'online'}" role="img" aria-label="${settingsStore.appearOffline ? t('main.statusInvisible') : t('main.statusOnline')}"></span>
                </div>
                <div class="user-info-text">
                  <span id="main-user-name" class="user-name-display">${escapeHtml(nickname)}</span>
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
                  <button id="bar-btn-deafen" class="btn btn-icon ${voiceStore.isDeafened ? 'danger-active' : ''}" aria-pressed="${voiceStore.isDeafened}" title="${escapeHtml([t(voiceStore.isDeafened ? 'main.undeafen' : 'main.deafen'), moderation.deafenReason].filter(Boolean).join('. '))}">
                    ${renderAudioStateIcon(voiceStore.isDeafened ? 'headset_off' : 'headphones', moderation.serverDeafened)}
                  </button>
                  <button type="button" class="audio-device-trigger" data-audio-device="output" aria-label="${t('settings.outputDevice')}" title="${t('settings.outputDevice')}">
                    <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
                  </button>
                </div>
                <button id="bar-btn-settings" class="btn btn-icon" title="${t('connection.settingsTitle')}">
                  <span class="material-symbols-outlined md-18">settings</span>
                </button>
              </div>
            </div>
          </div>
        </aside>
        <main class="main-center-column home-center-column">
          <div id="server-tools" class="server-tools" hidden></div>
          <div id="main-center-stage" class="main-content-area home-main-content"></div>
        </main>
      </div>
    `;
    this.container.innerHTML = markup;
    serverRailView.render();
    const sidebarRoot = this.container.querySelector<HTMLElement>('#home-sidebar-root');
    const centerStageEl = this.container.querySelector<HTMLElement>('#main-center-stage');
    if (sidebarRoot && centerStageEl) this.homeView.render(sidebarRoot, centerStageEl);
    this.observeUserCardHeight();
    this.attachEvents();
    this.updateVoiceConnectionRow();
    this.screenShareNoticeSignature = null;
    this.updateScreenShareNotice();
    this.updateOverlayNotice();
    const soundboardSlot = document.getElementById('soundboard-players-slot');
    if (soundboardSlot) soundboardPlayersBar.mount(soundboardSlot);
    if (navigating) this.animateServerEntry();
  }

  private animateServerEntry(): void {
    const layout = this.container.querySelector<HTMLElement>('.main-layout');
    if (!layout) return;
    const stage = this.container.querySelector<HTMLElement>('#main-center-stage');
    if (stage) cancelSurfaceMotion(stage);
    animateEnter(layout, 'view');
    this.unbindEvents.push(() => cancelSurfaceMotion(layout));
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

    const session = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
    const vc = session?.serverStore.getChannel(voiceStore.currentVoiceChannelId ?? '');
    if (!voiceStore.currentVoiceChannelId || !vc) {
      slot.innerHTML = '';
      this.stopSidebarPing();
      return;
    }

    const reconnecting = voiceStore.isReconnecting;
    const connecting = voiceStore.isConnecting;
    const connectionClass = reconnecting ? 'reconnecting' : connecting ? 'connecting' : '';
    const serverName = sessionManager.isHome() ? '' : session?.serverStore.serverDetails?.name ?? '';
    const { quality, icon } = voiceConnectionIndicator(null, reconnecting, connecting);
    const statusText = reconnecting ? t('main.reconnecting') : connecting ? t('main.connecting') : t('main.voiceConnected');
    const noiseMode = settingsStore.noiseSuppressionMode;
    const noiseEnabled = noiseMode !== 'off';
    const noiseTitle = escapeHtml(noiseSuppressionToggleTitle(noiseMode));

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
          <div class="audio-control-group noise-control-group">
            <button type="button" id="sidebar-btn-rnnoise" class="btn btn-icon voice-conn-rnnoise ${noiseEnabled ? 'rnnoise-active' : ''}" title="${noiseTitle}" aria-label="${noiseTitle}" aria-pressed="${noiseEnabled}">
              <span class="material-symbols-outlined md-18">graphic_eq</span>
            </button>
            <button type="button" class="audio-device-trigger" data-audio-device="noise" aria-label="${t('audioNoise.quickOptions')}" title="${t('audioNoise.quickOptions')}">
              <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
            </button>
          </div>
          <button id="sidebar-btn-leave-voice" class="btn btn-icon voice-conn-leave" title="${t('main.leaveCall')}">
            <span class="material-symbols-outlined md-18">call_end</span>
          </button>
        </div>
      </div>
    `;

    const btnRnnoise = document.querySelector<HTMLButtonElement>('#sidebar-btn-rnnoise');
    btnRnnoise?.addEventListener('click', async () => {
      if (!btnRnnoise || btnRnnoise.disabled) return;
      btnRnnoise.disabled = true;
      try {
        const currentMode = settingsStore.noiseSuppressionMode;
        await selectNoiseSuppression(currentMode === 'off' ? settingsStore.lastNoiseSuppressionMode : 'off');
      } catch (error: unknown) {
        console.warn('[MainView] Could not change noise suppression:', error);
        await showAlert({ title: t('common.error'), message: t('audioNoise.selectionFailed'), variant: 'danger' });
      } finally {
        btnRnnoise.disabled = false;
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
      const sessionKey = voiceStore.voiceSessionKey;
      const participants = (sessionKey ? sessionManager.get(sessionKey)?.participants.getInVoiceChannel(channelId ?? '') : undefined) ?? [];
      const pending = voiceStore.isConnecting || voiceStore.isReconnecting;
      const avg = pending ? null : participants.length <= 1 && !isSfu ? 0 : await webRtcManager.getAverageP2pPing();
      if (!pingEl.isConnected || channelId !== voiceStore.currentVoiceChannelId || sessionKey !== voiceStore.voiceSessionKey) return;
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

  private updateParticipantSpeaking(sessionId?: string): void {
    for (const row of this.container.querySelectorAll<HTMLElement>('.voice-participant-mini[data-session-id]')) {
      const id = row.dataset.sessionId;
      if (!id || (sessionId && id !== sessionId)) continue;
      row.classList.toggle('speaking', isParticipantSpeaking(participantManager.get(id)));
    }
  }

  /**
   * Remote participants broadcasting their screen in the voice channel the
   * local user is currently connected to (#282).
   */
  private getRemoteScreenSharers(): Array<{ id: string; nickname: string }> {
    const channelId = voiceStore.currentVoiceChannelId;
    const session = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
    if (!channelId || !session) return [];
    return session.participants
      .getInVoiceChannel(channelId)
      .filter((p) => !session.serverStore.isMySession(p.user.sessionId) && (p.voiceState?.isScreenSharing ?? false))
      .map((p) => ({
        id: p.user.sessionId || p.user.id,
        nickname: session.participants.displayName(p),
      }));
  }

  private getWatchedRemoteScreens(): Array<{ sessionId: string; shareId: string }> {
    const channelId = voiceStore.currentVoiceChannelId;
    const session = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
    if (!channelId || !session) return [];
    return voiceStore.getScreenWatchers().flatMap(([sessionId, shareIds]) => {
      const participant = session.participants.get(sessionId);
      if (!participant || participant.voiceState?.channelId !== channelId
        || session.serverStore.isMySession(participant.user.sessionId)) return [];
      return shareIds.map(shareId => ({ sessionId, shareId }));
    });
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

    const watchedScreens = this.getWatchedRemoteScreens();
    const watchedSessions = new Set(watchedScreens.map(screen => screen.sessionId));
    const sharers = this.getRemoteScreenSharers().filter(sharer => !watchedSessions.has(sharer.id));
    const isSelfSharing = voiceStore.isScreenSharing;
    const voice = getBotVoiceContext();
    const screens = voice ? voice.session.botScreenStore.list(voice.channelId)
      .filter((screen) => !this.voiceStageView?.isWatchingBotScreen(screen.id)
        && !voice.session.botScreenStore.isInvitationDismissed(screen.id)) : [];
    const loadFailed = voice?.session.botScreenStore.loadFailed ?? false;
    const signature = JSON.stringify([
      this.activeContentView, isSelfSharing, watchedScreens, sharers, voice?.session.key, voice?.channelId,
      screens.map((screen) => [screen.id, screen.instanceId, screen.title]), loadFailed,
    ]);
    if (signature === this.screenShareNoticeSignature) return;
    this.screenShareNoticeSignature = signature;

    if ((this.activeContentView === 'stage'
      || (watchedScreens.length === 0 && sharers.length === 0 && !isSelfSharing))
      && screens.length === 0 && !loadFailed) {
      slot.innerHTML = '';
      return;
    }

    const parts: string[] = [];

    // Local user sharing notice with stop button (#416)
    if (isSelfSharing && this.activeContentView !== 'stage') {
      parts.push(`
        <div class="screenshare-notice screenshare-notice--self">
          <span class="material-symbols-outlined md-16 screenshare-notice-icon">screen_share</span>
          <span class="screenshare-notice-text">${t('main.screenShareSelfNotice')}</span>
          <button id="screenshare-self-stop-btn" class="screenshare-notice-btn screenshare-notice-btn--danger">${t('screenShare.stopSharing')}</button>
        </div>
      `);
    }

    if (watchedScreens.length > 0 && this.activeContentView !== 'stage') {
      parts.push(`
        <div class="screenshare-notice screenshare-notice--self screenshare-notice--stacked">
          <span class="material-symbols-outlined md-16 screenshare-notice-icon">visibility</span>
          <span class="screenshare-notice-text">${t('main.screenShareWatchingNotice')}</span>
          <div class="screenshare-notice-actions">
            <button type="button" id="screenshare-viewer-stage-btn" class="screenshare-notice-btn">${t('main.screenShareBackToStage')}</button>
            <button type="button" id="screenshare-viewer-stop-btn" class="screenshare-notice-btn screenshare-notice-btn--danger">${t('stage.stopWatching')}</button>
          </div>
        </div>
      `);
    }

    // Remote sharers notice
    if (sharers.length > 0 && this.activeContentView !== 'stage') {
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

    for (const screen of screens) {
      const label = escapeHtml(t('botScreen.invitation', { title: screen.title }));
      parts.push(`
        <div class="screenshare-notice bot-screen-invitation">
          <span class="material-symbols-outlined md-16 screenshare-notice-icon" aria-hidden="true">apps</span>
          <span class="screenshare-notice-text" title="${label}">${label}</span>
          <button type="button" class="screenshare-notice-btn" data-watch-bot-screen="${escapeHtml(screen.id)}"
            data-bot-screen-instance="${escapeHtml(screen.instanceId)}"
            aria-label="${escapeHtml(t('botScreen.open', { title: screen.title }))}">${t('botScreen.watch')}</button>
        </div>
      `);
    }
    if (loadFailed) {
      parts.push(`<div class="screenshare-notice bot-screen-invitation">
        <span class="screenshare-notice-text" role="status">${t('botScreen.loadError')}</span>
        <button type="button" class="screenshare-notice-btn" data-reload-bot-screens>${t('botScreen.retry')}</button>
      </div>`);
    }
    slot.innerHTML = parts.join('');
    slot.querySelectorAll<HTMLButtonElement>('[data-watch-bot-screen]').forEach((button) => {
      button.addEventListener('click', () => {
        const current = getBotVoiceContext();
        if (!voice || current?.session !== voice.session || current.channelId !== voice.channelId) return;
        const id = button.dataset.watchBotScreen;
        const screen = id ? current.session.botScreenStore.get(id) : undefined;
        if (!screen || screen.instanceId !== button.dataset.botScreenInstance) return;
        this.openVoiceStage(undefined, screen.id);
      });
    });
    slot.querySelector('[data-reload-bot-screens]')?.addEventListener('click', () => appEvents.emit('voice.bot_screens_reload'));

    // Stop self-sharing handler
    document.getElementById('screenshare-self-stop-btn')?.addEventListener('click', async () => {
      try {
        await stopLocalScreenShares(screenAudioService);
      } catch (error) {
        await showAlert({
          title: t('screenShare.errorTitle'),
          message: t('screenShare.errorMessage', { error: error instanceof Error ? error.message : String(error) }),
          variant: 'danger',
        });
      }
      this.updateScreenShareNotice();
    });

    document.getElementById('screenshare-viewer-stage-btn')?.addEventListener('click', () => this.openVoiceStage());

    document.getElementById('screenshare-viewer-stop-btn')?.addEventListener('click', () => {
      for (const [sessionId, shareIds] of voiceStore.getScreenWatchers()) {
        for (const shareId of shareIds) webRtcManager.setRemoteScreenWatching(sessionId, shareId, false);
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
  private openVoiceStage(watchSessionId?: string, botScreenId?: string): void {
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    if (!channelId || !sessionKey || !sessionManager.get(sessionKey)) return;
    // A notice can belong to the background call, never to the current text tab.
    if (sessionManager.isHome() || sessionManager.getActiveKey() !== sessionKey) sessionManager.activate(sessionKey);
    this.viewedVoiceChannelId = channelId;
    this.viewedVoiceSessionKey = sessionKey;
    this.setActiveContentView('stage');
    this.voiceStageView?.setChannel(channelId);
    if (watchSessionId) this.voiceStageView?.watchScreenShare(watchSessionId);
    if (botScreenId) this.voiceStageView?.watchBotScreen(botScreenId);
    this.renderChannels();
    this.updateScreenShareNotice();
  }

  private closeServerDropdown(): void {
    const menu = document.getElementById('server-dropdown-menu');
    const toggle = document.getElementById('server-dropdown-toggle');
    if (menu && !menu.hidden) hideWithMotion(menu, 'popover');
    toggle?.classList.remove('open');
    toggle?.setAttribute('aria-expanded', 'false');
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
    const max = Math.max(min, Math.floor(window.innerWidth * 0.175));
    return Math.min(max, Math.max(min, width));
  }

  private clampVoiceChatWidth(width: number): number {
    const min = 480;
    const layout = this.container.querySelector<HTMLElement>('.main-layout');
    const channels = layout?.querySelector<HTMLElement>(':scope > .channels-sidebar');
    const rail = layout?.querySelector<HTMLElement>(':scope > .server-rail');
    const layoutWidth = layout?.getBoundingClientRect().width || window.innerWidth;
    const reservedWidth = (channels?.getBoundingClientRect().width ?? 0) +
      (rail?.getBoundingClientRect().width ?? 0) + 320;
    const max = Math.max(min, Math.min(720, Math.floor(layoutWidth - reservedWidth)));
    return Math.min(max, Math.max(min, Math.round(width)));
  }

  private activateTextChannel(channelId: string): void {
    this.clearTextChannelDragHover();
    this.viewedVoiceChannelId = null;
    this.viewedVoiceSessionKey = null;
    this.closeVoiceChannelChat(false);
    serverStore.setActiveTextChannel(channelId);
    this.setActiveContentView('chat');
    this.showSelectedChannel(channelId);
    this.renderChannels();
    this.updateScreenShareNotice();
  }

  private openVoiceChannelChat(channelId: string): void {
    const channel = serverStore.getChannel(channelId);
    if (channel?.type !== 'VOICE' || !serverStore.hasPermission(Permission.READ_MESSAGES, channelId)) return;
    this.viewedVoiceChannelId = channelId;
    this.viewedVoiceSessionKey = sessionManager.getActiveKey();
    this.voiceChatChannelId = channelId;
    this.setActiveContentView('stage');
    this.voiceStageView?.setChannel(channelId);
    this.mountVoiceChannelChat(channelId, true);
    this.renderChannels();
    this.updateScreenShareNotice();
  }

  private toggleVoiceChannelChat(channelId: string): void {
    const panel = this.container.querySelector<HTMLElement>('#voice-channel-chat-panel');
    if (this.voiceChatChannelId === channelId && panel && !panel.hidden) {
      this.closeVoiceChannelChat(true);
      this.renderChannels();
      return;
    }
    this.openVoiceChannelChat(channelId);
  }

  private mountVoiceChannelChat(channelId: string, animate: boolean): void {
    const panel = this.container.querySelector<HTMLElement>('#voice-channel-chat-panel');
    const layout = this.container.querySelector<HTMLElement>('.main-layout');
    const channel = serverStore.getChannel(channelId);
    if (!panel || !layout || channel?.type !== 'VOICE' ||
        !serverStore.hasPermission(Permission.READ_MESSAGES, channelId)) {
      this.closeVoiceChannelChat(false);
      return;
    }
    this.voiceChatView?.destroy();
    panel.innerHTML = `
      <div class="voice-chat-resizer" role="separator" aria-orientation="vertical" tabindex="0"
        aria-label="${t('main.resizeHandle')}" title="${t('main.resizeHandle')}"></div>
      <button type="button" class="voice-chat-close" aria-label="${t('voiceChat.close')}" title="${t('voiceChat.close')}">
        <span class="material-symbols-outlined md-20" aria-hidden="true">close</span>
      </button>
      <div class="voice-chat-content"></div>
    `;
    this.voiceChatChannelId = channelId;
    layout.classList.add('main-layout--voice-chat-open');
    const content = panel.querySelector<HTMLElement>('.voice-chat-content')!;
    this.voiceChatView = new ChatView(content);
    this.voiceChatView.setChannel(channelId);
    panel.querySelector<HTMLButtonElement>('.voice-chat-close')?.addEventListener('click', () => {
      this.closeVoiceChannelChat(true);
      this.renderChannels();
    });
    this.setupVoiceChatResizer(panel);
    if (animate) showWithMotion(panel, 'panel');
    else panel.hidden = false;
    this.voiceStageView?.setChatOpen(true);
  }

  private setupVoiceChatResizer(panel: HTMLElement): void {
    this.voiceChatResizeCleanup?.();
    const resizer = panel.querySelector<HTMLElement>('.voice-chat-resizer');
    if (!resizer) return;

    const persist = () => {
      try {
        localStorage.setItem('monky_voice_chat_width', String(Math.round(panel.getBoundingClientRect().width)));
      } catch {}
    };
    const applyWidth = (width: number, save: boolean) => {
      const next = this.clampVoiceChatWidth(width);
      panel.style.width = `${next}px`;
      resizer.setAttribute('aria-valuenow', String(next));
      if (save) persist();
    };
    resizer.setAttribute('aria-valuemin', '480');
    resizer.setAttribute('aria-valuemax', String(this.clampVoiceChatWidth(Number.MAX_SAFE_INTEGER)));
    resizer.setAttribute('aria-valuenow', String(
      this.clampVoiceChatWidth(Number.parseFloat(getComputedStyle(panel).width) || 480),
    ));
    try {
      const saved = Number.parseInt(localStorage.getItem('monky_voice_chat_width') ?? '', 10);
      if (Number.isFinite(saved)) applyWidth(saved, false);
    } catch {}

    let startX = 0;
    let startWidth = 0;
    let dragging = false;
    const stopDragging = (save: boolean) => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizer.classList.remove('is-resizing');
      if (save) persist();
    };
    const onMove = (event: MouseEvent) => {
      applyWidth(startWidth + startX - event.clientX, false);
    };
    const onUp = () => stopDragging(true);
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = panel.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      resizer.classList.add('is-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const current = panel.getBoundingClientRect().width;
      let next: number | null = null;
      if (event.key === 'ArrowLeft') next = current + 24;
      else if (event.key === 'ArrowRight') next = current - 24;
      else if (event.key === 'Home') next = 480;
      else if (event.key === 'End') next = Number.MAX_SAFE_INTEGER;
      if (next === null) return;
      event.preventDefault();
      applyWidth(next, true);
    };
    const onWindowResize = () => {
      if (panel.style.width) applyWidth(panel.getBoundingClientRect().width, false);
    };
    resizer.addEventListener('mousedown', onMouseDown);
    resizer.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onWindowResize);
    this.voiceChatResizeCleanup = () => {
      stopDragging(false);
      resizer.removeEventListener('mousedown', onMouseDown);
      resizer.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
      this.voiceChatResizeCleanup = null;
    };
  }

  private closeVoiceChannelChat(animate: boolean): void {
    this.voiceChatResizeCleanup?.();
    this.voiceChatView?.destroy();
    this.voiceChatView = null;
    this.voiceChatChannelId = null;
    this.container.querySelector('.main-layout')?.classList.remove('main-layout--voice-chat-open');
    this.voiceStageView?.setChatOpen(false);
    const panel = this.container.querySelector<HTMLElement>('#voice-channel-chat-panel');
    if (!panel) return;
    if (animate) hideWithMotion(panel, 'panel', () => panel.replaceChildren());
    else {
      cancelSurfaceMotion(panel);
      panel.hidden = true;
      panel.replaceChildren();
    }
  }

  private showSelectedChannel(channelId: string): void {
    const channel = serverStore.getChannel(channelId);
    const session = sessionManager.getActive();
    const root = this.container.querySelector<HTMLElement>('#main-center-stage');
    const forumId = channel?.type === 'FORUM' ? channel.id : channel?.forumId;
    const entering = this.displayedChannelId !== channelId && (!forumId || this.forumView?.channelId !== forumId);
    this.displayedChannelId = channelId;
    if (forumId && session && root) {
      if (this.forumView?.channelId !== forumId || !root.querySelector('.forum-layout')) {
        this.chatView?.destroy();
        this.forumView?.destroy();
        root.innerHTML = '<div class="forum-layout"><div class="forum-header"></div><div class="forum-list-pane"></div><aside class="forum-discussion-pane" hidden></aside></div>';
        this.forumView = new ForumView(root.querySelector<HTMLElement>('.forum-list-pane')!, session.client, session.serverStore,
          forumId, id => this.activateTextChannel(id), root.querySelector<HTMLElement>('.forum-header')!);
        this.chatView = new ChatView(root.querySelector<HTMLElement>('.forum-discussion-pane')!);
        this.chatView.onOpenForum = id => this.activateTextChannel(id);
        this.chatInForum = true;
      }
      const discussion = root.querySelector<HTMLElement>('.forum-discussion-pane')!;
      if (channel?.type === 'FORUM') {
        this.chatView?.destroy();
        hideWithMotion(discussion, 'panel', () => discussion.replaceChildren());
      } else {
        if (discussion.hidden || discussion.hasAttribute('data-ui-closing')) showWithMotion(discussion, 'panel');
        this.chatView?.setChannel(channelId);
      }
      if (entering && root) animateEnter(root, 'view');
    } else {
      this.forumView?.destroy();
      this.forumView = null;
      if (this.chatInForum && root) {
        this.chatView?.destroy();
        this.chatView = new ChatView(root);
        this.chatView.onOpenForum = id => this.activateTextChannel(id);
        this.chatInForum = false;
      }
      this.chatView?.setChannel(channelId);
    }
  }

  private handleChannelDeleted(payload: ChannelDeletedPayload): void {
    if (this.viewedVoiceChannelId && !serverStore.getChannel(this.viewedVoiceChannelId)) {
      this.viewedVoiceChannelId = null;
      this.viewedVoiceSessionKey = null;
      this.closeVoiceChannelChat(false);
      if (this.activeContentView === 'stage') {
        if (this.callIsHere()) {
          this.viewedVoiceChannelId = voiceStore.currentVoiceChannelId;
          this.viewedVoiceSessionKey = sessionManager.getActiveKey();
          this.voiceStageView?.setChannel(voiceStore.currentVoiceChannelId);
        } else if (serverStore.activeTextChannelId) {
          this.activateTextChannel(serverStore.activeTextChannelId);
        }
      }
    }
    if (
      isForegroundEvent() &&
      this.activeContentView === 'chat' &&
      payload.channelId === this.displayedChannelId &&
      this.forumView &&
      serverStore.getChannel(this.forumView.channelId)
    ) {
      this.activateTextChannel(this.forumView.channelId);
      return;
    }
    if (
      isForegroundEvent() && !sessionManager.isHome() &&
      this.activeContentView === 'chat' &&
      serverStore.activeTextChannelId &&
      this.chatView
    ) {
      this.showSelectedChannel(serverStore.activeTextChannelId);
    }
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

    const textListEl = document.createElement('div');
    const voiceListEl = document.createElement('div');
    const canManageChannels = serverStore.hasPermission(Permission.MANAGE_CHANNELS);
    const permissionsResolved = this.arePermissionsResolved();

    const textChannels = serverStore.serverDetails.channels.filter((c) => (c.type === 'TEXT' || c.type === 'FORUM') && !c.forumId);
    const voiceChannels = serverStore.serverDetails.channels.filter((c) => c.type === 'VOICE');

    if (textListEl) {
      textListEl.innerHTML = textChannels.map((c) => `
        <div class="channel-item ${(c.id === serverStore.activeTextChannelId || c.id === serverStore.getChannel(serverStore.activeTextChannelId ?? '')?.forumId) && this.activeContentView === 'chat' ? 'active' : ''}" data-channel-id="${c.id}" data-channel-type="${c.type}">
          <span class="material-symbols-outlined md-16 channel-icon" style="color: var(--text-muted);">${c.type === 'FORUM' ? 'forum' : 'tag'}</span>
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
        const isActive = isViewingCallServer() && c.id === voiceStore.currentVoiceChannelId;
        const isViewing = this.activeContentView === 'stage' &&
          this.viewedVoiceSessionKey === sessionManager.getActiveKey() &&
          this.viewedVoiceChannelId === c.id;
        const showRestrictedIcon = permissionsResolved && !serverStore.hasPermission(Permission.VIEW_CHANNEL, c.id);
        const isRestricted = showRestrictedIcon && !isActive;
        const hasMention = chatStore.hasMention(c.id);
        const hasUnread = chatStore.hasUnread(c.id);

        return `
          <div class="voice-channel-group" data-channel-id="${c.id}" style="display: flex; flex-direction: column;">
            <div class="channel-item ${isViewing ? 'active' : ''} ${isRestricted ? 'restricted' : ''}" data-channel-id="${c.id}" data-channel-type="VOICE">
              <span class="material-symbols-outlined md-16 channel-icon" style="color: ${isActive ? 'var(--success)' : 'var(--text-muted)'};">volume_up</span>
              <span class="channel-name">${escapeHtml(c.name)}</span>
              ${c.isPrivate ? `<span class="material-symbols-outlined md-16 channel-private-icon" title="${t('main.privateChannelBadge')}">lock_person</span>` : ''}
              ${showRestrictedIcon ? `<span class="material-symbols-outlined md-16 channel-restricted-icon" title="${t('main.voiceChannelRestricted')}">lock</span>` : ''}
              ${isActive ? `<span style="font-size: 11px; color: var(--success); font-weight: 600;">(${t('common.you')})</span>` : ''}
              <span class="voice-channel-actions">
                ${serverStore.hasPermission(Permission.READ_MESSAGES, c.id) ? `<button type="button" class="voice-chat-btn ${hasMention ? 'has-mention' : hasUnread ? 'has-unread' : ''}"
                  data-voice-chat-channel="${c.id}" title="${t('voiceChat.open')}" aria-label="${t('voiceChat.open')}">
                  <span class="material-symbols-outlined md-16" aria-hidden="true">chat_bubble</span>
                </button>` : ''}
                <button class="channel-menu-btn" data-menu-channel="${c.id}" title="${t('common.moreOptions')}">
                  <span class="material-symbols-outlined md-16">more_vert</span>
                </button>
              </span>
            </div>

            ${inVoice.length > 0 ? `
              <div class="voice-participants-sublist">
                ${inVoice.map((p) => {
                  const sessionId = p.user.sessionId || p.user.id;
                  const isLocal = serverStore.isMySession(p.user.sessionId);
                  const isLocalCall = isLocal && isViewingCallServer() && !!voiceStore.currentVoiceChannelId;
                  const isSpeaking = isParticipantSpeaking(p);
                  const isServerDeafened = isLocalCall ? voiceStore.serverDeafened : (p.voiceState?.serverDeafened ?? false);
                  const isServerMuted = isLocalCall ? voiceStore.serverMuted : (p.voiceState?.serverMuted ?? false);
                  const isPermissionMuted = isLocalCall ? voiceStore.permissionMuted : (p.voiceState?.permissionMuted ?? false);
                  const isSelfDeafened = isLocalCall ? voiceStore.isDeafened : (p.voiceState?.isDeafened ?? false);
                  const isSelfMuted = isLocalCall ? voiceStore.isMuted : (p.voiceState?.isMuted ?? false);
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
                      ${renderAudioMuteIndicators({ ...p.voiceState, isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened, permissionMuted: isPermissionMuted })}
                      ${p.voiceState?.isScreenSharing ? `<span class="material-symbols-outlined md-14 voice-mini-icon live" title="${t('main.sharingScreen')}">screen_share</span>` : ''}
                      ${p.voiceState?.isCameraOn ? `<span class="material-symbols-outlined md-14 voice-mini-icon" title="${t('main.cameraOn')}">videocam</span>` : ''}
                      ${p.user.activity ? (activityIconSrc(p.user.activity.iconBase64)
                        ? `<img class="voice-mini-art" src="${activityIconSrc(p.user.activity.iconBase64)}" alt="" title="${escapeHtml(t('main.playingGame', { game: p.user.activity.name }))}">`
                        : `<span class="material-symbols-outlined md-18 voice-mini-icon" title="${escapeHtml(t('main.playingGame', { game: p.user.activity.name }))}">sports_esports</span>`) : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }

    const categoryList = this.container.querySelector<HTMLElement>('#channel-categories-list');
    if (categoryList) {
      const rows = new Map<string, string>();
      for (const row of [...textListEl.children, ...voiceListEl.children]) {
        const id = row.getAttribute('data-channel-id');
        if (id) rows.set(id, row.outerHTML);
      }
      const categories = serverStore.serverDetails.categories ?? [];
      const knownCategoryIds = new Set(categories.map((category) => category.id));
      const groups = [
        { id: '', name: t('categories.uncategorized') },
        ...categories.map((category) => ({ id: category.id, name: category.name })),
      ];
      categoryList.innerHTML = groups.map((group) => {
        const canManage = canManageChannels;
        const channels = serverStore.serverDetails!.channels.filter((channel) =>
          group.id ? channel.categoryId === group.id : !channel.categoryId || !knownCategoryIds.has(channel.categoryId));
        const collapsed = !!group.id && serverStore.isCategoryCollapsed(group.id);
        return `<section class="channel-category${group.id ? '' : ' channel-category--uncategorized'}${channels.length ? '' : ' channel-category--empty'}" data-category-id="${escapeHtml(group.id)}">
          ${group.id ? `<div class="category-title" data-category-dropzone="${escapeHtml(group.id)}">
            <button class="category-collapse-btn" data-collapse-category="${escapeHtml(group.id)}" aria-expanded="${!collapsed}">
              <span class="material-symbols-outlined md-16">${collapsed ? 'chevron_right' : 'expand_more'}</span>
              <span>${escapeHtml(group.name)}</span>
            </button>
            ${canManage ? `<button class="category-add-btn" data-add-category="${escapeHtml(group.id)}" title="${t('categories.addChannel')}">
              <span class="material-symbols-outlined md-14">add</span></button>` : ''}
          </div>` : canManage ? `<div class="category-uncategorized-dropzone" data-category-dropzone="">
            <span class="material-symbols-outlined md-16">drive_file_move</span>
            <span>${escapeHtml(group.name)}</span>
          </div>` : ''}
          <div class="category-channels" data-category-channels="${escapeHtml(group.id)}" ${collapsed ? 'hidden' : ''}>
            ${channels.map((channel) => rows.get(channel.id) ?? '').join('')}
          </div>
        </section>`;
      }).join('');
      categoryList.querySelectorAll<HTMLButtonElement>('[data-collapse-category]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.collapseCategory ?? '';
          serverStore.toggleCategoryCollapsed(id);
          this.container.querySelectorAll<HTMLButtonElement>('[data-collapse-category]').forEach((next) => {
            if (next.dataset.collapseCategory === id) next.focus();
          });
        });
      });
      categoryList.querySelectorAll<HTMLButtonElement>('[data-add-category]').forEach((button) => {
        button.addEventListener('click', () => createChannelModal.open('TEXT', button.dataset.addCategory || null));
      });
      categoryList.querySelectorAll<HTMLElement>('.channel-category').forEach((section) => {
        section.querySelector('.category-title')?.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (!section.dataset.categoryId) return;
          const mouse = event as MouseEvent;
          this.openCategoryMenu(section.dataset.categoryId, mouse.clientX, mouse.clientY);
        });
      });
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
      const sourceId = participantManager.get(miniEl.getAttribute('data-session-id') ?? '')?.voiceState?.channelId;
      if (sourceId && serverStore.hasPermission(Permission.MOVE_MEMBERS)) {
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
        if (!el.dataset.channelId) return;
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
              const sourceId = currentParticipant?.voiceState?.channelId;
              if (!sourceId || !serverStore.hasPermission(Permission.MOVE_MEMBERS)) return;
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
        if ((e.target as HTMLElement).closest('.channel-menu-btn, .voice-chat-btn')) return;
        const channelId = item.getAttribute('data-channel-id')!;
        const type = item.getAttribute('data-channel-type')!;

        if (type === 'TEXT' || type === 'FORUM') {
          this.activateTextChannel(channelId);
        } else if (type === 'VOICE') {
          if (channelId !== voiceStore.currentVoiceChannelId && this.arePermissionsResolved() && !serverStore.hasPermission(Permission.VIEW_CHANNEL, channelId)) {
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
          const sessionKey = sessionManager.getActiveKey();
          try {
            if (!await this.handleJoinVoiceChannel(channelId)) return;
            if (voiceStore.currentVoiceChannelId !== channelId || voiceStore.voiceSessionKey !== sessionKey
              || sessionManager.getActiveKey() !== sessionKey) return;
            this.viewedVoiceChannelId = channelId;
            this.viewedVoiceSessionKey = sessionKey;
            this.setActiveContentView('stage');
            this.voiceStageView?.setChannel(channelId);
            this.updateScreenShareNotice();
          } finally {
            this.renderChannels();
          }
        }
      });
    });

    this.container.querySelectorAll<HTMLButtonElement>('[data-voice-chat-channel]').forEach((button) => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const channelId = button.dataset.voiceChatChannel;
        if (channelId) this.openVoiceChannelChat(channelId);
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
    this.setupCategoryReorder();
  }

  /**
   * A single channel drag kind supports mixed categories without interfering
   * with voice-member dragging or attachment drops.
   */
  private setupChannelReorder(): void {
    if (!serverStore.hasPermission(Permission.MANAGE_CHANNELS)) return;

    const categoryList = this.container.querySelector<HTMLElement>('#channel-categories-list');
    const lists = Array.from(this.container.querySelectorAll<HTMLElement>('[data-category-channels]'))
      .map((el) => ({ el, categoryId: el.dataset.categoryChannels || null }));
    const mime = 'text/monky-channel';
    const clearDropTargets = () => {
      categoryList?.classList.remove('channel-reorder-active');
      this.container.querySelectorAll('.channel-category-drop-target').forEach((element) => {
        element.classList.remove('channel-category-drop-target');
      });
      this.container.querySelectorAll('.channel-drop-before, .channel-drop-after').forEach((element) => {
        element.classList.remove('channel-drop-before', 'channel-drop-after');
      });
    };
    const pointerDropTarget = (clientX: number, clientY: number) => {
      const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const targetHandle = element?.closest<HTMLElement>('.channel-item[data-channel-id]');
      const targetList = targetHandle?.closest<HTMLElement>('[data-category-channels]');
      if (targetHandle && targetList) {
        let targetRow = targetHandle;
        while (targetRow.parentElement && targetRow.parentElement !== targetList) targetRow = targetRow.parentElement;
        const rect = targetRow.getBoundingClientRect();
        return {
          categoryId: targetList.dataset.categoryChannels || null,
          targetId: targetHandle.dataset.channelId ?? null,
          after: clientY > rect.top + rect.height / 2,
          targetList,
          targetRow,
          dropzone: null as HTMLElement | null,
        };
      }
      const dropzone = element?.closest<HTMLElement>('[data-category-dropzone]');
      if (dropzone) {
        return {
          categoryId: dropzone.dataset.categoryDropzone || null,
          targetId: null,
          after: true,
          targetList: null as HTMLElement | null,
          targetRow: null as HTMLElement | null,
          dropzone,
        };
      }
      const emptyList = element?.closest<HTMLElement>('[data-category-channels]');
      if (!emptyList) return null;
      return {
        categoryId: emptyList.dataset.categoryChannels || null,
        targetId: null,
        after: true,
        targetList: emptyList,
        targetRow: null as HTMLElement | null,
        dropzone: null as HTMLElement | null,
      };
    };
    const showPointerDropTarget = (target: ReturnType<typeof pointerDropTarget>) => {
      clearDropTargets();
      categoryList?.classList.add('channel-reorder-active');
      if (!target) return;
      target.dropzone?.classList.add('channel-category-drop-target');
      target.targetRow?.classList.add(target.after ? 'channel-drop-after' : 'channel-drop-before');
    };

    for (const { el: listEl, categoryId } of lists) {
      if (!listEl) continue;
      // A voice channel and its participants live in a wrapper; a text channel
      // is the item itself. Dragging and dropping act on whichever is the direct
      // child of the list, so the participants travel with their channel.
      const rows = Array.from(listEl.children) as HTMLElement[];

      for (const row of rows) {
        const handle = (row.matches('.channel-item') ? row : row.querySelector('.channel-item')) as HTMLElement | null;
        if (!handle) continue;
        const channelId = handle.getAttribute('data-channel-id');
        if (!channelId || !serverStore.hasPermission(Permission.MANAGE_CHANNELS)) continue;

        handle.draggable = false;
        handle.classList.add('channel-reorder-handle');
        // Dragging is invisible without a hint, and the row has no title of its
        // own to lose.
        if (!handle.title) handle.title = t('main.channelReorderHint');
        handle.addEventListener('dragstart', (e: Event) => {
          const de = e as DragEvent;
          if ((de.target as Element | null)?.closest('button')) {
            de.preventDefault();
            return;
          }
          de.dataTransfer?.setData(mime, channelId);
          de.dataTransfer!.effectAllowed = 'move';
          row.classList.add('channel-dragging');
          categoryList?.classList.add('channel-reorder-active');
        });
        handle.addEventListener('dragend', () => {
          row.classList.remove('channel-dragging');
          listEl.querySelectorAll('.channel-drop-before, .channel-drop-after').forEach((n) => {
            n.classList.remove('channel-drop-before', 'channel-drop-after');
          });
          clearDropTargets();
        });

        let pointer: { startX: number; startY: number; active: boolean } | null = null;
        let suppressClick = false;
        handle.addEventListener('click', event => {
          if (!suppressClick) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          suppressClick = false;
        }, true);
        const movePointer = (event: MouseEvent) => {
          if (!pointer) return;
          if (!pointer.active &&
              Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 6) return;
          if (!pointer.active) {
            pointer.active = true;
            row.classList.add('channel-dragging');
            categoryList?.classList.add('channel-reorder-active');
          }
          event.preventDefault();
          showPointerDropTarget(pointerDropTarget(event.clientX, event.clientY));
        };
        const finishPointer = (event: MouseEvent, commit: boolean) => {
          if (!pointer) return;
          const wasActive = pointer.active;
          const target = wasActive ? pointerDropTarget(event.clientX, event.clientY) : null;
          pointer = null;
          window.removeEventListener('mousemove', movePointer);
          window.removeEventListener('mouseup', stopPointer);
          window.removeEventListener('blur', cancelPointer);
          row.classList.remove('channel-dragging');
          clearDropTargets();
          if (!wasActive) return;
          suppressClick = true;
          window.setTimeout(() => { suppressClick = false; }, 0);
          if (commit && target && target.targetId !== channelId) {
            void this.commitChannelOrder(
              target.categoryId,
              channelId,
              target.targetId,
              target.after
            );
          }
        };
        const stopPointer = (event: MouseEvent) => finishPointer(event, true);
        const cancelPointer = () => {
          if (!pointer) return;
          finishPointer(new MouseEvent('mouseup', {
            clientX: pointer.startX,
            clientY: pointer.startY,
          }), false);
        };
        handle.addEventListener('mousedown', event => {
          if (event.button !== 0 || (event.target as Element | null)?.closest('button')) return;
          pointer = { startX: event.clientX, startY: event.clientY, active: false };
          window.addEventListener('mousemove', movePointer);
          window.addEventListener('mouseup', stopPointer);
          window.addEventListener('blur', cancelPointer);
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
          listEl.classList.remove('channel-category-drop-target');
          if (!draggedId) return;
          de.preventDefault();
          de.stopPropagation();
          if (draggedId === channelId) return;
          void this.commitChannelOrder(categoryId, draggedId, channelId, after);
        });
      }

      // Dropping on the empty space below the list sends the channel to the end.
      listEl.addEventListener('dragover', (e: Event) => {
        const de = e as DragEvent;
        if (!de.dataTransfer?.types.includes(mime)) return;
        de.preventDefault();
        de.dataTransfer.dropEffect = 'move';
      });
      listEl.addEventListener('dragleave', (e: Event) => {
        const next = (e as DragEvent).relatedTarget as Node | null;
        if (next && listEl.contains(next)) return;
        listEl.classList.remove('channel-category-drop-target');
      });
      listEl.addEventListener('drop', (e: Event) => {
        const de = e as DragEvent;
        const draggedId = de.dataTransfer?.getData(mime);
        listEl.classList.remove('channel-category-drop-target');
        if (!draggedId) return;
        de.preventDefault();
        de.stopPropagation();
        void this.commitChannelOrder(categoryId, draggedId, null, true);
      });
    }

    this.container.querySelectorAll<HTMLElement>('[data-category-dropzone]').forEach((dropzone) => {
      const categoryId = dropzone.dataset.categoryDropzone || null;
      dropzone.addEventListener('dragover', (e: Event) => {
        const de = e as DragEvent;
        if (!de.dataTransfer?.types.includes(mime)) return;
        de.preventDefault();
        de.stopPropagation();
        de.dataTransfer.dropEffect = 'move';
        dropzone.classList.add('channel-category-drop-target');
      });
      dropzone.addEventListener('dragleave', (e: Event) => {
        const next = (e as DragEvent).relatedTarget as Node | null;
        if (next && dropzone.contains(next)) return;
        dropzone.classList.remove('channel-category-drop-target');
      });
      dropzone.addEventListener('drop', (e: Event) => {
        const de = e as DragEvent;
        const draggedId = de.dataTransfer?.getData(mime);
        dropzone.classList.remove('channel-category-drop-target');
        if (!draggedId) return;
        de.preventDefault();
        de.stopPropagation();
        void this.commitChannelOrder(categoryId, draggedId, null, true);
      });
    });
  }

  private setupCategoryReorder(): void {
    if (!serverStore.hasPermission(Permission.MANAGE_CHANNELS)) return;
    const categoryList = this.container.querySelector<HTMLElement>('#channel-categories-list');
    if (!categoryList) return;
    const mime = 'text/monky-category';
    const sections = Array.from(categoryList.querySelectorAll<HTMLElement>(
      '.channel-category[data-category-id]:not(.channel-category--uncategorized)'
    ));
    const clearIndicators = () => {
      sections.forEach(section => section.classList.remove('category-drop-before', 'category-drop-after'));
    };
    const clear = () => {
      categoryList.classList.remove('category-reorder-active');
      sections.forEach(section => section.classList.remove('category-dragging'));
      clearIndicators();
    };
    const pointerTarget = (clientX: number, clientY: number) => {
      const title = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)
        ?.closest<HTMLElement>('.category-title[data-category-dropzone]');
      const section = title?.closest<HTMLElement>('.channel-category[data-category-id]');
      const categoryId = section?.dataset.categoryId;
      if (!title || !section || !categoryId) return null;
      const rect = title.getBoundingClientRect();
      return { categoryId, section, after: clientY > rect.top + rect.height / 2 };
    };

    for (const section of sections) {
      const categoryId = section.dataset.categoryId;
      const title = section.querySelector<HTMLElement>(':scope > .category-title');
      if (!categoryId || !title) continue;
      title.draggable = false;
      title.classList.add('category-reorder-handle');
      title.addEventListener('dragstart', event => {
        if ((event.target as Element | null)?.closest('.category-add-btn')) {
          event.preventDefault();
          return;
        }
        event.dataTransfer?.setData(mime, categoryId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        section.classList.add('category-dragging');
        categoryList.classList.add('category-reorder-active');
      });
      title.addEventListener('dragend', clear);
      let pointer: { startX: number; startY: number; active: boolean } | null = null;
      let suppressClick = false;
      title.addEventListener('click', event => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
      }, true);
      const movePointer = (event: MouseEvent) => {
        if (!pointer) return;
        if (!pointer.active &&
            Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 6) return;
        if (!pointer.active) {
          pointer.active = true;
          section.classList.add('category-dragging');
          categoryList.classList.add('category-reorder-active');
        }
        event.preventDefault();
        clearIndicators();
        const target = pointerTarget(event.clientX, event.clientY);
        target?.section.classList.add(target.after ? 'category-drop-after' : 'category-drop-before');
      };
      const finishPointer = (event: MouseEvent, commit: boolean) => {
        if (!pointer) return;
        const wasActive = pointer.active;
        const target = wasActive ? pointerTarget(event.clientX, event.clientY) : null;
        pointer = null;
        window.removeEventListener('mousemove', movePointer);
        window.removeEventListener('mouseup', stopPointer);
        window.removeEventListener('blur', cancelPointer);
        clear();
        if (!wasActive) return;
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
        if (commit && target && target.categoryId !== categoryId) {
          this.commitCategoryOrder(categoryId, target.categoryId, target.after);
        }
      };
      const stopPointer = (event: MouseEvent) => finishPointer(event, true);
      const cancelPointer = () => {
        if (!pointer) return;
        finishPointer(new MouseEvent('mouseup', {
          clientX: pointer.startX,
          clientY: pointer.startY,
        }), false);
      };
      title.addEventListener('mousedown', event => {
        if (event.button !== 0 || (event.target as Element | null)?.closest('.category-add-btn')) return;
        pointer = { startX: event.clientX, startY: event.clientY, active: false };
        window.addEventListener('mousemove', movePointer);
        window.addEventListener('mouseup', stopPointer);
        window.addEventListener('blur', cancelPointer);
      });
      title.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types.includes(mime)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const rect = title.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        section.classList.toggle('category-drop-before', !after);
        section.classList.toggle('category-drop-after', after);
      });
      title.addEventListener('dragleave', event => {
        const next = event.relatedTarget as Node | null;
        if (next && title.contains(next)) return;
        section.classList.remove('category-drop-before', 'category-drop-after');
      });
      title.addEventListener('drop', event => {
        const draggedId = event.dataTransfer?.getData(mime);
        const after = section.classList.contains('category-drop-after');
        section.classList.remove('category-drop-before', 'category-drop-after');
        if (!draggedId) return;
        event.preventDefault();
        event.stopPropagation();
        if (draggedId !== categoryId) this.commitCategoryOrder(draggedId, categoryId, after);
      });
    }
  }

  private commitCategoryOrder(draggedId: string, targetId: string, after: boolean): void {
    const ids = (serverStore.serverDetails?.categories ?? []).map(category => category.id)
      .filter(categoryId => categoryId !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(after ? targetIndex + 1 : targetIndex, 0, draggedId);
    this.requestCategoryChange(MessageType.CATEGORY_REORDER, { orderedIds: ids });
  }

  /**
   * Sends the reordered list to the server (#471).
   *
   * Moving first preserves an override, or adopts the destination's ACL for
   * inherited channels. The server confirms each step before the next is sent.
   */
  private async commitChannelOrder(
    categoryId: string | null,
    draggedId: string,
    targetId: string | null,
    after: boolean
  ): Promise<void> {
    const dragged = serverStore.getChannel(draggedId);
    if (!dragged) return;
    const channels = serverStore.serverDetails?.channels.filter((c) =>
      !c.forumId && (c.categoryId ?? null) === categoryId) ?? [];
    const ids = channels.map((c) => c.id).filter((id) => id !== draggedId);

    let index = ids.length;
    if (targetId) {
      const at = ids.indexOf(targetId);
      if (at === -1) return;
      index = after ? at + 1 : at;
    }
    ids.splice(index, 0, draggedId);

    try {
      if ((dragged.categoryId ?? null) !== categoryId) {
        await networkClient.sendRequest(MessageType.CHANNEL_UPDATE, { channelId: draggedId, categoryId });
      }
      await networkClient.sendRequest(MessageType.CHANNEL_REORDER, { categoryId, orderedIds: ids });
    } catch (err: unknown) {
      void showAlert({
        title: t('common.error'),
        message: err instanceof Error ? err.message : t('main.channelReorderFailed'),
        variant: 'danger',
      });
      this.renderChannels();
    }
  }

  private openCategoryMenu(categoryId: string, x: number, y: number): void {
    if (!serverStore.hasPermission(Permission.MANAGE_CHANNELS)) return;
    const categories = serverStore.serverDetails?.categories ?? [];
    const category = categories.find((item) => item.id === categoryId);
    if (!category) return;
    const position = categories.indexOf(category);
    const move = (delta: number) => {
      const ids = categories.map((item) => item.id);
      ids.splice(position, 1);
      ids.splice(position + delta, 0, categoryId);
      this.requestCategoryChange(MessageType.CATEGORY_REORDER, { orderedIds: ids });
    };
    contextMenu.open(x, y, [
      { label: t('categories.addChannel'), icon: 'add', onClick: () => createChannelModal.open('TEXT', categoryId) },
      { label: t('categories.edit'), icon: 'settings', onClick: () => categoryModal.open(category) },
      { label: t('categories.moveUp'), icon: 'arrow_upward', disabled: position === 0 || !serverStore.hasPermission(Permission.MANAGE_CHANNELS), onClick: () => move(-1) },
      { label: t('categories.moveDown'), icon: 'arrow_downward', disabled: position === categories.length - 1 || !serverStore.hasPermission(Permission.MANAGE_CHANNELS), onClick: () => move(1) },
      {
        label: t('categories.delete'), icon: 'delete', danger: true, onClick: () => {
          void showConfirm({ title: t('categories.delete'), message: t('categories.deleteConfirm'), variant: 'danger' })
            .then((confirmed) => { if (confirmed) this.requestCategoryChange(MessageType.CATEGORY_DELETE, { categoryId }); });
        },
      },
    ]);
  }

  private requestCategoryChange(type: MessageType, payload: object): void {
    void networkClient.sendRequest(type, payload).catch((error: unknown) => {
      void showAlert({ title: t('common.error'), message: error instanceof Error ? error.message : t('categories.error'), variant: 'danger' });
    });
  }

  /** Opens the per-channel options menu at the given screen coordinates (#151). */
  private openChannelMenu(channelId: string, x: number, y: number): void {
    const channel = serverStore.serverDetails?.channels.find((c) => c.id === channelId);
    const items: ContextMenuEntry[] = [];

    // Notification controls apply to every channel that carries messages.
    if (channel?.type === 'TEXT' || channel?.type === 'VOICE') {
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
      if (channel && serverStore.hasPermission(Permission.MANAGE_CHANNELS)) {
        const siblings = serverStore.serverDetails?.channels.filter((item) => (item.categoryId ?? null) === (channel.categoryId ?? null)) ?? [];
        const at = siblings.findIndex((item) => item.id === channelId);
        items.push({
          label: t('categories.moveTo'), icon: 'drive_file_move',
          submenu: [
            { id: null, name: t('categories.uncategorized') },
            ...(serverStore.serverDetails?.categories ?? []),
          ].map((category) => ({
            label: category.name,
            disabled: category.id === (channel.categoryId ?? null),
            onClick: () => { void this.commitChannelOrder(category.id, channelId, null, true); },
          })),
        });
        items.push(
          { label: t('categories.moveUp'), icon: 'arrow_upward', disabled: at <= 0, onClick: () => { void this.commitChannelOrder(channel.categoryId ?? null, channelId, siblings[at - 1]?.id ?? null, false); } },
          { label: t('categories.moveDown'), icon: 'arrow_downward', disabled: at >= siblings.length - 1, onClick: () => { void this.commitChannelOrder(channel.categoryId ?? null, channelId, siblings[at + 1]?.id ?? null, true); } },
        );
      }
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

  private async handleJoinVoiceChannel(channelId: string, silent: boolean = false): Promise<boolean> {
    const session = sessionManager.getActive();
    if (!session) return false;
    if (voiceStore.currentVoiceChannelId === channelId && voiceStore.voiceSessionKey === session.key) {
      return !isVoiceAdmissionPending(session.key, channelId);
    }

    if (this.arePermissionsResolved() && !session.serverStore.hasPermission(Permission.VIEW_CHANNEL, channelId)) {
      if (!silent) this.showVoicePermissionDenied();
      return false;
    }

    try {
      await joinCallOnSession(session.key, channelId);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return false;
      await showAlert({
        title: t('voiceJoin.failedTitle'),
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (voiceStore.voiceSessionKey !== session.key || voiceStore.currentVoiceChannelId !== channelId) return false;
    if (!silent && !voiceStore.getEffectiveDeafened()) soundEffects.play('join_voice');
    return true;
  }

  public async rejoinVoiceChannel(channelId: string): Promise<void> {
    const sessionKey = voiceStore.voiceSessionKey;
    const session = sessionKey ? sessionManager.get(sessionKey) : undefined;
    if (!session) return;
    await rejoinCallOnSession(session.key, channelId);
    if (sessionManager.getActive() !== session || voiceStore.voiceSessionKey !== session.key
      || voiceStore.currentVoiceChannelId !== channelId) return;
    this.viewedVoiceChannelId = channelId;
    this.viewedVoiceSessionKey = session.key;
    this.setActiveContentView('stage');
    this.voiceStageView?.setChannel(channelId);
    this.renderChannels();
    this.updateScreenShareNotice();
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
      leaveCurrentCall();
      this.voiceStageView?.setChannel(null);
      this.setActiveContentView('chat');
    }
    if (channel.type === 'VOICE' && this.viewedVoiceChannelId === channelId) {
      this.viewedVoiceChannelId = null;
      this.viewedVoiceSessionKey = null;
      this.closeVoiceChannelChat(false);
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
      (btnSettings as HTMLElement).style.display = (canManageServer || canManageRoles || canManageBots || serverStore.hasPermission(Permission.MANAGE_EVENTS)) ? '' : 'none';
    }
    const recentSounds = document.getElementById('btn-recent-sounds');
    if (recentSounds) {
      recentSounds.style.display = serverStore.serverDetails?.recentSoundCacheEnabled
        && serverStore.serverDetails.protocol?.features.includes('recent-sounds') ? '' : 'none';
    }
    this.refreshServerMonitorVisibility();
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
        .filter((ch) => canAccessChannel(ch, myPerms, myRoleIds, false, serverStore.currentUser?.id))
        .map((ch) => ch.id)
    );

    if (countEl) {
      countEl.innerText = t('main.membersCount', { count: allMembers.length });
    }

    const renderMemberItem = (m: UserSummary, isOffline: boolean): string => {
      const isLocal = m.id === serverStore.currentUser?.id;
      const isLocalCall = isLocal && isViewingCallServer() && !!voiceStore.currentVoiceChannelId;
      const vm = participantManager.getByUserId(m.id);
      const voiceState = vm?.voiceState;
      // If the member is in a private channel the local user cannot access,
      // mask them as offline so their presence is not leaked (#401).
      const inPrivateHiddenChannel = voiceState && !visibleChannelIds.has(voiceState.channelId);
      const effectiveOffline = isOffline || inPrivateHiddenChannel;
      const inVoice = !!voiceState && !inPrivateHiddenChannel;
      const isReconnecting = !effectiveOffline && participantManager.isUserReconnecting(m.id);
      const avatar = getAvatarUrl(m.avatarUrl);
      const isServerDeafened = !effectiveOffline && (isLocalCall ? voiceStore.serverDeafened : (voiceState?.serverDeafened ?? false));
      const isServerMuted = !effectiveOffline && (isLocalCall ? voiceStore.serverMuted : (voiceState?.serverMuted ?? false));
      const isPermissionMuted = !effectiveOffline && (isLocalCall ? voiceStore.permissionMuted : (voiceState?.permissionMuted ?? false));
      const isSelfDeafened = !effectiveOffline && (isLocalCall ? voiceStore.isDeafened : (voiceState?.isDeafened ?? false));
      const isSelfMuted = !effectiveOffline && (isLocalCall ? voiceStore.isMuted : (voiceState?.isMuted ?? false));

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
              ${renderAudioMuteIndicators({ ...voiceState, isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened, permissionMuted: isPermissionMuted }, { showMicrophone: inVoice || isServerMuted || isPermissionMuted })}
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

  private refreshServerMonitorVisibility(): void {
    const btn = this.container.querySelector<HTMLElement>('#btn-server-monitor');
    if (!btn) return;
    const session = sessionManager.getActive();
    const user = session?.serverStore.currentUser;
    const allowed = session?.client.getStatus() === 'CONNECTED' && user && !user.isBot
      && session.serverStore.hasPermission(Permission.VIEW_SERVER_MONITOR);
    btn.style.display = allowed ? '' : 'none';
  }

  private attachChannelListMenu(): void {
    const list = this.container.querySelector<HTMLElement>('.channels-list-container');
    if (!list) return;
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element) ||
          event.target.closest('.channel-item, .category-title, #server-community')) return;
      event.preventDefault();
      const items: ContextMenuEntry[] = [];
      if (serverStore.hasPermission(Permission.MANAGE_CHANNELS)) {
        items.push(
          { label: t('channelModal.title'), icon: 'add', onClick: () => createChannelModal.open('TEXT', null) },
          { label: t('categories.create'), icon: 'create_new_folder', onClick: () => categoryModal.open() },
        );
      }
      const rect = list.getBoundingClientRect();
      contextMenu.open(event.clientX || rect.left, event.clientY || rect.top, items, list);
    };
    list.addEventListener('contextmenu', open);
    this.unbindEvents.push(() => list.removeEventListener('contextmenu', open));
  }

  private attachEvents(): void {
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
    this.unbindEvents.push(bindPttIndicators(this.container));
    this.unbindEvents.push(bindAudioDevicePopovers(this.container));
    this.unbindEvents.push(bindFooterControlsMotion(this.container));
    this.attachChannelListMenu();

    const btnInvite = document.getElementById('btn-invite-friends');
    const btnServerSettings = document.getElementById('btn-server-settings');
    const btnServerMonitor = document.getElementById('btn-server-monitor');
    const btnRecentSounds = document.getElementById('btn-recent-sounds');
    const btnProfile = document.getElementById('user-profile-btn');
    const btnSettings = document.getElementById('bar-btn-settings');
    const btnMic = document.getElementById('bar-btn-mic');
    const btnDeafen = document.getElementById('bar-btn-deafen');
    const btnDisconnect = document.getElementById('bar-btn-disconnect');

    btnInvite?.addEventListener('click', (e) => { this.closeServerDropdown(); withButtonLoading(e.currentTarget as HTMLElement, () => inviteModal.open()); });
    btnServerSettings?.addEventListener('click', (e) => { this.closeServerDropdown(); withButtonLoading(e.currentTarget as HTMLElement, () => serverSettingsModal.open()); });
    btnServerMonitor?.addEventListener('click', (e) => {
      this.closeServerDropdown();
      const session = sessionManager.getActive();
      withButtonLoading(e.currentTarget as HTMLElement, () => session
        ? serverMonitorModal.openRemote(session)
        : showAlert({ title: t('serverMonitor.title'), message: t('serverMonitor.disconnected'), variant: 'warning' }));
    });
    btnRecentSounds?.addEventListener('click', (event) => {
      this.closeServerDropdown();
      withButtonLoading(event.currentTarget as HTMLElement, () => recentSoundsModal.open());
    });
    this.refreshServerMonitorVisibility();
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
    const positionServerMenu = () => {
      const menu = document.getElementById('server-dropdown-menu');
      if (!menu || menu.hidden || !dropdownToggle) return;
      menu.style.width = `${dropdownToggle.getBoundingClientRect().width}px`;
      positionAnchoredSurface(menu, dropdownToggle);
    };
    const menuSize = new ResizeObserver(positionServerMenu);
    if (dropdownToggle) {
      menuSize.observe(dropdownToggle);
      if (dropdownToggle.parentElement) menuSize.observe(dropdownToggle.parentElement);
      dropdownToggle.setAttribute('aria-expanded', 'false');
      dropdownToggle.setAttribute('aria-controls', 'server-dropdown-menu');
      dropdownToggle.setAttribute('aria-haspopup', 'menu');
    }
    window.addEventListener('resize', positionServerMenu);
    window.addEventListener('scroll', positionServerMenu, true);
    this.unbindEvents.push(() => {
      menuSize.disconnect();
      window.removeEventListener('resize', positionServerMenu);
      window.removeEventListener('scroll', positionServerMenu, true);
    });
    dropdownToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('server-dropdown-menu');
      if (!menu) return;
      if (dropdownToggle.classList.contains('open')) this.closeServerDropdown();
      else {
        showWithMotion(menu, 'popover');
        positionServerMenu();
        dropdownToggle.classList.add('open');
        dropdownToggle.setAttribute('aria-expanded', 'true');
      }
    });
    document.querySelectorAll<HTMLElement>('#server-dropdown-menu button').forEach(button => button.setAttribute('role', 'menuitem'));
    const menuKeyboard = (event: KeyboardEvent) => {
      const menu = document.getElementById('server-dropdown-menu');
      if (!menu || !dropdownToggle) return;
      const menuItems = () => [...menu.querySelectorAll<HTMLElement>('button:not(:disabled)')].filter(item => !item.hidden && item.getClientRects().length);
      if (event.target === dropdownToggle && event.key === 'ArrowDown' && !dropdownToggle.classList.contains('open')) {
        event.preventDefault();
        dropdownToggle.click();
        menuItems()[0]?.focus();
        return;
      }
      if (!dropdownToggle.classList.contains('open')) return;
      if (event.key === 'Tab') {
        this.closeServerDropdown();
        dropdownToggle.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeServerDropdown();
        dropdownToggle.focus();
      } else if (menu.contains(event.target as Node) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = menuItems();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('keydown', menuKeyboard);
    this.unbindEvents.push(() => document.removeEventListener('keydown', menuKeyboard));
    const outsideClickHandler = (e: MouseEvent) => {
      const menu = document.getElementById('server-dropdown-menu');
      const toggle = document.getElementById('server-dropdown-toggle');
      if (!menu || menu.hidden || menu.hasAttribute('data-ui-closing')) return;
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
      const session = sessionManager.getActive();
      if (!session) return;
      const confirmed = await showConfirm({
        title: t('main.disconnect'),
        message: t('main.disconnectServerMessage', { name: session.serverStore.serverDetails?.name ?? session.host }),
        confirmLabel: t('main.disconnect'),
        variant: 'danger',
      });
      if (confirmed && sessionManager.get(session.key) === session) {
        // Captured before the socket closes: afterwards there is no way to tell
        // whether this user was hosting the server they just left (#334).
        const leaveState = await captureHostedServerLeaveState(session.client.getCurrentServerUrl());
        soundEffects.play('leave_voice');
        appEvents.emit('connection.manual_disconnect', { key: session.key });
        // Microphone and peer mesh are shared by every session (#400): tearing
        // them down while the call lives on another server would kill the audio
        // and still leave the user listed in that server's voice channel.
        session.client.disconnect();
        const next = sessionManager.getAll().find(candidate => candidate.client.getStatus() === 'CONNECTED');
        if (next) sessionManager.activate(next.key);
        else showHome();
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
    let lastPermissionMuted = voiceStore.permissionMuted;
    let lastVoiceChannelId = voiceStore.currentVoiceChannelId;
    const updateDeafenControl = () => {
      const btnDeafenEl = document.getElementById('bar-btn-deafen');
      if (btnDeafenEl) {
        const moderation = getVoiceControlModeration();
        btnDeafenEl.className = `btn btn-icon ${voiceStore.isDeafened ? 'danger-active' : ''}`;
        btnDeafenEl.setAttribute('aria-pressed', String(voiceStore.isDeafened));
        btnDeafenEl.title = [t(voiceStore.isDeafened ? 'main.undeafen' : 'main.deafen'), moderation.deafenReason].filter(Boolean).join('. ');
        updateAudioStateIcon(btnDeafenEl, voiceStore.isDeafened ? 'headset_off' : 'headphones', moderation.serverDeafened);
      }
    };
    const u4 = appEvents.on('voice.state_updated', () => {
      const avatarEl = document.getElementById('main-user-avatar');
      if (avatarEl) {
        if (voiceStore.isSpeaking) avatarEl.classList.add('speaking');
        else avatarEl.classList.remove('speaking');
      }
      this.updateParticipantSpeaking();
      updateDeafenControl();

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
        || voiceStore.serverMuted !== lastServerMuted || voiceStore.serverDeafened !== lastServerDeafened
        || voiceStore.permissionMuted !== lastPermissionMuted) {
        lastLocalMuted = voiceStore.isMuted;
        lastLocalDeafened = voiceStore.isDeafened;
        lastServerMuted = voiceStore.serverMuted;
        lastServerDeafened = voiceStore.serverDeafened;
        lastPermissionMuted = voiceStore.permissionMuted;
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

    const u5 = appEvents.on('voice.speaking_changed', () => {
      const avatarEl = document.getElementById('main-user-avatar');
      if (avatarEl) {
        avatarEl.classList.toggle('speaking', voiceStore.isSpeaking);
      }
      this.updateParticipantSpeaking();
    });

    const u6 = appEvents.on('participants.speaking_changed', (data: { sessionId: string; speaking: boolean }) => {
      this.updateParticipantSpeaking(data.sessionId);
    });

    const u7 = appEvents.on(`message.${MessageType.SERVER_SETTINGS_UPDATED}`, (payload: any) => {
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

    const u7d = appEvents.on('session.changed', () => this.refreshServerMonitorVisibility());

    const u8 = appEvents.on(`message.${MessageType.CHANNEL_DELETED}`,
      (payload: ChannelDeletedPayload) => this.handleChannelDeleted(payload));

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

    // PiP "back to tab" returns to the call it was showing, even from another server.
    const u9b = appEvents.on('screen_pip.return_to_call', (call: { sessionKey: string; channelId: string }) => {
      if (voiceStore.voiceSessionKey === call.sessionKey && voiceStore.currentVoiceChannelId === call.channelId) {
        this.openVoiceStage();
      }
    });

    const u10 = appEvents.on('settings.updated', () => {
      const btnRnnoise = document.getElementById('sidebar-btn-rnnoise');
      if (btnRnnoise) {
        const mode = settingsStore.noiseSuppressionMode;
        const enabled = mode !== 'off';
        const title = noiseSuppressionToggleTitle(mode);
        btnRnnoise.className = `btn btn-icon voice-conn-rnnoise ${enabled ? 'rnnoise-active' : ''}`;
        btnRnnoise.setAttribute('title', title);
        btnRnnoise.setAttribute('aria-label', title);
        btnRnnoise.setAttribute('aria-pressed', String(enabled));
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
    const u17 = appEvents.on('server.voice_restrictions_updated', updateDeafenControl);
    const u18 = appEvents.on('voice.bot_screens_updated', () => this.updateScreenShareNotice());
    const u19 = appEvents.on('stage.bot_screens_changed', () => this.updateScreenShareNotice());
    const u20 = appEvents.on('session.voice_context_updated', () => {
      this.updateScreenShareNotice();
      this.updateParticipantSpeaking();
    });
    const u21 = appEvents.on('network.status', () => this.refreshServerMonitorVisibility());
    const u22 = appEvents.on('voice.screen_watch_changed', () => this.updateScreenShareNotice());

    this.unbindEvents.push(u1, u2, u3, u4, u5, u6, u7, u7b, u7c, u7d, u8, u9, u9b, u10, u11, u12, u13, u14, u15, u16, u17, u18, u19, u20, u21, u22);
  }

  /** True when the channel's conversation is currently visible on screen (#14). */
  public isViewingTextChannel(channelId: string): boolean {
    return (
      !sessionManager.isHome() &&
      ((this.activeContentView === 'chat' && serverStore.activeTextChannelId === channelId) ||
        (this.activeContentView === 'stage' && this.voiceChatChannelId === channelId))
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
    const stage = this.container.querySelector<HTMLElement>('#main-center-stage');
    if (stage) cancelSurfaceMotion(stage);
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
  }

  public destroy(): void {
    this.displayedChannelId = this.navigationKey = null;
    this.forumView?.destroy();
    this.communityView?.destroy();
    this.messageSearch?.destroy();
    categoryModal.close();
    this.homeView?.suspend();
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
