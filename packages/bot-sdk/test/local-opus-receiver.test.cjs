const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RTCPeerConnection } = require('werift');
const {
  LOCAL_EXECUTION_PROTOCOL_LIMITS, LOCAL_MEDIA_CHANNEL_LABEL, LOCAL_MEDIA_CHANNEL_OPTIONS, LOCAL_MEDIA_FORMAT,
  advanceLocalMediaFlow, createLocalMediaFlowState, decodeLocalMediaRecord, encodeLocalMediaRecord,
  isLocalMediaSdp, localMediaSignalSchema,
} = require('@monky/shared');
const { LocalOpusReceiver } = require('../dist/localExecution/LocalOpusReceiver');

const SILENCE = Uint8Array.from([0xf8, 0xff, 0xfe]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const envelope = signal => ({ taskId: 'local-opus-test', mediaGeneration: 7, signal });
const frame = sequence => ({ kind: 'frame', sequence, opus: SILENCE });
const binary = record => Buffer.from(encodeLocalMediaRecord(record));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function within(promise, ms = 3000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation did not settle.')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function until(predicate, message = 'Condition did not become true') {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await wait(10);
  assert.ok(predicate(), message);
}

async function remainsPending(promise) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await wait(25);
  assert.equal(settled, false, 'Playback must not advance while its pending operation is blocked.');
}

function candidates(sdp) {
  const mid = /^a=mid:([^\r\n]+)/m.exec(sdp)?.[1];
  const usernameFragment = /^a=ice-ufrag:([^\r\n]+)/m.exec(sdp)?.[1];
  return [...sdp.matchAll(/^a=(candidate:[^\r\n]+)/gm)].map(match => ({
    candidate: match[1], sdpMid: mid, sdpMLineIndex: 0, usernameFragment,
  }));
}

