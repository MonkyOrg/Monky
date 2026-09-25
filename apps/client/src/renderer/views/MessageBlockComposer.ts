import { parseFencedMessageBlocks, type ResolvedMessageBlock } from '@monky/shared';
import { type ChatStore } from '../stores/chatStore';
import { renderReplyPreview } from '../utils/messageReply';
import { bindCodeComposer, renderCodeComposer } from './CodeComposer';
import { t } from '../i18n';
import { MarkdownInput } from './MarkdownInput';

export function renderMessageBlockComposer(
  root: HTMLElement, store: ChatStore, channelId: string, changed: () => void, disabled: boolean,
): void {
  const blocks = store.getBlockDraft(channelId);
  root.hidden = blocks.length === 0;
  const persist = () => { store.setBlockDraft(channelId, blocks); changed(); };
  const render = () => renderMessageBlockComposer(root, store, channelId, changed, disabled);
  const previous = Array.from(root.querySelectorAll('fieldset'));
  const focused = document.activeElement?.closest('textarea, monky-markdown-input');
  const active = (focused instanceof HTMLTextAreaElement || focused instanceof MarkdownInput) && root.contains(focused)
    ? focused : null;
  const focusIndex = active ? previous.indexOf(active.closest('fieldset')!) : -1;
  const selection = active ? [active.selectionStart, active.selectionEnd] : null;
  const collapsed = previous.map(element => element.querySelector('details')?.open === false);
  root.replaceChildren();
  blocks.forEach((block, index) => {
    const element = document.createElement('fieldset');
    element.className = `chat-composer-block chat-composer-block-${block.type}`;
    element.disabled = disabled;
    const remove = `<button type="button" class="chat-block-remove" data-remove aria-label="${t('chat.removeBlock')}" title="${t('chat.removeBlock')}"><span class="material-symbols-outlined md-16" aria-hidden="true">close</span></button>`;
    if (block.type === 'reply') {
      element.innerHTML = `<div class="chat-quote">${renderReplyPreview(block.reply)}${remove}</div>`;
    } else if (block.type === 'code') {
      element.innerHTML = renderCodeComposer(block, remove);
      root.append(element);
      bindCodeComposer(element, block, value => { Object.assign(block, value); persist(); });
    } else {
      element.innerHTML = `${remove}<monky-markdown-input aria-label="${t('chat.formatText')}"></monky-markdown-input>`;
    }
    const input = element.querySelector<HTMLTextAreaElement | MarkdownInput>('textarea, monky-markdown-input');
    const details = element.querySelector('details');
    if (details && collapsed[index]) details.open = false;
    if (input instanceof MarkdownInput && block.type === 'text') {
      if (input instanceof MarkdownInput) input.disabled = disabled;
      input.value = block.text;
      input.addEventListener('input', event => {
        block.text = input.value;
        persist();
        input.refresh();
        if (event instanceof InputEvent && event.isComposing) return;
        if (block.type === 'text') {
          const parsed = parseFencedMessageBlocks(input.value);
          if (parsed.some(entry => entry.type === 'code') && blocks.length - 1 + parsed.length < 100) {
            blocks.splice(index, 1, ...parsed);
            persist(); render();
            return;
          }
        }
        if (block.type === 'text' && blocks.length < 98 && input.value.endsWith('```')) {
          block.text = input.value.slice(0, -3);
          const code: ResolvedMessageBlock = { type: 'code', language: 'plaintext', code: '' };
          blocks.splice(index + 1, 0, code);
          persist(); render();
          root.querySelectorAll('fieldset')[index + 1]?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        }
      });
      input.addEventListener('keydown', event => {
        if (!(event instanceof KeyboardEvent) || event.isComposing) return;
        if (event.key === 'Enter') event.stopPropagation();
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          root.closest('.chat-input-container')?.querySelector<HTMLButtonElement>('#btn-send-message')?.click();
        }
      });
      root.append(element);
      input.refresh();
    }
    element.querySelector('[data-remove]')?.addEventListener('click', () => {
      blocks.splice(index, 1);
      persist(); render();
    });
    root.append(element);
  });
  if (focusIndex >= 0 && selection && !disabled) {
    const input = root.querySelectorAll('fieldset')[focusIndex]?.querySelector<HTMLTextAreaElement | MarkdownInput>('textarea, monky-markdown-input');
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(selection[0], selection[1]);
  }
}
