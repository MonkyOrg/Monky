const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const shared = require('@monky/shared');

const mainSource = (name) => path.join(__dirname, '..', 'src', 'main', name);
const PASSWORD = 'correct horse battery';

function load(file, modules, globals = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports, Buffer, console, Error, ...globals,
    require: (name) => {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error(`Unexpected import in ${path.basename(file)}: ${name}`);
    },
  });
  return exports;
}

/** A fake system keychain: "encrypts" by tagging, and can be locked like a denied macOS Keychain or a foreign DPAPI blob. */
function keychain() {
  return {
    available: true,
    locked: false,
    decrypts: 0,
    isEncryptionAvailable() { return this.available; },
    encryptString(text) { return Buffer.from(`sealed:${text}`, 'utf8'); },
    decryptString(buffer) {
      this.decrypts++;
      if (this.locked) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      const text = buffer.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('Unexpected ciphertext');
      return text.slice('sealed:'.length);
    },
  };
}

/** A fresh main process: its own module state (the in-memory identity) over a throwaway profile. */
function launch(t, userData = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-identity-'))) {
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const safeStorage = keychain();
  const logged = [];
  const quiet = { ...console, error: (...parts) => logged.push(parts.map(String).join(' ')), warn: () => {} };
  const i18n = load(mainSource('i18n.ts'), { fs, path });
  const envelope = load(mainSource('secretEnvelope.ts'), { '@monky/shared': shared, './i18n': i18n });
  const atomicFile = load(mainSource('atomicFile.ts'), { crypto, fs, path });
  const electron = { app: { getPath: (kind) => { assert.equal(kind, 'userData'); return userData; } }, safeStorage };
  const keyrings = [];
  const service = load(mainSource('identityService.ts'), {
    crypto, electron, fs, path, '@monky/shared': shared, './atomicFile': atomicFile, './secretEnvelope': envelope,
    './dm/dmCrypto': { DmKeyring: class { constructor(publicKey) { this.identityPublicKey = publicKey; keyrings.push(publicKey); } } },
  }, { console: quiet });
  const file = path.join(userData, 'identity.json');
  return { service, safeStorage, logged, userData, file, relaunch: () => launch(t, userData) };
}

function writeRecord(file, record) {
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record, null, 2));
  return fs.readFileSync(file);
}

function plainRecord() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    version: 1,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    storage: 'plain',
  };
}

/** Results come from another realm (vm), so they are compared as plain data. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function leftovers(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
}

/** Every file the identity service writes: the identity, its copies and temporary files. */
function identityFiles(directory) {
  return fs.readdirSync(directory).filter((name) => /^\.?identity\./.test(name)).sort();
}

test('a computer without an identity gets one, written atomically and only readable by the user', (t) => {
  const app = launch(t);
  assert.deepEqual(plain(app.service.getIdentityStatus()), { state: 'missing' });
  assert.equal(app.service.getIdentity(false), null, 'Asking without creating keeps the computer empty');
  assert.equal(fs.existsSync(app.file), false);

  const identity = app.service.getIdentity(true);
  assert.match(identity.publicKey, /^[0-9a-f]+$/);
  assert.deepEqual(plain(app.service.getIdentityStatus()), { state: 'ready' });
  const record = JSON.parse(fs.readFileSync(app.file, 'utf8'));
  assert.equal(record.storage, 'safeStorage');
  assert.equal(record.publicKey, identity.publicKey);
  assert.deepEqual(leftovers(app.userData), [], 'No temporary file is left behind');
  if (process.platform !== 'win32') assert.equal(fs.statSync(app.file).mode & 0o777, 0o600);

  const next = app.relaunch();
  assert.equal(next.service.getIdentity(false).publicKey, identity.publicKey, 'The next launch reads the same identity');
});

test('the identity is read once: signing on every reconnection does not touch the disk or the keychain again', (t) => {
  const first = launch(t);
  const identity = first.service.getIdentity(true);
  const app = first.relaunch();
  assert.equal(app.service.hasIdentity(), true);
  assert.equal(app.safeStorage.decrypts, 1);

  // A keychain that locks afterwards (the Mac waking up) no longer matters: nothing is read again.
  app.safeStorage.locked = true;
  fs.rmSync(app.file);
  for (let attempt = 0; attempt < 5; attempt++) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const signature = app.service.signChallenge(nonce);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(identity.publicKey, 'hex'), format: 'der', type: 'spki' });
    assert.ok(crypto.verify(null, Buffer.from(nonce, 'hex'), publicKey, Buffer.from(signature, 'hex')));
  }
  assert.equal(app.service.getClientId(), identity.clientId);
  assert.equal(app.safeStorage.decrypts, 1, 'The keychain is asked once per launch');
  assert.equal(fs.existsSync(app.file), false, 'Nothing rewrote the file behind the user');
});

