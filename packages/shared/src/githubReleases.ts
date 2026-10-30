/**
 * Monky releases on GitHub: the hosts their files are downloaded from, bounded
 * reads, SHA-256 manifests and the order of release versions. Only web APIs are
 * used (fetch, streams, TextDecoder), so the app, the server CLI and the bot SDK
 * share one implementation; writing to disk and hashing stay at each Node edge.
 */

/**
 * Hosts GitHub serves Monky release files from, redirects included. When GitHub
 * moves its CDN again (as from `objects.` to `release-assets.`), this is the only
 * list to update.
 */
export const MONKY_RELEASE_HOSTS: ReadonlySet<string> = new Set([
  'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** https on the default port, without credentials or fragment, on one of `hosts`. */
export function isTrustedDownloadUrl(url: URL, hosts: ReadonlySet<string>): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    hosts.has(url.hostname);
}

export type TrustedFetchFailure = 'untrusted' | 'redirect-missing' | 'redirects' | 'http' | 'too-large';

/** Why a trusted download stopped; each caller turns it into its own error. */
export class TrustedFetchError extends Error {
  constructor(readonly failure: TrustedFetchFailure, readonly status?: number) {
    super(failure === 'http' ? `HTTP ${status}` : `Trusted download failed: ${failure}`);
    this.name = 'TrustedFetchError';
  }
}

export interface TrustedFetchOptions {
  hosts: ReadonlySet<string>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: 'GET' | 'HEAD';
  /** The global fetch by default; the app passes one that honours the system proxy. */
  request?: typeof fetch;
}

/**
 * Requests `url` following redirects by hand: every hop must pass
 * `isTrustedDownloadUrl` before anything is sent to it, at most five redirects
 * are followed, and only a 200 (with a body, unless it is a HEAD) is returned.
 */
export async function fetchTrusted(url: string | URL, options: TrustedFetchOptions): Promise<Response> {
  const request = options.request ?? globalThis.fetch;
  const method = options.method ?? 'GET';
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new TrustedFetchError('untrusted');
  }
  for (let redirects = 0; ; redirects++) {
    options.signal?.throwIfAborted();
    if (!isTrustedDownloadUrl(current, options.hosts)) throw new TrustedFetchError('untrusted');
    const response = await request(current, { method, redirect: 'manual', signal: options.signal, headers: options.headers });
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new TrustedFetchError('redirect-missing');
      if (redirects >= MAX_REDIRECTS) throw new TrustedFetchError('redirects');
      try {
        current = new URL(location, current);
      } catch {
        throw new TrustedFetchError('untrusted');
      }
      continue;
    }
    if (response.status !== 200 || (method === 'GET' && !response.body)) {
      await response.body?.cancel();
      throw new TrustedFetchError('http', response.status);
    }
    return response;
  }
}

/** The body as UTF-8 text; a body larger than `maxBytes` fails with `too-large`. */
export async function readLimitedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) throw new TrustedFetchError('too-large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases a body left unread by the limit or a cancellation.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Digest of `name` in a `sha256sum` manifest, or null unless exactly one line names it. */
export function parseSha256Manifest(manifest: string, name: string): string | null {
  const digests = manifest.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line);
    return match && (match[2] === name || match[2] === `./${name}`) ? [match[1].toLowerCase()] : [];
  });
  return digests.length === 1 ? digests[0] : null;
}

interface ParsedReleaseVersion {
  core: string[];
  prerelease: string[];
}

function parseReleaseVersion(version: string): ParsedReleaseVersion {
  const [withoutBuild] = String(version).trim().replace(/^v/i, '').split('+', 1);
  const dash = withoutBuild.indexOf('-');
  const core = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split('.')
    .map((part) => (/^\d+/.exec(part)?.[0] ?? '0').replace(/^0+(?=\d)/, ''));
  return { core, prerelease: dash === -1 ? [] : withoutBuild.slice(dash + 1).split('.') };
}

/** Digit strings of any length, by value. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a > b ? 1 : a < b ? -1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareDigits(a.replace(/^0+(?=\d)/, ''), b.replace(/^0+(?=\d)/, ''));
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a > b ? 1 : a < b ? -1 : 0;
}

/**
 * SemVer precedence between release versions, with or without the tag's `v`:
 * positive when `a` is newer, negative when it is older, 0 when they are the
 * same. A release outranks its own pre-releases, numeric identifiers compare by
 * value and below alphanumeric ones (`beta.10` > `beta.2`), and build metadata
 * is ignored.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  for (let index = 0; index < 3; index++) {
    const order = compareDigits(left.core[index] ?? '0', right.core[index] ?? '0');
    if (order) return order;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    if (index >= left.prerelease.length) return -1;
    if (index >= right.prerelease.length) return 1;
    const order = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (order) return order;
  }
  return 0;
}

/** Whether `version` is a pre-release, such as a beta. */
export function isPrereleaseVersion(version: string): boolean {
  return parseReleaseVersion(version).prerelease.length > 0;
}

/** A GitHub release, as far as choosing the newest one is concerned. */
export interface ReleaseTag {
  tag_name?: string | null;
  draft?: boolean | null;
}

/**
 * Newest release of a listing, by version and never by position: `/releases`
 * comes ordered by tag name, so `beta.9` arrived before `beta.15`. Drafts (only
 * maintainers see them, and they have no assets) and untagged entries are skipped.
 */
export function pickNewestRelease<T extends ReleaseTag>(releases: readonly (T | null | undefined)[]): T | null {
  let newest: { release: T; tag: string } | null = null;
  for (const release of releases) {
    const tag = release?.tag_name;
    if (!release || release.draft || typeof tag !== 'string' || !tag) continue;
    if (!newest || compareReleaseVersions(tag, newest.tag) > 0) newest = { release, tag };
  }
  return newest?.release ?? null;
}
