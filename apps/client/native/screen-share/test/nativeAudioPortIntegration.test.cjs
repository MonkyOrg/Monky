'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { MessageChannel } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { NativeAudioPortMain } = require('../runtime/nativeAudioPortMain.cjs');
const { NativeAudioPortRenderer, registerNativeAudioPortReceiver } = require('../runtime/nativeAudioPortRenderer.cjs');
const { createNativeAudioOutput } = require('../runtime/nativeAudioOutput.cjs');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');
const { boundedCleanup } = require('../runtime/frameSink.cjs');
const protocol = require('@monky/shared');

const config = epoch => ({ epoch, sinkId: 'chosen-output', sampleRate: 48000, channels: 2 });
const pcm = (epoch = 1, sequence = 0) => ({ epoch, sequence, firstPlayoutFrame: sequence * 480,
  frames: 480, sampleRate: 48000, channels: 2, samples: new Float32Array(960).fill(.25) });
const invalidated = (epoch, reason = 'transport-detached') => ({
  type: 'audio.outputInvalidated', target: 0, data: { epoch, reason },
});
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const until = async condition => {
  for (let index = 0; index < 500; index++) {
    if (condition()) return;
    await delay(1);
  }
  assert.fail('Expected native audio integration observation did not arrive.');
};

