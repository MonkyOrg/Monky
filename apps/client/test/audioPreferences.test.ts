import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIO_OUTPUT_CATEGORIES, copyAudioOutputPreferences, isNoiseSuppressionMode,
  resolveAudioOutput, restoreAudioOutputDevices, restoreNoiseSuppressionMode,
  type AudioOutputPreferences,
} from '../src/renderer/utils/audioPreferences';
import { SettingsStore } from '../src/renderer/stores/settingsStore';
import { DEFAULT_CUSTOM_PROFILE } from '@monky/shared';
import { customVideoFpsLimit, normalizeCustomQualityProfile } from '../src/renderer/utils/qualityProfileLimits';

test('screen encoding defaults to Automatic independently of camera and persists exact Manual software', () => {
  withSettingsStorage(storage => {
    for (const preferredVideoCodec of ['av1', 'vp9', 'vp8', 'h264']) {
      storage.setItem('monky_settings', JSON.stringify({ preferredVideoCodec }));
      const store = new SettingsStore();
      assert.equal(store.screenEncodingMode, 'hardware');
      assert.equal(store.screenEncodingStrategy, 'automatic');
      assert.equal(store.preferredScreenCodec, 'h264');
      assert.equal(store.preferredVideoCodec, preferredVideoCodec);
      store.screenEncodingMode = 'software';
      store.screenEncodingStrategy = 'manual';
      store.preferredScreenCodec = 'av1';
      store.save();
      const restored = new SettingsStore();
      assert.equal(restored.screenEncodingMode, 'software');
      assert.equal(restored.screenEncodingStrategy, 'manual');
      assert.equal(restored.preferredScreenCodec, 'av1');
      assert.equal(restored.preferredVideoCodec, preferredVideoCodec);
    }
    storage.setItem('monky_settings', JSON.stringify({ screenEncodingMode: 'chromium', preferredScreenCodec: 'vp9' }));
    const invalid = new SettingsStore();
    assert.equal(invalid.screenEncodingMode, 'hardware');
    assert.equal(invalid.preferredScreenCodec, 'h264');
    assert.equal(invalid.screenEncodingStrategy, 'automatic');
  });
});

test('legacy explicit screen choices migrate to Manual, and Automatic preserves dormant manual preferences on reload', () => {
  withSettingsStorage(storage => {
    for (const [input, strategy, mode, codec] of [
      [{}, 'automatic', 'hardware', 'h264'],
      [{ preferredScreenCodec: 'auto' }, 'automatic', 'hardware', 'h264'],
      [{ screenEncodingMode: 'software' }, 'manual', 'software', 'h264'],
      [{ screenEncodingMode: 'software', preferredScreenCodec: 'auto' }, 'manual', 'software', 'h264'],
      [{ preferredScreenCodec: 'av1' }, 'manual', 'hardware', 'av1'],
      [{ preferredScreenCodec: 'h264' }, 'manual', 'hardware', 'h264'],
      [{ screenEncodingStrategy: 'automatic', screenEncodingMode: 'software', preferredScreenCodec: 'av1' }, 'automatic', 'software', 'av1'],
      [{ screenEncodingStrategy: 'invalid', screenEncodingMode: 'software' }, 'automatic', 'software', 'h264'],
    ] as const) {
      storage.setItem('monky_settings', JSON.stringify(input));
      const store = new SettingsStore();
      assert.equal(store.screenEncodingStrategy, strategy);
      assert.equal(store.screenEncodingMode, mode);
      assert.equal(store.preferredScreenCodec, codec);
      store.save();
      assert.equal(new SettingsStore().screenEncodingStrategy, strategy);
    }
  });
});
test('screen high-FPS ceilings preserve existing camera limits including 4K combinations', () => {
  for (const [width, height, limit, screenLimit] of [[1920, 1080, 120, 240], [2560, 1440, 120, 240], [3440, 1440, 120, 240],
    [3840, 2160, 60, 120], [3840, 1080, 60, 120], [1920, 2160, 60, 120]]) {
    assert.equal(customVideoFpsLimit(width, height, false), limit);
    assert.equal(customVideoFpsLimit(width, height), screenLimit);
    for (const fps of [1, 59, 60, 61, 119, 120, 121, 144, 240, 241, 10000]) {
      const normalized = normalizeCustomQualityProfile({
        ...DEFAULT_CUSTOM_PROFILE, cameraWidth: width, cameraHeight: height, cameraFps: fps,
        screenWidth: width, screenHeight: height, screenFps: fps,
      });
      assert.equal(normalized.cameraFps, Math.min(fps, limit));
      assert.equal(normalized.screenFps, Math.min(fps, screenLimit));
    }
  }
});

