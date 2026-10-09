import { createServerInviteAppLink, parseServerInviteLink, type ServerInvite } from '@monky/shared';
import { clientLog } from '../core/ClientLogService';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { joinInviteModal } from './JoinInviteModal';

/**
 * Invitation links carry the whole server address after `#`, which the docs
 * site never receives. Fetching its preview could only return the generic
 * page card, so the chat decodes the link locally and shows the server itself.
 */
export function serverInviteFromLink(url: string | null | undefined): ServerInvite | null {
  if (!url) return null;
  const result = parseServerInviteLink(url);
  return result.ok ? result.invite : null;
}

function inviteName(invite: ServerInvite): string {
  return invite.name?.trim() || invite.host;
}

function inviteHeading(invite: ServerInvite, sent: boolean): string {
  if (invite.eventId) return t(sent ? 'invite.cardEventSent' : 'invite.cardEventReceived');
  return t(sent ? 'invite.cardSent' : 'invite.cardReceived');
}

export function renderServerInviteCard(invite: ServerInvite, link: string, sent: boolean): string {
  const name = inviteName(invite);
  const heading = inviteHeading(invite, sent);
  // The name is chosen by whoever made the link, so the address stays visible next to it.
  const address = `${invite.host}:${invite.port}`;
  const initial = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? Array.from(name)[0] ?? '?').toUpperCase();
  return `
    <div class="chat-invite-card" role="group" aria-label="${escapeHtml(`${heading}: ${name}`)}">
      <span class="chat-invite-card-heading">${escapeHtml(heading)}</span>
      <div class="chat-invite-card-body">
        <span class="chat-invite-card-icon" aria-hidden="true">${escapeHtml(initial)}</span>
        <span class="chat-invite-card-info">
          <span class="chat-invite-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="chat-invite-card-address" title="${escapeHtml(address)}">${escapeHtml(address)}</span>
        </span>
        <button type="button" class="btn btn-primary chat-invite-card-join" data-server-invite-link="${escapeHtml(link)}"
          aria-label="${escapeHtml(t('invite.cardJoinLabel', { name }))}">${escapeHtml(t('invite.cardJoin'))}</button>
      </div>
    </div>
  `;
}

/** Compact version for the composer, before the message is sent. */
export function renderComposeServerInvite(invite: ServerInvite): string {
  return `
    <div class="compose-link-preview-text">
      <div class="compose-link-preview-site">${escapeHtml(t(invite.eventId ? 'invite.cardComposeEvent' : 'invite.cardCompose'))}</div>
      <div class="compose-link-preview-title">${escapeHtml(inviteName(invite))}</div>
      <div class="compose-link-preview-desc">${escapeHtml(`${invite.host}:${invite.port}`)}</div>
    </div>
  `;
}

/** Opens the review dialog for an invitation link; returns false for any other link. */
export function openServerInviteLink(url: string | null | undefined): boolean {
  const invite = serverInviteFromLink(url);
  if (!invite) return false;
  joinInviteModal.open(invite).catch(() => clientLog.warn('CONNECTION', 'Could not open the invitation from chat'));
  return true;
}

/**
 * Adds one card per distinct invitation linked in each message row of `root`.
 * Safe to call again on the same row: its previous cards are replaced.
 */
export function mountServerInviteCards(root: HTMLElement, isSent: (row: HTMLElement) => boolean): void {
  const rows = root.matches('.chat-message-row') ? [root] : [...root.querySelectorAll<HTMLElement>('.chat-message-row')];
  for (const row of rows) {
    row.querySelectorAll('.chat-invite-cards').forEach(container => container.remove());
    const text = row.querySelector<HTMLElement>('.chat-message-body > .chat-message-text');
    if (!text) continue;
    const seen = new Set<string>();
    const cards: string[] = [];
    text.querySelectorAll<HTMLElement>('.md-link[data-external-link]').forEach(link => {
      // A quoted invitation already has its card on the original message.
      if (link.closest('.chat-quote-preview')) return;
      const url = link.getAttribute('data-external-link');
      const invite = serverInviteFromLink(url);
      if (!url || !invite) return;
      // The same invitation may arrive through the PT, EN or older page.
      const key = createServerInviteAppLink(invite);
      if (seen.has(key)) return;
      seen.add(key);
      cards.push(renderServerInviteCard(invite, url, isSent(row)));
    });
    if (!cards.length) continue;
    const container = document.createElement('div');
    container.className = 'chat-invite-cards';
    container.innerHTML = cards.join('');
    container.querySelectorAll<HTMLButtonElement>('[data-server-invite-link]').forEach(button => {
      button.addEventListener('click', () => { openServerInviteLink(button.dataset.serverInviteLink); });
    });
    text.after(container);
  }
}
