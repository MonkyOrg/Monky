'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Decoder } = require('./wire.cjs');

const failure = (code, message, detail = {}) => Object.assign(new Error(message), { code, ...detail });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const METHODS = new Set(['capabilities', 'permission', 'list', 'resolve', 'thumbnail', 'close',
  'media.probe', 'media.start', 'media.stop', 'media.bitrate', 'media.keyframe']);
const errorCode = value => typeof value === 'string' && /^ERR_MAC_[A-Z_]{1,48}$/u.test(value);

class MacNativeHost {
  constructor(executable, { timeoutMs = 15000, onError = error => console.error('[MacNativeHost]', error.code),
    onVideo } = {}, dependencies = {}) {
    assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 15000);
    this.timeoutMs = timeoutMs;
    this.onError = onError;
    assert.ok(onVideo === undefined || typeof onVideo === 'function');
    this.onVideo = onVideo;
    this.mediaSequence = 0;
    this.mediaEnd = deferred();
    void this.mediaEnd.promise.catch(() => {});
    this.pending = new Map();
    this.sequence = 0;
    this.exit = deferred();
    this.hello = deferred();
    this.ready = this.hello.promise;
    void this.ready.catch(() => {});
    this.child = (dependencies.spawn ?? spawn)(executable, [], {
      stdio: onVideo ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      windowsHide: true, shell: false,
    });
    this.control = new Decoder((message, payload) => this.receive(message, payload));
    this.child.stdout.on('data', bytes => {
      try { this.control.push(bytes); } catch (error) { this.fail(error); }
    });
    this.child.stdout.on('end', () => {
      try { this.control.end(); this.outputEnded = true; } catch (error) { this.fail(error); }
    });
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr])
      pipe.on('error', () => this.fail(failure('ERR_MAC_HOST_PIPE', 'Native macOS host pipe failed.')));
    this.child.stderr.resume();
    if (onVideo) {
      this.media = new Decoder((message, payload) => this.receiveVideo(message, payload));
      this.child.stdio[3].on('data', bytes => {
        try {
          if (!this.media.push(bytes)) {
            this.videoBackpressured = true;
            this.child.stdio[3].pause();
          }
        } catch (error) { this.fail(error); }
      });
      this.child.stdio[3].on('error', () => this.fail(failure('ERR_MAC_MEDIA_PIPE', 'Native macOS media pipe failed.')));
      this.child.stdio[3].on('end', () => {
        try {
          this.media.end();
          assert.ok(!this.mediaHello || this.mediaClosed);
          this.mediaEnd.resolve();
        } catch (error) { this.mediaEnd.reject(error); this.fail(error); }
      });
    }
    this.child.once('error', () => this.fail(failure('ERR_MAC_HOST_START', 'Native macOS host could not start.')));
    this.child.once('close', (code, signal) => {
      this.exited = true;
      clearTimeout(this.startTimer);
      clearTimeout(this.forceTimer);
      const error = this.failure ?? failure('ERR_MAC_HOST_EXIT', 'The owned native macOS host exited.', {
        hostExited: true, exitCode: code, signal,
      });
      this.hello.reject(error);
      if (this.failure) this.mediaEnd.reject(error);
      for (const record of this.pending.values()) { this.finishRecord(record); record.reject(error); }
      this.pending.clear();
      this.exit.resolve({ code, signal, hostExited: true });
      if (!this.closing && !this.failure) this.notify(error);
    });
    this.startTimer = setTimeout(() => this.fail(failure('ERR_MAC_HOST_START', 'Native macOS host startup timed out.')), timeoutMs);
  }
  notify(error) {
    try { this.onError(error); }
    catch (observerError) { console.error('[MacNativeHost] Failure observer threw:', observerError); }
  }
  fail(error) {
    if (this.exited || this.failure) return;
    this.failure = error;
    this.notify(error);
    try { this.child.kill('SIGTERM'); }
    catch { this.notify(failure('ERR_MAC_HOST_KILL', 'Could not signal the owned macOS host.')); }
    this.forceTimer = setTimeout(() => {
      if (this.exited) return;
      try { this.child.kill('SIGKILL'); }
      catch { this.notify(failure('ERR_MAC_HOST_KILL', 'Could not terminate the owned macOS host.')); }
    }, 1000);
  }
  receive(message, payload) {
    if (this.failure) return;
    if (message.type === 'hello') {
      assert.equal(message.protocol, 1);
      assert.equal(message.pid, this.child.pid);
      assert.equal(message.platform, 'darwin');
      assert.equal(this.initialized, undefined);
      assert.equal(payload.length, 0);
      this.initialized = true;
      clearTimeout(this.startTimer);
      this.hello.resolve(message);
      return;
    }
    if (message.type === 'failure') {
      assert.ok(errorCode(message.code));
      assert.ok(Number.isSafeInteger(message.nativeStatus));
      throw failure(message.code, 'Native macOS host failed.', { nativeStatus: message.nativeStatus });
    }
    assert.equal(message.type, 'result');
    const record = this.pending.get(message.id);
    assert.ok(record, 'Uncorrelated native macOS response.');
    let resultError;
    if (message.error) {
      assert.ok(errorCode(message.error.code));
      assert.ok(Number.isSafeInteger(message.error.nativeStatus));
      assert.equal(typeof message.error.nativeOwnershipRetained, 'boolean');
      assert.equal(payload.length, 0);
      resultError = failure(message.error.code, 'Native macOS operation failed.',
        { nativeStatus: message.error.nativeStatus });
      if (message.error.nativeOwnershipRetained) throw resultError;
    } else {
      assert.ok(message.value && typeof message.value === 'object' && !Array.isArray(message.value));
      if (record.method !== 'thumbnail') assert.equal(payload.length, 0);
    }
    this.pending.delete(message.id);
    this.finishRecord(record);
    if (resultError) record.reject(resultError);
    else record.resolve({ value: message.value, payload });
  }
  receiveVideo(message, payload) {
    if (this.failure) return;
    assert.equal(this.mediaRequested, true, 'Native video arrived without an explicit capture request.');
    if (message.type === 'hello') {
      assert.equal(this.mediaHello, undefined);
      assert.equal(message.pid, this.child.pid);
      assert.equal(message.protocol, 1);
      assert.equal(message.codec, 'h264');
      assert.equal(message.timebase, 'mach-host-us');
      assert.equal(payload.length, 0);
      this.mediaHello = true;
      return;
    }
    assert.equal(this.mediaHello, true);
    assert.equal(this.mediaClosed, undefined);
    if (message.type === 'failure') {
      assert.ok(errorCode(message.code) && Number.isSafeInteger(message.nativeStatus));
      throw failure(message.code, 'Native macOS capture failed.', { nativeStatus: message.nativeStatus });
    }
    if (message.type === 'closed') {
      assert.equal(payload.length, 0);
      assert.equal(message.packets, this.mediaSequence);
      assert.equal(message.writerDrained, true);
      assert.equal(message.retainedFrames, 0);
      assert.equal(message.retainedBytes, 0);
      this.mediaClosed = true;
      return;
    }
    assert.equal(message.type, 'video');
    assert.equal(message.id, this.mediaSequence + 1);
    assert.ok(Number.isSafeInteger(message.timestampUs) && message.timestampUs >= 0
      && (this.lastVideoTimestamp === undefined || message.timestampUs > this.lastVideoTimestamp));
    assert.ok(Number.isSafeInteger(message.durationUs) && message.durationUs > 0 && message.durationUs <= 1000000);
    assert.equal(typeof message.keyframe, 'boolean');
    assert.ok(payload.length > 0 && payload.length <= 4 * 1024 * 1024);
    if (this.mediaSequence === 0) assert.equal(message.keyframe, true);
    if (!this.discardVideo) {
      const accepted = this.onVideo({ frameId: message.id, timestampUs: message.timestampUs,
        durationUs: message.durationUs, keyframe: message.keyframe, data: payload, codec: 'h264', ntpTimeMs: -1 });
      assert.ok(accepted === undefined || accepted === false);
      if (accepted === false) return false;
    }
    this.mediaSequence = message.id;
    this.lastVideoTimestamp = message.timestampUs;
  }
  resumeVideo() {
    if (!this.videoBackpressured) return;
    try {
      if (this.media.drain()) {
        this.videoBackpressured = false;
        this.child.stdio[3].resume();
      }
    } catch (error) { this.fail(error); }
  }
  discardPendingVideo() {
    this.discardVideo = true;
    this.resumeVideo();
  }
  finishRecord(record) {
    clearTimeout(record.timer);
    record.signal?.removeEventListener('abort', record.abort);
  }
  write(message) {
    const bytes = Buffer.from(JSON.stringify(message) + '\n');
    assert.ok(bytes.length <= 65536 && this.child.stdin.writableLength + bytes.length <= 262144,
      'Native macOS command pipe is full.');
    if (this.exited || this.failure) throw this.failure ?? failure('ERR_MAC_HOST_EXIT', 'Native host is closed.');
    this.child.stdin.write(bytes);
  }
  async request(method, data = {}, signal) {
    assert.ok(METHODS.has(method));
    if (method === 'media.start') {
      assert.equal(typeof this.onVideo, 'function', 'Capture needs an owned media pipe.');
      assert.equal(this.mediaRequested, undefined, 'A capture owner cannot be reused for another source.');
    }
    signal?.throwIfAborted();
    const startupAbort = () => this.fail(new DOMException('Native macOS startup was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', startupAbort, { once: true });
    try { await this.ready; } finally { signal?.removeEventListener('abort', startupAbort); }
    signal?.throwIfAborted();
    if (this.exited || this.failure) throw this.failure ?? failure('ERR_MAC_HOST_EXIT', 'Native host is closed.');
    if (this.closing && method !== 'close') throw new DOMException('Native macOS host is closing.', 'AbortError');
    assert.ok(method === 'close' || this.pending.size < 16, 'Native macOS request credits are exhausted.');
    const id = ++this.sequence, result = deferred();
    const record = { ...result, signal, method };
    // Screenshot APIs have no cancellation receipt. Retire the isolated owner
    // and wait for OS exit rather than leaving callbacks alive in a shared host.
    record.abort = () => this.fail(new DOMException('Native macOS request was cancelled.', 'AbortError'));
    record.timer = setTimeout(() => this.fail(failure('ERR_MAC_HOST_TIMEOUT', 'Native macOS operation timed out.')), this.timeoutMs);
    this.pending.set(id, record);
    signal?.addEventListener('abort', record.abort, { once: true });
    if (method === 'media.start') this.mediaRequested = true;
    try { this.write({ id, method, data }); } catch (error) { this.fail(error); }
    return result.promise;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.discardPendingVideo();
    this.closePromise = (async () => {
      if (!this.exited && !this.failure) {
        try {
          const { value } = await this.request('close');
          assert.equal(value.nativeClosed, true, 'Native macOS resources did not acknowledge closure.');
          if (value.retiredWithErrors)
            this.notify(failure('ERR_MAC_RETIRED_WITH_ERRORS', 'Native media retired after a prior cleanup failure.'));
          this.nativeClosed = true;
        } catch (error) { this.fail(error); }
      }
      const timer = setTimeout(() => this.fail(failure('ERR_MAC_HOST_TIMEOUT', 'Native macOS host did not exit.')), this.timeoutMs);
      const exited = await this.exit.promise;
      clearTimeout(timer);
      if (this.failure) throw this.failure;
      assert.ok(this.nativeClosed && this.outputEnded && exited.code === 0 && exited.signal === null,
        'Native close requires resource, pipe, and normal OS-exit proof.');
      if (this.mediaHello) assert.equal(this.mediaClosed, true);
      return { nativeClosed: true, hostExited: true };
    })();
    return this.closePromise;
  }
}

module.exports = { MacNativeHost, failure };
