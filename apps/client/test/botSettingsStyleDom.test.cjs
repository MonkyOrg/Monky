// Renders the real bot settings and server settings modals with the app's own
// stylesheets and fonts, compares the typography and navigation the person sees
// (tabs, sidebar title, section titles and subsection menus) and captures both
// modals. Screenshots go to MONKY_BOT_SETTINGS_SCREENSHOTS, or dist-test.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('bot settings share the typography and navigation of the standard settings modals', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `bot-settings-style-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_BOT_SETTINGS_STYLE_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: clientRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_BOT_SETTINGS_STYLE_PROFILE);
  app.on('window-all-closed', () => {});
  const screenshots = process.env.MONKY_BOT_SETTINGS_SCREENSHOTS || path.join(clientRoot, 'dist-test');
  const dump = process.argv.includes('--dump');
  let vite;
  let browser;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  const capture = async (name) => {
    await browser.webContents.executeJavaScript(`document.fonts.ready.then(() => Promise.allSettled(document.getAnimations()
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)))
      .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`, true);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      browser.webContents.once('paint', () => { clearTimeout(timer); resolve(); });
      browser.webContents.invalidate();
    });
    fs.mkdirSync(screenshots, { recursive: true });
    const file = path.join(screenshots, `${name}.png`);
    fs.writeFileSync(file, (await browser.webContents.capturePage()).toPNG());
    return file;
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'bot-settings-style-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__bot_settings_style__') return next();
            response.setHeader('Content-Type', 'text/html');
            // The same stylesheets, in the same order, as the application's index.html.
            response.end('<!doctype html><html lang="pt-BR"><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"><link rel="stylesheet" href="/styles/footerControls.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite address');
    browser = new BrowserWindow({
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Bot settings style DOM check timed out'); void finish(1); }, 100000);
    const files = [];
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${address.port}/__bot_settings_style__`);
      await browser.webContents.executeJavaScript('localStorage.clear(); sessionStorage.clear();', true);
      await browser.webContents.executeJavaScript(
        `window.botSettingsStyle = (${runBotSettingsStyle.toString()})(${JSON.stringify(language)}, ${dump}); void 0`, true);
      for (;;) {
        const step = await browser.webContents.executeJavaScript(
          'window.botSettingsStyle.next().catch(error => ({ failure: error.stack || String(error) }))', true);
        if (step.failure) throw new Error(step.failure);
        if (step.done) {
          if (dump) console.log(JSON.stringify(step.value, null, 2));
          else console.log(`Bot settings style DOM (${language}): ${step.value} checks passed`);
          break;
        }
        files.push(await capture(`bot-settings-style-${language}-${step.value}`));
      }
    }
    console.log(`Screenshots: ${files.join(', ')}`);
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function* runBotSettingsStyle(language, dump) {
  const [{ botSettingsModal: modal }, servers, networks, i18n, { ServerSettingsModal }, { CommunityFeed }, { sessionManager }] =
    await Promise.all([
      import('/views/BotSettingsModal.ts'), import('/stores/serverStore.ts'), import('/core/NetworkClient.ts'),
      import('/i18n/index.ts'), import('/views/ServerSettingsModal.ts'), import('/core/CommunityFeed.ts'),
      import('/core/SessionManager.ts'),
    ]);
  i18n.setLanguage(language);
  const { t } = i18n;
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const live = selector => [...document.querySelectorAll(selector)].filter(element => !element.closest('[data-ui-closing]'));
  const find = selector => {
    const element = live(selector)[0];
    if (!element) throw new Error(`Missing ${selector}: ${document.body.innerText.slice(-600)}`);
    return element;
  };
  const flush = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.allSettled(document.getAnimations().filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
    await document.fonts.ready;
  };
  const typography = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'color'];
  const styleOf = (element, keys = typography) => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(keys.map(key => [key, computed[key]]));
  };
  const same = (actual, expected, keys, message) => {
    const differences = keys.filter(key => actual[key] !== expected[key])
      .map(key => `${key}: ${actual[key]} != ${expected[key]}`);
    check(differences.length === 0, `${message} (${differences.join('; ')})`);
  };
  const measure = document.createElement('canvas').getContext('2d');
  const tabMetrics = tab => {
    const icon = tab.querySelector(':scope > .material-symbols-outlined');
    const parts = [...tab.childNodes].filter(node => node !== icon && node.textContent.trim());
    const label = parts.map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const range = document.createRange();
    range.setStartBefore(parts[0]);
    range.setEndAfter(parts[parts.length - 1]);
    const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 1).map(rect => Math.round(rect.top)));
    const style = styleOf(tab, [...typography, 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap']);
    measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
      label, ...style, height: tab.getBoundingClientRect().height, lines: lines.size, active: tab.classList.contains('active'),
      labelWidth: Math.ceil(measure.measureText(label).width),
      room: tab.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) -
        (icon ? icon.getBoundingClientRect().width + parseFloat(style.gap) : 0),
    };
  };
  const subsectionMenu = tab => {
    const id = (tab.getAttribute('aria-controls') ?? '').split(/\s+/).find(entry => entry.startsWith('settings-subsections-'));
    const menu = id ? document.getElementById(id) : null;
    return {
      expanded: tab.getAttribute('aria-expanded') === 'true' && !!menu && !menu.hidden,
      links: menu ? [...menu.querySelectorAll('.settings-section-link')].map(link => link.textContent) : [],
    };
  };

  const Permission = { CONFIGURE_BOTS: 1 << 15, MANAGE_BOTS: 1 << 13 };
  const previous = { client: networks.getActiveNetworkClient(), server: servers.getActiveServerStore(), active: sessionManager.getActive };
  const owner = { id: 'owner', clientId: 'owner-client', nickname: 'Owner', status: 'ONLINE', joinedAt: 1 };
  const definition = {
    user: {
      title: 'Music preferences', description: 'Applies only to you.',
      fields: [{ name: 'announce', label: 'Announce the next song', type: 'boolean', defaultValue: true }],
    },
    server: {
      title: 'Music', description: 'Music behavior shared by everyone on this server.',
      fields: [
        { name: 'idle', label: 'Idle timeout (seconds)', type: 'integer', required: true, defaultValue: 60, min: 1, max: 600 },
        { name: 'announce', label: 'Announce songs in the chat', type: 'boolean', required: true, defaultValue: true },
      ],
    },
    localizations: {
      'pt-BR': {
        user: { title: 'Preferências de música', description: 'Vale só para você.', fields: { announce: { label: 'Anunciar a próxima música' } } },
        server: {
          title: 'Música', description: 'Comportamento da música compartilhado por todos neste servidor.',
          fields: { idle: { label: 'Tempo de inatividade (segundos)' }, announce: { label: 'Anunciar músicas no chat' } },
        },
      },
    },
  };
  const permissions = {
    requested: ['commands', 'send_messages', 'publish_voice', 'local_execution', 'sound_download', 'receive_voice'],
    granted: ['commands', 'send_messages', 'publish_voice', 'local_execution', 'sound_download'],
    revision: 3, reviewRequired: true, reviewedBy: null, reviewedAt: null,
  };
  let manifestUrl = 'https://bots.monky.example:7780/very/long/path/that/does/not/fit/in/one/line/of/the/settings/manifest';
  const summary = () => ({
    botId: 'monky-bot', name: 'Monky Bot', avatarUrl: null, online: true, capabilities: { downloadsSound: true },
    schemaRevision: 1, revision: 1, hasServerSettings: true, hasUserSettings: true, canConfigure: true, canManage: true,
    permissions: structuredClone(permissions), manifestUrl,
  });
  const botServer = servers.createServerStore();
  const botClient = networks.createNetworkClient();
  botClient.getConnectionId = () => 1;
  botClient.getStatus = () => 'CONNECTED';
  botClient.getCurrentServerUrl = () => 'wss://style.example/';
  botClient.sendRequest = async (type, payload) => {
    if (type === 'BOT_SETTINGS_LIST') return { bots: [summary()] };
    if (type === 'BOT_SETTINGS_GET' && payload.botId === 'monky-bot') {
      return { bot: summary(), definition, server: { schemaRevision: 1, revision: 1, values: { idle: 60, announce: true } } };
    }
    throw new Error(`Unexpected bot settings request ${type}`);
  };
  botServer.setServerDetails({
    id: 'style-server', name: 'Servidor de estilo', createdAt: 1, maxUsers: 10, voiceStates: {}, channels: [],
    members: [owner], knownMembers: [owner], roles: [], userRoles: [], ownerId: owner.id,
    myPermissions: Permission.CONFIGURE_BOTS | Permission.MANAGE_BOTS,
  }, owner);
  networks.setActiveNetworkClient(botClient);
  servers.setActiveServerStore(botServer);
  const bot = {};
  try {
    await modal.open('monky-bot');
    await flush();
    bot.sidebarTitle = styleOf(find('.bot-settings-modal .settings-sidebar > :first-child'));
    bot.headerTitle = styleOf(find('#bot-settings-title'));
    for (const scope of ['user', 'server', 'permissions']) {
      find(`[data-settings-scope="${scope}"]`).click();
      await flush();
      const tabs = live('.bot-settings-modal .settings-tab-btn');
      bot[scope] = {
        tabs: tabs.map(tabMetrics), menu: subsectionMenu(find(`[data-settings-scope="${scope}"]`)),
        headings: live('.bot-settings-modal .settings-tab-panel h3, .bot-settings-modal .settings-tab-panel h4')
          .map(heading => ({ text: heading.textContent.trim(), className: heading.className, ...styleOf(heading) })),
        sectionTitles: live('.bot-settings-modal .bot-settings-section-title')
          .map(title => ({ text: title.textContent.trim(), ...styleOf(title) })),
        links: live('.bot-settings-modal .settings-section-link').map(link => ({ text: link.textContent, ...styleOf(link) })),
        manifest: live('.bot-settings-modal [data-bot-manifest]').map(row => {
          const url = row.querySelector('.bot-settings-manifest-url');
          return {
            label: styleOf(row.querySelector('.bot-settings-manifest-label')),
            url: { ...styleOf(url, [...typography, 'whiteSpace', 'textOverflow', 'userSelect']),
              truncated: url.scrollWidth > url.clientWidth, height: url.getBoundingClientRect().height, title: url.title },
            copy: row.querySelector('[data-settings-copy-manifest]')?.getAttribute('aria-label') ?? null,
          };
        }),
        permissionLabels: live('.bot-settings-modal .bot-permission-label').map(label => styleOf(label)),
        reviewStatus: live('.bot-settings-modal .bot-settings-review-pending').map(status => styleOf(status)),
        // Text left at the browser default size is what made the old headings and labels look foreign.
        oversized: [...find(`#tab-panel-${scope}`).querySelectorAll('*')]
          .filter(element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) &&
            !element.closest('.bot-settings-identity, .material-symbols-outlined') && element.checkVisibility() &&
            parseFloat(getComputedStyle(element).fontSize) > 14)
          .map(element => `${element.tagName.toLowerCase()}.${element.className}: ${element.textContent.trim().slice(0, 40)}`),
      };
      yield `bot-${scope}`;
    }
    const recordedUrl = manifestUrl;
    manifestUrl = null;
    await modal.open('monky-bot');
    find('[data-settings-scope="user"]').click();
    await flush();
    const missing = find('.bot-settings-modal [data-bot-manifest-missing]');
    const muted = styleOf(find('.bot-settings-modal #bot-settings-panel > .bot-settings-description'));
    bot.missing = { text: missing.textContent, ...styleOf(missing), copy: !!document.querySelector('[data-settings-copy-manifest]'),
      mutedFontSize: muted.fontSize, mutedColor: muted.color };
    yield 'bot-manifest-missing';
    manifestUrl = recordedUrl;
  } finally {
    modal.close();
  }

  const store = new servers.ServerStore();
  const member = id => ({ id, clientId: `${id}-key`, sessionId: `${id}-session`, nickname: id, status: 'ONLINE', joinedAt: 1 });
  store.setServerDetails({
    id: 'server-a', name: 'Server A', serverVersion: '44.7.9', createdAt: 1, maxUsers: 0, hasPassword: false,
    iconUrl: null, voiceMode: 'p2p', turnEnabled: false, turnAvailability: { supported: false, reason: 'not-installed', autoInstallable: true },
    allowSoundboard: true, recentSoundCacheEnabled: true, recentSoundCacheLimit: 20, dmRelayEnabled: true,
    allowEveryoneMention: true, allowMessageEdit: true, showRoleBadgesToEveryone: true, messageDeleteUndoSeconds: 60,
    protocol: { version: 38, minimumVersion: 35, features: ['message-length-setting', 'message-delete-undo', 'recent-sounds', 'dm-relay', 'role-deny', 'role-grants'] },
    channels: [], members: [member('admin')], knownMembers: [member('admin')], voiceStates: {}, roles: [], userRoles: [],
    ownerId: 'admin', myPermissions: 0xFFFFFFFF,
    attachmentStorage: { usedBytes: 0, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 },
  }, member('admin'));
  const client = new networks.NetworkClient();
  client.sessionKey = 'server-a';
  client.getStatus = () => 'CONNECTED';
  client.getCurrentServerUrl = () => 'wss://server-a.example/';
  client.getHttpBaseUrl = () => window.location.origin;
  client.sendRequest = (type) => {
    if (type === 'COMMUNITY_GET') return Promise.resolve({ settings: { eventsEnabled: true, bannerUrl: null }, events: [], liveActions: [] });
    if (type === 'BOT_LIST') return Promise.resolve({ bots: [] });
    return new Promise(() => {});
  };
  servers.setActiveServerStore(store);
  networks.setActiveNetworkClient(client);
  const community = new CommunityFeed(client, store);
  await community.load();
  sessionManager.getActive = () => ({ community });
  const serverModal = new ServerSettingsModal();
  const standard = {};
  try {
    serverModal.open();
    await flush();
    standard.sidebarTitle = styleOf(find('.server-settings-modal-card .settings-sidebar > :first-child'));
    standard.headerTitle = styleOf(find('#server-settings-tab-title'));
    standard.sectionTitle = styleOf(find('[data-settings-section="message-limit"] label[for="input-message-limit"]'));
    standard.rowTitle = styleOf(find('[data-settings-section="member-limit"] div[style*="font-weight: 600"]'));
    standard.description = styleOf(find('[data-settings-section="message-limit"] small'));
    standard.tabs = live('.server-settings-modal-card .settings-tab-btn').map(tabMetrics);
    standard.menu = subsectionMenu(find('.server-settings-modal-card .settings-tab-btn.active'));
    standard.links = live('.server-settings-modal-card .settings-section-link').map(link => ({ text: link.textContent, ...styleOf(link) }));
    yield 'server-general';
  } finally {
    serverModal.close();
    sessionManager.getActive = previous.active;
    networks.setActiveNetworkClient(previous.client);
    servers.setActiveServerStore(previous.server);
  }
  if (dump) return { bot, standard };

  const tabKeys = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap'];
  const standardInactive = standard.tabs.find(tab => !tab.active && tab.lines === 1);
  const standardActive = standard.tabs.find(tab => tab.active);
  check(standardInactive && standardActive && standardActive.lines === 1,
    'The server settings reference renders single-line inactive and active tabs');
  for (const scope of ['user', 'server', 'permissions']) {
    for (const tab of bot[scope].tabs) {
      same(tab, tab.active ? standardActive : standardInactive, tabKeys,
        `Bot tab "${tab.label}" (${tab.active ? 'active' : 'inactive'}) uses the standard settings tab typography`);
      check(tab.lines === 1 && Math.abs(tab.height - standardInactive.height) < 0.5,
        `Bot tab "${tab.label}" stays on one line with the standard height (${tab.lines} lines, ${tab.height}px)`);
    }
  }
  same(bot.sidebarTitle, standard.sidebarTitle, ['fontFamily', 'fontSize', 'fontWeight', 'textTransform', 'color'],
    'The bot sidebar title matches the standard settings sidebar title');
  same(bot.headerTitle, standard.headerTitle, ['fontFamily', 'fontSize', 'fontWeight', 'color'],
    'The bot header title matches the standard settings header title');
  for (const scope of ['user', 'server', 'permissions']) {
    check(bot[scope].headings.every(heading => heading.className.includes('bot-settings-section-title')),
      `The ${scope} tab has no unstyled browser-default headings: ${JSON.stringify(bot[scope].headings.map(heading => heading.text))}`);
    for (const title of bot[scope].sectionTitles) {
      same(title, standard.sectionTitle, ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'color'],
        `Section title "${title.text}" in the ${scope} tab uses the standard settings section title style`);
    }
  }
  check(bot.server.sectionTitles.some(title => title.text === 'Música' || title.text === 'Music'),
    'The shared form keeps its declared title as a standard section title');
  for (const scope of ['server', 'permissions']) {
    check(!bot[scope].menu.expanded && bot[scope].menu.links.length === 0,
      `The ${scope} tab has a single section, so it shows no subsection menu repeating it: ${JSON.stringify(bot[scope].menu)}`);
  }
  check(bot.user.menu.expanded && bot.user.menu.links.length >= 2,
    `The personal tab, with several sections, keeps the standard subsection menu: ${JSON.stringify(bot.user.menu)}`);
  check(!bot.permissions.tabs.some(tab => bot.permissions.sectionTitles.some(title => title.text === tab.label)),
    'The permissions panel does not repeat the tab name as a section title');
  const standardLink = standard.links[0];
  check(!!standardLink, 'The server settings reference shows a subsection menu');
  for (const link of bot.user.links) {
    same(link, standardLink, ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight'],
      `Bot subsection link "${link.text}" uses the standard subsection typography`);
  }
  check(bot.missing.text === t('botSettings.manifestMissing') && !bot.missing.copy &&
    bot.missing.fontSize === bot.missing.mutedFontSize && bot.missing.color === bot.missing.mutedColor,
  `A bot without a recorded manifest shows only the muted explanation: ${JSON.stringify(bot.missing)}`);
  for (const scope of ['user', 'server', 'permissions']) {
    const rows = bot[scope].manifest;
    check(rows.length === 1, `The ${scope} tab shows the manifest URL once, in the bot header`);
    same(rows[0].label, standard.sectionTitle, ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'color'],
      `The manifest label in the ${scope} tab uses the standard section label`);
    check(rows[0].url.whiteSpace === 'nowrap' && rows[0].url.textOverflow === 'ellipsis' && rows[0].url.truncated &&
      rows[0].url.userSelect === 'text' && rows[0].url.title === manifestUrl,
    `A long manifest URL stays on one selectable line with an ellipsis and its full value in the tooltip: ${JSON.stringify(rows[0].url)}`);
    check(rows[0].copy === t('botSettings.manifestCopy'), 'The copy button has a localized accessible name');
  }
  check(bot.permissions.permissionLabels.length > 0, 'The permissions tab lists capability switches');
  for (const label of bot.permissions.permissionLabels) {
    same(label, standard.rowTitle, ['fontFamily', 'fontSize', 'fontWeight', 'color'],
      'Capability switch titles use the standard settings row title instead of the browser label default');
  }
  check(bot.permissions.reviewStatus.length === 1, 'A pending review is announced in the permissions tab');
  same(bot.permissions.reviewStatus[0], standard.rowTitle, ['fontFamily', 'fontSize', 'fontWeight'],
    'The pending review status uses the standard row title size instead of a default paragraph');
  for (const scope of ['user', 'server', 'permissions']) {
    check(bot[scope].oversized.length === 0, `The ${scope} tab has no text at browser default sizes: ${bot[scope].oversized.join('; ')}`);
  }
  check(t('botSettings.serverTab') !== 'botSettings.serverTab', 'Tab labels are localized');
  return checks;
}
