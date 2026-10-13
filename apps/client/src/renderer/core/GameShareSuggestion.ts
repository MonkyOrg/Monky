import type { UserActivity } from '@monky/shared';
import { appEvents } from './EventBus';
import { gamePresence } from './GamePresenceController';
import { gameSessionKey, shouldSuggestGameShare } from './gameShareEligibility';
import { gameShareRequests, type PendingGameShareRequest } from './GameShareRequests';
import { startGameShare } from './gameShareStart';
import { screenAudioService } from './ScreenAudioService';
import { stopLocalScreenShares } from './screenShareControls';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { showErrorToast } from '../views/CopyToast';
import { showConfirm } from '../views/Dialog';
import { activityIconSrc } from '../utils/activityIcon';
import { setButtonLoading } from '../utils/buttonLoading';
import { escapeHtml } from '../utils/html';
import { cancelSurfaceMotion } from '../utils/surfaceMotion';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { t } from '../i18n';

export const GAME_SHARE_SUGGESTION_SLOT = 'game-share-notice-slot';

type StripState = 'playing' | 'request' | 'live';

/**
 * The game strip atop the voice panel (#763), as in Discord: the game you are
 * playing is the panel's header, with one written action. It is a status, not
 * a nudge — it lives while the game runs in a call, with nothing to dismiss.
 *
 * - playing: "Jogando · <game>" and "Compartilhar", which streams the game
 *   window after one confirmation, without the picker;
 * - request: someone in the call asked to watch ("Lucas quer ver"), with a bar
 *   for the 30 s left, "Compartilhar" to accept and × for "Agora não". It shows
 *   even with the suggestion setting off: a person asking is not a nudge;
 * - live: the same strip says "Ao vivo" and the action becomes "Parar". It then
 *   owns the "you are sharing" status, so the panel does not stack two.
 *
 * Sharing anything else by hand hides it: the strip only speaks for the game.
 */
export class GameShareSuggestion {
  private activity: UserActivity | null = null;
  /** The share this strip started, while it is the only one being published. */
  private liveShareId: string | null = null;
  private busy = false;
  private wasLive = false;
  private readonly unbind: Array<() => void> = [];

  public start(): void {
    this.activity = gamePresence.current;
    this.unbind.push(
      appEvents.on<UserActivity | null>('game_presence.changed', (activity) => {
        this.activity = activity;
        this.render();
      }),
      appEvents.on('voice.channel_changed', () => this.render()),
      appEvents.on('voice.state_updated', () => this.render()),
      appEvents.on('game_share.request_changed', () => this.render()),
      appEvents.on('i18n.language_changed', () => this.render(false, true)),
    );
    this.render();
  }

  public dispose(): void {
    for (const off of this.unbind.splice(0)) off();
    this.liveShareId = null;
    this.wasLive = false;
    for (const strip of document.querySelectorAll<HTMLElement>(`#${GAME_SHARE_SUGGESTION_SLOT} .game-share-suggestion`)) {
      cancelSurfaceMotion(strip);
      strip.remove();
    }
  }

  /** Whether the strip is showing the game share as live, in place of the panel's "you are sharing" notice. */
  public isLive(): boolean {
    return this.state() === 'live';
  }

  /** Called by startGameShare right before the share is published. */
  public claimShare(shareId: string): void {
    this.liveShareId = shareId;
  }

  private state(): StripState | null {
    const ids = voiceStore.screenShareIds;
    if (this.liveShareId !== null && !ids.includes(this.liveShareId)) this.liveShareId = null;
    if (gameShareRequests.current() && this.activity && voiceStore.currentVoiceChannelId !== null
      && !voiceStore.isScreenSharing) return 'request';
    const visible = shouldSuggestGameShare({
      enabled: settingsStore.suggestGameShare,
      activity: this.activity,
      inVoiceChannel: voiceStore.currentVoiceChannelId !== null,
      isScreenSharing: voiceStore.isScreenSharing,
    });
    if (visible) return 'playing';
    const onlyTheGame = this.liveShareId !== null && ids.length === 1 && ids[0] === this.liveShareId;
    return onlyTheGame && settingsStore.suggestGameShare && !!this.activity && voiceStore.currentVoiceChannelId !== null
      ? 'live' : null;
  }

