import fs from 'node:fs';
import { BOT_ECOSYSTEM_FILE, UPDATER_ECOSYSTEM_FILE } from './constants';
import { ensurePrivateDirectory, writePrivateFile } from './fs';
import { runNpm } from '../tooling/process';
import { pm2Command, runCommand, type CommandResult } from './process';
import { type CliContext } from './config';

export interface Pm2Process {
  name?: string;
  pid?: number;
  monit?: { memory?: number; cpu?: number };
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
    env?: Record<string, unknown>;
  };
}

function pm2Env(context: CliContext, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  ensurePrivateDirectory(context.pm2Home);
  return { ...env, PM2_HOME: context.pm2Home };
}

function ecosystemSource(app: Record<string, unknown>): string {
  return `module.exports = ${JSON.stringify({ apps: [app] }, null, 2)};\n`;
}

function runPm2(context: CliContext, args: readonly string[], options: { stdio?: 'pipe' | 'inherit'; timeout?: number } = {}): CommandResult {
  const executable = pm2Command();
  if (!executable) throw new Error('The pm2 Node entry point is unavailable. Install it with: npm install -g pm2');
  return runCommand(executable.command, [...executable.args, ...args], {
    env: pm2Env(context), stdio: options.stdio, timeout: options.timeout,
  });
}

export function isPm2Available(context: CliContext): boolean {
  const executable = pm2Command();
  if (!executable) return false;
  const result = runCommand(executable.command, [...executable.args, '--version'], {
    env: pm2Env(context), timeout: 10_000,
  });
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') return false;
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pm2 --version failed (${result.status ?? result.signal}).\n${result.stderr || result.stdout}`);
  }
  return true;
}

export function ensurePm2ForStart(context: CliContext): void {
  if (isPm2Available(context)) return;
  console.log('pm2 não encontrado. Instalando para o start em background...');
  runNpm(['install', '-g', 'pm2'], { stdio: 'inherit', env: pm2Env(context), timeout: 300_000 });
  if (!isPm2Available(context)) {
    throw new Error('pm2 was installed, but the executable is still unavailable in PATH.');
  }
}

export function requirePm2(context: CliContext, action: string): void {
  if (isPm2Available(context)) return;
  throw new Error(`pm2 is required to ${action}. Install it with: npm install -g pm2`);
}

export function listProcesses(context: CliContext): Pm2Process[] | null {
  if (!isPm2Available(context)) return null;
  const result = runPm2(context, ['jlist']);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pm2 jlist failed (${result.status ?? result.signal}).\n${result.stderr || result.stdout}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('pm2 returned invalid JSON for jlist.');
  }
  if (!Array.isArray(parsed)) throw new Error('pm2 jlist did not return an array.');
  return parsed as Pm2Process[];
}

export function findProcess(context: CliContext, name = context.processName): Pm2Process | null {
  return listProcesses(context)?.find((processInfo) => processInfo.name === name) ?? null;
}

export function writeBotEcosystem(context: CliContext, entry: string): string {
  ensurePrivateDirectory(context.homeDir);
  const file = context.botEcosystemFile;
  const app = {
    name: context.processName,
    script: context.runnerScript,
    interpreter: process.execPath,
    cwd: context.homeDir,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      MONKY_BOT_CLI_CONFIG_FILE: context.configFile,
      MONKY_BOT_CLI_ENTRY: entry,
    },
  };
  writePrivateFile(file, ecosystemSource(app));
  return file;
}

export function writeUpdaterEcosystem(context: CliContext, schedule: string, includeBeta: boolean): string {
  ensurePrivateDirectory(context.homeDir);
  const file = context.updaterEcosystemFile;
  const updateArgs = [...context.cliInvocation.args, 'update', '--yes'];
  const app = {
    name: context.updaterProcessName,
    script: context.updaterScript,
    interpreter: process.execPath,
    cwd: context.homeDir,
    autorestart: true,
    watch: false,
    env: {
      MONKY_BOT_CLI_PACKAGE_ROOT: context.packageRoot,
      MONKY_BOT_CLI_UPDATE_CWD: context.cliInvocation.cwd,
      MONKY_BOT_CLI_UPDATE_ARGS: JSON.stringify(updateArgs),
      MONKY_BOT_CLI_SCHEDULE: schedule,
      MONKY_BOT_CLI_INCLUDE_BETA: includeBeta ? 'true' : 'false',
    },
  };
  writePrivateFile(file, ecosystemSource(app));
  return file;
}

export function startOrRestart(context: CliContext, ecosystemFile: string): void {
  const result = runPm2(context, ['startOrRestart', ecosystemFile, '--update-env'], { stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pm2 startOrRestart failed (${result.status ?? result.signal}).`);
}

export function saveProcessList(context: CliContext): void {
  const result = runPm2(context, ['save']);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pm2 save failed (${result.status ?? result.signal}).`);
}

export function deleteProcess(context: CliContext, name: string): void {
  if (!isPm2Available(context)) return;
  const result = runPm2(context, ['delete', name]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = `${result.stdout}\n${result.stderr}`;
    if (!/not found|process or namespace/i.test(message)) {
      throw new Error(`pm2 delete ${name} failed (${result.status ?? result.signal}).\n${message}`);
    }
  }
}

export function stopProcess(context: CliContext, name: string): void {
  const result = runPm2(context, ['stop', name], { stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pm2 stop ${name} failed (${result.status ?? result.signal}).`);
}

export function streamLogs(context: CliContext, lines: number, follow: boolean): void {
  const args = ['logs', context.processName, '--lines', String(lines)];
  if (!follow) args.push('--nostream');
  const result = runPm2(context, args, { stdio: 'inherit', timeout: follow ? 0 : 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.signal === null && result.status !== 130) {
    throw new Error(`pm2 logs failed (${result.status}).`);
  }
}

export function updaterEnvironment(processInfo: Pm2Process): Record<string, unknown> {
  return processInfo.pm2_env?.env ?? {};
}

export function cleanupEcosystemFiles(context: CliContext): void {
  for (const file of [context.botEcosystemFile, context.updaterEcosystemFile]) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

export const PM2_FILES = { BOT_ECOSYSTEM_FILE, UPDATER_ECOSYSTEM_FILE };
