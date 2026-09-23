'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { within } = require('../runtime/nativeDeadline.cjs');
const directory = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice('--mode='.length) ?? 'p2p';
const soakMs = Number(process.argv.find(value => value.startsWith('--soak-ms='))?.slice('--soak-ms='.length) ?? 0);
const simulateDisconnect = process.argv.includes('--disconnect');
assert.ok(directory && path.isAbsolute(directory) && ['p2p', 'sfu'].includes(mode));
assert.ok(Number.isSafeInteger(soakMs) && soakMs >= 0 && soakMs <= 90000);
assert.ok(!simulateDisconnect || mode === 'sfu');

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
  }, 180000);
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

const { app, BrowserWindow, sharedTexture, MessageChannelMain } = require('electron');
const { loadRuntime, NativeScreenEndpoint, NativeScreenPublisher, NativeScreenSubscription, NativePcmCaptureHub } = require('../index.cjs');
const captureModule = require('@monky/screen-audio');
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
const report = { mode, personalCapture: false, recordedMedia: false, phases: [] };
let publisher, hub, sfu, expectingSourceLoss = false;
const expectedSourceLoss = error => error.code === 'ERR_SCREEN_CAPTURE_SOURCE_LOST' || error.name === 'AbortError'
  || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(expectedSourceLoss));
