import { LIMITS, LOG_LEVELS, LogLevel } from '@monky/shared';
import { SqliteServerRepository } from '../../infrastructure/database/SqliteRepositories';
import { clearRestartMarker, markUpdateRestart } from '../../infrastructure/lifecycle/RestartMarker';
import { ANSI, color, DEFAULT_SERVER_NAME } from '../constants';
import { GlobalArgs, readLocalConfig, withContext } from '../context';
import { formatBool, parseOption, parsePositiveInt, pad } from '../formatters';
import {
  ensurePm2,
  deletePm2Process,
  findLegacyProcessFor,
  findPm2Process,
  getPm2ProcessName,
  isMonkyServerRegistered,
  isPm2Available,
  LEGACY_PM2_PROCESS_NAME,
  Pm2Process,
  requirePm2,
  writeEcosystem,
} from '../pm2';
import { runAsync, runSync } from '../process';
import { diagnoseServerHealth, HealthProblem, needsProcessRecreate } from '../health';
import { hasServerDatabase, RegisteredServer, registerServer } from '../registry';
import { confirmDisconnectingUsers } from '../onlineUsers';
import { knownServers, resolveTargetServer } from '../target';
import { CoturnManager, TURN_LISTENING_PORT } from '../../infrastructure/turn/CoturnManager';
import { t } from '../i18n/index';

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
 * Reserved for a process PM2 calls `online` without ever having a pid for it:
 * the spawn failed, and restarting only asks the same configuration to fail
 * again — deleting first is what actually recovered it (#522). A plain
 * `startOrRestart` re-reads the ecosystem file and re-applies the interpreter,
 * so a stale interpreter alone is not worth dropping the process for.
 */
function recreateIfStale(processName: string, entry: Pm2Process | null, forced: boolean): void {
  if (!forced && !needsProcessRecreate(entry)) return;
  console.log(color(t('lifecycle.recreatingProcess'), ANSI.yellow));
  deletePm2Process(processName);
}

export async function loadStoredServer(
  dataDir: string
): Promise<Awaited<ReturnType<SqliteServerRepository['getServer']>>> {
  if (!hasServerDatabase(dataDir)) {
    return null;
  }
  return withContext(dataDir, async (ctx) => ctx.serverRepo.getServer(), false);
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
  const overriddenPort = portOption ? parsePositiveInt('port', portOption) : null;

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
function retireLegacyProcess(dataDir: string): void {
  if (!findLegacyProcessFor(dataDir)) return;
  console.log(color(t('lifecycle.migratingPm2'), ANSI.dim));
  runSync('pm2', ['delete', LEGACY_PM2_PROCESS_NAME], { stdio: 'ignore' });
}

export async function startServerCommand(globalArgs: GlobalArgs, args: string[]): Promise<void> {
  rejectRemovedStartOptions(args);
  const portOption = parseOption(args, '--port');
  if (portOption) parsePositiveInt('port', portOption);
  const fresh = args.includes('--fresh');

  const target = await resolveTargetServer(globalArgs, 'iniciar');
  const plan = await buildStartPlan(target.dataDir, args);
  const processName = getPm2ProcessName(target.dataDir);

  ensurePm2();

  const existing = findPm2Process(processName);
  // `status === 'online'` alone is not proof the server is up: PM2 reports the
  // state it intends to keep, so a failed spawn stays "online" with no pid.
  // Trusting it made `monky start` answer "already running" for a server that
  // had never started, refusing to fix the very thing it was asked to fix
  // (#522).
  if (existing?.pm2_env?.status === 'online' && existing.pid) {
    if (!fresh) {
      console.log(color(t('lifecycle.alreadyRunning', { pid: existing.pid }), ANSI.yellow));
      console.log(color(t('lifecycle.useRestartOrStop'), ANSI.dim));
      return;
    }
    // `--fresh` is the one path where start takes down a server that is
    // actually up, so it owes the same warning as stop and restart (#334).
    // A broken process has nobody connected, so this asks nothing there.
    if (!(await confirmDisconnectingUsers(target, 'reiniciar'))) return;
  }

  retireLegacyProcess(target.dataDir);
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
  console.log(`dataDir: ${plan.dataDir}`);
  console.log(`serverName: ${plan.serverName}`);
  console.log(`PM2 process: ${processName}`);
  console.log();
  console.log(color(t('lifecycle.helpTitle'), ANSI.bold));
  console.log(t('lifecycle.helpStatus'));
  console.log(t('lifecycle.helpLogs'));
  console.log(t('lifecycle.helpRestart'));
  console.log(t('lifecycle.helpStop'));
}

export async function stopServerCommand(globalArgs: GlobalArgs): Promise<void> {
  if (!requirePm2('parar')) return;

  const target = await resolveTargetServer(globalArgs, 'parar');
  const processName = getPm2ProcessName(target.dataDir);

  // Everyone on the server loses their session when it goes down (#334).
  if (!(await confirmDisconnectingUsers(target, 'parar'))) return;

  if (!isMonkyServerRegistered(processName) && findLegacyProcessFor(target.dataDir)) {
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

export interface RestartOptions {
  /**
   * Whether this restart is applying an update. It is written to the data
   * directory so the outgoing process can tell its clients the server is
   * coming back, instead of the standard "the host closed the server" (#558).
   */
  asUpdate?: boolean;
}

export async function restartServerCommand(
  globalArgs: GlobalArgs,
  args: string[] = [],
  options: RestartOptions = {}
): Promise<void> {
  if (!requirePm2('reiniciar')) return;

  const fresh = args.includes('--fresh');
  const target = await resolveTargetServer(globalArgs, 'reiniciar');
  const processName = getPm2ProcessName(target.dataDir);

  if (!isMonkyServerRegistered(processName) && !findLegacyProcessFor(target.dataDir)) {
    console.log(color(t('lifecycle.notRegisteredStart'), ANSI.yellow));
    return;
  }

  // A restart drops every open session, same as a stop (#334).
  if (!(await confirmDisconnectingUsers(target, 'reiniciar'))) return;

  retireLegacyProcess(target.dataDir);

  // Rewriting the ecosystem before restarting is what makes a port or name
  // changed in the meantime actually take effect.
  const plan = await buildStartPlan(target.dataDir, args);
  const ecosystemPath = writeEcosystem(plan);
  recreateIfStale(processName, findPm2Process(processName), fresh);

  // Written immediately before the signal: the running process reads it while
  // shutting down, and a marker left by a restart that never happened would
  // otherwise sit there waiting to mislabel a later stop.
  if (options.asUpdate) {
    markUpdateRestart(target.dataDir);
  }

  const result = runSync('pm2', ['startOrRestart', ecosystemPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    clearRestartMarker(target.dataDir);
    throw new Error(t('lifecycle.restartFailed'));
  }

  runSync('pm2', ['save'], { stdio: 'ignore' });
  registerServer(target.dataDir, { name: plan.serverName, port: plan.port });

  console.log(color(t('lifecycle.restarted'), ANSI.green));
  console.log(t('target.portSuffix', { port: plan.port }));
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

  if (!isPm2Available()) {
    console.log(color(t('lifecycle.pm2NoLogs'), ANSI.yellow));
    console.log(color(t('lifecycle.logsExplain'), ANSI.dim));
    console.log(color(t('pm2.installHint'), ANSI.dim));
    console.log(color(t('lifecycle.serverMonkyApp'), ANSI.dim));
    return;
  }

  const target = await resolveTargetServer(globalArgs, 'inspecionar');
  let processName = getPm2ProcessName(target.dataDir);

  if (!isMonkyServerRegistered(processName)) {
    if (findLegacyProcessFor(target.dataDir)) {
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
  return color(status, statusColor);
}

function readServerStatus(dataDir: string): { status: string; process: ReturnType<typeof findPm2Process> } {
  const found = findPm2Process(getPm2ProcessName(dataDir)) ?? findLegacyProcessFor(dataDir);
  return { status: found?.pm2_env?.status ?? 'not started', process: found };
}

async function printServerDetails(server: RegisteredServer): Promise<void> {
  const { status, process: entry } = readServerStatus(server.dataDir);
  const port = server.port ?? readLocalConfig(server.dataDir).port ?? LIMITS.DEFAULT_PORT;

  console.log(color(t('lifecycle.serverState', { name: server.name || 'Monky Server' }), ANSI.bold));
  console.log(`status: ${statusLabel(status)}`);
  console.log(`dataDir: ${server.dataDir}`);
  console.log(`${t('target.portSuffix', { port })}`);
  console.log(`PM2 process: ${getPm2ProcessName(server.dataDir)}`);

  if (!entry) {
    console.log(color(t('lifecycle.useStart'), ANSI.dim));
    return;
  }

  console.log(`pid: ${entry.pid || '-'}`);
  console.log(`uptime: ${entry.pm2_env?.pm_uptime ? new Date(entry.pm2_env.pm_uptime).toISOString() : '-'}`);
  console.log(`restarts: ${entry.pm2_env?.restart_time ?? 0}`);
  console.log(`memory: ${entry.monit?.memory ? `${Math.round(entry.monit.memory / 1024 / 1024)} MB` : '-'}`);
  console.log(`cpu: ${entry.monit?.cpu !== undefined ? `${entry.monit.cpu}%` : '-'}`);
  if (entry.pm2_env?.node_version) console.log(`node: ${entry.pm2_env.node_version}`);

  // PM2's own status is a claim, not a measurement, so it is checked against
  // the port before being taken at face value (#522).
  printHealthProblems(await diagnoseServerHealth(entry, port));

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

export function printServerTable(servers: RegisteredServer[]): void {
  const rows = servers.map((server) => ({
    name: server.name || 'Monky Server',
    status: readServerStatus(server.dataDir).status,
    port: String(server.port ?? readLocalConfig(server.dataDir).port ?? LIMITS.DEFAULT_PORT),
    dataDir: server.dataDir,
  }));

  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length));
  const portWidth = Math.max(5, ...rows.map((row) => row.port.length));

  console.log(
    `${color(pad(t('lifecycle.tableNome'), nameWidth), ANSI.cyan)}  ${color(pad(t('lifecycle.tableStatus'), statusWidth), ANSI.cyan)}  ` +
      `${color(pad(t('lifecycle.tablePorta'), portWidth), ANSI.cyan)}  ${color(t('lifecycle.tableDataDir'), ANSI.cyan)}`
  );

  for (const row of rows) {
    const paddedStatus = statusLabel(row.status) + ' '.repeat(Math.max(0, statusWidth - row.status.length));
    console.log(`${pad(row.name, nameWidth)}  ${paddedStatus}  ${pad(row.port, portWidth)}  ${row.dataDir}`);
  }
}

export async function listServersCommand(): Promise<void> {
  const servers = knownServers();
  if (servers.length === 0) {
    console.log(color(t('lifecycle.noneFound'), ANSI.yellow));
    console.log(color(t('lifecycle.createHint'), ANSI.dim));
    return;
  }
  printServerTable(servers);
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
      const server = await ctx.serverRepo.getServer();
      if (!server) return;
      const turnEnabled = Boolean(server.turnEnabled);
      console.log();
      console.log(color(t('lifecycle.turnTitle'), ANSI.bold));
      console.log(`turn: ${formatBool(turnEnabled)}`);
      if (turnEnabled) {
        const reason = CoturnManager.getUnavailabilityReason();
        if (reason) {
          console.log(`coturn: ${color(t('lifecycle.coturnUnavailable'), ANSI.yellow)}`);
          console.log(`  ${color(reason, ANSI.dim)}`);
        } else {
          console.log(`coturn: ${color(t('lifecycle.coturnInstalled'), ANSI.green)}`);
          console.log(`port: ${TURN_LISTENING_PORT}`);
          // Check port reachability
          const portProblem = await CoturnManager.checkPortReachability();
          if (portProblem) {
            console.log(`status: ${color(t('lifecycle.turnPortBlocked'), ANSI.yellow)}`);
            console.log(`  ${color(portProblem, ANSI.dim)}`);
          } else {
            console.log(`status: ${color(t('lifecycle.turnAccessible'), ANSI.green)}`);
          }
        }
      }
    }, false);
  } catch {
    // Database may be locked by the running server; skip silently.
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
 * Cached TURN status so the dashboard can show it without blocking the render.
 * Updated asynchronously in the background every cycle.
 */
interface TurnCache {
  enabled: boolean | null;
  coturnOk: boolean;
  coturnProblem: string | null;
  portProblem: string | null;
}

let turnCache: TurnCache = { enabled: null, coturnOk: false, coturnProblem: null, portProblem: null };

/**
 * Same idea as {@link turnCache}: the dashboard redraws every 2s, and probing
 * the port inside the render would stall the frame.
 */
let healthCache: HealthProblem[] = [];

/**
 * Reads PM2 once and shares the result with everything drawing this frame.
 *
 * Each `readServerStatus` costs two synchronous child processes (`pm2 --version`
 * then `pm2 jlist`), so letting the health refresh and the render each do their
 * own doubled the blocking spawns per tick — enough to overrun the 2s interval
 * on the small VPSes this dashboard is meant for.
 */
type StatusSnapshot = ReturnType<typeof readServerStatus>;

async function refreshHealthCache(server: RegisteredServer, snapshot: StatusSnapshot): Promise<void> {
  const port = server.port ?? readLocalConfig(server.dataDir).port ?? LIMITS.DEFAULT_PORT;
  try {
    healthCache = await diagnoseServerHealth(snapshot.process, port);
  } catch {
    healthCache = [];
  }
}

async function refreshTurnCache(dataDir: string): Promise<void> {
  try {
    await withContext(dataDir, async (ctx) => {
      const server = await ctx.serverRepo.getServer();
      if (!server) { turnCache.enabled = null; return; }
      turnCache.enabled = Boolean(server.turnEnabled);
      if (!turnCache.enabled) return;
      const reason = CoturnManager.getUnavailabilityReason();
      if (reason) {
        turnCache.coturnOk = false;
        turnCache.coturnProblem = reason;
        turnCache.portProblem = null;
      } else {
        turnCache.coturnOk = true;
        turnCache.coturnProblem = null;
        turnCache.portProblem = await CoturnManager.checkPortReachability();
      }
    }, false);
  } catch {
    // DB locked — keep stale cache
  }
}

/**
 * Renders one frame of the real-time dashboard without flicker.
 *
 * Instead of clearing the whole screen (which causes a visible flash), we move
 * the cursor to the top-left, write the full frame, then erase everything
 * below. This produces a smooth in-place update.
 */
function renderDashboard(server: RegisteredServer, snapshot: StatusSnapshot): void {
  const { status, process: entry } = snapshot;
  const port = server.port ?? readLocalConfig(server.dataDir).port ?? LIMITS.DEFAULT_PORT;

  const lines: string[] = [];
  const push = (s: string = '') => lines.push(s);

  push(color('╔══════════════════════════════════════════════════╗', ANSI.cyan));
  push(color('║', ANSI.cyan) + color(`  ${t('lifecycle.dashboard')}`, ANSI.bold) + ' '.repeat(25) + color('║', ANSI.cyan));
  push(color('╚══════════════════════════════════════════════════╝', ANSI.cyan));
  push();

  // ── Server ──
  push(color(`  ${t('lifecycle.dashboardServer')}`, ANSI.bold));
  push(`    ${t('config.askName')}: ${server.name || 'Monky Server'}`);
  push(`    status:   ${statusLabel(status)}`);
  push(`    ${t('config.askPort')}: ${port}`);
  push(`    dataDir:  ${server.dataDir}`);
  push(`    process:  ${getPm2ProcessName(server.dataDir)}`);

  // ── Process ──
  if (entry) {
    push();
    push(color(`  ${t('lifecycle.dashboardProcess')}`, ANSI.bold));
    push(`    pid:      ${entry.pid || '-'}`);
    push(`    uptime:   ${entry.pm2_env?.pm_uptime ? formatUptime(entry.pm2_env.pm_uptime) : '-'}`);
    push(`    restarts: ${entry.pm2_env?.restart_time ?? 0}`);
    push(`    memory:   ${entry.monit?.memory ? `${Math.round(entry.monit.memory / 1024 / 1024)} MB` : '-'}`);
    push(`    cpu:      ${entry.monit?.cpu !== undefined ? `${entry.monit.cpu}%` : '-'}`);
    if (entry.pm2_env?.node_version) push(`    node:     ${entry.pm2_env.node_version}`);
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
    push(`    turn:     ${formatBool(turnCache.enabled)}`);
    if (turnCache.enabled) {
      if (!turnCache.coturnOk) {
        push(`    coturn:   ${color(t('lifecycle.coturnUnavailable'), ANSI.yellow)}`);
        if (turnCache.coturnProblem) push(`              ${color(turnCache.coturnProblem, ANSI.dim)}`);
      } else {
        push(`    coturn:   ${color(t('lifecycle.coturnInstalled'), ANSI.green)}`);
        push(`    port:     ${TURN_LISTENING_PORT}`);
        if (turnCache.portProblem) {
          push(`    status:   ${color(t('lifecycle.turnPortBlocked'), ANSI.yellow)}`);
          push(`              ${color(turnCache.portProblem, ANSI.dim)}`);
        } else {
          push(`    status:   ${color(t('lifecycle.turnAccessible'), ANSI.green)}`);
        }
      }
    }
  }

  push();
  push(color(`  ${t('lifecycle.dashboardUpdated', { time: new Date().toLocaleTimeString() })}`, ANSI.dim));
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
  if (!requirePm2('consultar')) return;

  const watch = args.includes('--watch') || args.includes('-w');

  if (watch) {
    const target = await resolveTargetServer(globalArgs, 'monitorar');

    // --watch mode: real-time dashboard that refreshes every 2s (#441)
    // Hide cursor for cleaner output, clear screen once
    process.stdout.write('\x1b[?25l\x1b[2J');
    // Seed TURN cache before first render, then render
    const seed = readServerStatus(target.dataDir);
    await refreshTurnCache(target.dataDir);
    await refreshHealthCache(target, seed);
    renderDashboard(target, seed);
    const interval = setInterval(() => {
      const snapshot = readServerStatus(target.dataDir);
      Promise.all([refreshTurnCache(target.dataDir), refreshHealthCache(target, snapshot)]).then(() =>
        renderDashboard(target, snapshot)
      );
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
    const target = await resolveTargetServer(globalArgs, 'consultar');
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

  printServerTable(servers);
  console.log();
  console.log(color(t('lifecycle.useStatusData'), ANSI.dim));
}
