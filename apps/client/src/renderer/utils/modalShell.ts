import { appEvents } from '../core/EventBus';
import { isForegroundEvent } from '../core/sessionRouting';
import type { SafeHtml } from './html';
import { enterModal, exitModal, handlesModalKey } from './modalSurface';

/** Why a modal closed, so `canClose` can tell a person's dismissal from a programmatic one. */
export type ModalCloseReason = 'escape' | 'backdrop' | 'button' | 'api' | 'session' | 'owner';

export interface ModalShellOptions {
  /** The card: a single root element, normally `.modal-card`. Its id-based hooks stay as written. */
  card: string | SafeHtml;
  /** Classes added to the backdrop next to `modal-backdrop`. */
  backdropClass?: string;
  /** Accessible name for a card without a visible title (`aria-label`). */
  label?: string;
  /**
   * Where focus starts: an element or a selector inside the card. By default the
   * first control below the header, then the card itself; `false` leaves it to the caller.
   */
  initialFocus?: HTMLElement | string | false;
  /** Who gets the focus back on close; by default whoever had it when the modal opened. */
  returnFocus?: Element | null;
  /** Escape closes unless this is false. */
  closeOnEscape?: boolean;
  /** A press that starts on the backdrop closes unless this is false. */
  closeOnBackdrop?: boolean;
  /** Keeps the modal open while it returns false (an operation in flight). The owner's end always closes. */
  canClose?: (reason: ModalCloseReason) => boolean;
  /** Other keys of this dialog (Enter, shortcuts); runs only while it owns the keyboard. */
  onKeydown?: (event: KeyboardEvent) => void;
  /** Closes at once, with its popups, when the visible server changes or its connection drops. */
  closeWithSession?: boolean;
  /** The owner's lifetime: when it aborts, the modal closes at once. */
  signal?: AbortSignal;
  /** Runs once, as soon as the modal starts to close. */
  onClose?: (reason: ModalCloseReason) => void;
}

export interface ModalShell {
  /** The backdrop, which is also the element `modalSurface` stacks. */
  readonly element: HTMLElement;
  readonly card: HTMLElement;
  /** Aborted when the modal closes: bind every listener of its content to it. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  /** Returns false when `canClose` kept it open. Closing a closed modal again only hurries its exit. */
  close(reason?: ModalCloseReason, immediate?: boolean): boolean;
}

const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]';
let titles = 0;

/** What Tab can reach inside `root`, in document order. */
export function tabbableControls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter(control => control.tabIndex >= 0
    && !control.matches(':disabled') && !control.closest('[inert], [hidden]') && control.getClientRects().length > 0);
}

function focusCard(card: HTMLElement): void {
  if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
  card.focus({ preventScroll: true });
}

/** Keeps Tab inside the card: only the step that would leave it wraps around. */
function trapTab(card: HTMLElement, event: KeyboardEvent): void {
  const controls = tabbableControls(card);
  const active = document.activeElement;
  if (!controls.length) {
    event.preventDefault();
    focusCard(card);
    return;
  }
  const direction = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  if (active instanceof Node && card.contains(active)
    && controls.some(control => control !== active && (active.compareDocumentPosition(control) & direction))) return;
  event.preventDefault();
  controls[event.shiftKey ? controls.length - 1 : 0].focus({ preventScroll: true });
}

/** Every modal is announced as a dialog, by its title when it has one; title icons are decoration. */
function describeDialog(card: HTMLElement, label: string | undefined): void {
  if (!card.hasAttribute('role')) card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.querySelectorAll('.modal-title .material-symbols-outlined:not([aria-hidden])')
    .forEach(icon => icon.setAttribute('aria-hidden', 'true'));
  if (card.hasAttribute('aria-label') || card.hasAttribute('aria-labelledby')) return;
  const title = card.querySelector<HTMLElement>('.modal-title, h1, h2');
  if (title?.textContent?.trim()) {
    title.id ||= `modal-title-${++titles}`;
    card.setAttribute('aria-labelledby', title.id);
  } else if (label) card.setAttribute('aria-label', label);
}

