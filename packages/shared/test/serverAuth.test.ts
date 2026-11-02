import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  SERVER_KEY_AUTH_FEATURE, authChallengeSchema, decideServerKey, memberAuthChallenge, serverAuthChallenge,
  serverPublicKeySchema,
} from '../src/serverAuth';
import { BOT_PROTOCOL_FEATURES, PROTOCOL_FEATURES } from '../src/protocolCompatibility';
import { createServerInviteAppLink, createServerInviteLink, parseServerInviteLink, type ServerInvite } from '../src/serverInvites';
import {
  createServerInviteLink as createBefore821, parseServerInviteLink as parseBefore821, serverInviteSchema as beforeSchema,
} from './fixtures/serverInvitesBefore821';

const key = (digit: string) => `302a300506032b6570032100${digit.repeat(64)}`;
const nonce = 'ab'.repeat(32);
const bound = (serverKey: string) => authChallengeSchema.parse({ nonce, serverKey, serverSignature: 'c'.repeat(128) });
const bare = authChallengeSchema.parse({ nonce });
const nowhere = () => false;

test('a person signs a message naming the server, never the bare nonce or the server\'s own proof', () => {
  const member = memberAuthChallenge(nonce, key('a'));
  assert.equal(member, `monky-auth:v2:${key('a')}:${nonce}`);
  assert.notEqual(member, memberAuthChallenge(nonce, key('b')), 'Another server gets another message');
  assert.notEqual(member, serverAuthChallenge(nonce, key('a')), 'A member signature is never a server proof');
  assert.equal(memberAuthChallenge(nonce.toUpperCase(), key('a').toUpperCase()), member, 'Hex case does not matter');
  assert.throws(() => memberAuthChallenge('ab', key('a')));
  assert.throws(() => memberAuthChallenge(nonce, 'not-a-key'));
  const real = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  assert.equal(serverPublicKeySchema.parse(real), real);
});

test('a challenge carries a bare nonce, or a key with its proof, never half of it', () => {
  assert.equal(authChallengeSchema.safeParse({ nonce, serverKey: key('a') }).success, false);
  assert.equal(authChallengeSchema.safeParse({ nonce, serverSignature: 'c'.repeat(128) }).success, false);
  assert.equal(authChallengeSchema.safeParse({ nonce: 'zz', serverKey: key('a'), serverSignature: 'c'.repeat(128) }).success, false);
  assert.equal(bound(key('A')).nonce, nonce);
});

test('the app binds to the key it pinned, and refuses another key, no key or a key pinned elsewhere (#821)', () => {
  // First contact: pin what the server presents, or keep the bare nonce for a server without a key.
  assert.deepEqual(decideServerKey(bound(key('a')), {}, nowhere), { kind: 'bind', serverKey: key('a') });
  assert.deepEqual(decideServerKey(bare, {}, nowhere), { kind: 'legacy' });
  // Pinned: the same key binds; no downgrade and no other key.
  assert.deepEqual(decideServerKey(bound(key('a')), { pinned: key('a') }, () => true), { kind: 'bind', serverKey: key('a') },
    'Another address of the same saved server shares its pin');
  assert.deepEqual(decideServerKey(bare, { pinned: key('a') }, nowhere), { kind: 'refuse', reason: 'key-missing' });
  assert.deepEqual(decideServerKey(bound(key('b')), { pinned: key('a') }, nowhere), { kind: 'refuse', reason: 'key-changed' });
  // A new address presenting another saved server's key, by sign-in or invitation, is refused.
  assert.deepEqual(decideServerKey(bound(key('a')), {}, () => true), { kind: 'refuse', reason: 'key-of-other-server' });
  assert.deepEqual(decideServerKey(bound(key('a')), { invited: key('a') }, () => true),
    { kind: 'refuse', reason: 'key-of-other-server' });
  // An invitation naming a new key is the only way to replace a pin, and the server must present that key.
  assert.deepEqual(decideServerKey(bound(key('b')), { pinned: key('a'), invited: key('b') }, nowhere),
    { kind: 'bind', serverKey: key('b') });
  assert.deepEqual(decideServerKey(bound(key('a')), { pinned: key('a'), invited: key('b') }, nowhere),
    { kind: 'refuse', reason: 'key-changed' });
  assert.deepEqual(decideServerKey(bare, { invited: key('b') }, nowhere), { kind: 'refuse', reason: 'key-missing' });
  assert.deepEqual(decideServerKey(bound(key('a')), { pinned: key('a'), invited: key('a') }, () => true),
    { kind: 'bind', serverKey: key('a') }, 'An invitation repeating the pin is the pin');
});

