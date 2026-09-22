'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { CaptureBridge } = require('../runtime/captureBridge.cjs');
const { NativeScreenEndpoint, assertNativeScreenEndpointLocallyClosed } = require('../runtime/nativeEndpoint.cjs');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');

function fixture({ incomplete = false, role = 'receive', mode = 'p2p', audio = false,
  target = { hwnd: 12345, expectedProcessId: 56789 }, captureEncoder = 'auto', captureModule, preserveAspectRatio,
  captureRuntime = {}, captureDirectory = path.resolve(__dirname, 'modeled-capture') } = {}) {
  let finish, closeCalls = 0;
  const errors = [], requests = [], states = [], diagnostics = [];
  const closing = new Promise(resolve => { finish = resolve; });
  const engine = {
    ready: Promise.resolve(),
    request: async (_id, operation) => {
      requests.push(operation);
      if (role === 'publish' && operation === 'source.createEncodedVideo') return { sourceId: 1 };
      assert.fail(`An unwatched endpoint cannot allocate transport resources: ${operation}`);
    },
    submitEncodedFrame() { assert.fail('A local-only preview cannot submit network media.'); },
    cancel() {}, submitFrame() {}, releaseFrame() {},
    respond() { assert.fail('An unwatched endpoint cannot acknowledge transport creation.'); },
    close() { closeCalls++; return closing; },
  };
  for (const method of ['grantAudioCredits', 'audioClockProbe', 'calibrateAudioClock', 'setAudioOutputFeedback'])
    engine[method] = () => assert.fail(`An unwatched preview cannot open audio output: ${method}`);
  if (incomplete) delete engine.submitFrame;
  const frame = { isDestroyed: () => false, postMessage() {}, url: 'file:///C:/modeled/index.html' };
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: frame });
  const endpoint = new NativeScreenEndpoint({
    runtime: { ...captureRuntime, rtc: { createEngine: () => engine } }, textures: { importSharedTexture() {}, sendSharedTexture() {} },
    role, mode, sessionId: role === 'publish' ? 'publisher' : 'viewer', publisherSessionId: 'publisher', channelId: 'channel',
    pipelineId: randomUUID(), source: { shareId: 'screen', instanceId: randomUUID(), audio,
      video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } },
    quality: 'source', destination: { frame, presentationId: randomUUID() },
    target, captureEncoder, preserveAspectRatio, captureDirectory,
    ...(audio ? { audio: { sinkId: '', muted: true, volume: 0, maxBitrateBps: 128000,
      captureModule: captureModule ?? { createPacketCapture() { assert.fail('Preview-only demand cannot capture PCM.'); } },
      output: { webContents, frame, expectedUrl: frame.url,
        createMessageChannel() { assert.fail('An unwatched preview cannot create an audio-output port.'); } },
    } } : {}),
    rpc: async () => assert.fail('An unwatched preview cannot allocate SFU resources.'),
    send: async () => {}, onError: error => errors.push(error),
    onState: state => states.push(state), onDiagnostic: error => diagnostics.push(error),
  });
  return { endpoint, engine, errors, requests, states, diagnostics, finish, closeCalls: () => closeCalls };
}

