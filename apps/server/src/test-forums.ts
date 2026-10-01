import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MessageType, Permission, ProtocolErrorCode } from '@monky/shared';
import { createFixture, record, records, text } from './testFixtures/bots';
import { ForumError } from './application/services/ForumService';

async function setup(t: test.TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Forum owner');
  const member = await f.human('Forum member');
  const result = await f.channelService.createChannel({ name: 'Discussions', type: 'FORUM' });
  assert.ok(result.channel);
  return { ...f, owner, member, forum: result.channel };
}

test('forum posts are durable text threads, support idempotent retries, replies and search', async t => {
  const f = await setup(t);
  const payload = { id: randomUUID(), channelId: f.forum.id, title: 'First discussion', content: 'searchable forum text' };
  const result = await f.forumService.create(f.member.id, payload, () => true);
  assert.equal(result.post.replyCount, 0);
  assert.equal((await f.channelService.getChannelSummary(result.post.channelId))?.forumId, f.forum.id);
  assert.equal((await f.forumService.create(f.member.id, payload, () => true)).post.channelId, result.post.channelId);
  assert.equal((await f.forumService.list(f.member.id, { channelId: f.forum.id }, () => true)).posts.length, 1);
  const reply = await f.chatService.sendMessage(f.member.id, result.post.channelId, 'A reply');
  assert.equal(reply.success, true);
  assert.equal((await f.forumService.list(f.member.id, { channelId: f.forum.id }, () => true)).posts[0].replyCount, 1);
  assert.equal((await f.searchService.search(f.member.id, { query: 'searchable' })).messages[0].channelId, result.post.channelId);
  assert.deepEqual(f.database.getDb().prepare('PRAGMA foreign_key_check').all(), []);
});

test('forum privacy follows the parent immediately across direct history/search paths', async t => {
  const f = await setup(t);
  const post = await f.forumService.create(f.member.id, {
    id: randomUUID(), channelId: f.forum.id, title: 'Private later', content: 'hidden keyword',
  }, () => true);
  await f.channelService.updateChannel({ channelId: f.forum.id, isPrivate: true, allowedRoleIds: [], inheritCategoryPermissions: false });
  assert.equal(await f.channelService.canUserAccessChannel(f.member.id, post.post.channelId), false);
  assert.equal((await f.channelService.getChannelSummary(post.post.channelId))?.isPrivate, true);
  await assert.rejects(f.forumService.list(f.member.id, { channelId: f.forum.id }, () => true), ForumError);
  assert.equal((await f.searchService.search(f.member.id, { query: 'hidden' })).messages.length, 0);
  await f.member.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: post.post.channelId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  assert.equal((await f.channelService.updateChannel({ channelId: post.post.channelId, isPrivate: false })).success, false);
});

test('moderators lock threads while authors close them, and both states block replies', async t => {
  const f = await setup(t);
  const post = await f.forumService.create(f.member.id, {
    id: randomUUID(), channelId: f.forum.id, title: 'Moderated', content: 'Discussion',
  }, () => true);
  await assert.rejects(f.forumService.update(f.member.id, { channelId: post.post.channelId, pinned: true }, () => true), ForumError);
  await assert.rejects(f.forumService.update(f.owner.id, { channelId: post.post.channelId, closed: true }, () => true), ForumError);
  await f.forumService.update(f.owner.id, { channelId: post.post.channelId, pinned: true, locked: true }, () => true);
  assert.equal((await f.chatService.sendMessage(f.member.id, post.post.channelId, 'Blocked')).success, false);
  await assert.rejects(f.messageRepo.create({
    id: randomUUID(), channelId: post.post.channelId, userId: f.member.id, content: 'Blocked race', createdAt: Date.now(),
  }), /not accepting/);
  await f.forumService.update(f.owner.id, { channelId: post.post.channelId, locked: false }, () => true);
  await f.forumService.update(f.member.id, { channelId: post.post.channelId, closed: true }, () => true);
  assert.equal((await f.chatService.sendMessage(f.member.id, post.post.channelId, 'Still blocked')).success, false);
  await assert.rejects(f.forumService.update(f.owner.id, { channelId: post.post.channelId, closed: false }, () => true), ForumError);
  await f.forumService.update(f.member.id, { channelId: post.post.channelId, closed: false }, () => true);
  assert.equal((await f.chatService.sendMessage(f.member.id, post.post.channelId, 'Allowed')).success, true);
});

