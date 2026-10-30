'use strict';

const assert = require('node:assert/strict');

/**
 * Bytes received from a stream pipe while their frame is incomplete. Chunks are kept as they
 * arrived: a range inside one chunk is returned without copying, and a range spanning chunks is
 * copied once into a single chunk that replaces the pieces it covered. Reading the same range
 * again (a header while its payload is still arriving, a frame retained by backpressure) never
 * copies again, so framing costs O(bytes) instead of re-concatenating everything on each chunk.
 */
class ByteQueue {
  #chunks = [];
  #length = 0;

  get length() { return this.#length; }

  push(chunk) {
    assert.ok(Buffer.isBuffer(chunk), 'A pipe chunk must be a Buffer.');
    if (!chunk.length) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  /** The buffered bytes [offset, offset + count), contiguous and not consumed. */
  peek(count, offset = 0) {
    this.#assertRange(count, offset);
    if (count === 0) return Buffer.alloc(0);
    let index = 0, start = 0;
    while (start + this.#chunks[index].length <= offset) start += this.#chunks[index++].length;
    const first = this.#chunks[index], from = offset - start;
    if (from + count <= first.length) return first.subarray(from, from + count);
    const bytes = Buffer.allocUnsafe(count);
    const pieces = from > 0 ? [first.subarray(0, from), bytes] : [bytes];
    let written = first.copy(bytes, 0, from), end = index + 1;
    for (;;) {
      const chunk = this.#chunks[end++], used = chunk.copy(bytes, written, 0, count - written);
      written += used;
      if (written === count) {
        if (used < chunk.length) pieces.push(chunk.subarray(used));
        break;
      }
    }
    this.#chunks.splice(index, end - index, ...pieces);
    return bytes;
  }

  /** Consumes the first `count` buffered bytes. */
  skip(count) {
    this.#assertRange(count, 0);
    this.#length -= count;
    let index = 0;
    while (count > 0 && count >= this.#chunks[index].length) count -= this.#chunks[index++].length;
    if (count > 0) this.#chunks[index] = this.#chunks[index].subarray(count);
    this.#chunks.splice(0, index);
  }

  #assertRange(count, offset) {
    assert.ok(Number.isSafeInteger(count) && Number.isSafeInteger(offset) && count >= 0 && offset >= 0
      && offset + count <= this.#length, 'The requested bytes are not buffered.');
  }
}

module.exports = { ByteQueue };
