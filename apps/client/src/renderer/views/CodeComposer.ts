import { CODE_LANGUAGE_OPTIONS, codeLineNumbers, highlightCode, resolveCodeLanguage } from '../utils/codeHighlight';
import { escapeHtml } from '../utils/html';
import { indentCodeInput } from './CodeBlockModal';
import { t } from '../i18n';

export interface CodeComposerValue { code: string; language: string }

export function renderCodeComposer(value: CodeComposerValue, remove = ''): string {
  const language = resolveCodeLanguage(value.language) ?? 'plaintext';
  return `<details open><summary class="chat-code-header" aria-label="${t('chat.codeBlockTitle')}">
    <span class="material-symbols-outlined md-18" aria-hidden="true">code</span>
    <select aria-label="${t('chat.codeModalLanguage')}" data-search-placeholder="${t('chat.codeLanguageSearch')}" data-empty-label="${t('chat.codeLanguageNoResults')}">${CODE_LANGUAGE_OPTIONS.map(option =>
      `<option value="${escapeHtml(option.id)}" data-search-terms="${escapeHtml(option.searchTerms ?? '')}" ${option.id === language ? 'selected' : ''}>${escapeHtml(option.id === 'plaintext' ? t('chat.codeBlockPlain') : option.label)}</option>`).join('')}</select>
    <span class="material-symbols-outlined md-16 chat-code-fold" aria-hidden="true">expand_more</span>${remove}
    </summary><div class="chat-code-editor">
      <pre class="md-code-lines" aria-hidden="true"><span></span></pre>
      <div class="chat-code-input"><pre aria-hidden="true"><code class="hljs"></code></pre>
        <textarea rows="1" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="${t('chat.codeModalCode')}"></textarea>
      </div></div></details>`;
}

export function bindCodeComposer(
  element: HTMLElement, initial: CodeComposerValue, changed: (value: CodeComposerValue) => void,
  measured: () => void = () => {},
): { update(value: CodeComposerValue): void; destroy(): void } {
  const input = element.querySelector('textarea')!;
  const select = element.querySelector('select')!;
  const highlight = element.querySelector<HTMLElement>('.chat-code-input code')!;
  const numbers = element.querySelector<HTMLElement>('.md-code-lines span')!;
  const details = element.querySelector('details')!;
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  let value = initial;
  const scroll = () => {
    highlight.parentElement!.scrollTop = input.scrollTop;
    highlight.parentElement!.scrollLeft = input.scrollLeft;
    numbers.style.transform = `translateY(${-input.scrollTop}px)`;
  };
  const refresh = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    highlight.innerHTML = (highlightCode(input.value, value.language) || escapeHtml(input.value)) + '\n';
    numbers.textContent = codeLineNumbers(input.value);
    scroll();
    measured();
  };
  const update = (next: CodeComposerValue) => {
    value = next;
    if (input.value !== next.code) input.value = next.code;
    const language = resolveCodeLanguage(next.language) ?? 'plaintext';
    if (select.value !== language) select.value = language;
    refresh();
  };
  input.addEventListener('input', () => { value = { ...value, code: input.value }; changed(value); refresh(); }, options);
  select.addEventListener('change', () => { value = { ...value, language: select.value }; changed(value); refresh(); }, options);
  input.addEventListener('scroll', scroll, options);
  details.addEventListener('toggle', () => { if (details.open) refresh(); }, options);
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      indentCodeInput(input, event.shiftKey);
    }
    if (event.key === 'Escape') { event.stopPropagation(); select.focus(); }
    if (event.key === 'Enter') event.stopPropagation();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      element.closest('.chat-input-container')?.querySelector<HTMLButtonElement>('#btn-send-message')?.click();
    }
  }, options);
  update(initial);
  return { update, destroy: () => lifetime.abort() };
}
