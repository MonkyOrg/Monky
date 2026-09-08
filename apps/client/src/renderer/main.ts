import {
  AdminDeafenUserPayload,
  AdminKickVoicePayload,
  AdminMoveUserPayload,
  AdminMuteUserPayload,
  AuthSuccessPayload,
  ChannelCreatedPayload,
  ChannelDeletedPayload,
  ChannelUpdatedPayload,
  ChannelsReorderedPayload,
  ChatHistoryPayload,
  ChatMessageUpdatedPayload,
  ChatMessage,
  chatReactionEventSchema,
  MessageType,
  MemberKickedPayload,
  Permission,
  ProtocolErrorCode,
  RolesListPayload,
  ServerErrorPayload,
  UserJoinedPayload,
  UserLeftPayload,
  UserConnectionStatePayload,
  UserUpdatedPayload,
  VoiceStateChangedPayload,
  VoiceUserJoinedPayload,
  VoiceUserLeftPayload,
  hasEveryoneMention,
} from '@monky/shared';
import { audioProcessor } from './core/AudioProcessor';
import { appEvents } from './core/EventBus';
import { networkClient, type ConnectionStatus } from './core/NetworkClient';
import { callClient, rejoinCallOnSession } from './core/serverConnection';
import { participantManager } from './core/ParticipantManager';
import { sessionManager } from './core/SessionManager';
import { currentEventOrigin, emitOutsideRouting, isForegroundEvent } from './core/sessionRouting';
import { soundEffects } from './core/SoundEffects';
import { soundboardService } from './core/SoundboardService';
import { keybindService } from './core/KeybindService';
import { updateService } from './core/UpdateService';
import { videoService } from './core/VideoService';
import { webRtcManager } from './core/WebRtcManager';
import { chatStore } from './stores/chatStore';
import { connectionStore } from './stores/connectionStore';
import { serverStore } from './stores/serverStore';
import { settingsStore } from './stores/settingsStore';
import { voiceStore } from './stores/voiceStore';
import { ConnectionView } from './views/ConnectionView';
import { MainView } from './views/MainView';
import { screenAudioService } from './core/ScreenAudioService';
import { screenSharePickerModal } from './views/ScreenSharePickerModal';
import { showAlert } from './views/Dialog';
import { showIdentityImportDialog } from './views/IdentityDialogs';
import { initI18n, t } from './i18n';
import { translateProtocolError } from './i18n/protocolErrors';
import { toAbsoluteServerIconUrl } from './utils/avatar';
import { installImageFallback } from './utils/imageFallback';
import { clientLog } from './core/ClientLogService';
import { overlayBridgeService } from './core/OverlayBridgeService';
import { OverlayStageView } from './views/OverlayStageView';
import { bindBotChatEvents } from './core/botChatEvents';

class App {
  private appContainer: HTMLElement;
  private connectionView!: ConnectionView;
  private mainView!: MainView;
  private rendererReadySignalled = false;

  constructor() {
    this.appContainer = document.getElementById('app')!;
    installImageFallback();

    const isOverlay = window.location.search.includes('overlay=1');
    if (isOverlay) {
      initI18n();
      new OverlayStageView(this.appContainer).init();
      return;
    }

    // Routes incoming server events to the right state bundle. It must be in
    // place before any connection exists, otherwise the first events would be
    // applied to whatever store happens to be active (#400).
    sessionManager.install();
    this.connectionView = new ConnectionView(this.appContainer);
    this.mainView = new MainView(this.appContainer);

    // Must run before any await in init(): otherwise the Windows-style window
    // controls stay visible on macOS during onboarding/identity loading (#307)
    this.setupTitleBar();
    // Registered before any await: quitting during onboarding must still take
    // the user out of whatever server is connected (#458).
    this.setupGracefulQuit();

    this.init();
  }

