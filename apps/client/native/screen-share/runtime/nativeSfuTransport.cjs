'use strict';

const { isNativeSfuAudioBroker } = require('./nativeSfuBroker.cjs');
const { within, notifyObserver } = require('./asyncTools.cjs');

const cancelled = () => new DOMException('Native SFU source was retired.', 'AbortError');
const actualPromise = (value, operation) => {
  if (typeof value?.then !== 'function') throw new Error(`Native SFU ${operation} must return its actual Promise.`);
  return value;
};

class NativeSfuTransport {
  constructor(broker, onError, { audioPublication = false, timeoutMs = 12000 } = {}) {
    if (['registerSource', 'publish', 'removeSource', 'handleNativeEvent', 'close', 'finishAfterEngineClose']
      .some(name => typeof broker?.[name] !== 'function') || typeof onError !== 'function'
      || typeof audioPublication !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
      || (audioPublication && (!isNativeSfuAudioBroker(broker)
        || broker.audioPublicationEnabled !== true
        || ['registerAudioSource', 'publishAudio', 'removeAudioSource']
          .some(name => typeof broker[name] !== 'function')))) {
      throw new Error('A complete native SFU broker and error observer are required.');
    }
    this.broker = broker;
    this.onError = onError;
    this.sources = new Map();
    this.closing = false;
    this.timeoutMs = timeoutMs;
    Object.defineProperty(this, 'audioPublicationEnabled', { value: audioPublication, enumerable: true });
  }

  report(error, shareId) {
    notifyObserver('Native SFU transport error observer', this.onError, error, Object.freeze({ shareId }));
  }

  async addSource(source, signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid native SFU cancellation signal.');
    signal?.throwIfAborted();
    if (this.closing || !Number.isSafeInteger(source?.sourceId) || source.sourceId < 1
      || typeof source.shareId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(source.shareId)
      || typeof source.syncGroup !== 'string' || !source.syncGroup || source.syncGroup.includes('\0')
      || Buffer.byteLength(source.syncGroup, 'utf8') > 256
      || !Number.isInteger(source.maxFramerate) || source.maxFramerate < 1 || source.maxFramerate > 240
      || !Number.isSafeInteger(source.maxBitrateBps) || source.maxBitrateBps < 1 || source.maxBitrateBps > 1000000000
      || (source.kind !== undefined && source.kind !== 'video')
      || (source.mediaType !== undefined && source.mediaType !== 'screen_video')
      || this.sources.has(source.sourceId)) throw new Error('Native SFU screen source is invalid, retained or closed.');
    const record = { sourceId: source.sourceId, shareId: source.shareId, syncGroup: source.syncGroup, kind: 'video',
      ...(source.nativeScreen ? { nativeScreen: source.nativeScreen } : {}),
      maxFramerate: source.maxFramerate, maxBitrateBps: source.maxBitrateBps, active: true, opening: null, retiring: null };
    this.broker.registerSource({ sourceId: record.sourceId, shareId: record.shareId, syncGroup: record.syncGroup,
      ...(record.nativeScreen ? { nativeScreen: record.nativeScreen } : {}) });
    return this.attachSource(record, signal);
  }

  async addAudioSource(source, signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid native SFU cancellation signal.');
    signal?.throwIfAborted();
    const video = [...this.sources.values()].find(record => record.kind === 'video' && record.active
      && record.shareId === source?.screenAudioShareId && record.syncGroup === source?.syncGroup);
    if (this.closing || !this.audioPublicationEnabled || !video || !Number.isSafeInteger(source?.sourceId) || source.sourceId < 1
      || this.sources.has(source.sourceId) || [...this.sources.values()].some(record => record.kind === 'audio')
      || source.maxFramerate !== undefined || (source.kind !== undefined && source.kind !== 'audio')
      || (source.mediaType !== undefined && source.mediaType !== 'screen_audio')
      || !Number.isSafeInteger(source.maxBitrateBps) || source.maxBitrateBps < 6000 || source.maxBitrateBps > 510000) {
      throw new Error('Native SFU audio needs its explicit active screen, bitrate and configured A/V broker.');
    }
    const record = { sourceId: source.sourceId, shareId: source.screenAudioShareId, syncGroup: source.syncGroup,
      kind: 'audio', associatedVideo: video, maxBitrateBps: source.maxBitrateBps,
      active: true, opening: null, retiring: null };
    this.broker.registerAudioSource({ sourceId: record.sourceId, screenAudioShareId: record.shareId, syncGroup: record.syncGroup });
    return this.attachSource(record, signal);
  }

