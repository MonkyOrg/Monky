import { Permission } from '@monky/shared';
import { t, tCount } from '../i18n';
import { escapeHtml } from '../utils/html';
import { getAvatarUrl } from '../utils/avatar';
import { withButtonLoading } from '../utils/buttonLoading';
import { dmStore } from '../stores/dmStore';
import { getActiveServerStore } from '../stores/serverStore';
import { openCommunityModal } from './CommunityModal';
import { showErrorToast, showInfoToast, showSuccessToast } from './CopyToast';
import {
  forwardBlocker, forwardMessages, type ForwardDestination, type ForwardItem,
} from '../core/MessageForwarder';

/** Destinations one forward may reach at once. */
export const FORWARD_MAX_DESTINATIONS = 10;

export interface ForwardDestinationOption {
  destination: ForwardDestination;
  label: string;
  detail?: string;
  icon?: string;
  avatar?: string | null;
}

export interface ForwardModalOptions {
  items: ForwardItem[];
  channels: ForwardDestinationOption[];
  channelsHeading: string;
  friends: ForwardDestinationOption[];
}

const keyOf = (destination: ForwardDestination): string =>
  destination.kind === 'channel' ? `channel:${destination.channelId}` : `dm:${destination.peer}`;

/**
 * The chat channels of the active server the user can read, and every friend,
 * except `source`: forwarding into the conversation the messages are in makes no sense.
 */
export function forwardDestinations(source?: ForwardDestination): Pick<ForwardModalOptions, 'channels' | 'channelsHeading' | 'friends'> {
  const server = getActiveServerStore();
  const details = server.serverDetails;
  const channels = (details?.channels ?? [])
    .filter((channel) => (channel.type === 'TEXT' || channel.type === 'VOICE') && !channel.forumId
      && server.hasPermission(Permission.READ_MESSAGES, channel.id)
      && !(source?.kind === 'channel' && source.channelId === channel.id))
    .map((channel): ForwardDestinationOption => ({
      destination: { kind: 'channel', channelId: channel.id },
      label: channel.name,
      icon: channel.type === 'VOICE' ? 'volume_up' : 'tag',
    }));
  const friends = dmStore.friends()
    .filter((peer) => !(source?.kind === 'dm' && source.peer.toLowerCase() === peer.publicKey.toLowerCase()))
    .map((peer): ForwardDestinationOption => ({
    destination: { kind: 'dm', peer: peer.publicKey },
    label: peer.nickname,
    avatar: peer.avatar,
    detail: t(dmStore.isOnline(peer.publicKey) ? 'chat.forwardFriendOnline' : 'chat.forwardFriendOffline'),
  }));
  return {
    channels,
    channelsHeading: details ? t('chat.forwardChannelsOf', { server: details.name }) : t('chat.forwardChannels'),
    friends,
  };
}

/**
 * Picks where the selected messages go (one or several destinations) and
 * forwards them, one message each, destination by destination. Resolves true
 * once something was sent; each failed destination is named in the error toast.
 */
