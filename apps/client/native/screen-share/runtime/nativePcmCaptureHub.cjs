'use strict';

const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { within } = require('./nativeDeadline.cjs');

const cancelled = () => new DOMException('The native PCM subscription was detached.', 'AbortError');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};

class NativePcmCaptureHub {
  #module;
  #selection;
  #onError;
  #current = null;
  #subscriptions = new Set();
  #closed = false;
  #starts = 0;

  constructor(captureModule, selection, onError) {
    assert.equal(typeof captureModule?.createPacketCapture, 'function');
    assert.equal(typeof onError, 'function');
    assert.ok(selection && typeof selection === 'object' && !Array.isArray(selection));
    assert.ok(Object.keys(selection).every(key => ['includeWindowId', 'excludePid', 'expectedProcessId'].includes(key)));
    assert.ok(selection.excludePid === undefined || selection.excludePid === process.pid);
    assert.ok(selection.includeWindowId === undefined
      || (Number.isSafeInteger(selection.includeWindowId) && selection.includeWindowId > 0));
    assert.ok(selection.expectedProcessId === undefined || (selection.includeWindowId !== undefined
      && Number.isSafeInteger(selection.expectedProcessId) && selection.expectedProcessId > 0
      && selection.expectedProcessId <= 0xffffffff));
    this.#module = captureModule;
    this.#selection = Object.freeze({ ...selection });
    this.#onError = onError;
  }

  static matches(hub, captureModule, selection) {
    return hub !== null && typeof hub === 'object' && #module in hub
      && hub.#module === captureModule && isDeepStrictEqual(hub.#selection, selection);
  }

  #report(error) {
    try { this.#onError(error); }
    catch (observerError) { console.error('Native PCM capture owner error observer failed:', observerError); }
  }

  #event(owner, event) {
    if (event?.type === 'ready') {
      assert.equal(owner.readyEvent, null, 'The native PCM capture emitted duplicate readiness.');
      owner.readyEvent = event;
    } else assert.ok(['packet', 'error', 'closed'].includes(event?.type), 'Unknown native PCM capture event.');
    for (const subscription of owner.members) {
      if (!subscription.stopping) subscription.onEvent(event);
    }
  }

  #open() {
    const owner = { handle: null, members: new Set(), readyEvent: null, stopping: null, retired: false };
    this.#current = owner;
    try {
      owner.handle = this.#module.createPacketCapture({ ...this.#selection }, event => {
        try { this.#event(owner, event); }
        catch (error) {
          this.#report(error);
          void this.#stopOwner(owner).catch(cleanupError => this.#report(cleanupError));
        }
      });
      assert.equal(typeof owner.handle?.ready?.then, 'function');
      assert.equal(typeof owner.handle?.closed?.then, 'function');
      assert.equal(typeof owner.handle?.stop, 'function');
      assert.equal(typeof owner.handle?.getStats, 'function');
      this.#starts++;
      void owner.handle.ready.catch(error => this.#report(error));
      void owner.handle.closed.then(() => {
        owner.retired = true;
        if (!owner.stopping && owner.members.size) this.#report(new Error('Native PCM capture retired while subscribers were active.'));
      }, error => this.#report(error));
      return owner;
    } catch (error) {
      if (!owner.handle) { owner.retired = true; this.#current = null; }
      else void this.#stopOwner(owner).catch(cleanupError => this.#report(cleanupError));
      throw error;
    }
  }

  #stopOwner(owner) {
    if (owner.stopping) return owner.stopping;
    const stopping = (async () => {
      await owner.handle.stop();
      await owner.handle.closed;
      owner.retired = true;
    })();
    owner.stopping = stopping;
    void stopping.catch(() => { if (!owner.retired && owner.stopping === stopping) owner.stopping = null; });
    return stopping;
  }

  subscribe(selection, onEvent) {
    assert.equal(this.#closed, false, 'The PCM owner is closed.');
    assert.equal(isDeepStrictEqual(this.#selection, selection), true, 'A PCM subscriber cannot replace the selected process.');
    assert.equal(typeof onEvent, 'function');
    assert.ok(this.#subscriptions.size < 4, 'A PCM source supports at most four simultaneous video renditions.');
    const subscription = { owner: null, onEvent, stopping: false, retirement: null, detached: deferred() };
    this.#subscriptions.add(subscription);
    const ready = (async () => {
      const previous = this.#current;
      if (previous?.stopping) await previous.stopping;
      if (this.#closed || subscription.stopping) throw cancelled();
      const owner = !this.#current || this.#current.retired ? this.#open() : this.#current;
      subscription.owner = owner;
      owner.members.add(subscription);
      if (owner.readyEvent) onEvent(owner.readyEvent);
      return owner.handle.ready;
    })();
    void ready.catch(() => {});
    const detach = () => {
      if (subscription.retirement) return subscription.retirement;
      subscription.stopping = true;
      const retiring = (async () => {
        // Capture readiness can be pending; detaching the final subscriber must
        // cancel the actual capture rather than wait for readiness first.
        const owner = subscription.owner;
        owner?.members.delete(subscription);
        if (owner && owner.members.size === 0) await this.#stopOwner(owner);
        this.#subscriptions.delete(subscription);
        subscription.detached.resolve();
      })();
      subscription.retirement = retiring;
      void retiring.catch(error => {
        subscription.retirement = null;
        this.#report(error);
      });
      return retiring;
    };
    subscription.detach = detach;
    return Object.freeze({
      kind: 'native-pcm-subscription',
      ready,
      detached: subscription.detached.promise,
      detach,
      getStats: () => ({
        kind: 'native-pcm-subscription', detached: !this.#subscriptions.has(subscription),
        captureClosed: subscription.owner?.retired ?? false,
        capture: subscription.owner?.handle?.getStats() ?? null,
      }),
    });
  }

  async close() {
    this.#closed = true;
    const results = await Promise.allSettled([...this.#subscriptions].map(subscription => subscription.detach()));
    if (this.#current && !this.#current.retired)
      results.push(...await Promise.allSettled([this.#stopOwner(this.#current)]));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native PCM capture ownership did not retire.');
    assert.equal(this.#subscriptions.size, 0);
  }

  async waitUntilIdle() {
    if (this.#current?.stopping) await within(this.#current.stopping, 12000, 'Native PCM capture retirement remains pending.');
    assert.equal(this.#subscriptions.size, 0);
    assert.ok(!this.#current || this.#current.retired);
  }

  getStats() {
    return {
      kind: 'native-pcm-capture-owner', captureStarts: this.#starts, subscriptions: this.#subscriptions.size,
      captureClosed: this.#current?.retired ?? true,
      capture: this.#current?.handle?.getStats() ?? null,
      closed: this.#closed && this.#subscriptions.size === 0 && (!this.#current || this.#current.retired),
    };
  }
}

module.exports = { NativePcmCaptureHub };
