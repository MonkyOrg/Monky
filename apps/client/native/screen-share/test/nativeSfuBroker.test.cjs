'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MessageType, sfuCreateWebRtcTransportSchema, sfuCloseWebRtcTransportSchema, sfuConsumeSchema,
  sfuProducerSetPausedSchema, sfuConsumerSetPausedSchema, sfuProducerClosedSchema, sfuConsumerClosedSchema,
  sfuMediaAppDataSchema,
} = require('@monky/shared');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');
const { NativeSfuBroker } = require('../runtime/nativeSfuBroker.cjs');

const CHANNEL = 'channel-one';
const OWNER = 'publisher-local';
const SYNC = 'opaque-sync-group-not-a-share-id';
const localGroup = sourceId => `${SYNC}-${sourceId}`;
const remoteGroup = producerId => `opaque-remote-group-${producerId}`;
const ENCODING = Object.freeze({ maxBitrateBps: 12000000, maxFramerate: 120 });
const VIDEO_CAPS = Object.freeze({
  codecs: [{ kind: 'video', mimeType: 'video/H264', preferredPayloadType: 96, clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e034' }, rtcpFeedback: [{ type: 'nack' }] }],
  headerExtensions: [{ kind: 'video', uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', preferredId: 1 }],
});
const NATIVE_CAPS = Object.freeze({
  codecs: [...VIDEO_CAPS.codecs,
    { kind: 'audio', mimeType: 'audio/opus', preferredPayloadType: 111, clockRate: 48000, channels: 2 }],
  headerExtensions: [...VIDEO_CAPS.headerExtensions,
    { kind: 'audio', uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level', preferredId: 10 }],
});
const RTP = Object.freeze({
  codecs: [{ mimeType: 'video/H264', payloadType: 96, clockRate: 90000, parameters: { 'packetization-mode': 1 } }],
  encodings: [{ ssrc: 123456 }], headerExtensions: [], rtcp: { cname: 'test-screen' },
});
const DTLS = Object.freeze({ role: 'auto', fingerprints: [{ algorithm: 'sha-256', value: Array(32).fill('AB').join(':') }] });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('The deterministic double did not reach its expected checkpoint.');
}

function hasCode(error, suffix) {
  return error?.code === `ERR_NATIVE_SFU_${suffix}`
    || (error instanceof AggregateError && error.errors.some(child => hasCode(child, suffix)));
}

function diagnostics(error) {
  return [error?.message ?? '', ...(error instanceof AggregateError ? error.errors.flatMap(diagnostics) : [])];
}

function fixture(overrides = {}) {
  let nextNative = 10, nextCallback = 1, nextTransport = 1, nextProducer = 1, nextConsumer = 1;
  let controllerClosePromise = null;
  const engineCloseCalls = [];
  const native = new Map(), server = new Map(), callbacks = new Map(), remotes = new Map(), watched = new Map();
  const nativeCalls = [], rpcCalls = [], events = [], responses = [], cancellations = [], errors = [], routeCalls = [];
  const implicitTransportCloses = [];
  const nativeHooks = new Map(), rpcHooks = new Map(), routed = new Map();
  const scope = { current: true };
  const externalSources = new Map();
  let broker;
  const key = (publisher, share) => JSON.stringify([publisher, share]);
  const allocateNative = (kind, parent, fields = {}) => {
    const id = nextNative++;
    native.set(id, { id, kind, parent, ...fields });
    return id;
  };
  const retireNative = id => {
    for (const record of [...native.values()]) if (record.parent === id) retireNative(record.id);
    native.delete(id);
  };
  const callback = async (command, method, target, payload) => {
    const callbackId = nextCallback++;
    const ticket = deferred();
    callbacks.set(callbackId, ticket);
    const event = { type: 'request', target, data: { callbackId, requestId: command.id, method, payload: structuredClone(payload) } };
    events.push(event);
    void broker.handleNativeEvent(event);
    return await ticket.promise;
  };
  const connect = async (command, transport) => {
    if (transport.connected) return;
    await callback(command, 'connectTransport', transport.id,
      { transportId: transport.serverId, dtlsParameters: structuredClone(DTLS), purpose: 'screen' });
    transport.connected = true;
  };
  const defaultNative = async command => {
    const { operation, target, data } = command;
    if (operation === 'sfu.load') {
      return { deviceId: allocateNative('device', null), rtpCapabilities: structuredClone(NATIVE_CAPS),
        canProduceVideo: true, canProduceAudio: true };
    }
    if (operation === 'sfu.createTransport') {
      const id = allocateNative('transport', target, { direction: data.direction, serverId: data.id, connected: false, mids: new Set() });
      return { transportId: id, serverTransportId: data.id, direction: data.direction, purpose: 'screen' };
    }
    if (operation === 'sfu.produce') {
      const transport = native.get(target);
      const source = externalSources.get(data.sourceId);
      assert.equal(source?.kind, 'video');
      assert.equal(source.syncGroup, data.appData.syncGroup);
      assert.equal(data.enabled, false);
      let produced;
      try {
        await connect(command, transport);
        produced = await callback(command, 'produce', target, { transportId: transport.serverId, kind: 'video',
          rtpParameters: structuredClone(RTP), appData: data.appData, purpose: 'screen' });
        const producerId = allocateNative('producer', target, { sourceId: data.sourceId, serverId: produced.id,
          requestedEnabled: false, effectiveEnabled: false });
        await callback(command, 'setProducerEnabled', producerId, {
          transportId: transport.serverId, producerId: produced.id, enabled: false, purpose: 'screen',
        });
        return { producerId, serverProducerId: produced.id, kind: source.kind, syncGroup: source.syncGroup };
      } catch (error) {
        retireNative(target);
        if (produced) {
          try {
            await callback(command, 'setProducerEnabled', target, {
              transportId: transport.serverId, producerId: produced.id, enabled: false, purpose: 'screen',
            });
          } catch { /* Native teardown does not acknowledge the independent server obligation. */ }
        }
        throw error;
      }
    }
    if (operation === 'sfu.consume') {
      const transport = native.get(target);
      assert.equal(data.kind, 'video');
      assert.equal(data.enabled, false);
      const consumerId = allocateNative('consumer', target, { serverId: data.id, enabled: false });
      const mid = data.rtpParameters.mid ?? String(consumerId);
      assert.match(mid, /^[\x21-\x7e]{1,64}$/u);
      assert.equal(transport.mids.has(mid), false);
      transport.mids.add(mid);
      try {
        await callback(command, 'setConsumerEnabled', consumerId, {
          transportId: transport.serverId, consumerId: data.id, enabled: false, purpose: 'screen',
        });
        await connect(command, transport);
        return { consumerId, serverConsumerId: data.id, kind: 'video', syncGroup: data.appData.syncGroup,
          mid, trackId: data.id };
      } catch (error) {
        retireNative(consumerId);
        throw error;
      }
    }
    if (operation === 'sfu.setProducerEnabled' || operation === 'sfu.setConsumerEnabled') {
      const resource = native.get(target), transport = native.get(resource.parent);
      const producer = operation === 'sfu.setProducerEnabled';
      const enabled = producer ? data.enabled && externalSources.get(resource.sourceId).enabled : data.enabled;
      try {
        await callback(command, producer ? 'setProducerEnabled' : 'setConsumerEnabled', target, {
          transportId: transport.serverId, [producer ? 'producerId' : 'consumerId']: resource.serverId,
          enabled, purpose: 'screen',
        });
        if (producer) {
          resource.requestedEnabled = data.enabled;
          resource.effectiveEnabled = enabled;
        } else resource.enabled = enabled;
        return { enabled };
      } catch (error) {
        if (producer) retireNative(resource.parent);
        throw error;
      }
    }
    if (operation === 'source.setEnabled') {
      const source = externalSources.get(target);
      assert.ok(source);
      for (const producer of [...native.values()].filter(record => record.kind === 'producer' && record.sourceId === target)) {
        const transport = native.get(producer.parent);
        try {
          await callback(command, 'setProducerEnabled', producer.id, {
            transportId: transport.serverId, producerId: producer.serverId,
            enabled: data.enabled && producer.requestedEnabled, purpose: 'screen',
          });
          producer.effectiveEnabled = data.enabled && producer.requestedEnabled;
        } catch (error) { retireNative(producer.parent); throw error; }
      }
      source.enabled = data.enabled;
      return { enabled: data.enabled };
    }
    if (operation === 'resource.close') {
      if (externalSources.has(target)) {
        if ([...native.values()].some(record => record.sourceId === target)) throw new Error('SOURCE_IN_USE');
        externalSources.delete(target);
        return {};
      }
      if (!native.has(target)) throw Object.assign(new Error('Only a genuinely owned native handle can close.'), {
        code: 'ERR_RTC_NOT_FOUND',
      });
      retireNative(target);
      return {};
    }
    throw new Error('Unexpected fake native command.');
  };
  const engine = {
    request(id, operation, target, data) {
      const command = { id, operation, target, data: structuredClone(data) };
      nativeCalls.push(command);
      const next = () => defaultNative(command);
      return nativeHooks.has(operation) ? nativeHooks.get(operation)(command, next) : next();
    },
    respond(callbackId, response) {
      responses.push({ callbackId, response: structuredClone(response) });
      const ticket = callbacks.get(callbackId);
      if (!ticket) return;
      callbacks.delete(callbackId);
      if (response.ok) ticket.resolve(response.data);
      else {
        const error = new Error(response.error.message);
        error.code = response.error.code;
        ticket.reject(error);
      }
    },
    cancel(id) {
      cancellations.push(id);
      // Simulate completion winning the cancel race. The broker must still
      // claim and retire every late success rather than trusting dispatch.
    },
    close() {
      assert.ok(controllerClosePromise, 'Only the controller may start the global engine close.');
      engineCloseCalls.push('close');
      return controllerClosePromise;
    },
    createEngine() { assert.fail('The broker must never create a native engine.'); },
  };
  const commands = new NativeRtcCommands(engine);
  const schemaByType = new Map([
    [MessageType.SFU_CREATE_WEBRTC_TRANSPORT, sfuCreateWebRtcTransportSchema],
    [MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, sfuCloseWebRtcTransportSchema],
    [MessageType.SFU_CONSUME, sfuConsumeSchema],
    [MessageType.SFU_PRODUCER_SET_PAUSED, sfuProducerSetPausedSchema],
    [MessageType.SFU_CONSUMER_SET_PAUSED, sfuConsumerSetPausedSchema],
    [MessageType.SFU_PRODUCER_CLOSED, sfuProducerClosedSchema],
    [MessageType.SFU_CONSUMER_CLOSED, sfuConsumerClosedSchema],
  ]);
  const defaultRpc = async ({ type, payload }) => {
    assert.equal(payload.channelId, CHANNEL, 'every RPC remains bound to the captured call channel');
    const schema = schemaByType.get(type);
    if (schema) assert.equal(schema.safeParse(payload).success, true, 'outgoing DTO must pass the real strict server schema');
    if (type === MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES) {
      return { channelId: CHANNEL, rtpCapabilities: structuredClone(NATIVE_CAPS) };
    }
    if (type === MessageType.SFU_CREATE_WEBRTC_TRANSPORT) {
      // WebSocketServer closes the existing purpose/direction on CREATE,
      // independently of the new allocation. A broker must first get proof
      // that the old exact resource retired, not mistake replacement for proof.
      for (const previous of [...server.values()]) {
        if (previous.kind !== 'transport' || previous.direction !== payload.direction || previous.purpose !== payload.purpose
          || previous.screenSessionId !== payload.screenSessionId) continue;
        implicitTransportCloses.push(previous.id);
        server.delete(previous.id);
        for (const child of [...server.values()]) if (child.parent === previous.id) server.delete(child.id);
      }
      const id = `${payload.direction}-${nextTransport++}`;
      server.set(id, { id, kind: 'transport', purpose: 'screen', direction: payload.direction, screenSessionId: payload.screenSessionId });
      return { channelId: CHANNEL, direction: payload.direction, purpose: 'screen',
        ...(payload.screenSessionId ? { screenSessionId: payload.screenSessionId } : {}), transportOptions: {
        id, iceParameters: { usernameFragment: 'inert-test', password: 'inert-test-only', iceLite: true },
        iceCandidates: [{ foundation: 'fixture', protocol: 'udp', priority: 100, port: 50000,
          ip: '192.0.2.1', address: '192.0.2.1', type: 'host' }],
        dtlsParameters: structuredClone(DTLS),
        sctpParameters: { port: 5000, OS: 1024, MIS: 1024, maxMessageSize: 262144 },
      } };
    }
    if (type === MessageType.SFU_CONNECT_WEBRTC_TRANSPORT) {
      assert.equal(server.get(payload.transportId)?.kind, 'transport');
      return { channelId: CHANNEL, transportId: payload.transportId };
    }
    if (type === MessageType.SFU_PRODUCE) {
      assert.equal(sfuMediaAppDataSchema.safeParse(payload.appData).success, true);
      assert.equal(payload.kind, 'video');
      assert.equal(server.get(payload.transportId)?.direction, 'send');
      const id = `producer-${nextProducer++}`;
      server.set(id, { id, kind: 'producer', parent: payload.transportId, paused: false, appData: payload.appData });
      return { channelId: CHANNEL, id };
    }
    if (type === MessageType.SFU_CONSUME) {
      const remote = remotes.get(payload.producerId);
      assert.ok(remote);
      assert.equal(server.get(payload.transportId)?.direction, 'recv');
      const id = `consumer-${nextConsumer++}`;
      server.set(id, { id, kind: 'consumer', parent: payload.transportId, paused: true });
      return { channelId: CHANNEL, id, producerId: remote.producerId, producerSessionId: remote.producerSessionId,
        kind: remote.kind, appData: structuredClone(remote.appData), rtpParameters: structuredClone(RTP) };
    }
    if (type === MessageType.SFU_PRODUCER_SET_PAUSED || type === MessageType.SFU_CONSUMER_SET_PAUSED) {
      const resource = server.get(payload.producerId ?? payload.consumerId);
      assert.ok(resource);
      resource.paused = payload.paused;
      return structuredClone(payload);
    }
    if ([MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, MessageType.SFU_PRODUCER_CLOSED, MessageType.SFU_CONSUMER_CLOSED].includes(type)) {
      const id = payload.transportId ?? payload.producerId ?? payload.consumerId;
      const resource = server.get(id);
      assert.ok(resource, 'only an existing exact server resource can close');
      if (resource.kind === 'transport') assert.equal(resource.purpose, payload.purpose);
      server.delete(id);
      for (const child of [...server.values()]) if (child.parent === id) server.delete(child.id);
      return structuredClone(payload);
    }
    throw new Error('Unexpected fake server request.');
  };
  const rpc = (type, payload) => {
    const call = { type, payload: structuredClone(payload) };
    rpcCalls.push(call);
    const next = () => defaultRpc(call);
    return rpcHooks.has(type) ? rpcHooks.get(type)(call, next) : next();
  };
  const routes = {
    registerConsumer(id, publisherSessionId, shareId, watchVersion) {
      routeCalls.push({ operation: 'register', id, publisherSessionId, shareId, watchVersion });
      assert.equal(watched.get(key(publisherSessionId, shareId)), watchVersion);
      assert.equal(routed.has(id), false);
      routed.set(id, { publisherSessionId, shareId, watchVersion });
    },
    removeConsumer(id) {
      routeCalls.push({ operation: 'remove', id });
      routed.delete(id);
    },
  };
  const options = { engine, commands, rpc, channelId: CHANNEL, publisherSessionId: OWNER,
    isCurrent: () => scope.current, isWatchCurrent: (publisher, share, version) => watched.get(key(publisher, share)) === version,
    routes, onError: error => errors.push(error), ...overrides };
  broker = new NativeSfuBroker(options);
  return {
    broker, engine, commands, rpc, options, scope, routes, native, server, routed, remotes,
    nativeCalls, rpcCalls, events, responses, cancellations, errors, routeCalls, nativeHooks, rpcHooks, implicitTransportCloses,
    engineCloseCalls,
    closeEngineFromController(promise) {
      controllerClosePromise = promise;
      return commands.closeEngine();
    },
    async finishNativeClose() {
      controllerClosePromise = Promise.resolve().then(() => { native.clear(); return { closed: true }; });
      await broker.finishAfterEngineClose(commands.closeEngine());
    },
    callback, defaultNative, defaultRpc,
    register(sourceId = 1000, shareId = 'local-one', syncGroup = localGroup(sourceId), nativeScreen) {
      broker.registerSource({ sourceId, shareId, syncGroup, ...(nativeScreen ? { nativeScreen } : {}) });
      externalSources.set(sourceId, { kind: 'video', syncGroup, enabled: false });
    },
    remote(producerId = 'remote-video-one', publisherSessionId = 'publisher-remote', shareId = 'remote-one') {
      const metadata = { channelId: CHANNEL, producerId, producerSessionId: publisherSessionId,
        kind: 'video', appData: { mediaType: 'screen_video', shareId } };
      remotes.set(producerId, metadata);
      broker.registerRemoteProducer(metadata, remoteGroup(producerId));
      return metadata;
    },
    watch(publisher = 'publisher-remote', share = 'remote-one', version = 1) {
      if (version === null) watched.delete(key(publisher, share));
      else watched.set(key(publisher, share), version);
    },
    calls(type) { return rpcCalls.filter(call => call.type === type); },
    nativeFor(operation) { return nativeCalls.filter(call => call.operation === operation); },
  };
}

async function publication(f, sourceId = 1000, shareId = 'local-one') {
  f.register(sourceId, shareId);
  return await f.broker.publish(sourceId, ENCODING);
}

test('native SFU rendition registration carries its own transport identity and exact media settings', async () => {
  const pipelineId = 'dc901be6-7a05-408d-8d20-b58bcecb7b0c';
  const sourceInstanceId = 'fe3ea29d-91c6-43cf-b6dc-9f945d244dc9';
  const f = fixture({ screenSessionId: pipelineId });
  const nativeScreen = { pipelineId, sourceInstanceId,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 12000 } };
  f.register(1000, 'local-one', sourceInstanceId, nativeScreen);
  await assert.rejects(f.broker.publish(1000, { ...ENCODING, maxFramerate: 60 }), error => hasCode(error, 'SOURCE'));
  await f.broker.publish(1000, ENCODING);
  assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT)[0].payload.screenSessionId, pipelineId);
  assert.deepEqual(f.calls(MessageType.SFU_PRODUCE)[0].payload.appData.nativeScreen, nativeScreen);
  assert.throws(() => f.register(1001, 'local-two', SYNC, { ...nativeScreen, pipelineId: sourceInstanceId }),
    error => hasCode(error, 'SOURCE'));
  await f.broker.close();
  assert.equal(f.server.size, 0);
});

test('a replaced SFU screen-engine identity in CREATE is rejected and the exact late allocation is retired', async () => {
  const f = fixture({ screenSessionId: '388d211e-92b2-4334-aeeb-69a86e93dfbb' });
  f.rpcHooks.set(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, async (_call, next) => ({
    ...await next(), screenSessionId: '634e057a-9e45-4f99-9c3e-6cae51d388e0',
  }));
  await assert.rejects(f.broker.createTransport('send'), error => hasCode(error, 'RESPONSE'));
  assert.equal(f.server.size, 0);
  await f.broker.close();
});

async function consumption(f, producerId = 'remote-video-one', publisher = 'publisher-remote', share = 'remote-one', version = 1) {
  f.remote(producerId, publisher, share);
  f.watch(publisher, share, version);
  return await f.broker.consume(producerId, version);
}

function strictNativeFifo(f) {
  const rawRequest = f.engine.request.bind(f.engine);
  const queue = [], started = [], completed = [];
  let running = false;
  const pump = () => {
    if (running || queue.length === 0) return;
    running = true;
    const entry = queue.shift();
    started.push(entry.id);
    const finish = (ok, value) => {
      completed.push(entry.id);
      running = false;
      // Native may begin the next actor command as soon as its raw work ends,
      // before command-wrapper/adapter Promise continuations commit JS state.
      pump();
      if (ok) entry.resolve(value);
      else entry.reject(value);
    };
    let raw;
    try { raw = rawRequest(entry.id, entry.operation, entry.target, entry.data); }
    catch (error) { finish(false, error); return; }
    Promise.resolve(raw).then(value => finish(true, value), error => finish(false, error));
  };
  f.engine.request = (id, operation, target, data) => new Promise((resolve, reject) => {
    queue.push({ id, operation, target, data, resolve, reject });
    pump();
  });
  return { started, completed };
}

function failedNativeCreation(f, kind) {
  const entered = deferred(), proceed = deferred();
  const operation = kind === 'producer' ? 'sfu.produce' : 'sfu.consume';
  f.nativeHooks.set(operation, async command => {
    const transport = f.native.get(command.target);
    let serverId = command.data.id;
    if (kind === 'producer') {
      const produced = await f.callback(command, 'produce', command.target, {
        transportId: transport.serverId, kind: 'video', rtpParameters: structuredClone(RTP),
        appData: command.data.appData, purpose: 'screen',
      });
      serverId = produced.id;
    }
    const payload = { transportId: transport.serverId, [kind === 'producer' ? 'producerId' : 'consumerId']: serverId,
      enabled: false, purpose: 'screen' };
    entered.resolve({ command, payload, serverId });
    await proceed.promise;
    await f.callback(command, kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled', command.target, payload);
    throw new Error('SDK failed-create cleanup double');
  });
  return { entered: entered.promise, proceed };
}

function assertEmpty(f) {
  assert.deepEqual(f.broker.snapshot().resources, []);
  assert.equal(f.broker.snapshot().pendingCallbacks, 0);
  assert.equal(f.broker.snapshot().pendingOperations, 0);
  assert.equal(f.broker.snapshot().pendingRpc, 0);
  assert.equal(f.broker.nativeRetirementWaiters.size, 0);
  assert.equal(f.broker.tentativeNativeOwners.size, 0);
  assert.equal(f.native.size, 0);
  assert.equal(f.server.size, 0);
  assert.deepEqual(f.implicitTransportCloses, []);
}

test('SFU A/V permission cannot be inferred from RTP capability booleans or adapter-shaped readiness', async () => {
  const f = fixture();
  assert.equal(f.broker.audioPublicationEnabled, false);
  assert.throws(() => { f.broker.audioPublicationEnabled = true; }, TypeError);
  assert.throws(() => new NativeSfuBroker({ ...f.options, audio: {
    async prepareSfuReceive() { return {}; }, assertSfuReceiveReady() {}, expectedSfuOutputEpoch() { return 99; },
    bindSfuConsumer() { return true; }, revokeSfuReceive() { return true; },
  } }), /genuine same-engine receive adapter/u);
  f.register();
  assert.throws(() => f.broker.registerAudioSource({ sourceId: 2000, screenAudioShareId: 'local-one',
    syncGroup: localGroup(1000) }), /continuous PCM source/u);
  await assert.rejects(f.broker.publishAudio(1000, { maxBitrateBps: 128000 }), /registered PCM source/u);
  assert.equal(f.rpcCalls.length, 0);
  assert.equal(f.nativeCalls.length, 0);
  await f.broker.close();
});

test('construction is inert, call identity is captured, and configuration/source bounds are explicit', async () => {
  const f = fixture();
  assert.equal(f.rpcCalls.length, 0);
  assert.equal(f.nativeCalls.length, 0);
  f.options.channelId = 'foreground-other';
  f.options.publisherSessionId = 'other-local';
  assert.throws(() => { f.broker.scope.channelId = 'other'; }, TypeError);
  assert.throws(() => { f.broker.scope = {}; }, TypeError);
  assert.throws(() => new NativeSfuBroker({ ...f.options, channelId: CHANNEL, maximumResources: 65 }), /limits/u);
  for (const id of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.broker.registerSource({ sourceId: id, shareId: 'one', syncGroup: SYNC }), /registration/u);
  }
  for (const [kind, mediaType] of [['audio', 'screen_audio'], ['audio', 'mic'], ['video', 'camera']]) {
    assert.throws(() => f.broker.registerSource({ sourceId: 1000, shareId: 'one', syncGroup: SYNC, kind, mediaType }), /screen video only/u);
  }
  f.register();
  assert.throws(() => f.register(), /duplicated/u);
  assert.throws(() => f.register(1001, 'local-one'), /duplicated/u);
  f.register(1001, 'local-two');
  assert.throws(() => f.register(1002, 'local-three'), /at most two/u);
  await f.broker.load();
  assert.equal(f.calls(MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES)[0].payload.channelId, CHANNEL);
  assert.equal(f.broker.snapshot().publisherSessionId, OWNER);
  await f.broker.close();
  assertEmpty(f);
});

test('load preserves native audio capability while broker policy remains video-only and unqualified', async () => {
  const f = fixture();
  const first = f.broker.createTransport('send'), second = f.broker.createTransport('send');
  assert.equal(first, second);
  const transport = await first;
  const loaded = await f.broker.load();
  assert.equal(loaded.canProduceAudio, true);
  assert.equal(Object.hasOwn(loaded, 'audioAvailable'), false);
  assert.deepEqual(loaded.rtpCapabilities, NATIVE_CAPS);
  assert.deepEqual(loaded.brokerSupportedMediaTypes, ['screen_video']);
  assert.equal(loaded.availabilityScope, 'compiled-implementation-not-device-probe');
  assert.equal(Object.hasOwn(loaded, 'runtimeQualified'), false);
  assert.equal(f.nativeFor('sfu.load').length, 1);
  assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 1);
  const command = f.nativeFor('sfu.createTransport')[0];
  assert.equal(command.data.purpose, 'screen');
  assert.equal(Object.hasOwn(command.data, 'sctpParameters'), false);
  assert.equal(command.data.id, transport.serverTransportId);
  loaded.rtpCapabilities.codecs[0].kind = 'audio';
  assert.equal((await f.broker.load()).rtpCapabilities.codecs[0].kind, 'video');
  await assert.rejects(f.broker.createTransport('call'), error => hasCode(error, 'TRANSPORT'));
  await f.broker.close();
  assertEmpty(f);
});

test('two opaque source groups map to their authenticated shareIds rather than being used as share identities', async () => {
  const f = fixture();
  f.register(1000, 'local-one');
  f.register(1001, 'local-two');
  const one = f.broker.publish(1000, ENCODING);
  assert.equal(one, f.broker.publish(1000, ENCODING));
  const [first, second] = await Promise.all([one, f.broker.publish(1001, ENCODING)]);
  assert.notEqual(first.producerId, second.producerId);
  assert.deepEqual(f.calls(MessageType.SFU_PRODUCE).map(call => call.payload.appData), [
    { mediaType: 'screen_video', shareId: 'local-one' }, { mediaType: 'screen_video', shareId: 'local-two' },
  ]);
  for (const command of f.nativeFor('sfu.produce')) {
    assert.equal(command.data.enabled, false);
    assert.deepEqual(command.data.appData, { mediaType: 'screen_video', syncGroup: localGroup(command.data.sourceId) });
  }
  assert.equal(f.server.get(first.serverProducerId).paused, true);
  assert.equal(f.server.get(second.serverProducerId).paused, true);
  await assert.rejects(f.broker.publish(1000, { ...ENCODING, maxFramerate: 60 }), error => hasCode(error, 'SOURCE'));
  await f.broker.close();
  assertEmpty(f);
});

test('the real command registry reserves correlation before synchronous native dispatch', async () => {
  const f = fixture();
  let synchronous = false;
  f.nativeHooks.set('sfu.produce', (command, next) => {
    const pending = f.commands.getPendingRequest(command.id);
    assert.deepEqual(pending, command);
    pending.data.sourceId = 9999;
    assert.equal(f.commands.getPendingRequest(command.id).data.sourceId, 1000);
    synchronous = true;
    return next();
  });
  await publication(f);
  assert.equal(synchronous, true);
  await f.broker.close();
  assertEmpty(f);
});

test('wrong request, command, target, transport, source, purpose and media callbacks cause no RPC', async () => {
  const f = fixture();
  f.register();
  const transport = await f.broker.createTransport('send');
  const receive = await f.broker.createTransport('recv');
  const held = deferred();
  let original;
  f.nativeHooks.set('sfu.produce', command => { original = command; return held.promise; });
  const publishing = f.broker.publish(1000, ENCODING);
  await until(() => original);
  const getPending = f.commands.getPendingRequest.bind(f.commands);
  const base = () => ({ type: 'request', target: transport.transportId, data: {
    callbackId: 10000, requestId: original.id, method: 'produce', payload: {
      transportId: transport.serverTransportId, kind: 'video', rtpParameters: structuredClone(RTP),
      appData: { mediaType: 'screen_video', syncGroup: localGroup(1000) }, purpose: 'screen',
    },
  } });
  const changes = [
    event => { event.data.requestId = 9999; },
    event => { event.data.requestId = f.nativeFor('sfu.load')[0].id; },
    event => { event.target = receive.transportId; },
    event => { event.target = 9000; },
    event => { event.data.payload.transportId = receive.serverTransportId; },
    event => { event.data.payload.transportId = 'unowned-call-transport'; },
    event => { event.data.payload.purpose = 'call'; },
    event => { event.data.payload.kind = 'audio'; },
    event => { event.data.payload.appData.mediaType = 'mic'; },
    event => { event.data.payload.appData.mediaType = 'camera'; },
    event => { event.data.payload.appData.syncGroup = 'forged-share-identity'; },
    event => { event.data.payload.appData.shareId = 'renderer-injected'; },
    event => { event.data.method = 'unknownMethod'; },
    () => { f.commands.getPendingRequest = id => { const value = getPending(id); if (value) value.data.sourceId = 1001; return value; }; },
    () => { f.commands.getPendingRequest = id => { const value = getPending(id); if (value) value.target = receive.transportId; return value; }; },
    () => { f.commands.getPendingRequest = id => { const value = getPending(id); if (value) value.operation = 'peer.publish'; return value; }; },
  ];
  for (const [index, change] of changes.entries()) {
    f.commands.getPendingRequest = getPending;
    const event = base();
    event.data.callbackId += index;
    change(event);
    const before = f.rpcCalls.length;
    assert.equal(await f.broker.handleNativeEvent(event), false);
    assert.equal(f.rpcCalls.length, before);
    assert.equal(f.responses.at(-1).response.ok, false);
  }
  f.commands.getPendingRequest = getPending;
  held.reject(new Error('fake native rejected'));
  await assert.rejects(publishing, error => hasCode(error, 'NATIVE'));
  await f.broker.close();
  assertEmpty(f);
});

test('duplicate active native callback is coalesced and cannot allocate another server producer', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.rpcHooks.set(MessageType.SFU_PRODUCE, async (call, next) => {
    allocated = await next();
    return await held.promise;
  });
  const producing = publication(f);
  await until(() => allocated);
  const event = f.events.find(value => value.data.method === 'produce');
  const first = f.broker.handleNativeEvent(event), second = f.broker.handleNativeEvent(structuredClone(event));
  assert.equal(first, second);
  assert.equal(f.calls(MessageType.SFU_PRODUCE).length, 1);
  const replay = structuredClone(event);
  replay.data.callbackId = 9999;
  assert.equal(await f.broker.handleNativeEvent(replay), false);
  assert.equal(f.calls(MessageType.SFU_PRODUCE).length, 1);
  held.resolve(allocated);
  await producing;
  assert.equal(f.responses.filter(value => value.callbackId === event.data.callbackId).length, 1);
  await f.broker.close();
  assertEmpty(f);
});

