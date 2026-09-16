function authoredOggPreview() {
  const page = (packets, sequence, flags, granule) => {
    const header = Buffer.alloc(27 + packets.length);
    header.write('OggS'); header[5] = flags; header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(1, 14); header.writeUInt32LE(sequence, 18); header[26] = packets.length;
    packets.forEach((packet, index) => { header[27 + index] = packet.length; });
    const bytes = Buffer.concat([header, ...packets]);
    let crc = 0;
    for (const byte of bytes) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
    }
    bytes.writeUInt32LE(crc, 22);
    return bytes;
  };
  const header = Buffer.alloc(19);
  header.write('OpusHead'); header[8] = 1; header[9] = 2; header.writeUInt32LE(48000, 12);
  const tags = Buffer.alloc(16); tags.write('OpusTags');
  return Buffer.concat([
    page([header], 0, 2, 0), page([tags], 1, 0, 0),
    page(Array.from({ length: 25 }, () => Buffer.from([0xf8, 0xff, 0xfe])), 2, 4, 25 * 960),
  ]);
}

module.exports = { authoredOggPreview };
