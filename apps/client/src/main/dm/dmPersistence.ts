import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { openAtRest, sealAtRest } from './dmCrypto';

/**
 * Encrypted local storage for friends and DMs (#743).
 *
 * Every file is sealed with the identity-derived storage key (AES-256-GCM) and
 * written atomically (temp + rename). JSON documents are written with a short
 * debounce so a burst of messages costs one write. Attachments are stored as
 * separate sealed blobs; partial downloads are appended as individually sealed
 * chunks so nothing touches the disk in clear text.
 */

const WRITE_DEBOUNCE_MS = 250;

export class DmPersistence {
  private readonly pendingWrites = new Map<string, { timer: NodeJS.Timeout; produce: () => unknown }>();

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

  readJson<T>(name: string): T | null {
    const filePath = this.filePath(name);
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return JSON.parse(openAtRest(this.key, data, name).toString('utf8')) as T;
  }

  /** Writes now, cancelling any debounced write of the same document. */
  writeJsonNow(name: string, value: unknown): void {
    const pending = this.pendingWrites.get(name);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingWrites.delete(name);
    }
    this.atomicWrite(name, sealAtRest(this.key, Buffer.from(JSON.stringify(value), 'utf8'), name));
  }

  /** Schedules a write; `produce` is evaluated at write time so the latest state wins. */
  writeJsonSoon(name: string, produce: () => unknown): void {
    const pending = this.pendingWrites.get(name);
    if (pending) {
      pending.produce = produce;
      return;
    }
    const entry = {
      produce,
      timer: setTimeout(() => {
        this.pendingWrites.delete(name);
        try {
          this.atomicWrite(name, sealAtRest(this.key, Buffer.from(JSON.stringify(entry.produce()), 'utf8'), name));
        } catch (error) {
          console.error('[DM] Falha ao salvar', name, error);
        }
      }, WRITE_DEBOUNCE_MS),
    };
    entry.timer.unref?.();
    this.pendingWrites.set(name, entry);
  }

  flush(): void {
    for (const [name, pending] of [...this.pendingWrites.entries()]) {
      clearTimeout(pending.timer);
      this.pendingWrites.delete(name);
      try {
        this.atomicWrite(name, sealAtRest(this.key, Buffer.from(JSON.stringify(pending.produce()), 'utf8'), name));
      } catch (error) {
        console.error('[DM] Falha ao salvar', name, error);
      }
    }
  }

  /** Drops pending writes without touching the disk (logout wipes the folder). */
  discardPending(): void {
    for (const pending of this.pendingWrites.values()) clearTimeout(pending.timer);
    this.pendingWrites.clear();
  }

  private atomicWrite(name: string, data: Buffer): void {
    const target = this.filePath(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, target);
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
    const name = this.attachmentName(fileId);
    this.atomicWrite(name, sealAtRest(this.key, data, `file:${fileId}`));
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

  /** Appends one sealed chunk to a partial download. */
  appendPart(fileId: string, chunkIndex: number, chunk: Buffer): void {
    const sealed = sealAtRest(this.key, chunk, `part:${fileId}:${chunkIndex}`);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(sealed.length, 0);
    fs.appendFileSync(this.filePath(this.partName(fileId)), Buffer.concat([header, sealed]));
  }

  resetPart(fileId: string): void {
    try {
      fs.rmSync(this.filePath(this.partName(fileId)), { force: true });
    } catch {
      // Best effort.
    }
  }

  /** Reads every sealed chunk of a partial download, in order. */
  readPart(fileId: string): Buffer {
    const filePath = this.filePath(this.partName(fileId));
    if (!fs.existsSync(filePath)) return Buffer.alloc(0);
    const raw = fs.readFileSync(filePath);
    const chunks: Buffer[] = [];
    let offset = 0;
    let index = 0;
    while (offset + 4 <= raw.length) {
      const length = raw.readUInt32BE(offset);
      offset += 4;
      if (offset + length > raw.length) break;
      chunks.push(openAtRest(this.key, raw.subarray(offset, offset + length), `part:${fileId}:${index}`));
      offset += length;
      index += 1;
    }
    return Buffer.concat(chunks);
  }

  partChunkCount(fileId: string): number {
    const filePath = this.filePath(this.partName(fileId));
    if (!fs.existsSync(filePath)) return 0;
    const raw = fs.readFileSync(filePath);
    let offset = 0;
    let count = 0;
    while (offset + 4 <= raw.length) {
      const length = raw.readUInt32BE(offset);
      if (offset + 4 + length > raw.length) break;
      offset += 4 + length;
      count += 1;
    }
    return count;
  }
}
