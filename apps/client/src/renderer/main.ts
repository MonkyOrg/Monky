// First import: marks when the bundle starts running.
import { markStartup, startupTimings } from './core/startupTiming';
import { MessageType, Permission, type AppIdentityStatus, type AuthSuccessPayload } from '@monky/shared';
import { audioProcessor } from './core/AudioProcessor';
import { appEvents } from './core/EventBus';
import { leaveCurrentCall, rejoinCallOnSession, showHome } from './core/serverConnection';
import { VoiceModeReconnect, type VoiceReconnectCall } from './core/VoiceModeReconnect';
import { participantManager } from './core/ParticipantManager';
import { sessionManager } from './core/SessionManager';
import { gamePresence } from './core/GamePresenceController';
import { gameShareRequests } from './core/GameShareRequests';
import { gameShareSuggestion } from './core/GameShareSuggestion';
import { afkMonitor } from './core/AfkMonitor';
import { currentEventOrigin, isForegroundEvent } from './core/sessionRouting';
import { soundEffects } from './core/SoundEffects';
import { soundboardService } from './core/SoundboardService';
import { keybindService } from './core/KeybindService';
import { updateService } from './core/UpdateService';
import { videoService } from './core/VideoService';
import { webRtcManager } from './core/WebRtcManager';
import { chatStore } from './stores/chatStore';
import { connectionStore } from './stores/connectionStore';
import { dmStore } from './stores/dmStore';
import { initProfileSync } from './core/profileSync';
import { bindDmNotifications } from './core/dmNotifications';
import { serverStore } from './stores/serverStore';
import { settingsStore } from './stores/settingsStore';
import { voiceStore } from './stores/voiceStore';
import { joinInviteModal } from './views/JoinInviteModal';
import { addServerModal } from './views/addServer/AddServerModal';
import { MainView } from './views/MainView';
import { HomeView } from './views/home/HomeView';
import { hasValidLocalProfile, showIdentityProfileStep } from './views/IdentityProfileStep';
import { stopLocalScreenShares } from './core/screenShareControls';
import { screenSharePickerModal } from './views/ScreenSharePickerModal';
import { showAlert } from './views/Dialog';
import { reportError } from './utils/feedback';
import { showIdentityOnboarding } from './views/IdentityOnboarding';
import { initI18n, t } from './i18n';
import { installImageFallback } from './utils/imageFallback';
import { clientLog } from './core/ClientLogService';
import { startResponsivenessMonitor } from './core/ResponsivenessMonitor';
import { overlayBridgeService } from './core/OverlayBridgeService';
import { bindBotChatEvents } from './core/botChatEvents';
import { bindBotScreenEvents } from './core/botScreenEvents';
import { bindBotVoiceCommandEvents } from './core/botVoiceCommandEvents';
import { selectEnhancer } from './core/SelectEnhancer';
import { dateTimeControls } from './core/DateTimeControls';
import { initTooltips } from './core/TooltipService';
import { bindCameraPublication } from './core/CameraPublication';
import { AutoEntryService } from './core/AutoEntryService';
import { runFatalBootstrap } from './utils/fatalBootstrap';
import { prepareDevelopmentQaProfile, startDevelopmentQa } from './core/DevelopmentQa';
import { bindServerStateEvents, hydrateServerSession } from './core/serverStateEvents';
import { bindChatEvents } from './core/chatEvents';
import { adoptCallAfterSignIn, bindVoiceEvents, callBeforeSignIn, resumeCallAfterSignIn } from './core/voiceEvents';
import { syncSavedServer } from './core/savedServerSync';
import { bindUserNotices } from './core/userNotices';
import { bindTraySync } from './core/traySync';
import { bindKeybindActions } from './core/keybindActions';

