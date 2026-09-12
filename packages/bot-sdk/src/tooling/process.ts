import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface NpmOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'pipe' | 'inherit';
  timeout?: number;
}

export function npmCommand(): { command: string; args: string[] } {
  const npmCli = process.env.npm_execpath;
  if (npmCli?.endsWith('.js') && fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli] };
  const locations = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const directory of locations) {
    if (!directory) continue;
    const adjacent = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(adjacent)) return { command: process.execPath, args: [adjacent] };
    if (process.platform !== 'win32') {
      const executable = path.join(directory, 'npm');
      if (fs.existsSync(executable)) {
        const resolved = fs.realpathSync(executable);
        if (resolved.endsWith('.js')) return { command: process.execPath, args: [resolved] };
      }
    }
  }
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('Could not locate npm-cli.js. Install Node.js with npm before using bot build/update commands.');
}

/** Execute npm through its Node entry point on Windows, never a shell-built argument string. */
export function runNpm(args: string[], options: NpmOptions = {}): string {
  const npm = npmCommand();
  const result = spawnSync(npm.command, [...npm.args, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args[0] ?? ''} failed (${result.status ?? result.signal}).\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}
