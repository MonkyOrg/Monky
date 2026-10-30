import fs from 'fs';
import path from 'path';
import { LIMITS, LOG_LEVELS, LogLevel } from '@monky/shared';
import { SqliteServerRepository } from '../../infrastructure/database/SqliteRepositories';
import { ANSI, color, DEFAULT_SERVER_NAME, SERVER_DB_NAME } from '../constants';
import { formatBotCompatibilityWarnings, printBotCompatibility, printBotCompatibilityWarning, waitForLocalServerPreview } from '../botCompatibility';
import { GlobalArgs, readLocalConfig, withContext } from '../context';
import { describeTurnPortProblem, describeTurnUnavailability, formatBool, formatProcessStatus, parseOption, parsePort, parsePositiveInt, pad } from '../formatters';
import {
  ensurePm2,
  deletePm2Process,
  findLegacyProcessFor,
  findPm2Process,
  getPm2ProcessName,
  getServerEntryPath,
  isMonkyServerRegistered,
  LEGACY_PM2_PROCESS_NAME,
  listPm2Processes,
  Pm2Process,
  pm2Availability,
  requirePm2,
  writeEcosystem,
} from '../pm2';
import { runAsync, runSync } from '../process';
import { diagnoseServerHealth, HealthProblem, needsProcessRecreate } from '../health';
import { hasServerDatabase, RegisteredServer, registerServer } from '../registry';
import { confirmDisconnectingUsers, readLocalServerPreview, resolveServerPort } from '../onlineUsers';
import { knownServers, resolveTargetServer } from '../target';
import { CoturnManager, TURN_LISTENING_PORT } from '../../infrastructure/turn/CoturnManager';
import { getCliLanguage, t } from '../i18n/index';
import { prepareUpdateRestart } from '../../infrastructure/lifecycle/updateRestart';
import { Logger } from '../../infrastructure/logger/Logger';
import { updateTiming } from '../updateSafety';

/**
 * Flags that only ever applied while the database was being created.
 *
 * `ensureServerSeedData` ignores them once the server exists, so accepting them
 * on `monky start` silently did nothing. They now fail loudly and point at the
 * command that actually applies them.
 */
const REMOVED_START_OPTIONS: Record<string, string> = {
  '--password': 'monky config set password',
  '--max-users': 'monky config set maxUsers',
  '--name': 'monky config set name',
  '--voice-channel': 'monky create',
  '--text-channel': 'monky create',
};

function rejectRemovedStartOptions(args: string[]): void {
  for (const [option, replacement] of Object.entries(REMOVED_START_OPTIONS)) {
    if (args.includes(option)) {
      throw new Error(t('lifecycle.removedOption', { option, replacement }));
    }
  }
}

/**
 * Drops a broken PM2 registration before starting, so the next start builds the
 * process from the ecosystem instead of reusing one that cannot run.
 *
 * A failed spawn or changed executable needs a fresh registration. PM2
 * reapplies the interpreter on restart but retains its cached pm_exec_path.
 */
function recreateIfStale(processName: string, entry: Pm2Process | null, forced: boolean): void {
  if (!forced && !needsProcessRecreate(entry, getServerEntryPath())) return;
  console.log(color(t('lifecycle.recreatingProcess'), ANSI.yellow));
  deletePm2Process(processName);
}

export async function loadStoredServer(
  dataDir: string
): Promise<Awaited<ReturnType<SqliteServerRepository['getLifecycleSettings']>>> {
  if (!hasServerDatabase(dataDir)) {
    return null;
  }
  return withContext(dataDir, async (ctx) => ctx.serverRepo.getLifecycleSettings(), false, { readOnly: true });
}

export interface StartPlan {
  dataDir: string;
  port: number;
  serverName: string;
}

/**
 * Resolves what `monky start` will hand to PM2.
 *
 * Everything comes from the server that already exists on disk; `--port` is the
 * only accepted override, because it is the one setting that may need to change
 * per boot without being persisted.
 */
export async function buildStartPlan(dataDir: string, args: string[]): Promise<StartPlan> {
  // Arguments are validated before the database is opened so a typo fails with
  // a message about the typo, not about the database.
  rejectRemovedStartOptions(args);
  const portOption = parseOption(args, '--port');
  const overriddenPort = portOption ? parsePort(portOption) : null;

  const localConfig = readLocalConfig(dataDir);
  const storedServer = await loadStoredServer(dataDir);

  return {
    dataDir,
    port: overriddenPort ?? localConfig.port ?? LIMITS.DEFAULT_PORT,
    serverName: storedServer?.name || DEFAULT_SERVER_NAME,
  };
}

