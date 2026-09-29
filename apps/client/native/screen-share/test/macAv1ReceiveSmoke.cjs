'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit' });
  const timeout = setTimeout(() => {
    console.error(`AV1 smoke exceeded its deadline; terminating owned Electron PID ${child.pid}.`);
    child.kill('SIGKILL'); process.exitCode = 1;
  }, 90000);
  child.once('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.once('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
  return;
}
const { app, BrowserWindow, screen, sharedTexture } = require('electron');
const placement = require('../../../test/fixtures/testDisplay.cjs').installTestDisplay({ app, screen, BrowserWindow });
const { loadRuntime, NativeScreenEndpoint } = require('..');
const { NativeRtcCommands, assertNativeRtcEngineClosed } = require('../runtime/nativeRtcCommands.cjs');
const { NativeP2pBroker } = require('../runtime/nativeP2pBroker.cjs');
const { NativeP2pTransport } = require('../runtime/nativeP2pTransport.cjs');
const { NativeSfuBroker } = require('../runtime/nativeSfuBroker.cjs');
const { NativeSfuTransport } = require('../runtime/nativeSfuTransport.cjs');
const { NativeScreenRoutes } = require('../runtime/nativeScreenRoutes.cjs');
const { LiveSenderFlow } = require('../runtime/encodedSender.cjs');
const { within } = require('../runtime/nativeDeadline.cjs');
const { createSfuFixture } = require('./sfuFixture.cjs');
const directory = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice('--mode='.length) ?? 'p2p';
assert.equal(process.platform, 'darwin');
assert.ok(['p2p', 'sfu'].includes(mode));
assert.ok(directory && path.isAbsolute(directory) && !fs.existsSync(directory), 'Use a new absolute artifact directory.');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'session'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const report = { mode, source: 'owned synthetic WebCodecs AV1 / BT.709 limited I420', errors: [] };
const pending = new Set();
let window, engine, commands, broker, transport, flow, receiver, sfu, closing = false;
const onError = error => { report.errors.push(error.stack ?? String(error)); console.error(error); };
function track(work) {
  pending.add(work);
  void work.then(() => pending.delete(work), error => { pending.delete(work); onError(error); });
}

async function setupEncoder() {
  const width = 640, height = 360;
  let config = { codec: 'av01.0.04M.08', width, height, framerate: 30, bitrate: 2000000,
    hardwareAcceleration: 'prefer-software', latencyMode: 'realtime' };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('AV1 fixture encoder unavailable.');
  let nextKeyframe = true, output, encodeError;
  const encoder = new VideoEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      output = { bytes, keyframe: chunk.type === 'key', timestampUs: chunk.timestamp };
    },
    error(error) { encodeError = error; },
  });
  encoder.configure(config);
  const data = new Uint8Array(width * height * 3 / 2);
  function rectangle(x, y, w, h, luma, u, v) {
    for (let row = y; row < y + h; row++) data.fill(luma, row * width + x, row * width + x + w);
    for (let row = y / 2; row < (y + h) / 2; row++) {
      const offset = width * height + row * width / 2 + x / 2;
      data.fill(u, offset, offset + w / 2);
      data.fill(v, offset + width * height / 4, offset + width * height / 4 + w / 2);
    }
  }
  rectangle(0, 0, width, height, 78, 214, 230);
  rectangle(0, 0, width, 36, 63, 102, 240);
  rectangle(0, height - 36, width, 36, 32, 240, 118);
  rectangle(240, 120, 160, 120, 235, 128, 128);
  globalThis.av1Fixture = {
    async frame(timestamp) {
      if (encodeError) throw encodeError;
      output = null;
      const frame = new VideoFrame(data, { format: 'I420', codedWidth: width, codedHeight: height, timestamp,
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } });
      try { encoder.encode(frame, { keyFrame: nextKeyframe }); nextKeyframe = false; }
      finally { frame.close(); }
      await encoder.flush();
      if (encodeError) throw encodeError;
      if (!output) throw new Error('AV1 fixture produced no access unit.');
      return output;
    },
    setBitrate(bitrate) { config = { ...config, bitrate }; encoder.configure(config); nextKeyframe = true; },
    requestKeyframe() { nextKeyframe = true; },
    close() { encoder.close(); },
  };
}

