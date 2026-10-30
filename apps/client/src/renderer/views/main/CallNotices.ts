import { appEvents } from '../../core/EventBus';
import { sessionManager } from '../../core/SessionManager';
import { webRtcManager } from '../../core/WebRtcManager';
import { gameShareSuggestion } from '../../core/GameShareSuggestion';
import { overlayBridgeService } from '../../core/OverlayBridgeService';
import { voiceStore } from '../../stores/voiceStore';
import { escapeHtml } from '../../utils/html';
import { getBotVoiceContext } from '../../utils/botVoice';
import { screenShareFailureMessage } from '../../utils/screenShareFailure';
import { cancelVisibilityMotion, setSurfaceVisible } from '../../utils/surfaceVisibility';
import { chooseSharesToStop, screenShareChooser, stopChosenShares } from '../ScreenShareChooser';
import type { BotScreenDock } from '../BotScreenDock';
import { showAlert } from '../Dialog';
import { t, tCount } from '../../i18n';

export interface CallNoticesHost {
  /** The layout the notices are drawn in. */
  readonly root: HTMLElement;
  /** Whether the center shows a conversation or the voice stage, where most of these notices have nothing to add. */
  contentView(): 'chat' | 'stage';
  /** The call's miniapps, on stage or parked while the person browses elsewhere. */
  botScreenDock(): BotScreenDock | null;
  /** Opens the call's stage, optionally watching someone's broadcast or a miniapp. */
  openVoiceStage(watchSessionId?: string, botScreenId?: string): void;
}

/**
 * The lines above the user card about what the call is doing out of sight:
 * screens being shared or watched (#282, #416), miniapps waiting off stage and
 * the overlay (#169).
 */
export class CallNotices {
  // Caches the rendered screen-share notice so the frequent (per-frame)
  // 'participants.updated' events don't rebuild it on every speaking change,
  // which would flicker the button and drop its listener (#282).
  private signature: string | null = null;

  constructor(private readonly host: CallNoticesHost) {}

  /** Fresh layout: its slots are empty, so every notice is drawn again. */
  public renderAll(): void {
    this.signature = null;
    this.updateScreenShare();
    this.updateBotScreenBackground(false);
    this.updateOverlay();
  }

