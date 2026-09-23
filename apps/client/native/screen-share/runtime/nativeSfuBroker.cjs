'use strict';

const { isDeepStrictEqual, types: { isPromise } } = require('node:util');
const { NativeRtcCommands, isNativeRtcCommandsForEngine, assertNativeRtcEngineClosed } = require('./nativeRtcCommands.cjs');
const { isNativeAudioReceiveAdapterForEngine, nativeAudioSfuReceiveHooks } = require('./nativeAudioReceiveAdapter.cjs');
const nativeContract = require('./nativeRtc/engine/contract.json');
const requiredAudioCapabilities = Object.freeze({
  abiVersion: nativeContract.abiVersion, contractRevision: nativeContract.contractRevision,
  audioExtensionVersion: nativeContract.audioExtensionVersion, audioAvailable: true,
  ...nativeContract.requiredCompiledCapabilities,
});
const {
  MessageType, messageReferenceSchema, screenShareIdSchema, sfuMediaAppDataSchema, sfuConsumeSchema,
  sfuCreateWebRtcTransportSchema, nativeScreenRenditionSchema,
} = require('@monky/shared');

const brokerError = Symbol('native-sfu-broker-error');
const audioBrokers = new WeakSet();
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const reference = value => messageReferenceSchema.safeParse(value).success;
const shareReference = value => screenShareIdSchema.safeParse(value).success;
const text = (value, maximum = 256) => typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0');
const mediaToken = (value, maximum) => typeof value === 'string'
  && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => object(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const shareKey = (publisherSessionId, shareId) => JSON.stringify([publisherSessionId, shareId]);

function failure(code, message) {
  const error = new Error(message);
  error.code = `ERR_NATIVE_SFU_${code}`;
  error[brokerError] = true;
  return error;
}

function requireValue(condition, code, message) {
  if (!condition) throw failure(code, message);
}

function aggregate(errors, message) {
  const error = new AggregateError([...new Set(errors)], message);
  error.code = 'ERR_NATIVE_SFU_CLEANUP';
  error[brokerError] = true;
  return error;
}

// Neither native callbacks nor legacy server response types are a JSON schema.
// Copy only bounded data properties, never invoke getters or retain mutable DTOs.
function json(value) {
  let remaining = 1024 * 1024, nodes = 20000;
  const copy = (item, depth) => {
    requireValue(depth <= 20 && --nodes >= 0, 'DTO', 'SFU JSON exceeds its structural limit.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      remaining -= Buffer.byteLength(item, 'utf8');
      requireValue(remaining >= 0, 'DTO', 'SFU JSON exceeds its byte limit.');
      return item;
    }
    requireValue(Array.isArray(item) || object(item), 'DTO', 'SFU data must contain only JSON values.');
    requireValue(Object.getOwnPropertySymbols(item).length === 0, 'DTO', 'SFU JSON cannot contain symbols.');
    if (Array.isArray(item)) {
      requireValue(item.length <= 20000, 'DTO', 'SFU JSON array exceeds its limit.');
      return Array.from({ length: item.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        requireValue(property && Object.hasOwn(property, 'value'), 'DTO', 'SFU JSON cannot contain accessors or holes.');
        return copy(property.value, depth + 1);
      });
    }
    const result = {};
    for (const key of Object.keys(item)) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      requireValue(Object.hasOwn(property, 'value'), 'DTO', 'SFU JSON cannot contain accessors.');
      remaining -= Buffer.byteLength(key, 'utf8');
      requireValue(remaining >= 0, 'DTO', 'SFU JSON exceeds its byte limit.');
      Object.defineProperty(result, key, { value: copy(property.value, depth + 1), enumerable: true,
        configurable: true, writable: true });
    }
    return result;
  };
  return copy(value, 0);
}

function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function video(kind, mediaType) {
  requireValue(kind === 'video' && mediaType === 'screen_video', 'UNSUPPORTED_MEDIA',
    'This native SFU broker supports screen video only; audio, microphone and camera have no fallback.');
}

function screenMedia(kind, mediaType, audioEnabled) {
  if (audioEnabled && kind === 'audio' && mediaType === 'screen_audio') return;
  video(kind, mediaType);
}

function audioCapabilities(value) {
  return object(value) && Object.entries(requiredAudioCapabilities).every(([key, expected]) => own(value, key) === expected);
}

function capabilities(value) {
  const parsed = sfuConsumeSchema.shape.rtpCapabilities.safeParse(json(value));
  requireValue(parsed.success && Array.isArray(parsed.data.codecs) && parsed.data.codecs.length > 0,
    'DTO', 'SFU RTP capabilities are malformed.');
  for (const codec of parsed.data.codecs) {
    requireValue(codec.mimeType.toLowerCase().startsWith(`${codec.kind}/`), 'DTO', 'SFU codec kind is inconsistent.');
  }
  return parsed.data;
}

function dtls(value) {
  const data = json(value);
  const lengths = { 'sha-1': 20, 'sha-224': 28, 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 };
  requireValue(object(data) && (data.role === undefined || ['auto', 'client', 'server'].includes(data.role))
    && Array.isArray(data.fingerprints) && data.fingerprints.length > 0 && data.fingerprints.length <= 32,
  'DTO', 'SFU DTLS parameters are malformed.');
  let strong = false;
  for (const fingerprint of data.fingerprints) {
    const size = own(lengths, fingerprint?.algorithm);
    requireValue(object(fingerprint) && size && typeof fingerprint.value === 'string'
      && new RegExp(`^(?:[A-Fa-f0-9]{2}:){${size - 1}}[A-Fa-f0-9]{2}$`, 'u').test(fingerprint.value),
    'DTO', 'SFU DTLS fingerprint is malformed.');
    strong ||= size >= 32;
  }
  requireValue(strong, 'DTO', 'SFU DTLS requires an advertised SHA-256 or stronger fingerprint.');
  return data;
}

function transportOptions(value) {
  const data = json(value);
  requireValue(object(data) && reference(data.id) && object(data.iceParameters)
    && text(data.iceParameters.usernameFragment) && text(data.iceParameters.password)
    && (data.iceParameters.iceLite === undefined || typeof data.iceParameters.iceLite === 'boolean')
    && Array.isArray(data.iceCandidates) && data.iceCandidates.length > 0 && data.iceCandidates.length <= 64,
  'DTO', 'SFU transport ICE parameters are malformed.');
  for (const candidate of data.iceCandidates) {
    requireValue(object(candidate) && text(candidate.foundation) && ['udp', 'tcp'].includes(candidate.protocol)
      && Number.isInteger(candidate.priority) && candidate.priority >= 0 && candidate.priority <= 0xffffffff
      && Number.isInteger(candidate.port) && candidate.port > 0 && candidate.port <= 65535
      && ['host', 'srflx', 'prflx', 'relay'].includes(candidate.type)
      && text(candidate.ip ?? candidate.address)
      && (candidate.ip === undefined || candidate.address === undefined || candidate.ip === candidate.address)
      && (candidate.tcpType === undefined || ['active', 'passive', 'so'].includes(candidate.tcpType)),
    'DTO', 'SFU ICE candidate is malformed.');
  }
  return {
    id: data.id, iceParameters: data.iceParameters, iceCandidates: data.iceCandidates,
    dtlsParameters: dtls(data.dtlsParameters),
  };
}

function rtp(value, kind = 'video') {
  const data = json(value);
  requireValue(object(data) && Array.isArray(data.codecs) && data.codecs.length > 0 && data.codecs.length <= 128
    && (data.mid === undefined || mediaToken(data.mid, 64))
    && (data.encodings === undefined || (Array.isArray(data.encodings) && data.encodings.length <= 64))
    && (data.headerExtensions === undefined || (Array.isArray(data.headerExtensions) && data.headerExtensions.length <= 64))
    && (data.rtcp === undefined || object(data.rtcp)), 'DTO', 'SFU video RTP parameters are malformed.');
  for (const codec of data.codecs) {
    requireValue(object(codec) && text(codec.mimeType, 128), 'DTO', 'SFU RTP codec is malformed.');
    if (kind === 'video') video(codec.mimeType.toLowerCase().startsWith('video/') ? 'video' : 'audio', 'screen_video');
    else requireValue(codec.mimeType.toLowerCase() === 'audio/opus' && codec.clockRate === 48000 && codec.channels === 2,
      'UNSUPPORTED_MEDIA', 'Native SFU screen audio requires the actual Opus 48kHz stereo RTP parameters.');
    requireValue(Number.isInteger(codec.payloadType) && codec.payloadType >= 0 && codec.payloadType <= 127
      && positiveId(codec.clockRate) && (kind === 'audio' || codec.channels === undefined)
      && (codec.parameters === undefined || object(codec.parameters))
      && (codec.rtcpFeedback === undefined || (Array.isArray(codec.rtcpFeedback) && codec.rtcpFeedback.length <= 32)),
    'DTO', 'SFU video RTP codec fields are malformed.');
    for (const parameter of Object.values(codec.parameters ?? {})) {
      requireValue((typeof parameter === 'number' && Number.isFinite(parameter))
        || (typeof parameter === 'string' && parameter.length <= 1024), 'DTO', 'SFU RTP codec parameter is malformed.');
    }
    for (const feedback of codec.rtcpFeedback ?? []) {
      requireValue(object(feedback) && typeof feedback.type === 'string' && feedback.type.length <= 64
        && (feedback.parameter === undefined || (typeof feedback.parameter === 'string' && feedback.parameter.length <= 128)),
      'DTO', 'SFU RTP feedback is malformed.');
    }
  }
  for (const entry of data.encodings ?? []) {
    requireValue(object(entry) && (entry.ssrc === undefined || (positiveId(entry.ssrc) && entry.ssrc <= 0xffffffff))
      && (entry.rid === undefined || text(entry.rid))
      && (entry.codecPayloadType === undefined || (Number.isInteger(entry.codecPayloadType)
        && entry.codecPayloadType >= 0 && entry.codecPayloadType <= 127))
      && (entry.rtx === undefined || (object(entry.rtx) && positiveId(entry.rtx.ssrc) && entry.rtx.ssrc <= 0xffffffff)),
    'DTO', 'SFU video RTP encoding is malformed.');
  }
  for (const extension of data.headerExtensions ?? []) {
    requireValue(object(extension) && text(extension.uri, 512) && Number.isInteger(extension.id)
      && extension.id > 0 && extension.id <= 255
      && (extension.encrypt === undefined || typeof extension.encrypt === 'boolean'),
    'DTO', 'SFU video RTP header extension is malformed.');
  }
  if (data.rtcp) {
    requireValue((data.rtcp.cname === undefined || text(data.rtcp.cname))
      && (data.rtcp.reducedSize === undefined || typeof data.rtcp.reducedSize === 'boolean')
      && (data.rtcp.mux === undefined || typeof data.rtcp.mux === 'boolean'), 'DTO', 'SFU RTP control fields are malformed.');
  }
  return data;
}

function encoding(value, kind = 'video') {
  if (kind === 'audio') {
    requireValue(exact(value, ['maxBitrateBps']) && Number.isInteger(value.maxBitrateBps)
      && value.maxBitrateBps >= 6000 && value.maxBitrateBps <= 510000,
    'DTO', 'Native SFU audio requires an explicit 6000..510000 bitrate and no video settings.');
    return { maxBitrateBps: value.maxBitrateBps };
  }
  if (value?.kind !== undefined || value?.mediaType !== undefined) {
    video(value.kind ?? 'video', value.mediaType ?? 'screen_video');
  }
  requireValue(exact(value, ['maxBitrateBps', 'maxFramerate'])
    && Number.isInteger(value.maxBitrateBps) && value.maxBitrateBps > 0 && value.maxBitrateBps <= 1000000000
    && Number.isInteger(value.maxFramerate) && value.maxFramerate > 0 && value.maxFramerate <= 240,
  'DTO', 'Native SFU requires bounded, explicit video encoding settings.');
  return { maxBitrateBps: value.maxBitrateBps, maxFramerate: value.maxFramerate };
}

