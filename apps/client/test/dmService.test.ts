import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  DM_PROFILE_AVATAR_MAX_LENGTH,
  LIMITS,
  MESSAGE_FORWARD_SOURCE_MAX_LENGTH,
  MessageType,
  PROTOCOL_VERSION,
  createProtocolOffer,
  sanitizeDmForward,
  type DmDispatch,
  type DmEvent,
  type DmIncomingRelayItem,
  type DmRelayItem,
  type DmResult,
  type UserSummary,
} from '@monky/shared';
import { DmKeyring, newDmId, verifyDmCertificate } from '../src/main/dm/dmCrypto';
import { DmPersistence } from '../src/main/dm/dmPersistence';
import { DmError, DmService, DM_DOWNLOAD_STALL_MS, DM_FILE_CHUNK_BYTES, DM_FILE_TRANSFER_IDLE_MS } from '../src/main/dm/dmService';
import { DmTransport, type DmRelayApi } from '../src/renderer/core/DmTransport';
import { sessionManager, type ServerSession } from '../src/renderer/core/SessionManager';

interface Identity {
  publicKey: string;
  privateKey: string;
}

function createIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

interface Device {
  name: string;
  identity: Identity;
  service: DmService;
  events: DmEvent[];
  /** How many of `events` the relay already looked at for dispatches the device raised on its own. */
  dispatched: number;
  dir: string;
  online: boolean;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-dm-test-'));
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));

function createDevice(
  name: string,
  identity: Identity,
  dir = fs.mkdtempSync(path.join(tempRoot, `${name}-`)),
  now?: () => number,
  fileCacheMaxBytes?: number
): Device {
  const events: DmEvent[] = [];
  const service = new DmService({
    keyring: new DmKeyring(identity.publicKey, identity.privateKey),
    dir,
    now,
    onEvent: (event) => events.push(event),
    fileCacheMaxBytes,
  });
  service.setSelfNickname(name);
  return { name, identity, service, events, dispatched: 0, dir, online: true };
}

/**
 * Relay that behaves like one server every device is on: deliver to every other online device of the recipient
 * identity. Acks leave a device only after it saved what they confirm, so once the queue drains every online device
 * writes what it has pending and sends what it dispatched on its own, as the renderer does.
 */
function relay(devices: Device[], origin: Device, dispatch: DmDispatch, budget = { left: 5000 }): void {
  const queue: Array<{ origin: Device; item: DmRelayItem }> = [];
  const enqueue = (from: Device, result: DmDispatch) => {
    for (const items of [...Object.values(result.peers ?? {}), ...Object.values(result.everywhere ?? {})]) {
      for (const item of items) queue.push({ origin: from, item });
    }
    for (const item of result.broadcast ?? []) queue.push({ origin: from, item });
    for (const item of result.reply ?? []) queue.push({ origin: from, item });
  };
  enqueue(origin, dispatch);
  for (;;) {
    while (queue.length > 0) {
      assert.ok(budget.left-- > 0, 'relay loop did not converge');
      const { origin: sender, item } = queue.shift()!;
      // The server refuses bigger items, so the test relay does too.
      const max = item.kind === 'file' ? LIMITS.DM_RELAY_FILE_DATA_MAX_LENGTH : LIMITS.DM_RELAY_DATA_MAX_LENGTH;
      assert.ok(item.data.length <= max, `${item.kind} item of ${item.data.length} chars exceeds the relay limit`);
      if (!sender.online) continue;
      for (const device of devices) {
        if (device === sender || !device.online || device.identity.publicKey !== item.to) continue;
        enqueue(device, device.service.ingest({ from: sender.identity.publicKey, kind: item.kind, data: item.data }));
      }
    }
    for (const device of devices) {
      if (!device.online) continue;
      if (device.service.hasPendingAcks()) device.service.flush();
      for (const dispatched of takeDispatches(device)) enqueue(device, dispatched);
    }
    if (queue.length === 0) return;
  }
}

/** Dispatches the device raised on its own since the last look (acks released by a write). */
function takeDispatches(device: Device): DmDispatch[] {
  const dispatches = device.events.slice(device.dispatched)
    .flatMap((event) => (event.type === 'dispatch' ? [event.dispatch] : []));
  device.dispatched = device.events.length;
  return dispatches;
}

function befriend(devices: Device[], a: Device, b: Device): void {
  relay(devices, a, a.service.sendFriendRequest(b.identity.publicKey, b.name));
  relay(devices, b, b.service.acceptFriend(a.identity.publicKey));
}

function peer(device: Device, other: Identity) {
  return device.service.snapshot().peers.find((entry) => entry.publicKey === other.publicKey);
}

test('dm crypto derives the same signed DM key on every device and rejects tampering', () => {
  const alice = createIdentity();
  const bob = createIdentity();
  const a1 = new DmKeyring(alice.publicKey, alice.privateKey);
  const a2 = new DmKeyring(alice.publicKey, alice.privateKey);
  const b = new DmKeyring(bob.publicKey, bob.privateKey);
  assert.equal(a1.dmPublicKey, a2.dmPublicKey);
  assert.ok(verifyDmCertificate(alice.publicKey, a1.certificate()));
  assert.ok(!verifyDmCertificate(bob.publicKey, a1.certificate()));

  const secret = 'conteudo-secreto-da-dm-7f3a9c';
  const sealed = a1.seal(bob.publicKey, b.certificate(), { id: 'a'.repeat(32), type: 'typing', ts: 1 }, { content: secret });
  assert.ok(!sealed.includes(secret), 'plaintext must not be visible to the relay');
  assert.ok(!sealed.includes('content'), 'body fields must not be visible to the relay');
  assert.ok(!sealed.includes('typing'), 'operation type must not be visible to the relay');
  assert.deepEqual(Object.keys(JSON.parse(sealed).h).sort(), ['from', 'to']);
  const opened = b.open(sealed, alice.publicKey, a2.certificate());
  assert.deepEqual(opened.body, { content: secret });
  assert.equal(opened.header.type, 'typing');
  assert.throws(() => b.open(sealed, bob.publicKey, a1.certificate()));

  const tampered = JSON.parse(sealed);
  tampered.h.to = alice.publicKey;
  assert.throws(() => a1.open(JSON.stringify(tampered), alice.publicKey, a1.certificate()));
  const flipped = JSON.parse(sealed);
  const bytes = Buffer.from(flipped.c, 'base64');
  bytes[0] ^= 1;
  flipped.c = bytes.toString('base64');
  assert.throws(() => b.open(JSON.stringify(flipped), alice.publicKey, a1.certificate()));
  assert.throws(() => a2.open(sealed, alice.publicKey, a1.certificate()), /não endereçado/);
});

test('friend request, accept, messages, acks, receipts, edits, reactions and deletes', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];

  relay(devices, alice, alice.service.sendFriendRequest(bob.identity.publicKey, 'Bob'));
  assert.equal(peer(alice, bob.identity)?.relation, 'outgoing');
  assert.equal(peer(bob, alice.identity)?.relation, 'incoming');
  assert.ok(bob.events.some((event) => event.type === 'friend-request'));

  relay(devices, bob, bob.service.acceptFriend(alice.identity.publicKey));
  assert.equal(peer(alice, bob.identity)?.relation, 'friend');
  assert.equal(peer(bob, alice.identity)?.relation, 'friend');
  assert.deepEqual(alice.service.pendingPeers(), []);

  relay(devices, alice, alice.service.sendMessage({ peer: bob.identity.publicKey, content: 'Olá **Bob**' }));
  const bobPage = bob.service.getConversation(alice.identity.publicKey);
  assert.equal(bobPage.messages.length, 1);
  assert.equal(bobPage.messages[0].content, 'Olá **Bob**');
  assert.equal(bob.service.snapshot().conversations[0].unread, 1);
  const messageId = bobPage.messages[0].id;
  assert.equal(alice.service.getConversation(bob.identity.publicKey).messages[0].delivery, 'delivered');

  relay(devices, bob, bob.service.markRead(alice.identity.publicKey));
  assert.equal(bob.service.snapshot().conversations[0].unread, 0);
  assert.equal(alice.service.getConversation(bob.identity.publicKey).messages[0].delivery, 'read');

  relay(devices, alice, alice.service.editMessage(bob.identity.publicKey, messageId, 'Olá Bob!'));
  assert.equal(bob.service.getConversation(alice.identity.publicKey).messages[0].content, 'Olá Bob!');
  assert.ok(bob.service.getConversation(alice.identity.publicKey).messages[0].editedAt);

  relay(devices, bob, bob.service.react(alice.identity.publicKey, messageId, '👍', true));
  assert.deepEqual(alice.service.getConversation(bob.identity.publicKey).messages[0].reactions, [
    { emoji: '👍', users: [bob.identity.publicKey] },
  ]);

  assert.throws(() => bob.service.deleteMessage(alice.identity.publicKey, messageId), (error: unknown) => error instanceof DmError && error.code === 'forbidden');
  relay(devices, alice, alice.service.deleteMessage(bob.identity.publicKey, messageId));
  assert.equal(bob.service.getConversation(alice.identity.publicKey).messages[0].deleted, true);
  assert.equal(bob.service.getConversation(alice.identity.publicKey).messages[0].content, '');
});

test('operations created in the same millisecond keep their order on both sides', () => {
  const frozen = () => 1_700_000_000_000;
  const alice = createDevice('Alice', createIdentity(), undefined, frozen);
  const bob = createDevice('Bob', createIdentity(), undefined, frozen);
  const devices = [alice, bob];
  befriend(devices, alice, bob);

  for (const content of ['um', 'dois', 'três', 'quatro']) {
    relay(devices, alice, alice.service.sendMessage({ peer: bob.identity.publicKey, content }));
  }
  const order = (device: Device, other: Device) =>
    device.service.getConversation(other.identity.publicKey).messages.map((message) => message.content);
  assert.deepEqual(order(alice, bob), ['um', 'dois', 'três', 'quatro']);
  assert.deepEqual(order(bob, alice), ['um', 'dois', 'três', 'quatro']);

  const messageId = alice.service.getConversation(bob.identity.publicKey).messages[0].id;
  relay(devices, alice, alice.service.editMessage(bob.identity.publicKey, messageId, 'primeira edição'));
  relay(devices, alice, alice.service.editMessage(bob.identity.publicKey, messageId, 'segunda edição'));
  assert.equal(bob.service.getConversation(alice.identity.publicKey).messages[0].content, 'segunda edição');

  relay(devices, bob, bob.service.react(alice.identity.publicKey, messageId, '👍', true));
  relay(devices, bob, bob.service.react(alice.identity.publicKey, messageId, '👍', false));
  assert.deepEqual(alice.service.getConversation(bob.identity.publicKey).messages[0].reactions, []);
  assert.deepEqual(bob.service.getConversation(alice.identity.publicKey).messages[0].reactions, []);
});

