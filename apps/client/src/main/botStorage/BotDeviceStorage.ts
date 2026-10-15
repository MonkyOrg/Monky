import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BOT_STORAGE_LIMITS, botDeviceStorageFileSchema, botDeviceStorageScopeSchema, botStorageKeySchema, botStorageLevel,
  botStoragePrefixSchema, botStorageQuotaSchema,
  type BotDeviceStorageDecision, type BotDeviceStorageEntry, type BotDeviceStorageFailure, type BotDeviceStorageFile,
  type BotDeviceStorageKeyInfo, type BotDeviceStorageScope, type BotDeviceStorageValue, type BotStorageUsage,
} from '@monky/shared';
import { localToolDirectory, localToolStat, missingLocalToolFile, readLocalToolFile, removeLocalToolTree } from '../localExecution/localToolsStorage';

const INDEX = 'scope.json';
const OBJECTS = 'objects';
const INDEX_BYTES = 2 * 1024 * 1024;
const SCOPE_ID = /^[a-f0-9]{64}$/;

export class BotDeviceStorageError extends Error {
  constructor(readonly reason: BotDeviceStorageFailure, options?: { cause?: unknown }) {
    super(`Bot storage on this computer failed: ${reason}`, options);
  }
}

type IndexEntry = BotDeviceStorageFile['objects'][number];

interface ScopeState {
  id: string;
  scope: BotDeviceStorageScope;
  decision: BotDeviceStorageDecision;
  maxBytes: number;
  objects: Map<string, IndexEntry>;
  /** False until something was saved: reading or opening a miniapp never creates folders. */
  persisted: boolean;
  /** The last write did not fit; the bot shows as full until space is freed or added. */
  refused: boolean;
  updatedAt: number;
}

/** Same tuple as the bot preferences of a person: server address, server, account and bot. */
export function botDeviceStorageScopeId(scope: BotDeviceStorageScope): string {
  const url = new URL(scope.serverUrl);
  return createHash('sha256')
    .update(JSON.stringify([url.origin, url.pathname, scope.serverId, scope.userId, scope.botId]))
    .digest('hex');
}

export function isBotDeviceStorageScopeId(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_ID.test(value);
}

function failure(error: unknown): BotDeviceStorageError {
  return error instanceof BotDeviceStorageError ? error : new BotDeviceStorageError('failed', { cause: error });
}

/**
 * What bots keep on this computer through their miniapps, one folder per server,
 * account and bot. Keys are only names inside an index: files get random names, so
 * no key can reach a path. Every scope is serialized, and the index is replaced
 * atomically after the new object reached the disk.
 */
export class BotDeviceStorage {
  private root: string;
  private ready: Promise<void> | null = null;
  private readonly states = new Map<string, ScopeState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(root: string, private readonly changed: (scopeId: string) => void = () => undefined) {
    if (!path.isAbsolute(root)) throw new BotDeviceStorageError('invalid');
    this.root = root;
  }

  async entry(input: BotDeviceStorageScope): Promise<BotDeviceStorageEntry> {
    const scope = this.scope(input);
    return this.serial(scope.id, async () => this.toEntry(await this.state(scope.id, scope.value)));
  }

