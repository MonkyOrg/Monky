'use strict';

const { NativeRtcCommands, isNativeRtcCommandsForEngine, assertNativeRtcEngineClosed } = require('./nativeRtcCommands.cjs');

const PROTOCOL = 'monky-native-screen-p2p';
const VERSION = 1;
const AV_VERSION = 2;
const SDP_BYTES = 1024 * 1024;
const ENVELOPE = ['protocol', 'version', 'callId', 'channelId', 'connectionId', 'generation', 'type'];
const VARIANTS = Object.freeze({
  negotiate: Object.freeze(['requestVersion']),
  turn: Object.freeze(['turn', 'offererSessionId']),
  offer: Object.freeze(['turn', 'sdp']),
  answer: Object.freeze(['turn', 'sdp']),
  'turn-applied': Object.freeze(['turn']),
  'turn-done': Object.freeze(['turn']),
  ice: Object.freeze(['turn', 'candidate', 'sdpMid', 'sdpMLineIndex']),
  publication: Object.freeze(['shareId', 'publicationId', 'publicationVersion', 'metadataVersion', 'trackId', 'mid', 'streamIds']),
  unpublish: Object.freeze(['shareId', 'publicationId', 'publicationVersion']),
  watch: Object.freeze(['shareId', 'publicationId', 'publicationVersion', 'metadataVersion', 'subscriptionId', 'revision', 'watching']),
});
const VIDEO_SUBSCRIPTION_FIELDS = Object.freeze(['publicationId', 'publicationVersion', 'metadataVersion', 'subscriptionId', 'revision']);
const mediaKind = value => value === 'audio' || value === 'video';
const mediaKey = (kind, shareId) => kind === 'audio' ? `audio:${shareId}` : shareId;
const publicationOperation = operation => operation === 'peer.publish' || operation === 'peer.publishAudio';
const kindOf = value => value.kind ?? 'video';

/**
 * @typedef {{protocol: 'monky-native-screen-p2p', version: 1, callId: string,
 *   channelId: string, connectionId: string, generation: number}} NativeP2pScope
 * @typedef {{shareId: string, publicationId: number, publicationVersion: number}} PublicationIdentity
 * @typedef {{trackId: string, mid: string|null, streamIds: string[], metadataVersion: number}} PublicationMetadata
 * @typedef {(
 *   {type: 'negotiate', requestVersion: number} |
 *   {type: 'turn', turn: number, offererSessionId: string} |
 *   {type: 'offer'|'answer', turn: number, sdp: string} |
 *   {type: 'turn-applied'|'turn-done', turn: number} |
 *   {type: 'ice', turn: number, candidate: string, sdpMid: string|null, sdpMLineIndex: number|null} |
 *   ({type: 'publication'} & PublicationIdentity & PublicationMetadata) |
 *   ({type: 'unpublish'} & PublicationIdentity) |
 *   ({type: 'watch', metadataVersion: number, subscriptionId: number, revision: number, watching: boolean} & PublicationIdentity)
 * ) & NativeP2pScope} NativeP2pControlMessage
 *
 * Numeric IDs/revisions/turns are positive safe integers except sdpMLineIndex (0..65535).
 * Session/scope IDs are 1..128 UTF-8 bytes; share IDs match [A-Za-z0-9_.-]{1,64}.
 * SDP is nonempty and <=1MiB. ICE is <=8192 bytes and has a MID or m-line index.
 * Actual track/MID/stream references are <=256 bytes (at most 8 stream IDs).
 * The ICE sdpMid is <=128 bytes. Version 1 remains video-only, with no extra fields.
 * Version 2 requires kind:'video'|'audio' on publication/unpublish/watch and
 * syncGroup on publication. An audio publication's shareId IS its explicit
 * screenAudioShareId. An audio Watch additionally requires video:{publicationId,
 * publicationVersion,metadataVersion,subscriptionId,revision}, all positive safe
 * integers identifying the current watched VIDEO publication of that same share.
 * Audio/video identities never share a map key. No rollback or pranswer exists.
 */

/**
 * This is dedicated native screen CONTROL, never browser call signaling.
 * send(authenticatedDestinationSessionId, message) MUST resolve on FIFO enqueue,
 * not on remote receive() completion. The carrier supplies the authenticated
 * sender to receive(); there is deliberately no sender field in a message.
 *
 * Both controllers must agree on {callId, channelId, connectionId, generation, controlVersion}
 * before connect(). A replacement uses a fresh connectionId and larger generation.
 * Pair establishment/leave notification belongs to that controller: retire both
 * ends on authenticated participant departure or a failed-generation notification.
 * The lexically smaller session grants one offer turn at a time, from either side.
 * A nonleader offerer acknowledges answer application before the leader sends done.
 * Neither "stable" nor an SDP creation result completes a negotiation turn.
 *
 * Sources/engine/GPU leases belong to the caller. onPublicationState.demanded is
 * authorized Watch intent; sourceDemand() counts that intent, not actual RTP.
 * requestedEnabled is the last acknowledged individual sender request. enabled
 * remains its last observed EFFECTIVE native ACK (request && source.enabled);
 * it does not observe subsequent external source-gate changes. The source owner
 * uses demanded/sourceDemand(), never enabled, to avoid a circular enable gate.
 * Revoked demand is not retirement proof. No source, engine, capture,
 * presentation or browser-call method is used.
 * The injected NativeRtcCommands must belong to this engine; nextId plus
 * getPendingRequest() identify only this broker's cancellable control requests.
 *
 * A/V is explicit: controlVersion:2 plus audio:{prepareReceive,assertReceiveReady,
 * bindReceiver,revokeReceiver,onReceiverVolume,onPublicationState?,rebindSource?}.
 * Default v1 and a constructor without audio are inert/video-only. Sources use
 * distinct per-screen groups, independent of the peer scope group. Register the
 * parent's existing continuous PCM source with registerAudioSource({sourceId,
 * screenAudioShareId,syncGroup}); publishAudio(sourceId,session,{maxBitrateBps,signal?})
 * creates only a disabled dedicated sendonly Opus publication. Native audio
 * publication state goes to audio.onPublicationState, NOT the video source gate
 * observer: audio demand/mute MUST NOT stop PCM submission or restart epochs/SRC.
 *
 * prepareReceive(context)->Promise<opaqueProof> and assertReceiveReady(proof,context)
 * belong to the GLOBAL Main output owner. Context includes engine, peerId, immutable
 * scope, AbortSignal, reason:'description'|'receiver', and side/descriptionType or
 * selection. The owner must prove selected/running/configured/calibrated CURRENT
 * output before each receiving SDP mutation and receiver enable. There is no
 * cached global ready flag or broker-local last-receiver inference. If normal
 * ADM StopPlayout cannot be observed/proven, reject preparation; do not fake an
 * event, ready epoch, clock anchor or successful audio runtime qualification.
 *
 * bindReceiver(selection,enableAck,proof), revokeReceiver(selection,reason), and
 * onReceiverVolume(selection,volumeAck) are synchronous ownership notifications.
 * Selection includes kind, peer/receiver/epoch, publisher/connection/generation,
 * shareId/screenAudioShareId, publication/metadata/subscription/watch versions,
 * exact binding, group and volume. They must not reenter/await this peer's queue.
 * Audio never enters NativeScreenRoutes. watch/stopWatching govern both kinds;
 * setAudioMuted(session,shareId,muted) and setAudioVolume(session,shareId,0..2)
 * affect audio only. Volume never authorizes an unwatched receiver or alters call deafen.
 *
 * rebindAudioSource(sourceId,{screenAudioShareId,syncGroup?,signal?}) retires old
 * audio publications and awaits a completed LOCAL-offerer turn covering their
 * StopStandard mutation (or proven peer/engine close). Then audio.rebindSource
 * receives {engine,sourceId,previousShareId,screenAudioShareId,syncGroup,signal,
 * isCurrent,callId,channelId} and must return the REAL {sourceId,syncGroup} ACK.
 * That parent hook also coordinates any SFU users before source.setAudioSyncGroup.
 * The broker never creates PCM sources, changes capture epochs, or mutates an
 * existing sender MSID. Republish explicitly after successful rebind; never pick
 * another screen on Stop/Abort. Pending retirement rejects/retains ownership.
 * Signaling delivery must progress independently while callers await audio
 * remove/rebind; those public waits must not block the carrier's receive queue.
 */
const NATIVE_P2P_CONTROL_SCHEMA = Object.freeze({
  protocol: PROTOCOL, version: VERSION, envelope: Object.freeze(ENVELOPE),
  variants: VARIANTS,
  av: Object.freeze({
    version: AV_VERSION, mediaKinds: Object.freeze(['video', 'audio']),
    publicationExtra: Object.freeze(['kind', 'syncGroup']),
    unpublishExtra: Object.freeze(['kind']), watchExtra: Object.freeze(['kind']),
    audioWatchExtra: Object.freeze(['video']), videoSubscriptionFields: VIDEO_SUBSCRIPTION_FIELDS,
  }),
  limits: Object.freeze({ sdpBytes: SDP_BYTES, candidateBytes: 8192, referenceBytes: 128, mediaReferenceBytes: 256, streamIds: 8 }),
});

function fault(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function check(condition, message) {
  if (!condition) throw fault('P2P_PROTOCOL', message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function fields(value, required, optional = []) {
  check(record(value), 'Expected a plain native screen control object.');
  const keys = Reflect.ownKeys(value);
  check(keys.length <= required.length + optional.length
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key))
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && Object.getOwnPropertyDescriptor(value, key)?.set === undefined)
    && required.every(key => Object.hasOwn(value, key)), 'Unexpected or missing native screen control fields.');
}

const positive = value => Number.isSafeInteger(value) && value > 0;
const text = (value, maximum) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0');
const reference = value => text(value, 128);
const share = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value);

function binding(value) {
  check(text(value.trackId, 256) && (value.mid === null || text(value.mid, 256))
    && Array.isArray(value.streamIds) && value.streamIds.length <= 8, 'Invalid negotiated native video binding.');
  const streamIds = Array.from({ length: value.streamIds.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.streamIds, String(index));
    check(descriptor && Object.hasOwn(descriptor, 'value') && text(descriptor.value, 256),
      'Invalid negotiated native video stream reference.');
    return descriptor.value;
  });
  return { trackId: value.trackId, mid: value.mid, streamIds };
}

function sameBinding(left, right) {
  return !!left && !!right && left.trackId === right.trackId && left.mid === right.mid
    && left.streamIds.length === right.streamIds.length
    && left.streamIds.every((id, index) => id === right.streamIds[index]);
}

function candidate(value) {
  check(typeof value.candidate === 'string' && Buffer.byteLength(value.candidate, 'utf8') <= 8192
    && !value.candidate.includes('\0') && (value.sdpMid === null || text(value.sdpMid, 128))
    && (value.sdpMLineIndex === null || (Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0
      && value.sdpMLineIndex <= 65535))
    && (value.sdpMid !== null || value.sdpMLineIndex !== null), 'Invalid native ICE candidate.');
  return { candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMLineIndex };
}

function description(value, type) {
  fields(value, ['type', 'sdp']);
  check(value.type === type && text(value.sdp, SDP_BYTES), 'Invalid native offer/answer SDP.');
  return { type, sdp: value.sdp };
}

function videoSubscription(value) {
  fields(value, VIDEO_SUBSCRIPTION_FIELDS);
  check(VIDEO_SUBSCRIPTION_FIELDS.every(key => positive(value[key])), 'Invalid audio-to-video Watch correlation.');
  return Object.fromEntries(VIDEO_SUBSCRIPTION_FIELDS.map(key => [key, value[key]]));
}

function audioSdp(sdp, side) {
  let sessionDirection = 'sendrecv', current = null;
  const sections = [];
  for (const line of sdp.split(/\r?\n/u)) {
    const section = /^m=(\S+)\s+(\d+)(?:\/\d+)?(?:\s|$)/u.exec(line);
    if (section) {
      current = { kind: section[1], port: Number(section[2]), direction: sessionDirection, bundleOnly: false };
      sections.push(current);
      check(sections.length <= 128, 'Native SDP media section limit exceeded.');
    } else {
      const direction = /^a=(sendrecv|sendonly|recvonly|inactive)$/u.exec(line)?.[1];
      if (direction) {
        if (current) current.direction = direction;
        else sessionDirection = direction;
      } else if (line === 'a=bundle-only' && current) current.bundleOnly = true;
    }
  }
  const active = sections.filter(section => section.kind === 'audio' && (section.port !== 0 || section.bundleOnly)
    && section.direction !== 'inactive');
  return { active: active.length > 0, receiving: active.some(section =>
    section.direction === 'sendrecv' || section.direction === (side === 'remote' ? 'sendonly' : 'recvonly')) };
}

