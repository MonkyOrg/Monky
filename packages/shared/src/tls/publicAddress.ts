import { BlockList, isIP } from 'node:net';

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

function normalize(address: string): string {
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(unwrapped);
  return (mapped ? mapped[1] : unwrapped).toLowerCase();
}

/** An address a certificate authority can reach from the internet. */
export function isPublicUnicastAddress(address: string): boolean {
  const normalized = normalize(address);
  const family = isIP(normalized);
  if (family === 4) return !NON_PUBLIC.check(normalized, 'ipv4');
  if (family === 6) return GLOBAL_UNICAST_V6.check(normalized, 'ipv6') && !NON_PUBLIC.check(normalized, 'ipv6');
  return false;
}

const PUBLIC_IP_PROVIDERS = [
  'https://api.ipify.org?format=json',
  'https://api4.my-ip.io/v2/ip.json',
];

/** The machine's public address as seen from the internet, or null when no provider answers. */
export async function discoverPublicIp(): Promise<string | null> {
  for (const url of PUBLIC_IP_PROVIDERS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (!response.ok) continue;
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') continue;
      const ip = 'ip' in data && data.ip ? data.ip : 'ipAddress' in data ? data.ipAddress : undefined;
      if (typeof ip === 'string' && isIP(ip)) return ip;
    } catch {
      // Try the next provider.
    }
  }
  return null;
}