test('producer enabled is inverted to paused and native completion waits for the exact ACK', async () => {
  const f = fixture();
  const producer = await publication(f);
  await f.commands.request('source.setEnabled', 1000, { enabled: true });
  const initialPauses = f.calls(MessageType.SFU_PRODUCER_SET_PAUSED).length;
  const held = deferred();
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
    await held.promise;
    return await next();
  });
  let done = false;
  const enabling = f.broker.setProducerEnabled(producer.producerId, true).then(value => { done = true; return value; });
  await until(() => f.calls(MessageType.SFU_PRODUCER_SET_PAUSED).length === initialPauses + 1);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_SET_PAUSED).at(-1).payload.paused, false);
  assert.equal(done, false);
  assert.equal(f.server.get(producer.serverProducerId).paused, true);
  held.resolve();
  assert.equal(await enabling, true);
  assert.equal(f.server.get(producer.serverProducerId).paused, false);
  f.rpcHooks.clear();
  assert.equal(await f.broker.setProducerEnabled(producer.producerId, false), false);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_SET_PAUSED).at(-1).payload.paused, true);
  await f.broker.close();
  assertEmpty(f);
});

test('mismatched or failed pause ACK fails closed and does not disclose native/RPC payload errors', async () => {
  for (const mode of ['mismatch', 'failure']) {
    const f = fixture(), producer = await publication(f);
    f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
      if (mode === 'failure') throw new Error('private-sdp-password-value');
      return { ...await next(), paused: !call.payload.paused };
    });
    await assert.rejects(f.broker.setProducerEnabled(producer.producerId, true),
      error => hasCode(error, 'NATIVE') || hasCode(error, 'ACK'));
    assert.equal(f.server.has(producer.serverProducerId), false);
    assert.equal(f.native.has(producer.producerId), false);
    assert.equal(f.errors.flatMap(diagnostics).join(' ').includes('private-sdp-password-value'), false);
    f.rpcHooks.clear();
    await f.finishNativeClose();
    assertEmpty(f);
  }
});

test('source.setEnabled callbacks are limited to publications of the active original source command', async () => {
  const f = fixture();
  const one = await publication(f, 1000, 'local-one'), two = await publication(f, 1001, 'local-two');
  await f.broker.setProducerEnabled(one.producerId, true);
  await f.broker.setProducerEnabled(two.producerId, true);
  await f.commands.request('source.setEnabled', 1000, { enabled: true });
  await f.commands.request('source.setEnabled', 1001, { enabled: true });
  await f.commands.request('source.setEnabled', 1000, { enabled: false });
  assert.equal(f.server.get(one.serverProducerId).paused, true);
  assert.equal(f.server.get(two.serverProducerId).paused, false);
  const held = deferred();
  let command;
  f.nativeHooks.set('source.setEnabled', value => { command = value; return held.promise; });
  const control = f.commands.request('source.setEnabled', 1000, { enabled: true });
  const send = f.nativeFor('sfu.createTransport')[0];
  const bad = { type: 'request', target: two.producerId, data: { callbackId: 20000, requestId: command.id,
    method: 'setProducerEnabled', payload: { transportId: send.data.id, producerId: two.serverProducerId,
      enabled: true, purpose: 'screen' } } };
  const before = f.rpcCalls.length;
  assert.equal(await f.broker.handleNativeEvent(bad), false);
  assert.equal(f.rpcCalls.length, before);
  held.resolve({ enabled: true });
  await control;
  f.nativeHooks.clear();
  await f.commands.request('source.setEnabled', 1000, { enabled: true });
  assert.equal(f.server.get(one.serverProducerId).paused, false);
  await f.broker.removeSource(1000);
  assert.equal(f.server.has(two.serverProducerId), true);
  assert.equal(f.native.has(two.producerId), true);
  assert.equal(f.nativeFor('resource.close').some(value => value.target === 1000 || value.target === 1001), false);
  await f.broker.close();
  assertEmpty(f);
});

test('roster metadata is mandatory and neither consumers nor native/RPC media exist before Watch', async () => {
  const f = fixture();
  const remote = f.remote();
  await assert.rejects(f.broker.consume(remote.producerId, 1), error => hasCode(error, 'STALE'));
  assert.equal(f.rpcCalls.length, 0);
  assert.equal(f.nativeCalls.length, 0);
  for (const changes of [
    { channelId: 'other-channel' }, { producerSessionId: OWNER }, { producerId: '' },
    { appData: { mediaType: 'screen_video', shareId: 'invalid/share' } },
  ]) assert.throws(() => f.broker.registerRemoteProducer({ ...remote, ...changes }, SYNC), /authenticated/u);
  for (const [kind, mediaType] of [['audio', 'screen_audio'], ['audio', 'mic'], ['video', 'camera']]) {
    assert.throws(() => f.broker.registerRemoteProducer({ ...remote, producerId: 'other', kind,
      appData: { mediaType, shareId: 'remote-one' } }, SYNC), /screen video only/u);
  }
  f.watch();
  await assert.rejects(f.broker.consume('renderer-invented-producer', 1), error => hasCode(error, 'ROSTER'));
  assert.equal(f.rpcCalls.length, 0);
  await f.broker.close();
  assertEmpty(f);
});

