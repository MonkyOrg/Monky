import {
  BOT_STORAGE_LIMITS, botDeviceStorageFileSchema, botDeviceStorageRequestSchema, botDeviceStorageScopeIdSchema,
  botDeviceStorageScopeSchema, botStorageKeySchema, botStorageLevel, botStoragePrefixSchema, botStorageQuotaSchema,
  type BotDeviceStorageDecision, type BotDeviceStorageDocumentState, type BotDeviceStorageEntry, type BotDeviceStorageFailure,
  type BotDeviceStorageFile, type BotDeviceStorageGrant, type BotDeviceStorageKeyInfo, type BotDeviceStorageResponse,
  type BotDeviceStorageScope, type BotDeviceStorageStatus, type BotDeviceStorageValue, type BotStorageUsage,
} from './botStorage.js';

/**
 * What bots keep on the device running their miniapps (#861): one rule set for
 * the desktop, which writes files, and the web version, which writes IndexedDB.
 * Only the backend differs; decisions, quota, clearing and forgetting are here.
 */
export class BotDeviceStorageError extends Error {
  constructor(readonly reason: BotDeviceStorageFailure, options?: { cause?: unknown }) {
    super(`Bot storage on this computer failed: ${reason}`, options);
  }
}

export function isBotDeviceStorageScopeId(value: unknown): value is string {
  return botDeviceStorageScopeIdSchema.safeParse(value).success;
}

/**
 * The text hashed (SHA-256, hex) into a scope id: server address, server, account and bot,
 * like the bot preferences of a person. Display names never pick a different scope.
 */
export function botDeviceStorageScopeIdentity(scope: BotDeviceStorageScope): string {
  const url = new URL(scope.serverUrl);
  return JSON.stringify([url.origin, url.pathname, scope.serverId, scope.userId, scope.botId]);
}

/**
 * Where one platform keeps the scopes. Each scope has an index and objects named by
 * the engine (`<uuid>.bin`), so no key ever reaches a storage name. A scope whose
 * index was never written did not finish its first save and holds nothing.
 */
export interface BotDeviceStorageBackend {
  /** Lowercase hex SHA-256 of a scope identity. */
  scopeId(identity: string): string;
  /** A fresh random UUID. */
  randomId(): string;
  /** Prepares the store; called before every operation, so it must be cheap once done. */
  initialize(): Promise<void>;
  /** The names of every scope present, including unfinished ones; the engine ignores names that are not scope ids. */
  scopes(): Promise<string[]>;
  /** Whether anything at all is present for the scope. */
  hasScope(scopeId: string): Promise<boolean>;
  /** The parsed, still untrusted index, or null when there is none (leftovers of an unfinished first save are removed). */
  readIndex(scopeId: string): Promise<unknown>;
  /** Replaces the index atomically: readers see the old one or the new one. */
  writeIndex(scopeId: string, index: BotDeviceStorageFile): Promise<void>;
  /** Removes whatever an interrupted write left: objects not in `referenced` and staging copies. */
  removeUnreferenced(scopeId: string, referenced: ReadonlySet<string>): Promise<void>;
  /** Writes a new object atomically. */
  writeObject(scopeId: string, file: string, bytes: Uint8Array): Promise<void>;
  readObject(scopeId: string, file: string): Promise<Uint8Array>;
  /** Removes an object no longer referenced; one already gone is fine, and failures only warn. */
  removeObject(scopeId: string, file: string): Promise<void>;
  /** Removes the scope with everything in it. */
  removeScope(scopeId: string): Promise<void>;
}

type IndexEntry = BotDeviceStorageFile['objects'][number];

interface ScopeState {
  id: string;
  scope: BotDeviceStorageScope;
  decision: BotDeviceStorageDecision;
  maxBytes: number;
  objects: Map<string, IndexEntry>;
  /** False until something was saved: reading or opening a miniapp never creates anything. */
  persisted: boolean;
  /** The last write did not fit; the bot shows as full until space is freed or added. */
  refused: boolean;
  updatedAt: number;
}

