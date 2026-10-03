import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { DmDispatch, DmEvent, DmRelayItem } from '@monky/shared';
import { DmKeyring, verifyDmCertificate } from '../src/main/dm/dmCrypto';
import { DmError, DmService, DM_FILE_CHUNK_BYTES } from '../src/main/dm/dmService';

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
  dir: string;
  online: boolean;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-dm-test-'));
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));

function createDevice(
  name: string,
  identity: Identity,
  dir = fs.mkdtempSync(path.join(tempRoot, `${name}-`)),
  now?: () => number
): Device {
  const events: DmEvent[] = [];
  const service = new DmService({
    keyring: new DmKeyring(identity.publicKey, identity.privateKey),
    dir,
    now,
    onEvent: (event) => events.push(event),
  });
  service.setSelfNickname(name);
  return { name, identity, service, events, dir, online: true };
}

/** Relay that behaves like the server: deliver to every other online device of the recipient identity. */
function relay(devices: Device[], origin: Device, dispatch: DmDispatch, budget = { left: 5000 }): void {
  const queue: Array<{ origin: Device; item: DmRelayItem }> = [];
  const enqueue = (from: Device, result: DmDispatch) => {
    for (const items of Object.values(result.peers ?? {})) for (const item of items) queue.push({ origin: from, item });
    for (const item of result.broadcast ?? []) queue.push({ origin: from, item });
    for (const item of result.reply ?? []) queue.push({ origin: from, item });
  };
  enqueue(origin, dispatch);
  while (queue.length > 0) {
    assert.ok(budget.left-- > 0, 'relay loop did not converge');
    const { origin: sender, item } = queue.shift()!;
    if (!sender.online) continue;
    for (const device of devices) {
      if (device === sender || !device.online || device.identity.publicKey !== item.to) continue;
      enqueue(device, device.service.ingest({ from: sender.identity.publicKey, kind: item.kind, data: item.data }));
    }
  }
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
  // Reply = [ack, file request]; the request is the second item.
  assert.equal(afterMessage.reply?.length, 2);
  const fileRequest = afterMessage.reply![1];
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
