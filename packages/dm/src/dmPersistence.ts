import { dmCrypto, type DmFileStore } from './backend';
import { concatBytes, fromUtf8, readUint32BE, toHex, utf8, writeUint32BE } from './bytes';
import { openAtRest, sealAtRest, sealAtRestStream, sha256Hex } from './dmCrypto';

/**
 * Encrypted local storage for friends and DMs (#743).
 *
 * Every document is sealed with the identity-derived storage key (AES-256-GCM)
 * and written atomically by the platform's store (on the desktop, temp + fsync
 * + rename). JSON documents are written with a short debounce so a burst of
 * messages costs one write; a write that fails stays pending and is tried
 * again with backoff, never dropped. Conversations live in one folder each,
 * split by month, so a change rewrites only its month (#823). Attachments are
 * stored as separate sealed blobs; partial downloads are appended as
 * individually sealed chunks so nothing is stored in clear text.
 */

const WRITE_DEBOUNCE_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
/** A sealed chunk: one plaintext chunk plus the sealing overhead, with room to spare. */
const MAX_SEALED_PART_BYTES = 1024 * 1024;

interface PendingWrite {
  produce: () => unknown;
  timer: DmTimer | null;
  failures: number;
}

export class DmPersistence {
  private readonly pendingWrites = new Map<string, PendingWrite>();
  /** Told which documents were stored after every write pass; lets acks wait for the data they confirm. */
  onWritten: ((written: ReadonlySet<string>) => void) | null = null;

  constructor(
    private readonly store: DmFileStore,
    private readonly key: Uint8Array
  ) {}

  /** Folder of a conversation (#823): one sealed file per month and its `index.mkdm`. */
  static conversationDir(peer: string): string {
    return `conv-${sha256Hex(peer).slice(0, 40)}`;
  }

  /** The single file a conversation lived in before #823; only read to migrate it. */
  static peerFileName(peer: string): string {
    return `${DmPersistence.conversationDir(peer)}.mkdm`;
  }

  static segmentName(peer: string, month: number): string {
    return `${DmPersistence.conversationDir(peer)}/${month}.mkdm`;
  }

  static headName(peer: string): string {
    return `${DmPersistence.conversationDir(peer)}/index.mkdm`;
  }

  /** The months (`yyyymm`) a conversation has a file for. */
  listSegments(peer: string): number[] {
    return this.store.list(DmPersistence.conversationDir(peer)).flatMap((name) => {
      const match = /^(\d{6})\.mkdm$/.exec(name);
      return match ? [Number(match[1])] : [];
    });
  }

  exists(name: string): boolean {
    return this.store.exists(name);
  }

  /** Deletes a document; one that is already gone is fine. Throws when the store refuses. */
  remove(name: string): void {
    this.store.remove(name);
  }

  /**
   * Reads a sealed JSON document. A missing document reads as `null`. One
   * that exists but does not open or does not pass `accept` (damaged, cut
   * short) is renamed to `<name>.corrupt-<time>` and also reads as `null`, so
   * the next save starts over without destroying those bytes. Any other read
   * error (a file held by another program, no permission) throws and leaves
   * everything in place, for the caller to fail now and try again later.
   */
  readJson<T>(name: string, accept: (value: unknown) => value is T): T | null {
    const data = this.store.read(name);
    if (data === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(fromUtf8(openAtRest(this.key, data, name)));
    } catch {
      value = undefined;
    }
    if (value !== undefined && accept(value)) return value;
    this.setAside(name);
    return null;
  }

  /** Moves an unreadable document out of the way; if even that fails, it throws and the document stays untouched. */
  private setAside(name: string): void {
    const aside = `${name}.corrupt-${Date.now()}`;
    this.store.rename(name, aside);
    console.error(`[DM] ${name} could not be read; it was kept as ${aside} and starts over.`);
  }

