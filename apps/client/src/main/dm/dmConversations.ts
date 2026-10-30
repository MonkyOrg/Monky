import { createHash } from 'crypto';
import {
  DM_MAX_ATTACHMENTS,
  DM_MAX_MESSAGE_LENGTH,
  sanitizeDmForward,
  type DmAttachmentState,
  type DmDispatch,
  type DmRelayItem,
  type DmSendMessageInput,
} from '@monky/shared';
import { newDmId, type DmEnvelopeHeader } from './dmCrypto';
import type { DmFiles } from './dmFiles';
import type { DmLedger } from './dmLedger';
import {
  DmError,
  MAX_CLOCK_SKEW_MS,
  contentClock,
  contentWins,
  editedAtWins,
  type StoredAttachment,
  type StoredMessage,
} from './dmModel';
import { dispatchFor, type DmOutbox } from './dmOutbox';
import { MAX_EMOJI_LENGTH, isDmId, isRecord, parseWireMessage, sanitizeAttachmentMeta, storedMessage, type ParsedMessage } from './dmWire';

/** Deletes of messages this device never had, remembered per conversation. */
const MAX_TOMBSTONES = 500;

/**
 * The messages of each conversation (#743): what this device sends, edits,
 * deletes, reacts to and reads, and the same operations coming from the friend
 * or from another own device. Text and reactions follow last-writer-wins
 * clocks, so every device ends with the same conversation whatever order the
 * operations reach it in, and a delete is final.
 */
export class DmConversations {
  constructor(
    private readonly ledger: DmLedger,
    private readonly outbox: DmOutbox,
    private readonly files: DmFiles,
  ) {}

  openConversation(peerKey: string): void {
    const peer = this.ledger.requirePeerKey(peerKey);
    if (!this.ledger.state.peers[peer]) throw new DmError('not-found', 'Conversa não encontrada.');
    this.ledger.meta(peer).hidden = false;
    this.ledger.changed();
  }

  closeConversation(peerKey: string): void {
    const peer = this.ledger.requirePeerKey(peerKey);
    const meta = this.ledger.state.conversations[peer];
    if (!meta) return;
    meta.hidden = true;
    this.ledger.changed();
  }

  sendMessage(input: DmSendMessageInput): DmDispatch {
    const record = this.ledger.requireFriend(input.peer);
    const peer = record.publicKey;
    const content = typeof input.content === 'string' ? input.content.replace(/\r\n/g, '\n').trim() : '';
    const files = Array.isArray(input.files) ? input.files : [];
    if (!content && files.length === 0) throw new DmError('empty-message', 'Mensagem vazia.');
    if (content.length > DM_MAX_MESSAGE_LENGTH) {
      throw new DmError('message-too-long', 'Mensagem muito longa.', { limit: DM_MAX_MESSAGE_LENGTH });
    }
    if (files.length > DM_MAX_ATTACHMENTS) {
      throw new DmError('too-many-files', 'Arquivos demais.', { limit: DM_MAX_ATTACHMENTS });
    }
    for (const file of files) {
      const size = file?.data?.byteLength ?? 0;
      if (size > record.maxFileBytes) {
        throw new DmError('file-too-large', 'Arquivo acima do limite do amigo.', {
          limit: record.maxFileBytes,
          nickname: record.nickname,
          name: file?.name ?? '',
        });
      }
    }
    const replyTo = input.replyTo && this.ledger.findMessage(peer, input.replyTo) ? input.replyTo : null;
    const forwarded = sanitizeDmForward(input.forwarded);
    const attachments: StoredAttachment[] = files.map((file) => {
      const data = Buffer.from(file.data);
      const meta = sanitizeAttachmentMeta({
        fileId: newDmId(),
        name: file.name,
        size: data.length,
        mime: file.mime,
        sha256: createHash('sha256').update(data).digest('hex'),
      })!;
      this.ledger.store.writeAttachment(meta.fileId, data);
      return { ...meta, state: 'local', receivedBytes: meta.size };
    });
    const id = newDmId();
    const ts = this.ledger.stamp();
    const message: StoredMessage = {
      id,
      author: this.ledger.me,
      content,
      createdAt: ts,
      editedAt: null,
      deleted: false,
      replyTo,
      reactions: {},
      attachments,
      delivery: 'pending',
      forwarded,
    };
    const meta = this.ledger.meta(peer);
    meta.hidden = false;
    this.insertMessage(peer, message);
    meta.lastReadAt = Math.max(meta.lastReadAt, ts);
    this.ledger.refreshMeta(peer);
    const body = {
      content,
      replyTo,
      attachments: attachments.map(({ fileId, name, size, mime, sha256 }) => ({ fileId, name, size, mime, sha256 })),
      // Optional so the body of a plain message stays as older clients expect; they ignore the field.
      ...(forwarded ? { forwarded } : {}),
    };
    const item = this.outbox.queueEnvelope(record, 'msg', body, id, ts);
    this.ledger.changed(peer);
    this.ledger.emitMessages(peer, [message]);
    return dispatchFor(peer, [item], [this.outbox.selfCopy(peer, 'msg', id, ts, body)]);
  }

