import { Permission, getMessageText } from '@monky/shared';
import type { AttachmentMeta, ChatMessage, MentionMatcher } from '@monky/shared';
import { getLanguage, t } from '../../i18n';
import type { OutgoingMessage } from '../../stores/chatStore';
import { serverStore } from '../../stores/serverStore';
import { fileIconName, formatBytes, getAttachmentUrl } from '../../utils/attachment';
import { getAvatarUrl } from '../../utils/avatar';
import { escapeHtml, html, trustedHtml, type SafeHtml } from '../../utils/html';
import { renderCodeBlock, renderMarkdown } from '../../utils/markdown';
import { serverMentionMatcher } from '../../utils/mentions';
import { renderForwardedBadge } from '../../utils/messageForward';
import { formatMessageTime } from '../../utils/messageReply';
import { extractStickerIds, stripStickerTokens } from '../../utils/stickers';
import { renderBotCommandContext } from '../botResponse';
import { renderImageCarousel } from '../ImageCarousel';
import { nativePollVoterProfile, renderNativePoll } from '../nativePoll';
import type { ChatContext } from './chatContext';
import {
  renderDeletedNotice,
  renderEditedBadge,
  renderMessageRow,
  renderMessageToolbar,
  renderReactionButtons,
  renderReplyReference,
} from './messageRow';

/** Keys of the feed entries: one per message, per day divider and per bot card. */
export const messageKey = (messageId: string): string => `message:${messageId}`;
export const dayKey = (day: string): string => `day:${day}`;
export const invocationKey = (invocationId: string): string => `invocation:${invocationId}`;
export const isMessageKey = (key: string): boolean => key.startsWith('message:');
export const isDayKey = (key: string): boolean => key.startsWith('day:');
export const isInvocationKey = (key: string): boolean => key.startsWith('invocation:');

