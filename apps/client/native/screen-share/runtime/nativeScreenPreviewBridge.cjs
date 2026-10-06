'use strict';

const assert = require('node:assert/strict');
const { NATIVE_SCREEN_PREVIEW_IPC, nativeScreenPreviewInfoSchema, nativeScreenPreviewReceiptSchema,
  nativeScreenVideoProfileSchema } = require('@monky/shared');

const MAX_PACKETS = 16;
const MAX_BYTES = 8 * 1024 * 1024;

class NativeScreenPreviewBridge {
  constructor({ frame, info, createMessageChannel, onState, onError }) {
    this.info = nativeScreenPreviewInfoSchema.parse(info);
    this.onState = onState; this.onError = onError;
    this.pending = new Map();
    this.bytes = 0; this.sequence = 0; this.closed = false; this.needsKeyframe = true;
    this.pipelineId = null; this.state = 'waiting';
    const { port1, port2 } = createMessageChannel();
    this.port = port1;
    this.message = event => {
      try {
        const receipt = nativeScreenPreviewReceiptSchema.parse(event.data);
        const packet = this.pending.get(receipt.sequence);
        assert.ok(packet, 'Preview receipt does not belong to an outstanding packet.');
        this.pending.delete(receipt.sequence);
        this.bytes -= packet.bytes;
        if (packet.pipelineId === this.pipelineId) {
          if (receipt.needsKeyframe) this.needsKeyframe = true;
          if (receipt.rendered) this.setState('playing');
        }
      } catch (error) { this.fail(error); }
    };
    this.port.on('message', this.message);
    this.disconnected = () => { if (!this.closed) this.fail(new Error('The local preview port closed unexpectedly.')); };
    this.port.on('close', this.disconnected);
    this.port.start();
    try { frame.postMessage(NATIVE_SCREEN_PREVIEW_IPC.port, this.info, [port2]); }
    catch (error) { port2.close(); this.close(); throw error; }
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  offer(frame, pipelineId, video) {
    if (this.closed) return;
    try {
      if (pipelineId !== this.pipelineId) {
        this.pipelineId = pipelineId;
        this.needsKeyframe = true;
      }
      if (this.needsKeyframe && !frame.keyframe) return;
      const bytes = frame.data.byteLength;
      if (this.pending.size >= MAX_PACKETS || this.bytes + bytes > MAX_BYTES) {
        // Preview is best-effort; never backpressure the original H.264 sender.
        this.needsKeyframe = true;
        return;
      }
      nativeScreenVideoProfileSchema.parse(video);
      assert.ok(Number.isSafeInteger(this.sequence + 1));
      const sequence = ++this.sequence;
      this.pending.set(sequence, { pipelineId, bytes });
      this.bytes += bytes;
      this.port.postMessage({ type: 'packet', sequence, pipelineId, video,
        ...(frame.codec === 'av1' ? { codec: 'av1' } : {}),
        timestampUs: frame.timestampUs, keyframe: frame.keyframe, data: frame.data });
      this.needsKeyframe = false;
    } catch (error) { this.fail(error); }
  }

  reset(state = 'waiting') {
    assert.ok(state === 'waiting' || state === 'paused');
    if (this.closed) return;
    this.pipelineId = null; this.needsKeyframe = true;
    try { this.port.postMessage({ type: 'reset' }); this.setState(state); }
    catch (error) { this.fail(error); }
  }

  fail(error) {
    if (this.closed) return;
    this.setState('unavailable');
    this.close();
    this.onError(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.port.off('message', this.message);
    this.port.off('close', this.disconnected);
    this.port.close();
    this.pending.clear(); this.bytes = 0;
  }
}

module.exports = { NativeScreenPreviewBridge, MAX_PACKETS, MAX_BYTES };