  async attachSource(record, signal) {
    this.sources.set(record.sourceId, record);
    record.opening = Promise.resolve().then(async () => {
      if (this.closing || !record.active) throw cancelled();
      if (record.kind === 'audio') {
        await record.associatedVideo.opening;
        if (this.closing || !record.active || !record.associatedVideo.active) throw cancelled();
        return actualPromise(this.broker.publishAudio(record.sourceId, { maxBitrateBps: record.maxBitrateBps }), 'audio publish');
      }
      return actualPromise(this.broker.publish(record.sourceId, {
        maxBitrateBps: record.maxBitrateBps, maxFramerate: record.maxFramerate,
      }), 'publish');
    });
    const abort = () => {
      void this.removeSource(record.sourceId).catch(error => this.report(error, record.shareId));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const result = await record.opening;
      signal?.throwIfAborted();
      if (this.closing || !record.active) throw cancelled();
      return result;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  async removeSource(sourceId) {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw new Error('Invalid native SFU source ID.');
    const record = this.sources.get(sourceId);
    if (!record) return;
    record.active = false;
    if (!record.retiring) {
      const retiring = Promise.resolve().then(async () => {
        const audio = record.kind === 'video' ? [...this.sources.values()]
          .find(candidate => candidate.kind === 'audio' && candidate.associatedVideo === record) : null;
        const audioRetirement = audio ? this.removeAudioSource(audio.sourceId) : null;
        const sourceRetirement = actualPromise(record.kind === 'audio' ? this.broker.removeAudioSource(sourceId) : this.broker.removeSource(sourceId),
          'source retirement');
        if (audioRetirement) {
          const results = await Promise.allSettled([sourceRetirement, audioRetirement]);
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, 'Native SFU associated sources retain independent retirement obligations.');
        } else await sourceRetirement;
        await Promise.allSettled([record.opening]);
      });
      record.retiring = retiring;
      void retiring.catch(() => { if (record.retiring === retiring) record.retiring = null; });
    }
    await within(record.retiring, this.timeoutMs, 'Native SFU source retirement is still pending; ownership is retained.');
    if (this.sources.get(sourceId) === record) this.sources.delete(sourceId);
  }

  async removeAudioSource(sourceId) {
    const record = this.sources.get(sourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || (record && record.kind !== 'audio')) {
      throw new Error('Native SFU audio retirement requires its own source ID.');
    }
    await this.removeSource(sourceId);
  }

  async drainSources() {
    await within(Promise.allSettled([...this.sources.values()]
      .flatMap(record => [record.opening, record.retiring]).filter(Boolean)),
    this.timeoutMs, 'Native SFU source work is still pending; ownership is retained.');
  }

  handleEvent(event) { return this.broker.handleNativeEvent(event); }

  async close() {
    this.closing = true;
    for (const record of this.sources.values()) record.active = false;
    await actualPromise(this.broker.close(), 'call closure');
    await this.drainSources();
    this.sources.clear();
  }

  async finishAfterEngineClose(realClosePromise) {
    this.closing = true;
    for (const record of this.sources.values()) record.active = false;
    await actualPromise(this.broker.finishAfterEngineClose(realClosePromise), 'engine retirement');
    await this.drainSources();
    this.sources.clear();
  }
}

module.exports = { NativeSfuTransport };
