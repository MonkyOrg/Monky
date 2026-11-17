import { settingsStore } from '../stores/settingsStore';

/** How firm the touch reply is: a choice, a call action, leaving the call, or a failure. */
export type HapticKind = 'selection' | 'impact' | 'heavy' | 'error';

const VIBRATION: Record<HapticKind, number | number[]> = {
  selection: 8,
  impact: 14,
  heavy: 28,
  error: [28, 60, 28],
};

/** Safari has a single tick, so a failure repeats it. */
const IOS_TICKS: Record<HapticKind, number> = { selection: 1, impact: 1, heavy: 1, error: 2 };
const IOS_TICK_GAP_MS = 110;

/** Switches and choice cards reply on their own; any other control opts in with `data-haptic="<kind>"`. */
const TARGETS = '[data-haptic], .toggle-switch input, .input-mode-card';

function isHapticKind(value: string): value is HapticKind {
  return Object.hasOwn(VIBRATION, value);
}

function coarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

function canVibrate(): boolean {
  return typeof navigator.vibrate === 'function';
}

/** Safari on the iPhone has no `vibrate`, but toggling a `switch` checkbox plays the system tick. */
function hasSwitchTick(): boolean {
  return 'switch' in HTMLInputElement.prototype;
}

/**
 * Whether this device can reply to a touch: a phone or tablet whose browser
 * vibrates (Android) or plays the switch tick (Safari on iOS 18). The desktop
 * app and computers never do.
 */
export function hapticsSupported(): boolean {
  return coarsePointer() && (canVibrate() || hasSwitchTick());
}

let tickLabel: HTMLLabelElement | null = null;

function switchTick(): HTMLLabelElement {
  if (tickLabel?.isConnected) return tickLabel;
  const doc = document;
  const label = doc.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.dataset.hapticTick = '';
  label.style.display = 'none';
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.append(input);
  // Outside the body: nothing that looks for the page's controls ever finds it.
  doc.head.append(label);
  tickLabel = label;
  return label;
}

/**
 * Plays a short touch reply. Browsers only allow it during (or right after) a
 * tap, so a reply to something that arrived from the network may stay silent.
 */
export function haptic(kind: HapticKind): void {
  if (!settingsStore.hapticsEnabled || !hapticsSupported()) return;
  const activation = navigator.userActivation;
  if (activation && !activation.hasBeenActive) return;
  if (canVibrate()) {
    navigator.vibrate(VIBRATION[kind]);
    return;
  }
  const label = switchTick();
  label.click();
  for (let tick = 1; tick < IOS_TICKS[kind]; tick++) window.setTimeout(() => label.click(), tick * IOS_TICK_GAP_MS);
}

function kindOf(control: Element): HapticKind {
  const declared = control.getAttribute('data-haptic');
  return declared !== null && isHapticKind(declared) ? declared : 'selection';
}

/**
 * Makes the app's controls reply to the touch: one listener for the whole page.
 * Locked desktop-only controls stop their click before it gets here.
 */
export function installHaptics(): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  // The tick toggles a hidden switch; its events must not look like a click on the page (closing menus, for instance).
  const hideTick = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('[data-haptic-tick]')) event.stopImmediatePropagation();
  };
  for (const type of ['click', 'input', 'change'] as const) window.addEventListener(type, hideTick, { capture: true, signal });
  document.addEventListener('click', (event) => {
    const control = event.target instanceof Element ? event.target.closest(TARGETS) : null;
    if (control && !control.closest('[data-haptic-tick]')) haptic(kindOf(control));
  }, { capture: true, signal });
  return () => {
    controller.abort();
    tickLabel?.remove();
    tickLabel = null;
  };
}
