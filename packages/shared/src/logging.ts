/**
 * Shapes for server logs that are consumed outside the server process.
 *
 * The server writes to the console, but the desktop app hosting a server and
 * the CLI both need the same entries in a structured form, so the vocabulary
 * lives here instead of being redeclared by each consumer.
 */
export type LogCategory =
  | 'INFO'
  | 'WARN'
  | 'ERROR'
  | 'SECURITY'
  | 'NETWORK'
  | 'DATABASE'
  | 'WEBRTC'
  | 'SFU'
  | 'SOUNDBOARD'
  | 'ATTACHMENT'
  | 'BOT';

/** Categories used by the desktop client's logging system (#444). */
export type ClientLogCategory =
  | 'APP'
  | 'IPC'
  | 'NETWORK'
  | 'WEBRTC'
  | 'SFU'
  | 'AUDIO'
  | 'VIDEO'
  | 'UI'
  | 'STORE'
  | 'CONNECTION'
  | 'IDENTITY'
  | 'UPDATE'
  | 'SERVER_HOST'
  | 'SCREEN_SHARE'
  | 'SOUNDBOARD'
  | 'MEDIA'
  | 'DM';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  /** ISO-8601, assigned when the entry is recorded. */
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
}

/** Entry produced by the client logging system (#444). */
export interface ClientLogEntry {
  timestamp: string;
  level: LogLevel;
  category: ClientLogCategory;
  message: string;
  /** Optional structured metadata (stack traces, IDs, etc.). */
  data?: Record<string, unknown>;
}

/** Persisted client log settings (#444). */
export interface ClientLogConfig {
  /** Whether logging is enabled. */
  enabled: boolean;
  /** Maximum total log size in bytes before rotation. Default 50 MB. */
  maxSizeBytes: number;
}

export const CLIENT_LOG_DEFAULTS: ClientLogConfig = {
  enabled: true,
  maxSizeBytes: 50 * 1024 * 1024, // 50 MB
};

export const LOG_LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR'];

/** The client logs gathered into one text file, ready to attach to a message. */
export type ClientLogBundle =
  | { success: true; fileName: string; content: string; truncated: boolean }
  | { success: false; error: 'no-logs' | 'failed' };

/** Name of the file the client logs are exported to, on disk or in a channel. */
export function clientLogExportName(now: Date = new Date()): string {
  return `monky-logs-${now.toISOString().slice(0, 10)}.txt`;
}

const NEWLINE = 0x0a;

/**
 * The newest `maxBytes` of UTF-8 log text, starting at a whole line: the oldest
 * entries go first, and a cut never leaves half an entry or half a character.
 */
export function newestLogBytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.length <= maxBytes) return bytes;
  if (maxBytes <= 0) return bytes.subarray(bytes.length);
  const tail = bytes.subarray(bytes.length - maxBytes);
  // The byte just before the tail ending a line means the tail already starts on one.
  if (bytes[bytes.length - maxBytes - 1] === NEWLINE) return tail;
  const lineEnd = tail.indexOf(NEWLINE);
  return lineEnd < 0 ? tail.subarray(tail.length) : tail.subarray(lineEnd + 1);
}
