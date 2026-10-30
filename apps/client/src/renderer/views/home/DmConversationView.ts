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
import { getLanguage, t, tCount } from '../../i18n';
import { dmStore, type DmAttachmentProgressEvent, type DmComposerDraft, type DmConversationState } from '../../stores/dmStore';
import { ownAvatarSource } from '../../core/profileSync';
import { connectionStore } from '../../stores/connectionStore';
import { formatBytes, fileIconName } from '../../utils/attachment';
import { getAvatarUrl } from '../../utils/avatar';
import { openFileInputPicker } from '../../utils/buttonLoading';
import { escapeHtml } from '../../utils/html';
import { renderMarkdown } from '../../utils/markdown';
import type { MessageClipboardContent } from '../../utils/messageClipboard';
import { highlightMessageJump } from '../../utils/messageJumpHighlight';
import { formatMessageClock, formatMessageTime, renderReplyPreview } from '../../utils/messageReply';
import { smoothScrollIntoView } from '../../utils/scroll';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import { animateEnter } from '../../utils/surfaceMotion';
import { renderLoadingSkeleton } from '../../utils/loadingSkeleton';
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

/** How a message row was last drawn, and what besides the message it depended on. */
interface RowRender {
  html: string;
  grouped: boolean;
  reply: string;
  context: string;
}

/** What every row of one render pass shares. */
interface FeedContext {
  signature: string;
  original(messageId: string): DmMessageView | undefined;
}

const OLDER_KEY = 'older';
const INTRO_KEY = 'intro';

function rowKey(messageId: string): string {
  return `message:${messageId}`;
}

