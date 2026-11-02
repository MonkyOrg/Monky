const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createServerInviteAppLink, createServerInviteLink, parseServerInviteLink } = require('@monky/shared');
const { nativeExecutable } = require('./native_test_paths.cjs');

const executable = process.env.MONKY_LIGHT_INVITE_TEST_BIN || nativeExecutable('monky-light-invite-test');

function decode(links) {
  const result = spawnSync(executable, ['--decode-fixture'], {
    input: `${links.join('\n')}\n`, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/u);
}

const hex = (value) => (value === undefined ? '-' : Buffer.from(value, 'utf8').toString('hex'));
const key = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('hex');

test('native server invitation scenarios remain active in Release builds', () => {
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Monky Light reads every invitation the app and the website create, server key and TLS included (#821, #829)', () => {
  const invites = [];
  const hosts = ['localhost', '127.0.0.1', '[::1]', '203.0.113.7', 'monky.example.com', '[2001:db8::1]',
    '[2001:db8:0:1:0:0:0:1]', '[fe80::]', 'xn--mnky-6qa.example'];
  for (const host of hosts) {
    for (const port of [3000, 3001, 65535]) {
      invites.push({ v: 1, host, port });
      invites.push({ v: 1, host, port, name: 'Servidor ç ✓ 🐒', password: 'senha com espaço' });
      invites.push({ v: 1, host, port, password: 'abcdef0123456789', serverKey: key() });
      invites.push({ v: 1, host, port, password: 'ABCDEF012', name: 'x'.repeat(100), serverKey: key(), eventId: 'event_1-a' });
      invites.push({ v: 1, host, port, name: 'Casa '.repeat(19).trim(), password: 'p'.repeat(900), serverKey: key() });
      invites.push({ v: 1, host, port, tls: true });
      invites.push({ v: 1, host, port, name: 'Proxy', password: 'abc', serverKey: key(), tls: true, eventId: 'e-1' });
    }
  }
  const links = invites.flatMap(invite => [createServerInviteLink(invite), createServerInviteAppLink(invite),
    createServerInviteLink(invite, 'en')]);
  const decoded = decode(links);
  assert.equal(decoded.length, links.length);
  links.forEach((link, index) => {
    const parsed = parseServerInviteLink(link);
    assert.ok(parsed.ok, link);
    const { invite } = parsed;
    assert.equal(decoded[index], ['ok', invite.host, invite.port, hex(invite.name), hex(invite.password),
      invite.serverKey ?? '-', invite.eventId ?? '-', `${invite.tls ? 'wss' : 'ws'}://${invite.host}:${invite.port}`].join(' '), link);
  });
});

test('Monky Light refuses what the shared parser refuses', () => {
  const valid = createServerInviteAppLink({ v: 1, host: '203.0.113.7', port: 3000, serverKey: key() });
  // An extension that announces a server key without carrying one.
  const bare = Buffer.from(createServerInviteAppLink({ v: 1, host: '203.0.113.7', port: 3000, tls: true }).slice('monky://#~'.length), 'base64url');
  bare[bare.length - 5] |= 2;
  const links = [
    valid.replace('monky://', 'monky://host'), `${valid}.event.`, `${valid}.extra`, valid.slice(0, -2),
    valid.replace('#~', '#'), 'monky://#~Ax', 'https://example.com/Monky/convite/#~Aw', `monky://#~${bare.toString('base64url')}`,
  ];
  for (const [index, line] of decode(links).entries()) {
    assert.equal(parseServerInviteLink(links[index]).ok, false, links[index]);
    assert.equal(line, 'invalid', links[index]);
  }
});
