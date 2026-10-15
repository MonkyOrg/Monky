import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  BOT_STORAGE_IPC, BOT_STORAGE_LIMITS, botDeviceStorageDecisionUpdateSchema, botDeviceStorageQuotaUpdateSchema,
  botDeviceStorageRequestSchema, botDeviceStorageScopeSchema,
  type BotDeviceStorageDocumentState, type BotDeviceStorageEntry, type BotDeviceStorageResponse, type BotDeviceStorageStatus,
} from '@monky/shared';
import { botScreenDocumentStorage, type BotScreenStorageBinding } from '../botScreenDocuments';
import { BotDeviceStorageError, isBotDeviceStorageScopeId, type BotDeviceStorage } from './BotDeviceStorage';

interface RateWindow { start: number; count: number }

/**
 * Miniapps reach their storage only through the document Monky created for them,
 * and only while the person allows it; the decision is read again on every call.
 */
export function bindBotDeviceStorage(isOwner: (contents: WebContents) => boolean, storage: BotDeviceStorage): () => void {
  const rates = new Map<string, RateWindow>();
  const owns = (event: IpcMainInvokeEvent): boolean => isOwner(event.sender) && event.senderFrame === event.sender.mainFrame;
  const reject = (): never => { throw new Error('Invalid bot storage request.'); };
  const allow = (url: string): boolean => {
    const now = Date.now();
    const window = rates.get(url);
    if (!window || now - window.start >= 1000) {
      // Stale windows of closed documents never outlive a second of inactivity.
      for (const [key, value] of rates) if (now - value.start >= 1000) rates.delete(key);
      rates.set(url, { start: now, count: 1 });
      return true;
    }
    return ++window.count <= BOT_STORAGE_LIMITS.operationsPerSecond;
  };
  const access = async (url: string, owner: WebContents): Promise<{ status: BotDeviceStorageStatus; binding: BotScreenStorageBinding | null }> => {
    const binding = botScreenDocumentStorage(url, owner);
    if (!binding) return { status: 'unavailable', binding: null };
    const decision = await storage.decision(binding.scopeId);
    return { status: decision === 'always' || (decision === 'ask' && binding.session) ? 'granted' : 'denied', binding };
  };

  ipcMain.handle(BOT_STORAGE_IPC.documentState, async (event, ...args: unknown[]): Promise<BotDeviceStorageDocumentState> => {
    if (!owns(event) || args.length !== 1 || typeof args[0] !== 'string') return reject();
    const { status, binding } = await access(args[0], event.sender);
    return {
      status, scopeId: binding?.scopeId ?? null,
      usage: binding && status === 'granted' ? await storage.usage(binding.scope) : null,
    };
  });

  ipcMain.handle(BOT_STORAGE_IPC.documentRequest, async (event, ...args: unknown[]): Promise<BotDeviceStorageResponse> => {
    if (!owns(event) || args.length !== 2 || typeof args[0] !== 'string') return reject();
    const request = botDeviceStorageRequestSchema.safeParse(args[1]);
    if (!request.success) return { ok: false, reason: 'invalid', usage: null };
    if (!allow(args[0])) return { ok: false, reason: 'failed', usage: null };
    const { status, binding } = await access(args[0], event.sender);
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
  });

  ipcMain.handle(BOT_STORAGE_IPC.list, async (event, ...args: unknown[]): Promise<BotDeviceStorageEntry[]> => {
    if (!owns(event) || args.length !== 0) return reject();
    return storage.list();
  });
  ipcMain.handle(BOT_STORAGE_IPC.get, async (event, ...args: unknown[]): Promise<BotDeviceStorageEntry> => {
    const scope = botDeviceStorageScopeSchema.safeParse(args[0]);
    if (!owns(event) || args.length !== 1 || !scope.success) return reject();
    return storage.entry(scope.data);
  });
  ipcMain.handle(BOT_STORAGE_IPC.setDecision, async (event, ...args: unknown[]): Promise<BotDeviceStorageEntry> => {
    const input = botDeviceStorageDecisionUpdateSchema.safeParse(args[0]);
    if (!owns(event) || args.length !== 1 || !input.success) return reject();
    return storage.setDecision(input.data.scope, input.data.decision);
  });
  ipcMain.handle(BOT_STORAGE_IPC.setQuota, async (event, ...args: unknown[]): Promise<BotDeviceStorageEntry> => {
    const input = botDeviceStorageQuotaUpdateSchema.safeParse(args[0]);
    if (!owns(event) || args.length !== 1 || !input.success) return reject();
    return storage.setQuota(input.data.scope, input.data.maxBytes);
  });
  ipcMain.handle(BOT_STORAGE_IPC.clear, async (event, ...args: unknown[]): Promise<void> => {
    if (!owns(event) || args.length !== 1 || !isBotDeviceStorageScopeId(args[0])) return reject();
    await storage.clear(args[0]);
  });
  ipcMain.handle(BOT_STORAGE_IPC.forget, async (event, ...args: unknown[]): Promise<void> => {
    if (!owns(event) || args.length !== 1 || !isBotDeviceStorageScopeId(args[0])) return reject();
    await storage.forget(args[0]);
  });

  return () => {
    for (const channel of Object.values(BOT_STORAGE_IPC)) ipcMain.removeHandler(channel);
    rates.clear();
  };
}