function fixture(t, options = {}) {
  const calls = [], errors = [], errorContexts = [], credits = [], feedback = [], contexts = [], nodes = [], channels = [], timers = new Map();
  const ipc = new EventEmitter(), contents = new EventEmitter();
  let contextCount = 0, nextTimer = 1, destroyed = false;
  const frame = {
    url: options.documentUrl ?? 'file:///C:/owned/nativeRtc.html', detached: false,
    isDestroyed: () => destroyed,
    postMessage(channel, info, ports) {
      calls.push('transfer');
      if (options.transferFailure) throw options.transferFailure;
      ipc.emit(channel, { ports }, info);
    },
  };
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => destroyed });
  const rendererOptions = {
    workletUrl: 'nativePcmPlayout.worklet.js', now: () => 100, timeoutMs: options.timeoutMs ?? 250,
    setTimer(callback, ms) { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    createContext() {
      calls.push('context');
      contextCount++;
      if (options.contextFailure) throw options.contextFailure;
      const listeners = new Map();
      const context = {
        state: 'suspended', sampleRate: 48000, sinkId: '', destination: {}, listeners,
        audioWorklet: { async addModule() { calls.push('module'); } },
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
        async setSinkId(id) {
          calls.push('sink');
          if (options.sinkGate) await options.sinkGate.promise;
          if (options.sinkFailure) throw options.sinkFailure;
          this.sinkId = id;
        },
        async resume() { calls.push('resume'); this.state = 'running'; },
        async close() {
          calls.push('context-close');
          if (options.closeGate) await options.closeGate.promise;
          this.state = 'closed';
        },
        getOutputTimestamp: () => ({ contextTime: options.physicalTime ?? 1, performanceTime: 100 }),
      };
      contexts.push(context);
      return context;
    },
    createWorklet(context) {
      calls.push('worklet');
      const posted = [];
      const node = {
        context, posted,
        port: {
          onmessage: null,
          postMessage: (message, transfers = []) => posted.push(structuredClone(message, { transfer: transfers })),
          close: () => calls.push('worklet-port-close'),
        },
        connect: () => calls.push('connect'),
        disconnect: () => calls.push('disconnect'),
      };
      nodes.push(node);
      return node;
    },
  };
  const receiver = registerNativeAudioPortReceiver(ipc, protocol, {
    ...rendererOptions, onError: error => errors.push(error),
  });
  const mainOptions = {
    webContents: contents, frame, expectedUrl: frame.url, sessionId: 'owned-engine',
    protocol, createMessageChannel() { const channel = new MessageChannel(); channels.push(channel); return channel; },
    controls: {
      async configureOutput(value) {
        calls.push('configure');
        assert.equal(contexts.at(-1)?.state, 'running');
        if (!options.withOwner) assert.equal(contexts.at(-1)?.sinkId, value.sinkId);
        if (options.configureGate) await options.configureGate.promise;
        if (options.configureFailure) throw options.configureFailure;
        calls.push('configured');
        return { epoch: value.epoch, sampleRate: 48000, channels: 2 };
      },
      probe(value) { calls.push('probe'); return { ...value, rtcBeforeUs: 1000000, rtcAfterUs: 1000001 }; },
      calibrate(value) { calls.push('calibrate'); return {
        epoch: value.epoch, calibrationId: value.probeId, offsetUs: 900000, uncertaintyUs: 1,
      }; },
      grantCredits: value => { credits.push(value); },
      feedback: value => { feedback.push(value); },
    },
    onError(error, context) {
      errors.push(error);
      errorContexts.push(context);
      return options.onError?.(error, context);
    },
  };
  let main, owner = null, commands = null;
  if (options.withOwner) {
    const controls = mainOptions.controls;
    const engine = {
      request(id, operation, target, data) {
        assert.deepEqual(commands.getPendingRequest(id), { id, operation, target, data });
        assert.equal(target, 0);
        if (operation === 'audio.configureOutput') {
          assert.deepEqual(Object.keys(data), ['epoch']);
          return controls.configureOutput(data);
        }
        if (operation === 'audio.stopOutput') {
          calls.push(`native-stop:${data.epoch}`);
          return options.nativeStop ? options.nativeStop(data) : Promise.resolve({});
        }
        throw new Error(`Unexpected composed output command ${operation}`);
      },
      grantAudioCredits: controls.grantCredits,
      audioClockProbe: controls.probe,
      calibrateAudioClock: controls.calibrate,
      setAudioOutputFeedback: controls.feedback,
      close() { calls.push('native-engine-close'); return Promise.resolve({ closed: true }); },
    };
    commands = new NativeRtcCommands(engine);
    const output = createNativeAudioOutput({ ...mainOptions, engine, commands, timeoutMs: options.timeoutMs ?? 250 });
    owner = output.owner;
    main = output.renderer;
  } else {
    main = new NativeAudioPortMain(mainOptions);
  }
  t.after(async () => {
    for (const name of ['sinkGate', 'configureGate', 'closeGate']) options[name]?.resolve();
    if (owner && !owner.getStats().stopped) {
      try { await boundedCleanup(owner.stop(), 'Fixture global audio did not stop.', 1000); }
      catch {
        destroyed = true;
        contents.emit('destroyed');
        await owner.finishAfterEngineClose(commands.closeEngine());
      }
    }
    if (main.current) {
      try { await boundedCleanup(main.stop(main.current.config.epoch), 'Fixture output did not stop.', 1000); }
      catch {
        destroyed = true;
        contents.emit('destroyed');
        await main.stop(main.current.config.epoch);
      }
    }
    await receiver.dispose();
    for (const { port1, port2 } of channels) { port1.close(); port2.close(); }
  });
  return {
    main, owner, commands, receiver, rendererOptions, frame, contents, ipc, calls, errors, errorContexts,
    contexts, nodes, credits, feedback,
    timers, channels, contextCount: () => contextCount,
    emit(message) { nodes.at(-1).port.onmessage?.({ data: message }); },
    grant(epoch = 1) { this.emit({ type: 'credits', epoch, grantSequence: 1, frames: 960 }); },
    destroy() { destroyed = true; contents.emit('destroyed'); },
  };
}

test('registering native audio IPC and constructing Main ownership opens no output or channels', async t => {
  const f = fixture(t);
  assert.equal(f.contextCount(), 0);
  assert.equal(f.channels.length, 0);
  assert.equal(f.contents.eventNames().length, 0);
  assert.equal(f.ipc.listenerCount(protocol.NATIVE_SCREEN_AUDIO_IPC.outputPort), 1);
  await f.receiver.dispose();
  assert.equal(f.ipc.listenerCount(protocol.NATIVE_SCREEN_AUDIO_IPC.outputPort), 0);
});

test('one private port connects selected output, native configuration, clock calibration and readiness in order', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.main.start(config(1)), config(1));
  assert.deepEqual(f.calls, ['transfer', 'context', 'sink', 'module', 'resume', 'configure',
    'configured', 'probe', 'calibrate', 'worklet', 'connect']);
  assert.equal(f.main.getStats().current.ready, true);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, 100);
  assert.deepEqual(f.credits, []);
  assert.deepEqual(f.errors, []);
});