export function openForwardModal(options: ForwardModalOptions): Promise<boolean> {
  const count = options.items.length;
  const modal = openCommunityModal(tCount('chat.forwardTitle', count));
  modal.element.querySelector('.community-modal')?.classList.add('forward-modal');
  const all = [...options.channels, ...options.friends];
  const unavailable = new Map(all.map((option) => [keyOf(option.destination), forwardBlocker(options.items, option.destination)]));

  const renderOption = (option: ForwardDestinationOption): string => {
    const key = keyOf(option.destination);
    const reason = unavailable.get(key);
    const visual = option.destination.kind === 'dm'
      ? `<img class="forward-destination-avatar" src="${escapeHtml(getAvatarUrl(option.avatar ?? null))}" alt="" data-fallback="avatar">`
      : `<span class="material-symbols-outlined md-20 forward-destination-icon" aria-hidden="true">${escapeHtml(option.icon ?? 'tag')}</span>`;
    return `<button type="button" class="forward-destination" data-forward-key="${escapeHtml(key)}"
      data-forward-search="${escapeHtml(`${option.label} ${option.detail ?? ''}`.toLowerCase())}"
      aria-pressed="false" aria-disabled="${!!reason}" ${reason ? `title="${escapeHtml(reason)}"` : ''}>
      ${visual}
      <span class="forward-destination-copy"><strong>${escapeHtml(option.label)}</strong>
        ${option.detail || reason ? `<small>${escapeHtml(reason ?? option.detail ?? '')}</small>` : ''}</span>
      <span class="material-symbols-outlined md-20 forward-destination-check" aria-hidden="true">check_circle</span>
    </button>`;
  };
  const section = (heading: string, entries: ForwardDestinationOption[], empty: string) => `
    <section class="forward-section" aria-label="${escapeHtml(heading)}">
      <h3 class="forward-section-heading">${escapeHtml(heading)}</h3>
      ${entries.length ? `<div class="forward-destinations" role="group" aria-label="${escapeHtml(heading)}">${entries.map(renderOption).join('')}</div>`
        : `<p class="forward-empty">${escapeHtml(empty)}</p>`}
    </section>`;

  modal.content.innerHTML = `
    <label class="forward-search">
      <span class="material-symbols-outlined md-18" aria-hidden="true">search</span>
      <input class="input-field" type="text" data-forward-filter autocomplete="off" spellcheck="false"
        placeholder="${escapeHtml(t('chat.forwardSearch'))}" aria-label="${escapeHtml(t('chat.forwardSearch'))}">
    </label>
    <div class="forward-lists">
      ${section(options.channelsHeading, options.channels, t('chat.forwardNoChannels'))}
      ${section(t('chat.forwardFriends'), options.friends, t('chat.forwardNoFriends'))}
    </div>
    <p class="forward-progress" data-forward-progress role="status" aria-live="polite"></p>
    <div class="modal-footer">
      <button type="button" class="btn btn-secondary" data-forward-cancel>${escapeHtml(t('common.cancel'))}</button>
      <button type="button" class="btn btn-primary" data-forward-confirm disabled>${escapeHtml(t('chat.forwardAction'))}</button>
    </div>`;

  const filter = modal.content.querySelector<HTMLInputElement>('[data-forward-filter]');
  const confirm = modal.content.querySelector<HTMLButtonElement>('[data-forward-confirm]');
  const progress = modal.content.querySelector<HTMLElement>('[data-forward-progress]');
  const buttons = [...modal.content.querySelectorAll<HTMLButtonElement>('[data-forward-key]')];
  // Kept in the order the user picked them, which is the order they are sent in.
  const selected: ForwardDestinationOption[] = [];
  let busy = false;
  let limitNoticeShown = false;

  const syncConfirm = () => {
    if (!confirm) return;
    confirm.disabled = selected.length === 0;
    confirm.textContent = selected.length > 1 ? t('chat.forwardToMany', { count: selected.length }) : t('chat.forwardAction');
  };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    modal.signal.addEventListener('abort', () => settle(false), { once: true });

    filter?.addEventListener('input', () => {
      const query = filter.value.trim().toLowerCase();
      for (const button of buttons) button.hidden = !!query && !(button.dataset.forwardSearch ?? '').includes(query);
    }, { signal: modal.signal });

    for (const button of buttons) {
      button.addEventListener('click', () => {
        if (busy || button.getAttribute('aria-disabled') === 'true') return;
        const option = all.find((entry) => keyOf(entry.destination) === button.dataset.forwardKey);
        if (!option) return;
        const index = selected.indexOf(option);
        if (index >= 0) selected.splice(index, 1);
        else if (selected.length >= FORWARD_MAX_DESTINATIONS) {
          if (!limitNoticeShown) showInfoToast(t('chat.forwardDestinationLimit', { max: FORWARD_MAX_DESTINATIONS }));
          limitNoticeShown = true;
          return;
        } else selected.push(option);
        button.setAttribute('aria-pressed', String(index < 0));
        syncConfirm();
      }, { signal: modal.signal });
    }

    modal.content.querySelector('[data-forward-cancel]')?.addEventListener('click', () => {
      if (!busy) modal.close();
    }, { signal: modal.signal });

    confirm?.addEventListener('click', () => {
      const targets = [...selected];
      if (targets.length === 0 || busy) return;
      busy = true;
      buttons.forEach((button) => { button.disabled = true; });
      if (filter) filter.disabled = true;
      void withButtonLoading(confirm, async () => {
        const failures: { label: string; error: string }[] = [];
        let reached = 0;
        // One destination failing never stops the others.
        for (const target of targets) {
          const result = await forwardMessages(options.items, target.destination, (sent) => {
            if (progress) progress.textContent = t('chat.forwardProgressTo', { destination: target.label, sent, total: count });
          });
          if (result.sent > 0) reached++;
          if (result.error) {
            failures.push({
              label: target.label,
              error: result.sent > 0 ? t('chat.forwardPartialShort', { sent: result.sent, total: count, error: result.error }) : result.error,
            });
          }
        }
        busy = false;
        if (failures.length === 0) {
          showSuccessToast(targets.length === 1
            ? tCount('chat.forwardDone', count, { destination: targets[0].label })
            : tCount('chat.forwardDoneMany', count, { destinations: targets.length }));
        } else {
          showErrorToast(failures.map((failure) => t('chat.forwardFailedFor', failure)).join(' '), 9000);
        }
        if (reached > 0) {
          settle(true);
          modal.close();
          return;
        }
        if (progress) progress.textContent = '';
        buttons.forEach((button) => { button.disabled = false; });
        if (filter) filter.disabled = false;
      });
    }, { signal: modal.signal });

    filter?.focus();
  });
}
