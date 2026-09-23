const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const timers = require('node:timers/promises');
const { terminate } = require('../../dist/localRuntime');

const tools = {
  node: path.join(__dirname, 'managed tools', 'node.exe'),
  ytDlp: path.join(__dirname, 'managed tools', 'yt-dlp.exe'),
  ffmpeg: path.join(__dirname, 'managed tools', 'ffmpeg.exe'),
};
const signal = () => new AbortController().signal;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const track = (duration = 0.12) => ({
  id: 'abcdefghijk', title: 'Synthetic Opus fixture', duration,
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  audioUrl: 'https://rr1.googlevideo.com/videoplayback',
});

async function until(predicate, milliseconds = 3000) {
  const end = performance.now() + milliseconds;
  while (!predicate() && performance.now() < end) await wait(10);
  assert.ok(predicate(), 'Expected fixture state did not arrive.');
}

function page(sequence, flags, sizes, body, serial = 7) {
  const header = Buffer.alloc(27);
  header.write('OggS');
  header[5] = flags;
  header.writeBigUInt64LE(BigInt(Math.max(0, sequence - 1) * 960), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = sizes.length;
  return Buffer.concat([header, Buffer.from(sizes), body]);
}

function headers() {
  const head = Buffer.alloc(19);
  head.write('OpusHead');
  head[8] = 1;
  head[9] = 2;
  head.writeUInt32LE(48000, 12);
  const tags = Buffer.alloc(16);
  tags.write('OpusTags');
  return [page(0, 2, [head.length], head), page(1, 0, [tags.length], tags)];
}

function ogg(count = 6, eos = true) {
  return Buffer.concat([...headers(), ...Array.from({ length: count }, (_, index) =>
    page(index + 2, eos && index === count - 1 ? 4 : 0, [3], Buffer.from([0xf8, 0xff, 0xfe])))]);
}

function emit(bytes) {
  return `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'));`;
}

function decoder(t, script) {
  const original = childProcess.spawn;
  const children = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== tools.ffmpeg) {
      assert.match(command, /[\\/]taskkill\.exe$/i, 'Only owned-process cleanup may launch another executable.');
      return original(command, args, options);
    }
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, process.platform !== 'win32');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    const code = typeof script === 'function' ? script(args, children.length) : script;
    const child = original(process.execPath, ['-e', code], options);
    children.push({ child, args });
    return child;
  });
  t.after(async () => {
    for (const { child } of children) await terminate(child);
    assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null || !child.pid),
      'Every owned decoder must terminate.');
  });
  return children;
}

function relay(args) {
  const url = new URL(args[args.indexOf('-i') + 1]);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/[0-9a-f]{64}$/);
  return `
    const http = require('node:http');
    const fail = error => { process.stderr.write(error.message); process.exitCode = 1; };
    http.get(${JSON.stringify(url.href)}, { agent: false }, response => {
      response.once('error', fail);
      response.pipe(process.stdout);
    }).once('error', fail);
  `;
}

async function consume(stream, onFrame) {
  const frames = [];
  try {
    for await (const frame of stream.frames) {
      frames.push(Buffer.from(frame));
      if (onFrame) await onFrame(frame, frames.length);
    }
    return frames;
  } finally { await stream.close(); }
}

async function server(t, handler) {
  const sockets = new Set();
  const requests = [];
  const upstreamUrls = [];
  const instance = http.createServer((request, response) => {
    requests.push({ range: request.headers.range, ifRange: request.headers['if-range'] });
    handler(request, response);
  });
  instance.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  });
  const url = `http://127.0.0.1:${instance.address().port}/synthetic`;
  const request = (validatedUrl, headers, abortSignal) => new Promise((resolve, reject) => {
    upstreamUrls.push(validatedUrl.href);
    assert.equal(validatedUrl.protocol, 'https:');
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers.Authorization, undefined);
    const outgoing = http.request(url, { headers, signal: abortSignal, agent: false }, response => {
      response.on('error', reject);
      resolve(response);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
  return { requests, upstreamUrls, request };
}

function range(request, bytes) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
  const start = match ? Number(match[1]) : 0;
  const end = Math.min(bytes.length - 1, match?.[2] ? Number(match[2]) : bytes.length - 1);
  return { start, end };
}

function send(request, response, bytes, options = {}) {
  const { start, end } = range(request, bytes);
  if (start >= bytes.length) {
    response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, Connection: 'close' }).end();
    return;
  }
  const servedEnd = Math.min(end, options.segmentEnd ?? end);
  response.writeHead(206, {
    'Content-Type': 'audio/ogg', 'Accept-Ranges': 'bytes',
    'Content-Length': servedEnd - start + 1,
    'Content-Range': `bytes ${start}-${servedEnd}/${bytes.length}`,
    ETag: options.etag || '"synthetic-v1"', Connection: 'close',
  });
  response.end(bytes.subarray(start, Math.min(servedEnd + 1, options.cut ?? bytes.length)));
}

function read(url, headers = {}, abortSignal, onData) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, signal: abortSignal, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => { chunks.push(chunk); onData?.(chunk); });
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks),
      }));
    });
    request.once('error', reject);
  });
}

function quickRetries(t, onDelay = () => {}, milliseconds = 20) {
  const original = timers.setTimeout;
  let attempts = 0;
  t.mock.method(timers, 'setTimeout', (ms, value, options) => {
    assert.ok(ms >= 1000 && ms <= 5000, 'Production retry delays must remain bounded.');
    onDelay(++attempts);
    return original(milliseconds, value, options);
  });
}

module.exports = { tools, signal, wait, track, until, page, headers, ogg, emit, decoder, relay,
  consume, server, range, send, read, quickRetries };
