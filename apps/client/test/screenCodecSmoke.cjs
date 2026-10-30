const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `screen-codec-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_SCREEN_CODEC_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_SCREEN_CODEC_PROFILE);
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.on('window-all-closed', () => {});
  let vite, window, worker, sfuManager, router, vp8Router, legacyRouter, timeout;
  const transports = new Map(), producers = new Map(), consumers = new Map();
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    sfuManager?.close();
    worker?.close();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const [{ createServer }, mediasoup, { MessageType }] = await Promise.all([
      import('vite'), import('mediasoup'), import('@monky/shared'),
    ]);
    const { SfuManager } = require(path.join(clientRoot, '..', 'server', 'dist', 'infrastructure', 'sfu', 'SfuManager.js'));
    sfuManager = new SfuManager({ listenIp: '127.0.0.1', announcedIp: '127.0.0.1' });
    router = await sfuManager.getOrCreateRouter('room');
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    legacyRouter = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
    ] });
    vp8Router = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
    ] });
    async function sfuRequest(type, payload) {
      const currentRouter = payload.channelId === 'vp8-room' ? vp8Router
        : payload.channelId === 'legacy-room' ? legacyRouter : router;
      switch (type) {
        case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
          return { channelId: payload.channelId, rtpCapabilities: currentRouter.rtpCapabilities };
        case MessageType.SFU_CREATE_WEBRTC_TRANSPORT: {
          const transport = await currentRouter.createWebRtcTransport({
            listenInfos: [{ protocol: 'udp', ip: '127.0.0.1', port: 0 }],
            enableUdp: true, enableTcp: false,
          });
          transports.set(transport.id, transport);
          return { channelId: payload.channelId, transportOptions: {
            id: transport.id, iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
          } };
        }
        case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
          await transports.get(payload.transportId).connect({ dtlsParameters: payload.dtlsParameters });
          return {};
        case MessageType.SFU_GET_PRODUCERS:
          return { channelId: payload.channelId, participants: [], producers: [] };
        case MessageType.SFU_PRODUCE: {
          const producer = await transports.get(payload.transportId).produce({
            kind: payload.kind, rtpParameters: payload.rtpParameters, appData: payload.appData,
          });
          producers.set(producer.id, producer);
          return { id: producer.id };
        }
        case MessageType.SFU_CONSUME: {
          const mediaType = producers.get(payload.producerId).appData.mediaType;
          const consumer = await transports.get(payload.transportId).consume({
            producerId: payload.producerId, rtpCapabilities: payload.rtpCapabilities,
            paused: mediaType === 'screen_video' || mediaType === 'screen_audio',
          });
          consumers.set(consumer.id, consumer);
          return {
            channelId: payload.channelId, id: consumer.id, producerId: consumer.producerId,
            kind: consumer.kind, rtpParameters: consumer.rtpParameters,
            producerSessionId: 'self', appData: producers.get(payload.producerId).appData,
          };
        }
        case MessageType.SFU_CONSUMER_SET_PAUSED: {
          const consumer = consumers.get(payload.consumerId);
          if (consumer && !consumer.closed) {
            if (payload.paused) await consumer.pause();
            else await consumer.resume();
          }
          return {};
        }
        case MessageType.SFU_CONSUMER_CLOSED:
          consumers.get(payload.consumerId)?.close();
          consumers.delete(payload.consumerId);
          return {};
        case MessageType.SFU_PRODUCER_CLOSED:
          producers.get(payload.producerId)?.close();
          producers.delete(payload.producerId);
          return {};
        case 'fixture.stats': {
          const producer = producers.get(payload.producerId);
          return { codecs: producer.rtpParameters.codecs, stats: await producer.getStats() };
        }
        default: throw new Error(`Unexpected SFU fixture request: ${type}`);
      }
    }
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'screen-codec-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url === '/__screen_codec__') {
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><html><body></body></html>');
            } else if (request.url === '/__screen_codec_sfu__') {
              let body = '';
              request.on('data', chunk => { body += chunk; });
              request.on('end', async () => {
                try {
                  const { type, payload } = JSON.parse(body);
                  const result = await sfuRequest(type, payload);
                  response.setHeader('Content-Type', 'application/json');
                  response.end(JSON.stringify(result));
                } catch (error) {
                  response.statusCode = 500;
                  response.end(JSON.stringify({ error: error.message }));
                }
              });
            } else next();
          });
        },
      }],
    });
    const httpServer = vite.httpServer;
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
    });
    const address = httpServer.address();
    window = new BrowserWindow({
      show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', (_event, _level, message) => {
      if (message.startsWith('CODEC TEST')) console.log(message);
    });
    timeout = setTimeout(() => { console.error('Screen codec smoke timed out'); void finish(1); }, 120000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__screen_codec__`);
    const result = await window.webContents.executeJavaScript(
      `(${runScreenCodecSmoke.toString()})(${JSON.stringify(MessageType)}, ${process.argv.includes('--admission-only')}, ${process.argv.includes('--codecs-only')}, ${process.argv.includes('--h264-profiles-only')}, ${process.argv.includes('--picker-only')})`, true);
    console.log(`Screen codecs: ${result.checks} checks passed; actual output: ${result.outputs.join(', ')}`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runScreenCodecSmoke(MessageType, admissionOnly, codecsOnly, profilesOnly, pickerOnly) {
  const [{ WebRtcManager }, { SfuClientEngine }, { NetworkClient, ProtocolRequestError }, codecs, { settingsStore: settings },
    { voiceStore: voice }, { videoService }, { appEvents }, { VideoDiagnosticsSampler }] = await Promise.all([
    import('/core/WebRtcManager.ts'), import('/core/webrtc/SfuClientEngine.ts'), import('/core/NetworkClient.ts'),
    import('/core/webrtc/codecPreferences.ts'), import('/stores/settingsStore.ts'),
    import('/stores/voiceStore.ts'), import('/core/VideoService.ts'), import('/core/EventBus.ts'),
    import('/core/webrtc/videoDiagnostics.ts'),
  ]);
  let checks = 0;
  const outputs = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (probe, message, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await tick(100);
    }
    throw new Error(message);
  };
  const expectFailure = async (action, message) => {
    let error;
    try { await action(); } catch (reason) { error = reason; }
    check(error instanceof Error, message);
    return error;
  };
  const capabilities = RTCRtpSender.getCapabilities('video').codecs;
  const available = [...new Set(capabilities.filter(codec => !/\/(rtx|red|ulpfec)$/i.test(codec.mimeType)).map(codec => codec.mimeType))];
  console.log('CODEC TEST sender capabilities: ' + available.join(', '));
  const preferenceProbe = new RTCPeerConnection({ iceServers: [] });
  const probeTransceiver = preferenceProbe.addTransceiver('video', { direction: 'sendonly' });
  for (const [name, caps] of [['send', capabilities], ['receive', RTCRtpReceiver.getCapabilities('video').codecs]]) {
    try {
      probeTransceiver.setCodecPreferences(codecs.sortVideoCodecs(caps, true));
      console.log(`CODEC TEST unfiltered ${name} preference accepted`);
    } catch (error) {
      console.log(`CODEC TEST unfiltered ${name} preference rejected: ${error.message}`);
    }
  }
  preferenceProbe.close();
  const selected = available.some(mime => mime.toLowerCase() === 'video/h264') ? 'h264' : 'vp8';
  const required = `video/${selected}`;
  settings.save = () => {};
  settings.qualityPreset = 'NORMAL';
  // The camera has no codec choice since #717: a 60+ FPS preset is what puts H.264 first.
  const preferHardwareCodec = async run => {
    const preset = settings.qualityPreset;
    settings.qualityPreset = 'GAMING';
    try { return await run(); } finally { settings.qualityPreset = preset; }
  };
  voice.setChannel('room');
  const sources = [];
  function source(width = 160, height = 90) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      context.fillStyle = `hsl(${frame++ % 360} 80% 40%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'white'; context.fillText(String(frame), 20, 40);
    };
    draw();
    const stream = canvas.captureStream(10);
    const timer = setInterval(draw, 100);
    const entry = { stream, stop() { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); } };
    sources.push(entry);
    return entry;
  }
  async function actualCodec(sender, label, expected = required, expectedProfile) {
    const first = new Map();
    const sampler = new VideoDiagnosticsSampler();
    const sample = await until(async () => {
      const report = await sender.getStats();
      const diagnostics = sampler.sampleOutbound(sender, report, sender.getParameters(), sender.track?.id);
      for (const stat of report.values()) {
        if (stat.type !== 'outbound-rtp' || stat.kind !== 'video' || stat.active === false
          || !stat.codecId || !(stat.framesEncoded > 0)) continue;
        const codec = report.get(stat.codecId);
        if (!codec || /\/(rtx|red|ulpfec)$/i.test(codec.mimeType)) continue;
        const previous = first.get(stat.id);
        first.set(stat.id, {
          frames: stat.framesEncoded, bytes: stat.bytesSent, codecId: stat.codecId, sourceId: stat.mediaSourceId,
        });
        if (previous && previous.codecId === stat.codecId && previous.sourceId === stat.mediaSourceId
          && stat.framesEncoded > previous.frames && stat.bytesSent > previous.bytes) {
          return {
            codec: codec.mimeType.toLowerCase(), fmtp: codec.sdpFmtpLine, frames: stat.framesEncoded,
            diagnostics: diagnostics.find(sample => sample.id === stat.id),
          };
        }
      }
      return false;
    }, `${label}: no new encoded RTP frames`);
    if (expected && sample.codec !== expected) {
      const snapshots = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        await tick(200);
        const report = await sender.getStats();
        snapshots.push([...report.values()].filter(stat => stat.type === 'outbound-rtp' && stat.kind === 'video').map(stat => ({
          codec: report.get(stat.codecId)?.mimeType, frames: stat.framesEncoded, bytes: stat.bytesSent,
        })));
      }
      console.log('CODEC TEST mismatch details: ' + JSON.stringify({
        label, preset: settings.qualityPreset, expected, snapshots,
        parameters: sender.getParameters().codecs.map(codec => codec.mimeType),
      }));
    }
    check(!expected || sample.codec === expected, `${label}: encoded ${sample.codec}, expected ${expected}`);
    if (expectedProfile) {
      check(profileOf(sample.fmtp) === expectedProfile,
        `${label}: encoded profile ${profileOf(sample.fmtp)}, expected ${expectedProfile}`);
    }
    check(sample.diagnostics?.codec?.toLowerCase() === sample.codec.split('/')[1]
      && sample.diagnostics.fps > 0 && sample.diagnostics.bitrateKbps > 0,
    `${label}: passive diagnostics read the actual codec and positive interval FPS/bitrate: ${JSON.stringify(sample.diagnostics)}`);
    outputs.push(`${label}=${sample.codec}`);
    console.log(`CODEC TEST ${label}: ${sample.codec}, ${sample.frames} encoded frames`);
    return sample.codec;
  }
  /** An owned native share descriptor, without a capture backend behind it. */
  function nativeShare() {
    const stream = new MediaStream();
    videoService.registerNativeScreenShare(stream, {
      desktopSourceId: `native-monitor:fixture-${stream.id}`, captureKind: 'monitor', preserveAspectRatio: true,
      audioBitrateKbps: 128, source: { shareId: stream.id, instanceId: crypto.randomUUID(), audio: false,
        video: { width: 1280, height: 720, fps: 30, maxBitrateKbps: 6000 } },
    });
    return stream;
  }
  const onlyVideoCodec = mime => codecs.getPrioritizedVideoCodecs()
    .filter(codec => [mime, 'video/rtx'].includes(codec.mimeType.toLowerCase()));
  const rtc = new WebRtcManager();
  const store = { serverDetails: { voiceMode: 'p2p' }, currentUser: { id: 'self', sessionId: 'self' } };
  Object.defineProperty(rtc, 'voiceServerStore', { value: store });
  rtc.p2p.rtcConfig = { iceServers: [], iceCandidatePoolSize: 0 };
  rtc.setCurrentSessionId('self');
  let remote, signalQueue = Promise.resolve();
  let remoteEpoch;
  // The loopback peer is not a call participant, nor a Monky client: give its
  // descriptions the connection id every client sends.
  rtc.isPeerInOurCall = () => true;
  const receivePeerSignal = rtc.handleIncomingSignal.bind(rtc);
  rtc.handleIncomingSignal = payload => receivePeerSignal({
    ...payload, ...(payload.signalType === 'offer' || payload.signalType === 'answer'
      ? { subscriptionId: payload.subscriptionId ?? remoteEpoch } : {}),
  });
  const signalErrors = [];
  function setupPeer() {
    remoteEpoch = crypto.randomUUID();
    remote = new RTCPeerConnection({ iceServers: [] });
    remote.ontrack = event => {
      const video = document.createElement('video');
      video.muted = true; video.autoplay = true;
      video.srcObject = new MediaStream([event.track]);
      document.body.appendChild(video);
      void video.play();
    };
    remote.onicecandidate = event => {
      if (event.candidate) void rtc.handleIncomingSignal({
        fromSessionId: 'peer', targetSessionId: 'self', signalType: 'candidate', candidate: event.candidate.toJSON(),
      });
    };
    const transport = {
      getStatus: () => 'CONNECTED',
      send(type, payload) {
        if (type !== MessageType.RTC_SIGNAL || payload.targetSessionId !== 'peer') return;
        signalQueue = signalQueue.then(async () => {
          if (payload.signalType === 'offer') {
            if (remote.signalingState !== 'stable') {
              signalErrors.push('An impolite peer ignored an offer before its own offer was answered');
              return;
            }
            await remote.setRemoteDescription(payload.sdp);
            await remote.setLocalDescription(await remote.createAnswer());
            await rtc.handleIncomingSignal({ fromSessionId: 'peer', targetSessionId: 'self', signalType: 'answer', sdp: remote.localDescription.toJSON() });
          } else if (payload.signalType === 'answer') {
            await remote.setRemoteDescription(payload.sdp);
          } else if (payload.signalType === 'candidate' && remote.remoteDescription) {
            await remote.addIceCandidate(payload.candidate);
          }
        }).catch(error => { signalErrors.push(error.message); });
      },
    };
    Object.defineProperty(rtc, 'signalClient', { configurable: true, value: transport });
  }
  const request = async (type, payload) => {
    const response = await fetch('/__screen_codec_sfu__', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  const client = new NetworkClient();
  client.sendRequest = request;
  client.send = (type, payload) => { void request(type, payload).catch(error => signalErrors.push(error.message)); };
  const sfu = new SfuClientEngine(() => client, () => 'self', {
    onHealthChanged() {}, onRoster() {}, onConsumerTrack() {}, onConsumerClosed() {}, onConnectionFailed() {}, onConnected() {},
  });
  try {
    if (pickerOnly) {
      await testScreenSharePickerLifecycle();
      return { checks, outputs };
    }
    if (admissionOnly) {
      await testRejoinAdmission();
      await testForegroundAdmission();
      await testVoiceKick();
      return { checks, outputs };
    }
    if (selected === 'h264') await preferHardwareCodec(testH264Profiles);
    if (profilesOnly) {
      check(selected === 'h264', 'H.264 must be available for the profile scenarios');
      return { checks, outputs };
    }
    setupPeer();
    remote.addTransceiver('audio', { direction: 'sendrecv' });
    const incomingCamera = source();
    const incomingSender = remote.addTrack(incomingCamera.stream.getVideoTracks()[0], incomingCamera.stream);
    remote.getTransceivers().find(entry => entry.sender === incomingSender).setCodecPreferences(onlyVideoCodec('video/vp8'));
    await rtc.connectToPeer('peer', false);
    rtc.getPeerConnection('peer').addEventListener('track', event => {
      if (event.track.kind !== 'video') return;
      const video = document.createElement('video');
      video.autoplay = video.muted = true;
      video.srcObject = new MediaStream([event.track]);
      document.body.appendChild(video);
      void video.play();
    });
    await remote.setLocalDescription(await remote.createOffer());
    await rtc.handleIncomingSignal({ fromSessionId: 'peer', targetSessionId: 'self', signalType: 'offer', sdp: remote.localDescription.toJSON() });
    await signalQueue;
    await actualCodec(incomingSender, 'Independent incoming camera', 'video/vp8');
    const receiverSampler = new VideoDiagnosticsSampler();
    const receivedDiagnostics = await until(async () => {
      for (const receiver of rtc.getPeerConnection('peer').getReceivers()) {
        if (receiver.track.kind !== 'video') continue;
        const samples = receiverSampler.sampleInbound(receiver, await receiver.getStats(), receiver.track.id);
        const received = samples.find(sample => sample.fps > 0 && sample.bitrateKbps > 0);
        if (received) return received;
      }
      return null;
    }, 'The incoming VP8 camera must decode whatever this side prefers to send');
    check(receivedDiagnostics.codec?.toLowerCase() === 'vp8' && receivedDiagnostics.width === 160
      && receivedDiagnostics.height === 90 && receivedDiagnostics.encodeTimeMs === null,
    'Receiving diagnostics report the decoded remote camera, not local encoder settings');
    await signalQueue;
    rtc.closeAllPeers(); remote.close(); incomingCamera.stop();

    check(await sfu.join('vp8-room'), 'An SFU router without H.264 still connects');
    const fallbackCamera = source();
    try {
      const camera = await preferHardwareCodec(() => sfu.produceCamera(fallbackCamera.stream.getVideoTracks()[0]));
      check(!!camera, 'The SFU publishes a camera the router cannot receive in H.264');
      await actualCodec(camera.rtpSender, 'SFU camera fallback', 'video/vp8');
    } finally {
      sfu.leave();
      fallbackCamera.stop();
    }

    const originalCapture = navigator.mediaDevices.getUserMedia;
    try {
      let resolveCamera;
      let cameraRequests = 0;
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { cameraRequests++; resolveCamera = resolve; });
      const beforeCapture = videoService.startCamera();
      videoService.stopCamera();
      const cancelledBeforeCapture = await expectFailure(() => beforeCapture, 'Camera setup can be cancelled before permission is requested');
      check(cancelledBeforeCapture.name === 'AbortError' && cameraRequests === 0,
        'A stopped camera setup does not request hardware after loading saved effects');
      const pendingCamera = videoService.startCamera();
      for (let attempt = 0; attempt < 200 && !resolveCamera; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      check(typeof resolveCamera === 'function', 'Wait for the actual camera permission boundary before cancelling capture');
      videoService.stopCamera();
      const lateCamera = source();
      resolveCamera(lateCamera.stream);
      const cancelledCamera = await expectFailure(() => pendingCamera, 'A late camera capture is cancelled by mode teardown');
      check(cancelledCamera.name === 'AbortError' && lateCamera.stream.getTracks().every(track => track.readyState === 'ended'),
        'No stale camera track can appear after the clean rejoin');
    } finally {
      navigator.mediaDevices.getUserMedia = originalCapture;
    }
    if (!codecsOnly) {
      await testScreenSharePickerLifecycle();
      await testRejoinAdmission();
      await testForegroundAdmission();
      await testVoiceKick();
    }
    check(signalErrors.length === 0, 'No signaling failures: ' + signalErrors.join('; '));
    return { checks, outputs };
  } catch (error) {
    console.log('CODEC TEST failure: ' + error.message + '; cause: ' + error.cause?.message);
    if (sfu.sendTransport) {
      console.log('CODEC TEST SFU states: ' + JSON.stringify({
        send: sfu.sendTransport.connectionState, receive: sfu.recvTransport?.connectionState, signaling: signalErrors,
        stats: [...(await sfu.sendTransport.getStats()).values()].filter(entry =>
          ['outbound-rtp', 'transport', 'candidate-pair'].includes(entry.type)).map(entry => ({
          type: entry.type, kind: entry.kind, state: entry.state, dtlsState: entry.dtlsState,
          frames: entry.framesEncoded, bytesSent: entry.bytesSent, selectedCandidatePairId: entry.selectedCandidatePairId,
        })),
      }));
    }
    throw error;
  } finally {
    rtc.closeAllPeers(); remote?.close(); sfu.leave(); client.dispose();
    for (const item of sources) item.stop();
    voice.reset();
    appEvents.clear();
  }

  function profileOf(fmtp = '') {
    return /(?:^|;)\s*profile-level-id=([0-9a-f]{6})(?:;|$)/i.exec(fmtp)?.[1].toLowerCase();
  }

  async function testScreenSharePickerLifecycle() {
    const [{ ScreenSharePickerModal }, { webRtcManager: globalRtc }, { callClient }, { openModal }] = await Promise.all([
      import('/views/ScreenSharePickerModal.ts'), import('/core/WebRtcManager.ts'), import('/core/callScope.ts'),
      import('/utils/modalShell.ts'),
    ]);
    const picker = new ScreenSharePickerModal();
    const client = callClient();
    const originalSend = client.send;
    const originalCapture = navigator.mediaDevices.getUserMedia;
    const originalDisplay = navigator.mediaDevices.getDisplayMedia;
    const originalNativeStart = globalRtc.startNativeScreenShare;
    const originalRemove = globalRtc.removeNativeScreenSource;
    const originalScreenCodec = settings.preferredScreenCodec;
    const originalEncodingMode = settings.screenEncodingMode;
    const originalEncodingStrategy = settings.screenEncodingStrategy;
    const originalApi = window.api;
    const originalVideoPreset = videoService.currentPreset;
    const captureWith = handler => {
      navigator.mediaDevices.getUserMedia = handler;
      navigator.mediaDevices.getDisplayMedia = handler;
    };
    const pendingCaptures = [];
    const states = [];
    let acquireNative;
    let selection = 0;
    let browserAcquisitions = 0;
    const nativeSelections = [];
    const encodingProbes = [];
    const mount = async (preserveAspectRatio = true) => {
      picker.close();
      // Only the picker's start controls, in the shell every modal uses; closing it retires the picker as usual.
      const shell = openModal({
        card: '<div class="modal-card"><button id="btn-share">Share</button><button id="btn-share-add">Add</button>'
          + '<button id="btn-cancel">Cancel</button><button id="modal-close">Close</button>'
          + '<input type="hidden" id="chk-share-audio"><p id="share-capture-info"></p>'
          + `<label class="toggle-switch"><input type="checkbox" id="chk-preserve-aspect-ratio" ${preserveAspectRatio ? 'checked' : ''}>`
          + '<span class="toggle-slider"></span></label></div>',
        initialFocus: false,
        onClose: () => picker.teardown(shell),
      });
      const modal = shell.element;
      picker.shell = shell;
      picker.modalEl = modal;
      picker.activeTab = 'screen';
      picker.selectedSourceId = `native-monitor:${String(++selection).padStart(64, '0')}`;
      picker.nativeCapabilities = { capture: true, captureAudio: true, receive: true,
        captureKinds: ['monitor'], backend: 'libobs-amf', reason: null };
      picker.sourceState = { status: 'ready', sources: [
        { id: picker.selectedSourceId, type: 'screen', name: 'Owned fixture display', thumbnailDataUrl: '', appIconDataUrl: null },
      ] };
      return modal;
    };
    const retired = [];
    globalRtc.removeNativeScreenSource = async shareId => { retired.push(shareId); };
    const old = nativeShare();
    voice.addScreenShare(old.id);
    client.send = (type, payload) => { if (type === MessageType.VOICE_STATE_UPDATE) states.push(payload); };
    settings.preferredScreenCodec = 'h264';
    settings.screenEncodingMode = 'hardware';
    settings.screenEncodingStrategy = 'manual';
    window.api = { ...originalApi, platform: 'win32', nativeScreenCommand: async command => {
      encodingProbes.push(command);
      throw new Error('The picker must leave encoder verification to native source admission');
    } };
    videoService.setQualityPreset('NORMAL');
    captureWith(async () => { browserAcquisitions++; throw new Error('The picker must not fall back to Chromium capture.'); });
    globalRtc.startNativeScreenShare = async (desktopSourceId, audio, isWanted, captureKind, preserveAspectRatio) => {
      nativeSelections.push({ desktopSourceId, isWanted, captureKind, preserveAspectRatio });
      check(captureKind === 'monitor' && desktopSourceId === picker.selectedSourceId,
        'The picker forwards exactly the selected native source and method');
      check(typeof preserveAspectRatio === 'boolean'
        && preserveAspectRatio === picker.modalEl.querySelector('#chk-preserve-aspect-ratio').checked,
      'The picker forwards both default fit and explicit stretch without treating OFF as missing');
      const stream = await acquireNative();
      // Deliberately return even an obsolete descriptor to exercise the
      // picker's cleanup independently of the native controller's own guard.
      videoService.registerNativeScreenShare(stream, {
        desktopSourceId, captureKind, preserveAspectRatio, audioBitrateKbps: 128,
        source: { shareId: stream.id, instanceId: crypto.randomUUID(), audio,
          video: { width: 1280, height: 720, fps: 30, maxBitrateKbps: 6000 } },
      });
      return stream;
    };
    try {
      let acquisitions = 0;
      acquireNative = async () => {
        acquisitions++;
        throw new DOMException('Picker cancelled', 'AbortError');
      };
      await mount(false);
      await picker.startSharing('replace');
      check(acquisitions === 1 && videoService.getNativeScreenCapture(old.id) !== null && retired.length === 0
        && voice.screenShareIds.includes(old.id) && states.length === 0 && browserAcquisitions === 0,
      'Cancelling acquisition preserves the existing share and never requests fallback capture');

      acquireNative = () => new Promise(resolve => { pendingCaptures.push(resolve); });
      await mount();
      const abandoned = picker.startSharing('replace');
      await until(() => pendingCaptures.length === 1, 'Old picker waits for acquisition');
      picker.close();
      const currentModal = await mount();
      const current = picker.startSharing('add');
      await until(() => pendingCaptures.length === 2, 'A new picker may start after cancelling the old one');
      const late = new MediaStream();
      pendingCaptures.shift()(late);
      await abandoned;
      check(!videoService.getScreenStream(late.id) && !videoService.getNativeScreenCapture(late.id)
        && retired.includes(late.id) && !nativeSelections[1].isWanted() && nativeSelections[2].isWanted()
        && picker.modalEl === currentModal && picker.isStarting,
        'A stale picker cannot clear the loading state or close its successor');
      const added = new MediaStream();
      pendingCaptures.shift()(added);
      await current;
      check(voice.screenShareIds.includes(old.id) && voice.screenShareIds.includes(added.id)
        && videoService.getNativeScreenCapture(added.id)?.captureKind === 'monitor'
        && !retired.includes(old.id) && !picker.modalEl,
      'The current picker publishes the added share through the common control flow');

      const replacement = new MediaStream();
      acquireNative = async () => replacement;
      states.length = 0;
      await mount();
      await picker.startSharing('replace');
      check(retired.includes(old.id) && retired.includes(added.id) && !retired.includes(replacement.id)
        && !videoService.getScreenStream(old.id) && !videoService.getScreenStream(added.id)
        && !videoService.getNativeScreenCapture(added.id) && videoService.getScreenStream(replacement.id) === replacement
        && videoService.getNativeScreenCapture(replacement.id)?.captureKind === 'monitor'
        && voice.screenShareIds.length === 1 && voice.screenShareIds[0] === replacement.id,
      'Replacing from the picker retires all old native sources but preserves the newly acquired source');
      check(states.length === 1 && states[0].isScreenSharing === true
        && states[0].screenShareIds[0] === replacement.id && states[0].nativeScreenShares[0].shareId === replacement.id,
      'Replacement publishes one final screen state instead of an intermediate sharing=false');
      check(browserAcquisitions === 0, 'Native picker scenarios never request the disabled Chromium path');
      check(encodingProbes.length === 0 && settings.preferredScreenCodec === 'h264'
        && settings.screenEncodingMode === 'hardware' && settings.screenEncodingStrategy === 'manual',
      'The picker leaves saved encoding preferences unchanged and verification to native source admission');
      check(nativeSelections[0].preserveAspectRatio === false
        && nativeSelections.slice(1).every(selection => selection.preserveAspectRatio === true)
        && videoService.getNativeScreenCapture(replacement.id)?.preserveAspectRatio === true,
      'A new picker restores fit after a previous explicit OFF and persists that share choice in its capture metadata');

      // #490: a native-screen:invoke rejection, exactly as Electron delivers it, opens the real error notice
      // with the category in the app's language and none of the technical text.
      const { t } = await import('/i18n/index.ts');
      acquireNative = async () => {
        throw new Error("Error invoking remote method 'native-screen:invoke': Error: Unsafe absolute path"
          + ' [monky-screen-failure {"codes":["ERR_SCREEN_CAPTURE_PATH"]}]');
      };
      await mount();
      const failing = picker.startSharing('replace');
      const notice = await until(() => document.querySelector('.dialog-card .dialog-message'), 'The failure opens the error notice');
      check(notice.textContent === t('screenShare.startFailed', { reason: t('screenShare.failure.files') })
        && !/Error invoking remote method|native-screen|ERR_|Unsafe absolute path|monky-screen-failure/.test(notice.textContent)
        && notice.closest('.dialog-card').textContent.includes(t('screenShare.errorTitle')),
      'A native failure reads as its category in the app language, without the technical text');
      notice.closest('.dialog-card').querySelector('[data-action="confirm"]').click();
      await failing;
      check(voice.screenShareIds.length === 1 && voice.screenShareIds[0] === replacement.id,
        'A failed replacement keeps the share on air');
    } finally {
      picker.close();
      for (const resolve of pendingCaptures) resolve(new MediaStream());
      navigator.mediaDevices.getUserMedia = originalCapture;
      navigator.mediaDevices.getDisplayMedia = originalDisplay;
      globalRtc.startNativeScreenShare = originalNativeStart;
      globalRtc.removeNativeScreenSource = originalRemove;
      settings.preferredScreenCodec = originalScreenCodec;
      settings.screenEncodingMode = originalEncodingMode;
      settings.screenEncodingStrategy = originalEncodingStrategy;
      window.api = originalApi;
      videoService.setQualityPreset(originalVideoPreset);
      client.send = originalSend;
      videoService.stopScreenShare();
      voice.setScreenSharing(false);
    }
  }

  async function testH264Profiles() {
    const nativeProfile = capabilities.find(codec => codec.mimeType.toLowerCase() === 'video/h264'
      && /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(codec.sdpFmtpLine ?? '')
      && ['42001f', '42e01f'].includes(profileOf(codec.sdpFmtpLine)));
    check(!!nativeProfile, 'Runtime exposes a sendable Baseline or Constrained Baseline profile');
    const expectedProfile = profileOf(nativeProfile.sdpFmtpLine);
    const viewerClient = new NetworkClient();
    viewerClient.sendRequest = request;
    viewerClient.send = (type, payload) => { void request(type, payload).catch(error => signalErrors.push(error.message)); };
    const videos = [];
    const viewer = new SfuClientEngine(() => viewerClient, () => 'viewer', {
      onHealthChanged() {}, onRoster() {}, onConsumerClosed() {}, onConnected() {},
      onConnectionFailed(reason) { signalErrors.push(reason); },
      onConsumerTrack({ track }) {
        const video = document.createElement('video');
        video.autoplay = video.muted = true;
        video.srcObject = new MediaStream([track]);
        document.body.append(video);
        videos.push(video);
      },
    });
    const shared = source(640, 360);
    try {
      check(await sfu.join('room'), 'Profile scenarios use the production SFU router');
      const sendProfiles = sfu.device.sendRtpCapabilities.codecs
        .filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
      check(sendProfiles[0].parameters['profile-level-id'] === expectedProfile,
        'SFU preserves native profile order rather than forcing the router first profile');
      const { rtpCapabilities } = await request(MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES, { channelId: 'room' });
      const legacyDevice = new sfu.device.constructor();
      await legacyDevice.load({ routerRtpCapabilities: rtpCapabilities });
      const legacyFirst = legacyDevice.sendRtpCapabilities.codecs.find(codec => codec.mimeType.toLowerCase() === 'video/h264');
      check(legacyFirst.parameters['profile-level-id'] === '42e01f',
        'An older client that uses router order keeps Constrained Baseline');
      check(await viewer.join('room'), 'A separate receiving client joins the real SFU fixture');
      check(JSON.stringify(viewer.device.rtpCapabilities) === JSON.stringify(legacyDevice.rtpCapabilities),
        'Legacy and updated clients negotiate the same receiving capabilities');
      let producer = await sfu.produceCamera(shared.stream.getVideoTracks()[0]);
      await actualCodec(producer.rtpSender, 'SFU native H264 profile', 'video/h264', expectedProfile);
      await viewer.consumeRemoteProducer({
        channelId: 'room', producerId: producer.id, producerSessionId: 'self', kind: 'video',
        appData: { mediaType: 'camera' },
      });
      const receiver = viewer.getConsumerReceiver('self', 'camera');
      check(!!receiver, 'The SFU receiver is created for the selected H264 profile');
      await until(async () => {
        const stats = await receiver.getStats();
        return [...stats.values()].some(stat => stat.type === 'inbound-rtp' && stat.framesDecoded > 0
          && profileOf(stats.get(stat.codecId)?.sdpFmtpLine) === expectedProfile);
      }, 'The selected H264 profile must arrive and decode through the SFU');
      check(true, 'The receiving client decodes actual SFU video with the negotiated profile');
      sfu.closeProducer('camera');

      // Model a negotiated send set without Baseline; do not invent a codec
      // absent from that set just because another machine could accelerate it.
      sfu.device.sendRtpCapabilities.codecs = sfu.device.sendRtpCapabilities.codecs
        .filter(codec => codec.mimeType.toLowerCase() !== 'video/h264'
          || codec.parameters['profile-level-id'] === '42e01f');
      producer = await sfu.produceCamera(shared.stream.getVideoTracks()[0]);
      await actualCodec(producer.rtpSender, 'SFU constrained-only send set', 'video/h264', '42e01f');
      sfu.closeProducer('camera');
      check(shared.stream.getVideoTracks()[0].readyState === 'live', 'Changing producers preserves the capture track');
      check(await sfu.join('legacy-room'), 'The updated client still joins a legacy Constrained-only server');
      producer = await sfu.produceCamera(shared.stream.getVideoTracks()[0]);
      await actualCodec(producer.rtpSender, 'SFU legacy router', 'video/h264', '42e01f');
    } finally {
      sfu.leave();
      viewer.leave();
      viewerClient.dispose();
      shared.stop();
      for (const video of videos) {
        video.pause();
        video.srcObject = null;
        video.remove();
      }
    }
  }

  async function testRejoinAdmission() {
    const [{ rejoinCallOnSession }, { sessionManager }, { audioProcessor: audio }, { webRtcManager: globalRtc }] = await Promise.all([
      import('/core/serverConnection.ts'), import('/core/SessionManager.ts'),
      import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    ]);
    const session = sessionManager.create('voice-rejoin-fixture', 0, 'Alice');
    const visible = sessionManager.create('visible-fixture', 0, 'Bob');
    sessionManager.activate(visible.key);
    const user = { id: 'alice', sessionId: 'alice:desktop', clientId: 'fixture', nickname: 'Alice', status: 'ONLINE', joinedAt: 1 };
    session.serverStore.currentUser = user;
    session.serverStore.serverDetails = { id: 'fixture', name: 'Fixture', voiceMode: 'p2p', channels: [] };
    session.client.getStatus = () => 'CONNECTED';
    session.client.send = () => {};
    session.participants.addUser(user);
    const state = {
      userId: user.id, sessionId: user.sessionId, channelId: 'room',
      isMuted: false, isDeafened: false, serverMuted: true, serverDeafened: true,
      isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
      connectionHealth: 'connected',
    };
    const reply = { channelId: 'room', userId: user.id, sessionId: user.sessionId, user,
      voiceState: state, participants: [{ user, voiceState: state }] };
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const originalCapture = navigator.mediaDevices.getUserMedia;
    const publish = globalRtc.setLocalAudioTrack;
    let captures = 0, publications = 0, resolveJoin;
    let expectedRequest = MessageType.VOICE_RECONNECT;
    session.client.sendRequest = (type, payload) => {
      check(type === expectedRequest && (type !== MessageType.VOICE_RECONNECT || payload.transitionId === 'transition'),
        'Rejoin uses the correct admission contract');
      return new Promise(resolve => { resolveJoin = resolve; });
    };
    settings.noiseSuppressionEnabled = false;
    settings.inputMode = 'voice_activity';
    navigator.mediaDevices.getUserMedia = async () => { captures++; return destination.stream.clone(); };
    globalRtc.setLocalAudioTrack = async track => {
      publications++;
      check(!track.enabled && voice.serverMuted && voice.serverDeafened,
        'Authoritative moderation is applied before microphone publication');
    };
    try {
      voice.reset();
      voice.isMuted = voice.isDeafened = false;
      voice.setChannel('room', session.key);
      const joining = rejoinCallOnSession(session.key, 'room', { transitionId: 'transition', isCurrent: () => true });
      check(captures === 0 && publications === 0, 'No microphone is acquired while admission is unconfirmed');
      resolveJoin(reply);
      await joining;
      check(captures === 1 && publications === 1 && !audio.getRawMicrophoneStream().getAudioTracks()[0].enabled,
        'Clean rejoin acquires a single privacy-gated microphone');
      check(sessionManager.getActiveKey() === visible.key && voice.voiceSessionKey === session.key,
        'Rejoining the background call never migrates it to the visible server');
      audio.stopMicrophone();
      voice.reset();
      voice.setChannel('room', session.key);
      const cancelled = rejoinCallOnSession(session.key, 'room', { transitionId: 'transition', isCurrent: () => true });
      voice.setChannel('different-room', session.key);
      resolveJoin(reply);
      const error = await expectFailure(() => cancelled, 'A new call cancels a late rejoin response');
      check(error.name === 'AbortError' && captures === 1 && publications === 1,
        'A late old admission cannot capture or publish audio into the new call');
      voice.reset();
      voice.setChannel('room', session.key);
      expectedRequest = MessageType.VOICE_JOIN;
      const ordinary = rejoinCallOnSession(session.key, 'room');
      check(globalRtc.voiceReconnectSuspended && captures === 1, 'Ordinary background rejoin also gates transports before admission');
      resolveJoin(reply);
      await ordinary;
      check(captures === 2 && publications === 2, 'Ordinary rejoin publishes only after authoritative moderation');
      const errors = [];
      const offError = appEvents.on('voice.rejoin_failed', error => errors.push(error));
      session.client.sendRequest = async () => { throw new Error('Channel access revoked'); };
      await rejoinCallOnSession(session.key, 'room');
      offError();
      check(!voice.currentVoiceChannelId && !audio.getRawMicrophoneStream() && errors.length === 1,
        'Rejected ordinary rejoin tears down locally and surfaces a failure instead of an unhandled rejection');
    } finally {
      audio.stopMicrophone();
      globalRtc.setLocalAudioTrack = publish;
      navigator.mediaDevices.getUserMedia = originalCapture;
      sessionManager.remove(session.key);
      sessionManager.remove(visible.key);
      voice.reset();
      destination.stream.getTracks().forEach(track => track.stop());
      await context.close();
    }
  }

  // An administrative removal ends the call by the same path as hanging up. A kick that crosses a
  // VOICE_JOIN already on the wire cancels that admission: if the server admits it anyway, the client
  // leaves that room at once instead of staying in it as a ghost, and a new join on the same socket
  // only goes out after that leave.
  async function testVoiceKick() {
    const [{ joinCallOnSession, isVoiceAdmissionPending }, { sessionManager }, { audioProcessor: audio },
      { bindVoiceEvents }, { routeSessionEvent }] = await Promise.all([
      import('/core/serverConnection.ts'), import('/core/SessionManager.ts'), import('/core/AudioProcessor.ts'),
      import('/core/voiceEvents.ts'), import('/core/sessionRouting.ts'),
    ]);
    const session = sessionManager.create('voice-kick-fixture', 0, 'Alice');
    const user = { id: 'alice', sessionId: 'alice:kick', clientId: 'fixture', nickname: 'Alice', status: 'ONLINE', joinedAt: 1 };
    session.serverStore.currentUser = user;
    session.serverStore.serverDetails = { id: 'kick', name: 'Kick', voiceMode: 'p2p', channels: [] };
    session.client.getStatus = () => 'CONNECTED';
    // Everything this socket puts on the wire, in order; requests wait for the test to answer them.
    const sent = [];
    const requests = [];
    session.client.send = (type, payload) => sent.push({ type, payload });
    session.client.sendRequest = (type, payload) => {
      sent.push({ type, payload });
      return new Promise((resolve, reject) => requests.push({ type, payload, resolve, reject }));
    };
    const admitted = channelId => {
      const voiceState = {
        userId: user.id, sessionId: user.sessionId, channelId, isMuted: false, isDeafened: false,
        serverMuted: false, serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false,
        isSharingScreenAudio: false, connectionHealth: 'connected',
      };
      return { channelId, userId: user.id, sessionId: user.sessionId, user, voiceState, participants: [{ user, voiceState }] };
    };
    const wire = () => sent.map(message => message.type);
    session.participants.addUser(user);
    const previousActive = sessionManager.getActiveKey();
    sessionManager.activate(session.key);
    let renders = 0;
    const unbind = bindVoiceEvents({ reconnect: { departed: () => false }, render: () => { renders++; }, rejoinOnScreen() {} });
    try {
      voice.reset();
      const joining = joinCallOnSession(session.key, 'room').catch(error => error);
      await until(() => requests.length === 1, 'The VOICE_JOIN the kick crosses never reached the wire');
      check(requests[0].type === MessageType.VOICE_JOIN && requests[0].payload.channelId === 'room'
        && isVoiceAdmissionPending(session.key, 'room'), 'The kick fixture starts with a VOICE_JOIN on the wire');
      // The server's echo of us in the room.
      session.participants.updateVoiceState(admitted('room').voiceState);
      routeSessionEvent(session.key, `message.${MessageType.ADMIN_KICK_VOICE}`,
        () => appEvents.emit(`message.${MessageType.ADMIN_KICK_VOICE}`, { targetSessionId: user.sessionId }));
      check(!isVoiceAdmissionPending(session.key, 'room') && voice.currentVoiceChannelId === null && voice.voiceSessionKey === null,
        'A voice kick cancels the admission in flight and ends the call');
      check(!session.participants.get(user.sessionId)?.voiceState && renders === 1,
        'A voice kick takes our own row out of the room at once and redraws the server on screen');
      // Entering the room again right away: this join must wait for the one the kick crossed.
      const rejoining = joinCallOnSession(session.key, 'room').catch(error => error);
      await tick(200);
      check(!wire().includes(MessageType.VOICE_LEAVE) && requests.length === 1,
        'Being kicked sends no VOICE_LEAVE, and a new join on the same socket waits for the crossed one');
      // The server admitted the join that crossed the kick.
      requests[0].resolve(admitted('room'));
      check((await joining)?.name === 'AbortError', 'The crossed admission settles as cancelled even though the server admitted it');
      await until(() => requests.length === 2, 'The new join never left after the crossed one settled');
      check(JSON.stringify(wire()) === JSON.stringify([MessageType.VOICE_JOIN, MessageType.VOICE_LEAVE, MessageType.VOICE_JOIN])
        && sent[1].payload.channelId === 'room' && requests[1].payload.channelId === 'room',
      'A join admitted after the kick is left with exactly one VOICE_LEAVE, before the next join goes out');
      requests[1].reject(new Error('fixture: room unavailable'));
      check((await rejoining)?.message === 'fixture: room unavailable', 'The later join settles on its own answer');
    } finally {
      unbind();
      audio.stopMicrophone();
      if (previousActive) sessionManager.activate(previousActive);
      sessionManager.remove(session.key);
      voice.reset();
    }
  }

  async function testForegroundAdmission() {
    const [{ joinCallOnSession }, { sessionManager }, { audioProcessor: audio },
      { webRtcManager: globalRtc }, { soundEffects }, { bindCameraPublication }] = await Promise.all([
      import('/core/serverConnection.ts'), import('/core/SessionManager.ts'),
      import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'), import('/core/SoundEffects.ts'),
      import('/core/CameraPublication.ts'),
    ]);
    const sessions = ['a', 'b'].map(name => {
      const session = sessionManager.create(`voice-admission-${name}`, 0, 'Alice');
      const user = { id: 'alice', sessionId: `alice:${name}`, clientId: 'fixture', nickname: 'Alice', status: 'ONLINE', joinedAt: 1 };
      session.serverStore.currentUser = user;
      session.serverStore.serverDetails = { id: name, name, voiceMode: 'p2p', channels: [] };
      session.client.getStatus = () => 'CONNECTED';
      session.participants.addUser(user);
      return session;
    });
    const [a, b] = sessions;
    const pending = [], messages = [], publications = [], views = [];
    const reply = (session, channelId, serverMuted = false, serverDeafened = false) => {
      const user = session.serverStore.currentUser;
      const voiceState = {
        userId: user.id, sessionId: user.sessionId, channelId, isMuted: voice.isMuted, isDeafened: voice.isDeafened,
        serverMuted, serverDeafened, isSpeaking: false, isCameraOn: false, isScreenSharing: false,
        isSharingScreenAudio: false, connectionHealth: 'connected',
      };
      return { channelId, userId: user.id, sessionId: user.sessionId, user, voiceState, participants: [{ user, voiceState }] };
    };
    for (const session of sessions) {
      session.client.send = (type, payload, requestId) => messages.push({ key: session.key, type, payload, requestId });
      session.client.sendRequest = (type, payload) => {
        check(type === MessageType.VOICE_JOIN, 'Foreground and moved calls await VOICE_JOIN instead of sending it fire-and-forget');
        messages.push({ key: session.key, type, payload });
        return new Promise((resolve, reject) => pending.push({ key: session.key, payload, resolve, reject }));
      };
    }
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const originalCapture = navigator.mediaDevices.getUserMedia;
    const originalPublish = globalRtc.setLocalAudioTrack;
    const originalRemoveScreen = globalRtc.removeNativeScreenSource;
    const originalCue = soundEffects.play;
    let captures = 0, deferCapture = false, resolveCapture;
    navigator.mediaDevices.getUserMedia = () => {
      captures++;
      return deferCapture ? new Promise(resolve => { resolveCapture = resolve; }) : Promise.resolve(destination.stream.clone());
    };
    globalRtc.setLocalAudioTrack = async track => {
      publications.push({ key: voice.voiceSessionKey, channel: voice.currentVoiceChannelId,
        muted: voice.serverMuted, deafened: voice.serverDeafened, enabled: !!track?.enabled, hasTrack: !!track });
      if (track) check(track.enabled === !voice.getEffectiveMuted(),
        'Every published microphone already obeys current manual and server privacy gates');
    };
    soundEffects.play = () => {};
    try {
      const { MainView } = await import('/views/MainView.ts');
      const view = new MainView(document.createElement('div'));
      view.arePermissionsResolved = () => false;
      view.renderChannels = () => {};
      view.updateScreenShareNotice = () => {};
      view.voiceStageView = { setChannel(channelId) { views.push(channelId); } };
      voice.reset();
      voice.setMuted(false);
      voice.setDeafened(false);
      voice.setChannel('room', a.key);
      voice.setServerMuted(true);
      voice.setServerDeafened(true);
      await audio.startMicrophone();
      const oldA = audio.getRawMicrophoneStream();
      const beforeB = captures;
      sessionManager.activate(b.key);
      const enteringB = view.handleJoinVoiceChannel('room');
      check(oldA.getTracks().every(track => track.readyState === 'ended') && !audio.getRawMicrophoneStream(),
        'Foreground A-to-B join stops the old physical microphone synchronously');
      check(globalRtc.voiceReconnectSuspended && voice.voiceSessionKey === b.key
        && !voice.serverMuted && !voice.serverDeafened && !voice.isMuted && !voice.isDeafened,
      'The destination clears only old server moderation, never manual privacy preferences');
      audio.setMuted(false);
      await globalRtc.connectToPeer('announcement-before-admission', true);
      check(captures === beforeB && publications.length === 0 && !globalRtc.getPeerConnection('announcement-before-admission'),
        'PTT/store synchronization and peer announcements cannot open media before admission');
      const previousInputMode = settings.inputMode;
      const speakingDuringAdmission = [];
      const offSpeaking = appEvents.on('local.speaking', active => speakingDuringAdmission.push(active));
      try {
        settings.inputMode = 'push_to_talk';
        audio.applyTrackEnabled();
        audio.handlePttState(true);
        check(!voice.microphoneOpen && !voice.pttPressed && !voice.isSpeaking
          && audio.getInputLevel() === -1 && !speakingDuringAdmission.includes(true)
          && captures === beforeB && publications.length === 0,
        'A requested channel without authoritative admission cannot activate PTT, speaking or microphone activity');
      } finally {
        audio.handlePttState(false);
        settings.inputMode = previousInputMode;
        audio.applyTrackEnabled();
        offSpeaking();
      }
      const replacement = destination.stream.clone();
      const replacementError = await expectFailure(
        () => globalRtc.replaceMicrophoneTrack(replacement.getAudioTracks()[0], new AbortController().signal),
        'A microphone selection cannot bypass pending admission');
      replacement.getTracks().forEach(track => track.stop());
      check(replacementError.name === 'AbortError', 'Microphone replacements share the admission transport gate');
      await until(() => pending.length === 1, 'Foreground join must request admission');
      check(pending[0].key === b.key && messages.some(message => message.key === a.key && message.type === MessageType.VOICE_LEAVE),
        'Cross-server join leaves A and requests only the captured destination B');
      pending.shift().resolve(reply(b, 'room'));
      await enteringB;
      check(publications.at(-1).key === b.key && publications.at(-1).enabled
        && !publications.at(-1).muted && !publications.at(-1).deafened,
      'Unrestricted B does not inherit A moderation despite identical channel IDs');
      check(voice.microphoneOpen && !voice.pttPressed && audio.getInputLevel() >= 0,
        'Microphone activity becomes available only after authoritative admission and live capture');

      voice.setMuted(true);
      sessionManager.activate(a.key);
      const enteringA = view.handleJoinVoiceChannel('room');
      await until(() => pending.length === 1, 'Returning to A must revalidate moderation');
      pending.shift().resolve(reply(a, 'room', true, true));
      await enteringA;
      check(voice.isMuted && settings.isMuted && publications.at(-1).muted && publications.at(-1).deafened
        && !publications.at(-1).enabled, 'A restrictions and manual mute are authoritative before publication');
      sessionManager.activate(b.key);
      const mutedB = view.handleJoinVoiceChannel('room');
      await until(() => pending.length === 1, 'Returning to B must request its own admission');
      pending.shift().resolve(reply(b, 'room'));
      await mutedB;
      check(voice.isMuted && settings.isMuted && !voice.serverMuted && !voice.serverDeafened
        && !publications.at(-1).enabled, 'Leaving a restricted server never clears the user manual mute');

      const retiredScreens = [];
      globalRtc.removeNativeScreenSource = async shareId => { retiredScreens.push(shareId); };
      const screen = nativeShare();
      voice.addScreenShare(screen.id);
      // A published camera, as left by the stage toggle and the publication binding.
      const camera = source();
      const cameraTrack = camera.stream.getVideoTracks()[0];
      Object.assign(videoService, {
        cameraStream: camera.stream, cameraStatus: 'ready', cameraRequested: true, announcedCameraStream: camera.stream,
      });
      globalRtc.localCameraTrack = cameraTrack;
      voice.setCameraOn(true);
      const unbindCameraPublication = bindCameraPublication();
      const beforeMoveMessages = messages.length;
      const beforeMove = views.length;
      let moving;
      try {
        moving = view.rejoinVoiceChannel('moved-room');
        sessionManager.activate(a.key);
        await until(() => pending.length === 1, 'Administrative move must await destination admission');
        check(pending[0].key === b.key && retiredScreens.includes(screen.id)
          && !videoService.getNativeScreenCapture(screen.id) && !voice.isScreenSharing,
        'A move uses the call server and retires native screen sources before admission');
        const moveMessages = messages.slice(beforeMoveMessages);
        const cameraOff = moveMessages.findIndex(message => message.key === b.key
          && message.type === MessageType.VOICE_STATE_UPDATE && message.payload.isCameraOn === false);
        const destinationJoin = moveMessages.findIndex(message => message.type === MessageType.VOICE_JOIN
          && message.payload.channelId === 'moved-room');
        check(cameraTrack.readyState === 'ended' && !voice.isCameraOn && globalRtc.localCameraTrack === null
          && videoService.getCameraState().status === 'idle' && !videoService.getCameraState().publishing,
        'Changing voice channels turns the camera off and drops its cached track before admission');
        check(cameraOff >= 0 && destinationJoin > cameraOff,
          'The old room is told the camera is off before the destination admission is requested');
        pending.shift().resolve(reply(b, 'moved-room', true));
        await moving;
      } finally {
        unbindCameraPublication();
      }
      check(!voice.isCameraOn && globalRtc.localCameraTrack === null && videoService.getCameraStream() === null,
        'Admission into the destination never republishes the previous room camera');
      check(voice.voiceSessionKey === b.key && voice.currentVoiceChannelId === 'moved-room'
        && sessionManager.getActiveKey() === a.key && views.length === beforeMove,
      'A delayed foreground rejoin never changes the newly visible server stage');

      voice.setMuted(false);
      const beforeDuplicates = publications.length;
      const first = joinCallOnSession(a.key, 'room');
      const firstResult = first.then(() => null, error => error);
      await until(() => pending.length === 1, 'First repeated admission must reach the server');
      const second = joinCallOnSession(a.key, 'room');
      await tick(0);
      check(pending.length === 1, 'Same-socket admissions are serialized, even for the same channel');
      pending.shift().resolve(reply(a, 'room'));
      await until(() => pending.length === 1, 'Latest admission must continue after the previous response');
      check((await firstResult)?.name === 'AbortError' && publications.length === beforeDuplicates,
        'An older same-channel response cannot reopen the microphone');
      pending.shift().resolve(reply(a, 'room', true));
      await second;
      check(publications.length === beforeDuplicates + 1 && publications.at(-1).muted
        && !publications.at(-1).enabled, 'Only the latest same-channel admission can publish its moderation state');

      const oldRequest = joinCallOnSession(a.key, 'other-room');
      const oldResult = oldRequest.then(() => null, error => error);
      await until(() => pending.length === 1, 'Old admission must be pending before a new server is selected');
      const oldPending = pending.shift();
      const newRequest = joinCallOnSession(b.key, 'room');
      await until(() => pending.length === 1, 'A different server must not wait on the abandoned server');
      pending.shift().resolve(reply(b, 'room'));
      await newRequest;
      const liveB = audio.getRawMicrophoneStream();
      oldPending.reject(new Error('Old server access was revoked'));
      check((await oldResult)?.name === 'AbortError' && voice.voiceSessionKey === b.key
        && audio.getRawMicrophoneStream() === liveB && liveB.getTracks().every(track => track.readyState === 'live'),
      'A late rejected admission cannot tear down the newer call');

      // Moved twice before the first join was answered (#841): each join names the move it follows,
      // and one the server refuses as overtaken leaves no leave behind to end the later call.
      const { rejoinCallOnSession } = await import('/core/serverConnection.ts');
      const beforeMoves = messages.length;
      const firstMove = rejoinCallOnSession(b.key, 'visible-room', undefined, 'move-1');
      await until(() => pending.length === 1, 'The first move must request admission');
      const overtaken = pending.shift();
      check(overtaken.payload.channelId === 'visible-room' && overtaken.payload.moveId === 'move-1',
        'A join following a move names it');
      const secondMove = rejoinCallOnSession(b.key, 'hidden-room', undefined, 'move-2');
      overtaken.reject(new ProtocolRequestError('A movimentação foi substituída por outra.', 'VOICE_MOVE_SUPERSEDED'));
      await until(() => pending.length === 1, 'The second move must request admission once the first is answered');
      check(pending[0].payload.channelId === 'hidden-room' && pending[0].payload.moveId === 'move-2',
        'The later join names the later move');
      pending.shift().resolve(reply(b, 'hidden-room'));
      await Promise.all([firstMove, secondMove]);
      check(!messages.slice(beforeMoves).some(message => message.type === MessageType.VOICE_LEAVE),
        'An overtaken join the server refused is followed by no leave');
      check(voice.voiceSessionKey === b.key && voice.currentVoiceChannelId === 'hidden-room'
        && audio.getRawMicrophoneStream()?.getAudioTracks()[0].readyState === 'live',
      'The call ends up in the room of the last move');
      const ordinaryJoin = joinCallOnSession(b.key, 'room');
      await until(() => pending.length === 1, 'A join of its own must request admission');
      check(!('moveId' in pending[0].payload), 'A join of its own names no move');
      pending.shift().resolve(reply(b, 'room'));
      await ordinaryJoin;

      sessionManager.activate(a.key);
      deferCapture = true;
      const lateCaptureJoin = view.handleJoinVoiceChannel('room');
      await until(() => pending.length === 1, 'The old foreground call must await admission');
      pending.shift().resolve(reply(a, 'room', true));
      await until(() => resolveCapture, 'Microphone capture should start only after the old admission');
      const finishOldCapture = resolveCapture;
      const lateStream = destination.stream.clone();
      const beforeNewCapture = publications.length;
      deferCapture = false;
      sessionManager.activate(b.key);
      const latestForeground = view.handleJoinVoiceChannel('room');
      await until(() => pending.length === 1, 'A newer foreground call must acquire a separate admission');
      pending.shift().resolve(reply(b, 'room'));
      await latestForeground;
      const latestRaw = audio.getRawMicrophoneStream();
      finishOldCapture(lateStream);
      await lateCaptureJoin;
      check(lateStream.getTracks().every(track => track.readyState === 'ended')
        && audio.getRawMicrophoneStream() === latestRaw && latestRaw.getTracks().every(track => track.readyState === 'live')
        && publications.length === beforeNewCapture + 1 && publications.at(-1).key === b.key,
      'A late old getUserMedia result is stopped without disturbing the newer foreground call');

      // A switch the server turns away, such as into a room that filled up meanwhile, keeps the call in
      // the room it came from: the server still holds the session there.
      const { t } = await import('/i18n/index.ts');
      const afkToastShown = () => [...document.querySelectorAll('.chat-copy-toast')]
        .some(toast => toast.textContent.includes(t('afk.leftMutedToast')));
      const beforeRefusal = messages.length;
      const refusedSwitch = joinCallOnSession(b.key, 'full-room');
      const refusedResult = refusedSwitch.then(() => null, error => error);
      await until(() => pending.length === 1, 'The switch to a full room must request admission');
      pending.shift().reject(new ProtocolRequestError('Este canal de voz está cheio.', 'CHANNEL_FULL'));
      await until(() => pending.length === 1, 'A refused switch must ask to go back to the room it came from');
      check(pending[0].key === b.key && pending[0].payload.channelId === 'room'
        && !messages.slice(beforeRefusal).some(message => message.type === MessageType.VOICE_LEAVE),
      'A refused switch returns to the previous room instead of leaving the call');
      pending.shift().resolve(reply(b, 'room'));
      const refusal = await refusedResult;
      check(refusal?.code === 'CHANNEL_FULL' && voice.voiceSessionKey === b.key && voice.currentVoiceChannelId === 'room'
        && audio.getRawMicrophoneStream()?.getAudioTracks()[0].readyState === 'live' && publications.at(-1).key === b.key,
      'The member keeps the call, with a live microphone, and still learns that the room was full');

      // Out of the AFK room, arriving muted is part of the request; a refused exit keeps the member
      // there with their own mute untouched, and only an admitted one mutes them and says so.
      const plainB = b.serverStore.serverDetails;
      b.serverStore.serverDetails = { ...plainB, afkChannelId: 'afk',
        protocol: { version: 1, minimumVersion: 1, features: ['afk-channel'] } };
      voice.setMuted(false);
      const intoAfk = joinCallOnSession(b.key, 'afk');
      await until(() => pending.length === 1, 'The AFK room must request admission');
      pending.shift().resolve(reply(b, 'afk', true));
      await intoAfk;
      const refusedExit = joinCallOnSession(b.key, 'full-room');
      const refusedExitResult = refusedExit.then(() => null, error => error);
      await until(() => pending.length === 1, 'Leaving the AFK room must request admission');
      check(pending[0].payload.channelId === 'full-room' && pending[0].payload.isMuted === true,
        'Leaving the AFK room asks to arrive muted');
      pending.shift().reject(new ProtocolRequestError('Este canal de voz está cheio.', 'CHANNEL_FULL'));
      await until(() => pending.length === 1, 'A refused exit must ask to go back to the AFK room');
      check(pending[0].payload.channelId === 'afk', 'A refused exit returns to the AFK room');
      pending.shift().resolve(reply(b, 'afk', true));
      check((await refusedExitResult)?.code === 'CHANNEL_FULL' && voice.currentVoiceChannelId === 'afk'
        && !voice.isMuted && !afkToastShown(), 'A refused exit keeps the member in the AFK room without touching their own mute');
      const exit = joinCallOnSession(b.key, 'room');
      await until(() => pending.length === 1, 'Leaving the AFK room for a free room must request admission');
      pending.shift().resolve(reply(b, 'room'));
      await exit;
      check(voice.currentVoiceChannelId === 'room' && voice.isMuted && settings.isMuted && !publications.at(-1).enabled
        && afkToastShown(), 'Arriving from the AFK room keeps the microphone muted until the member unmutes it');
      b.serverStore.serverDetails = plainB;
      voice.setMuted(false);

      // When even the way back is refused, the call ends as before instead of lingering in either room.
      const beforeDoubleRefusal = messages.length;
      const doublyRefused = joinCallOnSession(b.key, 'full-room');
      const doublyRefusedResult = doublyRefused.then(() => null, error => error);
      await until(() => pending.length === 1, 'The double refusal must request admission');
      pending.shift().reject(new ProtocolRequestError('Este canal de voz está cheio.', 'CHANNEL_FULL'));
      await until(() => pending.length === 1, 'The double refusal must try the previous room');
      pending.shift().reject(new ProtocolRequestError('Canal não encontrado', 'CHANNEL_NOT_FOUND'));
      check((await doublyRefusedResult)?.code === 'CHANNEL_FULL' && !voice.currentVoiceChannelId && !audio.getRawMicrophoneStream()
        && messages.slice(beforeDoubleRefusal).some(message => message.key === b.key
          && message.type === MessageType.VOICE_LEAVE && message.payload.channelId === 'room'),
      'If the previous room refuses too, the call ends without lingering in either room');

      const invalid = joinCallOnSession(a.key, 'room');
      const invalidResult = invalid.then(() => null, error => error);
      await until(() => pending.length === 1, 'Invalid-response test must request admission');
      const missingFlags = reply(a, 'room');
      delete missingFlags.voiceState.serverMuted;
      pending.shift().resolve(missingFlags);
      check((await invalidResult) instanceof Error && !voice.currentVoiceChannelId && !audio.getRawMicrophoneStream(),
        'A response without authoritative moderation flags fails closed');

      const left = joinCallOnSession(a.key, 'room');
      const leftResult = left.then(() => null, error => error);
      await until(() => pending.length === 1, 'Leave test must have a pending admission');
      const beforeLeaveResponse = captures;
      audio.stopMicrophone();
      globalRtc.closeAllPeers();
      voice.reset();
      pending.shift().resolve(reply(a, 'room', true));
      check((await leftResult)?.name === 'AbortError' && captures === beforeLeaveResponse
        && !voice.currentVoiceChannelId, 'Intentional leave cancels pending admission without reopening any capture');

      const queuedRequest = a.client.sendRequest;
      const previousSocket = a.client.ws;
      a.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
      a.client.sendRequest = NetworkClient.prototype.sendRequest;
      try {
        const firstMessage = messages.length;
        const beforeCorrelatedAdmission = captures;
        const correlatedJoin = joinCallOnSession(a.key, 'room');
        const wireRequest = await until(
          () => messages.slice(firstMessage).find(message => message.type === MessageType.VOICE_JOIN && message.requestId),
          'The real NetworkClient must send a correlated voice request');
        a.client.handleIncomingMessage({ type: MessageType.VOICE_USER_JOINED, payload: reply(a, 'room') });
        await tick(0);
        check(captures === beforeCorrelatedAdmission && globalRtc.voiceReconnectSuspended,
          'An uncorrelated own broadcast cannot release the real NetworkClient admission request');
        a.client.handleIncomingMessage({ type: MessageType.VOICE_USER_JOINED,
          requestId: wireRequest.requestId, payload: reply(a, 'room', true) });
        await correlatedJoin;
        check(publications.at(-1).muted && !publications.at(-1).enabled
          && a.client.pendingRequests.size === 0,
        'Only the final correlated own response admits media and clears the request timer');
      } finally {
        a.client.sendRequest = queuedRequest;
        a.client.ws = previousSocket;
      }

      deferCapture = true;
      resolveCapture = null;
      const restrictedDuringCapture = joinCallOnSession(a.key, 'room');
      await until(() => pending.length === 1, 'Moderation race must await admission');
      pending.shift().resolve(reply(a, 'room'));
      await until(() => resolveCapture, 'Moderation race must have deferred microphone capture');
      voice.setServerMuted(true);
      audio.setMuted(voice.getEffectiveMuted());
      resolveCapture(destination.stream.clone());
      deferCapture = false;
      await restrictedDuringCapture;
      check(publications.at(-1).muted && !publications.at(-1).enabled
        && !audio.getRawMicrophoneStream().getAudioTracks()[0].enabled,
      'Moderation received after admission but before capture completion still gates every audio track');

      deferCapture = true;
      resolveCapture = null;
      const deviceSelectionJoin = joinCallOnSession(a.key, 'device-room');
      await until(() => pending.length === 1, 'Microphone-selection race must await admission');
      pending.shift().resolve(reply(a, 'device-room', true));
      await until(() => resolveCapture, 'Initial microphone must be pending before selecting a device');
      const finishSupersededCapture = resolveCapture;
      const supersededStream = destination.stream.clone();
      deferCapture = false;
      const selectedDevice = audio.switchMicrophone('fixture-device',
        (track, signal) => globalRtc.replaceMicrophoneTrack(track, signal));
      finishSupersededCapture(supersededStream);
      await Promise.all([deviceSelectionJoin, selectedDevice]);
      check(voice.currentVoiceChannelId === 'device-room' && voice.voiceSessionKey === a.key
        && supersededStream.getTracks().every(track => track.readyState === 'ended')
        && audio.getRawMicrophoneStream()?.getAudioTracks()[0].readyState === 'live'
        && !audio.getRawMicrophoneStream().getAudioTracks()[0].enabled,
      'Selecting a microphone can supersede initial capture without cancelling an admitted, moderated call');

      const manualChange = joinCallOnSession(b.key, 'manual-room');
      await until(() => pending.length === 1, 'Manual-privacy race must wait for admission');
      voice.setMuted(true);
      const olderManualState = reply(b, 'manual-room');
      olderManualState.voiceState.isMuted = false;
      pending.shift().resolve(olderManualState);
      await manualChange;
      check(voice.isMuted && settings.isMuted && !publications.at(-1).enabled
        && b.participants.get(b.serverStore.currentUser.sessionId)?.voiceState.isMuted
        && messages.some(message => message.key === b.key && message.type === MessageType.VOICE_STATE_UPDATE
          && message.payload.isMuted === true && message.payload.isDeafened === false),
      'A manual mute changed during admission is preserved locally and resynchronized to the admitted server');

      const microphoneErrors = [];
      const offMicrophoneError = appEvents.on('voice.microphone_failed', error => microphoneErrors.push(error));
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Fixture microphone permission denied', 'NotAllowedError'); };
      const receiveOnly = joinCallOnSession(b.key, 'room');
      await until(() => pending.length === 1, 'Receive-only call must still be admitted');
      pending.shift().resolve(reply(b, 'room'));
      await receiveOnly;
      offMicrophoneError();
      check(voice.voiceSessionKey === b.key && voice.currentVoiceChannelId === 'room'
        && !audio.getRawMicrophoneStream() && !publications.at(-1).hasTrack && microphoneErrors.length === 1,
      'Microphone failure preserves admitted receive-only behavior and surfaces a meaningful error');
    } finally {
      audio.stopMicrophone();
      globalRtc.closeAllPeers();
      globalRtc.setLocalAudioTrack = originalPublish;
      navigator.mediaDevices.getUserMedia = originalCapture;
      soundEffects.play = originalCue;
      globalRtc.removeNativeScreenSource = originalRemoveScreen;
      videoService.stopScreenShare();
      for (const session of sessions) sessionManager.remove(session.key);
      voice.reset();
      destination.stream.getTracks().forEach(track => track.stop());
      await context.close();
    }
  }
}
