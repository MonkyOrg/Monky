import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  NATIVE_SCREEN_IPC, SCREEN_SHARE_FAILURE_CATEGORIES, SCREEN_SHARE_FAILURE_CODES, decodeScreenShareFailure,
  encodeScreenShareFailure, screenShareFailureCategory,
} from '@monky/shared';
import { NativeScreenNotice, rendererFailure } from '../src/main/nativeScreen/errorDiagnostics';
import { setLanguage, t, type SupportedLanguage, type TranslationKey } from '../src/renderer/i18n';
import {
  ScreenShareUserError, screenEncodingFallbackMessage, screenShareFailureMessage,
} from '../src/renderer/utils/screenShareFailure';

const client = path.resolve(__dirname, '..', '..');
const TECHNICAL = /Error invoking remote method|ERR_[A-Z]|monky-screen-failure|native-screen:invoke|Unsafe absolute path/;

/** Every `ERR_SCREEN_*` and `ERR_MAC_*` code the native runtimes, screen audio and Main can raise, read from their sources. */
function sourceCodes(): Set<string> {
  const codes = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'build', 'test'].includes(entry.name)) visit(file); }
      else if (/\.(?:cpp|cc|h|hpp|mm|m|cjs|js|ts)$/.test(entry.name))
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bERR_(?:SCREEN|MAC)_[A-Z0-9_]*[A-Z0-9]\b/g)) codes.add(match[0]);
    }
  };
  for (const directory of ['native/screen-share/src', 'native/screen-share/runtime', 'native/screen-audio', 'src/main'])
    visit(path.join(client, directory));
  return codes;
}

/** A failure as the renderer receives it: Main's error, flattened by Electron's invoke into a message. */
function crossed(error: unknown): Error {
  return new Error(`Error invoking remote method '${NATIVE_SCREEN_IPC.invoke}': ${String(rendererFailure(error))}`);
}
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

/** Fails when two sentences of a message open with the same three words, as "Não foi possível … Não foi possível". */
function assertNoRepeatedOpening(message: string, context: string): void {
  const openings = message.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ')).filter(Boolean);
  assert.equal(new Set(openings).size, openings.length, `${context} repeats a sentence opening: ${message}`);
}
const ACTIONS = ['start', 'stop', 'game-start', 'game-stop'] as const;

test('every native ERR_SCREEN and ERR_MAC code has a category, and the table names no code the sources dropped', () => {
  const codes = sourceCodes();
  assert.ok([...codes].filter(code => code.startsWith('ERR_SCREEN_')).length >= 70, 'The scan is not reading the Windows sources.');
  assert.ok([...codes].filter(code => code.startsWith('ERR_MAC_')).length >= 130, 'The scan is not reading the macOS sources.');
  assert.ok(codes.has('ERR_SCREEN_AUDIO_UNAVAILABLE'), 'The scan is not reading native/screen-audio.');
  // Every code needs a decision, `unexpected` included: that list is explicit too.
  const missing = [...codes].filter(code => !SCREEN_SHARE_FAILURE_CODES.has(code));
  assert.deepEqual(missing, [], 'A new native code needs a category in packages/shared/src/screenShareFailures.ts');
  const stale = [...SCREEN_SHARE_FAILURE_CODES.keys()].filter(code => /^ERR_(?:SCREEN|MAC)_/.test(code) && !codes.has(code));
  assert.deepEqual(stale, []);
  for (const category of SCREEN_SHARE_FAILURE_CATEGORIES)
    assert.ok([...SCREEN_SHARE_FAILURE_CODES.values()].includes(category), `${category} explains no code`);
  for (const [code, category] of [
    ['ERR_MAC_AV1_RUNTIME', 'files'], ['ERR_MAC_HOST_START', 'files'], ['ERR_SCREEN_AUDIO_UNAVAILABLE', 'files'],
    ['ERR_MAC_VIDEO_METAL_UNAVAILABLE', 'encoder'], ['ERR_MAC_CAPTURE_FIRST_FRAME', 'interrupted'],
    ['ERR_MAC_SCREEN_PERMISSION', 'permission'], ['ERR_MAC_SOURCE_LOST', 'source-lost'],
  ] as const) assert.equal(SCREEN_SHARE_FAILURE_CODES.get(code), category, code);
});

