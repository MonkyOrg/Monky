import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { pasteMonkyClipboard } from '../utils/messageClipboard';
import { bindEditorContextMenu } from './EditorContextMenu';
import { bindChatComposerMotion } from './FooterControlsMotion';
import { bindFormattingToolbar, renderFormattingToolbar } from './FormattingToolbar';
import type { MarkdownInput } from './MarkdownInput';

export interface ChatComposerMarkup {
  /** Server channels add polls, stickers and message blocks to the composer direct messages also use. */
  kind: 'channel' | 'direct';
  placeholder: string;
  /** Longest message accepted; 0 means unlimited. */
  maxLength: number;
}

export interface ChatComposerBehavior {
  input: MarkdownInput;
  /** False once the owning view left or replaced this composer. */
  isActive(): boolean;
  /** Whether files would be taken right now; dragging them over the conversation shows the drop area only then. */
  canAcceptFiles(): boolean;
  /** Files pasted, dropped on the conversation or picked with the attach button; returns true when they were taken. */
  acceptFiles(files: FileList): boolean;
  focus(): void;
}

export interface ComposerEditMode {
  /** A sent message is being edited. */
  editing: boolean;
  /** The edit is on its way to be saved. */
  saving: boolean;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
  return !!element?.closest('textarea, input, select, monky-markdown-input, [contenteditable]:not([contenteditable="false"])');
}

export function renderChatEditComposer(): string {
  return `<div id="chat-edit-composer" class="chat-edit-composer" hidden>
            <div class="chat-edit-heading">
              <span class="material-symbols-outlined md-18" aria-hidden="true">edit</span>
              <strong id="chat-edit-label" role="status">${t('chat.editingMessage')}</strong>
              <button type="button" id="btn-cancel-message-edit" class="btn btn-secondary">${t('common.cancel')}</button>
            </div>
            <p id="chat-edit-hint">${t('chat.editComposerHint')}</p>
            <p id="chat-edit-error" class="chat-edit-error" role="alert" hidden></p>
          </div>`;
}

/**
 * The message composer of server channels and direct messages. Both render this
 * markup and bind it with {@link bindChatComposer}, so neither can lose the
 * formatting bar, the editor menu or the clipboard handling the other has.
 */
export function renderChatComposer({ kind, placeholder, maxLength }: ChatComposerMarkup): string {
  const channel = kind === 'channel';
  const attachLabel = t(channel ? 'chat.moreActions' : 'chat.attachFile');
  return `<div class="chat-composer-surface">
          ${renderFormattingToolbar()}
          <div id="chat-reply-composer" class="chat-reply-composer" hidden></div>
          ${channel ? `<div id="chat-composer-blocks" aria-label="${t('chat.composerBlocks')}" hidden></div>` : ''}
          <div class="chat-input-wrapper">
            <div class="chat-create-wrap">
            <button id="btn-attach" type="button" class="chat-attach-btn" title="${attachLabel}"
              aria-label="${attachLabel}"${channel ? ' aria-expanded="false" aria-controls="chat-create-menu"' : ''}>
              <span class="material-symbols-outlined md-22">add</span>
            </button>
            ${channel ? `<div id="chat-create-menu" class="chat-create-menu" role="menu" hidden>
              <button type="button" role="menuitem" data-chat-create="attachment">
                <span class="material-symbols-outlined md-20">attach_file</span><span>${t('chat.attachFile')}</span>
              </button>
              <button type="button" role="menuitem" data-chat-create="poll">
                <span class="material-symbols-outlined md-20">poll</span><span>${t('poll.create')}</span>
              </button>
            </div>` : ''}</div>
            <input id="chat-file-input" type="file" multiple style="display: none;">
            <button id="btn-emoji" type="button" class="chat-attach-btn" title="${t(channel ? 'chat.emojiPickerTitle' : 'chat.emojiAction')}">
              <span class="material-symbols-outlined md-22">mood</span>
            </button>
            <button id="btn-format" type="button" class="chat-attach-btn" title="${t('chat.formatting')}" aria-label="${t('chat.formatting')}" aria-expanded="false" aria-controls="chat-format-toolbar">
              <span class="material-symbols-outlined md-22">format_size</span>
            </button>
            <monky-markdown-input id="chat-message-input" class="chat-input-field" placeholder="${escapeHtml(placeholder)}" ${maxLength > 0 ? `maxlength="${maxLength}"` : ''}></monky-markdown-input>
            <span id="chat-char-counter" class="chat-char-count">0/${maxLength > 0 ? maxLength : '∞'}</span>
            <button type="button" id="btn-send-message" class="btn btn-primary chat-send-btn">
              <span class="material-symbols-outlined md-16" aria-hidden="true">send</span>
              <span class="chat-send-label">${t('chat.send')}</span>
            </button>
          </div>
          </div>`;
}

/**
 * Editing a sent message turns the composer into the edit composer: the banner
 * shows, Send becomes Save (or "Saving…") and attachments step aside. Server
 * channels and direct messages switch it the same way; enabling the buttons
 * stays with each view, whose rules differ.
 */