test('consumer creation is disabled, routes are registered before enable, and resume waits for ACK', async () => {
  const f = fixture();
  const consumer = await consumption(f);
  assert.equal(consumer.enabled, false);
  assert.equal(f.server.get(consumer.serverConsumerId).paused, true);
  assert.equal(f.routed.has(consumer.consumerId), true);
  const nativeConsume = f.nativeFor('sfu.consume')[0];
  assert.equal(nativeConsume.data.enabled, false);
  assert.deepEqual(nativeConsume.data.appData, { mediaType: 'screen_video', syncGroup: remoteGroup('remote-video-one') });
  assert.deepEqual(f.calls(MessageType.SFU_CONSUME)[0].payload.rtpCapabilities, NATIVE_CAPS);
  assert.equal(nativeConsume.data.kind, 'video');
  f.nativeHooks.set('sfu.setConsumerEnabled', (command, next) => {
    assert.equal(f.routed.has(command.target), true);
    return next();
  });
  const held = deferred();
  let completed = false;
  f.rpcHooks.set(MessageType.SFU_CONSUMER_SET_PAUSED, async (call, next) => { await held.promise; return await next(); });
  const enabling = f.broker.setConsumerEnabled(consumer.consumerId, true).then(value => { completed = true; return value; });
  await until(() => f.calls(MessageType.SFU_CONSUMER_SET_PAUSED).length === 2);
  assert.equal(completed, false);
  assert.equal(f.calls(MessageType.SFU_CONSUMER_SET_PAUSED).at(-1).payload.paused, false);
  held.resolve();
  assert.equal(await enabling, true);
  f.rpcHooks.clear();
  await f.broker.close();
  assertEmpty(f);
});

test('Stop one watched screen removes only its route and exact consumer, never another screen or the recv pair', async () => {
  const f = fixture();
  const one = await consumption(f);
  const two = await consumption(f, 'remote-video-two', 'publisher-remote', 'remote-two', 2);
  await f.broker.setConsumerEnabled(one.consumerId, true);
  await f.broker.setConsumerEnabled(two.consumerId, true);
  f.watch('publisher-remote', 'remote-one', null);
  await f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  assert.equal(f.routed.has(one.consumerId), false);
  assert.equal(f.routed.has(two.consumerId), true);
  assert.equal(f.server.has(one.serverConsumerId), false);
  assert.equal(f.server.get(two.serverConsumerId).paused, false);
  assert.equal(f.calls(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).length, 0);
  assert.deepEqual(f.calls(MessageType.SFU_CONSUMER_CLOSED).map(call => call.payload.consumerId), [one.serverConsumerId]);
  await f.broker.close();
  assertEmpty(f);
});

test('Stop during server transport creation retires its late exact ID without creating a native consumer or transport', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.remote();
  f.watch();
  f.rpcHooks.set(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, async (call, next) => {
    allocated = await next();
    return await held.promise;
  });
  const consuming = f.broker.consume('remote-video-one', 1);
  await until(() => allocated);
  f.watch('publisher-remote', 'remote-one', null);
  const stopping = f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  held.resolve(allocated);
  await assert.rejects(consuming, error => hasCode(error, 'STALE'));
  await stopping;
  assert.equal(f.nativeFor('sfu.createTransport').length, 0);
  assert.equal(f.calls(MessageType.SFU_CONSUME).length, 0);
  assert.deepEqual(f.calls(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).map(call => call.payload.transportId), [allocated.transportOptions.id]);
  await f.broker.close();
  assertEmpty(f);
});

test('Stop during native transport creation retires both late native/server IDs, not a replacement transport', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.remote();
  f.watch();
  f.nativeHooks.set('sfu.createTransport', async (command, next) => {
    allocated = await next();
    return await held.promise;
  });
  const old = f.broker.consume('remote-video-one', 1);
  await until(() => allocated);
  const stopping = f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  f.nativeHooks.delete('sfu.createTransport');
  f.watch('publisher-remote', 'remote-one', 2);
  const replacing = f.broker.consume('remote-video-one', 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 1);
  held.resolve(allocated);
  await assert.rejects(old, error => hasCode(error, 'STALE'));
  await stopping;
  const replacement = await replacing;
  assert.equal(f.native.has(allocated.transportId), false);
  assert.equal(f.server.has(allocated.serverTransportId), false);
  assert.equal(f.native.has(replacement.consumerId), true);
  assert.equal(f.server.has(replacement.serverConsumerId), true);
  assert.equal(f.calls(MessageType.SFU_CONSUME).length, 1);
  await f.broker.close();
  assertEmpty(f);
});

test('scope close during native load owns and retires the late device without touching engine/capture', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.nativeHooks.set('sfu.load', async (command, next) => { allocated = await next(); return await held.promise; });
  const loading = f.broker.load();
  await until(() => allocated);
  f.scope.current = false;
  const closing = f.broker.close();
  held.resolve(allocated);
  await assert.rejects(loading, error => hasCode(error, 'STALE'));
  await closing;
  assert.deepEqual(f.nativeFor('resource.close').map(command => command.target), [allocated.deviceId]);
  assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 0);
  assertEmpty(f);
});

test('reset during server/native transport creation cannot delete the replacement of the same direction', async () => {
  for (const phase of ['server', 'native']) {
    const f = fixture(), held = deferred();
    let allocated;
    const hook = async (call, next) => { allocated = await next(); return await held.promise; };
    if (phase === 'server') f.rpcHooks.set(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, hook);
    else f.nativeHooks.set('sfu.createTransport', hook);
    const old = f.broker.createTransport('send');
    await until(() => allocated);
    const resetting = f.broker.resetTransport('send');
    f.rpcHooks.clear();
    f.nativeHooks.clear();
    const replacing = f.broker.createTransport('send');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 1);
    held.resolve(allocated);
    await assert.rejects(old, error => hasCode(error, 'STALE'));
    await resetting;
    const replacement = await replacing;
    const oldServerId = phase === 'server' ? allocated.transportOptions.id : allocated.serverTransportId;
    assert.equal(f.server.has(oldServerId), false);
    assert.equal(f.server.has(replacement.serverTransportId), true);
    assert.equal(f.native.has(replacement.transportId), true);
    assert.deepEqual(f.calls(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).map(call => call.payload.transportId), [oldServerId]);
    if (phase === 'native') assert.equal(f.native.has(allocated.transportId), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('Stop/replacement during server consumer creation deletes only the exact old consumer before any native consume', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.remote();
  f.watch();
  f.rpcHooks.set(MessageType.SFU_CONSUME, async (call, next) => { allocated = await next(); return await held.promise; });
  const old = f.broker.consume('remote-video-one', 1);
  await until(() => allocated);
  const stopping = f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  f.watch('publisher-remote', 'remote-one', 2);
  f.rpcHooks.delete(MessageType.SFU_CONSUME);
  const replacement = await f.broker.consume('remote-video-one', 2);
  await f.broker.setConsumerEnabled(replacement.consumerId, true);
  held.resolve(allocated);
  await assert.rejects(old, error => hasCode(error, 'STALE'));
  await stopping;
  assert.equal(f.server.has(allocated.id), false);
  assert.equal(f.server.get(replacement.serverConsumerId).paused, false);
  assert.equal(f.routed.has(replacement.consumerId), true);
  assert.equal(f.nativeFor('sfu.consume').length, 1);
  await f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  assert.equal(f.server.has(replacement.serverConsumerId), true);
  assert.deepEqual(f.calls(MessageType.SFU_CONSUMER_CLOSED).map(call => call.payload.consumerId), [allocated.id]);
  await f.broker.close();
  assertEmpty(f);
});

test('Stop/replacement during native consumer creation retires the old native ID and route generation only', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.remote();
  f.watch();
  f.nativeHooks.set('sfu.consume', async (command, next) => { allocated = await next(); return await held.promise; });
  const old = f.broker.consume('remote-video-one', 1);
  await until(() => allocated);
  const stopping = f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  f.nativeHooks.delete('sfu.consume');
  f.watch('publisher-remote', 'remote-one', 2);
  const replacement = await f.broker.consume('remote-video-one', 2);
  held.resolve(allocated);
  await assert.rejects(old, error => hasCode(error, 'STALE'));
  await stopping;
  assert.equal(f.native.has(allocated.consumerId), false);
  assert.equal(f.server.has(allocated.serverConsumerId), false);
  assert.equal(f.routed.has(allocated.consumerId), false);
  assert.equal(f.routed.has(replacement.consumerId), true);
  assert.equal(f.routeCalls.some(call => call.operation === 'register' && call.id === allocated.consumerId), false);
  await f.broker.close();
  assertEmpty(f);
});

test('Watch changes while routing is awaited cannot enable or retain the obsolete consumer route', async () => {
  const f = fixture(), held = deferred();
  const register = f.routes.registerConsumer;
  let registered;
  f.routes.registerConsumer = async (...args) => {
    register(...args);
    registered = args[0];
    await held.promise;
  };
  const old = consumption(f);
  await until(() => registered);
  f.watch('publisher-remote', 'remote-one', null);
  const stopping = f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  held.resolve();
  await assert.rejects(old, error => hasCode(error, 'STALE'));
  await stopping;
  assert.equal(f.routed.size, 0);
  assert.equal(f.nativeFor('sfu.setConsumerEnabled').length, 0);
  assert.equal(f.calls(MessageType.SFU_CONSUMER_SET_PAUSED).every(call => call.payload.paused), true);
  await f.broker.close();
  assertEmpty(f);
});

test('a late consumer resume ACK after Stop retires only that generation and cannot resurrect RTP', async () => {
  const f = fixture();
  const one = await consumption(f);
  const held = deferred();
  let resume;
  f.rpcHooks.set(MessageType.SFU_CONSUMER_SET_PAUSED, async (call, next) => {
    if (call.payload.paused) return await next();
    resume = call;
    await held.promise;
    return await next();
  });
  const enabling = f.broker.setConsumerEnabled(one.consumerId, true);
  const rejected = assert.rejects(enabling, error => hasCode(error, 'NATIVE') || hasCode(error, 'STALE'));
  await until(() => resume);
  const stopping = f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  f.watch('publisher-remote', 'remote-one', 2);
  const replacement = await f.broker.consume('remote-video-one', 2);
  held.resolve();
  await rejected;
  await stopping;
  assert.equal(f.server.has(one.serverConsumerId), false);
  assert.equal(f.routed.has(one.consumerId), false);
  assert.equal(f.server.has(replacement.serverConsumerId), true);
  assert.equal(f.routed.has(replacement.consumerId), true);
  f.rpcHooks.clear();
  await f.broker.close();
  assertEmpty(f);
});

test('a server producer arriving after native failure is retired before callback rejection and cannot bypass retained transport cleanup',
  { timeout: 5000 }, async () => {
  const f = fixture(), held = deferred(), lostNative = deferred();
  let allocated;
  f.register(1000, 'same-authenticated-share');
  f.rpcHooks.set(MessageType.SFU_PRODUCE, async (call, next) => { allocated = await next(); return await held.promise; });
  f.nativeHooks.set('sfu.produce', (command, next) => Promise.race([next(), lostNative.promise]));
  const old = f.broker.publish(1000, ENCODING);
  await until(() => allocated);
  const original = f.events.find(event => event.data.method === 'produce');
  lostNative.reject(new Error('inert cancellation double'));
  await until(() => f.commands.getPendingRequest(original.data.requestId) === null);
  const stopping = f.broker.removeSource(1000);
  f.nativeHooks.clear();
  f.rpcHooks.clear();
  f.register(1001, 'same-authenticated-share');
  const replacement = f.broker.publish(1001, ENCODING);
  const rejectedReplacement = assert.rejects(replacement, error => hasCode(error, 'CLOSE_NATIVE'));
  let cleanupPrecededReply = false;
  const respond = f.engine.respond;
  f.engine.respond = (callbackId, response) => {
    if (callbackId === original.data.callbackId) {
      assert.equal(response.ok, false);
      assert.equal(f.server.has(allocated.id), false);
      cleanupPrecededReply = true;
    }
    respond(callbackId, response);
  };
  held.resolve(allocated);
  await assert.rejects(old, error => hasCode(error, 'NATIVE'));
  await Promise.all([stopping, rejectedReplacement]);
  assert.equal(cleanupPrecededReply, true);
  assert.equal(f.nativeFor('sfu.produce').length, 1);
  assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 1);
  assert.deepEqual(f.calls(MessageType.SFU_PRODUCER_CLOSED).map(call => call.payload.producerId), [allocated.id]);
  await f.finishNativeClose();
  assertEmpty(f);
});

test('source removal during native producer creation closes the late exact publication, not a replacement source', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.register(1000, 'same-share');
  f.nativeHooks.set('sfu.produce', async (command, next) => { allocated = await next(); return await held.promise; });
  const old = f.broker.publish(1000, ENCODING);
  await until(() => allocated);
  const stopping = f.broker.removeSource(1000);
  f.nativeHooks.clear();
  f.register(1001, 'same-share');
  const replacement = await f.broker.publish(1001, ENCODING);
  held.resolve(allocated);
  await assert.rejects(old, error => hasCode(error, 'STALE'));
  await stopping;
  assert.equal(f.native.has(allocated.producerId), false);
  assert.equal(f.server.has(allocated.serverProducerId), false);
  assert.equal(f.native.has(replacement.producerId), true);
  assert.equal(f.server.has(replacement.serverProducerId), true);
  assert.equal(f.nativeFor('resource.close').some(command => [1000, 1001].includes(command.target)), false);
  await f.broker.close();
  assertEmpty(f);
});

test('authorization changes during consume retire returned IDs for the old remote producer, never the remote producer itself', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.remote();
  f.watch();
  f.rpcHooks.set(MessageType.SFU_CONSUME, async (call, next) => { allocated = await next(); return await held.promise; });
  const old = f.broker.consume('remote-video-one', 1);
  await until(() => allocated);
  f.remote('remote-video-replacement');
  f.rpcHooks.clear();
  const replacement = await f.broker.consume('remote-video-replacement', 1);
  held.resolve(allocated);
  await assert.rejects(old, error => hasCode(error, 'STALE'));
  assert.equal(f.server.has(allocated.id), false);
  assert.equal(f.server.has(replacement.serverConsumerId), true);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 0);
  await f.broker.removeRemoteProducer({ channelId: CHANNEL, producerId: 'remote-video-replacement' });
  assert.equal(f.server.has(replacement.serverConsumerId), false);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 0);
  await f.broker.close();
  assertEmpty(f);
});

