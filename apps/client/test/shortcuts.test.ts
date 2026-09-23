import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { EventType, UiohookKey as K, type UiohookKeyboardEvent } from 'uiohook-napi';
import { GlobalInputHook, isPttConfig, parseAcceleratorToHotkey as parseNativeAccelerator } from '../src/main/globalInputHook';
import { WindowsKeyboardLayout } from '../src/main/windowsKeyboardLayout';
import type { KeyboardLayoutSnapshot } from '@monky/screen-audio';
import { captureShortcut, ShortcutCapture, shortcutIdentity } from '../src/renderer/utils/keybind';

class Hook extends EventEmitter {
  starts = 0;
  stops = 0;
  failStart = false;
  failStop = false;
  start(): void { this.starts++; if (this.failStart) throw new Error('test start failure'); }
  stop(): void { this.stops++; if (this.failStop) throw new Error('test stop failure'); }
}

// Isolate generic matching from this machine's layout; the Windows regressions
// below inject verified OS snapshots instead of assuming US native keycodes.
const parseAcceleratorToHotkey = (id: string, accelerator: string) => parseNativeAccelerator(id, accelerator, null);

function fixture(layout: WindowsKeyboardLayout | null = null) {
  const native = new Hook();
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const window = { isDestroyed: () => false, webContents: {
    send: (channel: string, ...args: unknown[]) => { sent.push({ channel, args }); },
  } };
  const hook = new GlobalInputHook(native, layout);
  hook.init(window);
  const key = (keycode: number, down = true, modifiers: Partial<UiohookKeyboardEvent> = {}) => {
    native.emit(down ? 'keydown' : 'keyup', {
      type: down ? EventType.EVENT_KEY_PRESSED : EventType.EVENT_KEY_RELEASED,
      time: Date.now(), keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers,
    } satisfies UiohookKeyboardEvent);
  };
  return { native, hook, sent, key, window };
}

test('legacy saved accelerators, Spanish punctuation, numpad and physical codes all parse', () => {
  for (const [accelerator, code] of [
    ['Q', K.Q], ['q', K.Q], ['º', K.Backquote], ['Ñ', K.Semicolon],
    ['num1', K.Numpad1], ['numadd', K.NumpadAdd], ['+', K.Equal],
    ['Ctrl++', K.Equal], ['code:Semicolon', K.Semicolon], ['code:Backquote', K.Backquote],
    ['code:IntlBackslash', 0x56], ['code:NumpadEnter', K.NumpadEnter],
  ] as const) {
    assert.deepEqual(parseAcceleratorToHotkey('mute', accelerator)?.keyCodes, [code], accelerator);
  }
  assert.equal(parseAcceleratorToHotkey('mute', 'Unknown+Q'), null);
  assert.equal(parseAcceleratorToHotkey('mute', 'code:__proto__'), null);
  assert.equal(parseAcceleratorToHotkey('mute', 'Q+'), null);
  assert.equal(shortcutIdentity('Control+Q+W'), shortcutIdentity('Ctrl+code:KeyW+code:KeyQ'));
  assert.equal(shortcutIdentity('Ctrl++'), shortcutIdentity('Ctrl+code:Equal'));
  assert.equal(shortcutIdentity('Shift+!'), shortcutIdentity('Shift+code:Digit1'));
});

test('capture accumulates any number of simultaneously held ordinary keys and commits after release', () => {
  const capture = new ShortcutCapture();
  const letters = [...'QWERTYUIOPASDFGHJKLZXCVBNM'];
  for (const key of letters) capture.keyDown({ code: `Key${key}`, key: key.toLowerCase(), repeat: false });
  assert.equal(capture.combo?.accelerator.split('+').length, letters.length);
  for (const key of letters.slice(0, -1)) assert.equal(capture.keyUp(`Key${key}`), null);
  const combo = capture.keyUp('KeyM');
  assert.ok(combo);
  assert.equal(parseAcceleratorToHotkey('mute', combo.accelerator)?.keyCodes.length, letters.length);
});

