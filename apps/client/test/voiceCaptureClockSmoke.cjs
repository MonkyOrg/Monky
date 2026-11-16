const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

// Regression: the transmitted voice must follow the microphone, not the output
// device's audio clock. A slow output clock used to make Web Audio drop
// microphone samples, so the voice arrived late, robotic and cut.
if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `voice-capture-clock-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_VOICE_CLOCK_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_VOICE_CLOCK_PROFILE);
  // The fake microphone is paced by its own capture timer, like a physical device.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'voice-clock-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__voice_clock__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><body></body></html>');
          });
        },
      }],
    });
    const httpServer = vite.httpServer;
    if (!httpServer) throw new Error('Missing Vite server');
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
    window = new BrowserWindow({
      width: 320, height: 240, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', ({ message }) => {
      if (message.startsWith('[voice clock]')) console.log(message);
    });
    timeout = setTimeout(() => { console.error('Voice capture clock smoke timed out'); void finish(1); }, 120_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__voice_clock__`);
    // A minimized window loses the high resolution timer that paces timer-driven audio output.
    window.minimize();
    const checks = await window.webContents.executeJavaScript(
      `(${runVoiceCaptureClockSmoke.toString()})().catch(error => { throw new Error(error?.stack || error?.message || String(error)); })`,
      true,
    );
    console.log(`Voice capture clock smoke: ${checks} checks passed`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runVoiceCaptureClockSmoke() {
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const NativeAudioContext = window.AudioContext;
  // Without an output device the context renders on a renderer timer, which
  // falls to about 2/3 of real time while the window is minimized: the slow
  // output clock seen in the field reports.
  window.AudioContext = class extends NativeAudioContext {
    constructor(options = {}) { super({ ...options, sinkId: { type: 'none' } }); }
  };
  const [{ audioProcessor: audio }, { voiceStore: voice }, { settingsStore: settings }] = await Promise.all([
    import('/core/AudioProcessor.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
  ]);
  settings.inputMode = 'voice_activity';
  settings.selectedMicrophoneId = '';
  voice.currentVoiceChannelId = 'clock-room';
  voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  /** Fraction of real time delivered by `track`, and by the processing context's clock, over `ms`. */
  const measure = async (track, context, ms) => {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let samples = 0;
    let started = 0;
    let contextStart = 0;
    let stopped = false;
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (started) samples += value.numberOfFrames * 48000 / value.sampleRate;
        value.close();
        if (stopped) return;
      }
    })();
    await wait(1000);
    started = performance.now();
    contextStart = context.currentTime;
    await wait(ms);
    const elapsed = (performance.now() - started) / 1000;
    const contextRate = (context.currentTime - contextStart) / elapsed;
    stopped = true;
    await reader.cancel();
    await pump;
    return { delivered: samples / 48000 / elapsed, contextRate };
  };

  for (const mode of ['gtcrn', 'rnnoise', 'off']) {
    settings.noiseSuppressionMode = mode;
    await audio.startMicrophone();
    const output = audio.getLocalAudioStream().getAudioTracks()[0];
    check(output !== audio.getRawMicrophoneStream().getAudioTracks()[0] && output.enabled && voice.microphoneOpen,
      `${mode}: the processed microphone is open`);
    const { delivered, contextRate } = await measure(output, audio.audioContext, 4000);
    console.log(`[voice clock] ${mode}: transmitted ${(delivered * 100).toFixed(1)}%, output clock ${(contextRate * 100).toFixed(1)}%`);
    check(delivered > 0.95 && delivered < 1.05,
      `${mode}: transmitted voice keeps the microphone's pace (${(delivered * 100).toFixed(1)}%)`);
    audio.stopMicrophone();
  }

  // Browsers without MediaStreamTrackProcessor keep a working Web Audio chain.
  const Generator = window.MediaStreamTrackGenerator;
  delete window.MediaStreamTrackGenerator;
  try {
    settings.noiseSuppressionMode = 'rnnoise';
    await audio.startMicrophone();
    const output = audio.getLocalAudioStream().getAudioTracks()[0];
    check(audio.chain.pipeline === 'webaudio' && audio.chain.suppression === 'rnnoise' && output.readyState === 'live'
      && voice.microphoneOpen, 'Without MediaStreamTrackGenerator the Web Audio chain still processes the microphone');
    audio.stopMicrophone();
    check(output.readyState === 'ended', 'The fallback chain releases its output track');
  } finally {
    window.MediaStreamTrackGenerator = Generator;
  }
  window.AudioContext = NativeAudioContext;
  return checks;
}
