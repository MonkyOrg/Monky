const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const clientRoot = path.resolve(__dirname, '..');
const room = 'voice-recovery-room';

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `voice-recovery-${process.pid}-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_VOICE_RECOVERY_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  let deadline;
  (async () => {
    try {
      child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], {
        cwd: clientRoot, env, stdio: 'inherit',
      });
      deadline = setTimeout(() => {
        console.error('Voice recovery: Electron exceeded the global deadline');
        // This tree belongs exclusively to this invocation, including its worker.
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else child.kill('SIGKILL');
      }, 170_000);
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, 'Real Electron/mediasoup voice recovery failed');
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  })();
} else {
  void runElectronSmoke().catch(error => {
    console.error(error);
    require('electron').app.exit(1);
  });
}

async function runElectronSmoke() {
  const { app, BrowserWindow } = require('electron');
  const { WebSocketServer } = require('ws');
  const mediasoup = require('mediasoup');
  const { MessageType: M, PROTOCOL_VERSION } = require('@monky/shared');
  app.setPath('userData', process.env.MONKY_VOICE_RECOVERY_PROFILE);
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('mute-audio');
  app.on('window-all-closed', () => {});

  const windows = [];
  const fatal = [];
  const consoleTail = [];
  const transports = new Map();
  const producers = new Map();
  const consumers = new Map();
  const consumerHistory = new Map();
  const closedConsumerRequests = new Set();
  const authenticatedSockets = new WeakSet();
  const allocations = [];
  const peers = Object.fromEntries(['A', 'B'].map(label => [label, {
    label, socket: null, state: null, auths: 0, joins: 0, leaves: 0, pings: 0,
    rejectNext: 0, rejected: 0, failProduce: 0, failConsume: 0, failures: 0,
    created: { transports: 0, producers: 0, consumers: 0 }, holdJoin: false, pendingJoin: null,
    user: {
      id: `fixture-${label}`, clientId: `fixture-${label}`, sessionId: `fixture:${label}`,
      nickname: label, status: 'ONLINE', joinedAt: 1,
    },
  }]));
  let worker, workerClosed, router, ws, vite, timeout;
  let phase = 'startup';
  let finishing = false;
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const run = (window, expression) => {
    const contents = window.webContents;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.removeListener('render-process-gone', gone);
        contents.removeListener('destroyed', gone);
        if (error) reject(error);
        else resolve(value);
      };
      const gone = () => done(new Error(`Renderer unavailable during ${phase}`));
      const timer = setTimeout(() => done(new Error(`Renderer command timed out during ${phase}`)), 20_000);
      if (contents.isDestroyed() || contents.isCrashed()) return gone();
      contents.once('render-process-gone', gone);
      contents.once('destroyed', gone);
      void contents.executeJavaScript(expression, true).then(value => done(null, value), error => done(error));
    });
  };
  const until = async (probe, message, budget = 20_000) => {
    const end = Date.now() + budget;
    let last;
    while (Date.now() < end) {
      if (fatal.length) throw new Error(fatal.join('\n'));
      last = await probe();
      if (last) return last;
      await delay(50);
    }
    throw new Error(`${phase}: timed out waiting for ${message}`);
  };
  const snapshot = window => run(window, 'window.voiceRecovery.snapshot()');
  const ready = window => until(async () => {
    const state = await snapshot(window);
    if (state.errors.length) throw new Error(state.errors.join('\n'));
    return state.status === 'CONNECTED' && state.ready && !state.connecting && !state.reconnecting;
  }, 'healthy production voice state');
  const stage = name => { phase = name; console.log(`VOICE RECOVERY: ${name}`); };
  const send = (socket, type, payload, requestId) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type, payload, requestId }));
  };
  const broadcast = (type, payload, except) => {
    for (const peer of Object.values(peers)) if (peer !== except) send(peer.socket, type, payload);
  };
  const roster = () => Object.values(peers).filter(peer => peer.state)
    .map(peer => ({ user: peer.user, voiceState: peer.state }));
  const closeMedia = (peer, direction) => {
    for (const entry of [...transports.values()]) {
      if (entry.peer === peer && (!direction || entry.direction === direction)) entry.value.close();
    }
  };
  const leave = peer => {
    const wasInVoice = peer.state;
    peer.state = null;
    closeMedia(peer);
    if (wasInVoice) broadcast(M.VOICE_USER_LEFT, {
      channelId: room, sessionId: peer.user.sessionId, userId: peer.user.id,
    });
  };
  const trackAllocation = (map, value, metadata) => {
    const entry = { value, ...metadata };
    allocations.push(value);
    map.set(value.id, entry);
    value.observer.once('close', () => map.delete(value.id));
    return entry;
  };
  const describeProducer = entry => ({
    channelId: room, producerId: entry.value.id, producerSessionId: entry.peer.user.sessionId,
    kind: entry.value.kind, appData: entry.value.appData,
  });
  const ownedTransport = (peer, id, direction) => {
    const entry = transports.get(id);
    assert.ok(entry && entry.peer === peer && (!direction || entry.direction === direction), 'Owned fixture transport');
    return entry.value;
  };
  async function handle(peer, socket, message) {
    const { type, payload = {}, requestId } = message;
    const reply = (responseType, response) => send(socket, responseType, response, requestId);
    if (type === M.AUTH_CONNECT) {
      assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
      assert.equal(payload.nickname, peer.label);
      authenticatedSockets.add(socket);
      peer.auths++;
      reply(M.AUTH_SUCCESS, {
        currentUser: peer.user, iceServers: [], voiceRestrictions: { serverMuted: false, serverDeafened: false },
        server: {
          id: 'voice-recovery-fixture', name: 'Disposable loopback SFU', voiceMode: 'sfu',
          createdAt: 1, maxUsers: 2, ownerId: peers.A.user.id, myPermissions: 2147483647,
          members: Object.values(peers).map(entry => entry.user), roles: [], userRoles: [],
          channels: [{ id: room, name: 'Recovery', type: 'VOICE', position: 0 }],
          voiceStates: Object.fromEntries(roster().map(entry => [entry.user.sessionId, entry.voiceState])),
        },
      });
      return;
    }
    if (type === M.VOICE_JOIN) {
      peer.joins++;
      peer.state = {
        channelId: room, userId: peer.user.id, sessionId: peer.user.sessionId,
        isMuted: payload.isMuted, isDeafened: payload.isDeafened, isSpeaking: false,
        isCameraOn: false, isScreenSharing: false, screenShareIds: [], isSharingScreenAudio: false,
        serverMuted: false, serverDeafened: false,
      };
      const joined = { channelId: room, userId: peer.user.id, sessionId: peer.user.sessionId,
        user: peer.user, voiceState: { ...peer.state }, participants: roster() };
      broadcast(M.VOICE_USER_JOINED, joined, peer);
      if (peer.holdJoin) {
        peer.holdJoin = false;
        peer.pendingJoin = () => reply(M.VOICE_USER_JOINED, joined);
      } else reply(M.VOICE_USER_JOINED, joined);
      return;
    }
    if (type === M.VOICE_LEAVE) { peer.leaves++; leave(peer); return; }
    if (type === M.USER_LOGOUT) { leave(peer); return; }
    if (type === M.PING) { peer.pings++; reply(M.PONG, payload); return; }
    if (type === M.VOICE_STATE_UPDATE) {
      if (peer.state) {
        Object.assign(peer.state, payload);
        broadcast(M.VOICE_STATE_CHANGED, { voiceState: peer.state });
      }
      return;
    }
    if (type === M.SFU_CONSUMER_CLOSED) {
      assert.ok(authenticatedSockets.has(socket) && peer.socket === socket, 'Authenticated current fixture socket');
      const entry = consumerHistory.get(payload.consumerId);
      assert.ok(entry && entry.peer === peer && payload.channelId === room, 'Owned fixture consumer');
      // A producer/transport may already have retired this exact registered allocation.
      entry.value.close();
      assert.ok(entry.value.closed && !consumers.has(payload.consumerId), 'Consumer retirement completed');
      closedConsumerRequests.add(payload.consumerId);
      if (requestId) reply(M.SFU_CONSUMER_CLOSED, { channelId: room, consumerId: payload.consumerId });
      return;
    }
    assert.ok(peer.state && payload.channelId === room, `Voice admission before ${type}`);
    switch (type) {
      case M.SFU_GET_ROUTER_RTP_CAPABILITIES:
        reply(M.SFU_ROUTER_RTP_CAPABILITIES, { channelId: room, rtpCapabilities: router.rtpCapabilities });
        break;
      case M.SFU_CREATE_WEBRTC_TRANSPORT: {
        // Production replaces the old allocation for this direction on rejoin.
        closeMedia(peer, payload.direction);
        const value = await router.createWebRtcTransport({
          listenInfos: [{ protocol: 'udp', ip: '127.0.0.1', port: 0 }],
          enableUdp: true, enableTcp: false,
        });
        if (peer.socket !== socket || !peer.state) { value.close(); return; }
        trackAllocation(transports, value, { peer, direction: payload.direction });
        peer.created.transports++;
        value.on('dtlsstatechange', state => {
          if (state === 'failed' || state === 'closed') value.close();
        });
        reply(M.SFU_WEBRTC_TRANSPORT_CREATED, {
          channelId: room, direction: payload.direction,
          transportOptions: { id: value.id, iceParameters: value.iceParameters,
            iceCandidates: value.iceCandidates, dtlsParameters: value.dtlsParameters },
        });
        break;
      }
      case M.SFU_CONNECT_WEBRTC_TRANSPORT:
        await ownedTransport(peer, payload.transportId).connect({ dtlsParameters: payload.dtlsParameters });
        reply(M.SFU_WEBRTC_TRANSPORT_CONNECTED, { channelId: room });
        break;
      case M.SFU_GET_PRODUCERS:
        reply(M.SFU_PRODUCERS_LIST, { channelId: room, participants: roster(),
          producers: [...producers.values()].map(describeProducer) });
        break;
      case M.SFU_PRODUCE: {
        if (peer.failProduce > 0) {
          peer.failProduce--; peer.failures++;
          reply(M.SERVER_ERROR, { code: 'FIXTURE_PRODUCE', message: 'Injected microphone publication failure' });
          break;
        }
        const value = await ownedTransport(peer, payload.transportId, 'send').produce({
          kind: payload.kind, rtpParameters: payload.rtpParameters, appData: payload.appData,
        });
        const entry = trackAllocation(producers, value, { peer });
        peer.created.producers++;
        value.observer.once('close', () => broadcast(M.SFU_PRODUCER_CLOSED, { channelId: room, producerId: value.id }));
        reply(M.SFU_PRODUCED, { channelId: room, id: value.id });
        broadcast(M.SFU_NEW_PRODUCER, describeProducer(entry), peer);
        break;
      }
      case M.SFU_CONSUME: {
        if (peer.failConsume > 0) {
          peer.failConsume--; peer.failures++;
          reply(M.SERVER_ERROR, { code: 'FIXTURE_CONSUME', message: 'Injected consumer setup failure' });
          break;
        }
        const producer = producers.get(payload.producerId);
        if (!producer) {
          reply(M.SFU_PRODUCER_CLOSED, { channelId: room, producerId: payload.producerId });
          break;
        }
        assert.ok(router.canConsume({ producerId: payload.producerId, rtpCapabilities: payload.rtpCapabilities }));
        const value = await ownedTransport(peer, payload.transportId, 'recv').consume({
          producerId: payload.producerId, rtpCapabilities: payload.rtpCapabilities, paused: false,
        });
        consumerHistory.set(value.id, trackAllocation(consumers, value, { peer }));
        peer.created.consumers++;
        reply(M.SFU_CONSUMED, { channelId: room, id: value.id, producerId: payload.producerId,
          kind: value.kind, rtpParameters: value.rtpParameters,
          producerSessionId: producer.peer.user.sessionId, appData: producer.value.appData });
        break;
      }
      case M.SFU_PRODUCER_CLOSED:
        if (producers.get(payload.producerId)?.peer === peer) producers.get(payload.producerId).value.close();
        break;
      case M.SFU_CONSUMER_SET_PAUSED: {
        const entry = consumers.get(payload.consumerId);
        assert.equal(entry?.peer, peer);
        if (payload.paused) await entry.value.pause();
        else await entry.value.resume();
        break;
      }
      default: throw new Error(`Unexpected fixture request ${type}`);
    }
  }
  const finish = async code => {
    if (finishing) return;
    finishing = true;
    clearTimeout(timeout);
    try {
      for (const window of windows) {
        if (!window.isDestroyed() && !window.webContents.isCrashed()) {
          await run(window, 'window.voiceRecovery?.cleanup()');
        }
      }
    } catch (error) { console.error('Voice recovery cleanup:', error); code = 1; }
    finally {
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      if (ws) {
        for (const socket of ws.clients) socket.terminate();
        await new Promise(resolve => ws.close(resolve));
      }
      worker?.close();
      if (workerClosed) await workerClosed;
      if (vite) await vite.close();
      app.exit(code);
    }
  };
  try {
    await app.whenReady();
    timeout = setTimeout(() => {
      console.error(`Voice recovery global timeout during ${phase}`);
      void finish(1);
    }, 140_000);
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    workerClosed = once(worker, 'subprocessclose');
    worker.on('died', error => fatal.push(`mediasoup worker died: ${error.message}`));
    router = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    ] });
    ws = new WebSocketServer({
      host: '127.0.0.1', port: 0,
      verifyClient(info, done) {
        // Isolated cookies identify the participant before its AUTH_CONNECT.
        const peer = peers[/voice_recovery_peer=([AB])/.exec(info.req.headers.cookie ?? '')?.[1]];
        if (!peer) return done(false, 403);
        if (peer.rejectNext > 0) { peer.rejectNext--; peer.rejected++; return done(false, 503); }
        done(true);
      },
    });
    await once(ws, 'listening');
    ws.on('connection', (socket, request) => {
      const peer = peers[/voice_recovery_peer=([AB])/.exec(request.headers.cookie)?.[1]];
      peer.socket = socket;
      socket.on('error', error => fatal.push(`Fixture socket: ${error.message}`));
      socket.on('message', bytes => {
        void handle(peer, socket, JSON.parse(bytes.toString())).catch(error => {
          fatal.push(`Fixture ${peer.label}: ${error.stack}`);
        });
      });
      socket.on('close', () => {
        if (peer.socket !== socket) return;
        peer.socket = null;
        leave(peer);
      });
    });
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: false, root: path.join(clientRoot, 'src', 'renderer'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      resolve: { alias: { '@monky/shared': path.resolve(clientRoot, '..', '..', 'packages', 'shared', 'src', 'index.ts') } },
      optimizeDeps: { noDiscovery: true, entries: [], include: ['uuid', 'mediasoup-client', 'zod', '@sapphi-red/web-noise-suppressor'] },
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [{
        name: 'voice-recovery-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__voice_recovery__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><body>Isolated voice recovery fixture</body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const makeWindow = async label => {
      const window = new BrowserWindow({ show: false, webPreferences: {
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        partition: `voice-recovery-${label}-${process.pid}`,
      } });
      windows.push(window);
      window.webContents.setAudioMuted(true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.on('render-process-gone', (_event, details) => {
        if (!finishing) fatal.push(`Renderer ${label}: ${details.reason} (${details.exitCode})`);
      });
      window.webContents.on('console-message', (_event, level, message) => {
        if (level >= 2) {
          consoleTail.push(`${label} [${phase}] ${message}`);
          if (consoleTail.length > 40) consoleTail.shift();
        }
      });
      await window.loadURL(`http://127.0.0.1:${http.address().port}/__voice_recovery__`);
      await run(window, `(${setupRenderer.toString()})(${JSON.stringify({ port: ws.address().port, label, room, M })})`);
      return window;
    };
    const a = await makeWindow('A');
    const b = await makeWindow('B');
    check(a.webContents.session !== b.webContents.session
      && a.webContents.getOSProcessId() !== b.webContents.getOSProcessId(),
    'Participants have independent Chromium processes and storage partitions');
    const audio = async (window, audible = true, wireSilent = !audible) => {
      const result = await run(window, `window.voiceRecovery.measureAudio(${audible}, ${wireSilent})`);
      check(result.packets > 0 && result.bytes > 0 && result.samples > 0, 'New real inbound RTP and decoded samples');
      console.log(`  ${result.remote} -> ${result.local}: +${result.packets} packets, +${result.bytes} bytes, +${result.samples} samples; PCM ${result.rms.toFixed(5)}${audible ? '' : ' (silent)'}`);
      return result;
    };
    const duplex = async () => {
      await Promise.all([ready(a), ready(b)]);
      await Promise.all([audio(a), audio(b)]);
    };
    const activeCounts = () => ({ transports: transports.size, producers: producers.size, consumers: consumers.size });
    const bounded = async () => {
      check(JSON.stringify(activeCounts()) === JSON.stringify({ transports: 4, producers: 2, consumers: 2 }),
        `Exactly two transport pairs/two microphones/two consumers: ${JSON.stringify(activeCounts())}`);
      check((await router.dump()).transportIds.length === 4, 'Worker reports exactly four real transports');
    };
    stage('two isolated Chromium participants, real Opus RTP and decoded PCM');
    await run(a, 'window.voiceRecovery.join()');
    await run(b, 'window.voiceRecovery.join()');
    await duplex();
    await bounded();

    stage('idempotent SFU initialization preserves transports, producers and ongoing audio');
    const beforeInit = JSON.stringify(Object.values(peers).map(peer => peer.created));
    const mediaIds = await snapshot(a);
    await run(a, 'Promise.all([window.voiceRecovery.initSfu(), window.voiceRecovery.initSfu()])');
    check(JSON.stringify(Object.values(peers).map(peer => peer.created)) === beforeInit, 'No redundant SFU allocations');
    check(JSON.stringify((await snapshot(a)).ids) === JSON.stringify(mediaIds.ids), 'The same client-side media objects survive');
    await duplex();

    stage('two microphone publication failures cannot be hidden by healthy reception');
    const joinsBeforeFault = peers.A.joins;
    const retiredConsumer = [...consumers.values()].find(entry => entry.peer === peers.B);
    check(!!retiredConsumer, 'B owns the consumer of A before microphone replacement');
    peers.A.failProduce = 2;
    await run(a, 'window.voiceRecovery.republishMic()');
    const failedMic = await snapshot(a);
    check(failedMic.reconnecting && failedMic.retry > 0 && failedMic.receiveState === 'connected',
      'Mic failure reports recovery while the real receive transport remains connected');
    await audio(a);
    await until(() => peers.A.failures === 2, 'two injected SFU_PRODUCE errors');
    check((await snapshot(a)).reconnecting, 'Second publication failure keeps the recovery indicator');
    await duplex();
    check(peers.A.joins === joinsBeforeFault, 'SFU recovery needs no manual voice re-admission');
    await bounded();

    stage('consumer closure authenticates ownership and acknowledges exact retired allocations');
    check(retiredConsumer.value.closed && !consumers.has(retiredConsumer.value.id)
      && closedConsumerRequests.has(retiredConsumer.value.id), 'Replacement retires the original consumer, including its close request');
    const liveConsumer = [...consumers.values()].find(entry => entry.peer === peers.B);
    check(!!liveConsumer, 'B owns a replacement consumer');
    const closeMessage = consumerId => ({
      type: M.SFU_CONSUMER_CLOSED, payload: { channelId: room, consumerId }, requestId: 'fixture-ownership-check',
    });
    await assert.rejects(handle(peers.A, peers.A.socket, closeMessage(liveConsumer.value.id)), /Owned fixture consumer/);
    await assert.rejects(handle(peers.B, peers.B.socket, closeMessage('unregistered-consumer')), /Owned fixture consumer/);
    await assert.rejects(handle(peers.B, peers.A.socket, closeMessage(liveConsumer.value.id)), /Authenticated current fixture socket/);
    await assert.rejects(handle(peers.B, peers.B.socket, {
      ...closeMessage(liveConsumer.value.id), payload: { channelId: 'other-room', consumerId: liveConsumer.value.id },
    }), /Owned fixture consumer/);
    check(!liveConsumer.value.closed && consumers.get(liveConsumer.value.id) === liveConsumer,
      'Invalid close requests preserve the live registered consumer');
    const closed = await run(b, `window.voiceRecovery.closeConsumer(${JSON.stringify(retiredConsumer.value.id)})`);
    check(closed.channelId === room && closed.consumerId === retiredConsumer.value.id, 'Authenticated repeated close receives an exact correlated acknowledgement');
    for (const { value } of transports.values()) {
      check(!(await value.dump()).consumerIds.includes(retiredConsumer.value.id), 'No worker transport retains the retired consumer');
    }
    await bounded();

    stage('failed consumer setup retries automatically');
    peers.A.failConsume = 1;
    await run(b, 'window.voiceRecovery.republishMic()');
    await until(() => peers.A.failures === 3, 'injected SFU_CONSUME error');
    await until(async () => (await snapshot(a)).reconnecting, 'receive failure indicator');
    await duplex();
    await bounded();

    async function interruptAndRecover() {
      const before = await snapshot(a);
      const auths = peers.A.auths;
      const rejected = peers.A.rejected;
      peers.A.rejectNext = 2;
      peers.A.socket.terminate();
      await until(async () => (await snapshot(a)).status === 'RECONNECTING', 'lost signaling');
      const suspended = await snapshot(a);
      check(suspended.channel === room && suspended.key === before.key && suspended.reconnecting && !suspended.ready,
        'Suspension preserves call intent but releases real transports');
      check(suspended.liveCaptureTracks === 0, 'Network suspension stops the captured input');
      const allocationsBeforeOfflineInit = peers.A.created.transports;
      await run(a, 'window.voiceRecovery.initSfu()');
      check(await run(a, 'window.voiceRecovery.offlineRequestFailsImmediately()'), 'Offline requests reject without waiting for timeout');
      await until(() => peers.A.rejected === rejected + 2, 'two real HTTP 503 WebSocket upgrade rejections');
      check(peers.A.created.transports === allocationsBeforeOfflineInit, 'No SFU rebuild races disconnected signaling');
      await until(() => peers.A.auths === auths + 1, 'automatic authenticated reconnect');
      await ready(a);
      const after = await snapshot(a);
      check(after.statusHistory.slice(before.statusHistory.length).join(',') === 'RECONNECTING,CONNECTED',
        'Handshake failures never strand the retained session DISCONNECTED/CONNECTING');
      check(after.channel === before.channel && after.key === before.key
        && after.muted === before.muted && after.deafened === before.deafened, 'Channel/mute/deafen intent survives reconnect');
      check(peers.A.state.isMuted === before.muted && peers.A.state.isDeafened === before.deafened,
        'Re-admission carries the preserved privacy flags over the real WS protocol');
    }
    stage('signaling cut, two rejected WebSocket retries, automatic duplex recovery');
    await interruptAndRecover();
    await duplex();
    await bounded();

    stage('muted/deafened reconstruction remains silent, then restores in-place');
    await run(a, 'window.voiceRecovery.setPrivacy(true, true)');
    await interruptAndRecover();
    const privateState = await snapshot(a);
    check(!privateState.microphoneOpen && privateState.localTrackEnabled === false && privateState.gain === 0,
      'Rebuilt microphone and playback remain gated by real privacy controls');
    await Promise.all([audio(a, false, false), audio(b, false)]);
    await run(a, 'window.voiceRecovery.setPrivacy(true, false)');
    check((await snapshot(a)).muted, 'Undeafen preserves an independently selected microphone mute');
    await Promise.all([audio(a), audio(b, false)]);
    await run(a, 'window.voiceRecovery.setPrivacy(false, false)');
    await duplex();
    await bounded();

    stage('leave while signaling is down clears the roster immediately and never auto-rejoins');
    const authsBeforeLeave = peers.A.auths;
    const joinsBeforeLeave = peers.A.joins;
    peers.A.rejectNext = 2;
    peers.A.socket.terminate();
    await until(async () => (await snapshot(a)).reconnecting, 'network suspension before leave');
    check((await snapshot(a)).selfInRoster, 'The disconnected call still has its local roster entry');
    const left = await run(a, 'window.voiceRecovery.leave()');
    check(left.released && !left.selfInRoster && left.channel === null && left.key === null && !left.reconnecting,
      'Local hang-up releases media and roster synchronously, without a server echo');
    await until(() => peers.A.auths === authsBeforeLeave + 1, 'signaling returns after explicit leave');
    const pings = peers.A.pings;
    await until(() => peers.A.pings > pings, 'post-reconnect production heartbeat');
    check(peers.A.joins === joinsBeforeLeave && peers.A.state === null && (await snapshot(a)).released,
      'Returning signaling and an entire heartbeat cannot resurrect the abandoned call');
    check([...transports.values()].every(entry => entry.peer !== peers.A), 'No abandoned A transport remains in the worker');

    stage('leave during pending admission ignores its late successful response');
    peers.A.holdJoin = true;
    const beforePending = await snapshot(a);
    const createdBeforePending = { ...peers.A.created };
    await run(a, 'window.voiceRecovery.startPendingJoin()');
    await until(() => peers.A.pendingJoin, 'server admission response held in flight');
    check((await snapshot(a)).admissionPending, 'The real admission boundary is pending');
    const cancelled = await run(a, 'window.voiceRecovery.leave()');
    check(cancelled.released && !cancelled.selfInRoster && !cancelled.admissionPending, 'Pending admission can be cancelled locally');
    await until(() => peers.A.state === null, 'server processes explicit leave before stale success');
    peers.A.pendingJoin();
    peers.A.pendingJoin = null;
    await until(async () => (await snapshot(a)).pendingResult === 'AbortError', 'late admission settles as cancellation');
    check(JSON.stringify(peers.A.created) === JSON.stringify(createdBeforePending), 'Late admission allocated no SFU media');
    const afterPending = await snapshot(a);
    check(afterPending.captures === beforePending.captures && afterPending.released && !afterPending.selfInRoster,
      'Late success acquires no microphone and restores no local roster');

    stage('final teardown: no live transport, producer, consumer, input or playback graph');
    await run(b, 'window.voiceRecovery.leave()');
    await until(async () => (await router.dump()).transportIds.length === 0, 'worker releases all transports');
    check(transports.size === 0 && producers.size === 0 && consumers.size === 0, 'Fixture resource registries are empty');
    check(allocations.every(value => value.closed), 'Every allocated native mediasoup object is closed');
    check([...closedConsumerRequests].every(id => consumerHistory.get(id).value.closed && !consumers.has(id)),
      'Every acknowledged consumer close has a retired registered allocation');
    for (const window of windows) {
      const state = await snapshot(window);
      check(state.released && state.errors.length === 0, 'All observed Chromium media objects ended without unhandled errors');
    }
    check(fatal.length === 0, 'No renderer or worker crashes');
    console.log(`Voice recovery smoke: ${checks} checks passed (real WS, Chromium, mediasoup, RTP deltas and decoded PCM).`);
    await finish(0);
  } catch (error) {
    console.error(`Voice recovery failed during ${phase}:`, error);
    console.error('Fixture resources:', { transports: transports.size, producers: producers.size, consumers: consumers.size });
    for (const window of windows) {
      if (!window.isDestroyed() && !window.webContents.isCrashed()) {
        try { console.error('Renderer snapshot:', await snapshot(window)); } catch (reason) { console.error(reason); }
      }
    }
    console.error([...fatal, ...consoleTail].join('\n'));
    await finish(1);
  }
}

