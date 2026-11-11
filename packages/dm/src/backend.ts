/**
 * What the DM engine needs from the platform (#858). Everything is
 * synchronous, so the same engine runs on the desktop (Node crypto and files)
 * and in the browser (pure JS crypto and an in-memory copy of IndexedDB).
 */

/** Incremental SHA-256, for files hashed one chunk at a time. */
export interface DmHash {
  update(data: Uint8Array): DmHash;
  digest(): Uint8Array;
}

/**
 * AES-256-GCM sealing fed one piece at a time. Everything returned, in order,
 * is the ciphertext followed by the 16-byte tag; `final()` returns whatever
 * is left, the tag last.
 */
export interface DmGcmSealer {
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
}

export interface DmCryptoBackend {
  randomBytes(length: number): Uint8Array;
  sha256(): DmHash;
  /** HKDF-SHA256 with a 32-byte output. */
  hkdf32(input: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array;
  /** Raw 32-byte Ed25519 public key of a 32-byte seed. */
  ed25519PublicKey(seed: Uint8Array): Uint8Array;
  ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array;
  /** False for any key or signature that does not verify, never throws. */
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
  /** Raw 32-byte X25519 public key of a 32-byte private key. */
  x25519PublicKey(privateKey: Uint8Array): Uint8Array;
  x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** Ciphertext followed by the 16-byte tag. */
  aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  aesGcmSealer(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array): DmGcmSealer;
  /** Opens ciphertext + tag; throws when the tag does not match. */
  aesGcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array;
}

let installed: DmCryptoBackend | null = null;

/** Called once by the host before any DM code runs. */
export function installDmCrypto(backend: DmCryptoBackend): void {
  installed = backend;
}

export function dmCrypto(): DmCryptoBackend {
  if (!installed) throw new Error('The DM crypto backend was not installed.');
  return installed;
}

/**
 * Runs `task` once the current task is over: `setImmediate` where the host has
 * it (Node, Electron's main process), else a zero timer. Returns a cancel.
 */
export function afterCurrentTask(task: () => void): () => void {
  const immediate: unknown = Reflect.get(globalThis, 'setImmediate');
  const cancelImmediate: unknown = Reflect.get(globalThis, 'clearImmediate');
  if (typeof immediate === 'function' && typeof cancelImmediate === 'function') {
    const handle: unknown = immediate(task);
    if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') handle.unref();
    return () => cancelImmediate(handle);
  }
  const timer = setTimeout(task, 0);
  return () => clearTimeout(timer);
}

/**
 * The encrypted store as named documents in folders (`/` separated). Writes
 * are atomic per document. The desktop writes files; the browser keeps an
 * in-memory copy and saves it to IndexedDB in the background.
 */
export interface DmFileStore {
  /** Bytes of a document, or null when it does not exist. */
  read(name: string): Uint8Array | null;
  exists(name: string): boolean;
  /** Writes the whole document atomically: either the new bytes or the old ones remain. */
  write(name: string, data: Uint8Array | Iterable<Uint8Array>): void;
  /** Deletes a document; one already gone is fine. */
  remove(name: string): void;
  /** Renames a document out of the way (`name` → `aside`). */
  rename(name: string, aside: string): void;
  /** Names directly inside a folder; an empty list when it does not exist. */
  list(folder: string): string[];
  /** Appends to a document, creating it. A failed append leaves the document as it was. */
  append(name: string, data: Uint8Array): void;
  /** Size in bytes, or null when the document does not exist. */
  size(name: string): number | null;
  /** Cuts a document down to `length` bytes. */
  truncate(name: string, length: number): void;
  /** Opens a document for reading pieces of it, or null when it does not exist. Close it when done. */
  openReader(name: string): DmFileReader | null;
}

export interface DmFileReader {
  /** Up to `length` bytes from `offset`; fewer at the end. */
  read(offset: number, length: number): Uint8Array;
  close(): void;
}

/** Guest conversations use the same encrypted engine, without a durable platform store. */
export class MemoryDmFileStore implements DmFileStore {
  private readonly documents = new Map<string, Uint8Array>();
  read(name: string): Uint8Array | null { return this.documents.get(name)?.slice() ?? null; }
  exists(name: string): boolean { return this.documents.has(name); }
  write(name: string, data: Uint8Array | Iterable<Uint8Array>): void {
    const pieces = data instanceof Uint8Array ? [data] : [...data];
    const joined = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) { joined.set(piece, offset); offset += piece.length; }
    this.documents.set(name, joined);
  }
  remove(name: string): void { this.documents.delete(name); }
  rename(name: string, aside: string): void {
    const data = this.documents.get(name);
    if (data) { this.documents.set(aside, data); this.documents.delete(name); }
  }
  list(folder: string): string[] {
    const prefix = `${folder}/`;
    return [...new Set([...this.documents.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length).split('/')[0]))];
  }
  append(name: string, data: Uint8Array): void { this.write(name, [this.documents.get(name) ?? new Uint8Array(), data]); }
  size(name: string): number | null { return this.documents.get(name)?.length ?? null; }
  truncate(name: string, length: number): void {
    const data = this.documents.get(name);
    if (data && data.length > length) this.documents.set(name, data.slice(0, length));
  }
  openReader(name: string): DmFileReader | null {
    const data = this.documents.get(name);
    return data ? { read: (offset, length) => data.slice(offset, offset + length), close: () => {} } : null;
  }
  save(): Promise<void> { return Promise.resolve(); }
  dispose(): Promise<void> { this.discard(); return Promise.resolve(); }
  discard(): void { this.documents.clear(); }
}