test('capture persists physical Spanish keys while displaying layout labels, modifiers and plus safely', () => {
  const capture = new ShortcutCapture();
  for (const [code, key] of [['ControlLeft', 'Control'], ['Backquote', 'º'], ['Semicolon', 'ñ'], ['Equal', '+']]) {
    capture.keyDown({ code, key, repeat: false });
  }
  assert.match(capture.combo?.display ?? '', /º/);
  assert.match(capture.combo?.display ?? '', /Ñ/);
  assert.deepEqual(new Set(parseAcceleratorToHotkey('mute', capture.combo!.accelerator)?.keyCodes),
    new Set([K.Backquote, K.Semicolon, K.Equal]));
  capture.keyUp('ControlLeft');
  capture.keyDown({ code: 'KeyA', key: 'a', repeat: false });
  assert.ok(!capture.combo?.accelerator.includes('KeyA'), 'a sequence cannot extend a released chord');
});

test('passive Q toggles once per press and reaches other native observers', () => {
  const { native, hook, sent, key } = fixture();
  let observed = 0;
  native.on('keydown', () => observed++);
  assert.equal(hook.setActionHotkeys([{ action: 'toggle_mute', accelerator: 'Q' }]), true);
  key(K.Q); key(K.Q); key(K.Q);
  assert.equal(sent.length, 1);
  assert.equal(observed, 3);
  key(K.Q, false); key(K.Q);
  assert.equal(sent.length, 2);
  hook.destroy();
  assert.equal(native.listenerCount('keydown'), 1, 'teardown leaves other owners intact');
});

test('arbitrary held-key chords work in either order for both actions and sounds', () => {
  const { hook, sent, key } = fixture();
  hook.setActionHotkeys([{ action: 'toggle_mute', accelerator: 'Ctrl+code:KeyQ+code:KeyW+code:KeyE' }]);
  hook.setSoundboardHotkeys([{ soundName: 'bell', accelerator: 'Ctrl+code:KeyQ+code:KeyW+code:KeyE' }]);
  key(K.E); key(K.W); key(K.Q);
  assert.equal(sent.length, 0);
  key(K.Ctrl, true, { ctrlKey: true });
  assert.deepEqual(sent.map((event) => event.channel), ['shortcut:action-triggered', 'soundboard:shortcut-triggered']);
  key(K.Q, true, { ctrlKey: true });
  assert.equal(sent.length, 2);
  key(K.W, false, { ctrlKey: true });
  key(K.W, true, { ctrlKey: true });
  assert.equal(sent.length, 4);
  hook.destroy();
});

test('exact modifiers, releases and modifier toggles never retrigger a held ordinary key', () => {
  const { hook, sent, key } = fixture();
  hook.setActionHotkeys([{ action: 'toggle_mute', accelerator: 'Q' }]);
  key(K.Q, true, { ctrlKey: true });
  key(K.Ctrl, false);
  key(K.W);
  key(K.Q);
  assert.equal(sent.length, 0);
  key(K.Q, false); key(K.Q);
  assert.equal(sent.length, 1);
  key(K.Shift, true, { shiftKey: true }); key(K.Shift, false);
  key(K.Q);
  assert.equal(sent.length, 1);
  hook.destroy();
});

test('stop/start clears stale repeat guards and rebinding held keys cannot spuriously fire', () => {
  const { hook, sent, key } = fixture();
  hook.setActionHotkeys([{ action: 'old', accelerator: 'Q' }]);
  key(K.Q);
  hook.setActionHotkeys([{ action: 'new', accelerator: 'Q' }]);
  key(K.W); key(K.Q);
  assert.equal(sent.length, 1);
  hook.setActionHotkeys([]);
  hook.setActionHotkeys([{ action: 'new', accelerator: 'Q' }]);
  key(K.Q);
  assert.equal(sent.length, 2);
  hook.destroy();
});

test('native capture suppresses shortcuts/PTT and PTT rebinding releases the old active key', () => {
  const { hook, sent, key, native } = fixture();
  const ptt = { enabled: true, key: { keyType: 'keyboard', keyCode: K.Q, code: 'Q', display: 'Q' } };
  hook.setPttConfig(ptt);
  key(K.Q);
  assert.deepEqual(sent.pop()?.args, [true]);
  hook.setPttConfig({ ...ptt, key: { ...ptt.key, keyCode: K.W, code: 'W' } });
  assert.deepEqual(sent.pop()?.args, [false]);
  hook.setActionHotkeys([{ action: 'mute', accelerator: 'W' }]);
  hook.setShortcutCapture(true);
  key(K.W);
  assert.equal(sent.length, 0);
  key(K.W, false);
  hook.setShortcutCapture(false);
  key(K.W);
  assert.deepEqual(sent.map((event) => event.channel), ['ptt:state-changed', 'shortcut:action-triggered']);
  hook.setPttConfig({ enabled: true, key: { keyType: 'mouse', mouseButton: 4, code: 'Mouse4', display: 'Mouse 4' } });
  native.emit('mousedown', { button: 4 }); native.emit('mouseup', { button: 4 });
  assert.deepEqual(sent.slice(-2).map((event) => event.args), [[true], [false]]);
  hook.destroy();
});

