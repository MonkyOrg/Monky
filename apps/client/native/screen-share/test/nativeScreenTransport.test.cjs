'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeScreenTransport } = require('../runtime/nativeScreenTransport.cjs');

const video = (sourceId = 1) => ({ sourceId, shareId: `screen-${sourceId}`, syncGroup: `group-${sourceId}`,
  maxBitrateBps: 8000000, maxFramerate: 60 });
const audio = (sourceId = 2) => ({ sourceId, screenAudioShareId: 'screen-1', syncGroup: 'group-1', maxBitrateBps: 128000 });

/** The shared transport rules, with each mode's broker work reduced to a recorded call. */
class RecordingTransport extends NativeScreenTransport {
  constructor({ failRetirement = () => false } = {}) {
    const calls = [];
    const broker = {
      registerAudioSource: value => { calls.push(['register', value.sourceId]); },
      handleNativeEvent: () => true,
    };
    super(broker, () => {}, { label: 'Test', audioPublication: true, maximumBitrateBps: 1000000000 });
    Object.assign(this, { calls, failRetirement });
  }

  registerVideo(record) { this.calls.push(['register', record.sourceId]); }
  async publishSource(record) { this.calls.push(['publish', record.sourceId]); }
  async retireSource(record) {
    this.calls.push(['retire', record.sourceId]);
    if (this.failRetirement(record)) throw new Error(`Retirement of ${record.sourceId} failed.`);
  }
  async closeBroker() { this.calls.push(['close']); }
  async retireBroker() { this.calls.push(['engine-retired']); }
}

test('retiring a screen retires its audio first in every mode, and a failed audio retirement keeps both', async () => {
  let failing = true;
  const transport = new RecordingTransport({ failRetirement: record => failing && record.kind === 'audio' });
  await transport.addSource(video());
  await transport.addAudioSource(audio());
  await assert.rejects(transport.removeSource(1), /Retirement of 2 failed/u);
  assert.deepEqual(transport.calls.filter(call => call[0] === 'retire'), [['retire', 2]]);
  assert.deepEqual([...transport.sources.keys()], [1, 2]);
  failing = false;
  await transport.removeSource(1);
  assert.deepEqual(transport.calls.filter(call => call[0] === 'retire'), [['retire', 2], ['retire', 2], ['retire', 1]]);
  assert.equal(transport.sources.size, 0);
});

test('every mode refuses a foreign cancellation signal or an invalid synchronization group before registering', async () => {
  const transport = new RecordingTransport();
  await assert.rejects(transport.addSource(video(), { aborted: false }), /Invalid native Test cancellation signal/u);
  for (const syncGroup of ['', 'group\0hidden', 'x'.repeat(257), undefined]) {
    await assert.rejects(transport.addSource({ ...video(), syncGroup }), /invalid, retained or closed/u);
  }
  await assert.rejects(transport.removeSource(0), /Invalid native Test source ID/u);
  assert.deepEqual(transport.calls, []);
  await transport.close();
  assert.deepEqual(transport.calls, [['close']]);
});
