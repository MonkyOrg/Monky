import { MediaError } from './errors';

/** Incremental Ogg demuxer for the single Opus stream emitted by our FFmpeg. */
export class OggOpusParser {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private packetBytes = 0;
  private headers = 0;
  private serial: number | undefined;
  private sequence = 0;
  private ended = false;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 256 * 1024 || this.buffer.length + chunk.length > 320 * 1024) this.invalid();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets: Uint8Array[] = [];
    while (this.buffer.length >= 27) {
      if (this.ended || this.buffer.toString('ascii', 0, 4) !== 'OggS' || this.buffer[4] !== 0) this.invalid();
      const segments = this.buffer[26];
      if (this.buffer.length < 27 + segments) break;
      const sizes = this.buffer.subarray(27, 27 + segments);
      const length = 27 + segments + sizes.reduce((total, size) => total + size, 0);
      if (this.buffer.length < length) break;
      const flags = this.buffer[5];
      const serial = this.buffer.readUInt32LE(14);
      const sequence = this.buffer.readUInt32LE(18);
      if (this.serial === undefined) {
        if (!(flags & 2) || sequence !== 0) this.invalid();
        this.serial = serial;
      } else if (flags & 2) this.invalid();
      if (serial !== this.serial || sequence !== this.sequence++ ||
          Boolean(flags & 1) !== (this.packetBytes > 0) || (flags & ~7)) this.invalid();
      let offset = 27 + segments;
      for (const size of sizes) {
        this.fragments.push(this.buffer.subarray(offset, offset + size));
        this.packetBytes += size;
        offset += size;
        if (this.packetBytes > 65536 || (this.headers >= 2 && this.packetBytes > 1275)) this.invalid();
        if (size === 255) continue;
        const packet = Buffer.concat(this.fragments, this.packetBytes);
        this.fragments = [];
        this.packetBytes = 0;
        if (this.headers === 0) {
          if (packet.length < 19 || packet.toString('ascii', 0, 8) !== 'OpusHead' || packet[8] !== 1) this.invalid();
          this.headers++;
        } else if (this.headers === 1) {
          if (packet.length < 16 || packet.toString('ascii', 0, 8) !== 'OpusTags') this.invalid();
          this.headers++;
        } else {
          if (!packet.length) this.invalid();
          const config = packet[0] >> 3;
          const frameMs = config < 12 ? [10, 20, 40, 60][config % 4]
            : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
          const code = packet[0] & 3;
          const count = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 63 : 2;
          if (frameMs * count !== 20) this.invalid();
          packets.push(packet);
        }
      }
      this.ended = Boolean(flags & 4);
      this.buffer = this.buffer.subarray(length);
    }
    return packets;
  }

  finish(): void {
    if (this.buffer.length || this.packetBytes || this.headers !== 2 || !this.ended) this.invalid();
  }

  private invalid(): never {
    throw new MediaError('unavailable', 'Invalid or oversized Ogg Opus stream');
  }
}