function fixture(t, options = {}) {
  const errors = [], signals = [], controls = [], peerErrors = [], ready = [];
  const executor = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const channel = executor.createDataChannel(
    options.label ?? LOCAL_MEDIA_CHANNEL_LABEL,
    { ...LOCAL_MEDIA_CHANNEL_OPTIONS, ...options.channelOptions },
  );
  let flow = createLocalMediaFlowState();
  const receiver = new LocalOpusReceiver({
    taskId: 'local-opus-test', generation: 7, iceServers: options.iceServers ?? [],
    sendSignal: signal => {
      localMediaSignalSchema.parse(signal);
      signals.push(signal);
      options.sendSignal?.(signal);
    },
    onReady: () => {
      ready.push({ pc: receiver.pc.connectionState, channel: receiver.channel?.readyState });
      options.onReady?.();
    },
    onError: error => errors.push(error),
  });
  const subscription = channel.onMessage.subscribe(data => {
    try {
      assert.ok(Buffer.isBuffer(data), 'Controls must also cross real SCTP as binary records.');
      const record = decodeLocalMediaRecord(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      flow = advanceLocalMediaFlow(flow, record, 'bot');
      controls.push(record);
    } catch (error) { peerErrors.push(error); }
  });
  t.after(async () => {
    await receiver.abort(new Error('Local receiver fixture disposed.'));
    subscription.unSubscribe();
    await executor.close();
    assert.deepEqual(peerErrors, []);
  });
  async function offer() {
    for (const transport of executor.iceTransports) {
      // iceServers: [] alone does not disable werift's implicit public STUN server.
      transport.connection.stunServer = transport.connection.options.stunServer;
    }
    await executor.setLocalDescription(await executor.createOffer());
    return { type: 'offer', sdp: executor.localDescription.sdp };
  }
  async function negotiate({ earlyIce = false, expectReady = true } = {}) {
    const original = await offer();
    let sdp = original.sdp;
    if (earlyIce) {
      const early = candidates(sdp);
      assert.ok(early.length, 'The local executor must produce real host ICE candidates.');
      for (const candidate of early) {
        await receiver.handleSignal(envelope({ signalType: 'candidate', candidate }));
      }
      await receiver.handleSignal(envelope({ signalType: 'candidate', candidate: null }));
      sdp = sdp.replace(/^a=(?:candidate:[^\r\n]*|end-of-candidates)\r?\n/gm, '');
    }
    await receiver.handleSignal(envelope({ signalType: 'offer', sdp: { type: 'offer', sdp } }));
    const answer = signals.find(signal => signal.signal.signalType === 'answer')?.signal.sdp;
    assert.ok(answer);
    await executor.setRemoteDescription(answer);
    for (const signal of signals) {
      if (signal.signal.signalType === 'candidate') await executor.addIceCandidate(signal.signal.candidate);
    }
    if (expectReady) {
      await until(() => ready.length > 0 && channel.readyState === 'open', 'Paired local SCTP did not open.');
      assert.deepEqual(errors, []);
      assert.deepEqual(ready, [{ pc: 'connected', channel: 'open' }]);
    } else {
      await until(() => errors.length > 0);
    }
    return { offer: original, answer };
  }
  async function start() {
    receiver.start();
    await until(() => controls.some(record => record.kind === 'credit'));
  }
  function send(record) {
    flow = advanceLocalMediaFlow(flow, record, 'executor');
    channel.send(binary(record));
  }
  return {
    receiver, executor, channel, errors, signals, controls, ready, offer, negotiate, start, send,
    get flow() { return flow; },
  };
}

test('real data-only offer/answer accepts early ICE, needs PC AND channel readiness, and waits for start', { timeout: 30000 }, async t => {
  const f = fixture(t);
  assert.throws(() => f.receiver.start(), /not ready/);
  const descriptions = await f.negotiate({ earlyIce: true });
  for (const description of Object.values(descriptions)) {
    assert.equal(isLocalMediaSdp(description.sdp), true);
    assert.equal((description.sdp.match(/^m=/gm) ?? []).length, 1);
    assert.doesNotMatch(description.sdp, /^m=(?:audio|video)/m);
  }
  assert.deepEqual(f.receiver.pc.getTransceivers(), []);
  assert.deepEqual(f.receiver.pc.getSenders(), []);
  assert.deepEqual(f.receiver.pc.getReceivers(), []);
  assert.deepEqual(f.receiver.pc.getConfiguration().iceServers, []);
  assert.ok(f.receiver.pc.iceTransports.every(transport => transport.connection.stunServer === undefined));
  assert.ok(f.executor.iceTransports.every(transport => transport.connection.stunServer === undefined));
  assert.equal(f.channel.ordered, true);
  assert.equal(f.channel.maxRetransmits, null);
  assert.equal(f.channel.maxPacketLifeTime, null);
  assert.ok(f.signals.some(signal => signal.signal.signalType === 'candidate'));
  assert.ok(f.signals.every(signal => signal.taskId === 'local-opus-test' && signal.mediaGeneration === 7));
  await wait(25);
  assert.deepEqual(f.controls, [], 'Connection alone must not authorize native media production.');
  f.receiver.pc.connectionStateChange.execute('connected');
  f.receiver.channel.stateChange.execute('open');
  assert.equal(f.ready.length, 1);
  await f.start();
  f.receiver.start();
  await wait(25);
  assert.deepEqual(f.controls, [{ kind: 'credit', consumedFrames: 0, windowEnd: 25 }]);
  assert.equal(f.receiver.playedFrames, 0);
  assert.equal(f.receiver.hasDrained, false);
});

test('a real connected peer without an open data channel is not ready and cannot issue credit', { timeout: 30000 }, async t => {
  const f = fixture(t);
  f.channel.close();
  const offer = await f.offer();
  await f.receiver.handleSignal(envelope({ signalType: 'offer', sdp: offer }));
  const answer = f.signals.find(signal => signal.signal.signalType === 'answer').signal.sdp;
  await f.executor.setRemoteDescription(answer);
  await until(() => f.receiver.pc.connectionState === 'connected');
  await wait(25);
  assert.equal(f.receiver.channel, undefined);
  assert.deepEqual(f.ready, []);
  assert.deepEqual(f.controls, []);
  assert.throws(() => f.receiver.start(), /not ready/);
});

test('25-packet ingress cap replenishes on handoff, not arrival, and PLAYED is a separate clock', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.negotiate();
  await f.start();
  for (let sequence = 0; sequence < 25; sequence++) f.send(frame(sequence));
  await until(() => f.receiver.packets.length === 25);
  assert.deepEqual(f.controls, [{ kind: 'credit', consumedFrames: 0, windowEnd: 25 }]);
  const iterator = f.receiver.frames[Symbol.asyncIterator]();
  const first = await within(iterator.next());
  assert.deepEqual(first, { done: false, value: SILENCE });
  assert.equal(Buffer.isBuffer(first.value), false, 'The iterator exposes Uint8Array, not a Node Buffer.');
  await until(() => f.flow.consumedFrames === 1);
  assert.equal(f.flow.windowEnd, 26);
  assert.equal(f.receiver.playedFrames, 0);
  assert.equal(f.controls.some(record => record.kind === 'played'), false);
  const next = iterator.next();
  f.send(frame(25));
  await until(() => f.receiver.packets.length === 25);
  await remainsPending(next);
  assert.equal(f.flow.consumedFrames, 1, 'Read-ahead must not create unlimited outstanding playback frames.');
  f.receiver.markFrameAdvanced();
  assert.deepEqual(await within(next), { done: false, value: SILENCE });
  await until(() => f.flow.consumedFrames === 2);
  assert.deepEqual(f.controls.slice(0, 4), [
    { kind: 'credit', consumedFrames: 0, windowEnd: 25 },
    { kind: 'credit', consumedFrames: 1, windowEnd: 26 },
    { kind: 'played', playedFrames: 1 },
    { kind: 'credit', consumedFrames: 2, windowEnd: 27 },
  ]);
  assert.equal(f.receiver.playedFrames, 1);
});

