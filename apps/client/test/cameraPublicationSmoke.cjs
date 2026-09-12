const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');
const scenarioArgument = process.argv.find(argument => argument.startsWith('--scenario='));
const scenarioFilter = scenarioArgument?.slice('--scenario='.length) ?? '';
const mdnsControl = process.argv.includes('--mdns-control');

if (!process.versions.electron) {
  const output = path.join(clientRoot, 'dist-test');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'camera-publication-profile-'));
  const env = { ...process.env, MONKY_CAMERA_PUBLICATION_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [
    __filename, ...(scenarioArgument ? [scenarioArgument] : []), ...(mdnsControl ? ['--mdns-control'] : []),
  ], {
    cwd: clientRoot, env, stdio: 'inherit',
  });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  const timeout = setTimeout(() => {
    console.error('Camera publication smoke: Electron exceeded 180 seconds');
    child.kill();
  }, 180_000);
  child.once('error', error => {
    clearTimeout(timeout);
    console.error(error);
    cleanup();
    process.exitCode = 1;
  });
  child.once('exit', code => {
    clearTimeout(timeout);
    cleanup();
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow, session } = require('electron');
  const profile = process.env.MONKY_CAMERA_PUBLICATION_PROFILE;
  if (!profile || path.dirname(profile) !== path.join(clientRoot, 'dist-test')
    || !path.basename(profile).startsWith('camera-publication-profile-')) {
    throw new Error('Run this smoke with Node so it owns an isolated temporary profile');
  }
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  // This isolated fixture denies media permission; its native ICE must not
  // depend on CI having a working LAN mDNS resolver.
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  if (!mdnsControl) {
    const disabled = new Set(app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean));
    disabled.add('WebRtcHideLocalIpsWithMdns');
    app.commandLine.appendSwitch('disable-features', [...disabled].join(','));
  }
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  let finishing = false;
  const finish = async code => {
    if (finishing) return;
    finishing = true;
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const blocked = [];
    const permissionRequests = [];
    let allowedOrigin = '';
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      permissionRequests.push(permission);
      callback(false);
    });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const allowed = url.origin === allowedOrigin || ['data:', 'blob:', 'about:'].includes(url.protocol);
      if (!allowed) blocked.push(details.url);
      callback({ cancel: !allowed });
    });
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      cacheDir: path.join(profile, 'vite-cache'),
      resolve: {
        alias: {
          'camera-publication-producer': path.join(path.dirname(require.resolve('mediasoup-client')), 'Producer.js'),
        },
      },
      optimizeDeps: { include: ['camera-publication-producer', 'mediasoup-client'] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'camera-publication-fixture',
        resolveId(id) {
          if (id === '/__camera_publication_modules__.js') return id;
        },
        load(id) {
          if (id === '/__camera_publication_modules__.js') {
            return 'export { Producer } from "camera-publication-producer"; export { MessageType } from "@monky/shared";';
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            // CSS imports still load Vite's client with hmr:false. Preserve styles,
            // but do not start its websocket/reconnect machinery in this fixture.
            if (request.url?.split('?')[0] === '/@vite/client') {
              response.setHeader('Content-Type', 'application/javascript');
              response.end(`
                const styles = new Map();
                export function updateStyle(id, css) {
                  let style = styles.get(id);
                  if (!style) {
                    style = document.createElement('style');
                    document.head.appendChild(style);
                    styles.set(id, style);
                  }
                  style.textContent = css;
                }
                export function removeStyle(id) {
                  styles.get(id)?.remove();
                  styles.delete(id);
                }
                export function createHotContext() {
                  return { accept() {}, dispose() {}, prune() {}, on() {}, off() {}, data: {} };
                }
              `);
              return;
            }
            if (request.url !== '/__camera_publication__') return next();
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
      httpServer.listen(0, '127.0.0.1', () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
    allowedOrigin = `http://127.0.0.1:${address.port}`;
    window = new BrowserWindow({
      show: false, width: 1000, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== allowedOrigin) event.preventDefault();
    });
    window.webContents.on('console-message', (_event, _level, message) => {
      if (message.startsWith('CAMERA ')) console.log(message);
    });
    timeout = setTimeout(() => {
      console.error('Camera publication smoke: renderer timed out');
      void finish(1);
    }, 165_000);
    await window.loadURL(`${allowedOrigin}/__camera_publication__`);
    const result = await window.webContents.executeJavaScript(
      `(${runCameraPublicationSmoke.toString()})(${JSON.stringify(scenarioFilter)}).catch(error => {
        throw new Error(error?.stack || String(error));
      })`,
      true,
    );
    if (blocked.length || permissionRequests.length) {
      result.failures.push({
        scenario: 'isolation',
        message: JSON.stringify({ blocked, permissionRequests }),
      });
    }
    console.log(`Camera publication smoke: ${result.checks} checks passed; ${result.scenarios} scenarios; ${result.failures.length} failures`);
    for (const failure of result.failures) {
      console.error(`FAIL ${failure.scenario}: ${failure.message}`);
    }
    await finish(result.failures.length ? 1 : 0);
  }).catch(async error => {
    console.error(error);
    await finish(1);
  });
}

