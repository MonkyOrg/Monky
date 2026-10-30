import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

/** What Windows answers while an antivirus, indexer or backup tool briefly holds the file being replaced. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

export function fileErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // A host that forbids blocking waits still gets the immediate retry.
  }
}

/** `fs.renameSync` that waits out the brief locks Windows tools put on a file. */
export function renameFileSync(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = fileErrorCode(error);
      if (!code || !BUSY_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      pause(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Makes the rename itself survive a power loss on POSIX; Windows cannot open a folder, which is fine there. */
function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Best effort.
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Already closed.
      }
    }
  }
}

/**
 * Replaces `target` so that a crash, a full disk or a file held by another
 * program leaves either the previous or the new contents, never a mix: the
 * bytes reach the disk in a temporary sibling first (fsync) and only a rename
 * publishes them. The temporary file is removed when anything fails.
 *
 * `data` may also be a sequence of pieces, written in order, so a large file
 * never has to sit in memory whole; a sequence that throws publishes nothing.
 * `mode` defaults to 0o600 (only this user can read it; Windows ignores it).
 */
export function writeFileAtomicSync(target: string, data: string | Uint8Array | Iterable<Uint8Array>, mode = 0o600): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    if (typeof data === 'string' || data instanceof Uint8Array) fs.writeFileSync(descriptor, data);
    else for (const piece of data) fs.writeFileSync(descriptor, piece);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    renameFileSync(temporary, target);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Already failing; the original error matters.
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Left behind only if the disk refuses even this.
    }
    throw error;
  }
  syncDirectory(directory);
}
