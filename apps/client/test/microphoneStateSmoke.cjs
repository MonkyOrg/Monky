const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `microphone-state-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_MICROPHONE_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_MICROPHONE_TEST_PROFILE);
  let vite;
  let window;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'microphone-state-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__microphone_state__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><body></body></html>');
          });
        },
      }],
    });
    const httpServer = vite.httpServer;
    if (!httpServer) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
    window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Microphone state smoke timed out'); void finish(1); }, 45_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__microphone_state__`);
    const checks = await window.webContents.executeJavaScript(`(${runMicrophoneStateSmoke.toString()})()`, true);
    console.log(`Microphone state smoke: ${checks} checks passed`);
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runMicrophoneStateSmoke() {
  const [{ audioProcessor: audio }, { voiceStore: voice, VoiceStore }, { settingsStore: settings },
    { appEvents }, routing, { soundEffects }] = await Promise.all([
    import('/core/AudioProcessor.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/EventBus.ts'), import('/core/sessionRouting.ts'), import('/core/SoundEffects.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const state = (open, pressed, message) => {
    check(voice.microphoneOpen === open && voice.pttPressed === pressed,
      `${message}: got open=${voice.microphoneOpen}, pressed=${voice.pttPressed}`);
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const input = new AudioContext();
  const source = input.createMediaStreamDestination();
  // Real browser MediaStreamTracks, but no physical capture, speakers or native key injection.
  navigator.mediaDevices.getUserMedia = async () => source.stream.clone();
  soundEffects.playPttTone = () => {};
  voice.isMuted = false;
  voice.isDeafened = false;
  voice.serverMuted = false;
  voice.serverDeafened = false;
  settings.noiseSuppressionEnabled = false;
  settings.inputMode = 'voice_activity';
  settings.pttReleaseDelay = 80;
  audio.setMuted(false);
  audio.setDeafened(false);
  let notifications = 0;
  const off = appEvents.on('voice.microphone_updated', () => { notifications++; });
  try {
    state(false, false, 'no microphone');
    await audio.startMicrophone();
    state(true, false, 'voice activation opens live tracks even in silence');
    const before = notifications;
    audio.applyTrackEnabled();
    audio.applyTrackEnabled();
    check(notifications === before, 'unchanged microphone state is deduplicated');
    voice.setSpeaking(true);
    voice.setSpeaking(false);
    state(true, false, 'VAD does not control microphone availability');

    settings.inputMode = 'push_to_talk';
    appEvents.emit('settings.updated');
    state(false, false, 'PTT starts closed');
    audio.handlePttState(true);
    state(true, true, 'PTT press opens input and output tracks');
    check(audio.rawMicStream.getAudioTracks().every((track) => track.enabled), 'raw input enabled');
    check(audio.getLocalAudioStream().getAudioTracks().every((track) => track.enabled), 'output enabled');
    audio.handlePttState(false);
    state(true, false, 'release tail stays open without showing held key');
    const tail = audio.pttReleaseTimeout;
    audio.handlePttState(false);
    check(audio.pttReleaseTimeout === tail, 'duplicate native/window releases do not extend tail');
    await delay(120);
    state(false, false, 'release delay closes tracks');

    audio.handlePttState(true);
    audio.handlePttState(false);
    audio.handlePttState(true);
    await delay(120);
    state(true, true, 'repress cancels release timeout');
    audio.setMuted(true);
    state(false, false, 'muting a held key clears gate without a release timer');
    audio.handlePttState(false);
    audio.setMuted(false);
    state(false, false, 'release while muted cannot latch on unmute');
    audio.handlePttState(true);
    audio.handlePttState(false);
    audio.setMuted(true);
    audio.setMuted(false);
    await delay(120);
    state(false, false, 'mute cancels pending release tail');

    for (const flag of ['isMuted', 'isDeafened', 'serverMuted', 'serverDeafened']) {
      audio.handlePttState(true);
      voice[flag] = true;
      audio.applyTrackEnabled();
      state(false, false, `${flag} closes and clears held state`);
      audio.handlePttState(false);
      voice[flag] = false;
      audio.applyTrackEnabled();
      state(false, false, `${flag} release cannot reopen PTT`);
    }
    audio.handlePttState(true);
    audio.setDeafened(true);
    state(false, false, 'local deafen closes held PTT');
    audio.setDeafened(false);
    audio.setMuted(false);
    state(false, false, 'undeafen does not restore stale PTT');

    audio.handlePttState(true);
    settings.inputMode = 'voice_activity';
    appEvents.emit('settings.updated');
    state(true, false, 'switching to voice activity clears held key');
    settings.inputMode = 'push_to_talk';
    appEvents.emit('settings.updated');
    state(false, false, 'switching back never restores held gate');
    audio.handlePttState(true);
    audio.stopMicrophone();
    state(false, false, 'stopping held PTT resets UI');
    await audio.startMicrophone();
    state(false, false, 'restarting never restores held gate');

    audio.handlePttState(true);
    const physical = audio.rawMicStream.getAudioTracks()[0];
    const output = audio.getLocalAudioStream().getAudioTracks()[0];
    physical.stop();
    physical.dispatchEvent(new Event('ended'));
    check(output.readyState === 'live', 'Web Audio output remains live after physical loss');
    state(false, false, 'ended input cannot be mistaken for live destination output');
    audio.stopMicrophone();

    const setupAudioGraph = audio.setupAudioGraph;
    let resumeSetup;
    let graphReady;
    const setupPaused = new Promise((resolve) => { graphReady = resolve; });
    const setupResume = new Promise((resolve) => { resumeSetup = resolve; });
    audio.setupAudioGraph = async (stream) => {
      await setupAudioGraph.call(audio, stream);
      graphReady();
      await setupResume;
    };
    try {
      const starting = audio.startMicrophone();
      const result = starting.then(() => null, (error) => error);
      await setupPaused;
      audio.stopMicrophone();
      resumeSetup();
      const error = await result;
      check(error?.name === 'AbortError', 'stop during awaited setup cancels without null dereference');
      check(audio.unbindMicrophoneEvents.length === 0, 'cancelled startup installs no track listeners');
      state(false, false, 'cancelled startup leaves microphone UI reset');
    } finally {
      resumeSetup();
      audio.setupAudioGraph = setupAudioGraph;
    }

    const controls = await import('/core/voiceControls.ts');
    const { networkClient } = await import('/core/NetworkClient.ts');
    const originalSend = networkClient.send;
    const originalPlay = soundEffects.play;
    const previousSoundboardMuted = settings.soundboardMuted;
    const sent = [];
    networkClient.send = (type, payload) => { sent.push({ type, payload }); };
    soundEffects.play = () => {};
    try {
      voice.reset();
      voice.isMuted = voice.isDeafened = false;
      settings.inputMode = 'voice_activity';
      audio.setDeafened(false);
      audio.setMuted(false);
      controls.toggleMicrophoneMute();
      check(voice.isMuted && settings.isMuted, 'microphone mute is saved outside a call');
      check(sent.length === 0 && !audio.getLocalAudioStream(), 'pre-mute neither signals a server nor starts capture');
      await audio.startMicrophone();
      state(false, false, 'microphone starts closed when muted before joining');
      check(audio.rawMicStream.getAudioTracks().every(track => !track.enabled), 'pre-mute also disables the raw input before it can be published');
      voice.setChannel('premute-fixture');
      check(voice.isMuted, 'joining a channel preserves pre-mute');

      controls.toggleAudioDeafen();
      controls.toggleAudioDeafen();
      check(voice.isMuted && !voice.isDeafened, 'undeafen preserves a previously muted microphone');
      controls.toggleMicrophoneMute();
      state(true, false, 'in-call microphone unmute opens the media gate');
      check(sent.at(-1).type === 'VOICE_STATE_UPDATE' && sent.at(-1).payload.isMuted === false, 'in-call mute changes still notify the server');
      controls.toggleAudioDeafen();
      state(false, false, 'in-call deafen closes the microphone');
      controls.toggleMicrophoneMute();
      check(!voice.isMuted && !voice.isDeafened && sent.at(-1).payload.isDeafened === false, 'explicit microphone unmute also undeafens');
      state(true, false, 'unmute while deafened clears cached audio mute as well as UI flags');
      voice.setServerMuted(true);
      controls.toggleMicrophoneMute();
      controls.toggleMicrophoneMute();
      state(false, false, 'local unmute cannot bypass server mute');
      voice.setServerMuted(false);

      audio.stopMicrophone();
      voice.reset();
      const beforeLocalActions = sent.length;
      controls.toggleAudioDeafen();
      check(voice.isMuted && voice.isDeafened && settings.isDeafened, 'deafen outside a call saves both privacy flags');
      controls.toggleAudioDeafen();
      check(!voice.isMuted && !voice.isDeafened, 'undeafen outside a call restores the previously open microphone preference');
      controls.toggleMicrophoneMute();
      settings.soundboardMuted = false;
      let settingsEvents = 0;
      const offSettings = appEvents.on('settings.updated', () => { settingsEvents++; });
      controls.toggleSoundboardMute();
      offSettings();
      check(settings.soundboardMuted && settingsEvents === 1, 'soundboard mute outside a call emits one settings update');
      check(JSON.parse(localStorage.getItem('monky_settings')).soundboardMuted, 'soundboard pre-mute is persisted');
      controls.toggleSoundboardMute();
      check(!settings.soundboardMuted, 'soundboard can also be unmuted outside a call');
      voice.reset();
      check(voice.isMuted && new VoiceStore().isMuted, 'leaving and restoring saved settings preserve pre-mute');
      check(sent.length === beforeLocalActions && !audio.getLocalAudioStream(), 'all outside-call mute controls remain local and do not open capture');
    } finally {
      networkClient.send = originalSend;
      soundEffects.play = originalPlay;
      settings.soundboardMuted = previousSoundboardMuted;
      voice.reset();
      voice.setDeafened(false);
      voice.setMuted(false);
      audio.setDeafened(false);
      audio.setMuted(false);
      settings.inputMode = 'push_to_talk';
    }
    await audio.startMicrophone();
    audio.handlePttState(true);
    audio.destroy();
    state(false, false, 'destroy clears live gate and held key');

    const store = new VoiceStore();
    const foreground = [];
    const offRouting = appEvents.on('voice.microphone_updated', () => foreground.push(routing.isForegroundEvent()));
    routing.setForegroundContext(false);
    store.setMicrophoneState(true, true);
    check(foreground.length === 0, 'background routing defers global microphone event');
    routing.setForegroundContext(true);
    await Promise.resolve();
    check(foreground.length === 1 && foreground[0], 'deferred event reaches foreground UI');
    store.reset();
    check(!store.microphoneOpen && !store.pttPressed, 'store reset clears ephemeral state');
    offRouting();
    return checks;
  } finally {
    off();
    routing.setForegroundContext(true);
    audio.destroy();
    source.stream.getTracks().forEach((track) => track.stop());
    await input.close();
  }
}
