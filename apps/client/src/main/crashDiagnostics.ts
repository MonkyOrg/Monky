import { randomUUID } from 'crypto';
import { release } from 'os';
import type { RendererBootstrapFailure } from '@monky/shared';
import { mt } from './i18n';

export type FatalFailureKind =
  | 'renderer-gone'
  | 'renderer-bootstrap'
  | 'bootstrap-timeout'
  | 'document-load'
  | 'preload'
  | 'main-bootstrap';

export interface FatalFailure {
  kind: FatalFailureKind;
  reason?: string;
  code?: number;
  error?: { name?: string; stack?: string };
}

export interface CrashDiagnostic {
  incident: string;
  occurredAt: string;
  kind: FatalFailureKind;
  appVersion: string;
  platform: string;
  architecture: string;
  osRelease: string;
  electron: string;
  chromium: string;
  uptimeSeconds: number;
  reason?: string;
  code?: number;
  errorName?: string;
  locations: string[];
}

const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'DOMException',
]);
const FAILURE_REASONS = new Set([
  'crashed', 'killed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure',
  'memory-eviction', 'constructor', 'initialization',
]);

export function parseBootstrapFailure(input: unknown): RendererBootstrapFailure | null {
  if (!input || typeof input !== 'object') return null;
  if (!('phase' in input) || (input.phase !== 'constructor' && input.phase !== 'initialization')) return null;
  if (!('errorName' in input) || typeof input.errorName !== 'string' || input.errorName.length > 100) return null;
  const stack = 'stack' in input ? input.stack : undefined;
  if ('stack' in input && (typeof stack !== 'string' || stack.length > 12000)) return null;
  return {
    phase: input.phase,
    errorName: ERROR_NAMES.has(input.errorName) ? input.errorName : 'Error',
    ...(typeof stack === 'string' ? { stack } : {}),
  };
}

/** Never retain exception messages, function names, URLs, queries or user paths. */
function appLocations(stack?: string): string[] {
  if (typeof stack !== 'string') return [];
  const locations: string[] = [];
  for (const line of stack.slice(0, 12000).split('\n').slice(1, 20)) {
    const match = /(?:[/\\](?:assets|renderer|main|preload)[/\\])([A-Za-z][A-Za-z0-9_.-]{0,80}\.(?:[cm]?js|ts))(?::(\d{1,7}):(\d{1,5}))\)?$/.exec(line.trim());
    if (match) locations.push(`${match[1]}:${match[2]}:${match[3]}`);
    if (locations.length === 4) break;
  }
  return [...new Set(locations)];
}

function version(value?: string): string {
  return typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,39}$/.test(value) ? value : 'unknown';
}

export function createCrashDiagnostic(failure: FatalFailure, appVersion: string): CrashDiagnostic {
  return {
    incident: randomUUID(),
    occurredAt: new Date().toISOString(),
    kind: failure.kind,
    appVersion: version(appVersion),
    platform: process.platform,
    architecture: process.arch,
    osRelease: version(release()),
    electron: version(process.versions.electron),
    chromium: version(process.versions.chrome),
    uptimeSeconds: Math.floor(process.uptime()),
    ...(failure.reason && FAILURE_REASONS.has(failure.reason) ? { reason: failure.reason } : {}),
    ...(Number.isSafeInteger(failure.code) ? { code: failure.code } : {}),
    ...(failure.error ? { errorName: ERROR_NAMES.has(failure.error.name ?? '') ? failure.error.name : 'Error' } : {}),
    locations: appLocations(failure.error?.stack),
  };
}

export function formatCrashDiagnostic(diagnostic: CrashDiagnostic): string {
  return [
    `${mt('crash.fieldIncident')}: ${diagnostic.incident}`,
    `${mt('crash.fieldTime')}: ${diagnostic.occurredAt}`,
    `Monky: ${diagnostic.appVersion}`,
    `${mt('crash.fieldFailure')}: ${diagnostic.kind}${diagnostic.reason ? ` / ${diagnostic.reason}` : ''}`,
    ...(diagnostic.code !== undefined ? [`${mt('crash.fieldCode')}: ${diagnostic.code}`] : []),
    `${mt('crash.fieldOs')}: ${diagnostic.platform} ${diagnostic.osRelease} (${diagnostic.architecture})`,
    `Electron: ${diagnostic.electron} / Chromium: ${diagnostic.chromium}`,
    `${mt('crash.fieldUptime')}: ${diagnostic.uptimeSeconds}s`,
    ...(diagnostic.errorName ? [`${mt('crash.fieldError')}: ${diagnostic.errorName}`] : []),
    ...diagnostic.locations.map(location => `${mt('crash.fieldSource')}: ${location}`),
  ].join('\n');
}
