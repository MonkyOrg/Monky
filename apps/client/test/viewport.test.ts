import test from 'node:test';
import assert from 'node:assert/strict';
import { bindViewportSize } from '../src/renderer/utils/viewport';

class FakeViewport extends EventTarget {
  scale = 1;
  width = 402;
  height = 714;
  offsetTop = 0;
}

class FakeWindow extends EventTarget {
  scrollY = 0;
  visualViewport = new FakeViewport();
}

function install(): { page: FakeWindow; style: Map<string, string>; nextFrame: () => void; restore: () => void } {
  const page = new FakeWindow();
  const style = new Map<string, string>();
  let frames: Array<() => void> = [];
  const root = {
    style: { setProperty: (name: string, value: string) => style.set(name, value), removeProperty: (name: string) => style.delete(name) },
    hasAttribute: () => false,
    toggleAttribute: () => false,
    removeAttribute: () => undefined,
  };
  const fakeDocument = Object.assign(new EventTarget(), { documentElement: root, activeElement: null });
  const globals: Record<string, unknown> = {
    window: page,
    document: fakeDocument,
    HTMLElement: class {},
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => undefined,
  };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return {
    page,
    style,
    nextFrame: () => {
      const due = frames;
      frames = [];
      due.forEach(callback => callback());
    },
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('the app follows iOS scrolling the page to the field before the visual viewport reports it', () => {
  const { page, style, nextFrame, restore } = install();
  const unbind = bindViewportSize();
  try {
    const viewport = page.visualViewport;
    viewport.height = 404;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(style.get('--viewport-top'), '0px');
    // Measured on iOS: the page scrolls 310 px with no event, while visualViewport.offsetTop says 0 for ~350 ms.
    page.scrollY = 310;
    nextFrame();
    assert.equal(style.get('--viewport-top'), '310px', 'the app moves with the page instead of staying raised over an empty gap');
    viewport.offsetTop = 310;
    nextFrame();
    viewport.dispatchEvent(new Event('scroll'));
    assert.equal(style.get('--viewport-top'), '310px', 'the late visual viewport report does not move the app again');
    viewport.height = 714;
    viewport.offsetTop = 0;
    page.scrollY = 0;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(style.get('--viewport-top'), '0px');
    assert.equal(style.get('--viewport-height'), '714px');
  } finally {
    unbind();
    restore();
  }
});
