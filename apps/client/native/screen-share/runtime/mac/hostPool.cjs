'use strict';

const assert = require('node:assert/strict');
const { MacNativeHost, failure } = require('./host.cjs');
const { within } = require('../nativeDeadline.cjs');
const entries = new Map();
const mediaMethods = new Set(['media.start', 'media.stop', 'media.stats', 'media.bitrate', 'media.keyframe']);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};

function createEntry(filename, previous) {
  const entry = { filename, clients: new Set(), sequence: 0, host: null, closing: null };
  entry.ready = (async () => {
    if (previous?.closing) {
      try { await previous.closing; }
      catch (error) {
        if (!previous.host?.exited) throw error;
        console.warn('[MacNativeHost] Replacing a retired failed helper:', error.code ?? error.name);
      }
    }
    entry.host = new MacNativeHost(filename, { multiplexed: true, onError: error => {
      for (const client of entry.clients) {
        try { client.onError(error); }
        catch (observerError) { console.error('[MacNativeHost] Client failure observer threw:', observerError); }
      }
    } });
    await entry.host.ready;
  })();
  void entry.ready.catch(() => {});
  entries.set(filename, entry);
  return entry;
}

class MacHostLease {
  constructor(entry, options) {
    this.entry = entry;
    this.onError = options.onError ?? (error => console.error('[MacNativeHost]', error.code));
    this.pending = new Set();
    entry.clients.add(this);
    this.ready = entry.ready.then(() => {
      if (options.onVideo) {
        assert.ok(Number.isSafeInteger(++entry.sequence));
        this.captureId = entry.sequence;
        this.session = { child: entry.host.child, onVideo: options.onVideo, onError: error => this.fail(error),
          mediaSequence: 0, finished: deferred() };
        entry.host.sessions.set(this.captureId, this.session);
      }
    });
    void this.ready.catch(() => {});
  }
  get child() { return this.entry.host?.child; }
  get exited() { return this.entry.host?.exited === true; }
  get failure() { return this.localFailure ?? this.entry.host?.failure; }
  get forcedTermination() { return this.exited && !!this.entry.host?.failure; }
  get mediaSequence() { return this.session?.mediaSequence ?? 0; }
  get lastVideoTimestamp() { return this.session?.lastVideoTimestamp; }
  fail(error) {
    if (this.localFailure) return;
    this.localFailure = error;
    try { this.onError(error); }
    catch (observerError) { console.error('[MacNativeHost] Client failure observer threw:', observerError); }
    void this.close().catch(retirementError => {
      console.error('[MacNativeHost] Failed to retire a cancelled owner:', retirementError);
    });
  }
  resumeVideo() { this.entry.host?.resumeVideo(); }
  request(method, data = {}, signal) {
    if (this.closing) return Promise.reject(new DOMException('Native macOS owner is closing.', 'AbortError'));
    const operation = this.ready.then(() => {
      signal?.throwIfAborted();
      if (this.closing) throw new DOMException('Native macOS owner is closing.', 'AbortError');
      if (mediaMethods.has(method)) {
        assert.ok(this.session, 'Media commands require an owned capture session.');
        data = { ...data, captureId: this.captureId };
      }
      return this.entry.host.request(method, data, signal);
    });
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.retire();
    return this.closing;
  }
  async retire() {
    let error;
    try {
      await this.ready;
      if (this.session) {
        this.session.discardVideo = true;
        this.resumeVideo();
      }
      await Promise.allSettled([...this.pending]);
      const host = this.entry.host;
      if (this.session?.started && !host.exited) {
        const { value } = await host.request('media.stop', { captureId: this.captureId });
        assert.equal(value.nativeClosed, true);
        assert.equal(value.writerClosed, true);
        await within(this.session.finished.promise, 15000, 'Native media did not drain its scoped output.');
      }
      host.sessions.delete(this.captureId);
      this.nativeClosed = true;
    } catch (failure) {
      error = failure;
      const host = this.entry.host;
      if (host && !host.exited) { host.fail(failure); await host.exit.promise; }
      if (host?.exited) {
        host.sessions.delete(this.captureId);
        this.nativeClosed = true;
      }
    }
    const entry = this.entry;
    entry.clients.delete(this);
    if (!entry.clients.size) {
      entry.closing = entry.host ? entry.host.close() : entry.ready;
      try { await entry.closing; }
      catch (failure) { error ??= failure; }
      if (entries.get(entry.filename) === entry) entries.delete(entry.filename);
    }
    if (error) throw error;
    assert.equal(this.nativeClosed, true);
    return { nativeClosed: true, hostExited: this.exited };
  }
}

function acquireMacHost(filename, options = {}) {
  let entry = entries.get(filename);
  if (!entry || entry.closing) entry = createEntry(filename, entry);
  if (entry.host?.exited)
    throw entry.host.failure ?? failure('ERR_MAC_HOST_EXIT', 'The failed native helper still has active owners.');
  return new MacHostLease(entry, options);
}

module.exports = { acquireMacHost };
