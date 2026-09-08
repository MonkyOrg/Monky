const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');
const output = path.join(clientRoot, 'dist-test');

if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true });
  const profile = path.join(output, `command-dom-profile-${process.pid}`);
  const env = { ...process.env, MONKY_COMMAND_DOM_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_COMMAND_DOM_PROFILE);
  let vite;
  let window;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'command-dom-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__command_dom_smoke__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const httpServer = vite.httpServer;
    if (!httpServer) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
    window = new BrowserWindow({
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('DOM smoke timed out'); void finish(1); }, 45_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__command_dom_smoke__`);
    window.webContents.focus();
    await window.webContents.executeJavaScript(`(${runDomSmoke.toString()})()`, true);
    fs.writeFileSync(path.join(output, 'command-dom-catalog.png'), (await window.webContents.capturePage()).toPNG());
    const result = await window.webContents.executeJavaScript('window.commandDomCaptureComposer()', true);
    fs.writeFileSync(path.join(output, 'command-dom-composer.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript('window.commandDomCleanup()', true);
    console.log(`Command DOM smoke: ${result.checks} checks passed`);
    console.log('Screenshots: dist-test\\command-dom-catalog.png and dist-test\\command-dom-composer.png');
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runDomSmoke() {
  const [{ ChatView }, chats, servers, networks, events, inputs, catalog, language, proxies, botEvents] = await Promise.all([
    import('/views/ChatView.ts'), import('/stores/chatStore.ts'), import('/stores/serverStore.ts'),
    import('/core/NetworkClient.ts'), import('/core/EventBus.ts'), import('/utils/botInputs.ts'),
    import('/utils/commandCatalog.ts'), import('/i18n/index.ts'), import('/core/activeProxy.ts'), import('/core/botChatEvents.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const find = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  const type = (element, value) => { element.focus(); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (element, value) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const option = (name) => {
    const row = [...document.querySelectorAll('[data-parameter-option]')].find((element) => element.querySelector('strong')?.textContent === name);
    if (!row) throw new Error(`Missing parameter choice ${name}`);
    return row;
  };
  language.setLanguage('pt-BR');
  localStorage.removeItem(catalog.COMMAND_USAGE_STORAGE_KEY);
  const caller = { id: 'alice', clientId: 'alice-client', nickname: 'Alice', status: 'ONLINE', joinedAt: 1 };
  const otherCaller = { ...caller, id: 'bob', clientId: 'bob-client', nickname: 'Bob' };
  const store = chats.createChatStore();
  const server = servers.createServerStore();
  const client = networks.createNetworkClient();
  const sent = [];
  client.getStatus = () => 'CONNECTED';
  client.send = (messageType, payload) => sent.push({ type: messageType, payload });
  chats.setActiveChatStore(store);
  servers.setActiveServerStore(server);
  networks.setActiveNetworkClient(client);
  const unbindBotEvents = botEvents.bindBotChatEvents();
  const refreshRegistry = (commands) => events.appEvents.emit('message.COMMANDS_LIST_RESPONSE', { commands });
  server.setServerDetails({
    id: 'command-dom-server', name: 'Command DOM', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: ['one', 'two'].map((id, position) => ({
      id, serverId: 'command-dom-server', name: id === 'one' ? 'general' : 'other', type: 'TEXT',
      position, createdAt: 1, isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
    })),
    members: [caller, otherCaller], knownMembers: [caller, otherCaller], roles: [], userRoles: [],
    myPermissions: 2147483647, ownerId: caller.id,
  }, caller);
  const command = {
    name: 'play', description: 'Choose a song with the full title', botId: 'music-one', botName: 'Monky Music',
    botAvatarUrl: '/assets/Logo.png',
    options: [
      { name: 'song', description: 'Full song title', type: 'string', required: true },
      { name: 'count', description: 'Repeat count', type: 'integer', required: true, min: 0, max: 10 },
      { name: 'private', description: 'Private playback', type: 'boolean' },
      { name: 'member', description: 'Member', type: 'user' },
      { name: 'mode', description: 'Playback mode', type: 'string', choices: [{ label: 'Ordered', value: 'ordered' }, { label: 'Shuffle', value: 'shuffle' }] },
    ],
  };
  const duplicate = { ...command, botId: 'music-two', botName: 'Second Music', botAvatarUrl: null };
  const ping = { ...command, name: 'ping', description: 'Check the bot', options: [] };
  refreshRegistry([command, duplicate, ping]);
  const container = find('#app');
  container.style.cssText = 'height:calc(100vh - 24px);width:calc(100vw - 24px);margin:12px auto;display:flex;flex-direction:column;flex:none;';
  const view = new ChatView(container);
  view.setChannel('one');
  await document.fonts.ready;
  await frame();
  const allowedChannel = { ...server.getChannel('one') };
  type(find('#chat-message-input'), '/');
  server.updateChannel({ ...allowedChannel, botCommandsEnabled: false });
  check(find('#command-dropup').textContent.includes('não são permitidos neste canal'), 'Channel switch must immediately replace an open slash menu with a localized notice');
  check(document.querySelectorAll('[data-cmd-index]').length === 0, 'Disabled channels must not expose selectable commands, even for admins');
  const deniedSent = sent.length;
  type(find('#chat-message-input'), '/ping');
  key(find('#chat-message-input'), 'Enter');
  check(sent.length === deniedSent && !store.getCommandDraft('one'), 'Disabled channel must prevent command execution');
  language.setLanguage('en');
  type(find('#chat-message-input'), '/');
  check(find('#command-dropup').textContent.includes('not allowed in this text channel'), 'Channel denial must be localized in English');
  server.updateChannel(allowedChannel);
  server.myPermissions = 1 << 8;
  events.appEvents.emit('server.roles_updated');
  check(find('#command-dropup').textContent.includes('do not have permission'), 'Role revocation must immediately refresh an open slash menu');
  check(!find('#chat-message-input').readOnly, 'Bot permission denial must not block ordinary chat');
  server.myPermissions = 2147483647;
  events.appEvents.emit('server.roles_updated');
  check(document.querySelectorAll('[data-cmd-index]').length > 0, 'Granting bot permission must restore commands');
  language.setLanguage('pt-BR');
  type(find('#chat-message-input'), '');
  const [{ CreateChannelModal }, { EditChannelModal }, { ServerRolesTab }] = await Promise.all([
    import('/views/CreateChannelModal.ts'), import('/views/EditChannelModal.ts'),
    import('/views/serverSettings/tabs/ServerRolesTab.ts'),
  ]);
  const createChannel = new CreateChannelModal();
  const editChannel = new EditChannelModal();
  const channelRequests = [];
  const originalSendRequest = client.sendRequest;
  client.sendRequest = async (messageType, payload) => { channelRequests.push({ type: messageType, payload }); return {}; };
  try {
    createChannel.open('TEXT');
    check(find('#input-channel-bot-commands').checked, 'New text channels must enable bots by default');
    check(!!find('#input-channel-bot-commands').closest('.toggle-switch'), 'Channel bot setting must use the established toggle switch');
    find('#input-channel-bot-commands').checked = false;
    find('input[name="channel-type"][value="VOICE"]').click();
    check(find('#channel-bot-commands-group').hidden, 'Voice channels must hide the text-only bot setting');
    find('input[name="channel-type"][value="TEXT"]').click();
    check(!find('#channel-bot-commands-group').hidden && !find('#input-channel-bot-commands').checked, 'Switching channel type must preserve the chosen bot setting');
    type(find('#input-channel-name'), 'channel-test');
    find('#form-create-channel').requestSubmit();
    await frame();
    check(channelRequests.at(-1)?.payload.botCommandsEnabled === false, 'Channel creation must send an explicit disabled switch');
    check(channelRequests.at(-1)?.payload.maxParticipants === undefined, 'Bot settings must not overwrite the channel participant default');
    server.updateChannel({ ...allowedChannel, botCommandsEnabled: false });
    editChannel.open('one');
    check(!find('#input-channel-bot-commands').checked, 'Channel edit must load the persisted bot switch');
    find('#form-edit-channel').requestSubmit();
    await frame();
    check(channelRequests.at(-1)?.type === 'CHANNEL_UPDATE' && channelRequests.at(-1)?.payload.botCommandsEnabled === false, 'Editing a disabled channel must preserve its bot setting');
    createChannel.open('VOICE');
    check(find('#channel-bot-commands-group').hidden, 'Voice creation must initially hide bot controls');
    type(find('#input-channel-name'), 'voice-test');
    find('#form-create-channel').requestSubmit();
    await frame();
    check(channelRequests.at(-1)?.payload.botCommandsEnabled === undefined, 'Voice creation must leave bot defaults untouched');
    const rolesMarkup = document.createElement('div');
    rolesMarkup.innerHTML = new ServerRolesTab().renderHtml();
    check(!!rolesMarkup.querySelector('.role-permission-switch[data-permission="8192"]'), 'Role editor must expose MANAGE_BOTS as a switch');
    check(!!rolesMarkup.querySelector('.role-permission-switch[data-permission="16384"]'), 'Role editor must expose USE_BOT_COMMANDS as a switch');
  } finally {
    createChannel.close();
    editChannel.close();
    client.sendRequest = originalSendRequest;
    server.updateChannel(allowedChannel);
  }
  const exactPing = { ...ping, botId: 'zeta', botName: 'Zeta Bot' };
  const botNameMatch = { ...ping, name: 'start', botId: 'ping-bot', botName: 'Ping Bot' };
  refreshRegistry([exactPing, botNameMatch]);
  for (const selectKey of ['Enter', 'Tab']) {
    type(find('#chat-message-input'), '/ping');
    key(find('#chat-message-input'), selectKey);
    check(store.getCommandDraft('one')?.command.botId === exactPing.botId,
      `${selectKey} must prefer a unique exact command over an unrelated bot-name match`);
    check(sent.at(-1)?.type === 'COMMAND_INVOKE' && sent.at(-1)?.payload.botId === exactPing.botId,
      `${selectKey} must immediately invoke the exact no-argument command`);
    store.setCommandPending('one', store.getCommandDraft('one'), false);
    find('[data-bot-action="cancel-command"]').click();
  }
  type(find('#chat-message-input'), '/ping');
  key(find('#chat-message-input'), 'ArrowDown');
  refreshRegistry([exactPing, botNameMatch]);
  check(find('.command-row.active strong').textContent === '/start', 'Refresh must preserve deliberate keyboard navigation');
  key(find('#chat-message-input'), 'Enter');
  check(store.getCommandDraft('one')?.command.name === 'start', 'Explicit navigation must still select another matching command');
  check(sent.at(-1)?.payload.commandName === 'start', 'Explicit selection must invoke the no-argument command');
  store.setCommandPending('one', store.getCommandDraft('one'), false);
  find('[data-bot-action="cancel-command"]').click();
  sent.length = 0;
  refreshRegistry([command, duplicate, ping]);
  type(find('#chat-message-input'), '/');
  const normalInputHeight = find('#chat-message-input').clientHeight;
  refreshRegistry([command, duplicate, ping, ...Array.from({ length: 20 }, (_, index) => ({
    ...command, name: `extra-${index}`,
  }))]);
  const catalogScroll = find('.command-picker-scroll');
  check(catalogScroll.scrollHeight > catalogScroll.clientHeight, 'Long catalogs must have an internal scroll range');
  check(catalogScroll.getBoundingClientRect().bottom <= find('.command-picker').getBoundingClientRect().bottom + 1,
    'Long command lists must remain inside their panel instead of covering the chat input');
  catalogScroll.scrollTop = catalogScroll.scrollHeight;
  await frame();
  check(catalogScroll.scrollTop > 0, 'The last commands must be reachable by scrolling');
  refreshRegistry([command, duplicate, ping]);
  check(document.querySelectorAll('[data-command-group]').length === 3, 'Expected frequent and two bot groups');
  check(find('#command-dropup').getBoundingClientRect().width > 900, 'Command dropup should span composer width');
  check(find('#command-dropup').getBoundingClientRect().top >= 0, 'Command dropup must stay inside the viewport');
  check(find('.command-empty-frequency').textContent.includes('executar'), 'Empty frequency must not fabricate usage');
  check(getComputedStyle(find('.command-row.active .command-row-arguments')).display !== 'none', 'Active row must reveal parameter chips');
  find('[data-command-section="bot:music-two"] [data-cmd-index]').click();
  check(store.getCommandDraft('one').command.botId === 'music-two', 'Duplicate command must target selected bot');
  check(sent.every((entry) => entry.type !== 'COMMAND_INVOKE'), 'Selecting must never invoke');
  check(find('#chat-command-composer').getBoundingClientRect().height < 180, 'Composer must be compact');
  check(find('#chat-command-composer').getBoundingClientRect().bottom <= innerHeight, 'Composer must remain inside the viewport');
  check(document.querySelectorAll('#chat-command-composer [data-field-name]').length === 2, 'Only required arguments start visible');
  type(find('#chat-command-composer [data-field-name="song"] [data-bot-input]'), 'A song with spaces and, commas');
  key(find('#chat-command-composer [data-field-name="song"] [data-bot-input]'), 'Enter');
  check(sent.every((entry) => entry.type !== 'COMMAND_INVOKE'), 'Invalid required inputs must not execute');
  type(find('#chat-command-composer [data-field-name="count"] [data-bot-input]'), '0');
  find('[data-bot-action="optional-parameters"]').click();
  key(find('[data-bot-action="optional-parameters"]'), 'Enter');
  const toggle = find('#chat-command-composer [data-field-name="private"] input');
  check(toggle.type === 'checkbox' && getComputedStyle(toggle).opacity === '0', 'Boolean must use hidden native control');
  check(find('#chat-command-composer .toggle-slider').getBoundingClientRect().width > 0, 'Custom switch must be visible');
  toggle.click();
  toggle.click();
  find('[data-remove-parameter="private"]').click();
  check(store.getCommandDraft('one').values.private === false, 'Removing an optional field must preserve false');
  check(!document.querySelector('#chat-command-composer [data-field-name="private"]'), 'Removed parameter must be hidden');
  find('[data-bot-action="optional-parameters"]').click();
  option('private').click();
  check(find('#chat-command-composer [data-field-name="private"] input').checked === false, 'Revealing must restore optional draft');
  find('[data-bot-action="optional-parameters"]').click();
  option('mode').click();
  check(!find('#bot-parameter-options').hidden, 'Focusing choices must open anchored list');
  key(find('[data-bot-choice="mode"]'), 'ArrowDown');
  key(find('[data-bot-choice="mode"]'), 'Enter');
  check(store.getCommandDraft('one').values.mode === 'shuffle', 'Choice must keep declared value, not label');
  check(find('#bot-parameter-options').hidden, 'Choosing an option must close its list');
  const typing = find('#chat-command-composer [data-field-name="song"] [data-bot-input]');
  typing.focus();
  typing.setSelectionRange(4, 12, 'backward');
  const optionalNames = JSON.stringify(store.getCommandDraft('one').visibleOptionalNames);
  refreshRegistry([{ ...command, botName: 'Unrelated profile update' }, structuredClone(duplicate), ping]);
  check(document.activeElement === typing, 'Unrelated registry refresh must retain the focused argument control');
  check(typing.selectionStart === 4 && typing.selectionEnd === 12 && typing.selectionDirection === 'backward', 'Registry refresh must preserve caret and selection direction');
  refreshRegistry([command, { ...duplicate, botName: 'Selected profile update' }, ping]);
  const renamedInput = find('#chat-command-composer [data-field-name="song"] [data-bot-input]');
  check(document.activeElement === renamedInput && renamedInput.selectionStart === 4 && renamedInput.selectionEnd === 12 &&
    renamedInput.selectionDirection === 'backward', 'Selected bot profile refresh must restore focus and selection');
  const thirdMember = { ...otherCaller, id: 'charlie', clientId: 'charlie-client', nickname: 'Charlie' };
  server.addMember(thirdMember);
  server.addMember({ ...thirdMember, id: command.botId, clientId: 'bot-client', nickname: command.botName, isBot: true });
  const memberRefreshInput = find('#chat-command-composer [data-field-name="song"] [data-bot-input]');
  check(document.activeElement === memberRefreshInput && memberRefreshInput.selectionStart === 4 &&
    memberRefreshInput.selectionEnd === 12 && memberRefreshInput.selectionDirection === 'backward', 'Member refresh must retain active text input and caret');
  check(JSON.stringify(store.getCommandDraft('one').visibleOptionalNames) === optionalNames &&
    store.getCommandDraft('one').values.mode === 'shuffle', 'Refreshes must retain revealed optional parameters and values');
  refreshRegistry([command, duplicate, ping]);
  find('[data-bot-action="optional-parameters"]').click();
  option('member').click();
  check(!!option(caller.nickname), 'Bot member choices must include the caller');
  check(![...document.querySelectorAll('#bot-parameter-options [data-parameter-option] strong')].some((label) =>
    label.textContent === command.botName), 'Bot accounts must not be offered as user arguments');
  const browsedMember = option('Charlie');
  browsedMember.focus();
  browsedMember.dispatchEvent(new MouseEvent('mouseenter'));
  server.updateMember({ ...thirdMember, nickname: 'Aaron' });
  check(!find('#bot-parameter-options').hidden, 'Member refresh must retain an open member choice menu');
  check(document.activeElement === option('Aaron') && option('Aaron').getAttribute('aria-selected') === 'true',
    'Member choice focus must follow the stable user ID when names reorder');
  option('Bob').click();
  check(store.getCommandDraft('one').values.member === 'bob', 'Member choice must retain user ID');
  store.setCommandValues('one', { ...store.getCommandDraft('one').values, member: command.botId });
  find('#chat-command-composer button[type="submit"]').click();
  check(sent.every((entry) => entry.type !== 'COMMAND_INVOKE'), 'Bot user IDs must fail local validation even if inserted into the draft');
  find('[data-bot-choice="member"]').click();
  option(caller.nickname).click();
  find('#chat-command-composer button[type="submit"]').click();
  check(sent.some((entry) => entry.type === 'COMMAND_INVOKE' && entry.payload.options.member === caller.id), 'Self-targeting must pass command validation and send the caller ID');
  const selfDraft = store.getCommandDraft('one');
  store.setCommandPending('one', selfDraft, false);
  key(find('#chat-command-composer [data-field-name="song"] [data-bot-input]'), 'Escape');
  check(!store.getCommandDraft('one'), 'Escape must cancel selected command');
  check(getComputedStyle(find('.chat-input-wrapper')).display !== 'none', 'Normal composer must return after cancel');
  check(find('#chat-message-input').clientHeight >= normalInputHeight, 'Restored normal input must retain a usable line height');
  check(['#btn-attach', '#btn-code', '#btn-emoji'].every((selector) => !find(selector).disabled), 'Ordinary media/code controls must remain usable');
  type(find('#chat-message-input'), 'Ordinary draft stays here');
  view.setChannel('two');
  view.setChannel('one');
  check(find('#chat-message-input').value === 'Ordinary draft stays here', 'Channel switches must retain ordinary drafts');
  type(find('#chat-message-input'), '/ping');
  key(find('#chat-message-input'), 'Tab');
  check(sent.filter((entry) => entry.type === 'COMMAND_INVOKE').length === 2, 'No-argument Tab selection must execute immediately');
  find('#chat-command-composer button[type="submit"]').click();
  find('#chat-command-composer form').requestSubmit();
  check(sent.filter((entry) => entry.type === 'COMMAND_INVOKE').length === 2, 'Pending invocation must reject duplicate submit');
  const invocation = { invocationId: 'dom-invocation', channelId: 'one', botId: command.botId, commandName: 'ping' };
  store.acknowledgeCommand(invocation);
  store.clearCommand('one');
  store.receivePrompt({
    ...invocation, interactionId: 'form', botName: command.botName, botAvatarUrl: command.botAvatarUrl,
    expiresAt: Date.now() + 60_000,
    form: { title: 'Private follow-up', fields: [
      { name: 'question', label: 'Question', type: 'text', required: true },
      { name: 'options', label: 'Options', type: 'string-list', required: true, minItems: 2, maxItems: 5 },
    ] },
  });
  type(find('.bot-inline-form [data-field-name="question"] [data-bot-input]'), 'Preserve the private form');
  const list = [...document.querySelectorAll('.bot-inline-form [data-field-name="options"] [data-bot-input]')];
  type(list[0], 'First option');
  type(list[1], 'Second option');
  find('.bot-inline-form [data-field-action="add"]').click();
  type(find('.bot-inline-form [data-list-index="2"][data-bot-input]'), 'Third option');
  store.setHistory('one', []);
  view.setChannel('two');
  view.setChannel('one');
  check(find('.bot-inline-form [data-field-name="question"] [data-bot-input]').value === 'Preserve the private form', 'History/channel rebuilds must retain form answers');
  check(document.querySelectorAll('.bot-inline-form [data-field-name="options"] [data-bot-input]').length === 3, 'Dynamic rows must survive rebuilds');
  server.updateChannel({ ...allowedChannel, botCommandsEnabled: false });
  check(find('.bot-inline-form button[type="submit"]').disabled, 'Channel disable must immediately disable an existing form, even for admins');
  const beforeDeniedForm = sent.length;
  find('.bot-inline-form').requestSubmit();
  check(sent.length === beforeDeniedForm, 'A forged DOM submit must not bypass the channel switch');
  server.updateChannel(allowedChannel);
  server.myPermissions = 1 << 8;
  events.appEvents.emit('server.roles_updated');
  check(find('.bot-inline-form button[type="submit"]').disabled, 'Role revocation must disable an existing form');
  server.myPermissions = 2147483647;
  events.appEvents.emit('server.roles_updated');
  check(!find('.bot-inline-form button[type="submit"]').disabled, 'Restored access must restore form editing');
  find('.bot-inline-form button[type="submit"]').click();
  store.failFormSubmit(invocation.invocationId, 'form', 'Retry this form');
  check(find('.bot-inline-form .bot-error').textContent === 'Retry this form', 'Failed form must stay visible with its error');
  find('.bot-inline-form button[type="submit"]').click();
  store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId: 'form', values: { question: 'Preserve the private form' } });
  check(!document.querySelector('[data-interaction-id="form"]'), 'Acknowledged form must disappear');
  const selectorForm = (presentation) => ({
    title: 'Choose a next step',
    fields: [{ name: 'choice', label: 'Choose', type: 'select', required: true, presentation,
      choices: [{ label: 'First', value: 'first' }, { label: 'Second', value: 'second' }] }],
  });
  store.receivePrompt({
    ...invocation, interactionId: 'buttons', botName: command.botName, expiresAt: Date.now() + 60_000,
    form: selectorForm('buttons'),
  });
  const beforeButtons = sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length;
  find('[data-bot-select-value="second"]').click();
  check(sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length === beforeButtons + 1,
    'Choice button must submit immediately');
  check(sent.at(-1).payload.values.choice === 'second', 'Choice button must preserve its option value');
  store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId: 'buttons', values: { choice: 'second' } });
  store.receivePrompt({
    ...invocation, interactionId: 'dropdown', botName: command.botName, expiresAt: Date.now() + 60_000,
    form: selectorForm('dropdown'),
  });
  const beforeDropdown = sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length;
  type(find('[data-interaction-id="dropdown"] select'), 'first');
  check(sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length === beforeDropdown,
    'Dropdown must wait for confirmation');
  find('[data-interaction-id="dropdown"] button[type="submit"]').click();
  check(sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length === beforeDropdown + 1,
    'Dropdown confirmation must submit the selected value');
  store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId: 'dropdown', values: { choice: 'first' } });
  check(!document.querySelector('.bot-inline-form'), 'All completed selectors must disappear');
  const background = chats.createChatStore();
  background.bus = proxies.silentBus;
  background.receivePrompt({
    ...invocation, invocationId: 'background', interactionId: 'secret', botName: 'Background bot', expiresAt: Date.now() + 60_000,
    form: { title: 'BACKGROUND ONLY', fields: [{ name: 'value', label: 'Value', type: 'text' }] },
  });
  check(!container.textContent.includes('BACKGROUND ONLY'), 'Background forms must not repaint foreground');
  store.finishInvocation({ ...invocation, reason: 'completed' });
  check([...document.querySelectorAll('.bot-inline-form [data-bot-input]')].every((input) => input.disabled), 'Finished forms must be disabled');
  store.addMessage(inputs.botCommandMessage({
    ...invocation, messageId: 'attributed', content: 'The command finished successfully.', createdAt: Date.now(),
    botName: command.botName, botAvatarUrl: command.botAvatarUrl, ephemeral: true,
    invokerId: otherCaller.id, invokerNickname: otherCaller.nickname, invokerAvatarUrl: null,
  }));
  check(find('.bot-response-context').textContent.includes('Bob usou /ping'), 'Response context must use authoritative caller');
  check(find('.bot-response-bubble .chat-author-name').textContent === command.botName, 'Bot identity must remain separate from caller');
  check(find('.bot-response-bubble .bot-private-cue').textContent.includes('você'), 'Private response must retain its badge');
  check(getComputedStyle(find('.bot-response-bubble')).borderLeftWidth === '3px', 'Bot response must have accented card');
  type(find('#chat-message-input'), '/');
  const usageBeforeOffline = JSON.stringify(store.getCommandUsage());
  refreshRegistry([duplicate]);
  check(!document.querySelector('[data-command-section="frequent"] .command-row'), 'Unavailable bot commands must be hidden from frequency');
  refreshRegistry([]);
  check(JSON.stringify(store.getCommandUsage()) === usageBeforeOffline, 'An empty registry snapshot must not erase frequency');
  refreshRegistry([command, duplicate, ping]);
  check(find('[data-command-section="frequent"] .command-row-title').textContent.includes('/ping'), 'ACKed usage must appear in frequent section');
  const persisted = localStorage.getItem(catalog.COMMAND_USAGE_STORAGE_KEY) ?? '';
  check(!persisted.includes('song with spaces') && !persisted.includes('Preserve the private form'), 'Frequency storage must never contain arguments');
  check(JSON.parse(persisted).every((entry) => entry.serverId === server.serverDetails.id && entry.callerId === caller.id), 'Frequency must use the authenticated local identity, not a response caller');
  await frame();
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(getComputedStyle(find('#command-dropup')).display !== 'none', 'Refocusing the composer must not leave a stale blur timer closing discovery');
  key(find('#chat-message-input'), 'ArrowDown');
  key(find('#chat-message-input'), 'ArrowDown');
  check(find('.command-row[aria-selected="true"] .command-row-arguments').textContent.includes('song'), 'Active command should reveal required parameter chips');
  await frame();
  window.commandDomCaptureComposer = async () => {
    key(find('#chat-message-input'), 'Escape');
    store.selectCommand('one', command, 'A song with multiple words');
    store.setCommandValues('one', { song: 'A song with multiple words', count: '0', private: false, mode: 'shuffle' });
    store.setCommandOptionVisible('one', 'private', true);
    store.setCommandOptionVisible('one', 'mode', true);
    await frame();
    check(find('.bot-response-bubble').getBoundingClientRect().bottom <= find('#chat-messages-feed').getBoundingClientRect().bottom, 'Selecting a command must keep the latest pinned reply in view');
    return { checks };
  };
  const { PublicSelectorView } = await import('/views/PublicSelectorView.ts');
  const selectorFeed = document.createElement('div');
  document.body.append(selectorFeed);
  const selectorRow = () => {
    selectorFeed.innerHTML = '<div data-message-id="public-question"><div class="chat-message-body"><div class="chat-message-text">Question</div></div></div>';
  };
  selectorRow();
  const selectorClient = networks.createNetworkClient();
  selectorClient.sessionKey = 'selector-dom';
  selectorClient.getStatus = () => 'CONNECTED';
  let publicSnapshot = {
    id: 'public-selector', botId: 'music-one', channelId: 'one', messageId: 'public-question',
    title: 'Question <script>not HTML</script>', choices: [{ label: 'A <img>', value: 'a' }, { label: 'B', value: 'b' }],
    presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 2,
    createdAt: 1, closedAt: null, resultMessageId: null, counts: { a: 0, b: 0 }, responseCount: 0, canRespond: true,
  };
  const publicRequests = [];
  selectorClient.sendRequest = async (messageType, payload) => {
    publicRequests.push({ type: messageType, payload });
    if (messageType === 'SELECTOR_LIST') return { selectors: [publicSnapshot] };
    publicSnapshot = { ...publicSnapshot, ownResponse: payload.value, counts: { a: payload.value === 'a' ? 1 : 0, b: payload.value === 'b' ? 1 : 0 }, responseCount: 1 };
    return publicSnapshot;
  };
  const publicView = new PublicSelectorView(selectorFeed, selectorClient, server, 'one');
  await frame();
  check(selectorFeed.querySelectorAll('[data-selector-value]').length === 2, 'Persisted public selectors must restore buttons from server list');
  check(!selectorFeed.querySelector('img,script'), 'Public selector labels and question must be text, never executable HTML');
  selectorFeed.querySelector('[data-selector-value="b"]').click();
  await frame();
  check(publicRequests.filter((request) => request.type === 'SELECTOR_RESPOND').length === 1, 'Public option buttons must submit immediately');
  check(selectorFeed.querySelector('[data-selector-value="b"]').getAttribute('aria-pressed') === 'true', 'Public response ACK must show the selected option');
  publicSnapshot = { ...publicSnapshot, presentation: 'dropdown' };
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', publicSnapshot);
  const dropdown = selectorFeed.querySelector('select');
  dropdown.value = 'a';
  dropdown.dispatchEvent(new Event('change', { bubbles: true }));
  check(publicRequests.filter((request) => request.type === 'SELECTOR_RESPOND').length === 1, 'Public dropdown selection must wait for Confirm');
  selectorFeed.querySelector('[data-selector-confirm]').click();
  await frame();
  check(publicRequests.filter((request) => request.type === 'SELECTOR_RESPOND').length === 2, 'Confirm must submit a public dropdown once');
  selectorRow();
  await frame();
  check(!!selectorFeed.querySelector('select'), 'History rerenders must restore public selector controls');
  server.updateChannel({ ...server.getChannel('one'), botCommandsEnabled: false });
  check(selectorFeed.querySelector('select').disabled, 'Disabled channels must block public selector responses for admins too');
  server.updateChannel({ ...server.getChannel('one'), botCommandsEnabled: true });
  publicSnapshot = { ...publicSnapshot, closedAt: Date.now(), canRespond: false };
  language.setLanguage('pt-BR');
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', publicSnapshot);
  check(selectorFeed.querySelector('[data-selector-confirm]').disabled, 'Closed selectors must disable voting');
  check(selectorFeed.querySelector('.bot-status').textContent === 'Encerrado', 'Public selectors must use the Portuguese central catalog');
  language.setLanguage('en');
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', publicSnapshot);
  check(selectorFeed.querySelector('.bot-status').textContent === 'Closed', 'Public selectors must use the English central catalog');
  publicView.destroy();
  const requestsBeforeDestroy = publicRequests.length;
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', { ...publicSnapshot, closedAt: null, canRespond: true });
  check(publicRequests.length === requestsBeforeDestroy, 'Destroyed public selector views must not send further requests');
  selectorClient.dispose();
  selectorFeed.remove();
  window.commandDomCleanup = () => { view.destroy(); unbindBotEvents(); client.dispose(); };
  return { checks };
}
