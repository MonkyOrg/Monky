import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import './gameSharePrompt.css';

export interface GameSharePromptOptions {
  nickname: string;
  gameName: string;
  onShare(shareAudio: boolean): void;
  onDecline(): void;
}

/**
 * "Fulano quer ver sua partida" (#763). Non-blocking on purpose: the player is
 * usually in the game, so the prompt never takes focus or covers the app, and
 * screen readers learn about it through the live region instead.
 */
export class GameSharePrompt {
  private element: HTMLElement | null = null;
  private readonly controller = new AbortController();

  constructor(private readonly options: GameSharePromptOptions) {}

  public show(): void {
    const element = document.createElement('div');
    element.className = 'game-share-prompt';
    element.setAttribute('role', 'alertdialog');
    element.setAttribute('aria-modal', 'false');
    element.setAttribute('aria-live', 'assertive');
    const titleId = `game-share-title-${crypto.randomUUID()}`;
    element.setAttribute('aria-labelledby', titleId);
    element.innerHTML = `
      <div class="game-share-prompt-header">
        <span class="material-symbols-outlined" aria-hidden="true">sports_esports</span>
        <span id="${titleId}" class="game-share-prompt-title">${escapeHtml(t('gameShare.promptTitle', {
          name: this.options.nickname, game: this.options.gameName,
        }))}</span>
      </div>
      <div class="game-share-prompt-audio">
        <span id="${titleId}-audio">${escapeHtml(t('gameShare.promptAudio'))}</span>
        <label class="toggle-switch">
          <input type="checkbox" data-game-share-audio aria-labelledby="${titleId}-audio" checked>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="game-share-prompt-actions">
        <button type="button" class="btn btn-secondary" data-game-share="decline">${escapeHtml(t('gameShare.notNow'))}</button>
        <button type="button" class="btn btn-primary" data-game-share="share">${escapeHtml(t('gameShare.share'))}</button>
      </div>
    `;
    const signal = this.controller.signal;
    element.querySelector('[data-game-share="share"]')?.addEventListener('click', () => {
      const audio = element.querySelector<HTMLInputElement>('[data-game-share-audio]');
      this.options.onShare(audio?.checked ?? true);
    }, { signal });
    element.querySelector('[data-game-share="decline"]')?.addEventListener('click', () => this.options.onDecline(), { signal });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.options.onDecline();
    }, { signal });
    document.body.appendChild(element);
    this.element = element;
  }

  public close(): void {
    this.controller.abort();
    this.element?.remove();
    this.element = null;
  }
}
