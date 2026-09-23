import net from 'net';
import path from 'path';
import { LIMITS } from '@monky/shared';
import { t } from './i18n/index';
import type { Pm2Process } from './pm2';

/**
 * What a TCP connect to the port told us.
 *
 * `closed` means the kernel actively refused the connection (ECONNREFUSED):
 * nothing is listening. `unreachable` covers timeouts and everything else,
 * which usually points at a firewall rather than a missing process. The
 * distinction matters because it separates "the server never started" from
 * "the server is up but something is in the way".
 */
export type PortState = 'listening' | 'closed' | 'unreachable';

/**
 * Checks whether anything accepts TCP on the port, over loopback.
 *
 * Loopback on purpose: this answers "did the server actually bind?", not "can
 * the internet reach it". A firewall must not make a healthy server look dead.
 */
export function probeLocalPort(port: number, timeoutMs = 1000): Promise<PortState> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (state: PortState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('listening'));
    socket.once('timeout', () => finish('unreachable'));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'closed' : 'unreachable')
    );
    socket.connect(port, '127.0.0.1');
  });
}

/** Major version number of a `x.y.z` string, or null when unparseable. */
export function majorOf(version: string | undefined | null): number | null {
  const match = /^v?(\d+)\./.exec(String(version ?? '').trim());
  return match ? Number(match[1]) : null;
}

export interface HealthProblem {
  message: string;
  hint?: string;
}

export interface HealthInput {
  entry: Pm2Process | null;
  portState: PortState;
  /** Node version the CLI itself is running under. */
  cliNodeVersion: string;
  /** Executable selected by the CLI, not PM2's cached registration. */
  expectedScript?: string;
  /** Injectable for tests; defaults to now. */
  now?: number;
}

/**
 * How long after a spawn the port is allowed to still be closed.
 *
 * `MonkyServer.create()` runs migrations and autodetects the public IP — a
 * network round trip — before `listen()`, and PM2 reports `online` from the
 * moment it spawns the process. Without this window a `monky status` right
 * after `monky start` would report a healthy server as broken.
 */
export const STARTUP_GRACE_MS = 15_000;

function hasScriptMismatch(entry: Pm2Process | null, expectedScript?: string): boolean {
  const script = entry?.pm2_env?.pm_exec_path;
  if (!expectedScript || typeof script !== 'string' || !script) return false;
  const actual = path.resolve(script);
  const expected = path.resolve(expectedScript);
  return process.platform === 'win32'
    ? actual.toLowerCase() !== expected.toLowerCase()
    : actual !== expected;
}

/**
 * Turns the raw facts about a server into the problems worth reporting.
 *
 * Kept pure and separate from the probing so the rules can be tested without a
 * live PM2 or an open port.
 *
 * The ordering is deliberate: the Node mismatch is reported before the closed
 * port, because when both are present the mismatch is the cause and the port is
 * the symptom.
 */
export function evaluateServerHealth(input: HealthInput): HealthProblem[] {
  const { entry, portState, cliNodeVersion } = input;
  if (!entry) return [];

  const status = entry.pm2_env?.status;
  // A server the operator stopped is not unhealthy, and `status` already says
  // so. Only a process PM2 believes is running can be *wrong* about it.
  if (status !== 'online') return [];

  const problems: HealthProblem[] = [];

  const script = entry.pm2_env?.pm_exec_path;
  if (script && input.expectedScript && hasScriptMismatch(entry, input.expectedScript)) {
    problems.push({
      message: t('health.scriptMismatch', { script, expected: input.expectedScript }),
      hint: t('health.scriptMismatchHint'),
    });
  }

  const processNodeVersion = entry.pm2_env?.node_version;
  const processMajor = majorOf(processNodeVersion);
  const cliMajor = majorOf(cliNodeVersion);

  if (processMajor !== null && processMajor < LIMITS.MIN_NODE_MAJOR) {
    problems.push({
      message: t('health.nodeTooOld', {
        processVersion: String(processNodeVersion),
        minimum: LIMITS.MIN_NODE_MAJOR,
      }),
      hint: t('health.nodeTooOldHint'),
    });
  } else if (
    processNodeVersion &&
    cliMajor !== null &&
    processMajor !== null &&
    processMajor !== cliMajor
  ) {
    problems.push({
      message: t('health.nodeMismatch', {
        processVersion: String(processNodeVersion),
        cliVersion: cliNodeVersion,
      }),
      hint: t('health.nodeMismatchHint'),
    });
  }

  // PM2 reports the state it intends to keep, not one it verified. With no pid
  // it never managed to spawn the process — usually because the interpreter it
  // resolves is gone after a Node upgrade (#522). This one is reported no
  // matter how recent the spawn was: a missing pid is never a startup delay.
  if (!entry.pid) {
    problems.push({
      message: t('health.noPid'),
      hint: t('health.noPidHint'),
    });
    return problems;
  }

  const uptime = entry.pm2_env?.pm_uptime;
  const stillStarting =
    typeof uptime === 'number' && (input.now ?? Date.now()) - uptime < STARTUP_GRACE_MS;

  if (portState !== 'listening' && !stillStarting) {
    problems.push({
      message: portState === 'closed' ? t('health.portClosed') : t('health.portUnreachable'),
      hint: t('health.portClosedHint'),
    });
  }

  return problems;
}

