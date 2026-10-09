import { createPublicKey, randomBytes, verify } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import {
  BOT_REACHABILITY_MAX_RESPONSE_BYTES,
  BOT_REACHABILITY_PATH,
  botReachabilityChallenge,
  botReachabilityProofSchema,
  normalizeBotReachabilityOrigin,
} from '@monky/shared';

export type ReachabilityProbeOutcome =
  | { status: 'verified' }
  | { status: 'unverified' }
  | { status: 'skipped'; reason: 'address_not_allowed' | 'port_not_allowed' };

export interface ReachabilityProbeOptions {
  /** Address the request came from; the bot may always test its own address. */
  requesterIp: string;
  publicKeyHex: string;
  timeoutMs?: number;
  lookup?: (hostname: string) => Promise<string[]>;
}

const MAX_ADDRESSES = 2;
const DEFAULT_TIMEOUT_MS = 4_000;

// Never dial the server's own network, documentation, multicast or reserved space.
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

/** Folds IPv4-mapped IPv6 (`::ffff:a.b.c.d`) into IPv4 so both spellings follow the same rule. */
export function normalizeIpAddress(address: string): string {
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(unwrapped);
  return (mapped ? mapped[1] : unwrapped).toLowerCase();
}

export function isPublicUnicastAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  const family = isIP(normalized);
  if (family === 4) return !NON_PUBLIC.check(normalized, 'ipv4');
  if (family === 6) return GLOBAL_UNICAST_V6.check(normalized, 'ipv6') && !NON_PUBLIC.check(normalized, 'ipv6');
  return false;
}

/** Bots may use 80/443 (reverse proxies) and unprivileged ports; system service ports are never probed. */
export function isProbePortAllowed(port: number): boolean {
  return port === 80 || port === 443 || (port >= 1024 && port <= 65535);
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function verifyProof(nonce: string, signature: string, publicKeyHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' &&
      verify(null, Buffer.from(botReachabilityChallenge(nonce), 'utf8'), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** One GET to a pinned address; any failure, redirect or wrong proof is simply "not verified". */
function attempt(url: URL, address: string, publicKeyHex: string, timeoutMs: number): Promise<boolean> {
  const nonce = randomBytes(32).toString('hex');
  const secure = url.protocol === 'https:';
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return new Promise((resolve) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const finish = (verified: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(verified);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      request = (secure ? https : http).request({
        host: address,
        port: Number(url.port || (secure ? 443 : 80)),
        path: `${BOT_REACHABILITY_PATH}?nonce=${nonce}`,
        method: 'GET',
        agent: false,
        headers: { Host: url.host, Accept: 'application/json', 'User-Agent': 'Monky-Reachability/1' },
        maxHeaderSize: 8 * 1024,
        ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
      }, (response) => {
        const length = Number(response.headers['content-length']);
        if (response.statusCode !== 200 || length > BOT_REACHABILITY_MAX_RESPONSE_BYTES) {
          finish(false);
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > BOT_REACHABILITY_MAX_RESPONSE_BYTES) finish(false);
          else chunks.push(chunk);
        });
        response.on('error', () => finish(false));
        response.on('end', () => {
          try {
            const proof = botReachabilityProofSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            finish(proof.success && verifyProof(nonce, proof.data.signature, publicKeyHex));
          } catch {
            finish(false);
          }
        });
      });
      request.on('error', () => finish(false));
      request.end();
    } catch {
      finish(false);
    }
  });
}

/**
 * Probes a bot-declared public origin. Only a fresh Ed25519 proof from the
 * bot's own key counts: closed, filtered and foreign services all look alike,
 * so the result says nothing about third-party hosts.
 */
export async function probeBotReachability(origin: string, options: ReachabilityProbeOptions): Promise<ReachabilityProbeOutcome> {
  const normalized = normalizeBotReachabilityOrigin(origin);
  if (!normalized) return { status: 'skipped', reason: 'address_not_allowed' };
  const url = new URL(normalized);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!isProbePortAllowed(port)) return { status: 'skipped', reason: 'port_not_allowed' };
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : (await (options.lookup ?? resolveAddresses)(hostname)).slice(0, 4);
  } catch {
    return { status: 'unverified' };
  }
  const requester = normalizeIpAddress(options.requesterIp);
  const allowed = addresses
    .filter((address) => isPublicUnicastAddress(address) || normalizeIpAddress(address) === requester)
    .slice(0, MAX_ADDRESSES);
  if (!allowed.length) return { status: 'skipped', reason: 'address_not_allowed' };
  for (const address of allowed) {
    if (await attempt(url, address, options.publicKeyHex, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)) return { status: 'verified' };
  }
  return { status: 'unverified' };
}
