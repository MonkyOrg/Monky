import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { DmDispatch, DmEvent, DmRelayItem } from '@monky/shared';
import { DmKeyring, newDmId } from '../src/main/dm/dmCrypto';
import { DmFriends } from '../src/main/dm/dmFriends';
import { DmLedger } from '../src/main/dm/dmLedger';
import { DmOutbox } from '../src/main/dm/dmOutbox';
import { DmPersistence } from '../src/main/dm/dmPersistence';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-dm-friends-test-'));
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));

interface Side {
  key: string;
  ledger: DmLedger;
  outbox: DmOutbox;
  friends: DmFriends;
  events: DmEvent[];
}

function side(name: string): Side {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyring = new DmKeyring(
    publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  );
  const store = new DmPersistence(fs.mkdtempSync(path.join(tempRoot, `${name}-`)), keyring.storageKey());
  const events: DmEvent[] = [];
  const ledger = new DmLedger(keyring.identityPublicKey, store, Date.now, (event) => events.push(event));
  const outbox = new DmOutbox(ledger, keyring);
  return { key: keyring.identityPublicKey, ledger, outbox, friends: new DmFriends(ledger, outbox), events };
}

/** The signed statements of `dispatch` addressed to `to`. */
function statements(dispatch: DmDispatch, to: Side): DmRelayItem[] {
  return [...(dispatch.peers?.[to.key] ?? []), ...(dispatch.reply ?? [])]
    .filter((item) => item.kind === 'friend' && item.to === to.key);
}

/** Hands the statements `from` dispatched to `to`, and the statements `to` answers back, until none is left. */
function deliver(from: Side, to: Side, dispatch: DmDispatch): void {
  for (const item of statements(dispatch, to)) deliver(to, from, to.friends.ingestStatement(from.key, item.data));
}

function befriend(alice: Side, bob: Side): void {
  deliver(alice, bob, alice.friends.sendRequest(bob.key));
  deliver(bob, alice, bob.friends.accept(alice.key));
}

/** What a peer record keeps about a request or a friendship. */
function relationOf(owner: Side, other: Side) {
  const record = owner.ledger.state.peers[other.key];
  return {
    relation: record?.relation,
    requestId: record?.requestId,
    requestedAt: record?.requestedAt,
    friendSince: record?.friendSince,
    outgoingStatement: record?.outgoingStatement,
  };
}

const NO_RELATION = { relation: 'none', requestId: null, requestedAt: null, friendSince: null, outgoingStatement: null };

function queuedTypes(owner: Side, other: Side): string[] {
  return (owner.ledger.state.outbox[other.key] ?? []).map((entry) => entry.type);
}

/** A message to `other` still waiting for its ack: in the conversation as pending, and in the outbox. */
function pendingMessage(owner: Side, other: Side): string {
  const record = owner.ledger.state.peers[other.key];
  const id = newDmId();
  const ts = owner.ledger.stamp();
  owner.ledger.conversation(other.key).messages.push({
    id, author: owner.key, content: 'ainda sem ack', createdAt: ts, editedAt: null, deleted: false, replyTo: null,
    reactions: {}, attachments: [], delivery: 'pending', forwarded: null,
  });
  owner.outbox.queueEnvelope(record, 'msg', { content: 'ainda sem ack', replyTo: null, attachments: [] }, id, ts);
  return id;
}

test('a request answered either way leaves no request queued, and both sides end as friends', () => {
  const alice = side('alice');
  const bob = side('bob');
  befriend(alice, bob);
  assert.equal(relationOf(alice, bob).relation, 'friend');
  assert.equal(relationOf(bob, alice).relation, 'friend');
  assert.deepEqual(queuedTypes(alice, bob), [], 'The answered request is not sent again');
  assert.deepEqual(queuedTypes(bob, alice), ['accept'], 'The answer waits for its ack');
  assert.ok(alice.events.some((event) => event.type === 'friend-accepted'));

  // Both ask at once: each request reads as the answer to the other.
  const carol = side('carol');
  const dave = side('dave');
  const fromCarol = carol.friends.sendRequest(dave.key);
  const fromDave = dave.friends.sendRequest(carol.key);
  deliver(carol, dave, fromCarol);
  deliver(dave, carol, fromDave);
  for (const [owner, other] of [[carol, dave], [dave, carol]] as const) {
    assert.equal(relationOf(owner, other).relation, 'friend');
    assert.equal(relationOf(owner, other).outgoingStatement, null);
    assert.ok(!queuedTypes(owner, other).includes('request'), 'An answered request is not sent again');
    assert.ok(owner.ledger.state.conversations[other.key], 'The conversation is there for the first message');
  }
});

