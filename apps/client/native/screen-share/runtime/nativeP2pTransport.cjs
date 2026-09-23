'use strict';

const { boundedCleanup } = require('./frameSink.cjs');

const cancelled = () => new DOMException('Native P2P audio association was retired.', 'AbortError');
const shareIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value);
const groupValid = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0
  && Buffer.byteLength(value, 'utf8') <= 256 && !value.includes('\0');

async function waitForSetup(pending, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([pending, new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason ?? cancelled());
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

class NativeP2pTransport {
  constructor(broker, onError, { audioPublication = false, timeoutMs = 12000, preparePeer = null } = {}) {
    if (['registerSource', 'connect', 'publish', 'removeSource', 'closePeer', 'close',
      'finishAfterEngineClose', 'handleNativeEvent'].some(name => typeof broker?.[name] !== 'function')
      || typeof onError !== 'function' || typeof audioPublication !== 'boolean'
      || (preparePeer !== null && typeof preparePeer !== 'function')
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
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
    this.timeoutMs = timeoutMs;
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
      associatedVideo: video, active: true, retiring: null, rebind: null, associationRevision: 0 };
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
    for (const source of this.sources.values()) source.rebind?.wake?.();
    const abort = () => {
      void this.removeSource(record.sourceId).catch(error => {
        try { this.onError(error, { shareId: record.shareId }); }
        catch (observerError) { console.error('Native P2P transport error observer failed:', observerError); }
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

  async publish(source, peer, transition = null) {
    if (transition) await waitForSetup(peer.opening, transition.abort.signal);
    else await peer.opening;
    if (!source.active || !peer.active || this.closing) return;
    if (source.kind === 'audio') {
      if (source.rebind && (source.rebind !== transition || !transition.committed)) return;
      const video = source.associatedVideo, revision = source.associationRevision;
      await this.publish(video, peer);
      if (!source.active || !peer.active || this.closing || !video.active || source.associatedVideo !== video
        || source.associationRevision !== revision
        || (source.rebind && (source.rebind !== transition || !transition.committed))) return;
      try {
        await this.broker.publishAudio(source.sourceId, peer.sessionId, {
          maxBitrateBps: source.maxBitrateBps, ...(transition ? { signal: transition.abort.signal } : {}),
        });
      } catch (error) {
        // A publication started under the old association can be cancelled by its
        // rebind; that cancellation must not tear down the peer's video tracks.
        if (source.active && source.associationRevision === revision && !this.closing) throw error;
      }
      return;
    }
    await this.broker.publish(source.sourceId, peer.sessionId, {
      maxBitrateBps: source.maxBitrateBps, maxFramerate: source.maxFramerate,
    });
  }

  assertRebindCurrent(source, transition) {
    if (this.closing || !source.active || source.rebind !== transition || transition.abort.signal.aborted
      || this.sources.get(source.sourceId) !== source || !transition.previousVideo.active
      || this.sources.get(transition.previousVideo.sourceId) !== transition.previousVideo
      || (transition.video && (!transition.video.active
        || this.sources.get(transition.video.sourceId) !== transition.video
        || transition.video.shareId !== transition.shareId || transition.video.syncGroup !== transition.syncGroup))) {
      throw cancelled();
    }
  }

  async rebindVideo(source, transition) {
    while (true) {
      this.assertRebindCurrent(source, transition);
      const video = [...this.sources.values()].find(record => record.kind === 'video' && record.shareId === transition.shareId);
      if (video) {
        transition.video = video;
        this.assertRebindCurrent(source, transition);
        await waitForSetup(video.opening, transition.abort.signal);
        this.assertRebindCurrent(source, transition);
        return video;
      }
      // The Root may reserve the rebind before its target has finished native
      // source creation. Registration wakes this bounded, abortable setup wait.
      try {
        await waitForSetup(new Promise(resolve => { transition.wake = resolve; }), transition.abort.signal);
      } finally { transition.wake = null; }
    }
  }

  async rebindAudioSource(sourceId, { screenAudioShareId, syncGroup } = {}, signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid native P2P rebind signal.');
    signal?.throwIfAborted();
    const source = this.sources.get(sourceId);
    const selected = [...this.sources.values()].find(record => record.kind === 'video' && record.shareId === screenAudioShareId);
    if (this.closing || !this.audioPublicationEnabled || source?.kind !== 'audio' || !source.active || source.rebind
      || !shareIdValid(screenAudioShareId) || !groupValid(syncGroup)
      || (selected && (!selected.active || selected.syncGroup !== syncGroup))
      || typeof this.broker.rebindAudioSource !== 'function') {
      throw new Error('Native P2P audio rebind requires its active source, exact selected video group and broker capability.');
    }
    const transition = { shareId: screenAudioShareId, syncGroup, previousVideo: source.associatedVideo,
      video: selected ?? null, abort: new AbortController(), raw: null, committed: false, wake: null };
    source.rebind = transition;
    source.associationRevision++;
    const abort = () => transition.abort.abort(signal?.reason ?? cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    const raw = Promise.resolve().then(async () => {
      await waitForSetup(source.opening, transition.abort.signal);
      const video = await this.rebindVideo(source, transition);
      this.assertRebindCurrent(source, transition);
      const pending = this.broker.rebindAudioSource(sourceId, {
        screenAudioShareId, syncGroup, signal: transition.abort.signal,
      });
      if (typeof pending?.then !== 'function') throw new Error('Native P2P audio rebind needs the actual broker Promise.');
      const result = await pending;
      this.assertRebindCurrent(source, transition);
      if (result?.sourceId !== sourceId || result.screenAudioShareId !== screenAudioShareId || result.syncGroup !== syncGroup) {
        throw new Error('Native P2P audio rebind acknowledgement does not match the selected source and screen.');
      }
      Object.assign(source, { associatedVideo: video, shareId: screenAudioShareId, screenAudioShareId, syncGroup });
      transition.committed = true;
      const publishedPeers = new Set();
      while (true) {
        this.assertRebindCurrent(source, transition);
        const peers = [...this.peers.values()].filter(peer => peer.active && !publishedPeers.has(peer));
        if (!peers.length) break;
        const published = await Promise.allSettled(peers.map(peer => this.publish(source, peer, transition)));
        const failures = published.flatMap((value, index) => value.status === 'rejected' && peers[index].active ? [value.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Native P2P audio reassociation publication failed.');
        for (const peer of peers) publishedPeers.add(peer);
      }
      source.rebind = null;
      return result;
    });
    transition.raw = raw;
    try {
      return await boundedCleanup(raw, 'Native P2P audio rebind is still pending; ownership is retained.', this.timeoutMs);
    } catch (error) {
      abort();
      try { await this.removeAudioSource(sourceId); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native P2P audio rebind and retirement failed; ownership is retained.');
      }
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
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
      if (this.closing || !peer.active) throw new DOMException('Native P2P peer was retired.', 'AbortError');
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
    source.rebind?.abort.abort(cancelled());
    if (source.kind === 'audio') source.associationRevision++;
    if (!source.retiring) {
      const retiring = Promise.resolve().then(async () => {
        if (source.kind === 'video') {
          // Finish audio's StopStandard turn before withdrawing its associated video.
          const audio = [...this.sources.values()].find(record => record.kind === 'audio'
            && (record.associatedVideo === source || record.rebind?.previousVideo === source
              || record.rebind?.shareId === source.shareId));
          if (audio) await this.removeAudioSource(audio.sourceId);
        }
        if (source.rebind) await this.drainRebinds([source]);
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

  async drainRebinds(sources = [...this.sources.values()]) {
    await boundedCleanup(Promise.allSettled(sources.map(source => source.rebind?.raw).filter(Boolean)),
      'Native P2P audio rebind is still pending; source ownership is retained.', this.timeoutMs);
  }

  async close() {
    this.closing = true;
    for (const source of this.sources.values()) {
      source.active = false;
      source.rebind?.abort.abort(cancelled());
    }
    for (const peer of this.peers.values()) peer.active = false;
    await this.broker.close();
    const opened = await Promise.allSettled([...this.peers.values()].map(peer => peer.opening));
    if (opened.length) await this.broker.close();
    await this.drainRebinds();
    this.peers.clear();
    this.sources.clear();
  }

  async finishAfterEngineClose(closed) {
    this.closing = true;
    for (const source of this.sources.values()) {
      source.active = false;
      source.rebind?.abort.abort(cancelled());
    }
    await this.broker.finishAfterEngineClose(closed);
    await this.drainRebinds();
    this.peers.clear();
    this.sources.clear();
  }
}

module.exports = { NativeP2pTransport };
