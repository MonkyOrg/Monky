import { t } from '../../i18n';
import { html } from '../../utils/html';
import { cancelCompactPageTransition, cancelSurfaceMotion, transitionCompactPage } from '../../utils/surfaceMotion';
import { revealWithin } from '../../utils/scroll';
import { COMPACT_VIEWPORT_QUERY } from '../../utils/viewport';

export interface CompactSettingsOptions {
  initialDetail?: boolean;
  onPageVisibilityChanged?: (visible: boolean) => void;
}

let nextIndexId = 0;

/** Mobile settings are a category index and a detail page, not a row of desktop tabs. */
export class CompactSettingsNavigation {
  private readonly compact = window.matchMedia(COMPACT_VIEWPORT_QUERY);
  private readonly lifetime = new AbortController();
  private readonly header = document.createElement('div');
  private readonly back = document.createElement('button');
  private readonly card: HTMLElement;
  private readonly main: HTMLElement;
  private readonly tabs: Array<{ button: HTMLButtonElement; tabIndex: string | null }>;
  private readonly labelledBy: string | null;
  public detail: boolean;

  constructor(
    root: HTMLElement,
    private readonly sidebar: HTMLElement,
    private readonly options: CompactSettingsOptions,
    private readonly onReveal: () => void,
  ) {
    this.card = sidebar.closest<HTMLElement>('.settings-modal-card')!;
    this.main = this.card.querySelector<HTMLElement>('.settings-main-container')!;
    this.labelledBy = this.card.getAttribute('aria-labelledby');
    this.detail = options.initialDetail ?? false;
    this.tabs = [...sidebar.querySelectorAll<HTMLButtonElement>('.settings-tab-btn')]
      .map(button => ({ button, tabIndex: button.getAttribute('tabindex') }));
    this.header.className = 'compact-settings-index-header';
    const id = `compact-settings-index-${++nextIndexId}`;
    const label = sidebar.querySelector('.settings-sidebar-title, .bot-settings-sidebar-title')?.textContent
      || t('connection.settingsTitle');
    this.header.innerHTML = String(html`<h2 id="${id}">${label}</h2>
      <button type="button" class="btn btn-icon" data-modal-close aria-label="${t('common.close')}">
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>`);
    this.back.type = 'button';
    this.back.className = 'btn btn-icon compact-settings-back';
    this.back.setAttribute('aria-label', t('common.back'));
    this.back.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>';
    this.card.prepend(this.header);
    this.main.querySelector('.settings-content-header')?.prepend(this.back);
    const { signal } = this.lifetime;
    this.back.addEventListener('click', () => this.goBack(), { signal });
    root.addEventListener('click', event => {
      const tab = event.target instanceof Element ? event.target.closest('.settings-tab-btn') : null;
      if (tab && sidebar.contains(tab) && this.compact.matches) {
        this.showDetail(true, tab.classList.contains('active'));
      }
    }, { capture: true, signal });
    root.addEventListener('keydown', event => {
      if (!this.compact.matches || this.detail || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const index = this.tabs.findIndex(({ button }) => button === event.target);
      if (index < 0) return;
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.tabs.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + this.tabs.length) % this.tabs.length;
      const target = this.tabs[next]?.button;
      if (target) {
        target.focus({ preventScroll: true });
        revealWithin(this.sidebar, target);
      }
    }, { capture: true, signal });
    this.compact.addEventListener('change', () => {
      cancelCompactPageTransition(this.card);
      this.apply();
      options.onPageVisibilityChanged?.(this.visible);
    }, { signal });
    this.apply();
  }

  public get visible(): boolean {
    return !this.compact.matches || this.detail;
  }

  private apply(): void {
    cancelSurfaceMotion(this.main);
    this.sidebar.hidden = this.compact.matches && this.detail;
    this.sidebar.inert = this.sidebar.hidden;
    this.main.hidden = !this.visible;
    this.main.inert = !this.visible;
    this.header.hidden = !this.compact.matches || this.detail;
    this.card.dataset.settingsScreen = this.detail ? 'detail' : 'index';
    const label = this.header.querySelector('h2')!.id;
    if (this.compact.matches && !this.detail) this.card.setAttribute('aria-labelledby', label);
    else if (this.labelledBy) this.card.setAttribute('aria-labelledby', this.labelledBy);
    this.tabs.forEach(({ button, tabIndex }) => {
      if (this.compact.matches) button.tabIndex = 0;
      else if (tabIndex === null) button.removeAttribute('tabindex');
      else button.setAttribute('tabindex', tabIndex);
    });
    if (this.compact.matches && document.activeElement instanceof HTMLElement && document.activeElement.closest('[inert]')) {
      (this.detail ? this.back : this.tabs.find(({ button }) => button.classList.contains('active'))?.button)
        ?.focus({ preventScroll: true });
    }
  }

  public showDetail(focus = false, notify = true): void {
    const changed = !this.detail;
    this.detail = true;
    if (changed && notify) this.options.onPageVisibilityChanged?.(this.visible);
    const reveal = () => {
      this.apply();
      this.onReveal();
      if (focus && this.compact.matches) this.back.focus({ preventScroll: true });
    };
    if (changed) transitionCompactPage(this.card, reveal, 1);
    else reveal();
  }

  public goBack(): boolean {
    if (!this.compact.matches || !this.detail || !this.tabs.length) return false;
    this.detail = false;
    this.options.onPageVisibilityChanged?.(false);
    transitionCompactPage(this.card, () => {
      this.apply();
      (this.tabs.find(({ button }) => button.classList.contains('active')) ?? this.tabs[0]).button.focus({ preventScroll: true });
    }, -1);
    return true;
  }

  public destroy(): void {
    cancelCompactPageTransition(this.card);
    this.lifetime.abort();
    cancelSurfaceMotion(this.main);
    cancelSurfaceMotion(this.sidebar);
    this.sidebar.hidden = this.sidebar.inert = this.main.hidden = this.main.inert = false;
    if (this.labelledBy) this.card.setAttribute('aria-labelledby', this.labelledBy);
    delete this.card.dataset.settingsScreen;
    this.header.remove();
    this.back.remove();
    this.tabs.forEach(({ button, tabIndex }) => {
      if (tabIndex === null) button.removeAttribute('tabindex');
      else button.setAttribute('tabindex', tabIndex);
    });
  }
}
