'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeP2pBroker, NATIVE_P2P_CONTROL_SCHEMA, parseNativeP2pMessage } = require('../runtime/nativeP2pBroker.cjs');
const { NativeRtcCommands, isNativeRtcCommandsForEngine, assertNativeRtcEngineClosed } = require('../runtime/nativeRtcCommands.cjs');
const { NativeScreenRoutes } = require('../runtime/nativeScreenRoutes.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function nativeError(code, message = code) { return Object.assign(new Error(message), { code }); }
function destination(id) { return { presentationId: id, frame: { detached: false, isDestroyed: () => false } }; }
function media(value) { return { trackId: value.trackId, mid: value.mid, streamIds: [...value.streamIds] }; }

class Clock {
  constructor() { this.now = 0; this.next = 1; this.tasks = new Map(); }
  setTimeout = (callback, delay) => {
    const id = this.next++;
    this.tasks.set(id, { callback, due: this.now + delay });
    return id;
  };
  clearTimeout = id => { this.tasks.delete(id); };
  advance(milliseconds) {
    const until = this.now + milliseconds;
    for (let count = 0; count < 10000; count++) {
      const next = [...this.tasks].filter(([, task]) => task.due <= until)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) { this.now = until; return; }
      this.now = next[1].due;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    assert.fail('Deterministic clock did not quiesce.');
  }
}

/**
 * Pure control-contract double, not an engine implementation. No addon, device,
 * media, factory, Electron or socket is loaded. SDP carries test-only metadata;
 * offer/answer state transitions and answer m-line restrictions are enforced.
 */
class CommandsDouble {
  constructor(name) {
    this.name = name;
    this.nextResource = 1;
    this.nextReceiver = 10000;
    this.lastRequest = 0;
    this.resources = new Map();
    this.externalSources = new Map();
    this.requests = [];
    this.cancellations = [];
    this.pending = new Map();
    this.holds = [];
    this.failures = [];
    this.events = [];
    this.frames = [];
    this.onEvent = () => {};
    this.outputReady = false;
    this.outputEpoch = 0;
    this.mixedReceivers = [];
    this.receivingAudioStreams = 0;
    this.outputStops = 0;
  }

  supplySource(syncGroup, kind = 'video') {
    const sourceId = this.nextResource++;
    this.externalSources.set(sourceId, { syncGroup, kind, enabled: false, inputEpoch: kind === 'audio' ? 7 : null, packetCursor: 0 });
    return sourceId;
  }

  setOwnedSourceEnabled(sourceId, enabled) {
    const source = this.externalSources.get(sourceId);
    assert.ok(source, 'only the fake external source owner changes its aggregate gate');
    source.enabled = enabled;
    for (const resource of this.resources.values()) {
      if (resource.kind === 'publication' && resource.sourceId === sourceId) {
        resource.enabled = resource.requestedEnabled && enabled;
      }
    }
  }

  holdNext(operation, { afterCommit = false, matches = () => true } = {}) {
    const hold = { operation, afterCommit, matches, started: deferred(), gate: deferred(), matched: false };
    hold.release = () => hold.gate.resolve();
    this.holds.push(hold);
    return hold;
  }

  failNext(operation, target, code = 'NATIVE_TEST_FAILURE') {
    this.failures.push({ operation, target, error: nativeError(code) });
  }

  request(id, operation, target, data) {
    assert.ok(Number.isSafeInteger(id) && id > this.lastRequest, 'shared command IDs must never be reused');
    this.lastRequest = id;
    this.requests.push({ id, operation, target, data: structuredClone(data) });
    const hold = this.holds.find(value => !value.matched && value.operation === operation && value.matches(data, target));
    if (hold) hold.matched = true;
    const request = { id, operation, target, committed: false, cancelled: false, hold };
    this.pending.set(id, request);
    return (async () => {
      await Promise.resolve();
      if (hold && !hold.afterCommit) {
        hold.started.resolve(request);
        await hold.gate.promise;
      }
      if (request.cancelled) throw nativeError('ERR_RTC_CANCELLED');
      const result = this.execute(operation, target, data);
      request.committed = true;
      if (hold?.afterCommit) {
        hold.started.resolve({ ...request, result: structuredClone(result) });
        await hold.gate.promise;
      }
      return structuredClone(result);
    })().finally(() => this.pending.delete(id));
  }

  cancel(id) {
    this.cancellations.push(id);
    const request = this.pending.get(id);
    if (!request || request.committed)
      throw Object.assign(nativeError('ERR_RTC_REQUEST_ID', 'The native commit point already won.'), { status: 4 });
    request.cancelled = true;
    request.hold?.gate.reject(nativeError('ERR_RTC_CANCELLED'));
  }

  emit(type, target, data) {
    if (type === 'peer.state') {
      const entries = Object.entries(data);
      assert.equal(entries.length, 1, 'native peer.state emits exactly one state field per event');
      const [key, value] = entries[0];
      assert.ok(['signalingState', 'iceConnectionState', 'connectionState', 'iceGatheringState'].includes(key));
      assert.equal(typeof value, 'string');
    }
    const event = { type, target, data: structuredClone(data) };
    this.events.push(event);
    this.onEvent(event);
  }

  peer(id) {
    const peer = this.resources.get(id);
    assert.equal(peer?.kind, 'peer', `native peer ${id} must exist`);
    return peer;
  }

  execute(operation, target, data) {
    const failure = this.failures.findIndex(value => value.operation === operation
      && (value.target === undefined || value.target === target));
    if (failure >= 0) throw this.failures.splice(failure, 1)[0].error;
    assert.ok(['peer.create', 'peer.publish', 'peer.publishAudio', 'peer.setPublicationEnabled', 'peer.setReceiving', 'peer.setReceiverEnabled',
      'peer.setReceiverVolume', 'audio.configureOutput', 'audio.stopOutput',
      'peer.createOffer', 'peer.createAnswer', 'peer.setLocalDescription', 'peer.setRemoteDescription',
      'peer.addIceCandidate', 'resource.close'].includes(operation), `forbidden/non-contract operation: ${operation}`);
    if (operation === 'audio.configureOutput') {
      this.outputEpoch = data.epoch;
      this.outputReady = true;
      return { epoch: data.epoch, sampleRate: 48000, channels: 2 };
    }
    if (operation === 'audio.stopOutput') {
      if (data.epoch === this.outputEpoch) this.outputReady = false;
      return {};
    }
    if (operation === 'peer.create') {
      assert.equal(target, 0);
      assert.equal(data.receiveVideo, false);
      const peerId = this.nextResource++;
      this.resources.set(peerId, {
        kind: 'peer', peerId, syncGroup: data.syncGroup, receiving: false, signaling: 'stable',
        local: null, remote: null, mids: new Set(), midKinds: new Map(), publications: new Map(), receivers: new Map(),
        retiringAudio: new Map(),
      });
      this.emit('peer.state', peerId, { signalingState: 'stable' });
      this.emit('peer.state', peerId, { connectionState: 'new' });
      return { peerId };
    }
    if (operation === 'resource.close') {
      assert.deepEqual(data, {});
      assert.ok(!this.externalSources.has(target), 'broker must never close an externally owned source');
      const resource = this.resources.get(target);
      if (!resource) throw nativeError('ERR_RTC_RESOURCE');
      if (resource.kind === 'publication') {
        const peer = this.peer(resource.peerId);
        peer.publications.delete(target);
        resource.enabled = false;
        if (resource.mediaKind === 'audio') peer.retiringAudio.set(target, { ...resource });
        this.emit('peer.negotiationNeeded', resource.peerId, {});
      } else {
        assert.equal(resource.publications.size, 0, 'retire publications before their owning peer');
      }
      this.resources.delete(target);
      this.updateAudioStreams();
      this.updateAudioMix();
      return {};
    }
    if (operation === 'peer.setPublicationEnabled') {
      const publication = this.resources.get(target);
      assert.equal(publication?.kind, 'publication');
      publication.requestedEnabled = data.enabled;
      publication.enabled = data.enabled && this.externalSources.get(publication.sourceId).enabled;
      return { enabled: publication.enabled };
    }
    const peer = this.peer(target);
    if (operation === 'peer.publish' || operation === 'peer.publishAudio') {
      assert.equal(data.enabled, false, 'no native sender can start before Watch');
      const source = this.externalSources.get(data.sourceId), kind = operation === 'peer.publishAudio' ? 'audio' : 'video';
      assert.equal(source?.kind, kind);
      if (kind === 'audio') {
        assert.equal(peer.retiringAudio.size, 0, 'StopStandard must be negotiated stopped before another audio publication');
        assert.ok(![...peer.publications.values()].some(value => value.mediaKind === 'audio'));
        assert.ok(data.maxBitrateBps >= 6000 && data.maxBitrateBps <= 510000);
        assert.equal(data.maxFramerate, undefined);
      }
      const publicationId = this.nextResource++;
      const publication = { kind: 'publication', peerId: target, publicationId, sourceId: data.sourceId,
        mediaKind: kind, trackId: `${this.name}-actual-${kind}-track-${publicationId}`, mid: null, streamIds: [source.syncGroup],
        requestedEnabled: false, enabled: false };
      this.resources.set(publicationId, publication);
      peer.publications.set(publicationId, publication);
      this.emit('peer.publicationUpdated', target, { publicationId, kind, ...media(publication) });
      this.emit('peer.negotiationNeeded', target, {});
      return { publicationId, kind, ...media(publication) };
    }
    if (operation === 'peer.createOffer') {
      assert.equal(peer.signaling, 'stable', 'offer glare / no rollback is available');
      assert.deepEqual(data, {});
      return { type: 'offer', sdp: this.sdp(peer, 'offer') };
    }
    if (operation === 'peer.createAnswer') {
      assert.equal(peer.signaling, 'have-remote-offer');
      return { type: 'answer', sdp: this.sdp(peer, 'answer') };
    }
    if (operation === 'peer.setLocalDescription') {
      assert.ok(data.type === 'offer' || data.type === 'answer', 'rev2 has no rollback/pranswer');
      assert.equal(peer.signaling, data.type === 'offer' ? 'stable' : 'have-remote-offer');
      const described = this.readSdp(data.sdp);
      this.assertAudioOutput(described, 'local', data.expectedOutputEpoch);
      peer.signaling = data.type === 'offer' ? 'have-local-offer' : 'stable';
      peer.local = described;
      for (const described of peer.local.publications) {
        const publication = peer.publications.get(described.publicationId);
        if (publication && publication.mid !== described.mid) {
          publication.mid = described.mid;
          this.emit('peer.publicationUpdated', target, { publicationId: publication.publicationId,
            kind: publication.mediaKind, ...media(publication) });
        }
      }
      this.emit('peer.state', target, { signalingState: peer.signaling });
      this.updateAudioStreams();
      return {};
    }
    if (operation === 'peer.setRemoteDescription') {
      assert.ok(data.type === 'offer' || data.type === 'answer');
      assert.equal(peer.signaling, data.type === 'offer' ? 'stable' : 'have-local-offer');
      const described = this.readSdp(data.sdp);
      this.assertAudioOutput(described, 'remote', data.expectedOutputEpoch);
      peer.signaling = data.type === 'offer' ? 'have-remote-offer' : 'stable';
      peer.remote = described;
      for (const mid of peer.remote.mids) {
        peer.mids.add(mid);
        peer.midKinds.set(mid, peer.remote.kinds[mid]);
      }
      if (data.type === 'answer') for (const id of peer.local?.retiredAudioIds ?? []) peer.retiringAudio.delete(id);
      const seen = new Set();
      for (const described of peer.remote.publications) {
        const key = `${peer.remote.endpoint}:${described.publicationId}`;
        seen.add(key);
        const previous = [...peer.receivers.values()].find(receiver => receiver.key === key);
        if (!previous) this.addReceiver(peer, key, described);
        else if (!previous.present || JSON.stringify(media(previous)) !== JSON.stringify(media(described))) {
          Object.assign(previous, media(described), { present: true, requested: false, enabled: false, mediaKind: described.kind });
          this.receiverEvent(peer, previous, 'peer.trackUpdated');
        }
      }
      for (const receiver of peer.receivers.values()) {
        if (receiver.present && !seen.has(receiver.key)) {
          receiver.present = false;
          receiver.requested = false;
          receiver.enabled = false;
          this.receiverEvent(peer, receiver, 'peer.trackRemoved');
        }
      }
      this.emit('peer.state', target, { signalingState: peer.signaling });
      this.updateAudioStreams();
      return {};
    }
    if (operation === 'peer.addIceCandidate') {
      assert.ok(peer.remote, 'ICE must wait for an actual remote description');
      return {};
    }
    if (operation === 'peer.setReceiving') {
      if (data.enabled && [...peer.receivers.values()].some(receiver =>
        receiver.mediaKind === 'audio' && receiver.present && receiver.requested)) this.assertOutputEpoch(data.expectedOutputEpoch);
      peer.receiving = data.enabled;
      for (const receiver of peer.receivers.values()) {
        const enabled = peer.receiving && receiver.present && receiver.requested;
        if (enabled !== receiver.enabled) {
          receiver.enabled = enabled;
          this.receiverEvent(peer, receiver);
        }
      }
      this.emit('peer.negotiationNeeded', target, {});
      return { renegotiationRequired: true };
    }
    if (operation === 'peer.setReceiverEnabled') {
      const receiver = peer.receivers.get(data.receiverId);
      assert.ok(receiver, 'receiver IDs are not generic closeable resources');
      if (receiver.mediaKind === 'audio' && data.enabled) this.assertOutputEpoch(data.expectedOutputEpoch);
      const enabled = peer.receiving && receiver.present && data.enabled;
      if (receiver.requested !== data.enabled || receiver.enabled !== enabled) {
        receiver.requested = data.enabled;
        receiver.enabled = enabled;
        this.receiverEvent(peer, receiver);
      }
      return { receiverId: receiver.receiverId, receiverEpoch: receiver.epoch, enabled, requestedEnabled: data.enabled };
    }
    if (operation === 'peer.setReceiverVolume') {
      const receiver = peer.receivers.get(data.receiverId);
      assert.equal(receiver?.mediaKind, 'audio');
      assert.ok(data.volume >= 0 && data.volume <= 2);
      receiver.volume = data.volume;
      this.updateAudioMix();
      return { receiverId: receiver.receiverId, receiverEpoch: receiver.epoch, volume: data.volume };
    }
    assert.fail(`Unhandled command double operation ${operation}`);
  }

  sdp(peer, type) {
    const publications = [];
    for (const publication of peer.publications.values()) {
      if (type === 'answer' && (publication.mid === null || !peer.remote.mids.includes(publication.mid))) continue;
      let mid = publication.mid;
      if (mid === null) {
        let index = 0;
        while (peer.mids.has(String(index))) index++;
        mid = String(index);
        peer.mids.add(mid);
      }
      peer.midKinds.set(mid, publication.mediaKind);
      publications.push({ publicationId: publication.publicationId, kind: publication.mediaKind, ...media(publication), mid });
    }
    const mids = type === 'answer' ? peer.remote.mids : [...peer.mids];
    const directions = {}, stopped = [];
    for (const mid of mids) {
      const retired = [...peer.retiringAudio.values()].some(value => value.mid === mid);
      const local = publications.find(value => value.mid === mid);
      const remote = peer.remote?.publications.find(value => value.mid === mid);
      if (retired) { directions[mid] = 'inactive'; stopped.push(mid); }
      else if (local) directions[mid] = local.kind === 'audio' ? 'sendonly' : 'sendrecv';
      else if (remote) directions[mid] = peer.receiving ? 'recvonly' : 'inactive';
      else { directions[mid] = 'inactive'; stopped.push(mid); }
      if (type === 'answer' && !stopped.includes(mid)) {
        const offer = peer.remote.directions[mid], preferred = directions[mid];
        const send = ['sendrecv', 'sendonly'].includes(preferred) && ['sendrecv', 'recvonly'].includes(offer);
        const receive = ['sendrecv', 'recvonly'].includes(preferred) && ['sendrecv', 'sendonly'].includes(offer);
        directions[mid] = send && receive ? 'sendrecv' : send ? 'sendonly' : receive ? 'recvonly' : 'inactive';
      }
    }
    const dto = { endpoint: this.name, mids, kinds: Object.fromEntries(peer.midKinds), publications,
      directions, stopped, retiredAudioIds: type === 'offer' ? [...peer.retiringAudio.keys()] : [] };
    const encoded = Buffer.from(JSON.stringify(dto), 'utf8').toString('base64');
    return `v=0\r\na=x-test-dto:${encoded}\r\n${mids.map(mid =>
      `m=${dto.kinds[mid]} ${stopped.includes(mid) ? 0 : 9} UDP/TLS/RTP/SAVPF ${dto.kinds[mid] === 'audio' ? 111 : 96}\r\n`
      + `a=mid:${mid}\r\na=${directions[mid]}\r\n`
      + (dto.kinds[mid] === 'audio' ? 'a=rtpmap:111 opus/48000/2\r\n' : '')).join('')}`;
  }

  assertOutputEpoch(epoch) {
    assert.ok(Number.isSafeInteger(epoch) && epoch > 0, 'native audio admission requires the prepared output epoch');
    if (!this.outputReady || epoch !== this.outputEpoch) {
      throw Object.assign(nativeError('ERR_RTC_AUDIO_OUTPUT_PRE_ADMISSION'), { nativeStatus: 8 });
    }
  }

  grantAudioCredits() {}
  audioClockProbe(data) { return { ...data, rtcBeforeUs: 1000, rtcAfterUs: 1001 }; }
  calibrateAudioClock(data) { return { epoch: data.epoch, calibrationId: data.probeId, offsetUs: 0, uncertaintyUs: 1 }; }
  setAudioOutputFeedback() {}

  assertAudioOutput(dto, side, expectedOutputEpoch) {
    const receives = dto.mids.some(mid => dto.kinds[mid] === 'audio' && !dto.stopped.includes(mid)
      && ['sendrecv', side === 'local' ? 'recvonly' : 'sendonly'].includes(dto.directions[mid]));
    if (receives) this.assertOutputEpoch(expectedOutputEpoch);
  }

  updateAudioStreams() {
    let receiving = 0;
    for (const peer of this.resources.values()) {
      if (peer.kind !== 'peer') continue;
      for (const receiver of peer.receivers.values()) {
        const mid = receiver.mid;
        if (receiver.mediaKind === 'audio' && receiver.present
          && ['recvonly', 'sendrecv'].includes(peer.local?.directions[mid])
          && ['sendonly', 'sendrecv'].includes(peer.remote?.directions[mid])
          && !peer.local.stopped.includes(mid) && !peer.remote.stopped.includes(mid)) receiving++;
      }
    }
    if (this.receivingAudioStreams && !receiving) {
      this.outputStops++;
    }
    this.receivingAudioStreams = receiving;
  }

  updateAudioMix() {
    this.mixedReceivers = [...this.resources.values()].filter(value => value.kind === 'peer')
      .flatMap(peer => [...peer.receivers.values()])
      .filter(receiver => receiver.mediaKind === 'audio' && receiver.present && receiver.enabled && receiver.volume > 0)
      .map(receiver => receiver.receiverId);
  }

  readSdp(sdp) {
    const encoded = /^a=x-test-dto:([A-Za-z0-9+/=]+)$/mu.exec(sdp.replace(/\r/gu, ''))?.[1];
    assert.ok(encoded, 'test SDP must originate in one of these doubles');
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  }

  addReceiver(peer, key, described) {
    const receiver = { receiverId: this.nextReceiver++, epoch: 0, key, ...media(described),
      mediaKind: described.kind ?? 'video', volume: 1, present: true, requested: false, enabled: false };
    peer.receivers.set(receiver.receiverId, receiver);
    this.receiverEvent(peer, receiver, 'peer.trackAdded');
    return receiver;
  }

  receiverEvent(peer, receiver, type = 'peer.trackUpdated') {
    receiver.epoch++;
    this.emit(receiver.present ? type : 'peer.trackRemoved', peer.peerId,
      { receiverId: receiver.receiverId, receiverEpoch: receiver.epoch, kind: receiver.mediaKind, ...media(receiver) });
    if (receiver.enabled && receiver.mediaKind === 'video') this.decoded(peer.peerId, receiver);
    this.updateAudioMix();
  }

  decoded(peerId, receiver, epoch = receiver.epoch) {
    const event = { type: 'frame', target: peerId,
      data: { routeKind: 'peer', receiverId: receiver.receiverId, receiverEpoch: epoch } };
    this.frames.push(event);
    this.onEvent(event);
    return event;
  }

  publicationUpdate(publicationId, change) {
    const publication = this.resources.get(publicationId);
    Object.assign(publication, change);
    this.emit('peer.publicationUpdated', publication.peerId, { publicationId, kind: publication.mediaKind, ...media(publication) });
  }

  finishHolds() {
    this.failures = [];
    for (const hold of this.holds) hold.release();
  }
}

class AudioOwnerDouble {
  constructor(engine) {
    this.engine = engine;
    this.preparations = [];
    this.configurations = [];
    this.proofs = new WeakSet();
    this.bindings = new Map();
    this.revocations = [];
    this.volumes = [];
    this.publications = [];
    this.rebinds = [];
    this.unavailable = false;
    this.observeStoppedEpoch = true;
    this.preparationHold = null;
    this.rebindHold = null;
  }

  async prepareReceive(context) {
    assert.equal(context.engine, this.engine);
    this.preparations.push({ reason: context.reason, side: context.side, peerId: context.peerId });
    if (this.preparationHold && !this.preparationHold.used) {
      this.preparationHold.used = true;
      this.preparationHold.started.resolve();
      await this.preparationHold.gate.promise;
    }
    if (context.signal.aborted) throw nativeError('OWNER_ABORTED');
    if (this.unavailable || (!this.observeStoppedEpoch && this.engine.outputEpoch > 0 && !this.engine.outputReady)) {
      throw nativeError('OWNER_OUTPUT_UNPROVEN');
    }
    if (!this.engine.outputReady) {
      this.engine.outputEpoch++;
      this.engine.outputReady = true;
      this.configurations.push(this.engine.outputEpoch);
    }
    const proof = { engine: this.engine, epoch: this.engine.outputEpoch };
    this.proofs.add(proof);
    return proof;
  }

  assertReceiveReady(proof, context) {
    assert.equal(context.engine, this.engine);
    if (!this.proofs.has(proof) || !this.engine.outputReady || proof.epoch !== this.engine.outputEpoch) {
      throw nativeError('OWNER_OUTPUT_UNPROVEN');
    }
  }

  expectedOutputEpoch(proof, context) {
    this.assertReceiveReady(proof, context);
    return proof.epoch;
  }

  bindReceiver(selection, result, proof) {
    this.assertReceiveReady(proof, { engine: this.engine });
    assert.equal(selection.kind, 'audio');
    assert.equal(result.enabled, true);
    this.bindings.set(`${selection.peerId}:${selection.receiverId}`, structuredClone(selection));
  }

  revokeReceiver(selection, reason) {
    this.revocations.push({ ...structuredClone(selection), reason });
    const key = `${selection.peerId}:${selection.receiverId}`, current = this.bindings.get(key);
    if (current?.watchVersion === selection.watchVersion && current.receiverEpoch === selection.receiverEpoch) this.bindings.delete(key);
  }

  onReceiverVolume(selection, result) { this.volumes.push({ selection: structuredClone(selection), result: structuredClone(result) }); }
  onPublicationState(state) { this.publications.push(structuredClone(state)); }

  async rebindSource(context) {
    this.rebinds.push({ sourceId: context.sourceId, screenAudioShareId: context.screenAudioShareId, syncGroup: context.syncGroup });
    if (this.rebindHold && !this.rebindHold.afterCommit) {
      this.rebindHold.started.resolve();
      await this.rebindHold.gate.promise;
    }
    if (context.signal.aborted || !context.isCurrent()) throw nativeError('OWNER_ABORTED');
    for (const resource of this.engine.resources.values()) {
      assert.ok(resource.kind !== 'publication' || resource.sourceId !== context.sourceId, 'source group needs all native publications retired');
      if (resource.kind === 'peer') {
        assert.ok(![...resource.retiringAudio.values()].some(publication => publication.sourceId === context.sourceId),
          'source owner cannot rebind before the stopped SDP mutation is negotiated');
      }
    }
    const source = this.engine.externalSources.get(context.sourceId);
    assert.equal(source.kind, 'audio');
    source.syncGroup = context.syncGroup;
    if (this.rebindHold?.afterCommit) {
      this.rebindHold.started.resolve();
      await this.rebindHold.gate.promise;
    }
    return { sourceId: context.sourceId, syncGroup: source.syncGroup };
  }

  holdPreparation() {
    this.preparationHold = { started: deferred(), gate: deferred(), used: false };
    return this.preparationHold;
  }

  holdRebind(afterCommit = false) {
    this.rebindHold = { started: deferred(), gate: deferred(), afterCommit };
    return this.rebindHold;
  }
}

class Wire {
  constructor() { this.queue = []; this.history = []; this.endpoints = new Map(); this.block = () => false; }
  send = (from, to, message) => {
    const item = { from, to, message: structuredClone(message) };
    this.queue.push(item);
    this.history.push(structuredClone(item));
    return Promise.resolve();
  };
  async deliverOne() {
    const index = this.queue.findIndex((item, position) => !this.block(item)
      && !this.queue.slice(0, position).some(previous => previous.from === item.from && previous.to === item.to));
    if (index < 0) return false;
    const [item] = this.queue.splice(index, 1);
    await this.endpoints.get(item.to).broker.receive(item.from, item.message);
    return true;
  }
}

async function world(t, names = ['a', 'b'], options = {}) {
  const clock = new Clock(), wire = new Wire(), endpoints = new Map();
  const { av = false, realAudioOutput = false, ...brokerOptions } = options;
  const videoSources = new Map();
  for (const name of names) {
    const engine = new CommandsDouble(name), commands = new NativeRtcCommands(engine), routes = new NativeScreenRoutes();
    const errors = [], states = [], demand = [], routed = [];
    const endpoint = { name, engine, commands, routes, errors, states, demand, routed, current: true };
    let audioOwner = av ? new AudioOwnerDouble(engine) : null;
    if (realAudioOutput) {
      assert.equal(av, true);
      const { NativeAudioOutputOwner } = require('../runtime/nativeAudioOutputOwner.cjs');
      const { NativeAudioReceiveAdapter } = require('../runtime/nativeAudioReceiveAdapter.cjs');
      const output = new NativeAudioOutputOwner(engine, commands, {
        async start(config, signal) {
          await output.configureOutput(config);
          signal.throwIfAborted();
          output.probe({ epoch: config.epoch, probeId: 1 });
          output.calibrate({ epoch: config.epoch, probeId: 1, rendererBeforeUs: 1000, rendererAfterUs: 1001 });
          return config;
        },
        async stop() {},
        async enqueue() {},
      }, error => errors.push(error));
      endpoint.output = output;
      audioOwner = new NativeAudioReceiveAdapter({
        engine, output, callId: 'call-606', channelId: 'channel-621', isCurrent: () => endpoint.current,
      });
      await output.start('explicit-modeled-output');
    }
    endpoint.audioOwner = audioOwner;
    endpoint.broker = new NativeP2pBroker({
      engine, commands, routes, localSessionId: name, syncGroup: `${name}-sync`, callId: 'call-606', channelId: 'channel-621',
      send: (to, message) => wire.send(name, to, message), isCurrent: () => endpoint.current,
      onError: error => errors.push(error), onPeerState: state => states.push(state), onPublicationState: state => demand.push(state),
      timers: clock, controlVersion: av ? 2 : 1, audio: audioOwner, ...brokerOptions,
    });
    engine.onEvent = event => {
      if (endpoint.output?.handleNativeEvent(event)) return;
      endpoint.broker.handleNativeEvent(event);
      if (event.type === 'frame') routed.push({ event, destination: routes.resolveFrame(event) });
    };
    const routeTrack = routes.onTrackEvent.bind(routes);
    routes.onTrackEvent = event => { assert.equal(event.data.kind, 'video', 'audio must never enter NativeScreenRoutes'); return routeTrack(event); };
    endpoints.set(name, endpoint);
    wire.endpoints.set(name, endpoint);
  }
  for (const endpoint of endpoints.values()) {
    for (const name of names) await endpoint.broker.setRoster(name, ['screen-one', 'screen-two']);
  }
  const fixture = {
    endpoints, clock, wire,
    async connect(left = 'a', right = 'b', generation = 1) {
      const connectionId = `${[left, right].sort().join('-')}-${generation}`;
      await Promise.all([endpoints.get(left).broker.connect(right, { connectionId, generation }),
        endpoints.get(right).broker.connect(left, { connectionId, generation })]);
    },
    supply(name, shareId = 'screen-one', { enabled = true } = {}) {
      const endpoint = endpoints.get(name);
      const syncGroup = `${name}-${shareId}-${endpoint.engine.nextResource}-sync`;
      const sourceId = endpoint.engine.supplySource(syncGroup);
      endpoint.broker.registerSource({ sourceId, localShareId: shareId, syncGroup });
      videoSources.set(`${name}:${shareId}`, sourceId);
      // Most fixtures model an owner already supplying capture/preview; disabled-source cases opt out.
      endpoint.engine.setOwnedSourceEnabled(sourceId, enabled);
      return sourceId;
    },
    supplyAudio(name, shareId = 'screen-one') {
      const endpoint = endpoints.get(name);
      const video = endpoint.engine.externalSources.get(videoSources.get(`${name}:${shareId}`));
      assert.ok(video);
      const sourceId = endpoint.engine.supplySource(video.syncGroup, 'audio');
      endpoint.broker.registerAudioSource({ sourceId, screenAudioShareId: shareId, syncGroup: video.syncGroup });
      endpoint.engine.setOwnedSourceEnabled(sourceId, true);
      return sourceId;
    },
    async settle() {
      for (let round = 0; round < 500; round++) {
        await Promise.all([...endpoints.values()].map(endpoint => endpoint.broker.idle()));
        if (!await wire.deliverOne()) return;
      }
      assert.fail('In-memory control exchange did not converge.');
    },
    messages(type, from) { return wire.history.filter(item => item.message.type === type && (!from || item.from === from)); },
  };
  t.after(async () => {
    for (const endpoint of endpoints.values()) {
      endpoint.engine.finishHolds();
      endpoint.audioOwner?.preparationHold?.gate.resolve();
      endpoint.audioOwner?.rebindHold?.gate.resolve();
    }
    for (const endpoint of endpoints.values()) {
      await endpoint.broker.close();
      await endpoint.output?.stop();
    }
    assert.equal(clock.tasks.size, 0, 'all deterministic operation/turn timers must be cleared');
    for (const endpoint of endpoints.values()) {
      assert.equal(endpoint.engine.resources.size, 0);
      assert.ok(endpoint.engine.requests.every(request => !request.operation.startsWith('source.')
        && !request.operation.startsWith('sfu.') && !request.operation.startsWith('engine.')));
    }
  });
  return fixture;
}

function peerOf(endpoint, remote) { return endpoint.engine.peer(endpoint.broker.getPeer(remote).peerId); }
function pubs(endpoint, remote) { return [...peerOf(endpoint, remote).publications.values()]; }
function watchedReceiver(endpoint, remote, publication) {
  return [...peerOf(endpoint, remote).receivers.values()].find(receiver => receiver.trackId === publication.trackId && receiver.present);
}
function envelope(type, fields = {}) {
  return { protocol: NATIVE_P2P_CONTROL_SCHEMA.protocol, version: 1, callId: 'call-606', channelId: 'channel-621',
    connectionId: 'a-b-1', generation: 1, type, ...fields };
}
async function microtasks(count = 20) { for (let index = 0; index < count; index++) await Promise.resolve(); }

function beginOwnerClose(endpoint) {
  const completion = deferred();
  endpoint.engine.close = () => {
    endpoint.engine.closeCalls = (endpoint.engine.closeCalls ?? 0) + 1;
    return completion.promise;
  };
  return {
    promise: endpoint.commands.closeEngine(),
    resolve(snapshot = { nativeThreadsDrained: true }) {
      endpoint.engine.resources.clear();
      completion.resolve(snapshot);
    },
    reject: completion.reject,
  };
}

test('inert construction, immutable scopes and strict bounded serializable CONTROL DTOs', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  assert.equal(a.engine.requests.length, 0);
  assert.throws(() => { a.broker.callId = 'other'; }, TypeError);
  const input = envelope('publication', {
    shareId: 'screen-one', publicationId: 2, publicationVersion: 1, metadataVersion: 1,
    trackId: 'actual-track', mid: null, streamIds: ['not-an-authenticated-share'],
  });
  const parsed = parseNativeP2pMessage(input);
  input.streamIds[0] = 'mutated';
  assert.equal(parsed.streamIds[0], 'not-an-authenticated-share');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
  for (const invalid of [
    { ...parsed, fromSessionId: 'victim' }, { ...parsed, type: 'rollback' }, { ...parsed, version: 2 },
    { ...parsed, publicationVersion: Number.MAX_SAFE_INTEGER + 1 }, { ...parsed, streamIds: Array(9).fill('x') },
    { ...parsed, streamIds: Array(2) },
    envelope('offer', { turn: 1, sdp: 'x'.repeat(1024 * 1024 + 1) }),
    envelope('ice', { turn: 1, candidate: 'x'.repeat(8193), sdpMid: '0', sdpMLineIndex: 0 }),
    envelope('ice', { turn: 1, candidate: 'candidate:x', sdpMid: null, sdpMLineIndex: null }),
    envelope('ice', { turn: 1, candidate: 'candidate:x', sdpMid: '0', sdpMLineIndex: -1 }),
  ]) assert.throws(() => parseNativeP2pMessage(invalid), { code: 'P2P_PROTOCOL' });
  assert.throws(() => parseNativeP2pMessage({ get type() { assert.fail('do not execute message getters'); } }), /message type/u);
  const streamsWithGetter = [];
  Object.defineProperty(streamsWithGetter, '0', { get() { assert.fail('do not execute stream getters'); } });
  assert.throws(() => parseNativeP2pMessage({ ...parsed, streamIds: streamsWithGetter }), /stream reference/u);
  await h.connect();
  const count = a.engine.requests.length;
  for (const [sender, inputMessage] of [
    ['c', parsed], ['b', { ...parsed, callId: 'old-call' }], ['b', { ...parsed, channelId: 'old-channel' }],
    ['b', { ...parsed, connectionId: 'old-connection' }], ['b', { ...parsed, generation: 2 }],
  ]) assert.equal((await a.broker.receive(sender, inputMessage)).accepted, false);
  assert.equal(a.engine.requests.length, count);
  assert.ok(!Object.keys(require.cache).some(path => /nativeRtc[\\/]engine[\\/]node[\\/]index\.cjs$/u.test(path)));
});

