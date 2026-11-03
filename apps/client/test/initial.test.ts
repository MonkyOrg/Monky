import test from 'node:test';
import assert from 'node:assert/strict';
import { firstInitial } from '../src/renderer/utils/initial';

test('the initial keeps a whole emoji instead of splitting its surrogate pair', () => {
  assert.equal(firstInitial('😀 Server'), '😀');
  assert.equal(firstInitial('👨‍👩‍👧 Família'), '👨‍👩‍👧');
});

test('the initial of a plain name is its upper-cased first letter', () => {
  assert.equal(firstInitial('monky'), 'M');
  assert.equal(firstInitial('  ábaco'), 'Á');
});

test('an empty name uses the fallback', () => {
  assert.equal(firstInitial('   '), '?');
  assert.equal(firstInitial(null, ''), '');
});
