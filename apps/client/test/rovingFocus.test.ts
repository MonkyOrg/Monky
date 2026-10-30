import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypeahead, nextIndex, TYPEAHEAD_PAUSE_MS } from '../src/renderer/utils/rovingFocus';

test('arrows step through a column and come round at the ends; Home and End jump to them', () => {
  assert.equal(nextIndex('ArrowDown', 0, 3), 1);
  assert.equal(nextIndex('ArrowDown', 2, 3), 0);
  assert.equal(nextIndex('ArrowUp', 0, 3), 2);
  assert.equal(nextIndex('ArrowUp', 2, 3), 1);
  assert.equal(nextIndex('Home', 2, 3), 0);
  assert.equal(nextIndex('End', 0, 3), 2);
  assert.equal(nextIndex('ArrowRight', 0, 3), null, 'a column ignores the arrows of a row');
  assert.equal(nextIndex('a', 0, 3), null);
  assert.equal(nextIndex('Enter', 0, 3), null);
});

test('rows, grids that read both ways and lists that stop at their ends', () => {
  assert.equal(nextIndex('ArrowRight', 0, 2, { orientation: 'horizontal' }), 1);
  assert.equal(nextIndex('ArrowLeft', 0, 2, { orientation: 'horizontal' }), 1, 'two cards: either arrow reaches the other');
  assert.equal(nextIndex('ArrowDown', 0, 2, { orientation: 'horizontal' }), null);
  assert.equal(nextIndex('ArrowDown', 1, 3, { orientation: 'both' }), 2);
  assert.equal(nextIndex('ArrowLeft', 1, 3, { orientation: 'both' }), 0);
  assert.equal(nextIndex('ArrowDown', 2, 3, { wrap: false }), 2);
  assert.equal(nextIndex('ArrowUp', 0, 3, { wrap: false }), 0);
  assert.equal(nextIndex('End', 0, 3, { wrap: false }), 2);
});

test('from outside the list the forward arrow enters at the first item and the backward one at the last', () => {
  assert.equal(nextIndex('ArrowDown', -1, 4), 0);
  assert.equal(nextIndex('ArrowUp', -1, 4), 3);
  assert.equal(nextIndex('ArrowUp', -1, 4, { wrap: false }), 3);
  assert.equal(nextIndex('ArrowDown', 9, 4), 0, 'an item that left the list counts as outside');
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) assert.equal(nextIndex(key, -1, 0), null, `an empty list ignores ${key}`);
});

test('typed letters within the pause spell one word; a pause, Space or a shortcut is not typing', () => {
  let clock = 1000;
  const typeahead = createTypeahead(() => clock);
  const items = ['Headset', 'Default', 'Speakers', 'Speakers (USB)', ''].map(textContent => ({ textContent: ` ${textContent} ` }));
  const press = (key: string, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
    typeahead({ key, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }, items)?.textContent?.trim();
  assert.equal(press('s'), 'Speakers');
  clock += TYPEAHEAD_PAUSE_MS - 1;
  assert.equal(press('P'), 'Speakers', 'letters add up, whatever their case');
  clock += TYPEAHEAD_PAUSE_MS;
  assert.equal(press('d'), 'Default', 'after a pause a new word starts');
  assert.equal(press('x'), undefined, 'no item begins with the word');
  assert.equal(press(' '), undefined);
  assert.equal(press('h', { ctrlKey: true }), undefined);
  assert.equal(press('h', { altKey: true }), undefined);
  assert.equal(press('ArrowDown'), undefined);
  clock += TYPEAHEAD_PAUSE_MS;
  assert.equal(press('h'), 'Headset', 'keys that were not typing leave the next word alone');
});
