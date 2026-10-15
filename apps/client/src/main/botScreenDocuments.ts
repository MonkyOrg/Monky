import { randomUUID } from 'node:crypto';
import { ipcMain, protocol, type Session, type WebContents } from 'electron';
import { BOT_SCREEN_DOCUMENT_IPC, BOT_SCREEN_LIMITS, botScreenDocumentConsentSchema, type BotDeviceStorageScope } from '@monky/shared';
import { botDeviceStorageScopeId, type BotDeviceStorage } from './botStorage/BotDeviceStorage';

/** Storage on this computer that one opened miniapp document may reach. */
export interface BotScreenStorageBinding {
  scopeId: string;
  scope: BotDeviceStorageScope;
  /** "Only this session": lasts while this document exists; reopening asks again. */
  session: boolean;
}

const scheme = 'monky-miniapp';
const documents = new Map<string, { owner: WebContents; session: Session; html: string; storage: BotScreenStorageBinding | null }>();
const sessions = new WeakSet<Session>();
const owners = new WeakSet<WebContents>();
const maxDocumentBytes = BOT_SCREEN_LIMITS.htmlBytes + BOT_SCREEN_LIMITS.stateBytes * 6 + 32 * 1024;

/** Removing the document (leaving the miniapp) ends whatever it was allowed to store. */
export function botScreenDocumentStorage(url: string, owner: WebContents): BotScreenStorageBinding | null {
  const entry = documents.get(url);
  return entry && entry.owner === owner && !owner.isDestroyed() ? entry.storage : null;
}

async function removeDocument(url: string): Promise<void> {
  const entry = documents.get(url);
  if (!entry) return;
  documents.delete(url);
  const parsed = new URL(url);
  await entry.session.clearStorageData({ origin: `${parsed.protocol}//${parsed.host}` });
}

export function registerBotScreenScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

export function installBotScreenDocuments(session: Session): void {
  if (sessions.has(session)) return;
  sessions.add(session);
  session.protocol.handle(scheme, request => {
    const entry = documents.get(request.url);
    if (request.method !== 'GET' || !entry || entry.owner.isDestroyed() || entry.owner.session !== session) {
      return new Response('Miniapp document not found.', { status: 404 });
    }
    return new Response(entry.html, { headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  });
}

export function bindBotScreenDocuments(isOwner: (contents: WebContents) => boolean, storage?: BotDeviceStorage): () => void {
  ipcMain.handle(BOT_SCREEN_DOCUMENT_IPC.create, async (event, ...args: unknown[]): Promise<string> => {
    if (!isOwner(event.sender) || event.senderFrame !== event.sender.mainFrame || args.length !== 2 ||
        typeof args[0] !== 'string' || !args[0] || Buffer.byteLength(args[0]) > maxDocumentBytes) {
      throw new Error('Invalid miniapp document request.');
    }
    const consent = botScreenDocumentConsentSchema.safeParse(args[1]);
    if (!consent.success) {
      throw new Error('Current, instance-bound miniapp consent is required.');
    }
    const owner = event.sender;
    const html = args[0];
    let binding: BotScreenStorageBinding | null = null;
    if (consent.data.storage && storage) {
      const { scope, grant } = consent.data.storage;
      const scopeId = botDeviceStorageScopeId(scope);
      let session = grant === 'session';
      if (grant === 'always') {
        try {
          // "Always" is remembered, but never overrides a "Never" chosen in the bot settings.
          if (await storage.decision(scopeId) === 'ask') await storage.setDecision(scope, 'always');
        } catch (error) {
          // The person allowed it: that holds for this view, and each storage operation reports its own failure.
          console.warn('[Bot storage] Could not remember the storage decision; it applies to this view only.', error);
          session = true;
        }
      }
      binding = { scopeId, scope, session };
    }
    if (owner.isDestroyed() || !isOwner(owner)) throw new Error('The miniapp window closed.');
    if ([...documents.values()].filter(entry => entry.owner === owner).length >= 2) {
      throw new Error('Close another miniapp before opening this one.');
    }
    installBotScreenDocuments(owner.session);
    if (!owners.has(owner)) {
      owners.add(owner);
      const clear = (): void => {
        for (const [url, entry] of documents) if (entry.owner === owner) {
          void removeDocument(url).catch(error => console.error('[Bot screens] Could not clear miniapp storage.', error));
        }
      };
      owner.on('render-process-gone', clear);
      owner.on('did-navigate', clear);
      owner.once('destroyed', clear);
    }
    const url = `${scheme}://${randomUUID()}/index.html`;
    documents.set(url, { owner, session: owner.session, html, storage: binding });
    return url;
  });
  ipcMain.handle(BOT_SCREEN_DOCUMENT_IPC.remove, async (event, ...args: unknown[]): Promise<void> => {
    if (!isOwner(event.sender) || event.senderFrame !== event.sender.mainFrame ||
        args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('Invalid miniapp document removal.');
    }
    const entry = documents.get(args[0]);
    if (entry && entry.owner !== event.sender) throw new Error('Miniapp document belongs to another window.');
    await removeDocument(args[0]);
  });
  return () => {
    ipcMain.removeHandler(BOT_SCREEN_DOCUMENT_IPC.create);
    ipcMain.removeHandler(BOT_SCREEN_DOCUMENT_IPC.remove);
    for (const url of documents.keys()) {
      void removeDocument(url).catch(error => console.error('[Bot screens] Could not clear miniapp storage.', error));
    }
  };
}