test('private registry identity rejects a foreign genuine commands instance despite a shadowed engine getter before effects', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  const foreign = new NativeRtcCommands(b.engine);
  let getterReads = 0;
  Object.defineProperty(foreign, 'engine', { get() { getterReads++; return a.engine; }, configurable: true });
  assert.equal(isNativeRtcCommandsForEngine(foreign, a.engine), false);
  assert.equal(isNativeRtcCommandsForEngine(foreign, b.engine), true);
  assert.throws(() => new NativeP2pBroker({
    engine: a.engine, commands: foreign, routes: a.routes, localSessionId: 'a', syncGroup: 'a-scope',
    callId: 'call-606', channelId: 'channel-621', send: () => Promise.resolve(),
    controlVersion: 2, audio: a.audioOwner,
  }), { code: 'P2P_PROTOCOL' });
  assert.equal(getterReads, 0, 'admission uses the private engine identity, not the public getter');
  assert.equal(a.engine.requests.length, 0);
  assert.equal(b.engine.requests.length, 0);
  assert.equal(a.engine.resources.size + b.engine.resources.size, 0);
  assert.equal(foreign.pending.size, 0);
});

test('consecutive peer.state patches preserve other fields, isolate peers and reset on replacement', async t => {
  const h = await world(t, ['a', 'b', 'c']), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect('a', 'b');
  await h.connect('a', 'c');
  const peerId = a.broker.getPeer('b').peerId;
  const initial = { signalingState: 'stable', connectionState: 'new' };
  assert.deepEqual(a.broker.getPeer('b').nativeState, initial);
  let expected = initial;
  for (const patch of [
    { connectionState: 'connecting' },
    { iceConnectionState: 'checking' },
    { iceGatheringState: 'gathering' },
    { connectionState: 'connected' },
    { signalingState: 'have-local-offer' },
    { iceGatheringState: 'complete' },
    { signalingState: 'stable' },
  ]) {
    const previousSnapshot = a.broker.getPeer('b').nativeState;
    a.engine.emit('peer.state', peerId, patch);
    assert.deepEqual(previousSnapshot, expected, 'previous snapshots must not be mutated');
    expected = { ...expected, ...patch };
    assert.deepEqual(a.broker.getPeer('b').nativeState, expected);
    assert.deepEqual(a.states.at(-1).nativeState, expected);
    assert.deepEqual(a.broker.getPeer('c').nativeState, initial);
  }
  await Promise.all([a.broker.closePeer('b'), b.broker.closePeer('a')]);
  await h.connect('a', 'b', 2);
  assert.deepEqual(a.broker.getPeer('b').nativeState, initial, 'a new peer cannot inherit the previous peer state');
  assert.deepEqual(a.broker.getPeer('c').nativeState, initial);
});

