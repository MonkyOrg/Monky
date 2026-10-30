import http from 'http';
import { isIP } from 'net';

/**
 * HTTP plumbing of the marketplace listener started by `BotClient.serve()`.
 *
 * Only Monky servers talk to it: they fetch `/manifest` and post one small
 * registration to `/register`. Nothing here is meant for browsers, so there is
 * no CORS, and the limits below assume a single, small request per install.
 */

/** A registration is a token, a server name and two URLs: far below this. */
export const MAX_REGISTRATION_BYTES = 16 * 1024;
/** Each registration keeps an outgoing WebSocket open while it authenticates (up to 8 s). */
const MAX_CONCURRENT_REGISTRATIONS = 4;
const MAX_ATTEMPTS_PER_ADDRESS = 10;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 1024;

export const MARKETPLACE_SERVER_OPTIONS: http.ServerOptions = {
  headersTimeout: 10_000,
  requestTimeout: 10_000,
  // Node only enforces the two limits above on this cadence (30 s by default).
  connectionsCheckingInterval: 1_000,
};

/**
 * Public origin announced in the manifest, such as `https://bot.example.com`.
 * Only an origin: the server and `<bot> doctor` prove reachability at the
 * origin itself, so a path could never be verified.
 */
export function marketplaceBaseUrl(publicUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error('publicUrl must be an absolute http(s) URL, such as https://bot.example.com.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || publicUrl.includes('?') || publicUrl.includes('#')) {
    throw new Error('publicUrl must be an http(s) origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

/**
 * Browsers can only send `application/json` cross-origin after a CORS
 * preflight that this listener never approves, so requiring it keeps web pages
 * from registering a bot that listens on localhost or the LAN.
 */
export function isJsonContentType(header: string | undefined): boolean {
  return header?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

interface JsonReplyOptions {
  /** Ends the connection after the reply, so Node stops reading a body nobody will use. */
  close?: boolean;
  retryAfterSeconds?: number;
}

export function replyJson(
  res: http.ServerResponse, status: number, body: object, options: JsonReplyOptions = {},
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
  if (options.close) headers.Connection = 'close';
  if (options.retryAfterSeconds) headers['Retry-After'] = String(options.retryAfterSeconds);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export type RequestBody = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'aborted' };

/** Reads at most `limit` bytes and stops pulling from the socket as soon as the body is too large. */
export function readRequestBody(req: http.IncomingMessage, limit: number): Promise<RequestBody> {
  if (Number(req.headers['content-length']) > limit) return Promise.resolve({ ok: false, reason: 'too_large' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const settle = (result: RequestBody): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      req.pause();
      settle({ ok: false, reason: 'too_large' });
    };
    const onEnd = (): void => settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    const onAbort = (): void => settle({ ok: false, reason: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

/** IPv6 hosts usually own a whole /64, so the attempt budget applies to the /64. */
function attemptKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];
  if (isIP(address) !== 6) return address;
  const [head, tail] = address.toLowerCase().split('%')[0].split('::');
  // An embedded IPv4 sits in the last 32 bits; it only has to count as two groups.
  const groups = (part: string | undefined): string[] =>
    part ? part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : [];
  const left = groups(head);
  const right = groups(tail);
  const expanded = tail === undefined
    ? left
    : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${expanded.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Bounds what anonymous registrations can cost the bot: every Monky server may
 * install it, but no single address can fill the saved registrations or keep it
 * opening WebSockets, and only a few registrations authenticate at once.
 */
export class RegistrationLimiter {
  private active = 0;
  private readonly attempts = new Map<string, number[]>();

  /** Counts an attempt; false once the address used its budget for the last minute. */
  allowAttempt(address: string | undefined, now = Date.now()): boolean {
    const key = attemptKey(address);
    const recent = (this.attempts.get(key) ?? []).filter((time) => now - time < ATTEMPT_WINDOW_MS);
    const allowed = recent.length < MAX_ATTEMPTS_PER_ADDRESS;
    if (allowed) recent.push(now);
    // Re-inserting keeps the least recently seen address first, which is the one dropped.
    this.attempts.delete(key);
    this.attempts.set(key, recent);
    for (const stale of this.attempts.keys()) {
      if (this.attempts.size <= MAX_TRACKED_ADDRESSES) break;
      this.attempts.delete(stale);
    }
    return allowed;
  }

  /** Reserves one of the concurrent registration slots; the returned release is idempotent. */
  acquire(): (() => void) | undefined {
    if (this.active >= MAX_CONCURRENT_REGISTRATIONS) return undefined;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
