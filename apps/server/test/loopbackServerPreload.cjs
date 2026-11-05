// Preloaded (`--require`) into a real server process forked by a CLI test: the
// server listens on an ephemeral loopback port and reports it to the test. The
// port belongs to the TLS/plain listener in front of the HTTP server (#860), a
// `net.Server`; wrapping the base class covers it and any HTTP server alike.
const net = require('node:net');
const path = require('node:path');

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function listenOnLoopback() {
  this.once('listening', () => process.send({ qaPort: this.address().port }));
  return listen.call(this, 0, '127.0.0.1');
};

require(path.resolve(__dirname, '../dist/infrastructure/discovery/LanBroadcaster.js'))
  .LanBroadcaster.prototype.start = async () => {};