/**
 * Retires the pre-registry `monky-server` process for this data directory.
 *
 * Without this an upgraded machine would end up with the old process and the
 * new per-directory one competing for the same port.
 */
function retireLegacyProcess(dataDir: string, processes: readonly Pm2Process[]): void {
  if (!findLegacyProcessFor(dataDir, processes)) return;
  console.log(color(t('lifecycle.migratingPm2'), ANSI.dim));
  runSync('pm2', ['delete', LEGACY_PM2_PROCESS_NAME], { stdio: 'ignore' });
}

export async function startServerCommand(globalArgs: GlobalArgs, args: string[]): Promise<void> {
  rejectRemovedStartOptions(args);
  const portOption = parseOption(args, '--port');
  if (portOption) parsePort(portOption);
  const fresh = args.includes('--fresh');

  const target = await resolveTargetServer(globalArgs, t('action.start'));
  const plan = await buildStartPlan(target.dataDir, args);
  const processName = getPm2ProcessName(target.dataDir);

  ensurePm2();

  const processes = listPm2Processes();
  const existing = findPm2Process(processName, processes);
  // `status === 'online'` alone is not proof the server is up: PM2 reports the
  // state it intends to keep, so a failed spawn stays "online" with no pid.
  // Trusting it made `monky start` answer "already running" for a server that
  // had never started, refusing to fix the very thing it was asked to fix
  // (#522).
  if (existing?.pm2_env?.status === 'online' && existing.pid) {
    if (!fresh) {
      console.log(color(t('lifecycle.alreadyRunning', { pid: existing.pid }), ANSI.yellow));
      console.log(color(t('lifecycle.useRestartOrStop'), ANSI.dim));
      await printBotCompatibilityWarning(resolveServerPort(target));
      return;
    }
    // `--fresh` is the one path where start takes down a server that is
    // actually up, so it owes the same warning as stop and restart (#334).
    // A broken process has nobody connected, so this asks nothing there.
    if (!(await confirmDisconnectingUsers(target, t('action.restart')))) return;
  }

  retireLegacyProcess(target.dataDir, processes);
  const ecosystemPath = writeEcosystem(plan);
  recreateIfStale(processName, existing, fresh);

  // startOrRestart re-reads the ecosystem file, so a process PM2 still knows
  // about from a previous "monky stop" picks up the current port.
  const result = runSync('pm2', ['startOrRestart', ecosystemPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(t('lifecycle.startFailed'));
  }

  runSync('pm2', ['save'], { stdio: 'ignore' });
  registerServer(target.dataDir, { name: plan.serverName, port: plan.port });

  console.log();
  console.log(color(t('lifecycle.started'), ANSI.green));
  console.log(t('target.portSuffix', { port: plan.port }));
  console.log(`${t('label.dataDir')}: ${plan.dataDir}`);
  console.log(`${t('label.name')}: ${plan.serverName}`);
  console.log(`${t('label.pm2Process')}: ${processName}`);
  await printBotCompatibilityWarning(plan.port, { waitForStartup: true });
  console.log();
  console.log(color(t('lifecycle.helpTitle'), ANSI.bold));
  console.log(t('lifecycle.helpStatus'));
  console.log(t('lifecycle.helpLogs'));
  console.log(t('lifecycle.helpRestart'));
  console.log(t('lifecycle.helpStop'));
}

export async function stopServerCommand(globalArgs: GlobalArgs): Promise<void> {
  if (!requirePm2(t('action.stop'))) return;

  const target = await resolveTargetServer(globalArgs, t('action.stop'));
  const processName = getPm2ProcessName(target.dataDir);

  // Everyone on the server loses their session when it goes down (#334).
  if (!(await confirmDisconnectingUsers(target, t('action.stop')))) return;

  const processes = listPm2Processes();
  if (!isMonkyServerRegistered(processName, processes) && findLegacyProcessFor(target.dataDir, processes)) {
    runSync('pm2', ['stop', LEGACY_PM2_PROCESS_NAME], { stdio: 'inherit' });
    console.log(color(t('lifecycle.stopped'), ANSI.green));
    return;
  }

  const result = runSync('pm2', ['stop', processName], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (output.includes('not found')) {
      console.log(color(t('lifecycle.notRegistered'), ANSI.yellow));
      return;
    }
    throw new Error(t('lifecycle.stopFailed'));
  }

  // The process is kept in PM2 on purpose: deleting it discards the logs right
  // when they matter most, after a crash or a manual stop.
  console.log(color(t('lifecycle.stopped'), ANSI.green));
  console.log(color(t('lifecycle.logsAvailable'), ANSI.dim));
}

/** Resolves `true` only when the server was actually restarted. */
export async function restartServerCommand(globalArgs: GlobalArgs, args: string[] = []): Promise<boolean> {
  if (!requirePm2(t('action.restart'))) return false;

  const fresh = args.includes('--fresh');
  const afterUpdate = args.includes('--after-update');
  const target = await resolveTargetServer(globalArgs, t('action.restart'));
  const processName = getPm2ProcessName(target.dataDir);
  const processes = listPm2Processes();

  if (!isMonkyServerRegistered(processName, processes) && !findLegacyProcessFor(target.dataDir, processes)) {
    console.log(color(t('lifecycle.notRegisteredStart'), ANSI.yellow));
    return false;
  }

  const current = findPm2Process(processName, processes) ?? findLegacyProcessFor(target.dataDir, processes);
  // An update only reloads servers that were running: one the operator
  // stopped on purpose must not come back up at 4am.
  if (afterUpdate && !(current?.pm2_env?.status === 'online' && current.pid)) {
    console.log(color(t('lifecycle.updateLeftStopped'), ANSI.dim));
    return false;
  }

  // A restart drops every open session, same as a stop (#334).
  if (!(await confirmDisconnectingUsers(target, t('action.restart')))) return false;

  // Rewriting the ecosystem before restarting is what makes a port or name
  // changed in the meantime actually take effect.
  const plan = await buildStartPlan(target.dataDir, args);
  const ecosystemPath = writeEcosystem(plan);
  let clearIntent: (() => void) | undefined;
  if (afterUpdate && current?.pid) {
    try { clearIntent = prepareUpdateRestart(target.dataDir, current.pid); }
    catch (error) {
      Logger.error('ERROR', 'Could not prepare the update restart notice.', error);
      throw new Error(t('lifecycle.updateNoticeFailed'));
    }
  }
  let restartFailed = false;
  try {
    retireLegacyProcess(target.dataDir, processes);
    recreateIfStale(processName, current, fresh);
    const result = runSync('pm2', ['startOrRestart', ecosystemPath], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(t('lifecycle.restartFailed'));
  } catch (error) {
    restartFailed = true;
    throw error;
  } finally {
    try { clearIntent?.(); }
    catch (error) {
      Logger.error('ERROR', 'Could not clear the update restart notice.', error);
      if (!restartFailed) throw new Error(t('lifecycle.updateNoticeCleanupFailed'));
    }
  }

  runSync('pm2', ['save'], { stdio: 'ignore' });
  registerServer(target.dataDir, { name: plan.serverName, port: plan.port });

  if (afterUpdate) {
    // Exiting with an error is what lets the updater roll the version back.
    const preview = await waitForLocalServerPreview(plan.port, updateTiming.startupMs);
    if (!preview) {
      throw new Error(t('lifecycle.updateStartFailed', { port: plan.port, seconds: updateTiming.startupMs / 1000 }));
    }
    console.log(color(t('lifecycle.restarted'), ANSI.green));
    console.log(t('target.portSuffix', { port: plan.port }));
    printBotCompatibility(preview);
    return true;
  }

  console.log(color(t('lifecycle.restarted'), ANSI.green));
  console.log(t('target.portSuffix', { port: plan.port }));
  await printBotCompatibilityWarning(plan.port, { waitForStartup: true });
  return true;
}

/**
 * Classifies a PM2 output line by the level the server Logger printed it with.
 *
 * The console format is `[timestamp] [CATEGORY]` for INFO and
 * `[timestamp] [WARN:CATEGORY]` / `[ERROR:CATEGORY]` for the rest, and PM2
 * prefixes every line with its own process tag, so the markers are matched
 * anywhere in the line. Lines that match nothing are continuations (stack
 * traces, for instance) and inherit the level of the line above them.
 */
function classifyLogLine(line: string): LogLevel | null {
  if (line.includes('[ERROR:')) return 'ERROR';
  if (line.includes('[WARN:')) return 'WARN';
  if (/\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+\[[A-Z]+\]/.test(line)) return 'INFO';
  return null;
}

function parseLevelOption(value: string): LogLevel {
  const normalized = value.trim().toUpperCase();
  if ((LOG_LEVELS as string[]).includes(normalized)) return normalized as LogLevel;
  throw new Error(t('lifecycle.invalidLevel', { value, levels: LOG_LEVELS.join(', ') }));
}

export async function logsServerCommand(globalArgs: GlobalArgs, args: string[] = []): Promise<void> {
  const linesOption = parseOption(args, '--lines');
  const levelOption = parseOption(args, '--level');
  const follow = !args.includes('--no-follow');

  const lines = linesOption ? parsePositiveInt('lines', linesOption) : 100;
  const minLevel = levelOption ? parseLevelOption(levelOption) : null;

  const availability = pm2Availability();
  if (availability === 'failing') {
    console.log(color(t('pm2.failing', { action: t('action.inspect') }), ANSI.yellow));
    console.log(color(t('pm2.failingHint'), ANSI.dim));
    return;
  }
  if (availability === 'missing') {
    console.log(color(t('lifecycle.pm2NoLogs'), ANSI.yellow));
    console.log(color(t('lifecycle.logsExplain'), ANSI.dim));
    console.log(color(t('pm2.installHint'), ANSI.dim));
    console.log(color(t('lifecycle.serverMonkyApp'), ANSI.dim));
    return;
  }

  const target = await resolveTargetServer(globalArgs, t('action.inspect'));
  let processName = getPm2ProcessName(target.dataDir);
  const processes = listPm2Processes();

  if (!isMonkyServerRegistered(processName, processes)) {
    if (findLegacyProcessFor(target.dataDir, processes)) {
      processName = LEGACY_PM2_PROCESS_NAME;
    } else {
      console.log(color(t('lifecycle.logsNoRegistered'), ANSI.yellow));
      console.log(color(t('lifecycle.logsUseStart'), ANSI.dim));
      return;
    }
  }

  const pm2Args = ['logs', processName, '--lines', String(lines)];
  if (!follow) pm2Args.push('--nostream');

  const describeFilter = minLevel ? t('lifecycle.levelFilter', { level: minLevel }) : '';
  console.log(
    color(
      follow
        ? t('lifecycle.showingLogs', { name: target.name || target.dataDir, filter: describeFilter })
        : t('lifecycle.lastLines', { lines, name: target.name || target.dataDir, filter: describeFilter }),
      ANSI.dim
    )
  );

  // Without a level filter, hand the terminal straight to PM2 so its own
  // colours and formatting survive; filtering requires reading the stream.
  if (!minLevel) {
    runSync('pm2', pm2Args, { stdio: 'inherit' });
    return;
  }

  const threshold = LOG_LEVELS.indexOf(minLevel);
  const child = runAsync('pm2', pm2Args);
  let pending = '';
  let keepingCurrent = false;

  const handleChunk = (chunk: Buffer) => {
    pending += chunk.toString();
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? '';

    for (const line of parts) {
      const level = classifyLogLine(line);
      if (level) {
        keepingCurrent = LOG_LEVELS.indexOf(level) >= threshold;
      }
      if (keepingCurrent) console.log(line);
    }
  };

  child.stdout?.on('data', handleChunk);
  child.stderr?.on('data', handleChunk);
  child.on('close', () => {
    if (pending && keepingCurrent) console.log(pending);
  });

  const forwardInterrupt = () => child.kill();
  process.on('SIGINT', forwardInterrupt);
  child.on('close', () => process.off('SIGINT', forwardInterrupt));
}

function statusLabel(status: string): string {
  const statusColor = status === 'online' ? ANSI.green : status === 'stopped' ? ANSI.yellow : ANSI.red;
  return color(formatProcessStatus(status), statusColor);
}

function readServerStatus(
  dataDir: string,
  processes: readonly Pm2Process[] = listPm2Processes(),
): { status: string; process: ReturnType<typeof findPm2Process> } {
  const found = findPm2Process(getPm2ProcessName(dataDir), processes) ?? findLegacyProcessFor(dataDir, processes);
  return { status: found?.pm2_env?.status ?? 'not started', process: found };
}

async function printServerDetails(server: RegisteredServer): Promise<void> {
  const { status, process: entry } = readServerStatus(server.dataDir);
  const port = server.port ?? readLocalConfig(server.dataDir).port ?? LIMITS.DEFAULT_PORT;

  console.log(color(t('lifecycle.serverState', { name: server.name || 'Monky Server' }), ANSI.bold));
  console.log(`${t('label.status')}: ${statusLabel(status)}`);
  console.log(`${t('label.dataDir')}: ${server.dataDir}`);
  console.log(`${t('target.portSuffix', { port })}`);
  console.log(`${t('label.pm2Process')}: ${getPm2ProcessName(server.dataDir)}`);

  if (!entry) {
    console.log(color(t('lifecycle.useStart'), ANSI.dim));
    return;
  }

  console.log(`${t('label.pid')}: ${entry.pid || '-'}`);
  console.log(`${t('label.startedAt')}: ${entry.pm2_env?.pm_uptime ? new Date(entry.pm2_env.pm_uptime).toISOString() : '-'}`);
  console.log(`${t('label.restarts')}: ${entry.pm2_env?.restart_time ?? 0}`);
  console.log(`${t('label.memory')}: ${entry.monit?.memory ? `${Math.round(entry.monit.memory / 1024 / 1024)} MB` : '-'}`);
  console.log(`${t('label.cpu')}: ${entry.monit?.cpu !== undefined ? `${entry.monit.cpu}%` : '-'}`);
  if (entry.pm2_env?.node_version) console.log(`${t('label.node')}: ${entry.pm2_env.node_version}`);

  // PM2's own status is a claim, not a measurement, so it is checked against
  // the port before being taken at face value (#522).
  printHealthProblems(await diagnoseServerHealth(entry, port, getServerEntryPath()));
  if (status === 'online' && entry.pid) {
    await printBotCompatibilityWarning(port);
  }

  // TURN relay info (#441)
  printTurnStatus(server.dataDir);
}

/** Prints the diagnostics block, or nothing at all when the server is healthy. */
function printHealthProblems(problems: HealthProblem[]): void {
  if (problems.length === 0) return;
  console.log();
  console.log(color(t('health.title'), ANSI.bold));
  for (const problem of problems) {
    console.log(color(`⚠ ${problem.message}`, ANSI.yellow));
    if (problem.hint) console.log(`  ${color(problem.hint, ANSI.dim)}`);
  }
}

export async function printServerTable(servers: RegisteredServer[]): Promise<void> {
  const processes = listPm2Processes();
  const rows = await Promise.all(servers.map(async (server) => {
    const snapshot = readServerStatus(server.dataDir, processes);
    const port = resolveServerPort(server);
    return {
      name: server.name || 'Monky Server',
      status: snapshot.status,
      port: String(port),
      dataDir: server.dataDir,
      warnings: await readBotWarnings(port, snapshot),
    };
  }));

  const nameWidth = Math.max(t('lifecycle.tableNome').length, ...rows.map((row) => row.name.length));
  const statusWidth = Math.max(t('lifecycle.tableStatus').length, ...rows.map((row) => formatProcessStatus(row.status).length));
  const portWidth = Math.max(t('lifecycle.tablePorta').length, ...rows.map((row) => row.port.length));

  console.log(
    `${color(pad(t('lifecycle.tableNome'), nameWidth), ANSI.cyan)}  ${color(pad(t('lifecycle.tableStatus'), statusWidth), ANSI.cyan)}  ` +
      `${color(pad(t('lifecycle.tablePorta'), portWidth), ANSI.cyan)}  ${color(t('lifecycle.tableDataDir'), ANSI.cyan)}`
  );

  for (const row of rows) {
    const paddedStatus = statusLabel(row.status) + ' '.repeat(Math.max(0, statusWidth - formatProcessStatus(row.status).length));
    console.log(`${pad(row.name, nameWidth)}  ${paddedStatus}  ${pad(row.port, portWidth)}  ${row.dataDir}`);
    for (const warning of row.warnings) console.log(`  ${warning}`);
  }
}

export async function listServersCommand(): Promise<void> {
  const servers = knownServers();
  if (servers.length === 0) {
    console.log(color(t('lifecycle.noneFound'), ANSI.yellow));
    console.log(color(t('lifecycle.createHint'), ANSI.dim));
    return;
  }
  await printServerTable(servers);
}

/**
 * Prints TURN relay info when the server has it configured (#441).
 *
 * This is the sync stub called from `printServerDetails`; it only shows
 * platform-level availability. The full async variant (`printTurnStatusAsync`)
 * also reads the database to check whether TURN is actually enabled.
 */
function printTurnStatus(_dataDir: string): void {
  // The sync path only reports coturn availability; the database read happens
  // in printTurnStatusAsync after printServerDetails returns.
}

/**
 * Async variant that reads TURN status from the database.
 */
async function printTurnStatusAsync(dataDir: string): Promise<void> {
  if (!hasServerDatabase(dataDir)) return;
  try {
    await withContext(dataDir, async (ctx) => {
      const server = await ctx.serverRepo.getLifecycleSettings();
      if (!server) return;
      const turnEnabled = Boolean(server.turnEnabled);
      console.log();
      console.log(color(t('lifecycle.turnTitle'), ANSI.bold));
      console.log(`${t('label.turn')}: ${formatBool(turnEnabled)}`);
      if (turnEnabled) {
        const reason = describeTurnUnavailability(CoturnManager.describeAvailability());
        if (reason) {
          console.log(`coturn: ${color(t('lifecycle.coturnUnavailable'), ANSI.yellow)}`);
          console.log(`  ${color(reason, ANSI.dim)}`);
        } else {
          console.log(`coturn: ${color(t('lifecycle.coturnInstalled'), ANSI.green)}`);
          console.log(`${t('label.port')}: ${TURN_LISTENING_PORT}`);
          // Check port reachability
          const portProblem = await CoturnManager.checkPortReachability(describeTurnPortProblem);
          if (portProblem) {
            console.log(`${t('label.status')}: ${color(t('lifecycle.turnPortBlocked'), ANSI.yellow)}`);
            console.log(`  ${color(portProblem, ANSI.dim)}`);
          } else {
            console.log(`${t('label.status')}: ${color(t('lifecycle.turnAccessible'), ANSI.green)}`);
          }
        }
      }
    }, false, { readOnly: true });
  } catch (error) {
    console.log(color(t('lifecycle.turnDiagnosticsFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }), ANSI.yellow));
  }
}

/**
 * Formats uptime from epoch ms to a human-readable duration.
 */
function formatUptime(startedAtMs: number): string {
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < 0) return '-';
  const seconds = Math.floor(elapsed / 1000) % 60;
  const minutes = Math.floor(elapsed / (1000 * 60)) % 60;
  const hours = Math.floor(elapsed / (1000 * 60 * 60)) % 24;
  const days = Math.floor(elapsed / (1000 * 60 * 60 * 24));
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * TURN status shown by the dashboard.
 */
interface TurnCache {
  enabled: boolean | null;
  coturnOk: boolean;
  coturnProblem: string | null;
  portProblem: string | null;
}

/**
 * How often the dashboard looks at TURN again. Both checks cost far more than
 * its 2s redraw: the settings come from loading the whole database, and the
 * port check binds UDP ports and asks an outside service to probe this host.
 */
const DASHBOARD_TURN_REFRESH = { settingsMs: 30_000, probeMs: 60_000 };

/**
 * TURN state for one dashboard. The database is read again only after it
 * changed on disk, and at most every `settingsMs`; coturn and its ports are
 * checked every `probeMs`, or as soon as TURN gets enabled.
 */
export class DashboardTurnStatus {
  public readonly state: TurnCache = { enabled: null, coturnOk: false, coturnProblem: null, portProblem: null };
  /** Modification time of the database read last; undefined before the first read. */
  private databaseMtimeMs: number | null | undefined;
  private settingsReadAt = -Infinity;
  private probedAt = -Infinity;

  constructor(private readonly dataDir: string) {}

  public async refresh(now = Date.now()): Promise<void> {
    const wasEnabled = this.state.enabled;
    const databaseMtimeMs = fs.statSync(path.join(this.dataDir, SERVER_DB_NAME), { throwIfNoEntry: false })?.mtimeMs ?? null;
    if (databaseMtimeMs !== this.databaseMtimeMs && now - this.settingsReadAt >= DASHBOARD_TURN_REFRESH.settingsMs) {
      try {
        const server = await withContext(this.dataDir, async (ctx) => ctx.serverRepo.getLifecycleSettings(), false, { readOnly: true });
        this.state.enabled = server ? Boolean(server.turnEnabled) : null;
        this.databaseMtimeMs = databaseMtimeMs;
        this.settingsReadAt = now;
      } catch {
        // Unreadable right now: keep the last state and try again on the next redraw.
      }
    }
    if (!this.state.enabled) return;
    if (wasEnabled === true && now - this.probedAt < DASHBOARD_TURN_REFRESH.probeMs) return;
    this.probedAt = now;
    const reason = describeTurnUnavailability(CoturnManager.describeAvailability());
    this.state.coturnOk = !reason;
    this.state.coturnProblem = reason;
    this.state.portProblem = reason ? null : await CoturnManager.checkPortReachability(describeTurnPortProblem);
  }
}

/**
 * Same idea as {@link DashboardTurnStatus}: the dashboard redraws every 2s, and
 * probing the port inside the render would stall the frame.
 */
let healthCache: HealthProblem[] = [];

/**
 * Reads PM2 once and shares the result with everything drawing this frame.
 *
 * Each `readServerStatus` costs a synchronous `pm2 jlist`, which loads all of
 * PM2, so letting the health refresh and the render each do their own doubled
 * the blocking spawns per tick — enough to overrun the 2s interval on the small
 * VPSes this dashboard is meant for.
 */
type StatusSnapshot = ReturnType<typeof readServerStatus>;

async function readBotWarnings(port: number, snapshot: StatusSnapshot): Promise<string[]> {
  if (snapshot.status !== 'online' || !snapshot.process?.pid) return [];
  const summary = (await readLocalServerPreview(port))?.botCompatibility ?? null;
  return formatBotCompatibilityWarnings(summary);
}

async function refreshHealthCache(server: RegisteredServer, snapshot: StatusSnapshot): Promise<void> {
  const port = server.port ?? readLocalConfig(server.dataDir).port ?? LIMITS.DEFAULT_PORT;
  try {
    healthCache = await diagnoseServerHealth(snapshot.process, port, getServerEntryPath());
  } catch {
    healthCache = [];
  }
}

/**
 * Renders one frame of the real-time dashboard without flicker.
 *
 * Instead of clearing the whole screen (which causes a visible flash), we move
 * the cursor to the top-left, write the full frame, then erase everything
 * below. This produces a smooth in-place update.
 */
function renderDashboard(
  server: RegisteredServer, snapshot: StatusSnapshot, botWarnings: readonly string[], turnCache: Readonly<TurnCache>,
): void {
  const { status, process: entry } = snapshot;
  const port = server.port ?? readLocalConfig(server.dataDir).port ?? LIMITS.DEFAULT_PORT;

  const lines: string[] = [];
  const push = (s: string = '') => lines.push(s);

  push(color('╔══════════════════════════════════════════════════╗', ANSI.cyan));
  push(color('║', ANSI.cyan) + color(pad(`  ${t('lifecycle.dashboard')}`, 50), ANSI.bold) + color('║', ANSI.cyan));
  push(color('╚══════════════════════════════════════════════════╝', ANSI.cyan));
  push();

  // ── Server ──
  push(color(`  ${t('lifecycle.dashboardServer')}`, ANSI.bold));
  push(`    ${t('config.askName')}: ${server.name || 'Monky Server'}`);
  push(`    ${t('label.status')}: ${statusLabel(status)}`);
  push(`    ${t('config.askPort')}: ${port}`);
  push(`    ${t('label.dataDir')}: ${server.dataDir}`);
  push(`    ${t('label.pm2Process')}: ${getPm2ProcessName(server.dataDir)}`);
  for (const warning of botWarnings) push(`    ${warning}`);

  // ── Process ──
  if (entry) {
    push();
    push(color(`  ${t('lifecycle.dashboardProcess')}`, ANSI.bold));
    push(`    ${t('label.pid')}: ${entry.pid || '-'}`);
    push(`    ${t('label.uptime')}: ${entry.pm2_env?.pm_uptime ? formatUptime(entry.pm2_env.pm_uptime) : '-'}`);
    push(`    ${t('label.restarts')}: ${entry.pm2_env?.restart_time ?? 0}`);
    push(`    ${t('label.memory')}: ${entry.monit?.memory ? `${Math.round(entry.monit.memory / 1024 / 1024)} MB` : '-'}`);
    push(`    ${t('label.cpu')}: ${entry.monit?.cpu !== undefined ? `${entry.monit.cpu}%` : '-'}`);
    if (entry.pm2_env?.node_version) push(`    ${t('label.node')}: ${entry.pm2_env.node_version}`);
  }

  // ── Diagnóstico ──
  if (healthCache.length > 0) {
    push();
    push(color(`  ${t('health.title')}`, ANSI.bold));
    for (const problem of healthCache) {
      push(color(`    ⚠ ${problem.message}`, ANSI.yellow));
      if (problem.hint) push(`      ${color(problem.hint, ANSI.dim)}`);
    }
  }

  // ── TURN ──
  if (turnCache.enabled !== null) {
    push();
    push(color(`  ${t('lifecycle.turnTitle')}`, ANSI.bold));
    push(`    ${t('label.turn')}: ${formatBool(turnCache.enabled)}`);
    if (turnCache.enabled) {
      if (!turnCache.coturnOk) {
        push(`    coturn:   ${color(t('lifecycle.coturnUnavailable'), ANSI.yellow)}`);
        if (turnCache.coturnProblem) push(`              ${color(turnCache.coturnProblem, ANSI.dim)}`);
      } else {
        push(`    coturn:   ${color(t('lifecycle.coturnInstalled'), ANSI.green)}`);
        push(`    ${t('label.port')}: ${TURN_LISTENING_PORT}`);
        if (turnCache.portProblem) {
          push(`    ${t('label.status')}: ${color(t('lifecycle.turnPortBlocked'), ANSI.yellow)}`);
          push(`              ${color(turnCache.portProblem, ANSI.dim)}`);
        } else {
          push(`    ${t('label.status')}: ${color(t('lifecycle.turnAccessible'), ANSI.green)}`);
        }
      }
    }
  }

  push();
  push(color(`  ${t('lifecycle.dashboardUpdated', { time: new Date().toLocaleTimeString(getCliLanguage()) })}`, ANSI.dim));
  push(color(`  ${t('lifecycle.dashboardExit')}`, ANSI.dim));

  // Move cursor to top-left, write frame, then erase anything below
  process.stdout.write('\x1b[H' + lines.join('\n') + '\n\x1b[J');
}

/**
 * Shows one server in detail, or every server as a table.
 *
 * Listing is read-only, so with several servers it prints all of them instead
 * of asking which one — asking would be busywork for a question with no side
 * effects.
 */
export async function statusServerCommand(globalArgs: GlobalArgs, args: string[] = []): Promise<void> {
  if (!requirePm2(t('action.check'))) return;

  const watch = args.includes('--watch') || args.includes('-w');

  if (watch) {
    const target = await resolveTargetServer(globalArgs, t('action.monitor'));

    // --watch mode: real-time dashboard that refreshes every 2s (#441)
    // Seed TURN cache before first render, then render
    const turn = new DashboardTurnStatus(target.dataDir);
    const seed = readServerStatus(target.dataDir);
    const port = resolveServerPort(target);
    const [, , seedWarnings] = await Promise.all([
      turn.refresh(), refreshHealthCache(target, seed), readBotWarnings(port, seed),
    ]);
    // Hide the cursor only after the initial probes succeed.
    process.stdout.write('\x1b[?25l\x1b[2J');
    renderDashboard(target, seed, seedWarnings, turn.state);
    let refreshing = false;
    const interval = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const snapshot = readServerStatus(target.dataDir);
        const [, , warnings] = await Promise.all([
          turn.refresh(), refreshHealthCache(target, snapshot), readBotWarnings(resolveServerPort(target), snapshot),
        ]);
        renderDashboard(target, snapshot, warnings, turn.state);
      } catch (error) {
        console.error(color(t('lifecycle.dashboardRefreshFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }), ANSI.red));
      } finally {
        refreshing = false;
      }
    }, 2000);

    const cleanup = () => {
      clearInterval(interval);
      // Show cursor again and print a clean exit line
      process.stdout.write('\x1b[?25h');
      console.log();
      console.log(color(t('lifecycle.dashboardClosed'), ANSI.dim));
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    return;
  }

  if (globalArgs.dataDirSpecified) {
    const target = await resolveTargetServer(globalArgs, t('action.check'));
    await printServerDetails(target);
    await printTurnStatusAsync(target.dataDir);
    return;
  }

  const servers = knownServers();
  if (servers.length === 0) {
    console.log(color(t('lifecycle.noneFound'), ANSI.yellow));
    console.log(color(t('lifecycle.createHint'), ANSI.dim));
    return;
  }

  if (servers.length === 1) {
    await printServerDetails(servers[0]);
    await printTurnStatusAsync(servers[0].dataDir);
    return;
  }

  await printServerTable(servers);
  console.log();
  console.log(color(t('lifecycle.useStatusData'), ANSI.dim));
}
