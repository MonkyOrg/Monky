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
  const { data } = await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, filename), Buffer.from(data, 'base64'));
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
    if (text) await insert(text);
    else await key('Backspace', 'Backspace', 8);
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
    if (process.argv.includes('--markdown-preview')) return await runLiveMarkdownSmoke(window);
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
      check(current.attachHidden && !current.codeDisabled, 'Attachments remain unavailable while code formatting edits the existing message');
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
    await fixture('selectText()');
    await click('#btn-format');
    await evaluate(`Promise.all(document.querySelector('.chat-format-panel').getAnimations().map(animation => animation.finished))`);
    await click('[data-format="code"]');
    current = await state();
    check(current.editing && current.value === '```\nRetained when editing is disabled\n```'
      && current.sent.length === 0 && current.edits.length === 0,
    'Code formatting during editing neither requires new-message permission nor sends another message');
    await key('z', 'KeyZ', 90, undefined, process.platform === 'darwin' ? 4 : 2);
    await fixture('settle()');
    check((await state()).value === 'Retained when editing is disabled',
      'Undo isolates toolbar formatting from the preceding native typing');
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
    checks += await runLiveMarkdownSmoke(window);
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

async function runLiveMarkdownSmoke(window) {
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  const fixture = source => evaluate(`window.messageEditingFixture.${source}`);
  const nativeCaretHeight = async () => {
    const rectangle = await evaluate(`(() => {
      const input=document.getElementById('chat-message-input');
      const line=input.querySelector('.cm-line').getBoundingClientRect();
      const caret=window.getSelection().getRangeAt(0).getBoundingClientRect();
      return {x:Math.floor(caret.height ? caret.left : line.left),y:Math.floor(line.top),width:2,height:Math.ceil(line.height)+2};
    })()`);
    const pixels = async () => {
      const {data}=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png'});
      return require('electron').nativeImage.createFromBuffer(Buffer.from(data,'base64')).crop(rectangle).getBitmap();
    };
    await evaluate(`document.getElementById('chat-message-input').blur()`);
    await fixture('settle()');
    const before = await pixels();
    await evaluate(`document.getElementById('chat-message-input').focus()`);
    await fixture('settle()');
    const after = await pixels();
    const rows = [];
    for (let y=0;y<rectangle.height;y++) {
      if ([0,1].some(x => [0,1,2].some(channel => {
        const offset=(y*2+x)*4+channel;
        return Math.abs(after[offset]-before[offset])>100;
      }))) rows.push(y);
    }
    return rows.length ? rows.at(-1)-rows[0]+1 : 0;
  };
  const key = async (key, code, keyCode, modifiers = 0) => {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers,
    });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers,
    });
    await fixture('settle()');
  };
  const insert = async text => {
    await window.webContents.debugger.sendCommand('Input.insertText', { text });
    await fixture('settle()');
  };
  const click = async selector => {
    const point = await fixture(`point(${JSON.stringify(selector)})`);
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await fixture('settle()');
  };
  const draft = async (text, from = 0, to = text.length) => {
    await evaluate(`(() => {
      const input = document.getElementById('chat-message-input');
      input.value = ${JSON.stringify(text)}; input.focus(); input.setSelectionRange(${from}, ${to});
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await fixture('settle()');
  };
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  for (const locale of ['pt-BR', 'en']) {
    await fixture(`prepare(${JSON.stringify(locale)})`);
    await draft('', 0, 0);
    const [initialWidth, initialHeight] = window.getContentSize();
    const originalPlaceholder = await evaluate(`document.getElementById('chat-message-input').placeholder`);
    window.setContentSize(450, initialHeight);
    await evaluate(`document.getElementById('chat-message-input').placeholder=${JSON.stringify(originalPlaceholder.repeat(4))}`);
    await fixture('settle()');
    const emptyCaret = await evaluate(`(() => {
      const input=document.getElementById('chat-message-input');
      return {
        placeholder:input.querySelector('.cm-placeholder').getBoundingClientRect().height,
        nativeCaret:getComputedStyle(input.querySelector('.cm-line')).caretColor,
        lineHeight:parseFloat(getComputedStyle(input.querySelector('.cm-line')).lineHeight)};
    })()`);
    emptyCaret.height = await nativeCaretHeight();
    check(emptyCaret.placeholder > emptyCaret.lineHeight * 2 && emptyCaret.height > 0
      && emptyCaret.height <= emptyCaret.lineHeight + 1,
    `A wrapped placeholder keeps a single-line caret: ${JSON.stringify(emptyCaret)}`);
    check(emptyCaret.nativeCaret !== 'rgba(0, 0, 0, 0)', 'The native caret is visible rather than hidden behind a replacement cursor');
    await captureScreenshot(window, `markdown-placeholder-caret-${locale}.png`);
    await insert('x');
    const typedCaretHeight = await nativeCaretHeight();
    check(typedCaretHeight > 0 && typedCaretHeight <= emptyCaret.lineHeight + 1,
      `The native caret stays visible and single-line before and after typing: empty=${emptyCaret.height}, typed=${typedCaretHeight}`);
    window.setContentSize(initialWidth, initialHeight);
    await evaluate(`document.getElementById('chat-message-input').placeholder=${JSON.stringify(originalPlaceholder)}`);
    await draft('', 0, 0);
    const source = '# Heading\n\nA **bold** and *italic* with ~~strike~~ and `inline`.\n\n> Quote\n\n4. Four\n5. Five\n\n```js\nconst answer = 42;\n```';
    await insert(source);
    let result = await evaluate(`(() => {
      const input = document.getElementById('chat-message-input');
      return {value:input.value, heading:!!input.querySelector('.md-editor-h1'), bold:input.querySelector('strong')?.textContent,
        italic:!!input.querySelector('em'), strike:!!input.querySelector('del'), code:!!input.querySelector('.hljs-keyword'),
        marker: input.querySelector('.md-editor-h1')?.textContent, scripts:input.querySelectorAll('script,img:not(.cm-widgetBuffer)').length,
        attach:document.querySelector('#btn-attach > span').textContent.trim(), open:document.getElementById('btn-format').getAttribute('aria-expanded')};
    })()`);
    check(result.value === source, 'Live rendering never rewrites the Markdown source');
    check(result.heading && result.bold === 'bold' && result.italic && result.strike && result.code, 'Headings, emphasis, strike and code are rendered while composing');
    check(!result.marker.includes('#') && result.marker.replace(/[\u200b\ufeff]/g, '') === 'Heading' && !result.scripts,
      `Inactive syntax is hidden without mounting user HTML: ${JSON.stringify(result)}`);
    check(result.attach === 'attach_file' && result.open === 'false', 'Paperclip replaces plus and formatting starts collapsed');
    await evaluate(`document.getElementById('chat-message-input').setSelectionRange(4,4)`);
    await fixture('settle()');
    check(await evaluate(`(() => { const marker=document.querySelector('.md-editor-h1 .md-editor-syntax');
      return marker?.textContent === '# ' && Number(getComputedStyle(marker).opacity) < 1; })()`),
    'Moving the real editor selection into a heading reveals dimmed syntax');
    await draft('selected');
    await click('#btn-format');
    await evaluate(`Promise.all(document.querySelector('.chat-format-panel').getAnimations().map(animation => animation.finished))`);
    await click('[data-format="bold"]');
    check((await fixture('state()')).value === '**selected**', 'Bold formats the selected text, not the entire draft');
    await key('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
    check((await fixture('state()')).value === 'selected', 'Native Undo reverses a formatting transaction');
    await draft('selected');
    await click('[data-format="italic"]');
    check((await fixture('state()')).value === '*selected*', 'Italic preserves and formats the selection');
    await draft('selected');
    await click('[data-format="strike"]');
    check((await fixture('state()')).value === '~~selected~~', 'Strike preserves and formats the selection');
    for (const [format, tag] of [['bold', 'strong'], ['italic', 'em'], ['strike', 'del']]) {
      await draft('', 0, 0);
      await click(`[data-format="${format}"]`);
      check((await fixture('state()')).value === '' && await evaluate(`document.querySelector('[data-format="${format}"]').getAttribute('aria-pressed') === 'true'`),
        `${format} toggles typing without inserting placeholder text`);
      await insert('alpha');
      await insert(' ');
      await insert('beta');
      await click(`[data-format="${format}"]`);
      await insert('plain');
      const formatted = await evaluate(`(async () => {
        const {renderMarkdown}=await import('/utils/markdown.ts');
        const template=document.createElement('template'); template.innerHTML=renderMarkdown(document.getElementById('chat-message-input').value);
        return {text:template.content.textContent, styled:[...template.content.querySelectorAll('${tag}')].map(node=>node.textContent).join(''),
          pressed:document.querySelector('[data-format="${format}"]').getAttribute('aria-pressed')};
      })()`);
      check(formatted.text === 'alpha betaplain' && formatted.styled === 'alphabeta' && formatted.pressed === 'false',
        `${format} persists through typing and spaces, then stops without changing existing text: ${JSON.stringify(formatted)}`);
      await key('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
      check(!(await fixture('state()')).value.includes('plain') && (await fixture('state()')).value.includes('beta'),
        'Undo after switching typing style does not discard preceding formatted typing');
    }
    await draft('', 0, 0);
    await click('[data-format="bold"]');
    await click('[data-format="italic"]');
    await insert('combined');
    check((await fixture('state()')).value === '**_combined_**', 'Typing toggles compose without ambiguous Markdown delimiters');
    await key('Enter', 'Enter', 13, 8);
    await key('Enter', 'Enter', 13, 8);
    await insert('next');
    check((await fixture('state()')).value === '**_combined_**\n\n**_next_**',
      'Enabled formatting continues after blank lines without unbalanced delimiters');
    check(await evaluate(`document.querySelectorAll('.chat-format-toolbar [role="separator"]').length === 2`),
      'Emphasis and list controls have separate visual groups');
    await draft('selected');
    await click('[data-format="inline-code"]');
    check((await fixture('state()')).value === '`selected`', 'Inline code remains distinct from a code block');
    await draft('one\ntwo');
    await click('[data-format="bullet"]');
    check((await fixture('state()')).value === '- one\n- two', 'Bullet formatting handles multiple selected lines');
    check(await evaluate(`document.querySelectorAll('.md-editor-bullet').length === 2
      && [...document.querySelectorAll('.md-editor-bullet')].every(marker=>marker.textContent==='\\u2022')`),
      'Bullets are rendered as visible dots, not raw hyphens');
    await draft('', 0, 0);
    await click('[data-format="bullet"]');
    await insert('item');
    check((await fixture('state()')).value === '- item', 'Starting an empty bullet list keeps its marker when typing');
    await draft('one\ntwo');
    await click('[data-format="numbered"]');
    check((await fixture('state()')).value === '1. one\n2. two', 'Numbered formatting handles multiple selected lines');
    await draft('one\ntwo', 0, 4);
    await click('[data-format="bullet"]');
    check((await fixture('state()')).value === '- one\ntwo', 'Line formatting excludes a following line outside the selected range');
    await draft('# Heading');
    await click('[data-format="heading"]');
    await click('.floating-context-menu [role="menuitem"]:nth-child(3)');
    check((await fixture('state()')).value === '### Heading', 'Changing heading level does not remove the existing heading');
    await click('[data-format="heading"]');
    await click('.floating-context-menu [role="menuitem"]:nth-child(3)');
    check((await fixture('state()')).value === 'Heading', 'Selecting the same heading level toggles it off');
    await draft('', 0, 0);
    await click('[data-format="separator"]');
    await evaluate(`document.getElementById('chat-message-input').blur()`);
    await fixture('settle()');
    check(await evaluate(`document.getElementById('chat-message-input').value === '\\n\\n---\\n\\n'
      && !!document.querySelector('.md-editor-separator') && !document.querySelector('.md-editor-separator').textContent.includes('---')
      && getComputedStyle(document.querySelector('.md-editor-separator')).backgroundImage !== 'none'
      && document.querySelector('.md-editor-separator').getBoundingClientRect().height >= 16`),
    'Separators preview as horizontal rules while preserving their source');
    check(await evaluate(`(async () => {
      const {renderMarkdown}=await import('/utils/markdown.ts');
      const rendered=document.createElement('div'); rendered.className='chat-message-text'; rendered.innerHTML=renderMarkdown('---');
      document.body.appendChild(rendered);
      const rule=getComputedStyle(rendered.querySelector('hr'));
      const editor=document.querySelector('.md-editor-separator');
      const height=parseFloat(rule.marginTop)+parseFloat(rule.borderTopWidth)+parseFloat(rule.marginBottom);
      const equal=Math.abs(editor.getBoundingClientRect().height-height)<1
        && getComputedStyle(editor).backgroundImage.includes(rule.borderTopColor)
        && getComputedStyle(editor).backgroundSize === '100% 1px';
      rendered.remove(); return equal;
    })()`), 'The divider uses the sent-message color, one-pixel stroke and exact vertical spacing');
    const dividerMessage = 'Before\n\n---\n\nAfter';
    await draft(dividerMessage, dividerMessage.length, dividerMessage.length);
    check(await evaluate(`(async () => {
      const {renderMarkdown}=await import('/utils/markdown.ts');
      const input=document.getElementById('chat-message-input');
      const sent=document.createElement('div'); sent.className='chat-message-text'; sent.innerHTML=renderMarkdown(input.value);
      sent.style.width=input.getBoundingClientRect().width+'px'; document.body.appendChild(sent);
      const editorLines=[...input.querySelectorAll('.cm-line')];
      const sentGap=sent.lastElementChild.getBoundingClientRect().top-sent.firstElementChild.getBoundingClientRect().top;
      const editorGap=editorLines.at(-1).getBoundingClientRect().top-editorLines[0].getBoundingClientRect().top;
      sent.remove(); return Math.abs(sentGap-editorGap)<1;
    })()`), 'The same text and blank lines surrounding a divider have identical vertical spacing before and after sending');
    await captureScreenshot(window, `markdown-divider-${locale}.png`);
    await draft('quoted');
    await click('[data-format="quote"]');
    check((await fixture('state()')).value === '> quoted', 'Quote formatting applies to the current line');
    await draft('', 0, 0);
    await click('[data-format="quote"]');
    await insert('quotation');
    check((await fixture('state()')).value === '> quotation', 'A new quote places the caret after its marker without selecting or overwriting it');
    await draft('@e', 2, 2);
    await click('[data-mention-index="0"]');
    await insert('continues');
    check((await fixture('state()')).value === '@everyone continues', 'Typing after choosing a mention preserves the complete mention');
    await draft('Monky');
    await click('[data-format="link"]');
    check(await evaluate(`document.querySelectorAll('[data-link-input]').length === 2
      && document.querySelector('[data-link-input]').value === 'Monky'
      && document.activeElement === document.querySelectorAll('[data-link-input]')[1]
      && !document.querySelector('.modal-backdrop') && !document.querySelector('.chat-link-popover [aria-invalid="true"]')
      && document.querySelector('.chat-link-popover').getBoundingClientRect().bottom <= document.querySelector('[data-format="link"]').getBoundingClientRect().top`),
      'The link form opens above its anchor without a modal or premature validation');
    await insert('javascript:alert(1)');
    check(await evaluate(`!document.querySelector('.chat-link-popover [aria-invalid="true"]')`), 'Typing does not show errors before the first submit');
    await click('.chat-link-popover [data-action="confirm"]');
    check(await evaluate(`document.querySelectorAll('.chat-link-popover [aria-invalid="true"]').length === 1`), 'Invalid link protocols show feedback on submit without inserting a link');
    await evaluate(`document.activeElement.select()`);
    await insert('www.google.com');
    await click('.chat-link-popover [data-action="confirm"]');
    check((await fixture('state()')).value === '[Monky](https://www.google.com/)', 'The link form accepts www addresses without a scheme and defaults to HTTPS');
    check(await evaluate(`(async () => {
      const {normalizeEditorLinkAddress:normalize}=await import('/views/LinkPopover.ts');
      return normalize('example.com/docs?q=1#part')==='https://example.com/docs?q=1#part'
        && normalize('example.com/?next=https://other.example/')==='https://example.com/?next=https://other.example/'
        && normalize('example.com:8443/a b')==='https://example.com:8443/a%20b'
        && normalize('http://example.com/')==='http://example.com/'
        && ['javascript:alert(1)','data:text/html,test','file:///tmp/test','ftp://example.com','custom.example://path',
          'not-address','//example.com','www.','user@example.com'].every(value=>normalize(value)===null);
    })()`), 'Address normalization preserves HTTP, ports, paths and fragments without accepting unsafe schemes or invalid hostnames');
    await draft('', 0, 0);
    await click('[data-format="link"]');
    check(await evaluate(`document.querySelector('[data-link-input]').value === ''
      && document.activeElement === document.querySelector('[data-link-input]')`),
      'Without a selection the link dialog starts with an empty display-text field');
    await insert('Label [detail]');
    await click('.chat-link-popover label + label [data-link-input]');
    await insert('https://example.invalid/a(b)');
    await click('.chat-link-popover [data-action="confirm"]');
    await evaluate(`document.getElementById('chat-message-input').blur()`);
    await fixture('settle()');
    check(await evaluate(`(async () => {
      const {markdownMessageClipboard}=await import('/utils/messageClipboard.ts');
      const input=document.getElementById('chat-message-input');
      return markdownMessageClipboard(input.value).text === 'Label [detail]'
        && input.querySelector('.md-editor-link').textContent.replace(/[\\u200b\\ufeff]/g,'') === 'Label [detail]'
        && input.value.includes('/a%28b%29');
    })()`), 'Link labels and addresses with brackets render identically in the editor and sent message');
    await draft('one', 3, 3);
    await key('Enter', 'Enter', 13, 8);
    await key('Enter', 'Enter', 13, 8);
    await key('Enter', 'Enter', 13, 8);
    await insert('two');
    check((await fixture('state()')).value === 'one\n\n\ntwo', 'Native Shift+Enter preserves each authored blank line');
    const spacing = await evaluate(`(async () => {
      const {renderMarkdown}=await import('/utils/markdown.ts');
      const {markdownMessageClipboard}=await import('/utils/messageClipboard.ts');
      const value=document.getElementById('chat-message-input').value;
      const rendered=document.createElement('div'); rendered.className='chat-message-text'; rendered.innerHTML=renderMarkdown(value);
      document.body.appendChild(rendered);
      const lines=[...rendered.querySelectorAll('.md-blank-line')];
      const editorLines=[...document.querySelectorAll('#chat-message-input .cm-line')];
      const renderedGap=rendered.lastElementChild.getBoundingClientRect().top-rendered.firstElementChild.getBoundingClientRect().top;
      const editorGap=editorLines.at(-1).getBoundingClientRect().top-editorLines[0].getBoundingClientRect().top;
      const valid=lines.length===2 && lines.every(line=>line.getBoundingClientRect().height>=19)
        && Math.abs(renderedGap-editorGap)<1 && markdownMessageClipboard(value).text===value;
      rendered.remove(); return {valid,renderedGap,editorGap};
    })()`);
    check(spacing.valid, `Sent-message rendering and both clipboard representations preserve the same visible blank lines: ${JSON.stringify(spacing)}`);
    await draft('4. Four', 7, 7);
    await key('Enter', 'Enter', 13, 8);
    check((await fixture('state()')).value === '4. Four\n5. ', 'Native Shift+Enter continues the authored numbered list');
    result = await evaluate(`(async () => {
      const {renderMarkdown}=await import('/utils/markdown.ts');
      const {renderReplyPreview}=await import('/utils/messageReply.ts');
      const template=document.createElement('template');
      template.innerHTML=renderMarkdown('4. Four\\n5. Five');
      const preview=document.createElement('div');
      preview.innerHTML=renderReplyPreview({messageId:'fixture',userId:'fixture',userNickname:'Author',content:'**Reply**\\n\\n\`\`\`js\\nconst a = 1;\\n\`\`\`',createdAt:1});
      return {start:template.content.querySelector('ol').start,items:template.content.querySelectorAll('li').length,
        replyBold:preview.querySelector('strong:not(.chat-quote-heading strong)')?.textContent,
        replyCode:!!preview.querySelector('.hljs-keyword'), replyButtons:preview.querySelectorAll('button,a').length};
    })()`);
    check(result.start === 4 && result.items === 2, 'Published lists preserve the authored start number');
    check(result.replyBold === 'Reply' && result.replyCode && result.replyButtons === 0, 'Replies render emphasis and highlighted code without nested interactive controls');
    for (const start of [0, 2, 99]) {
      check(await evaluate(`(async () => {
        const {renderMarkdown}=await import('/utils/markdown.ts');
        const template=document.createElement('template'); template.innerHTML=renderMarkdown('${start}. Item\\n${start + 1}. Next');
        return template.content.querySelector('ol')?.start === ${start};
      })()`), `Published lists retain their explicit starting number ${start}`);
    }
    await draft('composition', 11, 11);
    const sentBeforeComposition = (await fixture('state()')).sent.length;
    await window.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 });
    await key('Enter', 'Enter', 13);
    check((await fixture('state()')).sent.length === sentBeforeComposition, 'Enter during native IME composition does not submit a message');
    await insert('漢');
    check((await fixture('state()')).value === 'composition漢', 'Native composition commits once without corrupting the Markdown document');
    await evaluate(`(() => { const input=document.getElementById('chat-message-input'); input.readOnly=true; })()`);
    await insert('blocked');
    check((await fixture('state()')).value === 'composition漢', 'Read-only Markdown input blocks native edits');
    await evaluate(`document.getElementById('chat-message-input').readOnly=false`);
    await draft('', 0, 0);
    await click('[data-format="bold"]');
    await window.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 });
    await insert('漢');
    check((await fixture('state()')).value === '**漢**', 'IME composition honors the active typing toggle without duplicate characters');
    await key('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
    check((await fixture('state()')).value === '', 'Undo removes one formatted IME composition without leaving markers');
    await draft('', 0, 0);
    await evaluate(`document.getElementById('chat-message-input').maxLength=5`);
    await insert('12345');
    await insert('6');
    check((await fixture('state()')).value === '12345', 'The editor enforces the configured character limit on native input');
    await evaluate(`document.getElementById('chat-message-input').removeAttribute('maxlength')`);
    await draft('<img src=x onerror=alert(1)>');
    check(await evaluate(`!document.getElementById('chat-message-input').querySelector('img')`), 'Live Markdown never interprets raw HTML as executable markup');
    check(await evaluate(`!document.querySelector('.chat-block-add-text')`), 'The redundant Add text buttons are absent');
    await key('Escape', 'Escape', 27);
    check(await evaluate(`document.getElementById('btn-format').getAttribute('aria-expanded')==='false'`), 'Escape collapses formatting before changing message-edit state');
    await draft(source, source.length, source.length);
    await click('#btn-format');
    await evaluate(`document.getElementById('chat-message-input').blur()`);
    await fixture('settle()');
    await evaluate(`Promise.all(document.querySelector('.chat-format-panel').getAnimations().map(animation => animation.finished))`);
    check(await evaluate(`(() => {
      const input=document.getElementById('chat-message-input');
      return getComputedStyle(input.querySelector('.cm-scroller')).fontFamily === getComputedStyle(input).fontFamily
        && getComputedStyle(input.querySelector('.md-editor-quote')).paddingLeft === '10px'
        && getComputedStyle(input.querySelector('.cm-content')).caretColor === getComputedStyle(input).color
        && getComputedStyle(input.querySelector('.cm-editor')).outlineStyle === 'none'
        && getComputedStyle(input.querySelector('.cm-content')).backgroundColor === 'rgba(0, 0, 0, 0)';
    })()`), 'Live preview retains the app font and quote indentation rather than CodeMirror defaults');
    await captureScreenshot(window, `markdown-composer-${locale}.png`);
    const [width, height] = window.getContentSize();
    window.setContentSize(450, height);
    await fixture('settle()');
    check(await evaluate(`(() => {
      const surface=document.querySelector('.chat-composer-surface');
      return surface.scrollWidth <= surface.clientWidth + 1;
    })()`), 'The composer and formatting toolbar fit a narrow window without horizontal overflow');
    await captureScreenshot(window, `markdown-composer-narrow-${locale}.png`);
    window.setContentSize(width, height);
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    check(await evaluate(`getComputedStyle(document.querySelector('.chat-format-panel')).transitionDuration === '0s'`),
      'Formatting panel respects reduced motion');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await fixture(`setReplyContent('2. First\\n3. Second\\n4. Third')`);
    check(await evaluate(`(() => {
      const list=document.querySelector('#chat-reply-composer .md-ol');
      return list?.start===2 && getComputedStyle(list).listStyleType==='decimal'
        && parseFloat(getComputedStyle(list).paddingLeft)>=20 && list.querySelectorAll('li').length===3;
    })()`), 'Reply previews preserve ordered-list numbers and their visible marker gutter');
    await captureScreenshot(window, `markdown-reply-list-${locale}.png`);
    await fixture(`setReplyContent('- First\\n- Second')`);
    check(await evaluate(`getComputedStyle(document.querySelector('#chat-reply-composer .md-ul')).listStyleType === 'disc'`),
      'Reply previews also render bullet markers');
    const codeMessage = 'Before\n\n```js\nconst answer = 42;\nconsole.log(answer);\n```\n\nAfter';
    await fixture(`beginCodeEdit(${JSON.stringify(codeMessage)})`);
    check((await fixture('state()')).editing && (await fixture('state()')).value === codeMessage,
      'Editing a message with code retains the entire original Markdown');
    check(await evaluate(`(() => {
      const input=document.getElementById('chat-message-input');
      const block=input.querySelector('.md-editor-code-widget');
      return block.querySelector('select').value==='javascript'
        && block.querySelector('textarea').value==='const answer = 42;\\nconsole.log(answer);'
        && block.querySelector('.md-code-lines').textContent==='1\\n2'
        && !block.textContent.includes('\`\`\`') && !!block.querySelector('.hljs-keyword');
    })()`), 'Existing code edits use the composition textarea, language dropdown and gutter without visible fences');
    for (const viewportWidth of [2000, 450]) {
      window.setContentSize(viewportWidth, height);
      await fixture('settle()');
      const layout = await evaluate(`(() => {
        const wrapper=document.querySelector('.chat-input-wrapper');
        const input=document.getElementById('chat-message-input');
        const content=input.querySelector('.cm-content').getBoundingClientRect();
        const code=input.querySelector('.md-editor-code-widget').getBoundingClientRect();
        const save=document.getElementById('btn-send-message').getBoundingClientRect();
        const counter=document.getElementById('chat-char-counter').getBoundingClientRect();
        return {
          codeWidth:code.width, availableWidth:content.width,
          rightGap:wrapper.getBoundingClientRect().right-save.right,
          padding:parseFloat(getComputedStyle(wrapper).paddingRight),
          counterBeforeSave:counter.right<=save.left && Math.abs(counter.top+counter.height/2-save.top-save.height/2)<2,
          controlsBelow:save.top>=input.getBoundingClientRect().bottom,
          overflow:wrapper.scrollWidth> wrapper.clientWidth+1
        };
      })()`);
      check(Math.abs(layout.codeWidth-layout.availableWidth)<2 && Math.abs(layout.rightGap-layout.padding)<2
        && layout.counterBeforeSave && layout.controlsBelow && !layout.overflow,
      `Code editing uses the full width and keeps Save/count at the bottom right (${viewportWidth}px): ${JSON.stringify(layout)}`);
      await captureScreenshot(window, `markdown-code-layout-${viewportWidth}-${locale}.png`);
    }
    window.setContentSize(width, height);
    await fixture('settle()');
    await captureScreenshot(window, `markdown-existing-code-edit-${locale}.png`);
    await evaluate(`(() => { const input=document.querySelector('.md-editor-code-widget textarea'); input.focus(); const end=input.value.indexOf('\\n'); input.setSelectionRange(end,end); })()`);
    await insert(' // edited');
    check((await fixture('state()')).value.includes('const answer = 42; // edited'),
      'The framed code remains directly editable through native typing');
    await key('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
    check((await fixture('state()')).value === codeMessage, 'Undo inside a code block restores its exact original source');
    await insert(' // edited');
    await evaluate(`(() => { const input=document.getElementById('chat-message-input');
      const from=input.value.indexOf('const answer'); input.setSelectionRange(from,from+'const answer = 42;'.length); })()`);
    await fixture('settle()');
    check(await evaluate(`document.activeElement instanceof HTMLTextAreaElement
      && document.activeElement.value.slice(document.activeElement.selectionStart,document.activeElement.selectionEnd)==='const answer = 42;'`),
      'Code selections use the same native textarea as composition');
    await captureScreenshot(window, `markdown-selected-code-${locale}.png`);
    await click('#btn-send-message');
    await fixture('replyEdit("a")');
    await fixture('settle()');
    check(!(await fixture('state()')).editing
      && (await fixture('state()')).message.includes('const answer = 42; // edited'),
      'Saving an existing code message preserves its edited code and surrounding text');
    for (const text of ['```js\n```', '```js\n\n```', '```js\nconst open = 1;', '```js\nconst a = 1;\n```\n\n```py\nprint(2)\n```\n\nAfter']) {
      await draft(text, 0, 0);
      await evaluate(`document.getElementById('chat-message-input').blur()`);
      await fixture('settle()');
      check(await evaluate(`(() => {
        const input=document.getElementById('chat-message-input');
        return input.value === ${JSON.stringify(text)} && !!input.querySelector('.md-editor-code-widget select')
          && [...input.querySelectorAll('.md-editor-code-widget')].every(line=>line.getBoundingClientRect().width<=input.clientWidth+1);
      })()`), 'Empty, unfinished and multiple code blocks retain source and bounded rendering');
    }
    await draft('', 0, 0);
    await insert('https://');
    check(await evaluate(`!document.querySelector('#chat-message-input .md-editor-link')`),
      'An incomplete URL stays plain text until it has a valid address');
    await insert('example.invalid?q=1&lang=pt');
    const automaticSource = 'https://example.invalid?q=1&lang=pt';
    check((await fixture('state()')).value === automaticSource && await evaluate(`document.querySelector('#chat-message-input .md-editor-link')?.textContent===${JSON.stringify(automaticSource)}`),
      'Typing a URL recognizes a link without rewriting the draft or moving its caret');
    await key('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
    check((await fixture('state()')).value === '' || (await fixture('state()')).value === 'https://',
      'Automatic recognition adds no extra undo transaction');
    const autoLinks = 'Veja **https://example.invalid/a(b)** e www.example.invalid.\n\n`https://code.invalid`\n\n```js\nhttps://block.invalid\n```\n\n[Manual](https://manual.invalid)';
    await draft(autoLinks, 0, 0);
    await evaluate(`document.getElementById('chat-message-input').blur()`);
    await fixture('settle()');
    check(await evaluate(`(async () => {
      const {renderMarkdown}=await import('/utils/markdown.ts');
      const input=document.getElementById('chat-message-input');
      const template=document.createElement('template');template.innerHTML=renderMarkdown(input.value);
      return input.value===${JSON.stringify(autoLinks)}
        && JSON.stringify([...input.querySelectorAll('.md-editor-link')].map(link=>link.textContent))===JSON.stringify(['https://example.invalid/a(b)','www.example.invalid','Manual'])
        && template.content.querySelectorAll('a').length===3
        && !!template.content.querySelector('strong > a')
        && !template.content.querySelector('code a');
    })()`), 'Automatic links preserve bold, manual links and code with the same rendering after sending');
    await captureScreenshot(window, `markdown-automatic-links-${locale}.png`);
    checks += await runEditorContextSmoke(window, locale);
    await fixture('deletedUndo(60000)');
    check(await evaluate(`!!document.querySelector('[data-restore-message-id="original"]')`), 'An acknowledged deletion offers a timed undo action');
    await fixture('setChannel("other")');
    await fixture('setChannel("chat")');
    check(await evaluate(`!!document.querySelector('[data-restore-message-id="original"]')`), 'Changing channels does not discard the server undo deadline');
    await click('[data-restore-message-id="original"]');
    check((await fixture('state()')).message === '\nOriginal line\nSecond line', 'Undo restores the original row after a channel round trip');
    await fixture('deletedUndo(400)');
    await evaluate(`new Promise(resolve=>setTimeout(resolve,700))`);
    check(await evaluate(`!document.querySelector('[data-restore-message-id="original"]')`), 'The undo control disappears when its time window ends');
  }
  return checks;
}

