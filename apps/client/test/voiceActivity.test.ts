import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVoiceActive, speechLevel, vadSensitivity } from '../src/renderer/audio/voiceActivity';
import { microphoneConstraints } from '../src/renderer/utils/audioPreferences';

/** A 128-bin snapshot (fftSize 256) with `speech` in the speech band, one `peak` bin and loud bins above it. */
function snapshot(speech: number, peak: number): Uint8Array {
  const bins = new Uint8Array(128).fill(255);
  bins.fill(speech, 0, 36);
  bins[10] = peak;
  return bins;
}

test('the speech level reads only the speech band of the analyser snapshot', () => {
  assert.deepEqual(speechLevel(snapshot(20, 90)), { average: (20 * 35 + 90) / 36, peak: 90 });
  assert.deepEqual(speechLevel(Uint8Array.of(10, 30)), { average: 20, peak: 30 });
  assert.deepEqual(speechLevel(new Uint8Array(0)), { average: 0, peak: 0 });
});

test('voice activity keeps the calibration of the call gate', () => {
  // Below sensitivity 20 the targets stay at their floors: an average of 16 and a peak of 42.
  assert.equal(isVoiceActive({ average: 17, peak: 43 }, 0), true);
  assert.equal(isVoiceActive({ average: 17, peak: 42 }, 0), false, 'the peak has to exceed its target');
  assert.equal(isVoiceActive({ average: 16, peak: 200 }, 0), false, 'the average has to exceed its target');
  assert.equal(isVoiceActive({ average: 22.5, peak: 23 }, 0), true, 'a loud enough average opens the gate alone');
  // The default sensitivity: an average above 20 with a peak above 45, or an average above 28.
  assert.equal(isVoiceActive({ average: 21, peak: 46 }, 25), true);
  assert.equal(isVoiceActive({ average: 21, peak: 45 }, 25), false);
  assert.equal(isVoiceActive({ average: 28.1, peak: 30 }, 25), true);
  // The top of the slider needs an average above 179.2: no peak reaches 288.
  assert.equal(isVoiceActive({ average: 179, peak: 255 }, 160), false);
  assert.equal(isVoiceActive({ average: 180, peak: 255 }, 160), true);
});

test('the sensitivity stays within the slider and an unreadable one never silences the gate', () => {
  assert.equal(vadSensitivity(-5), 0);
  assert.equal(vadSensitivity(500), 160);
  assert.equal(vadSensitivity(Number.NaN), 0);
  assert.equal(isVoiceActive({ average: 179, peak: 255 }, 1000), false);
  assert.equal(isVoiceActive({ average: 17, peak: 43 }, Number.NaN), true);
});

test('the call and the settings preview open the microphone with the same constraints', () => {
  assert.deepEqual(microphoneConstraints('mic-1', 'rnnoise'), {
    deviceId: { exact: 'mic-1' }, channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true,
  });
  const fallback = microphoneConstraints('', 'browser');
  assert.equal(fallback.deviceId, undefined, 'the system default is never pinned to a device');
  assert.equal(fallback.noiseSuppression, true, "only the browser mode asks for Chromium's suppression");
});
