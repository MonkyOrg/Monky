import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import '../styles/serverAutoEntry.css';

export function renderServerAutoEntryToggle(enabled: boolean): string {
  const label = escapeHtml(t('autoEntry.label'));
  return `<label class="server-auto-entry-control" title="${escapeHtml(t('autoEntry.description'))}">
    <span class="server-auto-entry-caption">${label}</span>
    <span class="toggle-switch">
      <input id="join-auto-entry" type="checkbox" role="switch" data-server-auto-entry
        aria-label="${label}" ${enabled ? 'checked' : ''}>
      <span class="toggle-slider" aria-hidden="true"></span>
    </span>
  </label>`;
}
