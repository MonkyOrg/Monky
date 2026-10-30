const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const shared = require('@monky/shared');

const repository = path.resolve(__dirname, '..', '..', '..');
const mainSource = (name) => path.join(repository, 'apps', 'client', 'src', 'main', name);

// Exported by the app before #490 (PBKDF2-SHA256 with 210 000 iterations), with this password.
const LEGACY_PASSWORD = 'legacy fixture password';
const LEGACY_PUBLIC_KEY = '302a300506032b6570032100f36c91a111c0f7c2f6a023006337062253309be913f6a3a52b715868f6a1d1d7';
const LEGACY_IDENTITY_CODE = 'MONKY-ID:eyJ2ZXJzaW9uIjoxLCJzYWx0IjoiZjE5MDUwZjUxZmNmMWVhMTRhZGFiZjgxZmY3ZTgyY2YiLCJpdiI6Ijk0ZWE3OTA5YTVjMzBkZjg0NTE0NDRlNyIsInRhZyI6ImI1NDZiMzVjMjgzZmRmNzczYjk3OGQ0MDlhYjkxOTlhIiwiY2lwaGVydGV4dCI6IjNjMDRmNTg5MzU3YWNmYjMwNjJiZTFiYWMxZDJiOWE3MzJkMDEyNmM3MTlkYzYyNDg4MTY2ZWQ3MjFjYTk2Y2RjNTY4ZGJiYjExYjEzZmFiMmE2YWVkMzExYTdjMTFmZmJlMjA1MzhjMTlkY2VjYTQ4OTJjMjE1NTJkNGViZWM5ODQ5NTU2YWRiMWY2N2QwNmY1ZTdhZGEwMTBmY2E4OTNjNDUwMmE5M2YwOGE4NmZhNDYyMTg4NTRkMjJhODgzNDQwYWE2YjNjNGFiZDE5Yjg3MTUyYjMwNDBhOWQ1MWZkMmRhN2ViYjQ4MjA3NzgwZWJlNTZhNzEwZWQwYjk1YWFkYjhlNGJjYjJkOTcyYTMyYzBhNDA2NzcwNDZlZmNlNGFhZDJkY2Q2YmZiMTkxZjI4YzkxNjY0ZjQ3MzBlMWFjNDQ2ZWZjNzNlOTYyZmZkY2UyOGM3NjU0NmY3NmU5OGNiN2ViOTZjZGYyNDFiMjJhOGE2NDI4ZmFmZjE2ZWJlMzAyODYxNjI0ZTViNzI4OTA2MTM0YTZkZjM5ZDZmZmNiZmNjMGIxZDU1NDdhZGU0MWVlZjg3YmViNTlkZWUyMWY2MTY2MzIxNGMxMWQ2ODM0ZGZjNzAyMWNmNGMxZGZkNDk2NTM0MWMyMWMxZDBjMGEyN2JhZWQ1ZDExZTgyNGJmMDhlYTljMjg0ODBlYjU0MjUzNTkwMmQ4ZTMwMjgzMGU4MTA1ZjkxMzdkIn0=';
const LEGACY_BACKUP_CODE = 'MONKY-BACKUP:eyJ2ZXJzaW9uIjoxLCJzYWx0IjoiYjhlMGU2MGE3MzRjZDQ5MjQzMGQzODhlMTYzZGYwMTMiLCJpdiI6IjI4ZmRjZjRlYmNjYWM0NTA2NmJlMWNmNiIsInRhZyI6IjFmMDQxZTc3YTBhODdiMmE2ZDUzMTg1Y2JiMTIwY2QyIiwiY2lwaGVydGV4dCI6Ijc2MWUxODg0ZjhkYjAxNDEzM2FmMzNlOWE5OGE5ZTk0N2Q1YzYyNTNkNGZlZDNmZjU3MTQ0YiJ9';
const PASSWORD = 'correct horse battery';

function load(file, modules) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports, Buffer, console, Error,
    require: (name) => {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error(`Unexpected import in ${path.basename(file)}: ${name}`);
    },
  });
  return exports;
}

