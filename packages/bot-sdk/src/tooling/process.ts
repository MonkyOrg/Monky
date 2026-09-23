import { spawnSync } from 'node:child_process';
import { npmCommand } from './install';

export { npmCommand } from './install';

export interface NpmOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'pipe' | 'inherit';
  timeout?: number;
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