test('invalid returned consumer metadata is claimed before rejection and its exact server ID is cleaned', async () => {
  const variants = [
    response => { response.channelId = 'foreign-channel'; },
    response => { response.producerId = 'foreign-producer'; },
    response => { response.producerSessionId = 'foreign-owner'; },
    response => { response.appData.shareId = 'foreign-share'; },
    response => { response.appData.extra = 'not-in-server-schema'; },
    response => { response.kind = 'audio'; response.appData.mediaType = 'screen_audio'; },
    response => { response.rtpParameters.codecs[0].mimeType = 'audio/opus'; },
    response => { response.rtpParameters = {}; },
  ];
  for (const alter of variants) {
    const f = fixture();
    let allocated;
    f.rpcHooks.set(MessageType.SFU_CONSUME, async (call, next) => {
      allocated = await next();
      const response = structuredClone(allocated);
      alter(response);
      return response;
    });
    await assert.rejects(consumption(f),
      error => ['RESPONSE', 'UNSUPPORTED_MEDIA', 'DTO'].some(code => hasCode(error, code)));
    assert.equal(f.server.has(allocated.id), false);
    assert.equal(f.nativeFor('sfu.consume').length, 0);
    assert.deepEqual(f.calls(MessageType.SFU_CONSUMER_CLOSED).map(call => call.payload.consumerId), [allocated.id]);
    assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 0);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('mismatched native producer/consumer server IDs close the allocated IDs, not the forged result IDs', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture();
    let allocated;
    const operation = kind === 'producer' ? 'sfu.produce' : 'sfu.consume';
    f.nativeHooks.set(operation, async (command, next) => {
      allocated = await next();
      return { ...allocated, [kind === 'producer' ? 'serverProducerId' : 'serverConsumerId']: 'unrelated-call-resource' };
    });
    await assert.rejects(kind === 'producer' ? publication(f) : consumption(f), error => hasCode(error, 'RESPONSE'));
    const actualId = kind === 'producer' ? allocated.serverProducerId : allocated.serverConsumerId;
    assert.equal(f.server.has(actualId), false);
    assert.equal(f.rpcCalls.some(call => Object.values(call.payload).includes('unrelated-call-resource')), false);
    assert.equal(f.native.has(kind === 'producer' ? allocated.producerId : allocated.consumerId), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('invalid transport channel, purpose, direction and DTLS/ICE responses still clean the exact allocated screen transport', async () => {
  const variants = [
    response => { response.channelId = 'wrong-channel'; },
    response => { response.purpose = 'call'; },
    response => { response.direction = 'recv'; },
    response => { response.transportOptions.iceCandidates[0].address = '192.0.2.2'; },
    response => { response.transportOptions.dtlsParameters.fingerprints[0].value = '00'; },
  ];
  for (const alter of variants) {
    const f = fixture();
    let allocated;
    f.rpcHooks.set(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, async (call, next) => {
      allocated = await next();
      const response = structuredClone(allocated);
      alter(response);
      return response;
    });
    await assert.rejects(f.broker.createTransport('send'), error => hasCode(error, 'RESPONSE') || hasCode(error, 'DTO'));
    assert.equal(f.nativeFor('sfu.createTransport').length, 0);
    assert.deepEqual(f.calls(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).map(call => call.payload),
      [{ channelId: CHANNEL, transportId: allocated.transportOptions.id, purpose: 'screen' }]);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('local source-in-use cleanup failure still stops server RTP and retains the publication for exact local retry', async () => {
  const f = fixture(), producer = await publication(f);
  f.nativeHooks.set('resource.close', async (command, next) => {
    if (command.target === producer.producerId) throw new Error('inert local close refusal');
    return await next();
  });
  await assert.rejects(f.broker.removeSource(1000), AggregateError);
  assert.equal(f.server.has(producer.serverProducerId), false);
  assert.equal(f.native.has(producer.producerId), true);
  const retained = f.broker.snapshot().resources.find(record => record.kind === 'producer');
  assert.equal(retained.nativeOwned, true);
  assert.equal(retained.serverOwned, false);
  assert.equal(f.broker.snapshot().sources, 1);
  await assert.rejects(f.commands.request('resource.close', 1000, {}), /SOURCE_IN_USE/u);
  f.nativeHooks.clear();
  await f.broker.removeSource(1000);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 1);
  assert.equal(f.native.has(producer.producerId), false);
  assert.equal(f.broker.snapshot().sources, 0);
  await f.broker.close();
  assertEmpty(f);
});

test('server-only ownership survives local close and retry never repeats an acknowledged native retirement', async () => {
  const f = fixture(), producer = await publication(f);
  f.rpcHooks.set(MessageType.SFU_PRODUCER_CLOSED, async () => { throw new Error('server close unavailable'); });
  await assert.rejects(f.broker.removeSource(1000), AggregateError);
  const retained = f.broker.snapshot().resources.find(record => record.kind === 'producer');
  assert.equal(retained.nativeOwned, false);
  assert.equal(retained.serverOwned, true);
  assert.equal(f.native.has(producer.producerId), false);
  assert.equal(f.server.has(producer.serverProducerId), true);
  f.rpcHooks.clear();
  await f.broker.removeSource(1000);
  assert.equal(f.nativeFor('resource.close').filter(command => command.target === producer.producerId).length, 1);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 2);
  await f.broker.close();
  assertEmpty(f);
});

test('complete teardown aggregates failures, retains exact ownership, and retries without touching global/call resources', async () => {
  const f = fixture();
  const producer = await publication(f);
  const consumer = await consumption(f);
  const closeTypes = [MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, MessageType.SFU_PRODUCER_CLOSED, MessageType.SFU_CONSUMER_CLOSED];
  f.nativeHooks.set('resource.close', async () => { throw new Error('inert local failure'); });
  for (const type of closeTypes) f.rpcHooks.set(type, async () => { throw new Error('inert server failure'); });
  await assert.rejects(f.broker.close(), AggregateError);
  let snapshot = f.broker.snapshot();
  assert.equal(snapshot.closed, true);
  assert.equal(snapshot.resources.length, 5);
  assert.equal(snapshot.resources.every(record => record.nativeOwned), true);
  assert.equal(snapshot.resources.filter(record => record.kind !== 'device').every(record => record.serverOwned), true);
  assert.equal(f.routed.size, 0);
  assert.equal(f.native.has(producer.producerId), true);
  assert.equal(f.server.has(consumer.serverConsumerId), true);
  f.nativeHooks.clear();
  await assert.rejects(f.broker.close(), AggregateError);
  snapshot = f.broker.snapshot();
  assert.equal(snapshot.resources.every(record => record.nativeOwned === false), true);
  assert.equal(snapshot.resources.filter(record => record.kind !== 'device').every(record => record.serverOwned), true);
  const nativeCloseCount = f.nativeFor('resource.close').length;
  f.rpcHooks.clear();
  await f.broker.close();
  assert.equal(f.nativeFor('resource.close').length, nativeCloseCount);
  assert.equal(f.nativeFor('resource.close').some(command => command.target === 1000), false);
  assert.equal(f.calls(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).every(call => call.payload.purpose === 'screen'), true);
  assert.equal(f.broker.snapshot().sources, 0);
  assertEmpty(f);
  await f.broker.close();
  await assert.rejects(f.broker.load(), error => hasCode(error, 'STALE'));
});

test('close only accepts owned transport handles and a wrong close ACK retains the exact old obligation for retry', async () => {
  const f = fixture();
  const send = await f.broker.createTransport('send'), recv = await f.broker.createTransport('recv');
  const before = f.rpcCalls.length;
  for (const id of [0, 9999, send.serverTransportId, 'call']) {
    await assert.rejects(f.broker.closeTransport(id), error => hasCode(error, 'RESOURCE'));
  }
  assert.equal(f.rpcCalls.length, before);
  f.rpcHooks.set(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, async call => ({
    ...call.payload, transportId: recv.serverTransportId,
  }));
  await assert.rejects(f.broker.closeTransport(send.transportId), AggregateError);
  assert.equal(f.server.has(send.serverTransportId), true);
  assert.equal(f.native.has(send.transportId), false);
  assert.equal(f.server.has(recv.serverTransportId), true);
  assert.equal(f.native.has(recv.transportId), true);
  f.rpcHooks.clear();
  await f.broker.closeTransport(send.transportId);
  assert.equal(f.server.has(send.serverTransportId), false);
  assert.equal(f.server.has(recv.serverTransportId), true);
  assert.equal(f.nativeFor('resource.close').filter(command => command.target === send.transportId).length, 1);
  await f.broker.close();
  assertEmpty(f);
});

test('failed late server-resource cleanup blocks replacement until exact retained cleanup is acknowledged', async () => {
  const f = fixture(), held = deferred();
  let allocated;
  f.rpcHooks.set(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, async (call, next) => {
    allocated = await next();
    return await held.promise;
  });
  const old = f.broker.createTransport('send');
  await until(() => allocated);
  f.rpcHooks.set(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, async () => { throw new Error('inert close failure'); });
  const reset = f.broker.resetTransport('send');
  const rejectedReset = assert.rejects(reset, AggregateError);
  f.rpcHooks.delete(MessageType.SFU_CREATE_WEBRTC_TRANSPORT);
  const replacing = f.broker.createTransport('send');
  const rejectedReplacement = assert.rejects(replacing, AggregateError);
  held.resolve(allocated);
  await assert.rejects(old, error => hasCode(error, 'RPC'));
  await rejectedReset;
  await rejectedReplacement;
  assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 1);
  assert.equal(f.broker.snapshot().resources.some(record => record.serverId === allocated.transportOptions.id && record.serverOwned), true);
  f.rpcHooks.clear();
  await f.broker.retryCleanup();
  const replacement = await f.broker.createTransport('send');
  assert.equal(f.server.has(allocated.transportOptions.id), false);
  assert.equal(f.server.has(replacement.serverTransportId), true);
  assert.equal(f.native.has(replacement.transportId), true);
  await f.broker.close();
  assertEmpty(f);
});

test('unknown successful allocation IDs remain unresolved instead of claiming another source or discarding ownership', async () => {
  const f = fixture();
  f.register();
  let real;
  f.nativeHooks.set('sfu.produce', async (command, next) => {
    real = await next();
    return { ...real, producerId: 1000 };
  });
  await assert.rejects(f.broker.publish(1000, ENCODING), error => hasCode(error, 'RESPONSE') && hasCode(error, 'OWNERSHIP'));
  const retained = f.broker.snapshot().resources.find(record => record.kind === 'producer');
  assert.equal(retained.nativeUnknown, true);
  assert.equal(retained.nativeId, null);
  assert.equal(f.nativeFor('resource.close').some(command => command.target === 1000), false);
  assert.equal(f.native.has(real.producerId), true);
  assert.equal(f.server.has(real.serverProducerId), false);
  // The exact owned transport/device close acknowledges descendant retirement;
  // the child's earlier failure is still surfaced, not silently discarded.
  await assert.rejects(f.broker.close(), AggregateError);
  assertEmpty(f);
  await f.broker.close();
});

test('a route registration/removal failure retains its route obligation and never enables native media', async () => {
  const f = fixture();
  const register = f.routes.registerConsumer, remove = f.routes.removeConsumer;
  f.routes.registerConsumer = (...args) => { register(...args); throw new Error('inert route registration failure'); };
  f.routes.removeConsumer = () => { throw new Error('inert route removal failure'); };
  await assert.rejects(consumption(f), error => hasCode(error, 'ROUTE'));
  assert.equal(f.nativeFor('sfu.setConsumerEnabled').length, 0);
  assert.equal(f.routed.size, 1);
  assert.equal(f.broker.snapshot().resources.some(record => record.kind === 'consumer' && record.routed), true);
  f.routes.removeConsumer = remove;
  await f.broker.retryCleanup();
  assert.equal(f.routed.size, 0);
  await f.broker.close();
  assertEmpty(f);
});

test('stale scope callbacks fail promptly with only exact transport cleanup and no foreground channel/session substitution', async () => {
  const f = fixture(), proceed = deferred();
  let entered;
  f.register();
  await f.broker.createTransport('send');
  f.nativeHooks.set('sfu.produce', async (command, next) => { entered = true; await proceed.promise; return await next(); });
  const producing = f.broker.publish(1000, ENCODING);
  await until(() => entered);
  const before = f.rpcCalls.length;
  f.scope.current = false;
  proceed.resolve();
  await assert.rejects(producing, error => hasCode(error, 'NATIVE'));
  assert.equal(f.rpcCalls.slice(before).every(call => call.type === MessageType.SFU_CLOSE_WEBRTC_TRANSPORT), true);
  assert.equal(f.responses.at(-1).response.ok, false);
  await f.finishNativeClose();
  assert.equal(f.rpcCalls.every(call => call.payload.channelId === CHANNEL), true);
  assertEmpty(f);
});

test('a stopped authorized Watch generation cannot be resurrected before its first consume', async () => {
  const f = fixture();
  f.remote();
  f.watch();
  await f.broker.stopWatching('publisher-remote', 'remote-one', 1);
  await assert.rejects(f.broker.consume('remote-video-one', 1), error => hasCode(error, 'STALE'));
  assert.equal(f.rpcCalls.length, 0);
  f.watch('publisher-remote', 'remote-one', 2);
  await f.broker.consume('remote-video-one', 2);
  await f.broker.close();
  assertEmpty(f);
});

test('source identities cannot register/publish again on the same call/transport after retirement', async () => {
  const f = fixture();
  await publication(f);
  await f.broker.removeSource(1000);
  assert.throws(() => f.register(1000, 'local-one'), /duplicated/u);
  assert.equal(f.calls(MessageType.SFU_PRODUCE).length, 1);
  await f.broker.close();
  assertEmpty(f);
});

test('resource, roster and source identity histories are bounded without dispatching excess work', async () => {
  const bounded = fixture({ maximumResources: 1, maximumRemoteProducers: 1 });
  bounded.register();
  await assert.rejects(bounded.broker.publish(1000, ENCODING), error => hasCode(error, 'LIMIT'));
  bounded.remote();
  assert.throws(() => bounded.remote('remote-two', 'publisher-other', 'other-share'), /roster limit/u);
  assert.equal(bounded.rpcCalls.length, 0);
  assert.equal(bounded.nativeCalls.length, 0);
  await bounded.broker.close();
  assertEmpty(bounded);
  const f = fixture();
  for (let index = 0; index < 64; index++) {
    f.register(1000 + index, 'repeated-share-with-new-native-source');
    await f.broker.removeSource(1000 + index);
  }
  assert.throws(() => f.register(2000, 'new-source'), /history is full/u);
  assert.equal(f.nativeCalls.length, 0);
  await f.broker.close();
  assertEmpty(f);
});

test('scope change in the final callback continuation still cleans before replying and cannot commit a producer', async () => {
  const f = fixture();
  const assertCallback = f.broker.assertCallback.bind(f.broker);
  let checks = 0;
  f.broker.assertCallback = token => {
    assertCallback(token);
    if (token.event.data.method === 'produce' && ++checks === 2) queueMicrotask(() => { f.scope.current = false; });
  };
  await assert.rejects(publication(f), error => hasCode(error, 'NATIVE'));
  const event = f.events.find(value => value.data.method === 'produce');
  assert.equal(f.responses.find(value => value.callbackId === event.data.callbackId).response.ok, false);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 1);
  assert.equal([...f.native.values()].some(record => record.kind === 'producer'), false);
  await f.finishNativeClose();
  assertEmpty(f);
});

test('failed respond retires the server allocation and retains tracking until the original native operation settles', async () => {
  const f = fixture(), nativeEnded = deferred();
  f.nativeHooks.set('sfu.produce', (command, next) => Promise.race([next(), nativeEnded.promise]));
  const respond = f.engine.respond;
  let rejectedCallback;
  f.engine.respond = (callbackId, response) => {
    const event = f.events.find(value => value.data.callbackId === callbackId);
    if (event?.data.method === 'produce' && response.ok) {
      rejectedCallback = callbackId;
      throw new Error('inert out-of-band response rejection');
    }
    respond(callbackId, response);
  };
  const producing = publication(f);
  await until(() => rejectedCallback && f.calls(MessageType.SFU_PRODUCER_CLOSED).length === 1);
  assert.equal(f.broker.snapshot().pendingOperations, 1);
  assert.equal(f.errors.some(error => hasCode(error, 'RESPOND')), true);
  assert.equal([...f.server.values()].some(record => record.kind === 'producer'), false);
  assert.equal(f.cancellations.length > 0, true);
  nativeEnded.reject(new Error('native cancellation completion'));
  await assert.rejects(producing, error => hasCode(error, 'NATIVE'));
  await f.broker.close();
  assertEmpty(f);
});

test('optional request-ID exposure eagerly cancels only its matching native creation before callbacks exist', async () => {
  const f = fixture(), held = deferred();
  let allocated, creationId;
  const request = f.commands.request.bind(f.commands);
  f.commands.request = (operation, target, data) => {
    const result = request(operation, target, data);
    Object.defineProperty(result, 'requestId', { value: f.nativeCalls.at(-1).id });
    return result;
  };
  f.nativeHooks.set('sfu.createTransport', async (command, next) => {
    creationId = command.id;
    allocated = await next();
    return await held.promise;
  });

  const creating = f.broker.createTransport('send');
  await until(() => allocated);
  const closing = f.broker.close();
  assert.ok(f.cancellations.includes(creationId));
  held.resolve(allocated);
  await assert.rejects(creating, error => hasCode(error, 'STALE'));
  await closing;
  assertEmpty(f);
});

for (const phase of ['connect', 'produce', 'initial-pause', 'enable', 'raw-source-gate']) {
  test(`SFU endpoint retirement drains ${phase} with concurrent viewers before cancelling native requests`, { timeout: 5000 }, async () => {
    const { NativeScreenEndpoint } = require('../runtime/nativeEndpoint.cjs');
    const held = deferred();
    let endpoint, allocated, rawGate = false;
    const f = fixture({ isCurrent: () => !endpoint?.closing });
    f.register();
    const method = phase === 'connect' ? MessageType.SFU_CONNECT_WEBRTC_TRANSPORT
      : phase === 'produce' ? MessageType.SFU_PRODUCE : MessageType.SFU_PRODUCER_SET_PAUSED;
    f.rpcHooks.set(method, async (call, next) => {
      const response = await next();
      if (phase === 'raw-source-gate' && !rawGate) return response;
      if (phase === 'initial-pause' && !call.payload.paused || phase === 'enable' && call.payload.paused) return response;
      allocated = response;
      await held.promise;
      return response;
    });
    const respond = f.engine.respond;
    f.engine.respond = (id, response) => {
      const event = f.events.find(value => value.data.callbackId === id);
      assert.equal(f.cancellations.includes(event.data.requestId), false,
        'Native Respond checks the original cancellation token before accepting a callback response.');
      return respond(id, response);
    };
    Object.assign(f.engine, {
      ready: Promise.resolve(),
      submitEncodedFrame() { assert.fail('The drain fixture must not submit media.'); },
      submitFrame() { assert.fail('The drain fixture must not submit textures.'); },
      releaseFrame() { assert.fail('The drain fixture must not own textures.'); },
    });
    f.nativeHooks.set('source.createEncodedVideo', async () => ({ sourceId: 1000 }));
    endpoint = new NativeScreenEndpoint({
      runtime: { rtc: { createEngine: () => f.engine } },
      textures: { importSharedTexture() {}, sendSharedTexture() {} },
      role: 'publish', mode: 'sfu', sessionId: OWNER, publisherSessionId: OWNER, channelId: CHANNEL,
      pipelineId: require('node:crypto').randomUUID(),
      source: { shareId: 'local-one', instanceId: require('node:crypto').randomUUID(), audio: false,
        video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 12000 } },
      quality: 'source', target: { hwnd: 12345, expectedProcessId: 56789 },
      captureDirectory: require('node:path').resolve(__dirname, 'modeled-capture'),
      rpc: async () => assert.fail('Only the wired broker model may issue RPCs.'),
      onError: error => f.errors.push(error), onState() {}, onDiagnostic() {},
    });
    await endpoint.ready;
    await endpoint.transport.close();
    Object.assign(endpoint, {
      sourceDescription: {},
      broker: f.broker, commands: f.commands, abort: new AbortController(), peerReadiness: new Map(),
      pending: new Set(), demandWork: new Set(), errors: [], reported: new WeakSet(),
      closing: false, closed: false, demand: 0, previewDemand: false, stopRequested: false,
      onError: error => f.errors.push(error),
      refreshCapture() {},
      transport: { addSource: () => f.broker.publish(1000, ENCODING) },
      async retire() { await f.broker.close(); this.closed = true; },
    });
    let rejected;
    if (phase === 'raw-source-gate') {
      await endpoint.setDemand(1, false);
      rawGate = true;
      // PCM admits source.setEnabled independently from viewer demand work.
      endpoint.pcm = { stopAccepting() {}, beginCaptureStop() {},
        packetTail: f.commands.request('source.setEnabled', 1000, { enabled: true }) };
      rejected = endpoint.pcm.packetTail;
    } else {
      rejected = Promise.all([1, 2].map(count => assert.rejects(endpoint.setDemand(count, false), { name: 'AbortError' })));
    }
    await until(() => allocated);
    const duplicate = f.broker.handleNativeEvent(f.events.at(-1));
    const closing = endpoint.close();
    await assert.rejects(endpoint.setDemand(3, false), { name: 'AbortError' });
    // Always release the RPC so a failing assertion cannot retain test work.
    held.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.errors.some(error => hasCode(error, 'RESPOND')), false,
      'Retirement must not cancel an original request while its server reply is still being delivered.');
    await rejected;
    await duplicate;
    await closing;
    assert.deepEqual(f.errors, []);
    assert.equal(f.cancellations.length, 0);
    assert.equal(f.calls(MessageType.SFU_PRODUCE).length, 1, 'Concurrent viewers must share the original publication.');
    assertEmpty(f);
  });
}

test('forged optional request-ID metadata cannot cancel a separate call operation', async () => {
  const f = fixture(), held = deferred(), callHeld = deferred();
  f.nativeHooks.set('peer.create', () => callHeld.promise);
  const separateCall = f.commands.request('peer.create', 0, { syncGroup: 'browser-call-double' });
  const callRequestId = f.nativeCalls.at(-1).id;
  const request = f.commands.request.bind(f.commands);
  f.commands.request = (operation, target, data) => {
    const result = request(operation, target, data);
    Object.defineProperty(result, 'requestId', { value: callRequestId });
    return result;
  };
  let allocated;
  f.nativeHooks.set('sfu.createTransport', async (command, next) => { allocated = await next(); return await held.promise; });
  const creating = f.broker.createTransport('send');
  await until(() => allocated);
  const closing = f.broker.close();
  assert.equal(f.cancellations.includes(callRequestId), false);
  assert.ok(f.commands.getPendingRequest(callRequestId));
  held.resolve(allocated);
  await assert.rejects(creating, error => hasCode(error, 'STALE'));
  await closing;
  callHeld.resolve({ peerId: 99999 });
  await separateCall;
  assertEmpty(f);
});

test('a legacy audioAvailable load field is rejected rather than used as a capability fallback', async () => {
  const f = fixture();
  let allocated;
  f.nativeHooks.set('sfu.load', async (command, next) => {
    allocated = await next();
    return { ...allocated, audioAvailable: true };
  });
  await assert.rejects(f.broker.load(), error => hasCode(error, 'RESPONSE'));
  assert.deepEqual(f.nativeFor('resource.close').map(command => command.target), [allocated.deviceId]);
  assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 0);
  await f.broker.close();
  assertEmpty(f);
});

