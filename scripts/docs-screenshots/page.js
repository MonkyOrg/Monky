import fs from 'node:fs/promises';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Minimal Chrome DevTools Protocol session over the page of the captured client. */
export class Page {
  static async attach(port, match) {
    const deadline = Date.now() + 15_000;
    let target;
    while (!target && Date.now() < deadline) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find(item => item.type === 'page' && match(item.url));
      if (!target) await delay(200);
    }
    if (!target) throw new Error('The client page did not expose a DevTools target.');
    const page = new Page(target.webSocketDebuggerUrl);
    await page.opened;
    await page.send('Page.enable');
    return page;
  }

  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`DevTools connection failed: ${url}`)), { once: true });
    });
    this.listeners = new Map();
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(method) ?? [];
      const timer = setTimeout(() => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter(item => item !== listener));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = params => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter(item => item !== listener));
        resolve(params);
      };
      this.listeners.set(method, [...listeners, listener]);
    });
  }

  /** Answers the file picker opened by clicking `selector` with `file`, as a person choosing it would. */
  async chooseFile(selector, file) {
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
    const opened = this.once('Page.fileChooserOpened');
    await this.click(selector);
    const { backendNodeId } = await opened;
    await this.send('DOM.setFileInputFiles', { files: [file], backendNodeId });
    await this.send('Page.setInterceptFileChooserDialog', { enabled: false });
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (exceptionDetails) {
      throw new Error(`Page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}\n${expression.slice(0, 300)}`);
    }
    return result.value;
  }

  async waitFor(selector, { timeoutMs = 15_000, visible = true } = {}) {
    const deadline = Date.now() + timeoutMs;
    const check = `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      if (!${visible}) return true;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    })()`;
    while (Date.now() < deadline) {
      if (await this.eval(check)) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${selector}`);
  }

  async waitUntil(expression, description, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  /** Clicks through the input pipeline, so the app sees a real pointer click. */
  async click(selector, { text } = {}) {
    await this.waitFor(selector);
    const locate = `(() => {
      const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const element = ${text ? `candidates.find(item => item.textContent.trim().includes(${JSON.stringify(text)}))` : 'candidates[0]'};
      if (!element) return null;
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`;
    // Surfaces open with a scale/slide transition; clicking mid-flight misses.
    let box = await this.eval(locate);
    for (let attempt = 0; box && attempt < 20; attempt++) {
      await delay(60);
      const next = await this.eval(locate);
      if (next && next.x === box.x && next.y === box.y) break;
      box = next;
    }
    if (!box) throw new Error(`Nothing to click for ${selector}${text ? ` with "${text}"` : ''}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }

  async hover(selector) {
    const box = await this.eval(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (box) await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  }

  /** Moves the pointer out of the way so no hover state leaks into a capture. */
  async park() {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1279, y: 899 });
  }

  async type(text) {
    await this.send('Input.insertText', { text });
  }

  async key(key, code = key, keyCode = 0) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async escape() {
    await this.key('Escape', 'Escape', 27);
  }

  /** Replaces a field's value the way typing would, so the app's listeners run. */
  async fill(selector, value) {
    await this.waitFor(selector);
    await this.eval(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  /** Fixes the viewport; the app maximizes its window on some flows, so captures reapply it. */
  async setViewport(width, height) {
    this.viewport = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async capture(file, { width, height, keepFocus = false } = {}) {
    if (this.viewport) await this.setViewport(this.viewport.width, this.viewport.height);
    // Transient feedback from the disposable environment (an encoder probe, a
    // copy notice) is not part of the screen being documented, and neither is
    // a blinking caret left by filling a field.
    await this.eval(`document.querySelectorAll('.chat-copy-toast-close').forEach(button => button.click())`);
    if (!keepFocus) await this.eval(`document.activeElement?.matches?.('input, textarea, [contenteditable]') && document.activeElement.blur()`);
    await this.park();
    // Two frames: the hover reset and any transition it triggers have to land.
    await this.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(450);
    const params = { format: 'png' };
    if (width && height) params.clip = { x: 0, y: 0, width, height, scale: 1 };
    const { data } = await this.send('Page.captureScreenshot', params);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
  }

  close() {
    this.ws.close();
  }
}