test('two distinct source groups share one peer, stay sender-disabled before Watch, and Stop is per screen', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two');
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b')]);
  await h.settle();
  const [publicationOne, publicationTwo] = pubs(a, 'b');
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
  assert.equal(b.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
  assert.notDeepEqual(publicationOne.streamIds, publicationTwo.streamIds);
  assert.notEqual(publicationOne.trackId, publicationTwo.trackId);
  assert.notEqual(publicationOne.mid, publicationTwo.mid);
  assert.ok(pubs(a, 'b').every(publication => !publication.enabled));
  assert.equal(b.broker.getPeer('a').receiving, false);
  assert.equal(a.broker.getPeer('b').nativeState.connectionState, 'new', 'negotiated does not mean connected');
  await Promise.all([b.broker.watch('a', 'screen-one', destination('first')),
    b.broker.watch('a', 'screen-two', destination('second'))]);
  await h.settle();
  assert.ok(pubs(a, 'b').every(publication => publication.enabled));
  assert.equal(a.broker.sourceDemand(one), 1);
  assert.equal(a.broker.sourceDemand(two), 1);
  for (const [publication, expected] of [[publicationOne, 'first'], [publicationTwo, 'second']]) {
    const receiver = watchedReceiver(b, 'a', publication);
    assert.equal(receiver.enabled, true);
    const frame = b.engine.decoded(peerOf(b, 'a').peerId, receiver);
    assert.equal(b.routes.resolveFrame(frame).presentationId, expected);
  }
  await b.broker.stopWatching('a', 'screen-one');
  await h.settle();
  assert.equal(publicationOne.enabled, false);
  assert.equal(publicationTwo.enabled, true);
  assert.equal(b.broker.getPeer('a').receiving, true);
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peerOf(b, 'a').peerId, watchedReceiver(b, 'a', publicationOne))), null);
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peerOf(b, 'a').peerId, watchedReceiver(b, 'a', publicationTwo))).presentationId, 'second');
  await a.broker.removeSource(two);
  await h.settle();
  assert.equal(b.broker.getPeer('a').receiving, false);
  assert.equal(a.engine.resources.has(publicationTwo.publicationId), false);
  assert.ok(a.broker.getPeer('b'), 'stopping a source does not close the participant pair');
  assert.equal(a.engine.externalSources.size, 2, 'external capture/source ownership is untouched');
});

test('publication results and state snapshots cannot mutate internal binding metadata', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const source = h.supply('a');
  const publication = await a.broker.publish(source, 'b');
  publication.streamIds[0] = 'caller-mutation';
  await h.settle();
  const snapshot = a.broker.getPeer('b');
  snapshot.publications[0].streamIds[0] = 'another-caller-mutation';
  snapshot.resources.length = 0;
  const current = await a.broker.publish(source, 'b');
  assert.equal(current.mid, pubs(a, 'b')[0].mid, 'idempotent publication returns fresh negotiated metadata');
  assert.deepEqual(current.streamIds, [a.engine.externalSources.get(source).syncGroup]);
  assert.deepEqual(a.broker.getPeer('b').publications[0].streamIds, [a.engine.externalSources.get(source).syncGroup]);
  assert.ok(a.broker.getPeer('b').resources.length > 0);
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.publish').length, 1);
});

test('a disabled source can acknowledge first Watch false while authorized demand wakes its owner without a cycle', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const source = h.supply('a', 'screen-one', { enabled: false });
  await a.broker.publish(source, 'b');
  await h.settle();
  const demandSeen = deferred();
  a.broker.onPublicationState = state => {
    a.demand.push(state);
    if (state.sourceId === source && state.demanded) demandSeen.resolve(a.broker.sourceDemand(source));
  };
  await b.broker.watch('a', 'screen-one', destination('waiting-for-capture'));
  await h.settle();
  const publication = pubs(a, 'b')[0], state = a.broker.getPeer('b').publications[0];
  assert.equal(a.broker.getPeer('b').status, 'open');
  assert.equal(await demandSeen.promise, 1);
  assert.equal(a.broker.sourceDemand(source), 1);
  assert.equal(state.demanded, true);
  assert.equal(state.requestedEnabled, true);
  assert.equal(state.enabled, false, 'false is the actual combined-gate acknowledgement, not a failure');
  assert.equal(publication.requestedEnabled, true);
  assert.equal(publication.enabled, false);
  assert.ok(a.demand.some(value => value.demanded && value.enabled === false));
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.setPublicationEnabled'
    && request.data.enabled === true).length, 1, 'a closed source gate must not cause a retry loop');
  a.engine.setOwnedSourceEnabled(source, a.broker.sourceDemand(source) > 0);
  assert.equal(publication.enabled, true, 'only the external source owner completes the combined gate');
  assert.equal(a.broker.getPeer('b').publications[0].enabled, false,
    'the broker retains the last actual ACK; it cannot fabricate observations of a later source change');
  assert.equal(a.errors.length, 0);
});

test('Stop after a disabled-source Watch still clears the requested sender gate before the source can start later', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const source = h.supply('a', 'screen-one', { enabled: false });
  await a.broker.publish(source, 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('stop-before-capture'));
  await h.settle();
  await b.broker.stopWatching('a', 'screen-one');
  await h.settle();
  const publication = pubs(a, 'b')[0];
  assert.equal(a.broker.sourceDemand(source), 0);
  assert.deepEqual(a.engine.requests.filter(request => request.operation === 'peer.setPublicationEnabled')
    .map(request => request.data.enabled), [true, false]);
  assert.equal(publication.requestedEnabled, false);
  a.engine.setOwnedSourceEnabled(source, true);
  assert.equal(publication.enabled, false, 'no unwatched RTP can revive when the source is enabled');
  assert.equal(a.broker.getPeer('b').publications[0].demanded, false);
  assert.equal(a.broker.getPeer('b').publications[0].requestedEnabled, false);
  assert.equal(a.errors.length, 0);
});

test('an effective true acknowledgement of a requested sender disable still fails closed', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('authorized'));
  await h.settle();
  const execute = a.engine.execute.bind(a.engine);
  a.engine.execute = (operation, target, data) => {
    const result = execute(operation, target, data);
    return operation === 'peer.setPublicationEnabled' && data.enabled === false ? { enabled: true } : result;
  };
  await b.broker.stopWatching('a', 'screen-one');
  await assert.rejects(h.settle(), { code: 'P2P_PROTOCOL' });
  await a.broker.idle();
  assert.ok(a.states.some(state => state.status === 'failed'));
  assert.ok(a.errors.some(error => error.code === 'P2P_PROTOCOL'));
});

