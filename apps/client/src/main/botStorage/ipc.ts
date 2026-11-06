import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  BOT_STORAGE_IPC, BotScreenStorageRateLimit, answerBotScreenStorageRequest, botDeviceStorageDecisionUpdateSchema,
  botDeviceStorageQuotaUpdateSchema, botDeviceStorageScopeSchema, botScreenStorageState,
  type BotDeviceStorageDocumentState, type BotDeviceStorageEntry, type BotDeviceStorageResponse,
} from '@monky/shared';
import { botScreenDocumentStorage } from '../botScreenDocuments';
import { isBotDeviceStorageScopeId, type BotDeviceStorage } from './BotDeviceStorage';

/**
 * Miniapps reach their storage only through the document Monky created for them,
 * and only while the person allows it; the decision is read again on every call.
 */
export function bindBotDeviceStorage(isOwner: (contents: WebContents) => boolean, storage: BotDeviceStorage): () => void {
  const rates = new BotScreenStorageRateLimit();
  const owns = (event: IpcMainInvokeEvent): boolean => isOwner(event.sender) && event.senderFrame === event.sender.mainFrame;
  const reject = (): never => { throw new Error('Invalid bot storage request.'); };

  ipcMain.handle(BOT_STORAGE_IPC.documentState, async (event, ...args: unknown[]): Promise<BotDeviceStorageDocumentState> => {
    if (!owns(event) || args.length !== 1 || typeof args[0] !== 'string') return reject();
    return botScreenStorageState(storage, botScreenDocumentStorage(args[0], event.sender));
  });

  ipcMain.handle(BOT_STORAGE_IPC.documentRequest, async (event, ...args: unknown[]): Promise<BotDeviceStorageResponse> => {
    const url = args[0];
    if (!owns(event) || args.length !== 2 || typeof url !== 'string') return reject();
    return answerBotScreenStorageRequest(storage, botScreenDocumentStorage(url, event.sender), args[1], () => rates.allow(url));
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