  private async init(): Promise<void> {
    // Initialise client logging (#444)
    await clientLog.init();
    clientLog.info('APP', 'Renderer process initialising');

    initI18n();

    // Check if identity exists BEFORE rendering anything
    if (window.api?.hasIdentity) {
      connectionStore.hasIdentity = await window.api.hasIdentity();
    }

    if (!connectionStore.hasIdentity) {
      // Show onboarding screen and wait for identity to be created/imported
      await this.showIdentityOnboarding();
    }

    // At this point, identity is guaranteed to exist
    if (window.api?.getIdentity) {
      const identity = await window.api.getIdentity();
      connectionStore.setIdentity(identity);
    }

    this.setupGlobalEventListeners();
    this.setupTraySync();

    // Initialize and sync quality preset to WebRtcManager and VideoService (#474)
    webRtcManager.setQualityPreset(settingsStore.qualityPreset);

    // Initialize overlay bridge service (#169)
    overlayBridgeService.init();

    // Render connection view initially
    this.connectionView?.render();

    // The main UI has now been written to the DOM — let the main process lift
    // the post-update splash once it actually paints (#498).
    this.signalRendererReady();

    // Load soundboard sounds if configured
    soundboardService.loadSounds().catch(() => {});

    // Sync minimize-to-tray preference to main process (#256)
    if (window.api?.setMinimizeToTray) {
      window.api.setMinimizeToTray(settingsStore.minimizeToTrayOnClose).catch(() => {});
    }

    // Initialize keybind service (#252)
    keybindService.init();

    // Start checking for app updates (non-blocking)
    updateService.init();

    // Debug helper to check voice engine status in console
    (window as any).debugVoice = () => {
      const status = webRtcManager.getVoiceStatus();
      console.log('%c🎙️ [Monky Voice Status]', 'color: #5865f2; font-weight: bold; font-size: 14px;');
      console.table(status);
      return status;
    };
  }