/**
 * Probes a server and reports what is wrong with it, if anything.
 *
 * `monky status` used to print PM2's own view and nothing else, so a daemon
 * that could not start the process still showed `online` while the port was
 * closed — the status contradicted the client without explaining why (#522).
 */
export async function diagnoseServerHealth(
  entry: Pm2Process | null,
  port: number,
  expectedScript?: string
): Promise<HealthProblem[]> {
  if (!entry || entry.pm2_env?.status !== 'online') return [];
  const portState = await probeLocalPort(port);
  return evaluateServerHealth({ entry, portState, cliNodeVersion: process.versions.node, expectedScript });
}

/**
 * Absolute path of the Node to pin in the ecosystem, or `null` when the Node
 * running this CLI must not be imposed on the server.
 *
 * Pinning is what keeps PM2 from resolving a bare `node` out of its own stale
 * environment (#522), but it cuts both ways: whatever runs the CLI decides what
 * the server runs. The auto-updater is registered with PM2 once and keeps that
 * Node for as long as it lives, so a nightly unattended update could otherwise
 * pin the server to an older Node than it already had. Below the floor,
 * mediasoup does not load at all, which would turn a routine 4am update into an
 * outage. Refusing to pin leaves PM2 resolving the interpreter as before —
 * never worse than the old behaviour.
 *
 * Windows is left unpinned for a different reason: PM2 only wraps a forked
 * process in `ProcessContainerFork.js` when the interpreter matches `/node$/`,
 * and `process.execPath` there ends in `node.exe`. Pinning would drop the
 * wrapper, and with it the IPC that reports `node_version` back — the very
 * field the Node diagnostics read. The bug being fixed is a Linux daemon
 * problem anyway, so the trade is not worth blinding `monky status`.
 */
export function resolveInterpreter(): string | null {
  if (process.platform === 'win32') return null;
  const major = majorOf(process.versions.node);
  if (major !== null && major < LIMITS.MIN_NODE_MAJOR) return null;
  return process.execPath;
}

/**
 * Whether PM2's registration for a process is broken in a way that restarting
 * cannot fix, so it has to be deleted and recreated.
 *
 * An online process without a pid never spawned (#522). A differing script
 * also needs recreation: startOrRestart updates `script` in current_conf but
 * keeps executing the old pm_exec_path when an installation moves.
 *
 * A differing `exec_interpreter` deliberately does *not* qualify. It is
 * tempting, since `pm2 update` restores the old value from its dump — which is
 * why that command did not help the original report — but `pm2 startOrRestart`
 * with an ecosystem file does re-apply it: PM2 aliases `interpreter` to
 * `exec_interpreter` when validating the config and merges it into the live
 * `pm2_env` on restart. Recreating on a mismatch would therefore fire on every
 * pre-fix installation, trading a restart PM2 handles for a delete that drops
 * the process from the list entirely if the following start fails — taking
 * `monky logs` with it.
 */
export function needsProcessRecreate(entry: Pm2Process | null, expectedScript?: string): boolean {
  if (!entry) return false;

  // PM2 claims the process is running but never got a pid for it, so the spawn
  // itself failed. Restarting asks the same broken configuration to try again.
  return hasScriptMismatch(entry, expectedScript) || (entry.pm2_env?.status === 'online' && !entry.pid);
}
