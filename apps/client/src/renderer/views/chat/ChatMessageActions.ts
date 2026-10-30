import { MessageType, Permission, getMessageText } from '@monky/shared';
import type { ChatMessage, ChatMessageUpdatedPayload, NativePoll } from '@monky/shared';
import { appEvents } from '../../core/EventBus';
import { fetchAttachment, type ForwardItem } from '../../core/MessageForwarder';
import { getLanguage, t, tCount } from '../../i18n';
import { chatStore } from '../../stores/chatStore';
import { serverStore } from '../../stores/serverStore';
import { getAttachmentUrl } from '../../utils/attachment';
import { reportError } from '../../utils/feedback';
import { downloadFilesWithChoice, type DownloadableFile } from '../../utils/fileDownloads';
import type { MessageClipboardContent, MessageCopyMode } from '../../utils/messageClipboard';
import { archiveDate } from '../../utils/messageForward';
import { formatMessageTime } from '../../utils/messageReply';
import { extractStickerIds, stripStickerTokens } from '../../utils/stickers';
import type { ContextMenuEntry } from '../ContextMenu';
import { showErrorToast, showInfoToast } from '../CopyToast';
import { showConfirm } from '../Dialog';
import { forwardDestinations, openForwardModal } from '../ForwardMessagesModal';
import { MessageCopy, messageClipboardContent } from '../MessageCopy';
import { MessageSelection, type MessageSelectionAction } from '../MessageSelection';
import {
  fetchNativePoll,
  isNativePollClosed,
  nativePollVoterProfile,
  nextNativePollSelection,
  openNativePollVoters,
  submitNativePollVote,
} from '../nativePoll';
import { openNativePollWizard } from '../NativePollWizard';
import type { ChatContext } from './chatContext';

/**
 * What can be done with messages already in a channel (R-CHAT-10): the menu
 * of one message, the bar of a multiple selection, forwarding, deleting and
 * undoing a deletion, copying, and voting on or editing polls.
 */
export class ChatMessageActions {
  public readonly copy: MessageCopy;
  public readonly selection: MessageSelection;
  /** Answers shown while a poll vote is in flight, keyed by poll id. */
  private readonly pendingPollVotes = new Map<string, string[]>();

  constructor(private readonly ctx: ChatContext) {
    this.copy = new MessageCopy({
      isActive: () => ctx.isCurrentSession(),
      feed: () => ctx.container.querySelector<HTMLElement>('#chat-messages-feed'),
      content: (messageId) => this.messageClipboard(messageId),
      image: (messageId) => this.messageClipboardImage(messageId),
    });
    this.selection = new MessageSelection({
      feed: () => ctx.container.querySelector<HTMLElement>('#chat-messages-feed'),
      host: () => ctx.container.querySelector<HTMLElement>('.chat-input-container'),
      selectable: (row) => !!this.selectableMessage(row.dataset.messageId ?? ''),
      actions: (ids) => this.selectionActions(ids),
    });
  }

