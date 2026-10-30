import { inspect, types } from 'node:util';

/**
 * Longest text one log entry keeps, in the console and in the buffer the
 * desktop app and the CLI read back. Entries interpolate values that came from
 * clients: without a bound, one oversized value became a line megabytes long,
 * kept LOG_BUFFER_SIZE times over in memory.
 */
export const LOG_ENTRY_MAX_LENGTH = 16 * 1024;

/** Room kept at the end of a cut entry for the note saying how much was cut. */
const TRUNCATION_NOTE_ROOM = 64;

/** An Error, including one from another realm, which `instanceof` misses. */
export function isError(value: unknown): value is Error {
  return value instanceof Error || types.isNativeError(value);
}

/**
 * What a log call attaches after its message.
 *
 * `JSON.stringify` alone wrote `{}` for an Error, whose message and stack are
 * not enumerable, and threw on a cycle or a BigInt — usually from inside the
 * `.catch` that was reporting a failure. An Error keeps its stack, cause and
 * aggregated errors; anything else is JSON, or Node's own rendering when JSON
 * cannot represent it.
 */
export function formatLogMeta(meta: unknown): string {
  try {
    if (isError(meta)) return inspect(meta, { depth: 4 });
    const json = JSON.stringify(meta, (_key, value: unknown) =>
      isError(value) ? inspect(value, { depth: 4 }) : typeof value === 'bigint' ? `${value}n` : value);
    if (json !== undefined) return json;
  } catch {
    // A cycle, or a toJSON that throws: rendered below instead.
  }
  try {
    return inspect(meta, { depth: 4, breakLength: Infinity });
  } catch {
    return '[unprintable value]';
  }
}

/** Cuts a log text to LOG_ENTRY_MAX_LENGTH, saying how much was left out. */
export function truncateLogText(text: string): string {
  if (text.length <= LOG_ENTRY_MAX_LENGTH) return text;
  let end = LOG_ENTRY_MAX_LENGTH - TRUNCATION_NOTE_ROOM;
  // Never leave half of a surrogate pair at the cut.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)} … [${text.length - end} characters truncated]`;
}
