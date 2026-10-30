import { LIMITS, MessageType, Permission } from '@monky/shared';
import type { ChatMessage } from '@monky/shared';
import { linkPreviewService } from '../../core/LinkPreviewService';
import { getActiveNetworkClient, networkClient } from '../../core/NetworkClient';
import { participantManager } from '../../core/ParticipantManager';
import { t } from '../../i18n';
import { chatStore, getActiveChatStore, type BotInvocation } from '../../stores/chatStore';
import { getActiveServerStore, serverStore } from '../../stores/serverStore';
import { reportError } from '../../utils/feedback';
import { escapeHtml } from '../../utils/html';
import { renderLoadingSkeleton } from '../../utils/loadingSkeleton';
import { serverMentionMatcher } from '../../utils/mentions';
import { animateEnter } from '../../utils/surfaceMotion';
import { initializeCustomMediaPlayers } from '../../utils/videoPlayer';
import { renderBotInvocation } from '../BotChatView';
import { botSettingsMenuItem } from '../BotSettingsModal';
import { contextMenu, type ContextMenuItem } from '../ContextMenu';
import { EmojiPicker } from '../EmojiPicker';
import { imageCarouselNavigationButton, moveImageCarousel } from '../ImageCarousel';
import { bindCodeBlockCopyButtons } from '../MessageCopy';
import { animatePollBars, capturePollBars, capturePollFocus, restorePollFocus } from '../nativePoll';
import { bindMessageLinks, mountServerInviteCards } from '../ServerInviteCard';
import { userContextMenu } from '../UserContextMenu';
import {
  dayKey,
  dayOf,
  invocationKey,
  isDayKey,
  isInvocationKey,
  isMessageKey,
  messageKey,
  renderChannelMessage,
  renderChannelReactions,
  renderDayDivider,
} from './channelMessage';
import { bindChatMedia } from './chatMedia';
import type { ChatContext } from './chatContext';
import { MessageFeed, type FeedEntry } from './MessageFeed';

/**
 * The conversation of a channel (R-CHAT-10): its history and the placeholders
 * shown while it loads, rows coming in, changing and leaving, jumps to older
 * messages, and what each row does when used.
 */
export class ChatFeedController {
  private static readonly HISTORY_SKELETON_TIMEOUT_MS = 10_000;
  /** The rows on screen; rebuilt with the view's markup. */
  public list: MessageFeed | null = null;
  private reactionPicker: EmojiPicker | null = null;
  // A history reload asked for by a reconnection, not by the reader: it must
  // not throw them back to the bottom or rebuild a feed that did not change.
  private resyncSnapshot: string | null = null;
  /**
   * Channel whose first history page is on its way. Until it lands the feed
   * shows message-shaped placeholders instead of the empty-channel message,
   * which was misleading on a channel that does have messages.
   */
  private historyPendingChannel: string | null = null;
  private historyPendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** A message the reader asked to see, waiting for the history around it. */
  private pendingJumpId: string | null = null;

  constructor(private readonly ctx: ChatContext) {}

  public mount(element: HTMLElement | null): void {
    this.list = element ? new MessageFeed(element, { onCreate: (entry) => this.bindEntry(entry) }) : null;
  }

  public unmount(): void {
    this.pendingJumpId = null;
    this.list?.destroy();
    this.list = null;
  }

  /** Shows the skeleton only when nothing of this channel is known yet. */
  public markHistoryPending(): void {
    const channelId = this.ctx.channelId;
    this.clearHistoryPending();
    if (!channelId || !this.ctx.server.hasPermission(Permission.READ_MESSAGES, channelId)) return;
    if (chatStore.getMessages(channelId).length || chatStore.getInvocations(channelId).length) return;
    this.historyPendingChannel = channelId;
    // A history that never arrives must not leave placeholders up forever.
    this.historyPendingTimer = setTimeout(() => {
      if (this.historyPendingChannel !== channelId) return;
      this.clearHistoryPending();
      if (this.ctx.channelId === channelId) this.render();
    }, ChatFeedController.HISTORY_SKELETON_TIMEOUT_MS);
  }

  public clearHistoryPending(): boolean {
    const wasPending = this.historyPendingChannel !== null;
    if (this.historyPendingTimer) clearTimeout(this.historyPendingTimer);
    this.historyPendingTimer = null;
    this.historyPendingChannel = null;
    return wasPending;
  }

