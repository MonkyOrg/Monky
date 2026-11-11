import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageType } from '../src/protocol';
import { identityBanHistoryPageSchema, identityBanHistoryRequestSchema, identityUnbanSchema } from '../src/identityAccess';
import {
  clientMessage, serverMessage,
  type ClientMessageArgs, type ClientMessageType, type ServerMessage, type ServerMessageType,
} from '../src/protocolPayloads';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// A message type is sent by someone, so it names its payload in one of the maps.
// SERVER_STATE is the only one nobody sends. A type added to MessageType without
// its payload stops this file from compiling.
const everyTypeHasItsPayload: Equal<Exclude<MessageType, ClientMessageType | ServerMessageType>, MessageType.SERVER_STATE> = true;

test('every message type that travels names its payload', () => {
  assert.equal(everyTypeHasItsPayload, true);
});

test('a message is held to the payload of its own type', () => {
  const pong: ServerMessage = { type: MessageType.PONG, payload: { timestamp: 1 } };
  // @ts-expect-error The payload of another message does not fit.
  const mixed: ServerMessage = { type: MessageType.PONG, payload: { channelId: 'room' } };
  const leave: ClientMessageArgs = [MessageType.VOICE_LEAVE, { channelId: 'room' }];
  // @ts-expect-error A field the payload lacks is refused.
  const extra: ClientMessageArgs = [MessageType.VOICE_LEAVE, { channelId: 'room', reason: 'bye' }];
  // @ts-expect-error The server never sends what only clients send.
  const wrongWay: ServerMessage = { type: MessageType.VOICE_LEAVE, payload: { channelId: 'room' } };
  assert.ok(pong && mixed && leave && extra && wrongWay);
});

test('serverMessage builds the envelope that travels', () => {
  assert.deepEqual(serverMessage(MessageType.PONG, { timestamp: 7 }, 'request'),
    { type: MessageType.PONG, payload: { timestamp: 7 }, requestId: 'request' });
  assert.deepEqual(JSON.parse(JSON.stringify(serverMessage(MessageType.COMMUNITY_ACK, {}))),
    { type: MessageType.COMMUNITY_ACK, payload: {} });
});

test('clientMessage builds the envelope that travels, held to the payload of its type', () => {
  const leave: ClientMessageArgs = [MessageType.VOICE_LEAVE, { channelId: 'room' }];
  assert.deepEqual(clientMessage(...leave, 'request'),
    { type: MessageType.VOICE_LEAVE, payload: { channelId: 'room' }, requestId: 'request' });
  assert.deepEqual(JSON.parse(JSON.stringify(clientMessage(MessageType.PONG, { timestamp: 3 }))),
    { type: MessageType.PONG, payload: { timestamp: 3 } });
  // @ts-expect-error The payload of another message does not fit.
  assert.ok(clientMessage(MessageType.VOICE_LEAVE, { timestamp: 3 }));
});

test('identity history is bounded and strict, while legacy unban payloads remain valid', () => {
  assert.ok(identityUnbanSchema.safeParse({ publicKey: 'key' }).success);
  assert.ok(identityUnbanSchema.safeParse({ publicKey: 'key', banId: 1 }).success);
  for (const banId of [0, -1, 1.5, '1']) assert.equal(identityUnbanSchema.safeParse({ publicKey: 'key', banId }).success, false);
  assert.ok(identityBanHistoryRequestSchema.safeParse({ scope: 'all', beforeId: 1 }).success);
  for (const payload of [{}, { scope: 'unknown' }, { scope: 'all', beforeId: 0 }, { scope: 'all', userId: 'other' }]) {
    assert.equal(identityBanHistoryRequestSchema.safeParse(payload).success, false);
  }
  const entry = { id: 1, publicKey: 'key', nickname: 'Name', reason: 'Private reason', showReason: false,
    createdAt: 1, expiresAt: null, createdBy: null, endedAt: null, endedBy: null, status: 'active' };
  assert.ok(identityBanHistoryPageSchema.safeParse({ entries: [entry], nextCursor: null }).success);
  assert.ok(identityBanHistoryPageSchema.safeParse({ entries: Array.from({ length: 50 }, () => entry), nextCursor: 1 }).success);
  assert.equal(identityBanHistoryPageSchema.safeParse({ entries: Array.from({ length: 51 }, () => entry), nextCursor: 1 }).success, false);
  assert.equal(identityBanHistoryPageSchema.safeParse({ entries: [{ ...entry, status: 'unknown' }], nextCursor: null }).success, false);
  assert.equal(identityBanHistoryPageSchema.safeParse({ entries: [{ ...entry, remoteHtml: '<img>' }], nextCursor: null }).success, false);
});
