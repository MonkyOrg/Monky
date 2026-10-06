'use strict';

const { isPresentationId } = require('./presentationRoute.cjs');

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const shareIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value);
const mediaReference = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256;

function mediaBinding(data) {
  if (!mediaReference(data?.trackId) || (data.mid !== null && !mediaReference(data.mid))
    || !Array.isArray(data.streamIds) || data.streamIds.length > 8
    || data.streamIds.some(value => !mediaReference(value))) {
    throw new Error('Invalid native media binding metadata.');
  }
  return { trackId: data.trackId, mid: data.mid, streamIds: [...data.streamIds] };
}

function sameBinding(left, right) {
  return left.trackId === right.trackId && left.mid === right.mid
    && left.streamIds.length === right.streamIds.length
    && left.streamIds.every((value, index) => value === right.streamIds[index]);
}

class NativeScreenRoutes {
  constructor({ maximumPeers = 32, maximumReceivers = 64 } = {}) {
    if (!Number.isInteger(maximumPeers) || maximumPeers < 1 || maximumPeers > 64
      || !Number.isInteger(maximumReceivers) || maximumReceivers < 1 || maximumReceivers > 64) {
      throw new Error('Invalid bounded native screen routing configuration.');
    }
    this.maximumPeers = maximumPeers;
    this.maximumReceivers = maximumReceivers;
    this.roster = new Map();
    this.peers = new Map();
    this.consumers = new Map();
    this.watches = new Map();
    this.nextWatchVersion = 1;
    this.drops = new Map();
  }

  setRoster(publisherSessionId, shareIds) {
    if (!reference(publisherSessionId) || !Array.isArray(shareIds) || shareIds.length > 2
      || shareIds.some(id => !shareIdValid(id)) || new Set(shareIds).size !== shareIds.length) {
      throw new Error('Invalid authenticated screen roster.');
    }
    if (!this.roster.has(publisherSessionId) && this.roster.size >= this.maximumPeers) {
      throw new Error('Native screen publisher limit reached.');
    }
    const allowed = new Set(shareIds);
    this.roster.set(publisherSessionId, allowed);
    const watches = this.watches.get(publisherSessionId);
    for (const shareId of watches?.keys() ?? []) if (!allowed.has(shareId)) watches.delete(shareId);
    for (const peer of this.peers.values()) {
      if (peer.publisherSessionId !== publisherSessionId) continue;
      for (const shareId of peer.announcements.keys()) if (!allowed.has(shareId)) peer.announcements.delete(shareId);
      for (const receiver of peer.receivers.values()) {
        if (receiver.authorization && !allowed.has(receiver.authorization.shareId)) receiver.authorization = null;
      }
    }
  }

  addPeer(peerId, publisherSessionId, connectionId) {
    if (!positiveId(peerId) || !reference(publisherSessionId) || !reference(connectionId)
      || this.peers.has(peerId) || this.peers.size >= this.maximumPeers
      || [...this.peers.values()].some(peer => peer.publisherSessionId === publisherSessionId)) {
      throw new Error('Invalid or duplicate native peer route.');
    }
    this.peers.set(peerId, { publisherSessionId, connectionId, announcements: new Map(), receivers: new Map() });
  }

  removePeer(peerId) {
    this.peers.delete(peerId);
  }

  removePublisher(publisherSessionId) {
    this.roster.delete(publisherSessionId);
    this.watches.delete(publisherSessionId);
    for (const [id, peer] of this.peers) if (peer.publisherSessionId === publisherSessionId) this.peers.delete(id);
    for (const [id, consumer] of this.consumers) {
      if (consumer.publisherSessionId === publisherSessionId) this.consumers.delete(id);
    }
  }

