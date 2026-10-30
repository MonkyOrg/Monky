import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { MessageType } from '@monky/shared';
import { AttachmentService } from './application/services/AttachmentService';
import { createHttpRequestListener } from './infrastructure/http/HttpRouter';
import { attachmentRoutes } from './infrastructure/http/attachmentRoutes';
import { AttachmentStorageService } from './infrastructure/security/AttachmentStorageService';
import { createApprovedBotFixture, record, records, text, type Received } from './testFixtures/bots';

type Fixture = Awaited<ReturnType<typeof createApprovedBotFixture>>;

interface StoredAttachment {
  id: string;
  filename: string;
  filePath: string;
}

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** What an upload leaves: the file under attachments/ and a pending row. */
async function storeAttachment(f: Fixture, userId: string, channelId: string): Promise<StoredAttachment> {
  const id = randomUUID();
  const filename = `${randomUUID()}.png`;
  const filePath = path.join(f.dataDir, 'attachments', filename);
  fs.writeFileSync(filePath, PNG_BYTES);
  await f.attachmentRepo.create({
    id, messageId: null, channelId, userId, kind: 'image', filename, originalName: 'photo.png', mimeType: 'image/png',
    sizeBytes: PNG_BYTES.length, width: null, height: null, durationMs: null, evicted: false, createdAt: Date.now(),
  });
  return { id, filename, filePath };
}

async function assertRemoved(f: Fixture, ...attachments: StoredAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    assert.equal(fs.existsSync(attachment.filePath), false, `${attachment.filename} is still on disk`);
    assert.deepEqual(await f.attachmentRepo.findByIds([attachment.id]), [], `${attachment.id} is still listed`);
  }
}

async function assertKept(f: Fixture, ...attachments: StoredAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    assert.ok(fs.existsSync(attachment.filePath), `${attachment.filename} was removed`);
    assert.equal((await f.attachmentRepo.findByIds([attachment.id])).length, 1, `${attachment.id} was removed`);
  }
}