test('actual ports carry only worklet-earned PCM credits and transfer a copied packet into the worklet', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  f.grant();
  await until(() => f.credits.length === 1);
  const packet = pcm();
  await f.main.enqueue(packet);
  await until(() => f.nodes[0].posted.some(value => value.type === 'pcm'));
  const played = f.nodes[0].posted.find(value => value.type === 'pcm').packet;
  assert.equal(played.samples[0], .25);
  assert.equal(packet.samples.byteLength, 3840);
  assert.deepEqual(f.credits, [{ epoch: 1, grantSequence: 1, frames: 960 }]);
  assert.equal(f.receiver.getStats().sessions[0].sink.acceptedFrames, 480);
  assert.equal(f.timers.size, 1, 'There is only a clock refresh, not a PCM pacing timer.');
});

test('calibrated physical feedback crosses that same port without replacing a negative initial position', async t => {
  const f = fixture(t, { physicalTime: .998 });
  await f.main.start(config(1));
  f.emit({ type: 'feedback', epoch: 1, clockEpoch: 1, state: 'running',
    contextFrame: 48000, frames: 128, firstPlayoutFrame: 0, mediaFrames: 128, queuedFrames: 960 });
  await until(() => f.feedback.length === 1);
  assert.equal(f.feedback[0].available, true);
  assert.ok(f.feedback[0].estimatedPlayoutFrame < 0);
  assert.equal(f.feedback[0].calibrationId, 1);
  assert.equal(f.feedback[0].confirmedPcmEnd, 1088);
  f.emit({ type: 'feedback', epoch: 1, clockEpoch: 2, state: 'buffering',
    contextFrame: 48128, frames: 128, firstPlayoutFrame: null, mediaFrames: 0, queuedFrames: 0 });
  await until(() => f.feedback.length === 2);
  assert.deepEqual(f.feedback[1], { epoch: 1, available: false });
});

test('stopping removes both clock work and owned IPC listeners only after the actual context closes', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  assert.deepEqual(await f.main.stop(1), { epoch: 1, stopped: true });
  await until(() => f.receiver.getStats().sessions.length === 0);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.contexts[0].listeners.size, 0);
  assert.equal(f.nodes[0].port.onmessage, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.contents.eventNames().length, 0);
  assert.equal(f.main.getStats().last.retirement, 'renderer-context-closed');
  assert.equal(f.main.getStats().retiredThrough, 1);
});

test('cancel before admission creates neither MessagePort nor AudioContext', async t => {
  const f = fixture(t), abort = new AbortController();
  abort.abort(new Error('Cancelled before output.'));
  await assert.rejects(f.main.start(config(1), abort.signal), /Cancelled before output/);
  assert.equal(f.channels.length, 0);
  assert.equal(f.contextCount(), 0);
  assert.equal(f.main.getStats().lastEpoch, 0);
});

test('Stop does not deadlock against Renderer start while native configure remains pending', async t => {
  const configureGate = deferred(), f = fixture(t, { configureGate }), abort = new AbortController();
  const starting = f.main.start(config(1), abort.signal);
  const cancelledStart = assert.rejects(starting, /cancelled by caller/);
  await until(() => f.calls.includes('configure'));
  abort.abort(new Error('Output cancelled by caller.'));
  await cancelledStart;
  assert.deepEqual(await f.main.stop(1), { epoch: 1, stopped: true });
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.calls.includes('configured'), false, 'Renderer retirement says nothing about the separately owned native configure.');
  configureGate.resolve();
  await until(() => f.calls.includes('configured'));
  assert.equal(f.calls.includes('worklet'), false);
  assert.equal(f.main.getStats().current, null);
});

test('late device selection cannot create a worklet after its context has been stopped', async t => {
  const sinkGate = deferred(), f = fixture(t, { sinkGate });
  const starting = f.main.start(config(1));
  const rejected = assert.rejects(starting, /cancelled/);
  await until(() => f.calls.includes('sink'));
  await f.main.stop(1);
  await rejected;
  sinkGate.resolve();
  await delay(5);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.calls.includes('configure'), false);
  assert.equal(f.nodes.length, 0);
});

test('pending AudioContext.close retains the Renderer epoch and prevents a replacement', async t => {
  const closeGate = deferred(), f = fixture(t, { closeGate });
  await f.main.start(config(1));
  const stopped = f.main.stop(1);
  await until(() => f.calls.includes('context-close'));
  assert.equal(f.main.getStats().retiredThrough, 0);
  await assert.rejects(f.main.start(config(2)), /complete Renderer retirement/);
  closeGate.resolve();
  await stopped;
  assert.equal(f.main.getStats().retiredThrough, 1);
});

