'use strict';

const portError = (message, code = 'ERR_NATIVE_AUDIO_IPC') => Object.assign(new Error(message), { code });
const errorData = value => ({
  code: (typeof value?.code === 'string' ? value.code.replaceAll('\0', '').slice(0, 128) : '') || 'ERR_NATIVE_AUDIO_IPC',
  message: (typeof value?.message === 'string' && value.message ? value.message : String(value))
    .replaceAll('\0', '').slice(0, 4096) || 'Native audio operation failed.',
});

class NativeAudioPort {
  constructor({ port, protocol, scope, side, onRequest, onEvent, onError, onResponseSent,
    maximumRequests = 16 }) {
    if (typeof protocol?.isNativeScreenAudioPortScope !== 'function'
      || typeof protocol.isNativeScreenAudioPortMessage !== 'function'
      || !protocol.isNativeScreenAudioPortScope(scope) || !['main', 'renderer'].includes(side)
      || [port?.postMessage, port?.start, port?.close, onRequest, onEvent, onError]
        .some(value => typeof value !== 'function')
      || (onResponseSent !== undefined && typeof onResponseSent !== 'function')
      || !Number.isInteger(maximumRequests) || maximumRequests < 1 || maximumRequests > 64) {
      throw portError('Native audio needs a scoped private MessagePort and its shared protocol.');
    }
    const dom = typeof port.addEventListener === 'function' && typeof port.removeEventListener === 'function';
    if (!dom && (typeof port.on !== 'function' || typeof port.removeListener !== 'function')) {
      throw portError('Native audio MessagePort has no removable event listeners.');
    }
    Object.assign(this, { port, protocol, side, onRequest, onEvent, onError, onResponseSent, maximumRequests, dom });
    this.scope = Object.freeze({ portId: scope.portId, epoch: scope.epoch });
    this.remoteSide = side === 'main' ? 'renderer' : 'main';
    this.started = false;
    this.closed = false;
    this.portClosed = false;
    this.failed = false;
    this.retirementAcknowledged = false;
    this.nextId = 1;
    this.lastIncomingId = 0;
    this.pending = new Map();
    this.incoming = new Set();
    this.listeners = new Map();
    this.errors = [];
    this.stats = { sent: 0, received: 0, suppressedAfterFailure: 0, requestErrors: 0 };
  }

  report(value) {
    const error = value instanceof Error ? value : portError(String(value));
    if (this.errors.length < 32) this.errors.push(error);
    if (this.failed) return;
    this.failed = true;
    try {
      const observed = this.onError(error);
      if (typeof observed?.then === 'function') void observed.catch(observerError => {
        console.error('Native audio port error observer failed:', observerError);
      });
    } catch (observerError) { console.error('Native audio port error observer failed:', observerError); }
  }

  listen(name, callback) {
    this.listeners.set(name, callback);
    if (this.dom) this.port.addEventListener(name, callback);
    else this.port.on(name, callback);
  }

