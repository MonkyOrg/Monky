'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { NativePcmPlayoutQueue } = require('../runtime/nativePcmPlayout.worklet.js');

function packet(sequence = 1, firstPlayoutFrame = (sequence - 1) * 480, epoch = 1) {
  const samples = new Float32Array(960);
  for (let frame = 0; frame < 480; frame++) {
    samples[frame * 2] = (firstPlayoutFrame + frame) / 10000;
    samples[frame * 2 + 1] = -(firstPlayoutFrame + frame) / 10000;
  }
  return { epoch, sequence, firstPlayoutFrame, sampleRate: 48000, channels: 2, frames: 480, samples };
}
const output = (frames = 128) => [new Float32Array(frames), new Float32Array(frames)];

function workletFixture() {
  let Processor;
  const messages = [];
  const context = vm.createContext({
    Float32Array, ArrayBuffer, SharedArrayBuffer: undefined, Number, Error, sampleRate: 48000, currentFrame: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
    registerProcessor(name, type) { assert.equal(name, 'native-pcm-playout'); Processor = type; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'nativePcmPlayout.worklet.js'), 'utf8'), context);
  const processor = new Processor({ processorOptions: { epoch: 1 } });
  return { messages, context, processor };
}

test('playout grants bounded sample credits and never requests a second timer clock', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  assert.deepEqual(queue.reserveCredits(), { epoch: 1, grantSequence: 1, frames: 960 });
  assert.equal(queue.reserveCredits(), null);
  queue.enqueue(packet(1));
  queue.enqueue(packet(2));
  assert.equal(queue.reserveCredits(), null);
  queue.render(output(), 0);
  assert.deepEqual(queue.reserveCredits(), { epoch: 1, grantSequence: 2, frames: 480 });
  assert.equal(queue.reserveCredits(), null);
  for (let index = 1; index < 4; index++) queue.render(output(), index * 128);
  assert.deepEqual(queue.reserveCredits(), { epoch: 1, grantSequence: 3, frames: 480 });
  assert.equal(queue.snapshot().outstandingFrames, 960);
  assert.equal(queue.snapshot().queuedFrames + queue.snapshot().outstandingFrames, 1408);
});

test('priming waits for the actual target depth and leaves room for whole-packet refill', () => {
  assert.throws(() => new NativePcmPlayoutQueue({ epoch: 1, capacityFrames: 960 }), /configuration/u);
  const queue = new NativePcmPlayoutQueue({ epoch: 1, capacityFrames: 1440 });
  queue.reserveCredits();
  queue.enqueue(packet(1));
  const buffering = queue.render(output(), 0);
  assert.equal(buffering.firstPlayoutFrame, null);
  assert.equal(buffering.mediaFrames, 0);
  assert.equal(queue.snapshot().queuedFrames, 480);
  assert.equal(queue.snapshot().underruns, 0);
  queue.enqueue(packet(2));
  assert.equal(queue.render(output(), 128).firstPlayoutFrame, 0);
  assert.equal(queue.reserveCredits().frames, 480);
  assert.equal(queue.snapshot().queuedFrames + queue.snapshot().outstandingFrames, 1312);
});

test('zero-based native packet counters are valid and still require exact continuity', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  queue.reserveCredits();
  queue.enqueue(packet(0, 0));
  queue.enqueue(packet(1, 480));
  assert.equal(queue.render(output(), 0).firstPlayoutFrame, 0);
});

