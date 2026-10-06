import { MarkdownInput } from './MarkdownInput';
import { ContextMenu } from './ContextMenu';
import { escapeHtml } from '../utils/html';
import { showAlert } from './Dialog';
import { editEditorLink } from './LinkPopover';
import { inlineFormats } from './MarkdownFormatting';
import { t } from '../i18n';

const actions = [
  ['bold', 'format_bold', 'chat.formatBold'],
  ['italic', 'format_italic', 'chat.formatItalic'],
  ['strike', 'format_strikethrough', 'chat.formatStrike'],
  ['bullet', 'format_list_bulleted', 'chat.formatBulletList'],
  ['numbered', 'format_list_numbered', 'chat.formatNumberedList'],
  ['heading', 'format_h1', 'chat.formatHeading'],
  ['quote', 'format_quote', 'chat.formatQuote'],
  ['inline-code', 'code', 'chat.formatInlineCode'],
  ['code', 'data_object', 'chat.codeBlockTitle'],
  ['link', 'link', 'chat.formatLink'],
  ['separator', 'horizontal_rule', 'chat.formatSeparator'],
] as const;

export function renderFormattingToolbar(): string {
  return `<div class="chat-format-panel" aria-hidden="true" inert><div class="chat-format-overflow">
    <div id="chat-format-toolbar" class="chat-format-toolbar" role="toolbar" aria-label="${t('chat.formatting')}">
      ${actions.map(([action, icon, label]) => `<button type="button" class="chat-format-button" data-format="${action}"
        ${action === 'bold' || action === 'italic' || action === 'strike' ? 'aria-pressed="false"' : ''}
        ${action === 'code' ? 'id="btn-code"' : ''} ${action === 'heading' ? 'aria-haspopup="menu" aria-expanded="false"' : ''}
        title="${escapeHtml(t(label))}" aria-label="${escapeHtml(t(label))}">
        <span class="material-symbols-outlined md-20" aria-hidden="true">${icon}</span></button>
        ${action === 'strike' || action === 'numbered' ? '<span class="chat-format-divider" role="separator" aria-orientation="vertical"></span>' : ''}`).join('')}
    </div>
  </div></div>`;
}

