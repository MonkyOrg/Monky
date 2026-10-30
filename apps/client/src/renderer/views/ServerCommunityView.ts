import type { LiveAction, NativeLiveForm, NativePoll, ServerEventPublic } from '@monky/shared';
import type { CommunityFeed } from '../core/CommunityFeed';
import { appEvents } from '../core/EventBus';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { cancelVisibilityMotion, setSurfaceVisible } from '../utils/surfaceVisibility';
import { openCommunityModal, type CommunityModal } from './CommunityModal';
import { imageCarouselNavigationButton, moveImageCarousel } from './ImageCarousel';
import { canCreateLiveAction } from './community/communityAccess';
import { assetUrl, type CommunityContext } from './community/communityContext';
import { locationIcon } from './community/communityMarkup';
import { getEvent, locationName, openEvent, openEvents } from './community/eventModals';
import { openActions, openLiveItem } from './community/liveActionModals';
import '../styles/community.css';

/**
 * The server's activity in the sidebar: a banner for what is happening now and the
 * links to its events and live actions. The dialogs live in `views/community/`;
 * this view opens them, and every one of them closes with it.
 */
export class ServerCommunityView {
  private readonly abort = new AbortController();
  private readonly unbind: Array<() => void> = [];
  private dismissed = new Set<string>();
  private index = 0;
  private bannerTransition = 0;
  private readonly modals = new Set<(immediate?: boolean) => void>();
  /** Open event lists and details, told when the server refuses one of their events; see `forgetEvent`. */
  private readonly eventWatchers = new Set<(id: string) => void>();
  private readonly storageKey: string;
  /** Last markup written to the sidebar section; see `show`. */
  private shownHtml: string | null = null;
  private readonly context: CommunityContext;

