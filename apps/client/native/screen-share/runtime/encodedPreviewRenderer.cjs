'use strict';

const { nativeScreenPreviewPacketSchema } = require('@monky/shared');
const { boundedCleanup } = require('./frameSink.cjs');

function h264Codec(data) {
  for (let index = 0; index + 7 < data.length; index++) {
    if (data[index] !== 0 || data[index + 1] !== 0) continue;
    const offset = data[index + 2] === 1 ? index + 3
      : data[index + 2] === 0 && data[index + 3] === 1 ? index + 4 : -1;
    if (offset >= 0 && (data[offset] & 31) === 7)
      return 'avc1.' + [...data.subarray(offset + 1, offset + 4)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('The preview keyframe is missing its original H.264 SPS.');
}

class EncodedPreviewRenderer {
  constructor(sink, onError, platform = { VideoDecoder: globalThis.VideoDecoder, EncodedVideoChunk: globalThis.EncodedVideoChunk }) {
    this.sink = sink; this.onError = onError; this.platform = platform;
    this.pending = new Map(); this.operations = new Set();
    this.pipelineId = null; this.decoder = null; this.port = null; this.closed = false;
    this.tail = Promise.resolve(); this.needsKeyframe = true; this.lastSequence = 0;
  }

  attach(port) {
    if (this.closed || this.port || typeof this.platform.VideoDecoder !== 'function')
      throw new Error('The local H.264 preview decoder is unavailable or already attached.');
    this.port = port;
    this.message = event => {
      try {
        if (event.data?.type === 'reset' && Object.keys(event.data).length === 1) {
          this.reset();
          return;
        }
        const packet = nativeScreenPreviewPacketSchema.parse(event.data);
        if (packet.sequence <= this.lastSequence || this.pending.size >= 16)
          throw new Error('The local preview exceeded its ordered packet credits.');
        this.lastSequence = packet.sequence;
        const entry = { packet, decoder: null };
        this.pending.set(packet.sequence, entry);
        const work = this.tail.then(() => this.decode(entry));
        this.tail = work.catch(error => this.fail(error));
      } catch (error) { this.fail(error); }
    };
    this.messageError = () => this.fail(new Error('The local preview MessagePort could not deserialize its packet.'));
    port.addEventListener('message', this.message);
    port.addEventListener('messageerror', this.messageError);
    port.start();
  }

  receipt(entry, rendered = false, needsKeyframe = false) {
    if (this.pending.get(entry.packet.sequence) !== entry) return;
    this.pending.delete(entry.packet.sequence);
    if (!this.closed) {
      try { this.port?.postMessage({ sequence: entry.packet.sequence, rendered, needsKeyframe }); }
      catch (error) { this.fail(error); }
    }
  }

  async decode(entry) {
    if (this.closed || !this.pending.has(entry.packet.sequence)) return;
    const packet = entry.packet;
    if (packet.pipelineId !== this.pipelineId) {
      this.resetDecoder();
      this.pipelineId = packet.pipelineId;
    }
    if (this.needsKeyframe && !packet.keyframe) { this.receipt(entry, false, true); return; }
    if (!this.decoder) {
      const config = { codec: h264Codec(packet.data), codedWidth: packet.video.width, codedHeight: packet.video.height,
        optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
      const supported = await this.platform.VideoDecoder.isConfigSupported(config);
      if (this.closed || !this.pending.has(packet.sequence)) return;
      if (!supported.supported) throw new Error('The local preview does not support this H.264 stream.');
      const decoder = new this.platform.VideoDecoder({
        output: frame => this.output(decoder, frame),
        error: error => { if (this.decoder === decoder) this.fail(error); },
      });
      this.decoder = decoder;
      decoder.configure(config);
    }
    entry.decoder = this.decoder;
    this.needsKeyframe = false;
    this.decoder.decode(new this.platform.EncodedVideoChunk({
      type: packet.keyframe ? 'key' : 'delta', timestamp: packet.timestampUs, data: packet.data,
    }));
    // decode() copies the compressed input; only its receipt remains owned here.
    entry.packet = { ...packet, data: null };
  }

  output(decoder, frame) {
    const entry = [...this.pending.values()].find(value => value.decoder === decoder && value.packet.timestampUs === frame.timestamp);
    if (!entry || this.closed || decoder !== this.decoder) { frame.close(); return; }
    const work = this.sink.acceptFrame(frame, frame.timestamp, { frameId: entry.packet.sequence })
      .then(rendered => this.receipt(entry, rendered), error => this.fail(error));
    this.operations.add(work);
    void work.then(() => this.operations.delete(work), error => {
      this.operations.delete(work);
      this.fail(error);
    });
  }

  resetDecoder() {
    const decoder = this.decoder;
    this.decoder = null;
    this.needsKeyframe = true;
    if (decoder && decoder.state !== 'closed') decoder.close();
    for (const entry of [...this.pending.values()]) {
      if (entry.decoder === decoder && decoder) this.receipt(entry);
    }
  }

  reset() {
    this.resetDecoder();
    this.pipelineId = null;
    for (const entry of [...this.pending.values()]) this.receipt(entry);
  }

  fail(error) {
    if (this.closed) return;
    this.report(error);
    void this.stop().catch(cleanupError => this.report(cleanupError));
  }

  report(error) {
    try { this.onError(error); }
    catch (observerError) { console.error('Local preview error observer failed:', observerError); }
  }

  async stop() {
    this.closed = true;
    this.reset();
    if (this.port) {
      this.port.removeEventListener('message', this.message);
      this.port.removeEventListener('messageerror', this.messageError);
      this.port.close(); this.port = null;
    }
    await boundedCleanup(this.tail, 'The local preview decoder did not finish configuration.');
    await boundedCleanup(Promise.all([...this.operations]), 'The local preview frames did not retire.');
  }
}

module.exports = { EncodedPreviewRenderer, h264Codec };
