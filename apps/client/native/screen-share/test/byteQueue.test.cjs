'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ByteQueue } = require('../runtime/byteQueue.cjs');
const { HEADER_BYTES, MAGIC, LiveFrames } = require('../runtime/capturePackets.cjs');
const { encode, Decoder, MAX_PAYLOAD } = require('../runtime/mac/wire.cjs');

const chunked = (bytes, size) => Array.from({ length: Math.ceil(bytes.length / size) },
  (_value, index) => bytes.subarray(index * size, (index + 1) * size));

function windowsPacket(payload, fps = 60) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0); header.writeUInt32LE(1, 4);
  header.writeUInt32LE(HEADER_BYTES, 8); header.writeUInt32LE(payload.length, 12);
  header.writeBigUInt64LE(1n, 16); header.writeBigUInt64LE(1n, 24);
  header.writeBigUInt64LE(10000000n, 32); header.writeBigUInt64LE(10000000n, 40);
  header.writeBigInt64LE(1000000n, 48); header.writeBigInt64LE(0n, 56);
  header.writeBigInt64LE(-1n, 64); header.writeBigInt64LE(1000000n, 72);
  header.writeUInt32LE(1, 80); header.writeUInt32LE(fps, 84);
  header.writeUInt32LE(1, 88); header.writeUInt32LE(1000, 92);
  return Buffer.concat([header, payload]);
}

// Counts the bytes of every copy a framing can make: concatenation, copying Buffer.from and the
// destination of an explicit copy. Node's own concat does not go through the public allocUnsafe.
function countCopies(t) {
  const allocate = Buffer.allocUnsafe, concat = Buffer.concat, from = Buffer.from;
  const counter = { bytes: 0 };
  t.mock.method(Buffer, 'allocUnsafe', size => { counter.bytes += size; return allocate.call(Buffer, size); });
  t.mock.method(Buffer, 'concat', (...values) => {
    const result = concat.apply(Buffer, values);
    counter.bytes += result.length;
    return result;
  });
  t.mock.method(Buffer, 'from', (...values) => {
    const result = from.apply(Buffer, values);
    if (ArrayBuffer.isView(values[0])) counter.bytes += result.length;
    return result;
  });
  return counter;
}

test('a range inside one chunk is returned without copying and a spanning range is copied only once', () => {
  // Buffer.alloc is never pooled, so a view into it shares its exact ArrayBuffer.
  const queue = new ByteQueue(), first = Buffer.alloc(6), second = Buffer.alloc(4);
  first.write('abcdef'); second.write('ghij');
  queue.push(first); queue.push(Buffer.alloc(0)); queue.push(second);
  assert.equal(queue.length, 10);
  const inside = queue.peek(3, 1);
  assert.equal(inside.toString(), 'bcd');
  assert.ok(inside.buffer === first.buffer && inside.byteOffset === first.byteOffset + 1,
    'A range inside one chunk must not be copied.');
  const spanning = queue.peek(4, 4);
  assert.equal(spanning.toString(), 'efgh');
  assert.ok(spanning.buffer !== first.buffer && spanning.buffer !== second.buffer);
  const again = queue.peek(4, 4);
  assert.ok(again.buffer === spanning.buffer && again.byteOffset === spanning.byteOffset,
    'Reading the same range again must not copy it again.');
  assert.equal(queue.peek(10).toString(), 'abcdefghij');
  assert.equal(queue.length, 10, 'Peeking never consumes.');
  queue.skip(5);
  assert.equal(queue.length, 5);
  assert.equal(queue.peek(5).toString(), 'fghij');
  queue.skip(5);
  assert.equal(queue.length, 0);
  assert.equal(queue.peek(0).length, 0);
  assert.throws(() => queue.peek(1), /not buffered/);
  assert.throws(() => queue.skip(1), /not buffered/);
  assert.throws(() => queue.push('text'), /Buffer/);
});

test('Windows live framing of a 4 MiB frame in 8 KiB chunks copies each byte at most once, also under backpressure', t => {
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < payload.length; index += 4096) payload[index] = index / 4096 % 251;
  const chunks = chunked(windowsPacket(payload), 8192);
  let accept = false;
  const frames = [], parser = new LiveFrames(message => {
    if (message.type !== 'packet') return;
    if (!accept) return false;
    frames.push(message.frame);
  }, 60);
  const copied = countCopies(t);
  for (const chunk of chunks.slice(0, -1)) assert.equal(parser.push(chunk), true);
  assert.equal(parser.push(chunks.at(-1)), false, 'A refused frame stays buffered.');
  assert.equal(parser.drain(), false);
  assert.equal(parser.bufferedBytes, HEADER_BYTES + payload.length);
  accept = true;
  assert.equal(parser.drain(), true);
  assert.ok(copied.bytes <= payload.length + HEADER_BYTES,
    `Framing must copy linearly, not re-concatenate on every chunk (${copied.bytes} bytes copied).`);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data, payload);
  assert.equal(parser.bufferedBytes, 0);
});

test('Windows live framing produces the same packets whatever the chunk boundaries', () => {
  const stream = Buffer.concat([windowsPacket(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]))]);
  for (const size of [1, 7, 95, 96, 97, 8192]) {
    const frames = [], parser = new LiveFrames(message => {
      if (message.type === 'packet') frames.push(message.frame);
    }, 60);
    for (const chunk of chunked(stream, size)) parser.push(chunk);
    assert.equal(frames.length, 1, `chunk size ${size}`);
    assert.deepEqual(frames[0].data, Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]));
    assert.equal(parser.bufferedBytes, 0);
  }
});

test('macOS framing of a 4 MiB frame in 8 KiB chunks copies each byte at most once, also under backpressure', t => {
  const payload = Buffer.alloc(MAX_PAYLOAD);
  for (let index = 0; index < payload.length; index += 4096) payload[index] = index / 4096 % 251;
  const chunks = chunked(encode({ type: 'video', id: 1 }, payload), 8192);
  let accept = false;
  const received = [], decoder = new Decoder((header, bytes) => {
    if (!accept) return false;
    received.push({ header, bytes });
  });
  const copied = countCopies(t);
  for (const chunk of chunks.slice(0, -1)) assert.equal(decoder.push(chunk), true);
  assert.equal(decoder.push(chunks.at(-1)), false, 'A refused frame stays pending.');
  accept = true;
  assert.equal(decoder.drain(), true);
  assert.ok(copied.bytes <= payload.length + 64,
    `Framing must copy linearly, not re-concatenate on every chunk (${copied.bytes} bytes copied).`);
  decoder.end();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].header, { type: 'video', id: 1 });
  assert.deepEqual(received[0].bytes, payload);
});

test('macOS framing splits frames sharing one chunk and frames spanning several identically', () => {
  const stream = Buffer.concat([encode({ type: 'result', id: 1 }), encode({ type: 'result', id: 2 }, Buffer.from('png')),
    encode({ type: 'result', id: 3 }, Buffer.alloc(20000, 7))]);
  for (const size of [1, 5, 13, 4096, stream.length]) {
    const received = [], decoder = new Decoder((header, payload) => { received.push({ id: header.id, payload }); });
    for (const chunk of chunked(stream, size)) decoder.push(chunk);
    decoder.end();
    assert.deepEqual(received.map(value => value.id), [1, 2, 3], `chunk size ${size}`);
    assert.equal(received[0].payload.length, 0);
    assert.equal(received[1].payload.toString(), 'png');
    assert.deepEqual(received[2].payload, Buffer.alloc(20000, 7));
  }
});