test('clock skew keeps replies after the message they answer and read receipts working', () => {
  let bobNow = 1_700_000_000_000;
  const alice = createDevice('Alice', createIdentity(), undefined, () => bobNow + 2 * 60_000);
  const bob = createDevice('Bob', createIdentity(), undefined, () => bobNow);
  const devices = [alice, bob];
  befriend(devices, alice, bob);

  relay(devices, alice, alice.service.sendMessage({ peer: bob.identity.publicKey, content: 'pergunta' }));
  bobNow += 1_000;
  relay(devices, bob, bob.service.markRead(alice.identity.publicKey));
  assert.equal(alice.service.getConversation(bob.identity.publicKey).messages[0].delivery, 'read');

  relay(devices, bob, bob.service.sendMessage({ peer: alice.identity.publicKey, content: 'resposta' }));
  const order = (device: Device, other: Device) =>
    device.service.getConversation(other.identity.publicKey).messages.map((message) => message.content);
  assert.deepEqual(order(alice, bob), ['pergunta', 'resposta']);
  assert.deepEqual(order(bob, alice), ['pergunta', 'resposta']);
});

test('offline friends get the outbox when they show up again, deduplicated', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);

  bob.online = false;
  relay(devices, alice, alice.service.sendMessage({ peer: bob.identity.publicKey, content: 'um' }));
  relay(devices, alice, alice.service.sendMessage({ peer: bob.identity.publicKey, content: 'dois' }));
  assert.deepEqual(alice.service.pendingPeers(), [bob.identity.publicKey]);
  assert.equal(alice.service.getConversation(bob.identity.publicKey).messages[0].delivery, 'pending');

  bob.online = true;
  // Recently sent items are not resent without force; the hello forces a flush.
  assert.deepEqual(alice.service.outgoing([bob.identity.publicKey]), {});
  relay(devices, bob, bob.service.helloTo(alice.identity.publicKey));
  assert.deepEqual(
    bob.service.getConversation(alice.identity.publicKey).messages.map((message) => message.content),
    ['um', 'dois']
  );
  assert.deepEqual(alice.service.pendingPeers(), []);

  // A duplicate resend does not duplicate messages.
  relay(devices, alice, alice.service.sendMessage({ peer: bob.identity.publicKey, content: 'três' }));
  relay(devices, alice, alice.service.outgoing([bob.identity.publicKey], true));
  assert.equal(bob.service.getConversation(alice.identity.publicKey).messages.length, 3);
});

test('own devices sync friends and receive copies of sent messages', () => {
  const aliceIdentity = createIdentity();
  const alice1 = createDevice('Alice', aliceIdentity);
  const alice2 = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice1, alice2, bob];

  alice2.online = false;
  befriend(devices, alice1, bob);
  assert.equal(peer(alice2, bob.identity), undefined);

  alice2.online = true;
  relay(devices, alice2, alice2.service.hello(false));
  assert.equal(peer(alice2, bob.identity)?.relation, 'friend');

  relay(devices, alice1, alice1.service.sendMessage({ peer: bob.identity.publicKey, content: 'de um aparelho' }));
  assert.equal(alice2.service.getConversation(bob.identity.publicKey).messages[0].content, 'de um aparelho');
  assert.equal(alice2.service.getConversation(bob.identity.publicKey).messages[0].author, aliceIdentity.publicKey);

  relay(devices, bob, bob.service.sendMessage({ peer: aliceIdentity.publicKey, content: 'para os dois' }));
  assert.equal(alice1.service.getConversation(bob.identity.publicKey).messages.length, 2);
  assert.equal(alice2.service.getConversation(bob.identity.publicKey).messages.length, 2);

  relay(devices, alice2, alice2.service.markRead(bob.identity.publicKey));
  assert.equal(alice1.service.snapshot().conversations[0].unread, 0);

  relay(devices, alice2, alice2.service.removeFriend(bob.identity.publicKey));
  assert.equal(peer(alice1, bob.identity)?.relation, 'none');
  assert.equal(peer(bob, aliceIdentity)?.relation, 'none');
  assert.equal(bob.service.snapshot().conversations[0].readOnly, true);
  assert.equal(bob.service.getConversation(aliceIdentity.publicKey).messages.length, 2);
});

/** What two devices must agree on for a conversation to look the same. */
function history(device: Device, other: Identity) {
  return device.service.getConversation(other.publicKey, null, 500).messages.map((message) => ({
    id: message.id,
    author: message.author,
    content: message.content,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    deleted: message.deleted,
    reactions: message.reactions.map((reaction) => `${reaction.emoji}:${[...reaction.users].sort().join('+')}`).sort(),
  }));
}

test('an own device that was offline catches up on friends and full history once both are online', () => {
  const aliceIdentity = createIdentity();
  const alice1 = createDevice('Alice', aliceIdentity);
  const alice2 = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice1, alice2, bob];
  const bobKey = bob.identity.publicKey;

  alice2.online = false;
  befriend(devices, alice1, bob);
  relay(devices, alice1, alice1.service.sendMessage({ peer: bobKey, content: 'primeira' }));
  relay(devices, bob, bob.service.sendMessage({ peer: aliceIdentity.publicKey, content: 'resposta' }));
  relay(devices, alice1, alice1.service.sendMessage({ peer: bobKey, content: 'vai ser editada' }));
  relay(devices, alice1, alice1.service.sendMessage({ peer: bobKey, content: 'vai ser apagada' }));
  const [first, answer, edited, removed] = alice1.service.getConversation(bobKey).messages;
  relay(devices, alice1, alice1.service.editMessage(bobKey, edited.id, 'editada'));
  relay(devices, alice1, alice1.service.deleteMessage(bobKey, removed.id));
  relay(devices, bob, bob.service.react(aliceIdentity.publicKey, first.id, '👍', true));
  relay(devices, alice1, alice1.service.markRead(bobKey));
  assert.equal(peer(alice2, bob.identity), undefined);

  const before = alice2.events.length;
  alice2.online = true;
  relay(devices, alice2, alice2.service.hello(false));
  assert.equal(peer(alice2, bob.identity)?.relation, 'friend');
  assert.deepEqual(history(alice2, bob.identity), history(alice1, bob.identity));
  assert.equal(history(alice2, bob.identity).length, 4);
  assert.equal(alice2.service.snapshot().conversations[0].unread, 0, 'read on the other device stays read');
  assert.ok(!alice2.events.slice(before).some((event) => event.type === 'incoming-message'), 'old history must not notify');
  const own = alice2.service.getConversation(bobKey).messages.find((message) => message.id === first.id);
  assert.equal(own?.delivery, 'delivered');

  // Now the other way round: the device that stayed online has news.
  alice1.online = false;
  relay(devices, bob, bob.service.sendMessage({ peer: aliceIdentity.publicKey, content: 'só no segundo' }));
  relay(devices, alice2, alice2.service.react(bobKey, answer.id, '❤️', true));
  relay(devices, alice2, alice2.service.editMessage(bobKey, edited.id, 'editada de novo'));
  alice1.online = true;
  relay(devices, alice1, alice1.service.hello(false));
  assert.deepEqual(history(alice1, bob.identity), history(alice2, bob.identity));
  assert.equal(history(alice1, bob.identity).length, 5);

  // The same hello again (a second shared server) sends nothing new.
  let items = 0;
  const counted = alice1.service.hello(false);
  const budget = { left: 5000 };
  relay(devices, alice1, counted, budget);
  items = 5000 - budget.left;
  const again = { left: 5000 };
  relay(devices, alice1, alice1.service.hello(false), again);
  assert.ok(5000 - again.left <= items, 'a repeated hello must not resend history');
});

test('long histories reach another own device over several rounds', () => {
  let clock = Date.UTC(2024, 0, 1, 12);
  const now = () => clock;
  const aliceIdentity = createIdentity();
  const alice1 = createDevice('Alice', aliceIdentity, undefined, now);
  const alice2 = createDevice('Alice', aliceIdentity, undefined, now);
  const bob = createDevice('Bob', createIdentity(), undefined, now);
  const devices = [alice1, alice2, bob];
  alice2.online = false;
  befriend(devices, alice1, bob);
  const text = 'x'.repeat(2_000);
  for (let day = 0; day < 12; day += 1) {
    for (let index = 0; index < 30; index += 1) {
      clock += 1_000;
      relay(devices, alice1, alice1.service.sendMessage({ peer: bob.identity.publicKey, content: `${day}-${index}-${text}` }));
    }
    clock += 86_400_000;
  }
  alice2.online = true;
  relay(devices, alice2, alice2.service.hello(false), { left: 20_000 });
  const synced = history(alice2, bob.identity);
  assert.equal(synced.length, 360);
  assert.deepEqual(synced, history(alice1, bob.identity));
});

test('nickname and avatar follow the identity to its other devices, newest wins', () => {
  const identity = createIdentity();
  const a1 = createDevice('Alice', identity);
  const a2 = createDevice('Alice', identity);
  const devices = [a1, a2];
  const avatar = `data:image/webp;base64,${Buffer.from('avatar-1').toString('base64')}`;

  a2.online = false;
  const chosen = a1.service.setSelfProfile({ nickname: 'Alice Nova', nicknameAt: 1_000, avatar, avatarAt: 1_000 });
  assert.equal(chosen.profile.nickname, 'Alice Nova');
  relay(devices, a1, chosen.dispatch);

  // A profile saved before the sync existed only seeds; it never beats a real choice.
  const seeded = a2.service.setSelfProfile({ nickname: 'Alice Velha', nicknameAt: 0 });
  assert.equal(seeded.profile.nicknameAt, 1);
  a2.online = true;
  relay(devices, a2, a2.service.hello(false));
  const latest = a2.events.filter((event): event is Extract<DmEvent, { type: 'self-profile' }> => event.type === 'self-profile').pop();
  assert.equal(latest?.profile.nickname, 'Alice Nova');
  assert.equal(latest?.profile.avatar, avatar);
  assert.equal(a1.service.setSelfProfile({}).profile.nickname, 'Alice Nova');

  relay(devices, a2, a2.service.setSelfProfile({ nickname: 'Alice Final', nicknameAt: 2_000 }).dispatch);
  const live = a1.events.filter((event): event is Extract<DmEvent, { type: 'self-profile' }> => event.type === 'self-profile').pop();
  assert.equal(live?.profile.nickname, 'Alice Final');
  assert.equal(live?.profile.avatar, avatar);

  const tooBig = `data:image/webp;base64,${'A'.repeat(DM_PROFILE_AVATAR_MAX_LENGTH)}`;
  assert.equal(a1.service.setSelfProfile({ avatar: tooBig, avatarAt: 3_000 }).profile.avatar, avatar);
  assert.equal(a1.service.setSelfProfile({ avatar: 'https://example.com/a.png', avatarAt: 3_000 }).profile.avatar, avatar);
});

test('friends get the profile picture even when it changed while they were away', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;

  const first = `data:image/png;base64,${Buffer.from('foto-1').toString('base64')}`;
  relay(devices, alice, alice.service.setSelfProfile({ nickname: 'Alice Perfil', nicknameAt: 1_000, avatar: first, avatarAt: 1_000 }).dispatch);
  assert.equal(peer(bob, alice.identity)?.avatar, first);
  assert.equal(peer(bob, alice.identity)?.nickname, 'Alice Perfil');

  // What servers show does not replace what the friend chose.
  bob.service.observePeer({ publicKey: aliceKey, nickname: 'Apelido no servidor', avatar: 'http://host/avatars/x.png' });
  assert.equal(peer(bob, alice.identity)?.avatar, first);
  assert.equal(peer(bob, alice.identity)?.nickname, 'Alice Perfil');

  bob.online = false;
  const second = `data:image/png;base64,${Buffer.from('foto-2').toString('base64')}`;
  relay(devices, alice, alice.service.setSelfProfile({ avatar: second, avatarAt: 2_000 }).dispatch);
  assert.equal(peer(bob, alice.identity)?.avatar, first);
  bob.online = true;
  relay(devices, alice, alice.service.helloTo(bob.identity.publicKey));
  assert.equal(peer(bob, alice.identity)?.avatar, second);

  // Up to date: another hello asks for nothing.
  const budget = { left: 5000 };
  relay(devices, alice, alice.service.helloTo(bob.identity.publicKey), budget);
  assert.ok(5000 - budget.left <= 3);
});