class App {
  private appContainer: HTMLElement;
  private homeView!: HomeView;
  private mainView!: MainView;
  private rendererReadySignalled = false;
  private inviteWork: Promise<boolean> | null = null;
  private unbindInvites: (() => void) | null = null;
  private unbindDm: (() => void) | null = null;
  private unbindProfileSync: (() => void) | null = null;
  private disposed = false;
  private readonly autoEntryService = new AutoEntryService(message => clientLog.info('CONNECTION', message));
  private readonly voiceModeReconnect = new VoiceModeReconnect({
    currentCall: () => {
      const sessionKey = voiceStore.voiceSessionKey;
      const channelId = voiceStore.currentVoiceChannelId;
      const sessionId = sessionKey ? sessionManager.get(sessionKey)?.serverStore.currentUser?.sessionId : undefined;
      return sessionKey && channelId && sessionId ? { sessionKey, channelId, sessionId } : null;
    },
    canReconnect: (call) => {
      const session = sessionManager.get(call.sessionKey);
      return session?.client.getStatus() === 'CONNECTED'
        && session.serverStore.getChannel(call.channelId)?.type === 'VOICE'
        && session.serverStore.hasPermission(Permission.VIEW_CHANNEL, call.channelId);
    },
    notify: () => {
      void showAlert({ title: t('voiceReconnect.title'), message: t('voiceReconnect.notice'), variant: 'info' });
    },
    teardown: async () => {
      webRtcManager.suspendForVoiceReconnect();
      audioProcessor.stopMicrophone();
      videoService.stopCamera();
      const stoppedScreens = stopLocalScreenShares({ teardown: true });
      voiceStore.setCameraOn(false);
      voiceStore.setSpeaking(false);
      voiceStore.setReconnecting(true);
      await stoppedScreens;
    },
    rejoin: (call, transitionId, isCurrent) =>
      rejoinCallOnSession(call.sessionKey, call.channelId, { transitionId, isCurrent }),
    cancelled: (call) => this.finishVoiceModeReconnect(call),
    failed: (call, error) => {
      this.finishVoiceModeReconnect(call);
      clientLog.error('CONNECTION', 'Automatic voice mode reconnection failed', { error: error.message });
      void showAlert({
        title: t('voiceReconnect.failedTitle'),
        message: t('voiceReconnect.failed', { error: error.message }),
        variant: 'danger',
      });
    },
    timeoutMessage: () => t('voiceReconnect.timeout'),
  });

  private finishVoiceModeReconnect(call: VoiceReconnectCall): void {
    if (voiceStore.voiceSessionKey !== call.sessionKey || voiceStore.currentVoiceChannelId !== call.channelId) return;
    const session = sessionManager.get(call.sessionKey);
    if (session?.serverStore.currentUser?.sessionId !== call.sessionId) return;
    // Socket recovery now owns readmission, including a mode change that was
    // interrupted by network loss. It must keep the user's call intention.
    if (session.client.getStatus() === 'RECONNECTING') return;
    leaveCurrentCall();
  }

