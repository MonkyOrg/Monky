'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  const timeout = setTimeout(() => {
    console.error(`Native smoke exceeded its deadline; terminating only owned Electron PID ${child.pid}.`);
    child.kill('SIGKILL'); process.exitCode = 1;
  }, 180000);
  child.once('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.once('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
  return;
}
const { app, BrowserWindow, sharedTexture, MessageChannelMain } = require('electron');
const { getScreenShareProfile } = require('@monky/shared');
const moduleDirectory = process.argv.find(value => value.startsWith('--module='))?.slice('--module='.length)
  ?? path.resolve(__dirname, '..');
assert.ok(path.isAbsolute(moduleDirectory), 'The native module under test must have an absolute path.');
const { loadRuntime, NativeScreenEndpoint, NativeScreenPublisher, NativeScreenSubscription,
  NativeScreenPreviewBridge } = require(moduleDirectory);
const { within } = require('../runtime/nativeDeadline.cjs');
const { createSfuFixture } = require('./sfuFixture.cjs');

const directory = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice('--mode='.length) ?? 'p2p';
const encoder = process.argv.find(value => value.startsWith('--encoder='))?.slice('--encoder='.length) ?? 'auto';
const selectedQuality = process.argv.find(value => value.startsWith('--quality='))?.slice('--quality='.length);
assert.ok(['auto', 'obs_x264', 'monky_aom_av1', 'av1_texture_amf', 'obs_nvenc_av1_tex',
  'h264_texture_amf', 'obs_nvenc_h264_tex'].includes(encoder));
assert.ok(selectedQuality === undefined || ['source', '1080p60', '720p60', '480p30'].includes(selectedQuality));
const codec = ['monky_aom_av1', 'av1_texture_amf', 'obs_nvenc_av1_tex'].includes(encoder) ? 'av1' : 'h264';
const previewOnly = process.argv.includes('--preview-only');
assert.ok(['p2p', 'sfu'].includes(mode));
assert.ok(directory && path.isAbsolute(directory), 'An explicit isolated smoke-artifact directory is required.');
assert.equal(fs.existsSync(directory), false, 'Never reuse a smoke profile or capture owner.');
fs.mkdirSync(directory, { recursive: true });
const profile = path.join(directory, 'electron-profile');
fs.mkdirSync(profile);
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setName('MonkyNativeCaptureSmoke');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const failures = [];
const report = { mode, encoder, codec, moduleDirectory, profiles: [], errors: [], personalWindowsCaptured: false, videoRecorded: false };
const progress = () => fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
const fail = value => {
  const error = value instanceof Error ? value : new Error(String(value));
  failures.push(error); console.error(error);
};
app.on('window-all-closed', () => {});
let sourceWindow, playbackWindow, activeSfu;
const extraWindows = new Set();

async function waitFor(predicate, description, timeout = 20000) {
  const expires = performance.now() + timeout;
  while (performance.now() < expires) {
    if (failures.length) throw new AggregateError(failures, description);
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error(description);
}

async function videoRtp(peer, type) {
  const target = mode === 'p2p' ? peer.peerId : peer.role === 'publish'
    ? peer.publication.producerId : [...peer.broker.activeConsumers.values()][0]?.nativeId;
  const reports = await peer.commands.request(mode === 'p2p' ? 'peer.getStats' : 'sfu.getStats', target, {});
  assert.ok(Array.isArray(reports));
  const rows = reports.filter(value => value.type === type && (value.kind === 'video' || value.mediaType === 'video'));
  assert.equal(rows.length, 1);
  const bytes = rows[0][type === 'outbound-rtp' ? 'bytesSent' : 'bytesReceived'];
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, `Missing native media-byte counter: ${JSON.stringify(rows[0])}`);
  return { id: rows[0].id, bytes };
}

function assertPixels(pixels, video) {
  assert.equal(pixels.width, video.width); assert.equal(pixels.height, video.height);
  const { top, bottom, left, right, center } = pixels;
  assert.ok(top[0] > 180 && top[1] < 70 && top[2] < 70, 'Stretch lost the original top red band.');
  assert.ok(bottom[2] > 180 && bottom[0] < 70 && bottom[1] < 70, 'Stretch lost the original bottom blue band.');
  for (const edge of [left, right])
    assert.ok(edge[0] > 180 && edge[1] < 70 && edge[2] > 180, 'Encoded letterboxing remained at a side edge.');
  assert.ok(center.slice(0, 3).every(value => value > 180), 'The central source geometry was lost.');
}

