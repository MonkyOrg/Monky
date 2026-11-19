import { Permission } from '@monky/shared';
import { t } from '../../i18n';
import { html, trustedHtml, type SafeHtml } from '../../utils/html';
import { openModal } from '../../utils/modalShell';
import { errorMessage, reportError } from '../../utils/feedback';
import { withButtonLoading } from '../../utils/buttonLoading';
import { appEvents } from '../../core/EventBus';
import { sessionManager, type ServerSession } from '../../core/SessionManager';
import { channelPostBlocker, maxAttachmentBytes, sendToServerChannel, type ForwardItem } from '../../core/MessageForwarder';
import { showSuccessToast } from '../CopyToast';

const SERVER = 'data-send-logs-server';
const CHANNEL = 'data-send-logs-channel';

interface Option {
  value: string;
  label: string;
  detail?: string;
  icon: string;
  blocker?: string | null;
}

function connectedSessions(): ServerSession[] {
  return sessionManager.getAll().filter(session => session.client.getStatus() === 'CONNECTED' && session.serverStore.serverDetails);
}

function serverName(session: ServerSession): string {
  return session.serverStore.serverDetails?.name ?? session.host;
}

/** Text channels the user can read; the ones that refuse files stay listed with the reason. */
function textChannels(session: ServerSession): Option[] {
  const server = session.serverStore;
  return (server.serverDetails?.channels ?? [])
    .filter(channel => channel.type === 'TEXT' && !channel.forumId && server.hasPermission(Permission.READ_MESSAGES, channel.id))
    .map(channel => ({ value: channel.id, label: channel.name, icon: 'tag', blocker: channelPostBlocker(server, channel.id, true) }));
}

function renderOptions(attribute: typeof SERVER | typeof CHANNEL, label: string, options: readonly Option[], selected: string | null): SafeHtml {
  const name = trustedHtml(attribute);
  return html`<div class="forward-destinations" role="group" aria-label="${label}">${options.map(option => html`
    <button type="button" class="forward-destination" ${name}="${option.value}" aria-pressed="${option.value === selected}"
      aria-disabled="${!!option.blocker}"${option.blocker ? html` title="${option.blocker}"` : null}>
      <span class="material-symbols-outlined md-20 forward-destination-icon" aria-hidden="true">${option.icon}</span>
      <span class="forward-destination-copy"><strong>${option.label}</strong>${
        option.blocker || option.detail ? html`<small>${option.blocker ?? option.detail ?? ''}</small>` : null}</span>
      <span class="material-symbols-outlined md-20 forward-destination-check" aria-hidden="true">check_circle</span>
    </button>`)}</div>`;
}

function markSelected(group: HTMLElement, attribute: typeof SERVER | typeof CHANNEL, value: string | null): void {
  group.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach(option => {
    option.setAttribute('aria-pressed', String(option.getAttribute(attribute) === value));
  });
}

/**
 * Picks a text channel of any connected server and posts the client logs there
 * as a text file. Only the newest logs that fit the server's file limit go.
 */
