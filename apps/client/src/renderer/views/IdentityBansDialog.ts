import { MessageType, identityBanHistoryPageSchema, type IdentityBanHistoryEntry, type IdentityBanSummary } from '@monky/shared';
import { getActiveNetworkClient } from '../core/NetworkClient';
import { BoundRequests, SessionBinding } from '../core/sessionBinding';
import { getActiveServerStore } from '../stores/serverStore';
import { getLanguage, t } from '../i18n';
import { html } from '../utils/html';
import { bindIdentityBanAccess, canManageIdentityBans } from '../utils/identityBan';
import { openModal } from '../utils/modalShell';
import { preserveViewState } from '../utils/preserveViewState';
import { renderChoiceCards, selectChoiceCard } from '../utils/formControls';
import { reportError } from '../utils/feedback';
import { showConfirm } from './Dialog';
import '../styles/identityBan.css';

interface ListedBan { ban: IdentityBanSummary; history?: IdentityBanHistoryEntry }
const rowKey = (row: ListedBan) => row.history ? String(row.history.id) : row.ban.publicKey;

export function openIdentityBansDialog(): void {
  const client = getActiveNetworkClient();
  const store = getActiveServerStore();
  if (!canManageIdentityBans(store)) { reportError(t('identity.banUnavailable')); return; }
  const binding = new SessionBinding(client, store, () => getActiveServerStore() === store);
  const requests = new BoundRequests(client);
  const supportsHistory = store.serverDetails?.protocol?.features.includes('identity-ban-history') === true;
  let scope: 'active' | 'all' = 'active';
  let busy = false;
  let rows: ListedBan[] = [];
  let nextCursor: number | null = null;
  const shell = openModal({ closeWithSession: true, onClose: () => requests.cancel(),
    card: html`<div class="modal-card identity-bans-card">
      <div class="modal-header"><h2 class="modal-title">${t('identity.bansTitle')}</h2>
        <button type="button" class="btn btn-icon" data-modal-close aria-label="${t('common.close')}">×</button></div>
      <p class="identity-bans-hint">${t('identity.banHistoryHint')}</p>
      ${renderChoiceCards({ id: 'identity-bans-scope', label: t('identity.bansTitle'), attribute: 'data-bans-scope',
        selected: 'active', choices: [
          { value: 'active', title: t('identity.bansActive'), description: t('identity.bansActiveDescription') },
          { value: 'all', title: t('identity.bansHistory'), description: t('identity.bansHistoryDescription') },
        ] })}
      <div data-bans aria-busy="true"></div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-load-more hidden>${t('identity.bansLoadMore')}</button>
        <button type="button" class="btn btn-secondary" data-refresh>${t('common.refresh')}</button>
      </div></div>` });
  const current = bindIdentityBanAccess(shell, binding, store);
  const list = shell.card.querySelector<HTMLElement>('[data-bans]')!;
  const refreshButton = shell.card.querySelector<HTMLButtonElement>('[data-refresh]')!;
  const moreButton = shell.card.querySelector<HTMLButtonElement>('[data-load-more]')!;
  shell.card.querySelector('[data-bans-scope="all"]')!.setAttribute('aria-disabled', String(!supportsHistory));
  const time = (value: number) => new Date(value).toLocaleString(getLanguage());
  const updateControls = () => {
    refreshButton.disabled = busy;
    moreButton.disabled = busy;
    moreButton.hidden = nextCursor === null;
    shell.card.querySelectorAll<HTMLButtonElement>('[data-bans-scope]').forEach(button => { button.disabled = busy; });
    list.querySelectorAll<HTMLButtonElement>('[data-unban]').forEach(button => { button.disabled = busy; });
    list.setAttribute('aria-busy', String(busy));
  };
  const render = () => preserveViewState(list, () => {
    list.innerHTML = rows.map(row => {
      const { ban, history } = row;
      const status = history?.status ?? 'active';
      return html`<article class="identity-ban-record" data-ban-key="${rowKey(row)}">
        <div class="identity-ban-record-header"><strong>${ban.nickname}</strong>
          <span class="identity-ban-status" data-ban-status="${status}">${t(`identity.banStatus.${status}`)}</span></div>
        <p>${ban.expiresAt === null ? t('identity.banPermanent') : t('identity.banUntil', { time: time(ban.expiresAt) })}</p>
        <dl class="identity-ban-details">
          <div><dt>${t('identity.banCreatedAt')}</dt><dd>${time(ban.createdAt)}</dd></div>
          <div><dt>${t('identity.banCreatedBy')}</dt><dd>${history?.createdBy?.nickname ?? t('identity.banUnknownModerator')}</dd></div>
          ${history?.endedAt !== null && history?.endedAt !== undefined ? html`
            <div><dt>${t('identity.banEndedAt')}</dt><dd>${time(history.endedAt)}</dd></div>
            <div><dt>${t('identity.banEndedBy')}</dt><dd>${history.endedBy?.nickname ?? t('identity.banUnknownModerator')}</dd></div>` : null}
        </dl>
        <div class="identity-ban-record-reason"><strong>${t('identity.banReason')}</strong><p>${ban.reason}</p></div>
        <small>${t(ban.showReason ? 'identity.banReasonVisible' : 'identity.banReasonHidden')}</small>
        ${status === 'active' ? html`<button type="button" class="btn btn-secondary" data-unban="${rowKey(row)}">${t('identity.unban')}</button>` : null}
      </article>`;
    }).join('') || html`<p>${t(scope === 'active' ? 'identity.noBans' : 'identity.noBanHistory')}</p>`.toString();
    updateControls();
  }, { itemKeys: ['data-ban-key'], fallback: () => refreshButton });
  const load = async (more = false) => {
    if (busy || shell.closed || !current() || (more && nextCursor === null)) return;
    busy = true;
    updateControls();
    try {
      if (supportsHistory) {
        const result = await requests.send(id => client.sendRequest<unknown>(MessageType.IDENTITY_BAN_HISTORY_GET,
          { scope, ...(more && nextCursor !== null ? { beforeId: nextCursor } : {}) }, id));
        if (shell.closed || !current()) return;
        const page = identityBanHistoryPageSchema.parse(result);
        const loaded = page.entries.map(history => ({ ban: history, history }));
        rows = more ? [...rows, ...loaded] : loaded;
        nextCursor = page.nextCursor;
      } else {
        const result = await requests.send(id => client.sendRequest<{ bans: IdentityBanSummary[] }>(MessageType.IDENTITY_BANS_GET, {}, id));
        if (shell.closed || !current()) return;
        rows = result.bans.map(ban => ({ ban }));
        nextCursor = null;
      }
      render();
    } catch (error) {
      if (!shell.closed && current()) reportError(t('identity.banFailed'), { log: 'CONNECTION', error });
    } finally {
      busy = false;
      if (!shell.closed) updateControls();
    }
  };
  refreshButton.addEventListener('click', () => { void load(); }, { signal: shell.signal });
  moreButton.addEventListener('click', () => { void load(true); }, { signal: shell.signal });
  shell.card.querySelector('#identity-bans-scope')!.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-bans-scope]') : null;
    if (!button || busy || !current()) return;
    const selected = button.dataset.bansScope === 'all' ? 'all' : 'active';
    if (selected === 'all' && !supportsHistory) { reportError(t('identity.banHistoryRequiresUpdate')); return; }
    if (selected === scope) return;
    scope = selected;
    nextCursor = null;
    rows = [];
    list.replaceChildren();
    selectChoiceCard(shell.card, 'data-bans-scope', scope);
    void load();
  }, { signal: shell.signal });
  list.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-unban]') : null;
    if (!button || busy || !current()) return;
    const row = rows.find(entry => rowKey(entry) === button.dataset.unban);
    if (!row) { reportError(t('identity.banUnavailable')); return; }
    void (async () => {
      busy = true;
      updateControls();
      let confirmed = false;
      try {
        confirmed = await showConfirm({ title: t('identity.unban'),
          message: t('identity.unbanConfirmNamed', { name: row.ban.nickname }), signal: shell.signal, focusCancel: true });
        if (confirmed && !shell.closed && current()) {
          await requests.send(id => client.sendRequest(MessageType.IDENTITY_UNBAN,
            { publicKey: row.ban.publicKey, ...(row.history ? { banId: row.history.id } : {}) }, id));
        }
      } catch (error) {
        if (!shell.closed && current()) reportError(t('identity.banFailed'), { log: 'CONNECTION', error });
      } finally {
        busy = false;
        if (!shell.closed) updateControls();
      }
      if (confirmed && !shell.closed && current()) await load();
    })();
  }, { signal: shell.signal });
  void load();
}
