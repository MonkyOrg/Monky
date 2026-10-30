'use strict';

const { isDeepStrictEqual } = require('node:util');
const { isNativeRtcCommandsForEngine, assertNativeRtcEngineClosed } = require('./nativeRtcCommands.cjs');

const RETIRED = Object.freeze({ retired: true });
const positive = value => Number.isSafeInteger(value) && value > 0;
// Completion can win the cancellation race; the original request then still owns its result.
const finished = error => ['NOT_FOUND', 'ERR_RTC_NOT_FOUND', 'ERR_RTC_UNKNOWN_REQUEST'].includes(error?.code)
  || (error?.code === 'ERR_RTC_REQUEST_ID' && error.status === 4);

/**
 * The native command bookkeeping both screen brokers share, one ledger per broker: every command
 * is issued with its real request ID, cancelled only while that exact command is still pending,
 * and every wait on native work ends once the complete close of the engine is proven. Which
 * commands belong to which peer or resource stays in each broker.
 */
class NativeCommandLedger {
  #waiters = new Set();
  #retired = false;

  constructor(engine, commands) {
    if (!isNativeRtcCommandsForEngine(commands, engine) || typeof engine.cancel !== 'function') {
      throw new Error('A native command ledger requires its engine and that engine\'s NativeRtcCommands.');
    }
    Object.defineProperties(this, { engine: { value: engine }, commands: { value: commands } });
  }

  /** Whether the complete close of this engine was proven: no native command result remains owned. */
  get retired() { return this.#retired; }

  /** Waits currently racing the engine-close proof. */
  get waiting() { return this.#waiters.size; }

  /**
   * Issues one command. `id` is its request ID, or null when the registry holds a different
   * command under that ID, which only a replaced request method can cause.
   */
  issue(operation, target, data) {
    const completion = this.commands.request(operation, target, data);
    if (typeof completion?.then !== 'function') throw new Error('A native command did not return its actual Promise.');
    const id = Object.getOwnPropertyDescriptor(completion, 'requestId')?.value;
    const original = positive(id) ? this.commands.getPendingRequest(id) : undefined;
    const correlated = original === null || this.#describes(original, id, operation, target, data);
    return { id: correlated ? id : null, completion };
  }

  /** Cancels a command only while it is still pending; false once it finished (or was never this one). */
  cancel({ id, operation, target, data }) {
    if (!positive(id) || !this.#describes(this.commands.getPendingRequest(id), id, operation, target, data)) return false;
    try { this.engine.cancel(id); }
    catch (error) {
      if (finished(error)) return false;
      throw error;
    }
    return true;
  }

  /** Settles like `promise` as `{ retired: false, value }`, or as `{ retired: true }` once the engine retires. */
  untilRetired(promise) {
    if (this.#retired) {
      void Promise.resolve(promise).catch(() => {});
      return Promise.resolve(RETIRED);
    }
    return new Promise((resolve, reject) => {
      // Retirement wins over a result that has not been delivered yet.
      const wake = () => resolve(RETIRED);
      this.#waiters.add(wake);
      Promise.resolve(promise).then(value => { this.#waiters.delete(wake); resolve({ retired: false, value }); },
        error => { this.#waiters.delete(wake); reject(error); });
    });
  }

  /** Records the private complete-close proof of this engine and ends every wait on it. */
  proveRetired() {
    assertNativeRtcEngineClosed(this.commands, this.engine);
    this.#retired = true;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  #describes(command, id, operation, target, data) {
    return command?.id === id && command.operation === operation && command.target === target
      && isDeepStrictEqual(command.data, data);
  }
}

module.exports = { NativeCommandLedger };
