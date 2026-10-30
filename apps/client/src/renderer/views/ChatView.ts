import { MessageType, Permission } from '@monky/shared';
import type { ChatMessage } from '@monky/shared';
import { appEvents } from '../core/EventBus';
import { getActiveNetworkClient, networkClient } from '../core/NetworkClient';
import { t } from '../i18n';
import { chatStore, getActiveChatStore } from '../stores/chatStore';
import { channelViewSignature, getActiveServerStore, serverStore } from '../stores/serverStore';
import { escapeHtml } from '../utils/html';
import { cancelSurfaceMotion } from '../utils/surfaceMotion';
import { cancelVisibilityMotion } from '../utils/surfaceVisibility';
import { renderChatComposer, renderChatEditComposer } from './ChatComposer';
import { ChatCommands } from './chat/ChatCommands';
import { ChatComposerController } from './chat/ChatComposerController';
import type { ChatContext } from './chat/chatContext';
import { ChatFeedController } from './chat/ChatFeedController';
import { ChatMessageActions } from './chat/ChatMessageActions';
import { MentionDropup } from './chat/MentionDropup';
import { contextMenu } from './ContextMenu';
import { lightboxModal } from './LightboxModal';
import type { MarkdownInput } from './MarkdownInput';

/**
 * The chat of a channel: its conversation and the composer below it.
 *
 * The work is split among parts that share this view as their context
 * (R-CHAT-10): the feed, the composer, the actions on sent messages, bot
 * commands and @-mentions. The view draws the frame, follows the channel
 * on screen and hands the app's events to the parts concerned.
 */
export class ChatView implements ChatContext {
  public onOpenForum?: (channelId: string) => void;
  public readonly store = getActiveChatStore();
  public readonly client = getActiveNetworkClient();
  public readonly server = getActiveServerStore();
  public readonly feed: ChatFeedController;
  public readonly composer: ChatComposerController;
  public readonly actions: ChatMessageActions;
  public readonly commands: ChatCommands;
  public readonly mentions: MentionDropup;
  private currentChannelId: string | null = null;
  private unbindEvents: Array<() => void> = [];
  /** Whether the member could read the channel when its permissions were last looked at. */
  private couldRead = false;
  /** What the open channel's composer was last brought up to date with (see `channelViewSignature`). */
  private settingsSignature = '';

  constructor(public readonly container: HTMLElement) {
    this.feed = new ChatFeedController(this);
    this.composer = new ChatComposerController(this);
    this.actions = new ChatMessageActions(this);
    this.commands = new ChatCommands(this);
    this.mentions = new MentionDropup(this);
  }

  public get channelId(): string | null {
    return this.currentChannelId;
  }

  /** Whether the server this view was created for is still the one on screen. */
  public isCurrentSession(): boolean {
    return getActiveChatStore() === this.store && getActiveNetworkClient() === this.client &&
      getActiveServerStore() === this.server;
  }

  public setChannel(channelId: string): void {
    if (!this.isCurrentSession()) return;
    if (this.currentChannelId === channelId && this.composer.hasInput && this.container.querySelector('#chat-messages-feed')) {
      // Channel is already active and rendered; keep existing DOM and media state
      this.composer.focus({ defer: true });
      return;
    }

    this.currentChannelId = channelId;
    this.feed.cancelJump();
    // Switching channels discards any files staged for the previous channel (#11).
    this.composer.tray.clear();
    // Opening a channel reads its mentions: clear the local badge and tell the
    // server so offline-delivered mentions aren't re-shown next connect (#14).
    chatStore.clearMention(channelId);
    chatStore.clearUnread(channelId);
    networkClient.send(MessageType.CHAT_MENTIONS_READ, { channelId });
    this.feed.markHistoryPending();
    this.render();
    this.feed.loadHistory();
    // Auto-focus the message input after the fresh DOM has settled (#181).
    this.composer.focus({ defer: true });
  }

