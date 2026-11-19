import { Permission } from '@monky/shared';
import { t } from '../../i18n';
import { html } from '../../utils/html';
import { openModal } from '../../utils/modalShell';
import { errorMessage, reportError } from '../../utils/feedback';
import { withButtonLoading } from '../../utils/buttonLoading';
import { appEvents } from '../../core/EventBus';
import { sessionManager, type ServerSession } from '../../core/SessionManager';
import { channelPostBlocker, maxAttachmentBytes, sendToServerChannel, type ForwardItem } from '../../core/MessageForwarder';
import { showSuccessToast } from '../CopyToast';

function connectedSessions(): ServerSession[] {
  return sessionManager.getAll().filter(session => session.client.getStatus() === 'CONNECTED' && session.serverStore.serverDetails);
}

function serverName(session: ServerSession): string {
  return session.serverStore.serverDetails?.name ?? session.host;
}

function option(label: string, value: string, icon: string | null, searchTerms = ''): HTMLOptionElement {
  const element = new Option(label, value);
  if (icon) element.dataset.icon = icon;
  if (searchTerms) element.dataset.searchTerms = searchTerms;
  return element;
}

/** Shown while nothing is chosen; when the list is empty it explains why instead. */
function placeholder(label: string, hasChoices: boolean): HTMLOptionElement {
  const element = option(label, '', null);
  element.disabled = true;
  element.hidden = hasChoices;
  return element;
}

/** Text channels the user can read; the ones that refuse files stay listed, disabled, with the reason. */
function textChannels(session: ServerSession): HTMLOptionElement[] {
  const server = session.serverStore;
  return (server.serverDetails?.channels ?? [])
    .filter(channel => channel.type === 'TEXT' && !channel.forumId && server.hasPermission(Permission.READ_MESSAGES, channel.id))
    .map(channel => {
      const blocker = channelPostBlocker(server, channel.id, true);
      if (!blocker) return option(channel.name, channel.id, 'tag');
      const element = option(t('settings.logsSendChannelBlocked', { channel: channel.name, reason: blocker }), channel.id, 'tag', blocker);
      element.disabled = true;
      return element;
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
        <fieldset class="send-logs-fields" data-send-logs-fields>
          <div class="form-group"><label for="send-logs-server">${t('settings.logsSendServer')}</label>
            <select id="send-logs-server" class="input-field" data-send-logs-server
              data-search-placeholder="${t('settings.logsSendServerSearch')}" data-empty-label="${t('settings.logsSendServerNoResults')}"></select></div>
          <div class="form-group"><label for="send-logs-channel">${t('settings.logsSendChannel')}</label>
            <select id="send-logs-channel" class="input-field" data-send-logs-channel
              data-search-placeholder="${t('settings.logsSendChannelSearch')}" data-empty-label="${t('settings.logsSendChannelNoResults')}"></select></div>
        </fieldset>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
        <button type="button" class="btn btn-primary" data-send-logs-confirm disabled>${t('settings.logsSendAction')}</button>
      </div></div>`,
  });
  const fields = modal.card.querySelector<HTMLFieldSetElement>('[data-send-logs-fields]');
  const servers = modal.card.querySelector<HTMLSelectElement>('[data-send-logs-server]');
  const channels = modal.card.querySelector<HTMLSelectElement>('[data-send-logs-channel]');
  const confirm = modal.card.querySelector<HTMLButtonElement>('[data-send-logs-confirm]');
  if (!fields || !servers || !channels || !confirm) return;

  const selectedSession = (): ServerSession | undefined => connectedSessions().find(session => session.key === serverKey);
  const syncConfirm = (): void => {
    fields.disabled = busy;
    confirm.disabled = busy || !selectedSession() || !channelId;
  };

  // Only the options are replaced, so an open search popup keeps its filter and the choice survives.
  const syncChannels = (): void => {
    const session = selectedSession();
    const options = session ? textChannels(session) : [];
    if (!options.some(item => item.value === channelId && !item.disabled)) channelId = null;
    const empty = t(!session ? 'settings.logsSendNoServers' : options.length ? 'settings.logsSendChannelPlaceholder' : 'settings.logsSendNoChannels');
    channels.replaceChildren(placeholder(empty, options.length > 0), ...options);
    channels.value = channelId ?? '';
    channels.disabled = !options.length;
    syncConfirm();
  };

  const syncServers = (): void => {
    const sessions = connectedSessions();
    if (!sessions.some(session => session.key === serverKey)) {
      const active = sessionManager.getActive();
      serverKey = (sessions.find(session => session.key === active?.key) ?? sessions[0])?.key ?? null;
      channelId = null;
    }
    servers.replaceChildren(...(sessions.length
      ? sessions.map(session => option(serverName(session), session.key, 'dns', `${session.host}:${session.port}`))
      : [placeholder(t('settings.logsSendNoServers'), false)]));
    servers.value = serverKey ?? '';
    servers.disabled = !sessions.length;
    syncChannels();
  };

  servers.addEventListener('change', () => {
    if (busy || servers.value === serverKey) return;
    serverKey = servers.value;
    channelId = null;
    syncChannels();
  }, { signal: modal.signal });

  channels.addEventListener('change', () => {
    if (busy) return;
    channelId = channels.value || null;
    syncConfirm();
  }, { signal: modal.signal });

  const unsubscribe = appEvents.on('session.connections_changed', () => { if (!busy) syncServers(); });
  modal.signal.addEventListener('abort', unsubscribe, { once: true });

  confirm.addEventListener('click', () => {
    const session = selectedSession();
    const target = channelId;
    if (busy || !target) return;
    if (!session) {
      reportError(t('settings.logsSendServerGone'));
      syncServers();
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
      else if (!modal.signal.aborted) syncServers();
    });
  }, { signal: modal.signal });

  syncServers();
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
