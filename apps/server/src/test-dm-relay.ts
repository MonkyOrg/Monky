import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  LIMITS,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  type DmRelayKind,
} from '@monky/shared';
import { createFixture, identity, record, text } from './testFixtures/bots';

function dmItem(to: string, kind: DmRelayKind = 'signal', data = 'payload') {
  return { to, kind, data };
}

function dmPayload(to: string, relayId: string = randomUUID(), kind: DmRelayKind = 'signal', data = 'payload') {
  return { relayId, items: [dmItem(to, kind, data)] };
}

function tableCounts(f: Awaited<ReturnType<typeof createFixture>>) {
  const db = f.database.getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => [name, record(db.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get()).count]);
}

test('human DM relay stamps sender public keys, works both ways, and writes no database rows', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  const bob = await f.human('Bob');
  assert.equal(record(alice.auth.payload.currentUser).publicKey, alice.keys.publicKey);
  const before = tableCounts(f);

  const bobStart = bob.peer.messages.length;
  const ack = await alice.peer.request(MessageType.DM_RELAY_SEND, dmPayload(bob.keys.publicKey, 'a-to-b', 'envelope', 'cipher-a'));
  assert.equal(ack.type, MessageType.DM_RELAY_ACK);
  assert.deepEqual(ack.payload, { relayId: 'a-to-b', accepted: 1 });
  const deliveredToBob = await bob.peer.wait(message => message.type === MessageType.DM_RELAY_DELIVER, bobStart);
  assert.deepEqual(deliveredToBob.payload, { from: alice.keys.publicKey, kind: 'envelope', data: 'cipher-a' });

  const aliceStart = alice.peer.messages.length;
  const replyAck = await bob.peer.request(MessageType.DM_RELAY_SEND, dmPayload(alice.keys.publicKey, 'b-to-a', 'friend', 'cipher-b'));
  assert.equal(replyAck.type, MessageType.DM_RELAY_ACK);
  assert.deepEqual(replyAck.payload, { relayId: 'b-to-a', accepted: 1 });
  const deliveredToAlice = await alice.peer.wait(message => message.type === MessageType.DM_RELAY_DELIVER, aliceStart);
  assert.deepEqual(deliveredToAlice.payload, { from: bob.keys.publicKey, kind: 'friend', data: 'cipher-b' });

  await alice.peer.barrier();
  await bob.peer.barrier();
  assert.deepEqual(tableCounts(f), before);
  assert.deepEqual(f.database.getDb().prepare("SELECT name FROM sqlite_master WHERE lower(name) LIKE '%dm%'").all(), []);
});

test('DM relay supports multi-device self-sync, excludes the origin socket, and reaches invisible recipients', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  const aliceSecondDevice = await f.human('Alice laptop', alice.keys, randomUUID());
  const invisible = await f.human('Invisible', identity(), randomUUID(), true);

  const originStart = alice.peer.messages.length;
  const secondStart = aliceSecondDevice.peer.messages.length;
  const selfAck = await alice.peer.request(MessageType.DM_RELAY_SEND, dmPayload(alice.keys.publicKey, 'self-copy', 'signal', 'self-cipher'));
  assert.deepEqual(selfAck.payload, { relayId: 'self-copy', accepted: 1 });
  const selfCopy = await aliceSecondDevice.peer.wait(message => message.type === MessageType.DM_RELAY_DELIVER, secondStart);
  assert.deepEqual(selfCopy.payload, { from: alice.keys.publicKey, kind: 'signal', data: 'self-cipher' });
  await alice.peer.barrier();
  assert.equal(alice.peer.messages.slice(originStart).some(message => message.type === MessageType.DM_RELAY_DELIVER), false);

  const invisibleStart = invisible.peer.messages.length;
  const invisAck = await alice.peer.request(MessageType.DM_RELAY_SEND, dmPayload(invisible.keys.publicKey, 'to-invisible'));
  assert.deepEqual(invisAck.payload, { relayId: 'to-invisible', accepted: 1 });
  const delivered = await invisible.peer.wait(message => message.type === MessageType.DM_RELAY_DELIVER, invisibleStart);
  assert.equal(delivered.payload.from, alice.keys.publicKey);
});