/** The app's real identity export, on a throwaway profile, and the server CLI's real reader. */
function sides(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-identity-export-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const i18n = load(mainSource('i18n.ts'), { fs, path });
  const envelope = load(mainSource('secretEnvelope.ts'), { '@monky/shared': shared, './i18n': i18n });
  const electron = {
    app: { getPath: (kind) => { assert.equal(kind, 'userData'); return userData; } },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const app = load(mainSource('identityService.ts'), {
    crypto, electron, fs, path, '@monky/shared': shared, './secretEnvelope': envelope, './dm/dmCrypto': { DmKeyring: class {} },
    './atomicFile': load(mainSource('atomicFile.ts'), { crypto, fs, path }),
  });
  const cli = load(path.join(repository, 'apps', 'server', 'src', 'cli', 'identity.ts'), {
    crypto, '@monky/shared': shared, './i18n/index': { t: (key) => key },
  });
  return { app, cli, envelope, i18n };
}

test('identity codes exported by the app open in monky create, and earlier codes still import', async (t) => {
  const { app, cli } = sides(t);
  const identity = app.getIdentity(true);
  const dm = { version: 1, peers: [] };
  const code = await app.exportIdentity(PASSWORD, '{"version":1,"servers":[]}', dm);
  assert.ok(code.startsWith('MONKY-ID2:'), 'Apps and CLIs from before #490 reject the new prefix as an invalid code');
  const envelope = JSON.parse(Buffer.from(code.slice(shared.IDENTITY_EXPORT_PREFIX.length), 'base64').toString('utf8'));
  assert.equal(envelope.version, 2);
  assert.ok(envelope.iterations >= 600_000, 'The app seals with the recommended cost');

  const opened = await cli.decryptIdentityExport(code, PASSWORD);
  assert.equal(opened.publicKey, identity.publicKey, 'monky create reads exactly what the app wrote');
  assert.equal(opened.clientId, identity.clientId);
  await assert.rejects(cli.decryptIdentityExport(code, 'another long password'), { message: 'identity.wrongPassword' });

  const imported = await app.importIdentity(code, PASSWORD);
  assert.equal(imported.status, 'imported', 'The identity in use imports again without asking');
  assert.equal(imported.publicKey, identity.publicKey);
  assert.equal(imported.extras, '{"version":1,"servers":[]}');
  assert.deepEqual(imported.dm, dm);

  const asked = await app.importIdentity(LEGACY_IDENTITY_CODE, LEGACY_PASSWORD);
  assert.equal(asked.status, 'confirm-replace', 'Another identity waits for the user to confirm');
  assert.equal(asked.publicKey, LEGACY_PUBLIC_KEY);
  assert.equal(app.getIdentity(false).publicKey, identity.publicKey, 'Nothing changes before that');
  const legacy = await app.importIdentity(LEGACY_IDENTITY_CODE, LEGACY_PASSWORD, asked.publicKey);
  assert.equal(legacy.status, 'imported');
  assert.equal(legacy.publicKey, LEGACY_PUBLIC_KEY);
  assert.equal(app.getIdentity(false).publicKey, LEGACY_PUBLIC_KEY, 'An imported identity replaces the stored one');
  assert.equal((await cli.decryptIdentityExport(LEGACY_IDENTITY_CODE, LEGACY_PASSWORD)).publicKey, LEGACY_PUBLIC_KEY);
});

test('the app refuses weak export passwords and explains envelope failures in its language', async (t) => {
  const { app, envelope, i18n } = sides(t);
  const identity = app.getIdentity(true);
  await assert.rejects(app.exportIdentity('curta'), { message: 'A senha precisa ter pelo menos 8 caracteres.' });
  i18n.setMainLanguage('en');
  await assert.rejects(app.exportIdentity('password123'), { message: 'This password is common or easy to guess. Choose another one.' });
  await assert.rejects(envelope.sealBackup('{}', 'short'), { message: 'The password needs at least 8 characters.' });

  const code = await app.exportIdentity(PASSWORD);
  await assert.rejects(app.importIdentity(code, 'another long password'), { message: 'Wrong password or corrupted identity.' });
  const sealed = JSON.parse(Buffer.from(code.slice(shared.IDENTITY_EXPORT_PREFIX.length), 'base64').toString('utf8'));
  const newer = `${shared.IDENTITY_EXPORT_PREFIX}${Buffer.from(JSON.stringify({ ...sealed, version: 3 })).toString('base64')}`;
  await assert.rejects(app.importIdentity(newer, PASSWORD), { message: /newer version of Monky/ });
  await assert.rejects(app.importIdentity(LEGACY_BACKUP_CODE, LEGACY_PASSWORD), { message: 'Invalid identity code.' });
  assert.equal(app.getIdentity(false).publicKey, identity.publicKey, 'A failed import keeps the current identity');

  assert.equal(await envelope.openBackup(LEGACY_BACKUP_CODE, LEGACY_PASSWORD), '{"version":1,"settings":{}}');
  await assert.rejects(envelope.openBackup(LEGACY_BACKUP_CODE, 'wrong'), { message: 'Wrong password or corrupted backup.' });
  await assert.rejects(envelope.openBackup(code, PASSWORD), { message: 'Invalid backup file.' });
  const backup = await envelope.sealBackup('{"version":1}', PASSWORD);
  assert.ok(backup.startsWith('MONKY-BACKUP2:'), 'Apps from before #490 reject the new prefix as an invalid backup file');
  assert.equal(await envelope.openBackup(backup, PASSWORD), '{"version":1}');
});
