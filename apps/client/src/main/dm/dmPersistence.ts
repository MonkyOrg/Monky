import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileErrorCode, renameFileSync, writeFileAtomicSync } from '../atomicFile';
import { openAtRest, sealAtRest, sealAtRestStream } from './dmCrypto';

/**
 * Encrypted local storage for friends and DMs (#743).
 *
 * Every file is sealed with the identity-derived storage key (AES-256-GCM) and
 * written atomically (temp + fsync + rename). JSON documents are written with a
 * short debounce so a burst of messages costs one write; a write that fails
 * stays pending and is tried again with backoff, never dropped. Attachments
 * are stored as separate sealed blobs; partial downloads are appended as
 * individually sealed chunks so nothing touches the disk in clear text.
 */

const WRITE_DEBOUNCE_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
/** A sealed chunk: one plaintext chunk plus the sealing overhead, with room to spare. */
const MAX_SEALED_PART_BYTES = 1024 * 1024;

interface PendingWrite {
  produce: () => unknown;
  timer: NodeJS.Timeout | null;
  failures: number;
}

export class DmPersistence {
  private readonly pendingWrites = new Map<string, PendingWrite>();
  /** Told which documents reached the disk after every write pass; lets acks wait for the data they confirm. */
  onWritten: ((written: ReadonlySet<string>) => void) | null = null;

  constructor(
    readonly dir: string,
    private readonly key: Buffer
  ) {
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  }

  static peerFileName(peer: string): string {
    return `conv-${createHash('sha256').update(peer, 'utf8').digest('hex').slice(0, 40)}.mkdm`;
  }

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  /**
   * Reads a sealed JSON document. A missing file reads as `null`. A file that
   * exists but does not open or does not pass `accept` (damaged, cut short) is
   * renamed to `<name>.corrupt-<time>` and also reads as `null`, so the next
   * save starts over without destroying those bytes. Any other read error (a
   * file held by another program, no permission) throws and leaves everything
   * in place, for the caller to fail now and try again later.
   */
  readJson<T>(name: string, accept: (value: unknown) => value is T): T | null {
    let data: Buffer;
    try {
      data = fs.readFileSync(this.filePath(name));
    } catch (error) {
      if (fileErrorCode(error) === 'ENOENT') return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(openAtRest(this.key, data, name).toString('utf8'));
    } catch {
      value = undefined;
    }
    if (value !== undefined && accept(value)) return value;
    this.setAside(name);
    return null;
  }

  /** Moves an unreadable document out of the way; if even that fails, it throws and the document stays untouched. */
  private setAside(name: string): void {
    const aside = `${this.filePath(name)}.corrupt-${Date.now()}`;
    renameFileSync(this.filePath(name), aside);
    console.error(`[DM] ${name} could not be read; it was kept as ${path.basename(aside)} and starts over.`);
  }

  /** Writes now, cancelling any debounced write of the same document. Throws when the disk refuses it. */
  writeJsonNow(name: string, value: unknown): void {
    const pending = this.pendingWrites.get(name);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pendingWrites.delete(name);
    this.atomicWrite(name, sealAtRest(this.key, Buffer.from(JSON.stringify(value), 'utf8'), name));
    this.onWritten?.(new Set([name]));
  }

  /** Schedules a write; `produce` is evaluated at write time so the latest state wins. */
  writeJsonSoon(name: string, produce: () => unknown): void {
    const pending = this.pendingWrites.get(name);
    if (pending) {
      pending.produce = produce;
      return;
    }
    const entry: PendingWrite = { produce, timer: null, failures: 0 };
    this.pendingWrites.set(name, entry);
    this.schedule(name, entry, WRITE_DEBOUNCE_MS);
  }

  /** Documents changed in memory that have not reached the disk yet. */
  pendingNames(): Set<string> {
    return new Set(this.pendingWrites.keys());
  }

