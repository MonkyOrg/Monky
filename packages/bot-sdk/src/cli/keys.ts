import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory, writePrivateFile } from './fs';

export interface KeyPair {
  publicKeyHex: string;
  privateKeyPem: string;
}

export interface KeyPaths {
  directory: string;
  publicKeyFile: string;
  privateKeyFile: string;
  registrationsFile: string;
}

export function keyPaths(botDir: string): KeyPaths {
  const directory = path.join(botDir, '.keys');
  return {
    directory,
    publicKeyFile: path.join(directory, 'public.hex'),
    privateKeyFile: path.join(directory, 'private.pem'),
    registrationsFile: path.join(directory, 'registrations.json'),
  };
}

function isHexPublicKey(value: string): boolean {
  return /^[0-9a-f]{88}$/i.test(value.trim());
}

function incompleteIdentityMessage(paths: KeyPaths): string {
  return `The bot identity in ${paths.directory} is incomplete or corrupted. Restore public.hex, private.pem and registrations.json from the same backup or remove the entire .keys directory to create a new identity.`;
}

export function loadBotKeys(botDir: string): KeyPair {
  const paths = keyPaths(botDir);
  const hasPublic = fs.existsSync(paths.publicKeyFile);
  const hasPrivate = fs.existsSync(paths.privateKeyFile);
  if (!hasPublic || !hasPrivate) throw new Error(incompleteIdentityMessage(paths));
  const publicKeyHex = fs.readFileSync(paths.publicKeyFile, 'utf8').trim();
  if (!isHexPublicKey(publicKeyHex)) {
    throw new Error(`The public key at ${paths.publicKeyFile} is invalid. Expected 88 hex characters in DER/SPKI format.`);
  }
  const privateKeyPem = fs.readFileSync(paths.privateKeyFile, 'utf8');
  if (!privateKeyPem.includes('BEGIN PRIVATE KEY')) {
    throw new Error(`The private key at ${paths.privateKeyFile} is invalid or truncated.`);
  }
  return { publicKeyHex, privateKeyPem };
}

export function loadOrCreateBotKeys(botDir: string): KeyPair {
  const paths = keyPaths(botDir);
  const hasPublic = fs.existsSync(paths.publicKeyFile);
  const hasPrivate = fs.existsSync(paths.privateKeyFile);
  const hasRegistrations = fs.existsSync(paths.registrationsFile);
  if (hasPublic && hasPrivate) return loadBotKeys(botDir);
  if (hasPublic || hasPrivate || hasRegistrations) throw new Error(incompleteIdentityMessage(paths));

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyHex = Buffer.from(publicKey).toString('hex');
  if (!isHexPublicKey(publicKeyHex)) {
    throw new Error('Generated Ed25519 public key does not match the expected DER/SPKI length.');
  }

  ensurePrivateDirectory(paths.directory);
  writePrivateFile(paths.publicKeyFile, `${publicKeyHex}\n`);
  writePrivateFile(paths.privateKeyFile, privateKey);
  return { publicKeyHex, privateKeyPem: privateKey };
}
