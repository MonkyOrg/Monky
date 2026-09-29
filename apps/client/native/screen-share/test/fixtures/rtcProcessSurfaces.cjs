'use strict';

const assert = require('node:assert/strict');
const leases = new Set();
module.exports = {
  leases,
  openSender(name) {
    assert.equal(name, 'fixture-mach-channel');
    return { close() {}, sendSurface(id, frameId) {
      assert.equal(id.readBigUInt64LE(), 7n);
      assert.equal(frameId, 1);
    } };
  },
  createReceiver(pid) {
    assert.ok(pid > 0 && pid !== process.pid);
    return { name: 'fixture-mach-channel', close() {}, receiveSurface(frameId, width, height) {
      assert.equal(frameId, 1);
      assert.deepEqual([width, height], [4, 2]);
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(0x12345678n);
      const lease = { handle, closed: false, close() {
        assert.equal(this.closed, false);
        this.closed = true;
        leases.delete(this);
      } };
      leases.add(lease);
      return lease;
    } };
  },
};
