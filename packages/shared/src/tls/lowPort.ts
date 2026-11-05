import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { AUTO_TLS_LOW_PORT_SYSCTL, AUTO_TLS_LOW_PORT_SYSCTL_FILE } from '../autoTls';
import { AutoTlsFailure } from './errors';

type Elevation = 'root' | 'sudo';

/** `sudo -n` never prompts, so a background process cannot hang waiting for a password. */
function detectElevation(): Elevation | null {
  if (os.platform() !== 'linux') return null;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'root';
  try {
    return spawnSync('sudo', ['-n', 'true'], { timeout: 5000 }).status === 0 ? 'sudo' : null;
  } catch {
    return null;
  }
}

function runPrivileged(elevation: Elevation, command: string[], timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const [bin, ...args] = elevation === 'sudo' ? ['sudo', '-n', ...command] : command;
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false, `"${command.join(' ')}" timed out.`);
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', (error) => finish(false, error.message));
    child.on('close', (code) => finish(code === 0, code === 0 ? '' : stderr.trim() || `exited with code ${code}`));
  });
}

/**
 * Lets unprivileged processes open port 80 on Linux, persistently, through
 * root or passwordless sudo. Only called after the owner agreed to it.
 */
export async function allowValidationPort(): Promise<void> {
  const elevation = detectElevation();
  if (!elevation) throw new AutoTlsFailure('privilege-unavailable', 'No root or passwordless sudo is available.');
  const persist = await runPrivileged(elevation,
    ['sh', '-c', `printf '%s\\n' '${AUTO_TLS_LOW_PORT_SYSCTL}' > ${AUTO_TLS_LOW_PORT_SYSCTL_FILE}`], 15_000);
  const apply = persist.ok ? await runPrivileged(elevation, ['sysctl', '-w', AUTO_TLS_LOW_PORT_SYSCTL], 15_000) : persist;
  if (!apply.ok) throw new AutoTlsFailure('privilege-unavailable', apply.detail);
}