test('invalid IPC payloads cannot throw or replace valid registrations', () => {
  const { hook, sent, key } = fixture();
  hook.setActionHotkeys([{ action: 'mute', accelerator: 'Q' }]);
  for (const value of [null, {}, [null], [{ action: 2, accelerator: 'Q' }]]) {
    assert.equal(hook.setActionHotkeys(value), false);
  }
  assert.equal(hook.setShortcutCapture('true'), false);
  assert.equal(hook.setPttConfig({ enabled: true, key: { keyType: 'mouse', mouseButton: '4' } }), false);
  assert.equal(isPttConfig(null), false);
  const cyclic: { enabled: boolean; key: null; extra?: unknown } = { enabled: false, key: null };
  cyclic.extra = cyclic;
  assert.equal(hook.setPttConfig(cyclic), true, 'only validated PTT fields are retained');
  key(K.Q);
  assert.deepEqual(sent[0].args, ['mute']);
  hook.destroy();
});

test('numpad shortcuts survive NumLock-dependent native aliases', () => {
  const { hook, key, sent } = fixture();
  hook.setSoundboardHotkeys([{ soundName: 'bell', accelerator: 'num1' }]);
  key(K.NumpadEnd); key(K.NumpadEnd, false); key(K.Numpad1);
  assert.equal(sent.length, 2);
  hook.destroy();
});

test('an unsupported legacy shortcut cannot disable other valid saved bindings', () => {
  const { hook, key, sent } = fixture();
  assert.equal(hook.setActionHotkeys([
    { action: 'unsupported', accelerator: 'Unknown+Q' },
    { action: 'mute', accelerator: 'Q' },
  ]), false);
  key(K.Q);
  assert.deepEqual(sent.map((event) => event.args), [['mute']]);
  hook.destroy();
});

test('unsupported capture keys invalidate the whole chord instead of saving a weaker shortcut', () => {
  const capture = new ShortcutCapture();
  capture.keyDown({ code: 'KeyQ', key: 'q', repeat: false });
  assert.equal(capture.keyDown({ code: 'Unidentified', key: 'Unknown', repeat: false }), null);
  assert.equal(capture.keyUp('Unidentified', 'Unknown'), null);
  assert.equal(capture.keyUp('KeyQ'), null);
  capture.keyDown({ code: 'KeyW', key: 'w', repeat: false });
  assert.equal(capture.keyUp('KeyW')?.accelerator, 'code:KeyW');
});

test('virtual keyboard events without DOM codes retain logical keys instead of losing the action binding', () => {
  const capture = new ShortcutCapture();
  capture.keyDown({ code: '', key: 'Control', repeat: false, ctrlKey: true });
  capture.keyDown({ code: '', key: 'q', repeat: false, ctrlKey: true });
  capture.keyDown({ code: 'Unidentified', key: 'w', repeat: false, ctrlKey: true });
  assert.equal(capture.keyUp('', 'Control'), null);
  assert.equal(capture.keyUp('Unidentified', 'w'), null);
  const combo = capture.keyUp('', 'q');
  assert.equal(combo?.accelerator, 'Ctrl+Q+W');
  assert.deepEqual(parseAcceleratorToHotkey('mute', combo!.accelerator)?.keyCodes, [K.Q, K.W]);

  const unsupported = new ShortcutCapture();
  assert.equal(unsupported.keyDown({ code: '', key: 'Dead', repeat: false }), null);
  assert.equal(unsupported.keyUp('', 'Dead'), null);
});

