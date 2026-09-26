'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cloneSource } = require('./captureProtocol.cjs');
const { validatePreviewImage } = require('./nativePreviewImage.cjs');

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_ACTIVE = 4;
const MAX_PENDING = 32;
const TIMEOUT_MS = 5000;

function failure(code, hresult) {
  const error = new Error(`Native desktop preview failed (${code}).`);
  error.code = code;
  if (hresult !== undefined) error.hresult = hresult;
  return error;
}

function cancelled() {
  return new DOMException('Native desktop preview was cancelled.', 'AbortError');
}

function argumentsFor(source, width, height) {
  assert.ok(Number.isSafeInteger(width) && width > 0 && width <= 640);
  assert.ok(Number.isSafeInteger(height) && height > 0 && height <= 360);
  if (source.kind === 'monitor') return ['--monitor', source.deviceId, source.deviceName,
    ...['x', 'y', 'width', 'height'].map(key => String(source.bounds[key])), String(width), String(height)];
  assert.equal(source.kind, 'window', 'Picker thumbnails require a window or monitor, never a game hook.');
  return ['--window', String(source.hwnd), String(source.expectedProcessId),
    source.expectedProcessCreationTime100ns, String(width), String(height)];
}

class NativeThumbnailCapturer {
  constructor(host) {
    assert.equal(host?.kind, 'verified-native-thumbnail-host');
    assert.ok(path.isAbsolute(host.executable));
    this.host = host;
    this.queue = [];
    this.active = new Set();
    this.closed = false;
    this.retirement = null;
  }

  capture(target, { signal, width = 320, height = 180 } = {}) {
    const source = cloneSource(target), args = argumentsFor(source, width, height);
    if (this.closed || signal?.aborted) return Promise.reject(cancelled());
    if (this.queue.length + this.active.size >= MAX_PENDING)
      return Promise.reject(failure('ERR_DESKTOP_PREVIEW_BUSY'));
    return new Promise((resolve, reject) => {
      const job = { args, width, height, signal, resolve, reject, abort: null };
      job.abort = () => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener('abort', job.abort);
        reject(cancelled());
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    while (!this.closed && this.active.size < MAX_ACTIVE && this.queue.length) {
      const job = this.queue.shift();
      job.signal?.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) { job.reject(cancelled()); continue; }
      const abort = new AbortController();
      const owner = { abort, done: null };
      this.active.add(owner);
      const propagate = () => abort.abort();
      job.signal?.addEventListener('abort', propagate, { once: true });
      owner.done = this.run(job, abort.signal).then(job.resolve, job.reject).finally(() => {
        job.signal?.removeEventListener('abort', propagate);
        this.active.delete(owner);
        this.pump();
      });
    }
  }

  run(job, signal) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.host.executable, job.args,
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch {
        reject(failure('ERR_DESKTOP_PREVIEW_SPAWN'));
        return;
      }
      let error = null, bytes = 0, stderr = '', settled = false;
      const chunks = [];
      const stop = reason => {
        error ??= reason;
        // Keep the slot until close: a timeout is not process retirement.
        if (child.pid) child.kill();
      };
      const onAbort = () => stop(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop(failure('ERR_DESKTOP_PREVIEW_TIMEOUT')), TIMEOUT_MS);
      child.stdout.on('data', chunk => {
        if (error) return;
        bytes += chunk.length;
        if (bytes > MAX_IMAGE_BYTES) { stop(failure('ERR_DESKTOP_PREVIEW_OUTPUT')); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', chunk => {
        if (stderr.length < 512) stderr += chunk.toString('utf8').slice(0, 512 - stderr.length);
      });
      for (const pipe of [child.stdout, child.stderr])
        pipe.on('error', () => stop(failure('ERR_DESKTOP_PREVIEW_PIPE')));
      child.on('error', () => { error ??= failure('ERR_DESKTOP_PREVIEW_SPAWN'); });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) { reject(error); return; }
        if (code !== 0) {
          if (code === 124) { reject(failure('ERR_DESKTOP_PREVIEW_TIMEOUT')); return; }
          const reason = /^ERR_DESKTOP_PREVIEW_[A-Z_]{1,32}(?=\s|$)/u.exec(stderr)?.[0]
            ?? 'ERR_DESKTOP_PREVIEW_CAPTURE';
          const hresult = /^ERR_DESKTOP_PREVIEW_[A-Z_]{1,32} HRESULT=0x([0-9a-f]{8})\r?\n?$/iu.exec(stderr)?.[1];
          reject(failure(reason, hresult === undefined ? undefined : Number.parseInt(hresult, 16)));
          return;
        }
        try { resolve(validatePreviewImage(Buffer.concat(chunks, bytes), job.width, job.height)); }
        catch { reject(failure('ERR_DESKTOP_PREVIEW_OUTPUT')); }
      });
      if (signal.aborted) onAbort();
    });
  }

  close() {
    if (this.retirement) return this.retirement;
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener('abort', job.abort);
      job.reject(cancelled());
    }
    for (const owner of this.active) owner.abort.abort();
    this.retirement = Promise.all([...this.active].map(owner => owner.done)).then(() => undefined);
    return this.retirement;
  }
}

module.exports = { NativeThumbnailCapturer };
