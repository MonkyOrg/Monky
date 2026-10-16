import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { isButtonLoading, withButtonLoading } from '../utils/buttonLoading';
import { MESSAGE_SELECTION_MAX, dragSelection, edgeScrollSpeed } from '../utils/messageSelection';
import { animateEnter, removeWithMotion, topModal } from '../utils/surfaceMotion';
import { showInfoToast } from './CopyToast';

export interface MessageSelectionAction {
  id: string;
  icon: string;
  label: string;
  danger?: boolean;
  /** Why the action cannot run for this selection; undefined when it can. */
  unavailable?: string;
  run: (ids: string[]) => Promise<void> | void;
}

export interface MessageSelectionOptions {
  /** The scrolling feed holding `.chat-message-row[data-message-id]` rows. */
  feed(): HTMLElement | null;
  /** The composer area: the action bar takes its place while selecting. */
  host(): HTMLElement | null;
  selectable(row: HTMLElement): boolean;
  /** Actions for the current selection, always in the same order. */
  actions(ids: string[]): MessageSelectionAction[];
}

const ROW = '.chat-message-row[data-message-id]';
/** Holding the button this long on a message starts a drag selection. */
const HOLD_MS = 260;
/** Moving this far before the hold also starts it: a quick drag means the same. */
const DRAG_SLOP_PX = 6;

interface PointerGesture {
  pointerId: number;
  anchor: string;
  startX: number;
  startY: number;
  lastY: number;
  timer: number;
  dragging: boolean;
  target: boolean;
  before: Set<string>;
  frame: number;
}

/**
 * Selection mode of a chat feed: clicking toggles messages, holding and dragging
 * selects a range while the feed scrolls near its edges, and an action bar
 * replaces the composer until the user cancels or an action finishes.
 */
export class MessageSelection {
  private selected = new Set<string>();
  private listeners: AbortController | null = null;
  private bar: HTMLElement | null = null;
  private gesture: PointerGesture | null = null;
  private limitNoticeShown = false;

  constructor(private readonly options: MessageSelectionOptions) {}

  public isActive(): boolean {
    return this.listeners !== null;
  }

  /** Message ids in the order they appear in the conversation. */
  public ids(): string[] {
    const feed = this.options.feed();
    if (!feed) return [];
    return [...feed.querySelectorAll<HTMLElement>(ROW)]
      .map((row) => row.dataset.messageId ?? '')
      .filter((id) => this.selected.has(id));
  }

  public start(messageId?: string): void {
    const feed = this.options.feed();
    const host = this.options.host();
    if (!feed || !host) return;
    if (!this.isActive()) {
      const anchor = (messageId ? this.row(messageId) : null) ?? this.firstVisibleRow(feed);
      this.keepInPlace(feed, anchor, () => {
        this.listeners = new AbortController();
        this.limitNoticeShown = false;
        this.bindFeed(feed, this.listeners.signal);
        feed.classList.add('is-selecting-messages');
        feed.setAttribute('role', 'listbox');
        feed.setAttribute('aria-multiselectable', 'true');
        feed.setAttribute('aria-label', t('chat.selectionLabel'));
        this.mountBar(host);
      });
    }
    if (messageId) {
      const row = this.row(messageId);
      if (row && this.options.selectable(row)) this.apply(new Set([...this.selected, messageId]));
      row?.focus({ preventScroll: true });
    }
    this.sync();
  }

