import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'pipe' | 'inherit';
  timeout?: number;
}

export function pm2Command(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } | null {
  if (platform !== 'win32') return { command: 'pm2', args: [] };
  const locations = [...(env.PATH ?? '').split(path.delimiter), path.dirname(process.execPath)];
  for (const directory of locations) {
    if (!directory) continue;
    const entry = path.join(directory, 'node_modules', 'pm2', 'bin', 'pm2');
    if (fs.existsSync(entry) && fs.statSync(entry).isFile()) {
      return { command: process.execPath, args: [entry] };
    }
  }
  return null;
}

export function runCommand(command: string, args: readonly string[] = [], options: CommandOptions = {}): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  } satisfies SpawnSyncOptions);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

export function spawnCommand(command: string, args: readonly string[] = [], options: CommandOptions = {}): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: options.stdio === 'inherit' ? 'inherit' : 'pipe',
    windowsHide: true,
  } satisfies SpawnOptions);
}

export function commandExists(command: string, args: readonly string[] = ['--version'], env: NodeJS.ProcessEnv = process.env): boolean {
  const result = runCommand(command, args, { env, timeout: 10_000 });
  return !result.error && result.status === 0;
}
