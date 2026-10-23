import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LivePulseClock } from '../src/renderer/utils/livePulse';

test('rebuilt live badges resume their pulse phase instead of pulsing again', () => {
  let now = 1_000;
  const clock = new LivePulseClock(() => now);

  assert.equal(clock.delay('ana'), '0ms');
  now += 2_500;
  assert.equal(clock.delay('ana'), '-2500ms', 'a rebuild continues the running pulse');
  assert.equal(clock.delay('bia'), '0ms', 'someone who just went live starts from the beginning');

  // Long after the last cycle the delay keeps growing, so the recreated
  // animation is already finished and produces no frames.
  now += 60_000;
  assert.equal(clock.delay('ana'), '-62500ms');
});

test('a member who stops and starts sharing again pulses again', () => {
  let now = 0;
  const clock = new LivePulseClock(() => now);
  clock.delay('ana');
  clock.delay('bia');
  now = 10_000;

  clock.retain(new Set(['bia']));
  assert.equal(clock.delay('ana'), '0ms');
  assert.equal(clock.delay('bia'), '-10000ms');
});
