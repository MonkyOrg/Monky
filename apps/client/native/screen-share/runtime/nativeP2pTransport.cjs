'use strict';

const { NativeScreenTransport, actualPromise } = require('./nativeScreenTransport.cjs');

const cancelled = () => new DOMException('Native P2P peer was retired.', 'AbortError');

class NativeP2pTransport extends NativeScreenTransport {
  constructor(broker, onError, { audioPublication = false, preparePeer = null } = {}) {
    if (['registerSource', 'connect', 'publish', 'removeSource', 'closePeer', 'close',
      'finishAfterEngineClose', 'handleNativeEvent'].some(name => typeof broker?.[name] !== 'function')
      || typeof onError !== 'function' || typeof audioPublication !== 'boolean'
      || (preparePeer !== null && typeof preparePeer !== 'function')
      || (audioPublication && (broker.controlVersion !== 2 || !broker.audio
        || ['registerAudioSource', 'publishAudio'].some(name => typeof broker[name] !== 'function')))) {
      throw new Error('A complete native P2P broker and error observer are required.');
    }
    super(broker, onError, { label: 'P2P', audioPublication, maximumBitrateBps: 2147483647 });
    this.peers = new Map();
    this.preparePeer = preparePeer;
  }

  registerVideo(record) {
    this.broker.registerSource({ sourceId: record.sourceId, localShareId: record.shareId, syncGroup: record.syncGroup });
  }

  async publishSource(record, signal) {
    const published = await Promise.allSettled([...this.peers.values()].map(peer => this.publish(record, peer)));
    signal?.throwIfAborted();
    if (this.closing || !record.active) throw this.retired();
    const failures = published.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Native screen could not publish to every requested peer.');
  }

  retireSource(record) {
    return actualPromise(this.broker.removeSource(record.sourceId), 'Native P2P source retirement');
  }

  async publish(source, peer) {
    await peer.opening;
    if (!source.active || !peer.active || this.closing) return;
    if (source.kind === 'audio') {
      const video = source.associatedVideo;
      await this.publish(video, peer);
      if (!source.active || !peer.active || this.closing || !video.active) return;
      try {
        await this.broker.publishAudio(source.sourceId, peer.sessionId, { maxBitrateBps: source.maxBitrateBps });
      } catch (error) {
        // Removing the audio source cancels its pending publication; that
        // cancellation must not tear down the peer's video tracks.
        if (source.active && !this.closing) throw error;
      }
      return;
    }
    await this.broker.publish(source.sourceId, peer.sessionId, {
      maxBitrateBps: source.maxBitrateBps, maxFramerate: source.maxFramerate,
    });
  }

  async connect(sessionId, configuration) {
    if (this.closing || this.peers.has(sessionId)) throw new Error('Native P2P peer is retained or closed.');
    const peer = { sessionId, active: true, opening: null };
    this.peers.set(sessionId, peer);
    peer.opening = Promise.resolve().then(async () => {
      const peerId = await this.broker.connect(sessionId, configuration);
      if (this.closing || !peer.active) throw cancelled();
      if (this.preparePeer) {
        const preparing = this.preparePeer(peerId, sessionId);
        if (typeof preparing?.then !== 'function') throw new Error('Native peer preparation must return its actual Promise.');
        await preparing;
      }
      return peerId;
    });
    try {
      const peerId = await peer.opening;
      const published = await Promise.allSettled([...this.sources.values()].filter(source => source.active)
        .map(source => this.publish(source, peer)));
      if (this.closing || !peer.active) throw cancelled();
      const failures = published.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Native peer could not receive every published screen.');
      return peerId;
    } catch (error) {
      try { await this.closePeer(sessionId); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native peer setup and cleanup failed.'); }
      throw error;
    }
  }

  async closePeer(sessionId) {
    const peer = this.peers.get(sessionId);
    if (!peer) return;
    peer.active = false;
    const closing = Promise.resolve().then(() => this.broker.closePeer(sessionId));
    const result = await Promise.allSettled([peer.opening, closing]);
    // A connect result can arrive after closePeer found no native record yet.
    const closed = await Promise.allSettled([Promise.resolve().then(() => this.broker.closePeer(sessionId))]);
    const failures = [...result.slice(1), ...closed].filter(value => value.status === 'rejected').map(value => value.reason);
    if (failures.length) throw new AggregateError(failures, 'Native peer closure retained ownership.');
    if (this.peers.get(sessionId) === peer) this.peers.delete(sessionId);
  }

  async closeBroker() {
    for (const peer of this.peers.values()) peer.active = false;
    await this.broker.close();
    const opened = await Promise.allSettled([...this.peers.values()].map(peer => peer.opening));
    if (opened.length) await this.broker.close();
    this.peers.clear();
  }

  async retireBroker(engineClosePromise) {
    await this.broker.finishAfterEngineClose(engineClosePromise);
    this.peers.clear();
  }
}

module.exports = { NativeP2pTransport };
