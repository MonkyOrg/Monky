import {
  MessageType, ProtocolErrorCode, communitySnapshotSchema, createServerInviteLink, eventInterestedListResultSchema,
  eventResultSchema, type EventControl, type EventInterestedListResult, type ServerEventPublic,
} from '@monky/shared';
import type { CommunityFeed } from '../../core/CommunityFeed';
import { ProtocolRequestError } from '../../core/NetworkClient';
import { getLanguage, t } from '../../i18n';
import { copyText, reportError } from '../../utils/feedback';
import { html } from '../../utils/html';
import { renderKeyedList } from '../../utils/keyedList';
import type { CommunityModal } from '../CommunityModal';
import { contextMenu } from '../ContextMenu';
import { showConfirm } from '../Dialog';
import { imageCarouselNavigationButton, moveImageCarousel } from '../ImageCarousel';
import { renderServerEventCard } from '../ServerEventCard';
import { openServerEventWizard } from '../ServerEventWizard';
import { canCreateEvent, canManageEvent } from './communityAccess';
import { assetUrl, followFeed, keepPlace, type CommunityContext } from './communityContext';
import { locationIcon } from './communityMarkup';

/** Shortest wait between two checks of an event the snapshot does not carry. */
const EVENT_CHECK_INTERVAL_MS = 1000;

/** How the server answers for an event that was deleted or is no longer visible to this member. */
function isEventRefused(error: unknown): boolean {
  return error instanceof ProtocolRequestError && error.code === ProtocolErrorCode.PERMISSION_DENIED;
}

/** Where the event takes place: its channel's name, or the place its organizer wrote. */
export function locationName(feed: CommunityFeed, event: ServerEventPublic): string {
  return event.location.kind !== 'external'
    ? feed.server.serverDetails?.channels.find(channel => event.location.kind !== 'external' && channel.id === event.location.channelId)?.name ?? ''
    : event.location.label;
}

/** Fetches one event from the server; aborting `signal` cancels the request. */
export async function getEvent(feed: CommunityFeed, id: string, signal: AbortSignal): Promise<ServerEventPublic> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const requestId = crypto.randomUUID();
  const cancel = () => feed.client.cancelRequest(requestId);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const response = await feed.client.sendRequest<unknown>(MessageType.EVENT_GET, { id }, requestId);
    const { event } = eventResultSchema.parse(response);
    if (event.id !== id) throw new Error(t('community.changed'));
    return event;
  } finally { signal.removeEventListener('abort', cancel); }
}

/** Fetches an event the snapshot does not carry; one the server refuses leaves the open lists. */
async function confirmEvent(ctx: CommunityContext, id: string, signal: AbortSignal): Promise<ServerEventPublic> {
  try {
    return await getEvent(ctx.feed, id, signal);
  } catch (error) {
    if (!isEventRefused(error)) throw error;
    ctx.forgetEvent(id);
    throw new Error(t('community.eventUnavailable'));
  }
}

function eventLink(feed: CommunityFeed, event: ServerEventPublic): string {
  const address = new URL(feed.client.getHttpBaseUrl());
  return createServerInviteLink({
    v: 1, host: address.hostname, port: Number(address.port || (address.protocol === 'https:' ? 443 : 80)),
    name: feed.server.serverDetails?.name, eventId: event.id,
  }, getLanguage());
}

/** A notice that is not an error, such as a calendar saved: it stays in the dialog until the next action. */
function eventFeedback(modal: CommunityModal, message: string): void {
  modal.content.querySelector('[data-event-feedback]')?.remove();
  const notice = document.createElement('p');
  notice.dataset.eventFeedback = '';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  modal.content.append(notice);
}

function eventImages(feed: CommunityFeed, event: ServerEventPublic): string[] {
  const urls = event.imageUrls?.length ? event.imageUrls : event.imageUrl ? [event.imageUrl] : [];
  return urls.map(url => assetUrl(feed, url));
}

