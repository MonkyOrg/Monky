import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIO_OUTPUT_CATEGORIES, copyAudioOutputPreferences, isNoiseSuppressionMode,
  resolveAudioOutput, restoreAudioOutputDevices, restoreNoiseSuppressionMode,
  type AudioOutputPreferences,
} from '../src/renderer/utils/audioPreferences';
import { SettingsStore } from '../src/renderer/stores/settingsStore';

function withSettingsStorage(run: (storage: Storage) => void): void {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    run(storage);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('legacy noise suppression settings preserve RNNoise and browser behavior', () => {
  assert.equal(restoreNoiseSuppressionMode(undefined, true), 'rnnoise');
  assert.equal(restoreNoiseSuppressionMode(undefined, false), 'browser');
  assert.equal(restoreNoiseSuppressionMode('invalid', undefined), 'rnnoise');
  for (const mode of ['rnnoise', 'speex', 'gtcrn', 'browser', 'off']) {
    assert.equal(restoreNoiseSuppressionMode(mode, false), mode);
    assert.ok(isNoiseSuppressionMode(mode));
  }
  for (const invalid of [null, undefined, false, {}, 'RNNoise', '']) {
    assert.equal(isNoiseSuppressionMode(invalid), false);
  }
});

test('output overrides distinguish inheritance from the explicit system default', () => {
  const preferences: AudioOutputPreferences = {
    selectedSpeakerId: 'headphones',
    advancedAudioOutputs: true,
    audioOutputDevices: { voice: 'voice-device', screen: '', media: null },
  };
  assert.equal(resolveAudioOutput(preferences, 'voice'), 'voice-device');
  assert.equal(resolveAudioOutput(preferences, 'screen'), '');
  assert.equal(resolveAudioOutput(preferences, 'media'), 'headphones');
  preferences.selectedSpeakerId = 'new-general';
  assert.equal(resolveAudioOutput(preferences, 'voice'), 'voice-device');
  assert.equal(resolveAudioOutput(preferences, 'screen'), '');
  assert.equal(resolveAudioOutput(preferences, 'media'), 'new-general');
});

test('disabling advanced routing uses the general output without deleting choices', () => {
  const preferences: AudioOutputPreferences = {
    selectedSpeakerId: 'default',
    advancedAudioOutputs: false,
    audioOutputDevices: { voice: 'voice-device', screen: 'screen-device', media: 'media-device' },
  };
  for (const category of AUDIO_OUTPUT_CATEGORIES) assert.equal(resolveAudioOutput(preferences, category), '');
  const next = copyAudioOutputPreferences(preferences);
  next.advancedAudioOutputs = true;
  next.audioOutputDevices.media = null;
  assert.equal(preferences.audioOutputDevices.media, 'media-device');
  assert.equal(next.selectedSpeakerId, '');
  assert.equal(resolveAudioOutput(next, 'voice'), 'voice-device');
});

test('saved output settings are validated and legacy default aliases are normalized', () => {
  const empty = { voice: null, screen: null, media: null };
  for (const invalid of [undefined, null, [], 42, 'speaker']) {
    assert.deepEqual(restoreAudioOutputDevices(invalid), empty);
  }
  assert.deepEqual(restoreAudioOutputDevices({
    voice: 'headphones', screen: 'default', media: false, extra: 'ignored',
  }), { voice: 'headphones', screen: '', media: null });
  assert.deepEqual(restoreAudioOutputDevices({ media: '' }), { voice: null, screen: null, media: '' });
});

test('new audio preferences survive an actual settings-store save and reload', () => {
  withSettingsStorage(() => {
    const settings = new SettingsStore();
    settings.selectedSpeakerId = 'general';
    settings.advancedAudioOutputs = true;
    settings.audioOutputDevices = { voice: 'headset', screen: '', media: null };
    settings.noiseSuppressionMode = 'off';
    settings.lastNoiseSuppressionMode = 'gtcrn';
    settings.save();
    const reloaded = new SettingsStore();
    assert.equal(reloaded.noiseSuppressionMode, 'off');
    assert.equal(reloaded.lastNoiseSuppressionMode, 'gtcrn');
    assert.equal(reloaded.getAudioOutputDeviceId('voice'), 'headset');
    assert.equal(reloaded.getAudioOutputDeviceId('screen'), '');
    assert.equal(reloaded.getAudioOutputDeviceId('media'), 'general');
    assert.equal(reloaded.advancedAudioOutputs, true);
  });
});

test('store migration prioritizes an explicit engine regardless of JSON field order', () => {
  withSettingsStorage((storage) => {
    storage.setItem('monky_settings', JSON.stringify({ noiseSuppressionMode: 'speex', noiseSuppressionEnabled: false }));
    assert.equal(new SettingsStore().noiseSuppressionMode, 'speex');
    storage.setItem('monky_settings', JSON.stringify({ noiseSuppressionEnabled: false }));
    assert.equal(new SettingsStore().noiseSuppressionMode, 'browser');
    storage.setItem('monky_settings', JSON.stringify({
      noiseSuppressionMode: 'invalid', advancedAudioOutputs: 'true', audioOutputDevices: { voice: 42, screen: 'default' },
    }));
    const restored = new SettingsStore();
    assert.equal(restored.noiseSuppressionMode, 'rnnoise');
    assert.equal(restored.advancedAudioOutputs, false);
    assert.deepEqual(restored.audioOutputDevices, { voice: null, screen: '', media: null });
  });
});
