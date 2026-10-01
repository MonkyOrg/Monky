import type { ServerEventPublic } from '@monky/shared';
import { getLanguage, t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { renderImageCarousel } from './ImageCarousel';

type EventCard = Pick<ServerEventPublic, 'id' | 'title' | 'description' | 'startsAt' | 'status' | 'interestedCount' | 'location' | 'audience'>;

export function renderServerEventCard(event: EventCard, location: string, images: string[], actions = '', openable = false): string {
  const when = event.status === 'scheduled'
    ? t('community.beginsAt', { date: new Date(event.startsAt).toLocaleString(getLanguage(), { dateStyle: 'short', timeStyle: 'short' }) })
    : t(`community.${event.status}`);
  return `<article class="community-event-row ${event.status === 'active' ? 'is-active' : ''}" data-event-id="${escapeHtml(event.id)}"
    ${openable ? 'data-event-openable="true"' : ''}>
    ${openable
      ? images[0] ? `<img class="community-cover" src="${escapeHtml(images[0])}" alt="">` : ''
      : renderImageCarousel(images, '', event.title)}
    <div class="community-event-content">
      <div class="community-event-meta"><span class="community-event-status"><span class="material-symbols-outlined md-18">event</span>${escapeHtml(when)}</span>
        ${event.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}
        <span class="community-interest-count" aria-label="${escapeHtml(t('community.interestedCount', { count: event.interestedCount }))}"><span class="material-symbols-outlined md-16">group</span>${event.interestedCount}</span></div>
      <h3>${openable ? `<button class="community-event-title" type="button" data-event-action="detail">${escapeHtml(event.title)}</button>` : escapeHtml(event.title)}</h3><p>${escapeHtml(event.description)}</p>
    </div>
    <footer class="community-event-footer"><span class="community-event-location"><span class="material-symbols-outlined md-18">${event.location.kind === 'voice' ? 'volume_up' : event.location.kind === 'text' ? 'tag' : 'location_on'}</span>${escapeHtml(location)}</span>
      ${actions ? `<div class="community-actions">${actions}</div>` : ''}
    </footer></article>`;
}