/**
 * One Main-side screen call instance; video-only unless explicitly configured
 * with a genuine NativeAudioReceiveAdapter, revision7 compiled capabilities,
 * callId/connectionId/generation and dedicated isAudioWatchCurrent and
 * isAudioPublicationCurrent observers. No output selection/start is implicit.
 *
 * Audio additions:
 * - registerAudioSource({sourceId,screenAudioShareId,syncGroup}) associates the
 *   sole continuous PCM source with one registered video. publishAudio(id,
 *   {maxBitrateBps},signal?) starts disabled; only authenticated audio demand may enable.
 *   syncAudioProducer(id) applies the current aggregate authenticated demand.
 *   closeAudioProducer(nativeId) retires only that publication, retaining PCM.
 * - Audio registerRemoteProducer/consume use the same server schemas, with
 *   appData:{mediaType:'screen_audio',shareId}. Its trusted group must match a
 *   registered video from that publisher. Video and audio have separate routes;
 *   the latter uses only the output adapter, never NativeScreenRoutes.
 * - isAudioWatchCurrent(publisher,share,watchVersion) authorizes THAT audio
 *   association independently of video Watch/call deafen. setAudioMuted(id,bool)
 *   and setConsumerVolume(id,0..2) affect only that owned watched audio consumer.
 * - The adapter captures E before sfu.consume, including paused creation, and
 *   that same proof/E guards every activation. No admission failure is retried.
 * - rebindAudioSource(id,{screenAudioShareId,syncGroup,signal?}) retires the old
 *   native AND server producer before calling rebindAudioSourceGroup(context).
 *   The hook returns the actual {sourceId,syncGroup} ACK; republish explicitly.
 *   It never changes a live sender MSID, pauses PCM or chooses another screen.
 * The controller supplies an already-ready engine;
 * this module never loads addons, owns capture sources, or closes the engine.
 * commands must be a NativeRtcCommands instance privately bound to that engine.
 *
 * rpc resolves the correlated response PAYLOAD and must stay bound to this
 * authenticated session even during late cleanup. It must not use whichever
 * foreground connection happens to exist when a Promise settles.
 * registerSource/registerRemoteProducer are trusted roster/controller entry
 * points, not renderer IPC handlers. syncGroup is not a share identity.
 * routes implements NativeScreenRoutes.registerConsumer/removeConsumer.
 *
 * Controller API:
 * - registerSource({sourceId, shareId, syncGroup}); publish(sourceId,
 *   {maxBitrateBps,maxFramerate}) -> {producerId,serverProducerId,sourceId,
 *   shareId,kind:'video',syncGroup,enabled:false}. At most two live sources
 *   with distinct opaque video groups; 64 never-reused registrations per call.
 *   Concurrent/live publication requests coalesce. A retired publication can
 *   be recreated only after its exact native and server obligations retire;
 *   an unacknowledged failure must first complete retryCleanup().
 * - registerRemoteProducer(authenticatedNotification, trustedSyncGroup);
 *   consume(serverProducerId, watchVersion) -> disabled, already-routed
 *   {consumerId,serverConsumerId,producerId,publisherSessionId,shareId,
 *   watchVersion,kind:'video',syncGroup,mid,trackId,enabled:false}. MID/trackId
 *   are validated actual native bindings; MID is never null.
 * - setProducerEnabled(nativeId, boolean) / setConsumerEnabled(nativeId,
 *   boolean) wait for the native operation AND its correlated server ACK.
 *   They return the native enabled value unchanged, not the caller's boolean.
 *   Producer enabled is effective (requested && source enabled), so fulfilled
 *   false does not discard requested true. Consumer success equals its request
 *   and is independent of a local source gate. Both must match their server ACK.
 *   Source cascades await intent application for earlier correlated producer
 *   request IDs only, never a later queued setter or an operation's cleanup.
 * - handleNativeEvent(event) must run directly, outside command/control queues.
 *   engine.respond is synchronous void admission. Thenables/non-void returns
 *   are rejected and their rejections observed, never promoted into an ACK.
 *   The original native request Promise still proves operation completion.
 * - stopWatching(publisherSessionId, shareId, watchVersion) retires only that
 *   generation. Invalidate the controller's Watch/presentation route first.
 * - removeSource(sourceId) retires publications, never the capture source.
 *   Await this before the capture owner attempts source.close.
 * - load() / createTransport(direction) are lazy and single-flight;
 *   load returns the actual native rtpCapabilities/canProduceVideo/canProduceAudio
 *   router intersection, including advertised Opus. brokerSupportedMediaTypes
 *   is separately ['screen_video'] or the explicitly configured
 *   ['screen_video','screen_audio']; router capability alone is not broker
 *   permission or a hardware qualification. audioPublicationEnabled describes
 *   the opt-in compiled A/V path, not a canProduceAudio result or output health.
 *   closeTransport(nativeId) closes only that owned screen transport;
 *   resetTransport(direction) also cancels an in-flight direction reservation.
 *   A replacement waits for the old direction's acknowledged cleanup, since
 *   the existing server otherwise deletes that direction on CREATE dispatch.
 * - removeRemoteProducer({channelId,producerId}) retires only OUR consumers.
 * - retryCleanup() retries retained closing records without touching current
 *   replacements. close() permanently invalidates this call and is retryable.
 *   snapshot() contains IDs/ownership only, never ICE credentials or RTP/SDP.
 * - finishAfterEngineClose(commandsClosePromise) awaits commands.closeEngine()
 *   and requires the helper's captured private-state proof, then retires only native
 *   ownership and retries remote cleanup. The controller calls closeEngine()
 *   AFTER draining presentation/capture leases; JSON/ACK or a fabricated
 *   resolved Promise cannot establish the command registry's private proof.
 *   This broker does not close that engine.
 *
 * A successful ancestor close ACK proves its descendants retired. A failed
 * close or malformed allocation ID does not: unresolved obligations remain
 * visible and failures aggregate. The controller still owns presentation/input
 * lease drainage, capture, connection authentication and the global engine.
 * Producer failures after native dispatch can destroy their entire send
 * transport, including other videos/audio. Invalidate that tree without
 * inferring native retirement from the failure or from NOT_FOUND on cleanup.
 *
 * Confirmed revision-2 callback targets: connect/produce use the native
 * transport; producer/consumer gates use their native resource, including the
 * tentative ID before creation completes. source.setEnabled targets each
 * native producer. Failed-create pause cleanup alone uses the transport target
 * with enabled:false; it may outlive the local transport, but must match the
 * active original create command and its exact owned server reservation.
 * NativeRtcCommands may expose a validated own Promise.requestId property for
 * eager cancellation before the first callback. Without it, callbacks provide
 * IDs for cancellation and all other late native results are awaited/retired.
 */
class NativeSfuBroker {
  constructor({ engine, commands, rpc, channelId, publisherSessionId, isCurrent, isWatchCurrent, routes, onError,
    maximumResources = 32, maximumPendingOperations = 64, maximumRemoteProducers = 64,
    audio = null, callId, connectionId, generation, nativeCapabilities = null,
    isAudioWatchCurrent = null, isAudioPublicationCurrent = null, rebindAudioSourceGroup = null,
    screenSessionId } = {}) {
    requireValue(typeof engine?.respond === 'function' && typeof engine?.cancel === 'function'
      && typeof commands?.request === 'function' && typeof commands?.getPendingRequest === 'function'
      && commands instanceof NativeRtcCommands && isNativeRtcCommandsForEngine(commands, engine) && commands.engine === engine
      && typeof rpc === 'function' && reference(channelId) && reference(publisherSessionId)
      && typeof isCurrent === 'function' && typeof isWatchCurrent === 'function'
      && typeof routes?.registerConsumer === 'function' && typeof routes?.removeConsumer === 'function'
      && typeof onError === 'function', 'CONFIG', 'Native SFU requires an immutable authenticated call and its adapters.');
    for (const value of [maximumResources, maximumPendingOperations, maximumRemoteProducers]) {
      requireValue(Number.isInteger(value) && value >= 1 && value <= 64, 'CONFIG', 'Native SFU limits must be between 1 and 64.');
    }
    requireValue(sfuCreateWebRtcTransportSchema.safeParse({
      channelId, direction: 'send', purpose: 'screen', screenSessionId,
    }).success, 'CONFIG', 'Native SFU requires a valid screen engine identity.');
    requireValue(audio === null || (isNativeAudioReceiveAdapterForEngine(audio, engine, callId, channelId)
      && reference(callId) && reference(connectionId) && positiveId(generation) && audioCapabilities(nativeCapabilities)
      && typeof isAudioWatchCurrent === 'function' && typeof isAudioPublicationCurrent === 'function'
      && (rebindAudioSourceGroup === null || typeof rebindAudioSourceGroup === 'function')),
    'CONFIG', 'Native SFU audio requires its genuine same-engine receive adapter, revision7 capabilities and dedicated audio authorization.');
    Object.defineProperties(this, {
      engine: { value: engine }, commands: { value: commands },
      scope: { value: Object.freeze({ channelId, publisherSessionId }) },
      screenSessionId: { value: screenSessionId },
      isCurrent: { value: isCurrent }, isWatchCurrent: { value: isWatchCurrent },
      audio: { value: audio }, audioPublicationEnabled: { value: audio !== null, enumerable: true },
      audioHooks: { value: audio === null ? null : nativeAudioSfuReceiveHooks(audio, engine, callId, channelId) },
      audioScope: { value: Object.freeze({ callId, connectionId, generation }) },
      isAudioWatchCurrent: { value: isAudioWatchCurrent }, isAudioPublicationCurrent: { value: isAudioPublicationCurrent },
      rebindAudioSourceGroup: { value: rebindAudioSourceGroup },
    });
    if (audio !== null) audioBrokers.add(this);
    Object.assign(this, { rpc, routes, onError, maximumResources, maximumPendingOperations, maximumRemoteProducers });
    this.sources = new Map();
    this.sourceHistory = new Set();
    this.remoteProducers = new Map();
    this.activeConsumers = new Map();
    this.watchVersions = new Map();
    this.resources = new Set();
    this.nativeOwners = new Map();
    this.tentativeNativeOwners = new Map();
    this.serverOwners = new Map();
    this.operations = new Set();
    this.nativeRetirementWaiters = new Set();
    this.engineRetired = false;
    this.engineCloseProof = null;
    this.callbacks = new Map();
    this.externalRequests = new Map();
    this.transports = new Map();
    this.device = null;
    this.closed = false;
    this.closing = null;
    this.pendingRpc = 0;
    this.reportedErrors = new WeakSet();
    this.observerFailures = 0;
  }

  report(error) {
    if (!error?.[brokerError]) error = failure('ADAPTER', 'A native SFU adapter failed without a safe diagnostic.');
    if (error?.code === 'ERR_NATIVE_SFU_STALE' || this.reportedErrors.has(error)) return;
    this.reportedErrors.add(error);
    try { this.onError(error); }
    catch { this.observerFailures++; }
  }

  assertCurrent() {
    let current = false;
    try { current = this.isCurrent() === true; }
    catch { throw failure('SCOPE', 'The native SFU call epoch observer failed.'); }
    requireValue(!this.closed && current, 'STALE', 'The native SFU call instance is no longer current.');
  }

  assertRecord(record) {
    this.assertCurrent();
    requireValue(!record.closing && !record.nativeRetired && !record.serverRetired,
      'STALE', 'The native SFU resource is being retired.');
    if (record.parent) requireValue(!record.parent.closing && !record.parent.nativeRetired && !record.parent.serverRetired,
      'STALE', 'The native SFU parent is being retired.');
    if (record.kind === 'producer') {
      requireValue(this.sources.get(record.source.sourceId) === record.source && !record.source.closing,
        'STALE', 'The native SFU source is no longer registered.');
      if (record.source.kind === 'audio') this.assertAudioSource(record.source);
    }
    if (record.kind === 'consumer') {
      let watching = false;
      try {
        watching = this.isWatchCurrent(record.remote.producerSessionId, record.remote.shareId, record.watchVersion) === true;
      } catch { throw failure('SCOPE', 'The native SFU Watch observer failed.'); }
      requireValue(this.remoteProducers.get(record.remote.producerId) === record.remote
        && this.activeConsumers.get(record.key) === record && watching,
      'STALE', 'The native SFU consumer does not belong to the current explicit Watch.');
      if (record.remote.kind === 'audio') this.assertAudioWatch(record.remote, record.watchVersion);
    }
  }

