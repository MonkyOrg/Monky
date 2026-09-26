'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { encode, decode, fromError } = require('./wire.cjs');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const hostFailure = (message, detail = {}) => Object.assign(new Error(message), {
  code: 'ERR_RTC_HOST_EXIT', status: 7, hresult: 0, terminal: true, ...detail,
});
const queueFull = () => Object.assign(new Error('Native RTC IPC credits are exhausted.'), {
  code: 'ERR_RTC_ENCODED_INPUT', status: 3,
});

function spawnHost(filename) {
  if (process.versions.electron) {
    const { utilityProcess } = require('electron');
    assert.equal(typeof utilityProcess?.fork, 'function', 'Electron utility process isolation is required.');
    const child = utilityProcess.fork(filename, [], {
      serviceName: 'Monky native screen RTC', stdio: 'ignore',
    });
    return { child, send: bytes => child.postMessage(bytes), utility: true };
  }
  const child = fork(filename, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced', windowsHide: true, execArgv: [] });
  return { child, send: (bytes, fail) => child.send(bytes, error => { if (error) fail(error); }), utility: false };
}

class ProcessEngine {
  constructor({ filename, capabilities, handlesFile, options, onEvent, hostFile = path.join(__dirname, 'host.cjs') }) {
    assert.equal(typeof onEvent, 'function');
    this.asynchronousNative = true;
    this.options = options;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.leases = new Map();
    this.inputFrames = new Map();
    this.nextId = 0;
    this.bytesPending = 0;
    this.encodedPending = 0;
    this.audioPending = 0;
    this.lastSnapshot = null;
    this.readyState = deferred();
    this.exitState = deferred();
    this.ready = this.readyState.promise;
    void this.ready.catch(() => {});
    const transport = spawnHost(hostFile);
    this.child = transport.child;
    this.sendBytes = transport.send;
    const fail = error => this.fail(error);
    this.child.on('error', fail);
    this.child.on('exit', (code, signal) => this.exited(code, signal));
    this.child.on('close', code => { if (!this.child.pid) this.exited(code, null); });
    this.child.on('message', bytes => {
      try { this.receive(decode(bytes)); }
      catch (error) { this.fail(error); }
    });
    const initialize = () => {
      if (this.failure || this.hostExited) return;
      try {
        this.pid = this.child.pid;
        if (handlesFile) this.handles = require(handlesFile).openProcess(this.child.pid);
        this.send({ type: 'initialize', filename, capabilities, handlesFile, parentPid: process.pid, options });
      } catch (error) { this.fail(error); }
    };
    this.child.once('spawn', initialize);
    this.startupTimer = setTimeout(() => this.fail(hostFailure('Native RTC host startup timed out.')),
      Math.max(5000, options.operationTimeoutMs ?? 12000));
  }

  send(value) {
    if (this.hostExited) throw this.failure ?? hostFailure('Native RTC host has exited.');
    this.sendBytes(encode(value), error => this.fail(error));
  }

  emit(event) {
    try { this.onEvent(event); }
    catch (error) { this.fail(error); }
  }

  receive(message) {
    if (this.hostExited) return;
    if (message.type === 'ready') {
      clearTimeout(this.startupTimer);
      this.observeSnapshot(message.snapshot);
      this.readyState.resolve();
    } else if (message.type === 'fatal') {
      this.fail(fromError(message.error));
    } else if (message.type === 'event') {
      const event = message.event;
      if (event.type === 'process.snapshot') this.observeSnapshot(event.snapshot);
      else if (event.type === 'frame') {
        assert.ok(this.handles && !this.leases.has(event.data.frameId));
        assert.ok(this.leases.size < (this.options.maxDecodedFrames ?? 16));
        const lease = this.handles.duplicate(event.data.textureInfo.handle.ntHandle);
        this.leases.set(event.data.frameId, { handle: lease, released: deferred(), proof: null });
        event.data.textureInfo.handle.ntHandle = lease.handle;
        this.emit(event);
      } else {
        if (event.type === 'audio.playout') {
          assert.ok(event.data.samples instanceof Float32Array && event.data.samples.length === 960);
          // V8 may deserialize a typed view into its larger wire buffer. The
          // renderer contract requires a dedicated, exactly sized PCM buffer.
          event.data.samples = new Float32Array(event.data.samples);
        }
        this.emit(event);
      }
      this.send({ type: 'event-ack', id: message.id });
    } else if (message.type === 'result') {
      const record = this.pending.get(message.id);
      assert.ok(record, 'Native RTC host replied to an unknown operation.');
      this.retireCall(message.id, record);
      if (record.inputKey && (!message.error || message.error.nativeOwnershipRetained === false))
        this.inputFrames.delete(record.inputKey);
      if (message.error) {
        const error = fromError(message.error);
        if (record.retirementOperation && error.code === 'ERR_RTC_CANCELLED') this.fail(error);
        record.reject(error);
      }
      else {
        if (record.method === 'close') {
          // Unlike OS death alone, the native close acknowledgement proves
          // that imported input readers and their GPU fences have retired.
          this.inputFrames.clear();
          this.closeAcknowledged = true;
          this.exitTimer = setTimeout(() => this.fail(hostFailure('The closed native RTC host did not exit.')),
            Math.min(this.options.operationTimeoutMs ?? 12000, 8000));
          this.send({ type: 'finish' });
        }
        record.resolve(message.result);
      }
    } else assert.equal(message.type, 'closed');
  }

  retireCall(id, record) {
    this.pending.delete(id);
    clearTimeout(record.timer);
    this.bytesPending -= record.bytes;
    if (record.method === 'submitEncodedFrame') this.encodedPending--;
    if (record.method === 'submitAudioPacket') this.audioPending--;
  }

  observeSnapshot(snapshot) {
    this.lastSnapshot = snapshot;
    const timeoutUs = Math.min(this.options.operationTimeoutMs ?? 12000, 8000) * 1000;
    for (const decoder of snapshot?.mf?.decoders ?? []) {
      const diagnostic = decoder.diagnostics;
      if (diagnostic?.clock !== 'process-steady-clock'
        || !Number.isSafeInteger(diagnostic.observedAtSteadyUs)) continue;
      for (const operation of ['core-create', 'core-pump', 'core-flush', 'core-abort', 'core-stop']) {
        const call = diagnostic.operations?.[operation];
        if (call?.inProgress > 0 && Number.isSafeInteger(call.lastStartSteadyUs)
          && diagnostic.observedAtSteadyUs - call.lastStartSteadyUs >= timeoutUs) {
          // Both readings belong to the existing native diagnostic clock. This
          // is a stuck CPU/native call, never a substitute GPU retirement fence.
          this.fail(hostFailure(`The native decoder ${operation} operation stopped responding.`));
          return;
        }
      }
    }
  }

  fail(error) {
    if (!this.failure) this.failure = hostFailure(error?.code === 'ERR_RTC_HOST_EXIT'
      ? error.message : 'The isolated native screen process failed.', {
      cause: error, detail: String(error?.message ?? error),
    });
    // A timeout is not closure. Only this exact ChildProcess/UtilityProcess is
    // terminated; native ownership remains until its OS exit notification.
    if (!this.hostExited) {
      try {
        if (!this.child.kill()) this.killFailure = 'The owned process did not accept termination.';
      } catch (failure) { this.killFailure = String(failure?.message ?? failure); }
    }
  }

  exited(code, signal) {
    if (this.hostExited) return;
    this.hostExited = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.exitTimer);
    if (!this.closeAcknowledged || code !== 0)
      this.failure ??= hostFailure('The native screen process exited unexpectedly.', { exitCode: code, signal });
    const error = this.failure ?? hostFailure('The native screen process has closed.');
    this.readyState.reject(error);
    for (const [id, record] of this.pending) {
      this.retireCall(id, record);
      const identity = record.identity;
      record.reject(Object.assign(new Error(error.message), error, identity ? {
        ...identity, nativeOwnershipRetained: record.method === 'submitFrame',
        ...(record.method === 'submitFrame' ? { gpuRetirementConfirmed: false } : { processingPending: false }),
        hostExited: true,
      } : { hostExited: true }));
    }
    try { this.handles?.close(); }
    catch (failure) {
      this.failure ??= hostFailure('The RTC process exited but its process HANDLE could not be closed.', { cause: failure });
    }
    this.exitState.resolve();
    if (this.failure) this.emit({ type: 'error', target: 0, data: {
      code: error.code, message: error.message, status: 7, hresult: 0, terminal: true,
      hostExited: true, exitCode: code, signal: signal ?? null,
      hostPid: this.pid ?? null,
    } });
  }

  call(method, args) {
    if (this.failure || this.hostExited) return Promise.reject(this.failure ?? hostFailure('Native RTC host is closed.'));
    assert.ok(Number.isSafeInteger(this.nextId + 1), 'Native RTC operation identifiers are exhausted.');
    const bytes = encode({ type: 'call', id: this.nextId + 1, method, args });
    const inputKey = method === 'submitFrame' ? `${args[0]}:${args[1]?.frameId}` : null;
    if (inputKey && this.inputFrames.has(inputKey))
      throw Object.assign(new Error('This input GPU frame already has a retained reader.'), {
        code: 'ERR_RTC_INPUT_DUPLICATE', status: 8, nativeOwnershipRetained: true,
        sourceId: args[0], frameId: args[1]?.frameId,
      });
    if (this.pending.size >= 128 || this.bytesPending + bytes.length > 32 * 1024 * 1024
      || (method === 'submitEncodedFrame' && this.encodedPending >= 16)
      || (method === 'submitAudioPacket' && this.audioPending >= 8)
      || (inputKey && this.inputFrames.size >= 16)) throw queueFull();
    const id = ++this.nextId, record = { ...deferred(), method, bytes: bytes.length };
    record.retirementOperation = method === 'request' && ['resource.close', 'audio.stopOutput'].includes(args[1]);
    if (method === 'submitAudioPacket') {
      const packet = args[1];
      record.identity = { sourceId: args[0], epoch: packet.epoch, sequence: packet.sequence,
        frameIndex: packet.frameIndex, frames: packet.frames };
      this.audioPending++;
    }
    if (method === 'submitFrame') {
      record.identity = { sourceId: args[0], frameId: args[1].frameId };
      record.inputKey = inputKey;
      this.inputFrames.set(inputKey, record.identity);
    }
    if (method === 'submitEncodedFrame') this.encodedPending++;
    this.bytesPending += bytes.length;
    this.pending.set(id, record);
    const timeout = method === 'releaseFrame' ? Math.min(this.options.operationTimeoutMs ?? 12000, 8000)
      : (this.options.operationTimeoutMs ?? 12000) + 1000;
    record.timer = setTimeout(() => this.fail(hostFailure(`Native RTC ${method} timed out.`)), timeout);
    try { this.sendBytes(bytes, error => this.fail(error)); }
    catch (error) { this.fail(error); }
    return record.promise;
  }

  request(...args) { return this.call('request', args); }
  respond(...args) { return this.call('respond', args); }
  cancel(...args) {
    void this.call('cancel', args).catch(error => {
      // Completion can win the IPC cancellation race. The original request,
      // never this failed cancel, still owns completion/retirement.
      if (['ERR_RTC_UNKNOWN_REQUEST', 'ERR_RTC_NOT_FOUND', 'NOT_FOUND'].includes(error.code)
        || (error.code === 'ERR_RTC_REQUEST_ID' && error.status === 4)) return;
      this.fail(error);
    });
  }
  submitFrame(...args) { return this.call('submitFrame', args); }
  submitEncodedFrame(...args) { return this.call('submitEncodedFrame', args); }
  submitAudioPacket(sourceId, packet) {
    const identity = { sourceId, epoch: packet.epoch, sequence: packet.sequence,
      frameIndex: packet.frameIndex, frames: packet.frames };
    if ([...this.pending.values()].some(record => record.method === 'submitAudioPacket'
      && record.identity.sourceId === sourceId && record.identity.epoch === packet.epoch
      && record.identity.sequence === packet.sequence)) {
      return Promise.reject(Object.assign(new Error('This PCM identity already has pending native processing.'), {
        ...identity, code: 'ERR_RTC_AUDIO_DUPLICATE', status: 8,
        nativeOwnershipRetained: false, processingPending: true,
      }));
    }
    try {
      if (this.failure || this.hostExited) throw this.failure ?? hostFailure('Native RTC host is closed.');
      return this.call('submitAudioPacket', [sourceId, packet]);
    } catch (error) {
      return Promise.reject(Object.assign(new Error(error.message), error, {
        ...identity, nativeOwnershipRetained: false, processingPending: false,
      }));
    }
  }
  grantAudioCredits(...args) { return this.call('grantAudioCredits', args); }
  audioClockProbe(...args) { return this.call('audioClockProbe', args); }
  calibrateAudioClock(...args) { return this.call('calibrateAudioClock', args); }
  setAudioOutputFeedback(...args) { return this.call('setAudioOutputFeedback', args); }
  snapshot() {
    return { ...structuredClone(this.lastSnapshot), process: {
      isolated: true, pid: this.pid ?? this.child.pid, exited: this.hostExited === true, cached: true,
      pendingCalls: this.pending.size, pendingBytes: this.bytesPending, externalTextureLeases: this.leases.size,
      unprovenInputGpuLeases: this.inputFrames.size,
    } };
  }
  async refreshSnapshot() {
    this.observeSnapshot(await this.call('snapshot', []));
    return this.snapshot();
  }

  async releaseFrame(frameId, reason) {
    const lease = this.leases.get(frameId);
    assert.ok(lease && !lease.proof, 'Unknown or already released external texture.');
    assert.ok(['unused', 'all-references-released'].includes(reason));
    lease.proof = reason;
    try {
      let result;
      if (this.failure && !this.hostExited) await this.exitState.promise;
      if (!this.hostExited) {
        try { result = await this.call('releaseFrame', [frameId, reason]); }
        catch (error) { if (!this.hostExited) throw error; }
      }
      if (!this.hostExited) {
        assert.equal(result?.frameId, frameId, 'Native GPU retirement identified a different frame.');
        assert.equal(result?.ok, true, 'Native GPU retirement was not confirmed.');
      }
      lease.handle.close();
      this.leases.delete(frameId);
      lease.released.resolve();
      return this.hostExited ? { frameId, ok: true, hostExited: true, gpuRetirementConfirmed: false } : result;
    } catch (error) {
      if (error.nativeOwnershipRetained === false) {
        lease.handle.close();
        this.leases.delete(frameId);
        lease.released.resolve();
      }
      lease.proof = null;
      throw error;
    }
  }

  close() {
    if (!this.closeWork) {
      const work = this.finishClose();
      this.closeWork = work;
      void work.catch(() => { if (this.closeWork === work) this.closeWork = null; });
    }
    return this.closeWork;
  }

  async finishClose() {
    await this.ready.catch(() => {});
    while (this.leases.size) await Promise.all([...this.leases.values()].map(lease => lease.released.promise));
    if (!this.hostExited && !this.failure) {
      try {
        this.lastSnapshot = await this.call('close', []);
        this.closeAcknowledged = true;
      } catch (error) { if (!this.hostExited) this.fail(error); }
    }
    await this.exitState.promise;
    while (this.leases.size) await Promise.all([...this.leases.values()].map(lease => lease.released.promise));
    if (this.inputFrames.size) throw Object.assign(new Error(
      'The RTC host exited before imported input GPU readers retired; producer ownership remains retained.'), {
      code: 'ERR_RTC_GPU_INPUT_RETIREMENT', nativeOwnershipRetained: true, hostExited: true,
    });
    assert.equal(this.leases.size, 0, 'Chromium texture ownership survived native host closure.');
    return this.snapshot();
  }
}

module.exports = { ProcessEngine };