test('exclusive EOF waits for final playback, ACK and iterator drain, keeping SCTP alive until finish', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.negotiate();
  await f.start();
  assert.throws(() => f.receiver.markFrameAdvanced(), /No consumed/);
  f.send(frame(0));
  f.send(frame(1));
  f.send({ kind: 'end', finalSequence: 2 });
  await until(() => f.receiver.flow.finalSequence === 2);
  await assert.rejects(f.receiver.finish(), /before playback drained/);
  assert.equal(f.receiver.channel.readyState, 'open');
  const iterator = f.receiver.frames[Symbol.asyncIterator]();
  assert.deepEqual((await within(iterator.next())).value, SILENCE);
  const second = iterator.next();
  await remainsPending(second);
  f.receiver.markFrameAdvanced();
  assert.deepEqual((await within(second)).value, SILENCE);
  const eof = iterator.next();
  await remainsPending(eof);
  await remainsPending(f.receiver.drained);
  assert.equal(f.receiver.playedFrames, 1);
  assert.equal(f.receiver.hasDrained, false);
  assert.equal(f.controls.some(record => record.kind === 'drainAck'), false);
  await assert.rejects(f.receiver.finish(), /before playback drained/);
  f.receiver.markFrameAdvanced();
  await within(f.receiver.drained);
  assert.deepEqual(await within(eof), { done: true, value: undefined });
  await until(() => f.flow.drained);
  assert.equal(f.receiver.hasDrained, true);
  assert.equal(f.receiver.playedFrames, 2);
  assert.deepEqual(f.controls.slice(-2), [
    { kind: 'played', playedFrames: 2 }, { kind: 'drainAck', finalSequence: 2 },
  ]);
  assert.throws(() => f.receiver.markFrameAdvanced(), /No consumed/);
  await iterator.return();
  assert.equal(f.receiver.pc.connectionState, 'connected');
  assert.equal(f.receiver.channel.readyState, 'open');
  assert.equal(f.channel.readyState, 'open');
  assert.deepEqual(f.errors, []);
  const closing = f.receiver.finish();
  assert.equal(closing, f.receiver.finish());
  await within(closing);
  assert.equal(f.receiver.pc.connectionState, 'closed');
  assert.equal(f.receiver.channel.readyState, 'closed');
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('real executor close after its drain ACK does not override verified playback or later cancellation',
  { timeout: 30000 }, async t => {
    const f = fixture(t);
    await f.negotiate();
    await f.start();
    f.send(frame(0));
    f.send({ kind: 'end', finalSequence: 1 });
    const iterator = f.receiver.frames[Symbol.asyncIterator]();
    assert.deepEqual((await within(iterator.next())).value, SILENCE);
    f.receiver.markFrameAdvanced();
    await until(() => f.flow.drained);
    f.channel.close();
    await until(() => f.receiver.channel.readyState === 'closed');
    await f.executor.close();
    assert.equal(f.receiver.hasDrained, true);
    assert.equal(f.receiver.playedFrames, 1);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    const reason = new Error('Server revoked the task before its completion acknowledgement.');
    await f.receiver.abort(reason);
    await assert.rejects(iterator.next(), error => error === reason);
    await assert.rejects(f.receiver.finish(), error => error === reason);
  });

test('a zero-frame EOF drains only after start and never invents a played frame', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.negotiate();
  await f.start();
  f.send({ kind: 'end', finalSequence: 0 });
  await within(f.receiver.drained);
  await until(() => f.flow.drained);
  assert.deepEqual(f.controls, [
    { kind: 'credit', consumedFrames: 0, windowEnd: 25 }, { kind: 'drainAck', finalSequence: 0 },
  ]);
  assert.deepEqual(await f.receiver.frames[Symbol.asyncIterator]().next(), { done: true, value: undefined });
  assert.equal(f.receiver.channel.readyState, 'open');
  await f.receiver.finish();
});

