import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SettingsStore, settingsStore } from '../src/renderer/stores/settingsStore';
import * as Dialog from '../src/renderer/views/Dialog';
import {
  confirmSoundDownload, soundDownloadConfirmationScope, type SoundDownloadConfirmationDetails,
} from '../src/renderer/utils/soundDownloadConfirmation';

function fixture(context: TestContext) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousExceptions = settingsStore.botDownloadConfirmationExceptions;
  const previousPreferences = settingsStore.botUserPreferences;
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  settingsStore.botDownloadConfirmationExceptions = [];
  settingsStore.botUserPreferences = {};
  context.after(() => {
    settingsStore.botDownloadConfirmationExceptions = previousExceptions;
    settingsStore.botUserPreferences = previousPreferences;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const details: SoundDownloadConfirmationDetails = {
    serverUrl: 'wss://server.example/', serverId: 'server-id', serverName: 'A server',
    invokerId: 'caller', botId: 'generic-bot', botName: 'Generic Bot',
    folder: 'C:\\Audio',
    request: { title: 'Authored sound', fileName: 'sound.wav', url: 'https://audio.example/sound.wav' },
  };
  return { storage, details };
}

test('download opt-outs are isolated by normalized endpoint, server, caller and bot', (context) => {
  const { details } = fixture(context);
  const key = soundDownloadConfirmationScope(details);
  assert.ok(key);
  assert.equal(soundDownloadConfirmationScope({ ...details, serverUrl: 'wss://SERVER.example:443/' }), key);
  for (const different of [
    { serverUrl: 'wss://another.example/' }, { serverUrl: 'ws://server.example/' },
    { serverUrl: 'wss://server.example:8443/' }, { serverUrl: 'wss://server.example/other' },
    { serverId: 'different-server' }, { invokerId: 'another-caller' }, { botId: 'another-bot' },
  ]) {
    assert.notEqual(soundDownloadConfirmationScope({ ...details, ...different }), key);
  }
  for (const invalid of [
    { serverId: '' }, { invokerId: '' }, { botId: '' }, { serverUrl: 'invalid' },
    { serverUrl: 'https://server.example/' }, { serverUrl: 'wss://user:password@server.example/' },
  ]) {
    assert.equal(soundDownloadConfirmationScope({ ...details, ...invalid }), null);
  }
});

test('accepting the switch persists consent for this scope only, and reset restores confirmation', async (context) => {
  const { details } = fixture(context);
  const prompt = context.mock.method(Dialog, 'showConfirmWithText', async (options: Parameters<typeof Dialog.showConfirmWithText>[0]) => {
    assert.equal(options.requireUserGesture, true);
    assert.ok(options.signal);
    assert.ok(options.checkboxLabel);
    assert.ok(options.message.includes('sound.wav'));
    assert.ok(options.message.includes('C:\\Audio'));
    assert.ok(options.message.includes('audio.example'));
    assert.equal(options.textInput.value, 'sound');
    assert.equal(options.textInput.suffix, '.wav');
    assert.ok(options.checkboxHint);
    return { confirmed: true, checked: true, value: 'sound' };
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await confirmSoundDownload(details, signal), { fileName: 'sound.wav' });
  assert.equal(prompt.mock.callCount(), 1);
  const restored = new SettingsStore();
  assert.deepEqual(restored.botDownloadConfirmationExceptions, [soundDownloadConfirmationScope(details)]);
  assert.deepEqual(await confirmSoundDownload(details, signal), { fileName: 'sound.wav' });
  assert.equal(prompt.mock.callCount(), 1);
  assert.deepEqual(await confirmSoundDownload({ ...details, botId: 'different-bot' }, signal), { fileName: 'sound.wav' });
  assert.equal(prompt.mock.callCount(), 2);
  settingsStore.resetBotDownloadConfirmations();
  assert.deepEqual(new SettingsStore().botDownloadConfirmationExceptions, []);
  assert.deepEqual(await confirmSoundDownload(details, signal), { fileName: 'sound.wav' });
  assert.equal(prompt.mock.callCount(), 3);
});

test('declining, unchecked acceptance and an aborted acceptance never persist an exception', async (context) => {
  const { details } = fixture(context);
  const results = [
    { confirmed: false, checked: true, value: 'renamed' },
    { confirmed: true, checked: false, value: 'renamed' },
    { confirmed: true, checked: true, value: 'renamed' },
  ];
  const controller = new AbortController();
  let index = 0;
  context.mock.method(Dialog, 'showConfirmWithText', async () => {
    if (index === 2) controller.abort();
    return results[index++];
  });
  assert.equal(await confirmSoundDownload(details, controller.signal), null);
  assert.deepEqual(await confirmSoundDownload(details, controller.signal), { fileName: 'renamed.wav' });
  assert.equal(await confirmSoundDownload(details, controller.signal), null);
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, []);
  assert.deepEqual(new SettingsStore().botDownloadConfirmationExceptions, []);
});

test('missing scope identity still prompts but never offers persistent suppression', async (context) => {
  const { details } = fixture(context);
  const prompt = context.mock.method(Dialog, 'showConfirmWithText', async (options: Parameters<typeof Dialog.showConfirmWithText>[0]) => {
    assert.equal(options.checkboxLabel, undefined);
    return { confirmed: true, checked: true, value: options.textInput.value };
  });
  assert.deepEqual(await confirmSoundDownload({ ...details, serverId: '' }, new AbortController().signal), { fileName: 'sound.wav' });
  assert.equal(prompt.mock.callCount(), 1);
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, []);
});