test('the most specific category wins, and unknown or missing codes read as unexpected', () => {
  // Thrown for a window without positive dimensions or a source that cannot be created; the runtime groups it
  // with SOURCE_INITIALIZATION (nativeEndpoint.cjs). SETTINGS is an internal contract check, not a quality limit.
  assert.equal(screenShareFailureCategory(['ERR_SCREEN_CAPTURE_SOURCE']), 'source-lost');
  assert.equal(screenShareFailureCategory(['ERR_SCREEN_CAPTURE_SETTINGS']), 'unexpected');
  assert.equal(screenShareFailureCategory(['ERR_SCREEN_CAPTURE_RETIREMENT', 'ERR_SCREEN_CAPTURE_SOURCE_LOST']), 'source-lost');
  assert.equal(screenShareFailureCategory(['ERR_SCREEN_CAPTURE_TIMEOUT', 'ERR_SCREEN_CAPTURE_PATH']), 'files');
  assert.equal(screenShareFailureCategory(['ERR_SCREEN_CAPTURE_SOURCE_LOST', 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE']), 'game');
  assert.equal(screenShareFailureCategory(['ERR_SCREEN_CAPTURE_SOMETHING_NEW']), 'unexpected');
  assert.equal(screenShareFailureCategory([]), 'unexpected');
});

test('the marker survives Electron\'s prefix and refuses anything it did not write', () => {
  const message = encodeScreenShareFailure('Unsafe absolute path', { codes: ['ERR_SCREEN_CAPTURE_PATH'] });
  assert.deepEqual(decodeScreenShareFailure(`Error invoking remote method 'x': Error: ${message}`), { codes: ['ERR_SCREEN_CAPTURE_PATH'] });
  assert.equal(decodeScreenShareFailure('Unsafe absolute path'), null);
  assert.equal(decodeScreenShareFailure('x [monky-screen-failure {"codes":["rm -rf"]}]'), null);
  assert.equal(decodeScreenShareFailure('x [monky-screen-failure {"codes":[],"extra":1}]'), null);
  assert.equal(decodeScreenShareFailure('x [monky-screen-failure {not json}]'), null);
  assert.throws(() => encodeScreenShareFailure('x', { codes: ['not a code'] }));
});

for (const language of ['pt-BR', 'en'] as const satisfies readonly SupportedLanguage[]) {
  const start = (reason: string): string => t('screenShare.startFailed', { reason });

  test(`a native failure across IPC shows its category, never the technical text (${language})`, () => {
    setLanguage(language);
    const message = screenShareFailureMessage(crossed(coded('Unsafe absolute path', 'ERR_SCREEN_CAPTURE_PATH')), 'start');
    assert.equal(message, start(t('screenShare.failure.files')));
    assert.doesNotMatch(message, TECHNICAL);
    // Retirement errors aggregated with the cause do not hide it.
    const aggregate = new AggregateError([
      coded('Selected monitor was disconnected', 'ERR_SCREEN_CAPTURE_MONITOR_LOST'),
      coded('Retirement failed', 'ERR_SCREEN_CAPTURE_RETIREMENT'),
    ], 'Native source preparation and cleanup failed.');
    assert.equal(screenShareFailureMessage(crossed(aggregate), 'start'), start(t('screenShare.failure.source-lost')));
    // The renderer wraps IPC rejections too.
    const wrapped = new AggregateError([crossed(coded('NVENC', 'ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE')), new Error('cleanup')]);
    assert.equal(screenShareFailureMessage(wrapped, 'start'), start(t('screenShare.failure.encoder')));
    assert.equal(screenShareFailureMessage(crossed(coded('Hook refused', 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE')), 'start'),
      start(t('screenShare.gameCaptureUnavailable')));
  });

  test(`every native code reads as plain language in every action (${language})`, () => {
    setLanguage(language);
    for (const code of [...sourceCodes(), ...SCREEN_SHARE_FAILURE_CODES.keys()]) {
      for (const action of ACTIONS) {
        const message = screenShareFailureMessage(crossed(coded(`Native detail for ${code}`, code)), action);
        assert.doesNotMatch(message, TECHNICAL, `${code} (${action})`);
        assert.doesNotMatch(message, /Native detail|\{reason\}|screenShare\./, `${code} (${action})`);
        assertNoRepeatedOpening(message, `${code} (${action})`);
      }
    }
  });

  test(`messages the app already wrote read naturally after every action (${language})`, () => {
    setLanguage(language);
    const explained: readonly TranslationKey[] = [
      'screenShare.sourceUnavailable', 'screenShare.nativeUnavailable', 'screenCodec.reconnecting',
      'screenShare.audioAlreadySharing', 'screenShare.captureMethodUnavailable', 'screenShare.nativeAudioUnavailable',
      'screenShare.nativeEncoderUnavailable', 'screenShare.nativeProfileChangeBlocked', 'screenShare.ownWindowAudioUnavailable',
    ];
    for (const key of explained) for (const action of ACTIONS)
      assertNoRepeatedOpening(screenShareFailureMessage(new ScreenShareUserError(t(key)), action), `${key} (${action})`);
    assertNoRepeatedOpening(t('screenShare.gameCaptureUnavailable'), 'the Game Capture alert on its own');
  });

  test(`an automatic fallback to software explains the encoder refusal without the technical reason (${language})`, () => {
    setLanguage(language);
    const reason = 'AMF component initialization failed at C:\\Program Files\\Monky';
    const encoder = screenEncodingFallbackMessage({ available: false, reason, codes: ['ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED'] });
    assert.equal(encoder, t('screenShare.encodingFallback', { reason: t('screenShare.failure.encoder') }));
    const quality = screenEncodingFallbackMessage({ available: false, reason, codes: ['ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED'] });
    assert.equal(quality, t('screenShare.encodingFallback', { reason: t('screenShare.failure.quality') }));
    const uncoded = screenEncodingFallbackMessage({ available: false, reason: 'No compatible hardware encoder is compiled into this runtime.' });
    assert.equal(uncoded, t('screenShare.encodingFallback', { reason: '' }).trim());
    for (const message of [encoder, quality, uncoded]) {
      assert.doesNotMatch(message, /AMF component|Program Files|compiled into|ERR_|\{reason\}/);
      assertNoRepeatedOpening(message, 'encoding fallback');
    }
  });

  test(`without a known code the message is generic, and explained failures keep their text (${language})`, () => {
    setLanguage(language);
    const unexpected = start(t('screenShare.failure.unexpected'));
    for (const error of [
      crossed(new Error('The original signaling connection is unavailable.')),
      crossed(coded('Brand new failure', 'ERR_SCREEN_CAPTURE_SOMETHING_NEW')),
      new Error('Native screen operation failed.'), 'a string', undefined,
    ]) assert.equal(screenShareFailureMessage(error, 'start'), unexpected);
    assert.equal(screenShareFailureMessage(new ScreenShareUserError(t('screenShare.sourceUnavailable')), 'start'),
      start(t('screenShare.sourceUnavailable')));
    const notice = 'Monky windows can only be shared without audio.';
    assert.equal(screenShareFailureMessage(crossed(new NativeScreenNotice(notice, 'ERR_AUDIO_TARGET')), 'start'), start(notice));
    assert.equal(screenShareFailureMessage(new Error('Stop failed'), 'stop'),
      t('screenShare.stopFailed', { reason: t('screenShare.failure.unexpected') }));
  });
}
