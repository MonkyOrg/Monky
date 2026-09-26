'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { QUALITY_PRESETS } = require('@monky/shared');
const { fixture, deferred, flush } = require('./fixtures/screenSharingUiModel.cjs');

const control = (f, id) => f.document.querySelector(`#${id}`);
const change = element => element.dispatchEvent(new Event('change', { bubbles: true }));
const copy = value => JSON.parse(JSON.stringify(value));
const unsupported = () => ({ selection: null, hardware: { available: false, reason: 'RAW_DRIVER_UNSUPPORTED' },
  fallback: false, reason: 'RAW_DRIVER_UNSUPPORTED' });
const supported = input => ({
  selection: { mode: input.encodingMode, codec: input.codec,
    encoder: input.encodingMode === 'software' ? input.codec === 'av1' ? 'monky_aom_av1' : 'obs_x264'
      : input.codec === 'av1' ? 'av1_texture_amf' : 'h264_texture_amf' },
  hardware: { available: true, reason: null }, fallback: false,
});
const configure = f => {
  f.settingsStore.qualityPreset = 'CUSTOM';
  f.settingsStore.screenEncodingStrategy = 'manual';
  f.settingsStore.preferredScreenCodec = 'h264';
  f.settingsStore.screenEncodingMode = 'hardware';
  f.settingsStore.customProfile = { ...QUALITY_PRESETS.NORMAL,
    screenWidth: 3840, screenHeight: 2160, screenFps: 120, screenBitrateKbps: 3500,
    cameraWidth: 1280, cameraHeight: 720, cameraFps: 30, cameraBitrateKbps: 1700, audioBitrateKbps: 96 };
};