test('queued confirmations do not overlap, and an aborted queued request never opens a dialog', async (context) => {
  const { details } = fixture(context);
  let resolveFirst: (result: { confirmed: boolean; checked: boolean; value: string }) => void = () => {};
  const prompt = context.mock.method(Dialog, 'showConfirmWithText', () => new Promise<{ confirmed: boolean; checked: boolean; value: string }>((resolve) => {
    resolveFirst = resolve;
  }));
  const first = confirmSoundDownload(details, new AbortController().signal);
  const cancelled = new AbortController();
  const second = confirmSoundDownload({ ...details, botId: 'another' }, cancelled.signal);
  await Promise.resolve();
  assert.equal(prompt.mock.callCount(), 1);
  cancelled.abort();
  resolveFirst({ confirmed: true, checked: false, value: 'sound' });
  assert.deepEqual(await first, { fileName: 'sound.wav' });
  assert.equal(await second, null);
  assert.equal(prompt.mock.callCount(), 1);
});

test('a persistence failure rolls back approvals, rejects this download and leaves the queue usable', async (context) => {
  const { details, storage } = fixture(context);
  context.mock.method(console, 'warn', () => {});
  const write = context.mock.method(storage, 'setItem', () => { throw new Error('Fixture storage quota'); });
  const prompt = context.mock.method(Dialog, 'showConfirmWithText', async () => ({ confirmed: true, checked: true, value: 'sound' }));
  await assert.rejects(confirmSoundDownload(details, new AbortController().signal), /Could not save/);
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, []);
  write.mock.restore();
  assert.deepEqual(await confirmSoundDownload(details, new AbortController().signal), { fileName: 'sound.wav' });
  assert.equal(prompt.mock.callCount(), 2);
  assert.equal(settingsStore.botDownloadConfirmationExceptions.length, 1);
});

test('renaming preserves the source extension and rejects invalid Windows basenames before approval', async (context) => {
  const { details } = fixture(context);
  details.request.fileName = 'original.MP3';
  context.mock.method(Dialog, 'showConfirmWithText', async (options: Parameters<typeof Dialog.showConfirmWithText>[0]) => {
    assert.equal(options.textInput.suffix, '.MP3');
    assert.equal(options.textInput.maxLength, 124);
    for (const value of ['', '..', '../escape', 'folder\\file', 'CON', 'LPT1', 'bad:name', 'a'.repeat(125)]) {
      assert.ok(options.textInput.validate?.(value), `Must reject ${value}`);
    }
    assert.equal(options.textInput.validate?.('My local name'), undefined);
    return { confirmed: true, checked: false, value: 'My local name' };
  });
  assert.deepEqual(await confirmSoundDownload(details, new AbortController().signal), { fileName: 'My local name.MP3' });
  assert.equal(details.request.fileName, 'original.MP3', 'The bot request must not be mutated');
});

