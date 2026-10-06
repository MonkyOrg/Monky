import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_CLIENT_PROTOCOL,
  MessageType,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  type UserActivity,
} from '@monky/shared';
import { createFixture, identity, record, text } from './testFixtures/bots';

const game: UserActivity = { source: 'steam', appId: 606150, name: 'Moonlighter', startedAt: 1_758_200_000_000 };

/** Same protocol as today's client, minus the feature under test. */
const withoutGameActivity = {
  minimumVersion: MIN_CLIENT_PROTOCOL,
  features: PROTOCOL_FEATURES.filter((feature) => feature !== 'game-activity'),
};

async function legacyHuman(f: Awaited<ReturnType<typeof createFixture>>, nickname: string) {
  return f.human(nickname, identity(), undefined, false, PROTOCOL_VERSION, withoutGameActivity);
}

function updatedUser(message: { payload: Record<string, unknown> }) {
  return record(message.payload.user);
}

test('game activity reaches peers that negotiated it and is stripped for those that did not', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  const bob = await f.human('Bob');
  const legacy = await legacyHuman(f, 'Legacy');

  const bobStart = bob.peer.messages.length;
  const legacyStart = legacy.peer.messages.length;
  const own = await alice.peer.request(MessageType.USER_UPDATE_ACTIVITY, { activity: game });
  assert.equal(own.type, MessageType.USER_UPDATED);
  assert.deepEqual(updatedUser(own).activity, game);

  const isAliceUpdate = (message: { type: string; payload: Record<string, unknown> }) =>
    message.type === MessageType.USER_UPDATED && text(updatedUser(message).id) === alice.id;
  assert.deepEqual(updatedUser(await bob.peer.wait(isAliceUpdate, bobStart)).activity, game);
  const toLegacy = updatedUser(await legacy.peer.wait(isAliceUpdate, legacyStart));
  assert.equal(Object.hasOwn(toLegacy, 'activity'), false);

  // Clearing is a real update too, or the last game would stay frozen on the card.
  const clearStart = bob.peer.messages.length;
  await alice.peer.request(MessageType.USER_UPDATE_ACTIVITY, { activity: null });
  assert.equal(updatedUser(await bob.peer.wait(isAliceUpdate, clearStart)).activity, null);
});

test('the member list handed to a newcomer carries the game only when the newcomer negotiated it', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  await alice.peer.request(MessageType.USER_UPDATE_ACTIVITY, { activity: game });

  const aliceIn = (auth: { payload: Record<string, unknown> }) => {
    const members = record(auth.payload.server).members;
    assert.ok(Array.isArray(members));
    const member = members.map(record).find((candidate) => text(candidate.id) === alice.id);
    assert.ok(member, 'Alice must be in the member list');
    return member;
  };
  assert.deepEqual(aliceIn((await f.human('Carol')).auth).activity, game);
  assert.equal(Object.hasOwn(aliceIn((await legacyHuman(f, 'Legacy')).auth), 'activity'), false);
});

test('coming back from appear-offline re-announces the game only to peers that negotiated it', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  const bob = await f.human('Bob');
  const legacy = await legacyHuman(f, 'Legacy');
  await alice.peer.request(MessageType.USER_UPDATE_ACTIVITY, { activity: game });
  await alice.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: true });

  const bobStart = bob.peer.messages.length;
  const legacyStart = legacy.peer.messages.length;
  await alice.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: false });
  const isAliceJoin = (message: { type: string; payload: Record<string, unknown> }) =>
    message.type === MessageType.USER_JOINED && text(updatedUser(message).id) === alice.id;
  assert.deepEqual(updatedUser(await bob.peer.wait(isAliceJoin, bobStart)).activity, game);
  assert.equal(Object.hasOwn(updatedUser(await legacy.peer.wait(isAliceJoin, legacyStart)), 'activity'), false);
});

test('game activity is refused from clients without the feature and from bots', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const legacy = await legacyHuman(f, 'Legacy');
  await legacy.peer.error(MessageType.USER_UPDATE_ACTIVITY, { activity: game }, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);

  const createdBot = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(createdBot.payload.token));
  await bot.peer.error(MessageType.USER_UPDATE_ACTIVITY, { activity: game }, ProtocolErrorCode.PERMISSION_DENIED);
});
