import { ChatMessage, EVERYONE_MENTION_TOKENS, LIMITS, MessageType, Permission, hasEveryoneMention } from '@monky/shared';
import type { AttachmentMeta, MessageReply, SlashCommand, StickerEntry, UserSummary } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { networkClient, getActiveNetworkClient } from '../core/NetworkClient';
import { chatStore, getActiveChatStore, type BotInvocation } from '../stores/chatStore';
import { serverStore, getActiveServerStore } from '../stores/serverStore';
import { participantManager } from '../core/ParticipantManager';
import { userContextMenu } from './UserContextMenu';
import { contextMenu, ContextMenuItem } from './ContextMenu';
import { getAvatarUrl } from '../utils/avatar';
import { renderMarkdown } from '../utils/markdown';
import { toMarkdown, toPortableHtml, writeRichText } from '../utils/clipboardMarkdown';
import { getLanguage, t } from '../i18n';
import { uploadAttachment, UploadHandle } from '../core/AttachmentUploader';
import { getAttachmentUrl, formatBytes, fileIconName } from '../utils/attachment';
import { showAlert, showConfirm } from './Dialog';
import { downloadLightboxFile, lightboxModal, LightboxMedia } from './LightboxModal';
import { linkPreviewService } from '../core/LinkPreviewService';
import { initializeCustomVideoPlayers } from '../utils/videoPlayer';
import { EmojiPicker } from './EmojiPicker';
import { buildCodeMessage, codeBlockModal } from './CodeBlockModal';
import { stickerService } from '../core/StickerService';
import { settingsStore } from '../stores/settingsStore';
import { extractStickerIds, stickerToken, stripStickerTokens } from '../utils/stickers';
import { parseTypedCommand } from '../utils/botInputs';
import { BotChatView, renderBotInvocation } from './BotChatView';
import { groupCommands, type CommandGroup } from '../utils/commandCatalog';
import { renderCommandCatalog } from './commandCatalog';
import { renderBotCommandContext } from './botResponse';
import { PublicSelectorView } from './PublicSelectorView';

/** How close to the end the feed must be to keep following new messages (#270). */
const BOTTOM_SCROLL_THRESHOLD_PX = 48;

/** A file picked for upload, tracked until its message is sent (#11). */
interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  isImage: boolean;
  previewUrl: string | null;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  meta?: AttachmentMeta;
  error?: string;
  handle?: UploadHandle;
}

/** An entry in the @-mention dropup: a member or the channel-wide token (#464). */
type MentionCandidate =
  | { kind: 'user'; user: UserSummary }
  | { kind: 'everyone'; token: string };

export class ChatView {
  private container: HTMLElement;
  private currentChannelId: string | null = null;
  private unbindEvents: Array<() => void> = [];
  /** Tracks whether the feed is following the end of the conversation (#270). */
  private pinnedToBottom = true;
  // @-mention autocomplete state (#14). The list may also offer the
  // channel-wide token (#464), which is not a user.
  private mentionActive = false;
  private mentionMatches: MentionCandidate[] = [];
  private mentionActiveIndex = 0;
  private mentionAtIndex = -1;
  // /-command autocomplete state (#569).
  private commandActive = false;
  private commandMatches: SlashCommand[] = [];
  private commandGroups: CommandGroup[] = [];
  private commandActiveIndex = 0;
  private commandQuery = '';
  private botChat: BotChatView | null = null;
  private publicSelectors: PublicSelectorView | null = null;
  // Files picked for the next message, keyed by a local id (#11).
  private pending: PendingAttachment[] = [];
  /** Message currently open in the inline editor, if any (#504). */
  private editingMessageId: string | null = null;
  private uploadSeq = 0;
  /** Emoji/sticker popover anchored to the composer (#356). */
  private emojiPicker: EmojiPicker | null = null;
  private reactionPicker: EmojiPicker | null = null;
  private pendingJumpId: string | null = null;
  private copyRequestId = 0;
  private clearCopyFeedback: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public setChannel(channelId: string): void {
    if (this.currentChannelId === channelId && this.container.querySelector('#chat-messages-feed')) {
      // Channel is already active and rendered; keep existing DOM and media state
      this.focusChatInput({ defer: true });
      return;
    }

    this.currentChannelId = channelId;
    this.pendingJumpId = null;
    // Switching channels discards any files staged for the previous channel (#11).
    this.clearPending();
    // Opening a channel reads its mentions: clear the local badge and tell the
    // server so offline-delivered mentions aren't re-shown next connect (#14).
    chatStore.clearMention(channelId);
    chatStore.clearUnread(channelId);
    networkClient.send(MessageType.CHAT_MENTIONS_READ, { channelId });
    this.render();
    this.loadHistory();
    // Auto-focus the message input after the fresh DOM has settled (#181).
    this.focusChatInput({ defer: true });
  }

