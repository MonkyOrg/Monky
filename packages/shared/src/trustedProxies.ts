/**
 * Trusted reverse proxies (#829).
 *
 * Behind a reverse proxy, a tunnel or a container network every client reaches
 * the server from the proxy's address, so any limit keyed by address is shared
 * by everyone. The client's own address travels in `X-Forwarded-For` or
 * `Forwarded`, but anyone can send those headers: they are read only when the
 * socket comes from an address the operator listed as a proxy of theirs. The
 * list is empty by default, and then the headers are ignored.
 *
 * Shared so the CLI, the app and the server accept the very same list. Pure, no
 * Node APIs: the app validates it in the renderer.
 */

/** Most entries one list may hold. */
export const MAX_TRUSTED_PROXIES = 32;

export type TrustedProxyProblem =
  /** Neither an IP address nor an address/prefix. */
  | { code: 'invalid'; entry: string }
  /** A `/0` would trust every address on the internet, which turns the headers back into whatever a client says. */
  | { code: 'everyone'; entry: string }
  | { code: 'too-many'; max: number };

export type TrustedProxyList =
  | { ok: true; entries: string[] }
  | { ok: false; problem: TrustedProxyProblem };

interface IpAddress {
  /** 16 bytes; IPv4 is kept as IPv4-mapped IPv6, so `1.2.3.4` and `::ffff:1.2.3.4` are one address. */
  bytes: Uint8Array;
  v4: boolean;
}

