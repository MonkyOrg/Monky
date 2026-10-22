import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_CLIENT_PROTOCOL,
  MessageType,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  type CustomStatus,
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

const withoutBrb = {
  minimumVersion: MIN_CLIENT_PROTOCOL,
  features: PROTOCOL_FEATURES.filter((feature) => feature !== 'user-brb'),
};

test('"Volto já" reaches peers that negotiated it, follows every device and hides behind appear-offline', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  const bob = await f.human('Bob');
  const legacy = await f.human('Legacy', identity(), undefined, false, PROTOCOL_VERSION, withoutBrb);
  const isAliceUpdate = (message: { type: string; payload: Record<string, unknown> }) =>
    message.type === MessageType.USER_UPDATED && text(updatedUser(message).id) === alice.id;

  const bobStart = bob.peer.messages.length;
  const legacyStart = legacy.peer.messages.length;
  const own = await alice.peer.request(MessageType.USER_UPDATE_BRB, { brb: true });
  assert.equal(updatedUser(own).brb, true);
  assert.equal(updatedUser(await bob.peer.wait(isAliceUpdate, bobStart)).brb, true);
  assert.equal(Object.hasOwn(updatedUser(await legacy.peer.wait(isAliceUpdate, legacyStart)), 'brb'), false);

  // A newcomer sees it in the member list; a second device of Alice inherits it.
  const carol = await f.human('Carol');
  const members = record(carol.auth.payload.server).members;
  assert.ok(Array.isArray(members));
  assert.equal(members.map(record).find((member) => text(member.id) === alice.id)?.brb, true);

  // Appear-offline masks the status along with the presence.
  const hiddenStart = bob.peer.messages.length;
  await alice.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: true });
  const hidden = updatedUser(await bob.peer.wait((message) => isAliceUpdate(message)
    && updatedUser(message).status === 'DISCONNECTED', hiddenStart));
  assert.equal(Object.hasOwn(hidden, 'brb'), false);
  await alice.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: false });

  const clearStart = bob.peer.messages.length;
  await alice.peer.request(MessageType.USER_UPDATE_BRB, { brb: false });
  await bob.peer.wait((message) => isAliceUpdate(message) && !Object.hasOwn(updatedUser(message), 'brb'), clearStart);
});

test('a device that connects already "Volto já" applies it to the other devices of the person', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const keys = identity();
  const desktop = await f.human('Alice', keys);
  const desktopStart = desktop.peer.messages.length;
  const laptop = await f.human('Alice', keys, undefined, false, PROTOCOL_VERSION, undefined, true);
  assert.equal(record(laptop.auth.payload.currentUser).brb, true);
  const update = await desktop.peer.wait((message) => message.type === MessageType.USER_UPDATED
    && text(updatedUser(message).id) === desktop.id, desktopStart);
  assert.equal(updatedUser(update).brb, true);
});

test('"Volto já" is refused from clients without the feature, from bots, and with a malformed payload', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Owner');
  await owner.peer.error(MessageType.USER_UPDATE_BRB, { brb: 'yes' }, ProtocolErrorCode.BAD_REQUEST);
  const legacy = await f.human('Legacy', identity(), undefined, false, PROTOCOL_VERSION, withoutBrb, true);
  assert.equal(Object.hasOwn(record(legacy.auth.payload.currentUser), 'brb'), false, 'the login flag needs the feature too');
  await legacy.peer.error(MessageType.USER_UPDATE_BRB, { brb: true }, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  const createdBot = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(createdBot.payload.token));
  await bot.peer.error(MessageType.USER_UPDATE_BRB, { brb: true }, ProtocolErrorCode.PERMISSION_DENIED);
});

const lunch: CustomStatus = { text: 'Almoçando', emoji: '🍔', tag: 'ALMOÇO', color: '#22aa66', showEmoji: true, showTag: false };
const withoutCustomStatus = {
  minimumVersion: MIN_CLIENT_PROTOCOL,
  features: PROTOCOL_FEATURES.filter((feature) => feature !== 'custom-status'),
};

