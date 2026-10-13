import type { UserActivity } from '@monky/shared';
import { appEvents } from './EventBus';
import { gamePresence } from './GamePresenceController';
import { gameSessionKey, shouldSuggestGameShare } from './gameShareEligibility';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { screenSharePickerModal } from '../views/ScreenSharePickerModal';
import { showInfoToast } from '../views/CopyToast';
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
      <button type="button" class="btn btn-icon game-share-suggestion-stream" data-game-share-suggestion="share" title="${label}" aria-label="${label}">
        <span class="material-symbols-outlined md-18" aria-hidden="true">screen_share</span>
      </button>
    `;
    row.querySelector('[data-game-share-suggestion="share"]')?.addEventListener('click', () => void this.shareGame());
    slot.appendChild(row);
    if (animate) animateEnter(row, 'notice');
  }

  /**
   * The click on "Transmitir" is the explicit confirmation sharing already
   * requires; nothing is captured before it. Only the game's own windows are
   * offered, with its audio on (the picker still lets it be turned off), and
   * with none found the person picks one by hand.
   */
  public async shareGame(): Promise<void> {
    let sourceIds: string[] = [];
    try {
      sourceIds = await window.api?.findGameWindows?.() ?? [];
    } catch (error: unknown) {
      console.warn('[GameShare] Could not look up the game windows', error);
    }
    if (sourceIds.length === 0) {
      showInfoToast(t('gameShare.windowNotFound'), 6000);
      await screenSharePickerModal.open();
      return;
    }
    await screenSharePickerModal.openForGame({ sourceIds, shareAudio: true });
  }

  private findRow(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${GAME_SHARE_SUGGESTION_SLOT} .game-share-suggestion:not([data-ui-closing])`);
  }
}

export const gameShareSuggestion = new GameShareSuggestion();
