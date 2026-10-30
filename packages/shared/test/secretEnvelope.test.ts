import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  BACKUP_EXPORT_PREFIX, IDENTITY_EXPORT_PREFIX, SECRET_ENVELOPE_PBKDF2_ITERATIONS, SecretEnvelopeError, isSecretEnvelope,
  openIdentityExport, openSecretEnvelope, sealIdentityExport, sealSecretEnvelope, secretPasswordProblem,
} from '../src/index.js';

// Exported by the app before #490 (PBKDF2-SHA256 with 210 000 iterations), with this password.
const LEGACY_PASSWORD = 'legacy fixture password';
const LEGACY_PUBLIC_KEY = '302a300506032b6570032100f36c91a111c0f7c2f6a023006337062253309be913f6a3a52b715868f6a1d1d7';
const LEGACY_IDENTITY_CODE = 'MONKY-ID:eyJ2ZXJzaW9uIjoxLCJzYWx0IjoiZjE5MDUwZjUxZmNmMWVhMTRhZGFiZjgxZmY3ZTgyY2YiLCJpdiI6Ijk0ZWE3OTA5YTVjMzBkZjg0NTE0NDRlNyIsInRhZyI6ImI1NDZiMzVjMjgzZmRmNzczYjk3OGQ0MDlhYjkxOTlhIiwiY2lwaGVydGV4dCI6IjNjMDRmNTg5MzU3YWNmYjMwNjJiZTFiYWMxZDJiOWE3MzJkMDEyNmM3MTlkYzYyNDg4MTY2ZWQ3MjFjYTk2Y2RjNTY4ZGJiYjExYjEzZmFiMmE2YWVkMzExYTdjMTFmZmJlMjA1MzhjMTlkY2VjYTQ4OTJjMjE1NTJkNGViZWM5ODQ5NTU2YWRiMWY2N2QwNmY1ZTdhZGEwMTBmY2E4OTNjNDUwMmE5M2YwOGE4NmZhNDYyMTg4NTRkMjJhODgzNDQwYWE2YjNjNGFiZDE5Yjg3MTUyYjMwNDBhOWQ1MWZkMmRhN2ViYjQ4MjA3NzgwZWJlNTZhNzEwZWQwYjk1YWFkYjhlNGJjYjJkOTcyYTMyYzBhNDA2NzcwNDZlZmNlNGFhZDJkY2Q2YmZiMTkxZjI4YzkxNjY0ZjQ3MzBlMWFjNDQ2ZWZjNzNlOTYyZmZkY2UyOGM3NjU0NmY3NmU5OGNiN2ViOTZjZGYyNDFiMjJhOGE2NDI4ZmFmZjE2ZWJlMzAyODYxNjI0ZTViNzI4OTA2MTM0YTZkZjM5ZDZmZmNiZmNjMGIxZDU1NDdhZGU0MWVlZjg3YmViNTlkZWUyMWY2MTY2MzIxNGMxMWQ2ODM0ZGZjNzAyMWNmNGMxZGZkNDk2NTM0MWMyMWMxZDBjMGEyN2JhZWQ1ZDExZTgyNGJmMDhlYTljMjg0ODBlYjU0MjUzNTkwMmQ4ZTMwMjgzMGU4MTA1ZjkxMzdkIn0=';
const LEGACY_BACKUP_CODE = 'MONKY-BACKUP:eyJ2ZXJzaW9uIjoxLCJzYWx0IjoiYjhlMGU2MGE3MzRjZDQ5MjQzMGQzODhlMTYzZGYwMTMiLCJpdiI6IjI4ZmRjZjRlYmNjYWM0NTA2NmJlMWNmNiIsInRhZyI6IjFmMDQxZTc3YTBhODdiMmE2ZDUzMTg1Y2JiMTIwY2QyIiwiY2lwaGVydGV4dCI6Ijc2MWUxODg0ZjhkYjAxNDEzM2FmMzNlOWE5OGE5ZTk0N2Q1YzYyNTNkNGZlZDNmZjU3MTQ0YiJ9';
const LEGACY_IDENTITY_PREFIX = 'MONKY-ID:';
const LEGACY_BACKUP_PREFIX = 'MONKY-BACKUP:';
const PASSWORD = 'correct horse battery';

