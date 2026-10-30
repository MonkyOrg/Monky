'use strict';

const { within, notifyObserver } = require('./asyncTools.cjs');

const SHARE_ID = /^[A-Za-z0-9_.-]{1,64}$/u;

/** A synchronous success-shaped broker result proves no asynchronous publication or retirement. */
function actualPromise(value, description) {
  if (typeof value?.then !== 'function') throw new Error(`${description} must return its actual Promise.`);
  return value;
}

/**
 * What the P2P and SFU screen transports share: one screen video and at most one audio
 * associated with it, each registered with the broker, published by the subclass and retired
 * through its AbortSignal or removeSource(). Retiring a video retires its audio first, since P2P
 * must finish the audio's StopStandard turn before withdrawing the video.
 *
 * Subclasses implement registerVideo(record), publishSource(record, signal), retireSource(record),
 * closeBroker() and retireBroker(engineClosePromise), and may override settleSources(records).
 */
class NativeScreenTransport {
  constructor(broker, onError, { label, audioPublication, maximumBitrateBps, retirementTimeoutMs = null }) {
    Object.defineProperties(this, {
      label: { value: label },
      audioPublicationEnabled: { value: audioPublication, enumerable: true },
    });
    this.broker = broker;
    this.onError = onError;
    this.maximumBitrateBps = maximumBitrateBps;
    this.retirementTimeoutMs = retirementTimeoutMs;
    this.sources = new Map();
    this.closing = false;
  }

  retired() { return new DOMException(`Native ${this.label} source was retired.`, 'AbortError'); }

  report(error, shareId) {
    notifyObserver(`Native ${this.label} transport error observer`, this.onError, error, Object.freeze({ shareId }));
  }

  checkSignal(signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error(`Invalid native ${this.label} cancellation signal.`);
    signal?.throwIfAborted();
  }

  async addSource(source, signal) {
    this.checkSignal(signal);
    if (this.closing || !Number.isSafeInteger(source?.sourceId) || source.sourceId < 1
      || typeof source.shareId !== 'string' || !SHARE_ID.test(source.shareId)
      || typeof source.syncGroup !== 'string' || !source.syncGroup || source.syncGroup.includes('\0')
      || Buffer.byteLength(source.syncGroup, 'utf8') > 256
      || !Number.isInteger(source.maxFramerate) || source.maxFramerate < 1 || source.maxFramerate > 240
      || !Number.isSafeInteger(source.maxBitrateBps) || source.maxBitrateBps < 1 || source.maxBitrateBps > this.maximumBitrateBps
      || (source.kind !== undefined && source.kind !== 'video')
      || (source.mediaType !== undefined && source.mediaType !== 'screen_video')
      || this.sources.has(source.sourceId)) throw new Error(`Native ${this.label} screen source is invalid, retained or closed.`);
    const record = { sourceId: source.sourceId, shareId: source.shareId, syncGroup: source.syncGroup, kind: 'video',
      ...(source.nativeScreen ? { nativeScreen: source.nativeScreen } : {}),
      maxFramerate: source.maxFramerate, maxBitrateBps: source.maxBitrateBps, active: true, opening: null, retiring: null };
    this.registerVideo(record);
    return this.attachSource(record, signal);
  }

  async addAudioSource(source, signal) {
    this.checkSignal(signal);
    const video = [...this.sources.values()].find(record => record.kind === 'video' && record.active
      && record.shareId === source?.screenAudioShareId && record.syncGroup === source?.syncGroup);
    if (this.closing || !this.audioPublicationEnabled || !video || !Number.isSafeInteger(source?.sourceId) || source.sourceId < 1
      || this.sources.has(source.sourceId) || [...this.sources.values()].some(record => record.kind === 'audio')
      || source.maxFramerate !== undefined || (source.kind !== undefined && source.kind !== 'audio')
      || (source.mediaType !== undefined && source.mediaType !== 'screen_audio')
      || !Number.isSafeInteger(source.maxBitrateBps) || source.maxBitrateBps < 6000 || source.maxBitrateBps > 510000) {
      throw new Error(`Native ${this.label} audio needs its explicit active screen, bitrate and configured A/V broker.`);
    }
    const record = { sourceId: source.sourceId, shareId: source.screenAudioShareId, syncGroup: source.syncGroup,
      kind: 'audio', associatedVideo: video, maxBitrateBps: source.maxBitrateBps,
      active: true, opening: null, retiring: null };
    this.broker.registerAudioSource({ sourceId: record.sourceId, screenAudioShareId: record.shareId, syncGroup: record.syncGroup });
    return this.attachSource(record, signal);
  }

  async attachSource(record, signal) {
    this.sources.set(record.sourceId, record);
    record.opening = Promise.resolve().then(() => {
      if (this.closing || !record.active) throw this.retired();
      return this.publishSource(record, signal);
    });
    // Abort starts the retirement at once; the opening keeps owning a possible late publication.
    const abort = () => {
      void this.removeSource(record.sourceId).catch(error => this.report(error, record.shareId));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const result = await record.opening;
      signal?.throwIfAborted();
      if (this.closing || !record.active) throw this.retired();
      return result;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  async removeSource(sourceId) {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw new Error(`Invalid native ${this.label} source ID.`);
    const record = this.sources.get(sourceId);
    if (!record) return;
    const records = [this.associatedAudio(record), record].filter(Boolean);
    for (const retired of records) retired.active = false;
    // Openings settle only after every broker removal started: an audio opening waits for its video's.
    const retirement = this.retirement(record).then(() => this.settleSources(records));
    await (this.retirementTimeoutMs === null ? retirement : within(retirement, this.retirementTimeoutMs,
      `Native ${this.label} source retirement is still pending; ownership is retained.`));
    for (const retired of records) if (this.sources.get(retired.sourceId) === retired) this.sources.delete(retired.sourceId);
  }

  associatedAudio(record) {
    return record.kind === 'video' ? [...this.sources.values()]
      .find(candidate => candidate.kind === 'audio' && candidate.associatedVideo === record) ?? null : null;
  }

  /** Retires `record` through the broker once, its audio first; a failure lets the next removal retry. */
  retirement(record) {
    if (!record.retiring) {
      const retiring = Promise.resolve().then(async () => {
        const audio = this.associatedAudio(record);
        if (audio) await this.retirement(audio);
        await this.retireSource(record);
      });
      record.retiring = retiring;
      void retiring.catch(() => { if (record.retiring === retiring) record.retiring = null; });
    }
    return record.retiring;
  }

  /** What removal still waits for after the broker retired `records`; nothing by default. */
  async settleSources() {}

  async removeAudioSource(sourceId) {
    const record = this.sources.get(sourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || (record && record.kind !== 'audio')) {
      throw new Error(`Native ${this.label} audio retirement requires its own source ID.`);
    }
    await this.removeSource(sourceId);
  }

  handleEvent(event) { return this.broker.handleNativeEvent(event); }

  async close() {
    this.closing = true;
    for (const record of this.sources.values()) record.active = false;
    await this.closeBroker();
    this.sources.clear();
  }

  async finishAfterEngineClose(engineClosePromise) {
    this.closing = true;
    for (const record of this.sources.values()) record.active = false;
    await this.retireBroker(engineClosePromise);
    this.sources.clear();
  }
}

module.exports = { NativeScreenTransport, actualPromise };