test('PCM stays continuous through packet and ring boundaries without rewriting its sample positions', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  queue.reserveCredits();
  queue.enqueue(packet(1));
  queue.enqueue(packet(2));
  let nextPacket = 3;
  for (let quantum = 0; quantum < 50; quantum++) {
    const channels = output();
    const feedback = queue.render(channels, quantum * 128);
    assert.equal(feedback.firstPlayoutFrame, quantum * 128);
    for (let index = 0; index < 128; index++) {
      assert.ok(Math.abs(channels[0][index] - (quantum * 128 + index) / 10000) < 1e-7);
      assert.ok(Math.abs(channels[1][index] + channels[0][index]) < 1e-7);
    }
    const credit = queue.reserveCredits();
    for (let remaining = credit?.frames ?? 0; remaining; remaining -= 480) queue.enqueue(packet(nextPacket++));
  }
  assert.equal(queue.snapshot().underruns, 0);
  assert.equal(queue.snapshot().renderedFrames, 6400);
});

test('controlled 10 ms packet delivery and bounded IPC do not starve the render-driven playout queue', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  const deliveries = [];
  let contextFrame = 0, nativeFrame = 0, nativeCredits = 0, sequence = 0;
  while (Math.min(contextFrame, nativeFrame) < 96000) {
    const nextDelivery = deliveries.length ? deliveries[0].at : Infinity;
    const at = Math.min(contextFrame, nativeFrame, nextDelivery);
    while (deliveries[0]?.at === at) {
      const delivery = deliveries.shift();
      if (delivery.credit) {
        nativeCredits += delivery.credit.frames;
        assert.ok(nativeCredits <= 960, 'The actual native outstanding-credit bound stays unchanged');
      } else queue.enqueue(delivery.packet);
    }
    if (nativeFrame === at) {
      if (nativeCredits >= 480) {
        nativeCredits -= 480;
        // Two milliseconds per IPC leg; occasional PCM delivery adds four milliseconds.
        const delay = sequence % 31 === 15 ? 288 : 96;
        deliveries.push({ at: at + delay, packet: packet(sequence, sequence * 480) });
        sequence++;
      }
      nativeFrame += 480;
    }
    if (contextFrame === at) {
      queue.render(output(), contextFrame);
      const credit = queue.reserveCredits();
      if (credit) deliveries.push({ at: at + 96, credit });
      assert.ok(queue.snapshot().outstandingFrames <= 960);
      assert.ok(queue.snapshot().queuedFrames + queue.snapshot().outstandingFrames <= queue.capacityFrames);
      contextFrame += 128;
    }
    deliveries.sort((a, b) => a.at - b.at);
  }
  assert.ok(queue.snapshot().renderedFrames > 90000, 'A permanently buffering queue is not a successful playout');
  assert.equal(queue.snapshot().underruns, 0);
  queue.stop();
});

test('initial silence has no native playback anchor and an underrun invalidates its clock epoch', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  const empty = queue.render(output(), 0);
  assert.equal(empty.firstPlayoutFrame, null);
  assert.equal(empty.mediaFrames, 0);
  assert.equal(empty.underrun, false);
  queue.reserveCredits();
  queue.enqueue(packet(1));
  queue.enqueue(packet(2));
  for (let index = 1; index < 8; index++) queue.render(output(), index * 128);
  const starving = output();
  const feedback = queue.render(starving, 1024);
  assert.equal(feedback.underrun, true);
  assert.equal(feedback.firstPlayoutFrame, null);
  assert.equal(feedback.clockEpoch, empty.clockEpoch + 1);
  assert.equal(queue.snapshot().queuedFrames, 64, 'partial audio is not attributed to an entirely silent quantum');
  assert.equal(starving[0].every(sample => sample === 0), true);
  assert.equal(queue.reserveCredits().frames, 960);
  queue.enqueue(packet(3));
  assert.equal(queue.render(output(), 1152).firstPlayoutFrame, null);
  queue.enqueue(packet(4));
  const resumed = queue.render(output(), 1280);
  assert.equal(resumed.firstPlayoutFrame, 896);
  assert.equal(resumed.contextFrame, 1280);
  assert.equal(queue.snapshot().underruns, 1);
});