function eventActions(feed: CommunityFeed, event: ServerEventPublic) {
  const canStart = canManageEvent(feed.server, event) && event.status === 'scheduled';
  return html`
    <button class="btn btn-secondary event-more" type="button" data-event-action="menu" aria-label="${t('common.moreOptions')}"><span class="material-symbols-outlined md-18">more_horiz</span></button>
    ${event.status === 'scheduled' ? html`<button class="btn ${event.interested ? 'btn-success' : 'btn-secondary'}" type="button" data-event-action="interest" aria-pressed="${event.interested}" title="${t(event.interested ? 'community.notInterested' : 'community.interested')}">${t('community.interested')}</button>` : ''}
    ${event.status === 'active' ? html`<button class="btn btn-secondary" type="button" data-event-action="copyLink"><span class="material-symbols-outlined md-18">link</span>${t('community.copyLinkShort')}</button>` : ''}
    ${event.status === 'active' && event.location.kind !== 'external' ? html`<button class="btn btn-success" type="button" data-event-action="join">${t(event.location.kind === 'voice' ? 'community.join' : 'community.openChannel')}</button>` : ''}
    ${canStart ? html`<button class="btn btn-primary" type="button" data-event-action="start">${t('community.start')}</button>` : ''}`;
}

/** An event's card with its actions: opens the event from a list, or shows it in full in its dialog. */
function eventCard(feed: CommunityFeed, event: ServerEventPublic, openable: boolean): string {
  return renderServerEventCard(event, locationName(feed, event), eventImages(feed, event), {
    actions: eventActions(feed, event), openable,
  });
}

function bindEventActions(ctx: CommunityContext, modal: CommunityModal, events: () => ServerEventPublic[]): void {
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
      openEvent(ctx, event);
      return;
    }
    if (button.dataset.eventAction === 'menu') {
      const rect = button.getBoundingClientRect();
      const management = event.status === 'scheduled' ? ['start', 'edit', 'cancel', 'delete'] as const
        : event.status === 'active' ? ['edit', 'end', 'delete'] as const : ['delete'] as const;
      const actions = [...(canManageEvent(ctx.feed.server, event) ? management : []),
        'copyLink', 'exportCalendar', ...(event.status === 'active' ? ['interest'] as const : [])] as const;
      contextMenu.open(rect.left, rect.bottom, actions.map(action => ({
        label: t(action === 'cancel' ? 'community.cancelEvent'
          : action === 'interest' ? (event.interested ? 'community.notInterested' : 'community.interested')
          : action === 'exportCalendar' && event.repeat !== 'none' ? 'community.exportSeries' : `community.${action}`),
        danger: action === 'cancel' || action === 'delete' || action === 'end',
        // The menu stays open while its card is unchanged: it acts on the event as it is now.
        onClick: () => {
          const current = events().find((entry) => entry.id === event.id);
          if (current) runEventAction(ctx, modal, current, button, action);
        },
      })), button);
      return;
    }

    runEventAction(ctx, modal, event, button, button.dataset.eventAction);
  }, { signal: modal.signal });
}

