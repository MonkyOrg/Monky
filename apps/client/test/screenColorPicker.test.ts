import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  isScreenColorPickerAvailable, pickScreenColor, ScreenColorPickerError,
  type ScreenColorPickerErrorCode,
} from '../src/renderer/core/ScreenColorPicker';

interface NativeRequest {
  signal: AbortSignal;
  resolve: (result: { sRGBHex: string }) => void;
  reject: (error: unknown) => void;
}

class PickerWindow extends EventTarget {
  isSecureContext = true;
  EyeDropper: Window['EyeDropper'];
}

async function fixture(run: (environment: {
  window: PickerWindow;
  requests: NativeRequest[];
  document: { hasFocus: () => boolean };
  constructions: () => number;
}) => Promise<void>): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const window = new PickerWindow();
  const document = { hasFocus: () => true };
  const requests: NativeRequest[] = [];
  let constructions = 0;
  window.EyeDropper = class {
    constructor() { constructions++; }
    open({ signal }: { signal: AbortSignal }): Promise<{ sRGBHex: string }> {
      return new Promise((resolve, reject) => requests.push({ signal, resolve, reject }));
    }
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  try {
    await run({ window, document, requests, constructions: () => constructions });
  } finally {
    window.dispatchEvent(new Event('pagehide'));
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

function isError(code: ScreenColorPickerErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ScreenColorPickerError && error.code === code;
}

function assertClean(window: PickerWindow, signal: AbortSignal): void {
  assert.equal(getEventListeners(window, 'pagehide').length, 0, 'owner listener removed');
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'caller listener removed');
}

function lastRequest(requests: NativeRequest[]): NativeRequest {
  const request = requests.at(-1);
  assert.ok(request, 'native open was called');
  return request;
}

test('screen picker availability has no capture, permission or constructor side effects', async () => {
  assert.equal(isScreenColorPickerAvailable(), false, 'safe outside a browser');
  await fixture(async ({ window, requests, constructions }) => {
    assert.equal(isScreenColorPickerAvailable(), true);
    assert.equal(constructions(), 0);
    assert.equal(requests.length, 0);
    window.isSecureContext = false;
    assert.equal(isScreenColorPickerAvailable(), false);
    await assert.rejects(pickScreenColor(new AbortController().signal), isError('unsupported'));
    window.isSecureContext = true;
    window.EyeDropper = undefined;
    assert.equal(isScreenColorPickerAvailable(), false);
    await assert.rejects(pickScreenColor(new AbortController().signal), isError('unsupported'));
  });
});

test('an already-aborted picker never constructs, opens or installs listeners', async () => {
  await fixture(async ({ window, requests, constructions }) => {
    const controller = new AbortController();
    controller.abort(new Error('Component already closed'));
    assert.equal(await pickScreenColor(controller.signal), null);
    assert.equal(constructions(), 0);
    assert.equal(requests.length, 0);
    assertClean(window, controller.signal);
    window.EyeDropper = undefined;
    assert.equal(await pickScreenColor(controller.signal), null, 'cancellation precedes unsupported');
  });
});

test('exact native sRGB colors are normalized and open retains synchronous user activation', async () => {
  await fixture(async ({ window, requests, constructions }) => {
    for (const color of ['#00ff00', '#010203', '#a0B1c2', '#000000', '#FFFFFF', '#1234Ab']) {
      const controller = new AbortController();
      const result = pickScreenColor(controller.signal);
      assert.equal(constructions(), requests.length, 'open happens before the promise is returned');
      const request = lastRequest(requests);
      request.resolve({ sRGBHex: color });
      assert.equal(await result, color.toLowerCase());
      assert.equal(request.signal.aborted, false);
      assertClean(window, controller.signal);
    }
  });
});

test('Escape cancellation is null, not an error or a selected color', async () => {
  await fixture(async ({ window, requests }) => {
    const controller = new AbortController();
    const result = pickScreenColor(controller.signal);
    requests[0].reject(new DOMException('The user canceled the selection.', 'AbortError'));
    assert.equal(await result, null);
    assertClean(window, controller.signal);
  });
});

test('component cancellation aborts native selection immediately and isolates stale success', async () => {
  await fixture(async ({ window, requests }) => {
    const first = new AbortController();
    const oldResult = pickScreenColor(first.signal);
    first.abort('Popup closed');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(await oldResult, null, 'does not wait for a late native reply');
    assertClean(window, first.signal);
    const second = new AbortController();
    const nextResult = pickScreenColor(second.signal);
    requests[0].resolve({ sRGBHex: '#ff0000' });
    await Promise.resolve();
    await assert.rejects(pickScreenColor(new AbortController().signal), isError('busy'));
    requests[1].resolve({ sRGBHex: '#00ff00' });
    assert.equal(await nextResult, '#00ff00');
    assertClean(window, second.signal);
  });
});

test('late native rejection after caller cancellation is handled without leaking a busy lock', async () => {
  await fixture(async ({ window, requests }) => {
    const first = new AbortController();
    const result = pickScreenColor(first.signal);
    first.abort();
    assert.equal(await result, null);
    requests[0].reject(new Error('Late capture failure'));
    await Promise.resolve();
    assertClean(window, first.signal);
    const next = new AbortController();
    const nextResult = pickScreenColor(next.signal);
    requests[1].resolve({ sRGBHex: '#112233' });
    assert.equal(await nextResult, '#112233');
  });
});

test('owner pagehide aborts and settles its picker, removing every app listener', async () => {
  await fixture(async ({ window, requests }) => {
    const controller = new AbortController();
    const result = pickScreenColor(controller.signal);
    window.dispatchEvent(new Event('pagehide'));
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(await result, null);
    assertClean(window, controller.signal);
    requests[0].resolve({ sRGBHex: '#ffffff' });
    await Promise.resolve();
  });
});

test('an unfocused owner fails explicitly instead of becoming native success-shaped cancellation', async () => {
  await fixture(async ({ window, document, requests }) => {
    document.hasFocus = () => false;
    const controller = new AbortController();
    await assert.rejects(pickScreenColor(controller.signal), isError('permission'));
    assert.equal(requests.length, 0, 'Aura cannot open without a focused owner');
    assertClean(window, controller.signal);
  });
});

test('native permission, unsupported, busy and capture failures remain explicit and retain causes', async () => {
  await fixture(async ({ window, requests }) => {
    const cases: [unknown, ScreenColorPickerErrorCode][] = [
      [new DOMException('User gesture required', 'NotAllowedError'), 'permission'],
      [new DOMException('Restricted context', 'SecurityError'), 'permission'],
      [new DOMException('Unsupported platform', 'NotSupportedError'), 'unsupported'],
      [new DOMException('Already open', 'InvalidStateError'), 'busy'],
      [new DOMException('Could not open', 'OperationError'), 'capture'],
      [new Error('Capture failed'), 'capture'],
      ['Unexpected backend failure', 'capture'],
    ];
    for (const [cause, code] of cases) {
      const controller = new AbortController();
      const result = pickScreenColor(controller.signal);
      lastRequest(requests).reject(cause);
      await assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof ScreenColorPickerError);
        assert.equal(error.code, code);
        assert.equal(error.cause, cause);
        return true;
      });
      assertClean(window, controller.signal);
    }
  });
});