test('abort flushes a full paused buffer and preserves the first cancellation reason', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.negotiate();
  await f.start();
  for (let sequence = 0; sequence < 25; sequence++) f.send(frame(sequence));
  await until(() => f.receiver.packets.length === 25);
  const reason = new Error('Requester cancelled while paused.');
  const closing = f.receiver.abort(reason);
  assert.equal(f.receiver.packets.length, 0);
  assert.equal(f.receiver.pendingCandidates.length, 0);
  assert.equal(f.receiver.subscriptions.length, 0);
  assert.equal(f.receiver.abort(new Error('Do not replace the reason.')), closing);
  await assert.rejects(f.receiver.drained, error => error === reason);
  await assert.rejects(f.receiver.frames[Symbol.asyncIterator]().next(), error => error === reason);
  await within(closing);
  assert.equal(f.receiver.pc.connectionState, 'closed');
  assert.equal(f.receiver.channel.onMessage.length, 0);
  assert.equal(f.receiver.channel.stateChange.length, 0);
  assert.equal(f.receiver.channel.error.length, 0);
  assert.equal(f.receiver.pc.onIceCandidate.length, 0);
  assert.equal(f.receiver.pc.onDataChannel.length, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(f.receiver.playedFrames, 0);
});

test('abort rejects a hung read immediately; concurrent reads and consumers cannot accumulate', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.negotiate();
  await f.start();
  const iterator = f.receiver.frames[Symbol.asyncIterator]();
  const pending = iterator.next();
  await assert.rejects(iterator.next(), /Concurrent/);
  assert.throws(() => f.receiver.frames[Symbol.asyncIterator](), /single playback consumer/);
  const reason = new Error('Cancelled without awaiting the player read.');
  const closing = f.receiver.abort(reason);
  await within(assert.rejects(pending, error => error === reason), 500);
  await assert.rejects(f.receiver.drained, error => error === reason);
  await assert.rejects(f.receiver.finish(), error => error === reason);
  await assert.rejects(f.receiver.handleSignal(envelope({ signalType: 'candidate', candidate: null })), error => error === reason);
  assert.throws(() => f.receiver.start(), error => error === reason);
  assert.throws(() => f.receiver.markFrameAdvanced(), error => error === reason);
  await within(closing);
  assert.deepEqual(f.errors, []);
});

