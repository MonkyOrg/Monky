import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_REACHABILITY_MAX_TARGETS,
  botDiagnosticRequestSchema,
  botDiagnosticResultSchema,
  botReachabilityChallenge,
  botReachabilityProofSchema,
  normalizeBotReachabilityOrigin,
} from '../src/botDiagnostics.js';
import { MessageType } from '../src/protocol.js';
import { PROTOCOL_VERSION } from '../src/constants.js';

const request = {
  protocolVersion: PROTOCOL_VERSION,
  botToken: 'token',
  publicKey: 'ab'.repeat(44),
  targets: [{ id: 'manifest', origin: 'http://bot.example.com:7780' }],
};

test('protocol 37 publishes the pre-authentication bot diagnostic messages', () => {
  assert.ok(PROTOCOL_VERSION >= 37);
  assert.equal(MessageType.BOT_DIAGNOSTIC, 'BOT_DIAGNOSTIC');
  assert.equal(MessageType.BOT_DIAGNOSTIC_RESULT, 'BOT_DIAGNOSTIC_RESULT');
});

test('reachability targets are bare http(s) origins with unique ids and a hard limit', () => {
  assert.equal(botDiagnosticRequestSchema.safeParse(request).success, true);
  assert.equal(botDiagnosticRequestSchema.safeParse({ ...request, targets: [] }).success, true);
  for (const origin of [
    'ftp://bot.example.com', 'http://user:pass@bot.example.com', 'http://bot.example.com/path',
    'http://bot.example.com/?query', 'http://bot.example.com/#fragment', 'bot.example.com:7780', 'http://',
    'http://bot.example.com:7780\\x',
  ]) {
    assert.equal(normalizeBotReachabilityOrigin(origin), null, origin);
    assert.equal(botDiagnosticRequestSchema.safeParse({ ...request, targets: [{ id: 'a', origin }] }).success, false, origin);
  }
  assert.equal(normalizeBotReachabilityOrigin('https://Games.Example.com/'), 'https://games.example.com');
  assert.equal(normalizeBotReachabilityOrigin('http://[::1]:7781'), 'http://[::1]:7781');
  const duplicated = [request.targets[0], { ...request.targets[0] }];
  assert.equal(botDiagnosticRequestSchema.safeParse({ ...request, targets: duplicated }).success, false);
  const many = Array.from({ length: BOT_REACHABILITY_MAX_TARGETS + 1 }, (_, index) => ({
    id: `port-${index}`, origin: `http://bot.example.com:${8000 + index}`,
  }));
  assert.equal(botDiagnosticRequestSchema.safeParse({ ...request, targets: many }).success, false);
  assert.equal(botDiagnosticRequestSchema.safeParse({ ...request, targets: [{ id: 'Manifest', origin: 'http://a.b' }] }).success, false);
});

test('the signed challenge is domain separated and accepts only a 32-byte hex nonce', () => {
  const nonce = 'a'.repeat(64);
  assert.equal(botReachabilityChallenge(nonce), `monky-bot-reachability:v1:${nonce}`);
  for (const invalid of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`, '']) {
    assert.throws(() => botReachabilityChallenge(invalid));
  }
  assert.equal(botReachabilityProofSchema.safeParse({ signature: 'f'.repeat(128) }).success, true);
  assert.equal(botReachabilityProofSchema.safeParse({ signature: 'f'.repeat(128), extra: true }).success, false);
  assert.equal(botReachabilityProofSchema.safeParse({ signature: 'f'.repeat(127) }).success, false);
});

test('diagnostic results never carry target details beyond a generic status', () => {
  const result = {
    serverProtocolVersion: 37,
    protocol: { version: 37, minimumVersion: 24, features: [] },
    credential: 'valid',
    serverName: 'Servidor',
    reachability: [{ id: 'manifest', status: 'verified' }, { id: 'games', status: 'skipped', reason: 'address_not_allowed' }],
  };
  assert.equal(botDiagnosticResultSchema.safeParse(result).success, true);
  assert.equal(botDiagnosticResultSchema.safeParse({ ...result, protocol: null, credential: 'invalid', reachability: [] }).success, true);
  assert.equal(botDiagnosticResultSchema.safeParse({ ...result, credential: 'other' }).success, false);
  assert.equal(botDiagnosticResultSchema.safeParse({
    ...result, reachability: [{ id: 'manifest', status: 'unverified', reason: 'connection_refused' }],
  }).success, false);
});