  public loadHistory(): void {
    const channelId = this.ctx.channelId;
    if (!channelId || !this.ctx.server.hasPermission(Permission.READ_MESSAGES, channelId)) return;

    networkClient.send(MessageType.CHAT_LOAD_HISTORY, {
      channelId,
      limit: LIMITS.MAX_HISTORY_MESSAGES_INITIAL,
    });
  }

  /** The next history page is a reconnection's catch-up: it keeps the reading position unless something changed. */
  public expectResync(): void {
    const channelId = this.ctx.channelId;
    if (channelId) this.resyncSnapshot = JSON.stringify(chatStore.getMessages(channelId));
  }

  /**
   * A history page arrived for the channel on screen. Returns false when it was
   * only a reconnection's catch-up, which leaves everything else as it was.
   */
  public historyLoaded(data: { channelId: string; aroundMessageId?: string }): boolean {
    const replacingSkeleton = this.historyPendingChannel === data.channelId && this.clearHistoryPending();
    const snapshot = data.aroundMessageId ? null : this.resyncSnapshot;
    this.resyncSnapshot = null;
    if (snapshot !== null) {
      if (replacingSkeleton || snapshot !== JSON.stringify(chatStore.getMessages(data.channelId))) this.render();
      return false;
    }
    const jumpId = data.aroundMessageId === this.pendingJumpId ? this.pendingJumpId : null;
    if (jumpId) this.pendingJumpId = null;
    const returnLatest = this.ctx.container.querySelector<HTMLButtonElement>('#chat-return-latest');
    if (returnLatest) returnLatest.hidden = !data.aroundMessageId;
    this.render({ forceScroll: !jumpId });
    // Fade the real messages in over where the placeholders were.
    const feed = this.ctx.container.querySelector<HTMLElement>('#chat-messages-feed');
    if (replacingSkeleton && feed) animateEnter(feed, 'view');
    if (jumpId) {
      if (chatStore.getMessages(data.channelId).some((message) => message.id === jumpId)) this.jumpTo(jumpId);
      else reportError(t('chat.replyUnavailable'));
    }
    return true;
  }

  /** Scrolls to a message, loading the history around it when it is not on screen. */
  public jumpTo(messageId: string): void {
    const channelId = this.ctx.channelId;
    if (!channelId) return;
    if (this.list?.jumpTo(messageKey(messageId))) return;
    this.pendingJumpId = messageId;
    networkClient.send(MessageType.CHAT_LOAD_HISTORY, { channelId, aroundMessageId: messageId });
  }

  public cancelJump(): void {
    this.pendingJumpId = null;
  }

  public render(options: { forceScroll?: boolean } = {}): void {
    const feed = this.list;
    const channelId = this.ctx.channelId;
    if (!feed || !channelId) return;
    contextMenu.close();
    this.reactionPicker?.close();
    if (!this.ctx.server.hasPermission(Permission.READ_MESSAGES, channelId)) {
      feed.showState(`
        <div class="chat-feed-state" role="status">
          <span class="material-symbols-outlined chat-feed-state-icon" aria-hidden="true">lock</span>
          <div class="chat-feed-state-title">${t('channelPermissions.readDeniedTitle')}</div>
          <div class="chat-feed-state-text">${t('channelPermissions.readDenied')}</div>
        </div>
      `);
      return;
    }

    // Read before the feed changes: new messages only pull the view down when
    // the user is already reading the end of the conversation (#270).
    const shouldScroll = options.forceScroll === true || feed.followsEnd();

    const messages = chatStore.getMessages(channelId);
    if (messages.length === 0 && chatStore.getInvocations(channelId).length === 0
      && this.historyPendingChannel === channelId) {
      feed.showState(renderLoadingSkeleton('messages', 6));
      return;
    }
    if (messages.length === 0 && chatStore.getInvocations(channelId).length === 0) {
      feed.showState(`
        <div id="chat-empty-placeholder" class="chat-feed-state">
          <span class="material-symbols-outlined chat-feed-state-icon" aria-hidden="true">forum</span>
          <div class="chat-feed-state-title">${t(
            serverStore.getChannel(channelId)?.type === 'VOICE' ? 'chat.voiceEmptyTitle' : 'chat.emptyTitle',
            { channel: escapeHtml(serverStore.serverDetails?.channels.find((c) => c.id === channelId)?.name || t('chat.defaultChannelName')) },
          )}</div>
          <div class="chat-feed-state-text">${t('chat.emptySubtitle')}</div>
        </div>
      `);
      return;
    }

    // Rows that did not change keep their element: a history reload leaves the
    // images, players and selection of the messages already on screen alone.
    const anchor = shouldScroll ? null : feed.captureAnchor((key) => !isDayKey(key));
    feed.render(this.entries(messages));
    this.ctx.actions.selection.sync();

    feed.following = shouldScroll;
    if (shouldScroll) {
      feed.scrollToEnd({ reveal: options.forceScroll === true });
      feed.repinWhileMediaLoads(feed.element, options.forceScroll === true);
    } else if (anchor) {
      feed.restoreAnchor(anchor);
    }
  }

