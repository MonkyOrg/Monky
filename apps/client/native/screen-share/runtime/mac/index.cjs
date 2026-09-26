'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MacNativeHost, failure } = require('./host.cjs');
const { validatePreviewImage } = require('../nativePreviewImage.cjs');
const { validateMacTarget } = require('./target.cjs');

const MINIMUM_MACOS = '14.0';
const DEFAULT_DIRECTORY = path.resolve(__dirname, '..', '..', 'bin', `darwin-${process.arch}`);
const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = (value, min = 1, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

function loadMacCaptureRuntime(directory = DEFAULT_DIRECTORY, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch))
    throw failure('ERR_MAC_PLATFORM', 'Native macOS media requires macOS 14+ on arm64 or x64.');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'mac-capture-build.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, 'darwin');
  assert.equal(manifest.arch, arch);
  assert.equal(manifest.minimumMacOS, MINIMUM_MACOS);
  assert.equal(manifest.executable.name, 'monky-screen-mac');
  const filename = path.join(directory, manifest.executable.name);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === manifest.executable.bytes);
  assert.equal(createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), manifest.executable.sha256);
  return Object.freeze({ kind: 'verified-screencapturekit-host', executable: filename,
    minimumMacOS: MINIMUM_MACOS, arch, manifest: Object.freeze(manifest) });
}

function sourceIdentity(source) {
  assert.ok(source && typeof source === 'object' && typeof source.name === 'string' && source.name.length <= 512);
  assert.ok(integer(source.width) && integer(source.height));
  if (source.kind === 'monitor') {
    return validateMacTarget({ platform: 'darwin', kind: 'monitor', displayId: source.displayId,
      displayUuid: source.displayUuid, bounds: source.bounds });
  }
  assert.equal(source.kind, 'window');
  return validateMacTarget({ platform: 'darwin', kind: 'window', windowId: source.windowId,
    expectedProcessId: source.processId, expectedProcessStartTimeUs: source.processStartTimeUs });
}

class MacScreenProvider {
  constructor(options = {}, dependencies = {}) {
    this.runtime = dependencies.runtime ?? loadMacCaptureRuntime(options.directory);
    this.hostFactory = dependencies.hostFactory ?? (() => new MacNativeHost(this.runtime.executable));
    this.sources = new Map();
    this.generation = 0;
    this.excludeProcessIds = new Set(options.excludeProcessIds ?? [process.pid]);
  }
  getHost() {
    if (this.closed) throw failure('ERR_MAC_PROVIDER_CLOSED', 'Native macOS source provider is closed.');
    if (!this.host || this.host.exited) {
      this.sources.clear();
      this.host = this.hostFactory();
    }
    return this.host;
  }
  async capabilities(options = {}) {
    const { value } = await this.getHost().request('capabilities', {}, options.signal);
    assert.equal(value.platform, 'darwin');
    assert.equal(value.minimumMacOS, MINIMUM_MACOS);
    assert.equal(value.enumeration, 'ScreenCaptureKit');
    assert.equal(value.thumbnails, 'SCScreenshotManager');
    assert.equal(value.capture, false);
    assert.equal(value.encoder, null);
    assert.equal(value.transport, false);
    assert.equal(value.receive, false);
    assert.equal(value.audio, false);
    return Object.freeze(value);
  }
  async listSources(options = {}) {
    const host = this.getHost(), generation = ++this.generation;
    const { value } = await host.request('list', {}, options.signal);
    assert.ok(Array.isArray(value.sources) && value.sources.length <= 512);
    if (host !== this.host || generation !== this.generation || this.closed)
      throw new DOMException('Source enumeration was superseded.', 'AbortError');
    const next = new Map(), rows = [];
    for (const source of value.sources) {
      const target = sourceIdentity(source);
      if (target.kind === 'window' && this.excludeProcessIds.has(target.expectedProcessId)) continue;
      const hash = identity(target);
      const id = target.kind === 'monitor' ? `native-monitor:${hash}` : `window:${target.windowId}:${hash}`;
      assert.ok(!next.has(id), 'Native macOS enumeration contained duplicate identities.');
      next.set(id, Object.freeze(target));
      rows.push({ id, name: source.name, type: target.kind === 'monitor' ? 'screen' : 'window',
        thumbnailDataUrl: '', appIconDataUrl: null, thumbnailState: 'pending',
        ...(target.kind === 'monitor' ? { displayNumber: rows.filter(row => row.type === 'screen').length + 1 } : {}) });
    }
    this.sources = next;
    return rows;
  }
  async resolveTarget(sourceId, kind, options = {}) {
    const host = this.getHost(), target = this.sources.get(sourceId);
    if (!target || target.kind !== kind)
      throw failure('ERR_SCREEN_CAPTURE_SOURCE_LOST', 'The selected native macOS source is no longer registered.');
    const { value } = await host.request('resolve', { target }, options.signal);
    assert.deepEqual(value.target, target, 'Native macOS source ownership changed.');
    if (host !== this.host || this.closed || this.sources.get(sourceId) !== target)
      throw new DOMException('Source ownership was superseded.', 'AbortError');
    return Object.freeze({ ...target });
  }
  async thumbnail(sourceId, { signal, width = 320, height = 180 } = {}) {
    assert.ok(integer(width, 1, 640) && integer(height, 1, 360));
    const host = this.getHost();
    const target = this.sources.get(sourceId);
    if (!target) throw failure('ERR_SCREEN_CAPTURE_SOURCE_LOST', 'Native thumbnail source is no longer registered.');
    const { value, payload } = await host.request('thumbnail', { target, width, height }, signal);
    assert.equal(value.mimeType, 'image/png');
    validatePreviewImage(payload, width, height);
    if (host !== this.host || this.closed || this.sources.get(sourceId) !== target)
      throw new DOMException('Thumbnail ownership was superseded.', 'AbortError');
    return payload;
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    ++this.generation;
    this.sources.clear();
    const host = this.host;
    this.closePromise = host ? host.close().catch(error => {
      // Only byte copies leave this source host. After its OS exit no native
      // screenshot callback or external GPU lease remains owned by Main.
      if (!host.exited || host.pending.size !== 0) throw error;
      console.warn('[MacScreenProvider] Source host retired with an earlier failure:', error.code ?? error.name);
    }) : Promise.resolve();
    return this.closePromise;
  }
}

function createMacScreenProvider(options) { return new MacScreenProvider(options); }

function loadMacRuntime(options = {}) {
  const capture = loadMacCaptureRuntime(options.directory);
  // Capture support is not a transport implementation. Do not let Main enable
  // publishing/receiving merely because the ScreenCaptureKit executable exists.
  throw failure('ERR_MAC_RTC_UNAVAILABLE',
    'Native macOS WebRTC transport and cross-process IOSurface presentation are not available in this build.',
    { captureBackendAvailable: !!capture, nativeReceiveAvailable: false });
}

module.exports = { MINIMUM_MACOS, createMacScreenProvider, loadMacCaptureRuntime, loadMacRuntime,
  MacScreenProvider, sourceIdentity, validateMacTarget, MacVideoCapture: require('./capture.cjs').MacVideoCapture };
