import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { IDENTITY_EXPORT_PREFIX, deriveClientIdFromPublicKey, sealIdentityExport, sealSecretEnvelope } from '@monky/shared';
import { createCommand } from './cli/commands/create';
import { withContext } from './cli/context';
import { getCliLanguage, setCliLanguage, t, type CliTranslationKey } from './cli/i18n';
import { decryptIdentityExport } from './cli/identity';
import * as processes from './cli/process';
import * as prompts from './cli/prompts';

// Exported by the app before #490 (PBKDF2-SHA256 with 210 000 iterations), with this password.
const LEGACY_PASSWORD = 'legacy fixture password';
const LEGACY_PUBLIC_KEY = '302a300506032b6570032100f36c91a111c0f7c2f6a023006337062253309be913f6a3a52b715868f6a1d1d7';
const LEGACY_IDENTITY_CODE = 'MONKY-ID:eyJ2ZXJzaW9uIjoxLCJzYWx0IjoiZjE5MDUwZjUxZmNmMWVhMTRhZGFiZjgxZmY3ZTgyY2YiLCJpdiI6Ijk0ZWE3OTA5YTVjMzBkZjg0NTE0NDRlNyIsInRhZyI6ImI1NDZiMzVjMjgzZmRmNzczYjk3OGQ0MDlhYjkxOTlhIiwiY2lwaGVydGV4dCI6IjNjMDRmNTg5MzU3YWNmYjMwNjJiZTFiYWMxZDJiOWE3MzJkMDEyNmM3MTlkYzYyNDg4MTY2ZWQ3MjFjYTk2Y2RjNTY4ZGJiYjExYjEzZmFiMmE2YWVkMzExYTdjMTFmZmJlMjA1MzhjMTlkY2VjYTQ4OTJjMjE1NTJkNGViZWM5ODQ5NTU2YWRiMWY2N2QwNmY1ZTdhZGEwMTBmY2E4OTNjNDUwMmE5M2YwOGE4NmZhNDYyMTg4NTRkMjJhODgzNDQwYWE2YjNjNGFiZDE5Yjg3MTUyYjMwNDBhOWQ1MWZkMmRhN2ViYjQ4MjA3NzgwZWJlNTZhNzEwZWQwYjk1YWFkYjhlNGJjYjJkOTcyYTMyYzBhNDA2NzcwNDZlZmNlNGFhZDJkY2Q2YmZiMTkxZjI4YzkxNjY0ZjQ3MzBlMWFjNDQ2ZWZjNzNlOTYyZmZkY2UyOGM3NjU0NmY3NmU5OGNiN2ViOTZjZGYyNDFiMjJhOGE2NDI4ZmFmZjE2ZWJlMzAyODYxNjI0ZTViNzI4OTA2MTM0YTZkZjM5ZDZmZmNiZmNjMGIxZDU1NDdhZGU0MWVlZjg3YmViNTlkZWUyMWY2MTY2MzIxNGMxMWQ2ODM0ZGZjNzAyMWNmNGMxZGZkNDk2NTM0MWMyMWMxZDBjMGEyN2JhZWQ1ZDExZTgyNGJmMDhlYTljMjg0ODBlYjU0MjUzNTkwMmQ4ZTMwMjgzMGU4MTA1ZjkxMzdkIn0=';
const PASSWORD = 'correct horse battery';

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    privateKeyDerBase64: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function keepLanguage(context: TestContext): void {
  const previous = getCliLanguage();
  context.after(() => setCliLanguage(previous));
}

test('monky create opens identity codes in the app format, old and new', async () => {
  const keys = keyPair();
  const code = await sealIdentityExport({ ...keys, extras: '{"servers":[]}' }, PASSWORD);
  assert.ok(code.startsWith('MONKY-ID2:'), 'New codes use the prefix that older CLIs reject as invalid');
  const opened = await decryptIdentityExport(code, PASSWORD);
  assert.equal(opened.publicKey, keys.publicKey);
  assert.equal(opened.clientId, deriveClientIdFromPublicKey(keys.publicKey));
  assert.equal(opened.privateKeyDerBase64, keys.privateKeyDerBase64);
  assert.equal((await decryptIdentityExport(LEGACY_IDENTITY_CODE, LEGACY_PASSWORD)).publicKey, LEGACY_PUBLIC_KEY);
});

