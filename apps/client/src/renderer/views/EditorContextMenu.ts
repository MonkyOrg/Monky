import type { EditorCommand } from '@monky/shared';
import { t } from '../i18n';
import { findAutomaticLinks } from '../utils/markdown';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { MarkdownInput } from './MarkdownInput';
import { editEditorLink } from './LinkPopover';
import { showAlert } from './Dialog';
import { showCopyToast } from './CopyToast';

export function bindEditorContextMenu(root: HTMLElement): () => void {
  const menu = new ContextMenu();
  const lifetime = new AbortController();
  let clearFeedback: (() => void) | null = null;
  const onContextMenu = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('button, select, summary')) return;
    const host = target.closest('monky-markdown-input');
    const code = target.closest('textarea');
    const input = code instanceof HTMLTextAreaElement && code.closest('.chat-code-input') ? code
      : host instanceof MarkdownInput ? host : null;
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    const original = input.value, from = input.selectionStart, to = input.selectionEnd;
    const editable = () => !input.readOnly && !input.disabled && !input.closest('fieldset:disabled');
    const run = (action: () => void | Promise<void>, mutation = false) => { void (async () => {
      if (lifetime.signal.aborted || !input.isConnected) return;
      if (input.value !== original || (mutation && !editable())) {
        void showAlert({ message: t('chat.editorChanged'), variant: 'warning' });
        return;
      }
      input.focus();
      input.setSelectionRange(from, to);
      try { await action(); }
      catch (error) {
        console.warn('[Editor] Context action failed:', error);
        if (!lifetime.signal.aborted && input.isConnected) {
          void showAlert({ message: t('chat.editorActionFailed'), variant: 'danger' });
        }
      }
    })(); };
    const link = input instanceof MarkdownInput ? input.linkAt(target) : null;
    let items: ContextMenuItem[];
    if (link && input instanceof MarkdownInput) {
      items = [
        { label: t('chat.copyLink'), icon: 'link', onClick: () => run(async () => {
          clearFeedback?.();
          await navigator.clipboard.writeText(link.url);
          if (!lifetime.signal.aborted && input.isConnected) clearFeedback = showCopyToast(t('chat.messageCopied'));
        }) },
        { label: t('chat.openLink'), icon: 'public', onClick: () => run(async () => {
          if (!(await window.api.openExternal(link.url)).success) throw new Error('External link opening failed');
        }) },
        { label: t('chat.editLink'), icon: 'edit', disabled: !editable(), onClick: () => run(() =>
          editEditorLink(input, input, lifetime.signal, link.from, link.to,
            link.label.replace(/\\([\\[\]])/g, '$1'), link.url), true) },
        { label: t('chat.removeLink'), icon: 'link_off', disabled: !editable(), onClick: () => run(() => {
          let text = link.label;
          // Markdown escapes prevent an unlinked URL label from immediately autolinking again.
          for (const automatic of findAutomaticLinks(text).reverse()) {
            const position = automatic.from + (/^www\./i.test(text.slice(automatic.from)) ? 3
              : text.slice(automatic.from, automatic.to).indexOf(':'));
            text = text.slice(0, position) + '\\' + text.slice(position);
          }
          if (input.maxLength >= 0 && original.length - (link.to - link.from) + text.length > input.maxLength) {
            void showAlert({ message: t('chat.messageTooLong', { max: input.maxLength }), variant: 'danger' });
            return;
          }
          input.insertText(text, link.from, link.to);
          input.setSelectionRange(link.from + text.length, link.from + text.length);
          input.focus();
        }, true) },
      ];
    } else {
      const modifier = /Mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl';
      const command = (action: EditorCommand, label: string, shortcut: string, disabled = false): ContextMenuItem => ({
        label, shortcut: `${modifier}+${shortcut}`, disabled,
        onClick: () => run(async () => {
          if (action === 'cut' || action === 'copy') clearFeedback?.();
          if (!(await window.api.editorCommand(action)).success) throw new Error('Native editor command rejected');
          if ((action === 'cut' || action === 'copy') && !lifetime.signal.aborted && input.isConnected) {
            clearFeedback = showCopyToast(t(action === 'cut' ? 'chat.textCut' : 'chat.messageCopied'));
          }
        }, action === 'cut' || action === 'paste' || action === 'pasteAndMatchStyle'),
      });
      items = [
        command('cut', t('chat.cut'), 'X', !editable() || from === to),
        command('copy', t('chat.copy'), 'C', from === to),
        command('paste', t('chat.paste'), 'V', !editable()),
        command('pasteAndMatchStyle', t('chat.pastePlain'), 'Shift+V', !editable()),
        command('selectAll', t('chat.selectAll'), 'A', !original),
      ];
    }
    menu.open(event.clientX, event.clientY, items, input);
  };
  root.addEventListener('contextmenu', onContextMenu);
  return () => { lifetime.abort(); clearFeedback?.(); menu.close(); root.removeEventListener('contextmenu', onContextMenu); };
}
