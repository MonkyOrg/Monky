import { smoothScrollIntoView } from './scroll';

/**
 * Keyboard movement within a list of options, menu items, tabs or cards
 * (R-VOICEUI-13): one rule for the arrows, Home, End and type-to-select, so
 * every list moves the same way instead of each copying the last one.
 */

/** Which arrows move through a list: those of a column, of a row, or both. */
export type RovingOrientation = 'vertical' | 'horizontal' | 'both';

export interface RovingOptions {
  orientation?: RovingOrientation;
  /** Past either end the arrows come round to the other one; with false they stop there. */
  wrap?: boolean;
}

const FORWARD: Record<RovingOrientation, readonly string[]> = {
  vertical: ['ArrowDown'], horizontal: ['ArrowRight'], both: ['ArrowDown', 'ArrowRight'],
};
const BACKWARD: Record<RovingOrientation, readonly string[]> = {
  vertical: ['ArrowUp'], horizontal: ['ArrowLeft'], both: ['ArrowUp', 'ArrowLeft'],
};

/**
 * The index a key moves to among `length` items, or null when the key does
 * not move through this list. Home and End go to the ends, and each arrow of
 * the orientation steps one item. From outside the list (`index` -1) the
 * forward arrow enters at the first item and the backward one at the last.
 */
export function nextIndex(key: string, index: number, length: number, options: RovingOptions = {}): number | null {
  const { orientation = 'vertical', wrap = true } = options;
  if (length <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  const forward = FORWARD[orientation].includes(key);
  if (!forward && !BACKWARD[orientation].includes(key)) return null;
  if (index < 0 || index >= length) return forward ? 0 : length - 1;
  const next = index + (forward ? 1 : -1);
  return wrap ? (next + length) % length : Math.max(0, Math.min(length - 1, next));
}

/** Letters typed this close together spell one word, as in a native select. */
export const TYPEAHEAD_PAUSE_MS = 600;

/**
 * Type-to-select for a list: each letter extends the word typed less than
 * TYPEAHEAD_PAUSE_MS before, or starts a new one, and finds the first item
 * whose text begins with it. Space presses the focused item, and keys held
 * with Ctrl, Alt or Meta are shortcuts: none of them is typing.
 */
export function createTypeahead(now: () => number = () => performance.now()) {
  let word = '';
  let typedAt = Number.NEGATIVE_INFINITY;
  return <T extends { textContent: string | null }>(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
    items: readonly T[]): T | undefined => {
    if (event.key.length !== 1 || event.key === ' ' || event.ctrlKey || event.metaKey || event.altKey) return undefined;
    const at = now();
    word = at - typedAt < TYPEAHEAD_PAUSE_MS ? word + event.key : event.key;
    typedAt = at;
    const typed = word.toLocaleLowerCase();
    return items.find(item => item.textContent?.trim().toLocaleLowerCase().startsWith(typed));
  };
}

/** Moves focus to the item a key reached and brings it into view without jumping. */
export function focusItem(item: HTMLElement): void {
  item.focus({ preventScroll: true });
  smoothScrollIntoView(item, { block: 'nearest' });
}
