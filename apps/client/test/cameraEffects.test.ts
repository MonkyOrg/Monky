import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMERA_EFFECT_MODES, CameraEffectError, CameraFrameAdmission, DEFAULT_CAMERA_EFFECT_SETTINGS,
  applyChromaKey, backgroundImageRect, backgroundPositionForOffset, cameraCaptureError, cameraEffectFrameRate,
  fitCameraEffectSize, isCameraEffectMode, needsBackgroundImage, needsCameraProcessing, needsPersonSegmentation,
  restoreCameraEffectSettings, smoothStep, writePersonMask, zoomBackgroundAt,
} from '../src/renderer/utils/cameraEffects';
import { ProminentPersonTracker } from '../src/renderer/utils/cameraPersonFocus';
import { cameraImageDimensions, validateStoredCameraBackground } from '../src/renderer/utils/cameraBackgroundImage';
import { CameraEffectsStore } from '../src/renderer/stores/cameraEffectsStore';
import { COLOR_PRESETS, hexToHsv, hsvToHex, isHexColor, normalizeHexColor } from '../src/renderer/utils/colors';

const defaults = () => ({ ...DEFAULT_CAMERA_EFFECT_SETTINGS });
const isSettingsError = (error: unknown) => error instanceof CameraEffectError && error.code === 'settings';

test('the shared color picker normalizes user HEX input without weakening persisted-color validation', () => {
  assert.equal(normalizeHexColor(' #0F0 '), '#00ff00');
  assert.equal(normalizeHexColor('AbC123'), '#abc123');
  assert.equal(normalizeHexColor('#FFF'), '#ffffff');
  for (const input of ['', '#', 'red', 'rgba(1,2,3,1)', '#1234', '#12345678', 'url(x)', '<svg>']) {
    assert.equal(normalizeHexColor(input), null);
  }
  assert.equal(isHexColor('#fff'), false);
  assert.equal(isHexColor('#ABCDEF'), true);
  for (const preset of COLOR_PRESETS) assert.equal(isHexColor(preset), true);
});

test('shared HSV controls represent primary colors, gray and black accurately', () => {
  for (const [h, hex] of [[0, '#ff0000'], [60, '#ffff00'], [120, '#00ff00'], [180, '#00ffff'], [240, '#0000ff'], [300, '#ff00ff']] as const) {
    assert.equal(hsvToHex({ h, s: 100, v: 100 }), hex);
    assert.deepEqual(hexToHsv(hex), { h, s: 100, v: 100 });
  }
  assert.deepEqual(hexToHsv('#000000', 240), { h: 240, s: 0, v: 0 });
  assert.deepEqual(hexToHsv('#ffffff', 120), { h: 120, s: 0, v: 100 });
  assert.equal(hsvToHex({ h: 360, s: 100, v: 100 }), '#ff0000');
  assert.equal(hsvToHex({ h: -120, s: 100, v: 100 }), '#0000ff');
  assert.equal(hsvToHex({ h: 30, s: -5, v: 200 }), '#ffffff');
  assert.equal(hsvToHex({ h: 90, s: 200, v: -10 }), '#000000');
});

