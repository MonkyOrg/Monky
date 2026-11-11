import { MessageType, type OwnIdentitySession } from '@monky/shared';
import { sessionManager, type ServerSession } from '../core/SessionManager';
import { BoundRequests, SessionBinding } from '../core/sessionBinding';
import { connectionStore } from '../stores/connectionStore';
import { getLanguage, t } from '../i18n';
import { html } from '../utils/html';
import { openModal } from '../utils/modalShell';
import { preserveViewState } from '../utils/preserveViewState';
import { reportError } from '../utils/feedback';
import { showConfirm } from './Dialog';

interface ReachedDevice {
  id: string;
  current: boolean;
  connections: Array<{ server: ServerSession; session: OwnIdentitySession }>;
}

export function openOwnIdentitySessions(): void {
  const publicKey = connectionStore.publicKey;
  const requests = new Map<ServerSession, BoundRequests>();
  let devices: ReachedDevice[] = [];
  let consulted = 0;
  let generation = 0;
  let refreshing = false;
  let changing = false;
  let interval: ReturnType<typeof setInterval>;
  const shell = openModal({
    card: html`<div class="modal-card">
      <div class="modal-header"><h2 class="modal-title">${t('identity.sessionsTitle')}</h2><button type="button" class="btn btn-icon" data-modal-close aria-label="${t('common.close')}">×</button></div>
      <p>${t('identity.sessionsScope')}</p>
      <p data-session-coverage role="status"></p>
      <div data-identity-sessions aria-busy="true"></div>
      <div class="modal-footer"><button type="button" class="btn btn-secondary" data-refresh>${t('common.refresh')}</button></div>
    </div>`,
    onClose: () => { generation++; clearInterval(interval); requests.forEach(r => r.cancel()); },
  });
  const list = shell.card.querySelector<HTMLElement>('[data-identity-sessions]')!;
  const refreshButton = shell.card.querySelector<HTMLButtonElement>('[data-refresh]')!;
  const render = () => preserveViewState(list, () => {
    list.innerHTML = devices.map(device => html`<div class="settings-card" data-device="${device.id}" style="padding: 12px; margin: 8px 0; border: 1px solid var(--border-color); border-radius: var(--radius-md);">
      <strong>${t('identity.deviceLabel', { id: device.id.slice(0, 8) })}${device.current ? ` · ${t('identity.thisDevice')}` : ''}</strong>
      ${device.connections.map(({ server, session }) => html`<p>${server.serverStore.serverDetails?.name ?? server.host} · ${t('identity.connectedSince', { time: new Date(session.connectedAt).toLocaleString(getLanguage()) })}</p>`)}
      <button type="button" class="btn btn-secondary" data-disconnect-device="${device.id}">${t('identity.disconnectDevice')}</button>
    </div>`).join('') || html`<p>${t('identity.noSessions')}</p>`.toString();
    if (consulted === 0) list.textContent = t('identity.sessionsUnreachable');
  }, { itemKeys: ['data-device'], fallback: () => refreshButton });
  const refresh = async () => {
    if (shell.closed || refreshing || changing) return;
    if (publicKey !== connectionStore.publicKey) { shell.close('owner', true); return; }
    refreshing = true;
    refreshButton.disabled = true;
    list.setAttribute('aria-busy', 'true');
    const current = ++generation;
    const reached = sessionManager.getAll().filter(s => s.client.getStatus() === 'CONNECTED'
      && s.serverStore.currentUser?.publicKey === publicKey);
    const supported = reached.filter(s => s.serverStore.serverDetails?.protocol?.features.includes('identity-sessions'));
    const grouped = new Map<string, ReachedDevice>();
    let completed = 0;
    await Promise.all(supported.map(async server => {
      const binding = new SessionBinding(server.client, server.serverStore, () => sessionManager.get(server.key) === server);
      const pending = requests.get(server) ?? new BoundRequests(server.client);
      requests.set(server, pending);
      try {
        const result = await pending.send(id => server.client.sendRequest<{ sessions: OwnIdentitySession[] }>(MessageType.IDENTITY_SESSIONS_GET, {}, id));
        if (shell.closed || current !== generation || binding.failure()) return;
        completed++;
        for (const session of result.sessions) {
          const device = grouped.get(session.deviceId) ?? { id: session.deviceId, current: false, connections: [] };
          device.current ||= session.current;
          device.connections.push({ server, session });
          grouped.set(device.id, device);
        }
      } catch (error) {
        if (!shell.closed && current === generation && !binding.failure()) reportError(t('identity.sessionsFailed'), { log: 'CONNECTION', error });
      }
    }));
    if (!shell.closed && current === generation) {
      devices = [...grouped.values()];
      consulted = completed;
      render();
      shell.card.querySelector('[data-session-coverage]')!.textContent =
        t('identity.sessionsCoverage', { count: completed, unavailable: reached.length - completed });
      list.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
    refreshing = false;
  };
  refreshButton.addEventListener('click', () => { void refresh(); }, { signal: shell.signal });
  list.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-disconnect-device]') : null;
    const device = devices.find(d => d.id === button?.dataset.disconnectDevice);
    if (!button || !device || changing) return;
    void (async () => {
      changing = true;
      const confirmed = await showConfirm({ title: t('identity.disconnectDevice'),
        message: t('identity.disconnectScope', { count: device.connections.length }),
        variant: 'warning', focusCancel: true, signal: shell.signal });
      if (confirmed && !shell.closed && publicKey === connectionStore.publicKey) {
        for (const { server, session } of device.connections) {
          if (server.client.getStatus() !== 'CONNECTED' || server.serverStore.currentUser?.publicKey !== publicKey) continue;
          try {
            await requests.get(server)!.send(id => server.client.sendRequest(MessageType.IDENTITY_SESSION_DISCONNECT, { sessionId: session.sessionId }, id));
          } catch (error) {
            if (!shell.closed) reportError(t('identity.disconnectFailed'), { log: 'CONNECTION', error });
          }
        }
      }
      changing = false;
      await refresh();
    })();
  }, { signal: shell.signal });
  interval = setInterval(() => { void refresh(); }, 5000);
  void refresh();
}