test('simultaneous two-screen publication and Watch on BOTH endpoints grants offers to either side without glare', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const sources = [h.supply('a'), h.supply('a', 'screen-two'), h.supply('b'), h.supply('b', 'screen-two')];
  await Promise.all([
    a.broker.publish(sources[0], 'b'), a.broker.publish(sources[1], 'b'),
    b.broker.publish(sources[2], 'a'), b.broker.publish(sources[3], 'a'),
    a.broker.watch('b', 'screen-one', destination('a-one')), a.broker.watch('b', 'screen-two', destination('a-two')),
    b.broker.watch('a', 'screen-one', destination('b-one')), b.broker.watch('a', 'screen-two', destination('b-two')),
  ]);
  await h.settle();
  for (const [endpoint, remote] of [[a, 'b'], [b, 'a']]) {
    assert.equal(pubs(endpoint, remote).length, 2);
    assert.ok(pubs(endpoint, remote).every(publication => publication.enabled && publication.mid !== null));
    assert.equal([...peerOf(endpoint, remote).receivers.values()].filter(receiver => receiver.enabled).length, 2);
    assert.equal(endpoint.broker.getPeer(remote).turn, null);
    assert.equal(endpoint.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
    assert.ok(endpoint.engine.requests.some(request => request.operation === 'peer.createOffer'));
  }
  const turns = h.messages('turn', 'a').map(item => item.message);
  assert.deepEqual(turns.map(turn => turn.turn), turns.map((_, index) => index + 1));
  assert.deepEqual(new Set(turns.map(turn => turn.offererSessionId)), new Set(['a', 'b']));
  assert.ok(h.messages('turn-applied', 'b').length > 0);
  for (const offer of h.messages('offer')) {
    const grantIndex = h.wire.history.findIndex(item => item.message.type === 'turn' && item.message.turn === offer.message.turn);
    const offerIndex = h.wire.history.findIndex(item => item === offer);
    assert.ok(grantIndex >= 0 && grantIndex < offerIndex, 'grant must be enqueued before its offer');
  }
  assert.equal(a.errors.length + b.errors.length, 0);
});

test('a delayed answer application and a premature stable event cannot grant the next offer', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const first = h.supply('a'), second = h.supply('a', 'screen-two');
  const heldAnswer = a.engine.holdNext('peer.setRemoteDescription', { matches: data => data.type === 'answer' });
  await a.broker.publish(first, 'b');
  await a.broker.idle();
  while (!h.wire.queue.some(item => item.message.type === 'answer')) await h.wire.deliverOne();
  while (h.wire.queue[0].message.type !== 'answer') await h.wire.deliverOne();
  const delivery = h.wire.deliverOne();
  await heldAnswer.started.promise;
  const offers = a.engine.requests.filter(request => request.operation === 'peer.createOffer').length;
  const publishing = a.broker.publish(second, 'b');
  for (let index = 0; index < 25; index++) a.engine.emit('peer.negotiationNeeded', peerOf(a, 'b').peerId, {});
  a.engine.emit('peer.state', peerOf(a, 'b').peerId, { signalingState: 'stable' });
  await microtasks();
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.createOffer').length, offers);
  assert.equal(h.messages('turn-done').length, 0);
  assert.equal(a.broker.getPeer('b').turn.phase, 'applying-answer');
  heldAnswer.release();
  await delivery;
  await publishing;
  await h.settle();
  assert.ok(a.engine.requests.filter(request => request.operation === 'peer.createOffer').length > offers);
  assert.equal(a.broker.getPeer('b').turn, null);
  assert.equal(b.broker.getPeer('a').turn, null);
});

test('leader answering a remote offer waits for the exact answer-applied acknowledgement before another turn', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const fromB = h.supply('b'), fromA = h.supply('a');
  h.wire.block = item => item.from === 'b' && item.message.type === 'turn-applied';
  await b.broker.publish(fromB, 'a');
  await h.settle();
  assert.equal(a.broker.getPeer('b').turn.phase, 'await-applied');
  assert.equal(b.broker.getPeer('a').turn.phase, 'await-done');
  const granted = h.messages('turn').length;
  await a.broker.publish(fromA, 'b');
  await a.broker.idle();
  assert.equal(h.messages('turn').length, granted);
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.createOffer').length, 0);
  h.wire.block = () => false;
  await h.settle();
  assert.ok(h.messages('turn').length > granted);
  assert.ok(a.engine.requests.some(request => request.operation === 'peer.createOffer'));
});

test('an authenticated answer with the wrong turn fails before any native remote SDP mutation', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await a.broker.idle();
  const outstanding = a.broker.getPeer('b').turn.sequence;
  const before = a.engine.requests.filter(request => request.operation === 'peer.setRemoteDescription').length;
  await assert.rejects(a.broker.receive('b', envelope('answer', { turn: outstanding + 1, sdp: 'v=0\r\n' })),
    /outstanding native negotiation turn/u);
  await a.broker.idle();
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.setRemoteDescription').length, before);
  assert.ok(a.states.some(state => state.status === 'failed'));
});

test('ICE before an offer waits for remote SDP; late same-connection ICE survives reoffers, old connections do not', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const ice = envelope('ice', { turn: 1, candidate: 'candidate:in-memory', sdpMid: '0', sdpMLineIndex: 0 });
  await b.broker.receive('a', ice);
  assert.equal(b.engine.requests.some(request => request.operation === 'peer.addIceCandidate'), false);
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  const descriptionIndex = b.engine.requests.findIndex(request => request.operation === 'peer.setRemoteDescription');
  const iceIndex = b.engine.requests.findIndex(request => request.operation === 'peer.addIceCandidate');
  assert.ok(descriptionIndex >= 0 && iceIndex > descriptionIndex);
  await b.broker.watch('a', 'screen-one', destination('watch'));
  await h.settle();
  const count = b.engine.requests.filter(request => request.operation === 'peer.addIceCandidate').length;
  await b.broker.receive('a', ice);
  assert.equal(b.engine.requests.filter(request => request.operation === 'peer.addIceCandidate').length, count + 1);
  await Promise.all([a.broker.closePeer('b'), b.broker.closePeer('a')]);
  await h.connect('a', 'b', 2);
  assert.equal((await b.broker.receive('a', ice)).accepted, false);
  assert.equal(b.engine.requests.filter(request => request.operation === 'peer.addIceCandidate').length, count + 1);
});

test('late Watch true/false cannot affect replacement publications or a newer subscription on the same publication', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const oldSource = h.supply('a');
  await a.broker.publish(oldSource, 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('old'));
  await h.settle();
  const oldTrue = h.messages('watch', 'b').at(-1).message;
  await b.broker.stopWatching('a', 'screen-one');
  await h.settle();
  const oldFalse = h.messages('watch', 'b').at(-1).message;
  await a.broker.removeSource(oldSource);
  await h.settle();
  const replacement = h.supply('a');
  await a.broker.publish(replacement, 'b');
  await h.settle();
  const current = pubs(a, 'b')[0];
  assert.equal(current.enabled, false, 'replacement never inherits an old Watch');
  await a.broker.receive('b', oldTrue);
  await a.broker.receive('b', oldFalse);
  assert.equal(current.enabled, false);
  await b.broker.watch('a', 'screen-one', destination('new'));
  await h.settle();
  assert.equal(current.enabled, true);
  await a.broker.receive('b', oldFalse);
  assert.equal(current.enabled, true);
  await b.broker.stopWatching('a', 'screen-one');
  await h.settle();
  const previousStop = h.messages('watch', 'b').at(-1).message;
  await b.broker.watch('a', 'screen-one', destination('newer'));
  await h.settle();
  await a.broker.receive('b', previousStop);
  assert.equal(current.enabled, true);
  const receiver = watchedReceiver(b, 'a', current);
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peerOf(b, 'a').peerId, receiver)).presentationId, 'newer');
});

test('native receiver metadata can precede authenticated publication metadata but never authorizes delivery alone', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const published = await a.broker.publish(h.supply('a'), 'b');
  const receiver = b.engine.addReceiver(peerOf(b, 'a'), `a:${published.publicationId}`, published);
  await b.broker.watch('a', 'screen-one', destination('later'));
  await b.broker.idle();
  assert.equal(receiver.requested, false);
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peerOf(b, 'a').peerId, receiver)), null);
  assert.equal(pubs(a, 'b')[0].enabled, false);
  await h.settle();
  assert.equal(receiver.requested, true);
  assert.equal(receiver.enabled, true);
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peerOf(b, 'a').peerId, receiver)).presentationId, 'later');
});

test('MID/stream/epoch rebinding immediately revokes frames and needs fresh actual metadata plus receiver authorization', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('screen'));
  await h.settle();
  const publication = pubs(a, 'b')[0], receiver = watchedReceiver(b, 'a', publication), peer = peerOf(b, 'a');
  const oldEpoch = receiver.epoch;
  Object.assign(receiver, { mid: '77', streamIds: ['actual-rebound-stream'], requested: false, enabled: false });
  b.engine.receiverEvent(peer, receiver);
  const reboundEpoch = receiver.epoch;
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peer.peerId, receiver, oldEpoch)), null);
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peer.peerId, receiver)), null);
  await b.broker.idle();
  assert.equal(receiver.enabled, false);
  a.engine.publicationUpdate(publication.publicationId, { mid: '77', streamIds: ['actual-rebound-stream'] });
  await h.settle();
  assert.equal(receiver.enabled, true);
  assert.ok(receiver.epoch > reboundEpoch);
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peer.peerId, receiver)).presentationId, 'screen');
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peer.peerId, receiver, reboundEpoch)), null);
  const refreshed = h.messages('publication', 'a').at(-1).message;
  assert.equal(refreshed.mid, '77');
  assert.deepEqual(refreshed.streamIds, ['actual-rebound-stream']);
});

test('Stop during a held receiver-enable result rejects its old authorization without touching another watched screen', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  await Promise.all([a.broker.publish(h.supply('a'), 'b'), a.broker.publish(h.supply('a', 'screen-two'), 'b')]);
  await h.settle();
  const first = watchedReceiver(b, 'a', pubs(a, 'b')[0]);
  const held = b.engine.holdNext('peer.setReceiverEnabled', { afterCommit: true,
    matches: data => data.receiverId === first.receiverId && data.enabled === true });
  const watching = b.broker.watch('a', 'screen-one', destination('obsolete'));
  await held.started.promise;
  const stopping = b.broker.stopWatching('a', 'screen-one');
  const secondWatching = b.broker.watch('a', 'screen-two', destination('remaining'));
  assert.equal(b.routes.resolveFrame(b.engine.decoded(peerOf(b, 'a').peerId, first)), null);
  held.release();
  await Promise.all([watching, stopping, secondWatching]);
  await h.settle();
  assert.equal(first.enabled, false);
  assert.equal(pubs(a, 'b')[0].enabled, false);
  assert.equal(pubs(a, 'b')[1].enabled, true);
  assert.equal(b.broker.getPeer('a').receiving, true);
});

test('leaving during peer.create cancels the exact request and closes a committed late peer before forgetting it', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  const hold = a.engine.holdNext('peer.create', { afterCommit: true });
  const opening = a.broker.connect('b', { connectionId: 'a-b-1', generation: 1 });
  const openingRejected = assert.rejects(opening, { code: 'P2P_CANCELLED' });
  const native = await hold.started.promise;
  const command = a.commands.getPendingRequest(native.id);
  command.data.syncGroup = 'cannot-mutate-pending';
  assert.equal(a.commands.getPendingRequest(native.id).data.syncGroup, 'a-sync');
  const closing = a.broker.closePeer('b');
  assert.deepEqual(a.engine.cancellations, [native.id]);
  assert.ok(a.broker.getPeer('b'), 'pending create is still owned');
  assert.equal(a.engine.resources.has(native.result.peerId), true);
  hold.release();
  await Promise.all([openingRejected, closing]);
  await a.broker.idle();
  assert.equal(a.engine.resources.size, 0);
  assert.equal(a.broker.getPeer('b'), null);
});

test('leaving during peer.publish closes a late publication before its peer, never source/global engine resources', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const source = h.supply('a'), peerId = a.broker.getPeer('b').peerId;
  const held = a.engine.holdNext('peer.publish', { afterCommit: true });
  const publishing = a.broker.publish(source, 'b');
  const rejected = assert.rejects(publishing, { code: 'P2P_CANCELLED' });
  const native = await held.started.promise;
  const closing = a.broker.closePeer('b');
  assert.ok(a.engine.cancellations.includes(native.id));
  held.release();
  await Promise.all([closing, rejected]);
  const closes = a.engine.requests.filter(request => request.operation === 'resource.close').map(request => request.target);
  assert.deepEqual(closes, [native.result.publicationId, peerId]);
  assert.equal(a.engine.externalSources.has(source), true);
  assert.equal(a.broker.sourceDemand(source), 0);
  assert.equal(h.messages('publication', 'a').length, 0);
});

test('removing a source while creation is pending retires the late publication and permits a fresh same-share source', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const oldSource = h.supply('a');
  const hold = a.engine.holdNext('peer.publish', { afterCommit: true });
  const oldStart = a.broker.publish(oldSource, 'b');
  const rejected = assert.rejects(oldStart, { code: 'P2P_CANCELLED' });
  const late = await hold.started.promise;
  const stopping = a.broker.removeSource(oldSource);
  const nextSource = h.supply('a');
  const replacement = a.broker.publish(nextSource, 'b');
  hold.release();
  await Promise.all([rejected, stopping, replacement]);
  await h.settle();
  assert.equal(a.engine.resources.has(late.result.publicationId), false);
  assert.equal(pubs(a, 'b').length, 1);
  assert.equal(pubs(a, 'b')[0].sourceId, nextSource);
  assert.equal(pubs(a, 'b')[0].enabled, false);
  assert.equal(a.broker.getPeer('b').status, 'open');
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
});