function decode(code: string, prefix: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(code.slice(prefix.length), 'base64').toString('utf8'));
}

function encode(envelope: Record<string, unknown>, prefix = IDENTITY_EXPORT_PREFIX): string {
  return `${prefix}${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')}`;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SecretEnvelopeError, String(error));
    return error.code;
  }
  assert.fail('The envelope operation should have failed.');
}

/**
 * The reader shipped before #490 in the app (`openEnvelope`) and in
 * `monky create` (`decryptIdentityExport`): the prefix, then PBKDF2-SHA256 with
 * a fixed 210 000 iterations. Codes keep circulating to installs that never
 * update, so what this reader says about new codes is part of the contract.
 */
function legacyRead(payload: string, password: string, prefix: string): string {
  const normalized = payload.trim();
  if (!normalized.startsWith(prefix)) return 'invalid';
  let envelope: Record<string, string>;
  try {
    envelope = JSON.parse(Buffer.from(normalized.slice(prefix.length), 'base64').toString('utf8'));
  } catch {
    return 'invalid';
  }
  if (!envelope?.salt || !envelope?.iv || !envelope?.tag || !envelope?.ciphertext) return 'invalid';
  const key = pbkdf2Sync(password, Buffer.from(envelope.salt, 'hex'), 210_000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return 'wrong_password';
  }
}

test('new envelopes name their KDF and cost and open again', async () => {
  const code = await sealSecretEnvelope('{"secret":true}', PASSWORD, 'backup');
  assert.equal(BACKUP_EXPORT_PREFIX, 'MONKY-BACKUP2:');
  assert.ok(code.startsWith(BACKUP_EXPORT_PREFIX));
  const envelope = decode(code, BACKUP_EXPORT_PREFIX);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.kdf, 'pbkdf2-sha256');
  assert.equal(envelope.iterations, SECRET_ENVELOPE_PBKDF2_ITERATIONS);
  assert.ok(SECRET_ENVELOPE_PBKDF2_ITERATIONS >= 600_000, 'OWASP floor for PBKDF2-HMAC-SHA256');
  assert.match(String(envelope.salt), /^[0-9a-f]{32}$/);
  assert.match(String(envelope.iv), /^[0-9a-f]{24}$/);
  assert.match(String(envelope.tag), /^[0-9a-f]{32}$/);
  assert.equal(await openSecretEnvelope(code, PASSWORD, 'backup'), '{"secret":true}');
  assert.notEqual(await sealSecretEnvelope('{"secret":true}', PASSWORD, 'backup'), code, 'Salt and IV are fresh');

  assert.equal(await failure(openSecretEnvelope(code, 'another good password', 'backup')), 'wrong_password');
  assert.equal(await failure(openSecretEnvelope(code, '  ', 'backup')), 'missing_password');
  const flipped = String(envelope.ciphertext).replace(/^./, (digit) => (digit === '0' ? '1' : '0'));
  assert.equal(await failure(openSecretEnvelope(encode({ ...envelope, ciphertext: flipped }, BACKUP_EXPORT_PREFIX), PASSWORD,
    'backup')), 'wrong_password', 'Tampering is caught by the tag');
  assert.equal(await failure(openSecretEnvelope(code, PASSWORD, 'identity')), 'invalid', 'A backup is not an identity');
});

