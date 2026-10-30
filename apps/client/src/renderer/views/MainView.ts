import { MessageType, Permission, ProtocolErrorCode, type ChannelDeletedPayload, type MessageSearchResultPayload, type ServerSettingsUpdatedPayload } from '@monky/shared';
import { categoryModal } from './CategoryModal';
import { html } from '../utils/html';
import { animateEnter, cancelSurfaceMotion, hideWithMotion, showWithMotion } from '../utils/surfaceMotion';
import { replaceAroundLiveChild } from '../utils/preserveLiveChild';
import { appEvents } from '../core/EventBus';
import { ProtocolRequestError } from '../core/NetworkClient';
import { sessionManager } from '../core/SessionManager';
import { isForegroundEvent } from '../core/sessionRouting';
import { isVoiceAdmissionPending, joinCallOnSession, rejoinCallOnSession } from '../core/serverConnection';
import { participantManager } from '../core/ParticipantManager';
import { accessSignature, serverStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';
import { connectionStore } from '../stores/connectionStore';
import { ChatView } from './ChatView';
import type { HomeView } from './home/HomeView';
import { toggleCamera as toggleCallCamera } from '../core/CameraPublication';
import { VoiceStageView } from './VoiceStageView';
import { BotScreenDock } from './BotScreenDock';
import { showErrorToast, showInfoToast } from './CopyToast';
import { errorMessage, reportError } from '../utils/feedback';
import '../styles/connectionTransition.css';
import { showConfirm } from './Dialog';
import { showVoicePermissionDenied } from '../utils/channelAccess';
import { afkChannelIdOf, voiceUserLimitOf } from '../utils/voiceRooms';
import { bindResizableEdge } from '../utils/resizableEdge';
import { ownAvatarSource } from '../core/profileSync';
import { serverRailView } from './ServerRailView';
import { soundboardPlayersBar } from './SoundboardPlayersBar';
import { gameShareSuggestion } from '../core/GameShareSuggestion';
import { t } from '../i18n';
import { ServerCommunityView } from './ServerCommunityView';
import { MessageSearch } from './MessageSearch';
import { ForumView } from './ForumView';
import { ChannelSidebar } from './main/ChannelSidebar';
import { MemberList } from './main/MemberList';
import { ServerHeader } from './main/ServerHeader';
import { UserControlBar } from './main/UserControlBar';
import { CallNotices } from './main/CallNotices';

/**
 * The screen around the conversation: a server's layout (rail, header,
 * channels, user card, center and members) or Home's. It composes the parts in
 * `views/main/` and owns what is on screen: which server, whether the center
 * shows a conversation, a forum or a room's stage, and the voice chat panel.
 */
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
  private channelsResizeCleanup: (() => void) | null = null;
  private viewedVoiceChannelId: string | null = null;
  private viewedVoiceSessionKey: string | null = null;
  public voiceStageView: VoiceStageView | null = null;
  /**
   * The call's miniapps outlive the stage: browsing elsewhere parks them instead of closing them.
   * Created with the first stage, so constructing the view alone still binds nothing.
   */
  private botScreenDock: BotScreenDock | null = null;
  private unbindEvents: Array<() => void> = [];
  private activeContentView: 'chat' | 'stage' = 'chat';
  private displayedChannelId: string | null = null;
  private navigationKey: string | null = null;
  private readonly header: ServerHeader;
  private readonly channels: ChannelSidebar;
  private readonly members: MemberList;
  private readonly footer: UserControlBar;
  private readonly notices: CallNotices;

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
    // The parts call back through these methods, so a navigation always takes the same path.
    this.header = new ServerHeader(container);
    this.channels = new ChannelSidebar({
      root: container,
      contentView: () => this.activeContentView,
      isViewingVoiceRoom: channelId => this.isViewingVoiceRoom(channelId),
      permissionsResolved: () => this.arePermissionsResolved(),
      openTextChannel: channelId => this.activateTextChannel(channelId),
      enterVoiceChannel: channelId => this.enterVoiceChannel(channelId),
      openVoiceChat: channelId => this.openVoiceChannelChat(channelId),
      watchLive: sessionId => this.watchLive(sessionId),
    });
    this.members = new MemberList({ root: container, watchLive: sessionId => this.watchLive(sessionId) });
    this.footer = new UserControlBar({ root: container, toggleCamera: () => this.toggleCamera() });
    this.notices = new CallNotices({
      root: container,
      contentView: () => this.activeContentView,
      botScreenDock: () => this.botScreenDock,
      openVoiceStage: (...stage) => this.openVoiceStage(...stage),
    });
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
    this.footer.stopPing();

    if (home) {
      // The Home layout replaces the stage's DOM: its open miniapps wait off stage first, instead
      // of dying with the detached markup.
      this.voiceStageView?.destroy();
      this.renderHomeShell();
      return;
    }

    const server = serverStore.serverDetails;
    const user = serverStore.currentUser;
    if (!server || !user) return;
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

    const navigating = this.navigationKey !== activeSessionKey;
    if (navigating && this.activeContentView === 'stage') this.voiceStageView?.openAutomaticPictureInPicture();
    this.navigationKey = activeSessionKey;

    const markup = String(html`
      <div class="main-layout">
        <!-- Server Rail: saved servers + home (#29) -->
        <div class="server-rail" id="server-rail"></div>

        <!-- Left Sidebar: Channels & User Controls -->
        <div class="channels-sidebar">
          <div class="channels-resizer" id="channels-resizer" title="${t('main.resizeHandle')}" aria-label="${t('main.resizeHandle')}"></div>
          ${this.header.markup(server)}

          <div class="channels-list-container" tabindex="0">
            <div id="server-community" hidden></div>
            <div id="channel-categories-list"></div>
          </div>

          ${this.footer.markup({ nickname: user.nickname, avatarUrl: user.avatarUrl, server: server.name })}
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
    `);
    const preserved = preserve && replaceAroundLiveChild(this.container, markup, '.main-layout', '#main-center-stage');
    if (!preserved) {
      this.voiceStageView?.destroy();
      this.container.innerHTML = markup;
    }

    this.renderChannels();
    this.renderMembers();
    serverRailView.render();
    this.setupChannelsResizer();
    this.footer.observeHeight();

    const centerStageEl = this.container.querySelector<HTMLElement>('#main-center-stage');
    if (!centerStageEl) throw new Error('The server layout has no center area');
    // Re-rendering happens on every server switch now (#400), so the previous
    // views must be torn down or their event listeners and ping timers would
    // pile up on each switch.
    if (preserved) this.voiceStageView?.render();
    else {
      this.chatView?.destroy();
      this.chatView = new ChatView(centerStageEl);
      this.chatInForum = false;
      this.chatView.onOpenForum = id => this.activateTextChannel(id);
      this.botScreenDock ??= new BotScreenDock();
      this.voiceStageView = new VoiceStageView(centerStageEl, this.botScreenDock);
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
    if (this.activeContentView === 'stage' &&
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
    this.mountServerTools();
    this.finishLayout(navigating);
  }

  private renderHomeShell(): void {
    if (!this.homeView) throw new Error('The Home view was not provided to the main layout');
    const navigating = this.navigationKey !== 'home';
    this.navigationKey = 'home';
    this.activeContentView = 'chat';
    appEvents.emit('stage.visibility_changed', false);

    this.container.innerHTML = String(html`
      <div class="main-layout main-layout--home">
        <div class="server-rail" id="server-rail"></div>
        <aside class="home-sidebar-shell" aria-label="${t('home.sidebarLabel')}">
          <div id="home-sidebar-root" class="home-sidebar-root"></div>
          ${this.footer.markup({ nickname: connectionStore.savedNickname.trim() || t('home.defaultNickname'), avatarUrl: ownAvatarSource() })}
        </aside>
        <main class="main-center-column home-center-column">
          <div id="server-tools" class="server-tools" hidden></div>
          <div id="main-center-stage" class="main-content-area home-main-content"></div>
        </main>
      </div>
    `);
    serverRailView.render();
    const sidebarRoot = this.container.querySelector<HTMLElement>('#home-sidebar-root');
    const centerStageEl = this.container.querySelector<HTMLElement>('#main-center-stage');
    if (sidebarRoot && centerStageEl) this.homeView.render(sidebarRoot, centerStageEl);
    this.footer.observeHeight();
    this.attachEvents();
    this.finishLayout(navigating);
  }

  /** The server's community shortcuts and the message search, bound to the session on screen. */
  private mountServerTools(): void {
    const session = sessionManager.getActive();
    const communityRoot = this.container.querySelector<HTMLElement>('#server-community');
    const tools = this.container.querySelector<HTMLElement>('#server-tools');
    const center = this.container.querySelector<HTMLElement>('.main-center-column');
    if (!session || !communityRoot || !tools || !center) return;
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
      access: channelIds => accessSignature(session.serverStore, channelIds),
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
      events: session.client,
    });
  }

  /** What both layouts end with: the call row, the notices above the card and the entry animation. */
  private finishLayout(navigating: boolean): void {
    this.footer.updateVoiceConnectionRow();
    this.notices.renderAll();
    gameShareSuggestion.render(false);
    const soundboardSlot = this.container.querySelector<HTMLElement>('#soundboard-players-slot');
    if (soundboardSlot) soundboardPlayersBar.mount(soundboardSlot);
    if (navigating) this.animateServerEntry();
  }

  /** The channel tree, reconciled by row (R-SHELL-11). */
  private renderChannels(): void {
    this.channels.render();
  }

  private renderMembers(): void {
    this.members.render();
  }

  private updateScreenShareNotice(): void {
    this.notices.updateScreenShare();
  }

  /** The menu of the empty sidebar, bound with the rest of the layout. */
  private attachChannelListMenu(): void {
    this.unbindEvents.push(this.channels.bindBackgroundMenu());
  }

  private setupChannelsResizer(): void {
    this.channelsResizeCleanup?.();
    this.channelsResizeCleanup = null;
    const handle = this.container.querySelector<HTMLElement>('#channels-resizer');
    const sidebar = this.container.querySelector<HTMLElement>('.channels-sidebar');
    if (!handle || !sidebar) return;
    this.channelsResizeCleanup = bindResizableEdge({
      panel: sidebar, handle, edge: 'right', min: 280, storageKey: 'monky_channels_width',
      clamp: width => this.clampSidebarWidth(width),
    });
  }

  /** The stage on screen shows this room of the server on screen. */
  private isViewingVoiceRoom(channelId: string): boolean {
    return this.activeContentView === 'stage'
      && this.viewedVoiceSessionKey === sessionManager.getActiveKey()
      && this.viewedVoiceChannelId === channelId;
  }

  /** A voice room clicked in the list: joined, and its stage shown once admitted on the server still on screen. */
  private async enterVoiceChannel(channelId: string): Promise<void> {
    const sessionKey = sessionManager.getActiveKey();
    if (!await this.handleJoinVoiceChannel(channelId)) return;
    if (voiceStore.currentVoiceChannelId !== channelId || voiceStore.voiceSessionKey !== sessionKey
      || sessionManager.getActiveKey() !== sessionKey) return;
    this.viewedVoiceChannelId = channelId;
    this.viewedVoiceSessionKey = sessionKey;
    this.setActiveContentView('stage');
    this.voiceStageView?.setChannel(channelId);
    this.updateScreenShareNotice();
  }

  private attachEvents(): void {
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
    this.unbindEvents.push(this.footer.bind());
    this.attachChannelListMenu();
    this.unbindEvents.push(this.header.bind(), this.channels.bind(), this.notices.bind());

    let lastLocalMuted = voiceStore.isMuted;
    let lastLocalDeafened = voiceStore.isDeafened;
    let lastServerMuted = voiceStore.serverMuted;
    let lastServerDeafened = voiceStore.serverDeafened;
    let lastPermissionMuted = voiceStore.permissionMuted;
    let lastVoiceChannelId = voiceStore.currentVoiceChannelId;
    this.unbindEvents.push(
      appEvents.on('server.updated', () => {
        this.renderChannels();
        this.renderMembers();
        // Re-evaluate what depends on the current user's permissions (#246).
        this.header.refresh();
      }),
      appEvents.on('participants.updated', () => {
        this.renderChannels();
        this.renderMembers();
        this.updateScreenShareNotice();
      }),
      appEvents.on('user.updated', (user) => {
        this.footer.showUser(user);
        this.renderMembers();
      }),
      appEvents.on('server.members_updated', () => this.renderMembers()),
      appEvents.on('voice.state_updated', () => {
        this.footer.showSpeaking();
        this.channels.updateSpeaking();
        this.footer.syncMediaControls();
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
        // Show/hide the voice-connection row when joining/leaving a call (#60).
        // Hanging up goes through voiceStore.reset(), which only emits
        // 'voice.state_updated', so the screen-share notice has to be cleared
        // here too — otherwise it lingers until the server echo (#282).
        if (voiceStore.currentVoiceChannelId !== lastVoiceChannelId) {
          lastVoiceChannelId = voiceStore.currentVoiceChannelId;
          this.footer.updateVoiceConnectionRow();
          this.updateScreenShareNotice();
        }
      }),
      appEvents.on('voice.speaking_changed', () => {
        this.footer.showSpeaking();
        this.channels.updateSpeaking();
      }),
      // Joining/leaving a voice channel emits `voice.channel_changed` (not
      // `voice.state_updated`), so update the voice-connection row and the
      // channel list highlight here — otherwise the row only appeared by luck
      // when a later state update happened to fire (#60).
      appEvents.on('voice.channel_changed', () => {
        lastVoiceChannelId = voiceStore.currentVoiceChannelId;
        this.footer.updateVoiceConnectionRow();
        this.renderChannels();
        this.updateScreenShareNotice();
        // Keeps the "call is here" marker on the rail in sync (#400).
        serverRailView.render();
        // Hanging up from the sidebar row, the tray or the taskbar goes around the
        // stage: a room on screen must drop its call controls by itself.
        if (!voiceStore.currentVoiceChannelId && this.stageShown() && this.viewedVoiceChannelId) {
          this.voiceStageView?.setChannel(this.viewedVoiceChannelId);
        }
      }),
      appEvents.on('session.voice_context_updated', () => {
        this.updateScreenShareNotice();
        this.channels.updateSpeaking();
      }),
      // Re-render the channel list when an @-mention or an unread dot appears
      // or clears, so its marker on the channel follows at once (#14, #263).
      appEvents.on('chat.mentions_updated', () => this.renderChannels()),
      appEvents.on('chat.unread_updated', () => this.renderChannels()),
      appEvents.on(`message.${MessageType.CHANNEL_DELETED}`,
        (payload: ChannelDeletedPayload) => this.handleChannelDeleted(payload)),
      appEvents.on(`message.${MessageType.SERVER_SETTINGS_UPDATED}`, (payload: ServerSettingsUpdatedPayload) => {
        // The store above is the one of whichever server sent this. The header
        // shows only the server actually being looked at (#400); the saved entry
        // of any server is updated by the app (savedServerSync).
        if (!isForegroundEvent()) return;
        this.header.showServer(payload.name, payload.iconUrl);
        serverRailView.render();
      }),
      appEvents.on('connection.saved_servers_changed', () => serverRailView.render()),
      // Badges for servers kept alive in the background: the call marker and the
      // unread dot both live on the rail (#400).
      appEvents.on('session.background_activity', () => serverRailView.render()),
      // PiP "back to tab" returns to the call it was showing, even from another server.
      appEvents.on('screen_pip.return_to_call', (call: { sessionKey: string; channelId: string }) => {
        if (voiceStore.voiceSessionKey === call.sessionKey && voiceStore.currentVoiceChannelId === call.channelId) {
          this.openVoiceStage();
        }
      }),
    );
  }

  private unbindListeners(): void {
    const stage = this.container.querySelector<HTMLElement>('#main-center-stage');
    if (stage) cancelSurfaceMotion(stage);
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
    // Both edges belong to the layout being replaced: their window listeners go with it.
    this.channelsResizeCleanup?.();
    this.channelsResizeCleanup = null;
    this.voiceChatResizeCleanup?.();
    this.voiceChatResizeCleanup = null;
    this.channels.unbindList();
    this.members.unbindList();
  }

  public destroy(): void {
    this.displayedChannelId = this.navigationKey = null;
    this.forumView?.destroy();
    this.communityView?.destroy();
    this.messageSearch?.destroy();
    categoryModal.close();
    this.homeView?.suspend();
    this.channels.destroy();
    this.unbindListeners();
    soundboardPlayersBar.unmount();
    this.footer.destroy();
    this.chatView?.destroy();
    this.voiceStageView?.destroy();
    this.botScreenDock?.dispose();
    this.botScreenDock = null;
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

  /** Whether the center shows the voice stage right now; Home never does. */
  private stageShown(): boolean {
    return !sessionManager.isHome() && this.activeContentView === 'stage';
  }

  /**
   * The media bar and the camera shortcut. The camera belongs to the call; only
   * a stage on screen redraws its own tile, never one destroyed by a navigation.
   */
  public async toggleCamera(): Promise<void> {
    await toggleCallCamera();
    if (!this.stageShown()) return;
    this.voiceStageView?.updateControlsUI();
    this.voiceStageView?.renderParticipants();
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

  /**
   * Someone else's share icon or LIVE badge asks first, then opens the stage focused on their
   * broadcast and watching it. Someone sharing in another voice channel is reached by joining it.
   */
  private async watchLive(sessionId: string): Promise<void> {
    const sharing = () => {
      const participant = participantManager.get(sessionId);
      return participant?.voiceState?.isScreenSharing ? participant : undefined;
    };
    const participant = sharing();
    const channelId = participant?.voiceState?.channelId;
    const session = sessionManager.getActive();
    if (!participant || !channelId || !session) return;
    const inCall = voiceStore.voiceSessionKey === session.key && voiceStore.currentVoiceChannelId === channelId;
    const name = participantManager.displayName(participant);
    const channel = session.serverStore.serverDetails?.channels.find((value) => value.id === channelId)?.name ?? '';
    const confirmed = await showConfirm({
      title: t('main.watchLiveTitle'),
      message: inCall ? t('main.watchLiveMessage', { name }) : t('main.watchLiveJoinMessage', { name, channel }),
      confirmLabel: inCall ? t('stage.watchBroadcast') : t('main.watchLiveJoinConfirm'),
      variant: 'info',
    });
    // The broadcast may have ended, or the user moved elsewhere, while the question was open.
    if (!confirmed || sessionManager.getActive() !== session || sharing()?.voiceState?.channelId !== channelId) return;
    if (!inCall && !await this.handleJoinVoiceChannel(channelId)) return;
    if (voiceStore.voiceSessionKey !== session.key || voiceStore.currentVoiceChannelId !== channelId || !sharing()) return;
    this.openVoiceStage(sessionId);
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

  /**
   * An automatic reconnection to the server already on screen brings no new
   * navigation: rebuilding the layout would recreate the chat, losing the
   * draft and the reading position, and look like the app reloaded. Only the
   * parts fed by the new handshake are refreshed; anything less ordinary than
   * a text channel falls back to a full render.
   */
  public refreshAfterReconnect(): void {
    const channelId = serverStore.activeTextChannelId;
    const plainChat = !sessionManager.isHome() && this.activeContentView === 'chat' && !this.chatInForum
      && !this.forumView && !this.communityView && !!channelId && serverStore.getChannel(channelId)?.type === 'TEXT'
      && this.chatView?.channelId === channelId && !!this.container.querySelector('.main-layout #chat-messages-feed');
    if (!plainChat) {
      this.render();
      return;
    }
    this.renderChannels();
    this.renderMembers();
    serverRailView.render();
    this.footer.updateVoiceConnectionRow();
    this.chatView?.resyncAfterReconnect();
  }

  /**
   * A server connected, dropped or closed somewhere else. Connections only
   * show on the rail and on the call row, so nothing else is rebuilt.
   */
  public refreshConnections(): void {
    serverRailView.render();
    this.footer.updateVoiceConnectionRow();
  }

  private activateTextChannel(channelId: string): void {
    this.channels.clearTextChannelDragHover();
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
    panel.innerHTML = String(html`
      <div class="voice-chat-resizer" aria-label="${t('main.resizeHandle')}" title="${t('main.resizeHandle')}"></div>
      <button type="button" class="voice-chat-close" aria-label="${t('voiceChat.close')}" title="${t('voiceChat.close')}">
        <span class="material-symbols-outlined md-20" aria-hidden="true">close</span>
      </button>
      <div class="voice-chat-content"></div>
    `);
    this.voiceChatChannelId = channelId;
    layout.classList.add('main-layout--voice-chat-open');
    const content = panel.querySelector<HTMLElement>('.voice-chat-content')!;
    this.voiceChatView = new ChatView(content);
    this.voiceChatView.setChannel(channelId);
    panel.querySelector<HTMLButtonElement>('.voice-chat-close')?.addEventListener('click', () => {
      this.closeVoiceChannelChat(true);
      this.renderChannels();
    });
    this.voiceChatResizeCleanup?.();
    const resizer = panel.querySelector<HTMLElement>('.voice-chat-resizer');
    this.voiceChatResizeCleanup = resizer ? bindResizableEdge({
      panel, handle: resizer, edge: 'left', min: 480, storageKey: 'monky_voice_chat_width',
      clamp: width => this.clampVoiceChatWidth(width),
    }) : null;
    if (animate) showWithMotion(panel, 'panel');
    else panel.hidden = false;
    this.voiceStageView?.setChatOpen(true);
  }

  private closeVoiceChannelChat(animate: boolean): void {
    this.voiceChatResizeCleanup?.();
    this.voiceChatResizeCleanup = null;
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
    // The side chat may belong to another room than the stage on screen: a
    // voice room that disappears takes its chat with it, wherever it is shown.
    if (this.voiceChatChannelId && !serverStore.getChannel(this.voiceChatChannelId)) {
      this.closeVoiceChannelChat(false);
    }
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

  private arePermissionsResolved(): boolean {
    return serverStore.myPermissions > 0 || serverStore.ownerId !== null;
  }

  private async handleJoinVoiceChannel(channelId: string, silent: boolean = false): Promise<boolean> {
    const session = sessionManager.getActive();
    if (!session) return false;
    if (voiceStore.currentVoiceChannelId === channelId && voiceStore.voiceSessionKey === session.key) {
      return !isVoiceAdmissionPending(session.key, channelId);
    }
    if (channelId === afkChannelIdOf(session.serverStore.serverDetails)) {
      if (!silent) showInfoToast(t('afk.joinBlocked'), 5000);
      return false;
    }

    if (this.arePermissionsResolved() && !session.serverStore.hasPermission(Permission.VIEW_CHANNEL, channelId)) {
      if (!silent) showVoicePermissionDenied();
      return false;
    }

    // The server turns a full room away too, but only after the current call
    // was already left behind; refusing here keeps the member where they are.
    const channel = session.serverStore.getChannel(channelId);
    const userLimit = channel ? voiceUserLimitOf(session.serverStore.serverDetails, channel) : null;
    if (userLimit !== null && this.arePermissionsResolved() && !session.serverStore.hasPermission(Permission.MOVE_MEMBERS)
      && session.participants.getInVoiceChannel(channelId)
        .filter((participant) => !session.serverStore.isMySession(participant.user.sessionId)).length >= userLimit) {
      if (!silent) showErrorToast(t('protocolError.channelFull'));
      return false;
    }

    try {
      await joinCallOnSession(session.key, channelId);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return false;
      // A room that filled up while the request was on its way: same notice as the check above.
      if (error instanceof ProtocolRequestError && error.code === ProtocolErrorCode.CHANNEL_FULL) {
        if (!silent) showErrorToast(error.message);
        return false;
      }
      reportError(errorMessage(error, t('voiceJoin.failedTitle')), { log: 'CONNECTION', error });
      return false;
    }
    if (voiceStore.voiceSessionKey !== session.key || voiceStore.currentVoiceChannelId !== channelId) return false;
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

  /** Whether the call has an open miniapp, on stage or parked while its person browses elsewhere. */
  public isWatchingAnyBotScreen(): boolean {
    return this.botScreenDock?.isWatchingAny() ?? false;
  }

  /** True when the channel's conversation is currently visible on screen (#14). */
  public isViewingTextChannel(channelId: string): boolean {
    return (
      !sessionManager.isHome() &&
      ((this.activeContentView === 'chat' && serverStore.activeTextChannelId === channelId) ||
        (this.activeContentView === 'stage' && this.voiceChatChannelId === channelId))
    );
  }
}