for (const [label, reason, damage] of [
  ['a locked keychain (macOS Keychain denied, DPAPI from another user)', 'locked', (app) => { app.safeStorage.locked = true; }],
  ['a truncated file', 'corrupt', (app) => writeRecord(app.file, fs.readFileSync(app.file, 'utf8').slice(0, 40))],
  ['a file without the key fields', 'corrupt', (app) => writeRecord(app.file, { version: 1, storage: 'plain' })],
  ['a key that does not match the stored public key', 'corrupt', (app) => {
    writeRecord(app.file, { ...JSON.parse(fs.readFileSync(app.file, 'utf8')), publicKey: plainRecord().publicKey });
  }],
  ['a file that cannot be read now', 'io', (app) => { fs.rmSync(app.file); fs.mkdirSync(app.file); }],
]) {
  test(`${label} is reported and the file is never replaced`, (t) => {
    const original = launch(t);
    original.service.getIdentity(true);
    const secret = JSON.parse(fs.readFileSync(original.file, 'utf8')).privateKey.slice(-32);
    const app = original.relaunch();
    damage(app);
    const before = fs.statSync(app.file).isDirectory() ? null : fs.readFileSync(app.file);

    assert.deepEqual(plain(app.service.getIdentityStatus()), { state: 'unreadable', reason });
    assert.equal(app.service.hasIdentity(), false);
    for (const attempt of [
      () => app.service.getIdentity(true),
      () => app.service.getIdentity(false),
      () => app.service.signChallenge('ab'.repeat(32)),
      () => app.service.getClientId(),
      () => app.service.createDmKeyring(),
    ]) {
      assert.throws(attempt, (error) => error.name === 'IdentityUnavailableError' && error.reason === reason);
    }
    if (before) assert.deepEqual(fs.readFileSync(app.file), before, 'The unreadable file is kept byte for byte');
    else assert.ok(fs.statSync(app.file).isDirectory());
    assert.deepEqual(fs.readdirSync(app.userData).filter((name) => name.startsWith('identity.')), ['identity.json']);
    assert.ok(app.logged.some((line) => line.includes(`(${reason}`)), 'The reason reaches the log');
    assert.ok(app.logged.every((line) => !line.includes(secret)), 'The log never quotes the key');
  });
}

test('trying again opens the identity once the keychain lets it through', (t) => {
  const original = launch(t);
  const identity = original.service.getIdentity(true);
  const app = original.relaunch();
  app.safeStorage.locked = true;
  assert.deepEqual(plain(app.service.getIdentityStatus()), { state: 'unreadable', reason: 'locked' });
  app.safeStorage.locked = false;
  assert.deepEqual(plain(app.service.getIdentityStatus()), { state: 'ready' });
  assert.equal(app.service.getIdentity(false).publicKey, identity.publicKey);
});

test('creating another identity is explicit and sets the unreadable file aside', async (t) => {
  const original = launch(t);
  const identity = original.service.getIdentity(true);
  const app = original.relaunch();
  const damaged = writeRecord(app.file, fs.readFileSync(app.file, 'utf8').slice(0, 30));

  const created = app.service.createIdentity();
  assert.notEqual(created.publicKey, identity.publicKey);
  assert.deepEqual(plain(app.service.getIdentityStatus()), { state: 'ready' });
  const aside = fs.readdirSync(app.userData).filter((name) => /^identity\.unreadable-\d+(-\d+)?\.json$/.test(name));
  assert.equal(aside.length, 1, 'The unreadable file is kept under another name');
  assert.deepEqual(fs.readFileSync(path.join(app.userData, aside[0])), damaged);
  assert.equal(JSON.parse(fs.readFileSync(app.file, 'utf8')).publicKey, created.publicKey);
  assert.equal(app.service.createIdentity().publicKey, created.publicKey, 'A readable identity is never replaced by "create"');
  assert.deepEqual(leftovers(app.userData), []);

  // Importing over an unreadable identity sets it aside too, without touching the earlier copy.
  const code = await app.service.exportIdentity(PASSWORD);
  const other = app.relaunch();
  writeRecord(other.file, '{"version":1,');
  const imported = await other.service.importIdentity(code, PASSWORD);
  assert.equal(imported.status, 'imported', 'With no identity in use there is nothing to confirm');
  assert.equal(imported.publicKey, created.publicKey);
  const kept = fs.readdirSync(other.userData).filter((name) => name.startsWith('identity.unreadable-'));
  assert.equal(kept.length, 2);
  assert.ok(kept.some((name) => fs.readFileSync(path.join(other.userData, name)).equals(damaged)));
  assert.equal(other.service.getIdentity(false).publicKey, created.publicKey);
});

