// Creates the self-signed certificate that signs the macOS releases.
//
// macOS ties the permissions a user grants (Screen Recording, Microphone,
// Camera) to the app's designated requirement. An ad-hoc signature pins that
// requirement to a hash that changes on every build, so each update looks like
// a different app. A certificate pins it to the certificate itself, so the
// grants survive updates for as long as releases keep using the same one.
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = fileURLToPath(new URL('..', import.meta.url));
const commonName = 'Monky Code Signing';
export const signingFiles = {
  p12: 'monky-mac-signing.p12',
  base64: 'monky-mac-signing.p12.base64',
  password: 'monky-mac-signing-password.txt',
};

function openssl(args, env = {}) {
  const result = spawnSync('openssl', args, {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env },
  });
  if (result.error) throw new Error(`Could not run openssl: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr.trim()}`);
}

export function createMacSigningCertificate(out) {
  const directory = path.resolve(out);
  const relative = path.relative(repository, directory);
  if (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative))
    throw new Error(`Choose a folder outside the repository, not ${directory}, so the private key can never be committed.`);
  const targets = Object.fromEntries(Object.entries(signingFiles)
    .map(([key, name]) => [key, path.join(directory, name)]));
  const existing = Object.values(targets).filter(file => fs.existsSync(file));
  if (existing.length > 0)
    throw new Error(`Found an existing certificate (${existing.join(', ')}). Keep using it: a new one makes every macOS user grant the permissions again.`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-mac-signing-'));
  try {
    const config = path.join(temporary, 'openssl.cnf'), key = path.join(temporary, 'key.pem');
    const certificate = path.join(temporary, 'certificate.pem'), bundle = path.join(temporary, 'certificate.p12');
    fs.writeFileSync(config, [
      '[req]', 'prompt = no', 'distinguished_name = subject', 'x509_extensions = codesigning',
      '[subject]', `CN = ${commonName}`,
      '[codesigning]', 'basicConstraints = critical, CA:false', 'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = critical, codeSigning', 'subjectKeyIdentifier = hash', '',
    ].join('\n'));
    // Twenty years: a new certificate resets every user's permissions once more.
    openssl(['req', '-x509', '-config', config, '-newkey', 'rsa:3072', '-sha256', '-days', '7300', '-nodes',
      '-keyout', key, '-out', certificate]);
    const password = randomBytes(24).toString('base64url');
    // `security import` rejects the AES and PBKDF2 encryption OpenSSL 3 uses
    // by default ("MAC verification failed"). Request the classic algorithms.
    openssl(['pkcs12', '-export', '-inkey', key, '-in', certificate, '-name', commonName, '-out', bundle,
      '-passout', 'env:MONKY_SIGNING_PASSWORD', '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES',
      '-macalg', 'sha1'], { MONKY_SIGNING_PASSWORD: password });
    const p12 = fs.readFileSync(bundle);
    const sha1 = new X509Certificate(fs.readFileSync(certificate)).fingerprint.replaceAll(':', '').toLowerCase();
    const write = (file, data) => fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
    write(targets.p12, p12);
    write(targets.base64, p12.toString('base64'));
    write(targets.password, password);
    return {
      files: targets, sha1,
      requirement: `identifier "com.monky.app" and certificate leaf = H"${sha1}"`,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { out: { type: 'string', default: path.join(os.homedir(), 'Monky-mac-signing') } },
    });
    const { files, sha1, requirement } = createMacSigningCertificate(values.out);
    console.log([
      '[MacSigning] Created the macOS signing certificate:',
      `  ${files.p12}`, '      backup of the certificate and its private key',
      `  ${files.base64}`, '      value of the MAC_CSC_LINK secret',
      `  ${files.password}`, '      value of the MAC_CSC_KEY_PASSWORD secret',
      '',
      `Certificate SHA-1: ${sha1}`,
      'Releases signed with it have this designated requirement:',
      `  ${requirement}`,
      '',
      'Store the secrets from this repository checkout:',
      `  gh secret set MAC_CSC_LINK < "${files.base64}"`,
      `  gh secret set MAC_CSC_KEY_PASSWORD < "${files.password}"`,
      '',
      'Back up the .p12 and its password in a password manager, then delete this folder.',
      'Losing them forces a new certificate, and every macOS user grants the permissions again.',
      'Anyone holding them can sign an app that inherits the permissions granted to Monky.',
    ].join('\n'));
  } catch (error) {
    console.error(`[MacSigning] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
