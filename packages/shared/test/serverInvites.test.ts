import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync, inflateSync } from 'fflate';
import {
  createServerInviteAppLink, createServerInviteLink, decodeServerInviteToken,
  MAX_SERVER_INVITE_LENGTH, parseServerInviteLink, SERVER_INVITE_WEB_URL, serverInviteSchema,
  type ServerInvite,
} from '../src/serverInvites';

const token = (bytes: readonly number[] | Uint8Array): string => `~${Buffer.from(bytes).toString('base64url')}`;
const oldWebLink = (invite: ServerInvite): string =>
  `https://monkyorg.github.io/Monky/convite.html#${Buffer.from(JSON.stringify(invite)).toString('base64url')}`;

test('compact web and native invitations preserve every supplied field', () => {
  for (const host of [
    '192.168.1.5', 'example.org', 'localhost', '127.0.0.1', '[::1]', '[::]',
    '[2001:db8::2]', '2001:db8::2', '[::ffff:192.0.2.1]', 'bücher.example',
  ]) {
    for (const port of [1, 443, 3000, 65535]) {
      const input = { v: 1 as const, host, port, name: ' Sala de teste 🐵 ', password: ' espaço & = + 🐵 ' };
      const expected = serverInviteSchema.parse(input);
      const web = createServerInviteLink(input);
      const native = createServerInviteAppLink(input);
      assert.equal(new URL(web).search, '', 'invitation data never goes in the HTTP query');
      assert.equal(new URL(web).pathname, '/Monky/');
      assert.equal(new URL(native).hostname, '', 'the token is not a hostname that an OS might normalize');
      assert.equal(new URL(native).hash, new URL(web).hash);
      assert.ok(native.startsWith('monky://#~'));
      assert.deepEqual(parseServerInviteLink(web), { ok: true, invite: expected });
      assert.deepEqual(parseServerInviteLink(native), { ok: true, invite: expected });
      assert.deepEqual(parseServerInviteLink(native.replace('monky://', 'monky:///')), { ok: true, invite: expected },
        'Windows URI canonicalization may insert a slash but must preserve the fragment');
      assert.deepEqual(parseServerInviteLink(web.replace('/Monky/', '/Monky/en/')), { ok: true, invite: expected });
      assert.equal(web.includes(input.password), false);
    }
  }
});

test('absent fields remain absent; textual and packed hexadecimal passwords remain exact', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'EXAMPLE.ORG']) {
    for (const password of [undefined, 'a', 'ABC', '0012abcd', '0012ABCD', '00aB12', '12345', '00', 'not-hex', '🔑 texto 🐵']) {
      for (const name of [undefined, 'Name', ' Name with spaces ']) {
        const input: ServerInvite = { v: 1, host, port: 3000,
          ...(name === undefined ? {} : { name }), ...(password === undefined ? {} : { password }) };
        const result = parseServerInviteLink(createServerInviteLink(input));
        assert.deepEqual(result, { ok: true, invite: serverInviteSchema.parse(input) });
        if (result.ok) {
          assert.equal(Object.hasOwn(result.invite, 'password'), password !== undefined);
          assert.equal(Object.hasOwn(result.invite, 'name'), name !== undefined);
        }
      }
    }
  }
});

test('maximum-size Unicode and incompressible-looking data round-trip without truncation', () => {
  for (const password of [
    '漢'.repeat(1024),
    '🐵'.repeat(512),
    Array.from({ length: 1024 }, (_, index) => String.fromCodePoint(0x400 + (index * 7919) % 20000)).join(''),
    'aB0123'.repeat(170),
  ]) {
    const input: ServerInvite = { v: 1, host: 'voice.example.org', port: 65535, name: '🐵'.repeat(50), password };
    const link = createServerInviteLink(input);
    assert.ok(link.length < MAX_SERVER_INVITE_LENGTH);
    assert.deepEqual(parseServerInviteLink(link), { ok: true, invite: input });
  }
  for (const field of ['name', 'password']) {
    assert.throws(() => createServerInviteLink({ v: 1, host: 'localhost', port: 3000, [field]: '\ud800' }),
      'invalid UTF-16 is rejected, never silently replaced during encoding');
  }
});

test('common invitations are materially shorter without dropping connection data', () => {
  const examples: ServerInvite[] = [
    { v: 1, host: '203.0.113.7', port: 3000 },
    { v: 1, host: 'voice.example.org', port: 443, name: 'Sala de teste', password: 'normal-password' },
    { v: 1, host: '127.0.0.1', port: 62506, name: 'Monky QA connected', password: '0123456789abcdef'.repeat(3) },
    { v: 1, host: '[2001:db8::2]', port: 3000, name: 'Servidor de amigos', password: 'ABCDE01234'.repeat(4) },
  ];
  for (const invite of examples) {
    const compact = createServerInviteLink(invite);
    const bytes = Buffer.from(new URL(compact).hash.slice(2), 'base64url');
    const body = bytes[0] & 128 ? inflateSync(bytes.subarray(1)) : bytes.subarray(1);
    assert.equal(bytes.length, 1 + Math.min(body.length, deflateSync(body, { level: 9 }).length));
    assert.ok(compact.length <= oldWebLink(invite).length * 0.75,
      `Expected at least 25% reduction, got ${oldWebLink(invite).length} -> ${compact.length}`);
    assert.deepEqual(parseServerInviteLink(compact), { ok: true, invite: serverInviteSchema.parse(invite) });
  }
  assert.ok(createServerInviteAppLink(examples[0]).length <= 17, 'a bare IPv4/default-port invitation needs no JSON or field names');
  assert.equal(createServerInviteAppLink({ v: 1, host: 'localhost', port: 3000 }).length, 12);
});