export function openSendLogsModal(owner: AbortSignal): void {
  let busy = false;
  let serverKey: string | null = null;
  let channelId: string | null = null;
  const modal = openModal({
    signal: owner,
    canClose: () => !busy,
    card: html`<div class="modal-card send-logs-modal">
      <div class="modal-header"><h2>${t('settings.logsSendTitle')}</h2></div>
      <div class="modal-body">
        <p class="send-logs-description">${t('settings.logsSendDesc')}</p>
        <div class="forward-lists">
          <section class="forward-section"><h3 class="forward-section-heading">${t('settings.logsSendServer')}</h3>
            <div data-send-logs-servers></div></section>
          <section class="forward-section"><h3 class="forward-section-heading">${t('settings.logsSendChannel')}</h3>
            <div data-send-logs-channels></div></section>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
        <button type="button" class="btn btn-primary" data-send-logs-confirm disabled>${t('settings.logsSendAction')}</button>
      </div></div>`,
  });
  const servers = modal.card.querySelector<HTMLElement>('[data-send-logs-servers]');
  const channels = modal.card.querySelector<HTMLElement>('[data-send-logs-channels]');
  const confirm = modal.card.querySelector<HTMLButtonElement>('[data-send-logs-confirm]');
  if (!servers || !channels || !confirm) return;

  const selectedSession = (): ServerSession | undefined => connectedSessions().find(session => session.key === serverKey);
  const syncConfirm = (): void => { confirm.disabled = busy || !selectedSession() || !channelId; };

  const renderChannels = (): void => {
    const session = selectedSession();
    const options = session ? textChannels(session) : [];
    if (!options.some(option => option.value === channelId && !option.blocker)) channelId = null;
    channels.innerHTML = (options.length
      ? renderOptions(CHANNEL, t('settings.logsSendChannel'), options, channelId)
      : html`<p class="forward-empty">${t(session ? 'settings.logsSendNoChannels' : 'settings.logsSendNoServers')}</p>`).toString();
    syncConfirm();
  };

  const renderServers = (): void => {
    const sessions = connectedSessions();
    if (!sessions.some(session => session.key === serverKey)) {
      const active = sessionManager.getActive();
      serverKey = (sessions.find(session => session.key === active?.key) ?? sessions[0])?.key ?? null;
    }
    servers.innerHTML = (sessions.length
      ? renderOptions(SERVER, t('settings.logsSendServer'), sessions.map(session => ({
        value: session.key, label: serverName(session), detail: `${session.host}:${session.port}`, icon: 'dns',
      })), serverKey)
      : html`<p class="forward-empty">${t('settings.logsSendNoServers')}</p>`).toString();
    renderChannels();
  };

  modal.card.addEventListener('click', event => {
    const option = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.forward-destination') : null;
    if (!option || busy || option.getAttribute('aria-disabled') === 'true') return;
    const server = option.getAttribute(SERVER);
    const channel = option.getAttribute(CHANNEL);
    if (server && server !== serverKey) {
      serverKey = server;
      channelId = null;
      markSelected(servers, SERVER, serverKey);
      renderChannels();
    } else if (channel) {
      channelId = channel;
      markSelected(channels, CHANNEL, channelId);
      syncConfirm();
    }
  }, { signal: modal.signal });

  const unsubscribe = appEvents.on('session.connections_changed', () => { if (!busy) renderServers(); });
  modal.signal.addEventListener('abort', unsubscribe, { once: true });

  confirm.addEventListener('click', () => {
    const session = selectedSession();
    const target = channelId;
    if (busy || !target) return;
    if (!session) {
      reportError(t('settings.logsSendServerGone'));
      renderServers();
      return;
    }
    busy = true;
    syncConfirm();
    void withButtonLoading(confirm, async () => {
      let sent = false;
      try {
        await sendLogs(session, target);
        sent = true;
      } catch (error) {
        reportError(errorMessage(error, t('settings.logsSendFailed')), { log: 'UI', error });
      }
      busy = false;
      if (sent) modal.close();
      else if (!modal.signal.aborted) renderServers();
    });
  }, { signal: modal.signal });

  renderServers();
}

async function sendLogs(session: ServerSession, channelId: string): Promise<void> {
  const bundle = await window.api.bundleClientLogs(maxAttachmentBytes(session.serverStore));
  if (!bundle.success) throw new Error(t(bundle.error === 'no-logs' ? 'settings.logsEmpty' : 'settings.logsSendFailed'));
  const file = new Blob([bundle.content], { type: 'text/plain' });
  const item: ForwardItem = {
    content: bundle.truncated ? t('settings.logsSendTruncated') : '',
    attachments: [{ name: bundle.fileName, mime: 'text/plain', size: file.size, load: async () => file }],
    sourceLabel: null,
    createdAt: Date.now(),
  };
  const result = await sendToServerChannel([item], channelId, session);
  if (result.error) throw new Error(result.error);
  const channel = session.serverStore.serverDetails?.channels.find(candidate => candidate.id === channelId)?.name ?? '';
  showSuccessToast(t('settings.logsSendSuccess', { channel, server: serverName(session) }));
}
