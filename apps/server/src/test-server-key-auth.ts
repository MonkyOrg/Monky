import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MessageType, PROTOCOL_VERSION, ProtocolErrorCode, SERVER_KEY_AUTH_FEATURE, authChallengeSchema, createProtocolOffer,
  decideServerKey, memberAuthChallenge, serverAuthChallenge, type ProtocolOffer,
} from '@monky/shared';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteServerRepository } from './infrastructure/database/SqliteRepositories';
import { ServerIdentity } from './infrastructure/security/ServerIdentity';
import { createFixture, identity, record, text } from './testFixtures/bots';

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Keys = ReturnType<typeof identity>;

const clientOffer = createProtocolOffer('client');
const withoutKeyAuth: ProtocolOffer = { ...clientOffer, features: clientOffer.features.filter(feature => feature !== SERVER_KEY_AUTH_FEATURE) };

/**
 * The person's app as it answers a challenge: the rule the desktop and Light
 * follow (pins per address, decideServerKey), then the server's proof and the
 * signature. `legacy` stands for the app before #821, which signed any nonce.
 */
function app(keys: Keys, pins: Map<string, string>, legacy = false) {
  return (address: string, payload: Record<string, unknown>): string | { refused: string } => {
    const challenge = authChallengeSchema.parse(payload);
    if (legacy) return sign(null, Buffer.from(challenge.nonce, 'hex'), keys.privateKey).toString('hex');
    const decision = decideServerKey(challenge, { pinned: pins.get(address) },
      key => [...pins].some(([other, pinned]) => other !== address && pinned === key));
    if (decision.kind === 'refuse') return { refused: decision.reason };
    if (decision.kind === 'legacy') return sign(null, Buffer.from(challenge.nonce, 'hex'), keys.privateKey).toString('hex');
    assert.ok('serverSignature' in challenge);
    const proof = verify(null, Buffer.from(serverAuthChallenge(challenge.nonce, decision.serverKey), 'utf8'),
      createPublicKey({ key: Buffer.from(decision.serverKey, 'hex'), format: 'der', type: 'spki' }),
      Buffer.from(challenge.serverSignature, 'hex'));
    if (!proof) return { refused: 'server-signature' };
    pins.set(address, decision.serverKey);
    return sign(null, Buffer.from(memberAuthChallenge(challenge.nonce, decision.serverKey), 'utf8'), keys.privateKey).toString('hex');
  };
}

async function signIn(f: Fixture, keys: Keys, offer: ProtocolOffer | undefined,
  answer: (payload: Record<string, unknown>) => string | { refused: string }) {
  const peer = await f.connect();
  const challenge = await peer.request(MessageType.AUTH_CONNECT,
    { protocolVersion: PROTOCOL_VERSION, protocolOffer: offer, nickname: `Pessoa ${keys.publicKey.slice(-6)}`, publicKey: keys.publicKey });
  assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
  const signature = answer(challenge.payload);
  if (typeof signature !== 'string') return { refused: signature.refused };
  return { reply: await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature }) };
}

/**
 * M is a server the person joins. It opens its own connection to A with the
 * person's public key, hands A's challenge to the person's app as if it were
 * its own, and presents the answer to A. `present` decides what M shows.
 */
async function relay(a: Fixture, victim: Keys, toA: ProtocolOffer | undefined,
  answer: (payload: Record<string, unknown>) => string | { refused: string },
  present: (fromA: Record<string, unknown>) => Record<string, unknown> = fromA => fromA) {
  return signIn(a, victim, toA, fromA => answer(present(fromA)));
}

function malicious(): { keys: Keys; challenge(fromA: Record<string, unknown>): Record<string, unknown> } {
  const keys = identity();
  const serverKey = keys.publicKey;
  return {
    keys,
    challenge: fromA => {
      const nonce = text(fromA.nonce);
      return { nonce, serverKey, serverSignature: sign(null, Buffer.from(serverAuthChallenge(nonce, serverKey), 'utf8'), keys.privateKey).toString('hex') };
    },
  };
}

