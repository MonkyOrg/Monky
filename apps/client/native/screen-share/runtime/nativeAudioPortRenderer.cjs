'use strict';

const { NativeAudioPort, nativeAudioPortErrorData } = require('./nativeAudioPort.cjs');
const { NativePcmAudioSink } = require('./nativePcmAudioSink.cjs');
const { NativeAudioClockClient } = require('./nativeAudioClockClient.cjs');

const cancelled = () => new DOMException('Native audio Renderer startup was cancelled.', 'AbortError');

class NativeAudioPortRenderer {
  constructor({ port, info, protocol, workletUrl, onError, onRetired, createContext, createWorklet, now,
    setTimer, clearTimer, timeoutMs = 5000 }) {
    if (!protocol?.isNativeScreenAudioPortInfo(info) || typeof onError !== 'function'
      || typeof onRetired !== 'function') throw new Error('Native audio Renderer needs its private output descriptor.');
    this.info = Object.freeze({ ...info, output: Object.freeze({ ...info.output }) });
    this.onError = onError;
    this.onRetired = onRetired;
    this.started = false;
    this.ready = false;
    this.stopping = false;
    this.retired = false;
    this.failed = false;
    this.stopWork = null;
    this.errors = [];
    this.startupError = null;
    this.suppressedFeedback = 0;
    this.port = new NativeAudioPort({
      port, protocol, scope: { portId: info.portId, epoch: info.output.epoch }, side: 'renderer',
      onRequest: () => this.stop(),
      onEvent: (name, data) => {
        if (name === 'error') this.fail(Object.assign(new Error(data.message), { code: data.code }), false);
        else this.sink.acceptPacket(data);
      },
      onError: error => this.fail(error),
      onResponseSent: message => {
        if (message.method === 'stop' && message.ok) this.retire();
      },
    });
    this.clock = new NativeAudioClockClient({
      epoch: info.output.epoch, now, setTimer, clearTimer, timeoutMs,
      requestProbe: data => this.port.request('probe', data),
      calibrate: data => this.port.request('calibrate', data),
      sendFeedback: data => this.port.enqueue('feedback', data),
      onError: error => this.fail(error),
    });
    this.sink = new NativePcmAudioSink({
      ...info.output, workletUrl, createContext, createWorklet, now, timeoutMs,
      prepareOutput: async (config, signal) => {
        await this.port.request('configure', config);
        if (this.stopping || signal.aborted) throw cancelled();
        await this.clock.start();
        if (this.stopping || signal.aborted) throw cancelled();
      },
      onCredits: data => this.port.enqueue('credits', data),
      onFeedback: data => {
        if (this.stopping || !this.clock.started || this.clock.stopped) {
          this.suppressedFeedback++;
          return;
        }
        return this.clock.feedback(data);
      },
      onError: error => this.fail(error),
    });
  }

  observe(error) {
    if (this.errors.length < 32) this.errors.push(error instanceof Error ? error : new Error(String(error)));
    try {
      const observed = this.onError(error, this.info);
      if (typeof observed?.then === 'function') void observed.catch(observerError => {
        console.error('Native audio Renderer error observer failed:', observerError);
      });
    } catch (observerError) { console.error('Native audio Renderer error observer failed:', observerError); }
  }

  fail(error, notifyRemote = true) {
    if (this.failed) return;
    this.failed = true;
    this.observe(error);
    if (notifyRemote && this.port.started && !this.port.closed && !this.port.portClosed) {
      void this.port.enqueue('error', nativeAudioPortErrorData(error)).catch(sendError => this.observe(sendError));
    }
    void this.stop().catch(cleanupError => this.observe(cleanupError));
  }