test('importing another identity asks first, and the one in use is kept aside', async (t) => {
  const app = launch(t);
  const current = app.service.getIdentity(true);
  const before = fs.readFileSync(app.file);
  const elsewhere = launch(t);
  const other = elsewhere.service.getIdentity(true);
  const code = await elsewhere.service.exportIdentity(PASSWORD);

  const asked = await app.service.importIdentity(code, PASSWORD);
  assert.deepEqual(plain(asked), { status: 'confirm-replace', ...other });
  assert.deepEqual(fs.readFileSync(app.file), before, 'Nothing is written before the user confirms');
  assert.equal(app.service.getIdentity(false).publicKey, current.publicKey);
  assert.deepEqual(identityFiles(app.userData), ['identity.json']);
  assert.equal((await app.service.importIdentity(code, PASSWORD, current.publicKey)).status, 'confirm-replace',
    'Only a confirmation for the key in the code counts');

  const imported = await app.service.importIdentity(code, PASSWORD, asked.publicKey);
  assert.equal(imported.status, 'imported');
  assert.equal(app.service.getIdentity(false).publicKey, other.publicKey);
  assert.equal(app.relaunch().service.getIdentity(false).publicKey, other.publicKey);
  const kept = identityFiles(app.userData).filter((name) => /^identity\.replaced-\d+(-\d+)?\.json$/.test(name));
  assert.equal(kept.length, 1, 'The identity it replaced is kept aside');
  assert.deepEqual(leftovers(app.userData), []);
  // The copy really holds the previous identity: put back in place, it opens as before.
  const restored = launch(t);
  fs.copyFileSync(path.join(app.userData, kept[0]), restored.file);
  assert.equal(restored.service.getIdentity(false).publicKey, current.publicKey);
});

test('logging out removes every copy of the key, and only those', async (t) => {
  // An unreadable identity set aside by "create", that one replaced by an import, and writes that never finished.
  const first = launch(t);
  first.service.getIdentity(true);
  writeRecord(first.file, '{"version":1,');
  const app = first.relaunch();
  app.service.createIdentity();
  const elsewhere = launch(t);
  elsewhere.service.getIdentity(true);
  const code = await elsewhere.service.exportIdentity(PASSWORD);
  const asked = await app.service.importIdentity(code, PASSWORD);
  await app.service.importIdentity(code, PASSWORD, asked.publicKey);
  for (const name of ['.identity.json.0123456789ab.tmp', '.identity.replaced-1700000000000.json.abcdef012345.tmp']) {
    fs.writeFileSync(path.join(app.userData, name), 'partial');
  }
  const unrelated = ['Preferences', 'identity-notes.txt', 'my.identity.json'];
  for (const name of unrelated) fs.writeFileSync(path.join(app.userData, name), 'keep');
  fs.mkdirSync(path.join(app.userData, 'Local Storage'));
  assert.equal(identityFiles(app.userData).length, 5);

  // A copy that cannot be removed stops the logout before identity.json goes, so the account is intact to try again.
  const stuck = path.join(app.userData, 'identity.replaced-1-1.json');
  fs.mkdirSync(stuck);
  assert.throws(() => app.service.deleteIdentity());
  assert.ok(fs.existsSync(app.file));
  assert.ok(app.service.signChallenge('ab'.repeat(32)));
  fs.rmdirSync(stuck);

  app.service.deleteIdentity();
  assert.deepEqual(identityFiles(app.userData), [], 'No file with the key is left behind');
  for (const name of unrelated) assert.ok(fs.existsSync(path.join(app.userData, name)), `${name} stays`);
  assert.ok(fs.existsSync(path.join(app.userData, 'Local Storage')));
  assert.deepEqual(plain(app.service.getIdentityStatus()), { state: 'missing' });
  assert.equal(app.service.createDmKeyring(), null);
  assert.throws(() => app.service.signChallenge('ab'.repeat(32)), (error) => error.reason === 'missing',
    'Signing never invents an identity');
  assert.deepEqual(plain(app.relaunch().service.getIdentityStatus()), { state: 'missing' });
});
