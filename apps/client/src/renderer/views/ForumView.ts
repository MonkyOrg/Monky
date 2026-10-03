import { LIMITS, MessageType, Permission, type AttachmentMeta, type ForumListResult, type ForumPost, type ForumPostSaved } from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { t, getLanguage } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openCommunityModal } from './CommunityModal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { uploadAttachment, type UploadHandle } from '../core/AttachmentUploader';
import { contextMenu, type ContextMenuEntry } from './ContextMenu';
import { cancelVisibilityMotion, setSurfaceVisible } from '../utils/surfaceVisibility';
import { showConfirm } from './Dialog';
import { fileIconName, formatBytes } from '../utils/attachment';
import { imageCarouselNavigationButton, moveImageCarousel } from './ImageCarousel';
import { showErrorToast } from './CopyToast';
import { openFileInputPicker } from '../utils/buttonLoading';

interface ForumAttachmentSelection {
  id: string;
  file: File;
  kind: 'media' | 'file';
  previewUrl?: string;
}

export class ForumView {
  private readonly lifetime = new AbortController();
  private readonly unbind: () => void;
  private readonly modals = new Set<(immediate?: boolean) => void>();
  private posts: ForumPost[] = [];
  private query = '';
  private sort: 'latest' | 'newest' | 'oldest' = 'latest';
  private generation = 0;
  private next = 0;
  private more = false;
  private disposed = false;
  private loaded = false;
  private loading: 'initial' | 'refresh' | 'append' | null = null;
  private lazyObserver: IntersectionObserver | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private composerClose: ((immediate?: boolean) => void) | null = null;

