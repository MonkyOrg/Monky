import { LIMITS, MessageType, Permission, messageBlocksContent, messageBlocksInput, parseFencedMessageBlocks } from '@monky/shared';
import type {
  AttachmentMeta,
  ChatMessage,
  ChatMessageUpdatedPayload,
  ChatSendPayload,
  MessageReply,
  ResolvedMessageBlock,
  StickerEntry,
} from '@monky/shared';
import { uploadAttachment } from '../../core/AttachmentUploader';
import { appEvents } from '../../core/EventBus';
import { getActiveNetworkClient, networkClient } from '../../core/NetworkClient';
import { stickerService } from '../../core/StickerService';
import { t } from '../../i18n';
import { chatStore, getActiveChatStore, type MessageEditDraft, type MessageEditError, type OutgoingMessage } from '../../stores/chatStore';
import { serverStore } from '../../stores/serverStore';
import { formatBytes } from '../../utils/attachment';
import { parseTypedCommand } from '../../utils/botInputs';
import { openFileInputPicker } from '../../utils/buttonLoading';
import { errorMessage, reportError } from '../../utils/feedback';
import { renderReplyPreview } from '../../utils/messageReply';
import { stickerToken } from '../../utils/stickers';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import { bindChatComposer, setComposerEditMode } from '../ChatComposer';
import { buildCodeMessage, codeBlockModal } from '../CodeBlockModal';
import { EmojiPicker } from '../EmojiPicker';
import type { MarkdownInput } from '../MarkdownInput';
import { renderMessageBlockComposer } from '../MessageBlockComposer';
import { openNativePollWizard } from '../NativePollWizard';
import { AttachmentTray, listFileNames } from './AttachmentTray';
import type { ChatContext } from './chatContext';
import { ComposeLinkPreview } from './ComposeLinkPreview';

/**
 * The message composer of a channel (R-CHAT-10): the text box and its draft,
 * replies and code blocks, attachments, stickers and emoji, sending (and
 * retrying), editing a sent message, and what the member's permissions allow
 * right now.
 */
export class ChatComposerController {
  /** Files picked for the next message, uploaded as soon as they are picked (#11). */
  public readonly tray: AttachmentTray;
  /** The text box of the channel on screen; let go of when the view is rebuilt or the session's chat is cleared. */
  private input: MarkdownInput | null = null;
  /** The channel the text box was bound for. */
  private channelId: string | null = null;
  private counter: HTMLElement | null = null;
  private linkPreview: ComposeLinkPreview | null = null;
  /** Emoji/sticker popover anchored to the composer (#356). */
  private emojiPicker: EmojiPicker | null = null;
  /** A message of blocks is on its way to a server that does not confirm deliveries one by one. */
  private blockSendPending = false;
  /** The refusal last announced for each edit, so drawing the composer again does not repeat it. */
  private readonly announcedEditErrors = new WeakMap<MessageEditDraft, MessageEditError>();

  constructor(private readonly ctx: ChatContext) {
    this.tray = new AttachmentTray({
      maxFiles: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE,
      maxBytes: () => serverStore.serverDetails?.attachmentStorage?.maxFileBytes ?? LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT,
      tooLarge: (files, limit) => files.length === 1
        ? t('chat.attachmentTooLarge', { name: files[0].name, size: formatBytes(limit) })
        : t('chat.attachmentsTooLarge', { names: listFileNames(files), size: formatBytes(limit) }),
      tooMany: (max) => t('chat.tooManyAttachments', { max }),
      upload: (file, progress) => uploadAttachment(ctx.channelId ?? '', file, progress),
      hidden: () => !!this.messageEdit,
      onChange: () => this.syncPermissionState(),
    });
  }

  public get messageLengthLimit(): number {
    const { server } = this.ctx;
    return server.serverDetails?.maxMessageLength ?? (server.serverDetails ? 2000 : LIMITS.MAX_MESSAGE_LENGTH);
  }

  private get messageLimitLabel(): string { return this.messageLengthLimit === 0 ? '∞' : String(this.messageLengthLimit); }

  private isMessageTooLong(content: string): boolean {
    return this.messageLengthLimit > 0 && content.length > this.messageLengthLimit;
  }

  /** The sent message being edited in the composer, if any. */
  public get messageEdit(): MessageEditDraft | undefined {
    const channelId = this.ctx.channelId;
    return channelId ? this.ctx.store.getMessageEdit(channelId) : undefined;
  }

  public get hasInput(): boolean {
    return this.input !== null;
  }

  /** Whether the composer on screen belongs to this view's session and to the channel shown. */
  public isCurrent(): boolean {
    return this.ctx.isCurrentSession() && !!this.input?.isConnected &&
      this.channelId === this.ctx.channelId;
  }

  /** Whether `input` is still the text box the composer works with. */
  public owns(input: MarkdownInput | null): boolean {
    return input === this.input && this.isCurrent();
  }

  /** The text box stops writing to the session: the view was rebuilt or the session's chat cleared. */
  public release(): void {
    this.input = null;
    this.channelId = null;
  }

  /** Keeps what is typed, so it is still there when the view is drawn again (#478). */
  public rememberText(): void {
    const channelId = this.channelId;
    if (!channelId || !this.input) return;
    const { store } = this.ctx;
    if (store.getMessageEdit(channelId)) store.setMessageEditContent(channelId, this.input.value);
    else store.setDraft(channelId, this.input.value);
  }