test('identity code failures are explained in the CLI language', async (context) => {
  keepLanguage(context);
  const keys = keyPair();
  const code = await sealIdentityExport(keys, PASSWORD);
  const envelope: Record<string, unknown> = JSON.parse(Buffer.from(code.slice(IDENTITY_EXPORT_PREFIX.length), 'base64').toString('utf8'));
  const newer = `${IDENTITY_EXPORT_PREFIX}${Buffer.from(JSON.stringify({ ...envelope, version: 3 })).toString('base64')}`;
  const foreignKey = await sealIdentityExport({ ...keys, publicKey: keyPair().publicKey }, PASSWORD);
  const brokenKey = await sealSecretEnvelope('{"privateKeyDerBase64":"AAAA"}', PASSWORD, 'identity');
  const backup = await sealSecretEnvelope('{"version":1}', PASSWORD, 'backup');
  const cases: Array<[string, string, CliTranslationKey]> = [
    [code, 'another long password', 'identity.wrongPassword'],
    [code, '   ', 'identity.noPassword'],
    [newer, PASSWORD, 'identity.unsupportedVersion'],
    ['not-an-identity-code', PASSWORD, 'identity.invalidCode'],
    [backup, PASSWORD, 'identity.invalidCode'],
    [`${IDENTITY_EXPORT_PREFIX}e30=`, PASSWORD, 'identity.invalidContent'],
    [foreignKey, PASSWORD, 'identity.keyMismatch'],
    [brokenKey, PASSWORD, 'identity.invalidDecrypted'],
  ];
  for (const language of ['en', 'pt-BR'] as const) {
    setCliLanguage(language);
    for (const [identityCode, password, key] of cases) {
      await assert.rejects(decryptIdentityExport(identityCode, password), { message: t(key) }, `${language}: ${key}`);
    }
  }
});

test('monky create checks the identity before writing server data', async (context) => {
  keepLanguage(context);
  setCliLanguage('en');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-identity-'));
  const previousHome = process.env.MONKY_HOME;
  process.env.MONKY_HOME = path.join(root, 'cli-home');
  context.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  context.mock.method(processes, 'runSync', (command: string) => assert.fail(`Unexpected command: ${command}`));
  context.mock.method(processes, 'runAsync', (command: string) => assert.fail(`Unexpected process: ${command}`));
  context.mock.method(console, 'log', () => undefined);
  const keys = keyPair();
  let identityPassword = 'a wrong but long password';
  context.mock.method(prompts, 'promptPassword', async () => identityPassword);
  context.mock.method(prompts, 'confirm', async (question: string) => question === t('create.confirm'));
  const dataDir = path.join(root, 'server');
  const args = [
    '--identity', await sealIdentityExport(keys, PASSWORD), '--name', 'Identity test', '--port', '3000',
    '--password', '', '--max-users', '0', '--voice-mode', 'p2p',
  ];

  await assert.rejects(createCommand({ args: ['create'], dataDir, dataDirSpecified: true }, args), { message: t('identity.wrongPassword') });
  assert.equal(fs.existsSync(dataDir), false, 'A wrong password leaves no half-created server behind');

  identityPassword = PASSWORD;
  await createCommand({ args: ['create'], dataDir, dataDirSpecified: true }, args);
  await withContext(dataDir, async (ctx) => {
    const owner = await ctx.userRepo.findByPublicKey(keys.publicKey);
    assert.ok(owner, 'The identity exported by the app owns the new server');
    assert.equal((await ctx.serverRepo.getServer())?.ownerUserId, owner.id);
  });
});
