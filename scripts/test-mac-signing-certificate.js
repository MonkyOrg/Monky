import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMacSigningCertificate, signingFiles } from './create-mac-signing-certificate.js';

const script = fileURLToPath(new URL('./create-mac-signing-certificate.js', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const noOpenssl = spawnSync('openssl', ['version']).error ? 'OpenSSL is not installed' : false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-signing-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const pem = (text, label) => text.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----`, 'u'))[0];

test('the signing certificate is created once, outside the repository, in a format macOS imports', { skip: noOpenssl }, t => {
  const out = path.join(temporary(t), 'signing');
  const { stdout } = run(process.execPath, [script, '--out', out]);
  const files = Object.fromEntries(Object.entries(signingFiles).map(([key, name]) => [key, path.join(out, name)]));
  const p12 = fs.readFileSync(files.p12), password = fs.readFileSync(files.password, 'utf8');
  assert.match(password, /^[\w-]{32}$/u, 'A trailing newline would become part of the MAC_CSC_KEY_PASSWORD secret.');
  assert.equal(fs.readFileSync(files.base64, 'utf8'), p12.toString('base64'));
  if (process.platform !== 'win32')
    for (const file of Object.values(files)) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);

  const env = { ...process.env, MONKY_TEST_PASSWORD: password };
  const pkcs12 = args => run('openssl', ['pkcs12', '-in', files.p12, '-passin', 'env:MONKY_TEST_PASSWORD', ...args], { env });
  const certificate = new X509Certificate(pem(pkcs12(['-nokeys', '-clcerts']).stdout, 'CERTIFICATE'));
  const key = createPrivateKey(pem(pkcs12(['-nocerts', '-nodes']).stdout, 'PRIVATE KEY'));
  assert.equal(certificate.subject, 'CN=Monky Code Signing');
  assert.equal(certificate.issuer, certificate.subject);
  assert.ok(certificate.verify(certificate.publicKey));
  assert.ok(certificate.checkPrivateKey(key), 'The .p12 must carry the private key of its certificate.');
  assert.equal(certificate.ca, false);
  assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.3'], 'codesign only uses certificates for code signing.');
  const years = (new Date(certificate.validTo) - new Date(certificate.validFrom)) / (365.25 * 24 * 3600 * 1000);
  assert.ok(years > 19.9, `A replacement certificate resets the macOS permissions, so it must last: ${years} years.`);
  const sha1 = certificate.fingerprint.replaceAll(':', '').toLowerCase();
  for (const line of [`Certificate SHA-1: ${sha1}`, `identifier "com.monky.app" and certificate leaf = H"${sha1}"`,
    `gh secret set MAC_CSC_LINK < "${files.base64}"`, `gh secret set MAC_CSC_KEY_PASSWORD < "${files.password}"`])
    assert.ok(stdout.includes(line), `Missing "${line}" in:\n${stdout}`);

  const info = pkcs12(['-info', '-noout']);
  const details = info.stdout + info.stderr;
  assert.equal(details.match(/pbeWithSHA1And3-KeyTripleDES-CBC/gu)?.length, 2, details);
  assert.doesNotMatch(details, /PBES2|PBKDF2|AES/iu, '`security import` rejects the OpenSSL 3 default encryption.');
  assert.equal(details.match(/^MAC: (\S+?),/mu)?.[1] ?? 'sha1', 'sha1', details);

  const again = spawnSync(process.execPath, [script, '--out', out], { encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^\[MacSigning\] Found an existing certificate .+ Keep using it/u);
  assert.deepEqual(fs.readFileSync(files.p12), p12);
  assert.equal(fs.readFileSync(files.password, 'utf8'), password);
});

test('the private key is never written inside the repository', () => {
  for (const out of [repository, path.join(repository, 'signing'), path.join(repository, '..signing')]) {
    assert.throws(() => createMacSigningCertificate(out), /Choose a folder outside the repository/u);
    assert.equal(fs.existsSync(path.join(out, signingFiles.p12)), false);
  }
  assert.equal(fs.existsSync(path.join(repository, 'signing')), false);
});

test('macOS imports the certificate as the code signing identity named by its SHA-1', {
  skip: process.platform === 'darwin' ? noOpenssl : 'macOS only',
}, t => {
  const directory = temporary(t);
  const { files, sha1 } = createMacSigningCertificate(path.join(directory, 'signing'));
  const keychain = path.join(directory, 'signing.keychain'), keychainPassword = randomBytes(16).toString('hex');
  // codesign itself would need this keychain on the user's search list, as
  // electron-builder arranges during a release; this test leaves the list alone.
  run('security', ['create-keychain', '-p', keychainPassword, keychain]);
  t.after(() => spawnSync('security', ['delete-keychain', keychain]));
  run('security', ['import', files.p12, '-k', keychain, '-P', fs.readFileSync(files.password, 'utf8'),
    '-T', '/usr/bin/codesign']);
  const identities = run('security', ['find-identity', '-p', 'codesigning', keychain]).stdout;
  assert.match(identities, new RegExp(`^\\s*1\\) ${sha1.toUpperCase()} "Monky Code Signing"`, 'mu'));
  assert.match(identities, /^\s*1 identities found$/mu);
});
