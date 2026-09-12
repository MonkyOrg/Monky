import fs from 'node:fs';
import path from 'node:path';

function isIgnorablePermissionError(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['EINVAL', 'ENOSYS', 'EPERM', 'EACCES'].includes(error.code);
}

export function applyMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error: unknown) {
    if (process.platform !== 'win32' || !isIgnorablePermissionError(error)) throw error;
  }
}

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  applyMode(directory, 0o700);
}

export function writePrivateFile(file: string, content: string | NodeJS.ArrayBufferView): void {
  ensurePrivateDirectory(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600 });
  applyMode(file, 0o600);
}

export function writePrivateJson(file: string, value: unknown): void {
  writePrivateFile(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJsonFile(file: string, label: string, maxBytes = 256_000): unknown {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${label} is not a file.`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds the size limit.`);
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
  return input;
}