test('local disposal racing an admitted Stop preserves the actual Renderer closure receipt', async t => {
  const closeGate = deferred(), f = fixture(t, { closeGate });
  await f.main.start(config(1));
  const disposed = f.receiver.dispose();
  await until(() => f.calls.includes('context-close'));
  const stopped = f.main.stop(1).then(result => ({ result }), error => ({ error }));
  await until(() => f.receiver.getStats().sessions[0]?.port.incomingRequests === 1);
  closeGate.resolve();
  await disposed;
  assert.deepEqual(await stopped, { result: { epoch: 1, stopped: true } });
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.main.getStats().retiredThrough, 1);
});

test('a local closure receipt can precede Stop without requiring destruction of WebContents', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  await f.receiver.dispose();
  await until(() => f.main.getStats().current?.retirement === 'renderer-context-disposed');
  assert.equal(f.contents.isDestroyed(), false);
  assert.equal(f.contexts[0].state, 'closed');
  assert.deepEqual(await f.main.stop(1), { epoch: 1, stopped: true });
  assert.equal(f.main.getStats().retiredThrough, 1);
  assert.equal(f.contents.eventNames().length, 0);
});

test('failed local context closure cannot emit a disposal receipt or discard retry ownership', async t => {
  const closeGate = deferred(), f = fixture(t, { closeGate, timeoutMs: 35 });
  await f.main.start(config(1));
  await assert.rejects(f.receiver.dispose(), /still owns output contexts/);
  assert.equal(f.main.getStats().current.retirement, null);
  assert.equal(f.main.getStats().retiredThrough, 0);
  assert.equal(f.receiver.getStats().sessions.length, 1);
  closeGate.resolve();
  await until(() => f.contexts[0].state === 'closed');
  await f.receiver.dispose();
  await until(() => f.main.getStats().current.retirement === 'renderer-context-disposed');
  await f.main.stop(1);
});

test('a timed-out close remains retryable and cannot masquerade as a stopped output', async t => {
  const closeGate = deferred(), f = fixture(t, { closeGate, timeoutMs: 35 });
  await f.main.start(config(1));
  await assert.rejects(f.main.stop(1), /cleanup failed/);
  assert.equal(f.main.getStats().retiredThrough, 0);
  assert.equal(f.receiver.getStats().sessions[0].sink.stopped, false);
  closeGate.resolve();
  await until(() => f.contexts[0].state === 'closed');
  await f.main.stop(1);
  assert.equal(f.main.getStats().retiredThrough, 1);
});

test('output-device failure is explicit and does not fall back to another device', async t => {
  const f = fixture(t, { sinkFailure: new Error('Selected device disappeared.') });
  await assert.rejects(f.main.start(config(1)), /Selected device disappeared/);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.calls.filter(value => value === 'sink').length, 1);
  assert.equal(f.calls.includes('configure'), false);
  await f.main.stop(1);
  assert.equal(f.main.getStats().retiredThrough, 1);
});

test('failure to construct AudioContext has no fictitious context obligation left to retire', async t => {
  const f = fixture(t, { contextFailure: new Error('AudioContext is unavailable.') });
  await assert.rejects(f.main.start(config(1)), /AudioContext is unavailable/);
  assert.equal(f.contexts.length, 0);
  await f.main.stop(1);
  assert.equal(f.main.getStats().retiredThrough, 1);
});

test('worklet failure after readiness stops the real context and is visible to Main', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  f.nodes[0].onprocessorerror();
  await until(() => f.main.getStats().current.error !== null);
  await until(() => f.contexts[0].state === 'closed');
  assert.match(f.main.getStats().current.error, /AudioWorklet processing failed/);
  await assert.rejects(f.main.enqueue(pcm()), /matching active/);
  await f.main.stop(1);
});

test('a Main output error closes Renderer audio without reflecting an error loop back over the port', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  await f.main.current.port.enqueue('error', { code: 'ERR_OUTPUT_EXAMPLE', message: 'The native output was invalidated.' });
  await until(() => f.contexts[0].state === 'closed');
  assert.equal(f.main.getStats().current.error, null);
  assert.ok(f.receiver.getStats().sessions[0].errors.some(value => value.includes('invalidated')));
  await f.main.stop(1);
});

