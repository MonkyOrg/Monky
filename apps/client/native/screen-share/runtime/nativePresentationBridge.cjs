'use strict';

const { boundedCleanup } = require('./frameSink.cjs');
const { isPresentationId } = require('./presentationRoute.cjs');

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const coordinate = value => Number.isSafeInteger(value) && value >= 0;
const dimension = value => positiveId(value) && value <= 16384 && value % 2 === 0;

function decodedTextureInfo(event) {
  const data = event?.data;
  const info = data?.textureInfo;
  const coded = info?.codedSize, rect = info?.visibleRect, color = info?.colorSpace;
  const handle = info?.handle?.ntHandle;
  if (event?.type !== 'frame' || !positiveId(event.target) || !positiveId(data?.frameId)
    || data.format !== 'NV12' || data.gpuCopy !== true || info?.pixelFormat !== 'nv12'
    || !Number.isSafeInteger(data.timestampUs) || data.timestampUs < -1 || info.timestamp !== data.timestampUs
    || !dimension(coded?.width) || !dimension(coded?.height)
    || coded.width !== data.codedWidth || coded.height !== data.codedHeight
    || !coordinate(rect?.x) || !coordinate(rect?.y) || rect.x % 2 !== 0 || rect.y % 2 !== 0
    || !dimension(rect.width) || !dimension(rect.height)
    || rect.width !== data.width || rect.height !== data.height
    || rect.x + rect.width > coded.width || rect.y + rect.height > coded.height
    || color?.primaries !== 'bt709' || color.transfer !== 'bt709'
    || color.matrix !== 'bt709' || color.range !== 'limited'
    || !Buffer.isBuffer(handle) || handle.length !== 8 || handle.buffer instanceof SharedArrayBuffer) {
    throw new Error('Invalid native decoded NV12 texture descriptor.');
  }
  return {
    pixelFormat: 'nv12', handle: { ntHandle: Buffer.from(handle) },
    codedSize: { width: coded.width, height: coded.height },
    visibleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    timestamp: data.timestampUs,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' },
  };
}

class NativePresentationBridge {
  constructor(engine, textures, onError, { drainTimeoutMs = 5000 } = {}) {
    if (typeof engine?.releaseFrame !== 'function' || typeof engine.request !== 'function'
      || typeof engine.submitFrame !== 'function'
      || typeof textures?.importSharedTexture !== 'function' || typeof textures?.sendSharedTexture !== 'function'
      || typeof onError !== 'function' || !Number.isInteger(drainTimeoutMs)
      || drainTimeoutMs < 1 || drainTimeoutMs > 60000) {
      throw new Error('Native presentation requires an engine, shared-texture API and error observer.');
    }
    this.engine = engine;
    this.textures = textures;
    this.onError = onError;
    this.drainTimeoutMs = drainTimeoutMs;
    this.accepting = true;
    this.leases = new Map();
    this.transfers = new Set();
    this.drainWork = null;
    this.imported = 0;
    this.delivered = 0;
    this.dropped = 0;
    this.retired = 0;
    this.maximumOutstanding = 0;
    this.errors = [];
  }

  report(value) {
    const error = value instanceof Error ? value : new Error(String(value));
    this.errors.push(error);
    this.stopAccepting();
    try { this.onError(error); }
    catch (observerError) {
      this.errors.push(observerError instanceof Error ? observerError : new Error(String(observerError)));
      console.error('Native presentation error observer failed:', observerError);
    }
  }

  publish(event, destination = null) {
    const transfer = this.publishFrame(event, destination);
    this.transfers.add(transfer);
    void transfer.then(
      () => { this.transfers.delete(transfer); },
      error => { this.transfers.delete(transfer); this.report(error); },
    );
    return transfer;
  }

