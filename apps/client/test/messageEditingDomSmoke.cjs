const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');
const output = path.join(clientRoot, 'dist-test');

if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true });
  const profile = path.join(output, `message-editing-profile-${process.pid}`);
  const env = { ...process.env, MONKY_EDITING_PROFILE: profile, MONKY_HOME: path.join(profile, 'monky-home') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2), `--user-data-dir=${profile}`], {
    cwd: clientRoot, env, stdio: 'inherit',
  });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_EDITING_PROFILE);
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
      cacheDir: path.join(process.env.MONKY_EDITING_PROFILE, 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'message-editing-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__message_editing_smoke__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"><link rel="stylesheet" href="/styles/footerControls.css"><link rel="stylesheet" href="/styles/messageEditing.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const server = vite.httpServer;
    if (!server) throw new Error('Missing fixture HTTP server');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    window = new BrowserWindow({
      show: false, width: 1050, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) console.error(`[renderer] ${message}`);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Message editing smoke timed out'); void finish(1); }, 90_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__message_editing_smoke__`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    window.webContents.focus();
    const checks = await runNativeSmoke(window);
    console.log(`Message editing native DOM smoke: ${checks} checks passed`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function captureScreenshot(window, filename) {
  const expected = await window.webContents.executeJavaScript(
    '({ width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio) })');
  const image = await new Promise((resolve, reject) => {
    const painted = (_event, _rect, frame) => {
      const size = frame.getSize();
      if (size.width !== expected.width || size.height !== expected.height) return;
      clearTimeout(timeout);
      window.webContents.removeListener('paint', painted);
      if (frame.isEmpty()) reject(new Error(`Empty offscreen frame: ${filename}`));
      else resolve(frame);
    };
    const timeout = setTimeout(() => {
      window.webContents.removeListener('paint', painted);
      reject(new Error(`Offscreen frame was not presented: ${filename}`));
    }, 5000);
    window.webContents.on('paint', painted);
    window.webContents.invalidate();
  });
  fs.writeFileSync(path.join(output, filename), image.toPNG());
}

async function runNativeSmoke(window) {
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  const fixture = source => evaluate(`window.messageEditingFixture.${source}`);
  const state = () => fixture('state()');
  const resize = async (width, height) => {
    window.setContentSize(width, height);
    await evaluate(`new Promise((resolve, reject) => {
      const resized = () => {
        if (innerWidth !== ${width} || innerHeight !== ${height}) return;
        clearTimeout(timeout); removeEventListener('resize', resized); resolve();
      };
      const timeout = setTimeout(() => {
        removeEventListener('resize', resized); reject(new Error('The requested viewport was not applied'));
      }, 5000);
      addEventListener('resize', resized); resized();
    })`);
    await fixture('settle()');
  };
  let checks = 0;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks++;
  };
  const key = async (key, code, virtualKey, text, modifiers = 0) => {
    // CDP bypasses Cocoa's native editing-command resolver.
    const commands = process.platform === 'darwin' && modifiers === 4 && code === 'KeyZ' ? ['undo'] : [];
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, modifiers, commands, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
    });
  };
  const enter = (shift = false) => key('Enter', 'Enter', 13, '\r', shift ? 8 : 0);
  const escape = () => key('Escape', 'Escape', 27);
  const insert = text => window.webContents.debugger.sendCommand('Input.insertText', { text });
  const replace = async text => {
    await fixture('selectText()');
    await insert(text);
  };
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
  };
  let editAttempt = 0;
  const edit = async (keyboard = false) => {
    editAttempt++;
    if (keyboard) {
      await fixture('focusMore()');
      await enter();
    } else await click('[data-message-id="original"] [data-message-action="more"]');
    const index = await fixture('editMenuIndex()');
    for (let i = 0; i < index; i++) await key('ArrowDown', 'ArrowDown', 40);
    await enter();
    const current = await state();
    check(current.editing && current.focus === 'chat-message-input',
      `Edit menu loads and focuses the normal composer: ${JSON.stringify(current)}`);
    check(current.inlineEditors === 0 && current.textareas === 1, 'Editing never adds a separate message editor');
  };

  await evaluate(`(${installFixture.toString()})()`);
  const localeMap = process.argv.find(argument => argument.startsWith('--locale-map='))?.slice('--locale-map='.length);
  if (localeMap) {
    const translations = JSON.parse(fs.readFileSync(localeMap, 'utf8'));
    await evaluate(`Promise.all([import('/i18n/locales/pt-BR.ts'), import('/i18n/locales/en.ts')]).then(([pt, en]) => {
      const translations = ${JSON.stringify(translations)};
      Object.assign(pt.ptBR, translations['pt-BR']); Object.assign(en.en, translations.en);
    })`);
    console.log('Validating staged composer locale map; run without --locale-map after integration.');
  }
  try {
    for (const locale of ['pt-BR', 'en']) {
      await fixture(`prepare(${JSON.stringify(locale)})`);
      const draft = '\nDraft waiting to be sent\nSecond draft line';
      await insert(draft);
      await edit(true);
      let current = await state();
      check(current.value === '\nOriginal line\nSecond line', 'Original multiline text, including its leading newline, is loaded exactly');
      check(current.draft === draft && current.replyHidden, 'The existing text and reply draft are kept outside edit mode');
      check(current.saveLabel === (locale === 'en' ? 'Save' : 'Salvar'), 'Save is translated');
      check(current.cancelLabel === (locale === 'en' ? 'Cancel' : 'Cancelar'), 'Cancel is translated');
      check(current.editLabel === (locale === 'en' ? 'Editing message' : 'Editando mensagem'), 'Edit mode is visibly localized');
      check(current.description.includes('chat-edit-hint') && current.hint.includes('Shift+Enter'), 'The textarea exposes accessible multiline keyboard guidance');
      check(current.originalVisible && current.message === '\nOriginal line\nSecond line', 'The original row stays visible and unchanged before acknowledgement');
      check(current.attachHidden && current.codeHidden, 'Actions which publish separate messages are unavailable during text editing');
      await replace('Edited first line');
      await enter(true);
      await insert('Edited second line');
      current = await state();
      check(current.value === 'Edited first line\nEdited second line' && current.edits.length === 0, 'Native Shift+Enter inserts a newline without saving');
      await captureScreenshot(window, `message-editing-${locale}.png`);
      await enter();
      await enter();
      current = await state();
      check(current.pending && current.saveDisabled && current.cancelDisabled, 'Save is acknowledged asynchronously and cannot be duplicated or misleadingly cancelled');
      check(current.edits.length === 1 && current.edits[0].messageId === 'original' &&
        current.edits[0].channelId === 'chat' && current.edits[0].content === 'Edited first line\nEdited second line',
      'Only the selected message and original channel are sent in CHAT_EDIT');
      check(current.sent.length === 0 && current.commands.length === 0, 'Saving never publishes a new message or command');
      await fixture('focusOtherControl()');
      await fixture('replyEdit("a")');
      await fixture('settle()');
      current = await state();
      check(!current.editing && current.value === draft && current.draft === draft, 'A successful save restores the exact previous draft');
      check(current.message === 'Edited first line\nEdited second line' && current.replyId === 'reply-source' && !current.replyHidden,
        'Only the original message is updated and the pending reply is restored');
      check(current.focus === 'fixture-other-control', 'An asynchronous save never steals focus from a different control or dialog');
      await fixture('removeOtherControl()');
      await fixture('focusInput()');
      await enter();
      current = await state();
      check(current.sent.length === 1 && current.sent[0].content === draft.trim() && current.sent[0].replyToMessageId === 'reply-source',
        'Normal sending and replies still work after saving');

      await insert('Draft preserved on cancel');
      await edit();
      await replace('This edit is cancelled');
      await key('Tab', 'Tab', 9, '\t');
      check((await state()).focus === 'btn-send-message', 'Native Tab reaches Save from the textarea');
      await key('Tab', 'Tab', 9, '\t', 8);
      await key('Tab', 'Tab', 9, '\t', 8);
      await key('Tab', 'Tab', 9, '\t', 8);
      check((await state()).focus === 'btn-cancel-message-edit', 'Cancel is reachable through the native keyboard tab order');
      await enter();
      current = await state();
      check(!current.editing && current.value === 'Draft preserved on cancel' && current.edits.length === 1, 'Keyboard Cancel restores the draft without changing the message');
      await edit();
      await replace('Escape cancels too');
      await escape();
      check(!(await state()).editing && (await state()).value === 'Draft preserved on cancel', 'Native Escape cancels editing');
    }

    await fixture('prepare("en")');
    await insert('Original unsent draft');
    await edit();
    await replace('/ping this is literal\nmessage text');
    let current = await state();
    check(!current.commandOpen && !current.commandSelected, 'Slash text has no command autocomplete while editing');
    await enter();
    current = await state();
    check(current.edits[0]?.content === '/ping this is literal\nmessage text' && current.commands.length === 0, 'Native Enter saves slash-prefixed text, without executing it');
    await fixture('replyEdit("a", "failure")');
    await fixture('settle()');
    current = await state();
    check(current.editing && !current.pending && current.value === '/ping this is literal\nmessage text' && current.draft === 'Original unsent draft',
      'A server rejection keeps both texts available for retry');
    check(current.error.includes('Could not save'), 'The failure is announced inline, not silently discarded');
    await enter();
    await fixture('replyEdit("a")');
    await fixture('settle()');
    check(!(await state()).editing && (await state()).value === 'Original unsent draft', 'Retry succeeds and restores the draft');
    await fixture('prepare("en")');
    await insert('Reply and upload draft');
    await fixture('stageUploadingAttachment()');
    await edit();
    check((await state()).trayHidden && !(await state()).saveDisabled, 'A new-message upload is kept aside and does not block saving an edit');
    await click('#btn-emoji');
    check(await evaluate('!!document.querySelector(".emoji-picker") && !document.querySelector("[data-picker-tab=stickers]")'),
      'Editing keeps emoji insertion without offering sticker sends');
    await escape();
    await fixture('focusInput()');
    await replace('');
    await enter();
    current = await state();
    check(current.editing && current.edits.length === 0 && current.error.includes('Write a message'), 'Empty text is rejected without silently deleting the message or draft');
    await replace('Do not replace me');
    await fixture('trySecondEdit()');
    current = await state();
    check(current.value === 'Do not replace me' && current.error.includes('Finish or cancel'), 'Selecting another message never discards the unfinished edit');
    await fixture('replaceHistory()');
    current = await state();
    check(current.value === 'Do not replace me' && current.editing, 'Loading a different history window does not reset the composer');
    await fixture('deleteOriginal()');
    current = await state();
    check(current.value === 'Do not replace me' && current.saveDisabled && current.error.includes('deleted'), 'Deletion preserves edit text and disables Save with recovery guidance');
    await enter();
    check((await state()).edits.length === 0, 'Enter cannot save a deleted message');
    await escape();
    current = await state();
    check(current.value === 'Reply and upload draft' && !current.trayHidden && current.saveDisabled,
      'Cancel restores the original draft and its still-uploading attachment');

    await fixture('prepare("en")');
    await insert('Draft before deleting a pending edit');
    await edit();
    await replace('Pending text stays recoverable');
    await enter();
    await fixture('deleteOriginal()');
    await fixture('replyEdit("a", "stale-success")');
    await fixture('settle()');
    current = await state();
    check(current.editing && !current.pending && current.saveDisabled && current.value === 'Pending text stays recoverable',
      'Deletion wins over a late successful save acknowledgement without losing editing text');
    check(current.message === '' && current.error.includes('deleted'), 'A stale save response cannot resurrect the deleted row');
    await escape();
    check((await state()).value === 'Draft before deleting a pending edit', 'Cancelling the deleted pending edit restores the original draft');

    await fixture('prepare("en")');
    await insert('Attachment caption draft');
    await fixture('attachOriginal()');
    await edit();
    await replace('');
    await enter();
    current = await state();
    check(current.edits.length === 1 && current.edits[0].content === '', 'An attachment caption may be cleared without deleting its attachment');
    await fixture('replyEdit("a")');
    await fixture('settle()');
    check(!(await state()).editing && (await state()).value === 'Attachment caption draft', 'Saving an empty attachment caption restores the prior draft');

    await fixture('prepare("en")');
    await insert('Permissions draft');
    await fixture('attemptForbiddenEdits()');
    check(!(await state()).editing, 'Other users, system, private and deleted messages cannot enter edit mode');
    await edit();
    await replace('Retained when editing is disabled');
    await fixture('setEditPermission(false)');
    current = await state();
    check(current.editing && current.saveDisabled && !current.readOnly && current.error.includes('no longer allowed'),
      'A permissions change blocks Save but keeps the text selectable and recoverable');
    await enter();
    check((await state()).edits.length === 0, 'Enter rechecks the current server edit setting');
    await fixture('setEditPermission(true)');
    await fixture('removeSendPermission()');
    check(!(await state()).saveDisabled, 'Author editing retains its existing independent permission policy even without SEND_MESSAGES');
    await enter();
    await fixture('replyEdit("a")');
    await fixture('settle()');
    check(!(await state()).editing && (await state()).readOnly, 'The restored normal composer obeys SEND_MESSAGES again');

    await fixture('prepare("en")');
    await insert('Channel A draft');
    await edit();
    await replace('Channel A unfinished edit');
    await fixture('setChannel("other")');
    check(!(await state()).editing && (await state()).value === 'Other channel draft', 'Changing channels never copies edited text into the new channel');
    await insert(' plus native text');
    await fixture('setChannel("chat")');
    check((await state()).value === 'Channel A unfinished edit' && (await state()).draft === 'Channel A draft',
      'Returning resumes the correct edit and still retains the original draft');
    await enter();
    await fixture('setChannel("other")');
    await fixture('replyEdit("a")');
    await fixture('settle()');
    check((await state()).value === 'Other channel draft plus native text' && !(await state()).editing,
      'An acknowledgement from the previous channel cannot overwrite the current composer');
    await fixture('setChannel("chat")');
    check((await state()).value === 'Channel A draft' && !(await state()).editing, 'A background channel save restores only its own draft');

    await fixture('prepare("en")');
    await insert('Server A draft');
    await edit();
    await replace('Server A edit');
    await enter();
    await fixture('activate("b")');
    await insert('Server B draft');
    await edit();
    await replace('Server B unfinished edit');
    await fixture('replyEdit("a")');
    await fixture('settle()');
    current = await state();
    check(current.value === 'Server B unfinished edit' && current.draft === 'Server B draft' && current.editing && current.edits.length === 0,
      'A late ACK in another session does not mutate the foreground edit with the same channel/message IDs');
    await fixture('dispatchDetachedInput()');
    check((await state()).value === 'Server B unfinished edit' && (await state()).draft === 'Server B draft',
      'A detached input event cannot write through the foreground proxy');
    await escape();
    await fixture('activate("a")');
    check((await state()).value === 'Server A draft' && !(await state()).editing, 'The captured background session completed its own edit');

    await fixture('prepare("en")');
    await insert('Offline draft');
    await edit();
    await replace('Keep this disconnected edit');
    await enter();
    await fixture('disconnectTemporarily()');
    await fixture('settle()');
    current = await state();
    check(current.value === 'Keep this disconnected edit' && current.draft === 'Offline draft' && current.saveDisabled && !current.pending,
      'Connection failure preserves both texts and unlocks the editor for recovery');
    await enter();
    check((await state()).edits.length === 1, 'Offline Enter cannot send an edit');
    await fixture('reconnect()');
    await enter();
    await fixture('replyEdit("a")');
    await fixture('settle()');
    check(!(await state()).editing && (await state()).value === 'Offline draft', 'Explicit retry after reconnect uses the new connection safely');

    await edit();
    await replace('Recovered after session removal');
    await fixture('hardDisconnectAndRecreate()');
    current = await state();
    check(current.editing && current.value === 'Recovered after session removal' && current.draft === 'Offline draft',
      'A terminal disconnect and new session recover both texts for the same authenticated endpoint');
    await fixture('rerender()');
    check((await state()).value === 'Recovered after session removal', 'Destroy/re-render preserves the edit, not only the ordinary draft');
    await escape();
    await edit();
    await enter();
    check(!(await state()).editing && (await state()).value === 'Offline draft', 'Saving unchanged content exits editing without a network request');

    const trusted = await fixture('trustedEvents()');
    check(trusted.inputs > 20 && trusted.enters > 15 && trusted.newlines >= 2 && trusted.escapes >= 4,
      'The smoke exercised actual Chromium input, Enter, Shift+Enter and Escape events, not synthetic-only dispatch');
    console.log(`Composer editing behavior: ${checks} native checks passed`);
    await replace('/ping');
    await key(' ', 'Space', 32, ' ');
    current = await state();
    check(current.commandSelected && current.commands.length === 0, 'Native Space still selects a command without prematurely executing it');
    await edit();
    await replace('/ping never execute an edit');
    check(!(await state()).commandSelected && !(await state()).commandOpen, 'An existing command composer is suspended while editing, including slash text');
    await escape();
    check((await state()).commandSelected, 'Cancelling restores the suspended command without replacing its draft');
    await enter();
    await fixture('settle()');
    check((await state()).commands.length === 1, 'Normal native Enter command execution still works after message editing');
    await fixture('prepare("en")');
    checks += await fixture('compositionChecks()');
    await fixture('referenceLayout(true)');
    let layout = await fixture('referenceState()');
    check(layout.placeholderOffset < 1 && layout.inputHeight <= 38, 'The empty placeholder line is centered with the footer buttons');
    await fixture('referenceLayout()');
    layout = await fixture('referenceState()');
    check(layout.quoteHasTime && layout.highlighted && layout.numbers === '1\n2\n3\n4',
      'Reference composer includes a compact dated quote, syntax highlighting and an isolated line-number gutter');
    check(layout.codeHeight < 120 && layout.unified, 'Code is compact and shares the composer surface rather than a separate toolbar/card stack');
    await click('.chat-code-header select');
    await insert('ps1');
    check(await fixture('languageOptions()') === 'PowerShell', 'Native search filters language aliases as well as display names');
    await enter();
    check((await fixture('referenceState()')).language === 'powershell', 'Enter selects the filtered language');
    await click('.chat-code-header select');
    await insert('no-such-language');
    check(await fixture('languageOptions()') === '' && await evaluate(`document.querySelector('.monky-select-empty')?.textContent === 'No languages found'`),
      'A search with no matches is explicit and does not change the selection');
    await escape();
    await click('.chat-code-header select');
    await insert('java');
    check(await fixture('languageOptions()') === 'Java|JavaScript', 'The searchable selector shows only matching languages');
    await key('ArrowDown', 'ArrowDown', 40);
    await enter();
    check((await fixture('referenceState()')).language === 'javascript', 'Native arrows select among filtered results');
    await click('.chat-code-header select');
    await insert('power');
    await enter();
    await fixture('focusCode()');
    const beforeIndent = (await fixture('referenceState()')).code;
    await key('Tab', 'Tab', 9);
    check((await fixture('referenceState()')).code !== beforeIndent, 'Inline code Tab uses the shared indentation behavior');
    await key('z', 'KeyZ', 90, undefined, process.platform === 'darwin' ? 4 : 2);
    check((await fixture('referenceState()')).code === beforeIndent, 'Native Undo reverses inline code indentation');
    await escape();
    check(await evaluate(`document.activeElement === document.querySelector('.chat-code-header select')`),
      'Escape leaves code editing without a keyboard focus trap');
    await fixture('settle()');
    await captureScreenshot(window, 'chat-composer-reference.png');
    await resize(460, 780);
    layout = await fixture('referenceState()');
    check(layout.width === 460 && !layout.overflow, 'The quote, language selector and footer fit a narrow chat without page overflow');
    await captureScreenshot(window, 'chat-composer-reference-narrow.png');
    await resize(1050, 800);
    checks += await fixture('deliveryChecks()');
    await fixture('settle()');
    await captureScreenshot(window, 'chat-delivery-reference.png');
    checks += await fixture('mediaDeliveryChecks()');
    return checks;
  } catch (error) {
    console.error(`Native edit attempt ${editAttempt}: ${JSON.stringify(await state())}`);
    try { await captureScreenshot(window, 'message-editing-failure.png'); }
    catch (captureError) { console.warn('Could not capture the failing fixture', captureError); }
    throw error;
  } finally {
    await fixture('cleanup()');
  }
}

