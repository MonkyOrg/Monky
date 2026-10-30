import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// A test file left out of the package script still compiles, and then silently never runs in CI.
test('every shared test file runs from the package test script', () => {
  const root = path.resolve(__dirname, '..', '..');
  const script = /"test":\s*"([^"]*)"/u.exec(readFileSync(path.join(root, 'package.json'), 'utf8'))?.[1] ?? '';
  const listed = new Set(script.split(/\s+/u));
  const unlisted = readdirSync(path.join(root, 'test'))
    .filter(name => name.endsWith('.test.ts'))
    .map(name => `dist-test/test/${name.slice(0, -'.ts'.length)}.js`)
    .filter(compiled => !listed.has(compiled));
  assert.deepEqual(unlisted, []);
});
