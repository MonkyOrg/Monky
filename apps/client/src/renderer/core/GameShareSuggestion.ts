import type { UserActivity } from '@monky/shared';
import { appEvents } from './EventBus';
import { gamePresence } from './GamePresenceController';
import { gameShareRequests } from './GameShareRequests';
import { gameSessionKey, shouldSuggestGameShare } from './gameShareEligibility';
import { voiceStore } from '../stores/voiceStore';
import { escapeHtml } from '../utils/html';
import { animateEnter, cancelSurfaceMotion, removeWithMotion } from '../utils/surfaceMotion';
import { t } from '../i18n';

export const GAME_SHARE_SUGGESTION_SLOT = 'game-share-notice-slot';

/**
 * "Você está jogando X. Compartilhar a partida?" (#763): a card above the
 * user panel, as in Discord, while a detected game runs and the person is in
 * a call without a screen share. Dismissing or sharing settles that launch of
 * the game; the next launch brings the suggestion back.
 */
export class GameShareSuggestion {
  private activity: UserActivity | null = null;
  private settled: string | null = null;
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
      appEvents.on('i18n.language_changed', () => this.render(false)),
    );
    this.render();
  }

  public dispose(): void {
    for (const off of this.unbind.splice(0)) off();
    for (const notice of document.querySelectorAll<HTMLElement>(`#${GAME_SHARE_SUGGESTION_SLOT} .game-share-suggestion`)) {
      cancelSurfaceMotion(notice);
      notice.remove();
    }
  }

  /**
   * Keeps the slot in sync with the current state. The sidebar re-renders on
   * every server switch, so the view calls this again on a fresh slot, without
   * the entrance motion: nothing changed from the person's point of view.
   */
  public render(animate = true): void {
    const slot = document.getElementById(GAME_SHARE_SUGGESTION_SLOT);
    const key = this.activity ? gameSessionKey(this.activity) : null;
    // A new launch starts clean — a blink to "no game" (sharing toggled off and
    // on, say) does not. Sharing by any means settles the current launch.
    if (this.settled !== null && key !== null && this.settled !== key) this.settled = null;
    if (key !== null && voiceStore.isScreenSharing) this.settled = key;

    const show = shouldSuggestGameShare({
      activity: this.activity,
      inVoiceChannel: voiceStore.currentVoiceChannelId !== null,
      isScreenSharing: voiceStore.isScreenSharing,
      settledSession: this.settled,
    });
    const existing = this.findNotice();
    if (!show || !slot || !this.activity || key === null) {
      if (existing) removeWithMotion(existing, 'notice');
      return;
    }
    if (existing?.dataset.session === key && animate) return;
    if (existing) existing.remove();
    for (const closing of slot.querySelectorAll<HTMLElement>('[data-ui-closing]')) {
      cancelSurfaceMotion(closing);
      closing.remove();
    }

    const notice = document.createElement('div');
    notice.className = 'screenshare-notice screenshare-notice--stacked game-share-suggestion';
    notice.setAttribute('role', 'status');
    notice.dataset.session = key;
    notice.innerHTML = `
      <span class="material-symbols-outlined md-16 screenshare-notice-icon" aria-hidden="true">sports_esports</span>
      <span class="screenshare-notice-text">${escapeHtml(t('gameShare.suggestion', { game: this.activity.name }))}</span>
      <div class="screenshare-notice-actions">
        <button type="button" class="screenshare-notice-btn screenshare-notice-btn--quiet" data-game-share-suggestion="dismiss">${escapeHtml(t('gameShare.notNow'))}</button>
        <button type="button" class="screenshare-notice-btn" data-game-share-suggestion="share">${escapeHtml(t('gameShare.share'))}</button>
      </div>
    `;
    notice.querySelector('[data-game-share-suggestion="dismiss"]')?.addEventListener('click', () => this.settle(key));
    notice.querySelector('[data-game-share-suggestion="share"]')?.addEventListener('click', () => {
      this.settle(key);
      // Game audio on by default, as when accepting a request; the picker still lets it be turned off.
      void gameShareRequests.shareGame(true);
    });
    slot.appendChild(notice);
    if (animate) animateEnter(notice, 'notice');
  }

  private settle(key: string): void {
    this.settled = key;
    const notice = this.findNotice();
    if (notice) removeWithMotion(notice, 'notice');
  }

  private findNotice(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${GAME_SHARE_SUGGESTION_SLOT} .game-share-suggestion:not([data-ui-closing])`);
  }
}

export const gameShareSuggestion = new GameShareSuggestion();
