import type { BotCompatibilitySummary } from './models.js';

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const RELEASE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_METADATA_BYTES = 16 * 1024;

export interface ReleaseCompatibility {
  schemaVersion: 1;
  version: string;
  protocolVersion: number;
  botSdkVersion: string;
}

export type ReleaseCompatibilityResult =
  | { status: 'available'; manifest: ReleaseCompatibility }
  | { status: 'unavailable'; reason: string };

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && RELEASE_VERSION.exec(value)?.[0] === value;
}

export function parseReleaseCompatibility(value: unknown, version: string): ReleaseCompatibility | null {
  if (!value || typeof value !== 'object' || !isReleaseVersion(version)) return null;
  if (!('schemaVersion' in value) || value.schemaVersion !== 1 ||
      !('version' in value) || value.version !== version ||
      !('protocolVersion' in value) || typeof value.protocolVersion !== 'number' ||
      !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion <= 0 ||
      !('botSdkVersion' in value) || value.botSdkVersion !== version) return null;
  return { schemaVersion: 1, version, protocolVersion: value.protocolVersion, botSdkVersion: version };
}

export function parseBotCompatibility(value: unknown): BotCompatibilitySummary | null {
  if (!value || typeof value !== 'object' ||
      !('protocolVersion' in value) || typeof value.protocolVersion !== 'number' ||
      !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion <= 0 ||
      !('incompatibleBots' in value) || typeof value.incompatibleBots !== 'number' ||
      !Number.isSafeInteger(value.incompatibleBots) || value.incompatibleBots < 0 ||
      !('uncheckedBots' in value) || typeof value.uncheckedBots !== 'number' ||
      !Number.isSafeInteger(value.uncheckedBots) || value.uncheckedBots < 0) return null;
  return {
    protocolVersion: value.protocolVersion,
    incompatibleBots: value.incompatibleBots,
    uncheckedBots: value.uncheckedBots,
  };
}

export async function fetchReleaseCompatibility(
  version: string,
  request: typeof fetch = globalThis.fetch,
): Promise<ReleaseCompatibilityResult> {
  if (!isReleaseVersion(version)) return { status: 'unavailable', reason: 'Invalid release version.' };
  const signal = AbortSignal.timeout(8000);
  let url = new URL(`https://github.com/MonkyOrg/Monky/releases/download/v${version}/monky-compatibility-${version}.json`);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !RELEASE_HOSTS.has(url.hostname)) {
        return { status: 'unavailable', reason: 'Untrusted compatibility metadata location.' };
      }
      const response = await request(url, { redirect: 'manual', signal, headers: { Accept: 'application/json' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) return { status: 'unavailable', reason: 'Compatibility metadata redirect has no location.' };
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return { status: 'unavailable', reason: `Compatibility metadata HTTP ${response.status}.` };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_METADATA_BYTES) {
            await reader.cancel();
            return { status: 'unavailable', reason: 'Compatibility metadata exceeds its size limit.' };
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const parsed: unknown = JSON.parse(text);
      const manifest = parseReleaseCompatibility(parsed, version);
      return manifest
        ? { status: 'available', manifest }
        : { status: 'unavailable', reason: 'Invalid compatibility metadata.' };
    }
    return { status: 'unavailable', reason: 'Too many compatibility metadata redirects.' };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof SyntaxError ? 'Invalid compatibility metadata JSON.'
        : signal.aborted ? 'Compatibility metadata request timed out.' : 'Compatibility metadata request failed.',
    };
  }
}
