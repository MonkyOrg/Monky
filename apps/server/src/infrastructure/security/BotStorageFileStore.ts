import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../logger/Logger';

const FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Bytes of bot storage objects on the host's disk, one directory per bot. File
 * names are random, never derived from a key, so no key can address a path.
 *
 * The database is an in-memory sql.js snapshot written a few seconds after each
 * change. Files that stop being referenced are therefore removed only after that
 * window: a crash must never leave a saved row pointing at a deleted file. Files
 * left behind by a crash are removed by `reconcile` at the next start.
 */
export class BotStorageFileStore {
  readonly root: string;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(dataDir: string, private readonly discardDelayMs = 10_000) {
    this.root = path.join(dataDir, 'bot-storage');
  }

  async write(botId: string, bytes: Uint8Array): Promise<string> {
    const directory = this.directory(botId);
    await fs.mkdir(directory, { recursive: true });
    const filename = `${randomUUID()}.bin`;
    const temporary = path.join(directory, `${filename}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, path.join(directory, filename));
    } catch (error) {
      // Best effort: reconcile() removes whatever is left at the next start.
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return filename;
  }

  async read(botId: string, filename: string): Promise<Buffer | null> {
    if (!FILENAME.test(filename)) return null;
    try {
      return await fs.readFile(path.join(this.directory(botId), filename));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  discard(botId: string, filename: string): void {
    if (FILENAME.test(filename)) this.later(() => fs.rm(path.join(this.directory(botId), filename), { force: true }));
  }

  discardBot(botId: string): void {
    this.later(() => fs.rm(this.directory(botId), { recursive: true, force: true }));
  }

  /** Removes directories of bots that no longer exist and files no row references. */
  async reconcile(references: Map<string, Set<string>>): Promise<number> {
    const bots = new Map([...references.keys()].map((botId) => [path.basename(this.directory(botId)), botId]));
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      const target = path.join(this.root, entry.name);
      const botId = bots.get(entry.name);
      if (!entry.isDirectory() || botId === undefined) {
        await fs.rm(target, { recursive: true, force: true });
        removed++;
        continue;
      }
      const files = references.get(botId) ?? new Set<string>();
      for (const file of await fs.readdir(target)) {
        if (files.has(file)) continue;
        await fs.rm(path.join(target, file), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private directory(botId: string): string {
    return path.join(this.root, createHash('sha256').update(botId).digest('hex'));
  }

  private later(operation: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      operation().catch((error: unknown) => Logger.warn('BOT', 'Could not remove a discarded bot storage file.', error));
    }, this.discardDelayMs);
    timer.unref();
    this.timers.add(timer);
  }
}