export function bindFormattingToolbar(root: HTMLElement): () => void {
  const trigger = root.querySelector<HTMLButtonElement>('#btn-format');
  const panel = root.querySelector<HTMLElement>('.chat-format-panel');
  const toolbar = root.querySelector<HTMLElement>('#chat-format-toolbar');
  if (!trigger || !panel || !toolbar) return () => {};
  const headings = new ContextMenu();
  const lifetime = new AbortController();
  let lastInput: MarkdownInput | null = null;
  const input = () => lastInput?.isConnected && !lastInput.closest('[hidden], [inert]')
    ? lastInput : root.querySelector<MarkdownInput>('#chat-message-input');
  const syncFormats = () => {
    const flags = input()?.activeFormats ?? 0;
    for (const format of ['bold', 'italic', 'strike'] as const) {
      toolbar.querySelector(`[data-format="${format}"]`)?.setAttribute('aria-pressed', String(!!(flags & inlineFormats[format])));
    }
  };
  const setOpen = (open: boolean) => {
    trigger.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    panel.classList.toggle('is-open', open);
    if (!open) headings.close();
  };
  const onToggle = () => setOpen(trigger.getAttribute('aria-expanded') !== 'true');
  const remember = (event: FocusEvent) => {
    const editor = event.target instanceof Element ? event.target.closest('monky-markdown-input') : null;
    if (editor instanceof MarkdownInput) lastInput = editor;
    syncFormats();
  };
  const replace = (editor: MarkdownInput, text: string, from: number, to: number, selectionFrom: number, selectionTo: number) => {
    if (!editor.isConnected || editor.readOnly || editor.disabled) return;
    if (editor.maxLength >= 0 && editor.value.length - (to - from) + text.length > editor.maxLength) {
      void showAlert({ message: t('chat.messageTooLong', { max: editor.maxLength }), variant: 'danger' });
      return;
    }
    editor.insertText(text, from, to);
    editor.setSelectionRange(selectionFrom, selectionTo);
    editor.focus();
  };
  const wrap = (editor: MarkdownInput, delimiter: string) => {
    let from = editor.selectionStart, to = editor.selectionEnd;
    let selected = editor.value.slice(from, to);
    if (selected.startsWith(delimiter) && selected.endsWith(delimiter) && selected.length >= delimiter.length * 2) {
      selected = selected.slice(delimiter.length, -delimiter.length);
      replace(editor, selected, from, to, from, from + selected.length);
    } else if (from >= delimiter.length && editor.value.slice(from - delimiter.length, from) === delimiter && editor.value.slice(to, to + delimiter.length) === delimiter) {
      from -= delimiter.length;
      to += delimiter.length;
      replace(editor, selected, from, to, from, from + selected.length);
    } else {
      selected ||= t('chat.formatText');
      replace(editor, delimiter + selected + delimiter, from, to, from + delimiter.length, from + delimiter.length + selected.length);
    }
  };
  const prefix = (editor: MarkdownInput, kind: string, level = 1) => {
    const hadSelection = editor.selectionStart !== editor.selectionEnd;
    const caret = editor.selectionEnd;
    const from = editor.value.slice(0, editor.selectionStart).lastIndexOf('\n') + 1;
    const lastSelected = editor.selectionEnd - (editor.selectionEnd > editor.selectionStart ? 1 : 0);
    const lineEnd = editor.value.indexOf('\n', lastSelected);
    const to = lineEnd < 0 ? editor.value.length : lineEnd;
    const original = editor.value.slice(from, to);
    const pattern = kind === 'heading' ? /^#{1,6}\s+/ : kind === 'quote' ? /^>\s?/ : kind === 'numbered' ? /^\d+\.\s+/ : /^[-*+]\s+/;
    const lines = original.split('\n');
    const activePattern = kind === 'heading' ? new RegExp(`^#{${level}}\\s+`) : pattern;
    const remove = lines.every(line => activePattern.test(line));
    const text = lines.map((line, index) => {
      if (remove) return line.replace(pattern, '');
      const marker = kind === 'heading' ? '#'.repeat(level) + ' ' : kind === 'quote' ? '> '
        : kind === 'numbered' ? `${index + 1}. ` : '- ';
      return marker + line.replace(/^(?:#{1,6}|>|[-*+]|\d+\.)\s+/, '');
    }).join('\n');
    const firstPrefix = text.match(/^(?:#{1,6}|>|[-*+]|\d+\.)\s+/)?.[0].length ?? 0;
    const position = Math.max(from, caret + text.length - original.length);
    replace(editor, text, from, to, hadSelection ? from + firstPrefix : position, hadSelection ? from + text.length : position);
  };
  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-format]') : null;
    const editor = input();
    if (!button || button.disabled || !editor || editor.readOnly || editor.disabled) return;
    const action = button.dataset.format;
    if (action === 'code' && editor.id === 'chat-message-input') return;
    if (action === 'bold' || action === 'italic' || action === 'strike') {
      editor.toggleFormat(action);
      syncFormats();
    } else if (action === 'inline-code') {
      wrap(editor, '`');
    } else if (action === 'heading') {
      const rect = button.getBoundingClientRect();
      headings.open(rect.left, rect.bottom, Array.from({ length: 6 }, (_, index) => ({
        label: `${t('chat.formatHeading')} ${index + 1}`,
        onClick: () => { if (editor.isConnected && !editor.readOnly) prefix(editor, 'heading', index + 1); },
      })), button);
    } else if (action === 'quote' || action === 'numbered' || action === 'bullet') {
      prefix(editor, action);
    } else if (action === 'link') {
      void editEditorLink(editor, button, lifetime.signal);
    } else if (action === 'code') {
      event.stopImmediatePropagation();
      editor.insertText(`\`\`\`\n${editor.value.slice(editor.selectionStart, editor.selectionEnd)}\n\`\`\``);
      editor.focus();
    } else if (action === 'separator') {
      editor.insertText('\n\n---\n\n');
      editor.focus();
    }
  };
  const keepSelection = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('button')) event.preventDefault();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && trigger.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      input()?.focus();
    }
    if (event.target instanceof Node && toolbar.contains(event.target) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.findIndex(button => button === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    const editor = input();
    if (!editor?.hasFocus || event.target instanceof HTMLTextAreaElement
      || !(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || editor.readOnly) return;
    const format = event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : null;
    if (format && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      editor.toggleFormat(format);
      syncFormats();
    }
  };
  trigger.addEventListener('click', onToggle);
  toolbar.addEventListener('mousedown', keepSelection);
  toolbar.addEventListener('click', onClick, true);
  root.addEventListener('focusin', remember);
  root.addEventListener('keydown', onKey, true);
  root.addEventListener('format-change', syncFormats);
  root.addEventListener('input', syncFormats);
  return () => {
    lifetime.abort();
    headings.close();
    trigger.removeEventListener('click', onToggle);
    toolbar.removeEventListener('mousedown', keepSelection);
    toolbar.removeEventListener('click', onClick, true);
    root.removeEventListener('focusin', remember);
    root.removeEventListener('keydown', onKey, true);
    root.removeEventListener('format-change', syncFormats);
    root.removeEventListener('input', syncFormats);
  };
}
