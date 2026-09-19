'use strict';

const assert = require('node:assert/strict');
const { assertNativeScreenEndpointLocallyClosed } = require('./nativeEndpoint.cjs');
const { randomUUID } = require('node:crypto');
const {
  getScreenShareProfile, messageReferenceSchema, nativeScreenRenditionSchema, nativeScreenSignalSchema,
  nativeScreenSourceSchema, screenShareProfileKey, screenShareQualitySchema,
} = require('@monky/shared');
const { within } = require('./nativeDeadline.cjs');

const cancelled = () => new DOMException('The screen subscription was retired.', 'AbortError');
const retiredSubscriptions = new WeakSet();

class NativeScreenSubscription {
  constructor({ sessionId, publisherSessionId, channelId, mode, source, quality, backend = 'native',
    presentationId = randomUUID(), iceServers, createEndpoint, retirePresentation, send, onError, onState }) {
    for (const value of [sessionId, publisherSessionId, channelId]) messageReferenceSchema.parse(value);
    assert.notEqual(sessionId, publisherSessionId);
    assert.ok(['p2p', 'sfu'].includes(mode) && ['native', 'browser'].includes(backend));
    assert.match(presentationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    for (const observer of [createEndpoint, retirePresentation, send, onError, onState]) assert.equal(typeof observer, 'function');
    Object.assign(this, { sessionId, publisherSessionId, channelId, mode, backend, createEndpoint,
      retirePresentation, send, onError, onState });
    this.source = Object.freeze(nativeScreenSourceSchema.parse(source));
    this.quality = screenShareQualitySchema.parse(quality);
    this.profile = getScreenShareProfile(this.source.video, this.quality);
    this.iceServers = structuredClone(iceServers);
    this.subscriptionId = randomUUID();
    this.presentationId = presentationId;
    this.producers = new Map();
    this.endpoint = null;
    this.started = false;
    this.playing = false;
    this.stopping = false;
    this.closed = false;
    this.generation = null;
    this.opening = null;
    this.consuming = null;
  }

  envelope(data) {
    return nativeScreenSignalSchema.parse({
      fromSessionId: this.sessionId, targetSessionId: this.publisherSessionId, publisherSessionId: this.publisherSessionId,
      channelId: this.channelId, shareId: this.source.shareId, sourceInstanceId: this.source.instanceId,
      subscriptionId: this.subscriptionId, ...data,
    });
  }

  observe(state) {
    try { this.onState({ subscriptionId: this.subscriptionId, presentationId: this.presentationId, quality: this.quality, ...state }); }
    catch (error) { this.fail(error); }
  }

  fail(error) {
    if (this.stopping && error.name === 'AbortError') return;
    try { this.onError(error); }
    catch (observerError) { console.error('Native screen subscription error observer failed:', observerError); }
    if (!this.stopping) void this.close().catch(cleanupError => {
      try { this.onError(cleanupError); }
      catch (observerError) { console.error('Native screen subscription cleanup observer failed:', observerError); }
    });
  }

  async start() {
    assert.equal(this.started, false);
    if (this.stopping) throw cancelled();
    this.started = true;
    this.observe({ type: 'connecting' });
    this.timer = setTimeout(() => this.fail(new Error('The native screen did not produce a frame before its startup deadline.')), 30000);
    this.timer.unref?.();
    try { await this.send(this.envelope({ action: 'watch', quality: this.quality, backend: this.backend })); }
    catch (error) { this.fail(error); throw error; }
  }

  async receive(value) {
    const message = nativeScreenSignalSchema.parse(value);
    assert.equal(message.targetSessionId, this.sessionId);
    assert.equal(message.fromSessionId, this.publisherSessionId);
    assert.equal(message.publisherSessionId, this.publisherSessionId);
    assert.equal(message.channelId, this.channelId);
    assert.equal(message.shareId, this.source.shareId);
    assert.equal(message.sourceInstanceId, this.source.instanceId);
    assert.ok(['accepted', 'control', 'closed'].includes(message.action));
    if (this.stopping || message.subscriptionId !== this.subscriptionId) return;
    assert.equal(this.started, true);
    if (message.action === 'closed') {
      this.observe({ type: 'unavailable', reason: message.reason });
      return this.close(false);
    }
    if (message.action === 'accepted') {
      assert.equal(message.quality, this.quality);
      assert.equal(message.backend, this.backend);
      if (this.generation !== null) { assert.equal(message.generation, this.generation); return this.opening; }
      this.generation = message.generation;
      this.opening = this.open();
      void this.opening.catch(error => this.fail(error));
      return this.opening;
    }
    assert.equal(this.mode, 'p2p');
    assert.equal(message.control.generation, this.generation);
    assert.ok(this.endpoint, 'Native control arrived without an accepted subscription.');
    return this.endpoint.receiveControl(this.publisherSessionId, message.control);
  }

  async open() {
    this.endpoint = this.createEndpoint({
      source: this.source, quality: this.quality, pipelineId: randomUUID(), presentationId: this.presentationId,
      send: async (remoteSessionId, control) => {
        assert.equal(remoteSessionId, this.publisherSessionId);
        if (this.stopping) return;
        await this.send(this.envelope({ action: 'control', control }));
      },
      onError: error => this.fail(error),
      onState: state => {
        if (state.type === 'frame' && !this.stopping && !this.playing) {
          this.playing = true;
          clearTimeout(this.timer);
          this.observe({ type: 'playing' });
        }
      },
    });
    await this.endpoint.ready;
    if (this.stopping) throw cancelled();
    if (this.mode === 'p2p') await this.endpoint.connectPeer(this.publisherSessionId, {
      connectionId: this.subscriptionId, generation: this.generation, iceServers: this.iceServers,
    });
    else await this.consumePending();
  }

  async addRemoteProducer(value) {
    assert.equal(this.mode, 'sfu');
    const metadata = nativeScreenRenditionSchema.parse(value.appData?.nativeScreen);
    messageReferenceSchema.parse(value.producerId);
    assert.equal(value.channelId, this.channelId);
    if (this.stopping || value.producerSessionId !== this.publisherSessionId
      || value.appData.shareId !== this.source.shareId || metadata.sourceInstanceId !== this.source.instanceId
      || screenShareProfileKey(metadata.video) !== screenShareProfileKey(this.profile)) return;
    assert.ok(value.kind === 'video' || (this.source.audio && value.kind === 'audio'));
    if (this.producers.has(value.producerId)) return;
    assert.ok(this.producers.size < 8, 'Too many native renditions for the selected screen subscription.');
    this.producers.set(value.producerId, { value: structuredClone(value), started: false });
    if (this.endpoint) {
      await this.endpoint.ready;
      if (!this.stopping) await this.consumePending();
    }
  }

  consumePending() {
    if (this.consuming) return this.consuming.then(() => this.consumePending());
    const work = (async () => {
      while (!this.stopping) {
        const record = [...this.producers.values()]
          .sort((a, b) => Number(a.value.kind === 'audio') - Number(b.value.kind === 'audio'))
          .find(value => !value.started && (value.value.kind === 'video'
            || [...this.producers.values()].some(video => video.started && video.value.kind === 'video'
              && video.value.appData.nativeScreen.pipelineId === value.value.appData.nativeScreen.pipelineId)));
        if (!record) return;
        record.started = true;
        await this.endpoint.addRemoteProducer(record.value);
      }
    })();
    this.consuming = work;
    void work.then(() => { if (this.consuming === work) this.consuming = null; }, error => {
      if (this.consuming === work) this.consuming = null;
      this.fail(error);
    });
    return work;
  }

  async removeRemoteProducer(producerId) {
    messageReferenceSchema.parse(producerId);
    const record = this.producers.get(producerId);
    this.producers.delete(producerId);
    if (record?.started && this.endpoint) await this.endpoint.removeRemoteProducer(producerId);
  }

  async setAudioPreferences(preferences) {
    assert.equal(typeof preferences?.muted, 'boolean');
    assert.ok(Number.isFinite(preferences.volume) && preferences.volume >= 0 && preferences.volume <= 2);
    if (!this.stopping && this.endpoint) await this.endpoint.setAudioPreferences(preferences);
  }

  close(notify = true) {
    if (this.closing) return this.closing;
    this.stopping = true;
    clearTimeout(this.timer);
    this.closing = (async () => {
      const errors = [];
      if (notify && this.started) {
        try { await this.send(this.envelope({ action: 'stop' })); }
        catch (error) { errors.push(error); }
      }
      try { await this.retirePresentation(this.presentationId); }
      catch (error) { errors.push(error); }
      if (this.endpoint) {
        try { await this.endpoint.close(); }
        catch (error) { errors.push(error); }
        if (!this.endpoint.snapshot().closed && errors.length === 0)
          errors.push(new Error('The native screen receiver did not confirm complete retirement.'));
      }
      await within(Promise.allSettled([this.opening, this.consuming]), 15000, 'Screen subscription setup did not retire.');
      retiredSubscriptions.add(this);
      this.producers.clear();
      this.closed = !this.endpoint || this.endpoint.snapshot().closed;
      if (this.closed) this.observe({ type: 'closed' });
      if (errors.length) throw new AggregateError(errors, 'Native screen subscription reported shutdown failures.');
    })();
    void this.closing.catch(() => { if (!this.closed) this.closing = null; });
    return this.closing;
  }

  async diagnostics() {
    assert.equal(this.stopping, false, 'The screen subscription is retiring.');
    return this.endpoint ? [await this.endpoint.diagnostics()] : [];
  }

  snapshot() {
    return {
      subscriptionId: this.subscriptionId, presentationId: this.presentationId, quality: this.quality,
      generation: this.generation, stopping: this.stopping, closed: this.closed,
      endpoint: this.endpoint?.snapshot() ?? null,
    };
  }

  assertLocallyClosed() {
    assert.ok(retiredSubscriptions.has(this), 'The subscription still has pending media operations.');
    if (this.endpoint) assertNativeScreenEndpointLocallyClosed(this.endpoint);
  }
}

module.exports = { NativeScreenSubscription };
