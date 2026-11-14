import test from 'node:test';
import assert from 'node:assert/strict';
import { followPointerReorder, isPrimaryPress, REORDER_HOLD_MS, REORDER_THRESHOLD_PX, type PointerReorder } from '../src/renderer/utils/pointerReorder';

/** The window the drag listens to: events reach its listeners in the order they were added. */
function fakeWindow(context: { after: (fn: () => void) => void }, compact = false): EventTarget {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(target, { matchMedia: () => ({ matches: compact }) }),
  });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return target;
}

/** A list that keeps the pointer, recording what was asked of it. */
class CaptureRecorder {
  isConnected = true;
  readonly calls: string[] = [];
  private readonly held = new Set<number>();
  constructor(private readonly refuse = false) {}
  setPointerCapture(pointerId: number): void {
    this.calls.push(`set ${pointerId}`);
    if (this.refuse) throw new Error('NotFoundError');
    this.held.add(pointerId);
  }
  releasePointerCapture(pointerId: number): void {
    this.calls.push(`release ${pointerId}`);
    this.held.delete(pointerId);
  }
  hasPointerCapture(pointerId: number): boolean {
    return this.held.has(pointerId);
  }
}

function follow(capture: CaptureRecorder, signal?: AbortSignal, pointerType = 'mouse', target: EventTarget | null = null) {
  const log: string[] = [];
  const reorder: PointerReorder = {
    capture,
    signal,
    onStart: () => log.push('start'),
    onMove: (x, y) => log.push(`move ${x},${y}`),
    onDrop: (x, y) => log.push(`drop ${x},${y}`),
    onCancel: () => log.push('cancel'),
  };
  followPointerReorder({ button: 0, isPrimary: true, pointerId: 1, pointerType, clientX: 100, clientY: 100, target }, reorder);
  return log;
}

const pointer = (type: string, clientX: number, clientY: number, pointerId = 1, buttons = 1) =>
  Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX, clientY, buttons });
const key = (name: string) => Object.assign(new Event('keydown', { cancelable: true }), { key: name });
/** Dispatches a click made by code and tells whether a listener added after the release still heard it. */
function clickReaches(target: EventTarget): boolean {
  let heard = false;
  const listener = () => { heard = true; };
  target.addEventListener('click', listener);
  target.dispatchEvent(new Event('click', { cancelable: true }));
  target.removeEventListener('click', listener);
  return heard;
}

test('a press that stays within the threshold is a click: nothing is dragged, captured or swallowed', (context) => {
  const target = fakeWindow(context);
  const capture = new CaptureRecorder();
  const log = follow(capture);
  target.dispatchEvent(pointer('pointermove', 100 + REORDER_THRESHOLD_PX - 1, 100));
  target.dispatchEvent(pointer('pointerup', 100 + REORDER_THRESHOLD_PX - 1, 100));
  assert.deepEqual(log, []);
  assert.deepEqual(capture.calls, []);
  assert.equal(clickReaches(target), true, 'the click of a plain press opens what was pressed');
});

test('moving a finger before the hold scrolls instead of reordering, even at desktop size', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = fakeWindow(context);
  const capture = new CaptureRecorder();
  const log = follow(capture, undefined, 'touch');
  const movement = pointer('pointermove', 100, 160);
  target.dispatchEvent(movement);
  target.dispatchEvent(pointer('pointerup', 100, 200));
  context.mock.timers.tick(REORDER_HOLD_MS);
  assert.deepEqual(log, []);
  assert.deepEqual(capture.calls, []);
  assert.equal(movement.defaultPrevented, false);
  assert.equal(clickReaches(target), true, 'a plain tap remains available to the page');
});

test('compact navigation leaves mouse and pen drags to scrolling instead of reordering', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = fakeWindow(context, true);
  for (const pointerType of ['mouse', 'pen']) {
    const capture = new CaptureRecorder();
    const log = follow(capture, undefined, pointerType);
    const movement = pointer('pointermove', 100, 160);
    target.dispatchEvent(movement);
    target.dispatchEvent(pointer('pointerup', 100, 200));
    context.mock.timers.tick(REORDER_HOLD_MS);
    assert.deepEqual(log, [], pointerType);
    assert.deepEqual(capture.calls, [], pointerType);
    assert.equal(movement.defaultPrevented, false, pointerType);
  }
});