test('iterator return and throw can interrupt a hung next rather than queue behind it', { timeout: 30000 }, async t => {
  for (const operation of ['return', 'throw']) {
    await t.test(operation, async t => {
      const f = fixture(t);
      await f.negotiate();
      await f.start();
      const iterator = f.receiver.frames[Symbol.asyncIterator]();
      const pending = iterator.next();
      const result = operation === 'return' ? iterator.return() : iterator.throw(new Error('Player stopped.'));
      const rejectedResult = operation === 'throw' ? assert.rejects(result, /Player stopped/) : result;
      await within(assert.rejects(pending, /cancelled|Player stopped/), 500);
      await within(rejectedResult);
      await assert.rejects(f.receiver.drained, /cancelled|Player stopped/);
      assert.deepEqual(f.errors, []);
    });
  }
});

test('real SCTP rejects malformed, wrong-direction, oversent, stale and inconsistent EOF records', { timeout: 120000 }, async t => {
  const cases = [
    { name: 'short binary', data: Buffer.from([1]), error: /record length/ },
    { name: 'text message', data: 'not an Opus binary record', error: /must be binary/ },
    { name: 'empty Opus', data: Buffer.from([1, 0, 0, 0, 0]), error: /20 ms Opus/ },
    { name: 'wrong duration', data: Buffer.from([1, 0, 0, 0, 0, 0x80]), error: /20 ms Opus/ },
    { name: 'oversized packet', ignoreMessageLimit: true, data: Buffer.alloc(6 + LOCAL_MEDIA_FORMAT.maxPacketBytes), error: /record length/ },
    { name: 'reserved wrapping sequence', data: Buffer.from([1, 255, 255, 255, 255, ...SILENCE]), error: /4294967294/ },
    { name: 'unknown record', data: Buffer.from([9, 0, 0, 0, 0]), error: /Unknown/ },
    { name: 'executor credit', data: binary({ kind: 'credit', consumedFrames: 0, windowEnd: 25 }), error: /wrong sender/ },
    { name: 'executor played', data: binary({ kind: 'played', playedFrames: 0 }), error: /wrong sender/ },
    { name: 'executor drain ACK', data: binary({ kind: 'drainAck', finalSequence: 0 }), error: /wrong sender/ },
    { name: 'sequence gap', data: binary(frame(1)), error: /out of sequence/ },
    { name: 'stale frame', before: [frame(0)], data: binary(frame(0)), error: /out of sequence/ },
    { name: '26th uncredited frame', before: Array.from({ length: 25 }, (_, sequence) => frame(sequence)), data: binary(frame(25)), error: /credit/ },
    { name: 'wrong exclusive EOF', data: binary({ kind: 'end', finalSequence: 1 }), error: /EOF/ },
    { name: 'duplicate EOF', before: [frame(0), { kind: 'end', finalSequence: 1 }], data: binary({ kind: 'end', finalSequence: 1 }), error: /EOF/ },
    { name: 'frame after EOF', before: [frame(0), { kind: 'end', finalSequence: 1 }], data: binary(frame(1)), error: /out of sequence/ },
    { name: 'EOF before authoritative start', noStart: true, data: binary({ kind: 'end', finalSequence: 0 }), error: /before authoritative start/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const f = fixture(t);
      await f.negotiate();
      if (!scenario.noStart) await f.start();
      for (const record of scenario.before ?? []) f.send(record);
      // A deliberately noncompliant peer must bypass its own negotiated send-size check.
      if (scenario.ignoreMessageLimit) f.channel.sctp.setRemoteMaxMessageSize(0);
      const iterator = f.receiver.frames[Symbol.asyncIterator]();
      const pending = scenario.before ? undefined : iterator.next();
      const rejectedRead = pending ? assert.rejects(pending, scenario.error) : undefined;
      f.channel.send(scenario.data);
      await until(() => f.errors.length > 0);
      assert.equal(f.errors.length, 1);
      assert.match(f.errors[0].message, scenario.error);
      if (rejectedRead) await within(rejectedRead);
      await assert.rejects(f.receiver.drained, scenario.error);
      await assert.rejects(iterator.next(), scenario.error);
      assert.equal(f.receiver.packets.length, 0);
      await f.receiver.abort(new Error('Already failed.'));
    });
  }
});