  editMessage(peerKey: string, messageId: string, contentInput: string): DmDispatch {
    const record = this.ledger.requireFriend(peerKey);
    const peer = record.publicKey;
    const message = this.ledger.findMessage(peer, messageId);
    if (!message || message.author !== this.ledger.me || message.deleted) throw new DmError('not-found', 'Mensagem não encontrada.');
    const content = typeof contentInput === 'string' ? contentInput.replace(/\r\n/g, '\n').trim() : '';
    if (!content && message.attachments.length === 0) throw new DmError('empty-message', 'Mensagem vazia.');
    if (content.length > DM_MAX_MESSAGE_LENGTH) {
      throw new DmError('message-too-long', 'Mensagem muito longa.', { limit: DM_MAX_MESSAGE_LENGTH });
    }
    if (content === message.content) return {};
    // Newer than every edit of it this device has seen, so it wins on every device even when clocks disagree.
    const editedAt = Math.max(this.ledger.stamp(), contentClock(message) + 1);
    this.ledger.observeStamp(editedAt);
    message.content = content;
    message.editedAt = editedAt;
    message.contentAt = editedAt;
    this.ledger.refreshMeta(peer);
    const body = { messageId, content, editedAt };
    const items: Array<DmRelayItem | null> = [];
    const pendingMessage = this.outbox.entries(peer).find((entry) => entry.id === messageId && entry.type === 'msg');
    if (pendingMessage && isRecord(pendingMessage.body)) {
      // A copy not confirmed yet carries the new text and its clock, so whoever gets it from now on sees the
      // final version, and an older edit still on its way cannot replace it. Older versions ignore the clock.
      pendingMessage.body = { ...pendingMessage.body, content, contentAt: editedAt };
      items.push(this.outbox.item(record, pendingMessage));
    }
    // "Pending" only means no ack came back: the friend may already have the old text, so the edit always
    // goes out too. Only the newest edit matters (last writer wins), so older queued ones are dropped.
    this.outbox.dropQueued(peer, messageId, ['edit']);
    items.push(this.outbox.queueEnvelope(record, 'edit', body));
    this.ledger.changed(peer);
    this.ledger.emitMessages(peer, [message]);
    return dispatchFor(peer, items, [this.outbox.selfCopy(peer, 'edit', newDmId(), editedAt, body)]);
  }

  deleteMessage(peerKey: string, messageId: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.state.peers[peer];
    const message = this.ledger.findMessage(peer, messageId);
    if (!record || !message || message.deleted) throw new DmError('not-found', 'Mensagem não encontrada.');
    if (message.author !== this.ledger.me) throw new DmError('forbidden', 'Só é possível apagar as próprias mensagens.');
    this.markDeleted(message);
    this.ledger.refreshMeta(peer);
    const body = { messageId };
    const items: Array<DmRelayItem | null> = [];
    // A copy still queued never reaches anyone new, and neither do edits of it. But "pending" only means no
    // ack came back: the friend may have the message already, so the delete always goes out.
    this.outbox.dropQueued(peer, messageId, ['msg', 'edit', 'react', 'delete']);
    if (record.relation === 'friend' && !record.blocked && record.cert) {
      items.push(this.outbox.queueEnvelope(record, 'delete', body));
    }
    this.ledger.changed(peer);
    this.ledger.emitMessages(peer, [message]);
    return dispatchFor(peer, items, [this.outbox.selfCopy(peer, 'delete', newDmId(), this.ledger.stamp(), body)]);
  }