  async start() {
    if (this.started || this.stopping) throw new Error('Native audio Renderer cannot reuse an output epoch.');
    this.started = true;
    try {
      this.port.start();
      const result = await this.sink.start();
      if (this.stopping) throw cancelled();
      this.ready = true;
      await this.port.enqueue('ready', result);
      return result;
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : String(error);
      if (!this.stopping) this.fail(error);
      try { await this.stop(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native audio Renderer startup and retirement failed.');
      }
      throw error;
    }
  }

  stop() {
    this.stopping = true;
    this.ready = false;
    this.clock.stop();
    if (!this.stopWork) {
      // Stop is independent of the outer start Promise, which may still await Main configuration.
      const work = Promise.resolve().then(() => this.sink.stop()).then(result => {
        if (result.epoch !== this.info.output.epoch || result.stopped !== true) {
          throw new Error('Native audio Renderer still owns its output context.');
        }
        return { epoch: result.epoch, stopped: true };
      });
      this.stopWork = work;
      void work.catch(() => { if (this.stopWork === work) this.stopWork = null; });
    }
    return this.stopWork;
  }

  retire() {
    if (this.retired) return;
    if (this.sink.getStats().stopped !== true) throw new Error('Native audio cannot retire a live output context.');
    this.port.close();
    this.retired = true;
    this.onRetired(this);
  }

  async dispose() {
    const result = await this.stop();
    if (this.retired) return;
    // Local teardown may precede Stop. Deliver its real context-closure receipt before closing the port.
    if (this.port.started && !this.port.closed && !this.port.portClosed) {
      await this.port.enqueue('disposed', result);
    }
    this.retire();
  }

  getStats() {
    return {
      sessionId: this.info.sessionId, portId: this.info.portId, epoch: this.info.output.epoch,
      ready: this.ready, retired: this.retired, suppressedFeedback: this.suppressedFeedback,
      startupError: this.startupError,
      sink: this.sink.getStats(), clock: this.clock.getStats(), port: this.port.getStats(),
      errors: this.errors.map(error => error.message),
    };
  }
}

function registerNativeAudioPortReceiver(ipcRenderer, protocol, { workletUrl, onError, ...options }) {
  if (typeof ipcRenderer?.on !== 'function' || typeof ipcRenderer.removeListener !== 'function'
    || typeof protocol?.NATIVE_SCREEN_AUDIO_IPC?.outputPort !== 'string'
    || typeof protocol.isNativeScreenAudioPortInfo !== 'function' || typeof onError !== 'function') {
    throw new Error('Native audio requires a private preload IPC receiver.');
  }
  const sessions = new Map();
  let disposed = false;
  const errors = [];
  const report = error => {
    if (errors.length < 64) errors.push(error instanceof Error ? error.message : String(error));
    try {
      const observed = onError(error);
      if (typeof observed?.then === 'function') void observed.catch(observerError => {
        console.error('Native audio preload error observer failed:', observerError);
      });
    } catch (observerError) { console.error('Native audio preload error observer failed:', observerError); }
  };
  const receive = (event, info) => {
    const ports = event?.ports;
    try {
      if (disposed || !protocol.isNativeScreenAudioPortInfo(info) || !Array.isArray(ports) || ports.length !== 1) {
        throw new Error('Native audio IPC did not transfer one valid scoped port.');
      }
      if (sessions.has(info.sessionId) || sessions.size >= 64) {
        throw new Error('Native audio already owns this session output, or its active output limit was reached.');
      }
      const session = new NativeAudioPortRenderer({
        ...options, port: ports[0], info, protocol, workletUrl, onError: report,
        onRetired: retired => {
          if (sessions.get(info.sessionId) === retired) sessions.delete(info.sessionId);
        },
      });
      sessions.set(info.sessionId, session);
      void session.start().catch(error => {
        if (!session.stopping) report(error);
      });
    } catch (error) {
      const failures = [error];
      for (const port of Array.isArray(ports) ? ports : []) {
        try { port.close(); }
        catch (cleanupError) { failures.push(cleanupError); }
      }
      report(failures.length === 1 ? error : new AggregateError(failures, 'Native audio port admission failed.'));
    }
  };
  ipcRenderer.on(protocol.NATIVE_SCREEN_AUDIO_IPC.outputPort, receive);
  return {
    getStats: () => ({ sessions: [...sessions.values()].map(session => session.getStats()), errors: [...errors] }),
    async dispose() {
      disposed = true;
      ipcRenderer.removeListener(protocol.NATIVE_SCREEN_AUDIO_IPC.outputPort, receive);
      const results = await Promise.allSettled([...sessions.values()].map(session => session.dispose()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Native audio preload still owns output contexts.');
    },
  };
}

module.exports = { NativeAudioPortRenderer, registerNativeAudioPortReceiver };