test('blocking is silent and drops requests and messages', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  relay(devices, bob, bob.service.block(alice.identity.publicKey));
  assert.equal(peer(bob, alice.identity)?.blocked, true);
  // Alice only sees the friendship gone (no history, so the peer disappears), never the block.
  assert.equal(peer(alice, bob.identity), undefined);

  bob.events.length = 0;
  relay(devices, alice, alice.service.sendFriendRequest(bob.identity.publicKey));
  assert.equal(peer(bob, alice.identity)?.relation, 'none');
  assert.ok(!bob.events.some((event) => event.type === 'friend-request'));
  // Nobody acked, so the request keeps waiting on Alice's side.
  assert.deepEqual(alice.service.pendingPeers(), [bob.identity.publicKey]);

  relay(devices, bob, bob.service.unblock(alice.identity.publicKey));
  relay(devices, alice, alice.service.outgoing([bob.identity.publicKey], true));
  assert.equal(peer(bob, alice.identity)?.relation, 'incoming');
});

test('decline is silent and cancel withdraws the request', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  relay(devices, alice, alice.service.sendFriendRequest(bob.identity.publicKey));
  relay(devices, bob, bob.service.declineFriend(alice.identity.publicKey));
  assert.equal(peer(alice, bob.identity)?.relation, 'outgoing');
  assert.equal(peer(bob, alice.identity), undefined);

  relay(devices, alice, alice.service.cancelFriendRequest(bob.identity.publicKey));
  assert.equal(peer(alice, bob.identity), undefined);

  relay(devices, alice, alice.service.sendFriendRequest(bob.identity.publicKey));
  assert.equal(peer(bob, alice.identity)?.relation, 'incoming');
  relay(devices, alice, alice.service.cancelFriendRequest(bob.identity.publicKey));
  assert.equal(peer(bob, alice.identity), undefined);
});

test('files transfer in encrypted chunks and respect the receiver limit', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);

  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 7 + 1234);
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
  relay(
    devices,
    alice,
    alice.service.sendMessage({
      peer: bob.identity.publicKey,
      content: '',
      files: [{ name: 'foto.png', mime: 'image/png', data: new Uint8Array(content) }],
    })
  );
  const received = bob.service.getConversation(alice.identity.publicKey).messages[0];
  assert.equal(received.attachments[0].state, 'ready');
  const file = bob.service.readAttachment(alice.identity.publicKey, received.id, received.attachments[0].fileId);
  assert.ok(file.data.equals(content));
  assert.equal(file.name, 'foto.png');

  const onDisk = fs.readdirSync(path.join(bob.dir, 'files'));
  assert.ok(onDisk.every((name) => name.endsWith('.mkdm')));
  const stored = fs.readFileSync(path.join(bob.dir, 'files', onDisk[0]));
  assert.equal(stored.indexOf(content.subarray(0, 64)), -1);

  relay(devices, bob, bob.service.updateSettings({ maxFileBytes: 10 * 1024 * 1024 }));
  assert.equal(peer(alice, bob.identity)?.maxFileBytes, 10 * 1024 * 1024);
  assert.throws(
    () =>
      alice.service.sendMessage({
        peer: bob.identity.publicKey,
        content: '',
        files: [{ name: 'grande.bin', mime: 'application/octet-stream', data: new Uint8Array(10 * 1024 * 1024 + 1) }],
      }),
    (error: unknown) => error instanceof DmError && error.code === 'file-too-large' && error.details.limit === 10 * 1024 * 1024
  );
});

test('interrupted downloads resume from the received offset', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 20, 7);

  const dispatch = alice.service.sendMessage({
    peer: bob.identity.publicKey,
    content: 'arquivo',
    files: [{ name: 'a.bin', mime: 'application/octet-stream', data: new Uint8Array(content) }],
  });
  // Deliver only the message; Bob's first file request reaches Alice, but the chunks are lost.
  const [messageItem] = dispatch.peers![bob.identity.publicKey];
  const afterMessage = bob.service.ingest({ from: alice.identity.publicKey, kind: messageItem.kind, data: messageItem.data });
  // Reply = [file request]: the ack waits until Bob saved the message.
  assert.equal(afterMessage.reply?.length, 1);
  const fileRequest = afterMessage.reply![0];
  const chunks = alice.service.ingest({ from: bob.identity.publicKey, kind: fileRequest.kind, data: fileRequest.data });
  assert.ok((chunks.reply?.length ?? 0) > 1);
  // Only the first chunk arrives.
  bob.service.ingest({ from: alice.identity.publicKey, kind: 'file', data: chunks.reply![0].data });
  const partial = bob.service.getConversation(alice.identity.publicKey).messages[0].attachments[0];
  assert.equal(partial.state, 'downloading');
  assert.equal(partial.receivedBytes, DM_FILE_CHUNK_BYTES);

  relay(devices, bob, bob.service.outgoing([alice.identity.publicKey], true));
  const message = bob.service.getConversation(alice.identity.publicKey).messages[0];
  assert.equal(message.attachments[0].state, 'ready');
  assert.ok(bob.service.readAttachment(alice.identity.publicKey, message.id, message.attachments[0].fileId).data.equals(content));
});

test('state persists encrypted and reloads; export restores friends and history', () => {
  const aliceIdentity = createIdentity();
  const alice = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  relay(devices, alice, alice.service.sendMessage({ peer: bob.identity.publicKey, content: 'segredo persistente' }));
  alice.service.flush();

  for (const name of fs.readdirSync(alice.dir)) {
    const full = path.join(alice.dir, name);
    if (fs.statSync(full).isFile()) {
      assert.equal(fs.readFileSync(full).indexOf('segredo'), -1, `${name} has clear text`);
    }
  }

  const reloaded = createDevice('Alice', aliceIdentity, alice.dir);
  assert.equal(peer(reloaded, bob.identity)?.relation, 'friend');
  assert.equal(reloaded.service.getConversation(bob.identity.publicKey).messages[0].content, 'segredo persistente');

  const wrongIdentity = createDevice('Eve', createIdentity(), alice.dir);
  assert.deepEqual(wrongIdentity.service.snapshot().peers, []);

  const friendsOnly = alice.service.exportData(false);
  const withHistory = alice.service.exportData(true);
  assert.equal(friendsOnly.conversations, undefined);
  const restoredFriends = createDevice('Alice', aliceIdentity);
  restoredFriends.service.importData(JSON.parse(JSON.stringify(friendsOnly)));
  assert.equal(peer(restoredFriends, bob.identity)?.relation, 'friend');
  assert.equal(restoredFriends.service.getConversation(bob.identity.publicKey).messages.length, 0);
  const restored = createDevice('Alice', aliceIdentity);
  restored.service.importData(JSON.parse(JSON.stringify(withHistory)));
  assert.equal(restored.service.getConversation(bob.identity.publicKey).messages[0].content, 'segredo persistente');
});

test('a friend on a fresh device gets re-accepted automatically', () => {
  const aliceIdentity = createIdentity();
  const alice = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  befriend([alice, bob], alice, bob);
  const aliceFresh = createDevice('Alice', aliceIdentity);
  const devices = [aliceFresh, bob];
  relay(devices, aliceFresh, aliceFresh.service.sendFriendRequest(bob.identity.publicKey, 'Bob'));
  assert.equal(peer(aliceFresh, bob.identity)?.relation, 'friend');
});

test('server-stamped sender must match the envelope', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const carol = createDevice('Carol', createIdentity());
  const devices = [alice, bob, carol];
  befriend(devices, alice, bob);
  befriend(devices, carol, bob);
  const dispatch = alice.service.sendMessage({ peer: bob.identity.publicKey, content: 'de Alice' });
  const item = dispatch.peers![bob.identity.publicKey][0];
  // A relay that lies about the sender gets nothing applied.
  assert.deepEqual(bob.service.ingest({ from: carol.identity.publicKey, kind: item.kind, data: item.data }), {});
  assert.equal(bob.service.getConversation(carol.identity.publicKey).messages.length, 0);
  assert.equal(bob.service.getConversation(alice.identity.publicKey).messages.length, 0);
});

function forwardedOf(device: Device, other: Identity, id: string) {
  return device.service.getConversation(other.publicKey, null, 500).messages.find((message) => message.id === id)?.forwarded;
}

test('forwarded DMs carry the marker to the friend and own devices, survive edits and clear on delete', () => {
  const aliceIdentity = createIdentity();
  const alice1 = createDevice('Alice', aliceIdentity);
  const alice2 = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice1, alice2, bob];
  const bobKey = bob.identity.publicKey;
  befriend(devices, alice1, bob);
  relay(devices, alice2, alice2.service.hello(false));

  const marker = { source: '#geral · Servidor', createdAt: 1_700_000_000_000 };
  relay(devices, alice1, alice1.service.sendMessage({ peer: bobKey, content: 'encaminhada', forwarded: marker }));
  relay(devices, alice1, alice1.service.sendMessage({ peer: bobKey, content: 'normal' }));
  const [sent, plain] = alice1.service.getConversation(bobKey).messages;
  assert.deepEqual(sent.forwarded, marker);
  assert.equal(plain.forwarded, null);
  assert.deepEqual(forwardedOf(bob, aliceIdentity, sent.id), marker);
  assert.equal(forwardedOf(bob, aliceIdentity, plain.id), null);
  assert.deepEqual(forwardedOf(alice2, bob.identity, sent.id), marker, 'own-device copy keeps the marker');
  const incoming = bob.events.find((event) => event.type === 'incoming-message' && event.message.id === sent.id);
  assert.ok(incoming && incoming.type === 'incoming-message');
  assert.deepEqual(incoming.message.forwarded, marker);

  relay(devices, alice1, alice1.service.editMessage(bobKey, sent.id, 'encaminhada e editada'));
  assert.deepEqual(forwardedOf(bob, aliceIdentity, sent.id), marker, 'edits keep the marker');
  assert.deepEqual(forwardedOf(alice1, bob.identity, sent.id), marker);

  // A device that was offline gets the marker through the own-device history sync.
  const alice3 = createDevice('Alice', aliceIdentity);
  relay([...devices, alice3], alice3, alice3.service.hello(false));
  assert.deepEqual(forwardedOf(alice3, bob.identity, sent.id), marker);
  assert.equal(forwardedOf(alice3, bob.identity, plain.id), null);

  relay(devices, alice1, alice1.service.deleteMessage(bobKey, sent.id));
  assert.equal(forwardedOf(bob, aliceIdentity, sent.id), null);
  assert.equal(forwardedOf(alice1, bob.identity, sent.id), null);
});