test('missing physical codes preserve international logical mappings and plus serialization', () => {
  const capture = new ShortcutCapture();
  capture.keyDown({ code: '', key: 'ñ', repeat: false });
  const combo = capture.keyUp('', 'Ñ');
  assert.equal(combo?.accelerator, 'Ñ');
  const layout = new WindowsKeyboardLayout(() => SPANISH_LAYOUT);
  assert.deepEqual(parseNativeAccelerator('enye', combo!.accelerator, layout)?.keyCodes, [K.Backquote]);

  const plus = new ShortcutCapture();
  plus.keyDown({ code: 'ControlLeft', key: 'Control', repeat: false });
  plus.keyDown({ code: '', key: '+', repeat: false });
  assert.equal(plus.combo?.accelerator, 'Ctrl++');
  assert.deepEqual(parseAcceleratorToHotkey('plus', plus.combo!.accelerator)?.keyCodes, [K.Equal]);

  const shifted = new ShortcutCapture();
  shifted.keyDown({ code: '', key: 'Shift', keyCode: 16, repeat: false, shiftKey: true });
  shifted.keyDown({ code: '', key: '!', keyCode: 49, repeat: false, shiftKey: true });
  assert.equal(shifted.keyUp('', 'Shift', 16), null);
  assert.equal(shifted.keyUp('', '1', 49)?.accelerator, 'Shift+!');
});

test('failed native start is reported, retries use latest registrations, init is idempotent', async () => {
  const { hook, native, window, sent, key } = fixture();
  native.failStart = true;
  assert.equal(hook.setActionHotkeys([{ action: 'old', accelerator: 'Q' }]), false);
  assert.equal(hook.setActionHotkeys([{ action: 'new', accelerator: 'W' }]), false);
  native.failStart = false;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(native.starts, 3);
  hook.init(window);
  assert.equal(native.listenerCount('keydown'), 1);
  key(K.Q); key(K.W);
  assert.deepEqual(sent.map((event) => event.args), [['new']]);
  hook.destroy();
});

test('destroy cancels failed-start retries and hook can be initialized again', async () => {
  const { hook, native, window, key, sent } = fixture();
  native.failStart = true;
  hook.setActionHotkeys([{ action: 'mute', accelerator: 'Q' }]);
  hook.destroy();
  native.failStart = false;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(native.starts, 1);
  hook.init(window);
  hook.setActionHotkeys([{ action: 'mute', accelerator: 'Q' }]);
  key(K.Q);
  assert.equal(sent.length, 1);
  hook.destroy();
});

test('failed stop keeps truthful native state, retries teardown and does not duplicate starts', async () => {
  const { hook, native } = fixture();
  hook.setActionHotkeys([{ action: 'mute', accelerator: 'Q' }]);
  native.failStop = true;
  assert.equal(hook.setActionHotkeys([]), false);
  hook.setSoundboardHotkeys([{ soundName: 'bell', accelerator: 'Q' }]);
  assert.equal(native.starts, 1);
  native.failStop = false;
  hook.destroy();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(native.stops, 2);
  assert.equal(native.listenerCount('keydown'), 0);
});

test('AltGr modifier flags survive capture without a synthetic Ctrl keydown', () => {
  const capture = new ShortcutCapture();
  capture.keyDown({ code: 'AltRight', key: 'AltGraph', repeat: false, ctrlKey: true, altKey: true });
  capture.keyDown({ code: 'KeyQ', key: '@', repeat: false, ctrlKey: true, altKey: true });
  assert.deepEqual(parseAcceleratorToHotkey('mute', capture.combo!.accelerator)?.modifiers, new Set(['Alt', 'Ctrl']));
});

