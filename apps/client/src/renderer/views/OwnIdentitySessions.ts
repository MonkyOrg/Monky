import { MessageType, type OwnIdentitySession } from '@monky/shared';
import { sessionManager, type ServerSession } from '../core/SessionManager';
import { BoundRequests, SessionBinding } from '../core/sessionBinding';
import { connectionStore } from '../stores/connectionStore';
import { getLanguage, t } from '../i18n';
import { html, trustedHtml } from '../utils/html';
import { preserveViewState } from '../utils/preserveViewState';
import { reportError } from '../utils/feedback';
import { renderLoadingIndicator } from '../utils/loadingIndicator';
import { cancelVisibilityMotion, setSurfaceVisible } from '../utils/surfaceVisibility';
import { setButtonLoading } from '../utils/buttonLoading';
import '../styles/identitySessions.css';

interface ReachedDevice {
  id: string;
  current: boolean;
  connections: Array<{ server: ServerSession; session: OwnIdentitySession }>;
}

export function renderOwnIdentitySessions(): string {
  if (!connectionStore.hasIdentity || connectionStore.guest) return '';
  return String(html`<section class="form-group identity-sessions" data-settings-section="identity-sessions"
    data-settings-label="${t('identity.sessionsTitle')}" aria-labelledby="identity-sessions-title">
    <div class="identity-sessions-header">
      <h3 id="identity-sessions-title" tabindex="-1"><span class="material-symbols-outlined md-18" aria-hidden="true">devices</span>${t('identity.sessionsTitle')}</h3>
      <button type="button" class="btn btn-secondary" data-refresh>
        <span class="material-symbols-outlined md-16" aria-hidden="true">refresh</span>${t('common.refresh')}
      </button>
    </div>
    <p class="identity-sessions-description">${t('identity.sessionsScope')}</p>
    <p class="identity-sessions-coverage" data-session-coverage role="status">${t('common.loading')}</p>
    <div class="identity-sessions-list" data-identity-sessions aria-busy="true">${trustedHtml(renderLoadingIndicator(t('common.loading')))}</div>
  </section>`);
}