test('a full document navigation invalidates controls but can still retire the old private output', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  f.frame.url = 'https://foreign.example/';
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await assert.rejects(f.main.enqueue(pcm()), /matching active/);
  await f.main.stop(1);
  assert.equal(f.contexts[0].state, 'closed');
});

test('same-document navigation and iframe navigation do not invalidate the owned main frame', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  f.frame.url += '#quality';
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  f.grant();
  await until(() => f.credits.length === 1);
  await f.main.enqueue(pcm());
  assert.equal(f.main.getStats().current.error, null);
});

for (const documentUrl of ['http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/']) {
  test(`native output accepts only the exact explicitly owned development document (${documentUrl})`, async t => {
    const f = fixture(t, { documentUrl });
    await f.main.start(config(1));
    await f.main.stop(1);
    f.frame.url = `${documentUrl}foreign`;
    await assert.rejects(f.main.start(config(2)), /foreign Renderer document/);
    await f.main.stop(2);
  });
}

test('foreign or replaced frames are rejected before any output or port is opened', async t => {
  const f = fixture(t);
  f.contents.mainFrame = { ...f.frame };
  await assert.rejects(f.main.start(config(1)), /replaced or foreign/);
  assert.deepEqual(await f.main.stop(1), { epoch: 1, stopped: true });
  assert.equal(f.main.getStats().last.retirement, 'not-transferred');
  f.contents.mainFrame = f.frame;
  f.frame.url = 'https://foreign.example/';
  await assert.rejects(f.main.start(config(2)), /owned local document/);
  assert.deepEqual(await f.main.stop(2), { epoch: 2, stopped: true });
  assert.equal(f.main.getStats().last.retirement, 'not-transferred');
  assert.equal(f.channels.length, 0);
  assert.equal(f.contextCount(), 0);
});

test('port closure alone retains ownership; genuine Renderer destruction may subsequently retire it', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  f.channels[0].port2.close();
  await until(() => f.main.getStats().current.error !== null);
  await assert.rejects(f.main.stop(1), /not open/);
  assert.equal(f.main.getStats().retiredThrough, 0);
  f.destroy();
  await f.main.stop(1);
  assert.equal(f.main.getStats().last.retirement, 'web-contents-destroyed');
});

test('ambiguous port transfer failure is not proof of absent Renderer resources', async t => {
  const f = fixture(t, { transferFailure: new Error('Transfer failed after an unknown point.') });
  await assert.rejects(f.main.start(config(1)), /unknown point/);
  const stop = f.main.stop(1);
  await assert.rejects(boundedCleanup(stop, 'Renderer receipt was not observed.', 10), /not observed/);
  assert.equal(f.main.getStats().retiredThrough, 0);
  f.destroy();
  await stop;
  assert.equal(f.main.getStats().last.retirement, 'web-contents-destroyed');
});

test('new epochs replace only a retired output and old stop calls cannot affect the replacement', async t => {
  const f = fixture(t);
  await f.main.start(config(1));
  await f.main.stop(1);
  await f.main.start({ ...config(3), sinkId: 'new-selected-output' });
  assert.equal(f.contexts[1].sinkId, 'new-selected-output');
  await f.main.stop(1);
  await f.main.stop(2);
  assert.equal(f.contexts[1].state, 'running');
  await assert.rejects(f.main.enqueue(pcm(1)), /matching active/);
  await assert.rejects(f.main.start(config(1)), /epochs must increase/);
});

test('malformed transfer descriptors are rejected without constructing audio or exposing the port', async t => {
  const f = fixture(t), { port1, port2 } = new MessageChannel();
  t.after(() => { port1.close(); port2.close(); });
  f.ipc.emit(protocol.NATIVE_SCREEN_AUDIO_IPC.outputPort, { ports: [port2] }, {
    version: 1, sessionId: 'bad-engine', portId: 'private-bad', output: { ...config(1), channels: 1 },
  });
  assert.equal(f.contextCount(), 0);
  assert.match(f.errors[0].message, /one valid scoped port/);
  assert.equal(f.receiver.getStats().sessions.length, 0);
});

