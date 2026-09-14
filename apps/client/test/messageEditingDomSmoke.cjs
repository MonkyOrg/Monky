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

async function runNativeSmoke(window) {
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  const fixture = source => evaluate(`window.messageEditingFixture.${source}`);
  const state = () => fixture('state()');
  let checks = 0;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks++;
  };
  const key = async (key, code, virtualKey, text, modifiers = 0) => {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
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
      fs.writeFileSync(path.join(output, `message-editing-${locale}.png`), (await window.webContents.capturePage()).toPNG());
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
    return checks;
  } catch (error) {
    console.error(`Native edit attempt ${editAttempt}: ${JSON.stringify(await state())}`);
    fs.writeFileSync(path.join(output, 'message-editing-failure.png'), (await window.webContents.capturePage()).toPNG());
    throw error;
  } finally {
    await fixture('cleanup()');
  }
}

async function installFixture() {
  const [{ ChatView }, { sessionManager }, chats, { appEvents }, routing, language] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/stores/chatStore.ts'),
    import('/core/EventBus.ts'), import('/core/sessionRouting.ts'), import('/i18n/index.ts'),
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
  const offUpdate = appEvents.on('message.CHAT_MESSAGE_UPDATED', payload => chats.chatStore.updateMessage(payload.message));
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
    const state = { name, session, status: 'CONNECTED', epoch: 1, edits: [], sent: [], commands: [] };
    session.serverStore.setServerDetails(details(name), user);
    session.client.getStatus = () => state.status;
    session.client.getConnectionId = () => `${name}-${state.epoch}`;
    session.client.getCurrentServerUrl = () => session.key;
    session.client.send = (type, payload, requestId) => {
      if (type === 'CHAT_EDIT') state.edits.push({ payload, requestId, completed: false });
      if (type === 'CHAT_SEND') state.sent.push(payload);
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
    session.client.sendRequest = (type, ...args) => type === 'SELECTOR_LIST' ? Promise.resolve({ selectors: [] }) : request(type, ...args);
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
      offUpdate();
      sessionManager.removeAll();
      routing.setSessionEventRouter((_key, _event, emit) => emit());
      document.removeEventListener('input', inputListener);
      document.removeEventListener('keydown', keyListener);
      document.getElementById('fixture-other-control')?.remove();
      root.innerHTML = '';
    },
  };
}
