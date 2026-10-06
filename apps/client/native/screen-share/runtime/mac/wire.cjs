'use strict';

const assert = require('node:assert/strict');

const MAGIC = 0x4d435331;
const MAX_JSON = 1024 * 1024;
const MAX_PAYLOAD = 4 * 1024 * 1024;

function encode(header, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  assert.ok(json.length > 0 && json.length <= MAX_JSON && Buffer.isBuffer(payload) && payload.length <= MAX_PAYLOAD);
  const prefix = Buffer.alloc(12);
  prefix.writeUInt32BE(MAGIC, 0);
  prefix.writeUInt32BE(json.length, 4);
  prefix.writeUInt32BE(payload.length, 8);
  return Buffer.concat([prefix, json, payload]);
}

class Decoder {
  constructor(receive) {
    this.receive = receive;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.blocked = false;
  }
  push(bytes) {
    assert.ok(Buffer.isBuffer(bytes) && !this.blocked, 'Native macOS output arrived while its pipe was paused.');
    assert.ok(this.buffer.length + bytes.length <= MAX_JSON + MAX_PAYLOAD + 12 + 65536,
      'Native macOS output exceeded its bounded frame buffer.');
    this.buffer = Buffer.concat([this.buffer, bytes]);
    return this.drain();
  }
  drain() {
    this.blocked = false;
    for (;;) {
      if (this.pending) {
        const accepted = this.receive(this.pending.header, this.pending.payload);
        assert.ok(accepted === undefined || accepted === false, 'Native packet admission must be synchronous.');
        if (accepted === false) { this.blocked = true; return false; }
        this.pending = null;
      }
      if (this.buffer.length < 12) return true;
      assert.equal(this.buffer.readUInt32BE(0), MAGIC, 'Invalid native macOS wire identity.');
      const jsonBytes = this.buffer.readUInt32BE(4), payloadBytes = this.buffer.readUInt32BE(8);
      assert.ok(jsonBytes > 0 && jsonBytes <= MAX_JSON && payloadBytes <= MAX_PAYLOAD, 'Invalid native macOS wire bounds.');
      const size = 12 + jsonBytes + payloadBytes;
      if (this.buffer.length < size) return true;
      const header = JSON.parse(this.buffer.toString('utf8', 12, 12 + jsonBytes));
      assert.ok(header && typeof header === 'object' && !Array.isArray(header));
      this.pending = { header, payload: Buffer.from(this.buffer.subarray(12 + jsonBytes, size)) };
      this.buffer = this.buffer.subarray(size);
    }
  }
  end() {
    assert.ok(!this.pending && this.buffer.length === 0, 'Native macOS pipe ended with an unretired or truncated frame.');
  }
}

module.exports = { encode, Decoder, MAX_JSON, MAX_PAYLOAD };