test('an opt-out does not retain a custom filename for subsequent downloads', async (context) => {
  const { details, storage } = fixture(context);
  const prompt = context.mock.method(Dialog, 'showConfirmWithText', async () => ({
    confirmed: true, checked: true, value: 'Local custom name',
  }));
  const signal = new AbortController().signal;
  assert.deepEqual(await confirmSoundDownload(details, signal), { fileName: 'Local custom name.wav' });
  assert.deepEqual(await confirmSoundDownload(details, signal), { fileName: 'sound.wav' });
  assert.equal(prompt.mock.callCount(), 1);
  assert.equal(storage.getItem('monky_settings')?.includes('Local custom name'), false);
});

test('invalid accepted names fail closed without remembering approval', async (context) => {
  const { details } = fixture(context);
  context.mock.method(Dialog, 'showConfirmWithText', async () => ({
    confirmed: true, checked: true, value: '../escape',
  }));
  await assert.rejects(confirmSoundDownload(details, new AbortController().signal), /file name is invalid/);
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, []);
});

test('malformed or unreadable stored approvals fail closed, including a reload after previous consent', (context) => {
  const { details, storage } = fixture(context);
  context.mock.method(console, 'warn', () => {});
  const key = soundDownloadConfirmationScope(details);
  assert.ok(key);
  settingsStore.suppressBotDownloadConfirmation(key);
  for (const invalid of [true, null, 'all', [true], [''], [1], Array(257).fill('scope')]) {
    storage.setItem('monky_settings', JSON.stringify({ botDownloadConfirmationExceptions: invalid }));
    assert.deepEqual(new SettingsStore().botDownloadConfirmationExceptions, []);
  }
  storage.setItem('monky_settings', '{malformed');
  settingsStore.load();
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, []);
  storage.removeItem('monky_settings');
  settingsStore.botDownloadConfirmationExceptions = [key];
  settingsStore.load();
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, []);
});

test('reset failure is explicit and preserves the existing approvals in memory and storage', (context) => {
  const { details, storage } = fixture(context);
  context.mock.method(console, 'warn', () => {});
  const key = soundDownloadConfirmationScope(details);
  assert.ok(key);
  settingsStore.suppressBotDownloadConfirmation(key);
  context.mock.method(storage, 'setItem', () => { throw new Error('Fixture write failure'); });
  assert.throws(() => settingsStore.resetBotDownloadConfirmations(), /Could not restore/);
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, [key]);
  assert.deepEqual(new SettingsStore().botDownloadConfirmationExceptions, [key]);
});

test('individual bot values and download prompts are isolated by caller, server and bot', (context) => {
  const { details } = fixture(context);
  const scopes = [
    details,
    { ...details, botId: 'another-bot' },
    { ...details, serverId: 'another-server' },
    { ...details, invokerId: 'another-user' },
  ].map((scope) => {
    const key = soundDownloadConfirmationScope(scope);
    assert.ok(key);
    return key;
  });
  for (const key of scopes) settingsStore.saveBotPreferences(key, { enabled: false, repeat: 0, sources: ['first'] }, false);
  settingsStore.saveBotPreferences(scopes[0], { enabled: true, repeat: 2 }, true);
  assert.deepEqual(settingsStore.getBotUserSettings(scopes[0]), { enabled: true, repeat: 2 });
  assert.equal(settingsStore.botDownloadConfirmationExceptions.includes(scopes[0]), false);
  for (const key of scopes.slice(1)) {
    assert.deepEqual(settingsStore.getBotUserSettings(key), { enabled: false, repeat: 0, sources: ['first'] });
    assert.equal(settingsStore.botDownloadConfirmationExceptions.includes(key), true);
  }
  const restored = new SettingsStore();
  assert.deepEqual(restored.botUserPreferences, settingsStore.botUserPreferences);
  assert.deepEqual(restored.botDownloadConfirmationExceptions, scopes.slice(1));
});

