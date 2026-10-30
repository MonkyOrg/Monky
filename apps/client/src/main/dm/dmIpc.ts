import { app, dialog, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DM_EVENT,
  DM_IPC,
  dmRelayKindSchema,
  sanitizeDmForward,
  type DmEvent,
  type DmExportMode,
  type DmFailure,
  type DmResult,
} from '@monky/shared';
import { createDmKeyring } from '../identityService';
import { isRecord } from '../ipc/guards';
import type { IpcRegistry } from '../ipc/registry';
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
  try {
    service = new DmService({
      keyring,
      dir: path.join(dmRoot(), folder),
      onEvent: (event) => eventSink?.(event),
    });
  } catch (error) {
    // The store could not be read right now; it stays on disk and the next call tries again.
    console.error('[DM] Could not open the encrypted store.', error);
    return null;
  }
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

/**
 * Writes a DM attachment of the active identity to `destination` (absolute path,
 * created or overwritten). For main-process features such as batch downloads.
 * Throws when DMs are unavailable, the message/file does not exist or the file
 * is not downloaded yet (state other than ready/local).
 */
export async function writeDmAttachment(peer: string, messageId: string, fileId: string, destination: string): Promise<void> {
  const dm = currentService();
  if (!dm) throw new Error('Direct messages are unavailable: no identity is loaded.');
  await dm.writeAttachmentTo(text(peer), text(messageId), text(fileId), text(destination));
}

