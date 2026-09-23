'use strict';

const { randomUUID } = require('node:crypto');
const { NativeAudioPort } = require('./nativeAudioPort.cjs');

const positive = value => Number.isSafeInteger(value) && value > 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const documentUrl = value => {
  const url = new URL(value);
  const localFile = url.protocol === 'file:' && !url.hostname;
  const development = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!localFile && !development) || url.username || url.password)
    throw new Error('Native audio requires its explicitly owned local document.');
  url.hash = '';
  return url.href;
};
const abortError = () => new DOMException('Native audio output was cancelled.', 'AbortError');

class NativeAudioPortMain {
  constructor({ webContents, frame, expectedUrl, sessionId, protocol, createMessageChannel, controls, onError }) {
    if ([webContents?.isDestroyed, webContents?.on, webContents?.removeListener, frame?.isDestroyed,
      frame?.postMessage, createMessageChannel, onError, controls?.configureOutput, controls?.grantCredits,
      controls?.probe, controls?.calibrate, controls?.feedback].some(value => typeof value !== 'function')
      || typeof protocol?.isNativeScreenAudioPortInfo !== 'function'
      || typeof protocol.isNativeScreenAudioOutputConfig !== 'function'
      || typeof protocol.isNativeScreenAudioPortScope !== 'function'
      || typeof protocol.isNativeScreenAudioPortMessage !== 'function'
      || typeof protocol.NATIVE_SCREEN_AUDIO_IPC?.outputPort !== 'string'
      || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || sessionId.includes('\0')) {
      throw new Error('Native audio output requires an owned frame and its Main control callbacks.');
    }
    Object.assign(this, { webContents, frame, sessionId, protocol, createMessageChannel, controls, onError });
    this.expectedUrl = documentUrl(expectedUrl);
    this.current = null;
    this.lastEpoch = 0;
    this.retiredThrough = 0;
    this.lastStats = null;
  }

  assertFrame() {
    if (this.webContents.isDestroyed() || this.frame.isDestroyed() || this.frame.detached
      || this.webContents.mainFrame !== this.frame || documentUrl(this.frame.url) !== this.expectedUrl) {
      throw new Error('Native audio cannot attach to a destroyed, replaced or foreign Renderer document.');
    }
  }

  report(record, error) {
    if (!record.failure) {
      record.failure = error;
      record.ready.reject(error);
      try {
        const observed = this.onError(error, { sessionId: this.sessionId, epoch: record.config.epoch });
        if (typeof observed?.then === 'function') void observed.catch(observerError => {
          console.error('Native audio Main error observer failed:', observerError);
        });
      } catch (observerError) { console.error('Native audio Main error observer failed:', observerError); }
    }
  }

  listen(record, name, callback) {
    record.listeners.set(name, callback);
    this.webContents.on(name, callback);
  }