  /**
   * Keeps the slot in sync with the current state. The sidebar re-renders on
   * every server switch, so the view calls this again on a fresh slot, without
   * the entrance motion: nothing changed from the person's point of view.
   */
  public render(animate = true, rebuild = false): void {
    const slot = document.getElementById(GAME_SHARE_SUGGESTION_SLOT);
    const state = this.state();
    const live = state === 'live';
    if (live !== this.wasLive) {
      this.wasLive = live;
      appEvents.emit('game_share.live_changed', live);
    }
    const existing = this.findStrip();
    const activity = this.activity;
    if (!state || !slot || !activity) {
      if (existing) setSurfaceVisible(existing, false, 'panel', undefined, () => existing.remove());
      return;
    }
    const key = gameSessionKey(activity);
    if (existing && existing.dataset.session === key && !rebuild) {
      this.applyState(existing, activity, state, animate);
      return;
    }
    existing?.remove();
    for (const closing of slot.querySelectorAll<HTMLElement>('[data-ui-closing]')) {
      cancelSurfaceMotion(closing);
      closing.remove();
    }

    const art = activityIconSrc(activity.iconBase64);
    const strip = document.createElement('div');
    strip.className = 'game-share-suggestion';
    strip.dataset.session = key;
    strip.innerHTML = `
      <span class="game-share-suggestion-art">${art
        ? `<img src="${art}" alt="" width="32" height="32">`
        : '<span class="material-symbols-outlined md-18" aria-hidden="true">sports_esports</span>'}</span>
      <span class="game-share-suggestion-text" role="status">
        <span class="game-share-suggestion-over"></span>
        <span class="game-share-suggestion-name">${escapeHtml(activity.name)}</span>
      </span>
      <button type="button" class="game-share-suggestion-dismiss" data-game-share-suggestion="decline" hidden>
        <span class="material-symbols-outlined md-18" aria-hidden="true">close</span>
      </button>
      <button type="button" class="screenshare-notice-btn game-share-suggestion-cta" data-game-share-suggestion="share"></button>
      <span class="game-share-suggestion-timer" aria-hidden="true"></span>
    `;
    const button = strip.querySelector<HTMLButtonElement>('.game-share-suggestion-cta');
    button?.addEventListener('click', () => void this.onAction(button));
    strip.querySelector('.game-share-suggestion-dismiss')?.addEventListener('click', () => {
      const id = strip.dataset.request;
      if (id) gameShareRequests.answer(id, false);
    });
    this.applyState(strip, activity, state, false);
    // The panel opens room for it instead of the strip popping over the voice row.
    strip.hidden = true;
    slot.appendChild(strip);
    if (animate) setSurfaceVisible(strip, true, 'panel');
    else strip.hidden = false;
  }

  /** Same place, same size: only the status line, the actions and the timer change. */
  private applyState(strip: HTMLElement, activity: UserActivity, state: StripState, animate: boolean): void {
    const request = state === 'request' ? gameShareRequests.current() : null;
    if (strip.dataset.state === state && (strip.dataset.request ?? null) === (request?.id ?? null)) return;
    const changed = strip.dataset.state !== undefined;
    strip.dataset.state = state;
    if (request) strip.dataset.request = request.id;
    else delete strip.dataset.request;
    const over = strip.querySelector<HTMLElement>('.game-share-suggestion-over');
    const text = strip.querySelector<HTMLElement>('.game-share-suggestion-text');
    if (over) over.innerHTML = this.statusLine(state, request);
    const dismiss = strip.querySelector<HTMLButtonElement>('.game-share-suggestion-dismiss');
    if (dismiss) {
      dismiss.hidden = !request;
      dismiss.setAttribute('aria-label', t('gameShare.notNow'));
      dismiss.title = t('gameShare.notNow');
    }
    this.runTimer(strip, request);
    if (changed && animate && text) {
      text.classList.remove('game-share-suggestion-text--swap');
      void text.offsetWidth;
      text.classList.add('game-share-suggestion-text--swap');
    }
    const button = strip.querySelector<HTMLButtonElement>('.game-share-suggestion-cta');
    if (!button) return;
    const live = state === 'live';
    button.dataset.gameShareSuggestion = live ? 'stop' : request ? 'accept' : 'share';
    button.classList.toggle('game-share-suggestion-cta--stop', live);
    button.textContent = t(live ? 'gameShare.stop' : 'gameShare.share');
    button.setAttribute('aria-label', t(live ? 'gameShare.stopLabel' : 'gameShare.shareLabel', { game: activity.name }));
  }