  registerSource(value) {
    this.assertCurrent();
    video(value?.kind ?? 'video', value?.mediaType ?? 'screen_video');
    requireValue(object(value) && Object.keys(value).every(key =>
      ['sourceId', 'shareId', 'syncGroup', 'kind', 'mediaType', 'nativeScreen'].includes(key))
      && positiveId(value.sourceId) && shareReference(value.shareId) && text(value.syncGroup)
      && !this.sourceHistory.has(value.sourceId) && !this.nativeOwners.has(value.sourceId)
      && !this.tentativeNativeOwners.has(value.sourceId)
      && ![...this.sources.values()].some(source => source.kind === 'video' && (source.syncGroup === value.syncGroup
        || (source.shareId === value.shareId && !source.closing))),
    'SOURCE', 'Native SFU source registration is invalid or duplicated.');
    requireValue([...this.sources.values()].filter(source => source.kind === 'video').length < 2
      && this.resources.size + this.sources.size < this.maximumResources,
      'LIMIT', 'Native SFU permits at most two bounded local screen sources.');
    requireValue(this.sourceHistory.size < 64, 'LIMIT', 'Native SFU source identity history is full for this call instance.');
    const nativeScreen = value.nativeScreen === undefined ? null : nativeScreenRenditionSchema.safeParse(json(value.nativeScreen));
    requireValue(nativeScreen === null || (nativeScreen.success && nativeScreen.data.pipelineId === this.screenSessionId
      && nativeScreen.data.sourceInstanceId === value.syncGroup),
    'SOURCE', 'Native SFU rendition metadata must match its registered source and engine.');
    const source = {
      sourceId: value.sourceId, shareId: value.shareId, syncGroup: value.syncGroup, kind: 'video',
      nativeScreen: nativeScreen?.data,
      closing: false, publications: new Set(), publication: null,
    };
    this.sources.set(source.sourceId, source);
    this.sourceHistory.add(source.sourceId);
    return Object.freeze({ sourceId: source.sourceId, shareId: source.shareId, syncGroup: source.syncGroup });
  }

  registerAudioSource(value) {
    this.assertCurrent();
    const associatedVideo = [...this.sources.values()].find(source => source.kind === 'video'
      && !source.closing && source.shareId === value?.screenAudioShareId && source.syncGroup === value?.syncGroup);
    requireValue(this.audioPublicationEnabled && exact(value, ['sourceId', 'screenAudioShareId', 'syncGroup'])
      && positiveId(value.sourceId) && shareReference(value.screenAudioShareId) && text(value.syncGroup)
      && associatedVideo && ![...this.sources.values()].some(source => source.kind === 'audio')
      && !this.sourceHistory.has(value.sourceId) && !this.nativeOwners.has(value.sourceId)
      && !this.tentativeNativeOwners.has(value.sourceId),
    'SOURCE', 'Native SFU audio requires one existing continuous PCM source and its explicit active screen association.');
    requireValue(this.resources.size + this.sources.size < this.maximumResources && this.sourceHistory.size < 64,
      'LIMIT', 'Native SFU source identity or resource limit reached.');
    const source = { sourceId: value.sourceId, shareId: value.screenAudioShareId, syncGroup: value.syncGroup,
      kind: 'audio', associatedVideo, closing: false, publications: new Set(), publication: null, rebinding: null };
    this.sources.set(source.sourceId, source);
    this.sourceHistory.add(source.sourceId);
    return Object.freeze({ sourceId: source.sourceId, screenAudioShareId: source.shareId, syncGroup: source.syncGroup });
  }

  assertAudioSource(source) {
    const videoSource = source.associatedVideo;
    requireValue(this.audioPublicationEnabled && !source.rebinding && videoSource?.kind === 'video' && !videoSource.closing
      && this.sources.get(videoSource.sourceId) === videoSource && videoSource.shareId === source.shareId
      && videoSource.syncGroup === source.syncGroup,
    'STALE', 'Native SFU audio no longer has its exact active screen association.');
  }

  assertAudioWatch(remote, watchVersion) {
    let watching = false;
    try { watching = this.isAudioWatchCurrent(remote.producerSessionId, remote.shareId, watchVersion) === true; }
    catch { throw failure('SCOPE', 'The dedicated native SFU audio Watch observer failed.'); }
    const videoProducer = this.remoteProducers.get(remote.videoProducerId);
    requireValue(watching && videoProducer?.kind === 'video' && videoProducer.producerSessionId === remote.producerSessionId
      && videoProducer.shareId === remote.shareId && videoProducer.syncGroup === remote.syncGroup,
    'STALE', 'Native SFU audio requires the current dedicated Watch for its exact screen association.');
  }

  registerRemoteProducer(value, syncGroup) {
    this.assertCurrent();
    const data = json(value);
    screenMedia(data.kind, data.appData?.mediaType, this.audioPublicationEnabled);
    const appData = sfuMediaAppDataSchema.safeParse(data.appData);
    requireValue(exact(data, ['channelId', 'producerId', 'producerSessionId', 'kind', 'appData'])
      && data.channelId === this.scope.channelId && reference(data.producerId) && reference(data.producerSessionId)
      && data.producerSessionId !== this.scope.publisherSessionId && appData.success && text(syncGroup),
    'ROSTER', 'Native SFU producer metadata is not an authenticated remote screen in this channel.');
    const watchKey = shareKey(data.producerSessionId, appData.data.shareId);
    const videoProducer = data.kind === 'audio' ? [...this.remoteProducers.values()].find(candidate => candidate.kind === 'video'
      && candidate.producerSessionId === data.producerSessionId && candidate.shareId === appData.data.shareId
      && candidate.syncGroup === syncGroup) : null;
    requireValue(data.kind !== 'audio' || videoProducer,
      'ROSTER', 'Native SFU audio metadata requires its explicit authenticated video share and synchronization group.');
    const remote = Object.freeze({ ...data, appData: Object.freeze(appData.data), shareId: appData.data.shareId, syncGroup,
      watchKey, key: data.kind === 'audio' ? JSON.stringify(['audio', data.producerSessionId]) : watchKey,
      ...(videoProducer ? { videoProducerId: videoProducer.producerId } : {}) });
    const existing = this.remoteProducers.get(data.producerId);
    if (existing) {
      requireValue(isDeepStrictEqual(existing, remote), 'ROSTER', 'An SFU producer ID cannot change its authenticated identity.');
      return;
    }
    const previous = [...this.remoteProducers.values()].find(candidate => candidate.key === remote.key);
    requireValue(previous || this.remoteProducers.size < this.maximumRemoteProducers, 'LIMIT', 'Native SFU remote roster limit reached.');
    if (previous) {
      this.remoteProducers.delete(previous.producerId);
      for (const record of this.resources) {
        if (record.remote === previous || record.remote?.videoProducerId === previous.producerId) this.retireInBackground(record);
      }
      for (const candidate of this.remoteProducers.values()) if (candidate.videoProducerId === previous.producerId) {
        this.remoteProducers.delete(candidate.producerId);
      }
    }
    this.remoteProducers.set(remote.producerId, remote);
  }

  async removeRemoteProducer(value) {
    requireValue(exact(value, ['channelId', 'producerId']) && value.channelId === this.scope.channelId
      && reference(value.producerId), 'ROSTER', 'Invalid scoped SFU producer removal.');
    const remote = this.remoteProducers.get(value.producerId);
    if (!remote) return;
    this.remoteProducers.delete(value.producerId);
    const records = [...this.resources].filter(record => record.remote === remote || record.remote?.videoProducerId === remote.producerId);
    for (const candidate of this.remoteProducers.values()) if (candidate.videoProducerId === remote.producerId) {
      this.remoteProducers.delete(candidate.producerId);
    }
    for (const record of records) this.markClosing(record);
    await this.retireMany(records);
    this.pruneWatch(remote.watchKey);
  }

  reserve(kind, parent = null, fields = {}) {
    requireValue(this.resources.size + this.sources.size < this.maximumResources, 'LIMIT', 'Native SFU resource limit reached.');
    const record = {
      kind, parent, ...fields, nativeId: null, serverId: null, nativeOwned: false, serverOwned: false,
      nativeUnknown: false, serverUnknown: false, children: new Set(), creating: true, ready: false,
      closing: false, retiring: null, localClosing: null, serverClosing: null, controls: new Set(),
      tentativeNativeId: null, initialPauseAcknowledged: false, nativeCleanupSeen: false,
      nativeRetired: false, serverRetired: false,
      requestedEnabled: false, routeRegistered: false, controlTail: Promise.resolve(),
      controller: new AbortController(), audioProof: null, audioContext: null, audioBound: false,
    };
    this.resources.add(record);
    parent?.children.add(record);
    return record;
  }

  start(record, action) {
    // Internal children await work, NOT the public cleanup wrapper: a parent's
    // failed creation must never wait for a child that is awaiting that cleanup.
    record.work = Promise.resolve().then(async () => {
      this.assertRecord(record);
      const result = await action();
      this.assertRecord(record);
      record.ready = true;
      return Object.freeze(result);
    }).finally(() => { record.creating = false; });
    record.promise = record.work.catch(async error => {
      this.markClosing(record);
      try { await this.retire(record); }
      catch (cleanupError) { error = aggregate([error, cleanupError], 'Native SFU creation and exact-resource cleanup failed.'); }
      this.report(error);
      throw error;
    });
    void record.promise.catch(() => {});
    return record;
  }

  getDevice() {
    this.assertCurrent();
    if (this.device && !this.device.closing) return this.device;
    const record = this.reserve('device');
    this.device = record;
    return this.start(record, async () => {
      const response = await this.callRpc(MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES, { channelId: this.scope.channelId });
      this.assertRecord(record);
      requireValue(own(response, 'channelId') === this.scope.channelId, 'RESPONSE', 'SFU router capabilities belong to another channel.');
      const routerRtpCapabilities = capabilities(own(response, 'rtpCapabilities'));
      const result = await this.nativeRequest(record, 'sfu.load', 0, { routerRtpCapabilities });
      this.claimNative(record, own(result, 'deviceId'));
      const data = json(result);
      requireValue(exact(data, ['deviceId', 'rtpCapabilities', 'canProduceVideo', 'canProduceAudio'])
        && typeof data.canProduceVideo === 'boolean' && typeof data.canProduceAudio === 'boolean',
      'RESPONSE', 'Native SFU load did not return the revision-3 router capability contract.');
      record.rtpCapabilities = capabilities(data.rtpCapabilities);
      record.canProduceVideo = data.canProduceVideo;
      record.canProduceAudio = data.canProduceAudio;
      this.assertRecord(record);
      return { deviceId: record.nativeId, rtpCapabilities: json(record.rtpCapabilities),
        canProduceVideo: record.canProduceVideo, canProduceAudio: record.canProduceAudio,
        brokerSupportedMediaTypes: this.audioPublicationEnabled ? ['screen_video', 'screen_audio'] : ['screen_video'],
        availabilityScope: 'compiled-implementation-not-device-probe' };
    });
  }

  load() {
    try { return this.getDevice().promise.then(result => json(result)); }
    catch (error) { return Promise.reject(error); }
  }