const fatal = error => { errors.push(error); console.error(error); };
const failure = error => {
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
  if (value.ok) request.resolve(); else request.reject(new Error(value.error));
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
function audioOptions(window, publish = false) {
  return {
    sinkId: '', muted: false, volume: 1,
    output: { webContents: window.webContents, frame: window.webContents.mainFrame,
      expectedUrl: window.webContents.getURL(), createMessageChannel: () => new MessageChannelMain() },
    ...(publish ? { captureModule, captureHub: hub, maxBitrateBps: 128000 } : {}),
  };
}
async function createWindow(id) {
  const window = new BrowserWindow({ width: 640, height: 400, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
      preload: path.join(__dirname, 'nativeCaptureSmoke.preload.cjs') } });
  windows.set(id, window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('render-process-gone', (_event, details) => failure(new Error(`Owned A/V Renderer exited: ${details.reason}`)));
  await window.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'));
  window.setTitle(`Monky owned AV ${id}`); window.showInactive();
  return window;
}
const sample = id => windows.get(id).webContents.executeJavaScript('nativeCaptureSmoke.sample()');
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
async function observeCapturedStereo() {
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
  report.originalCapture = original;
  assert.ok(original.correlation < -.9, 'The owned test source did not deliver anti-phase stereo before RTC.');
}
async function run() {
  phase('starting');
  const runtime = loadRuntime(), channelId = randomUUID();
  const source = { shareId: 'owned-av', instanceId: randomUUID(), audio: true,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  const ownerWindow = await createWindow('publisher');
  const invalid = captureModule.createPacketCapture({
    includeWindowId: target.hwnd, expectedProcessId: process.pid,
  }, () => {});
  await assert.rejects(invalid.ready, { code: 'ERR_AUDIO_TARGET' });
  await invalid.closed;
  report.changedWindowOwnerRejected = true;
  hub = new NativePcmCaptureHub(captureModule,
    { includeWindowId: target.hwnd, expectedProcessId: target.expectedProcessId }, failure);
  sfu = mode === 'sfu' ? await createSfuFixture(channelId) : null;
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
  const common = { runtime, textures: sharedTexture, mode, publisherSessionId: 'publisher', channelId,
    onDiagnostic: error => console.warn('A/V diagnostic:', error.message) };
  publisher = new NativeScreenPublisher({
    sessionId: 'publisher', channelId, mode, source, iceServers: [], send, onError: failure, onState() {},
    createEndpoint(options) {
      const endpoint = new NativeScreenEndpoint({
        ...common, ...options, role: 'publish', sessionId: 'publisher', target, captureDirectory: directory,
        audio: audioOptions(ownerWindow, true), rpc: sfu?.rpc('publisher'),
      });
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
  phase('capturing-real-stereo');
  await sourceCommand('tone-start');
  await waitFor(() => receivers.get('viewer-a').audioOutput.owner.getStats().pcmSignal?.nonzeroFrames > 4800,
    'The captured application tone did not pass through native Opus and the receiver mixer.');
  await observeCapturedStereo();
  await start('viewer-b', 'source');
  await start('viewer-c', '720p60');
  assert.equal(senders.length, 2);
  assert.equal(hub.getStats().captureStarts, 1, 'Each quality opened a redundant WASAPI capture.');
  assert.equal(hub.getStats().subscriptions, 2);
  for (const id of ['viewer-a', 'viewer-b', 'viewer-c']) {
    await waitFor(() => receivers.get(id).audioOutput.owner.getStats().pcmSignal?.nonzeroFrames > 4800,
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
    assert.ok(value.fps >= (index === 2 ? 60 : 120) * .85, `${value.id} A/V cadence was ${value.fps.toFixed(2)} FPS.`);
    assert.deepEqual(value.errors, []);
    assert.equal(value.audio.sessions.length, 1);
    const output = value.audio.sessions[0];
    assert.equal(output.ready, true);
    assert.ok(output.sink.playout?.renderedFrames > 4800, 'Native audio did not reach actual AudioWorklet playout.');
    const nativeOutput = value.nativeOutput;
    assert.ok(nativeOutput.pcmSignal.leftRms > .0001 && nativeOutput.pcmSignal.rightRms > .0001);
    assert.ok(nativeOutput.pcmSignal.normalizedCrossCorrelation < -.9, 'Captured anti-phase stereo was not preserved.');
  }
  if (soakMs) {
    phase('sustaining-concurrent-av');
    const until = performance.now() + soakMs;
    report.soak = [];
    while (performance.now() < until) {
      if (errors.length) throw new AggregateError(errors, 'Sustained A/V output failed.');
      await delay(1000);
      report.soak.push(await Promise.all(['viewer-a', 'viewer-b', 'viewer-c'].map(async id => {
        const value = await sample(id);
        return { id, sampledAtMs: value.sampledAtMs, presentedFrames: value.playback?.counters.presentedFrames,
          audio: value.audio.sessions.map(output => ({ ready: output.ready, playout: output.sink.playout, errors: output.errors })) };
      })));
    }
  }
  phase('muting-and-volume');
  const endpoint = receivers.get('viewer-a');
  const normal = await signalWindow('viewer-a');
  await endpoint.setAudioPreferences({ muted: false, volume: .5 });
  await delay(500);
  const half = await signalWindow('viewer-a');
  assert.ok(half.leftRms / normal.leftRms > .4 && half.leftRms / normal.leftRms < .6,
    'The real received PCM did not follow its selected volume.');
  await endpoint.setAudioPreferences({ muted: true, volume: .5 });
  await delay(500);
  const muted = await signalWindow('viewer-a');
  assert.equal(muted.nonzeroFrames, 0, 'Muted screen audio still entered the native output.');
  const other = await signalWindow('viewer-b', 300);
  assert.ok(other.nonzeroFrames > 4800, 'Muting one viewer also muted another.');
  await endpoint.setAudioPreferences({ muted: false, volume: 1 });
  await delay(500);
  const resumed = await signalWindow('viewer-a');
  assert.ok(resumed.nonzeroFrames > 4800);
  report.audioControls = { normal, half, muted, other, resumed };
  phase('retiring-demand');
  await subscriptions.get('viewer-a').close();
  await subscriptions.get('viewer-b').close();
  await waitFor(() => senders[0].snapshot().closed, 'The first rendition retained its native resources.');
  assert.equal(hub.getStats().subscriptions, 1);
  assert.equal(hub.getStats().captureClosed, false);
  assert.ok((await signalWindow('viewer-c')).nonzeroFrames > 4800);
  await subscriptions.get('viewer-c').close();
  await waitFor(() => publisher.snapshot().pipelines.length === 0, 'The final viewer retained a native pipeline.');
  await hub.waitUntilIdle();
  assert.equal(hub.getStats().captureClosed, true);
  report.captureAfterStop = hub.getStats();
  for (const id of ['viewer-a', 'viewer-b', 'viewer-c']) assert.equal((await sample(id)).audio.sessions.length, 0);
  phase('restarting-watch');
  await start('viewer-d', '480p30');
  assert.equal(hub.getStats().captureStarts, 2);
  await waitFor(() => receivers.get('viewer-d').audioOutput.owner.getStats().pcmSignal?.nonzeroFrames > 4800,
    'A fresh Watch failed to resume the actual captured audio.');
  if (simulateDisconnect) {
    phase('disconnecting-signaling');
    report.simulatedDisconnect = true;
    sfu.disconnectRpc();
    return;
  }
  phase('source-loss');
  expectingSourceLoss = true;
  await sourceCommand('close-source');
  await waitFor(() => subscriptions.get('viewer-d').closed && publisher.snapshot().pipelines.length === 0,
    'Source loss did not retire its active A/V subscription.');
  report.sourceLoss = senders.at(-1).snapshot();
  assert.ok(report.sourceLoss.errors.some(error => error.code === 'ERR_SCREEN_CAPTURE_SOURCE_LOST'));
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
    report.errors = errors.map(error => error.stack ?? String(error));
    for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    app.exit(errors.length ? 1 : 0);
  }
}).catch(error => { console.error(error); app.exit(1); });
