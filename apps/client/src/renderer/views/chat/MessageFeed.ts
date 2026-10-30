import { highlightMessageJump } from '../../utils/messageJumpHighlight';
import { restoreScrollWithMotion, smoothScrollIntoView, smoothScrollTo } from '../../utils/scroll';

/** One item of a conversation feed: a message row, a day divider, a bot card. */
export interface FeedEntry {
  /** Names the entry across renders; unique within the feed. */
  key: string;
  /** Markup of exactly one element. */
  html: string;
}

/** Where an entry in view sat, so it can stay there while entries around it change. */
export interface FeedAnchor {
  key: string;
  top: number;
}

export interface MessageFeedOptions {
  /** Wires an element built from new markup: its links, cards and players. */
  onCreate?(element: HTMLElement, key: string): void;
}

interface FocusedControl {
  key: string;
  /** The focused control inside the entry; null when the entry itself had focus. */
  selector: string | null;
  index: number;
}

/** How close to the end the feed must be to keep following new messages (#270). */
const END_THRESHOLD_PX = 48;
/** How long revealing the newest message follows a view that shrinks under it. */
const REVEAL_FOLLOW_MS = 1000;
/**
 * The longest an automatic scroll to the newest message counts as on its way.
 * It normally ends well before, once a frame finds the view at the end.
 */
const AUTO_SCROLL_MS = 2000;
/**
 * How far the view may go up during an automatic scroll, beyond what the
 * content explains, before it counts as the reader scrolling away.
 */
const DRIFT_PX = 2;
/** How close to the end an automatic scroll must get to have arrived there. */
const ARRIVED_PX = 1;
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

function build(markup: string): HTMLElement | null {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  const element = template.content.firstElementChild;
  return element instanceof HTMLElement ? element : null;
}

/** A selector finding the same control in the rebuilt entry: its id, or its tag and data attributes. */
function describe(element: HTMLElement): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  return element.tagName.toLowerCase() + [...element.attributes]
    .filter(attribute => attribute.name.startsWith('data-'))
    .map(attribute => `[${attribute.name}="${CSS.escape(attribute.value)}"]`).join('');
}

/**
 * The scrolling list of a conversation, shared by server channels and direct
 * messages (R-CHAT-5). The view says which entries exist and what each one
 * looks like; the feed puts them on screen touching only what changed, so an
 * entry whose markup stayed the same keeps its element, and with it the text
 * selected in it, focus, hover, loaded images and players. It also keeps the
 * reader's place: it follows the newest message while the reader is at the
 * end, holds what is in view still when entries above change, and moves to a
 * message on request, always through the motion preference.
 */
export class MessageFeed {
  /** The element on screen for each entry. */
  private readonly nodes = new Map<string, HTMLElement>();
  /** The key and markup each element was built from: an entry with the same markup is left alone. */
  private readonly built = new WeakMap<Element, FeedEntry>();
  /** Markup shown instead of entries (loading placeholders, an empty or locked conversation). */
  private state: string | null = null;
  private revealingUntil = 0;
  /**
   * Until when an automatic scroll to the newest message is on its way. Its
   * frames pass through positions short of the end, which are not the reader
   * leaving it: content arriving meanwhile must still be followed (#490).
   */
  private autoScrollUntil = 0;
  /**
   * Ends the automatic scroll once its time is up, if no frame did: scrolls
   * after that are the reader's own again.
   */
  private landing = 0;
  /** How far the view went up during the automatic scroll beyond what the content explains. */
  private drift = 0;
  /** Where the view and the end were when the feed last looked. */
  private seenTop = 0;
  private seenEnd = 0;
  /** The entry first in view when the feed last looked, and how far below the feed's top it sat. */
  private seenEntry: FeedAnchor | null = null;
  /** Where the end was when the feed last scrolled to it. */
  private pinnedEnd = -1;
  private readonly lifetime = new AbortController();
  private readonly resize: ResizeObserver;

  /**
   * Whether the reader is following the newest message. Only the reader moving
   * the feed away from the end clears it, or a jump to an older message.
   */
  public following = true;