test('forward markers from the renderer or a peer are validated', () => {
  assert.deepEqual(sanitizeDmForward({ source: null, createdAt: null }), { source: null, createdAt: null });
  assert.deepEqual(sanitizeDmForward({}), { source: null, createdAt: null });
  assert.deepEqual(sanitizeDmForward({ source: '  #geral\u0000\n ', createdAt: 0 }), { source: '#geral', createdAt: 0 });
  assert.deepEqual(sanitizeDmForward({ source: '   ' }), { source: null, createdAt: null });
  assert.equal(sanitizeDmForward({ source: 'x'.repeat(5000) })?.source?.length, MESSAGE_FORWARD_SOURCE_MAX_LENGTH);
  for (const invalid of [
    undefined,
    null,
    true,
    'forwarded',
    [],
    { source: 42 },
    { source: { text: '#geral' } },
    { createdAt: -1 },
    { createdAt: 1.5 },
    { createdAt: Number.NaN },
    { createdAt: Number.POSITIVE_INFINITY },
    { createdAt: '1700000000000' },
  ]) {
    assert.equal(sanitizeDmForward(invalid), null, JSON.stringify(invalid) ?? String(invalid));
  }

  const aliceIdentity = createIdentity();
  const bobIdentity = createIdentity();
  const alice = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', bobIdentity);
  befriend([alice, bob], alice, bob);

  // The service validates its own input too, not only the IPC layer.
  const dispatch = alice.service.sendMessage({
    peer: bobIdentity.publicKey,
    content: 'entrada inválida',
    forwarded: { source: '#geral', createdAt: -1 },
  });
  relay([alice, bob], alice, dispatch);
  assert.equal(bob.service.getConversation(aliceIdentity.publicKey).messages[0].forwarded, null);

  // A modified client may put anything in the encrypted body: the receiver sanitizes it.
  const aliceKeyring = new DmKeyring(aliceIdentity.publicKey, aliceIdentity.privateKey);
  const bobCertificate = new DmKeyring(bobIdentity.publicKey, bobIdentity.privateKey).certificate();
  const sendRaw = (forwarded: unknown): string => {
    const id = newDmId();
    const data = aliceKeyring.seal(bobIdentity.publicKey, bobCertificate, { id, type: 'msg', ts: Date.now() }, {
      content: 'de um cliente modificado',
      replyTo: null,
      attachments: [],
      forwarded,
    });
    bob.service.ingest({ from: aliceIdentity.publicKey, kind: 'envelope', data });
    return id;
  };
  assert.equal(forwardedOf(bob, aliceIdentity, sendRaw({ source: '#geral', createdAt: -5 })), null);
  assert.equal(forwardedOf(bob, aliceIdentity, sendRaw('encaminhada')), null);
  assert.equal(forwardedOf(bob, aliceIdentity, sendRaw([{ source: '#geral' }])), null);
  assert.deepEqual(forwardedOf(bob, aliceIdentity, sendRaw({ source: `\u0007 ${'y'.repeat(900)}`, createdAt: 5, extra: true })), {
    source: 'y'.repeat(MESSAGE_FORWARD_SOURCE_MAX_LENGTH),
    createdAt: 5,
  });
  // An older client sends no marker at all.
  assert.equal(forwardedOf(bob, aliceIdentity, sendRaw(undefined)), null);
});

test('forward markers persist, survive export/import and older stores load without them', () => {
  const aliceIdentity = createIdentity();
  const alice = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  const bobKey = bob.identity.publicKey;
  befriend([alice, bob], alice, bob);
  const marker = { source: null, createdAt: 1_650_000_000_000 };
  relay([alice, bob], alice, alice.service.sendMessage({ peer: bobKey, content: 'de uma conversa privada', forwarded: marker }));
  relay([alice, bob], alice, alice.service.sendMessage({ peer: bobKey, content: 'sem marcador' }));
  alice.service.flush();
  const [forwarded, plain] = alice.service.getConversation(bobKey).messages;

  const reloaded = createDevice('Alice', aliceIdentity, alice.dir);
  assert.deepEqual(forwardedOf(reloaded, bob.identity, forwarded.id), marker);

  const backup = JSON.parse(JSON.stringify(alice.service.exportData(true)));
  const restored = createDevice('Alice', aliceIdentity);
  restored.service.importData(backup);
  assert.deepEqual(forwardedOf(restored, bob.identity, forwarded.id), marker);
  assert.equal(forwardedOf(restored, bob.identity, plain.id), null);

  // Backups are sanitized like peer data; a backup from before forwarding has no field.
  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.conversations[0].messages[0].forwarded = { source: 'x'.repeat(1000), createdAt: -1 };
  delete tampered.conversations[0].messages[1].forwarded;
  const restoredTampered = createDevice('Alice', aliceIdentity);
  restoredTampered.service.importData(tampered);
  assert.equal(forwardedOf(restoredTampered, bob.identity, forwarded.id), null);
  assert.equal(forwardedOf(restoredTampered, bob.identity, plain.id), null);

  // A conversation file written by an older version has no `forwarded` on its messages.
  const store = new DmPersistence(alice.dir, new DmKeyring(aliceIdentity.publicKey, aliceIdentity.privateKey).storageKey());
  const file = DmPersistence.peerFileName(bobKey);
  const legacy = store.readJson(file, (value): value is { messages: Array<Record<string, unknown>> } =>
    typeof value === 'object' && value !== null && 'messages' in value && Array.isArray(value.messages));
  assert.ok(legacy);
  for (const message of legacy.messages) delete message.forwarded;
  store.writeJsonNow(file, legacy);
  const legacyDevice = createDevice('Alice', aliceIdentity, alice.dir);
  const messages = legacyDevice.service.getConversation(bobKey).messages;
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.forwarded === null));
});

test('attachments can be written to a file path only when they are on this device', async () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;
  const outDir = fs.mkdtempSync(path.join(tempRoot, 'attachment-out-'));
  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 2 + 77);
  for (let index = 0; index < content.length; index += 1) content[index] = (index * 7) % 256;

  // Only the message envelope reaches Bob: his copy of the file stays pending.
  const dispatch = alice.service.sendMessage({
    peer: bobKey,
    content: 'arquivo',
    files: [{ name: 'dados.bin', mime: 'application/octet-stream', data: new Uint8Array(content) }],
  });
  const requests: DmDispatch[] = (dispatch.peers?.[bobKey] ?? []).map((item) =>
    bob.service.ingest({ from: aliceKey, kind: item.kind, data: item.data }));
  const pending = bob.service.getConversation(aliceKey).messages[0];
  const fileId = pending.attachments[0].fileId;
  assert.equal(pending.attachments[0].state, 'pending');
  const pendingTarget = path.join(outDir, 'pendente.bin');
  await assert.rejects(
    bob.service.writeAttachmentTo(aliceKey, pending.id, fileId, pendingTarget),
    (error: unknown) => error instanceof DmError && error.code === 'not-found'
  );
  assert.equal(fs.existsSync(pendingTarget), false);

  // The sender's own copy is local and is written (overwriting whatever was there).
  const own = alice.service.getConversation(bobKey).messages[0];
  const ownTarget = path.join(outDir, 'enviado.bin');
  fs.writeFileSync(ownTarget, 'conteúdo antigo bem mais longo que nada');
  await alice.service.writeAttachmentTo(bobKey, own.id, fileId, ownTarget);
  assert.ok(fs.readFileSync(ownTarget).equals(content));

  // Once downloaded, the receiver can write it too, decrypted.
  for (const request of requests) relay(devices, bob, request);
  assert.equal(bob.service.getConversation(aliceKey).messages[0].attachments[0].state, 'ready');
  const receivedTarget = path.join(outDir, 'recebido.bin');
  await bob.service.writeAttachmentTo(aliceKey, pending.id, fileId, receivedTarget);
  assert.ok(fs.readFileSync(receivedTarget).equals(content));

  await assert.rejects(
    bob.service.writeAttachmentTo(aliceKey, newDmId(), fileId, path.join(outDir, 'x.bin')),
    (error: unknown) => error instanceof DmError && error.code === 'not-found'
  );
  await assert.rejects(
    bob.service.writeAttachmentTo(aliceKey, pending.id, newDmId(), path.join(outDir, 'y.bin')),
    (error: unknown) => error instanceof DmError && error.code === 'not-found'
  );
  await assert.rejects(
    bob.service.writeAttachmentTo('nao-e-uma-chave', pending.id, fileId, path.join(outDir, 'z.bin')),
    (error: unknown) => error instanceof DmError
  );
  await assert.rejects(bob.service.writeAttachmentTo(aliceKey, pending.id, fileId, 'relativo.bin'), /absolute file path/);
  await assert.rejects(bob.service.writeAttachmentTo(aliceKey, pending.id, fileId, ''), /absolute file path/);
  assert.equal(fs.existsSync('relativo.bin'), false);

  relay(devices, alice, alice.service.deleteMessage(bobKey, own.id));
  await assert.rejects(
    bob.service.writeAttachmentTo(aliceKey, pending.id, fileId, path.join(outDir, 'apagado.bin')),
    (error: unknown) => error instanceof DmError && error.code === 'not-found'
  );
});

/** Bob ingests what Alice dispatched to him, saves it, and the acks he sends back get lost on the way. */
function deliverLosingAcks(from: Device, to: Device, dispatch: DmDispatch): DmDispatch[] {
  const replies = (dispatch.peers?.[to.identity.publicKey] ?? []).map((item) =>
    to.service.ingest({ from: from.identity.publicKey, kind: item.kind, data: item.data }));
  to.service.flush();
  takeDispatches(to);
  return replies;
}

function storeOf(device: Device): DmPersistence {
  return new DmPersistence(device.dir, new DmKeyring(device.identity.publicKey, device.identity.privateKey).storageKey());
}

test('acks leave only after the message is saved, and a save that fails is tried again instead of dropped', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;
  // The conversation is open on Bob's side when its file stops accepting writes (a folder in the way fails the
  // rename the way a file held by an antivirus does).
  bob.service.getConversation(aliceKey);
  const conversationFile = path.join(bob.dir, DmPersistence.peerFileName(aliceKey));
  fs.mkdirSync(conversationFile);

  const [item] = alice.service.sendMessage({ peer: bobKey, content: 'precisa chegar ao disco' }).peers![bobKey];
  const received = bob.service.ingest({ from: aliceKey, kind: item.kind, data: item.data });
  assert.deepEqual(received.reply, [], 'No ack goes out before the message is saved');
  bob.service.flush();
  assert.deepEqual(takeDispatches(bob), [], 'A failed save releases no ack');
  assert.equal(bob.service.hasPendingAcks(), true);
  assert.equal(alice.service.getConversation(bobKey).messages[0].delivery, 'pending', 'Alice keeps it in her outbox');

  fs.rmdirSync(conversationFile);
  bob.service.flush();
  const acks = takeDispatches(bob);
  assert.equal(acks.length, 1, 'The write that failed stayed pending and the ack follows it');
  relay(devices, bob, acks[0]);
  assert.equal(alice.service.getConversation(bobKey).messages[0].delivery, 'delivered');
  assert.deepEqual(
    createDevice('Bob', bob.identity, bob.dir).service.getConversation(aliceKey).messages.map((message) => message.content),
    ['precisa chegar ao disco'],
  );

  // What is already on disk is confirmed at once.
  assert.equal(bob.service.ingest({ from: aliceKey, kind: item.kind, data: item.data }).reply?.length, 1);
});