test('field decoding preserves leading BOM characters and recovers after invalid UTF-8', () => {
  assert.equal(decodeServerInviteToken(token([0, 1, 255])).ok, false);
  for (const value of ['\ufeff', '\ufeff texto ', 'e\u0301', '\u200d🐵']) {
    const invite: ServerInvite = { v: 1, host: 'localhost', port: 3000, name: value, password: value };
    assert.deepEqual(parseServerInviteLink(createServerInviteLink(invite)), { ok: true, invite });
  }
});

test('cross-field repetition may select textual fields instead of larger packed candidates', () => {
  const sharedText = '0123456789abcdef'.repeat(6);
  const invite: ServerInvite = { v: 1, host: 'localhost', port: 3000, name: sharedText, password: sharedText };
  const bytes = Buffer.from(new URL(createServerInviteLink(invite)).hash.slice(2), 'base64url');
  const field = (value: string): number[] => [value.length, ...Buffer.from(value)];
  const textBody = Uint8Array.from([...field(sharedText), ...field(sharedText)]);
  const packedBody = Uint8Array.from([...field(sharedText), sharedText.length, ...Buffer.from(sharedText, 'hex')]);
  const shortest = 1 + Math.min(textBody.length, deflateSync(textBody, { level: 9 }).length,
    packedBody.length, deflateSync(packedBody, { level: 9 }).length);
  assert.ok(bytes.length <= shortest, 'packing must not discard better cross-field compression');
  assert.deepEqual(parseServerInviteLink(createServerInviteLink(invite)), { ok: true, invite });
});

test('compression is selected only when smaller and the complete fields are still recovered', () => {
  for (const password of [undefined, '0123456789abcdef'.repeat(60)]) {
    const invite: ServerInvite = { v: 1, host: 'localhost', port: 3000, ...(password === undefined ? {} : { password }) };
    const fragment = new URL(createServerInviteLink(invite)).hash.slice(2);
    const header = Buffer.from(fragment, 'base64url')[0];
    assert.equal(!!(header & 128), password !== undefined);
    assert.deepEqual(decodeServerInviteToken(`~${fragment}`), { ok: true, invite });
  }
});

test('malformed binary fields, invalid UTF-8 and noncanonical base64 cannot become a target', () => {
  for (const bytes of [
    [6], [7], [1, 127, 0], [2, 1], [0, 1, 255],
    [0, 128], [0, 128, 0], [0, 255, 255], [3, 0], [11, 0, 0],
    [19, 0], [35, 1, 10], [35, 3, 0xed, 0xa0, 0x80], [67, 1, 0xa1],
    [131], [131, 255, 255, 255],
  ]) assert.deepEqual(decodeServerInviteToken(token(bytes)), { ok: false, reason: 'invalid' });
  for (const value of ['', '~', '~A', '~Aw=', '~Ax', '_w', null, {}, '~***']) {
    assert.deepEqual(decodeServerInviteToken(value), { ok: false, reason: 'invalid' });
  }
  const compressed = deflateSync(new TextEncoder().encode('bad data'.repeat(100)), { level: 9 });
  assert.equal(decodeServerInviteToken(token([131, ...compressed.subarray(0, compressed.length - 2)])).ok, false);
});

test('compressed expansion and encoded input have strict size bounds', () => {
  const bomb = deflateSync(new Uint8Array(100_000).fill(65), { level: 9 });
  assert.deepEqual(decodeServerInviteToken(token([131, ...bomb])), { ok: false, reason: 'too_long' });
  assert.deepEqual(decodeServerInviteToken(token(new Uint8Array(4801))), { ok: false, reason: 'too_long' });
  assert.deepEqual(decodeServerInviteToken('~' + 'A'.repeat(MAX_SERVER_INVITE_LENGTH)), { ok: false, reason: 'too_long' });
  assert.deepEqual(parseServerInviteLink('x'.repeat(MAX_SERVER_INVITE_LENGTH + 1)), { ok: false, reason: 'too_long' });
});

test('unrelated pages, query parameters, credentials and the unshipped old format are rejected', () => {
  const invite: ServerInvite = { v: 1, host: '127.0.0.1', port: 3000 };
  const web = createServerInviteLink(invite);
  for (const value of [
    null, {}, '', '127.0.0.1:3000', web.replace('https:', 'http:'),
    web.replace('monkyorg.github.io', 'example.org'), web.replace('/Monky/', '/Other/'),
    web.replace('/Monky/', '/Monky/download.html'), web.replace('/Monky/', '/Monky/convite.html'),
    web.replace('#', '?tracking=yes#'), web.replace('https://', 'https://fixture-user@'),
    'monky://other/#~Aw', 'monky://invite:3000/#~Aw', 'monky://extra/path#~Aw',
    oldWebLink(invite), `${SERVER_INVITE_WEB_URL}#${Buffer.from(JSON.stringify(invite)).toString('base64url')}`,
  ]) assert.equal(parseServerInviteLink(value).ok, false);
});