function elementFromHtml(html: string): HTMLElement | null {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;
  return element instanceof HTMLElement ? element : null;
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
  /** Whether opening the conversation finished, even without any history. */
  private openSettled = false;
  /** The node on screen for each feed entry (message rows, "load older", the intro). */
  private readonly feedNodes = new Map<string, HTMLElement>();
  /** The markup each node on screen was made from, compared with the next render to leave unchanged rows alone. */
  private readonly nodeSources = new WeakMap<Element, string>();
  private rowRenders = new WeakMap<DmMessageView, RowRender>();
  /** The context signature of the last full pass (see {@link renderSignature}). */
  private renderedSignature: string | null = null;
  private renderFrame: number | null = null;
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
    this.openSettled = false;
    this.container = container;
    this.listeners = new AbortController();
    container.innerHTML = this.renderShell();
    this.bindEvents();
    this.renderHeader();
    this.restoreDraft();
    this.renderComposerState();
    this.renderMessages(true);
    this.unsubscribers.push(
      dmStore.bus.on<{ peer: string }>('messages', (event) => {
        if (event?.peer !== this.peer) return;
        // Deliveries, reactions and receipts arrive in bursts: one pass per frame draws all of them.
        this.scheduleMessages();
        if (this.replyTo) this.renderReplyComposer();
      }),
      dmStore.bus.on<DmAttachmentProgressEvent>('attachment-progress', (event) => {
        if (event?.peer === this.peer) this.applyProgress(event.messageId, event.fileId);
      }),
      dmStore.bus.on<{ peer: string }>('typing', (event) => {
        if (event?.peer === this.peer) this.renderTyping();
      }),
      dmStore.bus.on('changed', () => {
        this.renderHeader();
        this.renderComposerState();
        // Names, avatars and whether the friend can still be written to show in every row.
        this.scheduleMessages();
      }),
      dmStore.bus.on('presence', () => {
        this.renderHeader();
        this.renderComposerState();
      }),
    );
    const peer = this.peer;
    void dmStore.open(peer).finally(() => {
      // A failed load must not leave placeholders up: fall back to the feed.
      if (this.peer !== peer || !this.container) return;
      this.openSettled = true;
      if (!dmStore.conversation(peer)) this.renderMessages(true);
    });
    window.addEventListener('focus', () => void dmStore.markRead(this.peer), { signal: this.listeners.signal });
    this.focusInput();
  }

  public destroy(): void {
    if (!this.container) return;
    this.saveDraft();
    this.selection.stop();
    dmStore.leave(this.peer);
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.listeners?.abort();
    this.listeners = null;
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    this.feedNodes.clear();
    // Drawn rows may point at image URLs revoked below.
    this.rowRenders = new WeakMap();
    this.renderedSignature = null;
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

  /**
   * Puts back what the composer held when this conversation last left the
   * screen (R-CHAT-8). An edit comes back only while its message is still
   * there to be edited; otherwise what was typed before it does.
   */
  private restoreDraft(): void {
    const saved = dmStore.draft(this.peer);
    const input = this.input();
    if (!saved || !input) return;
    this.staged = saved.files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));
    const edited = saved.editing ? this.message(saved.editing.messageId) : undefined;
    if (saved.editing && edited && !edited.deleted && this.isMine(edited)) {
      this.editing = edited.id;
      this.draft = saved.text;
      input.value = saved.editing.content;
    } else {
      this.replyTo = saved.replyTo;
      input.value = saved.text;
    }
    input.setSelectionRange(input.value.length, input.value.length);
    if (this.staged.length > 0) this.renderTray();
    if (this.replyTo) this.renderReplyComposer();
  }

  /** Keeps the composer for when this conversation comes back. What is being sent right now is not a draft. */
  private saveDraft(): void {
    const input = this.input();
    if (!input) return;
    if (this.sending && !this.editing) {
      dmStore.setDraft(this.peer, null);
      return;
    }
    dmStore.setDraft(this.peer, {
      text: this.editing ? this.draft : input.value,
      replyTo: this.editing ? null : this.replyTo,
      files: this.staged.map((entry) => entry.file),
      // An edit already being saved is not kept: it would come back as an edit of what was just saved.
      editing: this.editing && !this.sending ? { messageId: this.editing, content: input.value } : null,
    });
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

  private scheduleMessages(): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderMessages(false);
    });
  }

  /**
   * Brings the feed in line with the conversation, touching only what changed
   * (R-CHAT-4): rows whose markup stays the same are left alone, with the text
   * selected in them, focus, hover and loaded images; new rows go in their
   * place and changed ones are swapped. Redrawing every row for each delivery,
   * reaction, receipt or page of history made long conversations slow and
   * dropped the selection.
   */
  private renderMessages(forceScroll: boolean): void {
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    const feed = this.query('[data-dm-feed]');
    if (!feed) return;
    const state = dmStore.conversation(this.peer);
    // Nothing of this conversation is loaded yet: show message-shaped
    // placeholders instead of a blank feed.
    if (!state && !this.openSettled) {
      if (!feed.querySelector(':scope > .loading-skeleton')) feed.innerHTML = renderLoadingSkeleton('messages', 5);
      this.feedNodes.clear();
      return;
    }
    const replacingSkeleton = !!feed.querySelector(':scope > .loading-skeleton');
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    // A conversation opens at its latest messages.
    const followEnd = forceScroll || replacingSkeleton || (nearBottom && this.pinnedToBottom);
    const anchor = followEnd ? null : this.scrollAnchor(feed);
    const focus = this.focusInFeed(feed);
    if (this.reconcileFeed(feed, state)) {
      this.loadImages(feed);
      this.selection.sync();
      if (focus) this.restoreFocus(focus);
    }
    if (followEnd) feed.scrollTop = feed.scrollHeight;
    else if (anchor) this.keepAnchor(feed, anchor);
    this.renderTyping();
    if (replacingSkeleton) animateEnter(feed, 'view');
  }

  /** Puts every feed entry on screen in order, reusing the nodes whose markup did not change. Returns whether any node changed. */
  private reconcileFeed(feed: HTMLElement, state: DmConversationState | undefined): boolean {
    const messages = state?.messages ?? [];
    const entries: Array<{ key: string; html: string }> = [];
    if (state?.hasMore) {
      entries.push({ key: OLDER_KEY, html: `<button type="button" class="btn btn-secondary dm-load-older" data-dm-older>${t('dm.loadOlder')}</button>` });
    } else if (state) {
      entries.push({ key: INTRO_KEY, html: this.renderIntro() });
    }
    const context = this.feedContext(messages);
    this.renderedSignature = context.signature;
    messages.forEach((message, index) => {
      entries.push({ key: rowKey(message.id), html: this.rowHtml(message, messages[index - 1], context) });
    });

    const placed: Array<[string, HTMLElement]> = [];
    const created: HTMLElement[] = [];
    for (const entry of entries) {
      const current = this.feedNodes.get(entry.key);
      if (current && current.parentElement === feed && this.nodeSources.get(current) === entry.html) {
        placed.push([entry.key, current]);
        continue;
      }
      const node = elementFromHtml(entry.html);
      if (!node) continue;
      this.nodeSources.set(node, entry.html);
      placed.push([entry.key, node]);
      created.push(node);
    }
    const keep = new Set<Node>(placed.map(([, node]) => node));
    let changed = created.length > 0;
    for (const child of [...feed.childNodes]) {
      if (keep.has(child)) continue;
      child.remove();
      changed = true;
    }
    // Nodes already in the right order are never moved: moving one would drop a selection inside it.
    let cursor = feed.firstElementChild;
    for (const [, node] of placed) {
      if (node === cursor) {
        cursor = node.nextElementSibling;
        continue;
      }
      feed.insertBefore(node, cursor);
    }
    this.feedNodes.clear();
    for (const [key, node] of placed) this.feedNodes.set(key, node);
    for (const node of created) {
      if (node.classList.contains('chat-message-row')) this.bindRow(node);
    }
    return changed;
  }

  private feedContext(messages: DmMessageView[]): FeedContext {
    let byId: Map<string, DmMessageView> | null = null;
    return {
      signature: this.renderSignature(),
      original: (messageId) => (byId ??= new Map(messages.map((message) => [message.id, message]))).get(messageId),
    };
  }

  /** Everything besides the messages themselves that rows show: when any of it changes, every row is drawn again. */
  private renderSignature(): string {
    return JSON.stringify([
      getLanguage(),
      this.canWrite(),
      this.nickname(),
      this.peerView()?.avatar ?? null,
      dmStore.snapshot.me?.publicKey ?? null,
      connectionStore.savedNickname,
      ownAvatarSource(),
      dmStore.snapshot.settings.maxFileBytes,
    ]);
  }

  /** The markup of one message row, drawn again only when the message or what its row depends on changed. */
  private rowHtml(message: DmMessageView, previous: DmMessageView | undefined, context: FeedContext): string {
    const grouped = !!previous && previous.author === message.author && !previous.deleted && !message.replyTo &&
      sameLocalDay(previous.createdAt, message.createdAt);
    const reply = message.replyTo && !message.deleted ? this.renderReplyReference(context.original(message.replyTo)) : '';
    const cached = this.rowRenders.get(message);
    if (cached && cached.grouped === grouped && cached.reply === reply && cached.context === context.signature) return cached.html;
    const html = this.renderMessage(message, grouped, reply);
    this.rowRenders.set(message, { html, grouped, reply, context: context.signature });
    return html;
  }

  /** The first message at least partly in view, and where it sits, to keep it there while rows around it change. */
  private scrollAnchor(feed: HTMLElement): { messageId: string; top: number } | null {
    const rows = feed.querySelectorAll<HTMLElement>(':scope > .chat-message-row');
    const top = feed.getBoundingClientRect().top;
    let low = 0;
    let high = rows.length - 1;
    let found: HTMLElement | null = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (rows[middle].getBoundingClientRect().bottom > top) {
        found = rows[middle];
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    const messageId = found?.dataset.messageId;
    return found && messageId ? { messageId, top: found.getBoundingClientRect().top } : null;
  }

  /** Exact restoration of what was on screen, not a navigation: instant on purpose. */
  private keepAnchor(feed: HTMLElement, anchor: { messageId: string; top: number }): void {
    const row = this.feedNodes.get(rowKey(anchor.messageId));
    if (!row?.isConnected) return;
    const shift = row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) >= 1) feed.scrollTop += shift;
  }

  /** Where keyboard focus is inside the feed, to bring it back if its row is redrawn. */
  private focusInFeed(feed: HTMLElement): { messageId: string; control: string | null } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !feed.contains(active)) return null;
    const row = active.closest<HTMLElement>('.chat-message-row[data-message-id]');
    const messageId = row?.dataset.messageId;
    if (!row || !messageId) return null;
    let control: string | null = null;
    if (active.dataset.dmAction) control = `[data-dm-action="${CSS.escape(active.dataset.dmAction)}"]`;
    else if (active.dataset.dmReaction) control = `[data-dm-reaction="${CSS.escape(active.dataset.dmReaction)}"]`;
    return { messageId, control };
  }

  private restoreFocus(focus: { messageId: string; control: string | null }): void {
    // Still where it was: its row was not redrawn.
    if (document.activeElement && document.activeElement !== document.body) return;
    const row = this.feedNodes.get(rowKey(focus.messageId));
    if (!row?.isConnected) return;
    const target = (focus.control ? row.querySelector<HTMLElement>(focus.control) : null) ?? row;
    target.focus({ preventScroll: true });
  }

  /**
   * A download moved on: only its file card changes, so the rest of the row
   * keeps its selection and hover. When a full pass is due anyway (one is on
   * its way, or names or permissions changed since the last one), that pass
   * draws the progress together with everything else.
   */
  private applyProgress(messageId: string, fileId: string): void {
    if (this.renderFrame !== null) return;
    const feed = this.query('[data-dm-feed]');
    const row = this.feedNodes.get(rowKey(messageId));
    const messages = dmStore.conversation(this.peer)?.messages;
    if (!feed || !row || row.parentElement !== feed || !messages) return;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const context = this.feedContext(messages);
    const html = context.signature === this.renderedSignature
      ? this.rowHtml(messages[index], messages[index - 1], context) : null;
    const selector = `[data-dm-file="${CSS.escape(fileId)}"]`;
    const card = row.querySelector(selector);
    const fresh = html ? elementFromHtml(html)?.querySelector(selector) : null;
    if (!html || !card || !fresh) {
      this.scheduleMessages();
      return;
    }
    card.replaceWith(fresh);
    this.nodeSources.set(row, html);
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

  private renderMessage(message: DmMessageView, grouped: boolean, replyReference: string): string {
    const author = this.authorInfo(message.author);
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
          ${replyReference}
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

  private renderReplyReference(original: DmMessageView | undefined): string {
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

  /** Wires what a newly drawn row holds: links, server invitations and code blocks. */
  private bindRow(row: HTMLElement): void {
    row.querySelectorAll<HTMLAnchorElement>('a.md-link').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const url = link.getAttribute('data-external-link');
        if (url && !openServerInviteLink(url)) void window.api?.openExternal?.(url);
      });
    });
    // Only rows of this user's own messages carry a delivery state.
    mountServerInviteCards(row, (element) => element.hasAttribute('data-delivery'));
    bindCodeBlockCopyButtons(row);
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
      this.jumpToMessage(jump.dataset.dmJump!);
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

  /**
   * Brings the message a reply quotes into view and marks it, as server
   * channels do (R-CHAT-12): the scroll follows "reduce motion", the mark
   * shows which row it is, and focus moves there for the keyboard.
   */
  private jumpToMessage(messageId: string): void {
    const row = this.feedNodes.get(rowKey(messageId));
    if (!row?.isConnected) return;
    // The scroll is on its way: the next update must not pull the feed back to the end.
    this.pinnedToBottom = false;
    smoothScrollIntoView(row, { block: 'center' });
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
    highlightMessageJump(row);
  }

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
      const root = this.container;
      try {
        const failure = await dmStore.editMessage(this.peer, messageId, content);
        if (failure) this.showFailure(failure);
        else if (this.editing === messageId) this.cancelEdit();
      } finally {
        if (this.container === root) {
          this.sending = false;
          this.syncComposer();
          this.focusInput();
        }
      }
      return;
    }
    if (!content && this.staged.length === 0) return;
    const root = this.container;
    const peer = this.peer;
    const outgoing: DmComposerDraft = {
      text: input.value,
      replyTo: this.replyTo,
      files: this.staged.map((entry) => entry.file),
      editing: null,
    };
    this.sending = true;
    this.syncComposer();
    try {
      const files: DmOutgoingFile[] = [];
      for (const file of outgoing.files) {
        let data: ArrayBuffer;
        try {
          data = await file.arrayBuffer();
        } catch {
          // A file picked a while ago (it may have waited in a draft) can be moved or deleted since.
          showErrorToast(t('dm.errorFileUnreadable', { name: file.name }), 7000);
          return;
        }
        files.push({ name: file.name, mime: file.type || 'application/octet-stream', data: new Uint8Array(data) });
      }
      const failure = await dmStore.sendMessage(peer, content, files, outgoing.replyTo);
      if (failure) {
        this.showFailure(failure);
        // The conversation was left while this was being sent: it waits there as the draft instead.
        if (this.container !== root && !dmStore.draft(peer)) dmStore.setDraft(peer, outgoing);
        return;
      }
      if (this.container !== root) return;
      input.value = '';
      this.clearStaged();
      this.clearReply();
      this.pinnedToBottom = true;
    } finally {
      if (this.container === root) {
        this.sending = false;
        this.syncComposer();
        this.focusInput();
      }
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
