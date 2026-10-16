import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MESSAGE_SELECTION_MAX, dragSelection, edgeScrollSpeed } from '../src/renderer/utils/messageSelection';

const order = ['a', 'b', 'c', 'd', 'e', 'f'];
const sorted = (values: Set<string>) => [...values].sort();

test('dragging selects the rows between the anchor and the pointer, in either direction', () => {
  assert.deepEqual(sorted(dragSelection(order, new Set(), 1, 3, true)), ['b', 'c', 'd']);
  assert.deepEqual(sorted(dragSelection(order, new Set(), 4, 2, true)), ['c', 'd', 'e']);
  assert.deepEqual(sorted(dragSelection(order, new Set(), 2, 2, true)), ['c']);
});

test('rows outside the range keep what they had when the drag began', () => {
  const before = new Set(['a', 'f']);
  assert.deepEqual(sorted(dragSelection(order, before, 1, 2, true)), ['a', 'b', 'c', 'f']);
  // Shrinking the drag back gives the rows it left their earlier state.
  assert.deepEqual(sorted(dragSelection(order, new Set(['c']), 1, 1, true)), ['b', 'c']);
  assert.deepEqual(sorted(dragSelection(order, new Set(), 1, 1, true)), ['b']);
});

test('starting on a selected message deselects the range instead', () => {
  const before = new Set(['b', 'c', 'd', 'e']);
  assert.deepEqual(sorted(dragSelection(order, before, 2, 3, false)), ['b', 'e']);
});

test('messages that scrolled out of the rendered list stay selected', () => {
  assert.deepEqual(sorted(dragSelection(order, new Set(['gone']), 0, 1, true)), ['a', 'b', 'gone']);
});

test('adding stops at the selection limit, closest to the anchor first', () => {
  const many = Array.from({ length: MESSAGE_SELECTION_MAX + 20 }, (_, index) => `m${index}`);
  const selection = dragSelection(many, new Set(), 10, many.length - 1, true);
  assert.equal(selection.size, MESSAGE_SELECTION_MAX);
  assert.ok(selection.has('m10'));
  assert.ok(!selection.has(many[many.length - 1]));
  assert.equal(dragSelection(order, new Set(['a', 'b']), 2, 5, true, 3).size, 3);
});

test('the feed scrolls only near its edges, faster closer to them', () => {
  assert.equal(edgeScrollSpeed(300, 0, 600), 0);
  assert.ok(edgeScrollSpeed(40, 0, 600) < 0);
  assert.ok(edgeScrollSpeed(5, 0, 600) < edgeScrollSpeed(40, 0, 600));
  assert.ok(edgeScrollSpeed(590, 0, 600) > 0);
  assert.equal(edgeScrollSpeed(-500, 0, 600), -28);
  assert.equal(edgeScrollSpeed(5000, 0, 600), 28);
  assert.equal(edgeScrollSpeed(10, 0, 0), 0);
});