test('an inactive Renderer may be retired without ever allocating an AudioContext', async t => {
  const f = fixture(t), { port1, port2 } = new MessageChannel();
  t.after(() => { port1.close(); port2.close(); });
  let retired = false;
  const renderer = new NativeAudioPortRenderer({
    ...f.rendererOptions, port: port2, protocol,
    info: { version: 1, sessionId: 'never-started', portId: 'inactive-port', output: config(1) },
    onError: error => f.errors.push(error), onRetired: () => { retired = true; },
  });
  assert.deepEqual(await renderer.stop(), { epoch: 1, stopped: true });
  renderer.retire();
  assert.equal(retired, true);
  assert.equal(f.contextCount(), 0);
});

test('composed global owner stays inert and establishes exact selected output through its real port handshake', async t => {
  const f = fixture(t, { withOwner: true });
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.getStats().state, 'idle');
  assert.equal(f.main.getStats().current, null);
  assert.deepEqual(await f.owner.start('chosen-output'), config(1));
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(f.owner.getStats().nativeConfigured, true);
  assert.equal(f.owner.getStats().calibrationId, 1);
  assert.equal(f.main.getStats().current.ready, true);
  assert.equal(f.contexts[0].sinkId, 'chosen-output');
  assert.deepEqual(f.errors, []);
});

test('composed global owner accounts actual port credits, PCM and calibrated feedback without a pacing loop', async t => {
  const f = fixture(t, { withOwner: true, physicalTime: .998 });
  await f.owner.start('chosen-output');
  f.grant();
  await until(() => f.credits.length === 1);
  for (let sequence = 0; sequence < 2; sequence++) {
    assert.equal(f.owner.handleNativeEvent({ type: 'audio.playout', target: 0, data: pcm(1, sequence) }), true);
  }
  await until(() => f.nodes[0].posted.filter(value => value.type === 'pcm').length === 2);
  f.emit({ type: 'feedback', epoch: 1, clockEpoch: 1, state: 'running',
    contextFrame: 48000, frames: 128, firstPlayoutFrame: 0, mediaFrames: 128, queuedFrames: 832 });
  await until(() => f.feedback.length === 1);
  assert.equal(f.feedback[0].available, true);
  assert.ok(f.feedback[0].estimatedPlayoutFrame < 0);
  assert.equal(f.feedback[0].confirmedPcmEnd, 960);
  assert.equal(f.owner.getStats().nextPlayoutFrame, 960);
  assert.equal(f.owner.getStats().outstandingCreditFrames, 0);
  assert.equal(f.owner.getStats().pendingEnqueues, 0);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.errors, []);
});

test('composed global stop retires native output and real Renderer context without closing the shared engine', async t => {
  const f = fixture(t, { withOwner: true });
  await f.owner.start('chosen-output');
  await f.owner.stop(1);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.owner.getStats().nativeRetired, true);
  assert.equal(f.owner.getStats().rendererRetired, true);
  assert.equal(f.main.getStats().retiredThrough, 1);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.calls.filter(value => value === 'native-stop:1').length, 1);
  assert.equal(f.calls.includes('native-engine-close'), false);
  assert.equal(await f.owner.stop(1), false);
});

test('native invalidation withdraws readiness synchronously but still waits for actual Renderer closure', async t => {
  const closeGate = deferred(), f = fixture(t, { withOwner: true, closeGate });
  await f.owner.start('chosen-output');
  assert.equal(f.owner.handleNativeEvent(invalidated(1)), true);
  assert.equal(f.owner.getStats().ready, false);
  await until(() => f.calls.includes('context-close'));
  assert.equal(f.contexts[0].state, 'running');
  assert.equal(f.owner.getStats().rendererRetired, false);
  assert.equal(f.owner.getStats().stopped, false);
  await assert.rejects(f.owner.start('replacement-output'), /still owns/);
  closeGate.resolve();
  await f.owner.stop(1);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.calls.includes('native-engine-close'), false);
  await f.owner.start('replacement-output');
  f.owner.handleNativeEvent(invalidated(1));
  f.owner.handleNativeEvent(invalidated(1, 'owner-stop'));
  await delay(5);
  assert.equal(f.owner.getStats().activeEpoch, 2);
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(f.contexts[1].state, 'running');
  assert.equal(f.calls.includes('native-stop:2'), false);
});