test('custom dimensions and video bitrate are bounded before frame rates are resolved', () => {
  const normalized = normalizeCustomQualityProfile({
    ...DEFAULT_CUSTOM_PROFILE, cameraWidth: 9000, cameraHeight: 9000, cameraFps: 144,
    screenWidth: 9000, screenHeight: 9000, screenFps: 144, cameraBitrateKbps: 80001, screenBitrateKbps: 999999,
  });
  for (const kind of ['camera', 'screen'] as const) {
    assert.equal(normalized[`${kind}Width`], 3840);
    assert.equal(normalized[`${kind}Height`], 2160);
    assert.equal(normalized[`${kind}Fps`], kind === 'camera' ? 60 : 120);
    assert.equal(normalized[`${kind}BitrateKbps`], 80000);
  }
  assert.deepEqual(normalizeCustomQualityProfile(normalized), normalized);
  const invalid = normalizeCustomQualityProfile({ ...DEFAULT_CUSTOM_PROFILE, screenFps: NaN,
    screenWidth: Infinity, screenHeight: -1, screenBitrateKbps: 149 });
  assert.equal(invalid.screenFps, DEFAULT_CUSTOM_PROFILE.screenFps);
  assert.equal(invalid.screenWidth, DEFAULT_CUSTOM_PROFILE.screenWidth);
  assert.equal(invalid.screenHeight, 2);
  assert.equal(invalid.screenBitrateKbps, 150);
  assert.equal(normalizeCustomQualityProfile({ ...DEFAULT_CUSTOM_PROFILE, screenBitrateKbps: 12345 }).screenBitrateKbps, 12300);
});

test('old custom preferences and saved profiles cannot bypass current ceilings', () => {
  withSettingsStorage(storage => {
    storage.setItem('monky_settings', JSON.stringify({ customProfile: {
      ...DEFAULT_CUSTOM_PROFILE, screenWidth: 3840, screenHeight: 2160, screenFps: 120, screenBitrateKbps: 100000,
    } }));
    const store = new SettingsStore();
    assert.equal(store.customProfile.screenFps, 120);
    assert.equal(store.customProfile.screenBitrateKbps, 80000);
    store.customProfile.screenFps = 144;
    store.customProfile.cameraWidth = 6000;
    store.save();
    const loaded = new SettingsStore();
    assert.equal(loaded.customProfile.screenFps, 120);
    assert.equal(loaded.customProfile.cameraWidth, 3840);
    assert.equal(JSON.parse(storage.getItem('monky_settings')!).customProfile.screenFps, 120);
  });
});

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

for (const platform of ['win32', 'darwin']) {
  test(`screen receiver defaults and explicit persistence on ${platform}`, () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { platform } } });
    try {
      withSettingsStorage(storage => {
        const defaultReceiver = platform === 'darwin' ? 'chromium' : 'native';
        const store = new SettingsStore();
        assert.equal(store.getScreenShareReceiver(), defaultReceiver);
        assert.equal(store.nativeScreenReceiverComingSoon, platform === 'darwin');
        storage.setItem('monky_settings', JSON.stringify({ screenShareReceiver: 'automatic' }));
        store.load(false);
        assert.equal(store.getScreenShareReceiver(), defaultReceiver);
        store.setScreenShareReceiver('chromium');
        assert.equal(new SettingsStore().getScreenShareReceiver(), 'chromium');
        if (platform === 'darwin') {
          assert.throws(() => store.setScreenShareReceiver('native'), /unavailable/);
          storage.setItem('monky_settings', JSON.stringify({ screenShareReceiver: 'native' }));
          store.load(false);
          assert.equal(store.getScreenShareReceiver(), 'chromium');
        } else {
          store.setScreenShareReceiver('native');
          assert.equal(new SettingsStore().getScreenShareReceiver(), 'native');
        }
        storage.clear();
        store.load(false);
        assert.equal(store.getScreenShareReceiver(), defaultReceiver, 'Cleared preferences must restore the platform default.');
      });
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

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

test('soundboard limiting is opt-in and preserves its local ceiling across restarts', () => {
  withSettingsStorage((storage) => {
    const settings = new SettingsStore();
    assert.equal(settings.soundboardLimiterEnabled, false);
    assert.equal(settings.soundboardLoudnessLimit, 6);
    settings.soundboardLimiterEnabled = true;
    settings.soundboardLoudnessLimit = 4;
    settings.save();
    const reloaded = new SettingsStore();
    assert.equal(reloaded.soundboardLimiterEnabled, true);
    assert.equal(reloaded.soundboardLoudnessLimit, 4);
    storage.removeItem('monky_settings');
    reloaded.load(false);
    assert.equal(reloaded.soundboardLimiterEnabled, false);
    assert.equal(reloaded.soundboardLoudnessLimit, 6);
  });
});

test('corrupt soundboard limiter preferences cannot become invalid audio parameters', () => {
  withSettingsStorage((storage) => {
    for (const value of [null, 'loud', 0, 11, 2.5, -6, {}, []]) {
      storage.setItem('monky_settings', JSON.stringify({
        soundboardLimiterEnabled: 'true', soundboardLoudnessLimit: value,
      }));
      const settings = new SettingsStore();
      assert.equal(settings.soundboardLimiterEnabled, false);
      assert.equal(settings.soundboardLoudnessLimit, 6);
    }
    for (const value of [1, 6, 10]) {
      storage.setItem('monky_settings', JSON.stringify({
        soundboardLimiterEnabled: true, soundboardLoudnessLimit: value,
      }));
      assert.equal(new SettingsStore().soundboardLoudnessLimit, value);
    }
  });
});

test('unreleased peak-ceiling preferences are not interpreted as a loudness level', () => {
  withSettingsStorage((storage) => {
    storage.setItem('monky_settings', JSON.stringify({
      soundboardLimiterEnabled: true, soundboardLimiterCeilingDb: -30,
    }));
    const settings = new SettingsStore();
    assert.equal(settings.soundboardLimiterEnabled, true);
    assert.equal(settings.soundboardLoudnessLimit, 6);
    settings.save();
    assert.equal(Object.hasOwn(JSON.parse(storage.getItem('monky_settings')!), 'soundboardLimiterCeilingDb'), false);
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