  getTransport(direction) {
    requireValue(['send', 'recv'].includes(direction), 'TRANSPORT', 'Native SFU only creates screen send or receive transports.');
    this.assertCurrent();
    const existing = this.transports.get(direction);
    if (existing && !existing.closing) return existing;
    const device = this.getDevice();
    const record = this.reserve('transport', device, { direction });
    const predecessors = [...this.resources].filter(candidate => candidate !== record
      && candidate.kind === 'transport' && candidate.direction === direction && candidate.closing);
    this.transports.set(direction, record);
    return this.start(record, async () => {
      await device.work;
      this.assertRecord(record);
      await Promise.all(predecessors.map(previous => this.retire(previous)));
      this.assertRecord(record);
      const response = await this.callRpc(MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
        { channelId: this.scope.channelId, direction, purpose: 'screen',
          ...(this.screenSessionId ? { screenSessionId: this.screenSessionId } : {}) }, record);
      this.claimServer(record, own(own(response, 'transportOptions'), 'id'));
      requireValue(own(response, 'channelId') === this.scope.channelId && own(response, 'direction') === direction
        && own(response, 'purpose') === 'screen' && own(response, 'screenSessionId') === this.screenSessionId,
      'RESPONSE', 'SFU transport response changed its channel, direction, purpose or screen engine.');
      const options = transportOptions(own(response, 'transportOptions'));
      this.assertRecord(record);
      const result = await this.nativeRequest(record, 'sfu.createTransport', device.nativeId, { direction, purpose: 'screen', ...options });
      this.claimNative(record, own(result, 'transportId'));
      requireValue(own(result, 'serverTransportId') === record.serverId && own(result, 'direction') === direction
        && own(result, 'purpose') === 'screen', 'RESPONSE', 'Native SFU transport response changed its owned server identity.');
      return { transportId: record.nativeId, serverTransportId: record.serverId, direction, purpose: 'screen' };
    });
  }

  createTransport(direction) {
    try { return this.getTransport(direction).promise; }
    catch (error) { return Promise.reject(error); }
  }

  publish(sourceId, options) {
    try {
      this.assertCurrent();
      const source = this.sources.get(sourceId);
      const settings = encoding(options, source?.kind);
      requireValue(positiveId(sourceId) && source && !source.closing, 'SOURCE', 'Native SFU publication requires a registered source.');
      if (source.nativeScreen) requireValue(settings.maxFramerate === source.nativeScreen.video.fps
        && settings.maxBitrateBps === source.nativeScreen.video.maxBitrateKbps * 1000,
      'SOURCE', 'Native SFU publication must use the advertised rendition settings.');
      if (source.kind === 'audio') this.assertAudioSource(source);
      const previous = source.publication;
      if (previous) {
        if (!previous.parent.closing && !previous.parent.nativeRetired && !previous.parent.serverRetired) {
          if (previous.closing || previous.nativeRetired || previous.serverRetired) {
            this.markClosing(previous);
            throw failure('RESOURCE', 'The previous publication must complete exact native/server retirement before republishing.');
          }
          requireValue(isDeepStrictEqual(previous.encoding, settings), 'SOURCE', 'A source/send-transport publication cannot change its creation settings.');
          return previous.promise;
        }
        this.markClosing(previous.parent);
      }
      const transport = this.getTransport('send');
      const record = this.reserve('producer', transport, { source, encoding: settings });
      source.publication = record;
      source.publications.add(record);
      this.start(record, async () => {
        await transport.work;
        this.assertRecord(record);
        requireValue(source.kind === 'audio' ? transport.parent.canProduceAudio : transport.parent.canProduceVideo,
          'UNSUPPORTED_MEDIA', 'The loaded SFU device cannot produce the selected screen media.');
        const result = await this.nativeRequest(record, 'sfu.produce', transport.nativeId, {
          sourceId, enabled: false, ...settings,
          appData: { mediaType: source.kind === 'audio' ? 'screen_audio' : 'screen_video', syncGroup: source.syncGroup },
        });
        this.claimNative(record, own(result, 'producerId'));
        const data = json(result);
        requireValue(exact(data, ['producerId', 'serverProducerId', 'kind', 'syncGroup'])
          && record.serverOwned && data.serverProducerId === record.serverId
          && data.kind === source.kind && data.syncGroup === source.syncGroup,
        'RESPONSE', 'Native SFU producer changed its revision-3 source kind, group or owned server identity.');
        return { producerId: record.nativeId, serverProducerId: record.serverId, kind: data.kind, syncGroup: data.syncGroup,
          sourceId, shareId: source.shareId, enabled: false,
          ...(source.kind === 'audio' ? { screenAudioShareId: source.shareId } : {}) };
      });
      return record.promise;
    } catch (error) { return Promise.reject(error); }
  }

  publishAudio(sourceId, options, signal) {
    try {
      requireValue(this.audioPublicationEnabled && this.sources.get(sourceId)?.kind === 'audio',
        'SOURCE', 'Native SFU publishAudio requires its registered PCM source.');
      requireValue(signal === undefined || signal instanceof AbortSignal, 'SOURCE', 'Invalid native SFU audio publication cancellation signal.');
      signal?.throwIfAborted();
      const opening = this.publish(sourceId, options), record = this.sources.get(sourceId).publication;
      if (!signal || !record || opening !== record.promise) return opening;
      const abort = () => this.retireInBackground(record);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      return opening.then(result => {
        signal.throwIfAborted();
        this.assertRecord(record);
        return result;
      }).catch(async error => {
        if (signal.aborted) {
          try { await this.retire(record); }
          catch (cleanupError) { throw aggregate([error, cleanupError], 'Cancelled SFU audio publication retains ownership.'); }
        }
        throw error;
      }).finally(() => { signal.removeEventListener('abort', abort); });
    } catch (error) { return Promise.reject(error); }
  }

  async closeAudioProducer(producerId) {
    requireValue(positiveId(producerId), 'RESOURCE', 'Native SFU audio producer retirement requires its own ID.');
    const record = [...this.resources].find(candidate => candidate.kind === 'producer' && candidate.nativeId === producerId);
    if (!record) return;
    requireValue(record.source.kind === 'audio', 'RESOURCE', 'Native SFU audio retirement cannot close a video producer.');
    this.markClosing(record);
    await this.retire(record);
  }

  consume(producerId, watchVersion) {
    try {
      this.assertCurrent();
      const remote = this.remoteProducers.get(producerId);
      requireValue(reference(producerId) && remote && positiveId(watchVersion),
        'ROSTER', 'Native SFU consumption requires an authorized screen producer and a Watch generation.');
      let watching;
      try { watching = this.isWatchCurrent(remote.producerSessionId, remote.shareId, watchVersion) === true; }
      catch { throw failure('SCOPE', 'The native SFU Watch observer failed.'); }
      requireValue(watching,
        'STALE', 'No SFU consumer or RTP is permitted before the explicit current Watch.');
      if (remote.kind === 'audio') this.assertAudioWatch(remote, watchVersion);
      const generation = this.watchVersions.get(remote.watchKey);
      requireValue(!generation || watchVersion > generation.version
        || (watchVersion === generation.version && !generation.stopped),
      'STALE', 'The requested native SFU Watch generation has already stopped.');
      const previous = this.activeConsumers.get(remote.key);
      if (previous?.remote === remote && previous.watchVersion === watchVersion && !previous.closing) return previous.promise;
      if (previous) this.retireInBackground(previous);
      const audioPredecessors = remote.kind === 'audio' ? [...this.resources].filter(record => record.kind === 'consumer'
        && record.remote.kind === 'audio' && record.remote.producerSessionId === remote.producerSessionId) : [];
      for (const record of audioPredecessors) this.markClosing(record);
      const transport = this.getTransport('recv');
      const record = this.reserve('consumer', transport, { remote, watchVersion, key: remote.key, watchKey: remote.watchKey });
      this.watchVersions.set(remote.watchKey, { version: watchVersion, stopped: false });
      this.activeConsumers.set(remote.key, record);
      this.start(record, async () => {
        await transport.work;
        this.assertRecord(record);
        // The native ABI rejects concurrent audio consumers of the same producer.
        // Await exact predecessor cleanup rather than racing a new Consume.
        if (audioPredecessors.length) await this.retireMany(audioPredecessors);
        this.assertRecord(record);
        const response = await this.callRpc(MessageType.SFU_CONSUME, {
          channelId: this.scope.channelId, transportId: transport.serverId, producerId,
          rtpCapabilities: json(transport.parent.rtpCapabilities),
        }, record);
        // Claim before validating remote metadata: a mismatched owner/share is
        // still our newly allocated consumer, never the remote producer itself.
        this.claimServer(record, own(response, 'id'));
        const data = json(response);
        screenMedia(data.kind, data.appData?.mediaType, this.audioPublicationEnabled);
        const appData = sfuMediaAppDataSchema.safeParse(data.appData);
        requireValue(data.channelId === this.scope.channelId && data.producerId === remote.producerId
          && data.producerSessionId === remote.producerSessionId && data.kind === remote.kind && appData.success
          && appData.data.mediaType === remote.appData.mediaType
          && appData.data.shareId === remote.shareId && isDeepStrictEqual(appData.data.nativeScreen, remote.appData.nativeScreen),
        'RESPONSE', 'SFU consumer metadata does not match its authorized producer, publisher, share and rendition.');
        const rtpParameters = rtp(data.rtpParameters, remote.kind);
        this.assertRecord(record);
        if (remote.kind === 'audio') await this.prepareAudioReceive(record);
        const result = await this.nativeRequest(record, 'sfu.consume', transport.nativeId, {
          id: record.serverId, producerId, kind: remote.kind, rtpParameters,
          appData: { mediaType: remote.appData.mediaType, syncGroup: remote.syncGroup }, enabled: false,
          ...(remote.kind === 'audio' ? { expectedOutputEpoch: this.audioEpoch(record) } : {}),
        });
        this.claimNative(record, own(result, 'consumerId'));
        const nativeData = json(result);
        // The pinned SDK binds the server consumer ID as track ID. Validate the
        // actual returned binding; never replace it with an expected/producer ID.
        requireValue(exact(nativeData, ['consumerId', 'serverConsumerId', 'kind', 'syncGroup', 'mid', 'trackId'])
          && nativeData.serverConsumerId === record.serverId && nativeData.kind === remote.kind
          && nativeData.syncGroup === remote.syncGroup
          && mediaToken(nativeData.mid, 64) && (rtpParameters.mid === undefined || nativeData.mid === rtpParameters.mid)
          && mediaToken(nativeData.trackId, 256) && nativeData.trackId === record.serverId,
        'RESPONSE', 'Native SFU consumer changed its revision-3 kind, group, binding or owned server identity.');
        this.assertRecord(record);
        if (remote.kind === 'audio') {
          requireValue(this.audioHooks.bindSfuConsumer(nativeData, record.audioProof, record.audioContext) === true,
            'AUDIO', 'Native SFU audio did not bind its actual prepared consumer.');
          record.audioBound = true;
        } else {
          record.routeRegistered = true;
          try { await this.routes.registerConsumer(record.nativeId, remote.producerSessionId, remote.shareId, watchVersion); }
          catch { throw failure('ROUTE', 'Native SFU consumer route registration failed.'); }
        }
        this.assertRecord(record);
        return { consumerId: record.nativeId, serverConsumerId: record.serverId, producerId,
          kind: nativeData.kind, syncGroup: nativeData.syncGroup, mid: nativeData.mid, trackId: nativeData.trackId,
          publisherSessionId: remote.producerSessionId, shareId: remote.shareId, watchVersion, enabled: false,
          ...(remote.kind === 'audio' ? { screenAudioShareId: remote.shareId } : {}) };
      });
      return record.promise;
    } catch (error) { return Promise.reject(error); }
  }

  async prepareAudioReceive(record) {
    const remote = record.remote, transport = record.parent;
    record.audioContext = Object.freeze({
      engine: this.engine, ...this.audioScope, channelId: this.scope.channelId, reason: 'sfu-consumer',
      transportId: transport.nativeId, serverTransportId: transport.serverId,
      remoteSessionId: remote.producerSessionId, producerId: remote.producerId, serverConsumerId: record.serverId,
      kind: 'audio', shareId: remote.shareId, screenAudioShareId: remote.shareId,
      syncGroup: remote.syncGroup, watchVersion: record.watchVersion, signal: record.controller.signal,
    });
    const pending = this.audioHooks.prepareSfuReceive(record.audioContext);
    requireValue(pending && typeof pending.then === 'function', 'AUDIO', 'Native SFU audio preparation must return its actual Promise.');
    record.audioProof = await pending;
    this.assertRecord(record);
    this.audioEpoch(record);
  }

