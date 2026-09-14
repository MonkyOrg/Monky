import { LIMITS, Permission, TurnAvailability } from '@monky/shared';
import { ANSI, color, ConfigKey, PERMISSION_OPTIONS } from './constants';
import { t } from './i18n/index';
import type { SfuPortProblem } from '../infrastructure/sfu/SfuManager';
import type { TurnPortProblem } from '../infrastructure/turn/CoturnManager';
import {
  SFU_MIN_NODE_MAJOR,
  SfuPreflightIssue,
  SfuPreflightResult,
} from '../infrastructure/sfu/SfuPreflight';

/**
 * Translated counterpart of the server-side `describeSfuPortProblem`.
 *
 * The manager reports a structured problem precisely so the operator reads it
 * in their own language instead of the Portuguese string the server sends to
 * the desktop client (#515).
 */
export function describeSfuPortProblem(problem: SfuPortProblem): string {
  if (problem.code === 'turn-overlap') {
    return t('sfu.portOverlap', {
      minPort: String(problem.minPort),
      maxPort: String(problem.maxPort),
      turnMinPort: String(problem.turnMinPort),
      turnMaxPort: String(problem.turnMaxPort),
    });
  }
  return t('sfu.portBindFailed', {
    port: String(problem.port),
    minPort: String(problem.minPort),
    maxPort: String(problem.maxPort),
  });
}

/**
 * Value of a `--flag value` pair.
 *
 * A value that looks like another flag is rejected instead of accepted, so
 * `monky start --port --name x` fails clearly rather than parsing `--name` as
 * the port.
 */
export function parseOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(t('validation.optionValue', { option: name }));
  }
  if (value.startsWith('--')) {
    throw new Error(t('validation.optionValueReceived', { option: name, value }));
  }
  return value;
}

export function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'sim', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
  throw new Error(t('validation.boolean', { value }));
}

export function parsePositiveInt(key: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(t('validation.positiveInt', { key, value }));
  }
  return parsed;
}

/**
 * Parses the membership cap, where 0 means "no limit" (#403).
 *
 * Kept apart from `parsePositiveInt` because 0 is a legitimate value here and
 * an error everywhere else.
 */
export function parseMemberLimit(key: string, value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === '0' || normalized === 'ilimitado' || normalized === 'unlimited') {
    return LIMITS.MAX_USERS_UNLIMITED;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(t('validation.memberLimit', { key, value }));
  }
  return parsed;
}

export function formatDate(timestamp?: number | null): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toISOString();
}

export function formatBool(value: boolean): string {
  return value ? color('true', ANSI.green) : color('false', ANSI.yellow);
}

export function pad(value: string, size: number): string {
  return value.length >= size ? value : value.padEnd(size, ' ');
}

export function permissionLabel(name: keyof typeof Permission): string {
  return t(`permission.${name}`);
}

/** Keep the old English labels valid in scripts, regardless of display locale. */
function legacyPermissionLabel(name: keyof typeof Permission): string {
  return name
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}

export function encodePermissions(names: string[]): number {
  let permissions = 0;
  for (const selected of names) {
    const option = PERMISSION_OPTIONS.find((entry) =>
      permissionLabel(entry.name) === selected || entry.name === selected || legacyPermissionLabel(entry.name) === selected
    );
    if (!option) throw new Error(t('validation.permission', { value: selected }));
    permissions |= option.value;
  }
  return permissions;
}

export function parsePermissionNames(input: string): string[] {
  if (!input.trim()) return [];
  const selected = new Set<string>();
  for (const token of input.split(',').map((item) => item.trim()).filter(Boolean)) {
    const byEnum = PERMISSION_OPTIONS.find((entry) => entry.name.toLowerCase() === token.toLowerCase());
    if (byEnum) {
      selected.add(byEnum.name);
      continue;
    }

    const byLabel = PERMISSION_OPTIONS.find((entry) =>
      permissionLabel(entry.name).toLowerCase() === token.toLowerCase() ||
      legacyPermissionLabel(entry.name).toLowerCase() === token.toLowerCase()
    );
    if (byLabel) {
      selected.add(byLabel.name);
      continue;
    }

    throw new Error(t('validation.permission', { value: token }));
  }
  return [...selected];
}

export function normalizeRoleColor(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
    throw new Error(t('validation.roleColor'));
  }
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