test('an unreadable conversation is set aside instead of overwritten, and one that cannot be read now stays put', () => {
  const aliceIdentity = createIdentity();
  const alice = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  const bobKey = bob.identity.publicKey;
  befriend([alice, bob], alice, bob);
  relay([alice, bob], alice, alice.service.sendMessage({ peer: bobKey, content: 'guardada' }));
  alice.service.flush();
  const name = DmPersistence.peerFileName(bobKey);
  const file = path.join(alice.dir, name);
  const saved = fs.readFileSync(file);

  // Held by another program right now: the operation fails, and nothing is moved or replaced.
  fs.rmSync(file);
  fs.mkdirSync(file);
  const busy = createDevice('Alice', aliceIdentity, alice.dir);
  assert.throws(() => busy.service.getConversation(bobKey));
  assert.ok(fs.statSync(file).isDirectory());
  fs.rmdirSync(file);
  fs.writeFileSync(file, saved);
  assert.equal(busy.service.getConversation(bobKey).messages[0].content, 'guardada', 'The next try reads it');

  // Damaged: the bytes are kept aside, and only that conversation starts over.
  const damaged = Buffer.from(saved);
  damaged[damaged.length - 1] ^= 0xff;
  fs.writeFileSync(file, damaged);
  const reloaded = createDevice('Alice', aliceIdentity, alice.dir);
  assert.equal(peer(reloaded, bob.identity)?.relation, 'friend', 'Friends live in another file and stay');
  assert.deepEqual(reloaded.service.getConversation(bobKey).messages, []);
  const aside = fs.readdirSync(alice.dir).filter((entry) => entry.startsWith(`${name}.corrupt-`));
  assert.equal(aside.length, 1);
  assert.ok(fs.readFileSync(path.join(alice.dir, aside[0])).equals(damaged));

  // A state file that cannot be read now keeps the whole store closed instead of starting it empty.
  const state = path.join(alice.dir, 'state.mkdm');
  const savedState = fs.readFileSync(state);
  fs.rmSync(state);
  fs.mkdirSync(state);
  assert.throws(() => createDevice('Alice', aliceIdentity, alice.dir));
  fs.rmdirSync(state);
  fs.writeFileSync(state, savedState);
  assert.equal(peer(createDevice('Alice', aliceIdentity, alice.dir), bob.identity)?.relation, 'friend');
});

test('editing or deleting a message whose ack was lost still reaches the friend', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;

  deliverLosingAcks(alice, bob, alice.service.sendMessage({ peer: bobKey, content: 'primeira versão' }));
  const [sent] = alice.service.getConversation(bobKey).messages;
  assert.equal(sent.delivery, 'pending', 'Alice never heard back');
  relay(devices, alice, alice.service.editMessage(bobKey, sent.id, 'versão final'));
  const edited = bob.service.getConversation(aliceKey).messages[0];
  assert.equal(edited.content, 'versão final');
  assert.ok(edited.editedAt, 'Bob saw the first version, so it shows as edited');

  deliverLosingAcks(alice, bob, alice.service.sendMessage({ peer: bobKey, content: 'para apagar' }));
  const doomed = alice.service.getConversation(bobKey).messages[1];
  assert.equal(doomed.delivery, 'pending');
  relay(devices, alice, alice.service.deleteMessage(bobKey, doomed.id));
  const removed = bob.service.getConversation(aliceKey).messages.find((message) => message.id === doomed.id);
  assert.equal(removed?.deleted, true);
  assert.equal(removed?.content, '');
  assert.deepEqual(alice.service.pendingPeers(), [], 'Everything got confirmed in the end');
});

test('a message deleted or edited before it was delivered only ever shows up as its final version', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;

  bob.online = false;
  const lost = alice.service.sendMessage({ peer: bobKey, content: 'apagada antes de chegar' });
  relay(devices, alice, lost);
  const [doomed] = alice.service.getConversation(bobKey).messages;
  relay(devices, alice, alice.service.deleteMessage(bobKey, doomed.id));
  relay(devices, alice, alice.service.sendMessage({ peer: bobKey, content: 'rascunho' }));
  const draft = alice.service.getConversation(bobKey).messages.find((message) => message.content === 'rascunho');
  assert.ok(draft);
  relay(devices, alice, alice.service.editMessage(bobKey, draft.id, 'texto final'));

  bob.online = true;
  relay(devices, bob, bob.service.helloTo(aliceKey));
  const shown = () => bob.service.getConversation(aliceKey).messages.map((message) => message.content);
  assert.deepEqual(shown(), ['texto final'], 'The deleted message never shows up, not even as deleted');
  assert.equal(bob.service.getConversation(aliceKey).messages[0].editedAt, null, 'Bob never saw another version');
  assert.deepEqual(alice.service.pendingPeers(), []);

  // A copy of the deleted message that was still on its way arrives late and stays out, also after a restart.
  const [late] = lost.peers![bobKey];
  bob.service.ingest({ from: aliceKey, kind: late.kind, data: late.data });
  assert.deepEqual(shown(), ['texto final']);
  bob.service.flush();
  const restarted = createDevice('Bob', bob.identity, bob.dir);
  restarted.service.ingest({ from: aliceKey, kind: late.kind, data: late.data });
  assert.deepEqual(restarted.service.getConversation(aliceKey).messages.map((message) => message.content), ['texto final']);
});

test('a download whose last step fails can be tried again instead of staying "downloading"', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 2 + 5, 3);
  const dispatch = alice.service.sendMessage({
    peer: bob.identity.publicKey,
    content: '',
    files: [{ name: 'disco-cheio.bin', mime: 'application/octet-stream', data: new Uint8Array(content) }],
  });
  const fileId = alice.service.getConversation(bob.identity.publicKey).messages[0].attachments[0].fileId;
  const [request] = deliverLosingAcks(alice, bob, dispatch)[0].reply ?? [];
  assert.ok(request, 'Bob asks for the file');
  // Then the finished file cannot be written (a full disk behaves the same: the write throws).
  const target = path.join(bob.dir, 'files', `${fileId}.mkdm`);
  fs.mkdirSync(target);
  relay(devices, bob, { peers: { [aliceKey]: [request] } });
  const failed = bob.service.getConversation(aliceKey).messages[0];
  assert.equal(failed.attachments[0].state, 'failed', 'The failure is visible and offers "try again"');
  assert.deepEqual(bob.service.pendingPeers(), [], 'Nothing keeps asking for a file that is all here');

  fs.rmdirSync(target);
  relay(devices, bob, bob.service.retryAttachment(aliceKey, failed.id, fileId));
  const ready = bob.service.getConversation(aliceKey).messages[0];
  assert.equal(ready.attachments[0].state, 'ready');
  assert.ok(bob.service.readAttachment(aliceKey, ready.id, fileId).data.equals(content));
});

test('a partial download torn by a crash resumes from its last intact chunk, or completes when all of it is there', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 4 + 99);
  for (let index = 0; index < content.length; index += 1) content[index] = (index * 13) % 256;
  const send = () => {
    const dispatch = alice.service.sendMessage({
      peer: bob.identity.publicKey,
      content: '',
      files: [{ name: 'parcial.bin', mime: 'application/octet-stream', data: new Uint8Array(content) }],
    });
    const [request] = deliverLosingAcks(alice, bob, dispatch)[0].reply ?? [];
    assert.ok(request, 'Bob asks for the file');
    const message = alice.service.getConversation(bob.identity.publicKey).messages.at(-1)!;
    return { request, message, fileId: message.attachments[0].fileId };
  };

  // Two chunks arrive, then the app dies in the middle of appending the third.
  const torn = send();
  const chunks = alice.service.ingest({ from: bob.identity.publicKey, kind: torn.request.kind, data: torn.request.data }).reply!;
  for (const chunk of chunks.slice(0, 2)) bob.service.ingest({ from: aliceKey, kind: chunk.kind, data: chunk.data });
  const part = path.join(bob.dir, 'files', `${torn.fileId}.part`);
  fs.appendFileSync(part, Buffer.from([0, 1, 0x80, 0, 9, 9, 9]));
  bob.service.flush();

  // Everything arrived, but the app closed before putting the file together.
  const whole = send();
  const store = storeOf(bob);
  for (let index = 0; index * DM_FILE_CHUNK_BYTES < content.length; index += 1) {
    store.appendPart(whole.fileId, index, content.subarray(index * DM_FILE_CHUNK_BYTES, (index + 1) * DM_FILE_CHUNK_BYTES));
  }
  bob.service.flush();

  const restarted = createDevice('Bob', bob.identity, bob.dir);
  relay([alice, restarted], restarted, restarted.service.outgoing([aliceKey], true));
  for (const { message, fileId } of [torn, whole]) {
    const view = restarted.service.getConversation(aliceKey).messages.find((entry) => entry.id === message.id)!;
    assert.equal(view.attachments[0].state, 'ready');
    assert.ok(restarted.service.readAttachment(aliceKey, message.id, fileId).data.equals(content));
  }
});
test('edits that arrive out of order still leave both friends with the last text', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;
  relay(devices, alice, alice.service.sendMessage({ peer: bobKey, content: 'A' }));
  const [message] = alice.service.getConversation(bobKey).messages;
  const shown = (device: Device, other: Device) => device.service.getConversation(other.identity.publicKey).messages[0];

  // A → B → A, and the second edit gets there first: each send may go through a different server.
  const first = alice.service.editMessage(bobKey, message.id, 'B');
  const second = alice.service.editMessage(bobKey, message.id, 'A');
  relay(devices, alice, second);
  relay(devices, alice, first);
  assert.equal(shown(alice, bob).content, 'A');
  assert.equal(shown(bob, alice).content, 'A', 'The older edit arriving last does not bring "B" back');
  assert.equal(shown(bob, alice).editedAt, null, 'Bob never saw another text, so nothing shows as edited');
  relay(devices, alice, alice.service.outgoing([bobKey], true));
  relay(devices, bob, bob.service.outgoing([aliceKey], true));
  assert.equal(shown(bob, alice).content, 'A');
  assert.deepEqual(alice.service.pendingPeers(), []);

  // The clock survives a restart: the old edit arriving once more still loses.
  bob.service.flush();
  const restarted = createDevice('Bob', bob.identity, bob.dir);
  const [late] = first.peers![bobKey];
  restarted.service.ingest({ from: aliceKey, kind: late.kind, data: late.data });
  assert.equal(shown(restarted, alice).content, 'A');

  // And a later edit still wins everywhere.
  relay([alice, restarted], alice, alice.service.editMessage(bobKey, message.id, 'C'));
  assert.equal(shown(restarted, alice).content, 'C');
  assert.equal(shown(alice, bob).content, 'C');
});

test('a message edited while waiting for delivery arrives with its last text, and older edits on the way lose', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;
  bob.online = false;
  relay(devices, alice, alice.service.sendMessage({ peer: bobKey, content: 'rascunho' }));
  const [message] = alice.service.getConversation(bobKey).messages;
  const [, stale] = alice.service.editMessage(bobKey, message.id, 'quase').peers![bobKey];
  alice.service.editMessage(bobKey, message.id, 'final');
  bob.online = true;

  // The copy from the outbox gets there first, then the older edit that was already on its way, then the newest.
  const [latest, edit] = alice.service.outgoing([bobKey], true).peers![bobKey];
  const give = (item: DmRelayItem) => bob.service.ingest({ from: aliceKey, kind: item.kind, data: item.data });
  const shown = () => bob.service.getConversation(aliceKey).messages[0];
  give(latest);
  assert.equal(shown().content, 'final');
  give(stale);
  assert.equal(shown().content, 'final', 'The older edit cannot replace the text the message arrived with');
  give(edit);
  assert.equal(shown().content, 'final');
  assert.equal(shown().editedAt, null, 'Bob only ever saw the final text');
  assert.ok(!bob.events.some((event) => event.type === 'messages' && event.messages.some((view) => view.content === 'quase')),
    'The intermediate text never showed');
});

