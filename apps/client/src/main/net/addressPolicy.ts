import { BlockList, isIP } from 'node:net';

/**
 * Which hosts a request made on someone else's behalf may reach. Link previews
 * and soundboard downloads fetch URLs that came from the chat, from anyone on
 * the server, in the main process: without an origin and without CORS. They
 * must never reach this machine or its local network (#372), and one list
 * serves both.
 */

const blocked = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(subnet, prefix, 'ipv6');

/**
 * A public unicast IP. Loopback, private, link-local, shared, documentation,
 * multicast and reserved ranges are not, and neither is any IPv6 outside the
 * global unicast block: a mapped, translated or tunnelled form could carry a
 * private IPv4.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || address.includes('%')) return false;
  if (family === 6 && !/^[23]/.test(address)) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Names that resolve to this machine or to the local network by convention. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return !host || host === 'localhost' || /\.(?:localhost|local|internal|home\.arpa)$/.test(host);
}

/**
 * Whether a URL host, an IP literal (bracketed or not) or a name, is refused
 * before any lookup. A public-looking name is checked again on the address it
 * resolves to.
 */
export function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return isIP(bare) ? !isPublicAddress(bare) : isLocalHostname(bare);
}