  audioEpoch(record) {
    this.assertRecord(record);
    this.audioHooks.assertSfuReceiveReady(record.audioProof, record.audioContext);
    const epoch = this.audioHooks.expectedSfuOutputEpoch(record.audioProof, record.audioContext);
    requireValue(positiveId(epoch), 'AUDIO', 'Native SFU audio needs the exact prepared positive output epoch.');
    return epoch;
  }

  audioPublicationCurrent(record) {
    this.assertRecord(record);
    const context = Object.freeze({
      engine: this.engine, ...this.audioScope, channelId: this.scope.channelId,
      publisherSessionId: this.scope.publisherSessionId, sourceId: record.source.sourceId,
      shareId: record.source.shareId, screenAudioShareId: record.source.shareId, syncGroup: record.source.syncGroup,
      producerId: record.nativeId, serverProducerId: record.serverId,
      transportId: record.parent.nativeId, serverTransportId: record.parent.serverId,
    });
    try { return this.isAudioPublicationCurrent(context) === true; }
    catch { throw failure('SCOPE', 'The authenticated native SFU audio publication observer failed.'); }
  }

  syncAudioProducer(producerId) {
    try {
      const record = this.nativeOwners.get(producerId);
      requireValue(record?.kind === 'producer' && record.source.kind === 'audio' && record.ready,
        'RESOURCE', 'Native SFU audio demand requires its own ready PCM publication.');
      return this.setProducerEnabled(producerId, this.audioPublicationCurrent(record));
    } catch (error) { return Promise.reject(error); }
  }

  setProducerEnabled(producerId, enabled) {
    return this.setEnabled('producer', producerId, enabled);
  }

  setConsumerEnabled(consumerId, enabled) {
    return this.setEnabled('consumer', consumerId, enabled);
  }

  async getStats(id) {
    const record = this.nativeOwners.get(id);
    requireValue(positiveId(id) && record?.ready && ['producer', 'consumer'].includes(record.kind),
      'RESOURCE', 'Native diagnostics require an owned, ready SFU media resource.');
    this.assertRecord(record);
    const reports = await this.nativeRequest(record, 'sfu.getStats', id, {});
    this.assertRecord(record);
    return { id: `sfu-${id}`, reports };
  }

  setAudioMuted(consumerId, muted) {
    const record = this.nativeOwners.get(consumerId);
    if (record?.kind !== 'consumer' || record.remote.kind !== 'audio' || typeof muted !== 'boolean') {
      return Promise.reject(failure('RESOURCE', 'Native SFU audio mute requires its own watched audio consumer.'));
    }
    return this.setConsumerEnabled(consumerId, !muted);
  }

  setConsumerVolume(consumerId, volume) {
    const record = this.nativeOwners.get(consumerId);
    if (!positiveId(consumerId) || record?.kind !== 'consumer' || record.remote.kind !== 'audio' || !record.ready
      || !Number.isFinite(volume) || volume < 0 || volume > 2) {
      return Promise.reject(failure('RESOURCE', 'Native SFU volume requires its own watched audio consumer and 0..2 gain.'));
    }
    if (record.controls.size >= this.maximumPendingOperations) {
      return Promise.reject(failure('LIMIT', 'Native SFU audio control queue limit reached.'));
    }
    const run = record.controlTail.then(async () => {
      this.audioEpoch(record);
      requireValue(record.audioBound, 'AUDIO', 'Native SFU audio volume needs its prepared consumer binding.');
      const result = await this.nativeRequest(record, 'sfu.setConsumerVolume', consumerId, { volume });
      this.audioEpoch(record);
      requireValue(exact(result, ['consumerId', 'volume']) && result.consumerId === consumerId && result.volume === volume,
        'RESPONSE', 'Native SFU audio volume acknowledgement changed its consumer or gain.');
      requireValue(this.audioHooks.onSfuConsumerVolume(consumerId, result, record.audioProof, record.audioContext) === true,
        'AUDIO', 'Native SFU output did not acknowledge its consumer volume.');
      return result.volume;
    });
    return this.trackControl(record, run, 'volume');
  }

  setEnabled(kind, id, enabled) {
    const record = this.nativeOwners.get(id);
    if (!positiveId(id) || record?.kind !== kind || typeof enabled !== 'boolean' || !record.ready) {
      return Promise.reject(failure('RESOURCE', 'Native SFU gate requires its own ready screen resource and a boolean.'));
    }
    if ((record.source?.kind === 'audio' || record.remote?.kind === 'audio') && record.controls.size >= this.maximumPendingOperations) {
      return Promise.reject(failure('LIMIT', 'Native SFU audio control queue limit reached.'));
    }
    const run = record.controlTail.then(async () => {
      this.assertRecord(record);
      const audioConsumer = kind === 'consumer' && record.remote.kind === 'audio';
      if (kind === 'consumer') requireValue(audioConsumer ? record.audioBound : record.routeRegistered,
        'ROUTE', 'Native SFU consumer must be routed before enable.');
      if (kind === 'producer' && record.source.kind === 'audio' && enabled) {
        requireValue(this.audioPublicationCurrent(record), 'STALE', 'Native SFU audio sender has no authenticated screen demand.');
      }
      const operation = kind === 'producer' ? 'sfu.setProducerEnabled' : 'sfu.setConsumerEnabled';
      const result = await this.nativeRequest(record, operation, id, {
        enabled, ...(audioConsumer && enabled ? { expectedOutputEpoch: this.audioEpoch(record) } : {}),
      });
      requireValue(exact(result, ['enabled']) && typeof result.enabled === 'boolean' && (enabled || result.enabled === false),
        'RESPONSE', 'Native SFU enabled result is invalid or contradicts a disable request.');
      this.assertRecord(record);
      if (audioConsumer) {
        requireValue(this.audioHooks.onSfuConsumerEnabled(id, result, record.audioProof, record.audioContext) === true,
          'AUDIO', 'Native SFU output did not acknowledge its prepared audio gate.');
      }
      return result.enabled;
    });
    return this.trackControl(record, run, 'gate');
  }

  trackControl(record, run, operation) {
    record.controls.add(run);
    const settled = run.finally(() => { record.controls.delete(run); });
    record.controlTail = settled.then(() => {}, () => {});
    return settled.catch(async error => {
      this.markClosing(record);
      try { await this.retire(record); }
      catch (cleanupError) { error = aggregate([error, cleanupError], `Native SFU ${operation} and exact-resource cleanup failed.`); }
      this.report(error);
      throw error;
    });
  }

  async nativeRequest(record, operation, target, data) {
    this.assertRecord(record);
    if (record.remote?.kind === 'audio' && (operation === 'sfu.consume'
      || (operation === 'sfu.setConsumerEnabled' && data.enabled))) {
      requireValue(data.expectedOutputEpoch === this.audioEpoch(record), 'AUDIO',
        'Native SFU audio admission must carry this attempt\'s exact prepared output epoch.');
    }
    requireValue(this.operations.size < this.maximumPendingOperations, 'LIMIT', 'Native SFU pending operation limit reached.');
    const pending = { record, operation, target, data: json(data), id: null, callbacks: new Map() };
    if (operation === 'sfu.setProducerEnabled') {
      pending.intentApplied = new Promise(resolve => { pending.resolveIntent = resolve; });
    }
    this.operations.add(pending);
    let request, nativeCompleted = false;
    try {
      request = this.commands.request(operation, target, pending.data);
      requireValue(request && typeof request.then === 'function', 'NATIVE', 'Native SFU command did not return a Promise.');
      // Optional backwards-compatible request-ID exposure permits eager cancel
      // even for creation commands that have not emitted a callback yet.
      try {
        const requestId = Object.getOwnPropertyDescriptor(request, 'requestId')?.value;
        if (positiveId(requestId)) {
          const original = this.commands.getPendingRequest(requestId);
          requireValue(original?.id === requestId && original.operation === operation && original.target === target
            && isDeepStrictEqual(original.data, pending.data), 'NATIVE', 'Native SFU request-ID metadata did not match its original command.');
          pending.id = requestId;
        }
      } catch { this.report(failure('NATIVE', 'Native SFU request-ID metadata could not be correlated; late completion remains tracked.')); }
      const completion = await this.waitForNative(request);
      requireValue(!completion.retired, 'STALE', 'The complete native engine close retired this operation.');
      const result = completion.value;
      nativeCompleted = true;
      const gateMethod = operation === 'sfu.setProducerEnabled' ? 'setProducerEnabled'
        : operation === 'sfu.setConsumerEnabled' ? 'setConsumerEnabled' : null;
      if (gateMethod) {
        const acknowledgement = [...pending.callbacks.values()].find(token => token.event.data.method === gateMethod && token.acknowledged);
        requireValue(acknowledgement,
          'ACK', 'Native SFU gate completed without its correlated server acknowledgement.');
        requireValue(exact(result, ['enabled']) && typeof own(result, 'enabled') === 'boolean'
          && own(result, 'enabled') === acknowledgement.event.data.payload.enabled,
          'RESPONSE', 'Native SFU gate result contradicts its acknowledged effective server state.');
        if (record.source?.kind === 'audio' && pending.data.enabled) {
          requireValue(this.audioPublicationCurrent(record), 'STALE', 'Native SFU audio demand changed during its native gate.');
        }
        if (record.remote?.kind === 'audio' && pending.data.enabled) this.audioEpoch(record);
        // A following raw native command can start before these JS
        // continuations. Source callbacks wait on this commit, not on the
        // public setter Promise (whose failure path performs cleanup).
        record.requestedEnabled = pending.data.enabled;
      }
      return result;
    } catch (error) {
      // Dispatch can throw synchronously after native entry; a returned Promise
      // is not required to invalidate a possibly destroyed shared send transport.
      if (record.kind === 'producer' && !nativeCompleted
        && ['sfu.produce', 'sfu.setProducerEnabled'].includes(operation)) {
        this.retireInBackground(record.parent);
      }
      if (pending.intentApplied) this.markClosing(record);
      const preAdmission = error?.code === 'ERR_RTC_AUDIO_OUTPUT_PRE_ADMISSION' && error.status === 8;
      const duringAdmission = error?.code === 'ERR_RTC_AUDIO_OUTPUT_DURING_ADMISSION' && error.status === 7;
      if (record.remote?.kind === 'audio' && request && !nativeCompleted
        && ['sfu.consume', 'sfu.setConsumerEnabled'].includes(operation)) {
        if (!preAdmission) this.retireInBackground(record.parent);
        if (preAdmission || duringAdmission) {
          const diagnostic = failure('AUDIO_OUTPUT', 'Native SFU audio admission failed for its captured output epoch; no automatic retry.');
          Object.assign(diagnostic, { code: error.code, status: error.status, expectedOutputEpoch: pending.data.expectedOutputEpoch,
            requestId: pending.id, target, operation });
          throw diagnostic;
        }
      }
      if (error?.[brokerError]) throw error;
      throw failure('NATIVE', 'Native SFU command failed; media or credentials are not included in diagnostics.');
    } finally {
      // A failed result invalidates the record before releasing dependants.
      // No cleanup/close command is awaited while native may be in a source
      // callback immediately behind this operation.
      pending.resolveIntent?.();
      this.operations.delete(pending);
    }
  }

  waitForNative(promise) {
    if (this.engineRetired) {
      void Promise.resolve(promise).catch(() => {});
      return Promise.resolve({ retired: true });
    }
    let resolveRetired;
    const retired = new Promise(resolve => { resolveRetired = resolve; });
    this.nativeRetirementWaiters.add(resolveRetired);
    return Promise.race([
      Promise.resolve(promise).then(value => ({ retired: false, value })),
      retired.then(() => ({ retired: true })),
    ]).finally(() => { this.nativeRetirementWaiters.delete(resolveRetired); });
  }

