import type { ServerEventPublic } from '@monky/shared';
import { t } from '../../i18n';
import { html, type SafeHtml } from '../../utils/html';

/** The lock badge of an activity only some members can see. */
export function privateBadge(): SafeHtml {
  return html`<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>`;
}

/** The icon of where an event takes place: a voice channel, a text channel or somewhere else. */
export function locationIcon(kind: ServerEventPublic['location']['kind']): string {
  return kind === 'voice' ? 'volume_up' : kind === 'text' ? 'tag' : 'location_on';
}

export interface LiveItemCard {
  /** The attribute naming the card, with the item's id; see `preserveViewState`. */
  item: 'data-live-action-card' | 'data-live-poll-card' | 'data-native-live-form-card';
  /** The attribute of its Open button, with the item's id. */
  open: 'data-live-action' | 'data-live-poll' | 'data-native-live-form';
  /** Its management menu, for whoever may close it. */
  menu: 'action' | 'poll' | 'form' | null;
  id: string;
  kind: string;
  title: string;
  summary: string;
  channel: string;
  private: boolean;
  image?: { url: string; className?: string };
}

/** A live action, poll or form in the list of live actions. */
export function renderLiveItemCard(card: LiveItemCard): SafeHtml {
  return html`<article class="community-event-row live-action-card" ${card.item}="${card.id}">
    ${card.image ? html`<img class="live-action-card-image${card.image.className ? ` ${card.image.className}` : ''}"
      src="${card.image.url}" alt="">` : ''}
    <div class="community-event-content">
      <small class="community-live-label"><span class="community-live-dot"></span>${card.kind}
        ${card.private ? privateBadge() : ''}</small>
      <h3>${card.title}</h3>
      <p>${card.summary}</p>
    </div>
    <footer class="community-event-footer">
      <span class="community-event-location"><span class="material-symbols-outlined md-16">tag</span>${card.channel}</span>
      <div class="community-actions">
        ${card.menu ? html`<button type="button" class="btn btn-secondary event-more" data-live-action-menu="${card.menu}"
          aria-haspopup="menu" aria-label="${t('common.moreOptions')}"><span class="material-symbols-outlined md-18">more_horiz</span></button>` : ''}
        <button type="button" class="btn btn-primary" ${card.open}="${card.id}">${t('community.open')}</button>
      </div>
    </footer>
  </article>`;
}