  public stop(): void {
    if (!this.listeners) return;
    this.cancelGesture();
    this.listeners.abort();
    this.listeners = null;
    const feed = this.options.feed();
    const anchor = feed ? (this.row(this.ids()[0] ?? '') ?? this.firstVisibleRow(feed)) : null;
    this.selected.clear();
    const leave = () => {
      if (feed) {
        feed.classList.remove('is-selecting-messages', 'is-drag-selecting');
        feed.removeAttribute('role');
        feed.removeAttribute('aria-multiselectable');
        feed.removeAttribute('aria-label');
        feed.querySelectorAll<HTMLElement>(ROW).forEach((row) => {
          row.classList.remove('is-selected', 'is-unselectable');
          row.removeAttribute('aria-selected');
          row.removeAttribute('role');
        });
      }
      this.options.host()?.classList.remove('message-selection-host--active');
      if (this.bar) removeWithMotion(this.bar, 'panel');
      this.bar = null;
    };
    if (feed?.isConnected) this.keepInPlace(feed, anchor, leave);
    else leave();
  }

  private firstVisibleRow(feed: HTMLElement): HTMLElement | null {
    const top = feed.getBoundingClientRect().top;
    return [...feed.querySelectorAll<HTMLElement>(ROW)].find((row) => row.getBoundingClientRect().bottom > top) ?? null;
  }