  public append(msg: ChatMessage, options: { forceScroll?: boolean } = {}): void {
    const feed = this.list;
    const channelId = this.ctx.channelId;
    if (!feed || !channelId) return;

    // A live message can beat the history page: it replaces the placeholders.
    if (this.historyPendingChannel === channelId) this.clearHistoryPending();

    const shouldScroll = options.forceScroll === true || feed.followsEnd();
    const messages = chatStore.getMessages(channelId);
    const prevMsg = messages.length > 1 ? messages[messages.length - 2] : null;
    const day = dayOf(msg.createdAt);
    const entries: FeedEntry[] = [];
    if (!prevMsg || dayOf(prevMsg.createdAt) !== day) {
      entries.push({ key: dayKey(day), html: renderDayDivider(msg.createdAt) });
    }
    entries.push({ key: messageKey(msg.id), html: renderChannelMessage(this.ctx, msg) });
    // Whatever was on screen before (the empty-channel message, placeholders) gives way.
    feed.append(entries);
    this.pruneTrimmedRows(shouldScroll);
    this.ctx.actions.selection.sync();

    feed.following = shouldScroll;
    if (shouldScroll) {
      feed.scrollToEnd();
      const row = feed.node(messageKey(msg.id));
      if (row) feed.repinWhileMediaLoads(row);
    }
  }

  /** Redraws one row in place after an edit or a deletion (#504). */
  public replaceRow(msg: ChatMessage): void {
    const feed = this.list;
    const key = messageKey(msg.id);
    const row = feed?.node(key);
    if (!feed || !row) return;
    const focusedPollControl = capturePollFocus(row);
    const pollBars = capturePollBars(row);
    const newRow = feed.replace(key, renderChannelMessage(this.ctx, msg));
    if (!newRow) return;
    this.ctx.actions.selection.sync();
    restorePollFocus(newRow, focusedPollControl);
    animatePollBars(newRow, pollBars);
  }

  public updateReactions(message: ChatMessage): void {
    const row = this.list?.node(messageKey(message.id));
    const reactions = row?.querySelector<HTMLElement>('.chat-reactions');
    if (!row || !reactions) return;
    this.dropReactionPicker();
    // Only the reactions change, so the rest of the row keeps its images, players and selection.
    reactions.innerHTML = renderChannelReactions(message, this.ctx.channelId).toString();
    this.bindReactionButtons(reactions);
  }

  /** A bot card changed: it is redrawn in place, keeping the field being typed in and its caret. */
  public renderInvocationCard(invocation: BotInvocation): void {
    const feed = this.list;
    if (!feed || invocation.channelId !== this.ctx.channelId) return;
    const shouldScroll = feed.followsEnd();
    const key = invocationKey(invocation.invocationId);
    const previous = feed.node(key);
    const focused = document.activeElement;
    const focusId = focused instanceof HTMLElement && previous?.contains(focused) ? focused.id : '';
    const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? { start: focused.selectionStart, end: focused.selectionEnd }
      : undefined;
    const markup = this.renderInvocation(invocation);
    if (!markup) feed.remove(key);
    else if (previous) feed.replace(key, markup);
    else feed.append([{ key, html: markup }]);
    for (const entry of feed.entries()) {
      if (isInvocationKey(entry.key) && !chatStore.getInvocation(entry.element.dataset.invocationId ?? '')) feed.remove(entry.key);
    }
    if (markup && focusId) {
      const next = document.getElementById(focusId);
      next?.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.end !== null &&
          (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && next.type !== 'checkbox') {
        next.setSelectionRange(selection?.start ?? 0, selection?.end ?? 0);
      }
    }
    if (shouldScroll) feed.scrollToEnd({ keepReveal: true });
  }