  react(peerKey: string, messageId: string, emojiInput: string, add: boolean): DmDispatch {
    const record = this.ledger.requireFriend(peerKey);
    const peer = record.publicKey;
    const message = this.ledger.findMessage(peer, messageId);
    if (!message || message.deleted) throw new DmError('not-found', 'Mensagem não encontrada.');
    const emoji = typeof emojiInput === 'string' ? emojiInput.trim().slice(0, MAX_EMOJI_LENGTH) : '';
    if (!emoji) throw new DmError('empty-message', 'Reação inválida.');
    const ts = this.ledger.stamp();
    this.applyReaction(message, this.ledger.me, emoji, add !== false, ts);
    const body = { messageId, emoji, add: add !== false, at: ts };
    const item = this.outbox.queueEnvelope(record, 'react', body);
    this.ledger.changed(peer);
    this.ledger.emitMessages(peer, [message]);
    return dispatchFor(peer, [item], [this.outbox.selfCopy(peer, 'react', newDmId(), ts, body)]);
  }

  markRead(peerKey: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const meta = this.ledger.state.conversations[peer];
    if (!meta) return {};
    const lastIncoming = [...this.ledger.conversation(peer).messages]
      .reverse()
      .find((message) => message.author !== this.ledger.me && !message.deleted);
    const readAt = Math.max(meta.lastReadAt, lastIncoming?.createdAt ?? 0);
    if (meta.unread === 0 && readAt === meta.lastReadAt) return {};
    const advanced = readAt > meta.lastReadAt;
    meta.lastReadAt = readAt;
    meta.unread = 0;
    this.ledger.changed();
    if (!advanced) return {};
    const body = { readAt };
    const broadcast = [this.outbox.selfCopy(peer, 'read', newDmId(), this.ledger.stamp(), body)];
    const record = this.ledger.state.peers[peer];
    if (!record || record.relation !== 'friend' || record.blocked || !record.cert) {
      return { broadcast };
    }
    this.outbox.dropReadReceipts(peer);
    const item = this.outbox.queueEnvelope(record, 'read', body);
    return dispatchFor(peer, [item], broadcast);
  }

  typing(peerKey: string): DmDispatch {
    const record = this.ledger.requireFriend(peerKey);
    return dispatchFor(record.publicKey, [this.outbox.envelopeItem(record, 'typing', {})]);
  }