test('shared RGB/HSV conversion round trips preserve exact selected colors', () => {
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        const color = `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
        assert.equal(hsvToHex(hexToHsv(color)), color);
      }
    }
  }
});

test('shared color conversion rejects malformed numeric and text inputs explicitly', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => hsvToHex({ h: value, s: 50, v: 50 }), RangeError);
    assert.throws(() => hsvToHex({ h: 50, s: value, v: 50 }), RangeError);
    assert.throws(() => hsvToHex({ h: 50, s: 50, v: value }), RangeError);
  }
  assert.throws(() => hexToHsv('transparent'), RangeError);
});

test('camera effects default to Off and preserve all four explicit effect choices', () => {
  assert.equal(defaults().mode, 'off');
  assert.equal(defaults().limitQuality, false);
  assert.deepEqual(CAMERA_EFFECT_MODES, ['off', 'blur', 'color', 'image', 'chroma']);
  for (const mode of CAMERA_EFFECT_MODES) {
    assert.equal(restoreCameraEffectSettings({ ...defaults(), mode }).mode, mode);
    assert.equal(isCameraEffectMode(mode), true);
  }
  assert.equal(isCameraEffectMode('green-screen'), false);
  assert.equal(needsPersonSegmentation('chroma'), false, 'physical chroma must not become an AI green backdrop');
  assert.equal(needsPersonSegmentation('off'), false);
  for (const mode of ['blur', 'color', 'image'] as const) assert.equal(needsPersonSegmentation(mode), true);
  assert.equal(needsBackgroundImage({ ...defaults(), mode: 'image' }), true);
  assert.equal(needsBackgroundImage({ ...defaults(), mode: 'chroma', backgroundSource: 'image' }), true);
  assert.equal(needsBackgroundImage({ ...defaults(), mode: 'chroma', backgroundSource: 'color' }), false);
});

test('corrupt saved privacy choices reject instead of silently becoming Off', () => {
  for (const value of [null, undefined, false, [], 'blur', {}, { ...defaults(), mode: 'unknown' }]) {
    assert.throws(() => restoreCameraEffectSettings(value), isSettingsError);
  }
  for (const patch of [
    { backgroundColor: 'url(https://invalid.example/image)' }, { backgroundColor: '#fff' },
    { keyColor: '<svg>' }, { backgroundSource: 'transparent' }, { maxFps: 1000 }, { maxFps: NaN },
    { blurRadius: Infinity }, { personThreshold: -1 }, { edgeSoftness: 101 },
    { keyTolerance: 0 }, { keySoftness: 0 }, { spillReduction: -2 },
    { limitFpsTo30: 'false' }, { limitFpsTo30: 0 }, { limitFpsTo30: null }, { limitFpsTo30: undefined },
    { limitQuality: 'false' }, { limitQuality: 0 }, { limitQuality: null }, { limitQuality: undefined },
  ]) {
    assert.throws(() => restoreCameraEffectSettings({ ...defaults(), ...patch }), isSettingsError);
  }
  assert.equal(restoreCameraEffectSettings({ ...defaults(), backgroundColor: '#00FF00' }).backgroundColor, '#00ff00');
});

test('valid legacy FPS settings migrate to profile FPS without changing privacy choices', () => {
  const { limitQuality: _limit, ...legacy } = defaults();
  for (const mode of CAMERA_EFFECT_MODES) {
    for (const maxFps of [5, 15, 15.5, 24]) {
      const restored = restoreCameraEffectSettings({
        ...legacy, mode, maxFps, backgroundSource: 'image', backgroundColor: '#112233', blurRadius: 28,
      });
      assert.deepEqual(restored, {
        ...defaults(), mode, backgroundSource: 'image', backgroundColor: '#112233', blurRadius: 28,
      });
      assert.equal('maxFps' in restored, false);
      assert.equal(cameraEffectFrameRate(60, restored.limitQuality), 60);
    }
  }
  assert.equal(restoreCameraEffectSettings({ ...defaults(), limitQuality: true }).limitQuality, true);
  assert.equal(restoreCameraEffectSettings({ ...legacy, maxFps: 15, limitFpsTo30: true }).limitQuality, true);
});

test('settings saved before mirror, person focus and framing existed load with their defaults', () => {
  const {
    mirror: _mirror, personFocus: _focus, backgroundZoom: _zoom, backgroundPositionX: _x, backgroundPositionY: _y, ...older
  } = defaults();
  assert.deepEqual(restoreCameraEffectSettings({ ...older, mode: 'image' }), { ...defaults(), mode: 'image' });
  const chosen = { ...defaults(), mirror: true, personFocus: 'main', backgroundZoom: 250, backgroundPositionX: 12.5, backgroundPositionY: 100 };
  assert.deepEqual(restoreCameraEffectSettings(chosen), chosen);
  for (const patch of [
    { mirror: 'true' }, { mirror: null }, { personFocus: 'nearest' }, { personFocus: null },
    { backgroundZoom: 99 }, { backgroundZoom: 401 }, { backgroundZoom: NaN },
    { backgroundPositionX: -1 }, { backgroundPositionY: 101 }, { backgroundPositionX: '50' },
  ]) {
    assert.throws(() => restoreCameraEffectSettings({ ...defaults(), ...patch }), isSettingsError);
  }
});

test('mirroring alone still routes the camera through the processor', () => {
  assert.equal(needsCameraProcessing(defaults()), false);
  assert.equal(needsCameraProcessing({ ...defaults(), mirror: true }), true);
  for (const mode of CAMERA_EFFECT_MODES.filter((value) => value !== 'off')) {
    assert.equal(needsCameraProcessing({ ...defaults(), mode }), true);
  }
});

const framing = (backgroundZoom: number, backgroundPositionX: number, backgroundPositionY: number) =>
  ({ backgroundZoom, backgroundPositionX, backgroundPositionY });

test('the background image covers the frame at any zoom and position, and dragging inverts the placement', () => {
  // `+ 0` turns -0 into 0: both place the image at the same pixel.
  const place = (...args: Parameters<typeof backgroundImageRect>) => {
    const { x, y, width, height } = backgroundImageRect(...args);
    return { x: x + 0, y: y + 0, width, height };
  };
  assert.deepEqual(place(40, 40, 120, 40, framing(100, 50, 50)), { x: -40, y: 0, width: 120, height: 40 });
  assert.deepEqual(place(40, 40, 120, 40, framing(200, 0, 0)), { x: 0, y: 0, width: 240, height: 80 });
  assert.deepEqual(place(40, 40, 120, 40, framing(200, 100, 100)), { x: -200, y: -40, width: 240, height: 80 });
  for (const zoom of [100, 175, 400]) {
    for (const position of [0, 33, 100]) {
      const rect = backgroundImageRect(64, 36, 30, 50, framing(zoom, position, position));
      assert.ok(rect.x <= 0 && rect.y <= 0 && rect.x + rect.width >= 64 - 1e-9 && rect.y + rect.height >= 36 - 1e-9);
      assert.ok(Math.abs(backgroundPositionForOffset(36, rect.height, rect.y) - position) < 1e-9);
    }
  }
  assert.equal(backgroundPositionForOffset(40, 40, 0), 50, 'An axis without slack stays centered');
  assert.equal(backgroundPositionForOffset(40, 120, 30), 0, 'Dragging past an edge stops at that edge');
  assert.equal(backgroundPositionForOffset(40, 120, -500), 100);
  for (const size of [0, -1, NaN, Infinity]) {
    assert.throws(() => backgroundImageRect(size, 40, 120, 40, framing(100, 50, 50)), (error: unknown) =>
      error instanceof CameraEffectError && error.code === 'processing');
  }
});

test('zooming around a point keeps the image under it and never uncovers the frame', () => {
  const at = (settings: ReturnType<typeof framing>, zoom: number, x: number, y: number) =>
    zoomBackgroundAt(64, 36, 128, 72, settings, zoom, x, y);
  const imageFraction = (settings: ReturnType<typeof framing>, x: number, y: number) => {
    const rect = backgroundImageRect(64, 36, 128, 72, settings);
    return [(x - rect.x) / rect.width, (y - rect.y) / rect.height];
  };
  const zoomed = at(framing(100, 50, 50), 200, 16, 9);
  assert.deepEqual(zoomed, framing(200, 25, 25));
  assert.deepEqual(imageFraction(zoomed, 16, 9), imageFraction(framing(100, 50, 50), 16, 9));
  assert.deepEqual(at(framing(100, 50, 50), 300, 32, 18), framing(300, 50, 50), 'The center zooms in place');
  assert.deepEqual(at(framing(400, 0, 0), 200, 64, 36), framing(200, 0, 0), 'Zooming out stops at the frame edges');
  assert.deepEqual(at(framing(200, 10, 90), 100, 5, 5), framing(100, 50, 50), 'Without slack the image is centered');
  assert.equal(at(framing(100, 50, 50), 1000, 0, 0).backgroundZoom, 400);
  assert.equal(at(framing(150, 50, 50), 10, 0, 0).backgroundZoom, 100);
});

/** A matte drawn from rows of text: '#' is a person, '.' is background. */
function matte(rows: string[]): { alpha: Float32Array; width: number; height: number } {
  const width = rows[0].length;
  const alpha = new Float32Array(rows.length * width);
  rows.forEach((row, y) => [...row].forEach((cell, x) => { alpha[y * width + x] = cell === '#' ? 0.9 : 0; }));
  return { alpha, width, height: rows.length };
}

function kept(weights: Float32Array, width: number, x: number, y: number): boolean {
  return weights[y * width + x] === 1;
}

test('the main person is the largest one, and the margin around them never reaches another person', () => {
  const tracker = new ProminentPersonTracker();
  const { alpha, width, height } = matte([
    '##.......###',
    '##.......###',
    '.........###',
    '.........###',
  ]);
  const weights = tracker.select(alpha, width, height);
  assert.ok(kept(weights, width, 10, 2), 'The largest person is kept');
  assert.ok(kept(weights, width, 8, 1), 'Soft edges around the main person are kept');
  assert.ok(!kept(weights, width, 0, 0) && !kept(weights, width, 1, 1), 'The smaller person gets the background effect');
  assert.ok(!kept(weights, width, 4, 3), 'Far background is not kept');

  const touching = matte([
    '##.###',
    '#####.',
  ]);
  const neighbor = new ProminentPersonTracker().select(touching.alpha, touching.width, touching.height);
  assert.ok([...neighbor].every((value, index) => value === 1 || touching.alpha[index] === 0),
    'People touching each other form a single region');

  const close = matte(['###...##', '###...##']);
  const margin = new ProminentPersonTracker().select(close.alpha, close.width, close.height);
  assert.ok(kept(margin, close.width, 4, 0), 'Background beside the main person is kept as its edge');
  assert.ok(!kept(margin, close.width, 6, 0), 'Even within the margin, another person is excluded');
});

test('focus stays on the current person while comparable in size and resets without anyone in view', () => {
  const tracker = new ProminentPersonTracker();
  const first = matte(['###.......##', '###.......##', '###.......##']);
  assert.ok(kept(tracker.select(first.alpha, first.width, first.height), first.width, 0, 0));
  // The other person grows a little larger: the current one keeps the focus.
  const similar = matte(['###.....####', '###.....####', '###.....####']);
  const weights = tracker.select(similar.alpha, similar.width, similar.height);
  assert.ok(kept(weights, similar.width, 0, 0) && !kept(weights, similar.width, 11, 0));
  // The other person becomes clearly larger: the focus moves.
  const larger = matte(['#.....######', '#.....######', '#.....######']);
  const moved = tracker.select(larger.alpha, larger.width, larger.height);
  assert.ok(kept(moved, larger.width, 11, 0) && !kept(moved, larger.width, 0, 0));

  const empty = matte(['....', '....']);
  assert.ok(tracker.select(empty.alpha, empty.width, empty.height).every((value) => value === 1),
    'Without anyone clearly present the matte is left untouched');
  assert.throws(() => tracker.select(new Float32Array(3), 2, 2), (error: unknown) =>
    error instanceof CameraEffectError && error.code === 'processing');
});

test('the prior FPS-only switch migrates to the combined quality policy without losing its choice', () => {
  const { limitQuality: _limit, ...legacy } = defaults();
  for (const mode of CAMERA_EFFECT_MODES) {
    for (const limitFpsTo30 of [false, true]) {
      const restored = restoreCameraEffectSettings({
        ...legacy, mode, limitFpsTo30, keyColor: '#808080', keyTolerance: 31, backgroundSource: 'image',
      });
      assert.deepEqual(restored, {
        ...defaults(), mode, limitQuality: limitFpsTo30, keyColor: '#808080', keyTolerance: 31, backgroundSource: 'image',
      });
      assert.equal('limitFpsTo30' in restored, false);
      assert.equal('maxFps' in restored, false);
    }
  }
  for (const limitQuality of [false, true]) {
    assert.equal(restoreCameraEffectSettings({
      ...legacy, limitQuality, limitFpsTo30: !limitQuality, maxFps: 15,
    }).limitQuality, limitQuality, 'A valid canonical choice takes precedence over valid legacy fields');
  }
});

test('FPS migration never repairs malformed settings or ignores an invalid explicit choice', () => {
  const { limitQuality: _limit, ...legacy } = defaults();
  for (const maxFps of [undefined, null, '15', 0, 4, 25, NaN, Infinity]) {
    assert.throws(() => restoreCameraEffectSettings({ ...legacy, maxFps }), isSettingsError);
    assert.throws(() => restoreCameraEffectSettings({ ...defaults(), maxFps }), isSettingsError);
  }
  assert.throws(() => restoreCameraEffectSettings(legacy), isSettingsError);
  assert.throws(() => restoreCameraEffectSettings({ ...legacy, maxFps: 15, limitFpsTo30: 'false' }), isSettingsError);
  assert.throws(() => restoreCameraEffectSettings({ ...legacy, maxFps: 15, mode: 'unknown' }), isSettingsError);
  for (const invalid of [undefined, null, 0, 'true']) {
    assert.throws(() => restoreCameraEffectSettings({ ...legacy, limitFpsTo30: invalid }), isSettingsError);
    assert.throws(() => restoreCameraEffectSettings({ ...legacy, limitFpsTo30: true, limitQuality: invalid }), isSettingsError);
  }
});

test('effect cadence follows the selected profile unless the combined quality limit is enabled', () => {
  for (const fps of [12, 20, 24, 30, 60, 120]) {
    assert.equal(cameraEffectFrameRate(fps, false), fps);
    assert.equal(cameraEffectFrameRate(fps, true), Math.min(fps, 30));
  }
  for (const fps of [0, -1, NaN, Infinity]) {
    assert.throws(() => cameraEffectFrameRate(fps, false), isSettingsError);
    assert.throws(() => cameraEffectFrameRate(fps, true), isSettingsError);
  }
});

test('frame admission follows capture timestamps, never duplicating frames or drifting with batched delivery', () => {
  for (const [sourceFps, targetFps, expected] of [[60, 30, 30], [120, 30, 30], [30, 30, 30], [30, 60, 30], [24, 20, 20]]) {
    const admission = new CameraFrameAdmission();
    let admitted = 0;
    for (let frame = 0; frame < sourceFps * 5; frame++) {
      const jitter = frame % 2 ? -0.1 : 0.1;
      if (admission.admit(frame * 1000 / sourceFps + jitter, targetFps) && frame >= sourceFps) admitted++;
    }
    assert.ok(Math.abs(admitted / 4 - expected) <= 1, `${sourceFps} -> ${targetFps} FPS admitted ${admitted / 4}`);
  }
  const admission = new CameraFrameAdmission();
  assert.equal(admission.admit(0, 30), true);
  assert.equal(admission.admit(10, 30), false, 'A frame before the next slot is dropped');
  assert.equal(admission.admit(500, 30), true, 'A late frame after a stall is admitted once');
  assert.equal(admission.admit(501, 30), false, 'A stall never releases a burst of catch-up frames');
  admission.reset();
  assert.equal(admission.admit(502, 30), true, 'A reset cadence admits the next frame immediately');
});

test('image-size defaults remain bounded while explicit output profiles are not unconditionally capped', () => {
  assert.deepEqual(fitCameraEffectSize(3840, 2160), { width: 1280, height: 720 });
  assert.deepEqual(fitCameraEffectSize(1920, 1080, 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(fitCameraEffectSize(3840, 2160, 3840, 2160), { width: 3840, height: 2160 });
  assert.deepEqual(fitCameraEffectSize(1920, 1080, 640, 480), { width: 640, height: 360 });
  assert.deepEqual(fitCameraEffectSize(640, 360, 1920, 1080), { width: 640, height: 360 });
  assert.deepEqual(fitCameraEffectSize(1, 1, 1920, 1080), { width: 1, height: 1 });
  assert.deepEqual(fitCameraEffectSize(1, 180, 1920, 1080), { width: 1, height: 180 });
  assert.deepEqual(fitCameraEffectSize(1080, 1920), { width: 404, height: 720 });
  assert.deepEqual(fitCameraEffectSize(321, 181), { width: 320, height: 180 });
  for (const [width, height] of [[0, 100], [0.5, 100], [-1, 2], [NaN, 100], [Infinity, 100]]) {
    assert.throws(() => fitCameraEffectSize(width, height), CameraEffectError);
  }
});

test('person masks use foreground confidence with an adjustable threshold and feather', () => {
  const confidence = new Float32Array([0.1, 0.55, 0.95]);
  const rgba = new Uint8ClampedArray(12);
  writePersonMask(confidence, rgba, 55, 10);
  assert.deepEqual([...rgba], [255, 255, 255, 0, 255, 255, 255, 128, 255, 255, 255, 255]);
  writePersonMask(confidence, rgba, 70, 0);
  assert.deepEqual([rgba[3], rgba[7], rgba[11]], [0, 0, 255]);
  assert.throws(() => writePersonMask(new Float32Array([NaN]), new Uint8ClampedArray(4), 55, 10), CameraEffectError);
  assert.throws(() => writePersonMask(confidence, new Uint8ClampedArray(4), 55, 10), CameraEffectError);
  assert.equal(smoothStep(1, 1, 0.9), 0);
  assert.equal(smoothStep(1, 1, 1), 1);
});

test('physical chroma removes light and dark green while preserving neutral and non-key pixels', () => {
  const rgba = new Uint8ClampedArray([
    0, 255, 0, 255, 0, 60, 0, 255, 200, 20, 20, 255,
    255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255,
  ]);
  applyChromaKey(rgba, { ...defaults(), mode: 'chroma' });
  assert.deepEqual([rgba[3], rgba[7], rgba[11], rgba[15], rgba[19], rgba[23]], [0, 0, 255, 255, 255, 255]);
  assert.deepEqual([...rgba.slice(8, 12)], [200, 20, 20, 255]);
});

test('chroma tolerance and green spill suppression remain independently adjustable', () => {
  const pixel = new Uint8ClampedArray([40, 160, 35, 255]);
  const strict = pixel.slice();
  const permissive = pixel.slice();
  applyChromaKey(strict, { ...defaults(), mode: 'chroma', keyTolerance: 5, spillReduction: 0 });
  applyChromaKey(permissive, { ...defaults(), mode: 'chroma', keyTolerance: 60, spillReduction: 0 });
  assert.equal(strict[3], 255);
  assert.equal(permissive[3], 0);
  const spill = pixel.slice();
  applyChromaKey(spill, { ...defaults(), mode: 'chroma', keyTolerance: 5, spillReduction: 100 });
  assert.equal(spill[3], strict[3]);
  assert.ok(spill[1] < strict[1]);
});

test('neutral and near-black keys distinguish luminance and preserve different foregrounds', () => {
  for (const keyColor of ['#000000', '#ffffff', '#808080', '#808182', '#7f8081', '#7f817f', '#010102', '#000005', '#010503', '#fefefd']) {
    const settings = restoreCameraEffectSettings({ ...defaults(), mode: 'chroma', keyColor, spillReduction: 100 });
    const rgb = [1, 3, 5].map(offset => parseInt(keyColor.slice(offset, offset + 2), 16));
    const opposite = rgb[0] >= 128 ? 0 : 255;
    const pixels = new Uint8ClampedArray([
      ...rgb, 255, opposite, opposite, opposite, 255, 255, 0, 0, 255, 0, 255, 0, 255,
    ]);
    applyChromaKey(pixels, settings);
    assert.deepEqual([pixels[3], pixels[7], pixels[11], pixels[15]], [0, 255, 255, 255], keyColor);
    assert.deepEqual([...pixels.slice(12, 16)], [0, 255, 0, 255], 'Neutral keys do not invent green spill suppression');
  }
});

test('dark saturated keys remove exact matches throughout the low-RGB range without near-black bypass', () => {
  for (let r = 0; r < 16; r++) {
    for (let g = 0; g < 16; g++) {
      for (let b = 0; b < 16; b++) {
        const keyColor = `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
        const settings = restoreCameraEffectSettings({ ...defaults(), mode: 'chroma', keyColor, keyTolerance: 5 });
        const pixels = new Uint8ClampedArray([r, g, b, 255, 255, 255, 255, 255]);
        applyChromaKey(pixels, settings);
        assert.equal(pixels[3], 0, keyColor);
        assert.deepEqual([...pixels.slice(4)], [255, 255, 255, 255], keyColor);
      }
    }
  }
});

