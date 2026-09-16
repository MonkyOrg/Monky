const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { test } = require('node:test');
const { WebSocketServer } = require('ws');
const { nativeExecutable } = require('./native_test_paths.cjs');

const executable = process.env.MONKY_LIGHT_WEBSOCKET_FIXTURE ||
  nativeExecutable('monky-light-websocket-fixture');

function run(url, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [url, scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Native WebSocket fixture timed out: ${scenario}`));
    }, 12_000);
    const collect = (data) => {
      output += data.toString();
      if (output.length > 64 * 1024) {
        child.kill();
        reject(new Error('Native fixture output limit exceeded'));
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Fixture ${scenario}: code=${code} signal=${signal}\n${output}`));
      else resolve();
    });
  });
}

async function server(t, handler) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const failures = [];
  wss.on('connection', (socket, request) => {
    socket.on('error', (error) => failures.push(error));
    handler(socket, request, failures);
  });
  await once(wss, 'listening');
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    assert.deepEqual(failures, []);
  });
  return `ws://127.0.0.1:${wss.address().port}`;
}

test('native WebSocket rejects invalid URLs, reuse and offline sends', { timeout: 15_000 }, async () => {
  await run('unused', 'invalid');
});

test('native WebSocket sends text, assembles fragmented UTF-8 and responds to control ping',
  { timeout: 15_000 }, async (t) => {
    let received = false;
    let pong = false;
    const url = await server(t, (socket, request, failures) => {
      if (request.url !== '/signaling?fixture=1') failures.push('path/query not preserved');
      if (request.headers['sec-websocket-protocol']) failures.push('unexpected subprotocol');
      socket.once('message', (bytes, binary) => {
        if (binary || bytes.toString() !== 'hello') failures.push('outgoing text mismatch');
        received = true;
        const bytesOut = Buffer.from('echo:olá 🐒');
        socket.send(bytesOut.subarray(0, bytesOut.length - 2), { binary: false, fin: false });
        socket.send(bytesOut.subarray(bytesOut.length - 2), { binary: false, fin: true });
        socket.ping('heartbeat');
      });
      socket.once('pong', (data) => {
        if (data.toString() !== 'heartbeat') failures.push('pong payload mismatch');
        pong = true;
        socket.send('pong-observed');
      });
    });
    await run(`${url}/signaling?fixture=1`, 'exchange');
    assert.ok(received);
    assert.ok(pong);
  });

test('native WebSocket bounds fragmented inbound messages', { timeout: 15_000 }, async (t) => {
  const url = await server(t, (socket) => {
    socket.send('x'.repeat(700), { fin: false });
    socket.send('x'.repeat(700), { fin: true });
  });
  await run(url, 'oversized');
});

test('native WebSocket default accepts an 8 MiB fragmented optional-content broadcast',
  { timeout: 15_000 }, async (t) => {
    const url = await server(t, (socket) => {
      const fragment = 'x'.repeat(512 * 1024);
      for (let index = 0; index < 16; index++)
        socket.send(fragment, { fin: index === 15 });
    });
    await run(url, 'large');
  });

for (const scenario of ['close', 'destroy', 'race']) {
  test(`native WebSocket safely handles ${scenario} during a receive callback`,
    { timeout: 15_000 }, async (t) => {
      let closed;
      let resolveClosed;
      const closeEvent = new Promise((resolve) => { resolveClosed = resolve; });
      const url = await server(t, (socket) => {
        socket.once('close', (code) => { closed = code; resolveClosed(); });
        socket.send('close-now');
      });
      await run(url, scenario);
      await Promise.race([
        closeEvent,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Server close timed out')), 2000);
          timer.unref();
          closeEvent.then(() => clearTimeout(timer));
        }),
      ]);
      if (scenario !== 'race') assert.equal(closed, 1000);
    });
}

test('native WebSocket handles peer close', { timeout: 15_000 }, async (t) => {
  const url = await server(t, (socket) => socket.close(1000, 'fixture finished'));
  await run(url, 'remote-close');
});

test('native WebSocket rejects binary signaling', { timeout: 15_000 }, async (t) => {
  const url = await server(t, (socket) => socket.send(Buffer.from([1, 2, 3])));
  await run(url, 'binary');
});

test('native WebSocket cancels a stalled upgrade without late callbacks',
  { timeout: 15_000 }, async (t) => {
    const sockets = new Set();
    const listener = http.createServer();
    listener.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    listener.on('upgrade', () => {});
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => listener.close(resolve));
    });
    await run(`ws://127.0.0.1:${listener.address().port}`, 'handshake-cancel');
  });

test('native WebSocket reports failed HTTP upgrade', { timeout: 15_000 }, async (t) => {
  const listener = http.createServer((_, response) => response.writeHead(403).end());
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  await run(`ws://127.0.0.1:${listener.address().port}`, 'failure');
});

test('native wss rejects an untrusted certificate without disabling OS trust',
  { timeout: 15_000 }, async (t) => {
    let upgraded = false;
    const listener = https.createServer(require('./websocket_tls_fixture.cjs'));
    listener.on('tlsClientError', () => {});
    listener.on('upgrade', (_, socket) => { upgraded = true; socket.destroy(); });
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    t.after(() => new Promise((resolve) => listener.close(resolve)));
    await run(`wss://127.0.0.1:${listener.address().port}`, 'failure');
    assert.equal(upgraded, false, 'TLS validation must fail before the HTTP upgrade');
  });

test('native WebSocket does not follow HTTP redirects', { timeout: 15_000 }, async (t) => {
  let redirected = false;
  const target = await server(t, () => { redirected = true; });
  const listener = http.createServer((_, response) => {
    response.writeHead(302, { Location: target }).end();
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  await run(`ws://127.0.0.1:${listener.address().port}`, 'failure');
  assert.equal(redirected, false);
});