  async callRpc(type, payload, allocation = null) {
    requireValue(this.pendingRpc < this.maximumPendingOperations, 'LIMIT', 'Native SFU pending RPC limit reached.');
    this.pendingRpc++;
    try {
      const request = json(payload);
      if (allocation) allocation.serverUnknown = true;
      const promise = this.rpc(type, request);
      requireValue(promise && typeof promise.then === 'function', 'RPC', 'Native SFU RPC adapter did not return a Promise.');
      return await promise;
    } catch (error) {
      if (error?.[brokerError]) throw error;
      throw failure('RPC', 'The scoped SFU RPC did not acknowledge its operation.');
    } finally { this.pendingRpc--; }
  }

  claimNative(record, id) {
    const retired = this.engineRetired || record.nativeRetired || record.parent?.nativeRetired === true;
    record.nativeUnknown = !retired;
    requireValue(positiveId(id) && !this.sources.has(id) && !this.nativeOwners.has(id),
      'RESPONSE', 'Native SFU returned an invalid or already-owned resource ID.');
    requireValue((!this.tentativeNativeOwners.has(id) || this.tentativeNativeOwners.get(id) === record)
      && (record.tentativeNativeId === null || record.tentativeNativeId === id),
    'RESPONSE', 'Native SFU creation returned a different resource than its tentative callback identity.');
    record.nativeId = id;
    record.nativeOwned = !retired;
    record.nativeUnknown = false;
    if (this.tentativeNativeOwners.get(id) === record) this.tentativeNativeOwners.delete(id);
    if (!retired) this.nativeOwners.set(id, record);
    if (record.kind === 'producer' || record.kind === 'consumer') {
      requireValue(record.tentativeNativeId === id && record.initialPauseAcknowledged && !record.nativeCleanupSeen,
        'RESPONSE', 'Native SFU creation completed without its tentative pause ACK or after failed-create cleanup.');
    }
  }

  bindTentative(record, id) {
    requireValue(positiveId(id) && !this.sourceHistory.has(id) && !this.nativeOwners.has(id)
      && (!this.tentativeNativeOwners.has(id) || this.tentativeNativeOwners.get(id) === record)
      && (record.tentativeNativeId === null || record.tentativeNativeId === id),
    'CALLBACK', 'Native SFU tentative callback target is invalid, already owned, or changed during creation.');
    record.tentativeNativeId = id;
    this.tentativeNativeOwners.set(id, record);
  }

  claimServer(record, id) {
    record.serverUnknown = true;
    requireValue(reference(id) && !this.serverOwners.has(`${record.kind}:${id}`),
      'RESPONSE', 'SFU returned an invalid or already-owned server resource ID.');
    record.serverId = id;
    record.serverOwned = true;
    record.serverUnknown = false;
    record.serverRetired = false;
    this.serverOwners.set(`${record.kind}:${id}`, record);
  }

  acknowledge(value, expected) {
    const data = json(value);
    requireValue(exact(data, Object.keys(expected)) && Object.keys(expected).every(key => data[key] === expected[key]),
      'ACK', 'SFU acknowledgement changed its scoped resource, purpose or requested state.');
  }

  activeCommand(requestId) {
    let command;
    try { command = this.commands.getPendingRequest(requestId); }
    catch { throw failure('CALLBACK', 'The native SFU command correlation adapter failed.'); }
    requireValue(command && command.id === requestId, 'CALLBACK', 'Native SFU callback has no active original command.');
    return command;
  }

  correlate(event) {
    this.assertCurrent();
    const { requestId, method, payload } = event.data;
    const command = this.activeCommand(requestId);
    let record, pending, transport, cleanup = false, initialGate = false, sourceGate = false;
    let precedingIntents = [];
    if (command.operation === 'source.setEnabled' && method === 'setProducerEnabled') {
      record = this.serverOwners.get(`producer:${payload.producerId}`);
      transport = record?.parent;
      const source = this.sources.get(command.target);
      requireValue(source && !source.closing && record?.source === source && record.nativeOwned
        && record.nativeId === event.target && typeof command.data?.enabled === 'boolean'
        && exact(command.data, ['enabled']) && (!payload.enabled || command.data.enabled),
      'CALLBACK', 'Native source gating can only control registered publications of that exact source.');
      sourceGate = true;
      for (const [id] of this.externalRequests) {
        if (!this.commands.getPendingRequest(id)) this.externalRequests.delete(id);
      }
      pending = this.externalRequests.get(requestId);
      if (!pending) {
        requireValue(this.externalRequests.size < this.maximumPendingOperations, 'LIMIT', 'Native SFU source callback limit reached.');
        pending = { id: requestId, operation: command.operation, target: command.target,
          data: json(command.data), callbacks: new Map(), external: true };
        this.externalRequests.set(requestId, pending);
      }
    } else {
      pending = [...this.operations].find(candidate => (candidate.id === null || candidate.id === requestId)
        && candidate.operation === command.operation && candidate.target === command.target
        && isDeepStrictEqual(candidate.data, command.data));
      requireValue(pending, 'CALLBACK', 'Native SFU callback does not match an active broker operation.');
      pending.id = requestId;
      record = pending.record;
      transport = record.parent;
      requireValue(transport?.kind === 'transport' && transport.serverId === payload.transportId && positiveId(transport.nativeId),
        'CALLBACK', 'Native SFU command references another transport.');
      if (method === 'connectTransport' || method === 'produce') {
        requireValue(['sfu.produce', 'sfu.consume'].includes(command.operation) && command.target === transport.nativeId
          && event.target === transport.nativeId, 'CALLBACK', 'Native SFU transport callback target is mismatched.');
        if (method === 'produce') {
          requireValue(command.operation === 'sfu.produce' && record.kind === 'producer'
            && command.data.sourceId === record.source.sourceId
            && payload.kind === record.source.kind
            && command.data.enabled === false && isDeepStrictEqual(command.data.appData, payload.appData)
            && !record.serverOwned, 'CALLBACK', 'Native SFU produce callback changed its registered source or publication.');
        }
      } else if (method === 'setProducerEnabled') {
        requireValue(record.kind === 'producer' && record.serverId === payload.producerId,
          'CALLBACK', 'Native SFU producer gate callback references another server resource.');
        if (command.operation === 'sfu.produce') {
          requireValue(command.target === transport.nativeId && command.data.sourceId === record.source.sourceId
            && command.data.enabled === false && payload.enabled === false,
          'CALLBACK', 'Native SFU producer creation may only pause its own source publication.');
          cleanup = event.target === transport.nativeId;
          initialGate = !cleanup;
        } else {
          requireValue(command.operation === 'sfu.setProducerEnabled' && record.nativeOwned
            && command.target === record.nativeId && event.target === record.nativeId
            && (!payload.enabled || command.data.enabled === true),
          'CALLBACK', 'Native SFU producer gate callback changed its resource or requested enable state.');
        }
      } else if (method === 'setConsumerEnabled') {
        requireValue(record.kind === 'consumer' && record.serverId === payload.consumerId,
          'CALLBACK', 'Native SFU consumer gate callback references another server resource.');
        if (command.operation === 'sfu.consume') {
          requireValue(command.target === transport.nativeId && command.data.id === record.serverId
            && command.data.producerId === record.remote.producerId && command.data.enabled === false && payload.enabled === false,
          'CALLBACK', 'Native SFU consumer creation may only pause its own server reservation.');
          cleanup = event.target === transport.nativeId;
          initialGate = !cleanup;
        } else {
          requireValue(command.operation === 'sfu.setConsumerEnabled' && record.nativeOwned
            && command.target === record.nativeId && event.target === record.nativeId && command.data.enabled === payload.enabled,
          'CALLBACK', 'Native SFU consumer gate callback changed its resource or requested enable state.');
        }
      }
    }
    requireValue(transport?.kind === 'transport' && transport.serverId === payload.transportId && payload.purpose === 'screen',
      'CALLBACK', 'Native SFU callback does not belong to its captured screen transport.');
    const token = { command, pending, record, transport, event, cleanup, initialGate, sourceGate };
    if (cleanup) {
      this.assertCleanup(token);
      record.nativeCleanupSeen = true;
      if (record.kind === 'producer') this.retireInBackground(transport);
    } else {
      requireValue(transport.nativeOwned && transport.serverOwned && !transport.closing
        && this.serverOwners.get(`transport:${transport.serverId}`) === transport,
      'CALLBACK', 'Native SFU callback does not belong to a live owned screen transport.');
      this.assertRecord(record);
      if (initialGate) this.bindTentative(record, event.target);
      if (sourceGate) {
        precedingIntents = [...this.operations].filter(operation => operation.record === record
          && operation.intentApplied && positiveId(operation.id) && operation.id < requestId)
          .map(operation => operation.intentApplied);
        if (precedingIntents.length === 0) this.assertSourceIntent(token);
      }
    }
    return { command, pending, record, transport, cleanup, initialGate, sourceGate, precedingIntents };
  }

  assertCleanup(token) {
    this.assertCurrent();
    const { record, transport, event } = token;
    const payload = event.data.payload;
    requireValue(event.target === transport.nativeId && payload.enabled === false && payload.purpose === 'screen'
      && payload.transportId === transport.serverId
      && (payload.producerId ?? payload.consumerId) === record.serverId
      && ((record.serverOwned && this.serverOwners.get(`${record.kind}:${record.serverId}`) === record)
        || record.serverRetired), 'CALLBACK', 'Native SFU failed-create cleanup has no matching owned server reservation.');
  }

  assertSourceIntent(token) {
    requireValue(!token.event.data.payload.enabled || (token.command.data.enabled && token.record.requestedEnabled),
      'CALLBACK', 'Native source gating does not match its producer intent in native command order.');
  }

  assertCallback(token, checkIntent = true) {
    if (token.cleanup) this.assertCleanup(token);
    else this.assertRecord(token.record);
    const command = this.activeCommand(token.event.data.requestId);
    requireValue(command.operation === token.command.operation && command.target === token.command.target
      && isDeepStrictEqual(command.data, token.command.data), 'CALLBACK', 'Native SFU original command changed during signaling.');
    if (checkIntent && token.sourceGate) this.assertSourceIntent(token);
    if (!token.cleanup && checkIntent && token.record.source?.kind === 'audio' && token.event.data.payload.enabled === true) {
      requireValue(this.audioPublicationCurrent(token.record), 'STALE', 'Native SFU audio callback has no current authenticated demand.');
    }
    if (!token.cleanup && token.record.remote?.kind === 'audio' && (token.command.operation === 'sfu.consume'
      || (token.command.operation === 'sfu.setConsumerEnabled' && token.command.data.enabled))) this.audioEpoch(token.record);
  }

