import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOT_SCREEN_LIMITS, isBotScreenJson, botScreenCreateSchema, botScreenActionSchema, botScreenUpdateSchema,
  botScreenRefSchema, botScreenRemovedSchema, botScreenSchema,
} from '../src/botScreens.js';
import { PROTOCOL_VERSION } from '../src/constants.js';
import { authConnectSchema } from '../src/validators.js';
import {
  MIN_CLIENT_PROTOCOL, MIN_BOT_PROTOCOL, createProtocolOffer, negotiateProtocol, legacyProtocolFallback,
} from '../src/protocolCompatibility.js';

test('authentication shape allows negotiation while the compatibility floor rejects obsolete peers', () => {
  const input = { nickname: 'Member', publicKey: 'ab'.repeat(32), protocolVersion: PROTOCOL_VERSION };
  assert.equal(PROTOCOL_VERSION, 26);
  assert.equal(MIN_CLIENT_PROTOCOL, 26);
  assert.equal(MIN_BOT_PROTOCOL, 24);
  assert.equal(authConnectSchema.safeParse(input).success, true);
  for (const version of [16, 17, 18, 19, 21, 22, 23]) {
    assert.equal(authConnectSchema.safeParse({ ...input, protocolVersion: version }).success, true);
    assert.equal(negotiateProtocol(version, undefined, 'client'), null);
    assert.equal(negotiateProtocol(version, undefined, 'bot'), null);
  }
  for (const version of [24, 25]) {
    for (const protocolOffer of [undefined, { minimumVersion: 24, features: ['chat-blocks', 'message-length-setting', 'chat-delivery'] }]) {
      assert.equal(authConnectSchema.safeParse({ ...input, protocolVersion: version, protocolOffer }).success, true);
      assert.equal(negotiateProtocol(version, protocolOffer, 'client'), null);
      assert.deepEqual(negotiateProtocol(version, protocolOffer, 'bot'), {
        version: 26, minimumVersion: 24, features: protocolOffer ? ['message-length-setting'] : [],
      });
    }
    assert.equal(legacyProtocolFallback(version, 'client'), null);
    assert.equal(legacyProtocolFallback(version, 'bot'), version);
  }
});

test('protocol 26 retains feature negotiation without restoring obsolete native client contracts', () => {
  assert.deepEqual(createProtocolOffer('client'), {
    minimumVersion: 26, features: ['chat-blocks', 'message-length-setting', 'chat-delivery'],
  });
  assert.deepEqual(createProtocolOffer('bot'), { minimumVersion: 24, features: ['message-length-setting'] });
  assert.deepEqual(negotiateProtocol(26, undefined, 'client'), { version: 26, ...createProtocolOffer('client') });
  assert.deepEqual(negotiateProtocol(26, { minimumVersion: 26, features: [] }, 'client')?.features, []);
  assert.deepEqual(negotiateProtocol(27, { minimumVersion: 26, features: ['chat-blocks', 'unknown'] }, 'client'), {
    version: 26, minimumVersion: 26, features: ['chat-blocks'],
  });
  assert.equal(negotiateProtocol(27, undefined, 'client'), null);
  assert.equal(negotiateProtocol(27, { minimumVersion: 27, features: [] }, 'client'), null);
  for (const offer of [null, { minimumVersion: 26, features: 'chat-blocks' }, { minimumVersion: 27, features: [] }]) {
    assert.equal(negotiateProtocol(26, offer, 'client'), null);
  }
});

test('screen JSON is finite, bounded, cycle-safe and rejects executable values', () => {
  assert.equal(isBotScreenJson({ board: [null, 'p', 1, true], players: { alice: 'white' } }), true);
  for (const invalid of [undefined, NaN, Infinity, () => 1, new Date(), { value: undefined }, { value: BigInt(1) }]) {
    assert.equal(isBotScreenJson(invalid), false);
  }
  const cycle: { child?: object } = {};
  cycle.child = cycle;
  assert.equal(isBotScreenJson(cycle), false);
  let deep: object = {};
  for (let i = 0; i <= BOT_SCREEN_LIMITS.jsonDepth; i++) deep = { child: deep };
  assert.equal(isBotScreenJson(deep), false);
  assert.equal(isBotScreenJson('é'.repeat(BOT_SCREEN_LIMITS.stateBytes / 2)), false);
  assert.equal(isBotScreenJson(JSON.parse('{"__proto__":{"spoof":true}}')), false);
  assert.equal(isBotScreenJson({ get secret() { throw new Error('Getter must not run'); } }), false);
});

test('create/update/action contracts reject spoofed identities and invalid revisions', () => {
  const create = { channelId: 'chat', title: 'Game', html: '<script>play()</script>', state: {} };
  assert.equal(botScreenCreateSchema.safeParse(create).success, true);
  assert.equal(botScreenCreateSchema.safeParse({ ...create, creatorUserId: 'admin' }).success, false);
  assert.equal(botScreenCreateSchema.safeParse({ ...create, html: 'a'.repeat(BOT_SCREEN_LIMITS.htmlBytes + 1) }).success, false);
  assert.equal(botScreenCreateSchema.safeParse({ ...create, instanceId: 'forged' }).success, false);
  assert.equal(botScreenUpdateSchema.safeParse({ id: 'game', instanceId: 'instance', state: {}, expectedRevision: -1 }).success, false);
  const action = { id: 'game', instanceId: 'instance', action: 'move', payload: { to: 2 }, revision: 0, actionId: 'move-1' };
  assert.equal(botScreenActionSchema.safeParse(action).success, true);
  assert.equal(botScreenActionSchema.safeParse({ ...action, userId: 'admin' }).success, false);
  assert.equal(botScreenActionSchema.safeParse({ ...action, payload: 'x'.repeat(BOT_SCREEN_LIMITS.actionBytes) }).success, false);
});

test('end and lifecycle contracts require an exact instance and server-authenticated attribution', () => {
  const ref = { id: 'game', instanceId: 'server-instance' };
  assert.equal(botScreenRefSchema.safeParse(ref).success, true);
  for (const invalid of [{ id: 'game' }, { ...ref, instanceId: '' }, { ...ref, endedByUserId: 'admin' }, { ...ref, creatorUserId: 'admin' }]) {
    assert.equal(botScreenRefSchema.safeParse(invalid).success, false);
  }
  assert.equal(botScreenUpdateSchema.safeParse({ id: 'game', state: {}, expectedRevision: 0 }).success, false);
  assert.equal(botScreenUpdateSchema.safeParse({ ...ref, state: {}, expectedRevision: 0 }).success, true);
  const ended = { ...ref, channelId: 'voice', reason: 'ended', endedByUserId: 'alice' };
  assert.equal(botScreenRemovedSchema.safeParse(ended).success, true);
  assert.equal(botScreenRemovedSchema.safeParse({ ...ended, endedByUserId: undefined }).success, false);
  assert.equal(botScreenRemovedSchema.safeParse({ ...ended, reason: 'view_revoked' }).success, false);
  assert.equal(botScreenRemovedSchema.safeParse({ ...ref, channelId: 'voice', reason: 'view_revoked' }).success, true);
  const screen = {
    ...ref, botId: 'bot', channelId: 'voice', title: 'Game', html: 'Game', state: null, revision: 0, createdAt: 1,
  };
  assert.equal(botScreenSchema.safeParse(screen).success, true);
  assert.equal(botScreenSchema.parse({ ...screen, creatorUserId: 'alice' }).creatorUserId, 'alice');
});
