import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeProtocolHeader } from './generate-light-contracts.js';

const contract = {
  version: 7,
  messageTypes: { VOICE_JOIN: 'voice.join', AUTH_CONNECT: 'auth.connect' },
  errorCodes: { UNAUTHORIZED: 'UNAUTHORIZED', BAD_REQUEST: 'BAD_REQUEST' },
  limits: { MAX_MEMBERS: 20, NO_LIMIT: 0 },
  reconnectDelays: [1000, 2000, 5000],
};

test('native contracts preserve the source version, message values and limits', () => {
  const header = nativeProtocolHeader(contract);
  assert.ok(header.includes('inline constexpr std::int64_t VERSION = 7LL;'));
  assert.ok(header.includes('inline constexpr std::string_view AUTH_CONNECT = "auth.connect";'));
  assert.ok(header.includes('inline constexpr std::string_view VOICE_JOIN = "voice.join";'));
  assert.ok(header.includes('inline constexpr std::int64_t MAX_MEMBERS = 20LL;'));
  assert.ok(header.includes('inline constexpr std::int64_t NO_LIMIT = 0LL;'));
  assert.ok(header.endsWith('\n'));
});

test('native contract generation is independent of source property order', () => {
  assert.equal(nativeProtocolHeader(contract), nativeProtocolHeader({
    version: contract.version,
    messageTypes: { AUTH_CONNECT: 'auth.connect', VOICE_JOIN: 'voice.join' },
    errorCodes: { BAD_REQUEST: 'BAD_REQUEST', UNAUTHORIZED: 'UNAUTHORIZED' },
    limits: { NO_LIMIT: 0, MAX_MEMBERS: 20 },
    reconnectDelays: contract.reconnectDelays,
  }));
});

test('error codes and reconnect ordering come from the same shared source', () => {
  const header = nativeProtocolHeader(contract);
  assert.ok(header.includes('inline constexpr std::string_view UNAUTHORIZED = "UNAUTHORIZED";'));
  assert.ok(header.includes('RECONNECT_DELAYS_MS = {1000LL, 2000LL, 5000LL};'));
  const reordered = nativeProtocolHeader({ ...contract, reconnectDelays: [5000, 1000] });
  assert.ok(reordered.includes('RECONNECT_DELAYS_MS = {5000LL, 1000LL};'));
});

test('message string literals escape quotes and backslashes', () => {
  const header = nativeProtocolHeader({
    ...contract,
    messageTypes: { EXAMPLE: 'value"with\\escaping' },
  });
  assert.ok(header.includes('EXAMPLE = "value\\"with\\\\escaping";'));
});

test('a protocol bump changes the generated native version rather than using a copy', () => {
  const header = nativeProtocolHeader({ ...contract, version: 8 });
  assert.ok(header.includes('VERSION = 8LL;'));
  assert.ok(!header.includes('VERSION = 7LL;'));
});

test('fractional limits remain floating point rather than being truncated', () => {
  const header = nativeProtocolHeader({
    ...contract,
    limits: { WATERMARK: 0.9, SMALL_FRACTION: 1e-7, MAX_MEMBERS: 20 },
  });
  assert.ok(header.includes('inline constexpr double WATERMARK = 0.9;'));
  assert.ok(header.includes('inline constexpr double SMALL_FRACTION = 1e-7;'));
  assert.ok(header.includes('inline constexpr std::int64_t MAX_MEMBERS = 20LL;'));
});

test('every current shared message and limit is represented in the native contract', async () => {
  const { PROTOCOL_VERSION, LIMITS, RECONNECT_DELAYS_MS } = await import('../packages/shared/dist/constants.js');
  const { MessageType, ProtocolErrorCode } = await import('../packages/shared/dist/protocol.js');
  const header = nativeProtocolHeader({
    version: PROTOCOL_VERSION,
    messageTypes: MessageType,
    errorCodes: ProtocolErrorCode,
    limits: LIMITS,
    reconnectDelays: RECONNECT_DELAYS_MS,
  });
  assert.ok(header.includes(`VERSION = ${PROTOCOL_VERSION}LL;`));
  for (const [key, value] of Object.entries(MessageType)) {
    assert.ok(header.includes(`${key} = ${JSON.stringify(value)};`), key);
  }
  for (const [key, value] of Object.entries(ProtocolErrorCode)) {
    assert.ok(header.includes(`${key} = ${JSON.stringify(value)};`), key);
  }
  for (const [key, value] of Object.entries(LIMITS)) {
    const suffix = Number.isInteger(value) ? 'LL' : '';
    assert.ok(header.includes(`${key} = ${value}${suffix};`), key);
  }
});

test('invalid versions, identifiers and unsupported values fail explicitly', () => {
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7']) {
    assert.throws(() => nativeProtocolHeader({ ...contract, version }), /Protocol version/);
  }
  for (const messageTypes of [null, [], {}, { 'BAD-NAME': 'bad' }, { CLASS: '' }, { NUMBER: 5 }, { CONTROL: 'a\nb' }]) {
    assert.throws(() => nativeProtocolHeader({ ...contract, messageTypes }), TypeError);
  }
  for (const limits of [null, [], {}, { UNSAFE: Number.MAX_SAFE_INTEGER + 1 }, { UNBOUNDED: Infinity }, { STRING: '20' }]) {
    assert.throws(() => nativeProtocolHeader({ ...contract, limits }), TypeError);
  }
  for (const reconnectDelays of [null, [], [-1], [0.5], [Infinity]]) {
    assert.throws(() => nativeProtocolHeader({ ...contract, reconnectDelays }), /Reconnect delays/);
  }
  for (const errorCodes of [null, {}, { INVALID: 3 }]) {
    assert.throws(() => nativeProtocolHeader({ ...contract, errorCodes }), TypeError);
  }
});