  handleNativeEvent(value) {
    if (own(value, 'type') !== 'request') return Promise.resolve(false);
    const callbackId = own(own(value, 'data'), 'callbackId');
    let event, correlated;
    try {
      requireValue(positiveId(callbackId), 'CALLBACK', 'Native SFU request has no valid callback ID.');
      event = json(value);
      requireValue(positiveId(event.target) && positiveId(event.data.requestId)
        && ['connectTransport', 'produce', 'setProducerEnabled', 'setConsumerEnabled'].includes(event.data.method),
      'CALLBACK', 'Native SFU callback envelope is malformed.');
      const { method, payload } = event.data;
      const keys = {
        connectTransport: ['transportId', 'dtlsParameters', 'purpose'],
        produce: ['transportId', 'kind', 'rtpParameters', 'appData', 'purpose'],
        setProducerEnabled: ['transportId', 'producerId', 'enabled', 'purpose'],
        setConsumerEnabled: ['transportId', 'consumerId', 'enabled', 'purpose'],
      };
      requireValue(exact(payload, keys[method]) && reference(payload.transportId), 'CALLBACK', 'Native SFU callback payload is malformed.');
      if (method === 'produce') {
        screenMedia(payload.kind, payload.appData?.mediaType, this.audioPublicationEnabled);
        requireValue(exact(payload.appData, ['mediaType', 'syncGroup']) && text(payload.appData.syncGroup),
          'CALLBACK', 'Native SFU callback appData is not the screen sync-group contract.');
        payload.rtpParameters = rtp(payload.rtpParameters, payload.kind);
      } else if (method === 'connectTransport') payload.dtlsParameters = dtls(payload.dtlsParameters);
      else requireValue(typeof payload.enabled === 'boolean'
        && reference(method === 'setProducerEnabled' ? payload.producerId : payload.consumerId),
      'CALLBACK', 'Native SFU gate callback requires a valid server ID and boolean.');
      const running = this.callbacks.get(callbackId);
      if (running) {
        requireValue(isDeepStrictEqual(running.event, event), 'CALLBACK_DUPLICATE', 'Native SFU callback ID was reused with different data.');
        return running.task;
      }
      correlated = this.correlate(event);
      const key = `${method}:${event.target}:${payload.producerId ?? payload.consumerId ?? ''}`;
      const previous = correlated.pending.callbacks.get(key);
      if (previous?.event.data.callbackId === callbackId) return previous.task;
      requireValue(!previous, 'CALLBACK_DUPLICATE', 'Native SFU operation emitted a duplicate signaling callback.');
      requireValue(this.callbacks.size < this.maximumPendingOperations, 'LIMIT', 'Native SFU callback limit reached.');
      const token = { event, ...correlated, task: null, retire: null };
      this.callbacks.set(callbackId, token);
      correlated.pending.callbacks.set(key, token);
      // Never serialize this behind a command/control tail: native is waiting
      // for respond(), which deliberately bypasses the engine actor queue.
      token.task = Promise.resolve().then(async () => {
        let responseAttempted = false;
        try {
          const data = await this.runCallback(token);
          this.assertCallback(token);
          responseAttempted = true;
          requireValue(this.respond(callbackId, { ok: true, data }), 'RESPOND', 'Native SFU did not accept its signaling response.');
          token.acknowledged = true;
          if (token.initialGate) token.record.initialPauseAcknowledged = true;
          return true;
        } catch (error) {
          if (!token.retire) {
            try { await this.rejectCallback(token, error); }
            catch (cleanupError) { error = cleanupError; }
          }
          if (!responseAttempted) {
            this.respond(callbackId, { ok: false, error: { code: error.code ?? 'ERR_NATIVE_SFU_CALLBACK',
              message: 'Scoped native SFU signaling failed.' } });
          }
          this.report(error);
          return false;
        }
      }).finally(() => {
        if (this.callbacks.get(callbackId) === token) this.callbacks.delete(callbackId);
        if (token.retire) this.retireInBackground(token.retire);
      });
      return token.task;
    } catch (error) {
      // Do not answer an unrelated replay over an already-active callback ID.
      if (positiveId(callbackId) && !this.callbacks.has(callbackId)) {
        this.respond(callbackId, { ok: false, error: { code: error.code ?? 'ERR_NATIVE_SFU_CALLBACK',
          message: 'Native SFU callback was rejected before signaling.' } });
      }
      this.report(error);
      return Promise.resolve(false);
    }
  }

  respond(callbackId, response) {
    if (this.engineRetired) return false;
    try {
      const result = this.engine.respond(callbackId, response);
      if (result === undefined) return true;
      this.report(failure('RESPOND', 'Native SFU respond must synchronously return void; its reply was not acknowledged.'));
      void Promise.resolve(result).catch(() => {
        this.report(failure('RESPOND', 'An invalid asynchronous native SFU response rejected; no reply or retirement is inferred.'));
      });
      return false;
    }
    catch {
      this.report(failure('RESPOND', 'Native SFU callback response was not accepted; no resource retirement is inferred.'));
      return false;
    }
  }

  async runCallback(token) {
    const { record, transport, event } = token;
    const { method, payload } = event.data;
    try {
      if (token.precedingIntents.length > 0) {
        this.assertCallback(token, false);
        await Promise.all(token.precedingIntents);
      }
      this.assertCallback(token);
      if (token.cleanup && record.serverRetired) return {};
      if (method === 'produce') {
        const nativeScreen = record.source.kind === 'audio'
          ? record.source.associatedVideo.nativeScreen : record.source.nativeScreen;
        const response = await this.callRpc(MessageType.SFU_PRODUCE, {
          channelId: this.scope.channelId, transportId: transport.serverId, kind: record.source.kind,
          rtpParameters: payload.rtpParameters,
          appData: { mediaType: record.source.kind === 'audio' ? 'screen_audio' : 'screen_video', shareId: record.source.shareId,
            ...(nativeScreen ? { nativeScreen } : {}) },
        }, record);
        this.claimServer(record, own(response, 'id'));
        requireValue(own(response, 'channelId') === this.scope.channelId, 'RESPONSE', 'SFU producer response belongs to another channel.');
        this.assertCallback(token);
        return { id: record.serverId };
      }
      let type, request;
      if (method === 'connectTransport') {
        type = MessageType.SFU_CONNECT_WEBRTC_TRANSPORT;
        request = { channelId: this.scope.channelId, transportId: transport.serverId, dtlsParameters: payload.dtlsParameters };
      } else if (method === 'setProducerEnabled') {
        type = MessageType.SFU_PRODUCER_SET_PAUSED;
        request = { channelId: this.scope.channelId, producerId: record.serverId, paused: !payload.enabled, purpose: 'screen' };
      } else {
        type = MessageType.SFU_CONSUMER_SET_PAUSED;
        request = { channelId: this.scope.channelId, consumerId: record.serverId, paused: !payload.enabled };
      }
      const response = await this.callRpc(type, request);
      this.acknowledge(response, method === 'connectTransport'
        ? { channelId: this.scope.channelId, transportId: transport.serverId } : request);
      this.assertCallback(token);
      return {};
    } catch (error) { return await this.rejectCallback(token, error); }
  }

  async rejectCallback(token, error) {
    token.retire = token.record.kind === 'producer' ? token.transport : token.record;
    this.markClosing(token.retire);
    // Waiting for local resource.close here would deadlock behind the native
    // operation awaiting this callback. Only server cleanup runs inline; the
    // entire affected send tree retires after the callback has returned.
    if (token.record.serverOwned || token.record.serverUnknown) {
      try { await this.closeServer(token.record); }
      catch (cleanupError) { throw aggregate([error, cleanupError], 'Native SFU callback and server resource cleanup failed.'); }
    }
    throw error;
  }

  markClosing(record) {
    record.closing = true;
    record.controller.abort();
    try { this.revokeAudioReceive(record); }
    catch { this.report(failure('AUDIO', 'Native SFU audio preparation revocation failed; ownership is retained.')); }
    if (record.kind === 'transport' && this.transports.get(record.direction) === record) this.transports.delete(record.direction);
    if (record.kind === 'device' && this.device === record) this.device = null;
    if (record.kind === 'consumer' && this.activeConsumers.get(record.key) === record) this.activeConsumers.delete(record.key);
    for (const child of record.children) this.markClosing(child);
    if (this.engineRetired || this.engineCloseProof) return;
    for (const operation of this.operations) {
      if (operation.record !== record || !positiveId(operation.id) || operation.cancelAttempted) continue;
      operation.cancelAttempted = true;
      try {
        const original = this.commands.getPendingRequest(operation.id);
        if (!original) continue;
        requireValue(original.id === operation.id && original.operation === operation.operation && original.target === operation.target
          && isDeepStrictEqual(original.data, operation.data), 'CANCEL', 'Native SFU cannot cancel a different original command.');
        this.engine.cancel(operation.id);
      }
      catch { this.report(failure('CANCEL', 'Native SFU cancellation was not acknowledged; late results remain owned.')); }
    }
  }

  retireInBackground(record) {
    this.markClosing(record);
    void this.retire(this.unusedCreatingTransport(record) ?? record).catch(error => this.report(error));
  }

  unusedCreatingTransport(record) {
    const parent = record.parent;
    if (parent?.kind !== 'transport' || !parent.creating
      || [...parent.children].some(child => !child.closing)) return null;
    this.markClosing(parent);
    return parent;
  }