export function setComposerEditMode(root: ParentNode, { editing, saving }: ComposerEditMode): void {
  root.querySelector('.chat-input-container')?.classList.toggle('chat-input-container--editing', editing);
  const banner = root.querySelector<HTMLElement>('#chat-edit-composer');
  if (banner) banner.hidden = !editing;
  const cancel = root.querySelector<HTMLButtonElement>('#btn-cancel-message-edit');
  if (cancel) cancel.disabled = saving;
  const input = root.querySelector<HTMLElement>('#chat-message-input');
  // Each attribute change reconfigures the editor, so only real changes are written.
  const describedBy = editing ? 'chat-edit-hint chat-edit-error' : null;
  if (input && input.getAttribute('aria-describedby') !== describedBy) {
    if (describedBy) input.setAttribute('aria-describedby', describedBy);
    else input.removeAttribute('aria-describedby');
  }
  const attach = root.querySelector<HTMLButtonElement>('#btn-attach');
  if (attach) attach.style.display = editing ? 'none' : '';
  const send = root.querySelector<HTMLButtonElement>('#btn-send-message');
  if (!send) return;
  send.setAttribute('aria-busy', String(saving));
  const label = send.querySelector('.chat-send-label');
  const text = t(saving ? 'chat.editSaving' : editing ? 'common.save' : 'chat.send');
  if (label && label.textContent !== text) label.textContent = text;
  const icon = send.querySelector('.material-symbols-outlined');
  if (icon) icon.textContent = saving ? 'hourglass_empty' : editing ? 'check' : 'send';
}

/**
 * Formatting, editor menu, motion and file handling shared by every chat
 * composer: files arrive by paste, by the attach button's picker or dropped
 * anywhere on the conversation, and all three go through `acceptFiles`.
 */
export function bindChatComposer(root: HTMLElement, behavior: ChatComposerBehavior): () => void {
  const { input } = behavior;
  const unbind = [bindChatComposerMotion(root), bindFormattingToolbar(root), bindEditorContextMenu(root)];
  const onInputPaste = (event: ClipboardEvent) => {
    if (!behavior.isActive() || event.defaultPrevented) return;
    if (event.target instanceof HTMLTextAreaElement && event.target.closest('.chat-code-input')) return;
    const files = event.clipboardData?.files;
    if (files && files.length > 0) {
      if (behavior.acceptFiles(files)) event.preventDefault();
      return;
    }
    // A message copied from Monky comes back as its Markdown, not as flattened text.
    if (event.clipboardData && pasteMonkyClipboard(input, event.clipboardData)) event.preventDefault();
  };
  // Ctrl+V outside any field still attaches files, so a pasted screenshot is never lost.
  const onGlobalPaste = (event: ClipboardEvent) => {
    if (!behavior.isActive() || isEditableTarget(event.target)) return;
    const files = event.clipboardData?.files;
    if (!files || files.length === 0 || !behavior.acceptFiles(files)) return;
    event.preventDefault();
    behavior.focus();
  };
  const shells = [root.querySelector<HTMLElement>('.chat-input-container'), root.querySelector<HTMLElement>('.chat-input-wrapper')];
  const focusFromShell = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.defaultPrevented || isEditableTarget(target)) return;
    if (target?.closest('button, select, summary, .mention-dropup, #chat-attachment-tray, #chat-command-composer')) return;
    requestAnimationFrame(() => behavior.focus());
  };
  const picker = root.querySelector<HTMLInputElement>('#chat-file-input');
  const onPicked = () => {
    if (picker?.files?.length && behavior.isActive()) behavior.acceptFiles(picker.files);
    if (picker) picker.value = '';
  };
  // Entering a child element leaves its parent, so the drop area follows how deep the drag is.
  const conversation = root.querySelector<HTMLElement>('.chat-container');
  let dragDepth = 0;
  const carriesFiles = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  const onDragEnter = (event: DragEvent) => {
    if (!behavior.isActive() || !carriesFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    if (behavior.canAcceptFiles()) conversation?.classList.add('chat-drag-over');
  };
  const onDragOver = (event: DragEvent) => {
    if (!behavior.isActive() || !carriesFiles(event) || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = behavior.canAcceptFiles() ? 'copy' : 'none';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) conversation?.classList.remove('chat-drag-over');
  };
  const onDrop = (event: DragEvent) => {
    dragDepth = 0;
    conversation?.classList.remove('chat-drag-over');
    const files = event.dataTransfer?.files;
    if (!behavior.isActive() || !files?.length) return;
    // Taken or not, a file dropped on the conversation must never make the page open it.
    event.preventDefault();
    if (behavior.canAcceptFiles()) behavior.acceptFiles(files);
  };
  input.addEventListener('paste', onInputPaste, true);
  document.addEventListener('paste', onGlobalPaste);
  for (const shell of shells) shell?.addEventListener('mousedown', focusFromShell);
  picker?.addEventListener('change', onPicked);
  root.addEventListener('dragenter', onDragEnter);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);
  return () => {
    unbind.forEach((off) => off());
    input.removeEventListener('paste', onInputPaste, true);
    document.removeEventListener('paste', onGlobalPaste);
    for (const shell of shells) shell?.removeEventListener('mousedown', focusFromShell);
    picker?.removeEventListener('change', onPicked);
    root.removeEventListener('dragenter', onDragEnter);
    root.removeEventListener('dragover', onDragOver);
    root.removeEventListener('dragleave', onDragLeave);
    root.removeEventListener('drop', onDrop);
    conversation?.classList.remove('chat-drag-over');
  };
}
