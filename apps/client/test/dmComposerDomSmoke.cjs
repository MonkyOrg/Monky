const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dispatchKey } = require('./fixtures/nativeKeyboard.cjs');

const clientRoot = path.resolve(__dirname, '..');

// Direct messages render the same composer, editor menu and message copying as
// server channels. Native pointer and key input exercises the real handlers; the
// clipboard is a fixture sink and native paste is intercepted before any editor
// reads it, so the user's system clipboard is never written.
if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `dm-composer-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_DM_COMPOSER_PROFILE: profile, MONKY_HOME: path.join(profile, 'monky-home') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, Menu } = require('electron');
  app.setPath('userData', process.env.MONKY_DM_COMPOSER_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  let phase = 'startup';
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
    await vite?.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    // The packaged app has no application menu, so nothing native offers editing actions.
    Menu.setApplicationMenu(null);
    timeout = setTimeout(() => { console.error(`DM composer smoke timed out during ${phase}`); void finish(1); }, 120_000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      cacheDir: path.join(process.env.MONKY_DM_COMPOSER_PROFILE, 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'dm-composer-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__dm_composer_smoke__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"><link rel="stylesheet" href="/styles/footerControls.css"><link rel="stylesheet" href="/styles/messageEditing.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing DM composer fixture HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing DM composer fixture address');
    window = new BrowserWindow({
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) console.error(`[renderer:${phase}] ${message}`);
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/__dm_composer_smoke__`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    window.webContents.focus();
    const checks = await runSmoke(window, name => { phase = name; });
    console.log(`DM composer DOM smoke: ${checks} checks passed (native keys/pointer; system clipboard untouched)`);
    await finish(0);
  }).catch(async error => {
    console.error(`DM composer smoke failed during ${phase}`, error);
    await finish(1);
  });
}