test('missing returned consumer IDs retain unknown ownership until the exact transport close is acknowledged', async () => {
  const f = fixture();
  let allocated;
  f.rpcHooks.set(MessageType.SFU_CONSUME, async (call, next) => {
    allocated = await next();
    const response = { ...allocated };
    delete response.id;
    return response;
  });
  await assert.rejects(consumption(f), error => hasCode(error, 'OWNERSHIP') && hasCode(error, 'RESPONSE'));
  const retained = f.broker.snapshot().resources.find(record => record.kind === 'consumer');
  assert.equal(retained.serverUnknown, true);
  assert.equal(retained.serverId, null);
  assert.equal(f.server.has(allocated.id), true);
  assert.equal(f.calls(MessageType.SFU_CONSUMER_CLOSED).length, 0);
  await assert.rejects(f.broker.close(), AggregateError);
  assertEmpty(f);
  await f.broker.close();
});

test('malformed native callback JSON, RTP encodings and control types are rejected before RPC', async () => {
  const f = fixture(), held = deferred();
  f.register();
  const transport = await f.broker.createTransport('send');
  let command;
  f.nativeHooks.set('sfu.produce', value => { command = value; return held.promise; });
  const producing = f.broker.publish(1000, ENCODING);
  await until(() => command);
  const makeEvent = () => ({ type: 'request', target: transport.transportId, data: { callbackId: 30000,
    requestId: command.id, method: 'produce', payload: { transportId: transport.serverTransportId,
      kind: 'video', purpose: 'screen', rtpParameters: structuredClone(RTP),
      appData: { mediaType: 'screen_video', syncGroup: localGroup(1000) } } } });
  let getterRead = false;
  const variants = [
    event => { event.data.payload.rtpParameters.encodings = ['not-an-encoding']; },
    event => { event.data.payload.rtpParameters.encodings = [{ ssrc: -1 }]; },
    event => { event.data.payload.rtpParameters.codecs[0].parameters = { bad: { nested: true } }; },
    event => { event.data.payload.rtpParameters.headerExtensions = [{ id: 0, uri: 'invalid' }]; },
    event => { Object.defineProperty(event.data.payload, 'kind', { enumerable: true, get() { getterRead = true; return 'video'; } }); },
    event => { event.data.payload.rtpParameters.self = event.data.payload.rtpParameters; },
  ];
  const before = f.rpcCalls.length;
  for (const [index, alter] of variants.entries()) {
    const event = makeEvent();
    event.data.callbackId += index;
    alter(event);
    assert.equal(await f.broker.handleNativeEvent(event), false);
  }
  assert.equal(getterRead, false);
  assert.equal(f.rpcCalls.length, before);
  held.reject(new Error('end inert native operation'));
  await assert.rejects(producing, error => hasCode(error, 'NATIVE'));
  await f.broker.close();
  assertEmpty(f);
});

test('producer/consumer callbacks cannot gate another native/server resource or resume a disable command', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture();
    const first = kind === 'producer' ? await publication(f) : await consumption(f);
    const second = kind === 'producer' ? await publication(f, 1001, 'local-two')
      : await consumption(f, 'remote-two', 'publisher-remote', 'remote-two', 2);
    const nativeId = kind === 'producer' ? first.producerId : first.consumerId;
    const otherNative = kind === 'producer' ? second.producerId : second.consumerId;
    const serverId = kind === 'producer' ? first.serverProducerId : first.serverConsumerId;
    const otherServer = kind === 'producer' ? second.serverProducerId : second.serverConsumerId;
    const transport = f.native.get(f.native.get(nativeId).parent);
    const operation = kind === 'producer' ? 'sfu.setProducerEnabled' : 'sfu.setConsumerEnabled';
    const method = kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled';
    const held = deferred();
    let command;
    f.nativeHooks.set(operation, value => { command = value; return held.promise; });
    const disabling = kind === 'producer' ? f.broker.setProducerEnabled(nativeId, false)
      : f.broker.setConsumerEnabled(nativeId, false);
    const rejected = assert.rejects(disabling, error => hasCode(error, 'NATIVE'));
    await until(() => command);
    const base = () => ({ type: 'request', target: nativeId, data: { callbackId: 40000, requestId: command.id, method,
      payload: { transportId: transport.serverId, [kind === 'producer' ? 'producerId' : 'consumerId']: serverId,
        enabled: false, purpose: 'screen' } } });
    const variants = [
      event => { event.target = otherNative; },
      event => { event.target = transport.id; },
      event => { event.data.payload[kind === 'producer' ? 'producerId' : 'consumerId'] = otherServer; },
      event => { event.data.payload.transportId = 'unrelated-call-transport'; },
      event => { event.data.payload.enabled = true; },
      event => { event.data.payload.enabled = 'false'; },
      event => { event.data.payload.purpose = 'call'; },
    ];
    const before = f.rpcCalls.length;
    for (const [index, alter] of variants.entries()) {
      const event = base();
      event.data.callbackId += index;
      alter(event);
      assert.equal(await f.broker.handleNativeEvent(event), false);
    }
    assert.equal(f.rpcCalls.length, before);
    assert.equal(f.server.has(otherServer), true, 'invalid callbacks alone cannot retire a different resource');
    held.reject(new Error('inert native gate failure'));
    await rejected;
    assert.equal(f.server.has(otherServer), kind !== 'producer', 'a rejected native producer command invalidates every sender');
    await f.broker.close();
    assertEmpty(f);
  }
});

test('native gate success without an active correlated server ACK is not accepted as enabled', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture();
    const record = kind === 'producer' ? await publication(f) : await consumption(f);
    const operation = kind === 'producer' ? 'sfu.setProducerEnabled' : 'sfu.setConsumerEnabled';
    f.nativeHooks.set(operation, async () => ({ enabled: true }));
    await assert.rejects(kind === 'producer' ? f.broker.setProducerEnabled(record.producerId, true)
      : f.broker.setConsumerEnabled(record.consumerId, true), error => hasCode(error, 'ACK'));
    assert.equal(f.server.has(kind === 'producer' ? record.serverProducerId : record.serverConsumerId), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('throwing error observers cannot prevent a rejected callback response or exact cleanup', async () => {
  const f = fixture({ onError() { throw new Error('inert observer exception'); } });
  const producer = await publication(f);
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async () => { throw new Error('inert RPC failure'); });
  await assert.rejects(f.broker.setProducerEnabled(producer.producerId, true));
  assert.equal(f.responses.at(-1).response.ok, false);
  assert.equal(f.broker.snapshot().observerFailures > 0, true);
  assert.equal(f.server.has(producer.serverProducerId), false);
  f.rpcHooks.clear();
  await f.finishNativeClose();
  assertEmpty(f);
});

test('finishAfterEngineClose requires a real Promise and does not retire native ownership before fulfillment', async () => {
  const f = fixture(), proof = deferred();
  await publication(f);
  for (const notAProof of [{ type: 'closed', target: 0, data: {} }, { closed: true }, undefined,
    { then(resolve) { resolve({ closed: true }); } }]) {
    await assert.rejects(f.broker.finishAfterEngineClose(notAProof), error => hasCode(error, 'ENGINE_CLOSE'));
  }
  assert.equal(f.broker.snapshot().closed, false);
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.broker.snapshot().closed, true);
  assert.equal(f.broker.snapshot().engineRetired, false);
  assert.throws(() => f.commands.assertEngineClosed(f.engine), /has not been proven/u);
  assert.equal(f.broker.snapshot().resources.every(record => record.nativeOwned), true);
  assert.equal(f.nativeFor('resource.close').length, 0);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 0);
  // Only this double's controller performs the simulated complete engine close.
  f.native.clear();
  proof.resolve({ closed: true, nativeThreadsDrained: true });
  await finishing;
  assert.equal(f.broker.snapshot().engineRetired, true);
  assert.doesNotThrow(() => f.commands.assertEngineClosed(f.engine));
  assert.equal(f.engineCloseCalls.length, 1);
  assert.equal(f.nativeFor('resource.close').length, 0);
  assertEmpty(f);
});

test('a rejected complete-engine-close Promise retains native ownership and does not invent global retirement', async () => {
  const f = fixture(), proof = deferred();
  await publication(f);
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  proof.reject(new Error('private native close diagnostic'));
  await assert.rejects(finishing, error => hasCode(error, 'ENGINE_CLOSE'));
  assert.equal(f.broker.snapshot().engineRetired, false);
  assert.equal(f.broker.snapshot().resources.every(record => record.nativeOwned), true);
  assert.equal(f.nativeFor('resource.close').length, 0);
  assert.equal(f.errors.flatMap(diagnostics).join(' ').includes('private native close diagnostic'), false);
  await f.broker.close();
  assertEmpty(f);
});

test('global engine-close proof preserves offline server obligations, and retries never call the destroyed engine', async () => {
  const f = fixture(), proof = deferred();
  const producer = await publication(f);
  const consumer = await consumption(f);
  for (const type of [MessageType.SFU_PRODUCER_CLOSED, MessageType.SFU_CONSUMER_CLOSED, MessageType.SFU_CLOSE_WEBRTC_TRANSPORT]) {
    f.rpcHooks.set(type, async () => { throw new Error('offline server double'); });
  }
  f.nativeHooks.set('resource.close', () => { assert.fail('resource.close cannot run after complete engine retirement'); });
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  f.native.clear();
  proof.resolve({ closed: true });
  await assert.rejects(finishing, error => hasCode(error, 'RPC') && !hasCode(error, 'CLOSE_NATIVE'));
  const snapshot = f.broker.snapshot();
  assert.equal(snapshot.engineRetired, true);
  assert.equal(snapshot.resources.every(record => !record.nativeOwned && !record.nativeUnknown), true);
  assert.equal(snapshot.resources.filter(record => record.kind !== 'device').every(record => record.serverOwned), true);
  assert.equal(f.server.has(producer.serverProducerId), true);
  assert.equal(f.server.has(consumer.serverConsumerId), true);
  assert.equal(f.routed.size, 0);
  assert.equal(f.nativeFor('resource.close').length, 0);
  f.rpcHooks.clear();
  await f.broker.retryCleanup();
  assert.equal(f.nativeFor('resource.close').length, 0);
  assertEmpty(f);
});

test('global proof supersedes an already-pending local close but not its failed remote cleanup', async () => {
  const f = fixture(), localClose = deferred(), proof = deferred();
  const producer = await publication(f);
  let localCommand;
  f.nativeHooks.set('resource.close', command => { localCommand = command; return localClose.promise; });
  for (const type of [MessageType.SFU_PRODUCER_CLOSED, MessageType.SFU_CLOSE_WEBRTC_TRANSPORT]) {
    f.rpcHooks.set(type, async () => { throw new Error('offline server double'); });
  }
  const originalClose = f.broker.close();
  const rejectedOriginal = assert.rejects(originalClose, error => hasCode(error, 'RPC'));
  await until(() => localCommand);
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  f.native.clear();
  proof.resolve({ closed: true });
  await rejectedOriginal;
  await assert.rejects(finishing, error => hasCode(error, 'RPC') && !hasCode(error, 'CLOSE_NATIVE'));
  assert.equal(f.nativeFor('resource.close').length, 1);
  assert.equal(f.nativeFor('resource.close')[0].target, producer.producerId);
  assert.equal(f.broker.snapshot().resources.every(record => !record.nativeOwned), true);
  // A delayed wrapper rejection is observed but no longer an ownership failure.
  localClose.reject(new Error('late CLOSED from the retired engine double'));
  await until(() => f.commands.getPendingRequest(localCommand.id) === null);
  f.rpcHooks.clear();
  await f.broker.close();
  assert.equal(f.nativeFor('resource.close').length, 1);
  assertEmpty(f);
});

test('a late native creation completion after the global proof cannot restore native ownership or trigger local close', async () => {
  const f = fixture(), nativeResult = deferred(), proof = deferred();
  let allocated, commandId;
  f.register();
  f.nativeHooks.set('sfu.produce', async (command, next) => {
    commandId = command.id;
    allocated = await next();
    return await nativeResult.promise;
  });
  const producing = f.broker.publish(1000, ENCODING);
  const rejected = assert.rejects(producing, error => hasCode(error, 'STALE'));
  await until(() => allocated);
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  f.native.clear();
  proof.resolve({ closed: true });
  await rejected;
  await finishing;
  assert.equal(f.nativeFor('resource.close').length, 0);
  assert.equal(f.server.has(allocated.serverProducerId), false);
  nativeResult.resolve(allocated);
  await until(() => f.commands.getPendingRequest(commandId) === null);
  assert.equal(f.broker.snapshot().engineRetired, true);
  assert.equal(f.nativeFor('resource.close').some(command => command.target === 1000), false);
  assertEmpty(f);
});

test('late server consumer creation remains owned after global native close and is cleaned without creating native resources', async () => {
  const f = fixture(), serverResult = deferred(), proof = deferred();
  let allocated;
  f.remote();
  f.watch();
  f.rpcHooks.set(MessageType.SFU_CONSUME, async (call, next) => { allocated = await next(); return await serverResult.promise; });
  const consuming = f.broker.consume('remote-video-one', 1);
  const rejected = assert.rejects(consuming, error => hasCode(error, 'STALE'));
  await until(() => allocated);
  let finished = false;
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise)).then(() => { finished = true; });
  f.native.clear();
  proof.resolve({ closed: true });
  await until(() => f.broker.snapshot().engineRetired);
  assert.equal(finished, false);
  assert.equal(f.broker.snapshot().resources.every(record => !record.nativeOwned && !record.nativeUnknown), true);
  assert.equal(f.broker.snapshot().resources.some(record => record.kind === 'consumer' && record.serverUnknown), true);
  serverResult.resolve(allocated);
  await rejected;
  await finishing;
  assert.deepEqual(f.calls(MessageType.SFU_CONSUMER_CLOSED).map(call => call.payload.consumerId), [allocated.id]);
  assert.equal(f.nativeFor('sfu.consume').length, 0);
  assert.equal(f.nativeFor('resource.close').length, 0);
  assertEmpty(f);
});

test('late producer RPC callbacks after full engine retirement perform only exact remote cleanup, never respond/cancel', async () => {
  const f = fixture(), serverResult = deferred(), proof = deferred();
  let allocated;
  f.register();
  f.rpcHooks.set(MessageType.SFU_PRODUCE, async (call, next) => { allocated = await next(); return await serverResult.promise; });
  const producing = f.broker.publish(1000, ENCODING);
  const rejected = assert.rejects(producing, error => hasCode(error, 'STALE'));
  await until(() => allocated);
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  f.native.clear();
  proof.resolve({ closed: true });
  await until(() => f.broker.snapshot().engineRetired);
  const beforeResponses = f.responses.length, beforeCancels = f.cancellations.length;
  f.engine.respond = () => { assert.fail('respond cannot touch a globally retired engine'); };
  f.engine.cancel = () => { assert.fail('cancel cannot touch a globally retired engine'); };
  serverResult.resolve(allocated);
  await rejected;
  await finishing;
  assert.equal(f.responses.length, beforeResponses);
  assert.equal(f.cancellations.length, beforeCancels);
  assert.deepEqual(f.calls(MessageType.SFU_PRODUCER_CLOSED).map(call => call.payload.producerId), [allocated.id]);
  assert.equal(f.nativeFor('resource.close').length, 0);
  assertEmpty(f);
});

test('global native proof clears unidentified native allocations while preserving only independently acknowledged remote cleanup', async () => {
  const f = fixture(), proof = deferred();
  f.register();
  f.nativeHooks.set('sfu.produce', async (command, next) => ({ ...await next(), producerId: 1000 }));
  await assert.rejects(f.broker.publish(1000, ENCODING), error => hasCode(error, 'OWNERSHIP'));
  assert.equal(f.broker.snapshot().resources.some(record => record.nativeUnknown), true);
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  f.native.clear();
  proof.resolve({ closed: true });
  await finishing;
  assert.equal(f.nativeFor('resource.close').length, 0);
  assert.equal(f.broker.snapshot().engineRetired, true);
  assertEmpty(f);
});

test('completed local close failures are superseded by global proof while remote failures remain retryable', async () => {
  const f = fixture(), proof = deferred();
  await publication(f);
  f.nativeHooks.set('resource.close', async () => { throw new Error('local close failure before global shutdown'); });
  for (const type of [MessageType.SFU_PRODUCER_CLOSED, MessageType.SFU_CLOSE_WEBRTC_TRANSPORT]) {
    f.rpcHooks.set(type, async () => { throw new Error('offline server double'); });
  }
  await assert.rejects(f.broker.close(), error => hasCode(error, 'CLOSE_NATIVE') && hasCode(error, 'RPC'));
  const nativeCloses = f.nativeFor('resource.close').length;
  const finishing = f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  f.native.clear();
  proof.resolve({ closed: true });
  await assert.rejects(finishing, error => hasCode(error, 'RPC') && !hasCode(error, 'CLOSE_NATIVE'));
  assert.equal(f.nativeFor('resource.close').length, nativeCloses);
  assert.equal(f.broker.snapshot().resources.every(record => !record.nativeOwned && !record.nativeUnknown), true);
  f.rpcHooks.clear();
  await f.broker.finishAfterEngineClose(f.closeEngineFromController(proof.promise));
  assert.equal(f.nativeFor('resource.close').length, nativeCloses);
  assertEmpty(f);
});