interface Network {
  bytes: Uint8Array;
  /** Bits compared, out of 128. */
  bits: number;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // Leading zeros read as octal in some parsers: refused rather than guessed.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | null {
  if (!/^[0-9a-f:.]+$/i.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (half: string): number[] | null => {
    if (half === '') return [];
    const words: number[] = [];
    const parts = half.split(':');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1 && part.includes('.')) {
        const v4 = parseIpv4(part);
        if (!v4) return null;
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        words.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return words;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  // A dotted IPv4 tail may only end the address.
  if (!head || !tail || (halves.length === 2 && halves[0].includes('.'))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...new Array<number>(halves.length === 1 ? 0 : missing).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  words.forEach((word, i) => {
    bytes[i * 2] = word >> 8;
    bytes[i * 2 + 1] = word & 0xff;
  });
  return bytes;
}

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

function isV4Mapped(bytes: Uint8Array): boolean {
  return V4_MAPPED_PREFIX.every((value, i) => bytes[i] === value);
}

function parseIp(text: string): IpAddress | null {
  const v4 = parseIpv4(text);
  if (v4) return { bytes: new Uint8Array([...V4_MAPPED_PREFIX, ...v4]), v4: true };
  const v6 = parseIpv6(text);
  return v6 ? { bytes: v6, v4: isV4Mapped(v6) } : null;
}

function formatIp({ bytes, v4 }: IpAddress): string {
  if (v4) return Array.from(bytes.subarray(12)).join('.');
  const words = Array.from({ length: 8 }, (_, i) => (bytes[i * 2] << 8) | bytes[i * 2 + 1]);
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) { i++; continue; }
    let end = i;
    while (end < 8 && words[end] === 0) end++;
    if (end - i > bestLength) { bestStart = i; bestLength = end - i; }
    i = end;
  }
  const hex = words.map(word => word.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/** The address in one canonical spelling (IPv4-mapped IPv6 folded into IPv4), or null when it is not one. */
export function canonicalIpAddress(text: string): string | null {
  const address = parseIp(text.trim());
  return address ? formatIp(address) : null;
}

function parseEntry(text: string): { canonical: string; network: Network } | 'invalid' | 'everyone' {
  const [addressText, prefixText, extra] = text.split('/');
  if (extra !== undefined) return 'invalid';
  const address = parseIp(addressText);
  if (!address) return 'invalid';
  const width = address.v4 ? 32 : 128;
  let prefix = width;
  if (prefixText !== undefined) {
    if (!/^(0|[1-9]\d{0,2})$/.test(prefixText)) return 'invalid';
    prefix = Number(prefixText);
    if (prefix > width) return 'invalid';
  }
  if (prefix === 0) return 'everyone';
  const canonical = prefix === width ? formatIp(address) : `${formatIp(address)}/${prefix}`;
  return { canonical, network: { bytes: address.bytes, bits: prefix + (128 - width) } };
}

/**
 * Reads a list typed by the operator: addresses or networks (`10.0.0.0/8`,
 * `fd00::/8`) separated by commas, spaces or lines. Returns them in one
 * spelling each, without repeats, or the first one that cannot be trusted.
 * An empty list is valid and means "no proxy".
 */
export function parseTrustedProxies(input: string | readonly string[]): TrustedProxyList {
  const texts = (typeof input === 'string' ? [input] : input)
    .flatMap(item => item.split(/[\s,;]+/))
    .filter(Boolean);
  const entries: string[] = [];
  for (const text of texts) {
    const entry = parseEntry(text);
    if (entry === 'invalid' || entry === 'everyone') return { ok: false, problem: { code: entry, entry: text } };
    if (!entries.includes(entry.canonical)) entries.push(entry.canonical);
  }
  if (entries.length > MAX_TRUSTED_PROXIES) return { ok: false, problem: { code: 'too-many', max: MAX_TRUSTED_PROXIES } };
  return { ok: true, entries };
}

function inNetwork(address: IpAddress, network: Network): boolean {
  const full = Math.floor(network.bits / 8);
  for (let i = 0; i < full; i++) if (address.bytes[i] !== network.bytes[i]) return false;
  const rest = network.bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (address.bytes[full] & mask) === (network.bytes[full] & mask);
}

/** Answers whether an address belongs to one of the trusted proxies. Entries that do not parse are ignored. */
export function createTrustedProxyMatcher(entries: readonly string[]): (address: string) => boolean {
  const networks = entries.flatMap((text) => {
    const entry = parseEntry(text.trim());
    return typeof entry === 'string' ? [] : [entry.network];
  });
  if (networks.length === 0) return () => false;
  return (text) => {
    const address = parseIp(text.trim());
    return address !== null && networks.some(network => inNetwork(address, network));
  };
}

/** One hop of a forwarding header: `1.2.3.4`, `1.2.3.4:5678`, `2001:db8::1` or `[2001:db8::1]:5678`. */
function parseHop(raw: string): IpAddress | null {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) text = text.slice(1, -1).trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) return parseIp(bracketed[1]);
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
  return parseIp(withPort ? withPort[1] : text);
}

/** The `for=` of each element of a `Forwarded` header (RFC 7239), oldest first. */
function forwardedHops(header: string): (IpAddress | null)[] {
  return header.split(',').map((element) => {
    for (const pair of element.split(';')) {
      const separator = pair.indexOf('=');
      if (separator > 0 && pair.slice(0, separator).trim().toLowerCase() === 'for') return parseHop(pair.slice(separator + 1));
    }
    return null;
  });
}

export interface ForwardingHeaders {
  /** `X-Forwarded-For`, every occurrence joined by commas. */
  forwardedFor?: string;
  /** `Forwarded`, every occurrence joined by commas. */
  forwarded?: string;
}

/**
 * The address a connection stands for.
 *
 * The socket address, unless it is a trusted proxy. Then the forwarding header
 * is walked from the newest hop back, skipping the hops that are trusted
 * proxies too, and the first one that is not is the client: everything to its
 * left was written by the client itself and proves nothing.
 *
 * `X-Forwarded-For` is read when present, `Forwarded` only without it. Almost
 * every proxy (nginx, Caddy, Traefik, cloudflared) writes the former and passes
 * a `Forwarded` sent by the client through untouched, so preferring it would
 * let any client choose its own address.
 *
 * A hop that is not an address (`unknown`, an obfuscated name, garbage) stops
 * the walk at the last trusted proxy: its clients share one address, as they
 * did before any proxy was configured, instead of choosing one.
 */
export function resolveClientAddress(
  socketAddress: string,
  headers: ForwardingHeaders,
  isTrustedProxy: (address: string) => boolean,
): string {
  const socket = parseIp(socketAddress.trim());
  if (!socket) return socketAddress;
  let current = formatIp(socket);
  if (!isTrustedProxy(current)) return current;
  const hops = headers.forwardedFor !== undefined
    ? headers.forwardedFor.split(',').map(parseHop)
    : headers.forwarded !== undefined ? forwardedHops(headers.forwarded) : [];
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (!hop) return current;
    current = formatIp(hop);
    if (!isTrustedProxy(current)) return current;
  }
  return current;
}
