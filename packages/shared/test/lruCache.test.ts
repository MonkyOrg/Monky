import assert from 'node:assert/strict';
import test from 'node:test';
import { LruCache } from '../src/index.js';

test('LruCache returns stored values and reports its size', () => {
  const cache = new LruCache<string, number>(3, 10000);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.size, 2);
});

test('LruCache evicts the least recently used entry at capacity', () => {
  const cache = new LruCache<string, string>(2, 10000);
  cache.set('k1', 'v1');
  cache.set('k2', 'v2');
  assert.equal(cache.get('k1'), 'v1');
  cache.set('k3', 'v3');
  assert.equal(cache.get('k1'), 'v1');
  assert.equal(cache.get('k2'), undefined, 'k2 was the least recently used entry');
  assert.equal(cache.get('k3'), 'v3');
  assert.equal(cache.size, 2);
});

test('LruCache keeps an entry until its exact expiry time and drops it 1 ms later', t => {
  // A simulated clock: a busy runner cannot age the entry between two lines of the test.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const cache = new LruCache<string, string>(5, 50);
  cache.set('read', 'value');
  cache.set('checked', 'value');
  t.mock.timers.tick(50);
  assert.equal(cache.get('read'), 'value', 'An entry is still valid at exactly its expiry time');
  assert.equal(cache.has('checked'), true, 'An entry is still valid at exactly its expiry time');
  t.mock.timers.tick(1);
  assert.equal(cache.get('read'), undefined);
  assert.equal(cache.has('checked'), false);
  assert.equal(cache.size, 0, 'Reading an expired entry removes it');
});

test('LruCache has, delete and clear manage entries explicitly', () => {
  const cache = new LruCache<string, number>(5, 10000);
  cache.set('x', 10);
  cache.set('y', 20);
  assert.equal(cache.has('x'), true);
  assert.equal(cache.has('z'), false);
  assert.equal(cache.delete('x'), true);
  assert.equal(cache.has('x'), false);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.throws(() => new LruCache<string, number>(0), /maxEntries must be greater than 0/);
});
