'use strict';

const assert = require('node:assert/strict');
const { TextDecoder } = require('node:util');
const base = require('./captureProtocol.cjs');
const HEADER_BYTES = 96, MAGIC = 0x31484c4d;
const MAX_BUFFER_BYTES = base.MAX_PACKET_BYTES + HEADER_BYTES + 65536;
const utf8 = new TextDecoder('utf8', { fatal: true });

function bounded(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assert.ok(value >= BigInt(minimum) && value <= BigInt(maximum), 'Native live integer exceeds its bound.');
  return Number(value);
}

function parseHeader(bytes, fps) {
  base.integer(fps, 1, 240);
  assert.equal(bytes.length, HEADER_BYTES);
  assert.equal(bytes.readUInt32LE(0), MAGIC, 'Live pipe magic changed.');
  const kind = bytes.readUInt32LE(4), payloadBytes = bytes.readUInt32LE(12);
  assert.ok([1, 2, 3].includes(kind)); assert.equal(bytes.readUInt32LE(8), HEADER_BYTES);
  assert.ok(payloadBytes > 0 && payloadBytes <= (kind === 1 ? base.MAX_PACKET_BYTES : 16384));
  const sequence = bounded(bytes.readBigUInt64LE(16), 1);
  if (kind !== 1) {
    assert.ok(bytes.subarray(24).every(byte => byte === 0), 'A live notice cannot claim packet metadata.');
    return { kind, sequence, payloadBytes };
  }
  const frame = {
    frameId: bounded(bytes.readBigUInt64LE(24), 1),
    observedQpc: bytes.readBigUInt64LE(32).toString(), qpcFrequency: bytes.readBigUInt64LE(40).toString(),
    timestampUs: bounded(bytes.readBigInt64LE(48), 1), pts: bytes.readBigInt64LE(56).toString(),
    dts: bytes.readBigInt64LE(64).toString(), systemDtsUs: bounded(bytes.readBigInt64LE(72), 1),
    timebaseNumerator: bytes.readUInt32LE(80), timebaseDenominator: bytes.readUInt32LE(84),
    keyframe: bytes.readUInt32LE(88), settingsBitrateKbps: bytes.readUInt32LE(92),
    durationUs: Math.floor(1000000 / fps), ntpTimeMs: -1,
  };
  assert.ok(BigInt(frame.observedQpc) > 0n && BigInt(frame.qpcFrequency) > 0n);
  assert.equal(frame.timebaseNumerator, 1); assert.equal(frame.timebaseDenominator, fps);
  assert.ok(frame.keyframe === 0 || frame.keyframe === 1);
  assert.ok(frame.settingsBitrateKbps >= 50 && frame.settingsBitrateKbps <= 80000 && frame.settingsBitrateKbps % 50 === 0);
  frame.keyframe = frame.keyframe === 1;
  return { kind, sequence, payloadBytes, frame };
}

class LiveFrames {
  constructor(onFrame, fps) {
    assert.equal(typeof onFrame, 'function');
    base.integer(fps, 1, 240);
    this.fps = fps;
    this.onFrame = onFrame; this.pending = Buffer.alloc(0); this.sequence = 0; this.packets = 0;
  }
  push(chunk) {
    assert.ok(Buffer.isBuffer(chunk) && chunk.length <= 65536);
    assert.ok(this.pending.length + chunk.length <= MAX_BUFFER_BYTES);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    return this.drain();
  }
  drain() {
    while (this.pending.length >= HEADER_BYTES) {
      const header = parseHeader(this.pending.subarray(0, HEADER_BYTES), this.fps);
      if (this.pending.length < HEADER_BYTES + header.payloadBytes) break;
      assert.equal(header.sequence, this.sequence + 1, 'Live pipe sequence was lost or replayed.');
      assert.equal(this.closed, undefined, 'Live pipe emitted data after retirement.');
      const body = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + header.payloadBytes);
      if (header.kind === 1) {
        assert.equal(header.frame.frameId, this.packets + 1);
        if (this.lastFrame) {
          assert.equal(header.frame.qpcFrequency, this.lastFrame.qpcFrequency);
          for (const field of ['pts', 'dts', 'observedQpc'])
            assert.ok(BigInt(header.frame[field]) > BigInt(this.lastFrame[field]), `Live ${field} regressed.`);
          assert.ok(header.frame.timestampUs > this.lastFrame.timestampUs);
        } else {
          assert.equal(header.frame.keyframe, true); assert.equal(header.frame.pts, '0');
        }
        const admission = this.onFrame({ type: 'packet', frame: { ...header.frame, data: body } });
        assert.ok(admission === undefined || admission === false, 'Live AU admission must be synchronous.');
        if (admission === false) return false;
        this.lastFrame = header.frame; this.packets++;
      } else {
        const value = JSON.parse(utf8.decode(body));
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        if (header.kind === 3) {
          assert.equal(value.kind, 'closed'); assert.equal(value.packets, this.packets);
          assert.equal(value.writtenPackets, this.packets); assert.equal(value.retainedFrames, 0);
          assert.equal(value.retainedBytes, 0); assert.equal(value.workerDrained, true);
          if (value.failure !== undefined && value.failure !== null) base.validateFailure(value.failure);
          assert.ok(Number.isInteger(value.peakFrames) && value.peakFrames >= 1 && value.peakFrames <= 16);
          assert.ok(Number.isInteger(value.peakBytes) && value.peakBytes >= HEADER_BYTES && value.peakBytes <= 8 * 1024 * 1024);
          if (Object.hasOwn(value, 'backpressureWaits')) {
            assert.ok(Number.isSafeInteger(value.backpressureWaits) && value.backpressureWaits >= 0);
            assert.ok(Number.isSafeInteger(value.maxBackpressureMs) && value.maxBackpressureMs >= 0
              && value.maxBackpressureMs <= 500);
          }
          this.closed = value;
        }
        this.onFrame({ type: header.kind === 3 ? 'closed' : 'notice', value });
      }
      this.pending = this.pending.subarray(HEADER_BYTES + header.payloadBytes);
      this.sequence++;
    }
    return true;
  }
  end() {
    assert.equal(this.pending.length, 0, 'Live pipe ended with a split packet.');
    assert.ok(this.closed, 'Live pipe ended before actual writer retirement.');
  }
}

module.exports = { ...base, HEADER_BYTES, MAGIC, MAX_BUFFER_BYTES, LiveFrames, parseHeader };
