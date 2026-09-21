'use strict';

const assert = require('node:assert/strict');
const { assertNativeScreenEndpointLocallyClosed } = require('./nativeEndpoint.cjs');
const { randomUUID } = require('node:crypto');
const {
  getScreenShareProfile, messageReferenceSchema, nativeScreenSignalSchema, nativeScreenSourceSchema,
  screenShareProfileKey,
} = require('@monky/shared');

// Each A/V peer needs a peer and two publications, in addition to shared sources.
// Leave room under the engine's 64-resource ceiling for in-flight retirement.
const MAXIMUM_PROFILE_VIEWERS = 16;
const cancelled = () => new DOMException('The screen subscription was retired.', 'AbortError');
const failureReason = error => error?.code === 'ERR_SCREEN_CAPACITY' ? 'capacity-exceeded'
  : error?.code === 'ERR_RTC_ENCODED_FORMAT' ? 'unsupported'
  : String(error?.code).includes('CAPTURE') ? 'capture-failed' : 'connection-failed';

class NativeScreenPublisher {
  constructor({ sessionId, channelId, mode, source, iceServers, createEndpoint, send, onError, onState, onPreview = null }) {
    messageReferenceSchema.parse(sessionId); messageReferenceSchema.parse(channelId);
    assert.ok(['p2p', 'sfu'].includes(mode));
    for (const observer of [createEndpoint, send, onError, onState]) assert.equal(typeof observer, 'function');
    Object.assign(this, { sessionId, channelId, mode, createEndpoint, send, onError, onState });
    this.onPreview = onPreview;
    this.previewPipeline = null;
    this.source = Object.freeze(nativeScreenSourceSchema.parse(source));
    this.iceServers = structuredClone(iceServers);
    this.viewers = new Map();
    this.pipelines = new Map();
    this.pending = new Set();
    this.generation = 0;
    this.closed = false;
  }

  current(viewer) {
    return !this.closed && !viewer.retiring && this.viewers.get(viewer.sessionId) === viewer;
  }

  observe(error, scope) {
    try { this.onError(error, scope); }
    catch (observerError) { console.error('Native screen publisher error observer failed:', observerError); }
  }