  constructor(
    private readonly root: HTMLElement,
    private readonly feed: CommunityFeed,
    joinVoice: (channelId: string) => Promise<void>,
    private readonly header?: HTMLElement,
    openTextChannel?: (channelId: string) => void,
  ) {
    this.context = {
      feed, joinVoice, openTextChannel,
      modal: title => {
        const modal = openCommunityModal(title);
        this.track(modal);
        return modal;
      },
      track: modal => this.track(modal),
      closeAll: () => { for (const close of [...this.modals]) close(); },
      // Top-most first, so a detail closes, giving focus back to its list, before that list drops the card.
      forgetEvent: id => { for (const forget of [...this.eventWatchers].reverse()) forget(id); },
      watchEvents: forget => {
        this.eventWatchers.add(forget);
        return () => this.eventWatchers.delete(forget);
      },
    };
    this.storageKey = JSON.stringify(['monky-hidden-activity', feed.server.serverDetails?.id, feed.server.currentUser?.id]);
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(this.storageKey) ?? '[]');
      if (Array.isArray(stored)) this.dismissed = new Set(stored.filter((value): value is string => typeof value === 'string').slice(-500));
    } catch (error) { console.warn('[Community] Could not restore hidden banners.', error); }
    this.unbind.push(feed.subscribe(() => { this.render(); this.openRequestedEvent(); }), appEvents.on('i18n.language_changed', () => this.render()));
    root.addEventListener('click', this.click, { signal: this.abort.signal });
    this.render();
    this.openRequestedEvent();
    if (!feed.snapshot) void feed.load();
  }

  /** A dialog of this view, wizards included: it closes with the view. */
  private track(modal: CommunityModal | undefined): void {
    if (!modal) return;
    this.modals.add(modal.close);
    modal.signal.addEventListener('abort', () => this.modals.delete(modal.close), { once: true });
  }

  private items(): Array<{
    key: string;
    event?: ServerEventPublic;
    action?: LiveAction;
    poll?: NativePoll;
    form?: NativeLiveForm;
  }> {
    const snapshot = this.feed.snapshot;
    if (!snapshot) return [];
    return [
      ...snapshot.events.filter((event) => event.status === 'active')
        .map((event) => ({ key: `event:${event.id}:${event.occurrence}`, event })),
      ...snapshot.liveActions.map((action) => ({ key: `action:${action.id}:${action.createdAt}`, action })),
      ...(snapshot.polls ?? []).map((poll) => ({ key: `poll:${poll.id}:${poll.createdAt}`, poll })),
      ...(snapshot.nativeForms ?? []).map((form) => ({ key: `form:${form.id}:${form.createdAt}`, form })),
    ].filter((item) => !this.dismissed.has(item.key));
  }

  private render(animateBanner = false): void {
    const revision = ++this.bannerTransition;
    const previous = this.root.querySelector<HTMLElement>('.community-banner');
    if (previous) {
      cancelVisibilityMotion(previous);
      if (animateBanner) {
        setSurfaceVisible(previous, false, 'panel', undefined, () => {
          if (this.abort.signal.aborted || revision !== this.bannerTransition) return;
          this.render();
          const next = this.root.querySelector<HTMLElement>('.community-banner');
          if (next) { next.hidden = true; setSurfaceVisible(next, true); }
        });
        return;
      }
    }
    const snapshot = this.feed.snapshot;
    if (!snapshot) {
      this.setHeaderImage(null);
      this.root.hidden = !this.feed.error;
      this.show(this.feed.error ? `<p role="alert">${t('community.loadError')}</p>
        <button class="btn btn-secondary" type="button" data-community="retry">${t('community.retry')}</button>` : '');
      return;
    }
    const items = this.items();
    this.index = items.length ? Math.min(this.index, items.length - 1) : 0;
    const item = items[this.index];
    const title = item?.event?.title ?? item?.action?.title ?? item?.poll?.question ?? item?.form?.form.title;
    const image = snapshot.settings.bannerUrl;
    this.setHeaderImage(snapshot.settings.bannerUrl);
    const liveActionCount = snapshot.liveActions.length + (snapshot.polls?.length ?? 0) +
      (snapshot.nativeForms?.length ?? 0);
    const canCreate = snapshot.settings.eventsEnabled && canCreateLiveAction(this.feed.server);
    const showToolbar = snapshot.settings.eventsEnabled || liveActionCount > 0 || canCreate;
    const hasActiveEvent = snapshot.events.some(event => event.status === 'active');
    const eventCount = snapshot.events.filter(event => event.status === 'scheduled' || event.status === 'active').length;
    const eventLabel = eventCount === 0 ? t('community.events') : eventCount === 1
      ? t('community.sidebarOneEvent') : t('community.sidebarEventCount', { count: eventCount });
    this.root.hidden = (!image || !!this.header) && !item && !showToolbar;
    this.show(`${(image && !this.header) || item ? `<section class="community-banner">
      ${image && !this.header && !item
        ? `<img src="${escapeHtml(assetUrl(this.feed, image))}" alt="${escapeHtml(t('community.banner'))}">`
        : ''}
      ${item ? `<button class="community-dismiss" type="button" data-community="dismiss" aria-label="${escapeHtml(t('community.closeBanner'))}">×</button>
        <div class="community-banner-body"><small class="community-live-label"><span class="community-live-dot"></span>${t(item.event ? 'community.active' : 'community.liveActions')}</small>
          <h3>${escapeHtml(title ?? '')}</h3>
          ${item.event ? `<p class="community-banner-location"><span class="material-symbols-outlined md-16">${locationIcon(item.event.location.kind)}</span>${escapeHtml(locationName(this.feed, item.event))}</p>
            <small class="community-banner-interested">${t('community.interestedCount', { count: item.event.interestedCount })}</small>` : ''}
          <button class="btn btn-secondary" type="button" data-community="open">${t('community.open')}</button></div>` : ''}
      ${items.length > 1 ? `<nav class="community-navigation">
        <button class="btn btn-secondary" type="button" data-community="previous" aria-label="${escapeHtml(t('community.previous'))}">‹</button>
        <span>${t('community.bannerPosition', { current: this.index + 1, total: items.length })}</span>
        <button class="btn btn-secondary" type="button" data-community="next" aria-label="${escapeHtml(t('community.next'))}">›</button>
      </nav>` : ''}</section>` : ''}
      ${showToolbar ? `<div class="community-toolbar">
        ${snapshot.settings.eventsEnabled ? `<button class="community-sidebar-link" type="button" data-community="events"><span class="material-symbols-outlined md-20">event</span>${hasActiveEvent ? '<span class="live-pulse-dot community-sidebar-live-dot" aria-hidden="true"></span>' : ''}${eventLabel}</button>` : ''}
        ${liveActionCount || canCreate ? `<button class="community-sidebar-link" type="button" data-community="actions"><span class="material-symbols-outlined md-20">bolt</span>${liveActionCount ? '<span class="live-pulse-dot community-sidebar-live-dot" aria-hidden="true"></span>' : ''}${liveActionCount === 0 ? t('community.liveActions') : t(liveActionCount === 1 ? 'community.oneLiveAction' : 'community.liveActionCount', { count: liveActionCount })}</button>` : ''}
      </div>` : ''}`);
  }

  /**
   * The server sends a snapshot for every vote, response or "interested" anywhere
   * on it; rewriting identical markup would only drop focus and restart motion.
   */
  private show(html: string): void {
    if (html === this.shownHtml) return;
    this.shownHtml = html;
    this.root.innerHTML = html;
  }

  private setHeaderImage(image: string | null): void {
    if (!this.header) return;
    this.header.classList.toggle('server-header--banner', !!image);
    this.header.style.backgroundImage = image
      ? `linear-gradient(#0008, transparent 65%), url(${JSON.stringify(assetUrl(this.feed, image))})` : '';
  }

  private click = (event: MouseEvent): void => {
    const carouselButton = imageCarouselNavigationButton(event.target);
    if (carouselButton && moveImageCarousel(carouselButton)) return;
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-community]') : null;
    if (!button) return;
    const items = this.items();
    const item = items[this.index];
    switch (button.dataset.community) {
      case 'retry': void this.feed.load(); break;
      case 'previous': this.index = (this.index - 1 + items.length) % items.length; this.render(true); break;
      case 'next': this.index = (this.index + 1) % items.length; this.render(true); break;
      case 'dismiss':
        if (!item) return;
        this.dismissed.add(item.key);
        try { localStorage.setItem(this.storageKey, JSON.stringify([...this.dismissed].slice(-500))); }
        catch (failure) { console.warn('[Community] Could not persist hidden banners.', failure); }
        this.render(true);
        break;
      case 'events': openEvents(this.context); break;
      case 'actions': openActions(this.context); break;
      case 'open':
        if (item?.event) openEvent(this.context, item.event);
        else if (item) openLiveItem(this.context, item);
        break;
    }
  };

  /** An event a link asked for, fetched by id: it may be in the history, outside the snapshot. */
  private openRequestedEvent(): void {
    if (!this.feed.snapshot) return;
    const id = this.feed.takeEventRequest();
    if (!id) return;
    const modal = this.context.modal(t('community.details'));
    modal.content.textContent = t('community.loadingEvent');
    void modal.run(async () => {
      try {
        const event = await getEvent(this.feed, id, modal.signal);
        if (modal.signal.aborted) return;
        modal.close();
        openEvent(this.context, event, true);
      } finally { modal.content.textContent = ''; }
    });
  }

  destroy(): void {
    this.bannerTransition++;
    const banner = this.root.querySelector<HTMLElement>('.community-banner');
    if (banner) cancelVisibilityMotion(banner);
    this.setHeaderImage(null);
    this.abort.abort();
    for (const unbind of this.unbind) unbind();
    for (const close of [...this.modals]) close(true);
    this.root.replaceChildren();
    this.shownHtml = null;
  }
}