test('malformed native replies fail as capture errors rather than null', async () => {
  await fixture(async ({ window, requests }) => {
    for (const color of ['', '#fff', '#12345678', 'green', 'rgb(1, 2, 3)', '#12xx45']) {
      const controller = new AbortController();
      const result = pickScreenColor(controller.signal);
      lastRequest(requests).resolve({ sRGBHex: color });
      await assert.rejects(result, isError('capture'));
      assertClean(window, controller.signal);
    }
  });
});

test('synchronous construction and open failures clean up and permit later picks', async () => {
  await fixture(async ({ window, requests }) => {
    const original = window.EyeDropper;
    const controller = new AbortController();
    window.EyeDropper = class {
      constructor() { throw new Error('Construction failure'); }
      open(): Promise<{ sRGBHex: string }> { throw new Error('Unreachable'); }
    };
    await assert.rejects(pickScreenColor(controller.signal), isError('capture'));
    assertClean(window, controller.signal);
    window.EyeDropper = class {
      open(): Promise<{ sRGBHex: string }> {
        throw new DOMException('User gesture required', 'NotAllowedError');
      }
    };
    await assert.rejects(pickScreenColor(controller.signal), isError('permission'));
    assertClean(window, controller.signal);
    window.EyeDropper = original;
    const result = pickScreenColor(controller.signal);
    requests[0].resolve({ sRGBHex: '#102030' });
    assert.equal(await result, '#102030');
  });
});

test('concurrent requests cannot replace or cancel the current native operation', async () => {
  await fixture(async ({ window, requests }) => {
    const first = new AbortController();
    const current = pickScreenColor(first.signal);
    const second = new AbortController();
    await assert.rejects(pickScreenColor(second.signal), isError('busy'));
    second.abort();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, false);
    requests[0].resolve({ sRGBHex: '#abcdef' });
    assert.equal(await current, '#abcdef');
    assertClean(window, first.signal);
    assertClean(window, second.signal);
  });
});

test('cancellation wins over an unsettled native success and aborts even during synchronous open', async () => {
  await fixture(async ({ window, requests }) => {
    const controller = new AbortController();
    const result = pickScreenColor(controller.signal);
    requests[0].resolve({ sRGBHex: '#ff0000' });
    controller.abort();
    assert.equal(await result, null);
    assertClean(window, controller.signal);
    const next = new AbortController();
    window.EyeDropper = class {
      open({ signal }: { signal: AbortSignal }): Promise<{ sRGBHex: string }> {
        next.abort();
        assert.equal(signal.aborted, true);
        return Promise.resolve({ sRGBHex: '#ffffff' });
      }
    };
    assert.equal(await pickScreenColor(next.signal), null);
    assertClean(window, next.signal);
  });
});
