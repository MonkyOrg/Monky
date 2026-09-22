const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const sdkRoot = path.resolve(__dirname, '..');
const clientRoot = path.resolve(sdkRoot, '..', '..', 'apps', 'client');

if (!process.versions.electron) {
  const profile = path.join(sdkRoot, 'dist', `voice-renderer-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_VOICE_RENDERER_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: sdkRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, powerSaveBlocker } = require('electron');
  const { OpusPeer } = require('../dist/voice/OpusPeer');
  const { BotVoiceConnection, validateOpus } = require('../dist/voice/BotVoiceConnection');
  const { MessageType, botVoiceSignalSchema, rtcSignalSchema } = require('@monky/shared');
  app.setPath('userData', process.env.MONKY_VOICE_RENDERER_PROFILE);
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  let vite, window, worker, router, p2p, sfu, botProducer, timeout, rosterVoice, rosterJoin, retiredPeer;
  let p2pTimer;
  let p2pSubscriptionId;
  let listener, listenerJoin, listenerReader, listenerRecvTransport, humanProducer;
  let received = { packets: 0, bytes: 0 };
  const listenerJobs = new Set();
  const human = {
    user: { id: 'human', sessionId: 'aaa:human' },
    voiceState: { sessionId: 'aaa:human', userId: 'human', channelId: 'room', isMuted: false, isDeafened: false },
  };
  let powerBlocker;
  let mediaPaused = false;
  let mediaWrite = Promise.resolve();
  const outgoingSignals = [];
  const listenerSignals = [];
  const describeSignal = signal => ({
    type: signal.signalType, from: signal.fromSessionId,
    media: signal.sdp?.sdp.split(/\r?\n/).filter(line => /^(m=|a=mid:|a=(sendrecv|sendonly|recvonly|inactive)$)/.test(line)),
  });
  const activityUpdates = [];
  const transports = new Map();
  const timers = new Set();
  const errors = [];
  let candidateSignals = 0;
  let rosterOffers = 0;
  const streams = new Set();
  let audioFrames;
  const botId = 'bot:voice';
  const humanId = 'aaa:human';
  const roster = [{
    user: { id: 'voice-bot', sessionId: botId, clientId: 'bot-voice', nickname: 'Voice bot', isBot: true, status: 'ONLINE', joinedAt: 1 },
    voiceState: { sessionId: botId, userId: 'voice-bot', channelId: 'room', isMuted: false, isDeafened: false,
      serverMuted: false, serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false },
  }];
  function generatedSine() {
    const encoded = spawnSync(process.env.MONKY_MUSIC_FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k',
      '-frame_duration', '20', '-application', 'audio', '-f', 'ogg', '-page_duration', '20000', 'pipe:1',
    ], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    if (encoded.error) throw new Error(`Generated audio needs FFmpeg; set MONKY_MUSIC_FFMPEG (${encoded.error.code}).`);
    if (encoded.status !== 0) throw new Error(`Generated audio encoding exited with code ${encoded.status}.`);
    const frames = [];
    // This fixture asks FFmpeg for one 20 ms packet per page, not arbitrary Ogg input.
    for (let offset = 0; offset < encoded.stdout.length;) {
      if (encoded.stdout.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error('Invalid generated Ogg page.');
      const segments = encoded.stdout[offset + 26];
      const laces = encoded.stdout.subarray(offset + 27, offset + 27 + segments);
      const start = offset + 27 + segments;
      const end = start + laces.reduce((total, value) => total + value, 0);
      const packet = encoded.stdout.subarray(start, end);
      if (!['OpusHead', 'OpusTags'].includes(packet.toString('ascii', 0, 8))) {
        if ([...laces].filter(value => value < 255).length !== 1) throw new Error('Expected one generated packet per page.');
        validateOpus(packet);
        frames.push(packet);
      }
      offset = end;
    }
    if (frames.length < 50) throw new Error('Generated sine did not contain a second of Opus.');
    return frames;
  }
  function pace(peer, label) {
    let stopped = false, timer, index = 0, nextAt = performance.now();
    let lateTicks = 0, maxLagMs = 0, maxWriteMs = 0;
    const tick = () => {
      if (stopped) return;
      const now = performance.now();
      if (mediaPaused) {
        nextAt = now;
        timer = setTimeout(tick, 20);
        return;
      }
      maxLagMs = Math.max(maxLagMs, now - nextAt);
      // Keep the media deadline: resynchronizing here silently discards RTP time.
      if (now - nextAt > 100) lateTicks++;
      const writtenAt = performance.now();
      mediaWrite = peer.write(audioFrames[index++ % audioFrames.length])
        .catch(error => errors.push(`${label} frame ${index}: ${error.message}`))
        .finally(() => {
          maxWriteMs = Math.max(maxWriteMs, performance.now() - writtenAt);
          if (stopped) return;
          nextAt += 20;
          timer = setTimeout(tick, Math.max(0, nextAt - performance.now()));
        });
    };
    const pacer = {
      get frames() { return index; },
      get timing() {
        return { label, frames: index, lateTicks, maxLagMs: Math.round(maxLagMs), maxWriteMs: Math.round(maxWriteMs) };
      },
      stop() { stopped = true; clearTimeout(timer); timers.delete(pacer); },
    };
    timers.add(pacer);
    tick();
    return pacer;
  }
  const stopMedia = async () => {
    for (const timer of timers) timer.stop();
    await mediaWrite;
  };
  const finish = async (code) => {
    clearTimeout(timeout);
    if (powerBlocker !== undefined) powerSaveBlocker.stop(powerBlocker);
    await stopMedia();
    for (const stream of streams) await stream.close();
    await listenerReader;
    await Promise.all(listenerJobs);
    if (window && !window.isDestroyed()) window.destroy();
    worker?.close();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    // The hidden Electron fixture must stay awake like the real bot's Node process.
    powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!process.argv.includes('--receive-only')) audioFrames = generatedSine();
    const [{ createServer }, mediasoup] = await Promise.all([import('vite'), import('mediasoup')]);
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    router = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    ] });
    const options = (transport) => ({
      id: transport.id, iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
    });
    async function listenerRequest(message) {
      const payload = message.payload;
      switch (message.type) {
        case MessageType.VOICE_JOIN:
          return { type: MessageType.VOICE_USER_JOINED, payload: {
            ...roster[0], channelId: 'room', sessionId: botId, participants: [roster[0], human],
          } };
        case MessageType.VOICE_LEAVE:
          listenerRecvTransport?.close();
          return { type: MessageType.VOICE_USER_LEFT, payload: { channelId: 'room', sessionId: botId } };
        case MessageType.VOICE_STATE_UPDATE:
          roster[0].voiceState = { ...roster[0].voiceState, ...payload };
          if (payload.isDeafened) listenerRecvTransport?.close();
          return { type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState: roster[0].voiceState } };
        case MessageType.SFU_CREATE_WEBRTC_TRANSPORT: {
          const response = await request(message.type, payload);
          listenerRecvTransport = transports.get(response.transportOptions.id);
          return { type: MessageType.SFU_WEBRTC_TRANSPORT_CREATED, payload: response };
        }
        case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
          await request(message.type, payload);
          return { type: MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED, payload: { channelId: 'room', transportId: payload.transportId } };
        case MessageType.SFU_GET_PRODUCERS:
          return { type: MessageType.SFU_PRODUCERS_LIST, payload: {
            channelId: 'room', participants: [roster[0], human], producers: humanProducer ? [{
              channelId: 'room', producerId: humanProducer.id, producerSessionId: humanId,
              kind: 'audio', appData: { mediaType: 'mic' },
            }] : [],
          } };
        case MessageType.SFU_CONSUME: {
          if (payload.producerId !== humanProducer?.id) throw new Error('Listener requested something other than the human microphone');
          const consumer = await transports.get(payload.transportId).consume({
            producerId: payload.producerId, rtpCapabilities: payload.rtpCapabilities,
          });
          return { type: MessageType.SFU_CONSUMED, payload: {
            channelId: 'room', id: consumer.id, producerId: humanProducer.id, producerSessionId: humanId,
            kind: 'audio', appData: { mediaType: 'mic' }, rtpParameters: consumer.rtpParameters,
          } };
        }
        default: throw new Error(`Unexpected listener request ${message.type}`);
      }
    }
    async function request(type, payload) {
      switch (type) {
        case 'fixture.prepare-listener': {
          await stopMedia();
          await rosterVoice?.close();
          await listener?.close();
          await listenerReader;
          rosterVoice = undefined;
          outgoingSignals.length = 0;
          humanProducer = undefined;
          received = { packets: 0, bytes: 0 };
          roster[0].voiceState = { ...roster[0].voiceState, receivesVoice: true,
            isMuted: false, isDeafened: false, serverMuted: false, serverDeafened: false, isSpeaking: false,
            botVoicePermissions: { publish: false, receive: true, publishRequested: false, receiveRequested: true } };
          listener = new BotVoiceConnection('room', {
            currentUser: roster[0].user, server: { voiceMode: payload.mode }, iceServers: [],
          }, {
            send(message) {
              if (message.type === MessageType.RTC_SIGNAL) {
                listenerSignals.push(describeSignal(message.payload));
                outgoingSignals.push(message.payload);
                return;
              }
              const connection = listener;
              const job = listenerRequest(message).then(response => connection.handle({
                ...response, requestId: message.requestId,
              })).catch(error => {
                errors.push(error.message);
                connection.handle({ type: MessageType.SERVER_ERROR, requestId: message.requestId, payload: { message: error.message } });
              }).finally(() => listenerJobs.delete(job));
              listenerJobs.add(job);
            },
            participants() {}, disconnected() {}, error(error) { errors.push(error.message); },
          }, false);
          streams.add(listener);
          listenerJoin = listener.join({ receiveAudio: true }).then(() => {
            const receiver = listener.receiveAudio();
            listenerReader = (async () => {
              for await (const packet of receiver) {
                if (packet.sessionId !== humanId || packet.userId !== 'human' || packet.channelId !== 'room' ||
                    packet.codec !== 'opus' || packet.clockRate !== 48000 || !(packet.opus instanceof Uint8Array)) {
                  throw new Error('Received microphone has invalid source or encoding metadata');
                }
                validateOpus(packet.opus);
                received.packets++;
                received.bytes += packet.opus.length;
              }
            })().catch(error => errors.push(error.message));
          });
          void listenerJoin.catch(error => errors.push(error.message));
          return { voiceState: roster[0].voiceState };
        }
        case 'fixture.listener-ready':
          await listenerJoin;
          return received;
        case 'fixture.listener-stats':
          return received;
        case 'fixture.listener-deafen':
          await listener.setDeafened(payload.deafened);
          return { voiceState: roster[0].voiceState };
        case 'fixture.listener-stop': {
          const pcs = [...listener.peers.values()].map(peer => peer.pc);
          if (listener.sfuReceive) pcs.push(listener.sfuReceive.peer.pc);
          await listener.close();
          await listenerReader;
          return { closed: pcs.every(pc => pc.connectionState === 'closed'), ...received };
        }
        case 'fixture.stop-media':
          await stopMedia();
          return {};
        case 'fixture.pause':
          mediaPaused = true;
          rosterVoice?.stopSpeaking();
          await mediaWrite;
          return {};
        case 'fixture.resume':
          mediaPaused = false;
          return {};
        case 'fixture.voice-state':
          return { voiceState: roster[0].voiceState, updateCount: activityUpdates.length, frames: p2pTimer?.frames ?? 0 };
        case 'fixture.timing':
          return [...timers].map(timer => timer.timing);
        case 'fixture.restrict':
          roster[0].voiceState = { ...roster[0].voiceState,
            serverMuted: payload.serverMuted, serverDeafened: payload.serverDeafened,
            isSpeaking: payload.serverMuted || payload.serverDeafened ? false : roster[0].voiceState.isSpeaking };
          rosterVoice.handle({ type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState: roster[0].voiceState } });
          return {};
        case 'fixture.offer':
          p2pSubscriptionId = randomUUID();
          p2p = new OpusPeer([], (error) => errors.push(error.message), (signal) => outgoingSignals.push(rtcSignalSchema.parse({
            ...signal, fromSessionId: botId, targetSessionId: humanId, subscriptionId: p2pSubscriptionId,
          })));
          streams.add(p2p);
          await p2p.pc.setLocalDescription(await p2p.pc.createOffer());
          return rtcSignalSchema.parse({ fromSessionId: botId, targetSessionId: humanId,
            signalType: 'offer', sdp: p2p.pc.localDescription, subscriptionId: p2pSubscriptionId });
        case 'fixture.answerer':
          await stopMedia();
          await p2p.close();
          outgoingSignals.length = 0;
          p2pSubscriptionId = randomUUID();
          p2p = new OpusPeer([], (error) => errors.push(error.message), (signal) => outgoingSignals.push(rtcSignalSchema.parse({
            ...signal, fromSessionId: botId, targetSessionId: humanId, subscriptionId: p2pSubscriptionId,
          })));
          streams.add(p2p);
          return {};
        case MessageType.RTC_SIGNAL:
          if (payload.signalType === 'candidate') candidateSignals++;
          if (listener) {
            if (payload.signalType !== 'candidate') listenerSignals.push(describeSignal(payload));
            listener.handle({ type: MessageType.RTC_SIGNAL, payload: botVoiceSignalSchema.parse(payload) });
          } else if (rosterVoice) {
            rosterVoice.handle({ type: MessageType.RTC_SIGNAL, payload: botVoiceSignalSchema.parse(payload) });
          } else await p2p.accept(botVoiceSignalSchema.parse(payload), false);
          return { signals: outgoingSignals.splice(0) };
        case 'fixture.signals': return { signals: outgoingSignals.splice(0) };
        case 'fixture.start-p2p':
          await p2p.ready;
          p2pTimer = pace(p2p, `P2P ${p2p.pc.localDescription.type}`);
          return {};
        case 'fixture.prepare-roster': {
          await stopMedia();
          await p2p.close();
          outgoingSignals.length = 0;
          const human = {
            user: { id: 'human', sessionId: humanId },
            voiceState: { sessionId: humanId, channelId: 'room' },
          };
          rosterVoice = new BotVoiceConnection('room', {
            currentUser: roster[0].user, server: { voiceMode: 'p2p' }, iceServers: [],
          }, {
            send(message) {
              if (message.type === MessageType.VOICE_JOIN) {
                if (message.payload.isMuted !== false || message.payload.isDeafened !== false) {
                  throw new Error('Bot join must not impersonate user mute/deafen preferences.');
                }
                roster[0].voiceState = { ...roster[0].voiceState, isMuted: false, isDeafened: false, isSpeaking: false };
                queueMicrotask(() => rosterVoice.handle({
                  type: MessageType.VOICE_USER_JOINED, requestId: message.requestId,
                  payload: { ...roster[0], channelId: 'room', sessionId: botId, participants: [...roster, human] },
                }));
              }
              else if (message.type === MessageType.VOICE_LEAVE) queueMicrotask(() => rosterVoice.handle({
                type: MessageType.VOICE_USER_LEFT, requestId: message.requestId,
                payload: { channelId: 'room', sessionId: botId },
              }));
              else if (message.type === MessageType.RTC_SIGNAL) {
                if (message.payload.signalType === 'offer') rosterOffers++;
                outgoingSignals.push(rtcSignalSchema.parse(message.payload));
              }
              else if (message.type === MessageType.VOICE_STATE_UPDATE) {
                if (Object.keys(message.payload).join() !== 'isSpeaking' || typeof message.payload.isSpeaking !== 'boolean') {
                  throw new Error('Activity updates may not rewrite mute/deafen preferences.');
                }
                activityUpdates.push(message.payload);
                roster[0].voiceState = { ...roster[0].voiceState, ...message.payload };
                rosterVoice.handle({ type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState: roster[0].voiceState } });
              }
            },
            participants() {}, disconnected() {},
            error(error) { errors.push(error.message); },
          });
          streams.add(rosterVoice);
          rosterJoin = rosterVoice.join();
          void rosterJoin.catch(error => errors.push(error.message));
          return {};
        }
        case 'fixture.start-roster':
          await rosterJoin;
          p2pTimer = pace({ write: frame => rosterVoice.writeOpus(frame) }, 'SDK roster');
          return {};
        case 'fixture.human-left':
          retiredPeer = rosterVoice.peers.get(humanId);
          rosterVoice.handle({
            type: MessageType.VOICE_USER_LEFT, payload: { channelId: 'room', sessionId: humanId },
          });
          return {};
        case 'fixture.human-rejoined':
          rosterVoice.handle({ type: MessageType.VOICE_USER_JOINED, payload: {
            channelId: 'room', sessionId: humanId, user: { id: 'human', sessionId: humanId },
            voiceState: { channelId: 'room', sessionId: humanId },
          } });
          return {};
        case 'fixture.rejoined-ready': {
          const peer = rosterVoice.peers.get(humanId);
          if (!peer || peer === retiredPeer) throw new Error('Human rejoin did not create a fresh transport.');
          await peer.ready;
          retiredPeer.failed(new Error('Fixture: late retired ICE/DTLS timeout.'));
          return { active: !rosterVoice.isClosed, humanParticipantCount: rosterVoice.humanParticipantCount, rosterOffers };
        }
        case 'fixture.prepare-sfu': {
          await stopMedia();
          await p2p.close();
          await rosterVoice?.close();
          const transport = await router.createWebRtcTransport({ listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }] });
          sfu = new OpusPeer([], (error) => errors.push(error.message));
          streams.add(sfu);
          const prepared = await sfu.prepareSfu(options(transport));
          await transport.connect({ dtlsParameters: prepared.dtlsParameters });
          await sfu.pc.setRemoteDescription({ type: 'answer', sdp: prepared.answer });
          await sfu.ready;
          botProducer = await transport.produce({
            kind: 'audio', rtpParameters: prepared.rtpParameters, appData: { mediaType: 'mic' },
          });
          pace(sfu, 'SFU');
          return { roster };
        }
        case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
          return { channelId: 'room', rtpCapabilities: router.rtpCapabilities };
        case MessageType.SFU_CREATE_WEBRTC_TRANSPORT: {
          const transport = await router.createWebRtcTransport({ listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }] });
          transports.set(transport.id, transport);
          return { channelId: 'room', transportOptions: options(transport) };
        }
        case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
          await transports.get(payload.transportId).connect({ dtlsParameters: payload.dtlsParameters });
          return {};
        case MessageType.SFU_GET_PRODUCERS:
          if (listener) return { channelId: 'room', participants: roster, producers: [] };
          return { channelId: 'room', participants: roster, producers: [{
            channelId: 'room', producerId: botProducer.id, producerSessionId: botId,
            kind: 'audio', appData: botProducer.appData,
          }] };
        case MessageType.SFU_PRODUCE: {
          const producer = await transports.get(payload.transportId).produce(payload);
          if (payload.kind === 'audio' && payload.appData.mediaType === 'mic') {
            humanProducer = producer;
            listener?.handle({ type: MessageType.SFU_NEW_PRODUCER, payload: {
              channelId: 'room', producerId: producer.id, producerSessionId: humanId,
              kind: 'audio', appData: { mediaType: 'mic' },
            } });
          }
          return { channelId: 'room', id: producer.id };
        }
        case MessageType.SFU_PRODUCER_CLOSED:
          if (humanProducer?.id === payload.producerId) {
            humanProducer.close();
            humanProducer = undefined;
            listener?.handle({ type, payload });
          }
          return {};
        case MessageType.SFU_CONSUME: {
          const consumer = await transports.get(payload.transportId).consume({
            producerId: payload.producerId, rtpCapabilities: payload.rtpCapabilities, paused: false,
          });
          return { channelId: 'room', id: consumer.id, producerId: botProducer.id,
            kind: 'audio', rtpParameters: consumer.rtpParameters, producerSessionId: botId, appData: botProducer.appData };
        }
        case 'fixture.errors': return { errors, candidateSignals, activityUpdates,
          listener: listener ? { closed: listener.isClosed, receiving: listener.isReceivingAudio, signals: listenerSignals,
            peers: [...listener.peers].map(([id, peer]) => ({ id, connection: peer.pc.connectionState, signaling: peer.pc.signalingState })) } : undefined };
        default: throw new Error(`Unexpected voice fixture request ${type}`);
      }
    }
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'bot-voice-renderer-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/__voice_renderer__') {
              res.setHeader('Content-Type', 'text/html');
              res.end('<!doctype html><html><body></body></html>');
            } else if (req.url === '/__voice_request__') {
              let body = '';
              req.on('data', (chunk) => { body += chunk; });
              req.on('end', async () => {
                try {
                  const input = JSON.parse(body);
                  const result = await request(input.type, input.payload);
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify(result));
                } catch (error) {
                  errors.push(error.message);
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: error.message }));
                }
              });
            } else next();
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    window = new BrowserWindow({
      show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', (_event, _level, message) => {
      if (message.startsWith('VOICE TEST')) console.log(message);
    });
    timeout = setTimeout(() => { console.error('Bot voice renderer smoke timed out'); void finish(1); }, 120000);
    await window.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__voice_renderer__`);
    if (!process.argv.includes('--receive-only')) {
      const result = await window.webContents.executeJavaScript(
        `(${runRenderer.toString()})(${JSON.stringify(MessageType)},${JSON.stringify(roster)},${JSON.stringify(humanId)})`, true);
      console.log(`Bot voice renderer: ${JSON.stringify(result)}`);
    }
    const reception = await window.webContents.executeJavaScript(
      `(${runReceiveRenderer.toString()})(${JSON.stringify(roster)},${JSON.stringify(humanId)})`, true);
    console.log(`Bot microphone reception renderer: ${JSON.stringify(reception)}`);
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runReceiveRenderer(roster, humanId) {
  const [{ WebRtcManager }, { ParticipantManager }, { voiceStore }, { settingsStore }] = await Promise.all([
    import('/core/WebRtcManager.ts'), import('/core/ParticipantManager.ts'),
    import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
  ]);
  const request = async (type, payload = {}) => {
    const response = await fetch('/__voice_request__', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const audio = new AudioContext({ sampleRate: 48000 });
  const tones = [440, 660].map(frequency => {
    const oscillator = audio.createOscillator();
    oscillator.frequency.value = frequency;
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    return { oscillator, destination, track: destination.stream.getAudioTracks()[0] };
  });
  await audio.resume();
  const results = {};
  try {
    for (const mode of ['p2p', 'sfu']) {
      const prepared = await request('fixture.prepare-listener', { mode });
      const botId = prepared.voiceState.sessionId;
      const participants = new ParticipantManager();
      participants.reconcileVoiceChannel('room', [{ ...roster[0], voiceState: prepared.voiceState }]);
      const rtc = new WebRtcManager();
      const errors = [];
      const client = {
        getStatus: () => 'CONNECTED', getConnectionId: () => `listener-${mode}`,
        send(type, payload) {
          void request(type, payload).then(async response => {
            for (const signal of response.signals ?? []) await rtc.handleIncomingSignal(signal);
          }).catch(error => errors.push(error.message));
        },
        sendRequest: request,
      };
      Object.defineProperty(rtc, 'voiceServerStore', { value: {
        serverDetails: { voiceMode: mode }, currentUser: { id: 'human', sessionId: humanId },
      } });
      Object.defineProperty(rtc, 'voiceParticipants', { value: participants });
      Object.defineProperty(rtc, 'signalClient', { value: client });
      rtc.rtcConfig = { iceServers: [], iceCandidatePoolSize: 0 };
      rtc.setCurrentSessionId(humanId);
      voiceStore.setChannel('room');
      settingsStore.save = () => {};
      const pump = async () => {
        for (const signal of (await request('fixture.signals')).signals) await rtc.handleIncomingSignal(signal);
      };
      const until = async (predicate, message) => {
        for (let index = 0; index < 160; index++) {
          await pump();
          if (await predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`${mode}: ${message}; ${errors.join('; ')}; ${JSON.stringify(await request('fixture.errors'))}`);
      };
      try {
        await rtc.setLocalAudioTrack(tones[0].track);
        if (mode === 'p2p') {
          await until(() => rtc.getPeerConnection(botId)?.connectionState === 'connected', 'microphone P2P did not connect');
        }
        await request('fixture.listener-ready');
        await until(async () => (await request('fixture.listener-stats')).packets >= 12, 'SDK did not receive Chromium Opus');
        if (mode === 'p2p') {
          const pc = rtc.getPeerConnection(botId);
          check(pc.getTransceivers().length === 1 && pc.getTransceivers()[0].currentDirection === 'sendonly',
            'A receive-only bot must negotiate only the human microphone');
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 32;
          canvas.getContext('2d').fillRect(0, 0, 32, 32);
          const video = canvas.captureStream(5);
          try {
            await rtc.setLocalCameraTrack(video.getVideoTracks()[0]);
            await rtc.addLocalScreenTrack(video);
            check(pc.getTransceivers().length === 1 && pc.getSenders().every(sender => sender.track?.kind !== 'video'),
              'Camera and screen sharing must never reach a listening bot');
          } finally {
            await rtc.removeLocalScreenTrack(video.id);
            await rtc.setLocalCameraTrack(null);
            for (const track of video.getTracks()) track.stop();
          }
          await rtc.setLocalScreenAudioTrack(tones[1].track);
          check(pc.getSenders().filter(sender => sender.track).length === 1, 'Screen audio must not be sent to the listening bot');
          await rtc.setLocalScreenAudioTrack(null);
          await rtc.setLocalAudioTrack(tones[1].track);
          check(pc.getSenders()[0].track === tones[1].track, 'Microphone device replacement must reach authorized listening bots');
          await rtc.setLocalAudioTrack(null);
          check(pc.getSenders()[0].track === null, 'Removing the microphone must detach it from the listening bot');
          await rtc.setLocalAudioTrack(tones[0].track);
        }
        let changed = await request('fixture.listener-deafen', { deafened: true });
        participants.updateVoiceState(changed.voiceState);
        rtc.syncBotVoiceReception(botId);
        await until(() => mode === 'sfu' || rtc.getPeerConnection(botId).getSenders()[0].track === null,
          'Deafen did not remove the human microphone');
        const paused = await request('fixture.listener-stats');
        for (let index = 0; index < 8; index++) { await pump(); await new Promise(resolve => setTimeout(resolve, 40)); }
        check((await request('fixture.listener-stats')).packets === paused.packets, 'Deafen must stop SDK delivery');
        changed = await request('fixture.listener-deafen', { deafened: false });
        participants.updateVoiceState(changed.voiceState);
        rtc.syncBotVoiceReception(botId);
        await until(async () => (await request('fixture.listener-stats')).packets >= paused.packets + 8, 'Undeafen did not restore reception');
        results[mode] = await request('fixture.listener-stop');
        check(results[mode].closed && results[mode].bytes > 100, 'Reception must deliver data and close every peer');
        check(errors.length === 0, errors.join('; '));
      } finally {
        rtc.closeAllPeers();
      }
    }
    const signaling = await request('fixture.errors');
    check(signaling.errors.length === 0, signaling.errors.join('; '));
    return results;
  } finally {
    for (const tone of tones) {
      tone.track.stop();
      tone.oscillator.stop();
      tone.oscillator.disconnect();
      tone.destination.disconnect();
    }
    await audio.close();
  }
}

async function runRenderer(MessageType, roster, humanId) {
  const [{ WebRtcManager }, { ParticipantManager }, { voiceStore }, { settingsStore }] = await Promise.all([
    import('/core/WebRtcManager.ts'), import('/core/ParticipantManager.ts'),
    import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
  ]);
  const request = async (type, payload = {}) => {
    const response = await fetch('/__voice_request__', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (probe, message) => {
    for (let i = 0; i < 150; i++) {
      const result = await probe();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
  };
  const botId = roster[0].voiceState.sessionId;
  const participants = new ParticipantManager();
  participants.reconcileVoiceChannel('room', roster);
  const store = { serverDetails: { voiceMode: 'p2p' }, currentUser: { id: 'human', sessionId: humanId } };
  const rtc = new WebRtcManager();
  const errors = [];
  const audioProbes = new Set();
  const client = {
    getStatus: () => 'CONNECTED',
    getConnectionId: () => 'voice-renderer-connection',
    send(type, payload) {
      void request(type, payload).then(async (response) => {
        for (const signal of response.signals ?? []) await rtc.handleIncomingSignal(signal);
      }).catch((error) => errors.push(error.message));
    },
    sendRequest: request,
  };
  Object.defineProperty(rtc, 'voiceServerStore', { value: store });
  Object.defineProperty(rtc, 'voiceParticipants', { value: participants });
  Object.defineProperty(rtc, 'signalClient', { value: client });
  rtc.rtcConfig = { iceServers: [], iceCandidatePoolSize: 0 };
  rtc.setCurrentSessionId(humanId);
  voiceStore.setChannel('room');
  settingsStore.save = () => {};
  settingsStore.setUserVolume(botId, 100);
  const syncVoiceState = async () => {
    const state = await request('fixture.voice-state');
    participants.updateVoiceState(state.voiceState);
    return state;
  };
  const rendererSpeakingState = () => {
    const participant = participants.get(botId);
    return participant ? {
      sessionId: participant.user.sessionId,
      isSpeaking: participant.isSpeaking,
      voiceState: participant.voiceState ? { ...participant.voiceState } : null,
    } : null;
  };
  async function assertVoice(category, statsSource, continuousMs = 0, checkActivity = false) {
    const audio = await until(() => rtc.mediaRouter.getAudioElement(botId), `${category}: missing microphone audio element`);
    check(audio.dataset.peerSession === botId, `${category}: wrong roster session label`);
    check(!rtc.mediaRouter.getScreenAudioElement(botId), `${category}: incorrectly classified as screen audio`);
    check(audio.srcObject.getAudioTracks().length === 1, `${category}: expected one microphone track`);
    check(rtc.mediaRouter.voicePipelines.has(botId), `${category}: missing voice output graph`);
    check(!rtc.mediaRouter.screenAudioPipelines.has(botId), `${category}: unexpected screen graph`);
    await until(() => !audio.paused && audio.readyState >= 2, `${category}: audio decoder did not play`);
    // Decode counters alone cannot prove audible audio; tap the actual voice
    // GainNode while the isolated fixture's physical output remains muted.
    const pipeline = rtc.mediaRouter.voicePipelines.get(botId);
    const analyser = pipeline.gain.context.createAnalyser();
    analyser.fftSize = 2048;
    const silentSink = pipeline.gain.context.createGain();
    silentSink.gain.value = 0;
    pipeline.gain.connect(analyser);
    analyser.connect(silentSink);
    silentSink.connect(pipeline.gain.context.destination);
    const samples = new Float32Array(analyser.fftSize);
    const rms = () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    };
    const disposeProbe = () => {
      try { pipeline.gain.disconnect(analyser); } catch {}
      analyser.disconnect();
      silentSink.disconnect();
      audioProbes.delete(disposeProbe);
    };
    audioProbes.add(disposeProbe);
    let lastAudioStats;
    const sampleStats = async () => {
      const reports = await statsSource();
      const audioReport = [...reports.values()].find(entry => entry.type === 'inbound-rtp' && entry.kind === 'audio');
      if (audioReport) lastAudioStats = {
        packetsReceived: audioReport.packetsReceived, bytesReceived: audioReport.bytesReceived,
        totalSamplesReceived: audioReport.totalSamplesReceived, concealedSamples: audioReport.concealedSamples,
        totalAudioEnergy: audioReport.totalAudioEnergy, audioLevel: audioReport.audioLevel,
      };
      return [...reports.values()].find((entry) => entry.type === 'inbound-rtp' &&
        entry.kind === 'audio' && entry.packetsReceived >= 3 &&
        Number.isFinite(entry.totalSamplesReceived) && Number.isFinite(entry.concealedSamples) &&
        entry.totalSamplesReceived > entry.concealedSamples);
    };
    const stats = await until(sampleStats, `${category}: browser did not decode real Opus RTP`).catch(error => {
      throw new Error(`${error.message}: ${JSON.stringify(lastAudioStats)}`);
    });
    await until(() => rms() > 0.005, `${category}: decoded Opus never reached the voice output graph`).catch(error => {
      throw new Error(`${error.message}: ${JSON.stringify({ ...lastAudioStats, rms: rms(), context: pipeline.gain.context.state })}`);
    });
    if (checkActivity) {
      await until(async () => (await syncVoiceState()).voiceState.isSpeaking, `${category}: missing transmission activity`);
      check(participants.get(botId).isSpeaking, `${category}: activity did not reach the human speaking-state path`);
      check(!participants.get(botId).voiceState.isMuted && !participants.get(botId).voiceState.isDeafened,
        `${category}: bot displayed voluntary mute/deafen despite normal preferences`);
    }
    const beforeLocalMute = await sampleStats();
    settingsStore.setUserVolume(botId, 0);
    rtc.setPeerVolume(botId, 0);
    await until(() => rms() < 0.0001, `${category}: per-listener mute did not silence the bot output`);
    await until(async () => (await sampleStats())?.packetsReceived > beforeLocalMute.packetsReceived + 3,
      `${category}: per-listener mute incorrectly stopped transmission`);
    if (checkActivity) check((await syncVoiceState()).voiceState.isSpeaking, `${category}: local mute changed sender activity`);
    settingsStore.setUserVolume(botId, 100);
    rtc.setPeerVolume(botId, 100);
    await until(() => rms() > 0.005, `${category}: per-listener unmute failed to restore current audio`);
    rtc.setDeafened(true);
    check(audio.muted && rtc.mediaRouter.voicePipelines.get(botId).gain.gain.value === 0,
      `${category}: bot microphone bypassed voice deafen`);
    rtc.setDeafened(false);
    check(!audio.muted && rtc.mediaRouter.voicePipelines.get(botId).gain.gain.value > 0,
      `${category}: bot microphone did not restore its voice volume`);
    if (checkActivity) {
      const beforeRestriction = await syncVoiceState();
      await request('fixture.restrict', category.includes('rejoin')
        ? { serverMuted: false, serverDeafened: true } : { serverMuted: true, serverDeafened: false });
      check(!(await syncVoiceState()).voiceState.isSpeaking, `${category}: admin suppression left speaking active`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const muted = await sampleStats();
      await new Promise(resolve => setTimeout(resolve, 100));
      check((await sampleStats()).packetsReceived === muted.packetsReceived, `${category}: admin suppression leaked RTP`);
      check((await syncVoiceState()).frames > beforeRestriction.frames, `${category}: suppression stopped frame advancement`);
    }
    await request('fixture.pause');
    if (checkActivity) {
      await request('fixture.restrict', { serverMuted: false, serverDeafened: false });
      check(!(await syncVoiceState()).voiceState.isSpeaking, `${category}: unmute overrode manual pause`);
    }
    // Drain the jitter buffer before resuming the same RTP stream.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const paused = await sampleStats();
    check(paused, `${category}: lost inbound stats while paused`);
    const decodedBeforeResume = paused.totalSamplesReceived - paused.concealedSamples;
    const resumedAt = performance.now();
    await request('fixture.resume');
    const resumed = await until(async () => {
      const next = await sampleStats();
      return next && next.packetsReceived >= paused.packetsReceived + 3 &&
        next.totalSamplesReceived - next.concealedSamples > decodedBeforeResume &&
        rms() > 0.005 ? next : null;
    }, `${category}: Opus arrived after resume but the browser did not decode it`);
    const decodedSamples = resumed.totalSamplesReceived - resumed.concealedSamples;
    const resumeDelayMs = Math.round(performance.now() - resumedAt);
    if (checkActivity) {
      check((await syncVoiceState()).voiceState.isSpeaking && participants.get(botId).isSpeaking,
        `${category}: resumed PCM did not restore speaking activity`);
    }
    console.log(`VOICE TEST ${category}: microphone route, packets=${resumed.packetsReceived}, decodedSamples=${decodedSamples}, resumeDelayMs=${resumeDelayMs}`);
    let continuous;
    if (continuousMs) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const before = await sampleStats();
      const pacingBefore = await request('fixture.timing');
      const beforeActivity = checkActivity ? (await syncVoiceState()).updateCount : 0;
      const levels = [];
      let inactiveSpeakingProbes = 0;
      let firstInactiveState;
      const untilAt = performance.now() + continuousMs;
      while (performance.now() < untilAt) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, untilAt - performance.now())));
        levels.push(rms());
        if (checkActivity && !participants.get(botId)?.isSpeaking) {
          inactiveSpeakingProbes++;
          if (!firstInactiveState) {
            const renderer = rendererSpeakingState();
            firstInactiveState = { renderer, sdk: (await request('fixture.voice-state')).voiceState };
          }
        }
      }
      const after = await sampleStats();
      const pacingAfter = await request('fixture.timing');
      check(before && after, `${category}: lost audio during continuous playback`);
      const samples = after.totalSamplesReceived - before.totalSamplesReceived;
      const concealed = after.concealedSamples - before.concealedSamples;
      const packetMs = (after.packetsReceived - before.packetsReceived) * 20;
      const wallMs = after.timestamp - before.timestamp;
      continuous = { durationMs: wallMs, packetMs, decodedSamples: samples - concealed,
        concealedSamples: concealed, concealmentRatio: samples ? concealed / samples : 1,
        minOutputRms: Math.min(...levels), silentProbes: levels.filter(level => level <= 0.005).length,
        pacing: { before: pacingBefore, after: pacingAfter },
        ...(checkActivity ? { inactiveSpeakingProbes } : {}) };
      check(Math.abs(wallMs - packetMs) < 500, `${category}: RTP clock drift ${wallMs - packetMs} ms: ${JSON.stringify(continuous)}`);
      check(continuous.concealmentRatio < 0.05, `${category}: excessive concealment ${JSON.stringify(continuous)}`);
      check(continuous.decodedSamples > continuousMs * 40 && continuous.silentProbes <= 1,
        `${category}: generated audio was not continuously decoded`);
      if (checkActivity) {
        // Snapshot before any wire-state synchronization could repair a stale roster.
        const renderer = rendererSpeakingState();
        const afterActivity = await request('fixture.voice-state');
        continuous.activity = { renderer, sdk: afterActivity.voiceState };
        check(afterActivity.voiceState.isSpeaking && afterActivity.updateCount === beforeActivity,
          `${category}: continuous packets caused state spam or speaking flicker: ${JSON.stringify(continuous.activity)}`);
        check(inactiveSpeakingProbes === 0 && renderer?.isSpeaking,
          `${category}: the human speaking-state path lost active bot transmission: ${JSON.stringify({ continuous, firstInactiveState })}`);
      }
      console.log(`VOICE TEST ${category} continuous: ${JSON.stringify(continuous)}`);
    }
    disposeProbe();
    return { packets: resumed.packetsReceived, decodedSamples, resumeDelayMs, continuous, trackId: audio.srcObject.getAudioTracks()[0].id };
  }
  const receiveDescription = async (type) => until(async () => {
    const { signals } = await request('fixture.signals');
    for (const signal of signals) await rtc.handleIncomingSignal(signal);
    return rtc.getPeerConnection(botId)?.remoteDescription?.type === type;
  }, `Missing bot ${type} for current human membership`);
  try {
    const offer = await request('fixture.offer');
    check((offer.sdp.sdp.match(/^m=audio /gm) || []).length === 1, 'Bot must offer exactly one primary audio m-line');
    check(/^a=msid:.+ .+/m.test(offer.sdp.sdp), 'Bot offer must carry a media stream and track ID');
    await rtc.handleIncomingSignal(offer);
    await request('fixture.start-p2p');
    const p2pResult = await assertVoice('P2P', () => rtc.getPeerConnection(botId).getStats(), 12000);
    const msid = /^a=msid:(\S+) (\S+)/m.exec(offer.sdp.sdp);
    check(p2pResult.trackId === msid[2], 'Chromium microphone track must retain the bot SDP MSID track ID');
    await request('fixture.stop-media');
    rtc.closeAllPeers();
    await request('fixture.answerer');
    await rtc.connectToPeer(botId, true);
    await request('fixture.start-p2p');
    const answeringResult = await assertVoice('P2P browser-offer', () => rtc.getPeerConnection(botId).getStats(), 4000);
    await request('fixture.stop-media');
    rtc.closeAllPeers();
    await request('fixture.prepare-roster');
    check(!(await syncVoiceState()).voiceState.isSpeaking, 'Joining the roster alone must not claim speaking');
    await receiveDescription('offer');
    await request('fixture.start-roster');
    const beforeRejoin = await assertVoice('P2P roster', () => rtc.getPeerConnection(botId).getStats(), 0, true);
    rtc.closeAllPeers();
    await request('fixture.human-left');
    check(!(await syncVoiceState()).voiceState.isSpeaking, 'The last recipient left but activity remained true');
    await new Promise(resolve => setTimeout(resolve, 150));
    await request('fixture.human-rejoined');
    await rtc.connectToPeer(botId, true);
    await receiveDescription('answer');
    const membership = await request('fixture.rejoined-ready');
    check(membership.active && membership.humanParticipantCount === 1, 'Retired peer timeout disconnected the replacement');
    check(membership.rosterOffers === 1, 'Only bot admission may initiate; human rejoin must not trigger a competing bot offer');
    const rejoinedResult = await assertVoice('P2P same-session rejoin', () => rtc.getPeerConnection(botId).getStats(), 22000, true);
    check(rejoinedResult.trackId !== beforeRejoin.trackId, 'Rejoin did not use the new bot transport track');
    await request('fixture.stop-media');
    rtc.closeAllPeers();
    await request('fixture.prepare-sfu');
    check(!(await syncVoiceState()).voiceState.isSpeaking, 'Closing the SDK voice transport left stale activity');
    store.serverDetails.voiceMode = 'sfu';
    check(await rtc.sfuEngine.join('room'), 'Browser SFU engine failed to join');
    const sfuResult = await assertVoice('SFU', async () => {
      const consumer = [...rtc.sfuEngine.consumers.values()][0];
      return consumer ? consumer.getStats() : new Map();
    }, 12000);
    await request('fixture.stop-media');
    check(participants.get(botId)?.user.isBot === true, 'SFU roster lost bot identity');
    check(errors.length === 0, errors.join('; '));
    const signaling = await request('fixture.errors');
    check(signaling.errors.length === 0, signaling.errors.join('; '));
    check(signaling.candidateSignals > 0, 'Existing Chromium candidate signaling must be exercised');
    check(signaling.activityUpdates.length >= 6 && signaling.activityUpdates.length <= 12,
      'Speaking activity must be bounded transitions, not a state message per packet');
    check(signaling.activityUpdates.every((update, index) => update.isSpeaking === (index % 2 === 0)),
      'Speaking transitions did not alternate correctly');
    return { p2p: p2pResult, p2pBrowserOffer: answeringResult, rejoined: rejoinedResult, sfu: sfuResult,
      candidateSignals: signaling.candidateSignals, speakingTransitions: signaling.activityUpdates.length,
      rosterOffers: membership.rosterOffers };
  } finally {
    for (const dispose of audioProbes) dispose();
    rtc.closeAllPeers();
  }
}