/** Runs `run` on the store of the current identity; errors travel as data because Electron drops custom error fields. */
async function withDm<T>(run: (dm: DmService) => T | Promise<T>): Promise<DmResult<T>> {
  const dm = currentService();
  if (!dm) {
    return { ok: false, error: { code: 'unavailable', message: 'No identity', details: {} } };
  }
  try {
    return { ok: true, value: await run(dm) };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

/** Friends and DMs answer only the main window; anyone else is told so as data, like every other DM failure. */
const DM_POLICY: { from: 'main'; refused: { ok: false; error: DmFailure } } = {
  from: 'main',
  refused: { ok: false, error: { code: 'forbidden', message: 'Forbidden', details: {} } },
};

export function registerDmIpc(registry: IpcRegistry, mainWindow: BrowserWindow, sanitizeFileName: (name: string) => string): void {
  eventSink = (event) => { registry.send('main', DM_EVENT, event); };
  registry.onDispose(() => {
    eventSink = null;
    flushDirectMessages();
  });

  registry.handle(DM_IPC.snapshot, DM_POLICY, () => withDm(dm => dm.snapshot()));
  registry.handle(DM_IPC.conversation, DM_POLICY, (_event, peer, before, limit) => withDm(dm =>
    dm.getConversation(text(peer), typeof before === 'string' ? before : null, typeof limit === 'number' ? limit : undefined)));
  registry.handle(DM_IPC.openConversation, DM_POLICY, (_event, peer) => withDm(dm => dm.openConversation(text(peer))));
  registry.handle(DM_IPC.closeConversation, DM_POLICY, (_event, peer) => withDm(dm => dm.closeConversation(text(peer))));
  registry.handle(DM_IPC.sendFriendRequest, DM_POLICY, (_event, peer, nickname) => withDm(dm =>
    dm.sendFriendRequest(text(peer), typeof nickname === 'string' ? nickname : undefined)));
  registry.handle(DM_IPC.acceptFriend, DM_POLICY, (_event, peer) => withDm(dm => dm.acceptFriend(text(peer))));
  registry.handle(DM_IPC.declineFriend, DM_POLICY, (_event, peer) => withDm(dm => dm.declineFriend(text(peer))));
  registry.handle(DM_IPC.cancelFriendRequest, DM_POLICY, (_event, peer) => withDm(dm => dm.cancelFriendRequest(text(peer))));
  registry.handle(DM_IPC.removeFriend, DM_POLICY, (_event, peer) => withDm(dm => dm.removeFriend(text(peer))));
  registry.handle(DM_IPC.block, DM_POLICY, (_event, peer, nickname) => withDm(dm =>
    dm.block(text(peer), typeof nickname === 'string' ? nickname : undefined)));
  registry.handle(DM_IPC.unblock, DM_POLICY, (_event, peer) => withDm(dm => dm.unblock(text(peer))));
  registry.handle(DM_IPC.sendMessage, DM_POLICY, (_event, input) => withDm(dm => {
    const value: Record<string, unknown> = isRecord(input) ? input : {};
    const files = Array.isArray(value.files) ? value.files : [];
    return dm.sendMessage({
      peer: text(value.peer),
      content: text(value.content),
      replyTo: typeof value.replyTo === 'string' ? value.replyTo : null,
      forwarded: sanitizeDmForward(value.forwarded),
      files: files
        .filter(isRecord)
        .map((file) => ({
          name: text(file.name),
          mime: text(file.mime),
          data: file.data instanceof Uint8Array ? file.data : new Uint8Array(),
        })),
    });
  }));
  registry.handle(DM_IPC.editMessage, DM_POLICY, (_event, peer, id, content) => withDm(dm =>
    dm.editMessage(text(peer), text(id), text(content))));
  registry.handle(DM_IPC.deleteMessage, DM_POLICY, (_event, peer, id) => withDm(dm => dm.deleteMessage(text(peer), text(id))));
  registry.handle(DM_IPC.react, DM_POLICY, (_event, peer, id, emoji, add) => withDm(dm =>
    dm.react(text(peer), text(id), text(emoji), add !== false)));
  registry.handle(DM_IPC.markRead, DM_POLICY, (_event, peer) => withDm(dm => dm.markRead(text(peer))));
  registry.handle(DM_IPC.typing, DM_POLICY, (_event, peer) => withDm(dm => dm.typing(text(peer))));
  registry.handle(DM_IPC.ingest, DM_POLICY, (_event, item) => withDm(dm => {
    const value: Record<string, unknown> = isRecord(item) ? item : {};
    // The server relays only these kinds; anything else carries nothing to read.
    const kind = dmRelayKindSchema.safeParse(value.kind);
    return kind.success ? dm.ingest({ from: text(value.from), kind: kind.data, data: text(value.data) }) : {};
  }));
  registry.handle(DM_IPC.outgoing, DM_POLICY, (_event, peers, force) => withDm(dm =>
    dm.outgoing(Array.isArray(peers) ? peers.filter((peer): peer is string => typeof peer === 'string') : [], force === true)));
  registry.handle(DM_IPC.hello, DM_POLICY, (_event, toFriends, announce) => withDm(dm =>
    dm.hello(toFriends === true, announce !== false)));
  registry.handle(DM_IPC.helloTo, DM_POLICY, (_event, peer) => withDm(dm => dm.helloTo(text(peer))));
  registry.handle(DM_IPC.pendingPeers, DM_POLICY, () => withDm(dm => dm.pendingPeers()));
  registry.handle(DM_IPC.observePeer, DM_POLICY, (_event, observed) => withDm(dm => {
    const value: Record<string, unknown> = isRecord(observed) ? observed : {};
    dm.observePeer({
      publicKey: text(value.publicKey),
      nickname: typeof value.nickname === 'string' ? value.nickname : undefined,
      avatar: typeof value.avatar === 'string' ? value.avatar : null,
    });
  }));
  registry.handle(DM_IPC.setSelfNickname, DM_POLICY, (_event, nickname) => withDm(dm => dm.setSelfNickname(text(nickname))));
  registry.handle(DM_IPC.setSelfProfile, DM_POLICY, (_event, input) => withDm(dm => {
    const value: Record<string, unknown> = isRecord(input) ? input : {};
    const stamp = (at: unknown): number | undefined => (typeof at === 'number' && Number.isFinite(at) ? at : undefined);
    return dm.setSelfProfile({
      nickname: typeof value.nickname === 'string' ? value.nickname : undefined,
      nicknameAt: stamp(value.nicknameAt),
      avatar: typeof value.avatar === 'string' || value.avatar === null ? value.avatar : undefined,
      avatarAt: stamp(value.avatarAt),
    });
  }));
  registry.handle(DM_IPC.updateSettings, DM_POLICY, (_event, settings) => withDm(dm => {
    const value: Record<string, unknown> = isRecord(settings) ? settings : {};
    return dm.updateSettings(typeof value.maxFileBytes === 'number' ? { maxFileBytes: value.maxFileBytes } : {});
  }));
  registry.handle(DM_IPC.retryAttachment, DM_POLICY, (_event, peer, id, fileId) => withDm(dm =>
    dm.retryAttachment(text(peer), text(id), text(fileId))));
  registry.handle(DM_IPC.readAttachment, DM_POLICY, (_event, peer, id, fileId) => withDm(dm => {
    const file = dm.readAttachment(text(peer), text(id), text(fileId));
    return { name: file.name, mime: file.mime, data: new Uint8Array(file.data) };
  }));
  registry.handle(DM_IPC.saveAttachment, DM_POLICY, (_event, peer, id, fileId) => withDm(async dm => {
    const file = dm.readAttachment(text(peer), text(id), text(fileId));
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), sanitizeFileName(file.name) || 'arquivo'),
    });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, file.data);
    return true;
  }));
}