test('codes and backups exported before the stronger KDF still open', async () => {
  const identity = await openIdentityExport(LEGACY_IDENTITY_CODE, LEGACY_PASSWORD);
  assert.equal(identity.publicKey, LEGACY_PUBLIC_KEY);
  assert.equal(identity.extras, '{"version":1,"servers":[]}');
  assert.deepEqual(identity.dm, { version: 1, peers: [] });
  assert.equal(await openSecretEnvelope(LEGACY_BACKUP_CODE, LEGACY_PASSWORD, 'backup'), '{"version":1,"settings":{}}');
  assert.equal(await failure(openIdentityExport(LEGACY_IDENTITY_CODE, 'wrong password')), 'wrong_password');
  // A pasted code may come wrapped across lines.
  const wrapped = `  ${LEGACY_IDENTITY_CODE.replace(/(.{64})/g, '$1\n')}\n`;
  assert.equal((await openIdentityExport(wrapped, LEGACY_PASSWORD)).publicKey, LEGACY_PUBLIC_KEY);

  // Version 1 had no KDF field, and its readers never required the version itself.
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(LEGACY_PASSWORD, salt, 210_000, 32, 'sha256'), iv);
  const ciphertext = Buffer.concat([cipher.update('{"privateKeyDerBase64":"AA=="}', 'utf8'), cipher.final()]);
  const unversioned = encode({
    salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex'),
  }, LEGACY_IDENTITY_PREFIX);
  assert.equal((await openIdentityExport(unversioned, LEGACY_PASSWORD)).privateKeyDerBase64, 'AA==');

  // Development builds sealed version 2 under the old prefix for a while; those codes still open.
  const current = await sealIdentityExport({ privateKeyDerBase64: 'AA==' }, PASSWORD);
  const relabeled = encode(decode(current, IDENTITY_EXPORT_PREFIX), LEGACY_IDENTITY_PREFIX);
  assert.equal((await openIdentityExport(relabeled, PASSWORD)).privateKeyDerBase64, 'AA==');
});

test('readers released before #490 call new codes invalid instead of blaming the password', async () => {
  // The replica is faithful: it opens what the old app exported and rejects a wrong password.
  assert.equal(JSON.parse(legacyRead(LEGACY_IDENTITY_CODE, LEGACY_PASSWORD, LEGACY_IDENTITY_PREFIX)).publicKey, LEGACY_PUBLIC_KEY);
  assert.equal(legacyRead(LEGACY_IDENTITY_CODE, 'wrong password', LEGACY_IDENTITY_PREFIX), 'wrong_password');
  assert.equal(legacyRead(LEGACY_BACKUP_CODE, LEGACY_PASSWORD, LEGACY_BACKUP_PREFIX), '{"version":1,"settings":{}}');

  const identity = await sealIdentityExport({ privateKeyDerBase64: 'AA==' }, PASSWORD);
  const backup = await sealSecretEnvelope('{"version":1}', PASSWORD, 'backup');
  assert.equal(IDENTITY_EXPORT_PREFIX, 'MONKY-ID2:');
  assert.ok(identity.startsWith(IDENTITY_EXPORT_PREFIX));
  assert.equal(legacyRead(identity, PASSWORD, LEGACY_IDENTITY_PREFIX), 'invalid', 'An old app or monky create says "invalid code"');
  assert.equal(legacyRead(backup, PASSWORD, LEGACY_BACKUP_PREFIX), 'invalid', 'An old app says "invalid backup file"');
  // Why the prefix changed: under the old one, the right password would read as a wrong one.
  const sameEnvelopeOldPrefix = encode(decode(identity, IDENTITY_EXPORT_PREFIX), LEGACY_IDENTITY_PREFIX);
  assert.equal(legacyRead(sameEnvelopeOldPrefix, PASSWORD, LEGACY_IDENTITY_PREFIX), 'wrong_password');

  for (const value of [identity, ` ${identity}\n`, LEGACY_IDENTITY_CODE]) assert.equal(isSecretEnvelope(value, 'identity'), true);
  for (const value of [backup, LEGACY_BACKUP_CODE]) assert.equal(isSecretEnvelope(value, 'backup'), true);
  for (const value of [backup, LEGACY_BACKUP_CODE, 'monky-id2:e30=', 'MONKY-ID3:e30=', 'MONKY-ID', 'https://example.test']) {
    assert.equal(isSecretEnvelope(value, 'identity'), false, value);
  }
  assert.equal(isSecretEnvelope(identity, 'backup'), false);
});

