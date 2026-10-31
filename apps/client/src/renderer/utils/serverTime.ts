import { html, type SafeHtml } from './html';

/** The furthest instant a `Date` holds, either side of 1970, in milliseconds. */
const DATE_RANGE_MS = 8.64e15;

/**
 * A time a server sent, or null when it is not one a `Date` can hold: text, `NaN` and numbers
 * beyond the range would make `toISOString()` and `Intl` throw and take the whole view down.
 */
export function serverDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= DATE_RANGE_MS ? new Date(value) : null;
}

/** Whether a server's value is a time the app can show. */
export function isServerTime(value: unknown): value is number {
  return serverDate(value) !== null;
}

/** A server's time as a `<time>` element showing `format(date)`, or nothing when it is not a valid time. */
export function serverTimeHtml(value: unknown, format: (date: Date) => string, className?: string): SafeHtml | '' {
  const date = serverDate(value);
  return date ? html`<time${className ? html` class="${className}"` : ''} datetime="${date.toISOString()}">${format(date)}</time>` : '';
}
