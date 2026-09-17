const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const assert = require('node:assert/strict');
  const { test } = require('node:test');
  test('full Monky voice renderer survives live SDK Opus leave/rejoin', { timeout: 150_000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `bot-voice-rejoin-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_VOICE_REJOIN_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const assert = require('node:assert/strict');
  const { once } = require('node:events');
  const { app, BrowserWindow } = require('electron');
  const { WebSocketServer } = require('ws');
  const { BotVoiceConnection } = require('@monky/bot-sdk');
  const { MessageType, Permission, isBotPublishSignalAllowed } = require('@monky/shared');
  const { bindRendererDiagnostics } = require('../dist-electron/main/rendererDiagnostics.js');
  app.setPath('userData', process.env.MONKY_VOICE_REJOIN_PROFILE);
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('mute-audio');
  app.on('window-all-closed', () => {});
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const windows = [];
  const errors = [];
  const diagnostics = [];
  const negotiations = [];
  const nativeOperations = [];
  const clients = new Map();
  const states = new Map();
  const botUser = {
    id: 'bot-fixture', clientId: 'bot-fixture', sessionId: 'bot:fixture',
    nickname: 'Opus fixture', isBot: true, joinedAt: 1, status: 'ONLINE',
  };
  let vite, socketServer, bot, audioTask, timer;
  let playing = false;
  let finishing = false;
  let phase = 'startup';
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  const run = (window, script) => new Promise((resolve, reject) => {
    if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) {
      reject(new Error(`Renderer unavailable during ${phase}`));
      return;
    }
    const contents = window.webContents;
    const finish = (error, value) => {
      clearTimeout(deadline);
      contents.removeListener('render-process-gone', gone);
      contents.removeListener('destroyed', gone);
      if (error) reject(error);
      else resolve(value);
    };
    const gone = () => finish(new Error(`Renderer exited during ${phase}`));
    const deadline = setTimeout(() => finish(new Error(`Renderer command timed out during ${phase}`)), 20_000);
    contents.once('render-process-gone', gone);
    contents.once('destroyed', gone);
    try {
      void contents.executeJavaScript(script, true).then(value => finish(null, value), error => finish(error));
    } catch (error) {
      finish(error);
    }
  });
  const until = async (condition, description) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (errors.length) throw new Error(errors.join('\n'));
      if (await condition()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${description}`);
  };
  const send = (id, message) => {
    if (id === botUser.sessionId) bot?.handle(message);
    else if (clients.get(id)?.socket.readyState === 1) clients.get(id).socket.send(JSON.stringify(message));
  };
  const broadcast = (message, except) => {
    for (const id of [...clients.keys(), botUser.sessionId]) if (id !== except) send(id, message);
  };
  const voiceState = (user, flags = {}) => ({
    userId: user.id, sessionId: user.sessionId, channelId: 'voice-room',
    isMuted: false, isDeafened: false, isSpeaking: false,
    isCameraOn: false, isScreenSharing: false, screenShareIds: [],
    isSharingScreenAudio: false,
    serverMuted: false, serverDeafened: false, ...flags,
  });
  const roster = () => [...states].map(([id, state]) => ({
    user: id === botUser.sessionId ? botUser : clients.get(id).user, voiceState: state,
  }));
  const handle = (user, message) => {
    const { type, payload = {}, requestId } = message;
    if (type === MessageType.VOICE_JOIN) {
      const state = voiceState(user, { isMuted: !!payload.isMuted, isDeafened: !!payload.isDeafened });
      states.set(user.sessionId, state);
      const joined = {
        channelId: state.channelId, userId: user.id, sessionId: user.sessionId, user, voiceState: state,
      };
      send(user.sessionId, { type: MessageType.VOICE_USER_JOINED, requestId, payload: { ...joined, participants: roster() } });
      broadcast({ type: MessageType.VOICE_USER_JOINED, payload: joined }, user.sessionId);
    } else if (type === MessageType.VOICE_LEAVE) {
      states.delete(user.sessionId);
      broadcast({
        type: MessageType.VOICE_USER_LEFT, requestId,
        payload: { channelId: payload.channelId, userId: user.id, sessionId: user.sessionId },
      });
    } else if (type === MessageType.RTC_SIGNAL) {
      if (user.isBot || payload.targetSessionId === botUser.sessionId) {
        assert.ok(isBotPublishSignalAllowed(payload, user.isBot === true),
          'Actual bot/human SDP must satisfy the production one-way voice gate');
      }
      if (payload.sdp?.sdp) {
        negotiations.push({
          phase, from: user.sessionId, type: payload.signalType,
          media: payload.sdp.sdp.split(/\r?\n/).filter(line =>
            /^m=|^a=(?:mid:|group:|sendrecv|sendonly|recvonly|inactive|rtpmap:|fmtp:|extmap:|bundle-only)/.test(line)),
        });
      }
      send(payload.targetSessionId, { type, payload: { ...payload, fromSessionId: user.sessionId } });
    } else if (type === MessageType.VOICE_STATE_UPDATE) {
      const current = states.get(user.sessionId);
      if (current) {
        Object.assign(current, payload);
        broadcast({ type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState: current } });
      }
    } else if (type === MessageType.ADMIN_GET_VOICE_RESTRICTIONS) {
      const state = [...states.values()].find(entry => entry.userId === payload.targetUserId);
      send(user.sessionId, {
        type: MessageType.VOICE_RESTRICTIONS_UPDATED, requestId,
        payload: { userId: payload.targetUserId, serverMuted: !!state?.serverMuted, serverDeafened: !!state?.serverDeafened },
      });
    } else if (type === MessageType.ADMIN_MUTE_USER || type === MessageType.ADMIN_DEAFEN_USER) {
      assert.equal(user.id, 'human-0', 'Only the authorized admin can modify server voice restrictions');
      for (const state of states.values()) {
        if (state.userId !== payload.targetUserId) continue;
        if (type === MessageType.ADMIN_MUTE_USER) state.serverMuted = payload.muted;
        else state.serverDeafened = payload.deafened;
        if (state.serverMuted || state.serverDeafened) state.isSpeaking = false;
        broadcast({ type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState: state } });
      }
      send(user.sessionId, { type, requestId, payload: { success: true } });
    } else if (type === MessageType.BOT_SCREEN_LIST) {
      send(user.sessionId, { type: MessageType.BOT_SCREEN_LIST, requestId, payload: { channelId: payload.channelId, screens: [] } });
    } else if (type === MessageType.PING) {
      send(user.sessionId, { type: MessageType.PONG, requestId, payload });
    } else if (requestId) {
      send(user.sessionId, { type, requestId, payload: {} });
    }
  };
  const finish = async code => {
    if (finishing) return;
    finishing = true;
    clearTimeout(timer);
    playing = false;
    try {
      if (audioTask) await audioTask;
      for (const window of windows) {
        if (!window.isDestroyed() && !window.webContents.isCrashed()) {
          await run(window, 'window.voiceFixture?.cleanup()');
        }
      }
      if (bot) await bot.close();
    } catch (error) {
      console.error('Voice fixture cleanup failed:', error);
      code = 1;
    } finally {
      if (errors.length > 0) code = 1;
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      if (socketServer) {
        for (const socket of socketServer.clients) socket.terminate();
        await new Promise(resolve => socketServer.close(resolve));
      }
      if (vite) await vite.close();
      fs.writeFileSync(path.join(clientRoot, 'dist-test', 'bot-voice-rejoin-diagnostics.json'),
        JSON.stringify({ phase, checks, errors, diagnostics, negotiations, nativeOperations,
          sdkEntry: require.resolve('@monky/bot-sdk') }, null, 2));
      app.exit(code);
    }
  };
  app.whenReady().then(async () => {
    timer = setTimeout(() => {
      console.error(`Voice rejoin smoke timed out during ${phase}`);
      void finish(1);
    }, 120_000);
    socketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(socketServer, 'listening');
    socketServer.on('connection', socket => {
      let user;
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === MessageType.AUTH_CONNECT) {
          const index = clients.size;
          user = {
            id: `human-${index}`, clientId: `human-${index}`, sessionId: `aaa:human-${index}`,
            nickname: `Listener ${index}`, status: 'ONLINE', joinedAt: 1,
          };
          clients.set(user.sessionId, { user, socket });
          socket.send(JSON.stringify({
            type: MessageType.AUTH_SUCCESS,
            requestId: message.requestId,
            payload: {
              currentUser: user, iceServers: [],
              voiceRestrictions: { serverMuted: false, serverDeafened: false },
              server: {
                id: 'renderer-voice-fixture', name: 'Renderer voice fixture', createdAt: 1, maxUsers: 10,
                voiceMode: 'p2p', ownerId: 'human-0',
                myPermissions: index === 0 ? 2147483647
                  : Permission.SPEAK | Permission.READ_MESSAGES | Permission.SEND_MESSAGES | Permission.USE_BOT_COMMANDS,
                roles: [], userRoles: [],
                members: [...clients.values()].map(entry => entry.user).concat(botUser),
                knownMembers: [...clients.values()].map(entry => entry.user).concat(botUser),
                channels: [
                  { id: 'text-room', name: 'Text', type: 'TEXT', position: 0 },
                  { id: 'voice-room', name: 'Voice', type: 'VOICE', position: 1 },
                ],
                voiceStates: Object.fromEntries(states),
              },
            },
          }));
          broadcast({ type: MessageType.USER_JOINED, payload: { user } }, user.sessionId);
        } else if (user) handle(user, message);
      });
    });
    const { createServer } = await import('vite');
    const mainPath = path.join(clientRoot, 'src', 'renderer', 'main.ts');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'full-voice-renderer-fixture', enforce: 'pre',
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) {
            return { code: `${code}\nexport { App as VoiceRejoinTestApp };`, map: null };
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__voice_rejoin__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/footerControls.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const createRenderer = async name => {
      const window = new BrowserWindow({
      show: false, width: 1280, height: 1000,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
        partition: `voice-rejoin-${name}`,
      },
      });
      windows.push(window);
      bindRendererDiagnostics(window.webContents, { write: entry => diagnostics.push(entry) });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('render-process-gone', (_event, details) => {
        errors.push(`Renderer ${name} gone during ${phase}: ${details.reason}, exitCode=${details.exitCode}`);
      });
      window.webContents.on('console-message', (_event, level, message) => {
        if (message.startsWith('VOICE_NATIVE_STEP ')) {
          nativeOperations.push({ phase, renderer: name, ...JSON.parse(message.slice('VOICE_NATIVE_STEP '.length)) });
        }
        if (level >= 3) errors.push(`[renderer:${name}:${phase}] ${message}`);
      });
      await window.loadURL(`http://127.0.0.1:${http.address().port}/__voice_rejoin__`);
      await run(window, `(${setupFullVoiceRenderer.toString()})(${socketServer.address().port},${process.env.MONKY_VOICE_REJOIN_TRACE === '1'})`);
      return window;
    };
    phase = 'full renderer setup';
    const window = await createRenderer('primary');
    const packets = (await run(window, 'window.voiceFixture.authoredOpus()')).map(bytes => Uint8Array.from(bytes));
    check(packets.length > 25, 'Native Opus encoder produced authored stereo test media');
    phase = 'human joins before bot';
    await run(window, 'window.voiceFixture.join()');
    const guest = await createRenderer('guest');
    await run(guest, 'window.voiceFixture.join()');
    bot = new BotVoiceConnection('voice-room', {
      currentUser: botUser, server: { voiceMode: 'p2p' }, iceServers: [],
    }, {
      send: message => queueMicrotask(() => handle(botUser, message)),
      participants: () => {},
      disconnected: reason => { if (!finishing) errors.push(`Unexpected SDK disconnection: ${reason}`); },
      error: error => errors.push(`SDK: ${error.message}`),
    });
    phase = 'bot initiates live Opus';
    await bot.join();
    playing = true;
    audioTask = (async () => {
      let packetIndex = 0;
      let nextAt = performance.now();
      while (playing) {
        if (performance.now() - nextAt > 100) nextAt = performance.now();
        await bot.writeOpus(packets[packetIndex++ % packets.length]);
        nextAt += 20;
        await delay(Math.max(0, nextAt - performance.now()));
      }
    })().catch(error => {
      playing = false;
      errors.push(`SDK audio writer: ${error instanceof Error ? error.message : String(error)}`);
    });
    await until(() => run(window, 'window.voiceFixture.receiving()'), 'initial decoded SDK audio');
    check(await run(window, 'window.voiceFixture.graphActive()'), 'Real RNNoise, remote audio graph, and stage are active');
    phase = 'independent second listener';
    await until(() => run(guest, 'window.voiceFixture.receiving()'), 'guest receives the same live SDK track');
    check(states.get(botUser.sessionId).isMuted === false && states.get(botUser.sessionId).isDeafened === false,
      'Lack of bot audio reception never appears as voluntary mute/deafen');
    for (const listener of [window, guest]) {
      await until(() => run(listener, 'window.voiceFixture.speaking()'), 'bot uses human sidebar/stage speaking classes');
      check(await run(listener, 'window.voiceFixture.noPublicationToBot()'),
        'Human microphone tracks are never attached to the live bot audio connection');
    }
    const speakingPackets = await Promise.all([window, guest].map(listener =>
      run(listener, 'window.voiceFixture.receivedPackets()')));
    await delay(750);
    for (const [index, listener] of [window, guest].entries()) {
      check(await run(listener, `(async () => window.voiceFixture.speaking() && (await window.voiceFixture.receivedPackets()) > ${speakingPackets[index]})()`),
        'Continued RTP transmission keeps the human speaking visual despite zero receiver telemetry');
    }
    phase = 'per-listener local mute';
    await run(window, 'window.voiceFixture.localVolume(0)');
    await until(() => run(window, 'window.voiceFixture.voiceRms() < 0.0001'), 'locally muted decoded PCM');
    check(await run(window, 'window.voiceFixture.botGain() === 0'), 'Human volume/mute control silences the bot locally');
    check(await run(guest, 'window.voiceFixture.botGain() === 1 && window.voiceFixture.voiceRms() > 0.005'), 'Another listener keeps their independent decoded audio');
    check(states.get(botUser.sessionId).serverMuted === false && states.get(botUser.sessionId).isMuted === false,
      'Local mute never changes bot transmission or server restrictions');
    await run(window, 'window.voiceFixture.localVolume(100)');
    await until(() => run(window, 'window.voiceFixture.voiceRms() > 0.005'), 'local decoded audio restoration');
    check(await run(window, 'window.voiceFixture.botGain() === 1'), 'Local restore resumes the same stream');
    check(await run(guest, 'window.voiceFixture.hasAdminControls()') === false, 'An ordinary listener gets no administrative controls');
    phase = 'server-admin mute';
    await run(window, 'window.voiceFixture.adminMute()');
    await until(() => states.get(botUser.sessionId).serverMuted === true, 'admin mute acknowledged');
    for (const listener of [window, guest]) {
      await until(() => run(listener, 'window.voiceFixture.botGain() === 0 && window.voiceFixture.voiceRms() < 0.0001 && !window.voiceFixture.speaking()'),
        'global mute gates playback and the shared speaking visual');
    }
    await run(window, 'window.voiceFixture.adminMute()');
    await until(() => states.get(botUser.sessionId).serverMuted === false, 'admin unmute acknowledged');
    for (const listener of [window, guest]) {
      await until(() => run(listener, 'window.voiceFixture.botGain() === 1 && window.voiceFixture.voiceRms() > 0.005 && window.voiceFixture.speaking()'),
        'unmute restores the same playback and speaking path');
    }
    check(errors.length === 0, 'Both complete renderers remained alive through local/global mute');
    console.log(`Full renderer bot controls: ${checks} checks passed (authored Opus, two listeners, local/admin mute, shared speaking UI)`);
    await run(guest, 'window.voiceFixture.leave()');
    await until(() => run(guest, 'window.voiceFixture.mediaReleased()'), 'guest media release');
    phase = 'one-way media authorization';
    check(await run(window, 'window.voiceFixture.verifyOneWayPublication()'),
      'Changing microphone, camera, screen video and screen audio cannot publish a track to the bot');
    for (let round = 0; round < 5; round++) {
      phase = `leave ${round + 1}`;
      await run(window, 'window.voiceFixture.leave()');
      await until(() => run(window, 'window.voiceFixture.mediaReleased()'), 'all old media released');
      check(!states.has('aaa:human-0'), 'Only the leaving listener exits; bot stays in voice');
      check(states.has(botUser.sessionId), 'The same SDK voice connection remains alive');
      await delay(round === 0 ? 3000 : 100);
      phase = `human rejoin ${round + 1}`;
      await run(window, 'window.voiceFixture.join()');
      await until(() => run(window, 'window.voiceFixture.receiving()'), 'decoded SDK audio after rejoin');
      check(await run(window, 'window.voiceFixture.graphActive()'), 'Fresh real graphs and stage survive rejoin');
      check(await run(window, 'window.voiceFixture.noPublicationToBot()'), 'Rejoining does not reintroduce human media senders toward the bot');
      check(errors.length === 0, 'No renderer, signaling, or SDK errors');
    }
    phase = 'steady full-renderer audio after rejoin';
    for (let sample = 0; sample < 88; sample++) {
      await delay(250);
      check(await run(window, 'window.voiceFixture.speaking() && window.voiceFixture.voiceRms() > 0.005'),
        'Twenty-two seconds of decoded audio keep the actual participant and stage speaking state active');
      if (errors.length) throw new Error(errors.join('\n'));
    }
    phase = 'final teardown';
    await run(window, 'window.voiceFixture.leave()');
    await until(() => run(window, 'window.voiceFixture.mediaReleased()'), 'final media release');
    check(diagnostics.length === 0, 'No renderer process was lost');
    console.log(`Full renderer SDK voice rejoin: ${checks} checks passed (RNNoise, decoded authored Opus, five rejoins, 22s continuous speaking, two listeners, local/admin mute)`);
    await finish(0);
  }).catch(async error => {
    console.error(`Full voice renderer failed during ${phase}:`, error);
    for (const message of errors) console.error(message);
    const snapshots = await Promise.allSettled(windows
      .filter(window => !window.isDestroyed() && !window.webContents.isCrashed())
      .map(window => run(window, 'window.voiceFixture?.audioDiagnostics()')));
    for (const snapshot of snapshots) {
      console.error('Generated audio diagnostics:', snapshot.status === 'fulfilled' ? snapshot.value : snapshot.reason);
    }
    await finish(1);
  });
}

