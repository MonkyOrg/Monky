import { t } from '../i18n';
import { reportError } from '../utils/feedback';
import { ImageClipboard } from '../utils/imageClipboard';
import {
  combinedMessageClipboard,
  markdownMessageClipboard,
  renderedMessageClipboard,
  selectedMessageClipboard,
  setMessageClipboardData,
  writeMessageClipboard,
  type MessageClipboardContent,
  type MessageCopyMode,
} from '../utils/messageClipboard';
import { isEditableTarget } from './ChatComposer';
import type { ContextMenuSubmenu } from './ContextMenu';
import { showCopyToast } from './CopyToast';

export interface MessageCopySource {
  /** False once the owning view no longer shows this conversation. */
  isActive(): boolean;
  /** The feed holding the rendered `.chat-message-row` elements. */
  feed(): HTMLElement | null;
  content(messageId: string): MessageClipboardContent | null;
  /** A message made of a single image is copied as that image. */
  image(messageId: string): HTMLImageElement | null;
}

/** What a message puts on the clipboard, read from its rendering when it is on screen. */
export function messageClipboardContent(
  root: ParentNode, messageId: string, markdown: string, attachmentNames: string[],
): MessageClipboardContent {
  if (!markdown.trim()) return { text: attachmentNames.join('\n') || markdown };
  const rendered = root.querySelector(`.chat-message-row[data-message-id="${CSS.escape(messageId)}"] .chat-message-text`);
  return rendered ? renderedMessageClipboard(rendered, markdown) : markdownMessageClipboard(markdown);
}

/** Copy buttons of rendered code blocks (#391); reading the text back keeps highlighting markup off the clipboard. */
export function bindCodeBlockCopyButtons(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('.md-code-copy').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const code = button.closest('.md-code')?.querySelector('code')?.textContent ?? '';
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
      } catch (error) {
        console.warn('[MessageCopy] Could not copy code block', error);
        return;
      }
      const label = button.querySelector('.md-code-copy-label');
      if (!label) return;
      label.textContent = t('chat.codeBlockCopied');
      button.classList.add('md-code-copy--done');
      window.setTimeout(() => {
        label.textContent = t('chat.codeBlockCopy');
        button.classList.remove('md-code-copy--done');
      }, 1600);
    });
  });
}

/**
 * Copying messages out of a chat feed, shared by server channels and direct
 * messages: the copy action and its formatted / Markdown / plain variants,
 * Ctrl+C on a focused message or a selection, and the feedback for each.
 */
export class MessageCopy {
  private requestId = 0;
  private clearFeedback: (() => void) | null = null;
  private readonly images = new ImageClipboard();

  constructor(private readonly source: MessageCopySource) {}

  /** The selected part of the feed; with an id, only a selection touching that message. */
  public selection(messageId?: string): MessageClipboardContent | null {
    const feed = this.source.feed();
    const selection = window.getSelection();
    if (!feed || !selection || selection.isCollapsed) return null;
    if (messageId) {
      const row = feed.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (!row || !selection.rangeCount || !selection.getRangeAt(0).intersectsNode(row)) return null;
    }
    return selectedMessageClipboard(feed, selection);
  }

  public copyMessage(messageId: string, mode: MessageCopyMode = 'formatted', selection: MessageClipboardContent | null = null): Promise<void> {
    if (!this.source.isActive()) return Promise.resolve();
    if (!selection && mode === 'formatted') {
      const image = this.source.image(messageId);
      if (image) return this.copyImage(image);
    }
    const content = this.source.content(messageId);
    return content ? this.copyContent(selection ?? content, mode) : Promise.resolve();
  }

  /** Selected messages: one is copied as usual, several go together under their authors and times. */
  public copyMessages(entries: { messageId: string; heading: string }[]): Promise<void> {
    if (!this.source.isActive() || entries.length === 0) return Promise.resolve();
    if (entries.length === 1) return this.copyMessage(entries[0].messageId);
    const parts = entries.flatMap((entry) => {
      const content = this.source.content(entry.messageId);
      return content ? [{ heading: entry.heading, content }] : [];
    });
    return parts.length ? this.copyContent(combinedMessageClipboard(parts), 'formatted') : Promise.resolve();
  }