test('a timed-out stopped publication keeps ownership and closes its late ID without harming a live replacement', async t => {
  for (const failLateClose of [false, true]) {
    await t.test(failLateClose ? 'late close failure remains retryable' : 'late close succeeds automatically', async child => {
      const h = await world(child, ['a', 'b'], { operationTimeoutMs: 100 }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
      await h.connect();
      const keptSource = h.supply('a', 'screen-two');
      await a.broker.publish(keptSource, 'b');
      await h.settle();
      await b.broker.watch('a', 'screen-two', destination('keep-watching'));
      await h.settle();
      const kept = pubs(a, 'b')[0], oldSource = h.supply('a');
      const hold = a.engine.holdNext('peer.publish', { afterCommit: true });
      const starting = a.broker.publish(oldSource, 'b');
      const cancelled = assert.rejects(starting, error => error.code === 'P2P_CANCELLED' && error.cause?.code === 'P2P_TIMEOUT');
      const late = await hold.started.promise;
      const removing = a.broker.removeSource(oldSource);
      const retained = assert.rejects(removing, error => error instanceof AggregateError
        && error.errors.some(reason => reason.code === 'P2P_OWNERSHIP_RETAINED'));
      h.clock.advance(101);
      await Promise.all([cancelled, retained]);
      assert.equal(a.broker.getPeer('b').status, 'open');
      assert.ok(a.broker.getPeer('b').pendingRequests.includes(late.id));
      assert.equal(a.broker.sources.has(oldSource), true);
      assert.equal(kept.enabled, true);
      const nextSource = h.supply('a');
      const replacement = await a.broker.publish(nextSource, 'b');
      await h.settle();
      await b.broker.watch('a', 'screen-one', destination('replacement'));
      await h.settle();
      if (failLateClose) a.engine.failNext('resource.close', late.result.publicationId, 'LATE_CLOSE_RETAINED');
      hold.release();
      await microtasks();
      await h.settle();
      if (failLateClose) {
        assert.ok(a.errors.some(error => error.code === 'LATE_CLOSE_RETAINED'));
        assert.equal(a.broker.sources.has(oldSource), true);
        assert.equal(a.engine.resources.has(late.result.publicationId), true);
        assert.equal(a.engine.requests.filter(request => request.operation === 'resource.close'
          && request.target === late.result.publicationId).length, 1);
        await a.broker.removeSource(oldSource);
        await h.settle();
      }
      assert.equal(a.engine.resources.has(late.result.publicationId), false);
      assert.equal(a.broker.sources.has(oldSource), false);
      assert.equal(a.broker.getPeer('b').status, 'open');
      assert.equal(kept.enabled, true);
      assert.equal(a.engine.resources.get(replacement.publicationId).enabled, true);
      assert.ok(a.broker.getPeer('b').publications.some(value => value.publicationId === replacement.publicationId && value.active));
      assert.equal(a.engine.requests.some(request => request.operation === 'resource.close' && request.target === kept.publicationId), false);
      assert.equal(a.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
      const closeCount = a.engine.requests.filter(request => request.operation === 'resource.close').length;
      await a.broker.removeSource(oldSource);
      assert.equal(a.engine.requests.filter(request => request.operation === 'resource.close').length, closeCount);
    });
  }
});

test('Stop before a queued publish starts does not call native publish or fail the still-live peer', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const source = h.supply('a');
  const publication = a.broker.publish(source, 'b');
  const rejected = assert.rejects(publication, { code: 'P2P_CANCELLED' });
  const removal = a.broker.removeSource(source);
  await Promise.all([rejected, removal]);
  assert.equal(a.engine.requests.some(request => request.operation === 'peer.publish'), false);
  assert.equal(a.broker.getPeer('b').status, 'open');
});

test('accepted cancellation of an uncommitted publication stops only that source, not an already watched publication', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('keep'));
  await h.settle();
  const remaining = pubs(a, 'b')[0], source = h.supply('a', 'screen-two');
  const hold = a.engine.holdNext('peer.publish');
  const starting = a.broker.publish(source, 'b');
  const rejected = assert.rejects(starting, error => error.code === 'P2P_CANCELLED' && error.cause?.code === 'ERR_RTC_CANCELLED');
  const pending = await hold.started.promise;
  await Promise.all([rejected, a.broker.removeSource(source)]);
  await h.settle();
  assert.ok(a.engine.cancellations.includes(pending.id));
  assert.equal(a.broker.getPeer('b').status, 'open');
  assert.equal(remaining.enabled, true);
  assert.equal(pubs(a, 'b').length, 1);
  assert.equal(a.errors.length, 0);
});

test('accepted cancellation before peer creation has no late resource and is not reported as a media failure', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  const hold = a.engine.holdNext('peer.create');
  const opening = a.broker.connect('b', { connectionId: 'a-b-1', generation: 1 });
  const rejected = assert.rejects(opening, { code: 'ERR_RTC_CANCELLED' });
  await hold.started.promise;
  await Promise.all([rejected, a.broker.closePeer('b')]);
  await a.broker.idle();
  assert.equal(a.engine.resources.size, 0);
  assert.equal(a.engine.requests.some(request => request.operation === 'resource.close'), false);
  assert.equal(a.errors.length, 0);
});

test('failed publication retirement retains the handle and native gate observation after demand revocation', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const firstSource = h.supply('a'), secondSource = h.supply('a', 'screen-two');
  await Promise.all([a.broker.publish(firstSource, 'b'), a.broker.publish(secondSource, 'b')]);
  await h.settle();
  await Promise.all([b.broker.watch('a', 'screen-one', destination('one')), b.broker.watch('a', 'screen-two', destination('two'))]);
  await h.settle();
  const first = pubs(a, 'b')[0], second = pubs(a, 'b')[1];
  a.engine.failNext('resource.close', first.publicationId, 'CLOSE_RETAINED');
  await assert.rejects(a.broker.removeSource(firstSource), error => error instanceof AggregateError
    && error.errors.some(value => value.code === 'CLOSE_RETAINED'));
  await a.broker.idle();
  assert.equal(a.engine.resources.has(first.publicationId), true);
  assert.equal(a.broker.sourceDemand(firstSource), 0, 'Stop revokes authorized capture demand immediately');
  const retainedState = a.broker.getPeer('b').publications.find(value => value.sourceId === firstSource);
  assert.equal(retainedState.demanded, false);
  assert.equal(retainedState.requestedEnabled, true);
  assert.equal(retainedState.enabled, true, 'a failed close does not fabricate a disabled effective gate');
  assert.equal(second.enabled, true);
  assert.equal(a.broker.getPeer('b').status, 'open');
  await a.broker.removeSource(firstSource);
  await h.settle();
  assert.equal(a.engine.resources.has(first.publicationId), false);
  assert.equal(a.broker.sourceDemand(firstSource), 0);
  assert.equal(second.enabled, true);
});

test('peer close failures preserve the owner for retry and cannot masquerade as successful teardown', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  const peerId = a.broker.getPeer('b').peerId;
  a.engine.failNext('resource.close', peerId, 'PEER_CLOSE_RETAINED');
  await assert.rejects(a.broker.closePeer('b'), AggregateError);
  await a.broker.idle();
  assert.equal(a.broker.getPeer('b').status, 'closing');
  assert.deepEqual(a.broker.getPeer('b').resources, [{ id: peerId, kind: 'peer' }]);
  assert.equal(a.engine.resources.has(peerId), true);
  assert.equal(a.routes.snapshot().peers, 0);
  await a.broker.closePeer('b');
  assert.equal(a.engine.resources.size, 0);
  assert.equal(a.broker.getPeer('b'), null);
});

test('native operation timeout surfaces failure, keeps unresolved create ownership, and retires a late committed ID', async t => {
  const h = await world(t, ['a', 'b'], { operationTimeoutMs: 100 }), a = h.endpoints.get('a');
  const hold = a.engine.holdNext('peer.create', { afterCommit: true });
  const opening = a.broker.connect('b', { connectionId: 'a-b-1', generation: 1 });
  const rejected = assert.rejects(opening, { code: 'P2P_TIMEOUT' });
  const pending = await hold.started.promise;
  h.clock.advance(101);
  await rejected;
  await a.broker.idle();
  assert.equal(a.broker.getPeer('b').status, 'failed');
  assert.deepEqual(a.broker.getPeer('b').pendingRequests, [pending.id]);
  assert.equal(a.engine.resources.has(pending.result.peerId), true);
  assert.ok(a.errors.some(error => error.code === 'P2P_TIMEOUT'));
  await assert.rejects(a.broker.closePeer('b'), AggregateError);
  hold.release();
  await microtasks();
  await a.broker.idle();
  assert.equal(a.engine.resources.size, 0);
  assert.equal(a.broker.getPeer('b'), null);
});

test('a timed-out close retains its handle until the original late acknowledgement, without issuing a duplicate close', async t => {
  const h = await world(t, ['a', 'b'], { operationTimeoutMs: 100 }), a = h.endpoints.get('a');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  const publication = pubs(a, 'b')[0];
  const hold = a.engine.holdNext('resource.close', { afterCommit: true,
    matches: (_data, target) => target === publication.publicationId });
  const closing = a.broker.closePeer('b');
  const rejected = assert.rejects(closing, AggregateError);
  await hold.started.promise;
  h.clock.advance(101);
  await rejected;
  assert.ok(a.broker.getPeer('b').resources.some(resource => resource.id === publication.publicationId));
  await assert.rejects(a.broker.closePeer('b'), AggregateError);
  assert.equal(a.engine.requests.filter(request => request.operation === 'resource.close'
    && request.target === publication.publicationId).length, 1);
  hold.release();
  await microtasks();
  await a.broker.idle();
  assert.equal(a.engine.resources.size, 0);
  assert.equal(a.broker.getPeer('b'), null);
});

test('full engine-close proof retires retained native handles, not JSON closed/ACK or external source/GPU ownership', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const source = h.supply('a');
  await a.broker.publish(source, 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('before-close'));
  await h.settle();
  const publication = pubs(a, 'b')[0];
  a.engine.releaseFrame = () => assert.fail('external GPU retirement belongs to the parent');
  a.engine.failNext('resource.close', publication.publicationId, 'LOCAL_CLOSE_RETAINED');
  await assert.rejects(a.broker.close(), AggregateError);
  const retained = a.broker.getPeer('b').resources, requests = a.engine.requests.length;
  for (const notProof of [{ type: 'closed', target: 0, data: {} }, { ok: true }, { then: resolve => resolve({}) }]) {
    await assert.rejects(a.broker.finishAfterEngineClose(notProof), /actual engine.close Promise/u);
  }
  const fullClose = beginOwnerClose(a);
  let finished = false;
  const finishing = a.broker.finishAfterEngineClose(fullClose.promise).then(() => { finished = true; });
  a.broker.handleNativeEvent({ type: 'closed', target: 0, data: {} });
  await microtasks();
  assert.equal(finished, false);
  assert.deepEqual(a.broker.getPeer('b').resources, retained);
  assert.equal(a.broker.sourceDemand(source), 0, 'intent is revoked independently of pending native retirement');
  assert.equal(a.broker.getPeer('b').publications[0].enabled, true, 'no native retirement proof exists yet');
  await assert.rejects(a.broker.close(), AggregateError);
  assert.equal(a.engine.requests.length, requests, 'no resource.close against a shutting-down engine');
  fullClose.resolve({ nativeThreadsDrained: true });
  await finishing;
  await a.broker.close();
  assert.equal(a.broker.getPeer('b'), null);
  assert.equal(a.broker.sourceDemand(source), 0);
  assert.equal(a.demand.at(-1).enabled, false);
  assert.equal(a.engine.externalSources.has(source), true, 'capture registration is still parent-owned');
  assert.equal(a.engine.requests.length, requests);
  assert.equal(a.engine.closeCalls, 1, 'only the owner calls closeEngine; the broker cannot initiate another engine close');
  assert.equal(a.routes.snapshot().peers, 0);
});

test('forged fulfilled promises, swallowed close errors, and another engine proof cannot retire native handles', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  const retained = a.broker.getPeer('b').resources, requests = a.engine.requests.length;
  await assert.rejects(a.broker.finishAfterEngineClose(Promise.resolve({ closed: true })), /has not been proven/u);
  assert.deepEqual(a.broker.getPeer('b').resources, retained);
  assert.equal(a.engine.closeCalls, undefined);
  const otherClose = beginOwnerClose(b);
  otherClose.resolve();
  await b.broker.finishAfterEngineClose(otherClose.promise);
  await assert.rejects(a.broker.finishAfterEngineClose(otherClose.promise), /has not been proven/u);
  assert.throws(() => { a.commands.engine = b.engine; }, TypeError);
  assert.deepEqual(a.broker.getPeer('b').resources, retained);
  const failedClose = beginOwnerClose(a);
  const swallowed = failedClose.promise.catch(() => ({ closed: true }));
  const invalidProof = a.broker.finishAfterEngineClose(swallowed);
  failedClose.reject(nativeError('REAL_CLOSE_FAILED'));
  await assert.rejects(invalidProof, /has not been proven/u);
  assert.deepEqual(a.broker.getPeer('b').resources, retained);
  assert.equal(a.engine.requests.length, requests);
  const actualClose = beginOwnerClose(a);
  const finishing = a.broker.finishAfterEngineClose(actualClose.promise);
  actualClose.resolve();
  await finishing;
  assert.equal(a.broker.getPeer('b'), null);
  assert.equal(a.engine.closeCalls, 2, 'the rejected engine close is retried only by the owner');
});

test('private closure proof rejects an overridden real instance method and preserves every live A/V resource', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  const retained = a.broker.getPeer('b').resources;
  const actualResources = [...a.engine.resources.keys()];
  const requests = a.engine.requests.length;
  assert.equal(actualResources.length, 3);
  assert.throws(() => assertNativeRtcEngineClosed(a.commands, a.engine), /has not been proven/u);
  a.commands.assertEngineClosed = () => {};
  try {
    await assert.rejects(a.broker.finishAfterEngineClose(Promise.resolve({ closed: true })), /has not been proven/u);
    assert.equal(a.broker.engineRetired, false);
    assert.deepEqual(a.broker.getPeer('b').resources, retained);
    assert.deepEqual([...a.engine.resources.keys()], actualResources);
    assert.equal(a.engine.requests.length, requests);
    assert.equal(a.engine.closeCalls ?? 0, 0);
    assert.throws(() => assertNativeRtcEngineClosed(a.commands, a.engine), /has not been proven/u);
  } finally {
    const actualClose = beginOwnerClose(a);
    actualClose.resolve();
    await a.broker.finishAfterEngineClose(actualClose.promise);
  }
  assert.equal(a.engine.closeCalls, 1, 'only the real owner close path can establish retirement');
  assert.equal(a.broker.getPeer('b'), null);
});