async function runPreview(runtime) {
  const instanceId = randomUUID(), pipelineId = randomUUID(), presentationId = randomUUID();
  const source = { shareId: 'own-preview', instanceId, codec, audio: false,
    video: { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 } };
  const quality = selectedQuality ?? '480p30', video = getScreenShareProfile(source.video, quality, codec);
  await playbackWindow.webContents.executeJavaScript(`nativeCaptureSmoke.start(${JSON.stringify(presentationId)}, true)`);
  const bridge = new NativeScreenPreviewBridge({
    frame: playbackWindow.webContents.mainFrame,
    info: { callId: instanceId, shareId: source.shareId, sourceInstanceId: instanceId, presentationId },
    createMessageChannel: () => new MessageChannelMain(), onState() {}, onError: fail,
  });
  const endpoint = new NativeScreenEndpoint({
    runtime, textures: sharedTexture, mode: 'p2p', role: 'publish', sessionId: 'smoke-preview',
    publisherSessionId: 'smoke-preview', channelId: instanceId, pipelineId, source, quality,
    captureEncoder: encoder, captureDirectory: directory, preserveAspectRatio: false,
    target: { hwnd: Number(sourceWindow.getNativeWindowHandle().readBigUInt64LE()), expectedProcessId: process.pid },
    send: async () => assert.fail('Local preview must not publish network media.'),
    onError: fail, onState() {}, onDiagnostic: error => console.warn(error),
    onPreview: frame => bridge.offer(frame, pipelineId, video),
  });
  try {
    await endpoint.ready;
    await endpoint.setDemand(0, true);
    const sample = () => playbackWindow.webContents.executeJavaScript('nativeCaptureSmoke.sample()');
    const first = await waitFor(async () => {
      const value = await sample();
      return value.pixels && value.playback.counters.presentedFrames >= 5 ? value : null;
    }, 'The real WebCodecs preview did not present encoded pixels.');
    assert.deepEqual(first.errors, []); assertPixels(first.pixels, video);
    const before = await sample(); await delay(3000); const after = await sample();
    const fps = (after.playback.counters.presentedFrames - before.playback.counters.presentedFrames) *
      1000 / (after.sampledAtMs - before.sampledAtMs);
    assert.deepEqual(after.errors, []);
    assert.ok(fps >= video.fps * .85, `Preview only sustained ${fps.toFixed(2)} of ${video.fps} FPS.`);
    assert.equal(endpoint.flow.snapshot().admitted, 0, 'A local-only preview admitted network input.');
    report.preview = { codec, encoder, video, pixels: first.pixels, presentedFps: fps };
  } finally {
    bridge.close();
    await playbackWindow.webContents.executeJavaScript('nativeCaptureSmoke.stop()');
    await endpoint.close();
    assert.equal(endpoint.snapshot().nativeClosed, true);
    assert.equal(fs.existsSync(endpoint.runDirectory), false);
  }
  if (failures.length) throw new AggregateError(failures, 'Owned preview reported failures.');
  console.log(JSON.stringify({ ...report.preview, nativeClosed: true }));
}

