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
  let vite, window, worker, router, vp8Router, timeout;
  const transports = new Map(), producers = new Map();
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    worker?.close();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const [{ createServer }, mediasoup, { MessageType }] = await Promise.all([
      import('vite'), import('mediasoup'), import('@monky/shared'),
    ]);
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    router = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/AV1', clockRate: 90000 },
      { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0 } },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
      { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
    ] });
    vp8Router = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
    ] });
    async function sfuRequest(type, payload) {
      const currentRouter = payload.channelId === 'vp8-room' ? vp8Router : router;
      switch (type) {
        case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
          return { channelId: payload.channelId, rtpCapabilities: currentRouter.rtpCapabilities };
        case MessageType.SFU_CREATE_WEBRTC_TRANSPORT: {
          const transport = await currentRouter.createWebRtcTransport({
            listenInfos: [{ protocol: 'udp', ip: '127.0.0.1', port: 0 }],
            enableUdp: true, enableTcp: false,
          });
          transports.set(transport.id, transport);
          return { channelId: 'room', transportOptions: {
            id: transport.id, iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
          } };
        }
        case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
          await transports.get(payload.transportId).connect({ dtlsParameters: payload.dtlsParameters });
          return {};
        case MessageType.SFU_GET_PRODUCERS:
          return { channelId: 'room', participants: [], producers: [] };
        case MessageType.SFU_PRODUCE: {
          const producer = await transports.get(payload.transportId).produce({
            kind: payload.kind, rtpParameters: payload.rtpParameters, appData: payload.appData,
          });
          producers.set(producer.id, producer);
          return { id: producer.id };
        }
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
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
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
      `(${runScreenCodecSmoke.toString()})(${JSON.stringify(MessageType)}, ${process.argv.includes('--admission-only')}, ${process.argv.includes('--codecs-only')})`, true);
    console.log(`Screen codecs: ${result.checks} checks passed; actual output: ${result.outputs.join(', ')}`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runScreenCodecSmoke(MessageType, admissionOnly, codecsOnly) {
  const [{ WebRtcManager }, { SfuClientEngine }, { NetworkClient }, codecs, { settingsStore: settings },
    { voiceStore: voice }, { videoService }, { appEvents }] = await Promise.all([
    import('/core/WebRtcManager.ts'), import('/core/webrtc/SfuClientEngine.ts'), import('/core/NetworkClient.ts'),
    import('/core/webrtc/codecPreferences.ts'), import('/stores/settingsStore.ts'),
    import('/stores/voiceStore.ts'), import('/core/VideoService.ts'), import('/core/EventBus.ts'),
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
      probeTransceiver.setCodecPreferences(codecs.sortVideoCodecs(caps, 'h264'));
      console.log(`CODEC TEST unfiltered ${name} preference accepted`);
    } catch (error) {
      console.log(`CODEC TEST unfiltered ${name} preference rejected: ${error.message}`);
    }
  }
  preferenceProbe.close();
  const selected = available.some(mime => mime.toLowerCase() === 'video/h264') ? 'h264' : 'vp8';
  const required = `video/${selected}`;
  settings.save = () => {};
  settings.preferredVideoCodec = selected;
  settings.qualityPreset = 'NORMAL';
  voice.setChannel('room');
  const sources = [];
  function source() {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 90;
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
  async function actualCodec(sender, label, expected = required) {
    const first = new Map();
    const sample = await until(async () => {
      const report = await sender.getStats();
      for (const stat of report.values()) {
        if (stat.type !== 'outbound-rtp' || stat.kind !== 'video' || !stat.codecId || !(stat.framesEncoded > 0)) continue;
        const codec = report.get(stat.codecId);
        if (!codec || /\/(rtx|red|ulpfec)$/i.test(codec.mimeType)) continue;
        const previous = first.get(stat.id);
        first.set(stat.id, { frames: stat.framesEncoded, bytes: stat.bytesSent });
        if (previous && stat.framesEncoded > previous.frames && stat.bytesSent > previous.bytes) {
          return { codec: codec.mimeType.toLowerCase(), frames: stat.framesEncoded };
        }
      }
      return false;
    }, `${label}: no new encoded RTP frames`);
    if (expected && sample.codec !== expected) {
      const pc = rtc.getPeerConnection('peer');
      const mid = pc?.getTransceivers().find(entry => entry.sender === sender)?.mid;
      const snapshots = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        await tick(200);
        const report = await sender.getStats();
        snapshots.push([...report.values()].filter(stat => stat.type === 'outbound-rtp' && stat.kind === 'video').map(stat => ({
          codec: report.get(stat.codecId)?.mimeType, frames: stat.framesEncoded, bytes: stat.bytesSent,
        })));
      }
      console.log('CODEC TEST mismatch details: ' + JSON.stringify({
        label, selected: settings.preferredVideoCodec, expected, mid, snapshots,
        local: pc?.currentLocalDescription && codecs.getSdpVideoCodecOrder(pc.currentLocalDescription.sdp, mid),
        remote: pc?.currentRemoteDescription && codecs.getSdpVideoCodecOrder(pc.currentRemoteDescription.sdp, mid),
        parameters: sender.getParameters().codecs.map(codec => codec.mimeType),
      }));
    }
    check(!expected || sample.codec === expected, `${label}: encoded ${sample.codec}, expected ${expected}`);
    outputs.push(`${label}=${sample.codec}`);
    console.log(`CODEC TEST ${label}: ${sample.codec}, ${sample.frames} encoded frames`);
    return sample.codec;
  }
  const rtc = new WebRtcManager();
  const failShare = rtc.failLocalScreenShare.bind(rtc);
  rtc.failLocalScreenShare = (shareId, error, notify, renegotiate) => {
    const sender = rtc.getScreenSendersForShare(shareId)[0];
    const pc = rtc.getPeerConnection('peer');
    const transceiver = pc?.getTransceivers().find(entry => entry.sender === sender);
    console.log('CODEC TEST failed screen negotiation: ' + JSON.stringify({
      error: error.message, currentDirection: transceiver?.currentDirection, direction: transceiver?.direction,
      mid: transceiver?.mid, codecs: sender?.getParameters().codecs.map(codec => codec.mimeType),
    }));
    return failShare(shareId, error, notify, renegotiate);
  };
  const store = { serverDetails: { voiceMode: 'p2p' }, currentUser: { id: 'self', sessionId: 'self' } };
  Object.defineProperty(rtc, 'voiceServerStore', { value: store });
  rtc.rtcConfig = { iceServers: [], iceCandidatePoolSize: 0 };
  rtc.setCurrentSessionId('self');
  let remote, signalQueue = Promise.resolve();
  let beforeAnswer = async () => {};
  const signalErrors = [];
  const sentDescriptions = [];
  function setupPeer() {
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
      send(type, payload) {
        if (type !== MessageType.RTC_SIGNAL || payload.targetSessionId !== 'peer') return;
        if (payload.signalType === 'offer' || payload.signalType === 'answer') {
          sentDescriptions.push({ type: payload.signalType, sdpType: payload.sdp?.type });
        }
        signalQueue = signalQueue.then(async () => {
          if (payload.signalType === 'offer') {
            if (remote.signalingState !== 'stable') {
              signalErrors.push('An impolite peer ignored an offer before its own offer was answered');
              return;
            }
            await remote.setRemoteDescription(payload.sdp);
            await remote.setLocalDescription(await remote.createAnswer());
            await beforeAnswer();
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
    if (admissionOnly) {
      await testRejoinAdmission();
      await testForegroundAdmission();
      return { checks, outputs };
    }
    if (selected === 'h264') {
      const oldSender = new RTCPeerConnection({ iceServers: [] });
      const oldReceiver = new RTCPeerConnection({ iceServers: [] });
      const senderCandidates = [], receiverCandidates = [];
      oldSender.onicecandidate = event => { if (event.candidate) senderCandidates.push(event.candidate.toJSON()); };
      oldReceiver.onicecandidate = event => { if (event.candidate) receiverCandidates.push(event.candidate.toJSON()); };
      const oldScreen = source();
      try {
        const transceiver = oldSender.addTransceiver(oldScreen.stream.getVideoTracks()[0], { direction: 'sendonly', streams: [oldScreen.stream] });
        transceiver.setCodecPreferences(codecs.sortVideoCodecs(RTCRtpReceiver.getCapabilities('video').codecs, 'h264'));
        await oldSender.setLocalDescription(await oldSender.createOffer());
        check(codecs.getSdpVideoCodecOrder(oldSender.localDescription.sdp)[0] === 'h264', 'Legacy offer really preferred H.264');
        await oldReceiver.setRemoteDescription(oldSender.localDescription);
        oldReceiver.getTransceivers()[0].setCodecPreferences(codecs.getScreenVideoCodecs('av1'));
        await oldReceiver.setLocalDescription(await oldReceiver.createAnswer());
        await oldSender.setRemoteDescription(oldReceiver.localDescription);
        await tick(200);
        for (const candidate of senderCandidates) await oldReceiver.addIceCandidate(candidate);
        for (const candidate of receiverCandidates) await oldSender.addIceCandidate(candidate);
        await actualCodec(transceiver.sender, 'Legacy preferred-H264 fallback', 'video/av1');
      } finally {
        oldSender.close(); oldReceiver.close(); oldScreen.stop();
      }
    }
    setupPeer();
    await rtc.connectToPeer('peer', true);
    await signalQueue;
    const first = source();
    await rtc.addLocalScreenTrack(first.stream);
    await actualCodec(rtc.getScreenSendersForShare(first.stream.id)[0], 'P2P initial');
    settings.preferredVideoCodec = 'av1';
    await rtc.reapplyCodecPreferences();
    await actualCodec(rtc.getScreenSendersForShare(first.stream.id)[0], 'P2P live AV1', 'video/av1');
    settings.preferredVideoCodec = selected;
    await rtc.reapplyCodecPreferences();
    await actualCodec(rtc.getScreenSendersForShare(first.stream.id)[0], 'P2P live explicit');
    for (const preferred of ['vp8', 'vp9', 'auto', selected]) {
      settings.preferredVideoCodec = preferred;
      await rtc.reapplyCodecPreferences();
      const sender = rtc.getScreenSendersForShare(first.stream.id)[0];
      const expected = preferred === 'auto' ? null : `video/${preferred}`;
      check(sender.getParameters().encodings.every(encoding => encoding.active
        && (expected ? encoding.codec?.mimeType.toLowerCase() === expected : encoding.codec === undefined)),
        `${preferred}: live encoder selection is explicit, and Automatic removes the previous pin`);
      await actualCodec(sender, `P2P live ${preferred}`, expected);
    }
    let releaseAnswer;
    const delayedAnswer = new Promise(resolve => { releaseAnswer = resolve; });
    let answerHeld = false;
    beforeAnswer = async () => {
      if (answerHeld) return;
      answerHeld = true;
      await delayedAnswer;
    };
    try {
      settings.preferredVideoCodec = 'av1';
      const firstChange = rtc.reapplyCodecPreferences();
      await until(() => answerHeld, 'AV1 negotiation should reach its pending answer');
      check(rtc.getPeerConnection('peer').signalingState === 'have-local-offer',
        'Rapid selection regression holds a real outstanding AV1 offer');
      const sender = rtc.getScreenSendersForShare(first.stream.id)[0];
      check(sender.getParameters().encodings.every(encoding => !encoding.active && !encoding.codec),
        'Screen encoding is paused and its old codec unpinned while negotiation is pending');
      await rtc.applyBitrateConstraints();
      check(sender.getParameters().encodings.every(encoding => !encoding.active),
        'A concurrent quality update cannot resume a screen before its codec is applied');
      const encodedFrames = async () => {
        const stats = await sender.getStats();
        return [...stats.values()].filter(stat => stat.type === 'outbound-rtp' && stat.kind === 'video')
          .reduce((total, stat) => total + (stat.framesEncoded ?? 0), 0);
      };
      await tick(150);
      const framesBefore = await encodedFrames();
      await tick(300);
      check(await encodedFrames() === framesBefore && first.stream.getVideoTracks()[0].readyState === 'live',
        'Pending codec negotiation emits no new encoded frames without stopping capture');
      settings.preferredVideoCodec = selected;
      const latestChange = rtc.reapplyCodecPreferences();
      releaseAnswer();
      await Promise.all([firstChange, latestChange]);
      check(first.stream.getVideoTracks()[0].readyState === 'live' && rtc.localScreenTracks.has(first.stream.id),
        'A superseded compatible answer cannot terminate the screen capture');
      await actualCodec(rtc.getScreenSendersForShare(first.stream.id)[0], 'P2P rapid latest selection');
    } finally {
      releaseAnswer();
      beforeAnswer = async () => {};
      settings.preferredVideoCodec = selected;
    }
    const screenSender = rtc.getScreenSendersForShare(first.stream.id)[0];
    const localScreen = rtc.getPeerConnection('peer').getTransceivers().find(entry => entry.sender === screenSender);
    check(localScreen.direction === 'sendonly', 'Screen codec cannot constrain an unrelated incoming video');
    const cameraLine = rtc.getPeerConnection('peer').getTransceivers().find(entry => entry.receiver.track.kind === 'video' && entry !== localScreen);
    check(!cameraLine.sender.track, 'Dedicated screen sender never occupies the camera slot');

    const localPc = rtc.getPeerConnection('peer');
    const createAnswer = localPc.createAnswer;
    let releaseLocalAnswer;
    const heldLocalAnswer = new Promise(resolve => { releaseLocalAnswer = resolve; });
    let localAnswerReady = false;
    localPc.createAnswer = async function (...args) {
      const answer = await createAnswer.apply(this, args);
      localAnswerReady = true;
      await heldLocalAnswer;
      return answer;
    };
    try {
      const descriptionStart = sentDescriptions.length;
      remote.getTransceivers().find(entry => entry.mid === localScreen.mid).setCodecPreferences(codecs.getScreenVideoCodecs('auto'));
      settings.preferredVideoCodec = 'av1';
      await remote.setLocalDescription(await remote.createOffer());
      const answering = rtc.handleIncomingSignal({
        fromSessionId: 'peer', targetSessionId: 'self', signalType: 'offer', sdp: remote.localDescription.toJSON(),
      });
      await until(() => localAnswerReady, 'Answerer should capture the AV1 negotiation before preferences change');
      check(screenSender.getParameters().encodings.every(encoding => !encoding.active),
        'An incoming offer also keeps screen encoding inactive until its encoder is selected');
      settings.preferredVideoCodec = selected;
      const latest = rtc.reapplyCodecPreferences();
      releaseLocalAnswer();
      await Promise.all([answering, latest]);
      const descriptions = sentDescriptions.slice(descriptionStart);
      check(descriptions[0]?.type === 'answer' && descriptions[0].sdpType === 'answer'
        && descriptions[1]?.type === 'offer' && descriptions[1].sdpType === 'offer',
        'The committed answer is transmitted before a queued codec offer, using its own captured SDP');
      check(first.stream.getVideoTracks()[0].readyState === 'live',
        'A preference change while producing an answer cannot end compatible capture');
      await actualCodec(rtc.getScreenSendersForShare(first.stream.id)[0], 'P2P answerer latest selection');
    } finally {
      releaseLocalAnswer();
      localPc.createAnswer = createAnswer;
      settings.preferredVideoCodec = selected;
    }

    for (const operation of ['share', 'codec']) {
      for (const phase of ['before-offer', 'after-offer']) {
        for (const action of ['depart', 'replace']) {
          const peerId = `transient-${operation}-${phase}-${action}`;
          await rtc.connectToPeer(peerId, false);
          const transient = rtc.peers.get(peerId);
          const originalWait = rtc.waitForStable;
          let releasePeer;
          const pausedPeer = new Promise(resolve => { releasePeer = resolve; });
          let reached = false;
          let waits = 0;
          rtc.waitForStable = async (pc, timeout) => {
            if (pc === transient.pc && waits++ === (phase === 'before-offer' ? 0 : 1)) {
              reached = true;
              await pausedPeer;
            }
            return originalWait.call(rtc, pc, timeout);
          };
          const sharing = operation === 'share' ? source() : first;
          let outcome;
          try {
            if (operation === 'codec') settings.preferredVideoCodec = 'av1';
            const pending = operation === 'share'
              ? rtc.addLocalScreenTrack(sharing.stream) : rtc.reapplyCodecPreferences();
            outcome = pending.then(() => undefined, error => error);
            await until(() => reached, `${phase}: wait should target the transient peer`);
            rtc.removePeer(peerId);
            if (action === 'replace') await rtc.connectToPeer(peerId, false);
            releasePeer();
            const error = await outcome;
            check(!error && sharing.stream.getVideoTracks()[0].readyState === 'live',
              `${operation} ${action} ${phase}: obsolete peer work must not stop capture (${error?.message ?? 'no error'})`);
            await actualCodec(rtc.getScreenSendersForShare(sharing.stream.id)[0], `Healthy peer after ${operation} ${action} ${phase}`,
              operation === 'codec' ? 'video/av1' : required);
          } finally {
            releasePeer();
            rtc.waitForStable = originalWait;
            rtc.removePeer(peerId);
            if (outcome) await outcome;
            if (operation === 'share') {
              await rtc.removeLocalScreenTrack(sharing.stream.id);
              sharing.stop();
            } else {
              settings.preferredVideoCodec = selected;
              await rtc.reapplyCodecPreferences();
            }
            await signalQueue;
          }
        }
      }
    }

    const replacement = source();
    const oldTrack = first.stream.getVideoTracks()[0];
    first.stream.removeTrack(oldTrack);
    first.stream.addTrack(replacement.stream.getVideoTracks()[0]);
    await rtc.addLocalScreenTrack(first.stream);
    oldTrack.stop();
    await actualCodec(rtc.getScreenSendersForShare(first.stream.id)[0], 'P2P replace');

    await remote.setLocalDescription(await remote.createOffer());
    await rtc.handleIncomingSignal({ fromSessionId: 'peer', targetSessionId: 'self', signalType: 'offer', sdp: remote.localDescription.toJSON() });
    await signalQueue;
    await actualCodec(rtc.getScreenSendersForShare(first.stream.id)[0], 'P2P answer');
    await rtc.removeLocalScreenTrack(first.stream.id);
    first.stop(); replacement.stop();
    await signalQueue;
    const second = source();
    await rtc.addLocalScreenTrack(second.stream);
    await actualCodec(rtc.getScreenSendersForShare(second.stream.id)[0], 'P2P re-share');
    rtc.sfuEngine = sfu;
    store.serverDetails.voiceMode = 'sfu';
    await rtc.handleVoiceModeUpdate();
    check(second.stream.getVideoTracks()[0].readyState === 'live', 'P2P-to-SFU keeps the intended local capture');
    await actualCodec(rtc.getScreenSendersForShare(second.stream.id)[0], 'P2P-to-SFU');
    await rtc.removeLocalScreenTrack(second.stream.id);
    second.stop();
    await signalQueue;
    rtc.closeAllPeers(); remote.close();

    check(await sfu.join('room'), 'Real SFU joins using only ephemeral loopback transports');
    store.serverDetails.voiceMode = 'sfu';
    const screen = source();
    await rtc.addLocalScreenTrack(screen.stream);
    let producer = sfu.producers.get(`screen_video:${screen.stream.id}`);
    await actualCodec(producer.rtpSender, 'SFU initial');
    const inbound = await request('fixture.stats', { producerId: producer.id });
    check(inbound.stats.some(stat => stat.type === 'inbound-rtp' && stat.byteCount > 0), 'SFU received real encoded RTP bytes');
    settings.preferredVideoCodec = 'av1';
    await rtc.reapplyCodecPreferences();
    await actualCodec(rtc.getScreenSendersForShare(screen.stream.id)[0], 'SFU live AV1', 'video/av1');
    settings.preferredVideoCodec = selected;
    await rtc.reapplyCodecPreferences();
    await actualCodec(rtc.getScreenSendersForShare(screen.stream.id)[0], 'SFU live explicit');
    settings.preferredVideoCodec = 'av1';
    const superseded = rtc.reapplyCodecPreferences();
    settings.preferredVideoCodec = selected;
    await Promise.all([superseded, rtc.reapplyCodecPreferences()]);
    await actualCodec(rtc.getScreenSendersForShare(screen.stream.id)[0], 'SFU latest selection');
    sfu.closeProducer(`screen_video:${screen.stream.id}`);
    producer = await sfu.produceScreenVideo(screen.stream.getVideoTracks()[0], screen.stream.id);
    await actualCodec(producer.rtpSender, 'SFU re-share');
    const another = source();
    await sfu.replaceTrack(`screen_video:${screen.stream.id}`, another.stream.getVideoTracks()[0]);
    await actualCodec(sfu.getScreenSender(screen.stream.id), 'SFU replacement');
    sfu.leave();
    screen.stop(); another.stop();
    check(await sfu.join('vp8-room'), 'SFU with a genuinely incompatible router still connects for voice');
    const incompatibleSfu = source();
    settings.preferredVideoCodec = 'h264';
    const refused = await expectFailure(() => sfu.produceScreenVideo(incompatibleSfu.stream.getVideoTracks()[0], incompatibleSfu.stream.id),
      'SFU without H.264 rejects the explicit screen selection');
    check(refused instanceof codecs.ScreenCodecError && !sfu.getScreenSender(incompatibleSfu.stream.id),
      'SFU must never publish an alternate codec for an incompatible explicit screen');
    const camera = await sfu.produceCamera(incompatibleSfu.stream.getVideoTracks()[0]);
    await actualCodec(camera.rtpSender, 'SFU camera fallback', 'video/vp8');
    incompatibleSfu.stop();
    rtc.suspendForVoiceReconnect();
    settings.preferredVideoCodec = selected;
    store.serverDetails.voiceMode = 'p2p';
    rtc.resumeAfterVoiceReconnect();
    setupPeer();
    await rtc.connectToPeer('peer', true);
    await signalQueue;
    const afterMode = source();
    await rtc.addLocalScreenTrack(afterMode.stream);
    await actualCodec(rtc.getScreenSendersForShare(afterMode.stream.id)[0], 'SFU-to-P2P');
    await rtc.removeLocalScreenTrack(afterMode.stream.id);
    afterMode.stop();
    await signalQueue;
    const afterStop = source();
    await rtc.addLocalScreenTrack(afterStop.stream);
    await actualCodec(rtc.getScreenSendersForShare(afterStop.stream.id)[0], 'mode re-share');
    await rtc.removeLocalScreenTrack(afterStop.stream.id);
    afterStop.stop();
    await signalQueue;
    settings.preferredVideoCodec = 'auto';
    const automatic = source();
    await rtc.addLocalScreenTrack(automatic.stream);
    await actualCodec(rtc.getScreenSendersForShare(automatic.stream.id)[0], 'Automatic', null);
    await rtc.removeLocalScreenTrack(automatic.stream.id);
    automatic.stop();
    await signalQueue;
    rtc.closeAllPeers(); remote.close();
    settings.preferredVideoCodec = selected;
    setupPeer();
    remote.addTransceiver('audio', { direction: 'sendrecv' });
    const incomingCamera = source();
    const incomingSender = remote.addTrack(incomingCamera.stream.getVideoTracks()[0], incomingCamera.stream);
    remote.getTransceivers().find(entry => entry.sender === incomingSender).setCodecPreferences(codecs.getScreenVideoCodecs('vp8'));
    const initialAnswer = source();
    await rtc.addLocalScreenTrack(initialAnswer.stream);
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
    await actualCodec(rtc.getScreenSendersForShare(initialAnswer.stream.id)[0], 'P2P initial answer');
    await actualCodec(incomingSender, 'Independent incoming camera', 'video/vp8');
    await until(async () => {
      const stats = await rtc.getPeerConnection('peer').getStats();
      return [...stats.values()].some(stat => stat.type === 'inbound-rtp' && stat.framesDecoded > 0
        && stats.get(stat.codecId)?.mimeType.toLowerCase() === 'video/vp8');
    }, 'Incoming VP8 camera must still decode alongside the explicit H.264 screen');
    check(true, 'Strict screen codec leaves incoming camera decoding unrestricted');
    const explicitSender = rtc.getScreenSendersForShare(initialAnswer.stream.id)[0];
    const explicitLine = rtc.getPeerConnection('peer').getTransceivers().find(entry => entry.sender === explicitSender);
    const remoteScreenLine = remote.getTransceivers().find(entry => entry.mid === explicitLine.mid);
    remoteScreenLine.setCodecPreferences(codecs.getScreenVideoCodecs('av1'));
    const errors = [];
    const offFailure = appEvents.on('screen.codec_failed', error => errors.push(error));
    await remote.setLocalDescription(await remote.createOffer());
    await rtc.handleIncomingSignal({ fromSessionId: 'peer', targetSessionId: 'self', signalType: 'offer', sdp: remote.localDescription.toJSON() });
    await signalQueue;
    await until(() => !rtc.getScreenSendersForShare(initialAnswer.stream.id).length, 'An incompatible explicit screen must stop, not negotiate AV1');
    check(errors.length === 1 && initialAnswer.stream.getVideoTracks()[0].readyState === 'ended',
      'Incompatible P2P screen ends capture and surfaces one error');
    offFailure();
    await actualCodec(incomingSender, 'Camera after screen failure', 'video/vp8');
    incomingCamera.stop(); initialAnswer.stop();

    const original = RTCRtpSender.getCapabilities;
    let captures = 0;
    const capture = navigator.mediaDevices.getDisplayMedia;
    try {
      RTCRtpSender.getCapabilities = kind => ({ codecs: original.call(RTCRtpSender, kind).codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264'), headerExtensions: [] });
      navigator.mediaDevices.getDisplayMedia = async () => { captures++; return source().stream; };
      settings.preferredVideoCodec = 'h264';
      const error = await expectFailure(() => videoService.startScreenShare(), 'Unsupported H.264 fails clearly');
      check(error instanceof codecs.ScreenCodecError && captures === 0, 'Unsupported explicit codec never opens capture or silently substitutes AV1');
    } finally {
      RTCRtpSender.getCapabilities = original;
      navigator.mediaDevices.getDisplayMedia = capture;
    }
    const originalDisplay = navigator.mediaDevices.getDisplayMedia;
    const originalCapture = navigator.mediaDevices.getUserMedia;
    try {
      settings.preferredVideoCodec = selected;
      let resolveScreen;
      navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { resolveScreen = resolve; });
      const pendingScreen = videoService.startScreenShare();
      videoService.stopScreenShare();
      const lateScreen = source();
      resolveScreen(lateScreen.stream);
      const cancelledScreen = await expectFailure(() => pendingScreen, 'A late screen capture is cancelled by mode teardown');
      check(cancelledScreen.name === 'AbortError' && lateScreen.stream.getTracks().every(track => track.readyState === 'ended'),
        'No stale screen track can appear after the clean rejoin');
      let resolveCamera;
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCamera = resolve; });
      const pendingCamera = videoService.startCamera();
      videoService.stopCamera();
      const lateCamera = source();
      resolveCamera(lateCamera.stream);
      const cancelledCamera = await expectFailure(() => pendingCamera, 'A late camera capture is cancelled by mode teardown');
      check(cancelledCamera.name === 'AbortError' && lateCamera.stream.getTracks().every(track => track.readyState === 'ended'),
        'No stale camera track can appear after the clean rejoin');
    } finally {
      navigator.mediaDevices.getDisplayMedia = originalDisplay;
      navigator.mediaDevices.getUserMedia = originalCapture;
    }
    rtc.closeAllPeers(); remote.close();
    if (!codecsOnly) {
      await testRejoinAdmission();
      await testForegroundAdmission();
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

  async function testForegroundAdmission() {
    const [{ joinCallOnSession }, { sessionManager }, { audioProcessor: audio },
      { webRtcManager: globalRtc }, { soundEffects }] = await Promise.all([
      import('/core/serverConnection.ts'), import('/core/SessionManager.ts'),
      import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'), import('/core/SoundEffects.ts'),
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

      const screen = source();
      videoService.screenStreams.set(screen.stream.id, screen.stream);
      globalRtc.localScreenTracks.set(screen.stream.id, screen.stream.getVideoTracks()[0]);
      voice.addScreenShare(screen.stream.id);
      const beforeMove = views.length;
      const moving = view.rejoinVoiceChannel('moved-room');
      sessionManager.activate(a.key);
      await until(() => pending.length === 1, 'Administrative move must await destination admission');
      check(pending[0].key === b.key && screen.stream.getTracks().every(track => track.readyState === 'ended')
        && !voice.isScreenSharing, 'A move uses the call server and ends screen sharing before admission');
      pending.shift().resolve(reply(b, 'moved-room', true));
      await moving;
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
      videoService.stopScreenShare();
      globalRtc.clearLocalScreenTracks();
      for (const session of sessions) sessionManager.remove(session.key);
      voice.reset();
      destination.stream.getTracks().forEach(track => track.stop());
      await context.close();
    }
  }
}