  /** Keeps the newest message in view while the reader is following the end of the conversation. */
  public followEnd(): void {
    this.list?.followEnd();
  }

  /** Reactions and replies follow the permission to talk; a reply also waits for an edit to end. */
  public setActionsEnabled(canSend: boolean, editing: boolean): void {
    this.ctx.container.querySelectorAll<HTMLButtonElement>('.chat-reaction, .chat-reaction-add, [data-message-action="reply"]').forEach((button) => {
      button.disabled = !canSend || (editing && button.dataset.messageAction === 'reply');
    });
    if (!canSend) this.dropReactionPicker();
  }

  public closeReactionPicker(): void {
    this.reactionPicker?.close();
  }

  public dropReactionPicker(): void {
    this.reactionPicker?.destroy();
    this.reactionPicker = null;
  }

  /** Clicks in the feed that act on a message, the undo countdowns and the way back to the latest messages. */
  public bindListeners(): () => void {
    const { container, actions } = this.ctx;
    const messagesFeed = container.querySelector<HTMLElement>('#chat-messages-feed');
    const restoreClick = (event: Event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-restore-message-id]') : null;
      if (button?.dataset.restoreMessageId) { event.stopPropagation(); void actions.undoDeletion(button.dataset.restoreMessageId, button); }
    };
    messagesFeed?.addEventListener('click', restoreClick);
    const pollClick = (event: Event) => {
      const carouselButton = imageCarouselNavigationButton(event.target);
      if (carouselButton && !carouselButton.closest('[data-field-type="image-list"]')
          && moveImageCarousel(carouselButton)) {
        event.stopPropagation();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const votersButton = target?.closest<HTMLButtonElement>('[data-native-poll-voters]');
      if (votersButton) {
        event.stopPropagation();
        const poll = actions.findPollMessage(votersButton.dataset.nativePollVoters)?.poll;
        if (poll && !votersButton.disabled) actions.openPollVoters(poll, votersButton.dataset.nativePollVotersOption);
        return;
      }
      const button = target?.closest<HTMLButtonElement>('[data-native-poll][data-native-poll-option]');
      const pollId = button?.dataset.nativePoll;
      const optionId = button?.dataset.nativePollOption;
      if (!button || !pollId || !optionId || button.disabled) return;
      event.stopPropagation();
      actions.votePoll(pollId, optionId);
    };
    messagesFeed?.addEventListener('click', pollClick);
    const undoTimer = setInterval(() => {
      for (const button of container.querySelectorAll<HTMLButtonElement>('[data-undo-until]')) {
        const remaining = Math.ceil((Number(button.dataset.undoUntil) - Date.now()) / 1000);
        if (remaining <= 0) button.remove();
        else button.textContent = t('chat.undoDeleteCountdown', { seconds: remaining });
      }
    }, 250);
    const unbindLinks = messagesFeed ? bindMessageLinks(messagesFeed) : undefined;
    container.querySelector<HTMLButtonElement>('#chat-return-latest')?.addEventListener('click', () => {
      this.pendingJumpId = null;
      this.loadHistory();
    });
    return () => {
      clearInterval(undoTimer);
      messagesFeed?.removeEventListener('click', restoreClick);
      messagesFeed?.removeEventListener('click', pollClick);
      unbindLinks?.();
    };
  }

  /** Messages and bot cards in time order, with a divider line per day (#11). */
  private entries(messages: ChatMessage[]): FeedEntry[] {
    // One matcher for the whole feed: building it walks every known member.
    const mentions = serverMentionMatcher(serverStore);
    const items = [
      ...messages.map((message) => ({
        key: messageKey(message.id), createdAt: message.createdAt, html: renderChannelMessage(this.ctx, message, mentions),
      })),
      ...chatStore.getInvocations(this.ctx.channelId ?? '').map((invocation) => ({
        key: invocationKey(invocation.invocationId), createdAt: invocation.createdAt, html: this.renderInvocation(invocation),
      })),
    ].filter((item) => item.html !== '').sort((a, b) => a.createdAt - b.createdAt);
    const entries: FeedEntry[] = [];
    let lastDay = '';
    for (const item of items) {
      const day = dayOf(item.createdAt);
      if (day !== lastDay) {
        entries.push({ key: dayKey(day), html: renderDayDivider(item.createdAt) });
        lastDay = day;
      }
      entries.push({ key: item.key, html: item.html });
    }
    return entries;
  }

