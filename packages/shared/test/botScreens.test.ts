import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOT_SCREEN_LIMITS, isBotScreenJson, botScreenCreateSchema, botScreenActionSchema, botScreenUpdateSchema,
  botScreenRefSchema, botScreenRemovedSchema, botScreenSchema,
} from '../src/botScreens.js';
import { PROTOCOL_VERSION } from '../src/constants.js';
import { authConnectSchema } from '../src/validators.js';

test('protocol 20 requires clients and bots to update with the server', () => {
  const input = { nickname: 'Member', publicKey: 'ab'.repeat(32), protocolVersion: PROTOCOL_VERSION };
  assert.equal(PROTOCOL_VERSION, 21);
  assert.equal(authConnectSchema.safeParse({ ...input, protocolVersion: 19 }).success, false);
  assert.equal(authConnectSchema.safeParse(input).success, true);
  assert.equal(authConnectSchema.safeParse({ ...input, protocolVersion: 17 }).success, false);
  assert.equal(authConnectSchema.safeParse({ ...input, protocolVersion: 18 }).success, false);
  assert.equal(authConnectSchema.safeParse({ ...input, protocolVersion: 16 }).success, false);
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
