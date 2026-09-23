import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMERA_EFFECT_MODES, CameraEffectError, DEFAULT_CAMERA_EFFECT_SETTINGS,
  applyChromaKey, cameraCaptureError, cameraEffectFrameRate, fitCameraEffectSize, isCameraEffectMode,
  needsBackgroundImage, needsPersonSegmentation, restoreCameraEffectSettings, smoothStep, writePersonMask,
} from '../src/renderer/utils/cameraEffects';
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
