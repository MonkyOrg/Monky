import type { ServerEventPublic } from '@monky/shared';
import { getLanguage, t } from '../i18n';
import { html, trustedHtml, type SafeHtml } from '../utils/html';
import { renderImageCarousel } from './ImageCarousel';
import { locationIcon, privateBadge } from './community/communityMarkup';

type EventCard = Pick<ServerEventPublic, 'id' | 'title' | 'description' | 'startsAt' | 'status' | 'interestedCount' | 'location' | 'audience'>;

export interface EventCardOptions {
  /** The buttons of its footer. */
  actions?: SafeHtml;
  /** A card in a list: it opens its event when clicked, and shows only the first image. */
  openable?: boolean;
  /**
   * The event's own dialog: its tabs come before the details, which become a tab
   * panel with the facts under the title. The interested count and the place are
   * among those facts, so the card leaves them out.
   */
  detail?: { tabs: SafeHtml; facts: SafeHtml; panel: { id: string; labelledBy: string; hidden: boolean } };
}

export function renderServerEventCard(event: EventCard, location: string, images: string[], options: EventCardOptions = {}): string {
  const { openable = false, detail } = options;
  const when = event.status === 'scheduled'
    ? t('community.beginsAt', { date: new Date(event.startsAt).toLocaleString(getLanguage(), { dateStyle: 'short', timeStyle: 'short' }) })
    : t(`community.${event.status}`);
  return String(html`<article class="community-event-row ${event.status === 'active' ? 'is-active' : ''}" data-event-id="${event.id}"
    ${openable ? html`data-event-openable="true"` : ''}>
    ${openable
      ? images[0] ? html`<img class="community-cover" src="${images[0]}" alt="">` : ''
      : trustedHtml(renderImageCarousel(images, '', event.title))}
    ${detail?.tabs}
    <div class="community-event-content"${detail ? html` id="${detail.panel.id}" role="tabpanel"
      aria-labelledby="${detail.panel.labelledBy}"${detail.panel.hidden ? html` hidden` : ''}` : ''}>
      <div class="community-event-meta"><span class="community-event-status"><span class="material-symbols-outlined md-18">event</span>${when}</span>
        ${event.audience.visibility === 'private' ? privateBadge() : ''}
        ${detail ? '' : html`<span class="community-interest-count" aria-label="${t('community.interestedCount', { count: event.interestedCount })}"><span class="material-symbols-outlined md-16">group</span>${event.interestedCount}</span>`}</div>
      <h3>${openable ? html`<button class="community-event-title" type="button" data-event-action="detail">${event.title}</button>` : event.title}</h3>
      ${detail?.facts}
      <p>${event.description}</p>
    </div>
    <footer class="community-event-footer">${detail ? '' : html`<span class="community-event-location"><span class="material-symbols-outlined md-18">${locationIcon(event.location.kind)}</span>${location}</span>`}
      ${options.actions ? html`<div class="community-actions">${options.actions}</div>` : ''}
    </footer></article>`);
}
