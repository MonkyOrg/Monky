import { getMessageText, type MessageReply } from '@monky/shared';
import { getLanguage, t } from '../i18n';
import { escapeHtml } from './html';
import { extractStickerIds, stripStickerTokens } from './stickers';

export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toLocaleDateString(getLanguage())} ${date.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' })}`;
}

export function renderReplyPreview(reply: MessageReply): string {
  const content = getMessageText(reply, getLanguage());
  const preview = reply.deleted ? t('chat.messageDeleted')
    : stripStickerTokens(content, extractStickerIds(content)).trim() || (reply.hasAttachments ? t('chat.replyAttachment') : content);
  const time = !reply.deleted && reply.createdAt !== undefined && Number.isFinite(reply.createdAt)
    ? `<time>${escapeHtml(formatMessageTime(reply.createdAt))}</time>` : '';
  return `<span class="chat-quote-content">
    ${reply.deleted ? '' : `<span class="chat-quote-heading"><strong>${escapeHtml(reply.userNickname)}</strong>${time}</span>`}
    <span class="chat-quote-preview">${escapeHtml(preview)}</span>
  </span>`;
}