test('authors and moderators can delete threads while other members cannot', async t => {
  const f = await setup(t);
  const outsider = await f.human('Forum outsider');
  const authored = await f.forumService.create(f.member.id, {
    id: randomUUID(), channelId: f.forum.id, title: 'Author deletion', content: 'Delete me',
  }, () => true);
  await assert.rejects(f.forumService.delete(outsider.id, { channelId: authored.post.channelId }, () => true), ForumError);
  const deletedByAuthor = await f.forumService.delete(f.member.id, { channelId: authored.post.channelId }, () => true);
  assert.equal(deletedByAuthor.deleted, true);
  assert.equal(await f.channelRepo.findById(authored.post.channelId), null);

  const moderated = await f.forumService.create(f.member.id, {
    id: randomUUID(), channelId: f.forum.id, title: 'Moderator deletion', content: 'Delete me too',
  }, () => true);
  await f.forumService.delete(f.owner.id, { channelId: moderated.post.channelId }, () => true);
  assert.equal(await f.channelRepo.findById(moderated.post.channelId), null);
  assert.deepEqual(f.database.getDb().prepare('PRAGMA foreign_key_check').all(), []);
});

test('failed initial messages roll back posts; deleting forums cascades posts/messages and FTS', async t => {
  const f = await setup(t);
  await assert.rejects(f.forumService.create(f.member.id, {
    id: randomUUID(), channelId: f.forum.id, title: 'Invalid', content: 'x'.repeat(20000),
  }, () => true), ForumError);
  assert.equal((await f.forumService.list(f.member.id, { channelId: f.forum.id }, () => true)).posts.length, 0);
  const created = await f.forumService.create(f.member.id, {
    id: randomUUID(), channelId: f.forum.id, title: 'Valid', content: 'Cascade',
  }, () => true);
  await f.channelRepo.delete(f.forum.id);
  assert.equal(await f.channelRepo.findById(created.post.channelId), null);
  assert.equal(await f.messageRepo.findById(created.post.firstMessageId!), null);
  assert.deepEqual(f.database.getDb().prepare('PRAGMA foreign_key_check').all(), []);
});

test('WebSocket community, forum and search routes preserve request IDs and publish child channels before navigation', async t => {
  const f = await setup(t);
  const enabled = await f.owner.peer.request(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: true });
  assert.equal(enabled.type, MessageType.COMMUNITY_ACK);
  const snapshot = await f.member.peer.request(MessageType.COMMUNITY_GET);
  assert.equal(snapshot.type, MessageType.COMMUNITY_SNAPSHOT);
  assert.equal(record(snapshot.payload.settings).eventsEnabled, true);
  await f.member.peer.error(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: false }, ProtocolErrorCode.PERMISSION_DENIED);
  const created = await f.member.peer.request(MessageType.FORUM_CREATE_POST, {
    id: randomUUID(), channelId: f.forum.id, title: 'Socket discussion', content: 'Unique socket content',
  });
  assert.equal(created.type, MessageType.FORUM_POST_SAVED);
  const channelId = text(record(created.payload.post).channelId);
  assert.ok(f.member.peer.messages.some(message => message.type === MessageType.CHANNEL_CREATED &&
    text(record(message.payload.channel).id) === channelId));
  const list = await f.member.peer.request(MessageType.FORUM_LIST, { channelId: f.forum.id });
  assert.equal(list.type, MessageType.FORUM_LIST_RESULT);
  assert.equal(records(list.payload.posts).length, 1);
  const search = await f.member.peer.request(MessageType.CHAT_SEARCH, { query: 'Unique' });
  assert.equal(search.type, MessageType.CHAT_SEARCH_RESULTS);
  assert.equal(records(search.payload.messages)[0].channelId, channelId);
  const removed = await f.member.peer.request(MessageType.FORUM_DELETE_POST, { channelId });
  assert.equal(removed.type, MessageType.FORUM_POST_SAVED);
  assert.equal(record(removed.payload).deleted, true);
  assert.equal(records((await f.member.peer.request(MessageType.FORUM_LIST, { channelId: f.forum.id })).payload.posts).length, 0);
});

