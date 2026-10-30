import type { BotCompatibilitySummary } from './models.js';
import { PROTOCOL_VERSION } from './constants.js';
import { MONKY_RELEASE_HOSTS, TrustedFetchError, fetchTrusted, readLimitedText } from './githubReleases.js';
import { MIN_BOT_PROTOCOL, MIN_CLIENT_PROTOCOL } from './protocolCompatibility.js';

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const MAX_METADATA_BYTES = 16 * 1024;

export interface ReleaseCompatibility {
  schemaVersion: 1;
  version: string;
  protocolVersion: number;
  botSdkVersion: string;
  minimumClientProtocol?: number;
  minimumBotProtocol?: number;
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
  const floors: Pick<ReleaseCompatibility, 'minimumClientProtocol' | 'minimumBotProtocol'> = {};
  for (const key of ['minimumClientProtocol', 'minimumBotProtocol'] as const) {
    if (!(key in value)) continue;
    const floor = key === 'minimumClientProtocol' && 'minimumClientProtocol' in value
      ? value.minimumClientProtocol : 'minimumBotProtocol' in value ? value.minimumBotProtocol : undefined;
    if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor < 1 || floor > value.protocolVersion) return null;
    floors[key] = floor;
  }
  return { schemaVersion: 1, version, protocolVersion: value.protocolVersion, botSdkVersion: version, ...floors };
}

export function releaseRequiresProtocolUpdate(manifest: ReleaseCompatibility, kind: 'client' | 'bot'): boolean {
  const floor = kind === 'bot' ? manifest.minimumBotProtocol : manifest.minimumClientProtocol;
  if (floor === undefined) return manifest.protocolVersion !== PROTOCOL_VERSION;
  const localFloor = kind === 'bot' ? MIN_BOT_PROTOCOL : MIN_CLIENT_PROTOCOL;
  return floor > PROTOCOL_VERSION || manifest.protocolVersion < localFloor;
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
  cancellation?: AbortSignal,
): Promise<ReleaseCompatibilityResult> {
  if (!isReleaseVersion(version)) return { status: 'unavailable', reason: 'Invalid release version.' };
  const timeout = AbortSignal.timeout(8000);
  const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
  const url = `https://github.com/MonkyOrg/Monky/releases/download/v${version}/monky-compatibility-${version}.json`;
  try {
    const response = await fetchTrusted(url, {
      hosts: MONKY_RELEASE_HOSTS, signal, request, headers: { Accept: 'application/json' },
    });
    const parsed: unknown = JSON.parse(await readLimitedText(response, MAX_METADATA_BYTES));
    const manifest = parseReleaseCompatibility(parsed, version);
    return manifest
      ? { status: 'available', manifest }
      : { status: 'unavailable', reason: 'Invalid compatibility metadata.' };
  } catch (error) {
    return { status: 'unavailable', reason: compatibilityFailure(error, timeout, cancellation) };
  }
}

function compatibilityFailure(error: unknown, timeout: AbortSignal, cancellation?: AbortSignal): string {
  if (error instanceof TrustedFetchError) {
    switch (error.failure) {
      case 'untrusted': return 'Untrusted compatibility metadata location.';
      case 'redirect-missing': return 'Compatibility metadata redirect has no location.';
      case 'redirects': return 'Too many compatibility metadata redirects.';
      case 'too-large': return 'Compatibility metadata exceeds its size limit.';
      case 'http': return `Compatibility metadata HTTP ${error.status}.`;
    }
  }
  return error instanceof SyntaxError ? 'Invalid compatibility metadata JSON.'
    : cancellation?.aborted ? 'Compatibility metadata request cancelled.'
      : timeout.aborted ? 'Compatibility metadata request timed out.' : 'Compatibility metadata request failed.';
}
