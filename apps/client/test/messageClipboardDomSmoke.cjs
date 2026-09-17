const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');
const output = path.join(clientRoot, 'dist-test');

if (!process.versions.electron) {
  const profile = path.join(output, `message-clipboard-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_CLIPBOARD_PROFILE: profile, MONKY_HOME: path.join(profile, 'monky-home') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], {
    cwd: clientRoot, env, stdio: 'inherit',
  });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_CLIPBOARD_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      cacheDir: path.join(process.env.MONKY_CLIPBOARD_PROFILE, 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'message-clipboard-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__message_clipboard_smoke__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"><link rel="stylesheet" href="/styles/footerControls.css"><link rel="stylesheet" href="/styles/messageEditing.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const server = vite.httpServer;
    if (!server) throw new Error('Missing clipboard fixture HTTP server');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing clipboard fixture address');
    window = new BrowserWindow({
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: !['data:', 'blob:'].includes(url.protocol) && url.hostname !== '127.0.0.1' });
    });
    timeout = setTimeout(() => { console.error('Message clipboard smoke timed out'); void finish(1); }, 90_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__message_clipboard_smoke__`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    window.webContents.focus();
    const checks = await runSmoke(window);
    console.log(`Message clipboard DOM smoke: ${checks} checks passed (native keys/pointer, real Markdown and MIME blobs; system clipboard untouched)`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runSmoke(window) {
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  const fixture = source => evaluate(`window.messageClipboardFixture.${source}`);
  let checks = 0;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks++;
  };
  const key = async (key, code, virtualKey, modifiers = 0, text) => {
    // CDP bypasses Cocoa's key-binding resolver; native editing needs its command.
    const commands = process.platform === 'darwin' && code === 'KeyZ' && [4, 12].includes(modifiers)
      ? [modifiers === 12 ? 'redo' : 'undo'] : [];
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: virtualKey, commands,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtualKey,
    });
    await fixture('settle()');
  };
  const enter = () => key('Enter', 'Enter', 13, 0, '\r');
  const escape = () => key('Escape', 'Escape', 27);
  const copy = (plain = false, meta = false) => key(plain ? 'C' : 'c', 'KeyC', 67, (meta ? 4 : 2) | (plain ? 8 : 0));
  const click = async selector => {
    const point = await fixture(`point(${JSON.stringify(selector)})`);
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', button: 'left', clickCount: 1, ...point,
    });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', button: 'left', clickCount: 1, ...point,
    });
    await fixture('settle()');
  };
  const more = '[data-message-id="rich"] [data-message-action="more"]';
  const parentCopy = '.floating-context-menu:not(.floating-context-submenu) [aria-haspopup="menu"]';
  const children = '.floating-context-submenu [role="menuitem"]';

  await evaluate(`(${installFixture.toString()})()`);
  try {
    await fixture('prepare("en")');
    checks += await fixture('testHelpers()');
    await fixture('select("[data-message-id=rich] strong", 1, 3)');
    await copy();
    let state = await fixture('state()');
    check(state.last.kind === 'formatted' && state.last.text === 'ol', 'Native Ctrl+C must copy only the selected substring, not the whole message');
    check(state.last.html.includes('<strong>ol</strong>'), 'Partial selection retains the strong ancestor dropped by Range.cloneContents');
    check(state.last.types.join(',') === 'text/plain,text/html', 'Formatted copying supplies standard text/plain and text/html MIME flavors');
    check(state.toast === 'Copied!', 'A successful native copy retains localized accessible feedback');
    await copy(true);
    state = await fixture('state()');
    check(state.last.kind === 'plain' && state.last.text === 'ol' && !state.last.html, 'Native Ctrl+Shift+C contains only visible plain text');
    await copy(false, true);
    check((await fixture('state()')).last.kind === 'formatted', 'Cmd+C follows the same formatted behavior');
    await copy(true, true);
    check((await fixture('state()')).last.kind === 'plain', 'Cmd+Shift+C follows the same plain behavior');
    await fixture('select("[data-message-id=rich] .chat-message-text")');
    await copy();
    state = await fixture('state()');
    check(state.last.text === state.expectedPlain, 'Rendered headings, paragraphs, lists, quotes and code preserve readable line breaks');
    check(!/md-code-header|content_copy|chat-author|chat-timestamp/.test(state.last.html), 'Language headers, code buttons and message chrome never leak into the copy');
    check(!/\*\*bold\*\*|~~strike~~|\[Monky\]/.test(state.last.text), 'Even formatted copying has a genuinely plain-text MIME alternative');
    checks += await fixture('testRichDestination()');
    await copy(true);
    check((await fixture('state()')).last.text === state.expectedPlain, 'Plain mode uses the same visible text for an entire rendered selection');

    await fixture('clearSelection(); window.messageClipboardFixture.focusRow("rich")');
    await copy();
    check((await fixture('state()')).last.text === state.expectedPlain, 'Without a selection, Ctrl+C copies only the keyboard-focused message');
    await fixture('preparePaste("draft ", 6, 6)');
    const pasted = await fixture('pasteLast()');
    state = await fixture('state()');
    check(pasted && state.input === `draft ${state.source}`, 'Pasting a full formatted message into Monky restores the exact Markdown source as editable text');
    check(state.draft === state.input, 'Formatted paste updates the existing draft, counter and input lifecycle');
    await key('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
    state = await fixture('state()');
    check(state.input === 'draft ', `Native Undo reverts the formatted paste without erasing the prior draft: ${JSON.stringify({
      input: state.input, historyInputType: state.historyInputType,
    })}`);
    check(state.historyInputType === 'historyUndo', 'Undo uses the real trusted native editing history event');
    if (process.platform === 'darwin') await key('Z', 'KeyZ', 90, 12);
    else await key('y', 'KeyY', 89, 2);
    state = await fixture('state()');
    check(state.historyInputType === 'historyRedo' && state.input === `draft ${state.source}`,
      'Native Redo restores the formatted paste through the same editing history');

    for (const locale of ['pt-BR', 'en']) {
      await fixture(`prepare(${JSON.stringify(locale)})`);
      await fixture('select("[data-message-id=rich] strong", 1, 3)');
      await click(more);
      const before = (await fixture('state()')).writes;
      await click(parentCopy);
      state = await fixture('state()');
      check(state.writes === before && state.menuCount === 2, 'The Copy parent opens a submenu rather than copying immediately');
      check(state.submenuLabels[0].includes(locale === 'en' ? 'With formatting' : 'Com formatação') &&
        state.submenuLabels[1].includes(locale === 'en' ? 'Without formatting' : 'Sem formatação'), 'Both submenu choices are localized');
      check(state.submenuExpanded && state.submenuControlled && state.submenuLabels[1].includes('Shift+C'),
        'The submenu exposes aria-haspopup, aria-expanded, aria-controls and shortcut hints');
      await click(`${children}:first-child`);
      state = await fixture('state()');
      check(state.last.text === 'ol' && state.last.kind === 'formatted', 'Pointer navigation preserves the selected fragment captured before the submenu takes focus');
      check(state.menuCount === 0 && state.toolbarDismissed && state.toast === (locale === 'en' ? 'Copied!' : 'Copiado!'),
        `A submenu choice closes both menus, dismisses the toolbar and retains existing copy feedback: ${JSON.stringify({
          menus: state.menuCount, dismissed: state.toolbarDismissed, toast: state.toast, locale,
        })}`);

      await fixture('clearSelection(); window.messageClipboardFixture.focusMore()');
      await enter();
      await key('ArrowDown', 'ArrowDown', 40);
      await key('ArrowDown', 'ArrowDown', 40);
      await key('ArrowRight', 'ArrowRight', 39);
      state = await fixture('state()');
      check(state.submenuFocus === 0, 'Keyboard Right opens Copy and focuses its first choice');
      await key('End', 'End', 35);
      check((await fixture('state()')).submenuFocus === 1, 'End navigates within the submenu, not the parent menu');
      await key('Home', 'Home', 36);
      await key('ArrowUp', 'ArrowUp', 38);
      check((await fixture('state()')).submenuFocus === 1, 'Up wraps among the two copy modes');
      await enter();
      state = await fixture('state()');
      check(state.last.kind === 'plain' && state.last.text === state.expectedPlain && !state.last.html,
        'Keyboard submenu plain copy strips all Markdown formatting from the full message');

      await fixture('focusMore()');
      await enter();
      await key('ArrowDown', 'ArrowDown', 40);
      await key('ArrowDown', 'ArrowDown', 40);
      await key(' ', 'Space', 32, 0, ' ');
      check((await fixture('state()')).submenuFocus === 0, 'Space opens a focused submenu using native button semantics');
      await key('ArrowLeft', 'ArrowLeft', 37);
      state = await fixture('state()');
      check(state.menuCount === 1 && state.parentFocused, 'Left closes only the submenu and restores focus to Copy');
      await key('ArrowRight', 'ArrowRight', 39);
      await escape();
      check((await fixture('state()')).menuCount === 1, 'First Escape returns from the submenu');
      await escape();
      state = await fixture('state()');
      check(state.menuCount === 0 && state.moreFocused, 'Second Escape closes the parent and restores focus to More options');
      await enter();
      await key('Tab', 'Tab', 9, 0, '\t');
      check((await fixture('state()')).menuCount === 0, 'Tab dismisses the entire menu without trapping focus');
    }

    await fixture('prepare("en")');
    await fixture('select("[data-message-id=rich] pre code", 6, 12)');
    await copy();
    state = await fixture('state()');
    check(state.last.text === 'sample' && state.last.html.includes('<pre'), 'A code selection copies only literal selected code, retaining preformatted HTML');
    await fixture('clearSelection()');
    await click('[data-message-id="rich"] .md-code-copy');
    state = await fixture('state()');
    check(state.last.kind === 'plain' && state.last.text === state.code && !state.last.html, 'The existing code-block button still copies exact literal code without fences or headers');
    check(state.codeCopied, 'Code-block copy retains its own inline feedback');
    await fixture('focusRow("files")');
    await copy();
    state = await fixture('state()');
    check(state.last.text === 'report **literal**.txt\nimage.png' && !state.last.html, 'Attachment-only copying keeps literal file names, never Markdown-parsed names or media data');
    await copy(true);
    check((await fixture('state()')).last.text === state.last.text, 'Both modes retain attachment-only filename copying');
    await fixture('focusRow("caption")');
    await copy(true);
    check((await fixture('state()')).last.text === 'Caption', 'A message with attachments still copies its caption instead of appending filenames');

    checks += await fixture('testScopesAndPaste()');
    checks += await fixture('testLifecycleAndFailures()');
    state = await fixture('state()');
    check(state.trustedKeys > 20 && state.trustedClicks > 5, 'Smoke scenarios actually exercise native keyboard and pointer events');
    check(state.trustedCopyEvents === 0, 'Native copies are intercepted before browser clipboard mutation; the user clipboard remains untouched');
  } catch (error) {
    fs.writeFileSync(path.join(output, 'message-clipboard-failure.png'), (await window.webContents.capturePage()).toPNG());
    throw error;
  } finally {
    await fixture('cleanup()');
  }
  return checks;
}