test('rejected full engine-close proof preserves native IDs and can be retried without issuing native commands', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await h.settle();
  const retained = a.broker.getPeer('b').resources, requests = a.engine.requests.length;
  const failure = nativeError('GLOBAL_CLOSE_TIMEOUT'), failedProof = beginOwnerClose(a);
  const finishing = a.broker.finishAfterEngineClose(failedProof.promise);
  const rejected = assert.rejects(finishing, error => error === failure);
  failedProof.reject(failure);
  await rejected;
  assert.deepEqual(a.broker.getPeer('b').resources, retained);
  assert.ok(a.errors.includes(failure));
  await assert.rejects(a.broker.closePeer('b'), { code: 'P2P_ENGINE_CLOSE_UNCONFIRMED' });
  assert.equal(a.engine.requests.length, requests);
  const retriedProof = beginOwnerClose(a);
  const retry = a.broker.finishAfterEngineClose(retriedProof.promise);
  retriedProof.resolve({ nativeThreadsDrained: true });
  await retry;
  await a.broker.close();
  assert.equal(a.broker.getPeer('b'), null);
  assert.equal(a.engine.requests.length, requests);
});

test('global close proof settles pending creates and late acknowledgements cannot resurrect native IDs', async t => {
  for (const operation of ['peer.create', 'peer.publish']) {
    await t.test(operation, async child => {
      const h = await world(child), a = h.endpoints.get('a');
      if (operation === 'peer.publish') await h.connect();
      const hold = a.engine.holdNext(operation, { afterCommit: true });
      const opening = operation === 'peer.create'
        ? a.broker.connect('b', { connectionId: 'a-b-1', generation: 1 })
        : a.broker.publish(h.supply('a'), 'b');
      const cancelled = assert.rejects(opening, { code: 'P2P_CANCELLED' });
      const native = await hold.started.promise;
      const requests = a.engine.requests.length;
      const proof = beginOwnerClose(a), finishing = a.broker.finishAfterEngineClose(proof.promise);
      assert.ok(a.broker.getPeer('b').pendingRequests.includes(native.id));
      proof.resolve({ nativeThreadsDrained: true });
      await Promise.all([finishing, cancelled]);
      assert.equal(a.broker.getPeer('b'), null);
      hold.release();
      await microtasks();
      await a.broker.close();
      assert.equal(a.broker.nativePeers.size, 0);
      assert.equal(a.engine.requests.length, requests);
      assert.equal(a.commands.getPendingRequest(native.id), null);
      assert.equal(a.engine.cancellations.length, 0, 'engine closing owns native cancellation');
    });
  }
});

test('full engine-close proof abandons pending signaling enqueue without hanging local retirement or leaving timers', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const enqueue = deferred(), started = deferred();
  a.broker.send = () => { started.resolve(); return enqueue.promise; };
  const publishing = a.broker.publish(h.supply('a'), 'b');
  const cancelled = assert.rejects(publishing, { code: 'P2P_CANCELLED' });
  await started.promise;
  const requests = a.engine.requests.length, proof = beginOwnerClose(a);
  const finishing = a.broker.finishAfterEngineClose(proof.promise);
  proof.resolve({ nativeThreadsDrained: true });
  await Promise.all([finishing, cancelled]);
  await a.broker.close();
  assert.equal(a.broker.getPeer('b'), null);
  assert.equal(a.engine.requests.length, requests);
  assert.equal(h.clock.tasks.size, 0);
  enqueue.resolve();
  await microtasks();
  assert.equal(a.engine.requests.length, requests);
});

test('a nonleader waiting for a grant also has a bounded failed outcome when the leader never replies', async t => {
  const h = await world(t, ['a', 'b'], { turnTimeoutMs: 100 }), b = h.endpoints.get('b');
  await h.connect();
  await b.broker.publish(h.supply('b'), 'a');
  await b.broker.idle();
  assert.equal(b.broker.getPeer('a').turn, null);
  assert.equal(h.messages('negotiate', 'b').length, 1);
  h.clock.advance(101);
  await b.broker.idle();
  assert.ok(b.states.some(state => state.status === 'failed' && state.error.code === 'P2P_TURN_TIMEOUT'));
  assert.equal(b.engine.resources.size, 0);
});

test('a rejected signaling enqueue surfaces the actual error and closes only owned screen resources', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const source = h.supply('a');
  a.broker.send = () => Promise.reject(nativeError('SIGNAL_ENQUEUE_REJECTED'));
  await assert.rejects(a.broker.publish(source, 'b'), { code: 'SIGNAL_ENQUEUE_REJECTED' });
  await a.broker.idle();
  assert.ok(a.errors.some(error => error.code === 'SIGNAL_ENQUEUE_REJECTED'));
  assert.equal(a.engine.resources.size, 0);
  assert.equal(a.engine.externalSources.has(source), true);
});

test('a signaling enqueue timeout is bounded even though no remote handler or real connection exists', async t => {
  const h = await world(t, ['a', 'b'], { operationTimeoutMs: 100 }), a = h.endpoints.get('a');
  await h.connect();
  const source = h.supply('a'), pendingEnqueue = deferred(), started = deferred();
  a.broker.send = () => { started.resolve(); return pendingEnqueue.promise; };
  const publishing = a.broker.publish(source, 'b');
  const rejected = assert.rejects(publishing, { code: 'P2P_TIMEOUT' });
  await started.promise;
  h.clock.advance(101);
  await rejected;
  await a.broker.idle();
  assert.ok(a.errors.some(error => error.code === 'P2P_TIMEOUT'));
  assert.equal(a.engine.resources.size, 0);
  pendingEnqueue.resolve();
});

test('negotiation timeout and native SDP rejection have explicit failed outcomes, never fake connected or browser fallback', async t => {
  const h = await world(t, ['a', 'b'], { turnTimeoutMs: 100 }), a = h.endpoints.get('a');
  await h.connect();
  await a.broker.publish(h.supply('a'), 'b');
  await a.broker.idle();
  assert.ok(a.broker.getPeer('b').turn);
  h.clock.advance(101);
  await a.broker.idle();
  assert.ok(a.states.some(state => state.status === 'failed' && state.error.code === 'P2P_TURN_TIMEOUT'));
  assert.ok(!a.states.some(state => state.nativeState.connectionState === 'connected'));
  await h.endpoints.get('b').broker.closePeer('a');
  await h.connect('a', 'b', 2);
  a.engine.failNext('peer.createOffer', undefined, 'NATIVE_SDP_REJECTED');
  const source = [...a.engine.externalSources.keys()][0];
  await a.broker.publish(source, 'b');
  await a.broker.idle();
  assert.ok(a.errors.some(error => error.code === 'NATIVE_SDP_REJECTED'));
  assert.ok(a.states.some(state => state.status === 'failed'));
});

test('pending ICE and local message queues are bounded, and unknown roster announcements cannot open sender gates', async t => {
  const h = await world(t, ['a', 'b'], { maximumIce: 2, maximumQueue: 4 }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const announced = envelope('publication', { shareId: 'not-in-roster', publicationId: 44, publicationVersion: 1,
    metadataVersion: 1, trackId: 'guessed', mid: '0', streamIds: ['a-sync'] });
  await b.broker.receive('a', announced);
  assert.throws(() => b.broker.watch('a', 'not-in-roster', destination('invalid')), /authenticated/u);
  const ice = envelope('ice', { turn: 1, candidate: 'candidate:bounded', sdpMid: '0', sdpMLineIndex: 0 });
  await b.broker.receive('a', ice);
  await b.broker.receive('a', ice);
  await assert.rejects(b.broker.receive('a', ice), /pending ICE queue is full/u);
  await b.broker.idle();
  assert.ok(b.states.some(state => state.status === 'failed'));
  assert.equal(b.engine.requests.some(request => request.operation === 'peer.setReceiving'), false);
  await a.broker.closePeer('b');
  await h.connect('a', 'b', 2);
  const held = a.engine.holdNext('peer.createOffer');
  await a.broker.publish(h.supply('a'), 'b');
  await held.started.promise;
  const input = { ...ice, connectionId: 'a-b-2', generation: 2 };
  const incoming = Array.from({ length: 5 }, () => a.broker.receive('b', input));
  const results = await Promise.allSettled(incoming);
  assert.ok(results.some(result => result.status === 'rejected' && result.reason.code === 'P2P_QUEUE_LIMIT'));
  await a.broker.idle();
  assert.ok(a.errors.some(error => error.code === 'P2P_QUEUE_LIMIT'));
});

test('one viewer Stop or leave never changes another pair publication or either screen source', async t => {
  const h = await world(t, ['a', 'b', 'c']), a = h.endpoints.get('a'), b = h.endpoints.get('b'), c = h.endpoints.get('c');
  await h.connect('a', 'b');
  await h.connect('a', 'c');
  const source = h.supply('a');
  await Promise.all([a.broker.publish(source, 'b'), a.broker.publish(source, 'c')]);
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('b-view'));
  await h.settle();
  const watchForB = h.messages('watch', 'b').at(-1).message;
  await a.broker.receive('c', { ...watchForB, connectionId: 'a-c-1' });
  assert.equal(pubs(a, 'c')[0].enabled, false, 'an authenticated other viewer cannot reuse a different destination publication');
  await c.broker.watch('a', 'screen-one', destination('c-view'));
  await h.settle();
  const forC = pubs(a, 'c')[0];
  assert.equal(a.broker.sourceDemand(source), 2);
  await b.broker.stopWatching('a', 'screen-one');
  await h.settle();
  assert.equal(a.broker.sourceDemand(source), 1);
  assert.equal(forC.enabled, true);
  await Promise.all([a.broker.closePeer('b'), b.broker.closePeer('a')]);
  assert.equal(forC.enabled, true);
  assert.equal(a.engine.resources.has(forC.publicationId), true);
  assert.equal(a.broker.getPeer('c').status, 'open');
  assert.equal(a.engine.externalSources.has(source), true);
});

test('authenticated roster revocation stops only revoked shares and never trusts syncGroup as ownership', async t => {
  const h = await world(t), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  assert.throws(() => a.broker.registerSource({ sourceId: 999, localShareId: 'not-owned', syncGroup: 'a-sync' }), /roster/u);
  assert.throws(() => a.broker.registerSource({ sourceId: 999, localShareId: 'screen-one', syncGroup: '' }), /syncGroup/u);
  await Promise.all([a.broker.publish(h.supply('a'), 'b'), a.broker.publish(h.supply('a', 'screen-two'), 'b')]);
  await h.settle();
  await Promise.all([b.broker.watch('a', 'screen-one', destination('one')), b.broker.watch('a', 'screen-two', destination('two'))]);
  await h.settle();
  await b.broker.setRoster('a', ['screen-two']);
  await h.settle();
  assert.equal(pubs(a, 'b')[0].enabled, false);
  assert.equal(pubs(a, 'b')[1].enabled, true);
  await a.broker.setRoster('a', ['screen-two']);
  await h.settle();
  assert.equal(pubs(a, 'b').length, 1);
  assert.equal(pubs(a, 'b')[0].enabled, true);
});

test('an obsolete externally supplied call generation fails closed without consuming or releasing a decoded GPU lease', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const peerId = a.broker.getPeer('b').peerId;
  const before = a.engine.requests.length;
  assert.equal(a.broker.handleNativeEvent({ type: 'frame', target: peerId,
    data: { frameId: 987, routeKind: 'peer', receiverId: 5, receiverEpoch: 1 } }), false);
  assert.equal(a.engine.requests.length, before);
  a.current = false;
  assert.throws(() => a.broker.watch('b', 'screen-one', destination('obsolete')), { code: 'P2P_CANCELLED' });
  await a.broker.closePeer('b');
  assert.equal(a.routes.snapshot().peers, 0);
  assert.equal(a.engine.requests.filter(request => request.operation === 'resource.close').length, 1);
});

test('A/V CONTROL v2 is explicit, discriminates media identity, and legacy video never prepares audio', async t => {
  const h = await world(t), a = h.endpoints.get('a');
  await h.connect();
  const video = h.supply('a');
  await a.broker.publish(video, 'b');
  await h.settle();
  const group = a.engine.externalSources.get(video).syncGroup;
  const before = a.engine.requests.length;
  assert.throws(() => a.broker.registerAudioSource({ sourceId: 999, screenAudioShareId: 'screen-one', syncGroup: group }),
    { code: 'P2P_AUDIO_UNAVAILABLE' });
  const audio = { ...envelope('publication', { shareId: 'screen-one', publicationId: 55, publicationVersion: 9,
    metadataVersion: 1, trackId: 'audio-actual', mid: '4', streamIds: [group] }), version: 2, kind: 'audio', syncGroup: group };
  assert.deepEqual(parseNativeP2pMessage(audio), audio);
  assert.throws(() => parseNativeP2pMessage({ ...audio, version: 1 }), /fields/u);
  assert.equal((await a.broker.receive('b', audio)).accepted, false);
  const watched = { ...envelope('watch', { shareId: 'screen-one', publicationId: 55, publicationVersion: 9,
    metadataVersion: 1, subscriptionId: 7, revision: 2, watching: true }), version: 2, kind: 'audio' };
  assert.throws(() => parseNativeP2pMessage(watched), /fields/u);
  const videoReference = { publicationId: 3, publicationVersion: 2, metadataVersion: 1, subscriptionId: 4, revision: 5 };
  assert.deepEqual(parseNativeP2pMessage({ ...watched, video: videoReference }).video, videoReference);
  assert.throws(() => parseNativeP2pMessage({ ...watched, video: { ...videoReference, revision: 0 } }), /correlation/u);
  assert.equal(a.engine.requests.length, before);
  assert.equal(a.engine.outputEpoch, 0);
  assert.equal(h.endpoints.get('b').engine.outputEpoch, 0);
});

