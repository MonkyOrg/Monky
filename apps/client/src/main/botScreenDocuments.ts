import { randomUUID } from 'node:crypto';
import { ipcMain, protocol, type Session, type WebContents } from 'electron';
import { BOT_SCREEN_DOCUMENT_IPC, BOT_SCREEN_LIMITS } from '@monky/shared';

const scheme = 'monky-miniapp';
const documents = new Map<string, { owner: WebContents; session: Session; html: string }>();
const sessions = new WeakSet<Session>();
const owners = new WeakSet<WebContents>();
const maxDocumentBytes = BOT_SCREEN_LIMITS.htmlBytes + BOT_SCREEN_LIMITS.stateBytes * 6 + 32 * 1024;

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

export function bindBotScreenDocuments(isOwner: (contents: WebContents) => boolean): () => void {
  ipcMain.handle(BOT_SCREEN_DOCUMENT_IPC.create, (event, ...args: unknown[]): string => {
    if (!isOwner(event.sender) || event.senderFrame !== event.sender.mainFrame || args.length !== 1 ||
        typeof args[0] !== 'string' || !args[0] || Buffer.byteLength(args[0]) > maxDocumentBytes) {
      throw new Error('Invalid miniapp document request.');
    }
    const owner = event.sender;
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
    documents.set(url, { owner, session: owner.session, html: args[0] });
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
