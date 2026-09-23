const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');

async function releaseReservations(releases) {
  const errors = [];
  for (const release of releases.reverse()) {
    try { await release(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Could not release owned SFU port reservations.');
}

async function reservePort(port, releases) {
  const tcp = net.createServer(socket => socket.destroy());
  releases.push(() => new Promise((resolve, reject) => tcp.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  })));
  await new Promise((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      tcp.removeListener('error', reject);
      resolve();
    });
  });
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  releases.push(() => new Promise((resolve, reject) => {
    try { udp.close(resolve); }
    catch (error) {
      if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve();
      else reject(error);
    }
  }));
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind({ port, address: '0.0.0.0', exclusive: true }, () => {
      udp.removeListener('error', reject);
      resolve();
    });
  });
}

async function chooseSfuPorts() {
  const addresses = Object.values(os.networkInterfaces()).flat().filter(address => address?.family === 'IPv4');
  const size = Math.max(32, 5 * (addresses.length + 1) * 2 + 16);
  assert.ok(size <= 256, 'Too many interface candidates for the bounded SFU smoke port range.');
  let conflict;
  for (let attempt = 0; attempt < 8; attempt++) {
    const minPort = randomInt(20_000, 39_000 - size);
    const maxPort = minPort + size - 1;
    const releases = [];
    try {
      for (let port = minPort; port <= maxPort; port++) await reservePort(port, releases);
    } catch (error) {
      await releaseReservations(releases);
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      conflict = error;
      continue;
    }
    // Only the test's own reservations close. A later allocation race remains
    // an actual SFU failure; no retry or process termination happens after this.
    await releaseReservations(releases);
    return { minPort, maxPort };
  }
  throw new Error('No bounded contiguous UDP/TCP range was available for the isolated SFU.', { cause: conflict });
}

async function configureRealSfu(testContext, modulePath) {
  const ports = await chooseSfuPorts();
  const module = require(modulePath);
  const RealSfuManager = module.SfuManager;
  let manager;
  const constructor = testContext.mock.method(module, 'SfuManager', function() {
    assert.equal(manager, undefined, 'This fixture configures exactly one real server SFU manager.');
    manager = new RealSfuManager({
      listenIp: '127.0.0.1', announcedIp: '127.0.0.1',
      rtcMinPort: ports.minPort, rtcMaxPort: ports.maxPort,
    });
    return manager;
  });
  testContext.after(() => {
    constructor.mock.restore();
    assert.equal(module.SfuManager, RealSfuManager);
  });
  return {
    ports,
    snapshot: () => ({
      ports, ready: manager?.isReady() ?? false, error: manager?.getLastError() ?? null,
      listenIp: '127.0.0.1', announcedIp: manager?.getAnnouncedIp(),
    }),
    assertReady() {
      assert.ok(manager, 'MonkyServer must construct the actual configured SFU manager.');
      assert.deepEqual(manager.getPortRange(), ports);
      assert.equal(manager.isReady(), true, manager.getLastError() ?? 'The real mediasoup worker is not ready.');
    },
  };
}

module.exports = { configureRealSfu };
