import { randomUUID } from 'node:crypto';
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

/**
 * Why a profile file exists but cannot be used. Each caller words it for its
 * own file; the message is the English fallback.
 */
export class PrivateJsonError extends Error {
  constructor(readonly problem: 'not-file' | 'too-large' | 'invalid-json', message: string) {
    super(message);
  }
}

/** The replacement failed, and so did removing its temporary file. */
export class LeftoverFileError extends Error {
  constructor(readonly file: string) {
    super(`Could not remove the temporary file ${file}.`);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Reads a small JSON file of the profile. Links, directories and anything over
 * `maxBytes` are refused rather than followed or loaded; a missing file throws
 * ENOENT (see {@link readOptionalPrivateJson}).
 */
export function readJsonFile(file: string, label: string, maxBytes = 256_000): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new PrivateJsonError('not-file', `${label} is not a file.`);
  if (stat.size > maxBytes) throw new PrivateJsonError('too-large', `${label} exceeds the size limit.`);
  const contents = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(contents);
  } catch {
    throw new PrivateJsonError('invalid-json', `${label} contains invalid JSON.`);
  }
}

/**
 * A profile file that may not exist yet: undefined when it is absent. Every
 * other problem throws, so nothing is mistaken for an empty file and then
 * overwritten.
 */
export function readOptionalPrivateJson(file: string, label: string, maxBytes: number): unknown {
  try {
    return readJsonFile(file, label, maxBytes);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/**
 * Replaces a profile file in one step: the content goes to a temporary file
 * beside it, renamed over it once complete. A failure, a full disk or a crash
 * halfway leaves the previous file as it was, never a truncated one.
 */
export function writePrivateJsonAtomic(file: string, value: unknown): void {
  const pending = path.join(path.dirname(file), `.${path.basename(file, '.json')}-${randomUUID()}.pending`);
  try {
    writePrivateJson(pending, value);
    fs.renameSync(pending, file);
  } catch (error) {
    try {
      fs.rmSync(pending, { force: true });
    } catch {
      throw new LeftoverFileError(pending);
    }
    throw error;
  }
}