  /**
   * The entries offered in the menu of one message (#504).
   *
   * Editing belongs to the author alone and only while the server allows it;
   * deleting is the author's too, plus anyone with MANAGE_SERVER, who needs to
   * be able to clean up after other people. Deleted and system messages offer
   * nothing.
   */
  public menuItems(messageId: string | null): ContextMenuEntry[] {
    const channelId = this.ctx.channelId;
    if (!messageId || !channelId) return [];
    const message = chatStore.getMessages(channelId).find((m) => m.id === messageId);
    if (!message || message.isSystem || message.isEphemeral || message.deletedAt || this.ctx.store.getOutgoing(message.id)) return [];

    const isAuthor = !!serverStore.currentUser && message.userId === serverStore.currentUser.id;
    const canModerate = serverStore.hasPermission(Permission.MANAGE_SERVER);
    const editingAllowed = serverStore.serverDetails?.allowMessageEdit !== false;

    const items: ContextMenuEntry[] = [];
    if (serverStore.hasPermission(Permission.SEND_MESSAGES, channelId)) {
      items.push({
        label: t('chat.emojiAction'), icon: 'add_reaction',
        onClick: () => this.ctx.container.querySelector<HTMLButtonElement>(
          `.chat-message-row[data-message-id="${CSS.escape(message.id)}"] .chat-reaction-add`
        )?.click(),
      });
      if (!this.ctx.composer.messageEdit) {
        items.push({ label: t('chat.replyMessage'), icon: 'reply', onClick: () => this.ctx.composer.startReply(message.id) });
      }
    }
    items.push(this.copy.menuItem(message.id));
    if (this.forwardableMessage(message)) {
      items.push({ label: t('chat.forwardMessage'), icon: 'forward', onClick: () => void this.forwardSelected([message.id]) });
    }
    items.push({ label: t('chat.selectMessages'), icon: 'checklist', onClick: () => this.selection.start(message.id) });
    const poll = message.poll;
    if (poll) {
      // Polls are edited as polls, by their creator or a server manager, while they are open.
      if ((isAuthor || canModerate) && !isNativePollClosed(poll) &&
          serverStore.serverDetails?.protocol?.features.includes('poll-edit')) {
        items.push({ label: t('poll.edit'), icon: 'edit', onClick: () => this.editPoll(poll.id) });
      }
    } else if (isAuthor && editingAllowed) {
      items.push({
        label: t('chat.editMessage'),
        icon: 'edit',
        onClick: () => this.ctx.composer.startEditingMessage(message.id),
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

  public canUndoDeletion(message: ChatMessage): boolean {
    const { server } = this.ctx;
    return !!server.serverDetails?.protocol?.features.includes('message-delete-undo')
      && !!message.deletedAt && (message.deleteUndoUntil ?? 0) > Date.now()
      && message.deletedByUserId === server.currentUser?.id
      && (message.userId === server.currentUser?.id || server.hasPermission(Permission.MANAGE_SERVER));
  }

  public async undoDeletion(messageId: string, button: HTMLButtonElement): Promise<void> {
    const channelId = this.ctx.channelId;
    if (!this.ctx.composer.isCurrent() || !channelId) return;
    const message = this.ctx.store.getMessages(channelId).find(entry => entry.id === messageId);
    const deletedAt = message?.deletedAt, revision = message?.revision;
    if (!message || !deletedAt || revision === undefined || !this.canUndoDeletion(message) || button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const result = await this.ctx.client.sendRequest<ChatMessageUpdatedPayload>(MessageType.CHAT_RESTORE, {
        messageId, channelId: message.channelId, deletedAt, revision,
      });
      if (this.ctx.server.hasPermission(Permission.READ_MESSAGES, message.channelId)) this.ctx.store.updateMessage(result.message);
    } catch {
      if (button.isConnected) reportError(t('chat.undoDeleteFailed'));
    } finally {
      if (button.isConnected) { button.disabled = !this.canUndoDeletion(message); button.removeAttribute('aria-busy'); }
    }
  }

  public findPollMessage(pollId: string | undefined): ChatMessage | undefined {
    const channelId = this.ctx.channelId;
    if (!pollId || !channelId) return undefined;
    return this.ctx.store.getMessages(channelId).find(message => message.poll?.id === pollId);
  }

  /** The answers to show for a poll whose vote is still on its way. */
  public pendingVote(pollId: string): string[] | undefined {
    return this.pendingPollVotes.get(pollId);
  }

  /** Each click sends the member's complete answer set; the card shows it at once and ignores clicks until confirmed. */
  public votePoll(pollId: string, optionId: string): void {
    const message = this.findPollMessage(pollId);
    if (!message?.poll || this.pendingPollVotes.has(pollId)) return;
    const optionIds = nextNativePollSelection(message.poll, optionId);
    if (optionIds.length === 0 && !this.ctx.server.serverDetails?.protocol?.features.includes('poll-voters')) {
      showInfoToast(t('poll.withdrawRequiresUpdate'));
      return;
    }
    this.pendingPollVotes.set(pollId, optionIds);
    this.ctx.feed.replaceRow(message);
    void submitNativePollVote(this.ctx.client, pollId, optionIds)
      .then(
        poll => {
          this.pendingPollVotes.delete(pollId);
          this.ctx.store.updatePoll(poll);
        },
        (error: unknown) => showErrorToast(error instanceof Error ? error.message : t('poll.voteFailed')),
      )
      .finally(() => {
        this.pendingPollVotes.delete(pollId);
        const current = this.findPollMessage(pollId);
        // An older revision than the one already shown is not re-rendered by the store.
        if (current && this.ctx.container.isConnected && this.ctx.container.querySelector(
          `.chat-message-row[data-message-id="${CSS.escape(current.id)}"] [data-native-poll-card][aria-busy]`,
        )) this.ctx.feed.replaceRow(current);
      });
  }

  public openPollVoters(poll: NativePoll, optionId?: string): void {
    openNativePollVoters(this.ctx.client, poll, {
      optionId,
      profile: nativePollVoterProfile(serverStore.knownMembers),
      subscribe: listener => appEvents.on('chat.message_updated', (message: ChatMessage) => {
        if (message.poll) listener(message.poll);
      }),
    });
  }

  public messageClipboard(messageId: string): MessageClipboardContent | null {
    const channelId = this.ctx.channelId;
    const message = channelId ? chatStore.getMessages(channelId).find((entry) => entry.id === messageId) : undefined;
    if (!message || message.deletedAt || message.isSystem) return null;
    const messageText = getMessageText(message, getLanguage());
    const stickerIds = extractStickerIds(messageText).filter((id) =>
      message.attachments?.some((attachment) => attachment.id === id && attachment.kind === 'image'));
    const content = stripStickerTokens(messageText, stickerIds);
    return messageClipboardContent(this.ctx.container, messageId, content,
      message.attachments?.map((entry) => entry.originalName) ?? []);
  }

  public copyMessage(messageId: string, mode: MessageCopyMode = 'formatted', selection: MessageClipboardContent | null = null): Promise<void> {
    return this.copy.copyMessage(messageId, mode, selection);
  }

  public copyAttachmentImage(image: HTMLImageElement): Promise<void> {
    return this.copy.copyImage(image);
  }

  private messageClipboardImage(messageId: string): HTMLImageElement | null {
    const channelId = this.ctx.channelId;
    const message = channelId && this.ctx.store.getMessages(channelId).find(entry => entry.id === messageId);
    if (!message || stripStickerTokens(message.content, extractStickerIds(message.content)).trim() || message.deletedAt) return null;
    return this.ctx.container.querySelector<HTMLElement>(`.chat-message-row[data-message-id="${CSS.escape(messageId)}"]`)
      ?.querySelector<HTMLImageElement>('.chat-sticker img, img.chat-sticker, .chat-attachment-image img, img.chat-attachment-image, .chat-sticker-image') ?? null;
  }

  private selectableMessage(messageId: string): ChatMessage | undefined {
    const channelId = this.ctx.channelId;
    if (!channelId) return undefined;
    const { store } = this.ctx;
    const message = store.getMessages(channelId).find((entry) => entry.id === messageId);
    return message && !message.isSystem && !message.isEphemeral && !message.deletedAt && !store.getOutgoing(message.id)
      ? message : undefined;
  }

  /** Text and files can be sent again as they are; polls, bot widgets and stickers cannot. */
  private forwardableMessage(message: ChatMessage): boolean {
    if (message.deletedAt || message.isSystem || message.isEphemeral || message.poll || message.botComponents?.length) return false;
    if (extractStickerIds(message.content).length > 0) return false;
    return message.content.trim().length > 0 || !!message.attachments?.some((attachment) => attachment.url && !attachment.evicted);
  }

  private selectedMessages(ids: string[]): ChatMessage[] {
    return ids.flatMap((id) => {
      const message = this.selectableMessage(id);
      return message ? [message] : [];
    });
  }

  private archiveName(): string {
    const channel = serverStore.getChannel(this.ctx.channelId ?? '')?.name;
    return [channel, archiveDate()].filter(Boolean).join(' - ');
  }

  private selectionActions(ids: string[]): MessageSelectionAction[] {
    const { server, composer } = this.ctx;
    const messages = this.selectedMessages(ids);
    const channelId = this.ctx.channelId;
    const canSend = !!channelId && server.hasPermission(Permission.SEND_MESSAGES, channelId);
    const replyBlocks = !!server.serverDetails?.protocol?.features.includes('chat-blocks');
    const me = server.currentUser?.id;
    const canModerate = server.hasPermission(Permission.MANAGE_SERVER);
    const files: DownloadableFile[] = messages.flatMap((message) => (message.attachments ?? []).flatMap((attachment) => {
      const url = attachment.evicted ? '' : getAttachmentUrl(attachment.url);
      return url ? [{ url, fileName: attachment.originalName }] : [];
    }));
    return [
      {
        id: 'reply', icon: 'reply', label: t('chat.replyMessage'),
        unavailable: !canSend ? t('chat.sendPermissionDenied')
          : composer.messageEdit ? t('chat.selectionReplyWhileEditing')
            : messages.length > 1 && !replyBlocks ? t('chat.selectionReplyOne') : undefined,
        run: () => {
          this.selection.stop();
          // With chat-blocks every reply becomes its own quote in the composer.
          for (const message of messages) composer.startReply(message.id);
          composer.focus();
        },
      },
      {
        id: 'forward', icon: 'forward', label: t('chat.forwardAction'),
        unavailable: messages.every((message) => this.forwardableMessage(message)) ? undefined : t('chat.selectionForwardUnsupported'),
        run: () => this.forwardSelected(messages.map((message) => message.id)),
      },
      {
        id: 'copy', icon: 'content_copy', label: t('chat.copyMessage'),
        run: async () => {
          await this.copy.copyMessages(messages.map((message) => ({
            messageId: message.id, heading: `${message.userNickname} — ${formatMessageTime(message.createdAt)}`,
          })));
          this.selection.stop();
        },
      },
      {
        id: 'download', icon: 'download', label: t('common.download'),
        unavailable: files.length ? undefined : t('chat.selectionNoFiles'),
        run: () => downloadFilesWithChoice(files, this.archiveName()),
      },
      {
        id: 'delete', icon: 'delete', label: t('chat.deleteMessage'), danger: true,
        unavailable: messages.every((message) => message.userId === me || canModerate) ? undefined : t('chat.selectionDeleteDenied'),
        run: () => this.deleteSelected(messages.map((message) => message.id)),
      },
    ];
  }

  private async forwardSelected(ids: string[]): Promise<void> {
    const messages = this.selectedMessages(ids).filter((message) => this.forwardableMessage(message));
    if (messages.length === 0) return;
    const channelId = this.ctx.channelId ?? '';
    const channel = serverStore.getChannel(channelId)?.name;
    const source = [channel ? `#${channel}` : '', this.ctx.server.serverDetails?.name ?? ''].filter(Boolean).join(' · ') || null;
    const items: ForwardItem[] = messages.map((message) => ({
      content: message.content,
      attachments: (message.attachments ?? []).flatMap((attachment) => {
        const url = attachment.evicted ? '' : getAttachmentUrl(attachment.url);
        return url ? [{
          name: attachment.originalName, mime: attachment.mimeType, size: attachment.sizeBytes,
          load: () => fetchAttachment(url),
        }] : [];
      }),
      sourceMessageId: message.id,
      sourceLabel: source,
      createdAt: message.createdAt,
    }));
    if (await openForwardModal({ items, ...forwardDestinations({ kind: 'channel', channelId }) })) {
      this.selection.stop();
    }
  }

  private async deleteSelected(ids: string[]): Promise<void> {
    const { client, server, store } = this.ctx;
    const channelId = this.ctx.channelId;
    if (!channelId || ids.length === 0 || !this.ctx.composer.isCurrent()) return;
    const connectionId = client.getConnectionId();
    const confirmed = await showConfirm({
      title: tCount('chat.deleteMessagesTitle', ids.length),
      message: tCount('chat.deleteMessagesConfirm', ids.length),
      confirmLabel: t('chat.deleteMessage'),
      variant: 'danger',
    });
    if (!confirmed || !this.ctx.composer.isCurrent() || this.ctx.channelId !== channelId ||
        client.getConnectionId() !== connectionId || client.getStatus() !== 'CONNECTED') return;
    let failed = 0;
    // There is no bulk delete in the protocol: one request each, as the single-message action does.
    for (const messageId of ids) {
      try {
        const result = await client.sendRequest<ChatMessageUpdatedPayload>(MessageType.CHAT_DELETE, { channelId, messageId });
        if (server.hasPermission(Permission.READ_MESSAGES, channelId)) store.updateMessage(result.message);
      } catch {
        failed++;
      }
    }
    this.selection.stop();
    if (failed > 0 && this.ctx.isCurrentSession()) {
      showErrorToast(t('chat.deleteSomeFailed', { failed, total: ids.length }), 7000);
    }
  }

  private async confirmDeleteMessage(messageId: string): Promise<void> {
    const { client, server, store } = this.ctx;
    const channelId = this.ctx.channelId;
    if (!this.ctx.composer.isCurrent() || !channelId) return;
    const message = store.getMessages(channelId).find((m) => m.id === messageId);
    if (!message) return;
    const connectionId = client.getConnectionId();

    const confirmed = await showConfirm({
      title: t('chat.deleteMessageTitle'),
      message: t('chat.deleteMessageConfirm'),
      confirmLabel: t('chat.deleteMessage'),
      variant: 'danger',
    });
    if (!confirmed || !this.ctx.composer.isCurrent() || this.ctx.channelId !== channelId ||
        client.getConnectionId() !== connectionId || client.getStatus() !== 'CONNECTED') return;

    try {
      const result = await client.sendRequest<ChatMessageUpdatedPayload>(MessageType.CHAT_DELETE, {
        channelId: message.channelId, messageId,
      });
      if (server.hasPermission(Permission.READ_MESSAGES, message.channelId)) store.updateMessage(result.message);
    } catch {
      if (this.ctx.isCurrentSession()) reportError(t('chat.deleteFailed'));
    }
  }

  private editPoll(pollId: string): void {
    const poll = this.findPollMessage(pollId)?.poll;
    if (!poll || isNativePollClosed(poll)) return;
    // The chat copy lacks the revealed audience and may hold stale counts: edit from the current poll.
    void fetchNativePoll(this.ctx.client, poll.id).then(current => {
      this.ctx.store.updatePoll(current);
      if (isNativePollClosed(current) || !this.ctx.container.isConnected) return;
      openNativePollWizard(this.ctx.client, this.ctx.server, current.channelId, {
        edit: current,
        onSaved: saved => this.ctx.store.updatePoll(saved),
      });
    }, (error: unknown) => showErrorToast(error instanceof Error ? error.message : t('poll.editLoadFailed')));
  }
}
