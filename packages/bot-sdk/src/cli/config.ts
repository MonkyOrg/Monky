import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '@monky/shared';
import {
  BOT_ECOSYSTEM_FILE,
  DEFAULT_MANUAL_SERVER_URL,
  DEFAULT_MARKETPLACE_PORT,
  DEFAULT_TOKEN_ENV,
  GENERATED_WRAPPER_FILE,
  UPDATER_ECOSYSTEM_FILE,
} from './constants';
import { ensurePrivateDirectory, readJsonFile, writePrivateJson } from './fs';
import {
  botEntryPath,
  isRecord,
  loadBotProject,
  type BotMode,
  type BotProject,
} from '../tooling/config';

export interface ManualBotConfig {
  mode: 'manual';
  botName: string;
  botDir: string;
  serverUrl: string;
  tokenEnv: string;
}

export interface MarketplaceBotConfig {
  mode: 'marketplace';
  botName: string;
  botDir: string;
  servePort: number;
  publicHost: string;
}

export type BotConfig = ManualBotConfig | MarketplaceBotConfig;

export interface CliInvocation {
  cwd: string;
  args: string[];
}

export interface CliContext {
  packageRoot: string;
  project: BotProject;
  cliName: string;
  displayName: string;
  version: string;
  homeDir: string;
  configFile: string;
  pm2Home: string;
  botEcosystemFile: string;
  updaterEcosystemFile: string;
  processName: string;
  updaterProcessName: string;
  runnerScript: string;
  updaterScript: string;
  cliInvocation: CliInvocation;
}

function stringValue(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const key = Object.keys(value).find((entry) => !allowed.includes(entry));
  if (key) throw new Error(`Unknown ${label} property: ${key}.`);
}

export function configHomeDirectory(cliName: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.MONKY_BOT_CLI_HOME ? path.resolve(env.MONKY_BOT_CLI_HOME) : os.homedir();
  return path.join(base, `.${cliName}`);
}

export function configFilePath(cliName: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configHomeDirectory(cliName, env), 'config.json');
}

export function defaultBotDir(context: CliContext): string {
  return path.join(context.homeDir, 'bot');
}

export function normalizeBotDir(value: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved)) throw new Error('The bot directory must resolve to an absolute path.');
  return resolved;
}

export function validateBotName(value: unknown): string {
  const name = stringValue(value, 'bot name', LIMITS.MAX_NICKNAME_LENGTH);
  if (name.length < LIMITS.MIN_NICKNAME_LENGTH) {
    throw new Error(`The bot name must contain at least ${LIMITS.MIN_NICKNAME_LENGTH} characters.`);
  }
  return name;
}

export function validateTokenEnv(value: unknown): string {
  const tokenEnv = stringValue(value, 'token environment variable', 100);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new Error('The token environment variable must use only A-Z, 0-9 and _.');
  }
  return tokenEnv;
}

export function validateServerUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(stringValue(value, 'server URL', 2048));
  } catch {
    throw new Error('The server URL must be a valid ws:// or wss:// URL.');
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('The server URL must be a valid ws:// or wss:// URL without embedded credentials.');
  }
  return url.toString();
}

export function validateServePort(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(stringValue(value, 'serve port', 16));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('The serve port must be an integer between 1 and 65535.');
  }
  return parsed;
}

export function validatePublicHost(value: unknown): string {
  const host = stringValue(value, 'public host', 255);
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(unwrapped);
  if (family && (family === 6 || host === unwrapped) && !unwrapped.includes('%')) return host;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    throw new Error('The public host must be a hostname or IP without a scheme or port.');
  }
  if (url.hostname !== host.toLowerCase() || url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The public host must be a hostname or IP without a scheme or port.');
  }
  return host;
}

function parseCommonConfig(raw: Record<string, unknown>): { botName: string; botDir: string } {
  return {
    botName: validateBotName(raw.botName),
    botDir: normalizeBotDir(stringValue(raw.botDir, 'config.botDir', 4096)),
  };
}

export function validateConfig(value: unknown, label = 'Bot config'): BotConfig {
  if (!isRecord(value)) throw new Error(`${label} must contain an object.`);
  rejectUnknown(value, ['mode', 'botName', 'botDir', 'serverUrl', 'tokenEnv', 'servePort', 'publicHost'], label);
  const common = parseCommonConfig(value);
  if (value.mode === 'manual') {
    return {
      mode: 'manual',
      botName: common.botName,
      botDir: common.botDir,
      serverUrl: validateServerUrl(value.serverUrl),
      tokenEnv: validateTokenEnv(value.tokenEnv),
    };
  }
  if (value.mode === 'marketplace') {
    return {
      mode: 'marketplace',
      botName: common.botName,
      botDir: common.botDir,
      servePort: validateServePort(value.servePort),
      publicHost: validatePublicHost(value.publicHost),
    };
  }
  throw new Error(`${label}.mode must be "manual" or "marketplace".`);
}