async function runEditorContextSmoke(window, locale) {
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const settle = () => evaluate('window.messageEditingFixture.settle()');
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  let checks = 0;
  const draft = async (text, from = 0, to = text.length) => {
    await evaluate(`(() => { const input=document.getElementById('chat-message-input');
      input.value=${JSON.stringify(text)};input.focus();input.setSelectionRange(${from},${to});
      input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await settle();
  };
  const click = async (selector, button = 'left') => {
    const point = await evaluate(`window.messageEditingFixture.point(${JSON.stringify(selector)})`);
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point });
    await settle();
  };
  const key = async (key, code, keyCode, modifiers = 0) => {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await settle();
  };
  const item = index => `.floating-context-menu button:nth-child(${index})`;
  const link = '#chat-message-input .md-editor-link';
  const context = async () => {
    const point = await evaluate(`(() => { const selection=window.getSelection();
      if(!selection?.rangeCount || selection.isCollapsed) return null;
      const rect=selection.getRangeAt(0).getBoundingClientRect();
      return rect.width?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:null; })()`);
    if (!point) return click('#chat-message-input .cm-content', 'right');
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mousePressed',button:'right',clickCount:1,...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseReleased',button:'right',clickCount:1,...point });
    await settle();
  };
  const value = () => evaluate(`document.getElementById('chat-message-input').value`);
  await evaluate(`(() => {
    const state=window.editorMenuTest={commands:[],copied:[],opened:[],oldApi:window.api,
      oldClipboard:Object.getOwnPropertyDescriptor(navigator,'clipboard')};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>state.copied.push(text)}});
    window.api={...window.api,
      editorCommand:async command=>{
        const active=document.activeElement;
        const input=active instanceof HTMLTextAreaElement?active:active.closest('monky-markdown-input');
        state.commands.push({command,from:input.selectionStart,to:input.selectionEnd,value:input.value,code:input instanceof HTMLTextAreaElement});
        return {success:!state.failCommand};
      },
      openExternal:async url=>{state.opened.push(url);return {success:true};}
    };
  })()`);
  try {
    await draft('', 0, 0);
    await context();
    check(await evaluate(`JSON.stringify([...document.querySelectorAll('.floating-context-menu button')].map(b=>b.disabled))==='[true,true,false,false,true]'`),
      'An empty editor disables Cut, Copy and Select all, but allows both paste modes');
    check(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(item(3))})`),
      'The menu focuses its first enabled action');
    await captureScreenshot(window, `editor-text-menu-${locale}.png`);
    await key('End', 'End', 35);
    check(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(item(4))})`),
      'Keyboard menu navigation skips disabled actions');
    await key('Escape', 'Escape', 27);
    check(await evaluate(`!document.querySelector('.floating-context-menu') && document.getElementById('chat-message-input').contains(document.activeElement)`),
      'Escape closes the menu and returns focus to the editor');
    await context();
    const outsideInputPoint = await evaluate(`(() => {const rect=document.querySelector('#chat-message-input .cm-content').getBoundingClientRect();
      return {x:rect.left+3,y:rect.top+rect.height/2};})()`);
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...outsideInputPoint});
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...outsideInputPoint});
    await settle();
    check(await evaluate(`!document.querySelector('.floating-context-menu') && document.getElementById('chat-message-input').contains(document.activeElement)`),
      'Clicking the editor outside its context menu dismisses the menu without swallowing the input click');
    for (const [index, command] of ['cut','copy','paste','pasteAndMatchStyle','selectAll'].entries()) {
      await draft('ABCDE', 1, 4);
      await context();
      await click(item(index+1));
      check(await evaluate(`(() => {const last=window.editorMenuTest.commands.at(-1);
        return last.command===${JSON.stringify(command)} && last.value==='ABCDE' && last.from===1 && last.to===4;})()`),
      `${command} restores the original input and selection before invoking the native editing command`);
      if (command === 'copy' || command === 'cut') {
        const toast = command === 'cut' ? (locale === 'en' ? 'Cut!' : 'Recortado!') : (locale === 'en' ? 'Copied!' : 'Copiado!');
        check(await evaluate(`document.querySelector('.chat-copy-toast-label')?.textContent===${JSON.stringify(toast)}`),
          `${command} shows localized toast feedback only after the native command is accepted`);
      }
      if (command === 'selectAll') {
        window.webContents.selectAll();
        await settle();
        check(await evaluate(`(() => {const input=document.getElementById('chat-message-input');return input.selectionStart===0 && input.selectionEnd===5;})()`),
          'The native Select all operation selects only the focused editor');
      }
    }
    await draft('ABCDE',1,4);
    await evaluate(`window.editorMenuTest.failCommand=true`);
    await context();
    await click(item(2));
    check(await evaluate(`!document.querySelector('.chat-copy-toast') && !!document.querySelector('.dialog-card')`),
      'A rejected native copy reports failure instead of displaying a success toast');
    await click('.dialog-card [data-action="confirm"]');
    await evaluate(`window.editorMenuTest.failCommand=false`);
    const original = 'Before [Monky](https://example.invalid/a) after';
    await draft(original, 0, 0);
    await click(link, 'right');
    check(await evaluate(`document.querySelectorAll('.floating-context-menu button').length===4`), 'A link opens its dedicated four-action menu');
    await captureScreenshot(window, `editor-link-menu-${locale}.png`);
    await click(item(1));
    check(await evaluate(`window.editorMenuTest.copied.at(-1)==='https://example.invalid/a'`) && await value()===original,
      'Copy link copies the address, not the label, without changing the message');
    check(await evaluate(`document.querySelector('.chat-copy-toast-label')?.textContent===${JSON.stringify(locale === 'en' ? 'Copied!' : 'Copiado!')}`),
      'Copy link also shows the localized copy toast');
    await click(link, 'right');
    await click(item(2));
    check(await evaluate(`window.editorMenuTest.opened.at(-1)==='https://example.invalid/a'`), 'Open link uses the existing external-browser bridge');
    await click(link, 'right');
    await click(item(3));
    check(await evaluate(`(() => { const inputs=[...document.querySelectorAll('[data-link-input]')];
      return inputs.length===2 && inputs[0].value==='Monky' && inputs[1].value==='https://example.invalid/a'
        && !document.querySelector('.chat-link-popover [aria-invalid="true"]'); })()`),
      'Edit link reuses the non-modal form with its label and address and no initial errors');
    await evaluate(`(() => {const inputs=document.querySelectorAll('[data-link-input]');
      inputs[0].value='Updated';inputs[1].value='other.invalid/path';})()`);
    await click('.chat-link-popover [type="submit"]');
    const edited = 'Before [Updated](https://other.invalid/path) after';
    check(await value()===edited, 'Editing changes only the clicked link and keeps surrounding text');
    await click(link, 'right');
    await click(item(3));
    await click('#chat-message-input .cm-content');
    check(await evaluate(`!document.querySelector('.chat-link-popover')`) && await value()===edited,
      'Clicking the message input closes the link dropup without changing the draft');
    await click(link, 'right');
    await click(item(4));
    check(await value()==='Before Updated after', 'Remove link keeps the display text');
    await key('z', 'KeyZ', 90, process.platform==='darwin'?4:2);
    check(await value()===edited, 'Undo restores the removed link in one transaction');
    for (const url of ['https://example.invalid/a(b)', 'www.example.invalid']) {
      await draft(url, 0, 0);
      await click(link, 'right');
      await click(item(4));
      check(await evaluate(`(async () => {
        const {renderMarkdown}=await import('/utils/markdown.ts');
        const input=document.getElementById('chat-message-input'); const node=document.createElement('div');node.innerHTML=renderMarkdown(input.value);
        return !input.querySelector('.md-editor-link') && !node.querySelector('a') && node.textContent===${JSON.stringify(url)}
          && input.querySelector('.cm-content').textContent.replace(/[\\u200b\\ufeff]/g,'')===${JSON.stringify(url)};
      })()`), 'Removing an automatic link keeps its visible URL without immediately relinking, including after sending');
      await key('z', 'KeyZ', 90, process.platform==='darwin'?4:2);
      check(await value()===url && await evaluate(`!!document.querySelector(${JSON.stringify(link)})`), 'Undo restores automatic link recognition');
    }
    await draft(original, 0, 0);
    await evaluate(`document.getElementById('chat-message-input').readOnly=true`);
    await click(link, 'right');
    check(await evaluate(`JSON.stringify([...document.querySelectorAll('.floating-context-menu button')].map(b=>b.disabled))==='[false,false,true,true]'`),
      'Read-only links allow opening and copying, not editing or removal');
    await key('Escape','Escape',27);
    await evaluate(`document.getElementById('chat-message-input').readOnly=false`);
    await draft('```js\nconst keep = 1;\n```',0,0);
    await evaluate(`(() => {const codeInput=document.querySelector('.md-editor-code-widget textarea');codeInput.focus();codeInput.select();})()`);
    await click('.md-editor-code-widget textarea','right');
    await click(item(2));
    check(await evaluate(`window.editorMenuTest.commands.at(-1).code===true && window.editorMenuTest.commands.at(-1).value==='const keep = 1;'`),
      'Code textareas use the text menu and keep native code selection semantics');
    await click('.md-editor-code-widget textarea','right');
    const codePoint = await evaluate(`(() => {const rect=document.querySelector('.md-editor-code-widget textarea').getBoundingClientRect();
      return {x:rect.left+3,y:rect.top+rect.height/2};})()`);
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...codePoint});
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...codePoint});
    await settle();
    check(await evaluate(`!document.querySelector('.floating-context-menu') && document.activeElement.matches('.md-editor-code-widget textarea')`),
      'Clicking a code textarea outside its context menu closes the menu and keeps the textarea editable');
    await evaluate(`window.messageEditingFixture.beginCodeEdit(${JSON.stringify(original)})`);
    await click(link,'right');
    await click(item(4));
    check(await value()==='Before Monky after', 'The same link menu also updates an existing message edit');
    await click('#btn-cancel-message-edit');
    await draft('ABCDE',1,4);
    await evaluate(`void (window.api.editorCommand=()=>new Promise(resolve=>{window.editorMenuTest.resolveCommand=resolve}))`);
    await context();
    await click(item(2));
    await evaluate(`window.messageEditingFixture.setChannel('other');window.editorMenuTest.resolveCommand({success:true})`);
    await settle();
    check(await evaluate(`!document.querySelector('.chat-copy-toast')`),
      'A native copy completed after changing channels cannot display a stale success toast');
    await evaluate(`window.messageEditingFixture.setChannel('chat')`);
    await draft(original,0,0);
    await click(link,'right');
    await click(item(3));
    await evaluate(`window.messageEditingFixture.setChannel('other')`);
    check(await evaluate(`!document.querySelector('.chat-link-popover, .floating-context-menu')`),
      'Changing channels closes context menus and pending link forms');
    await evaluate(`window.messageEditingFixture.setChannel('chat')`);
  } finally {
    await evaluate(`(() => {
      const state=window.editorMenuTest;window.api=state.oldApi;
      if(state.oldClipboard) Object.defineProperty(navigator,'clipboard',state.oldClipboard);else delete navigator.clipboard;
      delete window.editorMenuTest;
    })()`);
  }
  return checks;
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
  document.addEventListener('input', inputListener, true);
  document.addEventListener('keydown', keyListener, true);
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
      if (type === 'CHAT_RESTORE') queueMicrotask(() => session.client.handleIncomingMessage({
        type: 'CHAT_MESSAGE_UPDATED', requestId, payload: { message: { ...original, revision: payload.revision + 1, deletedAt: null } },
      }));
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
        readOnly: input.readOnly, focus: document.activeElement?.closest('monky-markdown-input')?.id ?? document.activeElement?.id,
        attachHidden: getComputedStyle(find('#btn-attach')).display === 'none',
        codeHidden: getComputedStyle(find('#btn-code')).display === 'none',
        codeDisabled: find('#btn-code').disabled,
        trayHidden: getComputedStyle(find('#chat-attachment-tray')).display === 'none',
        inlineEditors: root.querySelectorAll('.chat-message-editor').length,
        textareas: root.querySelectorAll('textarea, monky-markdown-input').length,
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
    async beginCodeEdit(content) {
      active.session.chatStore.updateMessage({ ...original, content });
      view.startEditingMessage(original.id);
      await settle();
    },
    async deletedUndo(duration) {
      const now = Date.now();
      active.session.serverStore.serverDetails.protocol = { version: 27, minimumVersion: 27, features: ['message-delete-undo'] };
      active.session.chatStore.updateMessage({ ...original, content: '', revision: now, deletedAt: now,
        deletedByUserId: user.id, deleteUndoUntil: now + duration });
      await settle();
    },
    async setReplyContent(content) {
      const updated = { ...reply, content };
      active.session.chatStore.updateMessage(updated);
      view.startReply(updated.id);
      await settle();
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
    async cleanup() {
      view?.destroy();
      selectEnhancer.dispose();
      offUpdate();
      offMessage();
      await sessionManager.removeAll();
      routing.setSessionEventRouter((_key, _event, emit) => emit());
      document.removeEventListener('input', inputListener, true);
      document.removeEventListener('keydown', keyListener, true);
      document.getElementById('fixture-other-control')?.remove();
      root.innerHTML = '';
    },
  };
}
