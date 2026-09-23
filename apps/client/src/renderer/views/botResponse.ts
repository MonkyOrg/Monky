import type { ChatMessage, CommandPresentation } from '@monky/shared';
import { getAvatarUrl } from '../utils/avatar';
import { escapeHtml } from '../utils/html';
import { formatCommandContext } from '../utils/botInputs';

export function renderBotCommandContext(message: Pick<ChatMessage, 'botCommand'>, presentation?: CommandPresentation): string {
  const context = message.botCommand;
  if (!context) return '';
  return `<div class="bot-response-context" data-command-invocation="${escapeHtml(context.invocationId)}"
    data-invoker-id="${escapeHtml(context.invokerId)}" data-command-name="${escapeHtml(context.commandName)}">
    <img class="bot-invoker-avatar" src="${escapeHtml(getAvatarUrl(context.invokerAvatarUrl))}" alt="" data-fallback="avatar">
    <span data-command-context-label>${escapeHtml(formatCommandContext(context, presentation))}</span>
  </div>`;
}