  constructor(readonly element: HTMLElement, private readonly options: MessageFeedOptions = {}) {
    const signal = this.lifetime.signal;
    element.addEventListener('scroll', () => {
      if (this.autoScrollUntil) {
        this.checkFlight();
        return;
      }
      this.look();
      this.following = this.atEnd();
    }, { passive: true, signal });
    // The composer can grow under the feed while the conversation opens (a toolbar
    // wrapping onto another line in a narrow window): the smaller viewport moves the
    // end below where the feed scrolled, hiding the newest message behind the
    // composer. For the moment of the reveal, while the reader follows, the feed keeps
    // up with it, however many times it grows: re-pinning leaves that moment as it is.
    // What counts is where the end is against where the feed last scrolled, not the
    // size last observed: on a slow machine one frame can grow the viewport and shrink
    // it again, and only the net change is seen.
    this.resize = new ResizeObserver(() => {
      if (performance.now() < this.revealingUntil && this.followsEnd()
        && element.scrollHeight - element.clientHeight - this.pinnedEnd >= 1) this.pinToEnd(true);
    });
    this.resize.observe(element);
    const takeOver = () => { this.revealingUntil = 0; };
    for (const type of TAKEOVER_EVENTS) element.addEventListener(type, takeOver, { passive: true, signal });
    // Coming to rest near the end ends the automatic scroll, not the reveal: the
    // conversation can still be settling once the view got there. Where scrolling is
    // instant (smooth scrolling turned off in Windows), the view gets there before the
    // composer is done growing, a frame later (#490).
    element.addEventListener('scrollend', () => {
      if (this.atEnd()) this.stopFlight();
    }, { signal });
  }

  /** Whether the feed is scrolled close enough to the end to count as "at the end" (#270). */
  public atEnd(): boolean {
    const feed = this.element;
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= END_THRESHOLD_PX;
  }

  /**
   * Whether new content should bring the view down. Where the view is does not
   * decide it: on its way to the end, or with the end pushed down by a preview
   * or an image, a reader who did not scroll away is still following. The
   * reader may have just moved the view up, before its scroll event: that
   * counts, during an automatic scroll or not.
   */
  public followsEnd(): boolean {
    if (this.autoScrollUntil) this.checkFlight();
    else if (this.look() > DRIFT_PX) this.following = this.atEnd();
    return this.following;
  }

  /** Whether the feed shows a state (placeholders, an empty or locked conversation) instead of entries. */
  public get showsState(): boolean {
    return this.state !== null;
  }

  public node(key: string): HTMLElement | undefined {
    return this.nodes.get(key);
  }

  public keyOf(element: Element): string | undefined {
    return this.built.get(element)?.key;
  }

  /** The entries on screen, in order. */
  public entries(): Array<{ key: string; element: HTMLElement }> {
    return [...this.element.children].flatMap((element) => {
      const key = this.keyOf(element);
      return key !== undefined && element instanceof HTMLElement ? [{ key, element }] : [];
    });
  }

  /** Replaces the entries with markup that is not a list: placeholders, an empty or a locked conversation. */
  public showState(markup: string): void {
    if (this.state === markup && this.nodes.size === 0) return;
    this.nodes.clear();
    this.state = markup;
    this.element.innerHTML = markup;
  }

