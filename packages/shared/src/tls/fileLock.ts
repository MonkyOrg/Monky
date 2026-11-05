import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FileLockOptions {
  /** A lock older than this is abandoned even if its process id looks alive (id reuse). */
  staleMs?: number;
  pollMs?: number;
}

interface LockOwner {
  id: string;
  pid: number;
  at: number;
}

const DEFAULT_STALE_MS = 15 * 60_000;
const UNREADABLE_GRACE_MS = 5_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * A lock shared by every process of the machine that renews the certificate:
 * the file's creation is the atomic step, and a lock left by a dead process,
 * or kept far longer than any issuance takes, is taken over.
 */
export class FileLock {
  private readonly staleMs: number;
  private readonly pollMs: number;

  constructor(private readonly file: string, options: FileLockOptions = {}) {
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.pollMs = options.pollMs ?? 500;
  }

  /** The release function, or null when another process holds the lock. */
  public tryAcquire(): (() => void) | null {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const owner: LockOwner = { id: randomUUID(), pid: process.pid, at: Date.now() };
      try {
        const descriptor = fs.openSync(this.file, 'wx', 0o600);
        try {
          fs.writeSync(descriptor, JSON.stringify(owner));
        } finally {
          fs.closeSync(descriptor);
        }
        return () => this.release(owner.id);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
        if (!this.isStale()) return null;
        fs.rmSync(this.file, { force: true });
      }
    }
    return null;
  }

  public async acquire(waitMs: number, signal?: AbortSignal): Promise<(() => void) | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const release = this.tryAcquire();
      if (release) return release;
      if (signal?.aborted || Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  private isStale(): boolean {
    let text: string;
    let modified: number;
    try {
      text = fs.readFileSync(this.file, 'utf8');
      modified = fs.statSync(this.file).mtimeMs;
    } catch {
      return true;
    }
    let owner: Partial<LockOwner> | null = null;
    try {
      owner = JSON.parse(text) as Partial<LockOwner>;
    } catch {
      owner = null;
    }
    if (!owner || typeof owner.pid !== 'number' || typeof owner.at !== 'number') {
      return Date.now() - modified > UNREADABLE_GRACE_MS;
    }
    return Date.now() - owner.at > this.staleMs || !processIsAlive(owner.pid);
  }

  private release(id: string): void {
    try {
      const owner = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LockOwner>;
      if (owner.id === id) fs.rmSync(this.file, { force: true });
    } catch {
      // Already gone or taken over.
    }
  }
}
