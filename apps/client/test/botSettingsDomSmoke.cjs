async function runBotSettingsDomSmoke() {
  const [modalModule, servers, networks, chats, { settingsStore }, { appEvents }, { botPreferenceScopeFor },
    { userContextMenu }, { contextMenu }, { SoundboardTab }, language, { BotChatView, renderBotInvocation }] = await Promise.all([
    import('/views/BotSettingsModal.ts'), import('/stores/serverStore.ts'),
    import('/core/NetworkClient.ts'), import('/stores/chatStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/EventBus.ts'), import('/utils/botSettingsContext.ts'), import('/views/UserContextMenu.ts'),
    import('/views/ContextMenu.ts'), import('/views/settings/tabs/SoundboardTab.ts'), import('/i18n/index.ts'),
    import('/views/BotChatView.ts'),
  ]);
  const Permission = { CONFIGURE_BOTS: 1 << 15, MANAGE_BOTS: 1 << 13 };
  const MessageType = {
    BOT_SETTINGS_LIST: 'BOT_SETTINGS_LIST', BOT_SETTINGS_GET: 'BOT_SETTINGS_GET', BOT_SETTINGS_UPDATE: 'BOT_SETTINGS_UPDATE',
  };
  const { botSettingsModal: modal, botSettingsMenuItem } = modalModule;
  const previous = {
    client: networks.getActiveNetworkClient(), server: servers.getActiveServerStore(), chat: chats.getActiveChatStore(),
    exceptions: settingsStore.botDownloadConfirmationExceptions, preferences: settingsStore.botUserPreferences,
    stored: localStorage.getItem('monky_settings'), language: language.getLanguage(),
  };
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected),
    message + ': ' + JSON.stringify(actual));
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing settings control ' + selector + ': ' + document.body.innerText.slice(-600));
    return element;
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Settings fixture did not settle: ' + document.body.innerText.slice(-800));
  };
  const type = (selector, value) => {
    const input = find(selector);
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toggle = (selector, value) => {
    const input = find(selector);
    input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const submit = async () => {
    find('#bot-settings-form').requestSubmit();
    await tick();
  };
  const server = servers.createServerStore();
  const client = networks.createNetworkClient();
  const chat = chats.createChatStore();
  let connectionId = 1;
  client.getConnectionId = () => connectionId;
  client.getStatus = () => 'CONNECTED';
  client.getCurrentServerUrl = () => 'wss://settings.example/';
  networks.setActiveNetworkClient(client);
  servers.setActiveServerStore(server);
  chats.setActiveChatStore(chat);
  const caller = { id: 'caller', clientId: 'caller-client', nickname: 'Caller', status: 'ONLINE', joinedAt: 1 };
  server.setServerDetails({
    id: 'settings-server', name: 'Settings server', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: [{
      id: 'settings-channel', serverId: 'settings-server', name: 'General', type: 'TEXT', position: 0, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
    }],
    members: [caller], knownMembers: [caller], roles: [], userRoles: [], ownerId: 'someone-else',
    myPermissions: 0,
  }, caller);
  settingsStore.botDownloadConfirmationExceptions = [];
  settingsStore.botUserPreferences = {};
  language.setLanguage('pt-BR');
  const definition = {
    user: {
      title: 'Personal options',
      fields: [
        { name: 'enabled', label: 'Enabled', type: 'boolean', required: true, defaultValue: false },
        { name: 'count', label: 'Count', type: 'integer', required: true, defaultValue: 0, min: 0, max: 5 },
        { name: 'mode', label: 'Mode', type: 'select', presentation: 'buttons', required: true, defaultValue: 'one',
          choices: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] },
        { name: 'names', label: 'Names', type: 'string-list', required: true, defaultValue: ['first'], minItems: 1, maxItems: 3 },
        { name: 'sound', label: 'Sound', type: 'select', required: true, defaultValue: 'bell',
          choices: [{ label: 'Bell', value: 'bell', audio: { url: 'https://audio.example/bell.mp3', fileName: 'bell.mp3', durationMs: 1000 } }] },
      ],
    },
    server: {
      title: 'Shared options',
      fields: [
        { name: 'enabled', label: 'Enabled for everyone', type: 'boolean', required: true, defaultValue: true },
        { name: 'rate', label: 'Rate', type: 'integer', required: true, defaultValue: 5, min: 1, max: 10 },
      ],
    },
  };
  let revision = 1;
  let schemaRevision = 1;
  let overrides = {};
  let userDefinition = definition.user;
  const requests = [];
  let deferType = null;
  let completeRequest = null;
  let failNext = false;
  const canConfigure = () => server.hasPermission(Permission.CONFIGURE_BOTS);
  const summary = id => ({
    botId: id, name: id === 'audio-bot' ? 'Audio <bot>' : 'Generic bot', avatarUrl: null, online: false,
    capabilities: { downloadsSound: id === 'audio-bot' }, schemaRevision, revision,
    hasServerSettings: id === 'generic-bot', hasUserSettings: id === 'generic-bot' && !!userDefinition,
    canConfigure: canConfigure(),
  });
  const snapshot = id => ({
    bot: summary(id),
    definition: id === 'audio-bot' ? {} : {
      ...(userDefinition ? { user: userDefinition } : {}),
      ...(canConfigure() ? { server: definition.server } : {}),
    },
    ...(canConfigure() && id === 'generic-bot' ? {
      server: {
        schemaRevision, revision,
        values: id === 'audio-bot' ? {} : { enabled: true, rate: 5, ...overrides },
      },
    } : {}),
  });
  client.sendRequest = async (type, payload) => {
    requests.push({ type, payload: structuredClone(payload), client });
    if (failNext) { failNext = false; throw new Error('Fixture response failed'); }
    if (deferType === type) return new Promise(resolve => { completeRequest = resolve; });
    if (type === MessageType.BOT_SETTINGS_LIST) return { bots: [summary('audio-bot'), summary('generic-bot')] };
    if (type === MessageType.BOT_SETTINGS_GET) return snapshot(payload.botId);
    if (type === MessageType.BOT_SETTINGS_UPDATE) {
      if (!canConfigure()) throw new Error('Fixture permission denied');
      if (payload.expectedRevision !== revision || payload.schemaRevision !== schemaRevision) throw new Error('Fixture settings conflict');
      for (const [key, value] of Object.entries(payload.patch)) {
        if (value === null) delete overrides[key];
        else overrides[key] = value;
      }
      revision++;
      return snapshot(payload.botId);
    }
    throw new Error('Unexpected settings request ' + type);
  };
  const userKey = botPreferenceScopeFor(client, server, 'generic-bot');
  const audioKey = botPreferenceScopeFor(client, server, 'audio-bot');
  const otherKey = botPreferenceScopeFor(client, server, 'other-bot');
  try {
    check(!new SoundboardTab().renderHtml().includes('bot-download-confirmations'), 'Soundboard no longer owns bot confirmations');
    await modal.open('audio-bot');
    check(find('.bot-settings-name').textContent === 'Audio <bot>' && !document.querySelector('.bot-settings-name bot'),
      'Bot identity is escaped');
    check(find('[data-settings-scope="user"]') && !document.querySelector('[data-settings-scope="server"]'),
      'A bot with only download capability shows only individual preferences');
    check(find('#bot-settings-host-prompt').getAttribute('role') === 'switch', 'Host confirmation uses a switch');
    check(find('.bot-settings-presence').textContent.includes('Offline'), 'An offline bot remains configurable');
    settingsStore.suppressBotDownloadConfirmation(otherKey);
    toggle('#bot-settings-host-prompt', false);
    await submit();
    check(settingsStore.botDownloadConfirmationExceptions.includes(audioKey), 'Individual save disables this bot prompt');
    equal(settingsStore.getBotUserSettings(audioKey), {}, 'Host confirmation never becomes a custom SDK value');
    check(!requests.some(request => request.type === MessageType.BOT_SETTINGS_UPDATE), 'Individual save does not call shared update');
    toggle('#bot-settings-host-prompt', true);
    await submit();
    check(!settingsStore.botDownloadConfirmationExceptions.includes(audioKey) &&
      settingsStore.botDownloadConfirmationExceptions.includes(otherKey), 'Re-enabling a prompt leaves another bot untouched');

    await modal.open();
    check(document.querySelectorAll('[data-settings-bot]').length === 2, 'Ordinary members can list installed offline bots');
    find('[data-settings-bot="generic-bot"]').click();
    await settle(() => !!document.querySelector('#bot-settings-user-count'));
    check(!document.querySelector('[data-settings-scope="server"]'), 'Shared behavior is omitted without configure permission');
    check(find('#bot-settings-user-enabled').checked === false && find('#bot-settings-user-count').value === '0',
      'False and zero defaults are displayed without truthiness fallback');
    check(document.querySelectorAll('[data-audio-preview-volume]').length === 1 &&
      !!document.querySelector('[data-audio-preview-progress]'), 'Settings reuse sound choices with one volume and progress');
    find('[data-bot-select-value="two"]').click();
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Choice buttons do not auto-save settings');
    check(find('[data-bot-select-value="two"]').getAttribute('aria-pressed') === 'true', 'Persistent button choices show selection');
    find('[data-field-name="names"] [data-field-action="add"]').click();
    type('#bot-settings-user-names-1', 'second');
    type('#bot-settings-user-count', '6');
    await submit();
    check(find('.bot-settings-message').getAttribute('role') === 'alert' &&
      find('[data-field-name="count"]').getAttribute('aria-invalid') === 'true', 'Invalid settings are visibly rejected');
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Invalid settings cannot reach persistence');
    type('#bot-settings-user-count', '2');
    await submit();
    equal(settingsStore.getBotUserSettings(userKey), { count: 2, mode: 'two', names: ['first', 'second'] },
      'Valid individual overrides are typed, sparse and explicit');
    await modal.open('generic-bot');
    check(find('#bot-settings-user-count').value === '2', 'Saved individual values reload');
    find('[data-settings-defaults]').click();
    equal(settingsStore.getBotUserSettings(userKey), { count: 2, mode: 'two', names: ['first', 'second'] },
      'Restore defaults waits for explicit Save');
    await submit();
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Saving defaults clears only custom overrides for this scope');

    settingsStore.saveBotPreferences(userKey, { removed: 'old value' });
    await modal.open('generic-bot');
    check(find('.bot-settings-message').textContent.includes(language.t('botSettings.stalePreferences')),
      'Incompatible saved preferences are surfaced rather than dropped');
    await submit();
    equal(settingsStore.getBotUserSettings(userKey), { removed: 'old value' }, 'An incompatible save does not silently erase fields');
    find('[data-settings-defaults]').click();
    await submit();
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Explicit defaults recover obsolete custom preferences');
    settingsStore.saveBotPreferences(userKey, { removed: 'obsolete' });
    userDefinition = undefined;
    await modal.open('generic-bot');
    check(!!document.querySelector('[data-settings-scope="user"]'), 'Removed user declarations still allow clearing old local overrides');
    find('[data-settings-defaults]').click();
    await submit();
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Old preferences can be reset after a declaration is removed');
    userDefinition = definition.user;

    server.myPermissions |= Permission.CONFIGURE_BOTS;
    check(!server.hasPermission(Permission.MANAGE_BOTS), 'Configure-only role has no installation/profile management grant');
    await modal.open('generic-bot');
    find('[data-settings-scope="server"]').click();
    type('#bot-settings-server-rate', '7');
    await submit();
    const update = requests.filter(request => request.type === MessageType.BOT_SETTINGS_UPDATE).at(-1);
    equal(update.payload.patch, { rate: 7 }, 'Shared saves patch only changed fields');
    check(update.payload.expectedRevision === 1 && update.payload.schemaRevision === 1,
      'Shared writes carry both optimistic concurrency revisions');
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Shared writes never mutate personal preferences');
    find('[data-settings-defaults]').click();
    await submit();
    equal(requests.filter(request => request.type === MessageType.BOT_SETTINGS_UPDATE).at(-1).payload.patch,
      { enabled: null, rate: null }, 'Shared defaults remove overrides rather than materializing defaults');
    type('#bot-settings-server-rate', '8');
    revision++;
    appEvents.emit('message.BOT_SETTINGS_LIST_RESPONSE', { bots: [summary('audio-bot'), summary('generic-bot')] });
    check(find('[data-settings-save]').disabled && find('.bot-settings-message').textContent.includes(language.t('botSettings.conflict')),
      'Concurrent shared changes block stale writes');
    check(find('#bot-settings-server-rate').value === '8', 'Concurrent updates do not erase unsaved input');
    find('[data-settings-reload]').click();
    await settle(() => !!document.querySelector('#bot-settings-server-rate') && !find('[data-settings-save]').disabled);
    check(find('#bot-settings-server-rate').value === '5', 'Explicit reload accepts current shared values');
    server.myPermissions &= ~Permission.CONFIGURE_BOTS;
    appEvents.emit('server.roles_updated');
    check(!document.querySelector('[data-settings-scope="server"]') && !modal.snapshot.server && !modal.drafts.server,
      'Permission loss removes shared controls and private values from memory');

    await modal.open('generic-bot');
    type('#bot-settings-user-count', '3');
    schemaRevision++;
    appEvents.emit('message.BOT_SETTINGS_LIST_RESPONSE', { bots: [summary('audio-bot'), summary('generic-bot')] });
    check(find('[data-settings-save]').disabled && find('#bot-settings-user-count').value === '3',
      'Schema updates require review without destroying a draft');
    find('[data-settings-reload]').click();
    await settle(() => !!document.querySelector('#bot-settings-user-count') && !find('[data-settings-save]').disabled);
    type('#bot-settings-user-count', '4');
    settingsStore.saveBotPreferences(userKey, { count: 1 });
    check(find('[data-settings-save]').disabled && find('#bot-settings-user-count').value === '4',
      'Changes from another local interaction do not silently overwrite an open draft');

    modal.close();
    userContextMenu.open(40, 40, { ...caller, id: 'audio-bot', nickname: 'Audio bot', isBot: true });
    find('[data-action="bot-settings"]').click();
    await settle(() => !!document.querySelector('#bot-settings-host-prompt'));
    check(!document.querySelector('.user-context-menu'), 'Bot menu opens scoped settings and dismisses itself');
    modal.close();
    userContextMenu.open(40, 40, { ...caller, id: 'human', nickname: 'Human', isBot: false });
    check(!document.querySelector('[data-action="bot-settings"]'), 'Human context menus have no bot action');
    userContextMenu.close();
    contextMenu.open(20, 20, [botSettingsMenuItem('audio-bot', client, server)]);
    appEvents.emit('session.changed');
    check(!document.querySelector('.floating-context-menu'), 'Generic context menu closes on session switch');

    const command = { botId: 'audio-bot', botName: 'Audio bot', name: 'query', description: 'Audio search', options: [] };
    chat.setCommands([command]);
    chat.acknowledgeCommand({ invocationId: 'settings-invocation', botId: command.botId, commandName: command.name, channelId: 'settings-channel' }, command);
    const feed = document.createElement('div');
    const composer = document.createElement('div');
    document.body.append(feed, composer);
    feed.innerHTML = renderBotInvocation(chat.getInvocation('settings-invocation'));
    const botView = new BotChatView(chat, client, server, 'settings-channel', composer, feed, () => {}, () => {});
    try {
      feed.querySelector('.chat-author-name').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 40, clientY: 40,
      }));
      find('.floating-context-menu button').click();
      await settle(() => !!document.querySelector('#bot-settings-host-prompt'));
      check(modal.snapshot.bot.botId === command.botId, 'Private command/progress identity opens its own bot settings');
    } finally {
      botView.destroy();
      feed.remove();
      composer.remove();
      modal.close();
    }

    server.myPermissions |= Permission.CONFIGURE_BOTS;
    await modal.open('generic-bot');
    find('[data-settings-scope="server"]').click();
    type('#bot-settings-server-rate', '9');
    deferType = MessageType.BOT_SETTINGS_UPDATE;
    completeRequest = null;
    find('#bot-settings-form').requestSubmit();
    await settle(() => !!completeRequest);
    const finishSave = completeRequest;
    appEvents.emit('session.changed');
    deferType = null;
    await modal.open('audio-bot');
    finishSave(snapshot('generic-bot'));
    await tick();
    check(modal.snapshot.bot.botId === 'audio-bot' && !!document.querySelector('#bot-settings-host-prompt'),
      'A late shared-save ACK cannot overwrite a replacement modal');
    server.myPermissions &= ~Permission.CONFIGURE_BOTS;
    modal.close();

    deferType = MessageType.BOT_SETTINGS_GET;
    completeRequest = null;
    const opening = modal.open('audio-bot');
    await settle(() => !!completeRequest);
    appEvents.emit('session.changed');
    completeRequest(snapshot('audio-bot'));
    await opening;
    check(!document.querySelector('.bot-settings-modal'), 'Late reads cannot reopen a closed settings modal');
    deferType = null;
    await modal.open('audio-bot');
    connectionId++;
    appEvents.emit('network.status');
    check(!document.querySelector('.bot-settings-modal'), 'Connection replacement closes the pinned modal');
    await modal.open('audio-bot');
    server.currentUser = { ...caller, id: 'another-identity' };
    appEvents.emit('user.updated');
    check(!document.querySelector('.bot-settings-modal'), 'Identity replacement invalidates scoped editing');
    server.currentUser = caller;

    const staleAction = botSettingsMenuItem('audio-bot', client, server);
    const otherClient = networks.createNetworkClient();
    networks.setActiveNetworkClient(otherClient);
    const beforeStale = requests.length;
    staleAction.onClick();
    await tick();
    check(requests.length === beforeStale && !document.querySelector('.bot-settings-modal'),
      'A stale context-menu action cannot target the newly selected server');
    find('.dialog-card button').click();
    networks.setActiveNetworkClient(client);

    await modal.open('generic-bot');
    failNext = true;
    find('[data-settings-reload]').click();
    await settle(() => !modal.loading);
    check(find('[data-settings-save]').disabled && find('.bot-settings-message').textContent.includes('Fixture response failed'),
      'A failed refresh does not permit saving against unverified metadata');
    find('[data-settings-reload]').click();
    await settle(() => !!document.querySelector('#bot-settings-user-count') && !find('[data-settings-save]').disabled);
    check(find('#bot-settings-user-count').value === '1', 'Reload recovers after a visible request error');
    language.setLanguage('en');
    check(find('#bot-settings-title').textContent === 'Bot settings', 'Settings chrome follows the active app language');
    await modal.open('audio-bot');
    check(find('label[for="bot-settings-host-prompt"]').textContent === 'Ask for a file name before downloading',
      'Host preference text is localized');
    window.botSettingsPreviewMarkup = find('.bot-settings-modal').outerHTML;
    return checks;
  } finally {
    modal.close();
    userContextMenu.close();
    contextMenu.close();
    settingsStore.botDownloadConfirmationExceptions = previous.exceptions;
    settingsStore.botUserPreferences = previous.preferences;
    if (previous.stored === null) localStorage.removeItem('monky_settings');
    else localStorage.setItem('monky_settings', previous.stored);
    language.setLanguage(previous.language);
    networks.setActiveNetworkClient(previous.client);
    servers.setActiveServerStore(previous.server);
    chats.setActiveChatStore(previous.chat);
  }
}

module.exports = { runBotSettingsDomSmoke };