test('resolved JSON/ACK Promises cannot forge retirement before or during the command registry real close', async () => {
  const f = fixture(), nativeProof = deferred();
  await publication(f);
  for (const jsonAck of [{ closed: true }, { type: 'closed', target: 0, data: {} }, { ok: true }]) {
    await assert.rejects(f.broker.finishAfterEngineClose(Promise.resolve(jsonAck)), error => hasCode(error, 'ENGINE_CLOSE'));
    assert.equal(f.broker.snapshot().engineRetired, false);
    assert.equal(f.broker.snapshot().resources.every(record => record.nativeOwned), true);
  }
  assert.equal(f.engineCloseCalls.length, 0);
  const actualClose = f.closeEngineFromController(nativeProof.promise);
  const finishing = f.broker.finishAfterEngineClose(actualClose);
  await until(() => f.engineCloseCalls.length === 1);
  await assert.rejects(f.broker.finishAfterEngineClose(Promise.resolve({ closed: true })),
    error => hasCode(error, 'ENGINE_CLOSE'));
  assert.equal(f.broker.snapshot().engineRetired, false);
  assert.equal(f.broker.snapshot().resources.every(record => record.nativeOwned), true);
  assert.equal(f.nativeFor('resource.close').length, 0);
  f.native.clear();
  nativeProof.resolve({ closed: true });
  await finishing;
  assert.equal(f.broker.snapshot().engineRetired, true);
  assert.equal(f.nativeFor('resource.close').length, 0);
  assertEmpty(f);
});

test('a proven close of a different engine cannot retire this broker engine', async () => {
  const f = fixture(), foreign = fixture(), foreignProof = deferred();
  await publication(f);
  const otherEngineClose = foreign.closeEngineFromController(foreignProof.promise);
  foreign.native.clear();
  foreignProof.resolve({ closed: true });
  await otherEngineClose;
  assert.doesNotThrow(() => foreign.commands.assertEngineClosed(foreign.engine));
  assert.throws(() => foreign.commands.assertEngineClosed(f.engine), /has not been proven/u);
  assert.throws(() => { f.commands.engine = foreign.engine; }, TypeError);
  await assert.rejects(f.broker.finishAfterEngineClose(otherEngineClose), error => hasCode(error, 'ENGINE_CLOSE'));
  assert.equal(f.broker.snapshot().engineRetired, false);
  assert.equal(f.broker.snapshot().resources.every(record => record.nativeOwned), true);
  assert.equal(f.engineCloseCalls.length, 0);
  await f.broker.close();
  await foreign.broker.finishAfterEngineClose(otherEngineClose);
  assertEmpty(f);
  assertEmpty(foreign);
});

test('initial pause targets the tentative native producer/consumer before the creation result, not its transport', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture(), pauseAck = deferred();
    const type = kind === 'producer' ? MessageType.SFU_PRODUCER_SET_PAUSED : MessageType.SFU_CONSUMER_SET_PAUSED;
    const method = kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled';
    f.rpcHooks.set(type, async (call, next) => { await pauseAck.promise; return await next(); });
    const creating = kind === 'producer' ? publication(f) : consumption(f);
    await until(() => f.calls(type).length === 1);
    const event = f.events.find(value => value.data.method === method);
    const original = f.commands.getPendingRequest(event.data.requestId);
    const record = [...f.broker.resources].find(value => value.kind === kind);
    assert.notEqual(event.target, original.target);
    assert.equal(f.broker.tentativeNativeOwners.get(event.target), record);
    assert.equal(record.nativeId, null);
    assert.equal(record.nativeOwned, false);
    assert.equal(f.routed.size, 0);
    assert.equal(f.calls(type)[0].payload.paused, true);
    pauseAck.resolve();
    const created = await creating;
    assert.equal(kind === 'producer' ? created.producerId : created.consumerId, event.target);
    assert.equal(f.broker.tentativeNativeOwners.has(event.target), false);
    assert.equal(f.broker.nativeOwners.get(event.target), record);
    f.rpcHooks.clear();
    await f.broker.close();
    assertEmpty(f);
  }
});

test('tentative targets cannot claim existing sources/resources or change identity during the same creation', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture(), held = deferred(), entered = deferred();
    const existing = kind === 'producer' ? await publication(f) : await consumption(f);
    if (kind === 'consumer') f.register(1000, 'capture-not-published');
    const operation = kind === 'producer' ? 'sfu.produce' : 'sfu.consume';
    const method = kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled';
    f.nativeHooks.set(operation, async command => {
      const transport = f.native.get(command.target);
      let serverId = command.data.id;
      if (kind === 'producer') {
        const response = await f.callback(command, 'produce', command.target, { transportId: transport.serverId,
          kind: 'video', rtpParameters: structuredClone(RTP), appData: command.data.appData, purpose: 'screen' });
        serverId = response.id;
      }
      entered.resolve({ command, serverId, transport });
      return await held.promise;
    });
    const creating = kind === 'producer' ? publication(f, 1001, 'local-two')
      : consumption(f, 'remote-two', 'publisher-remote', 'remote-two', 2);
    const rejected = assert.rejects(creating, error => hasCode(error, 'NATIVE'));
    const { command, serverId, transport } = await entered.promise;
    let callbackId = 50000;
    const eventFor = target => ({ type: 'request', target, data: { callbackId: callbackId++, requestId: command.id, method,
      payload: { transportId: transport.serverId, [kind === 'producer' ? 'producerId' : 'consumerId']: serverId,
        enabled: false, purpose: 'screen' } } });
    const before = f.rpcCalls.length;
    for (const target of [1000, kind === 'producer' ? existing.producerId : existing.consumerId,
      f.nativeFor('sfu.load').length ? [...f.native.values()].find(value => value.kind === 'device').id : 0]) {
      assert.equal(await f.broker.handleNativeEvent(eventFor(target)), false);
    }
    assert.equal(f.rpcCalls.length, before);
    assert.equal(await f.broker.handleNativeEvent(eventFor(60000)), true);
    assert.throws(() => f.broker.registerSource({ sourceId: 60000, shareId: 'forged-source', syncGroup: SYNC }), /registration/u);
    const afterPause = f.rpcCalls.length;
    assert.equal(await f.broker.handleNativeEvent(eventFor(60001)), false);
    assert.equal(f.rpcCalls.length, afterPause);
    held.reject(new Error('SDK discarded its tentative resource'));
    await rejected;
    assert.equal(f.broker.tentativeNativeOwners.size, 0);
    assert.equal(f.nativeFor('resource.close').some(value => value.target === 60000 || value.target === 60001), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('failed-create transport-target cleanup still pauses the exact server reservation after local transport close and Stop', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture(), failure = failedNativeCreation(f, kind);
    const creating = kind === 'producer' ? publication(f) : consumption(f);
    const rejected = assert.rejects(creating, error => hasCode(error, 'NATIVE'));
    const { command, serverId } = await failure.entered;
    const transport = [...f.broker.resources].find(record => record.kind === 'transport' && record.nativeId === command.target);
    await f.broker.closeLocal(transport);
    assert.equal(transport.nativeOwned, false);
    assert.equal(transport.serverOwned, true);
    const stopping = kind === 'producer' ? f.broker.removeSource(1000)
      : f.broker.stopWatching('publisher-remote', 'remote-one', 1);
    if (kind === 'consumer') f.watch('publisher-remote', 'remote-one', null);
    failure.proceed.resolve();
    await rejected;
    await stopping;
    const pauseType = kind === 'producer' ? MessageType.SFU_PRODUCER_SET_PAUSED : MessageType.SFU_CONSUMER_SET_PAUSED;
    assert.equal(f.calls(pauseType).length, 1);
    const paused = f.calls(pauseType)[0].payload;
    assert.equal(paused.producerId ?? paused.consumerId, serverId);
    assert.equal(paused.paused, true);
    const event = f.events.find(value => value.data.method === (kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled'));
    assert.equal(event.target, command.target);
    assert.equal(f.responses.find(value => value.callbackId === event.data.callbackId).response.ok, true);
    await f.broker.resetTransport(kind === 'producer' ? 'send' : 'recv');
    await f.broker.close();
    assertEmpty(f);
  }
});

test('failed-create cleanup does not issue pause RPC against a server resource already retired by an exact ACK', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture(), failure = failedNativeCreation(f, kind);
    const creating = kind === 'producer' ? publication(f) : consumption(f);
    const rejected = assert.rejects(creating, error => hasCode(error, 'NATIVE'));
    const { serverId } = await failure.entered;
    const record = [...f.broker.resources].find(value => value.kind === kind && value.serverId === serverId);
    await f.broker.closeServer(record);
    assert.equal(record.serverRetired, true);
    assert.equal(record.serverOwned, false);
    const before = f.rpcCalls.length;
    failure.proceed.resolve();
    await rejected;
    assert.equal(f.rpcCalls.slice(before).every(call => call.type === MessageType.SFU_CLOSE_WEBRTC_TRANSPORT), true);
    const method = kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled';
    const event = f.events.find(value => value.data.method === method);
    assert.equal(f.responses.find(value => value.callbackId === event.data.callbackId).response.ok, true);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('the failed-create cleanup exception cannot resume media or address another server reservation', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture(), failure = failedNativeCreation(f, kind);
    const creating = kind === 'producer' ? publication(f) : consumption(f);
    const rejected = assert.rejects(creating, error => hasCode(error, 'NATIVE'));
    const { command, payload } = await failure.entered;
    const method = kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled';
    const variants = [
      event => { event.data.payload.enabled = true; },
      event => { event.data.payload[kind === 'producer' ? 'producerId' : 'consumerId'] = 'another-call-resource'; },
      event => { event.data.payload.transportId = 'another-call-transport'; },
      event => { event.data.payload.purpose = 'call'; },
      event => { event.data.requestId = command.id + 10000; },
    ];
    const before = f.rpcCalls.length;
    for (const [index, alter] of variants.entries()) {
      const event = { type: 'request', target: command.target, data: { callbackId: 70000 + index, requestId: command.id,
        method, payload: structuredClone(payload) } };
      alter(event);
      assert.equal(await f.broker.handleNativeEvent(event), false);
    }
    assert.equal(f.rpcCalls.length, before);
    failure.proceed.resolve();
    await rejected;
    await f.broker.close();
    assertEmpty(f);
  }
});

test('a creation success after failed-create cleanup is rejected and its returned native/server IDs are retired', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture();
    let allocated;
    f.nativeHooks.set(kind === 'producer' ? 'sfu.produce' : 'sfu.consume', async (command, next) => {
      allocated = await next();
      const transport = f.native.get(command.target);
      await f.callback(command, kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled', command.target, {
        transportId: transport.serverId,
        [kind === 'producer' ? 'producerId' : 'consumerId']: kind === 'producer' ? allocated.serverProducerId : allocated.serverConsumerId,
        enabled: false, purpose: 'screen',
      });
      return allocated;
    });
    await assert.rejects(kind === 'producer' ? publication(f) : consumption(f), error => hasCode(error, 'RESPONSE'));
    const nativeId = kind === 'producer' ? allocated.producerId : allocated.consumerId;
    const serverId = kind === 'producer' ? allocated.serverProducerId : allocated.serverConsumerId;
    assert.equal(f.native.has(nativeId), false);
    assert.equal(f.server.has(serverId), false);
    assert.equal(f.nativeFor('resource.close').filter(command => command.target === nativeId).length, 1);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('a final native ID that contradicts its tentative callback cannot be trusted or closed as an unrelated handle', async () => {
  const f = fixture();
  let actual;
  f.nativeHooks.set('sfu.consume', async (command, next) => {
    actual = await next();
    return { ...actual, consumerId: actual.consumerId + 10000 };
  });
  await assert.rejects(consumption(f), error => hasCode(error, 'RESPONSE') && hasCode(error, 'OWNERSHIP'));
  assert.equal(f.native.has(actual.consumerId), true);
  assert.equal(f.server.has(actual.serverConsumerId), false);
  assert.equal(f.broker.snapshot().resources.some(record => record.kind === 'consumer' && record.nativeUnknown), true);
  assert.equal(f.nativeFor('resource.close').some(command => command.target === actual.consumerId + 10000), false);
  await assert.rejects(f.broker.close(), AggregateError);
  assertEmpty(f);
  await f.broker.close();
});

test('an initial tentative pause failure may emit a transport-target cleanup without replaying deleted server IDs', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture();
    const operation = kind === 'producer' ? 'sfu.produce' : 'sfu.consume';
    const method = kind === 'producer' ? 'setProducerEnabled' : 'setConsumerEnabled';
    const pauseType = kind === 'producer' ? MessageType.SFU_PRODUCER_SET_PAUSED : MessageType.SFU_CONSUMER_SET_PAUSED;
    f.rpcHooks.set(pauseType, async () => { throw new Error('inert initial server pause failure'); });
    if (kind === 'consumer') f.nativeHooks.set(operation, async (command, next) => {
      try { return await next(); }
      catch (error) {
        const initial = f.events.find(event => event.data.requestId === command.id && event.data.method === method);
        await f.callback(command, method, command.target, initial.data.payload);
        throw error;
      }
    });

    await assert.rejects(kind === 'producer' ? publication(f) : consumption(f), error => hasCode(error, 'NATIVE'));
    const gates = f.events.filter(event => event.data.method === method);
    assert.equal(gates.length, 2);
    assert.notEqual(gates[0].target, gates[1].target);
    assert.equal(gates[1].target, f.nativeFor(operation)[0].target);
    assert.equal(f.calls(pauseType).length, 1);
    assert.equal(f.responses.find(value => value.callbackId === gates[1].data.callbackId).response.ok, true);
    assert.equal(f.broker.tentativeNativeOwners.size, 0);
    f.rpcHooks.clear();
    await f.finishNativeClose();
    assertEmpty(f);
  }
});

test('an acknowledged local transport close also retires a late tentative creation result without replaying its native ID', async () => {
  const f = fixture(), lateResult = deferred();
  let allocated, transportId;
  f.nativeHooks.set('sfu.consume', async (command, next) => {
    transportId = command.target;
    allocated = await next();
    return await lateResult.promise;
  });
  const creating = consumption(f);
  const rejected = assert.rejects(creating, error => hasCode(error, 'STALE'));
  await until(() => allocated);
  const transport = [...f.broker.resources].find(record => record.kind === 'transport' && record.nativeId === transportId);
  await f.broker.closeLocal(transport);
  assert.equal(f.native.has(allocated.consumerId), false);
  assert.equal(f.broker.tentativeNativeOwners.size, 0);
  lateResult.resolve(allocated);
  await rejected;
  assert.equal(f.nativeFor('resource.close').some(command => command.target === allocated.consumerId), false);
  assert.equal(f.server.has(allocated.serverConsumerId), false);
  assert.equal(f.routed.size, 0);
  await f.broker.resetTransport('recv');
  await f.broker.close();
  assertEmpty(f);
});