  /**
   * Applies a conversation operation. `author` is who performed it: the peer,
   * or this identity for copies coming from another own device.
   */
  applyOp(
    peer: string,
    author: string,
    header: Pick<DmEnvelopeHeader, 'id' | 'type' | 'ts'>,
    data: Record<string, unknown>,
    fromPeer: boolean
  ): DmRelayItem[] {
    const now = this.ledger.now();
    const ts = Math.min(header.ts, now + MAX_CLOCK_SKEW_MS);
    const meta = this.ledger.meta(peer);
    switch (header.type) {
      case 'msg': {
        // The author's timestamp is kept as-is so every device shares one time base for order and read receipts.
        // `contentAt` is set when the author edited it while it waited for delivery: older edits on their way
        // stay behind it. Only these fields come from the body.
        const parsed = parseWireMessage({
          id: header.id,
          author,
          createdAt: ts,
          content: data.content,
          replyTo: data.replyTo,
          attachments: data.attachments,
          forwarded: data.forwarded,
          contentAt: data.contentAt,
        }, { me: this.ledger.me, peer, limit: now + MAX_CLOCK_SKEW_MS });
        // Deleted before it got here: the delete that came first is final.
        if (!parsed || this.isTombstoned(peer, parsed.id, author)) return [];
        if (!parsed.content && parsed.attachments.length === 0) return [];
        const attachments = this.receivedAttachments(parsed, fromPeer);
        const message = storedMessage(parsed, false, attachments, this.ledger.me);
        if (!this.insertMessage(peer, message)) return [];
        this.ledger.observeStamp(Math.max(message.createdAt, message.contentAt ?? 0));
        meta.hidden = false;
        if (author === this.ledger.me) {
          meta.lastReadAt = Math.max(meta.lastReadAt, message.createdAt);
        }
        this.ledger.refreshMeta(peer);
        const replies: DmRelayItem[] = [];
        for (const file of attachments) {
          if (file.state !== 'pending') continue;
          const request = this.files.startDownload(peer, message.id, file, now);
          if (request) replies.push(request);
        }
        this.ledger.changed(peer);
        this.ledger.emitMessages(peer, [message]);
        if (author !== this.ledger.me) {
          this.ledger.emit({ type: 'incoming-message', peer, message: this.ledger.messageView(peer, message) });
        }
        return replies;
      }
      case 'edit': {
        const message = this.ledger.findMessage(peer, data.messageId);
        if (!message || message.author !== author || message.deleted) return [];
        const content = typeof data.content === 'string' ? data.content.slice(0, DM_MAX_MESSAGE_LENGTH) : '';
        const editedAt = typeof data.editedAt === 'number' ? Math.min(data.editedAt, now + MAX_CLOCK_SKEW_MS) : ts;
        // Last writer wins by the text's own clock, which also moves when the text stays: otherwise an older edit
        // arriving later (A → B → A, delivered out of order) would leave each side with a different text.
        if (!contentWins(editedAt, content, message)) return [];
        message.contentAt = editedAt;
        this.ledger.observeStamp(editedAt);
        // Same text as shown (it arrived already edited, or went back to it): nothing to mark as edited.
        if (content !== message.content) {
          message.content = content;
          message.editedAt = editedAt;
          this.ledger.refreshMeta(peer);
          this.ledger.emitMessages(peer, [message]);
        }
        this.ledger.changed(peer);
        return [];
      }
      case 'delete': {
        const message = this.ledger.findMessage(peer, data.messageId);
        if (!message) {
          // Deleted before it got here (or its ack was lost and it is still on the way): keep it out for good.
          if (isDmId(data.messageId)) {
            this.addTombstone(peer, data.messageId, author);
            this.ledger.saveConversation(peer);
          }
          return [];
        }
        if (message.author !== author || message.deleted) return [];
        this.markDeleted(message);
        this.ledger.refreshMeta(peer);
        this.ledger.changed(peer);
        this.ledger.emitMessages(peer, [message]);
        return [];
      }
      case 'react': {
        const message = this.ledger.findMessage(peer, data.messageId);
        const emoji = typeof data.emoji === 'string' ? data.emoji.trim().slice(0, MAX_EMOJI_LENGTH) : '';
        if (!message || message.deleted || !emoji) return [];
        const at = typeof data.at === 'number' ? Math.min(data.at, now + MAX_CLOCK_SKEW_MS) : ts;
        if (this.applyReaction(message, author, emoji, data.add !== false, at)) {
          this.ledger.changed(peer);
          this.ledger.emitMessages(peer, [message]);
        }
        return [];
      }
      case 'read': {
        const readAt = typeof data.readAt === 'number' ? Math.min(data.readAt, now + MAX_CLOCK_SKEW_MS) : 0;
        if (author === this.ledger.me) {
          if (readAt > meta.lastReadAt) {
            meta.lastReadAt = readAt;
            this.ledger.refreshMeta(peer);
            this.ledger.changed();
          }
          return [];
        }
        if (readAt > meta.peerReadAt) {
          meta.peerReadAt = readAt;
          this.ledger.changed();
          const own = this.ledger.conversation(peer).messages.filter(
            (message) => message.author === this.ledger.me && message.createdAt <= readAt && message.createdAt > readAt - 60 * 60_000
          );
          this.ledger.emitMessages(peer, own);
        }
        return [];
      }
      default:
        return [];
    }
  }

  /** Merges history another own device sent: union of messages, deletes win, edits and reactions by timestamp. */
  mergeHistory(peer: string, messages: unknown[]): void {
    const scope = { me: this.ledger.me, peer, limit: this.ledger.now() + MAX_CLOCK_SKEW_MS };
    const meta = this.ledger.meta(peer);
    const changedMessages: StoredMessage[] = [];
    let inserted = false;
    for (const raw of messages.slice(0, 2000)) {
      const parsed = parseWireMessage(raw, scope);
      if (!parsed) continue;
      const { author, content, editedAt, contentAt } = parsed;
      // A delete that reached this device before the message itself also holds for copies from other devices.
      const deleted = parsed.deleted || this.isTombstoned(peer, parsed.id, author);
      const existing = this.ledger.findMessage(peer, parsed.id);
      if (!existing) {
        const attachments = deleted ? [] : this.receivedAttachments(parsed, false);
        if (!deleted && !content && attachments.length === 0) continue;
        const message = storedMessage(parsed, deleted, attachments, this.ledger.me);
        if (!this.insertMessage(peer, message)) continue;
        this.ledger.observeStamp(Math.max(message.createdAt, message.contentAt ?? 0));
        if (author === this.ledger.me) meta.lastReadAt = Math.max(meta.lastReadAt, message.createdAt);
        changedMessages.push(message);
        inserted = true;
        continue;
      }
      if (existing.author !== author) continue;
      let dirty = false;
      if (deleted && !existing.deleted) {
        this.markDeleted(existing);
        dirty = true;
      } else if (!existing.deleted && !deleted && contentAt !== null && contentWins(contentAt, content, existing)) {
        // The text follows its own clock, so every device ends with the same text whatever order the edits
        // reached them in.
        existing.content = content;
        existing.contentAt = contentAt;
        this.ledger.observeStamp(contentAt);
        dirty = true;
      }
      // The "edited" mark keeps the newest either device has, deleted or not: both sides of a merge end with the
      // same one in this round, even when the delete reached them after different edits.
      if (editedAtWins(editedAt, existing)) {
        existing.editedAt = editedAt;
        dirty = true;
      }
      if (!existing.deleted) {
        for (const [emoji, users] of Object.entries(parsed.reactions)) {
          for (const [user, value] of Object.entries(users)) {
            if (this.applyReaction(existing, user, emoji, value.on, value.ts)) dirty = true;
          }
        }
      }
      if (dirty) changedMessages.push(existing);
    }
    if (changedMessages.length > 0) {
      if (inserted) meta.hidden = false;
      this.ledger.refreshMeta(peer);
      this.ledger.changed(peer);
      this.ledger.emitMessages(peer, changedMessages);
    }
  }

