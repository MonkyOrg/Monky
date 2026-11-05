import {
  DmKeyring, DmService, dmResult, installDmCrypto, sha256Hex, type DmExportData,
} from '@monky/dm';
import type { DmApi, DmEvent, DmExportMode, DmResult } from '@monky/shared';
import { saveBlob } from './webFiles';
import { webDmCrypto } from './webDmCrypto';
import { WebDmStore } from './webDmStore';
import { webIdentitySecret } from './webIdentity';
import { deleteRecordsWithPrefix } from './webStorage';

/**
 * Friends and direct messages in the browser (#858): the same engine as the
 * desktop (`@monky/dm`), with its crypto from @noble and its store in
 * IndexedDB. This module plays the part of the desktop's `dmIpc.ts`: one
 * store per identity, opened on first use, answering every call as data.
 */
installDmCrypto(webDmCrypto);

const STORE_PREFIX = 'dm/';

interface OpenService {
  service: DmService;
  store: WebDmStore;
}

let opening: Promise<OpenService | null> | null = null;
const listeners = new Set<(event: DmEvent) => void>();

/** One store per identity, so importing another identity never mixes histories. */
function currentService(): Promise<OpenService | null> {
  opening ??= (async () => {
    const secret = await webIdentitySecret();
    if (!secret) return null;
    const keyring = new DmKeyring(secret.publicKey, secret.privateKeyDerBase64);
    const store = await WebDmStore.open(`${STORE_PREFIX}${sha256Hex(keyring.identityPublicKey).slice(0, 16)}/`);
    const service = new DmService({
      keyring,
      store,
      onEvent: (event) => { for (const listener of [...listeners]) listener(event); },
    });
    return { service, store };
  })().catch((error: unknown) => {
    console.error('[DM] Could not open direct messages in this browser.', error);
    opening = null;
    return null;
  });
  return opening;
}

async function withDm<T>(run: (dm: DmService) => T | Promise<T>): Promise<DmResult<T>> {
  const open = await currentService();
  if (!open) return { ok: false, error: { code: 'unavailable', message: 'No identity', details: {} } };
  return dmResult(() => run(open.service));
}

/** Drops the open store; the next call opens the store of the current identity. */
export async function resetWebDirectMessages(): Promise<void> {
  const open = await opening;
  opening = null;
  if (!open) return;
  open.service.flush();
  await open.store.dispose();
}

/** Logout: deletes every friend list, DM history and attachment kept in this browser. */
export async function wipeWebDirectMessages(): Promise<void> {
  const open = await opening;
  opening = null;
  open?.service.discard();
  open?.store.discard();
  await deleteRecordsWithPrefix(STORE_PREFIX);
}

/** Friends (and optionally history) to embed in the identity export. */
export async function exportWebDirectMessages(mode: DmExportMode): Promise<DmExportData | undefined> {
  if (mode === 'none') return undefined;
  return (await currentService())?.service.exportData(mode === 'history');
}

/** Merges DM data that came with an imported identity into its store. */
export async function importWebDirectMessages(data: unknown): Promise<void> {
  if (data === undefined || data === null) return;
  const open = await currentService();
  if (!open) return;
  try {
    open.service.importData(data);
    open.service.flush();
    await open.store.save();
  } catch (error: unknown) {
    console.error('[DM] Could not import friends/history from the identity code.', error);
  }
}

export const webDirectMessages: DmApi = {
  snapshot: () => withDm(dm => dm.snapshot()),
  conversation: (peer, before, limit) => withDm(dm => dm.getConversation(peer, before ?? null, limit)),
  openConversation: (peer) => withDm(dm => dm.openConversation(peer)),
  closeConversation: (peer) => withDm(dm => dm.closeConversation(peer)),
  sendFriendRequest: (peer, nickname) => withDm(dm => dm.sendFriendRequest(peer, nickname)),
  acceptFriend: (peer) => withDm(dm => dm.acceptFriend(peer)),
  declineFriend: (peer) => withDm(dm => dm.declineFriend(peer)),
  cancelFriendRequest: (peer) => withDm(dm => dm.cancelFriendRequest(peer)),
  removeFriend: (peer) => withDm(dm => dm.removeFriend(peer)),
  block: (peer, nickname) => withDm(dm => dm.block(peer, nickname)),
  unblock: (peer) => withDm(dm => dm.unblock(peer)),
  sendMessage: (input) => withDm(dm => dm.sendMessage(input)),
  editMessage: (peer, id, content) => withDm(dm => dm.editMessage(peer, id, content)),
  resendMessage: (peer, id) => withDm(dm => dm.resendMessage(peer, id)),
  deleteMessage: (peer, id) => withDm(dm => dm.deleteMessage(peer, id)),
  react: (peer, id, emoji, add) => withDm(dm => dm.react(peer, id, emoji, add)),
  markRead: (peer) => withDm(dm => dm.markRead(peer)),
  typing: (peer) => withDm(dm => dm.typing(peer)),
  ingest: (item) => withDm(dm => dm.ingest(item)),
  outgoing: (peers, force) => withDm(dm => dm.outgoing(peers, force === true)),
  hello: (toFriends, announce) => withDm(dm => dm.hello(toFriends, announce !== false)),
  helloTo: (peer) => withDm(dm => dm.helloTo(peer)),
  pendingPeers: () => withDm(dm => dm.pendingPeers()),
  observePeer: (peer) => withDm(dm => dm.observePeer(peer)),
  setSelfNickname: (nickname) => withDm(dm => dm.setSelfNickname(nickname)),
  setSelfProfile: (input) => withDm(dm => dm.setSelfProfile(input)),
  updateSettings: (settings) => withDm(dm => dm.updateSettings(settings)),
  readAttachment: (peer, id, fileId) => withDm(dm => dm.readAttachment(peer, id, fileId)),
  saveAttachment: (peer, id, fileId) => withDm(dm => {
    const file = dm.readAttachment(peer, id, fileId);
    saveBlob(new Blob([new Uint8Array(file.data)], { type: file.mime || 'application/octet-stream' }), file.name || 'arquivo');
    return true;
  }),
  retryAttachment: (peer, id, fileId) => withDm(dm => dm.retryAttachment(peer, id, fileId)),
  onEvent(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