test('own devices that got the edits in different orders end with the same text', () => {
  const alice = createDevice('Alice', createIdentity());
  const bobIdentity = createIdentity();
  const bobs = [0, 1, 2].map(() => createDevice('Bob', bobIdentity));
  const [bob1, bob2, bob3] = bobs;
  const devices = [alice, ...bobs];
  befriend(devices, alice, bob1);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bobIdentity.publicKey;
  assert.ok(bobs.every((device) => peer(device, alice.identity)?.relation === 'friend'));
  relay(devices, alice, alice.service.sendMessage({ peer: bobKey, content: 'A' }));
  const [message] = alice.service.getConversation(bobKey).messages;
  const [edit1] = alice.service.editMessage(bobKey, message.id, 'B').peers![bobKey];
  const [edit2] = alice.service.editMessage(bobKey, message.id, 'A').peers![bobKey];
  const shown = (device: Device) => device.service.getConversation(aliceKey).messages[0];

  // Each device was online for a different part of it: bob1 and bob3 only got the first edit, bob2 only the second.
  for (const [device, item] of [[bob1, edit1], [bob3, edit1], [bob2, edit2]] as const) {
    device.service.ingest({ from: aliceKey, kind: item.kind, data: item.data });
  }
  assert.deepEqual(bobs.map((device) => shown(device).content), ['B', 'A', 'B']);

  // bob1 and bob2 compare history while bob3 is away; then bob3 only meets bob1, whose "edited" mark already
  // matches its own: the text clock is what tells them apart.
  bob3.online = false;
  relay(devices, bob2, bob2.service.hello(false));
  bob2.online = false;
  bob3.online = true;
  relay(devices, bob3, bob3.service.hello(false));
  assert.equal(shown(bob3).content, 'A');
  bob2.online = true;
  relay(devices, bob2, bob2.service.hello(false));
  assert.deepEqual(bobs.map((device) => shown(device).content), ['A', 'A', 'A']);
  assert.equal(new Set(bobs.map((device) => shown(device).editedAt)).size, 1, 'The edited mark agrees on every device');
  assert.equal(alice.service.getConversation(bobKey).messages[0].content, 'A');
});

/** Opens envelopes `sender` addressed to `receiver`, to tell which operations a dispatch carries. */
function envelopeTypes(items: DmRelayItem[] | undefined, sender: Device, receiver: Device): string[] {
  const keyring = new DmKeyring(receiver.identity.publicKey, receiver.identity.privateKey);
  const cert = new DmKeyring(sender.identity.publicKey, sender.identity.privateKey).certificate();
  return (items ?? []).map((item) => (item.kind === 'friend'
    ? 'statement'
    : keyring.open(item.data, sender.identity.publicKey, cert).header.type));
}

/** File requests `device` raised on its own (not as an answer) since the last look, addressed to `friend`. */
function fileRequestsRaised(device: Device, friend: Device): DmRelayItem[] {
  const key = friend.identity.publicKey;
  return takeDispatches(device)
    .flatMap((dispatch) => [...(dispatch.peers?.[key] ?? []), ...(dispatch.everywhere?.[key] ?? [])])
    .filter((item) => envelopeTypes([item], device, friend)[0] === 'file-req');
}

test('a download touches its part file once to put it together, and shows progress without redrawing the conversation', (context) => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 30 + 512);
  for (let index = 0; index < content.length; index += 1) content[index] = (index * 31) % 256;
  const partReads: string[] = [];
  const isPart = (target: unknown) => typeof target === 'string' && target.endsWith('.part');
  const openSync = fs.openSync;
  context.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    // Appending opens the part file too; only opening it to read counts.
    if (isPart(args[0]) && (args[1] === undefined || args[1] === 'r')) partReads.push('open');
    return openSync(...args);
  });
  const readFileSync = fs.readFileSync;
  context.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (isPart(args[0])) partReads.push('read');
    return readFileSync(...args);
  });
  const eventsBefore = bob.events.length;

  relay(devices, alice, alice.service.sendMessage({
    peer: bob.identity.publicKey,
    content: '',
    files: [{ name: 'video.mp4', mime: 'video/mp4', data: new Uint8Array(content) }],
  }));

  const message = bob.service.getConversation(aliceKey).messages[0];
  assert.equal(message.attachments[0].state, 'ready');
  assert.ok(bob.service.readAttachment(aliceKey, message.id, message.attachments[0].fileId).data.equals(content));
  // Before, every chunk read the whole part file twice: O(n²) bytes read for an n-chunk file.
  assert.deepEqual(partReads, ['open'], 'The part file is read once, when the file is put together');
  const events = bob.events.slice(eventsBefore);
  const redraws = events.filter((event) => event.type === 'messages' && event.messages.some((entry) => entry.id === message.id));
  // Arrived, started downloading, finished: not one full message per 96 KiB chunk.
  assert.equal(redraws.length, 3);
  const progress = events.flatMap((event) => (event.type === 'attachment-progress' ? [event] : []));
  assert.ok(progress.length > 0, 'Progress reaches the screen as a light event');
  assert.ok(progress.every((event, index) => event.messageId === message.id
    && event.receivedBytes > (progress[index - 1]?.receivedBytes ?? 0) && event.receivedBytes < content.length));
});

test('putting a download together checks size and hash before anything is published', () => {
  const identity = createIdentity();
  const dir = fs.mkdtempSync(path.join(tempRoot, 'part-'));
  const store = new DmPersistence(dir, new DmKeyring(identity.publicKey, identity.privateKey).storageKey());
  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 2 + 10, 9);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const fileId = newDmId();
  for (let index = 0; index * DM_FILE_CHUNK_BYTES < content.length; index += 1) {
    store.appendPart(fileId, index, content.subarray(index * DM_FILE_CHUNK_BYTES, (index + 1) * DM_FILE_CHUNK_BYTES));
  }
  assert.equal(store.completePart(fileId, content.length, '0'.repeat(64)), false, 'Another hash is refused');
  assert.equal(store.completePart(fileId, content.length + 1, sha256), false, 'Missing bytes are refused');
  assert.equal(store.hasAttachment(fileId), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'files')).filter((name) => name.endsWith('.tmp')), [],
    'A refused file leaves nothing half written behind');
  assert.equal(store.completePart(fileId, content.length, sha256), true);
  assert.ok(store.readAttachment(fileId)?.equals(content));
});

test('a friend that stops sending a file is asked again within seconds, not at the next outbox round', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const content = Buffer.alloc(DM_FILE_CHUNK_BYTES * 9 + 7, 5);
  const [messageItem] = alice.service.sendMessage({
    peer: bob.identity.publicKey,
    content: '',
    files: [{ name: 'lote.zip', mime: 'application/zip', data: new Uint8Array(content) }],
  }).peers![bob.identity.publicKey];
  const [request] = bob.service.ingest({ from: aliceKey, kind: messageItem.kind, data: messageItem.data }).reply ?? [];
  const window = alice.service.ingest({ from: bob.identity.publicKey, kind: request.kind, data: request.data }).reply!;
  // The relay drops most of the window on the way.
  for (const chunk of window.slice(0, 2)) bob.service.ingest({ from: aliceKey, kind: chunk.kind, data: chunk.data });

  context.mock.timers.tick(DM_DOWNLOAD_STALL_MS - 1);
  assert.deepEqual(fileRequestsRaised(bob, alice), [], 'Nothing is asked again while the window may still be on its way');
  context.mock.timers.tick(1);
  const retry = fileRequestsRaised(bob, alice);
  assert.equal(retry.length, 1, 'Bob asks again by himself');
  relay(devices, bob, { peers: { [aliceKey]: retry } });
  const message = bob.service.getConversation(aliceKey).messages[0];
  assert.equal(message.attachments[0].state, 'ready');
  assert.ok(bob.service.readAttachment(aliceKey, message.id, message.attachments[0].fileId).data.equals(content));

  // With nothing left to download, the timer is gone too.
  context.mock.timers.tick(DM_DOWNLOAD_STALL_MS * 4);
  assert.deepEqual(fileRequestsRaised(bob, alice), []);
});

test('quick retries stop after a few silent rounds and start over when the friend sends again', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  befriend([alice, bob], alice, bob);
  const aliceKey = alice.identity.publicKey;
  const [messageItem] = alice.service.sendMessage({
    peer: bob.identity.publicKey,
    content: '',
    files: [{ name: 'longe.bin', mime: 'application/octet-stream', data: new Uint8Array(DM_FILE_CHUNK_BYTES * 3) }],
  }).peers![bob.identity.publicKey];
  bob.service.ingest({ from: aliceKey, kind: messageItem.kind, data: messageItem.data });
  const retries = () => {
    context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
    return fileRequestsRaised(bob, alice).length;
  };
  assert.deepEqual([retries(), retries(), retries(), retries(), retries()], [1, 1, 1, 0, 0],
    'Alice is away: after three quick retries only the regular rounds ask again');
  const [request] = bob.service.outgoing([aliceKey]).everywhere?.[aliceKey] ?? [];
  const window = alice.service.ingest({ from: bob.identity.publicKey, kind: request.kind, data: request.data }).reply!;
  bob.service.ingest({ from: aliceKey, kind: window[0].kind, data: window[0].data });
  assert.equal(retries(), 1, 'A chunk shows she is back: quick retries start over');
});

/** Counts the attachments one device decrypts whole from its disk. */
function countAttachmentReads(context: TestContext, device: Device): string[] {
  const reads: string[] = [];
  const readAttachment = DmPersistence.prototype.readAttachment;
  context.mock.method(DmPersistence.prototype, 'readAttachment', function (this: DmPersistence, fileId: string) {
    if (this.dir === device.dir) reads.push(fileId);
    return readAttachment.call(this, fileId);
  });
  return reads;
}

function sampleFile(name: string, size: number, seed: number) {
  const data = Buffer.alloc(size);
  for (let index = 0; index < data.length; index += 1) data[index] = (index * seed) % 256;
  return { name, mime: 'application/octet-stream', data };
}

test('two files that do not fit in memory together are sent one after the other, each decrypted once', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const size = DM_FILE_CHUNK_BYTES * 20 + 100;
  // Room for one of them and a half: the second would push the first out of memory.
  const alice = createDevice('Alice', createIdentity(), undefined, undefined, Math.floor(size * 1.5));
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const files = [sampleFile('a.bin', size, 3), sampleFile('b.bin', size, 7)];
  const reads = countAttachmentReads(context, alice);

  // Bob asks for both at once, and each window he gets brings the request for the next one: Alice sees A, B, A, B...
  relay(devices, alice, alice.service.sendMessage({
    peer: bob.identity.publicKey,
    content: '',
    files: files.map((file) => ({ ...file, data: new Uint8Array(file.data) })),
  }));
  const message = () => bob.service.getConversation(aliceKey).messages[0];
  const [first, second] = message().attachments.map((entry) => entry.fileId);
  assert.deepEqual(reads, [first], 'The second file waits instead of pushing the first one out of memory');
  assert.deepEqual(message().attachments.map((entry) => entry.state), ['ready', 'pending']);

  // Bob asks again once Alice goes quiet, and the first file no longer needs the room.
  context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
  relay(devices, bob, {});
  assert.deepEqual(message().attachments.map((entry) => entry.state), ['ready', 'ready']);
  assert.deepEqual(reads, [first, second], 'Each file was decrypted once, not once per window');
  files.forEach((file, index) => {
    assert.ok(bob.service.readAttachment(aliceKey, message().id, message().attachments[index].fileId).data.equals(file.data));
  });
});