  announce(peerId, publisherSessionId, connectionId, announcement) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.publisherSessionId !== publisherSessionId || peer.connectionId !== connectionId) {
      throw new Error('Screen announcement belongs to a different authenticated peer generation.');
    }
    const shareId = announcement?.shareId;
    if (!shareIdValid(shareId) || !this.roster.get(publisherSessionId)?.has(shareId)) {
      throw new Error('Screen announcement is absent from its authenticated publisher roster.');
    }
    const binding = mediaBinding(announcement);
    for (const [otherShare, otherBinding] of peer.announcements) {
      if (otherShare !== shareId && (otherBinding.trackId === binding.trackId
        || (binding.mid !== null && otherBinding.mid === binding.mid))) {
        throw new Error('Two native screens cannot claim the same negotiated track or MID.');
      }
    }
    peer.announcements.set(shareId, binding);
    for (const receiver of peer.receivers.values()) {
      if (receiver.authorization?.shareId === shareId && !sameBinding(receiver.authorization.binding, binding)) {
        receiver.authorization = null;
      }
    }
  }

  setWatching(publisherSessionId, shareId, destination) {
    if (!reference(publisherSessionId) || !shareIdValid(shareId)
      || (destination !== null && (!this.roster.get(publisherSessionId)?.has(shareId)
        || !isPresentationId(destination?.presentationId) || typeof destination.frame?.isDestroyed !== 'function'))) {
      throw new Error('Invalid native screen watch destination.');
    }
    let watches = this.watches.get(publisherSessionId);
    if (destination === null) {
      watches?.delete(shareId);
      for (const peer of this.peers.values()) {
        if (peer.publisherSessionId !== publisherSessionId) continue;
        for (const receiver of peer.receivers.values()) {
          if (receiver.authorization?.shareId === shareId) receiver.authorization = null;
        }
      }
      return null;
    }
    if (!Number.isSafeInteger(this.nextWatchVersion)) throw new Error('Native watch generations are exhausted.');
    if (!watches) { watches = new Map(); this.watches.set(publisherSessionId, watches); }
    const watch = {
      version: this.nextWatchVersion++, destination: { presentationId: destination.presentationId, frame: destination.frame },
    };
    watches.set(shareId, watch);
    return watch.version;
  }

  onTrackEvent(event) {
    if (!['peer.trackAdded', 'peer.trackUpdated', 'peer.trackRemoved'].includes(event?.type)
      || !positiveId(event.target) || !positiveId(event.data?.receiverId) || !positiveId(event.data.receiverEpoch)
      || event.data.kind !== 'video') {
      throw new Error('Invalid native receiver lifecycle event.');
    }
    const peer = this.peers.get(event.target);
    if (!peer) return false;
    const binding = mediaBinding(event.data);
    const { receiverId, receiverEpoch } = event.data;
    const previous = peer.receivers.get(receiverId);
    if (previous && receiverEpoch < previous.epoch) return false;
    if (previous && receiverEpoch === previous.epoch) {
      if (!sameBinding(previous.binding, binding) || previous.present !== (event.type !== 'peer.trackRemoved')) {
        throw new Error('Native receiver changed binding or presence without a new epoch.');
      }
      return false;
    }
    if (!previous && peer.receivers.size >= this.maximumReceivers) throw new Error('Native receiver history limit reached.');
    const authorization = previous?.authorization;
    peer.receivers.set(receiverId, {
      epoch: receiverEpoch, binding, present: event.type !== 'peer.trackRemoved',
      authorization: authorization?.receiverEpoch === receiverEpoch && sameBinding(authorization.binding, binding)
        ? authorization : null,
    });
    return true;
  }

  desiredReceiver(peerId, receiverId) {
    const peer = this.peers.get(peerId);
    const receiver = peer?.receivers.get(receiverId);
    if (!receiver?.present) return null;
    for (const [shareId, binding] of peer.announcements) {
      const watch = this.watches.get(peer.publisherSessionId)?.get(shareId);
      if (!watch || !sameBinding(receiver.binding, binding)) continue;
      return {
        peerId, receiverId, observedEpoch: receiver.epoch, publisherSessionId: peer.publisherSessionId,
        connectionId: peer.connectionId, shareId, watchVersion: watch.version, binding: mediaBinding(binding),
      };
    }
    return null;
  }

  confirmReceiver(selection, result) {
    if (!positiveId(selection?.peerId) || !positiveId(selection.receiverId) || !positiveId(selection.observedEpoch)
      || !positiveId(selection.watchVersion) || !reference(selection.publisherSessionId)
      || !reference(selection.connectionId) || !shareIdValid(selection.shareId)
      || !positiveId(result?.receiverId) || !positiveId(result.receiverEpoch)
      || typeof result.enabled !== 'boolean' || result.requestedEnabled !== true
      || selection.receiverId !== result.receiverId || result.receiverEpoch < selection.observedEpoch) {
      throw new Error('Invalid native receiver enable acknowledgement.');
    }
    const peer = this.peers.get(selection.peerId);
    const receiver = peer?.receivers.get(selection.receiverId);
    const watch = this.watches.get(selection.publisherSessionId)?.get(selection.shareId);
    const announced = peer?.announcements.get(selection.shareId);
    if (!result.enabled || !receiver?.present || !watch || peer.publisherSessionId !== selection.publisherSessionId
      || peer.connectionId !== selection.connectionId || watch?.version !== selection.watchVersion
      || !announced || !sameBinding(announced, selection.binding)
      || !sameBinding(receiver.binding, selection.binding) || receiver.epoch > result.receiverEpoch) return false;
    receiver.authorization = { ...selection, binding: mediaBinding(selection.binding), receiverEpoch: result.receiverEpoch };
    return true;
  }

  registerConsumer(consumerId, publisherSessionId, shareId, watchVersion) {
    if (!positiveId(consumerId) || this.consumers.has(consumerId) || this.consumers.size >= this.maximumReceivers
      || !this.roster.get(publisherSessionId)?.has(shareId)
      || this.watches.get(publisherSessionId)?.get(shareId)?.version !== watchVersion) {
      throw new Error('Native SFU consumer does not belong to the current authenticated watch.');
    }
    this.consumers.set(consumerId, { publisherSessionId, shareId, watchVersion });
  }

  removeConsumer(consumerId) {
    this.consumers.delete(consumerId);
  }

  drop(reason) {
    this.drops.set(reason, (this.drops.get(reason) ?? 0) + 1);
    return null;
  }

  resolveFrame(event) {
    const data = event?.data;
    if (event?.type !== 'frame' || !positiveId(event.target)
      || !['peer', 'consumer'].includes(data?.routeKind)
      || (data.routeKind === 'peer' && (!positiveId(data.receiverId) || !positiveId(data.receiverEpoch)))
      || (data.routeKind === 'consumer' && (data.receiverId !== undefined || data.receiverEpoch !== undefined))) {
      throw new Error('Invalid native decoded frame route.');
    }
    let route;
    if (data.routeKind === 'peer') {
      const peer = this.peers.get(event.target);
      const receiver = peer?.receivers.get(data.receiverId);
      if (!receiver?.present || receiver.epoch !== data.receiverEpoch
        || receiver.authorization?.receiverEpoch !== data.receiverEpoch) return this.drop('unauthorized-receiver');
      route = receiver.authorization;
    } else {
      route = this.consumers.get(event.target);
      if (!route) return this.drop('unknown-consumer');
    }
    const watch = this.watches.get(route.publisherSessionId)?.get(route.shareId);
    if (!this.roster.get(route.publisherSessionId)?.has(route.shareId)
      || watch?.version !== route.watchVersion) return this.drop('obsolete-watch');
    if (watch.destination.frame.isDestroyed() || watch.destination.frame.detached) return this.drop('closed-destination');
    return watch.destination;
  }

  snapshot() {
    return {
      peers: this.peers.size, consumers: this.consumers.size,
      watched: [...this.watches.values()].reduce((sum, values) => sum + values.size, 0),
      droppedFrames: Object.fromEntries(this.drops),
    };
  }
}

module.exports = { NativeScreenRoutes };