test('before #821 a relaying server signs in to A as the person; now A refuses every relayed answer', async (t) => {
  const a = await createFixture();
  t.after(() => a.dispose());
  const victim = identity();
  const pins = new Map<string, string>();
  const current = app(victim, pins);

  // The person signs in to A normally once: A is pinned on that address.
  const first = await signIn(a, victim, createProtocolOffer('client'), payload => current('a.example:3000', payload));
  assert.equal(first.reply?.type, MessageType.AUTH_SUCCESS);
  assert.equal(pins.get('a.example:3000'), a.authService['serverIdentity'].publicKey);

  // Today's attack, against an app that signs whatever nonce it is given: A lets M in.
  const other = identity();
  const legacyApp = app(other, new Map(), true);
  const otherFirst = await signIn(a, other, withoutKeyAuth, payload => legacyApp('a.example:3000', payload));
  assert.equal(otherFirst.reply?.type, MessageType.AUTH_SUCCESS);
  const relayedLegacy = await relay(a, other, undefined, payload => legacyApp('m.example:3000', payload));
  assert.equal(relayedLegacy.reply?.type, MessageType.AUTH_SUCCESS, 'the bare nonce lets the relay in');

  // M presents its own key: the answer is bound to M, so A rejects it.
  const m = malicious();
  const ownKey = await relay(a, victim, createProtocolOffer('client'),
    payload => current('m.example:3000', payload), m.challenge);
  assert.equal(ownKey.reply?.type, MessageType.AUTH_FAILED);
  assert.equal(ownKey.reply?.payload.code, ProtocolErrorCode.UNAUTHORIZED);

  // M hides that A has a key: the app (which never saw M) signs the bare nonce, and A no longer takes it from this member.
  const stripped = await relay(a, victim, withoutKeyAuth, payload => current('m2.example:3000', payload));
  assert.equal(stripped.reply?.type, MessageType.AUTH_FAILED);
  assert.equal(stripped.reply?.payload.code, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);

  // M forwards A's own key and proof: the app knows that key from another saved server and signs nothing.
  const forwarded = await relay(a, victim, createProtocolOffer('client'), payload => current('m3.example:3000', payload));
  assert.deepEqual(forwarded, { refused: 'key-of-other-server' });
  assert.equal(pins.has('m3.example:3000'), false);
});

test('normal sign-in, reconnection and another device keep working, bound and unbound', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const keys = identity();
  const pins = new Map<string, string>();
  for (const attempt of ['first', 'reconnect']) {
    const result = await signIn(f, keys, createProtocolOffer('client'), payload => app(keys, pins)('srv:3000', payload));
    assert.equal(result.reply?.type, MessageType.AUTH_SUCCESS, attempt);
  }
  // Another device of the same person, with its own pins, also binds on its first sign-in.
  const second = await signIn(f, keys, createProtocolOffer('client'), payload => app(keys, new Map())('lan:3000', payload));
  assert.equal(second.reply?.type, MessageType.AUTH_SUCCESS);
  // People that never offered the feature keep the bare nonce, and so do apps without an explicit offer.
  const legacy = identity();
  for (const offer of [withoutKeyAuth, undefined]) {
    const result = await signIn(f, legacy, offer, payload => {
      assert.equal(payload.serverKey, undefined);
      return app(legacy, new Map())('srv:3000', payload);
    });
    assert.equal(result.reply?.type, MessageType.AUTH_SUCCESS);
  }
});

test('a member bound once is refused unbound, the app refuses a server that drops or changes its key', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const keys = identity();
  const pins = new Map<string, string>();
  const bound = await signIn(f, keys, createProtocolOffer('client'), payload => app(keys, pins)('srv:3000', payload));
  assert.equal(bound.reply?.type, MessageType.AUTH_SUCCESS);
  assert.equal(await f.userRepo.requiresServerKey(text(record(bound.reply?.payload.currentUser).id)), true);

  // Server side: an old app of the same person (bare nonce) is told to update.
  const old = await signIn(f, keys, withoutKeyAuth, payload => app(keys, new Map(), true)('srv:3000', payload));
  assert.equal(old.reply?.type, MessageType.AUTH_FAILED);
  assert.equal(old.reply?.payload.code, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);

  // App side: no downgrade, and no other key, on the pinned address.
  const dropped = await signIn(f, keys, withoutKeyAuth, payload => app(keys, pins)('srv:3000', payload));
  assert.deepEqual(dropped, { refused: 'key-missing' });
  const changed = await signIn(f, keys, createProtocolOffer('client'),
    payload => app(keys, pins)('srv:3000', malicious().challenge(payload)));
  assert.deepEqual(changed, { refused: 'key-changed' });
  // A forged proof for the right key is caught by the signature check.
  const forged = await signIn(f, keys, createProtocolOffer('client'),
    payload => app(keys, pins)('srv:3000', { ...payload, serverSignature: '0'.repeat(128) }));
  assert.deepEqual(forged, { refused: 'server-signature' });
});

test('the server identity survives a restart and its proof verifies', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-server-key-'));
  const file = path.join(dir, 'server.db');
  const first = await DatabaseConnection.create(file);
  const created = await ServerIdentity.load(new SqliteServerRepository(first.getDb()));
  first.getDb().flush();
  first.close();
  const reopened = await DatabaseConnection.create(file);
  t.after(() => {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const loaded = await ServerIdentity.load(new SqliteServerRepository(reopened.getDb()));
  assert.equal(loaded.publicKey, created.publicKey);
  const nonce = 'ab'.repeat(32);
  const key: KeyObject = createPublicKey({ key: Buffer.from(loaded.publicKey, 'hex'), format: 'der', type: 'spki' });
  assert.equal(verify(null, Buffer.from(serverAuthChallenge(nonce, loaded.publicKey), 'utf8'), key,
    Buffer.from(created.signChallenge(nonce), 'hex')), true);
  // A second creation keeps the stored key.
  assert.equal(await new SqliteServerRepository(reopened.getDb()).createIdentityKey('00', Date.now()),
    await new SqliteServerRepository(reopened.getDb()).getIdentityKey());
});