  public render(): void {
    this.unbindListeners();

    const serverDetails = this.server.serverDetails;
    const channelId = this.currentChannelId;
    if (!this.isCurrentSession() || !channelId || !serverDetails) {
      this.container.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
          ${t('chat.selectChannel')}
        </div>
      `;
      return;
    }

    if (this.server.currentUser) {
      this.store.setComposerScope({
        sessionKey: this.client.sessionKey || this.client.getCurrentServerUrl(),
        serverId: serverDetails.id,
        userId: this.server.currentUser.id,
      });
    }
    const channel = serverDetails.channels.find((c) => c.id === channelId);
    const channelName = channel ? channel.name : t('chat.defaultChannelName');
    const isVoiceChannel = channel?.type === 'VOICE';
    const readDenied = !this.server.hasPermission(Permission.READ_MESSAGES, channelId);

    const markup = `
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
            ${channel?.forumId ? `<button type="button" class="btn btn-secondary" id="chat-forum-back" aria-label="${t('forum.back')}" title="${t('forum.back')}"><span class="material-symbols-outlined md-20">close</span></button>` : ''}
            <span class="material-symbols-outlined md-18" style="color: var(--text-muted);">${isVoiceChannel ? 'volume_up' : 'tag'}</span>
            <span class="channel-title">${escapeHtml(channelName)}</span>
          </div>
          <div class="header-status-badge">${t(isVoiceChannel ? 'chat.voiceChannelBadge' : 'chat.textChannelBadge')}</div>
        </div>

        <div id="chat-messages-feed" class="chat-messages-feed"></div>
        <button type="button" id="chat-return-latest" class="btn btn-secondary" hidden>${t('chat.returnLatest')}</button>

        <div class="chat-input-container" ${readDenied ? 'hidden' : ''}>
          ${renderChatEditComposer()}
          <div id="mention-dropup" class="mention-dropup" style="display: none;"></div>
          <div id="command-dropup" class="command-dropup" style="display: none;"></div>
          <div id="chat-attachment-tray" class="chat-attachment-tray" style="display: none;"></div>
          <div id="chat-compose-link-preview" class="chat-compose-link-preview" style="display: none;"></div>
          <div id="chat-send-permission-banner" class="chat-permission-banner" style="display: none;"></div>
          <div id="chat-command-composer" class="bot-command-composer" hidden></div>
          ${renderChatComposer({
            kind: 'channel',
            placeholder: t(isVoiceChannel ? 'chat.voiceInputPlaceholder' : 'chat.inputPlaceholder', { channel: channelName }),
            maxLength: this.composer.messageLengthLimit,
          })}
        </div>
      </div>
    `;
    this.container.innerHTML = markup;
    this.feed.mount(this.container.querySelector<HTMLElement>('#chat-messages-feed'));
    this.composer.tray.mount(this.container.querySelector<HTMLElement>('#chat-attachment-tray'));

    if (readDenied) this.store.revokeChannel(channelId);
    this.feed.render({ forceScroll: true });
    this.attachEvents();
    const forumId = channel?.forumId;
    if (forumId) this.container.querySelector('#chat-forum-back')?.addEventListener('click', () => this.onOpenForum?.(forumId));
  }

  /**
   * Catches the open channel up after the socket came back, keeping the DOM,
   * the draft and the reading position: only messages missed meanwhile change.
   */
  public resyncAfterReconnect(): void {
    if (!this.currentChannelId || !this.container.querySelector('#chat-messages-feed')) return;
    this.feed.expectResync();
    this.composer.syncPermissionState();
    this.feed.loadHistory();
  }

  public jumpToMessage(messageId: string): void {
    this.feed.jumpTo(messageId);
  }

  /** Binds the parts to the markup just drawn and hands them the app's events. */
  private attachEvents(): void {
    const input = this.container.querySelector<MarkdownInput>('#chat-message-input');
    const channelId = this.currentChannelId;
    this.couldRead = !!channelId && this.server.hasPermission(Permission.READ_MESSAGES, channelId);
    this.settingsSignature = channelViewSignature(this.server, channelId);
    const refreshSettings = () => this.refreshSettings(input);
    this.unbindEvents.push(
      this.composer.bind(input),
      this.feed.bindListeners(),
      this.actions.copy.bind(),
      this.commands.bindDropup(input),
      // The server re-sends the role list whenever anyone logs in, and `server.updated`
      // follows each one: only a real change for this channel reaches the composer, once (#850).
      appEvents.on('server.updated', refreshSettings),
      appEvents.on('server.roles_updated', refreshSettings),
      appEvents.on('chat.message_added', (message: ChatMessage) => {
        if (message.channelId !== this.currentChannelId) return;
        // Sending a message always brings the author back to the end (#270).
        this.feed.append(message, { forceScroll: message.userId === serverStore.currentUser?.id });
      }),
      appEvents.on('chat.history_loaded', (data: { channelId: string; aroundMessageId?: string }) => {
        if (data.channelId !== this.currentChannelId || !this.feed.historyLoaded(data)) return;
        if (!this.server.hasPermission(Permission.READ_MESSAGES, data.channelId)) {
          this.composer.clearForRevokedRead();
          this.composer.renderBlocks();
        }
      }),
      // Only the affected row is redrawn: rebuilding the whole feed would drop
      // the reader's scroll position and reload every image (#504).
      appEvents.on('chat.message_updated', (message: ChatMessage) => {
        if (message.channelId !== this.currentChannelId) return;
        contextMenu.close();
        this.feed.closeReactionPicker();
        this.feed.replaceRow(message);
        if (this.store.getReplyDraft(message.channelId)?.messageId === message.id ||
            this.store.getBlockDraft(message.channelId).some(block => block.type === 'reply' && block.messageId === message.id)) {
          this.composer.renderReply();
        }
      }),
      appEvents.on('chat.commands_updated', () => this.commands.commandsUpdated(input)),
      ...this.commands.subscribe(input),
      appEvents.on('chat.reactions_updated', (message: ChatMessage) => {
        if (message.channelId === this.currentChannelId) this.feed.updateReactions(message);
      }),
      () => this.feed.dropReactionPicker(),
      appEvents.on('network.status', () => this.composer.syncPermissionState()),
      appEvents.on('user.updated', () => this.composer.syncPermissionState()),
      appEvents.on('chat.cleared', () => {
        if (this.isCurrentSession()) this.composer.release();
      }),
    );
    // Last, so the command composer's own listeners run after the view's.
    this.commands.mount(input);
  }

  /** The server's settings or the member's permissions changed. */
  private refreshSettings(input: MarkdownInput | null): void {
    const channelId = this.currentChannelId;
    const signature = channelViewSignature(this.server, channelId);
    if (signature === this.settingsSignature) {
      // Who may be mentioned also follows other members' roles.
      this.composer.refreshMentions(input);
      return;
    }
    this.settingsSignature = signature;
    const canRead = !!channelId && this.server.hasPermission(Permission.READ_MESSAGES, channelId);
    if (canRead !== this.couldRead) {
      this.couldRead = canRead;
      if (!canRead && channelId) {
        this.store.revokeChannel(channelId);
        this.composer.clearForRevokedRead();
      }
      if (canRead) this.feed.markHistoryPending();
      else this.feed.clearHistoryPending();
      this.feed.render();
      if (canRead) this.feed.loadHistory();
    }
    this.composer.refreshSettings(input);
  }

  private unbindListeners(): void {
    this.composer.rememberText();
    this.commands.unmount();
    // Its state outlives the markup: left open, the next channel's first Enter or Tab would insert a stale mention.
    this.mentions.close();
    this.actions.copy.cancel();
    contextMenu.close();
    this.feed.cancelJump();
    for (const element of this.container.querySelectorAll<HTMLElement>('#mention-dropup, #command-dropup')) {
      cancelSurfaceMotion(element);
      element.hidden = true;
      element.replaceChildren();
    }
    this.unbindEvents.forEach((unbind) => unbind());
    this.unbindEvents = [];
    this.container.querySelectorAll<HTMLElement>('[data-ui-motion]').forEach(cancelVisibilityMotion);
    // After the sweep above, which would otherwise cancel the bar's exit and leave it behind.
    this.actions.selection.stop();
    this.container.querySelectorAll<MarkdownInput>('monky-markdown-input').forEach(input => input.destroy());
    this.composer.release();
    this.feed.unmount();
    this.composer.tray.mount(null);
  }

  public destroy(): void {
    this.feed.clearHistoryPending();
    lightboxModal.close();
    this.unbindListeners();
    this.composer.tray.destroy();
  }
}
