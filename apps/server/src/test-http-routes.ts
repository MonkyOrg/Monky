import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { ProtocolErrorCode } from '@monky/shared';
import { MonkyServer } from './server';
import { AttachmentService } from './application/services/AttachmentService';
import { LanBroadcaster } from './infrastructure/discovery/LanBroadcaster';
import * as ipScanner from './infrastructure/discovery/ServerIpScanner';
import { createHttpRequestListener } from './infrastructure/http/HttpRouter';
import { attachmentRoutes } from './infrastructure/http/attachmentRoutes';
import { isLocalRequest } from './infrastructure/http/publicRoutes';
import { serveFile } from './infrastructure/http/serveFile';
import { AttachmentStorageService } from './infrastructure/security/AttachmentStorageService';
import { createApprovedBotFixture } from './testFixtures/bots';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function collect(response: http.IncomingMessage): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    response.on('error', reject);
  });
}

/** Sends the path exactly as written: fetch() would normalize the dot segments under test. */
function send(port: number, options: {
  method?: string; path: string; headers?: http.OutgoingHttpHeaders; body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers, agent: false,
    }, (response) => { collect(response).then(resolve, reject); });
    request.on('error', reject);
    request.end(options.body);
  });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Sends a head announcing a body that never finishes arriving: a first unit of
 * it, then another every 100 ms. Returns the answer's status once the server has
 * closed the connection, and fails if the connection outlives the answer.
 */
async function trickleBody(port: number, head: string, unit = 'x'): Promise<number> {
  const socket = net.connect(port, '127.0.0.1');
  // The server may reset a connection it stopped reading; only the close matters here.
  socket.on('error', () => {});
  const closed = new Promise<'closed'>((resolve) => socket.once('close', () => resolve('closed')));
  let answer = '';
  socket.on('data', (chunk: Buffer) => { answer += chunk.toString('latin1'); });
  await once(socket, 'connect');
  socket.write(`${head}\r\n${unit}`);
  const drip = setInterval(() => { if (socket.writable) socket.write(unit); }, 100);
  let limit: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      closed,
      new Promise<'open'>((resolve) => { limit = setTimeout(() => resolve('open'), 2000); }),
    ]);
    assert.equal(outcome, 'closed', `the connection outlived its answer (${answer.split('\r\n')[0] || 'none'})`);
  } finally {
    clearTimeout(limit);
    clearInterval(drip);
    socket.destroy();
  }
  const status = /^HTTP\/1\.1 (\d{3}) /.exec(answer);
  assert.ok(status, 'the answer arrived before the connection closed');
  return Number(status[1]);
}