  private statusLine(state: StripState, request: PendingGameShareRequest | null): string {
    if (state === 'live') {
      return `<span class="live-pulse-dot" aria-hidden="true"></span><span class="game-share-suggestion-live">${escapeHtml(t('gameShare.live'))}</span>`;
    }
    if (request) {
      const initial = Array.from(request.nickname.trim())[0]?.toUpperCase() ?? '?';
      return `<span class="game-share-suggestion-avatar" aria-hidden="true">${escapeHtml(initial)}</span>`
        + `<span class="game-share-suggestion-request">${escapeHtml(t('gameShare.wantsToWatch', { name: request.nickname }))}</span>`;
    }
    return `<span>${escapeHtml(t('gameShare.playing'))}</span>`;
  }

  /** The bar empties over what is left of the request, even when the strip was rebuilt midway. */
  private runTimer(strip: HTMLElement, request: PendingGameShareRequest | null): void {
    const timer = strip.querySelector<HTMLElement>('.game-share-suggestion-timer');
    if (!timer) return;
    timer.classList.remove('game-share-suggestion-timer--run');
    if (!request) return;
    const left = Math.max(0, request.expiresAt - Date.now());
    timer.style.setProperty('--game-share-timer-start', String(left / request.durationMs));
    timer.style.animationDuration = `${left}ms`;
    void timer.offsetWidth;
    timer.classList.add('game-share-suggestion-timer--run');
  }

  private async onAction(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    setButtonLoading(button, true);
    try {
      const action = button.dataset.gameShareSuggestion;
      const request = action === 'accept' ? button.closest<HTMLElement>('.game-share-suggestion')?.dataset.request : undefined;
      if (action === 'stop') await this.stopGame();
      // "Cancelar" leaves everything as it was: nothing captured, a request still waiting.
      else if (this.activity && await this.confirmShare(this.activity.name)) {
        // The asker hears back first; a request that expired meanwhile just has nobody to answer.
        if (request) gameShareRequests.answer(request, true);
        await this.shareGame();
      }
    } finally {
      this.busy = false;
      if (button.isConnected) setButtonLoading(button, false);
    }
  }

  /** One explicit yes before anything is captured; stopping never asks. */
  public confirmShare(game: string): Promise<boolean> {
    return showConfirm({
      title: t('gameShare.confirmTitle', { game }),
      message: t('gameShare.confirmMessage'),
      confirmLabel: t('gameShare.share'),
      cancelLabel: t('common.cancel'),
    });
  }

  /**
   * Straight to the stream once confirmed, as in Discord: no picker. With the
   * game window gone (closed, or not found among the open ones) it says so
   * instead of offering the screen or another app.
   */
  public async shareGame(): Promise<void> {
    try {
      const [sourceId] = await window.api?.findGameWindows?.() ?? [];
      if (!sourceId) {
        showErrorToast(t('gameShare.windowNotFound'));
        return;
      }
      await startGameShare(sourceId, shareId => this.claimShare(shareId));
    } catch (error: unknown) {
      console.warn('[GameShare] Could not stream the game', error);
      showErrorToast(t('gameShare.failed', { error: error instanceof Error ? error.message : String(error) }), 7000);
    }
  }

  private async stopGame(): Promise<void> {
    const shareId = this.liveShareId;
    if (!shareId) return;
    try {
      await stopLocalScreenShares(screenAudioService, { shareIds: [shareId] });
    } catch (error: unknown) {
      console.warn('[GameShare] Could not stop the game stream', error);
      showErrorToast(t('gameShare.stopFailed', { error: error instanceof Error ? error.message : String(error) }), 7000);
    }
  }

  private findStrip(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${GAME_SHARE_SUGGESTION_SLOT} .game-share-suggestion:not([data-ui-closing])`);
  }
}

export const gameShareSuggestion = new GameShareSuggestion();