test('new epochs revoke outstanding credit and reject old packets without poisoning the replacement', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  queue.reserveCredits();
  queue.enqueue(packet(1));
  queue.reset(2);
  assert.equal(queue.enqueue(packet(2)), false);
  assert.equal(queue.snapshot().outstandingFrames, 0);
  assert.equal(queue.snapshot().queuedFrames, 0);
  queue.reserveCredits();
  queue.enqueue(packet(10, 9000, 2));
  queue.enqueue(packet(11, 9480, 2));
  assert.equal(queue.render(output(), 5000).firstPlayoutFrame, 9000);
  assert.equal(queue.snapshot().discardedFrames, 480);
  assert.throws(() => queue.reset(2), /new monotonic epoch/u);
});

test('native PCM cannot exceed credits, skip sequence/sample positions or introduce invalid samples', () => {
  const mutations = [
    value => { value.sequence = 3; },
    value => { value.firstPlayoutFrame = 481; },
    value => { value.sampleRate = 44100; },
    value => { value.samples[0] = NaN; },
    value => { value.samples = new Float32Array(959); },
    value => { value.samples = new Float32Array(new SharedArrayBuffer(960 * 4)); },
    value => { value.frames = 0; },
    value => { value.epoch = 2; },
    value => { value.sequence = Number.MAX_SAFE_INTEGER; },
  ];
  for (const mutate of mutations) {
    const queue = new NativePcmPlayoutQueue({ epoch: 1 });
    queue.reserveCredits();
    queue.enqueue(packet(1));
    const invalid = packet(2);
    mutate(invalid);
    assert.throws(() => queue.enqueue(invalid));
    assert.equal(queue.snapshot().state, 'failed');
    assert.equal(queue.snapshot().queuedFrames, 0);
    assert.equal(queue.reserveCredits(), null);
  }
  const uncredited = new NativePcmPlayoutQueue({ epoch: 1 });
  assert.throws(() => uncredited.enqueue(packet()), /credit/u);
});

test('the worklet rejects shared PCM even when its realm does not expose SharedArrayBuffer', () => {
  const { processor, messages } = workletFixture();
  processor.process([], [output()]);
  const shared = { ...packet(), samples: new Float32Array(new SharedArrayBuffer(3840)) };
  processor.port.onmessage({ data: { type: 'pcm', packet: shared } });
  assert.equal(messages.at(-1).type, 'error');
  assert.equal(messages.at(-1).code, 'ERR_NATIVE_AUDIO_PACKET');
});

test('a regressing AudioContext cannot reuse an output anchor', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  queue.reserveCredits();
  queue.enqueue(packet(1));
  queue.render(output(), 1000);
  assert.throws(() => queue.render(output(), 1000), /clock regressed/u);
  assert.equal(queue.snapshot().state, 'failed');
});

test('a forward graph gap discards only unplayed PCM and preserves real packet positions and credit ownership', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  queue.reserveCredits();
  queue.enqueue(packet(1));
  queue.enqueue(packet(2));
  assert.equal(queue.render(output(), 0).firstPlayoutFrame, 0);
  assert.equal(queue.reserveCredits().frames, 480);
  const gapOutput = output(), gap = queue.render(gapOutput, 256);
  assert.equal(gap.state, 'buffering');
  assert.equal(gap.underrun, true);
  assert.equal(gap.firstPlayoutFrame, null);
  assert.equal(gap.mediaFrames, 0);
  assert.equal(gap.clockEpoch, 2);
  assert.equal(gap.epoch, 1);
  assert.equal(gap.outstandingFrames, 480);
  assert.equal(gapOutput.every(channel => channel.every(value => value === 0)), true);
  assert.equal(queue.snapshot().discardedFrames, 832);
  assert.equal(queue.snapshot().skippedContextFrames, 128);
  assert.equal(queue.snapshot().contextDiscontinuities, 1);
  assert.equal(queue.reserveCredits().frames, 480);
  queue.enqueue(packet(3));
  queue.enqueue(packet(4));
  const resumed = queue.render(output(), 384);
  assert.equal(resumed.firstPlayoutFrame, 960, 'Resume must keep the original native PCM cursor, not fabricate a graph cursor.');
  assert.equal(resumed.clockEpoch, 2);
  const stats = queue.snapshot();
  assert.equal(stats.acceptedFrames, stats.renderedFrames + stats.queuedFrames + stats.discardedFrames);
});

