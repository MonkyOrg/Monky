'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { within } = require('../runtime/nativeDeadline.cjs');
const directory = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
assert.equal(process.platform, 'darwin');
assert.ok(directory && path.isAbsolute(directory) && !fs.existsSync(directory), 'Use a new isolated artifact directory.');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const source = require('../../screen-audio/test/macAudioSource.cjs').createMacAudioSource(`${directory}-source`);
  const exited = once(source, 'exit');
  let child;
  const timeout = setTimeout(() => {
    console.error('Native source admission exceeded its deadline.');
    child?.kill('SIGKILL'); source.kill('SIGKILL'); process.exitCode = 1;
  }, 120000);
  void (async () => {
    const [ready] = await within(once(source, 'message'), 15000, 'Owned source did not open.');
    assert.equal(ready.pid, source.pid);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [__filename, ...process.argv.slice(2),
      `--source-pid=${source.pid}`, `--source-window=${ready.hwnd}`], { env, stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, 'Real Main/IPC source admission failed.');
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    source.disconnect();
    try { await within(exited, 10000, 'Owned source did not retire.'); }
    catch (error) { console.error(error); source.kill('SIGKILL'); process.exitCode = 1; }
    clearTimeout(timeout);
  });
  return;
}

const { app, BrowserWindow } = require('electron');
const { createMacScreenProvider, loadRuntime } = require('..');
const { setupNativeScreenSharingIpc } = require('../../../dist-electron/main/nativeScreenSharing.js');
const sourcePid = Number(process.argv.find(value => value.startsWith('--source-pid='))?.slice(13));
const sourceWindow = Number(process.argv.find(value => value.startsWith('--source-window='))?.slice(16));
assert.ok(Number.isSafeInteger(sourcePid) && sourcePid > 0 && Number.isSafeInteger(sourceWindow) && sourceWindow > 0);
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'session'));
process.env.MONKY_HOME = path.join(directory, 'cli');
const report = { cases: [], errors: [], personalSourcesCaptured: false };
let window, provider, service, helper;
void (async () => {
  await app.whenReady();
  loadRuntime();
  provider = createMacScreenProvider();
  const sources = await provider.listSources();
  const selectedWindow = sources.find(value => provider.sources.get(value.id)?.windowId === sourceWindow
    && provider.sources.get(value.id)?.expectedProcessId === sourcePid);
  const selectedMonitor = sources.find(value => value.type === 'screen');
  assert.ok(selectedWindow && selectedMonitor, 'Both the owned window and a monitor identity are required.');
  helper = provider.host.child;
  const listeners = { exit: helper.listenerCount('exit'), close: helper.listenerCount('close') };
  const thumbnail = await provider.thumbnail(selectedWindow.id);
  assert.ok(thumbnail.length > 8);
  report.ownedThumbnailBytes = thumbnail.length;
  window = new BrowserWindow({ width: 640, height: 400, show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: false,
    backgroundThrottling: false,
    preload: path.join(__dirname, 'nativeCaptureSmoke.preload.cjs'),
  } });
  await window.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'));
  report.av1DecoderSupport = await window.webContents.executeJavaScript(`(async () => {
    const result = {};
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      result[hardwareAcceleration] = (await VideoDecoder.isConfigSupported({
        codec: 'av01.0.04M.08', codedWidth: 848, codedHeight: 480,
        optimizeForLatency: true, hardwareAcceleration,
      })).supported;
    }
    return result;
  })()`);
  service = setupNativeScreenSharingIpc(window, (id, kind) => provider.resolveTarget(id, kind));
  const command = value => window.webContents.executeJavaScript(`nativeCaptureSmoke.command(${JSON.stringify(value)})`);
  const callId = randomUUID();
  await command({ action: 'join', callId, sessionId: 'owned-publisher', channelId: 'owned-channel',
    mode: 'p2p', iceServers: [] });
  await command({ action: 'preview-preferences', callId, pauseWhenUnfocused: false });
  for (const [codec, encodingMode] of [['h264', 'hardware'], ['h264', 'software'], ['av1', 'software']]) {
    for (const kind of ['monitor', 'window']) {
      for (let attempt = 0; attempt < 3; ++attempt) {
        const shareId = `${codec}-${kind}-${attempt}`;
        const result = await command({ action: 'source-add', callId, shareId,
          desktopSourceId: kind === 'window' ? selectedWindow.id : selectedMonitor.id, captureKind: kind,
          video: { width: 1280, height: 720, fps: 30, maxBitrateKbps: 3000 },
          codec, encodingStrategy: 'manual', encodingMode,
          audio: true, audioBitrateKbps: 128, preserveAspectRatio: true });
        assert.equal(result.kind, 'source');
        assert.equal(result.source.codec, codec);
        assert.equal(result.source.audio, true);
        if (kind === 'window' && attempt === 0) {
          const presentationId = randomUUID();
          window.showInactive();
          await window.webContents.executeJavaScript(`nativeCaptureSmoke.start(${JSON.stringify(presentationId)}, true)`);
          await command({ action: 'preview-start', callId, shareId,
            sourceInstanceId: result.source.instanceId, presentationId });
          const playback = await within((async () => {
            for (;;) {
              const sample = await window.webContents.executeJavaScript('nativeCaptureSmoke.sample()');
              assert.deepEqual(sample.errors, []);
              if (sample.pixels && sample.playback.counters.presentedFrames >= 5) return sample;
              await delay(100);
            }
          })(), 20000, 'Main/IPC did not deliver the owned native source to the actual local preview.');
          const until = Date.now() + 15000;
          let last = playback;
          let nextEnumeration = 0;
          while (Date.now() < until) {
            if (Date.now() >= nextEnumeration) {
              assert.ok((await provider.listSources()).some(source => source.id === selectedWindow.id));
              assert.ok((await provider.thumbnail(selectedWindow.id)).length > 8);
              nextEnumeration = Date.now() + 3000;
            }
            await delay(250);
            last = await window.webContents.executeJavaScript('nativeCaptureSmoke.sample()');
            assert.deepEqual(last.errors, []);
          }
          assert.ok(last.playback.counters.presentedFrames > playback.playback.counters.presentedFrames + 15,
            'The preview stopped progressing after its initial frames.');
          report.cases.push({ codec, encodingMode, kind, durationMs: 15000,
            actualPreviewFrames: last.playback.counters.presentedFrames });
        }
        await command({ action: 'source-remove', callId, shareId });
        assert.equal((await command({ action: 'stats', callId })).publishers.length, 0);
        assert.equal(provider.host.child, helper);
        assert.equal(helper.exitCode, null);
        assert.equal(helper.listenerCount('exit'), listeners.exit);
        assert.equal(helper.listenerCount('close'), listeners.close);
        assert.equal((await provider.capabilities()).platform, 'darwin');
        report.cases.push({ codec, encodingMode, kind, attempt, admitted: true, released: true, sharedHelperAlive: true });
      }
    }
  }
  assert.ok((await provider.thumbnail(selectedWindow.id)).length > 8);
  await command({ action: 'leave', callId });
  report.casesCompleted = true;
})().catch(error => {
  console.error(error); report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
}).finally(async () => {
  try {
    await service?.dispose();
    await provider?.close();
    if (helper) assert.equal(helper.exitCode, 0, 'The helper must exit when its final owner retires.');
    report.finalHelperExited = !!helper;
  } catch (error) { console.error(error); report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
  window?.destroy();
  report.passed = report.casesCompleted === true && report.errors.length === 0 && report.finalHelperExited === true;
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  app.exit(process.exitCode ?? 0);
});