test('real DCEP rejects unexpected channel parameters and a second otherwise valid channel', { timeout: 60000 }, async t => {
  for (const options of [
    { label: 'another-channel' },
    { channelOptions: { protocol: 'other-protocol' } },
    { channelOptions: { ordered: false } },
    { channelOptions: { maxRetransmits: 0 } },
    { channelOptions: { maxPacketLifeTime: 100 } },
  ]) {
    await t.test(JSON.stringify(options), async t => {
      const f = fixture(t, options);
      await f.negotiate({ expectReady: false });
      assert.equal(f.ready.length, 0);
      await assert.rejects(f.receiver.drained, /fixed reliable, ordered/);
      assert.equal(f.errors.length, 1);
    });
  }
  await t.test('additional channel', async t => {
    const f = fixture(t);
    await f.negotiate();
    f.executor.createDataChannel(LOCAL_MEDIA_CHANNEL_LABEL, LOCAL_MEDIA_CHANNEL_OPTIONS);
    await until(() => f.errors.length > 0);
    await assert.rejects(f.receiver.drained, /extra local media data channel/);
    assert.equal(f.ready.length, 1);
    assert.equal(f.errors.length, 1);
  });
});

test('signals reject another task, stale generation, wrong role and audio/video m-lines before native application', { timeout: 30000 }, async t => {
  for (const scenario of ['task', 'generation', 'answer', 'audio', 'video']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      if (scenario === 'audio' || scenario === 'video') f.executor.addTransceiver(scenario);
      const offer = await f.offer();
      const signal = envelope({ signalType: 'offer', sdp: offer });
      if (scenario === 'task') signal.taskId = 'another-task';
      if (scenario === 'generation') signal.mediaGeneration--;
      if (scenario === 'answer') signal.signal = { signalType: 'answer', sdp: { ...offer, type: 'answer' } };
      await assert.rejects(f.receiver.handleSignal(signal), /another task or generation|not answers|m-line/);
      assert.equal(f.receiver.pc.remoteDescription, null);
      assert.deepEqual(f.receiver.pc.getTransceivers(), []);
      assert.equal(f.errors.length, 1);
      assert.deepEqual(f.signals, []);
    });
  }
});

test('the receiver never renegotiates an existing generation', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const { offer } = await f.negotiate();
  const count = f.signals.length;
  await assert.rejects(f.receiver.handleSignal(envelope({ signalType: 'offer', sdp: offer })), /renegotiation/);
  assert.equal(f.signals.length, count);
  assert.equal(f.errors.length, 1);
  await assert.rejects(f.receiver.drained, /renegotiation/);
});

test('only authenticated ICE is retained, without werift public STUN fallback for TURN-only tasks', { timeout: 30000 }, async t => {
  for (const protocol of ['stun', 'turn']) {
    await t.test(protocol, async t => {
      const iceServers = [{ urls: [`${protocol}:127.0.0.1:9`], username: 'local-test', credential: 'local-test' }];
      const f = fixture(t, { iceServers });
      const offer = await f.offer();
      const entered = deferred(), release = deferred();
      const createAnswer = f.receiver.pc.createAnswer.bind(f.receiver.pc);
      f.receiver.pc.createAnswer = async () => {
        const answer = await createAnswer();
        entered.resolve();
        await release.promise;
        return answer;
      };
      t.after(() => release.resolve());
      const signaling = f.receiver.handleSignal(envelope({ signalType: 'offer', sdp: offer }));
      const cancelled = assert.rejects(signaling, /Do not contact ICE servers/);
      await within(entered.promise);
      assert.deepEqual(f.receiver.pc.getConfiguration().iceServers, iceServers);
      const connection = f.receiver.pc.iceTransports[0].connection;
      assert.deepEqual(connection.stunServer, protocol === 'stun' ? ['127.0.0.1', 9] : undefined);
      assert.deepEqual(connection.turnServer, protocol === 'turn' ? ['127.0.0.1', 9] : undefined);
      assert.deepEqual(connection.protocols, [], 'No STUN or TURN gathering is run in this configuration test.');
      await f.receiver.abort(new Error('Do not contact ICE servers.'));
      await within(cancelled);
      release.resolve();
      await until(() => !f.receiver.signaling);
      assert.deepEqual(f.signals, []);
    });
  }
});