test('the actual worklet immediately withdraws its clock anchor on a skipped rendering quantum', () => {
  const { context, processor, messages } = workletFixture();
  processor.process([], [output()]);
  processor.port.onmessage({ data: { type: 'pcm', packet: packet(1) } });
  processor.port.onmessage({ data: { type: 'pcm', packet: packet(2) } });
  context.currentFrame = 128;
  processor.process([], [output()]);
  context.currentFrame = 512;
  assert.equal(processor.process([], [output()]), true);
  const feedback = messages.findLast(message => message.type === 'feedback');
  assert.equal(feedback.state, 'buffering');
  assert.equal(feedback.firstPlayoutFrame, null);
  assert.equal(feedback.playout.discardedFrames, 832);
  assert.equal(feedback.playout.skippedContextFrames, 256);
  assert.equal(messages.some(message => message.type === 'error'), false);
});

test('stopped output is silent, offers no credit and does not report samples as physically played', () => {
  const queue = new NativePcmPlayoutQueue({ epoch: 1 });
  queue.reserveCredits();
  queue.enqueue(packet());
  queue.stop();
  const samples = output();
  const feedback = queue.render(samples, 0);
  assert.equal(queue.reserveCredits(), null);
  assert.equal(feedback.firstPlayoutFrame, null);
  assert.equal(feedback.mediaFrames, 0);
  assert.equal(feedback.state, 'stopped');
  assert.equal(queue.enqueue(packet(2)), false);
});

test('the actual worklet uses render-driven credits and bounded feedback, without devices or AudioContext', () => {
  const { context, processor, messages } = workletFixture();
  processor.process([], [output()]);
  assert.equal(messages[0].type, 'credits');
  assert.equal(messages[0].frames, 960);
  processor.port.onmessage({ data: { type: 'pcm', packet: packet() } });
  processor.port.onmessage({ data: { type: 'pcm', packet: packet(2) } });
  for (let quantum = 1; quantum < 5; quantum++) {
    context.currentFrame = quantum * 128;
    processor.process([], [output()]);
  }
  const feedback = messages.find(message => message.type === 'feedback');
  assert.equal(feedback.firstPlayoutFrame, 256);
  assert.equal(feedback.contextFrame, 384);
  assert.equal(feedback.mediaFrames, 128);
  assert.equal(feedback.playout.renderedFrames, 384);
  assert.equal(feedback.playout.silenceFrames, 128);
  assert.equal(feedback.playout.underruns, 0);
  assert.equal(feedback.playout.queuedFrames, feedback.queuedFrames);
  assert.equal(feedback.playout.outstandingFrames, feedback.outstandingFrames);
  processor.port.onmessage({ data: { type: 'unknown' } });
  assert.equal(messages.at(-1).type, 'error');
  const afterFailure = output();
  assert.equal(processor.process([], [afterFailure]), false);
  assert.equal(afterFailure[0].every(value => value === 0), true);
});

test('late reset/stop controls cannot tear down a replacement audio epoch', () => {
  const { processor, messages } = workletFixture();
  processor.port.onmessage({ data: { type: 'reset', epoch: 3 } });
  processor.port.onmessage({ data: { type: 'reset', epoch: 2 } });
  processor.port.onmessage({ data: { type: 'stop', epoch: 1 } });
  assert.equal(processor.process([], [output()]), true);
  assert.equal(messages[0].epoch, 3);
  processor.port.onmessage({ data: { type: 'stop', epoch: 3 } });
  assert.equal(processor.process([], [output()]), false);
  assert.equal(messages.some(message => message.type === 'error'), false);
});
