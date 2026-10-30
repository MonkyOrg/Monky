'use strict';

const { notifyObserver } = require('./asyncTools.cjs');

const cancelled = () => new DOMException('Native P2P peer was retired.', 'AbortError');

class NativeP2pTransport {
  constructor(broker, onError, { audioPublication = false, preparePeer = null } = {}) {
    if (['registerSource', 'connect', 'publish', 'removeSource', 'closePeer', 'close',
      'finishAfterEngineClose', 'handleNativeEvent'].some(name => typeof broker?.[name] !== 'function')
      || typeof onError !== 'function' || typeof audioPublication !== 'boolean'
      || (preparePeer !== null && typeof preparePeer !== 'function')
      || (audioPublication && (broker.controlVersion !== 2 || !broker.audio
        || ['registerAudioSource', 'publishAudio'].some(name => typeof broker[name] !== 'function')))) {
      throw new Error('A complete native P2P broker and error observer are required.');
    }
    this.broker = broker;
    this.onError = onError;
    this.sources = new Map();
    this.peers = new Map();
    this.closing = false;
    this.audioPublicationEnabled = audioPublication;
    this.preparePeer = preparePeer;
  }

  async addSource(source, signal) {
    signal?.throwIfAborted();
    if (this.closing || !Number.isSafeInteger(source?.sourceId) || source.sourceId < 1
      || typeof source.shareId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(source.shareId)
      || !Number.isInteger(source.maxFramerate) || source.maxFramerate < 1 || source.maxFramerate > 240
      || !Number.isSafeInteger(source.maxBitrateBps) || source.maxBitrateBps < 1 || source.maxBitrateBps > 2147483647
      || this.sources.has(source.sourceId)) throw new Error('Native P2P source is invalid, retained or closed.');
    const record = { ...source, kind: 'video', active: true, retiring: null };
    this.broker.registerSource({ sourceId: record.sourceId, localShareId: record.shareId, syncGroup: record.syncGroup });
    return this.attachSource(record, signal);
  }

  async addAudioSource(source, signal) {
    signal?.throwIfAborted();
    const video = [...this.sources.values()].find(record => record.kind === 'video'
      && record.active && record.shareId === source?.screenAudioShareId);
    if (this.closing || !this.audioPublicationEnabled || !Number.isSafeInteger(source?.sourceId) || source.sourceId < 1
      || this.sources.has(source.sourceId) || [...this.sources.values()].some(record => record.kind === 'audio')
      || !video || source.syncGroup !== video.syncGroup || source.maxFramerate !== undefined
      || !Number.isSafeInteger(source.maxBitrateBps) || source.maxBitrateBps < 6000 || source.maxBitrateBps > 510000) {
      throw new Error('Native P2P audio publication needs its explicit active screen, bitrate and configured A/V broker.');
    }
    const record = { ...source, kind: 'audio', shareId: source.screenAudioShareId,
      associatedVideo: video, active: true, retiring: null };
    this.broker.registerAudioSource({
      sourceId: record.sourceId, screenAudioShareId: record.shareId, syncGroup: record.syncGroup,
    });
    return this.attachSource(record, signal);
  }

  async attachSource(record, signal) {
    this.sources.set(record.sourceId, record);
    record.opening = Promise.resolve().then(async () => {
      const published = await Promise.allSettled([...this.peers.values()].map(peer => this.publish(record, peer)));
      signal?.throwIfAborted();
      if (this.closing || !record.active) throw new DOMException('Native P2P source was retired.', 'AbortError');
      const failures = published.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Native screen could not publish to every requested peer.');
    });
    const abort = () => {
      void this.removeSource(record.sourceId).catch(error => {
        notifyObserver('Native P2P transport error observer', this.onError, error, { shareId: record.shareId });
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      await record.opening;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
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

  async removeSource(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.active = false;
    if (!source.retiring) {
      const retiring = Promise.resolve().then(async () => {
        if (source.kind === 'video') {
          // Finish audio's StopStandard turn before withdrawing its associated video.
          const audio = [...this.sources.values()].find(record => record.kind === 'audio' && record.associatedVideo === source);
          if (audio) await this.removeAudioSource(audio.sourceId);
        }
        await this.broker.removeSource(sourceId);
      });
      source.retiring = retiring;
      void retiring.catch(() => { if (source.retiring === retiring) source.retiring = null; });
    }
    await source.retiring;
    if (this.sources.get(sourceId) === source) this.sources.delete(sourceId);
  }

  async removeAudioSource(sourceId) {
    const source = this.sources.get(sourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || (source && source.kind !== 'audio')) {
      throw new Error('Native P2P audio retirement requires its own source ID.');
    }
    await this.removeSource(sourceId);
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

  handleEvent(event) { return this.broker.handleNativeEvent(event); }

  async close() {
    this.closing = true;
    for (const source of this.sources.values()) source.active = false;
    for (const peer of this.peers.values()) peer.active = false;
    await this.broker.close();
    const opened = await Promise.allSettled([...this.peers.values()].map(peer => peer.opening));
    if (opened.length) await this.broker.close();
    this.peers.clear();
    this.sources.clear();
  }

  async finishAfterEngineClose(closed) {
    this.closing = true;
    for (const source of this.sources.values()) source.active = false;
    await this.broker.finishAfterEngineClose(closed);
    this.peers.clear();
    this.sources.clear();
  }
}

module.exports = { NativeP2pTransport };