async function installFixture() {
  const [{ ChatView }, { sessionManager }, { appEvents }, language, clipboard, { contextMenu }, { stickerToken }] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/core/EventBus.ts'),
    import('/i18n/index.ts'), import('/utils/messageClipboard.ts'), import('/views/ContextMenu.ts'), import('/utils/stickers.ts'),
  ]);
  const root = document.getElementById('app');
  root.style.cssText = 'height:100vh;width:100%;display:flex;flex-direction:column;';
  const code = 'const sample = "<tag>";\n  console.log(sample);';
  const source = '# Heading\n\nA **bold** and *italic* with ~~strike~~ and `x < y`.\n\n[Monky](https://example.invalid/docs?a=1&b=2)\n\n> A quote\n> Second line\n\n- First **item**\n- Second item\n\n1. One\n2. Two\n\n---\n\n```js\n' + code + '\n```';
  const expectedPlain = 'Heading\n\nA bold and italic with strike and x < y.\n\nMonky\n\nA quote\nSecond line\n\nFirst item\nSecond item\n\nOne\nTwo\n\n' + code;
  const user = { id: 'clipboard-author', clientId: 'clipboard-device', nickname: 'Author', status: 'ONLINE', joinedAt: 1 };
  const attachment = { id: 'file-one', messageId: 'files', kind: 'file', url: null, originalName: 'report **literal**.txt',
    mimeType: 'text/plain', sizeBytes: 4, createdAt: 1, evicted: true };
  sessionManager.install();
  const session = sessionManager.create('message-clipboard-local', 49216, user.nickname);
  session.serverStore.setServerDetails({
    id: 'clipboard-server', name: 'Clipboard fixture', createdAt: 1, maxUsers: 10, voiceStates: {}, allowMessageEdit: true,
    channels: ['chat', 'other'].map((id, position) => ({
      id, name: id, serverId: 'clipboard-server', type: 'TEXT', position, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
    })),
    members: [user], knownMembers: [user], roles: [], userRoles: [], myPermissions: 2147483647, ownerId: user.id,
  }, user);
  session.client.getStatus = () => 'CONNECTED';
  session.client.getCurrentServerUrl = () => session.key;
  session.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  session.client.send = () => {};
  session.client.sendRequest = () => Promise.resolve({ selectors: [] });
  sessionManager.activate(session.key);

  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writes = [];
  const pending = [];
  let writeMode = 'resolve';
  let view;
  let filePastes = 0;
  let trustedKeys = 0;
  let trustedClicks = 0;
  let trustedCopyEvents = 0;
  let historyInputType = '';
  const onKey = event => { if (event.isTrusted) trustedKeys++; };
  const onClick = event => { if (event.isTrusted) trustedClicks++; };
  const onCopy = event => { if (event.isTrusted) trustedCopyEvents++; };
  const onInput = event => {
    if (event.isTrusted && event instanceof InputEvent && event.target?.id === 'chat-message-input') {
      historyInputType = event.inputType;
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onClick);
  document.addEventListener('copy', onCopy);
  document.addEventListener('input', onInput);
  const write = entry => {
    writes.push(entry);
    if (writeMode === 'reject') return Promise.reject(new Error('Clipboard denied by fixture'));
    if (writeMode === 'hold') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return Promise.resolve();
  };
  // Real ClipboardItem/Blob encoding with a controlled sink, never the user's OS clipboard.
  const clipboardSink = {
    write: items => write({ kind: 'formatted', items }),
    writeText: text => write({ kind: 'plain', text }),
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboardSink });

  const tracked = new Map();
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const trackedTypes = new Set(['copy', 'paste', 'keydown', 'pointerdown', 'contextmenu', 'resize', 'scroll']);
  const listenerKey = (target, type, options) =>
    `${target === document ? 'document' : 'window'}:${type}:${typeof options === 'boolean' ? options : !!options?.capture}`;
  EventTarget.prototype.addEventListener = function(type, callback, options) {
    if ((this === document || this === window) && trackedTypes.has(type) && callback) {
      if (!tracked.has(callback)) tracked.set(callback, new Set());
      tracked.get(callback).add(listenerKey(this, type, options));
    }
    return originalAdd.call(this, type, callback, options);
  };
  EventTarget.prototype.removeEventListener = function(type, callback, options) {
    if (this === document || this === window) {
      tracked.get(callback)?.delete(listenerKey(this, type, options));
      if (tracked.get(callback)?.size === 0) tracked.delete(callback);
    }
    return originalRemove.call(this, type, callback, options);
  };
  const listenerCount = () => [...tracked.values()].reduce((total, keys) => total + keys.size, 0);
  const busSnapshot = () => JSON.stringify([...appEvents.listeners].map(([name, callbacks]) => [name, callbacks.size]).sort());
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing clipboard fixture element: ${selector}`);
    return element;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const makeData = (text, html) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    if (html) data.setData('text/html', html);
    return data;
  };
  const last = async () => {
    const entry = writes.at(-1);
    if (!entry) return null;
    if (entry.kind === 'plain') return { kind: 'plain', text: entry.text, types: ['text/plain'] };
    check(entry.items.length === 1 && entry.items[0] instanceof ClipboardItem, 'Formatted copies must use an actual ClipboardItem');
    const item = entry.items[0];
    return { kind: 'formatted', types: item.types,
      text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
  };
  const clearSelection = () => window.getSelection().removeAllRanges();
  const focusRow = (id = 'rich') => {
    const row = find(`[data-message-id="${id}"].chat-message-row`);
    row.tabIndex = -1;
    row.scrollIntoView({ block: 'nearest' });
    row.focus({ preventScroll: true });
  };
  const textPoint = (element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (offset <= node.textContent.length) return { node, offset };
      offset -= node.textContent.length;
      node = walker.nextNode();
    }
    throw new Error('Selection offset exceeds fixture text');
  };
  const select = (selector, from, to) => {
    const element = find(selector);
    const row = element.closest('.chat-message-row');
    if (row) focusRow(row.dataset.messageId);
    const range = document.createRange();
    if (from === undefined) range.selectNodeContents(element);
    else {
      const start = textPoint(element, from);
      const end = textPoint(element, to);
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    }
    clearSelection();
    window.getSelection().addRange(range);
  };
  const keyboard = (target, options = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const copyEvent = (target, data = new DataTransfer()) => {
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, text: data.getData('text/plain'), html: data.getData('text/html'), types: data.types };
  };
  const paste = (target, data) => {
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const preparePaste = (value = '', start = value.length, end = start) => {
    clearSelection();
    const input = find('#chat-message-input');
    input.focus();
    input.value = value;
    input.setSelectionRange(start, end);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const dismissAlert = () => document.querySelector('.dialog-card [data-action="confirm"]')?.click();
  const openMenu = () => {
    clearSelection();
    find('[data-message-id="rich"] [data-message-action="more"]').click();
    find('.floating-context-menu [aria-haspopup="menu"]').click();
  };
  const prepare = async locale => {
    view?.destroy();
    clearSelection();
    dismissAlert();
    root.innerHTML = '';
    language.setLanguage(locale);
    session.chatStore.clear();
    const message = { channelId: 'chat', userId: user.id, userNickname: user.nickname, createdAt: 1, isSystem: false };
    session.chatStore.setHistory('chat', [
      { ...message, id: 'rich', content: source },
      { ...message, id: 'second', content: 'A **second** message.', createdAt: 2 },
      { ...message, id: 'files', content: '', attachments: [attachment, { ...attachment, id: 'file-two', originalName: 'image.png' }], createdAt: 3 },
      { ...message, id: 'caption', content: '**Caption**', attachments: [attachment], createdAt: 4 },
      { ...message, id: 'sticker', content: stickerToken('sticker-image'),
        attachments: [{ ...attachment, id: 'sticker-image', kind: 'image', originalName: 'sticker.png' }], createdAt: 5 },
      { ...message, id: 'deleted', content: 'Secret removed text', deletedAt: 7, createdAt: 6 },
    ]);
    session.chatStore.setHistory('other', []);
    writes.length = 0;
    writeMode = 'resolve';
    filePastes = 0;
    historyInputType = '';
    view = new ChatView(root);
    view.addFiles = () => { filePastes++; };
    view.setChannel('chat');
    await document.fonts.ready;
    await settle();
  };

  window.messageClipboardFixture = {
    prepare, settle, select, clearSelection, focusRow, preparePaste,
    focusMore() { find('[data-message-id="rich"] [data-message-action="more"]').focus(); },
    async point(selector) {
      const element = find(selector);
      element.scrollIntoView({ block: 'nearest' });
      await settle();
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    async pasteLast() {
      const entry = await last();
      return paste(find('#chat-message-input'), makeData(entry.text, entry.html));
    },
    async state() {
      const input = root.querySelector('#chat-message-input');
      const parent = document.querySelector('.floating-context-menu:not(.floating-context-submenu) [aria-haspopup="menu"]');
      const submenu = document.querySelector('.floating-context-submenu');
      return {
        source, code, expectedPlain, last: await last(), writes: writes.length,
        input: input?.value, draft: session.chatStore.getDraft(view.currentChannelId), historyInputType,
        toast: document.querySelector('.chat-copy-toast-label')?.textContent ?? '',
        menuCount: document.querySelectorAll('.floating-context-menu').length,
        submenuLabels: [...(submenu?.querySelectorAll('button') ?? [])].map(button => button.textContent),
        submenuFocus: [...(submenu?.querySelectorAll('button') ?? [])].indexOf(document.activeElement),
        submenuExpanded: parent?.getAttribute('aria-expanded') === 'true',
        submenuControlled: !!submenu && parent?.getAttribute('aria-controls') === submenu.id,
        parentFocused: document.activeElement === parent,
        moreFocused: document.activeElement?.dataset.messageAction === 'more',
        toolbarDismissed: root.querySelector('[data-message-id="rich"]')?.classList.contains('chat-message-actions-dismissed'),
        codeCopied: !!root.querySelector('.md-code-copy--done'),
        trustedKeys, trustedClicks, trustedCopyEvents,
      };
    },
    testHelpers() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      const rich = find('[data-message-id="rich"] .chat-message-text');
      expect(!!rich.querySelector('h1') && !!rich.querySelector('strong') && !!rich.querySelector('pre .hljs'),
        'Tests must exercise the real Markdown renderer including syntax highlighting');
      const full = clipboard.renderedMessageClipboard(rich, source);
      expect(full.text === expectedPlain, `Plain visible serialization differs: ${JSON.stringify(full.text)}`);
      expect(full.html.includes('<h1>Heading</h1>') && full.html.includes('<em>italic</em>') &&
        full.html.includes('<del>strike</del>') && full.html.includes('<blockquote>') && full.html.includes('<ul>') &&
        full.html.includes('<ol>') && full.html.includes('<hr>') && full.html.includes('font-family: monospace'),
      'Formatted HTML retains semantic headings, emphasis, strike, quote, lists, separator and code');
      expect(clipboard.readMonkyClipboardMarkdown(makeData(full.text, full.html)) === source, 'Full-message source round-trips exactly through the HTML MIME metadata');
      const whitespace = clipboard.markdownMessageClipboard('  two  spaces\tend  ');
      const whitespaceTemplate = document.createElement('template');
      whitespaceTemplate.innerHTML = whitespace.html;
      expect(whitespace.text === '  two  spaces\tend  ' && whitespaceTemplate.content.firstElementChild.style.whiteSpace === 'pre-wrap',
        'Spaces and tabs visible in the chat also survive rich-text destinations without Monky stylesheets');
      expect(clipboard.readMonkyClipboardMarkdown(makeData('bold', full.html)) === null,
        'Stale whole-message metadata from a partial external rich-text copy is ignored');
      select('[data-message-id=rich] strong', 1, 3);
      const forward = window.getSelection().getRangeAt(0).cloneRange();
      window.getSelection().setBaseAndExtent(forward.endContainer, forward.endOffset, forward.startContainer, forward.startOffset);
      const backwards = clipboard.selectedMessageClipboard(find('#chat-messages-feed'), window.getSelection());
      expect(backwards.text === 'ol' && backwards.html.includes('<strong>ol</strong>'), 'Backward selections preserve exactly the same fragment and inline formatting');
      select('[data-message-id=rich] a', 1, 4);
      const link = clipboard.selectedMessageClipboard(find('#chat-messages-feed'), window.getSelection());
      expect(link.text === 'onk' && link.html.includes('href="https://example.invalid/docs?a=1&amp;b=2"'),
        'Partial link selections preserve their safe target without expanding the visible label');
      expect(clipboard.readMonkyClipboardMarkdown(makeData(link.text, link.html)) === '[onk](https://example.invalid/docs?a=1&b=2)',
        'Formatted partial selections can be reused as Markdown in Monky');
      select('[data-message-id=rich] pre code', 6, 12);
      const codeCopy = clipboard.selectedMessageClipboard(find('#chat-messages-feed'), window.getSelection());
      expect(codeCopy.text === 'sample' && !codeCopy.html.includes('hljs-'), 'Highlight spans never change copied code text');
      select('[data-message-id=rich] strong', 0, 4);
      const range = window.getSelection().getRangeAt(0);
      const end = textPoint(find('[data-message-id=second] strong'), 3);
      range.setEnd(end.node, end.offset);
      const across = clipboard.selectedMessageClipboard(find('#chat-messages-feed'), window.getSelection());
      expect(across.text.startsWith('bold and italic') && across.text.endsWith('A sec') && !across.text.includes('Author'),
        'Cross-message selection clips both endpoints and excludes authors and timestamps');
      expect(!across.text.includes('Heading') && !across.text.endsWith('second message.'), 'Cross-message copying never expands either partially selected endpoint');
      clearSelection();

      const template = document.createElement('template');
      template.innerHTML = '<strong id="unsafe" onclick="window.clipboardExecuted=true">Safe</strong><script>window.clipboardExecuted=true</script><iframe src="https://example.invalid/iframe"></iframe><a href="javascript:alert(1)" onmouseover="alert(1)">Label</a><img src="https://example.invalid/image" onerror="alert(1)"><style>body{display:none}</style>';
      const safe = clipboard.renderedMessageClipboard(template.content);
      const exported = document.createElement('template');
      exported.innerHTML = safe.html;
      expect(safe.text === 'SafeLabel' && !exported.content.querySelector('script, style, iframe, img, [onclick], [onerror], a'),
        'The clipboard whitelist removes executable elements, attributes and non-HTTP links');
      expect(!window.clipboardExecuted && !document.getElementById('unsafe'), 'Clipboard processing never mounts untrusted HTML');
      const literal = clipboard.markdownMessageClipboard('<img src=x onerror=alert(1)>');
      const literalTemplate = document.createElement('template');
      literalTemplate.innerHTML = literal.html;
      expect(literal.text === '<img src=x onerror=alert(1)>' && !literalTemplate.content.querySelector('img'),
        'Raw HTML in a chat message remains visible literal text in both MIME flavors');
      const duplicate = `${full.html}${full.html}`;
      expect(clipboard.readMonkyClipboardMarkdown(makeData(full.text, duplicate)) === null, 'Ambiguous multiple metadata sources are ignored');
      expect(clipboard.readMonkyClipboardMarkdown(makeData('plain', '<b>External rich text</b>')) === null,
        'External rich HTML does not become trusted Markdown or DOM');
      expect(clipboard.readMonkyClipboardMarkdown(makeData('plain', 'x'.repeat(1_000_001))) === null, 'Oversized external HTML is bounded before parsing');
      return checks;
    },
    async testRichDestination() {
      const entry = await last();
      const editor = document.createElement('div');
      editor.contentEditable = 'true';
      editor.innerHTML = entry.html;
      document.body.appendChild(editor);
      try {
        check(Number(getComputedStyle(editor.querySelector('strong')).fontWeight) >= 600 &&
          getComputedStyle(editor.querySelector('em')).fontStyle === 'italic', 'A rich-text destination retains bold and italic without Monky CSS classes');
        check(editor.querySelector('a').href === 'https://example.invalid/docs?a=1&b=2' &&
          editor.querySelector('pre code').textContent === code, 'A rich destination retains safe links and literal preformatted code');
        check(!editor.querySelector('button, .md-code-header, script'), 'Rich destinations receive content, not chat controls');
        return 3;
      } finally { editor.remove(); }
    },
    async testScopesAndPaste() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      await prepare('en');
      const full = clipboard.markdownMessageClipboard(source);
      const data = makeData(full.text, full.html);
      const input = find('#chat-message-input');
      for (const tag of ['input', 'textarea', 'div']) {
        const field = document.createElement(tag);
        if (tag === 'div') { field.contentEditable = 'true'; field.innerHTML = '<span>Editable text</span>'; }
        else field.value = '**literal input**';
        document.body.appendChild(field);
        field.focus();
        for (const shiftKey of [false, true]) expect(!keyboard(field, { shiftKey }), `${tag} keeps its native copy shortcut`);
        expect(!copyEvent(field).prevented, `${tag} keeps native Edit/Copy behavior`);
        field.remove();
      }
      preparePaste('**literal composer**', 0, 19);
      expect(!keyboard(input) && !keyboard(input, { shiftKey: true }) && !copyEvent(input).prevented,
        'The chat composer retains native literal copying in both shortcut modes');
      input.readOnly = true;
      expect(!paste(input, data), 'A read-only composer is not changed by formatted paste');
      input.readOnly = false;
      preparePaste('draft before editing');
      view.startEditingMessage('second');
      expect(!keyboard(input) && !keyboard(input, { shiftKey: true }), 'Message editing does not lose native editor copy shortcuts');
      view.cancelMessageEdit();

      select('[data-message-id=rich] strong', 1, 3);
      const before = writes.length;
      for (const options of [{ ctrlKey: false }, { altKey: true }, { isComposing: true }, { key: 'v' }, { key: 'x' }]) {
        expect(!keyboard(document.activeElement, options), 'Unrelated modifiers, IME, paste and cut remain native');
      }
      const external = document.createElement('button');
      external.textContent = 'Another dialog';
      document.body.appendChild(external);
      external.focus();
      expect(!keyboard(external) && !copyEvent(external).prevented, 'A lingering chat selection never steals shortcuts from another dialog');
      const outside = document.createElement('p');
      outside.textContent = 'Outside chat';
      document.body.appendChild(outside);
      focusRow('rich');
      const range = window.getSelection().getRangeAt(0);
      range.setEnd(outside.firstChild, 7);
      expect(!keyboard(document.activeElement) && !keyboard(document.activeElement, { shiftKey: true }),
        'Selections extending outside the chat are left native, never expanded to a full message');
      outside.remove();
      external.remove();
      clearSelection();
      document.activeElement.blur();
      expect(!keyboard(document.body) && writes.length === before, 'No focus and no selection never copies the entire feed or a hovered row');
      select('[data-message-id=rich] strong', 1, 3);
      const copied = copyEvent(document.activeElement);
      expect(copied.prevented && copied.text === 'ol' && copied.html.includes('<strong>ol</strong>'),
        'Native Edit/Copy events use the same formatted, selection-aware MIME serialization');
      const empty = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(empty);
      expect(!empty.defaultPrevented, 'Copy events without clipboardData retain browser behavior');
      const handled = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
      handled.preventDefault();
      document.activeElement.dispatchEvent(handled);
      expect(writes.length === before, 'Already-handled events are not copied a second time');
      select('[data-message-id=rich] .chat-author-name', 1, 4);
      expect(!keyboard(document.activeElement), 'Ordinary author-name copying keeps browser behavior');
      expect(keyboard(document.activeElement, { shiftKey: true }), 'Plain-copy shortcuts also work for other selected visible text inside the feed');
      await settle();
      expect((await last()).text === 'uth' && (await last()).kind === 'plain', 'Author-name selections never expand into the message body');
      const other = sessionManager.create('message-clipboard-other', 49217, user.nickname);
      sessionManager.activate(other.key);
      select('[data-message-id=rich] strong', 1, 3);
      expect(!keyboard(document.activeElement) && !copyEvent(document.activeElement).prevented, 'A background session cannot handle foreground clipboard shortcuts');
      sessionManager.activate(session.key);
      other.client.dispose();

      preparePaste('prefix replace suffix', 7, 14);
      expect(paste(input, makeData(copied.text, copied.html)) && input.value === 'prefix **ol** suffix',
        'A partial formatted paste replaces only the composer selection');
      expect(session.chatStore.getDraft('chat') === input.value, 'Formatted selection paste persists through the existing input event');
      preparePaste('untouched');
      expect(!paste(input, makeData('plain text')) && input.value === 'untouched', 'Plain clipboard content keeps native paste behavior');
      input.blur();
      expect(!paste(input, data) && input.value === 'untouched', 'A paste dispatched to an unfocused composer cannot insert into a different active editor');
      input.focus();
      expect(!paste(input, makeData('external', '<strong>external</strong>')), 'Unmarked rich HTML also keeps native plain-text paste behavior');
      expect(!paste(input, makeData('ol', full.html)), 'Mismatched metadata cannot paste a whole message in place of a copied fragment');

      const unsafeText = '<img id="clipboard-injected" src=x onerror="window.clipboardExecuted=true">';
      const unsafe = clipboard.markdownMessageClipboard(unsafeText);
      preparePaste('');
      expect(paste(input, makeData(unsafe.text, unsafe.html)) && input.value === unsafeText, 'Even spoofed clipboard source metadata is inserted only as textarea text');
      expect(!document.getElementById('clipboard-injected') && !window.clipboardExecuted, 'Formatted paste never treats clipboard HTML as executable markup');
      const capacity = input.maxLength;
      input.maxLength = 12;
      preparePaste('1234567890', 5, 10);
      expect(paste(input, data) && input.value.length === 12 && input.value.startsWith('12345'), 'Formatted paste respects the existing maxlength and replacement capacity');
      input.maxLength = capacity;

      const originalCommand = document.execCommand;
      document.execCommand = () => false;
      try {
        preparePaste('before ', 7, 7);
        expect(paste(input, makeData(copied.text, copied.html)) && input.value === 'before **ol**',
          'Unsupported undo-aware insertion falls back to a bounded textarea replacement');
        expect(session.chatStore.getDraft('chat') === input.value, 'The insertion fallback still notifies draft and counter listeners');
      } finally { document.execCommand = originalCommand; }
      preparePaste('');
      const files = makeData(full.text, full.html);
      files.items.add(new File(['fixture'], 'clipboard-file.txt', { type: 'text/plain' }));
      expect(paste(input, files) && filePastes === 1 && input.value === '', 'File paste keeps precedence over text metadata and uploads exactly once');
      clearSelection();
      input.blur();
      expect(paste(document.body, files) && filePastes === 2, 'The existing global file paste still works outside editable fields');
      const detachedInput = input;
      view.render();
      await settle();
      expect(!paste(detachedInput, files) && filePastes === 2, 'Detached composer paste listeners cannot upload or mutate the new view');
      focusRow('sticker');
      keyboard(document.activeElement, { shiftKey: true });
      await settle();
      expect((await last()).text === 'sticker.png', 'Plain copying of rendered stickers uses their visible file identity, never hidden marker syntax');
      focusRow('deleted');
      expect(!keyboard(document.activeElement), 'A deleted message is never copied from stale source content');
      return checks;
    },
    async testLifecycleAndFailures() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      await prepare('en');
      const baseline = listenerCount();
      const bus = busSnapshot();
      clearSelection();
      const row = find('[data-message-id="rich"]');
      const rightClick = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 200 });
      row.dispatchEvent(rightClick);
      expect(rightClick.defaultPrevented, 'Right-click without a text selection still opens message actions');
      find('.floating-context-menu [aria-haspopup="menu"]').click();
      find('.floating-context-submenu button:last-child').click();
      await settle();
      expect((await last()).kind === 'plain' && (await last()).text === expectedPlain && !document.querySelector('.floating-context-menu'),
        'The right-click menu also offers both copy modes and closes after a choice');
      select('[data-message-id=rich] strong', 1, 3);
      const selectedRightClick = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      row.dispatchEvent(selectedRightClick);
      expect(!selectedRightClick.defaultPrevented && !document.querySelector('.floating-context-menu'),
        'Right-clicking a selected fragment retains the native selection context menu');
      for (let i = 0; i < 30; i++) {
        openMenu();
        expect(document.querySelectorAll('.floating-context-menu').length === 2, 'Each opening creates exactly one parent and one submenu');
        contextMenu.close();
      }
      await settle();
      expect(listenerCount() === baseline && busSnapshot() === bus, 'Repeated submenu open/close releases global and EventBus listeners without delayed reattachment');
      for (const event of ['network.disconnected', 'voice.channel_changed', 'session.changed']) {
        openMenu();
        appEvents.emit(event);
        expect(!document.querySelector('.floating-context-menu'), `${event} closes the complete menu tree`);
      }
      for (const event of ['resize', 'scroll']) {
        openMenu();
        window.dispatchEvent(new Event(event));
        expect(!document.querySelector('.floating-context-menu'), `${event} closes the complete menu tree`);
      }
      openMenu();
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(!document.querySelector('.floating-context-menu'), 'Outside pointerdown closes parent and submenu');
      const anchor = find('[data-message-id="rich"] [data-message-action="more"]');
      contextMenu.open(innerWidth - 1, innerHeight - 1, view.buildMessageMenuItems('rich'), anchor);
      find('.floating-context-menu [aria-haspopup="menu"]').click();
      const menus = [...document.querySelectorAll('.floating-context-menu')].map(menu => menu.getBoundingClientRect());
      expect(menus.every(rect => rect.left >= 11 && rect.top >= 11 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight - 11),
        'The nested menu flips left and stays within the viewport at the bottom-right corner');
      expect(menus[1].right <= menus[0].left + 1, 'A submenu near the right edge is placed to the left of its parent');
      contextMenu.close();

      for (let i = 0; i < 6; i++) {
        view.render();
        await settle();
        select('[data-message-id=rich] strong', 1, 3);
        const count = writes.length;
        keyboard(document.activeElement);
        await settle();
        expect(writes.length === count + 1 && listenerCount() === baseline, 'Re-rendering binds each copy shortcut exactly once without accumulating global listeners');
      }
      view.clearCopyFeedback?.();
      writeMode = 'hold';
      clearSelection();
      find('[data-message-id="rich"] [data-message-action="copy"]').click();
      expect(!document.querySelector('.chat-copy-toast'), 'Pending clipboard writes never show premature success');
      pending.shift().resolve();
      await settle();
      expect(document.querySelectorAll('.chat-copy-toast').length === 1, 'Acknowledged copying produces one toast');
      writeMode = 'resolve';
      find('[data-message-id="rich"] [data-message-action="copy"]').click();
      await settle();
      expect(document.querySelectorAll('.chat-copy-toast').length === 1, 'Repeated successful copies replace rather than stack feedback');
      for (const mode of ['formatted', 'plain']) {
        writeMode = 'reject';
        await view.copyMessage('rich', mode);
        expect(!document.querySelector('.chat-copy-toast') && find('.dialog-message').textContent === 'Could not copy the message.',
          `${mode} clipboard rejection uses localized error feedback, never a success toast or silent mode downgrade`);
        dismissAlert();
      }
      writeMode = 'hold';
      void view.copyMessage('rich');
      const older = pending.shift();
      writeMode = 'reject';
      await view.copyMessage('rich', 'plain');
      dismissAlert();
      older.resolve();
      await settle();
      expect(!document.querySelector('.chat-copy-toast'), 'An older success cannot overwrite the failure of a newer copy request');
      const nativeWrite = clipboardSink.write;
      clipboardSink.write = undefined;
      await view.copyMessage('rich');
      expect(!document.querySelector('.chat-copy-toast') && !!document.querySelector('.dialog-message'),
        'Unavailable rich clipboard support fails visibly instead of pretending plain text preserved formatting');
      dismissAlert();
      clipboardSink.write = nativeWrite;

      writeMode = 'resolve';
      select('[data-message-id=rich] strong', 1, 3);
      const failingData = new DataTransfer();
      failingData.setData = () => { throw new Error('DataTransfer denied by fixture'); };
      expect(!copyEvent(document.activeElement, failingData).prevented, 'A failing native copy serializer leaves the browser fallback available');
      expect(!document.querySelector('.chat-copy-toast') && !!document.querySelector('.dialog-message'),
        'Synchronous copy-event failures use the same failure feedback');
      dismissAlert();
      clearSelection();
      writeMode = 'hold';
      void view.copyMessage('rich');
      const changing = pending.shift();
      view.setChannel('other');
      changing.resolve();
      await settle();
      expect(!document.querySelector('.chat-copy-toast'), 'Channel switches suppress late clipboard confirmation');
      view.setChannel('chat');
      await settle();
      writeMode = 'hold';
      void view.copyMessage('rich');
      const destroying = pending.shift();
      openMenu();
      view.destroy();
      destroying.reject(new Error('Late clipboard failure'));
      await settle();
      expect(!document.querySelector('.chat-copy-toast, .floating-context-menu, .dialog-card'),
        'Destroyed views suppress late successes, failures and all open submenus');
      expect(listenerCount() === 0, 'View destruction releases every tracked global listener');
      const count = writes.length;
      select('[data-message-id=rich] strong', 1, 3);
      expect(!keyboard(document.activeElement) && !copyEvent(document.activeElement).prevented && writes.length === count,
        'Old chat DOM cannot keep handling copies after its view is destroyed');
      await prepare('pt-BR');
      writeMode = 'reject';
      await view.copyMessage('rich');
      expect(find('.dialog-message').textContent === 'Não foi possível copiar a mensagem.', 'Clipboard failure is also localized in Portuguese');
      dismissAlert();
      writeMode = 'resolve';
      return checks;
    },
    cleanup() {
      contextMenu.close();
      view?.destroy();
      clearSelection();
      dismissAlert();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('input', onInput);
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else delete navigator.clipboard;
      session.client.dispose();
      root.replaceChildren();
    },
  };
}
