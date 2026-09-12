import fs from 'node:fs';
import path from 'node:path';
import {
  defaultBotDir,
  ensureModeSupported,
  manualConfig,
  marketplaceConfig,
  readConfig,
  resolveInstalledEntry,
  sanitizeConfig,
  validateBotName,
  validatePublicHost,
  validateServerUrl,
  validateServePort,
  validateTokenEnv,
  writeConfig,
  normalizeBotDir,
  type BotConfig,
  type CliContext,
} from '../config';
import { DEFAULT_MANUAL_SERVER_URL, DEFAULT_MARKETPLACE_PORT } from '../constants';
import { loadOrCreateBotKeys } from '../keys';
import {
  deleteProcess,
  ensurePm2ForStart,
  findProcess,
  isPm2Available,
  listProcesses,
  requirePm2,
  saveProcessList,
  startOrRestart,
  stopProcess,
  streamLogs,
  updaterEnvironment,
  writeBotEcosystem,
} from '../pm2';
import { spawnCommand } from '../process';
import { createRuntimeEnvironment } from '../runner';
import { loadBotProject } from '../../tooling/config';
import { runNpm } from '../../tooling/process';

function loadConfigOrThrow(context: CliContext): BotConfig {
  const config = readConfig(context);
  if (!config) throw new Error(`No config found. Run "${context.cliName} setup" first.`);
  return config;
}

function resolveEntryForLaunch(context: CliContext): string {
  try {
    return resolveInstalledEntry(context);
  } catch (error: unknown) {
    if (!context.project.definition.buildScript) throw error instanceof Error ? error : new Error('The bot entry is unavailable.');
  }
  runNpm(['run', context.project.definition.buildScript], {
    cwd: context.project.root,
    stdio: 'inherit',
    timeout: 300_000,
  });
  return resolveInstalledEntry({ ...context, project: loadBotProject(context.project.root) });
}

function ensureRuntimeState(context: CliContext, config: BotConfig): string {
  ensureModeSupported(context, config.mode);
  fs.mkdirSync(config.botDir, { recursive: true, mode: 0o700 });
  const keys = loadOrCreateBotKeys(config.botDir);
  createRuntimeEnvironment(config, keys.publicKeyHex);
  return resolveEntryForLaunch(context);
}

async function waitForForeground(child: ReturnType<typeof spawnCommand>): Promise<void> {
  let interrupted = false;
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      interrupted = true;
      child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (interrupted) {
          resolve();
          return;
        }
        if (signal) {
          reject(new Error(`The bot terminated unexpectedly with signal ${signal}.`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`The bot exited with status ${code}.`));
          return;
        }
        resolve();
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

function parseLogsOptions(args: string[]): { lines: number; follow: boolean } {
  let lines = 50;
  let follow = true;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--no-follow') {
      follow = false;
      continue;
    }
    if (argument === '--lines') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--lines requires a numeric value.');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) throw new Error('--lines must be between 1 and 10000.');
      lines = parsed;
      continue;
    }
    throw new Error(`Unknown logs option: ${argument}`);
  }
  return { lines, follow };
}