const captureFailure = (code = 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE') => Object.assign(new Error(code), { code });

async function captureFixture(t, { failures = [captureFailure()], packetBeforeFailure = false, retirementGate,
  retirementFails = false, expectCloseFailure = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'monky-game-fallback-')));
  const hosts = [], bitrates = [];
  let allowRetirement = !retirementFails;
  const f = fixture({
    role: 'publish', target: targets[1], captureEncoder: 'h264_texture_amf', preserveAspectRatio: true,
    captureDirectory: directory,
    captureRuntime: {
      host: { kind: 'verified-native-screen-capture-host', executable: path.join(directory, 'modeled-host.exe'), sha256: 'a'.repeat(64) },
      obs: { kind: 'verified-stock-obs-runtime', version: '32.1.1', binaryDirectory: directory, stockDirectory: directory },
    },
  });
  t.mock.method(CaptureBridge.prototype, 'prepare', async function(target, signal) {
    signal.throwIfAborted();
    this.source = target;
    this.modeledDirectory = f.endpoint.runDirectory;
    this.modeledArguments = this.argumentsForSource(target, this.runId);
    if (hosts.length) {
      assert.equal(hosts.at(-1).nativeClosed, true);
      await assert.rejects(fs.stat(hosts.at(-1).modeledDirectory), { code: 'ENOENT' });
    }
    hosts.push(this);
  });
  t.mock.method(CaptureBridge.prototype, 'start', async function() {
    assert.equal(f.endpoint.flow.host, undefined, 'Neither startup attempt may receive live feedback before its first AU.');
    const failure = failures[hosts.length - 1];
    if (!failure || packetBeforeFailure) {
      this.liveFrames.packets++;
      this.onPacket({ frameId: 1, data: Buffer.from([1]), timestampUs: 1000, keyframe: true });
    }
    if (failure) throw this.fail(failure);
    this.ready = true;
  });
  t.mock.method(CaptureBridge.prototype, 'stop', async function() {
    if (retirementGate && this === hosts[0]) {
      retirementGate.enter();
      await retirementGate.promise;
    }
    if (!allowRetirement) throw captureFailure('ERR_SCREEN_CAPTURE_RETIREMENT');
    this.nativeClosed = true;
    this.closed = true;
    if (this.firstError) throw this.firstError;
  });
  t.mock.method(CaptureBridge.prototype, 'setBitrate', async function(bitrateKbps) {
    assert.equal(this.ready, true);
    bitrates.push({ host: this, bitrateKbps });
    return { bitrateKbps, settingsAccepted: true, hardwareApplicationConfirmed: false };
  });
  t.after(async () => {
    allowRetirement = true;
    retirementGate?.resolve();
    const closing = f.endpoint.close();
    f.finish({ closed: true });
    if (expectCloseFailure) await assert.rejects(closing, AggregateError);
    else await closing;
    assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
    await fs.rm(directory, { recursive: true });
  });
  await f.endpoint.ready;
  return { ...f, hosts, bitrates, allowRetirement: () => { allowRetirement = true; },
    start: async () => { await f.endpoint.setDemand(0, true); return f.endpoint.captureWork; } };
}

const targets = [
  { kind: 'window', hwnd: 12345, expectedProcessId: 56789, expectedProcessCreationTime100ns: '123456789' },
  { kind: 'game', hwnd: 12345, expectedProcessId: 56789, expectedProcessCreationTime100ns: '123456789' },
  { kind: 'monitor', deviceId: String.raw`\\?\DISPLAY#SELECTED#ONE`, deviceName: String.raw`\\.\DISPLAY2`,
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
];

test('capture fixtures canonicalize inherited temporary-directory aliases', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'monky-game-temp-alias-')));
  t.after(() => fs.rm(root, { recursive: true }));
  const actual = path.join(root, 'actual'), alias = path.join(root, 'alias');
  await fs.mkdir(actual);
  await fs.symlink(actual, alias, 'junction');
  await t.test('fallback and retirement use the owned physical directory', async child => {
    child.mock.method(os, 'tmpdir', () => alias);
    const f = await captureFixture(child);
    assert.equal(f.endpoint.captureDirectory, await fs.realpath(f.endpoint.captureDirectory));
    await f.start();
    assert.deepEqual(f.hosts.map(host => host.source.kind), ['game', 'window']);
    assert.equal(f.states.filter(state => state.type === 'capture-fallback').length, 1);
    assert.deepEqual(f.errors, []);
  });
});

test('rejected Game Capture retires before one same-window Normal retry without replacing the engine or profile', async t => {
  const f = await captureFixture(t);
  f.endpoint.flow.feedback({ target: 1, data: { sourceId: 1, sequence: 1, kind: 'rate', bitrateBps: 3000000,
    requestedFps: 0, paused: false, fpsApplied: null, keyframeConfirmed: false, bitrateCeilingBps: 20000000 } });
  await f.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.hosts.map(host => host.source), [targets[1], { ...targets[1], kind: 'window' }]);
  assert.ok(f.hosts.every(host => host.modeledArguments.includes('--scale-mode=fit')
    && host.modeledArguments.includes('--fps=120') && host.modeledArguments.includes('--width=1920')));
  assert.equal(f.hosts[0].nativeClosed, true);
  assert.notEqual(f.hosts[0].runId, f.hosts[1].runId);
  assert.equal(f.endpoint.flow.host, f.hosts[1]);
  assert.equal(f.bitrates.length, 1);
  assert.equal(f.bitrates[0].host, f.hosts[1]);
  assert.equal(f.bitrates[0].bitrateKbps, 2700);
  assert.deepEqual(f.requests, ['source.createEncodedVideo']);
  assert.equal(f.closeCalls(), 0);
  assert.equal(f.endpoint.snapshot().captureMode, 'normal');
  assert.equal(f.endpoint.snapshot().captureState, 'running');
  assert.deepEqual(f.states.filter(state => state.type === 'capture-mode').map(state => state.capture), [
    { mode: 'game', ready: false }, { mode: 'normal', ready: false }, { mode: 'normal', ready: true },
  ]);
  assert.equal(f.states.filter(state => state.type === 'capture-fallback').length, 1);
  assert.equal(f.diagnostics.length, 1);
  assert.deepEqual(f.errors, []);
});