test('a custom status reaches peers that negotiated it, replaces "Volto já" and hides behind appear-offline', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const alice = await f.human('Alice');
  const bob = await f.human('Bob');
  const legacy = await f.human('Legacy', identity(), undefined, false, PROTOCOL_VERSION, withoutCustomStatus);
  const isAliceUpdate = (message: { type: string; payload: Record<string, unknown> }) =>
    message.type === MessageType.USER_UPDATED && text(updatedUser(message).id) === alice.id;

  await alice.peer.request(MessageType.USER_UPDATE_BRB, { brb: true });
  const bobStart = bob.peer.messages.length;
  const legacyStart = legacy.peer.messages.length;
  const own = updatedUser(await alice.peer.request(MessageType.USER_UPDATE_CUSTOM_STATUS, {
    customStatus: { ...lunch, color: '#22AA66', text: '  Almoçando ' },
  }));
  assert.deepEqual(own.customStatus, lunch, 'the server stores the validated, normalized status');
  assert.equal(Object.hasOwn(own, 'brb'), false, 'choosing a custom status ends "Volto já"');
  // The earlier "Volto já" broadcast may still be arriving; wait for the update that ended it.
  const afterBrb = (message: { type: string; payload: Record<string, unknown> }) =>
    isAliceUpdate(message) && !Object.hasOwn(updatedUser(message), 'brb');
  assert.deepEqual(updatedUser(await bob.peer.wait(afterBrb, bobStart)).customStatus, lunch);
  assert.equal(Object.hasOwn(updatedUser(await legacy.peer.wait(afterBrb, legacyStart)), 'customStatus'), false,
    'peers without the feature keep seeing a plain online person');

  const carol = await f.human('Carol');
  const members = record(carol.auth.payload.server).members;
  assert.ok(Array.isArray(members));
  assert.deepEqual(members.map(record).find((member) => text(member.id) === alice.id)?.customStatus, lunch);

  const hiddenStart = bob.peer.messages.length;
  await alice.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: true });
  const hidden = updatedUser(await bob.peer.wait((message) => isAliceUpdate(message)
    && updatedUser(message).status === 'DISCONNECTED', hiddenStart));
  assert.equal(Object.hasOwn(hidden, 'customStatus'), false, 'appear-offline hides the status too');
  await alice.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: false });

  const brbStart = bob.peer.messages.length;
  await alice.peer.request(MessageType.USER_UPDATE_BRB, { brb: true });
  const brb = updatedUser(await bob.peer.wait((message) => isAliceUpdate(message) && updatedUser(message).brb === true, brbStart));
  assert.equal(Object.hasOwn(brb, 'customStatus'), false, '"Volto já" ends the custom status');

  await alice.peer.request(MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: lunch });
  const clearStart = bob.peer.messages.length;
  await alice.peer.request(MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: null });
  await bob.peer.wait((message) => isAliceUpdate(message) && !Object.hasOwn(updatedUser(message), 'customStatus'), clearStart);
});

test('a device that connects with a custom status applies it to the other devices of the person', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const keys = identity();
  const desktop = await f.human('Alice', keys, undefined, false, PROTOCOL_VERSION, undefined, true);
  const desktopStart = desktop.peer.messages.length;
  const laptop = await f.human('Alice', keys, undefined, false, PROTOCOL_VERSION, undefined, undefined, lunch);
  assert.deepEqual(record(laptop.auth.payload.currentUser).customStatus, lunch);
  const update = await desktop.peer.wait((message) => message.type === MessageType.USER_UPDATED
    && text(updatedUser(message).id) === desktop.id && Object.hasOwn(updatedUser(message), 'customStatus'), desktopStart);
  assert.deepEqual(updatedUser(update).customStatus, lunch);
  assert.equal(Object.hasOwn(updatedUser(update), 'brb'), false, 'the newer choice replaces "Volto já" everywhere');
});

test('a custom status is refused from clients without the feature, from bots, and when malformed', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Owner');
  for (const customStatus of [{ ...lunch, emoji: 'abc' }, { ...lunch, color: 'red' }, { ...lunch, text: 'x'.repeat(129) }]) {
    await owner.peer.error(MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus }, ProtocolErrorCode.BAD_REQUEST);
  }
  const legacy = await f.human('Legacy', identity(), undefined, false, PROTOCOL_VERSION, withoutCustomStatus, undefined, lunch);
  assert.equal(Object.hasOwn(record(legacy.auth.payload.currentUser), 'customStatus'), false, 'the login status needs the feature too');
  await legacy.peer.error(MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: lunch }, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  const createdBot = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(createdBot.payload.token));
  await bot.peer.error(MessageType.USER_UPDATE_CUSTOM_STATUS, { customStatus: lunch }, ProtocolErrorCode.PERMISSION_DENIED);
});
