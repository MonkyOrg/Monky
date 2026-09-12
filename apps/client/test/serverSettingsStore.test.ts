import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appEvents } from '../src/renderer/core/EventBus';
import type { ChatSoundMode } from '../src/renderer/stores/settingsStore';

class MemorySettingsStorage implements Storage {
  private readonly values = new Map<string, string>();
  public failWrites = false;
  public failReads = false;
  public writes = 0;
  public get length(): number { return this.values.size; }
  public clear(): void { this.values.clear(); }
  public getItem(key: string): string | null {
    if (this.failReads) throw new Error('Synthetic read failure');
    return this.values.get(key) ?? null;
  }
  public key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  public removeItem(key: string): void { this.values.delete(key); }
  public setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('Synthetic write failure');
    this.values.set(key, value);
    this.writes++;
  }
}

async function withStorage(
  run: (storage: MemorySettingsStorage, Store: typeof import('../src/renderer/stores/settingsStore').SettingsStore) => void,
): Promise<void> {
  const storage = new MemorySettingsStorage();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const { SettingsStore } = await import('../src/renderer/stores/settingsStore');
    run(storage, SettingsStore);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

function persistedOverrides(storage: Storage): unknown {
  const data: unknown = JSON.parse(storage.getItem('monky_settings') ?? 'null');
  assert.ok(data && typeof data === 'object' && 'chatSoundServerOverrides' in data);
  return data.chatSoundServerOverrides;
}

test('failed server preference writes preserve the previous map, bytes and unrelated preferences', async (context) => {
  const errors = context.mock.method(console, 'error', () => {});
  await withStorage((storage, Store) => {
    const settings = new Store();
    settings.selectedSpeakerId = 'headphones';
    settings.noiseSuppressionMode = 'speex';
    settings.advancedAudioOutputs = true;
    settings.audioOutputDevices = { voice: 'voice-output', screen: '', media: null };
    settings.setServerChatSoundOverride('a', 'mentions');
    settings.setServerChatSoundOverride('b', 'none');
    const before = storage.getItem('monky_settings');
    const previousMap = settings.chatSoundServerOverrides;
    let notifications = 0;
    const off = appEvents.on('settings.updated', () => { notifications++; });
    try {
      storage.failWrites = true;
      assert.throws(() => settings.setServerChatSoundOverride('a', 'all'), /Synthetic write failure/);
      assert.equal(settings.chatSoundServerOverrides, previousMap);
      assert.equal(settings.getServerChatSoundOverride('a'), 'mentions');
      assert.equal(settings.getServerChatSoundOverride('b'), 'none');
      assert.equal(storage.getItem('monky_settings'), before);
      assert.equal(notifications, 0);
      assert.equal(settings.selectedSpeakerId, 'headphones');
      assert.equal(settings.noiseSuppressionMode, 'speex');
      assert.equal(settings.advancedAudioOutputs, true);
      assert.deepEqual(settings.audioOutputDevices, { voice: 'voice-output', screen: '', media: null });
      assert.equal(errors.mock.callCount(), 1);
    } finally {
      off();
    }
  });
});

test('a successful retry notifies only after persistence and never mutates a previous map reference', async (context) => {
  context.mock.method(console, 'error', () => {});
  await withStorage((storage, Store) => {
    const settings = new Store();
    settings.setServerChatSoundOverride('a', 'mentions');
    const previous = settings.chatSoundServerOverrides;
    storage.failWrites = true;
    assert.throws(() => settings.setServerChatSoundOverride('a', 'none'));
    const observations: { mode: ChatSoundMode; persisted: unknown }[] = [];
    const off = appEvents.on('settings.updated', () => {
      observations.push({ mode: settings.getServerChatSoundOverride('a'), persisted: persistedOverrides(storage) });
    });
    try {
      storage.failWrites = false;
      settings.setServerChatSoundOverride('a', 'none');
      assert.deepEqual(observations, [{ mode: 'none', persisted: { a: 'none' } }]);
      assert.deepEqual(previous, { a: 'mentions' });
      assert.equal(new Store().getServerChatSoundOverride('a'), 'none');
      assert.equal(observations.length, 1, 'Constructing a store must not emit during import initialization');
    } finally {
      off();
    }
  });
});

test('removing an override is atomic too, including failure followed by inherit retry', async (context) => {
  context.mock.method(console, 'error', () => {});
  await withStorage((storage, Store) => {
    const settings = new Store();
    settings.setServerChatSoundOverride('a', 'none');
    settings.setServerChatSoundOverride('b', 'all');
    const before = storage.getItem('monky_settings');
    storage.failWrites = true;
    assert.throws(() => settings.setServerChatSoundOverride('a', 'inherit'));
    assert.equal(settings.getServerChatSoundOverride('a'), 'none');
    assert.equal(storage.getItem('monky_settings'), before);
    storage.failWrites = false;
    settings.setServerChatSoundOverride('a', 'inherit');
    assert.equal(settings.getServerChatSoundOverride('a'), 'inherit');
    assert.deepEqual(persistedOverrides(storage), { b: 'all' });
  });
});

test('initial hydration stays silent, while explicit refresh notifies fully restored persisted truth', async () => {
  await withStorage((storage, Store) => {
    storage.setItem('monky_settings', JSON.stringify({ chatSoundServerOverrides: { a: 'none' } }));
    const seen: ChatSoundMode[] = [];
    let current: InstanceType<typeof Store> | undefined;
    let prematureNotifications = 0;
    const off = appEvents.on('settings.updated', () => {
      if (!current) {
        prematureNotifications++;
        return;
      }
      seen.push(current.getServerChatSoundOverride('a'));
    });
    try {
      current = new Store();
      assert.equal(prematureNotifications, 0, 'Initial hydration must not call consumers of the uninitialized singleton');
      assert.deepEqual(seen, []);
      assert.equal(current.getServerChatSoundOverride('a'), 'none');
      storage.setItem('monky_settings', JSON.stringify({
        chatSoundServerOverrides: { a: 'mentions', b: 'invalid', c: 'inherit' },
        noiseSuppressionMode: 'gtcrn', noiseSuppressionEnabled: false,
        advancedAudioOutputs: true, audioOutputDevices: { voice: 'external-voice' },
      }));
      const writes = storage.writes;
      current.load();
      assert.deepEqual(seen, ['mentions']);
      assert.deepEqual(current.chatSoundServerOverrides, { a: 'mentions' });
      assert.equal(current.noiseSuppressionMode, 'gtcrn');
      assert.equal(current.getAudioOutputDeviceId('voice'), 'external-voice');
      assert.equal(storage.writes, writes, 'Rehydration must not write back or create cross-window loops');
      storage.setItem('monky_settings', '{}');
      current.load();
      assert.deepEqual(seen, ['mentions', 'inherit']);
      current.setServerChatSoundOverride('a', 'all');
      storage.removeItem('monky_settings');
      current.load();
      assert.equal(seen.at(-1), 'inherit');
      assert.deepEqual(current.chatSoundServerOverrides, {});
    } finally {
      off();
    }
  });
});

test('failed or malformed rehydration does not announce success or erase the last valid preference', async (context) => {
  const warnings = context.mock.method(console, 'warn', () => {});
  await withStorage((storage, Store) => {
    const settings = new Store();
    settings.setServerChatSoundOverride('a', 'mentions');
    let notifications = 0;
    const off = appEvents.on('settings.updated', () => { notifications++; });
    try {
      storage.failReads = true;
      settings.load();
      storage.failReads = false;
      for (const invalid of ['{broken', 'null', 'false', '"invalid"', '[]']) {
        storage.setItem('monky_settings', invalid);
        settings.load();
        assert.equal(settings.getServerChatSoundOverride('a'), 'mentions');
      }
      assert.equal(notifications, 0);
      assert.equal(warnings.mock.callCount(), 6);
      storage.setItem('monky_settings', JSON.stringify({ chatSoundServerOverrides: { a: 'all' } }));
      settings.load();
      assert.equal(settings.getServerChatSoundOverride('a'), 'all');
      assert.equal(notifications, 1);
    } finally {
      off();
    }
  });
});
