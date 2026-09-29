'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { within } = require('../runtime/nativeDeadline.cjs');
const directory = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice('--mode='.length) ?? 'p2p';
const sfuListenIp = process.argv.find(value => value.startsWith('--sfu-listen-ip='))?.slice('--sfu-listen-ip='.length);
const soakMs = Number(process.argv.find(value => value.startsWith('--soak-ms='))?.slice('--soak-ms='.length) ?? 0);
const singleReceiverSoakMs = Number(process.argv.find(value => value.startsWith('--single-receiver-soak-ms='))?.slice('--single-receiver-soak-ms='.length) ?? 0);
const requireAudioContinuity = process.argv.includes('--require-audio-continuity');
const mainStallMs = Number(process.argv.find(value => value.startsWith('--main-stall-ms='))?.slice('--main-stall-ms='.length) ?? 0);
const encoder = process.argv.find(value => value.startsWith('--encoder='))?.slice('--encoder='.length) ?? 'auto';
assert.ok(['auto', 'h264_texture_amf', 'obs_nvenc_h264_tex', 'av1_texture_amf', 'obs_nvenc_av1_tex'].includes(encoder));
const codec = encoder.includes('av1') ? 'av1' : 'h264';
const selectedProfile = process.argv.find(value => value.startsWith('--profile='))?.slice('--profile='.length) ?? '1080p120';
assert.ok(['1080p120', '720p30'].includes(selectedProfile));
const silentSource = process.argv.includes('--silent-source');
const audioAddon = process.argv.find(value => value.startsWith('--audio-addon='))?.slice('--audio-addon='.length);
assert.ok(!audioAddon || (path.isAbsolute(audioAddon) && path.extname(audioAddon) === '.node'));
const simulateDisconnect = process.argv.includes('--disconnect');
const simulateRtcFault = process.argv.includes('--rtc-fault');
assert.ok(directory && path.isAbsolute(directory) && ['p2p', 'sfu'].includes(mode));
assert.ok(sfuListenIp === undefined || (mode === 'sfu' && require('node:net').isIPv4(sfuListenIp)),
  'An explicit local SFU address requires SFU mode and an IPv4 address.');
assert.ok(Number.isSafeInteger(soakMs) && soakMs >= 0 && soakMs <= 1200000);
assert.ok(Number.isSafeInteger(singleReceiverSoakMs) && singleReceiverSoakMs >= 0 && singleReceiverSoakMs <= 1200000);
assert.ok(!singleReceiverSoakMs || (!soakMs && !mainStallMs && !simulateDisconnect && !simulateRtcFault && !silentSource),
  'Single-receiver audio continuity requires its real synthetic tone without competing lifecycle scenarios.');
assert.ok(!requireAudioContinuity || singleReceiverSoakMs >= 30000,
  'Strict audio continuity needs at least 30 seconds of the single-receiver scenario.');
