import type { UserActivity } from '@monky/shared';
import { appEvents } from './EventBus';
import { gamePresence } from './GamePresenceController';
import { gameSessionKey, shouldSuggestGameShare } from './gameShareEligibility';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { startGameShare } from './gameShareStart';
import { showErrorToast } from '../views/CopyToast';
import { setButtonLoading } from '../utils/buttonLoading';
import { activityIconSrc } from '../utils/activityIcon';
import { escapeHtml } from '../utils/html';
import { animateEnter, cancelSurfaceMotion, removeWithMotion } from '../utils/surfaceMotion';
import { t } from '../i18n';

export const GAME_SHARE_SUGGESTION_SLOT = 'game-share-notice-slot';

/**
 * The game you are playing, at the top of the voice panel with a button to
 * stream it (#763), as in Discord: shown while a detected game runs and the
 * person is in a call without a screen share. It never nags — no dismissal to
 * remember — and the setting turns it off for good.
 */
export class GameShareSuggestion {
  private activity: UserActivity | null = null;
  private readonly unbind: Array<() => void> = [];
  private starting = false;

  public start(): void {
    this.activity = gamePresence.current;
    this.unbind.push(
      appEvents.on<UserActivity | null>('game_presence.changed', (activity) => {
        this.activity = activity;
        this.render();
      }),
      appEvents.on('voice.channel_changed', () => this.render()),
      appEvents.on('voice.state_updated', () => this.render()),
      appEvents.on('i18n.language_changed', () => this.render(false)),
    );
    this.render();
  }

  public dispose(): void {
    for (const off of this.unbind.splice(0)) off();
    for (const row of document.querySelectorAll<HTMLElement>(`#${GAME_SHARE_SUGGESTION_SLOT} .game-share-suggestion`)) {
      cancelSurfaceMotion(row);
      row.remove();
    }
  }

  /**
   * Keeps the slot in sync with the current state. The sidebar re-renders on
   * every server switch, so the view calls this again on a fresh slot, without
   * the entrance motion: nothing changed from the person's point of view.
   */
  public render(animate = true): void {
    const slot = document.getElementById(GAME_SHARE_SUGGESTION_SLOT);
    const activity = this.activity;
    const show = shouldSuggestGameShare({
      enabled: settingsStore.suggestGameShare,
      activity,
      inVoiceChannel: voiceStore.currentVoiceChannelId !== null,
      isScreenSharing: voiceStore.isScreenSharing,
    });
    const existing = this.findRow();
    if (!show || !slot || !activity) {
      if (existing) removeWithMotion(existing, 'notice');
      return;
    }
    const key = gameSessionKey(activity);
    if (existing?.dataset.session === key && animate) return;
    if (existing) existing.remove();
    for (const closing of slot.querySelectorAll<HTMLElement>('[data-ui-closing]')) {
      cancelSurfaceMotion(closing);
      closing.remove();
    }

    const art = activityIconSrc(activity.iconBase64);
    const label = escapeHtml(t('gameShare.stream', { game: activity.name }));
    const row = document.createElement('div');
    row.className = 'game-share-suggestion';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', activity.name);
    row.dataset.session = key;
    row.innerHTML = `
      ${art
        ? `<img class="game-share-suggestion-art" src="${art}" alt="" width="28" height="28">`
        : '<span class="material-symbols-outlined md-18 game-share-suggestion-art" aria-hidden="true">sports_esports</span>'}
      <span class="game-share-suggestion-name">${escapeHtml(activity.name)}</span>
      <button type="button" class="btn btn-icon media-bar-btn-lg game-share-suggestion-stream" data-game-share-suggestion="share" title="${label}" aria-label="${label}">
        <span class="material-symbols-outlined md-18" aria-hidden="true">screen_share</span>
      </button>
    `;
    const button = row.querySelector<HTMLButtonElement>('[data-game-share-suggestion="share"]');
    button?.addEventListener('click', () => {
      if (this.starting) return;
      this.starting = true;
      setButtonLoading(button, true);
      void this.shareGame().finally(() => {
        this.starting = false;
        if (button.isConnected) setButtonLoading(button, false);
      });
    });
    slot.appendChild(row);
    if (animate) animateEnter(row, 'notice');
  }

  /**
   * Straight to the stream, as in Discord: no picker, no question. With the
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
      await startGameShare(sourceId);
    } catch (error: unknown) {
      console.warn('[GameShare] Could not stream the game', error);
      showErrorToast(t('gameShare.failed', { error: error instanceof Error ? error.message : String(error) }), 7000);
    }
  }

  private findRow(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${GAME_SHARE_SUGGESTION_SLOT} .game-share-suggestion:not([data-ui-closing])`);
  }
}

export const gameShareSuggestion = new GameShareSuggestion();