for (const language of ['en', 'pt-BR']) {
  test(`confirmed H264 4K120 to60 adjustment preserves everything except screen FPS (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    configure(f);
    const original = copy(f.settingsStore.customProfile), probes = [];
    f.controls.encoding = async input => {
      probes.push(copy(input));
      return input.video.fps <= 60 ? supported(input) : unsupported();
    };
    f.mountQuality();
    await flush();
    assert.deepEqual(probes.map(input => input.video.fps), [120, 90, 60]);
    for (const input of probes) {
      assert.equal(input.codec, 'h264');
      assert.equal(input.encodingMode, 'hardware');
      assert.equal(input.encodingStrategy, 'manual');
      assert.deepEqual(input.video, { width: 3840, height: 2160, fps: input.video.fps, maxBitrateKbps: 3500 });
    }
    assert.deepEqual(copy(f.settingsStore.customProfile), { ...original, screenFps: 60 });
    assert.equal(f.settingsStore.preferredScreenCodec, 'h264');
    assert.equal(f.settingsStore.screenEncodingMode, 'hardware');
    assert.equal(f.saves, 1, 'Only the positively verified candidate is persisted.');
    assert.equal(control(f, 'q-select-screenFps').value, '60');
    assert.equal(control(f, 'custom-screenFps').value, '60');
    assert.equal(control(f, 'q-select-cameraFps').value, '30');
    const toast = f.document.querySelector('.chat-copy-toast-label').textContent;
    assert.match(toast, /H264/);
    assert.match(toast, /120/);
    assert.match(toast, /60/);
    assert.doesNotMatch(toast, /Recomendado|Recommended/);
    assert.doesNotMatch(toast, /RAW_DRIVER/);
    assert.equal(control(f, 'screen-encoding-status').getAttribute('aria-busy'), 'false');
    assert.equal(f.traces.filter(trace => trace[0] === 'preset').length, 1);
    f.settingsStore.save();
    await flush();
    assert.equal(probes.length, 3, 'No redundant probe after the confirmed settings commit.');
  });
}

test('supported AV1 4K120 is not lowered and codec edits start the same verified adjustment flow', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.preferredScreenCodec = 'av1';
  const probes = [];
  f.controls.encoding = async input => {
    probes.push([input.codec, input.video.fps]);
    return input.codec === 'av1' || input.video.fps <= 60 ? supported(input) : unsupported();
  };
  f.mountQuality();
  await flush();
  assert.equal(f.settingsStore.customProfile.screenFps, 120);
  assert.equal(f.saves, 0);
  assert.equal(f.document.querySelector('.chat-copy-toast'), null);
  control(f, 'select-video-codec').value = 'h264';
  change(control(f, 'select-video-codec'));
  await flush();
  assert.deepEqual(probes, [['av1', 120], ['h264', 120], ['h264', 90], ['h264', 60]]);
  assert.equal(f.settingsStore.customProfile.screenFps, 60);
});

test('an adjusted named preset becomes CUSTOM with that preset camera/audio/bitrate intact', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.qualityPreset = 'ULTRA';
  const previous = copy(QUALITY_PRESETS.ULTRA);
  f.controls.encoding = async input => input.video.fps < previous.screenFps ? supported(input) : unsupported();
  f.mountQuality();
  await flush();
  assert.equal(f.settingsStore.qualityPreset, 'CUSTOM');
  assert.equal(control(f, 'select-preset').value, 'CUSTOM');
  const { screenFps, ...unchanged } = copy(f.settingsStore.customProfile);
  const { screenFps: before, ...expected } = previous;
  assert.deepEqual(unchanged, expected);
  assert.ok(screenFps < before);
  assert.equal(control(f, 'q-select-screenFps').value, String(screenFps));
});

test('camera edits during a pending screen probe survive the verified FPS commit', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  const candidate = deferred();
  f.controls.encoding = async input => input.video.fps === 120 ? unsupported() : candidate.promise;
  f.mountQuality();
  await flush();
  control(f, 'q-select-cameraFps').value = '60';
  change(control(f, 'q-select-cameraFps'));
  candidate.resolve(supported({ codec: 'h264', encodingMode: 'hardware' }));
  await flush();
  assert.equal(f.settingsStore.customProfile.screenFps, 90);
  assert.equal(f.settingsStore.customProfile.cameraFps, 60);
  assert.equal(control(f, 'q-select-cameraFps').value, '60');
});

test('saving a new codec cancels a pending candidate and does not apply its late success', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  const lower = deferred();
  f.controls.encoding = async input => input.codec === 'av1' ? supported(input)
    : input.video.fps === 120 ? unsupported() : lower.promise;
  f.mountQuality();
  await flush();
  control(f, 'select-video-codec').value = 'av1';
  change(control(f, 'select-video-codec'));
  await flush();
  assert.ok(f.traces.some(trace => trace[0] === 'cancel-encoding'));
  lower.resolve(supported({ codec: 'h264', encodingMode: 'hardware' }));
  await flush();
  assert.equal(f.settingsStore.customProfile.screenFps, 120);
  assert.equal(f.settingsStore.preferredScreenCodec, 'av1');
  assert.equal(f.saves, 1);
  assert.equal(control(f, 'screen-encoding-status').getAttribute('aria-busy'), 'false');
  assert.equal(f.document.querySelector('.chat-copy-toast'), null);
});

test('custom controls rebind to the adjusted profile and live rejection keeps the new baseline', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.controls.encoding = async input => input.video.fps <= 60 ? supported(input) : unsupported();
  f.mountQuality();
  await flush();
  f.controls.settingsError = new Error('Active capture rejected the next user edit.');
  control(f, 'q-select-screenFps').value = '30';
  change(control(f, 'q-select-screenFps'));
  await flush();
  assert.equal(f.settingsStore.customProfile.screenFps, 60);
  assert.equal(control(f, 'q-select-screenFps').value, '60');
  assert.equal(f.saves, 1);
  assert.equal(f.document.querySelector('.chat-copy-toast-label').textContent, f.i18n.t('settings.screenEncodingAdjustmentBlocked'));
});

for (const invalidate of ['codec', 'mode', 'strategy', 'profile', 'cleanup', 'detach']) {
  test(`late compatible FPS cannot mutate stale ${invalidate} selection`, async t => {
    const f = fixture();
    t.after(() => f.close());
    configure(f);
    const lower = deferred();
    let probes = 0;
    f.controls.encoding = async input => {
      probes++;
      return input.codec === 'h264' && input.video.fps === 120 ? unsupported() : lower.promise;
    };
    const root = f.mountQuality();
    await flush();
    assert.equal(probes, 2);
    if (invalidate === 'codec') f.settingsStore.preferredScreenCodec = 'av1';
    if (invalidate === 'mode') f.settingsStore.screenEncodingMode = 'software';
    if (invalidate === 'strategy') f.settingsStore.screenEncodingStrategy = 'automatic';
    if (invalidate === 'profile') f.settingsStore.customProfile = { ...f.settingsStore.customProfile, screenBitrateKbps: 4000 };
    if (invalidate === 'cleanup') f.quality.cleanup();
    if (invalidate === 'detach') root.remove();
    const saved = f.saves;
    lower.resolve(supported({ codec: 'h264', encodingMode: 'hardware' }));
    await flush();
    assert.equal(f.settingsStore.customProfile.screenFps, 120);
    assert.equal(f.saves, saved);
    assert.equal(f.document.querySelector('.chat-copy-toast'), null);
  });
}

for (const failure of ['initial-exception', 'candidate-exception', 'initial-error-result', 'candidate-error-result']) {
  test(`${failure} logs diagnostics with friendly UI but never downgrades`, async t => {
    const f = fixture();
    t.after(() => f.close());
    configure(f);
    const probes = [];
    f.controls.encoding = async input => {
      probes.push(input.video.fps);
      if (input.video.fps === 120 && failure.startsWith('candidate')) return unsupported();
      if (failure.endsWith('exception')) throw new Error('RAW_DRIVER_CRASH');
      return { ...unsupported(), hardware: { available: false, reason: 'RAW_DRIVER_CRASH', error: true } };
    };
    f.mountQuality();
    await flush();
    assert.deepEqual(probes, failure.startsWith('initial') ? [120] : [120, 90]);
    assert.equal(f.settingsStore.customProfile.screenFps, 120);
    assert.equal(f.saves, 0);
    assert.ok(f.warnings.length);
    assert.equal(control(f, 'screen-encoding-status').textContent, f.i18n.t('settings.screenEncodingProbeFailed'));
    assert.doesNotMatch(f.document.body.textContent, /RAW_DRIVER/);
  });
}

test('no supported lower profile leaves preferences unchanged with localized unavailable status', async t => {
  const f = fixture('pt-BR');
  t.after(() => f.close());
  configure(f);
  const original = copy(f.settingsStore.customProfile), probes = [];
  f.controls.encoding = async input => { probes.push(input.video.fps); return unsupported(); };
  f.mountQuality();
  for (let turn = 0; turn < 5; turn++) await flush();
  assert.deepEqual(probes, [120, 90, 60, 48, 30, 24, 20, 15, 10, 5]);
  assert.deepEqual(copy(f.settingsStore.customProfile), original);
  assert.equal(f.saves, 0);
  assert.equal(control(f, 'screen-encoding-status').getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(control(f, 'screen-encoding-status').textContent, /RAW_DRIVER/);
  assert.equal(control(f, 'screen-encoding-status').textContent,
    f.i18n.t('settings.screenEncodingProfileUnavailable', { codec: 'H264', mode: f.i18n.t('settings.screenEncodingHardwareShort') }));
});

for (const mismatch of ['codec', 'mode', 'fallback']) {
  test(`a positive candidate with different ${mismatch} cannot substitute the explicit selection`, async t => {
    const f = fixture();
    t.after(() => f.close());
    configure(f);
    f.controls.encoding = async input => {
      if (input.video.fps === 120) return unsupported();
      const result = supported(input);
      if (mismatch === 'codec') result.selection.codec = 'av1';
      if (mismatch === 'mode') result.selection.mode = 'software';
      if (mismatch === 'fallback') result.fallback = true;
      return result;
    };
    f.mountQuality();
    await flush();
    assert.equal(f.settingsStore.customProfile.screenFps, 120);
    assert.equal(f.settingsStore.preferredScreenCodec, 'h264');
    assert.equal(f.settingsStore.screenEncodingMode, 'hardware');
    assert.equal(f.saves, 0);
    assert.equal(control(f, 'screen-encoding-status').textContent, f.i18n.t('settings.screenEncodingProbeFailed'));
  });
}

for (const stage of ['preflight', 'apply']) {
  test(`live ${stage} failure rolls back FPS/preset without persisting or leaking driver text`, async t => {
    const f = fixture();
    t.after(() => f.close());
    configure(f);
    const original = copy(f.settingsStore.customProfile);
    f.controls.encoding = async input => input.video.fps <= 60 ? supported(input) : unsupported();
    if (stage === 'preflight') f.controls.settingsError = new Error('RAW_DRIVER_LIVE_FAILURE');
    else f.load('core/WebRtcManager').webRtcManager.setQualityPreset = () => { throw new Error('RAW_DRIVER_LIVE_FAILURE'); };
    f.mountQuality();
    await flush();
    assert.equal(f.settingsStore.qualityPreset, 'CUSTOM');
    assert.deepEqual(copy(f.settingsStore.customProfile), original);
    assert.equal(f.saves, 0);
    assert.equal(control(f, 'q-select-screenFps').value, '120');
    assert.equal(control(f, 'screen-encoding-status').getAttribute('aria-busy'), 'false');
    assert.equal(control(f, 'screen-encoding-status').textContent, f.i18n.t('settings.screenEncodingAdjustmentBlocked'));
    assert.equal(f.document.querySelector('.chat-copy-toast-label').textContent, f.i18n.t('settings.screenEncodingAdjustmentBlocked'));
    assert.doesNotMatch(f.document.body.textContent, /RAW_DRIVER/);
    if (stage === 'preflight') assert.equal(f.traces.filter(trace => trace[0] === 'preset').length, 0);
  });
}

test('Automatic retains its existing encoding fallback without changing quality or explicit preferences', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.screenEncodingStrategy = 'automatic';
  let probes = 0;
  f.controls.encoding = async () => {
    probes++;
    return { selection: { mode: 'software', codec: 'av1', encoder: 'monky_aom_av1' },
      hardware: { available: false, reason: 'RAW_DRIVER_UNSUPPORTED' }, fallback: true };
  };
  f.mountQuality();
  await flush();
  assert.equal(probes, 1);
  assert.equal(f.settingsStore.customProfile.screenFps, 120);
  assert.equal(f.settingsStore.preferredScreenCodec, 'h264');
  assert.equal(f.settingsStore.screenEncodingMode, 'hardware');
  assert.equal(f.saves, 0);
  assert.doesNotMatch(control(f, 'screen-encoding-status').textContent, /RAW_DRIVER/);
  assert.equal(control(f, 'screen-encoding-status').textContent, f.i18n.t('settings.screenEncodingHardwareUnavailable'));
  assert.match(JSON.stringify(f.warnings), /RAW_DRIVER_UNSUPPORTED/);
});

const edits = [
  ['resolution dropdown', 'q-res-screen', '3840x2160'],
  ['custom width', 'custom-screenWidth', '3840'],
  ['custom height', 'custom-screenHeight', '2160'],
  ['aspect ratio', 'q-aspect-screen', '21:9'],
  ['FPS dropdown', 'q-select-screenFps', '120'],
  ['custom FPS', 'custom-screenFps', '120'],
  ['bitrate dropdown', 'q-select-screenBitrate', '30000'],
  ['custom bitrate', 'custom-screenBitrate', '25000'],
  ['preset', 'select-preset', 'ULTRA'],
];
for (const [label, id, value] of edits) {
  test(`${label} validates the entire requested profile BEFORE live preflight/apply/persistence`, async t => {
    const f = fixture();
    t.after(() => f.close());
    configure(f);
    f.settingsStore.customProfile = { ...f.settingsStore.customProfile,
      screenWidth: 1920, screenHeight: 1080, screenFps: label.includes('FPS') || label === 'preset' ? 60 : 120 };
    let editing = false;
    const gate = deferred(), probes = [];
    const supportedFps = label === 'preset' ? 30 : 60;
    f.controls.encoding = async input => {
      if (!editing) return supported(input);
      probes.push(copy(input));
      return input.video.fps > supportedFps ? unsupported() : gate.promise;
    };
    f.mountQuality();
    await flush();
    const previous = copy(f.settingsStore.customProfile), saved = f.saves;
    f.traces.length = 0;
    editing = true;
    const field = control(f, id);
    field.value = value;
    change(field);
    await flush();
    assert.ok(probes.length >= 2);
    assert.deepEqual(copy(f.settingsStore.customProfile), previous, 'No speculative live profile is exposed or saved.');
    assert.equal(f.saves, saved);
    assert.equal(f.traces.filter(trace => ['assert-settings', 'preset'].includes(trace[0])).length, 0);
    assert.equal(control(f, 'screen-encoding-status').getAttribute('aria-busy'), 'true');
    const requested = probes[0].video;
    for (const input of probes) assert.deepEqual(input.video, { ...requested, fps: input.video.fps });
    gate.resolve(supported(probes.at(-1)));
    await flush();
    const committed = f.settingsStore.customProfile;
    assert.equal(committed.screenFps, supportedFps);
    assert.equal(committed.screenWidth, requested.width);
    assert.equal(committed.screenHeight, requested.height);
    assert.equal(committed.screenBitrateKbps, requested.maxBitrateKbps);
    const preflight = f.traces.find(trace => trace[0] === 'assert-settings')[1];
    assert.equal(preflight.screenFps, supportedFps, 'Existing live preflight receives the confirmed candidate, not the rejected request.');
    assert.equal(f.traces.filter(trace => trace[0] === 'preset').length, 1);
    assert.equal(f.saves, saved + 1);
    const expectedOtherMedia = label === 'preset' ? QUALITY_PRESETS.ULTRA : previous;
    for (const key of ['cameraWidth', 'cameraHeight', 'cameraFps', 'cameraBitrateKbps', 'audioBitrateKbps'])
      assert.equal(committed[key], expectedOtherMedia[key], key);
    assert.equal(control(f, 'q-select-screenFps').value, String(supportedFps));
    assert.match(f.document.querySelector('.chat-copy-toast-label').textContent, new RegExp(`${requested.fps}.*${supportedFps}`));
  });
}

for (const changeEncoding of ['codec', 'hardware', 'software', 'automatic']) {
  test(`${changeEncoding} selection uses the same verified profile before live reapply`, async t => {
    const f = fixture();
    t.after(() => f.close());
    configure(f);
    if (changeEncoding === 'codec') f.settingsStore.preferredScreenCodec = 'av1';
    if (changeEncoding === 'hardware') f.settingsStore.screenEncodingMode = 'software';
    let editing = false;
    const gate = deferred(), probes = [];
    f.controls.encoding = async input => {
      if (!editing) {
        const result = supported(input);
        if (changeEncoding === 'hardware') result.hardware = { available: false, reason: 'RAW_DRIVER_UNSUPPORTED' };
        return result;
      }
      probes.push(copy(input));
      return input.video.fps > 60 ? unsupported() : gate.promise;
    };
    f.mountQuality();
    await flush();
    f.traces.length = 0;
    editing = true;
    if (changeEncoding === 'codec') {
      control(f, 'select-video-codec').value = 'h264';
      change(control(f, 'select-video-codec'));
    } else control(f, `screen-encoding-${changeEncoding}`).click();
    await flush();
    assert.deepEqual(probes.map(input => input.video.fps), [120, 90, 60]);
    assert.equal(f.settingsStore.customProfile.screenFps, 120);
    assert.equal(f.traces.filter(trace => ['assert-settings', 'preset'].includes(trace[0])).length, 0);
    gate.resolve(supported(probes.at(-1)));
    await flush();
    assert.equal(f.settingsStore.customProfile.screenFps, 60);
    assert.equal(f.traces.find(trace => trace[0] === 'assert-settings')[1].screenFps, 60);
    assert.equal(f.traces.filter(trace => trace[0] === 'preset').length, 1);
    assert.equal(f.settingsStore.screenEncodingMode, changeEncoding === 'software' ? 'software' : 'hardware');
    assert.equal(f.settingsStore.preferredScreenCodec, 'h264');
  });
}

test('unsupported bitrate is never invented or lowered: exhaust probes then restore the prior profile', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.customProfile.screenFps = 60;
  const previous = copy(f.settingsStore.customProfile), probes = [];
  f.controls.encoding = async input => {
    probes.push(copy(input));
    return input.video.maxBitrateKbps === previous.screenBitrateKbps ? supported(input) : unsupported();
  };
  f.mountQuality();
  await flush();
  probes.length = 0;
  f.traces.length = 0;
  control(f, 'custom-screenBitrate').value = '80000';
  change(control(f, 'custom-screenBitrate'));
  for (let turn = 0; turn < 5; turn++) await flush();
  assert.ok(probes.length > 1);
  assert.ok(probes.every(input => input.video.maxBitrateKbps === 80000));
  assert.deepEqual(copy(f.settingsStore.customProfile), previous);
  assert.equal(control(f, 'custom-screenBitrate').value, String(previous.screenBitrateKbps));
  assert.equal(f.saves, 0);
  assert.equal(f.traces.filter(trace => trace[0] === 'preset').length, 0);
  assert.ok(f.warnings.length);
  const toast = f.document.querySelector('.chat-copy-toast-label').textContent;
  assert.equal(toast, f.i18n.t('settings.screenEncodingProfileUnavailable', {
    codec: 'H264', mode: f.i18n.t('settings.screenEncodingHardwareShort'),
  }));
  assert.doesNotMatch(toast, /RAW_DRIVER|adjusted/i);
});

test('camera/audio numeric clamps retain existing limits and reuse only the identical verified screen profile', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.customProfile.screenFps = 60;
  let probes = 0;
  f.controls.encoding = async input => { probes++; return supported(input); };
  f.mountQuality();
  await flush();
  const before = copy(f.settingsStore.customProfile);
  for (const [id, value, key, expected] of [
    ['custom-cameraFps', '500', 'cameraFps', 120],
    ['custom-cameraWidth', '10000', 'cameraWidth', 3840],
    ['custom-audioBitrate', '1000', 'audioBitrateKbps', 510],
  ]) {
    control(f, id).value = value;
    change(control(f, id));
    await flush();
    assert.equal(f.settingsStore.customProfile[key], expected);
    assert.equal(f.document.querySelector('.chat-copy-toast-label').textContent, f.i18n.t('settings.qualityValueAdjusted'));
  }
  assert.equal(f.settingsStore.customProfile.cameraFps, 60, 'The existing camera 4K60 cap remains unchanged.');
  assert.equal(f.settingsStore.customProfile.screenFps, before.screenFps);
  assert.equal(f.settingsStore.customProfile.screenBitrateKbps, before.screenBitrateKbps);
  assert.equal(probes, 1, 'Camera/audio changes do not probe or capture the webcam.');
});

test('newer custom quality edits cancel the old candidate and closing keeps unverified values out of storage', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.customProfile.screenFps = 60;
  const original = copy(f.settingsStore.customProfile), first = deferred(), second = deferred();
  f.controls.encoding = async input => input.video.maxBitrateKbps === 3500 ? supported(input)
    : input.video.maxBitrateKbps === 8000 ? first.promise : second.promise;
  f.mountQuality();
  await flush();
  control(f, 'custom-screenBitrate').value = '8000';
  change(control(f, 'custom-screenBitrate'));
  control(f, 'custom-screenBitrate').value = '9000';
  change(control(f, 'custom-screenBitrate'));
  assert.ok(f.traces.some(trace => trace[0] === 'cancel-encoding'));
  first.resolve(supported({ encodingMode: 'hardware', codec: 'h264' }));
  await flush();
  assert.deepEqual(copy(f.settingsStore.customProfile), original);
  f.quality.cleanup();
  second.resolve(supported({ encodingMode: 'hardware', codec: 'h264' }));
  await flush();
  assert.deepEqual(copy(f.settingsStore.customProfile), original);
  assert.equal(f.saves, 0);
});

test('changing codec during pending resolution validation keeps the new resolution, not the old saved profile', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.customProfile.screenWidth = 1920;
  f.settingsStore.customProfile.screenHeight = 1080;
  const lower = deferred();
  f.controls.encoding = async input => input.codec === 'av1' || input.video.width === 1920 ? supported(input)
    : input.video.fps > 60 ? unsupported() : lower.promise;
  f.mountQuality();
  await flush();
  control(f, 'q-res-screen').value = '3840x2160';
  change(control(f, 'q-res-screen'));
  await flush();
  assert.equal(f.settingsStore.customProfile.screenWidth, 1920);
  control(f, 'select-video-codec').value = 'av1';
  change(control(f, 'select-video-codec'));
  await flush();
  assert.equal(f.settingsStore.customProfile.screenWidth, 3840);
  assert.equal(f.settingsStore.customProfile.screenHeight, 2160);
  assert.equal(f.settingsStore.customProfile.screenFps, 120);
  lower.resolve(supported({ encodingMode: 'hardware', codec: 'h264' }));
  await flush();
  assert.equal(f.settingsStore.customProfile.screenFps, 120);
  assert.equal(f.settingsStore.preferredScreenCodec, 'av1');
  assert.equal(f.document.querySelector('.chat-copy-toast'), null);
});

test('rejected live resolution commit restores both stored profile and requested controls', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.customProfile.screenWidth = 1920;
  f.settingsStore.customProfile.screenHeight = 1080;
  const original = copy(f.settingsStore.customProfile);
  f.controls.encoding = async input => input.video.width === 1920 || input.video.fps <= 60 ? supported(input) : unsupported();
  f.mountQuality();
  await flush();
  f.controls.settingsError = new Error('RAW_DRIVER_LIVE_FAILURE');
  control(f, 'q-res-screen').value = '3840x2160';
  change(control(f, 'q-res-screen'));
  await flush();
  assert.deepEqual(copy(f.settingsStore.customProfile), original);
  assert.equal(control(f, 'q-res-screen').value, '1920x1080');
  assert.equal(control(f, 'q-select-screenFps').value, '120');
  assert.equal(f.saves, 0);
  assert.equal(f.traces.filter(trace => trace[0] === 'preset').length, 0);
  assert.equal(f.document.querySelector('.chat-copy-toast-label').textContent,
    f.i18n.t('settings.screenEncodingAdjustmentBlocked'));
});

test('explicit verified Software remains usable when optional hardware inspection fails', async t => {
  const f = fixture();
  t.after(() => f.close());
  configure(f);
  f.settingsStore.screenEncodingMode = 'software';
  f.controls.encoding = async input => ({ ...supported(input),
    hardware: { available: false, reason: 'RAW_DRIVER_HARDWARE_INSPECTION', error: true } });
  f.mountQuality();
  await flush();
  assert.equal(f.settingsStore.customProfile.screenFps, 120);
  assert.equal(f.saves, 0);
  control(f, 'custom-screenBitrate').value = '8000';
  change(control(f, 'custom-screenBitrate'));
  await flush();
  assert.equal(f.settingsStore.customProfile.screenBitrateKbps, 8000);
  assert.equal(f.settingsStore.customProfile.screenFps, 120);
  assert.equal(f.settingsStore.screenEncodingMode, 'software');
  assert.equal(f.traces.filter(trace => trace[0] === 'preset').length, 1);
  assert.ok(f.warnings.length);
  assert.doesNotMatch(f.document.body.textContent, /RAW_DRIVER/);
});
