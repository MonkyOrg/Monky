import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyScreenRotation,
  cycleScreenRotation,
  nextScreenRotation,
  quarterTurnBox,
  screenRotationFor,
  screenRotationTransform,
} from '../src/renderer/views/stage/StageScreenRotate';

test('each tap turns a screen 90° and wraps back to upright', () => {
  assert.equal(nextScreenRotation(0), 90);
  assert.equal(nextScreenRotation(90), 180);
  assert.equal(nextScreenRotation(180), 270);
  assert.equal(nextScreenRotation(270), 0);
});

test('rotation is remembered per tile and cleared when it returns upright', () => {
  const key = 'session:screen:share-box';
  assert.equal(screenRotationFor(key), 0);
  assert.equal(cycleScreenRotation(key), 90);
  assert.equal(screenRotationFor(key), 90);
  assert.equal(cycleScreenRotation(key), 180);
  assert.equal(cycleScreenRotation(key), 270);
  assert.equal(cycleScreenRotation(key), 0);
  assert.equal(screenRotationFor(key), 0);
});

test('a quarter-turn uses a swapped box that lands on the host after rotate', () => {
  assert.deepEqual(quarterTurnBox(1600, 900), {
    width: 900, height: 1600, left: 350, top: -350,
  });
  assert.deepEqual(quarterTurnBox(900, 1600), {
    width: 1600, height: 900, left: -350, top: 350,
  });
  assert.equal(quarterTurnBox(0, 900), null);
});

test('rotation CSS is only the angle; layout owns the fill', () => {
  assert.equal(screenRotationTransform(0), '');
  assert.equal(screenRotationTransform(90), 'rotate(90deg)');
  assert.equal(screenRotationTransform(180), 'rotate(180deg)');
});

test('applyScreenRotation sizes the swapped box and clears it when upright again', () => {
  const host = { clientWidth: 1600, clientHeight: 900 };
  const video = {
    dataset: {} as DOMStringMap,
    style: {
      transform: '', objectFit: '', width: '', height: '', left: '', top: '', right: '', bottom: '',
    },
    closest: (selector: string) => {
      if (selector === '.is-zoomed') return null;
      if (selector.includes('stage-focused-main')) return host;
      return null;
    },
  };
  applyScreenRotation(video as unknown as HTMLVideoElement, 90);
  assert.equal(video.dataset.screenRotation, '90');
  assert.equal(video.style.width, '900px');
  assert.equal(video.style.height, '1600px');
  assert.equal(video.style.left, '350px');
  assert.equal(video.style.top, '-350px');
  assert.equal(video.style.objectFit, 'contain');
  assert.equal(video.style.transform, 'rotate(90deg)');
  applyScreenRotation(video as unknown as HTMLVideoElement, 0);
  assert.equal(video.dataset.screenRotation, '0');
  assert.equal(video.style.width, '');
  assert.equal(video.style.height, '');
  assert.equal(video.style.transform, '');
});