test('server-key-auth is offered by people only and needs no protocol bump', () => {
  assert.ok(PROTOCOL_FEATURES.includes(SERVER_KEY_AUTH_FEATURE));
  assert.ok(!(BOT_PROTOCOL_FEATURES as readonly string[]).includes(SERVER_KEY_AUTH_FEATURE));
});

test('an invitation carries the server key compactly and keeps it through a round trip', () => {
  const real = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  const plain = { v: 1 as const, host: '203.0.113.7', port: 3000, name: 'Casa' };
  const invite = { ...plain, serverKey: real };
  const link = createServerInviteLink(invite);
  assert.deepEqual(parseServerInviteLink(link), { ok: true, invite });
  assert.ok(link.length - createServerInviteLink(plain).length <= 64, 'The key adds its 32 raw bytes and a marker');
  assert.deepEqual(parseServerInviteLink(createServerInviteLink({ ...invite, eventId: 'event-1', password: 'abc' })),
    { ok: true, invite: { ...invite, eventId: 'event-1', password: 'abc' } });
  assert.throws(() => createServerInviteLink({ ...plain, serverKey: 'not-a-key' }));
});

test('apps released before #821 open an invitation with a server key, TLS or both, only without them', () => {
  const real = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  const cases: ServerInvite[] = [
    { v: 1, host: 'localhost', port: 3000 },
    { v: 1, host: '203.0.113.7', port: 3000, name: 'Casa' },
    { v: 1, host: 'monky.example.com', port: 43210, name: 'Servidor com nome bem comprido '.repeat(3).trim(), password: 'senha' },
    { v: 1, host: '[2001:db8::1]', port: 3001, password: 'ABCDEF0123', eventId: 'event-1' },
    { v: 1, host: '10.0.0.2', port: 3000, name: 'ç'.repeat(90), password: 'x'.repeat(600) },
  ];
  for (const invite of cases) {
    for (let attempt = 0; attempt < 20; attempt++) {
      // The extension (#829): one marker after the deflate stream for every field the old parsers must skip.
      for (const extension of [{ serverKey: real() }, { tls: true as const }, { serverKey: real(), tls: true as const }]) {
        const extended = { ...invite, ...extension };
        for (const link of [createServerInviteLink(extended), createServerInviteAppLink(extended), createServerInviteLink(extended, 'en')]) {
          assert.deepEqual(parseBefore821(link), { ok: true, invite: beforeSchema.parse(invite) }, link);
          assert.deepEqual(parseServerInviteLink(link), { ok: true, invite: extended });
        }
      }
      // And invitations made by those apps keep opening here, without a key.
      assert.deepEqual(parseServerInviteLink(createBefore821(invite)), { ok: true, invite });
    }
  }
});

test('the invitation extension refuses a field it announces but does not carry', () => {
  const link = createServerInviteAppLink({ v: 1, host: '203.0.113.7', port: 3000, tls: true });
  const bytes = Buffer.from(link.slice('monky://#~'.length), 'base64url');
  // flags | fields length | "M" "K" | version: announce a server key with no key bytes.
  const forged = Buffer.from(bytes);
  forged[forged.length - 5] |= 2;
  assert.deepEqual(parseServerInviteLink(`monky://#~${forged.toString('base64url')}`), { ok: false, reason: 'invalid' });
  // A bit no reader knows yet is skipped, and the fields it knows still come first.
  const future = Buffer.from(bytes);
  future[future.length - 5] |= 128;
  assert.deepEqual(parseServerInviteLink(`monky://#~${future.toString('base64url')}`),
    { ok: true, invite: { v: 1, host: '203.0.113.7', port: 3000, tls: true } });
});
