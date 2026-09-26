'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const {
  getScreenShareProfile, getScreenH264ProfileLevelId, messageReferenceSchema, nativeScreenSourceSchema, nativeScreenP2pControlSchema,
  nativeScreenRenditionSchema, nativeScreenEndpointDiagnosticsSchema, screenShareProfileKey,
} = require('@monky/shared');
const { CaptureBridge } = require('./captureBridge.cjs');
const { cloneSource, validateEncoder, ENCODERS } = require('./captureProtocol.cjs');
const { LiveSenderFlow } = require('./encodedSender.cjs');
const { NativeRtcCommands, assertNativeRtcEngineClosed } = require('./nativeRtcCommands.cjs');
const { NativeP2pBroker } = require('./nativeP2pBroker.cjs');
const { NativeP2pTransport } = require('./nativeP2pTransport.cjs');
const { NativeSfuBroker } = require('./nativeSfuBroker.cjs');
const { NativeSfuTransport } = require('./nativeSfuTransport.cjs');
const { NativeScreenRoutes } = require('./nativeScreenRoutes.cjs');
const { NativePresentationBridge } = require('./nativePresentationBridge.cjs');
const { NativePcmCaptureBridge } = require('./nativePcmCaptureBridge.cjs');
const { createNativeAudioOutput } = require('./nativeAudioOutput.cjs');
const { NativeAudioReceiveAdapter } = require('./nativeAudioReceiveAdapter.cjs');
const { assertNativeAudioOutputStopped } = require('./nativeAudioOutputOwner.cjs');
const { within } = require('./nativeDeadline.cjs');
const { rtpReports, decoderObservations } = require('./nativeVideoDiagnostics.cjs');

const cancelled = () => new DOMException('The native screen endpoint was retired.', 'AbortError');
const endpointOwners = new WeakMap();
const gameStartupFailures = new Set([
  'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE', 'ERR_SCREEN_CAPTURE_SOURCE', 'ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION',
]);

