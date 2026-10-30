import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import dns from 'node:dns';
import { isLocalHost, isPublicAddress } from '../src/main/net/addressPolicy';
import { fetchLinkPreview } from '../src/main/linkPreview';

test('one address policy refuses local, private, special and transition addresses for previews and sounds', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.4.2', '100.64.0.1', '0.0.0.0', '192.0.0.1',
    '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'fe80::1%eth0', 'fd00::1', 'fec0::1', 'ff02::1', '2001:db8::1',
    // A private IPv4 must not hide in an IPv4-compatible, mapped, NAT64, 6to4 or Teredo address.
    '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::7f00:1',
    '2002:7f00:1::', '2001:0:4136:e378::1', 'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '192.0.78.9', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  for (const host of [
    'localhost', 'LOCALHOST.', 'app.localhost', 'impressora.local', 'metadata.google.internal', 'router.home.arpa', '',
    '127.0.0.1', '[::1]', '[::ffff:7f00:1]', '[fe80::1]',
  ]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ['exemplo.com', 'local.example', '8.8.8.8', '[2606:4700:4700::1111]']) {
    assert.equal(isLocalHost(host), false, host);
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
