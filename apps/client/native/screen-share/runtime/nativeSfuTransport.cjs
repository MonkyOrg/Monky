'use strict';

const { isNativeSfuAudioBroker } = require('./nativeSfuBroker.cjs');
const { within } = require('./asyncTools.cjs');
const { NativeScreenTransport, actualPromise } = require('./nativeScreenTransport.cjs');

class NativeSfuTransport extends NativeScreenTransport {
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
    super(broker, onError, { label: 'SFU', audioPublication, maximumBitrateBps: 1000000000, retirementTimeoutMs: timeoutMs });
    this.timeoutMs = timeoutMs;
  }

  registerVideo(record) {
    this.broker.registerSource({ sourceId: record.sourceId, shareId: record.shareId, syncGroup: record.syncGroup,
      ...(record.nativeScreen ? { nativeScreen: record.nativeScreen } : {}) });
  }

  async publishSource(record) {
    if (record.kind === 'audio') {
      await record.associatedVideo.opening;
      if (this.closing || !record.active || !record.associatedVideo.active) throw this.retired();
      return actualPromise(this.broker.publishAudio(record.sourceId, { maxBitrateBps: record.maxBitrateBps }),
        'Native SFU audio publish');
    }
    return actualPromise(this.broker.publish(record.sourceId, {
      maxBitrateBps: record.maxBitrateBps, maxFramerate: record.maxFramerate,
    }), 'Native SFU publish');
  }

  retireSource(record) {
    return actualPromise(record.kind === 'audio' ? this.broker.removeAudioSource(record.sourceId)
      : this.broker.removeSource(record.sourceId), 'Native SFU source retirement');
  }

  // A late publication result settles before its record leaves the transport.
  async settleSources(records) {
    await Promise.allSettled(records.map(record => record.opening));
  }

  async drainSources() {
    await within(Promise.allSettled([...this.sources.values()]
      .flatMap(record => [record.opening, record.retiring]).filter(Boolean)),
    this.timeoutMs, 'Native SFU source work is still pending; ownership is retained.');
  }

  async closeBroker() {
    await actualPromise(this.broker.close(), 'Native SFU call closure');
    await this.drainSources();
  }

  async retireBroker(engineClosePromise) {
    await actualPromise(this.broker.finishAfterEngineClose(engineClosePromise), 'Native SFU engine retirement');
    await this.drainSources();
  }
}

module.exports = { NativeSfuTransport };
