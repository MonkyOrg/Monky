import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DM_EVENT,
  DM_IPC,
  type DmEvent,
  type DmExportMode,
  type DmFailure,
  type DmResult,
} from '@monky/shared';
import { createDmKeyring } from '../identityService';
import { DmError, DmService, type DmExportData } from './dmService';

let service: DmService | null = null;
let eventSink: ((event: DmEvent) => void) | null = null;

function dmRoot(): string {
  return path.join(app.getPath('userData'), 'dm');
}

/** One store per identity, so importing another identity never mixes histories. */
function currentService(): DmService | null {
  if (service) return service;
  let keyring;
  try {
    keyring = createDmKeyring();
  } catch (error) {
    console.error('[DM] Could not load the identity keyring.', error);
    return null;
  }
  if (!keyring) return null;
  const identity = keyring.identityPublicKey;
  const folder = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  service = new DmService({
    keyring,
    dir: path.join(dmRoot(), folder),
    onEvent: (event) => eventSink?.(event),
  });
  return service;
}

/** Writes pending DM state to disk. Safe to call repeatedly. */
export function flushDirectMessages(): void {
  try {
    service?.flush();
  } catch (error) {
    console.error('[DM] Could not flush the encrypted store.', error);
  }
}

/** Drops the cached store; the next call opens the store of the current identity. */
export function resetDirectMessages(): void {
  flushDirectMessages();
  service = null;
}

/**
 * Logout: deletes every friend list, DM history and attachment stored on this
 * computer. Call after the identity file is gone, so nothing reopens a store.
 */
