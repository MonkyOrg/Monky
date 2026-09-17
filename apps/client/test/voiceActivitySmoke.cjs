const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const clientRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const { createFixture } = require(path.join(repoRoot, 'apps', 'server', 'dist', 'testFixtures', 'bots.js'));
  const { configureRealSfu } = require('./localExecutionE2e/sfuFixture.cjs');
  for (const mode of ['p2p', 'sfu']) {
    test(`real server and two full renderers show remote speech (${mode})`, { timeout: 120_000 }, async t => {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-voice-activity-'));
      let fixture;
      let child;
      try {
        if (mode === 'sfu') {
          await configureRealSfu(t, path.join(repoRoot, 'apps', 'server', 'dist', 'infrastructure', 'sfu', 'SfuManager.js'));
        }
        fixture = await createFixture();
        const env = { ...process.env, MONKY_ACTIVITY_FIXTURE: JSON.stringify({ url: fixture.url, mode, profile }) };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, `Remote activity failed in ${mode}`);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill();
          await once(child, 'exit');
        }
        await fixture?.dispose();
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
  }
} else {
  void runElectron().catch(error => {
    console.error(error);
    require('electron').app.exit(1);
  });
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { generateKeyPairSync, sign } = require('node:crypto');
  const { MessageType } = require('@monky/shared');
  const { identitySignChannel } = require('./voiceActivityPreload.cjs');
  const config = JSON.parse(process.env.MONKY_ACTIVITY_FIXTURE);
  app.setPath('userData', config.profile);
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('mute-audio');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const windows = [];
  const identities = new Map();
  ipcMain.handle(identitySignChannel, (event, nonce) => {
    const identity = identities.get(event.sender.id);
    assert.ok(identity, 'Only owned fixture windows may sign');
    assert.equal(typeof nonce, 'string');
    assert.match(nonce, /^[a-f0-9]{64}$/i);
    return sign(null, Buffer.from(nonce, 'hex'), identity.privateKey).toString('hex');
  });
  const errors = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let vite;
  let phase = 'startup';
  let last;
  const run = (window, code) => window.webContents.executeJavaScript(
    `(async () => { try { return await (${code}); } catch (error) { throw new Error(error.name + ': ' + error.message); } })()`, true);
  const until = async (probe, description) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (errors.length) throw new Error(errors.join('\n'));
      last = await probe();
      if (last.ok) return last;
      await delay(50);
    }
    throw new Error(`${description}: ${JSON.stringify(last)}`);
  };
  const deadline = setTimeout(() => {
    console.error(`Voice activity timed out during ${phase}: ${JSON.stringify(last)}`);
    app.exit(1);
  }, 100_000);
  let exitCode = 0;
  try {
    const { createServer } = await import('vite');
    const mainPath = path.join(clientRoot, 'src', 'renderer', 'main.ts');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(config.profile, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'real-voice-activity-renderer', enforce: 'pre',
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) return { code: `${code}\nexport { App as ActivityTestApp };`, map: null };
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__voice_activity__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/footerControls.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    for (const label of ['A', 'B']) {
      const window = new BrowserWindow({
        show: false, width: 1280, height: 1000,
        webPreferences: {
          contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
          offscreen: true, partition: `activity-${label}`, preload: path.join(__dirname, 'voiceActivityPreload.cjs'),
        },
      });
      windows.push(window);
      const identity = generateKeyPairSync('ed25519');
      identities.set(window.webContents.id, identity);
      const publicKey = identity.publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('render-process-gone', (_event, details) => errors.push(`${label}: ${details.reason}`));
      await window.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__voice_activity__`);
      await run(window, `(${prepareRenderer.toString()})(${JSON.stringify(config.url)},${JSON.stringify(label)},${JSON.stringify(MessageType)},${JSON.stringify(publicKey)})`);
      if (label === 'A') await run(window, `window.activity.setMode(${JSON.stringify(config.mode)})`);
    }
    phase = 'voice admission';
    for (const window of windows) {
      await run(window, 'window.activity.join()');
      await until(async () => {
        const value = await run(window, 'window.activity.snapshot()');
        return { ...value, ok: value.inRoom && !value.connecting && !value.reconnecting };
      }, 'Voice admission');
    }
    const [a, b] = windows;
    const remoteId = await run(a, 'window.activity.sessionId');
    phase = 'decoded remote speech and visible ring';
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: value.rms > 0.01 && value.packets > 8 && value.speaking && value.ring && value.shadow !== 'none' };
    }, `Audible speech must produce the green ring in ${config.mode}`);
    phase = 'silence';
    await run(a, 'window.activity.tone(false)');
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: value.rms < 0.001 && !value.speaking && !value.ring };
    }, 'Silence clears remote activity');
    phase = 'speech resumes';
    await run(a, 'window.activity.tone(true)');
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: value.rms > 0.01 && value.ring && value.shadow !== 'none' };
    }, 'Speech resumes on the same connection');
    phase = 'listener mute and deafen';
    await run(b, `window.activity.localVolume(${JSON.stringify(remoteId)}, 0)`);
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: value.rms < 0.001 && value.speaking && value.ring };
    }, 'Per-listener volume does not erase remote transmission');
    await run(b, `window.activity.localVolume(${JSON.stringify(remoteId)}, 100)`);
    await run(b, 'window.activity.deafen(true)');
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: !value.ring };
    }, 'Deafen hides activity while not listening');
    await run(b, 'window.activity.deafen(false)');
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: value.rms > 0.01 && value.ring };
    }, 'Undeafen restores the current activity');
    phase = 'leave and rejoin';
    await run(a, 'window.activity.leave()');
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: !value.ring && !value.hasPipeline && !value.hasVad };
    }, 'Leaving removes both playback meter and sampling timer');
    await run(a, 'window.activity.join()');
    await until(async () => {
      const value = await run(b, `window.activity.remote(${JSON.stringify(remoteId)})`);
      return { ...value, ok: value.rms > 0.01 && value.ring && value.hasPipeline && value.hasVad };
    }, 'Rejoining meters the new receiver lifetime');
    console.log(`VOICE ACTIVITY ${config.mode}: real audio, speech/silence, local mute/deafen and rejoin passed`);
  } catch (error) {
    exitCode = 1;
    console.error(`VOICE ACTIVITY ${config.mode} failed during ${phase}:`, error);
    for (const window of windows) {
      if (!window.isDestroyed() && !window.webContents.isCrashed()) {
        console.error('Activity snapshot:', await run(window, 'window.activity?.snapshot()'));
      }
    }
  } finally {
    clearTimeout(deadline);
    for (const window of windows) {
      if (!window.isDestroyed() && !window.webContents.isCrashed()) {
        try { await run(window, 'window.activity?.cleanup()'); }
        catch (error) { exitCode = 1; console.error('Activity cleanup failed:', error); }
      }
      if (!window.isDestroyed()) window.destroy();
    }
    await vite?.close();
    ipcMain.removeHandler(identitySignChannel);
    identities.clear();
    app.exit(exitCode);
  }
}

async function prepareRenderer(url, label, MessageType, publicKey) {
  const errors = [];
  window.addEventListener('error', event => errors.push(event.error?.message ?? event.message));
  window.addEventListener('unhandledrejection', event => errors.push(event.reason?.message ?? String(event.reason)));
  window.api = {
    onAppBeforeQuit: () => () => {}, setWindowInServer: async () => {}, setLanguage: async () => {},
    setPttConfig: async () => true, fitHomeWindowToContent: async () => {},
    hostServerStatus: async () => ({ isRunning: false, port: null, serverId: null }),
    onHostServerStatusChanged: () => () => {}, writeClientLog: async () => {},
    signChallenge: nonce => window.voiceActivityIdentity.signChallenge(nonce),
  };
  const [
    { ActivityTestApp }, { audioProcessor }, { webRtcManager: rtc }, { voiceStore: voice },
    { settingsStore: settings }, { sessionManager }, connection, controls,
  ] = await Promise.all([
    import('/main.ts'), import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'), import('/core/SessionManager.ts'),
    import('/core/serverConnection.ts'), import('/core/voiceControls.ts'),
  ]);
  ActivityTestApp.prototype.init = async () => {};
  const app = new ActivityTestApp();
  app.setupGlobalEventListeners();
  settings.noiseSuppressionMode = 'off';
  settings.inputMode = 'voice_activity';
  settings.vadSensitivity = 0;
  settings.pttSoundCue = false;
  const source = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  const oscillator = source.createOscillator();
  const gain = source.createGain();
  const destination = source.createMediaStreamDestination();
  oscillator.frequency.value = label === 'A' ? 440 : 660;
  gain.gain.value = 0.15;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  await source.resume();
  const captures = [];
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints.audio || constraints.video) throw new Error('Only synthetic microphone capture is available');
    const track = destination.stream.getAudioTracks()[0].clone();
    captures.push(track);
    return new MediaStream([track]);
  };
  const address = new URL(url);
  await connection.openServerSession(address.hostname, Number(address.port), { clientId: crypto.randomUUID(), publicKey }, `Participant ${label}`);
  const session = sessionManager.getActive();
  rtc.rtcConfig = { iceServers: [] };
  let probe;
  const clearProbe = () => {
    if (!probe) return;
    if (rtc.mediaRouter.voicePipelines.get(probe.sessionId) === probe.pipeline
        && probe.pipeline.gain.context.state !== 'closed') probe.pipeline.gain.disconnect(probe.analyser);
    probe.analyser.disconnect();
    probe.sink.disconnect();
    probe = null;
  };
  const snapshot = () => ({
    errors, sessionId: session.serverStore.currentUser.sessionId,
    inRoom: !!voice.currentVoiceChannelId, connecting: voice.isConnecting, reconnecting: voice.isReconnecting,
    microphoneOpen: voice.microphoneOpen, localSpeaking: voice.isSpeaking,
    active: sessionManager.getActiveKey(), call: voice.voiceSessionKey,
    participants: session.participants.getAll().map(p => ({
      sessionId: p.user.sessionId, voiceState: p.voiceState, speaking: p.isSpeaking,
    })),
  });
  window.activity = {
    sessionId: session.serverStore.currentUser.sessionId,
    setMode: mode => session.client.sendRequest(MessageType.SERVER_UPDATE_SETTINGS, { voiceMode: mode }),
    join() {
      const channel = document.querySelector('[data-channel-type="VOICE"]');
      if (!channel) throw new Error('No real voice channel control');
      channel.click();
    },
    snapshot,
    tone: on => { gain.gain.value = on ? 0.15 : 0; },
    leave: () => connection.leaveCurrentCall(),
    localVolume: (sessionId, value) => rtc.mediaRouter.setPeerVolume(sessionId, value),
    deafen: value => { if (voice.isDeafened !== value) controls.toggleAudioDeafen(); },
    async remote(sessionId) {
      const participant = session.participants.get(sessionId);
      const pipeline = rtc.mediaRouter.voicePipelines.get(sessionId);
      if (probe && probe.pipeline !== pipeline) clearProbe();
      if (pipeline && (!probe || probe.pipeline !== pipeline)) {
        const analyser = pipeline.gain.context.createAnalyser();
        const sink = pipeline.gain.context.createGain();
        sink.gain.value = 0;
        pipeline.gain.connect(analyser).connect(sink).connect(pipeline.gain.context.destination);
        probe = { sessionId, pipeline, analyser, sink };
      }
      let rms = 0;
      if (probe) {
        const samples = new Float32Array(probe.analyser.fftSize);
        probe.analyser.getFloatTimeDomainData(samples);
        rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      }
      const receiver = rtc.isSfuMode()
        ? [...rtc.sfuEngine.consumers.values()].find(c => c.kind === 'audio')?.rtpReceiver
        : rtc.peers.get(sessionId)?.pc.getReceivers().find(r => r.track.kind === 'audio');
      const stats = receiver ? [...(await receiver.getStats()).values()].filter(r => r.type === 'inbound-rtp' && r.kind === 'audio') : [];
      const row = document.getElementById(`voice-mini-user-${sessionId}`);
      return {
        ...snapshot(), rms, speaking: participant?.isSpeaking, ring: row?.classList.contains('speaking'),
        hasPipeline: !!pipeline, hasVad: rtc.vadMonitor.remoteAudioVads.has(sessionId),
        shadow: row?.querySelector('img') ? getComputedStyle(row.querySelector('img')).boxShadow : null,
        packets: stats[0]?.packetsReceived ?? 0,
        stats: stats.map(s => ({ audioLevel: s.audioLevel, energy: s.totalAudioEnergy, duration: s.totalSamplesDuration })),
      };
    },
    async cleanup() {
      clearProbe();
      await connection.leaveCurrentCall();
      audioProcessor.stopMicrophone();
      oscillator.stop();
      oscillator.disconnect();
      gain.disconnect();
      destination.disconnect();
      captures.forEach(track => track.stop());
      destination.stream.getTracks().forEach(track => track.stop());
      await source.close();
      session.client.disconnect();
      sessionManager.remove(session.key);
    },
  };
}
