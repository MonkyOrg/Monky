/** A server as saved by the user: the host keeps whatever spelling it was typed with. */
export interface ServerAddress {
  host: string;
  port: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** `WS://[::1] ` and `::1` are the same host: no scheme, IPv6 brackets, spaces or capitals. */
export function normalizeHost(host: string): string {
  return host.trim().replace(/^wss?:\/\//i, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
}

/**
 * Identity of a server, however its address was typed. Favorites and automatic
 * entry persist it, so its format must never change.
 */
export function serverAddressKey(server: ServerAddress): string {
  return JSON.stringify([normalizeHost(server.host), server.port]);
}

export function sameServerAddress(a: ServerAddress, b: ServerAddress): boolean {
  return a.port === b.port && normalizeHost(a.host) === normalizeHost(b.host);
}

/** This machine, where the servers created in the app run. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

/**
 * Host as written in a URL: IPv6 between brackets. The case is kept, because
 * URLs already persisted (server icons) were built with it.
 */
function urlHost(host: string): string {
  const bare = host.trim().replace(/^(?:wss?|https?):\/\//i, '').replace(/^\[(.+)\]$/, '$1');
  return bare.includes(':') ? `[${bare}]` : bare;
}

export function toWsUrl(server: ServerAddress): string {
  return `ws://${urlHost(server.host)}:${server.port}`;
}

export function toHttpBase(server: ServerAddress): string {
  return `http://${urlHost(server.host)}:${server.port}`;
}

/** Host and port of a server URL; a regex on `//host:port` cannot read IPv6. */
export function parseServerUrl(url: string): ServerAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
  const port = Number(parsed.port || (secure ? 443 : 80));
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: parsed.hostname, port };
}