  private renderInvocation(invocation: BotInvocation): string {
    const { commands } = this.ctx;
    return renderBotInvocation(invocation, !commands.deniedReason(), serverStore.serverDetails?.id,
      commands.voiceDeniedReason(invocation), commands.presentation(invocation.botId, invocation.commandName));
  }

  /**
   * The store keeps only the newest messages of each channel, so the rows it let
   * go of leave the feed too. They had stopped working anyway — their menu, copy,
   * reply and reactions look the message up in the store — and a busy channel
   * left open for hours would otherwise grow without limit.
   */
  private pruneTrimmedRows(followingEnd: boolean): void {
    const feed = this.list;
    const channelId = this.ctx.channelId;
    if (!feed || !channelId) return;
    const kept = new Set(this.ctx.store.getMessages(channelId).map((message) => messageKey(message.id)));
    const trimmed = new Set(feed.entries().filter((entry) => isMessageKey(entry.key) && !kept.has(entry.key))
      .map((entry) => entry.key));
    if (!trimmed.size) return;
    // Whatever the reader is looking at stays where it is (an exact restoration).
    const anchor = followingEnd ? null : feed.captureAnchor((key) => !trimmed.has(key) && !isDayKey(key));
    for (const key of trimmed) feed.remove(key);
    // A day left without messages loses its divider as well.
    const entries = feed.entries();
    entries.forEach((entry, index) => {
      const next = entries[index + 1];
      if (isDayKey(entry.key) && (!next || isDayKey(next.key))) feed.remove(entry.key);
    });
    if (anchor) feed.restoreAnchor(anchor);
  }

  /** Wires an entry the feed just built: links to invitations, previews, code, media and the row's own actions. */
  private bindEntry(element: HTMLElement): void {
    mountServerInviteCards(element, row => !!row.dataset.userId && row.dataset.userId === serverStore.currentUser?.id);
    linkPreviewService.initializePreviews(element);
    bindCodeBlockCopyButtons(element);
    if (element.classList.contains('chat-message-row')) this.bindMessageRow(element);
    bindChatMedia(element, this.ctx);
    initializeCustomMediaPlayers(element);
  }

