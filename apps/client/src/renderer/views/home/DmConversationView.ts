import {
  DM_MAX_ATTACHMENTS,
  DM_MAX_MESSAGE_LENGTH,
  type DmAttachmentView,
  type DmFailure,
  type DmMessageView,
  type DmOutgoingFile,
  type DmPeerView,
  type MessageReply,
} from '@monky/shared';
import { t, tCount } from '../../i18n';
import { dmStore } from '../../stores/dmStore';
import { ownAvatarSource } from '../../core/profileSync';
import { connectionStore } from '../../stores/connectionStore';
import { formatBytes, fileIconName } from '../../utils/attachment';
import { getAvatarUrl } from '../../utils/avatar';
import { openFileInputPicker } from '../../utils/buttonLoading';
import { escapeHtml } from '../../utils/html';
import { renderMarkdown } from '../../utils/markdown';
import type { MessageClipboardContent } from '../../utils/messageClipboard';
import { formatMessageClock, formatMessageTime, renderReplyPreview } from '../../utils/messageReply';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import { bindChatComposer, renderChatComposer, renderChatEditComposer } from '../ChatComposer';
import { contextMenu, type ContextMenuEntry } from '../ContextMenu';
import { showErrorToast } from '../CopyToast';
import { showConfirm } from '../Dialog';
import { EmojiPicker } from '../EmojiPicker';
import { lightboxModal } from '../LightboxModal';
import { bindCodeBlockCopyButtons, MessageCopy, messageClipboardContent } from '../MessageCopy';
import { mountServerInviteCards, openServerInviteLink } from '../ServerInviteCard';
import type { MarkdownInput } from '../MarkdownInput';
import '../MarkdownInput';
import { dmFailureMessage } from './dmErrors';
import { MessageSelection, type MessageSelectionAction } from '../MessageSelection';
import { forwardDestinations, openForwardModal } from '../ForwardMessagesModal';
import type { ForwardItem } from '../../core/MessageForwarder';
import { downloadFilesWithChoice, type DownloadableFile } from '../../utils/fileDownloads';
import { archiveDate, renderForwardedBadge } from '../../utils/messageForward';

interface StagedFile {
  id: string;
  file: File;
  previewUrl: string | null;
}

/** Consecutive messages from the same author on the same local day share one header. */
function sameLocalDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

/**
 * One direct-message conversation (#743). History lives in the main process;
 * this view renders what `dmStore` holds and sends through it. The composer,
 * its menus and message copying are the ones server channels use.
 */
export class DmConversationView {
  private container: HTMLElement | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private listeners: AbortController | null = null;
  private replyTo: string | null = null;
  private editing: string | null = null;
  /** Unsent text set aside while a sent message is being edited. */
  private draft = '';
  private staged: StagedFile[] = [];
  private readonly blobUrls = new Map<string, string>();
  private readonly loadingBlobs = new Set<string>();
  private picker: EmojiPicker | null = null;
  private composerPicker: EmojiPicker | null = null;
  private pinnedToBottom = true;
  private sending = false;
  private readonly copy = new MessageCopy({
    isActive: () => !!this.container?.isConnected,
    feed: () => this.query('[data-dm-feed]'),
    content: (messageId) => this.messageClipboard(messageId),
    image: (messageId) => this.messageClipboardImage(messageId),
  });
  private readonly selection = new MessageSelection({
    feed: () => this.query('[data-dm-feed]'),
    host: () => this.query('.chat-input-container'),
    selectable: (row) => !!this.selectableMessage(row.dataset.messageId ?? ''),
    actions: (ids) => this.selectionActions(ids),
  });

  constructor(readonly peer: string) {}

  public mount(container: HTMLElement): void {
    this.destroy();
    this.container = container;
    this.listeners = new AbortController();
    container.innerHTML = this.renderShell();
    this.bindEvents();
    this.renderHeader();
    this.renderComposerState();
    this.renderMessages(true);
    this.unsubscribers.push(
      dmStore.bus.on<{ peer: string }>('messages', (event) => {
        if (event?.peer !== this.peer) return;
        this.renderMessages(false);
        if (this.replyTo) this.renderReplyComposer();
      }),
      dmStore.bus.on<{ peer: string }>('typing', (event) => {
        if (event?.peer === this.peer) this.renderTyping();
      }),
      dmStore.bus.on('changed', () => {
        this.renderHeader();
        this.renderComposerState();
      }),
      dmStore.bus.on('presence', () => {
        this.renderHeader();
        this.renderComposerState();
      }),
    );
    void dmStore.open(this.peer);
    window.addEventListener('focus', () => void dmStore.markRead(this.peer), { signal: this.listeners.signal });
    this.focusInput();
  }