async function installFixture() {
  const [{ ChatView }, { sessionManager }, chats, { appEvents }, routing, language, { selectEnhancer }] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/stores/chatStore.ts'),
    import('/core/EventBus.ts'), import('/core/sessionRouting.ts'), import('/i18n/index.ts'),
    import('/core/SelectEnhancer.ts'),
  ]);
  const root = document.getElementById('app');
  root.style.cssText = 'height:100vh;width:100%;display:flex;flex-direction:column;';
  const user = { id: 'author', clientId: 'author-device', nickname: 'Author', status: 'ONLINE', joinedAt: 1 };
  const original = { id: 'original', channelId: 'chat', userId: user.id, userNickname: user.nickname,
    content: '\nOriginal line\nSecond line', createdAt: 100, isSystem: false };
  const reply = { ...original, id: 'reply-source', content: 'Reply target', createdAt: 90 };
  const command = { botId: 'utility-bot', botName: 'Utility Bot', name: 'ping', description: 'Fixture command' };
  const states = new Map();
  let active;
  let view;
  let detachedInput;
  const trusted = { inputs: 0, enters: 0, newlines: 0, escapes: 0 };
  const inputListener = event => { if (event.isTrusted) trusted.inputs++; };
  const keyListener = event => {
    if (!event.isTrusted) return;
    if (event.key === 'Enter') { trusted.enters++; if (event.shiftKey) trusted.newlines++; }
    if (event.key === 'Escape') trusted.escapes++;
  };
  document.addEventListener('input', inputListener);
  document.addEventListener('keydown', keyListener);
  sessionManager.install();
  selectEnhancer.init();
  const offUpdate = appEvents.on('message.CHAT_MESSAGE_UPDATED', payload => chats.chatStore.updateMessage(payload.message));
  const offMessage = appEvents.on('message.CHAT_MESSAGE', message => {
    if (chats.chatStore.getOutgoing(message.id)) chats.chatStore.addMessage(message);
  });
  const details = name => ({
    id: `editing-${name}`, name: `Editing ${name}`, createdAt: 1, maxUsers: 10, voiceStates: {}, allowMessageEdit: true,
    channels: ['chat', 'other'].map((id, position) => ({
      id, name: id, serverId: `editing-${name}`, type: 'TEXT', position, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
    })),
    members: [user], knownMembers: [user], roles: [], userRoles: [], myPermissions: 2147483647, ownerId: user.id,
  });
  const create = name => {
    const session = sessionManager.create(`message-editing-${name}`, 49102, user.nickname);
    const state = { name, session, status: 'CONNECTED', epoch: 1, edits: [], sent: [], commands: [], deliveryRequests: [] };
    session.serverStore.setServerDetails(details(name), user);
    session.client.getStatus = () => state.status;
    session.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
    session.client.getConnectionId = () => `${name}-${state.epoch}`;
    session.client.getCurrentServerUrl = () => session.key;
    session.client.send = (type, payload, requestId) => {
      if (type === 'CHAT_EDIT') state.edits.push({ payload, requestId, completed: false });
      if (type === 'CHAT_SEND') state.sent.push(payload);
      if (type === 'CHAT_SEND' && payload.clientMessageId) {
        const message = structuredClone(session.chatStore.getOutgoing(payload.clientMessageId).message);
        state.deliveryRequests.push({ requestId, payload: structuredClone(payload), message });
        if (!state.holdDeliveryAck) queueMicrotask(() => session.client.handleIncomingMessage({
          type: 'CHAT_MESSAGE', requestId, payload: message,
        }));
      } else if (type === 'CHAT_SEND' && payload.blocks) {
        state.blockRequest = { requestId, payload };
        if (!state.holdBlockAck) queueMicrotask(() => session.client.handleIncomingMessage({
          type: 'CHAT_MESSAGE', requestId, payload: { ...payload, id: `block-${state.sent.length}`, userId: user.id, userNickname: user.nickname, createdAt: Date.now(), isSystem: false },
        }));
      }
      if (type === 'COMMAND_INVOKE') {
        state.commands.push(payload);
        queueMicrotask(() => session.client.handleIncomingMessage({
          type: 'COMMAND_INVOKED', requestId,
          payload: { invocationId: `invocation-${state.commands.length}`, channelId: payload.channelId,
            botId: payload.botId, commandName: payload.commandName },
        }));
      }
    };
    const request = session.client.sendRequest.bind(session.client);
    session.client.sendRequest = (type, ...args) => type === 'SELECTOR_LIST' ? Promise.resolve({ selectors: [] })
      : type === 'CHAT_SEND' && args[0]?.clientMessageId && state.deliveryTimeout
        ? request(type, args[0], args[1], state.deliveryTimeout) : request(type, ...args);
    states.set(name, state);
    seed(state);
    return state;
  };
  const seed = state => {
    const store = state.session.chatStore;
    store.setHistory('chat', [
      reply, original,
      { ...original, id: 'second', content: 'Another editable message', createdAt: 110 },
      { ...original, id: 'other-user', userId: 'someone-else', createdAt: 120 },
      { ...original, id: 'system', isSystem: true, createdAt: 130 },
      { ...original, id: 'deleted', deletedAt: 140, createdAt: 140 },
      { ...original, id: 'private', isEphemeral: true, createdAt: 150 },
    ]);
    store.setHistory('other', [{ ...original, id: 'other-message', channelId: 'other' }]);
    store.setDraft('other', 'Other channel draft');
    store.setReplyDraft('chat', reply);
    store.setCommands([command]);
  };
  const activate = name => {
    detachedInput = document.getElementById('chat-message-input');
    view?.destroy();
    active = states.get(name) ?? create(name);
    sessionManager.activate(active.session.key);
    root.innerHTML = '';
    view = new ChatView(root);
    view.setChannel('chat');
  };
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  const settle = async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  window.messageEditingFixture = {
    async referenceLayout(empty = false) {
      const store = active.session.chatStore;
      const server = active.session.serverStore;
      server.serverDetails.maxMessageLength = 16000;
      server.serverDetails.protocol = { version: 25, minimumVersion: 24, features: ['chat-blocks', 'message-length-setting', 'chat-delivery'] };
      store.clearDraft('chat');
      store.setReplyDraft('chat');
      const source = { ...reply, userId: 'qa-teammate', userNickname: 'QA Teammate', content: 'Podemos revisar o exemplo?', createdAt: new Date(2026, 3, 13, 14, 51).getTime() };
      store.setHistory('chat', [source]);
      store.setBlockDraft('chat', empty ? [] : [
        { type: 'reply', messageId: source.id, reply: store.messageReply(source) },
        { type: 'text', text: 'Segue o exemplo para revisão:' },
        { type: 'code', language: 'powershell', code: '$name = "Monky"\nGet-Process |\n  Where-Object { $_.CPU -gt 10 }\nWrite-Output $name' },
      ]);
      view.render();
      await settle();
    },
    referenceState() {
      const input = find('#chat-message-input');
      const style = getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      const button = find('#btn-send-message').getBoundingClientRect();
      const code = document.querySelector('.chat-code-input textarea');
      return {
        width: innerWidth,
        placeholderOffset: Math.abs(rect.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 - (button.top + button.height / 2)),
        inputHeight: rect.height, quoteHasTime: !!document.querySelector('.chat-composer-block .chat-quote time'),
        highlighted: !!document.querySelector('.chat-code-input code .hljs-variable'),
        numbers: document.querySelector('.chat-code-editor .md-code-lines')?.textContent,
        codeHeight: code?.getBoundingClientRect().height,
        unified: !!code?.closest('.chat-composer-surface'),
        language: document.querySelector('.chat-code-header select')?.value, code: code?.value,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    },
    languageOptions() { return [...document.querySelectorAll('.monky-select-option')].map(option => option.textContent).join('|'); },
    focusCode() {
      const code = find('.chat-code-input textarea');
      code.focus(); code.setSelectionRange(0, 0);
    },
    async deliveryChecks() {
      let checks = 0;
      const check = (value, message) => { if (!value) throw new Error(message); checks++; };
      const store = active.session.chatStore;
      const client = active.session.client;
      active.holdDeliveryAck = true;
      find('#btn-send-message').click();
      const first = active.deliveryRequests.at(-1);
      check(first && document.querySelector(`[data-message-id="${first.message.id}"] [data-delivery="sending"]`),
        'Sending creates a visible pending message for the complete reference composition');
      check(store.getBlockDraft('chat').length === 0 && !find('#chat-message-input').readOnly,
        'The immutable outbox preserves the message while the user can compose the next one');
      client.handleIncomingMessage({ type: 'SERVER_ERROR', requestId: first.requestId, payload: { code: 'RATE_LIMITED', message: 'fixture' } });
      await settle();
      check(document.querySelector(`[data-message-id="${first.message.id}"] [data-delivery="failed"] button`),
        'A server rejection displays failure and retry beside the same message');
      check(store.getOutgoing(first.message.id).payload.blocks[2].code === first.payload.blocks[2].code,
        'Failure preserves the exact code, text and reply ID, not a reconstructed draft');
      view.setChannel('other');
      view.setChannel('chat');
      await settle();
      const retry = find(`[data-message-id="${first.message.id}"] [data-retry-message]`);
      const before = active.deliveryRequests.length;
      retry.click(); retry.click();
      check(active.deliveryRequests.length === before + 1 && store.getOutgoing(first.message.id).status === 'sending',
        'Repeated retry clicks start exactly one attempt');
      const retried = active.deliveryRequests.at(-1);
      check(JSON.stringify(retried.payload) === JSON.stringify(first.payload) && retried.requestId !== first.requestId,
        'Retry keeps the stable message ID and payload but correlates a new request');
      client.handleIncomingMessage({ type: 'CHAT_MESSAGE', requestId: first.requestId, payload: first.message });
      await settle();
      client.rejectPendingRequests();
      await settle();
      check(!store.getOutgoing(first.message.id) && document.querySelectorAll(`.chat-message-row[data-message-id="${first.message.id}"]`).length === 1
        && document.querySelector(`[data-message-id="${first.message.id}"] [data-delivery="sent"]`),
        'A late original acknowledgement wins over a later retry failure without duplicating the row');
      check(document.querySelector(`[data-message-id="${first.message.id}"] .md-code-lines`).textContent === '1\n2\n3\n4',
        'The acknowledged message keeps syntax, numbers and its compact reply');
      active.deliveryTimeout = 40;
      const input = find('#chat-message-input');
      input.value = 'Esta mensagem aguarda uma nova tentativa.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      find('#btn-send-message').click();
      const timedOut = active.deliveryRequests.at(-1);
      await new Promise(resolve => setTimeout(resolve, 80));
      await settle();
      check(store.getOutgoing(timedOut.message.id)?.status === 'failed',
        'An actual request timeout leaves a visible recoverable message rather than reporting sent');
      active.deliveryTimeout = undefined;
      active.holdDeliveryAck = false;
      find(`[data-message-id="${timedOut.message.id}"] [data-retry-message]`).click();
      await settle();
      check(!store.getOutgoing(timedOut.message.id)
        && document.querySelectorAll(`.chat-message-row[data-message-id="${timedOut.message.id}"]`).length === 1,
        'Retry after timeout reconciles to one confirmed row');
      active.holdDeliveryAck = true;
      input.value = 'Exemplo de falha com botão para tentar novamente.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      find('#btn-send-message').click();
      client.rejectPendingRequests();
      await settle();
      return checks;
    },
    async mediaDeliveryChecks() {
      const { stickerService } = await import('/core/StickerService.ts');
      const { client, chatStore: store, serverStore: server } = active.session;
      const saved = { xhr: window.XMLHttpRequest, request: client.sendRequest, base: client.getHttpBaseUrl,
        toFile: stickerService.toFile, permissions: server.myPermissions, protocol: server.serverDetails.protocol };
      let checks = 0;
      let uploads = 0;
      const check = (value, message) => { if (!value) throw new Error(message); checks++; };
      const row = id => find(`.chat-message-row[data-message-id="${id}"]`);
      try {
        client.getHttpBaseUrl = () => location.origin;
        client.sendRequest = (type, ...args) => type === 'CHAT_REQUEST_UPLOAD_TOKEN'
          ? Promise.resolve({ token: 'fixture-upload' }) : saved.request.call(client, type, ...args);
        window.XMLHttpRequest = class {
          upload = {};
          open() {}
          setRequestHeader() {}
          send(file) {
            uploads++;
            this.status = 200;
            this.response = { id: `fixture-file-${uploads}`, messageId: '', originalName: file.name,
              sizeBytes: file.size, mimeType: file.type, kind: file.type === 'image/png' ? 'image' : 'file',
              url: '/fixture-attachment', createdAt: Date.now() };
            queueMicrotask(() => this.onload?.());
          }
        };
        active.holdDeliveryAck = true;
        const files = new DataTransfer();
        files.items.add(new File(['Fixture content'], 'fixture.txt', { type: 'text/plain' }));
        view.addFiles(files.files);
        await settle();
        check(view.pending.length === 1 && view.pending[0].status === 'done', 'The ordinary file upload completes before queuing');
        find('#btn-send-message').click();
        const fileRequest = active.deliveryRequests.at(-1);
        check(fileRequest.payload.attachmentIds[0] === 'fixture-file-1'
          && row(fileRequest.message.id).querySelector('.chat-attachments')
          && view.pending.length === 0, 'Attachment-only messages retain their preview while awaiting server confirmation');
        client.rejectPendingRequests();
        await settle();
        const before = active.deliveryRequests.length;
        server.myPermissions = 0;
        row(fileRequest.message.id).querySelector('[data-retry-message]').click();
        check(active.deliveryRequests.length === before && store.getOutgoing(fileRequest.message.id).status === 'failed',
          'Revoked permissions block retry without discarding the attachment');
        find('.dialog-card [data-action="confirm"]').click();
        server.myPermissions = saved.permissions;
        server.serverDetails.protocol = { ...saved.protocol, features: saved.protocol.features.filter(feature => feature !== 'chat-delivery') };
        row(fileRequest.message.id).querySelector('[data-retry-message]').click();
        check(active.deliveryRequests.length === before, 'A server without the negotiated delivery feature cannot receive a retry');
        find('.dialog-card [data-action="confirm"]').click();
        server.serverDetails.protocol = saved.protocol;
        active.holdDeliveryAck = false;
        row(fileRequest.message.id).querySelector('[data-retry-message]').click();
        await settle();
        check(uploads === 1 && !store.getOutgoing(fileRequest.message.id)
          && row(fileRequest.message.id).querySelector('.chat-attachments'), 'Retry confirms the same uploaded file without another upload');
        stickerService.toFile = async () => new File(['Synthetic sticker'], 'fixture.png', { type: 'image/png' });
        active.holdDeliveryAck = true;
        await view.sendSticker({ name: 'fixture', filePath: 'fixture-sticker', sizeBytes: 17 });
        const stickerRequest = active.deliveryRequests.at(-1);
        check(stickerRequest.payload.attachmentIds[0] === 'fixture-file-2'
          && row(stickerRequest.message.id).querySelector('.chat-sticker')
          && row(stickerRequest.message.id).querySelector('[data-delivery="sending"]'), 'Stickers use the same visible pending acknowledgement path');
        client.rejectPendingRequests();
        await settle();
        active.holdDeliveryAck = false;
        row(stickerRequest.message.id).querySelector('[data-retry-message]').click();
        await settle();
        check(uploads === 2 && !store.getOutgoing(stickerRequest.message.id)
          && row(stickerRequest.message.id).querySelector('[data-delivery="sent"]'), 'Sticker retry reuses its upload and confirms delivery');
        return checks;
      } finally {
        window.XMLHttpRequest = saved.xhr;
        client.sendRequest = saved.request;
        client.getHttpBaseUrl = saved.base;
        stickerService.toFile = saved.toFile;
        server.myPermissions = saved.permissions;
        server.serverDetails.protocol = saved.protocol;
      }
    },
    async compositionChecks() {
      let checks = 0;
      const check = (value, message) => { if (!value) throw new Error(message); checks++; };
      const store = active.session.chatStore;
      const server = active.session.serverStore;
      store.setReplyDraft('chat', null);
      server.serverDetails.maxMessageLength = 16000;
      server.serverDetails.protocol = { version: 25, minimumVersion: 24, features: ['chat-blocks', 'message-length-setting'] };
      appEvents.emit('server.updated', server.serverDetails);
      const input = find('#chat-message-input');
      const type = (element, text) => {
        element.focus(); element.value = text; element.setSelectionRange(text.length, text.length);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const { Permission } = await import('/@id/@monky/shared');
      const channel = server.getChannel('chat');
      const roles = server.roles;
      const assignments = server.userRoles;
      const reader = { id: 'mention-reader', name: 'Reader', color: '#123456', position: 1,
        permissions: Permission.READ_MESSAGES, isDefault: false, createdAt: 1 };
      server.knownMembers.set('mention-allowed', { ...user, id: 'mention-allowed', nickname: 'Eligible' });
      server.knownMembers.set('mention-outsider', { ...user, id: 'mention-outsider', nickname: 'Outsider' });
      server.updateRoles([...roles, reader], [...assignments, { userId: 'mention-allowed', roleIds: [reader.id] }]);
      server.updateChannel({ ...channel, isPrivate: true, allowedRoleIds: [reader.id] });
      type(input, '@');
      check(find('#mention-dropup').textContent.includes('Eligible') && !find('#mention-dropup').textContent.includes('Outsider'),
        'Private channel autocomplete excludes members without access');
      server.updateRoles(roles, assignments);
      check(!find('#mention-dropup').textContent.includes('Eligible'), 'Revoking a role refreshes an already open mention list');
      server.updateChannel(channel);
      check(find('#mention-dropup').textContent.includes('Outsider'), 'Making the channel public refreshes mention suggestions immediately');
      server.knownMembers.delete('mention-allowed');
      server.knownMembers.delete('mention-outsider');
      type(input, 'Before ');
      find('#btn-code').click();
      check(store.getBlockDraft('chat').map(block => block.type).join(',') === 'text,code', 'Code inserts at the caret without sending');
      check(active.sent.length === 0, 'Creating inline code never sends a message');
      const code = find('.chat-composer-block-code textarea');
      type(code, 'const safe = "<img onerror=alert(1)>";');
      const details = find('.chat-composer-block-code details');
      details.open = false;
      check(!details.open && code.value.includes('<img'), 'Code is editable and collapsible without losing text');
      type(input, 'After');
      find('[data-message-id="original"] [data-message-action="reply"]').click();
      find('[data-message-id="reply-source"] [data-message-action="reply"]').click();
      check(store.getBlockDraft('chat').filter(block => block.type === 'reply').length === 2, 'Multiple reference blocks coexist with text and code');
      view.setChannel('other');
      view.setChannel('chat');
      check(store.getBlockDraft('chat').length === 5, 'All blocks survive channel navigation');
      active.holdBlockAck = true;
      find('#btn-send-message').click();
      await settle();
      check(find('#chat-message-input').readOnly, 'The composer is locked while waiting for the server acknowledgement');
      check(store.getBlockDraft('chat').length === 5, 'Blocks remain recoverable before acknowledgement');
      const request = active.blockRequest;
      active.session.client.handleIncomingMessage({ type: 'SERVER_ERROR', requestId: request.requestId,
        payload: { code: 'RATE_LIMITED', message: 'fixture' } });
      await settle();
      check(store.getBlockDraft('chat').length === 5 && !find('#chat-message-input').readOnly, 'A rejected send preserves every block and unlocks editing');
      find('.dialog-card [data-action="confirm"]').click();
      await settle();
      active.holdBlockAck = false;
      find('#btn-send-message').click();
      await settle();
      check(store.getBlockDraft('chat').length === 0, 'Only the acknowledged send clears the draft');
      check(active.sent.at(-1).blocks.filter(block => block.type === 'reply').every(block => !('reply' in block)), 'Reference snapshots are never trusted in client input');
      type(find('#chat-message-input'), '```');
      check(store.getBlockDraft('chat')[0]?.type === 'code', 'Triple backticks create an inline code block');
      store.setBlockDraft('chat', []);
      view.renderComposerBlocks();
      server.serverDetails.maxMessageLength = 0;
      appEvents.emit('server.updated', server.serverDetails);
      check(!find('#chat-message-input').hasAttribute('maxlength'), 'Unlimited messages remove the native maxlength');
      check(find('#chat-char-counter').textContent.includes('∞'), 'The unlimited setting updates the counter immediately');
      server.serverDetails.maxMessageLength = 123;
      appEvents.emit('server.updated', server.serverDetails);
      check(find('#chat-message-input').maxLength === 123, 'A live limit update changes the editor without reconnecting');
      const { OverlayStageView } = await import('/views/OverlayStageView.ts');
      const overlayRoot = document.createElement('div');
      overlayRoot.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px';
      document.body.append(overlayRoot);
      const overlay = new OverlayStageView(overlayRoot);
      overlay.init();
      try {
        const config = { enabled: true, opacity: 0.9, layout: 'grid', preserveAspectRatio: true, showCamera: true, showScreen: true };
        const participants = Array.from({ length: 3 }, (_, index) => ({
          sessionId: `overlay-${index}`, userId: `overlay-${index}`, nickname: `Participant ${index}`,
          isCameraOn: true, isScreenSharing: false, isMuted: false, isDeafened: false, isSpeaking: false,
        }));
        for (const layout of ['grid', 'horizontal', 'vertical', 'focus-speaker']) {
          overlay.currentState = { config: {
            ...config, layout: layout === 'focus-speaker' ? 'grid' : layout,
            mode: 'cameras-only', focusActiveSpeaker: layout === 'focus-speaker',
          }, participants, channelName: 'Isolated overlay' };
          overlay.render();
          await settle();
          const grid = overlayRoot.querySelector('.overlay-cards-container');
          check(getComputedStyle(grid).display === 'grid', `${layout} respects proportional grid sizing`);
          for (const card of grid.querySelectorAll('.overlay-card')) {
            const rect = card.getBoundingClientRect();
            check(Math.abs(rect.width / rect.height - 16 / 9) < 0.03, `${layout} cards remain 16:9 in the actual DOM`);
          }
          overlay.currentState.config.preserveAspectRatio = false;
          overlay.render();
          check(!overlayRoot.querySelector('.overlay-cards-container').classList.contains('preserve-aspect'), 'Disabling aspect preservation restores the flexible layout');
          overlay.currentState.config.preserveAspectRatio = true;
          overlay.render();
          check(overlayRoot.querySelector('.overlay-cards-container').classList.contains('preserve-aspect'), 'Aspect preservation can be restored without recreating the overlay');
        }
        overlayRoot.style.width = '350px';
        overlayRoot.style.height = '240px';
        await settle();
        check(overlayRoot.querySelectorAll('.overlay-resize-hint').length === 8, 'All resize directions have a proximity hint');
        overlay.isHovered = true; overlay.pointer = { x: 175, y: 120 }; overlay.applyHoverState();
        check([...overlayRoot.querySelectorAll('.overlay-resize-hint')].every(hint => !hint.classList.contains('near-pointer')), 'Resize hints do not clutter the center');
        const root = overlayRoot.querySelector('.overlay-stage-root');
        const bounds = root.getBoundingClientRect();
        const showHint = (x, y) => {
          overlay.pointer = { x: bounds.left + x, y: bounds.top + y };
          overlay.applyHoverState();
          return [...root.querySelectorAll('.overlay-resize-hint.near-pointer')].map(hint => hint.dataset.direction).join(',');
        };
        for (const [direction, x, y, rotation] of [
          ['nw', 1, 1, 180], ['ne', bounds.width - 1, 1, 270],
          ['sw', 1, bounds.height - 1, 90], ['se', bounds.width - 1, bounds.height - 1, 0],
        ]) {
          check(showHint(x, y) === direction, `Only the ${direction} corner lights up near that corner`);
          const hint = root.querySelector(`[data-direction="${direction}"]`);
          check(hint.querySelector('path').getAttribute('transform') === `rotate(${rotation} 8 8)`, `${direction} grip points toward its own corner`);
          check(getComputedStyle(hint).pointerEvents === 'none', 'Resize indicators never intercept native window resizing');
        }
        check(showHint(bounds.width * 0.35, bounds.height - 40) === 's', 'Bottom-center hint appears while approaching its central region');
        check(showHint(bounds.width * 0.65, 40) === 'n', 'Top-center hint appears across its central region');
        check(showHint(40, bounds.height * 0.35) === 'w', 'Left-center hint appears before reaching the edge');
        check(showHint(bounds.width - 40, bounds.height * 0.65) === 'e', 'Right-center hint appears before reaching the edge');
        overlay.isHovered = false;
        overlay.applyHoverState();
        check(!root.querySelector('.near-pointer'), 'Leaving the overlay clears the active resize hint');
      } finally { overlay.destroy(); overlayRoot.remove(); document.body.classList.remove('overlay-window-mode'); }
      return checks;
    },
    async prepare(locale) {
      view?.destroy();
      for (const state of states.values()) {
        for (const id of ['chat', 'other']) {
          const edit = state.session.chatStore.getMessageEdit(id);
          if (edit) state.session.chatStore.finishMessageEdit(id, edit);
        }
        state.session.client.rejectPendingRequests();
        state.session.chatStore.clear();
        state.session.serverStore.setServerDetails(details(state.name), user);
        state.status = 'CONNECTED';
        state.epoch++;
        state.edits = [];
        state.sent = [];
        state.commands = [];
        seed(state);
      }
      language.setLanguage(locale);
      activate('a');
      await document.fonts.ready;
      await settle();
    },
    state() {
      const channel = view.currentChannelId;
      const store = active.session.chatStore;
      const edit = store.getMessageEdit(channel);
      const input = find('#chat-message-input');
      const save = find('#btn-send-message');
      const cancel = find('#btn-cancel-message-edit');
      const row = root.querySelector('[data-message-id="original"] .chat-message-text');
      return {
        editing: !!edit, pending: !!edit?.pending, value: input.value, draft: store.getDraft(channel),
        message: store.getMessages('chat').find(message => message.id === 'original')?.content,
        originalVisible: !!row && getComputedStyle(row).display !== 'none',
        edits: active.edits.map(request => request.payload), sent: active.sent, commands: active.commands,
        saveLabel: save.textContent.replace(/send|check|hourglass_empty/g, '').trim(),
        cancelLabel: cancel.textContent.trim(), saveDisabled: save.disabled, cancelDisabled: cancel.disabled,
        editLabel: find('#chat-edit-label').textContent, hint: find('#chat-edit-hint').textContent,
        error: find('#chat-edit-error').textContent, description: input.getAttribute('aria-describedby') ?? '',
        replyId: store.getReplyDraft(channel)?.messageId, replyHidden: find('#chat-reply-composer').hidden,
        readOnly: input.readOnly, focus: document.activeElement?.id,
        attachHidden: getComputedStyle(find('#btn-attach')).display === 'none',
        codeHidden: getComputedStyle(find('#btn-code')).display === 'none',
        trayHidden: getComputedStyle(find('#chat-attachment-tray')).display === 'none',
        inlineEditors: root.querySelectorAll('.chat-message-editor').length,
        textareas: root.querySelectorAll('textarea').length,
        commandOpen: getComputedStyle(find('#command-dropup')).display !== 'none',
        commandSelected: !!store.getCommandDraft(channel),
      };
    },
    selectText() { const input = find('#chat-message-input'); input.focus(); input.select(); },
    focusInput() { find('#chat-message-input').focus(); },
    focusOtherControl() {
      const button = document.createElement('button');
      button.id = 'fixture-other-control';
      button.textContent = 'Another control';
      document.body.appendChild(button);
      button.focus({ preventScroll: true });
    },
    removeOtherControl() { document.getElementById('fixture-other-control')?.remove(); },
    async focusMore() { find('[data-message-id="original"] [data-message-action="more"]').focus(); await settle(); },
    editMenuIndex() {
      const buttons = [...document.querySelectorAll('.floating-context-menu [role="menuitem"]')];
      const index = buttons.findIndex(button => button.textContent.includes(language.t('chat.editMessage')));
      if (index < 0) throw new Error('Edit is missing from the message menu: ' + JSON.stringify({
        labels: buttons.map(button => button.textContent), focus: document.activeElement?.id,
        editing: !!active.session.chatStore.getMessageEdit(view.currentChannelId),
      }));
      return index;
    },
    async point(selector) {
      const element = find(selector);
      element.scrollIntoView({ block: 'nearest' });
      await settle();
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    async replyEdit(name, kind = 'success') {
      const state = states.get(name);
      const request = state.edits.findLast(request => !request.completed);
      if (!request) throw new Error(`No pending edit in ${name}`);
      request.completed = true;
      const message = kind === 'stale-success' ? original : state.session.chatStore.getMessages(request.payload.channelId)
        .find(message => message.id === request.payload.messageId) ?? original;
      state.session.client.handleIncomingMessage(kind === 'failure'
        ? { type: 'SERVER_ERROR', requestId: request.requestId, payload: { code: 'PERMISSION_DENIED', message: 'Fixture rejection' } }
        : { type: 'CHAT_MESSAGE_UPDATED', requestId: request.requestId,
          payload: { message: { ...message, content: request.payload.content, editedAt: Date.now() } } });
      await settle();
    },
    stageUploadingAttachment() {
      view.pending.push({ localId: 'fixture-upload', name: 'fixture.txt', size: 12, isImage: false,
        previewUrl: null, status: 'uploading', progress: 0.5 });
      view.renderTray();
      view.updateSendButtonState();
    },
    attachOriginal() {
      active.session.chatStore.updateMessage({ ...original, content: 'Attachment caption', attachments: [{
        id: 'fixture-attachment', messageId: original.id, kind: 'FILE', url: null, originalName: 'fixture.txt',
        mimeType: 'text/plain', sizeBytes: 12, createdAt: 100, evicted: true,
      }] });
    },
    trySecondEdit() { view.startEditingMessage('second'); },
    replaceHistory() { active.session.chatStore.setHistory('chat', [reply], 'reply-source'); },
    deleteOriginal() {
      active.session.client.handleIncomingMessage({
        type: 'CHAT_MESSAGE_UPDATED', payload: { message: { ...original, content: '', deletedAt: 200 } },
      });
    },
    attemptForbiddenEdits() {
      for (const id of ['other-user', 'system', 'deleted', 'private']) view.startEditingMessage(id);
    },
    setEditPermission(allowed) {
      active.session.serverStore.serverDetails.allowMessageEdit = allowed;
      active.session.serverStore.bus.emit('server.updated');
    },
    removeSendPermission() {
      active.session.serverStore.myPermissions = 0;
      active.session.serverStore.bus.emit('server.roles_updated');
    },
    async setChannel(channel) { view.setChannel(channel); await settle(); },
    async activate(name) { activate(name); await settle(); },
    dispatchDetachedInput() {
      if (!detachedInput) throw new Error('Missing detached input');
      detachedInput.value = 'A stale event must not replace either session draft';
      detachedInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    },
    disconnectTemporarily() {
      active.status = 'RECONNECTING';
      active.session.client.rejectPendingRequests();
      active.session.client.emitScoped('network.status', 'RECONNECTING');
    },
    reconnect() {
      active.status = 'CONNECTED';
      active.epoch++;
      active.session.client.emitScoped('network.status', 'CONNECTED');
    },
    async hardDisconnectAndRecreate() {
      const name = active.name;
      active.session.chatStore.clear();
      view.destroy();
      sessionManager.remove(active.session.key);
      states.delete(name);
      create(name);
      activate(name);
      await settle();
    },
    async rerender() { view.render(); await settle(); find('#chat-message-input').focus(); },
    trustedEvents() { return trusted; },
    settle,
    cleanup() {
      view?.destroy();
      selectEnhancer.dispose();
      offUpdate();
      offMessage();
      sessionManager.removeAll();
      routing.setSessionEventRouter((_key, _event, emit) => emit());
      document.removeEventListener('input', inputListener);
      document.removeEventListener('keydown', keyListener);
      document.getElementById('fixture-other-control')?.remove();
      root.innerHTML = '';
    },
  };
}
