import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appEvents } from '../src/renderer/core/EventBus';
import type { SettingsUpdate } from '../src/renderer/stores/settingsStore';

/**
 * Saving the settings announces what changed and groups the writes of a value
 * still moving (R-SHELL-2, R-VOICEUI-8). A dragged volume slider must not wake
 * the saved-server probe or the push-to-talk hook, which filter on those keys,
 * and its value must reach storage where the slider stops, when the page goes
 * away and when the app starts quitting.
 */

class CountingStorage implements Storage {
  private readonly values = new Map<string, string>();
  public writes = 0;
  public get length(): number { return this.values.size; }
  public clear(): void { this.values.clear(); }
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  public removeItem(key: string): void { this.values.delete(key); }
  public setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes++;
  }
}

const storage = new CountingStorage();
let quitting: (() => void) | null = null;
const page = Object.assign(new EventTarget(), {
  api: { onAppBeforeQuit: (callback: () => void) => { quitting = callback; return () => {}; } },
});
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
Object.defineProperty(globalThis, 'window', { configurable: true, value: page });
// Loaded once the page exists, as in the app, so the store registers its listeners on it.
const loaded = import('../src/renderer/stores/settingsStore');

function recordUpdates(): { updates: SettingsUpdate[]; off: () => void } {
  const updates: SettingsUpdate[] = [];
  const off = appEvents.on<SettingsUpdate>('settings.updated', (update) => updates.push(update));
  return { updates, off };
}

const stored = (): Record<string, unknown> => JSON.parse(storage.getItem('monky_settings') ?? '{}');

test('a save announces only the settings that changed, and an unchanged one writes nothing', async () => {
  const { settingsStore } = await loaded;
  const { updates, off } = recordUpdates();
  try {
    settingsStore.soundboardMuted = !settingsStore.soundboardMuted;
    settingsStore.save();
    assert.deepEqual(updates.map((update) => update.keys), [['soundboardMuted']]);
    assert.equal(stored().soundboardMuted, settingsStore.soundboardMuted);
    const writes = storage.writes;
    settingsStore.save();
    assert.equal(storage.writes, writes, 'nothing changed, nothing written');
    assert.equal(updates.length, 1, 'nothing changed, nothing announced');
  } finally {
    off();
  }
});

test('a volume still moving is heard at once and saved once, without concerning the probe or the push-to-talk hook', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { settingsStore, settingsChanged } = await loaded;
  const { updates, off } = recordUpdates();
  const heard: number[] = [];
  const offVolume = appEvents.on<{ volume: number }>('user_volume.changed', ({ volume }) => heard.push(volume));
  try {
    const writes = storage.writes;
    for (let volume = 40; volume < 100; volume++) settingsStore.setUserVolume('peer:device', volume, 'soon');
    assert.equal(heard.length, 60, 'every step is applied at once');
    assert.equal(storage.writes, writes, 'nothing is written while the slider moves');
    assert.equal(updates.length, 0, 'nothing is announced while the slider moves');
    context.mock.timers.tick(299);
    assert.equal(storage.writes, writes);
    context.mock.timers.tick(1);
    assert.equal(storage.writes, writes + 1, 'one write where the slider stopped');
    assert.deepEqual(updates.map((update) => update.keys), [['userVolumes']]);
    assert.deepEqual(stored().userVolumes, { 'peer:device': 99 });
    // What AutoEntryService and AudioProcessor ask before probing servers or calling the hook.
    assert.equal(settingsChanged(updates[0], 'autoConnectServers'), false);
    assert.equal(settingsChanged(updates[0], 'inputMode', 'pttKey'), false);
    assert.equal(settingsChanged(undefined, 'inputMode'), true, 'an event from outside the store may concern anything');
  } finally {
    off();
    offVolume();
  }
});

test('releasing the slider saves at once and cancels the grouped save', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { settingsStore } = await loaded;
  const { updates, off } = recordUpdates();
  try {
    settingsStore.setScreenAudioVolume('sharer:device', 150, 'soon');
    settingsStore.setMiniappVolume('bot', 60, 'soon');
    const writes = storage.writes;
    settingsStore.save();
    assert.equal(storage.writes, writes + 1);
    assert.deepEqual(updates.map((update) => update.keys), [['screenAudioVolumes', 'miniappVolumes']]);
    context.mock.timers.tick(1000);
    assert.equal(storage.writes, writes + 1, 'the grouped save does not write again');
    assert.equal(updates.length, 1);
    settingsStore.setUserVolume('peer:device', 120);
    assert.equal(storage.writes, writes + 2, 'a volume set outright is saved outright');
  } finally {
    off();
  }
});

test('a value still waiting is written when the page goes away and when the app starts quitting', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { settingsStore } = await loaded;
  settingsStore.soundboardVolume = 33;
  settingsStore.saveSoon();
  assert.notEqual(stored().soundboardVolume, 33);
  page.dispatchEvent(new Event('pagehide'));
  assert.equal(stored().soundboardVolume, 33, 'written when the page goes away');
  settingsStore.vadSensitivity = 61;
  settingsStore.saveSoon();
  assert.ok(quitting, 'the store follows the app shutdown');
  quitting?.();
  assert.equal(stored().vadSensitivity, 61, 'written when the app starts quitting');
  const writes = storage.writes;
  context.mock.timers.tick(1000);
  assert.equal(storage.writes, writes, 'nothing is left to write afterwards');
});

test('a backup includes a value still waiting', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { settingsStore } = await loaded;
  const { collectBackup } = await import('../src/renderer/utils/backup');
  settingsStore.pttReleaseDelay = 450;
  settingsStore.saveSoon();
  const backup = collectBackup(['settings']);
  const settings = backup.settings?.settings;
  assert.ok(settings && typeof settings === 'object' && 'pttReleaseDelay' in settings);
  assert.equal(settings.pttReleaseDelay, 450);
});

test('reading the settings announces only what another window changed, and writes nothing back', async () => {
  const { settingsStore } = await loaded;
  const { updates, off } = recordUpdates();
  try {
    storage.setItem('monky_settings', JSON.stringify({ ...stored(), pttReleaseDelay: 640, chatMessageSoundEnabled: false }));
    const writes = storage.writes;
    settingsStore.load();
    assert.deepEqual(updates.map((update) => update.keys), [['pttReleaseDelay', 'chatMessageSoundEnabled']]);
    settingsStore.load();
    assert.equal(updates.length, 1, 'reading the same settings again announces nothing');
    assert.equal(storage.writes, writes, 'reading never writes');
  } finally {
    off();
  }
});

test('keys that are not settings, as an imported backup may bring, never reach the store', async () => {
  const { settingsStore } = await loaded;
  const { updates, off } = recordUpdates();
  try {
    storage.setItem('monky_settings', JSON.stringify({
      ...stored(), vadSensitivity: 23, saved: {}, pendingSave: 'later', diff: 1, save: 0, load: null,
    }));
    assert.doesNotThrow(() => settingsStore.load(), 'the settings still load');
    assert.equal(settingsStore.vadSensitivity, 23, 'the settings in the text are read');
    assert.deepEqual(updates.map((update) => update.keys), [['vadSensitivity']]);
    settingsStore.soundboardMuted = !settingsStore.soundboardMuted;
    settingsStore.save();
    assert.deepEqual(updates.at(-1)?.keys, ['soundboardMuted'], 'the store still saves and announces what changed');
    assert.ok(!('saved' in stored()) && !('diff' in stored()), 'what is not a setting is not written back');
    settingsStore.load();
    assert.equal(updates.length, 2, 'and it still reads its own text back');
  } finally {
    off();
  }
});