function applyConfigChange(context: CliContext, config: BotConfig, key: string, value: string): BotConfig {
  if (key === 'mode') {
    if (value === 'manual') {
      return manualConfig(context, {
        botName: config.botName,
        botDir: config.botDir,
        serverUrl: config.mode === 'manual' ? config.serverUrl : DEFAULT_MANUAL_SERVER_URL,
        tokenEnv: config.mode === 'manual' ? config.tokenEnv : 'MONKY_BOT_TOKEN',
      });
    }
    if (value === 'marketplace') {
      return marketplaceConfig(context, {
        botName: config.botName,
        botDir: config.botDir,
        servePort: config.mode === 'marketplace' ? config.servePort : DEFAULT_MARKETPLACE_PORT,
        publicHost: config.mode === 'marketplace' ? config.publicHost : 'localhost',
      });
    }
    throw new Error('mode must be "manual" or "marketplace".');
  }
  if (key === 'name') {
    return config.mode === 'manual'
      ? { ...config, botName: validateBotName(value) }
      : { ...config, botName: validateBotName(value) };
  }
  if (key === 'bot-dir') {
    return config.mode === 'manual'
      ? { ...config, botDir: normalizeBotDir(value) }
      : { ...config, botDir: normalizeBotDir(value) };
  }
  if (key === 'server-url') {
    return manualConfig(context, {
      botName: config.botName,
      botDir: config.botDir,
      serverUrl: validateServerUrl(value),
      tokenEnv: config.mode === 'manual' ? config.tokenEnv : 'MONKY_BOT_TOKEN',
    });
  }
  if (key === 'token-env') {
    return manualConfig(context, {
      botName: config.botName,
      botDir: config.botDir,
      serverUrl: config.mode === 'manual' ? config.serverUrl : DEFAULT_MANUAL_SERVER_URL,
      tokenEnv: validateTokenEnv(value),
    });
  }
  if (key === 'serve-port') {
    return marketplaceConfig(context, {
      botName: config.botName,
      botDir: config.botDir,
      servePort: validateServePort(value),
      publicHost: config.mode === 'marketplace' ? config.publicHost : 'localhost',
    });
  }
  if (key === 'public-host') {
    return marketplaceConfig(context, {
      botName: config.botName,
      botDir: config.botDir,
      servePort: config.mode === 'marketplace' ? config.servePort : DEFAULT_MARKETPLACE_PORT,
      publicHost: validatePublicHost(value),
    });
  }
  throw new Error(`Unknown config key: ${key}`);
}

function normalizedConfigKey(key: string): string {
  const aliases: Record<string, string> = {
    botName: 'name',
    botDir: 'bot-dir',
    serverUrl: 'server-url',
    tokenEnv: 'token-env',
    servePort: 'serve-port',
    publicHost: 'public-host',
  };
  return aliases[key] ?? key;
}

export async function startCommand(context: CliContext, args: string[]): Promise<void> {
  const foreground = args.includes('--foreground');
  const invalid = args.find((argument) => !['--foreground'].includes(argument));
  if (invalid) throw new Error(`Unknown start option: ${invalid}`);
  const config = loadConfigOrThrow(context);
  const entry = ensureRuntimeState(context, config);
  if (foreground) {
    const child = spawnCommand(process.execPath, [context.runnerScript], {
      cwd: context.homeDir,
      env: {
        ...process.env,
        MONKY_BOT_CLI_CONFIG_FILE: context.configFile,
        MONKY_BOT_CLI_ENTRY: entry,
      },
      stdio: 'inherit',
    });
    await waitForForeground(child);
    return;
  }
  ensurePm2ForStart(context);
  const current = findProcess(context);
  if (current?.pm2_env?.status === 'online') {
    console.log(`${context.displayName} já está rodando (PID ${current.pid ?? 'desconhecido'}).`);
    return;
  }
  startOrRestart(context, writeBotEcosystem(context, entry));
  saveProcessList(context);
  console.log(`${context.displayName} iniciado em background.`);
}

export function stopCommand(context: CliContext, args: string[]): void {
  if (args.length) throw new Error(`Unknown stop option: ${args[0]}`);
  requirePm2(context, 'stop the bot');
  const processInfo = findProcess(context);
  if (!processInfo || processInfo.pm2_env?.status !== 'online') {
    console.log(`${context.displayName} não está rodando.`);
    return;
  }
  stopProcess(context, context.processName);
  saveProcessList(context);
  console.log(`${context.displayName} parado.`);
}

export function restartCommand(context: CliContext, args: string[]): void {
  const fresh = args.includes('--fresh');
  const invalid = args.find((argument) => !['--fresh'].includes(argument));
  if (invalid) throw new Error(`Unknown restart option: ${invalid}`);
  const config = loadConfigOrThrow(context);
  const entry = ensureRuntimeState(context, config);
  requirePm2(context, 'restart the bot');
  if (fresh) deleteProcess(context, context.processName);
  startOrRestart(context, writeBotEcosystem(context, entry));
  saveProcessList(context);
  console.log(`${context.displayName} reiniciado.`);
}