async function listen(t: test.TestContext, server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function startServer(t: test.TestContext): Promise<{ port: number; dataDir: string; server: MonkyServer }> {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-http-routes-'));
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const server = await MonkyServer.create({ port: address.port, dataDir, voiceMode: 'p2p', discoveryPort: 0 });
  t.after(async () => {
    try {
      await server.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await server.start();
  // The startup reconciliation removes files without a row; the ones a test writes must come after it.
  await server['waitForStartupTasks']();
  return { port: address.port, dataDir, server };
}

async function uploadFixture(t: test.TestContext, uploadIdleTimeoutMs?: number) {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const member = await f.human('Uploader');
  const channel = (await f.channelService.listChannels()).find((item) => item.type === 'TEXT');
  assert.ok(channel);
  const storage = new AttachmentStorageService(f.dataDir);
  const attachments = new AttachmentService(f.attachmentRepo, f.serverRepo, storage, f.rateLimiter);
  const port = await listen(t, http.createServer(createHttpRequestListener(attachmentRoutes({
    attachments, storage, canUpload: async () => true, uploadIdleTimeoutMs,
  }))));
  const uploadPath = () => {
    const issued = attachments.issueUploadToken(member.id, channel.id);
    assert.ok(issued);
    return `/attachments?token=${issued.token}&name=notes.txt`;
  };
  return { f, port, uploadPath, tmpDir: path.join(f.dataDir, 'attachments', 'tmp') };
}

test('a route that throws or rejects answers 500 and the listener keeps serving (S-WS-1)', async (t) => {
  const port = await listen(t, http.createServer(createHttpRequestListener([
    { methods: ['GET'], path: '/throws', handle: () => { throw new Error('synchronous failure'); } },
    { methods: ['GET'], path: '/rejects', handle: async () => { throw new Error('asynchronous failure'); } },
    { methods: ['GET'], path: '/ok', handle: (_req, res) => { res.end('ok'); } },
  ])));
  assert.equal((await send(port, { path: '/throws' })).status, 500);
  assert.equal((await send(port, { path: '/rejects' })).status, 500);
  const ok = await send(port, { path: '/ok?with=query' });
  assert.equal(ok.status, 200, 'routes are matched without their query string');
  assert.equal(ok.headers['access-control-allow-origin'], '*');
  assert.equal((await send(port, { method: 'POST', path: '/ok' })).status, 404);
  const preflight = await send(port, { method: 'OPTIONS', path: '/attachments' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
});

test('malformed names, dot segments and folders answer 404 instead of stopping the server (S-WS-1)', async (t) => {
  const { port } = await startServer(t);
  for (const target of [
    '/avatars/%', '/attachments/%E0%A4%A', '/attachments/tmp', '/attachments/%2e', '/attachments/%2E%2E',
    '/avatars/.', '/avatars/..', '/avatars/', '/attachments/', '/attachments/tmp%2Fx.part', '/avatars/%00',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await send(port, { method, path: target })).status, 404, `${method} ${target}`);
    }
  }
  assert.equal((await send(port, { path: '/health' })).status, 200, 'the server is still up');
});

test('downloads share Range, HEAD and nosniff, and attachments stay out of shared caches', async (t) => {
  const { port, dataDir } = await startServer(t);
  const image = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(1000, 7)]);
  const imageName = `${randomUUID()}.png`;
  const documentName = `${randomUUID()}.bin`;
  const avatarName = `${randomUUID()}.png`;
  fs.writeFileSync(path.join(dataDir, 'attachments', imageName), image);
  fs.writeFileSync(path.join(dataDir, 'attachments', documentName), 'plain bytes');
  fs.writeFileSync(path.join(dataDir, 'avatars', avatarName), image);
  const imagePath = `/attachments/${imageName}`;

  const full = await send(port, { path: imagePath });
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, image);
  assert.equal(full.headers['content-type'], 'image/png');
  assert.equal(full.headers['content-length'], String(image.length));
  assert.equal(full.headers['cache-control'], 'private, max-age=86400');
  assert.equal(full.headers['x-content-type-options'], 'nosniff');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['access-control-allow-origin'], '*');
  assert.equal(full.headers['content-disposition'], undefined, 'validated images render inline');

  const head = await send(port, { method: 'HEAD', path: imagePath });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(image.length));
  assert.equal(head.body.length, 0);

  const start = await send(port, { path: imagePath, headers: { range: 'bytes=0-9' } });
  assert.equal(start.status, 206);
  assert.equal(start.headers['content-range'], `bytes 0-9/${image.length}`);
  assert.deepEqual(start.body, image.subarray(0, 10));
  const suffix = await send(port, { path: imagePath, headers: { range: 'bytes=-5' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], `bytes ${image.length - 5}-${image.length - 1}/${image.length}`);
  assert.deepEqual(suffix.body, image.subarray(-5), 'a suffix range is the end of the file, not its start');
  const open = await send(port, { path: imagePath, headers: { range: `bytes=${image.length - 3}-` } });
  assert.deepEqual(open.body, image.subarray(-3));
  const beyond = await send(port, { path: imagePath, headers: { range: `bytes=${image.length}-` } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers['content-range'], `bytes */${image.length}`);

  const document = await send(port, { path: `/attachments/${documentName}` });
  assert.equal(document.headers['content-type'], 'application/octet-stream');
  assert.equal(document.headers['content-disposition'], 'attachment');

  const avatar = await send(port, { path: `/avatars/${avatarName}?v=2` });
  assert.equal(avatar.status, 200);
  assert.deepEqual(avatar.body, image);
  assert.equal(avatar.headers['cache-control'], 'public, max-age=86400');
  assert.equal(avatar.headers['x-content-type-options'], 'nosniff');
  assert.equal(avatar.headers['content-length'], String(image.length));
  const avatarStart = await send(port, { path: `/avatars/${avatarName}`, headers: { range: 'bytes=0-7' } });
  assert.equal(avatarStart.status, 206);
  assert.deepEqual(avatarStart.body, PNG_SIGNATURE);
});

test('an aborted download closes its file instead of leaking the descriptor (S-WS-1)', async (t) => {
  const { port, dataDir } = await startServer(t);
  const name = `${randomUUID()}.mp4`;
  fs.writeFileSync(path.join(dataDir, 'attachments', name), Buffer.alloc(32 * 1024 * 1024));
  const opened: Array<{ file: string; handle: fs.promises.FileHandle }> = [];
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    opened.push({ file: String(args[0]), handle });
    return handle;
  });
  for (const range of [undefined, 'bytes=0-']) {
    const before = opened.length;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/attachments/${name}`, headers: range ? { range } : {}, agent: false }, resolve)
        .on('error', reject);
    });
    assert.equal(response.statusCode, range ? 206 : 200);
    await once(response, 'data');
    response.destroy();
    const download = opened.slice(before).find((entry) => entry.file.endsWith(name));
    assert.ok(download, 'the download opened the attachment');
    await waitFor(() => download.handle.fd === -1, `the descriptor is released after an aborted ${range ?? 'full'} download`);
  }
  assert.equal((await send(port, { path: '/health' })).status, 200);
});

test('a client gone before the first byte does not leave the file open (S-WS-1)', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-serve-file-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const filePath = path.join(folder, 'clip.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(64 * 1024));
  const served: Promise<void>[] = [];
  const server = http.createServer((req, res) => {
    served.push(serveFile(req, res, { filePath, mimeType: 'video/mp4' }, { cacheControl: 'private', inline: true }));
  });
  const port = await listen(t, server);
  const open = fs.promises.open;
  for (const range of ['', 'Range: bytes=0-\r\n']) {
    let opened!: () => void;
    const requested = new Promise<void>((resolve) => { opened = resolve; });
    let leave!: () => void;
    const gone = new Promise<void>((resolve) => { leave = resolve; });
    let handle: fs.promises.FileHandle | undefined;
    // The client hangs up while the file is being opened, before anything was sent.
    const opening = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
      handle = await open(...args);
      opened();
      await gone;
      return handle;
    });
    server.once('connection', (socket: net.Socket) => socket.once('close', () => setImmediate(leave)));
    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    client.write(`GET /clip.mp4 HTTP/1.1\r\nHost: localhost\r\n${range}\r\n`);
    await requested;
    client.destroy();
    await Promise.all(served);
    opening.mock.restore();
    assert.ok(handle);
    assert.equal(handle.fd, -1, `the descriptor is released when the client leaves before a ${range ? 'ranged' : 'full'} download`);
  }
});

test('an upload token is spent on arrival, and a full disk answers 507 without stopping the server', async (t) => {
  const upload = await uploadFixture(t);
  const target = upload.uploadPath();
  assert.equal((await send(upload.port, { method: 'POST', path: target, body: 'first file' })).status, 200);
  const replay = await send(upload.port, { method: 'POST', path: target, body: 'second file' });
  assert.equal(replay.status, 401, 'one token authorizes one upload (S-WS-11)');

  const createWriteStream = fs.createWriteStream;
  const diskFull = t.mock.method(fs, 'createWriteStream', (file: fs.PathLike, options?: Parameters<typeof fs.createWriteStream>[1]) =>
    String(file).endsWith('.part')
      ? new Writable({
        write: (_chunk, _encoding, callback) => callback(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })),
      })
      : createWriteStream(file, options));
  const full = await send(upload.port, { method: 'POST', path: upload.uploadPath(), body: 'does not fit' });
  diskFull.mock.restore();
  assert.equal(full.status, 507);
  const fullBody: unknown = JSON.parse(full.body.toString());
  assert.ok(fullBody && typeof fullBody === 'object' && 'error' in fullBody);
  assert.equal(fullBody.error, ProtocolErrorCode.STORAGE_FULL);
  assert.equal(full.headers.connection, 'close');

  await upload.f.serverRepo.updateServer({ maxAttachmentFileBytes: 16 });
  const oversized = await new Promise<RawResponse>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: upload.port, method: 'POST', path: upload.uploadPath(), agent: false },
      (response) => { collect(response).then(resolve, reject); });
    request.on('error', reject);
    request.write('0123456789');
    request.end('0123456789');
  });
  assert.equal(oversized.status, 413, 'a streamed body over the limit is refused and its answer delivered');
  await upload.f.serverRepo.updateServer({ maxAttachmentFileBytes: 1024 });

  assert.equal((await send(upload.port, { method: 'POST', path: upload.uploadPath(), body: 'room again' })).status, 200,
    'the listener survived the failed writes');
  await waitFor(() => fs.readdirSync(upload.tmpDir).length === 0, 'failed uploads leave no temp file behind');
});

test('uploads stop on inactivity or below a minimum pace rather than on total duration (S-WS-11)', async (t) => {
  const { server } = await startServer(t);
  assert.equal(server['httpServer'].requestTimeout, 0, 'no whole-request deadline cuts long uploads');
  assert.equal(server['httpServer'].headersTimeout, 60_000, 'a request head still has to arrive in time');

  const upload = await uploadFixture(t, 300);
  const steady = await new Promise<RawResponse>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: upload.port, method: 'POST', path: upload.uploadPath(), agent: false },
      (response) => { collect(response).then(resolve, reject); });
    request.on('error', reject);
    let chunks = 0;
    // 2 KiB every 100 ms: slow, but well above the minimum pace of 1 KiB/s.
    const timer = setInterval(() => {
      chunks += 1;
      if (chunks < 8) {
        request.write(Buffer.alloc(2048, chunks));
        return;
      }
      clearInterval(timer);
      request.end('done');
    }, 100);
  });
  assert.equal(steady.status, 200, 'a slow upload that keeps sending lasts longer than the idle limit and completes');

  const stalled = await new Promise<RawResponse>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: upload.port, method: 'POST', path: upload.uploadPath(), agent: false },
      (response) => { collect(response).then(resolve, reject); });
    request.on('error', reject);
    request.write('partial ');
  });
  assert.equal(stalled.status, 408);
  await waitFor(() => fs.readdirSync(upload.tmpDir).length === 0, 'the abandoned temp file is removed');

  const head = `POST ${upload.uploadPath()} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100000\r\n`;
  assert.equal(await trickleBody(upload.port, head), 408,
    'a byte now and then never lets the idle limit expire, but cannot hold an authorized upload open for good');
  await waitFor(() => fs.readdirSync(upload.tmpDir).length === 0, 'the trickled temp file is removed');
});

test('an answer sent before its body arrived closes the connection, so a trickled body cannot hold it (S-WS-11)', async (t) => {
  const { port } = await startServer(t);
  const lengthOf = (size: number) => `Content-Length: ${size}\r\n`;
  assert.equal(await trickleBody(port, `POST /attachments?token=nope HTTP/1.1\r\nHost: localhost\r\n${lengthOf(1_000_000)}`), 401);
  assert.equal(await trickleBody(port, 'POST /nowhere HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n', '1\r\nx\r\n'), 404);
  assert.equal(await trickleBody(port, `GET /health HTTP/1.1\r\nHost: localhost\r\n${lengthOf(1000)}`), 200);
  assert.equal(await trickleBody(port, `OPTIONS /attachments HTTP/1.1\r\nHost: localhost\r\n${lengthOf(1000)}`), 204);

  const upload = await uploadFixture(t);
  await upload.f.serverRepo.updateServer({ maxAttachmentFileBytes: 1024 });
  assert.equal(await trickleBody(upload.port, `POST ${upload.uploadPath()} HTTP/1.1\r\nHost: localhost\r\n${lengthOf(5000)}`), 413,
    'a declared size over the limit is refused without draining the rest');

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const reused: boolean[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/health', agent }, (response) => {
        reused.push(request.reusedSocket);
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', reject);
    });
  }
  assert.deepEqual(reused, [false, true], 'a request without a body keeps its connection alive');
});

test('/invite-info answers only this machine, and exact routes accept query strings (S-WS-11)', async (t) => {
  t.mock.method(ipScanner, 'scanServerNetworkInterfaces', async () => [
    { name: 'Ethernet', address: '192.168.0.10', family: 'IPv4' as const, type: 'lan' as const, description: 'LAN' },
  ]);
  const { port } = await startServer(t);
  const local = await send(port, { path: '/invite-info' });
  assert.equal(local.status, 200);
  const info: unknown = JSON.parse(local.body.toString());
  assert.ok(info && typeof info === 'object' && 'port' in info && 'networkInterfaces' in info);
  assert.equal(info.port, port);
  assert.deepEqual(info.networkInterfaces, [
    { name: 'Ethernet', address: '192.168.0.10', family: 'IPv4', type: 'lan', description: 'LAN' },
  ]);
  const proxied = await send(port, { path: '/invite-info', headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(proxied.status, 404, 'a local proxy speaks for someone else');

  const peer = (remoteAddress: string, headers: http.IncomingHttpHeaders = {}) => ({ headers, socket: { remoteAddress } });
  assert.equal(isLocalRequest(peer('127.0.0.1')), true);
  assert.equal(isLocalRequest(peer('::ffff:127.0.0.1')), true);
  assert.equal(isLocalRequest(peer('::1')), true);
  assert.equal(isLocalRequest(peer('192.168.0.20')), false);
  assert.equal(isLocalRequest(peer('203.0.113.7')), false);
  assert.equal(isLocalRequest(peer('127.0.0.1', { forwarded: 'for=203.0.113.7' })), false);

  assert.equal((await send(port, { path: '/health?probe=1' })).status, 200);
  assert.equal((await send(port, { path: '/preview?lang=pt-BR' })).status, 200);
});

test('concurrent invites share one public IP lookup, and a failed lookup is not repeated at once (S-WS-11)', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    throw new Error('offline');
  });
  // Far past any lookup an earlier test may have cached in this process.
  t.mock.method(Date, 'now', () => 10 ** 15);
  const [first, second] = await Promise.all([ipScanner.getPublicIp(), ipScanner.getPublicIp()]);
  assert.equal(first, second);
  assert.equal(requests, 2, 'each provider is asked once, not once per caller');
  await ipScanner.getPublicIp();
  assert.equal(requests, 2, 'a failed lookup is remembered for a while');
});
