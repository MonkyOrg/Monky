'use strict';

class NativeRtcCommands {
  #engine;
  #closed = false;
  #closing = null;

  constructor(engine) {
    if (typeof engine?.request !== 'function') throw new Error('Native RTC command API is unavailable.');
    this.#engine = engine;
    this.nextId = 1;
    this.pending = new Map();
  }

  static isForEngine(commands, engine) {
    return commands !== null && typeof commands === 'object' && #engine in commands && commands.#engine === engine;
  }

  get engine() { return this.#engine; }

  request(operation, target, data) {
    if (!Number.isSafeInteger(this.nextId)) throw new Error('Native RTC request identifiers are exhausted.');
    const id = this.nextId++;
    const command = { id, operation, target, data: structuredClone(data) };
    this.pending.set(id, command);
    let result;
    try {
      result = this.#engine.request(id, operation, target, command.data);
      if (!result || typeof result.then !== 'function') throw new Error('Native RTC request did not return a Promise.');
    } catch (error) {
      this.pending.delete(id);
      return Promise.reject(error);
    }
    const pending = Promise.resolve(result).then(
      value => { this.pending.delete(id); return value; },
      error => { this.pending.delete(id); throw error; },
    );
    return pending;
  }

  getPendingRequest(id) {
    const command = this.pending.get(id);
    return command ? structuredClone(command) : null;
  }

  closeEngine() {
    if (!this.#closing) {
      const closing = Promise.resolve().then(() => {
        if (typeof this.#engine.close !== 'function') throw new Error('Native RTC engine closure is unavailable.');
        const result = this.#engine.close();
        if (!result || typeof result.then !== 'function') throw new Error('Native RTC close did not return a retirement Promise.');
        return result;
      }).then(result => {
        this.#closed = true;
        return result;
      });
      this.#closing = closing;
      void closing.catch(() => { if (this.#closing === closing) this.#closing = null; });
    }
    return this.#closing;
  }

  assertEngineClosed(engine) {
    if (engine !== this.#engine || !this.#closed) throw new Error('Complete closure of this native engine has not been proven.');
  }
}

// Capture the private-state check before an adapter can replace instance or prototype methods.
const verifyEngineClosed = Function.prototype.call.bind(NativeRtcCommands.prototype.assertEngineClosed);
function assertNativeRtcEngineClosed(commands, engine) {
  verifyEngineClosed(commands, engine);
}

const isNativeRtcCommandsForEngine = NativeRtcCommands.isForEngine;
module.exports = { NativeRtcCommands, isNativeRtcCommandsForEngine, assertNativeRtcEngineClosed };
