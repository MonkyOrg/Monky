const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');
const output = path.join(clientRoot, 'dist-test');
const systemClipboard = process.argv.includes('--system-clipboard');

function assertIsolatedSystemClipboard() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('System clipboard smoke requires a disposable GitHub Actions runner; the local smoke leaves the user clipboard untouched.');
  }
}

if (!process.versions.electron) {
  if (systemClipboard) assertIsolatedSystemClipboard();
  const profile = path.join(output, `message-clipboard-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_CLIPBOARD_PROFILE: profile, MONKY_HOME: path.join(profile, 'monky-home') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`, ...(systemClipboard ? ['--system-clipboard'] : [])], {
    cwd: clientRoot, env, stdio: 'inherit',
  });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, Menu, nativeImage } = require('electron');
  if (systemClipboard) assertIsolatedSystemClipboard();
  app.setPath('userData', process.env.MONKY_CLIPBOARD_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  let imageServer;
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
    if (vite) await vite.close();
    if (imageServer?.listening) await new Promise(resolve => imageServer.close(resolve));
    app.exit(code);
  };
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const authoredImage = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 255, 0, 0, 255]), {
      width: 2, height: 1, scaleFactor: 1,
    });
    imageServer = require('node:http').createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (request.url === '/too-large.png') {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 51 * 1024 * 1024 });
        response.end();
        return;
      }
      if (!['/authored.png', '/authored.jpg'].includes(request.url)) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Image fixture not found');
        return;
      }
      response.setHeader('Content-Type', request.url.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
      response.end(request.url.endsWith('.jpg') ? authoredImage.toJPEG(100) : authoredImage.toPNG());
    });
    await new Promise((resolve, reject) => {
      imageServer.once('error', reject);
      imageServer.listen(0, '127.0.0.1', resolve);
    });
    const imageAddress = imageServer.address();
    if (!imageAddress || typeof imageAddress === 'string') throw new Error('Missing image fixture address');
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
    await window.webContents.executeJavaScript(`window.clipboardImageOrigin = ${JSON.stringify(`http://127.0.0.1:${imageAddress.port}`)}`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    window.webContents.focus();
    const checks = systemClipboard ? await runSystemClipboardSmoke(window) : await runSmoke(window);
    console.log(systemClipboard
      ? `Message system clipboard smoke: ${checks} checks passed (native copy/paste into an independent rich editor and textarea)`
      : `Message clipboard DOM smoke: ${checks} checks passed (native keys/pointer, real Markdown and MIME blobs; system clipboard untouched)`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function dispatchKey(window, key, code, virtualKey, modifiers = 0, text) {
  // CDP bypasses Cocoa's key-binding resolver; native editing needs its command.
  const editingCommand = code === 'KeyZ' ? (modifiers === 12 ? 'redo' : 'undo')
    : code === 'KeyV' ? 'paste' : code === 'KeyC' && !(modifiers & 8) ? 'copy' : null;
  const commands = process.platform === 'darwin' && [4, 12].includes(modifiers) && editingCommand
    ? [editingCommand] : [];
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: virtualKey, commands,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtualKey,
  });
}

async function dispatchClick(window, point, clickCount = 1) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'left', clickCount, ...point,
  });
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', button: 'left', clickCount, ...point,
  });
}