test('neutral-key lighting tolerance and soft edges are adjustable without changing RGB colors', () => {
  const pixel = new Uint8ClampedArray([176, 176, 176, 255]);
  for (const [keyTolerance, keySoftness, expected] of [[5, 1, 255], [25, 1, 0]] as const) {
    const result = pixel.slice();
    applyChromaKey(result, { ...defaults(), mode: 'chroma', keyColor: '#808080', keyTolerance, keySoftness });
    assert.equal(result[3], expected);
    assert.deepEqual([...result.slice(0, 3)], [176, 176, 176]);
  }
  const soft = pixel.slice();
  applyChromaKey(soft, { ...defaults(), mode: 'chroma', keyColor: '#808080', keyTolerance: 15, keySoftness: 10 });
  assert.ok(soft[3] > 0 && soft[3] < 255);
});

test('the full RGB key range persists and removes exact matching pixels, including black and near-neutral colors', () => {
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        const keyColor = `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
        const settings = restoreCameraEffectSettings({ ...defaults(), mode: 'chroma', keyColor });
        const pixel = new Uint8ClampedArray([r, g, b, 255]);
        applyChromaKey(pixel, settings);
        assert.equal(settings.keyColor, keyColor);
        assert.equal(pixel[3], 0, keyColor);
      }
    }
  }
  for (const keyColor of ['#gggggg', 'black', '#000', '', '#00000000']) {
    assert.throws(() => applyChromaKey(new Uint8ClampedArray(4), { ...defaults(), keyColor }), isSettingsError);
  }
  assert.throws(() => applyChromaKey(new Uint8ClampedArray(3), defaults()), CameraEffectError);
});

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('image headers are bounded before decoding, including dishonest MIME types', () => {
  assert.deepEqual(cameraImageDimensions(png(1920, 1080), 'image/png'), { width: 1920, height: 1080 });
  assert.throws(() => cameraImageDimensions(png(20000, 20000), 'image/png'),
    (error: unknown) => error instanceof CameraEffectError && error.code === 'imageSize');
  assert.throws(() => cameraImageDimensions(png(8192, 8192), 'image/png'),
    (error: unknown) => error instanceof CameraEffectError && error.code === 'imageSize');
  for (const [bytes, mime] of [
    [png(10, 10), 'image/jpeg'],
    [new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'],
    [new TextEncoder().encode('<svg onload="alert(1)"></svg>'), 'image/png'],
    [png(10, 10), 'image/svg+xml'],
  ] as const) assert.throws(() => cameraImageDimensions(bytes, mime), CameraEffectError);
});

test('JPEG and WebP dimensions are parsed without loading an image decoder', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 9, 8, 0, 90, 1, 64, 1, 1, 0xff, 0xd9]);
  assert.deepEqual(cameraImageDimensions(jpeg, 'image/jpeg'), { width: 320, height: 90 });
  const webp = new Uint8Array(30);
  const view = new DataView(webp.buffer);
  view.setUint32(0, 0x52494646);
  view.setUint32(8, 0x57454250);
  view.setUint32(12, 0x56503858);
  view.setUint32(16, 10, true);
  webp[24] = 63;
  webp[25] = 1;
  webp[27] = 89;
  assert.deepEqual(cameraImageDimensions(webp, 'image/webp'), { width: 320, height: 90 });
});

test('saved images cannot exceed the normalized processing dimensions', async () => {
  const image = (width: number, height: number) => ({
    id: 'fixture', name: 'fixture.png', blob: new Blob([png(width, height)], { type: 'image/png' }),
  });
  await validateStoredCameraBackground(image(1280, 720));
  await assert.rejects(validateStoredCameraBackground(image(1282, 720)),
    (error: unknown) => error instanceof CameraEffectError && error.code === 'imageSize');
  await assert.rejects(validateStoredCameraBackground(image(720, 1280)),
    (error: unknown) => error instanceof CameraEffectError && error.code === 'imageSize');
});

test('unavailable persistent storage does not masquerade as an Off preference', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    const store = new CameraEffectsStore();
    await assert.rejects(store.load(), (error: unknown) => error instanceof CameraEffectError && error.code === 'storage');
    assert.equal(store.isLoaded, false);
    await assert.rejects(store.update({ mode: 'blur' }), CameraEffectError);
    assert.equal(store.isLoaded, false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});

test('device errors retain actionable distinctions without leaking raw Error messages', () => {
  assert.equal(cameraCaptureError(new DOMException('denied', 'NotAllowedError')).code, 'permission');
  assert.equal(cameraCaptureError(new DOMException('missing', 'NotFoundError')).code, 'device');
  const processing = new CameraEffectError('processing');
  assert.equal(cameraCaptureError(processing), processing);
  assert.equal(cameraCaptureError(new Error('device-internal-detail')).code, 'camera');
});