  /** The messages of a backup, read like the history of another own device: all of them read, their files unavailable. */
  importHistory(peer: string, messages: unknown[], limit: number): void {
    const meta = this.ledger.meta(peer);
    for (const raw of messages) {
      const parsed = parseWireMessage(raw, { me: this.ledger.me, peer, limit });
      if (!parsed) continue;
      const deleted = parsed.deleted || this.isTombstoned(peer, parsed.id, parsed.author);
      if (!deleted && !parsed.content && parsed.attachments.length === 0) continue;
      const attachments = parsed.attachments.map<StoredAttachment>((file) => ({ ...file, state: 'unavailable', receivedBytes: 0 }));
      this.insertMessage(peer, storedMessage(parsed, deleted, attachments, this.ledger.me));
    }
    meta.hidden = false;
    meta.lastReadAt = Math.max(meta.lastReadAt, meta.lastMessageAt);
    this.ledger.refreshMeta(peer);
    this.ledger.saveConversation(peer);
  }

  /**
   * The files of a message this device just learned of, as it holds them.
   * Only the files of a message that came from the friend are downloaded:
   * another own device never has more than its copy of the message.
   */
  private receivedAttachments(parsed: ParsedMessage, download: boolean): StoredAttachment[] {
    return parsed.attachments.map((file) => {
      let state: DmAttachmentState = 'unavailable';
      if (this.ledger.store.hasAttachment(file.fileId)) state = parsed.author === this.ledger.me ? 'local' : 'ready';
      else if (download) state = file.size > this.ledger.state.settings.maxFileBytes ? 'too-large' : 'pending';
      return { ...file, state, receivedBytes: state === 'ready' || state === 'local' ? file.size : 0 };
    });
  }

  private insertMessage(peer: string, message: StoredMessage): boolean {
    const conversation = this.ledger.conversation(peer);
    if (conversation.messages.some((existing) => existing.id === message.id)) return false;
    let index = conversation.messages.length;
    // Equal timestamps only happen across authors; the id keeps every device in the same order.
    while (
      index > 0 &&
      (conversation.messages[index - 1].createdAt > message.createdAt ||
        (conversation.messages[index - 1].createdAt === message.createdAt && conversation.messages[index - 1].id > message.id))
    ) {
      index -= 1;
    }
    conversation.messages.splice(index, 0, message);
    this.ledger.refreshMeta(peer);
    return true;
  }

  private isTombstoned(peer: string, id: string, author: string): boolean {
    const tombstones = this.ledger.conversation(peer).tombstones;
    return Array.isArray(tombstones) && tombstones.some((entry) => entry.id === id && entry.author === author);
  }

  private addTombstone(peer: string, id: string, author: string): void {
    const conversation = this.ledger.conversation(peer);
    if (!Array.isArray(conversation.tombstones)) conversation.tombstones = [];
    if (this.isTombstoned(peer, id, author)) return;
    conversation.tombstones.push({ id, author });
    if (conversation.tombstones.length > MAX_TOMBSTONES) {
      conversation.tombstones.splice(0, conversation.tombstones.length - MAX_TOMBSTONES);
    }
  }

  private markDeleted(message: StoredMessage): void {
    message.deleted = true;
    message.content = '';
    for (const file of message.attachments) this.files.forget(file.fileId);
    message.attachments = [];
    message.reactions = {};
    message.forwarded = null;
  }

  private applyReaction(message: StoredMessage, user: string, emoji: string, on: boolean, ts: number): boolean {
    const users = (message.reactions[emoji] ??= {});
    const current = users[user];
    if (current && current.ts >= ts) return false;
    users[user] = { on, ts };
    return true;
  }
}