  /** Right-click menu, hover toolbar, reactions and reply jump of one message row. */
  private bindMessageRow(row: HTMLElement): void {
    const { actions, composer } = this.ctx;
    row.querySelector<HTMLButtonElement>('[data-retry-message]')?.addEventListener('click', () => {
      composer.retryMessage(row.dataset.messageId ?? '');
    });
    const toolbar = row.querySelector<HTMLElement>('.chat-message-toolbar');
    const dismissToolbar = () => this.dismissToolbar(row);
    const resetToolbar = () => row.classList.remove('chat-message-actions-dismissed');
    // Closing a submenu over the row can synthesize an enter without moving
    // the pointer. Only real movement should undo an action's dismissal.
    row.addEventListener('pointermove', (event) => {
      if (event.movementX || event.movementY) resetToolbar();
    });
    row.addEventListener('mouseleave', resetToolbar);
    toolbar?.addEventListener('focusin', resetToolbar);
    toolbar?.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-message-action]') : null;
      if (button && !button.disabled && !['more', 'emoji', 'copy'].includes(button.dataset.messageAction ?? '')) dismissToolbar();
    }, true);
    this.bindReactionButtons(row);
    row.querySelector<HTMLButtonElement>('[data-message-action="reply"]')?.addEventListener('click', () => {
      composer.startReply(row.dataset.messageId ?? '');
    });
    row.querySelector<HTMLButtonElement>('[data-message-action="copy"]')?.addEventListener('click', () => {
      const messageId = row.dataset.messageId ?? '';
      const selection = actions.copy.selection(messageId);
      dismissToolbar();
      void actions.copyMessage(messageId, 'formatted', selection);
    });
    const more = row.querySelector<HTMLButtonElement>('[data-message-action="more"]');
    more?.addEventListener('click', (event) => {
      if (contextMenu.isOpenFor(more)) {
        contextMenu.close();
        (event.detail === 0 ? more : row).focus({ preventScroll: true });
        return;
      }
      this.reactionPicker?.close();
      resetToolbar();
      const rect = more.getBoundingClientRect();
      const dismissItem = (item: ContextMenuItem): ContextMenuItem => ({
        ...item,
        onClick: () => { dismissToolbar(); item.onClick(); },
      });
      const items = actions.menuItems(row.dataset.messageId ?? null).map((item) =>
        'submenu' in item ? { ...item, submenu: item.submenu.map(dismissItem),
          onClick: item.onClick ? () => { dismissToolbar(); item.onClick?.(); } : undefined } : dismissItem(item));
      contextMenu.open(rect.right, rect.bottom, items, more);
    });
    row.querySelector<HTMLButtonElement>('[data-reply-target]')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      if (button instanceof HTMLButtonElement && button.dataset.replyTarget) this.jumpTo(button.dataset.replyTarget);
    });
    row.addEventListener('contextmenu', (mouseEvent: MouseEvent) => {
      const image = mouseEvent.target instanceof Element
        ? mouseEvent.target.closest<HTMLImageElement>('img.chat-attachment-image, img.chat-sticker') : null;
      if (image && row.contains(image)) {
        mouseEvent.preventDefault();
        userContextMenu.close();
        contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, [{
          label: t('chat.copyImage'), icon: 'content_copy',
          onClick: () => { void actions.copyAttachmentImage(image); },
        }, ...actions.menuItems(row.dataset.messageId ?? null)]);
        return;
      }
      // If text is currently highlighted / selected, allow normal browser selection copy
      const selection = window.getSelection()?.toString();
      if (selection && selection.trim().length > 0) {
        return;
      }

      const userId = row.getAttribute('data-user-id');
      if (!userId) return;

      const targetUser =
        participantManager.getByUserId(userId)?.user ||
        serverStore.serverDetails?.members.find((m) => m.id === userId) ||
        serverStore.knownMembers.get(userId);
      if (mouseEvent.target instanceof Element && mouseEvent.target.closest('.chat-author-name, .chat-author-avatar')) {
        if (targetUser) {
          mouseEvent.preventDefault();
          contextMenu.close();
          userContextMenu.open(mouseEvent.clientX, mouseEvent.clientY, targetUser);
          return;
        }
        const channelId = this.ctx.channelId;
        const message = channelId
          ? chatStore.getMessages(channelId).find((entry) => entry.id === row.dataset.messageId)
          : undefined;
        if (message?.isBot && message.userId === userId) {
          mouseEvent.preventDefault();
          userContextMenu.close();
          contextMenu.open(mouseEvent.clientX, mouseEvent.clientY,
            [botSettingsMenuItem(userId, getActiveNetworkClient(), getActiveServerStore())]);
          return;
        }
      }

      // Editing/deleting acts on this specific message, so it takes
      // precedence over the per-person menu (#504).
      const messageActions = actions.menuItems(row.getAttribute('data-message-id'));
      if (messageActions.length > 0) {
        mouseEvent.preventDefault();
        userContextMenu.close();
        contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, messageActions);
        return;
      }

      if (targetUser) {
        mouseEvent.preventDefault();
        userContextMenu.open(mouseEvent.clientX, mouseEvent.clientY, targetUser);
      }
    });
  }

  private bindReactionButtons(row: HTMLElement): void {
    row.querySelectorAll<HTMLButtonElement>('.chat-reaction, .chat-reaction-add').forEach((button) => {
      button.addEventListener('click', (event) => {
        const channelId = this.ctx.channelId;
        if (!channelId || !serverStore.hasPermission(Permission.SEND_MESSAGES, channelId)) return;
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
        const messageRow = button.closest<HTMLElement>('.chat-message-row');
        if (this.reactionPicker?.isOpenFor(button)) {
          this.reactionPicker.close();
          (event.detail === 0 ? button : messageRow)?.focus({ preventScroll: true });
          return;
        }
        this.reactionPicker?.destroy();
        contextMenu.close();
        messageRow?.classList.remove('chat-message-actions-dismissed');
        const picker = new EmojiPicker({
          container: document.body, anchor: button, emojiOnly: true, floating: true,
          onSelectEmoji: (emoji) => {
            picker.close();
            if (messageRow) this.dismissToolbar(messageRow);
            toggle(emoji);
          },
        });
        this.reactionPicker = picker;
        void picker.open();
      });
    });
  }

  private dismissToolbar(row: HTMLElement): void {
    contextMenu.close();
    row.classList.add('chat-message-actions-dismissed');
    row.focus({ preventScroll: true });
  }
}
