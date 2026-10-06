import {
  MessageType, Permission, botSelectorPublicSchema, validateBotFormValues, validateNativeLiveFormValues,
  communitySnapshotSchema, nativeLiveFormResultsSchema, nativeLiveFormSchema,
  type ServerEventPublic, type LiveAction, type EventControl, type NativeLiveForm,
  type NativeLiveFormResults, type NativePoll,
  createServerInviteLink, eventResultSchema, eventInterestedListResultSchema, type EventInterestedListResult,
} from '@monky/shared';
import type { CommunityFeed } from '../core/CommunityFeed';
import { appEvents } from '../core/EventBus';
import { getLanguage, t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { botInputError, convertBotInputValues, initialBotInputValues } from '../utils/botInputs';
import { scrollWithin } from '../utils/scroll';
import { addBotFieldImage, applyBotFieldAction, readBotFieldChange, renderBotFields } from './botFields';
import { openCommunityModal } from './CommunityModal';
import { openServerEventWizard } from './ServerEventWizard';
import { renderServerEventCard } from './ServerEventCard';
import { contextMenu } from './ContextMenu';
import { PublicSelectorView } from './PublicSelectorView';
import { showConfirm } from './Dialog';
import { showCopyToast, showInfoToast } from './CopyToast';
import { audioPreviewService } from '../core/AudioPreviewService';
import { renderNativePoll, submitNativePollVote } from './nativePoll';
import { openNativePollWizard } from './NativePollWizard';
import { openNativeLiveFormWizard } from './NativeLiveFormWizard';
import { DEFAULT_AVATAR_URL } from '../utils/avatar';
import { cancelVisibilityMotion, setSurfaceVisible } from '../utils/surfaceVisibility';
import {
  imageCarouselNavigationButton, imageCarouselPresentationClass, moveImageCarousel, renderImageCarousel,
} from './ImageCarousel';
import '../styles/community.css';

export class ServerCommunityView {
  private readonly abort = new AbortController();
  private readonly unbind: Array<() => void> = [];
  private dismissed = new Set<string>();
  private index = 0;
  private bannerTransition = 0;
  private clearCopyFeedback: (() => void) | null = null;
  private modals = new Set<(immediate?: boolean) => void>();
  private readonly storageKey: string;

  constructor(
    private readonly root: HTMLElement,
    private readonly feed: CommunityFeed,
    private readonly joinVoice: (channelId: string) => Promise<void>,
    private readonly header?: HTMLElement,
    private readonly openTextChannel?: (channelId: string) => void,
  ) {
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

  private eventImages(event: ServerEventPublic): string[] {
    return event.imageUrls?.length ? event.imageUrls : event.imageUrl ? [event.imageUrl] : [];
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
      this.root.innerHTML = this.feed.error ? `<p role="alert">${t('community.loadError')}</p>
        <button class="btn btn-secondary" type="button" data-community="retry">${t('community.retry')}</button>` : '';
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
    const canCreateLiveAction = snapshot.settings.eventsEnabled &&
      this.liveActionChannels().length > 0 &&
      (this.feed.server.serverDetails?.protocol?.features.includes('native-polls') ||
        this.feed.server.serverDetails?.protocol?.features.includes('native-live-forms'));
    const showToolbar = snapshot.settings.eventsEnabled || liveActionCount > 0 || canCreateLiveAction;
    const hasActiveEvent = snapshot.events.some(event => event.status === 'active');
    const eventCount = snapshot.events.filter(event => event.status === 'scheduled' || event.status === 'active').length;
    const eventLabel = eventCount === 0 ? t('community.events') : eventCount === 1
      ? t('community.sidebarOneEvent') : t('community.sidebarEventCount', { count: eventCount });
    this.root.hidden = (!image || !!this.header) && !item && !showToolbar;
    this.root.innerHTML = `${(image && !this.header) || item ? `<section class="community-banner">
      ${image && !this.header && !item
        ? `<img src="${escapeHtml(this.feed.client.getHttpBaseUrl() + image)}" alt="${escapeHtml(t('community.banner'))}">`
        : ''}
      ${item ? `<button class="community-dismiss" type="button" data-community="dismiss" aria-label="${escapeHtml(t('community.closeBanner'))}">×</button>
        <div class="community-banner-body"><small class="community-live-label"><span class="community-live-dot"></span>${t(item.event ? 'community.active' : 'community.liveActions')}</small>
          <h3>${escapeHtml(title ?? '')}</h3>
          ${item.event ? `<p class="community-banner-location"><span class="material-symbols-outlined md-16">${item.event.location.kind === 'voice' ? 'volume_up' : item.event.location.kind === 'text' ? 'tag' : 'location_on'}</span>${escapeHtml(this.locationName(item.event))}</p>
            <small class="community-banner-interested">${t('community.interestedCount', { count: item.event.interestedCount })}</small>` : ''}
          <button class="btn btn-secondary" type="button" data-community="open">${t('community.open')}</button></div>` : ''}
      ${items.length > 1 ? `<nav class="community-navigation">
        <button class="btn btn-secondary" type="button" data-community="previous" aria-label="${escapeHtml(t('community.previous'))}">‹</button>
        <span>${t('community.bannerPosition', { current: this.index + 1, total: items.length })}</span>
        <button class="btn btn-secondary" type="button" data-community="next" aria-label="${escapeHtml(t('community.next'))}">›</button>
      </nav>` : ''}</section>` : ''}
      ${showToolbar ? `<div class="community-toolbar">
        ${snapshot.settings.eventsEnabled ? `<button class="community-sidebar-link" type="button" data-community="events"><span class="material-symbols-outlined md-20">event</span>${hasActiveEvent ? '<span class="live-pulse-dot community-sidebar-live-dot" aria-hidden="true"></span>' : ''}${eventLabel}</button>` : ''}
        ${liveActionCount || canCreateLiveAction ? `<button class="community-sidebar-link" type="button" data-community="actions"><span class="material-symbols-outlined md-20">bolt</span>${liveActionCount ? '<span class="live-pulse-dot community-sidebar-live-dot" aria-hidden="true"></span>' : ''}${liveActionCount === 0 ? t('community.liveActions') : t(liveActionCount === 1 ? 'community.oneLiveAction' : 'community.liveActionCount', { count: liveActionCount })}</button>` : ''}
      </div>` : ''}`;
  }

  private setHeaderImage(image: string | null): void {
    if (!this.header) return;
    this.header.classList.toggle('server-header--banner', !!image);
    this.header.style.backgroundImage = image
      ? `linear-gradient(#0008, transparent 65%), url(${JSON.stringify(this.feed.client.getHttpBaseUrl() + image)})` : '';
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
      case 'events': this.openEvents(); break;
      case 'actions': this.openActions(); break;
      case 'open':
        if (item?.event) this.openEvent(item.event);
        if (item?.action) void this.openAction(item.action);
        if (item?.poll) this.openPollAction(item.poll);
        if (item?.form) this.openNativeFormAction(item.form);
        break;
    }
  };

  private modal(title: string) {
    const modal = openCommunityModal(title);
    this.modals.add(modal.close);
    modal.signal.addEventListener('abort', () => this.modals.delete(modal.close), { once: true });
    return modal;
  }

  private openWizard(event?: ServerEventPublic): void {
    const modal = openServerEventWizard(this.feed, event);
    if (!modal) return;
    this.modals.add(modal.close);
    modal.signal.addEventListener('abort', () => this.modals.delete(modal.close), { once: true });
  }

  private async getEvent(id: string, signal: AbortSignal): Promise<ServerEventPublic> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const requestId = crypto.randomUUID();
    const cancel = () => this.feed.client.cancelRequest(requestId);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.feed.client.sendRequest<unknown>(MessageType.EVENT_GET, { id }, requestId);
      const { event } = eventResultSchema.parse(response);
      if (event.id !== id) throw new Error(t('community.changed'));
      return event;
    } finally { signal.removeEventListener('abort', cancel); }
  }

  private openRequestedEvent(): void {
    if (!this.feed.snapshot) return;
    const id = this.feed.takeEventRequest();
    if (!id) return;
    const modal = this.modal(t('community.details'));
    modal.content.textContent = t('community.loadingEvent');
    void modal.run(async () => {
      try {
        const event = await this.getEvent(id, modal.signal);
        if (modal.signal.aborted) return;
        modal.close();
        this.openEvent(event);
      } finally { modal.content.textContent = ''; }
    });
  }

  private eventLink(event: ServerEventPublic): string {
    const address = new URL(this.feed.client.getHttpBaseUrl());
    return createServerInviteLink({
      v: 1, host: address.hostname, port: Number(address.port || (address.protocol === 'https:' ? 443 : 80)),
      name: this.feed.server.serverDetails?.name, eventId: event.id,
    });
  }

  private eventFeedback(modal: ReturnType<typeof openCommunityModal>, message: string): void {
    modal.content.querySelector('[data-event-feedback]')?.remove();
    const notice = document.createElement('p');
    notice.dataset.eventFeedback = '';
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    modal.content.append(notice);
  }

  private eventHtml(event: ServerEventPublic, details = false): string {
    const canManage = this.canManageEvent(event);
    const ongoing = event.status === 'scheduled' || event.status === 'active';
    const location = this.locationName(event);
    const actions = `
        <button class="btn btn-secondary event-more" type="button" data-event-action="menu" aria-label="${t('common.moreOptions')}"><span class="material-symbols-outlined md-18">more_horiz</span></button>
        ${event.status === 'scheduled' ? `<button class="btn ${event.interested ? 'btn-success' : 'btn-secondary'}" type="button" data-event-action="interest" aria-pressed="${event.interested}" title="${t(event.interested ? 'community.notInterested' : 'community.interested')}">${t('community.interested')}</button>` : ''}
        ${event.status === 'active' ? `<button class="btn btn-secondary" type="button" data-event-action="copyLink"><span class="material-symbols-outlined md-18">link</span>${t('community.copyLinkShort')}</button>` : ''}
        ${event.status === 'active' && event.location.kind !== 'external' ? `<button class="btn btn-success" type="button" data-event-action="join">${t(event.location.kind === 'voice' ? 'community.join' : 'community.openChannel')}</button>` : ''}
        ${canManage && ongoing && event.status === 'scheduled' ? `<button class="btn btn-primary" type="button" data-event-action="start">${t('community.start')}</button>` : ''}`;
    const images = this.eventImages(event).map(url => this.feed.client.getHttpBaseUrl() + url);
    return renderServerEventCard(event, location, images, actions, !details);
  }

  private locationName(event: ServerEventPublic): string {
    return event.location.kind !== 'external'
      ? this.feed.server.serverDetails?.channels.find(channel => event.location.kind !== 'external' && channel.id === event.location.channelId)?.name ?? ''
      : event.location.label;
  }

  private canManageEvent(event: ServerEventPublic): boolean {
    return event.creatorUserId === this.feed.server.currentUser?.id ||
      this.feed.server.hasPermission(Permission.MANAGE_SERVER) ||
      this.feed.server.hasPermission(Permission.MANAGE_EVENTS, event.location.kind === 'external' ? undefined : event.location.channelId);
  }

  private bindEventActions(modal: ReturnType<typeof openCommunityModal>, events: () => ServerEventPublic[]): void {
    modal.content.addEventListener('click', (click) => {
      const carouselButton = imageCarouselNavigationButton(click.target);
      if (carouselButton && moveImageCarousel(carouselButton)) return;
      const target = click.target instanceof Element ? click.target : null;
      const button = target?.closest<HTMLButtonElement>('[data-event-action]') ?? null;
      const openableCard = target?.closest<HTMLElement>('[data-event-openable="true"]') ?? null;
      const id = (button ?? openableCard)?.closest<HTMLElement>('[data-event-id]')?.dataset.eventId;
      const event = events().find((entry) => entry.id === id);
      if (!event) return;
      if (!button) {
        if (!openableCard || target?.closest('button, a, input, select, textarea, [role="button"], .community-actions')) return;
        this.openEvent(event);
        return;
      }
      if (button.dataset.eventAction === 'menu') {
        const rect = button.getBoundingClientRect();
        const management = event.status === 'scheduled' ? ['start', 'edit', 'cancel', 'delete'] as const
          : event.status === 'active' ? ['edit', 'end', 'delete'] as const : ['delete'] as const;
        const actions = [...(this.canManageEvent(event) ? management : []),
          'copyLink', 'exportCalendar', ...(event.status === 'active' ? ['interest'] as const : [])] as const;
        contextMenu.open(rect.left, rect.bottom, actions.map(action => ({
          label: t(action === 'cancel' ? 'community.cancelEvent'
            : action === 'interest' ? (event.interested ? 'community.notInterested' : 'community.interested')
            : action === 'exportCalendar' && event.repeat !== 'none' ? 'community.exportSeries' : `community.${action}`),
          danger: action === 'cancel' || action === 'delete' || action === 'end',
          onClick: () => this.runEventAction(modal, event, button, action),
        })), button);
        return;
      }

      this.runEventAction(modal, event, button, button.dataset.eventAction);
    }, { signal: modal.signal });
  }

  private runEventAction(modal: ReturnType<typeof openCommunityModal>, event: ServerEventPublic, button: HTMLButtonElement, requestedAction?: string): void {
    if (modal.signal.aborted) return;
    modal.content.querySelector('[data-event-feedback]')?.remove();
    void modal.run(async () => {
        if (requestedAction === 'detail') { this.openEvent(event); return; }
        if (requestedAction === 'edit') { this.openWizard(event); return; }
        if (requestedAction === 'start') { this.confirmStart(event); return; }
        if (requestedAction === 'join' && event.location.kind === 'voice') {
          await this.joinVoice(event.location.channelId);
          for (const close of this.modals) close();
          return;
        }
        if (requestedAction === 'join' && event.location.kind === 'text') {
          if (!this.openTextChannel || !this.feed.server.getChannel(event.location.channelId)) throw new Error(t('community.changed'));
          this.openTextChannel(event.location.channelId);
          for (const close of this.modals) close();
          return;
        }
        button.disabled = true;
        try {
          if (requestedAction === 'copyLink') {
            this.clearCopyFeedback?.();
            this.clearCopyFeedback = null;
            try { await navigator.clipboard.writeText(this.eventLink(event)); }
            catch (error) { console.warn('[Community] Event link copy failed.', error); throw new Error(t('community.copyFailed')); }
            if (!modal.signal.aborted) this.clearCopyFeedback = showCopyToast(t('community.linkCopied'));
            return;
          }
          if (requestedAction === 'exportCalendar') {
            const server = this.feed.server.serverDetails;
            if (!server) throw new Error(t('community.changed'));
            const result = await window.api.saveEventCalendar({
              event, serverId: server.id, serverName: server.name, location: this.locationName(event), link: this.eventLink(event),
            });
            if (result.status === 'failed') throw new Error(result.error);
            if (result.status === 'saved' && !modal.signal.aborted) this.eventFeedback(modal, t('community.calendarSaved'));
            return;
          }
          if (requestedAction === 'interest') {
            await this.feed.client.sendRequest(MessageType.EVENT_INTEREST, { id: event.id, interested: !event.interested });
          } else {
            const action = requestedAction === 'confirm-start' ? 'start' : requestedAction;
            if (action !== 'start' && action !== 'end' && action !== 'cancel' && action !== 'delete') throw new Error(t('community.changed'));
            if (action !== 'start' && !await showConfirm({
              message: t(action === 'end' ? 'community.confirmEnd' : action === 'cancel' ? 'community.confirmCancel' : 'community.confirmDelete'),
              signal: modal.signal,
            })) return;
            const payload: EventControl = { id: event.id, expectedRevision: event.revision, action };
            await this.feed.client.sendRequest(MessageType.EVENT_CONTROL, payload);
            if (requestedAction === 'confirm-start') modal.close();
          }
        } finally { if (button.isConnected) button.disabled = false; }
    });
  }

  private openEvents(): void {
    const modal = this.modal(t('community.events'));
    modal.element.querySelector('.community-modal')?.classList.add('event-list-modal');
    const header = modal.element.querySelector('.modal-header');
    if (this.feed.server.hasPermission(Permission.MANAGE_EVENTS) ||
        this.feed.server.serverDetails?.channels.some(channel => !channel.forumId &&
          (channel.type === 'TEXT' || channel.type === 'VOICE') && this.feed.server.hasPermission(Permission.MANAGE_EVENTS, channel.id))) {
      const create = document.createElement('button');
      create.className = 'btn btn-primary';
      create.dataset.createEvent = '';
      create.textContent = t('community.newEvent');
      create.addEventListener('click', () => this.openWizard(), { signal: modal.signal });
      header?.querySelector('.modal-title')?.after(create);
    }
    let history = false;
    let previous: ServerEventPublic[] = [];
    const events = () => history ? previous : this.feed.snapshot?.events ?? [];
    const render = () => {
      const count = events().length;
      const title = modal.element.querySelector('.modal-title');
      if (title) title.innerHTML = `<span class="material-symbols-outlined md-24">event</span>${escapeHtml(t(count === 1 ? 'community.oneEvent' : 'community.eventCount', { count }))}`;
      modal.content.innerHTML = `${events().length ? events().map((event) => this.eventHtml(event)).join('') : `<div class="community-empty">
        <span class="material-symbols-outlined">event</span><h2>${t('community.emptyEvents')}</h2><p>${t('community.emptyHint')}</p></div>`}
        <div class="community-history">
        <span>${t('community.history')}</span>
        <label class="toggle-switch"><input type="checkbox" role="switch" data-history ${history ? 'checked' : ''} aria-label="${escapeHtml(t('community.history'))}"><span class="toggle-slider"></span></label>
        </div>`;
    };
    const refresh = async () => {
      if (history) {
        const response: unknown = await this.feed.client.sendRequest(MessageType.COMMUNITY_GET, { includeEnded: true });
        if (modal.signal.aborted) return;
        previous = communitySnapshotSchema.parse(response).events;
      }
      render();
    };
    modal.content.addEventListener('change', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-history')) {
        history = event.target.checked;
        void modal.run(refresh);
      }
    }, { signal: modal.signal });
    this.bindEventActions(modal, events);
    const unbind = this.feed.subscribe(() => {
      if (!this.feed.snapshot?.settings.eventsEnabled) { modal.close(true); return; }
      if (history) {
        const current = new Map(this.feed.snapshot.events.map((event) => [event.id, event]));
        previous = [...previous.filter((event) => !current.has(event.id) && ['ended', 'cancelled'].includes(event.status)), ...current.values()];
      }
      render();
    });
    modal.signal.addEventListener('abort', unbind, { once: true });
    render();
  }

  private openEvent(initial: ServerEventPublic): void {
    const modal = this.modal(initial.title);
    modal.element.querySelector('.community-modal')?.classList.add('event-detail-modal');
    let event = initial;
    let tab: 'details' | 'interested' = 'details';
    let members: EventInterestedListResult['users'] = [];
    let cursor: string | null = null;
    let loading = false, failed = false, generation = 0;
    let requestId: string | null = null;
    let detailAbort = new AbortController();
    const tabsId = crypto.randomUUID();
    const cancelMembers = () => {
      generation++;
      if (requestId) this.feed.client.cancelRequest(requestId);
      requestId = null;
      loading = false;
    };
    const render = () => {
      const focusedTab = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.eventTab : undefined;
      modal.content.innerHTML = this.eventHtml(event, true);
      const content = modal.content.querySelector<HTMLElement>('.community-event-content')!;
      content.hidden = tab !== 'details';
      content.id = `${tabsId}-details-panel`;
      content.setAttribute('role', 'tabpanel');
      content.setAttribute('aria-labelledby', `${tabsId}-details`);
      content.insertAdjacentHTML('beforebegin', `<div class="community-event-tabs" role="tablist">
        <button type="button" id="${tabsId}-details" role="tab" data-event-tab="details" aria-controls="${tabsId}-details-panel" aria-selected="${tab === 'details'}" tabindex="${tab === 'details' ? 0 : -1}">${t('community.details')}</button>
        <button type="button" id="${tabsId}-interested" role="tab" data-event-tab="interested" aria-controls="${tabsId}-interested-panel" aria-selected="${tab === 'interested'}" tabindex="${tab === 'interested' ? 0 : -1}">${t('community.interestedCount', { count: event.interestedCount })}</button></div>
        <section class="event-interest-list" id="${tabsId}-interested-panel" role="tabpanel" aria-labelledby="${tabsId}-interested" ${tab !== 'interested' ? 'hidden' : ''} aria-busy="${loading}">
          <ul>${members.map(member => `<li><img src="${escapeHtml(member.avatarUrl ? this.feed.client.getHttpBaseUrl() + member.avatarUrl : DEFAULT_AVATAR_URL)}" alt=""><span>${escapeHtml(member.nickname)}</span></li>`).join('')}</ul>
          ${loading ? `<p role="status">${t('community.loadingInterested')}</p>` : ''}
          ${!loading && !failed && !members.length ? `<p>${t('community.noInterested')}</p>` : ''}
          ${failed ? `<p role="alert">${t('community.interestedLoadError')}</p>` : ''}
          ${!loading && (failed || cursor) ? `<button type="button" class="btn btn-secondary" data-interested-more>${t(failed ? 'community.retry' : 'community.loadMore')}</button>` : ''}
        </section>`);
      const creator = this.feed.server.knownMembers.get(event.creatorUserId)?.nickname;
      content.querySelector('h3')?.insertAdjacentHTML('afterend', `<div class="community-event-details-meta">
        <p><span class="material-symbols-outlined md-18">dns</span>${escapeHtml(this.feed.server.serverDetails?.name ?? '')}</p>
        <p><span class="material-symbols-outlined md-18">${event.location.kind === 'voice' ? 'volume_up' : event.location.kind === 'text' ? 'tag' : 'location_on'}</span>${escapeHtml(this.locationName(event))}</p>
        <p><span class="material-symbols-outlined md-18">group</span>${t('community.interestedCount', { count: event.interestedCount })}</p>
        ${creator ? `<p><span class="material-symbols-outlined md-18">person</span>${escapeHtml(t('community.createdBy', { name: creator }))}</p>` : ''}</div>`);
      modal.content.querySelector('.community-event-footer .community-event-location')?.remove();
      content.querySelector('.community-interest-count')?.remove();
      if (focusedTab === 'details' || focusedTab === 'interested') modal.content.querySelector<HTMLElement>(`[data-event-tab="${focusedTab}"]`)?.focus();
    };
    const loadMembers = async (reset: boolean) => {
      cancelMembers();
      if (reset) { members = []; cursor = null; }
      const current = generation;
      loading = true;
      failed = false;
      requestId = crypto.randomUUID();
      render();
      try {
        const response = await this.feed.client.sendRequest<unknown>(MessageType.EVENT_GET_INTERESTED, {
          id: event.id, ...(cursor ? { cursor } : {}), limit: 50,
        }, requestId);
        if (modal.signal.aborted || current !== generation) return;
        const result = eventInterestedListResultSchema.parse(response);
        if (result.id !== event.id) throw new Error(t('community.changed'));
        members = [...new Map([...members, ...result.users].map(member => [member.id, member])).values()];
        cursor = result.nextCursor;
      } catch (error) {
        if (modal.signal.aborted || current !== generation) return;
        console.warn('[Community] Interested members could not be loaded.', error);
        failed = true;
      } finally {
        if (!modal.signal.aborted && current === generation) { requestId = null; loading = false; render(); }
      }
    };
    modal.content.addEventListener('click', click => {
      const target = click.target instanceof Element ? click.target.closest<HTMLElement>('[data-event-tab], [data-interested-more]') : null;
      if (!target) return;
      if (target.hasAttribute('data-interested-more')) { void loadMembers(false); return; }
      tab = target.dataset.eventTab === 'interested' ? 'interested' : 'details';
      if (tab === 'interested') void loadMembers(true);
      else { cancelMembers(); render(); }
    }, { signal: modal.signal });
    modal.content.addEventListener('keydown', key => {
      if (!(key.target instanceof Element) || !key.target.closest('[data-event-tab]')) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key.key)) return;
      key.preventDefault();
      const next = key.key === 'Home' ? 'details' : key.key === 'End' ? 'interested' : tab === 'details' ? 'interested' : 'details';
      modal.content.querySelector<HTMLButtonElement>(`[data-event-tab="${next}"]`)?.click();
      modal.content.querySelector<HTMLElement>(`[data-event-tab="${next}"]`)?.focus();
    }, { signal: modal.signal });
    this.bindEventActions(modal, () => [event]);
    const unbind = this.feed.subscribe(() => {
      if (!this.feed.snapshot?.settings.eventsEnabled) { modal.close(true); return; }
      const current = this.feed.snapshot?.events.find((entry) => entry.id === event.id);
      detailAbort.abort();
      detailAbort = new AbortController();
      cancelMembers();
      if (current) {
        event = current;
        render();
        if (tab === 'interested') void loadMembers(true);
      } else {
        // Links may target an event outside the bounded snapshot, including historical events.
        const signal = AbortSignal.any([modal.signal, detailAbort.signal]);
        modal.content.textContent = t('community.loadingEvent');
        void (async () => {
          try {
            const result = await this.getEvent(event.id, signal);
            if (signal.aborted) return;
            event = result;
            render();
            if (tab === 'interested') await loadMembers(true);
          } catch (error) {
            if (signal.aborted) return;
            console.warn('[Community] Event refresh failed.', error);
            modal.content.textContent = '';
            modal.fail(error instanceof Error ? error.message : t('community.loadError'));
          }
        })();
      }
    });
    modal.signal.addEventListener('abort', () => { unbind(); cancelMembers(); detailAbort.abort(); }, { once: true });
    render();
  }

  private confirmStart(event: ServerEventPublic): void {
    const modal = this.modal(event.title);
    modal.element.querySelector('.community-modal')?.classList.add('event-start-modal');
    modal.content.innerHTML = `<p class="event-wizard-hint">${t('community.startHint')}</p>${this.eventHtml(event, true)}
      <div data-event-id="${escapeHtml(event.id)}"><button type="button" class="btn btn-primary event-start-confirm" data-event-action="confirm-start">${t('community.start')}</button></div>`;
    modal.content.querySelector('.community-actions')?.remove();
    this.bindEventActions(modal, () => [event]);
    const unbind = this.feed.subscribe(() => {
      const current = this.feed.snapshot?.events.find(item => item.id === event.id);
      if (!current || current.revision !== event.revision) modal.close(true);
    });
    modal.signal.addEventListener('abort', unbind, { once: true });
  }

  private openActions(): void {
    const modal = this.modal(t('community.liveActions'));
    modal.element.querySelector('.community-modal')?.classList.add('event-list-modal', 'live-action-list-modal');
    const header = modal.element.querySelector('.modal-header');
    const canCreate = this.liveActionChannels().length > 0 &&
      (this.feed.server.serverDetails?.protocol?.features.includes('native-polls') ||
        this.feed.server.serverDetails?.protocol?.features.includes('native-live-forms'));
    if (canCreate && header) {
      const create = document.createElement('button');
      create.className = 'btn btn-primary';
      create.dataset.createLiveAction = '';
      create.textContent = t('liveAction.create');
      header.insertBefore(create, header.querySelector('[data-community-close]'));
      create.addEventListener('click', () => this.openCreateLiveAction(), { signal: modal.signal });
    }
    const render = () => {
      const actions = this.feed.snapshot?.liveActions ?? [];
      const polls = this.feed.snapshot?.polls ?? [];
      const forms = this.feed.snapshot?.nativeForms ?? [];
      const count = actions.length + polls.length + forms.length;
      const title = modal.element.querySelector('.modal-title');
      if (title) title.innerHTML = `<span class="material-symbols-outlined md-24">bolt</span>${escapeHtml(t(count === 1 ? 'community.oneLiveAction' : 'community.liveActionCount', { count }))}`;
      const actionCards = actions.map((action) => {
        const channel = this.feed.server.getChannel(action.channelId);
        const canManage = this.canCloseLiveAction(action);
        return `<article class="community-event-row live-action-card" data-live-action-card="${escapeHtml(action.id)}">
          ${action.imageUrls[0] ? `<img class="live-action-card-image ${imageCarouselPresentationClass(action.imagePresentation)}"
            src="${escapeHtml(this.feed.client.getHttpBaseUrl() + action.imageUrls[0])}" alt="">` : ''}
          <div class="community-event-content">
            <small class="community-live-label"><span class="community-live-dot"></span>${t('community.liveActions')}
              ${action.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}</small>
            <h3>${escapeHtml(action.title)}</h3>
            <p>${escapeHtml(action.description)}</p>
          </div>
          <footer class="community-event-footer">
            <span class="community-event-location"><span class="material-symbols-outlined md-16">tag</span>${escapeHtml(channel?.name ?? '')}</span>
            <div class="community-actions">
              ${canManage ? `<button type="button" class="btn btn-secondary event-more" data-live-action-menu="action"
                aria-haspopup="menu" aria-label="${escapeHtml(t('common.moreOptions'))}"><span class="material-symbols-outlined md-18">more_horiz</span></button>` : ''}
              <button type="button" class="btn btn-primary" data-live-action="${escapeHtml(action.id)}">${t('community.open')}</button>
            </div>
          </footer>
        </article>`;
      });
      const pollCards = polls.map(poll => {
        const channel = this.feed.server.getChannel(poll.channelId);
        const canManage = this.feed.server.currentUser?.id === poll.creatorUserId ||
          this.feed.server.hasPermission(Permission.MANAGE_SERVER) ||
          this.feed.server.hasPermission(Permission.EMIT_LIVE_ACTIONS, poll.channelId);
        return `<article class="community-event-row live-action-card" data-live-poll-card="${escapeHtml(poll.id)}">
          ${poll.imageUrls[0] ? `<img class="live-action-card-image" src="${escapeHtml(this.feed.client.getHttpBaseUrl() + poll.imageUrls[0])}" alt="">` : ''}
          <div class="community-event-content">
            <small class="community-live-label"><span class="community-live-dot"></span>${t('poll.liveAction')}
              ${poll.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}</small>
            <h3>${escapeHtml(poll.question)}</h3>
            <p>${t(poll.totalVotes === 1 ? 'poll.oneVote' : 'poll.voteCount', { count: poll.totalVotes })}</p>
          </div>
          <footer class="community-event-footer">
            <span class="community-event-location"><span class="material-symbols-outlined md-16">tag</span>${escapeHtml(channel?.name ?? '')}</span>
            <div class="community-actions">
              ${canManage ? `<button type="button" class="btn btn-secondary event-more" data-live-action-menu="poll"
                aria-haspopup="menu" aria-label="${escapeHtml(t('common.moreOptions'))}"><span class="material-symbols-outlined md-18">more_horiz</span></button>` : ''}
              <button type="button" class="btn btn-primary" data-live-poll="${escapeHtml(poll.id)}">${t('community.open')}</button>
            </div>
          </footer>
        </article>`;
      });
      const formCards = forms.map(form => {
        const channel = this.feed.server.getChannel(form.channelId);
        const canManage = this.canManageNativeForm(form);
        return `<article class="community-event-row live-action-card" data-native-live-form-card="${escapeHtml(form.id)}">
          <div class="community-event-content">
            <small class="community-live-label"><span class="community-live-dot"></span>${t('liveForm.kind')}
              ${form.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}</small>
            <h3>${escapeHtml(form.form.title)}</h3>
            <p>${escapeHtml(form.form.description ?? t('liveForm.noDescription'))}</p>
          </div>
          <footer class="community-event-footer">
            <span class="community-event-location"><span class="material-symbols-outlined md-16">tag</span>${escapeHtml(channel?.name ?? '')}</span>
            <div class="community-actions">
              ${canManage ? `<button type="button" class="btn btn-secondary event-more" data-live-action-menu="form"
                aria-haspopup="menu" aria-label="${escapeHtml(t('common.moreOptions'))}"><span class="material-symbols-outlined md-18">more_horiz</span></button>` : ''}
              <button type="button" class="btn btn-primary" data-native-live-form="${escapeHtml(form.id)}">${t('community.open')}</button>
            </div>
          </footer>
        </article>`;
      });
      modal.content.innerHTML = count ? [...actionCards, ...pollCards, ...formCards].join('') : `<div class="community-empty live-action-empty">
        <span class="material-symbols-outlined">bolt</span>
        <h2>${t('community.emptyActions')}</h2>
        <p>${t('community.emptyActionsHint')}</p>
      </div>`;
    };
    modal.content.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const menuButton = target?.closest<HTMLButtonElement>('[data-live-action-menu]');
      if (menuButton) {
        const rect = menuButton.getBoundingClientRect();
        if (menuButton.dataset.liveActionMenu === 'action') {
          const id = menuButton.closest<HTMLElement>('[data-live-action-card]')?.dataset.liveActionCard;
          const action = this.feed.snapshot?.liveActions.find(entry => entry.id === id);
          if (action) contextMenu.open(rect.left, rect.bottom, [{
            label: t('community.closeLiveAction'),
            danger: true,
            onClick: () => this.runCloseLiveAction(modal, action, menuButton),
          }], menuButton);
        } else if (menuButton.dataset.liveActionMenu === 'poll') {
          const id = menuButton.closest<HTMLElement>('[data-live-poll-card]')?.dataset.livePollCard;
          const poll = (this.feed.snapshot?.polls ?? []).find(entry => entry.id === id);
          if (poll) contextMenu.open(rect.left, rect.bottom, [{
            label: t('community.closeLiveAction'),
            danger: true,
            onClick: () => this.runCloseNativePoll(modal, poll, menuButton),
          }], menuButton);
        } else {
          const id = menuButton.closest<HTMLElement>('[data-native-live-form-card]')?.dataset.nativeLiveFormCard;
          const form = (this.feed.snapshot?.nativeForms ?? []).find(entry => entry.id === id);
          if (form) contextMenu.open(rect.left, rect.bottom, [{
            label: t('liveForm.viewResults', { count: form.responseCount }),
            onClick: () => this.openNativeFormResults(form),
          }, {
            label: t('community.closeLiveAction'),
            danger: true,
            onClick: () => this.runCloseNativeForm(modal, form, menuButton),
          }], menuButton);
        }
        return;
      }
      const id = target?.closest<HTMLElement>('[data-live-action]')?.dataset.liveAction;
      const action = this.feed.snapshot?.liveActions.find((entry) => entry.id === id);
      if (action) void this.openAction(action);
      const pollId = target?.closest<HTMLElement>('[data-live-poll]')?.dataset.livePoll;
      const poll = (this.feed.snapshot?.polls ?? []).find(entry => entry.id === pollId);
      if (poll) this.openPollAction(poll);
      const formId = target?.closest<HTMLElement>('[data-native-live-form]')?.dataset.nativeLiveForm;
      const form = (this.feed.snapshot?.nativeForms ?? []).find(entry => entry.id === formId);
      if (form) this.openNativeFormAction(form);
    }, { signal: modal.signal });
    const unbind = this.feed.subscribe(render);
    modal.signal.addEventListener('abort', unbind, { once: true });
    render();
  }

  private liveActionChannels() {
    return this.feed.server.serverDetails?.channels.filter(channel =>
      !channel.forumId && (channel.type === 'TEXT' || channel.type === 'VOICE') &&
      this.feed.server.hasPermission(Permission.EMIT_LIVE_ACTIONS, channel.id)) ?? [];
  }

  private openCreateLiveAction(): void {
    const modal = this.modal(t('liveAction.create'));
    modal.element.querySelector('.community-modal')?.classList.add('live-action-create-modal');
    const channels = this.liveActionChannels();
    const canPoll = channels.some(channel => this.feed.server.hasPermission(Permission.SEND_MESSAGES, channel.id)) &&
      !!this.feed.server.serverDetails?.protocol?.features.includes('native-polls');
    const canForm = !!this.feed.server.serverDetails?.protocol?.features.includes('native-live-forms');
    modal.content.innerHTML = `<p class="event-wizard-hint">${t('liveAction.createHint')}</p>
      <label>${t('liveAction.channel')}<select class="input-field" data-live-action-channel>
        ${channels.map(channel => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.name)}</option>`).join('')}
      </select></label>
      <div class="live-action-type-grid">
        ${canPoll ? `<button type="button" class="live-action-type-card" data-live-action-type="poll">
          <span class="material-symbols-outlined">poll</span><strong>${t('liveAction.poll')}</strong>
          <small>${t('liveAction.pollHint')}</small></button>` : ''}
        ${canForm ? `<button type="button" class="live-action-type-card" data-live-action-type="form">
          <span class="material-symbols-outlined">dynamic_form</span><strong>${t('liveAction.form')}</strong>
          <small>${t('liveAction.formHint')}</small></button>` : ''}
      </div>`;
    if (channels.length === 0) modal.fail(t('liveAction.noChannels'));
    modal.content.addEventListener('click', event => {
      const type = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-live-action-type]')?.dataset.liveActionType : undefined;
      if (!type) return;
      const channelId = modal.content.querySelector<HTMLSelectElement>('[data-live-action-channel]')?.value;
      if (!channelId) { modal.fail(t('liveAction.noChannels')); return; }
      if (!this.feed.server.hasPermission(Permission.EMIT_LIVE_ACTIONS, channelId) ||
          type === 'poll' && !this.feed.server.hasPermission(Permission.SEND_MESSAGES, channelId)) {
        modal.fail(t('protocolError.permissionDenied'));
        return;
      }
      modal.close(true);
      queueMicrotask(() => {
        if (type === 'poll') {
          openNativePollWizard(this.feed.client, this.feed.server, channelId, {
            liveAction: true,
            lockLiveAction: true,
          });
        } else {
          openNativeLiveFormWizard(this.feed.client, this.feed.server, channelId);
        }
      });
    }, { signal: modal.signal });
  }

  private openPollAction(initial: NativePoll): void {
    const modal = this.modal(t('poll.liveAction'));
    modal.element.querySelector('.community-modal')?.classList.add('event-detail-modal', 'live-action-detail-modal');
    let poll = initial;
    let pending = false;
    const formatTime = (value: number) => new Intl.DateTimeFormat(getLanguage(), {
      dateStyle: 'short', timeStyle: 'short',
    }).format(value);
    const render = () => {
      modal.content.innerHTML = `${renderNativePoll(
        poll,
        !pending && this.feed.server.hasPermission(Permission.SEND_MESSAGES, poll.channelId),
        formatTime,
        this.feed.client.getHttpBaseUrl(),
      )}`;
    };
    modal.content.addEventListener('click', event => {
      const carouselButton = imageCarouselNavigationButton(event.target);
      if (carouselButton && moveImageCarousel(carouselButton)) return;
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-native-poll][data-native-poll-option]') : null;
      const confirm = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-native-poll-confirm]') : null;
      const card = (button ?? confirm)?.closest<HTMLElement>('[data-native-poll-card]');
      if (confirm && confirm.dataset.nativePollConfirm && !confirm.disabled && !pending) {
        const optionIds = [...card?.querySelectorAll<HTMLButtonElement>('[data-native-poll-option][aria-pressed="true"]') ?? []]
          .map(option => option.dataset.nativePollOption).filter((id): id is string => !!id);
        if (optionIds.length === 0) return;
        pending = true;
        void modal.run(async () => {
          try {
            poll = await submitNativePollVote(this.feed.client, confirm.dataset.nativePollConfirm!, optionIds);
          } finally {
            pending = false;
            if (!modal.signal.aborted) render();
          }
        });
        return;
      }
      if (!button?.dataset.nativePoll || !button.dataset.nativePollOption || pending) return;
      if (card?.dataset.pollMultiple === 'true') {
        const selected = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('native-poll-option--selected', selected);
        const submit = card.querySelector<HTMLButtonElement>('[data-native-poll-confirm]');
        if (submit) submit.disabled = card.querySelectorAll('[data-native-poll-option][aria-pressed="true"]').length === 0;
        return;
      }
      pending = true;
      render();
      void modal.run(async () => {
        try {
          poll = await submitNativePollVote(
            this.feed.client,
            button.dataset.nativePoll!,
            [button.dataset.nativePollOption!],
          );
          if (!modal.signal.aborted) render();
        } finally {
          pending = false;
          if (!modal.signal.aborted) render();
        }
      });
    }, { signal: modal.signal });
    const unbind = this.feed.subscribe(() => {
      const current = (this.feed.snapshot?.polls ?? []).find(entry => entry.id === poll.id);
      if (!current) { modal.close(true); return; }
      poll = current.myVoteOptionIds === null && poll.myVoteOptionIds !== null
        ? { ...current, myVoteOptionIds: poll.myVoteOptionIds }
        : current;
      render();
    });
    modal.signal.addEventListener('abort', unbind, { once: true });
    render();
  }

  private runCloseNativePoll(
    modal: ReturnType<typeof openCommunityModal>,
    poll: NativePoll,
    button: HTMLButtonElement,
  ): void {
    if (button.disabled || modal.signal.aborted) return;
    button.disabled = true;
    void modal.run(async () => {
      try {
        if (!await showConfirm({
          message: t('community.confirmCloseLiveAction'),
          confirmLabel: t('community.closeLiveAction'),
          variant: 'danger',
          signal: modal.signal,
        })) return;
        await this.feed.client.sendRequest(MessageType.POLL_CLOSE, { id: poll.id });
        if (!modal.signal.aborted) {
          showInfoToast(t('community.liveActionClosed'));
          modal.close();
        }
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }

  private canManageNativeForm(form: NativeLiveForm): boolean {
    return this.feed.server.currentUser?.id === form.creatorUserId ||
      this.feed.server.hasPermission(Permission.MANAGE_SERVER) ||
      this.feed.server.hasPermission(Permission.EMIT_LIVE_ACTIONS, form.channelId);
  }

  private runCloseNativeForm(
    modal: ReturnType<typeof openCommunityModal>,
    form: NativeLiveForm,
    button: HTMLButtonElement,
  ): void {
    if (button.disabled || modal.signal.aborted) return;
    button.disabled = true;
    void modal.run(async () => {
      try {
        if (!await showConfirm({
          message: t('community.confirmCloseLiveAction'),
          confirmLabel: t('community.closeLiveAction'),
          variant: 'danger',
          signal: modal.signal,
        })) return;
        await this.feed.client.sendRequest(MessageType.NATIVE_FORM_CLOSE, { id: form.id });
        if (!modal.signal.aborted) {
          showInfoToast(t('community.liveActionClosed'));
          modal.close();
        }
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }

  private openNativeFormAction(initial: NativeLiveForm): void {
    const modal = this.modal(initial.form.title);
    modal.element.querySelector('.community-modal')?.classList.add(
      'event-wizard',
      'live-action-wizard',
      'native-live-form-action-modal',
    );
    let form = initial;
    let values = form.myResponse?.values ?? initialBotInputValues(form.form.fields);
    let pending = false;
    const fieldContext = () => ({
      prefix: `native-form-${form.id}`,
      disabled: pending,
      nativeForm: true,
      persistentSelection: true,
      members: [...this.feed.server.knownMembers.values()],
    });
    const clearFieldError = (target: EventTarget | null) => {
      const question = target instanceof Element ? target.closest<HTMLElement>('.native-form-question') : null;
      if (!question) return;
      question.classList.remove('native-form-question--invalid');
      question.removeAttribute('aria-invalid');
      question.querySelector('[data-native-form-field-error]')?.remove();
      modal.clearError();
    };
    const updateClearButton = (target: EventTarget | null) => {
      const question = target instanceof Element ? target.closest<HTMLElement>('.native-form-question') : null;
      const name = question?.dataset.fieldName;
      const clear = question?.querySelector<HTMLButtonElement>('.bot-field-clear');
      if (!name || !clear) return;
      const value = values[name];
      clear.hidden = value === undefined || value === null
        || (typeof value === 'string' && value.trim().length === 0)
        || (Array.isArray(value) && value.length === 0);
    };
    const showFieldError = (fieldName: string, reason: Parameters<typeof botInputError>[2]) => {
      const question = modal.content.querySelector<HTMLElement>(
        `[data-field-name="${CSS.escape(fieldName)}"]`,
      );
      if (!question) { modal.fail(t('community.invalidResponse')); return; }
      const message = botInputError(form.form.fields, fieldName, reason);
      question.classList.add('native-form-question--invalid');
      question.setAttribute('aria-invalid', 'true');
      const error = document.createElement('p');
      error.dataset.nativeFormFieldError = '';
      error.className = 'native-form-field-error';
      error.setAttribute('role', 'alert');
      error.textContent = message;
      question.append(error);
      modal.fail(message);
      const scroller = modal.content.querySelector<HTMLElement>('.live-action-step');
      if (scroller) scrollWithin(scroller, question, 16);
      question.querySelector<HTMLElement>(
        '[data-bot-input], [data-bot-select-value], [data-field-action], select, input, textarea, button:not(:disabled)',
      )?.focus({ preventScroll: true });
    };
    const render = () => {
      modal.content.innerHTML = `<header class="native-form-action-header">
        <h2 tabindex="-1">${escapeHtml(form.form.title)}
          ${form.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}</h2>
        <button type="button" class="native-form-action-close" data-native-form-cancel
          aria-label="${escapeHtml(t('common.close'))}" title="${escapeHtml(t('common.close'))}" ${pending ? 'disabled' : ''}>
          <span class="material-symbols-outlined md-20" aria-hidden="true">close</span>
        </button>
        </header>
        <section class="live-action-step">
          ${form.form.description ? `<p class="event-wizard-hint">${escapeHtml(form.form.description)}</p>` : ''}
          ${renderBotFields(form.form.fields, values, fieldContext())}
        </section>
        <footer class="modal-footer event-wizard-footer live-action-footer">
          <span class="event-footer-spacer"></span>
          <button type="button" class="btn btn-secondary" data-native-form-cancel ${pending ? 'disabled' : ''}>${t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" data-native-form-submit ${pending ? 'disabled' : ''}>${escapeHtml(form.form.submitLabel ?? t('liveForm.submit'))}</button>
        </footer>`;
    };
    modal.content.addEventListener('input', event => {
      clearFieldError(event.target);
      values = readBotFieldChange(event.target, form.form.fields, values) ?? values;
      updateClearButton(event.target);
    }, { signal: modal.signal });
    modal.content.addEventListener('change', event => {
      clearFieldError(event.target);
      values = readBotFieldChange(event.target, form.form.fields, values) ?? values;
      updateClearButton(event.target);
    }, { signal: modal.signal });
    modal.content.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-native-form-cancel]')) { modal.close(); return; }
      if (pending) return;
      const choice = target?.closest<HTMLElement>('[data-bot-select-value]');
      if (choice) {
        clearFieldError(choice);
        const name = choice.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
        if (name && choice.dataset.botSelectValue !== undefined) {
          values = { ...values, [name]: choice.dataset.botSelectValue };
          render();
        }
        return;
      }
      const fieldButton = target?.closest<HTMLButtonElement>('[data-field-action]');
      if (fieldButton) {
        clearFieldError(fieldButton);
        values = applyBotFieldAction(fieldButton, form.form.fields, values, fieldContext()) ?? values;
        return;
      }
      if (!target?.closest('[data-native-form-submit]')) return;
      const parsed = validateNativeLiveFormValues(form.form, convertBotInputValues(form.form.fields, values));
      if (!parsed.success) { showFieldError(parsed.field, parsed.reason); return; }
      pending = true;
      render();
      void modal.run(async () => {
        try {
          const updated = nativeLiveFormSchema.parse(await this.feed.client.sendRequest(
            MessageType.NATIVE_FORM_SUBMIT,
            { id: form.id, expectedRevision: form.revision, values: parsed.values },
          ));
          form = updated;
          values = updated.myResponse?.values ?? values;
          if (!modal.signal.aborted) {
            showInfoToast(t(updated.myResponse?.createdAt === updated.myResponse?.updatedAt
              ? 'liveForm.responseSent' : 'liveForm.responseUpdated'));
            modal.close();
          }
        } catch (error) {
          pending = false;
          if (!modal.signal.aborted) render();
          throw error;
        } finally { pending = false; }
      });
    }, { signal: modal.signal });
    const unbind = this.feed.subscribe(() => {
      const current = (this.feed.snapshot?.nativeForms ?? []).find(entry => entry.id === form.id);
      if (!current) { modal.close(true); return; }
      form = current;
      if (current.myResponse) values = current.myResponse.values;
      render();
    });
    modal.signal.addEventListener('abort', unbind, { once: true });
    render();
  }

  private openNativeFormResults(form: NativeLiveForm): void {
    const modal = this.modal(t('liveForm.resultsTitle', { title: form.form.title }));
    modal.element.querySelector('.community-modal')?.classList.add('native-live-form-results-modal');
    let responses: NativeLiveFormResults['responses'] = [];
    let loading = false;
    let exporting = false;
    let tab: 'summary' | 'question' | 'individual' = 'summary';
    let questionIndex = 0;
    let responseIndex = 0;
    let questionPage = 0;
    let expandedAnswerGroup: number | null = null;
    const QUESTION_PAGE_SIZE = 20;
    const dateFormatter = new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'short', timeStyle: 'short' });
    const valueLabel = (name: string, value: unknown): string => {
      const field = form.form.fields.find(entry => entry.name === name);
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
        return t('liveForm.noAnswer');
      }
      if (field?.type === 'boolean') return t(value === true ? 'botChat.switchOn' : 'botChat.switchOff');
      if (field?.type === 'select') {
        return field.choices.find(choice => choice.value === value)?.label ?? String(value ?? '');
      }
      if (field?.type === 'multi-select' && Array.isArray(value)) {
        return value.map(entry =>
          field.choices.find(choice => choice.value === entry)?.label ?? String(entry),
        ).join(', ');
      }
      if (field?.type === 'rating' && typeof value === 'number') {
        return t('liveForm.ratingResult', { value });
      }
      return String(value);
    };
    const aggregateField = (fieldIndex: number, includeTextAnswers = true): string => {
      const field = form.form.fields[fieldIndex];
      if (!field) return '';
      const answered = responses.filter(entry => {
        const value = entry.response.values[field.name];
        return value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
      });
      let categories: Array<{ value: string | number | boolean; label: string }> | null = field.type === 'boolean'
        ? [{ value: true, label: t('botChat.switchOn') }, { value: false, label: t('botChat.switchOff') }]
        : field.type === 'select' || field.type === 'multi-select'
          ? field.choices.map(choice => ({ value: choice.value, label: choice.label }))
          : field.type === 'rating'
            ? Array.from({ length: 5 }, (_, index) => ({
              value: index + 1,
              label: t('liveForm.ratingResult', { value: index + 1 }),
            }))
            : null;
      if (field.type === 'integer' && answered.length) {
        const values = [...new Set(answered.map(entry => Number(entry.response.values[field.name])))]
          .filter(Number.isFinite).sort((a, b) => a - b);
        if (values.length <= 10) categories = values.map(value => ({ value, label: String(value) }));
      }
      const stats = categories?.map(category => {
        const count = answered.filter(entry => {
          const value = entry.response.values[field.name];
          return Array.isArray(value) ? value.includes(String(category.value)) : value === category.value;
        }).length;
        const share = answered.length ? Number((count * 100 / answered.length).toFixed(2)) : 0;
        return { ...category, count, share, percentage: Math.round(share) };
      });
      if (!stats && !includeTextAnswers) return '';
      const useDonut = answered.length > 0 && (field.type === 'boolean' || field.type === 'select');
      const body = stats && useDonut ? `<figure class="native-form-result-donut"
          aria-label="${escapeHtml(t('liveForm.chartLabel', { question: field.label }))}">
        <svg viewBox="0 0 42 42" aria-hidden="true">
          <circle class="native-form-result-donut-track" cx="21" cy="21" r="15.9"></circle>
          ${stats.reduce((result, item, index, list) => {
            const offset = list.slice(0, index).reduce((sum, entry) => sum + entry.share, 0);
            if (!item.share) return result;
            return `${result}<circle class="native-form-result-donut-segment chart-color-${index % 8}"
              cx="21" cy="21" r="15.9" pathLength="100"
              stroke-dasharray="${item.share} ${100 - item.share}"
              stroke-dashoffset="${-offset}"></circle>`;
          }, '')}
        </svg>
        <figcaption>${stats.map((item, index) => `<div>
          <i class="chart-color-${index % 8}" aria-hidden="true"></i>
          <span>${escapeHtml(item.label)}</span><strong>${item.count} (${item.percentage}%)</strong>
        </div>`).join('')}</figcaption>
      </figure>` : stats ? `<div class="native-form-result-bars">${stats.map((item, index) => `
        <div class="native-form-result-bar ${field.type === 'rating'
          ? `rating-color-${index + 1}` : `chart-color-${index % 8}`}">
          <div><span>${escapeHtml(item.label)}</span><strong>${item.count} (${item.percentage}%)</strong></div>
          <span aria-hidden="true"><i style="width:${item.share}%"></i></span>
        </div>`).join('')}</div>` : `<ul class="native-form-text-results" data-native-summary-text="${fieldIndex}"
        data-next-offset="${Math.min(20, answered.length)}" tabindex="0"
        aria-label="${escapeHtml(field.label)}">${answered.slice(0, 20).map(entry =>
        `        <li><span>${escapeHtml(valueLabel(field.name, entry.response.values[field.name]))}</span>
          ${entry.user ? `<small>${escapeHtml(entry.user.nickname)}</small>` : ''}</li>`,
      ).join('')}${answered.length > 20 ? `<li class="native-form-more-answers" data-native-summary-text-more>
        ${t('liveForm.moreTextAnswers', { count: answered.length - 20 })}</li>` : ''}</ul>`;
      return `<article class="native-form-result-question">
        <header><h3>${escapeHtml(field.label)}</h3>
          <span>${t('liveForm.answerCount', { count: answered.length })}</span></header>
        ${body}
      </article>`;
    };
    const appendSummaryTextAnswers = (list: HTMLElement): void => {
      const fieldIndex = Number(list.dataset.nativeSummaryText);
      const field = form.form.fields[fieldIndex];
      const offset = Number(list.dataset.nextOffset ?? 20);
      if (!field || !Number.isInteger(offset)) return;
      const answered = responses.filter(entry => {
        const value = entry.response.values[field.name];
        return value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
      });
      list.querySelector('[data-native-summary-text-more]')?.remove();
      for (const entry of answered.slice(offset, offset + 20)) {
        const item = document.createElement('li');
        const answer = document.createElement('span');
        answer.textContent = valueLabel(field.name, entry.response.values[field.name]);
        item.append(answer);
        if (entry.user) {
          const respondent = document.createElement('small');
          respondent.textContent = entry.user.nickname;
          item.append(respondent);
        }
        list.append(item);
      }
      const nextOffset = Math.min(offset + 20, answered.length);
      list.dataset.nextOffset = String(nextOffset);
      if (nextOffset < answered.length) {
        const more = document.createElement('li');
        more.className = 'native-form-more-answers';
        more.dataset.nativeSummaryTextMore = '';
        more.textContent = t('liveForm.moreTextAnswers', { count: answered.length - nextOffset });
        list.append(more);
      }
    };
    const tabs = () => `<nav class="native-form-results-tabs" role="tablist" aria-label="${escapeHtml(t('liveForm.resultsTitle', { title: form.form.title }))}">
      ${(['summary', 'question', 'individual'] as const).map(value => `<button type="button" role="tab"
        aria-selected="${tab === value}" data-native-form-results-tab="${value}">${t(`liveForm.results${value[0].toUpperCase()}${value.slice(1)}` as Parameters<typeof t>[0])}</button>`).join('')}
    </nav>`;
    const navigation = (kind: 'question' | 'response', index: number, total: number) =>
      `<div class="native-live-form-results-navigation">
        <button type="button" class="btn btn-secondary" data-native-form-${kind}-previous
          aria-label="${escapeHtml(t('common.previous'))}" ${index <= 0 ? 'disabled' : ''}>
          <span class="material-symbols-outlined">chevron_left</span></button>
        <span class="native-live-form-results-position">${t(kind === 'question'
          ? 'liveForm.questionPosition' : 'liveForm.responsePosition', { current: index + 1, total })}</span>
        <button type="button" class="btn btn-secondary" data-native-form-${kind}-next
          aria-label="${escapeHtml(t('common.next'))}" ${index >= total - 1 ? 'disabled' : ''}>
          <span class="material-symbols-outlined">chevron_right</span></button>
      </div>`;
    const responseLabel = (index: number): string => {
      const entry = responses[index];
      return entry?.user?.nickname ?? t('liveForm.anonymousResponse', { number: index + 1 });
    };
    const questionAnswers = (showFieldTitle: boolean): string => {
      const field = form.form.fields[questionIndex];
      if (!field) return '';
      const groups = new Map<string, { label: string; responseIndices: number[] }>();
      for (const [index, entry] of responses.entries()) {
        const value = entry.response.values[field.name];
        const key = JSON.stringify(Array.isArray(value) ? [...value].sort() : value ?? null);
        const current = groups.get(key);
        if (current) current.responseIndices.push(index);
        else groups.set(key, { label: valueLabel(field.name, value), responseIndices: [index] });
      }
      const entries = [...groups.values()];
      const pages = Math.max(1, Math.ceil(entries.length / QUESTION_PAGE_SIZE));
      questionPage = Math.min(questionPage, pages - 1);
      const offset = questionPage * QUESTION_PAGE_SIZE;
      const visible = entries.slice(offset, offset + QUESTION_PAGE_SIZE);
      return `<section class="native-form-question-answers">
        <header><h3>${showFieldTitle ? escapeHtml(field.label) : t('liveForm.answers')}</h3>
          <span>${t('liveForm.answerCount', { count: responses.length })}</span></header>
        <div class="native-form-question-answer-list">${visible.map((group, pageIndex) => {
          const groupIndex = offset + pageIndex;
          const duplicate = group.responseIndices.length > 1;
          return `<article class="native-form-question-answer">
            <button type="button" data-native-form-answer-group="${groupIndex}">
              <span>${escapeHtml(group.label)}</span>
              <strong>${group.responseIndices.length}</strong>
              <span class="material-symbols-outlined md-18">${duplicate ? 'expand_more' : 'arrow_forward'}</span>
            </button>
            ${duplicate && expandedAnswerGroup === groupIndex ? `<label>${t('liveForm.chooseResponse')}
              <select class="input-field" data-native-form-answer-target>
                <option value="">${t('liveForm.chooseResponse')}</option>
                ${group.responseIndices.map(index =>
                  `<option value="${index}">${escapeHtml(responseLabel(index))}</option>`,
                ).join('')}
              </select></label>` : ''}
          </article>`;
        }).join('')}</div>
        ${pages > 1 ? `<footer class="native-form-question-pagination">
          <button type="button" class="btn btn-secondary" data-native-form-question-page-previous
            aria-label="${escapeHtml(t('common.previous'))}" ${questionPage === 0 ? 'disabled' : ''}>
            <span class="material-symbols-outlined">chevron_left</span></button>
          <span>${t('liveForm.pagePosition', { current: questionPage + 1, total: pages })}</span>
          <button type="button" class="btn btn-secondary" data-native-form-question-page-next
            aria-label="${escapeHtml(t('common.next'))}" ${questionPage >= pages - 1 ? 'disabled' : ''}>
            <span class="material-symbols-outlined">chevron_right</span></button>
        </footer>` : ''}
      </section>`;
    };
    const individual = (): string => {
      const entry = responses[responseIndex];
      if (!entry) return '';
      return `<div class="native-live-form-results-toolbar">
        ${entry.user ? `<div class="native-live-form-results-person">
          <img src="${escapeHtml(entry.user.avatarUrl ?? DEFAULT_AVATAR_URL)}" alt="">
          <div><strong>${escapeHtml(entry.user.nickname)}</strong>
            <small>${'updatedAt' in entry.response ? dateFormatter.format(entry.response.updatedAt) : ''}</small></div>
        </div>` : `<div class="native-live-form-results-person native-live-form-results-person--anonymous">
          <span class="material-symbols-outlined">visibility_off</span>
          <div><strong>${escapeHtml(responseLabel(responseIndex))}</strong>
            <small>${t('liveForm.anonymousNotice')}</small></div>
        </div>`}
        ${navigation('response', responseIndex, responses.length)}
      </div>
      ${renderBotFields(form.form.fields, entry.response.values, {
        prefix: `native-form-result-${form.id}-${responseIndex}`,
        disabled: true,
        nativeForm: true,
        readOnly: true,
        persistentSelection: true,
        members: [...this.feed.server.knownMembers.values()],
      })}`;
    };
    const render = () => {
      if (loading) {
        modal.content.innerHTML = `<div class="community-empty"><span class="loading-spinner" aria-hidden="true"></span>
          <h2>${t('common.loading')}</h2></div>`;
        return;
      }
      if (!responses.length) {
        modal.content.innerHTML = `<div class="community-empty"><span class="material-symbols-outlined">inbox</span>
          <h2>${t('liveForm.noResponses')}</h2><p>${t('liveForm.noResponsesHint')}</p></div>`;
        return;
      }
      questionIndex = Math.min(questionIndex, form.form.fields.length - 1);
      responseIndex = Math.min(responseIndex, responses.length - 1);
      const body = tab === 'summary'
        ? `<div class="native-form-results-summary">${form.form.fields.map((_, index) => aggregateField(index)).join('')}</div>`
        : tab === 'question'
          ? (() => {
            const aggregate = aggregateField(questionIndex, false);
            return `<div class="native-form-results-question-view">
              <div class="native-live-form-results-toolbar">${navigation('question', questionIndex, form.form.fields.length)}</div>
              ${aggregate}${questionAnswers(!aggregate)}
            </div>`;
          })()
          : individual();
      modal.content.innerHTML = `<header class="native-form-results-header">
          <strong>${t('liveForm.responsesCount', { count: responses.length })}</strong>
          <button type="button" class="btn btn-secondary" data-native-form-export
            ${exporting ? 'disabled data-loading="1" aria-busy="true"' : ''}>
            <span class="material-symbols-outlined md-18">download</span>${t('liveForm.exportCsv')}</button>
        </header>
        ${tabs()}
        <section class="native-form-results-panel">${body}</section>`;
    };
    const load = () => {
      if (loading) return;
      loading = true;
      render();
      void modal.run(async () => {
        try {
          const all: NativeLiveFormResults['responses'] = [];
          let nextCursor: string | null = null;
          do {
            const result = nativeLiveFormResultsSchema.parse(await this.feed.client.sendRequest(
              MessageType.NATIVE_FORM_RESULTS,
              { id: form.id, ...(nextCursor ? { cursor: nextCursor } : {}), limit: 50 },
            ));
            all.push(...result.responses);
            nextCursor = result.nextCursor;
          } while (nextCursor && !modal.signal.aborted);
          responses = all;
        } finally {
          loading = false;
          if (!modal.signal.aborted) render();
        }
      });
    };
    const csvCell = (value: unknown): string => {
      let text = String(value ?? '').replace(/\r\n?/g, '\n');
      if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const exportCsv = () => {
      if (exporting || !responses.length) return;
      exporting = true;
      render();
      void modal.run(async () => {
        try {
          const rows = form.form.anonymous ? [
            form.form.fields.map(field => field.label),
            ...responses.map(entry =>
              form.form.fields.map(field => valueLabel(field.name, entry.response.values[field.name]))),
          ] : [
            [t('liveForm.csvRespondent'), t('liveForm.csvSubmittedAt'), ...form.form.fields.map(field => field.label)],
            ...responses.map(entry => [
              entry.user?.nickname ?? '',
              'updatedAt' in entry.response ? new Date(entry.response.updatedAt).toISOString() : '',
              ...form.form.fields.map(field => valueLabel(field.name, entry.response.values[field.name])),
            ]),
          ];
          const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
          const baseName = form.form.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'form';
          const result = await window.api.saveCsvFile(csv, `${baseName}.csv`);
          if (result.success) showInfoToast(t('liveForm.exportCsvSuccess'));
          else if (result.error) throw new Error(result.error);
        } finally {
          exporting = false;
          if (!modal.signal.aborted) render();
        }
      });
    };
    modal.content.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const tabButton = event.target.closest<HTMLElement>('[data-native-form-results-tab]');
      if (tabButton) {
        const next = tabButton.dataset.nativeFormResultsTab;
        if (next === 'summary' || next === 'question' || next === 'individual') { tab = next; render(); }
        return;
      }
      if (event.target.closest('[data-native-form-question-previous]') && questionIndex > 0) {
        questionIndex--; questionPage = 0; expandedAnswerGroup = null; render(); return;
      }
      if (event.target.closest('[data-native-form-question-next]') && questionIndex < form.form.fields.length - 1) {
        questionIndex++; questionPage = 0; expandedAnswerGroup = null; render(); return;
      }
      if (event.target.closest('[data-native-form-question-page-previous]') && questionPage > 0) {
        questionPage--; expandedAnswerGroup = null; render(); return;
      }
      if (event.target.closest('[data-native-form-question-page-next]')) {
        questionPage++; expandedAnswerGroup = null; render(); return;
      }
      if (event.target.closest('[data-native-form-response-previous]') && responseIndex > 0) {
        responseIndex--; render(); return;
      }
      if (event.target.closest('[data-native-form-response-next]') && responseIndex < responses.length - 1) {
        responseIndex++; render(); return;
      }
      const answerGroup = event.target.closest<HTMLElement>('[data-native-form-answer-group]');
      if (answerGroup) {
        const field = form.form.fields[questionIndex];
        if (!field) return;
        const groups = new Map<string, number[]>();
        for (const [index, entry] of responses.entries()) {
          const value = entry.response.values[field.name];
          const key = JSON.stringify(Array.isArray(value) ? [...value].sort() : value ?? null);
          const current = groups.get(key);
          if (current) current.push(index); else groups.set(key, [index]);
        }
        const indices = [...groups.values()][Number(answerGroup.dataset.nativeFormAnswerGroup)];
        if (!indices?.length) return;
        if (indices.length === 1) {
          responseIndex = indices[0];
          tab = 'individual';
        } else {
          expandedAnswerGroup = expandedAnswerGroup === Number(answerGroup.dataset.nativeFormAnswerGroup)
            ? null : Number(answerGroup.dataset.nativeFormAnswerGroup);
        }
        render();
        return;
      }
      if (event.target.closest('[data-native-form-export]')) exportCsv();
    }, { signal: modal.signal });
    modal.content.addEventListener('change', event => {
      const select = event.target instanceof Element
        ? event.target.closest<HTMLSelectElement>('[data-native-form-answer-target]') : null;
      if (!select || select.value === '') return;
      const index = Number(select.value);
      if (!Number.isInteger(index) || index < 0 || index >= responses.length) return;
      responseIndex = index;
      tab = 'individual';
      expandedAnswerGroup = null;
      render();
    }, { signal: modal.signal });
    modal.content.addEventListener('scroll', event => {
      const list = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-native-summary-text]') : null;
      if (!list || list.scrollTop + list.clientHeight < list.scrollHeight - 40 ||
          !list.querySelector('[data-native-summary-text-more]')) return;
      appendSummaryTextAnswers(list);
    }, { capture: true, signal: modal.signal });
    render();
    load();
  }

  private canCloseLiveAction(action: LiveAction): boolean {
    return this.feed.server.currentUser?.id === action.creatorUserId ||
      this.feed.server.hasPermission(Permission.MANAGE_SERVER) ||
      this.feed.server.hasPermission(Permission.EMIT_LIVE_ACTIONS, action.channelId);
  }

  private runCloseLiveAction(
    modal: ReturnType<typeof openCommunityModal>,
    action: LiveAction,
    button: HTMLButtonElement,
  ): void {
    if (button.disabled || modal.signal.aborted) return;
    button.disabled = true;
    void modal.run(async () => {
      try {
        if (!await showConfirm({
          message: t('community.confirmCloseLiveAction'),
          confirmLabel: t('community.closeLiveAction'),
          variant: 'danger',
          signal: modal.signal,
        })) return;
        await this.feed.client.sendRequest(MessageType.LIVE_ACTION_CLOSE, { id: action.id });
        if (!modal.signal.aborted) {
          showInfoToast(t('community.liveActionClosed'));
          modal.close();
        }
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }

  private async openAction(action: LiveAction): Promise<void> {
    const modal = this.modal(action.title);
    const card = modal.element.querySelector('.community-modal');
    card?.classList.add(action.content.kind === 'form' ? 'event-wizard' : 'event-detail-modal',
      action.content.kind === 'form' ? 'live-action-wizard' : 'live-action-detail-modal');
    const unbind = this.feed.subscribe(() => {
      const current = this.feed.snapshot?.liveActions.find((entry) => entry.id === action.id);
      if (!current || current.revision !== action.revision) modal.close(true);
    });
    modal.signal.addEventListener('abort', unbind, { once: true });
    if (action.content.kind === 'selector') {
      const selectorId = action.content.selectorId;
      await modal.run(async () => {
        const response = await this.feed.client.sendRequest<{ selectors: unknown[] }>(MessageType.SELECTOR_LIST, { channelId: action.channelId });
        if (modal.signal.aborted) return;
        const selector = response.selectors.map((entry) => botSelectorPublicSchema.parse(entry)).find((entry) => entry.id === selectorId);
        if (!selector) throw new Error(t('community.changed'));
        modal.content.innerHTML = `${renderImageCarousel(
          action.imageUrls, this.feed.client.getHttpBaseUrl(), action.title, action.imagePresentation,
        )}
          <div data-message-id="${escapeHtml(selector.messageId)}"><div class="chat-message-body">
          <p class="chat-message-text">${escapeHtml(selector.title)}</p></div></div>`;
        const view = new PublicSelectorView(modal.content, this.feed.client, this.feed.server, action.channelId);
        modal.signal.addEventListener('abort', () => view.destroy(), { once: true });
        modal.content.addEventListener('click', event => {
          const button = imageCarouselNavigationButton(event.target);
          if (button) { moveImageCarousel(button); return; }
        }, { signal: modal.signal });
      });
      return;
    }
    const form = action.content.form;
    let values = initialBotInputValues(form.fields);
    let pending = false;
    const fieldContext = () => ({
      prefix: `live-${action.id}`, disabled: pending, persistentSelection: true,
      members: [...this.feed.server.knownMembers.values()],
      imageUpload: { client: this.feed.client, channelId: action.channelId },
    });
    modal.signal.addEventListener('abort', audioPreviewService.bind(modal.content), { once: true });
    const render = () => {
      modal.content.innerHTML = `${renderImageCarousel(
        action.imageUrls, this.feed.client.getHttpBaseUrl(), action.title, action.imagePresentation,
      )}
        <section class="live-action-step">
          <h2 tabindex="-1">${escapeHtml(action.title)}
            ${action.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}</h2>
          <p class="event-wizard-hint">${escapeHtml(form.description ?? action.description)}</p>
          ${renderBotFields(form.fields, values, fieldContext())}
        </section>
        <footer class="modal-footer event-wizard-footer live-action-footer">
          <span class="event-footer-spacer"></span>
          <button type="button" class="btn btn-secondary" data-live-cancel ${pending ? 'disabled' : ''}>${t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" data-live-submit ${pending ? 'disabled' : ''}>${escapeHtml(form.submitLabel ?? t('common.confirm'))}</button>
        </footer>`;
    };
    modal.content.addEventListener('input', (event) => {
      values = readBotFieldChange(event.target, form.fields, values) ?? values;
    }, { signal: modal.signal });
    modal.content.addEventListener('change', (event) => {
      values = readBotFieldChange(event.target, form.fields, values) ?? values;
    }, { signal: modal.signal });
    modal.content.addEventListener('click', (event) => {
      const carouselButton = imageCarouselNavigationButton(event.target);
      if (carouselButton && moveImageCarousel(carouselButton)) return;
      const cancel = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-live-cancel]') : null;
      if (cancel && !pending) { modal.close(); return; }
      if (pending || audioPreviewService.ownsEventTarget(event.target)) return;
      const choice = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-bot-select-value]') : null;
      if (choice) {
        const name = choice.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
        if (name && choice.dataset.botSelectValue !== undefined) {
          values = { ...values, [name]: choice.dataset.botSelectValue };
          render();
          const field = [...modal.content.querySelectorAll<HTMLElement>('[data-field-name]')].find(item => item.dataset.fieldName === name);
          [...field?.querySelectorAll<HTMLElement>('[data-bot-select-value]') ?? []]
            .find(item => item.dataset.botSelectValue === values[name])?.focus();
        }
        return;
      }
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
      if (!button || pending) return;
      if (button.dataset.fieldAction) {
        if (button.dataset.fieldAction === 'image-add') {
          button.disabled = true;
          void modal.run(async () => {
            const next = await addBotFieldImage(button, form.fields, values, fieldContext());
            if (next) values = next;
          }).finally(() => { if (button.isConnected) button.disabled = false; });
          return;
        }
        values = applyBotFieldAction(button, form.fields, values, fieldContext()) ?? values;
        return;
      }
      if (!button.hasAttribute('data-live-submit')) return;
      void modal.run(async () => {
        const parsed = validateBotFormValues(form, convertBotInputValues(form.fields, values));
        if (!parsed.success) { modal.fail(t('community.invalidResponse')); return; }
        pending = true;
        render();
        try {
          await this.feed.client.sendRequest(MessageType.LIVE_ACTION_SUBMIT, {
            id: action.id, expectedRevision: action.revision, values: parsed.values, locale: getLanguage(),
          });
          if (!modal.signal.aborted) {
            showInfoToast(t('community.submitted'));
            modal.close();
          }
        } catch (error) {
          pending = false;
          if (!modal.signal.aborted) render();
          throw error;
        } finally { pending = false; }
      });
    }, { signal: modal.signal });
    modal.content.addEventListener('keydown', event => {
      if (pending || audioPreviewService.ownsEventTarget(event.target)) return;
      const option = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-bot-select-value]') : null;
      if (!option || option instanceof HTMLButtonElement) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); option.click(); return; }
      const options = [...option.closest('[data-bot-choice-list]')?.querySelectorAll<HTMLElement>('[data-bot-select-value]') ?? []];
      const index = options.indexOf(option);
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) :
        event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); options[next]?.focus(); }
    }, { signal: modal.signal });
    render();
  }

  destroy(): void {
    this.bannerTransition++;
    this.clearCopyFeedback?.();
    this.clearCopyFeedback = null;
    const banner = this.root.querySelector<HTMLElement>('.community-banner');
    if (banner) cancelVisibilityMotion(banner);
    this.setHeaderImage(null);
    this.abort.abort();
    for (const unbind of this.unbind) unbind();
    for (const close of [...this.modals]) close(true);
    this.root.replaceChildren();
  }
}
