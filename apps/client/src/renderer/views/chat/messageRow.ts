import type { MessageReply } from '@monky/shared';
import { t } from '../../i18n';
import { html, trustedHtml, type SafeHtml } from '../../utils/html';
import { renderReplyPreview } from '../../utils/messageReply';

/**
 * What a message row shows, independent of where the message came from: a
 * server channel or a direct conversation. Each view turns its own message
 * into this model; the row around it, and the classes and attributes the
 * copy, selection and jump code look for, are drawn in one place.
 */
export interface MessageRowModel {
  id: string;
  /** Extra classes of the row; falsy entries are skipped. */
  classes?: ReadonlyArray<string | false | null | undefined>;
  /** Extra `data-*` attributes, named without the prefix. */
  data?: Readonly<Record<string, string | undefined>>;
  /** A message that can be acted on takes focus (copy, select, jump); a deleted one does not. */
  focusable?: boolean;
  toolbar?: SafeHtml;
  /** Before the avatar: the time of a grouped message, the command a bot answered. */
  lead?: SafeHtml;
  /** Bot answers wrap avatar and body in a bubble. */
  bot?: boolean;
  /** An address `getAvatarUrl` already vetted. */
  avatarUrl: string;
  author: string;
  /** After the author name: bot badge, private cue. */
  badges?: SafeHtml;
  time: string;
  /** After the time: delivery state, edited badge. */
  meta?: SafeHtml;
  content: SafeHtml;
  /** Reaction buttons; left out, the row has no reactions area at all. */
  reactions?: SafeHtml;
}

export interface MessageToolbarAction {
  /** Read back from `data-message-action` when the button is used. */
  action: string;
  icon: string;
  label: string;
  disabled?: boolean;
  /** What the button opens, for assistive technology. */
  popup?: 'dialog' | 'menu';
  className?: string;
}

export interface MessageReactionView {
  emoji: string;
  count: number;
  mine: boolean;
  /** Who reacted, for the tooltip. */
  names: readonly string[];
}

const DISABLED = trustedHtml(' disabled');

export function renderMessageRow(row: MessageRowModel): string {
  const classes = ['chat-message-row', ...(row.classes ?? [])].filter(Boolean).join(' ');
  const data = Object.entries(row.data ?? {}).flatMap(([name, value]) =>
    value === undefined ? [] : [html` data-${trustedHtml(name)}="${value}"`]);
  const main = html`<img class="chat-author-avatar" src="${row.avatarUrl}" alt="" data-fallback="avatar">
    <div class="chat-message-body${row.bot ? ' bot-response-bubble' : ''}">
      <div class="chat-author-header">
        <span class="chat-author-name">${row.author}</span>${row.badges}
        <span class="chat-timestamp">${row.time}</span>${row.meta}
      </div>
      ${row.content}
      ${row.reactions === undefined ? '' : html`<div class="chat-reactions">${row.reactions}</div>`}
    </div>`;
  return html`<div class="${classes}"${row.focusable === false ? '' : trustedHtml(' tabindex="-1"')} data-message-id="${row.id}"${data}>
    ${row.toolbar}${row.lead}
    ${row.bot ? html`<div class="bot-response-main">${main}</div>` : main}
  </div>`.toString();
}

/** The actions that appear over a row on hover or focus. */
export function renderMessageToolbar(actions: readonly MessageToolbarAction[]): SafeHtml {
  return html`<div class="chat-message-toolbar" role="group" aria-label="${t('chat.messageActions')}">${actions.map((action) =>
    html`<button type="button"${action.className ? html` class="${action.className}"` : ''} data-message-action="${action.action}"
      title="${action.label}" aria-label="${action.label}"${action.popup ? html` aria-haspopup="${action.popup}" aria-expanded="false"` : ''}${action.disabled ? DISABLED : ''}><span class="material-symbols-outlined md-18" aria-hidden="true">${action.icon}</span></button>`)}</div>`;
}

export function renderReactionButtons(reactions: readonly MessageReactionView[], disabled: boolean): SafeHtml {
  return html`${reactions.map((reaction) => {
    const title = t('chat.reactedBy', { emoji: reaction.emoji, users: reaction.names.join(', ') });
    return html`<button type="button" class="chat-reaction${reaction.mine ? ' chat-reaction--mine' : ''}"${disabled ? DISABLED : ''}
      data-reaction-emoji="${reaction.emoji}" aria-pressed="${String(reaction.mine)}" title="${title}" aria-label="${title}">${reaction.emoji} <span>${reaction.count}</span></button>`;
  })}`;
}

export function renderEditedBadge(editedAt: string): SafeHtml {
  return html`<span class="chat-edited-badge" title="${t('chat.editedAtTitle', { time: editedAt })}">${t('chat.messageEdited')}</span>`;
}

/** The placeholder a deleted message leaves, so nothing reshuffles under the reader (#504). */
export function renderDeletedNotice(extra?: SafeHtml): SafeHtml {
  return html`<div class="chat-message-deleted-text">
    <span class="material-symbols-outlined md-14">block</span>
    <span>${t('chat.messageDeleted')}</span>${extra}
  </div>`;
}

/** The quote of the message a reply answers; clicking it jumps there. */
export function renderReplyReference(reply: MessageReply): SafeHtml {
  return html`<button type="button" class="chat-reply-reference chat-quote"${reply.deleted ? DISABLED : ''}
    data-reply-target="${reply.messageId}" title="${t('chat.jumpToMessage')}">${trustedHtml(renderReplyPreview(reply))}</button>`;
}
