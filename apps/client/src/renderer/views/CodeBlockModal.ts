import { LIMITS } from '@monky/shared';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { reportError } from '../utils/feedback';
import { CODE_LANGUAGE_OPTIONS } from '../utils/codeHighlight';

interface CodeBlockModalOptions {
  onSubmit: (language: string, code: string) => void;
}

/**
 * Composer for a fenced code block (#391).
 *
 * The message is plain text on the wire — the modal only assembles the
 * ```language fence around what was typed — so nothing about the chat protocol
 * changes and clients that never open this dialog keep rendering the block.
 */
export class CodeBlockModal {
  private get limit(): number { return serverStore.serverDetails?.maxMessageLength ?? 2000; }
  private shell: ModalShell | null = null;
  // Kept between openings: people paste one language far more often than they
  // switch, so re-picking it every time would be busywork.
  private lastLanguage = 'plaintext';

  public open(options: CodeBlockModalOptions): void {
    this.close();

    const languageOptions = CODE_LANGUAGE_OPTIONS.map(
      (lang) =>
        `<option value="${escapeHtml(lang.id)}" data-search-terms="${escapeHtml(lang.searchTerms ?? '')}" ${lang.id === this.lastLanguage ? 'selected' : ''}>${escapeHtml(lang.id === 'plaintext' ? t('chat.codeBlockPlain') : lang.label)}</option>`
    ).join('');

    let form: HTMLFormElement | null = null;
    const shell = openModal({
      card: `
      <div class="modal-card code-modal-card">
        <div class="modal-header">
          <div class="modal-title">${t('chat.codeModalTitle')}</div>
          <button type="button" id="modal-close" class="modal-close-btn" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>

        <form id="form-code-block">
          <div class="form-group">
            <label for="code-language">${t('chat.codeModalLanguage')}</label>
            <select id="code-language" class="code-language-select" data-search-placeholder="${t('chat.codeLanguageSearch')}" data-empty-label="${t('chat.codeLanguageNoResults')}">${languageOptions}</select>
          </div>

          <div class="form-group code-editor-field">
            <label for="code-body">${t('chat.codeModalCode')}</label>
            <textarea id="code-body" class="code-textarea" rows="12" spellcheck="false" placeholder="${escapeHtml(t('chat.codeModalPlaceholder'))}"></textarea>
            <div class="code-modal-meta">
              <span class="code-modal-hint">${t('chat.codeModalHint')}</span>
              <span id="code-char-counter" class="code-char-count">0/${this.limit || '∞'}</span>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" id="btn-cancel" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
            <button type="submit" id="btn-send-code" class="btn btn-primary">${t('chat.codeModalSubmit')}</button>
          </div>
        </form>
      </div>
    `,
      initialFocus: '#code-body',
      // Ctrl+Enter sends from anywhere in the dialog.
      onKeydown: (event) => {
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        form?.requestSubmit();
      },
      onClose: () => { if (this.shell === shell) this.shell = null; },
    });
    this.shell = shell;
    form = shell.card.querySelector<HTMLFormElement>('#form-code-block');
    this.attachEvents(shell, options);
  }

  private attachEvents(shell: ModalShell, options: CodeBlockModalOptions): void {
    const root = shell.card;
    const listen = { signal: shell.signal };
    const form = root.querySelector('#form-code-block') as HTMLFormElement | null;
    const select = root.querySelector('#code-language') as HTMLSelectElement | null;
    const textarea = root.querySelector('#code-body') as HTMLTextAreaElement | null;
    const counter = root.querySelector('#code-char-counter') as HTMLElement | null;
    const btnSubmit = root.querySelector('#btn-send-code') as HTMLButtonElement | null;

    // The fence itself counts against the message limit, so the counter shows
    // the size of what will actually be sent instead of just the code.
    const totalLength = (): number => buildCodeMessage(select?.value ?? '', textarea?.value ?? '').length;

    const refresh = (): void => {
      const total = totalLength();
      const tooLong = this.limit > 0 && total > this.limit;
      if (counter) {
        counter.textContent = `${total}/${this.limit || '∞'}`;
        counter.classList.toggle('code-char-count--over', tooLong);
      }
      if (btnSubmit) btnSubmit.disabled = tooLong || (textarea?.value.trim().length ?? 0) === 0;
    };

    textarea?.addEventListener('input', refresh, listen);
    select?.addEventListener('change', refresh, listen);
    refresh();

    // Tab indenta em vez de pular para o próximo campo (#391). O campo não
    // prende quem navega por teclado: Escape fecha e Ctrl+Enter envia.
    textarea?.addEventListener('keydown', (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      indentCodeInput(textarea, e.shiftKey);
    }, listen);

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = textarea?.value ?? '';
      if (!code.trim()) {
        reportError(t('chat.codeModalEmpty'), { field: textarea, focus: true });
        return;
      }
      if (this.limit > 0 && totalLength() > this.limit) return;

      this.lastLanguage = select?.value ?? 'plaintext';
      options.onSubmit(this.lastLanguage, code);
      this.close();
    }, listen);
  }

  public close(): void {
    this.shell?.close('api');
  }
}

