import {
  DM_MAX_ATTACHMENTS, DM_MAX_MESSAGE_LENGTH, LIMITS, MessageType, Permission, ProtocolErrorCode,
  type ChatMessage, type ChatSendPayload, type DmPeerView,
} from '@monky/shared';
import { t } from '../i18n';
import { dmStore } from '../stores/dmStore';
import { getActiveChatStore, type ChatStore } from '../stores/chatStore';
import { getActiveServerStore, type ServerStore } from '../stores/serverStore';
import { uploadAttachment } from './AttachmentUploader';
import { getActiveNetworkClient, ProtocolRequestError, type NetworkClient } from './NetworkClient';

export interface ForwardAttachment {
  name: string;
  mime: string;
  size: number;
  load(): Promise<Blob>;
}

/** One message to forward, already read from wherever it was. */
export interface ForwardItem {
  content: string;
  attachments: ForwardAttachment[];
  /** The original on the active server, which lets that server name its channel and check the copy. */
  sourceMessageId?: string;
  /** Badge text for a DM destination (`#canal · Servidor`); null when the original was in a DM. */
  sourceLabel: string | null;
  createdAt: number;
}

export type ForwardDestination = { kind: 'channel'; channelId: string } | { kind: 'dm'; peer: string };

export interface ForwardResult {
  sent: number;
  error?: string;
}

/**
 * The server counts every message and every upload token against one per-user
 * allowance (RATE_LIMIT_MAX_MESSAGES per window), so forwarding paces both.
 */
const ACTION_SPACING_MS = Math.ceil(LIMITS.RATE_LIMIT_WINDOW_MS / Math.max(1, LIMITS.RATE_LIMIT_MAX_MESSAGES - 1));
const RATE_LIMIT_RETRIES = 3;
/** Shared by every destination, so forwarding to several channels keeps one pace. */
let lastLimitedActionAt = 0;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Runs one action the server rate-limits, spaced from the previous one. Messages
 * the user sent just before also count, so a refusal waits a whole window and
 * tries again instead of failing the forward.
 */
async function rateLimited<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const delay = lastLimitedActionAt + ACTION_SPACING_MS - Date.now();
    if (delay > 0) await wait(delay);
    lastLimitedActionAt = Date.now();
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ProtocolRequestError) || error.code !== ProtocolErrorCode.RATE_LIMITED || attempt >= RATE_LIMIT_RETRIES) throw error;
      await wait(LIMITS.RATE_LIMIT_WINDOW_MS);
    }
  }
}

/** Server attachments are served with CORS, so the renderer can read them back to re-upload. */
export async function fetchAttachment(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(t('chat.forwardReadFailed'));
  return await response.blob();
}

/**
 * Why `items` cannot go to `destination`, or null when they can. Checked before
 * anything is sent, so a forward never stops halfway over a predictable limit.
 */
export function forwardBlocker(
  items: readonly ForwardItem[],
  destination: ForwardDestination,
  server: ServerStore = getActiveServerStore(),
): string | null {
  const hasFiles = items.some((item) => item.attachments.length > 0);
  if (destination.kind === 'channel') {
    if (!server.hasPermission(Permission.SEND_MESSAGES, destination.channelId)) return t('chat.forwardNoPermission');
    if (hasFiles && !server.hasPermission(Permission.ATTACH_FILES, destination.channelId)) return t('chat.forwardNoFilePermission');
    const details = server.serverDetails;
    const maxLength = details?.maxMessageLength ?? (details ? 2000 : LIMITS.MAX_MESSAGE_LENGTH);
    if (maxLength > 0 && items.some((item) => item.content.length > maxLength)) return t('chat.forwardTooLong', { max: maxLength });
    const maxFile = details?.attachmentStorage?.maxFileBytes ?? LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT;
    if (items.some((item) => item.attachments.some((file) => file.size > maxFile))) return t('chat.forwardFileTooLarge');
    if (items.some((item) => item.attachments.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE)) return t('chat.forwardTooManyFiles');
    return null;
  }
  const peer: DmPeerView | undefined = dmStore.peer(destination.peer);
  if (!peer || peer.relation !== 'friend' || peer.blocked) return t('chat.forwardNotFriend');
  if (items.some((item) => item.content.length > DM_MAX_MESSAGE_LENGTH)) return t('chat.forwardTooLong', { max: DM_MAX_MESSAGE_LENGTH });
  if (items.some((item) => item.attachments.some((file) => file.size > peer.maxFileBytes))) return t('chat.forwardFileTooLarge');
  if (items.some((item) => item.attachments.length > DM_MAX_ATTACHMENTS)) return t('chat.forwardTooManyFiles');
  return null;
}

async function forwardToChannel(
  items: readonly ForwardItem[], channelId: string, onProgress: (sent: number) => void,
  client: NetworkClient, server: ServerStore, store: ChatStore,
): Promise<ForwardResult> {
  const features = server.serverDetails?.protocol?.features ?? [];
  if (!features.includes('chat-delivery')) return { sent: 0, error: t('chat.featureUpdateRequired') };
  const marksForward = features.includes('message-forward');
  let sent = 0;
  try {
    for (const item of items) {
      const attachmentIds: string[] = [];
      for (const file of item.attachments) {
        const blob = await file.load();
        const upload = new File([blob], file.name, { type: file.mime });
        // A refused token never starts the upload, so asking again is safe.
        const meta = await rateLimited(() => uploadAttachment(channelId, upload, undefined, client).promise);
        attachmentIds.push(meta.id);
      }
      const payload: ChatSendPayload = {
        channelId,
        content: item.content,
        clientMessageId: crypto.randomUUID(),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(marksForward ? { forward: item.sourceMessageId ? { sourceMessageId: item.sourceMessageId } : {} } : {}),
      };
      // The same clientMessageId makes a retry deliver the message once.
      const message = await rateLimited(() => client.sendRequest<ChatMessage>(MessageType.CHAT_SEND, payload));
      if (message?.channelId === channelId && server.hasPermission(Permission.READ_MESSAGES, channelId)) store.addMessage(message);
      onProgress(++sent);
    }
    return { sent };
  } catch (error) {
    return { sent, error: error instanceof Error ? error.message : t('chat.forwardFailed') };
  }
}

async function forwardToDm(items: readonly ForwardItem[], peer: string, onProgress: (sent: number) => void): Promise<ForwardResult> {
  let sent = 0;
  try {
    for (const item of items) {
      const files = [];
      for (const file of item.attachments) {
        files.push({ name: file.name, mime: file.mime, data: new Uint8Array(await (await file.load()).arrayBuffer()) });
      }
      const failure = await dmStore.sendMessage(peer, item.content, files, null,
        { source: item.sourceLabel, createdAt: item.createdAt });
      if (failure) return { sent, error: failure.message };
      onProgress(++sent);
    }
    return { sent };
  } catch (error) {
    return { sent, error: error instanceof Error ? error.message : t('chat.forwardFailed') };
  }
}

/** Sends `items` in order, each as its own message; stops at the first failure. */
export async function forwardMessages(
  items: readonly ForwardItem[],
  destination: ForwardDestination,
  onProgress: (sent: number) => void = () => undefined,
): Promise<ForwardResult> {
  const blocker = forwardBlocker(items, destination);
  if (blocker) return { sent: 0, error: blocker };
  return destination.kind === 'channel'
    ? await forwardToChannel(items, destination.channelId, onProgress,
      getActiveNetworkClient(), getActiveServerStore(), getActiveChatStore())
    : await forwardToDm(items, destination.peer, onProgress);
}