test('a transfer that stops holds its memory only for a while', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const size = DM_FILE_CHUNK_BYTES * 20 + 100;
  const alice = createDevice('Alice', createIdentity(), undefined, undefined, Math.floor(size * 1.5));
  const bob = createDevice('Bob', createIdentity());
  befriend([alice, bob], alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;
  const reads = countAttachmentReads(context, alice);
  const [messageItem] = alice.service.sendMessage({
    peer: bobKey,
    content: '',
    files: [sampleFile('a.bin', size, 3), sampleFile('b.bin', size, 7)].map((file) => ({ ...file, data: new Uint8Array(file.data) })),
  }).peers![bobKey];
  const [requestA] = bob.service.ingest({ from: aliceKey, kind: messageItem.kind, data: messageItem.data }).reply ?? [];
  const serve = (request: Pick<DmRelayItem, 'kind' | 'data'>) =>
    alice.service.ingest({ from: bobKey, kind: request.kind, data: request.data }).reply ?? [];
  // Each time Bob asks again, it is a new request, as his app seals every one.
  const fileB = alice.service.getConversation(bobKey).messages[0].attachments[1].fileId;
  const askForB = () => serve(sealedBy(bob, alice, 'file-req', { fileId: fileB, offset: 0, count: 6 }));

  // Bob got the first window of A and then went away; B has to wait while A may still be on its way.
  assert.equal(serve(requestA).length, 6);
  assert.deepEqual(envelopeTypes(askForB(), alice, bob), ['file-wait'], 'Bob is told to wait, not that the file is gone');
  context.mock.timers.tick(DM_FILE_TRANSFER_IDLE_MS - 1);
  assert.deepEqual(envelopeTypes(askForB(), alice, bob), ['file-wait'], 'A transfer that may only be slow keeps its file');
  context.mock.timers.tick(1);
  assert.equal(askForB().length, 6, 'Nobody asked for A in a while: B takes its place');
  assert.equal(reads.length, 2);
});

/**
 * Alice with two devices and Bob, all friends. Only `sender` sends here, so `copy` knows those messages from
 * the copy every own device gets, never their files. The relay hands Bob the answer of the device listed first.
 */
function senderWithCopy(first: 'copy' | 'sender', fileCacheMaxBytes?: number) {
  const aliceIdentity = createIdentity();
  const sender = createDevice('Alice', aliceIdentity, undefined, undefined, fileCacheMaxBytes);
  const copy = createDevice('Alice', aliceIdentity);
  const bob = createDevice('Bob', createIdentity());
  const devices = first === 'copy' ? [copy, sender, bob] : [sender, copy, bob];
  copy.online = false;
  befriend(devices, sender, bob);
  copy.online = true;
  relay(devices, copy, copy.service.hello(false));
  assert.equal(peer(copy, bob.identity)?.relation, 'friend', 'Both devices of Alice answer what Bob asks');
  return { sender, copy, bob, devices, aliceKey: aliceIdentity.publicKey, bobKey: bob.identity.publicKey };
}

/** What `device` answers to everything it is handed from now on. */
function captureAnswers(context: TestContext, device: Device): DmRelayItem[] {
  const answers: DmRelayItem[] = [];
  const ingest = device.service.ingest.bind(device.service);
  context.mock.method(device.service, 'ingest', (item: DmIncomingRelayItem) => {
    const result = ingest(item);
    answers.push(...(result.reply ?? []));
    return result;
  });
  return answers;
}

/** Opens what `sender` addressed to `receiver`: the type and body of each envelope. */
function opened(items: DmRelayItem[], sender: Device, receiver: Device) {
  const keyring = new DmKeyring(receiver.identity.publicKey, receiver.identity.privateKey);
  const cert = new DmKeyring(sender.identity.publicKey, sender.identity.privateKey).certificate();
  return items.filter((item) => item.kind !== 'friend' && item.to === receiver.identity.publicKey)
    .map((item) => keyring.open(item.data, sender.identity.publicKey, cert))
    .map(({ header, body }) => ({ type: header.type, body }));
}

/** An envelope sealed by hand, as another version of the app sends it. */
function sealedBy(sender: Device, receiver: Device, type: string, body: unknown): DmIncomingRelayItem {
  const keyring = new DmKeyring(sender.identity.publicKey, sender.identity.privateKey);
  const cert = new DmKeyring(receiver.identity.publicKey, receiver.identity.privateKey).certificate();
  const data = keyring.seal(receiver.identity.publicKey, cert, { id: newDmId(), type, ts: Date.now() }, body);
  return { from: sender.identity.publicKey, kind: 'signal', data };
}

test('a file downloads whole while another device of the sender, which only has its copy of the message, answers too', (context) => {
  // The device without the file answers first: before, its "missing" ended the download right there.
  const { sender, copy, bob, devices, aliceKey, bobKey } = senderWithCopy('copy');
  const file = sampleFile('ferias.mp4', DM_FILE_CHUNK_BYTES * 14 + 321, 11);
  const copyReads = countAttachmentReads(context, copy);
  const copyAnswers = captureAnswers(context, copy);
  const dispatch = sender.service.sendMessage({ peer: bobKey, content: '', files: [{ ...file, data: new Uint8Array(file.data) }] });
  for (const item of dispatch.broadcast ?? []) copy.service.ingest({ from: aliceKey, kind: item.kind, data: item.data });
  const copied = copy.service.getConversation(bobKey).messages[0];
  assert.equal(copied.attachments[0].state, 'unavailable', 'The other device has the message, not the file');
  const [message] = dispatch.peers![bobKey];
  const [request] = bob.service.ingest({ from: aliceKey, kind: message.kind, data: message.data }).reply ?? [];
  const state = () => bob.service.getConversation(aliceKey).messages[0].attachments[0].state;

  // Versions before #490 of that other device say "missing" when they only lack the file.
  bob.service.ingest(sealedBy(copy, bob, 'file-missing', { fileId: copied.attachments[0].fileId }));
  assert.equal(state(), 'pending', 'An older device saying it lacks the file does not end the download');

  relay(devices, bob, { peers: { [aliceKey]: [request] } });
  const received = bob.service.getConversation(aliceKey).messages[0];
  assert.equal(received.attachments[0].state, 'ready');
  assert.ok(bob.service.readAttachment(aliceKey, received.id, received.attachments[0].fileId).data.equals(file.data));
  const answers = opened(copyAnswers, copy, bob).filter((answer) => answer.type.startsWith('file-'));
  assert.ok(answers.length > 0 && answers.every((answer) => answer.type === 'file-absent'),
    `The device without the file only says it is not there: ${JSON.stringify(answers.map((answer) => answer.type))}`);
  assert.deepEqual(copyReads, [], 'It never looks for the file on its disk');
});

test('when no device of the sender has the file, the download ends as unavailable after the quick retries, and can be tried again', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const { sender, copy, bob, devices, aliceKey, bobKey } = senderWithCopy('copy');
  const file = sampleFile('relatorio.pdf', DM_FILE_CHUNK_BYTES * 3 + 9, 5);
  const dispatch = sender.service.sendMessage({ peer: bobKey, content: '', files: [{ ...file, data: new Uint8Array(file.data) }] });
  for (const item of dispatch.broadcast ?? []) copy.service.ingest({ from: aliceKey, kind: item.kind, data: item.data });
  // The device that sent it goes away for good: only the other device answers, round after round.
  sender.online = false;
  const [message] = dispatch.peers![bobKey];
  relay(devices, bob, bob.service.ingest({ from: aliceKey, kind: message.kind, data: message.data }));
  const state = () => bob.service.getConversation(aliceKey).messages[0].attachments[0].state;
  assert.equal(state(), 'pending');
  for (let round = 1; round < 3; round += 1) {
    context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
    relay(devices, bob, {});
    assert.equal(state(), 'pending', `Round ${round} with only "not here" still asks again`);
  }
  context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
  relay(devices, bob, {});
  assert.equal(state(), 'unavailable', 'Three rounds with nothing else: no device of Alice has it');

  // Once the device that has it is back, trying again brings the file.
  sender.online = true;
  const pending = bob.service.getConversation(aliceKey).messages[0];
  relay(devices, bob, bob.service.retryAttachment(aliceKey, pending.id, pending.attachments[0].fileId));
  assert.equal(state(), 'ready');
  assert.ok(bob.service.readAttachment(aliceKey, pending.id, pending.attachments[0].fileId).data.equals(file.data));
});

test('a friend without the file does not end a download, while no answer at all keeps it waiting', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const { sender, copy, bob, devices, aliceKey, bobKey } = senderWithCopy('copy');
  const file = sampleFile('fotos.zip', DM_FILE_CHUNK_BYTES * 2 + 1, 13);
  const dispatch = sender.service.sendMessage({ peer: bobKey, content: '', files: [{ ...file, data: new Uint8Array(file.data) }] });
  // Nobody of Alice's is around: Bob's requests get no answer, which only means "later".
  sender.online = false;
  copy.online = false;
  const [message] = dispatch.peers![bobKey];
  relay(devices, bob, bob.service.ingest({ from: aliceKey, kind: message.kind, data: message.data }));
  for (let round = 0; round < 6; round += 1) {
    context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
    relay(devices, bob, {});
    relay(devices, bob, bob.service.outgoing([aliceKey]));
  }
  const state = () => bob.service.getConversation(aliceKey).messages[0].attachments[0].state;
  assert.equal(state(), 'pending', 'Unanswered requests never make a file unavailable');

  // Rounds of "not here" from the device without it, one short of giving up; then the device that sent it greets Bob.
  copy.online = true;
  for (let round = 0; round < 3; round += 1) relay(devices, bob, bob.service.outgoing([aliceKey], true));
  assert.equal(state(), 'pending');
  sender.online = true;
  const [hello] = sender.service.helloTo(bobKey).peers![bobKey];
  relay(devices, sender, { peers: { [bobKey]: [hello] } });
  assert.equal(state(), 'ready', 'A device that just came gets asked before anything is given up');
});

test('the device that sent a file and lost it says so for good, and the download ends at once', (context) => {
  const { sender, bob, devices, aliceKey, bobKey } = senderWithCopy('copy');
  const file = sampleFile('apagado.bin', DM_FILE_CHUNK_BYTES * 2, 3);
  const senderAnswers = captureAnswers(context, sender);
  const dispatch = sender.service.sendMessage({ peer: bobKey, content: '', files: [{ ...file, data: new Uint8Array(file.data) }] });
  storeOf(sender).deleteAttachment(sender.service.getConversation(bobKey).messages[0].attachments[0].fileId);
  relay(devices, sender, dispatch);
  assert.equal(bob.service.getConversation(aliceKey).messages[0].attachments[0].state, 'unavailable');
  const answers = opened(senderAnswers, sender, bob).filter((answer) => answer.type.startsWith('file-'));
  // Versions before #490 already read "file-missing" as final; the flag tells newer ones it is.
  const final = (body: unknown) => (typeof body === 'object' && body !== null && 'final' in body ? body.final : undefined);
  assert.deepEqual(answers.map((answer) => [answer.type, final(answer.body)]), [['file-missing', true]]);
});