  public destroy(): void {
    if (!this.container) return;
    this.selection.stop();
    dmStore.leave(this.peer);
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.listeners?.abort();
    this.listeners = null;
    this.copy.cancel();
    contextMenu.close();
    this.picker?.destroy();
    this.picker = null;
    this.composerPicker?.destroy();
    this.composerPicker = null;
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    for (const file of this.staged) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    this.staged = [];
    this.replyTo = null;
    this.editing = null;
    this.draft = '';
    this.sending = false;
    this.container = null;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private peerView(): DmPeerView | undefined {
    return dmStore.peer(this.peer);
  }

  private nickname(): string {
    return this.peerView()?.nickname || this.peer.slice(0, 8);
  }

  private renderShell(): string {
    return `
      <div class="chat-container dm-conversation" data-dm-peer="${escapeHtml(this.peer)}">
        <div class="chat-drop-overlay">
          <div class="drop-inner">
            <span class="material-symbols-outlined" style="font-size: 48px;">upload_file</span>
            <div class="drop-title">${t('chat.dropTitle')}</div>
            <div class="drop-sub">${t('chat.dropSubtitle')}</div>
          </div>
        </div>
        <div class="content-header dm-header" data-dm-header></div>
        <div class="chat-messages-feed dm-messages-feed" data-dm-feed></div>
        <div class="dm-typing" data-dm-typing aria-live="polite"></div>
        <div class="chat-input-container">
          <div class="chat-permission-banner dm-banner" data-dm-banner hidden></div>
          ${renderChatEditComposer()}
          <div id="chat-attachment-tray" class="chat-attachment-tray" style="display: none;"></div>
          ${renderChatComposer({
            kind: 'direct',
            placeholder: t('dm.inputPlaceholder', { nickname: this.nickname() }),
            maxLength: DM_MAX_MESSAGE_LENGTH,
          })}
          <div class="dm-offline-hint" data-dm-offline hidden></div>
        </div>
      </div>
    `;
  }

  private renderHeader(): void {
    const header = this.query('[data-dm-header]');
    if (!header) return;
    const peer = this.peerView();
    const online = dmStore.isOnline(this.peer);
    header.innerHTML = `
      <div class="channel-title-container dm-header-title">
        <span class="dm-header-avatar">
          <img src="${escapeHtml(getAvatarUrl(peer?.avatar))}" alt="" data-fallback="avatar">
          <span class="status-indicator ${online ? 'online' : 'offline'}" aria-hidden="true"></span>
        </span>
        <span class="channel-title">${escapeHtml(this.nickname())}</span>
        <span class="dm-header-presence">${online ? t('main.statusOnline') : t('main.statusOffline')}</span>
      </div>
      <div class="header-status-badge dm-header-badge" title="${escapeHtml(t('dm.encryptedHint'))}">
        <span class="material-symbols-outlined md-14" aria-hidden="true">lock</span>
        <span>${t('dm.encrypted')}</span>
      </div>
    `;
  }

  private canWrite(): boolean {
    const peer = this.peerView();
    return !!peer && peer.relation === 'friend' && !peer.blocked;
  }

  private renderComposerState(): void {
    const banner = this.query('[data-dm-banner]');
    const peer = this.peerView();
    const writable = this.canWrite();
    if (banner) {
      if (peer?.blocked) {
        banner.innerHTML = `<span>${escapeHtml(t('dm.blockedBanner', { nickname: this.nickname() }))}</span>
          <button type="button" class="btn btn-secondary" data-dm-unblock>${t('home.unblockUser')}</button>`;
        banner.hidden = false;
      } else if (!writable) {
        banner.innerHTML = `<span>${escapeHtml(t('dm.readOnly'))}</span>`;
        banner.hidden = false;
      } else {
        banner.hidden = true;
        banner.replaceChildren();
      }
      banner.style.display = banner.hidden ? 'none' : 'flex';
    }
    const surface = this.query('.chat-composer-surface');
    if (surface) surface.hidden = !writable;
    if (!writable) {
      this.cancelEdit();
      this.clearReply();
      this.clearStaged();
      this.composerPicker?.close();
    }
    const offline = this.query('[data-dm-offline]');
    if (offline) {
      const show = writable && !dmStore.isOnline(this.peer);
      offline.hidden = !show;
      offline.textContent = show ? t('dm.offlineHint', { nickname: this.nickname() }) : '';
    }
    this.syncComposer();
  }

  /** The same composer states as a server channel: editing swaps Send for Save and sets attachments aside. */
  private syncComposer(): void {
    const input = this.input();
    if (!input) return;
    const editing = this.editing !== null;
    const saving = editing && this.sending;
    this.query('.chat-input-container')?.classList.toggle('chat-input-container--editing', editing);
    const banner = this.query('#chat-edit-composer');
    if (banner) banner.hidden = !editing;
    const cancel = this.query<HTMLButtonElement>('#btn-cancel-message-edit');
    if (cancel) cancel.disabled = saving;
    const placeholder = editing ? t('chat.editingMessage') : t('dm.inputPlaceholder', { nickname: this.nickname() });
    // Each attribute change reconfigures the editor, so only real changes are written.
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    if (input.getAttribute('aria-label') !== placeholder) input.setAttribute('aria-label', placeholder);
    const describedBy = editing ? 'chat-edit-hint chat-edit-error' : null;
    if (input.getAttribute('aria-describedby') !== describedBy) {
      if (describedBy) input.setAttribute('aria-describedby', describedBy);
      else input.removeAttribute('aria-describedby');
    }
    if (input.readOnly !== saving) input.readOnly = saving;
    input.classList.toggle('chat-input-field--readonly', saving);
    this.query('.chat-input-wrapper')?.classList.toggle('chat-input-wrapper--disabled', saving);
    this.container?.querySelectorAll<HTMLButtonElement>('#btn-emoji, #btn-format, [data-format]').forEach((button) => {
      button.disabled = saving;
    });
    const attach = this.query<HTMLButtonElement>('#btn-attach');
    if (attach) {
      attach.style.display = editing ? 'none' : '';
      attach.disabled = editing;
    }
    const send = this.query<HTMLButtonElement>('#btn-send-message');
    if (send) {
      send.disabled = this.sending;
      send.setAttribute('aria-busy', String(saving));
      const label = send.querySelector('.chat-send-label');
      const text = t(saving ? 'chat.editSaving' : editing ? 'common.save' : 'chat.send');
      if (label && label.textContent !== text) label.textContent = text;
      const icon = send.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = saving ? 'hourglass_empty' : editing ? 'check' : 'send';
    }
    this.updateCounter();
  }

  private updateCounter(): void {
    const length = this.input()?.value.length ?? 0;
    const counter = this.query('#chat-char-counter');
    if (!counter) return;
    counter.textContent = `${length}/${DM_MAX_MESSAGE_LENGTH}`;
    counter.classList.toggle('code-char-count--over', length > DM_MAX_MESSAGE_LENGTH);
  }

  private renderTyping(): void {
    const typing = this.query('[data-dm-typing]');
    if (!typing) return;
    typing.textContent = dmStore.isTyping(this.peer) ? t('dm.typing', { nickname: this.nickname() }) : '';
  }

  private renderMessages(forceScroll: boolean): void {
    const feed = this.query('[data-dm-feed]');
    if (!feed) return;
    const state = dmStore.conversation(this.peer);
    const previousHeight = feed.scrollHeight;
    const previousTop = feed.scrollTop;
    const firstBefore = feed.querySelector<HTMLElement>('.chat-message-row')?.dataset.messageId;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    const messages = state?.messages ?? [];
    const intro = state && !state.hasMore ? this.renderIntro() : '';
    const older = state?.hasMore
      ? `<button type="button" class="btn btn-secondary dm-load-older" data-dm-older>${t('dm.loadOlder')}</button>`
      : '';
    feed.innerHTML = `${older}${intro}${messages.map((message, index) => this.renderMessage(message, messages[index - 1])).join('')}`;
    this.bindFeed(feed);
    this.loadImages(feed);
    this.selection.sync();
    const firstAfter = feed.querySelector<HTMLElement>('.chat-message-row')?.dataset.messageId;
    if (forceScroll || (nearBottom && this.pinnedToBottom)) {
      feed.scrollTop = feed.scrollHeight;
    } else if (firstBefore && firstAfter !== firstBefore) {
      // Older messages were prepended: keep the same message under the eyes.
      feed.scrollTop = previousTop + (feed.scrollHeight - previousHeight);
    } else {
      feed.scrollTop = previousTop;
    }
    this.renderTyping();
  }

  private renderIntro(): string {
    const peer = this.peerView();
    return `
      <div class="dm-intro">
        <img class="dm-intro-avatar" src="${escapeHtml(getAvatarUrl(peer?.avatar))}" alt="" data-fallback="avatar">
        <h2>${escapeHtml(this.nickname())}</h2>
        <p>${escapeHtml(t('dm.conversationStart', { nickname: this.nickname() }))}</p>
        <p class="dm-intro-hint"><span class="material-symbols-outlined md-16" aria-hidden="true">lock</span>${escapeHtml(t('dm.conversationStartDesc'))}</p>
      </div>
    `;
  }

  private authorInfo(author: string): { name: string; avatar: string | null; mine: boolean } {
    const me = dmStore.snapshot.me?.publicKey;
    if (author === me) {
      return {
        name: connectionStore.savedNickname.trim() || t('home.defaultNickname'),
        avatar: ownAvatarSource(),
        mine: true,
      };
    }
    const peer = this.peerView();
    return { name: this.nickname(), avatar: peer?.avatar ?? null, mine: false };
  }

  private renderMessage(message: DmMessageView, previous: DmMessageView | undefined): string {
    const author = this.authorInfo(message.author);
    const grouped = !!previous && previous.author === message.author && !previous.deleted && !message.replyTo &&
      sameLocalDay(previous.createdAt, message.createdAt);
    const time = formatMessageTime(message.createdAt);
    const writable = this.canWrite();
    const gutterTime = grouped ? `<span class="dm-grouped-time" aria-hidden="true">${formatMessageClock(message.createdAt)}</span>` : '';
    if (message.deleted) {
      return `
        <div class="chat-message-row chat-message-deleted${grouped ? ' dm-message-row--grouped' : ''}" data-message-id="${escapeHtml(message.id)}">
          ${gutterTime}
          <img class="chat-author-avatar" src="${escapeHtml(getAvatarUrl(author.avatar))}" alt="" data-fallback="avatar">
          <div class="chat-message-body">
            <div class="chat-author-header">
              <span class="chat-author-name">${escapeHtml(author.name)}</span>
              <span class="chat-timestamp">${time}</span>
            </div>
            <div class="chat-message-deleted-text">
              <span class="material-symbols-outlined md-14">block</span>
              <span>${t('chat.messageDeleted')}</span>
            </div>
          </div>
        </div>
      `;
    }
    const pending = author.mine && message.delivery === 'pending';
    const failed = author.mine && message.delivery === 'failed';
    const editedBadge = message.editedAt
      ? `<span class="chat-edited-badge" title="${escapeHtml(formatMessageTime(message.editedAt))}">${t('chat.messageEdited')}</span>`
      : '';
    const rowClass = `chat-message-row${grouped ? ' dm-message-row--grouped' : ''}${pending ? ' dm-message-row--pending' : ''}`;
    return `
      <div class="${rowClass}" tabindex="-1" data-message-id="${escapeHtml(message.id)}"${author.mine ? ` data-delivery="${pending ? 'pending' : failed ? 'failed' : 'sent'}"` : ''}>
        ${this.renderToolbar(author.mine, writable)}
        ${gutterTime}
        <img class="chat-author-avatar" src="${escapeHtml(getAvatarUrl(author.avatar))}" alt="" data-fallback="avatar">
        <div class="chat-message-body">
          <div class="chat-author-header">
            <span class="chat-author-name">${escapeHtml(author.name)}</span>
            <span class="chat-timestamp">${time}</span>
            ${grouped ? '' : editedBadge}
          </div>
          ${message.forwarded ? renderForwardedBadge(message.forwarded, formatMessageTime) : ''}
          ${pending ? `<span class="chat-delivery-sr" role="status">${escapeHtml(t('dm.deliveryPending'))}</span>` : ''}
          ${message.replyTo ? this.renderReplyReference(message.replyTo) : ''}
          ${message.content.trim() ? `<div class="chat-message-text">${renderMarkdown(message.content, { currentNickname: connectionStore.savedNickname })}${grouped ? editedBadge : ''}</div>` : ''}
          ${message.attachments.length ? `<div class="dm-attachments">${message.attachments.map((attachment) => this.renderAttachment(message, attachment, author.mine)).join('')}</div>` : ''}
          ${failed ? `<div class="chat-delivery chat-delivery--failed dm-delivery-failed" role="status">
            <span class="material-symbols-outlined md-14" aria-hidden="true">error_outline</span>
            <span>${escapeHtml(t('dm.deliveryFailed'))}</span>
          </div>` : ''}
          <div class="chat-reactions">${this.renderReactions(message, writable)}</div>
        </div>
      </div>
    `;
  }

  private renderToolbar(mine: boolean, writable: boolean): string {
    const button = (action: string, icon: string, label: string) =>
      `<button type="button" data-dm-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="material-symbols-outlined md-18" aria-hidden="true">${icon}</span></button>`;
    return `<div class="chat-message-toolbar" role="group" aria-label="${escapeHtml(t('chat.messageActions'))}">
      ${writable ? button('react', 'add_reaction', t('chat.emojiAction')) : ''}
      ${writable ? button('reply', 'reply', t('chat.replyMessage')) : ''}
      ${writable && mine ? button('edit', 'edit', t('chat.editMessage')) : ''}
      ${button('copy', 'content_copy', t('chat.copyMessage'))}
      ${mine ? button('delete', 'delete', t('chat.deleteMessage')) : ''}
    </div>`;
  }

  private renderReplyReference(replyTo: string): string {
    const state = dmStore.conversation(this.peer);
    const original = state?.messages.find((message) => message.id === replyTo);
    if (!original || original.deleted) {
      return `<div class="chat-reply-reference chat-quote dm-reply-missing">${escapeHtml(t('dm.replyUnavailable'))}</div>`;
    }
    const author = this.authorInfo(original.author);
    const preview = original.content.trim() || (original.attachments[0]?.name ?? '');
    return `<button type="button" class="chat-reply-reference chat-quote" data-dm-jump="${escapeHtml(original.id)}" title="${escapeHtml(t('chat.jumpToMessage'))}">
      <strong>${escapeHtml(author.name)}</strong>
      <span>${escapeHtml(preview.length > 140 ? `${preview.slice(0, 140)}…` : preview)}</span>
    </button>`;
  }

  private renderReactions(message: DmMessageView, writable: boolean): string {
    const me = dmStore.snapshot.me?.publicKey;
    return message.reactions.filter((reaction) => reaction.users.length > 0).map((reaction) => {
      const mine = !!me && reaction.users.includes(me);
      const names = reaction.users.map((user) => this.authorInfo(user).name).join(', ');
      const title = t('chat.reactedBy', { emoji: reaction.emoji, users: names });
      return `<button type="button" class="chat-reaction${mine ? ' chat-reaction--mine' : ''}" ${writable ? '' : 'disabled'}
        data-dm-reaction="${escapeHtml(reaction.emoji)}" aria-pressed="${mine}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
        ${escapeHtml(reaction.emoji)} <span>${reaction.users.length}</span></button>`;
    }).join('');
  }

  private renderAttachment(message: DmMessageView, attachment: DmAttachmentView, mine: boolean): string {
    const available = attachment.state === 'local' || attachment.state === 'ready';
    const key = `${message.id}:${attachment.fileId}`;
    const data = `data-dm-message="${escapeHtml(message.id)}" data-dm-file="${escapeHtml(attachment.fileId)}"`;
    if (available && attachment.mime.startsWith('image/')) {
      const src = this.blobUrls.get(key);
      return `
        <div class="chat-inline-media chat-inline-media--image dm-attachment-image" ${data}>
          <img class="chat-attachment-image" ${src ? `src="${src}"` : ''} data-dm-image="${escapeHtml(key)}" alt="${escapeHtml(attachment.name)}" title="${escapeHtml(attachment.name)}">
          <div class="chat-inline-media-actions">
            <button type="button" class="chat-attachment-action" data-dm-open-media title="${escapeHtml(t('chat.openMediaViewer'))}" aria-label="${escapeHtml(t('chat.openMediaViewer'))}">
              <span class="material-symbols-outlined md-18">open_in_full</span>
            </button>
            <button type="button" class="chat-attachment-action" data-dm-save title="${escapeHtml(t('common.download'))}" aria-label="${escapeHtml(t('common.download'))}">
              <span class="material-symbols-outlined md-18">download</span>
            </button>
          </div>
        </div>
      `;
    }
    const kind = attachment.mime.startsWith('image/') ? 'image' : attachment.mime.startsWith('video/') ? 'video' : 'file';
    const percent = attachment.size > 0 ? Math.min(100, Math.round((attachment.receivedBytes / attachment.size) * 100)) : 0;
    const status = this.attachmentStatus(attachment, mine, percent);
    const canRetry = !mine && (attachment.state === 'failed' || attachment.state === 'unavailable');
    return `
      <div class="chat-attachment-file dm-attachment-file dm-attachment-file--${attachment.state}" ${data}>
        <span class="material-symbols-outlined md-24 af-icon" aria-hidden="true">${fileIconName(kind, attachment.mime, attachment.name)}</span>
        <span class="af-meta">
          <span class="af-name" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</span>
          <span class="af-size">${formatBytes(attachment.size)}${status ? ` · ${escapeHtml(status)}` : ''}</span>
          ${attachment.state === 'downloading' ? `<span class="dm-attachment-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width: ${percent}%"></span></span>` : ''}
        </span>
        ${available ? `<button type="button" class="chat-attachment-action" data-dm-save title="${escapeHtml(t('common.download'))}" aria-label="${escapeHtml(t('common.download'))} ${escapeHtml(attachment.name)}">
          <span class="material-symbols-outlined md-20">download</span></button>` : ''}
        ${canRetry ? `<button type="button" class="chat-attachment-action" data-dm-retry title="${escapeHtml(t('common.retry'))}" aria-label="${escapeHtml(t('common.retry'))}">
          <span class="material-symbols-outlined md-20">refresh</span></button>` : ''}
      </div>
    `;
  }

  private attachmentStatus(attachment: DmAttachmentView, mine: boolean, percent: number): string {
    switch (attachment.state) {
      case 'pending':
        return mine ? '' : t('dm.attachmentWaiting', { nickname: this.nickname() });
      case 'downloading':
        return t('dm.attachmentDownloading', { percent });
      case 'unavailable':
        return t('dm.attachmentUnavailable');
      case 'too-large':
        return t('dm.attachmentTooLarge', { size: formatBytes(dmStore.snapshot.settings.maxFileBytes) });
      case 'failed':
        return t('dm.attachmentFailed');
      default:
        return '';
    }
  }

  private loadImages(feed: HTMLElement): void {
    feed.querySelectorAll<HTMLImageElement>('img[data-dm-image]:not([src])').forEach((image) => {
      const key = image.dataset.dmImage!;
      if (this.loadingBlobs.has(key)) return;
      const holder = image.closest<HTMLElement>('[data-dm-file]');
      const messageId = holder?.dataset.dmMessage;
      const fileId = holder?.dataset.dmFile;
      if (!messageId || !fileId) return;
      this.loadingBlobs.add(key);
      void dmStore.readAttachment(this.peer, messageId, fileId).then((blob) => {
        this.loadingBlobs.delete(key);
        if (!blob || !this.container) return;
        const url = URL.createObjectURL(blob);
        this.blobUrls.set(key, url);
        const feedNow = this.query('[data-dm-feed]');
        const nearBottom = feedNow ? feedNow.scrollHeight - feedNow.scrollTop - feedNow.clientHeight < 120 : false;
        this.container.querySelectorAll<HTMLImageElement>(`img[data-dm-image="${CSS.escape(key)}"]`).forEach((target) => {
          target.src = url;
          if (nearBottom && feedNow) target.addEventListener('load', () => { feedNow.scrollTop = feedNow.scrollHeight; }, { once: true });
        });
      });
    });
  }

  private renderTray(): void {
    const tray = this.query('#chat-attachment-tray');
    if (!tray) return;
    if (this.staged.length === 0) {
      setSurfaceVisible(tray, false, 'panel', undefined, () => tray.replaceChildren());
      return;
    }
    tray.innerHTML = this.staged.map((entry) => `
      <div class="tray-item" title="${escapeHtml(entry.file.name)}">
        ${entry.previewUrl ? `<img class="tray-thumb" src="${entry.previewUrl}" alt="">` : '<span class="material-symbols-outlined md-22 tray-thumb-icon">draft</span>'}
        <div class="tray-info">
          <span class="tray-name">${escapeHtml(entry.file.name)}</span>
          <div class="tray-sub"><span class="tray-size">${formatBytes(entry.file.size)}</span></div>
        </div>
        <button type="button" class="tray-remove" data-dm-unstage="${entry.id}" title="${escapeHtml(t('common.remove'))}" aria-label="${escapeHtml(t('common.remove'))}">
          <span class="material-symbols-outlined md-18">close</span>
        </button>
      </div>
    `).join('');
    setSurfaceVisible(tray, this.editing === null, 'panel', 'flex');
  }

  private renderReplyComposer(): void {
    const element = this.query('#chat-reply-composer');
    if (!element) return;
    const original = this.replyTo ? this.message(this.replyTo) : undefined;
    if (!original || this.editing) {
      delete element.dataset.reply;
      setSurfaceVisible(element, false, 'panel', undefined, () => element.replaceChildren());
      return;
    }
    // Deliveries and reactions also refresh the conversation; only a change to the quoted message redraws it.
    const key = `${original.id}:${original.editedAt ?? ''}:${original.deleted}`;
    if (element.dataset.reply === key && !element.hidden && !element.hasAttribute('data-ui-closing')) return;
    element.dataset.reply = key;
    element.innerHTML = `<div class="chat-quote">${renderReplyPreview(this.replyPreview(original))}
      <button type="button" aria-label="${escapeHtml(t('chat.cancelReply'))}" title="${escapeHtml(t('chat.cancelReply'))}"><span class="material-symbols-outlined md-18" aria-hidden="true">close</span></button></div>`;
    element.querySelector('button')?.addEventListener('click', () => {
      this.clearReply();
      this.focusInput();
    });
    setSurfaceVisible(element, true);
  }

  private replyPreview(message: DmMessageView): MessageReply {
    return {
      messageId: message.id,
      userNickname: this.authorInfo(message.author).name,
      content: message.content,
      deleted: message.deleted,
      hasAttachments: message.attachments.length > 0,
      createdAt: message.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    const root = this.container!;
    const signal = this.listeners!.signal;
    const input = this.input();
    const fileInput = this.query<HTMLInputElement>('#chat-file-input');
    const attach = this.query<HTMLButtonElement>('#btn-attach');

    if (input) {
      this.unsubscribers.push(bindChatComposer(root, {
        input,
        isActive: () => this.container === root && root.isConnected,
        pasteFiles: (files) => {
          if (!this.canWrite() || this.editing) return false;
          this.stageFiles([...files]);
          return true;
        },
        focus: () => this.focusInput(),
      }));
    }
    this.unsubscribers.push(this.copy.bind());

    root.addEventListener('click', (event) => this.onClick(event), { signal });
    this.query('[data-dm-feed]')?.addEventListener('contextmenu', (event) => this.onFeedContextMenu(event), { signal });
    this.query('#btn-send-message')?.addEventListener('click', () => void this.submit(), { signal });
    this.query('#btn-cancel-message-edit')?.addEventListener('click', () => {
      this.cancelEdit();
      this.focusInput();
    }, { signal });
    attach?.addEventListener('click', () => {
      if (this.canWrite() && !this.editing) openFileInputPicker(fileInput, attach);
    }, { signal });
    fileInput?.addEventListener('change', () => {
      if (fileInput.files) this.stageFiles([...fileInput.files]);
      fileInput.value = '';
    }, { signal });
    this.query('#btn-emoji')?.addEventListener('click', (event) => this.toggleComposerEmoji(event.currentTarget as HTMLElement), { signal });
    // The formatting bar leaves the code button to its composer: here it opens a code block in the editor.
    this.query('#btn-code')?.addEventListener('click', () => this.insertCodeBlock(), { signal });

    input?.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        if (this.editing) {
          event.preventDefault();
          if (!this.sending) this.cancelEdit();
        } else if (this.replyTo) {
          event.preventDefault();
          this.clearReply();
        }
        return;
      }
      if (event.key === 'ArrowUp' && !this.editing && input.value.length === 0) {
        const lastOwn = [...(dmStore.conversation(this.peer)?.messages ?? [])].reverse()
          .find((message) => message.author === dmStore.snapshot.me?.publicKey && !message.deleted && message.content.trim());
        if (lastOwn) {
          event.preventDefault();
          this.startEdit(lastOwn.id);
        }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
    }, { capture: true, signal });
    input?.addEventListener('input', () => {
      this.updateCounter();
      if (!this.editing && input.value.trim()) dmStore.typing(this.peer);
    }, { signal });

    const feed = this.query('[data-dm-feed]');
    feed?.addEventListener('scroll', () => {
      this.pinnedToBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
      if (feed.scrollTop < 60) void dmStore.loadOlder(this.peer);
    }, { passive: true, signal });

    const chat = this.query('.chat-container');
    let dragDepth = 0;
    root.addEventListener('dragenter', (event) => {
      if (!this.canWrite() || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      chat?.classList.add('chat-drag-over');
    }, { signal });
    root.addEventListener('dragover', (event) => {
      if (!this.canWrite() || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
    }, { signal });
    root.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) chat?.classList.remove('chat-drag-over');
    }, { signal });
    root.addEventListener('drop', (event) => {
      dragDepth = 0;
      chat?.classList.remove('chat-drag-over');
      if (!this.canWrite() || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      this.stageFiles([...event.dataTransfer.files]);
    }, { signal });
  }