  async start(config, signal) {
    if (!this.protocol.isNativeScreenAudioOutputConfig(config) || config.epoch <= this.lastEpoch || this.current) {
      throw new Error('Native audio output epochs must increase after complete Renderer retirement.');
    }
    if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) throw new Error('Invalid native audio output cancellation signal.');
    if (signal?.aborted) throw signal.reason ?? abortError();
    const record = {
      config: Object.freeze({ ...config }), portId: randomUUID(), ready: deferred(), port: null, localPort: null, untransferred: null,
      transferAttempted: false, configured: false, configureWork: null, readyObserved: false,
      stopping: false, retired: false, stopWork: null, failure: null, retirement: null,
      retirementReady: deferred(), listeners: new Map(), ignoredAfterStop: 0, signal, abortListener: null,
    };
    this.current = record;
    this.lastEpoch = config.epoch;
    this.retiredThrough = config.epoch - 1;
    record.abortListener = () => {
      record.stopping = true;
      record.ready.reject(signal.reason ?? abortError());
    };
    try {
      // Claim the valid epoch first, so a rejected frame still has an exact no-transfer retirement.
      this.assertFrame();
      const { port1, port2 } = this.createMessageChannel();
      record.localPort = port1;
      record.untransferred = port2;
      record.port = new NativeAudioPort({
        port: port1, protocol: this.protocol, scope: { portId: record.portId, epoch: config.epoch }, side: 'main',
        onRequest: (method, data) => this.control(record, method, data),
        onEvent: (name, data) => this.event(record, name, data),
        onError: error => this.report(record, error),
      });
      this.listen(record, 'did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
        const main = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
        const sameDocument = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace;
        if (main && !sameDocument) {
          record.stopping = true;
          this.report(record, new Error('The native audio Renderer document is navigating.'));
        }
      });
      const rendererGone = reason => {
        record.retirement = reason;
        record.retirementReady.resolve({ epoch: record.config.epoch, stopped: true });
        if (!record.stopping) this.report(record, new Error('The native audio Renderer was destroyed.'));
      };
      this.listen(record, 'destroyed', () => rendererGone('web-contents-destroyed'));
      this.listen(record, 'render-process-gone', () => rendererGone('renderer-process-gone'));
      signal?.addEventListener('abort', record.abortListener, { once: true });
      record.port.start();
      this.assertFrame();
      if (signal?.aborted) throw signal.reason ?? abortError();
      const info = { version: 1, sessionId: this.sessionId, portId: record.portId, output: record.config };
      record.transferAttempted = true;
      this.frame.postMessage(this.protocol.NATIVE_SCREEN_AUDIO_IPC.outputPort, info, [port2]);
      record.untransferred = null;
    } catch (error) {
      record.stopping = true;
      record.ready.reject(error);
      this.report(record, error);
    }
    return record.ready.promise;
  }

  control(record, method, data) {
    this.assertFrame();
    if (this.current !== record || record.stopping || record.failure) throw new Error('Native audio output is no longer accepting control work.');
    if (method === 'configure') {
      if (record.configureWork || data.sinkId !== record.config.sinkId) {
        throw new Error('Native output must configure its exact selected device once.');
      }
      const pending = this.controls.configureOutput(data);
      if (typeof pending?.then !== 'function') throw new Error('Native audio configuration must return its actual Promise.');
      record.configureWork = pending.then(result => {
        if (result?.epoch !== record.config.epoch || result.sampleRate !== 48000 || result.channels !== 2
          || Object.keys(result).length !== 3) throw new Error('Native audio configuration returned an invalid receipt.');
        record.configured = true;
        return result;
      });
      return record.configureWork;
    }
    if (!record.configured) throw new Error('Native clock work preceded actual output configuration.');
    return method === 'probe' ? this.controls.probe(data) : this.controls.calibrate(data);
  }

  event(record, name, data) {
    if (name === 'disposed') {
      if (this.current !== record || record.retired) throw new Error('Native audio disposal has no matching owned Renderer.');
      const expected = record.stopping;
      record.stopping = true;
      record.retirement = 'renderer-context-disposed';
      record.retirementReady.resolve({ epoch: record.config.epoch, stopped: true });
      if (!expected) this.report(record, new Error('The Renderer disposed its native audio output.'));
      return;
    }
    if (name === 'error') {
      this.report(record, Object.assign(new Error(data.message), { code: data.code }));
      return;
    }
    if (record.stopping || record.retired) { record.ignoredAfterStop++; return; }
    this.assertFrame();
    if (this.current !== record || record.failure || !record.configured) {
      throw new Error('Native audio Renderer feedback arrived outside its configured output.');
    }
    if (name === 'ready') {
      if (record.readyObserved || data.sinkId !== record.config.sinkId) throw new Error('Native audio Renderer returned mismatched readiness.');
      record.readyObserved = true;
      record.signal?.removeEventListener('abort', record.abortListener);
      record.ready.resolve(data);
    } else if (name === 'credits') {
      return this.controls.grantCredits(data);
    } else {
      return this.controls.feedback(data);
    }
  }

  enqueue(packet) {
    const record = this.current;
    if (!record || record.stopping || record.retired || record.failure || !record.configured
      || packet?.epoch !== record.config.epoch) return Promise.reject(new Error('Native PCM has no matching active Renderer output.'));
    try { this.assertFrame(); }
    catch (error) { return Promise.reject(error); }
    return record.port.enqueue('pcm', packet);
  }

  stop(epoch) {
    if (!positive(epoch)) return Promise.reject(new Error('Native audio Renderer stop has no valid epoch.'));
    // Only one epoch can exist at a time, and lower epochs can never be admitted again.
    if (epoch <= this.retiredThrough) return Promise.resolve({ epoch, stopped: true });
    const record = this.current;
    if (!record || record.config.epoch !== epoch) return Promise.reject(new Error('Native audio has no owned Renderer epoch to retire.'));
    record.stopping = true;
    record.ready.reject(abortError());
    if (!record.stopWork) {
      const work = Promise.resolve().then(async () => {
        let result;
        if (!record.transferAttempted) {
          record.retirement = 'not-transferred';
          result = { epoch, stopped: true };
        } else if (record.retirement) {
          result = { epoch, stopped: true };
        } else {
          result = await Promise.race([record.port.request('stop', { epoch }), record.retirementReady.promise]);
          if (!record.retirement) record.retirement = 'renderer-context-closed';
        }
        if (result.epoch !== epoch || result.stopped !== true) throw new Error('Native audio Renderer did not prove output retirement.');
        this.retire(record);
        return result;
      });
      record.stopWork = work;
      void work.catch(() => { if (record.stopWork === work) record.stopWork = null; });
    }
    return record.stopWork;
  }

  retire(record) {
    const failures = [];
    for (const [name, callback] of record.listeners) {
      try { this.webContents.removeListener(name, callback); record.listeners.delete(name); }
      catch (error) { failures.push(error); }
    }
    try { record.signal?.removeEventListener('abort', record.abortListener); }
    catch (error) { failures.push(error); }
    try {
      if (record.port) record.port.close();
      else record.localPort?.close();
    }
    catch (error) { failures.push(error); }
    if (record.untransferred) {
      try { record.untransferred.close(); record.untransferred = null; }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native audio still owns Renderer transport cleanup.');
    record.retired = true;
    this.retiredThrough = record.config.epoch;
    this.lastStats = this.stats(record);
    if (this.current === record) this.current = null;
  }

  stats(record) {
    return {
      epoch: record.config.epoch, portId: record.portId, configured: record.configured,
      ready: record.readyObserved, stopping: record.stopping, retired: record.retired,
      retirement: record.retirement, ignoredAfterStop: record.ignoredAfterStop,
      error: record.failure?.message ?? null, port: record.port?.getStats() ?? null,
    };
  }

  getStats() {
    return {
      sessionId: this.sessionId, lastEpoch: this.lastEpoch, retiredThrough: this.retiredThrough,
      current: this.current ? this.stats(this.current) : null, last: this.lastStats,
    };
  }
}

module.exports = { NativeAudioPortMain };