export function statusCommand(context: CliContext, args: string[]): void {
  if (args.length) throw new Error(`Unknown status option: ${args[0]}`);
  const config = readConfig(context);
  const processes = listProcesses(context);
  const processInfo = processes?.find((entry) => entry.name === context.processName) ?? null;
  console.log(`${context.displayName} — status`);
  if (processes === null) {
    console.log('pm2 não está instalado neste ambiente.');
  } else if (!processInfo) {
    console.log('Processo em background: não registrado.');
  } else {
    console.log(`Processo: ${processInfo.pm2_env?.status ?? 'unknown'}`);
    if (processInfo.pid) console.log(`PID: ${processInfo.pid}`);
    if (processInfo.pm2_env?.pm_uptime) {
      const uptimeMs = Date.now() - processInfo.pm2_env.pm_uptime;
      console.log(`Uptime: ${Math.floor(uptimeMs / 3_600_000)}h ${Math.floor((uptimeMs % 3_600_000) / 60_000)}m`);
    }
    if (processInfo.monit?.memory !== undefined) {
      console.log(`Memória: ${(processInfo.monit.memory / 1024 / 1024).toFixed(1)} MB`);
    }
    if (processInfo.monit?.cpu !== undefined) console.log(`CPU: ${processInfo.monit.cpu}%`);
  }
  if (!config) {
    console.log(`Configuração: ausente (${context.configFile})`);
    return;
  }
  console.log('Configuração:');
  console.log(JSON.stringify(sanitizeConfig(config), null, 2));
}

export function logsCommand(context: CliContext, args: string[]): void {
  requirePm2(context, 'read bot logs');
  const processInfo = findProcess(context);
  if (!processInfo) throw new Error(`No background process is registered for ${context.cliName}.`);
  const { lines, follow } = parseLogsOptions(args);
  streamLogs(context, lines, follow);
}

export function configCommand(context: CliContext, args: string[]): void {
  if (!args.length || args[0] === 'show') {
    const config = readConfig(context);
    if (!config) {
      console.log(`Nenhuma configuração encontrada em ${context.configFile}.`);
      return;
    }
    console.log(JSON.stringify(sanitizeConfig(config), null, 2));
    return;
  }
  if (args[0] !== 'set') throw new Error(`Unknown config subcommand: ${args[0]}`);
  const config = loadConfigOrThrow(context);
  const key = normalizedConfigKey(args[1] ?? '');
  const value = args.slice(2).join(' ').trim();
  if (!key || !value) {
    throw new Error(`Usage: ${context.cliName} config set <mode|name|bot-dir|server-url|token-env|serve-port|public-host> <value>`);
  }
  const next = applyConfigChange(context, config, key, value);
  writeConfig(context, next);
  console.log('Configuração atualizada.');
}

export function autoUpdateStatusCommand(context: CliContext): void {
  const processes = listProcesses(context);
  if (processes === null) {
    console.log('Auto-update: pm2 indisponível.');
    return;
  }
  const updater = processes.find((entry) => entry.name === context.updaterProcessName);
  if (!updater) {
    console.log('Auto-update: desativado.');
    return;
  }
  const env = updaterEnvironment(updater);
  console.log('Auto-update: ativado.');
  if (typeof env.MONKY_BOT_CLI_SCHEDULE === 'string') console.log(`Horário: ${env.MONKY_BOT_CLI_SCHEDULE}`);
  if (typeof env.MONKY_BOT_CLI_INCLUDE_BETA === 'string') {
    console.log(`Canal: ${env.MONKY_BOT_CLI_INCLUDE_BETA === 'true' ? 'beta' : 'acompanha a versão instalada'}`);
  }
}