app.whenReady().then(async () => {
  try {
    const runtime = loadRuntime();
    const clockProbe = path.join(directory, 'capture-clock');
    execFileSync('xcrun', ['clang++', '-std=c++20', path.join(__dirname, 'nativeCaptureClockProbe.cc'), '-o', clockProbe]);
    const id = randomUUID(), publisherId = randomUUID(), video = { width: 640, height: 360, fps: 30, maxBitrateKbps: 2000 };
    const source = { shareId: 'av1-fixture', instanceId: id, codec: 'av1', audio: false, video };
    if (mode === 'sfu') sfu = await createSfuFixture(id);
    const options = { width: 680, height: 440, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        preload: path.join(__dirname, 'nativeCaptureSmoke.preload.cjs') } };
    window = placement ? placement.createWindow(options) : new BrowserWindow(options);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone', (_event, detail) => onError(new Error(`AV1 renderer exited: ${detail.reason}`)));
    await window.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'));
    window.showInactive();
    await window.webContents.executeJavaScript(`(${setupEncoder.toString()})()`);
    await window.webContents.executeJavaScript(`nativeCaptureSmoke.start(${JSON.stringify(id)})`);
    const early = [], sfuStates = new Map();
    const dispatch = async event => {
      if (event.type === 'source.encodedFeedback') flow?.feedback(event);
      else if (event.type === 'source.encodedFrameReleased') flow.released(event);
      else if (event.type === 'error') throw Object.assign(new Error(event.data.message), event.data);
      else if (event.type === 'sfu.state') sfuStates.set(event.target, event.data.state);
      else await transport.handleEvent(event);
    };
    engine = runtime.rtc.createEngine({ maxResources: 64, maxDecodedFrames: 16,
      maximumH264Level: 60, requireAudio: false, videoInput: 'encoded-av1' },
    event => { if (!transport) early.push(event); else track(dispatch(event)); });
    commands = new NativeRtcCommands(engine);
    await engine.ready;
    const routes = new NativeScreenRoutes();
    broker = sfu ? new NativeSfuBroker({ engine, commands, routes, rpc: sfu.rpc('av1-sender'),
      channelId: id, publisherSessionId: 'av1-sender', screenSessionId: publisherId,
      isCurrent: () => !closing, isWatchCurrent: () => false, onError })
      : new NativeP2pBroker({ engine, commands, routes,
      localSessionId: 'av1-sender', syncGroup: id, callId: id, channelId: id, onError,
      isCurrent: () => !closing,
      send: async (_remote, message) => {
        if (!closing) queueMicrotask(() => track(receiver.receiveControl('av1-sender', structuredClone(message))));
      } });
    transport = sfu ? new NativeSfuTransport(broker, onError) : new NativeP2pTransport(broker, onError);
    for (const event of early) track(dispatch(event));
    receiver = new NativeScreenEndpoint({ runtime, textures: sharedTexture, role: 'receive', mode,
      sessionId: 'av1-receiver', publisherSessionId: 'av1-sender', channelId: id, pipelineId: randomUUID(),
      source, quality: 'source', destination: { frame: window.webContents.mainFrame, presentationId: id },
      onError, onState() {}, onDiagnostic: onError,
      rpc: sfu?.rpc('av1-receiver'),
      send: async (_remote, message) => {
        if (!closing) queueMicrotask(() => track(broker.receive('av1-receiver', structuredClone(message))));
      } });
    await receiver.ready;
    if (sfu) routes.setRoster('av1-sender', [source.shareId]);
    else {
      await broker.setRoster('av1-sender', [source.shareId]);
      await broker.setRoster('av1-receiver', []);
    }
    const { sourceId } = await commands.request('source.createEncodedVideo', 0,
      { width: video.width, height: video.height, fps: video.fps, syncGroup: id, enabled: false });
    flow = new LiveSenderFlow({ engine, sourceId, onError, initialBitrateKbps: video.maxBitrateKbps });
    flow.bind({
      async setBitrate(bitrateKbps) {
        await window.webContents.executeJavaScript(`av1Fixture.setBitrate(${bitrateKbps * 1000})`);
        return { bitrateKbps, settingsAccepted: true, hardwareApplicationConfirmed: false };
      },
      async requestKeyFrame() {
        await window.webContents.executeJavaScript('av1Fixture.requestKeyframe()');
        return { mode: 'next-real-idr', keyframeConfirmed: false };
      },
    });
    const publication = await transport.addSource({ sourceId, shareId: source.shareId, syncGroup: id,
      maxFramerate: video.fps, maxBitrateBps: video.maxBitrateKbps * 1000,
      ...(sfu ? { nativeScreen: { sourceInstanceId: id, pipelineId: publisherId, video } } : {}) });
    if (sfu) {
      await broker.setProducerEnabled(publication.producerId, true);
      for (const producer of sfu.producers()) await receiver.addRemoteProducer(producer);
    } else {
      const connection = { connectionId: randomUUID(), generation: 1, iceServers: [] };
      await Promise.all([transport.connect('av1-receiver', connection), receiver.connectPeer('av1-sender', connection)]);
    }
    await within((async () => {
      const connected = () => sfu
        ? ['connected', 'completed'].includes(sfuStates.get(broker.transports.get('send')?.nativeId))
        : broker.sourceDemand(sourceId) > 0 && broker.getPeer('av1-receiver')?.nativeState.connectionState === 'connected';
      while (!connected()) {
        assert.deepEqual(report.errors, []); await delay(20);
      }
    })(), 15000, 'AV1 native peer did not become ready.');
    await commands.request('source.setEnabled', sourceId, { enabled: true });
    flow.setDemand(true); flow.setConnected(true);
    for (let frameId = 1; frameId <= 90; frameId++) {
      assert.deepEqual(report.errors, []);
      const timestampUs = Number(execFileSync(clockProbe, { encoding: 'utf8' }).trim());
      assert.ok(Number.isSafeInteger(timestampUs) && timestampUs > 0);
      const encoded = await window.webContents.executeJavaScript(`av1Fixture.frame(${timestampUs})`);
      const frame = { frameId, data: Buffer.from(encoded.bytes), keyframe: encoded.keyframe, timestampUs,
        durationUs: 33333, ntpTimeMs: -1, pts: String(timestampUs), dts: String(timestampUs),
        timebaseNumerator: 1, timebaseDenominator: 1000000 };
      await within((async () => { while (flow.packet(frame) === false) await delay(2); })(), 5000, 'AV1 admission stalled.');
      await delay(33);
      report.presentation = await window.webContents.executeJavaScript('nativeCaptureSmoke.sample()');
      if (report.presentation.playback.counters.presentedFrames >= 12) break;
    }
    assert.deepEqual(report.presentation.errors, []);
    assert.ok(report.presentation.playback.counters.presentedFrames >= 12, 'Native AV1 did not present actual decoded frames.');
    const { pixels } = report.presentation;
    assert.equal(pixels.width, video.width); assert.equal(pixels.height, video.height);
    assert.ok(pixels.top[0] > 180 && pixels.top[1] < 70 && pixels.top[2] < 70, 'Red AV1 top marker was corrupted.');
    assert.ok(pixels.bottom[2] > 180 && pixels.bottom[0] < 70 && pixels.bottom[1] < 70, 'Blue AV1 bottom marker was corrupted.');
    for (const location of ['left', 'right'])
      assert.ok(pixels[location][0] > 180 && pixels[location][1] < 70 && pixels[location][2] > 180,
        `Magenta AV1 ${location} marker was corrupted.`);
    assert.ok(pixels.center.slice(0, 3).every(value => value > 235), 'White AV1 center marker was corrupted.');
    report.receiver = await receiver.diagnostics();
    assert.equal(report.receiver.readErrors, 0);
    assert.ok(report.receiver.rtp.some(value => value.reports.some(row => row.mimeType?.toLowerCase() === 'video/av1')),
      'The receiver must report the actual AV1 RTP codec.');
    report.flow = flow.snapshot();
    assert.ok(report.flow.admitted > report.flow.actualIdrsAdmitted, 'AV1 must decode dependent frames as well as keyframes.');
  } catch (error) { onError(error); }
  finally {
    closing = true;
    for (const cleanup of [
      () => flow?.close(),
      async () => {
        if (window && !window.isDestroyed())
          await window.webContents.executeJavaScript('globalThis.av1Fixture?.close(); nativeCaptureSmoke.stop()');
      },
      () => receiver?.close(), () => transport?.close(),
      async () => {
        if (!commands) return;
        const closed = commands.closeEngine();
        if (transport) await transport.finishAfterEngineClose(closed);
        else await closed;
      },
      async () => { if (sfu) { try { sfu.assertRetired(); } finally { await sfu.close(); } } },
      async () => {
        if (commands) { assertNativeRtcEngineClosed(commands, engine); flow?.finishAfterEngineClose(commands); }
        await within(Promise.allSettled([...pending]), 15000, 'AV1 signaling did not drain.');
        if (window && !window.isDestroyed()) window.destroy();
      },
    ]) { try { await cleanup(); } catch (error) { onError(error); } }
    report.nativeClosed = receiver?.snapshot().nativeClosed === true && engine?.snapshot().process.exited === true;
    if (!report.nativeClosed) onError(new Error('AV1 native owners did not close.'));
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ av1ReceiveSmoke: report.errors.length === 0, nativeClosed: report.nativeClosed,
      presentedFrames: report.presentation?.playback.counters.presentedFrames }));
    app.exit(report.errors.length ? 1 : 0);
  }
});
