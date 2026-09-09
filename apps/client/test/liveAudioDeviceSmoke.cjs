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
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
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
    timeout = setTimeout(() => { console.error('Live audio smoke timed out'); void finish(1); }, 45_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__live_audio__`);
    const checks = await window.webContents.executeJavaScript(`(${runLiveAudioDeviceSmoke.toString()})()`, true);
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
    check(audio.rnnoiseNode && audio.analyser && audio.vadInterval && recoveredOutput !== audio.getRawMicrophoneStream().getAudioTracks()[0],
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
    const loadWasm = audio.loadWasmBinary;
    let resolveWasm;
    settings.noiseSuppressionEnabled = true;
    audio.loadWasmBinary = () => new Promise(resolve => { resolveWasm = resolve; });
    const graphAbort = new AbortController();
    const graphPending = devices.selectAudioDevice('input', 'cancel-graph', graphAbort.signal);
    await tick();
    const abandonedContext = audio.audioContext;
    const abandonedDestination = audio.destinationNode.stream;
    graphAbort.abort();
    resolveWasm(null);
    await reject(graphPending, 'AbortError', 'Picker cancellation interrupts asynchronous graph construction');
    check(allStopped(captures.at(-1)) && allStopped(abandonedDestination) && abandonedContext.state === 'closed'
      && !audio.audioContext && !recoverySender.track, 'Cancelled graph releases its raw and destination tracks and context');

    const initialGraph = audio.startMicrophone('superseded-start');
    const initialGraphCheck = reject(initialGraph, 'AbortError', 'Selection supersedes an unfinished startup graph');
    await tick();
    const resolveInitialWasm = resolveWasm;
    const initialRaw = audio.getRawMicrophoneStream();
    audio.loadWasmBinary = loadWasm;
    await devices.selectAudioDevice('input', 'after-initial-graph');
    resolveInitialWasm(null);
    await initialGraphCheck;
    check(allStopped(initialRaw) && audio.rnnoiseNode && recoverySender.track === audio.getLocalAudioStream().getAudioTracks()[0],
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

    // Stub only physical speaker selection; run the real router/effects/soundboard paths.
    const sinkCalls = [];
    const sinkByElement = new WeakMap();
    const sinkByContext = new WeakMap();
    HTMLMediaElement.prototype.setSinkId = async function(id) {
      sinkCalls.push({ element: this, id });
      if (this.dataset.failSink === id) throw new DOMException('Speaker unavailable', 'NotFoundError');
      sinkByElement.set(this, id);
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'sinkId', { configurable: true, get() { return sinkByElement.get(this) ?? ''; } });
    AudioContext.prototype.setSinkId = async function(id) { sinkByContext.set(this, id); };
    const peerAudio = new Audio();
    const screenAudio = new Audio();
    const boardAudio = new Audio();
    const router = rtc.mediaRouter;
    router.audioElements.set('peer', peerAudio);
    router.screenAudioElements.set('peer', screenAudio);
    router.audioContext = new AudioContext();
    effects.toneCtx = new AudioContext();
    soundboard.activePlaybacks.set('board', { audio: boardAudio });
    settings.selectedSpeakerId = '';
    await devices.selectAudioDevice('output', 'speaker');
    const outputs = [peerAudio, screenAudio, boardAudio, ...Object.values(effects.audioMap)];
    check(outputs.every(element => element.sinkId === 'speaker') && settings.selectedSpeakerId === 'speaker',
      'Specific speaker is applied to voice, screen, effects and soundboard before saving');
    check(sinkByContext.get(router.audioContext) === 'speaker' && sinkByContext.get(effects.toneCtx) === 'speaker',
      'Amplified audio and generated tones follow selected output');
    await devices.selectAudioDevice('output', '');
    check(outputs.every(element => element.sinkId === '') && settings.selectedSpeakerId === '', 'Returning to system default resets every active element');
    check(sinkByContext.get(router.audioContext) === '' && sinkByContext.get(effects.toneCtx) === '', 'Default also resets both output AudioContexts');
    screenAudio.dataset.failSink = 'broken-speaker';
    await reject(devices.selectAudioDevice('output', 'broken-speaker'), 'NotFoundError', 'Active sink failure rejects even after preflight succeeds');
    check(settings.selectedSpeakerId === '' && outputs.every(element => element.sinkId === ''), 'Partial speaker switch rolls back all outputs and keeps previous preference');
    check(sinkCalls.some(({ element, id }) => element === peerAudio && id === ''), 'Default is an actual setSinkId call, not a skipped empty ID');
    const outputAbort = new AbortController();
    const peerSetSink = peerAudio.setSinkId;
    peerAudio.setSinkId = async function(id) {
      await peerSetSink.call(this, id);
      if (id === 'cancel-speaker') outputAbort.abort();
    };
    await reject(devices.selectAudioDevice('output', 'cancel-speaker', outputAbort.signal), 'AbortError', 'Closing output picker cancels an awaited sink change');
    check(settings.selectedSpeakerId === '' && outputs.every(element => element.sinkId === ''), 'Cancelled output selection restores active sinks');
    await router.audioContext.close();
    await effects.toneCtx.close();
    router.audioContext = effects.toneCtx = null;
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