test('invalidation during native configuration cannot erase its late configure obligation or open a replacement', async t => {
  const configureGate = deferred(), f = fixture(t, { withOwner: true, configureGate });
  const starting = f.owner.start('chosen-output');
  const rejected = assert.rejects(starting);
  await until(() => f.calls.includes('configure'));
  assert.equal(f.owner.handleNativeEvent(invalidated(1, 'setup-failed')), true);
  assert.equal(f.owner.getStats().ready, false);
  await until(() => f.contexts[0].state === 'closed');
  assert.equal(f.owner.getStats().nativeConfigurationPending, true);
  assert.equal(f.owner.getStats().nativeRetired, false);
  await assert.rejects(f.owner.start('replacement-output'), /still owns/);
  configureGate.resolve();
  await rejected;
  await f.owner.stop(1);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.calls.filter(value => value === 'native-stop:1').length, 1);
  assert.equal(f.calls.includes('worklet'), false);
  assert.equal(f.calls.includes('native-engine-close'), false);
});

test('an expected owner-stop invalidation can arrive synchronously before its native command acknowledgement', async t => {
  let f;
  f = fixture(t, { withOwner: true, nativeStop(data) {
    f.calls.push('native-invalidation');
    assert.equal(f.owner.handleNativeEvent(invalidated(data.epoch, 'owner-stop')), true);
    assert.equal(f.owner.getStats().ready, false);
    f.calls.push('native-stop-ack');
    return Promise.resolve({});
  } });
  await f.owner.start('chosen-output');
  await f.owner.stop(1);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.calls.filter(value => value === 'native-stop:1').length, 1);
  assert.ok(f.calls.indexOf('native-invalidation') < f.calls.indexOf('native-stop-ack'));
  assert.deepEqual(f.errors, []);
});

test('the genuine native output error remains visible after its preceding retirement notification', async t => {
  const closeGate = deferred(), f = fixture(t, { withOwner: true, closeGate });
  await f.owner.start('chosen-output');
  assert.equal(f.owner.handleNativeEvent(invalidated(1, 'mixer-failure')), true);
  const message = 'Audio output epoch failed; select/recreate a new output epoch';
  assert.equal(f.owner.handleNativeEvent({ type: 'audio.outputError', target: 0, data: {
    epoch: 1, code: 'ERR_RTC_AUDIO_OUTPUT', message, status: 7, hresult: 0, terminal: false,
  } }), true);
  assert.ok(f.errors.some(error => error.message === message));
  assert.equal(f.owner.getStats().ready, false);
  closeGate.resolve();
  await f.owner.stop(1);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.calls.includes('native-engine-close'), false);
});

test('composed startup cancellation closes Renderer while retaining a late native configure for exact cleanup', async t => {
  const configureGate = deferred(), f = fixture(t, { withOwner: true, configureGate });
  const abort = new AbortController();
  const starting = f.owner.start('chosen-output', abort.signal);
  const rejected = assert.rejects(starting);
  await until(() => f.calls.includes('configure'));
  abort.abort();
  await until(() => f.contexts[0].state === 'closed');
  assert.equal(f.owner.getStats().nativeConfigurationPending, true);
  assert.equal(f.owner.getStats().nativeRetired, false);
  await assert.rejects(f.owner.start('replacement'), /still owns/);
  configureGate.resolve();
  await rejected;
  await f.owner.stop(1);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.calls.filter(value => value === 'native-stop:1').length, 1);
  assert.equal(f.calls.includes('worklet'), false);
});

test('Renderer failure after readiness stops that global audio epoch and leaves the engine available for video', async t => {
  const f = fixture(t, { withOwner: true });
  await f.owner.start('chosen-output');
  f.nodes[0].onprocessorerror();
  await until(() => f.owner.getStats().stopped);
  assert.equal(f.contexts[0].state, 'closed');
  assert.ok(f.errors.some(error => /AudioWorklet processing failed/.test(error.message)));
  assert.ok(f.errorContexts.some(context => context?.epoch === 1 && context.phase === 'renderer'));
  assert.equal(f.calls.includes('native-stop:1'), true);
  assert.equal(f.calls.includes('native-engine-close'), false);
});

test('a late driver failure cannot stop the replacement global output epoch', async t => {
  const f = fixture(t, { withOwner: true });
  await f.owner.start('chosen-output');
  const original = f.main.current;
  await f.owner.stop(1);
  await f.owner.start('replacement-output');
  f.main.report(original, new Error('Late original Renderer failure.'));
  await delay(5);
  assert.equal(f.owner.getStats().activeEpoch, 2);
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(f.contexts[1].state, 'running');
  assert.equal(f.calls.includes('native-stop:2'), false);
  assert.ok(f.errorContexts.some(context => context?.phase === 'renderer' && context.epoch === 1));
});

