import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MIN_CLIENT_PROTOCOL, MessageType, Permission, PROTOCOL_VERSION, ProtocolErrorCode, createProtocolOffer,
} from '@monky/shared';
import { createFixture, identity, record, records, text } from './testFixtures/bots';
import { SqliteMessageRepository } from './infrastructure/database/SqliteRepositories';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const legacyOffer = {
  minimumVersion: MIN_CLIENT_PROTOCOL,
  features: createProtocolOffer('client').features.filter(feature => feature !== 'message-forward'),
};

async function upload(f: Fixture, userId: string, channelId: string, originalName: string, sizeBytes: number, mimeType: string) {
  const id = randomUUID();
  await f.attachmentRepo.create({
    id, messageId: null, channelId, userId, kind: 'file', filename: `${id}.bin`, originalName, mimeType, sizeBytes,
    width: null, height: null, durationMs: null, evicted: false, createdAt: Date.now(),
  });
  return id;
}

async function setup(t: TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Forward owner');
  const member = await f.human('Forward member');
  const legacy = await f.human('Legacy reader', identity(), randomUUID(), false, PROTOCOL_VERSION, legacyOffer);
  const sourceChannelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const sourceName = text((await f.channelRepo.findById(sourceChannelId))?.name);
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'destination', type: 'TEXT' });
  const targetChannelId = text(record(created.payload.channel).id);
  const targetName = text(record(created.payload.channel).name);
  return { f, owner, member, legacy, sourceChannelId, sourceName, targetChannelId, targetName };
}

test('a forward of a readable message with the same text and files names its channel and survives history, search and edits', async t => {
  const { f, owner, member, legacy, sourceChannelId, sourceName, targetChannelId, targetName } = await setup(t);
  const files = [['notes.txt', 10, 'text/plain'], ['photo.png', 20, 'image/png']] as const;
  const originals = [];
  for (const [name, size, mime] of files) originals.push(await upload(f, owner.id, sourceChannelId, name, size, mime));
  const source = await owner.peer.request(MessageType.CHAT_SEND, {
    channelId: sourceChannelId, content: 'Original **text** findme', attachmentIds: originals,
  });
  assert.equal(source.type, MessageType.CHAT_MESSAGE);
  assert.equal('forwarded' in source.payload, false, 'Ordinary messages omit the marker');

  const copies = [];
  for (const [name, size, mime] of files) copies.push(await upload(f, member.id, targetChannelId, name, size, mime));
  const legacyMarker = legacy.peer.messages.length;
  const forwarded = await member.peer.request(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Original **text** findme', attachmentIds: copies,
    forward: { sourceMessageId: source.payload.id },
  });
  assert.equal(forwarded.type, MessageType.CHAT_MESSAGE);
  const expected = { source: `#${sourceName}`, createdAt: source.payload.createdAt };
  assert.deepEqual(forwarded.payload.forwarded, expected);
  const forwardedId = text(forwarded.payload.id);
  const ownerCopy = await owner.peer.wait(message => message.type === MessageType.CHAT_MESSAGE && message.payload.id === forwardedId);
  assert.deepEqual(ownerCopy.payload.forwarded, expected);
  const legacyCopy = await legacy.peer.wait(message =>
    message.type === MessageType.CHAT_MESSAGE && message.payload.id === forwardedId, legacyMarker);
  assert.equal('forwarded' in legacyCopy.payload, false, 'Peers without message-forward never receive the field');

  assert.deepEqual((await f.messageRepo.findById(forwardedId))?.forwarded, expected);
  const history = records((await owner.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: targetChannelId })).payload.messages);
  assert.deepEqual(history.find(message => message.id === forwardedId)?.forwarded, expected);
  const legacyHistory = records((await legacy.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: targetChannelId })).payload.messages);
  const legacyEntry = legacyHistory.find(message => message.id === forwardedId);
  assert.ok(legacyEntry);
  assert.equal('forwarded' in legacyEntry, false);
  const around = records((await owner.peer.request(MessageType.CHAT_LOAD_HISTORY, {
    channelId: targetChannelId, aroundMessageId: forwardedId,
  })).payload.messages);
  assert.deepEqual(around.find(message => message.id === forwardedId)?.forwarded, expected);
  const sourceHistory = records((await owner.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: sourceChannelId })).payload.messages);
  assert.equal('forwarded' in (sourceHistory.find(message => message.id === source.payload.id) ?? {}), false);

  const search = records((await owner.peer.request(MessageType.CHAT_SEARCH, {
    query: 'findme', channelIds: [targetChannelId],
  })).payload.messages);
  assert.deepEqual(search.find(message => message.id === forwardedId)?.forwarded, expected);
  const legacySearch = records((await legacy.peer.request(MessageType.CHAT_SEARCH, {
    query: 'findme', channelIds: [targetChannelId],
  })).payload.messages);
  assert.equal(legacySearch.some(message => message.id === forwardedId && 'forwarded' in message), false);
  assert.equal(legacySearch.some(message => message.id === forwardedId), true);

  const edited = await member.peer.request(MessageType.CHAT_EDIT, { channelId: targetChannelId, messageId: forwardedId, content: 'Edited copy' });
  assert.equal(edited.type, MessageType.CHAT_MESSAGE_UPDATED);
  assert.deepEqual(record(edited.payload.message).forwarded, expected, 'Editing keeps the marker');

  const recopies = [];
  for (const [name, size, mime] of files) recopies.push(await upload(f, member.id, targetChannelId, name, size, mime));
  const again = await member.peer.request(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Edited copy', attachmentIds: recopies, forward: { sourceMessageId: forwardedId },
  });
  assert.equal(again.type, MessageType.CHAT_MESSAGE, JSON.stringify(again.payload));
  assert.deepEqual(again.payload.forwarded, { source: `#${targetName}`, createdAt: forwarded.payload.createdAt },
    'A forward of a forward names its immediate source');
});

