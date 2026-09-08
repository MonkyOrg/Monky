import type { ChatMessage } from '@monky/shared';
import { getAvatarUrl } from '../utils/avatar';
import { escapeHtml } from '../utils/html';
import { formatCommandContext } from '../utils/botInputs';

export function renderBotCommandContext(message: Pick<ChatMessage, 'botCommand'>): string {
  const context = message.botCommand;
  if (!context) return '';
  return `<div class="bot-response-context" data-command-invocation="${escapeHtml(context.invocationId)}"
    data-invoker-id="${escapeHtml(context.invokerId)}">
    <img class="bot-invoker-avatar" src="${escapeHtml(getAvatarUrl(context.invokerAvatarUrl))}" alt="" data-fallback="avatar">
    <span>${escapeHtml(formatCommandContext(context))}</span>
  </div>`;
}
