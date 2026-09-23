import { LIMITS } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';
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
  private modalEl: HTMLElement | null = null;
  private unbind: Array<() => void> = [];
  // Kept between openings: people paste one language far more often than they
  // switch, so re-picking it every time would be busywork.
  private lastLanguage = 'plaintext';

  public open(options: CodeBlockModalOptions): void {
    this.close();

    const languageOptions = CODE_LANGUAGE_OPTIONS.map(
      (lang) =>
        `<option value="${escapeHtml(lang.id)}" ${lang.id === this.lastLanguage ? 'selected' : ''}>${escapeHtml(lang.label)}</option>`
    ).join('');

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card code-modal-card">
        <div class="modal-header">
          <div class="modal-title">${t('chat.codeModalTitle')}</div>
          <button id="modal-close" class="modal-close-btn">&times;</button>
        </div>

        <div id="code-error-banner" class="error-banner"></div>

        <form id="form-code-block">
          <div class="form-group">
            <label for="code-language">${t('chat.codeModalLanguage')}</label>
            <select id="code-language" class="code-language-select">${languageOptions}</select>
          </div>

          <div class="form-group code-editor-field">
            <label for="code-body">${t('chat.codeModalCode')}</label>
            <textarea id="code-body" class="code-textarea" rows="12" spellcheck="false" placeholder="${escapeHtml(t('chat.codeModalPlaceholder'))}"></textarea>
            <div class="code-modal-meta">
              <span class="code-modal-hint">${t('chat.codeModalHint')}</span>
              <span id="code-char-counter" class="code-char-count">0/${LIMITS.MAX_MESSAGE_LENGTH}</span>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" id="btn-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
            <button type="submit" id="btn-send-code" class="btn btn-primary">${t('chat.codeModalSubmit')}</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.attachEvents(options);
  }

  private attachEvents(options: CodeBlockModalOptions): void {
    if (!this.modalEl) return;

    const form = this.modalEl.querySelector('#form-code-block') as HTMLFormElement | null;
    const select = this.modalEl.querySelector('#code-language') as HTMLSelectElement | null;
    const textarea = this.modalEl.querySelector('#code-body') as HTMLTextAreaElement | null;
    const counter = this.modalEl.querySelector('#code-char-counter') as HTMLElement | null;
    const banner = this.modalEl.querySelector('#code-error-banner') as HTMLElement | null;
    const btnSubmit = this.modalEl.querySelector('#btn-send-code') as HTMLButtonElement | null;

    this.modalEl.querySelector('#modal-close')?.addEventListener('click', () => this.close());
    this.modalEl.querySelector('#btn-cancel')?.addEventListener('click', () => this.close());
    enableBackdropClose(this.modalEl, () => this.close());

    // The fence itself counts against the message limit, so the counter shows
    // the size of what will actually be sent instead of just the code.
    const totalLength = (): number => buildCodeMessage(select?.value ?? '', textarea?.value ?? '').length;

    const refresh = (): void => {
      const total = totalLength();
      const tooLong = total > LIMITS.MAX_MESSAGE_LENGTH;
      if (counter) {
        counter.textContent = `${total}/${LIMITS.MAX_MESSAGE_LENGTH}`;
        counter.classList.toggle('code-char-count--over', tooLong);
      }
      if (btnSubmit) btnSubmit.disabled = tooLong || (textarea?.value.trim().length ?? 0) === 0;
    };

    textarea?.addEventListener('input', refresh);
    select?.addEventListener('change', refresh);
    refresh();

    // Tab indenta em vez de pular para o próximo campo (#391). O campo não
    // prende quem navega por teclado: Escape fecha e Ctrl+Enter envia.
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !textarea) return;
      e.preventDefault();

      const edit = indentEdit(textarea.value, textarea.selectionStart, textarea.selectionEnd, e.shiftKey);
      textarea.setSelectionRange(edit.from, edit.to);
      replaceSelection(textarea, edit.text);
      if (edit.reselect) textarea.setSelectionRange(edit.from, edit.from + edit.text.length);
    };
    textarea?.addEventListener('keydown', onTab);

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        this.close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form?.requestSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    this.unbind.push(() => window.removeEventListener('keydown', onKeyDown, true));

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = textarea?.value ?? '';
      if (!code.trim()) {
        this.showError(banner, t('chat.codeModalEmpty'));
        return;
      }
      if (totalLength() > LIMITS.MAX_MESSAGE_LENGTH) return;

      this.lastLanguage = select?.value ?? 'plaintext';
      options.onSubmit(this.lastLanguage, code);
      this.close();
    });

    textarea?.focus();
  }

  private showError(banner: HTMLElement | null, message: string): void {
    if (!banner) return;
    banner.innerText = message;
    banner.classList.add('show');
  }

  public close(): void {
    this.unbind.forEach((fn) => fn());
    this.unbind = [];
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
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