class NativeScreenEndpoint {
  constructor(options) {
    const { runtime, textures, role, mode, sessionId, publisherSessionId, channelId, pipelineId,
      target, captureDirectory, destination, send, rpc, onError, onState, onDiagnostic } = options;
    assert.ok(['publish', 'receive'].includes(role) && ['p2p', 'sfu'].includes(mode));
    for (const value of [sessionId, publisherSessionId, channelId]) {
      messageReferenceSchema.parse(value);
      assert.ok(!value.includes('\0') && Buffer.byteLength(value) <= 128);
    }
    const source = nativeScreenSourceSchema.parse(options.source);
    const profile = getScreenShareProfile(source.video, options.quality, source.codec);
    const rendition = nativeScreenRenditionSchema.parse({ sourceInstanceId: source.instanceId, pipelineId, video: profile });
    assert.equal(role === 'publish', sessionId === publisherSessionId);
    const audio = options.audio ?? null;
    assert.equal(source.audio, audio !== null, 'Native A/V requires explicit capture and output configuration.');
    if (audio) {
      assert.ok(typeof audio.sinkId === 'string' && audio.sinkId.length <= 512 && !audio.sinkId.includes('\0'));
      assert.equal(typeof audio.muted, 'boolean');
      assert.ok(Number.isFinite(audio.volume) && audio.volume >= 0 && audio.volume <= 2);
      assert.equal(typeof audio.output?.createMessageChannel, 'function');
      if (role === 'publish') {
        assert.equal(typeof audio.captureModule?.createPacketCapture, 'function');
        assert.ok(Number.isSafeInteger(audio.maxBitrateBps) && audio.maxBitrateBps >= 6000 && audio.maxBitrateBps <= 510000);
      }
    }
    assert.equal(typeof runtime?.rtc?.createEngine, 'function');
    for (const method of ['importSharedTexture', 'sendSharedTexture']) assert.equal(typeof textures?.[method], 'function');
    for (const observer of [onError, onState, onDiagnostic]) assert.equal(typeof observer, 'function');
    if (mode === 'p2p') assert.equal(typeof send, 'function');
    else assert.equal(typeof rpc, 'function');
    if (role === 'publish') {
      cloneSource(target);
      validateEncoder(options.captureEncoder ?? 'auto');
      assert.equal(!options.captureEncoder || options.captureEncoder === 'auto' ? 'h264' :
        ENCODERS[options.captureEncoder].codec, source.codec ?? 'h264',
        'The selected capture encoder must match the announced screen codec.');
      if (options.preserveAspectRatio !== undefined) assert.equal(typeof options.preserveAspectRatio, 'boolean');
      assert.ok(path.isAbsolute(captureDirectory));
    } else assert.ok(destination && typeof destination.frame?.isDestroyed === 'function');
    Object.assign(this, { runtime, role, mode, sessionId, publisherSessionId, channelId, pipelineId, source, profile,
      rendition, captureDirectory, destination, send, rpc, onError, onState, onDiagnostic });
    this.audio = audio;
    this.audioMuted = audio?.muted ?? true;
    this.audioVolume = audio?.volume ?? 1;
    this.target = target ? cloneSource(target) : null;
    this.captureEncoder = options.captureEncoder ?? 'auto';
    this.preserveAspectRatio = options.preserveAspectRatio ?? true;
    this.isSourcePaused = options.isSourcePaused ?? (() => false);
    this.assertSourceCurrent = options.assertSourceCurrent ?? (() => {});
    this.onPreview = options.onPreview ?? null;
    this.pending = new Set();
    this.demandWork = new Set();
    this.connections = new Map();
    this.peerReadiness = new Map();
    this.pendingControlBytes = 0;
    this.pendingControlCount = 0;
    this.sfuStates = new Map();
    this.errors = [];
    this.reported = new WeakSet();
    this.early = [];
    this.demand = 0;
    this.previewDemand = false;
    this.closing = false;
    this.stopRequested = false;
    this.nativeClosed = false;
    this.closed = false;
    this.abort = new AbortController();
    this.captureState = 'waiting';
    this.captureMode = null;
    this.engine = runtime.rtc.createEngine({
      maxResources: 64, maxDecodedFrames: 16,
      maximumH264Level: role === 'publish' ? Number.parseInt(getScreenH264ProfileLevelId(profile).slice(-2), 16) : 60,
      requireAudio: source.audio,
      videoInput: role === 'publish' ? (source.codec === 'av1' ? 'encoded-av1' : 'encoded-h264') : 'nv12',
    }, event => {
      if (!this.transport) { this.early.push(event); return; }
      this.track(this.dispatch(event));
    });
    this.commands = new NativeRtcCommands(this.engine);
    endpointOwners.set(this, { engine: this.engine, commands: this.commands, locallyRetired: false, fullyRetired: false });
    this.track(this.engine.ready);
    try {
      this.routes = new NativeScreenRoutes({ maximumPeers: 64, maximumReceivers: 64 });
      this.presentation = new NativePresentationBridge(this.engine, textures, error => this.report(error), { drainTimeoutMs: 12000 });
      if (audio) {
        this.audioOutput = createNativeAudioOutput({
          ...audio.output, engine: this.engine, commands: this.commands, sessionId: pipelineId,
          protocol: require('@monky/shared'), onError: error => this.report(error),
        });
        this.audioAdapter = new NativeAudioReceiveAdapter({
          engine: this.engine, output: this.audioOutput.owner, callId: source.instanceId, channelId,
          isCurrent: () => !this.closing,
        });
      }
      if (mode === 'p2p') {
        this.broker = new NativeP2pBroker({
          engine: this.engine, commands: this.commands, routes: this.routes, localSessionId: sessionId,
          callId: source.instanceId, channelId, syncGroup: source.instanceId, maximumPeers: 64,
          controlVersion: source.audio ? 2 : 1, audio: this.audioAdapter ?? null,
          isCurrent: () => !this.closing, onError: (error, context) => this.report(error, context),
          send: (remote, value) => send(remote, nativeScreenP2pControlSchema.parse(value)),
          onPeerState: state => { this.refreshCapture(); this.observe({ type: 'peer', state }); },
          onPublicationState: () => this.refreshCapture(),
        });
        this.transport = new NativeP2pTransport(this.broker, error => this.report(error), {
          audioPublication: source.audio,
          preparePeer: async (peerId, remoteSessionId) => {
            if (this.role === 'publish') await this.commands.request('peer.configureBitrate', peerId, {
              startBitrateBps: Math.min(5000000, this.profile.maxBitrateKbps * 1000),
              maxBitrateBps: this.profile.maxBitrateKbps * 1000,
            });
            else await this.commands.request('peer.configureVideoPlayout', peerId, { minimumDelayMs: 0 });
            this.abort.signal.throwIfAborted();
            this.peerReady(remoteSessionId).resolve();
          },
        });
      } else {
        this.broker = new NativeSfuBroker({
          engine: this.engine, commands: this.commands, routes: this.routes, rpc, channelId,
          publisherSessionId: sessionId, screenSessionId: pipelineId,
          isCurrent: () => !this.closing,
          isWatchCurrent: (publisher, share, version) => !this.closing && role === 'receive'
            && publisher === publisherSessionId && share === source.shareId && version === this.watchVersion,
          ...(audio ? {
            audio: this.audioAdapter, callId: source.instanceId, connectionId: pipelineId, generation: 1,
            nativeCapabilities: runtime.rtc.capabilities(),
            isAudioWatchCurrent: (publisher, share, version) => !this.closing && role === 'receive'
              && publisher === publisherSessionId && share === source.shareId && version === this.watchVersion,
            isAudioPublicationCurrent: context => !this.closing && this.demand > 0 && role === 'publish'
              && context.sourceId === this.pcm?.sourceId && context.shareId === source.shareId
              && context.syncGroup === source.instanceId,
          } : {}),
          onError: error => this.report(error),
        });
        this.transport = new NativeSfuTransport(this.broker, error => this.report(error), { audioPublication: source.audio });
      }
      for (const event of this.early.splice(0)) this.track(this.dispatch(event));
      this.ready = this.initialize();
    } catch (error) {
      // Once an engine exists, return its owner even if composition fails.
      // The caller observes ready's rejection and still has a real close path.
      this.ready = Promise.reject(error);
    }
    this.track(this.ready);
  }