  public async copyContent(content: MessageClipboardContent, mode: MessageCopyMode, event?: ClipboardEvent): Promise<void> {
    this.images.cancel();
    const requestId = ++this.requestId;
    this.clearFeedback?.();
    try {
      if (event?.clipboardData) {
        setMessageClipboardData(event.clipboardData, content, mode);
        event.preventDefault();
      } else {
        await writeMessageClipboard(content, mode);
      }
    } catch (error) {
      console.warn('[MessageCopy] Could not copy message', error);
      if (requestId === this.requestId) this.clearFeedback = reportError(t('chat.copyFailed'));
      return;
    }
    if (requestId !== this.requestId) return;
    this.clearFeedback = showCopyToast(t('chat.messageCopied'));
  }

  public async copyImage(image: HTMLImageElement): Promise<void> {
    if (!this.source.isActive() || !image.isConnected) return;
    this.requestId++;
    this.clearFeedback?.();
    await this.images.copy(image.currentSrc || image.src);
  }

  /** The "Copy message" entry; a selection inside the message narrows what is copied. */
  public menuItem(messageId: string): ContextMenuSubmenu {
    const selection = this.selection(messageId);
    const modifier = navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl';
    return {
      label: t('chat.copyMessage'), icon: 'content_copy',
      onClick: () => { void this.copyMessage(messageId, 'formatted', selection); },
      submenu: [
        { label: t('chat.copyFormatted'), shortcut: `${modifier}+C`,
          onClick: () => { void this.copyMessage(messageId, 'formatted', selection); } },
        { label: t('chat.copyMarkdown'),
          onClick: () => { void this.copyMessage(messageId, 'markdown', selection); } },
        { label: t('chat.copyPlain'), shortcut: `${modifier}+Shift+C`,
          onClick: () => { void this.copyMessage(messageId, 'plain', selection); } },
      ],
    };
  }

  /** Ctrl+C and the copy event for a focused message or a selection inside the feed. */
  public bind(): () => void {
    const onCopyKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey ||
          !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return;
      const content = this.keyboardContent(event.target);
      if (!content) return;
      event.preventDefault();
      if (!event.shiftKey && window.getSelection()?.isCollapsed !== false) {
        const image = this.focusedImage();
        if (image) { void this.copyImage(image); return; }
      }
      void this.copyContent(content, event.shiftKey ? 'plain' : 'formatted');
    };
    const onCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const content = this.keyboardContent(event.target);
      if (content && window.getSelection()?.isCollapsed !== false) {
        const image = this.focusedImage();
        if (image) { event.preventDefault(); void this.copyImage(image); return; }
      }
      if (content) void this.copyContent(content, 'formatted', event);
    };
    document.addEventListener('keydown', onCopyKey);
    document.addEventListener('copy', onCopy);
    return () => {
      document.removeEventListener('keydown', onCopyKey);
      document.removeEventListener('copy', onCopy);
    };
  }

  /** Pending copies and their feedback must not outlive the view. */
  public cancel(): void {
    this.requestId++;
    this.images.cancel();
    this.clearFeedback?.();
  }

  private keyboardContent(target: EventTarget | null): MessageClipboardContent | null {
    if (!this.source.isActive() || isEditableTarget(target) || isEditableTarget(document.activeElement)) return null;
    const feed = this.source.feed();
    const element = target instanceof Element ? target : document.activeElement;
    if (!feed?.isConnected || (element !== document.body && element !== document.documentElement && !feed.contains(element))) return null;
    // An unsupported or out-of-chat selection must never fall back to copying a whole row.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return this.selection();
    const row = document.activeElement?.closest<HTMLElement>('.chat-message-row');
    return row && feed.contains(row) ? this.source.content(row.dataset.messageId ?? '') : null;
  }

  private focusedImage(): HTMLImageElement | null {
    const id = document.activeElement?.closest<HTMLElement>('.chat-message-row')?.dataset.messageId;
    return id ? this.source.image(id) : null;
  }
}
