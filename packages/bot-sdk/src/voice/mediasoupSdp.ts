import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  botVoiceAnnouncedCandidateSchema, botVoiceIceCandidateSchema,
  type BotVoiceIceCandidate, type BotVoiceTransportOptions,
} from '@monky/shared';

/** Candidates kept per transport: ICE pairs every one, so more only slows the connection down. */
const MAX_CANDIDATES = 32;
/** Bounds on resolving the names a server announces, which it chooses freely. */
const MAX_RESOLVED_NAMES = 4;
const MAX_ADDRESSES_PER_NAME = 8;
const RESOLVE_TIMEOUT_MS = 5_000;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

/** A mediasoup transport as the bot dials it: only candidates on an IP address. */
export type SfuTransport = Omit<BotVoiceTransportOptions, 'iceCandidates'> & { iceCandidates: BotVoiceIceCandidate[] };
export type ResolveHost = (hostname: string) => Promise<string[]>;

const resolveHost: ResolveHost = async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Keeps the candidates of an SFU transport a bot can dial: host candidates on
 * an IP address, at most 32, most preferred first.
 *
 * The SFU announces the address each client reached it by — a domain for a bot
 * behind `wss://monky.example.com` — next to its public IP and every local
 * interface, which on a host with many networks passes 32. Names are resolved,
 * a bracketed IPv6 literal is unwrapped, and what cannot be used is dropped:
 * one such candidate used to fail the whole join. Fails only when none is left.
 */
export async function prepareSfuTransport(
  options: BotVoiceTransportOptions, resolve: ResolveHost = resolveHost,
): Promise<SfuTransport> {
  const announced = options.iceCandidates.flatMap((value) => {
    const parsed = botVoiceAnnouncedCandidateSchema.safeParse(value);
    if (!parsed.success || parsed.data.type !== 'host') return [];
    const { address, ...candidate } = parsed.data;
    return [{ ...candidate, ip: unbracket(address ?? candidate.ip) }];
  });
  const names = [...new Set(announced.map((candidate) => candidate.ip)
    .filter((host) => isIP(host) === 0 && HOSTNAME.test(host)))].slice(0, MAX_RESOLVED_NAMES);
  const resolved = new Map(await Promise.all(names.map(async (name) => [name, await resolveWithin(name, resolve)] as const)));

  const seen = new Set<string>();
  const candidates: BotVoiceIceCandidate[] = [];
  for (const candidate of announced.sort((a, b) => b.priority - a.priority)) {
    for (const ip of isIP(candidate.ip) !== 0 ? [candidate.ip] : resolved.get(candidate.ip) ?? []) {
      const usable = botVoiceIceCandidateSchema.safeParse({ ...candidate, ip });
      const key = `${candidate.protocol} ${ip} ${candidate.port}`;
      if (!usable.success || seen.has(key)) continue;
      seen.add(key);
      candidates.push(usable.data);
    }
  }
  if (candidates.length === 0) throw new Error('The SFU announced no address this bot can reach.');
  return { ...options, iceCandidates: candidates.slice(0, MAX_CANDIDATES) };
}

/** The ICE and DTLS lines of an m-section answering a mediasoup transport: ICE-lite, passive DTLS. */
export function sfuTransportLines(transport: SfuTransport): string[] {
  const fingerprint = transport.dtlsParameters.fingerprints.find((entry) => entry.algorithm === 'sha-256');
  if (!fingerprint) throw new Error('SFU is missing its SHA-256 certificate fingerprint.');
  return [
    `a=ice-ufrag:${transport.iceParameters.usernameFragment}`, `a=ice-pwd:${transport.iceParameters.password}`,
    `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`, 'a=setup:passive',
  ];
}

export function sfuCandidateLines(transport: SfuTransport): string[] {
  return [
    ...transport.iceCandidates.map((candidate) =>
      `a=candidate:${candidate.foundation} 1 ${candidate.protocol.toUpperCase()} ${candidate.priority} ${candidate.ip} ${candidate.port} typ host${candidate.tcpType ? ` tcptype ${candidate.tcpType}` : ''}`),
    'a=end-of-candidates',
  ];
}

function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

async function resolveWithin(name: string, resolve: ResolveHost): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolve(name),
      new Promise<string[]>((done) => { timer = setTimeout(() => done([]), RESOLVE_TIMEOUT_MS); }),
    ]);
    return addresses.slice(0, MAX_ADDRESSES_PER_NAME);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
