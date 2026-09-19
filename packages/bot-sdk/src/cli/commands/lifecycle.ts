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
  validateBotToken,
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
  ensurePm2ForStart,
  findProcess,
  isPm2Available,
  listProcesses,
  requirePm2,
  restartBotProcess,
  saveProcessList,
  startOrRestart,
  stopProcess,
  streamLogs,
  updaterEnvironment,
  writeBotEcosystem,
} from '../pm2';
import { assertManifestPortAvailable, getManifestBindHost } from '../ports';
import { spawnCommand } from '../process';
import { createRuntimeEnvironment } from '../runner';
import { loadBotProject } from '../../tooling/config';
import { runNpm } from '../../tooling/process';
import { CliError, cliText } from '../locale';
import { updateSourceConfigCommand } from '../updateConfiguration';
import { updateCredentialCommand } from '../updateCredentials';
import { isInteractiveCliAccess } from '../locale';

function loadConfigOrThrow(context: CliContext): BotConfig {
  const config = readConfig(context);
  if (!config) throw new Error(cliText(context.locale,
    `Nenhuma configuração encontrada. Execute "${context.cliName} setup" primeiro.`,
    `No config found. Run "${context.cliName} setup" first.`));
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
      if (!value || value.startsWith('--')) throw new CliError('--lines requer um valor numérico.', '--lines requires a numeric value.');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) throw new CliError('--lines deve estar entre 1 e 10000.',
        '--lines must be between 1 and 10000.');
      lines = parsed;
      continue;
    }
    throw new CliError('Opção de logs desconhecida.', 'Unknown logs option.');
  }
  return { lines, follow };
}