async function runCameraPublicationSmoke(filter) {
  const media = navigator.mediaDevices;
  const originalCapture = media.getUserMedia;
  const originalEnumerate = media.enumerateDevices;
  const originalDisplay = media.getDisplayMedia;
  const originalApi = window.api;
  const nativePeerConnection = window.RTCPeerConnection;
  const activeConnections = new Set();
  const unexpected = [];
  const onUnhandled = event => {
    unexpected.push(event.reason?.stack || String(event.reason));
    event.preventDefault();
  };
  window.addEventListener('unhandledrejection', onUnhandled);

  // No path through this fixture can fall back to a physical device or STUN/TURN.
  media.getUserMedia = async () => { throw new Error('Synthetic capture has not been configured'); };
  media.getDisplayMedia = async () => { throw new Error('Display capture is forbidden in this smoke'); };
  media.enumerateDevices = async () => ['camera-a', 'camera-b', 'camera-c'].map(deviceId => ({
    deviceId, groupId: 'synthetic-camera', kind: 'videoinput', label: `Fixture ${deviceId}`,
  }));
  window.RTCPeerConnection = class extends nativePeerConnection {
    constructor(configuration = {}) {
      if (configuration.iceServers?.length) throw new Error('External ICE servers are forbidden in this smoke');
      super({ ...configuration, iceServers: [], iceCandidatePoolSize: 0 });
      activeConnections.add(this);
    }
    close() {
      super.close();
      activeConnections.delete(this);
    }
  };
  window.api = {
    openOverlay: async () => ({ success: true }),
    closeOverlay: async () => ({ success: true }),
    sendOverlaySyncState: async () => {},
  };

  const [{ Producer, MessageType }, { webRtcManager: rtc }, { videoService: video },
    publication, { appEvents: events }, { voiceStore: voice }, { settingsStore: settings },
    { serverStore: server }, { participantManager: participants },
    { networkClient: network }, { VoiceVideoTab }, { VoiceStageView }, { OverlayBridgeService },
    { CameraEffectError }, { cameraEffectErrorMessage }] = await Promise.all([
    import('/__camera_publication_modules__.js'),
    import('/core/WebRtcManager.ts'), import('/core/VideoService.ts'),
    import('/core/CameraPublication.ts'), import('/core/EventBus.ts'),
    import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/stores/serverStore.ts'),
    import('/core/ParticipantManager.ts'), import('/core/NetworkClient.ts'),
    import('/views/settings/tabs/VoiceVideoTab.ts'), import('/views/VoiceStageView.ts'),
    import('/core/OverlayBridgeService.ts'), import('/utils/cameraEffects.ts'),
    import('/utils/cameraEffectErrors.ts'),
  ]);

  let checks = 0;
  let scenarios = 0;
  let resources;
  let captureGate;
  let signalQueue = Promise.resolve();
  const failures = [];
  const sent = [];
  const captures = [];
  const sourceCanvases = new WeakMap();
  const captureRequests = [];
  const routes = new Map();
  const context = new AudioContext();
  const audioDestination = context.createMediaStreamDestination();
  const originalSend = network.send;
  const originalRequest = network.sendRequest;
  const originalSignalDescriptor = Object.getOwnPropertyDescriptor(rtc, 'signalClient');
  const originalRtcConfiguration = rtc.rtcConfig;
  const self = { id: 'fixture-user', sessionId: 'fixture-self', nickname: 'Camera fixture', status: 'CONNECTED' };
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? '' : `; actual=${JSON.stringify(detail)}`}`);
    checks++;
  };
  const tick = (milliseconds = 20) => new Promise(resolve => setTimeout(resolve, milliseconds));
  const bounded = async (promise, label, milliseconds = 10_000) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const until = async (probe, label, milliseconds = 8000) => {
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await tick();
    }
    throw new Error(`Timed out: ${label}`);
  };
  const observe = promise => promise.then(value => ({ value }), error => ({ error }));
  const rejected = async (promise, label, name) => {
    const result = await bounded(observe(promise), label);
    check(result.error instanceof Error && (!name || result.error.name === name), label, {
      name: result.error?.name, message: result.error?.message, resolved: !result.error,
    });
    return result.error;
  };
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    resources.gates.push(resolve);
    return { promise, resolve, reject };
  };
  const patch = (object, key, value) => {
    const previous = object[key];
    object[key] = value;
    resources.restore.push(() => { object[key] = previous; });
    return previous;
  };
  const listen = (name, callback) => {
    const off = events.on(name, callback);
    resources.cleanup.push(off);
    return off;
  };
  const listenerCount = name => events.listeners.get(name)?.size ?? 0;
  const pc = () => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    resources.pcs.push(connection);
    return connection;
  };
  const cameraInput = { width: 160, height: 90 };
  const source = (color = '#00ff00', width = 160, height = 90) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const paint = canvas.getContext('2d');
    if (!paint) throw new Error('Missing synthetic canvas context');
    let frame = 0;
    const draw = () => {
      paint.fillStyle = color;
      paint.fillRect(0, 0, canvas.width, canvas.height);
      paint.fillStyle = 'white';
      paint.fillRect(100 + frame++ % 20, 60, 4, 4);
    };
    draw();
    const stream = canvas.captureStream(12);
    sourceCanvases.set(stream.getVideoTracks()[0], canvas);
    const timer = setInterval(draw, 70);
    resources.cleanup.push(() => {
      clearInterval(timer);
      stream.getTracks().forEach(track => track.stop());
      canvas.remove();
    });
    return { stream, track: stream.getVideoTracks()[0] };
  };
  const mic = () => {
    const stream = audioDestination.stream.clone();
    resources.cleanup.push(() => stream.getTracks().forEach(track => track.stop()));
    return stream.getAudioTracks()[0];
  };
  const capture = async constraints => {
    captureRequests.push(constraints);
    if (constraints.audio !== false || !constraints.video) throw new Error('Only synthetic camera capture is allowed');
    const entry = source('#00ff00', cameraInput.width, cameraInput.height);
    captures.push({ ...entry, constraints });
    const gate = captureGate;
    captureGate = null;
    if (gate) await gate.promise;
    return entry.stream;
  };
  const transport = {
    send(type, payload) {
      sent.push({ type, payload });
      const route = type === MessageType.RTC_SIGNAL && routes.get(payload.targetSessionId);
      if (!route) return;
      signalQueue = signalQueue.then(async () => {
        if (route.remote.signalingState === 'closed') return;
        if (payload.signalType === 'offer') {
          await route.remote.setRemoteDescription(payload.sdp);
          for (const candidate of route.candidates.splice(0)) await route.remote.addIceCandidate(candidate);
          await route.remote.setLocalDescription(await route.remote.createAnswer());
          await rtc.handleIncomingSignal({
            fromSessionId: payload.targetSessionId, signalType: 'answer',
            sdp: route.remote.localDescription.toJSON(),
          });
        } else if (payload.signalType === 'answer') {
          await route.remote.setRemoteDescription(payload.sdp);
          for (const candidate of route.candidates.splice(0)) await route.remote.addIceCandidate(candidate);
        } else if (payload.signalType === 'candidate') {
          if (route.remote.remoteDescription) await route.remote.addIceCandidate(payload.candidate);
          else route.candidates.push(payload.candidate);
        }
      }).catch(error => { unexpected.push(`Loopback signaling: ${error.stack || error}`); });
    },
  };
  network.send = transport.send;
  network.sendRequest = async type => { throw new Error(`Real server request forbidden: ${type}`); };
  Object.defineProperty(rtc, 'signalClient', { configurable: true, value: transport });
  rtc.rtcConfig = { iceServers: [], iceCandidatePoolSize: 0 };
  rtc.setCurrentSessionId(self.sessionId);
  settings.inputMode = 'push_to_talk';
  settings.noiseSuppressionEnabled = false;
  settings.preferredVideoCodec = 'auto';
  settings.qualityPreset = 'CUSTOM';
  settings.customProfile = {
    ...settings.customProfile, cameraWidth: 160, cameraHeight: 90, cameraFps: 12,
  };
  video.setQualityPreset('CUSTOM');

  const makePeer = (id = 'fixture-peer', direction = 'sendrecv', screenFirst = false) => {
    const connection = pc();
    const audio = mic();
    const screen = source('#eecc00').track;
    const audioSender = connection.addTrack(audio, new MediaStream([audio]));
    const screenTransceiver = screenFirst
      ? connection.addTransceiver(screen, { direction: 'sendonly' }) : null;
    const camera = connection.addTransceiver('video', { direction });
    const screenSender = screenTransceiver?.sender
      ?? connection.addTransceiver(screen, { direction: 'sendonly' }).sender;
    const session = {
      peerSessionId: id, pc: connection, audioSender,
      remoteStream: new MediaStream(), remoteScreenStreams: new Map(),
      screenVideoSenders: new Map([['fixture-screen', screenSender]]),
      candidateQueue: [], isPolite: true, makingOffer: false,
      iceRestartAttempts: 0, reconnectAttempts: 0, isRecovering: false,
    };
    rtc.peers.set(id, session);
    return { session, camera, audio, audioSender, screen, screenSender };
  };
  const preserveOtherMedia = peer => check(
    peer.audioSender.track === peer.audio && peer.audio.readyState === 'live'
      && peer.screenSender.track === peer.screen && peer.screen.readyState === 'live',
    'Camera operation preserves the microphone and dedicated screen sender',
  );
  const receiveVideo = (track, label) => {
    const element = document.createElement('video');
    element.muted = true;
    element.autoplay = true;
    element.playsInline = true;
    element.srcObject = new MediaStream([track]);
    document.body.appendChild(element);
    let disposed = false;
    const dispose = () => {
      if (disposed) return playback;
      disposed = true;
      element.pause();
      element.srcObject = null;
      element.remove();
      track.stop();
      return playback;
    };
    resources.cleanup.push(dispose);
    const playback = element.play().then(
      () => ({ status: 'playing' }),
      error => {
        if (disposed && error.name === 'AbortError') return { status: 'cancelled' };
        unexpected.push(`${label}: ${error.message || error}`);
        return { status: 'failed', error: error.name };
      },
    );
    return { element, dispose, playback };
  };
  const loopback = session => {
    const remote = pc();
    const route = { remote, candidates: [], videos: new Map() };
    routes.set(session.peerSessionId, route);
    if (!session.pc.onicecandidate) {
      session.pc.onicecandidate = event => {
        if (event.candidate) transport.send(MessageType.RTC_SIGNAL, {
          targetSessionId: session.peerSessionId, signalType: 'candidate', candidate: event.candidate.toJSON(),
        });
      };
    }
    remote.ontrack = event => {
      if (event.track.kind !== 'video') return;
      route.videos.set(event.transceiver.mid, receiveVideo(event.track, 'Loopback playback').element);
    };
    remote.onicecandidate = event => {
      if (event.candidate && rtc.peers.get(session.peerSessionId) === session) {
        void rtc.handleIncomingSignal({
          fromSessionId: session.peerSessionId, signalType: 'candidate', candidate: event.candidate.toJSON(),
        }).catch(error => { unexpected.push(`Loopback ICE: ${error}`); });
      }
    };
    return route;
  };
  const addressKind = address => {
    if (!address) return 'unavailable';
    if (address.startsWith('127.') || address === '::1') return 'loopback';
    if (/\.local\.?$/i.test(address)) return 'mdns';
    if (address.includes(':')) return 'other-ipv6';
    return /^\d+\.\d+\.\d+\.\d+$/.test(address) ? 'other-ipv4' : 'other-hostname';
  };
  const trackState = track => {
    if (!track) return null;
    const settings = track.getSettings();
    const canvas = sourceCanvases.get(track);
    const paint = canvas?.getContext('2d');
    return {
      kind: track.kind, readyState: track.readyState, enabled: track.enabled, muted: track.muted,
      width: settings.width, height: settings.height, frameRate: settings.frameRate,
      syntheticRgba: paint ? [...paint.getImageData(0, 0, 1, 1).data] : null,
    };
  };
  const transportDiagnostics = async () => {
    const results = [];
    const candidates = description => (description?.sdp ?? '').split(/\r?\n/)
      .filter(line => line.startsWith('a=candidate:')).map(line => {
        const candidate = new RTCIceCandidate({ candidate: line.slice(2), sdpMid: '0' });
        return { addressKind: addressKind(candidate.address), type: candidate.type, protocol: candidate.protocol };
      });
    for (const connection of activeConnections) {
      const state = {
        signaling: connection.signalingState, connection: connection.connectionState,
        ice: connection.iceConnectionState, gathering: connection.iceGatheringState,
        localDescription: connection.localDescription?.type, remoteDescription: connection.remoteDescription?.type,
        localCandidates: candidates(connection.localDescription), remoteCandidates: candidates(connection.remoteDescription),
        transceivers: connection.getTransceivers().map(entry => ({
          mid: entry.mid, direction: entry.direction, currentDirection: entry.currentDirection,
          sender: trackState(entry.sender.track), receiver: trackState(entry.receiver.track),
        })),
      };
      const report = await observe(connection.getStats());
      if (report.error) {
        results.push({ ...state, statsError: report.error.name || String(report.error) });
        continue;
      }
      const keys = [
        'id', 'type', 'kind', 'mediaType', 'state', 'nominated', 'selectedCandidatePairId', 'dtlsState', 'codecId',
        'localCandidateId', 'remoteCandidateId', 'candidateType', 'protocol', 'mimeType',
        'packetsSent', 'packetsReceived', 'bytesSent', 'bytesReceived', 'framesEncoded', 'framesDecoded',
        'framesReceived', 'framesDropped', 'frameWidth', 'frameHeight', 'framesPerSecond',
        'keyFramesEncoded', 'keyFramesDecoded', 'decoderImplementation', 'encoderImplementation',
      ];
      const stats = [...report.value.values()].filter(entry => [
        'transport', 'candidate-pair', 'local-candidate', 'remote-candidate', 'codec', 'inbound-rtp', 'outbound-rtp',
      ].includes(entry.type)).map(entry => {
        const value = Object.fromEntries(keys.filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
        if (entry.type.endsWith('-candidate')) value.addressKind = addressKind(entry.address || entry.ip);
        return value;
      });
      results.push({ ...state, stats });
    }
    return results;
  };
  const decodedColor = async (getElement, rgb, label) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const paint = canvas.getContext('2d', { willReadFrequently: true });
    let sample;
    try {
      await until(() => {
        const element = getElement();
        if (!element || element.paused || element.readyState < 2 || !element.videoWidth) return false;
        paint.drawImage(element, 0, 0, 8, 8);
        sample = [...paint.getImageData(0, 0, 1, 1).data];
        return rgb.every((value, index) => Math.abs(value - sample[index]) < 65);
      }, `${label}: decoded pixels must be ${rgb}, not the previous source`);
    } catch (error) {
      const element = getElement();
      const processor = video.cameraProcessor;
      const diagnostics = {
        expected: rgb, sampled: sample ?? null,
        video: element ? {
          readyState: element.readyState, paused: element.paused, currentTime: element.currentTime,
          width: element.videoWidth, height: element.videoHeight, frames: element.getVideoPlaybackQuality().totalVideoFrames,
          tracks: element.srcObject?.getVideoTracks().map(trackState),
        } : null,
        processor: processor ? {
          active: processor.active, revision: processor.revision, inFlight: processor.inFlightRevision,
          targetFps: processor.targetFps, width: processor.canvas?.width, height: processor.canvas?.height,
          rgba: processor.context ? [...processor.context.getImageData(0, 0, 1, 1).data] : null,
        } : null,
        peers: await transportDiagnostics(),
      };
      throw new Error(`${error.message}; native camera state=${JSON.stringify(diagnostics)}`, { cause: error });
    }
    check(true, label, sample);
    return sample;
  };
  const stable = session => until(() => session.pc.signalingState === 'stable', 'loopback answer becomes stable');
  const bindPublication = () => {
    const dispose = publication.bindCameraPublication();
    resources.cleanup.push(dispose);
    return dispose;
  };
  const mountStage = (render = false) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const stage = new VoiceStageView(host);
    resources.cleanup.push(() => { stage.destroy(); host.remove(); });
    if (render) stage.setChannel('fixture-room');
    return { stage, host };
  };
  const published = async () => {
    const { stage } = mountStage();
    await stage.toggleCamera();
    check(voice.isCameraOn && video.getCameraState().status === 'ready', 'Stage startup publishes a ready camera');
    return video.getCameraState().stream;
  };
  const publicationsSettled = async () => {
    while (rtc.cameraTrackChange) await bounded(rtc.cameraTrackChange.task, 'camera publication settles');
  };

  // Only the SFU transport/control plane is mocked. Track ownership and replacement
  // use the installed mediasoup Producer and Chromium RTCRtpSender implementations.
  const installSfuTransport = (engine, canVideo = true) => {
    const connection = pc();
    const made = [];
    const options = [];
    const replacements = [];
    let nextGate = null;
    const sendTransport = {
      closed: false,
      async produce(input) {
        options.push(input);
        const sender = connection.addTransceiver(input.track, { direction: 'sendonly' }).sender;
        const producer = new Producer({
          id: `fixture-producer-${made.length}`, localId: String(made.length),
          rtpSender: sender, track: input.track, rtpParameters: sender.getParameters(),
          stopTracks: input.stopTracks, disableTrackOnPause: true, zeroRtpOnPause: false,
          appData: input.appData,
        });
        producer.on('@replacetrack', (track, resolve, reject) => {
          replacements.push({ producer, track });
          sender.replaceTrack(track).then(resolve, reject);
        });
        producer.on('@close', () => {
          if (connection.signalingState !== 'closed') connection.removeTrack(sender);
        });
        made.push(producer);
        const gate = nextGate;
        nextGate = null;
        if (gate) await gate.promise;
        return producer;
      },
      close() { this.closed = true; connection.close(); },
    };
    engine.channelId = voice.currentVoiceChannelId;
    engine.device = {
      loaded: true, canProduce: kind => kind === 'audio' || canVideo,
      sendRtpCapabilities: { codecs: [{ kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }] },
    };
    engine.sendTransport = sendTransport;
    engine.recvTransport = { close() {} };
    engine.isInitialized = true;
    return { connection, made, options, replacements, deferNext(gate) { nextGate = gate; } };
  };
  const makeOverlay = async () => {
    const bridge = new OverlayBridgeService();
    const states = [];
    patch(window.api, 'sendOverlaySyncState', async state => { states.push(state); });
    resources.cleanup.push(async () => {
      await bridge.close();
      clearTimeout(bridge.syncThrottleTimer);
      bridge.dummyTrack?.stop();
    });
    await bridge.open();
    bridge.isWebRtcReady = true;
    return { bridge, states };
  };
  const delayNative = (sender, target) => {
    const gate = deferred();
    const entered = deferred();
    const calls = [];
    const nativeReplace = sender.replaceTrack.bind(sender);
    patch(sender, 'replaceTrack', async track => {
      calls.push(track);
      if (track === target) {
        entered.resolve();
        await gate.promise;
      }
      return nativeReplace(track);
    });
    return { gate, entered, calls };
  };

  const run = async (name, action) => {
    if (filter && !name.includes(filter)) return;
    scenarios++;
    const before = checks;
    resources = { cleanup: [], restore: [], gates: [], pcs: [] };
    captures.length = sent.length = 0;
    captureGate = null;
    media.getUserMedia = capture;
    voice.currentVoiceChannelId = 'fixture-room';
    voice.voiceSessionKey = null;
    voice.isCameraOn = voice.isScreenSharing = voice.isReconnecting = false;
    voice.screenShareIds = [];
    settings.selectedCameraId = 'camera-a';
    server.serverDetails = {
      id: 'fixture-server', name: 'Camera fixture', voiceMode: 'p2p',
      channels: [{ id: 'fixture-room', name: 'Fixture voice', type: 'VOICE' }], members: [self],
    };
    server.currentUser = self;
    participants.addUser(self);
    participants.updateVoiceState({
      sessionId: self.sessionId, channelId: 'fixture-room',
      isCameraOn: false, isMuted: false, isDeafened: false, isScreenSharing: false, isSpeaking: false,
    });
    try {
      await bounded(video.setCameraEffects({ mode: 'off', limitQuality: false }), 'reset persisted camera choice');
      await until(() => !participants.updateScheduled, 'participant fixture update');
      await bounded(action(), name, 25_000);
      console.log(`CAMERA PASS ${name}: ${checks - before} checks`);
    } catch (error) {
      failures.push({ scenario: name, message: error.stack || String(error) });
      console.log(`CAMERA FAIL ${name}: ${error.message || error}`);
    } finally {
      resources.gates.forEach(resolve => resolve());
      try {
        for (const cleanup of resources.cleanup.reverse()) await cleanup();
        video.stopCamera();
        await bounded(video.cameraJobs, 'camera jobs teardown');
        if (rtc.cameraTrackChange) await bounded(observe(rtc.cameraTrackChange.task), 'publication teardown');
        await bounded(signalQueue, 'signaling teardown');
        rtc.closeAllPeers();
        rtc.localCameraTrack = rtc.localAudioTrack = null;
        rtc.localScreenTracks.clear();
        rtc.localScreenStreams.clear();
        for (const connection of resources.pcs) connection.close();
        routes.clear();
        participants.clear();
        for (const restore of resources.restore.reverse()) restore();
        document.body.replaceChildren();
      } catch (error) {
        failures.push({ scenario: `${name}/cleanup`, message: error.stack || String(error) });
      }
    }
  };

  try {
    await run('fixture-dns-independent-ice-and-late-track', async () => {
      const sending = pc();
      const receiving = pc();
      const entry = source('#ee2020');
      const sender = sending.addTrack(entry.track, entry.stream);
      let remoteVideo;
      receiving.ontrack = event => {
        remoteVideo = receiveVideo(event.track, 'DNS-independent fixture playback').element;
      };
      const numericHost = candidate => candidate.type === 'host'
        && ['loopback', 'other-ipv4', 'other-ipv6'].includes(addressKind(candidate.address));
      const withoutDns = description => ({
        type: description.type,
        sdp: description.sdp.split(/\r?\n/).filter(line => {
          if (!line.startsWith('a=candidate:')) return true;
          const candidate = new RTCIceCandidate({ candidate: line.slice(2), sdpMid: '0' });
          return numericHost(candidate);
        }).join('\r\n'),
      });
      await sending.setLocalDescription(await sending.createOffer());
      await until(() => sending.iceGatheringState === 'complete', 'Native sender finishes host ICE gathering');
      await receiving.setRemoteDescription(withoutDns(sending.localDescription));
      await receiving.setLocalDescription(await receiving.createAnswer());
      await until(() => receiving.iceGatheringState === 'complete', 'Native receiver finishes host ICE gathering');
      await sending.setRemoteDescription(withoutDns(receiving.localDescription));
      const visibleAt = performance.now() + 120;
      let lookups = 0;
      const rgba = await decodedColor(() => {
        lookups++;
        return performance.now() >= visibleAt ? remoteVideo : null;
      }, [238, 32, 32], 'Native camera decodes over genuine same-host ICE without DNS and with late track registration');
      check(lookups > 1 && sender.track === entry.track,
        'Decoder lookup waits for eventual ontrack registration without replacing or fabricating the sender');
      const report = await receiving.getStats();
      const pair = [...report.values()].find(stat => stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated);
      const remoteCandidate = pair && report.get(pair.remoteCandidateId);
      const signaled = receiving.remoteDescription.sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate:'))
        .map(line => new RTCIceCandidate({ candidate: line.slice(2), sdpMid: '0' }));
      const inbound = [...report.values()].find(stat => stat.type === 'inbound-rtp' && stat.kind === 'video');
      const sentReport = await sender.getStats();
      const outbound = [...sentReport.values()].find(stat => stat.type === 'outbound-rtp' && stat.kind === 'video');
      check(pair && signaled.length > 0 && signaled.every(numericHost)
        && outbound?.framesEncoded > 0 && inbound?.framesDecoded > 0,
      'A genuine numeric host ICE pair encodes and decodes RTP without mDNS resolution');
      console.log('CAMERA TEST DNS-independent transport ' + JSON.stringify({
        senderIce: sending.iceConnectionState, receiverIce: receiving.iceConnectionState,
        pairState: pair.state, candidate: addressKind(remoteCandidate?.address || remoteCandidate?.ip),
        signaledCandidates: signaled.map(candidate => addressKind(candidate.address)),
        framesEncoded: outbound.framesEncoded, framesDecoded: inbound.framesDecoded, rgba,
      }));
    });

    await run('fixture-pending-playback-cleanup', async () => {
      const receiver = pc().addTransceiver('video', { direction: 'recvonly' }).receiver;
      const pending = receiveVideo(receiver.track, 'Pending fixture playback');
      pending.dispose();
      const result = await bounded(pending.playback, 'Pending play cancellation settles');
      check(result.status === 'cancelled' && !pending.element.isConnected && receiver.track.readyState === 'ended',
        'Owned cleanup cancels a pending native play request without reporting a spurious renderer failure');
    });

    await run('p2p-idle-loopback-lifecycle', async () => {
      rtc.localAudioTrack = mic();
      await rtc.connectToPeer('fixture-peer', false);
      const session = rtc.peers.get('fixture-peer');
      const camera = session.pc.getTransceivers().find(entry => entry.receiver.track.kind === 'video');
      const screen = source('#eecc00').track;
      const screenSender = session.pc.addTransceiver(screen, { direction: 'sendonly' }).sender;
      session.screenVideoSenders.set('fixture-screen', screenSender);
      const peer = { session, camera, audio: rtc.localAudioTrack, audioSender: session.audioSender, screen, screenSender };
      check(camera.sender.track === null, 'Production connectToPeer creates an initially idle primary video transceiver');
      const route = loopback(session);
      await rtc.sendOffer(session);
      await stable(session);
      const initialOffers = sent.filter(entry => entry.payload?.signalType === 'offer').length;
      const first = source('#ee2020').track;
      const second = source('#2020ee').track;
      await rtc.setLocalCameraTrack(first);
      check(session.videoSender === camera.sender && camera.sender.track === first && rtc.localCameraTrack === first,
        'Initial publish recognizes and stores the existing idle camera sender');
      await decodedColor(() => route.videos.get(camera.mid), [238, 32, 32], 'Initial camera is decoded over the genuine loopback');
      await rtc.setLocalCameraTrack(second);
      check(camera.sender.track === second && rtc.localCameraTrack === second, 'Replacement updates both sender and late-peer cache');
      await decodedColor(() => route.videos.get(camera.mid), [32, 32, 238], 'Replacement pixels, not stale source pixels, are decoded');
      check(sent.filter(entry => entry.payload?.signalType === 'offer').length === initialOffers,
        'Stable sendrecv publication and replacement do not renegotiate');
      await rtc.setLocalCameraTrack(null);
      await stable(session);
      check(camera.sender.track === null && rtc.localCameraTrack === null && camera.direction === 'recvonly',
        'Stop detaches the stored camera sender and clears its cache');
      check(sent.filter(entry => entry.payload?.signalType === 'offer').length === initialOffers + 1,
        'Changing to recvonly negotiates exactly once');
      preserveOtherMedia(peer);
      await rtc.setLocalCameraTrack(second);
      await stable(session);
      check(camera.direction === 'sendrecv'
        && sent.filter(entry => entry.payload?.signalType === 'offer').length === initialOffers + 2,
      'Turning the camera back on negotiates sendrecv exactly once');
      preserveOtherMedia(peer);
    });

    await run('p2p-screen-exclusion-and-replace-failure', async () => {
      const good = makePeer('good', 'sendrecv', true);
      const bad = makePeer('bad');
      const raw = source().track;
      await rtc.setLocalCameraTrack(raw);
      check(good.session.videoSender === good.camera.sender && good.screenSender.track === good.screen,
        'An earlier screen transceiver is never mistaken for the idle camera');
      const processed = source('#2020ee').track;
      raw.stop();
      const calls = [];
      const failure = new DOMException('fixture native replacement failure', 'InvalidModificationError');
      const nativeReplace = bad.camera.sender.replaceTrack.bind(bad.camera.sender);
      patch(bad.camera.sender, 'replaceTrack', async track => {
        calls.push(track);
        if (track === processed) throw failure;
        return nativeReplace(track);
      });
      check(await rejected(rtc.setLocalCameraTrack(processed), 'Partial native replacement rejects') === failure,
        'The actual native failure reaches the caller');
      check(rtc.localCameraTrack === null && good.camera.sender.track === null,
        'A partially published failing candidate is detached instead of cached');
      check(!calls.includes(raw) && bad.camera.sender.track?.readyState !== 'live',
        'Failure never restores a stopped raw track');
      preserveOtherMedia(good);
      preserveOtherMedia(bad);
    });

    await run('p2p-negotiation-failure', async () => {
      const peer = makePeer('offer-failure', 'recvonly');
      const candidate = source('#2020ee').track;
      const failure = new Error('fixture createOffer failed');
      patch(peer.session.pc, 'createOffer', async () => { throw failure; });
      const calls = [];
      const sendOffer = rtc.sendOffer;
      patch(rtc, 'sendOffer', async function (...args) {
        calls.push(args);
        return sendOffer.apply(this, args);
      });
      check(await rejected(rtc.setLocalCameraTrack(candidate), 'Camera negotiation failure rejects') === failure,
        'Offer errors are propagated, not logged as a successful publication');
      check(calls.length === 1 && calls[0][1] === false && calls[0][2] === true,
        'Camera direction negotiation explicitly propagates sendOffer errors');
      check(peer.camera.sender.track === null && rtc.localCameraTrack === null && candidate.readyState === 'live',
        'Failed negotiation detaches only camera; capture ownership stays with its source');
      preserveOtherMedia(peer);
    });

    await run('p2p-concurrent-native-replacements', async () => {
      const peer = makePeer();
      const original = source().track;
      const older = source('#ee2020').track;
      const newest = source('#2020ee').track;
      await rtc.setLocalCameraTrack(original);
      const deferredReplace = delayNative(peer.camera.sender, older);
      const oldResult = observe(rtc.setLocalCameraTrack(older));
      await bounded(deferredReplace.entered.promise, 'older native replacement enters');
      const newResult = rtc.setLocalCameraTrack(newest);
      check(rtc.localCameraTrack === newest, 'A newly arriving peer sees the newest desired camera cache immediately');
      await tick();
      check(!deferredReplace.calls.includes(newest), 'The newer native replacement waits for the older native operation');
      deferredReplace.gate.resolve();
      check((await bounded(oldResult, 'old replacement settles')).error?.name === 'AbortError',
        'Superseded replacement reports cancellation');
      await newResult;
      check(peer.camera.sender.track === newest && rtc.localCameraTrack === newest,
        'Late old native completion cannot win over the latest source');
      check(deferredReplace.calls.at(-1) === newest, 'The final native assignment is the newest source');
      preserveOtherMedia(peer);
    });

    for (const race of ['stop', 'channel', 'session', 'close-peers']) {
      await run(`p2p-pending-${race}`, async () => {
        const peer = makePeer();
        const original = source().track;
        const late = source('#ee2020').track;
        await rtc.setLocalCameraTrack(original);
        const delayed = delayNative(peer.camera.sender, late);
        const oldResult = observe(rtc.setLocalCameraTrack(late));
        await bounded(delayed.entered.promise, 'old call replacement enters');
        let stopping;
        let replacementPeer;
        let newest;
        if (race === 'stop') stopping = rtc.setLocalCameraTrack(null);
        if (race === 'channel') voice.currentVoiceChannelId = 'fixture-other-room';
        if (race === 'session') voice.voiceSessionKey = 'fixture-other-server';
        if (race === 'close-peers') {
          rtc.closeAllPeers();
          voice.currentVoiceChannelId = 'fixture-other-room';
          replacementPeer = makePeer('new-call');
          newest = source('#2020ee').track;
          await rtc.setLocalCameraTrack(newest);
        }
        delayed.gate.resolve();
        const outcome = await bounded(oldResult, 'cancelled call replacement settles');
        check(outcome.error instanceof Error, `${race} rejects an in-flight publication instead of falsely succeeding`);
        if (stopping) await stopping;
        if (replacementPeer) {
          check(rtc.localCameraTrack === newest && replacementPeer.camera.sender.track === newest,
            'An old closed peer cannot change the next call cache or sender');
          preserveOtherMedia(replacementPeer);
        } else {
          check(rtc.localCameraTrack === null && peer.camera.sender.track === null,
            `${race} prevents late native completion from republishing the wrong source/call`);
          preserveOtherMedia(peer);
        }
      });
    }

    await run('p2p-reconnecting-rejects', async () => {
      const candidate = source().track;
      rtc.suspendForVoiceReconnect(true);
      await rejected(rtc.setLocalCameraTrack(candidate), 'Reconnect does not report nonnull publication success', 'AbortError');
      check(rtc.localCameraTrack === null && candidate.readyState === 'live', 'Reconnect cancellation clears cache without taking capture ownership');
      let initializations = 0;
      patch(rtc, 'initSfuForCurrentChannel', async () => { initializations++; });
      server.serverDetails.voiceMode = 'sfu';
      await rtc.setLocalCameraTrack(null);
      check(initializations === 0, 'Stopping a camera never initializes SFU while reconnecting');
    });

    for (const transportMode of ['p2p', 'sfu']) {
      await run(`camera-profile-fps-${transportMode}`, async () => {
        bindPublication();
        server.serverDetails.voiceMode = transportMode;
        patch(cameraInput, 'width', 1920);
        patch(cameraInput, 'height', 1080);
        patch(settings, 'customProfile', {
          ...settings.customProfile, cameraWidth: 1920, cameraHeight: 1080, cameraFps: 60, screenFps: 45,
        });
        patch(rtc, 'currentPreset', rtc.currentPreset);
        patch(rtc.sfuEngine, 'qualityProfile', rtc.sfuEngine.qualityProfile);
        patch(rtc.sfuEngine, 'qualityPreset', rtc.sfuEngine.qualityPreset);
        let peer;
        let route;
        let micProducer;
        let screenProducer;
        let sfuConnection;
        let decoded;
        if (transportMode === 'p2p') {
          peer = makePeer('fixture-fps-peer', 'recvonly');
          rtc.localScreenTracks.set('fixture-screen', peer.screen);
          route = loopback(peer.session);
        } else {
          const engine = rtc.sfuEngine;
          sfuConnection = installSfuTransport(engine).connection;
          micProducer = await engine.produceMic(mic());
          screenProducer = await engine.sendTransport.produce({
            track: source('#eecc00').track, stopTracks: false, appData: { mediaType: 'screen_video' },
          });
          engine.producers.set('screen_video:fixture-screen', screenProducer);
        }
        rtc.setQualityPreset('CUSTOM');
        await video.setCameraEffects({ mode: 'chroma', backgroundColor: '#1122dd', limitQuality: false });
        const stream = await published();
        await publicationsSettled();
        if (peer) await stable(peer.session);
        const sender = peer?.camera.sender ?? rtc.sfuEngine.producers.get('camera')?.rtpSender;
        check(sender instanceof RTCRtpSender, `${transportMode} FPS fixture uses the native RTP sender`);
        if (sfuConnection) {
          const receiver = pc();
          await sfuConnection.setLocalDescription(await sfuConnection.createOffer());
          await until(() => sfuConnection.iceGatheringState === 'complete', 'Native SFU sender gathers local ICE');
          const cameraMid = sfuConnection.getTransceivers().find(entry => entry.sender === sender).mid;
          receiver.ontrack = event => {
            if (event.transceiver.mid !== cameraMid) return;
            decoded = receiveVideo(event.track, 'SFU fixture playback').element;
          };
          await receiver.setRemoteDescription(sfuConnection.localDescription);
          await receiver.setLocalDescription(await receiver.createAnswer());
          await until(() => receiver.iceGatheringState === 'complete', 'Native SFU receiver gathers local ICE');
          await sfuConnection.setRemoteDescription(receiver.localDescription);
          await rtc.sfuEngine.applyQualityParams('CUSTOM', settings.customProfile);
        }
        const getDecoded = () => peer ? route.videos.get(peer.camera.mid) : decoded;
        await until(() => sender.getParameters().encodings[0]?.maxFramerate === 60,
          `${transportMode} applies the selected profile FPS to the camera encoder`);
        check(video.cameraProcessor.targetFps === 60 && captureRequests.at(-1).video.frameRate.exact === 60
          && captureRequests.at(-1).video.width.exact === 1920 && captureRequests.at(-1).video.height.exact === 1080,
        'Uncapped effects and hardware capture request the full selected resolution/FPS profile');
        const screenSender = peer?.screenSender ?? screenProducer.rtpSender;
        check(screenSender.getParameters().encodings[0]?.maxFramerate === 45,
          'Camera profile FPS stays distinct from the screen-share profile');
        await decodedColor(getDecoded, [17, 34, 221], 'Both native transports deliver the actual processed chroma composite');
        const expectSize = async (width, height, label) => {
          await until(() => {
            const actual = sender.track.getSettings();
            const decoded = getDecoded();
            return actual.width === width && actual.height === height
              && decoded?.videoWidth === width && decoded.videoHeight === height;
          }, label);
          const decoded = getDecoded();
          check(decoded.videoWidth === width && decoded.videoHeight === height, label);
        };
        await expectSize(1920, 1080, 'Uncapped selected 1080p reaches the actual remote decoder');
        const track = stream.getVideoTracks()[0];
        await video.setCameraEffects({ limitQuality: true });
        await publicationsSettled();
        check(video.cameraProcessor.targetFps === 30 && sender.track === track
          && sender.getParameters().encodings[0]?.maxFramerate === 60,
        'Combined quality limit gates source FPS without changing the selected encoder ceiling or sender track');
        await expectSize(1280, 720, 'The enabled 720p/30 cap also reaches the actual remote decoder');
        settings.customProfile = { ...settings.customProfile, cameraWidth: 640, cameraHeight: 360, cameraFps: 20 };
        rtc.setQualityPreset('CUSTOM');
        await until(() => video.cameraProcessor.targetFps === 20
          && sender.getParameters().encodings[0]?.maxFramerate === 20,
        'A lower selected profile propagates to both source and encoder while the cap is enabled');
        check(sender.track === track && captures.length === 1,
          'Live FPS changes preserve the processed track and sole hardware capture');
        await expectSize(640, 360, 'A lower profile updates actual transmitted resolution without upscaling');
        await video.setCameraEffects({ limitQuality: false });
        check(video.cameraProcessor.targetFps === 20,
          'Removing the optional cap does not invent FPS above a lower selected profile');
        await expectSize(640, 360, 'Removing the quality cap preserves the lower selected transmitted resolution');
        settings.customProfile = { ...settings.customProfile, cameraWidth: 1920, cameraHeight: 1080, cameraFps: 60 };
        rtc.setQualityPreset('CUSTOM');
        await until(() => video.cameraProcessor.targetFps === 60
          && sender.getParameters().encodings[0]?.maxFramerate === 60,
        'Raising the selected profile restores uncapped source and publisher targets');
        await expectSize(1920, 1080, 'Raising the profile restores full 1080p in the actual transmitted stream');
        await video.setCameraEffects({ mode: 'off', limitQuality: true });
        await publicationsSettled();
        check(!video.cameraProcessor && sender.track === video.getCameraStream().getVideoTracks()[0]
          && sender.getParameters().encodings[0]?.maxFramerate === 60 && captures.length === 1,
        'Off keeps ordinary camera profile behavior even if the effect-only cap preference is enabled');
        await expectSize(1920, 1080, 'Off ignores the combined limit and transmits the ordinary full-resolution source');
        if (peer) preserveOtherMedia(peer);
        else check(!micProducer.closed && !screenProducer.closed,
          'Effect FPS changes leave SFU microphone and screen producers intact');
      });
    }

    await run('sfu-genuine-producer-replacement', async () => {
      server.serverDetails.voiceMode = 'sfu';
      const engine = rtc.sfuEngine;
      const fixture = installSfuTransport(engine);
      const microphone = mic();
      const screen = source('#eecc00').track;
      const micProducer = await engine.produceMic(microphone);
      const screenProducer = await engine.sendTransport.produce({ track: screen, stopTracks: false, appData: { mediaType: 'screen_video' } });
      engine.producers.set('screen_video:fixture-screen', screenProducer);
      const original = (await video.startCamera()).getVideoTracks()[0];
      await rtc.setLocalCameraTrack(original);
      const producer = engine.producers.get('camera');
      check(producer instanceof Producer && producer.rtpSender instanceof RTCRtpSender, 'SFU fixture exercises a genuine mediasoup Producer and native RTP sender');
      const newer = source('#2020ee').track;
      await rtc.setLocalCameraTrack(newer);
      check(engine.producers.get('camera') === producer && producer.track === newer && producer.rtpSender.track === newer,
        'SFU replacement changes Producer.track as well as the native sender, without reprovisioning');
      check(fixture.replacements.length === 1 && fixture.replacements[0].producer === producer
        && fixture.replacements[0].track === newer, 'Camera replacement goes through the producer-level event path');
      check(fixture.options.filter(input => input.appData.mediaType === 'camera').length === 1
        && fixture.options.every(input => input.stopTracks === false), 'SFU production passes stopTracks:false to preserve capture ownership');
      await rtc.setLocalCameraTrack(null);
      check(producer.closed && engine.getCameraTrack() === null && rtc.localCameraTrack === null, 'SFU camera stop closes only its producer and clears the cache');
      check(original.readyState === 'live' && newer.readyState === 'live', 'Replacing and closing a producer never stop VideoService-owned tracks');
      check(!micProducer.closed && micProducer.track === microphone && !screenProducer.closed
        && screenProducer.track === screen, 'SFU camera stop leaves microphone and screen producers intact');
      video.stopCamera();
      check(original.readyState === 'ended' && captures[0].track.readyState === 'ended', 'VideoService, not mediasoup, stops the physical-capture substitute and its published clone');
    });

    await run('sfu-false-and-null-publication-failures', async () => {
      server.serverDetails.voiceMode = 'sfu';
      const engine = rtc.sfuEngine;
      installSfuTransport(engine);
      const first = source('#2020ee').track;
      await rtc.setLocalCameraTrack(first);
      const producer = engine.producers.get('camera');
      const candidate = source('#ee2020').track;
      patch(producer.rtpSender, 'replaceTrack', async () => { throw new Error('fixture producer replacement failed'); });
      const error = await rejected(rtc.setLocalCameraTrack(candidate), 'A false SFU replacement result rejects the public publication');
      check(error.message === 'Could not replace SFU camera' && rtc.localCameraTrack === null,
        'SFU failure is not silently cached as a successful camera change');
      check(producer.track === first && candidate.readyState === 'live', 'Failed producer replacement does not take ownership of or stop the candidate');
      engine.closeProducer('camera');
      engine.device.canProduce = kind => kind === 'audio';
      const missing = await rejected(rtc.setLocalCameraTrack(candidate), 'A null SFU producer rejects the public publication');
      check(missing.message === 'Could not publish SFU camera' && engine.getCameraTrack() === null,
        'Unavailable camera production is surfaced instead of reporting success');
    });

    await run('sfu-pending-produce-and-ownership', async () => {
      const engine = rtc.sfuEngine;
      const fixture = installSfuTransport(engine);
      const track = source().track;
      const gate = deferred();
      fixture.deferNext(gate);
      const pending = observe(engine.produceCamera(track));
      await until(() => fixture.made.length === 1, 'transport owns a pending producer');
      engine.closeProducer('camera');
      gate.resolve();
      check((await bounded(pending, 'pending camera stop')).error?.name === 'AbortError', 'Stopping a pending produce invalidates that exact producer operation');
      check(fixture.made[0].closed && engine.getCameraTrack() === null && track.readyState === 'live',
        'Late pending production is closed without stopping its capture');
      const first = await engine.produceCamera(track);
      const lateTransportClose = first.listeners('transportclose')[0];
      const newestTrack = source('#2020ee').track;
      const newest = await engine.produceCamera(newestTrack);
      lateTransportClose();
      check(first.closed && engine.producers.get('camera') === newest && engine.getCameraTrack() === newestTrack,
        'A late transportclose from an old producer cannot delete its successor');
      const delayedTrack = source('#ee2020').track;
      const delayed = delayNative(newest.rtpSender, delayedTrack);
      const replacing = engine.replaceTrack('camera', delayedTrack);
      await bounded(delayed.entered.promise, 'producer replacement enters');
      const replacement = await engine.produceCamera(track);
      delayed.gate.resolve();
      check(await replacing === false && engine.producers.get('camera') === replacement,
        'Producer-level replacement reports false after its producer loses ownership');
      check([track, newestTrack, delayedTrack].every(entry => entry.readyState === 'live'),
        'Producer ownership races leave source lifetimes with their capture owner');
    });

    await run('sfu-first-initialization-self-epoch', async () => {
      server.serverDetails.voiceMode = 'sfu';
      const engine = rtc.sfuEngine;
      let fixture;
      let joins = 0;
      patch(engine, 'join', async channelId => {
        joins++;
        engine.leave();
        fixture = installSfuTransport(engine);
        check(channelId === 'fixture-room', 'Initial SFU join uses the current call channel');
        return true;
      });
      const camera = (await video.startCamera()).getVideoTracks()[0];
      const microphone = mic();
      rtc.localAudioTrack = microphone;
      const epoch = rtc.sfuJoinEpoch;
      await rtc.setLocalCameraTrack(camera);
      check(joins === 1 && rtc.sfuJoinEpoch === epoch + 1, 'Initial SFU setup advances its own join epoch exactly once');
      check(rtc.localCameraTrack === camera && engine.getCameraTrack() === camera
        && fixture.options.filter(input => input.appData.mediaType === 'camera').length === 1,
      'Self-advanced join epoch does not cancel or duplicate initial camera publication');
      check(engine.producers.get('mic')?.track === microphone && voice.currentVoiceChannelId === 'fixture-room',
        'Initial camera publication preserves the microphone and call');
    });

    await run('sfu-rejoin-camera-failure-preserves-mic', async () => {
      server.serverDetails.voiceMode = 'sfu';
      const engine = rtc.sfuEngine;
      patch(engine, 'join', async () => {
        engine.leave();
        installSfuTransport(engine, false);
        return true;
      });
      const errors = [];
      listen('camera.publication_failed', error => errors.push(error));
      const camera = (await video.startCamera()).getVideoTracks()[0];
      rtc.localCameraTrack = camera;
      rtc.localAudioTrack = mic();
      await rtc.initSfuForCurrentChannel();
      check(errors.length === 1 && rtc.localCameraTrack === null && camera.readyState === 'ended',
        'A failed cached camera republish is surfaced and its capture is stopped');
      check(engine.isReady() && engine.producers.get('mic')?.track === rtc.localAudioTrack
        && rtc.localAudioTrack.readyState === 'live' && voice.currentVoiceChannelId === 'fixture-room',
      'Camera failure during SFU rejoin does not tear down the microphone, transports, or channel');
    });

    await run('binding-off-chroma-late-and-incoming-peers', async () => {
      bindPublication();
      const peer = makePeer();
      const route = loopback(peer.session);
      await rtc.sendOffer(peer.session);
      await stable(peer.session);
      const started = [];
      const replaced = [];
      listen('local.camera_started', stream => started.push(stream));
      listen('local.camera_replaced', event => replaced.push(event));
      const original = await published();
      const rawCapture = captures[0].stream;
      check(started.length === 1 && started[0] === original && original !== rawCapture,
        'The first requested Off stream is announced once and is a clone of the one shared capture');
      const stateChanges = sent.filter(entry => entry.type === MessageType.VOICE_STATE_UPDATE).length;
      publication.setLocalCameraState(true);
      check(sent.filter(entry => entry.type === MessageType.VOICE_STATE_UPDATE).length === stateChanges,
        'Duplicate camera state does not send redundant WebSocket updates');
      const changing = video.setCameraEffects({ mode: 'chroma', backgroundColor: '#2020ee' });
      check(original.getVideoTracks()[0].readyState === 'ended' && rawCapture.getVideoTracks()[0].readyState === 'live',
        'Enabling effects synchronously retires the published raw clone without closing the shared capture');
      check(video.getCameraState().status === 'starting' && video.getCameraState().stream === null,
        'No not-yet-processed output is advertised as ready');
      await changing;
      await publicationsSettled();
      const processed = video.getCameraState().stream;
      check(replaced.length === 1 && replaced[0].previousStream === original && replaced[0].stream === processed,
        'Real source replacement events identify both previous and processed streams');
      check(peer.camera.sender.track === processed.getVideoTracks()[0]
        && rtc.localCameraTrack === peer.camera.sender.track && voice.isCameraOn,
      'The publication binding propagates the processed source to both sender and late-peer cache');
      await decodedColor(() => route.videos.get(peer.camera.mid), [32, 32, 238], 'Only the chroma-composited background reaches the loopback decoder');
      await rtc.connectToPeer('late-peer', false);
      check(rtc.peers.get('late-peer').videoSender.track === processed.getVideoTracks()[0],
        'A new peer starts with the latest processed cached track');
      const incomingUser = { id: 'incoming-user', sessionId: 'incoming-peer', nickname: 'Incoming fixture', status: 'CONNECTED' };
      participants.addUser(incomingUser);
      participants.updateVoiceState({ sessionId: incomingUser.sessionId, channelId: 'fixture-room' });
      const incoming = pc();
      incoming.addTransceiver('audio', { direction: 'recvonly' });
      incoming.addTransceiver('video', { direction: 'recvonly' });
      routes.set('incoming-peer', { remote: incoming, candidates: [], videos: new Map() });
      await incoming.setLocalDescription(await incoming.createOffer());
      await rtc.handleIncomingSignal({
        fromSessionId: 'incoming-peer', signalType: 'offer', sdp: incoming.localDescription.toJSON(),
      });
      await bounded(signalQueue, 'incoming peer answer');
      check(rtc.peers.get('incoming-peer')?.videoSender?.track === processed.getVideoTracks()[0],
        'An incoming offer also answers with the latest processed camera, never the old raw source');
      preserveOtherMedia(peer);
      const stopMessages = sent.filter(entry => entry.type === MessageType.VOICE_STATE_UPDATE).length;
      video.stopCamera();
      await publicationsSettled();
      check(!voice.isCameraOn && rtc.localCameraTrack === null && peer.camera.sender.track === null,
        'Real local.camera_stopped clears the flag, cache, and camera sender');
      check(sent.filter(entry => entry.type === MessageType.VOICE_STATE_UPDATE).length === stopMessages + 1,
        'Camera stop announces the state change exactly once');
      preserveOtherMedia(peer);
    });

    for (const entryPoint of ['stage', 'binding']) {
      const scenario = entryPoint === 'stage'
        ? 'stage-pending-first-publication-stable-track-tuning'
        : 'binding-pending-replacement-stable-track-tuning';
      await run(scenario, async () => {
        bindPublication();
        const peer = makePeer();
        const route = loopback(peer.session);
        await rtc.sendOffer(peer.session);
        await stable(peer.session);
        const replacements = [];
        const terminalEvents = [];
        listen('local.camera_replaced', event => replacements.push(event));
        for (const event of ['local.camera_stopped', 'camera.effects_error', 'camera.publication_failed', 'camera.error_notice']) {
          listen(event, () => terminalEvents.push(event));
        }
        const chroma = { mode: 'chroma', backgroundColor: '#2020ee', keyTolerance: 25 };
        let previousStream = null;
        if (entryPoint === 'binding') previousStream = await published();
        else await video.setCameraEffects(chroma);

        const nativeGate = deferred();
        const nativeEntered = deferred();
        const nativeCalls = [];
        const nativeReplace = peer.camera.sender.replaceTrack.bind(peer.camera.sender);
        patch(peer.camera.sender, 'replaceTrack', async track => {
          nativeCalls.push(track);
          nativeEntered.resolve(track);
          await nativeGate.promise;
          return nativeReplace(track);
        });
        let stageResult;
        if (entryPoint === 'stage') {
          stageResult = observe(mountStage().stage.toggleCamera());
        } else {
          await video.setCameraEffects(chroma);
        }
        const track = await bounded(nativeEntered.promise, 'processed camera publication enters the native sender');
        const stream = video.getCameraState().stream;
        const processor = video.cameraProcessor;
        check(stream?.getVideoTracks()[0] === track && track.readyState === 'live' && processor?.isStarted
          && video.getCameraState().publishing, 'The pending publication owns a real ready chroma stream and processor');
        check(rtc.cameraTrackChange?.track === track && rtc.localCameraTrack === track
          && peer.camera.sender.track !== track, 'The native camera publication is genuinely pending before tuning starts');
        const publicationResult = observe(rtc.cameraTrackChange.task);
        check(voice.isCameraOn === (entryPoint === 'binding'),
          'First publication awaits its camera flag; a live replacement retains the existing flag');
        if (entryPoint === 'binding') {
          check(replacements.length === 1 && replacements[0].previousStream === previousStream
            && replacements[0].stream === stream, 'The pending replacement was initiated by the real VideoService replacement event');
        } else {
          check(replacements.length === 0, 'First publication comes through VoiceStage.toggleCamera, not a replacement event');
        }
        const replacementCount = replacements.length;
        const captureCount = captures.length;
        const tuneGate = deferred();
        const tuneEntered = deferred();
        const update = processor.update.bind(processor);
        // Hold reconfiguration after VideoService has gated the live output, then
        // run the real processor/worker update once native publication has settled.
        patch(processor, 'update', async snapshot => {
          tuneEntered.resolve(snapshot);
          await tuneGate.promise;
          return update(snapshot);
        });
        const tuningPatch = entryPoint === 'stage' ? { keyTolerance: 35 } : { backgroundColor: '#ee2020' };
        const tuningResult = observe(video.setCameraEffects(tuningPatch));
        const snapshot = await bounded(tuneEntered.promise, 'stable-track parameter update reaches the processor');
        check(Object.entries(tuningPatch).every(([key, value]) => snapshot.settings[key] === value),
          'The actual parameter change reaches processor reconfiguration');
        check(video.getCameraState().status === 'starting' && video.getCameraState().stream === null
          && video.getCameraStream() === stream && stream.getVideoTracks()[0] === track,
        'Tuning hides the preview while retaining the identical outgoing stream and track');
        check(track.readyState === 'live' && !track.enabled && video.cameraProcessor === processor
          && captures.length === captureCount, 'Tuning gates the existing processed track without stopping or recapturing it');

        nativeGate.resolve();
        const publishedResult = await bounded(publicationResult, 'native publication completes while tuning is starting');
        check(!publishedResult.error, 'A current pending publication must not be cancelled solely because preview status is starting',
          { name: publishedResult.error?.name, message: publishedResult.error?.message });
        if (stageResult) {
          const result = await bounded(stageResult, 'VoiceStage finishes the pending first publication');
          check(!result.error, 'VoiceStage completes its first publication during stable-track tuning');
        }
        await publicationsSettled();
        await tick();
        check(video.getCameraState().status === 'starting' && !track.enabled,
          'Publication completed before reconfiguration was allowed to finish');
        check(peer.session.videoSender === peer.camera.sender && peer.camera.sender.track === track
          && rtc.localCameraTrack === track && voice.isCameraOn && video.getCameraState().publishing,
        'Current sender, cache, and camera flag survive publication completion while preview is starting');
        check(terminalEvents.length === 0 && replacements.length === replacementCount,
          'Pending publication emits neither an error/stop nor a recovery replacement during tuning', terminalEvents);
        preserveOtherMedia(peer);

        tuneGate.resolve();
        const tuned = await bounded(tuningResult, 'real chroma parameter tuning finishes');
        check(!tuned.error, 'The real chroma worker finishes same-track parameter tuning',
          { name: tuned.error?.name, message: tuned.error?.message });
        check(video.getCameraState().status === 'ready' && video.getCameraState().stream === stream
          && stream.getVideoTracks()[0] === track && track.readyState === 'live' && track.enabled,
        'Finishing tuning ungates the same live track and restores the ready preview');
        check(peer.camera.sender.track === track && rtc.localCameraTrack === track && voice.isCameraOn,
          'The current camera remains published after tuning without a replacement event to repair it');
        check(nativeCalls.length === 1 && nativeCalls[0] === track && replacements.length === replacementCount,
          'Tuning required no native detach/reattach and no additional local.camera_replaced event');
        check(captures.length === captureCount && video.cameraProcessor === processor && terminalEvents.length === 0,
          'The whole race preserves capture/processor ownership and emits no stop or error', terminalEvents);
        const stateMessages = sent.filter(entry => entry.type === MessageType.VOICE_STATE_UPDATE);
        check(stateMessages.length === 1 && stateMessages[0].payload.isCameraOn === true,
          'Stable-track tuning never announces camera-off or duplicates the camera-on state');
        await decodedColor(() => route.videos.get(peer.camera.mid),
          entryPoint === 'stage' ? [32, 32, 238] : [238, 32, 32],
          'The same native sender resumes decoding real chroma output after tuning');
        preserveOtherMedia(peer);
      });
    }

    await run('binding-effect-error-dedup-and-dispose', async () => {
      const subscriptions = listenerCount('local.camera_replaced');
      const dispose = bindPublication();
      const peer = makePeer();
      const notices = [];
      listen('camera.error_notice', error => notices.push(error));
      await published();
      const failure = await rejected(video.setCameraEffects({ maxFps: 0 }), 'Invalid persisted effect settings reject');
      await publicationsSettled();
      publication.reportCameraError(failure);
      events.emit('camera.publication_failed', failure);
      publication.reportCameraError(new DOMException('fixture cancelled', 'AbortError'));
      check(notices.length === 1 && notices[0] === failure, 'The same error object is reported once across effect and publication paths; cancellations are ignored');
      check(video.getCameraState().status === 'error' && video.getCameraState().stream === null
        && !voice.isCameraOn && rtc.localCameraTrack === null && peer.camera.sender.track === null,
      'A real source error clears camera publication and exposes no raw fallback');
      preserveOtherMedia(peer);
      dispose();
      events.emit('camera.effects_error', new Error('fixture disposed binding'));
      check(notices.length === 1 && listenerCount('local.camera_replaced') === subscriptions,
        'Disposing the publication binding removes its event handlers');
    });

    await run('binding-current-and-stale-publication-failure', async () => {
      bindPublication();
      const peer = makePeer();
      const notices = [];
      listen('camera.error_notice', error => notices.push(error));
      const original = await published();
      const gate = deferred();
      const entered = deferred();
      const nativeReplace = peer.camera.sender.replaceTrack.bind(peer.camera.sender);
      let delayed = false;
      patch(peer.camera.sender, 'replaceTrack', async track => {
        if (track && track !== original.getVideoTracks()[0] && !delayed) {
          delayed = true;
          entered.resolve();
          await gate.promise;
          throw new Error('fixture stale native replacement failure');
        }
        return nativeReplace(track);
      });
      await video.setCameraDevice('camera-b');
      await bounded(entered.promise, 'first source replacement reaches native sender');
      await video.setCameraDevice('camera-c');
      const newest = video.getCameraState().stream;
      gate.resolve();
      await publicationsSettled();
      check(video.getCameraState().stream === newest && newest.getVideoTracks()[0].readyState === 'live'
        && peer.camera.sender.track === newest.getVideoTracks()[0] && voice.isCameraOn,
      'A stale publication failure cannot stop or detach a newer VideoService source');
      check(notices.length === 0, 'A superseded source failure does not generate a misleading notice');
      const failure = new Error('fixture current native replacement failure');
      patch(peer.camera.sender, 'replaceTrack', async track => {
        if (track) throw failure;
        return nativeReplace(null);
      });
      await video.setCameraDevice('camera-a');
      await until(() => notices.length === 1 && !rtc.cameraTrackChange, 'current publication failure cleanup');
      check(notices[0] === failure && !voice.isCameraOn && rtc.localCameraTrack === null
        && video.getCameraState().stream === null && peer.camera.sender.track === null,
      'A current publication failure stops the source, reports once, and clears only camera');
      preserveOtherMedia(peer);
    });

    await run('settings-preview-lease-device-switch-and-save-failure', async () => {
      const { t } = await import('/i18n/index.ts');
      const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      resources.cleanup.push(() => {
        if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
        else Reflect.deleteProperty(document, 'visibilityState');
      });
      bindPublication();
      const peer = makePeer();
      const tab = new VoiceVideoTab();
      const host = document.createElement('div');
      host.innerHTML = tab.renderHtml();
      document.body.appendChild(host);
      resources.cleanup.push(() => { tab.cleanup(); host.remove(); });
      tab.attachEvents(host);
      await tab.refreshDevices(host);
      const toggle = host.querySelector('[data-camera-preview-toggle]');
      const preview = host.querySelector('#camera-effects-preview');
      const select = host.querySelector('#select-cam');
      await until(() => !toggle.disabled, 'actual camera control loads');
      check(captures.length === 0 && preview.srcObject === null, 'Mounting VoiceVideoTab never captures a device automatically');
      host.querySelector('#camera-effects').scrollIntoView({ block: 'start', behavior: 'instant' });
      tab.activateCameraPreview();
      await until(() => preview.srcObject && video.getCameraState().status === 'ready', 'preview lease starts');
      check(captures.length === 1 && !video.getCameraState().publishing && !voice.isCameraOn && rtc.localCameraTrack === null,
        'Showing the actual camera controls acquires one default-on, nonpublishing preview lease');
      const previewCapture = captures[0].track;
      tab.deactivate();
      check(preview.srcObject === null && preview.hidden && previewCapture.readyState === 'ended',
        'Deactivating a preview-only tab releases its only capture');
      tab.activateCameraPreview();
      await until(() => preview.srcObject, 'second preview lease starts');
      const shared = preview.srcObject;
      const beforePromotion = captures.length;
      await published();
      check(video.getCameraState().stream === shared && captures.length === beforePromotion,
        'Starting a call promotes the exact preview stream without opening another capture');
      tab.deactivate();
      check(preview.srcObject === null && preview.hidden && shared.getVideoTracks()[0].readyState === 'live'
        && peer.camera.sender.track === shared.getVideoTracks()[0],
      'Closing settings preview cannot kill an active call capture or sender');
      select.value = 'camera-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => !select.disabled && video.getCameraState().status === 'ready'
        && video.getCameraState().stream !== shared, 'active camera changes with preview closed');
      await publicationsSettled();
      const switched = video.getCameraState().stream;
      check(settings.selectedCameraId === 'camera-b' && captures.at(-1).constraints.video.deviceId.exact === 'camera-b'
        && peer.camera.sender.track === switched.getVideoTracks()[0] && rtc.localCameraTrack === peer.camera.sender.track,
      'The actual camera select switches the live device and republishes while preview is closed');
      check(shared.getVideoTracks()[0].readyState === 'ended' && captures.at(-2).track.readyState === 'ended'
        && preview.srcObject === null, 'Live device switching retires the old capture without reopening preview');
      settings.selectedCameraId = 'camera-a';
      settings.save();
      check(select.value === 'camera-a', 'An externally persisted quick-camera choice also updates the full settings selector');
      settings.selectedCameraId = 'camera-b';
      settings.save();
      check(select.value === 'camera-b' && video.getCameraState().stream === switched,
        'Synchronizing the displayed camera preference never changes capture or preview ownership');
      const beforeFailure = captures.length;
      const setItem = Storage.prototype.setItem;
      patch(Storage.prototype, 'setItem', function (key, value) {
        if (key === 'monky_settings') throw new DOMException('fixture storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      });
      select.value = 'camera-c';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => !select.disabled, 'camera selection save failure settles');
      check(select.value === 'camera-b' && settings.selectedCameraId === 'camera-b'
        && captures.length === beforeFailure && video.getCameraState().stream === switched,
      'Save failure restores the previous selection and never switches the active capture');
      check(host.querySelector('#camera-effects-status').textContent === t('cameraEffects.deviceSaveFailed'),
        'Save failure displays localized retained-selection status without falsely claiming the camera stopped');
      tab.cleanup();
      check(switched.getVideoTracks()[0].readyState === 'live' && voice.isCameraOn,
        'Disposing all settings controls leaves the published call camera alive');
      select.value = 'camera-c';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      check(captures.length === beforeFailure && settings.selectedCameraId === 'camera-b',
        'Disposed camera-select listeners cannot change devices');
      preserveOtherMedia(peer);
    });

    await run('stage-ready-starting-error-and-overlay-state', async () => {
      bindPublication();
      makePeer();
      const { stage, host } = mountStage(true);
      await stage.toggleCamera();
      const elements = [...host.querySelectorAll('video[id$="-camera"]')];
      check(elements.length > 0 && elements.every(element => element.srcObject === video.getCameraState().stream),
        'The mounted VoiceStage attaches the actual ready camera stream');
      const sentinel = document.createElement('input');
      sentinel.value = 'preserve local DOM';
      host.querySelector('#stage-content-area').appendChild(sentinel);
      const cameraSubscriptions = listenerCount('camera.state_changed');
      const { bridge, states } = await makeOverlay();
      bridge.syncState();
      await until(() => bridge.videoSenders[0].track === video.getCameraState().stream?.getVideoTracks()[0],
        'overlay publishes ready camera');
      check(states.at(-1).participants[0].isCameraOn && states.at(-1).participants[0].videoSlotIndex === 0,
        'Overlay metadata exposes a slot only for the ready local camera');
      const changing = video.setCameraEffects({ mode: 'chroma', backgroundColor: '#2020ee' });
      bridge.syncState();
      check(video.getCameraStream() !== null && video.getCameraState().stream === null
        && elements.every(element => element.srcObject === null),
      'Stage uses ready state, never getCameraStream() while it still points at an old starting stream');
      check(!states.at(-1).participants[0].isCameraOn && states.at(-1).participants[0].videoSlotIndex === undefined,
        'Overlay starting state hides stale local video instead of advertising the old source');
      await changing;
      await publicationsSettled();
      const processed = video.getCameraState().stream;
      await until(() => bridge.videoSenders[0].track === processed.getVideoTracks()[0], 'overlay follows processed replacement event');
      check(elements.every(element => element.isConnected && element.srcObject === processed) && sentinel.isConnected,
        'Camera state changes update existing stage video elements without rebuilding participant DOM');
      const replacements = [];
      listen('local.camera_replaced', event => replacements.push(event));
      const tuning = video.setCameraEffects({ keyTolerance: 30 });
      check(elements.every(element => element.srcObject === null), 'Parameter changes also clear preview during starting');
      await tuning;
      check(video.getCameraState().stream === processed && replacements.length === 0
        && elements.every(element => element.srcObject === processed),
      'Ready state restores the same processed stream even when no replacement event occurs');
      await rejected(video.setCameraEffects({ maxFps: 0 }), 'A real source error reaches the stage');
      await publicationsSettled();
      bridge.syncState();
      check(elements.every(element => element.srcObject === null) && sentinel.isConnected
        && !states.at(-1).participants[0].isCameraOn, 'Error clears stage and overlay camera without rebuilding the stage');
      await bridge.close();
      check(listenerCount('camera.state_changed') === cameraSubscriptions,
        'Closing the overlay removes its per-connection camera subscriptions');
    });

    await run('stage-cancel-pending-toggle', async () => {
      bindPublication();
      const { stage } = mountStage();
      captureGate = deferred();
      const gate = captureGate;
      const starting = stage.toggleCamera();
      await until(() => captures.length === 1, 'stage startup awaits synthetic permission/capture');
      await stage.toggleCamera();
      gate.resolve();
      await starting;
      check(video.getCameraState().stream === null && !voice.isCameraOn && rtc.localCameraTrack === null,
        'A second camera toggle cancels an unfinished first toggle instead of publishing late');
      check(captures[0].track.readyState === 'ended', 'Cancelled stage startup releases the late capture');
      check(!sent.some(entry => entry.type === MessageType.VOICE_STATE_UPDATE && entry.payload.isCameraOn),
        'Cancelled startup never announces camera-on to the control plane');
    });

    await run('overlay-native-serialization-and-reopen', async () => {
      const { bridge } = await makeOverlay();
      const sender = bridge.videoSenders[0];
      const older = source('#ee2020').track;
      const newest = source('#2020ee').track;
      const delayed = delayNative(sender, older);
      bridge.updateVideoSender(0, older);
      await bounded(delayed.entered.promise, 'old overlay replacement enters');
      bridge.updateVideoSender(0, newest);
      bridge.updateVideoSender(0, newest);
      await tick();
      check(!delayed.calls.includes(newest), 'Overlay queues newer assignments behind a pending native replacement');
      delayed.gate.resolve();
      await until(() => !bridge.pendingVideoUpdates.has(sender), 'overlay replacement queue settles');
      check(sender.track === newest && delayed.calls.filter(track => track === newest).length === 1,
        'Latest overlay assignment wins and repeated same-track sync is deduplicated');
      const closedCandidate = source('#20ee20').track;
      const skipped = source('#eeee20').track;
      const closing = delayNative(sender, closedCandidate);
      bridge.updateVideoSender(0, closedCandidate);
      await bounded(closing.entered.promise, 'closing overlay has an in-flight native assignment');
      bridge.updateVideoSender(0, skipped);
      const oldConnection = bridge.localPeerConnection;
      await bridge.close();
      await bridge.open();
      bridge.isWebRtcReady = true;
      const reopenedSender = bridge.videoSenders[0];
      bridge.updateVideoSender(0, newest);
      await until(() => reopenedSender.track === newest, 'reopened overlay receives current source');
      closing.gate.resolve();
      await tick(100);
      check(oldConnection.signalingState === 'closed' && reopenedSender !== sender && reopenedSender.track === newest,
        'A late assignment from a closed overlay cannot mutate its reopened peer connection');
      check(!closing.calls.includes(skipped), 'Queued assignments for a retired overlay sender are discarded');
    });

    check(scenarios > 0, 'The scenario selector must run at least one regression');
    check(captureRequests.every(constraints => constraints.audio === false && constraints.video),
      'All requested captures are camera-only synthetic canvas streams');
    if (unexpected.length) failures.push({ scenario: 'unhandled-renderer-errors', message: unexpected.join('\n') });
    return { checks, scenarios, failures };
  } finally {
    video.dispose();
    rtc.closeAllPeers();
    audioDestination.stream.getTracks().forEach(track => track.stop());
    await context.close();
    network.send = originalSend;
    network.sendRequest = originalRequest;
    if (originalSignalDescriptor) Object.defineProperty(rtc, 'signalClient', originalSignalDescriptor);
    else delete rtc.signalClient;
    rtc.rtcConfig = originalRtcConfiguration;
    media.getUserMedia = originalCapture;
    media.enumerateDevices = originalEnumerate;
    media.getDisplayMedia = originalDisplay;
    window.RTCPeerConnection = nativePeerConnection;
    window.api = originalApi;
    window.removeEventListener('unhandledrejection', onUnhandled);
  }
}
