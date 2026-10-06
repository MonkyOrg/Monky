'use strict';

const { isNativeSfuAudioBroker } = require('./nativeSfuBroker.cjs');
const { boundedCleanup } = require('./frameSink.cjs');

const cancelled = () => new DOMException('Native SFU source was retired.', 'AbortError');
const shareIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value);
const groupValid = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0
  && Buffer.byteLength(value, 'utf8') <= 256 && !value.includes('\0');
const actualPromise = (value, operation) => {
  if (typeof value?.then !== 'function') throw new Error(`Native SFU ${operation} must return its actual Promise.`);
  return value;
};

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

class NativeSfuTransport {
  constructor(broker, onError, { audioPublication = false, timeoutMs = 12000 } = {}) {
    if (['registerSource', 'publish', 'removeSource', 'handleNativeEvent', 'close', 'finishAfterEngineClose']
      .some(name => typeof broker?.[name] !== 'function') || typeof onError !== 'function'
      || typeof audioPublication !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
      || (audioPublication && (!isNativeSfuAudioBroker(broker)
        || broker.audioPublicationEnabled !== true
        || ['registerAudioSource', 'publishAudio', 'removeAudioSource', 'rebindAudioSource', 'closeAudioProducer']
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
    try {
      const observed = this.onError(error, Object.freeze({ shareId }));
      if (typeof observed?.then === 'function') void Promise.resolve(observed).catch(observerError => {
        console.error('Native SFU transport error observer failed:', observerError);
      });
    } catch (observerError) { console.error('Native SFU transport error observer failed:', observerError); }
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
      active: true, opening: null, retiring: null, rebind: null, rebinding: null };
    this.broker.registerAudioSource({ sourceId: record.sourceId, screenAudioShareId: record.shareId, syncGroup: record.syncGroup });
    return this.attachSource(record, signal);
  }

  async attachSource(record, signal) {
    this.sources.set(record.sourceId, record);
    record.opening = Promise.resolve().then(async () => {
      if (this.closing || !record.active || record.rebinding) throw cancelled();
      if (record.kind === 'audio') {
        await record.associatedVideo.opening;
        if (this.closing || !record.active || !record.associatedVideo.active || record.rebinding) throw cancelled();
        return actualPromise(this.broker.publishAudio(record.sourceId, { maxBitrateBps: record.maxBitrateBps }), 'audio publish');
      }
      return actualPromise(this.broker.publish(record.sourceId, {
        maxBitrateBps: record.maxBitrateBps, maxFramerate: record.maxFramerate,
      }), 'publish');
    });
    for (const source of this.sources.values()) source.rebind?.wake?.();
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
    record.rebind?.abort.abort(cancelled());
    const usesVideo = audio => audio.kind === 'audio' && (audio.associatedVideo === record
      || audio.rebind?.previousVideo === record || audio.rebind?.shareId === record.shareId);
    if (record.kind === 'video') for (const audio of this.sources.values()) {
      if (usesVideo(audio)) audio.rebind?.abort.abort(cancelled());
    }
    if (!record.retiring) {
      const retiring = Promise.resolve().then(async () => {
        const audio = record.kind === 'video'
          ? [...this.sources.values()].find(usesVideo) : null;
        const audioRetirement = audio ? this.removeAudioSource(audio.sourceId) : null;
        const sourceRetirement = actualPromise(record.kind === 'audio' ? this.broker.removeAudioSource(sourceId) : this.broker.removeSource(sourceId),
          'source retirement');
        if (audioRetirement) {
          const results = await Promise.allSettled([sourceRetirement, audioRetirement]);
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, 'Native SFU associated sources retain independent retirement obligations.');
        } else await sourceRetirement;
        await Promise.allSettled([record.opening, record.rebinding]);
      });
      record.retiring = retiring;
      void retiring.catch(() => { if (record.retiring === retiring) record.retiring = null; });
    }
    await boundedCleanup(record.retiring, 'Native SFU source retirement is still pending; ownership is retained.', this.timeoutMs);
    if (this.sources.get(sourceId) === record) this.sources.delete(sourceId);
  }

  async removeAudioSource(sourceId) {
    const record = this.sources.get(sourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || (record && record.kind !== 'audio')) {
      throw new Error('Native SFU audio retirement requires its own source ID.');
    }
    await this.removeSource(sourceId);
  }

  async rebindAudioSource(sourceId, { screenAudioShareId, syncGroup } = {}, signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid native SFU cancellation signal.');
    signal?.throwIfAborted();
    const record = this.sources.get(sourceId);
    const selected = [...this.sources.values()].find(candidate => candidate.kind === 'video' && candidate.shareId === screenAudioShareId);
    if (this.closing || !this.audioPublicationEnabled || record?.kind !== 'audio' || !record.active || record.rebinding
      || !shareIdValid(screenAudioShareId) || !groupValid(syncGroup)
      || (selected && (!selected.active || selected.syncGroup !== syncGroup))) {
      throw new Error('Native SFU audio rebind needs its own PCM source and explicit active screen.');
    }
    const transition = { shareId: screenAudioShareId, syncGroup, previousVideo: record.associatedVideo,
      video: selected ?? null, abort: new AbortController(), wake: null };
    record.rebind = transition;
    const abort = () => transition.abort.abort(signal?.reason ?? cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    const raw = Promise.resolve().then(async () => {
      await waitForSetup(record.opening, transition.abort.signal);
      const video = await this.rebindVideo(record, transition);
      this.assertRebindCurrent(record, transition);
      const result = await actualPromise(this.broker.rebindAudioSource(sourceId,
        { screenAudioShareId, syncGroup, signal: transition.abort.signal }), 'audio reassociation');
      if (result?.sourceId !== sourceId || result.screenAudioShareId !== screenAudioShareId || result.syncGroup !== syncGroup) {
        throw new Error('Native SFU audio reassociation acknowledgement changed its selected source or group.');
      }
      this.assertRebindCurrent(record, transition);
      record.shareId = screenAudioShareId;
      record.syncGroup = syncGroup;
      record.associatedVideo = video;
      const publication = await actualPromise(this.broker.publishAudio(sourceId,
        { maxBitrateBps: record.maxBitrateBps }, transition.abort.signal), 'replacement audio publication');
      this.assertRebindCurrent(record, transition);
      if (publication?.sourceId !== sourceId || publication.screenAudioShareId !== screenAudioShareId
        || publication.shareId !== screenAudioShareId || publication.syncGroup !== syncGroup
        || publication.kind !== 'audio' || publication.enabled !== false) {
        throw new Error('Native SFU replacement audio publication acknowledgement changed its selected source or group.');
      }
      return publication;
    }).finally(() => {
      record.rebinding = null;
      record.rebind = null;
    });
    // Retirement drains only the raw workflow, never this wrapper that may itself
    // await retirement after failure or timeout.
    record.rebinding = raw;
    try {
      return await boundedCleanup(raw, 'Native SFU audio rebind is still pending; ownership is retained.', this.timeoutMs);
    } catch (error) {
      abort();
      try { await this.removeAudioSource(sourceId); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native SFU audio rebind and retirement failed; ownership is retained.');
      }
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  assertRebindCurrent(record, transition) {
    if (this.closing || !record.active || record.rebind !== transition || transition.abort.signal.aborted
      || this.sources.get(record.sourceId) !== record || !transition.previousVideo.active
      || this.sources.get(transition.previousVideo.sourceId) !== transition.previousVideo
      || (transition.video && (!transition.video.active || this.sources.get(transition.video.sourceId) !== transition.video
        || transition.video.shareId !== transition.shareId || transition.video.syncGroup !== transition.syncGroup))) throw cancelled();
  }

  async rebindVideo(record, transition) {
    while (true) {
      this.assertRebindCurrent(record, transition);
      const video = [...this.sources.values()].find(candidate => candidate.kind === 'video' && candidate.shareId === transition.shareId);
      if (video) {
        transition.video = video;
        this.assertRebindCurrent(record, transition);
        await waitForSetup(video.opening, transition.abort.signal);
        this.assertRebindCurrent(record, transition);
        return video;
      }
      // Root reserves before WGC/native creation registers the selected source.
      try {
        await waitForSetup(new Promise(resolve => { transition.wake = resolve; }), transition.abort.signal);
      } finally { transition.wake = null; }
    }
  }

  async drainSources() {
    await boundedCleanup(Promise.allSettled([...this.sources.values()]
      .flatMap(record => [record.opening, record.rebinding, record.retiring]).filter(Boolean)),
    'Native SFU source work is still pending; ownership is retained.', this.timeoutMs);
  }

  handleEvent(event) { return this.broker.handleNativeEvent(event); }

  async close() {
    this.closing = true;
    for (const record of this.sources.values()) {
      record.active = false;
      record.rebind?.abort.abort(cancelled());
    }
    await actualPromise(this.broker.close(), 'call closure');
    await this.drainSources();
    this.sources.clear();
  }

  async finishAfterEngineClose(realClosePromise) {
    this.closing = true;
    for (const record of this.sources.values()) {
      record.active = false;
      record.rebind?.abort.abort(cancelled());
    }
    await actualPromise(this.broker.finishAfterEngineClose(realClosePromise), 'engine retirement');
    await this.drainSources();
    this.sources.clear();
  }
}

module.exports = { NativeSfuTransport };