  public bind(): () => void {
    const screens = () => {
      this.updateScreenShare();
      this.updateBotScreenBackground();
    };
    const unbind = [
      // Keep the overlay notice in sync: `state_changed` covers the window
      // opening/closing, `overlay_settings.updated` covers the "open on leaving
      // the stage" arm/disarm that also counts as active (#169).
      appEvents.on('overlay.state_changed', () => this.updateOverlay()),
      appEvents.on('overlay_settings.updated', () => this.updateOverlay()),
      appEvents.on('voice.bot_screens_updated', screens),
      appEvents.on('stage.bot_screens_changed', screens),
      appEvents.on('voice.screen_watch_changed', () => this.updateScreenShare()),
      appEvents.on('game_share.live_changed', () => this.updateScreenShare()),
    ];
    return () => unbind.forEach(off => off());
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
  public updateScreenShare(): void {
    const slot = this.host.root.querySelector<HTMLElement>('#screenshare-notice-slot');
    if (!slot) return;

    const watchedScreens = this.getWatchedRemoteScreens();
    const watchedSessions = new Set(watchedScreens.map(screen => screen.sessionId));
    const sharers = this.getRemoteScreenSharers().filter(sharer => !watchedSessions.has(sharer.id));
    // While the game strip shows the game share as live, it is the status (#763).
    const isSelfSharing = voiceStore.isScreenSharing && !gameShareSuggestion.isLive();
    const voice = getBotVoiceContext();
    const screens = voice ? voice.session.botScreenStore.list(voice.channelId)
      .filter((screen) => !this.host.botScreenDock()?.isWatching(screen.id)
        && !voice.session.botScreenStore.isInvitationDismissed(screen.id)) : [];
    const loadFailed = voice?.session.botScreenStore.loadFailed ?? false;
    // The count re-renders the stop button when a second screen turns it into a menu.
    const selfShareCount = isSelfSharing ? voiceStore.screenShareIds.length : 0;
    const signature = JSON.stringify([
      this.host.contentView(), isSelfSharing, selfShareCount, watchedScreens, sharers, voice?.session.key, voice?.channelId,
      screens.map((screen) => [screen.id, screen.instanceId, screen.title]), loadFailed,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;

    if ((this.host.contentView() === 'stage'
      || (watchedScreens.length === 0 && sharers.length === 0 && !isSelfSharing))
      && screens.length === 0 && !loadFailed) {
      slot.innerHTML = '';
      return;
    }

    const parts: string[] = [];

    // Local user sharing notice with stop button (#416)
    if (isSelfSharing && this.host.contentView() !== 'stage') {
      parts.push(`
        <div class="screenshare-notice screenshare-notice--self">
          <span class="material-symbols-outlined md-16 screenshare-notice-icon">screen_share</span>
          <span class="screenshare-notice-text">${t('main.screenShareSelfNotice')}</span>
          <button id="screenshare-self-stop-btn" class="screenshare-notice-btn screenshare-notice-btn--danger"
            aria-haspopup="${selfShareCount > 1 ? 'menu' : 'false'}">${t('screenShare.stopSharing')}</button>
        </div>
      `);
    }

    if (watchedScreens.length > 0 && this.host.contentView() !== 'stage') {
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
    if (sharers.length > 0 && this.host.contentView() !== 'stage') {
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
        this.host.openVoiceStage(undefined, screen.id);
      });
    });
    slot.querySelector('[data-reload-bot-screens]')?.addEventListener('click', () => appEvents.emit('voice.bot_screens_reload'));

    // Stop self-sharing handler; with several screens it asks which one first.
    const selfStop = this.host.root.querySelector<HTMLElement>('#screenshare-self-stop-btn');
    if (selfStop) selfStop.addEventListener('click', async () => {
      if (screenShareChooser.isOpenFor(selfStop)) {
        screenShareChooser.close();
        return;
      }
      const selection = await chooseSharesToStop(selfStop);
      if (!selection) return;
      try {
        await stopChosenShares(selection);
      } catch (error) {
        await showAlert({
          title: t('screenShare.errorTitle'),
          message: screenShareFailureMessage(error, 'stop'),
          variant: 'danger',
        });
      }
      this.updateScreenShare();
    });

    this.host.root.querySelector<HTMLElement>('#screenshare-viewer-stage-btn')?.addEventListener('click', () => this.host.openVoiceStage());

    this.host.root.querySelector<HTMLElement>('#screenshare-viewer-stop-btn')?.addEventListener('click', () => {
      for (const [sessionId, shareIds] of voiceStore.getScreenWatchers()) {
        for (const shareId of shareIds) webRtcManager.setRemoteScreenWatching(sessionId, shareId, false);
      }
      this.updateScreenShare();
    });

    // Watch remote sharer handler
    if (sharers.length > 0) {
      const single = sharers.length === 1;
      this.host.root.querySelector<HTMLElement>('#screenshare-notice-btn')?.addEventListener('click', () => {
        this.host.openVoiceStage(single ? sharers[0].id : undefined);
      });
    }
  }

  /**
   * One line per open miniapp waiting off stage while its person browses elsewhere, with the way
   * back to it. A line slides out when its miniapp returns to the stage, but disappears at once when
   * the view closed: a revoked or ended miniapp must not linger.
   */
  public updateBotScreenBackground(animate = true): void {
    const slot = this.host.root.querySelector<HTMLElement>('#bot-screen-background-slot');
    const dock = this.host.botScreenDock();
    if (!slot) return;
    const parked = dock?.parked() ?? [];
    const rows = new Map([...slot.querySelectorAll<HTMLElement>('[data-bot-screen-background]')]
      .map((row) => [row.dataset.botScreenBackground ?? '', row]));
    for (const [id, row] of rows) {
      if (parked.some((view) => view.snapshot.id === id && view.snapshot.instanceId === row.dataset.botScreenInstance)) continue;
      rows.delete(id);
      if (dock?.isWatching(id) && row.dataset.botScreenInstance === dock.get(id)?.snapshot.instanceId) {
        setSurfaceVisible(row, false, 'panel', undefined, () => row.remove());
      } else {
        cancelVisibilityMotion(row);
        row.remove();
      }
    }
    for (const view of parked) {
      const { id, instanceId, title } = view.snapshot;
      let row = rows.get(id);
      if (!row) {
        row = document.createElement('div');
        // Stacked like the "watching" notice: the sentence and its action do not fit on one line.
        row.className = 'screenshare-notice screenshare-notice--stacked bot-screen-background';
        row.dataset.botScreenBackground = id;
        row.dataset.botScreenInstance = instanceId;
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined md-16 screenshare-notice-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'apps';
        const text = document.createElement('span');
        text.className = 'screenshare-notice-text';
        const actions = document.createElement('div');
        actions.className = 'screenshare-notice-actions';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'screenshare-notice-btn';
        button.addEventListener('click', () => {
          const current = this.host.botScreenDock()?.get(id);
          if (!current?.isWatching || current.snapshot.instanceId !== instanceId) return;
          this.host.openVoiceStage(undefined, id);
        });
        actions.append(button);
        row.append(icon, text, actions);
        row.hidden = animate;
        slot.append(row);
      }
      const text = row.querySelector<HTMLElement>('.screenshare-notice-text');
      const button = row.querySelector<HTMLButtonElement>('button');
      const label = t('botScreen.backgroundNotice', { title });
      if (text && text.textContent !== label) {
        text.textContent = label;
        text.title = label;
      }
      if (button) {
        const action = t('botScreen.returnToView');
        const name = t('botScreen.returnTo', { title });
        if (button.textContent !== action) button.textContent = action;
        if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
      }
      // Coming back while its exit plays reverses it instead of stacking a second line.
      if (animate) setSurfaceVisible(row, true, 'panel');
      else {
        cancelVisibilityMotion(row);
        row.hidden = false;
      }
    }
  }

  /**
   * Sidebar line mirroring the screen-share notice, but for the overlay: it
   * tells the user the overlay is on and carries the stop button, so the overlay
   * no longer needs a stop control on the stage. Unlike the screen-share notice,
   * it stays visible on the stage too — the overlay keeps running there, so its
   * indicator should as well.
   */
  public updateOverlay(): void {
    const slot = this.host.root.querySelector<HTMLElement>('#overlay-notice-slot');
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

    this.host.root.querySelector<HTMLElement>('#overlay-notice-stop-btn')?.addEventListener('click', () => {
      void overlayBridgeService.deactivate();
    });
  }}