export function mountOwnIdentitySessions(root: HTMLElement): () => void {
  const section = root.querySelector<HTMLElement>('[data-settings-section="identity-sessions"]');
  if (!section) return () => {};
  const publicKey = connectionStore.publicKey;
  const controller = new AbortController();
  const requests = new Map<ServerSession, BoundRequests>();
  let devices: ReachedDevice[] = [];
  let consulted = 0;
  let generation = 0;
  let refreshing = false;
  let changing = false;
  let confirmation: { device: ReachedDevice; button: HTMLButtonElement; panel: HTMLElement } | null = null;
  let submitting = false;
  let renderedContent = '';
  let interval: ReturnType<typeof setInterval> | undefined;
  const dispose = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    generation++;
    clearInterval(interval);
    requests.forEach(r => r.cancel());
    list.querySelectorAll<HTMLElement>('[data-device-confirmation]').forEach(cancelVisibilityMotion);
    confirmation = null;
    list.replaceChildren();
  };
  const current = () => {
    if (controller.signal.aborted) return false;
    if (!section.isConnected || !connectionStore.hasIdentity || connectionStore.guest || publicKey !== connectionStore.publicKey) {
      dispose();
      section.remove();
      return false;
    }
    return true;
  };
  const list = section.querySelector<HTMLElement>('[data-identity-sessions]')!;
  const refreshButton = section.querySelector<HTMLButtonElement>('[data-refresh]')!;
  const render = () => preserveViewState(list, () => {
    const content = consulted === 0
      ? String(html`<p class="identity-sessions-empty">${t('identity.sessionsUnreachable')}</p>`)
      : devices.map(device => html`<article class="identity-session-card" data-device="${device.id}">
      <span class="identity-session-icon material-symbols-outlined" aria-hidden="true">devices</span>
      <div class="identity-session-details">
        <div class="identity-session-heading"><strong>${t('identity.deviceLabel', { id: device.id.slice(0, 8) })}</strong>
          ${device.current ? html`<span class="identity-session-current">${t('identity.thisDevice')}</span>` : ''}
        </div>
        ${device.connections.map(({ server, session }) => html`<p class="identity-session-connection"><span>${server.serverStore.serverDetails?.name ?? server.host}</span>
          <span>${t('identity.connectedSince', { time: new Date(session.connectedAt).toLocaleString(getLanguage()) })}</span></p>`)}
      </div>
      <button type="button" class="btn btn-danger" data-disconnect-device="${device.id}"
        aria-expanded="false" aria-controls="identity-device-confirm-${device.id}">${t('identity.disconnectDevice')}</button>
      <div class="identity-session-confirmation" id="identity-device-confirm-${device.id}" data-device-confirmation hidden
        role="group" aria-label="${t('identity.disconnectDevice')}">
        <p>${t('identity.disconnectScope', { count: device.connections.length })}</p>
        <div class="identity-session-confirmation-actions">
          <button type="button" class="btn btn-secondary" data-cancel-disconnect>${t('common.cancel')}</button>
          <button type="button" class="btn btn-danger" data-confirm-disconnect>${t('identity.disconnectDevice')}</button>
        </div>
      </div>
    </article>`).join('') || html`<p class="identity-sessions-empty">${t('identity.noSessions')}</p>`.toString();
    if (renderedContent !== content) {
      list.querySelectorAll<HTMLElement>('[data-device-confirmation]').forEach(cancelVisibilityMotion);
      list.innerHTML = content;
      renderedContent = content;
    }
  }, { itemKeys: ['data-device'], fallback: () => refreshButton });
  const refresh = async () => {
    if (!current() || refreshing || changing) return;
    refreshing = true;
    refreshButton.disabled = true;
    list.setAttribute('aria-busy', 'true');
    const sequence = ++generation;
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
        if (!current() || sequence !== generation || binding.failure()) return;
        completed++;
        for (const session of result.sessions) {
          const device = grouped.get(session.deviceId) ?? { id: session.deviceId, current: false, connections: [] };
          device.current ||= session.current;
          device.connections.push({ server, session });
          grouped.set(device.id, device);
        }
      } catch (error) {
        if (current() && sequence === generation && !binding.failure()) reportError(t('identity.sessionsFailed'), { log: 'CONNECTION', error });
      }
    }));
    if (current() && sequence === generation && !changing) {
      devices = [...grouped.values()];
      consulted = completed;
      refreshButton.disabled = false;
      render();
      section.querySelector('[data-session-coverage]')!.textContent =
        t('identity.sessionsCoverage', { count: completed, unavailable: reached.length - completed });
      list.setAttribute('aria-busy', 'false');
    }
    if (current()) list.setAttribute('aria-busy', 'false');
    refreshing = false;
  };
  const closeConfirmation = () => {
    if (!confirmation || submitting) return;
    const { button, panel } = confirmation;
    confirmation = null;
    changing = false;
    button.setAttribute('aria-expanded', 'false');
    setSurfaceVisible(panel, false);
    refreshButton.disabled = refreshing;
    if (button.isConnected) button.focus({ preventScroll: true });
  };
  refreshButton.addEventListener('click', () => { void refresh(); }, { signal: controller.signal });
  list.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!target || !current() || submitting) return;
    if (target.hasAttribute('data-cancel-disconnect') && confirmation?.panel.contains(target)) {
      closeConfirmation();
      return;
    }
    if (target.hasAttribute('data-confirm-disconnect') && confirmation?.panel.contains(target)) {
      const pending = confirmation;
      submitting = true;
      setButtonLoading(target, true);
      pending.panel.querySelector<HTMLButtonElement>('[data-cancel-disconnect]')!.disabled = true;
      list.setAttribute('aria-busy', 'true');
      void (async () => {
        for (const { server, session } of pending.device.connections) {
          if (!current()) break;
          if (sessionManager.get(server.key) !== server || server.client.getStatus() !== 'CONNECTED'
            || server.serverStore.currentUser?.publicKey !== publicKey) continue;
          try {
            await requests.get(server)!.send(id => server.client.sendRequest(MessageType.IDENTITY_SESSION_DISCONNECT, { sessionId: session.sessionId }, id));
          } catch (error) {
            if (current()) reportError(t('identity.disconnectFailed'), { log: 'CONNECTION', error });
          }
        }
        submitting = false;
        if (!current()) return;
        setButtonLoading(target, false);
        pending.panel.querySelector<HTMLButtonElement>('[data-cancel-disconnect]')!.disabled = false;
        closeConfirmation();
        await refresh();
      })();
      return;
    }
    const button = target.hasAttribute('data-disconnect-device') ? target : null;
    const device = devices.find(d => d.id === button?.dataset.disconnectDevice);
    if (!button || !device || !current() || changing) return;
    const panel = button.closest('[data-device]')!.querySelector<HTMLElement>('[data-device-confirmation]')!;
    confirmation = { device, button, panel };
    changing = true;
    refreshButton.disabled = true;
    button.setAttribute('aria-expanded', 'true');
    setSurfaceVisible(panel, true);
    panel.querySelector<HTMLButtonElement>('[data-cancel-disconnect]')!.focus({ preventScroll: true });
  }, { signal: controller.signal });
  interval = setInterval(() => { void refresh(); }, 5000);
  void refresh();
  return dispose;
}