/** Status of the public URL of an attachment, through the real download route. */
async function attachmentUrls(t: test.TestContext, f: Fixture): Promise<(filename: string) => Promise<number>> {
  const storage = new AttachmentStorageService(f.dataDir);
  const server = http.createServer(createHttpRequestListener(attachmentRoutes({
    attachments: new AttachmentService(f.attachmentRepo, f.serverRepo, storage, f.rateLimiter),
    storage,
    canUpload: async () => false,
  })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return async (filename) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/attachments/${filename}`);
    await response.arrayBuffer();
    return response.status;
  };
}

function firstTextChannel(auth: Received): string {
  return text(records(record(auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
}

test('a deleted message keeps its files through the undo window and loses them, and their URL, once it expires (S-APP-6)', async (t) => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Attachment owner');
  const channelId = firstTextChannel(owner.auth);
  const status = await attachmentUrls(t, f);
  const kept = await storeAttachment(f, owner.id, channelId);
  const removed = await storeAttachment(f, owner.id, channelId);
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'stays', attachmentIds: [kept.id] });
  const messageId = text((await owner.peer.request(MessageType.CHAT_SEND, {
    channelId, content: 'goes', attachmentIds: [removed.id],
  })).payload.id);

  const deletion = record((await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId })).payload.message);
  await f.chatService.expireDeletedMessages();
  await assertKept(f, removed);
  const restored = await owner.peer.request(MessageType.CHAT_RESTORE, {
    channelId, messageId, deletedAt: deletion.deletedAt, revision: deletion.revision,
  });
  assert.equal(records(record(restored.payload.message).attachments).length, 1, 'undoing brings the file back');

  const final = record((await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId })).payload.message);
  assert.equal(await status(removed.filename), 200);
  const now = t.mock.method(Date, 'now', () => Number(final.deleteUndoUntil));
  await f.chatService.expireDeletedMessages();
  now.mock.restore();

  await assertRemoved(f, removed);
  assert.equal(await status(removed.filename), 404, 'the old URL no longer serves the file');
  await assertKept(f, kept);
  assert.equal(await status(kept.filename), 200);
});

for (const foreignKeys of ['ON', 'OFF'] as const) {
  test(`deleting a channel, a forum post, a forum with its topics or the AFK room removes their files (foreign keys ${foreignKeys}, S-APP-6)`, async (t) => {
    const f = await createApprovedBotFixture();
    t.after(() => f.dispose());
    // Production loses the foreign keys after its first save (S-APP-1): no cascade may be relied upon.
    f.database.getDb().exec(`PRAGMA foreign_keys = ${foreignKeys}`);
    const owner = await f.human('Channel owner');
    const generalId = firstTextChannel(owner.auth);
    const untouched = await storeAttachment(f, owner.id, generalId);
    await owner.peer.request(MessageType.CHAT_SEND, { channelId: generalId, content: 'elsewhere', attachmentIds: [untouched.id] });

    const doomedId = text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Doomed', type: 'TEXT' })).payload.channel).id);
    const sent = await storeAttachment(f, owner.id, doomedId);
    await owner.peer.request(MessageType.CHAT_SEND, { channelId: doomedId, content: 'bye', attachmentIds: [sent.id] });
    const pending = await storeAttachment(f, owner.id, doomedId);
    assert.equal((await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: doomedId })).type, MessageType.CHANNEL_DELETED);
    await assertRemoved(f, sent, pending);

    const forum = (await f.channelService.createChannel({ name: 'Board', type: 'FORUM' })).channel;
    assert.ok(forum);
    const postFile = await storeAttachment(f, owner.id, forum.id);
    const post = await f.forumService.create(owner.id, {
      id: randomUUID(), channelId: forum.id, title: 'Post', content: 'with a file', attachmentIds: [postFile.id],
    }, () => true);
    await f.forumService.delete(owner.id, { channelId: post.post.channelId }, () => true);
    await assertRemoved(f, postFile);

    const topicFile = await storeAttachment(f, owner.id, forum.id);
    await f.forumService.create(owner.id, {
      id: randomUUID(), channelId: forum.id, title: 'Topic', content: 'goes with the forum', attachmentIds: [topicFile.id],
    }, () => true);
    const forumPending = await storeAttachment(f, owner.id, forum.id);
    assert.equal((await f.channelService.deleteChannel(forum.id)).success, true);
    await assertRemoved(f, topicFile, forumPending);

    const afk = (await f.channelService.createAfkChannel('AFK')).channel;
    assert.ok(afk);
    const afkFile = await storeAttachment(f, owner.id, afk.id);
    assert.equal(await f.channelService.removeAfkChannel(), afk.id);
    await assertRemoved(f, afkFile);

    await assertKept(f, untouched);
  });
}

test('the startup reconciliation removes the files earlier deletions left behind (S-APP-6)', async (t) => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const db = f.database.getDb();
  // The state production accumulated: deletions ran without foreign keys (S-APP-1).
  db.exec('PRAGMA foreign_keys = OFF');
  const owner = await f.human('Legacy owner');
  const channelId = firstTextChannel(owner.auth);
  const send = async (target: string, attachment: StoredAttachment): Promise<string> => {
    const sent = await f.chatService.sendMessage(owner.id, target, 'with a file', [attachment.id]);
    assert.ok(sent.success && sent.message);
    return sent.message.id;
  };

  const live = await storeAttachment(f, owner.id, channelId);
  await send(channelId, live);
  const recentUpload = await storeAttachment(f, owner.id, channelId);
  const undoable = await storeAttachment(f, owner.id, channelId);
  const undoableMessage = await send(channelId, undoable);
  assert.equal((await f.chatService.deleteMessage(owner.id, channelId, undoableMessage, true)).success, true);

  const deletedLongAgo = await storeAttachment(f, owner.id, channelId);
  await f.messageRepo.markDeleted(await send(channelId, deletedLongAgo), Date.now() - 1000);
  const undoExpired = await storeAttachment(f, owner.id, channelId);
  await f.messageRepo.markDeleted(await send(channelId, undoExpired), Date.now() - 120_000, owner.id, Date.now() - 60_000);

  const goneChannel = (await f.channelService.createChannel({ name: 'Gone', type: 'TEXT' })).channel;
  assert.ok(goneChannel);
  const goneMessage = await storeAttachment(f, owner.id, goneChannel.id);
  await send(goneChannel.id, goneMessage);
  const gonePending = await storeAttachment(f, owner.id, goneChannel.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(goneChannel.id);

  const forum = (await f.channelService.createChannel({ name: 'Old board', type: 'FORUM' })).channel;
  assert.ok(forum);
  const orphanTopic = await storeAttachment(f, owner.id, forum.id);
  await f.forumService.create(owner.id, {
    id: randomUUID(), channelId: forum.id, title: 'Orphan', content: 'outlived its forum', attachmentIds: [orphanTopic.id],
  }, () => true);
  db.prepare('DELETE FROM channels WHERE id = ?').run(forum.id);

  const strayFile = path.join(f.dataDir, 'attachments', `${randomUUID()}.png`);
  fs.writeFileSync(strayFile, PNG_BYTES);

  await new AttachmentService(f.attachmentRepo, f.serverRepo, new AttachmentStorageService(f.dataDir), f.rateLimiter).reconcile();

  await assertRemoved(f, deletedLongAgo, undoExpired, goneMessage, gonePending, orphanTopic);
  await assertKept(f, live, recentUpload, undoable);
  assert.equal(fs.existsSync(strayFile), false, 'a file without a row is still collected');
});