/**
 * Wraps code in a fence the chat renderer understands. `plaintext` is left
 * untagged so an untouched dropdown does not label every snippet as a language.
 *
 * Any closing fence inside the code would end the block early, so those get a
 * zero-width space between the backticks: it keeps the text readable and
 * copyable while no longer matching the fence pattern.
 */
export function buildCodeMessage(language: string, code: string): string {
  const tag = language && language !== 'plaintext' ? language : '';
  const safeCode = code.replace(/\r\n/g, '\n').replace(/```/g, '`\u200b``').replace(/\s+$/, '');
  return `\`\`\`${tag}\n${safeCode}\n\`\`\``;
}

export const codeBlockModal = new CodeBlockModal();

const INDENT = '  ';

export interface IndentEdit {
  from: number;
  to: number;
  text: string;
  /** Reindentou linhas inteiras: a seleção volta cobrindo o bloco afetado. */
  reselect: boolean;
}

function outdentLine(line: string): string {
  if (line.startsWith(INDENT)) return line.slice(INDENT.length);
  if (line.startsWith('\t') || line.startsWith(' ')) return line.slice(1);
  return line;
}

/**
 * O que um Tab (ou Shift+Tab) deve escrever no campo de código (#391).
 *
 * Fica separada do DOM de propósito: é a única parte com regra de verdade, e
 * assim dá para testá-la sem montar a janela.
 *
 * Um Tab simples indenta no cursor. Quando a seleção passa de uma linha — ou
 * quando se está desindentando — a operação vale para as linhas inteiras, como
 * em qualquer editor; sem isso o Tab apagaria o trecho selecionado.
 */
export function indentEdit(value: string, start: number, end: number, outdenting: boolean): IndentEdit {
  const spansLines = value.slice(start, end).includes('\n');
  if (!spansLines && !outdenting) return { from: start, to: end, text: INDENT, reselect: false };

  const from = value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = value.indexOf('\n', end);
  const to = lineEnd === -1 ? value.length : lineEnd;
  const text = value
    .slice(from, to)
    .split('\n')
    .map((line) => (outdenting ? outdentLine(line) : INDENT + line))
    .join('\n');

  return { from, to, text, reselect: true };
}

/**
 * Escreve por `execCommand` para preservar o histórico de desfazer: alterar
 * `value` na mão faz o Ctrl+Z do campo perder tudo o que foi digitado antes,
 * o que é justamente o que se espera poder desfazer depois de um Tab errado.
 */
function replaceSelection(el: HTMLTextAreaElement, text: string): void {
  el.focus();
  try {
    if (document.execCommand('insertText', false, text)) return;
  } catch {
    // Sem suporte: segue para a substituição manual abaixo.
  }

  const { selectionStart, selectionEnd, value } = el;
  el.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
  el.setSelectionRange(selectionStart + text.length, selectionStart + text.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function indentCodeInput(textarea: HTMLTextAreaElement, outdenting: boolean): void {
  const edit = indentEdit(textarea.value, textarea.selectionStart, textarea.selectionEnd, outdenting);
  textarea.setSelectionRange(edit.from, edit.to);
  replaceSelection(textarea, edit.text);
  if (edit.reselect) textarea.setSelectionRange(edit.from, edit.from + edit.text.length);
}
