import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LIMITS,
  recentSoundEntrySchema,
  type RecentSoundDownload,
  type RecentSoundEntry,
  type RecentSoundMimeType,
} from '@monky/shared';

interface StoredRecentSound extends RecentSoundEntry {
  hash: string;
}

export class RecentSoundCacheService {
  private readonly root: string;
  private readonly blobRoot: string;
  private readonly indexPath: string;
  private entries: StoredRecentSound[] = [];
  private initialized = false;
  private enabled = false;
  private limit: number = LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT;
  private tail: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly maxTotalBytes = LIMITS.RECENT_SOUND_CACHE_MAX_BYTES) {
    this.root = path.join(dataDir, 'recent-sounds');
    this.blobRoot = path.join(this.root, 'blobs');
    this.indexPath = path.join(this.root, 'index.json');
  }

  public initialize(): Promise<{ recoveredCorruptIndex: boolean }> {
    return this.serial(() => this.load());
  }

  public list(): Promise<RecentSoundEntry[]> {
    return this.serial(async () => {
      await this.ensureInitialized();
      return this.entries.map(({ hash: _hash, ...entry }) => ({ ...entry }));
    });
  }

  public record(input: {
    soundName: string;
    mimeType: RecentSoundMimeType;
    bytes: Buffer;
    userId: string;
    userName: string;
    playedAt?: number;
  }): Promise<RecentSoundEntry | null> {
    return this.serial(async () => {
      await this.ensureInitialized();
      if (!this.enabled) return null;
      if (input.bytes.length < 1 || input.bytes.length > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) {
        throw new RangeError('Recent sound bytes exceed the allowed size.');
      }
      const hash = createHash('sha256').update(input.bytes).digest('hex');
      const blobPath = this.blobPath(hash, input.mimeType);
      await fs.mkdir(this.blobRoot, { recursive: true });
      let createdBlob = false;
      try {
        await fs.writeFile(blobPath, input.bytes, { flag: 'wx' });
        createdBlob = true;
      } catch (error) {
        if (!this.isCode(error, 'EEXIST')) throw error;
      }
      const entry: StoredRecentSound = {
        id: this.entries.find(candidate => candidate.hash === hash)?.id ?? randomUUID(),
        soundName: input.soundName.trim().slice(0, 100),
        mimeType: input.mimeType,
        sizeBytes: input.bytes.length,
        playedAt: input.playedAt ?? Date.now(),
        userId: input.userId,
        userName: input.userName.trim().slice(0, 100),
        hash,
      };
      const { hash: _storedHash, ...publicEntry } = entry;
      recentSoundEntrySchema.parse(publicEntry);
      const previous = this.entries.map(candidate => ({ ...candidate }));
      const replaced = this.entries.filter(candidate => candidate.hash === hash);
      this.entries = this.entries.filter(candidate => candidate.hash !== hash);
      this.entries.unshift(entry);
      const removed = [...replaced.slice(1), ...this.trim(this.limit)];
      try {
        await this.persist();
      } catch (error) {
        this.entries = previous;
        if (createdBlob && !previous.some(candidate => candidate.hash === hash)) {
          try {
            await fs.unlink(blobPath);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Could not persist or roll back a recent sound.');
          }
        }
        throw error;
      }
      await this.removeUnreferenced(removed);
      return publicEntry;
    });
  }

  public download(id: string): Promise<RecentSoundDownload | null> {
    return this.serial(async () => {
      await this.ensureInitialized();
      const stored = this.entries.find(entry => entry.id === id);
      if (!stored) return null;
      const bytes = await fs.readFile(this.blobPath(stored.hash, stored.mimeType));
      const { hash: _hash, ...entry } = stored;
      return { ...entry, audioBase64: bytes.toString('base64') };
    });
  }

  public configure(enabled: boolean, limit: number): Promise<{ cleanupError?: unknown }> {
    return this.serial(async () => {
      await this.ensureInitialized();
      const normalizedLimit = this.validateLimit(limit);
      const previous = this.entries.map(entry => ({ ...entry }));
      const removed = enabled ? this.trim(normalizedLimit) : this.entries.splice(0);
      try {
        await this.persist();
      } catch (error) {
        this.entries = previous;
        throw error;
      }
      this.enabled = enabled;
      this.limit = normalizedLimit;
      try {
        await this.removeUnreferenced(removed);
        return {};
      } catch (cleanupError) {
        return { cleanupError };
      }
    });
  }

  private async load(): Promise<{ recoveredCorruptIndex: boolean }> {
    await fs.mkdir(this.blobRoot, { recursive: true });
    let recoveredCorruptIndex = false;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1
        || !('entries' in parsed) || !Array.isArray(parsed.entries)) throw new Error('Invalid recent-sound index.');
      this.entries = parsed.entries.flatMap((candidate): StoredRecentSound[] => {
        if (!candidate || typeof candidate !== 'object' || !('hash' in candidate)
          || typeof candidate.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.hash)) return [];
        const { hash: _hash, ...publicCandidate } = candidate as StoredRecentSound;
        const parsedEntry = recentSoundEntrySchema.safeParse(publicCandidate);
        return parsedEntry.success ? [{ ...parsedEntry.data, hash: candidate.hash }] : [];
      });
    } catch (error) {
      if (!this.isCode(error, 'ENOENT')) {
        recoveredCorruptIndex = true;
        await fs.rename(this.indexPath, `${this.indexPath}.corrupt-${Date.now()}`).catch(() => undefined);
      }
      this.entries = [];
    }
    const verified: StoredRecentSound[] = [];
    const seenHashes = new Set<string>();
    for (const entry of this.entries) {
      if (seenHashes.has(entry.hash)) continue;
      const stat = await fs.stat(this.blobPath(entry.hash, entry.mimeType)).catch(() => null);
      if (stat?.isFile() && stat.size === entry.sizeBytes) {
        verified.push(entry);
        seenHashes.add(entry.hash);
      }
    }
    this.entries = verified;
    this.initialized = true;
    await this.persist();
    await this.removeUnknownBlobs();
    return { recoveredCorruptIndex };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.load();
  }

  private trim(limit: number): StoredRecentSound[] {
    const removed: StoredRecentSound[] = [];
    while (this.entries.length > limit || this.uniqueBytes() > this.maxTotalBytes) {
      const entry = this.entries.pop();
      if (entry) removed.push(entry);
    }
    return removed;
  }

  private uniqueBytes(): number {
    const unique = new Map<string, number>();
    for (const entry of this.entries) unique.set(entry.hash, entry.sizeBytes);
    return [...unique.values()].reduce((total, size) => total + size, 0);
  }

  private async persist(): Promise<void> {
    const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }), 'utf8');
    await fs.rename(temporary, this.indexPath);
  }

  private async removeUnreferenced(candidates: StoredRecentSound[]): Promise<void> {
    const retained = new Set(this.entries.map(entry => entry.hash));
    const unique = new Map(candidates.map(entry => [entry.hash, entry]));
    await Promise.all([...unique.values()].filter(entry => !retained.has(entry.hash))
      .map(entry => fs.unlink(this.blobPath(entry.hash, entry.mimeType)).catch(error => {
        if (!this.isCode(error, 'ENOENT')) throw error;
      })));
  }

  private async removeUnknownBlobs(): Promise<void> {
    const retained = new Set(this.entries.map(entry => path.basename(this.blobPath(entry.hash, entry.mimeType))));
    const files = await fs.readdir(this.blobRoot, { withFileTypes: true });
    await Promise.all(files.filter(entry => entry.isFile() && !retained.has(entry.name))
      .map(entry => fs.unlink(path.join(this.blobRoot, entry.name))));
  }

  private blobPath(hash: string, _mimeType: RecentSoundMimeType): string {
    return path.join(this.blobRoot, `${hash}.audio`);
  }

  private validateLimit(limit: number): number {
    if (!Number.isSafeInteger(limit)
      || limit < LIMITS.RECENT_SOUND_CACHE_MIN_LIMIT
      || limit > LIMITS.RECENT_SOUND_CACHE_MAX_LIMIT) {
      throw new RangeError('Invalid recent sound cache limit.');
    }
    return limit;
  }

  private isCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