  async removeSource(sourceId) {
    requireValue(positiveId(sourceId), 'SOURCE', 'Invalid native SFU source ID.');
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.closing = true;
    source.rebindController?.abort();
    for (const candidate of this.sources.values()) if (candidate.kind === 'audio' && candidate.rebindTarget === source) {
      candidate.rebindController?.abort();
    }
    const associatedAudio = source.kind === 'video'
      ? [...this.sources.values()].find(candidate => candidate.kind === 'audio' && candidate.associatedVideo === source) : null;
    const audioRetirement = associatedAudio ? this.removeSource(associatedAudio.sourceId) : null;
    const records = [...source.publications];
    for (const record of records) this.markClosing(record);
    for (const record of [...records]) {
      const parent = this.unusedCreatingTransport(record);
      if (parent && !records.includes(parent)) records.push(parent);
    }
    const retiring = this.retireMany(records);
    if (audioRetirement) {
      const results = await Promise.allSettled([retiring, audioRetirement]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw aggregate(errors, 'Native SFU associated source cleanup retains independent media ownership.');
    } else await retiring;
    if (source.rebinding) await Promise.allSettled([source.rebinding]);
    if (source.publications.size === 0 && this.sources.get(sourceId) === source) this.sources.delete(sourceId);
  }

  removeAudioSource(sourceId) {
    if (!positiveId(sourceId) || (this.sources.has(sourceId) && this.sources.get(sourceId).kind !== 'audio')) {
      return Promise.reject(failure('SOURCE', 'Native SFU audio retirement requires its own PCM source ID.'));
    }
    return this.removeSource(sourceId);
  }

  rebindAudioSource(sourceId, { screenAudioShareId, syncGroup, signal } = {}) {
    try {
      this.assertCurrent();
      const source = this.sources.get(sourceId);
      const videoSource = [...this.sources.values()].find(candidate => candidate.kind === 'video'
        && !candidate.closing && candidate.shareId === screenAudioShareId && candidate.syncGroup === syncGroup);
      requireValue(this.audioPublicationEnabled && source?.kind === 'audio' && !source.closing && !source.rebinding
        && shareReference(screenAudioShareId) && videoSource && typeof this.rebindAudioSourceGroup === 'function'
        && (signal === undefined || signal instanceof AbortSignal),
      'SOURCE', 'Native SFU audio rebind needs its explicit active screen and source-owner hook.');
      signal?.throwIfAborted();
      const controller = new AbortController(), previousShareId = source.shareId;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      source.rebindController = controller;
      source.rebindTarget = videoSource;
      const current = () => {
        try { this.assertCurrent(); } catch { return false; }
        return !controller.signal.aborted && !source.closing && this.sources.get(sourceId) === source
          && !videoSource.closing && this.sources.get(videoSource.sourceId) === videoSource;
      };
      const records = [...source.publications];
      for (const record of records) this.markClosing(record);
      let groupAttempted = false;
      const workflow = Promise.resolve().then(async () => {
        await this.retireMany(records);
        requireValue(current(), 'STALE', 'Native SFU audio reassociation was cancelled before changing its source.');
        groupAttempted = true;
        const pending = this.rebindAudioSourceGroup(Object.freeze({
          engine: this.engine, sourceId, previousShareId, screenAudioShareId, syncGroup,
          callId: this.audioScope.callId, channelId: this.scope.channelId, signal: controller.signal, isCurrent: current,
        }));
        requireValue(pending && typeof pending.then === 'function', 'AUDIO', 'Native SFU source group hook must return its actual Promise.');
        const result = await pending;
        requireValue(exact(result, ['sourceId', 'syncGroup']) && result.sourceId === sourceId && result.syncGroup === syncGroup,
          'ACK', 'Native SFU source group acknowledgement does not match its owned source and selected group.');
        source.syncGroup = result.syncGroup;
        requireValue(current(), 'STALE', 'Native SFU audio changed group after cancellation; explicit reassociation is required.');
        source.shareId = screenAudioShareId;
        source.associatedVideo = videoSource;
        return Object.freeze({ sourceId, kind: 'audio', screenAudioShareId, syncGroup });
      }).catch(error => {
        if (groupAttempted) source.associatedVideo = null;
        throw error;
      }).finally(() => {
        signal?.removeEventListener('abort', abort);
        source.rebinding = null;
        source.rebindController = null;
        source.rebindTarget = null;
      });
      source.rebinding = workflow;
      return workflow;
    } catch (error) { return Promise.reject(error); }
  }

  async stopWatching(publisherSessionId, shareId, watchVersion) {
    requireValue(reference(publisherSessionId) && shareReference(shareId) && positiveId(watchVersion),
      'ROSTER', 'Stopping native SFU Watch requires its exact publisher, share and generation.');
    const key = shareKey(publisherSessionId, shareId);
    const generation = this.watchVersions.get(key);
    if ((!generation || generation.version <= watchVersion)
      && (generation || [...this.remoteProducers.values()].some(remote => remote.watchKey === key))) {
      this.watchVersions.set(key, { version: watchVersion, stopped: true });
    }
    const records = [...this.resources].filter(record => record.kind === 'consumer'
      && record.watchKey === key && record.watchVersion === watchVersion);
    for (const record of records) this.markClosing(record);
    for (const record of [...records]) {
      const parent = this.unusedCreatingTransport(record);
      if (parent && !records.includes(parent)) records.push(parent);
    }
    await this.retireMany(records);
  }

  async resetTransport(direction) {
    requireValue(['send', 'recv'].includes(direction), 'TRANSPORT', 'Invalid native screen transport direction.');
    const record = this.transports.get(direction);
    if (!record) return;
    this.markClosing(record);
    await this.retireMany([record]);
  }

  async closeTransport(transportId) {
    const record = [...this.resources].find(candidate => candidate.kind === 'transport' && candidate.nativeId === transportId);
    requireValue(positiveId(transportId) && record?.kind === 'transport', 'RESOURCE', 'Only an owned native screen transport may be closed.');
    this.markClosing(record);
    await this.retireMany([record]);
  }

  async retryCleanup() {
    const records = [...this.resources].filter(record => record.closing && !record.parent?.closing);
    await this.retireMany(records);
  }

  async retireMany(records) {
    const results = await Promise.allSettled(records.map(record => this.retire(record)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) {
      const error = aggregate(errors, 'Native SFU teardown has failed ownership obligations; retry exact cleanup.');
      this.report(error);
      throw error;
    }
  }

  retire(record) {
    if (record.retiring) return record.retiring;
    this.markClosing(record);
    record.retiring = (async () => {
      const errors = [];
      try { this.revokeAudioReceive(record); }
      catch { errors.push(failure('AUDIO', 'Native SFU audio preparation revocation failed; ownership is retained.')); }
      if (record.routeRegistered) {
        try {
          await this.routes.removeConsumer(record.nativeId);
          record.routeRegistered = false;
        } catch { errors.push(failure('ROUTE', 'Native SFU consumer route removal failed; its route remains owned.')); }
      }
      await Promise.allSettled([record.work, ...record.controls]);
      const pendingCallbacks = [...this.callbacks.values()].filter(token => token.record === record).map(token => token.task);
      await Promise.allSettled(pendingCallbacks);
      try { this.revokeAudioReceive(record); }
      catch { errors.push(failure('AUDIO', 'Late native SFU audio preparation revocation failed; ownership is retained.')); }
      // Registration may have completed after Stop while creation was pending.
      if (record.routeRegistered) {
        try {
          await this.routes.removeConsumer(record.nativeId);
          record.routeRegistered = false;
        } catch { errors.push(failure('ROUTE', 'Native SFU consumer route removal failed; its route remains owned.')); }
      }
      const children = await Promise.allSettled([...record.children].map(child => this.retire(child)));
      for (const result of children) if (result.status === 'rejected') errors.push(result.reason);
      // Independent attempts: a failed local close must not leave server RTP
      // running merely because the native resource still needs a retry.
      const results = await Promise.allSettled([this.closeLocal(record), this.closeServer(record)]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      this.forget(record);
      if (errors.length) throw aggregate(errors, 'Native SFU resource cleanup failed; unacknowledged ownership is retained.');
    })().finally(() => { record.retiring = null; });
    return record.retiring;
  }

  revokeAudioReceive(record) {
    if (!record.audioProof) return;
    const revoked = this.audioHooks.revokeSfuReceive(record.audioProof, record.audioContext, 'sfu-consumer-retired');
    requireValue(typeof revoked === 'boolean', 'AUDIO', 'Native SFU audio revocation must synchronously retire its exact preparation.');
    record.audioProof = null;
    record.audioBound = false;
  }

  closeLocal(record) {
    if (this.engineRetired || record.nativeRetired) {
      this.retiredSide(record, 'native');
      return Promise.resolve();
    }
    if (record.localClosing) return record.localClosing;
    if (!record.nativeOwned && !record.nativeUnknown) return Promise.resolve();
    if (this.engineCloseProof) return this.engineCloseProof.then(() => { this.retiredSide(record, 'native'); });
    if (!record.nativeOwned) return Promise.reject(failure('OWNERSHIP', 'Native SFU allocation has no acknowledged native ID; ownership is unresolved.'));
    record.localClosing = (async () => {
      try {
        const completion = await this.waitForNative(this.commands.request('resource.close', record.nativeId, {}));
        requireValue(completion.retired || exact(completion.value, []), 'ACK', 'Native SFU local resource close was not acknowledged.');
        this.retiredSide(record, 'native');
      } catch (error) {
        if (this.engineRetired) {
          this.retiredSide(record, 'native');
          return;
        }
        if (error?.[brokerError]) throw error;
        throw failure('CLOSE_NATIVE', 'Native SFU local resource close failed; native ownership is retained.');
      }
    })().finally(() => { record.localClosing = null; });
    return record.localClosing;
  }

  closeServer(record) {
    if (record.serverClosing) return record.serverClosing;
    if (!record.serverOwned && !record.serverUnknown) return Promise.resolve();
    if (!record.serverOwned) return Promise.reject(failure('OWNERSHIP', 'SFU allocation has no acknowledged server ID; ownership is unresolved.'));
    record.serverClosing = (async () => {
      let type, payload;
      if (record.kind === 'transport') {
        type = MessageType.SFU_CLOSE_WEBRTC_TRANSPORT;
        payload = { channelId: this.scope.channelId, transportId: record.serverId, purpose: 'screen' };
      } else if (record.kind === 'producer') {
        type = MessageType.SFU_PRODUCER_CLOSED;
        payload = { channelId: this.scope.channelId, producerId: record.serverId };
      } else {
        type = MessageType.SFU_CONSUMER_CLOSED;
        payload = { channelId: this.scope.channelId, consumerId: record.serverId };
      }
      const response = await this.callRpc(type, payload);
      this.acknowledge(response, payload);
      this.retiredSide(record, 'server');
    })().finally(() => { record.serverClosing = null; });
    return record.serverClosing;
  }

  retiredSide(record, side) {
    record[`${side}Owned`] = false;
    record[`${side}Unknown`] = false;
    if (side === 'native' && this.nativeOwners.get(record.nativeId) === record) this.nativeOwners.delete(record.nativeId);
    if (side === 'native' && this.tentativeNativeOwners.get(record.tentativeNativeId) === record) {
      this.tentativeNativeOwners.delete(record.tentativeNativeId);
    }
    if (side === 'native') record.nativeRetired = true;
    if (side === 'server') record.serverRetired = true;
    if (side === 'server' && this.serverOwners.get(`${record.kind}:${record.serverId}`) === record) {
      this.serverOwners.delete(`${record.kind}:${record.serverId}`);
    }
    // Only an acknowledged ancestor close proves its descendants retired.
    // Never apply this to a replacement (which has a different parent object).
    for (const child of record.children) this.retiredSide(child, side);
    this.forget(record);
  }

  forget(record) {
    for (const child of [...record.children]) this.forget(child);
    if (record.creating || record.nativeOwned || record.serverOwned || record.nativeUnknown || record.serverUnknown
      || record.routeRegistered || record.audioProof || record.children.size > 0 || !record.closing) return;
    this.resources.delete(record);
    if (this.tentativeNativeOwners.get(record.tentativeNativeId) === record) this.tentativeNativeOwners.delete(record.tentativeNativeId);
    record.parent?.children.delete(record);
    record.source?.publications.delete(record);
    if (record.source?.publication === record) record.source.publication = null;
    if (record.source?.closing && !record.source.rebinding && record.source.publications.size === 0
      && this.sources.get(record.source.sourceId) === record.source) this.sources.delete(record.source.sourceId);
    if (record.watchKey) this.pruneWatch(record.watchKey);
  }

  pruneWatch(key) {
    if (![...this.remoteProducers.values()].some(remote => remote.watchKey === key)
      && ![...this.resources].some(record => record.watchKey === key)) this.watchVersions.delete(key);
  }

  invalidateScope() {
    this.closed = true;
    this.remoteProducers.clear();
    this.externalRequests.clear();
    for (const source of this.sources.values()) {
      source.closing = true;
      source.rebindController?.abort();
    }
    for (const record of this.resources) this.markClosing(record);
  }

  async finishAfterEngineClose(engineClosePromise) {
    requireValue(isPromise(engineClosePromise) && isNativeRtcCommandsForEngine(this.commands, this.engine),
      'ENGINE_CLOSE', 'Native SFU retirement requires commands.closeEngine() and its complete-close proof API.');
    const proof = engineClosePromise.then(() => {
      try { assertNativeRtcEngineClosed(this.commands, this.engine); }
      catch { throw failure('ENGINE_CLOSE', 'The command registry has not proven complete closure of this native engine.'); }
      this.engineRetired = true;
      for (const record of [...this.resources]) this.retiredSide(record, 'native');
      for (const resolve of this.nativeRetirementWaiters) resolve();
      this.nativeRetirementWaiters.clear();
    }, () => { throw failure('ENGINE_CLOSE', 'The complete native engine close failed; native ownership is retained.'); });
    this.engineCloseProof = proof;
    this.invalidateScope();
    try {
      await proof;
      // The global proof supersedes failed/pending local closes, not RPCs.
      // Allow existing retirement attempts to settle before retrying their
      // remaining server obligations, without replaying native close failures.
      await Promise.allSettled([this.closing, ...[...this.resources].map(record => record.retiring)]);
      await this.close();
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      if (this.engineCloseProof === proof) this.engineCloseProof = null;
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.invalidateScope();
    const roots = [...this.resources].filter(record => !record.parent || !this.resources.has(record.parent));
    this.closing = this.retireMany(roots).then(async () => {
      await Promise.allSettled([...this.sources.values()].map(source => source.rebinding));
      for (const [id, source] of this.sources) if (source.publications.size === 0) this.sources.delete(id);
      for (const key of this.watchVersions.keys()) this.pruneWatch(key);
    }).finally(() => { this.closing = null; });
    return this.closing;
  }

  snapshot() {
    return {
      ...this.scope, closed: this.closed, sources: this.sources.size, remoteProducers: this.remoteProducers.size,
      engineRetired: this.engineRetired,
      audioPublicationEnabled: this.audioPublicationEnabled,
      pendingOperations: this.operations.size, pendingCallbacks: this.callbacks.size, pendingRpc: this.pendingRpc,
      observerFailures: this.observerFailures, availabilityScope: 'compiled-implementation-not-device-probe',
      resources: [...this.resources].map(record => ({
        kind: record.kind, nativeId: record.nativeId, serverId: record.serverId, closing: record.closing,
        nativeOwned: record.nativeOwned, serverOwned: record.serverOwned,
        nativeUnknown: record.nativeUnknown, serverUnknown: record.serverUnknown,
        ...(record.source ? { sourceId: record.source.sourceId, shareId: record.source.shareId,
          mediaKind: record.source.kind } : {}),
        ...(record.remote ? { publisherSessionId: record.remote.producerSessionId, shareId: record.remote.shareId,
          watchVersion: record.watchVersion, routed: record.routeRegistered,
          ...(record.remote.kind === 'audio' ? { mediaKind: 'audio', audioBound: record.audioBound,
            audioPreparationRetained: record.audioProof !== null } : {}) } : {}),
      })),
    };
  }
}

const isNativeSfuAudioBroker = value => audioBrokers.has(value);
module.exports = { NativeSfuBroker, isNativeSfuAudioBroker };
