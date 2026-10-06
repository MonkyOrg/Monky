'use strict';

const { isDeepStrictEqual } = require('node:util');
const { isNativeAudioOutputOwnerForEngine, nativeAudioOutputReceiveEpoch } = require('./nativeAudioOutputOwner.cjs');

const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0');
const share = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value);
const mediaReference = value => typeof value === 'string' && Buffer.byteLength(value) > 0
  && Buffer.byteLength(value) <= 256 && !value.includes('\0');
const receiverKey = value => `${value.peerId}:${value.receiverId}`;
const token = (value, maximum) => typeof value === 'string' && value.length <= maximum && /^[\x21-\x7e]+$/u.test(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function selectionCopy(value) {
  if (!value || value.kind !== 'audio' || !share(value.shareId) || value.screenAudioShareId !== value.shareId
    || ![value.peerId, value.receiverId, value.observedEpoch, value.generation, value.publicationId,
      value.publicationVersion, value.metadataVersion, value.watchVersion, value.subscriptionId].every(positive)
    || ![value.publisherSessionId, value.connectionId].every(reference) || !mediaReference(value.syncGroup)
    || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 2
    || !mediaReference(value.binding?.trackId) || (value.binding.mid !== null && !mediaReference(value.binding.mid))
    || !Array.isArray(value.binding.streamIds) || value.binding.streamIds.length > 8
    || !value.binding.streamIds.every(mediaReference) || !value.binding.streamIds.includes(value.syncGroup)) {
    throw new Error('Native audio receiver requires its exact selected screen, generation and media binding.');
  }
  return Object.freeze({
    peerId: value.peerId, receiverId: value.receiverId, observedEpoch: value.observedEpoch,
    publisherSessionId: value.publisherSessionId, connectionId: value.connectionId, generation: value.generation,
    kind: 'audio', shareId: value.shareId, screenAudioShareId: value.shareId, syncGroup: value.syncGroup,
    publicationId: value.publicationId, publicationVersion: value.publicationVersion, metadataVersion: value.metadataVersion,
    watchVersion: value.watchVersion, subscriptionId: value.subscriptionId, volume: value.volume,
    binding: Object.freeze({ trackId: value.binding.trackId, mid: value.binding.mid,
      streamIds: Object.freeze([...value.binding.streamIds]) }),
  });
}

// These proofs correlate a prepared Main output with one attempt. Native admission must still compare its epoch.
class NativeAudioReceiveAdapter {
  #engine;
  #output;
  #callId;
  #channelId;
  #isCurrent;
  #maximumReceivers;
  #proofs = new WeakMap();
  #bindings = new Map();
  #sfuProofs = new WeakMap();
  #sfuAttempts = new Set();
  #sfuBindings = new Map();

  constructor({ engine, output, callId, channelId, isCurrent, maximumReceivers = 64 }) {
    if (!isNativeAudioOutputOwnerForEngine(output, engine) || ![callId, channelId].every(reference)
      || typeof isCurrent !== 'function' || !positive(maximumReceivers) || maximumReceivers > 128) {
      throw new Error('Native audio receive needs its genuine same-engine output and current call scope.');
    }
    this.#engine = engine;
    this.#output = output;
    this.#callId = callId;
    this.#channelId = channelId;
    this.#isCurrent = isCurrent;
    this.#maximumReceivers = maximumReceivers;
  }

  static isForEngineAndScope(adapter, engine, callId, channelId) {
    return adapter !== null && typeof adapter === 'object' && #engine in adapter
      && adapter.#engine === engine && adapter.#callId === callId && adapter.#channelId === channelId;
  }

  #context(value) {
    if (!value || value.engine !== this.#engine || value.callId !== this.#callId || value.channelId !== this.#channelId
      || ![value.remoteSessionId, value.connectionId].every(reference) || !positive(value.generation)
      || !positive(value.peerId) || !(value.signal instanceof AbortSignal)
      || !['description', 'receiver'].includes(value.reason)) throw new Error('Invalid native audio receive attempt scope.');
    value.signal.throwIfAborted();
    const scope = Object.freeze({ callId: value.callId, channelId: value.channelId, remoteSessionId: value.remoteSessionId,
      connectionId: value.connectionId, generation: value.generation });
    if (this.#isCurrent(scope) !== true) throw new Error('Native audio receive attempt no longer belongs to the current call.');
    if (value.reason === 'description') {
      if (!['local', 'remote'].includes(value.side) || !['offer', 'answer'].includes(value.descriptionType)) {
        throw new Error('Native audio receive needs the exact SDP side and type.');
      }
      return Object.freeze({ ...scope, peerId: value.peerId, signal: value.signal, reason: value.reason,
        side: value.side, descriptionType: value.descriptionType });
    }
    const selection = selectionCopy(value.selection);
    if (selection.peerId !== value.peerId || selection.publisherSessionId !== value.remoteSessionId
      || selection.connectionId !== value.connectionId || selection.generation !== value.generation) {
      throw new Error('Native audio receiver selection does not match its prepared peer generation.');
    }
    return Object.freeze({ ...scope, peerId: value.peerId, signal: value.signal, reason: value.reason, selection });
  }

  #prepared(proof, context) {
    const record = proof && typeof proof === 'object' ? this.#proofs.get(proof) : null;
    if (!record) throw new Error('Native audio receive requires an original preparation from this output owner.');
    const current = this.#context(context);
    if (current.signal !== record.context.signal || !isDeepStrictEqual(current, record.context)
      || nativeAudioOutputReceiveEpoch(this.#output, this.#engine) !== record.epoch) {
      throw new Error('The prepared native audio output or receive attempt was replaced.');
    }
    return record;
  }

  async prepareReceive(context) {
    const prepared = this.#context(context);
    const epoch = nativeAudioOutputReceiveEpoch(this.#output, this.#engine);
    if (!positive(epoch)) throw new Error('Select, start and calibrate the owned native audio output before receiving.');
    const proof = Object.freeze({});
    this.#proofs.set(proof, { epoch, context: prepared });
    return proof;
  }

  assertReceiveReady(proof, context) {
    this.#prepared(proof, context);
  }

  expectedOutputEpoch(proof, context) {
    return this.#prepared(proof, context).epoch;
  }

  bindReceiver(selection, acknowledgement, proof) {
    const prepared = proof && typeof proof === 'object' ? this.#proofs.get(proof) : null;
    if (!prepared || prepared.context.reason !== 'receiver') throw new Error('Audio receiver was not prepared for this binding.');
    this.#prepared(proof, { ...prepared.context, engine: this.#engine });
    const selected = selectionCopy(selection);
    if (!isDeepStrictEqual(selected, prepared.context.selection)
      || acknowledgement?.receiverId !== selected.receiverId || !positive(acknowledgement.receiverEpoch)
      || acknowledgement.receiverEpoch < selected.observedEpoch || selection.receiverEpoch !== acknowledgement.receiverEpoch
      || acknowledgement.enabled !== true || acknowledgement.requestedEnabled !== true) {
      throw new Error('Native audio receiver acknowledgement does not match its prepared Watch.');
    }
    this.#prune();
    const key = receiverKey(selected);
    if (!this.#bindings.has(key) && this.#bindings.size + this.#sfuAttempts.size >= this.#maximumReceivers) {
      throw new Error('Native audio output receiver binding limit reached.');
    }
    this.#bindings.set(key, { selection: selected, receiverEpoch: acknowledgement.receiverEpoch,
      outputEpoch: prepared.epoch, volume: selected.volume });
    return true;
  }

  revokeReceiver(selection, reason) {
    if (!reference(reason)) throw new Error('Native audio receiver retirement requires a reason.');
    const selected = selectionCopy(selection), key = receiverKey(selected), record = this.#bindings.get(key);
    if (!record || selection.receiverEpoch !== record.receiverEpoch
      || !isDeepStrictEqual(record.selection, selected)) return false;
    this.#bindings.delete(key);
    return true;
  }

  onReceiverVolume(selection, acknowledgement) {
    const selected = selectionCopy(selection);
    if (acknowledgement?.receiverId !== selected.receiverId || !positive(acknowledgement.receiverEpoch)
      || acknowledgement.receiverEpoch < selected.observedEpoch || acknowledgement.volume !== selected.volume) {
      throw new Error('Native audio volume acknowledgement does not match its selected receiver.');
    }
    const record = this.#bindings.get(receiverKey(selected));
    if (!record || record.receiverEpoch !== acknowledgement.receiverEpoch
      || !isDeepStrictEqual(record.selection, selected)) return false;
    record.volume = selected.volume;
    return true;
  }

  #sfuContext(value, current = true) {
    if (!value || value.engine !== this.#engine || value.callId !== this.#callId || value.channelId !== this.#channelId
      || value.reason !== 'sfu-consumer' || value.kind !== 'audio'
      || ![value.remoteSessionId, value.connectionId, value.serverTransportId, value.producerId, value.serverConsumerId].every(reference)
      || ![value.generation, value.transportId, value.watchVersion].every(positive)
      || !share(value.shareId) || value.screenAudioShareId !== value.shareId || !mediaReference(value.syncGroup)
      || !(value.signal instanceof AbortSignal)) {
      throw new Error('Native SFU audio needs its exact call, transport, producer, consumer, screen and Watch generation.');
    }
    const scope = Object.freeze({
      callId: value.callId, channelId: value.channelId, remoteSessionId: value.remoteSessionId,
      connectionId: value.connectionId, generation: value.generation, transportId: value.transportId,
      serverTransportId: value.serverTransportId, producerId: value.producerId, serverConsumerId: value.serverConsumerId,
      kind: 'audio', shareId: value.shareId, screenAudioShareId: value.shareId,
      syncGroup: value.syncGroup, watchVersion: value.watchVersion,
    });
    if (current) {
      value.signal.throwIfAborted();
      if (this.#isCurrent(scope) !== true) throw new Error('Native SFU audio Watch no longer belongs to the current call.');
    }
    return Object.freeze({ ...scope, reason: 'sfu-consumer', signal: value.signal });
  }

  #sfuPrepared(proof, context) {
    const record = proof && typeof proof === 'object' ? this.#sfuProofs.get(proof) : null;
    if (!record || record.retired) throw new Error('Native SFU audio requires an original live output preparation.');
    const current = this.#sfuContext(context);
    if (current.signal !== record.context.signal || !isDeepStrictEqual(current, record.context)
      || nativeAudioOutputReceiveEpoch(this.#output, this.#engine) !== record.epoch) {
      throw new Error('The prepared native SFU output epoch or receive attempt was replaced.');
    }
    return record;
  }

  // A paused SFU consumer still admits receiving SDP. Reserve its owned output
  // before sfu.consume, then reuse this exact epoch for every later activation.
  async prepareSfuReceive(context) {
    const prepared = this.#sfuContext(context);
    const epoch = nativeAudioOutputReceiveEpoch(this.#output, this.#engine);
    if (!positive(epoch)) throw new Error('Select, start and calibrate the owned native audio output before receiving.');
    this.#prune();
    if (this.#bindings.size + this.#sfuAttempts.size >= this.#maximumReceivers) {
      throw new Error('Native audio output receiver preparation limit reached.');
    }
    const proof = Object.freeze({});
    const record = { proof, epoch, context: prepared, binding: null, enabled: false, volume: 1, retired: false };
    this.#sfuProofs.set(proof, record);
    this.#sfuAttempts.add(record);
    return proof;
  }

  assertSfuReceiveReady(proof, context) { this.#sfuPrepared(proof, context); }

  expectedSfuOutputEpoch(proof, context) { return this.#sfuPrepared(proof, context).epoch; }

  bindSfuConsumer(acknowledgement, proof, context) {
    const record = this.#sfuPrepared(proof, context);
    if (!exact(acknowledgement, ['consumerId', 'serverConsumerId', 'kind', 'syncGroup', 'mid', 'trackId'])
      || !positive(acknowledgement.consumerId) || acknowledgement.kind !== 'audio'
      || acknowledgement.serverConsumerId !== record.context.serverConsumerId
      || acknowledgement.syncGroup !== record.context.syncGroup
      || !token(acknowledgement.mid, 64) || !token(acknowledgement.trackId, 256)
      || acknowledgement.trackId !== acknowledgement.serverConsumerId
      || record.binding || this.#sfuBindings.has(acknowledgement.consumerId)) {
      throw new Error('Native SFU audio binding does not match its actual paused consumer and prepared Watch.');
    }
    record.binding = Object.freeze({ ...acknowledgement });
    this.#sfuBindings.set(acknowledgement.consumerId, record);
    return true;
  }

  #sfuBound(consumerId, proof, context) {
    const record = this.#sfuPrepared(proof, context);
    if (!positive(consumerId) || record.binding?.consumerId !== consumerId || this.#sfuBindings.get(consumerId) !== record) {
      throw new Error('Native SFU audio control requires its exact bound consumer.');
    }
    return record;
  }

  onSfuConsumerEnabled(consumerId, acknowledgement, proof, context) {
    const record = this.#sfuBound(consumerId, proof, context);
    if (!exact(acknowledgement, ['enabled']) || typeof acknowledgement.enabled !== 'boolean') {
      throw new Error('Native SFU audio enable acknowledgement is malformed.');
    }
    record.enabled = acknowledgement.enabled;
    return true;
  }

  onSfuConsumerVolume(consumerId, acknowledgement, proof, context) {
    const record = this.#sfuBound(consumerId, proof, context);
    if (!exact(acknowledgement, ['consumerId', 'volume']) || acknowledgement.consumerId !== consumerId
      || !Number.isFinite(acknowledgement.volume) || acknowledgement.volume < 0 || acknowledgement.volume > 2) {
      throw new Error('Native SFU audio volume acknowledgement does not match its selected consumer.');
    }
    record.volume = acknowledgement.volume;
    return true;
  }

  revokeSfuReceive(proof, context, reason) {
    if (!reference(reason)) throw new Error('Native SFU audio retirement requires a reason.');
    const record = proof && typeof proof === 'object' ? this.#sfuProofs.get(proof) : null;
    if (!record || record.retired) return false;
    const original = this.#sfuContext(context, false);
    if (original.signal !== record.context.signal || !isDeepStrictEqual(original, record.context)) return false;
    this.#retireSfu(record);
    return true;
  }

  #retireSfu(record) {
    record.retired = true;
    this.#sfuAttempts.delete(record);
    if (record.binding && this.#sfuBindings.get(record.binding.consumerId) === record) {
      this.#sfuBindings.delete(record.binding.consumerId);
    }
  }

  #prune() {
    const epoch = nativeAudioOutputReceiveEpoch(this.#output, this.#engine);
    for (const [key, record] of this.#bindings) if (record.outputEpoch !== epoch) this.#bindings.delete(key);
    for (const record of this.#sfuAttempts) {
      let current = false;
      try {
        this.#sfuContext({ ...record.context, engine: this.#engine });
        current = record.epoch === epoch;
      } catch { /* Retired Watch/output observations cannot retain an authorization. */ }
      if (!current) this.#retireSfu(record);
    }
  }

  getStats() {
    this.#prune();
    return Object.freeze({ receivers: this.#bindings.size,
      bindings: Object.freeze([...this.#bindings.values()].map(record => Object.freeze({
        ...record.selection, receiverEpoch: record.receiverEpoch, outputEpoch: record.outputEpoch, volume: record.volume,
      }))),
      sfuPreparations: this.#sfuAttempts.size, sfuConsumers: this.#sfuBindings.size,
      sfuBindings: Object.freeze([...this.#sfuBindings.values()].map(record => {
        const { signal, reason, ...scope } = record.context;
        return Object.freeze({ ...scope, ...record.binding, outputEpoch: record.epoch,
          enabled: record.enabled, volume: record.volume });
      })) });
  }
}

const isNativeAudioReceiveAdapterForEngine = NativeAudioReceiveAdapter.isForEngineAndScope;
const sfuMethods = Object.freeze(Object.fromEntries([
  'prepareSfuReceive', 'assertSfuReceiveReady', 'expectedSfuOutputEpoch', 'bindSfuConsumer',
  'onSfuConsumerEnabled', 'onSfuConsumerVolume', 'revokeSfuReceive',
].map(name => [name, Function.prototype.call.bind(NativeAudioReceiveAdapter.prototype[name])])));
function nativeAudioSfuReceiveHooks(adapter, engine, callId, channelId) {
  if (!isNativeAudioReceiveAdapterForEngine(adapter, engine, callId, channelId)) {
    throw new Error('Native SFU audio hooks require the genuine same-engine/call receive adapter.');
  }
  return Object.freeze(Object.fromEntries(Object.entries(sfuMethods).map(([name, method]) => [
    name, (...args) => method(adapter, ...args),
  ])));
}
module.exports = { NativeAudioReceiveAdapter, isNativeAudioReceiveAdapterForEngine, nativeAudioSfuReceiveHooks };
