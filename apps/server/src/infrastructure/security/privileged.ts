import { spawn, spawnSync, type ChildProcess } from 'child_process';
import os from 'os';

export type Elevation = 'root' | 'sudo';

/**
 * How the server can run a privileged command on Linux, or null when it cannot.
 *
 * `sudo -n` never prompts: it either works without a password or fails right
 * away. Prompting would hang a background task forever with nobody at the
 * terminal to answer (#431).
 */
export function detectElevation(): Elevation | null {
  if (os.platform() !== 'linux') return null;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'root';
  try {
    const probe = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 5000 });
    return probe.status === 0 ? 'sudo' : null;
  } catch {
    return null;
  }
}

/** Runs a command as root, without ever waiting on a password prompt. */
export function runPrivileged(
  elevation: Elevation,
  command: string[],
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> {
  const [bin, ...args] = elevation === 'sudo' ? ['sudo', '-n', ...command] : command;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Keeps apt from stopping to ask questions nobody is there to answer.
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      });
    } catch (error) {
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false, `O comando "${command.join(' ')}" excedeu o tempo limite.`);
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      // Only the tail matters: package managers are chatty and the useful
      // line is the last one.
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => finish(false, error.message));
    child.on('close', (code) => {
      if (code === 0) finish(true, '');
      else finish(false, stderr.trim() || `saiu com código ${code}`);
    });
  });
}