  track(work) {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), error => {
      this.pending.delete(work);
      if (error.name !== 'AbortError') this.observe(error, { shareId: this.source.shareId });
    });
    return work;
  }

  envelope(viewer, data) {
    return nativeScreenSignalSchema.parse({
      fromSessionId: this.sessionId, targetSessionId: viewer.sessionId, publisherSessionId: this.sessionId,
      channelId: this.channelId, shareId: this.source.shareId, sourceInstanceId: this.source.instanceId,
      subscriptionId: viewer.subscriptionId, ...data,
    });
  }

  async signal(viewer, data) {
    if (!this.current(viewer)) throw cancelled();
    await this.send(this.envelope(viewer, data));
  }

  async pipelineFor(viewer) {
    const key = screenShareProfileKey(getScreenShareProfile(this.source.video, viewer.quality));
    const previous = this.pipelines.get(key);
    if (previous?.closing) {
      await previous.closing;
      if (!this.current(viewer)) throw cancelled();
      return this.pipelineFor(viewer);
    }
    if (previous) return this.reserveViewer(previous, viewer);
    assert.ok(this.pipelines.size < 4, 'A screen cannot have more than four distinct video profiles.');
    const pipeline = { key, id: randomUUID(), quality: viewer.quality, viewers: new Map(), endpoint: null, closing: null };
    this.pipelines.set(key, pipeline);
    try {
      pipeline.endpoint = this.createEndpoint({
        source: this.source, quality: viewer.quality, pipelineId: pipeline.id,
        send: async (remoteSessionId, control) => {
          const recipient = pipeline.viewers.get(remoteSessionId);
          // Teardown can emit late metadata, but a retired subscription cannot authorize it.
          if (!recipient || !this.current(recipient)) return;
          await this.signal(recipient, { action: 'control', control });
        },
        onError: (error, context) => {
          if (pipeline.closing) { this.observe(error, { pipelineId: pipeline.id, ...context }); return; }
          queueMicrotask(() => this.track(this.failedPipeline(pipeline, error, context)));
        },
        onState: state => this.onState({ shareId: this.source.shareId, pipelineId: pipeline.id, quality: pipeline.quality, state }),
        onPreview: frame => {
          if (!this.previewPipeline || this.previewPipeline.closing) this.previewPipeline = pipeline;
          if (this.previewPipeline === pipeline && !pipeline.closing && pipeline.viewers.size > 0)
            this.onPreview?.({ frame, pipelineId: pipeline.id, video: getScreenShareProfile(this.source.video, pipeline.quality) });
        },
      });
      assert.ok(pipeline.endpoint && typeof pipeline.endpoint.ready?.then === 'function');
      return this.reserveViewer(pipeline, viewer);
    } catch (error) {
      if (pipeline.endpoint) await this.retirePipeline(pipeline);
      else this.pipelines.delete(key);
      throw error;
    }
  }

  reserveViewer(pipeline, viewer) {
    if (!this.current(viewer)) throw cancelled();
    if (pipeline.viewers.size >= MAXIMUM_PROFILE_VIEWERS)
      throw Object.assign(new Error('The native screen profile has reached its viewer limit.'), { code: 'ERR_SCREEN_CAPACITY' });
    viewer.pipeline = pipeline;
    pipeline.viewers.set(viewer.sessionId, viewer);
    return pipeline;
  }

  watch(value) {
    const request = nativeScreenSignalSchema.parse(value);
    assert.equal(request.action, 'watch');
    this.assertScope(request);
    if (this.closed) return Promise.reject(cancelled());
    const previous = this.viewers.get(request.fromSessionId);
    if (previous?.subscriptionId === request.subscriptionId) {
      assert.equal(previous.quality, request.quality);
      assert.equal(previous.backend, request.backend);
      return previous.setup;
    }
    assert.ok(Number.isSafeInteger(++this.generation), 'The native screen generation was exhausted.');
    const viewer = {
      sessionId: request.fromSessionId, subscriptionId: request.subscriptionId,
      quality: request.quality, backend: request.backend, generation: this.generation,
      pipeline: null, retiring: false, accepted: false, setup: null, retirement: null,
    };
    this.viewers.set(viewer.sessionId, viewer);
    viewer.setup = this.track(this.prepare(viewer, previous));
    return viewer.setup;
  }

  async prepare(viewer, previous) {
    try {
      if (previous) await this.retireViewer(previous);
      if (!this.current(viewer)) throw cancelled();
      const pipeline = await this.pipelineFor(viewer);
      if (!this.current(viewer)) throw cancelled();
      await pipeline.endpoint.ready;
      if (!this.current(viewer)) throw cancelled();
      viewer.accepted = true;
      await this.signal(viewer, { action: 'accepted', quality: viewer.quality, backend: viewer.backend, generation: viewer.generation });
      if (!this.current(viewer)) throw cancelled();
      await pipeline.endpoint.setDemand(pipeline.viewers.size);
      if (!this.current(viewer)) throw cancelled();
      if (this.mode === 'p2p') await pipeline.endpoint.connectPeer(viewer.sessionId, {
        connectionId: viewer.subscriptionId, generation: viewer.generation, iceServers: this.iceServers,
      });
      if (!this.current(viewer)) throw cancelled();
    } catch (error) {
      const errors = [error];
      if (this.current(viewer) && error.name !== 'AbortError') {
        try { await this.signal(viewer, { action: 'closed', reason: failureReason(error) }); }
        catch (signalError) { if (signalError.name !== 'AbortError') errors.push(signalError); }
      }
      try { await this.retireViewer(viewer); }
      catch (cleanupError) { errors.push(cleanupError); }
      if (errors.length === 1 && error.code === 'ERR_SCREEN_CAPACITY') return;
      if (errors.length > 1) throw new AggregateError(errors, 'Screen subscription setup and retirement failed.');
      throw error;
    }
  }

  assertScope(request) {
    assert.equal(request.targetSessionId, this.sessionId);
    assert.equal(request.publisherSessionId, this.sessionId);
    assert.equal(request.channelId, this.channelId);
    assert.equal(request.shareId, this.source.shareId);
    assert.equal(request.sourceInstanceId, this.source.instanceId);
  }

  async receive(value) {
    const request = nativeScreenSignalSchema.parse(value);
    this.assertScope(request);
    assert.ok(['watch', 'stop', 'control'].includes(request.action));
    if (request.action === 'watch') return this.watch(request);
    const viewer = this.viewers.get(request.fromSessionId);
    if (!viewer || viewer.subscriptionId !== request.subscriptionId || !this.current(viewer)) return;
    if (request.action === 'stop') return this.retireViewer(viewer);
    assert.equal(this.mode, 'p2p');
    assert.equal(viewer.accepted, true);
    assert.equal(request.control.generation, viewer.generation);
    return viewer.pipeline.endpoint.receiveControl(viewer.sessionId, request.control);
  }

  retireViewer(viewer) {
    if (viewer.retirement) return viewer.retirement;
    viewer.retiring = true;
    if (this.viewers.get(viewer.sessionId) === viewer) this.viewers.delete(viewer.sessionId);
    const pipeline = viewer.pipeline;
    if (pipeline?.viewers.get(viewer.sessionId) === viewer) pipeline.viewers.delete(viewer.sessionId);
    viewer.retirement = (async () => {
      if (!pipeline) return;
      if (pipeline.viewers.size === 0) return this.retirePipeline(pipeline);
      if (this.mode === 'p2p') await pipeline.endpoint.closePeer(viewer.sessionId);
      if (!pipeline.closing) await pipeline.endpoint.setDemand(pipeline.viewers.size);
    })();
    return viewer.retirement;
  }

  retirePipeline(pipeline) {
    if (pipeline.closing) return pipeline.closing;
    pipeline.closing = (async () => {
      try { await pipeline.endpoint.setDemand(0); }
      finally {
        // A failure cause can coexist with verified closure; never reuse an unretired engine.
        if (pipeline.endpoint.snapshot().closed && this.pipelines.get(pipeline.key) === pipeline)
          this.pipelines.delete(pipeline.key);
        if (this.previewPipeline === pipeline) {
          this.previewPipeline = null;
          this.onPreview?.(null);
        }
      }
      assert.equal(pipeline.endpoint.snapshot().closed, true);
    })();
    return pipeline.closing;
  }

  async failedPipeline(pipeline, error, context) {
    this.observe(error, { pipelineId: pipeline.id, ...context });
    if (!pipeline.endpoint) return;
    let viewers = [...pipeline.viewers.values()];
    if (context?.remoteSessionId) {
      const remote = pipeline.viewers.get(context.remoteSessionId);
      viewers = remote && (context.connectionId === undefined || context.connectionId === remote.subscriptionId)
        && (context.generation === undefined || context.generation === remote.generation) ? [remote] : [];
    }
    const results = await Promise.allSettled(viewers.map(async viewer => {
      try {
        if (this.current(viewer)) await this.signal(viewer, { action: 'closed', reason: failureReason(error) });
      } finally { await this.retireViewer(viewer); }
    }));
    if (pipeline.viewers.size === 0 && !pipeline.closing) await this.retirePipeline(pipeline);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Failed native screen pipeline did not retire cleanly.');
  }

  async setParticipants(sessionIds) {
    assert.ok(Array.isArray(sessionIds) && sessionIds.length <= 1024);
    const participants = new Set(sessionIds.map(id => messageReferenceSchema.parse(id)));
    const results = await Promise.allSettled([...this.viewers.values()]
      .filter(viewer => !participants.has(viewer.sessionId)).map(viewer => this.retireViewer(viewer)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native screen participants did not retire.');
  }

  async close(reason = 'source-unavailable') {
    if (this.closing) return this.closing;
    const viewers = [...this.viewers.values()];
    const notifications = viewers.map(viewer => this.signal(viewer, { action: 'closed', reason }));
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([...notifications, ...viewers.map(viewer => this.retireViewer(viewer))]);
      await Promise.allSettled([...this.pending]);
      const remaining = await Promise.allSettled([...this.pipelines.values()].map(pipeline => this.retirePipeline(pipeline)));
      const errors = [...results, ...remaining].filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native screen publisher reported shutdown failures.');
      assert.equal(this.pipelines.size, 0, 'A screen publisher retained a native pipeline.');
    })();
    return this.closing;
  }

  diagnostics() {
    assert.equal(this.closed, false, 'The screen publisher is retiring.');
    return Promise.all([...this.pipelines.values()].filter(pipeline => pipeline.endpoint && !pipeline.closing)
      .map(pipeline => pipeline.endpoint.diagnostics()));
  }

  snapshot() {
    return {
      source: this.source, stopping: this.closed,
      closed: this.closed && this.pipelines.size === 0 && this.pending.size === 0, viewers: this.viewers.size,
      pipelines: [...this.pipelines.values()].map(pipeline => ({
        pipelineId: pipeline.id, quality: pipeline.quality, viewers: pipeline.viewers.size,
        endpoint: pipeline.endpoint.snapshot(),
      })),
    };
  }

  assertLocallyClosed() {
    assert.equal(this.closed, true, 'The publisher has not started shutdown.');
    assert.equal(this.pending.size, 0, 'The publisher still has pending media operations.');
    for (const pipeline of this.pipelines.values()) {
      if (pipeline.endpoint) assertNativeScreenEndpointLocallyClosed(pipeline.endpoint);
    }
  }
}

module.exports = { NativeScreenPublisher, MAXIMUM_PROFILE_VIEWERS };