  public focus(options?: { defer?: boolean }): void {
    const applyFocus = () => {
      if (!this.isCurrent()) return;
      const channelId = this.ctx.channelId;
      if (!this.messageEdit && channelId && this.ctx.store.getCommandDraft(channelId)) {
        this.ctx.commands.focusComposer();
        return;
      }
      const input = this.ctx.container.querySelector<MarkdownInput>('#chat-message-input');
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

  /** Wires the composer the view just drew. Returns what undoes it. */
  public bind(input: MarkdownInput | null): () => void {
    const { container } = this.ctx;
    const unbind: Array<() => void> = [];
    this.input = input;
    this.channelId = this.ctx.channelId;
    this.counter = container.querySelector<HTMLElement>('#chat-char-counter');
    const isCurrentInput = () => this.owns(input);
    if (input) {
      unbind.push(bindChatComposer(container, {
        input,
        isActive: isCurrentInput,
        canAcceptFiles: () => !this.messageEdit && this.canAttachFiles(),
        acceptFiles: (files) => {
          if (!serverStore.hasPermission(Permission.ATTACH_FILES, this.ctx.channelId)) return false;
          this.addFiles(files);
          return true;
        },
        focus: () => this.focus(),
      }));
    }
    const linkPreview = new ComposeLinkPreview(container.querySelector<HTMLElement>('#chat-compose-link-preview'), input, () => {
      const channelId = this.ctx.channelId;
      return !this.messageEdit && !!channelId && !!chatStore.getCommandDraft(channelId);
    });
    this.linkPreview = linkPreview;
    unbind.push(() => linkPreview.destroy());

    if (input) {
      input.addEventListener('input', (event) => this.handleInput(input, event));
      // Also detect URL on paste immediately
      input.addEventListener('paste', () => linkPreview.schedule('paste'));
    }

    // A restored draft (#478) has to look exactly like it did before the view
    // was rebuilt. It is assigned here rather than written into the template
    // because the HTML parser silently eats a newline right after the opening
    // `<textarea>` tag, which would swallow the first line of a draft that
    // starts with a line break.
    const channelId = this.ctx.channelId;
    const draft = this.messageEdit?.content ?? (channelId ? this.ctx.store.getDraft(channelId) : '');
    if (input && draft.length > 0) {
      input.value = draft;
      this.setCounter(input.value.length);
      input.refresh();
      linkPreview.update();
    }

    unbind.push(
      this.followEdit(input, linkPreview),
      this.bindCreateMenu(isCurrentInput),
      this.bindEmojiPicker(isCurrentInput),
      this.bindCodeButton(input, isCurrentInput),
    );

    // Re-render the tray for any files staged before this (re)render.
    this.tray.render();
    this.renderReply();
    this.syncPermissionState();

    if (input) {
      input.addEventListener('keydown', (event) => this.handleKeydown(input, event), true);
      unbind.push(this.bindDropupBlur(input));
    }
    container.querySelector('#btn-send-message')?.addEventListener('click', () => {
      if (input) void this.send(input);
    });
    container.querySelector('#btn-cancel-message-edit')?.addEventListener('click', () => this.cancelMessageEdit());
    return () => unbind.forEach((entry) => entry());
  }

  /** The server's limits or the member's permissions changed. */
  public refreshSettings(input: MarkdownInput | null): void {
    if (input) {
      if (this.messageLengthLimit > 0) input.maxLength = this.messageLengthLimit;
      else input.removeAttribute('maxlength');
    }
    this.syncPermissionState();
    this.updateCounter();
    this.renderBlocks();
    this.refreshMentions(input);
  }

  /** The open mention list follows who may read the channel now. */
  public refreshMentions(input: MarkdownInput | null): void {
    if (input && (this.ctx.mentions.isOpen || input.hasFocus)) this.ctx.mentions.update(input);
  }

  /** Reading the channel was revoked: nothing written in answer to it stays on screen. */
  public clearForRevokedRead(): void {
    if (this.input) this.input.value = '';
    this.renderReply();
  }

  /** A command was picked or put away: the text box gives way to the command form, or takes its place back. */
  public commandDraftChanged(input: MarkdownInput | null, selected: boolean, wasSelected: boolean): void {
    const channelId = this.ctx.channelId;
    if (!channelId) return;
    this.syncPermissionState();
    if (!this.messageEdit && input && (selected || wasSelected)) {
      input.value = this.ctx.store.getDraft(channelId);
      this.setCounter(input.value.length);
      if (!selected) input.refresh();
    }
    if (selected && !this.messageEdit) this.linkPreview?.hide();
    if (selected && !this.messageEdit && this.tray.count > 0) this.ctx.commands.showInfo(t('botChat.attachmentsKept'));
    if (!selected && wasSelected && !this.messageEdit) {
      this.ctx.commands.showNotice('');
      this.focus();
    }
  }

  /** Text the view wrote into the box (a mention picked) is counted, fitted and kept like typed text. */
  public textInserted(input: MarkdownInput): void {
    this.setCounter(input.value.length);
    input.refresh();
    this.persistDraft(input.value);
  }

  public closeEmojiPicker(): void {
    this.emojiPicker?.close();
  }

  /** Edit text and the new-message draft occupy separate, session-owned slots. */
  public startEditingMessage(messageId: string): void {
    const { store, server } = this.ctx;
    const channelId = this.ctx.channelId;
    if (!this.isCurrent() || !channelId) return;
    const message = store.getMessages(channelId).find((entry) => entry.id === messageId);
    if (!message || message.isSystem || message.isEphemeral || message.deletedAt || store.getOutgoing(message.id) ||
        message.userId !== server.currentUser?.id || server.serverDetails?.allowMessageEdit === false) return;
    this.rememberText();
    const previous = store.getMessageEdit(channelId);
    if (previous) {
      if (previous.message.id !== messageId && !previous.pending) this.refuseEdit(channelId, previous, 'in-progress');
      this.focus();
      return;
    }
    store.beginMessageEdit(message);
    this.focus();
  }

  public cancelMessageEdit(): void {
    const channelId = this.ctx.channelId;
    if (!this.isCurrent() || !channelId) return;
    const edit = this.ctx.store.getMessageEdit(channelId);
    if (!edit || edit.pending) return;
    this.ctx.store.finishMessageEdit(channelId, edit);
    this.focus();
  }

  public startReply(messageId: string): void {
    const channelId = this.ctx.channelId;
    if (!this.isCurrent() || this.messageEdit || !channelId || !serverStore.hasPermission(Permission.SEND_MESSAGES, channelId)) return;
    const message = chatStore.getMessages(channelId).find((entry) => entry.id === messageId);
    if (!message || message.deletedAt || message.isSystem || message.isEphemeral || this.ctx.store.getOutgoing(message.id)) return;
    if (this.ctx.server.serverDetails?.protocol?.features.includes('chat-blocks')) {
      this.addBlock({ type: 'reply', messageId: message.id, reply: this.ctx.store.messageReply(message) });
      return;
    }
    chatStore.setReplyDraft(channelId, message);
    this.renderReply();
    this.focus();
  }

  public renderReply(): void {
    this.renderBlocks();
    const el = this.ctx.container.querySelector<HTMLElement>('#chat-reply-composer');
    if (!el) return;
    const channelId = this.ctx.channelId;
    const reply = channelId ? chatStore.getReplyDraft(channelId) : undefined;
    if (this.messageEdit || !reply) {
      setSurfaceVisible(el, false, 'panel', undefined, () => el.replaceChildren());
      return;
    }
    el.innerHTML = reply ? `<div class="chat-quote">${renderReplyPreview(reply)}
      <button type="button" aria-label="${t('chat.cancelReply')}" title="${t('chat.cancelReply')}"><span class="material-symbols-outlined md-18" aria-hidden="true">close</span></button></div>` : '';
    el.querySelector('button')?.addEventListener('click', () => {
      this.clearReply();
      this.focus();
    });
    setSurfaceVisible(el, true);
  }

  public renderBlocks(): void {
    const root = this.ctx.container.querySelector<HTMLElement>('#chat-composer-blocks');
    const channelId = this.ctx.channelId;
    if (!root || !channelId) return;
    if (this.messageEdit) { setSurfaceVisible(root, false); return; }
    renderMessageBlockComposer(root, this.ctx.store, channelId, () => this.updateCounter(),
      this.blockSendPending || !this.isCurrent() || !this.ctx.server.hasPermission(Permission.SEND_MESSAGES, channelId));
    this.updateCounter();
  }

  public updateCounter(): void {
    const { container, store } = this.ctx;
    const input = container.querySelector<MarkdownInput>('#chat-message-input');
    if (!input) return;
    const channelId = this.ctx.channelId;
    const blocks = channelId && !this.messageEdit ? store.getBlockDraft(channelId) : [];
    const content = blocks.length ? messageBlocksContent([...blocks, { type: 'text', text: input.value }]) : input.value;
    const counter = container.querySelector<HTMLElement>('#chat-char-counter');
    if (counter) {
      counter.textContent = `${content.length}/${this.messageLimitLabel}`;
      counter.classList.toggle('code-char-count--over', this.isMessageTooLong(content));
    }
  }

  public syncPermissionState(): void {
    if (!this.isCurrent()) return;
    const { container } = this.ctx;
    const channelId = this.ctx.channelId;
    const input = container.querySelector<MarkdownInput>('#chat-message-input');
    const inputWrapper = container.querySelector<HTMLElement>('.chat-input-wrapper');
    const permissionBanner = container.querySelector<HTMLElement>('#chat-send-permission-banner');
    const btnSend = container.querySelector<HTMLButtonElement>('#btn-send-message');
    const btnAttach = container.querySelector<HTMLButtonElement>('#btn-attach');
    const btnEmoji = container.querySelector<HTMLButtonElement>('#btn-emoji');
    const btnCode = container.querySelector<HTMLButtonElement>('#btn-code');
    if (!input || !inputWrapper) return;

    // Without reading there is no conversation to answer: the feed explains the
    // denial on its own, so the composer steps aside instead of repeating it.
    const inputContainer = container.querySelector<HTMLElement>('.chat-input-container');
    if (inputContainer && channelId) {
      setSurfaceVisible(inputContainer, serverStore.hasPermission(Permission.READ_MESSAGES, channelId));
    }

    const edit = this.messageEdit;
    // What keeps Save off stays in the edit banner; a save that failed or was refused goes to the toast.
    const editBlocked = edit ? this.messageEditDeniedReason(edit) ?? '' : '';
    setComposerEditMode(container, { editing: !!edit, saving: !!edit?.pending });
    const editErrorEl = container.querySelector<HTMLElement>('#chat-edit-error');
    if (editErrorEl) {
      editErrorEl.hidden = !editBlocked;
      if (editErrorEl.textContent !== editBlocked) editErrorEl.textContent = editBlocked;
    }
    this.announceEditError(edit, input);

    const channelName = serverStore.serverDetails?.channels.find((c) => c.id === channelId)?.name || t('chat.defaultChannelName');
    const permissionsResolved = this.arePermissionsResolved();
    const forumChannel = serverStore.getChannel(channelId ?? '');
    const forumLocked = forumChannel?.forumLocked === true;
    const forumClosed = forumChannel?.forumClosed === true;
    const forumBlocked = forumLocked || forumClosed;
    const canSendMessages = !forumBlocked && (!permissionsResolved ||
      serverStore.hasPermission(Permission.READ_MESSAGES, channelId) && serverStore.hasPermission(Permission.SEND_MESSAGES, channelId));
    this.ctx.feed.setActionsEnabled(canSendMessages, !!edit);
    const canAttachFiles = canSendMessages && (!permissionsResolved || serverStore.hasPermission(Permission.ATTACH_FILES, channelId));
    const locked = !edit && permissionsResolved && !canSendMessages;
    const readOnly = locked || !!edit?.pending || this.blockSendPending;
    const commandSelected = !!channelId && !!chatStore.getCommandDraft(channelId);
    const surface = container.querySelector<HTMLElement>('.chat-composer-surface');
    if (surface) setSurfaceVisible(surface, !commandSelected || !!edit);
    else inputWrapper.style.display = commandSelected && !edit ? 'none' : '';
    const commandComposer = container.querySelector<HTMLElement>('#chat-command-composer');
    if (commandComposer) {
      if (!commandComposer.hasAttribute('data-ui-closing')) commandComposer.inert = !!edit;
      setSurfaceVisible(commandComposer, !edit && commandSelected);
    }

    input.readOnly = readOnly;
    input.placeholder = locked
      ? t(forumLocked ? 'forum.lockedPlaceholder' : forumClosed ? 'forum.closedPlaceholder' : 'chat.sendPermissionDenied')
      : edit ? t('chat.editingMessage') : t('chat.inputPlaceholder', { channel: channelName });
    input.setAttribute('aria-label', input.placeholder);
    input.setAttribute('aria-readonly', String(readOnly));
    inputWrapper.classList.toggle('chat-input-wrapper--disabled', readOnly);
    input.classList.toggle('chat-input-field--readonly', readOnly);

    if (permissionBanner) {
      permissionBanner.textContent = locked && !forumBlocked ? t('chat.sendPermissionDenied') : '';
      permissionBanner.style.display = locked && !forumBlocked ? 'flex' : 'none';
    }

    if (btnSend) {
      btnSend.hidden = locked;
      btnSend.disabled = edit ? edit.pending || !!this.messageEditDeniedReason(edit) :
        locked || this.blockSendPending || this.tray.uploading;
    }

    if (btnAttach) {
      btnAttach.disabled = !!edit || !canSendMessages;
      btnAttach.setAttribute('aria-disabled', btnAttach.disabled ? 'true' : 'false');
      const attachmentAction = container.querySelector<HTMLButtonElement>('[data-chat-create="attachment"]');
      const pollAction = container.querySelector<HTMLButtonElement>('[data-chat-create="poll"]');
      if (attachmentAction) attachmentAction.disabled = !canAttachFiles;
      if (pollAction) {
        pollAction.hidden = !!forumChannel?.forumId;
        pollAction.disabled = !canSendMessages || !!forumChannel?.forumId ||
          !serverStore.serverDetails?.protocol?.features.includes('native-polls');
      }
    }

    if (btnEmoji) {
      // Emojis only need permission to talk; the sticker upload additionally
      // checks ATTACH_FILES when it is actually sent.
      btnEmoji.disabled = readOnly;
      btnEmoji.setAttribute('aria-disabled', btnEmoji.disabled ? 'true' : 'false');
    }

    if (btnCode) {
      btnCode.disabled = readOnly;
      btnCode.setAttribute('aria-disabled', btnCode.disabled ? 'true' : 'false');
    }
    container.querySelectorAll<HTMLButtonElement>('#btn-format, [data-format]').forEach(button => { button.disabled = readOnly; });

    const { mentions, commands } = this.ctx;
    if (readOnly) {
      mentions.close();
      commands.close();
      this.emojiPicker?.close();
    } else if (commands.isOpen) {
      commands.update(input);
    }
    if (edit) commands.close();
  }

  public retryMessage(messageId: string): void {
    if (!this.isCurrent()) return;
    const { store, server } = this.ctx;
    const outgoing = store.getOutgoing(messageId);
    if (!outgoing || outgoing.status !== 'failed' || outgoing.message.channelId !== this.ctx.channelId ||
        outgoing.message.userId !== server.currentUser?.id) return;
    if (!server.serverDetails?.protocol?.features.includes('chat-delivery')) {
      reportError(t('chat.featureUpdateRequired'));
      return;
    }
    if (!server.hasPermission(Permission.SEND_MESSAGES, outgoing.payload.channelId) ||
        (outgoing.payload.attachmentIds?.length && !server.hasPermission(Permission.ATTACH_FILES, outgoing.payload.channelId))) {
      reportError(t('chat.sendPermissionDenied'));
      return;
    }
    const retry = store.retryOutgoing(messageId);
    if (retry) void this.transmitMessage(retry);
  }

  /** Whether files could be attached here right now (#11). */
  public canAttachFiles(): boolean {
    const channelId = this.ctx.channelId;
    return this.isCurrent() && !!channelId && (!this.arePermissionsResolved() ||
      serverStore.hasPermission(Permission.SEND_MESSAGES, channelId) &&
      serverStore.hasPermission(Permission.ATTACH_FILES, channelId));
  }

  /** Stages picked, pasted or dropped files; each one starts uploading at once (#11). */
  public addFiles(fileList: FileList): void {
    if (this.messageEdit || !this.canAttachFiles()) return;
    this.tray.add(fileList);
  }

  /**
   * Sends a sticker as its own message (#356): the image goes through the normal
   * attachment upload and the message text carries only the marker that tells
   * every client to draw it as a fixed-size square.
   */
  public async sendSticker(sticker: StickerEntry): Promise<void> {
    const channelId = this.ctx.channelId;
    if (!this.isCurrent() || this.messageEdit || !channelId) return;
    const client = getActiveNetworkClient();
    const store = getActiveChatStore();
    const connectionId = client.getConnectionId();
    const current = () => this.isCurrent() && this.ctx.channelId === channelId &&
      !store.getMessageEdit(channelId) && client.getConnectionId() === connectionId;
    const reply = store.getReplyDraft(channelId);
    if (reply?.deleted) { reportError(t('chat.replyUnavailable')); return; }
    if (
      this.arePermissionsResolved() &&
      (!serverStore.hasPermission(Permission.SEND_MESSAGES, channelId) || !serverStore.hasPermission(Permission.ATTACH_FILES, channelId))
    ) {
      reportError(t('chat.stickerPermissionDenied'));
      return;
    }

    try {
      const file = await stickerService.toFile(sticker);
      if (!file) throw new Error(t('chat.stickerReadFailed'));
      if (!current()) return;

      const meta = await uploadAttachment(channelId, file).promise;
      if (!current()) return;
      const payload: ChatSendPayload = {
        channelId,
        content: stickerToken(meta.id),
        attachmentIds: [meta.id],
        replyToMessageId: reply?.messageId,
      };
      if (this.ctx.server.serverDetails?.protocol?.features.includes('chat-delivery')) {
        this.queueMessage({ ...payload, clientMessageId: crypto.randomUUID() }, { reply, attachments: [meta] });
      } else client.send(MessageType.CHAT_SEND, payload);
      if (store.getReplyDraft(channelId) === reply) store.setReplyDraft(channelId);
      this.renderReply();
    } catch (e) {
      reportError(errorMessage(e, t('chat.stickerSendFailed')));
    }
  }

  public async transmitMessage(outgoing: OutgoingMessage): Promise<void> {
    const { store, client } = this.ctx;
    try {
      const message = await client.sendRequest<ChatMessage>(MessageType.CHAT_SEND, outgoing.payload);
      if (!message || message.id !== outgoing.message.id || message.channelId !== outgoing.message.channelId ||
          message.userId !== outgoing.message.userId) throw new Error(t('chat.deliveryInvalidAck'));
      if (this.ctx.server.hasPermission(Permission.READ_MESSAGES, message.channelId) &&
          store.getOutgoing(message.id) === outgoing) store.addMessage(message);
    } catch (error) {
      console.warn('[ChatView] Message delivery was not confirmed', error);
      store.failOutgoing(outgoing, error instanceof Error ? error.message : t('chat.deliveryFailed'));
    }
  }

  private handleInput(input: MarkdownInput, event: Event): void {
    if (!this.owns(input)) return;
    if (event instanceof InputEvent && event.isComposing) {
      this.persistDraft(input.value);
      this.updateCounter();
      return;
    }
    const { store } = this.ctx;
    const channelId = this.ctx.channelId;
    if (!this.messageEdit && this.ctx.server.serverDetails?.protocol?.features.includes('chat-blocks')) {
      const parsed = parseFencedMessageBlocks(input.value);
      if (parsed.some(block => block.type === 'code') && channelId) {
        const existing = store.getBlockDraft(channelId);
        if (existing.length + parsed.length < 100) {
          store.setBlockDraft(channelId, [...existing, ...parsed]);
          input.value = '';
          this.persistDraft('');
          this.renderBlocks();
          this.updateCounter();
          return;
        }
      }
      const caret = input.selectionStart;
      if (input.value.slice(0, caret).endsWith('```')) {
        input.setRangeText('', caret - 3, caret, 'end');
        this.addBlock({ type: 'code', language: 'plaintext', code: '' });
        return;
      }
    }
    this.setCounter(input.value.length);
    input.refresh();
    this.persistDraft(input.value);
    this.updateCounter();
    this.ctx.commands.showNotice('');
    this.ctx.mentions.update(input);
    this.ctx.commands.update(input);
    this.linkPreview?.schedule('typing');
  }

  private handleKeydown(input: MarkdownInput, e: KeyboardEvent): void {
    if (!this.owns(input)) return;
    if (e.isComposing || e.keyCode === 229) return;
    const { mentions, commands } = this.ctx;
    if (e.key === 'Escape' && this.messageEdit && !mentions.isOpen) {
      e.preventDefault();
      this.cancelMessageEdit();
      return;
    }
    if (e.key === 'Escape' && !this.messageEdit && !mentions.isOpen && !commands.isOpen) this.clearReply();
    if (this.messageEdit && e.shiftKey && (e.key === 'Enter' || e.key === 'Tab')) {
      mentions.close();
      return;
    }
    // While the mention dropup is open, arrows/enter/tab/esc drive it (#14).
    if (mentions.handleKey(e)) return;
    // While the command dropup is open (#569).
    if (!this.messageEdit && commands.handleKey(e)) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.send(input, e.isTrusted);
    }
  }

  /** Entering or leaving an edit swaps what the composer shows; saving and its errors update in place. */
  private followEdit(input: MarkdownInput | null, linkPreview: ComposeLinkPreview): () => void {
    let displayedEdit = this.messageEdit;
    let displayedEditPending = displayedEdit?.pending;
    let displayedEditError = displayedEdit?.error;
    let displayedEditMessage = displayedEdit?.message;
    return appEvents.on('chat.message_edit_updated', ({ channelId }: { channelId: string }) => {
      if (!this.owns(input) || channelId !== this.ctx.channelId || !input) return;
      const { commands } = this.ctx;
      const edit = this.messageEdit;
      const modeChanged = displayedEdit !== edit;
      const statusChanged = modeChanged || displayedEditPending !== edit?.pending ||
        displayedEditError !== edit?.error || displayedEditMessage !== edit?.message;
      if (modeChanged) {
        commands.cancelSelection();
        commands.close();
        this.ctx.mentions.close();
        commands.showNotice('');
        this.emojiPicker?.close();
        codeBlockModal.close();
      }
      const text = edit?.content ?? this.ctx.store.getDraft(channelId);
      if (input.value !== text) {
        input.value = text;
        this.setCounter(text.length);
        input.refresh();
      }
      displayedEdit = edit;
      displayedEditPending = edit?.pending;
      displayedEditError = edit?.error;
      displayedEditMessage = edit?.message;
      if (statusChanged) this.syncPermissionState();
      // A refusal repeated without any change in between (Enter on empty text again) is announced again too.
      this.announceEditError(edit, input);
      if (modeChanged) {
        this.renderReply();
        this.tray.render();
        commands.renderComposer();
        linkPreview.reset();
        linkPreview.update();
      }
    });
  }

  /** The "+" menu: attach files or create a poll. */
  private bindCreateMenu(isCurrentInput: () => boolean): () => void {
    const { container } = this.ctx;
    const btnAttach = container.querySelector<HTMLButtonElement>('#btn-attach');
    const fileInput = container.querySelector<HTMLInputElement>('#chat-file-input');
    const createMenu = container.querySelector<HTMLElement>('#chat-create-menu');
    const closeCreateMenu = () => {
      if (!createMenu || createMenu.hidden) return;
      btnAttach?.setAttribute('aria-expanded', 'false');
      setSurfaceVisible(createMenu, false, 'popover');
    };
    btnAttach?.addEventListener('click', event => {
      event.stopPropagation();
      if (!isCurrentInput() || this.messageEdit || !createMenu) return;
      const open = createMenu.hidden || createMenu.hasAttribute('data-ui-closing');
      btnAttach.setAttribute('aria-expanded', String(open));
      setSurfaceVisible(createMenu, open, 'popover', 'grid');
      if (open) requestAnimationFrame(() => createMenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    });
    createMenu?.addEventListener('click', event => {
      const action = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-chat-create]')?.dataset.chatCreate : undefined;
      if (!action) return;
      closeCreateMenu();
      const channelId = this.ctx.channelId;
      if (action === 'attachment') {
        if (serverStore.hasPermission(Permission.ATTACH_FILES, channelId)) openFileInputPicker(fileInput, btnAttach);
      } else if (action === 'poll' && channelId && !serverStore.getChannel(channelId)?.forumId) {
        openNativePollWizard(this.ctx.client, this.ctx.server, channelId);
      }
    });
    const closeCreateOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !createMenu?.contains(event.target) && !btnAttach?.contains(event.target)) closeCreateMenu();
    };
    document.addEventListener('pointerdown', closeCreateOutside);
    return () => document.removeEventListener('pointerdown', closeCreateOutside);
  }

  /** Emoji & sticker picker (#356). */
  private bindEmojiPicker(isCurrentInput: () => boolean): () => void {
    const { container } = this.ctx;
    const btnEmoji = container.querySelector<HTMLElement>('#btn-emoji');
    const inputContainer = container.querySelector<HTMLElement>('.chat-input-container');
    if (!btnEmoji || !inputContainer) return () => {};
    const pickerOptions = {
      container: inputContainer,
      anchor: btnEmoji,
      emojiOnly: !!this.messageEdit,
      onSelectEmoji: (emoji: string) => this.insertAtCaret(emoji),
      onSelectSticker: (sticker: StickerEntry) => {
        picker.close();
        void this.sendSticker(sticker);
      },
    };
    const picker = new EmojiPicker(pickerOptions);
    this.emojiPicker = picker;

    const onEmojiClick = () => {
      if (!isCurrentInput() || this.messageEdit?.pending) return;
      if (!this.messageEdit && this.arePermissionsResolved() &&
          !serverStore.hasPermission(Permission.SEND_MESSAGES, this.ctx.channelId)) return;
      pickerOptions.emojiOnly = !!this.messageEdit;
      picker.toggle();
    };
    btnEmoji.addEventListener('click', onEmojiClick);
    // The composer is bound again on every re-render, so the popover must go with
    // its listeners or its document-level handlers would pile up.
    return () => {
      btnEmoji.removeEventListener('click', onEmojiClick);
      picker.destroy();
      if (this.emojiPicker === picker) this.emojiPicker = null;
    };
  }

  /** Code block composer (#391). */
  private bindCodeButton(input: MarkdownInput | null, isCurrentInput: () => boolean): () => void {
    const btnCode = this.ctx.container.querySelector<HTMLElement>('#btn-code');
    if (!btnCode) return () => {};
    const onCodeClick = () => {
      if (!isCurrentInput() || !input || input.readOnly || input.disabled) return;
      const selected = input.value.slice(input.selectionStart, input.selectionEnd);
      if (this.messageEdit) {
        input.insertText(`\`\`\`\n${selected}\n\`\`\``);
        input.focus();
        return;
      }
      if (this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SEND_MESSAGES, this.ctx.channelId)) return;
      if (this.ctx.server.serverDetails?.protocol?.features.includes('chat-blocks')) {
        this.addBlock({ type: 'code', language: 'plaintext', code: selected });
        return;
      }
      codeBlockModal.open({
        onSubmit: (language, code) => this.sendCodeBlock(language, code),
      });
    };
    btnCode.addEventListener('click', onCodeClick);
    return () => {
      btnCode.removeEventListener('click', onCodeClick);
      codeBlockModal.close();
    };
  }

  /** The dropups close once focus has really left the text box. */
  private bindDropupBlur(input: MarkdownInput): () => void {
    let dropupBlurTimer: ReturnType<typeof setTimeout> | null = null;
    const onInputBlur = () => {
      if (!input.isConnected) return;
      // Delay so a click (mousedown) on a dropup item is processed first.
      if (dropupBlurTimer) clearTimeout(dropupBlurTimer);
      dropupBlurTimer = setTimeout(() => {
        dropupBlurTimer = null;
        if (!input.isConnected || input.hasFocus) return;
        this.ctx.mentions.close();
        if (!this.ctx.container.querySelector('#command-dropup')?.contains(document.activeElement)) this.ctx.commands.close();
      }, 150);
    };
    const onInputFocus = () => {
      if (dropupBlurTimer) clearTimeout(dropupBlurTimer);
      dropupBlurTimer = null;
    };
    input.addEventListener('blur', onInputBlur);
    input.addEventListener('focus', onInputFocus);
    return () => {
      input.removeEventListener('blur', onInputBlur);
      input.removeEventListener('focus', onInputFocus);
      if (dropupBlurTimer) clearTimeout(dropupBlurTimer);
    };
  }

  /** Sends what the composer holds, or hands it to the bot whose command was typed. */
  private async send(input: MarkdownInput, gesture: Event | boolean = false): Promise<void> {
    const channelId = this.ctx.channelId;
    if (!this.owns(input) || !channelId) return;
    if (this.blockSendPending) return;
    if (this.messageEdit) {
      void this.submitMessageEdit();
      return;
    }
    if (!serverStore.hasPermission(Permission.SEND_MESSAGES, channelId)) return;
    const { store, server, commands } = this.ctx;
    const draftedBlocks = store.getBlockDraft(channelId);
    const blocks = draftedBlocks.length ? messageBlocksInput([
      ...draftedBlocks, ...(input.value.trim() ? [{ type: 'text' as const, text: input.value }] : []),
    ]) : undefined;
    const text = blocks ? messageBlocksContent(blocks) : input.value.trim();
    if (blocks && !server.serverDetails?.protocol?.features.includes('chat-blocks')) {
      reportError(t('chat.featureUpdateRequired'));
      return;
    }
    if (this.isMessageTooLong(text)) {
      reportError(t('chat.messageTooLong', { max: this.messageLengthLimit }));
      return;
    }
    if (chatStore.getCommandDraft(channelId)) {
      commands.focusComposer();
      return;
    }
    const command = parseTypedCommand(blocks ? '' : input.value, chatStore.getCommands(), commands.locale);
    if (command.kind !== 'chat') {
      const denied = commands.deniedReason();
      if (denied) {
        commands.showNotice(denied);
        commands.update(input);
        return;
      }
      if (command.kind === 'command') commands.select(command.command, command.text,
        typeof gesture === 'boolean' ? gesture : gesture.isTrusted);
      else if (command.kind === 'ambiguous') commands.showAmbiguous(command.commands, input);
      else commands.showNotice(t('botChat.commandUnavailable'));
      return;
    }

    // Block sending until every staged upload has finished (#11).
    if (this.tray.uploading) return;

    const uploaded = this.tray.uploaded();
    const attachmentIds = uploaded.map((meta) => meta.id);

    if (!text && attachmentIds.length === 0 && !blocks?.some(block => block.type === 'reply')) return;
    const reply = chatStore.getReplyDraft(channelId);
    if (reply?.deleted) {
      reportError(t('chat.replyUnavailable'));
      return;
    }

    const payload: ChatSendPayload = {
      channelId,
      content: text,
      blocks,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      replyToMessageId: reply?.messageId,
      ...(server.serverDetails?.protocol?.features.includes('chat-delivery') ? { clientMessageId: crypto.randomUUID() } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify({ type: MessageType.CHAT_SEND, payload, requestId: '0'.repeat(36) })).byteLength > LIMITS.WS_MAX_PAYLOAD_BYTES) {
      reportError(t('chat.messagePacketTooLarge'));
      return;
    }
    if (payload.clientMessageId) {
      try {
        this.queueMessage(payload, {
          reply,
          blocks: blocks ? [...draftedBlocks, ...(input.value.trim() ? [{ type: 'text' as const, text: input.value }] : [])] : undefined,
          attachments: uploaded,
        });
      } catch (error) {
        console.warn('[ChatView] Unable to queue message', error);
        reportError(errorMessage(error, t('chat.deliveryFailed')));
        return;
      }
    } else if (blocks) {
      this.blockSendPending = true;
      this.syncPermissionState();
      this.renderBlocks();
      const originalBlocks = JSON.stringify(messageBlocksInput(store.getBlockDraft(channelId)));
      const originalDraft = store.getDraft(channelId);
      try {
        await this.ctx.client.sendRequest<ChatMessage>(MessageType.CHAT_SEND, payload);
        if (JSON.stringify(messageBlocksInput(store.getBlockDraft(channelId))) === originalBlocks) store.setBlockDraft(channelId, []);
        if (store.getDraft(channelId) === originalDraft) store.clearDraft(channelId);
        if (!this.owns(input) || this.ctx.channelId !== channelId) return;
      } catch (error) {
        console.warn('[ChatView] Block message was not acknowledged', error);
        reportError(errorMessage(error, t('chat.editSaveFailed')));
        return;
      } finally {
        this.blockSendPending = false;
        if (this.owns(input)) {
          this.syncPermissionState();
          this.renderBlocks();
        }
      }
    } else networkClient.send(MessageType.CHAT_SEND, payload);

    store.setBlockDraft(channelId, []);
    this.clearReply();
    this.tray.clear();
    input.value = '';
    this.persistDraft('');
    input.style.height = 'auto';
    this.setCounter(0);
    this.ctx.mentions.close();
    this.linkPreview?.reset();
  }

  private queueMessage(payload: ChatSendPayload, preview: {
    reply?: MessageReply; blocks?: ResolvedMessageBlock[]; attachments?: AttachmentMeta[];
  }): void {
    const user = this.ctx.server.currentUser;
    if (!user || !payload.clientMessageId) throw new Error(t('chat.deliveryFailed'));
    const outgoing = this.ctx.store.enqueueMessage(payload, {
      id: payload.clientMessageId, channelId: payload.channelId,
      userId: user.id, userNickname: user.nickname, userAvatarUrl: user.avatarUrl,
      content: payload.content, createdAt: Date.now(), ...preview,
    });
    void this.transmitMessage(outgoing);
  }

  private async submitMessageEdit(): Promise<void> {
    const channelId = this.ctx.channelId;
    if (!this.isCurrent() || !channelId || !this.input) return;
    const edit = this.ctx.store.getMessageEdit(channelId);
    if (!edit || edit.pending) return;
    this.rememberText();
    if (this.messageEditDeniedReason(edit)) {
      this.syncPermissionState();
      return;
    }
    const content = edit.content.trim();
    if (!content && !edit.message.attachments?.length) {
      this.refuseEdit(channelId, edit, 'empty');
      return;
    }
    if (this.isMessageTooLong(content)) {
      this.refuseEdit(channelId, edit, 'too-long');
      return;
    }
    if (edit.content === edit.message.content || content === edit.message.content) {
      this.cancelMessageEdit();
      return;
    }

    const { store, client, server } = this.ctx;
    const connectionId = client.getConnectionId();
    const serverId = server.serverDetails?.id;
    store.setMessageEditPending(channelId, edit, true);
    try {
      const result = await client.sendRequest<ChatMessageUpdatedPayload>(MessageType.CHAT_EDIT, {
        channelId,
        messageId: edit.message.id,
        content,
      });
      if (store.getMessageEdit(channelId) !== edit) return;
      if (client.getConnectionId() !== connectionId || client.getStatus() !== 'CONNECTED' ||
          server.serverDetails?.id !== serverId || server.currentUser?.id !== edit.message.userId ||
          result.message.id !== edit.message.id || result.message.channelId !== channelId ||
          result.message.userId !== edit.message.userId || result.message.deletedAt || edit.message.deletedAt ||
          result.message.content !== content) {
        this.refuseEdit(channelId, edit, 'failed');
        return;
      }
      const refocus = this.isCurrent() && this.ctx.channelId === channelId &&
        (this.input?.hasFocus ||
          document.activeElement === this.ctx.container.querySelector('#btn-send-message'));
      if (server.hasPermission(Permission.READ_MESSAGES, channelId)) store.updateMessage(result.message);
      store.finishMessageEdit(channelId, edit);
      if (refocus && this.isCurrent() && this.ctx.channelId === channelId) this.focus();
    } catch {
      this.refuseEdit(channelId, edit, 'failed');
    }
  }

  /** Turns a save down; the refusal is announced again even when it is the same as the last one. */
  private refuseEdit(channelId: string, edit: MessageEditDraft, error: MessageEditError): void {
    this.announcedEditErrors.delete(edit);
    this.ctx.store.setMessageEditPending(channelId, edit, false, error);
  }

  /**
   * A save that failed or was refused is explained once, in the alert toast,
   * never in the edit banner (#490); empty or overlong text also marks the box.
   */
  private announceEditError(edit: MessageEditDraft | undefined, input: MarkdownInput): void {
    if (!edit) return;
    if (!edit.error) {
      this.announcedEditErrors.delete(edit);
      return;
    }
    if (this.announcedEditErrors.get(edit) === edit.error) return;
    this.announcedEditErrors.set(edit, edit.error);
    const invalidText = edit.error === 'empty' || edit.error === 'too-long';
    reportError(edit.error === 'failed' ? t('chat.editSaveFailed')
      : edit.error === 'empty' ? t('chat.editEmpty')
        : edit.error === 'too-long' ? t('chat.editTooLong', { max: this.messageLengthLimit })
          : t('chat.editInProgress'), { field: invalidText ? input : undefined });
  }

  private messageEditDeniedReason(edit: MessageEditDraft): string | undefined {
    const { client, server } = this.ctx;
    if (client.getStatus() !== 'CONNECTED') return t('chat.editDisconnected');
    const message = edit.message;
    if (message.deletedAt || message.isSystem || message.isEphemeral ||
        !server.serverDetails?.channels.some((channel) => channel.id === message.channelId &&
          (channel.type === 'TEXT' || channel.type === 'VOICE'))) {
      return t('chat.editUnavailable');
    }
    if (message.userId !== server.currentUser?.id || server.serverDetails.allowMessageEdit === false) {
      return t('chat.editPermissionDenied');
    }
    return;
  }

  private clearReply(): void {
    if (this.messageEdit) return;
    const channelId = this.ctx.channelId;
    if (channelId) chatStore.setReplyDraft(channelId);
    this.renderReply();
  }

  private arePermissionsResolved(): boolean {
    return serverStore.myPermissions > 0 || serverStore.ownerId !== null;
  }

  /**
   * Inserts text (an emoji) where the caret is, then replays an `input` event so
   * the character counter, auto-resize and mention logic all react as if the
   * user had typed it (#356).
   */
  private insertAtCaret(text: string): void {
    if (!this.isCurrent()) return;
    const input = this.ctx.container.querySelector<MarkdownInput>('#chat-message-input');
    if (!input || input.readOnly) return;

    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + text + input.value.slice(end);
    if (this.isMessageTooLong(next)) {
      reportError(t('chat.messageTooLong', { max: this.messageLengthLimit }));
      return;
    }

    input.value = next;
    const caret = start + text.length;
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Legacy servers receive fenced code inserted in the draft, never auto-sent. */
  private sendCodeBlock(language: string, code: string): void {
    const channelId = this.ctx.channelId;
    if (!this.isCurrent() || this.messageEdit || !channelId) return;
    if (this.arePermissionsResolved() && !serverStore.hasPermission(Permission.SEND_MESSAGES, channelId)) {
      reportError(t('chat.sendPermissionDenied'));
      return;
    }

    const content = buildCodeMessage(language, code);
    if (!code.trim() || this.isMessageTooLong(content)) return;

    const reply = chatStore.getReplyDraft(channelId);
    if (reply?.deleted) { reportError(t('chat.replyUnavailable')); return; }
    this.insertAtCaret(`${content}\n`);
  }

  private addBlock(block: ResolvedMessageBlock): void {
    const channelId = this.ctx.channelId;
    if (!channelId || this.messageEdit || this.blockSendPending) return;
    const input = this.ctx.container.querySelector<MarkdownInput>('#chat-message-input');
    if (!input || input.disabled || input.readOnly) return;
    const { store } = this.ctx;
    const blocks = [...store.getBlockDraft(channelId)];
    if (blocks.length >= 98) {
      reportError(t('chat.tooManyBlocks'));
      return;
    }
    const prefix = input.value.slice(0, input.selectionStart);
    const suffix = input.value.slice(input.selectionEnd);
    if (prefix) blocks.push({ type: 'text', text: prefix });
    blocks.push(block);
    store.setBlockDraft(channelId, blocks);
    input.value = suffix;
    this.persistDraft(suffix);
    this.renderBlocks();
    if (block.type === 'code') {
      this.ctx.container.querySelector<HTMLTextAreaElement>('#chat-composer-blocks fieldset:last-child textarea')?.focus();
    } else { input.focus(); input.setSelectionRange(0, 0); }
  }

  /**
   * Keeps the store in sync with the composer so the text is still there after
   * the view is rebuilt (#478). Called from every place that writes to the
   * textarea without going through a real `input` event.
   */
  private persistDraft(text: string): void {
    const channelId = this.ctx.channelId;
    if (!this.isCurrent() || !channelId) return;
    if (this.messageEdit) this.ctx.store.setMessageEditContent(channelId, text);
    else this.ctx.store.setDraft(channelId, text);
  }

  private setCounter(length: number): void {
    if (this.counter) this.counter.textContent = `${length}/${this.messageLimitLabel}`;
  }
}
