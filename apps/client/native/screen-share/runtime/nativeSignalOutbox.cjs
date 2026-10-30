'use strict';

const assert = require('node:assert/strict');

const fault = (code, message) => Object.assign(new Error(message), { code });
const sameScope = (failure, control) => failure.connectionId === control.connectionId
  && failure.generation === control.generation;

/**
 * Native screen CONTROL handed to the app's signaling carrier, whose Promise settles only when the
 * server acknowledged the message. The P2P broker requires send() to resolve on FIFO enqueue instead:
 * waiting for the acknowledgement held the pair's queue for a full round trip per message, and a
 * received answer behind every local ICE candidate. Each message goes to the carrier at once and in
 * order (the carrier dispatches it to the server synchronously, FIFO); at most `maximumInFlight`
 * await their acknowledgement, and later ones wait for a free slot.
 *
 * A delivery that fails or is not acknowledged in time fails only its pair, as a rejected send did:
 * the error is reported with the pair's scope, and later messages to that same pair are refused with
 * it, so the broker retires the pair as well.
 */
class NativeSignalOutbox {
  constructor({ carrier, onFailure, isCurrent, maximumInFlight = 16, timeoutMs = 12000,
    timers = { setTimeout, clearTimeout } }) {
    for (const callback of [carrier, onFailure, isCurrent]) assert.equal(typeof callback, 'function');
    assert.ok(Number.isSafeInteger(maximumInFlight) && maximumInFlight > 0);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
    Object.assign(this, { carrier, onFailure, isCurrent, maximumInFlight, timeoutMs, timers });
    this.waiting = [];
    this.inFlight = new Set();
    this.failures = new Map();
    this.closed = false;
  }

  send(remoteSessionId, control) {
    if (this.closed) return Promise.reject(fault('P2P_CANCELLED', 'Native screen signaling is closed.'));
    const failure = this.failures.get(remoteSessionId);
    if (failure && sameScope(failure, control)) return Promise.reject(failure.error);
    if (failure) this.failures.delete(remoteSessionId);
    if (!this.waiting.length && this.inFlight.size < this.maximumInFlight) {
      this.dispatch(remoteSessionId, control);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ remoteSessionId, control, resolve, reject });
    });
  }

  dispatch(remoteSessionId, control) {
    let delivery;
    try { delivery = Promise.resolve(this.carrier(remoteSessionId, control)); }
    catch (error) { delivery = Promise.reject(error); }
    const record = {};
    const settle = error => {
      if (!this.inFlight.delete(record)) return;
      this.timers.clearTimeout(record.timer);
      if (error) this.fail(remoteSessionId, control, error);
      this.pump();
    };
    this.inFlight.add(record);
    record.timer = this.timers.setTimeout(() => settle(fault('P2P_TIMEOUT',
      'Native signaling delivery was not acknowledged in time.')), this.timeoutMs);
    void delivery.then(() => settle(null),
      error => settle(error instanceof Error ? error : new Error(String(error))));
  }

  pump() {
    while (!this.closed && this.waiting.length && this.inFlight.size < this.maximumInFlight) {
      const item = this.waiting.shift(), failure = this.failures.get(item.remoteSessionId);
      if (failure && sameScope(failure, item.control)) item.reject(failure.error);
      // The broker checked its pair when it enqueued; one that waited for a slot may be gone since.
      else if (!this.isCurrent(item.remoteSessionId, item.control))
        item.reject(fault('P2P_CANCELLED', 'Native screen peer is no longer current.'));
      else {
        this.dispatch(item.remoteSessionId, item.control);
        item.resolve();
      }
    }
  }

  fail(remoteSessionId, control, error) {
    const previous = this.failures.get(remoteSessionId);
    if (previous && sameScope(previous, control)) return;
    this.failures.set(remoteSessionId, { connectionId: control.connectionId, generation: control.generation, error });
    this.onFailure(error, { callId: control.callId, channelId: control.channelId, remoteSessionId,
      connectionId: control.connectionId, generation: control.generation });
  }

  /** Abandons unacknowledged deliveries and refuses queued and later messages. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.inFlight) this.timers.clearTimeout(record.timer);
    this.inFlight.clear();
    const cancelled = fault('P2P_CANCELLED', 'Native screen signaling is closed.');
    for (const item of this.waiting.splice(0)) item.reject(cancelled);
  }
}

module.exports = { NativeSignalOutbox };