  /**
   * Puts exactly `entries` on screen, in order. Elements whose markup did not
   * change stay where they are and are never moved when already in order:
   * moving one would drop a selection inside it. Focus inside a rebuilt entry
   * returns to the same control of the same entry, never a neighbor's.
   * Returns whether anything changed.
   */
  public render(entries: readonly FeedEntry[]): boolean {
    const focus = this.captureFocus();
    const placed = new Map<string, HTMLElement>();
    const created: HTMLElement[] = [];
    for (const entry of entries) {
      if (placed.has(entry.key)) continue;
      const current = this.nodes.get(entry.key);
      if (current && current.parentElement === this.element && this.built.get(current)?.html === entry.html) {
        placed.set(entry.key, current);
        continue;
      }
      const element = this.create(entry);
      if (!element) continue;
      placed.set(entry.key, element);
      created.push(element);
    }
    const keep = new Set<Node>(placed.values());
    let changed = created.length > 0;
    for (const child of [...this.element.childNodes]) {
      if (keep.has(child)) continue;
      child.remove();
      changed = true;
    }
    let cursor = this.element.firstElementChild;
    for (const element of placed.values()) {
      if (element === cursor) {
        cursor = element.nextElementSibling;
        continue;
      }
      this.element.insertBefore(element, cursor);
    }
    this.nodes.clear();
    for (const [key, element] of placed) this.nodes.set(key, element);
    this.state = null;
    this.bindCreated(created);
    if (focus) this.restoreFocus(focus);
    return changed;
  }

  /** Adds entries after the last one; an entry already on screen is updated in place instead. */
  public append(entries: readonly FeedEntry[]): HTMLElement[] {
    if (this.state !== null) {
      this.element.replaceChildren();
      this.state = null;
    }
    const created: HTMLElement[] = [];
    for (const entry of entries) {
      if (this.nodes.has(entry.key)) {
        this.replace(entry.key, entry.html);
        continue;
      }
      const element = this.create(entry);
      if (!element) continue;
      this.element.append(element);
      this.nodes.set(entry.key, element);
      created.push(element);
    }
    this.bindCreated(created);
    return created;
  }

  /**
   * Rebuilds one entry from new markup. Returns the new element, or null when
   * the entry is not on screen or its markup did not change.
   */
  public replace(key: string, markup: string): HTMLElement | null {
    const current = this.nodes.get(key);
    if (!current || current.parentElement !== this.element || this.built.get(current)?.html === markup) return null;
    const element = this.create({ key, html: markup });
    if (!element) return null;
    const focus = current.contains(document.activeElement) ? this.captureFocus() : null;
    current.replaceWith(element);
    this.nodes.set(key, element);
    this.bindCreated([element]);
    if (focus) this.restoreFocus(focus);
    return element;
  }

  /**
   * Brings an entry up to date by changing only part of it, e.g. a progress
   * bar, so the rest keeps its selection and hover. `apply` returns false when
   * it could not, and the entry is left as it was.
   */
  public patch(key: string, markup: string, apply: (element: HTMLElement) => boolean): boolean {
    const element = this.nodes.get(key);
    if (!element || element.parentElement !== this.element || !apply(element)) return false;
    this.built.set(element, { key, html: markup });
    return true;
  }

  public remove(key: string): boolean {
    const element = this.nodes.get(key);
    if (!element) return false;
    element.remove();
    this.nodes.delete(key);
    return true;
  }