  report(value, context) {
    const error = value instanceof Error ? value : new Error(String(value));
    if ((this.closing || this.stopRequested) && error.name === 'AbortError') return;
    if (this.reported.has(error)) return;
    this.reported.add(error);
    if (this.errors.length < 32) this.errors.push(error);
    try { this.onError(error, context); }
    catch (observerError) { console.error('Native screen error observer failed:', observerError); }
  }

  observe(state) {
    try { this.onState(state); }
    catch (error) { this.report(error); }
  }

  track(work) {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), error => { this.pending.delete(work); this.report(error); });
    return work;
  }

  async initialize() {
    await this.engine.ready;
    this.abort.signal.throwIfAborted();
    if (this.role === 'receive' && this.audio) {
      await this.audioOutput.owner.start(this.audio.sinkId, this.abort.signal);
      this.abort.signal.throwIfAborted();
    }
    if (this.mode === 'p2p') {
      await this.broker.setRoster(this.publisherSessionId, [this.source.shareId]);
      if (this.role === 'receive') await this.broker.setRoster(this.sessionId, []);
    } else {
      this.routes.setRoster(this.publisherSessionId, [this.source.shareId]);
      if (this.role === 'receive')
        this.watchVersion = this.routes.setWatching(this.publisherSessionId, this.source.shareId, this.destination);
    }
    if (this.role === 'publish') {
      const { width, height, fps, maxBitrateKbps } = this.profile;
      const created = await this.commands.request('source.createEncodedVideo', 0,
        { width, height, fps, syncGroup: this.source.instanceId, enabled: false });
      this.sourceId = created.sourceId;
      this.flow = new LiveSenderFlow({
        engine: this.engine, sourceId: this.sourceId, initialBitrateKbps: Math.min(5000, maxBitrateKbps),
        onError: error => this.report(error),
      });
      this.abort.signal.throwIfAborted();
      this.sourceDescription = {
        sourceId: this.sourceId, shareId: this.source.shareId, syncGroup: this.source.instanceId,
        maxFramerate: fps, maxBitrateBps: maxBitrateKbps * 1000,
        ...(this.mode === 'sfu' ? { nativeScreen: this.rendition } : {}),
      };
    }
    this.refreshCapture();
  }

  async startAudioSource() {
    this.assertDemandCurrent();
    this.pcm = new NativePcmCaptureBridge(this.engine, this.commands, this.audio.captureModule,
      error => this.report(error), { captureHub: this.audio.captureHub ?? null });
    const selection = this.target.kind === 'monitor' ? { excludePid: process.pid }
      : { includeWindowId: this.target.hwnd, expectedProcessId: this.target.expectedProcessId };
    const captured = await this.pcm.start(selection, this.source.instanceId, this.abort.signal);
    this.assertDemandCurrent();
    // A quiet application can legitimately have no packet yet. Publish its
    // disabled source and let the first real capture packet establish its epoch.
    this.pcm.arm();
    this.audioPublication = await this.transport.addAudioSource({
      sourceId: captured.sourceId, screenAudioShareId: this.source.shareId,
      syncGroup: this.source.instanceId, maxBitrateBps: this.audio.maxBitrateBps,
    }, this.abort.signal);
  }

  async dispatch(event) {
    if (this.audioOutput?.owner.handleNativeEvent(event)) return;
    if (event.type === 'frame') {
      const delivered = await this.presentation.publish(event, this.closing ? null : this.routes.resolveFrame(event));
      if (delivered.imported && !this.firstFrame) {
        this.firstFrame = true;
        this.observe({ type: 'frame' });
      }
    } else if (event.type === 'source.encodedFeedback') this.flow?.feedback(event);
    else if (event.type === 'source.encodedFrameReleased') {
      assert.ok(this.flow, 'Encoded retirement has no source owner.');
      this.flow.released(event);
      this.host?.resumePackets();
    } else if (event.type === 'error') {
      const error = Object.assign(new Error(event.data.message), event.data);
      if (event.data.terminal === false) this.onDiagnostic(error);
      else throw error;
    } else if (event.type === 'sfu.state') {
      this.sfuStates.set(event.target, event.data.state);
      this.refreshCapture();
      this.observe({ type: 'transport', state: event.data.state });
    } else await this.transport.handleEvent(event);
  }

  connected() {
    if (this.mode === 'sfu') {
      const transport = this.broker.transports.get('send');
      const state = this.sfuStates.get(transport?.nativeId);
      return state === 'connected' || state === 'completed';
    }
    return [...this.connections.keys()].some(id => this.broker.getPeer(id)?.nativeState.connectionState === 'connected');
  }

  refreshCapture() {
    if (!this.flow) return;
    const stopping = this.stopRequested || this.closing;
    this.flow.setDemand(!stopping && this.demand > 0
      && (this.mode === 'sfu' ? this.sfuPublicationRequested === true : this.broker.sourceDemand(this.sourceId) > 0));
    this.flow.setConnected(!stopping && this.connected());
    if (!stopping && (this.previewDemand || (this.flow.demand && this.flow.connected)) && !this.captureWork) {
      this.captureWork = this.startCapture();
      this.track(this.captureWork);
    }
  }

  async setDemand(count, preview = this.previewDemand) {
    assert.equal(this.role, 'publish');
    assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 64);
    assert.equal(typeof preview, 'boolean');
    assert.ok(count > 0 || !preview || !this.publicationWork,
      'A network publication must retire before a local-only preview replaces it.');
    if (count === 0 && !preview) return this.close();
    this.assertDemandCurrent();
    const work = this.applyDemand(count, preview);
    this.demandWork.add(work);
    const remove = () => this.demandWork.delete(work);
    void work.then(remove, remove);
    return work;
  }

  assertDemandCurrent() {
    if (this.stopRequested || this.closing) throw cancelled();
    this.abort.signal.throwIfAborted();
  }

  async applyDemand(count, preview) {
    this.demand = count;
    this.previewDemand = preview;
    this.refreshCapture();
    await this.ready;
    this.assertDemandCurrent();
    if (count === 0) { this.refreshCapture(); return; }
    if (!this.publicationWork) {
      this.publicationWork = this.track((async () => {
        this.publication = await this.transport.addSource(this.sourceDescription, this.abort.signal);
        this.assertDemandCurrent();
        await this.commands.request('source.setEnabled', this.sourceId, { enabled: true });
      })());
    }
    await this.publicationWork;
    this.assertDemandCurrent();
    if (this.audio) {
      if (!this.audioStartWork) this.audioStartWork = this.track(this.startAudioSource());
      await this.audioStartWork;
      this.assertDemandCurrent();
    }
    if (this.mode === 'sfu') {
      await this.broker.setProducerEnabled(this.publication.producerId, count > 0);
      this.assertDemandCurrent();
      this.sfuPublicationRequested = true;
      if (this.audioPublication) await this.broker.syncAudioProducer(this.audioPublication.producerId);
    }
    this.refreshCapture();
  }

  async startCapture() {
    this.captureState = 'starting';
    this.observe({ type: 'capture', state: this.captureState });
    try {
      await this.startCaptureAttempt(this.target);
    } catch (error) {
      if (!this.canRetryGameCapture(error, this.target)) throw error;
      this.onDiagnostic(error);
      this.recoveringHost = this.host;
      this.assertSourceCurrent();
      await this.stopCaptureHost(this.host);
      assert.equal(this.host.snapshot().nativeClosed, true, 'Game Capture must retire before switching to Normal.');
      assert.equal(this.host.liveFrames.packets, 0, 'A running capture cannot restart its encoded timeline in place.');
      assert.equal(this.flow.inFlight.size, 0);
      this.gameCaptureRetirement = this.host.snapshot();
      await this.removeOwnedDirectory();
      this.abort.signal.throwIfAborted();
      this.assertSourceCurrent();
      this.observe({ type: 'capture-fallback' });
      await this.startCaptureAttempt(cloneSource({ ...this.target, kind: 'window' }));
    }
    this.abort.signal.throwIfAborted();
    this.captureState = 'running';
    this.observe({ type: 'capture', state: this.captureState });
  }

  canRetryGameCapture(error, target) {
    return target.kind === 'game' && !this.abort.signal.aborted && gameStartupFailures.has(error.code)
      && this.captureMode === null && this.host?.liveFrames.packets === 0;
  }

  async stopCaptureHost(host) {
    try { await host?.stop(); }
    catch (error) {
      if (error.code === 'ERR_SCREEN_CAPTURE_SOURCE_LOST' && host.snapshot().nativeClosed) {
        // The source disappeared, but the bridge proved complete native retirement.
        this.report(error);
        return;
      }
      if (host !== this.recoveringHost || !gameStartupFailures.has(error.code) || !host.snapshot().nativeClosed) throw error;
    }
  }

  async startCaptureAttempt(target) {
    this.abort.signal.throwIfAborted();
    this.assertSourceCurrent();
    const mode = target.kind === 'game' ? 'game' : 'normal';
    this.observe({ type: 'capture-mode', capture: { mode, ready: false } });
    const runId = randomBytes(16).toString('hex');
    this.runDirectory = path.join(this.captureDirectory, `monky-screen-capture-${runId}`);
    this.directoryCreated = false;
    this.directoryRemoved = false;
    await fs.mkdir(this.runDirectory);
    this.directoryCreated = true;
    this.runId = runId;
    this.abort.signal.throwIfAborted();
    while (this.isSourcePaused()) {
      await require('node:timers/promises').setTimeout(100, undefined, { signal: this.abort.signal });
      this.abort.signal.throwIfAborted();
    }
    const { width, height, fps, maxBitrateKbps } = this.profile;
    this.host = new CaptureBridge({
      host: this.runtime.host, runtime: this.runtime.obs, runId, runDirectory: this.runDirectory,
      encoder: this.captureEncoder,
      bitrateCeilingKbps: maxBitrateKbps,
      video: { width, height, fps, bitrateKbps: Math.min(5000, maxBitrateKbps),
        scaleMode: this.preserveAspectRatio ? 'fit' : 'stretch' },
      isSourcePaused: this.isSourcePaused,
      onError: error => {
        if (!this.canRetryGameCapture(error, target)) this.report(error);
      }, onPacket: frame => {
        if (this.captureMode === null) {
          this.captureMode = mode;
          this.observe({ type: 'capture-mode', capture: { mode, ready: true } });
        }
        this.flow.setCapturePaused(this.isSourcePaused());
        const result = this.flow.packet(frame);
        if (!this.stopRequested && this.previewDemand && result !== false && !this.isSourcePaused()) {
          try { this.onPreview?.(frame); }
          catch (error) { this.onDiagnostic(error); }
        }
        return result;
      }, onNotice() {},
    });
    await this.host.prepare(target, this.abort.signal);
    this.abort.signal.throwIfAborted();
    // Feedback can arrive before capture. Bind only the host that produced its
    // first AU, so a rejected Game Capture attempt owns no feedback or RTC copy.
    await this.host.start(target);
    this.abort.signal.throwIfAborted();
    this.flow.bind(this.host);
  }

  async connectPeer(remoteSessionId, configuration) {
    assert.equal(this.mode, 'p2p');
    messageReferenceSchema.parse(remoteSessionId);
    await this.ready;
    this.abort.signal.throwIfAborted();
    assert.ok(!this.connections.has(remoteSessionId));
    if (this.role === 'receive') assert.equal(remoteSessionId, this.publisherSessionId);
    await this.broker.setRoster(remoteSessionId, this.role === 'receive' ? [this.source.shareId] : []);
    this.connections.set(remoteSessionId, configuration);
    let peerId;
    try { peerId = await this.transport.connect(remoteSessionId, configuration); }
    catch (error) { this.peerReady(remoteSessionId).reject(error); throw error; }
    if (this.role === 'receive') {
      if (this.audio) {
        await this.broker.setAudioMuted(remoteSessionId, this.source.shareId, this.audioMuted);
        await this.broker.setAudioVolume(remoteSessionId, this.source.shareId, this.audioVolume);
      }
      await this.broker.watch(remoteSessionId, this.source.shareId, this.destination);
    }
    this.refreshCapture();
    return peerId;
  }

  async receiveControl(remoteSessionId, value) {
    assert.equal(this.mode, 'p2p');
    messageReferenceSchema.parse(remoteSessionId);
    const control = nativeScreenP2pControlSchema.parse(value);
    assert.equal(control.channelId, this.channelId);
    assert.equal(control.callId, this.source.instanceId);
    if (this.role === 'receive') assert.equal(remoteSessionId, this.publisherSessionId);
    const bytes = Buffer.byteLength(JSON.stringify(control));
    assert.ok(this.pendingControlCount < 128 && this.pendingControlBytes + bytes <= 4 * 1024 * 1024,
      'Native screen signaling exceeded its bounded admission queue.');
    this.pendingControlCount++;
    this.pendingControlBytes += bytes;
    try {
      await this.ready;
      this.abort.signal.throwIfAborted();
      // The other process can publish while this engine is still opening.
      // Waiting for preparation, not full negotiation, avoids both lost offers and a signaling deadlock.
      await within(this.peerReady(remoteSessionId).promise, 15000, 'The native screen peer did not finish preparation.');
      this.abort.signal.throwIfAborted();
      return await this.broker.receive(remoteSessionId, control);
    } finally {
      this.pendingControlCount--;
      this.pendingControlBytes -= bytes;
    }
  }

  peerReady(remoteSessionId) {
    let ready = this.peerReadiness.get(remoteSessionId);
    if (!ready) {
      assert.ok(this.peerReadiness.size < 64);
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      ready = { promise, resolve, reject };
      this.peerReadiness.set(remoteSessionId, ready);
    }
    return ready;
  }

  async closePeer(remoteSessionId) {
    assert.equal(this.mode, 'p2p');
    this.peerReadiness.get(remoteSessionId)?.reject(cancelled());
    this.peerReadiness.delete(remoteSessionId);
    this.connections.delete(remoteSessionId);
    this.refreshCapture();
    await this.transport.closePeer(remoteSessionId);
  }

  async stopWatching() {
    assert.equal(this.role, 'receive');
    await this.ready;
    const version = this.watchVersion;
    this.watchVersion = null;
    await this.broker.stopWatching(this.publisherSessionId, this.source.shareId, version);
    if (this.mode === 'sfu') this.routes.setWatching(this.publisherSessionId, this.source.shareId, null);
  }

  async addRemoteProducer(value) {
    assert.equal(this.mode, 'sfu');
    assert.equal(this.role, 'receive');
    await this.ready;
    this.abort.signal.throwIfAborted();
    const metadata = nativeScreenRenditionSchema.parse(value.appData?.nativeScreen);
    assert.equal(value.channelId, this.channelId);
    assert.equal(value.producerSessionId, this.publisherSessionId);
    assert.equal(value.appData.shareId, this.source.shareId);
    assert.equal(metadata.sourceInstanceId, this.source.instanceId);
    assert.equal(screenShareProfileKey(metadata.video), screenShareProfileKey(this.profile));
    if (value.kind === 'audio') assert.ok(this.audio && [...this.broker.remoteProducers.values()]
      .some(video => video.kind === 'video' && video.appData.nativeScreen?.pipelineId === metadata.pipelineId),
    'Native audio must belong to the exact watched video rendition.');
    this.broker.registerRemoteProducer(value, this.source.instanceId);
    const consumed = await this.broker.consume(value.producerId, this.watchVersion);
    this.abort.signal.throwIfAborted();
    if (value.kind === 'audio') {
      this.audioConsumerId = consumed.consumerId;
      await this.broker.setConsumerVolume(consumed.consumerId, this.audioVolume);
      await this.broker.setAudioMuted(consumed.consumerId, this.audioMuted);
    } else await this.broker.setConsumerEnabled(consumed.consumerId, true);
  }

  async setAudioPreferences({ muted, volume }) {
    assert.equal(this.role, 'receive');
    assert.equal(typeof muted, 'boolean');
    assert.ok(Number.isFinite(volume) && volume >= 0 && volume <= 2);
    this.audioMuted = muted; this.audioVolume = volume;
    if (!this.audio || this.closing) return;
    await this.ready;
    this.abort.signal.throwIfAborted();
    if (this.mode === 'p2p' && this.broker.getPeer(this.publisherSessionId)) {
      await this.broker.setAudioVolume(this.publisherSessionId, this.source.shareId, volume);
      await this.broker.setAudioMuted(this.publisherSessionId, this.source.shareId, muted);
    } else if (this.mode === 'sfu' && this.audioConsumerId) {
      await this.broker.setConsumerVolume(this.audioConsumerId, volume);
      await this.broker.setAudioMuted(this.audioConsumerId, muted);
    }
  }

  async removeRemoteProducer(producerId) {
    assert.equal(this.mode, 'sfu');
    await this.broker.removeRemoteProducer({ channelId: this.channelId, producerId });
    if (![...this.broker.activeConsumers.values()].some(record => record.nativeId === this.audioConsumerId))
      this.audioConsumerId = null;
  }

  async stats() {
    const capture = this.host?.ready && !this.host.stopping ? await this.host.getStats() : null;
    return { ...this.snapshot(), capture, rtc: this.engine.snapshot() };
  }

  diagnostics() {
    if (this.diagnosticsWork) return this.diagnosticsWork;
    const work = this.readDiagnostics();
    this.diagnosticsWork = work;
    const settled = () => { if (this.diagnosticsWork === work) this.diagnosticsWork = null; };
    void work.then(settled, settled);
    return work;
  }

  async readDiagnostics() {
    this.abort.signal.throwIfAborted();
    if (this.stopRequested || this.closing) throw cancelled();
    const requests = this.mode === 'p2p'
      ? [...this.connections.keys()].filter(remote => this.broker.getPeer(remote)?.status === 'open')
        .map(remote => this.broker.getStats(remote))
      : (this.role === 'publish' ? this.publication ? [this.publication.producerId] : []
        : [...this.broker.activeConsumers.values()].filter(record => record.ready && !record.closing
          && record.remote.kind === 'video').map(record => record.nativeId))
        .map(id => this.broker.getStats(id));
    const rtp = [];
    let readErrors = 0, decoders = [];
    const results = await Promise.allSettled(requests);
    this.abort.signal.throwIfAborted();
    if (this.stopRequested || this.closing) throw cancelled();
    const snapshot = this.role === 'receive' ? this.engine.snapshot() : null;
    if (snapshot?.state === 'closing' || snapshot?.state === 'closed') throw cancelled();
    for (const result of results) {
      try {
        if (result.status === 'rejected') throw result.reason;
        rtp.push({ id: result.value.id, reports: rtpReports(result.value.reports) });
      } catch (error) { readErrors++; this.onDiagnostic(error); }
    }
    this.abort.signal.throwIfAborted();
    if (this.role === 'receive') {
      try {
        // The actor publishes its first control snapshot after ready; no worker exists yet.
        if (snapshot?.mf === null && snapshot.failure === null && snapshot.activeReceiverRoutes === 0
          && !this.firstFrame && (snapshot.state === 'starting' || snapshot.state === 'ready')) readErrors++;
        else decoders = decoderObservations(snapshot?.mf);
      }
      catch (error) { readErrors++; this.onDiagnostic(error); }
    }
    return nativeScreenEndpointDiagnosticsSchema.parse({
      pipelineId: this.pipelineId, profile: this.profile, readErrors, rtp, decoders,
    });
  }

  snapshot() {
    return {
      role: this.role, mode: this.mode, pipelineId: this.pipelineId, profile: this.profile,
      captureState: this.captureState, captureMode: this.captureMode,
      demand: this.demand, previewDemand: this.previewDemand, closing: this.closing,
      nativeClosed: this.nativeClosed, closed: this.closed, capturePid: this.host?.child?.pid ?? null,
      flow: this.flow?.snapshot() ?? null, captureRetirement: this.host?.snapshot() ?? null,
      gameCaptureRetirement: this.gameCaptureRetirement ?? null,
      presentation: this.presentation?.getStats() ?? null, routes: this.routes?.snapshot() ?? null,
      audioInput: this.pcm?.getStats() ?? null, audioOutput: this.audioOutput?.owner.getStats() ?? null,
      errors: this.errors.map(error => ({ code: error.code ?? null, message: error.message })),
    };
  }

  close() {
    if (endpointOwners.get(this).fullyRetired) return Promise.resolve(this.snapshot());
    if (this.closeWork) return this.closeWork;
    this.stopRequested = true;
    this.presentation?.stopAccepting();
    this.pcm?.stopAccepting();
    this.refreshCapture();
    // Cancelling a native produce while its signaling callback is awaiting RPC
    // invalidates respond() and destroys its transport. Drain admitted demand
    // first; no new phase or media input can start after the stop request.
    const admitted = [...this.demandWork];
    if (this.pcm?.packetTail) admitted.push(this.pcm.packetTail);
    const work = this.mode === 'sfu' && admitted.length > 0
      ? within(Promise.allSettled(admitted), 15000,
        'Native SFU admission is still pending; endpoint ownership is retained.').then(() => this.beginClose())
      : this.beginClose();
    this.closeWork = work;
    void work.catch(() => { if (this.closeWork === work) this.closeWork = null; });
    return work;
  }

  beginClose() {
    this.closing = true;
    this.demand = 0;
    this.previewDemand = false;
    this.captureState = 'stopping';
    this.presentation?.stopAccepting();
    this.refreshCapture();
    this.abort.abort(cancelled());
    for (const ready of this.peerReadiness.values()) ready.reject(cancelled());
    this.pcm?.stopAccepting();
    this.pcm?.beginCaptureStop();
    return this.retire();
  }

  async retire() {
    const errors = [];
    const collect = async work => {
      try { await work; }
      catch (error) { if (error.name !== 'AbortError') errors.push(error); }
    };
    await Promise.all([
      collect(this.flow?.close()), collect(this.stopCaptureHost(this.host)),
      collect(this.transport ? within(this.transport.close(), 15000, 'Native screen transport retirement timed out.') : undefined),
      collect(this.audioOutput?.owner.stop()),
    ]);
    await collect(this.pcm?.stop());
    // Never invalidate a texture still owned by Chromium, even after a transport error.
    await this.presentation?.stop();
    const closing = this.commands.closeEngine();
    const audioClosed = this.audioOutput?.owner.finishAfterEngineClose(closing);
    if (audioClosed) void audioClosed.catch(() => {});
    await within(closing, 15000, 'Native screen engine retirement timed out.');
    assertNativeRtcEngineClosed(this.commands, this.engine);
    let transportRetired = !this.transport, operationsRetired = false;
    if (this.transport) await collect(this.transport.finishAfterEngineClose(closing).then(() => { transportRetired = true; }));
    await collect(this.pcm?.finishAfterEngineClose(closing));
    await collect(audioClosed);
    if (this.audioOutput) assertNativeAudioOutputStopped(this.audioOutput.owner, this.engine);
    await collect(within(Promise.allSettled([...this.pending]), 15000,
      'Native screen operations retained ownership after engine closure.').then(() => { operationsRetired = true; }));
    if (this.host) {
      await collect(this.stopCaptureHost(this.host));
      assert.equal(this.host.snapshot().nativeClosed, true, 'The native capture host did not prove retirement.');
    }
    assert.equal(this.flow?.inFlight.size ?? 0, 0, 'Encoded native copies survived engine closure.');
    if (this.presentation) assert.equal(this.presentation.getStats().outstandingLeases, 0);
    assert.equal(this.pcm?.getStats().outstanding ?? 0, 0);
    if (this.pcm?.capture) assert.equal(this.pcm.getStats().subscription.detached, true);
    this.nativeClosed = true;
    this.captureState = 'closed';
    if (operationsRetired) await collect(this.removeOwnedDirectory());
    const locallyRetired = operationsRetired && (!this.directoryCreated || this.directoryRemoved === true);
    endpointOwners.get(this).locallyRetired = locallyRetired;
    this.closed = transportRetired && locallyRetired;
    endpointOwners.get(this).fullyRetired = this.closed;
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Native screen retirement reported failures.');
    this.observe({ type: 'closed' });
    return this.snapshot();
  }

  async removeOwnedDirectory() {
    if (!this.directoryCreated || this.directoryRemoved) return;
    const directory = await fs.lstat(this.runDirectory);
    assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
    assert.equal((await fs.realpath(this.runDirectory)).toLowerCase(), path.resolve(this.runDirectory).toLowerCase());
    assert.equal(path.dirname(this.runDirectory), this.captureDirectory);
    assert.equal(path.basename(this.runDirectory), `monky-screen-capture-${this.runId}`);
    const entries = await fs.readdir(this.runDirectory);
    if (entries.length) {
      const marker = JSON.parse(await fs.readFile(path.join(this.runDirectory, '.monky-screen-capture-owner'), 'utf8'));
      assert.equal(marker.runId, this.runId);
      assert.equal(marker.parentProcessId, process.pid);
      assert.equal(marker.helperProcessId, this.host?.child?.pid);
    }
    await fs.rm(this.runDirectory, { recursive: true });
    this.directoryRemoved = true;
  }
}

function assertNativeScreenEndpointLocallyClosed(endpoint) {
  const owner = endpointOwners.get(endpoint);
  assert.ok(owner?.locallyRetired, 'The original native screen endpoint still retains local media ownership.');
  assertNativeRtcEngineClosed(owner.commands, owner.engine);
}

module.exports = { NativeScreenEndpoint, assertNativeScreenEndpointLocallyClosed };