test('holding a finger activates reordering, prevents native pan and context menus, and drops on release', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = fakeWindow(context);
  const capture = new CaptureRecorder();
  const log = follow(capture, undefined, 'touch');
  const before = new Event('touchmove', { cancelable: true });
  target.dispatchEvent(before);
  assert.equal(before.defaultPrevented, false, 'scrolling is not blocked during the hold');
  context.mock.timers.tick(REORDER_HOLD_MS - 1);
  assert.deepEqual(log, []);
  target.dispatchEvent(pointer('pointermove', 102, 101));
  context.mock.timers.tick(1);
  assert.deepEqual(log, ['start']);
  assert.deepEqual(capture.calls, ['set 1']);
  const move = new Event('touchmove', { cancelable: true });
  target.dispatchEvent(move);
  assert.equal(move.defaultPrevented, true, 'the browser cannot take over an activated drag');
  const menu = new Event('contextmenu', { cancelable: true });
  target.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true, 'the hold cannot open a competing menu');
  target.dispatchEvent(pointer('pointermove', 100, 160));
  target.dispatchEvent(pointer('pointerup', 100, 170));
  assert.deepEqual(log, ['start', 'move 100,160', 'drop 100,170']);
  assert.equal(capture.hasPointerCapture(1), false);
  const after = new Event('touchmove', { cancelable: true });
  target.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false, 'native scrolling is restored after dropping');
});

test('compact mouse and pen reordering require a hold, not an ordinary scrolling drag', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = fakeWindow(context, true);
  for (const pointerType of ['mouse', 'pen']) {
    const capture = new CaptureRecorder();
    const log = follow(capture, undefined, pointerType);
    context.mock.timers.tick(REORDER_HOLD_MS);
    assert.deepEqual(log, ['start'], pointerType);
    target.dispatchEvent(pointer('pointermove', 100, 160));
    target.dispatchEvent(pointer('pointerup', 100, 170));
    assert.deepEqual(log, ['start', 'move 100,160', 'drop 100,170'], pointerType);
  }
});

test('an interrupted hold never activates later or interferes with scrolling', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = fakeWindow(context, true);
  for (const interruption of ['release', 'move', 'cancel', 'abort', 'blur', 'scroll', 'resize', 'escape', 'second finger']) {
    const capture = new CaptureRecorder();
    const lifetime = new AbortController();
    const log = follow(capture, lifetime.signal, 'touch');
    switch (interruption) {
      case 'release': target.dispatchEvent(pointer('pointerup', 100, 100)); break;
      case 'move': target.dispatchEvent(pointer('pointermove', 100, 100 + REORDER_THRESHOLD_PX)); break;
      case 'cancel': target.dispatchEvent(pointer('pointercancel', 100, 100)); break;
      case 'abort': lifetime.abort(); break;
      case 'escape': target.dispatchEvent(key('Escape')); break;
      case 'second finger': target.dispatchEvent(pointer('pointerdown', 100, 100, 2)); break;
      default: target.dispatchEvent(new Event(interruption)); break;
    }
    context.mock.timers.tick(REORDER_HOLD_MS);
    target.dispatchEvent(pointer('pointermove', 100, 160));
    target.dispatchEvent(pointer('pointerup', 100, 170));
    assert.deepEqual(log, [], interruption);
    assert.deepEqual(capture.calls, [], interruption);
    const move = new Event('touchmove', { cancelable: true });
    target.dispatchEvent(move);
    assert.equal(move.defaultPrevented, false, interruption);
  }
});