test('forwards whose text, files or access do not match the original are rejected', async t => {
  const { f, owner, member, sourceChannelId, targetChannelId } = await setup(t);
  t.mock.method(f.rateLimiter, 'checkLimit', () => true);
  const original = await upload(f, owner.id, sourceChannelId, 'report.pdf', 300, 'application/pdf');
  const second = await upload(f, owner.id, sourceChannelId, 'chart.png', 40, 'image/png');
  const source = await owner.peer.request(MessageType.CHAT_SEND, {
    channelId: sourceChannelId, content: 'Quarterly report', attachmentIds: [original, second],
  });
  const sourceMessageId = text(source.payload.id);
  const forward = { sourceMessageId };
  const report = await upload(f, member.id, targetChannelId, 'report.pdf', 300, 'application/pdf');
  const chart = await upload(f, member.id, targetChannelId, 'chart.png', 40, 'image/png');

  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Quarterly report (edited)', attachmentIds: [report, chart], forward,
  }, ProtocolErrorCode.BAD_REQUEST);
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Quarterly report', attachmentIds: [chart, report], forward,
  }, ProtocolErrorCode.BAD_REQUEST);
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Quarterly report', attachmentIds: [report], forward,
  }, ProtocolErrorCode.BAD_REQUEST);
  const resized = await upload(f, member.id, targetChannelId, 'chart.png', 41, 'image/png');
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Quarterly report', attachmentIds: [report, resized], forward,
  }, ProtocolErrorCode.BAD_REQUEST);
  const retyped = await upload(f, member.id, targetChannelId, 'chart.png', 40, 'image/jpeg');
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Quarterly report', attachmentIds: [report, retyped], forward,
  }, ProtocolErrorCode.BAD_REQUEST);
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Quarterly report', forward: { sourceMessageId: randomUUID() },
  }, ProtocolErrorCode.BAD_REQUEST);
  for (const malformed of [{ sourceMessageId: '' }, { sourceMessageId: 'x'.repeat(129) }, { sourceMessageId: 1 },
    { sourceMessageId, extra: true }, [], 'forward', null]) {
    await member.peer.error(MessageType.CHAT_SEND, {
      channelId: targetChannelId, content: 'Quarterly report', attachmentIds: [report, chart], forward: malformed,
    }, ProtocolErrorCode.BAD_REQUEST);
  }
  const target = records((await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: targetChannelId })).payload.messages);
  assert.equal(target.some(message => message.content === 'Quarterly report'), false, 'Rejected forwards are not persisted');

  const hidden = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'Hidden source', type: 'TEXT',
    permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.READ_MESSAGES }],
  });
  const hiddenChannelId = text(record(hidden.payload.channel).id);
  const secret = await owner.peer.request(MessageType.CHAT_SEND, { channelId: hiddenChannelId, content: 'Secret plan' });
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Secret plan', forward: { sourceMessageId: secret.payload.id },
  }, ProtocolErrorCode.BAD_REQUEST);
  const ownerForward = await owner.peer.request(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Secret plan', forward: { sourceMessageId: secret.payload.id },
  });
  assert.deepEqual(ownerForward.payload.forwarded, { source: `#${text(record(hidden.payload.channel).name)}`, createdAt: secret.payload.createdAt });

  await owner.peer.request(MessageType.CHAT_DELETE, { channelId: sourceChannelId, messageId: sourceMessageId });
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Quarterly report', attachmentIds: [report, chart], forward,
  }, ProtocolErrorCode.BAD_REQUEST);
  const system = randomUUID();
  await f.messageRepo.create({ id: system, channelId: sourceChannelId, userId: owner.id, content: 'System notice',
    createdAt: Date.now(), isSystem: true });
  await member.peer.error(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'System notice', forward: { sourceMessageId: system },
  }, ProtocolErrorCode.BAD_REQUEST);
});

