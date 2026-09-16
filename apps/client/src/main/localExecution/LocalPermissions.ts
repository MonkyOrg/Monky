import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LOCAL_PERMISSION_LIMITS,
  localCapabilityIdSchema,
  localExecutionSubjectSchema,
  localPermissionsFileSchema,
  normalizePublicKeyHex,
  type LocalBotIdentity,
  type LocalCapabilityId,
  type LocalConsentDecision,
  type LocalExecutionSubject,
  type LocalPermissionInfo,
} from '@monky/shared';
import { LocalExecutionError } from './errors';
import { readLocalToolFile } from './localToolsStorage';

type Confirmation = (
  bot: LocalBotIdentity, capability: LocalCapabilityId, signal: AbortSignal,
) => Promise<LocalConsentDecision>;

interface TemporaryPermission {
  owner: number;
  connectionId: string;
  permission: LocalPermissionInfo;
}

interface Prompt {
  owner: number;
  subject: LocalExecutionSubject;
  permission: LocalPermissionInfo;
  controller: AbortController;
  waiters: Set<symbol>;
  settled: boolean;
  result: Promise<string>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function identity(subject: LocalExecutionSubject): LocalBotIdentity {
  const { connectionId: _connectionId, ...bot } = subject;
  return bot;
}

export function localPermissionId(bot: LocalBotIdentity, capability: LocalCapabilityId): string {
  return createHash('sha256').update(JSON.stringify([
    new URL(bot.serverOrigin).origin, bot.serverId, bot.botId, normalizePublicKeyHex(bot.botPublicKey), capability,
  ])).digest('hex');
}

function connectionKey(owner: number, connectionId: string): string {
  return JSON.stringify([owner, connectionId]);
}

function copy(permission: LocalPermissionInfo): LocalPermissionInfo {
  return { ...permission, bot: { ...permission.bot } };
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

export class LocalPermissions {
  private readonly records = new Map<string, LocalPermissionInfo>();
  private readonly temporary = new Map<string, TemporaryPermission>();
  private readonly prompts = new Map<string, Prompt>();
  private readonly enabling = new Map<string, AbortController>();
  private readonly generations = new Map<string, number>();
  private readonly connectionGenerations = new Map<string, number>();
  private readonly ownerGenerations = new Map<number, number>();
  private readonly capabilityGenerations = new Map<LocalCapabilityId, number>();
  private readonly blocked = new Set<string>();
  private initialization: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private writeFailed = false;
  private closed = false;
  private filename: string;

  constructor(filename: string, private readonly onChanged: () => void = () => undefined) {
    if (!path.isAbsolute(filename)) throw new LocalExecutionError('invalid_request');
    this.filename = filename;
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      const loading = this.load();
      this.initialization = loading;
      void loading.catch(() => { if (this.initialization === loading) this.initialization = null; });
    }
    return this.initialization;
  }

  async list(): Promise<LocalPermissionInfo[]> {
    await this.initialize();
    await this.writes;
    if (this.writeFailed) throw new LocalExecutionError('storage_failed');
    const visible = new Map(this.records);
    for (const entry of this.temporary.values()) {
      if (!visible.has(entry.permission.id)) visible.set(entry.permission.id, entry.permission);
    }
    return [...visible.values()].map((entry) => copy(this.blocked.has(entry.id)
      ? { ...entry, decision: 'deny' } : entry));
  }

  async assertAllowed(owner: number, input: LocalExecutionSubject, capability: LocalCapabilityId): Promise<string> {
    const subject = this.subject(owner, input, capability);
    await this.initialize();
    await this.writes;
    const id = localPermissionId(subject, capability);
    this.assertOpen();
    if (this.blocked.has(id)) throw new LocalExecutionError('permission_revoked');
    const permanent = this.records.get(id);
    if (permanent?.decision === 'deny') throw new LocalExecutionError('permission_denied');
    if (permanent?.decision === 'always' || this.temporary.has(this.temporaryKey(owner, subject, id))) return id;
    throw new LocalExecutionError('permission_denied');
  }

  async authorize(
    owner: number, input: LocalExecutionSubject, capability: LocalCapabilityId,
    signal: AbortSignal, confirm: Confirmation,
  ): Promise<string> {
    const subject = this.subject(owner, input, capability);
    await this.initialize();
    await this.writes;
    signal.throwIfAborted();
    this.assertOpen();
    const id = localPermissionId(subject, capability);
    const existing = this.records.get(id);
    if (this.blocked.has(id)) throw new LocalExecutionError('permission_revoked');
    if (existing?.decision === 'deny') throw new LocalExecutionError('permission_denied');
    const key = this.temporaryKey(owner, subject, id);
    if (existing?.decision === 'always' || this.temporary.has(key)) return id;
    let prompt = this.prompts.get(key);
    if (!prompt || prompt.controller.signal.aborted) {
      const guard = this.guard(owner, subject, capability, id);
      const controller = new AbortController();
      const permission: LocalPermissionInfo = {
        id, bot: identity(subject), capability, decision: 'connection', updatedAt: Date.now(),
      };
      const result = this.confirmPermission(owner, subject, permission, controller.signal, guard, confirm);
      prompt = { owner, subject, permission, controller, waiters: new Set(), settled: false, result };
      const current = prompt;
      this.prompts.set(key, current);
      // Every caller receives result; this observer only owns prompt cleanup.
      result.then(
        () => this.finishPrompt(key, current),
        () => this.finishPrompt(key, current),
      );
    }
    const waiter = Symbol();
    prompt.waiters.add(waiter);
    try {
      return await waitWithSignal(prompt.result, signal);
    } finally {
      prompt.waiters.delete(waiter);
      if (!prompt.waiters.size && !prompt.settled) {
        prompt.controller.abort(new LocalExecutionError('cancelled'));
      }
    }
  }

  revoke(permissionId: string): Promise<void> {
    const pending = this.findKnown(permissionId);
    if (pending) this.invalidate(permissionId);
    return this.initialize().then(async () => {
      const permission = pending ?? this.findKnown(permissionId);
      if (!permission) throw new LocalExecutionError('invalid_request');
      if (!pending) this.invalidate(permissionId);
      await this.persist({ ...permission, decision: 'deny', updatedAt: Date.now() });
    });
  }

  async revokeCapability(capability: LocalCapabilityId): Promise<void> {
    this.capabilityGenerations.set(capability, (this.capabilityGenerations.get(capability) ?? 0) + 1);
    const known = new Map<string, LocalPermissionInfo>();
    for (const permission of this.records.values()) if (permission.capability === capability) known.set(permission.id, permission);
    for (const entry of this.temporary.values()) if (entry.permission.capability === capability) known.set(entry.permission.id, entry.permission);
    for (const prompt of this.prompts.values()) if (prompt.permission.capability === capability) known.set(prompt.permission.id, prompt.permission);
    for (const id of known.keys()) this.invalidate(id);
    await this.initialize();
    for (const permission of this.records.values()) if (permission.capability === capability) known.set(permission.id, permission);
    for (const permission of known.values()) {
      this.invalidate(permission.id);
      await this.persist({ ...permission, decision: 'deny', updatedAt: Date.now() });
    }
  }

  async enable(
    permissionId: string, callerSignal: AbortSignal,
    confirm: (bot: LocalBotIdentity, capability: LocalCapabilityId, signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean> {
    await this.initialize();
    callerSignal.throwIfAborted();
    if (this.closed) throw new LocalExecutionError('executor_unavailable');
    const permission = this.findKnown(permissionId);
    if (!permission) throw new LocalExecutionError('invalid_request');
    if (this.enabling.has(permissionId)) throw new LocalExecutionError('busy');
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    this.enabling.set(permissionId, controller);
    const generation = this.generations.get(permissionId) ?? 0;
    const capabilityGeneration = this.capabilityGenerations.get(permission.capability) ?? 0;
    const guard = (): void => {
      if (signal.aborted) {
        throw signal.reason instanceof LocalExecutionError ? signal.reason
          : new LocalExecutionError('cancelled', { cause: signal.reason });
      }
      if (this.closed) throw new LocalExecutionError('executor_unavailable');
      if (generation !== (this.generations.get(permissionId) ?? 0) ||
          capabilityGeneration !== (this.capabilityGenerations.get(permission.capability) ?? 0)) {
        throw new LocalExecutionError('permission_revoked');
      }
    };
    try {
      if (!await waitWithSignal(confirm({ ...permission.bot }, permission.capability, signal), signal)) return false;
      guard();
      await this.persist({ ...permission, decision: 'always', updatedAt: Date.now() }, guard);
      guard();
      this.blocked.delete(permissionId);
      this.onChanged();
      return true;
    } finally {
      if (this.enabling.get(permissionId) === controller) this.enabling.delete(permissionId);
    }
  }

  cancelConnection(owner: number, connectionId: string): void {
    const key = connectionKey(owner, connectionId);
    this.connectionGenerations.set(key, (this.connectionGenerations.get(key) ?? 0) + 1);
    for (const [temporaryKey, entry] of this.temporary) {
      if (entry.owner === owner && entry.connectionId === connectionId) this.temporary.delete(temporaryKey);
    }
    for (const prompt of this.prompts.values()) {
      if (prompt.owner === owner && prompt.subject.connectionId === connectionId) {
        prompt.controller.abort(new LocalExecutionError('executor_unavailable'));
      }
    }
    this.onChanged();
  }

  cancelOwner(owner: number): void {
    this.ownerGenerations.set(owner, (this.ownerGenerations.get(owner) ?? 0) + 1);
    for (const [key, entry] of this.temporary) if (entry.owner === owner) this.temporary.delete(key);
    for (const prompt of this.prompts.values()) {
      if (prompt.owner === owner) prompt.controller.abort(new LocalExecutionError('executor_unavailable'));
    }
    this.onChanged();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const prompts = [...this.prompts.values()];
    for (const prompt of prompts) prompt.controller.abort(new LocalExecutionError('executor_unavailable'));
    for (const controller of this.enabling.values()) controller.abort(new LocalExecutionError('executor_unavailable'));
    this.temporary.clear();
    await Promise.allSettled(prompts.map((prompt) => prompt.result));
    await this.writes;
  }

  private subject(owner: number, input: LocalExecutionSubject, capability: LocalCapabilityId): LocalExecutionSubject {
    const parsed = localExecutionSubjectSchema.safeParse(input);
    if (!Number.isSafeInteger(owner) || owner <= 0 || !parsed.success || !localCapabilityIdSchema.safeParse(capability).success) {
      throw new LocalExecutionError('invalid_request');
    }
    return parsed.data;
  }

  private assertOpen(): void {
    if (this.closed) throw new LocalExecutionError('executor_unavailable');
    if (this.writeFailed) throw new LocalExecutionError('storage_failed');
  }

  private temporaryKey(owner: number, subject: LocalExecutionSubject, id: string): string {
    return JSON.stringify([owner, subject.connectionId, id]);
  }

  private guard(owner: number, subject: LocalExecutionSubject, capability: LocalCapabilityId, id: string): () => void {
    const generation = this.generations.get(id) ?? 0;
    const ownerGeneration = this.ownerGenerations.get(owner) ?? 0;
    const connection = connectionKey(owner, subject.connectionId);
    const connectionGeneration = this.connectionGenerations.get(connection) ?? 0;
    const capabilityGeneration = this.capabilityGenerations.get(capability) ?? 0;
    return () => {
      this.assertOpen();
      if (generation !== (this.generations.get(id) ?? 0) ||
          capabilityGeneration !== (this.capabilityGenerations.get(capability) ?? 0)) {
        throw new LocalExecutionError('permission_revoked');
      }
      if (ownerGeneration !== (this.ownerGenerations.get(owner) ?? 0) ||
          connectionGeneration !== (this.connectionGenerations.get(connection) ?? 0)) {
        throw new LocalExecutionError('executor_unavailable');
      }
    };
  }

  private async confirmPermission(
    owner: number, subject: LocalExecutionSubject, permission: LocalPermissionInfo,
    signal: AbortSignal, guard: () => void, confirm: Confirmation,
  ): Promise<string> {
    const decision = await waitWithSignal(confirm({ ...permission.bot }, permission.capability, signal), signal);
    signal.throwIfAborted();
    guard();
    if (decision !== 'deny' && decision !== 'connection' && decision !== 'always') {
      throw new LocalExecutionError('invalid_request');
    }
    const next = { ...permission, decision, updatedAt: Date.now() };
    if (decision === 'connection') {
      this.temporary.set(this.temporaryKey(owner, subject, permission.id), {
        owner, connectionId: subject.connectionId, permission: next,
      });
      this.onChanged();
    } else {
      await this.persist(next, () => { signal.throwIfAborted(); guard(); });
    }
    signal.throwIfAborted();
    guard();
    if (decision === 'deny') throw new LocalExecutionError('permission_denied');
    return permission.id;
  }

  private finishPrompt(key: string, prompt: Prompt): void {
    prompt.settled = true;
    if (this.prompts.get(key) === prompt) this.prompts.delete(key);
  }

  private findKnown(id: string): LocalPermissionInfo | undefined {
    const stored = this.records.get(id);
    if (stored) return stored;
    for (const entry of this.temporary.values()) if (entry.permission.id === id) return entry.permission;
    for (const prompt of this.prompts.values()) if (prompt.permission.id === id) return prompt.permission;
    return undefined;
  }

  private invalidate(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.blocked.add(id);
    this.enabling.get(id)?.abort(new LocalExecutionError('permission_revoked'));
    for (const [key, entry] of this.temporary) if (entry.permission.id === id) this.temporary.delete(key);
    for (const prompt of this.prompts.values()) {
      if (prompt.permission.id === id) prompt.controller.abort(new LocalExecutionError('permission_revoked'));
    }
    this.onChanged();
  }

  private async load(): Promise<void> {
    try {
      const directory = path.dirname(this.filename);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      this.filename = path.join(await fs.realpath(directory), path.basename(this.filename));
      let stat: Stats;
      try {
        stat = await fs.lstat(this.filename);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LOCAL_PERMISSION_LIMITS.bytes) {
        throw new LocalExecutionError('storage_failed');
      }
      const file = await readLocalToolFile(
        path.dirname(this.filename), this.filename, LOCAL_PERMISSION_LIMITS.bytes, undefined, true,
      );
      const data: unknown = JSON.parse(file.contents.toString('utf8'));
      const parsed = localPermissionsFileSchema.safeParse(data);
      if (!parsed.success) throw new LocalExecutionError('storage_failed');
      const records = new Map<string, LocalPermissionInfo>();
      for (const permission of parsed.data.permissions) {
        if (permission.id !== localPermissionId(permission.bot, permission.capability) || records.has(permission.id)) {
          throw new LocalExecutionError('storage_failed');
        }
        records.set(permission.id, permission);
      }
      for (const [id, permission] of records) this.records.set(id, permission);
    } catch (error) {
      throw error instanceof LocalExecutionError && error.reason === 'storage_failed'
        ? error : new LocalExecutionError('storage_failed', { cause: error });
    }
  }

  private persist(permission: LocalPermissionInfo, guard?: () => void): Promise<void> {
    const result = this.writes.then(async () => {
      guard?.();
      if (permission.decision === 'connection') throw new LocalExecutionError('invalid_request');
      if (!this.records.has(permission.id) && this.records.size >= LOCAL_PERMISSION_LIMITS.entries) throw new LocalExecutionError('busy');
      const previous = this.records.get(permission.id);
      this.records.set(permission.id, copy(permission));
      const staging = path.join(path.dirname(this.filename), `.permissions-${randomUUID()}.tmp`);
      try {
        const content = JSON.stringify({ version: 1, permissions: [...this.records.values()] });
        if (Buffer.byteLength(content) > LOCAL_PERMISSION_LIMITS.bytes) throw new LocalExecutionError('busy');
        const file = await fs.open(staging, 'wx', 0o600);
        try {
          await file.writeFile(content);
          await file.sync();
        } finally {
          await file.close();
        }
        guard?.();
        await fs.rename(staging, this.filename);
        this.writeFailed = false;
      } catch (error) {
        if (permission.decision === 'always') {
          if (previous) this.records.set(permission.id, previous);
          else this.records.delete(permission.id);
        }
        if (!(error instanceof LocalExecutionError)) this.writeFailed = true;
        throw error instanceof LocalExecutionError ? error : new LocalExecutionError('storage_failed', { cause: error });
      } finally {
        try {
          await fs.unlink(staging);
        } catch (error) {
          if (!missing(error)) throw new LocalExecutionError('storage_failed', { cause: error });
        }
        this.onChanged();
      }
    });
    // A failed mutation must not poison the queue; its caller still gets result's rejection.
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }
}