export async function wipeDirectMessages(): Promise<void> {
  service?.discard();
  service = null;
  await fs.rm(dmRoot(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Friends (and optionally history) to embed in the identity export. */
export function exportDirectMessages(mode: DmExportMode): DmExportData | undefined {
  if (mode === 'none') return undefined;
  return currentService()?.exportData(mode === 'history');
}

/** Merges DM data that came with an imported identity into its store. */
export function importDirectMessages(data: unknown): void {
  if (data === undefined || data === null) return;
  const target = currentService();
  if (!target) return;
  try {
    target.importData(data);
    target.flush();
  } catch (error) {
    console.error('[DM] Could not import friends/history from the identity file.', error);
  }
}

function failure(error: unknown): DmFailure {
  if (error instanceof DmError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  console.error('[DM] Operation failed.', error);
  return {
    code: 'unavailable',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function setupDmIpc(mainWindow: BrowserWindow, sanitizeFileName: (name: string) => string): () => void {
  const owns = (event: IpcMainInvokeEvent): boolean =>
    !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame;

  eventSink = (event) => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send(DM_EVENT, event);
  };

  const channels: string[] = [];
  const handle = <T>(channel: string, run: (dm: DmService, ...args: unknown[]) => T | Promise<T>): void => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<DmResult<T>> => {
      if (!owns(event)) {
        return { ok: false, error: { code: 'forbidden', message: 'Forbidden', details: {} } };
      }
      const dm = currentService();
      if (!dm) {
        return { ok: false, error: { code: 'unavailable', message: 'No identity', details: {} } };
      }
      try {
        return { ok: true, value: await run(dm, ...args) };
      } catch (error) {
        return { ok: false, error: failure(error) };
      }
    });
  };

  handle(DM_IPC.snapshot, (dm) => dm.snapshot());
  handle(DM_IPC.conversation, (dm, peer, before, limit) =>
    dm.getConversation(text(peer), typeof before === 'string' ? before : null, typeof limit === 'number' ? limit : undefined));
  handle(DM_IPC.openConversation, (dm, peer) => dm.openConversation(text(peer)));
  handle(DM_IPC.closeConversation, (dm, peer) => dm.closeConversation(text(peer)));
  handle(DM_IPC.sendFriendRequest, (dm, peer, nickname) =>
    dm.sendFriendRequest(text(peer), typeof nickname === 'string' ? nickname : undefined));
  handle(DM_IPC.acceptFriend, (dm, peer) => dm.acceptFriend(text(peer)));
  handle(DM_IPC.declineFriend, (dm, peer) => dm.declineFriend(text(peer)));
  handle(DM_IPC.cancelFriendRequest, (dm, peer) => dm.cancelFriendRequest(text(peer)));
  handle(DM_IPC.removeFriend, (dm, peer) => dm.removeFriend(text(peer)));
  handle(DM_IPC.block, (dm, peer, nickname) => dm.block(text(peer), typeof nickname === 'string' ? nickname : undefined));
  handle(DM_IPC.unblock, (dm, peer) => dm.unblock(text(peer)));
  handle(DM_IPC.sendMessage, (dm, input) => {
    const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const files = Array.isArray(value.files) ? value.files : [];
    return dm.sendMessage({
      peer: text(value.peer),
      content: text(value.content),
      replyTo: typeof value.replyTo === 'string' ? value.replyTo : null,
      files: files
        .filter((file): file is Record<string, unknown> => !!file && typeof file === 'object')
        .map((file) => ({
          name: text(file.name),
          mime: text(file.mime),
          data: file.data instanceof Uint8Array ? file.data : new Uint8Array(),
        })),
    });
  });
  handle(DM_IPC.editMessage, (dm, peer, id, content) => dm.editMessage(text(peer), text(id), text(content)));
  handle(DM_IPC.deleteMessage, (dm, peer, id) => dm.deleteMessage(text(peer), text(id)));
  handle(DM_IPC.react, (dm, peer, id, emoji, add) => dm.react(text(peer), text(id), text(emoji), add !== false));
  handle(DM_IPC.markRead, (dm, peer) => dm.markRead(text(peer)));
  handle(DM_IPC.typing, (dm, peer) => dm.typing(text(peer)));
  handle(DM_IPC.ingest, (dm, item) => {
    const value = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return dm.ingest({ from: text(value.from), kind: value.kind as never, data: text(value.data) });
  });
  handle(DM_IPC.outgoing, (dm, peers, force) =>
    dm.outgoing(Array.isArray(peers) ? peers.filter((peer): peer is string => typeof peer === 'string') : [], force === true));
  handle(DM_IPC.hello, (dm, toFriends) => dm.hello(toFriends === true));
  handle(DM_IPC.helloTo, (dm, peer) => dm.helloTo(text(peer)));
  handle(DM_IPC.pendingPeers, (dm) => dm.pendingPeers());
  handle(DM_IPC.observePeer, (dm, observed) => {
    const value = (observed && typeof observed === 'object' ? observed : {}) as Record<string, unknown>;
    dm.observePeer({
      publicKey: text(value.publicKey),
      nickname: typeof value.nickname === 'string' ? value.nickname : undefined,
      avatar: typeof value.avatar === 'string' ? value.avatar : null,
    });
  });
  handle(DM_IPC.setSelfNickname, (dm, nickname) => dm.setSelfNickname(text(nickname)));
  handle(DM_IPC.updateSettings, (dm, settings) => {
    const value = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
    return dm.updateSettings(typeof value.maxFileBytes === 'number' ? { maxFileBytes: value.maxFileBytes } : {});
  });
  handle(DM_IPC.retryAttachment, (dm, peer, id, fileId) => dm.retryAttachment(text(peer), text(id), text(fileId)));
  handle(DM_IPC.readAttachment, (dm, peer, id, fileId) => {
    const file = dm.readAttachment(text(peer), text(id), text(fileId));
    return { name: file.name, mime: file.mime, data: new Uint8Array(file.data) };
  });
  handle(DM_IPC.saveAttachment, async (dm, peer, id, fileId) => {
    const file = dm.readAttachment(text(peer), text(id), text(fileId));
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), sanitizeFileName(file.name) || 'arquivo'),
    });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, file.data);
    return true;
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    eventSink = null;
    flushDirectMessages();
  };
}
