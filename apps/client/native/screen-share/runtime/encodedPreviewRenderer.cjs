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

function av1Codec(data) {
  let cursor = 0;
  while (cursor < data.length) {
    const header = data[cursor++], type = (header >> 3) & 15;
    if ((header & 0x81) || !(header & 2)) throw new Error('Invalid AV1 preview OBU header.');
    if (header & 4) {
      if (cursor >= data.length || data[cursor++] !== 0) throw new Error('AV1 preview requires L1T1.');
    }
    let size = 0, complete = false;
    for (let index = 0; index < 8; index++) {
      if (cursor >= data.length) throw new Error('Truncated AV1 OBU size.');
      const part = data[cursor++];
      size += (part & 127) * 2 ** (index * 7);
      if (!Number.isSafeInteger(size)) throw new Error('AV1 OBU size exceeds its bound.');
      if (!(part & 128)) { complete = true; break; }
    }
    if (!complete || size > data.length - cursor) throw new Error('AV1 OBU exceeds preview packet.');
    if (type === 1) {
      const end = (cursor + size) * 8;
      let position = cursor * 8;
      const read = count => {
        if (position + count > end) throw new Error('Truncated AV1 sequence header.');
        let result = 0;
        for (let i = 0; i < count; i++, position++)
          result = result * 2 + ((data[Math.floor(position / 8)] >> (7 - position % 8)) & 1);
        return result;
      };
      const profile = read(3);
      read(1);
      const reduced = read(1);
      if (profile !== 0 || reduced) throw new Error('Unsupported AV1 preview sequence profile.');
      let decoderModel = false;
      if (read(1)) {
        read(32); read(32);
        if (read(1)) {
          let zeros = 0;
          while (!read(1)) if (++zeros > 31) throw new Error('Invalid AV1 timing interval.');
          read(zeros);
        }
        decoderModel = Boolean(read(1));
        if (decoderModel) { read(5); read(32); read(5); read(5); }
      }
      read(1);
      const operatingPoints = read(5) + 1;
      const point = read(12), level = read(5);
      const tier = level > 7 ? read(1) : 0;
      if (operatingPoints !== 1 || point !== 0 || level > 23)
        throw new Error('Unsupported AV1 preview operating point.');
      return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.08`;
    }
    cursor += size;
  }
  throw new Error('The preview keyframe is missing its AV1 sequence header.');
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
      throw new Error('The local preview decoder is unavailable or already attached.');
    this.port = port;
    this.message = event => {
      if (this.closed) return;
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
      const config = { codec: packet.codec === 'av1' ? av1Codec(packet.data) : h264Codec(packet.data),
        codedWidth: packet.video.width, codedHeight: packet.video.height,
        optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
      const supported = await this.platform.VideoDecoder.isConfigSupported(config);
      if (this.closed || !this.pending.has(packet.sequence)) return;
      if (!supported.supported) throw new Error(`The local preview does not support this ${packet.codec === 'av1' ? 'AV1' : 'H.264'} stream.`);
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

module.exports = { EncodedPreviewRenderer, h264Codec, av1Codec };