function applyConfigChange(context: CliContext, config: BotConfig, key: string, value: string): BotConfig {
  if (key === 'mode') {
    if (value === 'manual') {
      return manualConfig(context, config.mode === 'manual' ? config : {
        botName: config.botName,
        botDir: config.botDir,
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
    throw new CliError('mode deve ser "manual" ou "marketplace".', 'mode must be "manual" or "marketplace".');
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
      ...(config.mode === 'manual' ? config : { botName: config.botName, botDir: config.botDir }),
      serverUrl: validateServerUrl(value),
    });
  }
  if (key === 'bot-token') {
    return manualConfig(context, {
      botName: config.botName,
      botDir: config.botDir,
      serverUrl: config.mode === 'manual' ? config.serverUrl : DEFAULT_MANUAL_SERVER_URL,
      botToken: validateBotToken(value),
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
  throw new CliError('Chave de configuração desconhecida.', 'Unknown config key.');
}

function normalizedConfigKey(key: string): string {
  const aliases: Record<string, string> = {
    botName: 'name',
    botDir: 'bot-dir',
    serverUrl: 'server-url',
    botToken: 'bot-token',
    tokenEnv: 'token-env',
    servePort: 'serve-port',
    publicHost: 'public-host',
  };
  return aliases[key] ?? key;
}

export async function startCommand(context: CliContext, args: string[]): Promise<void> {
  const foreground = args.includes('--foreground');
  const invalid = args.find((argument) => !['--foreground'].includes(argument));
  if (invalid) throw new CliError('Opção de start desconhecida.', 'Unknown start option.');
  const config = loadConfigOrThrow(context);
  const manualEntry = config.mode === 'manual' ? ensureRuntimeState(context, config) : null;
  const current = foreground ? null : findProcess(context);
  if (current?.pm2_env?.status === 'online') {
    console.log(cliText(context.locale,
      `${context.displayName} já está rodando (PID ${current.pid ?? 'desconhecido'}).`,
      `${context.displayName} is already running (PID ${current.pid ?? 'unknown'}).`));
    return;
  }
  if (config.mode === 'marketplace') {
    await assertManifestPortAvailable(config.servePort, context.cliName, getManifestBindHost(current?.pm2_env), context.locale);
  }
  const entry = manualEntry ?? ensureRuntimeState(context, config);
  if (foreground) {
    const child = spawnCommand(process.execPath, [context.runnerScript], {
      cwd: context.homeDir,
      env: {
        ...process.env,
        MONKY_BOT_CLI_CONFIG_FILE: context.configFile,
        MONKY_BOT_CLI_ENTRY: entry,
        MONKY_BOT_LOCALE: context.locale,
      },
      stdio: 'inherit',
    });
    await waitForForeground(child);
    return;
  }
  ensurePm2ForStart(context);
  startOrRestart(context, writeBotEcosystem(context, entry));
  saveProcessList(context);
  console.log(cliText(context.locale, `${context.displayName} iniciado em background.`, `${context.displayName} started in the background.`));
  console.log(cliText(context.locale, `Modo: ${config.mode}`, `Mode: ${config.mode}`));
  if (config.mode === 'manual') {
    console.log(cliText(context.locale, `Servidor: ${config.serverUrl}`, `Server: ${config.serverUrl}`));
  } else {
    const host = config.publicHost.includes(':') && !config.publicHost.startsWith('[')
      ? `[${config.publicHost}]` : config.publicHost;
    console.log(`Manifest: http://${host}:${config.servePort}/manifest`);
  }
  console.log(cliText(context.locale, `Comandos úteis: ${context.cliName} status, logs, restart, stop.`,
    `Useful commands: ${context.cliName} status, logs, restart, stop.`));
}

export function stopCommand(context: CliContext, args: string[]): void {
  if (args.length) throw new CliError('Opção de stop desconhecida.', 'Unknown stop option.');
  requirePm2(context, 'stop the bot');
  const processInfo = findProcess(context);
  if (!processInfo || processInfo.pm2_env?.status !== 'online') {
    console.log(cliText(context.locale, `${context.displayName} não está rodando.`, `${context.displayName} is not running.`));
    return;
  }
  stopProcess(context, context.processName);
  saveProcessList(context);
  console.log(cliText(context.locale, `${context.displayName} parado.`, `${context.displayName} stopped.`));
}

export async function restartCommand(context: CliContext, args: string[]): Promise<void> {
  const fresh = args.includes('--fresh');
  const invalid = args.find((argument) => !['--fresh'].includes(argument));
  if (invalid) throw new CliError('Opção de restart desconhecida.', 'Unknown restart option.');
  const config = loadConfigOrThrow(context);
  const entry = ensureRuntimeState(context, config);
  requirePm2(context, 'restart the bot');
  await restartBotProcess(context, config, entry, fresh);
  console.log(cliText(context.locale, `${context.displayName} reiniciado.`, `${context.displayName} restarted.`));
}

export function statusCommand(context: CliContext, args: string[]): void {
  if (args.length) throw new CliError('Opção de status desconhecida.', 'Unknown status option.');
  const config = readConfig(context);
  const processes = listProcesses(context);
  const processInfo = processes?.find((entry) => entry.name === context.processName) ?? null;
  console.log(`${context.displayName} — status`);
  if (processes === null) {
    console.log(cliText(context.locale, 'pm2 não está instalado neste ambiente.', 'pm2 is not installed in this environment.'));
  } else if (!processInfo) {
    console.log(cliText(context.locale, 'Processo em background: não registrado.', 'Background process: not registered.'));
  } else {
    console.log(cliText(context.locale, `Processo: ${processInfo.pm2_env?.status ?? 'desconhecido'}`,
      `Process: ${processInfo.pm2_env?.status ?? 'unknown'}`));
    if (processInfo.pid) console.log(`PID: ${processInfo.pid}`);
    if (processInfo.pm2_env?.pm_uptime) {
      const uptimeMs = Date.now() - processInfo.pm2_env.pm_uptime;
      console.log(`Uptime: ${Math.floor(uptimeMs / 3_600_000)}h ${Math.floor((uptimeMs % 3_600_000) / 60_000)}m`);
    }
    if (processInfo.monit?.memory !== undefined) {
      console.log(cliText(context.locale, `Memória: ${(processInfo.monit.memory / 1024 / 1024).toFixed(1)} MB`,
        `Memory: ${(processInfo.monit.memory / 1024 / 1024).toFixed(1)} MB`));
    }
    if (processInfo.monit?.cpu !== undefined) console.log(`CPU: ${processInfo.monit.cpu}%`);
    if (processInfo.pm2_env?.restart_time !== undefined) console.log(`Restarts: ${processInfo.pm2_env.restart_time}`);
  }
  if (!config) {
    console.log(cliText(context.locale, `Configuração: ausente (${context.configFile})`, `Configuration: missing (${context.configFile})`));
    return;
  }
  console.log(cliText(context.locale, 'Configuração:', 'Configuration:'));
  console.log(JSON.stringify(sanitizeConfig(config), null, 2));
}

export function logsCommand(context: CliContext, args: string[]): void {
  requirePm2(context, 'read bot logs');
  const processInfo = findProcess(context);
  if (!processInfo) throw new CliError(`Nenhum processo em background está registrado para ${context.cliName}.`,
    `No background process is registered for ${context.cliName}.`);
  const { lines, follow } = parseLogsOptions(args);
  streamLogs(context, lines, follow);
}

export async function configCommand(context: CliContext, args: string[]): Promise<void> {
  if (!args.length && isInteractiveCliAccess(['config'])) {
    const { configurationMenu } = await import('../menu');
    await configurationMenu(context);
    return;
  }
  if (args[0] === 'update-token') {
    await updateCredentialCommand(context, args.slice(1));
    return;
  }
  if (args[0] === 'update-source') {
    updateSourceConfigCommand(context, args.slice(1));
    return;
  }
  if (!args.length || args[0] === 'show') {
    const config = readConfig(context);
    if (!config) {
      console.log(cliText(context.locale, `Nenhuma configuração encontrada em ${context.configFile}.`,
        `No configuration found at ${context.configFile}.`));
      return;
    }
    console.log(JSON.stringify(sanitizeConfig(config), null, 2));
    return;
  }
  if (args[0] !== 'set') throw new CliError('Subcomando de config desconhecido.', 'Unknown config subcommand.');
  const config = loadConfigOrThrow(context);
  const key = normalizedConfigKey(args[1] ?? '');
  const value = args.slice(2).join(' ').trim();
  if (!key || !value) {
    throw new CliError(`Uso: ${context.cliName} config set <mode|botName|botDir|serverUrl|botToken|tokenEnv|servePort|publicHost> <valor>`,
      `Usage: ${context.cliName} config set <mode|botName|botDir|serverUrl|botToken|tokenEnv|servePort|publicHost> <value>`);
  }
  const next = applyConfigChange(context, config, key, value);
  if (next.mode === 'marketplace' &&
      (config.mode !== 'marketplace' || next.servePort !== config.servePort)) {
    await assertManifestPortAvailable(next.servePort, context.cliName, undefined, context.locale);
  }
  writeConfig(context, next);
  console.log(cliText(context.locale, 'Configuração atualizada.', 'Configuration updated.'));
  console.log(cliText(context.locale, `Reinicie o bot para aplicar: ${context.cliName} restart`,
    `Restart the bot to apply: ${context.cliName} restart`));
}

export function autoUpdateStatusCommand(context: CliContext): void {
  const processes = listProcesses(context);
  if (processes === null) {
    console.log(cliText(context.locale, 'Auto-update: pm2 indisponível.', 'Auto-update: pm2 unavailable.'));
    return;
  }
  const updater = processes.find((entry) => entry.name === context.updaterProcessName);
  if (!updater) {
    console.log(cliText(context.locale, 'Auto-update: desativado.', 'Auto-update: disabled.'));
    return;
  }
  const env = updaterEnvironment(updater);
  console.log(cliText(context.locale, 'Auto-update: ativado.', 'Auto-update: enabled.'));
  if (typeof env.MONKY_BOT_CLI_SCHEDULE === 'string') {
    console.log(cliText(context.locale, `Horário: ${env.MONKY_BOT_CLI_SCHEDULE}`, `Schedule: ${env.MONKY_BOT_CLI_SCHEDULE}`));
  }
  if (typeof env.MONKY_BOT_CLI_INCLUDE_BETA === 'string') {
    console.log(cliText(context.locale,
      `Canal: ${env.MONKY_BOT_CLI_INCLUDE_BETA === 'true' ? 'beta' : 'stable'}`,
      `Channel: ${env.MONKY_BOT_CLI_INCLUDE_BETA === 'true' ? 'beta' : 'stable'}`));
  }
}
