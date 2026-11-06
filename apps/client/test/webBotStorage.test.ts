import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOT_STORAGE_LIMITS, type BotDeviceStorageScope } from '@monky/shared';
import {
  bindWebBotScreenStorage, releaseWebBotScreenStorage, webBotStorage, wipeWebBotStorage,
} from '../src/renderer/platform/web/webBotStorage';

/** The slice of IndexedDB that `webStorage.ts` uses, over a sorted map, answering asynchronously like a browser. */
class Range {
  constructor(readonly lower: string, readonly upper: string) {}
  static bound(lower: string, upper: string): Range { return new Range(lower, upper); }
  includes(key: string): boolean { return key >= this.lower && key <= this.upper; }
}

const records = new Map<string, unknown>();

function request<T>(work: () => T) {
  const pending: { result?: T; onsuccess?: () => void; onerror?: () => void; error: null } = { error: null };
  setImmediate(() => { pending.result = work(); pending.onsuccess?.(); });
  return pending;
}

const matching = (range?: Range): string[] => [...records.keys()].filter(key => !range || range.includes(key)).sort();
const clone = (value: unknown): unknown => structuredClone(value);

const objectStore = {
  get: (key: string) => request(() => clone(records.get(key))),
  put: (value: unknown, key: string) => request(() => { records.set(key, clone(value)); }),
  delete: (key: string | Range) => request(() => {
    for (const stored of typeof key === 'string' ? [key] : matching(key)) records.delete(stored);
  }),
  getAllKeys: (range?: Range) => request(() => matching(range)),
  getAll: (range?: Range) => request(() => matching(range).map(key => clone(records.get(key)))),
};

const database = {
  objectStoreNames: { contains: () => true },
  transaction: () => ({ objectStore: () => objectStore }),
};

Object.assign(globalThis, {
  IDBKeyRange: Range,
  indexedDB: { open: () => request(() => database) },
});

const scope: BotDeviceStorageScope = {
  serverUrl: 'wss://monky.example/', serverId: 'server', serverName: 'Server', userId: 'user', botId: 'bot', botName: 'MonkyBot',
};
const DOCUMENT = 'https://monky-miniapps.vercel.app/frame.html#document';

const botRecords = (): string[] => [...records.keys()].filter(key => key.startsWith('bot-storage/'));

test('web miniapps keep data on the app origin, with the same consent, quota and forget as the desktop (#861)', async () => {
  records.clear();
  const entry = await webBotStorage.get(scope);
  assert.equal(entry.decision, 'ask', 'the web asks before a bot keeps anything, like the desktop');
  assert.deepEqual(botRecords(), [], 'reading never stores anything');

  await bindWebBotScreenStorage(DOCUMENT, { scope, grant: 'none' });
  assert.equal((await webBotStorage.documentState(DOCUMENT)).status, 'denied');
  assert.equal((await webBotStorage.documentRequest(DOCUMENT, { op: 'set', key: 'slot', value: { kind: 'text', text: 'x' }, autosave: false })).ok, false);
  releaseWebBotScreenStorage(DOCUMENT);

  await bindWebBotScreenStorage(DOCUMENT, { scope, grant: 'session' });
  assert.equal((await webBotStorage.documentState(DOCUMENT)).status, 'granted');
  assert.equal((await webBotStorage.documentRequest(DOCUMENT, { op: 'set', key: 'slot', value: { kind: 'text', text: 'x' }, autosave: false })).ok, true);
  const read = await webBotStorage.documentRequest(DOCUMENT, { op: 'get', key: 'slot' });
  assert.deepEqual(read.ok && read.op === 'get' ? read.value : null, { kind: 'text', text: 'x' });
  assert.ok(botRecords().some(key => key.endsWith(`${entry.id}/index`)), 'the index lives in the app origin\'s IndexedDB');
  assert.equal((await webBotStorage.get(scope)).decision, 'ask', '"Only this session" is not remembered');

  releaseWebBotScreenStorage(DOCUMENT);
  assert.equal((await webBotStorage.documentState(DOCUMENT)).status, 'unavailable', 'leaving the miniapp ends the session grant');

  await webBotStorage.setQuota(scope, BOT_STORAGE_LIMITS.minQuotaBytes);
  await bindWebBotScreenStorage(DOCUMENT, { scope, grant: 'always' });
  assert.equal((await webBotStorage.get(scope)).decision, 'always');
  const big = await webBotStorage.documentRequest(DOCUMENT, {
    op: 'set', key: 'big', value: { kind: 'bytes', bytes: new Uint8Array(BOT_STORAGE_LIMITS.minQuotaBytes) }, autosave: false,
  });
  assert.deepEqual(big.ok ? null : big.reason, 'quota', 'the quota is enforced on the web too');

  await webBotStorage.clear(entry.id);
  const cleared = await webBotStorage.documentRequest(DOCUMENT, { op: 'get', key: 'slot' });
  assert.equal(cleared.ok && cleared.op === 'get' ? cleared.value : 'still there', null, 'clearing removes the data');
  assert.equal((await webBotStorage.get(scope)).decision, 'always', 'clearing keeps the decision');

  await webBotStorage.forget(entry.id);
  assert.deepEqual(botRecords(), [], 'forgetting removes every record of the bot');
  assert.equal((await webBotStorage.get(scope)).decision, 'ask');
  releaseWebBotScreenStorage(DOCUMENT);
});

test('logging out of the web version deletes what every bot kept, and nothing else (#861)', async () => {
  records.clear();
  records.set('dm/conversation', 'kept');
  await bindWebBotScreenStorage(DOCUMENT, { scope, grant: 'always' });
  await webBotStorage.documentRequest(DOCUMENT, { op: 'set', key: 'slot', value: { kind: 'text', text: 'x' }, autosave: false });
  assert.notDeepEqual(botRecords(), []);

  await wipeWebBotStorage();
  assert.deepEqual(botRecords(), []);
  assert.equal(records.get('dm/conversation'), 'kept');
  assert.equal((await webBotStorage.documentState(DOCUMENT)).status, 'unavailable', 'an open miniapp loses its grant');
  assert.equal((await webBotStorage.get(scope)).decision, 'ask', 'the next account starts from the question again');
});