function runEventAction(
  ctx: CommunityContext, modal: CommunityModal, event: ServerEventPublic, button: HTMLButtonElement, requestedAction?: string,
): void {
  // A button no longer on screen (its card rebuilt, the event withdrawn) acts on nothing.
  if (modal.signal.aborted || !button.isConnected) return;
  modal.content.querySelector('[data-event-feedback]')?.remove();
  const { feed } = ctx;
  void modal.run(async () => {
    if (requestedAction === 'detail') { openEvent(ctx, event); return; }
    if (requestedAction === 'edit') { ctx.track(openServerEventWizard(feed, event)); return; }
    if (requestedAction === 'start') { confirmStart(ctx, event); return; }
    if (requestedAction === 'join' && event.location.kind === 'voice') {
      await ctx.joinVoice(event.location.channelId);
      ctx.closeAll();
      return;
    }
    if (requestedAction === 'join' && event.location.kind === 'text') {
      if (!ctx.openTextChannel || !feed.server.getChannel(event.location.channelId)) throw new Error(t('community.changed'));
      ctx.openTextChannel(event.location.channelId);
      ctx.closeAll();
      return;
    }
    button.disabled = true;
    try {
      if (requestedAction === 'copyLink') {
        await copyText(eventLink(feed, event), { copied: t('community.linkCopied'), failed: t('community.copyFailed') });
        return;
      }
      if (requestedAction === 'exportCalendar') {
        const server = feed.server.serverDetails;
        if (!server) throw new Error(t('community.changed'));
        // Only the snapshot is kept current: an event from the history is confirmed
        // with the server before its content leaves the app.
        const current = feed.snapshot?.events.some((entry) => entry.id === event.id)
          ? event : await confirmEvent(ctx, event.id, modal.signal);
        if (modal.signal.aborted) return;
        const result = await window.api.saveEventCalendar({
          event: current, serverId: server.id, serverName: server.name,
          location: locationName(feed, current), link: eventLink(feed, current),
        });
        if (result.status === 'failed') throw new Error(result.error);
        if (result.status === 'saved' && !modal.signal.aborted) eventFeedback(modal, t('community.calendarSaved'));
        return;
      }
      if (requestedAction === 'interest') {
        await feed.client.sendRequest(MessageType.EVENT_INTEREST, { id: event.id, interested: !event.interested });
      } else {
        const action = requestedAction === 'confirm-start' ? 'start' : requestedAction;
        if (action !== 'start' && action !== 'end' && action !== 'cancel' && action !== 'delete') throw new Error(t('community.changed'));
        if (action !== 'start' && !await showConfirm({
          message: t(action === 'end' ? 'community.confirmEnd' : action === 'cancel' ? 'community.confirmCancel' : 'community.confirmDelete'),
          signal: modal.signal,
        })) return;
        const payload: EventControl = { id: event.id, expectedRevision: event.revision, action };
        await feed.client.sendRequest(MessageType.EVENT_CONTROL, payload);
        if (requestedAction === 'confirm-start') modal.close();
      }
    } finally { if (button.isConnected) button.disabled = false; }
  });
}