  constructor() {
    this.appContainer = document.getElementById('app')!;
    installImageFallback();
    const disposeTooltips = initTooltips();
    selectEnhancer.init();
    dateTimeControls.init();
    window.addEventListener('pagehide', () => {
      this.disposed = true;
      this.unbindInvites?.();
      this.unbindDm?.();
      this.unbindProfileSync?.();
      dmStore.dispose();
      joinInviteModal.close();
      selectEnhancer.dispose();
      dateTimeControls.dispose();
      disposeTooltips();
    }, { once: true });

    // The overlay window loads overlay.html, not this app: microphone, push-to-talk,
    // cues and soundboard start here, in the main window only (R-MEDIA-3).
    audioProcessor.init();
    soundEffects.init();
    soundboardService.init();

    // Routes incoming server events to the right state bundle. It must be in
    // place before any connection exists, otherwise the first events would be
    // applied to whatever store happens to be active (#400).
    sessionManager.install();
    const stopResponsivenessMonitor = startResponsivenessMonitor();
    // Only starts polling if the person turned game sharing on (#675).
    gamePresence.start();
    gameShareRequests.start();
    gameShareSuggestion.start();
    afkMonitor.start();
    this.homeView = new HomeView();
    this.mainView = new MainView(this.appContainer, this.homeView);
    appEvents.on('dm.open', (peer) => {
      this.homeView.openConversation(peer);
      if (!sessionManager.isHome()) showHome();
    });
    window.addEventListener('pagehide', () => {
      stopResponsivenessMonitor();
      this.autoEntryService.dispose();
      gamePresence.dispose();
      gameShareRequests.dispose();
      gameShareSuggestion.dispose();
      afkMonitor.dispose();
      this.homeView.destroy();
      void sessionManager.dispose().catch((error: unknown) => {
        clientLog.error('CONNECTION', 'Failed to dispose sessions after page retirement', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, { once: true });

    // Must run before any await in init(): otherwise the Windows-style window
    // controls stay visible on macOS during onboarding/identity loading (#307)
    this.setupTitleBar();
    // Registered before any await: quitting during onboarding must still take
    // the user out of whatever server is connected (#458).
    this.setupGracefulQuit();

    void runFatalBootstrap(() => this.init(), 'initialization');
  }

  private async init(): Promise<void> {
    initI18n();

    // Startup reads that do not depend on each other run together (R-SHELL-14).
    // Prepared QA creates its identity first, so the status is read again after it.
    const readIdentityStatus = (): Promise<AppIdentityStatus> => window.api?.getIdentityStatus
      ? window.api.getIdentityStatus()
      : Promise.resolve({ state: 'missing' });
    // Initialise client logging (#444)
    let [, developmentQa, identityStatus] = await Promise.all([
      clientLog.init(),
      window.api?.getDevelopmentQaConfig?.() ?? Promise.resolve(null),
      readIdentityStatus(),
    ]);
    clientLog.info('APP', 'Renderer process initialising');
    if (developmentQa) {
      await prepareDevelopmentQaProfile(developmentQa);
      identityStatus = await readIdentityStatus();
    }

    // Check the identity BEFORE rendering anything. An identity that exists but
    // could not be opened is never replaced on its own (#490): the onboarding
    // offers to try again, import or explicitly create another one.
    connectionStore.hasIdentity = identityStatus.state === 'ready';

    if (!connectionStore.hasIdentity) {
      const identity = await showIdentityOnboarding(this.appContainer, identityStatus, () => this.signalRendererReady());
      connectionStore.setIdentity(identity);
      // Monky always runs maximized once an identity exists; only the compact
      // first-launch identity card is shown in the smaller window.
      void window.api?.maximize?.().catch(() => clientLog.warn('APP', 'Could not maximize after choosing an identity'));
    }

    // At this point, identity is guaranteed to exist
    if (window.api?.getIdentity) {
      const identity = await window.api.getIdentity();
      connectionStore.setIdentity(identity);
    }
    markStartup('identity');

    connectionStore.loadUserProfile();
    if (!hasValidLocalProfile()) {
      await showIdentityProfileStep(this.appContainer);
    }

    this.setupGlobalEventListeners();
    bindTraySync({ isWatchingBotScreen: () => this.mainView.isWatchingAnyBotScreen() });

    // Initialize and sync quality preset to WebRtcManager and VideoService (#474)
    void webRtcManager.setQualityPreset(settingsStore.qualityPreset);

    // Initialize overlay bridge service (#169)
    overlayBridgeService.init((sessionId, shareId) => webRtcManager.getScreenCaptureMode(sessionId, shareId));

    // Friends and DMs need the identity. Their store opens in the main process
    // (keys and the encrypted history), so Home is drawn without waiting for it
    // and shows the conversations as soon as they load (R-SHELL-14).
    const directMessages = dmStore.init().catch((error: unknown) => {
      clientLog.error('DM', 'Direct messages failed to start', { error: error instanceof Error ? error.message : String(error) });
    });

    // The product now lands on Home: server connections are opened from the rail
    // or in the background after the shell has painted.
    sessionManager.showHome();
    this.mainView.render();
    markStartup('home');

    // The main UI has now been written to the DOM — let the main process lift
    // the post-update splash once it actually paints (#498).
    this.signalRendererReady();

    // The DM transport rides on server sessions, so it must be listening before
    // invitations or auto-entry connect them.
    await directMessages;
    markStartup('dm');
    this.unbindDm = bindDmNotifications();
    // Nickname/avatar follow the identity across devices; runs once DMs are up.
    void initProfileSync().then((off) => { this.unbindProfileSync = off; });

    this.unbindInvites = window.api?.onServerInviteAvailable?.(() => { void this.consumeServerInvites(); }) ?? null;
    const invitations = this.consumeServerInvites();

    // Load soundboard sounds if configured
    soundboardService.loadSounds().catch(() => {});

    // Sync minimize-to-tray preference to main process (#256)
    if (window.api?.setMinimizeToTray) {
      window.api.setMinimizeToTray(settingsStore.minimizeToTrayOnClose).catch(() => {});
    }

    // Initialize keybind service (#252)
    if (!developmentQa) keybindService.init();

    // Start checking for app updates (non-blocking)
    if (developmentQa) void startDevelopmentQa(developmentQa);
    else {
      updateService.init();
      void invitations.then(received => {
        if (received || this.disposed) return;
        // First Home: show the guide; automatic entry waits until it is done.
        if (!settingsStore.onboardingCompleted) {
          addServerModal.openGuide(() => { if (!this.disposed) void this.autoEntryService.start(); });
          return;
        }
        void this.autoEntryService.start();
      });
    }

    // Debug helper to check voice engine status in console
    window.debugVoice = () => {
      const status = webRtcManager.getVoiceStatus();
      console.log('%c🎙️ [Monky Voice Status]', 'color: #5865f2; font-weight: bold; font-size: 14px;');
      console.table(status);
      return status;
    };
  }

  private consumeServerInvites(): Promise<boolean> {
    if (this.inviteWork) return this.inviteWork;
    const work = (async () => {
      let received = false;
      if (!window.api?.takeServerInvite) return false;
      try {
        while (!this.disposed) {
          await joinInviteModal.waitUntilClosed();
          if (this.disposed) return received;
          const pending = await window.api.takeServerInvite();
          if (!pending || this.disposed) return received;
          received = true;
          this.autoEntryService.dispose();
          if (!pending.ok) {
            clientLog.warn('CONNECTION', 'Invalid server invitation');
            reportError(t('invite.invalidLink'));
          } else {
            await joinInviteModal.open(pending.invite);
          }
        }
      } catch (error: unknown) {
        clientLog.warn('CONNECTION', 'Could not process the pending server invitation');
        if (!this.disposed) reportError(t('invite.readFailed'));
      }
      return received;
    })();
    this.inviteWork = work.finally(() => { this.inviteWork = null; });
    return this.inviteWork;
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
        markStartup('painted');
        window.api?.signalRendererReady?.();
        clientLog.info('APP', 'Renderer startup timing', startupTimings());
      });
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
    window.api?.onAppBeforeQuit(request => {
      void (async () => {
        await webRtcManager.prepareForQuit();
        if (request.phase === 'farewell') await sessionManager.removeAll();
        await window.api?.notifyLeaveComplete(request);
      })().catch((err: unknown) => {
        clientLog.error('CONNECTION', 'Failed to leave servers before quitting', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
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

  /**
   * Wires what the app does on its own: navigation, server traffic, voice,
   * shortcuts and notices. Each domain lives in its own `bind*` module; the
   * app keeps the root navigation and the order in which a sign-in and a
   * disconnection touch stores, call and screen.
   */
  private setupGlobalEventListeners(): void {
    const renderHome = (): void => {
      void window.api?.setWindowInServer?.(false);
      this.mainView.render();
    };
    const unbindOnPageHide = [
      appEvents.on('navigation.home', renderHome),
      appEvents.on('session.changed', ({ key }: { key: string | null }) => {
        if (!key || sessionManager.isHome() || !sessionManager.get(key)?.serverStore.serverDetails) return;
        this.mainView.render();
      }),
      appEvents.on('session.connections_changed', () => {
        // Inside a server that is gone there is nothing left to show but Home.
        if (!sessionManager.isHome() && !sessionManager.getAll().length) renderHome();
        // Anywhere else connections only show on the rail and the call row:
        // rebuilding the layout would also rebuild an open DM, losing what was
        // being typed and attached.
        else this.mainView.refreshConnections();
      }),
      bindCameraPublication(),
      bindUserNotices(),
    ];
    window.addEventListener('pagehide', () => unbindOnPageHide.forEach(unbind => unbind()), { once: true });

    appEvents.on('voice.join_requested', () => this.voiceModeReconnect.cancel());
    appEvents.on('voice.channel_changed', () => this.voiceModeReconnect.validate());
    for (const event of ['network.status', `message.${MessageType.ROLES_LIST}`,
      `message.${MessageType.CHANNEL_DELETED}`, `message.${MessageType.CHANNEL_UPDATED}`] as const) {
      appEvents.on(event, () => {
        // Validation runs after all synchronous handlers have updated the
        // scoped stores; it reads the captured call, never foreground globals.
        queueMicrotask(() => this.voiceModeReconnect.validate());
      });
    }

    bindKeybindActions({ toggleCamera: () => this.mainView.toggleCamera() });

    // Language switch (#16): re-render whichever screen is on, so every label
    // built into the templates comes back in the new language.
    appEvents.on('i18n.language_changed', () => {
      this.mainView.render(true);
    });

    appEvents.on('network.connected', (payload: AuthSuccessPayload) => this.handleSignedIn(payload));
    appEvents.on('network.disconnected', () => this.handleDisconnected());

    // Server -> client traffic, applied to the stores of whichever server sent it (#400).
    bindServerStateEvents({ reconnect: this.voiceModeReconnect });
    bindChatEvents({ isViewingTextChannel: channelId => this.mainView.isViewingTextChannel(channelId) });
    bindVoiceEvents({
      reconnect: this.voiceModeReconnect,
      render: () => this.mainView.render(),
      rejoinOnScreen: channelId => { void this.mainView.rejoinVoiceChannel(channelId); },
    });

    // ── Bot infrastructure (#569) ────────────────────────────────────────
    bindBotChatEvents();
    bindBotScreenEvents();
    bindBotVoiceCommandEvents();

    appEvents.on('modal.open_screenshare_picker', () => {
      screenSharePickerModal.open();
    });
  }

  /**
   * A server signed this user in, for the first time or after an automatic
   * reconnection. The order matters: the stores are filled before the call
   * adopts the session, the screen is drawn before the call returns to its room.
   */
  private handleSignedIn(payload: AuthSuccessPayload): void {
    const origin = currentEventOrigin();
    const session = origin ? sessionManager.get(origin) : undefined;
    // Another server answering at a saved address leaves the entry as the
    // person saved it: automatic entry refuses it, and entering by hand saves
    // it again. Read before its identity is remembered below.
    const saved = session ? connectionStore.findSavedServer(session) : undefined;
    const sameServer = !saved?.serverId || saved.serverId === payload.server.id;
    if (session) connectionStore.rememberSavedServerIdentity(session.host, session.port, payload.server.id);
    const call = callBeforeSignIn(origin);
    // Same server and identity as before the drop: the view on screen is
    // still right, it only has to catch up.
    const resumingView = serverStore.serverDetails?.id === payload.server.id
      && serverStore.currentUser?.id === payload.currentUser.id;

    hydrateServerSession(payload);
    // The in-server layout needs more room than the connection card (#342).
    if (isForegroundEvent()) void window.api?.setWindowInServer?.(true);
    adoptCallAfterSignIn(payload, call);

    if (isForegroundEvent()) {
      if (resumingView) this.mainView.refreshAfterReconnect();
      else this.mainView.render();
    }
    // The rail shows the saved entry even when not connected (#301).
    if (session && sameServer) syncSavedServer(session, payload.server);
    resumeCallAfterSignIn(payload, call, origin, channelId => { void this.mainView.rejoinVoiceChannel(channelId); });
  }

  /** A server's socket is gone for good; a client that will retry emits `network.reconnecting` instead. */
  private handleDisconnected(): void {
    const origin = currentEventOrigin();
    // A server restart, update or removal drops the call just like a voice
    // kick: leaving it plays the leave cue (callCues), as any other ending.
    if (!voiceStore.voiceSessionKey || voiceStore.voiceSessionKey === origin) leaveCurrentCall(false);

    // The stores resolve to the session that dropped, so this clears the
    // right bundle even when a background server is the one going away.
    serverStore.clear();
    chatStore.clear();
    participantManager.clear();

    // Leaving the dead session in the map would show it as connected on the
    // rail and let a click "switch" to a server that is no longer there (#400).
    if (origin) sessionManager.remove(origin);

    // A background server dropping must not disturb what is on screen (#400).
    if (!isForegroundEvent()) return;

    // Another server may still be connected — typically the one hosting the
    // call. Showing it beats dumping the user on the connection screen while
    // they are still talking to someone.
    const next = sessionManager
      .getBackground()
      .find((candidate) => candidate.client.getStatus() === 'CONNECTED');
    if (next) {
      sessionManager.activate(next.key);
      return;
    }

    // Nothing left to show: return to Home while keeping the rail available.
    sessionManager.showHome();
    void window.api?.setWindowInServer?.(false);
    this.mainView.render();
  }
}

markStartup('modules');

// Bootstrap when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  void runFatalBootstrap(() => { new App(); }, 'constructor');
}, { once: true });

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
