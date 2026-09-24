import { parseFencedMessageBlocks, type ResolvedMessageBlock } from '@monky/shared';
import { type ChatStore } from '../stores/chatStore';
import { escapeHtml } from '../utils/html';
import { CODE_LANGUAGE_OPTIONS, codeLineNumbers, highlightCode, resolveCodeLanguage } from '../utils/codeHighlight';
import { renderReplyPreview } from '../utils/messageReply';
import { indentCodeInput } from './CodeBlockModal';
import { t } from '../i18n';

export function renderMessageBlockComposer(
  root: HTMLElement, store: ChatStore, channelId: string, changed: () => void, disabled: boolean,
): void {
  const blocks = store.getBlockDraft(channelId);
  root.hidden = blocks.length === 0;
  const persist = () => { store.setBlockDraft(channelId, blocks); changed(); };
  const render = () => renderMessageBlockComposer(root, store, channelId, changed, disabled);
  const previous = Array.from(root.querySelectorAll('fieldset'));
  const active = document.activeElement instanceof HTMLTextAreaElement && root.contains(document.activeElement)
    ? document.activeElement : null;
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
      const language = resolveCodeLanguage(block.language) ?? 'plaintext';
      element.innerHTML = `<details open><summary class="chat-code-header" aria-label="${t('chat.codeBlockTitle')}">
        <span class="material-symbols-outlined md-18" aria-hidden="true">code</span>
        <select aria-label="${t('chat.codeModalLanguage')}" data-search-placeholder="${t('chat.codeLanguageSearch')}" data-empty-label="${t('chat.codeLanguageNoResults')}">${CODE_LANGUAGE_OPTIONS.map(option =>
          `<option value="${escapeHtml(option.id)}" data-search-terms="${escapeHtml(option.searchTerms ?? '')}" ${option.id === language ? 'selected' : ''}>${escapeHtml(option.id === 'plaintext' ? t('chat.codeBlockPlain') : option.label)}</option>`).join('')}</select>
        <span class="material-symbols-outlined md-16 chat-code-fold" aria-hidden="true">expand_more</span>${remove}
        </summary><div class="chat-code-editor">
          <pre class="md-code-lines" aria-hidden="true"><span></span></pre>
          <div class="chat-code-input"><pre aria-hidden="true"><code class="hljs"></code></pre>
            <textarea rows="1" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="${t('chat.codeModalCode')}"></textarea>
          </div></div></details>`;
    } else {
      element.innerHTML = `${remove}<textarea rows="1" aria-label="${t('chat.addTextBlock')}"></textarea>`;
    }
    const input = element.querySelector('textarea');
    const details = element.querySelector('details');
    if (details && collapsed[index]) details.open = false;
    if (input && block.type !== 'reply') {
      input.value = block.type === 'code' ? block.code : block.text;
      const highlight = element.querySelector<HTMLElement>('.chat-code-input code');
      const numbers = element.querySelector<HTMLElement>('.md-code-lines span');
      const syncScroll = () => {
        if (highlight?.parentElement) {
          highlight.parentElement.scrollTop = input.scrollTop;
          highlight.parentElement.scrollLeft = input.scrollLeft;
        }
        if (numbers) numbers.style.transform = `translateY(${-input.scrollTop}px)`;
      };
      const refreshEditor = () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, block.type === 'code' ? 240 : 160)}px`;
        if (highlight && block.type === 'code') highlight.innerHTML = (highlightCode(input.value, block.language) || escapeHtml(input.value)) + '\n';
        if (numbers) numbers.textContent = codeLineNumbers(input.value);
        syncScroll();
      };
      element.querySelector('select')?.addEventListener('change', event => {
        if (block.type === 'code' && event.target instanceof HTMLSelectElement) {
          block.language = event.target.value;
          persist();
          refreshEditor();
        }
      });
      input.addEventListener('scroll', syncScroll);
      details?.addEventListener('toggle', () => { if (details.open) refreshEditor(); });
      input.addEventListener('input', event => {
        if (block.type === 'code') block.code = input.value;
        else block.text = input.value;
        persist();
        refreshEditor();
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
          root.querySelectorAll('fieldset')[index + 1]?.querySelector('textarea')?.focus();
        }
      });
      input.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Tab' && block.type === 'code' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          indentCodeInput(input, event.shiftKey);
        }
        if (event.key === 'Escape' && block.type === 'code') {
          event.stopPropagation();
          element.querySelector('select')?.focus();
        }
        if (event.key === 'Enter') event.stopPropagation();
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          root.closest('.chat-input-container')?.querySelector<HTMLButtonElement>('#btn-send-message')?.click();
        }
      });
      root.append(element);
      refreshEditor();
    }
    element.querySelector('[data-remove]')?.addEventListener('click', () => {
      blocks.splice(index, 1);
      persist(); render();
    });
    const addText = document.createElement('button');
    addText.type = 'button';
    addText.className = 'chat-block-add-text';
    addText.textContent = t('chat.addTextBlock');
    addText.disabled = blocks.length >= 99;
    addText.title = blocks.length >= 99 ? t('chat.tooManyBlocks') : t('chat.addTextBlock');
    addText.addEventListener('click', () => {
      blocks.splice(index + 1, 0, { type: 'text', text: '' });
      persist(); render();
      root.querySelectorAll<HTMLTextAreaElement>('fieldset')[index + 1]?.querySelector('textarea')?.focus();
    });
    element.append(addText);
    root.append(element);
  });
  if (focusIndex >= 0 && selection && !disabled) {
    const input = root.querySelectorAll('fieldset')[focusIndex]?.querySelector('textarea');
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(selection[0], selection[1]);
  }
}