test('early ICE candidates are bounded across the entire generation, including candidates embedded in SDP', { timeout: 30000 }, async t => {
  await t.test('trickled candidates', async t => {
    const f = fixture(t);
    const signal = envelope({
      signalType: 'candidate',
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    for (let i = 0; i < LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates; i++) await f.receiver.handleSignal(signal);
    assert.equal(f.receiver.pendingCandidates.length, 256);
    await assert.rejects(f.receiver.handleSignal(signal), /candidate limit exceeded/);
    assert.equal(f.receiver.pendingCandidates.length, 0);
    assert.equal(f.errors.length, 1);
  });
  await t.test('embedded candidates', async t => {
    const f = fixture(t);
    const offer = await f.offer();
    const candidate = candidates(offer.sdp)[0];
    assert.ok(candidate);
    offer.sdp += Array.from({ length: 257 }, () => `a=${candidate.candidate}\r\n`).join('');
    await assert.rejects(f.receiver.handleSignal(envelope({ signalType: 'offer', sdp: offer })), /candidate limit exceeded/);
    assert.equal(f.receiver.pc.remoteDescription, null);
  });
});

test('applicable ICE validates MID, index, username fragments and malformed native candidates', { timeout: 60000 }, async t => {
  for (const scenario of ['mid', 'index', 'fragment', 'conflicting fragment', 'missing identity', 'malformed']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      const { offer } = await f.negotiate();
      const candidate = { ...candidates(offer.sdp)[0] };
      if (scenario === 'mid') candidate.sdpMid = 'other-mid';
      if (scenario === 'index') candidate.sdpMLineIndex = 1;
      if (scenario === 'fragment') candidate.usernameFragment = 'stale-generation';
      if (scenario === 'conflicting fragment') candidate.candidate += ' ufrag conflicting';
      if (scenario === 'missing identity') { delete candidate.sdpMid; delete candidate.sdpMLineIndex; }
      if (scenario === 'malformed') candidate.candidate = 'invalid ICE candidate';
      await assert.rejects(f.receiver.handleSignal(envelope({ signalType: 'candidate', candidate })));
      assert.equal(f.errors.length, 1);
      await assert.rejects(f.receiver.drained);
    });
  }
  await t.test('candidate foundation is not its ufrag extension', async t => {
    const f = fixture(t);
    const { offer } = await f.negotiate();
    const candidate = candidates(offer.sdp)[0];
    await f.receiver.handleSignal(envelope({
      signalType: 'candidate', candidate: {
        ...candidate,
        candidate: candidate.candidate.replace(/^candidate:\S+/, 'candidate:ufrag') + ` ufrag ${candidate.usernameFragment}`,
      },
    }));
    assert.deepEqual(f.errors, []);
  });
});

test('the bounded signaling queue rejects every waiter on abort without waiting for a hung SDP operation', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const offer = await f.offer();
  const entered = deferred(), release = deferred();
  const createAnswer = f.receiver.pc.createAnswer.bind(f.receiver.pc);
  f.receiver.pc.createAnswer = async () => {
    const answer = await createAnswer();
    entered.resolve();
    await release.promise;
    return answer;
  };
  t.after(() => release.resolve());
  const pending = [f.receiver.handleSignal(envelope({ signalType: 'offer', sdp: offer }))];
  void pending[0].catch(() => undefined);
  await within(entered.promise);
  for (let i = 1; i < LOCAL_EXECUTION_PROTOCOL_LIMITS.queuedSignals; i++) {
    const queued = f.receiver.handleSignal(envelope({ signalType: 'candidate', candidate: null }));
    void queued.catch(() => undefined);
    pending.push(queued);
  }
  assert.equal(f.receiver.signalQueue.length, 127);
  await assert.rejects(f.receiver.handleSignal(envelope({ signalType: 'candidate', candidate: null })), /signaling queue/);
  const results = await within(Promise.allSettled(pending), 500);
  assert.ok(results.every(result => result.status === 'rejected' && /signaling queue/.test(result.reason.message)));
  assert.equal(f.receiver.signalQueue.length, 0);
  await within(f.receiver.abort(new Error('Already cancelled.')), 500);
  assert.equal(f.receiver.pc.connectionState, 'closed');
  release.resolve();
  await until(() => !f.receiver.signaling);
  assert.deepEqual(f.signals, [], 'A late createAnswer must never send an answer or start local ICE.');
  assert.ok(f.receiver.pc.dtlsTransports.every(transport => transport.state === 'closed'));
});

