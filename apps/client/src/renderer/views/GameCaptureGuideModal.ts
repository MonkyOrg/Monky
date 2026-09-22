import { t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';

export const GAME_CAPTURE_GUIDE_SOURCE = 'https://obsproject.com/kb/game-capture-troubleshooting';

type GameCaptureAdvice = 'normal' | 'dx12' | 'separateWindow' | 'multiGpu' | 'permissions';
interface GameCaptureGuidance {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly advice: GameCaptureAdvice;
}

export const GAME_CAPTURE_GUIDANCE: readonly GameCaptureGuidance[] = [
  { id: 'cs2', title: 'Counter-Strike 2', aliases: ['CS2', 'CS 2', 'Counter Strike'], advice: 'normal' },
  { id: 'destiny2', title: 'Destiny 2', aliases: [], advice: 'normal' },
  { id: 'gta-san-andreas', title: 'Grand Theft Auto: San Andreas', aliases: ['GTA San Andreas', 'GTA SA'], advice: 'normal' },
  { id: 'roblox', title: 'Roblox', aliases: [], advice: 'normal' },
  { id: 'samp', title: 'San Andreas Multiplayer', aliases: ['SA-MP', 'SAMP'], advice: 'normal' },
  { id: 'call-of-duty', title: 'Call of Duty', aliases: [], advice: 'permissions' },
  { id: 'fortnite', title: 'Fortnite', aliases: [], advice: 'dx12' },
  { id: 'genshin-impact', title: 'Genshin Impact', aliases: [], advice: 'permissions' },
  { id: 'honkai-star-rail', title: 'Honkai: Star Rail', aliases: [], advice: 'permissions' },
  { id: 'league-of-legends', title: 'League of Legends', aliases: ['LoL'], advice: 'separateWindow' },
  { id: 'minecraft-java', title: 'Minecraft: Java Edition', aliases: ['Minecraft Java'], advice: 'multiGpu' },
  { id: 'osu', title: 'osu!', aliases: [], advice: 'multiGpu' },
  { id: 'valorant', title: 'Valorant', aliases: [], advice: 'permissions' },
  { id: 'zenless-zone-zero', title: 'Zenless Zone Zero', aliases: [], advice: 'permissions' },
];

const ADVICE_KEYS: Record<GameCaptureAdvice, TranslationKey> = {
  normal: 'screenShare.gameGuideAdviceNormal',
  dx12: 'screenShare.gameGuideAdviceDx12',
  separateWindow: 'screenShare.gameGuideAdviceSeparateWindow',
  multiGpu: 'screenShare.gameGuideAdviceMultiGpu',
  permissions: 'screenShare.gameGuideAdvicePermissions',
};

const normalizeSearch = (value: string): string => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function searchGameCaptureGuidance(query: string): readonly GameCaptureGuidance[] {
  if (!query.trim()) return GAME_CAPTURE_GUIDANCE;
  const needle = normalizeSearch(query);
  if (!needle) return [];
  return GAME_CAPTURE_GUIDANCE.filter(entry =>
    [entry.title, ...entry.aliases].some(name => normalizeSearch(name).includes(needle)));
}

export class GameCaptureGuideModal {
  private modalEl: HTMLElement | null = null;
  private eventController: AbortController | null = null;
  private parent: { element: HTMLElement; opener: HTMLButtonElement; wasInert: boolean } | null = null;
  private sourceOpening = false;

  public isOpen(): boolean { return this.modalEl !== null; }

  public open(opener: HTMLButtonElement, parent: HTMLElement): void {
    if (this.modalEl) {
      this.modalEl.querySelector<HTMLInputElement>('#game-capture-guide-search')?.focus();
      return;
    }
    if (!parent.isConnected || !opener.isConnected || opener.disabled || parent.inert) return;
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop game-capture-guide-backdrop';
    modal.innerHTML = `
      <div id="game-capture-guide" class="modal-card game-capture-guide-card" role="dialog" aria-modal="true"
        aria-labelledby="game-capture-guide-title" aria-describedby="game-capture-guide-intro">
        <div class="modal-header">
          <h2 id="game-capture-guide-title" class="modal-title">${escapeHtml(t('screenShare.gameGuideTitle'))}</h2>
          <button type="button" class="modal-close-btn" data-game-guide-close
            aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>
        <p id="game-capture-guide-intro" class="game-capture-guide-note">${escapeHtml(t('screenShare.gameGuideIntro'))}</p>
        <div class="game-capture-guide-search-field">
          <label for="game-capture-guide-search">${escapeHtml(t('screenShare.gameGuideSearch'))}</label>
          <input id="game-capture-guide-search" type="search" class="input-field" autocomplete="off" spellcheck="false"
            maxlength="120" aria-controls="game-capture-guide-results" placeholder="${escapeHtml(t('screenShare.gameGuideSearchPlaceholder'))}">
        </div>
        <div class="game-capture-guide-body">
          <p id="game-capture-guide-count" class="game-capture-guide-note" role="status" aria-live="polite" aria-atomic="true"></p>
          <div id="game-capture-guide-results"></div>
          <p class="game-capture-guide-note">${escapeHtml(t('screenShare.gameGuideFallback'))}</p>
        </div>
        <p id="game-capture-guide-link-error" class="game-capture-guide-error" role="alert" hidden></p>
        <div class="modal-footer">
          <a id="game-capture-guide-source" href="${GAME_CAPTURE_GUIDE_SOURCE}" rel="noopener noreferrer">
            ${escapeHtml(t('screenShare.gameGuideSource'))} · obsproject.com
          </a>
          <button type="button" id="game-capture-guide-close" class="btn btn-secondary" data-game-guide-close>${escapeHtml(t('common.close'))}</button>
        </div>
      </div>`;
    this.modalEl = modal;
    this.parent = { element: parent, opener, wasInert: parent.inert };
    this.eventController = new AbortController();
    const options = { signal: this.eventController.signal };
    const search = modal.querySelector<HTMLInputElement>('#game-capture-guide-search');
    search?.addEventListener('input', () => this.renderResults(modal, search.value), options);
    modal.querySelectorAll<HTMLButtonElement>('[data-game-guide-close]')
      .forEach(button => button.addEventListener('click', () => this.close(), options));
    modal.querySelector('#game-capture-guide-source')?.addEventListener('click', event => {
      event.preventDefault();
      void this.openSource(modal);
    }, options);
    modal.addEventListener('mousedown', event => {
      if (event.target === modal) this.close();
    }, options);
    modal.addEventListener('keydown', event => {
      if (event.defaultPrevented || [...document.querySelectorAll('.modal-backdrop')].at(-1) !== modal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll<HTMLElement>('button, input, a[href]')]
          .filter(control => !control.hasAttribute('disabled') && control.tabIndex >= 0 && control.checkVisibility());
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }, options);
    parent.inert = true;
    opener.setAttribute('aria-expanded', 'true');
    opener.setAttribute('aria-controls', 'game-capture-guide');
    document.body.appendChild(modal);
    this.renderResults(modal, '');
    search?.focus();
  }

  private renderResults(modal: HTMLElement, query: string): void {
    if (this.modalEl !== modal) return;
    const matches = searchGameCaptureGuidance(query);
    const count = modal.querySelector<HTMLElement>('#game-capture-guide-count');
    if (count) count.textContent = t('screenShare.gameGuideResultsCount', { count: matches.length });
    const results = modal.querySelector<HTMLElement>('#game-capture-guide-results');
    if (!results) return;
    results.innerHTML = matches.length ? (['normal', 'attention'] as const).map(group => {
      const entries = matches.filter(entry => (entry.advice === 'normal') === (group === 'normal'));
      if (!entries.length) return '';
      return `<section data-game-guide-group="${group}">
        <h3>${escapeHtml(t(group === 'normal' ? 'screenShare.gameGuideUseNormal' : 'screenShare.gameGuideAttention'))}</h3>
        <ul class="game-capture-guide-list">${entries.map(entry => `<li data-game-guide-entry="${entry.id}">
          <strong>${escapeHtml(entry.title)}</strong><p>${escapeHtml(t(ADVICE_KEYS[entry.advice]))}</p>
        </li>`).join('')}</ul>
      </section>`;
    }).join('') : `<p class="game-capture-guide-empty">${escapeHtml(t('screenShare.gameGuideNoResults'))}</p>`;
  }

  private async openSource(modal: HTMLElement): Promise<void> {
    if (this.modalEl !== modal || this.sourceOpening) return;
    this.sourceOpening = true;
    const link = modal.querySelector('#game-capture-guide-source');
    const failure = modal.querySelector<HTMLElement>('#game-capture-guide-link-error');
    if (failure) failure.hidden = true;
    link?.setAttribute('aria-busy', 'true');
    try {
      if (!window.api?.openExternal) throw new Error('External navigation bridge unavailable');
      const result = await window.api.openExternal(GAME_CAPTURE_GUIDE_SOURCE);
      if (!result.success) throw new Error('The official OBS guide was not opened');
    } catch (error: unknown) {
      console.warn('[GameCaptureGuide] Could not open the official source:', error);
      if (this.modalEl === modal && failure) {
        failure.textContent = t('screenShare.gameGuideSourceError');
        failure.hidden = false;
      }
    } finally {
      if (this.modalEl === modal) {
        this.sourceOpening = false;
        link?.removeAttribute('aria-busy');
      }
    }
  }

  public close(restoreFocus = true): void {
    this.eventController?.abort();
    this.eventController = null;
    this.modalEl?.querySelector('#game-capture-guide-source')?.removeAttribute('href');
    this.modalEl?.remove();
    this.modalEl = null;
    this.sourceOpening = false;
    const parent = this.parent;
    this.parent = null;
    if (!parent) return;
    parent.element.inert = parent.wasInert;
    parent.opener.setAttribute('aria-expanded', 'false');
    parent.opener.removeAttribute('aria-controls');
    if (restoreFocus && parent.element.isConnected && !parent.element.inert) {
      const target = parent.opener.isConnected && !parent.opener.disabled && parent.opener.checkVisibility()
        ? parent.opener : parent.element.querySelector<HTMLButtonElement>('button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
  }
}