  /** Writes now, cancelling any debounced write of the same document. Throws when the store refuses it. */
  writeJsonNow(name: string, value: unknown): void {
    const pending = this.pendingWrites.get(name);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pendingWrites.delete(name);
    this.store.write(name, sealAtRest(this.key, utf8(JSON.stringify(value)), name));
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

  /** Documents changed in memory that have not been stored yet. */
  pendingNames(): Set<string> {
    return new Set(this.pendingWrites.keys());
  }

  hasPending(name: string): boolean {
    return this.pendingWrites.has(name);
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
        this.store.write(name, sealAtRest(this.key, utf8(JSON.stringify(entry.produce())), name));
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

  /** Writes everything pending now. Whatever the store refuses stays pending for the next try. */
  flush(): void {
    this.writePass([...this.pendingWrites.keys()]);
  }

  /** Drops pending writes without touching the store (logout wipes it). */
  discardPending(): void {
    for (const pending of this.pendingWrites.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingWrites.clear();
  }

  private attachmentName(fileId: string): string {
    return `files/${fileId}.mkdm`;
  }

  private partName(fileId: string): string {
    return `files/${fileId}.part`;
  }

  hasAttachment(fileId: string): boolean {
    return this.store.exists(this.attachmentName(fileId));
  }

  writeAttachment(fileId: string, data: Uint8Array): void {
    this.store.write(this.attachmentName(fileId), sealAtRestStream(this.key, [data], `file:${fileId}`));
  }

  readAttachment(fileId: string): Uint8Array | null {
    const data = this.store.read(this.attachmentName(fileId));
    return data === null ? null : openAtRest(this.key, data, `file:${fileId}`);
  }

  deleteAttachment(fileId: string): void {
    for (const name of [this.attachmentName(fileId), this.partName(fileId)]) {
      try {
        this.store.remove(name);
      } catch {
        // Best effort.
      }
    }
  }

  /**
   * Appends one sealed chunk to a partial download. The store leaves the
   * document as it was when the append fails (full disk); {@link repairPart}
   * covers a crash instead.
   */
  appendPart(fileId: string, chunkIndex: number, chunk: Uint8Array): void {
    const sealed = sealAtRest(this.key, chunk, `part:${fileId}:${chunkIndex}`);
    this.store.append(this.partName(fileId), concatBytes(writeUint32BE(sealed.length), sealed));
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
    const size = this.store.size(this.partName(fileId));
    if (size === null) return 0;
    if (intact < size) this.store.truncate(this.partName(fileId), intact);
    return count;
  }

  resetPart(fileId: string): void {
    try {
      this.store.remove(this.partName(fileId));
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
    function* verified(): Generator<Uint8Array> {
      const hash = dmCrypto().sha256();
      let total = 0;
      for (const { chunk } of records) {
        total += chunk.length;
        if (total > size) throw new PartMismatch();
        hash.update(chunk);
        yield chunk;
      }
      if (total !== size || toHex(hash.digest()) !== sha256) throw new PartMismatch();
    }
    try {
      this.store.write(this.attachmentName(fileId), sealAtRestStream(this.key, verified(), `file:${fileId}`));
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
  private *partRecords(fileId: string): Generator<{ chunk: Uint8Array; end: number }> {
    const reader = this.store.openReader(this.partName(fileId));
    if (!reader) return;
    try {
      let position = 0;
      for (let index = 0; ; index += 1) {
        const header = reader.read(position, 4);
        if (header.length < 4) return;
        const length = readUint32BE(header);
        if (length > MAX_SEALED_PART_BYTES) return;
        const sealed = reader.read(position + 4, length);
        if (sealed.length < length) return;
        let chunk: Uint8Array;
        try {
          chunk = openAtRest(this.key, sealed, `part:${fileId}:${index}`);
        } catch {
          return;
        }
        position += 4 + length;
        yield { chunk, end: position };
      }
    } finally {
      reader.close();
    }
  }
}

/** The bytes of a finished download are not the file its message announced. */
class PartMismatch extends Error {}