test('A/V one PCM source follows only its explicitly watched screen, with independent mute/volume and continuous input', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  assert.equal(a.audioOwner.preparations.length + b.audioOwner.preparations.length, 0, 'construction is inert');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), audioSource = h.supplyAudio('a');
  const input = a.engine.externalSources.get(audioSource);
  input.packetCursor = 1920;
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b'), a.broker.publishAudio(audioSource, 'b')]);
  await h.settle();
  const audioPub = pubs(a, 'b').find(value => value.mediaKind === 'audio');
  const audioReceiver = watchedReceiver(b, 'a', audioPub);
  assert.equal(audioPub.enabled, false);
  assert.equal(audioReceiver.enabled, false);
  assert.equal(b.audioOwner.bindings.size, 0);
  assert.equal(b.routes.peers.get(peerOf(b, 'a').peerId).receivers.size, 2, 'the video router contains no audio receivers');
  assert.ok(b.audioOwner.preparations.some(value => value.reason === 'description' && value.side === 'remote'));
  assert.equal(a.audioOwner.preparations.length, 0, 'dedicated local sendonly audio needs no receiving output');
  await b.broker.watch('a', 'screen-two', destination('unassociated'));
  await h.settle();
  assert.equal(audioPub.enabled, false);
  assert.equal(audioReceiver.enabled, false);
  await b.broker.watch('a', 'screen-one', destination('associated'));
  await h.settle();
  assert.equal(audioPub.enabled, true);
  assert.equal(audioReceiver.enabled, true);
  assert.equal(b.audioOwner.bindings.get(`${peerOf(b, 'a').peerId}:${audioReceiver.receiverId}`).shareId, 'screen-one');
  assert.ok(!a.demand.some(state => state.sourceId === audioSource), 'PCM demand must not enter the video capture gate callback');
  assert.ok(a.audioOwner.publications.some(state => state.sourceId === audioSource && state.demanded));
  await b.broker.setAudioVolume('a', 'screen-one', 0.35);
  await h.settle();
  assert.equal(audioReceiver.volume, 0.35);
  await b.broker.setAudioMuted('a', 'screen-one', true);
  await h.settle();
  assert.equal(audioReceiver.enabled, false);
  assert.equal(audioPub.enabled, false);
  assert.equal(input.enabled, true, 'mute is a publication/receiver gate, never a PCM source pause');
  input.packetCursor += 960;
  await b.broker.setAudioMuted('a', 'screen-one', false);
  await h.settle();
  assert.equal(audioReceiver.enabled, true);
  assert.equal(audioReceiver.volume, 0.35);
  assert.equal(audioPub.enabled, true);
  assert.equal(input.inputEpoch, 7);
  assert.equal(input.packetCursor, 2880);
  await b.broker.stopWatching('a', 'screen-one');
  await h.settle();
  assert.equal(audioPub.enabled, false);
  assert.equal(audioReceiver.enabled, false);
  assert.equal(b.audioOwner.bindings.size, 0);
  assert.equal(b.broker.getPeer('a').receiving, true, 'watching the other video keeps only the aggregate gate');
  assert.equal(pubs(a, 'b').find(value => value.sourceId === two).enabled, true);
  assert.equal(input.enabled, true);
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
});

test('A/V both endpoints publish two videos and one sendonly Opus source using the same participant pair and offer turns', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const aOne = h.supply('a'), aTwo = h.supply('a', 'screen-two');
  const bOne = h.supply('b'), bTwo = h.supply('b', 'screen-two');
  const aAudio = h.supplyAudio('a'), bAudio = h.supplyAudio('b', 'screen-two');
  await Promise.all([
    a.broker.publish(aOne, 'b'), a.broker.publish(aTwo, 'b'), a.broker.publishAudio(aAudio, 'b'),
    b.broker.publish(bOne, 'a'), b.broker.publish(bTwo, 'a'), b.broker.publishAudio(bAudio, 'a'),
    a.broker.watch('b', 'screen-one', destination('a-one')), a.broker.watch('b', 'screen-two', destination('a-two')),
    b.broker.watch('a', 'screen-one', destination('b-one')), b.broker.watch('a', 'screen-two', destination('b-two')),
  ]);
  await h.settle();
  for (const [endpoint, remote] of [[a, 'b'], [b, 'a']]) {
    assert.equal(endpoint.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
    assert.equal(endpoint.engine.requests.filter(request => request.operation === 'peer.publishAudio').length, 1);
    assert.equal(pubs(endpoint, remote).length, 3);
    assert.ok(pubs(endpoint, remote).every(publication => publication.enabled));
    assert.equal([...peerOf(endpoint, remote).receivers.values()].filter(receiver => receiver.enabled).length, 3);
    assert.equal(endpoint.audioOwner.bindings.size, 1);
    assert.equal(endpoint.broker.getPeer(remote).turn, null);
    assert.equal(endpoint.errors.length, 0);
  }
  assert.ok(h.messages('offer', 'a').length > 0 && h.messages('offer', 'b').length > 0);
  assert.ok(h.messages('watch').filter(item => item.message.kind === 'audio').every(item => item.message.video
    && item.message.version === 2));
});

test('A/V output readiness failure prevents the receiving SDP mutation instead of assuming global output is ready', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), audio = h.supplyAudio('a');
  b.audioOwner.unavailable = true;
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(audio, 'b')]);
  await assert.rejects(h.settle(), { code: 'OWNER_OUTPUT_UNPROVEN' });
  assert.equal(b.engine.requests.filter(request => request.operation === 'peer.setRemoteDescription'
    && b.engine.readSdp(request.data.sdp).mids.some(mid => b.engine.readSdp(request.data.sdp).kinds[mid] === 'audio')).length, 0);
  assert.ok(b.states.some(state => state.status === 'failed'));
  assert.equal(b.audioOwner.bindings.size, 0);
});

test('A/V registration enforces unique video groups, one explicit PCM association and native Opus bitrate bounds', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a');
  await h.connect();
  const one = h.supply('a'), group = a.engine.externalSources.get(one).syncGroup;
  assert.notEqual(group, a.broker.syncGroup);
  assert.throws(() => a.broker.registerSource({ sourceId: 999, localShareId: 'screen-two', syncGroup: group }), /unique/u);
  assert.throws(() => a.broker.registerAudioSource({ sourceId: 999, screenAudioShareId: 'screen-two', syncGroup: group }), /selected/u);
  const audio = h.supplyAudio('a');
  const two = h.supply('a', 'screen-two');
  assert.throws(() => a.broker.registerAudioSource({ sourceId: 998, screenAudioShareId: 'screen-two',
    syncGroup: a.engine.externalSources.get(two).syncGroup }), /one PCM/u);
  assert.throws(() => a.broker.publishAudio(audio, 'b', { maxBitrateBps: 5999 }), /Opus bitrate/u);
  assert.throws(() => a.broker.publishAudio(audio, 'b', { maxBitrateBps: 510001 }), /Opus bitrate/u);
  assert.throws(() => a.broker.publishAudio(audio, 'b', { maxFramerate: 30 }), /framerate/u);
  assert.throws(() => a.broker.setAudioVolume('b', 'screen-one', 2.1), /0\.\.2/u);
  assert.throws(() => a.broker.setAudioVolume('b', 'screen-one', NaN), /0\.\.2/u);
});

test('A/V stopping the associated screen never falls back; explicit rebind reuses PCM with a new sendonly publication', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await Promise.all([b.broker.watch('a', 'screen-one', destination('one')), b.broker.watch('a', 'screen-two', destination('two'))]);
  await h.settle();
  const previous = pubs(a, 'b').find(publication => publication.mediaKind === 'audio');
  const oldWatch = h.messages('watch', 'b').findLast(item => item.message.kind === 'audio' && item.message.watching).message;
  const input = a.engine.externalSources.get(pcm), epoch = input.inputEpoch;
  const removal = a.broker.removeSource(one);
  await h.settle();
  await removal;
  assert.equal(pubs(a, 'b').filter(publication => publication.mediaKind === 'audio').length, 0);
  assert.equal(a.broker.getAudioSource().screenAudioShareId, null);
  assert.equal(input.enabled, true);
  assert.equal(input.inputEpoch, epoch);
  assert.equal(b.audioOwner.bindings.size, 0);
  assert.equal(pubs(a, 'b').find(publication => publication.sourceId === two).enabled, true);
  const moving = a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-two' });
  await h.settle();
  const association = await moving;
  assert.equal(association.sourceId, pcm);
  assert.equal(association.syncGroup, a.engine.externalSources.get(two).syncGroup);
  const replacement = await a.broker.publishAudio(pcm, 'b');
  await h.settle();
  assert.notEqual(replacement.publicationId, previous.publicationId);
  assert.notEqual(replacement.trackId, previous.trackId);
  assert.equal(a.engine.resources.get(replacement.publicationId).enabled, true);
  assert.equal([...b.audioOwner.bindings.values()][0].shareId, 'screen-two');
  await a.broker.receive('b', oldWatch);
  assert.equal(a.engine.resources.get(replacement.publicationId).enabled, true, 'old audio Watch cannot mutate a replacement');
  assert.equal(input.inputEpoch, epoch);
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
});

test('A/V audio rebind waits for a completed local offer covering StopStandard, not an older answer or stable patch', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await Promise.all([b.broker.watch('a', 'screen-one', destination('one')), b.broker.watch('a', 'screen-two', destination('two'))]);
  await h.settle();
  h.wire.block = item => item.message.type === 'answer';
  a.engine.emit('peer.negotiationNeeded', peerOf(a, 'b').peerId, {});
  await h.settle();
  const preceding = a.broker.getPeer('b').turn.sequence;
  const moving = a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-two' });
  await h.settle();
  assert.equal(a.audioOwner.rebinds.length, 0);
  assert.equal(a.broker.getAudioSource().rebinding, true);
  assert.throws(() => a.broker.publishAudio(pcm, 'b'), /obsolete|unowned/u);
  h.wire.block = item => item.message.type === 'answer' && item.message.turn !== preceding;
  await h.settle();
  assert.ok(a.broker.getPeer('b').completedTurn >= preceding);
  assert.ok(a.broker.getPeer('b').turn.sequence > preceding);
  assert.equal(a.audioOwner.rebinds.length, 0, 'the old offer did not contain the stopped mutation');
  a.engine.emit('peer.state', peerOf(a, 'b').peerId, { signalingState: 'stable' });
  await microtasks();
  assert.equal(a.audioOwner.rebinds.length, 0);
  h.wire.block = () => false;
  await h.settle();
  await moving;
  assert.equal(a.audioOwner.rebinds.length, 1);
  assert.equal(peerOf(a, 'b').retiringAudio.size, 0);
  assert.equal(a.broker.getAudioSource().screenAudioShareId, 'screen-two');
  assert.equal(pubs(a, 'b').filter(publication => publication.mediaKind === 'video').length, 2);
});

test('A/V audio receiver epoch/MID updates revoke the separate binding and reapply the saved volume', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('watch'));
  await h.settle();
  await b.broker.setAudioVolume('a', 'screen-one', 0.4);
  await h.settle();
  const audio = pubs(a, 'b').find(publication => publication.mediaKind === 'audio');
  const receiver = watchedReceiver(b, 'a', audio), peer = peerOf(b, 'a'), oldEpoch = receiver.epoch;
  Object.assign(receiver, { mid: '77', requested: false, enabled: false });
  b.engine.receiverEvent(peer, receiver);
  assert.equal(b.audioOwner.bindings.size, 0);
  await b.broker.idle();
  assert.equal(receiver.enabled, false);
  a.engine.publicationUpdate(audio.publicationId, { mid: '77' });
  await h.settle();
  const bound = b.audioOwner.bindings.get(`${peer.peerId}:${receiver.receiverId}`);
  assert.ok(bound.receiverEpoch > oldEpoch);
  assert.equal(bound.binding.mid, '77');
  assert.equal(receiver.enabled, true);
  assert.equal(receiver.volume, 0.4);
  assert.equal(b.routes.peers.get(peer.peerId).receivers.size, 1);
});

test('A/V committed audio publication aborted before completion retains and retires only that publication', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await a.broker.publish(video, 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('video-kept'));
  await h.settle();
  const hold = a.engine.holdNext('peer.publishAudio', { afterCommit: true }), controller = new AbortController();
  const publishing = a.broker.publishAudio(pcm, 'b', { signal: controller.signal });
  const cancelled = assert.rejects(publishing, { code: 'P2P_CANCELLED' });
  const native = await hold.started.promise;
  controller.abort();
  hold.release();
  await cancelled;
  await h.settle();
  assert.equal(a.engine.resources.has(native.result.publicationId), false);
  assert.equal(peerOf(a, 'b').retiringAudio.size, 0);
  assert.equal(a.broker.getPeer('b').status, 'open');
  assert.equal(pubs(a, 'b').find(publication => publication.sourceId === video).enabled, true);
  assert.equal(a.engine.externalSources.get(pcm).inputEpoch, 7);
  assert.equal(a.engine.externalSources.get(pcm).enabled, true);
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
});

test('A/V audio Watch cannot borrow another screen subscription or masquerade as a video publication', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await b.broker.watch('a', 'screen-two', destination('only-two'));
  await h.settle();
  const announced = h.messages('publication', 'a').findLast(item => item.message.kind === 'audio').message;
  const watched = h.messages('watch', 'b').findLast(item => item.message.kind === 'video').message;
  const video = Object.fromEntries(['publicationId', 'publicationVersion', 'metadataVersion', 'subscriptionId', 'revision']
    .map(key => [key, watched[key]]));
  const forged = { ...envelope('watch', {
    shareId: 'screen-one', publicationId: announced.publicationId, publicationVersion: announced.publicationVersion,
    metadataVersion: announced.metadataVersion, subscriptionId: 888, revision: 888, watching: true,
  }), version: 2, kind: 'audio', video };
  await a.broker.receive('b', forged);
  assert.equal(a.engine.resources.get(announced.publicationId).enabled, false);
  const { video: _video, ...wrongKind } = forged;
  await a.broker.receive('b', { ...wrongKind, kind: 'video' });
  assert.equal(a.engine.resources.get(announced.publicationId).enabled, false);
  assert.equal(pubs(a, 'b').find(publication => publication.sourceId === two).enabled, true);
});

test('A/V stopping a Watch during asynchronous preparation cannot bind or enable the obsolete receiver', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  const hold = b.audioOwner.holdPreparation();
  const watching = b.broker.watch('a', 'screen-one', destination('cancel-preparation'));
  await hold.started.promise;
  const stopping = b.broker.stopWatching('a', 'screen-one');
  hold.gate.resolve();
  await Promise.all([watching, stopping]);
  await h.settle();
  const publication = pubs(a, 'b').find(value => value.mediaKind === 'audio');
  assert.equal(publication.enabled, false);
  assert.equal(watchedReceiver(b, 'a', publication).enabled, false);
  assert.equal(b.audioOwner.bindings.size, 0);
  assert.equal(b.broker.getPeer('a').receiving, false);
});

test('A/V readiness is rechecked immediately before SDP even if a prepared output epoch becomes obsolete', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  const assertReady = b.audioOwner.assertReceiveReady.bind(b.audioOwner);
  let observations = 0;
  b.audioOwner.assertReceiveReady = (proof, context) => {
    assertReady(proof, context);
    if (++observations === 1) b.engine.outputReady = false;
  };
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await assert.rejects(h.settle(), { code: 'OWNER_OUTPUT_UNPROVEN' });
  assert.equal(b.engine.requests.some(request => request.operation === 'peer.setRemoteDescription'), false);
  assert.equal(b.audioOwner.bindings.size, 0);
});

test('A/V normal RTC pause preserves the owned output epoch across source retirement and new reception', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('watch'));
  await h.settle();
  const epoch = b.engine.outputEpoch;
  const rebinding = a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-one' });
  await h.settle();
  await rebinding;
  assert.equal(b.engine.outputReady, true);
  assert.ok(b.engine.outputStops > 0);
  assert.equal(b.engine.events.some(event => event.type === 'audio.outputError'), false,
    'normal StopPlayout is not an output retirement or an output failure');
  b.audioOwner.observeStoppedEpoch = false;
  await a.broker.publishAudio(pcm, 'b');
  await h.settle();
  assert.equal(b.engine.outputEpoch, epoch, 'a broker-local receiver count cannot replace the global output epoch');
  assert.equal(b.audioOwner.configurations.length, 1);
});