test('contract3 capability booleans are native data, independent of the fixed video-only broker policy', async () => {
  for (const canProduceAudio of [false, true]) {
    const f = fixture();
    f.nativeHooks.set('sfu.load', async (command, next) => ({ ...await next(), canProduceAudio }));
    const loaded = await f.broker.load();
    assert.equal(loaded.canProduceAudio, canProduceAudio);
    assert.equal(loaded.canProduceVideo, true);
    assert.deepEqual(loaded.rtpCapabilities, NATIVE_CAPS);
    assert.deepEqual(loaded.brokerSupportedMediaTypes, ['screen_video']);
    assert.equal(Object.hasOwn(loaded, 'audioAvailable'), false);
    assert.equal(Object.hasOwn(loaded, 'audioRuntimeQualified'), false);
    const before = f.nativeCalls.length;
    assert.throws(() => f.broker.registerSource({ sourceId: 1000, shareId: 'audio', syncGroup: 'audio-group',
      kind: 'audio', mediaType: 'screen_audio' }), error => hasCode(error, 'UNSUPPORTED_MEDIA'));
    assert.throws(() => f.broker.registerRemoteProducer({ channelId: CHANNEL, producerId: 'remote-audio',
      producerSessionId: 'publisher-remote', kind: 'audio', appData: { mediaType: 'screen_audio', shareId: 'audio' } },
    'audio-group'), error => hasCode(error, 'UNSUPPORTED_MEDIA'));
    assert.equal(f.nativeCalls.length, before);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('legacy and malformed load DTOs fail without fallback while preserving the allocated device for cleanup', async () => {
  const changes = [
    data => { delete data.canProduceAudio; data.audioAvailable = false; },
    data => { delete data.canProduceAudio; },
    data => { data.canProduceAudio = 'true'; },
    data => { data.canProduceAudio = null; },
    data => { delete data.canProduceVideo; },
    data => { data.audioAvailable = true; },
  ];
  for (const change of changes) {
    const f = fixture();
    let allocated;
    f.nativeHooks.set('sfu.load', async (command, next) => {
      allocated = await next();
      const invalid = structuredClone(allocated);
      change(invalid);
      return invalid;
    });
    await assert.rejects(f.broker.load(), error => hasCode(error, 'RESPONSE'));
    assert.deepEqual(f.nativeFor('resource.close').map(command => command.target), [allocated.deviceId]);
    assert.equal(f.calls(MessageType.SFU_CREATE_WEBRTC_TRANSPORT).length, 0);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('contract3 publish/consume metadata is returned without inventing kind, group, MID or track identity', async () => {
  const f = fixture();
  const producer = await publication(f);
  const consumer = await consumption(f);
  assert.equal(producer.kind, 'video');
  assert.equal(producer.syncGroup, localGroup(1000));
  assert.equal(consumer.kind, 'video');
  assert.equal(consumer.syncGroup, remoteGroup('remote-video-one'));
  assert.equal(consumer.mid, String(consumer.consumerId));
  assert.equal(consumer.trackId, consumer.serverConsumerId);
  assert.equal(producer.enabled, false);
  assert.equal(consumer.enabled, false);
  assert.equal(f.calls(MessageType.SFU_PRODUCE).every(call => call.payload.kind === 'video'
    && call.payload.appData.mediaType === 'screen_video'), true);
  assert.equal(f.nativeFor('sfu.consume').every(command => command.data.kind === 'video'
    && command.data.appData.mediaType === 'screen_video'), true);
  await f.broker.close();
  assertEmpty(f);
});

test('legacy native media results and changed kind/group are rejected before routing with exact-ID cleanup', async () => {
  for (const kind of ['producer', 'consumer']) {
    const changes = [
      data => { delete data.kind; delete data.syncGroup; if (kind === 'consumer') { delete data.mid; delete data.trackId; } },
      data => { data.kind = 'audio'; },
      data => { data.kind = 'camera'; },
      data => { data.syncGroup = 'different-from-the-captured-source'; },
      data => { delete data.syncGroup; },
      data => { data.syncGroup = null; },
    ];
    for (const change of changes) {
      const f = fixture();
      let allocated;
      f.nativeHooks.set(kind === 'producer' ? 'sfu.produce' : 'sfu.consume', async (command, next) => {
        allocated = await next();
        const invalid = structuredClone(allocated);
        change(invalid);
        return invalid;
      });
      await assert.rejects(kind === 'producer' ? publication(f) : consumption(f), error => hasCode(error, 'RESPONSE'));
      const nativeId = kind === 'producer' ? allocated.producerId : allocated.consumerId;
      const serverId = kind === 'producer' ? allocated.serverProducerId : allocated.serverConsumerId;
      assert.equal(f.native.has(nativeId), false);
      assert.equal(f.server.has(serverId), false);
      assert.equal(f.routed.size, 0);
      assert.equal(f.routeCalls.some(call => call.operation === 'register'), false);
      assert.equal(f.nativeFor('resource.close').filter(command => command.target === nativeId).length, 1);
      const closeType = kind === 'producer' ? MessageType.SFU_PRODUCER_CLOSED : MessageType.SFU_CONSUMER_CLOSED;
      assert.deepEqual(f.calls(closeType).map(call => call.payload.producerId ?? call.payload.consumerId), [serverId]);
      await f.broker.close();
      assertEmpty(f);
    }
  }
});

test('invalid contract3 consumer binding metadata never enters the GPU route registry', async () => {
  const changes = [
    data => { delete data.mid; },
    data => { data.mid = null; },
    data => { data.mid = ''; },
    data => { data.mid = 0; },
    data => { data.mid = 'x'.repeat(65); },
    data => { data.mid = 'not a token'; },
    data => { data.mid = 'não-ascii'; },
    data => { delete data.trackId; },
    data => { data.trackId = ''; },
    data => { data.trackId = null; },
    data => { data.trackId = 'x'.repeat(257); },
    data => { data.trackId = 'not a token'; },
    data => { data.trackId = 'não-ascii'; },
    data => { data.trackId = 'remote-video-one'; },
    data => { data.trackId = 'different-server-consumer'; },
  ];
  for (const change of changes) {
    const f = fixture();
    let allocated;
    f.nativeHooks.set('sfu.consume', async (command, next) => {
      allocated = await next();
      const invalid = structuredClone(allocated);
      change(invalid);
      return invalid;
    });
    await assert.rejects(consumption(f), error => hasCode(error, 'RESPONSE'));
    assert.equal(f.native.has(allocated.consumerId), false);
    assert.equal(f.server.has(allocated.serverConsumerId), false);
    assert.equal(f.routeCalls.some(call => call.operation === 'register'), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('kind/group rejection retains failed native/server retirement obligations rather than losing allocated IDs', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture();
    let allocated;
    f.nativeHooks.set(kind === 'producer' ? 'sfu.produce' : 'sfu.consume', async (command, next) => {
      allocated = await next();
      return { ...allocated, kind: 'audio', syncGroup: 'wrong-group' };
    });
    f.nativeHooks.set('resource.close', async () => { throw new Error('inert retained native owner'); });
    const closeType = kind === 'producer' ? MessageType.SFU_PRODUCER_CLOSED : MessageType.SFU_CONSUMER_CLOSED;
    f.rpcHooks.set(closeType, async () => { throw new Error('inert retained server owner'); });
    await assert.rejects(kind === 'producer' ? publication(f) : consumption(f),
      error => hasCode(error, 'RESPONSE') && hasCode(error, 'CLOSE_NATIVE') && hasCode(error, 'RPC'));
    const nativeId = kind === 'producer' ? allocated.producerId : allocated.consumerId;
    const serverId = kind === 'producer' ? allocated.serverProducerId : allocated.serverConsumerId;
    const retained = f.broker.snapshot().resources.find(record => record.kind === kind);
    assert.equal(retained.nativeId, nativeId);
    assert.equal(retained.serverId, serverId);
    assert.equal(retained.nativeOwned, true);
    assert.equal(retained.serverOwned, true);
    assert.equal(f.routed.size, 0);
    f.nativeHooks.clear();
    f.rpcHooks.clear();
    await f.broker.retryCleanup();
    assert.equal(f.native.has(nativeId), false);
    assert.equal(f.server.has(serverId), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('contract3 local video groups are unique and opaque, independently of authenticated share IDs', async () => {
  const f = fixture();
  f.register(1000, 'local-one', 'local-two');
  assert.throws(() => f.register(1001, 'local-two', 'local-two'), error => hasCode(error, 'SOURCE'));
  f.register(1001, 'local-two', 'local-one');
  const [first, second] = await Promise.all([f.broker.publish(1000, ENCODING), f.broker.publish(1001, ENCODING)]);
  assert.equal(first.shareId, 'local-one');
  assert.equal(first.syncGroup, 'local-two');
  assert.equal(second.shareId, 'local-two');
  assert.equal(second.syncGroup, 'local-one');
  assert.deepEqual(f.calls(MessageType.SFU_PRODUCE).map(call => call.payload.appData.shareId), ['local-one', 'local-two']);
  await f.broker.close();
  assertEmpty(f);
});

test('a first Watch can request publication enable while the source is still disabled without retiring the publication', async () => {
  const f = fixture();
  const producer = await publication(f);
  assert.equal(await f.broker.setProducerEnabled(producer.producerId, true), false);
  assert.equal(f.server.get(producer.serverProducerId).paused, true);
  assert.equal(f.native.get(producer.producerId).requestedEnabled, true);
  assert.equal(f.native.get(producer.producerId).effectiveEnabled, false);
  assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, true);
  assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 0);
  const enabledCommand = f.nativeFor('sfu.setProducerEnabled').at(-1);
  const gate = f.events.find(event => event.data.requestId === enabledCommand.id && event.data.method === 'setProducerEnabled');
  assert.equal(enabledCommand.data.enabled, true);
  assert.equal(gate.data.payload.enabled, false);
  assert.equal(f.responses.find(response => response.callbackId === gate.data.callbackId).response.ok, true);
  await f.commands.request('source.setEnabled', 1000, { enabled: true });
  assert.equal(f.server.get(producer.serverProducerId).paused, false);
  assert.equal(f.native.get(producer.producerId).effectiveEnabled, true);
  assert.equal(f.native.has(producer.producerId), true);
  await f.commands.request('source.setEnabled', 1000, { enabled: false });
  assert.equal(f.server.get(producer.serverProducerId).paused, true);
  assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, true);
  assert.equal(f.native.get(producer.producerId).effectiveEnabled, false);
  await f.broker.close();
  assertEmpty(f);
});

test('gate results are native booleans, not invented requestedEnabled echoes or successful contradictory disables', async () => {
  for (const result of [{ enabled: true }, { enabled: 'false' }, { enabled: false, requestedEnabled: false }]) {
    const f = fixture();
    const producer = await publication(f);
    f.nativeHooks.set('sfu.setProducerEnabled', async (command, next) => { await next(); return structuredClone(result); });
    await assert.rejects(f.broker.setProducerEnabled(producer.producerId, false), error => hasCode(error, 'RESPONSE'));
    assert.equal(f.server.has(producer.serverProducerId), false);
    assert.equal(f.native.has(producer.producerId), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('contract3 MID and track identity are the actual reserved/native values, never a producer ID or generated fallback', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture();
    let allocated;
    f.rpcHooks.set(MessageType.SFU_CONSUME, async (call, next) => {
      const result = await next();
      result.rtpParameters.mid = 'selected-video-mid';
      return result;
    });
    f.nativeHooks.set('sfu.consume', async (command, next) => {
      allocated = await next();
      return mismatch ? { ...allocated, mid: 'different-mid' } : allocated;
    });
    const creating = consumption(f);
    if (mismatch) {
      await assert.rejects(creating, error => hasCode(error, 'RESPONSE'));
      assert.equal(f.native.has(allocated.consumerId), false);
      assert.equal(f.server.has(allocated.serverConsumerId), false);
      assert.equal(f.routed.size, 0);
    } else {
      const consumer = await creating;
      assert.equal(consumer.mid, 'selected-video-mid');
      assert.equal(consumer.trackId, consumer.serverConsumerId);
      assert.notEqual(consumer.trackId, consumer.producerId);
    }
    await f.broker.close();
    assertEmpty(f);
  }
});

test('invalid explicit RTP MIDs are rejected before native dispatch and still retire allocated server consumers', async () => {
  for (const mid of [null, '', 0, 'not a token', 'não-ascii', 'x'.repeat(65)]) {
    const f = fixture();
    let allocated;
    f.rpcHooks.set(MessageType.SFU_CONSUME, async (call, next) => {
      allocated = await next();
      allocated.rtpParameters.mid = mid;
      return allocated;
    });
    await assert.rejects(consumption(f), error => hasCode(error, 'DTO'));
    assert.equal(f.nativeFor('sfu.consume').length, 0);
    assert.equal(f.server.has(allocated.id), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('producer effective and consumer requested results must match their own acknowledged native callback states', async () => {
  for (const kind of ['producer', 'consumer']) {
    const f = fixture();
    const resource = kind === 'producer' ? await publication(f) : await consumption(f);
    const operation = kind === 'producer' ? 'sfu.setProducerEnabled' : 'sfu.setConsumerEnabled';
    f.nativeHooks.set(operation, async (command, next) => {
      const result = await next();
      assert.equal(result.enabled, kind === 'consumer');
      return { enabled: !result.enabled };
    });
    await assert.rejects(kind === 'producer' ? f.broker.setProducerEnabled(resource.producerId, true)
      : f.broker.setConsumerEnabled(resource.consumerId, true), error => hasCode(error, 'RESPONSE'));
    assert.equal(f.server.has(kind === 'producer' ? resource.serverProducerId : resource.serverConsumerId), false);
    assert.equal(f.native.has(kind === 'producer' ? resource.producerId : resource.consumerId), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('source requested state does not enable an individually disabled producer or gate an unrelated video consumer', async () => {
  const f = fixture();
  const producer = await publication(f);
  const consumer = await consumption(f);
  assert.equal(await f.broker.setConsumerEnabled(consumer.consumerId, true), true);
  assert.equal(f.server.get(consumer.serverConsumerId).paused, false);
  const sourceResult = await f.commands.request('source.setEnabled', 1000, { enabled: true });
  assert.deepEqual(sourceResult, { enabled: true });
  assert.equal(f.native.get(producer.producerId).requestedEnabled, false);
  assert.equal(f.native.get(producer.producerId).effectiveEnabled, false);
  assert.equal(f.server.get(producer.serverProducerId).paused, true);
  await f.commands.request('source.setEnabled', 1000, { enabled: false });
  assert.equal(f.server.get(consumer.serverConsumerId).paused, false);
  assert.equal(f.native.get(consumer.consumerId).enabled, true);
  await f.broker.close();
  assertEmpty(f);
});

test('review regression: async respond cannot acknowledge an operation still waiting for its native reply', async () => {
  const f = fixture(), response = deferred(), nativeEnded = deferred();
  const producer = await publication(f);
  const respond = f.engine.respond;
  let commandId;
  f.nativeHooks.set('sfu.setProducerEnabled', (command, next) => {
    commandId = command.id;
    return Promise.race([next(), nativeEnded.promise]);
  });
  f.engine.respond = () => response.promise;
  const enabling = f.broker.setProducerEnabled(producer.producerId, true);
  const outcome = enabling.then(value => ({ value }), error => ({ error }));
  try {
    await until(() => commandId && [...f.broker.operations].some(operation =>
      operation.id === commandId && operation.callbacks.size > 0));
    const operation = [...f.broker.operations].find(value => value.id === commandId);
    const callback = [...operation.callbacks.values()][0];
    assert.equal(await callback.task, false);
    assert.notEqual(callback.acknowledged, true);
    assert.ok(f.commands.getPendingRequest(commandId));
    assert.equal(f.server.has(producer.serverProducerId), false);
    response.reject(new Error('inert asynchronous response rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.errors.some(error => hasCode(error, 'RESPOND')), true);
  } finally {
    // The baseline fails before it installs a rejection observer.
    void response.promise.catch(() => {});
    response.reject(new Error('end inert response double'));
    f.engine.respond = respond;
    nativeEnded.reject(new Error('end native operation double'));
    await outcome;
    await f.broker.close();
  }
  assertEmpty(f);
});

test('review regression: replacing the instance close assertion cannot forge private engine retirement', async () => {
  const f = fixture();
  await publication(f);
  const assertion = f.commands.assertEngineClosed;
  f.commands.assertEngineClosed = () => {};
  try {
    await assert.rejects(f.broker.finishAfterEngineClose(Promise.resolve({ closed: true })),
      error => hasCode(error, 'ENGINE_CLOSE'));
    assert.equal(f.broker.snapshot().engineRetired, false);
    assert.equal(f.broker.snapshot().resources.every(record => record.nativeOwned), true);
    assert.equal(f.native.size, 3);
    assert.equal(f.engineCloseCalls.length, 0);
  } finally {
    f.commands.assertEngineClosed = assertion;
    f.native.clear();
    await f.broker.finishAfterEngineClose(f.closeEngineFromController(Promise.resolve({ closed: true })));
  }
  assertEmpty(f);
});

test('review regression: a later queued disable cannot change the intent seen by an earlier source callback', async () => {
  const f = fixture(), deliverSource = deferred();
  const producer = await publication(f);
  assert.equal(await f.broker.setProducerEnabled(producer.producerId, true), false);
  let sourceCommand, queuedDisable;
  f.nativeHooks.set('source.setEnabled', async (command, next) => {
    sourceCommand = command;
    await deliverSource.promise;
    return await next();
  });
  const sourceEnabled = f.commands.request('source.setEnabled', 1000, { enabled: true });
  void sourceEnabled.catch(() => {});
  f.nativeHooks.set('sfu.setProducerEnabled', (command, next) => {
    queuedDisable = command;
    return sourceEnabled.then(next);
  });
  const disabled = f.broker.setProducerEnabled(producer.producerId, false);
  void disabled.catch(() => {});
  try {
    await until(() => queuedDisable);
    assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, true);
    deliverSource.resolve();
    assert.deepEqual(await sourceEnabled, { enabled: true });
    assert.equal(await disabled, false);
    const sourceCallback = f.events.find(event => event.data.requestId === sourceCommand.id);
    assert.equal(sourceCallback.data.payload.enabled, true);
    assert.equal(f.responses.find(value => value.callbackId === sourceCallback.data.callbackId).response.ok, true);
    assert.equal(f.server.get(producer.serverProducerId).paused, true);
    assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, false);
    assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 0);
  } finally {
    deliverSource.resolve();
    await Promise.allSettled([sourceEnabled, disabled]);
    f.nativeHooks.clear();
    await f.broker.close();
  }
  assertEmpty(f);
});

test('review regression: republishing after completed-native gate validation cannot return its retired publication cache', async () => {
  const f = fixture();
  const old = await publication(f);
  f.nativeHooks.set('sfu.setProducerEnabled', async (_command, next) => ({ ...await next(), enabled: 'invalid' }));
  await assert.rejects(f.broker.setProducerEnabled(old.producerId, true));
  f.nativeHooks.clear();
  assert.equal(f.native.has(old.producerId), false);
  assert.equal(f.server.has(old.serverProducerId), false);
  try {
    const first = f.broker.publish(1000, ENCODING), duplicate = f.broker.publish(1000, ENCODING);
    assert.equal(first, duplicate);
    const replacement = await first;
    assert.notEqual(replacement.producerId, old.producerId);
    assert.notEqual(replacement.serverProducerId, old.serverProducerId);
    assert.equal(f.native.has(replacement.producerId), true);
    assert.equal(f.server.has(replacement.serverProducerId), true);
    assert.equal(f.nativeFor('sfu.produce').length, 2);
  } finally { await f.broker.close(); }
  assertEmpty(f);
});

test('non-void and rejecting async error responses are observed without becoming native acknowledgements', async () => {
  const replies = [
    () => Promise.resolve(),
    () => Promise.reject(new Error('private asynchronous response diagnostic')),
    () => ({ then(resolve, reject) { reject(new Error('private thenable response diagnostic')); } }),
    () => Object.defineProperty({}, 'then', { get() { throw new Error('private then getter diagnostic'); } }),
    () => true,
    () => null,
  ];
  for (const reply of replies) {
    const f = fixture();
    f.engine.respond = () => reply();
    assert.equal(await f.broker.handleNativeEvent({ type: 'request', target: 1, data: {
      callbackId: 50001, requestId: 9999, method: 'unknown', payload: {},
    } }), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.errors.some(error => hasCode(error, 'RESPOND')), true);
    assert.equal(f.errors.flatMap(diagnostics).join(' ').includes('private '), false);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('an async shim that delivers then rejects cannot fake success on either successful or failed RPC replies', async () => {
  for (const rpcFails of [false, true]) {
    const f = fixture();
    const producer = await publication(f);
    if (rpcFails) f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async () => { throw new Error('private RPC diagnostic'); });
    const respond = f.engine.respond;
    f.engine.respond = (id, value) => {
      respond(id, value);
      return Promise.reject(new Error('private rejected async response'));
    };
    await assert.rejects(f.broker.setProducerEnabled(producer.producerId, true));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.errors.some(error => hasCode(error, 'RESPOND')), true);
    assert.equal(f.errors.flatMap(diagnostics).join(' ').includes('private '), false);
    assert.equal(f.native.has(producer.producerId), false);
    assert.equal(f.server.has(producer.serverProducerId), false);
    f.engine.respond = respond;
    f.rpcHooks.clear();
    await f.finishNativeClose();
    assertEmpty(f);
  }
});

test('invalid async response admission retains failed server cleanup for retry', async () => {
  const f = fixture();
  const producer = await publication(f);
  const respond = f.engine.respond;
  f.engine.respond = (id, value) => { respond(id, value); return Promise.resolve(); };
  f.rpcHooks.set(MessageType.SFU_PRODUCER_CLOSED, async () => { throw new Error('inert offline cleanup'); });
  f.rpcHooks.set(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, async () => { throw new Error('inert offline transport cleanup'); });
  await assert.rejects(f.broker.setProducerEnabled(producer.producerId, true));
  await until(() => f.calls(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).length > 0);
  await Promise.allSettled([...f.broker.resources].map(record => record.retiring));
  const retained = f.broker.snapshot().resources.find(record => record.kind === 'producer');
  assert.equal(retained.serverId, producer.serverProducerId);
  assert.equal(retained.serverOwned, true);
  assert.equal(retained.nativeOwned, false);
  assert.equal(f.errors.some(error => hasCode(error, 'RESPOND')), true);
  f.engine.respond = respond;
  f.rpcHooks.clear();
  await f.broker.retryCleanup();
  assert.equal(f.server.has(producer.serverProducerId), false);
  await f.broker.close();
  assertEmpty(f);
});

test('private close proof survives instance/prototype replacement and rejects unbranded command adapters', async () => {
  const f = fixture();
  const prototypeAssertion = NativeRtcCommands.prototype.assertEngineClosed;
  for (const commands of [
    { engine: f.engine, request() {}, getPendingRequest() {}, assertEngineClosed() {} },
    Object.create(NativeRtcCommands.prototype),
  ]) assert.throws(() => new NativeSfuBroker({ ...f.options, commands }), error => hasCode(error, 'CONFIG'));
  assert.throws(() => { f.broker.engine = {}; }, TypeError);
  assert.throws(() => { f.broker.commands = {}; }, TypeError);
  await publication(f);
  try {
    NativeRtcCommands.prototype.assertEngineClosed = () => {};
    f.commands.assertEngineClosed = () => {};
    await assert.rejects(f.broker.finishAfterEngineClose(Promise.resolve({ closed: true })),
      error => hasCode(error, 'ENGINE_CLOSE'));
    assert.equal(f.broker.snapshot().engineRetired, false);
    assert.equal(f.native.size, 3);
    f.commands.assertEngineClosed = () => { throw new Error('instance method must not be consulted'); };
    f.native.clear();
    await f.broker.finishAfterEngineClose(f.closeEngineFromController(Promise.resolve({ closed: true })));
    assert.equal(f.broker.snapshot().engineRetired, true);
  } finally {
    NativeRtcCommands.prototype.assertEngineClosed = prototypeAssertion;
    delete f.commands.assertEngineClosed;
    await f.broker.close();
  }
  assertEmpty(f);
});

test('a queued future enable cannot authorize a true callback from an earlier individually disabled source', async () => {
  const f = fixture(), deliverSource = deferred();
  const producer = await publication(f);
  let sourceCommand, queuedEnable;
  f.nativeHooks.set('source.setEnabled', async (command, next) => {
    sourceCommand = command;
    await deliverSource.promise;
    return await next();
  });
  const sourceEnabled = f.commands.request('source.setEnabled', 1000, { enabled: true });
  void sourceEnabled.catch(() => {});
  f.nativeHooks.set('sfu.setProducerEnabled', (command, next) => {
    queuedEnable = command;
    return sourceEnabled.then(next);
  });
  const enabled = f.broker.setProducerEnabled(producer.producerId, true);
  void enabled.catch(() => {});
  try {
    await until(() => queuedEnable);
    const transport = f.native.get(f.native.get(producer.producerId).parent);
    const before = f.rpcCalls.length;
    assert.equal(await f.broker.handleNativeEvent({ type: 'request', target: producer.producerId,
      data: { callbackId: 50002, requestId: sourceCommand.id, method: 'setProducerEnabled', payload: {
        transportId: transport.serverId, producerId: producer.serverProducerId, enabled: true, purpose: 'screen',
      } } }), false);
    assert.equal(f.rpcCalls.length, before);
    assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, false);
    deliverSource.resolve();
    assert.deepEqual(await sourceEnabled, { enabled: true });
    assert.equal(await enabled, true);
    assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, true);
    assert.equal(f.server.get(producer.serverProducerId).paused, false);
  } finally {
    deliverSource.resolve();
    await Promise.allSettled([sourceEnabled, enabled]);
    f.nativeHooks.clear();
    await f.broker.close();
  }
  assertEmpty(f);
});

test('a closing cached publication cannot be reused or duplicated until both exact retirement obligations succeed', async () => {
  for (const failedSide of ['native', 'server']) {
    const f = fixture();
    const old = await publication(f);
    f.nativeHooks.set('sfu.setProducerEnabled', async (_command, next) => ({ ...await next(), enabled: 'invalid' }));
    if (failedSide === 'native') {
      f.nativeHooks.set('resource.close', async (command, next) => {
        if (command.target === old.producerId) throw new Error('retained native publication');
        return await next();
      });
    } else f.rpcHooks.set(MessageType.SFU_PRODUCER_CLOSED, async () => { throw new Error('retained server publication'); });
    await assert.rejects(f.broker.setProducerEnabled(old.producerId, true));
    const before = f.nativeFor('sfu.produce').length;
    await assert.rejects(f.broker.publish(1000, ENCODING), error => hasCode(error, 'RESOURCE'));
    assert.equal(f.nativeFor('sfu.produce').length, before);
    const retained = f.broker.snapshot().resources.find(record => record.kind === 'producer');
    assert.equal(retained[`${failedSide}Owned`], true);
    f.nativeHooks.clear();
    f.rpcHooks.clear();
    await f.broker.retryCleanup();
    const fresh = f.broker.publish(1000, ENCODING);
    assert.equal(fresh, f.broker.publish(1000, ENCODING));
    const replacement = await fresh;
    assert.notEqual(replacement.producerId, old.producerId);
    assert.notEqual(replacement.serverProducerId, old.serverProducerId);
    assert.equal(f.nativeFor('sfu.produce').length, before + 1);
    await f.broker.close();
    assertEmpty(f);
  }
});

test('late retirement of an old transport publication cannot clear the replacement source cache', async () => {
  const f = fixture(), retireOld = deferred();
  const old = await publication(f);
  let waiting = false;
  f.rpcHooks.set(MessageType.SFU_PRODUCER_CLOSED, async (call, next) => {
    if (call.payload.producerId === old.serverProducerId) { waiting = true; await retireOld.promise; }
    return await next();
  });
  const resetting = f.broker.resetTransport('send');
  await until(() => waiting);
  const replacementPromise = f.broker.publish(1000, ENCODING);
  const replacementRecord = f.broker.sources.get(1000).publication;
  assert.equal(replacementRecord.promise, replacementPromise);
  retireOld.resolve();
  await resetting;
  const replacement = await replacementPromise;
  assert.equal(f.broker.sources.get(1000).publication, replacementRecord);
  assert.equal(f.broker.publish(1000, ENCODING), replacementPromise);
  assert.equal(f.native.has(replacement.producerId), true);
  assert.equal(f.server.has(replacement.serverProducerId), true);
  f.rpcHooks.clear();
  await f.broker.close();
  assertEmpty(f);
});

test('FIFO intent regression: source starts after raw producer completion but before downstream intent application', { timeout: 5000 }, async () => {
  const f = fixture(), pauseAck = deferred();
  const fifo = strictNativeFifo(f);
  const producer = await publication(f);
  let waitingForPause = false, sourceAtStart, sourceCommand;
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
    waitingForPause = true;
    await pauseAck.promise;
    return await next();
  });
  f.nativeHooks.set('source.setEnabled', (command, next) => {
    sourceCommand = command;
    sourceAtStart = {
      nativeRequested: f.native.get(producer.producerId).requestedEnabled,
      brokerRequested: f.broker.nativeOwners.get(producer.producerId).requestedEnabled,
    };
    return next();
  });
  const enabling = f.broker.setProducerEnabled(producer.producerId, true);
  void enabling.catch(() => {});
  let sourceEnabled;
  try {
    await until(() => waitingForPause);
    sourceEnabled = f.commands.request('source.setEnabled', 1000, { enabled: true });
    void sourceEnabled.catch(() => {});
    pauseAck.resolve();
    assert.equal(await enabling, false);
    assert.deepEqual(await sourceEnabled, { enabled: true });
    assert.deepEqual(sourceAtStart, { nativeRequested: true, brokerRequested: false });
    const producerCommand = f.nativeFor('sfu.setProducerEnabled')[0];
    assert.ok(producerCommand.id < sourceCommand.id);
    assert.ok(fifo.completed.indexOf(producerCommand.id) < fifo.completed.indexOf(sourceCommand.id));
    const callback = f.events.find(event => event.data.requestId === sourceCommand.id);
    assert.equal(callback.data.payload.enabled, true);
    assert.equal(f.responses.find(value => value.callbackId === callback.data.callbackId).response.ok, true);
    assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, true);
    assert.equal(f.server.get(producer.serverProducerId).paused, false);
  } finally {
    pauseAck.resolve();
    await Promise.allSettled([enabling, sourceEnabled]);
    f.rpcHooks.clear();
    f.nativeHooks.clear();
    await f.broker.close();
  }
  assertEmpty(f);
});

test('raw FIFO opposing gates commit around a source callback without waiting for future setters', { timeout: 5000 }, async () => {
  const f = fixture(), firstAck = deferred();
  strictNativeFifo(f);
  const producer = await publication(f);
  let waiting = false;
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
    if (!waiting) { waiting = true; await firstAck.promise; }
    return await next();
  });
  const first = f.broker.setProducerEnabled(producer.producerId, true);
  void first.catch(() => {});
  await until(() => waiting);
  const sourceEnabled = f.commands.request('source.setEnabled', 1000, { enabled: true });
  const disabled = f.broker.setProducerEnabled(producer.producerId, false);
  const enabledAgain = f.broker.setProducerEnabled(producer.producerId, true);
  for (const pending of [sourceEnabled, disabled, enabledAgain]) void pending.catch(() => {});
  try {
    firstAck.resolve();
    const results = await Promise.all([first, sourceEnabled, disabled, enabledAgain]);
    assert.deepEqual(results, [false, { enabled: true }, false, true]);
    const sourceCommand = f.nativeFor('source.setEnabled')[0];
    const gates = f.nativeFor('sfu.setProducerEnabled');
    assert.ok(gates[0].id < sourceCommand.id);
    assert.ok(gates[1].id > sourceCommand.id);
    assert.ok(gates[2].id > sourceCommand.id);
    assert.equal(f.broker.nativeOwners.get(producer.producerId).requestedEnabled, true);
    assert.equal(f.native.get(producer.producerId).requestedEnabled, true);
    assert.equal(f.server.get(producer.serverProducerId).paused, false);
    assert.equal(f.calls(MessageType.SFU_PRODUCER_CLOSED).length, 0);
  } finally {
    firstAck.resolve();
    await Promise.allSettled([first, sourceEnabled, disabled, enabledAgain]);
    f.rpcHooks.clear();
    await f.broker.close();
  }
  assertEmpty(f);
});

test('failed earlier native result releases its intent barrier without waiting for cleanup behind the source callback', { timeout: 5000 }, async () => {
  const f = fixture(), failedGateAck = deferred(), closeAck = deferred();
  strictNativeFifo(f);
  const producer = await publication(f);
  await f.broker.setProducerEnabled(producer.producerId, true);
  let waitingForGate = false, closeRequested = false;
  f.nativeHooks.set('sfu.setProducerEnabled', async (command, next) => {
    const resource = f.native.get(command.target);
    const previous = { requestedEnabled: resource.requestedEnabled, effectiveEnabled: resource.effectiveEnabled };
    await next();
    Object.assign(resource, previous);
    throw new Error('inert native sender-gate failure');
  });
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
    waitingForGate = true;
    await failedGateAck.promise;
    return await next();
  });
  f.rpcHooks.set(MessageType.SFU_PRODUCER_CLOSED, async (call, next) => {
    closeRequested = true;
    await closeAck.promise;
    return await next();
  });
  const failed = f.broker.setProducerEnabled(producer.producerId, false);
  void failed.catch(() => {});
  await until(() => waitingForGate);
  const sourceEnabled = f.commands.request('source.setEnabled', 1000, { enabled: true });
  void sourceEnabled.catch(() => {});
  try {
    failedGateAck.resolve();
    await until(() => closeRequested);
    const sourceCommand = f.nativeFor('source.setEnabled')[0];
    assert.ok(f.commands.getPendingRequest(sourceCommand.id));
    assert.equal(f.nativeFor('resource.close').length, 0);
    assert.equal(f.calls(MessageType.SFU_PRODUCER_SET_PAUSED).some(call => call.payload.paused === false), false);
    closeAck.resolve();
    await assert.rejects(failed, error => hasCode(error, 'NATIVE'));
    await assert.rejects(sourceEnabled);
    assert.equal(f.native.has(producer.producerId), false);
    assert.equal(f.server.has(producer.serverProducerId), false);
  } finally {
    failedGateAck.resolve();
    closeAck.resolve();
    await Promise.allSettled([failed, sourceEnabled]);
    f.rpcHooks.clear();
    f.nativeHooks.clear();
    await f.finishNativeClose();
  }
  assertEmpty(f);
});

test('scope is rechecked after the raw FIFO intent wait and late callback cleanup retains offline server ownership', { timeout: 5000 }, async () => {
  const f = fixture(), pauseAck = deferred();
  strictNativeFifo(f);
  const producer = await publication(f);
  let waitingForPause = false, stoppedWhileWaiting = false, sourceEvent;
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
    waitingForPause = true;
    await pauseAck.promise;
    return await next();
  });
  f.rpcHooks.set(MessageType.SFU_PRODUCER_CLOSED, async () => { throw new Error('inert offline server'); });
  f.rpcHooks.set(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, async () => { throw new Error('inert offline server transport'); });
  f.nativeHooks.set('source.setEnabled', (command, next) => {
    const raw = next();
    sourceEvent = f.events.find(event => event.data.requestId === command.id);
    queueMicrotask(() => {
      const token = f.broker.callbacks.get(sourceEvent.data.callbackId);
      stoppedWhileWaiting = token?.precedingIntents.length > 0;
      f.scope.current = false;
    });
    return raw;
  });
  const enabling = f.broker.setProducerEnabled(producer.producerId, true);
  void enabling.catch(() => {});
  await until(() => waitingForPause);
  const sourceEnabled = f.commands.request('source.setEnabled', 1000, { enabled: true });
  void sourceEnabled.catch(() => {});
  try {
    pauseAck.resolve();
    await assert.rejects(enabling, error => hasCode(error, 'STALE'));
    await assert.rejects(sourceEnabled);
    assert.equal(stoppedWhileWaiting, true);
    assert.equal(f.calls(MessageType.SFU_PRODUCER_SET_PAUSED).some(call => call.payload.paused === false), false);
    const retained = f.broker.snapshot().resources.find(record => record.kind === 'producer');
    assert.equal(retained.nativeOwned, true);
    assert.equal(retained.serverOwned, true);
    assert.equal(retained.serverId, producer.serverProducerId);
    f.rpcHooks.clear();
    await f.finishNativeClose();
    const before = f.rpcCalls.length;
    assert.equal(await f.broker.handleNativeEvent(sourceEvent), false);
    assert.equal(f.rpcCalls.length, before);
  } finally {
    pauseAck.resolve();
    await Promise.allSettled([enabling, sourceEnabled]);
    f.rpcHooks.clear();
    f.nativeHooks.clear();
    await f.finishNativeClose();
  }
  assertEmpty(f);
});

test('source intent barriers exclude earlier operations belonging to a different producer', { timeout: 5000 }, async () => {
  const f = fixture(), pauseAck = deferred();
  strictNativeFifo(f);
  const one = await publication(f, 1000, 'local-one');
  const two = await publication(f, 1001, 'local-two');
  await f.broker.setProducerEnabled(two.producerId, true);
  let waiting = false, waits = null;
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
    if (call.payload.producerId === one.serverProducerId) { waiting = true; await pauseAck.promise; }
    return await next();
  });
  const run = f.broker.runCallback.bind(f.broker);
  f.broker.runCallback = token => {
    if (token.sourceGate && token.record.nativeId === two.producerId) waits = token.precedingIntents.length;
    return run(token);
  };
  const first = f.broker.setProducerEnabled(one.producerId, true);
  void first.catch(() => {});
  await until(() => waiting);
  const sourceTwo = f.commands.request('source.setEnabled', 1001, { enabled: true });
  void sourceTwo.catch(() => {});
  try {
    pauseAck.resolve();
    assert.equal(await first, false);
    assert.deepEqual(await sourceTwo, { enabled: true });
    assert.equal(waits, 0);
    assert.equal(f.server.get(one.serverProducerId).paused, true);
    assert.equal(f.server.get(two.serverProducerId).paused, false);
  } finally {
    pauseAck.resolve();
    await Promise.allSettled([first, sourceTwo]);
    f.rpcHooks.clear();
    await f.broker.close();
  }
  assertEmpty(f);
});

test('source retirement during intent application rejects the waiting callback and fences unproven transport replacements', { timeout: 5000 }, async () => {
  const f = fixture(), pauseAck = deferred();
  strictNativeFifo(f);
  const producer = await publication(f);
  let waiting = false, removed, sourceEvent, removedWhileWaiting = false;
  f.rpcHooks.set(MessageType.SFU_PRODUCER_SET_PAUSED, async (call, next) => {
    waiting = true;
    await pauseAck.promise;
    return await next();
  });
  f.nativeHooks.set('source.setEnabled', (command, next) => {
    const raw = next();
    sourceEvent = f.events.find(event => event.data.requestId === command.id);
    queueMicrotask(() => {
      const token = f.broker.callbacks.get(sourceEvent.data.callbackId);
      removedWhileWaiting = token?.precedingIntents.length > 0;
      removed = f.broker.removeSource(1000);
      void removed.catch(() => {});
    });
    return raw;
  });
  const enabling = f.broker.setProducerEnabled(producer.producerId, true);
  void enabling.catch(() => {});
  await until(() => waiting);
  const sourceEnabled = f.commands.request('source.setEnabled', 1000, { enabled: true });
  void sourceEnabled.catch(() => {});
  try {
    pauseAck.resolve();
    await assert.rejects(enabling, error => hasCode(error, 'STALE'));
    await assert.rejects(sourceEnabled);
    await assert.rejects(removed, error => hasCode(error, 'CLOSE_NATIVE'));
    assert.equal(removedWhileWaiting, true);
    assert.equal(f.calls(MessageType.SFU_PRODUCER_SET_PAUSED).some(call => call.payload.paused === false), false);
    assert.equal(f.native.has(producer.producerId), false);
    assert.equal(f.server.has(producer.serverProducerId), false);
    f.rpcHooks.clear();
    f.nativeHooks.clear();
    await assert.rejects(publication(f, 1001), error => hasCode(error, 'CLOSE_NATIVE'));
    assert.equal(f.nativeFor('sfu.produce').length, 1);
    const before = f.rpcCalls.length;
    assert.equal(await f.broker.handleNativeEvent(sourceEvent), false);
    assert.equal(f.rpcCalls.length, before);
  } finally {
    pauseAck.resolve();
    await Promise.allSettled([enabling, sourceEnabled, removed]);
    f.rpcHooks.clear();
    f.nativeHooks.clear();
    await f.finishNativeClose();
  }
  assertEmpty(f);
});
