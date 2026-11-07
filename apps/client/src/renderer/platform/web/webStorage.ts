/**
 * Key-value records of the web version in IndexedDB: what the desktop keeps in
 * files of its profile folder. Values are structured clones, so a CryptoKey is
 * stored as is (and a non-extractable one stays non-extractable).
 */
const DATABASE_NAME = 'monky';
const DATABASE_VERSION = 1;
const STORE_NAME = 'records';

let opening: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const database = await openDatabase();
  return database.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

export async function readRecord(key: string): Promise<unknown> {
  return requestResult((await store('readonly')).get(key));
}

export async function writeRecord(key: string, value: unknown): Promise<void> {
  await requestResult((await store('readwrite')).put(value, key));
}

export async function deleteRecord(key: string): Promise<void> {
  await requestResult((await store('readwrite')).delete(key));
}

export async function listRecordKeys(): Promise<string[]> {
  const keys = await requestResult((await store('readonly')).getAllKeys());
  return keys.filter((key): key is string => typeof key === 'string');
}

function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

/** The keys that start with `prefix`, without reading their values. */
export async function listRecordKeysWithPrefix(prefix: string): Promise<string[]> {
  const keys = await requestResult((await store('readonly')).getAllKeys(prefixRange(prefix)));
  return keys.filter((key): key is string => typeof key === 'string');
}

/** Every record whose key starts with `prefix`. */
export async function readRecordsWithPrefix(prefix: string): Promise<Map<string, unknown>> {
  const records = await store('readonly');
  const [keys, values] = await Promise.all([
    requestResult(records.getAllKeys(prefixRange(prefix))),
    requestResult(records.getAll(prefixRange(prefix))),
  ]);
  const result = new Map<string, unknown>();
  keys.forEach((key, index) => { if (typeof key === 'string') result.set(key, values[index]); });
  return result;
}

/** Writes and deletes several records in one transaction: all of them or none. */
export async function writeRecords(writes: ReadonlyMap<string, unknown>, deletes: Iterable<string>): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const records = transaction.objectStore(STORE_NAME);
    for (const key of deletes) records.delete(key);
    for (const [key, value] of writes) records.put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function deleteRecordsWithPrefix(prefix: string): Promise<void> {
  await requestResult((await store('readwrite')).delete(prefixRange(prefix)));
}
