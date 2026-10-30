import { LIMITS } from '@monky/shared';

/**
 * Checks for values that arrive from a renderer. Its arguments are structured
 * clones the page chose, whatever the contract types say, so handlers check
 * them before any I/O.
 */

/** A plain object: never null or an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A port a hosted server can listen on. */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= LIMITS.MIN_PORT && value <= LIMITS.MAX_PORT;
}

/**
 * A plain web address, the only kind Monky hands to the system browser or downloads:
 * file:// or one of the Windows handlers that take arguments would be opened by the system (#372).
 */
export function webUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
