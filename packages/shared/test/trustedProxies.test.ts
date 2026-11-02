import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TRUSTED_PROXIES,
  canonicalIpAddress,
  createTrustedProxyMatcher,
  parseTrustedProxies,
  resolveClientAddress,
} from '../src/index.js';

test('parseTrustedProxies accepts addresses and networks in one spelling, without repeats', () => {
  assert.deepEqual(parseTrustedProxies(''), { ok: true, entries: [] });
  assert.deepEqual(parseTrustedProxies('127.0.0.1, 10.0.0.0/8\n::1  fd00:0:0::/8;127.0.0.1'), {
    ok: true, entries: ['127.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8'],
  });
  assert.deepEqual(parseTrustedProxies(['::ffff:192.168.0.1', '192.168.0.1/32', '2001:DB8:0:0:0:0:0:1/128']), {
    ok: true, entries: ['192.168.0.1', '2001:db8::1'],
  });
});

test('parseTrustedProxies names the entry it refuses', () => {
  for (const entry of ['localhost', '1.2.3', '256.0.0.1', '01.2.3.4', '10.0.0.0/33', '10.0.0.0/8/1', '::1/129',
    '1:2:3:4:5:6:7:8:9', '1::2::3', '1.2.3.4::', 'fe80::1%eth0', '10.0.0.0/']) {
    assert.deepEqual(parseTrustedProxies(`127.0.0.1 ${entry}`), { ok: false, problem: { code: 'invalid', entry } }, entry);
  }
  for (const entry of ['0.0.0.0/0', '::/0']) {
    assert.deepEqual(parseTrustedProxies(entry), { ok: false, problem: { code: 'everyone', entry } });
  }
  const many = Array.from({ length: MAX_TRUSTED_PROXIES + 1 }, (_, i) => `10.0.0.${i}`);
  assert.deepEqual(parseTrustedProxies(many), { ok: false, problem: { code: 'too-many', max: MAX_TRUSTED_PROXIES } });
});

test('canonicalIpAddress folds IPv4-mapped IPv6 and compresses IPv6', () => {
  assert.equal(canonicalIpAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(canonicalIpAddress('2001:0db8:0000:0000:0001:0000:0000:0001'), '2001:db8::1:0:0:1');
  assert.equal(canonicalIpAddress('::'), '::');
  assert.equal(canonicalIpAddress('1:0:2:3:4:5:6:7'), '1:0:2:3:4:5:6:7');
  assert.equal(canonicalIpAddress('unknown'), null);
});

test('createTrustedProxyMatcher matches addresses and networks of both families', () => {
  const trusted = createTrustedProxyMatcher(['127.0.0.1', '172.16.0.0/12', 'fd00::/8']);
  assert.equal(trusted('127.0.0.1'), true);
  assert.equal(trusted('::ffff:127.0.0.1'), true);
  assert.equal(trusted('127.0.0.2'), false);
  assert.equal(trusted('172.31.255.255'), true);
  assert.equal(trusted('172.32.0.0'), false);
  assert.equal(trusted('fdab::1'), true);
  assert.equal(trusted('fe00::1'), false);
  assert.equal(trusted('garbage'), false);
  assert.equal(createTrustedProxyMatcher([])('127.0.0.1'), false);
});

test('resolveClientAddress ignores forwarding headers from untrusted sockets', () => {
  const none = createTrustedProxyMatcher([]);
  assert.equal(resolveClientAddress('::ffff:127.0.0.1', { forwardedFor: '203.0.113.7' }, none), '127.0.0.1');
  assert.equal(resolveClientAddress('198.51.100.2', { forwarded: 'for=203.0.113.7' }, none), '198.51.100.2');
  assert.equal(resolveClientAddress('weird', { forwardedFor: '203.0.113.7' }, none), 'weird');
});

test('resolveClientAddress takes the newest hop that is not a trusted proxy', () => {
  const trusted = createTrustedProxyMatcher(['127.0.0.1', '10.0.0.0/8']);
  // The client prepended a fake hop; the proxies appended what they saw.
  assert.equal(resolveClientAddress('127.0.0.1', { forwardedFor: '1.1.1.1, 203.0.113.7, 10.1.2.3' }, trusted), '203.0.113.7');
  assert.equal(resolveClientAddress('127.0.0.1', { forwardedFor: '203.0.113.7:4711' }, trusted), '203.0.113.7');
  assert.equal(resolveClientAddress('127.0.0.1', { forwardedFor: '[2001:db8::7]:4711' }, trusted), '2001:db8::7');
  // Every hop trusted: the oldest one is the client.
  assert.equal(resolveClientAddress('127.0.0.1', { forwardedFor: '10.0.0.9' }, trusted), '10.0.0.9');
  // No header: the proxy itself.
  assert.equal(resolveClientAddress('127.0.0.1', {}, trusted), '127.0.0.1');
});

test('resolveClientAddress reads Forwarded only without X-Forwarded-For', () => {
  const trusted = createTrustedProxyMatcher(['127.0.0.1']);
  assert.equal(resolveClientAddress('127.0.0.1',
    { forwarded: 'for=1.1.1.1, for="[2001:db8::7]:4711";proto=https;by=127.0.0.1' }, trusted), '2001:db8::7');
  assert.equal(resolveClientAddress('127.0.0.1', { forwarded: 'proto=https;For="203.0.113.7:80"' }, trusted), '203.0.113.7');
  assert.equal(resolveClientAddress('127.0.0.1',
    { forwardedFor: '203.0.113.7', forwarded: 'for=198.51.100.66' }, trusted), '203.0.113.7');
});

test('resolveClientAddress stops at the last trusted proxy on a hop that is not an address', () => {
  const trusted = createTrustedProxyMatcher(['127.0.0.1', '10.0.0.0/8']);
  assert.equal(resolveClientAddress('127.0.0.1', { forwardedFor: '203.0.113.7, unknown, 10.0.0.2' }, trusted), '10.0.0.2');
  assert.equal(resolveClientAddress('127.0.0.1', { forwarded: 'for=_hidden' }, trusted), '127.0.0.1');
  assert.equal(resolveClientAddress('127.0.0.1', { forwardedFor: '' }, trusted), '127.0.0.1');
});
