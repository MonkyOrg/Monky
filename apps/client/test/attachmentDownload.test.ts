import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { downloadToFile, suggestedDownloadName } from '../src/main/attachmentDownload';
import { HttpGetError, httpGet } from '../src/main/net/httpGet';

test('a server cannot crash Main or strand the download with a redirect it chooses', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-attachment-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const redirects: Record<string, string> = {
    '/ftp': 'ftp://example.invalid/file.bin',
    '/file': 'file:///etc/hosts',
    '/script': 'javascript:alert(1)',
    '/malformed': 'http://[',
    '/loop': '/loop',
    '/relative': '/ok',
  };
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    const location = redirects[request.url ?? ''];
    if (location) {
      response.writeHead(302, { Location: location });
      response.end();
    } else if (request.url === '/ok') {
      response.end('attachment bytes');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const uncaught: unknown[] = [];
  const observe = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', observe);
  t.after(() => { process.removeListener('uncaughtException', observe); });

  for (const [route, reason] of [
    ['/ftp', /ftp:/], ['/file', /file:/], ['/script', /javascript:/],
    ['/malformed', /invalid address/], ['/loop', /Too many redirects/], ['/missing', /HTTP 404/],
  ] as const) {
    const destination = path.join(directory, `${route.slice(1)}.bin`);
    await assert.rejects(downloadToFile(`${base}${route}`, destination), reason, route);
    assert.equal(fs.existsSync(destination), false, `${route} leaves no file`);
    assert.equal(fs.existsSync(`${destination}.downloading`), false, `${route} leaves no partial file`);
  }
  await assert.rejects(downloadToFile('not a url', path.join(directory, 'invalid.bin')), /Invalid download URL/);
  await assert.rejects(downloadToFile('ftp://example.invalid/a', path.join(directory, 'scheme.bin')), /ftp:/);

  const saved = path.join(directory, 'saved.bin');
  await downloadToFile(`${base}/relative`, saved);
  assert.equal(fs.readFileSync(saved, 'utf8'), 'attachment bytes');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
  assert.ok(requests > 0);
});

test('a download that stops midway fails with the messages the toast has always shown and keeps no file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-attachment-midway-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    if (request.url === '/stalled') return;
    response.writeHead(200, { 'Content-Length': '1000' });
    // Then the connection drops, or goes silent, before the rest of the body.
    response.write('partial', () => {
      if (request.url === '/dropped') setTimeout(() => response.destroy(), 20);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const uncaught: unknown[] = [];
  const observe = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', observe);
  t.after(() => { process.removeListener('uncaughtException', observe); });

  for (const [route, idleTimeoutMs, message] of [
    // The real deadline: a dropped connection must not wait for it.
    ['/dropped', undefined, 'Download aborted'],
    ['/stalled-body', 50, 'Download timeout'],
    ['/stalled', 50, 'Download timeout'],
  ] as const) {
    const destination = path.join(directory, `${route.slice(1)}.bin`);
    await assert.rejects(downloadToFile(`${base}${route}`, destination, idleTimeoutMs), { message }, route);
    assert.equal(fs.existsSync(destination), false, `${route} leaves no file`);
    assert.equal(fs.existsSync(`${destination}.downloading`), false, `${route} leaves no partial file`);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
});

test('the suggested name prefers the one the renderer knows and survives malformed escapes', () => {
  const url = new URL('https://server.test/attachments/1/bad%E0%A4%A.png');
  assert.equal(suggestedDownloadName(url, 'Foto da call.png'), 'Foto da call.png');
  assert.equal(suggestedDownloadName(url, '../../etc/passwd'), 'passwd');
  assert.equal(suggestedDownloadName(url, ''), 'bad%E0%A4%A.png');
  assert.equal(suggestedDownloadName(url, 42), 'bad%E0%A4%A.png');
  assert.equal(suggestedDownloadName(new URL('https://server.test/a/relat%C3%B3rio%3F.pdf'), undefined), 'relatório_.pdf');
  assert.equal(suggestedDownloadName(new URL('https://server.test/'), undefined), 'download');
});

test('the main-process GET refuses hops before contacting them, times out idle hops and honours cancellation', async (t) => {
  const paths: string[] = [];
  const server = http.createServer(async (request, response) => {
    paths.push(request.url ?? '');
    if (request.url === '/stalled-body') {
      response.writeHead(200);
      response.write('partial');
    } else if (request.url === '/chunks') {
      response.writeHead(200, { 'Content-Length': '4000' });
      for (let chunk = 0; chunk < 4; chunk++) {
        response.write(Buffer.alloc(1000, chunk));
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      response.end();
    } else if (request.url === '/elsewhere') {
      response.writeHead(302, { Location: 'http://refused.invalid/x' });
      response.end();
    } else if (request.url !== '/stalled') {
      response.end('ok');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const local = (url: URL): boolean => url.hostname === '127.0.0.1';
  const failure = (name: string) => (error: unknown) => error instanceof HttpGetError && error.failure === name;

  await assert.rejects(httpGet(new URL(`${base}/ok`), { allows: () => false }), failure('refused'));
  await assert.rejects(httpGet(new URL(`${base}/elsewhere`), { allows: local }), failure('refused'));
  assert.deepEqual(paths, ['/elsewhere'], 'a refused hop is never requested');

  await assert.rejects(httpGet(new URL(`${base}/stalled`), { allows: local, idleTimeoutMs: 50 }), failure('timeout'));
  const stalled = await httpGet(new URL(`${base}/stalled-body`), { allows: local, idleTimeoutMs: 50 });
  assert.equal(stalled.status, 200);
  await assert.rejects(async () => { for await (const chunk of stalled.body) assert.ok(chunk); }, failure('timeout'));

  // The whole body arrived, but a slow disk has not taken it yet when the connection goes silent:
  // it must fail, not end early as if the first chunk were all of it.
  const unread = await httpGet(new URL(`${base}/chunks`), { allows: local, idleTimeoutMs: 100 });
  let written = 0;
  const slowDisk = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      written += chunk.length;
      setTimeout(done, 300);
    },
  });
  await assert.rejects(pipeline(unread.body, slowDisk), failure('timeout'));
  assert.ok(written < 4000, `${written} bytes were taken before the timeout`);

  const controller = new AbortController();
  const pending = httpGet(new URL(`${base}/stalled`), { allows: local, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /abort/i);
  await assert.rejects(httpGet(new URL(`${base}/ok`), { allows: local, signal: controller.signal }), /abort/i);

  const done = await httpGet(new URL(`${base}/ok`), { allows: local });
  assert.equal(done.status, 200);
  assert.equal(done.url.pathname, '/ok');
  done.body.resume();
});