test('every way a request or a friendship ends leaves nothing of it behind', () => {
  // Declined, and withdrawn by whoever asked.
  const alice = side('alice');
  const bob = side('bob');
  deliver(alice, bob, alice.friends.sendRequest(bob.key));
  deliver(bob, alice, bob.friends.decline(alice.key));
  assert.deepEqual(relationOf(bob, alice), NO_RELATION);
  assert.equal(relationOf(alice, bob).relation, 'outgoing', 'Declining is silent');
  deliver(alice, bob, alice.friends.cancel(bob.key));
  assert.deepEqual(relationOf(alice, bob), NO_RELATION);
  assert.deepEqual(queuedTypes(alice, bob), ['cancel'], 'Only the withdrawal waits to be delivered');

  // Withdrawn while the friend still had it: their side lets it go too.
  deliver(alice, bob, alice.friends.sendRequest(bob.key));
  assert.equal(relationOf(bob, alice).relation, 'incoming');
  deliver(alice, bob, alice.friends.cancel(bob.key));
  assert.deepEqual(relationOf(bob, alice), NO_RELATION);

  // Removed, here and on the friend's side: what waited for the friend fails visibly.
  const carol = side('carol');
  const dave = side('dave');
  befriend(carol, dave);
  const fromCarol = pendingMessage(carol, dave);
  const fromDave = pendingMessage(dave, carol);
  deliver(carol, dave, carol.friends.remove(dave.key));
  for (const [owner, other, id] of [[carol, dave, fromCarol], [dave, carol, fromDave]] as const) {
    assert.deepEqual(relationOf(owner, other), NO_RELATION);
    assert.ok(!queuedTypes(owner, other).includes('msg'));
    assert.equal(owner.ledger.findMessage(other.key, id)?.delivery, 'failed');
  }

  // Blocked: a friend sees the friendship end, someone asked sees the request withdrawn.
  const erin = side('erin');
  const frank = side('frank');
  befriend(erin, frank);
  deliver(erin, frank, erin.friends.block(frank.key));
  assert.deepEqual(relationOf(erin, frank), NO_RELATION);
  assert.equal(erin.ledger.state.peers[frank.key].blocked, true);
  assert.deepEqual(relationOf(frank, erin), NO_RELATION);
  const gina = side('gina');
  deliver(erin, gina, erin.friends.sendRequest(gina.key));
  deliver(erin, gina, erin.friends.block(gina.key));
  assert.deepEqual(relationOf(erin, gina), NO_RELATION);
  assert.ok(!queuedTypes(erin, gina).includes('request'));
  assert.deepEqual(relationOf(gina, erin), NO_RELATION, 'The request was withdrawn');
});

test('a statement counts only when its shape, its sender and its signature all hold', () => {
  const alice = side('alice');
  const bob = side('bob');
  const mallory = side('mallory');
  const [request] = statements(alice.friends.sendRequest(bob.key), bob);
  const reshaped = (change: (statement: { p: Record<string, unknown>; s: unknown }) => void): string => {
    const statement = JSON.parse(request.data);
    change(statement);
    return JSON.stringify(statement);
  };
  for (const data of [
    'not json',
    'null',
    reshaped((statement) => { statement.p.nickname = 42; }),
    reshaped((statement) => { statement.p.type = 'invite'; }),
    reshaped((statement) => { statement.s = 7; }),
    reshaped((statement) => { statement.p.maxFileBytes = 1; }),
  ]) {
    assert.deepEqual(bob.friends.ingestStatement(alice.key, data), {}, data.slice(0, 80));
  }
  assert.deepEqual(bob.friends.ingestStatement(mallory.key, request.data), {}, 'A relay that lies about the sender gets nothing');
  assert.equal(bob.ledger.state.peers[alice.key], undefined);
  bob.friends.ingestStatement(alice.key, request.data);
  assert.equal(relationOf(bob, alice).relation, 'incoming');
});