async function runSystemClipboardSmoke(sourceWindow) {
  const { BrowserWindow, clipboard } = require('electron');
  const evaluate = code => sourceWindow.webContents.executeJavaScript(code, true);
  const fixture = code => evaluate(`window.messageClipboardFixture.${code}`);
  const modifier = process.platform === 'darwin' ? 4 : 2;
  const normalize = text => text.replace(/\r\n?/g, '\n');
  let checks = 0;
  let fixtureInstalled = false;
  const check = (value, message) => {
    if (!value) throw new Error(message);
    checks++;
  };
  const until = async (probe, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`System clipboard timed out: ${label}`);
  };
  const external = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  });
  external.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  external.webContents.on('will-navigate', event => event.preventDefault());
  const destination = code => external.webContents.executeJavaScript(code, true);
  const click = async (selector, clickCount = 1) => {
    sourceWindow.webContents.focus();
    await dispatchClick(sourceWindow, await fixture(`point(${JSON.stringify(selector)})`), clickCount);
    await fixture('settle()');
  };
  const copy = async () => {
    sourceWindow.webContents.focus();
    await dispatchKey(sourceWindow, 'c', 'KeyC', 67, modifier);
    await fixture('settle()');
  };
  const copyPlain = async () => {
    sourceWindow.webContents.focus();
    await click('[data-message-id="rich"] [data-message-action="more"]');
    await click('.floating-context-menu:not(.floating-context-submenu) [aria-haspopup="menu"]');
    await click('.floating-context-submenu [role="menuitem"]:last-child');
  };
  const paste = async target => {
    external.webContents.focus();
    await destination(`window.lastPaste = null;
      document.getElementById('rich').replaceChildren();
      document.getElementById('plain').value = '';
      document.getElementById(${JSON.stringify(target)}).focus()`);
    await dispatchKey(external, 'v', 'KeyV', 86, modifier);
    const result = await until(() => destination('window.lastPaste'), `native paste into ${target}`);
    check(result.trusted, 'The external editor receives a trusted native paste event');
    return destination(`({
      text: document.getElementById(${JSON.stringify(target)})[${JSON.stringify(target === 'plain' ? 'value' : 'innerText')}],
      bold: [...document.querySelectorAll('#rich *')].some(element =>
        element.textContent === 'bold' && Number(getComputedStyle(element).fontWeight) >= 600),
      italic: [...document.querySelectorAll('#rich *')].some(element =>
        element.textContent === 'italic' && getComputedStyle(element).fontStyle === 'italic'),
      link: document.querySelector('#rich a')?.getAttribute('href'),
      types: window.lastPaste.types
    })`);
  };
  try {
    await external.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body>
      <div id="rich" contenteditable="true" style="min-height:300px"></div><textarea id="plain"></textarea>
      <script>document.addEventListener('paste', event => {
        window.lastPaste = { trusted: event.isTrusted, types: [...event.clipboardData.types] };
      });</script></body></html>`));
    external.webContents.debugger.attach('1.3');
    await external.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await evaluate(`(${installFixture.toString()})(true)`);
    fixtureInstalled = true;
    await fixture('prepare("en")');
    const expected = await fixture('state()');
    await fixture('focusRow("rich")');
    await copy();
    await until(() => [expected.source, expected.expectedPlain].includes(normalize(clipboard.readText())),
      'owned formatted clipboard write');
    const rich = await paste('rich');
    check(rich.bold && rich.italic && rich.link === 'https://example.invalid/docs?a=1&b=2' && rich.types.includes('text/html'),
      'An independent editor receives real OS HTML and renders bold, italic and links without Monky code');
    const text = await paste('plain');
    check(normalize(text.text) === expected.source,
      `Formatted native copy preserves Markdown for external text destinations: ${JSON.stringify(text.text)}`);
    check(normalize(clipboard.readText()) === expected.source && clipboard.availableFormats().includes('text/html'),
      'The real OS clipboard carries both Markdown text and semantic HTML');

    sourceWindow.webContents.focus();
    await dispatchKey(sourceWindow, 'C', 'KeyC', 67, modifier | 8);
    await fixture('settle()');
    check(normalize(clipboard.readText()) === expected.source && clipboard.availableFormats().includes('text/html'),
      'The removed plain-copy shortcut leaves the current formatted system clipboard unchanged');
    await copyPlain();
    await until(() => normalize(clipboard.readText()) === expected.expectedPlain, 'plain-copy menu button write');
    // macOS ReadHTML can return plain text; the advertised MIME types identify actual rich content.
    check(!clipboard.availableFormats().some(type => ['text/html', 'text/rtf'].includes(type)),
      `Plain copy replaces the previous rich formats: ${JSON.stringify(clipboard.availableFormats())}`);
    const plain = await paste('plain');
    check(normalize(plain.text) === expected.expectedPlain && !plain.types.includes('text/html'),
      'The plain-copy menu button followed by external Ctrl+V pastes visible text without Markdown markers or HTML');
    const plainRich = await paste('rich');
    check(!plainRich.bold && !plainRich.italic && !plainRich.link && !plainRich.types.includes('text/html'),
      'A rich editor also pastes plain copying without retaining the previous emphasis or links');

    await fixture('preparePaste("Untouched draft")');
    sourceWindow.webContents.focus();
    await click('[data-message-id="rich"] strong', 2);
    const selected = (await fixture('state()')).selection;
    check(selected === 'bold' || selected === 'bold ', 'Native mouse selection remains local to the chosen word');
    await copy();
    await until(() => clipboard.readText() === `**bold**${selected.slice(4)}`, 'formatted selection write');
    const fragment = await paste('plain');
    check(fragment.text === `**bold**${selected.slice(4)}`,
      'Formatted external copying preserves only the native selected fragment and its Markdown emphasis');
    const richFragment = await paste('rich');
    check(richFragment.bold && richFragment.text.trim() === 'bold',
      'The same partial selection stays formatted in the independent rich editor');
    await copyPlain();
    await until(() => clipboard.readText() === selected, 'plain selection write');
    const plainFragment = await paste('plain');
    check(plainFragment.text === selected && !clipboard.availableFormats().includes('text/html'),
      'Plain external copying preserves the exact native selection without copying the whole message');
    check((await fixture('state()')).input === 'Untouched draft', 'External copying never mutates the existing composer draft');
    await fixture('prepareImages("en")');
    await click('[data-message-id="photo"] .chat-attachment-copy');
    await until(() => {
      const image = clipboard.readImage();
      const size = image.getSize();
      return !image.isEmpty() && size.width === 2 && size.height === 1;
    }, 'real image clipboard write');
    check(clipboard.readImage().getSize().width === 2, 'Image copying preserves the original bitmap dimensions in the OS clipboard');
    const pastedImage = await paste('rich');
    check(pastedImage.types.includes('Files'), 'An independent editor receives an actual image file on native paste');
    await until(() => destination('document.querySelector("#rich img")?.naturalWidth === 2'),
      'original-size image pasted into an independent editor');
    checks++;
  } finally {
    if (external.webContents.debugger.isAttached()) external.webContents.debugger.detach();
    external.destroy();
    if (fixtureInstalled) await fixture('cleanup()');
  }
  return checks;
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
    await dispatchKey(window, key, code, virtualKey, modifiers, text);
    await fixture('settle()');
  };
  const enter = () => key('Enter', 'Enter', 13, 0, '\r');
  const escape = () => key('Escape', 'Escape', 27);
  const copy = (meta = false) => key('c', 'KeyC', 67, meta ? 4 : 2);
  const click = async (selector, clickCount = 1) => {
    await dispatchClick(window, await fixture(`point(${JSON.stringify(selector)})`), clickCount);
    await fixture('settle()');
  };
  const more = '[data-message-id="rich"] [data-message-action="more"]';
  const parentCopy = '.floating-context-menu:not(.floating-context-submenu) [aria-haspopup="menu"]';
  const children = '.floating-context-submenu [role="menuitem"]';
  const copyPlain = async (messageId = 'rich') => {
    await click(`[data-message-id="${messageId}"] [data-message-action="more"]`);
    await click(parentCopy);
    await click(`${children}:last-child`);
  };

  await evaluate(`(${installFixture.toString()})()`);
  try {
    await fixture('prepare("en")');
    checks += await fixture('testHelpers()');
    await fixture('preparePaste("Existing draft")');
    await click('[data-message-id="rich"] strong', 2);
    let state = await fixture('state()');
    const mouseSelection = state.selection;
    check(mouseSelection === 'bold' || mouseSelection === 'bold ',
      `Native mouse selection chooses the rendered word, including the platform's trailing space: ${JSON.stringify(mouseSelection)}`);
    await copyPlain();
    state = await fixture('state()');
    check(state.last?.kind === 'plain' && state.last.text === mouseSelection,
      `The plain-copy button preserves native mouse selection after typing a draft: ${JSON.stringify({
        last: state.last, selection: state.selection, activeElement: state.activeElement,
      })}`);
    await fixture('select("[data-message-id=rich] strong", 1, 3)');
    await copy();
    state = await fixture('state()');
    check(state.last.kind === 'formatted' && state.last.text === '**ol**', 'Native Ctrl+C preserves Markdown for only the selected substring, not the whole message');
    check(state.last.html.includes('<strong>ol</strong>'), 'Partial selection retains the strong ancestor dropped by Range.cloneContents');
    check(state.last.types.join(',') === 'text/plain,text/html', 'Formatted copying supplies standard text/plain and text/html MIME flavors');
    check(state.toast === 'Copied!', 'A successful native copy retains localized accessible feedback');
    await copyPlain();
    state = await fixture('state()');
    check(state.last.kind === 'plain' && state.last.text === 'ol' && !state.last.html, 'The plain-copy button contains only visible plain text');
    await copy(true);
    check((await fixture('state()')).last.kind === 'formatted', 'Cmd+C follows the same formatted behavior');
    const beforeRemovedShortcuts = (await fixture('state()')).writes;
    await key('C', 'KeyC', 67, 10);
    await key('C', 'KeyC', 67, 12);
    check((await fixture('state()')).writes === beforeRemovedShortcuts,
      'Neither Ctrl+Shift+C nor Cmd+Shift+C invokes message copying');
    await fixture('select("[data-message-id=rich] .chat-message-text")');
    await copy();
    state = await fixture('state()');
    check(state.last.text.startsWith('# Heading\n\nA **bold**') && state.last.text.includes('```javascript\n' + state.code),
      `Rendered selections preserve Markdown headings, emphasis and code for external text destinations: ${JSON.stringify(state.last.text)}`);
    check(!/md-code-header|content_copy|chat-author|chat-timestamp/.test(state.last.html), 'Language headers, code buttons and message chrome never leak into the copy');
    check(state.last.text.includes('~~strike~~') && state.last.text.includes('[Monky]'),
      'Formatted text/plain retains markup for destinations that do not accept HTML');
    checks += await fixture('testRichDestination()');
    await copyPlain();
    check((await fixture('state()')).last.text === state.expectedPlain, 'Plain mode uses the same visible text for an entire rendered selection');

    await fixture('clearSelection(); window.messageClipboardFixture.focusRow("rich")');
    await copy();
    check((await fixture('state()')).last.text === state.source, 'Without a selection, Ctrl+C copies the exact Markdown of only the keyboard-focused message');
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
      check(state.submenuExpanded && state.submenuControlled && state.submenuLabels[0].includes('+C') &&
        !state.submenuLabels[1].includes('+C'),
        'The submenu exposes accessible navigation and a shortcut hint only for formatted copying');
      await click(`${children}:first-child`);
      state = await fixture('state()');
      check(state.last.text === '**ol**' && state.last.kind === 'formatted', 'Pointer navigation preserves the selected fragment captured before the submenu takes focus');
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
    check(state.last.text === '```javascript\nsample\n```' && state.last.html.includes('<pre'),
      'A formatted code selection contains only selected code with its Markdown fence and preformatted HTML');
    await fixture('clearSelection()');
    await click('[data-message-id="rich"] .md-code-copy');
    state = await fixture('state()');
    check(state.last.kind === 'plain' && state.last.text === state.code && !state.last.html, 'The existing code-block button still copies exact literal code without fences or headers');
    check(state.codeCopied, 'Code-block copy retains its own inline feedback');
    await fixture('focusRow("files")');
    await copy();
    state = await fixture('state()');
    check(state.last.text === 'report **literal**.txt\nimage.png' && !state.last.html, 'Attachment-only copying keeps literal file names, never Markdown-parsed names or media data');
    await copyPlain('files');
    check((await fixture('state()')).last.text === state.last.text, 'Both modes retain attachment-only filename copying');
    await fixture('focusRow("caption")');
    await copyPlain('caption');
    check((await fixture('state()')).last.text === 'Caption', 'A message with attachments still copies its caption instead of appending filenames');

    checks += await fixture('testScopesAndPaste()');
    checks += await fixture('testLifecycleAndFailures()');
    await fixture('prepareImages("en")');
    const imageCopySelector = '[data-message-id="photo"] .chat-attachment-copy';
    const imagePoint = await fixture(`point(${JSON.stringify(imageCopySelector)})`);
    check(await evaluate(`document.querySelector(${JSON.stringify(imageCopySelector)})
      .contains(document.elementFromPoint(${imagePoint.x}, ${imagePoint.y}))`),
    `The image copy button must have a reachable pointer target, including tiny images: ${JSON.stringify(imagePoint)}`);
    await click(imageCopySelector);
    state = await fixture('state()');
    check(state.writes === 1 && state.last?.kind === 'image' && state.last.width === 2 && state.last.height === 1,
      'A trusted pointer click copies the original tiny image through the real button handler');
    checks += await fixture('testImages()');
    checks += await fixture('testReaderLocales()');
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

async function installFixture(systemClipboard = false) {
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
  const guardNativeCopy = event => {
    if (!systemClipboard && event.isTrusted && !event.defaultPrevented) event.preventDefault();
  };
  const onInput = event => {
    if (event.isTrusted && event instanceof InputEvent && event.target?.id === 'chat-message-input') {
      historyInputType = event.inputType;
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onClick);
  document.addEventListener('copy', onCopy);
  window.addEventListener('copy', guardNativeCopy);
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
  if (!systemClipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboardSink });

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
    if (item.types.includes('image/png')) {
      const blob = await item.getType('image/png');
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return { kind: 'image', types: item.types, width: bitmap.width, height: bitmap.height,
          pixels: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
      } finally {
        bitmap.close();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
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
  const openMenu = (id = 'rich') => {
    clearSelection();
    find(`[data-message-id="${id}"] [data-message-action="more"]`).click();
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

  const prepareImages = async (locale = 'en') => {
    await prepare(locale);
    const message = { channelId: 'chat', userId: user.id, userNickname: user.nickname, createdAt: 1, isSystem: false };
    const photo = { id: 'photo-image', messageId: 'photo', kind: 'image',
      url: `${window.clipboardImageOrigin}/authored.png`, originalName: 'authored.png',
      mimeType: 'image/png', sizeBytes: 100, createdAt: 1 };
    session.chatStore.setHistory('chat', [
      { ...message, id: 'photo', content: '**Photo caption**', attachments: [photo] },
      { ...message, id: 'jpeg', content: '', attachments: [{
        ...photo, id: 'jpeg-image', messageId: 'jpeg', url: `${window.clipboardImageOrigin}/authored.jpg`,
        originalName: 'authored.jpg', mimeType: 'image/jpeg',
      }] },
      { ...message, id: 'image-sticker', content: stickerToken('sticker-copy'),
        attachments: [{ ...photo, id: 'sticker-copy', messageId: 'image-sticker' }] },
    ]);
    view.render();
    await Promise.all([...root.querySelectorAll('img.chat-attachment-image, img.chat-sticker')].map(image => image.decode()));
    await settle();
  };

  window.messageClipboardFixture = {
    prepare, prepareImages, settle, select, clearSelection, focusRow, preparePaste,
    async testReaderLocales() {
      let count = 0;
      const check = (condition, message) => { if (!condition) throw new Error(message); count++; };
      const bot = {
        id: 'localized-bot', channelId: 'chat', userId: 'fixture-bot', userNickname: 'Fixture bot',
        createdAt: 1, isBot: true, content: 'Default text',
        localizations: { 'pt-BR': 'Música **adicionada** à fila.', en: 'Track **added** to the queue.' },
      };
      await prepare('en');
      session.chatStore.setHistory('chat', [bot, {
        id: 'reader-reply', channelId: 'chat', userId: user.id, userNickname: user.nickname,
        createdAt: 2, content: 'User text is not translated',
        reply: session.chatStore.messageReply(bot),
      }]);
      for (const locale of ['en', 'pt-BR', 'en']) {
        language.setLanguage(locale);
        view.render();
        await settle();
        const expected = locale === 'en' ? 'Track added to the queue.' : 'Música adicionada à fila.';
        const row = root.querySelector('[data-message-id="localized-bot"]');
        check(row.querySelector('.chat-message-text').textContent.includes(expected),
          `${locale}: the reader, not the invoker, selects the bot message`);
        check(root.querySelector('[data-message-id="reader-reply"] .chat-reply-reference').textContent.includes(bot.localizations[locale]),
          `${locale}: replies show the same localized source text`);
        check(root.querySelector('[data-message-id="reader-reply"] .chat-message-text').textContent.includes('User text is not translated'),
          `${locale}: human-authored text remains unchanged`);
        const copied = view.messageClipboard(bot.id);
        check(copied.text === expected && copied.markdown === bot.localizations[locale],
          `${locale}: copying preserves both plain and formatted text in the reader language`);
        check(session.chatStore.getMessages('chat')[0].content === 'Default text', 'Rendering never destroys the fallback or other variants');
      }
      session.chatStore.updateMessage({ ...bot, content: '', localizations: undefined, deletedAt: 3 });
      await settle();
      check(!root.textContent.includes('Track added to the queue.'), 'Deleting a localized original clears its reply previews');
      check(view.messageClipboard(bot.id) === null, 'Deleted bot translations cannot be copied');
      return count;
    },
    async testImages() {
      const { writeImageClipboard } = await import('/utils/imageClipboard.ts');
      const { lightboxModal } = await import('/views/LightboxModal.ts');
      let count = 0;
      const expect = (value, message) => { check(value, message); count++; };
      const expectImage = async (exact = true) => {
        await settle();
        const result = await last();
        await settle();
        expect(result?.kind === 'image' && result.types.join(',') === 'image/png',
          `Image copying provides a real image/png ClipboardItem, never file names, HTML or URLs: ${JSON.stringify(result)}`);
        expect(result.width === 2 && result.height === 1, 'The PNG has original image dimensions, not thumbnail dimensions');
        if (exact) expect(JSON.stringify(result.pixels) === JSON.stringify([255, 0, 0, 255, 0, 0, 255, 255]),
          'The decoded clipboard PNG preserves the authored red and blue pixels');
      };
      for (const locale of ['en', 'pt-BR']) {
        await prepareImages(locale);
        const label = locale === 'en' ? 'Copy image' : 'Copiar imagem';
        const copied = locale === 'en' ? 'Image copied!' : 'Imagem copiada!';
        const button = find('[data-message-id="photo"] .chat-attachment-copy');
        expect(button.title === label && button.getAttribute('aria-label') === label, 'Image controls follow the app language');
        button.click();
        await expectImage();
        expect(find('.chat-copy-toast-label').textContent === copied, 'Image copy success is localized and shown after encoding');
        find('[data-message-id="jpeg"] .chat-attachment-copy').click();
        await expectImage(false);
        await view.copyMessage('photo', 'plain');
        expect((await last()).text === 'Photo caption', 'Copy message keeps its text semantics after adding a separate image action');

        for (const selector of ['[data-message-id="photo"] .chat-attachment-image', '[data-message-id="image-sticker"] .chat-sticker']) {
          clearSelection();
          find(selector).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
          const item = find('.floating-context-menu [role="menuitem"]');
          expect(item.textContent.includes(label), 'Image and sticker context menus expose Copy image');
          item.click();
          await expectImage();
          expect(!document.querySelector('.floating-context-menu'), 'Copying dismisses the image context menu');
        }

        const baseline = listenerCount();
        for (let index = 0; index < 3; index++) {
          find('[data-message-id="photo"] .chat-attachment-lightbox-trigger').click();
          expect(find('.lightbox-copy').title === label && !find('.lightbox-copy').hidden,
            'The expanded image viewer exposes a localized copy button');
          find('.lightbox-copy').click();
          await expectImage();
          find('.lightbox-close').click();
          expect(listenerCount() === baseline, 'Closing the viewer releases its copy shortcut and existing global listeners');
        }
        find('[data-message-id="photo"] .chat-attachment-lightbox-trigger').click();
        clearSelection();
        find('.lightbox-copy').focus();
        const key = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
        find('.lightbox-copy').dispatchEvent(key);
        expect(key.defaultPrevented, 'Ctrl+C in the image viewer uses image copying');
        await expectImage();
        lightboxModal.close();
      }

      await prepareImages('en');
      writeMode = 'reject';
      await view.copyAttachmentImage(find('[data-message-id="photo"] .chat-attachment-image'));
      expect(!document.querySelector('.chat-copy-toast') && find('.dialog-message').textContent.startsWith('Could not copy the image.'),
        'Clipboard rejection is explicit, without a link fallback or success toast');
      dismissAlert();
      writeMode = 'resolve';
      for (const url of ['file:///not-an-allowed-source.png', `${window.clipboardImageOrigin}/missing.png`,
        `${window.clipboardImageOrigin}/too-large.png`]) {
        let failed = false;
        try { await writeImageClipboard(url, new AbortController().signal); } catch { failed = true; }
        expect(failed, 'Unsupported schemes, missing images and oversized transfers are rejected');
      }
      const aborted = new AbortController();
      aborted.abort();
      const before = writes.length;
      try { await writeImageClipboard(`${window.clipboardImageOrigin}/authored.png`, aborted.signal); } catch {}
      expect(writes.length === before, 'An already cancelled image copy never requests clipboard access');
      writeMode = 'hold';
      const copying = view.copyAttachmentImage(find('[data-message-id="photo"] .chat-attachment-image'));
      await settle();
      expect(pending.length === 1, 'An in-flight image write is exercised before teardown');
      view.destroy();
      pending.shift().resolve();
      await copying;
      expect(!document.querySelector('.chat-copy-toast'), 'Destroying the chat cancels pending image feedback and I/O');
      writeMode = 'resolve';
      return count;
    },
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
        selection: window.getSelection()?.toString(), activeElement: document.activeElement?.id || document.activeElement?.tagName,
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
      expect(full.markdown === source && clipboard.readMonkyClipboardMarkdown(makeData(full.markdown, full.html)) === source,
        'Markdown text/plain round-trips without relying on the destination understanding Monky metadata');
      const nativePlain = makeData('old rich clipboard', full.html);
      clipboard.setMessageClipboardData(nativePlain, full, 'plain');
      expect(nativePlain.getData('text/plain') === expectedPlain && nativePlain.types.join(',') === 'text/plain',
        'Plain native copy clears any previous HTML and exports only visible text');
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
      for (const options of [
        { ctrlKey: false }, { altKey: true }, { shiftKey: true }, { ctrlKey: false, metaKey: true, shiftKey: true },
        { isComposing: true }, { key: 'v' }, { key: 'x' },
      ]) {
        expect(!keyboard(document.activeElement, options), 'Unrelated modifiers, removed shortcuts, IME, paste and cut remain native');
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
      expect(copied.prevented && copied.text === '**ol**' && copied.html.includes('<strong>ol</strong>'),
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
      expect(!keyboard(document.activeElement, { shiftKey: true }), 'The removed plain-copy shortcut does not intercept author-name selections');
      await settle();
      expect(writes.length === before, 'Author-name selections do not trigger a custom clipboard write or copy the message body');
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
      openMenu('sticker');
      find('.floating-context-submenu button:last-child').click();
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
      window.removeEventListener('copy', guardNativeCopy);
      document.removeEventListener('input', onInput);
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
      if (!systemClipboard) {
        if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
        else delete navigator.clipboard;
      }
      session.client.dispose();
      root.replaceChildren();
    },
  };
}