function initialFocusOf(card: HTMLElement, option: ModalShellOptions['initialFocus']): HTMLElement | null {
  if (option instanceof HTMLElement) return option;
  if (typeof option === 'string') return card.querySelector<HTMLElement>(option);
  return null;
}

/** Focus starts on the requested control; one that is disabled or hidden yields to the first control. */
function focusInitially(card: HTMLElement, option: ModalShellOptions['initialFocus']): void {
  const preferred = initialFocusOf(card, option);
  preferred?.focus({ preventScroll: true });
  if (preferred && document.activeElement === preferred) return;
  const controls = tabbableControls(card);
  const first = controls.find(control => !control.closest('.modal-header, .settings-content-header')) ?? controls[0];
  first?.focus({ preventScroll: true });
  if (!first || document.activeElement !== first) focusCard(card);
}

/**
 * The one lifecycle every modal shares (#490): the backdrop on the modal stack,
 * Escape and Tab from a single capture listener that yields to whatever modal or
 * popup is above it, a press on the backdrop, `[data-modal-close]` buttons, the
 * dialog role and name, the first focus and its return (only through
 * `exitModal`), and every listener bound to `signal`.
 *
 * The content keeps its own markup and behaviour; a view that re-renders writes
 * inside `card`, never replacing it, so a child dialog keeps covering it.
 */
export function openModal(options: ModalShellOptions): ModalShell {
  const element = document.createElement('div');
  element.className = `modal-backdrop${options.backdropClass ? ` ${options.backdropClass}` : ''}`;
  element.innerHTML = String(options.card);
  const card = element.firstElementChild;
  if (!(card instanceof HTMLElement) || element.childElementCount !== 1) throw new Error('A modal needs exactly one card');
  describeDialog(card, options.label);
  const controller = new AbortController();
  const signal = controller.signal;
  let closed = false;
  const close = (reason: ModalCloseReason = 'api', immediate = false): boolean => {
    if (closed) {
      if (immediate) exitModal(element, true);
      return true;
    }
    if (reason !== 'owner' && options.canClose && !options.canClose(reason)) return false;
    closed = true;
    controller.abort();
    exitModal(element, immediate);
    options.onClose?.(reason);
    return true;
  };
  document.addEventListener('keydown', (event) => {
    if (!handlesModalKey(element, event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      // A search being typed is cleared first; the next Escape closes.
      const field = event.target;
      if (field instanceof HTMLInputElement && field.hasAttribute('data-clear-on-escape') && field.value && card.contains(field)) {
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (options.closeOnEscape !== false) close('escape');
    } else if (event.key === 'Tab') trapTab(card, event);
    else options.onKeydown?.(event);
  }, { capture: true, signal });
  element.addEventListener('mousedown', (event) => {
    if (event.target === element && options.closeOnBackdrop !== false) close('backdrop');
  }, { signal });
  card.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-modal-close]') : null;
    if (button && card.contains(button) && !button.matches(':disabled')) close('button');
  }, { signal });
  if (options.closeWithSession) {
    // Another server's content goes away at once, popups included: an exit animation would leave it over the new one.
    const unbind = [
      appEvents.on('session.changed', () => close('session', true)),
      appEvents.on('network.disconnected', () => { if (isForegroundEvent()) close('session', true); }),
    ];
    signal.addEventListener('abort', () => unbind.forEach(off => off()), { once: true });
  }
  document.body.append(element);
  enterModal(element, options.returnFocus === undefined ? document.activeElement : options.returnFocus);
  if (options.signal?.aborted) close('owner', true);
  else options.signal?.addEventListener('abort', () => close('owner', true), { once: true, signal });
  if (!closed && options.initialFocus !== false) focusInitially(card, options.initialFocus);
  return {
    element, card, signal, close,
    get closed() { return closed; },
  };
}
