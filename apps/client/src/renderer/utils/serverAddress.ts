/** A server as saved by the user: the host keeps whatever spelling it was typed with. */
export interface ServerAddress {
  host: string;
  port: number;
  /**
   * Over TLS (`wss://`, `https://`), as behind a reverse proxy. Left out, the
   * address follows what this app knows about it, which is plain by default.
   */
  secure?: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** Addresses this app reaches over TLS. Kept by the saved servers and by whoever opens a new one. */
const secureAddresses = new Set<string>();

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

/**
 * Splits a typed address into host and transport: `wss://` or `https://` ask
 * for TLS, `ws://` or `http://` for plain, and no scheme leaves it undecided
 * (`secure: undefined`), which connects plain.
 */
export function parseServerHostInput(value: string): { host: string; secure?: boolean } {
  const trimmed = value.trim();
  const scheme = /^(wss|https|ws|http):\/\//i.exec(trimmed);
  if (!scheme) return { host: trimmed };
  return { host: trimmed.slice(scheme[0].length), secure: /^(wss|https)$/i.test(scheme[1]) };
}

/** Records how this app reaches a server; every URL derived from its address follows it. */
export function setServerTransport(server: ServerAddress, secure: boolean): void {
  if (secure) secureAddresses.add(serverAddressKey(server));
  else secureAddresses.delete(serverAddressKey(server));
}

export function isSecureServer(server: ServerAddress): boolean {
  return server.secure ?? secureAddresses.has(serverAddressKey(server));
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
  return `${isSecureServer(server) ? 'wss' : 'ws'}://${urlHost(server.host)}:${server.port}`;
}

/** Attachments, avatars and the preview come from the same address, over the same transport. */
export function toHttpBase(server: ServerAddress): string {
  return `${isSecureServer(server) ? 'https' : 'http'}://${urlHost(server.host)}:${server.port}`;
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
