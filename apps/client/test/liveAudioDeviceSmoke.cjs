const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `live-audio-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_LIVE_AUDIO_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_LIVE_AUDIO_PROFILE);
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
        name: 'live-audio-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__live_audio__') return next();
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
      show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Live audio smoke timed out'); void finish(1); }, 90_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__live_audio__`);
    const checks = await window.webContents.executeJavaScript(
      `(${runLiveAudioDeviceSmoke.toString()})().catch(error => { throw new Error(error?.stack || error?.message || String(error)); })`,
      true,
    );
    console.log(`Live audio devices smoke: ${checks} checks passed`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runLiveAudioDeviceSmoke() {
  const [{ applyAudioDevice }, devices, { audioProcessor: audio }, { voiceStore: voice },
    { settingsStore: settings }, { webRtcManager: rtc }, { soundEffects: effects },
    { soundboardService: soundboard }] = await Promise.all([
    import('/core/applyAudioDevice.ts'), import('/core/AudioDeviceService.ts'),
    import('/core/AudioProcessor.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/WebRtcManager.ts'), import('/core/SoundEffects.ts'), import('/core/SoundboardService.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const reject = async (promise, name, message) => {
    let error;
    try { await promise; } catch (reason) { error = reason; }
    check(!!error && (!name || error.name === name), message);
  };
  const context = new AudioContext();
  const source = context.createMediaStreamDestination();
  const captures = [];
  const constraints = [];
  const capture = async options => {
    constraints.push(options);
    const stream = source.stream.clone();
    captures.push(stream);
    return stream;
  };
  const allStopped = stream => stream.getTracks().every(track => track.readyState === 'ended');
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  navigator.mediaDevices.getUserMedia = capture;
  const persistSettings = settings.save.bind(settings);
  settings.save = () => {};
  effects.play = () => {};
  effects.playPttTone = () => {};
  settings.noiseSuppressionEnabled = false;
  settings.inputMode = 'push_to_talk';
  settings.selectedMicrophoneId = 'old-mic';
  voice.currentVoiceChannelId = 'room';
  voice.voiceSessionKey = null;
  voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
  const unregister = devices.registerAudioDeviceApplier(applyAudioDevice);
  const peerConnections = [];
  try {
    await audio.startMicrophone();
    const output = audio.getLocalAudioStream().getAudioTracks()[0];
    const original = audio.getRawMicrophoneStream();
    await devices.selectAudioDevice('input', 'next-mic');
    check(allStopped(original), 'Successful replacement stops the old physical capture');
    check(audio.getLocalAudioStream().getAudioTracks()[0] === output, 'Normal switch preserves outgoing track for P2P and SFU');
    check(!output.enabled && !voice.microphoneOpen && !voice.pttPressed, 'Switch preserves closed PTT gate');
    check(settings.selectedMicrophoneId === 'next-mic' && constraints.at(-1).audio.deviceId.exact === 'next-mic', 'Specific mic is captured before preference commits');
    audio.handlePttState(true);
    await devices.selectAudioDevice('input', '');
    check(constraints.at(-1).audio.deviceId === undefined && settings.selectedMicrophoneId === '', 'Explicit default never falls back to the previous selected ID');
    check(output.enabled && voice.microphoneOpen && voice.pttPressed, 'Held PTT remains coherent after raw source replacement');
    audio.handlePttState(false);

    const beforeFailure = audio.getRawMicrophoneStream();
    const failureCaptureCount = captures.length;
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Device disconnected', 'NotFoundError'); };
    await reject(devices.selectAudioDevice('input', 'missing'), 'NotFoundError', 'Missing microphone surfaces failure without silent default fallback');
    check(audio.getRawMicrophoneStream() === beforeFailure && !allStopped(beforeFailure)
      && settings.selectedMicrophoneId === '' && captures.length === failureCaptureCount, 'Failed selection keeps previous stream and preference');
    navigator.mediaDevices.getUserMedia = capture;
    for (const flag of ['isMuted', 'isDeafened', 'serverMuted', 'serverDeafened']) {
      voice[flag] = true;
      await devices.selectAudioDevice('input', `gated-${flag}`);
      check(!audio.getRawMicrophoneStream().getAudioTracks()[0].enabled && !output.enabled && !voice.microphoneOpen,
        `${flag} cannot be bypassed by changing the microphone`);
      voice[flag] = false;
    }

    let resolveCapture;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCapture = resolve; });
    const controller = new AbortController();
    const beforeAbort = audio.getRawMicrophoneStream();
    const pending = devices.selectAudioDevice('input', 'cancelled', controller.signal);
    controller.abort();
    const cancelled = source.stream.clone();
    resolveCapture(cancelled);
    await reject(pending, 'AbortError', 'Closing the device picker cancels an awaited live capture');
    check(allStopped(cancelled) && audio.getRawMicrophoneStream() === beforeAbort && !allStopped(beforeAbort), 'Cancelled selection stops late capture but retains the old microphone');
    const leaving = devices.selectAudioDevice('input', 'after-leave');
    audio.stopMicrophone();
    voice.currentVoiceChannelId = null;
    const late = source.stream.clone();
    resolveCapture(late);
    await reject(leaving, 'AbortError', 'Leaving a call cancels an awaited live switch');
    check(allStopped(late) && !audio.getLocalAudioStream(), 'Late live capture cannot resurrect a departed call');

    const starting = audio.startMicrophone('late-start');
    audio.stopMicrophone();
    const lateStart = source.stream.clone();
    resolveCapture(lateStart);
    await reject(starting, 'AbortError', 'Leaving before startup capture resolves cancels startup');
    check(allStopped(lateStart) && !audio.getRawMicrophoneStream(), 'Late initial capture is also released');
    navigator.mediaDevices.getUserMedia = capture;
    const countBeforeProbe = captures.length;
    await devices.selectAudioDevice('input', 'pre-call');
    check(captures.length === countBeforeProbe + 1 && allStopped(captures.at(-1)) && !audio.getRawMicrophoneStream(),
      'Outside a call validates one stopped probe, never opens a second microphone');

    voice.currentVoiceChannelId = 'room';
    await audio.startMicrophone('overlap-original');
    const resolutions = [];
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => resolutions.push(resolve));
    const superseded = applyAudioDevice('input', 'first');
    const supersededCheck = reject(superseded, 'AbortError', 'A newer switch invalidates an older capture request');
    const newest = applyAudioDevice('input', 'second');
    await tick();
    const newerCapture = source.stream.clone();
    resolutions[1](newerCapture);
    await newest;
    const olderCapture = source.stream.clone();
    resolutions[0](olderCapture);
    await supersededCheck;
    await tick();
    check(allStopped(olderCapture) && audio.getRawMicrophoneStream() === newerCapture, 'Late old selection cannot replace the newest microphone');
    audio.stopMicrophone();
    navigator.mediaDevices.getUserMedia = capture;

    // Exercise the rare raw-stream fallback using real RTCRtpSenders.
    voice.currentVoiceChannelId = 'room';
    const setupGraph = audio.setupAudioGraph;
    audio.setupAudioGraph = async raw => { audio.localStream = raw; };
    await audio.startMicrophone('raw');
    audio.setupAudioGraph = setupGraph;
    rtc.localAudioTrack = audio.getLocalAudioStream().getAudioTracks()[0];
    const pc = new RTCPeerConnection();
    peerConnections.push(pc);
    const sender = pc.addTrack(rtc.localAudioTrack, audio.getLocalAudioStream());
    rtc.peers.set('fixture-peer', { pc, audioSender: sender });
    const rawPrevious = rtc.localAudioTrack;
    await devices.selectAudioDevice('input', 'raw-next');
    check(sender.track === audio.getLocalAudioStream().getAudioTracks()[0] && rtc.localAudioTrack === sender.track
      && rawPrevious.readyState === 'ended', 'Raw fallback replaces the actual RTP sender before retiring the old track');
    const kept = sender.track;
    const badPc = new RTCPeerConnection();
    peerConnections.push(badPc);
    const badSender = badPc.addTrack(kept, new MediaStream([kept]));
    badSender.replaceTrack = async () => { throw new DOMException('Replacement failed', 'InvalidModificationError'); };
    rtc.peers.set('failing-peer', { pc: badPc, audioSender: badSender });
    await reject(devices.selectAudioDevice('input', 'failed-raw'), 'InvalidModificationError', 'RTP replacement errors propagate');
    check(sender.track === kept && rtc.localAudioTrack === kept && kept.readyState === 'live' && allStopped(captures.at(-1)),
      'Partial RTP replacement rolls back successful senders and discards the new capture');
    rtc.peers.clear();
    const wasSfu = rtc.isSfuMode;
    const replaceSfu = rtc.sfuEngine.replaceTrack;
    const replacements = [];
    rtc.isSfuMode = () => true;
    rtc.sfuEngine.replaceTrack = async (key, track) => { replacements.push({ key, track }); return true; };
    await devices.selectAudioDevice('input', 'sfu-raw');
    check(replacements.at(-1).key === 'mic' && replacements.at(-1).track === audio.getLocalAudioStream().getAudioTracks()[0],
      'Raw SFU replacement updates only the existing microphone producer');
    const sfuKept = audio.getRawMicrophoneStream();
    rtc.sfuEngine.replaceTrack = async () => false;
    await reject(devices.selectAudioDevice('input', 'failed-sfu'), 'Error', 'Failed SFU replacement rejects selection');
    check(audio.getRawMicrophoneStream() === sfuKept && !allStopped(sfuKept) && allStopped(captures.at(-1)),
      'Failed SFU replacement keeps prior microphone and releases candidate');
    rtc.isSfuMode = wasSfu;
    rtc.sfuEngine.replaceTrack = replaceSfu;
    audio.stopMicrophone();

    // Join remains receive-only after both requested and default capture fail.
    rtc.localAudioTrack = null;
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('No microphone', 'NotFoundError'); };
    await reject(audio.startMicrophone('missing-at-join'), 'NotFoundError', 'Initial microphone failure leaves a recoverable receive-only call');
    check(!audio.getRawMicrophoneStream(), 'Failed startup retains no capture');
    const recoveryPc = new RTCPeerConnection();
    peerConnections.push(recoveryPc);
    const recoverySender = recoveryPc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    rtc.peers.set('receive-only', { pc: recoveryPc });
    const failedPreference = settings.selectedMicrophoneId;
    await reject(devices.selectAudioDevice('input', 'still-missing'), 'NotFoundError', 'Recovery captures the chosen device strictly');
    check(!audio.getRawMicrophoneStream() && settings.selectedMicrophoneId === failedPreference && !recoverySender.track,
      'Failed recovery never saves an unavailable microphone or publishes a track');
    navigator.mediaDevices.getUserMedia = capture;
    settings.noiseSuppressionEnabled = true;
    await devices.selectAudioDevice('input', 'recovered-p2p');
    const recoveredOutput = audio.getLocalAudioStream().getAudioTracks()[0];
    check(recoverySender.track === recoveredOutput && rtc.localAudioTrack === recoveredOutput,
      'Recovery publishes to the real existing sendrecv transceiver');
    check(audio.noiseSuppressorNode && audio.analyser && audio.vadInterval && recoveredOutput !== audio.getRawMicrophoneStream().getAudioTracks()[0],
      'Recovery builds the real RNNoise/VAD processed graph, not a permanent raw bypass');
    check(!recoveredOutput.enabled && !voice.microphoneOpen && settings.selectedMicrophoneId === 'recovered-p2p',
      'PTT stays closed and preference commits only after initial publication');
    audio.stopMicrophone();
    await recoverySender.replaceTrack(null);
    rtc.localAudioTrack = null;
    audio.handlePttState(true);
    await devices.selectAudioDevice('input', 'recovered-held-ptt');
    check(recoverySender.track.enabled && voice.microphoneOpen && voice.pttPressed, 'Recovery preserves held PTT without resetting its state');
    audio.stopMicrophone();
    await recoverySender.replaceTrack(null);
    rtc.localAudioTrack = null;
    for (const flag of ['isMuted', 'isDeafened', 'serverMuted', 'serverDeafened']) {
      voice[flag] = true;
      await devices.selectAudioDevice('input', `recover-${flag}`);
      check(!recoverySender.track.enabled && !audio.getRawMicrophoneStream().getAudioTracks()[0].enabled && !voice.microphoneOpen,
        `Initial recovery preserves ${flag}`);
      audio.stopMicrophone();
      await recoverySender.replaceTrack(null);
      rtc.localAudioTrack = null;
      voice[flag] = false;
    }
    settings.noiseSuppressionEnabled = false;
    for (const action of ['picker', 'leave', 'channel', 'session']) {
      let resolveRecovery;
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveRecovery = resolve; });
      const abort = new AbortController();
      const saved = settings.selectedMicrophoneId;
      const recovering = devices.selectAudioDevice('input', `cancel-recovery-${action}`, abort.signal);
      if (action === 'picker') abort.abort();
      if (action === 'leave') { audio.stopMicrophone(); voice.currentVoiceChannelId = null; }
      if (action === 'channel') voice.currentVoiceChannelId = 'different-room';
      if (action === 'session') voice.voiceSessionKey = 'different-session';
      const abandoned = source.stream.clone();
      resolveRecovery(abandoned);
      await reject(recovering, 'AbortError', `${action} invalidates pending initial recovery`);
      check(allStopped(abandoned) && !audio.getRawMicrophoneStream() && !recoverySender.track
        && settings.selectedMicrophoneId === saved, `${action} releases late capture without committing preference`);
      voice.currentVoiceChannelId = 'room';
      voice.voiceSessionKey = null;
    }
    navigator.mediaDevices.getUserMedia = capture;
    const recoveryFailurePc = new RTCPeerConnection();
    peerConnections.push(recoveryFailurePc);
    const recoveryFailureSender = recoveryFailurePc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    recoveryFailureSender.replaceTrack = async () => { throw new DOMException('Cannot publish', 'InvalidModificationError'); };
    rtc.peers.set('recovery-failure', { pc: recoveryFailurePc, audioSender: recoveryFailureSender });
    const beforeRecoveryFailure = settings.selectedMicrophoneId;
    await reject(devices.selectAudioDevice('input', 'publication-failure'), 'InvalidModificationError', 'Initial P2P publication failure propagates');
    check(!recoverySender.track && !rtc.localAudioTrack && !audio.getLocalAudioStream() && !audio.audioContext
      && allStopped(captures.at(-1)) && settings.selectedMicrophoneId === beforeRecoveryFailure,
      'Initial publication rollback detaches already-updated peers and releases the whole graph');
    rtc.peers.delete('recovery-failure');

    const publishMicrophone = rtc.replaceMicrophoneTrack;
    const commitAbort = new AbortController();
    rtc.replaceMicrophoneTrack = async function(track, signal) {
      const rollback = await publishMicrophone.call(this, track, signal);
      commitAbort.abort();
      return rollback;
    };
    await reject(devices.selectAudioDevice('input', 'cancel-after-publication', commitAbort.signal), 'AbortError',
      'Cancellation between RTP publication and graph commit is not successful recovery');
    check(!recoverySender.track && !rtc.localAudioTrack && !audio.getLocalAudioStream()
      && allStopped(captures.at(-1)), 'Post-publication cancellation rolls back the initial sender as well as the graph');
    rtc.replaceMicrophoneTrack = publishMicrophone;

    // The older asynchronous graph must never wire into a newer selection.
    const loadWorklet = AudioWorklet.prototype.addModule;
    const pendingModules = [];
    settings.noiseSuppressionEnabled = true;
    AudioWorklet.prototype.addModule = function(url, options) {
      return new Promise((resolve, reject) => {
        pendingModules.push(() => loadWorklet.call(this, url, options).then(resolve, reject));
      });
    };
    const nextPendingModule = async () => {
      for (let attempt = 0; attempt < 100 && pendingModules.length === 0; attempt++) await tick();
      const finish = pendingModules.shift();
      if (!finish) throw new Error('Expected an asynchronous worklet load');
      return finish;
    };
    const graphAbort = new AbortController();
    const graphPending = devices.selectAudioDevice('input', 'cancel-graph', graphAbort.signal);
    const resolveWorklet = await nextPendingModule();
    const abandonedContext = audio.audioContext;
    const abandonedDestination = audio.destinationNode.stream;
    graphAbort.abort();
    resolveWorklet();
    await reject(graphPending, 'AbortError', 'Picker cancellation interrupts asynchronous graph construction');
    check(allStopped(captures.at(-1)) && allStopped(abandonedDestination) && abandonedContext.state === 'closed'
      && !audio.audioContext && !recoverySender.track, 'Cancelled graph releases its raw and destination tracks and context');

    const initialGraph = audio.startMicrophone('superseded-start');
    const initialGraphCheck = reject(initialGraph, 'AbortError', 'Selection supersedes an unfinished startup graph');
    const resolveInitialWorklet = await nextPendingModule();
    const initialRaw = audio.getRawMicrophoneStream();
    AudioWorklet.prototype.addModule = loadWorklet;
    await devices.selectAudioDevice('input', 'after-initial-graph');
    resolveInitialWorklet();
    await initialGraphCheck;
    check(allStopped(initialRaw) && audio.noiseSuppressorNode && recoverySender.track === audio.getLocalAudioStream().getAudioTracks()[0],
      'Initial graph completion cannot damage the selected recovery graph');
    audio.stopMicrophone();
    await recoverySender.replaceTrack(null);
    rtc.localAudioTrack = null;
    settings.noiseSuppressionEnabled = false;

    const recoveryResolutions = [];
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => recoveryResolutions.push(resolve));
    const firstRecovery = applyAudioDevice('input', 'older-recovery');
    const firstRecoveryCheck = reject(firstRecovery, 'AbortError', 'Concurrent initial recovery is latest-wins');
    const lastRecovery = applyAudioDevice('input', 'latest-recovery');
    await tick();
    const lastRecoveryStream = source.stream.clone();
    recoveryResolutions[1](lastRecoveryStream);
    await lastRecovery;
    const firstRecoveryStream = source.stream.clone();
    recoveryResolutions[0](firstRecoveryStream);
    await firstRecoveryCheck;
    await tick();
    check(allStopped(firstRecoveryStream) && audio.getRawMicrophoneStream() === lastRecoveryStream
      && recoverySender.track === audio.getLocalAudioStream().getAudioTracks()[0], 'Late older recovery cannot replace the latest published graph');
    audio.stopMicrophone();
    rtc.peers.clear();
    rtc.localAudioTrack = null;
    navigator.mediaDevices.getUserMedia = capture;

    let finishPublishing;
    let publicationStarted;
    const publishing = new Promise(resolve => { publicationStarted = resolve; });
    const actualReplace = recoverySender.replaceTrack;
    let holdPublication = true;
    recoverySender.replaceTrack = async function(track) {
      await actualReplace.call(this, track);
      if (track && holdPublication) {
        holdPublication = false;
        publicationStarted();
        await new Promise(resolve => { finishPublishing = resolve; });
      }
    };
    rtc.peers.set('receive-only', { pc: recoveryPc });
    const supersededPublication = applyAudioDevice('input', 'superseded-publication');
    const supersededPublicationCheck = reject(supersededPublication, 'AbortError', 'A newer selection cancels an in-flight initial publication');
    await publishing;
    const stalePublishedTrack = recoverySender.track;
    const latestPublication = applyAudioDevice('input', 'latest-publication');
    finishPublishing();
    await Promise.all([supersededPublicationCheck, latestPublication]);
    check(stalePublishedTrack.readyState === 'ended' && recoverySender.track === rtc.localAudioTrack
      && rtc.localAudioTrack === audio.getLocalAudioStream().getAudioTracks()[0], 'Latest publication waits for stale sender rollback and retains only its own graph');
    recoverySender.replaceTrack = actualReplace;
    audio.stopMicrophone();
    await recoverySender.replaceTrack(null);
    rtc.peers.clear();
    rtc.localAudioTrack = null;

    // Exercise real SFU producer creation/replacement; stub only its transport.
    const engine = rtc.sfuEngine;
    const engineState = { sendTransport: engine.sendTransport, recvTransport: engine.recvTransport,
      device: engine.device, isInitialized: engine.isInitialized };
    const producers = [];
    let failProduce = false;
    let duringProduce = () => {};
    engine.device = { loaded: true, canProduce: () => true };
    engine.recvTransport = {};
    engine.isInitialized = true;
    engine.sendTransport = { produce: async ({ track }) => {
      if (failProduce) throw new Error('SFU publication failed');
      const producer = { id: `mic-${producers.length}`, track, closed: false, on() {},
        close() { this.closed = true; }, async replaceTrack({ track: nextTrack }) { this.track = nextTrack; } };
      producers.push(producer);
      duringProduce();
      return producer;
    } };
    rtc.isSfuMode = () => true;
    check(!engine.producers.has('mic'), 'Receive-only SFU has no microphone producer');
    await devices.selectAudioDevice('input', 'recovered-sfu');
    check(engine.producers.get('mic') === producers.at(-1) && producers.at(-1).track === rtc.localAudioTrack
      && rtc.localAudioTrack === audio.getLocalAudioStream().getAudioTracks()[0] && !rtc.localAudioTrack.enabled,
      'Initial SFU recovery creates the missing producer with processed, PTT-gated audio');
    engine.closeProducer('mic');
    audio.stopMicrophone();
    rtc.localAudioTrack = null;
    const savedSfu = settings.selectedMicrophoneId;
    failProduce = true;
    await reject(devices.selectAudioDevice('input', 'failed-initial-sfu'), 'Error', 'SFU initial publication failure is not silent success');
    check(!engine.producers.has('mic') && !audio.audioContext && !audio.getLocalAudioStream()
      && allStopped(captures.at(-1)) && settings.selectedMicrophoneId === savedSfu, 'Failed SFU startup rolls back graph and preference');
    failProduce = false;
    const sfuAbort = new AbortController();
    duringProduce = () => sfuAbort.abort();
    await reject(devices.selectAudioDevice('input', 'cancel-sfu-produce', sfuAbort.signal), 'AbortError', 'Cancellation during SFU publication rejects recovery');
    check(producers.at(-1).closed && !engine.producers.has('mic') && !rtc.localAudioTrack
      && !audio.getRawMicrophoneStream() && allStopped(captures.at(-1)), 'Cancelled SFU publication closes the newly created producer and capture');
    duringProduce = () => {};
    const sfuCommitAbort = new AbortController();
    rtc.replaceMicrophoneTrack = async function(track, signal) {
      const rollback = await publishMicrophone.call(this, track, signal);
      sfuCommitAbort.abort();
      return rollback;
    };
    await reject(devices.selectAudioDevice('input', 'cancel-after-sfu-publication', sfuCommitAbort.signal), 'AbortError',
      'Cancellation between SFU publication and graph commit rejects recovery');
    check(producers.at(-1).closed && !engine.producers.has('mic') && !rtc.localAudioTrack
      && !audio.getLocalAudioStream(), 'Post-publication SFU cancellation removes the producer and local track');
    rtc.replaceMicrophoneTrack = publishMicrophone;
    Object.assign(engine, engineState);
    rtc.isSfuMode = wasSfu;
    voice.currentVoiceChannelId = null;

    audio.stopMicrophone();
    const noiseConstraints = [];
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await capture(options);
      for (const track of stream.getAudioTracks()) {
        // Synthetic destination tracks have no physical noise-suppression capability.
        track.applyConstraints = async requested => { noiseConstraints.push(requested); };
      }
      return stream;
    };
    settings.noiseSuppressionMode = 'browser';
    settings.inputMode = 'push_to_talk';
    voice.currentVoiceChannelId = 'noise-room';
    voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
    await audio.startMicrophone();
    const noiseInput = audio.getRawMicrophoneStream();
    const noiseOutput = audio.getLocalAudioStream().getAudioTracks()[0];
    for (const mode of ['rnnoise', 'speex', 'gtcrn', 'off', 'browser']) {
      await devices.selectNoiseSuppression(mode);
      await new Promise(resolve => setTimeout(resolve, 100));
      check(settings.noiseSuppressionMode === mode, `${mode}: selected engine is committed`);
      check(audio.getRawMicrophoneStream() === noiseInput
        && audio.getLocalAudioStream().getAudioTracks()[0] === noiseOutput,
        `${mode}: input capture and outgoing RTC track remain stable`);
      check(!!audio.noiseSuppressorNode === !['browser', 'off'].includes(mode),
        `${mode}: actual worklet or browser/direct graph is selected`);
      check(noiseConstraints.at(-1).noiseSuppression === (mode === 'browser'),
        `${mode}: browser suppression is not stacked with a worklet`);
      check(audio.graphReady && !voice.microphoneOpen && !noiseOutput.enabled,
        `${mode}: initialized processor preserves closed PTT gate`);
    }
    audio.stopMicrophone();
    await audio.startMicrophone();
    const failureContext = audio.audioContext;
    const actualAddModule = failureContext.audioWorklet.addModule.bind(failureContext.audioWorklet);
    failureContext.audioWorklet.addModule = async () => { throw new Error('Missing worklet asset'); };
    await reject(devices.selectNoiseSuppression('speex'), undefined, 'A missing engine asset rejects selection');
    check(settings.noiseSuppressionMode === 'browser' && audio.graphReady && !audio.noiseSuppressorNode,
      'Failed noise selection preserves the previous working graph and preference');
    failureContext.audioWorklet.addModule = actualAddModule;
    await devices.selectNoiseSuppression('speex');
    check(settings.noiseSuppressionMode === 'speex' && audio.noiseSuppressorNode,
      'A failed worklet load can be retried successfully');
    const failedProcessor = audio.noiseSuppressorNode;
    failedProcessor.onprocessorerror();
    check(!voice.microphoneOpen && !audio.getLocalAudioStream().getAudioTracks()[0].enabled,
      'Processor errors stop microphone transmission rather than sending raw audio');
    await devices.selectNoiseSuppression('off');
    check(audio.graphReady && !audio.noiseSuppressorNode, 'Explicitly disabling suppression recovers from a processor error');
    check(settings.lastNoiseSuppressionMode === 'speex', 'Disabling retains the last selected engine for the quick toggle');
    audio.stopMicrophone();
    voice.currentVoiceChannelId = null;

    // Stub only physical speaker selection; run the real router/effects/soundboard paths.
    const sinkCalls = [];
    const contextSinkCalls = [];
    const sinkByElement = new WeakMap();
    const sinkByContext = new WeakMap();
    const failedContextSinks = new WeakMap();
    const nativeContextSink = Object.getOwnPropertyDescriptor(AudioContext.prototype, 'sinkId').get;
    HTMLMediaElement.prototype.setSinkId = async function(id) {
      sinkCalls.push({ element: this, id });
      if (this.dataset.failSink === id) throw new DOMException('Speaker unavailable', 'NotFoundError');
      sinkByElement.set(this, id);
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'sinkId', { configurable: true, get() { return sinkByElement.get(this) ?? ''; } });
    AudioContext.prototype.setSinkId = async function(id) {
      contextSinkCalls.push({ context: this, id });
      if (failedContextSinks.get(this) === id) throw new DOMException('Speaker unavailable', 'NotFoundError');
      sinkByContext.set(this, id);
    };
    Object.defineProperty(AudioContext.prototype, 'sinkId', {
      configurable: true, get() { return sinkByContext.get(this) ?? nativeContextSink.call(this); },
    });
    const boardAudio = new Audio();
    const chatVideo = document.createElement('video');
    chatVideo.dataset.audioOutput = 'media';
    const lightboxVideo = document.createElement('video');
    lightboxVideo.dataset.audioOutput = 'media';
    document.body.append(chatVideo, lightboxVideo);
    const router = rtc.mediaRouter;
    const peerAudio = router.ensureVoiceAudioElement('peer', source.stream);
    router.routeScreenAudioTrack('peer', source.stream.getAudioTracks()[0]);
    router.setScreenAudioMuted('peer', false);
    const screenAudio = router.getScreenAudioElement('peer');
    const voiceContext = router.audioContexts.get('voice');
    const screenContext = router.audioContexts.get('screen');
    effects.toneCtx = new AudioContext();
    soundboard.activePlaybacks.set('board', { audio: boardAudio });
    settings.selectedSpeakerId = '';
    await devices.selectAudioDevice('output', 'speaker');
    const outputs = [boardAudio, chatVideo, lightboxVideo, ...Object.values(effects.audioMap)];
    check(outputs.every(element => element.sinkId === 'speaker') && settings.selectedSpeakerId === 'speaker',
      'Specific speaker is applied to native media, effects and soundboard before saving');
    check(sinkByContext.get(voiceContext) === 'speaker' && sinkByContext.get(screenContext) === 'speaker' && sinkByContext.get(effects.toneCtx) === 'speaker',
      'Voice and screen playback at 100%, plus generated tones, follow selected output');
    check(peerAudio.volume === 0 && screenAudio.volume === 0
      && peerAudio.sinkId === 'speaker' && screenAudio.sinkId === 'speaker',
      'Remote decoder elements stay silent and align their shared echo-reference device with voice');
    await devices.selectAudioDevice('output', '');
    check(outputs.every(element => element.sinkId === '') && settings.selectedSpeakerId === '', 'Returning to system default resets every active element');
    check(sinkByContext.get(voiceContext) === '' && sinkByContext.get(screenContext) === '' && sinkByContext.get(effects.toneCtx) === '', 'Default also resets all output AudioContexts');
    failedContextSinks.set(screenContext, 'broken-speaker');
    await reject(devices.selectAudioDevice('output', 'broken-speaker'), 'NotFoundError', 'Active sink failure rejects even after preflight succeeds');
    check(settings.selectedSpeakerId === '' && outputs.every(element => element.sinkId === '')
      && voiceContext.sinkId === '' && screenContext.sinkId === '',
      'Partial speaker switch rolls back all output contexts and keeps previous preference');
    check(contextSinkCalls.some(({ context, id }) => context === voiceContext && id === ''),
      'Default is an actual context setSinkId call, not a skipped empty ID');
    const outputAbort = new AbortController();
    const voiceSetSink = voiceContext.setSinkId;
    voiceContext.setSinkId = async function(id) {
      await voiceSetSink.call(this, id);
      if (id === 'cancel-speaker') outputAbort.abort();
    };
    await reject(devices.selectAudioDevice('output', 'cancel-speaker', outputAbort.signal), 'AbortError', 'Closing output picker cancels an awaited sink change');
    check(settings.selectedSpeakerId === '' && outputs.every(element => element.sinkId === '')
      && voiceContext.sinkId === '' && screenContext.sinkId === '', 'Cancelled output selection restores active sinks');
    voiceContext.setSinkId = voiceSetSink;
    const advanced = {
      selectedSpeakerId: 'general-output', advancedAudioOutputs: true,
      audioOutputDevices: { voice: 'voice-output', screen: 'screen-output', media: 'media-output' },
    };
    await devices.selectAudioOutputPreferences(advanced);
    check(voiceContext.sinkId === 'voice-output' && screenContext.sinkId === 'screen-output'
      && chatVideo.sinkId === 'media-output' && lightboxVideo.sinkId === 'media-output',
      'Voice, screen audio, inline chat and lightbox honor independent outputs');
    check(sinkByContext.get(voiceContext) === 'voice-output' && sinkByContext.get(screenContext) === 'screen-output',
      'Every remote voice and screen volume uses independent output contexts');
    check(peerAudio.sinkId === 'voice-output' && screenAudio.sinkId === 'voice-output',
      'The native shared renderer follows the voice device even when screen speakers differ');
    check(boardAudio.sinkId === 'general-output' && Object.values(effects.audioMap).every(element => element.sinkId === 'general-output'),
      'Soundboard and alerts remain on the general output');
    await devices.selectAudioDevice('output', 'new-general');
    check(voiceContext.sinkId === 'voice-output' && screenContext.sinkId === 'screen-output' && chatVideo.sinkId === 'media-output',
      'Changing general output does not overwrite explicit category overrides');
    const inheritMedia = {
      selectedSpeakerId: settings.selectedSpeakerId, advancedAudioOutputs: true,
      audioOutputDevices: { ...settings.audioOutputDevices, media: null },
    };
    await devices.selectAudioOutputPreferences(inheritMedia);
    check(chatVideo.sinkId === 'new-general' && lightboxVideo.sinkId === 'new-general', 'Media can inherit the general output');
    await devices.selectAudioOutputPreferences({
      ...inheritMedia, audioOutputDevices: { ...inheritMedia.audioOutputDevices, media: '' },
    });
    check(chatVideo.sinkId === '' && lightboxVideo.sinkId === '', 'Explicit system default differs from inheriting the general output');
    const beforeOutputFailure = JSON.stringify(settings.audioOutputDevices);
    await reject(devices.selectAudioOutputPreferences({
      selectedSpeakerId: settings.selectedSpeakerId, advancedAudioOutputs: true,
      audioOutputDevices: { ...settings.audioOutputDevices, screen: 'broken-speaker' },
    }), 'NotFoundError', 'A failing category output rejects the whole settings operation');
    check(JSON.stringify(settings.audioOutputDevices) === beforeOutputFailure && screenContext.sinkId === 'screen-output'
      && voiceContext.sinkId === 'voice-output' && chatVideo.sinkId === '', 'Failed category routing restores all earlier sinks');
    await devices.selectAudioOutputPreferences({
      selectedSpeakerId: settings.selectedSpeakerId, advancedAudioOutputs: false,
      audioOutputDevices: { ...settings.audioOutputDevices },
    });
    check(outputs.every(element => element.sinkId === 'new-general')
      && voiceContext.sinkId === 'new-general' && screenContext.sinkId === 'new-general',
      'Disabling advanced outputs restores general routing everywhere');
    check(settings.audioOutputDevices.voice === 'voice-output' && settings.audioOutputDevices.screen === 'screen-output',
      'Disabling advanced mode does not discard category choices');

    const [{ AudioOutputControls }, { NoiseSuppressionControl }] = await Promise.all([
      import('/views/settings/AudioOutputControls.ts'), import('/views/settings/NoiseSuppressionControl.ts'),
    ]);
    const controls = new AudioOutputControls();
    const noiseControls = new NoiseSuppressionControl();
    const panel = document.createElement('div');
    panel.innerHTML = controls.renderHtml() + noiseControls.renderHtml();
    document.body.append(panel);
    controls.attachEvents(panel);
    noiseControls.attachEvents(panel);
    controls.refreshDevices(['new-general', 'voice-output', 'screen-output', 'media-output'].map(deviceId => ({
      kind: 'audiooutput', deviceId, label: deviceId, groupId: '',
    })));
    const toggleAdvanced = panel.querySelector('#toggle-advanced-audio-outputs');
    check(toggleAdvanced.closest('.toggle-switch') && panel.querySelector('#advanced-audio-outputs').hidden,
      'Advanced routing starts collapsed behind the existing switch component');
    toggleAdvanced.checked = true;
    toggleAdvanced.dispatchEvent(new Event('change'));
    for (let attempt = 0; attempt < 100 && toggleAdvanced.disabled; attempt++) await tick();
    check(!toggleAdvanced.disabled && settings.advancedAudioOutputs && !panel.querySelector('#advanced-audio-outputs').hidden,
      'The actual advanced-output control waits for application and reveals category selectors');
    const mediaSelect = panel.querySelector('#select-audio-output-media');
    check(Array.from(mediaSelect.options).some(option => option.value === 'inherit')
      && Array.from(mediaSelect.options).some(option => option.value === ''), 'Category selector offers both inheritance and explicit system default');
    mediaSelect.value = 'media-output';
    mediaSelect.dispatchEvent(new Event('change'));
    for (let attempt = 0; attempt < 100 && mediaSelect.disabled; attempt++) await tick();
    check(settings.audioOutputDevices.media === 'media-output' && chatVideo.sinkId === 'media-output',
      'Changing the actual category selector applies and persists the sink');
    const noiseSelect = panel.querySelector('#select-noise-suppression');
    const captureCountBeforeNoiseSelection = captures.length;
    noiseSelect.value = 'speex';
    noiseSelect.dispatchEvent(new Event('change'));
    for (let attempt = 0; attempt < 100 && noiseSelect.disabled; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    check(!noiseSelect.disabled && settings.noiseSuppressionMode === 'speex'
      && captures.length === captureCountBeforeNoiseSelection, 'Noise selector validates a local engine without opening the microphone');
    const outputReset = panel.querySelector('#reset-audio-outputs');
    const stubbedSave = settings.save;
    settings.save = persistSettings;
    const categorySink = HTMLMediaElement.prototype.setSinkId;
    const unavailable = new Set();
    HTMLMediaElement.prototype.setSinkId = async function(id) {
      if (unavailable.has(id)) throw new DOMException('Saved output was disconnected', 'NotFoundError');
      return categorySink.call(this, id);
    };
    try {
      await devices.selectAudioOutputPreferences({ ...advanced, selectedSpeakerId: 'new-general', advancedAudioOutputs: false });
      unavailable.add('voice-output');
      unavailable.add('screen-output');
      controls.refreshDevices([{ kind: 'audiooutput', deviceId: 'new-general', label: 'General', groupId: '' }]);
      toggleAdvanced.checked = true;
      toggleAdvanced.dispatchEvent(new Event('change'));
      for (let attempt = 0; attempt < 100 && toggleAdvanced.disabled; attempt++) await tick();
      check(!settings.advancedAudioOutputs && panel.querySelector('#advanced-audio-outputs').hidden
        && !outputReset.hidden && !outputReset.disabled, 'Missing saved category devices block activation but leave explicit recovery reachable');
      const routingError = panel.querySelector('#advanced-audio-output-status').textContent;
      settings.save();
      check(Boolean(routingError) && panel.querySelector('#advanced-audio-output-status').textContent === routingError,
        'Unrelated settings notifications do not erase the output selection error');
      outputReset.click();
      for (let attempt = 0; attempt < 100 && outputReset.disabled; attempt++) await tick();
      check(settings.selectedSpeakerId === '' && !settings.advancedAudioOutputs
        && Object.values(settings.audioOutputDevices).every(id => id === null), 'Explicit recovery resets general output and every override together');
      check(outputs.every(element => element.sinkId === '') && sinkByContext.get(voiceContext) === ''
        && sinkByContext.get(screenContext) === '', 'Recovery routes existing players and amplified categories to system default');
      check(outputReset.hidden && !panel.querySelector('#advanced-audio-output-status').textContent,
        'Successful recovery clears its error and hides the unnecessary reset action');
      unavailable.clear();
      await devices.selectAudioOutputPreferences({ ...advanced, selectedSpeakerId: 'new-general' });
      ['new-general', 'voice-output', 'screen-output'].forEach(id => unavailable.add(id));
      controls.refreshDevices([{ kind: 'audiooutput', deviceId: 'available-output', label: 'Available', groupId: '' }]);
      const voiceSelect = panel.querySelector('#select-audio-output-voice');
      voiceSelect.value = 'inherit';
      voiceSelect.dispatchEvent(new Event('change'));
      for (let attempt = 0; attempt < 100 && voiceSelect.disabled; attempt++) await tick();
      check(settings.advancedAudioOutputs && settings.audioOutputDevices.voice === 'voice-output' && !outputReset.hidden,
        'Several missing outputs cannot force a partial invalid preference; all-output recovery remains available');
      outputReset.click();
      for (let attempt = 0; attempt < 100 && outputReset.disabled; attempt++) await tick();
      const restoredOutputs = JSON.parse(localStorage.getItem('monky_settings'));
      check(restoredOutputs.selectedSpeakerId === '' && !restoredOutputs.advancedAudioOutputs
        && Object.values(restoredOutputs.audioOutputDevices).every(id => id === null),
        'One recovery action persists a valid configuration even when general and multiple categories disappeared');
      toggleAdvanced.checked = true;
      toggleAdvanced.dispatchEvent(new Event('change'));
      for (let attempt = 0; attempt < 100 && toggleAdvanced.disabled; attempt++) await tick();
      check(settings.advancedAudioOutputs && !panel.querySelector('#advanced-audio-outputs').hidden
        && !panel.querySelector('#audio-output-voice-status').textContent, 'Advanced routing can be enabled and edited normally after recovery');
    } finally {
      HTMLMediaElement.prototype.setSinkId = categorySink;
      settings.save = stubbedSave;
    }
    controls.cleanup();
    noiseControls.cleanup();
    panel.remove();

    // Local tracks use a different Chromium renderer. Exercise actual receivers,
    // with no physical input or audible test output, before accepting routing.
    const { RemoteMediaRouter } = await import('/core/webrtc/RemoteMediaRouter.ts');
    const remoteRouter = new RemoteMediaRouter(() => ({ get: () => undefined }));
    const transmitter = new RTCPeerConnection();
    const receiver = new RTCPeerConnection();
    peerConnections.push(transmitter, receiver);
    const received = new Map();
    const oscillators = [];
    const toneStreams = [];
    const frequencies = [468.75, 937.5, 1406.25];
    const waitFor = async (condition, message) => {
      const deadline = performance.now() + 8000;
      while (!condition()) {
        if (performance.now() > deadline) throw new Error(typeof message === 'function' ? message() : message);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    };
    receiver.ontrack = event => received.set(event.streams[0].id, event.track);
    try {
      for (const frequency of frequencies) {
        const oscillator = context.createOscillator();
        const level = context.createGain();
        const destination = context.createMediaStreamDestination();
        oscillator.frequency.value = frequency;
        level.gain.value = 0.1;
        oscillator.connect(level).connect(destination);
        oscillator.start();
        oscillators.push(oscillator);
        toneStreams.push(destination.stream);
        transmitter.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
      }
      await context.resume();
      await transmitter.setLocalDescription(await transmitter.createOffer());
      await waitFor(() => transmitter.iceGatheringState === 'complete', 'Sender ICE gathering timed out');
      await receiver.setRemoteDescription(transmitter.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await waitFor(() => receiver.iceGatheringState === 'complete', 'Receiver ICE gathering timed out');
      await transmitter.setRemoteDescription(receiver.localDescription);
      await waitFor(() => received.size === 3, 'Missing negotiated remote audio tracks');
      await remoteRouter.setOutputDeviceIds('', 'network-screen-speakers');
      const voicePlayer = remoteRouter.ensureVoiceAudioElement('network-peer',
        new MediaStream([received.get(toneStreams[0].id)]));
      const otherVoicePlayer = remoteRouter.ensureVoiceAudioElement('network-other-peer',
        new MediaStream([received.get(toneStreams[1].id)]));
      remoteRouter.routeScreenAudioTrack('network-peer', received.get(toneStreams[2].id));
      remoteRouter.setScreenAudioMuted('network-peer', false);
      const voiceGraph = remoteRouter.voicePipelines.get('network-peer');
      const otherVoiceGraph = remoteRouter.voicePipelines.get('network-other-peer');
      const screenGraph = remoteRouter.screenAudioPipelines.get('network-peer');
      const attachAnalyser = pipeline => {
        const analyser = pipeline.gain.context.createAnalyser();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0;
        pipeline.gain.connect(analyser);
        const waveform = new Float32Array(analyser.fftSize);
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        return {
          rms() {
            analyser.getFloatTimeDomainData(waveform);
            return Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length);
          },
          level(frequency) {
            analyser.getFloatFrequencyData(spectrum);
            const bin = Math.round(frequency * analyser.fftSize / analyser.context.sampleRate);
            return Math.max(...spectrum.slice(bin - 2, bin + 3));
          },
        };
      };
      const voiceSignal = attachAnalyser(voiceGraph);
      const otherVoiceSignal = attachAnalyser(otherVoiceGraph);
      const screenSignal = attachAnalyser(screenGraph);
      await waitFor(() => voiceSignal.rms() > 0.005 && otherVoiceSignal.rms() > 0.005
        && screenSignal.rms() > 0.005, 'Decoded WebRTC audio did not reach the category output graphs');
      check(voiceGraph.gain.context !== screenGraph.gain.context
        && voiceGraph.gain.context === otherVoiceGraph.gain.context,
        'Actual WebRTC receivers share a voice destination, not the screen destination');
      let levels;
      await waitFor(() => {
        levels = [voiceSignal, otherVoiceSignal, screenSignal].map(signal => frequencies.map(frequency => signal.level(frequency)));
        return levels[0][0] > levels[0][2] + 20 && levels[2][2] > levels[2][0] + 20
          && levels[2][2] > levels[2][1] + 20;
      }, () => `Decoded WebRTC spectra did not separate after startup: ${JSON.stringify(levels)}`);
      check(levels[0][0] > levels[0][2] + 20 && levels[2][2] > levels[2][0] + 20
        && levels[2][2] > levels[2][1] + 20,
        `Decoded audio proves no voice samples leak into the screen graph or vice versa: ${JSON.stringify(levels)}`);
      check(voicePlayer.volume === 0 && otherVoicePlayer.volume === 0
        && remoteRouter.getScreenAudioElement('network-peer').volume === 0
        && !sinkCalls.some(({ element }) => element === voicePlayer || element === otherVoicePlayer
          || element === remoteRouter.getScreenAudioElement('network-peer')),
        'Real receiver tracks never use audible native WebRTC playback or its shared sink switch');
      await remoteRouter.setOutputDeviceIds('', 'different-screen-speakers');
      check(voiceGraph.gain.context.sinkId === '' && otherVoiceGraph.gain.context.sinkId === ''
        && screenGraph.gain.context.sinkId === 'different-screen-speakers',
        'Switching only screen speakers preserves default headphones for every remote voice');
      await remoteRouter.setOutputDeviceIds('network-headphones', 'different-screen-speakers');
      check(voiceGraph.gain.context.sinkId === 'network-headphones'
        && screenGraph.gain.context.sinkId === 'different-screen-speakers'
        && voicePlayer.sinkId === 'network-headphones' && otherVoicePlayer.sinkId === 'network-headphones'
        && remoteRouter.getScreenAudioElement('network-peer').sinkId === 'network-headphones',
        'Explicit voice selection keeps the native echo-reference device aligned without moving screen output');
      remoteRouter.setScreenAudioMuted('network-peer', true);
      await waitFor(() => screenSignal.rms() < 0.00001 && voiceSignal.rms() > 0.005,
        'Screen mute affected voice or leaked decoded screen audio');
      check(true, 'Screen opt-out silences real decoded screen audio but preserves voice');
      remoteRouter.setScreenAudioMuted('network-peer', false);
      remoteRouter.setDeafened(true);
      await waitFor(() => voiceSignal.rms() < 0.00001 && otherVoiceSignal.rms() < 0.00001
        && screenSignal.rms() > 0.005, 'Voice deafen affected the selected screen playback');
      check(true, 'Deafen silences both real microphones without silencing the opted-in screen');
      remoteRouter.setDeafened(false);
      remoteRouter.setPeerVolume('network-peer', 50);
      remoteRouter.setScreenAudioVolume('network-peer', 150);
      await waitFor(() => voiceSignal.rms() > 0.002 && screenSignal.rms() > 0.005,
        'Remote audio did not recover after deafen');
      check(voiceGraph.gain.gain.value === 0.5 && screenGraph.gain.gain.value === 1.5
        && voicePlayer.volume === 0, 'Normal and amplified volumes retain the same isolated playback paths');
      remoteRouter.cleanupScreenAudio('network-peer');
      check(remoteRouter.getAudioElement('network-peer') === voicePlayer
        && remoteRouter.getAudioElement('network-other-peer') === otherVoicePlayer,
        'Ending real screen playback keeps both received microphones attached');

      const independentScreen = new RemoteMediaRouter(() => ({ get: () => undefined }));
      const warnings = [];
      const warn = console.warn;
      console.warn = (...args) => { warnings.push(args); warn(...args); };
      try {
        await independentScreen.setOutputDeviceIds('missing-voice-headset', 'available-screen-speakers');
        independentScreen.routeScreenAudioTrack('independent-screen', received.get(toneStreams[2].id));
        independentScreen.getScreenAudioElement('independent-screen').dataset.failSink = 'missing-voice-headset';
        independentScreen.setScreenAudioMuted('independent-screen', false);
        const independentGraph = independentScreen.screenAudioPipelines.get('independent-screen');
        const independentSignal = attachAnalyser(independentGraph);
        await waitFor(() => independentGraph.gain.context.sinkId === 'available-screen-speakers'
          && independentSignal.rms() > 0.005, 'Missing voice headset blocked valid independent screen output');
        check(true, 'A disconnected voice headset does not prevent real received screen audio on available speakers');
        check(warnings.some(args => String(args[0]).includes('voice echo-reference')
          && args[1]?.name === 'NotFoundError'),
          'Voice-reference failure is reported explicitly instead of being silently ignored');
      } finally {
        console.warn = warn;
        independentScreen.closeAllMedia();
      }
    } finally {
      remoteRouter.closeAllMedia();
      transmitter.close();
      receiver.close();
      for (const oscillator of oscillators) oscillator.stop();
      for (const stream of toneStreams) stream.getTracks().forEach(track => track.stop());
    }

    const originalPlay = HTMLMediaElement.prototype.play;
    const boardPlays = [];
    HTMLMediaElement.prototype.play = async function() { boardPlays.push(this); };
    const amplifiedVoice = source.stream.clone();
    const amplifiedScreen = source.stream.clone();
    settings.userVolumes['amplified-peer'] = 150;
    settings.screenAudioVolumes['amplified-peer'] = 175;
    router.ensureVoiceAudioElement('amplified-peer', amplifiedVoice);
    router.routeScreenAudioTrack('amplified-peer', amplifiedScreen.getAudioTracks()[0]);
    router.setScreenAudioMuted('amplified-peer', false);
    await tick();
    const voicePipeline = router.voicePipelines.get('amplified-peer');
    const screenPipeline = router.screenAudioPipelines.get('amplified-peer');
    check(voicePipeline?.gain.context === voiceContext && screenPipeline?.gain.context === screenContext
      && voicePipeline.gain.gain.value === 1.5 && screenPipeline.gain.gain.value === 1.75,
      'Actual playback above 100% uses distinct voice/screen contexts and retains each amplification level');
    router.cleanupPeerMedia('amplified-peer');
    amplifiedVoice.getTracks().forEach(track => track.stop());
    amplifiedScreen.getTracks().forEach(track => track.stop());
    delete settings.userVolumes['amplified-peer'];
    delete settings.screenAudioVolumes['amplified-peer'];
    await devices.selectAudioDevice('output', 'new-general');
    boardPlays.length = 0;
    const boardSink = HTMLMediaElement.prototype.setSinkId;
    let resolvePendingBoard;
    HTMLMediaElement.prototype.setSinkId = async function(id) {
      if (this.src.startsWith('data:audio/')) await new Promise(resolve => { resolvePendingBoard = resolve; });
      return boardSink.call(this, id);
    };
    const incoming = soundboard.handleIncomingSound({
      userId: 'pending-board', soundName: 'pending', audioBase64: 'AA==', mimeType: 'audio/wav',
    });
    for (let attempt = 0; attempt < 100 && !resolvePendingBoard; attempt++) await tick();
    check(Boolean(resolvePendingBoard), 'Soundboard waits for output selection before playing');
    soundboard.stopSoundForUser('pending-board');
    resolvePendingBoard();
    await incoming;
    check(boardPlays.length === 0 && !soundboard.activePlaybacks.has('pending-board'),
      'Stopping a sound during sink selection cannot start a late ghost playback');
    HTMLMediaElement.prototype.setSinkId = boardSink;
    HTMLMediaElement.prototype.play = originalPlay;
    const previousApi = window.api;
    const previousFolder = settings.soundboardFolderPath;
    const { appEvents } = await import('/core/EventBus.ts');
    const loadedFolders = [];
    let shortcutSyncs = 0;
    let resolveOldFolder, rejectOldFolder;
    const latestSounds = [{ name: 'Current', filePath: 'B:\\Current.wav', fileName: 'Current.wav', ext: '.wav', sizeBytes: 16 }];
    window.api = {
      ...previousApi,
      listSoundboardSounds: folder => folder === 'A:\\'
        ? new Promise((resolve, reject) => { resolveOldFolder = resolve; rejectOldFolder = reject; })
        : Promise.resolve(latestSounds),
      registerSoundboardShortcuts: async () => { shortcutSyncs++; return true; },
    };
    const unbindSounds = appEvents.on('soundboard.sounds_loaded', sounds => loadedFolders.push(sounds));
    try {
      for (const outcome of ['resolve', 'reject']) {
        settings.soundboardFolderPath = 'A:\\';
        const oldLoad = soundboard.loadSounds();
        settings.soundboardFolderPath = 'B:\\';
        await soundboard.loadSounds();
        const syncs = shortcutSyncs;
        const emissions = loadedFolders.length;
        if (outcome === 'resolve') resolveOldFolder([{ name: 'Old', filePath: 'A:\\Old.wav' }]);
        else rejectOldFolder(new Error('Old folder was removed'));
        await oldLoad;
        check(soundboard.getSounds() === latestSounds, `An obsolete folder ${outcome} cannot replace the current sound/favorites list`);
        check(shortcutSyncs === syncs && loadedFolders.length === emissions, `An obsolete folder ${outcome} cannot publish events or resync shortcuts`);
      }
    } finally {
      unbindSounds();
      window.api = previousApi;
      settings.soundboardFolderPath = previousFolder;
    }
    chatVideo.remove();
    lightboxVideo.remove();
    await voiceContext.close();
    await screenContext.close();
    await effects.toneCtx.close();
    router.audioContexts.clear();
    effects.toneCtx = null;
    router.audioElements.clear();
    router.screenAudioElements.clear();
    soundboard.activePlaybacks.clear();
    return checks;
  } finally {
    unregister();
    audio.stopMicrophone();
    rtc.peers.clear();
    peerConnections.forEach(pc => pc.close());
    captures.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    source.stream.getTracks().forEach(track => track.stop());
    await context.close();
  }
}