async function runSmoke(window, setPhase) {
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const cdp = (method, params) => window.webContents.debugger.sendCommand(method, params);
  const fixture = code => evaluate(`window.dmComposerFixture.${code}`);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const center = selector => evaluate(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing native input target: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    const point = { x: Math.round(rect.left + Math.min(rect.width / 2, 40)), y: Math.round(rect.top + rect.height / 2) };
    const hit = document.elementFromPoint(point.x, point.y);
    if (!element.contains(hit)) throw new Error('Native input target is covered: ' + ${JSON.stringify(selector)} + ' by ' + (hit?.outerHTML ?? 'nothing').slice(0, 160));
    return point;
  })()`);
  const click = async (selector, button = 'left') => {
    const point = await center(selector);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point });
    await fixture('settle()');
  };
  const editor = '#chat-message-input .cm-content';

  setPhase('server composer parity');
  await evaluate(`(${installFixture.toString()})()`);
  check(await fixture('serverComposerSignature()') === await fixture('dmComposerSignature()'),
    'Direct messages render exactly the controls of a server channel composer, minus polls and message blocks');
  checks += await fixture('testComposerStructure()');

  setPhase('editor context menu');
  await click(editor);
  await click(editor, 'right');
  const menu = await fixture('menuItems()');
  check(JSON.stringify(menu.map(item => item.label)) === JSON.stringify(['Recortar', 'Copiar', 'Colar', 'Colar como texto sem formatação', 'Selecionar tudo']),
    `A native right-click in the DM composer opens the editor menu: ${JSON.stringify(menu)}`);
  check(menu[0].disabled && menu[1].disabled && !menu[2].disabled && !menu[3].disabled,
    'Cut and Copy need a selection, while Paste and Paste as plain text are available');
  await fixture('clickMenuItem("Colar")');
  check((await fixture('editorCommands.at(-1)')) === 'paste', 'Paste from the menu runs the native paste command');
  await fixture('selectComposer("texto selecionado")');
  await click(editor, 'right');
  const selected = await fixture('menuItems()');
  check(!selected[0].disabled && !selected[1].disabled, 'A composer selection enables Cut and Copy');
  await fixture('clickMenuItem("Copiar")');
  check((await fixture('editorCommands.at(-1)')) === 'copy' && await fixture('waitForToast("Copiado!")'),
    'Copy from the editor menu runs the native command and confirms it');

  setPhase('native paste');
  await fixture('resetComposer()');
  await click(editor);
  await fixture('interceptNativePaste()');
  const modifier = process.platform === 'darwin' ? 4 : 2;
  await dispatchKey(window, 'v', 'KeyV', 86, modifier);
  const nativePaste = await fixture('nativePaste');
  check(nativePaste?.inEditor === true && nativePaste.prevented === false,
    `Native Ctrl+V reaches the DM editor without any handler cancelling it: ${JSON.stringify(nativePaste)}`);
  checks += await fixture('testPaste()');

  setPhase('formatting');
  checks += await fixture('testFormatting()');

  setPhase('message menus');
  await fixture('clearSelection()');
  // The avatar is not text, so macOS does not select a word on the native right-click.
  await click('.chat-message-row[data-message-id="peer-rich"] .chat-author-avatar', 'right');
  check(JSON.stringify((await fixture('menuItems()')).map(item => item.label))
    === JSON.stringify(['Emoji', 'Responder', 'Copiar mensagem', 'Encaminhar', 'Selecionar mensagens']),
    'Right-clicking a friend message offers react, reply, copy, forward and select');
  await fixture('closeMenus()');
  await click('.chat-message-row[data-message-id="mine"] .chat-author-avatar', 'right');
  const ownMenu = (await fixture('menuItems()')).map(item => item.label);
  check(JSON.stringify(ownMenu) === JSON.stringify([
    'Emoji', 'Responder', 'Copiar mensagem', 'Encaminhar', 'Selecionar mensagens', 'Editar mensagem', 'Apagar mensagem',
  ]), `Right-clicking an own message also offers edit and delete: ${JSON.stringify(ownMenu)}`);
  await fixture('closeMenus()');
  checks += await fixture('testMessageCopy()');

  setPhase('image copy');
  await fixture('waitForImage()');
  await click('.chat-message-row[data-message-id="photo"] img.chat-attachment-image', 'right');
  const imageMenu = await fixture('menuItems()');
  check(imageMenu[0]?.label === 'Copiar imagem', `Right-clicking an image offers Copy image first: ${JSON.stringify(imageMenu)}`);
  await fixture('clickMenuItem("Copiar imagem")');
  check(await fixture('lastImageCopy()'), 'Copy image writes the attachment as a PNG');

  setPhase('edit, reply and attachments');
  checks += await fixture('testEditReplyAndDrop()');

  setPhase('incremental feed');
  checks += await fixture('testIncrementalFeed()');

  setPhase('reply jump');
  const motion = value => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  await motion('no-preference');
  checks += await fixture('testReplyJump(false)');
  await motion('reduce');
  checks += await fixture('testReplyJump(true)');
  await motion('no-preference');

  setPhase('draft across conversations');
  checks += await fixture('testDraft()');

  setPhase('lifecycle');
  checks += await fixture('testLifecycle()');
  return checks;
}

async function installFixture() {
  const [{ DmConversationView }, { dmStore }, { ChatView }, { sessionManager }, language, { contextMenu }, clipboardUtils] = await Promise.all([
    import('/views/home/DmConversationView.ts'), import('/stores/dmStore.ts'), import('/views/ChatView.ts'),
    import('/core/SessionManager.ts'), import('/i18n/index.ts'), import('/views/ContextMenu.ts'), import('/utils/messageClipboard.ts'),
  ]);
  language.setLanguage('pt-BR');
  const root = document.getElementById('app');
  root.style.cssText = 'height:100vh;width:100%;display:flex;flex-direction:column;';
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing DM composer fixture element: ${selector}`);
    return element;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  };
  const visible = element => !!element && !element.hidden && !element.hasAttribute('data-ui-closing') && element.style.display !== 'none';

  // Global listeners are counted so every view releases what it added.
  const tracked = new Map();
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const trackedTypes = new Set(['copy', 'paste', 'keydown', 'contextmenu']);
  const listenerKey = (target, type, options) =>
    `${target === document ? 'document' : 'window'}:${type}:${typeof options === 'boolean' ? options : !!options?.capture}`;
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    if ((this === document || this === window) && trackedTypes.has(type) && callback) {
      if (!tracked.has(callback)) tracked.set(callback, new Set());
      tracked.get(callback).add(listenerKey(this, type, options));
      options?.signal?.addEventListener('abort', () => {
        tracked.get(callback)?.delete(listenerKey(this, type, options));
        if (tracked.get(callback)?.size === 0) tracked.delete(callback);
      });
    }
    return originalAdd.call(this, type, callback, options);
  };
  EventTarget.prototype.removeEventListener = function (type, callback, options) {
    if (this === document || this === window) {
      tracked.get(callback)?.delete(listenerKey(this, type, options));
      if (tracked.get(callback)?.size === 0) tracked.delete(callback);
    }
    return originalRemove.call(this, type, callback, options);
  };
  const listenerCount = () => [...tracked.values()].reduce((total, keys) => total + keys.size, 0);
  const listenerSummary = () => JSON.stringify([...tracked.values()].flatMap(keys => [...keys]).sort());

  // A controlled clipboard sink: real ClipboardItem/Blob encoding, never the OS clipboard.
  const writes = [];
  let writeMode = 'resolve';
  const write = entry => {
    writes.push(entry);
    return writeMode === 'reject' ? Promise.reject(new Error('Clipboard denied by fixture')) : Promise.resolve();
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    write: items => write({ kind: 'formatted', items }),
    writeText: text => write({ kind: 'plain', text }),
  } });
  const last = async () => {
    const entry = writes.at(-1);
    if (!entry) return null;
    if (entry.kind === 'plain') return { kind: 'plain', text: entry.text };
    const item = entry.items[0];
    if (item.types.includes('image/png')) return { kind: 'image', blob: await item.getType('image/png') };
    return { kind: 'formatted', text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
  };

  // Server composer, rendered by the real ChatView for the parity comparison.
  const user = { id: 'dm-parity-user', clientId: 'dm-parity-device', nickname: 'Eu', status: 'ONLINE', joinedAt: 1 };
  sessionManager.install();
  const session = sessionManager.create('dm-composer-parity', 49218, user.nickname);
  session.serverStore.setServerDetails({
    id: 'dm-parity-server', name: 'Parity', createdAt: 1, maxUsers: 10, voiceStates: {}, allowMessageEdit: true,
    channels: [{ id: 'chat', name: 'chat', serverId: 'dm-parity-server', type: 'TEXT', position: 0, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true }],
    members: [user], knownMembers: [user], roles: [], userRoles: [], myPermissions: 2147483647, ownerId: user.id,
  }, user);
  session.client.getStatus = () => 'CONNECTED';
  session.client.getCurrentServerUrl = () => session.key;
  session.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  session.client.send = () => {};
  session.client.sendRequest = () => Promise.resolve({ selectors: [] });
  sessionManager.activate(session.key);
  const signature = (scope, serverOnly = []) => JSON.stringify([...scope.querySelectorAll(
    '.chat-composer-surface :is(button, input, monky-markdown-input, [id])')]
    .filter(element => !serverOnly.some(selector => element.closest(selector)))
    .map(element => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.dataset.format ? `[${element.dataset.format}]` : ''}`));
  const serverRoot = document.createElement('div');
  serverRoot.style.cssText = 'height:400px;display:flex;flex-direction:column;';
  document.body.appendChild(serverRoot);
  const chat = new ChatView(serverRoot);
  chat.setChannel('chat');
  await settle();
  const serverSignature = signature(serverRoot, ['#chat-create-menu', '#chat-composer-blocks']);
  const serverFormats = [...serverRoot.querySelectorAll('[data-format]')].map(button => button.dataset.format);
  chat.destroy();
  serverRoot.remove();

  // Direct-message fixture: one friend, a short history, an image and a code block.
  const me = 'f'.repeat(64);
  const peer = 'a'.repeat(64);
  const now = Date.now();
  const message = (id, author, content, extra = {}) => ({ id, peer, author, content, createdAt: now - 60_000 + writes.length,
    editedAt: null, deleted: false, replyTo: null, reactions: [], attachments: [], delivery: author === me ? 'delivered' : null, ...extra });
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  canvas.getContext('2d').fillRect(0, 0, 320, 200);
  const png = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer());
  const source = '**negrito** e *itálico* com `código`';
  const messages = [
    message('peer-rich', peer, source, { createdAt: now - 50_000 }),
    message('mine', me, 'Mensagem **minha**', { createdAt: now - 40_000 }),
    message('mine-edited', me, 'Texto *editado*', { createdAt: now - 39_000, editedAt: now - 1_000 }),
    message('mine-code', me, '```js\nconst resposta = 42;\n```', { createdAt: now - 38_000 }),
    message('photo', peer, '', { createdAt: now - 30_000, attachments: [{ fileId: 'photo-file', name: 'foto.png', size: png.length,
      mime: 'image/png', state: 'ready', receivedBytes: png.length }] }),
  ];
  const ok = value => Promise.resolve({ ok: true, value });
  const calls = { send: [], edit: [] };
  // Another friend, to open a second conversation.
  const otherPeer = 'b'.repeat(64);
  /** What the main process tells the renderer; set once the DM store subscribes. */
  let storeEvent = () => { throw new Error('The DM store did not subscribe to events'); };
  const handlers = {
    snapshot: () => ok({ me: { publicKey: me }, peers: [{ publicKey: peer, nickname: 'Amigo', avatar: null, relation: 'friend',
      blocked: false, friendSince: 1, requestedAt: null, maxFileBytes: 50 * 1024 * 1024 },
    { publicKey: otherPeer, nickname: 'Outro', avatar: null, relation: 'friend',
      blocked: false, friendSince: 1, requestedAt: null, maxFileBytes: 50 * 1024 * 1024 }],
    conversations: [{ peer, lastMessageAt: now, lastMessagePreview: '', lastMessageAuthor: me, unread: 0, hidden: false, readOnly: false }],
    settings: { maxFileBytes: 50 * 1024 * 1024 } }),
    conversation: key => ok({ peer: key, messages: key === peer ? messages : [], hasMore: false, peerReadAt: 0 }),
    readAttachment: () => ok({ data: png, mime: 'image/png' }),
    sendMessage: input => { calls.send.push(input); return ok({}); },
    editMessage: (_peer, id, content) => { calls.edit.push({ id, content }); return ok({}); },
    pendingPeers: () => ok([]),
    onEvent: callback => { storeEvent = callback; return () => {}; },
  };
  const editorCommands = [];
  window.api = {
    ...window.api,
    dm: new Proxy({}, { get: (_target, name) => handlers[name] ?? (() => ok({})) }),
    editorCommand: async command => { editorCommands.push(command); return { success: true }; },
    openExternal: async () => ({ success: true }),
  };
  await dmStore.init();
  const baseline = listenerCount();
  const dmRoot = document.createElement('div');
  dmRoot.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
  root.appendChild(dmRoot);
  let view = new DmConversationView(peer);
  view.mount(dmRoot);
  await until(() => document.querySelector('.chat-message-row[data-message-id="photo"]'), 'The DM history did not render');
  await document.fonts.ready;
  await settle();

  const input = () => find('#chat-message-input');
  const content = () => find('#chat-message-input .cm-content');
  const menu = () => document.querySelector('.floating-context-menu:not(.floating-context-submenu):not([data-ui-closing])');
  const submenu = () => document.querySelector('.floating-context-submenu:not([data-ui-closing])');
  const dialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing]) .dialog-card');
  const dismissAlert = async () => {
    dialog()?.querySelector('[data-action="confirm"]')?.click();
    await settle();
  };
  const paste = (target, data) => {
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const textData = (text, html) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    if (html) data.setData('text/html', html);
    return data;
  };
  const fileData = name => {
    const data = new DataTransfer();
    data.items.add(new File(['fixture'], name, { type: 'text/plain' }));
    return data;
  };
  const resetComposer = async (value = '') => {
    contextMenu.close();
    input().focus();
    input().value = value;
    input().setSelectionRange(value.length, value.length);
    input().dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  };
  const keydown = (target, key, options = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const focusRow = id => {
    const row = find(`.chat-message-row[data-message-id="${id}"]`);
    row.focus({ preventScroll: true });
    return row;
  };
  const selectText = (selector, from, to) => {
    const node = find(selector).firstChild;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  };
  const toast = () => document.querySelector('.chat-copy-toast:not([data-ui-closing]) .chat-copy-toast-label')?.textContent ?? null;
  const waitForToast = async text => {
    await until(() => toast() === text, `Expected the "${text}" confirmation, got ${JSON.stringify(toast())}`);
    return true;
  };
  const clickMenuItem = async label => {
    const item = [...document.querySelectorAll('.floating-context-menu:not([data-ui-closing]) button')]
      .find(button => button.querySelector('span:not([aria-hidden])')?.textContent === label);
    if (!item) throw new Error(`Missing menu item: ${label}`);
    item.click();
    await settle();
  };
  const unstageAll = async () => {
    const count = document.querySelectorAll('#chat-attachment-tray [data-dm-unstage]').length;
    // Each removal redraws the tray, so the next button is looked up again.
    for (let index = 0; index < count; index++) find('#chat-attachment-tray [data-dm-unstage]').click();
    await new Promise(resolve => setTimeout(resolve, 400));
  };

  window.dmComposerFixture = {
    editorCommands,
    nativePaste: null,
    settle,
    serverComposerSignature: () => serverSignature,
    dmComposerSignature: () => signature(dmRoot),
    async testComposerStructure() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      const surface = find('.dm-conversation .chat-composer-surface');
      expect(JSON.stringify([...surface.querySelectorAll('[data-format]')].map(button => button.dataset.format)) === JSON.stringify(serverFormats),
        'The DM formatting bar offers every server formatting action');
      expect(surface.contains(find('#chat-reply-composer')) && surface.querySelector('.chat-format-panel') === surface.firstElementChild,
        'Formatting bar and reply preview live inside the composer surface, as in servers');
      expect(input().maxLength === 4000 && find('#chat-char-counter').textContent === '0/4000',
        'The DM limit is visible in the same counter servers use');
      expect(find('#btn-attach').title === 'Anexar arquivo' && !document.querySelector('#chat-create-menu'),
        'Without polls, the + button attaches files directly');
      return checks;
    },
    menuItems() {
      const current = menu();
      if (!current) return [];
      return [...current.querySelectorAll('button')].map(button => ({
        label: button.querySelector('span:not([aria-hidden])')?.textContent ?? '', disabled: button.disabled,
      }));
    },
    clickMenuItem,
    waitForToast,
    closeMenus() { contextMenu.close(); return settle(); },
    clearSelection() { window.getSelection().removeAllRanges(); },
    toast,
    async selectComposer(text) {
      await resetComposer(text);
      input().setSelectionRange(0, text.length);
      await settle();
    },
    resetComposer: () => resetComposer(),
    interceptNativePaste() {
      window.dmComposerFixture.nativePaste = null;
      const intercept = event => {
        window.removeEventListener('paste', intercept, true);
        window.dmComposerFixture.nativePaste = {
          inEditor: input().contains(event.target), prevented: event.defaultPrevented,
        };
        // Stop here: the fixture never reads or inserts what the system clipboard holds.
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener('paste', intercept, true);
    },
    async testPaste() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      await resetComposer('Olá ');
      paste(content(), textData('mundo'));
      await settle();
      expect(input().value === 'Olá mundo' && find('#chat-char-counter').textContent === '9/4000',
        'Plain text pastes natively into the DM editor and updates the counter');
      const formatted = clipboardUtils.markdownMessageClipboard(source);
      await resetComposer();
      expect(paste(content(), textData(formatted.text, formatted.html)) && input().value === source,
        'A message copied from Monky pastes back as its Markdown, as in server channels');
      await resetComposer('abc');
      paste(content(), textData('x'.repeat(4100)));
      await settle();
      expect(input().value === 'abc' && dialog()?.querySelector('.dialog-message')?.textContent === 'A mensagem excede o limite de 4000 caracteres.',
        'A paste over the DM limit explains the limit instead of silently doing nothing');
      await dismissAlert();
      await resetComposer();
      expect(paste(content(), fileData('notas.txt')) && input().value === '', 'Pasted files are attached instead of inserted as text');
      await settle();
      expect(visible(find('#chat-attachment-tray')) && find('#chat-attachment-tray').textContent.includes('notas.txt'),
        'The attachment tray shows the pasted file');
      expect(paste(document.body, fileData('fora.txt')) && document.querySelectorAll('#chat-attachment-tray .tray-item').length === 2,
        'Ctrl+V outside the editor still attaches files');
      await unstageAll();
      expect(!visible(find('#chat-attachment-tray')), 'Removing every staged file closes the tray');
      return checks;
    },
    async testFormatting() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      await resetComposer('texto');
      find('#btn-format').click();
      await settle();
      expect(find('#btn-format').getAttribute('aria-expanded') === 'true' && find('.chat-format-panel').classList.contains('is-open'),
        'The formatting button opens the formatting bar');
      input().setSelectionRange(0, 5);
      find('[data-format="bold"]').click();
      await settle();
      expect(input().value === '**texto**', 'Bold wraps the selection');
      expect(find('[data-format="bold"]').getAttribute('aria-pressed') === 'true', 'The bar reflects the active format');
      await resetComposer('trecho');
      input().setSelectionRange(0, 6);
      find('#btn-code').click();
      await settle();
      expect(input().value === '```\ntrecho\n```' && !!document.querySelector('#chat-message-input .md-editor-code-widget'),
        'The code button opens a code block in the editor');
      expect(keydown(content(), 'Escape') && find('#btn-format').getAttribute('aria-expanded') === 'false',
        'Escape closes the formatting bar first');
      await resetComposer();
      return checks;
    },
    async testMessageCopy() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      const openCopyMenu = async id => {
        window.getSelection().removeAllRanges();
        const row = find(`.chat-message-row[data-message-id="${id}"]`);
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 });
        row.querySelector('.chat-message-text').dispatchEvent(event);
        find('.floating-context-menu:not([data-ui-closing]) [aria-haspopup="menu"] .context-menu-trailing').click();
        await settle();
      };
      const expected = clipboardUtils.markdownMessageClipboard(source);
      await openCopyMenu('peer-rich');
      expect(JSON.stringify([...submenu().querySelectorAll('button')].map(button => button.querySelector('span:not([aria-hidden])').textContent))
        === JSON.stringify(['Copiar com formatação', 'Copiar Markdown', 'Copiar sem formatação']),
      'Copy message offers the formatted, Markdown and plain variants');
      await clickMenuItem('Copiar Markdown');
      expect(await waitForToast('Copiado!') && (await last()).text === source, 'Copy Markdown copies the message source and confirms it');
      await openCopyMenu('peer-rich');
      await clickMenuItem('Copiar sem formatação');
      await waitForToast('Copiado!');
      expect((await last()).text === expected.text, 'Copy without formatting copies the visible text');
      await openCopyMenu('peer-rich');
      await clickMenuItem('Copiar com formatação');
      await waitForToast('Copiado!');
      const formatted = await last();
      expect(formatted.kind === 'formatted' && formatted.text === expected.text && formatted.html.includes('data-monky-clipboard'),
        'Copy with formatting writes rich text that pastes back as Markdown');
      find('.chat-message-row[data-message-id="mine"] [data-dm-action="copy"]').click();
      expect(await waitForToast('Copiado!') && (await last()).text === 'Mensagem minha', 'The hover copy button copies formatted text with feedback');
      expect(keydown(focusRow('peer-rich'), 'c', { ctrlKey: true }), 'Ctrl+C on a focused message is handled');
      await settle();
      expect((await last()).kind === 'formatted', 'Ctrl+C copies the whole focused message with formatting');
      keydown(focusRow('peer-rich'), 'C', { ctrlKey: true, shiftKey: true });
      await settle();
      expect((await last()).kind === 'plain' && (await last()).text === expected.text, 'Ctrl+Shift+C copies it without formatting');
      focusRow('peer-rich');
      selectText('.chat-message-row[data-message-id="peer-rich"] strong', 0, 4);
      keydown(document.activeElement, 'c', { ctrlKey: true });
      await settle();
      expect((await last()).text === 'negr', 'Ctrl+C copies only the selected fragment');
      window.getSelection().removeAllRanges();
      await openCopyMenu('mine-edited');
      await clickMenuItem('Copiar sem formatação');
      expect((await last()).text === 'Texto editado', 'The edited marker of grouped messages is not copied');
      writeMode = 'reject';
      find('.chat-message-row[data-message-id="mine"] [data-dm-action="copy"]').click();
      await until(() => dialog(), 'A failed copy did not explain itself');
      expect(dialog().querySelector('.dialog-message').textContent === 'Não foi possível copiar a mensagem.' && toast() === null,
        'A clipboard failure is reported instead of being swallowed');
      writeMode = 'resolve';
      await dismissAlert();
      find('.chat-message-row[data-message-id="mine-code"] .md-code-copy').click();
      await until(() => find('.chat-message-row[data-message-id="mine-code"] .md-code-copy-label').textContent === 'Copiado!',
        'The code block copy button did not confirm the copy');
      expect((await last()).text.trim() === 'const resposta = 42;', 'Code blocks copy their code and confirm it like in servers');
      return checks;
    },
    async waitForImage() {
      await until(() => document.querySelector('.chat-message-row[data-message-id="photo"] img.chat-attachment-image[src]'),
        'The DM image never loaded');
      await find('.chat-message-row[data-message-id="photo"] img.chat-attachment-image').decode();
      await settle();
    },
    async lastImageCopy() {
      await until(() => writes.at(-1)?.kind === 'formatted' && writes.at(-1).items[0].types.includes('image/png'), 'No image reached the clipboard');
      const copied = await last();
      const bitmap = await createImageBitmap(copied.blob);
      const size = `${bitmap.width}x${bitmap.height}`;
      bitmap.close();
      await waitForToast('Imagem copiada!');
      return size === '320x200';
    },
    async testEditReplyAndDrop() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      const send = () => find('#btn-send-message');
      await resetComposer('rascunho');
      find('.chat-message-row[data-message-id="mine"] .chat-message-text').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
      await clickMenuItem('Editar mensagem');
      expect(visible(find('#chat-edit-composer')) && find('.chat-input-container').classList.contains('chat-input-container--editing')
        && input().value === 'Mensagem **minha**', 'Editing shows the server edit banner with the message text');
      expect(send().textContent.trim().endsWith('Salvar') && find('#btn-attach').style.display === 'none'
        && input().getAttribute('aria-describedby') === 'chat-edit-hint chat-edit-error',
      'While editing, Send becomes Save and attachments step aside');
      expect(keydown(content(), 'Escape') && input().value === 'rascunho' && send().textContent.trim().endsWith('Enviar')
        && find('#chat-edit-composer').hidden, 'Escape cancels the edit and restores the unsent draft');
      find('.chat-message-row[data-message-id="mine"] [data-dm-action="edit"]').click();
      await settle();
      input().value = 'Mensagem corrigida';
      expect(keydown(content(), 'Enter'), 'Enter saves the edit');
      await until(() => calls.edit.length === 1 && input().value === 'rascunho', 'The edit was not saved');
      expect(calls.edit[0].id === 'mine' && calls.edit[0].content === 'Mensagem corrigida', 'The edited text is sent to the friend');
      find('.chat-message-row[data-message-id="peer-rich"] .chat-message-text').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
      await clickMenuItem('Responder');
      const reply = find('#chat-reply-composer');
      expect(visible(reply) && find('.chat-composer-surface').contains(reply) && reply.querySelector('.chat-quote-heading strong')?.textContent === 'Amigo',
        'Replying shows the server reply preview inside the composer');
      const quote = reply.querySelector('.chat-quote');
      dmStore.bus.emit('messages', { peer });
      expect(reply.querySelector('.chat-quote') === quote, 'Unrelated conversation updates keep the reply preview and its focus target');
      input().value = 'Resposta';
      keydown(content(), 'Enter');
      await until(() => calls.send.length === 1 && input().value === '', 'The reply was not sent');
      expect(calls.send[0].content === 'Resposta' && calls.send[0].replyTo === 'peer-rich',
        'The reply goes out with its reference and clears the composer');
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(!visible(find('#chat-reply-composer')), 'Sending closes the reply preview');
      const chat = find('.dm-conversation');
      const data = fileData('arrastado.txt');
      chat.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      expect(chat.classList.contains('chat-drag-over') && getComputedStyle(find('.dm-conversation .chat-drop-overlay')).display === 'flex',
        'Dragging files over a DM shows the same drop overlay as servers');
      chat.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      await settle();
      expect(!chat.classList.contains('chat-drag-over') && find('#chat-attachment-tray').textContent.includes('arrastado.txt'),
        'Dropping stages the files and hides the overlay');
      await unstageAll();
      return checks;
    },
    async testIncrementalFeed() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      const rows = () => new Map([...document.querySelectorAll('[data-dm-feed] .chat-message-row')]
        .map(row => [row.dataset.messageId, row]));
      const selection = () => window.getSelection().toString();
      const before = rows();
      selectText('.chat-message-row[data-message-id="peer-rich"] strong', 0, 4);
      const download = message('download', peer, 'vídeo das férias', { createdAt: now - 5_000, attachments: [{
        fileId: 'video-file', name: 'ferias.mp4', size: 10_000_000, mime: 'video/mp4', state: 'downloading', receivedBytes: 500_000 }] });
      storeEvent({ type: 'messages', peer, messages: [download], peerReadAt: 0 });
      await settle();
      const after = rows();
      expect(after.has('download') && [...before].every(([id, row]) => after.get(id) === row),
        'A new message goes in without redrawing the rows already on screen');
      expect(selection() === 'negr', `Text selected in another message stays selected: ${JSON.stringify(selection())}`);
      const downloadRow = after.get('download');
      for (let step = 1; step <= 100; step++) {
        storeEvent({ type: 'attachment-progress', peer, messageId: 'download', fileId: 'video-file', receivedBytes: 500_000 + step * 90_000 });
      }
      await settle();
      const bar = downloadRow.querySelector('.dm-attachment-progress');
      expect(rows().get('download') === downloadRow && bar?.getAttribute('aria-valuenow') === '95'
        && downloadRow.querySelector('.af-size')?.textContent.includes('95%'),
      `100 progress events move the bar inside the same row: ${bar?.getAttribute('aria-valuenow')}`);
      expect([...before].every(([id, row]) => rows().get(id) === row) && selection() === 'negr',
        'Progress leaves every other row and the selection alone');

      const own = messages.find(entry => entry.id === 'mine');
      const ownRow = rows().get('mine');
      storeEvent({ type: 'messages', peer, messages: [{ ...own, reactions: [{ emoji: '👍', users: [peer] }] }], peerReadAt: 0 });
      await settle();
      const reacted = rows().get('mine');
      expect(reacted !== ownRow && reacted.querySelector('.chat-reaction')?.textContent.includes('👍'),
        'A reaction redraws only the row it belongs to');
      expect(rows().get('peer-rich') === before.get('peer-rich') && selection() === 'negr',
        'The selection in another message survives the reaction');

      window.getSelection().removeAllRanges();
      const editedRow = focusRow('mine-edited');
      const edited = messages.find(entry => entry.id === 'mine-edited');
      storeEvent({ type: 'messages', peer, messages: [{ ...edited, content: 'Texto *editado* de novo', editedAt: now }], peerReadAt: 0 });
      await settle();
      const redrawn = rows().get('mine-edited');
      expect(redrawn !== editedRow && redrawn.textContent.includes('editado de novo') && document.activeElement === redrawn,
        'Keyboard focus follows a message whose row had to be redrawn');
      return checks;
    },
    async testReplyJump(reduced) {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      check(matchMedia('(prefers-reduced-motion: reduce)').matches === reduced, 'The test controls the motion preference');
      if (!document.querySelector('.chat-message-row[data-message-id="answer"]')) {
        storeEvent({ type: 'messages', peer, peerReadAt: 0,
          messages: [message('answer', peer, 'Concordo com isso', { createdAt: now - 1_000, replyTo: 'peer-rich' })] });
        await settle();
      }
      const feed = find('[data-dm-feed]');
      feed.scrollTop = feed.scrollHeight;
      await settle();
      const scrolls = [];
      const scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options) {
        scrolls.push({ id: this.dataset?.messageId, options });
        return scrollIntoView.call(this, options);
      };
      try {
        find('.chat-message-row[data-message-id="answer"] [data-dm-jump="peer-rich"]').click();
        await settle();
      } finally {
        Element.prototype.scrollIntoView = scrollIntoView;
      }
      const target = find('.chat-message-row[data-message-id="peer-rich"]');
      expect(scrolls.length === 1 && scrolls[0].id === 'peer-rich' && scrolls[0].options?.block === 'center'
        && scrolls[0].options?.behavior === (reduced ? 'instant' : 'smooth'),
      `The jump brings the quoted message to the center, following the motion preference: ${JSON.stringify(scrolls)}`);
      expect(document.activeElement === target, 'Focus moves to the quoted message');
      const marker = target.querySelector(':scope > .chat-message-jump-highlight');
      expect(reduced ? !marker : !!marker, reduced ? 'With reduced motion nothing flashes' : 'The quoted message is marked');
      return checks;
    },
    async testDraft() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      const tray = () => [...document.querySelectorAll('#chat-attachment-tray .tray-item')].map(item => item.title);
      const reopen = async key => {
        view.destroy();
        view = new DmConversationView(key);
        view.mount(dmRoot);
        await settle();
        await new Promise(resolve => setTimeout(resolve, 300));
      };
      await resetComposer('rascunho que não pode sumir');
      paste(content(), fileData('anexo.txt'));
      find('.chat-message-row[data-message-id="peer-rich"] [data-dm-action="reply"]').click();
      await settle();
      check(tray().includes('anexo.txt') && visible(find('#chat-reply-composer')), 'The composer holds text, a file and a reply');

      await reopen(otherPeer);
      expect(input().value === '' && tray().length === 0 && !visible(find('#chat-reply-composer')),
        'Another conversation does not get the draft');
      await reopen(peer);
      await until(() => document.querySelector('.chat-message-row[data-message-id="peer-rich"]'), 'The conversation did not come back');
      await settle();
      expect(input().value === 'rascunho que não pode sumir', `The typed text comes back: ${JSON.stringify(input().value)}`);
      expect(JSON.stringify(tray()) === JSON.stringify(['anexo.txt']) && visible(find('#chat-attachment-tray')), 'The chosen file comes back');
      expect(visible(find('#chat-reply-composer')) && find('#chat-reply-composer .chat-quote-heading strong')?.textContent === 'Amigo',
        'The message being answered comes back');

      const sends = calls.send.length;
      keydown(content(), 'Enter');
      await until(() => calls.send.length === sends + 1 && input().value === '', 'The restored draft was not sent');
      const sent = calls.send.at(-1);
      expect(sent.content === 'rascunho que não pode sumir' && sent.replyTo === 'peer-rich'
        && sent.files.length === 1 && sent.files[0].name === 'anexo.txt', 'Sending it sends all of it');
      await reopen(peer);
      expect(input().value === '' && tray().length === 0 && !visible(find('#chat-reply-composer')), 'Once sent, it is no longer a draft');
      return checks;
    },
    async testLifecycle() {
      let checks = 0;
      const expect = (condition, message) => { check(condition, message); checks++; };
      contextMenu.close();
      await dismissAlert();
      await new Promise(resolve => setTimeout(resolve, 300));
      view.destroy();
      dmRoot.remove();
      await settle();
      expect(listenerCount() === baseline,
        `Leaving the DM releases every global copy, paste and key listener (${listenerCount()} != ${baseline}): ${listenerSummary()}`);
      const count = writes.length;
      document.body.focus();
      expect(!paste(document.body, fileData('depois.txt')) && writes.length === count,
        'A closed conversation no longer reacts to paste');
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
      return checks;
    },
  };
}