test('successful Game Capture stays Game and never emits a fallback', async t => {
  const f = await captureFixture(t, { failures: [] });
  await f.start();
  assert.equal(f.hosts.length, 1);
  assert.equal(f.endpoint.snapshot().captureMode, 'game');
  assert.equal(f.states.some(state => state.type === 'capture-fallback'), false);
  assert.deepEqual(f.errors, []);
});

test('Normal retry failure is terminal and cannot recurse or hide behind the Game diagnostic', async t => {
  const normalFailure = captureFailure('ERR_SCREEN_CAPTURE_SOURCE');
  const f = await captureFixture(t, { failures: [captureFailure(), normalFailure], expectCloseFailure: true });
  await assert.rejects(f.start(), normalFailure);
  assert.equal(f.hosts.length, 2);
  assert.deepEqual(f.errors, [normalFailure]);
  assert.equal(f.endpoint.snapshot().captureMode, null);
});

for (const code of ['ERR_SCREEN_CAPTURE_SOURCE_LOST', 'ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION']) {
  test(`${code}: source loss and encoder failures do not authorize another capture method`, async t => {
    const error = captureFailure(code);
    const f = await captureFixture(t, { failures: [error], expectCloseFailure: true });
    await assert.rejects(f.start(), error);
    assert.equal(f.hosts.length, 1);
    assert.equal(f.states.some(state => state.type === 'capture-fallback'), false);
  });
}

test('a Game Capture that already emitted a frame cannot reset the encoded timeline by retrying in place', async t => {
  const error = captureFailure();
  const f = await captureFixture(t, { failures: [error], packetBeforeFailure: true, expectCloseFailure: true });
  await assert.rejects(f.start(), error);
  assert.equal(f.hosts.length, 1);
  assert.equal(f.endpoint.snapshot().captureMode, 'game');
  assert.equal(f.states.some(state => state.type === 'capture-fallback'), false);
});

test('unproved capture retirement prevents fallback even when the original Game failure is recoverable', async t => {
  const f = await captureFixture(t, { retirementFails: true });
  await assert.rejects(f.start(), { code: 'ERR_SCREEN_CAPTURE_RETIREMENT' });
  assert.equal(f.hosts.length, 1);
  assert.equal(f.states.some(state => state.type === 'capture-fallback'), false);
  f.allowRetirement();
});

test('Stop during failed-Game retirement cancels fallback without a late Normal process or toast', async t => {
  let resolve, enter;
  const gate = { promise: new Promise(yes => { resolve = yes; }), resolve: () => resolve(),
    entered: new Promise(yes => { enter = yes; }), enter: () => enter() };
  const f = await captureFixture(t, { retirementGate: gate });
  const starting = assert.rejects(f.start(), { name: 'AbortError' });
  await gate.entered;
  const closing = f.endpoint.close();
  gate.resolve();
  f.finish({ closed: true });
  await Promise.all([starting, closing]);
  assert.equal(f.hosts.length, 1);
  assert.equal(f.states.some(state => state.type === 'capture-fallback'), false);
  assert.deepEqual(f.errors, []);
});

