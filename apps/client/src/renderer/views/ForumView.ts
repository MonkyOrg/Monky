import { LIMITS, MessageType, Permission, ProtocolErrorCode, type AttachmentMeta, type ForumListResult, type ForumPost, type ForumPostSaved } from '@monky/shared';
import { ProtocolRequestError, type NetworkClient } from '../core/NetworkClient';
import { accessSignature, type ServerStore } from '../stores/serverStore';
import { t, getLanguage } from '../i18n';
import { escapeHtml, html } from '../utils/html';
import { openCommunityModal } from './CommunityModal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { uploadAttachment, type UploadHandle } from '../core/AttachmentUploader';
import { contextMenu, type ContextMenuEntry } from './ContextMenu';
import { cancelVisibilityMotion, setSurfaceVisible } from '../utils/surfaceVisibility';
import { showConfirm } from './Dialog';
import { fileIconName, formatBytes, resolveAttachmentUrl } from '../utils/attachment';
import { imageCarouselNavigationButton, moveImageCarousel } from './ImageCarousel';
import { showErrorToast } from './CopyToast';
import { useAppValidation } from '../utils/feedback';
import { openFileInputPicker } from '../utils/buttonLoading';

interface ForumAttachmentSelection {
  id: string;
  file: File;
  kind: 'media' | 'file';
  previewUrl?: string;
}

/** A count or limit the server reported, or 0 when it is not a whole, non-negative number. */
function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A post as the server lists it; dates must be real so the list can show them. */
function isForumPost(value: unknown): value is ForumPost {
  return isRecord(value) && typeof value.channelId === 'string' && typeof value.forumId === 'string'
    && typeof value.title === 'string' && typeof value.authorId === 'string' && typeof value.preview === 'string'
    && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt)
    && typeof value.pinned === 'boolean' && typeof value.locked === 'boolean' && typeof value.closed === 'boolean';
}

/** Events where the forum may read something else; the server sends the role list whenever anyone logs in. */
const ACCESS_EVENTS = [MessageType.CHANNEL_DELETED, MessageType.CHANNEL_UPDATED, MessageType.CATEGORIES_UPDATED, MessageType.ROLES_LIST]
  .map(type => `message.${type}`);

/** The channel a message, reaction or channel event is about. */
function eventChannelId(event: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const source = event === `message.${MessageType.CHAT_MESSAGE_UPDATED}` ? payload.message
    : event === `message.${MessageType.CHANNEL_UPDATED}` ? payload.channel
      : [MessageType.CHAT_MESSAGE, MessageType.CHAT_REACTION_ADDED, MessageType.CHAT_REACTION_REMOVED, MessageType.CHANNEL_DELETED]
        .some(type => event === `message.${type}`) ? payload : null;
  if (!isRecord(source)) return null;
  const id = event === `message.${MessageType.CHANNEL_UPDATED}` ? source.id : source.channelId;
  return typeof id === 'string' ? id : null;
}

export class ForumView {
  /** The most pages a refresh asks for, however many are on screen. */
  private static readonly REFRESH_PAGES = 3;
  /**
   * A refresh waits this long per request of the previous one, from its last request.
   * With at most 3 requests each, refreshes then make at most 10 requests in any 10 s:
   * the server allows each person 30, all devices together, to list, post and edit.
   */
  private static readonly REFRESH_SPACING_MS = 1250;
  /** The server's forum request window: what it turned away is asked again after it. */
  private static readonly REFRESH_RETRY_MS = 10_000;
  /** A page that failed waits this long to be asked again, twice as long at each failure in a row. */
  private static readonly APPEND_RETRY_MS = 2_000;
  private static readonly APPEND_RETRY_MAX_MS = 30_000;
  private readonly lifetime = new AbortController();
  private readonly unbind: () => void;
  private readonly modals = new Set<(immediate?: boolean) => void>();
  private posts: ForumPost[] = [];
  private query = '';
  private sort: 'latest' | 'newest' | 'oldest' = 'latest';
  private generation = 0;
  private next = 0;
  /** Pages of posts on screen, and how many posts the server puts in a full one. */
  private pages = 0;
  private pageSize = 0;
  private more = false;
  private disposed = false;
  private loaded = false;
  private loading: 'initial' | 'refresh' | 'append' | null = null;
  private lazyObserver: IntersectionObserver | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the timer will load: a new list never turns into a refresh of the old one. */
  private pendingLoad: 'replace' | 'refresh' | null = null;
  /** Activity during a load: a refresh follows it. */
  private refreshAgain = false;
  /** The reader is past the pages a refresh would keep: it waits until they are back. */
  private refreshDeferred = false;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private lastRefreshCost = 0;
  /** Posts on screen that moved down or out of the server's list, each moving the ones after it up a place. */
  private shifts = 0;
  /**
   * Posts on screen that lost their newest message, with `shifts` as of the last time. The time
   * they show is no longer theirs, so any message deleted in them next may be the newest one.
   * Only a list read that began afterwards shows their time again: a save may carry an older copy.
   */
  private readonly staleTimes = new Map<string, number>();
  /** Set while the list asks for no further page, because the last one failed. */
  private appendPause: ReturnType<typeof setTimeout> | undefined;
  private appendFailures = 0;
  /** Search and order of the posts on screen. */
  private shownList = '';
  private composerClose: ((immediate?: boolean) => void) | null = null;
  /** Access and forum settings the listed posts were loaded under. */
  private access: string;