  /**
   * Selection mode changes every row's spacing and swaps the composer for the bar,
   * which would push the messages the user was looking at out of view. The feed
   * stays at the end when it was there; otherwise `anchor` keeps its place.
   * Restoring that exact position is instant on purpose: nothing moved for the user.
   */
  private keepInPlace(feed: HTMLElement, anchor: HTMLElement | null, change: () => void): void {
    const atEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 4;
    const before = anchor?.isConnected ? anchor.getBoundingClientRect().top : null;
    change();
    if (atEnd) {
      feed.scrollTop = feed.scrollHeight;
      // The bar and the composer animate in and out; keep reading the end while they settle.
      const follow = new ResizeObserver(() => { feed.scrollTop = feed.scrollHeight; });
      follow.observe(feed);
      window.setTimeout(() => follow.disconnect(), 600);
    } else if (before !== null && anchor?.isConnected) feed.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  /** Re-applies the selection after rows were rendered again, dropping messages that left or changed. */
  public sync(): void {
    if (!this.isActive()) return;
    const feed = this.options.feed();
    if (!feed) return;
    const present = new Set<string>();
    feed.querySelectorAll<HTMLElement>(ROW).forEach((row) => {
      const id = row.dataset.messageId ?? '';
      const selectable = this.options.selectable(row);
      if (selectable) present.add(id);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selectable && this.selected.has(id)));
      row.classList.toggle('is-selected', selectable && this.selected.has(id));
      row.classList.toggle('is-unselectable', !selectable);
    });
    const kept = [...this.selected].filter((id) => present.has(id));
    if (kept.length !== this.selected.size) this.selected = new Set(kept);
    this.renderBar();
  }

  private row(messageId: string): HTMLElement | null {
    return this.options.feed()?.querySelector<HTMLElement>(`${ROW}[data-message-id="${CSS.escape(messageId)}"]`) ?? null;
  }

  private selectableRows(feed: HTMLElement): HTMLElement[] {
    return [...feed.querySelectorAll<HTMLElement>(ROW)].filter((row) => this.options.selectable(row));
  }

  private apply(next: Set<string>): void {
    if (next.size > MESSAGE_SELECTION_MAX) next = new Set([...next].slice(0, MESSAGE_SELECTION_MAX));
    const feed = this.options.feed();
    feed?.querySelectorAll<HTMLElement>(ROW).forEach((row) => {
      const id = row.dataset.messageId ?? '';
      const now = next.has(id);
      if (now === this.selected.has(id)) return;
      row.classList.toggle('is-selected', now);
      row.setAttribute('aria-selected', String(now));
    });
    this.selected = next;
    this.renderBar();
  }

  private toggle(row: HTMLElement): void {
    const id = row.dataset.messageId ?? '';
    if (!this.options.selectable(row)) return;
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else if (next.size >= MESSAGE_SELECTION_MAX) { this.noticeLimit(); return; }
    else next.add(id);
    this.apply(next);
  }

  private noticeLimit(): void {
    if (this.limitNoticeShown) return;
    this.limitNoticeShown = true;
    showInfoToast(t('chat.selectionLimit', { max: MESSAGE_SELECTION_MAX }));
  }

  private bindFeed(feed: HTMLElement, signal: AbortSignal): void {
    const rowOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(ROW) : null;

    feed.addEventListener('pointerdown', (event) => {
      const row = rowOf(event.target);
      if (event.button !== 0 || !row || !feed.contains(row)) return;
      event.preventDefault();
      this.cancelGesture();
      const anchor = row.dataset.messageId ?? '';
      this.gesture = {
        pointerId: event.pointerId, anchor, startX: event.clientX, startY: event.clientY, lastY: event.clientY,
        timer: window.setTimeout(() => this.beginDrag(feed), HOLD_MS),
        dragging: false, target: !this.selected.has(anchor), before: new Set(this.selected), frame: 0,
      };
      row.focus({ preventScroll: true });
      try { feed.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
    }, { signal });

    feed.addEventListener('pointermove', (event) => {
      const gesture = this.gesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.lastY = event.clientY;
      if (!gesture.dragging && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > DRAG_SLOP_PX) {
        this.beginDrag(feed);
      }
      if (gesture.dragging) this.extendDrag(feed);
    }, { signal });

    const finish = (event: PointerEvent, cancelled: boolean) => {
      const gesture = this.gesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const wasDragging = gesture.dragging;
      this.cancelGesture();
      if (!wasDragging && !cancelled) {
        const row = this.row(gesture.anchor);
        if (row) this.toggle(row);
      }
    };
    feed.addEventListener('pointerup', (event) => finish(event, false), { signal });
    feed.addEventListener('pointercancel', (event) => finish(event, true), { signal });
    feed.addEventListener('lostpointercapture', (event) => {
      if (this.gesture?.pointerId === event.pointerId && this.gesture.dragging) this.cancelGesture();
    }, { signal });

    // Links, media and buttons inside a message do nothing while selecting: a click picks the message.
    feed.addEventListener('click', (event) => {
      if (rowOf(event.target)) { event.preventDefault(); event.stopPropagation(); }
    }, { capture: true, signal });
    feed.addEventListener('dblclick', (event) => {
      if (rowOf(event.target)) { event.preventDefault(); event.stopPropagation(); }
    }, { capture: true, signal });
    feed.addEventListener('contextmenu', (event) => {
      if (rowOf(event.target)) { event.preventDefault(); event.stopPropagation(); }
    }, { capture: true, signal });

    feed.addEventListener('keydown', (event) => {
      const row = rowOf(event.target);
      if (!row || event.target !== row || (event.key !== ' ' && event.key !== 'Enter')) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggle(row);
    }, { signal });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || topModal()) return;
      if (document.querySelector('.floating-context-menu:not([data-ui-closing])')) return;
      event.preventDefault();
      event.stopPropagation();
      this.stop();
    }, { capture: true, signal });
  }

  private beginDrag(feed: HTMLElement): void {
    const gesture = this.gesture;
    if (!gesture || gesture.dragging) return;
    window.clearTimeout(gesture.timer);
    const anchor = this.row(gesture.anchor);
    if (!anchor || !this.options.selectable(anchor)) { this.cancelGesture(); return; }
    gesture.dragging = true;
    feed.classList.add('is-drag-selecting');
    this.extendDrag(feed);
    const step = () => {
      if (this.gesture !== gesture || !gesture.dragging) return;
      const rect = feed.getBoundingClientRect();
      const speed = edgeScrollSpeed(gesture.lastY, rect.top, rect.bottom);
      if (speed !== 0) {
        // Following the pointer while it drags must stay instant; animating would lag behind it.
        const before = feed.scrollTop;
        feed.scrollTop = before + speed;
        if (feed.scrollTop !== before) this.extendDrag(feed);
      }
      gesture.frame = window.requestAnimationFrame(step);
    };
    gesture.frame = window.requestAnimationFrame(step);
  }

  private extendDrag(feed: HTMLElement): void {
    const gesture = this.gesture;
    if (!gesture?.dragging) return;
    const rows = this.selectableRows(feed);
    const order = rows.map((row) => row.dataset.messageId ?? '');
    const anchor = order.indexOf(gesture.anchor);
    if (anchor < 0) return;
    const rect = feed.getBoundingClientRect();
    const y = Math.min(Math.max(gesture.lastY, rect.top + 1), rect.bottom - 1);
    let current = rows.findIndex((row) => row.getBoundingClientRect().bottom >= y);
    if (current < 0) current = rows.length - 1;
    const next = dragSelection(order, gesture.before, anchor, current, gesture.target);
    if (gesture.target && next.size >= MESSAGE_SELECTION_MAX && Math.abs(current - anchor) + 1 > next.size - gesture.before.size) {
      this.noticeLimit();
    }
    this.apply(next);
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    window.clearTimeout(gesture.timer);
    window.cancelAnimationFrame(gesture.frame);
    this.gesture = null;
    const feed = this.options.feed();
    feed?.classList.remove('is-drag-selecting');
    try {
      if (feed?.hasPointerCapture(gesture.pointerId)) feed.releasePointerCapture(gesture.pointerId);
    } catch { /* already released */ }
  }

  private mountBar(host: HTMLElement): void {
    const bar = document.createElement('div');
    bar.className = 'message-selection-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', t('chat.selectionActions'));
    bar.innerHTML = `
      <span class="message-selection-count" role="status" aria-live="polite"></span>
      <div class="message-selection-actions"></div>
      <button type="button" class="message-selection-action message-selection-cancel" data-selection-cancel
        title="${escapeHtml(t('chat.selectionCancel'))}" aria-label="${escapeHtml(t('chat.selectionCancel'))}">
        <span class="material-symbols-outlined md-20" aria-hidden="true">close</span>
      </button>`;
    bar.querySelector('[data-selection-cancel]')?.addEventListener('click', () => this.stop());
    bar.querySelector('.message-selection-actions')?.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-selection-action]') : null;
      if (!button || button.getAttribute('aria-disabled') === 'true' || isButtonLoading(button)) return;
      const ids = this.ids();
      const action = this.options.actions(ids).find((entry) => entry.id === button.dataset.selectionAction);
      if (!action || action.unavailable || ids.length === 0) return;
      void withButtonLoading(button, () => action.run(ids));
    });
    host.prepend(bar);
    host.classList.add('message-selection-host--active');
    this.bar = bar;
    animateEnter(bar, 'panel');
  }

  private renderBar(): void {
    const bar = this.bar;
    if (!bar) return;
    const ids = this.ids();
    const count = bar.querySelector<HTMLElement>('.message-selection-count');
    if (count) {
      count.textContent = ids.length === 0 ? t('chat.selectionHint')
        : t(ids.length === 1 ? 'chat.selectionCount.one' : 'chat.selectionCount.other', { count: ids.length });
    }
    const list = bar.querySelector<HTMLElement>('.message-selection-actions');
    if (!list) return;
    for (const action of this.options.actions(ids)) {
      let button = list.querySelector<HTMLButtonElement>(`[data-selection-action="${CSS.escape(action.id)}"]`);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = `message-selection-action${action.danger ? ' message-selection-action--danger' : ''}`;
        button.dataset.selectionAction = action.id;
        button.innerHTML = `<span class="material-symbols-outlined md-20" aria-hidden="true">${escapeHtml(action.icon)}</span>
          <span class="message-selection-action-label">${escapeHtml(action.label)}</span>`;
        list.append(button);
      }
      // aria-disabled keeps the reason reachable by keyboard and hover, unlike `disabled`.
      const reason = ids.length === 0 ? t('chat.selectionEmpty') : action.unavailable;
      button.setAttribute('aria-disabled', String(!!reason));
      button.title = reason ?? action.label;
    }
  }
}