export function createCliContext(packageRoot: string, env: NodeJS.ProcessEnv = process.env): CliContext {
  const project = loadBotProject(packageRoot);
  const cliName = project.definition.cliName;
  const homeDir = configHomeDirectory(cliName, env);
  const wrapperPath = path.join(project.root, GENERATED_WRAPPER_FILE);
  const cliInvocation = fs.existsSync(wrapperPath) && fs.statSync(wrapperPath).isFile()
    ? { cwd: project.root, args: [wrapperPath] }
    : { cwd: project.root, args: [path.resolve(__dirname, '..', 'tools.js'), 'cli'] };
  return {
    packageRoot: project.root,
    project,
    cliName,
    displayName: project.definition.displayName,
    version: project.manifest.version,
    homeDir,
    configFile: path.join(homeDir, 'config.json'),
    pm2Home: path.join(homeDir, '.pm2'),
    botEcosystemFile: path.join(homeDir, BOT_ECOSYSTEM_FILE),
    updaterEcosystemFile: path.join(homeDir, UPDATER_ECOSYSTEM_FILE),
    processName: cliName,
    updaterProcessName: `${cliName}-updater`,
    runnerScript: path.resolve(__dirname, 'runner.js'),
    updaterScript: path.resolve(__dirname, 'updater.js'),
    cliInvocation,
  };
}

export function readConfigFile(file: string): BotConfig {
  return validateConfig(readJsonFile(file, 'The bot config file'));
}

export function readConfig(context: CliContext): BotConfig | null {
  return fs.existsSync(context.configFile) ? readConfigFile(context.configFile) : null;
}

export function writeConfig(context: CliContext, config: BotConfig): void {
  ensurePrivateDirectory(context.homeDir);
  writePrivateJson(context.configFile, config);
}

export function ensureModeSupported(context: CliContext, mode: BotMode): void {
  if (!context.project.definition.modes.includes(mode)) {
    throw new Error(`${context.displayName} does not support the ${mode} mode.`);
  }
}

function defaultBotName(context: CliContext): string {
  const name = context.displayName.slice(0, LIMITS.MAX_NICKNAME_LENGTH).replace(/[\uD800-\uDBFF]$/, '').trim();
  return name.length < LIMITS.MIN_NICKNAME_LENGTH ? `${name} Bot` : name;
}

export function manualConfig(
  context: CliContext,
  input: { botName?: string; botDir?: string; serverUrl?: string; tokenEnv?: string } = {}
): ManualBotConfig {
  ensureModeSupported(context, 'manual');
  return {
    mode: 'manual',
    botName: validateBotName(input.botName ?? defaultBotName(context)),
    botDir: normalizeBotDir(input.botDir ?? defaultBotDir(context)),
    serverUrl: validateServerUrl(input.serverUrl ?? DEFAULT_MANUAL_SERVER_URL),
    tokenEnv: validateTokenEnv(input.tokenEnv ?? DEFAULT_TOKEN_ENV),
  };
}

export function marketplaceConfig(
  context: CliContext,
  input: { botName?: string; botDir?: string; servePort?: number; publicHost?: string } = {}
): MarketplaceBotConfig {
  ensureModeSupported(context, 'marketplace');
  return {
    mode: 'marketplace',
    botName: validateBotName(input.botName ?? defaultBotName(context)),
    botDir: normalizeBotDir(input.botDir ?? defaultBotDir(context)),
    servePort: validateServePort(input.servePort ?? DEFAULT_MARKETPLACE_PORT),
    publicHost: validatePublicHost(input.publicHost ?? 'localhost'),
  };
}

export function sanitizeConfig(config: BotConfig): Record<string, unknown> {
  return config.mode === 'manual'
    ? {
      mode: config.mode,
      botName: config.botName,
      botDir: config.botDir,
      serverUrl: config.serverUrl,
      tokenEnv: config.tokenEnv,
    }
    : {
      mode: config.mode,
      botName: config.botName,
      botDir: config.botDir,
      servePort: config.servePort,
      publicHost: config.publicHost,
    };
}

export function resolveInstalledEntry(context: CliContext): string {
  return botEntryPath(context.project);
}
