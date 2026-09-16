const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID, sign } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { MessageType, PROTOCOL_VERSION } = require('@monky/shared');
const { MonkyServer } = require('../../server/dist/server.js');
const discovery = require('../../server/dist/infrastructure/discovery/ServerIpScanner.js');
const { buildDirectory } = require('./native_test_paths.cjs');

class WirePeer {
  messages = [];
  waiters = new Set();
  failure = null;

  constructor(url) {
    this.socket = new WebSocket(url);
    this.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.matches(message)) waiter.finish(null, message);
      }
    });
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Fixture WebSocket closed')));
  }

  fail(error) {
    this.failure = error;
    for (const waiter of [...this.waiters]) waiter.finish(error);
  }

  wait(matches, since = 0, timeout = 10_000) {
    const existing = this.messages.slice(since).find(matches);
    if (existing) return Promise.resolve(existing);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        finish: (error, message) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          if (error) reject(error);
          else resolve(message);
        },
      };
      const timer = setTimeout(() => waiter.finish(new Error(
        `Fixture response timed out; recent types: ${this.messages.slice(-8).map(message => message.type).join(', ')}`,
      )), timeout);
      this.waiters.add(waiter);
    });
  }

  send(type, payload, requestId) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, 'Fixture socket must be open before send');
    this.socket.send(JSON.stringify({ type, payload, requestId }));
  }

  async request(type, payload, expectedTypes) {
    assert.equal(typeof type, 'string', 'Fixture request type must come from MessageType');
    assert.ok(expectedTypes.length > 0 && expectedTypes.every(value => typeof value === 'string'),
      'Fixture reply types must come from MessageType');
    const requestId = randomUUID();
    const response = this.wait(message => message.requestId === requestId &&
      (expectedTypes.includes(message.type) || message.type === MessageType.SERVER_ERROR));
    this.send(type, payload, requestId);
    const message = await response;
    if (message.type === MessageType.SERVER_ERROR) {
      const error = new Error(`${message.payload.code}: ${message.payload.message}`);
      error.code = message.payload.code;
      throw error;
    }
    return message;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    const timer = setTimeout(() => this.socket.terminate(), 3000);
    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.send(MessageType.USER_LOGOUT, {});
        this.socket.close(1000);
      } else {
        this.socket.terminate();
      }
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function createServerFixture(t, { voiceMode = 'p2p', password = '' } = {}) {
  t.mock.method(discovery, 'getPublicIp', async () => '127.0.0.1');
  const directory = fs.mkdtempSync(path.join(buildDirectory, 'server-fixture-'));
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const action of cleanup.reverse()) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      throw new AggregateError(errors, `Light fixture cleanup failed; preserved ${directory}`);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const server = await MonkyServer.create({
    port: 0, dataDir: path.join(directory, 'server'), serverName: 'Monky Light fixture',
    voiceMode, password, maxUsers: 20,
  });
  cleanup.push(() => server.stop());
  // Keep the real protocol, persistence and SFU, but never advertise this fixture on the LAN.
  t.mock.method(server.lanBroadcaster, 'start', async () => {});
  const listen = server.httpServer.listen.bind(server.httpServer);
  t.mock.method(server.httpServer, 'listen', () => listen(0, '127.0.0.1'));
  t.mock.method(server.coturnManager, 'buildIceServers', () => []);
  const setAnnouncedIp = server.sfuManager.setAnnouncedIp.bind(server.sfuManager);
  t.mock.method(server.sfuManager, 'setAnnouncedIp', () => setAnnouncedIp('127.0.0.1'));
  server.sfuManager.setAnnouncedIp('127.0.0.1');
  const { minPort, maxPort } = server.sfuManager.getPortRange();
  t.mock.method(server.sfuManager, 'getListenInfos', () => ['udp', 'tcp'].map(protocol => ({
    protocol, ip: '127.0.0.1', announcedAddress: '127.0.0.1',
    portRange: { min: minPort, max: maxPort },
  })));
  await server.start();
  const { port } = await server.getStats();
  const url = `ws://127.0.0.1:${port}`;
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  async function connectHuman(nickname, options = {}) {
    const keys = options.keys ?? generateKeyPairSync('ed25519');
    const deviceId = options.deviceId ?? randomUUID();
    const peer = new WirePeer(url);
    cleanup.push(() => peer.close());
    await once(peer.socket, 'open');
    const challenge = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname, deviceId,
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
      password: options.password ?? password,
    }, [MessageType.AUTH_CHALLENGE]);
    const signature = sign(null, Buffer.from(challenge.payload.nonce, 'hex'), keys.privateKey).toString('hex');
    const authenticated = await peer.request(
      MessageType.AUTH_CHALLENGE_RESPONSE, { signature }, [MessageType.AUTH_SUCCESS],
    );
    return { peer, keys, deviceId, auth: authenticated.payload };
  }

  return {
    directory, server, url, connectHuman,
    onCleanup(action) { cleanup.push(action); },
  };
}

module.exports = { createServerFixture, WirePeer };