assert.ok(Number.isSafeInteger(mainStallMs) && mainStallMs >= 0 && mainStallMs <= 3000);
assert.ok(!simulateDisconnect || mode === 'sfu');
assert.ok(!simulateRtcFault || !simulateDisconnect);
assert.ok(!mainStallMs || (!simulateDisconnect && !simulateRtcFault));

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const sourceProfile = `${directory}-source`;
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(sourceProfile), false);
  const source = spawn(require('electron'), [path.join(__dirname, 'nativeAvSource.cjs'), `--profile=${sourceProfile}`],
    { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let test, sourceRetiring = false;
  const sourceExited = new Promise(resolve => source.once('exit', code => {
    if (!sourceRetiring) { console.error(`Owned source exited unexpectedly (${code}).`); test?.kill('SIGKILL'); process.exitCode = 1; }
    resolve();
  }));
  const deadline = setTimeout(() => {
    console.error('Owned native A/V smoke exceeded its deadline.');
    process.exitCode = 1; sourceRetiring = true;
    test?.kill('SIGKILL'); source.kill('SIGKILL');
  }, 180000 + soakMs + singleReceiverSoakMs);
  const run = async () => {
    const ready = await within(new Promise((resolve, reject) => {
      source.once('error', reject);
      source.once('message', resolve);
    }), 20000, 'The isolated synthetic source did not open its window.');
    assert.equal(ready.type, 'ready'); assert.equal(ready.pid, source.pid);
    assert.ok(Number.isSafeInteger(ready.hwnd) && ready.hwnd > 0);
    // Capture and source must be siblings: INCLUDE rejects the capturer's own process tree.
    test = spawn(require('electron'), [__filename, ...process.argv.slice(2),
      `--source-hwnd=${ready.hwnd}`, `--source-pid=${ready.pid}`],
    { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    test.on('message', value => { if (value?.type === 'source-command' && source.connected) source.send(value); });
    source.on('message', value => { if (value?.type === 'result' && test.connected) test.send(value); });
    const code = await new Promise((resolve, reject) => { test.once('exit', resolve); test.once('error', reject); });
    assert.equal(code, 0, 'Native A/V smoke failed.');
  };
  void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    sourceRetiring = true;
    if (source.connected) source.disconnect();
    await within(sourceExited, 10000, 'The owned source did not retire.').catch(error => {
      console.error(error); process.exitCode = 1; source.kill('SIGKILL');
    });
    clearTimeout(deadline);
  });
  return;
}

const { app, BrowserWindow, screen, sharedTexture, MessageChannelMain } = require('electron');
const { getScreenShareProfile } = require('@monky/shared');
let placement;
try {
  placement = require('../../../test/fixtures/testDisplay.cjs').installTestDisplay({ app, screen, BrowserWindow });
}
catch (error) { console.error('[TestDisplay] A/V launch rejected:', error); app.exit(1); return; }
const { loadRuntime, NativeScreenEndpoint, NativeScreenPublisher, NativeScreenSubscription, NativePcmCaptureHub } = require('../index.cjs');
const captureModule = audioAddon ? require(audioAddon) : require('@monky/screen-audio');
const { createSfuFixture } = require('./sfuFixture.cjs');
const { assertNativeScreenEndpointLocallyClosed } = require('../runtime/nativeEndpoint.cjs');
const target = {
  hwnd: Number(process.argv.find(value => value.startsWith('--source-hwnd='))?.slice('--source-hwnd='.length)),
  expectedProcessId: Number(process.argv.find(value => value.startsWith('--source-pid='))?.slice('--source-pid='.length)),
};
assert.ok(Number.isSafeInteger(target.hwnd) && target.hwnd > 0
  && Number.isSafeInteger(target.expectedProcessId) && target.expectedProcessId > 0 && target.expectedProcessId !== process.pid);
assert.equal(fs.existsSync(directory), false);
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.setName('MonkyNativeAvSmoke');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
const errors = [], windows = new Map(), subscriptions = new Map(), receivers = new Map(), senders = [], deliveries = new Set();
const report = { mode, encoder, codec, selectedProfile, silentSource, audioAddon: audioAddon ?? null,
  personalCapture: false, recordedMedia: false, phases: [] };
const eventLoopDelay = require('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let publisher, hub, sfu, expectingSourceLoss = false;
// Destruction may invalidate the stock finder before the next HWND liveness check.
// Both refusals are expected only for an acknowledged, explicitly destroyed source.
const sourceLossCodes = new Set(['ERR_SCREEN_CAPTURE_SOURCE_LOST', 'ERR_SCREEN_CAPTURE_SOURCE_AMBIGUOUS']);
const expectedSourceLoss = error => sourceLossCodes.has(error.code) || error.name === 'AbortError'
  || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(expectedSourceLoss));
const fatal = error => {
  report.firstMediaFailure ??= {
    phase: report.phases.at(-1), code: error.code, message: error.message,
    eventLoopMaxMs: eventLoopDelay.max / 1e6,
    audio: hub?.getStats(), publishers: senders.map(endpoint => ({
      flow: endpoint.flow?.snapshot(), pcm: endpoint.pcm?.getStats(),
    })),
  };
  errors.push(error); console.error(error);
};
const failure = error => {
  if (report.expectingRtcFault) {
    (report.expectedRtcErrors ??= []).push({ code: error.code ?? null, message: error.message });
    return;
  }
  if (report.simulatedDisconnect) {
    (report.remoteCleanupErrors ??= []).push(error.stack ?? String(error));
    return;
  }
  if (expectingSourceLoss && expectedSourceLoss(error)) {
    (report.expectedSourceErrors ??= []).push(error.stack ?? String(error));
    return;
  }
  fatal(error);
};
const phase = value => {
  report.phases.push(value);
  fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Native A/V ${mode}: ${value}`);
};
const sourceRequests = new Map();
process.on('message', value => {
  if (value?.type !== 'result') return;
  const request = sourceRequests.get(value.id);
  if (!request) return;
  sourceRequests.delete(value.id);
  if (value.ok) request.resolve(value); else request.reject(new Error(value.error));
});
function sourceCommand(command) {
  const id = randomUUID();
  return within(new Promise((resolve, reject) => {
    sourceRequests.set(id, { resolve, reject });
    process.send({ type: 'source-command', id, command });
  }), 10000, 'The owned synthetic source did not acknowledge its command.').finally(() => sourceRequests.delete(id));
}
async function waitFor(predicate, description, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (errors.length) throw new AggregateError(errors, description);
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  throw new Error(description);
}
function deliver(work) {
  deliveries.add(work);
  void work.then(() => deliveries.delete(work), error => { deliveries.delete(work); failure(error); });
}
function observeFixtureFailures(endpoint) {
  if (mode !== 'sfu') return;
  const reportError = endpoint.broker.report.bind(endpoint.broker);
  endpoint.broker.report = error => {
    // Only this owned fixture records the original adapter error before privacy sanitization.
    const original = report.originalAdapterErrors ??= [];
    if (original.length < 16) original.push({ role: endpoint.role, message: error?.message, stack: error?.stack });
    reportError(error);
  };
}
function audioOptions(window, publish = false) {
  return {
    sinkId: '', muted: false, volume: 1,
    output: { webContents: window.webContents, frame: window.webContents.mainFrame,
      expectedUrl: window.webContents.getURL(), createMessageChannel: () => new MessageChannelMain() },
    ...(publish ? { captureModule, captureHub: hub, maxBitrateBps: 128000 } : {}),
  };
}
async function createWindow(id) {
  const options = { width: 640, height: 400, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
      additionalArguments: singleReceiverSoakMs ? ['--native-audio-continuity-diagnostics'] : [],
      preload: path.join(__dirname, 'nativeCaptureSmoke.preload.cjs') } };
  const window = placement ? placement.createWindow(options) : new BrowserWindow(options);
  windows.set(id, window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('render-process-gone', (_event, details) => failure(new Error(`Owned A/V Renderer exited: ${details.reason}`)));
  await window.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'));
  window.setTitle(`Monky owned AV ${id}`); window.showInactive();
  return window;
}
const sample = id => windows.get(id).webContents.executeJavaScript('nativeCaptureSmoke.sample()');
const receivedAudio = id => {
  const signal = receivers.get(id).audioOutput.owner.getStats().pcmSignal;
  return signal?.frames > 4800 && (silentSource ? signal.nonzeroFrames === 0 : signal.nonzeroFrames > 4800);
};
async function signalWindow(id, milliseconds = 700) {
  const endpoint = receivers.get(id);
  const before = endpoint.audioOutput.owner.getStats().pcmSignal;
  await delay(milliseconds);
  const after = endpoint.audioOutput.owner.getStats().pcmSignal;
  assert.ok(before && after && after.frames > before.frames, 'The real native mixer did not advance.');
  const frames = after.frames - before.frames;
  return { frames, nonzeroFrames: after.nonzeroFrames - before.nonzeroFrames,
    leftRms: Math.sqrt((after.leftSquareSum - before.leftSquareSum) / frames),
    rightRms: Math.sqrt((after.rightSquareSum - before.rightSquareSum) / frames) };
}
async function observeCapturedStereo(reportKey = 'originalCapture') {
  const original = { frames: 0, channels: null, format: null, crossProduct: 0 };
  const observer = hub.subscribe({ includeWindowId: target.hwnd, expectedProcessId: target.expectedProcessId }, event => {
    if (event.type !== 'packet') return;
    const channels = event.format.channels;
    original.format = event.format;
    original.channels ??= Array.from({ length: channels }, () => ({ squareSum: 0, peak: 0 }));
    for (let frame = 0; frame < event.frames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = event.pcm.readFloatLE((frame * channels + channel) * 4);
        const signal = original.channels[channel];
        signal.squareSum += sample * sample; signal.peak = Math.max(signal.peak, Math.abs(sample));
      }
      original.crossProduct += event.pcm.readFloatLE(frame * channels * 4) * event.pcm.readFloatLE((frame * channels + 1) * 4);
    }
    original.frames += event.frames;
  });
  try { await observer.ready; await delay(700); }
  finally { await observer.detach(); }
  assert.ok(original.frames > 4800 && original.channels.length >= 2);
  original.correlation = original.crossProduct / Math.sqrt(original.channels[0].squareSum * original.channels[1].squareSum);
  report[reportKey] = original;
  assert.ok(original.channels[0].squareSum > 0 && original.channels[1].squareSum > 0,
    'The owned source capture is silent; downstream volume cannot be measured.');
  assert.ok(original.correlation < -.9, 'The owned test source did not deliver anti-phase stereo before RTC.');
}
async function run() {
  phase('starting');
  const runtime = loadRuntime(), channelId = randomUUID();
  const source = { shareId: 'owned-av', instanceId: randomUUID(), audio: true, codec,
    video: selectedProfile === '720p30'
      ? { width: 1280, height: 720, fps: 30, maxBitrateKbps: 2000 }
      : { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  const lowerQuality = selectedProfile === '720p30' ? '480p30' : '720p60';
  const ownerWindow = await createWindow('publisher');
  const invalid = captureModule.createPacketCapture({
    includeWindowId: target.hwnd, expectedProcessId: process.pid,
  }, () => {});
  await assert.rejects(invalid.ready, { code: 'ERR_AUDIO_TARGET' });
  await invalid.closed;
  report.changedWindowOwnerRejected = true;
  hub = new NativePcmCaptureHub(captureModule,
    { includeWindowId: target.hwnd, expectedProcessId: target.expectedProcessId }, failure);
  sfu = mode === 'sfu' ? await createSfuFixture(channelId, sfuListenIp) : null;
  sfu?.onProducer(producer => {
    for (const subscription of subscriptions.values()) deliver(subscription.addRemoteProducer(producer));
  });
  const send = async value => {
    if (report.simulatedDisconnect) throw new Error('The test deliberately disconnected its native signaling carrier.');
    const message = JSON.parse(JSON.stringify(value));
    queueMicrotask(() => {
      const recipient = message.targetSessionId === 'publisher' ? publisher : subscriptions.get(message.targetSessionId);
      assert.ok(recipient);
      deliver(recipient.receive(message));
      if (message.action === 'accepted' && sfu)
        for (const producer of sfu.producers().reverse()) deliver(recipient.addRemoteProducer(producer));
    });
  };
  const common = { runtime, textures: sharedTexture, mode, publisherSessionId: 'publisher', channelId, captureEncoder: encoder,
    onDiagnostic: error => console.warn('A/V diagnostic:', error.message) };
  publisher = new NativeScreenPublisher({
    sessionId: 'publisher', channelId, mode, source, iceServers: [], send, onError: failure, onState() {},
    createEndpoint(options) {
      const endpoint = new NativeScreenEndpoint({
        ...common, ...options, role: 'publish', sessionId: 'publisher', target, captureDirectory: directory,
        audio: audioOptions(ownerWindow, true), rpc: sfu?.rpc('publisher'),
      });
      observeFixtureFailures(endpoint);
      senders.push(endpoint); return endpoint;
    },
  });
  assert.equal(hub.getStats().captureStarts, 0);
  const start = async (id, quality) => {
    const window = await createWindow(id), presentationId = randomUUID();
    await window.webContents.executeJavaScript(`nativeCaptureSmoke.start(${JSON.stringify(presentationId)})`);
    const subscription = new NativeScreenSubscription({
      sessionId: id, publisherSessionId: 'publisher', channelId, mode, source, quality, presentationId,
      iceServers: [], send, onError: failure, onState() {},
      retirePresentation: () => window.webContents.executeJavaScript('nativeCaptureSmoke.stop()'),
      createEndpoint(options) {
        const endpoint = new NativeScreenEndpoint({
          ...common, ...options, role: 'receive', sessionId: id,
          destination: { frame: window.webContents.mainFrame, presentationId },
          audio: audioOptions(window), rpc: sfu?.rpc(id),
        });
        observeFixtureFailures(endpoint);
        receivers.set(id, endpoint); return endpoint;
      },
    });
    subscriptions.set(id, subscription);
    await subscription.start();
    await waitFor(async () => (await sample(id)).playback?.counters.presentedFrames >= 10, `${id} did not receive video.`);
  };
  phase('silent-source');
  await start('viewer-a', 'source');
  report.silent = { input: senders[0].pcm.getStats(), output: receivers.get('viewer-a').audioOutput.owner.getStats() };
  assert.equal(report.silent.output.ready, true);
  assert.equal(report.silent.output.pcmSignal?.nonzeroFrames ?? 0, 0, 'Silent owned application introduced unrelated audio.');
  phase(silentSource ? 'capturing-real-silence' : 'capturing-real-stereo');
  if (!silentSource) {
    await sourceCommand('tone-start');
    await observeCapturedStereo();
  }
  await waitFor(() => receivedAudio('viewer-a'),
    'The captured application tone did not pass through native Opus and the receiver mixer.');
  if (singleReceiverSoakMs) {
    phase('single-receiver-audio-continuity');
    const start = performance.now();
    const nativeEvents = [], engine = receivers.get('viewer-a').engine;
    const record = value => {
      nativeEvents.push({ at: performance.now(), ...value });
      if (nativeEvents.length > 512) nativeEvents.shift();
    };
    const call = engine.call.bind(engine), emit = engine.emit.bind(engine);
    engine.call = (method, args) => {
      if (method !== 'grantAudioCredits') return call(method, args);
      const grantedAt = performance.now(), grantSequence = args[0].grantSequence;
      record({ type: 'grant', grantSequence, frames: args[0].frames });
      return call(method, args).then(result => {
        record({ type: 'granted', grantSequence, durationMs: performance.now() - grantedAt });
        return result;
      });
    };
    engine.emit = event => {
      if (event.type === 'audio.playout') record({ type: 'pcm', sequence: event.data.sequence });
      return emit(event);
    };
    report.audioContinuity = { startedAt: new Date().toISOString(), durationMs: singleReceiverSoakMs,
      timeOrigin: performance.timeOrigin, sampleCount: 0, samples: [] };
    let nextProgress = 0;
    while (performance.now() - start < singleReceiverSoakMs) {
      if (errors.length) throw new AggregateError(errors, 'Single-receiver audio continuity failed.');
      const value = await sample('viewer-a');
      assert.equal(value.audio.sessions.length, 1);
      assert.equal(value.audio.sessions[0].ready, true);
      assert.deepEqual(value.audio.sessions[0].errors, []);
      const observation = {
        at: new Date().toISOString(), elapsedMs: performance.now() - start,
        audio: value.audio.sessions[0],
        audioScheduling: value.audioScheduling,
        nativeEvents: nativeEvents.splice(0),
        nativeOutput: receivers.get('viewer-a').audioOutput.owner.getStats(),
        capture: hub.getStats(),
        mainScheduling: { maxDelayMs: eventLoopDelay.max / 1e6, p99DelayMs: eventLoopDelay.percentile(99) / 1e6 },
        presentedFrames: value.playback?.counters.presentedFrames,
      };
      // Keep the full timeline on disk, not as growing live objects beside real-time media.
      if (report.audioContinuity.samples.length < 2) report.audioContinuity.samples.push(observation);
      else report.audioContinuity.samples[1] = observation;
      report.audioContinuity.sampleCount++;
      eventLoopDelay.reset();
      fs.appendFileSync(path.join(directory, 'audio-samples.jsonl'), JSON.stringify(observation) + '\n');
      if (report.audioContinuity.sampleCount % 5 === 0) {
        const progress = { ...report, audioContinuity: { ...report.audioContinuity, samples: [observation] } };
        fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(progress, null, 2) + '\n');
      }
      if (performance.now() - start >= nextProgress) {
        console.log('AUDIO_CONTINUITY', JSON.stringify({ elapsedMs: performance.now() - start,
          durationMs: singleReceiverSoakMs, playout: value.audio.sessions[0].sink.playout }));
        nextProgress += 30000;
      }
      await delay(Math.min(1000, Math.max(0, singleReceiverSoakMs - (performance.now() - start))));
    }
    report.audioContinuity.finishedAt = new Date().toISOString();
    if (requireAudioContinuity) {
      const first = report.audioContinuity.samples[0], last = report.audioContinuity.samples.at(-1);
      const before = first.audio.sink.playout, after = last.audio.sink.playout;
      assert.ok(last.elapsedMs - first.elapsedMs >= singleReceiverSoakMs * .95);
      assert.ok(after.renderedFrames - before.renderedFrames >= (last.elapsedMs - first.elapsedMs) * 48 * .95,
        'Actual AudioWorklet output did not keep up with elapsed playback time.');
      const videoFps = (last.presentedFrames - first.presentedFrames) * 1000 / (last.elapsedMs - first.elapsedMs);
      assert.ok(videoFps >= source.video.fps * .85, `Continuous A/V presentation slowed to ${videoFps.toFixed(2)} FPS.`);
      for (const counter of ['underruns', 'silenceFrames', 'discardedFrames'])
        assert.equal(after[counter], before[counter], `Continuous audio increased ${counter}.`);
      const signalBefore = first.nativeOutput.pcmSignal, signalAfter = last.nativeOutput.pcmSignal;
      assert.ok(signalAfter.nonzeroFrames - signalBefore.nonzeroFrames
        >= (signalAfter.frames - signalBefore.frames) * .99, 'The native mixer introduced gaps in the real source tone.');
      assert.ok(signalAfter.normalizedCrossCorrelation < -.9, 'The real received stereo source was not preserved.');
      assert.equal(last.capture.capture.droppedPackets, first.capture.capture.droppedPackets);
      report.audioContinuity.videoFps = videoFps;
      report.audioContinuity.verified = true;
    }
    return;
  }
  await start('viewer-b', 'source');
  await start('viewer-c', lowerQuality);
  assert.equal(senders.length, 2);
  assert.equal(hub.getStats().captureStarts, 1, 'Each quality opened a redundant WASAPI capture.');
  assert.equal(hub.getStats().subscriptions, 2);
  for (const id of ['viewer-a', 'viewer-b', 'viewer-c']) {
    await waitFor(() => receivedAudio(id),
      `${id} did not receive the original shared PCM capture.`);
  }
  phase('measuring-av');
  await delay(1000);
  const before = await Promise.all(['viewer-a', 'viewer-b', 'viewer-c'].map(sample));
  await delay(3000);
  const after = await Promise.all(['viewer-a', 'viewer-b', 'viewer-c'].map(sample));
  report.viewers = after.map((value, index) => {
    const id = ['viewer-a', 'viewer-b', 'viewer-c'][index];
    const fps = (value.playback.counters.presentedFrames - before[index].playback.counters.presentedFrames)
      * 1000 / (value.sampledAtMs - before[index].sampledAtMs);
    return { id, fps, pixels: value.pixels, errors: value.errors, audio: value.audio,
      nativeOutput: receivers.get(id).audioOutput.owner.getStats() };
  });
  for (const [index, value] of report.viewers.entries()) {
    const expected = getScreenShareProfile(source.video, index === 2 ? lowerQuality : 'source', codec).fps;
    assert.ok(value.fps >= expected * .85, `${value.id} A/V cadence was ${value.fps.toFixed(2)} FPS (expected ${expected}).`);
    assert.deepEqual(value.errors, []);
    assert.equal(value.audio.sessions.length, 1);
    const output = value.audio.sessions[0];
    assert.equal(output.ready, true);
    assert.ok(output.sink.playout?.renderedFrames > 4800, 'Native audio did not reach actual AudioWorklet playout.');
    const nativeOutput = value.nativeOutput;
    if (silentSource) assert.equal(nativeOutput.pcmSignal.nonzeroFrames, 0);
    else {
      assert.ok(nativeOutput.pcmSignal.leftRms > .0001 && nativeOutput.pcmSignal.rightRms > .0001);
      assert.ok(nativeOutput.pcmSignal.normalizedCrossCorrelation < -.9, 'Captured anti-phase stereo was not preserved.');
    }
  }
  if (soakMs) {
    phase('sustaining-concurrent-av');
    const until = performance.now() + soakMs;
    report.soak = [];
    report.scheduling = [];
    while (performance.now() < until) {
      if (errors.length) throw new AggregateError(errors, 'Sustained A/V output failed.');
      await delay(1000);
      report.soak.push(await Promise.all(['viewer-a', 'viewer-b', 'viewer-c'].map(async id => {
        const value = await sample(id);
        return { id, sampledAtMs: value.sampledAtMs, presentedFrames: value.playback?.counters.presentedFrames,
          audio: value.audio.sessions.map(output => ({ ready: output.ready, playout: output.sink.playout, errors: output.errors })) };
      })));
      report.scheduling.push({ at: performance.now(), maxDelayMs: eventLoopDelay.max / 1e6,
        p99DelayMs: eventLoopDelay.percentile(99) / 1e6 });
      eventLoopDelay.reset();
      if (report.soak.length % 5 === 0)
        fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
  if (mainStallMs) {
    phase('delaying-main-dispatch');
    const viewers = ['viewer-a', 'viewer-b', 'viewer-c'];
    const before = await Promise.all(viewers.map(sample));
    const beforeAudio = viewers.map(id => receivers.get(id).audioOutput.owner.getStats().pcmSignal.frames);
    report.mainStall = { requestedMs: mainStallMs, audioBefore: hub.getStats(),
      trigger: 'in-flight-texture-transfer',
      presentationBefore: Object.fromEntries(viewers.map(id => [id, receivers.get(id).presentation.getStats()])) };
    const presentation = receivers.get('viewer-a').presentation;
    const originalChannelFactory = presentation.createTextureChannel;
    try {
      await within(new Promise(resolve => {
        presentation.createTextureChannel = () => {
          presentation.createTextureChannel = originalChannelFactory;
          const channel = new MessageChannelMain();
          queueMicrotask(() => {
            const started = performance.now();
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, mainStallMs);
            report.mainStall.actualMs = performance.now() - started;
            resolve();
          });
          return channel;
        };
      }), 12000, 'No real texture transfer reached the Main stall injection.');
    } finally { presentation.createTextureChannel = originalChannelFactory; }
    for (const [index, id] of viewers.entries()) {
      const fps = getScreenShareProfile(source.video, index === 2 ? lowerQuality : 'source', codec).fps;
      await waitFor(async () => (await sample(id)).playback.counters.presentedFrames
        >= before[index].playback.counters.presentedFrames + fps, `${id} video did not resume after Main dispatch returned.`);
      await waitFor(() => receivers.get(id).audioOutput.owner.getStats().pcmSignal.frames >= beforeAudio[index] + 4800,
        `${id} actual PCM stopped advancing after Main dispatch returned.`);
    }
    report.mainStall.audioAfter = hub.getStats();
    assert.equal(report.mainStall.audioAfter.capture.overflowMode, 'discontinue');
    if (mainStallMs >= 1200) assert.ok(report.mainStall.audioAfter.capture.droppedPackets
      > report.mainStall.audioBefore.capture.droppedPackets, 'The injected stall did not exercise native PCM recovery.');
  }
  if (!silentSource) {
    phase('muting-and-volume');
    const endpoint = receivers.get('viewer-a');
    await observeCapturedStereo('captureBeforeVolume');
    const normal = await signalWindow('viewer-a');
    await endpoint.setAudioPreferences({ muted: false, volume: .5 });
    await delay(500);
    const half = await signalWindow('viewer-a');
    report.audioControls = { normal, half };
    fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
    assert.ok(half.leftRms / normal.leftRms > .4 && half.leftRms / normal.leftRms < .6,
      'The real received PCM did not follow its selected volume.');
    await endpoint.setAudioPreferences({ muted: true, volume: .5 });
    await delay(500);
    const muted = await signalWindow('viewer-a');
    assert.equal(muted.nonzeroFrames, 0, 'Muted screen audio still entered the native output.');
    const other = await signalWindow('viewer-b', 300);
    report.audioControls = { normal, half, muted, other };
    fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
    assert.ok(other.nonzeroFrames > 4800, 'Muting one viewer also muted another.');
    await endpoint.setAudioPreferences({ muted: false, volume: 1 });
    await delay(500);
    const resumed = await signalWindow('viewer-a');
    assert.ok(resumed.nonzeroFrames > 4800);
    report.audioControls = { normal, half, muted, other, resumed };
  } else {
    report.audioControls = { tested: false, reason: 'explicit-silent-source' };
  }
  phase('retiring-demand');
  await subscriptions.get('viewer-a').close();
  await subscriptions.get('viewer-b').close();
  await waitFor(() => senders[0].snapshot().closed, 'The first rendition retained its native resources.');
  assert.equal(hub.getStats().subscriptions, 1);
  assert.equal(hub.getStats().captureClosed, false);
  const remainingSignal = await signalWindow('viewer-c');
  assert.ok(remainingSignal.frames > 4800);
  assert.ok(silentSource ? remainingSignal.nonzeroFrames === 0 : remainingSignal.nonzeroFrames > 4800);
  await subscriptions.get('viewer-c').close();
  await waitFor(() => publisher.snapshot().pipelines.length === 0, 'The final viewer retained a native pipeline.');
  await hub.waitUntilIdle();
  assert.equal(hub.getStats().captureClosed, true);
  report.captureAfterStop = hub.getStats();
  for (const id of ['viewer-a', 'viewer-b', 'viewer-c']) assert.equal((await sample(id)).audio.sessions.length, 0);
  phase('restarting-watch');
  await start('viewer-d', '480p30');
  assert.equal(hub.getStats().captureStarts, 2);
  await waitFor(() => receivedAudio('viewer-d'),
    'A fresh Watch failed to resume the actual captured audio.');
  let finalViewer = 'viewer-d';
  if (simulateRtcFault) {
    phase('terminating-live-av-receiver');
    const endpoint = receivers.get(finalViewer), pid = endpoint.engine.child.pid;
    assert.notEqual(pid, process.pid);
    assert.ok(receivedAudio(finalViewer));
    report.expectingRtcFault = true;
    endpoint.engine.child.kill();
    await endpoint.engine.exitState.promise;
    assert.equal(await windows.get(finalViewer).webContents.executeJavaScript('6 * 7'), 42);
    await waitFor(() => subscriptions.get(finalViewer).closed && publisher.snapshot().pipelines.length === 0,
      'The failed media child did not retire its subscription and final PCM demand.', 30000);
    await hub.waitUntilIdle();
    assertNativeScreenEndpointLocallyClosed(endpoint);
    assert.equal(endpoint.engine.pending.size, 0);
    assert.equal(endpoint.engine.leases.size, 0);
    assert.equal(endpoint.audioOutput.owner.getStats().stopped, true);
    assert.equal(senders.at(-1).pcm.getStats().outstanding, 0);
    assert.ok(report.expectedRtcErrors.some(error => error.code === 'ERR_RTC_HOST_EXIT'));
    report.rtcFault = { pid, mainSurvived: true, texturesRetired: true, pcmRetired: true };
    report.expectingRtcFault = false;
    phase('recovering-after-av-fault');
    finalViewer = 'viewer-e';
    await start(finalViewer, '480p30');
    assert.notEqual(receivers.get(finalViewer).engine.child.pid, pid);
    await waitFor(() => receivedAudio(finalViewer),
      'A replacement media child did not resume actual captured PCM.');
    report.rtcFault.recovered = true;
  }
  if (simulateDisconnect) {
    phase('disconnecting-signaling');
    report.simulatedDisconnect = true;
    sfu.disconnectRpc();
    return;
  }
  phase('source-loss');
  expectingSourceLoss = true;
  const closure = await sourceCommand('close-source');
  assert.equal(closure.sourceDestroyed, true, 'The source owner did not prove destruction of its own window.');
  report.sourceClosure = { sourceDestroyed: true };
  await waitFor(() => subscriptions.get(finalViewer).closed && publisher.snapshot().pipelines.length === 0,
    'Source loss did not retire its active A/V subscription.');
  report.sourceLoss = senders.at(-1).snapshot();
  assert.ok(report.sourceLoss.errors.some(error => sourceLossCodes.has(error.code)));
}

app.whenReady().then(async () => {
  try { await run(); }
  catch (error) { failure(error); }
  finally {
    phase('closing');
    const closures = await Promise.allSettled([...subscriptions.values()].map(subscription => subscription.close()));
    const owners = await Promise.allSettled([publisher?.close()]);
    await within(Promise.allSettled([...deliveries]), 15000, 'Owned A/V signaling did not drain.').catch(failure);
    const captures = await Promise.allSettled([hub?.close()]);
    for (const result of [...closures, ...owners, ...captures]) if (result.status === 'rejected') failure(result.reason);
    report.endpoints = [...senders, ...receivers.values()].map(endpoint => endpoint.snapshot());
    try {
      for (const endpoint of [...senders, ...receivers.values()]) assertNativeScreenEndpointLocallyClosed(endpoint);
      publisher.assertLocallyClosed();
      for (const subscription of subscriptions.values()) subscription.assertLocallyClosed();
      assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('monky-screen-capture-')), [],
        'A retired local capture retained its private runtime directory.');
      if (report.simulatedDisconnect) {
        report.remoteRetirement = [...senders, ...receivers.values()].map(endpoint => ({
          locallyRetired: endpoint.snapshot().nativeClosed, fullyRetired: endpoint.snapshot().closed,
          unacknowledgedServerResources: endpoint.broker.snapshot().resources.filter(resource => resource.serverOwned).length,
        }));
        assert.ok(report.remoteRetirement.some(value => value.unacknowledgedServerResources > 0 && !value.fullyRetired),
          'Local cleanup was misrepresented as acknowledgement from the disconnected server.');
        assert.ok(report.remoteCleanupErrors.length > 0, 'The lost remote acknowledgement was silently discarded.');
      } else for (const endpoint of report.endpoints) assert.equal(endpoint.closed && endpoint.nativeClosed, true);
    } catch (error) { fatal(error); }
    if (sfu) {
      try { if (!report.simulatedDisconnect) sfu.assertRetired(); }
      catch (error) { fatal(error); }
      await sfu.close().catch(fatal);
      try { sfu.assertRetired(); } catch (error) { fatal(error); }
    }
    report.hub = hub?.getStats();
    eventLoopDelay.disable();
    report.errors = errors.map(error => error.stack ?? String(error));
    for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    app.exit(errors.length ? 1 : 0);
  }
}).catch(error => { console.error(error); app.exit(1); });
