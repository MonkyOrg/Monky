import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import dns from 'node:dns';
import { isPrivateAddress } from '../src/main/privateAddress';
import { fetchLinkPreview } from '../src/main/linkPreview';

test('IPv4-mapped normalized addresses inherit their IPv4 classification', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1']) {
    assert.equal(isPrivateAddress(new URL(`http://[::ffff:${ip}]/`).hostname), true, ip);
  }
  for (const ip of ['192.0.78.9', '192.0.78.17', '8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false);
    assert.equal(isPrivateAddress(new URL(`http://[::ffff:${ip}]/`).hostname), false);
  }
  for (const ip of ['::', '0:0:0:0:0:0:0:1', 'fe80::1', 'fd00::1', 'ff02::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('previews never request local IPv4 or normalized IPv4-mapped literals', async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Private fixture</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '[0:0:0:0:0:ffff:7f00:1]']) {
      assert.equal(await fetchLinkPreview(`http://${host}:${address.port}/`), null);
    }
    assert.equal(requests, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('DNS resolution cannot redirect a public-looking preview into a private listener', async context => {
  let requests = 0;
  let lookups = 0;
  const server = http.createServer((_request, response) => { requests++; response.end('<title>Private</title>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  context.mock.method(dns, 'lookup', (...args: unknown[]) => {
    lookups++;
    const callback = args.at(-1);
    assert.equal(typeof callback, 'function');
    if (typeof callback === 'function') callback(null, '127.0.0.1', 4);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(await fetchLinkPreview(`http://public-fixture.example:${address.port}/`), null);
  assert.equal(lookups, 1);
  assert.equal(requests, 0);
});
