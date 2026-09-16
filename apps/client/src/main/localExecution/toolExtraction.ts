import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { terminate } from '@monky/bot-sdk/dist/localRuntime';
import { LocalExecutionError, localFailure } from './errors';
import { localToolStorageError, localToolUnsafeFileError, missingLocalToolFile } from './localToolsStorage';

export type LocalToolArchive = 'zip' | 'tar.gz' | 'tar.xz';

export interface ToolExtractionSupport {
  tar: string;
  gzip: string | null;
  xz: string | null;
}

const EXTRACTION_TIMEOUT = 120_000;
const DIAGNOSTIC_LIMIT = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function systemExecutable(filename: string): Promise<string | null> {
  try {
    const canonical = await fs.realpath(filename);
    if (path.dirname(canonical).toLowerCase() !== path.dirname(filename).toLowerCase()) return null;
    const stat = await fs.stat(canonical);
    if (!stat.isFile() || process.platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) return null;
    await fs.access(canonical, constants.X_OK);
    return canonical;
  } catch (error) {
    if (missingLocalToolFile(error)) return null;
    throw new LocalExecutionError('storage_failed', { cause: error });
  }
}

export async function localToolExtractionSupport(
  platform: NodeJS.Platform, arch: string,
): Promise<ToolExtractionSupport | null> {
  if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) return null;
  if (platform === 'linux') {
    const report: unknown = process.report.getReport();
    if (!record(report) || !record(report.header) || typeof report.header.glibcVersionRuntime !== 'string') return null;
    const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(report.header.glibcVersionRuntime);
    if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 28) return null;
  }
  const windows = process.env.SystemRoot;
  if (platform === 'win32' && (!windows || !path.isAbsolute(windows))) return null;
  const tar = await systemExecutable(platform === 'win32'
    ? path.join(windows ?? '', 'System32', 'tar.exe') : '/usr/bin/tar');
  if (!tar) return null;
  const gzip = platform === 'linux' ? await systemExecutable('/usr/bin/gzip') : null;
  const xz = platform === 'linux' ? await systemExecutable('/usr/bin/xz') : null;
  if (platform === 'linux' && (!gzip || !xz)) return null;
  return { tar, gzip, xz };
}

function extractionEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['TAR_OPTIONS', 'GZIP', 'XZ_OPT', 'XZ_DEFAULTS']) delete env[key];
  return env;
}

function waitForExtraction(closed: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    closed.then(
      () => { signal.removeEventListener('abort', abort); resolve(); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

export async function checkToolExtraction(support: ToolExtractionSupport, signal: AbortSignal): Promise<'gnu' | 'bsd'> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const child = spawn(support.tar, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
    env: extractionEnvironment(),
  });
  let output = '';
  const timer = setTimeout(() => controller.abort(new LocalExecutionError('timeout')), 5000);
  const capture = (chunk: Buffer): void => {
    if (Buffer.byteLength(output) + chunk.length > DIAGNOSTIC_LIMIT) {
      controller.abort(new LocalExecutionError('unsupported_platform'));
    } else output += chunk.toString('utf8');
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new LocalExecutionError('unsupported_platform')));
  });
  try {
    await waitForExtraction(closed, controller.signal);
    controller.signal.throwIfAborted();
    if (output.includes('bsdtar')) return 'bsd';
    if (output.includes('GNU tar') && support.gzip && support.xz) return 'gnu';
    throw new LocalExecutionError('unsupported_platform');
  } catch (error) {
    throw new LocalExecutionError(localFailure(error, 'unsupported_platform', controller.signal), { cause: error });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    child.stdout.destroy();
    child.stderr.destroy();
    try {
      await terminate(child);
    } finally {
      await Promise.allSettled([closed]);
    }
  }
}

export async function extractLocalTool(options: {
  support: ToolExtractionSupport;
  implementation: 'gnu' | 'bsd';
  archive: string;
  format: LocalToolArchive;
  member: string;
  destination: string;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<void> {
  const { support, archive, format, member, destination, maxBytes, signal } = options;
  if (!path.isAbsolute(archive) || !path.isAbsolute(destination) ||
      !/^[a-zA-Z0-9._-]+\/bin\/(?:node|ffmpeg(?:\.exe)?)$/.test(member) ||
      member.split('/').some((part) => part === '..') ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new LocalExecutionError('invalid_request');
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new LocalExecutionError('timeout')), EXTRACTION_TIMEOUT);
  const args = ['-xOf', archive];
  if (options.implementation === 'gnu') {
    const compressor = format === 'tar.xz' ? support.xz : format === 'tar.gz' ? support.gzip : null;
    if (!compressor) {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      throw new LocalExecutionError('unsupported_platform');
    }
    // GNU tar must not resolve its decompressor through the inherited PATH.
    args.push(`--use-compress-program=${compressor}`);
  }
  args.push('--', member);
  const child = spawn(support.tar, args, {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
    env: extractionEnvironment(),
  });
  let diagnosticBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > DIAGNOSTIC_LIMIT) controller.abort(new LocalExecutionError('tool_install_failed'));
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new LocalExecutionError('tool_install_failed')));
  });
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new LocalExecutionError('integrity_failed') : null, chunk);
    },
  });
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const extracted = pipeline(child.stdout, limit, output, { signal: controller.signal });
  try {
    await Promise.all([closed, extracted]);
    controller.signal.throwIfAborted();
    if (!bytes) throw new LocalExecutionError('integrity_failed');
    const handle = await fs.open(destination, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (localToolStorageError(error)) throw new LocalExecutionError('storage_failed', { cause: error });
    if (localToolUnsafeFileError(error)) throw new LocalExecutionError('integrity_failed', { cause: error });
    throw new LocalExecutionError(localFailure(error, 'tool_install_failed', controller.signal), { cause: error });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    child.stdout.destroy();
    child.stderr.destroy();
    output.destroy();
    try {
      await terminate(child);
    } finally {
      await Promise.allSettled([closed, extracted]);
    }
  }
}