/** The server's events, with the ended ones on request. */
export function openEvents(ctx: CommunityContext): void {
  const { feed } = ctx;
  const modal = ctx.modal(t('community.events'));
  modal.card.classList.add('event-list-modal');
  if (canCreateEvent(feed.server)) {
    const create = document.createElement('button');
    create.className = 'btn btn-primary';
    create.dataset.createEvent = '';
    create.textContent = t('community.newEvent');
    create.addEventListener('click', () => ctx.track(openServerEventWizard(feed)), { signal: modal.signal });
    modal.card.querySelector('.modal-header .modal-title')?.after(create);
  }
  let history = false;
  let previous: ServerEventPublic[] = [];
  let shown: string | null = null;
  const events = () => history ? previous : feed.snapshot?.events ?? [];
  const render = () => {
    const list = events();
    const count = list.length;
    const heading = String(html`<span class="material-symbols-outlined md-24" aria-hidden="true">event</span>${t(count === 1 ? 'community.oneEvent' : 'community.eventCount', { count })}`);
    const items = [
      ...count ? list.map((event) => ({ key: `event:${event.id}`, html: eventCard(feed, event, true) })) : [{ key: 'empty', html: `<div class="community-empty">
        <span class="material-symbols-outlined">event</span><h2>${t('community.emptyEvents')}</h2><p>${t('community.emptyHint')}</p></div>` }],
      // Its state lives in the switch, so the row never has to be rebuilt.
      { key: 'history', html: String(html`<div class="community-history">
        <span>${t('community.history')}</span>
        <label class="toggle-switch"><input type="checkbox" role="switch" data-history aria-label="${t('community.history')}"><span class="toggle-slider"></span></label>
        </div>`) },
    ];
    // Snapshots also arrive for votes and responses elsewhere: unchanged cards stay as they are,
    // and a changed one is the only one rebuilt.
    const markup = heading + items.map((item) => item.html).join('');
    if (markup === shown) return;
    shown = markup;
    const title = modal.card.querySelector('.modal-title');
    if (title) title.innerHTML = heading;
    keepPlace(modal, () => renderKeyedList(modal.content, items));
    const toggle = modal.content.querySelector<HTMLInputElement>('[data-history]');
    if (toggle) toggle.checked = history;
  };
  const refresh = async () => {
    if (history) {
      const response: unknown = await feed.client.sendRequest(MessageType.COMMUNITY_GET, { includeEnded: true });
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
  bindEventActions(ctx, modal, events);
  // The history is a copy fetched once: an event the server refused since then leaves it.
  const unwatch = ctx.watchEvents((id) => {
    if (!previous.some((event) => event.id === id)) return;
    previous = previous.filter((event) => event.id !== id);
    render();
  });
  modal.signal.addEventListener('abort', unwatch, { once: true });
  followFeed(feed, modal, () => {
    if (!feed.snapshot?.settings.eventsEnabled) { modal.close(true); return; }
    if (history) {
      // In the server's order: what is on or coming first, then the ended and cancelled.
      const current = new Map(feed.snapshot.events.map((event) => [event.id, event]));
      previous = [...current.values(), ...previous.filter((event) => !current.has(event.id) && ['ended', 'cancelled'].includes(event.status))];
    }
    render();
  });
  render();
}

/** One event, with its details and who is interested; `fresh` when it was just fetched by id. */
export function openEvent(ctx: CommunityContext, initial: ServerEventPublic, fresh = false): void {
  const { feed } = ctx;
  const modal = ctx.modal(initial.title);
  modal.card.classList.add('event-detail-modal');
  let event = initial;
  let tab: 'details' | 'interested' = 'details';
  let members: EventInterestedListResult['users'] = [];
  let cursor: string | null = null;
  let loading = false, failed = false, generation = 0;
  let requestId: string | null = null;
  const tabsId = crypto.randomUUID();
  const cancelMembers = () => {
    generation++;
    if (requestId) feed.client.cancelRequest(requestId);
    requestId = null;
    loading = false;
  };
  const render = () => {
    const focusedTab = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.eventTab : undefined;
    const creator = feed.server.knownMembers.get(event.creatorUserId)?.nickname;
    const tabs = html`<div class="community-event-tabs" role="tablist">
      <button type="button" id="${tabsId}-details" role="tab" data-event-tab="details" aria-controls="${tabsId}-details-panel" aria-selected="${tab === 'details'}" tabindex="${tab === 'details' ? 0 : -1}">${t('community.details')}</button>
      <button type="button" id="${tabsId}-interested" role="tab" data-event-tab="interested" aria-controls="${tabsId}-interested-panel" aria-selected="${tab === 'interested'}" tabindex="${tab === 'interested' ? 0 : -1}">${t('community.interestedCount', { count: event.interestedCount })}</button></div>
      <section class="event-interest-list" id="${tabsId}-interested-panel" role="tabpanel" aria-labelledby="${tabsId}-interested" ${tab !== 'interested' ? html`hidden` : ''} aria-busy="${loading}">
        <ul>${members.map(member => html`<li><img src="${assetUrl(feed, member.avatarUrl)}" alt="" data-fallback="avatar"><span>${member.nickname}</span></li>`)}</ul>
        ${loading ? html`<p role="status">${t('community.loadingInterested')}</p>` : ''}
        ${!loading && !failed && !members.length ? html`<p>${t('community.noInterested')}</p>` : ''}
        ${failed ? html`<p role="alert">${t('community.interestedLoadError')}</p>` : ''}
        ${!loading && (failed || cursor) ? html`<button type="button" class="btn btn-secondary" data-interested-more>${t(failed ? 'community.retry' : 'community.loadMore')}</button>` : ''}
      </section>`;
    const facts = html`<div class="community-event-details-meta">
      <p><span class="material-symbols-outlined md-18">dns</span>${feed.server.serverDetails?.name ?? ''}</p>
      <p><span class="material-symbols-outlined md-18">${locationIcon(event.location.kind)}</span>${locationName(feed, event)}</p>
      <p><span class="material-symbols-outlined md-18">group</span>${t('community.interestedCount', { count: event.interestedCount })}</p>
      ${creator ? html`<p><span class="material-symbols-outlined md-18">person</span>${t('community.createdBy', { name: creator })}</p>` : ''}</div>`;
    modal.content.innerHTML = renderServerEventCard(event, locationName(feed, event), eventImages(feed, event), {
      actions: eventActions(feed, event),
      detail: { tabs, facts, panel: { id: `${tabsId}-details-panel`, labelledBy: `${tabsId}-details`, hidden: tab !== 'details' } },
    });
    if (focusedTab === 'details' || focusedTab === 'interested') modal.content.querySelector<HTMLElement>(`[data-event-tab="${focusedTab}"]`)?.focus();
  };
  const redraw = () => keepPlace(modal, render);
  const loadMembers = async (reset: boolean) => {
    cancelMembers();
    if (reset) { members = []; cursor = null; }
    const current = generation;
    loading = true;
    failed = false;
    requestId = crypto.randomUUID();
    redraw();
    try {
      const response = await feed.client.sendRequest<unknown>(MessageType.EVENT_GET_INTERESTED, {
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
      if (!modal.signal.aborted && current === generation) { requestId = null; loading = false; redraw(); }
    }
  };
  modal.content.addEventListener('click', click => {
    const target = click.target instanceof Element ? click.target.closest<HTMLElement>('[data-event-tab], [data-interested-more]') : null;
    if (!target) return;
    if (target.hasAttribute('data-interested-more')) { void loadMembers(false); return; }
    tab = target.dataset.eventTab === 'interested' ? 'interested' : 'details';
    if (tab === 'interested') void loadMembers(true);
    else { cancelMembers(); redraw(); }
  }, { signal: modal.signal });
  modal.content.addEventListener('keydown', key => {
    if (!(key.target instanceof Element) || !key.target.closest('[data-event-tab]')) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key.key)) return;
    key.preventDefault();
    const next = key.key === 'Home' ? 'details' : key.key === 'End' ? 'interested' : tab === 'details' ? 'interested' : 'details';
    modal.content.querySelector<HTMLButtonElement>(`[data-event-tab="${next}"]`)?.click();
    modal.content.querySelector<HTMLElement>(`[data-event-tab="${next}"]`)?.focus();
  }, { signal: modal.signal });
  // Links can open an event the bounded snapshot does not carry, such as one from the history.
  let inSnapshot = !!feed.snapshot?.events.some((entry) => entry.id === initial.id);
  const shownKey = (value: ServerEventPublic) => JSON.stringify([eventCard(feed, value, false),
    feed.server.knownMembers.get(value.creatorUserId)?.nickname, feed.server.serverDetails?.name]);
  /** What the content shows; null while the event is hidden until the server confirms it. */
  let shown: string | null = shownKey(event);
  // While hidden, nothing on screen — or still in a stale menu — acts on the event.
  bindEventActions(ctx, modal, () => shown === null ? [] : [event]);
  const show = (value: ServerEventPublic) => {
    const hidden = shown === null;
    const interestChanged = value.interestedCount !== event.interestedCount || value.interested !== event.interested;
    event = value;
    // The title comes back after a confirmation and follows renames.
    modal.setTitle(value.title);
    const key = shownKey(value);
    if (hidden) modal.clearError();
    // Snapshots also follow votes and responses elsewhere: the loaded pages and
    // what is on screen only change when this event does.
    if (tab === 'interested' && (hidden || interestChanged)) { shown = key; void loadMembers(true); }
    else if (key !== shown) { shown = key; redraw(); }
  };
  // Revoked content leaves the screen at once — the name in the title, the card and its
  // menu, the interested members — and focus moves to the now neutral title.
  const conceal = (text: string) => {
    cancelMembers();
    shown = null;
    modal.setTitle(t('community.details'));
    keepPlace(modal, () => { modal.content.textContent = text; });
  };
  // Checks with the server run one at a time and at most once per interval, so a
  // burst of snapshots (votes, responses) costs a single EVENT_GET.
  let checking: AbortController | null = null;
  let checkTimer: number | null = null;
  let checkAgain = false;
  let lastCheck = 0;
  const cancelCheck = () => {
    if (checkTimer !== null) window.clearTimeout(checkTimer);
    checkTimer = null;
    checkAgain = false;
    checking?.abort();
    checking = null;
  };
  const check = () => {
    checkTimer = null;
    lastCheck = performance.now();
    const controller = new AbortController();
    checking = controller;
    const signal = AbortSignal.any([modal.signal, controller.signal]);
    void getEvent(feed, event.id, signal).then(
      (result) => { if (!signal.aborted) show(result); },
      (error: unknown) => {
        if (signal.aborted) return;
        const refused = isEventRefused(error);
        if (!refused && shown !== null) {
          // A timeout says nothing about the event: it stays until the next snapshot checks again.
          console.warn('[Community] Event check failed.', error);
          return;
        }
        // The server no longer shows it, or it is already hidden: nothing of it is left
        // behind, not even an empty dialog or its card in the history, and the toast says why.
        console.warn('[Community] Event no longer available.', error);
        if (refused) { ctx.forgetEvent(event.id); return; }
        modal.close(true);
        reportError(t('community.eventLoadError'));
      },
    ).finally(() => {
      if (checking !== controller) return;
      checking = null;
      if (checkAgain) { checkAgain = false; scheduleCheck(); }
    });
  };
  const scheduleCheck = () => {
    if (checking) { checkAgain = true; return; }
    if (checkTimer === null) {
      checkTimer = window.setTimeout(check, Math.max(0, lastCheck + EVENT_CHECK_INTERVAL_MS - performance.now()));
    }
  };
  followFeed(feed, modal, () => {
    if (!feed.snapshot?.settings.eventsEnabled) { modal.close(true); return; }
    const current = feed.snapshot.events.find((entry) => entry.id === event.id);
    const left = inSnapshot && !current;
    inSnapshot = !!current;
    if (current) {
      // The live copy supersedes a check still in flight.
      cancelCheck();
      show(current);
      return;
    }
    if (left) {
      // Ended, cancelled, deleted or no longer visible: nothing stays on screen while
      // the server is asked, since it only comes back if the server still shows it.
      cancelCheck();
      conceal(t('community.loadingEvent'));
      check();
      return;
    }
    // Outside the snapshot from the start (history, links): confirmed again without blanking.
    scheduleCheck();
  });
  // The server refused it, as answer to this dialog's check or to an export from it.
  const unwatch = ctx.watchEvents((id) => {
    if (id !== event.id || modal.signal.aborted) return;
    modal.close(true);
    reportError(t('community.eventUnavailable'));
  });
  modal.signal.addEventListener('abort', () => { unwatch(); cancelMembers(); cancelCheck(); }, { once: true });
  render();
  // An event the snapshot does not carry (history, links) is confirmed at once, unless it was
  // just fetched: a server where nothing else changes sends no snapshot that would ask.
  if (!inSnapshot) {
    if (fresh) lastCheck = performance.now();
    else check();
  }
}

/** Asks before an event starts, showing it as it will be announced. */
function confirmStart(ctx: CommunityContext, event: ServerEventPublic): void {
  const { feed } = ctx;
  const modal = ctx.modal(event.title);
  modal.card.classList.add('event-start-modal');
  modal.content.innerHTML = `<p class="event-wizard-hint">${t('community.startHint')}</p>${
    renderServerEventCard(event, locationName(feed, event), eventImages(feed, event))}
    ${html`<div data-event-id="${event.id}"><button type="button" class="btn btn-primary event-start-confirm" data-event-action="confirm-start">${t('community.start')}</button></div>`}`;
  bindEventActions(ctx, modal, () => [event]);
  followFeed(feed, modal, () => {
    const current = feed.snapshot?.events.find(item => item.id === event.id);
    if (!current || current.revision !== event.revision) modal.close(true);
  });
}