test('DOM recorder previews, saves/persists/registers a chord and cleans up on blur or removal', async () => {
  const descriptors = new Map(['window', 'document', 'MutationObserver'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const win = new EventTarget();
  const captureCalls: boolean[] = [];
  Object.defineProperty(win, 'api', { value: { setShortcutCapture: async (active: boolean) => { captureCalls.push(active); return true; } } });
  let notifyRemoval: (() => void) | undefined;
  let disconnected = 0;
  class Observer {
    constructor(callback: () => void) { notifyRemoval = callback; }
    observe(): void {}
    disconnect(): void { disconnected++; }
  }
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { body: {} }, configurable: true });
  Object.defineProperty(globalThis, 'MutationObserver', { value: Observer, configurable: true });
  const { hook, key, sent } = fixture();
  try {
    const preview = { textContent: '' };
    let saved = '';
    const dispose = captureShortcut({ isConnected: true }, preview, (combo) => {
      saved = JSON.stringify({ action: 'mute', ...combo });
      dispose();
    }, () => dispose());
    await Promise.resolve();
    const dispatch = (code: string, down: boolean) => {
      const event = new Event(down ? 'keydown' : 'keyup', { cancelable: true });
      Object.defineProperties(event, { code: { value: code }, key: { value: code.slice(3) }, repeat: { value: false } });
      win.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    };
    dispatch('KeyQ', true); dispatch('KeyW', true); dispatch('KeyE', true);
    assert.equal(preview.textContent, 'E + Q + W');
    dispatch('KeyE', false); dispatch('KeyW', false);
    assert.equal(saved, '');
    dispatch('KeyQ', false);
    assert.ok(saved);
    assert.equal(hook.setActionHotkeys([JSON.parse(saved)]), true);
    key(K.W); key(K.E); key(K.Q);
    assert.deepEqual(sent.map((event) => event.args), [['mute']]);
    assert.deepEqual(captureCalls, [true, false]);
    assert.equal(disconnected, 1);
    let cancelled = 0;
    const disposeBlur = captureShortcut({ isConnected: true }, null, () => assert.fail('must cancel'),
      () => { cancelled++; disposeBlur(); });
    win.dispatchEvent(new Event('blur'));
    assert.equal(cancelled, 1);
    const owner = { isConnected: true };
    const backdrop = { isConnected: true };
    const disposeRemoved = captureShortcut(backdrop, null, () => assert.fail('must cancel'),
      () => { cancelled++; disposeRemoved(); }, owner);
    owner.isConnected = false;
    notifyRemoval?.();
    assert.equal(cancelled, 2);
    assert.equal(disconnected, 3);
  } finally {
    hook.destroy();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

// Verified Windows Spanish VK slots, not US uiohook constants masquerading as
// physical scans: scan 0x29 (º) -> VK_OEM_5, scan 0x27 (ñ) -> VK_OEM_3.
const SPANISH_LAYOUT: KeyboardLayoutSnapshot = {
  id: 'es-ES',
  scanCodeToVirtualKey: { 41: 0xdc, 39: 0xc0, 16: 0x51 },
  characterToVirtualKey: { 'º': 0xdc, 'ñ': 0xc0, q: 0x51 },
};

test('Windows Spanish physical º and ñ match real VK-derived native events without collisions', () => {
  const layout = new WindowsKeyboardLayout((previous) => previous === SPANISH_LAYOUT.id ? null : SPANISH_LAYOUT);
  const { hook, key, sent } = fixture(layout);
  const ordinal = new ShortcutCapture();
  ordinal.keyDown({ code: 'Backquote', key: 'º', repeat: false });
  const enye = new ShortcutCapture();
  enye.keyDown({ code: 'Semicolon', key: 'ñ', repeat: false });
  const saved = JSON.parse(JSON.stringify([
    { action: 'ordinal', accelerator: ordinal.keyUp('Backquote')?.accelerator },
    { action: 'enye', accelerator: enye.keyUp('Semicolon')?.accelerator },
  ]));
  assert.equal(hook.setActionHotkeys(saved), true);
  key(43); key(43, false);
  key(41); key(41, false);
  assert.deepEqual(sent.map((event) => event.args), [['ordinal'], ['enye']]);
  assert.deepEqual(parseNativeAccelerator('ordinal', 'code:Backquote', layout)?.keyCodes, [43]);
  assert.deepEqual(parseNativeAccelerator('enye', 'code:Semicolon', layout)?.keyCodes, [41]);
  hook.destroy();
});

test('Windows Spanish legacy º/Ñ and multi-key soundboard chords use the same native mapping', () => {
  const layout = new WindowsKeyboardLayout((previous) => previous === SPANISH_LAYOUT.id ? null : SPANISH_LAYOUT);
  const { hook, key, sent } = fixture(layout);
  assert.equal(hook.setActionHotkeys([
    { action: 'ordinal', accelerator: 'º' },
    { action: 'enye', accelerator: 'Ñ' },
  ]), true);
  key(41); key(41, false); key(43); key(43, false);
  assert.deepEqual(sent.map((event) => event.args), [['enye'], ['ordinal']]);
  hook.setActionHotkeys([]);
  hook.setSoundboardHotkeys([{ soundName: 'bell', accelerator: 'Ctrl+code:Backquote+code:Semicolon+code:KeyQ' }]);
  key(43, true, { ctrlKey: true }); key(41, true, { ctrlKey: true });
  assert.equal(sent.length, 2);
  key(16, true, { ctrlKey: true }); key(16, true, { ctrlKey: true });
  assert.deepEqual(sent.slice(2).map((event) => event.args), [['bell']]);
  hook.destroy();
});

test('foreground layout changes rebuild all registrations and clear obsolete pressed VK codes', () => {
  let current: KeyboardLayoutSnapshot = {
    id: 'en-US', scanCodeToVirtualKey: { 41: 0xc0, 39: 0xba }, characterToVirtualKey: {},
  };
  const layout = new WindowsKeyboardLayout((previous) => previous === current.id ? null : current);
  const { hook, key, sent } = fixture(layout);
  hook.setActionHotkeys([{ action: 'physical-ordinal', accelerator: 'code:Backquote' }]);
  key(41);
  current = SPANISH_LAYOUT;
  // The soundboard registration observes the new layout before the hook's next
  // key event. It must not leave existing action registrations on the old map.
  hook.setSoundboardHotkeys([{ soundName: 'enye', accelerator: 'code:Semicolon' }]);
  key(41);
  key(43);
  assert.deepEqual(sent.map((event) => event.args), [['physical-ordinal'], ['enye'], ['physical-ordinal']]);
  hook.destroy();
});

test('Windows AZERTY physical letters differ from legacy logical letter bindings', () => {
  const snapshot: KeyboardLayoutSnapshot = {
    id: 'fr-FR', scanCodeToVirtualKey: { 16: 0x41, 30: 0x51 }, characterToVirtualKey: { a: 0x41, q: 0x51 },
  };
  const layout = new WindowsKeyboardLayout((previous) => previous === snapshot.id ? null : snapshot);
  assert.deepEqual(parseNativeAccelerator('physical-Q', 'code:KeyQ', layout)?.keyCodes, [K.A]);
  assert.deepEqual(parseNativeAccelerator('logical-Q', 'Q', layout)?.keyCodes, [K.Q]);
  assert.deepEqual(parseNativeAccelerator('physical-A', 'code:KeyA', layout)?.keyCodes, [K.Q]);
});

test('Windows ISO key uses the observed native VC_LESSER_GREATER, not its physical scan code', () => {
  const snapshot: KeyboardLayoutSnapshot = {
    id: 'windows-iso', scanCodeToVirtualKey: { 86: 0xe2 }, characterToVirtualKey: {},
  };
  const layout = new WindowsKeyboardLayout((previous) => previous === snapshot.id ? null : snapshot);
  const { hook, key, sent } = fixture(layout);
  assert.equal(hook.setActionHotkeys([{ action: 'iso', accelerator: 'code:IntlBackslash' }]), true);
  assert.equal(hook.setSoundboardHotkeys([{ soundName: 'iso', accelerator: 'code:IntlBackslash' }]), true);
  key(0x56); key(0x56, false);
  assert.equal(sent.length, 0, 'physical Windows scan codes are not libuiohook event codes');
  key(0x0e46); key(0x0e46); key(0x0e46, false);
  assert.deepEqual(sent.map((event) => event.channel), ['shortcut:action-triggered', 'soundboard:shortcut-triggered']);
  hook.destroy();
});

test('legacy character mappings never drop required layout modifiers to fire a different key', () => {
  const snapshot: KeyboardLayoutSnapshot = {
    id: 'altgr-layout', scanCodeToVirtualKey: {}, characterToVirtualKey: { 'ñ': 0x064e },
  };
  const layout = new WindowsKeyboardLayout((previous) => previous === snapshot.id ? null : snapshot);
  assert.equal(parseNativeAccelerator('enye', 'Ñ', layout), null);
  assert.deepEqual(parseNativeAccelerator('enye', 'Ctrl+Alt+Ñ', layout)?.keyCodes, [K.N]);
});

test('missing Windows layout support fails closed instead of silently using US key positions', () => {
  const layout = new WindowsKeyboardLayout(() => null);
  assert.equal(parseNativeAccelerator('ordinal', 'code:Backquote', layout), null);
  const { hook, key, sent } = fixture(layout);
  assert.equal(hook.setActionHotkeys([{ action: 'ordinal', accelerator: 'code:Backquote' }]), false);
  assert.equal(hook.setShortcutCapture(true), false);
  key(41); key(43);
  assert.equal(sent.length, 0);
  hook.destroy();
});

test('layout collisions cannot weaken a two-physical-key chord into a one-key trigger', () => {
  const snapshot: KeyboardLayoutSnapshot = {
    id: 'colliding-layout', scanCodeToVirtualKey: { 16: 0x41, 30: 0x41 }, characterToVirtualKey: {},
  };
  const layout = new WindowsKeyboardLayout((previous) => previous === snapshot.id ? null : snapshot);
  assert.equal(parseNativeAccelerator('two-keys', 'code:KeyQ+code:KeyA', layout), null);
});