/** Validate unknown input and return an independent, JSON-serializable DTO. */
function parseNativeP2pMessage(value) {
  check(record(value), 'Invalid native screen control message.');
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, 'type');
  check(typeDescriptor && Object.hasOwn(typeDescriptor, 'value')
    && typeof typeDescriptor.value === 'string' && Object.hasOwn(VARIANTS, typeDescriptor.value),
  'Unknown native screen control message type.');
  const type = typeDescriptor.value;
  const version = Object.getOwnPropertyDescriptor(value, 'version')?.value;
  const hasMedia = ['publication', 'unpublish', 'watch'].includes(type);
  const kind = version === AV_VERSION && hasMedia ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : 'video';
  const extra = version === AV_VERSION && hasMedia ? ['kind'] : [];
  if (version === AV_VERSION && type === 'publication') extra.push('syncGroup');
  if (version === AV_VERSION && type === 'watch' && kind === 'audio') extra.push('video');
  fields(value, [...ENVELOPE, ...VARIANTS[type], ...extra]);
  check(value.protocol === PROTOCOL && [VERSION, AV_VERSION].includes(version) && mediaKind(kind)
    && reference(value.callId) && reference(value.channelId) && reference(value.connectionId)
    && positive(value.generation), 'Invalid native screen protocol scope.');
  const result = {
    protocol: PROTOCOL, version, callId: value.callId, channelId: value.channelId,
    connectionId: value.connectionId, generation: value.generation, type,
  };
  if (VARIANTS[type].includes('turn')) {
    check(positive(value.turn), 'Invalid negotiation turn.');
    result.turn = value.turn;
  }
  if (type === 'negotiate') {
    check(positive(value.requestVersion), 'Invalid negotiation request version.');
    result.requestVersion = value.requestVersion;
  } else if (type === 'turn') {
    check(reference(value.offererSessionId), 'Invalid negotiated offerer.');
    result.offererSessionId = value.offererSessionId;
  } else if (type === 'offer' || type === 'answer') {
    check(text(value.sdp, SDP_BYTES), 'Invalid native offer/answer SDP.');
    result.sdp = value.sdp;
  } else if (type === 'ice') {
    Object.assign(result, candidate(value));
  }
  if (['publication', 'unpublish', 'watch'].includes(type)) {
    check(share(value.shareId) && positive(value.publicationId) && positive(value.publicationVersion),
      'Invalid native publication correlation.');
    Object.assign(result, {
      shareId: value.shareId, publicationId: value.publicationId, publicationVersion: value.publicationVersion,
    });
  }
  if (type === 'publication' || type === 'watch') {
    check(positive(value.metadataVersion), 'Invalid native publication metadata version.');
    result.metadataVersion = value.metadataVersion;
  }
  if (type === 'publication') Object.assign(result, binding(value));
  if (version === AV_VERSION && hasMedia) result.kind = kind;
  if (version === AV_VERSION && type === 'publication') {
    check(reference(value.syncGroup), 'Invalid source synchronization group.');
    result.syncGroup = value.syncGroup;
  }
  if (type === 'watch') {
    check(positive(value.subscriptionId) && positive(value.revision) && typeof value.watching === 'boolean',
      'Invalid native Watch subscription.');
    Object.assign(result, { subscriptionId: value.subscriptionId, revision: value.revision, watching: value.watching });
    if (version === AV_VERSION && kind === 'audio') result.video = videoSubscription(value.video);
  }
  return result;
}

function iceConfiguration(value) {
  if (value === undefined) return undefined;
  check(Array.isArray(value) && value.length <= 8, 'Invalid native ICE server configuration.');
  return value.map(server => {
    fields(server, ['urls'], ['username', 'credential']);
    check(Array.isArray(server.urls) && server.urls.length > 0 && server.urls.length <= 4
      && server.urls.every(url => text(url, 2048) && /^(stun|stuns|turn|turns):/u.test(url)),
    'Invalid native ICE server URLs.');
    const result = { urls: [...server.urls] };
    for (const key of ['username', 'credential']) {
      if (server[key] !== undefined) {
        check(typeof server[key] === 'string' && Buffer.byteLength(server[key], 'utf8') <= 512,
          'Invalid native ICE server credentials.');
        result[key] = server[key];
      }
    }
    return result;
  });
}

class NativeP2pBroker {
  constructor({
    engine, commands = new NativeRtcCommands(engine), routes, localSessionId, syncGroup, callId, channelId,
    send, isCurrent = () => true, onError = () => {}, onPublicationState = () => {}, onPeerState = () => {},
    timers = { setTimeout, clearTimeout }, operationTimeoutMs = 12000, turnTimeoutMs = 30000,
    maximumPeers = 32, maximumQueue = 64, maximumIce = 128, maximumReceivers = 64, maximumHistory = 64,
    controlVersion = VERSION, audio = null,
  }) {
    check(isNativeRtcCommandsForEngine(commands, engine) && typeof engine?.cancel === 'function' && typeof commands?.request === 'function'
      && typeof commands?.getPendingRequest === 'function' && positive(commands.nextId),
    'A ready engine and NativeRtcCommands with monotonic request IDs are required.');
    check(['setRoster', 'addPeer', 'removePeer', 'announce', 'setWatching', 'onTrackEvent', 'desiredReceiver', 'confirmReceiver']
      .every(method => typeof routes?.[method] === 'function'), 'NativeScreenRoutes must be injected.');
    check([localSessionId, syncGroup, callId, channelId].every(reference)
      && [send, isCurrent, onError, onPublicationState, onPeerState].every(value => typeof value === 'function')
      && typeof timers?.setTimeout === 'function' && typeof timers?.clearTimeout === 'function',
    'Invalid native P2P broker dependencies or scope.');
    check([VERSION, AV_VERSION].includes(controlVersion), 'Unsupported explicit native CONTROL version.');
    check(audio === null || (controlVersion === AV_VERSION
      && ['prepareReceive', 'assertReceiveReady', 'expectedOutputEpoch', 'bindReceiver', 'revokeReceiver', 'onReceiverVolume']
        .every(method => typeof audio?.[method] === 'function')
      && (audio.onPublicationState === undefined || typeof audio.onPublicationState === 'function')
      && (audio.rebindSource === undefined || typeof audio.rebindSource === 'function')),
    'Audio requires CONTROL v2 and a separate output/receiver adapter.');
    check(Number.isInteger(operationTimeoutMs) && operationTimeoutMs >= 100 && operationTimeoutMs <= 60000
      && Number.isInteger(turnTimeoutMs) && turnTimeoutMs >= 100 && turnTimeoutMs <= 120000,
    'Invalid native P2P timeouts.');
    for (const [value, maximum] of [[maximumPeers, 64], [maximumQueue, 128], [maximumIce, 256],
      [maximumReceivers, 64], [maximumHistory, 128]]) {
      check(Number.isInteger(value) && value >= 1 && value <= maximum, 'Invalid bounded native P2P capacity.');
    }
    Object.assign(this, { engine, commands, routes, send, isCurrent, onError, onPublicationState, onPeerState, audio,
      timers, operationTimeoutMs, turnTimeoutMs, maximumPeers, maximumQueue, maximumIce, maximumReceivers, maximumHistory });
    for (const [key, value] of Object.entries({ localSessionId, syncGroup, callId, channelId, controlVersion })) {
      Object.defineProperty(this, key, { value, enumerable: true });
    }
    this.peers = new Map();
    this.nativePeers = new Map();
    this.generations = new Map();
    this.roster = new Map();
    this.sources = new Map();
    this.currentSources = new Map();
    this.earlyEvents = new Map();
    this.nextPublication = 1;
    this.nextSubscription = 1;
    this.nextWatchRevision = 1;
    this.closed = false;
    this.engineClosing = false;
    this.engineRetired = false;
    this.nextAudioWatchVersion = 1;
  }

  _next(key) {
    check(positive(this[key]), 'Native screen generations are exhausted.');
    return this[key]++;
  }

  _scope(peer) {
    return { callId: this.callId, channelId: this.channelId, remoteSessionId: peer.remoteSessionId,
      connectionId: peer.connectionId, generation: peer.generation };
  }

  _live(peer) {
    return !this.closed && ['opening', 'open'].includes(peer.status)
      && this.peers.get(peer.remoteSessionId) === peer && this.isCurrent(this._scope(peer)) === true;
  }

  _assertLive(peer) {
    if (!this._live(peer)) {
      if (['opening', 'open'].includes(peer.status)) {
        this._beginClose(peer);
        this._scheduleCleanup(peer);
      }
      throw fault('P2P_CANCELLED', 'Native screen peer is no longer current.');
    }
  }

  _report(peer, error) {
    try { this.onError(error, peer ? this._scope(peer) : { callId: this.callId, channelId: this.channelId }); } catch {}
  }

  _notify(callback, value, peer) {
    try {
      const result = callback(value);
      if (result && typeof result.then === 'function') result.catch(error => this._report(peer, error));
    } catch (error) { this._report(peer, error); }
  }

  _state(peer) {
    if (this.peers.get(peer.remoteSessionId) === peer) {
      this._notify(this.onPeerState, this.getPeer(peer.remoteSessionId), peer);
    }
  }

  _queue(peer, work, { closing = false, fatal = true, bytes = 0 } = {}) {
    if (peer.queued >= this.maximumQueue || peer.queuedBytes + bytes > 2 * SDP_BYTES + 65536) {
      const error = fault('P2P_QUEUE_LIMIT', 'Bounded native screen peer queue is full.');
      this._fail(peer, error);
      return Promise.reject(error);
    }
    peer.queued++;
    peer.queuedBytes += bytes;
    const pending = peer.chain.then(async () => {
      if (!closing) this._assertLive(peer);
      return work();
    }).catch(error => {
      const expectedCancellation = error.code === 'P2P_CANCELLED'
        || (['CANCELLED', 'ERR_RTC_CANCELLED'].includes(error.code) && !this._live(peer));
      if (fatal && !expectedCancellation) this._fail(peer, error);
      throw error;
    }).finally(() => { peer.queued--; peer.queuedBytes -= bytes; });
    peer.chain = pending.catch(() => {});
    return pending;
  }

  _background(peer, work, options) {
    this._queue(peer, work, options).catch(error => {
      if (error.code !== 'P2P_CANCELLED' && !peer.error) this._report(peer, error);
    });
  }