test('A/V removing one publisher receiver does not reset output while another native peer still receives audio', async t => {
  const h = await world(t, ['a', 'b', 'c'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b'), c = h.endpoints.get('c');
  await h.connect('a', 'b');
  await h.connect('a', 'c');
  const bVideo = h.supply('b'), bPcm = h.supplyAudio('b');
  const cVideo = h.supply('c'), cPcm = h.supplyAudio('c');
  await Promise.all([b.broker.publish(bVideo, 'a'), b.broker.publishAudio(bPcm, 'a'),
    c.broker.publish(cVideo, 'a'), c.broker.publishAudio(cPcm, 'a')]);
  await h.settle();
  await Promise.all([a.broker.watch('b', 'screen-one', destination('from-b')), a.broker.watch('c', 'screen-one', destination('from-c'))]);
  await h.settle();
  await a.broker.setAudioVolume('c', 'screen-one', 0.55);
  await h.settle();
  const epoch = a.engine.outputEpoch;
  const cAudio = pubs(c, 'a').find(value => value.mediaKind === 'audio');
  const cReceiver = watchedReceiver(a, 'c', cAudio);
  const removing = b.broker.removeSource(bPcm);
  await h.settle();
  await removing;
  assert.equal(a.engine.outputEpoch, epoch);
  assert.equal(a.engine.outputReady, true);
  assert.equal(cReceiver.enabled, true);
  assert.equal(cReceiver.volume, 0.55);
  assert.equal(a.audioOwner.bindings.size, 1);
  assert.equal([...a.audioOwner.bindings.values()][0].publisherSessionId, 'c');
});

test('A/V closing a local sendonly publication does not close the remote audio track on the same peer', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const aOne = h.supply('a'), aTwo = h.supply('a', 'screen-two'), aPcm = h.supplyAudio('a');
  const bVideo = h.supply('b'), bPcm = h.supplyAudio('b');
  await Promise.all([a.broker.publish(aOne, 'b'), a.broker.publish(aTwo, 'b'), a.broker.publishAudio(aPcm, 'b'),
    b.broker.publish(bVideo, 'a'), b.broker.publishAudio(bPcm, 'a')]);
  await h.settle();
  await Promise.all([a.broker.watch('b', 'screen-one', destination('remote-audio')),
    b.broker.watch('a', 'screen-one', destination('one')), b.broker.watch('a', 'screen-two', destination('two'))]);
  await h.settle();
  await a.broker.setAudioVolume('b', 'screen-one', 0.8);
  await h.settle();
  const remotePub = pubs(b, 'a').find(value => value.mediaKind === 'audio');
  const receiver = watchedReceiver(a, 'b', remotePub), epoch = a.engine.outputEpoch;
  const moving = a.broker.rebindAudioSource(aPcm, { screenAudioShareId: 'screen-two' });
  await h.settle();
  await moving;
  assert.equal(receiver.present, true);
  assert.equal(receiver.enabled, true);
  assert.equal(receiver.volume, 0.8);
  assert.equal(remotePub.enabled, true);
  assert.equal(a.engine.outputEpoch, epoch);
  assert.equal(a.audioOwner.bindings.size, 1);
  assert.equal(a.engine.requests.some(request => request.operation === 'resource.close' && request.target === receiver.receiverId), false);
  assert.equal(a.engine.requests.filter(request => request.operation === 'peer.create').length, 1);
});

test('A/V late timed-out audio creation retains ownership and cannot overlap another publication on the live peer', async t => {
  const h = await world(t, ['a', 'b'], { av: true, operationTimeoutMs: 100 }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await a.broker.publish(video, 'b');
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('keep-video'));
  await h.settle();
  const hold = a.engine.holdNext('peer.publishAudio', { afterCommit: true }), controller = new AbortController();
  const starting = a.broker.publishAudio(pcm, 'b', { signal: controller.signal });
  const cancelled = assert.rejects(starting, error => error.code === 'P2P_CANCELLED' && error.cause?.code === 'P2P_TIMEOUT');
  const native = await hold.started.promise;
  controller.abort();
  h.clock.advance(101);
  await cancelled;
  await a.broker.idle();
  assert.equal(a.broker.getPeer('b').status, 'open');
  assert.ok(a.broker.getPeer('b').pendingRequests.includes(native.id));
  assert.throws(() => a.broker.publishAudio(pcm, 'b'), /retained audio/u);
  hold.release();
  await microtasks();
  await h.settle();
  assert.equal(a.engine.resources.has(native.result.publicationId), false);
  assert.equal(a.broker.getPeer('b').audioRetirements.length, 0);
  assert.equal(pubs(a, 'b').find(value => value.sourceId === video).enabled, true);
  await a.broker.publishAudio(pcm, 'b');
  await h.settle();
  assert.equal(pubs(a, 'b').find(value => value.mediaKind === 'audio').enabled, true);
  assert.equal(a.engine.externalSources.get(pcm).inputEpoch, 7);
});

test('A/V audio close failure retains its ID but closes the RTP gate without pausing PCM or harming video', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('watch'));
  await h.settle();
  const audio = pubs(a, 'b').find(value => value.mediaKind === 'audio');
  a.engine.failNext('resource.close', audio.publicationId, 'ERR_RTC_RESOURCE');
  await assert.rejects(a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-two' }), AggregateError);
  assert.equal(a.engine.resources.has(audio.publicationId), true);
  assert.equal(audio.enabled, false);
  assert.equal(audio.requestedEnabled, false);
  assert.equal(a.engine.externalSources.get(pcm).enabled, true);
  assert.equal(a.engine.externalSources.get(pcm).inputEpoch, 7);
  assert.equal(pubs(a, 'b').find(value => value.sourceId === one).enabled, true);
  assert.equal(a.broker.getPeer('b').status, 'open');
  const retry = a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-two' });
  await h.settle();
  await retry;
  assert.equal(a.engine.resources.has(audio.publicationId), false);
  assert.equal(a.broker.getAudioSource().screenAudioShareId, 'screen-two');
});

test('A/V a timed-out committed group change cannot republish or restore the old association from a late ACK', async t => {
  const h = await world(t, ['a', 'b'], { av: true, operationTimeoutMs: 100 }), a = h.endpoints.get('a');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b')]);
  await h.settle();
  const hold = a.audioOwner.holdRebind(true);
  const moving = a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-two' });
  const timedOut = assert.rejects(moving, { code: 'P2P_TIMEOUT' });
  await hold.started.promise;
  h.clock.advance(101);
  await timedOut;
  assert.equal(a.broker.getAudioSource().rebinding, true);
  assert.throws(() => a.broker.publishAudio(pcm, 'b'), /obsolete|unowned/u);
  hold.gate.resolve();
  await microtasks();
  assert.equal(a.broker.getAudioSource().screenAudioShareId, null);
  assert.equal(a.broker.getAudioSource().syncGroup, a.engine.externalSources.get(two).syncGroup);
  assert.throws(() => a.broker.publishAudio(pcm, 'b'), /associated/u);
  a.audioOwner.rebindHold = null;
  await a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-two' });
  await a.broker.publishAudio(pcm, 'b');
  await h.settle();
  assert.equal(a.engine.externalSources.get(pcm).inputEpoch, 7);
});

test('A/V aborting the associated video publication retires its audio without stopping the peer or PCM source', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), pcm = h.supplyAudio('a'), controller = new AbortController();
  await Promise.all([a.broker.publish(one, 'b', { signal: controller.signal }),
    a.broker.publish(two, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await Promise.all([b.broker.watch('a', 'screen-one', destination('one')), b.broker.watch('a', 'screen-two', destination('two'))]);
  await h.settle();
  controller.abort();
  await h.settle();
  assert.equal(pubs(a, 'b').filter(value => value.mediaKind === 'audio').length, 0);
  assert.equal(pubs(a, 'b').find(value => value.sourceId === two).enabled, true);
  assert.equal(b.audioOwner.bindings.size, 0);
  assert.equal(a.broker.getPeer('b').status, 'open');
  assert.equal(a.engine.externalSources.get(pcm).enabled, true);
});

test('A/V pending stopped negotiation remains owned after timeout and only full engine proof can retire it without SDP', async t => {
  const h = await world(t, ['a', 'b'], { av: true, operationTimeoutMs: 100 }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const one = h.supply('a'), two = h.supply('a', 'screen-two'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(one, 'b'), a.broker.publish(two, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await b.broker.watch('a', 'screen-one', destination('watch'));
  await h.settle();
  h.wire.block = item => item.message.type === 'answer';
  const moving = a.broker.rebindAudioSource(pcm, { screenAudioShareId: 'screen-two' });
  const timeout = assert.rejects(moving, { code: 'P2P_TIMEOUT' });
  await h.settle();
  h.clock.advance(101);
  await timeout;
  await microtasks();
  assert.equal(a.broker.getPeer('b').audioRetirements.length, 1);
  assert.equal(a.audioOwner.rebinds.length, 0);
  assert.throws(() => a.broker.publishAudio(pcm, 'b'), /retained audio|rebinding|unowned|obsolete/u);
  const closed = beginOwnerClose(a);
  const finishing = a.broker.finishAfterEngineClose(closed.promise);
  a.broker.handleNativeEvent({ type: 'closed', target: 0, data: {} });
  assert.equal(a.broker.getPeer('b').audioRetirements.length, 1, 'JSON closed is not stopped-transceiver retirement proof');
  closed.resolve();
  await finishing;
  assert.equal(a.broker.getPeer('b'), null);
  assert.equal(a.broker.getAudioSource(), null);
  assert.equal(a.audioOwner.rebinds.length, 0);
});

test('A/V invalid synchronous readiness assertions are rejected before native receiving SDP', async t => {
  for (const mode of ['false', 'async']) {
    await t.test(mode, async child => {
      const h = await world(child, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
      await h.connect();
      const video = h.supply('a'), pcm = h.supplyAudio('a');
      b.audioOwner.assertReceiveReady = mode === 'false' ? () => false : async () => true;
      await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
      await assert.rejects(h.settle(), /readiness|synchronous/u);
      assert.equal(b.engine.requests.some(request => request.operation === 'peer.setRemoteDescription'), false);
      assert.equal(b.audioOwner.bindings.size, 0);
    });
  }
});

test('A/V invalid expected epochs cannot dispatch receiving SDP or be inferred from a public proof', async t => {
  for (const epoch of [0, -1, 1.5, '1', undefined, Promise.resolve(1)]) {
    await t.test(String(epoch), async child => {
      const h = await world(child, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
      await h.connect();
      b.audioOwner.expectedOutputEpoch = () => epoch;
      const video = h.supply('a'), pcm = h.supplyAudio('a');
      await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
      await assert.rejects(h.settle(), /epoch.*(?:synchronous|preparation)/u);
      assert.equal(b.engine.requests.some(request => request.operation === 'peer.setRemoteDescription'), false);
    });
  }
});

test('A/V output replacement after JS preparation is rejected at native admission without replay', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const held = b.engine.holdNext('peer.setRemoteDescription');
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  const settling = assert.rejects(h.settle(), { code: 'ERR_RTC_AUDIO_OUTPUT_PRE_ADMISSION' });
  const attempt = await held.started.promise;
  const peer = b.engine.peer(attempt.target);
  const prepared = b.engine.outputEpoch;
  b.engine.outputEpoch++;
  held.release();
  await settling;
  assert.equal(peer.remote, null);
  assert.equal(b.engine.outputReady, true, 'a rejected old attempt cannot retire its replacement output');
  const requests = b.engine.requests.filter(request => request.operation === 'peer.setRemoteDescription');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.expectedOutputEpoch, prepared);
  assert.equal(b.audioOwner.bindings.size, 0);
});

test('A/V broker composes real output ownership and opaque receive proofs through Watch, volume and Stop', async t => {
  const h = await world(t, ['a', 'b'], { av: true, realAudioOutput: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  assert.equal(b.audioOwner.getStats().receivers, 0);
  await b.broker.watch('a', 'screen-one', destination('real-owner'));
  await h.settle();
  assert.equal(b.audioOwner.getStats().receivers, 1);
  assert.equal(b.audioOwner.getStats().bindings[0].outputEpoch, 1);
  await b.broker.setAudioVolume('a', 'screen-one', 0.4);
  await h.settle();
  assert.equal(b.audioOwner.getStats().bindings[0].volume, 0.4);
  const admissions = b.engine.requests.filter(request => request.operation === 'peer.setReceiverEnabled'
    && request.data.enabled && b.engine.peer(request.target).receivers.get(request.data.receiverId).mediaKind === 'audio');
  assert.ok(admissions.length > 0);
  assert.ok(admissions.every(request => request.data.expectedOutputEpoch === 1));
  await b.broker.stopWatching('a', 'screen-one');
  await h.settle();
  assert.equal(b.audioOwner.getStats().receivers, 0);
  assert.equal(b.output.getStats().ready, true);
  assert.equal(b.engine.outputEpoch, 1);
  assert.equal(b.errors.length, 0);
});

test('A/V volume zero is independent from mute and never authorizes a non-watched receiver', async t => {
  const h = await world(t, ['a', 'b'], { av: true }), a = h.endpoints.get('a'), b = h.endpoints.get('b');
  await h.connect();
  const video = h.supply('a'), pcm = h.supplyAudio('a');
  await Promise.all([a.broker.publish(video, 'b'), a.broker.publishAudio(pcm, 'b')]);
  await h.settle();
  await b.broker.setAudioVolume('a', 'screen-one', 2);
  await h.settle();
  const audio = pubs(a, 'b').find(value => value.mediaKind === 'audio'), receiver = watchedReceiver(b, 'a', audio);
  assert.equal(receiver.enabled, false);
  assert.equal(audio.enabled, false);
  await b.broker.watch('a', 'screen-one', destination('watch'));
  await h.settle();
  await b.broker.setAudioVolume('a', 'screen-one', 0);
  await h.settle();
  assert.equal(receiver.volume, 0);
  assert.equal(b.engine.mixedReceivers.includes(receiver.receiverId), false);
  await b.broker.setAudioMuted('a', 'screen-one', true);
  await h.settle();
  await b.broker.setAudioMuted('a', 'screen-one', false);
  await h.settle();
  assert.equal(receiver.volume, 0, 'unmute must preserve the independently selected zero volume');
  assert.equal(b.engine.mixedReceivers.includes(receiver.receiverId), false);
  assert.equal(a.engine.externalSources.get(pcm).enabled, true);
});
