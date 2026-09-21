'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { within } = require('./nativeDeadline.cjs');
class ObsHostBridge {
  constructor({ host, runtime, onError, protocol, argumentsForSource, validateRetirement,
    runId = randomBytes(16).toString('hex') }, dependencies = {}) {
    assert.equal(runtime?.kind, 'verified-stock-obs-runtime');
    assert.equal(runtime.version, '32.1.1');
    assert.ok(path.isAbsolute(host?.executable) && path.isAbsolute(runtime.binaryDirectory));
    assert.match(host.sha256, /^[a-f0-9]{64}$/);
    assert.match(runId, /^[a-f0-9]{32}$/);
    assert.equal(typeof onError, 'function');
    for (const name of ['validateSource', 'validateMessage', 'validateProgress', 'command', 'errorDetails'])
      assert.equal(typeof protocol?.[name], 'function', `Missing OBS host protocol operation: ${name}`);
    assert.ok(Number.isSafeInteger(protocol.maxLineBytes) && protocol.maxLineBytes > 0
      && protocol.maxLineBytes <= 16384);
    assert.equal(typeof argumentsForSource, 'function');
    assert.equal(typeof validateRetirement, 'function');
    Object.assign(this, { host, runtime, onError, runId, protocol, argumentsForSource, validateRetirement });
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.deadline = dependencies.deadline ?? within;
    this.now = dependencies.now ?? (() => performance.now());
    this.deadlines = { prepare: 15000, start: 10000, stats: 2000, stop: 15000, exit: 5000, ...dependencies.deadlines };
    this.bindings = [];
    this.pending = new Map();
    this.requests = new Map();
    this.sequence = 0;
    this.errors = [];
    this.events = { prepared: 0, ready: 0, stats: 0, stopped: 0, error: 0, unexpected: 0 };
    this.eof = { stdout: false, stderr: false };
    this.started = false;
    this.closed = false;
    this.nativeClosed = false;
    this.closeReason = null;
    this.outputBytes = 0;
    this.stderr = '';
  }

  bind(target, event, listener) {
    target.on(event, listener);
    this.bindings.push(() => target.off(event, listener));
  }

  detach() {
    this.signal?.removeEventListener('abort', this.abort);
    for (const remove of this.bindings.splice(0)) remove();
  }

  fail(value) {
    const error = value instanceof Error ? value : new Error(String(value));
    if (!this.firstError) {
      this.firstError = error;
      this.errors.push(error.message);
      this.onError(error);
    }
    this.rejectPrepared?.(this.firstError);
    for (const request of this.pending.values()) request.reject(this.firstError);
    return this.firstError;
  }