async function runDemandControllers(runtime) {
  const channelId = randomUUID();
  const source = { shareId: 'shared-profile', instanceId: randomUUID(), audio: false,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  const sfu = mode === 'sfu' ? await createSfuFixture(channelId) : null;
  activeSfu = sfu;
  const senders = [], receivers = new Map(), subscriptions = new Map(), windows = new Map(), deliveries = new Set();
  let publisher;
  const result = { mode, phase: 'setting-up' };
  report.controllers = result;
  const trackDelivery = work => {
    deliveries.add(work);
    void work.then(() => deliveries.delete(work), error => {
      deliveries.delete(work);
      if (error.name !== 'AbortError') fail(error);
    });
  };
  const send = async signal => {
    const copied = JSON.parse(JSON.stringify(signal));
    queueMicrotask(() => {
      const recipient = copied.targetSessionId === 'publisher' ? publisher : subscriptions.get(copied.targetSessionId);
      assert.ok(recipient);
      trackDelivery(recipient.receive(copied));
      if (copied.action === 'accepted' && sfu)
        for (const producer of sfu.producers()) trackDelivery(recipient.addRemoteProducer(producer));
    });
  };
  const common = {
    runtime, textures: sharedTexture, mode, publisherSessionId: 'publisher', channelId,
    onDiagnostic: error => console.warn('Controller native diagnostic:', error.message),
  };
  publisher = new NativeScreenPublisher({
    sessionId: 'publisher', channelId, mode, source, iceServers: [], send, onError: fail, onState() {},
    createEndpoint(options) {
      const endpoint = new NativeScreenEndpoint({
        ...common, ...options, role: 'publish', sessionId: 'publisher', captureDirectory: directory, preserveAspectRatio: false,
        target: { hwnd: Number(sourceWindow.getNativeWindowHandle().readBigUInt64LE()), expectedProcessId: process.pid },
        rpc: sfu?.rpc('publisher'),
      });
      senders.push(endpoint);
      return endpoint;
    },
  });
  const start = async (id, quality) => {
    const window = new BrowserWindow({ width: 640, height: 400, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        preload: path.join(__dirname, 'nativeCaptureSmoke.preload.cjs') } });
    extraWindows.add(window); windows.set(id, window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone', (_event, detail) => fail(new Error(`Owned viewer exited: ${detail.reason}`)));
    await window.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'));
    window.setTitle(`Monky owned viewer ${id}`); window.showInactive();
    const presentationId = randomUUID();
    await window.webContents.executeJavaScript(`nativeCaptureSmoke.start(${JSON.stringify(presentationId)})`);
    const subscription = new NativeScreenSubscription({
      sessionId: id, publisherSessionId: 'publisher', channelId, mode, source, quality, presentationId, iceServers: [],
      send, onError: fail, onState() {},
      retirePresentation: () => window.webContents.executeJavaScript('nativeCaptureSmoke.stop()'),
      createEndpoint(options) {
        const endpoint = new NativeScreenEndpoint({
          ...common, ...options, role: 'receive', sessionId: id,
          destination: { frame: window.webContents.mainFrame, presentationId },
          rpc: sfu?.rpc(id),
        });
        receivers.set(id, endpoint);
        return endpoint;
      },
    });
    subscriptions.set(id, subscription);
    await subscription.start();
    await waitFor(async () => {
      const sample = await window.webContents.executeJavaScript('nativeCaptureSmoke.sample()');
      return sample.playback?.counters.presentedFrames >= 10;
    }, `Demand-controlled viewer ${id} did not receive decoded pixels.`);
  };
  const samples = () => Promise.all([...windows.entries()].filter(([id]) => !subscriptions.get(id).closed)
    .map(async ([id, window]) => ({ id, ...await window.webContents.executeJavaScript('nativeCaptureSmoke.sample()') })));
  try {
    assert.equal(senders.length, 0);
    await start('viewer-a', 'source');
    await start('viewer-b', 'source');
    await start('viewer-c', '720p60');
    assert.equal(senders.length, 2, 'Same-profile spectators created redundant capture/encoder pipelines.');
    assert.equal(publisher.snapshot().pipelines.find(pipeline => pipeline.quality === 'source').viewers, 2);
    assert.equal(senders.filter(sender => sender.captureState === 'running').length, 2);
    result.phase = 'measuring-concurrent-viewers'; progress();
    await delay(1000);
    const before = await samples(); await delay(3000); const after = await samples();
    result.viewers = after.map(value => {
      const prior = before.find(sample => sample.id === value.id);
      const fps = (value.playback.counters.presentedFrames - prior.playback.counters.presentedFrames)
        * 1000 / (value.sampledAtMs - prior.sampledAtMs);
      const expected = value.id === 'viewer-c' ? 60 : 120;
      assert.ok(fps >= expected * .85, `Concurrent ${value.id} presented ${fps.toFixed(2)} instead of ${expected} FPS.`);
      assert.deepEqual(value.errors, []);
      assert.equal(value.pixels.width, value.id === 'viewer-c' ? 1280 : 1920);
      return { id: value.id, fps, pixels: value.pixels };
    });
    await subscriptions.get('viewer-a').close();
    await waitFor(() => publisher.snapshot().viewers === 2, 'The first spectator retained demand.');
    assert.equal(senders[0].snapshot().closed, false);
    const remainingBefore = await windows.get('viewer-b').webContents.executeJavaScript('nativeCaptureSmoke.sample()');
    await delay(1000);
    const remainingAfter = await windows.get('viewer-b').webContents.executeJavaScript('nativeCaptureSmoke.sample()');
    assert.ok(remainingAfter.playback.counters.presentedFrames - remainingBefore.playback.counters.presentedFrames >= 95,
      'Stopping one viewer interrupted the remaining same-profile spectator.');
    await subscriptions.get('viewer-b').close();
    await waitFor(() => senders[0].snapshot().closed, 'The last full-quality viewer retained its encoder.');
    assert.equal(senders[1].snapshot().closed, false, 'Retiring one quality also retired another quality.');
    await subscriptions.get('viewer-c').close();
    await waitFor(() => publisher.snapshot().pipelines.length === 0, 'The last viewer retained a pipeline.');
    result.lastViewerRetiredAllPipelines = true;
    result.firstViewerPreservedOtherViewers = true;
    result.phase = 'retired'; progress();
  } finally {
    const closed = await Promise.allSettled([...subscriptions.values()].map(subscription => subscription.close()));
    await publisher.close();
    await within(Promise.allSettled([...deliveries]), 15000, 'Owned signaling did not drain.');
    for (const endpoint of [...senders, ...receivers.values()]) {
      assert.equal(endpoint.snapshot().nativeClosed, true);
      assert.equal(endpoint.snapshot().closed, true);
    }
    if (sfu) {
      try { sfu.assertRetired(); }
      finally { await sfu.close(); activeSfu = null; }
    }
    for (const window of windows.values()) { window.destroy(); extraWindows.delete(window); }
    const errors = closed.filter(value => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Owned demand-controlled viewers did not retire.');
  }
}

async function runProfile(runtime, quality, sourceLoss = false) {
  const runId = randomUUID();
  const source = { shareId: 'own-source', instanceId: runId, audio: false,
    codec,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  const video = getScreenShareProfile(source.video, quality, codec);
  const sfu = mode === 'sfu' ? await createSfuFixture(runId) : null;
  activeSfu = sfu;
  const destination = { frame: playbackWindow.webContents.mainFrame, presentationId: `screen-${runId}` };
  await playbackWindow.webContents.executeJavaScript(`nativeCaptureSmoke.start(${JSON.stringify(destination.presentationId)})`);
  let sender, receiver;
  const result = { video, nativeClosed: false };
  report.profiles.push(result);
  const phase = name => { result.phase = name; progress(); console.log(`Capture smoke ${video.width}x${video.height}@${video.fps}: ${name}`); };
  const mediaError = error => {
    if (!result.expectingSourceLoss) { fail(error); return; }
    (result.expectedSourceErrors ??= []).push({ code: error.code, message: error.message });
  };
  const common = {
    runtime, textures: sharedTexture, mode, publisherSessionId: 'smoke-sender', channelId: runId, captureEncoder: encoder,
    source, quality, onError: mediaError, onState() {},
    onDiagnostic: error => console.warn('Native diagnostic:', error.message),
  };
  const deliver = (other, from, control) => {
    const copied = structuredClone(control);
    const recordCodecs = value => {
      if (typeof value === 'string' && value.startsWith('v=0')) {
        (result.signalingCodecs ??= []).push({ from, lines: value.split(/\r?\n/u)
          .filter(line => /^(m=video|a=(rtpmap:|fmtp:|sendonly|recvonly|sendrecv))/u.test(line)) });
      } else if (value && typeof value === 'object') for (const field of Object.values(value)) recordCodecs(field);
    };
    recordCodecs(copied);
    queueMicrotask(() => { if (!other.closing) other.track(other.receiveControl(from, copied)); });
    return Promise.resolve();
  };
  sender = new NativeScreenEndpoint({
    ...common, role: 'publish', sessionId: 'smoke-sender', pipelineId: randomUUID(), captureDirectory: directory, preserveAspectRatio: false,
    target: { hwnd: Number(sourceWindow.getNativeWindowHandle().readBigUInt64LE()), expectedProcessId: process.pid },
    send: (_remote, control) => deliver(receiver, 'smoke-sender', control),
    rpc: sfu?.rpc('smoke-sender'),
  });
  receiver = new NativeScreenEndpoint({
    ...common, role: 'receive', sessionId: 'smoke-receiver', pipelineId: randomUUID(), destination,
    send: (_remote, control) => deliver(sender, 'smoke-receiver', control),
    rpc: sfu?.rpc('smoke-receiver'),
  });
  try {
    phase('preparing-peers');
    await Promise.all([sender.ready, receiver.ready]);
    assert.equal(sender.snapshot().capturePid, null, 'An idle endpoint must not start capture.');
    await sender.setDemand(1);
    if (sfu) {
      for (const producer of sfu.producers()) await receiver.addRemoteProducer(producer);
    } else {
      const configuration = { connectionId: randomUUID(), generation: 1, iceServers: [] };
      [sender.peerId, receiver.peerId] = await Promise.all([
        sender.connectPeer('smoke-receiver', configuration), receiver.connectPeer('smoke-sender', configuration),
      ]);
    }
    phase('preparing-capture');
    await waitFor(() => sender.captureState === 'running', 'Demand did not start the actual owned capture.');
    result.prepared = sender.host.prepared;
    result.ready = sender.host.ready;
    phase('waiting-for-pixels');
    const sample = () => playbackWindow.webContents.executeJavaScript('nativeCaptureSmoke.sample()');
    const first = await waitFor(async () => {
      const value = await sample();
      return value.pixels && value.playback.counters.presentedFrames >= 5 ? value : null;
    }, 'The native decoded texture did not reach the actual Electron player.');
    assert.deepEqual(first.errors, []);
    assertPixels(first.pixels, video);
    result.pixels = first.pixels;
    phase('measuring-presentation');
    await delay(1000);
    const before = await sample(); await delay(3000); const after = await sample();
    result.pixels = first.pixels;
    result.presentedFps = (after.playback.counters.presentedFrames - before.playback.counters.presentedFrames)
      * 1000 / (after.sampledAtMs - before.sampledAtMs);
    result.playback = after.playback;
    result.capture = await sender.host.getStats();
    result.sender = sender.engine.snapshot(); result.receiver = receiver.engine.snapshot();
    result.flow = sender.flow.snapshot();
    assert.deepEqual(after.errors, []);
    assert.ok(result.presentedFps >= video.fps * .85,
      `Native presentation ${result.presentedFps.toFixed(2)} FPS did not sustain the ${video.fps} FPS profile.`);
    result.activeRtp = { sender: await videoRtp(sender, 'outbound-rtp'), receiver: await videoRtp(receiver, 'inbound-rtp') };
    assert.ok(result.activeRtp.sender.bytes > 0 && result.activeRtp.receiver.bytes > 0);
    phase('stopping-watch');
    await receiver.stopWatching();
    if (sfu) {
      sfu.assertNoConsumers();
      result.serverConsumersRetired = true;
    } else {
      await waitFor(() => !sender.flow.demand, 'Stop Watching did not revoke sender demand.');
      const stoppedAdmission = sender.flow.snapshot().admitted;
      await delay(750);
      assert.equal(sender.flow.snapshot().admitted, stoppedAdmission, 'Native input continued after the last Watch was revoked.');
      const senderBefore = await videoRtp(sender, 'outbound-rtp');
      const receiverBefore = await videoRtp(receiver, 'inbound-rtp');
      await delay(500);
      assert.deepEqual(await videoRtp(sender, 'outbound-rtp'), senderBefore, 'Unwatched video still left the sender.');
      assert.deepEqual(await videoRtp(receiver, 'inbound-rtp'), receiverBefore, 'Unwatched video still reached the receiver.');
      result.stoppedRtp = { sender: senderBefore, receiver: receiverBefore, observedIdleMs: 500 };
    }
    if (sourceLoss) {
      phase('closing-owned-source');
      result.expectingSourceLoss = true;
      sourceWindow.destroy();
      await waitFor(() => sender.host.nativeError, 'Closing the owned source did not report its native cause.');
      assert.equal(sender.host.nativeError.code, 'ERR_SCREEN_CAPTURE_SOURCE_LOST');
    }
  } catch (error) {
    result.error = error.stack ?? String(error);
    result.sender = sender.engine.snapshot(); result.receiver = receiver.engine.snapshot();
    result.flow = sender.flow?.snapshot();
    if (sfu) {
      result.serverStats = await sfu.stats();
      result.nativeTransportStats = await Promise.all(
        [sender, receiver].flatMap(peer => [...peer.broker.transports.values()]
          .map(transport => peer.commands.request('sfu.getStats', transport.nativeId, {}))));
    }
    progress();
    throw error;
  } finally {
    phase('retiring');
    await within(playbackWindow.webContents.executeJavaScript('nativeCaptureSmoke.stop()'), 15000, 'Owned playback did not stop.');
    const outcomes = await Promise.allSettled([sender.setDemand(0), receiver.close()]);
    const expected = error => error === sender.host?.nativeError
      || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(expected));
    const rejected = outcomes.filter(value => value.status === 'rejected').map(value => value.reason);
    const errors = rejected.filter(error => !result.expectingSourceLoss || !expected(error));
    if (result.expectingSourceLoss)
      assert.ok(result.expectedSourceErrors?.some(error => error.code === 'ERR_SCREEN_CAPTURE_SOURCE_LOST'),
        'The original native source failure was not reported.');
    result.retirement = sender.snapshot();
    result.nativeClosed = errors.length === 0 && sender.snapshot().nativeClosed && receiver.snapshot().nativeClosed;
    result.cleanupErrors = errors.map(error => error.stack ?? String(error)); progress();
    assert.equal(sender.snapshot().closed, true);
    assert.equal(receiver.snapshot().closed, true);
    if (sender.runDirectory) assert.equal(fs.existsSync(sender.runDirectory), false, 'An owned capture directory survived complete retirement.');
    if (sfu) {
      try { sfu.assertRetired(); result.serverResourcesRetired = true; }
      finally { await sfu.close(); activeSfu = null; }
    }
    if (errors.length) throw new AggregateError(errors, 'Native smoke retirement failed.');
  }
  if (failures.length) throw new AggregateError(failures, 'Native smoke reported runtime failures.');
  console.log(JSON.stringify({ profile: video, pixels: result.pixels, presentedFps: result.presentedFps, nativeClosed: result.nativeClosed }));
}

app.whenReady().then(async () => {
  try {
    const runtime = loadRuntime();
    sourceWindow = new BrowserWindow({ width: 800, height: 600, useContentSize: true, frame: false, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    playbackWindow = new BrowserWindow({ width: 640, height: 400, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        preload: path.join(__dirname, 'nativeCaptureSmoke.preload.cjs') } });
    for (const window of [sourceWindow, playbackWindow]) {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('render-process-gone', (_event, detail) => fail(new Error(`Smoke renderer exited: ${detail.reason}`)));
    }
    await sourceWindow.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'), { hash: 'source' });
    await playbackWindow.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'));
    sourceWindow.setTitle(`Monky owned capture source ${process.pid}`);
    playbackWindow.setTitle(`Monky owned playback ${process.pid}`);
    sourceWindow.showInactive(); playbackWindow.showInactive();
    if (previewOnly) await runPreview(runtime);
    else {
      if (!selectedQuality) await runDemandControllers(runtime);
      for (const quality of selectedQuality ? [selectedQuality] : ['source', '1080p60', '720p60', '480p30'])
        await runProfile(runtime, quality, quality === '480p30');
    }
  } catch (error) {
    report.errors.push(error.stack ?? String(error)); console.error(error); process.exitCode = 1;
  } finally {
    await activeSfu?.close();
    for (const window of [sourceWindow, playbackWindow, ...extraWindows]) if (window && !window.isDestroyed()) window.destroy();
    report.errors.push(...failures.map(error => error.stack ?? error.message));
    if (report.errors.length) process.exitCode = 1;
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    app.exit(process.exitCode ?? 0);
  }
});