  constructor(private readonly root: HTMLElement, private readonly client: NetworkClient, private readonly server: ServerStore,
    readonly channelId: string, private readonly openPost: (id: string) => void, headerHost?: HTMLElement) {
    this.access = this.accessKey();
    root.innerHTML = `<section class="forum-view"><header class="content-header">
      <h2><span class="material-symbols-outlined md-20">forum</span>${escapeHtml(server.getChannel(channelId)?.name ?? t('forum.title'))}</h2></header>
      <div class="forum-list-content"><div class="forum-create-shell"><div class="forum-create-bar">
        <span class="material-symbols-outlined md-20 forum-create-search-icon">search</span>
        <input type="search" data-forum-search maxlength="200" aria-label="${t('forum.search')}" placeholder="${t('forum.searchOrCreate')}">
        <button type="button" class="btn btn-primary" data-forum-create><span class="material-symbols-outlined md-18">chat_bubble</span><span>${t('forum.newPost')}</span></button></div>
        <div class="forum-create-shortcut"><kbd>Shift</kbd><span>+</span><kbd>Enter</kbd><span>${t('forum.createShortcut')}</span></div>
      </div>
      <div data-forum-composer hidden></div><div class="forum-filters">
        <span class="material-symbols-outlined md-18" aria-hidden="true">sort</span>
        <select class="input-field" data-forum-sort aria-label="${t('forum.order')}">
          ${(['latest', 'newest', 'oldest'] as const).map(value => `<option value="${value}">${t(`forum.${value}`)}</option>`).join('')}
        </select></div>
      <div class="forum-posts" data-forum-posts></div>
      <div class="forum-thread-skeletons" data-forum-loading role="status" aria-label="${t('common.loading')}" hidden>
        ${Array.from({ length: 3 }, () => `<article class="forum-thread-skeleton" aria-hidden="true">
          <span class="skeleton forum-thread-skeleton-line forum-thread-skeleton-line--author"></span>
          <span class="skeleton forum-thread-skeleton-line forum-thread-skeleton-line--title"></span>
          <span class="skeleton forum-thread-skeleton-line forum-thread-skeleton-line--preview"></span>
          <span class="skeleton forum-thread-skeleton-line forum-thread-skeleton-line--meta"></span>
        </article>`).join('')}
      </div>
      <div class="forum-lazy-sentinel" data-forum-sentinel aria-hidden="true" hidden></div></div></section>`;
    const header = root.querySelector<HTMLElement>('.content-header');
    if (headerHost && header) headerHost.replaceChildren(header);
    root.addEventListener('click', this.click, { signal: this.lifetime.signal });
    root.addEventListener('contextmenu', event => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-forum-id]') : null;
      const post = this.posts.find(post => post.channelId === row?.dataset.forumId);
      if (!row || !post) return;
      event.preventDefault();
      this.openPostMenu(post, row, event.clientX, event.clientY);
    }, { signal: this.lifetime.signal });
    root.querySelector<HTMLInputElement>('[data-forum-search]')?.addEventListener('input', event => {
      if (!(event.target instanceof HTMLInputElement)) return;
      this.query = event.target.value;
      this.scheduleLoad('replace', 300);
    }, { signal: this.lifetime.signal });
    root.querySelector<HTMLInputElement>('[data-forum-search]')?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !event.shiftKey || !this.server.hasPermission(Permission.SEND_MESSAGES, this.channelId)) return;
      event.preventDefault();
      this.edit(undefined, true);
    }, { signal: this.lifetime.signal });
    root.querySelector<HTMLSelectElement>('[data-forum-sort]')?.addEventListener('change', event => {
      if (!(event.target instanceof HTMLSelectElement)) return;
      const value = event.target.value;
      if (value === 'latest' || value === 'newest' || value === 'oldest') { this.sort = value; void this.load('replace', true); }
    }, { signal: this.lifetime.signal });
    const scroller = root.querySelector<HTMLElement>('.forum-list-content');
    const sentinel = root.querySelector<HTMLElement>('[data-forum-sentinel]');
    if (scroller && sentinel) {
      this.lazyObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && this.more && !this.loading) void this.load('append');
      }, { root: scroller, rootMargin: '0px 0px 360px' });
      this.lazyObserver.observe(sentinel);
    }
    scroller?.addEventListener('scroll', () => {
      if (!this.refreshDeferred || this.readsPastRefresh()) return;
      this.refreshDeferred = false;
      this.scheduleLoad('refresh', 0);
    }, { passive: true, signal: this.lifetime.signal });
    this.unbind = client.onEvent((event, payload) => {
      if (event === 'network.status' && payload !== 'CONNECTED') { this.destroy(); root.replaceChildren(); return; }
      if (ACCESS_EVENTS.includes(event)) {
        const access = this.accessKey();
        if (access !== this.access) {
          // Lost or gained access to this forum, or the forum itself changed: answers to
          // requests sent before are discarded, along with the shown list and its modals.
          this.access = access;
          this.generation++;
          this.loaded = false;
          this.loading = null;
          this.next = 0;
          this.pages = 0;
          this.refreshDeferred = false;
          this.more = false;
          this.posts = [];
          this.staleTimes.clear();
          this.shownList = '';
          this.renderPosts();
          this.syncLazyState();
          for (const close of [...this.modals]) close(true);
          if (server.getChannel(channelId) && server.hasPermission(Permission.READ_MESSAGES, channelId)) this.scheduleLoad('replace', 250);
          return;
        }
      }
      // Only activity in this forum's posts changes the list; the rest of the server does not.
      if (event === `message.${MessageType.FORUM_POST_SAVED}`) {
        if (!isRecord(payload) || !isForumPost(payload.post) || payload.post.forumId !== channelId) return;
        this.applySavedPost(payload.post, payload.deleted === true);
      } else {
        const post = eventChannelId(event, payload);
        if (!post || !this.isPost(post)) return;
        if (event === `message.${MessageType.CHANNEL_DELETED}`) this.removePost(post);
        else if (event === `message.${MessageType.CHAT_MESSAGE_UPDATED}` && this.lostNewestMessage(post, payload)) {
          this.shiftUp();
          this.staleTimes.set(post, this.shifts);
        }
      }
      this.scheduleLoad('refresh', 250);
    });
    void this.load();
  }

  private accessKey(): string {
    // Posts follow the forum's permissions, so channels elsewhere never change what it lists.
    return JSON.stringify([accessSignature(this.server, [this.channelId]), this.server.getChannel(this.channelId) ?? null]);
  }

  private isPost(channelId: string): boolean {
    return this.posts.some(post => post.channelId === channelId) || this.server.getChannel(channelId)?.forumId === this.channelId;
  }

  /** A saved post updates its card at once; new posts arrive with the refresh. */
  private applySavedPost(post: ForumPost, deleted: boolean): void {
    if (deleted) { this.removePost(post.channelId); return; }
    const index = this.posts.findIndex(shown => shown.channelId === post.channelId);
    if (index >= 0) {
      if (this.movesDown(this.posts[index], post)) this.shiftUp();
      this.posts[index] = post;
      this.renderPosts();
    } else if (!this.more && this.loaded) {
      // Ordered oldest first, a new post lands after everything already loaded.
      this.more = true;
      this.syncLazyState();
    }
  }

  private removePost(channelId: string): void {
    const index = this.posts.findIndex(post => post.channelId === channelId);
    if (index < 0) return;
    this.posts.splice(index, 1);
    this.shiftUp();
    this.renderPosts();
  }

  /**
   * A post on screen moved down or out of the server's list, so the posts after it moved
   * up a place: the next page starts one earlier. When the post is still within the pages
   * shown, that page begins with a post already listed, which the list leaves out.
   */
  private shiftUp(): void {
    this.next = Math.max(0, this.next - 1);
    this.shifts++;
  }

  /** Whether a post on screen may now be lower in the server's list, or out of it. */
  private movesDown(shown: ForumPost, saved: ForumPost): boolean {
    return shown.pinned && !saved.pinned
      || this.sort === 'latest' && saved.updatedAt < shown.updatedAt
      // A new title may no longer match the search.
      || !!this.query.trim() && saved.title !== shown.title;
  }

  /**
   * In the latest order, a post on screen moves down when its newest message is deleted. The time
   * it shows is then no longer its own, so any message deleted in it next may be the newest one.
   */
  private lostNewestMessage(channelId: string, payload: unknown): boolean {
    const shown = this.posts.find(post => post.channelId === channelId);
    const message = isRecord(payload) && isRecord(payload.message) ? payload.message : null;
    return this.sort === 'latest' && !!shown && !!message?.deletedAt && (this.staleTimes.has(channelId)
      || typeof message.createdAt === 'number' && message.createdAt >= shown.updatedAt);
  }

  private scheduleLoad(mode: 'replace' | 'refresh', delay: number): void {
    if (mode === 'refresh') {
      // A load waiting or on its way shows this change too. Restarting the wait would
      // put the refresh off for as long as the forum stays busy.
      if (this.pendingLoad) return;
      if (this.loading) { this.refreshAgain = true; return; }
      if (this.deferRefresh()) return;
    }
    this.pendingLoad = mode;
    const wait = mode === 'refresh'
      ? Math.max(delay, this.lastRefreshAt + this.lastRefreshCost * ForumView.REFRESH_SPACING_MS - performance.now())
      : delay;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const pending = this.pendingLoad ?? 'refresh';
      this.pendingLoad = null;
      // A page the reader asked for meanwhile arrives first.
      if (pending === 'refresh' && this.loading) { this.refreshAgain = true; return; }
      void this.load(pending);
    }, wait);
  }

  /**
   * A refresh keeps only the pages it reloads: past them the next page starts where
   * the server's list is now, so no post is skipped or listed twice. Dropping posts
   * the reader is looking at would pull the list from under them, so then the
   * refresh waits for them to scroll back.
   */
  private deferRefresh(): boolean {
    this.refreshDeferred = this.readsPastRefresh();
    return this.refreshDeferred;
  }

  private readsPastRefresh(): boolean {
    if (this.pages <= ForumView.REFRESH_PAGES || !this.pageSize) return false;
    const scroller = this.root.querySelector<HTMLElement>('.forum-list-content');
    const dropped = this.root.querySelector<HTMLElement>('[data-forum-posts]')?.children[ForumView.REFRESH_PAGES * this.pageSize];
    return !!scroller && !!dropped && dropped.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom;
  }

  /**
   * `replace` shows the first page of a new list; `append` adds the next page;
   * `refresh` reloads the pages on screen, up to `REFRESH_PAGES`. Activity in a post
   * never sends the reader back to the top, and a post that moved, even out of the pages
   * shown, never makes the next page skip another one.
   */
  private async load(mode: 'replace' | 'refresh' | 'append' = 'replace', animateReorder = false): Promise<void> {
    const append = mode === 'append';
    if (this.disposed || (append && (this.loading || !this.more || this.appendPause))) return;
    if (mode === 'replace') {
      clearTimeout(this.refreshTimer);
      this.pendingLoad = null;
    }
    if (!this.server.hasPermission(Permission.READ_MESSAGES, this.channelId)) {
      this.renderPosts();
      return;
    }
    const { query, sort } = this;
    const list = JSON.stringify([query, sort]);
    // Another search or order starts from its first page.
    const sameList = mode === 'refresh' && list === this.shownList;
    if (sameList && this.deferRefresh()) return;
    const pagesToLoad = sameList ? Math.min(Math.max(1, this.pages), ForumView.REFRESH_PAGES) : 1;
    const generation = ++this.generation;
    const shifts = this.shifts;
    this.loading = append ? 'append' : this.loaded ? 'refresh' : 'initial';
    this.syncLazyState();
    let retry = false;
    try {
      const posts = append ? [...this.posts] : [];
      let offset = append ? this.next : 0;
      let fetched = 0;
      let response: ForumListResult;
      do {
        if (mode === 'refresh') {
          this.lastRefreshAt = performance.now();
          this.lastRefreshCost = fetched + 1;
        }
        response = await this.client.sendRequest<ForumListResult>(MessageType.FORUM_LIST, {
          channelId: this.channelId, query, sort, offset,
        });
        if (this.disposed || generation !== this.generation) return;
        if (response.hasMore) this.pageSize = response.posts.length;
        posts.push(...response.posts);
        offset = response.nextOffset;
        fetched++;
      } while (response.hasMore && fetched < pagesToLoad);
      // The reader scrolled past the pages kept while they loaded.
      if (sameList && fetched < this.pages && this.deferRefresh()) return;
      // A post above this page moved down or out while it was read, so the page may start a
      // post late: it is asked for again where the following posts are now.
      if (append && shifts !== this.shifts) return;
      this.posts = [...new Map(posts.map(post => [post.channelId, post])).values()];
      // A read that began after a post lost its newest message shows its time again; an
      // append, only for the posts on its page.
      const read = new Set(response.posts.map(post => post.channelId));
      for (const [id, counted] of this.staleTimes) if (counted <= shifts && (!append || read.has(id))) this.staleTimes.delete(id);
      // These pages may have been read before posts moved down or out: the next page then
      // starts that many places earlier.
      this.next = Math.max(0, response.nextOffset - (this.shifts - shifts));
      this.more = response.hasMore;
      this.pages = append ? this.pages + 1 : fetched;
      this.appendFailures = 0;
      if (!append) this.refreshDeferred = false;
      this.shownList = list;
      this.loaded = true;
      this.renderPosts(animateReorder);
    } catch (failure) {
      if (this.disposed || generation !== this.generation) return;
      console.warn('[Forum] Could not load posts.', failure);
      const rateLimited = failure instanceof ProtocolRequestError && failure.code === ProtocolErrorCode.RATE_LIMITED;
      // A refresh runs on its own: one the server turns away for now is tried again
      // once its window has passed, without interrupting the reader.
      retry = mode === 'refresh' && rateLimited;
      if (!retry) showErrorToast(failure instanceof Error ? failure.message : t('community.actionFailed'));
      // Asked again right away, the next page would fail the same way at every frame the
      // list is at its end. It waits instead: the server's window when it said so, which
      // a turned-away refresh also spent, or longer at each failure in a row.
      if (append) this.appendFailures++;
      if (append || rateLimited) {
        this.pauseAppends(rateLimited ? ForumView.REFRESH_RETRY_MS
          : Math.min(ForumView.APPEND_RETRY_MAX_MS, ForumView.APPEND_RETRY_MS * 2 ** (this.appendFailures - 1)));
      }
    } finally {
      if (!this.disposed && generation === this.generation) {
        this.loading = null;
        this.syncLazyState();
        if (retry || this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleLoad('refresh', retry ? ForumView.REFRESH_RETRY_MS : 250);
        }
      }
    }
  }

  /** The list asks for no further page for a while, then looks again whether the reader is at its end. */
  private pauseAppends(ms: number): void {
    clearTimeout(this.appendPause);
    this.appendPause = setTimeout(() => {
      this.appendPause = undefined;
      this.syncLazyState();
    }, ms);
  }

  private syncLazyState(): void {
    const container = this.root.querySelector<HTMLElement>('[data-forum-posts]');
    const loading = this.root.querySelector<HTMLElement>('[data-forum-loading]');
    const sentinel = this.root.querySelector<HTMLElement>('[data-forum-sentinel]');
    container?.setAttribute('aria-busy', String(this.loading !== null));
    const empty = container?.querySelector<HTMLElement>('.forum-empty-state');
    if (empty) empty.hidden = this.loading === 'initial';
    if (loading) loading.hidden = this.loading !== 'initial' && this.loading !== 'append';
    if (sentinel) {
      const hidden = this.loading !== null || !this.more || this.appendPause !== undefined;
      const revealed = sentinel.hidden && !hidden;
      sentinel.hidden = hidden;
      // Intersection changes are sampled per rendering frame. A page can load within one frame,
      // so restart observation to re-evaluate a sentinel that is still within range.
      if (revealed && this.lazyObserver) {
        this.lazyObserver.unobserve(sentinel);
        this.lazyObserver.observe(sentinel);
      }
    }
  }

  private renderPosts(animateReorder = false): void {
    const container = this.root.querySelector('[data-forum-posts]');
    if (!container) return;
    if (!this.server.hasPermission(Permission.READ_MESSAGES, this.channelId)) {
      container.innerHTML = `<div class="forum-empty-state" role="status">
          <span class="material-symbols-outlined forum-empty-icon" aria-hidden="true">lock</span>
          <strong>${t('channelPermissions.readDeniedTitle')}</strong>
          <p>${t('channelPermissions.readDenied')}</p>
        </div>`;
      return;
    }
    const reorderMotion = animateReorder && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const previous = reorderMotion
      ? new Map([...container.querySelectorAll<HTMLElement>('[data-forum-id]')]
        .map(row => [row.dataset.forumId, row.getBoundingClientRect()] as const))
      : new Map<string | undefined, DOMRect>();
    container.innerHTML = this.posts.length ? this.posts.map(post => {
      // Everything here comes from the server: counters only ever render as whole numbers, the rest as text.
      const replies = wholeNumber(post.replyCount);
      const reactions = wholeNumber(post.reactionCount);
      const author = this.server.knownMembers.get(post.authorId)?.nickname;
      const thumbnail = resolveAttachmentUrl(post.thumbnailUrl, this.client.getHttpBaseUrl());
      return html`<article class="forum-post-row" data-forum-id="${post.channelId}">
        <button type="button" class="forum-post-open" data-forum-open>
          <span class="forum-post-summary">
          ${author ? html`<small class="forum-post-author">${author}</small>` : ''}
          <h3>${post.pinned ? html`<span class="material-symbols-outlined md-16" aria-label="${t('forum.pinned')}">keep</span>` : ''}${post.title}</h3>
          <p>${post.preview}</p><small class="forum-post-stats">
            <span title="${t('forum.replies', { count: replies })}"><span class="material-symbols-outlined md-16">chat_bubble</span>${replies}</span>
            <span title="${t('forum.reactions', { count: reactions })}"><span class="material-symbols-outlined md-16">add_reaction</span>${reactions}</span>
            <time datetime="${new Date(post.updatedAt).toISOString()}">${new Date(post.updatedAt).toLocaleString(getLanguage())}</time>
            ${post.locked ? html`<span class="forum-post-state"><span class="material-symbols-outlined md-14">lock</span>${t('forum.locked')}</span>` : ''}
            ${post.closed ? html`<span class="forum-post-state"><span class="material-symbols-outlined md-14">check_circle</span>${t('forum.closed')}</span>` : ''}</small></span>
          ${thumbnail ? html`<img class="forum-post-thumbnail" src="${thumbnail}" alt="">` : ''}
        </button>
        <button type="button" class="forum-post-menu" data-forum-menu aria-label="${t('common.moreOptions')}"><span class="material-symbols-outlined md-18">more_horiz</span></button>
        </article>`;
    }).join('') : this.query
      ? `<div class="forum-empty-state forum-empty-state--search"><span class="material-symbols-outlined">search_off</span><p>${t('forum.noResults')}</p></div>`
      // The channel name comes from whoever may manage channels, so it only ever lands as text.
      : html`<div class="forum-empty-state"><span class="material-symbols-outlined forum-empty-icon">forum</span>
          <strong>${t('forum.emptyTitle')}</strong>
          <p>${t('forum.emptyDescription', { channel: this.server.getChannel(this.channelId)?.name ?? t('forum.title') })}</p>
        </div>`.toString();
    if (reorderMotion) {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-forum-id]')];
      for (const [index, row] of rows.entries()) {
        const before = previous.get(row.dataset.forumId);
        if (!before) {
          const animation = row.animate([
            { opacity: 0, translate: '0 10px' },
            { opacity: 1, translate: '0 0' },
          ], {
            duration: 220,
            delay: Math.min(index, 8) * 18,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
            fill: 'backwards',
          });
          animation.id = 'forum-thread-reorder-enter';
          continue;
        }
        const after = row.getBoundingClientRect();
        const x = before.left - after.left;
        const y = before.top - after.top;
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
        const animation = row.animate([
          { translate: `${x}px ${y}px` },
          { translate: '0 0' },
        ], { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
        animation.id = 'forum-thread-reorder';
      }
    }
    const create = this.root.querySelector<HTMLButtonElement>('[data-forum-create]');
    if (create) create.disabled = !this.server.hasPermission(Permission.SEND_MESSAGES, this.channelId);
  }

  private click = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button) return;
    if (button.hasAttribute('data-forum-create')) { this.edit(); return; }
    const id = button.closest<HTMLElement>('[data-forum-id]')?.dataset.forumId;
    const post = this.posts.find(item => item.channelId === id);
    if (!post) return;
    if (button.hasAttribute('data-forum-open')) { this.openPost(post.channelId); return; }
    if (button.hasAttribute('data-forum-menu')) {
      const rect = button.getBoundingClientRect();
      this.openPostMenu(post, button, rect.left, rect.bottom);
    }
  };

  private openPostMenu(post: ForumPost, anchor: HTMLElement, x: number, y: number): void {
    const items: ContextMenuEntry[] = [{ label: t('community.open'), icon: 'forum', onClick: () => this.openPost(post.channelId) }];
    const manager = this.server.hasPermission(Permission.MANAGE_CHANNELS);
    if (manager || post.authorId === this.server.currentUser?.id) items.push({
      label: t('forum.rename'), icon: 'edit', onClick: () => this.rename(post),
    });
    const update = (change: { pinned?: boolean; locked?: boolean; closed?: boolean }) => {
      void this.client.sendRequest(MessageType.FORUM_UPDATE_POST, { channelId: post.channelId, ...change }).catch((error: unknown) => {
        console.warn('[Forum] Could not update post.', error);
        showErrorToast(error instanceof Error ? error.message : t('community.actionFailed'));
      });
    };
    if (manager) items.push(
      { label: t(post.pinned ? 'forum.unpin' : 'forum.pin'), icon: 'keep', onClick: () => update({ pinned: !post.pinned }) },
      { label: t(post.locked ? 'forum.unlock' : 'forum.lock'), icon: 'lock', onClick: () => update({ locked: !post.locked }) },
    );
    const author = post.authorId === this.server.currentUser?.id;
    if (author) items.push({
      label: t(post.closed ? 'forum.reopen' : 'forum.close'),
      icon: post.closed ? 'lock_open' : 'check_circle',
      onClick: () => update({ closed: !post.closed }),
    });
    if (manager || author) items.push({
      label: t('forum.delete'),
      icon: 'delete',
      danger: true,
      onClick: () => { void this.delete(post); },
    });
    contextMenu.open(x, y, items, anchor);
  }

  private async delete(post: ForumPost): Promise<void> {
    if (!await showConfirm({
      title: t('forum.delete'),
      message: t('forum.deleteConfirm', { title: post.title }),
      confirmLabel: t('forum.delete'),
      variant: 'danger',
    })) return;
    try {
      await this.client.sendRequest(MessageType.FORUM_DELETE_POST, { channelId: post.channelId });
    } catch (failure) {
      console.warn('[Forum] Could not delete post.', failure);
      showErrorToast(failure instanceof Error ? failure.message : t('community.actionFailed'));
    }
  }

  private rename(post: ForumPost): void {
    const modal = openCommunityModal(t('forum.rename'));
    modal.element.querySelector('.community-modal')?.classList.add('forum-rename-modal');
    this.modals.add(modal.close);
    modal.signal.addEventListener('abort', () => this.modals.delete(modal.close), { once: true });
    modal.content.innerHTML = `<form class="forum-rename-form">
      <label class="forum-rename-field">${t('forum.renameLabel')}
        <input class="input-field" name="title" required maxlength="100" value="${escapeHtml(post.title)}">
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-secondary" data-rename-cancel>${t('common.cancel')}</button>
        <button type="submit" class="btn btn-primary">${t('common.save')}</button>
      </footer>
    </form>`;
    const title = modal.content.querySelector<HTMLInputElement>('input[name=title]')!;
    const renameForm = modal.content.querySelector('form')!;
    // A missing title is explained in the app's language, not in the browser's balloon.
    useAppValidation(renameForm, modal.signal);
    modal.content.querySelector('[data-rename-cancel]')?.addEventListener('click', () => modal.close(), { signal: modal.signal });
    renameForm.addEventListener('submit', event => {
      event.preventDefault();
      void modal.run(async () => {
        const next = title.value.trim();
        if (!next) {
          title.focus();
          return;
        }
        await this.client.sendRequest(MessageType.FORUM_UPDATE_POST, { channelId: post.channelId, title: next });
        modal.close();
      });
    }, { signal: modal.signal });
    title.select();
  }

  private openComposer() {
    const content = this.root.querySelector<HTMLElement>('[data-forum-composer]')!;
    const abort = new AbortController();
    const bar = this.root.querySelector<HTMLElement>('.forum-create-shell')!;
    bar.hidden = true;
    content.classList.add('forum-composer');
    const close = (immediate = false) => {
      if (abort.signal.aborted) return;
      abort.abort();
      this.composerClose = null;
      const clear = () => {
        content.replaceChildren();
        content.classList.remove('forum-composer');
        if (immediate) bar.hidden = false;
        else setSurfaceVisible(bar, true);
      };
      if (immediate) {
        cancelVisibilityMotion(content);
        content.hidden = true;
        clear();
      } else setSurfaceVisible(content, false, 'panel', undefined, clear);
    };
    this.composerClose = close;
    return {
      content, signal: abort.signal, close,
      run: async (operation: () => Promise<void>) => {
        try { await operation(); }
        catch (failure) {
          console.warn('[Forum] Could not save post.', failure);
          if (!abort.signal.aborted) showErrorToast(failure instanceof Error ? failure.message : t('community.actionFailed'));
        }
      },
    };
  }

  private edit(post?: ForumPost, focusMessage = false): void {
    if (post) {
      this.rename(post);
      return;
    }
    if (this.composerClose) { this.root.querySelector<HTMLElement>('[name=title]')?.focus(); return; }
    const modal = this.openComposer();
    this.modals.add(modal.close);
    modal.signal.addEventListener('abort', () => this.modals.delete(modal.close), { once: true });
    const id = crypto.randomUUID();
    const uploads = new Set<UploadHandle>();
    const uploaded = new Map<File, AttachmentMeta>();
    const selected: ForumAttachmentSelection[] = [];
    modal.signal.addEventListener('abort', () => {
      for (const upload of uploads) upload.cancel();
      for (const attachment of selected) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }, { once: true });
    // The server's limit only reaches the attribute as a whole number, as in ChatComposer.
    const messageLimit = wholeNumber(this.server.serverDetails?.maxMessageLength);
    modal.content.innerHTML = `<form>
      <div class="forum-composer-title"><input class="input-field" aria-label="${t('forum.postTitle')}" placeholder="${t('forum.postTitle')}" name="title" required maxlength="100" value="${escapeHtml(this.query)}">
        <button type="button" class="btn btn-secondary" data-post-close aria-label="${t('common.close')}"><span class="material-symbols-outlined md-20">close</span></button></div>
      <textarea class="input-field" aria-label="${t('forum.message')}" placeholder="${t('forum.message')}" name="content" required rows="3" ${messageLimit > 0 ? `maxlength="${messageLimit}"` : ''}></textarea>
      ${this.server.hasPermission(Permission.ATTACH_FILES, this.channelId) ? `
        <input type="file" data-post-media-input aria-label="${t('forum.addMedia')}" accept="image/*,video/*" multiple hidden>
        <input type="file" data-post-file-input aria-label="${t('forum.addFiles')}" multiple hidden>
        <section class="forum-attachment-preview" data-forum-media-preview hidden></section>
        <section class="forum-file-preview" data-forum-file-preview hidden></section>
        <p class="forum-upload-progress" data-upload-progress role="status"></p>` : ''}
      <footer class="forum-composer-footer">
        <button type="button" class="btn btn-secondary" data-post-emoji aria-label="${t('chat.emojiPickerTitle')}"><span class="material-symbols-outlined md-20">mood</span></button>
        ${this.server.hasPermission(Permission.ATTACH_FILES, this.channelId) ? `
          <button type="button" class="btn btn-secondary forum-attachment-action" data-post-media>
            <span class="material-symbols-outlined md-20">perm_media</span><span>${t('forum.addMedia')}</span>
          </button>
          <button type="button" class="btn btn-secondary forum-attachment-action" data-post-file>
            <span class="material-symbols-outlined md-20">attach_file</span><span>${t('forum.addFiles')}</span>
          </button>` : ''}
        <button type="submit" class="btn btn-primary">${t('forum.publish')}</button></footer></form>`;
    const title = modal.content.querySelector<HTMLInputElement>('input[name=title]')!;
    const content = modal.content.querySelector<HTMLTextAreaElement>('textarea');
    const mediaInput = modal.content.querySelector<HTMLInputElement>('[data-post-media-input]');
    const fileInput = modal.content.querySelector<HTMLInputElement>('[data-post-file-input]');
    const mediaPreview = modal.content.querySelector<HTMLElement>('[data-forum-media-preview]');
    const filePreview = modal.content.querySelector<HTMLElement>('[data-forum-file-preview]');
    let mediaIndex = 0;
    const showSelectionError = (message: string) => {
      showErrorToast(message);
    };
    const updateRequired = () => {
      if (content) content.required = selected.length === 0;
    };
    const renderSelections = () => {
      const media = selected.filter(attachment => attachment.kind === 'media');
      mediaIndex = Math.min(mediaIndex, Math.max(0, media.length - 1));
      if (mediaPreview) {
        mediaPreview.hidden = media.length === 0;
        mediaPreview.innerHTML = media.length === 0 ? '' : `
          <header><div><strong>${t('forum.mediaTitle')}</strong><p>${t('forum.mediaHint')}</p></div>
            <span>${media.length}/${LIMITS.MAX_LIVE_ACTION_IMAGES}</span></header>
          <div class="image-carousel image-carousel--editor forum-media-carousel" data-image-carousel data-carousel-index="${mediaIndex}">
            <div class="image-carousel-track"${mediaIndex ? ` style="transform:translateX(${-100 * mediaIndex}%)"` : ''}>
              ${media.map(attachment => `<div class="image-carousel-slide forum-media-slide">
                ${attachment.file.type.startsWith('video/')
                  ? `<video src="${escapeHtml(attachment.previewUrl ?? '')}" controls playsinline preload="metadata"></video>`
                  : `<img src="${escapeHtml(attachment.previewUrl ?? '')}" alt="${escapeHtml(attachment.file.name)}">`}
                <button type="button" class="forum-attachment-remove" data-remove-attachment="${attachment.id}"
                  aria-label="${t('forum.removeAttachment')}"><span class="material-symbols-outlined md-18">delete</span></button>
                <span class="forum-media-name">${escapeHtml(attachment.file.name)}</span>
              </div>`).join('')}
            </div>
            ${media.length > 1 ? `
              <button type="button" class="image-carousel-arrow image-carousel-arrow--previous" data-carousel-move="-1"
                aria-label="${t('community.previous')}"><span class="material-symbols-outlined">chevron_left</span></button>
              <button type="button" class="image-carousel-arrow image-carousel-arrow--next" data-carousel-move="1"
                aria-label="${t('community.next')}"><span class="material-symbols-outlined">chevron_right</span></button>
              <div class="image-carousel-dots">${media.map((_, index) => `<button type="button"
                class="image-carousel-dot${index === mediaIndex ? ' is-active' : ''}" data-carousel-index="${index}"
                aria-label="${t('community.imagePosition', { current: index + 1, total: media.length })}"></button>`).join('')}</div>` : ''}
          </div>`;
      }
      const files = selected.filter(attachment => attachment.kind === 'file');
      if (filePreview) {
        filePreview.hidden = files.length === 0;
        filePreview.innerHTML = files.length === 0 ? '' : `<header><strong>${t('forum.filesTitle')}</strong>
          <span>${files.length}</span></header><div class="forum-file-preview-list">${files.map(attachment => `
            <article class="forum-file-card">
              <span class="material-symbols-outlined forum-file-icon">${fileIconName('file', attachment.file.type, attachment.file.name)}</span>
              <span class="forum-file-meta"><strong title="${escapeHtml(attachment.file.name)}">${escapeHtml(attachment.file.name)}</strong>
                <small>${escapeHtml(formatBytes(attachment.file.size))}${attachment.file.type ? ` · ${escapeHtml(attachment.file.type)}` : ''}</small></span>
              <button type="button" data-remove-attachment="${attachment.id}" aria-label="${t('forum.removeAttachment')}">
                <span class="material-symbols-outlined md-18">close</span></button>
            </article>`).join('')}</div>`;
      }
      updateRequired();
    };
    const addFiles = (files: FileList | null, kind: ForumAttachmentSelection['kind']) => {
      const additions = [...files ?? []];
      if (!additions.length) return;
      if (selected.length + additions.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        showSelectionError(t('forum.attachmentLimit', { count: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE }));
        return;
      }
      const mediaCount = selected.filter(attachment => attachment.kind === 'media').length;
      if (kind === 'media' && mediaCount + additions.length > LIMITS.MAX_LIVE_ACTION_IMAGES) {
        showSelectionError(t('forum.mediaLimit', { count: LIMITS.MAX_LIVE_ACTION_IMAGES }));
        return;
      }
      const invalid = kind === 'media'
        ? additions.find(file => !file.type.startsWith('image/') && !file.type.startsWith('video/'))
        : undefined;
      if (invalid) {
        showSelectionError(t('forum.mediaOnly'));
        return;
      }
      for (const file of additions) {
        selected.push({
          id: crypto.randomUUID(),
          file,
          kind,
          previewUrl: kind === 'media' ? URL.createObjectURL(file) : undefined,
        });
      }
      renderSelections();
    };
    modal.content.querySelector('[data-post-close]')?.addEventListener('click', () => modal.close(), { signal: modal.signal });
    const mediaButton = modal.content.querySelector<HTMLElement>('[data-post-media]');
    const fileButton = modal.content.querySelector<HTMLElement>('[data-post-file]');
    mediaButton?.addEventListener('click', () => openFileInputPicker(mediaInput, mediaButton), { signal: modal.signal });
    fileButton?.addEventListener('click', () => openFileInputPicker(fileInput, fileButton), { signal: modal.signal });
    mediaInput?.addEventListener('change', () => {
      addFiles(mediaInput.files, 'media');
      mediaInput.value = '';
    }, { signal: modal.signal });
    fileInput?.addEventListener('change', () => {
      addFiles(fileInput.files, 'file');
      fileInput.value = '';
    }, { signal: modal.signal });
    modal.content.addEventListener('click', event => {
      const navigation = imageCarouselNavigationButton(event.target);
      if (navigation && moveImageCarousel(navigation)) {
        const carousel = navigation.closest<HTMLElement>('[data-image-carousel]');
        mediaIndex = Number(carousel?.dataset.carouselIndex ?? 0);
        return;
      }
      const remove = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-remove-attachment]')
        : null;
      if (!remove) return;
      const index = selected.findIndex(attachment => attachment.id === remove.dataset.removeAttachment);
      if (index < 0) return;
      const [attachment] = selected.splice(index, 1);
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      renderSelections();
    }, { signal: modal.signal });
    const detach = attachInputEmojiPicker(content ?? title, modal.content.querySelector<HTMLElement>('[data-post-emoji]')!);
    modal.signal.addEventListener('abort', detach, { once: true });
    const postForm = modal.content.querySelector('form')!;
    useAppValidation(postForm, modal.signal);
    postForm.addEventListener('submit', event => {
      event.preventDefault();
      void modal.run(async () => {
        const submit = modal.content.querySelector<HTMLButtonElement>('button[type=submit]')!;
        const controls = [...modal.content.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,button,textarea')];
        for (const control of controls) control.disabled = true;
        try {
          const selectedFiles = selected.map(attachment => attachment.file);
          const attachmentIds: string[] = [];
          for (const file of selectedFiles) {
            let attachment = uploaded.get(file);
            if (!attachment) {
              const upload = uploadAttachment(this.channelId, file, progress => {
                const status = modal.content.querySelector<HTMLElement>('[data-upload-progress]');
                if (status) status.textContent = t('forum.uploading', { name: file.name, progress: Math.round(progress * 100) });
              }, this.client);
              uploads.add(upload);
              try { attachment = await upload.promise; uploaded.set(file, attachment); }
              finally { uploads.delete(upload); }
            }
            attachmentIds.push(attachment.id);
          }
          if (modal.signal.aborted) return;
          const result = await this.client.sendRequest<ForumPostSaved>(MessageType.FORUM_CREATE_POST,
            { id, channelId: this.channelId, title: title.value, content: content?.value ?? '', attachmentIds });
          if (this.disposed) return;
          this.query = '';
          const search = this.root.querySelector<HTMLInputElement>('[data-forum-search]');
          if (search) search.value = '';
          await this.load();
          if (this.disposed) return;
          modal.close();
          this.openPost(result.post.channelId);
        } finally { if (submit.isConnected) for (const control of controls) control.disabled = false; }
      });
    }, { signal: modal.signal });
    setSurfaceVisible(modal.content, true);
    (focusMessage ? content : title)?.focus();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.unbind();
    this.lifetime.abort();
    this.lazyObserver?.disconnect();
    this.lazyObserver = null;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.appendPause);
    for (const close of [...this.modals]) close(true);
    const composer = this.root.querySelector<HTMLElement>('[data-forum-composer]');
    if (composer) cancelVisibilityMotion(composer);
  }
}
