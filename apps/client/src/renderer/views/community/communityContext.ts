import type { CommunityFeed } from '../../core/CommunityFeed';
import { resolveAvatarUrl } from '../../utils/avatar';
import { preserveViewState } from '../../utils/preserveViewState';
import type { CommunityModal } from '../CommunityModal';
import { contextMenu } from '../ContextMenu';

/** Attributes naming the event or live action a card belongs to; see `preserveViewState`. */
const ACTIVITY_ITEMS = ['data-event-id', 'data-live-action-card', 'data-live-poll-card', 'data-native-live-form-card'];

/** What the dialogs of a server's events and live actions share with the view that opens them. */
export interface CommunityContext {
  readonly feed: CommunityFeed;
  /** Opens a dialog that closes with the view. */
  modal(title: string): CommunityModal;
  /** A dialog opened by someone else, such as a wizard, that must also close with the view. */
  track(modal: CommunityModal | undefined): void;
  /** Closes every dialog of the view, as joining the call or opening the channel of an event does. */
  closeAll(): void;
  joinVoice(channelId: string): Promise<void>;
  openTextChannel?: (channelId: string) => void;
  /** The server refused this event: the dialog showing it closes and no list keeps it. */
  forgetEvent(id: string): void;
  /** Hears `forgetEvent` until the returned function is called. */
  watchEvents(forget: (id: string) => void): () => void;
}

/** Files the server stores (banners, covers, avatars), resolved against this session's server. */
export function assetUrl(feed: CommunityFeed, path: string | null | undefined): string {
  return resolveAvatarUrl(path, feed.client.getHttpBaseUrl());
}

/** Runs `listener` on every snapshot while `modal` is open. */
export function followFeed(feed: CommunityFeed, modal: CommunityModal, listener: () => void): void {
  const unbind = feed.subscribe(listener);
  modal.signal.addEventListener('abort', unbind, { once: true });
}

/**
 * Rebuilds a dialog's content keeping focus on the same control of the same card.
 * When that card is gone the dialog title takes focus, never a neighbor's button.
 * A card's ⋯ menu closes when its card is rebuilt or withdrawn, so no action can
 * reach an item that is no longer on screen, and when its ⋯ moves or the dialog
 * scrolls, since the menu does not follow it; focus in that menu returns to the ⋯
 * of the same card, or to the title.
 */
export function keepPlace(modal: CommunityModal, draw: () => void): void {
  const opener = [...modal.content.querySelectorAll<HTMLElement>('[aria-expanded="true"]')]
    .find(element => contextMenu.isOpenFor(element)) ?? null;
  const placed = opener?.getBoundingClientRect();
  const scroller = modal.card;
  const scrolled = scroller.scrollTop;
  const active = document.activeElement;
  const menuFocused = !!opener && active instanceof Element && !!active.closest('.floating-context-menu');
  let closed = false;
  preserveViewState(modal.content, () => {
    draw();
    if (!opener || !placed) return;
    const box = opener.isConnected ? opener.getBoundingClientRect() : null;
    // Scroll anchoring can hold the ⋯ in place by scrolling the dialog, and the menu
    // closes on any scroll: it is closed here, where focus can go back to the ⋯.
    if (box && Math.abs(box.top - placed.top) < 1 && Math.abs(box.left - placed.left) < 1
      && scroller.scrollTop === scrolled) return;
    contextMenu.close();
    closed = true;
  }, {
    itemKeys: ACTIVITY_ITEMS,
    fallback: () => modal.card.querySelector<HTMLElement>('.modal-title'),
    origin: menuFocused ? opener : null,
  });
  // A ⋯ that stayed but moved takes back the focus of the menu it no longer anchors.
  if (closed && menuFocused && opener?.isConnected) opener.focus({ preventScroll: true });
}