  consume(stream, channel) {
    let buffer = '';
    stream.setEncoding('utf8');
    this.bind(stream, 'data', chunk => {
      try {
        this.outputBytes += Buffer.byteLength(chunk);
        assert.ok(Number.isSafeInteger(this.outputBytes), 'Capture output counter overflow.');
        if (channel === 'stderr') {
          const tail = Buffer.from(this.stderr + chunk);
          this.stderr = tail.subarray(Math.max(0, tail.length - 64 * 1024)).toString('utf8');
          return;
        }
        if (this.protocolFailed) return;
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          assert.ok(line.length > 0 && Buffer.byteLength(line) <= this.protocol.maxLineBytes, 'Invalid OBS host line length.');
          this.receive(JSON.parse(line));
        }
        assert.ok(Buffer.byteLength(buffer) <= this.protocol.maxLineBytes, 'Unterminated OBS host line exceeded its bound.');
      } catch (error) {
        if (channel === 'stdout') this.events.unexpected++;
        this.protocolFailed = true;
        this.fail(error);
      }
    });
    this.bind(stream, 'end', () => {
      this.eof[channel] = true;
      if (channel === 'stdout' && buffer && !this.protocolFailed)
        this.fail(new Error('OBS host ended with an incomplete protocol line.'));
      else if (channel === 'stdout' && !this.stopped)
        this.fail(new Error('OBS host stdout ended before its requested retirement response.'));
    });
    this.bind(stream, 'error', error => this.fail(error));
  }

  receive(message) {
    assert.equal(this.closed, false, 'OBS host message arrived after process closure.');
    this.protocol.validateMessage(message, { source: this.source, runId: this.runId, helperProcessId: this.helperProcessId });
    if (this.lastMessage) this.protocol.validateProgress(this.lastMessage, message);
    this.lastMessage = structuredClone(message);
    if (message.type === 'error') {
      assert.ok(message.sequence <= this.sequence, 'OBS error refers to an unsent command.');
      this.events.error++;
      const details = this.protocol.errorDetails(message);
      const error = new Error(details.message);
      error.code = details.code;
      this.nativeError ??= error;
      this.failure = structuredClone(message);
      this.fail(this.nativeError);
      return;
    }
    if (message.type === 'prepared') {
      assert.equal(this.events.prepared++, 0, 'Duplicate OBS host preparation.');
      assert.equal(this.events.ready, 0);
      this.prepared = structuredClone(message);
      if (!this.stopping && !this.firstError) this.resolvePrepared(this.prepared);
      return;
    }
    assert.ok(this.prepared, 'OBS host emitted a capture response before preparation.');
    const request = this.requests.get(message.sequence);
    assert.ok(request && !request.received, 'Unsolicited or duplicate OBS host response.');
    assert.equal(message.type, { start: 'ready', stats: 'stats', stop: 'stopped' }[request.verb]);
    request.received = true;
    this.requests.delete(message.sequence);
    this.events[message.type]++;
    if (message.type === 'ready') {
      assert.equal(this.events.ready, 1, 'Duplicate OBS capture readiness.');
      this.ready = structuredClone(message);
    } else if (message.type === 'stopped') {
      assert.ok(this.stopping, 'OBS host retired without a requested stop.');
      assert.equal(this.events.stopped, 1);
      this.stopped = structuredClone(message);
    } else assert.ok(this.ready, 'OBS stats arrived before capture readiness.');
    this.lastObservation = structuredClone(message);
    this.pending.get(message.sequence)?.resolve(structuredClone(message));
  }

  async prepare(source, signal) {
    assert.equal(this.prepareStarted, undefined, 'An OBS host can be prepared once.');
    assert.equal(this.stopping, undefined);
    this.protocol.validateSource(source);
    signal?.throwIfAborted();
    this.source = Object.freeze({ hwnd: source.hwnd, expectedProcessId: source.expectedProcessId });
    this.prepareStarted = true;
    this.signal = signal;
    this.abort = () => {
      this.fail(signal.reason);
      void this.stop().catch(error => this.fail(error));
    };
    signal?.addEventListener('abort', this.abort, { once: true });
    const prepared = new Promise((resolve, reject) => { this.resolvePrepared = resolve; this.rejectPrepared = reject; });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    const observed = this.deadline(prepared, this.deadlines.prepare, 'OBS host preparation timed out.');
    try {
      this.child = this.spawnProcess(this.host.executable, this.argumentsForSource(this.source, this.runId),
        { cwd: path.dirname(this.host.executable), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.helperProcessId = this.child.pid;
      this.bind(this.child, 'error', error => this.fail(error));
      this.bind(this.child, 'exit', (code, exitSignal) => { this.processExit = { code, signal: exitSignal }; });
      this.bind(this.child, 'close', (code, exitSignal) => {
        this.exit = { code, signal: exitSignal };
        this.closedAtMs = this.now();
        this.closed = true;
        if (!this.stopping || code !== 0 || exitSignal !== null || !this.stopped)
          this.fail(new Error(`OBS host exited without clean requested retirement (${code}, ${exitSignal}).`));
        if (!this.eof.stdout || !this.eof.stderr)
          this.fail(new Error('OBS host process closure was not accompanied by both output EOFs.'));
        this.resolveExit(this.exit);
        this.requests.clear();
        this.detach();
      });
      this.consume(this.child.stdout, 'stdout');
      this.consume(this.child.stderr, 'stderr');
      this.bind(this.child.stdin, 'error', error => { if (!this.processExit) this.fail(error); });
      assert.ok(Number.isInteger(this.child.pid) && this.child.pid > 0);
    } catch (error) {
      this.spawnFailed = !this.child;
      this.fail(error);
      if (this.spawnFailed) {
        this.resolveExit(null);
        this.detach();
      }
    }
    try {
      const result = await observed;
      if (this.firstError) throw this.firstError;
      return result;
    }
    catch (error) { throw this.fail(error); }
  }

  async request(verb, allowStopping = false) {
    assert.ok(this.child && !this.exit && !this.spawnFailed, 'OBS host process is unavailable.');
    if (!allowStopping) {
      this.signal?.throwIfAborted();
      if (this.firstError) throw this.firstError;
      assert.equal(this.eof.stdout, false, 'OBS commands require an open response channel.');
      assert.equal(this.stopping, undefined, 'OBS host is stopping.');
      assert.equal(this.pending.size, 0, 'OBS sampling commands must be serialized.');
    }
    assert.ok(this.sequence < Number.MAX_SAFE_INTEGER, 'Capture command sequence exhausted.');
    const sequence = ++this.sequence;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(sequence, { resolve, reject });
      this.requests.set(sequence, { verb, received: false });
    });
    const observed = this.observeRequest(promise, verb);
    try {
      this.child.stdin.write(this.protocol.command(sequence, verb), error => { if (error && !this.exit) this.fail(error); });
    } catch (error) { this.fail(error); }
    try {
      const result = await observed;
      if (!allowStopping && this.firstError) throw this.firstError;
      return result;
    }
    catch (error) { throw this.fail(error); }
    finally { this.pending.delete(sequence); }
  }

  observeRequest(promise, verb) {
    return this.deadline(promise, this.deadlines[verb], `OBS host ${verb} acknowledgement timed out.`);
  }

  async start(source, signal) {
    this.protocol.validateSource(source);
    assert.deepEqual({ hwnd: source.hwnd, expectedProcessId: source.expectedProcessId }, this.source);
    assert.ok(this.prepared && !this.started && !this.stopping, 'OBS capture requires one prepared, unstarted host.');
    signal?.throwIfAborted();
    this.started = true;
    return this.request('start');
  }

  async getStats() {
    assert.ok(this.ready && !this.stopping, 'OBS sampling requires a running capture.');
    await this.request('stats');
    return this.snapshot();
  }

  snapshot() {
    return {
      started: this.started, closed: this.closed, nativeClosed: this.nativeClosed,
      closeReason: this.closeReason, helperProcessId: this.helperProcessId ?? null,
      prepared: this.prepared ? structuredClone(this.prepared) : null,
      native: this.lastObservation ? structuredClone(this.lastObservation) : null,
      stopped: this.stopped ? structuredClone(this.stopped) : null,
      failure: this.failure ? structuredClone(this.failure) : null,
      exit: this.exit ?? null, processExit: this.processExit ?? null, outputEof: { ...this.eof },
      closedAtMs: this.closedAtMs ?? null, forcedTermination: this.forcedTermination ?? false,
      events: { ...this.events }, errors: [...this.errors], stderr: this.stderr,
    };
  }

  stop() {
    if (this.stopTask) return this.stopTask;
    this.stopping = true;
    this.stopTask = Promise.resolve().then(async () => {
      if (!this.prepareStarted) return this.snapshot();
      this.rejectPrepared?.(this.firstError ?? new DOMException('OBS host preparation cancelled.', 'AbortError'));
      for (const request of this.pending.values())
        request.reject(this.firstError ?? new DOMException('OBS capture command cancelled.', 'AbortError'));
      const failures = [];
      if (this.child && !this.exit && !this.spawnFailed) {
        try { await this.request('stop', true); } catch (error) { failures.push(error); }
        try { this.child.stdin.end(); } catch (error) { failures.push(error); }
      }
      try { await this.deadline(this.exited, this.deadlines.exit, 'OBS host did not exit after retirement.'); }
      catch (error) {
        failures.push(error);
        if (this.child && !this.exit) {
          this.forcedTermination = true;
          try {
            assert.ok(Number.isInteger(this.helperProcessId) && this.helperProcessId > 0
              && this.child.pid === this.helperProcessId,
              'An unspawned OBS helper must not be targeted for termination.');
            assert.equal(this.child.kill('SIGTERM'), true, 'The owned OBS host could not be terminated.');
            await this.deadline(this.exited, this.deadlines.exit, 'The terminated OBS host did not close.');
          } catch (killError) { failures.push(killError); }
        }
      }
      if (this.exit) this.detach();
      if (this.firstError) failures.unshift(this.firstError);
      if (failures.length) {
        for (const error of failures) this.fail(error);
        throw new AggregateError(failures, failures.map(error => error.message).join('; '));
      }
      assert.deepEqual(this.exit, { code: 0, signal: null });
      assert.deepEqual(this.processExit, this.exit);
      assert.deepEqual(this.eof, { stdout: true, stderr: true });
      assert.ok(this.stopped);
      this.validateRetirement(this);
      this.nativeClosed = true;
      this.closeReason = 'requested';
      return this.snapshot();
    }).catch(error => { throw this.fail(error); });
    return this.stopTask;
  }
}

module.exports = { ObsHostBridge };