test('abort also settles a werift description promise that becomes pending forever during close', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const offer = await f.offer();
  const original = f.receiver.pc.setRemoteDescription.bind(f.receiver.pc);
  const reason = new Error('Closed during native setRemoteDescription.');
  f.receiver.pc.setRemoteDescription = description => {
    const operation = original(description);
    void f.receiver.abort(reason);
    return operation;
  };
  await within(assert.rejects(
    f.receiver.handleSignal(envelope({ signalType: 'offer', sdp: offer })), error => error === reason,
  ), 500);
  await within(f.receiver.abort(reason), 500);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.receiver.pc.connectionState, 'closed');
});

test('asynchronous signal callback and channel failures are surfaced, not silently converted to EOF', { timeout: 30000 }, async t => {
  await t.test('signaling callback failure during gathering', async t => {
    const reason = new Error('Server signaling is unavailable.');
    const f = fixture(t, { sendSignal: () => { throw reason; } });
    const offer = await f.offer();
    await assert.rejects(f.receiver.handleSignal(envelope({ signalType: 'offer', sdp: offer })), error => error === reason);
    await assert.rejects(f.receiver.drained, error => error === reason);
    assert.deepEqual(f.errors, [reason]);
    await within(f.receiver.abort(reason));
    await until(() => !f.receiver.signaling);
    assert.ok(f.receiver.pc.dtlsTransports.every(transport => transport.iceTransport.connection.protocols.length === 0));
  });
  await t.test('remote closes without completing', async t => {
    const f = fixture(t);
    await f.negotiate();
    await f.start();
    const next = f.receiver.frames[Symbol.asyncIterator]().next();
    const rejected = assert.rejects(next, /closed before playback drained/);
    f.channel.close();
    await within(rejected);
    await assert.rejects(f.receiver.drained, /closed before playback drained/);
    assert.equal(f.errors.length, 1);
  });
  await t.test('ready callback failure', async t => {
    const reason = new Error('Unable to report media readiness.');
    const f = fixture(t, { onReady: () => { throw reason; } });
    await f.negotiate({ expectReady: false });
    await assert.rejects(f.receiver.drained, error => error === reason);
    assert.deepEqual(f.errors, [reason]);
    assert.equal(f.ready.length, 1);
  });
});

test('the 20-second deadline includes a missing data channel, and abort removes its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  const receiver = new LocalOpusReceiver({
    taskId: 'deadline-test', generation: 1, iceServers: [],
    sendSignal: () => {}, onReady: () => assert.fail('An unconnected receiver cannot be ready.'),
    onError: error => errors.push(error),
  });
  t.after(() => receiver.abort(new Error('Deadline fixture disposed.')));
  t.mock.timers.tick(LOCAL_EXECUTION_PROTOCOL_LIMITS.mediaConnectTimeoutMs - 1);
  assert.equal(errors.length, 0);
  t.mock.timers.tick(1);
  assert.equal(errors.length, 1);
  await assert.rejects(receiver.drained, /timed out/);
  await receiver.abort(new Error('Already timed out.'));
  t.mock.timers.tick(LOCAL_EXECUTION_PROTOCOL_LIMITS.mediaConnectTimeoutMs);
  assert.equal(errors.length, 1);
});