async function setupRenderer({ port, label, room, M }) {
  const [{ NetworkClient }, { sessionManager }, connection, { webRtcManager: rtc }, { audioProcessor: audio },
    { voiceStore: voice }, { settingsStore: settings }, { appEvents }, { currentEventOrigin }] = await Promise.all([
    import('/core/NetworkClient.ts'), import('/core/SessionManager.ts'), import('/core/serverConnection.ts'),
    import('/core/WebRtcManager.ts'), import('/core/AudioProcessor.ts'), import('/stores/voiceStore.ts'),
    import('/stores/settingsStore.ts'), import('/core/EventBus.ts'), import('/core/sessionRouting.ts'),
  ]);
  const errors = [];
  const statusHistory = [];
  const ownedObjects = new Set();
  const captures = [];
  const processedTracks = new Set();
  const remote = label === 'A' ? 'fixture:B' : 'fixture:A';
  let probe = null;
  let pendingResult = null;
  const onError = event => errors.push(event.error?.stack ?? event.message);
  const onRejection = event => errors.push(event.reason?.stack ?? String(event.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  settings.noiseSuppressionMode = 'off';
  settings.inputMode = 'voice_activity';
  settings.vadSensitivity = 0;
  settings.pttSoundCue = false;
  rtc.rtcConfig = { iceServers: [] };

  // Replace only the physical acquisition boundary: every stream/track, the
  // production AudioProcessor graph and Chromium RTP sender/receiver are real.
  const tone = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  const oscillator = tone.createOscillator();
  const level = tone.createGain();
  const destination = tone.createMediaStreamDestination();
  oscillator.frequency.value = label === 'A' ? 440 : 660;
  level.gain.value = 0.15;
  oscillator.connect(level).connect(destination);
  oscillator.start();
  await tone.resume();
  const originalCapture = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints.audio || constraints.video) throw new Error('Fixture only provides synthetic microphone audio');
    const track = destination.stream.getAudioTracks()[0].clone();
    captures.push(track);
    return new MediaStream([track]);
  };
  document.cookie = `voice_recovery_peer=${label}; path=/; SameSite=Lax`;
  sessionManager.install();
  const sessionForEvent = () => sessionManager.get(currentEventOrigin());
  const off = [
    appEvents.on('network.status', status => {
      statusHistory.push(status);
      if (status === 'RECONNECTING') connection.suspendCallForNetworkLoss(currentEventOrigin());
    }),
    appEvents.on('network.connected', payload => {
      const session = sessionForEvent();
      session.serverStore.setServerDetails(payload.server, payload.currentUser);
      session.serverStore.voiceRestrictions = payload.voiceRestrictions;
      session.participants.setUsers(payload.server.members);
      session.participants.reconcileVoiceChannel(room, Object.values(payload.server.voiceStates).map(state => ({
        user: payload.server.members.find(user => user.sessionId === state.sessionId), voiceState: state,
      })));
      if (voice.voiceSessionKey === session.key && voice.currentVoiceChannelId) {
        void connection.rejoinCallOnSession(session.key, voice.currentVoiceChannelId);
      }
    }),
    appEvents.on(`message.${M.VOICE_USER_JOINED}`, payload => {
      const session = sessionForEvent();
      // Own admission belongs to joinCallOnSession, not an uncorrelated event.
      if (payload.sessionId === session.serverStore.currentUser.sessionId) return;
      session.participants.addUser(payload.user);
      session.participants.updateVoiceState(payload.voiceState);
    }),
    appEvents.on(`message.${M.VOICE_USER_LEFT}`, payload => {
      sessionForEvent().participants.removeVoiceState(payload.sessionId);
      rtc.removePeer(payload.sessionId);
    }),
    appEvents.on(`message.${M.VOICE_STATE_CHANGED}`, payload => {
      sessionForEvent().participants.updateVoiceState(payload.voiceState);
    }),
    appEvents.on('voice.state_updated', () => {
      audio.setMuted(voice.getEffectiveMuted());
      audio.setDeafened(voice.getEffectiveDeafened());
      rtc.setDeafened(voice.getEffectiveDeafened());
    }),
    appEvents.on('voice.rejoin_failed', payload => errors.push(`Rejoin failed: ${payload.error}`)),
  ];
  await connection.openServerSession('127.0.0.1', port, { clientId: label, publicKey: `fixture-${label}` }, label);
  const session = sessionManager.getActive();
  if (!(session.client instanceof NetworkClient)) throw new Error('The fixture must use the production NetworkClient');
  const engine = rtc.sfuEngine;
  const clearProbe = () => {
    if (!probe) return;
    try { probe.pipeline.gain.disconnect(probe.analyser); } catch {}
    probe.analyser.disconnect();
    probe.sink.disconnect();
    probe = null;
  };
  const rms = () => {
    const pipeline = rtc.mediaRouter.voicePipelines.get(remote);
    if (probe?.pipeline !== pipeline) clearProbe();
    if (!pipeline || pipeline.gain.context.state !== 'running') return null;
    if (!probe) {
      const analyser = pipeline.gain.context.createAnalyser();
      analyser.fftSize = 2048;
      const sink = pipeline.gain.context.createGain();
      sink.gain.value = 0;
      pipeline.gain.connect(analyser).connect(sink).connect(pipeline.gain.context.destination);
      probe = { pipeline, analyser, sink, data: new Float32Array(analyser.fftSize) };
    }
    probe.analyser.getFloatTimeDomainData(probe.data);
    return Math.sqrt(probe.data.reduce((sum, value) => sum + value * value, 0) / probe.data.length);
  };
  const snapshot = () => {
    const objects = [engine.sendTransport, engine.recvTransport, ...engine.producers.values(), ...engine.consumers.values()]
      .filter(Boolean);
    objects.forEach(value => ownedObjects.add(value));
    audio.getLocalAudioStream()?.getTracks().forEach(track => processedTracks.add(track));
    if (!rtc.mediaRouter.voicePipelines.size) clearProbe();
    const tracks = [...captures, ...processedTracks];
    const liveCaptureTracks = tracks.filter(track => track.readyState === 'live').length;
    return {
      local: label, channel: voice.currentVoiceChannelId, key: voice.voiceSessionKey,
      status: session.client.getStatus(), statusHistory: [...statusHistory],
      ready: engine.isReady(), connecting: voice.isConnecting, reconnecting: voice.isReconnecting,
      retry: rtc.getVoiceStatus().sfuReconnectAttempts, receiveState: engine.recvTransport?.connectionState,
      muted: voice.isMuted, deafened: voice.isDeafened, microphoneOpen: voice.microphoneOpen,
      localTrackEnabled: audio.getLocalAudioStream()?.getAudioTracks()[0]?.enabled,
      selfInRoster: !!session.participants.get(session.serverStore.currentUser.sessionId)?.voiceState,
      admissionPending: connection.isVoiceAdmissionPending(session.key, room),
      ids: objects.map(value => value.id), captures: captures.length, liveCaptureTracks,
      gain: rtc.mediaRouter.voicePipelines.get(remote)?.gain.gain.value, rms: rms(),
      released: objects.length === 0 && [...ownedObjects].every(value => value.closed) && liveCaptureTracks === 0
        && !audio.audioContext && rtc.mediaRouter.voicePipelines.size === 0 && rtc.mediaRouter.audioContexts.size === 0,
      pendingResult, errors: [...errors],
    };
  };
  const inbound = async () => {
    const receiver = engine.getConsumerReceiver(remote);
    if (!receiver) return null;
    for (const entry of (await receiver.getStats()).values()) {
      if (entry.type === 'inbound-rtp' && entry.kind === 'audio') return {
        id: `${receiver.track.id}:${entry.id}`, bytes: entry.bytesReceived, packets: entry.packetsReceived,
        samples: entry.totalSamplesReceived, energy: entry.totalAudioEnergy, level: entry.audioLevel, rms: rms(),
      };
    }
    return null;
  };
  window.voiceRecovery = {
    snapshot,
    join: () => connection.joinCallOnSession(session.key, room),
    initSfu: () => rtc.initSfuForCurrentChannel(),
    republishMic: () => rtc.setLocalAudioTrack(audio.getLocalAudioStream().getAudioTracks()[0]),
    closeConsumer: consumerId => session.client.sendRequest(M.SFU_CONSUMER_CLOSED, { channelId: room, consumerId }),
    setPrivacy(muted, deafened) {
      voice.setDeafened(deafened);
      voice.setMuted(muted);
      session.client.send(M.VOICE_STATE_UPDATE, { isMuted: voice.isMuted, isDeafened: voice.isDeafened });
    },
    leave() { snapshot(); connection.leaveCurrentCall(); return snapshot(); },
    startPendingJoin() {
      pendingResult = null;
      void connection.joinCallOnSession(session.key, room)
        .then(() => { pendingResult = 'resolved'; }, error => { pendingResult = error.name; });
    },
    async offlineRequestFailsImmediately() {
      const started = performance.now();
      try { await session.client.sendRequest(M.SFU_GET_ROUTER_RTP_CAPABILITIES, { channelId: room }); }
      catch { return performance.now() - started < 500; }
      return false;
    },
    async measureAudio(audible, wireSilent) {
      let baseline;
      let last;
      const deadline = performance.now() + 12_000;
      while (performance.now() < deadline) {
        if (errors.length) throw new Error(errors.join('\n'));
        const current = await inbound();
        last = current;
        if (current && Number.isFinite(current.samples) && current.rms !== null) {
          if (!baseline || baseline.id !== current.id) baseline = current;
          const samples = current.samples - baseline.samples;
          const packets = current.packets - baseline.packets;
          const bytes = current.bytes - baseline.bytes;
          const energy = current.energy - baseline.energy;
          if (!audible && current.rms > 0.0003) throw new Error(`Muted audio leaked decoded PCM: ${JSON.stringify(current)}`);
          // Chromium can report zero energy/audioLevel for audible WebRTC
          // tracks; decoded post-gain PCM, not that telemetry, proves sound.
          if (packets >= (audible ? 8 : 2) && bytes > 0 && samples >= (audible ? 9600 : 48000)
            && (audible ? current.rms > 0.01 : !wireSilent || energy < 0.00001)) {
            return { remote, local: label, packets, bytes, samples, rms: current.rms, energy, audioLevel: current.level };
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`No ${audible ? 'audible' : 'silent'} fresh RTP/decoded PCM from ${remote}: ${JSON.stringify({ baseline, last })}`);
    },
    async cleanup() {
      connection.leaveCurrentCall();
      off.forEach(unsubscribe => unsubscribe());
      await sessionManager.removeAll();
      audio.destroy();
      clearProbe();
      navigator.mediaDevices.getUserMedia = originalCapture;
      captures.forEach(track => track.stop());
      destination.stream.getTracks().forEach(track => track.stop());
      oscillator.stop();
      oscillator.disconnect();
      level.disconnect();
      destination.disconnect();
      await tone.close();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    },
  };
}