test('a detached item or list cannot activate a hold, and a second finger cancels an active touch drag', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = fakeWindow(context);
  const capture = new CaptureRecorder();
  const detached = follow(capture, undefined, 'touch');
  capture.isConnected = false;
  context.mock.timers.tick(REORDER_HOLD_MS);
  assert.deepEqual(detached, []);
  capture.isConnected = true;
  const item = Object.assign(new EventTarget(), { isConnected: true });
  const replaced = follow(capture, undefined, 'touch', item);
  item.isConnected = false;
  context.mock.timers.tick(REORDER_HOLD_MS);
  assert.deepEqual(replaced, [], 'a repainted item no longer owns the pending hold');
  const active = follow(capture, undefined, 'touch');
  context.mock.timers.tick(REORDER_HOLD_MS);
  target.dispatchEvent(pointer('pointerdown', 100, 100, 2));
  target.dispatchEvent(pointer('pointerup', 100, 170));
  assert.deepEqual(active, ['start', 'cancel']);
  assert.equal(capture.hasPointerCapture(1), false);
});

test('past the threshold the list keeps the pointer, moves are reported and the release drops', (context) => {
  const target = fakeWindow(context);
  const capture = new CaptureRecorder();
  const log = follow(capture);
  target.dispatchEvent(pointer('pointermove', 100, 100 + REORDER_THRESHOLD_PX));
  assert.deepEqual(capture.calls, ['set 1'], 'the pointer is captured only once it drags');
  assert.equal(capture.hasPointerCapture(1), true);
  target.dispatchEvent(pointer('pointermove', 2, 40, 2));
  target.dispatchEvent(pointer('pointermove', 120, 160));
  target.dispatchEvent(pointer('pointerup', 130, 170));
  assert.deepEqual(log, ['start', `move 100,${100 + REORDER_THRESHOLD_PX}`, 'move 120,160', 'drop 130,170'],
    'another pointer moves nothing');
  assert.equal(capture.hasPointerCapture(1), false, 'the capture ends with the drag');
  // The click a person's release makes is swallowed (real input in serverRailReorderDom); one made by code is not.
  assert.equal(clickReaches(target), true, 'a click made by code right after a drop goes through');
  target.dispatchEvent(pointer('pointermove', 300, 300));
  target.dispatchEvent(pointer('pointerup', 300, 300));
  assert.equal(log.length, 4, 'a finished drag hears nothing more');
});

test('Escape cancels the drag, goes no further and the release that follows drops nothing', (context) => {
  const target = fakeWindow(context);
  const capture = new CaptureRecorder();
  const log = follow(capture);
  const early = key('Escape');
  target.dispatchEvent(early);
  assert.equal(early.defaultPrevented, false, 'before the threshold, Escape is left to the page');
  target.dispatchEvent(pointer('pointermove', 100, 120));
  let pageHeard = false;
  target.addEventListener('keydown', () => { pageHeard = true; });
  const escape = key('Escape');
  target.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(pageHeard, false, 'a menu or dialog listening for Escape does not close too');
  assert.deepEqual(log, ['start', 'move 100,120', 'cancel']);
  assert.equal(capture.hasPointerCapture(1), false, 'the pointer is let go at once');
  target.dispatchEvent(pointer('pointermove', 100, 160));
  target.dispatchEvent(key('Escape'));
  target.dispatchEvent(pointer('pointerup', 100, 100));
  assert.deepEqual(log, ['start', 'move 100,120', 'cancel'], 'the cancelled press is not dragged again nor dropped');
});

test('losing the window, the pointer or the list cancels the drag', (context) => {
  const target = fakeWindow(context);
  for (const [label, end] of [
    ['blur', () => target.dispatchEvent(new Event('blur'))],
    ['pointercancel', () => target.dispatchEvent(pointer('pointercancel', 0, 0))],
  ] as const) {
    const capture = new CaptureRecorder();
    const log = follow(capture);
    target.dispatchEvent(pointer('pointermove', 100, 120));
    end();
    target.dispatchEvent(pointer('pointerup', 100, 120));
    assert.deepEqual(log, ['start', 'move 100,120', 'cancel'], label);
    assert.equal(capture.hasPointerCapture(1), false, label);
  }
  const list = new AbortController();
  const capture = new CaptureRecorder();
  const log = follow(capture, list.signal);
  target.dispatchEvent(pointer('pointermove', 100, 120));
  list.abort();
  target.dispatchEvent(pointer('pointerup', 100, 120));
  assert.deepEqual(log, ['start', 'move 100,120', 'cancel'], 'a list torn down mid-drag');
  const pending = follow(new CaptureRecorder(), AbortSignal.abort());
  target.dispatchEvent(pointer('pointermove', 100, 140));
  assert.deepEqual(pending, [], 'a press on a list already torn down is not followed');
});