  async list(): Promise<BotDeviceStorageEntry[]> {
    await this.initialize();
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      throw failure(error);
    }
    const entries: BotDeviceStorageEntry[] = [];
    for (const id of names.filter(isBotDeviceStorageScopeId).slice(0, BOT_STORAGE_LIMITS.deviceScopes)) {
      try {
        const state = await this.serial(id, () => this.state(id));
        if (state) entries.push(this.toEntry(state));
      } catch (error) {
        console.warn('[Bot storage] Ignoring an unreadable storage folder.', error);
      }
    }
    return entries.sort((first, second) => second.updatedAt - first.updatedAt);
  }

  /** Access is decided from the stored preference on every operation. */
  async decision(scopeId: string): Promise<BotDeviceStorageDecision> {
    if (!isBotDeviceStorageScopeId(scopeId)) return 'never';
    return this.serial(scopeId, async () => (await this.state(scopeId))?.decision ?? 'ask');
  }

  async setDecision(input: BotDeviceStorageScope, decision: BotDeviceStorageDecision): Promise<BotDeviceStorageEntry> {
    const scope = this.scope(input);
    return this.mutate(scope.id, async () => {
      const state = await this.state(scope.id, scope.value);
      return this.toEntry(await this.save({ ...state, scope: scope.value, decision, updatedAt: Date.now() }));
    });
  }

  async setQuota(input: BotDeviceStorageScope, maxBytes: number): Promise<BotDeviceStorageEntry> {
    const scope = this.scope(input);
    const quota = botStorageQuotaSchema.safeParse(maxBytes);
    if (!quota.success) throw new BotDeviceStorageError('invalid');
    return this.mutate(scope.id, async () => {
      const state = await this.state(scope.id, scope.value);
      return this.toEntry(await this.save({ ...state, scope: scope.value, maxBytes: quota.data, refused: false, updatedAt: Date.now() }));
    });
  }

  /** Deletes the objects and keeps the person's preference for this bot. */
  async clear(scopeId: string): Promise<void> {
    if (!isBotDeviceStorageScopeId(scopeId)) throw new BotDeviceStorageError('invalid');
    return this.mutate(scopeId, async () => {
      const state = await this.state(scopeId);
      if (!state) return;
      const files = [...state.objects.values()].map((entry) => entry.file);
      await this.save({ ...state, objects: new Map(), refused: false, updatedAt: Date.now() });
      for (const file of files) await this.removeObject(scopeId, file);
    });
  }

  /** Deletes the objects and the preferences, as if the bot had never stored anything here. */
  async forget(scopeId: string): Promise<void> {
    if (!isBotDeviceStorageScopeId(scopeId)) throw new BotDeviceStorageError('invalid');
    return this.mutate(scopeId, async () => {
      await this.initialize();
      this.states.delete(scopeId);
      try {
        await removeLocalToolTree(this.root, path.join(this.root, scopeId));
      } catch (error) {
        throw failure(error);
      }
    });
  }

  async get(input: BotDeviceStorageScope, keyInput: string): Promise<{ value: BotDeviceStorageValue | null; usage: BotStorageUsage }> {
    const scope = this.scope(input);
    const key = this.key(keyInput);
    return this.serial(scope.id, async () => {
      const state = await this.state(scope.id, scope.value);
      const entry = state.objects.get(key);
      if (!entry) return { value: null, usage: this.usageOf(state) };
      const bytes = entry.sizeBytes === 0 ? Buffer.alloc(0) : await this.readObject(scope.id, entry.file, entry.sizeBytes);
      const value: BotDeviceStorageValue = entry.kind === 'text'
        ? { kind: 'text', text: bytes.toString('utf8') } : { kind: 'bytes', bytes: new Uint8Array(bytes) };
      return { value, usage: this.usageOf(state) };
    });
  }

  async set(input: BotDeviceStorageScope, keyInput: string, value: BotDeviceStorageValue): Promise<BotStorageUsage> {
    const scope = this.scope(input);
    const key = this.key(keyInput);
    const bytes = value.kind === 'text'
      ? Buffer.from(value.text, 'utf8') : Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength);
    if (bytes.byteLength > BOT_STORAGE_LIMITS.objectBytes) throw new BotDeviceStorageError('invalid');
    return this.mutate(scope.id, async () => {
      const state = await this.state(scope.id, scope.value);
      const previous = state.objects.get(key);
      const usage = this.usageOf(state);
      if (usage.usedBytes - (previous?.sizeBytes ?? 0) + bytes.byteLength > state.maxBytes ||
          (!previous && state.objects.size >= BOT_STORAGE_LIMITS.deviceObjects)) {
        if (!state.refused) {
          state.refused = true;
          this.changed(scope.id);
        }
        throw new BotDeviceStorageError('quota');
      }
      await this.requireRoom(state);
      const file = await this.writeObject(scope.id, bytes);
      const objects = new Map(state.objects);
      objects.set(key, { key, file, sizeBytes: bytes.byteLength, kind: value.kind, updatedAt: Date.now() });
      let saved: ScopeState;
      try {
        saved = await this.save({ ...state, scope: scope.value, objects, refused: false, updatedAt: Date.now() });
      } catch (error) {
        await this.removeObject(scope.id, file);
        throw error;
      }
      if (previous) await this.removeObject(scope.id, previous.file);
      return this.usageOf(saved);
    });
  }

  async remove(input: BotDeviceStorageScope, keyInput: string): Promise<{ removed: boolean; usage: BotStorageUsage }> {
    const scope = this.scope(input);
    const key = this.key(keyInput);
    return this.mutate(scope.id, async () => {
      const state = await this.state(scope.id, scope.value);
      const previous = state.objects.get(key);
      if (!previous) return { removed: false, usage: this.usageOf(state) };
      const objects = new Map(state.objects);
      objects.delete(key);
      const saved = await this.save({ ...state, objects, refused: false, updatedAt: Date.now() });
      await this.removeObject(scope.id, previous.file);
      return { removed: true, usage: this.usageOf(saved) };
    });
  }

  async keys(input: BotDeviceStorageScope, prefixInput = ''): Promise<{ keys: BotDeviceStorageKeyInfo[]; usage: BotStorageUsage }> {
    const scope = this.scope(input);
    const prefix = botStoragePrefixSchema.safeParse(prefixInput);
    if (!prefix.success) throw new BotDeviceStorageError('invalid');
    return this.serial(scope.id, async () => {
      const state = await this.state(scope.id, scope.value);
      const keys = [...state.objects.values()].filter((entry) => entry.key.startsWith(prefix.data))
        .sort((first, second) => first.key < second.key ? -1 : first.key > second.key ? 1 : 0)
        .map(({ key, sizeBytes, updatedAt }) => ({ key, sizeBytes, updatedAt }));
      return { keys, usage: this.usageOf(state) };
    });
  }

  async usage(input: BotDeviceStorageScope): Promise<BotStorageUsage> {
    const scope = this.scope(input);
    return this.serial(scope.id, async () => this.usageOf(await this.state(scope.id, scope.value)));
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
  }

  private scope(input: BotDeviceStorageScope): { id: string; value: BotDeviceStorageScope } {
    const parsed = botDeviceStorageScopeSchema.safeParse(input);
    if (!parsed.success) throw new BotDeviceStorageError('invalid');
    return { id: botDeviceStorageScopeId(parsed.data), value: parsed.data };
  }

  private key(input: string): string {
    const parsed = botStorageKeySchema.safeParse(input);
    if (!parsed.success) throw new BotDeviceStorageError('invalid');
    return parsed.data;
  }

  private usageOf(state: ScopeState): BotStorageUsage {
    let usedBytes = 0;
    for (const entry of state.objects.values()) usedBytes += entry.sizeBytes;
    return {
      usedBytes, maxBytes: state.maxBytes, objectCount: state.objects.size, maxObjects: BOT_STORAGE_LIMITS.deviceObjects,
      level: botStorageLevel(usedBytes, state.maxBytes, state.refused),
    };
  }

  private toEntry(state: ScopeState): BotDeviceStorageEntry {
    return { id: state.id, scope: { ...state.scope }, decision: state.decision, usage: this.usageOf(state), updatedAt: state.updatedAt };
  }

  private initialize(): Promise<void> {
    if (!this.ready) {
      const loading = (async () => {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        this.root = await fs.realpath(this.root);
        await localToolDirectory(this.root);
      })();
      this.ready = loading;
      loading.catch(() => { if (this.ready === loading) this.ready = null; });
    }
    return this.ready.catch((error: unknown) => { throw failure(error); });
  }

  /** Without `fallback`, an unknown scope is null; with it, a default that is saved only on the first change. */
  private state(id: string): Promise<ScopeState | null>;
  private state(id: string, fallback: BotDeviceStorageScope): Promise<ScopeState>;
  private async state(id: string, fallback?: BotDeviceStorageScope): Promise<ScopeState | null> {
    await this.initialize();
    const cached = this.states.get(id);
    if (cached) return cached;
    const directory = path.join(this.root, id);
    let loaded: ScopeState | null = null;
    try {
      if (await localToolStat(directory)) {
        await localToolDirectory(directory);
        if (await localToolStat(path.join(directory, INDEX))) {
          const file = await readLocalToolFile(this.root, path.join(directory, INDEX), INDEX_BYTES, undefined, true);
          const data = botDeviceStorageFileSchema.parse(JSON.parse(file.contents.toString('utf8')));
          if (botDeviceStorageScopeId(data.scope) !== id) throw new BotDeviceStorageError('failed');
          loaded = {
            id, scope: data.scope, decision: data.decision, maxBytes: data.maxBytes,
            objects: new Map(data.objects.map((entry) => [entry.key, entry])), persisted: true, refused: false, updatedAt: data.updatedAt,
          };
          await this.removeUnreferenced(loaded);
        } else {
          // The index is written last: without one, the first save stopped midway and nothing here was ever stored.
          // An unreadable index is different (it may come from a newer Monky) and fails closed instead.
          await removeLocalToolTree(this.root, directory);
        }
      }
    } catch (error) {
      throw failure(error);
    }
    if (loaded) {
      this.states.set(id, loaded);
      return loaded;
    }
    if (!fallback) return null;
    return {
      id, scope: fallback, decision: 'ask', maxBytes: BOT_STORAGE_LIMITS.deviceDefaultBytes, objects: new Map(),
      persisted: false, refused: false, updatedAt: Date.now(),
    };
  }

  /** Bounds how many server, account and bot folders one computer keeps. */
  private async requireRoom(state: ScopeState): Promise<void> {
    if (state.persisted || await localToolStat(path.join(this.root, state.id))) return;
    const names = await fs.readdir(this.root);
    if (names.filter(isBotDeviceStorageScopeId).length >= BOT_STORAGE_LIMITS.deviceScopes) throw new BotDeviceStorageError('quota');
  }

  private async save(state: ScopeState): Promise<ScopeState> {
    await this.requireRoom(state);
    const directory = path.join(this.root, state.id);
    try {
      await localToolDirectory(path.join(directory, OBJECTS), true);
      const data: BotDeviceStorageFile = {
        version: 1, scope: state.scope, decision: state.decision, maxBytes: state.maxBytes,
        objects: [...state.objects.values()], updatedAt: state.updatedAt,
      };
      const content = JSON.stringify(botDeviceStorageFileSchema.parse(data));
      await this.replaceFile(directory, `.${INDEX}-${randomUUID()}.tmp`, INDEX, content);
    } catch (error) {
      throw failure(error);
    }
    const saved = { ...state, persisted: true };
    this.states.set(state.id, saved);
    return saved;
  }

  private async writeObject(scopeId: string, bytes: Buffer): Promise<string> {
    const directory = path.join(this.root, scopeId, OBJECTS);
    const file = `${randomUUID()}.bin`;
    try {
      await localToolDirectory(directory, true);
      await this.replaceFile(directory, `${file}.tmp`, file, bytes);
    } catch (error) {
      throw failure(error);
    }
    return file;
  }

  /** Readers see the old file or the new one, never a partial write; a failed attempt leaves nothing behind. */
  private async replaceFile(directory: string, staging: string, target: string, contents: string | Buffer): Promise<void> {
    const staged = path.join(directory, staging);
    const handle = await fs.open(staged, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(staged, path.join(directory, target));
    } catch (error) {
      await this.removeFile(staged);
      throw error;
    }
  }

  private async readObject(scopeId: string, file: string, sizeBytes: number): Promise<Buffer> {
    try {
      const read = await readLocalToolFile(this.root, path.join(this.root, scopeId, OBJECTS, file),
        BOT_STORAGE_LIMITS.objectBytes, undefined, true);
      if (read.size !== sizeBytes) throw new BotDeviceStorageError('failed');
      return read.contents;
    } catch (error) {
      throw failure(error);
    }
  }

  private removeObject(scopeId: string, file: string): Promise<void> {
    return this.removeFile(path.join(this.root, scopeId, OBJECTS, file));
  }

  private async removeFile(filename: string): Promise<void> {
    try {
      await fs.unlink(filename);
    } catch (error) {
      if (!missingLocalToolFile(error)) console.warn('[Bot storage] Could not remove a file that is no longer used.', error);
    }
  }

  /** Files left by an interrupted write are not in the index and never count as usage. */
  private async removeUnreferenced(state: ScopeState): Promise<void> {
    const directory = path.join(this.root, state.id);
    for (const name of await this.names(directory)) {
      if (name.startsWith(`.${INDEX}-`) && name.endsWith('.tmp')) await this.removeFile(path.join(directory, name));
    }
    const referenced = new Set([...state.objects.values()].map((entry) => entry.file));
    for (const name of await this.names(path.join(directory, OBJECTS))) {
      if (!referenced.has(name)) await this.removeObject(state.id, name);
    }
  }

  private async names(directory: string): Promise<string[]> {
    try {
      return await fs.readdir(directory);
    } catch (error) {
      if (missingLocalToolFile(error)) return [];
      throw error;
    }
  }

  private mutate<T>(scopeId: string, operation: () => Promise<T>): Promise<T> {
    return this.serial(scopeId, operation).then((result) => {
      this.changed(scopeId);
      return result;
    });
  }

  private serial<T>(scopeId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BotDeviceStorageError('unavailable'));
    const previous = this.queues.get(scopeId) ?? Promise.resolve();
    const result = previous.then(operation, operation).catch((error: unknown) => { throw failure(error); });
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(scopeId, tail);
    void tail.then(() => { if (this.queues.get(scopeId) === tail) this.queues.delete(scopeId); });
    return result;
  }
}