test('individual preference snapshots cannot mutate persisted data or carry host consent values', (context) => {
  const { details } = fixture(context);
  const key = soundDownloadConfirmationScope(details);
  assert.ok(key);
  const values = { count: 0, list: ['first'] };
  settingsStore.saveBotPreferences(key, values, false);
  values.list.push('outside');
  const snapshot = settingsStore.getBotUserSettings(key);
  assert.ok(Array.isArray(snapshot.list));
  snapshot.list.push('changed snapshot');
  assert.deepEqual(settingsStore.getBotUserSettings(key), { count: 0, list: ['first'] });
  settingsStore.suppressBotDownloadConfirmation(key);
  assert.deepEqual(settingsStore.getBotUserSettings(key), { count: 0, list: ['first'] });
  assert.deepEqual(settingsStore.getBotUserSettings('__proto__'), {});
  settingsStore.saveBotPreferences(key, { count: 1 });
  assert.equal(settingsStore.botDownloadConfirmationExceptions.includes(key), true, 'Custom values alone cannot reset host consent');
});

test('saving preferences and the filename prompt is atomic on storage failure', (context) => {
  const { details, storage } = fixture(context);
  const key = soundDownloadConfirmationScope(details);
  assert.ok(key);
  settingsStore.saveBotPreferences(key, { count: 1 }, false);
  const stored = storage.getItem('monky_settings');
  context.mock.method(console, 'warn', () => {});
  context.mock.method(storage, 'setItem', () => { throw new Error('Fixture storage failure'); });
  assert.throws(() => settingsStore.saveBotPreferences(key, { count: 2 }, true), /Could not save/);
  assert.deepEqual(settingsStore.getBotUserSettings(key), { count: 1 });
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, [key]);
  assert.equal(storage.getItem('monky_settings'), stored);
});

test('old opt-outs survive loading and malformed individual preferences fail explicitly', (context) => {
  const { details, storage } = fixture(context);
  const key = soundDownloadConfirmationScope(details);
  assert.ok(key);
  storage.setItem('monky_settings', JSON.stringify({ botDownloadConfirmationExceptions: [key] }));
  settingsStore.load();
  assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, [key]);
  assert.deepEqual(settingsStore.botUserPreferences, {});
  const warning = context.mock.method(console, 'warn', () => {});
  for (const invalid of [null, [], 1, { [key]: { count: { nested: true } } }]) {
    storage.setItem('monky_settings', JSON.stringify({ botDownloadConfirmationExceptions: [key], botUserPreferences: invalid }));
    settingsStore.load();
    assert.deepEqual(settingsStore.botUserPreferences, {});
    assert.deepEqual(settingsStore.botDownloadConfirmationExceptions, [key]);
  }
  assert.equal(warning.mock.callCount(), 4);
  settingsStore.saveBotPreferences(key, { count: 1 });
  assert.throws(() => settingsStore.saveBotPreferences('', { count: 2 }), /Invalid/);
  assert.throws(() => settingsStore.saveBotPreferences(key, { count: Infinity }), /Invalid/);
  assert.deepEqual(settingsStore.getBotUserSettings(key), { count: 1 });
});

test('local bot preference retention is bounded independently of other settings', (context) => {
  fixture(context);
  for (let index = 0; index < 257; index++) settingsStore.saveBotPreferences(`scope-${index}`, { count: index }, false);
  assert.equal(Object.keys(settingsStore.botUserPreferences).length, 256);
  assert.equal(settingsStore.botDownloadConfirmationExceptions.length, 256);
  assert.deepEqual(settingsStore.getBotUserSettings('scope-0'), {});
  assert.deepEqual(settingsStore.getBotUserSettings('scope-256'), { count: 256 });
});