  start() {
    if (this.started || this.closed) throw portError('Native audio port cannot be started twice.');
    this.started = true;
    try {
      this.listen('message', event => {
        try { this.receive(event.data); }
        catch (error) { this.report(error); }
      });
      this.listen('messageerror', () => this.report(portError('Native audio port could not deserialize a message.')));
      this.listen('close', () => {
        this.portClosed = true;
        const error = portError('The private native audio port closed.', 'ERR_NATIVE_AUDIO_IPC_CLOSED');
        if (!this.closed && !this.retirementAcknowledged) this.report(error);
        try { this.close(error); }
        catch (cleanupError) { this.report(cleanupError); }
      });
      this.port.start();
    } catch (error) {
      try { this.close(error); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native audio port startup and cleanup failed.'); }
      throw error;
    }
  }

  post(message) {
    if (!this.started || this.closed || this.portClosed) {
      throw portError('Native audio port is not open.', 'ERR_NATIVE_AUDIO_IPC_CLOSED');
    }
    if (!this.protocol.isNativeScreenAudioPortMessage(message, this.scope, this.side)) {
      throw portError('Native audio attempted to send an invalid or unauthorized port message.');
    }
    const wasAcknowledged = this.retirementAcknowledged;
    if ((message.type === 'response' && message.method === 'stop' && message.ok)
      || (message.type === 'event' && message.event === 'disposed')) this.retirementAcknowledged = true;
    try { this.port.postMessage(message); }
    catch (error) { this.retirementAcknowledged = wasAcknowledged; throw error; }
    this.stats.sent++;
  }

  request(method, data) {
    if (this.failed && method !== 'stop') return Promise.reject(portError('Native audio port has failed.'));
    if (this.pending.size >= this.maximumRequests || !Number.isSafeInteger(this.nextId)) {
      return Promise.reject(portError('Native audio port request budget is exhausted.'));
    }
    const id = this.nextId++;
    const message = { ...this.scope, type: 'request', id, method, data };
    return new Promise((resolve, reject) => {
      // Admission precedes postMessage, including test doubles with reentrant delivery.
      this.pending.set(id, { method, resolve, reject });
      try { this.post(message); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  enqueue(event, data) {
    if (this.failed && event !== 'error' && event !== 'disposed') return Promise.reject(portError('Native audio port has failed.'));
    try {
      this.post({ ...this.scope, type: 'event', event, data });
      return Promise.resolve();
    } catch (error) { return Promise.reject(error); }
  }

  receive(message) {
    if (this.closed) return;
    if (!this.protocol.isNativeScreenAudioPortMessage(message, this.scope, this.remoteSide)) {
      throw portError('Native audio received an invalid, foreign or unauthorized port message.');
    }
    this.stats.received++;
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending || pending.method !== message.method) throw portError('Native audio reply has no matching request.');
      this.pending.delete(message.id);
      if (message.ok) {
        if (message.method === 'stop') this.retirementAcknowledged = true;
        pending.resolve(message.data);
      } else {
        this.stats.requestErrors++;
        pending.reject(portError(message.error.message, message.error.code));
      }
      return;
    }
    if (message.type === 'request') {
      if (message.id <= this.lastIncomingId) throw portError('Native audio control request IDs cannot be reused.');
      this.lastIncomingId = message.id;
      if (this.incoming.size >= this.maximumRequests) {
        const error = portError('Native audio incoming control budget is exhausted.');
        this.respond(message, { ok: false, error: errorData(error) });
        this.report(error);
        return;
      }
      this.incoming.add(message.id);
      let work;
      try {
        if (this.failed && message.method !== 'stop') throw portError('Native audio port has failed.');
        work = this.onRequest(message.method, message.data);
      } catch (error) { work = Promise.reject(error); }
      void Promise.resolve(work).then(
        data => this.respond(message, { ok: true, data }),
        error => this.respond(message, { ok: false, error: errorData(error) }),
      ).catch(error => this.report(error)).finally(() => this.incoming.delete(message.id));
      return;
    }
    if (message.event === 'disposed') this.retirementAcknowledged = true;
    if (this.failed && message.event !== 'error' && message.event !== 'disposed') {
      this.stats.suppressedAfterFailure++;
      return;
    }
    const observed = this.onEvent(message.event, message.data);
    if (typeof observed?.then === 'function') void observed.catch(error => this.report(error));
  }

  respond(request, result) {
    if (this.closed) return;
    const message = { ...this.scope, type: 'response', id: request.id, method: request.method, ...result };
    try { this.post(message); }
    catch (error) {
      this.report(error);
      if (result.ok && !this.closed) {
        this.post({ ...this.scope, type: 'response', id: request.id, method: request.method,
          ok: false, error: errorData(error) });
      }
      return;
    }
    if (this.onResponseSent) {
      const observed = this.onResponseSent(message);
      if (typeof observed?.then === 'function') void observed.catch(error => this.report(error));
    }
  }

  close(reason = portError('Native audio port was disposed.', 'ERR_NATIVE_AUDIO_IPC_CLOSED')) {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    const failures = [];
    for (const [name, callback] of this.listeners) {
      try {
        if (this.dom) this.port.removeEventListener(name, callback);
        else this.port.removeListener(name, callback);
        this.listeners.delete(name);
      } catch (error) { failures.push(error); }
    }
    if (!this.portClosed) {
      try { this.port.close(); this.portClosed = true; }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native audio port disposal failed.');
  }

  getStats() {
    return {
      ...this.stats, ...this.scope, side: this.side, started: this.started, closed: this.closed,
      retirementAcknowledged: this.retirementAcknowledged, pendingRequests: this.pending.size,
      incomingRequests: this.incoming.size, errors: this.errors.map(error => error.message),
    };
  }
}

module.exports = { NativeAudioPort, nativeAudioPortErrorData: errorData };