  constructor(private readonly root: HTMLElement, private readonly client: NetworkClient, private readonly server: ServerStore,
    readonly channelId: string, private readonly openPost: (id: string) => void, headerHost?: HTMLElement) {
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
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => { void this.load(); }, 300);
    }, { signal: this.lifetime.signal });
    root.querySelector<HTMLInputElement>('[data-forum-search]')?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !event.shiftKey || !this.server.hasPermission(Permission.SEND_MESSAGES, this.channelId)) return;
      event.preventDefault();
      this.edit(undefined, true);
    }, { signal: this.lifetime.signal });
    root.querySelector<HTMLSelectElement>('[data-forum-sort]')?.addEventListener('change', event => {
      if (!(event.target instanceof HTMLSelectElement)) return;
      const value = event.target.value;
      if (value === 'latest' || value === 'newest' || value === 'oldest') { this.sort = value; void this.load(false, true); }
    }, { signal: this.lifetime.signal });
    const scroller = root.querySelector<HTMLElement>('.forum-list-content');
    const sentinel = root.querySelector<HTMLElement>('[data-forum-sentinel]');
    if (scroller && sentinel) {
      this.lazyObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && this.more && !this.loading) void this.load(true);
      }, { root: scroller, rootMargin: '0px 0px 360px' });
      this.lazyObserver.observe(sentinel);
    }
    this.unbind = client.onEvent((event, payload) => {
      if (event === 'network.status' && payload !== 'CONNECTED') { this.destroy(); root.replaceChildren(); return; }
      if ([MessageType.CHANNEL_DELETED, MessageType.CHANNEL_UPDATED, MessageType.CATEGORIES_UPDATED, MessageType.ROLES_LIST]
        .some(type => event === `message.${type}`)) {
        this.generation++;
        this.loaded = false;
        this.loading = null;
        this.next = 0;
        this.more = false;
        this.posts = [];
        this.renderPosts();
        this.syncLazyState();
        for (const close of [...this.modals]) close(true);
        if (!server.getChannel(channelId) || !server.hasPermission(Permission.READ_MESSAGES, channelId)) return;
      }
      if ([MessageType.FORUM_POST_SAVED, MessageType.CHAT_MESSAGE, MessageType.CHAT_MESSAGE_UPDATED,
        MessageType.CHAT_REACTION_ADDED, MessageType.CHAT_REACTION_REMOVED,
        MessageType.CHANNEL_UPDATED, MessageType.CATEGORIES_UPDATED, MessageType.ROLES_LIST]
        .some(type => event === `message.${type}`)) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => { void this.load(); }, 250);
      }
    });
    void this.load();
  }

  private async load(append = false, animateReorder = false): Promise<void> {
    if (this.disposed || (append && (this.loading || !this.more))) return;
    if (!this.server.hasPermission(Permission.READ_MESSAGES, this.channelId)) {
      this.renderPosts();
      return;
    }
    const generation = ++this.generation;
    this.loading = append ? 'append' : this.loaded ? 'refresh' : 'initial';
    this.syncLazyState();
    try {
      const response = await this.client.sendRequest<ForumListResult>(MessageType.FORUM_LIST, {
        channelId: this.channelId, query: this.query, sort: this.sort, offset: append ? this.next : 0,
      });
      if (this.disposed || generation !== this.generation) return;
      this.posts = append ? [...new Map([...this.posts, ...response.posts].map(post => [post.channelId, post])).values()] : response.posts;
      this.next = response.nextOffset;
      this.more = response.hasMore;
      this.loaded = true;
      this.renderPosts(animateReorder);
    } catch (failure) {
      if (this.disposed || generation !== this.generation) return;
      console.warn('[Forum] Could not load posts.', failure);
      showErrorToast(failure instanceof Error ? failure.message : t('community.actionFailed'));
    } finally {
      if (!this.disposed && generation === this.generation) {
        this.loading = null;
        this.syncLazyState();
      }
    }
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
      const hidden = this.loading !== null || !this.more;
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
      container.innerHTML = `<div class="forum-empty" role="status">${t('channelPermissions.readDenied')}</div>`;
      return;
    }
    const reorderMotion = animateReorder && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const previous = reorderMotion
      ? new Map([...container.querySelectorAll<HTMLElement>('[data-forum-id]')]
        .map(row => [row.dataset.forumId, row.getBoundingClientRect()] as const))
      : new Map<string | undefined, DOMRect>();
    container.innerHTML = this.posts.length ? this.posts.map(post =>
      `<article class="forum-post-row" data-forum-id="${escapeHtml(post.channelId)}">
        <button type="button" class="forum-post-open" data-forum-open>
          <span class="forum-post-summary">
          ${this.server.knownMembers.get(post.authorId)?.nickname ? `<small class="forum-post-author">${escapeHtml(this.server.knownMembers.get(post.authorId)!.nickname)}</small>` : ''}
          <h3>${post.pinned ? `<span class="material-symbols-outlined md-16" aria-label="${t('forum.pinned')}">keep</span>` : ''}${escapeHtml(post.title)}</h3>
          <p>${escapeHtml(post.preview)}</p><small class="forum-post-stats">
            <span title="${escapeHtml(t('forum.replies', { count: post.replyCount }))}"><span class="material-symbols-outlined md-16">chat_bubble</span>${post.replyCount}</span>
            <span title="${escapeHtml(t('forum.reactions', { count: post.reactionCount ?? 0 }))}"><span class="material-symbols-outlined md-16">add_reaction</span>${post.reactionCount ?? 0}</span>
            <time datetime="${new Date(post.updatedAt).toISOString()}">${escapeHtml(new Date(post.updatedAt).toLocaleString(getLanguage()))}</time>
            ${post.locked ? `<span class="forum-post-state"><span class="material-symbols-outlined md-14">lock</span>${t('forum.locked')}</span>` : ''}
            ${post.closed ? `<span class="forum-post-state"><span class="material-symbols-outlined md-14">check_circle</span>${t('forum.closed')}</span>` : ''}</small></span>
          ${post.thumbnailUrl ? `<img class="forum-post-thumbnail" src="${escapeHtml(this.client.getHttpBaseUrl() + post.thumbnailUrl)}" alt="">` : ''}
        </button>
        <button type="button" class="forum-post-menu" data-forum-menu aria-label="${t('common.moreOptions')}"><span class="material-symbols-outlined md-18">more_horiz</span></button>
        </article>`).join('') : this.query
      ? `<div class="forum-empty-state forum-empty-state--search"><span class="material-symbols-outlined">search_off</span><p>${t('forum.noResults')}</p></div>`
      : `<div class="forum-empty-state"><span class="material-symbols-outlined forum-empty-icon">forum</span>
          <strong>${t('forum.emptyTitle')}</strong>
          <p>${t('forum.emptyDescription', { channel: this.server.getChannel(this.channelId)?.name ?? t('forum.title') })}</p>
        </div>`;
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
    const manager = this.server.hasPermission(Permission.MANAGE_CHANNELS, this.channelId);
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
    modal.content.querySelector('[data-rename-cancel]')?.addEventListener('click', () => modal.close(), { signal: modal.signal });
    modal.content.querySelector('form')?.addEventListener('submit', event => {
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
    modal.content.innerHTML = `<form>
      <div class="forum-composer-title"><input class="input-field" aria-label="${t('forum.postTitle')}" placeholder="${t('forum.postTitle')}" name="title" required maxlength="100" value="${escapeHtml(this.query)}">
        <button type="button" class="btn btn-secondary" data-post-close aria-label="${t('common.close')}"><span class="material-symbols-outlined md-20">close</span></button></div>
      <textarea class="input-field" aria-label="${t('forum.message')}" placeholder="${t('forum.message')}" name="content" required rows="3" ${this.server.serverDetails?.maxMessageLength ? `maxlength="${this.server.serverDetails.maxMessageLength}"` : ''}></textarea>
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
    modal.content.querySelector('form')!.addEventListener('submit', event => {
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
    for (const close of [...this.modals]) close(true);
    const composer = this.root.querySelector<HTMLElement>('[data-forum-composer]');
    if (composer) cancelVisibilityMotion(composer);
  }
}
