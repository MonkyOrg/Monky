import type { DmFileStore } from '@monky/dm';
import { readRecordsWithPrefix, writeRecords } from './webStorage';

const SAVE_DELAY_MS = 50;

/**
 * The encrypted DM store of one identity in the browser (#858). The engine
 * reads and writes synchronously, so the documents live in memory, loaded
 * from IndexedDB when DMs open; every change is saved back right after, in
 * one transaction per batch, and once more when the tab is hidden.
 *
 * What is stored is already sealed by the engine (AES-GCM with the identity's
 * storage key), exactly as the desktop writes its files.
 */
export class WebDmStore implements DmFileStore {
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly onHidden = (): void => { if (document.visibilityState === 'hidden') void this.save(); };
  private disposed = false;

  private constructor(private readonly prefix: string, private readonly documents: Map<string, Uint8Array>) {
    document.addEventListener('visibilitychange', this.onHidden);
    window.addEventListener('pagehide', this.onHidden);
  }

  /** Loads every document of the store at `prefix` (e.g. `dm/<identity>/`). */
  static async open(prefix: string): Promise<WebDmStore> {
    const documents = new Map<string, Uint8Array>();
    for (const [key, value] of await readRecordsWithPrefix(prefix)) {
      if (value instanceof Uint8Array) documents.set(key.slice(prefix.length), value);
    }
    return new WebDmStore(prefix, documents);
  }

  /** Stops saving; what is still pending is saved first. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onHidden);
    window.removeEventListener('pagehide', this.onHidden);
    await this.save();
  }

  /** Forgets the store without saving (logout deletes it). */
  discard(): void {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty.clear();
    this.removed.clear();
    document.removeEventListener('visibilitychange', this.onHidden);
    window.removeEventListener('pagehide', this.onHidden);
  }

  private changed(name: string): void {
    this.removed.delete(name);
    this.dirty.add(name);
    this.scheduleSave();
  }

  private deleted(name: string): void {
    this.dirty.delete(name);
    this.removed.add(name);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.disposed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DELAY_MS);
  }

  /** Saves what changed since the last save; a batch that fails is tried again with the next one. */
  save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saving = this.saving.then(async () => {
      if (this.dirty.size === 0 && this.removed.size === 0) return;
      const writes = new Map<string, Uint8Array>();
      for (const name of this.dirty) {
        const data = this.documents.get(name);
        if (data) writes.set(`${this.prefix}${name}`, data);
      }
      const deletes = [...this.removed].map(name => `${this.prefix}${name}`);
      const batch = { dirty: [...this.dirty], removed: [...this.removed] };
      this.dirty.clear();
      this.removed.clear();
      try {
        await writeRecords(writes, deletes);
      } catch (error: unknown) {
        console.error('[DM] Could not save direct messages in this browser; trying again.', error);
        for (const name of batch.dirty) if (!this.removed.has(name)) this.dirty.add(name);
        for (const name of batch.removed) if (!this.dirty.has(name)) this.removed.add(name);
        this.scheduleSave();
      }
    });
    return this.saving;
  }

  read(name: string): Uint8Array | null {
    return this.documents.get(name)?.slice() ?? null;
  }

  exists(name: string): boolean {
    return this.documents.has(name);
  }

  write(name: string, data: Uint8Array | Iterable<Uint8Array>): void {
    // Gathered first: a source that throws halfway leaves the old document in place.
    const pieces = data instanceof Uint8Array ? [data] : [...data];
    const joined = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.length;
    }
    this.documents.set(name, joined);
    this.changed(name);
  }

  remove(name: string): void {
    if (!this.documents.delete(name)) return;
    this.deleted(name);
  }

  rename(name: string, aside: string): void {
    const data = this.documents.get(name);
    if (!data) return;
    this.documents.set(aside, data);
    this.documents.delete(name);
    this.changed(aside);
    this.deleted(name);
  }

  list(folder: string): string[] {
    const prefix = `${folder}/`;
    const names = new Set<string>();
    for (const name of this.documents.keys()) {
      if (name.startsWith(prefix)) names.add(name.slice(prefix.length).split('/')[0]);
    }
    return [...names];
  }

  append(name: string, data: Uint8Array): void {
    const current = this.documents.get(name) ?? new Uint8Array(0);
    const joined = new Uint8Array(current.length + data.length);
    joined.set(current);
    joined.set(data, current.length);
    this.documents.set(name, joined);
    this.changed(name);
  }

  size(name: string): number | null {
    return this.documents.get(name)?.length ?? null;
  }

  truncate(name: string, length: number): void {
    const current = this.documents.get(name);
    if (!current || current.length <= length) return;
    this.documents.set(name, current.slice(0, length));
    this.changed(name);
  }

  openReader(name: string): { read(offset: number, length: number): Uint8Array; close(): void } | null {
    const data = this.documents.get(name);
    if (!data) return null;
    return { read: (offset, length) => data.slice(offset, offset + length), close: () => {} };
  }
}