function failure(error: unknown): BotDeviceStorageError {
  return error instanceof BotDeviceStorageError ? error : new BotDeviceStorageError('failed', { cause: error });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The storage rules, over an injected backend. Every scope is serialized, and the
 * index is replaced only after the new object was written.
 */
export class BotDeviceStorageEngine {
  private readonly states = new Map<string, ScopeState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly backend: BotDeviceStorageBackend,
    private readonly changed: (scopeId: string) => void = () => undefined,
  ) {}

  /** The id of a scope; throws `invalid` for one that does not validate. */
  scopeId(scope: BotDeviceStorageScope): string {
    return this.scope(scope).id;
  }

  async entry(input: BotDeviceStorageScope): Promise<BotDeviceStorageEntry> {
    const scope = this.scope(input);
    return this.serial(scope.id, async () => this.toEntry(await this.state(scope.id, scope.value)));
  }

  async list(): Promise<BotDeviceStorageEntry[]> {
    let names: string[];
    try {
      await this.backend.initialize();
      names = await this.backend.scopes();
    } catch (error) {
      throw failure(error);
    }
    const entries: BotDeviceStorageEntry[] = [];
    for (const id of names.filter(isBotDeviceStorageScopeId).slice(0, BOT_STORAGE_LIMITS.deviceScopes)) {
      try {
        const state = await this.serial(id, () => this.state(id));
        if (state) entries.push(this.toEntry(state));
      } catch (error) {
        console.warn('[Bot storage] Ignoring an unreadable storage scope.', error);
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
      for (const file of files) await this.backend.removeObject(scopeId, file);
    });
  }

  /** Deletes the objects and the preferences, as if the bot had never stored anything here. */
  async forget(scopeId: string): Promise<void> {
    if (!isBotDeviceStorageScopeId(scopeId)) throw new BotDeviceStorageError('invalid');
    return this.mutate(scopeId, async () => {
      await this.backend.initialize();
      this.states.delete(scopeId);
      await this.backend.removeScope(scopeId);
    });
  }

  async get(input: BotDeviceStorageScope, keyInput: string): Promise<{ value: BotDeviceStorageValue | null; usage: BotStorageUsage }> {
    const scope = this.scope(input);
    const key = this.key(keyInput);
    return this.serial(scope.id, async () => {
      const state = await this.state(scope.id, scope.value);
      const entry = state.objects.get(key);
      if (!entry) return { value: null, usage: this.usageOf(state) };
      let bytes: Uint8Array = new Uint8Array(0);
      if (entry.sizeBytes > 0) {
        bytes = await this.backend.readObject(scope.id, entry.file);
        if (bytes.byteLength !== entry.sizeBytes) throw new BotDeviceStorageError('failed');
      }
      const value: BotDeviceStorageValue = entry.kind === 'text'
        ? { kind: 'text', text: decoder.decode(bytes) } : { kind: 'bytes', bytes: new Uint8Array(bytes) };
      return { value, usage: this.usageOf(state) };
    });
  }

  async set(input: BotDeviceStorageScope, keyInput: string, value: BotDeviceStorageValue): Promise<BotStorageUsage> {
    const scope = this.scope(input);
    const key = this.key(keyInput);
    const bytes = value.kind === 'text' ? encoder.encode(value.text) : value.bytes;
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
      const file = `${this.backend.randomId()}.bin`;
      await this.backend.writeObject(scope.id, file, bytes);
      const objects = new Map(state.objects);
      objects.set(key, { key, file, sizeBytes: bytes.byteLength, kind: value.kind, updatedAt: Date.now() });
      let saved: ScopeState;
      try {
        saved = await this.save({ ...state, scope: scope.value, objects, refused: false, updatedAt: Date.now() });
      } catch (error) {
        await this.backend.removeObject(scope.id, file);
        throw error;
      }
      if (previous) await this.backend.removeObject(scope.id, previous.file);
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
      await this.backend.removeObject(scope.id, previous.file);
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

  /** Waits for what is running; anything asked afterwards fails as `unavailable`. Idempotent. */
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    this.states.clear();
  }

  private scope(input: BotDeviceStorageScope): { id: string; value: BotDeviceStorageScope } {
    const parsed = botDeviceStorageScopeSchema.safeParse(input);
    if (!parsed.success) throw new BotDeviceStorageError('invalid');
    return { id: this.backend.scopeId(botDeviceStorageScopeIdentity(parsed.data)), value: parsed.data };
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

  /** Without `fallback`, an unknown scope is null; with it, a default that is saved only on the first change. */
  private state(id: string): Promise<ScopeState | null>;
  private state(id: string, fallback: BotDeviceStorageScope): Promise<ScopeState>;
  private async state(id: string, fallback?: BotDeviceStorageScope): Promise<ScopeState | null> {
    await this.backend.initialize();
    const cached = this.states.get(id);
    if (cached) return cached;
    // An unreadable index (it may come from a newer Monky) fails closed instead of being replaced.
    const raw = await this.backend.readIndex(id);
    if (raw !== null && raw !== undefined) {
      const data = botDeviceStorageFileSchema.parse(raw);
      if (this.backend.scopeId(botDeviceStorageScopeIdentity(data.scope)) !== id) throw new BotDeviceStorageError('failed');
      const loaded: ScopeState = {
        id, scope: data.scope, decision: data.decision, maxBytes: data.maxBytes,
        objects: new Map(data.objects.map((entry) => [entry.key, entry])), persisted: true, refused: false, updatedAt: data.updatedAt,
      };
      await this.backend.removeUnreferenced(id, new Set(data.objects.map((entry) => entry.file)));
      this.states.set(id, loaded);
      return loaded;
    }
    if (!fallback) return null;
    return {
      id, scope: fallback, decision: 'ask', maxBytes: BOT_STORAGE_LIMITS.deviceDefaultBytes, objects: new Map(),
      persisted: false, refused: false, updatedAt: Date.now(),
    };
  }

  /** Bounds how many server, account and bot scopes one device keeps. */
  private async requireRoom(state: ScopeState): Promise<void> {
    if (state.persisted || await this.backend.hasScope(state.id)) return;
    const names = await this.backend.scopes();
    if (names.filter(isBotDeviceStorageScopeId).length >= BOT_STORAGE_LIMITS.deviceScopes) throw new BotDeviceStorageError('quota');
  }

  private async save(state: ScopeState): Promise<ScopeState> {
    await this.requireRoom(state);
    const data: BotDeviceStorageFile = {
      version: 1, scope: state.scope, decision: state.decision, maxBytes: state.maxBytes,
      objects: [...state.objects.values()], updatedAt: state.updatedAt,
    };
    await this.backend.writeIndex(state.id, botDeviceStorageFileSchema.parse(data));
    const saved = { ...state, persisted: true };
    this.states.set(state.id, saved);
    return saved;
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

/** Storage that one opened miniapp document may reach. */
export interface BotScreenStorageBinding {
  scopeId: string;
  scope: BotDeviceStorageScope;
  /** "Only this session": lasts while this document exists; reopening asks again. */
  session: boolean;
}

/** What the person chose when opening a miniapp, applied: "always" is remembered, but never overrides a "never". */
export async function bindBotScreenStorage(
  storage: BotDeviceStorageEngine, choice: { scope: BotDeviceStorageScope; grant: BotDeviceStorageGrant },
): Promise<BotScreenStorageBinding> {
  const scopeId = storage.scopeId(choice.scope);
  let session = choice.grant === 'session';
  if (choice.grant === 'always') {
    try {
      if (await storage.decision(scopeId) === 'ask') await storage.setDecision(choice.scope, 'always');
    } catch (error) {
      // The person allowed it: that holds for this view, and each storage operation reports its own failure.
      console.warn('[Bot storage] Could not remember the storage decision; it applies to this view only.', error);
      session = true;
    }
  }
  return { scopeId, scope: choice.scope, session };
}

async function accessStatus(storage: BotDeviceStorageEngine, binding: BotScreenStorageBinding | null): Promise<BotDeviceStorageStatus> {
  if (!binding) return 'unavailable';
  const decision = await storage.decision(binding.scopeId);
  return decision === 'always' || (decision === 'ask' && binding.session) ? 'granted' : 'denied';
}

/** The storage state a miniapp document sees; the decision is read again on every call. */
export async function botScreenStorageState(
  storage: BotDeviceStorageEngine, binding: BotScreenStorageBinding | null,
): Promise<BotDeviceStorageDocumentState> {
  const status = await accessStatus(storage, binding);
  return {
    status, scopeId: binding?.scopeId ?? null,
    usage: binding && status === 'granted' ? await storage.usage(binding.scope) : null,
  };
}

/** Answers one request of a miniapp document, only while the person allows it and `allow` (the rate limit) agrees. */
export async function answerBotScreenStorageRequest(
  storage: BotDeviceStorageEngine, binding: BotScreenStorageBinding | null, input: unknown, allow: () => boolean = () => true,
): Promise<BotDeviceStorageResponse> {
  const request = botDeviceStorageRequestSchema.safeParse(input);
  if (!request.success) return { ok: false, reason: 'invalid', usage: null };
  if (!allow()) return { ok: false, reason: 'failed', usage: null };
  const status = await accessStatus(storage, binding);
  if (!binding) return { ok: false, reason: 'unavailable', usage: null };
  if (status !== 'granted') return { ok: false, reason: 'denied', usage: null };
  try {
    switch (request.data.op) {
      case 'get': {
        const { value, usage } = await storage.get(binding.scope, request.data.key);
        return { ok: true, op: 'get', value, usage };
      }
      case 'set':
        return { ok: true, op: 'set', usage: await storage.set(binding.scope, request.data.key, request.data.value) };
      case 'remove': {
        const { removed, usage } = await storage.remove(binding.scope, request.data.key);
        return { ok: true, op: 'remove', removed, usage };
      }
      case 'list': {
        const { keys, usage } = await storage.keys(binding.scope, request.data.prefix);
        return { ok: true, op: 'list', keys, usage };
      }
      case 'usage':
        return { ok: true, op: 'usage', usage: await storage.usage(binding.scope) };
    }
  } catch (error) {
    const reason = error instanceof BotDeviceStorageError ? error.reason : 'failed';
    if (reason === 'failed') console.warn('[Bot storage] A miniapp storage operation failed.', error);
    return { ok: false, reason, usage: reason === 'quota' ? await storage.usage(binding.scope).catch(() => null) : null };
  }
}

/** At most `BOT_STORAGE_LIMITS.operationsPerSecond` requests per document and second. */
export class BotScreenStorageRateLimit {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  allow(document: string): boolean {
    const now = this.now();
    const window = this.windows.get(document);
    if (!window || now - window.start >= 1000) {
      // Stale windows of closed documents never outlive a second of inactivity.
      for (const [key, value] of this.windows) if (now - value.start >= 1000) this.windows.delete(key);
      this.windows.set(document, { start: now, count: 1 });
      return true;
    }
    return ++window.count <= BOT_STORAGE_LIMITS.operationsPerSecond;
  }

  clear(): void {
    this.windows.clear();
  }
}