/** The calendar day of a timestamp, as the feed groups messages under day dividers. */
export function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function renderDayDivider(ts: number): string {
  const label = new Date(ts).toLocaleDateString(getLanguage(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `<div class="chat-date-divider"><span class="chat-date-divider-label">${escapeHtml(label)}</span></div>`;
}

/** One message of a channel, as a feed row. */
export function renderChannelMessage(ctx: ChatContext, m: ChatMessage, mentions: MentionMatcher = serverMentionMatcher(serverStore)): string {
  const time = formatMessageTime(m.createdAt);
  const messageText = getMessageText(m, getLanguage());

  if (m.isSystem) {
    return `
      <div class="system-message-row">
        <span class="material-symbols-outlined md-14" style="color: var(--accent-primary);">info</span>
        <span>${escapeHtml(m.content)}</span>
        <span style="font-size: 10px; color: var(--text-muted); margin-left: auto;">${time}</span>
      </div>
    `;
  }

  const me = serverStore.currentUser;
  const outgoing = ctx.store.getOutgoing(m.id);
  const currentNickname = me?.nickname?.trim();
  // `@todos` reaches everyone in the channel, so it highlights the row like a direct mention (#464).
  const isMentioned = !!messageText && mentions.mentions(messageText, currentNickname ?? '');

  const isBot = m.isBot || serverStore.knownMembers.get(m.userId)?.isBot === true;
  const botContext = isBot ? trustedHtml(renderBotCommandContext(m,
    m.botCommand ? ctx.commands.presentation(m.userId, m.botCommand.commandName) : undefined)) : undefined;
  const badges = html`${isBot ? html`<span class="member-badge-bot">${t('botChat.badge')}</span>` : ''}${m.isEphemeral
    ? html`<span class="bot-private-cue"><span class="material-symbols-outlined md-14" aria-hidden="true">lock</span>${t('botChat.private')}</span>`
    : ''}`;
  const author = { avatarUrl: getAvatarUrl(m.userAvatarUrl), author: m.userNickname, time, badges, lead: botContext, bot: isBot };

  // A deleted message keeps its place in the conversation with a placeholder
  // instead of vanishing, so nothing silently reshuffles under the reader
  // (#504). Its text, stickers, attachments and link previews are all gone.
  if (m.deletedAt) {
    return renderMessageRow({
      ...author,
      id: m.id,
      classes: ['chat-message-deleted', isBot && 'chat-bot-response'],
      data: { 'user-id': m.userId },
      focusable: false,
      content: renderDeletedNotice(ctx.actions.canUndoDeletion(m)
        ? html`<button type="button" class="chat-undo-delete" data-restore-message-id="${m.id}"
            data-undo-until="${m.deleteUndoUntil ?? 0}" aria-label="${t('chat.undoDelete')}">${t('chat.undoDeleteCountdown',
              { seconds: Math.ceil(((m.deleteUndoUntil ?? 0) - Date.now()) / 1000) })}</button>`
        : undefined),
    });
  }
  // Attachments flagged as stickers are drawn as fixed-size squares instead of
  // going into the regular media grid (#356). A marker only takes effect when
  // it resolves to an image attachment of this message: anything else (a
  // hand-typed marker, an id that no longer exists, a video/file attachment)
  // is left alone so no text or attachment can disappear from the UI.
  const stickers: AttachmentMeta[] = [];
  for (const id of extractStickerIds(messageText)) {
    const found = m.attachments?.find((a) => a.id === id);
    if (found && found.kind === 'image') stickers.push(found);
  }
  const stickerIds = stickers.map((a) => a.id);
  const visibleText = stickerIds.length > 0 ? stripStickerTokens(messageText, stickerIds) : messageText;
  const otherAttachments =
    stickerIds.length > 0 ? m.attachments?.filter((a) => !stickerIds.includes(a.id)) : m.attachments;

  const textHtml = m.poll ? '' : m.blocks?.length
    ? `<div class="chat-message-text">${m.blocks.map(block => block.type === 'reply'
      ? renderReplyReference(block.reply) : block.type === 'code'
        ? renderCodeBlock(block.language, block.code)
        : renderMarkdown(block.text, { currentNickname, mentions })).join('')}</div>`
    : visibleText && visibleText.trim().length > 0
      ? `<div class="chat-message-text">${renderMarkdown(visibleText, { currentNickname, mentions })}</div>`
      : '';
  const pollHtml = m.poll
    ? renderNativePoll(
        m.poll,
        serverStore.hasPermission(Permission.SEND_MESSAGES, ctx.channelId),
        value => formatMessageTime(value),
        ctx.client.getHttpBaseUrl(),
        {
          pendingSelection: ctx.actions.pendingVote(m.poll.id),
          profile: nativePollVoterProfile(serverStore.knownMembers),
        },
      )
    : '';
  const botComponentsHtml = m.botComponents?.length
    ? `<div class="bot-message-components">${m.botComponents.map(component =>
      renderImageCarousel(
        component.imageUrls,
        ctx.client.getHttpBaseUrl(),
        component.label ?? t('community.images'),
        component.presentation,
      )).join('')}</div>`
    : '';
  const sending = me?.id === m.userId && !isBot && outgoing?.status === 'sending';
  const canSend = serverStore.hasPermission(Permission.SEND_MESSAGES, ctx.channelId);
  // Private bot answers and messages still on their way cannot be acted on yet.
  const actionable = !m.isEphemeral && !outgoing;

  return renderMessageRow({
    ...author,
    id: m.id,
    classes: [isMentioned && 'chat-message-mentioned', m.isEphemeral && 'chat-message-private', isBot && 'chat-bot-response',
      sending && 'chat-message-row--sending'],
    data: { 'user-id': m.userId },
    toolbar: actionable ? renderMessageToolbar([
      { action: 'emoji', icon: 'add_reaction', label: t('chat.emojiAction'), popup: 'dialog', className: 'chat-reaction-add', disabled: !canSend },
      { action: 'reply', icon: 'reply', label: t('chat.replyMessage'), disabled: !canSend },
      { action: 'copy', icon: 'content_copy', label: t('chat.copyMessage') },
      { action: 'more', icon: 'more_horiz', label: t('chat.moreActions'), popup: 'menu' },
    ]) : undefined,
    meta: html`${me?.id === m.userId && !isBot ? trustedHtml(renderDelivery(outgoing)) : ''}${m.editedAt
      ? renderEditedBadge(formatMessageTime(m.editedAt)) : ''}`,
    content: html`
      ${m.forwarded ? trustedHtml(renderForwardedBadge(m.forwarded, (value) => formatMessageTime(value))) : ''}
      ${m.reply && !m.blocks?.length ? renderReplyReference(m.reply) : ''}
      ${trustedHtml(textHtml)}
      ${trustedHtml(pollHtml)}
      ${trustedHtml(botComponentsHtml)}
      ${trustedHtml(renderStickers(stickers))}
      <div class="chat-link-previews" data-message-id="${m.id}"></div>
      ${trustedHtml(renderAttachments(otherAttachments, m))}`,
    reactions: actionable ? renderChannelReactions(m, ctx.channelId) : undefined,
  });
}

/** Sending is shown by fading the row; only a failure keeps a visible indicator. */
function renderDelivery(outgoing: OutgoingMessage | undefined): string {
  const state = outgoing?.status ?? 'sent';
  if (state === 'sent') return '<span class="chat-delivery chat-delivery--sent" data-delivery="sent" hidden></span>';
  if (state === 'sending') {
    return `<span class="chat-delivery chat-delivery--sending chat-delivery-sr" data-delivery="sending" role="status">${escapeHtml(t('chat.deliverySending'))}</span>`;
  }
  const label = t('chat.deliveryFailed');
  return `<span class="chat-delivery chat-delivery--failed" data-delivery="failed" role="status" aria-label="${escapeHtml(label)}"
    title="${escapeHtml(outgoing?.error || label)}">
    <span class="material-symbols-outlined md-14" aria-hidden="true">error_outline</span>
    <span>${escapeHtml(label)}</span><button type="button" data-retry-message>${t('chat.deliveryRetry')}</button>
  </span>`;
}

export function renderChannelReactions(message: ChatMessage, channelId: string | null): SafeHtml {
  const me = serverStore.currentUser?.id;
  return renderReactionButtons((message.reactions ?? []).map((reaction) => ({
    emoji: reaction.emoji,
    count: reaction.users.length,
    mine: reaction.users.some((user) => user.userId === me),
    names: reaction.users.map((user) => serverStore.knownMembers.get(user.userId)?.nickname ?? user.userNickname),
  })), !serverStore.hasPermission(Permission.SEND_MESSAGES, channelId));
}

/**
 * Draws sticker attachments as fixed-size squares (#356). Unlike photos they
 * get no lightbox or download affordance — they behave like a large emoji,
 * except for a hover button that saves them into the user's own folder.
 */
function renderStickers(stickers: AttachmentMeta[]): string {
  if (stickers.length === 0) return '';
  const items = stickers.map((a) => a.url ? html`
        <div class="chat-sticker-wrap">
          <img class="chat-sticker" src="${getAttachmentUrl(a.url)}" alt="${a.originalName}" title="${a.originalName}" loading="lazy">
          <button type="button" class="chat-sticker-save" data-sticker-url="${a.url}" data-sticker-name="${a.originalName}" title="${t('chat.saveSticker')}" aria-label="${t('chat.saveSticker')}">
            <span class="material-symbols-outlined md-14">bookmark_add</span>
          </button>
        </div>
      ` : html`
        <div class="chat-sticker chat-sticker--evicted" title="${t('chat.attachmentEvicted')}">
          <span class="material-symbols-outlined md-24">hide_source</span>
        </div>
      `);
  return html`<div class="chat-stickers">${items}</div>`.toString();
}

/** Renders the attachment grid below a message body (#11). */
export function renderAttachments(attachments?: AttachmentMeta[], message?: ChatMessage): string {
  if (!attachments || attachments.length === 0) return '';
  const media = attachments.filter(attachment =>
    !!attachment.url && (attachment.kind === 'image' || attachment.kind === 'video'));
  const separate = media.length > 1
    ? attachments.filter(attachment => !media.includes(attachment))
    : attachments;
  const carousel = media.length > 1 ? `
    <section class="image-carousel chat-attachment-carousel" data-image-carousel data-carousel-index="0"
      aria-label="${escapeHtml(t('community.images'))}">
      <div class="image-carousel-track">${media.map(attachment => `
        <div class="image-carousel-slide chat-attachment-carousel-slide">
          ${renderAttachment(attachment, message)}
        </div>`).join('')}</div>
      <button type="button" class="image-carousel-arrow image-carousel-arrow--previous" data-carousel-move="-1"
        aria-label="${escapeHtml(t('community.previous'))}"><span class="material-symbols-outlined">chevron_left</span></button>
      <button type="button" class="image-carousel-arrow image-carousel-arrow--next" data-carousel-move="1"
        aria-label="${escapeHtml(t('community.next'))}"><span class="material-symbols-outlined">chevron_right</span></button>
      <div class="image-carousel-dots" role="group" aria-label="${escapeHtml(t('community.images'))}">
        ${media.map((_, index) => `<button type="button" class="image-carousel-dot${index === 0 ? ' is-active' : ''}"
          data-carousel-index="${index}" aria-label="${escapeHtml(t('community.imagePosition', {
            current: index + 1, total: media.length,
          }))}" aria-current="${index === 0 ? 'true' : 'false'}"></button>`).join('')}
      </div>
    </section>` : '';
  const items = separate.map(attachment => renderAttachment(attachment, message)).join('');
  return `<div class="chat-attachments">${carousel}${items}</div>`;
}

function renderAttachment(a: AttachmentMeta, message?: ChatMessage): string {
  // FIFO eviction removed the binary: show a placeholder instead of a broken link.
  if (!a.url) {
    return html`
      <div class="attachment-evicted" title="${a.originalName}">
        <span class="material-symbols-outlined md-18">hide_source</span>
        <span>${t('chat.attachmentEvicted')}</span>
      </div>
    `.toString();
  }

  // Empty unless it is one of the server's own `/attachments/` paths.
  const src = getAttachmentUrl(a.url);
  const name = a.originalName;
  const lightboxMeta = html`
    data-lightbox-sender="${message?.userNickname || ''}"
    data-lightbox-timestamp="${message ? formatMessageTime(message.createdAt) : ''}"
  `;
  const inlineActions = html`
    <div class="chat-inline-media-actions">
      ${a.kind === 'image' ? html`<button
        type="button"
        class="chat-attachment-action chat-attachment-copy"
        title="${t('chat.copyImage')}"
        aria-label="${t('chat.copyImage')}"
      >
        <span class="material-symbols-outlined md-18">content_copy</span>
      </button>` : ''}
      <button
        type="button"
        class="chat-attachment-action chat-attachment-lightbox-trigger"
        title="${t('chat.openMediaViewer')}"
      >
        <span class="material-symbols-outlined md-18">open_in_full</span>
      </button>
      <button
        type="button"
        class="chat-attachment-action chat-attachment-download"
        data-download-url="${src}"
        data-file-name="${name}"
        title="${t('common.download')}"
      >
        <span class="material-symbols-outlined md-18">download</span>
      </button>
    </div>
  `;

  if (a.kind === 'image') {
    return html`
      <div
        class="chat-inline-media chat-inline-media--image"
        data-lightbox-kind="image"
        data-lightbox-url="${src}"
        data-lightbox-name="${name}"
        ${lightboxMeta}
      >
        <img class="chat-attachment-image" src="${src}" alt="${name}" title="${name}" loading="lazy">
        ${inlineActions}
      </div>
    `.toString();
  }

  if (a.kind === 'video') {
    return html`
      <div
        class="chat-attachment-video-wrap chat-inline-media chat-inline-media--video"
        data-lightbox-kind="video"
        data-lightbox-url="${src}"
        data-lightbox-name="${name}"
        ${lightboxMeta}
      >
        <div class="chat-video-player">
          <video class="chat-attachment-video" preload="metadata" src="${src}" playsinline></video>
          ${inlineActions}
        </div>
      </div>
    `.toString();
  }

  if (a.mimeType.startsWith('audio/')) {
    return html`
      <div class="chat-audio-player">
        <audio class="chat-attachment-audio" preload="metadata" src="${src}"></audio>
        <div class="chat-audio-meta">
          <span class="material-symbols-outlined md-24 chat-audio-icon" aria-hidden="true">audio_file</span>
          <span class="chat-audio-copy">
            <strong title="${name}">${name}</strong>
            <small>${formatBytes(a.sizeBytes)}</small>
          </span>
          <button
            type="button"
            class="chat-audio-download chat-attachment-download"
            data-download-url="${src}"
            data-file-name="${name}"
            title="${t('common.download')}"
            aria-label="${t('common.download')} ${name}"
          >
            <span class="material-symbols-outlined md-20" aria-hidden="true">download</span>
          </button>
        </div>
      </div>
    `.toString();
  }

  return html`
    <button
      type="button"
      class="chat-attachment-file"
      data-download-url="${src}"
      data-file-name="${name}"
      title="${t('common.download')} ${name}"
    >
      <span class="material-symbols-outlined md-24 af-icon">${fileIconName(a.kind, a.mimeType, a.originalName)}</span>
      <span class="af-meta">
        <span class="af-name">${name}</span>
        <span class="af-size">${formatBytes(a.sizeBytes)}</span>
      </span>
      <span class="material-symbols-outlined md-20 af-dl">download</span>
    </button>
  `.toString();
}