test('DM relay acknowledgements do not reveal whether the recipient is online', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  const bob = await f.human('Bob');
  const onlineAck = await alice.peer.request(MessageType.DM_RELAY_SEND, dmPayload(bob.keys.publicKey, 'online-presence'));
  const offlineAck = await alice.peer.request(MessageType.DM_RELAY_SEND, dmPayload(identity().publicKey, 'offline-presence'));
  assert.equal(onlineAck.type, MessageType.DM_RELAY_ACK);
  assert.equal(offlineAck.type, MessageType.DM_RELAY_ACK);
  assert.equal(onlineAck.payload.accepted, offlineAck.payload.accepted);
  assert.equal(onlineAck.payload.accepted, 1);
});

test('DM relay rejects bots, clients without negotiated support, disabled servers, invalid payloads, and rate bursts', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const createdBot = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(createdBot.payload.token));
  const validTarget = identity().publicKey;

  const botError = await bot.peer.request(MessageType.DM_RELAY_SEND, dmPayload(validTarget, 'bot-relay'));
  assert.equal(botError.type, MessageType.SERVER_ERROR);
  assert.equal(botError.payload.code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(botError.payload.relayId, 'bot-relay');

  const legacy = await f.human('Legacy client', identity(), randomUUID(), false, PROTOCOL_VERSION, { minimumVersion: 35, features: [] });
  const featureError = await legacy.peer.request(MessageType.DM_RELAY_SEND, dmPayload(validTarget, 'no-feature'));
  assert.equal(featureError.type, MessageType.SERVER_ERROR);
  assert.equal(featureError.payload.code, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  assert.equal(featureError.payload.relayId, 'no-feature');

  const settings = await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { dmRelayEnabled: false });
  assert.equal(settings.type, MessageType.SERVER_SETTINGS_UPDATED);
  const disabledError = await owner.peer.request(MessageType.DM_RELAY_SEND, dmPayload(validTarget, 'disabled'));
  assert.equal(disabledError.type, MessageType.SERVER_ERROR);
  assert.equal(disabledError.payload.code, ProtocolErrorCode.DM_RELAY_DISABLED);
  assert.equal(disabledError.payload.relayId, 'disabled');
  await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { dmRelayEnabled: true });

  const badKey = await owner.peer.request(MessageType.DM_RELAY_SEND, { relayId: 'bad-key', items: [dmItem('ab'.repeat(44))] });
  assert.equal(badKey.type, MessageType.SERVER_ERROR);
  assert.equal(badKey.payload.code, ProtocolErrorCode.BAD_REQUEST);
  assert.equal(badKey.payload.relayId, 'bad-key');
  const tooMany = await owner.peer.request(MessageType.DM_RELAY_SEND, {
    relayId: 'too-many',
    items: Array.from({ length: LIMITS.DM_RELAY_MAX_ITEMS + 1 }, () => dmItem(validTarget)),
  });
  assert.equal(tooMany.type, MessageType.SERVER_ERROR);
  assert.equal(tooMany.payload.code, ProtocolErrorCode.BAD_REQUEST);
  assert.equal(tooMany.payload.relayId, 'too-many');
  const tooLarge = await owner.peer.request(MessageType.DM_RELAY_SEND, dmPayload(validTarget, 'too-large', 'file',
    'x'.repeat(LIMITS.DM_RELAY_FILE_DATA_MAX_LENGTH + 1)));
  assert.equal(tooLarge.type, MessageType.SERVER_ERROR);
  assert.equal(tooLarge.payload.code, ProtocolErrorCode.BAD_REQUEST);
  assert.equal(tooLarge.payload.relayId, 'too-large');

  let limited = false;
  for (let index = 0; index < 5; index++) {
    const response = await owner.peer.request(MessageType.DM_RELAY_SEND, {
      relayId: `burst-${index}`,
      items: Array.from({ length: LIMITS.DM_RELAY_MAX_ITEMS }, () => dmItem(validTarget)),
    });
    if (response.type === MessageType.SERVER_ERROR) {
      assert.equal(response.payload.code, ProtocolErrorCode.RATE_LIMITED);
      assert.equal(response.payload.relayId, `burst-${index}`);
      limited = true;
      break;
    }
  }
  assert.equal(limited, true);
});