test('forwards from outside the server name no source, and peers without the feature have it ignored', async t => {
  const { f, member, legacy, targetChannelId } = await setup(t);
  const external = await member.peer.request(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'From a DM', forward: {},
  });
  assert.equal(external.type, MessageType.CHAT_MESSAGE);
  assert.deepEqual(external.payload.forwarded, { source: null, createdAt: null });
  assert.deepEqual((await f.messageRepo.findById(text(external.payload.id)))?.forwarded, { source: null, createdAt: null });

  const ignored = await legacy.peer.request(MessageType.CHAT_SEND, {
    channelId: targetChannelId, content: 'Legacy forward', forward: { sourceMessageId: randomUUID(), extra: true },
  });
  assert.equal(ignored.type, MessageType.CHAT_MESSAGE, 'An unnegotiated field is ignored, not validated');
  assert.equal('forwarded' in ignored.payload, false);
  assert.equal((await f.messageRepo.findById(text(ignored.payload.id)))?.forwarded, undefined);
  const memberView = records((await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: targetChannelId })).payload.messages);
  assert.equal('forwarded' in (memberView.find(message => message.id === ignored.payload.id) ?? {}), false);
});

test('the forward marker survives closing and reopening the database', async t => {
  const root = path.join(__dirname, '..', `.bot-test-data-forward-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const filename = path.join(root, 'server.db');
  let database = await DatabaseConnection.create(filename);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  database.getDb().exec(`
    INSERT INTO server_meta (id,name,password_hash,created_at) VALUES ('server','Test','',1);
    INSERT INTO users (id,client_id,nickname,created_at,last_seen_at) VALUES ('author','device','Author',1,1);
    INSERT INTO channels (id,server_id,name,type,created_at) VALUES ('chat','server','chat','TEXT',1);
  `);
  let repository = new SqliteMessageRepository(database.getDb());
  await repository.create({ id: 'named', userId: 'author', channelId: 'chat', createdAt: 2, content: 'Copy',
    isSystem: false, forwarded: { source: '#general', createdAt: 1 } });
  await repository.create({ id: 'external', userId: 'author', channelId: 'chat', createdAt: 3, content: 'DM copy',
    isSystem: false, forwarded: { source: null, createdAt: null } });
  await repository.create({ id: 'plain', userId: 'author', channelId: 'chat', createdAt: 4, content: 'Plain', isSystem: false });
  database.close();
  database = await DatabaseConnection.create(filename);
  repository = new SqliteMessageRepository(database.getDb());
  assert.deepEqual((await repository.findById('named'))?.forwarded, { source: '#general', createdAt: 1 });
  assert.deepEqual((await repository.findById('external'))?.forwarded, { source: null, createdAt: null });
  assert.equal((await repository.findById('plain'))?.forwarded, undefined);
  await repository.markDeleted('named', 10);
  assert.deepEqual((await repository.listByChannel('chat', 10)).map(message => message.forwarded),
    [{ source: '#general', createdAt: 1 }, { source: null, createdAt: null }, undefined]);
});
