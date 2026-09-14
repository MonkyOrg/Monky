import { appEvents } from '../core/EventBus';
import { clientLog } from '../core/ClientLogService';
import { getLanguage, t } from '../i18n';
import { connectionStore, type SavedServer } from '../stores/connectionStore';
import { settingsStore } from '../stores/settingsStore';
import { autoEntryServerKey } from '../utils/autoEntry';
import { escapeHtml } from '../utils/html';
import '../styles/serverAutoEntry.css';

export function renderServerAutoEntryToggle(server: SavedServer): string {
  const key = autoEntryServerKey(server);
  const label = escapeHtml(t('autoEntry.serverLabel', { name: server.name || server.host }));
  const enabled = settingsStore.isServerAutoEntryEnabled(server);
  const title = !server.serverId ? escapeHtml(t('autoEntry.verifyServer', { name: server.name || server.host })) : label;
  return `<label class="server-auto-entry-control" title="${title}">
    <span class="server-auto-entry-caption">${escapeHtml(t('autoEntry.label'))}</span>
    <span class="toggle-switch">
      <input type="checkbox" role="switch" data-server-auto-entry="${escapeHtml(key ?? '')}"
        aria-label="${label}" ${enabled ? 'checked' : ''} ${key && (server.serverId || enabled) ? '' : 'disabled'}>
      <span class="toggle-slider" aria-hidden="true"></span>
    </span>
  </label>`;
}

export function renderAutoEntryServerList(): string {
  const servers = [...connectionStore.savedServers].sort((a, b) =>
    (a.name || a.host).localeCompare(b.name || b.host, getLanguage()));
  if (!servers.length) return `<p class="server-auto-entry-description">${escapeHtml(t('autoEntry.empty'))}</p>`;
  return servers.map(server => `<div class="server-auto-entry-settings-row">
    <div class="server-auto-entry-address">
      <strong>${escapeHtml(server.name || server.host)}</strong>
      <span>${escapeHtml(server.host)}:${server.port}</span>
    </div>
    ${renderServerAutoEntryToggle(server)}
  </div>`).join('');
}

export function renderAutoEntrySettings(): string {
  return `<section data-settings-section="automatic-entry" data-settings-label="${escapeHtml(t('autoEntry.section'))}"
      class="server-auto-entry-settings form-group">
    <h3>${escapeHtml(t('autoEntry.section'))}</h3>
    <p class="server-auto-entry-description">${escapeHtml(t('autoEntry.description'))}</p>
    <div data-auto-entry-server-list>${renderAutoEntryServerList()}</div>
  </section>`;
}

export function bindServerAutoEntryControls(
  container: HTMLElement,
  showError: (message: string) => void,
): () => void {
  const sync = () => {
    for (const input of container.querySelectorAll<HTMLInputElement>('[data-server-auto-entry]')) {
      const server = connectionStore.savedServers.find(item => autoEntryServerKey(item) === input.dataset.serverAutoEntry);
      input.checked = !!server && settingsStore.isServerAutoEntryEnabled(server);
      input.disabled = !server || (!server.serverId && !input.checked);
      if (server) {
        const label = input.closest('label');
        if (label) label.title = t(server.serverId ? 'autoEntry.serverLabel' : 'autoEntry.verifyServer', {
          name: server.name || server.host,
        });
      }
    }
  };
  const change = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-server-auto-entry')) return;
    const server = connectionStore.savedServers.find(item => autoEntryServerKey(item) === input.dataset.serverAutoEntry);
    if (!server) { sync(); return; }
    if (input.checked && !server.serverId) {
      sync();
      showError(t('autoEntry.verifyServer', { name: server.name || server.host }));
      return;
    }
    try {
      settingsStore.setServerAutoEntry(server, input.checked);
    } catch (error: unknown) {
      sync();
      clientLog.warn('STORE', 'Could not save automatic server entry', {
        error: error instanceof Error ? error.message : String(error),
      });
      showError(t('autoEntry.saveFailed'));
    }
  };
  const savedServersChanged = () => {
    const list = container.querySelector<HTMLElement>('[data-auto-entry-server-list]');
    if (list) list.innerHTML = renderAutoEntryServerList();
    sync();
  };
  container.addEventListener('change', change);
  const offSettings = appEvents.on('settings.updated', sync);
  const offServers = appEvents.on('connection.saved_servers_changed', savedServersChanged);
  return () => {
    container.removeEventListener('change', change);
    offSettings();
    offServers();
  };
}
