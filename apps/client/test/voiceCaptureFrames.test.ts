import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downmix, LinearResampler, SampleQueue, SampleTimeline, VOICE_SAMPLE_RATE } from '../src/renderer/core/voiceCapture/audioFrames';

function sine(rate: number, frames: number): Float32Array {
  return Float32Array.from({ length: frames }, (_, index) => Math.sin(2 * Math.PI * 440 * index / rate));
}

test('downmix averages stereo planes into mono', () => {
  const mono = downmix([Float32Array.of(1, 0.5, 0), Float32Array.of(0, 0.5, 1)], 3);
  assert.deepEqual(Array.from(mono), [0.5, 0.5, 0.5]);
});

test('the resampler turns one second of 44.1 kHz into one second of 48 kHz, whatever the chunking', () => {
  const input = sine(44100, 44100);
  const whole = new LinearResampler().process(input, 44100);
  const chunked = new LinearResampler();
  const pieces: number[] = [];
  for (let start = 0; start < input.length; start += 441) pieces.push(...chunked.process(input.subarray(start, start + 441), 44100));

  assert.ok(Math.abs(whole.length - VOICE_SAMPLE_RATE) <= 1, `got ${whole.length} samples`);
  assert.equal(pieces.length, whole.length);
  pieces.forEach((value, index) => assert.ok(Math.abs(value - whole[index]) < 1e-6, `sample ${index} differs`));
  const expected = sine(VOICE_SAMPLE_RATE, whole.length);
  for (let index = 1; index < whole.length; index++) assert.ok(Math.abs(whole[index] - expected[index]) < 0.01, `sample ${index} off the curve`);
});

test('48 kHz input passes through the resampler untouched', () => {
  const input = sine(VOICE_SAMPLE_RATE, 480);
  assert.equal(new LinearResampler().process(input, VOICE_SAMPLE_RATE), input);
});

test('the queue hands out whole blocks in order and keeps the remainder', () => {
  const queue = new SampleQueue();
  queue.push(Float32Array.from({ length: 10000 }, (_, index) => index));
  const block = new Float32Array(128);
  const taken: number[] = [];
  while (queue.take(block)) taken.push(block[0], block[127]);

  assert.equal(queue.length, 10000 % 128);
  assert.deepEqual(taken.slice(0, 4), [0, 127, 128, 255]);
  assert.equal(taken.at(-1), Math.floor(10000 / 128) * 128 - 1);
});

test('timestamps follow the samples written, not the input clock', () => {
  const timeline = new SampleTimeline();
  assert.equal(timeline.stamp(5_000_000, 480), 5_000_000);
  assert.equal(timeline.stamp(5_000_000, 480), 5_010_000);
  assert.equal(timeline.stamp(1_000, 480), 5_020_000);
});
