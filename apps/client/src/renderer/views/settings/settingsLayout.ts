import { t, type TranslationKey } from '../../i18n';
import { html, type SafeHtml } from '../../utils/html';

/** One entry of a settings sidebar: the app's settings and a server's settings declare theirs once, as a table. */
export interface SettingsTabEntry {
  id: string;
  icon: string;
  label: TranslationKey;
  /** A divider goes above it in the sidebar. */
  separated?: boolean;
}

/** The icon and the name of a tab, for its sidebar button and for the title above its panel. */
export function renderSettingsTabLabel(tab: SettingsTabEntry): SafeHtml {
  return html`<span class="material-symbols-outlined md-18" aria-hidden="true">${tab.icon}</span><span>${t(tab.label)}</span>`;
}

/** The sidebar's heading and its tab buttons; `active` is the tab shown first. */
export function renderSettingsTabButtons(tabs: readonly SettingsTabEntry[], active: string): SafeHtml {
  return html`<div class="settings-sidebar-title">${t('connection.settingsTitle')}</div>
    ${tabs.map(tab => html`${tab.separated ? html`<div class="settings-sidebar-divider" role="separator"></div>` : null}
      <button type="button" class="settings-tab-btn${tab.id === active ? ' active' : ''}" data-tab="${tab.id}"
        ${tab.id === active ? html`aria-current="page"` : null}>${renderSettingsTabLabel(tab)}</button>`)}`;
}

/** Marks the tab shown now in the sidebar and returns its button. */
export function selectSettingsTab(root: ParentNode, id: string): HTMLButtonElement | null {
  let selected: HTMLButtonElement | null = null;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.settings-tab-btn[data-tab]')) {
    const active = button.dataset.tab === id;
    button.classList.toggle('active', active);
    if (active) {
      button.setAttribute('aria-current', 'page');
      selected = button;
    } else button.removeAttribute('aria-current');
  }
  return selected;
}