  private schedule(name: string, entry: PendingWrite, delayMs: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.writePass([name]);
    }, delayMs);
    entry.timer.unref?.();
  }

  /** Writes the given pending documents; the ones that fail stay pending and are tried again later. */
  private writePass(names: Iterable<string>): void {
    const written = new Set<string>();
    for (const name of names) {
      const entry = this.pendingWrites.get(name);
      if (!entry) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      try {
        this.atomicWrite(name, sealAtRest(this.key, Buffer.from(JSON.stringify(entry.produce()), 'utf8'), name));
      } catch (error) {
        entry.failures += 1;
        const delayMs = Math.min(WRITE_DEBOUNCE_MS * 2 ** entry.failures, MAX_RETRY_DELAY_MS);
        console.error(`[DM] Could not save ${name}; trying again in ${delayMs} ms.`, error);
        this.schedule(name, entry, delayMs);
        continue;
      }
      this.pendingWrites.delete(name);
      written.add(name);
    }
    if (written.size > 0) this.onWritten?.(written);
  }

  /** Writes everything pending now. Whatever the disk refuses stays pending for the next try. */
  flush(): void {
    this.writePass([...this.pendingWrites.keys()]);
  }

  /** Drops pending writes without touching the disk (logout wipes the folder). */
  discardPending(): void {
    for (const pending of this.pendingWrites.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingWrites.clear();
  }

  private atomicWrite(name: string, data: Uint8Array | Iterable<Uint8Array>): void {
    writeFileAtomicSync(this.filePath(name), data);
  }

  private attachmentName(fileId: string): string {
    return path.join('files', `${fileId}.mkdm`);
  }

  private partName(fileId: string): string {
    return path.join('files', `${fileId}.part`);
  }

  hasAttachment(fileId: string): boolean {
    return fs.existsSync(this.filePath(this.attachmentName(fileId)));
  }

  writeAttachment(fileId: string, data: Buffer): void {
    this.atomicWrite(this.attachmentName(fileId), sealAtRestStream(this.key, [data], `file:${fileId}`));
  }

  readAttachment(fileId: string): Buffer | null {
    const filePath = this.filePath(this.attachmentName(fileId));
    if (!fs.existsSync(filePath)) return null;
    return openAtRest(this.key, fs.readFileSync(filePath), `file:${fileId}`);
  }

  deleteAttachment(fileId: string): void {
    for (const name of [this.attachmentName(fileId), this.partName(fileId)]) {
      try {
        fs.rmSync(this.filePath(name), { force: true });
      } catch {
        // Best effort.
      }
    }
  }

  /**
   * Appends one sealed chunk to a partial download. When the disk refuses it
   * halfway (full disk), the torn bytes are cut off again so the next chunk
   * does not land after garbage; {@link repairPart} covers a crash instead.
   */
  appendPart(fileId: string, chunkIndex: number, chunk: Buffer): void {
    const sealed = sealAtRest(this.key, chunk, `part:${fileId}:${chunkIndex}`);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(sealed.length, 0);
    const filePath = this.filePath(this.partName(fileId));
    let sizeBefore = 0;
    try {
      sizeBefore = fs.statSync(filePath).size;
    } catch (error) {
      if (fileErrorCode(error) !== 'ENOENT') throw error;
    }
    try {
      fs.appendFileSync(filePath, Buffer.concat([header, sealed]));
    } catch (error) {
      try {
        fs.truncateSync(filePath, sizeBefore);
      } catch {
        // repairPart() drops the torn tail before the download resumes.
      }
      throw error;
    }
  }

  /**
   * Keeps the intact prefix of a partial download and cuts off the rest: a
   * record torn by a crash or a full disk, or one that no longer opens.
   * Returns how many chunks survive.
   */
  repairPart(fileId: string): number {
    let count = 0;
    let intact = 0;
    for (const record of this.partRecords(fileId)) {
      count += 1;
      intact = record.end;
    }
    const filePath = this.filePath(this.partName(fileId));
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch (error) {
      if (fileErrorCode(error) === 'ENOENT') return 0;
      throw error;
    }
    if (intact < size) fs.truncateSync(filePath, intact);
    return count;
  }

  resetPart(fileId: string): void {
    try {
      fs.rmSync(this.filePath(this.partName(fileId)), { force: true });
    } catch {
      // Best effort.
    }
  }

  /**
   * Turns a finished partial download into the attachment with one chunk in
   * memory at a time: every chunk is opened in order, hashed and sealed again
   * into the attachment file, which is published only when the size and the
   * SHA-256 match. Returns false, writing nothing, when they do not.
   */
  completePart(fileId: string, size: number, sha256: string): boolean {
    const records = this.partRecords(fileId);
    function* verified(): Generator<Buffer> {
      const hash = createHash('sha256');
      let total = 0;
      for (const { chunk } of records) {
        total += chunk.length;
        if (total > size) throw new PartMismatch();
        hash.update(chunk);
        yield chunk;
      }
      if (total !== size || hash.digest('hex') !== sha256) throw new PartMismatch();
    }
    try {
      this.atomicWrite(this.attachmentName(fileId), sealAtRestStream(this.key, verified(), `file:${fileId}`));
    } catch (error) {
      if (error instanceof PartMismatch) return false;
      throw error;
    }
    return true;
  }

  /**
   * The intact records of a partial download, in order, read one at a time:
   * each opened chunk and the offset where its record ends. It stops at the
   * first record that is torn (a crash, a full disk) or does not open.
   */
  private *partRecords(fileId: string): Generator<{ chunk: Buffer; end: number }> {
    let descriptor: number;
    try {
      descriptor = fs.openSync(this.filePath(this.partName(fileId)), 'r');
    } catch (error) {
      if (fileErrorCode(error) === 'ENOENT') return;
      throw error;
    }
    try {
      const header = Buffer.alloc(4);
      let position = 0;
      for (let index = 0; ; index += 1) {
        if (fs.readSync(descriptor, header, 0, 4, position) < 4) return;
        const length = header.readUInt32BE(0);
        if (length > MAX_SEALED_PART_BYTES) return;
        const sealed = Buffer.allocUnsafe(length);
        if (fs.readSync(descriptor, sealed, 0, length, position + 4) < length) return;
        let chunk: Buffer;
        try {
          chunk = openAtRest(this.key, sealed, `part:${fileId}:${index}`);
        } catch {
          return;
        }
        position += 4 + length;
        yield { chunk, end: position };
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

/** The bytes of a finished download are not the file its message announced. */
class PartMismatch extends Error {}
