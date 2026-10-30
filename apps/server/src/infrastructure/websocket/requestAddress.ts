import type http from 'http';
import { TLSSocket } from 'node:tls';

/**
 * Extracts the hostname from a `Host` header, dropping the port (#425).
 *
 * The port has to go because the TURN listener is on 3478, not on whatever
 * port the client used to reach the API. IPv6 literals arrive bracketed
 * (`[::1]:3000`) and the brackets are kept, since ICE URLs need them too.
 */
export function requestHostname(header: string | undefined): string | undefined {
  const raw = (header || '').trim();
  if (!raw) return undefined;

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(0, end + 1) : undefined;
  }

  const host = raw.split(':')[0].trim();
  return host.length > 0 ? host : undefined;
}

/**
 * The endpoint a connection reached the server at, a proxy's scheme, port and
 * path included. Undefined when any part of the request makes it ambiguous.
 */
export function requestServerUrl(req: http.IncomingMessage): string | undefined {
  if (!req.headers.host) return undefined;
  try {
    const forwarded = req.headers['x-forwarded-proto'];
    if (forwarded !== undefined && typeof forwarded !== 'string') return undefined;
    const protocol = typeof forwarded === 'string' ? forwarded.split(',')[0].trim().toLowerCase() : undefined;
    if (protocol !== undefined && protocol !== 'http' && protocol !== 'https') return undefined;
    const secure = (req.socket instanceof TLSSocket && req.socket.encrypted) || protocol === 'https';
    const url = new URL(`${secure ? 'wss' : 'ws'}://${req.headers.host}`);
    const target = req.url || '/';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !target.startsWith('/') || target.startsWith('//') || target.includes('#')) return undefined;
    const endpoint = new URL(target, url);
    return endpoint.origin === url.origin && !endpoint.hash ? endpoint.href : undefined;
  } catch {
    return undefined;
  }
}