async function setupFullVoiceRenderer(port, traceNative = false) {
  const logs = [];
  const runtimeErrors = [];
  const onError = event => runtimeErrors.push(event.error?.stack ?? event.message);
  const onRejection = event => runtimeErrors.push(event.reason?.stack ?? String(event.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.api = {
    onAppBeforeQuit: () => () => {},
    setWindowInServer: async () => {},
    setLanguage: async () => {},
    setPttConfig: async () => true,
    fitHomeWindowToContent: async () => {},
    hostServerStatus: async () => ({ isRunning: false, port: null, serverId: null }),
    onHostServerStatusChanged: () => () => {},
    writeClientLog: async entry => { logs.push(entry); if (entry.level === 'ERROR') console.error(entry.message); },
  };
  const [
    { VoiceRejoinTestApp }, { audioProcessor }, { webRtcManager }, { voiceStore },
    { settingsStore }, { sessionManager }, { openServerSession },
  ] = await Promise.all([
    import('/main.ts'), import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/SessionManager.ts'), import('/core/serverConnection.ts'),
  ]);
  // Only unrelated startup I/O is skipped. The application, signaling, capture,
  // RNNoise, Web Audio playback, participants and stage use their real methods.
  VoiceRejoinTestApp.prototype.init = async () => {};
  const app = new VoiceRejoinTestApp();
  app.setupGlobalEventListeners();
  settingsStore.noiseSuppressionMode = 'rnnoise';
  webRtcManager.rtcConfig = { iceServers: [], iceCandidatePoolSize: 4 };
  await openServerSession('127.0.0.1', port, { clientId: 'fixture', publicKey: 'fixture' }, 'Listener');
  const session = sessionManager.getActive();
  let voiceProbe = null;
  const disposeVoiceProbe = () => {
    if (!voiceProbe) return;
    const { pipeline, analyser, silentSink } = voiceProbe;
    voiceProbe = null;
    if (webRtcManager.mediaRouter.voicePipelines.get('bot:fixture') === pipeline
        && pipeline.gain.context.state !== 'closed') pipeline.gain.disconnect(analyser);
    analyser.disconnect();
    silentSink.disconnect();
  };
  const restoreNativeTrace = [];
  if (traceNative) {
    const record = (operation, subject, argument) => {
      const peer = [...webRtcManager.peers.values()].find(entry => entry.pc === subject
        || entry.pc.getSenders().includes(subject) || entry.pc.getTransceivers().includes(subject));
      console.debug('VOICE_NATIVE_STEP ' + JSON.stringify({
        operation, argument, peer: peer?.peerSessionId,
        signaling: peer?.pc.signalingState, connection: peer?.pc.connectionState,
        transceivers: peer?.pc.getTransceivers().map(transceiver => ({
          mid: transceiver.mid, direction: transceiver.direction,
          currentDirection: transceiver.currentDirection, stopped: transceiver.stopped,
          senderKind: transceiver.sender.track?.kind,
          senderState: transceiver.sender.track?.readyState,
          receiverKind: transceiver.receiver.track.kind,
          receiverState: transceiver.receiver.track.readyState,
        })),
      }));
    };
    for (const [prototype, methods] of [
      [RTCPeerConnection.prototype, ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription', 'addIceCandidate']],
      [RTCRtpSender.prototype, ['replaceTrack', 'setParameters']],
      [RTCRtpTransceiver.prototype, ['setCodecPreferences']],
    ]) {
      for (const method of methods) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (!descriptor || typeof descriptor.value !== 'function') throw new Error(`Missing native operation ${method}`);
        const original = descriptor.value;
        Object.defineProperty(prototype, method, { ...descriptor, value: function(...args) {
          const operation = `${prototype.constructor.name}.${method}`;
          const argument = args[0]?.type ?? args[0]?.kind ?? args[0]?.sdpMid;
          record(`${operation}:start`, this, argument);
          let result;
          try {
            result = original.apply(this, args);
          } catch (error) {
            record(`${operation}:error`, this, argument);
            throw error;
          }
          if (result instanceof Promise) {
            return result.then(value => {
              record(`${operation}:done`, this, argument);
              return value;
            }, error => {
              record(`${operation}:error`, this, argument);
              throw error;
            });
          }
          record(`${operation}:done`, this, argument);
          return result;
        } });
        restoreNativeTrace.push(() => Object.defineProperty(prototype, method, descriptor));
      }
    }
  }
  const until = async predicate => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Renderer state did not settle');
  };
  let previousTracks = [];
  let previousContexts = [];
  let previousUnmuteCallbacks = [];
  let previousPeers = [];
  window.voiceFixture = {
    logs,
    async authoredOpus() {
      const packets = [];
      let failure;
      const encoder = new AudioEncoder({
        output: chunk => {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          packets.push([...bytes]);
        },
        error: error => { failure = error; },
      });
      try {
        encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 });
        for (let frame = 0; frame < 50; frame++) {
          const samples = new Float32Array(960 * 2);
          for (let i = 0; i < 960; i++) {
            samples[i] = samples[i + 960] = 0.15 * Math.sin(2 * Math.PI * 440 * (frame * 960 + i) / 48000);
          }
          const data = new AudioData({
            format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 2,
            timestamp: frame * 20000, data: samples,
          });
          encoder.encode(data);
          data.close();
        }
        await encoder.flush();
        if (failure) throw failure;
        return packets;
      } finally {
        if (encoder.state !== 'closed') encoder.close();
      }
    },
    async join() {
      const channel = document.querySelector('[data-channel-id="voice-room"][data-channel-type="VOICE"]');
      if (!channel) throw new Error('Actual voice channel control is missing');
      channel.click();
      await until(() => voiceStore.currentVoiceChannelId === 'voice-room' && !voiceStore.isConnecting
        && !!document.querySelector('.voice-stage-container'));
    },
    async leave() {
      disposeVoiceProbe();
      previousPeers = [...webRtcManager.peers.values()];
      previousTracks = [
        ...(audioProcessor.getLocalAudioStream()?.getTracks() ?? []),
        ...(audioProcessor.getRawMicrophoneStream()?.getTracks() ?? []),
        ...[...webRtcManager.peers.values()].flatMap(peer => peer.remoteStream.getTracks()),
      ];
      previousContexts = [audioProcessor.audioContext, ...webRtcManager.mediaRouter.audioContexts.values()].filter(Boolean);
      previousUnmuteCallbacks = [...webRtcManager.peers.values()].flatMap(peer =>
        peer.remoteStream.getAudioTracks().filter(track => track.onunmute).map(track =>
          track.onunmute.bind(track)));
      const leave = document.getElementById('sidebar-btn-leave-voice');
      if (!leave) throw new Error('Actual leave-voice control is missing');
      leave.click();
      await until(() => voiceStore.currentVoiceChannelId === null);
      for (const onUnmute of previousUnmuteCallbacks) onUnmute(new Event('unmute'));
    },
    async receiving() {
      const peer = webRtcManager.peers.get('bot:fixture');
      if (!peer || peer.pc.connectionState !== 'connected') return false;
      const reports = await peer.pc.getStats();
      return [...reports.values()].some(report => report.type === 'inbound-rtp'
        && report.kind === 'audio' && report.packetsReceived > 8 && report.totalSamplesReceived > 0)
        && this.voiceRms() > 0.005;
    },
    noPublicationToBot() {
      const peer = webRtcManager.peers.get('bot:fixture');
      return peer?.receiveOnly === true && peer.pc.getSenders().every(sender => sender.track === null)
        && peer.pc.getTransceivers().every(transceiver =>
          transceiver.direction === 'recvonly' || transceiver.direction === 'inactive');
    },
    async verifyOneWayPublication() {
      const original = webRtcManager.localAudioTrack;
      if (!original) throw new Error('The real microphone capture must be active for this check');
      const microphone = original.clone();
      const desktopAudio = original.clone();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      canvas.getContext('2d').fillRect(0, 0, 32, 32);
      const camera = canvas.captureStream(5);
      const screen = canvas.captureStream(5);
      try {
        await webRtcManager.setLocalAudioTrack(microphone);
        await webRtcManager.setLocalCameraTrack(camera.getVideoTracks()[0]);
        await webRtcManager.addLocalScreenTrack(screen);
        await webRtcManager.setLocalScreenAudioTrack(desktopAudio);
        return this.noPublicationToBot();
      } finally {
        await webRtcManager.setLocalScreenAudioTrack(null);
        await webRtcManager.removeLocalScreenTrack(screen.id);
        await webRtcManager.setLocalCameraTrack(null);
        await webRtcManager.setLocalAudioTrack(original);
        for (const track of [microphone, desktopAudio, ...camera.getTracks(), ...screen.getTracks()]) track.stop();
      }
    },
    async receivedPackets() {
      const peer = webRtcManager.peers.get('bot:fixture');
      if (!peer) return 0;
      const reports = await peer.pc.getStats();
      return [...reports.values()].filter(report => report.type === 'inbound-rtp' && report.kind === 'audio')
        .reduce((total, report) => total + report.packetsReceived, 0);
    },
    async audioDiagnostics() {
      const peer = webRtcManager.peers.get('bot:fixture');
      const reports = peer ? await peer.pc.getStats() : new Map();
      const fields = ['packetsReceived', 'bytesReceived', 'totalAudioEnergy', 'audioLevel',
        'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples'];
      return {
        voice: session.participants.get('bot:fixture')?.voiceState,
        connection: peer?.pc.connectionState,
        inbound: [...reports.values()].filter(report => report.type === 'inbound-rtp' && report.kind === 'audio')
          .map(report => Object.fromEntries(fields.map(field => [field, report[field]]))),
        gain: this.botGain(),
        rms: this.voiceRms(),
      };
    },
    graphActive() {
      return audioProcessor.noiseSuppressorNode !== null && audioProcessor.audioContext?.state === 'running'
        && webRtcManager.mediaRouter.voicePipelines.has('bot:fixture')
        && document.querySelectorAll('audio[data-peer-session="bot:fixture"]').length === 1
        && !!document.querySelector('.voice-stage-container');
    },
    botGain() { return webRtcManager.mediaRouter.voicePipelines.get('bot:fixture')?.gain.gain.value; },
    voiceRms() {
      const pipeline = webRtcManager.mediaRouter.voicePipelines.get('bot:fixture');
      if (pipeline !== voiceProbe?.pipeline) {
        disposeVoiceProbe();
        if (!pipeline || pipeline.gain.context.state !== 'running') return 0;
        // Measure decoded post-volume PCM while a zero-gain sink keeps the fixture inaudible.
        const analyser = pipeline.gain.context.createAnalyser();
        analyser.fftSize = 2048;
        const silentSink = pipeline.gain.context.createGain();
        silentSink.gain.value = 0;
        pipeline.gain.connect(analyser);
        analyser.connect(silentSink);
        silentSink.connect(pipeline.gain.context.destination);
        voiceProbe = { pipeline, analyser, silentSink, samples: new Float32Array(analyser.fftSize) };
      }
      if (!voiceProbe || voiceProbe.pipeline.gain.context.state !== 'running') return 0;
      voiceProbe.analyser.getFloatTimeDomainData(voiceProbe.samples);
      return Math.sqrt(voiceProbe.samples.reduce((sum, value) => sum + value * value, 0) / voiceProbe.samples.length);
    },
    speaking() {
      return session.participants.get('bot:fixture')?.isSpeaking === true
        && document.getElementById('voice-mini-user-bot:fixture')?.classList.contains('speaking')
        && document.querySelector('[data-session-id="bot:fixture"][data-kind=voice]')?.classList.contains('speaking');
    },
    openMenu() {
      const card = document.querySelector('[data-session-id="bot:fixture"][data-kind=voice]');
      if (!card) throw new Error('The normal bot participant card is missing');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
    },
    async localVolume(volume) {
      this.openMenu();
      const button = document.getElementById(`ctx-vol-${volume}`);
      if (!button) throw new Error('The human per-listener volume control is missing');
      button.click();
      (await import('/views/UserContextMenu.ts')).userContextMenu.close();
    },
    async hasAdminControls() {
      this.openMenu();
      const found = !!document.querySelector('.user-context-menu [data-action="server-mute"]');
      (await import('/views/UserContextMenu.ts')).userContextMenu.close();
      return found;
    },
    async adminMute() {
      this.openMenu();
      await until(() => document.querySelector('.user-context-menu [data-action="server-mute"]')?.disabled === false);
      document.querySelector('.user-context-menu [data-action="server-mute"]').click();
      await until(() => !document.querySelector('.user-context-menu'));
    },
    mediaReleased() {
      return !audioProcessor.getLocalAudioStream() && webRtcManager.peers.size === 0
        && webRtcManager.mediaRouter.voicePipelines.size === 0 && webRtcManager.mediaRouter.audioContexts.size === 0
        && webRtcManager.vadMonitor.remoteAudioVads.size === 0
        && document.querySelectorAll('audio[data-peer-session]').length === 0
        && previousTracks.every(track => track.readyState === 'ended')
        && previousContexts.every(context => context.state === 'closed')
        && previousPeers.every(peer => peer.pc.connectionState === 'closed'
          && peer.pc.ontrack === null && peer.pc.onicecandidate === null
          && peer.pc.onconnectionstatechange === null && peer.pc.oniceconnectionstatechange === null);
    },
    async cleanup() {
      try {
        disposeVoiceProbe();
        if (voiceStore.currentVoiceChannelId) app.mainView.voiceStageView.leaveVoice();
        app.mainView.destroy();
        sessionManager.remove(session.key);
        audioProcessor.destroy();
        webRtcManager.closeAllPeers();
        if (runtimeErrors.length > 0) throw new Error(runtimeErrors.join('\n'));
      } finally {
        for (const restore of restoreNativeTrace) restore();
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
      }
    },
  };
}
