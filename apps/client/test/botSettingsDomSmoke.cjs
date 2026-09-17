async function runBotSettingsDomSmoke() {
  const [modalModule, servers, networks, chats, { settingsStore }, { appEvents }, { botPreferenceScopeFor },
    { userContextMenu }, { contextMenu }, { SoundboardTab }, language, { BotChatView, renderBotInvocation },
    { showBotPermissionReview }] = await Promise.all([
    import('/views/BotSettingsModal.ts'), import('/stores/serverStore.ts'),
    import('/core/NetworkClient.ts'), import('/stores/chatStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/EventBus.ts'), import('/utils/botSettingsContext.ts'), import('/views/UserContextMenu.ts'),
    import('/views/ContextMenu.ts'), import('/views/settings/tabs/SoundboardTab.ts'), import('/i18n/index.ts'),
    import('/views/BotChatView.ts'), import('/views/BotPermissionReview.ts'),
  ]);
  const Permission = { CONFIGURE_BOTS: 1 << 15, MANAGE_BOTS: 1 << 13 };
  const MessageType = {
    BOT_SETTINGS_LIST: 'BOT_SETTINGS_LIST', BOT_SETTINGS_GET: 'BOT_SETTINGS_GET', BOT_SETTINGS_UPDATE: 'BOT_SETTINGS_UPDATE',
    BOT_PERMISSIONS_UPDATE: 'BOT_PERMISSIONS_UPDATE',
  };
  const { botSettingsModal: modal, botSettingsMenuItem } = modalModule;
  const previous = {
    client: networks.getActiveNetworkClient(), server: servers.getActiveServerStore(), chat: chats.getActiveChatStore(),
    exceptions: settingsStore.botDownloadConfirmationExceptions, preferences: settingsStore.botUserPreferences,
    locales: settingsStore.botLocalePreferences,
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
  settingsStore.botLocalePreferences = {};
  language.setLanguage('pt-BR');
  const definition = {
    user: {
      title: 'Personal options',
      description: 'Personal options stored on this device.',
      fields: [
        { name: 'enabled', label: 'Enabled', type: 'boolean', required: true, defaultValue: false },
        { name: 'count', label: 'Count', description: 'How many items to use.', type: 'integer', required: true, defaultValue: 0, min: 0, max: 5 },
        { name: 'mode', label: 'Mode', type: 'select', presentation: 'buttons', required: true, defaultValue: 'one',
          choices: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] },
        { name: 'names', label: 'Names', type: 'string-list', required: true, defaultValue: ['first'], minItems: 1, maxItems: 3 },
        { name: 'sound', label: 'Sound', type: 'select', required: true, defaultValue: 'bell',
          choices: [{ label: 'Bell', value: 'bell', audio: { url: 'https://audio.example/bell.mp3', fileName: 'bell.mp3', durationMs: 1000 } }] },
      ],
    },
    server: {
      title: 'Music settings',
      description: 'Music behavior shared by everyone on this server.',
      fields: [
        { name: 'enabled', label: 'Enabled for everyone', type: 'boolean', required: true, defaultValue: true },
        { name: 'rate', label: 'Rate', type: 'integer', required: true, defaultValue: 5, min: 1, max: 10 },
        { name: 'music_idle_seconds', label: 'Idle timeout (seconds)', description: 'Leave voice after 1 to 600 idle seconds.',
          type: 'integer', required: true, defaultValue: 60, min: 1, max: 600 },
      ],
    },
    localizations: {
      'pt-BR': {
        user: {
          title: 'Preferências pessoais', description: 'Opções pessoais salvas neste dispositivo.',
          fields: {
            enabled: { label: 'Ativado' },
            count: { label: 'Quantidade', description: 'Quantidade de itens de 0 a 5.' },
            names: { label: 'Nomes' },
          },
        },
        server: {
          title: 'Configurações de música', description: 'Comportamento da música compartilhado neste servidor.',
          fields: {
            rate: { label: 'Taxa' },
            music_idle_seconds: { label: 'Tempo de inatividade (segundos)', description: 'Sair da voz após 1 a 600 segundos sem atividade.' },
          },
        },
      },
      en: { user: { title: 'Your preferences', fields: { count: { label: 'Item count' } } } },
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
  const canManage = () => server.hasPermission(Permission.MANAGE_BOTS);
  let permissions = {
    requested: ['commands', 'send_messages', 'local_execution'], granted: [], revision: 1,
    reviewRequired: true, reviewedBy: null, reviewedAt: null,
  };
  const visibleDefinition = () => {
    const visible = {
      ...(userDefinition ? { user: userDefinition } : {}),
      ...(canConfigure() ? { server: definition.server } : {}),
    };
    const localizations = {};
    for (const [locale, forms] of Object.entries(definition.localizations)) {
      const scopes = {};
      for (const scope of ['user', 'server']) if (visible[scope] && forms[scope]) scopes[scope] = forms[scope];
      if (Object.keys(scopes).length) localizations[locale] = scopes;
    }
    if (Object.keys(localizations).length) visible.localizations = localizations;
    return visible;
  };
  const summary = id => ({
    botId: id, name: id === 'audio-bot' ? 'Audio <bot>' : 'Generic bot', avatarUrl: null, online: false,
    capabilities: { downloadsSound: id === 'audio-bot' }, schemaRevision, revision,
    hasServerSettings: id === 'generic-bot', hasUserSettings: id === 'generic-bot' && !!userDefinition,
    canConfigure: canConfigure(), canManage: canManage(), permissions: structuredClone(permissions),
  });
  const snapshot = id => ({
    bot: summary(id),
    definition: id === 'audio-bot' ? {} : visibleDefinition(),
    ...(canConfigure() && id === 'generic-bot' ? {
      server: {
        schemaRevision, revision,
        values: id === 'audio-bot' ? {} : { enabled: true, rate: 5, music_idle_seconds: 60, ...overrides },
      },
    } : {}),
  });
  client.sendRequest = async (type, payload) => {
    requests.push({ type, payload: structuredClone(payload), client });
    if (failNext) { failNext = false; throw new Error('Fixture response failed'); }
    if (deferType === type) return new Promise(resolve => { completeRequest = resolve; });
    if (type === MessageType.BOT_SETTINGS_LIST) return { bots: [summary('audio-bot'), summary('generic-bot')] };
    if (type === MessageType.BOT_SETTINGS_GET) return snapshot(payload.botId);
    if (type === MessageType.BOT_PERMISSIONS_UPDATE) {
      if (!canManage()) throw new Error('Fixture bot management denied');
      if (payload.expectedRevision !== permissions.revision) throw new Error('Fixture permission conflict');
      if (!payload.granted.every(capability => permissions.requested?.includes(capability))) throw new Error('Fixture unrequested grant');
      permissions = {
        ...permissions, granted: payload.granted.slice(), revision: permissions.revision + 1,
        reviewRequired: false, reviewedBy: caller.id, reviewedAt: Date.now(),
      };
      return { botId: payload.botId, permissions: structuredClone(permissions) };
    }
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
    check(find('[data-settings-locale="auto"]').getAttribute('aria-pressed') === 'true',
      'Bots follow the app language until the person chooses an override');
    find('[data-settings-locale="en"]').click();
    check(settingsStore.getBotLocalePreference(audioKey) === 'auto', 'Language cards do not save until confirmation');
    check(find('[data-settings-locale="en"]').getAttribute('aria-pressed') === 'true', 'Language cards expose selected state');
    find('[data-settings-locale="en"]').focus();
    find('[data-settings-locale="en"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    check(document.activeElement === find('[data-settings-locale="auto"]'), 'Language cards support keyboard navigation');
    await submit();
    check(settingsStore.getBotLocalePreference(audioKey) === 'en' && settingsStore.getBotLocalePreference(otherKey) === 'auto',
      'A language override is isolated from other bots and identities');
    equal(settingsStore.getBotUserSettings(audioKey), {}, 'The bot language is not mixed into custom SDK settings');
    find('[data-settings-defaults]').click();
    await submit();
    check(settingsStore.getBotLocalePreference(audioKey) === 'auto', 'Reset restores following Monky without pinning a locale');

    await modal.open();
    check(document.querySelectorAll('[data-settings-bot]').length === 2, 'Ordinary members can list installed offline bots');
    find('[data-settings-bot="generic-bot"]').click();
    await settle(() => !!document.querySelector('#bot-settings-user-count'));
    check(!document.querySelector('[data-settings-scope="server"]'), 'Shared behavior is omitted without configure permission');
    check(find('#bot-settings-form h3').textContent === 'Preferências pessoais' &&
      find('#bot-settings-form [data-settings-section="bot-defined"] > .bot-field-description').textContent === 'Opções pessoais salvas neste dispositivo.',
      'Personal form title and description follow declared app-language metadata');
    check(find('label[for="bot-settings-user-count"]').textContent.includes('Quantidade') &&
      find('[data-field-name="count"] .bot-field-description').textContent === 'Quantidade de itens de 0 a 5.',
      'Personal field labels and descriptions are localized rather than hardcoded');
    check(!Object.values(modal.snapshot.definition.localizations).some(forms => forms.server),
      'Unauthorized snapshots contain no localized server scope');
    find('[data-settings-locale="en"]').click();
    check(find('#bot-settings-form h3').textContent === 'Your preferences',
      'An unsaved bot-language choice previews translated metadata without changing app language');
    check(language.getLanguage() === 'pt-BR', 'A bot-language card does not change the application locale');
    await submit();
    await modal.open('generic-bot');
    check(find('#bot-settings-form h3').textContent === 'Your preferences',
      'Reopening settings restores the saved language override');
    find('[data-settings-locale="auto"]').click();
    await submit();
    check(find('#bot-settings-form h3').textContent === 'Preferências pessoais', 'Automatic language follows the app again');
    check(find('#bot-settings-user-enabled').checked === false && find('#bot-settings-user-count').value === '0',
      'False and zero defaults are displayed without truthiness fallback');
    check(document.querySelectorAll('[data-audio-preview-volume]').length === 1 &&
      !!document.querySelector('[data-audio-preview-progress]'), 'Settings reuse sound choices with one volume and progress');
    find('[data-bot-select-value="two"]').click();
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Choice buttons do not auto-save settings');
    check(find('[data-bot-select-value="two"]').getAttribute('aria-pressed') === 'true', 'Persistent button choices show selection');
    find('[data-field-name="names"] [data-field-action="add"]').click();
    type('#bot-settings-user-names-1', 'second');
    toggle('#bot-settings-user-enabled', true);
    type('#bot-settings-user-count', '3');
    find('#bot-settings-user-names-1').focus();
    find('#bot-settings-user-names-1').setSelectionRange(1, 4, 'backward');
    const personalDraft = structuredClone(modal.drafts.user);
    const definitionBeforeLanguage = structuredClone(definition);
    const requestsBeforeLanguage = requests.length;
    language.setLanguage('en');
    check(find('#bot-settings-form h3').textContent === 'Your preferences' &&
      find('label[for="bot-settings-user-count"]').textContent.includes('Item count'),
      'English overrides are selected from the current app language');
    check(find('[data-field-name="count"] .bot-field-description').textContent === 'How many items to use.',
      'Missing translated properties fall back to the declared base form');
    equal(modal.drafts.user, personalDraft, 'Language changes preserve unsaved personal values and dirty state');
    check(find('#bot-settings-user-enabled').checked && find('#bot-settings-user-count').value === '3' &&
      find('[data-bot-select-value="two"]').getAttribute('aria-pressed') === 'true' &&
      find('#bot-settings-user-names-1').value === 'second', 'Localized fields retain boolean, numeric, select and list drafts');
    check(document.activeElement?.id === 'bot-settings-user-names-1' &&
      document.activeElement.selectionStart === 1 && document.activeElement.selectionEnd === 4 &&
      document.activeElement.selectionDirection === 'backward', 'Relocalization preserves focused text and caret selection');
    language.setLanguage('pt-BR');
    check(find('#bot-settings-form h3').textContent === 'Preferências pessoais',
      'Switching back relocalizes the existing modal');
    equal(modal.drafts.user, personalDraft, 'Returning to Portuguese does not reset the draft');
    equal(definition, definitionBeforeLanguage, 'Localization never mutates field definitions or defaults');
    check(requests.length === requestsBeforeLanguage, 'Relocalization makes no settings request or implicit save');
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Unsaved localized settings remain outside persistence');
    toggle('#bot-settings-user-enabled', false);
    type('#bot-settings-user-count', '6');
    await submit();
    check(find('.bot-settings-message').getAttribute('role') === 'alert' &&
      find('[data-field-name="count"]').getAttribute('aria-invalid') === 'true', 'Invalid settings are visibly rejected');
    check(find('.bot-settings-message').textContent.includes('Quantidade'), 'Validation errors use the currently localized field label');
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
    check(find('#bot-settings-form h3').textContent === 'Configurações de música' &&
      find('label[for="bot-settings-server-music_idle_seconds"]').textContent.includes('Tempo de inatividade'),
      'Server music settings use declared Portuguese titles and labels');
    const idle = find('#bot-settings-server-music_idle_seconds');
    const idleField = modal.form().fields.find(field => field.name === 'music_idle_seconds');
    check(idle.inputMode === 'numeric' && idle.value === '60' && idleField.type === 'integer' &&
      idleField.defaultValue === 60 && idleField.min === 1 && idleField.max === 600 &&
      idle.closest('[data-field-name]').textContent.includes(language.t('botChat.minimum', { value: 1 })) &&
      idle.closest('[data-field-name]').textContent.includes(language.t('botChat.maximum', { value: 600 })),
      'Localized idle timeout retains the shared numeric control, integer type, default 60 and visible 1..600 limits');
    type('#bot-settings-server-music_idle_seconds', '120');
    type('#bot-settings-server-rate', '7');
    const serverDraft = structuredClone(modal.drafts.server);
    const requestsBeforeServerLanguage = requests.length;
    language.setLanguage('en');
    check(find('#bot-settings-form h3').textContent === 'Music settings' &&
      find('label[for="bot-settings-server-music_idle_seconds"]').textContent.includes('Idle timeout (seconds)') &&
      find('[data-field-name="music_idle_seconds"] .bot-field-description').textContent === 'Leave voice after 1 to 600 idle seconds.',
      'A base-English server form remains the fallback without an English localization block');
    equal(modal.drafts.server, serverDraft, 'Relocalization preserves unsaved shared values and revisions');
    check(find('#bot-settings-server-music_idle_seconds').value === '120' &&
      find('#bot-settings-server-rate').value === '7', 'Shared input values survive the language change');
    language.setLanguage('pt-BR');
    equal(modal.drafts.server, serverDraft, 'Portuguese restores labels without replacing the server draft');
    check(requests.length === requestsBeforeServerLanguage, 'Changing shared-form language never sends a save');
    for (const invalidIdle of ['0', '601', '1.5']) {
      type('#bot-settings-server-music_idle_seconds', invalidIdle);
      await submit();
      check(requests.length === requestsBeforeServerLanguage &&
        find('[data-field-name="music_idle_seconds"]').getAttribute('aria-invalid') === 'true',
        'Localized idle timeout rejects invalid integer/range input: ' + invalidIdle);
    }
    type('#bot-settings-server-music_idle_seconds', '120');
    await submit();
    const update = requests.filter(request => request.type === MessageType.BOT_SETTINGS_UPDATE).at(-1);
    equal(update.payload.patch, { rate: 7, music_idle_seconds: 120 }, 'Shared saves preserve typed values and patch only changed fields');
    check(update.payload.expectedRevision === 1 && update.payload.schemaRevision === 1,
      'Shared writes carry both optimistic concurrency revisions');
    equal(settingsStore.getBotUserSettings(userKey), {}, 'Shared writes never mutate personal preferences');
    find('[data-settings-defaults]').click();
    await submit();
    equal(requests.filter(request => request.type === MessageType.BOT_SETTINGS_UPDATE).at(-1).payload.patch,
      { enabled: null, rate: null, music_idle_seconds: null }, 'Shared defaults remove overrides rather than materializing defaults');
    type('#bot-settings-server-rate', '8');
    revision++;
    appEvents.emit('message.BOT_SETTINGS_LIST_RESPONSE', { bots: [summary('audio-bot'), summary('generic-bot')] });
    check(find('[data-settings-save]').disabled && find('.bot-settings-message').textContent.includes(language.t('botSettings.conflict')),
      'Concurrent shared changes block stale writes');
    check(find('#bot-settings-server-rate').value === '8', 'Concurrent updates do not erase unsaved input');
    find('[data-settings-reload]').click();
    await settle(() => !!document.querySelector('#bot-settings-server-rate') && !find('[data-settings-save]').disabled);
    check(find('#bot-settings-server-rate').value === '5', 'Explicit reload accepts current shared values');
    find('[data-settings-scope="user"]').click();
    type('#bot-settings-user-count', '4');
    find('[data-settings-scope="server"]').click();
    server.myPermissions &= ~Permission.CONFIGURE_BOTS;
    appEvents.emit('server.roles_updated');
    check(!document.querySelector('[data-settings-scope="server"]') && !modal.snapshot.server && !modal.drafts.server,
      'Permission loss removes shared controls and private values from memory');
    check(!Object.values(modal.snapshot.definition.localizations ?? {}).some(forms => forms.server),
      'Permission loss also removes localized private server declarations');
    check(find('#bot-settings-form h3').textContent === 'Preferências pessoais' && find('#bot-settings-user-count').value === '4',
      'Permission loss preserves localized personal controls and unsaved values');
    language.setLanguage('en');
    check(find('#bot-settings-form h3').textContent === 'Your preferences' && find('#bot-settings-user-count').value === '4',
      'Remaining personal localizations stay available after permission loss');
    language.setLanguage('pt-BR');

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
    check(find('[data-settings-save]').dataset.loading === '1' &&
      getComputedStyle(find('[data-settings-save]'), '::after').animationName === 'reconnect-spin',
    'Saving bot settings uses the existing animated button feedback');
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
    check(!!document.querySelector('.bot-settings-body .bot-loading-spinner') &&
      getComputedStyle(find('.bot-settings-body .bot-loading-spinner')).animationName === 'reconnect-spin',
    'Bot settings reads retain an animated localized waiting indicator');
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
    check(!!document.querySelector('.bot-settings-modal .settings-sidebar .settings-section-nav') &&
      find('#tab-panel-user').getAttribute('role') === 'tabpanel',
    'Bot settings reuse the app sidebar, subsection navigation and labelled settings panel');
    server.myPermissions = Permission.CONFIGURE_BOTS;
    await modal.open('generic-bot');
    check(!document.querySelector('[data-settings-scope="permissions"]'),
      'Configuring bot-defined settings never grants authority to review bot permissions');
    const localBeforeReview = JSON.stringify({
      preferences: settingsStore.botUserPreferences, locales: settingsStore.botLocalePreferences,
      exceptions: settingsStore.botDownloadConfirmationExceptions,
    });
    server.myPermissions = Permission.MANAGE_BOTS;
    await modal.open('generic-bot');
    check(find('[data-settings-scope="permissions"]').getAttribute('aria-selected') === 'true' &&
      !document.querySelector('[data-settings-scope="server"]'),
    'An unreviewed declaration opens its review for managers without exposing shared settings');
    check(document.querySelectorAll('[data-bot-capability]').length === 3 &&
      !document.querySelector('[data-bot-capability="publish_voice"]') &&
      ![...document.querySelectorAll('[data-bot-capability]')].some(input => input.checked),
    'Only requested capabilities are offered and new grants default off');
    const allowAll = find('[data-bot-permissions-all]');
    allowAll.focus();
    allowAll.click();
    check(document.activeElement === allowAll && [...document.querySelectorAll('[data-bot-capability]')].every(input => input.checked) &&
      allowAll.getAttribute('role') === 'switch', 'Allow all updates native accessible switches without replacing keyboard focus');
    find('[data-bot-capability="local_execution"]').click();
    check(!find('[data-bot-permissions-all]').checked, 'Turning off one capability clears Allow all');
    await submit();
    const grantRequest = requests.filter(request => request.type === MessageType.BOT_PERMISSIONS_UPDATE).at(-1);
    equal(grantRequest.payload, { botId: 'generic-bot', expectedRevision: 1, granted: ['commands', 'send_messages'] },
      'Saving sends the reviewed subset with its original optimistic revision');
    check(permissions.reviewedBy === caller.id && !permissions.reviewRequired, 'The server-approved revision is reflected after save');
    check(JSON.stringify({
      preferences: settingsStore.botUserPreferences, locales: settingsStore.botLocalePreferences,
      exceptions: settingsStore.botDownloadConfirmationExceptions,
    }) === localBeforeReview, 'Server capability review never changes local consent, language or personal preferences');
    find('[data-bot-capability="commands"]').click();
    permissions = { ...permissions, requested: [...permissions.requested, 'publish_voice'], revision: permissions.revision + 1,
      reviewRequired: true, reviewedBy: null, reviewedAt: null };
    appEvents.emit('message.BOT_PERMISSIONS_SNAPSHOT', { botId: 'generic-bot', permissions });
    check(find('[data-settings-save]').disabled && !find('[data-bot-capability="commands"]').checked &&
      !find('[data-bot-capability="publish_voice"]').checked, 'A concurrent declaration preserves the draft but blocks stale approval');
    find('[data-settings-reload]').click();
    await settle(() => !modal.loading);
    check(!find('[data-settings-save]').disabled && find('[data-bot-capability="commands"]').checked &&
      !find('[data-bot-capability="publish_voice"]').checked, 'Explicit reload restores only persisted grants, never a newly requested capability');
    find('[data-settings-defaults]').click();
    check(![...document.querySelectorAll('[data-bot-capability]')].some(input => input.checked),
      'Restoring permission defaults grants nothing');
    deferType = MessageType.BOT_PERMISSIONS_UPDATE;
    completeRequest = null;
    find('#bot-settings-form').requestSubmit();
    await settle(() => !!completeRequest);
    server.myPermissions = Permission.CONFIGURE_BOTS;
    appEvents.emit('server.updated');
    check(!document.querySelector('[data-settings-scope="permissions"]') && modal.permissionDraft.length === 0,
      'Losing MANAGE_BOTS removes permission editing and its unsaved draft');
    permissions = { ...permissions, granted: [], revision: permissions.revision + 1,
      reviewRequired: false, reviewedBy: caller.id, reviewedAt: Date.now() };
    completeRequest({ botId: 'generic-bot', permissions: structuredClone(permissions) });
    await tick();
    deferType = null;
    check(!document.querySelector('[data-settings-scope="permissions"]') && modal.permissionDraft.length === 0,
      'A late approval response cannot restore permission editing after role loss');
    permissions = { requested: null, granted: [], revision: 0, reviewRequired: true, reviewedBy: null, reviewedAt: null };
    server.myPermissions = Permission.MANAGE_BOTS;
    await modal.open('generic-bot');
    check(find('[data-settings-save]').disabled && !document.querySelector('[data-bot-capability]') &&
      find('.bot-settings-body').textContent.includes(language.t('botPermissions.undeclared')),
    'Manual and migrated bots with no declaration cannot receive fabricated approval');
    modal.close();
    const reviewPreview = {
      previewId: 'review-preview', expiresAt: Date.now() + 60000,
      manifest: { name: 'Review <bot>', description: 'Declared access', registrationUrl: 'https://bot.example/register',
        requestedCapabilities: ['commands', 'local_execution'] },
    };
    const reviewAbort = new AbortController();
    const review = showBotPermissionReview(reviewPreview, reviewAbort.signal);
    check(!find('[data-bot-permissions-all]').checked &&
      ![...document.querySelectorAll('[data-bot-capability]')].some(input => input.checked) &&
      !document.querySelector('#bot-permission-review-title bot'), 'Installation review escapes identity and starts with all switches off');
    check(find('.bot-permission-review-body').textContent.includes(language.t('botPermissions.localConsent')) &&
      find('.bot-permission-review-body').textContent.includes(language.t('botPermissions.listeningUnavailable')),
    'Review distinguishes device consent and explicitly states that voice reception is unavailable');
    find('[data-bot-permissions-all]').click();
    find('[data-bot-capability="local_execution"]').click();
    find('[data-review-confirm]').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    check(document.activeElement === find('[data-bot-permissions-all]'), 'Installation review wraps keyboard focus inside the dialog');
    find('[data-review-confirm]').click();
    equal(await review, ['commands'], 'Installation returns exactly the reviewed capability subset');
    const aborted = showBotPermissionReview(reviewPreview, reviewAbort.signal);
    reviewAbort.abort();
    check(await aborted === null && !document.querySelector('.bot-permission-review'),
      'Permission/session loss aborts the installation dialog and removes its listeners and DOM');
    const cancelled = showBotPermissionReview(reviewPreview, new AbortController().signal);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(await cancelled === null && !document.querySelector('.bot-permission-review'), 'Escape cancels a repeated review without stale dialogs');
    server.myPermissions = 0;
    await modal.open('generic-bot');
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
    settingsStore.botLocalePreferences = previous.locales;
    if (previous.stored === null) localStorage.removeItem('monky_settings');
    else localStorage.setItem('monky_settings', previous.stored);
    language.setLanguage(previous.language);
    networks.setActiveNetworkClient(previous.client);
    servers.setActiveServerStore(previous.server);
    chats.setActiveChatStore(previous.chat);
  }
}

module.exports = { runBotSettingsDomSmoke };