test('only a primary left press is followed, and a capture the browser refuses still drags', (context) => {
  const target = fakeWindow(context);
  const log: string[] = [];
  const reorder: PointerReorder = {
    capture: new CaptureRecorder(),
    onStart: () => log.push('start'), onMove: () => log.push('move'), onDrop: () => log.push('drop'), onCancel: () => log.push('cancel'),
  };
  followPointerReorder({ button: 2, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, target: null }, reorder);
  followPointerReorder({ button: 0, isPrimary: false, pointerId: 3, pointerType: 'touch', clientX: 0, clientY: 0, target: null }, reorder);
  target.dispatchEvent(pointer('pointermove', 50, 50));
  target.dispatchEvent(pointer('pointermove', 50, 50, 3));
  assert.deepEqual(log, [], 'a right press or a second finger reorders nothing');

  const refusing = new CaptureRecorder(true);
  const moved = follow(refusing);
  target.dispatchEvent(pointer('pointermove', 100, 120));
  target.dispatchEvent(pointer('pointerup', 100, 130));
  assert.deepEqual(moved, ['start', 'move 100,120', 'drop 100,130']);
  assert.deepEqual(refusing.calls, ['set 1']);
});

// A mouse button held for push-to-talk: pointer events send pointerdown only for the first
// button that goes down and pointerup only for the last one that comes up; the left button's
// press and release in between are moves that add or drop it (bit 1 of `buttons`).
const SIDE = 8;

test('the left button pressed while another one is held is a press; released, it is not', () => {
  assert.equal(isPrimaryPress({ isPrimary: true, button: 0, buttons: 1 }), true, 'a plain left press');
  assert.equal(isPrimaryPress({ isPrimary: true, button: 0, buttons: 1 | SIDE }), true, 'the left press added to a held side button');
  assert.equal(isPrimaryPress({ isPrimary: true, button: 0, buttons: SIDE }), false, 'the left release while the side button stays');
  assert.equal(isPrimaryPress({ isPrimary: true, button: -1, buttons: 1 }), false, 'a move with the button already held');
  assert.equal(isPrimaryPress({ isPrimary: true, button: 2, buttons: 2 }), false, 'a right press');
  assert.equal(isPrimaryPress({ isPrimary: false, button: 0, buttons: 1 }), false, 'a second finger');
});

test('letting go of the left button drops at once, even with another button still held', (context) => {
  const target = fakeWindow(context);
  const capture = new CaptureRecorder();
  const log = follow(capture);
  target.dispatchEvent(pointer('pointermove', 100, 120, 1, 1 | SIDE));
  target.dispatchEvent(pointer('pointermove', 100, 140, 1, 1 | SIDE));
  target.dispatchEvent(pointer('pointermove', 100, 150, 1, SIDE));
  assert.deepEqual(log, ['start', 'move 100,120', 'move 100,140', 'drop 100,150']);
  assert.equal(capture.hasPointerCapture(1), false);
  target.dispatchEvent(pointer('pointerup', 300, 300, 1, 0));
  assert.equal(log.length, 4, 'releasing the other button later drops nothing more');

  const pressed = follow(new CaptureRecorder());
  target.dispatchEvent(pointer('pointermove', 100, 102, 1, SIDE));
  target.dispatchEvent(pointer('pointermove', 100, 160, 1, SIDE));
  assert.deepEqual(pressed, [], 'a press let go before it dragged stays a click');

  const escaped = follow(new CaptureRecorder());
  target.dispatchEvent(pointer('pointermove', 100, 120, 1, 1 | SIDE));
  target.dispatchEvent(key('Escape'));
  target.dispatchEvent(pointer('pointermove', 100, 130, 1, SIDE));
  target.dispatchEvent(pointer('pointermove', 100, 160, 1, 1 | SIDE));
  assert.deepEqual(escaped, ['start', 'move 100,120', 'cancel'], 'after Escape the release ends the press quietly');
});