  private bindFeed(feed: HTMLElement): void {
    feed.querySelectorAll<HTMLAnchorElement>('a.md-link').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const url = link.getAttribute('data-external-link');
        if (url && !openServerInviteLink(url)) void window.api?.openExternal?.(url);
      });
    });
    // Only rows of this user's own messages carry a delivery state.
    mountServerInviteCards(feed, row => row.hasAttribute('data-delivery'));
    bindCodeBlockCopyButtons(feed);
  }

  /** Right-clicking a message offers the same actions as in a server channel. */
  private onFeedContextMenu(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>('.chat-message-row[data-message-id]');
    const messageId = row?.dataset.messageId;
    if (!row || !messageId) return;
    const image = target?.closest<HTMLImageElement>('img.chat-attachment-image');
    if (image?.src && row.contains(image)) {
      event.preventDefault();
      contextMenu.open(event.clientX, event.clientY, [{
        label: t('chat.copyImage'), icon: 'content_copy',
        onClick: () => { void this.copy.copyImage(image); },
      }, ...this.messageMenuItems(messageId)]);
      return;
    }
    // A selected fragment keeps the native selection behavior, as in server channels.
    if (window.getSelection()?.toString().trim()) return;
    const items = this.messageMenuItems(messageId);
    if (items.length === 0) return;
    event.preventDefault();
    contextMenu.open(event.clientX, event.clientY, items);
  }

  private messageMenuItems(messageId: string): ContextMenuEntry[] {
    const message = this.message(messageId);
    if (!message || message.deleted) return [];
    const writable = this.canWrite();
    const mine = message.author === dmStore.snapshot.me?.publicKey;
    const items: ContextMenuEntry[] = [];
    if (writable) {
      // The toolbar button anchors the picker, exactly as the hover action does.
      items.push({ label: t('chat.emojiAction'), icon: 'add_reaction', onClick: () => this.query<HTMLButtonElement>(
        `.chat-message-row[data-message-id="${CSS.escape(messageId)}"] [data-dm-action="react"]`)?.click() });
      if (!this.editing) items.push({ label: t('chat.replyMessage'), icon: 'reply', onClick: () => this.startReply(messageId) });
    }
    items.push(this.copy.menuItem(messageId));
    if (this.forwardableMessage(message)) {
      items.push({ label: t('chat.forwardMessage'), icon: 'forward', onClick: () => void this.forwardSelected([messageId]) });
    }
    items.push({ label: t('chat.selectMessages'), icon: 'checklist', onClick: () => this.selection.start(messageId) });
    if (writable && mine) items.push({ label: t('chat.editMessage'), icon: 'edit', onClick: () => this.startEdit(messageId) });
    if (mine) {
      items.push({ label: t('chat.deleteMessage'), icon: 'delete', danger: true, onClick: () => void this.confirmDelete(messageId) });
    }
    return items;
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.chat-message-row[data-message-id]');
    const messageId = row?.dataset.messageId;

    if (target.closest('[data-dm-older]')) {
      void dmStore.loadOlder(this.peer);
      return;
    }
    if (target.closest('[data-dm-unblock]')) {
      void this.report(dmStore.unblock(this.peer));
      return;
    }
    const unstage = target.closest<HTMLElement>('[data-dm-unstage]');
    if (unstage) {
      this.unstage(unstage.dataset.dmUnstage!);
      return;
    }
    const jump = target.closest<HTMLElement>('[data-dm-jump]');
    if (jump) {
      const destination = this.container?.querySelector<HTMLElement>(`.chat-message-row[data-message-id="${CSS.escape(jump.dataset.dmJump!)}"]`);
      destination?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      destination?.classList.add('chat-message-highlight');
      window.setTimeout(() => destination?.classList.remove('chat-message-highlight'), 1600);
      return;
    }
    const fileHolder = target.closest<HTMLElement>('[data-dm-file]');
    if (fileHolder && messageId) {
      const fileId = fileHolder.dataset.dmFile!;
      if (target.closest('[data-dm-save]')) {
        event.stopPropagation();
        void this.report(dmStore.saveAttachment(this.peer, messageId, fileId));
        return;
      }
      if (target.closest('[data-dm-retry]')) {
        void this.report(dmStore.retryAttachment(this.peer, messageId, fileId));
        return;
      }
      if (target.closest('[data-dm-open-media]') || target.closest('img[data-dm-image]')) {
        this.openMedia(fileHolder, messageId, fileId);
        return;
      }
    }
    const reaction = target.closest<HTMLButtonElement>('[data-dm-reaction]');
    if (reaction && messageId && !reaction.disabled) {
      const emoji = reaction.dataset.dmReaction!;
      void this.report(dmStore.react(this.peer, messageId, emoji, reaction.getAttribute('aria-pressed') !== 'true'));
      return;
    }
    const action = target.closest<HTMLButtonElement>('[data-dm-action]');
    if (action && messageId) {
      event.stopPropagation();
      switch (action.dataset.dmAction) {
        case 'react':
          this.openReactionPicker(action, messageId);
          break;
        case 'reply':
          this.startReply(messageId);
          break;
        case 'edit':
          this.startEdit(messageId);
          break;
        case 'copy':
          void this.copy.copyMessage(messageId, 'formatted', this.copy.selection(messageId));
          break;
        case 'delete':
          void this.confirmDelete(messageId);
          break;
      }
    }
  }

  private openMedia(holder: HTMLElement, messageId: string, fileId: string): void {
    const image = holder.querySelector<HTMLImageElement>('img[data-dm-image]');
    if (!image?.src) return;
    const message = dmStore.conversation(this.peer)?.messages.find((entry) => entry.id === messageId);
    const attachment = message?.attachments.find((entry) => entry.fileId === fileId);
    lightboxModal.open([{
      kind: 'image',
      url: image.src,
      fileName: attachment?.name ?? 'image',
      senderName: message ? this.authorInfo(message.author).name : '',
      timestamp: message ? formatMessageTime(message.createdAt) : '',
      source: holder,
    }], 0, async () => {
      await this.report(dmStore.saveAttachment(this.peer, messageId, fileId));
    });
  }

  private openReactionPicker(anchor: HTMLElement, messageId: string): void {
    if (this.picker?.isOpenFor(anchor)) {
      this.picker.close();
      return;
    }
    this.picker?.destroy();
    this.picker = new EmojiPicker({
      container: document.body,
      anchor,
      emojiOnly: true,
      floating: true,
      onSelectEmoji: (emoji) => {
        this.picker?.close();
        const message = dmStore.conversation(this.peer)?.messages.find((entry) => entry.id === messageId);
        const me = dmStore.snapshot.me?.publicKey;
        const already = !!me && !!message?.reactions.some((reaction) => reaction.emoji === emoji && reaction.users.includes(me));
        void this.report(dmStore.react(this.peer, messageId, emoji, !already));
      },
    });
    void this.picker.open();
  }

  private toggleComposerEmoji(anchor: HTMLElement): void {
    if (this.composerPicker?.isOpen()) {
      this.composerPicker.close();
      return;
    }
    // Anchored inside the composer like the server picker, not floating over the page.
    const container = this.query('.chat-input-container');
    if (!container) return;
    this.composerPicker?.destroy();
    this.composerPicker = new EmojiPicker({
      container,
      anchor,
      emojiOnly: true,
      onSelectEmoji: (emoji) => {
        const input = this.input();
        if (!input) return;
        input.insertText(emoji);
        input.focus();
      },
    });
    void this.composerPicker.open();
  }

  private insertCodeBlock(): void {
    const input = this.input();
    if (!input || input.readOnly || input.disabled || !this.canWrite()) return;
    const selected = input.value.slice(input.selectionStart, input.selectionEnd);
    input.insertText(`\`\`\`\n${selected}\n\`\`\``);
    input.focus();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private startReply(messageId: string): void {
    if (!this.canWrite()) return;
    this.cancelEdit();
    this.replyTo = messageId;
    this.renderReplyComposer();
    this.focusInput();
  }

  private clearReply(): void {
    if (!this.replyTo) return;
    this.replyTo = null;
    this.renderReplyComposer();
  }

  private startEdit(messageId: string): void {
    const message = this.message(messageId);
    const input = this.input();
    if (!message || !input || !this.canWrite() || message.author !== dmStore.snapshot.me?.publicKey) return;
    if (this.editing === null) this.draft = input.value;
    this.editing = messageId;
    this.replyTo = null;
    this.composerPicker?.close();
    this.renderReplyComposer();
    this.renderTray();
    input.value = message.content;
    input.setSelectionRange(message.content.length, message.content.length);
    this.syncComposer();
    this.focusInput();
  }

  /** Leaving an edit brings back whatever was being typed before it started. */
  private cancelEdit(): void {
    if (!this.editing) return;
    this.editing = null;
    const input = this.input();
    if (input) input.value = this.draft;
    this.draft = '';
    this.renderTray();
    this.syncComposer();
  }

  private async confirmDelete(messageId: string): Promise<void> {
    const confirmed = await showConfirm({
      title: t('dm.deleteConfirmTitle'),
      message: t('dm.deleteConfirm', { nickname: this.nickname() }),
      confirmLabel: t('chat.deleteMessage'),
      variant: 'danger',
    });
    if (confirmed) await this.report(dmStore.deleteMessage(this.peer, messageId));
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  private selectableMessage(messageId: string): DmMessageView | undefined {
    const message = this.message(messageId);
    return message && !message.deleted ? message : undefined;
  }

  private isMine(message: DmMessageView): boolean {
    return message.author === dmStore.snapshot.me?.publicKey;
  }

  /** Files are forwarded as they are, so every one of them must already be on this computer. */
  private forwardableMessage(message: DmMessageView): boolean {
    if (message.deleted) return false;
    if (message.attachments.some((attachment) => attachment.state !== 'ready' && attachment.state !== 'local')) return false;
    return message.content.trim().length > 0 || message.attachments.length > 0;
  }

  private selectedMessages(ids: string[]): DmMessageView[] {
    return ids.flatMap((id) => {
      const message = this.selectableMessage(id);
      return message ? [message] : [];
    });
  }

  private selectionActions(ids: string[]): MessageSelectionAction[] {
    const messages = this.selectedMessages(ids);
    const writable = this.canWrite();
    const files: DownloadableFile[] = messages.flatMap((message) => message.attachments.flatMap((attachment) =>
      attachment.state === 'ready' || attachment.state === 'local'
        ? [{ dm: { peer: this.peer, messageId: message.id, fileId: attachment.fileId }, fileName: attachment.name }] : []));
    return [
      {
        id: 'reply', icon: 'reply', label: t('chat.replyMessage'),
        unavailable: !writable ? t('chat.sendPermissionDenied')
          : this.editing ? t('chat.selectionReplyWhileEditing')
            : messages.length > 1 ? t('dm.selectionReplyOne') : undefined,
        run: () => {
          this.selection.stop();
          if (messages[0]) this.startReply(messages[0].id);
        },
      },
      {
        id: 'forward', icon: 'forward', label: t('chat.forwardAction'),
        unavailable: messages.every((message) => this.forwardableMessage(message)) ? undefined : t('dm.selectionForwardPending'),
        run: () => this.forwardSelected(messages.map((message) => message.id)),
      },
      {
        id: 'copy', icon: 'content_copy', label: t('chat.copyMessage'),
        run: async () => {
          await this.copy.copyMessages(messages.map((message) => ({
            messageId: message.id,
            heading: `${this.authorInfo(message.author).name} — ${formatMessageTime(message.createdAt)}`,
          })));
          this.selection.stop();
        },
      },
      {
        id: 'download', icon: 'download', label: t('common.download'),
        unavailable: files.length ? undefined : t('chat.selectionNoFiles'),
        run: () => downloadFilesWithChoice(files, [this.nickname(), archiveDate()].join(' - ')),
      },
      {
        id: 'delete', icon: 'delete', label: t('chat.deleteMessage'), danger: true,
        unavailable: messages.every((message) => this.isMine(message)) ? undefined : t('chat.selectionDeleteDenied'),
        run: () => this.deleteSelected(messages.map((message) => message.id)),
      },
    ];
  }

  private async forwardSelected(ids: string[]): Promise<void> {
    const messages = this.selectedMessages(ids).filter((message) => this.forwardableMessage(message));
    if (messages.length === 0) return;
    const peer = this.peer;
    const items: ForwardItem[] = messages.map((message) => ({
      content: message.content,
      attachments: message.attachments.map((attachment) => ({
        name: attachment.name, mime: attachment.mime, size: attachment.size,
        load: async () => {
          const blob = await dmStore.readAttachment(peer, message.id, attachment.fileId);
          if (!blob) throw new Error(t('chat.forwardReadFailed'));
          return blob;
        },
      })),
      // A private conversation is never named in the badge.
      sourceLabel: null,
      createdAt: message.createdAt,
    }));
    const destinations = forwardDestinations({ kind: 'dm', peer });
    if (await openForwardModal({ items, ...destinations })) this.selection.stop();
  }

  private async deleteSelected(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const confirmed = await showConfirm({
      title: tCount('chat.deleteMessagesTitle', ids.length),
      message: tCount('chat.deleteMessagesConfirm', ids.length),
      confirmLabel: t('chat.deleteMessage'),
      variant: 'danger',
    });
    if (!confirmed || !this.container) return;
    let failed = 0;
    for (const messageId of ids) {
      if (await dmStore.deleteMessage(this.peer, messageId)) failed++;
    }
    this.selection.stop();
    if (failed > 0) showErrorToast(t('chat.deleteSomeFailed', { failed, total: ids.length }), 7000);
  }

  private stageFiles(files: File[]): void {
    if (!this.canWrite() || this.editing || files.length === 0) return;
    const peer = this.peerView();
    const limit = peer?.maxFileBytes ?? 0;
    for (const file of files) {
      if (this.staged.length >= DM_MAX_ATTACHMENTS) {
        showErrorToast(t('dm.errorTooManyFiles', { count: DM_MAX_ATTACHMENTS }));
        break;
      }
      if (limit > 0 && file.size > limit) {
        showErrorToast(t('dm.errorFileTooLarge', { nickname: this.nickname(), size: formatBytes(limit), name: file.name }), 7000);
        continue;
      }
      this.staged.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      });
    }
    this.renderTray();
    this.focusInput();
  }

  private unstage(id: string): void {
    const index = this.staged.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const [removed] = this.staged.splice(index, 1);
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    this.renderTray();
  }

  private clearStaged(): void {
    if (this.staged.length === 0) return;
    for (const entry of this.staged) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    this.staged = [];
    this.renderTray();
  }

  private async submit(): Promise<void> {
    const input = this.input();
    if (!input || this.sending || !this.canWrite()) return;
    const content = input.value.trim();
    if (this.editing) {
      const messageId = this.editing;
      if (!content) {
        this.cancelEdit();
        await this.confirmDelete(messageId);
        return;
      }
      if (content === this.message(messageId)?.content) {
        this.cancelEdit();
        return;
      }
      this.sending = true;
      this.syncComposer();
      try {
        const failure = await dmStore.editMessage(this.peer, messageId, content);
        if (failure) this.showFailure(failure);
        else if (this.editing === messageId) this.cancelEdit();
      } finally {
        this.sending = false;
        this.syncComposer();
        this.focusInput();
      }
      return;
    }
    if (!content && this.staged.length === 0) return;
    this.sending = true;
    this.syncComposer();
    try {
      const files: DmOutgoingFile[] = [];
      for (const entry of this.staged) {
        files.push({
          name: entry.file.name,
          mime: entry.file.type || 'application/octet-stream',
          data: new Uint8Array(await entry.file.arrayBuffer()),
        });
      }
      const failure = await dmStore.sendMessage(this.peer, content, files, this.replyTo);
      if (failure) {
        this.showFailure(failure);
        return;
      }
      input.value = '';
      this.clearStaged();
      this.clearReply();
      this.pinnedToBottom = true;
    } finally {
      this.sending = false;
      this.syncComposer();
      this.focusInput();
    }
  }

  private async report(operation: Promise<DmFailure | null>): Promise<void> {
    const failure = await operation;
    if (failure) this.showFailure(failure);
  }

  private showFailure(failure: DmFailure): void {
    showErrorToast(dmFailureMessage(failure, this.nickname()), 7000);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private query<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return this.container?.querySelector<T>(selector) ?? null;
  }

  private input(): MarkdownInput | null {
    return this.query<MarkdownInput>('#chat-message-input');
  }

  private message(messageId: string): DmMessageView | undefined {
    return dmStore.conversation(this.peer)?.messages.find((entry) => entry.id === messageId);
  }

  private messageClipboard(messageId: string): MessageClipboardContent | null {
    const message = this.message(messageId);
    if (!message || message.deleted || !this.container) return null;
    return messageClipboardContent(this.container, messageId, message.content, message.attachments.map((entry) => entry.name));
  }

  /** A message without text copies its loaded image, as server channels do. */
  private messageClipboardImage(messageId: string): HTMLImageElement | null {
    const message = this.message(messageId);
    if (!message || message.deleted || message.content.trim()) return null;
    return this.query<HTMLImageElement>(`.chat-message-row[data-message-id="${CSS.escape(messageId)}"] img.chat-attachment-image[src]`);
  }

  private focusInput(): void {
    requestAnimationFrame(() => {
      const input = this.input();
      if (input && this.canWrite()) input.focus();
    });
  }
}