  /**
   * Tells the main process the real UI has painted, so the post-update
   * "Abrindo o Monky…" splash lifts exactly as Monky becomes visible instead of
   * at the blank first paint that `ready-to-show` marks (#498). Guarded to fire
   * once; the double `requestAnimationFrame` waits for a frame to actually paint
   * after the DOM was written (a hidden window still paints because
   * `backgroundThrottling` is off).
   */
  private signalRendererReady(): void {
    if (this.rendererReadySignalled) return;
    this.rendererReadySignalled = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.api?.signalRendererReady?.();
      });
    });
  }

  private showIdentityOnboarding(): Promise<void> {
    return new Promise((resolve) => {
      const logoUrl = new URL('./assets/Logo.png', import.meta.url).href;
      this.appContainer.innerHTML = `
        <div class="identity-onboarding">
          <img src="${logoUrl}" alt="Monky" style="width: 120px; height: 120px; object-fit: contain; margin-bottom: 16px; filter: drop-shadow(0 4px 16px rgba(88, 101, 242, 0.4));">
          <h1 style="font-size: 28px; font-weight: 700; margin: 0 0 8px; color: var(--text-primary);">Monky</h1>
          <p style="font-size: 14px; color: var(--text-secondary); margin: 0 0 32px; text-align: center; max-width: 360px; line-height: 1.5;">
            ${t('identity.onboardingDesc')}
          </p>
          <div style="display: flex; flex-direction: column; gap: 12px; width: 280px;">
            <button type="button" id="btn-onboard-create" class="btn btn-primary" style="padding: 14px 24px; font-size: 15px; font-weight: 600;">
              <span class="material-symbols-outlined md-20" style="margin-right: 8px;">add_circle</span>
              ${t('identity.onboardingCreate')}
            </button>
            <button type="button" id="btn-onboard-import" class="btn btn-secondary" style="padding: 14px 24px; font-size: 15px;">
              <span class="material-symbols-outlined md-20" style="margin-right: 8px;">qr_code_scanner</span>
              ${t('identity.onboardingImport')}
            </button>
          </div>
        </div>
      `;

      // Onboarding is the first real paint for a user without an identity; let
      // the main process lift the post-update splash here too (#498).
      this.signalRendererReady();

      document.getElementById('btn-onboard-create')?.addEventListener('click', async () => {
        // Generate identity
        if (window.api?.getIdentity) {
          const identity = await window.api.getIdentity();
          connectionStore.setIdentity(identity);
          connectionStore.hasIdentity = true;
        }
        resolve();
      });

      document.getElementById('btn-onboard-import')?.addEventListener('click', async () => {
        const result = await showIdentityImportDialog();
        if (result) {
          connectionStore.setIdentity(result);
          connectionStore.hasIdentity = true;
          resolve();
        }
      });
    });
  }

  private setupTraySync(): void {
    const syncTrayVoiceStatus = () => {
      window.api?.updateTrayVoiceStatus({
        inCall: !!voiceStore.currentVoiceChannelId,
        isMuted: voiceStore.getEffectiveMuted(),
        isDeafened: voiceStore.getEffectiveDeafened(),
        isSpeaking: voiceStore.isSpeaking,
      });
    };

    appEvents.on('voice.state_updated', syncTrayVoiceStatus);
    appEvents.on('voice.speaking_changed', syncTrayVoiceStatus);
    appEvents.on('voice.channel_changed', syncTrayVoiceStatus);

    // Initial sync
    syncTrayVoiceStatus();

    // Tray context menu actions
    window.api?.onTrayToggleMute(() => {
      this.toggleMuteFromTray();
    });

    window.api?.onTrayToggleDeafen(() => {
      this.toggleDeafenFromTray();
    });
  }

  /**
   * Leaves every server before the process dies (#458).
   *
   * Closing the app used to just drop the WebSockets. The server cannot tell
   * that apart from a network blip, so it held the person in the voice channel
   * for the whole reconnection grace period: everyone else kept seeing a
   * participant who could no longer speak, and no leave sound played. Sending
   * the logout explicitly makes the departure immediate and deliberate.
   *
   * The main process waits for the ack (with a short timeout) before quitting.
   */
  private setupGracefulQuit(): void {
    window.api?.onAppBeforeQuit(() => {
      try {
        sessionManager.removeAll();
      } catch (err) {
        clientLog.error('CONNECTION', 'Failed to leave servers before quitting', {
          error: (err as Error)?.message,
        });
      } finally {
        void window.api?.notifyLeaveComplete();
      }
    });
  }

  private toggleMuteFromTray(): void {
    if (!voiceStore.currentVoiceChannelId) return;
    const newMuted = !voiceStore.isMuted;
    voiceStore.setMuted(newMuted);
    audioProcessor.setMuted(voiceStore.getEffectiveMuted());
    soundEffects.play(newMuted ? 'mic_mute' : 'mic_unmute');

    // Unmuting the mic while deafened also undeafens the audio output (#62)
    let undeafened = false;
    if (!newMuted && voiceStore.isDeafened) {
      voiceStore.setDeafened(false);
      audioProcessor.setDeafened(voiceStore.getEffectiveDeafened());
      webRtcManager.setDeafened(voiceStore.getEffectiveDeafened());
      undeafened = true;
    }

    callClient().send(MessageType.VOICE_STATE_UPDATE, {
      isMuted: newMuted,
      ...(undeafened ? { isDeafened: false } : {}),
    });
  }

  private toggleDeafenFromTray(): void {
    if (!voiceStore.currentVoiceChannelId) return;
    const newDeafened = !voiceStore.isDeafened;
    voiceStore.setDeafened(newDeafened);
    audioProcessor.setDeafened(voiceStore.getEffectiveDeafened());
    // Restore the mic track to its (possibly restored) pre-deafen state (#74)
    audioProcessor.setMuted(voiceStore.getEffectiveMuted());
    webRtcManager.setDeafened(voiceStore.getEffectiveDeafened());
    soundEffects.play(newDeafened ? 'deafen' : 'undeafen');
    callClient().send(MessageType.VOICE_STATE_UPDATE, {
      isDeafened: newDeafened,
      isMuted: voiceStore.isMuted,
    });
  }

  private setupTitleBar(): void {
    const titlebar = document.getElementById('titlebar');
    if (window.api?.platform === 'darwin') {
      titlebar?.classList.add('titlebar--mac');
    }

    document.getElementById('win-min')?.addEventListener('click', () => window.api?.minimize());
    document.getElementById('win-max')?.addEventListener('click', () => window.api?.toggleMaximize());
    document.getElementById('win-close')?.addEventListener('click', () => window.api?.close());
  }

  private syncLocalVoiceMediaState(): void {
    audioProcessor.setMuted(voiceStore.getEffectiveMuted());
    audioProcessor.setDeafened(voiceStore.getEffectiveDeafened());
    webRtcManager.setDeafened(voiceStore.getEffectiveDeafened());
  }

  /**
   * Whether the event being handled came from the server hosting the call.
   *
   * Voice, microphone and peer connections are global — there is only one of
   * each machine-wide — so handlers that touch them must ignore events from the
   * other connected servers (#400).
   */
  private eventOwnsCall(): boolean {
    const voiceKey = voiceStore.voiceSessionKey;
    if (!voiceKey) return true;
    const origin = currentEventOrigin();
    return !origin || origin === voiceKey;
  }

  private setupGlobalEventListeners(): void {    // Global Keybind Actions (#252)
    appEvents.on('keybind.toggle_mute', () => {
      this.toggleMuteFromTray();
    });

    appEvents.on('keybind.toggle_deafen', () => {
      this.toggleDeafenFromTray();
    });

    appEvents.on('keybind.toggle_camera', () => {
      if (voiceStore.currentVoiceChannelId) {
        void this.mainView.voiceStageView?.toggleCamera();
      }
    });

    appEvents.on('keybind.toggle_screen_share', () => {
      if (voiceStore.currentVoiceChannelId) {
        appEvents.emit('modal.open_screenshare_picker');
      }
    });

    // Silencing the soundboard and cutting every sound short are the two things
    // people reach for mid-call, so both got a shortcut (#517). The event is
    // re-emitted because `save()` only persists — active playbacks re-read their
    // volume from `settings.updated`.
    appEvents.on('keybind.toggle_soundboard_mute', () => {
      settingsStore.soundboardMuted = !settingsStore.soundboardMuted;
      settingsStore.save();
      appEvents.emit('settings.updated');
    });

    appEvents.on('keybind.stop_soundboard', () => {
      soundboardService.stopAllFromUi();
    });

    // Language switch (#16): re-render whichever screen is on, so every label
    // built into the templates comes back in the new language.
    appEvents.on('i18n.language_changed', () => {
      if (serverStore.serverDetails) {
        this.mainView.render();
      } else {
        this.connectionView.render();
      }
    });

    // Network Connect / Disconnect
    appEvents.on('network.connected', (payload: AuthSuccessPayload) => {
      const origin = currentEventOrigin();
      // Voice is a single physical resource shared by every session (#400), so
      // only the connection actually hosting the call may touch it. Without
      // this, connecting to a second server would tear down an ongoing call.
      const ownsCall = !voiceStore.voiceSessionKey || voiceStore.voiceSessionKey === origin;
      // Preserve the voice channel we were in so we can auto-rejoin after an
      // automatic reconnection (null on a fresh connect, so this no-ops then).
      const previousVoiceChannelId = ownsCall ? voiceStore.currentVoiceChannelId : null;

      chatStore.setCommandUsageScope({ serverId: payload.server.id, callerId: payload.currentUser.id });
      serverStore.setServerDetails(payload.server, payload.currentUser);
      // The in-server layout needs more room than the connection card (#342).
      if (isForegroundEvent()) void window.api?.setWindowInServer?.(true);
      // Seed unread @-mention badges, including mentions received while this
      // user was offline (#14).
      chatStore.setMentions(payload.server.mentionedChannelIds ?? []);
      participantManager.clear();
      participantManager.setUsers(payload.server.members);

      // Populate existing voice states
      const knownVoiceUsers = new Map(payload.server.knownMembers?.map((user) => [user.id, user]));
      for (const [_, state] of Object.entries(payload.server.voiceStates)) {
        // Invisible users are absent from the online member list, but their
        // physical voice session still exists and can still carry media.
        if (!participantManager.get(state.sessionId)) {
          const user = knownVoiceUsers.get(state.userId);
          if (user) participantManager.addUser({ ...user, sessionId: state.sessionId });
        }
        participantManager.updateVoiceState(state);
      }

      if (ownsCall) {
        const myVoiceState = payload.currentUser.sessionId
          ? payload.server.voiceStates[payload.currentUser.sessionId]
          : undefined;
        voiceStore.setServerMuted(myVoiceState?.serverMuted ?? false);
        voiceStore.setServerDeafened(myVoiceState?.serverDeafened ?? false);
        this.syncLocalVoiceMediaState();

        webRtcManager.setCurrentSessionId(payload.currentUser.sessionId || payload.currentUser.id);
        // Adopt the relay this server offers before any peer connection is
        // opened, so calls started right after login can already use it (#425).
        webRtcManager.setIceServers(payload.iceServers);
        // Drop any stale peer connections left over from a dropped session.
        webRtcManager.closeAllPeers();
      }

      if (isForegroundEvent()) {
        this.mainView.render();
      }

      // Persist the server icon on the saved server entry so the rail shows it
      // even when not connected (#301).
      if (payload.server.iconUrl) {
        const url = networkClient.getCurrentServerUrl();
        if (url) {
          const match = url.match(/\/\/([^:]+):(\d+)/);
          if (match) {
            const port = parseInt(match[2], 10);
            connectionStore.updateSavedServerIcon(
              match[1],
              port,
              toAbsoluteServerIconUrl(match[1], port, payload.server.iconUrl)
            );
          }
        }
      }

      const stillHasVoiceChannel =
        !!previousVoiceChannelId &&
        payload.server.channels.some(
          (c) => c.id === previousVoiceChannelId && c.type === 'VOICE'
        );
      if (stillHasVoiceChannel) {
        // A background server that reconnected has to rejoin through its own
        // session: the view-driven path would migrate the call here (#400).
        if (isForegroundEvent()) {
          this.mainView.rejoinVoiceChannel(previousVoiceChannelId!);
        } else if (origin) {
          void rejoinCallOnSession(origin, previousVoiceChannelId!);
        }
      }
    });

    appEvents.on('network.status', (status: ConnectionStatus) => {
      if (status !== 'CONNECTED') {
        chatStore.finishAllInvocations('caller_disconnected');
        chatStore.setCommands([]);
      }
    });

    appEvents.on('network.disconnected', () => {
      const origin = currentEventOrigin();
      const ownsCall = !voiceStore.voiceSessionKey || voiceStore.voiceSessionKey === origin;

      // The stores resolve to the session that dropped, so this clears the
      // right bundle even when a background server is the one going away.
      serverStore.clear();
      chatStore.clear();
      participantManager.clear();

      if (ownsCall) {
        voiceStore.reset();
        audioProcessor.stopMicrophone();
        videoService.stopCamera();
        videoService.stopScreenShare();
        webRtcManager.clearLocalScreenTracks();
        webRtcManager.closeAllPeers();
      }

      // This event only fires once a socket is gone for good — a client that
      // still intends to retry emits `network.reconnecting` instead. Leaving the
      // dead session in the map would show it as connected on the rail and let a
      // click "switch" to a server that is no longer there (#400).
      if (origin) sessionManager.remove(origin);

      // A background server dropping must not disturb what is on screen (#400).
      if (!isForegroundEvent()) return;

      // Another server may still be connected — typically the one hosting the
      // call. Showing it beats dumping the user on the connection screen while
      // they are still talking to someone.
      const next = sessionManager
        .getBackground()
        .find((session) => session.client.getStatus() === 'CONNECTED');
      if (next) {
        sessionManager.activate(next.key);
        this.mainView.render();
        return;
      }

      // Nothing left to show: the view has to be torn down, or its listeners
      // and ping timer would outlive the server view behind the home screen.
      this.mainView.destroy();
      void window.api?.setWindowInServer?.(false);
      this.connectionView.render();
    });

    // Protocol Server -> Client Broadcast Handlers
    appEvents.on(`message.${MessageType.USER_JOINED}`, (payload: UserJoinedPayload) => {
      serverStore.addMember(payload.user);
      participantManager.addUser(payload.user);
    });

    appEvents.on(`message.${MessageType.ROLES_LIST}`, (payload: RolesListPayload) => {
      serverStore.updateRoles(payload.roles, payload.userRoles);
      if (!serverStore.hasPermission(Permission.SEND_MESSAGES)) chatStore.finishAllInvocations('cancelled');
    });

    appEvents.on(`message.${MessageType.USER_LEFT}`, (payload: UserLeftPayload) => {
      if (payload.sessionId) {
        participantManager.removeUser(payload.sessionId);
        // Peers belong to the call, which may live on another server (#400).
        if (this.eventOwnsCall()) webRtcManager.removePeer(payload.sessionId);
      }
      // Only drop the member row once the person has no device left online (#309).
      if (participantManager.getSessionsOfUser(payload.userId).length === 0) {
        if (serverStore.knownMembers.get(payload.userId)?.isBot) chatStore.finishBotInvocations(payload.userId);
        serverStore.removeMember(payload.userId);
      }
    });

    appEvents.on(`message.${MessageType.MEMBER_KICKED}`, (payload: MemberKickedPayload) => {
      if (payload.userId === serverStore.currentUser?.id) {
        // We were removed from the server: return home with a notice. Being
        // kicked from a server we are not looking at only closes that session.
        if (isForegroundEvent()) {
          appEvents.emit('network.server_shutdown', { reason: t('app.kickedFromServerMessage') });
        }
        networkClient.disconnect();
        return;
      }
      serverStore.removeMemberCompletely(payload.userId);
      // A kick takes every device of that person down at once (#309).
      for (const session of participantManager.getSessionsOfUser(payload.userId)) {
        const key = session.user.sessionId || session.user.id;
        participantManager.removeUser(key);
        if (this.eventOwnsCall()) webRtcManager.removePeer(key);
      }
    });

    appEvents.on(`message.${MessageType.USER_CONNECTION_STATE}`, (payload: UserConnectionStatePayload) => {
      // Reflect other users' temporary connection loss / recovery (#44).
      if (payload.sessionId) {
        participantManager.setReconnecting(payload.sessionId, payload.status === 'reconnecting');
      }
    });

    appEvents.on(`message.${MessageType.USER_UPDATED}`, (payload: UserUpdatedPayload) => {
      serverStore.updateMember(payload.user);
      participantManager.updateUser(payload.user);
      if (payload.user.id === serverStore.currentUser?.id) {
        serverStore.updateCurrentUser(payload.user);
        const invisible = payload.user.invisible;
        if (typeof invisible === 'boolean') {
          emitOutsideRouting(() => {
            if (settingsStore.appearOffline !== invisible) {
              settingsStore.appearOffline = invisible;
              settingsStore.save();
            }
          });
        }
      }
    });

    appEvents.on(`message.${MessageType.CHANNEL_CREATED}`, (payload: ChannelCreatedPayload) => {
      serverStore.addChannel(payload.channel);
    });

    appEvents.on(`message.${MessageType.CHANNEL_DELETED}`, (payload: ChannelDeletedPayload) => {
      chatStore.finishChannelInvocations(payload.channelId);
      serverStore.removeChannel(payload.channelId);
    });

    appEvents.on(`message.${MessageType.CHANNEL_UPDATED}`, (payload: ChannelUpdatedPayload) => {
      serverStore.updateChannel(payload.channel);
    });

    appEvents.on(`message.${MessageType.CHANNELS_REORDERED}`, (payload: ChannelsReorderedPayload) => {
      serverStore.applyChannelPositions(payload.positions);
    });

    appEvents.on(`message.${MessageType.CHAT_MESSAGE}`, (message: ChatMessage) => {
      chatStore.addMessage(message);
      // Incoming chat cue (#152), honoring the mute / mentions-only settings
      // (#153). Own and system messages are ignored. A mention is "@<nickname>"
      // appearing in the message body (#14).
      if (!message.isSystem) {
        const me = serverStore.currentUser;
        if (me && message.userId !== me.id) {
          const nick = (me.nickname || '').trim().toLowerCase();
          // `@todos` counts as a mention for everyone in the channel when the
          // server allows it (#464).
          const everyoneAllowed = serverStore.serverDetails?.allowEveryoneMention !== false;
          const isMention =
            (!!nick && message.content.toLowerCase().includes(`@${nick}`)) ||
            (everyoneAllowed && hasEveryoneMention(message.content));

          // Resolve the chat-sound mode with the 3-level precedence
          // channel → server → global (#153).
          const soundMode = settingsStore.getEffectiveChatSoundMode(
            serverStore.serverDetails?.id,
            message.channelId
          );
          const shouldPlay = soundMode === 'all' || (soundMode === 'mentions' && isMention);
          // A message from a server the user is not looking at gets a badge on
          // the rail instead of a sound, which would have no visible cause (#400).
          const isForeground = isForegroundEvent();
          if (shouldPlay && isForeground) soundEffects.play('chat_message');
          const isViewingChannel = isForeground && this.mainView.isViewingTextChannel(message.channelId);

          // Unread dot in the sidebar, following the same notification settings
          // as the sound: 'none' never marks, 'mentions' only marks mentions
          // (which render as the @-badge instead) and 'all' marks everything
          // (#263).
          if (shouldPlay && !isViewingChannel) {
            chatStore.markUnread(message.channelId);
          }

          // Mark the text channel in the sidebar until the user opens it (#14).
          if (isMention) {
            if (isViewingChannel) {
              // Seen live: clear the server-side unread row so it isn't
              // re-delivered as unread on the next reconnect (#14).
              networkClient.send(MessageType.CHAT_MENTIONS_READ, { channelId: message.channelId });
            } else {
              chatStore.markMention(message.channelId);
            }
          }
        }
      }
    });

    appEvents.on(`message.${MessageType.CHAT_HISTORY}`, (payload: ChatHistoryPayload) => {
      chatStore.setHistory(payload.channelId, payload.messages, payload.aroundMessageId);
    });

    for (const type of [MessageType.CHAT_REACTION_ADDED, MessageType.CHAT_REACTION_REMOVED]) {
      appEvents.on(`message.${type}`, (payload: unknown) => {
        const parsed = chatReactionEventSchema.safeParse(payload);
        if (parsed.success) chatStore.updateReaction(parsed.data, type === MessageType.CHAT_REACTION_ADDED);
      });
    }

    // An existing message was edited or deleted (#504). No sound and no unread
    // marker: nothing new was said, so nothing should call attention to it.
    appEvents.on(`message.${MessageType.CHAT_MESSAGE_UPDATED}`, (payload: ChatMessageUpdatedPayload) => {
      if (payload?.message) chatStore.updateMessage(payload.message);
    });

    appEvents.on(`message.${MessageType.VOICE_USER_JOINED}`, (payload: VoiceUserJoinedPayload) => {
      if (payload.user) participantManager.addUser(payload.user);
      if (payload.participants) {
        participantManager.reconcileVoiceChannel(payload.channelId, payload.participants);
        if (this.eventOwnsCall() && voiceStore.currentVoiceChannelId === payload.channelId && !webRtcManager.isSfuMode()) {
          for (const { voiceState } of payload.participants) {
            if (!serverStore.isMySession(voiceState.sessionId)) {
              void webRtcManager.connectToPeer(voiceState.sessionId, true);
            }
          }
        }
      }
      // Read before the state is overwritten: an admin move announces the
      // arrival once itself and once more when the moved client re-joins, so
      // the room would hear the join sound twice (#500). A repeated
      // announcement for a session already listed in this channel is that
      // second copy — the mesh still reconnects, only the cue is skipped.
      const alreadyInChannel =
        participantManager.get(payload.sessionId)?.voiceState?.channelId === payload.channelId;

      participantManager.updateVoiceState(payload.voiceState);

      // If we are also in this voice channel and not the joining session, connect P2P Mesh
      if (
        this.eventOwnsCall() &&
        voiceStore.currentVoiceChannelId === payload.channelId &&
        !serverStore.isMySession(payload.sessionId)
      ) {
        webRtcManager.connectToPeer(payload.sessionId, false);
        // Let everyone already in the channel hear that someone joined (#54), unless deafened (#251).
        if (!alreadyInChannel && !voiceStore.getEffectiveDeafened()) {
          soundEffects.play('join_voice');
        }
      }
    });

    appEvents.on(`message.${MessageType.VOICE_USER_LEFT}`, (payload: VoiceUserLeftPayload) => {
      const isMySession = serverStore.isMySession(payload.sessionId);
      if (this.eventOwnsCall()) {
        if (isMySession) {
          audioProcessor.stopMicrophone();
          videoService.stopCamera();
          videoService.stopScreenShare();
          webRtcManager.clearLocalScreenTracks();
          webRtcManager.closeAllPeers();
          voiceStore.reset();
          if (!voiceStore.getEffectiveDeafened()) {
            soundEffects.play('leave_voice');
          }
          if (isForegroundEvent()) this.mainView.render();
        } else {
          if (voiceStore.currentVoiceChannelId === payload.channelId && !voiceStore.getEffectiveDeafened()) {
            soundEffects.play('leave_voice');
          }
          webRtcManager.removePeer(payload.sessionId);
        }
      }
      participantManager.removeVoiceState(payload.sessionId);
    });

    appEvents.on(`message.${MessageType.VOICE_STATE_CHANGED}`, (payload: VoiceStateChangedPayload) => {
      const previousVoiceState = participantManager.get(payload.voiceState.sessionId)?.voiceState;
      const isRemoteUser = !serverStore.isMySession(payload.voiceState.sessionId);
      const isSameVoiceChannel =
        this.eventOwnsCall() && voiceStore.currentVoiceChannelId === payload.voiceState.channelId;

      if (isRemoteUser && isSameVoiceChannel && !voiceStore.isDeafened) {
        if (
          previousVoiceState?.isScreenSharing === false &&
          payload.voiceState.isScreenSharing === true
        ) {
          soundEffects.play('screen_share_start');
        } else if (
          previousVoiceState?.isScreenSharing === true &&
          payload.voiceState.isScreenSharing === false
        ) {
          soundEffects.play('screen_share_stop');
        }
      }

      participantManager.updateVoiceState(payload.voiceState);
      if (serverStore.isMySession(payload.voiceState.sessionId) && this.eventOwnsCall()) {
        voiceStore.setServerMuted(payload.voiceState.serverMuted);
        voiceStore.setServerDeafened(payload.voiceState.serverDeafened);
        this.syncLocalVoiceMediaState();
      }
    });

    appEvents.on(`message.${MessageType.ADMIN_MUTE_USER}`, (payload: AdminMuteUserPayload) => {
      const current = participantManager.get(payload.targetSessionId)?.voiceState;
      if (current) {
        participantManager.updateVoiceState({ ...current, serverMuted: payload.muted, isSpeaking: false });
      }
      if (serverStore.isMySession(payload.targetSessionId) && this.eventOwnsCall()) {
        voiceStore.setServerMuted(payload.muted);
        this.syncLocalVoiceMediaState();
      }
    });

    appEvents.on(`message.${MessageType.ADMIN_DEAFEN_USER}`, (payload: AdminDeafenUserPayload) => {
      const current = participantManager.get(payload.targetSessionId)?.voiceState;
      if (current) {
        participantManager.updateVoiceState({ ...current, serverDeafened: payload.deafened });
      }
      if (serverStore.isMySession(payload.targetSessionId) && this.eventOwnsCall()) {
        voiceStore.setServerDeafened(payload.deafened);
        this.syncLocalVoiceMediaState();
      }
    });

    appEvents.on(`message.${MessageType.ADMIN_KICK_VOICE}`, (payload: AdminKickVoicePayload) => {
      if (!serverStore.isMySession(payload.targetSessionId) || !this.eventOwnsCall()) return;
      audioProcessor.stopMicrophone();
      videoService.stopCamera();
      videoService.stopScreenShare();
      webRtcManager.clearLocalScreenTracks();
      webRtcManager.closeAllPeers();
      // Being kicked is still leaving the call, so it gets the same cue as
      // leaving on your own (#533) — read before reset(), which clears the
      // server-side deafen that decides whether anything should be heard.
      const shouldPlayLeaveCue = !voiceStore.getEffectiveDeafened();
      voiceStore.reset();
      if (shouldPlayLeaveCue) {
        soundEffects.play('leave_voice');
      }
      if (isForegroundEvent()) this.mainView.render();
    });

    appEvents.on(`message.${MessageType.ADMIN_MOVE_USER}`, (payload: AdminMoveUserPayload) => {
      // Being moved only makes sense on the server hosting the call; obeying it
      // elsewhere would silently drag the call to another server (#400).
      if (!serverStore.isMySession(payload.targetSessionId) || !this.eventOwnsCall()) return;
      if (isForegroundEvent()) {
        void this.mainView.rejoinVoiceChannel(payload.channelId);
      } else {
        const origin = currentEventOrigin();
        if (origin) void rejoinCallOnSession(origin, payload.channelId);
      }
    });

    // ── Bot infrastructure (#569) ────────────────────────────────────────
    bindBotChatEvents();

    // Local VAD speaking state
    appEvents.on('local.speaking', (speaking: boolean) => {
      voiceStore.setSpeaking(speaking);
      if (serverStore.currentUser) {
        participantManager.setSpeaking(
          serverStore.currentUser.sessionId || serverStore.currentUser.id,
          speaking
        );
      }
    });

    // Modals
    appEvents.on('modal.open_screenshare_picker', () => {
      screenSharePickerModal.open();
    });

    // Screen-share start/stop sound cue (covers all paths: picker, quick-stop,
    // switching to camera, and the OS "stop sharing" button).
    appEvents.on('local.screen_started', () => {
      soundEffects.play('screen_share_start');
    });
    appEvents.on('local.screen_stopped', () => {
      soundEffects.play('screen_share_stop');
      // Auto-stop screen audio only when the last share is gone (#253).
      if (videoService.getScreenShareCount() === 0 && screenAudioService.getIsCapturing()) {
        screenAudioService.stop();
      }
    });

    // The shared window/app was closed (or the OS "stop sharing" button was
    // used): finish tearing down that one screen share so peers stop seeing a
    // frozen frame and the local controls return to the idle state (#159, #253).
    appEvents.on('local.screen_ended_externally', async (shareId: string) => {
      if (!voiceStore.screenShareIds.includes(shareId)) return;
      await webRtcManager.removeLocalScreenTrack(shareId);
      voiceStore.removeScreenShare(shareId);
      callClient().send(MessageType.VOICE_STATE_UPDATE, {
        screenShareIds: voiceStore.screenShareIds,
        isScreenSharing: voiceStore.isScreenSharing,
      });
    });

    // Host closed the server: show a friendly notice (the network layer already
    // returned us to the home screen).
    appEvents.on('network.server_shutdown', (data: { reason?: string }) => {
      showAlert({
        title: t('app.serverShutdownTitle'),
        message: data?.reason || t('app.serverShutdownMessage'),
        variant: 'warning',
      });
    });

    // The SFU link dropped and is being rebuilt. Instead of a blocking modal,
    // this surfaces in the sidebar voice indicator (yellow) plus a recurring
    // audio cue, and clears itself once media flows again (#553).
    appEvents.on('sfu.reconnecting', () => {
      voiceStore.setReconnecting(true);
    });
    appEvents.on('sfu.reconnected', () => {
      voiceStore.setReconnecting(false);
    });

    // Drives the recurring reconnection cue for the whole attempt, stopping as
    // soon as the call recovers or the user leaves the channel (#553).
    appEvents.on('voice.reconnecting_changed', (reconnecting: boolean) => {
      if (reconnecting) soundEffects.startReconnectingLoop();
      else soundEffects.stopReconnectingLoop();
    });

    // The SFU refusing to start after an admin switched the server to it
    // arrives as an error with no requestId, which `NetworkClient` cannot
    // correlate to anything and therefore only re-emits — so without a
    // listener the admin would never hear about it.
    //
    // The server's own message is preferred over the code's canned text: it
    // carries what actually failed (the worker error and the port preflight),
    // while the canned string only describes the port conflict. Uncorrelated
    // errors are otherwise left alone, since fire-and-forget requests fail
    // this way too and have always been silent here.
    appEvents.on(`message.${MessageType.SERVER_ERROR}`, (payload: ServerErrorPayload) => {
      if (payload?.code !== ProtocolErrorCode.SFU_UNAVAILABLE) return;
      showAlert({
        title: t('sfu.unavailableTitle'),
        message: payload.message || translateProtocolError(payload.code, payload.message),
        variant: 'warning',
      });
    });
  }
}

// Bootstrap when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  new App();
});

// Global error handlers for uncaught exceptions (#444)
window.addEventListener('error', (event) => {
  clientLog.error('APP', `Uncaught error: ${event.message}`, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  clientLog.error('APP', `Unhandled promise rejection: ${reason}`);
});