test('a broken Root error observer cannot prevent global audio teardown after a Renderer failure', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...values) => logged.push(values));
  const f = fixture(t, { withOwner: true, onError() { throw new Error('Root observer failed.'); } });
  await f.owner.start('chosen-output');
  f.nodes[0].onprocessorerror();
  await until(() => f.owner.getStats().stopped);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.calls.includes('native-stop:1'), true);
  assert.ok(logged.some(values => String(values[0]).includes('Root error observer')));
});

test('composed full-engine proof cannot substitute for a pending Renderer context retirement', async t => {
  const closeGate = deferred(), f = fixture(t, { withOwner: true, closeGate, timeoutMs: 35 });
  await f.owner.start('chosen-output');
  await assert.rejects(f.owner.finishAfterEngineClose(f.commands.closeEngine()));
  assert.equal(f.owner.getStats().engineClosed, true);
  assert.equal(f.owner.getStats().nativeRetired, true);
  assert.equal(f.owner.getStats().rendererRetired, false);
  assert.equal(f.owner.getStats().stopped, false);
  closeGate.resolve();
  await until(() => f.contexts[0].state === 'closed');
  await f.owner.stop(1);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.calls.includes('native-stop:1'), false);
});

test('unsolicited local disposal retires the global native output through the scoped Root error path', async t => {
  const f = fixture(t, { withOwner: true });
  await f.owner.start('chosen-output');
  await f.receiver.dispose();
  await until(() => f.owner.getStats().stopped);
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.main.getStats().last.retirement, 'renderer-context-disposed');
  assert.equal(f.calls.includes('native-stop:1'), true);
  assert.equal(f.calls.includes('native-engine-close'), false);
});

test('composed invalid sink validation happens before consuming any native or Renderer epoch', async t => {
  const f = fixture(t, { withOwner: true });
  await assert.rejects(f.owner.start('\0'));
  assert.equal(f.owner.getStats().lastEpoch, 0);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.main.getStats().lastEpoch, 0);
  assert.equal(f.channels.length, 0);
  assert.equal(f.contextCount(), 0);
  assert.deepEqual(await f.owner.start('chosen-output'), config(1));
});

for (const kind of ['replaced-frame', 'foreign-document']) {
  test(`composed rejected ${kind} proves empty Renderer retirement before any transfer`, async t => {
    const f = fixture(t, { withOwner: true });
    const originalUrl = f.frame.url;
    if (kind === 'replaced-frame') f.contents.mainFrame = { ...f.frame };
    else f.frame.url = 'https://foreign.example/';
    await assert.rejects(f.owner.start('chosen-output'));
    assert.equal(f.owner.getStats().stopped, true);
    assert.equal(f.owner.getStats().nativeRetired, true);
    assert.equal(f.owner.getStats().rendererRetired, true);
    assert.equal(f.main.getStats().current, null);
    assert.equal(f.main.getStats().retiredThrough, 1);
    assert.equal(f.main.getStats().last.retirement, 'not-transferred');
    assert.equal(f.channels.length, 0);
    assert.equal(f.contextCount(), 0);
    assert.equal(f.contents.eventNames().length, 0);
    assert.deepEqual(f.calls, []);
    f.contents.mainFrame = f.frame;
    f.frame.url = originalUrl;
    assert.deepEqual(await f.owner.start('chosen-output'), config(2));
  });
}

test('ambiguous transfer failure retains global Renderer ownership despite absent modeled resources', async t => {
  const f = fixture(t, { withOwner: true, timeoutMs: 35,
    transferFailure: new Error('Transfer outcome is unknown.') });
  await assert.rejects(f.owner.start('chosen-output'));
  assert.equal(f.owner.getStats().stopped, false);
  assert.equal(f.owner.getStats().rendererRetired, false);
  assert.equal(f.owner.getStats().nativeRetired, true);
  assert.equal(f.main.current.transferAttempted, true);
  assert.equal(f.main.getStats().retiredThrough, 0);
  assert.equal(f.contextCount(), 0);
  await assert.rejects(f.owner.stop(1));
  assert.equal(f.owner.getStats().stopped, false);
  f.destroy();
  await f.owner.stop(1);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.main.getStats().last.retirement, 'web-contents-destroyed');
  assert.equal(f.calls.includes('native-engine-close'), false);
});