  public render(): void {
    this.unbindListeners();

    if (!this.currentChannelId || !serverStore.serverDetails) {
      this.container.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
          ${t('chat.selectChannel')}
        </div>
      `;
      return;
    }

    const channel = serverStore.serverDetails.channels.find((c) => c.id === this.currentChannelId);
    const channelName = channel ? channel.name : 'geral';

    this.container.innerHTML = `
      <div class="chat-container">
        <div id="chat-drop-overlay" class="chat-drop-overlay">
          <div class="drop-inner">
            <span class="material-symbols-outlined" style="font-size: 48px;">upload_file</span>
            <div class="drop-title">${t('chat.dropTitle')}</div>
            <div class="drop-sub">${t('chat.dropSubtitle')}</div>
          </div>
        </div>
        <div class="content-header">
          <div class="channel-title-container">
            <span class="material-symbols-outlined md-18" style="color: var(--text-muted);">tag</span>
            <span class="channel-title">${escapeHtml(channelName)}</span>
          </div>
          <div class="header-status-badge">${t('chat.textChannelBadge')}</div>
        </div>

        <div id="chat-messages-feed" class="chat-messages-feed"></div>
        <button type="button" id="chat-return-latest" class="btn btn-secondary" hidden>${t('chat.returnLatest')}</button>

        <div class="chat-input-container">
          <div id="chat-reply-composer" class="chat-reply-composer" hidden></div>
          <div id="mention-dropup" class="mention-dropup" style="display: none;"></div>
          <div id="command-dropup" class="command-dropup" style="display: none;"></div>
          <div id="chat-attachment-tray" class="chat-attachment-tray" style="display: none;"></div>
          <div id="chat-compose-link-preview" class="chat-compose-link-preview" style="display: none;"></div>
          <div id="chat-send-permission-banner" class="chat-permission-banner" style="display: none;"></div>
          <div id="chat-command-notice" class="bot-error" role="alert" hidden></div>
          <div id="chat-command-composer" class="bot-command-composer" hidden></div>
          <div class="chat-input-wrapper">
            <button id="btn-attach" type="button" class="chat-attach-btn" title="${t('chat.attachFile')}">
              <span class="material-symbols-outlined md-22">add_circle</span>
            </button>
            <input id="chat-file-input" type="file" multiple style="display: none;">
            <button id="btn-emoji" type="button" class="chat-attach-btn" title="${t('chat.emojiPickerTitle')}">
              <span class="material-symbols-outlined md-22">mood</span>
            </button>
            <button id="btn-code" type="button" class="chat-attach-btn" title="${t('chat.codeBlockTitle')}">
              <span class="material-symbols-outlined md-22">code</span>
            </button>
            <textarea id="chat-message-input" class="chat-input-field" rows="1" placeholder="${t('chat.inputPlaceholder', { channel: escapeHtml(channelName) })}" maxlength="${LIMITS.MAX_MESSAGE_LENGTH}"></textarea>
            <span id="chat-char-counter" class="chat-char-count">0/${LIMITS.MAX_MESSAGE_LENGTH}</span>
            <button id="btn-send-message" class="btn btn-primary chat-send-btn">
              <span class="material-symbols-outlined md-16">send</span>
              ${t('chat.send')}
            </button>
          </div>
        </div>
      </div>
    `;

    this.renderMessages({ forceScroll: true });
    this.attachEvents();
  }

  private loadHistory(): void {
    if (!this.currentChannelId) return;

    networkClient.send(MessageType.CHAT_LOAD_HISTORY, {
      channelId: this.currentChannelId,
      limit: LIMITS.MAX_HISTORY_MESSAGES_INITIAL,
    });
  }

  private renderMessages(options: { forceScroll?: boolean } = {}): void {
    const feed = document.getElementById('chat-messages-feed');
    if (!feed || !this.currentChannelId) return;
    contextMenu.close();
    this.reactionPicker?.close();

    // Read before the feed is replaced: new messages only pull the view down when
    // the user is already reading the end of the conversation (#270).
    const shouldScroll = options.forceScroll === true || this.isFeedAtBottom(feed);

    // The feed is rebuilt from scratch, so any open inline editor goes with it.
    this.editingMessageId = null;

    const messages = chatStore.getMessages(this.currentChannelId);
    if (messages.length === 0 && chatStore.getInvocations(this.currentChannelId).length === 0) {
      feed.innerHTML = `
        <div id="chat-empty-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); gap: 10px;">
          <span class="material-symbols-outlined" style="color: var(--text-dim); font-size: 44px;">forum</span>
          <div style="font-size: 15px; font-weight: 600; color: var(--text-secondary);">${t('chat.emptyTitle', { channel: escapeHtml(serverStore.serverDetails?.channels.find((c) => c.id === this.currentChannelId)?.name || 'geral') })}</div>
          <div style="font-size: 13px;">${t('chat.emptySubtitle')}</div>
        </div>
      `;
      return;
    }

    feed.innerHTML = this.renderMessagesWithDividers(messages);
    this.bindMessageElementEvents(feed);

    this.pinnedToBottom = shouldScroll;
    if (shouldScroll) {
      this.scrollToBottom();
      this.repinWhileMediaLoads(feed);
    }
  }

  private appendMessage(msg: ChatMessage, options: { forceScroll?: boolean } = {}): void {
    const feed = document.getElementById('chat-messages-feed');
    if (!feed || !this.currentChannelId) return;

    // If empty placeholder is shown, remove it cleanly before appending the new message
    const placeholder = feed.querySelector('#chat-empty-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    const shouldScroll = options.forceScroll === true || this.isFeedAtBottom(feed);
    const messages = chatStore.getMessages(this.currentChannelId);
    const prevMsg = messages.length > 1 ? messages[messages.length - 2] : null;
    const currKey = this.dateKey(msg.createdAt);
    const prevKey = prevMsg ? this.dateKey(prevMsg.createdAt) : '';

    const fragment = document.createDocumentFragment();

    if (currKey !== prevKey) {
      const dividerWrapper = document.createElement('div');
      dividerWrapper.innerHTML = this.renderDateDivider(msg.createdAt);
      if (dividerWrapper.firstElementChild) {
        fragment.appendChild(dividerWrapper.firstElementChild);
      }
    }

    const rowWrapper = document.createElement('div');
    rowWrapper.innerHTML = this.renderMessageRow(msg);
    const rowEl = rowWrapper.firstElementChild as HTMLElement;
    if (rowEl) {
      this.bindMessageElementEvents(rowEl);
      fragment.appendChild(rowEl);
    }

    feed.appendChild(fragment);

    this.pinnedToBottom = shouldScroll;
    if (shouldScroll) {
      this.scrollToBottom();
      if (rowEl) {
        this.repinWhileMediaLoads(rowEl);
      }
    }
  }

  private bindMessageElementEvents(container: HTMLElement): void {
    // Open markdown links in the external browser instead of navigating the app.
    container.querySelectorAll('a.md-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const url = link.getAttribute('data-external-link');
        if (url && window.api?.openExternal) {
          window.api.openExternal(url);
        }
      });
    });

    linkPreviewService.initializePreviews(container);

    // Copy button on code blocks (#391). Reading the rendered text back means
    // the highlighting markup never leaks into what lands on the clipboard.
    container.querySelectorAll('.md-code-copy').forEach((button) => {
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const code = button.closest('.md-code')?.querySelector('code')?.textContent ?? '';
        if (!code) return;
        try {
          await navigator.clipboard.writeText(code);
        } catch (err) {
          console.warn('[ChatView] Could not copy code block', err);
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

    // Attach right-click context menu on message rows (when not selecting text)
    const rows = container.classList.contains('chat-message-row')
      ? [container]
      : Array.from(container.querySelectorAll<HTMLElement>('.chat-message-row'));

    rows.forEach((row) => {
      this.bindReactionButtons(row);
      row.querySelector<HTMLButtonElement>('[data-message-action="reply"]')?.addEventListener('click', () => {
        this.startReply(row.dataset.messageId ?? '');
      });
      row.querySelector<HTMLButtonElement>('[data-message-action="copy"]')?.addEventListener('click', () => {
        void this.copyMessage(row.dataset.messageId ?? '');
      });
      const more = row.querySelector<HTMLButtonElement>('[data-message-action="more"]');
      more?.addEventListener('click', () => {
        this.reactionPicker?.close();
        const rect = more.getBoundingClientRect();
        contextMenu.open(rect.right, rect.bottom, this.buildMessageMenuItems(row.dataset.messageId ?? null), more);
      });
      row.querySelector<HTMLButtonElement>('[data-reply-target]')?.addEventListener('click', (event) => {
        const button = event.currentTarget;
        if (button instanceof HTMLButtonElement && button.dataset.replyTarget) this.jumpToMessage(button.dataset.replyTarget);
      });
      row.addEventListener('contextmenu', (e: Event) => {
        const mouseEvent = e as MouseEvent;
        // If text is currently highlighted / selected, allow normal browser selection copy
        const selection = window.getSelection()?.toString();
        if (selection && selection.trim().length > 0) {
          return;
        }

        const userId = row.getAttribute('data-user-id');
        if (!userId) return;

        const messageActions = this.buildMessageMenuItems(row.getAttribute('data-message-id'));

        const targetUser =
          participantManager.getByUserId(userId)?.user ||
          serverStore.serverDetails?.members.find((m) => m.id === userId);

        // On someone else's message the person's menu is the one that opens, so
        // the message actions ride along inside it. Deciding by "are there
        // message actions?" would have hidden the whole user menu the moment
        // Copy became available on every message (#516).
        if (targetUser && targetUser.id !== serverStore.currentUser?.id) {
          mouseEvent.preventDefault();
          userContextMenu.open(mouseEvent.clientX, mouseEvent.clientY, targetUser, messageActions);
          return;
        }

        if (messageActions.length > 0) {
          mouseEvent.preventDefault();
          contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, messageActions);
        }
      });
    });

    this.bindMediaInteractions(container);
    initializeCustomVideoPlayers(container);
  }

  /**
   * The current selection, when it lies inside the message feed (#516).
   *
   * Returns null for a selection anywhere else — the member list, the composer,
   * a modal — so copying outside the conversation keeps the browser's own
   * behaviour untouched.
   */
  private selectedMessageFragment(): DocumentFragment | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const feed = document.getElementById('chat-messages-feed');
    if (!feed) return null;

    // Both ends must be in the feed: a selection that starts in the
    // conversation and ends outside it is not ours to rewrite.
    const { anchorNode, focusNode } = selection;
    if (!anchorNode || !focusNode) return null;
    if (!feed.contains(anchorNode) || !feed.contains(focusNode)) return null;

    const range = selection.getRangeAt(0);
    let fragment = range.cloneContents();

    // cloneContents hands back the selected nodes without anything above them,
    // so a word picked out of **importante** comes back as bare text and the
    // rewrite would lose the very formatting it exists to keep. The ancestors
    // up to the message text are cloned back around it, empty, which restores
    // the context without dragging in a character that was not selected.
    const start = range.commonAncestorContainer;
    let ancestor = start.nodeType === Node.ELEMENT_NODE ? (start as HTMLElement) : start.parentElement;
    while (ancestor && ancestor !== feed && !ancestor.classList.contains('chat-message-text')) {
      const wrapper = ancestor.cloneNode(false) as HTMLElement;
      wrapper.appendChild(fragment);
      fragment = document.createDocumentFragment();
      fragment.appendChild(wrapper);
      ancestor = ancestor.parentElement;
    }

    return fragment;
  }

  /**
   * The Edit / Delete entries offered for one message (#504).
   *
   * Editing belongs to the author alone and only while the server allows it;
   * deleting is the author's too, plus anyone with MANAGE_SERVER, who needs to
   * be able to clean up after other people. Deleted and system messages offer
   * nothing.
   */
  private buildMessageMenuItems(messageId: string | null): ContextMenuItem[] {
    if (!messageId || !this.currentChannelId) return [];
    const message = chatStore.getMessages(this.currentChannelId).find((m) => m.id === messageId);
    if (!message || message.isSystem || message.isEphemeral || message.deletedAt) return [];

    const isAuthor = !!serverStore.currentUser && message.userId === serverStore.currentUser.id;
    const canModerate = serverStore.hasPermission(Permission.MANAGE_SERVER);
    const editingAllowed = serverStore.serverDetails?.allowMessageEdit !== false;

    const items: ContextMenuItem[] = [];
    if (serverStore.hasPermission(Permission.SEND_MESSAGES)) {
      items.push({
        label: t('chat.emojiAction'), icon: 'add_reaction',
        onClick: () => this.container.querySelector<HTMLButtonElement>(
          `.chat-message-row[data-message-id="${CSS.escape(message.id)}"] .chat-reaction-add`
        )?.click(),
      }, { label: t('chat.replyMessage'), icon: 'reply', onClick: () => this.startReply(message.id) });
    }
    items.push({ label: t('chat.copyMessage'), icon: 'content_copy', onClick: () => { void this.copyMessage(message.id); } });
    if (isAuthor && editingAllowed) {
      items.push({
        label: t('chat.editMessage'),
        icon: 'edit',
        onClick: () => this.startEditingMessage(message.id),
      });
    }
    if (isAuthor || canModerate) {
      items.push({
        label: t('chat.deleteMessage'),
        icon: 'delete',
        danger: true,
        onClick: () => void this.confirmDeleteMessage(message.id),
      });
    }
    return items;
  }

  /** Swaps a message's text for an inline editor (#504). */
  private startEditingMessage(messageId: string): void {
    if (!this.currentChannelId) return;
    const row = document.querySelector<HTMLElement>(
      `#chat-messages-feed .chat-message-row[data-message-id="${CSS.escape(messageId)}"]`
    );
    const message = chatStore.getMessages(this.currentChannelId).find((m) => m.id === messageId);
    if (!row || !message) return;

    // Only one editor at a time, otherwise leaving one open and starting
    // another would strand the first without a way back.
    this.cancelMessageEdit();

    const body = row.querySelector('.chat-message-body');
    const textEl = row.querySelector<HTMLElement>('.chat-message-text');
    if (!body) return;

    const editor = document.createElement('div');
    editor.className = 'chat-message-editor';
    editor.innerHTML = `
      <textarea class="chat-message-edit-input" rows="1">${escapeHtml(message.content)}</textarea>
      <div class="chat-message-edit-hint">${t('chat.editHint')}</div>
    `;

    if (textEl) textEl.style.display = 'none';
    body.insertBefore(editor, textEl ? textEl.nextSibling : null);
    this.editingMessageId = messageId;

    const input = editor.querySelector('textarea') as HTMLTextAreaElement;
    const autoGrow = () => {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    };
    autoGrow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelMessageEdit();
        return;
      }
      // Shift+Enter keeps inserting line breaks, same as the composer.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submitMessageEdit(messageId, input.value);
      }
    });
  }

  private submitMessageEdit(messageId: string, content: string): void {
    const trimmed = content.trim();
    const original = this.currentChannelId
      ? chatStore.getMessages(this.currentChannelId).find((m) => m.id === messageId)
      : undefined;

    // An empty edit is a deletion in disguise; asking for it explicitly keeps
    // the two actions distinguishable in the UI (#504).
    if (trimmed.length === 0) {
      this.cancelMessageEdit();
      void this.confirmDeleteMessage(messageId);
      return;
    }

    if (!original || trimmed === original.content) {
      this.cancelMessageEdit();
      return;
    }

    networkClient.send(MessageType.CHAT_EDIT, {
      channelId: original.channelId,
      messageId,
      content: trimmed,
    });
    this.cancelMessageEdit();
  }

  /** Closes the inline editor and puts the original text back on screen. */
  private cancelMessageEdit(): void {
    if (!this.editingMessageId) return;
    const row = document.querySelector<HTMLElement>(
      `#chat-messages-feed .chat-message-row[data-message-id="${CSS.escape(this.editingMessageId)}"]`
    );
    this.editingMessageId = null;
    if (!row) return;
    row.querySelector('.chat-message-editor')?.remove();
    const textEl = row.querySelector<HTMLElement>('.chat-message-text');
    if (textEl) textEl.style.display = '';
  }

  private async confirmDeleteMessage(messageId: string): Promise<void> {
    if (!this.currentChannelId) return;
    const message = chatStore.getMessages(this.currentChannelId).find((m) => m.id === messageId);
    if (!message) return;

    const confirmed = await showConfirm({
      title: t('chat.deleteMessageTitle'),
      message: t('chat.deleteMessageConfirm'),
      confirmLabel: t('chat.deleteMessage'),
      variant: 'danger',
    });
    if (!confirmed) return;

    networkClient.send(MessageType.CHAT_DELETE, {
      channelId: message.channelId,
      messageId,
    });
  }

  /** Redraws one row in place after an edit or a deletion (#504). */
  private replaceMessageRow(msg: ChatMessage): void {
    const feed = document.getElementById('chat-messages-feed');
    if (!feed) return;
    const row = feed.querySelector<HTMLElement>(
      `.chat-message-row[data-message-id="${CSS.escape(msg.id)}"]`
    );
    if (!row) return;

    if (this.editingMessageId === msg.id) this.cancelMessageEdit();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = this.renderMessageRow(msg);
    const newRow = wrapper.firstElementChild as HTMLElement | null;
    if (!newRow) return;

    row.replaceWith(newRow);
    this.bindMessageElementEvents(newRow);
  }

  /** Whether the feed is scrolled close enough to the end to count as "at the end" (#270). */
  private isFeedAtBottom(feed: HTMLElement): boolean {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= BOTTOM_SCROLL_THRESHOLD_PX;
  }

  /**
   * Images, videos and embeds only get their real height after loading, which
   * grows the feed and would leave the view above the newest message. Re-pin it
   * while the user hasn't scrolled away (#270).
   */
  private repinWhileMediaLoads(target: HTMLElement): void {
    const repin = () => {
      const feed = document.getElementById('chat-messages-feed');
      if (feed && this.pinnedToBottom) feed.scrollTop = feed.scrollHeight;
    };
    target.querySelectorAll('img, iframe').forEach((el) => {
      el.addEventListener('load', repin, { once: true });
    });
    // Media elements never fire "load"; their box only settles once metadata arrives.
    target.querySelectorAll('video').forEach((el) => {
      el.addEventListener('loadedmetadata', repin, { once: true });
      el.addEventListener('loadeddata', repin, { once: true });
    });
  }

  /** Interleaves messages with a per-day divider line (#11). */
  private renderMessagesWithDividers(messages: ChatMessage[]): string {
    const parts: string[] = [];
    let lastKey = '';
    const items = [
      ...messages.map((message) => ({ createdAt: message.createdAt, html: this.renderMessageRow(message) })),
      ...chatStore.getInvocations(this.currentChannelId ?? '').map((invocation) => ({
        createdAt: invocation.createdAt,
        html: renderBotInvocation(invocation, !this.getBotCommandDeniedReason()),
      })),
    ].filter((item) => item.html !== '').sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      const key = this.dateKey(item.createdAt);
      if (key !== lastKey) {
        parts.push(this.renderDateDivider(item.createdAt));
        lastKey = key;
      }
      parts.push(item.html);
    }
    return parts.join('');
  }

  private dateKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  private renderDateDivider(ts: number): string {
    const label = new Date(ts).toLocaleDateString(getLanguage(), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return `<div class="chat-date-divider"><span class="chat-date-divider-label">${escapeHtml(label)}</span></div>`;
  }

  /** Full date + time shown on each message, e.g. "24/08/2026 19:15" (#11). */
  private formatDateTime(ts: number): string {
    const d = new Date(ts);
    const date = d.toLocaleDateString(getLanguage());
    const time = d.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  }

  private focusChatInput(options?: { defer?: boolean }): void {
    const applyFocus = () => {
      if (this.currentChannelId && chatStore.getCommandDraft(this.currentChannelId)) {
        this.botChat?.focusComposer();
        return;
      }
      const input = this.container.querySelector('#chat-message-input') as HTMLTextAreaElement | null;
      if (!input) return;
      input.focus({ preventScroll: true });
      const caret = input.value.length;
      input.setSelectionRange(caret, caret);
    };

    if (options?.defer) {
      requestAnimationFrame(() => requestAnimationFrame(applyFocus));
      return;
    }

    applyFocus();
  }

  private arePermissionsResolved(): boolean {
    return serverStore.myPermissions > 0 || serverStore.ownerId !== null;
  }

  private syncComposerPermissionState(): void {
    const input = this.container.querySelector('#chat-message-input') as HTMLTextAreaElement | null;
    const inputWrapper = this.container.querySelector('.chat-input-wrapper') as HTMLElement | null;
    const permissionBanner = this.container.querySelector('#chat-send-permission-banner') as HTMLElement | null;
    const btnSend = this.container.querySelector('#btn-send-message') as HTMLButtonElement | null;
    const btnAttach = this.container.querySelector('#btn-attach') as HTMLButtonElement | null;
    const btnEmoji = this.container.querySelector('#btn-emoji') as HTMLButtonElement | null;
    const btnCode = this.container.querySelector('#btn-code') as HTMLButtonElement | null;
    if (!input || !inputWrapper) return;

    const channelName = serverStore.serverDetails?.channels.find((c) => c.id === this.currentChannelId)?.name || 'geral';
    const permissionsResolved = this.arePermissionsResolved();
    const canSendMessages = !permissionsResolved || serverStore.hasPermission(Permission.SEND_MESSAGES);
    this.container.querySelectorAll<HTMLButtonElement>('.chat-reaction, .chat-reaction-add, [data-message-action="reply"]').forEach((button) => {
      button.disabled = !canSendMessages;
    });
    if (!canSendMessages) { this.reactionPicker?.destroy(); this.reactionPicker = null; }
    const canAttachFiles = canSendMessages && (!permissionsResolved || serverStore.hasPermission(Permission.ATTACH_FILES));
    const locked = permissionsResolved && !canSendMessages;
    const commandSelected = !!this.currentChannelId && !!chatStore.getCommandDraft(this.currentChannelId);
    inputWrapper.style.display = commandSelected ? 'none' : '';

    input.readOnly = locked;
    input.placeholder = locked
      ? t('chat.sendPermissionDenied')
      : t('chat.inputPlaceholder', { channel: escapeHtml(channelName) });
    input.setAttribute('aria-readonly', locked ? 'true' : 'false');
    inputWrapper.classList.toggle('chat-input-wrapper--disabled', locked);
    input.classList.toggle('chat-input-field--readonly', locked);

    if (permissionBanner) {
      permissionBanner.textContent = locked ? t('chat.sendPermissionDenied') : '';
      permissionBanner.style.display = locked ? 'flex' : 'none';
    }

    if (btnSend) {
      btnSend.hidden = locked;
      btnSend.disabled = locked || this.pending.some((p) => p.status === 'uploading');
    }

    if (btnAttach) {
      btnAttach.disabled = !canAttachFiles;
      btnAttach.setAttribute('aria-disabled', btnAttach.disabled ? 'true' : 'false');
    }

    if (btnEmoji) {
      // Emojis only need permission to talk; the sticker upload additionally
      // checks ATTACH_FILES when it is actually sent.
      btnEmoji.disabled = locked;
      btnEmoji.setAttribute('aria-disabled', btnEmoji.disabled ? 'true' : 'false');
    }

    if (btnCode) {
      btnCode.disabled = locked;
      btnCode.setAttribute('aria-disabled', btnCode.disabled ? 'true' : 'false');
    }

    if (locked) {
      this.closeMentionDropup();
      this.closeCommandDropup();
      this.emojiPicker?.close();
    } else if (this.commandActive) {
      this.updateCommandDropup(input);
    }
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    const el =
      target instanceof HTMLElement
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    if (!el) return false;
    return !!el.closest('textarea, input, [contenteditable]:not([contenteditable="false"])');
  }

  private isUserMentioned(content: string, currentNickname: string): boolean {
    if (!content) return false;
    // `@todos` reaches everyone in the channel, so it highlights the message the
    // same way a direct mention does (#464).
    if (serverStore.serverDetails?.allowEveryoneMention !== false && hasEveryoneMention(content)) {
      return true;
    }
    if (!currentNickname) return false;
    const escaped = currentNickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[\\s(])@${escaped}(?=$|[\\s),.!?:;])`, 'i');
    return regex.test(content);
  }

  private renderMessageRow(m: ChatMessage): string {
    const time = this.formatDateTime(m.createdAt);

    if (m.isSystem) {
      return `
        <div class="system-message-row">
          <span class="material-symbols-outlined md-14" style="color: var(--accent-primary);">info</span>
          <span>${escapeHtml(m.content)}</span>
          <span style="font-size: 10px; color: var(--text-muted); margin-left: auto;">${time}</span>
        </div>
      `;
    }

    const me = serverStore.currentUser;
    const currentNickname = me?.nickname?.trim();
    const isMentioned = !m.isSystem && this.isUserMentioned(m.content, currentNickname ?? '');

    const knownNicknames = Array.from(serverStore.knownMembers.values()).map((u) => u.nickname);
    if (currentNickname && !knownNicknames.includes(currentNickname)) {
      knownNicknames.push(currentNickname);
    }

    const avatarSrc = escapeHtml(getAvatarUrl(m.userAvatarUrl));
    const isBot = m.isBot || serverStore.knownMembers.get(m.userId)?.isBot === true;
    const botContext = isBot ? renderBotCommandContext(m) : '';
    const botBadge = isBot ? `<span class="member-badge-bot">${t('botChat.badge')}</span>` : '';
    const privateCue = m.isEphemeral ? `<span class="bot-private-cue"><span class="material-symbols-outlined md-14" aria-hidden="true">lock</span>${t('botChat.private')}</span>` : '';

    // A deleted message keeps its place in the conversation with a placeholder
    // instead of vanishing, so nothing silently reshuffles under the reader
    // (#504). Its text, stickers, attachments and link previews are all gone.
    if (m.deletedAt) {
      return `
        <div class="chat-message-row chat-message-deleted${isBot ? ' chat-bot-response' : ''}" data-user-id="${escapeHtml(m.userId)}" data-message-id="${escapeHtml(m.id)}">
          ${botContext}
          ${isBot ? '<div class="bot-response-main">' : ''}
          <img class="chat-author-avatar" src="${avatarSrc}" data-fallback="avatar">
          <div class="chat-message-body${isBot ? ' bot-response-bubble' : ''}">
            <div class="chat-author-header">
              <span class="chat-author-name">${escapeHtml(m.userNickname)}</span>
              ${botBadge}${privateCue}
              <span class="chat-timestamp">${time}</span>
            </div>
            <div class="chat-message-deleted-text">
              <span class="material-symbols-outlined md-14">block</span>
              <span>${t('chat.messageDeleted')}</span>
            </div>
          </div>
          ${isBot ? '</div>' : ''}
        </div>
      `;
    }
    // Attachments flagged as stickers are drawn as fixed-size squares instead of
    // going into the regular media grid (#356). A marker only takes effect when
    // it resolves to an image attachment of this message: anything else (a
    // hand-typed marker, an id that no longer exists, a video/file attachment)
    // is left alone so no text or attachment can disappear from the UI.
    const stickers: AttachmentMeta[] = [];
    for (const id of extractStickerIds(m.content)) {
      const found = m.attachments?.find((a) => a.id === id);
      if (found && found.kind === 'image') stickers.push(found);
    }
    const stickerIds = stickers.map((a) => a.id);
    const visibleText = stickerIds.length > 0 ? stripStickerTokens(m.content, stickerIds) : m.content;
    const otherAttachments =
      stickerIds.length > 0 ? m.attachments?.filter((a) => !stickerIds.includes(a.id)) : m.attachments;

    const textHtml =
      visibleText && visibleText.trim().length > 0
        ? `<div class="chat-message-text">${renderMarkdown(visibleText, {
            currentNickname,
            knownNicknames,
            everyoneMentionEnabled: serverStore.serverDetails?.allowEveryoneMention !== false,
          })}</div>`
        : '';
    const stickersHtml = this.renderStickers(stickers);
    const attachmentsHtml = this.renderAttachments(otherAttachments, m);
    const rowClass = `chat-message-row${isMentioned ? ' chat-message-mentioned' : ''}${m.isEphemeral ? ' chat-message-private' : ''}${isBot ? ' chat-bot-response' : ''}`;

    return `
      <div class="${rowClass}" tabindex="-1" data-user-id="${escapeHtml(m.userId)}" data-message-id="${escapeHtml(m.id)}">
        ${m.isEphemeral ? '' : this.renderMessageToolbar()}
        ${botContext}
        ${isBot ? '<div class="bot-response-main">' : ''}
        <img class="chat-author-avatar" src="${avatarSrc}" data-fallback="avatar">
        <div class="chat-message-body${isBot ? ' bot-response-bubble' : ''}">
          ${m.reply ? this.renderReplyReference(m.reply) : ''}
          <div class="chat-author-header">
            <span class="chat-author-name">${escapeHtml(m.userNickname)}</span>
            ${botBadge}${privateCue}
            <span class="chat-timestamp">${time}</span>
            ${m.editedAt ? `<span class="chat-edited-badge" title="${escapeHtml(t('chat.editedAtTitle', { time: this.formatDateTime(m.editedAt) }))}">${t('chat.messageEdited')}</span>` : ''}
          </div>
          ${textHtml}
          ${stickersHtml}
          <div class="chat-link-previews" data-message-id="${escapeHtml(m.id)}"></div>
          ${attachmentsHtml}
          ${m.isEphemeral ? '' : `<div class="chat-reactions">${this.renderReactions(m)}</div>`}
        </div>
        ${isBot ? '</div>' : ''}
      </div>
    `;
  }

  private renderReactions(message: ChatMessage): string {
    const me = serverStore.currentUser?.id;
    const disabled = serverStore.hasPermission(Permission.SEND_MESSAGES) ? '' : 'disabled';
    const buttons = (message.reactions ?? []).map((reaction) => {
      const mine = reaction.users.some((user) => user.userId === me);
      const names = reaction.users.map((user) => serverStore.knownMembers.get(user.userId)?.nickname ?? user.userNickname).join(', ');
      const title = t('chat.reactedBy', { emoji: reaction.emoji, users: names });
      return `<button type="button" class="chat-reaction${mine ? ' chat-reaction--mine' : ''}"
        ${disabled} data-reaction-emoji="${escapeHtml(reaction.emoji)}" aria-pressed="${mine}" title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}">${escapeHtml(reaction.emoji)} <span>${reaction.users.length}</span></button>`;
    }).join('');
    return buttons;
  }

  private renderMessageToolbar(): string {
    const disabled = serverStore.hasPermission(Permission.SEND_MESSAGES) ? '' : 'disabled';
    const button = (action: string, icon: string, label: string, extra = '') =>
      `<button type="button" ${extra} data-message-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="material-symbols-outlined md-18" aria-hidden="true">${icon}</span></button>`;
    return `<div class="chat-message-toolbar" role="group" aria-label="${t('chat.messageActions')}">
      ${button('emoji', 'add_reaction', t('chat.emojiAction'), `class="chat-reaction-add" ${disabled}`)}
      ${button('reply', 'reply', t('chat.replyMessage'), disabled)}
      ${button('copy', 'content_copy', t('chat.copyMessage'))}
      <span class="chat-message-copy-status" role="status"></span>
      ${button('more', 'more_horiz', t('chat.moreActions'), 'aria-haspopup="menu"')}
    </div>`;
  }

  private replyPreview(reply: MessageReply): string {
    return reply.deleted ? t('chat.messageDeleted') : stripStickerTokens(reply.content, extractStickerIds(reply.content)).trim()
      || (reply.hasAttachments ? t('chat.replyAttachment') : reply.content);
  }

  private renderReplyReference(reply: MessageReply): string {
    return `<button type="button" class="chat-reply-reference" ${reply.deleted ? 'disabled' : ''}
      data-reply-target="${escapeHtml(reply.messageId)}" title="${escapeHtml(t('chat.jumpToMessage'))}">
      <span class="material-symbols-outlined md-16" aria-hidden="true">reply</span>
      ${reply.deleted ? '' : `<strong>${escapeHtml(reply.userNickname)}</strong>`}
      <span>${escapeHtml(this.replyPreview(reply))}</span>
    </button>`;
  }

  private startReply(messageId: string): void {
    if (!this.currentChannelId || !serverStore.hasPermission(Permission.SEND_MESSAGES)) return;
    const message = chatStore.getMessages(this.currentChannelId).find((entry) => entry.id === messageId);
    if (!message || message.deletedAt || message.isSystem || message.isEphemeral) return;
    chatStore.setReplyDraft(this.currentChannelId, message);
    this.renderReplyComposer();
    this.focusChatInput();
  }

  private renderReplyComposer(): void {
    const el = this.container.querySelector<HTMLElement>('#chat-reply-composer');
    if (!el) return;
    const reply = this.currentChannelId ? chatStore.getReplyDraft(this.currentChannelId) : undefined;
    el.hidden = !reply;
    el.innerHTML = reply ? `<span>${escapeHtml(reply.deleted ? t('chat.messageDeleted') : t('chat.replyingTo', { user: reply.userNickname }))}: ${escapeHtml(this.replyPreview(reply))}</span>
      <button type="button" aria-label="${t('chat.cancelReply')}" title="${t('chat.cancelReply')}"><span class="material-symbols-outlined md-18" aria-hidden="true">close</span></button>` : '';
    el.querySelector('button')?.addEventListener('click', () => {
      this.clearReply();
      this.focusChatInput();
    });
  }

  private clearReply(): void {
    if (this.currentChannelId) chatStore.setReplyDraft(this.currentChannelId);
    this.renderReplyComposer();
  }

  private async copyMessage(messageId: string): Promise<void> {
    const message = this.currentChannelId ? chatStore.getMessages(this.currentChannelId).find((entry) => entry.id === messageId) : undefined;
    if (!message || message.deletedAt) return;
    const requestId = ++this.copyRequestId;
    this.clearCopyFeedback?.();
    // Both flavours go to the clipboard (#516): the plain one is the stored
    // Markdown rather than anything read back from the screen, so pasting into
    // the composer reproduces the original, while the rich one is built from
    // what is rendered, so Word or Docs keep the bold, links and lists.
    const markdown = message.content || message.attachments?.map((entry) => entry.originalName).join('\n') || '';
    const textEl = this.container.querySelector<HTMLElement>(
      `.chat-message-row[data-message-id="${CSS.escape(messageId)}"] .chat-message-text`
    );
    if (!(await writeRichText(textEl ? toPortableHtml(textEl) : '', markdown))) {
      if (requestId === this.copyRequestId) void showAlert({ message: t('chat.copyFailed'), variant: 'danger' });
      return;
    }
    if (requestId !== this.copyRequestId) return;
    const toolbar = this.container.querySelector<HTMLElement>(
      `.chat-message-row[data-message-id="${CSS.escape(messageId)}"] .chat-message-toolbar`
    );
    const button = toolbar?.querySelector<HTMLButtonElement>('[data-message-action="copy"]');
    const icon = button?.querySelector<HTMLElement>('.material-symbols-outlined');
    const status = toolbar?.querySelector<HTMLElement>('.chat-message-copy-status');
    if (!toolbar || !button || !icon || !status) return;
    toolbar.classList.add('copy-confirmed');
    icon.textContent = 'check';
    status.textContent = t('chat.messageCopied');
    button.title = t('chat.messageCopied');
    button.setAttribute('aria-label', t('chat.messageCopied'));
    const clear = () => {
      window.clearTimeout(timeout);
      toolbar.classList.remove('copy-confirmed');
      icon.textContent = 'content_copy';
      status.textContent = '';
      button.title = t('chat.copyMessage');
      button.setAttribute('aria-label', t('chat.copyMessage'));
      this.clearCopyFeedback = null;
    };
    const timeout = window.setTimeout(clear, 1600);
    this.clearCopyFeedback = clear;
  }

  private jumpToMessage(messageId: string): void {
    if (!this.currentChannelId) return;
    const row = this.container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"].chat-message-row`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      this.pinnedToBottom = false;
      return;
    }
    this.pendingJumpId = messageId;
    networkClient.send(MessageType.CHAT_LOAD_HISTORY, { channelId: this.currentChannelId, aroundMessageId: messageId });
  }

  private bindReactionButtons(row: HTMLElement): void {
    row.querySelectorAll<HTMLButtonElement>('.chat-reaction, .chat-reaction-add').forEach((button) => {
      button.addEventListener('click', () => {
        if (!this.currentChannelId || !serverStore.hasPermission(Permission.SEND_MESSAGES)) return;
        const channelId = this.currentChannelId;
        const store = getActiveChatStore();
        const client = getActiveNetworkClient();
        const me = serverStore.currentUser?.id;
        const messageId = row.closest<HTMLElement>('.chat-message-row')?.dataset.messageId;
        const toggle = (emoji: string) => {
          const message = store.getMessages(channelId).find((entry) => entry.id === messageId);
          if (!message || message.deletedAt || message.isSystem || message.isEphemeral) return;
          const mine = message.reactions?.find((reaction) => reaction.emoji === emoji)?.users.some((user) => user.userId === me);
          client.send(mine ? MessageType.CHAT_REACTION_REMOVE : MessageType.CHAT_REACTION_ADD, {
            channelId, messageId: message.id, emoji,
          });
        };
        if (button.dataset.reactionEmoji) { toggle(button.dataset.reactionEmoji); return; }
        this.reactionPicker?.destroy();
        contextMenu.close();
        const picker = new EmojiPicker({
          container: document.body, anchor: button, emojiOnly: true, floating: true,
          onSelectEmoji: (emoji) => { picker.close(); toggle(emoji); },
        });
        this.reactionPicker = picker;
        void picker.open();
      });
    });
  }

  private updateReactionRow(message: ChatMessage): void {
    const row = this.container.querySelector<HTMLElement>(`.chat-message-row[data-message-id="${CSS.escape(message.id)}"]`);
    const reactions = row?.querySelector<HTMLElement>('.chat-reactions');
    if (!row || !reactions) return;
    this.reactionPicker?.destroy();
    this.reactionPicker = null;
    reactions.innerHTML = this.renderReactions(message);
    this.bindReactionButtons(reactions);
  }

  /**
   * Draws sticker attachments as fixed-size squares (#356). Unlike photos they
   * get no lightbox or download affordance — they behave like a large emoji,
   * except for a hover button that saves them into the user's own folder.
   */
  private renderStickers(stickers: AttachmentMeta[]): string {
    if (stickers.length === 0) return '';
    const items = stickers
      .map((a) => {
        const name = escapeHtml(a.originalName);
        if (!a.url) {
          return `
            <div class="chat-sticker chat-sticker--evicted" title="${t('chat.attachmentEvicted')}">
              <span class="material-symbols-outlined md-24">hide_source</span>
            </div>
          `;
        }
        return `
          <div class="chat-sticker-wrap">
            <img class="chat-sticker" src="${getAttachmentUrl(a.url)}" alt="${name}" title="${name}" loading="lazy">
            <button type="button" class="chat-sticker-save" data-sticker-url="${escapeHtml(a.url)}" data-sticker-name="${name}" title="${t('chat.saveSticker')}" aria-label="${t('chat.saveSticker')}">
              <span class="material-symbols-outlined md-14">bookmark_add</span>
            </button>
          </div>
        `;
      })
      .join('');
    return `<div class="chat-stickers">${items}</div>`;
  }

  /** Renders the attachment grid below a message body (#11). */
  private renderAttachments(attachments?: AttachmentMeta[], message?: ChatMessage): string {
    if (!attachments || attachments.length === 0) return '';
    const items = attachments.map((a) => this.renderAttachment(a, message)).join('');
    return `<div class="chat-attachments">${items}</div>`;
  }

  private renderAttachment(a: AttachmentMeta, message?: ChatMessage): string {
    // FIFO eviction removed the binary: show a placeholder instead of a broken link.
    if (!a.url) {
      return `
        <div class="attachment-evicted" title="${escapeHtml(a.originalName)}">
          <span class="material-symbols-outlined md-18">hide_source</span>
          <span>${t('chat.attachmentEvicted')}</span>
        </div>
      `;
    }

    const src = getAttachmentUrl(a.url);
    const name = escapeHtml(a.originalName);
    const senderName = escapeHtml(message?.userNickname || '');
    const sentAt = escapeHtml(message ? this.formatDateTime(message.createdAt) : '');
    const lightboxMeta = `
      data-lightbox-sender="${senderName}"
      data-lightbox-timestamp="${sentAt}"
    `;
    const inlineActions = `
      <div class="chat-inline-media-actions">
        <button
          type="button"
          class="chat-attachment-action chat-attachment-lightbox-trigger"
          title="${t('chat.openMediaViewer')}"
        >
          <span class="material-symbols-outlined md-18">open_in_full</span>
        </button>
        <button
          type="button"
          class="chat-attachment-action chat-attachment-download"
          data-download-url="${src}"
          data-file-name="${name}"
          title="${t('common.download')}"
        >
          <span class="material-symbols-outlined md-18">download</span>
        </button>
      </div>
    `;

    if (a.kind === 'image') {
      return `
        <div
          class="chat-inline-media chat-inline-media--image"
          data-lightbox-kind="image"
          data-lightbox-url="${src}"
          data-lightbox-name="${name}"
          ${lightboxMeta}
        >
          <img class="chat-attachment-image" src="${src}" alt="${name}" title="${name}" loading="lazy">
          ${inlineActions}
        </div>
      `;
    }

    if (a.kind === 'video') {
      return `
        <div
          class="chat-attachment-video-wrap chat-inline-media chat-inline-media--video"
          data-lightbox-kind="video"
          data-lightbox-url="${src}"
          data-lightbox-name="${name}"
          ${lightboxMeta}
        >
          <div class="chat-video-player">
            <video class="chat-attachment-video" preload="metadata" src="${src}" playsinline></video>
            ${inlineActions}
          </div>
        </div>
      `;
    }

    return `
      <button
        type="button"
        class="chat-attachment-file"
        data-download-url="${src}"
        data-file-name="${name}"
        title="${t('common.download')} ${name}"
      >
        <span class="material-symbols-outlined md-24 af-icon">${fileIconName(a.kind, a.mimeType, a.originalName)}</span>
        <span class="af-meta">
          <span class="af-name">${name}</span>
          <span class="af-size">${formatBytes(a.sizeBytes)}</span>
        </span>
        <span class="material-symbols-outlined md-20 af-dl">download</span>
      </button>
    `;
  }

  private bindMediaInteractions(feed: HTMLElement): void {
    feed.querySelectorAll('.chat-inline-media[data-lightbox-kind="image"] .chat-attachment-image').forEach((img) => {
      img.addEventListener('click', () => {
        const source = (img as HTMLElement).closest('[data-lightbox-kind]') as HTMLElement | null;
        if (source) this.openLightboxFromSource(source);
      });
    });

    feed.querySelectorAll('.chat-attachment-lightbox-trigger').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const source = (button as HTMLElement).closest('[data-lightbox-kind]') as HTMLElement | null;
        if (source) this.openLightboxFromSource(source);
      });
    });

    feed.querySelectorAll('.chat-attachment-file').forEach((chip) => {
      chip.addEventListener('click', () => {
        const url = chip.getAttribute('data-download-url');
        const name = chip.getAttribute('data-file-name') || 'attachment';
        if (url) void this.downloadAttachment(url, name);
      });
    });

    feed.querySelectorAll('.chat-attachment-download').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = button.getAttribute('data-download-url');
        const name = button.getAttribute('data-file-name') || 'attachment';
        if (url) void this.downloadAttachment(url, name);
      });
    });

    feed.querySelectorAll('.chat-sticker-save').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = button.getAttribute('data-sticker-url');
        const name = button.getAttribute('data-sticker-name') || 'sticker';
        if (url) void this.saveSticker(url, name);
      });
    });
  }

  /**
   * Copies a sticker somebody else sent into the local folder (#356 QA). Without
   * a folder configured there is nowhere to put it, so the picker is offered
   * instead of failing silently.
   */
  private async saveSticker(url: string, fileName: string): Promise<void> {
    const attachmentUrl = getAttachmentUrl(url);
    let result = await stickerService.saveFromUrl(attachmentUrl, fileName);

    // `no-folder` covers both "never picked one" and "the main process has not
    // seen the user confirm this folder in this run" — it only writes to folders
    // chosen through its own dialog. Either way, asking is the right answer.
    if (!result.ok && result.reason === 'no-folder') {
      const folder = await window.api?.selectStickersFolder?.();
      if (!folder) return;
      settingsStore.stickersFolderPath = folder;
      settingsStore.save();
      await stickerService.loadStickers(true);
      result = await stickerService.saveFromUrl(attachmentUrl, fileName);
    }

    if (result.ok) {
      void showAlert({
        message: t('chat.stickerSaved', { name: result.fileName ?? fileName }),
        variant: 'success',
      });
      return;
    }

    const reasonKey =
      result.reason === 'too-large'
        ? 'chat.stickerSaveTooLarge'
        : result.reason === 'bad-extension'
          ? 'chat.stickerSaveBadFormat'
          : 'chat.stickerSaveFailed';
    void showAlert({ message: t(reasonKey), variant: 'danger' });
  }

  private openLightboxFromSource(source: HTMLElement): void {
    const feed = document.getElementById('chat-messages-feed');
    if (!feed) return;

    const items = Array.from(feed.querySelectorAll<HTMLElement>('[data-lightbox-kind]'))
      .map((node) => {
        const kind = node.getAttribute('data-lightbox-kind');
        const url = node.getAttribute('data-lightbox-url');
        const fileName = node.getAttribute('data-lightbox-name') || 'attachment';
        const senderName = node.getAttribute('data-lightbox-sender') || '';
        const timestamp = node.getAttribute('data-lightbox-timestamp') || '';
        if ((kind === 'image' || kind === 'video') && url) {
          return { kind, url, fileName, senderName, timestamp, source: node } as LightboxMedia;
        }
        return null;
      })
      .filter((item): item is LightboxMedia => item !== null);

    if (items.length === 0) return;
    const startIndex = items.findIndex((item) => item.source === source);
    if (startIndex >= 0) {
      lightboxModal.open(items, startIndex, (url, name) => this.downloadAttachment(url, name));
    }
  }

  private attachEvents(): void {
    // Clear old unbinders
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];

    const input = this.container.querySelector('#chat-message-input') as HTMLTextAreaElement | null;
    const inputContainer = this.container.querySelector('.chat-input-container') as HTMLElement | null;
    const inputWrapper = this.container.querySelector('.chat-input-wrapper') as HTMLElement | null;
    const charCounter = document.getElementById('chat-char-counter');
    const btnSend = document.getElementById('btn-send-message');

    const messagesFeed = this.container.querySelector('#chat-messages-feed') as HTMLElement | null;
    const commandDropup = this.container.querySelector<HTMLElement>('#command-dropup');
    const onCommandFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget === input || (event.relatedTarget instanceof Node && commandDropup?.contains(event.relatedTarget))) return;
      this.closeCommandDropup();
    };
    const onOutsideCommand = (event: PointerEvent) => {
      if (this.commandActive && event.target instanceof Node && event.target !== input && !commandDropup?.contains(event.target)) this.closeCommandDropup();
    };
    commandDropup?.addEventListener('focusout', onCommandFocusOut);
    document.addEventListener('pointerdown', onOutsideCommand);
    this.unbindEvents.push(() => {
      commandDropup?.removeEventListener('focusout', onCommandFocusOut);
      document.removeEventListener('pointerdown', onOutsideCommand);
    });
    if (messagesFeed) {
      messagesFeed.addEventListener('scroll', () => {
        this.pinnedToBottom = this.isFeedAtBottom(messagesFeed);
      });
    }

    const autoResize = () => {
      if (!input) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };

    const focusFromInputShell = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!input) return;
      if (this.isEditableTarget(target)) return;
      if (target?.closest('button, .mention-dropup, #chat-attachment-tray, #chat-command-composer')) return;
      requestAnimationFrame(() => this.focusChatInput());
    };
    inputContainer?.addEventListener('mousedown', focusFromInputShell);
    inputWrapper?.addEventListener('mousedown', focusFromInputShell);

    let composeLinkTimer: ReturnType<typeof setTimeout> | null = null;
    let pastePreviewTimer: ReturnType<typeof setTimeout> | null = null;
    let dropupBlurTimer: ReturnType<typeof setTimeout> | null = null;
    let lastComposeUrl = '';
    const composeLinkPreviewEl = this.container.querySelector('#chat-compose-link-preview') as HTMLElement | null;

    const updateComposeLinkPreview = () => {
      if (!input || !composeLinkPreviewEl || !input.isConnected) return;
      if (this.currentChannelId && chatStore.getCommandDraft(this.currentChannelId)) {
        composeLinkPreviewEl.style.display = 'none';
        return;
      }
      const urlMatch = input.value.match(/(https?:\/\/[^\s<]+)/);
      const url = urlMatch ? urlMatch[1] : '';
      if (url === lastComposeUrl) return;
      lastComposeUrl = url;
      if (!url) {
        composeLinkPreviewEl.style.display = 'none';
        composeLinkPreviewEl.innerHTML = '';
        return;
      }
      linkPreviewService.fetch(url).then((data) => {
        if (!data || lastComposeUrl !== url) return;
        composeLinkPreviewEl.style.display = 'block';
        const imgHtml = data.image ? `<img class="compose-link-preview-img" src="${escapeHtml(data.image)}" alt="">` : '';
        composeLinkPreviewEl.innerHTML = `
          <div class="compose-link-preview-card" data-external-link="${escapeHtml(url)}" role="button" tabindex="0">
            <div class="compose-link-preview-text">
              <div class="compose-link-preview-site">${escapeHtml(data.siteName || new URL(url).hostname)}</div>
              <div class="compose-link-preview-title">${escapeHtml(data.title || url)}</div>
              ${data.description ? `<div class="compose-link-preview-desc">${escapeHtml(data.description)}</div>` : ''}
            </div>
            ${imgHtml}
            <button type="button" class="compose-link-preview-dismiss" title="${t('common.close')}">
              <span class="material-symbols-outlined md-16">close</span>
            </button>
          </div>
        `;
        const openPreviewLink = () => {
          if (window.api?.openExternal) {
            window.api.openExternal(url);
          }
        };
        composeLinkPreviewEl.querySelector('.compose-link-preview-card')?.addEventListener('click', openPreviewLink);
        composeLinkPreviewEl.querySelector('.compose-link-preview-card')?.addEventListener('keydown', (event) => {
          const keyEvent = event as KeyboardEvent;
          if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
            keyEvent.preventDefault();
            openPreviewLink();
          }
        });
        composeLinkPreviewEl.querySelector('.compose-link-preview-dismiss')?.addEventListener('click', (event) => {
          event.stopPropagation();
          composeLinkPreviewEl.style.display = 'none';
          composeLinkPreviewEl.innerHTML = '';
          lastComposeUrl = '__dismissed__';
        });
      }).catch(() => { /* silent */ });
    };

    input?.addEventListener('input', () => {
      if (charCounter) {
        charCounter.innerText = `${input.value.length}/${LIMITS.MAX_MESSAGE_LENGTH}`;
      }
      autoResize();
      this.persistDraft(input.value);
      this.showCommandNotice('');
      this.updateMentionDropup(input);
      this.updateCommandDropup(input);
      if (composeLinkTimer) clearTimeout(composeLinkTimer);
      composeLinkTimer = setTimeout(updateComposeLinkPreview, 500);
    });

    // Also detect URL on paste immediately
    input?.addEventListener('paste', () => {
      if (pastePreviewTimer) clearTimeout(pastePreviewTimer);
      pastePreviewTimer = setTimeout(updateComposeLinkPreview, 100);
    });
    this.unbindEvents.push(() => {
      if (composeLinkTimer) clearTimeout(composeLinkTimer);
      if (pastePreviewTimer) clearTimeout(pastePreviewTimer);
    });

    // A restored draft (#478) has to look exactly like it did before the view
    // was rebuilt. It is assigned here rather than written into the template
    // because the HTML parser silently eats a newline right after the opening
    // `<textarea>` tag, which would swallow the first line of a draft that
    // starts with a line break.
    const draft = this.currentChannelId ? chatStore.getDraft(this.currentChannelId) : '';
    if (input && draft.length > 0) {
      input.value = draft;
      if (charCounter) {
        charCounter.innerText = `${input.value.length}/${LIMITS.MAX_MESSAGE_LENGTH}`;
      }
      autoResize();
      updateComposeLinkPreview();
    }

    const handleSend = () => {
      if (!input || !this.currentChannelId || !serverStore.hasPermission(Permission.SEND_MESSAGES)) return;
      const text = input.value.trim();
      if (chatStore.getCommandDraft(this.currentChannelId)) {
        this.botChat?.focusComposer();
        return;
      }
      const command = parseTypedCommand(input.value, chatStore.getCommands());
      if (command.kind !== 'chat') {
        const denied = this.getBotCommandDeniedReason();
        if (denied) {
          this.showCommandNotice(denied);
          this.updateCommandDropup(input);
          return;
        }
        if (command.kind === 'command') this.selectCommand(command.command, command.text);
        else if (command.kind === 'ambiguous') {
          this.showCommandNotice(t('botChat.commandAmbiguous'));
          this.commandGroups = groupCommands(command.commands, [], getLanguage(), false);
          this.commandMatches = this.commandGroups.flatMap((group) => group.commands);
          this.commandActiveIndex = 0;
          this.commandActive = true;
          this.renderCommandDropup();
          input.focus();
        } else this.showCommandNotice(t('botChat.commandUnavailable'));
        return;
      }

      // Block sending until every staged upload has finished (#11).
      if (this.pending.some((p) => p.status === 'uploading')) return;

      const attachmentIds = this.pending
        .filter((p) => p.status === 'done' && p.meta)
        .map((p) => p.meta!.id);

      if (!text && attachmentIds.length === 0) return;
      const reply = chatStore.getReplyDraft(this.currentChannelId);
      if (reply?.deleted) {
        void showAlert({ message: t('chat.replyUnavailable'), variant: 'danger' });
        return;
      }

      networkClient.send(MessageType.CHAT_SEND, {
        channelId: this.currentChannelId,
        content: text,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        replyToMessageId: reply?.messageId,
      });

      this.clearReply();
      this.clearPending();
      input.value = '';
      this.persistDraft('');
      input.style.height = 'auto';
      if (charCounter) {
        charCounter.innerText = `0/${LIMITS.MAX_MESSAGE_LENGTH}`;
      }
      this.closeMentionDropup();
      // Clear compose link preview
      if (composeLinkPreviewEl) {
        composeLinkPreviewEl.style.display = 'none';
        composeLinkPreviewEl.innerHTML = '';
        lastComposeUrl = '';
      }
    };

    // --- Attachment upload wiring (#11) ---
    const btnAttach = document.getElementById('btn-attach');
    const fileInput = document.getElementById('chat-file-input') as HTMLInputElement | null;

    btnAttach?.addEventListener('click', () => {
      if (!serverStore.hasPermission(Permission.ATTACH_FILES)) return;
      fileInput?.click();
    });
    fileInput?.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        if (!serverStore.hasPermission(Permission.ATTACH_FILES)) return;
        this.addFiles(fileInput.files);
      }
      fileInput.value = '';
    });

    // --- Emoji & sticker picker (#356) ---
    const btnEmoji = document.getElementById('btn-emoji');
    if (btnEmoji && inputContainer) {
      const picker = new EmojiPicker({
        container: inputContainer,
        anchor: btnEmoji,
        onSelectEmoji: (emoji) => this.insertAtCaret(emoji),
        onSelectSticker: (sticker) => {
          picker.close();
          void this.sendSticker(sticker);
        },
      });
      this.emojiPicker = picker;

      const onEmojiClick = () => {
        if (this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SEND_MESSAGES)) return;
        picker.toggle();
      };
      btnEmoji.addEventListener('click', onEmojiClick);
      // attachEvents() runs again on every re-render, so the popover must go with
      // its listeners or its document-level handlers would pile up.
      this.unbindEvents.push(() => {
        btnEmoji.removeEventListener('click', onEmojiClick);
        picker.destroy();
        if (this.emojiPicker === picker) this.emojiPicker = null;
      });
    }

    // --- Code block composer (#391) ---
    const btnCode = document.getElementById('btn-code');
    if (btnCode) {
      const onCodeClick = () => {
        if (this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SEND_MESSAGES)) return;
        codeBlockModal.open({
          onSubmit: (language, code) => this.sendCodeBlock(language, code),
        });
      };
      btnCode.addEventListener('click', onCodeClick);
      this.unbindEvents.push(() => {
        btnCode.removeEventListener('click', onCodeClick);
        codeBlockModal.close();
      });
    }

    // Paste files/images directly into the message box.
    input?.addEventListener('paste', (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        if (!serverStore.hasPermission(Permission.ATTACH_FILES)) return;
        e.preventDefault();
        this.addFiles(files);
      }
    });

    // Global paste handler: Ctrl+V anywhere on the page uploads files when a
    // text channel is open (#181).
    const onGlobalPaste = (e: Event) => {
      const ce = e as ClipboardEvent;
      // Never hijack normal paste into editable fields; only catch truly global
      // pastes so text input keeps its native Ctrl+V behavior (#181).
      if (this.isEditableTarget(ce.target)) return;
      if (!this.currentChannelId) return;
      const files = ce.clipboardData?.files;
      if (files && files.length > 0) {
        if (!serverStore.hasPermission(Permission.ATTACH_FILES)) return;
        e.preventDefault();
        this.addFiles(files);
        // Focus the input so the user can add a message to accompany the file.
        this.focusChatInput();
      }
    };
    document.addEventListener('paste', onGlobalPaste);
    this.unbindEvents.push(() => document.removeEventListener('paste', onGlobalPaste));

    // Ctrl+C over the conversation. The default copy hands over the rendered
    // text, which drops the Markdown and drags the code-block toolbar along, so
    // both flavours are rewritten here (#516). Done in the copy event rather
    // than through the async clipboard API because this is the only place two
    // flavours can be written synchronously, with no permission prompt.
    const onCopy = (e: Event) => {
      const ce = e as ClipboardEvent;
      if (this.isEditableTarget(ce.target)) return;
      const fragment = this.selectedMessageFragment();
      if (!fragment || !ce.clipboardData) return;

      const markdown = toMarkdown(fragment);
      if (!markdown) return;

      ce.clipboardData.setData('text/plain', markdown);
      ce.clipboardData.setData('text/html', toPortableHtml(fragment));
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    this.unbindEvents.push(() => document.removeEventListener('copy', onCopy));
    this.unbindEvents.push(() => {
      inputContainer?.removeEventListener('mousedown', focusFromInputShell);
      inputWrapper?.removeEventListener('mousedown', focusFromInputShell);
    });

    // Drag & drop onto the chat pane. Listeners live on the persistent container,
    // so they must be unbound on re-render to avoid stacking.
    const onDragOver = (e: Event) => {
      const de = e as DragEvent;
      if (!de.dataTransfer || !Array.from(de.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      de.dataTransfer.dropEffect = 'copy';
      this.container.querySelector('.chat-container')?.classList.add('chat-drag-over');
    };
    const onDragLeave = (e: Event) => {
      const related = (e as DragEvent).relatedTarget as Node | null;
      // Only clear when the pointer actually leaves the chat pane, not when it
      // crosses between child elements (which would otherwise flicker).
      if (!related || !this.container.contains(related)) {
        this.container.querySelector('.chat-container')?.classList.remove('chat-drag-over');
      }
    };
    const onDrop = (e: Event) => {
      const de = e as DragEvent;
      this.container.querySelector('.chat-container')?.classList.remove('chat-drag-over');
      if (de.dataTransfer?.files && de.dataTransfer.files.length > 0) {
        e.preventDefault();
        this.addFiles(de.dataTransfer.files);
      }
    };
    this.container.addEventListener('dragover', onDragOver);
    this.container.addEventListener('dragleave', onDragLeave);
    this.container.addEventListener('drop', onDrop);
    this.unbindEvents.push(() => {
      this.container.removeEventListener('dragover', onDragOver);
      this.container.removeEventListener('dragleave', onDragLeave);
      this.container.removeEventListener('drop', onDrop);
    });

    // Re-render the tray for any files staged before this (re)render.
    this.renderTray();
    this.renderReplyComposer();
    this.syncComposerPermissionState();

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.mentionActive && !this.commandActive) this.clearReply();
      // While the mention dropup is open, arrows/enter/tab/esc drive it (#14).
      if (this.mentionActive && this.mentionMatches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.mentionActiveIndex = (this.mentionActiveIndex + 1) % this.mentionMatches.length;
          this.renderMentionDropup();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.mentionActiveIndex =
            (this.mentionActiveIndex - 1 + this.mentionMatches.length) % this.mentionMatches.length;
          this.renderMentionDropup();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          this.applyMention(this.mentionActiveIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeMentionDropup();
          return;
        }
      }

      // While the command dropup is open (#569).
      if (this.commandActive) {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeCommandDropup();
          return;
        }
        if (this.commandMatches.length === 0) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.setActiveCommand((this.commandActiveIndex + 1) % this.commandMatches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.setActiveCommand((this.commandActiveIndex - 1 + this.commandMatches.length) % this.commandMatches.length);
          return;
        }
        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
          e.preventDefault();
          this.applyCommand(this.commandActiveIndex);
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    const onInputBlur = () => {
      if (!input?.isConnected) return;
      // Delay so a click (mousedown) on a dropup item is processed first.
      if (dropupBlurTimer) clearTimeout(dropupBlurTimer);
      dropupBlurTimer = setTimeout(() => {
        dropupBlurTimer = null;
        if (!input.isConnected || document.activeElement === input) return;
        this.closeMentionDropup();
        if (!this.container.querySelector('#command-dropup')?.contains(document.activeElement)) this.closeCommandDropup();
      }, 150);
    };
    const onInputFocus = () => {
      if (dropupBlurTimer) clearTimeout(dropupBlurTimer);
      dropupBlurTimer = null;
    };
    input?.addEventListener('blur', onInputBlur);
    input?.addEventListener('focus', onInputFocus);
    this.unbindEvents.push(() => {
      input?.removeEventListener('blur', onInputBlur);
      input?.removeEventListener('focus', onInputFocus);
      if (dropupBlurTimer) clearTimeout(dropupBlurTimer);
    });

    btnSend?.addEventListener('click', () => {
      handleSend();
    });

    // Listen for new messages
    const u1 = appEvents.on('server.updated', () => this.syncComposerPermissionState());
    const u2 = appEvents.on('server.roles_updated', () => this.syncComposerPermissionState());
    const u3 = appEvents.on('chat.message_added', (msg: ChatMessage) => {
      if (msg.channelId === this.currentChannelId) {
        // Sending a message always brings the author back to the end (#270).
        const isOwnMessage = msg.userId === serverStore.currentUser?.id;
        this.appendMessage(msg, { forceScroll: isOwnMessage });
      }
    });

    const returnLatest = this.container.querySelector<HTMLButtonElement>('#chat-return-latest');
    returnLatest?.addEventListener('click', () => {
      this.pendingJumpId = null;
      this.loadHistory();
    });
    const u4 = appEvents.on('chat.history_loaded', (data: { channelId: string; aroundMessageId?: string }) => {
      if (data.channelId === this.currentChannelId) {
        const jumpId = data.aroundMessageId === this.pendingJumpId ? this.pendingJumpId : null;
        if (jumpId) this.pendingJumpId = null;
        if (returnLatest) returnLatest.hidden = !data.aroundMessageId;
        this.renderMessages({ forceScroll: !jumpId });
        if (jumpId) {
          if (chatStore.getMessages(data.channelId).some((message) => message.id === jumpId)) this.jumpToMessage(jumpId);
          else void showAlert({ message: t('chat.replyUnavailable'), variant: 'danger' });
        }
      }
    });

    // Only the affected row is redrawn: rebuilding the whole feed would drop
    // the reader's scroll position and reload every image (#504).
    const u5 = appEvents.on('chat.message_updated', (msg: ChatMessage) => {
      if (msg.channelId === this.currentChannelId) {
        contextMenu.close();
        this.reactionPicker?.close();
        this.replaceMessageRow(msg);
        this.renderReplyComposer();
      }
    });

    const u6 = appEvents.on('chat.commands_updated', () => {
      if (input && !chatStore.getCommandDraft(this.currentChannelId ?? '')) this.updateCommandDropup(input);
    });
    this.unbindEvents.push(appEvents.on('chat.reactions_updated', (message: ChatMessage) => {
      if (message.channelId === this.currentChannelId) this.updateReactionRow(message);
    }), () => { this.reactionPicker?.destroy(); this.reactionPicker = null; });
    this.unbindEvents.push(u1, u2, u3, u4, u5, u6);

    const composer = this.container.querySelector<HTMLElement>('#chat-command-composer');
    if (composer && messagesFeed && this.currentChannelId) {
      this.publicSelectors = new PublicSelectorView(
        messagesFeed, getActiveNetworkClient(), getActiveServerStore(), this.currentChannelId
      );
      const store = getActiveChatStore();
      const channelId = this.currentChannelId;
      let wasSelected = false;
      this.botChat = new BotChatView(
        store, getActiveNetworkClient(), getActiveServerStore(), channelId, composer, messagesFeed,
        () => {
          const selected = !!store.getCommandDraft(channelId);
          this.syncComposerPermissionState();
          if (input && (selected || wasSelected)) {
            input.value = store.getDraft(channelId);
            if (charCounter) charCounter.textContent = `${input.value.length}/${LIMITS.MAX_MESSAGE_LENGTH}`;
            if (!selected) autoResize();
          }
          if (selected && composeLinkPreviewEl) composeLinkPreviewEl.style.display = 'none';
          if (selected && this.pending.length > 0) this.showCommandNotice(t('botChat.attachmentsKept'));
          if (!selected && wasSelected) {
            this.showCommandNotice('');
            this.focusChatInput();
          }
          wasSelected = selected;
          if (this.pinnedToBottom) this.scrollToBottom();
        },
        (invocation) => this.renderInvocationCard(invocation)
      );
    }
  }

  private renderInvocationCard(invocation: BotInvocation): void {
    const feed = this.container.querySelector<HTMLElement>('#chat-messages-feed');
    if (!feed || invocation.channelId !== this.currentChannelId) return;
    const shouldScroll = this.isFeedAtBottom(feed);
    const previous = [...feed.querySelectorAll<HTMLElement>('[data-invocation-id]')]
      .find((element) => element.dataset.invocationId === invocation.invocationId);
    const focused = document.activeElement;
    const focusId = focused instanceof HTMLElement && previous?.contains(focused) ? focused.id : '';
    const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? { start: focused.selectionStart, end: focused.selectionEnd }
      : undefined;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderBotInvocation(invocation, !this.getBotCommandDeniedReason());
    const card = wrapper.firstElementChild;
    if (!card) {
      previous?.remove();
      if (shouldScroll) this.scrollToBottom();
      return;
    }
    if (previous) previous.replaceWith(card);
    else {
      feed.querySelector('#chat-empty-placeholder')?.remove();
      feed.appendChild(card);
    }
    for (const element of feed.querySelectorAll<HTMLElement>('[data-invocation-id]')) {
      if (!chatStore.getInvocation(element.dataset.invocationId ?? '')) element.remove();
    }
    if (focusId) {
      const next = document.getElementById(focusId);
      next?.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.end !== null &&
          (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && next.type !== 'checkbox') {
        next.setSelectionRange(selection?.start ?? 0, selection?.end ?? 0);
      }
    }
    if (shouldScroll) this.scrollToBottom();
  }

  private showCommandNotice(message: string): void {
    const notice = this.container.querySelector<HTMLElement>('#chat-command-notice');
    if (notice) {
      notice.textContent = message;
      notice.hidden = !message;
    }
  }

  private scrollToBottom(): void {
    const feed = document.getElementById('chat-messages-feed');
    if (feed) {
      feed.scrollTop = feed.scrollHeight;
      // The feed height is still settling right after the markup swap.
      requestAnimationFrame(() => {
        if (this.pinnedToBottom) feed.scrollTop = feed.scrollHeight;
      });
    }
  }

  private updateMentionDropup(input: HTMLTextAreaElement): void {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.substring(0, caret);
    // A mention token is an "@" at start/after whitespace, followed by the
    // nickname typed so far (no spaces — nicknames may contain spaces but the
    // full name is inserted on selection, ending the token).
    const match = before.match(/(?:^|\s)@([\w.\-]*)$/);
    if (!match) {
      this.closeMentionDropup();
      return;
    }
    const query = match[1].toLowerCase();
    this.mentionAtIndex = caret - match[1].length - 1;

    const all = serverStore.getMentionableUsers();
    const users = (query ? all.filter((u) => u.nickname.toLowerCase().includes(query)) : all)
      // Prioritize names that start with the query.
      .sort((a, b) => {
        const aStarts = a.nickname.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.nickname.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, 8);

    const matches: MentionCandidate[] = users.map((user) => ({ kind: 'user' as const, user }));

    // The channel-wide token leads the list when it matches what is being typed
    // and the server allows it (#464). Every spelling is accepted on the way in,
    // so suggesting only the one in the current language is enough.
    if (serverStore.serverDetails?.allowEveryoneMention !== false) {
      const suggested = EVERYONE_MENTION_TOKENS.find((token) => token.startsWith(query));
      const preferred = t('chat.everyoneMentionToken');
      const token = EVERYONE_MENTION_TOKENS.includes(preferred as typeof EVERYONE_MENTION_TOKENS[number])
        && preferred.startsWith(query)
        ? preferred
        : suggested;
      if (token) matches.unshift({ kind: 'everyone', token });
    }

    if (matches.length === 0) {
      this.closeMentionDropup();
      return;
    }

    this.mentionMatches = matches;
    this.mentionActive = true;
    if (this.mentionActiveIndex >= matches.length || this.mentionActiveIndex < 0) {
      this.mentionActiveIndex = 0;
    }
    this.renderMentionDropup();
  }

  private renderMentionDropup(): void {
    const el = document.getElementById('mention-dropup');
    if (!el) return;
    el.innerHTML = this.mentionMatches
      .map((candidate, i) => {
        const active = i === this.mentionActiveIndex ? 'active' : '';
        if (candidate.kind === 'everyone') {
          return `
            <div class="mention-item ${active}" data-mention-index="${i}">
              <span class="material-symbols-outlined md-18 mention-everyone-icon">campaign</span>
              <span class="mention-nick">@${escapeHtml(candidate.token)}</span>
              <span class="mention-everyone-hint">${escapeHtml(t('chat.everyoneMentionHint'))}</span>
            </div>
          `;
        }
        const u = candidate.user;
        const online = u.status !== 'DISCONNECTED';
        return `
          <div class="mention-item ${active}" data-mention-index="${i}">
            <img class="mention-avatar" src="${getAvatarUrl(u.avatarUrl)}" data-fallback="avatar">
            <span class="mention-nick">${escapeHtml(u.nickname)}</span>
            <span class="mention-status-dot ${online ? 'online' : 'offline'}"></span>
          </div>
        `;
      })
      .join('');
    el.style.display = 'block';

    el.querySelectorAll('.mention-item').forEach((item) => {
      item.addEventListener('mouseenter', () => {
        const idx = parseInt((item as HTMLElement).getAttribute('data-mention-index') || '0', 10);
        this.mentionActiveIndex = idx;
        el.querySelectorAll('.mention-item').forEach((el, i) => {
          el.classList.toggle('active', i === idx);
        });
      });
      // mousedown (not click) + preventDefault keeps focus in the textarea.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = parseInt((item as HTMLElement).getAttribute('data-mention-index') || '0', 10);
        this.applyMention(idx);
      });
    });
  }

  private applyMention(index: number): void {
    const input = document.getElementById('chat-message-input') as HTMLTextAreaElement | null;
    const candidate = this.mentionMatches[index];
    if (!input || !candidate || this.mentionAtIndex < 0) {
      this.closeMentionDropup();
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.substring(0, this.mentionAtIndex);
    const after = input.value.substring(caret);
    const insert = candidate.kind === 'everyone' ? `@${candidate.token} ` : `@${candidate.user.nickname} `;
    input.value = `${before}${insert}${after}`;
    const newCaret = before.length + insert.length;
    input.setSelectionRange(newCaret, newCaret);
    this.closeMentionDropup();
    input.focus();

    const charCounter = document.getElementById('chat-char-counter');
    if (charCounter) {
      charCounter.innerText = `${input.value.length}/${LIMITS.MAX_MESSAGE_LENGTH}`;
    }
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    this.persistDraft(input.value);
  }

  /**
   * Keeps the store in sync with the composer so the text is still there after
   * the view is rebuilt (#478). Called from every place that writes to the
   * textarea without going through a real `input` event.
   */
  private persistDraft(text: string): void {
    if (!this.currentChannelId) return;
    chatStore.setDraft(this.currentChannelId, text);
  }

  private closeMentionDropup(): void {
    this.mentionActive = false;
    this.mentionMatches = [];
    this.mentionActiveIndex = 0;
    this.mentionAtIndex = -1;
    const el = document.getElementById('mention-dropup');
    if (el) {
      el.style.display = 'none';
      el.innerHTML = '';
    }
  }

  // ── Slash command dropup (#569) ──────────────────────────────────────

  private getBotCommandDeniedReason(): string | undefined {
    const channel = serverStore.serverDetails?.channels.find((candidate) => candidate.id === this.currentChannelId);
    if (!channel || channel.type !== 'TEXT' || !channel.botCommandsEnabled) {
      return t('botChat.commandsDisabledInChannel');
    }
    if (!serverStore.hasPermission(Permission.USE_BOT_COMMANDS)) return t('botChat.commandsPermissionDenied');
    if (!serverStore.hasPermission(Permission.SEND_MESSAGES)) return t('chat.sendPermissionDenied');
    return undefined;
  }

  private updateCommandDropup(input: HTMLTextAreaElement): void {
    if (this.currentChannelId && chatStore.getCommandDraft(this.currentChannelId)) {
      this.closeCommandDropup();
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.substring(0, caret);
    // A command token is a "/" at the very start of the message, followed by
    // the partial command name typed so far (no spaces in the name).
    const match = before.match(/^\/([a-z0-9_-]*)$/i);
    if (!match) {
      this.closeCommandDropup();
      return;
    }
    if (this.getBotCommandDeniedReason()) {
      this.commandGroups = [];
      this.commandMatches = [];
      this.commandActive = true;
      this.renderCommandDropup();
      return;
    }
    const query = match[1].toLowerCase();
    const all = chatStore.getCommands();
    const matches = query
      ? all.filter((command) => command.name.includes(query) || command.botName.toLocaleLowerCase(getLanguage()).includes(query))
      : all;
    const previous = query === this.commandQuery ? this.commandMatches[this.commandActiveIndex] : undefined;
    const retained = previous && matches.find((command) => command.botId === previous.botId && command.name === previous.name);
    const exact = matches.filter((command) => command.name === query);
    const preferred = retained ?? (exact.length === 1 ? exact[0] : undefined);
    this.commandQuery = query;
    this.commandGroups = groupCommands(matches, chatStore.getCommandUsage(), getLanguage(), query.length === 0);
    this.commandMatches = this.commandGroups.flatMap((group) => group.commands);
    this.commandActive = true;
    this.commandActiveIndex = Math.max(0, this.commandMatches.findIndex((command) =>
      preferred !== undefined && command.botId === preferred.botId && command.name === preferred.name));
    this.renderCommandDropup();
  }

  private renderCommandDropup(): void {
    const el = document.getElementById('command-dropup');
    if (!el) return;
    const denied = this.getBotCommandDeniedReason();
    if (denied) {
      const input = this.container.querySelector('#chat-message-input');
      for (const attribute of ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-activedescendant']) input?.removeAttribute(attribute);
      el.innerHTML = `<div class="command-empty-frequency" role="status">${escapeHtml(denied)}</div>`;
      el.style.display = 'block';
      return;
    }
    el.innerHTML = renderCommandCatalog(this.commandGroups, this.commandActiveIndex);
    el.style.display = 'block';
    const input = this.container.querySelector<HTMLTextAreaElement>('#chat-message-input');
    input?.setAttribute('role', 'combobox');
    input?.setAttribute('aria-expanded', 'true');
    input?.setAttribute('aria-controls', 'command-list-options');
    input?.setAttribute('aria-autocomplete', 'list');
    el.querySelectorAll<HTMLElement>('[data-cmd-index]').forEach((item) => {
      item.addEventListener('mouseenter', () => {
        this.setActiveCommand(Number(item.dataset.cmdIndex), false);
      });
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => this.applyCommand(Number(item.dataset.cmdIndex)));
    });
    const groupButtons = [...el.querySelectorAll<HTMLButtonElement>('[data-command-group]')];
    groupButtons.forEach((button, index) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const section = [...el.querySelectorAll<HTMLElement>('[data-command-section]')]
          .find((element) => element.dataset.commandSection === button.dataset.commandGroup);
        section?.scrollIntoView({ block: 'start', inline: 'nearest' });
        const first = section?.querySelector<HTMLElement>('[data-cmd-index]');
        if (first) this.setActiveCommand(Number(first.dataset.cmdIndex), false);
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          const next = groupButtons[(index + offset + groupButtons.length) % groupButtons.length];
          next?.focus();
          next?.click();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.closeCommandDropup();
          input?.focus();
        }
      });
    });
    this.setActiveCommand(this.commandActiveIndex, false);
  }

  private setActiveCommand(index: number, scroll = true): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.commandMatches.length) return;
    this.commandActiveIndex = index;
    const dropup = this.container.querySelector<HTMLElement>('#command-dropup');
    let active: HTMLElement | undefined;
    dropup?.querySelectorAll<HTMLElement>('[data-cmd-index]').forEach((row) => {
      const selected = Number(row.dataset.cmdIndex) === index;
      row.classList.toggle('active', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected) active = row;
    });
    const groupId = active?.closest<HTMLElement>('[data-command-section]')?.dataset.commandSection;
    dropup?.querySelectorAll<HTMLButtonElement>('[data-command-group]').forEach((button) => {
      button.classList.toggle('active', button.dataset.commandGroup === groupId);
    });
    this.container.querySelector('#chat-message-input')?.setAttribute('aria-activedescendant', `command-option-${index}`);
    if (scroll) active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private applyCommand(index: number): void {
    const denied = this.getBotCommandDeniedReason();
    if (denied) {
      this.showCommandNotice(denied);
      this.renderCommandDropup();
      return;
    }
    const input = document.getElementById('chat-message-input') as HTMLTextAreaElement | null;
    const cmd = this.commandMatches[index];
    if (!input || !cmd) {
      this.closeCommandDropup();
      return;
    }
    const typed = parseTypedCommand(input.value, chatStore.getCommands());
    this.selectCommand(cmd, typed.kind === 'command' || typed.kind === 'ambiguous' ? typed.text : '');
  }

  private selectCommand(command: SlashCommand, text = ''): void {
    if (!this.currentChannelId) return;
    this.showCommandNotice('');
    this.closeMentionDropup();
    this.closeCommandDropup();
    this.emojiPicker?.close();
    chatStore.selectCommand(this.currentChannelId, command, text);
    const draft = chatStore.getCommandDraft(this.currentChannelId);
    if (draft && !command.options?.length && text.trim()) {
      chatStore.setCommandPending(this.currentChannelId, draft, false, t('botChat.unexpectedText'));
    } else if (draft && !command.options?.length) {
      void this.botChat?.invoke();
      return;
    }
    this.botChat?.focusComposer();
  }

  private closeCommandDropup(): void {
    this.commandActive = false;
    this.commandMatches = [];
    this.commandGroups = [];
    this.commandActiveIndex = 0;
    this.commandQuery = '';
    const input = this.container.querySelector('#chat-message-input');
    for (const attribute of ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-activedescendant']) input?.removeAttribute(attribute);
    const el = document.getElementById('command-dropup');
    if (el) {
      el.style.display = 'none';
      el.innerHTML = '';
    }
  }

  /**
   * Inserts text (an emoji) where the caret is, then replays an `input` event so
   * the character counter, auto-resize and mention logic all react as if the
   * user had typed it (#356).
   */
  private insertAtCaret(text: string): void {
    const input = this.container.querySelector('#chat-message-input') as HTMLTextAreaElement | null;
    if (!input || input.readOnly) return;

    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + text + input.value.slice(end);
    if (next.length > LIMITS.MAX_MESSAGE_LENGTH) return;

    input.value = next;
    const caret = start + text.length;
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Sends a code block as its own message (#391). The fence is plain text, so
   * this goes out through the same path as any other message and needs no
   * protocol change.
   */
  private sendCodeBlock(language: string, code: string): void {
    const channelId = this.currentChannelId;
    if (!channelId) return;
    if (this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SEND_MESSAGES)) {
      void showAlert({ message: t('chat.sendPermissionDenied'), variant: 'danger' });
      return;
    }

    const content = buildCodeMessage(language, code);
    if (!code.trim() || content.length > LIMITS.MAX_MESSAGE_LENGTH) return;

    const reply = chatStore.getReplyDraft(channelId);
    if (reply?.deleted) { void showAlert({ message: t('chat.replyUnavailable'), variant: 'danger' }); return; }
    networkClient.send(MessageType.CHAT_SEND, { channelId, content, replyToMessageId: reply?.messageId });
    this.clearReply();
  }

  /**
   * Sends a sticker as its own message (#356): the image goes through the normal
   * attachment upload and the message text carries only the marker that tells
   * every client to draw it as a fixed-size square.
   */
  private async sendSticker(sticker: StickerEntry): Promise<void> {
    const channelId = this.currentChannelId;
    if (!channelId) return;
    const client = getActiveNetworkClient();
    const store = getActiveChatStore();
    const reply = store.getReplyDraft(channelId);
    if (reply?.deleted) { void showAlert({ message: t('chat.replyUnavailable'), variant: 'danger' }); return; }
    if (
      this.arePermissionsResolved() &&
      (!serverStore.hasPermission(Permission.SEND_MESSAGES) || !serverStore.hasPermission(Permission.ATTACH_FILES))
    ) {
      void showAlert({ message: t('chat.stickerPermissionDenied'), variant: 'danger' });
      return;
    }

    try {
      const file = await stickerService.toFile(sticker);
      if (!file) throw new Error(t('chat.stickerReadFailed'));

      const meta = await uploadAttachment(channelId, file).promise;
      client.send(MessageType.CHAT_SEND, {
        channelId,
        content: stickerToken(meta.id),
        attachmentIds: [meta.id],
        replyToMessageId: reply?.messageId,
      });
      if (store.getReplyDraft(channelId) === reply) store.setReplyDraft(channelId);
      this.renderReplyComposer();
    } catch (e) {
      void showAlert({
        message: e instanceof Error ? e.message : t('chat.stickerSendFailed'),
        variant: 'danger',
      });
    }
  }

  private addFiles(fileList: FileList): void {
    if (!this.currentChannelId) return;
    if (this.arePermissionsResolved() && (!serverStore.hasPermission(Permission.SEND_MESSAGES) || !serverStore.hasPermission(Permission.ATTACH_FILES))) {
      return;
    }
    const channelId = this.currentChannelId;
    const maxFile =
      serverStore.serverDetails?.attachmentStorage?.maxFileBytes ??
      LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT;
    let overflow = false;

    for (const file of Array.from(fileList)) {
      if (this.pending.length >= LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        overflow = true;
        break;
      }

      const isImage = file.type.startsWith('image/');
      const item: PendingAttachment = {
        localId: `up-${++this.uploadSeq}`,
        name: file.name,
        size: file.size,
        isImage,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        status: 'uploading',
        progress: 0,
      };

      if (file.size > maxFile) {
        item.status = 'error';
        item.error = `Maior que o limite (${formatBytes(maxFile)})`;
        this.pending.push(item);
        continue;
      }

      this.pending.push(item);
      const handle = uploadAttachment(channelId, file, (frac) => {
        item.progress = frac;
        this.updatePendingProgress(item.localId);
      });
      item.handle = handle;
      handle.promise
        .then((meta) => {
          item.status = 'done';
          item.meta = meta;
          item.handle = undefined;
          this.renderTray();
          this.updateSendButtonState();
        })
        .catch((err) => {
          // A cancelled upload was already removed from the list; ignore it.
          if (!this.pending.includes(item)) return;
          item.status = 'error';
          item.error = err?.message || 'Falha no upload';
          item.handle = undefined;
          this.renderTray();
          this.updateSendButtonState();
        });
    }

    this.renderTray();
    this.updateSendButtonState();
    if (overflow) {
      this.showTrayNotice(t('chat.tooManyAttachments', { max: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE }));
    }
  }

  private renderTray(): void {
    const tray = document.getElementById('chat-attachment-tray');
    if (!tray) return;
    if (this.pending.length === 0) {
      tray.style.display = 'none';
      tray.innerHTML = '';
      return;
    }
    tray.style.display = 'flex';
    tray.innerHTML = this.pending.map((p) => this.renderTrayItem(p)).join('');
    tray.querySelectorAll('[data-remove-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-remove-id');
        if (id) this.removePending(id);
      });
    });
  }

  private renderTrayItem(p: PendingAttachment): string {
    const thumb =
      p.isImage && p.previewUrl
        ? `<img class="tray-thumb" src="${p.previewUrl}" alt="">`
        : `<span class="material-symbols-outlined md-22 tray-thumb-icon">draft</span>`;

    let statusHtml: string;
    if (p.status === 'uploading') {
      const pct = Math.round(p.progress * 100);
      statusHtml = `
        <div class="tray-progress"><div class="tray-progress-bar" data-progress-id="${p.localId}" style="width: ${pct}%;"></div></div>
        <span class="tray-status" data-progress-label="${p.localId}">${pct}%</span>
      `;
    } else if (p.status === 'error') {
      statusHtml = `<span class="tray-status tray-error">${escapeHtml(p.error || t('common.error'))}</span>`;
    } else {
      statusHtml = `<span class="tray-status tray-done">${t('common.done')}</span>`;
    }

    return `
      <div class="tray-item ${p.status === 'error' ? 'is-error' : ''}" data-local-id="${p.localId}" title="${escapeHtml(p.name)}">
        ${thumb}
        <div class="tray-info">
          <span class="tray-name">${escapeHtml(p.name)}</span>
          <div class="tray-sub">
            <span class="tray-size">${formatBytes(p.size)}</span>
            ${statusHtml}
          </div>
        </div>
        <button type="button" class="tray-remove" data-remove-id="${p.localId}" title="${t('common.remove')}">
          <span class="material-symbols-outlined md-18">close</span>
        </button>
      </div>
    `;
  }

  private updatePendingProgress(localId: string): void {
    const item = this.pending.find((p) => p.localId === localId);
    if (!item) return;
    const pct = Math.round(item.progress * 100);
    const bar = document.querySelector(`[data-progress-id="${localId}"]`) as HTMLElement | null;
    if (bar) bar.style.width = `${pct}%`;
    const label = document.querySelector(`[data-progress-label="${localId}"]`) as HTMLElement | null;
    if (label) label.innerText = `${pct}%`;
  }

  private updateSendButtonState(): void {
    const btnSend = document.getElementById('btn-send-message') as HTMLButtonElement | null;
    if (!btnSend) return;
    const uploading = this.pending.some((p) => p.status === 'uploading');
    const permissionLocked = this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SEND_MESSAGES);
    btnSend.disabled = uploading || permissionLocked;
    btnSend.style.opacity = uploading ? '0.6' : '';
    btnSend.style.cursor = uploading ? 'not-allowed' : '';
  }

  private removePending(localId: string): void {
    const idx = this.pending.findIndex((p) => p.localId === localId);
    if (idx < 0) return;
    const [item] = this.pending.splice(idx, 1);
    item.handle?.cancel();
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.renderTray();
    this.updateSendButtonState();
  }

  private clearPending(): void {
    for (const p of this.pending) {
      p.handle?.cancel();
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
    this.pending = [];
    this.renderTray();
    this.updateSendButtonState();
  }

  private showTrayNotice(message: string): void {
    const tray = document.getElementById('chat-attachment-tray');
    if (!tray) return;
    const notice = document.createElement('div');
    notice.className = 'tray-notice';
    notice.innerText = message;
    tray.appendChild(notice);
    setTimeout(() => notice.remove(), 3000);
  }

  private async downloadAttachment(url: string, fileName: string): Promise<void> {
    await downloadLightboxFile(url, fileName);
  }

  private unbindListeners(): void {
    this.copyRequestId++;
    this.clearCopyFeedback?.();
    contextMenu.close();
    this.pendingJumpId = null;
    this.publicSelectors?.destroy();
    this.publicSelectors = null;
    this.botChat?.destroy();
    this.botChat = null;
    this.closeCommandDropup();
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
  }

  public destroy(): void {
    lightboxModal.close();
    this.clearPending();
    this.unbindListeners();
  }
}