export function printVoiceModeComparisonTable(): void {
  const direct = t('voice.direct');
  const relayed = t('voice.viaServer');
  const stored = t('voice.stored');
  const rows = [
    { data: t('voice.audio'), p2p: direct, sfu: relayed },
    { data: t('voice.video'), p2p: direct, sfu: relayed },
    { data: t('voice.screen'), p2p: direct, sfu: relayed },
    { data: t('voice.chat'), p2p: relayed, sfu: relayed },
    { data: t('voice.files'), p2p: stored, sfu: stored },
    { data: t('voice.signaling'), p2p: relayed, sfu: relayed },
    { data: t('voice.profiles'), p2p: stored, sfu: stored },
    { data: t('voice.settings'), p2p: stored, sfu: stored },
    { data: t('voice.presence'), p2p: relayed, sfu: relayed },
  ];

  console.log();
  console.log(color('┌───────────────────────────────────────┬─────────────────────────┬─────────────────────────┐', ANSI.dim));
  console.log(color(`│ ${pad(t('voice.data'), 37)} │ ${pad('P2P Mesh', 23)} │ ${pad('SFU', 23)} │`, ANSI.bold));
  console.log(color('├───────────────────────────────────────┼─────────────────────────┼─────────────────────────┤', ANSI.dim));
  for (const r of rows) {
    const d = pad(r.data, 37);
    const p = pad(r.p2p, 23);
    const s = pad(r.sfu, 23);
    console.log(`│ ${d} │ ${p} │ ${s} │`);
  }
  console.log(color('└───────────────────────────────────────┴─────────────────────────┴─────────────────────────┘', ANSI.dim));
}

export function parseVoiceMode(value: string): 'p2p' | 'sfu' {
  const mode = value.trim().toLowerCase();
  if (mode === 'p2p' || mode === 'sfu') return mode;
  throw new Error(t('validation.voiceMode', { value }));
}

export function configKeyLabel(key: ConfigKey): string {
  return `${t(`label.${key}`)} (${key})`;
}

export function formatProcessStatus(status: string): string {
  switch (status) {
    case 'online': return t('status.online');
    case 'stopped': return t('status.stopped');
    case 'stopping': return t('status.stopping');
    case 'launching': return t('status.launching');
    case 'errored': return t('status.errored');
    case 'waiting restart': return t('status.waitingRestart');
    case 'one-launch-status': return t('status.oneLaunch');
    case 'not started': return t('status.notStarted');
    default: return status;
  }
}

export function describeTurnUnavailability(availability: TurnAvailability): string | null {
  if (availability.supported) return null;
  if (availability.reason === 'unsupported-platform') return t('config.turnLinuxOnly');
  if (availability.reason === 'not-installed') {
    return availability.autoInstallable ? t('config.coturnMissing') : t('config.coturnNoPrivileges');
  }
  return t('lifecycle.coturnUnavailable');
}

export function describeTurnPortProblem(problem: TurnPortProblem): string {
  switch (problem.code) {
    case 'not-listening': return t('turn.portNotListening', { port: problem.port });
    case 'external-unreachable': return t('turn.portExternalUnreachable', {
      port: problem.port, publicIp: problem.publicIp, minPort: problem.minPort, maxPort: problem.maxPort,
    });
    case 'relay-bind-failed': return t('turn.relayPortBindFailed', {
      port: problem.port, minPort: problem.minPort, maxPort: problem.maxPort,
    });
  }
}

/** Problem and matching fix for a preflight issue, in the CLI language. */
function describeSfuIssue(issue: SfuPreflightIssue): { problem: string; hint: string } {
  switch (issue.code) {
    case 'node-version':
      return {
        problem: t('sfu.preflightNodeVersion', {
          found: issue.found ?? '?',
          required: SFU_MIN_NODE_MAJOR,
        }),
        hint: t('sfu.preflightHintNode', { required: SFU_MIN_NODE_MAJOR }),
      };
    case 'worker-missing':
      return {
        problem: t('sfu.preflightWorkerMissing', { path: issue.workerPath ?? '?' }),
        hint: t('sfu.preflightHintWorker'),
      };
    case 'mediasoup-unresolved':
    default:
      return {
        problem: t('sfu.preflightMediasoupUnresolved'),
        hint: t('sfu.preflightHintReinstall'),
      };
  }
}

/**
 * Reports an environment that cannot run the SFU, at the moment the mode is
 * picked.
 *
 * `SfuManager` falls back to P2P rather than refusing to start, so without
 * this the operator only notices when calls quietly degrade.
 */
export function printSfuPreflight(result: SfuPreflightResult): void {
  if (result.ok) return;

  console.log();
  console.log(color(t('sfu.preflightTitle'), ANSI.bold));
  for (const issue of result.issues) {
    const { problem, hint } = describeSfuIssue(issue);
    console.log(color(`  ✖ ${problem}`, ANSI.red));
    console.log(color(`    → ${hint}`, ANSI.dim));
  }
  console.log(color(t('sfu.preflightConsequence'), ANSI.yellow));
}

/** One-line reason for listings, or an empty string when the SFU can run. */
export function sfuPreflightSummary(result: SfuPreflightResult): string {
  if (result.ok) return '';
  return result.issues.map((issue) => describeSfuIssue(issue).problem).join(' ');
}
