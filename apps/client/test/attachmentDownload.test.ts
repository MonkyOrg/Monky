import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadToFile, suggestedDownloadName } from '../src/main/attachmentDownload';

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

test('the suggested name prefers the one the renderer knows and survives malformed escapes', () => {
  const url = new URL('https://server.test/attachments/1/bad%E0%A4%A.png');
  assert.equal(suggestedDownloadName(url, 'Foto da call.png'), 'Foto da call.png');
  assert.equal(suggestedDownloadName(url, '../../etc/passwd'), 'passwd');
  assert.equal(suggestedDownloadName(url, ''), 'bad%E0%A4%A.png');
  assert.equal(suggestedDownloadName(url, 42), 'bad%E0%A4%A.png');
  assert.equal(suggestedDownloadName(new URL('https://server.test/a/relat%C3%B3rio%3F.pdf'), undefined), 'relatório_.pdf');
  assert.equal(suggestedDownloadName(new URL('https://server.test/'), undefined), 'download');
});
