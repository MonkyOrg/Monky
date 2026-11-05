const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { MONKY_MINIAPPS_URL, miniappsFrameSource } = require('@monky/shared');

const root = path.resolve(__dirname, '..', '..', '..');

function siteCsp() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const header = config.headers.flatMap((rule) => rule.headers).find((entry) => entry.key === 'Content-Security-Policy');
  return Object.fromEntries(header.value.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
}

test('the web site may frame the miniapps site it opens miniapps from (#858)', () => {
  assert.ok(siteCsp()['frame-src'].includes(miniappsFrameSource(MONKY_MINIAPPS_URL)),
    'vercel.json frame-src must follow MONKY_MINIAPPS_URL');
});

test('the web site itself is never framed, and runs no script from the miniapps site', () => {
  const csp = siteCsp();
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.ok(!csp['script-src'].some((source) => source.includes('miniapps')));
});

test('a miniapps URL becomes the CSP source of every document it serves', () => {
  assert.equal(miniappsFrameSource('https://monky-miniapps.vercel.app/'), 'https://monky-miniapps.vercel.app');
  assert.equal(miniappsFrameSource('https://{id}.miniapps.example.com/'), 'https://*.miniapps.example.com');
  assert.throws(() => miniappsFrameSource('https://miniapps.{id}.example.com/'));
});