  _deadline(peer, promise, message, onTimeout = () => {}) {
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        peer.waiters.delete(retire);
        callback(value);
      };
      const retire = () => settle(reject, fault('P2P_CANCELLED', 'The native engine completed full retirement.'));
      peer.waiters.add(retire);
      timer = this.timers.setTimeout(() => {
        const error = fault('P2P_TIMEOUT', message);
        onTimeout(error);
        settle(reject, error);
      }, this.operationTimeoutMs);
      Promise.resolve(promise).then(value => settle(resolve, value), error => settle(reject, error));
    });
  }

  _cancel(peer, request) {
    if (this.engineClosing || request.cancelled || request.operation === 'resource.close') return;
    request.cancelled = true;
    try {
      const current = this.commands.getPendingRequest(request.id);
      if (current && current.operation === request.operation && current.target === request.target) {
        this.engine.cancel(request.id);
      }
    } catch (error) {
      // Native completion can precede delivery of its JS Promise. Retirement
      // still waits for that original request; failed cancellation is not proof.
      if (error.code === 'ERR_RTC_REQUEST_ID' && error.status === 4) return;
      if (!['NOT_FOUND', 'ERR_RTC_NOT_FOUND', 'ERR_RTC_UNKNOWN_REQUEST'].includes(error.code)) this._report(peer, error);
    }
  }

  _request(peer, operation, target, data, commit = () => {}, afterSettled = () => {}) {
    if (this.engineClosing) throw fault('P2P_CANCELLED', 'Native commands are blocked during full engine shutdown.');
    const id = this.commands.nextId;
    check(positive(id) && peer.pending.size < 128, 'Native command capacity or identifiers exhausted.');
    const request = { id, operation, target, data, cancelled: false, expired: false };
    const raw = this.commands.request(operation, target, data);
    const admitted = this.commands.getPendingRequest(id);
    check(!admitted || (admitted.id === id && admitted.operation === operation && admitted.target === target),
      'Native command ID correlation failed.');
    peer.pending.set(id, request);
    const completion = Promise.resolve(raw).then(result => {
      if (!this.engineRetired) commit(result);
      return result;
    }).finally(() => {
      peer.pending.delete(id);
      if (request.expired && !this._live(peer)) this._scheduleCleanup(peer);
      afterSettled(request);
      this._collectSources();
    });
    request.completion = completion;
    completion.catch(error => {
      if (request.expired && !this.engineRetired) this._report(peer, error);
    });
    return this._deadline(peer, completion, `Native ${operation} did not complete; ownership is retained.`, () => {
      request.expired = true;
      this._cancel(peer, request);
    });
  }

  async _send(peer, payload) {
    this._assertLive(peer);
    try {
      const message = parseNativeP2pMessage({
        protocol: PROTOCOL, version: this.controlVersion, callId: this.callId, channelId: this.channelId,
        connectionId: peer.connectionId, generation: peer.generation, ...payload,
      });
      const queued = this.send(peer.remoteSessionId, message);
      check(queued && typeof queued.then === 'function', 'Native signaling send must return an enqueue Promise.');
      await this._deadline(peer, queued, 'Native signaling enqueue timed out.');
      this._assertLive(peer);
    } catch (error) {
      if (error.code !== 'P2P_CANCELLED') this._fail(peer, error);
      throw error;
    }
  }

  _requireAudio() {
    if (this.controlVersion !== AV_VERSION || !this.audio) {
      throw fault('P2P_AUDIO_UNAVAILABLE', 'Native screen audio requires explicit CONTROL v2 and a ready-owner adapter.');
    }
  }

  _audioContext(peer, reason, extra = {}) {
    return { ...this._scope(peer), peerId: peer.peerId, engine: this.engine,
      signal: peer.controller.signal, reason, ...extra };
  }

  _audioNotify(peer, method, ...args) {
    this._requireAudio();
    try {
      const result = this.audio[method](...args);
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(error => this._report(peer, error));
        throw fault('P2P_AUDIO_ADAPTER', `Audio ${method} must update its ownership synchronously.`);
      }
      check(method !== 'bindReceiver' || result !== false, 'Audio receiver binding was refused by its owner.');
    } catch (error) {
      this._fail(peer, error);
      throw error;
    }
  }

  _assertAudioReady(proof, context) {
    check((proof !== null && typeof proof === 'object') || typeof proof === 'symbol', 'Audio output requires an opaque owner readiness proof.');
    const result = this.audio.assertReceiveReady(proof, context);
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(error => this._report(null, error));
      throw fault('P2P_AUDIO_ADAPTER', 'Audio readiness assertion must be synchronous.');
    }
    check(result === undefined || result === true, 'Current global audio output readiness was not proven.');
  }

  _expectedAudioOutputEpoch(readiness) {
    this._assertAudioReady(readiness.proof, readiness.context);
    const epoch = this.audio.expectedOutputEpoch(readiness.proof, readiness.context);
    if (epoch && typeof epoch.then === 'function') {
      void Promise.resolve(epoch).catch(error => this._report(null, error));
      throw fault('P2P_AUDIO_ADAPTER', 'Expected audio output epoch must be synchronous.');
    }
    check(positive(epoch), 'Expected audio output epoch must come from the same preparation.');
    return epoch;
  }

  async _prepareAudioReceive(peer, reason, extra = {}) {
    this._requireAudio();
    this._assertLive(peer);
    const context = this._audioContext(peer, reason, extra);
    const pending = this.audio.prepareReceive(context);
    check(pending && typeof pending.then === 'function', 'Audio preparation must return a real readiness Promise.');
    const proof = await this._deadline(peer, pending, 'Native audio output preparation timed out.');
    this._assertLive(peer);
    this._assertAudioReady(proof, context);
    return { proof, context };
  }

  async _setDescription(peer, side, value) {
    const audio = audioSdp(value.sdp, side);
    if (audio.active) this._requireAudio();
    const readiness = audio.receiving
      ? await this._prepareAudioReceive(peer, 'description', { side, descriptionType: value.type }) : null;
    this._assertLive(peer);
    const data = readiness ? { ...value, expectedOutputEpoch: this._expectedAudioOutputEpoch(readiness) } : value;
    return this._request(peer, side === 'local' ? 'peer.setLocalDescription' : 'peer.setRemoteDescription', peer.peerId, data);
  }

  /** Trusted roster updates only; never populate this from receive() payloads. */
  async setRoster(publisherSessionId, shareIds) {
    check(!this.closed && reference(publisherSessionId) && Array.isArray(shareIds) && shareIds.length <= 2
      && [...shareIds].every(share) && new Set(shareIds).size === shareIds.length,
    'Invalid authenticated native screen roster.');
    check(this.roster.has(publisherSessionId) || this.roster.size < this.maximumHistory, 'Native roster history is full.');
    const allowed = new Set(shareIds);
    this.routes.setRoster(publisherSessionId, shareIds);
    this.roster.set(publisherSessionId, allowed);
    if (publisherSessionId === this.localSessionId) {
      await Promise.all([...this.sources.values()].filter(source => source.active && !allowed.has(source.localShareId))
        .map(source => this.removeSource(source.sourceId)));
      return;
    }
    const peer = this.peers.get(publisherSessionId);
    if (!peer || !this._live(peer)) return;
    for (const [shareId, watch] of peer.watches) {
      if (!allowed.has(shareId)) {
        this.routes.setWatching(publisherSessionId, shareId, null);
        watch.active = false;
        watch.revision = this._next('nextWatchRevision');
        this._touchAudioWatch(peer, watch, 'roster-revoked');
      }
    }
    for (const publication of peer.remotePublications.values()) {
      if (!allowed.has(publication.shareId)) publication.retired = true;
    }
    await this._queue(peer, async () => {
      for (const watch of peer.watches.values()) {
        if (!watch.active) {
          await this._sendWatch(peer, watch);
          await this._sendAudioWatch(peer, watch);
        }
      }
      await this._syncReceivers(peer);
    });
  }

  /** Register only an existing capture-bridge-owned, initially disabled source. */
  registerSource({ sourceId, localShareId, syncGroup, kind = 'video', screenAudioShareId }) {
    check(!this.closed && positive(sourceId) && share(localShareId) && reference(syncGroup) && mediaKind(kind)
      && this.roster.get(this.localSessionId)?.has(localShareId), 'Source is not owned by the authenticated local screen roster/syncGroup.');
    const key = mediaKey(kind, localShareId);
    check(!this.sources.has(sourceId) && !this.currentSources.has(key)
      && this.sources.size < this.maximumHistory, 'Duplicate or retained native screen source registration.');
    let associatedVideo = null;
    if (kind === 'audio') {
      this._requireAudio();
      check(screenAudioShareId === localShareId && ![...this.sources.values()].some(source => source.kind === 'audio'),
        'Exactly one PCM source must name its explicit screenAudioShareId.');
      associatedVideo = this.sources.get(this.currentSources.get(localShareId));
      check(associatedVideo?.active && associatedVideo.kind === 'video' && associatedVideo.syncGroup === syncGroup,
        'Audio must use the explicitly selected active video source group.');
    } else {
      check(screenAudioShareId === undefined
        && ![...this.sources.values()].some(source => source.kind === 'video' && source.syncGroup === syncGroup),
      'Video sources require unique synchronization groups.');
      check([...this.sources.values()].filter(source => source.active && source.kind === 'video').length < 2,
        'At most two video sources may be active.');
    }
    this.sources.set(sourceId, { sourceId, localShareId, syncGroup, kind, associatedVideo, active: true,
      associationRevision: 1, rebinding: false, rebindController: null, waiters: new Set() });
    this.currentSources.set(key, sourceId);
    if (kind === 'audio') return { sourceId, localShareId, screenAudioShareId, syncGroup, kind };
    return { sourceId, localShareId, syncGroup };
  }

  registerAudioSource({ sourceId, screenAudioShareId, syncGroup }) {
    return this.registerSource({ sourceId, localShareId: screenAudioShareId, screenAudioShareId, syncGroup, kind: 'audio' });
  }

  connect(remoteSessionId, { connectionId, generation, iceServers } = {}) {
    check(!this.closed && reference(remoteSessionId) && remoteSessionId !== this.localSessionId
      && reference(connectionId) && positive(generation) && this.roster.has(remoteSessionId),
    'Native peer needs an authenticated participant and agreed connection generation.');
    const configuration = iceConfiguration(iceServers);
    const existing = this.peers.get(remoteSessionId);
    if (existing) {
      check(existing.connectionId === connectionId && existing.generation === generation && this._live(existing),
        'Close and retire the previous native peer before reconnecting.');
      return existing.openPromise;
    }
    const previous = this.generations.get(remoteSessionId);
    check(!previous || (generation > previous.generation && connectionId !== previous.connectionId),
      'Native peer replacement requires a fresh nonce and increasing generation.');
    check(this.peers.size < this.maximumPeers
      && (previous || this.generations.size < this.maximumHistory), 'Native peer/history limit reached.');
    const peer = {
      remoteSessionId, connectionId, generation, peerId: null, status: 'opening', error: null, nativeState: {},
      chain: Promise.resolve(), queued: 0, queuedBytes: 0, pending: new Map(), resources: new Map(), waiters: new Set(),
      publications: new Map(), currentPublications: new Map(), remotePublications: new Map(),
      pendingMetadata: new Map(), receivers: new Map(), watches: new Map(), ice: [],
      receiving: false, receiverSyncScheduled: false, pumpScheduled: false,
      leader: this.localSessionId < remoteSessionId, dirty: false, remoteDirty: false,
      localRequestVersion: 0, remoteRequestVersion: 0, requestOutstanding: false,
      grantTimer: null,
      sequence: 0, completedTurn: 0, turn: null, lastOfferer: remoteSessionId,
      remoteDescriptionTurn: 0, localDescriptionTurn: 0, cleanupScheduled: false, closePromise: null,
      controller: new AbortController(), mutationVersion: 0, negotiatedMutation: 0, audioRetirements: new Map(),
      audioPreferences: new Map(),
    };
    this.peers.set(remoteSessionId, peer);
    this.generations.set(remoteSessionId, { generation, connectionId });
    peer.openPromise = this._queue(peer, async () => {
      const data = { syncGroup: this.syncGroup, receiveVideo: false };
      if (configuration !== undefined) data.iceServers = configuration;
      await this._request(peer, 'peer.create', 0, data, result => {
        check(positive(result?.peerId), 'Native peer.create returned no actual peer ID.');
        peer.peerId = result.peerId;
        peer.resources.set(result.peerId, { id: result.peerId, kind: 'peer', closing: false });
        this.nativePeers.set(result.peerId, peer);
      });
      this._assertLive(peer);
      this.routes.addPeer(peer.peerId, remoteSessionId, connectionId);
      peer.status = 'open';
      const early = this.earlyEvents.get(peer.peerId) ?? [];
      this.earlyEvents.delete(peer.peerId);
      for (const event of early) this.handleNativeEvent(event);
      this._state(peer);
      return peer.peerId;
    });
    return peer.openPromise;
  }

  publish(sourceId, remoteSessionId, options = {}) {
    const source = this.sources.get(sourceId), peer = this.peers.get(remoteSessionId);
    check(source?.active && !source.rebinding && this.currentSources.get(mediaKey(source.kind, source.localShareId)) === sourceId
      && this.roster.get(this.localSessionId)?.has(source.localShareId) && peer && this._live(peer),
    'Cannot publish an unowned source or obsolete native peer.');
    const { signal } = options;
    check(signal === undefined || signal instanceof AbortSignal, 'Invalid publication AbortSignal.');
    if (signal?.aborted) return Promise.reject(fault('P2P_CANCELLED', 'Native publication start was aborted.'));
    const isAudio = source.kind === 'audio';
    const key = mediaKey(source.kind, source.localShareId);
    const previous = peer.currentPublications.get(key);
    const maxBitrateBps = options.maxBitrateBps ?? (isAudio ? 64000 : 8000000);
    const maxFramerate = isAudio ? undefined : (options.maxFramerate ?? 30);
    if (isAudio) {
      this._requireAudio();
      check(source.associatedVideo?.active && this.currentSources.get(source.localShareId) === source.associatedVideo.sourceId
        && source.syncGroup === source.associatedVideo.syncGroup, 'Audio has no current explicitly associated screen.');
      check(options.maxFramerate === undefined && maxBitrateBps >= 6000 && maxBitrateBps <= 510000,
        'Native Opus bitrate must be 6000..510000 and has no video framerate.');
      check(![...peer.publications.values()].some(publication => publication.kind === 'audio' && publication !== previous),
        'A retained audio publication must retire before another one starts.');
      check(peer.audioRetirements.size === 0, 'Await the completed StopStandard negotiation before publishing audio.');
    }
    check(Number.isInteger(maxBitrateBps) && maxBitrateBps >= 1 && maxBitrateBps <= 2147483647
      && (isAudio || (Number.isInteger(maxFramerate) && maxFramerate >= 1 && maxFramerate <= 240)), 'Invalid native encoding limits.');
    if (previous) {
      check(previous.source === source && previous.active, 'Retire the previous screen publication before replacing it.');
      return previous.startPromise.then(() => this._publicationDto(previous));
    }
    check(peer.publications.size < this.maximumHistory, 'Native publication history is full.');
    const publication = {
      source, shareId: source.localShareId, publicationId: null, publicationVersion: this._next('nextPublication'),
      kind: source.kind, key, syncGroup: source.syncGroup, maxBitrateBps, maxFramerate,
      metadataVersion: 1, binding: null, active: true, demanded: false, requestedEnabled: false,
      enabled: false, watch: null, lastWatchRevision: 0,
      announcedVersion: 0, updateScheduled: false, retirementScheduled: false,
      retirement: null, nativeRetired: false, abortSignal: signal, abortListener: null,
      retirementGateClosed: false,
    };
    peer.publications.set(publication.publicationVersion, publication);
    peer.currentPublications.set(key, publication);
    if (signal) {
      publication.abortListener = () => {
        this._invalidatePublication(peer, publication);
        for (const pending of peer.pending.values()) {
          if (publicationOperation(pending.operation) && pending.data.sourceId === sourceId) this._cancel(peer, pending);
        }
        this._schedulePublicationRetirement(peer, publication);
      };
      signal.addEventListener('abort', publication.abortListener, { once: true });
    }
    publication.startPromise = this._queue(peer, async () => {
      if (!publication.active || !source.active) {
        throw fault('P2P_CANCELLED', 'Native source was removed before publication started.');
      }
      try {
        const data = { sourceId, enabled: false, maxBitrateBps };
        if (!isAudio) data.maxFramerate = maxFramerate;
        await this._request(peer, isAudio ? 'peer.publishAudio' : 'peer.publish', peer.peerId, data, result => {
            check(positive(result?.publicationId), 'Native peer.publish returned no actual publication ID.');
            publication.publicationId = result.publicationId;
            peer.publications.set(publication.publicationVersion, publication);
            peer.resources.set(result.publicationId, { id: result.publicationId, kind: 'publication', publication, closing: false });
            publication.binding = binding(result);
            check((result.kind === undefined && !isAudio) || result.kind === source.kind, 'Native publication returned the wrong media kind.');
            if (this.controlVersion === AV_VERSION) {
              check(publication.binding.streamIds.includes(publication.syncGroup), 'Native sender MSID does not match the registered source group.');
            }
            const early = peer.pendingMetadata.get(result.publicationId);
            if (early) {
              check(early.kind === undefined || early.kind === source.kind, 'Early native metadata has the wrong media kind.');
              publication.binding = binding(early);
              if (this.controlVersion === AV_VERSION) {
                check(publication.binding.streamIds.includes(publication.syncGroup), 'Early native metadata has the wrong source MSID.');
              }
              peer.pendingMetadata.delete(result.publicationId);
            }
          }, request => {
            if (request.expired && (!publication.active || !source.active
              || peer.currentPublications.get(publication.key) !== publication)) {
              this._schedulePublicationRetirement(peer, publication);
            }
          });
      } catch (error) {
        if (!publication.active || !source.active || !this._live(peer)) {
          if (!['CANCELLED', 'ERR_RTC_CANCELLED', 'P2P_CANCELLED'].includes(error.code)) this._report(peer, error);
          const cancelled = fault('P2P_CANCELLED', 'Native publication creation was cancelled by Stop.');
          cancelled.cause = error;
          throw cancelled;
        }
        throw error;
      }
      if (!this._live(peer) || !publication.active || !source.active) {
        await this._retirePublication(peer, publication, false);
        throw fault('P2P_CANCELLED', 'Native publication creation completed after Stop.');
      }
      await this._announce(peer, publication);
      this._markNegotiation(peer, true);
      return this._publicationDto(publication);
    });
    return publication.startPromise;
  }

  _publicationDto(publication) {
    return { shareId: publication.shareId, publicationId: publication.publicationId,
      publicationVersion: publication.publicationVersion, metadataVersion: publication.metadataVersion,
      ...(publication.binding ? binding(publication.binding) : {}),
      ...(this.controlVersion === AV_VERSION ? { kind: publication.kind, syncGroup: publication.syncGroup } : {}) };
  }

  publishAudio(sourceId, remoteSessionId, options = {}) {
    check(this.sources.get(sourceId)?.kind === 'audio', 'publishAudio requires the registered PCM source.');
    return this.publish(sourceId, remoteSessionId, options);
  }

  rebindAudioSource(sourceId, { screenAudioShareId, syncGroup, signal } = {}) {
    this._requireAudio();
    const source = this.sources.get(sourceId);
    const video = this.sources.get(this.currentSources.get(screenAudioShareId));
    check(!this.closed && source?.active && source.kind === 'audio' && !source.rebinding
      && share(screenAudioShareId) && this.roster.get(this.localSessionId)?.has(screenAudioShareId)
      && video?.active && video.kind === 'video', 'Audio rebind requires an explicitly selected active screen.');
    check((syncGroup === undefined || syncGroup === video.syncGroup)
      && typeof this.audio.rebindSource === 'function', 'Audio source rebind needs the parent source-owner hook and exact video group.');
    check(signal === undefined || signal instanceof AbortSignal, 'Invalid audio rebind AbortSignal.');
    if (signal?.aborted) return Promise.reject(fault('P2P_CANCELLED', 'Audio source rebind was aborted.'));
    const revision = ++source.associationRevision, controller = new AbortController();
    check(positive(revision), 'Audio association revisions exhausted.');
    source.rebinding = true;
    source.rebindController = controller;
    source.rebindTarget = video;
    const abort = () => controller.abort(fault('P2P_CANCELLED', 'Audio source rebind was aborted.'));
    signal?.addEventListener('abort', abort, { once: true });
    const current = () => !this.closed && !controller.signal.aborted && source.active
      && this.sources.get(sourceId) === source && source.associationRevision === revision
      && video.active && this.sources.get(this.currentSources.get(screenAudioShareId)) === video;
    const retirements = [];
    for (const peer of this.peers.values()) {
      for (const publication of peer.publications.values()) {
        if (publication.source !== source) continue;
        this._invalidatePublication(peer, publication);
        retirements.push({ peer, publication });
      }
    }
    let groupAttempted = false;
    const workflow = (async () => {
      const outcomes = await Promise.allSettled(retirements.map(({ peer, publication }) =>
        this._queue(peer, () => this._retirePublication(peer, publication, this._live(peer)), { closing: true, fatal: false })));
      const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
      if (failures.length) throw new AggregateError(failures, 'Audio rebind retains old publication ownership.');
      await Promise.all(retirements.map(({ peer, publication }) => this._waitAudioRetirement(peer, publication)));
      if (!current()) throw fault('P2P_CANCELLED', 'Audio rebind selection is no longer current.');
      groupAttempted = true;
      const pending = this.audio.rebindSource({
        engine: this.engine, sourceId, previousShareId: source.localShareId, screenAudioShareId,
        syncGroup: video.syncGroup, signal: controller.signal, isCurrent: current,
        callId: this.callId, channelId: this.channelId,
      });
      check(pending && typeof pending.then === 'function', 'Audio source rebind must return a native acknowledgement Promise.');
      const result = await pending;
      check(result?.sourceId === sourceId && result.syncGroup === video.syncGroup, 'Audio source rebind acknowledgement does not match its owner.');
      if (!this.engineRetired && this.sources.get(sourceId) === source) source.syncGroup = result.syncGroup;
      if (!current()) {
        source.associatedVideo = null;
        throw fault('P2P_CANCELLED', 'Audio source changed group after its selection was cancelled; explicit reassociation is required.');
      }
      const oldKey = mediaKey('audio', source.localShareId);
      if (this.currentSources.get(oldKey) === sourceId) this.currentSources.delete(oldKey);
      source.localShareId = screenAudioShareId;
      source.associatedVideo = video;
      this.currentSources.set(mediaKey('audio', screenAudioShareId), sourceId);
      return { sourceId, kind: 'audio', screenAudioShareId, localShareId: screenAudioShareId, syncGroup: source.syncGroup };
    })().catch(error => {
      if (groupAttempted && !this.engineRetired && this.sources.get(sourceId) === source) source.associatedVideo = null;
      throw error;
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
      source.rebinding = false;
      source.rebindController = null;
      source.rebindTarget = null;
      this._collectSources();
    });
    const interrupted = new Promise((_resolve, reject) => {
      const cancel = () => reject(fault('P2P_CANCELLED', 'Audio source rebind was aborted; retirement remains owned.'));
      controller.signal.addEventListener('abort', cancel, { once: true });
      void workflow.finally(() => controller.signal.removeEventListener('abort', cancel)).catch(() => {});
    });
    return this._deadline(source, Promise.race([workflow, interrupted]), 'Audio source rebind is still pending; ownership is retained.',
      () => controller.abort(fault('P2P_TIMEOUT', 'Audio source rebind timed out.')));
  }

  getAudioSource() {
    const source = [...this.sources.values()].find(value => value.kind === 'audio');
    return source ? { sourceId: source.sourceId, kind: 'audio', syncGroup: source.syncGroup,
      screenAudioShareId: source.associatedVideo?.active ? source.localShareId : null,
      active: source.active, rebinding: source.rebinding, associationRevision: source.associationRevision } : null;
  }

  async _announce(peer, publication) {
    if (!publication.active || !publication.publicationId) return;
    const dto = this._publicationDto(publication);
    await this._send(peer, { type: 'publication', ...dto });
    publication.announcedVersion = dto.metadataVersion;
  }

  _publicationDesired(peer, publication) {
    const selected = this._live(peer) && publication.active && publication.source.active && !publication.source.rebinding
      && peer.currentPublications.get(publication.key) === publication
      && this.roster.get(this.localSessionId)?.has(publication.shareId)
      && publication.watch?.watching === true
      && publication.watch.metadataVersion === publication.metadataVersion;
    if (!selected || publication.kind === 'video') return !!selected;
    const video = peer.currentPublications.get(publication.shareId), expected = publication.watch.video;
    return !!video && video.kind === 'video' && this._publicationDesired(peer, video)
      && publication.source.associatedVideo === video.source && publication.syncGroup === video.syncGroup
      && expected?.publicationId === video.publicationId && expected.publicationVersion === video.publicationVersion
      && expected.metadataVersion === video.metadataVersion && expected.subscriptionId === video.watch.subscriptionId
      && expected.revision === video.watch.revision;
  }

  _publicationState(peer, publication) {
    publication.demanded = !!this._publicationDesired(peer, publication);
    const callback = publication.kind === 'audio' ? this.audio?.onPublicationState : this.onPublicationState;
    if (!callback) return;
    this._notify(publication.kind === 'audio' ? callback.bind(this.audio) : callback, {
      ...this._scope(peer), sourceId: publication.source.sourceId, localShareId: publication.shareId,
      publicationId: publication.publicationId, publicationVersion: publication.publicationVersion,
      demanded: publication.demanded, requestedEnabled: publication.requestedEnabled, enabled: publication.enabled,
      ...(publication.kind === 'audio' ? { kind: 'audio', screenAudioShareId: publication.shareId, syncGroup: publication.syncGroup } : {}),
    }, peer);
  }

  _updatePublicationDemand(peer, publication) {
    if (publication.demanded !== !!this._publicationDesired(peer, publication)) this._publicationState(peer, publication);
  }

  async _syncPublication(peer, publication) {
    if (!publication.publicationId || !peer.resources.has(publication.publicationId)) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      this._updatePublicationDemand(peer, publication);
      const enabled = !!this._publicationDesired(peer, publication);
      if (publication.requestedEnabled === enabled) return;
      const result = await this._request(peer, 'peer.setPublicationEnabled', publication.publicationId, { enabled });
      if (this.engineRetired) return;
      check(typeof result?.enabled === 'boolean' && (enabled || result.enabled === false),
        'Invalid native effective sender gate acknowledgement.');
      publication.requestedEnabled = enabled;
      publication.enabled = result.enabled;
      this._publicationState(peer, publication);
    }
    throw fault('P2P_GATE_CHURN', 'Native publication authorization changed repeatedly during gate acknowledgement.');
  }

  async removeSource(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.active = false;
    source.associationRevision++;
    source.rebindController?.abort(fault('P2P_CANCELLED', 'The PCM source was removed.'));
    if (source.kind === 'video') {
      for (const audio of this.sources.values()) {
        if (audio.kind === 'audio' && audio.rebindTarget === source) {
          audio.rebindController?.abort(fault('P2P_CANCELLED', 'The selected audio rebind screen was removed.'));
        }
      }
    }
    const sourceKey = mediaKey(source.kind, source.localShareId);
    if (this.currentSources.get(sourceKey) === sourceId) this.currentSources.delete(sourceKey);
    const jobs = [];
    const retired = [];
    for (const peer of this.peers.values()) {
      const publications = [...peer.publications.values()].filter(publication => publication.source === source
        || (source.kind === 'video' && publication.kind === 'audio' && publication.source.associatedVideo === source));
      for (const publication of publications) {
        this._invalidatePublication(peer, publication);
        retired.push({ peer, publication });
      }
      for (const pending of peer.pending.values()) {
        if (publicationOperation(pending.operation) && publications.some(publication => pending.data.sourceId === publication.source.sourceId)) {
          this._cancel(peer, pending);
        }
      }
      if (publications.length) {
        jobs.push(this._queue(peer, async () => {
          for (const publication of publications) await this._retirePublication(peer, publication, this._live(peer));
        }, { closing: true, fatal: false }));
      }
    }
    const results = await Promise.allSettled(jobs);
    const waits = await Promise.allSettled(retired.map(({ peer, publication }) => this._waitAudioRetirement(peer, publication)));
    this._collectSources();
    const errors = [...results, ...waits].filter(result => result.status === 'rejected').map(result => result.reason);
    if (!errors.length && this.sources.get(sourceId) === source) {
      errors.push(fault('P2P_OWNERSHIP_RETAINED', 'Native source publication retirement is still unproven.'));
    }
    if (errors.length) throw new AggregateError(errors, 'Native publication retirement failed; source ownership is retained.');
  }

  _schedulePublicationRetirement(peer, publication) {
    if (this.engineClosing || !this._live(peer) || publication.retirementScheduled) return;
    publication.retirementScheduled = true;
    this._queue(peer, async () => {
      if (!publication.active || !publication.source.active
        || peer.currentPublications.get(publication.key) !== publication) {
        await this._retirePublication(peer, publication, this._live(peer));
      }
    }, { closing: true, fatal: false }).catch(error => {
      if (error.code !== 'P2P_CANCELLED') this._report(peer, error);
    }).finally(() => {
      publication.retirementScheduled = false;
      this._collectSources();
    });
  }

  async _retirePublication(peer, publication, announce) {
    this._invalidatePublication(peer, publication);
    const creating = [...peer.pending.values()].filter(request =>
      publicationOperation(request.operation) && request.data.sourceId === publication.source.sourceId);
    if (creating.length) {
      const error = fault('P2P_OWNERSHIP_RETAINED', 'Native publication creation has not completed its retirement proof.');
      Object.assign(error, { sourceId: publication.source.sourceId, publicationVersion: publication.publicationVersion,
        requestIds: creating.map(request => request.id) });
      throw error;
    }
    const resource = publication.publicationId && peer.resources.get(publication.publicationId);
    if (resource) {
      if (publication.kind === 'audio' && !publication.retirementGateClosed) {
        const stopped = await this._request(peer, 'peer.setPublicationEnabled', publication.publicationId, { enabled: false });
        if (this.engineRetired) return;
        check(stopped?.enabled === false, 'Audio retirement did not acknowledge the sender RTP gate closing.');
        publication.requestedEnabled = false;
        publication.enabled = false;
        publication.retirementGateClosed = true;
        this._publicationState(peer, publication);
      }
      await this._closeResource(peer, resource);
    }
    if (announce && publication.announcedVersion && !publication.unpublished) {
      await this._send(peer, { type: 'unpublish', shareId: publication.shareId, publicationId: publication.publicationId,
        publicationVersion: publication.publicationVersion,
        ...(this.controlVersion === AV_VERSION ? { kind: publication.kind } : {}) });
      publication.unpublished = true;
    }
    if ((!publication.publicationId || !peer.resources.has(publication.publicationId))
      && (!publication.retirement || publication.retirement.proven)) {
      peer.publications.delete(publication.publicationVersion);
    }
    if (announce) this._markNegotiation(peer);
  }

  _collectSources() {
    for (const [id, source] of this.sources) {
      if (source.active) continue;
      if (source.rebinding && !this.engineRetired) continue;
      const used = [...this.peers.values()].some(peer =>
        [...peer.publications.values()].some(publication => publication.source === source
          || (publication.kind === 'audio' && publication.source.associatedVideo === source))
        || [...peer.pending.values()].some(request => publicationOperation(request.operation) && request.data.sourceId === id));
      if (!used) this.sources.delete(id);
    }
  }

  _invalidatePublication(peer, publication) {
    publication.active = false;
    if (peer.currentPublications.get(publication.key) === publication) peer.currentPublications.delete(publication.key);
    if (publication.abortListener) {
      publication.abortSignal.removeEventListener('abort', publication.abortListener);
      publication.abortListener = null;
    }
    this._updatePublicationDemand(peer, publication);
    if (publication.kind === 'video') {
      const audio = peer.currentPublications.get(mediaKey('audio', publication.shareId));
      if (audio?.source.associatedVideo === publication.source) {
        this._invalidatePublication(peer, audio);
        this._schedulePublicationRetirement(peer, audio);
      }
    }
  }

  _startAudioRetirement(peer, publication) {
    if (publication.retirement) return;
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    check(positive(peer.mutationVersion + 1), 'Native SDP mutation versions exhausted.');
    const retirement = { promise, resolve, proven: false, requiredMutation: ++peer.mutationVersion };
    publication.retirement = retirement;
    peer.audioRetirements.set(publication.publicationVersion, publication);
    this._markNegotiation(peer);
  }

  _proveAudioRetirement(peer, publication, proof) {
    const retirement = publication.retirement;
    if (!retirement || retirement.proven) return;
    retirement.proven = true;
    peer.audioRetirements.delete(publication.publicationVersion);
    peer.publications.delete(publication.publicationVersion);
    retirement.resolve({ peerId: peer.peerId, publicationId: publication.publicationId,
      publicationVersion: publication.publicationVersion, proof });
    this._collectSources();
  }

  _provePeerAudioRetirement(peer, proof) {
    for (const publication of [...peer.audioRetirements.values()]) this._proveAudioRetirement(peer, publication, proof);
  }

  _waitAudioRetirement(peer, publication) {
    if (!publication.retirement) return Promise.resolve();
    return this._deadline(peer, publication.retirement.promise,
      'Dedicated audio transceiver retirement still needs a completed SDP turn or peer/engine close proof.');
  }

  /** Watch can precede the first announcement, but never authorizes a replacement. */
  watch(remoteSessionId, shareId, destination) {
    const peer = this.peers.get(remoteSessionId);
    check(destination !== null && peer && this.roster.get(remoteSessionId)?.has(shareId),
      'Watch requires a current authenticated native screen publisher.');
    this._assertLive(peer);
    check(peer.watches.has(shareId) || peer.watches.size < this.maximumHistory, 'Native Watch history is full.');
    this._revokeAudioForShare(peer, shareId, 'watch-replaced');
    const routeVersion = this.routes.setWatching(remoteSessionId, shareId, destination);
    check(routeVersion !== null, 'Use stopWatching() to stop a native screen.');
    const publication = peer.remotePublications.get(shareId);
    const watch = { shareId, destination, routeVersion, active: true,
      publicationVersion: publication && !publication.retired ? publication.publicationVersion : null,
      subscriptionId: this._next('nextSubscription'), revision: this._next('nextWatchRevision') };
    if (this.audio) {
      const audioPublication = peer.remotePublications.get(mediaKey('audio', shareId));
      const preferences = peer.audioPreferences.get(shareId) ?? { muted: false, volume: 1 };
      watch.audio = { ...preferences, version: this._next('nextAudioWatchVersion'),
        subscriptionId: this._next('nextSubscription'), revision: this._next('nextWatchRevision'), video: null,
        publicationVersion: audioPublication && !audioPublication.retired ? audioPublication.publicationVersion : null };
    }
    peer.watches.set(shareId, watch);
    return this._queue(peer, async () => {
      if (peer.watches.get(shareId) !== watch || !watch.active) return;
      await this._sendWatch(peer, watch);
      await this._sendAudioWatch(peer, watch);
      await this._syncReceivers(peer);
      return { subscriptionId: watch.subscriptionId, revision: watch.revision, watchVersion: watch.routeVersion };
    });
  }

  stopWatching(remoteSessionId, shareId) {
    const peer = this.peers.get(remoteSessionId);
    if (!peer) return Promise.resolve();
    check(share(shareId), 'Invalid native screen share ID.');
    this.routes.setWatching(remoteSessionId, shareId, null);
    const watch = peer.watches.get(shareId);
    if (!watch) return Promise.resolve();
    watch.active = false;
    watch.revision = this._next('nextWatchRevision');
    this._touchAudioWatch(peer, watch, 'watch-stopped');
    return this._queue(peer, async () => {
      await this._sendWatch(peer, watch);
      await this._sendAudioWatch(peer, watch);
      await this._syncReceivers(peer);
    });
  }

  async _sendWatch(peer, watch) {
    const publication = peer.remotePublications.get(watch.shareId);
    if (!publication || (publication.retired && watch.active) || watch.publicationVersion !== publication.publicationVersion) return;
    await this._send(peer, { type: 'watch', shareId: watch.shareId, publicationId: publication.publicationId,
      publicationVersion: publication.publicationVersion, metadataVersion: publication.metadataVersion,
      subscriptionId: watch.subscriptionId, revision: watch.revision, watching: watch.active,
      ...(this.controlVersion === AV_VERSION ? { kind: 'video' } : {}) });
  }

  _audioWatchAllowed(peer, watch) {
    const video = peer.remotePublications.get(watch.shareId);
    const audio = peer.remotePublications.get(mediaKey('audio', watch.shareId));
    return !!this.audio && watch.active && !!watch.audio && !watch.audio.muted
      && !watch.destination.frame.isDestroyed() && !watch.destination.frame.detached
      && this.roster.get(peer.remoteSessionId)?.has(watch.shareId)
      && !!video && !video.retired && video.publicationVersion === watch.publicationVersion
      && !!audio && !audio.retired && audio.publicationVersion === watch.audio.publicationVersion
      && audio.syncGroup === video.syncGroup;
  }

  _touchAudioWatch(peer, watch, reason, signalRevision = true) {
    if (!watch.audio) return;
    watch.audio.version = this._next('nextAudioWatchVersion');
    if (signalRevision) watch.audio.revision = this._next('nextWatchRevision');
    this._revokeAudioForShare(peer, watch.shareId, reason);
  }

  async _sendAudioWatch(peer, watch) {
    if (!watch.audio) return;
    const audio = peer.remotePublications.get(mediaKey('audio', watch.shareId));
    if (!audio || audio.retired || audio.publicationVersion !== watch.audio.publicationVersion) return;
    const video = peer.remotePublications.get(watch.shareId);
    const allowed = this._audioWatchAllowed(peer, watch);
    if (video && !video.retired && video.publicationVersion === watch.publicationVersion) {
      watch.audio.video = { publicationId: video.publicationId, publicationVersion: video.publicationVersion,
        metadataVersion: video.metadataVersion, subscriptionId: watch.subscriptionId, revision: watch.revision };
    }
    if (!watch.audio.video) return;
    await this._send(peer, { type: 'watch', kind: 'audio', shareId: watch.shareId,
      publicationId: audio.publicationId, publicationVersion: audio.publicationVersion, metadataVersion: audio.metadataVersion,
      subscriptionId: watch.audio.subscriptionId, revision: watch.audio.revision, watching: allowed,
      video: { ...watch.audio.video } });
  }

  _audioPreferences(remoteSessionId, shareId) {
    this._requireAudio();
    const peer = this.peers.get(remoteSessionId);
    check(peer && this._live(peer) && this.roster.get(remoteSessionId)?.has(shareId), 'Audio settings require an authenticated screen.');
    check(peer.audioPreferences.has(shareId) || peer.audioPreferences.size < this.maximumHistory, 'Audio preference history is full.');
    let preferences = peer.audioPreferences.get(shareId);
    if (!preferences) {
      preferences = { muted: false, volume: 1 };
      peer.audioPreferences.set(shareId, preferences);
    }
    return { peer, preferences, watch: peer.watches.get(shareId) };
  }

  setAudioMuted(remoteSessionId, shareId, muted) {
    check(typeof muted === 'boolean', 'Audio mute must be boolean.');
    const { peer, preferences, watch } = this._audioPreferences(remoteSessionId, shareId);
    preferences.muted = muted;
    if (!watch?.audio) return Promise.resolve();
    watch.audio.muted = muted;
    this._touchAudioWatch(peer, watch, 'audio-mute');
    return this._queue(peer, async () => {
      await this._sendAudioWatch(peer, watch);
      await this._syncReceivers(peer);
    });
  }

  setAudioVolume(remoteSessionId, shareId, volume) {
    check(typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 2, 'Audio volume must be 0..2.');
    const { peer, preferences, watch } = this._audioPreferences(remoteSessionId, shareId);
    preferences.volume = volume;
    if (!watch?.audio) return Promise.resolve();
    watch.audio.volume = volume;
    this._touchAudioWatch(peer, watch, 'audio-volume', false);
    return this._queue(peer, () => this._syncReceivers(peer));
  }

  async receive(authenticatedRemoteSessionId, input) {
    check(reference(authenticatedRemoteSessionId), 'The carrier must supply an authenticated remote session.');
    const message = parseNativeP2pMessage(input);
    const peer = this.peers.get(authenticatedRemoteSessionId);
    if (peer && !this._live(peer) && ['opening', 'open'].includes(peer.status)) {
      this._beginClose(peer);
      this._scheduleCleanup(peer);
    }
    if (!peer || !this._live(peer) || message.callId !== this.callId || message.channelId !== this.channelId
      || message.connectionId !== peer.connectionId || message.generation !== peer.generation
      || message.version !== this.controlVersion) {
      return { accepted: false, reason: 'obsolete-or-unauthenticated-peer' };
    }
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    return this._queue(peer, async () => {
      await this._receive(peer, message);
      return { accepted: true };
    }, { bytes });
  }

  async _receive(peer, message) {
    if (['offer', 'answer', 'turn-applied', 'turn-done'].includes(message.type) && message.turn <= peer.completedTurn) return;
    switch (message.type) {
      case 'negotiate':
        check(peer.leader, 'Only the pair leader receives negotiation requests.');
        if (message.requestVersion <= peer.remoteRequestVersion) return;
        peer.remoteRequestVersion = message.requestVersion;
        peer.remoteDirty = true;
        this._schedulePump(peer);
        return;
      case 'turn':
        check(!peer.leader, 'Only the pair leader grants negotiation turns.');
        if (message.turn <= peer.completedTurn) return;
        check(!peer.turn && message.turn === peer.sequence + 1
          && [this.localSessionId, peer.remoteSessionId].includes(message.offererSessionId),
        'Unexpected or overlapping native negotiation turn.');
        this._startTurn(peer, message.turn, message.offererSessionId);
        if (message.offererSessionId === this.localSessionId) await this._offer(peer);
        return;
      case 'offer':
        check(peer.turn?.sequence === message.turn && peer.turn.offerer === peer.remoteSessionId
          && peer.turn.phase === 'await-offer', 'Offer does not match the granted native negotiation turn.');
        peer.turn.phase = 'answering';
        await this._setDescription(peer, 'remote', { type: 'offer', sdp: message.sdp });
        await this._remoteDescription(peer, message.turn);
        this._assertLive(peer);
        {
          const answer = description(await this._request(peer, 'peer.createAnswer', peer.peerId, {}), 'answer');
          peer.localDescriptionTurn = message.turn;
          await this._setDescription(peer, 'local', answer);
          await this._send(peer, { type: 'answer', turn: message.turn, sdp: answer.sdp });
        }
        peer.turn.phase = peer.leader ? 'await-applied' : 'await-done';
        return;
      case 'answer':
        check(peer.turn?.sequence === message.turn && peer.turn.offerer === this.localSessionId
          && peer.turn.phase === 'await-answer', 'Answer does not match the outstanding native negotiation turn.');
        peer.turn.phase = 'applying-answer';
        await this._setDescription(peer, 'remote', { type: 'answer', sdp: message.sdp });
        await this._remoteDescription(peer, message.turn);
        this._assertLive(peer);
        if (peer.leader) await this._finishTurn(peer);
        else {
          await this._send(peer, { type: 'turn-applied', turn: message.turn });
          peer.turn.phase = 'await-done';
        }
        return;
      case 'turn-applied':
        check(peer.leader && peer.turn?.sequence === message.turn && peer.turn.offerer === peer.remoteSessionId
          && peer.turn.phase === 'await-applied', 'Unexpected native answer application acknowledgement.');
        await this._finishTurn(peer);
        return;
      case 'turn-done':
        check(!peer.leader && peer.turn?.sequence === message.turn && peer.turn.phase === 'await-done',
          'Native negotiation completed before the ordered answer exchange.');
        this._completeTurn(peer);
        return;
      case 'ice':
        check(message.turn <= peer.sequence + (peer.turn ? 0 : 1), 'ICE candidate refers to an ungranted future turn.');
        if (peer.remoteDescriptionTurn && message.turn <= peer.remoteDescriptionTurn) {
          await this._request(peer, 'peer.addIceCandidate', peer.peerId, candidate(message));
        } else {
          check(peer.ice.length < this.maximumIce, 'Bounded native pending ICE queue is full.');
          peer.ice.push({ turn: message.turn, ...candidate(message) });
        }
        return;
      case 'publication':
        await this._receivePublication(peer, message);
        return;
      case 'unpublish':
        this._receiveUnpublish(peer, message);
        if (kindOf(message) === 'video') {
          const watch = peer.watches.get(message.shareId);
          if (watch) await this._sendAudioWatch(peer, watch);
        }
        await this._syncReceivers(peer);
        return;
      case 'watch': {
        const publication = peer.currentPublications.get(mediaKey(kindOf(message), message.shareId));
        if (!publication?.active || !publication.source.active || publication.publicationId !== message.publicationId
          || publication.publicationVersion !== message.publicationVersion || publication.metadataVersion !== message.metadataVersion
          || publication.announcedVersion !== message.metadataVersion
          || !this.roster.get(this.localSessionId)?.has(message.shareId)
          || message.revision <= publication.lastWatchRevision) return;
        publication.lastWatchRevision = message.revision;
        publication.watch = message;
        await this._syncPublication(peer, publication);
        if (publication.kind === 'video') {
          const audio = peer.currentPublications.get(mediaKey('audio', message.shareId));
          if (audio) await this._syncPublication(peer, audio);
        }
        return;
      }
    }
  }

  async _receivePublication(peer, message) {
    if (!this.roster.get(peer.remoteSessionId)?.has(message.shareId)) return;
    const kind = kindOf(message), key = mediaKey(kind, message.shareId);
    if (kind === 'audio') this._requireAudio();
    const previous = peer.remotePublications.get(key);
    if (previous && (message.publicationVersion < previous.publicationVersion
      || (message.publicationVersion === previous.publicationVersion
        && (previous.retired || message.metadataVersion < previous.metadataVersion)))) return;
    if (previous && message.publicationVersion === previous.publicationVersion) {
      check(message.publicationId === previous.publicationId, 'Publication ID changed inside a publication generation.');
      check(message.syncGroup === previous.syncGroup, 'A source group cannot change on an existing publication/SSRC.');
      if (message.metadataVersion === previous.metadataVersion) {
        check(sameBinding(message, previous), 'Native publication binding changed without a metadata revision.');
        return;
      }
    }
    check(previous || peer.remotePublications.size < this.maximumHistory, 'Native remote publication history is full.');
    for (const other of peer.remotePublications.values()) {
      check(mediaKey(kindOf(other), other.shareId) === key || other.retired || other.publicationId !== message.publicationId,
        'One native publication cannot claim two authenticated screens.');
      if (kind === 'audio' && kindOf(other) === 'audio' && other.shareId !== message.shareId) {
        check(other.retired, 'A peer cannot announce simultaneous audio associations.');
      }
      if (mediaKey(kindOf(other), other.shareId) !== key && !other.retired) {
        check(other.trackId !== message.trackId && (message.mid === null || other.mid !== message.mid),
          'Different media publications cannot claim one native track/MID.');
      }
    }
    const watch = peer.watches.get(message.shareId);
    if (kind === 'video' && watch?.active && watch.publicationVersion !== null && watch.publicationVersion !== message.publicationVersion) {
      watch.active = false;
      this.routes.setWatching(peer.remoteSessionId, message.shareId, null);
      this._touchAudioWatch(peer, watch, 'video-replaced');
    }
    if (kind === 'video') this.routes.announce(peer.peerId, peer.remoteSessionId, peer.connectionId, message);
    peer.remotePublications.set(key, { ...message, kind, streamIds: [...message.streamIds], retired: false });
    if (kind === 'video' && watch?.active) {
      watch.publicationVersion = message.publicationVersion;
      watch.routeVersion = this.routes.setWatching(peer.remoteSessionId, message.shareId, watch.destination);
      watch.revision = this._next('nextWatchRevision');
      await this._sendWatch(peer, watch);
    }
    if (watch?.audio) {
      if (kind === 'audio') {
        if (watch.audio.publicationVersion !== message.publicationVersion) watch.audio.subscriptionId = this._next('nextSubscription');
        watch.audio.publicationVersion = message.publicationVersion;
      }
      this._touchAudioWatch(peer, watch, 'publication-metadata');
      await this._sendAudioWatch(peer, watch);
    }
    await this._syncReceivers(peer);
  }

  _receiveUnpublish(peer, message) {
    const kind = kindOf(message), publication = peer.remotePublications.get(mediaKey(kind, message.shareId));
    if (!publication || publication.publicationVersion !== message.publicationVersion
      || publication.publicationId !== message.publicationId) return;
    publication.retired = true;
    const watch = peer.watches.get(message.shareId);
    if (watch) {
      if (kind === 'video') watch.active = false;
      this._touchAudioWatch(peer, watch, 'publication-removed');
    }
    if (kind === 'video') this.routes.setWatching(peer.remoteSessionId, message.shareId, null);
  }

  _selection(peer, receiver) {
    if (receiver.kind === 'audio') return this._audioSelection(peer, receiver);
    const selection = this.routes.desiredReceiver(peer.peerId, receiver.receiverId);
    const watch = selection && peer.watches.get(selection.shareId);
    const publication = selection && peer.remotePublications.get(selection.shareId);
    return watch?.active && watch.routeVersion === selection.watchVersion && publication && !publication.retired
      && watch.publicationVersion === publication.publicationVersion && sameBinding(selection.binding, publication)
      ? selection : null;
  }

  _audioSelection(peer, receiver) {
    if (!receiver.present || !this.audio) return null;
    for (const publication of peer.remotePublications.values()) {
      if (kindOf(publication) !== 'audio' || publication.retired || !sameBinding(receiver.binding, publication)
        || !receiver.binding.streamIds.includes(publication.syncGroup)) continue;
      const watch = peer.watches.get(publication.shareId);
      if (!watch || !this._audioWatchAllowed(peer, watch)) continue;
      return { peerId: peer.peerId, receiverId: receiver.receiverId, observedEpoch: receiver.epoch,
        publisherSessionId: peer.remoteSessionId, connectionId: peer.connectionId, generation: peer.generation,
        kind: 'audio', shareId: publication.shareId, screenAudioShareId: publication.shareId,
        publicationId: publication.publicationId, publicationVersion: publication.publicationVersion,
        metadataVersion: publication.metadataVersion, syncGroup: publication.syncGroup,
        watchVersion: watch.audio.version, subscriptionId: watch.audio.subscriptionId,
        volume: watch.audio.volume, binding: binding(publication) };
    }
    return null;
  }

  _revokeAudioReceiver(peer, receiver, reason) {
    const previous = receiver.confirmation;
    receiver.confirmation = null;
    receiver.confirmationReadiness = null;
    if (previous) this._audioNotify(peer, 'revokeReceiver', { ...previous, receiverEpoch: previous.receiverEpoch }, reason);
  }

  _revokeAudioForShare(peer, shareId, reason) {
    for (const receiver of peer.receivers.values()) {
      if (receiver.kind === 'audio' && receiver.confirmation?.shareId === shareId) this._revokeAudioReceiver(peer, receiver, reason);
    }
  }

  _scheduleReceivers(peer) {
    if (!this._live(peer) || peer.receiverSyncScheduled) return;
    peer.receiverSyncScheduled = true;
    this._background(peer, async () => {
      peer.receiverSyncScheduled = false;
      await this._syncReceivers(peer);
    });
  }

  async _syncReceivers(peer) {
    this._assertLive(peer);
    const receiving = [...peer.watches.values()].some(watch => {
      const publication = peer.remotePublications.get(watch.shareId);
      return (watch.active && publication && !publication.retired
        && watch.publicationVersion === publication.publicationVersion
        && this.roster.get(peer.remoteSessionId)?.has(watch.shareId)) || this._audioWatchAllowed(peer, watch);
    });
    for (const receiver of peer.receivers.values()) {
      if (receiver.kind === 'audio' && !this._audioSelection(peer, receiver) && receiver.requestedEnabled !== false) {
        await this._disableReceiver(peer, receiver);
      }
    }
    if (peer.receiving !== receiving) {
      const requestedAudio = receiving && [...peer.receivers.values()].find(receiver =>
        receiver.kind === 'audio' && receiver.present && receiver.requestedEnabled === true);
      const readiness = requestedAudio
        ? await this._prepareAudioReceive(peer, 'receiver', { selection: this._audioSelection(peer, requestedAudio) }) : null;
      const data = { enabled: receiving };
      if (readiness) data.expectedOutputEpoch = this._expectedAudioOutputEpoch(readiness);
      this._assertLive(peer);
      const result = await this._request(peer, 'peer.setReceiving', peer.peerId, data);
      this._assertLive(peer);
      check(result?.renegotiationRequired === true, 'Native aggregate receive gate did not acknowledge renegotiation.');
      peer.receiving = receiving;
      this._markNegotiation(peer, true);
    }
    for (const receiver of peer.receivers.values()) {
      this._assertLive(peer);
      const selection = this._selection(peer, receiver);
      if (receiver.kind === 'audio') {
        await this._syncAudioReceiver(peer, receiver, selection);
        continue;
      }
      if (!selection) {
        if (receiver.requestedEnabled !== false) await this._disableReceiver(peer, receiver);
        continue;
      }
      const confirmed = receiver.confirmation;
      if (confirmed && confirmed.watchVersion === selection.watchVersion
        && confirmed.receiverEpoch >= selection.observedEpoch && sameBinding(confirmed.binding, selection.binding)) continue;
      const result = await this._request(peer, 'peer.setReceiverEnabled', peer.peerId,
        { receiverId: receiver.receiverId, enabled: true });
      this._assertLive(peer);
      this._validateReceiverResult(receiver, result, true, selection.observedEpoch);
      receiver.requestedEnabled = true;
      if (this._live(peer) && this._selection(peer, receiver)?.watchVersion === selection.watchVersion
        && this.routes.confirmReceiver(selection, result)) {
        receiver.confirmation = { ...selection, receiverEpoch: result.receiverEpoch };
      } else {
        await this._disableReceiver(peer, receiver);
      }
    }
  }

  _sameAudioSelection(peer, receiver, selection) {
    const current = this._audioSelection(peer, receiver);
    return !!current && current.watchVersion === selection.watchVersion
      && current.publicationId === selection.publicationId && current.publicationVersion === selection.publicationVersion
      && current.metadataVersion === selection.metadataVersion && sameBinding(current.binding, selection.binding);
  }

  async _syncAudioReceiver(peer, receiver, selection) {
    if (!selection) {
      this._revokeAudioReceiver(peer, receiver, 'not-watched');
      if (receiver.requestedEnabled !== false) await this._disableReceiver(peer, receiver);
      return;
    }
    const confirmed = receiver.confirmation;
    if (confirmed && confirmed.watchVersion === selection.watchVersion && confirmed.receiverEpoch >= selection.observedEpoch
      && receiver.volume === selection.volume && sameBinding(confirmed.binding, selection.binding)) {
      check(receiver.confirmationReadiness, 'Confirmed audio receiver has no owned output preparation.');
      this._assertAudioReady(receiver.confirmationReadiness.proof, receiver.confirmationReadiness.context);
      return;
    }
    const readiness = await this._prepareAudioReceive(peer, 'receiver', { selection });
    if (!this._sameAudioSelection(peer, receiver, selection)) {
      await this._disableReceiver(peer, receiver);
      return;
    }
    const volume = await this._request(peer, 'peer.setReceiverVolume', peer.peerId,
      { receiverId: receiver.receiverId, volume: selection.volume });
    check(volume?.receiverId === receiver.receiverId && positive(volume.receiverEpoch)
      && volume.receiverEpoch >= selection.observedEpoch && volume.volume === selection.volume,
    'Invalid native receiver volume acknowledgement.');
    receiver.volume = volume.volume;
    if (!this._sameAudioSelection(peer, receiver, selection)) {
      await this._disableReceiver(peer, receiver);
      return;
    }
    this._audioNotify(peer, 'onReceiverVolume', selection, volume);
    const expectedOutputEpoch = this._expectedAudioOutputEpoch(readiness);
    this._assertLive(peer);
    const result = await this._request(peer, 'peer.setReceiverEnabled', peer.peerId,
      { receiverId: receiver.receiverId, enabled: true, expectedOutputEpoch });
    this._validateReceiverResult(receiver, result, true, selection.observedEpoch);
    receiver.requestedEnabled = true;
    if (this._live(peer) && result.enabled && receiver.epoch <= result.receiverEpoch
      && this._sameAudioSelection(peer, receiver, selection)) {
      this._assertAudioReady(readiness.proof, readiness.context);
      receiver.confirmation = { ...selection, receiverEpoch: result.receiverEpoch };
      receiver.confirmationReadiness = readiness;
      this._audioNotify(peer, 'bindReceiver', receiver.confirmation, result, readiness.proof);
    } else await this._disableReceiver(peer, receiver);
  }

  _validateReceiverResult(receiver, result, requested, observedEpoch) {
    check(result?.receiverId === receiver.receiverId && positive(result.receiverEpoch)
      && result.receiverEpoch >= observedEpoch && result.requestedEnabled === requested
      && typeof result.enabled === 'boolean' && (requested || result.enabled === false),
    'Invalid native individual receiver gate acknowledgement.');
  }

  async _disableReceiver(peer, receiver) {
    if (receiver.kind === 'audio') this._revokeAudioReceiver(peer, receiver, 'disabled');
    const epoch = receiver.epoch;
    const result = await this._request(peer, 'peer.setReceiverEnabled', peer.peerId,
      { receiverId: receiver.receiverId, enabled: false });
    if (this.engineRetired) return;
    this._validateReceiverResult(receiver, result, false, epoch);
    receiver.requestedEnabled = false;
    receiver.confirmation = null;
  }

  _markNegotiation(peer, mutation = false) {
    if (!this._live(peer)) return;
    if (mutation) {
      check(positive(peer.mutationVersion + 1), 'Native SDP mutation versions exhausted.');
      peer.mutationVersion++;
    }
    peer.dirty = true;
    this._schedulePump(peer);
  }

  _schedulePump(peer) {
    if (!this._live(peer) || peer.pumpScheduled) return;
    peer.pumpScheduled = true;
    this._background(peer, async () => {
      peer.pumpScheduled = false;
      if (peer.turn || (!peer.dirty && !peer.remoteDirty)) return;
      if (!peer.leader) {
        if (!peer.requestOutstanding && peer.dirty) {
          check(positive(peer.localRequestVersion + 1), 'Native negotiation request versions exhausted.');
          peer.requestOutstanding = true;
          peer.grantTimer = this.timers.setTimeout(() => this._fail(peer,
            fault('P2P_TURN_TIMEOUT', 'Native negotiation request did not receive a turn.')), this.turnTimeoutMs);
          await this._send(peer, { type: 'negotiate', requestVersion: ++peer.localRequestVersion });
        }
        return;
      }
      let offerer = peer.dirty ? this.localSessionId : peer.remoteSessionId;
      if (peer.dirty && peer.remoteDirty && peer.lastOfferer === this.localSessionId) offerer = peer.remoteSessionId;
      if (offerer === peer.remoteSessionId) peer.remoteDirty = false;
      check(positive(peer.sequence + 1), 'Native negotiation turns exhausted.');
      this._startTurn(peer, peer.sequence + 1, offerer);
      await this._send(peer, { type: 'turn', turn: peer.sequence, offererSessionId: offerer });
      if (offerer === this.localSessionId) await this._offer(peer);
    });
  }

  _startTurn(peer, sequence, offerer) {
    peer.sequence = sequence;
    peer.turn = { sequence, offerer, phase: offerer === this.localSessionId ? 'creating-offer' : 'await-offer',
      timer: this.timers.setTimeout(() => this._fail(peer,
        fault('P2P_TURN_TIMEOUT', `Native negotiation turn ${sequence} did not finish.`)), this.turnTimeoutMs) };
    peer.lastOfferer = offerer;
  }

  async _offer(peer) {
    peer.dirty = false;
    peer.requestOutstanding = false;
    if (peer.grantTimer !== null) this.timers.clearTimeout(peer.grantTimer);
    peer.grantTimer = null;
    const turn = peer.turn.sequence;
    peer.turn.offeredMutation = peer.mutationVersion;
    const offer = description(await this._request(peer, 'peer.createOffer', peer.peerId, {}), 'offer');
    this._assertLive(peer);
    peer.localDescriptionTurn = turn;
    await this._setDescription(peer, 'local', offer);
    await this._send(peer, { type: 'offer', turn, sdp: offer.sdp });
    peer.turn.phase = 'await-answer';
  }

  async _remoteDescription(peer, turn) {
    peer.remoteDescriptionTurn = turn;
    const candidates = peer.ice;
    peer.ice = [];
    for (const entry of candidates) {
      if (entry.turn <= turn) await this._request(peer, 'peer.addIceCandidate', peer.peerId, candidate(entry));
      else if (entry.turn > turn) peer.ice.push(entry);
    }
  }

  async _finishTurn(peer) {
    await this._send(peer, { type: 'turn-done', turn: peer.turn.sequence });
    this._completeTurn(peer);
  }

  _completeTurn(peer) {
    if (peer.turn.offerer === this.localSessionId) {
      peer.negotiatedMutation = Math.max(peer.negotiatedMutation, peer.turn.offeredMutation ?? 0);
      for (const publication of [...peer.audioRetirements.values()]) {
        if (publication.retirement.requiredMutation <= peer.negotiatedMutation) {
          this._proveAudioRetirement(peer, publication, 'negotiated-turn');
        }
      }
    }
    this.timers.clearTimeout(peer.turn.timer);
    peer.completedTurn = peer.turn.sequence;
    peer.turn = null;
    this._schedulePump(peer);
  }

  /**
   * Call synchronously for lifecycle events BEFORE routing the next frame.
   * Frames and input retirement events are not consumed or released here.
   */
  handleNativeEvent(event) {
    if (!record(event) || typeof event.type !== 'string') return false;
    if (event.type === 'closed' && this.engineClosing) return true;
    if (event.type === 'closed' || (event.type === 'error' && event.target === 0 && event.data?.terminal === true)) {
      const error = fault(event.data?.code ?? 'P2P_ENGINE_CLOSED', event.data?.message ?? 'The supplied native engine closed.');
      for (const peer of this.peers.values()) this._fail(peer, error);
      return true;
    }
    if (!event.type.startsWith('peer.') && event.type !== 'error') return false;
    let peer = this.nativePeers.get(event.target);
    if (!peer && event.type === 'error') {
      peer = [...this.peers.values()].find(value => value.resources.has(event.target));
    }
    if (!peer) {
      if (!positive(event.target) || !event.type.startsWith('peer.')
        || ![...this.peers.values()].some(value => value.status === 'opening')) return false;
      const early = this.earlyEvents.get(event.target) ?? [];
      if (this.earlyEvents.size >= this.maximumPeers && !this.earlyEvents.has(event.target)
        || early.length >= this.maximumQueue) {
        for (const opening of this.peers.values()) {
          if (opening.status === 'opening') this._fail(opening, fault('P2P_EARLY_EVENT_LIMIT', 'Native pre-creation event queue is full.'));
        }
        return false;
      }
      early.push(structuredClone(event));
      this.earlyEvents.set(event.target, early);
      return true;
    }
    if (!this._live(peer)) {
      if (['opening', 'open'].includes(peer.status)) {
        this._beginClose(peer);
        this._scheduleCleanup(peer);
      }
      return false;
    }
    try {
      if (['peer.trackAdded', 'peer.trackUpdated', 'peer.trackRemoved'].includes(event.type)) {
        const media = binding(event.data);
        const { receiverId, receiverEpoch, kind } = event.data;
        check(positive(receiverId) && positive(receiverEpoch) && mediaKind(kind), 'Invalid native receiver lifecycle.');
        if (kind === 'audio') this._requireAudio();
        const previous = peer.receivers.get(receiverId);
        check(previous || peer.receivers.size < this.maximumReceivers, 'Native receiver history is full.');
        check(!previous || previous.kind === kind, 'Native receiver changed its media kind.');
        let changed;
        if (kind === 'video') changed = this.routes.onTrackEvent(event);
        else {
          if (previous && receiverEpoch < previous.epoch) return false;
          if (previous && receiverEpoch === previous.epoch) {
            check(sameBinding(previous.binding, media) && previous.present === (event.type !== 'peer.trackRemoved'),
              'Native audio receiver changed binding without a new epoch.');
            return true;
          }
          if (previous) this._revokeAudioReceiver(peer, previous, 'receiver-epoch');
          changed = true;
        }
        if (!changed) return true;
        const receiver = previous ?? { receiverId, kind, confirmation: null, requestedEnabled: null, volume: null };
        if (!sameBinding(receiver.binding, media)) receiver.requestedEnabled = null;
        Object.assign(receiver, { binding: media, epoch: receiverEpoch, present: event.type !== 'peer.trackRemoved' });
        peer.receivers.set(receiverId, receiver);
        this._scheduleReceivers(peer);
      } else if (event.type === 'peer.publicationUpdated') {
        check(positive(event.data?.publicationId), 'Invalid native publication metadata event.');
        check(event.data.kind === undefined || mediaKind(event.data.kind), 'Invalid native publication media kind.');
        const media = binding(event.data);
        const publication = [...peer.publications.values()].find(value => value.publicationId === event.data.publicationId);
        if (publication) check(event.data.kind === undefined || event.data.kind === publication.kind, 'Native publication changed media kind.');
        if (!publication) {
          const pending = [...peer.pending.values()].some(request => publicationOperation(request.operation));
          if (!pending) return false;
          check(peer.pendingMetadata.has(event.data.publicationId) || peer.pendingMetadata.size < this.maximumHistory,
            'Native pending publication metadata is full.');
          peer.pendingMetadata.set(event.data.publicationId, { ...media, kind: event.data.kind });
        } else if (publication.active && !sameBinding(publication.binding, media)) {
          if (this.controlVersion === AV_VERSION) check(media.streamIds.includes(publication.syncGroup), 'Source MSID changed on a live publication.');
          publication.binding = media;
          check(positive(publication.metadataVersion + 1), 'Native metadata revisions exhausted.');
          publication.metadataVersion++;
          this._updatePublicationDemand(peer, publication);
          if (!publication.updateScheduled) {
            publication.updateScheduled = true;
            this._background(peer, async () => {
              publication.updateScheduled = false;
              await this._syncPublication(peer, publication);
              if (publication.kind === 'video') {
                const audio = peer.currentPublications.get(mediaKey('audio', publication.shareId));
                if (audio) await this._syncPublication(peer, audio);
              }
              await this._announce(peer, publication);
            });
          }
        }
      } else if (event.type === 'peer.negotiationNeeded') {
        this._markNegotiation(peer);
      } else if (event.type === 'peer.iceCandidate') {
        const ice = candidate(event.data);
        const turn = peer.localDescriptionTurn;
        check(positive(turn), 'Native ICE arrived before a local description turn.');
        this._background(peer, () => this._send(peer, { type: 'ice', turn, ...ice }));
      } else if (event.type === 'peer.state') {
        check(record(event.data) && Object.keys(event.data).length <= 16
          && Object.values(event.data).every(value => typeof value === 'string' && text(value, 128)),
        'Invalid native peer state event.');
        peer.nativeState = { ...peer.nativeState, ...event.data };
        if (Object.values(event.data).includes('failed')) {
          this._fail(peer, fault('P2P_NATIVE_FAILED', 'Native screen peer reported a failed state.'));
        } else this._state(peer);
      } else if (event.type === 'error') {
        const error = fault(text(event.data?.code, 128) ? event.data.code : 'P2P_NATIVE_ERROR',
          text(event.data?.message, 4096) ? event.data.message : 'Native screen operation failed.');
        this._fail(peer, error);
      } else return false;
      return true;
    } catch (error) {
      this._fail(peer, error);
      return false;
    }
  }

  _fail(peer, error) {
    if (peer.status === 'closed') return;
    if (!peer.error) {
      peer.error = error;
      this._report(peer, error);
    }
    this._beginClose(peer, true);
    this._scheduleCleanup(peer);
  }

  _beginClose(peer, failed = false) {
    if (peer.status === 'closed') return;
    peer.status = failed || peer.error ? 'failed' : 'closing';
    peer.controller.abort(fault('P2P_CANCELLED', 'Native participant pair is closing.'));
    if (peer.turn) this.timers.clearTimeout(peer.turn.timer);
    if (peer.grantTimer !== null) this.timers.clearTimeout(peer.grantTimer);
    peer.grantTimer = null;
    peer.turn = null;
    peer.ice = [];
    peer.pendingMetadata.clear();
    if (peer.peerId) {
      this.routes.removePeer(peer.peerId);
      this.earlyEvents.delete(peer.peerId);
    }
    for (const watch of peer.watches.values()) {
      watch.active = false;
      this.routes.setWatching(peer.remoteSessionId, watch.shareId, null);
    }
    for (const receiver of peer.receivers.values()) {
      if (receiver.kind === 'audio') {
        try { this._revokeAudioReceiver(peer, receiver, 'peer-close'); } catch (error) { this._report(peer, error); }
      }
    }
    for (const publication of peer.publications.values()) this._invalidatePublication(peer, publication);
    peer.currentPublications.clear();
    for (const pending of peer.pending.values()) this._cancel(peer, pending);
    this._state(peer);
  }

  _scheduleCleanup(peer) {
    if (this.engineClosing || peer.cleanupScheduled || peer.status === 'closed' || this._live(peer)) return;
    peer.cleanupScheduled = true;
    const run = peer.chain.then(async () => {
      try { await this._cleanup(peer); } catch (error) { this._report(peer, error); }
      finally { peer.cleanupScheduled = false; }
    });
    peer.chain = run.catch(error => this._report(peer, error));
  }

  async _closeResource(peer, resource) {
    if (!peer.resources.has(resource.id)) return;
    check(!resource.closing, 'A native close is still pending; its ownership remains retained.');
    resource.closing = true;
    let completed = false;
    try {
      await this._request(peer, 'resource.close', resource.id, {}, () => {
        // Revision 2 specifies no close result DTO: the correlated completion is the retirement proof.
        completed = true;
        peer.resources.delete(resource.id);
        if (resource.publication) {
          resource.publication.nativeRetired = true;
          resource.publication.requestedEnabled = false;
          resource.publication.enabled = false;
          this._publicationState(peer, resource.publication);
          if (resource.publication.kind === 'audio') this._startAudioRetirement(peer, resource.publication);
          else peer.publications.delete(resource.publication.publicationVersion);
        } else if (resource.kind === 'peer') {
          this._provePeerAudioRetirement(peer, 'peer-close');
        }
      }, request => {
        if (request.expired && resource.publication?.kind === 'audio') {
          this._schedulePublicationRetirement(peer, resource.publication);
        }
      });
    } finally {
      const pending = [...peer.pending.values()].find(request => request.operation === 'resource.close' && request.target === resource.id);
      if (pending) pending.completion.finally(() => { resource.closing = false; }).catch(() => {});
      else resource.closing = false;
      if (completed && resource.publication
        && (!resource.publication.retirement || resource.publication.retirement.proven)) {
        peer.publications.delete(resource.publication.publicationVersion);
      }
    }
  }

  async _cleanup(peer) {
    if (peer.status === 'closed') return;
    if (this.engineClosing) {
      throw fault('P2P_ENGINE_CLOSE_UNCONFIRMED', 'Native ownership is retained until the actual full engine close Promise fulfills.');
    }
    const failures = [];
    for (const publication of [...peer.publications.values()]) {
      try { await this._retirePublication(peer, publication, false); } catch (error) { failures.push(error); }
    }
    for (const resource of [...peer.resources.values()]) {
      if (resource.kind === 'publication' && !peer.publications.has(resource.publication.publicationVersion)) {
        try { await this._closeResource(peer, resource); } catch (error) { failures.push(error); }
      }
    }
    if (peer.status === 'closed') return;
    const pendingCreates = [...peer.pending.values()].filter(request => request.operation === 'peer.create' || publicationOperation(request.operation));
    if (pendingCreates.length) failures.push(fault('P2P_OWNERSHIP_RETAINED', 'Cancelled native creation has not completed its ownership proof.'));
    if (!failures.length && ![...peer.resources.values()].some(resource => resource.kind === 'publication')) {
      for (const resource of [...peer.resources.values()]) {
        try { await this._closeResource(peer, resource); } catch (error) { failures.push(error); }
      }
    }
    if (peer.status === 'closed') return;
    if (failures.length || peer.resources.size || peer.pending.size) {
      throw new AggregateError(failures, 'Native peer teardown incomplete; retained handles can be retried with closePeer()/close().');
    }
    if (peer.peerId) {
      this.nativePeers.delete(peer.peerId);
      this.earlyEvents.delete(peer.peerId);
    }
    peer.status = 'closed';
    this._state(peer);
    if (this.peers.get(peer.remoteSessionId) === peer) this.peers.delete(peer.remoteSessionId);
    this._collectSources();
  }

  closePeer(remoteSessionId) {
    const peer = this.peers.get(remoteSessionId);
    if (!peer) return Promise.resolve();
    this._beginClose(peer);
    if (!peer.closePromise) {
      peer.closePromise = this._queue(peer, () => this._cleanup(peer), { closing: true, fatal: false })
        .finally(() => { peer.closePromise = null; });
    }
    return peer.closePromise;
  }

  async close() {
    this.closed = true;
    for (const source of this.sources.values()) source.rebindController?.abort(fault('P2P_CANCELLED', 'Native broker is closing.'));
    const results = await Promise.allSettled([...this.peers.keys()].map(sessionId => this.closePeer(sessionId)));
    for (const source of this.sources.values()) source.active = false;
    this.currentSources.clear();
    this._collectSources();
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Native broker close retained ownership; retry close().');
    this.earlyEvents.clear();
  }

  /**
   * The trusted engine owner calls this with its commands.closeEngine() Promise,
   * only after stopping presentation and draining real external GPU references.
   * Do not substitute a JSON "closed" event, ACK, or a rejection-swallowing Promise.
   * NativeRtcCommands must independently prove closure of this exact engine.
   * A rejected proof preserves the native ledger for another full-close attempt;
   * it never resumes resource.close commands against a shutting-down engine.
   */
  async finishAfterEngineClose(closePromise) {
    check(closePromise instanceof Promise, 'Full engine retirement requires the actual engine.close Promise.');
    this.closed = true;
    this.engineClosing = true;
    for (const peer of this.peers.values()) this._beginClose(peer);
    try {
      await closePromise;
      assertNativeRtcEngineClosed(this.commands, this.engine);
    }
    catch (error) {
      this._report(null, error);
      throw error;
    }
    if (this.engineRetired) return;
    this.engineRetired = true;
    for (const source of this.sources.values()) {
      source.rebindController?.abort(fault('P2P_CANCELLED', 'Native engine retired during audio rebind.'));
      for (const retire of [...source.waiters]) retire();
    }
    for (const peer of this.peers.values()) {
      this._provePeerAudioRetirement(peer, 'engine-close');
      for (const retire of [...peer.waiters]) retire();
      for (const publication of peer.publications.values()) {
        if (publication.enabled || publication.requestedEnabled || publication.demanded) {
          publication.requestedEnabled = false;
          publication.enabled = false;
          this._publicationState(peer, publication);
        }
      }
      peer.resources.clear();
      peer.pending.clear();
      peer.publications.clear();
      peer.currentPublications.clear();
      peer.receiving = false;
      peer.status = 'closed';
      this._state(peer);
    }
    this.peers.clear();
    this.nativePeers.clear();
    this.earlyEvents.clear();
    for (const source of this.sources.values()) source.active = false;
    this.currentSources.clear();
    this._collectSources();
  }

  /** Current authenticated Watch count, never a source/RTP/lease retirement acknowledgement. */
  sourceDemand(sourceId) {
    return [...this.peers.values()].reduce((count, peer) => count
      + [...peer.publications.values()].filter(publication =>
        publication.source.sourceId === sourceId && this._publicationDesired(peer, publication)).length, 0);
  }

  getPeer(remoteSessionId) {
    const peer = this.peers.get(remoteSessionId);
    if (!peer) return null;
    return { ...this._scope(peer), peerId: peer.peerId, status: peer.status, nativeState: { ...peer.nativeState },
      error: peer.error ? { code: peer.error.code ?? 'P2P_ERROR', message: peer.error.message } : null,
      turn: peer.turn ? { sequence: peer.turn.sequence, offerer: peer.turn.offerer, phase: peer.turn.phase } : null,
      completedTurn: peer.completedTurn, receiving: peer.receiving, queued: peer.queued,
      ...(this.controlVersion === AV_VERSION ? {
        controlVersion: AV_VERSION, negotiatedMutation: peer.negotiatedMutation,
        audioRetirements: [...peer.audioRetirements.values()].map(publication => ({
          publicationId: publication.publicationId, publicationVersion: publication.publicationVersion,
          requiredMutation: publication.retirement.requiredMutation,
        })),
      } : {}),
      pendingRequests: [...peer.pending.keys()], resources: [...peer.resources.values()].map(resource => ({ id: resource.id, kind: resource.kind })),
      publications: [...peer.publications.values()].map(publication => ({
        ...this._publicationDto(publication), sourceId: publication.source.sourceId, active: publication.active,
        demanded: !!this._publicationDesired(peer, publication), requestedEnabled: publication.requestedEnabled,
        enabled: publication.enabled,
      })) };
  }

  async getStats(remoteSessionId) {
    const peer = this.peers.get(remoteSessionId);
    check(peer && positive(peer.peerId), 'Native diagnostics require an admitted screen peer.');
    this._assertLive(peer);
    const reports = await this._request(peer, 'peer.getStats', peer.peerId, {});
    this._assertLive(peer);
    return { id: `peer-${peer.peerId}`, reports };
  }

  async idle() {
    for (let round = 0; round < this.maximumQueue * 4; round++) {
      const peers = [...this.peers.values()];
      const chains = peers.map(peer => peer.chain);
      await Promise.all(chains);
      if (peers.every((peer, index) => peer.chain === chains[index])) return;
    }
    throw fault('P2P_QUEUE_CHURN', 'Native broker did not reach local queue idle.');
  }
}

module.exports = { NativeP2pBroker, NATIVE_P2P_CONTROL_SCHEMA, parseNativeP2pMessage };
