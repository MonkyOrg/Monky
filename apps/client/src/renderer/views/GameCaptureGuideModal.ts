import { t, type TranslationKey } from '../i18n';
import { html } from '../utils/html';
import { openExternalUrl } from '../utils/feedback';
import { openModal, type ModalShell } from '../utils/modalShell';

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


/** OBS's known Game Capture limitations, searchable while the picker waits underneath. */
export class GameCaptureGuideModal {
  private shell: ModalShell | null = null;
  private opener: HTMLButtonElement | null = null;
  private sourceOpening = false;

  public isOpen(): boolean { return this.shell !== null; }

  public open(opener: HTMLButtonElement, parent: HTMLElement): void {
    if (this.shell) {
      this.shell.card.querySelector<HTMLInputElement>('#game-capture-guide-search')?.focus();
      return;
    }
    if (!parent.isConnected || !opener.isConnected || opener.disabled || parent.inert) return;
    const shell = openModal({
      backdropClass: 'game-capture-guide-backdrop',
      card: html`
        <div id="game-capture-guide" class="modal-card game-capture-guide-card" role="dialog" aria-modal="true"
          aria-labelledby="game-capture-guide-title" aria-describedby="game-capture-guide-intro">
          <div class="modal-header">
            <h2 id="game-capture-guide-title" class="modal-title">${t('screenShare.gameGuideTitle')}</h2>
            <button type="button" class="modal-close-btn" data-modal-close aria-label="${t('common.close')}">&times;</button>
          </div>
          <p id="game-capture-guide-intro" class="game-capture-guide-note">${t('screenShare.gameGuideIntro')}</p>
          <div class="game-capture-guide-search-field">
            <label for="game-capture-guide-search">${t('screenShare.gameGuideSearch')}</label>
            <input id="game-capture-guide-search" type="search" class="input-field" autocomplete="off" spellcheck="false"
              maxlength="120" aria-controls="game-capture-guide-results" placeholder="${t('screenShare.gameGuideSearchPlaceholder')}">
          </div>
          <div class="game-capture-guide-body">
            <p id="game-capture-guide-count" class="game-capture-guide-note" role="status" aria-live="polite" aria-atomic="true"></p>
            <div id="game-capture-guide-results"></div>
            <p class="game-capture-guide-note">${t('screenShare.gameGuideFallback')}</p>
          </div>
          <div class="modal-footer">
            <a id="game-capture-guide-source" href="${GAME_CAPTURE_GUIDE_SOURCE}" rel="noopener noreferrer">
              ${t('screenShare.gameGuideSource')} · obsproject.com
            </a>
            <button type="button" id="game-capture-guide-close" class="btn btn-secondary" data-modal-close>${t('common.close')}</button>
          </div>
        </div>`,
      initialFocus: '#game-capture-guide-search',
      returnFocus: opener,
      onClose: () => this.teardown(shell),
    });
    this.shell = shell;
    this.opener = opener;
    const search = shell.card.querySelector<HTMLInputElement>('#game-capture-guide-search');
    search?.addEventListener('input', () => this.renderResults(shell, search.value), { signal: shell.signal });
    shell.card.querySelector('#game-capture-guide-source')?.addEventListener('click', event => {
      event.preventDefault();
      void this.openSource(shell);
    }, { signal: shell.signal });
    opener.setAttribute('aria-expanded', 'true');
    opener.setAttribute('aria-controls', 'game-capture-guide');
    this.renderResults(shell, '');
  }

  private renderResults(shell: ModalShell, query: string): void {
    if (this.shell !== shell) return;
    const matches = searchGameCaptureGuidance(query);
    const count = shell.card.querySelector<HTMLElement>('#game-capture-guide-count');
    if (count) count.textContent = t('screenShare.gameGuideResultsCount', { count: matches.length });
    const results = shell.card.querySelector<HTMLElement>('#game-capture-guide-results');
    if (!results) return;
    const groups = (['normal', 'attention'] as const).flatMap(group => {
      const entries = matches.filter(entry => (entry.advice === 'normal') === (group === 'normal'));
      return entries.length ? [html`<section data-game-guide-group="${group}">
        <h3>${t(group === 'normal' ? 'screenShare.gameGuideUseNormal' : 'screenShare.gameGuideAttention')}</h3>
        <ul class="game-capture-guide-list">${entries.map(entry => html`<li data-game-guide-entry="${entry.id}">
          <strong>${entry.title}</strong><p>${t(ADVICE_KEYS[entry.advice])}</p>
        </li>`)}</ul>
      </section>`] : [];
    });
    results.innerHTML = String(groups.length ? html`${groups}`
      : html`<p class="game-capture-guide-empty">${t('screenShare.gameGuideNoResults')}</p>`);
  }

  /** Opens the official guide through the bridge, with the trusted address rather than the link's. */
  private async openSource(shell: ModalShell): Promise<void> {
    if (this.shell !== shell || this.sourceOpening) return;
    this.sourceOpening = true;
    const link = shell.card.querySelector('#game-capture-guide-source');
    link?.setAttribute('aria-busy', 'true');
    try {
      await openExternalUrl(GAME_CAPTURE_GUIDE_SOURCE, t('screenShare.gameGuideSourceError'));
    } finally {
      if (this.shell === shell) {
        this.sourceOpening = false;
        link?.removeAttribute('aria-busy');
      }
    }
  }

  public close(): void {
    this.shell?.close('api');
  }

  private teardown(shell: ModalShell): void {
    if (this.shell !== shell) return;
    shell.card.querySelector('#game-capture-guide-source')?.removeAttribute('href');
    this.shell = null;
    this.sourceOpening = false;
    this.opener?.setAttribute('aria-expanded', 'false');
    this.opener?.removeAttribute('aria-controls');
    this.opener = null;
  }
}