test('forum media stays owned and retries restore unattached files; previews and reaction counts follow deletion', async t => {
  const f = await setup(t);
  const attachmentId = randomUUID();
  await f.attachmentRepo.create({
    id: attachmentId, messageId: null, channelId: f.forum.id, userId: f.member.id, kind: 'image',
    filename: 'forum.png', originalName: 'forum.png', mimeType: 'image/png', sizeBytes: 12,
    width: 10, height: 10, durationMs: null, evicted: false, createdAt: Date.now(),
  });
  const payload = { id: randomUUID(), channelId: f.forum.id, title: 'Picture', content: '', attachmentIds: [attachmentId] };
  await assert.rejects(f.forumService.create(f.owner.id, payload, () => true), ForumError);
  const invalid = { ...payload, id: randomUUID(), content: 'x'.repeat(20000) };
  await assert.rejects(f.forumService.create(f.member.id, invalid, () => true), ForumError);
  const restored: { channelId: string; messageId: string | null } = f.database.getDb().prepare(
    'SELECT channel_id AS channelId, message_id AS messageId FROM message_attachments WHERE id = ?'
  ).get(attachmentId);
  assert.equal(restored.channelId, f.forum.id);
  assert.equal(restored.messageId, null);
  const created = await f.forumService.create(f.member.id, payload, () => true);
  assert.equal(created.post.thumbnailUrl, '/attachments/forum.png');
  assert.equal(created.message?.attachments?.[0].id, attachmentId);
  assert.ok(created.post.firstMessageId);
  assert.equal(await f.messageRepo.setReaction(created.post.firstMessageId, f.member.id, '\u{1F44D}', true), 'changed');
  assert.equal((await f.forumService.list(f.member.id, { channelId: f.forum.id }, () => true)).posts[0].reactionCount, 1);
  assert.equal((await f.chatService.sendMessage(f.member.id, created.post.channelId, 'Reply')).success, true);
  await f.messageRepo.markDeleted(created.post.firstMessageId, Date.now());
  const after = (await f.forumService.list(f.member.id, { channelId: f.forum.id }, () => true)).posts[0];
  assert.equal(after.replyCount, 1);
  assert.equal(after.thumbnailUrl, null);
  assert.equal(after.reactionCount, 0);
  assert.deepEqual(f.database.getDb().prepare('PRAGMA foreign_key_check').all(), []);
});

test('forum acknowledgement rechecks read permission after publishing the new channel', async t => {
  const f = await setup(t);
  const id = randomUUID();
  const checkPermission = f.permissions.checkPermission.bind(f.permissions);
  t.mock.method(f.permissions, 'checkPermission', async (userId: string, permission: number) => {
    if (userId === f.member.id && permission === Permission.READ_MESSAGES &&
        f.database.getDb().prepare('SELECT 1 FROM channels WHERE id = ?').get(id)) return false;
    return checkPermission(userId, permission);
  });
  await f.member.peer.error(MessageType.FORUM_CREATE_POST, {
    id, channelId: f.forum.id, title: 'Changed access', content: 'Private content',
  }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.ok(await f.channelRepo.findById(id));
  assert.equal(f.member.peer.messages.some(message => message.type === MessageType.FORUM_POST_SAVED), false);
  await f.owner.peer.request(MessageType.CHAT_SEND, { channelId: id, content: 'Private reply' });
  await f.member.peer.barrier();
  assert.equal(f.member.peer.messages.some(message =>
    message.type === MessageType.CHAT_MESSAGE && message.payload.channelId === id), false);
});