  /**
   * The first entry at least partly in view among those `accept` allows, and
   * where it sits, to keep it there while entries around it change.
   */
  public captureAnchor(accept: (key: string) => boolean = () => true): FeedAnchor | null {
    const candidates = this.entries().filter((entry) => accept(entry.key));
    const top = this.element.getBoundingClientRect().top;
    let low = 0;
    let high = candidates.length - 1;
    let found: { key: string; element: HTMLElement } | null = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (candidates[middle].element.getBoundingClientRect().bottom > top) {
        found = candidates[middle];
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return found ? { key: found.key, top: found.element.getBoundingClientRect().top } : null;
  }

  /** Exact restoration of what was on screen, not a navigation: instant on purpose. */
  public restoreAnchor(anchor: FeedAnchor): void {
    const element = this.nodes.get(anchor.key);
    if (!element?.isConnected) return;
    const shift = element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) >= 1) this.element.scrollTop += shift;
  }

  /**
   * Moves to the newest message. A reveal (opening the conversation or its
   * history) moves only the last stretch, whatever the history length, and
   * keeps up for a moment with a viewport that shrinks under it.
   */
  public scrollToEnd({ reveal = false, keepReveal = false }: { reveal?: boolean; keepReveal?: boolean } = {}): void {
    this.following = true;
    // Only the bounded reveal is followed, and briefly: other scrolls, including
    // one already at the end, are not in flight. Something under or in the feed
    // settling as the conversation opens (the command composer, its bot cards)
    // keeps the reveal's moment instead: the composer may still grow, and the
    // newest message must not end up behind it (#840).
    if (reveal) this.revealingUntil = this.atEnd() ? 0 : performance.now() + REVEAL_FOLLOW_MS;
    else if (!keepReveal) this.revealingUntil = 0;
    this.pinToEnd(reveal);
    // The feed height can still settle right after the markup changed. Only an
    // end that moved is pinned again: pinning the same end once more in the next
    // frame can cut short the scroll already on its way (measured in Electron).
    requestAnimationFrame(() => {
      const feed = this.element;
      if (feed.isConnected && this.followsEnd() && Math.abs(feed.scrollHeight - feed.clientHeight - this.pinnedEnd) >= 1) {
        this.pinToEnd(reveal);
      }
    });
  }

  /** Keeps the newest message in view while the reader follows it, without ending a reveal (#840). */
  public followEnd(): void {
    if (this.followsEnd()) this.scrollToEnd({ keepReveal: true });
  }

  /**
   * Images, videos and embeds only get their real height after loading, which
   * grows the feed and would leave the view above the newest message. Re-pin
   * it while the reader has not scrolled away (#270).
   */
  public repinWhileMediaLoads(target: HTMLElement, reveal = false): void {
    const repin = () => {
      if (!this.element.isConnected || !target.isConnected || !this.followsEnd()) return;
      this.pinToEnd(reveal);
    };
    const media = [...target.querySelectorAll<HTMLElement>('img, iframe, video')];
    if (target.matches('img, iframe, video')) media.push(target);
    for (const element of media) {
      if (element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0) continue;
      if (element instanceof HTMLVideoElement) {
        // Media elements never fire "load"; their box only settles once metadata arrives.
        element.addEventListener('loadedmetadata', repin, { once: true });
        element.addEventListener('loadeddata', repin, { once: true });
      } else {
        element.addEventListener('load', repin, { once: true });
      }
    }
  }

  /** Brings an entry into view and marks it, following "reduce motion"; focus moves there for the keyboard. */
  public jumpTo(key: string): boolean {
    const element = this.nodes.get(key);
    if (!element?.isConnected) return false;
    // The scroll is on its way: the next update must not pull the feed back to the end.
    this.stopFlight();
    this.following = false;
    this.revealingUntil = 0;
    smoothScrollIntoView(element, { block: 'center' });
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
    highlightMessageJump(element);
    return true;
  }

  public destroy(): void {
    this.lifetime.abort();
    this.resize.disconnect();
    this.stopFlight();
    this.nodes.clear();
    this.state = null;
  }

  private create(entry: FeedEntry): HTMLElement | null {
    const element = build(entry.html);
    if (element) this.built.set(element, { key: entry.key, html: entry.html });
    return element;
  }

  /** Scrolls to the newest message, telling its frames apart from the reader's own scrolling. */
  private pinToEnd(reveal: boolean): void {
    const feed = this.element;
    // The scroll starts from where the view is now, entries just changed included.
    this.look();
    this.drift = 0;
    this.pinnedEnd = this.seenEnd;
    // Already at the end, nothing moves: no frame would end the scroll.
    if (this.seenEnd - this.seenTop >= 1) {
      this.autoScrollUntil = performance.now() + AUTO_SCROLL_MS;
      window.clearTimeout(this.landing);
      this.landing = window.setTimeout(() => this.checkFlight(true), AUTO_SCROLL_MS);
    }
    // A pin asked before the reveal (the follow-up frame of an earlier scroll, media
    // still loading) can run during it: it keeps the reveal's short movement.
    if (reveal || performance.now() < this.revealingUntil) restoreScrollWithMotion(feed, feed.scrollHeight);
    else smoothScrollTo(feed, { top: feed.scrollHeight });
    // An instant scroll (reduced motion, the first leg of a reveal, smooth scrolling
    // turned off in the system) is already where it went, before its scroll event.
    // The reader moving the view up before that event is measured from there: from
    // where the scroll started, the way down would hide the way up (#490).
    this.look();
  }

  /**
   * Notes where the view and the end are, and returns how far the view went up
   * since the last look beyond what the content explains: scroll anchoring moves
   * the view exactly as much as entries above changed, and the end with it,
   * while entries changing below only move the end. With entries changing on
   * both sides between two looks, a row above shrinking and an image below
   * loading, the end alone reads a climb that never was. The entry in view
   * tells them apart: anchoring holds it still and changes below never move
   * it, while the view going up brings it down on screen. Only a climb both
   * agree on counts; without that entry, the end alone decides (#490).
   */
  private look(): number {
    const feed = this.element;
    const top = feed.scrollTop;
    const end = feed.scrollHeight - feed.clientHeight;
    let up = this.seenTop - top + Math.min(0, end - this.seenEnd);
    const origin = feed.getBoundingClientRect().top;
    const seen = this.seenEntry ? this.nodes.get(this.seenEntry.key) : undefined;
    if (this.seenEntry && seen?.isConnected) {
      up = Math.min(up, seen.getBoundingClientRect().top - origin - this.seenEntry.top);
    }
    this.seenTop = top;
    this.seenEnd = end;
    const entry = this.captureAnchor();
    this.seenEntry = entry && { key: entry.key, top: entry.top - origin };
    return up;
  }

  /**
   * The automatic scroll only moves down: the view going up by more than the
   * content explains is the reader, however they scroll (keys with the focus
   * outside the feed, a selection dragged past its edge, the scrollbar). That
   * ends the scroll and the reveal (#490). So does running out of time, after
   * a last look for a climb whose scroll event has not come yet, and getting
   * to the very end: until then the scroll is still on its way, and content
   * growing under the view in its last stretch is still followed.
   */
  private checkFlight(timeUp = performance.now() >= this.autoScrollUntil): void {
    this.drift += Math.max(0, this.look());
    const climbed = this.drift > DRIFT_PX;
    if (climbed) this.revealingUntil = 0;
    if (climbed || timeUp || this.seenEnd - this.seenTop <= ARRIVED_PX) this.land();
  }

  /**
   * The automatic scroll is over: it got to the end, ran out of time, or the
   * reader took over. Only the reader moving the view up stops the following,
   * from where they left it; anything else that kept the scroll short of the
   * end (the composer growing under it, say) does not (#490).
   */
  private land(): void {
    const climbed = this.drift > DRIFT_PX;
    this.stopFlight();
    if (climbed) this.following = this.atEnd();
  }

  private stopFlight(): void {
    window.clearTimeout(this.landing);
    this.autoScrollUntil = 0;
    this.drift = 0;
  }

  private bindCreated(elements: readonly HTMLElement[]): void {
    for (const element of elements) {
      const key = this.keyOf(element);
      if (key !== undefined) this.options.onCreate?.(element, key);
    }
  }

  private captureFocus(): FocusedControl | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === this.element || !this.element.contains(active)) return null;
    let entry: Element | null = active;
    while (entry && entry.parentElement !== this.element) entry = entry.parentElement;
    const key = entry ? this.keyOf(entry) : undefined;
    if (!entry || key === undefined) return null;
    if (entry === active) return { key, selector: null, index: 0 };
    const selector = describe(active);
    return { key, selector, index: Math.max(0, [...entry.querySelectorAll(selector)].indexOf(active)) };
  }

  /** Focus left with a rebuilt entry goes back to the same control of the same entry, or to the entry itself. */
  private restoreFocus(focus: FocusedControl): void {
    // Still where it was: its entry was not rebuilt.
    if (document.activeElement && document.activeElement !== document.body) return;
    const element = this.nodes.get(focus.key);
    if (!element?.isConnected) return;
    const control = focus.selector ? element.querySelectorAll<HTMLElement>(focus.selector)[focus.index] : undefined;
    (control ?? element).focus({ preventScroll: true });
  }
}