test('a file waiting its turn behind a long transfer is not given up on, whatever the other devices say', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const size = DM_FILE_CHUNK_BYTES * 20 + 100;
  // The sender answers first, so each "not here" from the copy comes after its "wait": the order that could undo it.
  const { sender, copy, bob, devices, aliceKey, bobKey } = senderWithCopy('sender', Math.floor(size * 1.5));
  const carol = createDevice('Carol', createIdentity());
  befriend([sender, carol], sender, carol);
  const carolKey = carol.identity.publicKey;
  const senderReads = countAttachmentReads(context, sender);
  const copyReads = countAttachmentReads(context, copy);

  // Carol downloads a large file of Alice's slowly: she keeps asking for it (a new request each time, as her app
  // seals every one), so it keeps its room in memory.
  const [toCarol] = sender.service.sendMessage({
    peer: carolKey, content: '', files: [{ ...sampleFile('c.bin', size, 3), data: new Uint8Array(size) }],
  }).peers![carolKey];
  carol.service.ingest({ from: aliceKey, kind: toCarol.kind, data: toCarol.data });
  const carolFile = sender.service.getConversation(carolKey).messages[0].attachments[0].fileId;
  const carolAsks = () => sender.service.ingest(sealedBy(carol, sender, 'file-req', { fileId: carolFile, offset: 0, count: 6 })).reply ?? [];
  assert.equal(carolAsks().length, 6);

  const file = sampleFile('b.bin', size, 7);
  relay(devices, sender, sender.service.sendMessage({ peer: bobKey, content: '', files: [{ ...file, data: new Uint8Array(file.data) }] }));
  const state = () => bob.service.getConversation(aliceKey).messages[0].attachments[0].state;
  assert.equal(state(), 'pending');
  for (let round = 0; round < 8; round += 1) {
    carolAsks();
    context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
    relay(devices, bob, {});
  }
  assert.equal(state(), 'pending', 'Forty seconds of "wait" keep the download going, "not here" from the other device or not');

  // Carol is done: her file gives its room up once nobody asked for it in a while.
  for (let elapsed = 0; elapsed <= DM_FILE_TRANSFER_IDLE_MS + DM_DOWNLOAD_STALL_MS && state() !== 'ready'; elapsed += DM_DOWNLOAD_STALL_MS) {
    context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
    relay(devices, bob, {});
  }
  const received = bob.service.getConversation(aliceKey).messages[0];
  assert.equal(received.attachments[0].state, 'ready');
  assert.ok(bob.service.readAttachment(aliceKey, received.id, received.attachments[0].fileId).data.equals(file.data));
  assert.equal(senderReads.length, 2, 'Each file was decrypted once');
  assert.deepEqual(copyReads, []);
});

/** A server Bob is signed in to, where Alice is online and the DM relay is on. */
function serverFor(host: string, bob: Device, alice: Identity): ServerSession {
  const session = sessionManager.create(host, 7900, bob.name);
  const member = (identity: Identity, nickname: string): UserSummary => ({
    id: `${host}-${nickname}`, clientId: nickname, publicKey: identity.publicKey, nickname, status: 'ONLINE', joinedAt: 1,
    sessionId: `${host}-${nickname}:device`,
  });
  const me = member(bob.identity, bob.name);
  session.serverStore.setServerDetails({
    id: host, name: host, createdAt: 1, maxUsers: 10, members: [me, member(alice, 'Alice')], voiceStates: {},
    channels: [], myPermissions: 0, protocol: { ...createProtocolOffer('client'), version: PROTOCOL_VERSION },
  }, me);
  return session;
}

/** The main process behind a renderer transport, answered by the service itself. */
function relayApi(service: DmService): DmRelayApi {
  const answer = async <T>(run: () => T): Promise<DmResult<T>> => ({ ok: true, value: run() });
  return {
    ingest: (item) => answer(() => service.ingest(item)),
    outgoing: (peers, force) => answer(() => service.outgoing(peers, force)),
    hello: (toFriends, announce) => answer(() => service.hello(toFriends, announce)),
    helloTo: (peerKey) => answer(() => service.helloTo(peerKey)),
    setSelfNickname: (nickname) => answer(() => service.setSelfNickname(nickname)),
    observePeer: (observed) => answer(() => service.observePeer(observed)),
  };
}

function relayedItems(payload: unknown): DmRelayItem[] {
  if (!payload || typeof payload !== 'object' || !('items' in payload) || !Array.isArray(payload.items)) return [];
  return payload.items;
}

test('a file reaches Bob through the server of the device that has it, even when Alice was last heard on another one', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  // Alice's notebook sent the file and is only on S1; her desktop only has its copy of the message and is only on S2.
  const { sender: notebook, copy: desktop, bob, aliceKey, bobKey } = senderWithCopy('copy');
  const file = sampleFile('viagem.mp4', DM_FILE_CHUNK_BYTES * 10 + 77, 17);
  const dispatch = notebook.service.sendMessage({ peer: bobKey, content: '', files: [{ ...file, data: new Uint8Array(file.data) }] });
  for (const item of dispatch.broadcast ?? []) desktop.service.ingest({ from: aliceKey, kind: item.kind, data: item.data });
  // Bob gets the message, but his first request for the file is lost on the way.
  const [messageItem] = dispatch.peers![bobKey];
  bob.service.ingest({ from: aliceKey, kind: messageItem.kind, data: messageItem.data });
  const state = () => bob.service.getConversation(aliceKey).messages[0].attachments[0].state;
  assert.equal(state(), 'pending');

  // Each server reaches only the device of Alice connected to it, and what that device answers comes back the same way.
  let s1Connected = false;
  const s1 = serverFor('dm-route-s1.test', bob, notebook.identity);
  const s2 = serverFor('dm-route-s2.test', bob, desktop.identity);
  const toBob: Array<() => void> = [];
  const deliverVia = (session: ServerSession, items: DmRelayItem[]) => {
    for (const item of items) {
      if (item.to !== bobKey) continue;
      toBob.push(() => session.client['notifyEventListeners'](`message.${MessageType.DM_RELAY_DELIVER}`,
        { from: aliceKey, kind: item.kind, data: item.data }));
    }
  };
  for (const [session, device, connected] of [[s1, notebook, () => s1Connected], [s2, desktop, () => true]] as const) {
    context.mock.method(session.client, 'getStatus', () => (connected() ? 'CONNECTED' : 'CONNECTING'));
    context.mock.method(session.client, 'send', (type: MessageType, payload: unknown) => {
      if (type !== MessageType.DM_RELAY_SEND) return;
      for (const item of relayedItems(payload)) {
        if (item.to !== aliceKey) continue;
        const answer = device.service.ingest({ from: bobKey, kind: item.kind, data: item.data });
        const forPeers = [...Object.values(answer.peers ?? {}), ...Object.values(answer.everywhere ?? {})].flat();
        deliverVia(session, [...(answer.reply ?? []), ...forPeers]);
      }
    });
  }
  const transport = new DmTransport(relayApi(bob.service));
  context.after(async () => {
    transport.stop();
    context.mock.timers.reset();
    await sessionManager.removeAll();
  });
  /** Runs Bob's transport and both servers until nothing is left on the way; what Bob raises goes out as in the app. */
  const settle = async () => {
    for (let idle = 0, turn = 0; idle < 20 && turn < 5_000; turn += 1) {
      const raised = takeDispatches(bob);
      for (const raisedDispatch of raised) transport.execute(raisedDispatch);
      const deliveries = toBob.splice(0);
      for (const deliver of deliveries) deliver();
      idle = raised.length === 0 && deliveries.length === 0 ? idle + 1 : 0;
      await nextTurn();
    }
  };

  transport.setIdentity(bobKey, [aliceKey], [aliceKey]);
  transport.start();
  await settle();
  // S2 was up first: Bob asked for the file there, and the desktop answered that it does not have it.
  s1Connected = true;
  transport.flushSoon();
  await settle();
  // Then Alice does something on the desktop: S2 is where Bob heard from her last.
  context.mock.timers.tick(1_000);
  deliverVia(s2, desktop.service.typing(bobKey).peers?.[bobKey] ?? []);
  await settle();
  for (let round = 0; round < 6 && state() !== 'ready'; round += 1) {
    context.mock.timers.tick(DM_DOWNLOAD_STALL_MS);
    await settle();
  }
  assert.equal(state(), 'ready', 'Bob also asked through the server where the device that has the file is');
  const received = bob.service.getConversation(aliceKey).messages[0];
  assert.ok(bob.service.readAttachment(aliceKey, received.id, received.attachments[0].fileId).data.equals(file.data));
});

test('a device on two servers with the friend answers one copy of a file request, not each', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  befriend([alice, bob], alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;
  const [messageItem] = alice.service.sendMessage({
    peer: bobKey, content: '', files: [{ ...sampleFile('dois.bin', DM_FILE_CHUNK_BYTES * 8, 9), data: new Uint8Array(DM_FILE_CHUNK_BYTES * 8) }],
  }).peers![bobKey];
  bob.service.ingest({ from: aliceKey, kind: messageItem.kind, data: messageItem.data });
  const [request] = bob.service.outgoing([aliceKey], true).everywhere?.[aliceKey] ?? [];
  assert.ok(request, 'Asking again for a file goes to every server Alice is on');
  const serve = (item: DmRelayItem) => alice.service.ingest({ from: bobKey, kind: item.kind, data: item.data }).reply ?? [];

  assert.equal(serve(request).length, 6, 'The copy that arrives first is answered');
  assert.deepEqual(serve(request), [], 'The same request arriving through the other server sends nothing again');
  const [again] = bob.service.outgoing([aliceKey], true).everywhere?.[aliceKey] ?? [];
  assert.equal(serve(again).length, 6, 'A new request for the same window is answered');
});

test('one sighting of a friend sends the outbox once, however many hellos it brings', () => {
  const alice = createDevice('Alice', createIdentity());
  const bob = createDevice('Bob', createIdentity());
  const devices = [alice, bob];
  befriend(devices, alice, bob);
  const aliceKey = alice.identity.publicKey;
  const bobKey = bob.identity.publicKey;
  bob.online = false;
  relay(devices, alice, alice.service.sendMessage({ peer: bobKey, content: 'um' }));
  relay(devices, alice, alice.service.sendMessage({ peer: bobKey, content: 'dois' }));
  bob.online = true;

  const greet = () => {
    const [hello] = bob.service.helloTo(aliceKey).peers![aliceKey];
    return envelopeTypes(alice.service.ingest({ from: bobKey, kind: hello.kind, data: hello.data }).reply, alice, bob);
  };
  const first = greet();
  assert.equal(first.filter((type) => type === 'msg').length, 2, 'The first hello brings the outbox');
  assert.ok(first.includes('hello'));
  const second = greet();
  assert.equal(second.filter((type) => type === 'msg').length, 0, 'A hello moments later does not send it again');
  assert.ok(second.includes('hello'), 'It is still answered');
});