test('envelopes from a newer Monky are reported as such instead of a wrong password', async () => {
  const envelope = decode(await sealSecretEnvelope('x', PASSWORD, 'identity'), IDENTITY_EXPORT_PREFIX);
  assert.equal(await failure(openSecretEnvelope(encode({ ...envelope, version: 3 }), PASSWORD, 'identity')), 'unsupported');
  assert.equal(await failure(openSecretEnvelope(encode({ ...envelope, kdf: 'argon2id' }), PASSWORD, 'identity')), 'unsupported');
  const started = Date.now();
  assert.equal(await failure(openSecretEnvelope(encode({ ...envelope, iterations: 4_000_000_000 }), PASSWORD,
    'identity')), 'unsupported');
  assert.ok(Date.now() - started < 1_000, 'An oversized cost is refused before deriving anything');

  for (const broken of [
    'MONKY-ID2:not base64 at all!', 'MONKY-ID2:', 'MONKY-ID:WzFd', 'MONKY-BACKUP2:e30=', 'MONKY-BACKUP:e30=', 'monky-id2:e30=',
    'MONKY-ID3:e30=', encode({ ...envelope, kdf: undefined }), encode({ ...envelope, iv: 'zz' }), encode({ ...envelope, tag: '00' }),
    encode({ ...envelope, version: '2' }), encode({ ...envelope, ciphertext: '' }), encode({ ...envelope, iterations: 0 }),
  ]) {
    assert.equal(await failure(openSecretEnvelope(broken, PASSWORD, 'identity')), 'invalid', broken);
  }
});

test('passwords that protect exported secrets need a minimum length and cannot be common', async () => {
  for (const password of ['', '       ', 'abc', 'Ab1!xyz', '  1234567  ']) assert.equal(secretPasswordProblem(password), 'too_short', password);
  for (const password of ['12345678', '87654321', 'abcdefgh', 'aaaaaaaa', 'abababab', 'Password123', 'senha123', ' QWERTYUIOP ',
    'monkymonky']) {
    assert.equal(secretPasswordProblem(password), 'too_common', password);
  }
  for (const password of ['correct horse battery', 'Fl4mengo-2026', 'pão de queijo', '8 letras!']) {
    assert.equal(secretPasswordProblem(password), null, password);
  }
  assert.equal(await failure(sealSecretEnvelope('x', 'short', 'backup')), 'too_short');
  assert.equal(await failure(sealIdentityExport({ privateKeyDerBase64: 'AA==' }, 'password123')), 'too_common');
});

test('identity codes keep their opaque extras and reject content without a key', async () => {
  const dm = { version: 1, peers: [{ publicKey: 'peer' }] };
  const code = await sealIdentityExport({ publicKey: 'public', privateKeyDerBase64: 'AA==', extras: '{"servers":[]}', dm }, PASSWORD);
  assert.ok(code.startsWith(IDENTITY_EXPORT_PREFIX));
  assert.deepEqual(await openIdentityExport(code, PASSWORD),
    { publicKey: 'public', privateKeyDerBase64: 'AA==', extras: '{"servers":[]}', dm });
  const minimal = await openIdentityExport(await sealIdentityExport({ privateKeyDerBase64: 'AA==' }, PASSWORD), PASSWORD);
  assert.deepEqual(minimal, { privateKeyDerBase64: 'AA==' });
  for (const plaintext of ['not json', '{"publicKey":"public"}', '{"privateKeyDerBase64":""}']) {
    const sealed = await sealSecretEnvelope(plaintext, PASSWORD, 'identity');
    assert.equal(await failure(openIdentityExport(sealed, PASSWORD)), 'invalid_content', plaintext);
  }
  // Fields an earlier exporter never wrote with another type are ignored rather than fatal.
  const odd = await openIdentityExport(
    await sealSecretEnvelope('{"privateKeyDerBase64":"AA==","extras":42,"publicKey":7}', PASSWORD, 'identity'), PASSWORD,
  );
  assert.equal(odd.privateKeyDerBase64, 'AA==');
  assert.equal(odd.extras, undefined);
  assert.equal(odd.publicKey, undefined);
});
