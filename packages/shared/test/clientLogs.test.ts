import assert from 'node:assert/strict';
import test from 'node:test';
import { clientLogExportName, newestLogBytes } from '../src/index.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

test('newestLogBytes keeps everything that already fits', () => {
  const bytes = encode('{"a":1}\n{"b":2}\n');
  assert.equal(newestLogBytes(bytes, bytes.length), bytes);
  assert.equal(newestLogBytes(bytes, bytes.length + 10), bytes);
});

test('newestLogBytes drops the oldest lines and never starts in the middle of one', () => {
  const text = '{"n":1}\n{"n":2}\n{"n":3}\n';
  assert.equal(decode(newestLogBytes(encode(text), 16)), '{"n":2}\n{"n":3}\n', 'A cut on a line boundary keeps both lines.');
  assert.equal(decode(newestLogBytes(encode(text), 15)), '{"n":3}\n', 'A cut inside a line drops what is left of it.');
  assert.equal(decode(newestLogBytes(encode(text), 3)), '', 'Less than one whole line keeps nothing.');
  assert.equal(decode(newestLogBytes(encode(text), 0)), '');
});

test('newestLogBytes never splits a multi-byte character', () => {
  const text = '{"m":"ação"}\n{"m":"日本"}\n';
  const bytes = encode(text);
  for (let max = 0; max <= bytes.length; max++) {
    const kept = decode(newestLogBytes(bytes, max));
    assert.ok(text.endsWith(kept), `${max} bytes keep a suffix of the text`);
    assert.ok(kept === '' || kept.startsWith('{'), `${max} bytes start on a whole line`);
    assert.ok(encode(kept).length <= max);
  }
});

test('clientLogExportName names the file after the local date and time', () => {
  // Built from local fields: late at night the name keeps the local day, not the UTC one.
  assert.equal(clientLogExportName(new Date(2026, 10, 19, 23, 30, 5)), 'monky-logs-2026-11-19_23-30-05.txt');
  assert.notEqual(clientLogExportName(new Date(2026, 10, 19, 9, 0, 0)), clientLogExportName(new Date(2026, 10, 19, 9, 0, 1)),
    'Two exports of the same day get different names');
});