  async publishFrame(event, destination) {
    const frameId = event?.data?.frameId;
    if (!positiveId(frameId) || this.leases.has(frameId)) {
      throw new Error('Invalid or duplicate native decoded frame ID; ownership is retained.');
    }
    let resolveRetired;
    const lease = {
      frameId, imported: null, importAttempted: false, releaseReason: null, releasePending: null,
      retired: new Promise(resolve => { resolveRetired = resolve; }),
      resolveRetired: () => resolveRetired(),
    };
    this.leases.set(frameId, lease);
    this.maximumOutstanding = Math.max(this.maximumOutstanding, this.leases.size);
    let info;
    try {
      info = decodedTextureInfo(event);
      if (destination !== null && (!isPresentationId(destination?.presentationId)
        || typeof destination.frame?.isDestroyed !== 'function')) {
        throw new Error('Invalid native presentation destination.');
      }
      if (!this.accepting || !destination || destination.frame.isDestroyed() || destination.frame.detached) {
        this.dropped++;
        this.beginRelease(lease, 'unused');
        return { frameId, imported: false };
      }
    } catch (error) {
      this.beginRelease(lease, 'unused');
      throw error;
    }

    let failure = null;
    try {
      // A throwing import may still have crossed the external ownership boundary.
      lease.importAttempted = true;
      lease.imported = this.textures.importSharedTexture({
        textureInfo: info,
        allReferencesReleased: () => { this.beginRelease(lease, 'all-references-released'); },
      });
      if (!lease.imported || typeof lease.imported.release !== 'function') {
        throw new Error('Native texture import did not return an owned wrapper; ownership is retained.');
      }
      this.imported++;
      await this.textures.sendSharedTexture({
        frame: destination.frame, importedSharedTexture: lease.imported,
      }, { frameId, timestampUs: event.data.timestampUs, presentationId: destination.presentationId });
      this.delivered++;
    } catch (error) {
      failure = error;
    } finally {
      try { if (typeof lease.imported?.release === 'function') lease.imported.release(); }
      catch (error) {
        failure = failure
          ? new AggregateError([failure, error], 'Native texture transfer and wrapper release failed.') : error;
      }
    }
    if (failure) throw failure;
    return { frameId, imported: true };
  }

  beginRelease(lease, reason) {
    if (this.leases.get(lease.frameId) !== lease || lease.releasePending) return lease.releasePending;
    if ((reason === 'unused' && lease.importAttempted)
      || (reason === 'all-references-released' && !lease.importAttempted)
      || (lease.releaseReason && lease.releaseReason !== reason)) {
      this.report(new Error('Conflicting native texture retirement proof; ownership is retained.'));
      return null;
    }
    lease.releaseReason = reason;
    const pending = Promise.resolve().then(() => {
      const release = this.engine.releaseFrame(lease.frameId, reason);
      if (!release || typeof release.then !== 'function') {
        throw new Error('Native ABI2 frame release did not return a retirement Promise; ownership is retained.');
      }
      return release;
    }).then(result => {
      if (result?.frameId !== lease.frameId || result.ok !== true) {
        throw new Error('Native frame retirement completion is invalid; ownership is retained.');
      }
      return result;
    });
    lease.releasePending = pending;
    void pending.then(
      () => this.completeRelease(lease),
      error => {
        lease.releasePending = null;
        if (error?.nativeOwnershipRetained === false) this.completeRelease(lease);
        this.report(error);
      },
    );
    return pending;
  }

  completeRelease(lease) {
    if (this.leases.get(lease.frameId) !== lease) return;
    this.leases.delete(lease.frameId);
    this.retired++;
    lease.resolveRetired();
  }

  retryRelease(frameId) {
    const lease = this.leases.get(frameId);
    if (!lease?.releaseReason) throw new Error('No native texture retirement proof is available for this frame.');
    return this.beginRelease(lease, lease.releaseReason);
  }

  stopAccepting() {
    this.accepting = false;
  }

  getStats() {
    return {
      imported: this.imported, delivered: this.delivered, dropped: this.dropped, retired: this.retired,
      outstandingLeases: this.leases.size, maximumOutstanding: this.maximumOutstanding,
      pendingTransfers: this.transfers.size,
      errors: this.errors.map(error => error.message),
    };
  }

  async waitForRetirement() {
    while (this.transfers.size || this.leases.size) {
      await Promise.all([
        Promise.allSettled([...this.transfers]),
        Promise.all([...this.leases.values()].map(lease => lease.retired)),
      ]);
    }
  }

  async stop() {
    this.stopAccepting();
    if (!this.drainWork) {
      const work = this.waitForRetirement();
      this.drainWork = work;
      void work.then(() => { if (this.drainWork === work) this.drainWork = null; });
    }
    await boundedCleanup(this.drainWork,
      'Native presentation cleanup timed out; GPU leases remain owned.', this.drainTimeoutMs);
    return this.getStats();
  }
}

module.exports = { NativePresentationBridge };
