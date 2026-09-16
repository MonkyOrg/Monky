const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { mock } = require('node:test');
const { app, BrowserWindow } = require('electron');
const { MessageType } = require('@monky/shared');
const { createServerFixture } = require('./server_fixture.cjs');
const { NativeClient } = require('./native_client.cjs');

const profile = process.env.MONKY_LIGHT_BROWSER_PROFILE;
assert.ok(profile && path.isAbsolute(profile), 'An isolated browser fixture profile is required');
const mode = process.argv.at(-1);
assert.ok(['p2p', 'sfu'].includes(mode));
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('disable-audio-input');
app.commandLine.appendSwitch('disable-audio-output');
app.on('window-all-closed', () => {});

async function run() {
  const cleanup = [];
  let window;
  let ending = false;
  let failure;
  const fail = error => { if (!ending) failure ??= error; };
  const check = () => { if (failure) throw failure; };
  try {
    const fixture = await createServerFixture({ after: action => cleanup.push(action), mock }, { voiceMode: mode });
    const native = new NativeClient(fixture, { nickname: 'Native peer' });
    const auth = await native.wait('authenticated');
    const browser = await fixture.connectHuman('Chromium peer');
    const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
    const bundle = mode === 'sfu' ? require('esbuild').buildSync({
      stdin: { contents: 'export { Device } from "mediasoup-client";', resolveDir: path.resolve(__dirname, '..', '..', 'client') },
      bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
    }).outputFiles[0].text : '';
    const page = http.createServer((request, response) => {
      if (request.url === '/mediasoup.js' && mode === 'sfu') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(bundle);
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body></body></html>');
      } else {
        response.writeHead(404).end();
      }
    });
    cleanup.push(() => new Promise((resolve, reject) => {
      page.closeAllConnections();
      page.close(error => error ? reject(error) : resolve());
    }));
    await new Promise((resolve, reject) => {
      page.once('error', reject);
      page.listen(0, '127.0.0.1', () => { page.removeListener('error', reject); resolve(); });
    });
    window = new BrowserWindow({
      show: false, width: 320, height: 240, useContentSize: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const evaluate = expression => window.webContents.executeJavaScript(expression, true);
    const replies = new Map([
      [MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES, [MessageType.SFU_ROUTER_RTP_CAPABILITIES]],
      [MessageType.SFU_CREATE_WEBRTC_TRANSPORT, [MessageType.SFU_WEBRTC_TRANSPORT_CREATED]],
      [MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, [MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED]],
      [MessageType.SFU_PRODUCE, [MessageType.SFU_PRODUCED]],
      [MessageType.SFU_GET_PRODUCERS, [MessageType.SFU_PRODUCERS_LIST]],
      [MessageType.SFU_CONSUME, [MessageType.SFU_CONSUMED, MessageType.SFU_PRODUCER_CLOSED]],
    ]);
    window.webContents.on('console-message', (_event, level, text) => {
      if (!text.startsWith('LIGHT_FIXTURE:')) {
        if (level >= 3) fail(new Error(text));
        return;
      }
      let event;
      try { event = JSON.parse(text.slice('LIGHT_FIXTURE:'.length)); } catch (error) { fail(error); return; }
      if (event.kind === 'signal') {
        browser.peer.send(MessageType.RTC_SIGNAL, {
          ...event.payload, fromSessionId: browser.auth.currentUser.sessionId, targetSessionId: auth.sessionId,
        });
      } else if (event.kind === 'rpc') {
        const accepted = replies.get(event.type);
        if (!accepted) { fail(new Error(`Unexpected browser fixture RPC: ${event.type}`)); return; }
        void browser.peer.request(event.type, event.payload, accepted).then(
          result => evaluate(`peerFixture.complete(${JSON.stringify({ id: event.id, result })})`),
          error => evaluate(`peerFixture.complete(${JSON.stringify({ id: event.id, error: error.message })})`),
        ).catch(fail);
      } else if (event.kind === 'error') {
        fail(new Error(event.detail));
      }
    });
    let signals = Promise.resolve();
    const relay = data => {
      const message = JSON.parse(data.toString());
      if (![MessageType.RTC_SIGNAL, MessageType.SFU_NEW_PRODUCER, MessageType.SFU_PRODUCER_CLOSED].includes(message.type)) return;
      signals = signals.then(() => ending ? undefined : evaluate(
        `peerFixture.receive(${JSON.stringify(message)})`,
      )).catch(fail);
    };
    await window.loadURL(`http://127.0.0.1:${page.address().port}/`);
    const config = { mode, channelId, selfSessionId: browser.auth.currentUser.sessionId, MessageType };
    await evaluate(`(${setupBrowserPeer.toString()})(${JSON.stringify(config)})`);
    browser.peer.socket.on('message', relay);
    cleanup.push(() => browser.peer.socket.removeListener('message', relay));
    await native.join(channelId);
    await browser.peer.request(MessageType.VOICE_JOIN, { channelId, isMuted: false, isDeafened: false },
      [MessageType.VOICE_USER_JOINED]);
    if (mode === 'p2p') {
      const streamId = await evaluate('peerFixture.screenStreamId');
      browser.peer.send(MessageType.RTC_SIGNAL, {
        fromSessionId: browser.auth.currentUser.sessionId, targetSessionId: auth.sessionId,
        signalType: 'screen-audio-meta', streamId,
      });
    }
    await evaluate('peerFixture.start()');
    await native.untilState(value => {
      check();
      return value.audioDevice.playoutCallbacks > 25;
    }, 'Chromium audio did not establish native playout');
    const silent = await native.state();
    assert.ok(silent.audioDevice.outputRms < 0.00001, 'Screen audio was incorrectly treated as the microphone');
    await evaluate('peerFixture.microphoneGain.gain.value = 0.0625');
    await native.untilState(value => {
      check();
      return value.audioDevice.outputEnergy > silent.audioDevice.outputEnergy + 0.1;
    }, 'Chromium microphone was not decoded by the native engine');
    await native.decodedFrom(browser.auth.currentUser.sessionId);
    const deadline = Date.now() + 15_000;
    let metrics;
    do {
      check();
      metrics = await evaluate('peerFixture.stats()');
      if (metrics.playoutRms > 0.00001) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(metrics.playoutRms > 0.00001,
      `Native microphone was not decoded by Chromium: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.silentSink, true, 'Browser fixture must never open physical audio output');
    if (mode === 'p2p') {
      assert.equal(metrics.videoRejected, true, 'Voice-only native answer must reject offered video');
      assert.equal(metrics.directions[0], 'inactive', 'The screen-audio m-line must be inactive');
    }
    const codecs = await native.nativeAudioState();
    assert.equal(codecs.videoEncoderCreations, 0, 'Voice-only native call instantiated a video encoder');
    assert.equal(codecs.videoDecoderCreations, 0, 'Voice-only native call instantiated a video decoder');
    await evaluate('peerFixture.stop()');
    ending = true;
    await signals;
    await native.close();
    console.log(`Native/Chromium ${mode} bidirectional decoded audio succeeded without physical media devices.`);
  } finally {
    ending = true;
    const errors = [];
    if (window && !window.isDestroyed()) window.destroy();
    for (const action of cleanup.reverse()) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    mock.restoreAll();
    if (errors.length) throw new AggregateError(errors, 'Browser interoperability cleanup failed');
  }
}

async function setupBrowserPeer(config) {
  const { MessageType: M, mode, channelId, selfSessionId } = config;
  const emit = event => console.log('LIGHT_FIXTURE:' + JSON.stringify(event));
  const reportError = error => emit({ kind: 'error', detail: error.message });
  if (!('sinkId' in AudioContext.prototype)) throw new Error('Silent Web Audio sinks are required by this fixture');
  const audio = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  if (audio.sinkId?.type !== 'none') throw new Error('The browser did not create a silent audio sink');
  await audio.resume();
  const tone = (frequency, amplitude) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    oscillator.frequency.value = frequency;
    gain.gain.value = amplitude;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    return { oscillator, gain, destination, track: destination.stream.getAudioTracks()[0] };
  };
  const microphone = tone(1000, 0);
  const screen = tone(2000, 0.25);
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  canvas.getContext('2d').fillRect(0, 0, 16, 16);
  const video = canvas.captureStream(0);
  const sources = [];
  const elements = [];
  const analysers = [];
  const attach = track => {
    if (track.kind !== 'audio') return;
    const source = audio.createMediaStreamSource(new MediaStream([track]));
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser).connect(audio.destination);
    sources.push(source);
    analysers.push({ node: analyser, samples: new Float32Array(analyser.fftSize) });
    // Match RemoteMediaRouter: Chromium's RTC playout is driven by a media
    // element, while Web Audio receives the PCM. All output devices are fake.
    const element = new Audio();
    element.volume = 0;
    element.srcObject = new MediaStream([track]);
    document.body.appendChild(element);
    elements.push(element);
    void element.play().catch(reportError);
  };
  const pending = new Map();
  const rpc = (type, payload) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    emit({ kind: 'rpc', id, type, payload: { channelId, ...payload } });
  });
  let pc;
  let send;
  let recv;
  let producer;
  const consumers = new Map();
  const descriptions = new Map();
  const candidates = [];
  let receiveTail = Promise.resolve();
  const consume = async description => {
    const id = description.producerId;
    if (!recv || consumers.has(id) || description.producerSessionId === selfSessionId ||
      description.kind !== 'audio' || description.appData.mediaType !== 'mic') return;
    const response = await rpc(M.SFU_CONSUME, {
      transportId: recv.id, producerId: id, rtpCapabilities: peerFixture.device.rtpCapabilities,
    });
    if (response.type === M.SFU_PRODUCER_CLOSED) return;
    const consumer = await recv.consume(response.payload);
    attach(consumer.track);
    consumers.set(id, consumer);
  };
  if (mode === 'p2p') {
    pc = new RTCPeerConnection({ iceServers: [] });
    // Screen audio deliberately precedes the microphone to exercise classification by metadata.
    pc.addTransceiver(screen.track, { direction: 'sendonly', streams: [screen.destination.stream] });
    pc.addTransceiver(microphone.track, { direction: 'sendrecv', streams: [microphone.destination.stream] });
    pc.addTransceiver(video.getVideoTracks()[0], { direction: 'sendonly', streams: [video] });
    pc.ontrack = event => attach(event.track);
    pc.onicecandidate = event => {
      if (event.candidate) emit({ kind: 'signal', payload: { signalType: 'candidate', candidate: event.candidate.toJSON() } });
    };
  }
  globalThis.peerFixture = {
    microphoneGain: microphone.gain,
    screenStreamId: screen.destination.stream.id,
    complete({ id, result, error }) {
      const request = pending.get(id);
      if (!request) throw new Error('Unexpected fixture RPC completion');
      pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    },
    async start() {
      if (pc) {
        await pc.setLocalDescription(await pc.createOffer());
        emit({ kind: 'signal', payload: { signalType: 'offer', sdp: pc.localDescription.toJSON() } });
        return;
      }
      const { Device } = await import('/mediasoup.js');
      this.device = new Device();
      const capabilities = await rpc(M.SFU_GET_ROUTER_RTP_CAPABILITIES, {});
      await this.device.load({ routerRtpCapabilities: capabilities.payload.rtpCapabilities });
      for (const direction of ['send', 'recv']) {
        const response = await rpc(M.SFU_CREATE_WEBRTC_TRANSPORT, { direction });
        const transport = direction === 'send'
          ? this.device.createSendTransport(response.payload.transportOptions)
          : this.device.createRecvTransport(response.payload.transportOptions);
        transport.on('connect', ({ dtlsParameters }, resolve, reject) => {
          void rpc(M.SFU_CONNECT_WEBRTC_TRANSPORT, { transportId: transport.id, dtlsParameters }).then(resolve, reject);
        });
        if (direction === 'send') send = transport;
        else recv = transport;
      }
      send.on('produce', ({ kind, rtpParameters, appData }, resolve, reject) => {
        void rpc(M.SFU_PRODUCE, { transportId: send.id, kind, rtpParameters, appData }).then(
          response => resolve({ id: response.payload.id }), reject,
        );
      });
      producer = await send.produce({ track: microphone.track, appData: { mediaType: 'mic' } });
      const snapshot = await rpc(M.SFU_GET_PRODUCERS, {});
      for (const description of snapshot.payload.producers) descriptions.set(description.producerId, description);
      for (const description of descriptions.values()) await consume(description);
    },
    receive(message) {
      receiveTail = receiveTail.then(async () => {
        const value = message.payload;
        if (message.type === M.SFU_NEW_PRODUCER) {
          descriptions.set(value.producerId, value);
          await consume(value);
        } else if (message.type === M.SFU_PRODUCER_CLOSED) {
          descriptions.delete(value.producerId);
          consumers.get(value.producerId)?.close();
          consumers.delete(value.producerId);
        } else if (pc && value.signalType === 'candidate') {
          if (pc.remoteDescription) await pc.addIceCandidate(value.candidate);
          else candidates.push(value.candidate);
        } else if (pc && ['offer', 'answer'].includes(value.signalType)) {
          await pc.setRemoteDescription(value.sdp);
          for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
          if (value.signalType === 'offer') {
            await pc.setLocalDescription(await pc.createAnswer());
            emit({ kind: 'signal', payload: { signalType: 'answer', sdp: pc.localDescription.toJSON() } });
          }
        }
      }).catch(reportError);
    },
    async stats() {
      const reports = pc ? [...(await pc.getStats()).values()]
        : (await Promise.all([...consumers.values()].map(async consumer => [...(await consumer.getStats()).values()]))).flat();
      return {
        silentSink: audio.sinkId?.type === 'none',
        audioState: audio.state,
        playoutRms: Math.max(0, ...analysers.map(({ node, samples }) => {
          node.getFloatTimeDomainData(samples);
          return Math.sqrt(samples.reduce((energy, sample) => energy + sample * sample, 0) / samples.length);
        })),
        inbound: reports.filter(report => report.type === 'inbound-rtp' && report.kind === 'audio'),
        videoRejected: pc ? pc.getTransceivers().filter(transceiver => transceiver.receiver.track.kind === 'video')
          .every(transceiver => transceiver.currentDirection === 'inactive' || transceiver.currentDirection === null) : null,
        directions: pc?.getTransceivers().map(transceiver => transceiver.currentDirection) ?? [],
      };
    },
    async stop() {
      await receiveTail;
      for (const consumer of consumers.values()) consumer.close();
      consumers.clear();
      producer?.close();
      send?.close();
      recv?.close();
      if (pc) {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.close();
      }
      for (const source of sources) source.disconnect();
      for (const { node } of analysers) node.disconnect();
      for (const element of elements) {
        element.pause();
        element.srcObject = null;
        element.remove();
      }
      for (const value of [microphone, screen]) {
        value.track.stop();
        value.oscillator.stop();
        value.oscillator.disconnect();
        value.gain.disconnect();
        value.destination.disconnect();
      }
      for (const track of video.getTracks()) track.stop();
      await audio.close();
      if (pending.size !== 0) throw new Error('Browser fixture leaked pending RPCs');
    },
  };
}

void app.whenReady().then(run).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