test('fallback revalidates the exact selected window after retirement before starting Normal', async t => {
  const f = await captureFixture(t);
  f.endpoint.assertSourceCurrent = () => {
    if (f.hosts[0]?.nativeClosed) throw captureFailure('ERR_SCREEN_CAPTURE_SOURCE_LOST');
  };
  await assert.rejects(f.start(), { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
  assert.equal(f.hosts.length, 1);
  assert.equal(f.states.some(state => state.type === 'capture-fallback'), false);
});

for (const selected of targets) {
  test(`${selected.kind}: endpoint retains immutable exact target/encoder and preview never starts requested audio`, async t => {
    const target = structuredClone(selected);
    const f = fixture({ role: 'publish', target, captureEncoder: 'obs_nvenc_h264_tex', audio: true, preserveAspectRatio: true });
    t.after(async () => {
      const closing = f.endpoint.close(); f.finish({ closed: true }); await closing;
      assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
    });
    t.mock.method(f.endpoint, 'startCapture', async () => {});
    await f.endpoint.ready;
    if (target.kind === 'monitor') target.bounds.x = 1;
    else target.expectedProcessCreationTime100ns = '999';
    assert.deepEqual(f.endpoint.target, selected);
    assert.equal(Object.isFrozen(f.endpoint.target), true);
    if (selected.kind === 'monitor') assert.equal(Object.isFrozen(f.endpoint.target.bounds), true);
    assert.equal(f.endpoint.captureEncoder, 'obs_nvenc_h264_tex');
    assert.equal(f.endpoint.preserveAspectRatio, true);
    await f.endpoint.setDemand(0, true);
    assert.equal(f.endpoint.pcm, undefined);
    assert.equal(f.endpoint.audioStartWork, undefined);
    assert.equal(f.endpoint.audioOutput.owner.getStats().starts, 0);
    assert.deepEqual(f.requests, ['source.createEncodedVideo']);
    assert.deepEqual(f.errors, []);
  });
}

test('endpoint rejects malformed explicit targets and unknown encoders before native engine allocation', () => {
  for (const target of [
    { kind: 'game', hwnd: 12345, expectedProcessId: 56789 },
    { ...targets[0], expectedProcessCreationTime100ns: '0' },
    { ...targets[2], bounds: { ...targets[2].bounds, width: 0 } },
  ]) assert.throws(() => fixture({ role: 'publish', target }));
  assert.throws(() => fixture({ role: 'publish', target: targets[0], captureEncoder: 'vendor-nvidia' }));
  for (const preserveAspectRatio of [null, 0, 'true', {}])
    assert.throws(() => fixture({ role: 'publish', preserveAspectRatio }));
});

for (const selected of targets) {
  test(`${selected.kind}: endpoint PCM selection uses selected process or system mix excluding Monky`, async () => {
    let closeCapture, closeSource = false;
    const closed = new Promise(resolve => { closeCapture = resolve; });
    const selections = [], publications = [], errors = [];
    const format = { encoding: 'float32-interleaved', sampleRate: 48000, channels: 2, channelMask: 3,
      sourceBitsPerSample: 32, sourceValidBitsPerSample: 32 };
    const engine = {
      async request(_id, operation) {
        if (operation === 'source.createAudio') return { sourceId: 11, kind: 'audio' };
        if (operation === 'resource.close') { closeSource = true; return {}; }
        assert.fail(`No synthetic epoch or PCM activation is permitted: ${operation}`);
      },
      submitAudioPacket() { assert.fail('This selection fixture has no physical PCM.'); },
      async close() { return { closed: true }; },
    };
    const endpoint = {
      engine, commands: new NativeRtcCommands(engine), target: selected,
      source: { shareId: 'selected', instanceId: randomUUID() }, abort: new AbortController(),
      report: error => errors.push(error),
      audio: { maxBitrateBps: 128000, captureModule: {
        createPacketCapture(selection, onEvent) {
          selections.push(selection);
          const snapshot = () => ({ sessionId: 'modeled-selection', state: closeSource ? 'closed' : 'capturing', format });
          queueMicrotask(() => onEvent({ type: 'ready', sessionId: 'modeled-selection', format }));
          return { ready: Promise.resolve(snapshot()), closed, getStats: snapshot,
            async stop() { onEvent({ type: 'closed', snapshot: snapshot() }); closeCapture(snapshot()); return closed; } };
        },
      } },
      transport: { async addAudioSource(value) { publications.push(value); return { sourceId: value.sourceId }; } },
    };
    await NativeScreenEndpoint.prototype.startAudioSource.call(endpoint);
    assert.deepEqual(selections, [selected.kind === 'monitor' ? { excludePid: process.pid }
      : { includeWindowId: selected.hwnd, expectedProcessId: selected.expectedProcessId }]);
    assert.equal(publications[0].syncGroup, endpoint.source.instanceId);
    assert.equal(endpoint.pcm.getStats().submitted, 0);
    assert.equal(endpoint.pcm.getStats().enabled, false);
    await endpoint.pcm.stop();
    assert.equal(closeSource, true);
    assert.deepEqual(errors, []);
  });
}

for (const mode of ['p2p', 'sfu']) {
  test(`${mode}: preview-only demand allocates no transport, publication or network frame`, async t => {
    const f = fixture({ role: 'publish', mode });
    assert.equal(f.endpoint.preserveAspectRatio, false);
    let captures = 0;
    t.mock.method(f.endpoint, 'startCapture', async () => { captures++; });
    await f.endpoint.ready;
    assert.equal(captures, 0);
    await f.endpoint.setDemand(0, true);
    assert.equal(captures, 1);
    assert.equal(f.endpoint.snapshot().demand, 0);
    assert.equal(f.endpoint.snapshot().previewDemand, true);
    assert.equal(f.endpoint.publication, undefined);
    assert.deepEqual(f.requests, ['source.createEncodedVideo']);
    f.endpoint.flow.packet({ frameId: 1, keyframe: true });
    assert.equal(f.endpoint.flow.snapshot().admitted, 0);
    assert.equal(f.endpoint.flow.snapshot().notWatched, 1);
    const closing = f.endpoint.setDemand(0, false);
    f.finish({ closed: true });
    await closing;
    assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
    assert.deepEqual(f.errors, []);
  });
}

test('SFU capture remains connected when ICE completes and stops admission on genuine disconnection', async t => {
  const f = fixture({ role: 'publish', mode: 'sfu' });
  t.mock.method(f.endpoint, 'startCapture', async () => {});
  await f.endpoint.ready;
  f.endpoint.broker.transports.set('send', { nativeId: 7 });
  f.endpoint.demand = 1;
  f.endpoint.sfuPublicationRequested = true;
  t.after(async () => {
    f.endpoint.broker.transports.delete('send');
    const closing = f.endpoint.close();
    f.finish({ closed: true });
    await closing;
    assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
  });
  for (const state of ['new', 'connecting', 'connected', 'completed', 'disconnected', 'connected', 'failed', 'closed']) {
    await f.endpoint.dispatch({ type: 'sfu.state', target: 7, data: { state } });
    assert.equal(f.endpoint.flow.snapshot().connected, state === 'connected' || state === 'completed', state);
  }
  await f.endpoint.dispatch({ type: 'sfu.state', target: 8, data: { state: 'completed' } });
  assert.equal(f.endpoint.connected(), false, 'A different transport cannot authorize capture admission.');
  assert.deepEqual(f.errors, []);
});

test('public snapshots and a borrowed closed engine cannot forge local endpoint retirement', async () => {
  const engine = { request: async () => ({}), close: async () => ({ closed: true }) };
  const commands = new NativeRtcCommands(engine);
  await commands.closeEngine();
  assert.throws(() => assertNativeScreenEndpointLocallyClosed({
    engine, commands, closed: true, nativeClosed: true, snapshot: () => ({ closed: true, nativeClosed: true }),
  }), /original native screen endpoint/);
});

test('local retirement waits for its own native close and ignores writable success-shaped fields', async () => {
  const f = fixture();
  await f.endpoint.ready;
  f.endpoint.nativeClosed = true;
  f.endpoint.closed = true;
  assert.throws(() => assertNativeScreenEndpointLocallyClosed(f.endpoint), /retains local media/);
  const closing = f.endpoint.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closeCalls(), 1);
  assert.throws(() => assertNativeScreenEndpointLocallyClosed(f.endpoint), /retains local media/);
  f.finish({ closed: true });
  await closing;
  assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
  assert.deepEqual(f.errors, []);
});

test('composition failure after native allocation returns a failed owner with a genuine cleanup path', async () => {
  const f = fixture({ incomplete: true });
  await assert.rejects(f.endpoint.ready, /Native presentation requires/);
  const closing = f.endpoint.close();
  f.finish({ closed: true });
  await closing;
  assert.equal(f.closeCalls(), 1);
  assert.equal(f.errors.length, 1);
  assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
});
