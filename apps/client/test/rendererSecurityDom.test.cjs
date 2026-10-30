const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('server data stays text in chat, forum, settings, menus, stage and overlay; the QR camera never outlives its dialog', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `renderer-security-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_RENDERER_SECURITY_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
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
  app.setPath('userData', process.env.MONKY_RENDERER_SECURITY_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let browser;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false },
      plugins: [{
        name: 'renderer-security-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__renderer_security__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
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
    browser = new BrowserWindow({
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Fixture hosts such as call.example never leave the machine.
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: !['data:', 'blob:'].includes(url.protocol) && url.hostname !== '127.0.0.1' });
    });
    timeout = setTimeout(() => { console.error('Renderer security DOM timed out'); void finish(1); }, 100000);
    await browser.loadURL(`http://127.0.0.1:${http.address().port}/__renderer_security__`);
    const checks = await browser.webContents.executeJavaScript(`(${runRendererSecurity.toString()})()`, true);
    console.log(`Renderer security DOM: ${checks} checks passed (hostile ids, names, colors, numbers and addresses in chat, forum, server settings, user menu, voice stage and overlay; QR camera lifecycle)`);
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRendererSecurity() {
  let checks = 0;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks++;
  };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await frame();
  };
  // Leaves an attribute and opens an element: either way, running it bumps the counter.
  const HOSTILE = 'x" onerror="window.hostileRuns++" data-x="><img src=x onerror="window.hostileRuns++">';
  window.hostileRuns = 0;
  const handlers = element => [...element.querySelectorAll('*')].flatMap(node =>
    [...node.attributes].filter(attribute => /^on/i.test(attribute.name)).map(attribute => `${node.tagName}[${attribute.name}]`));
  const inert = (element, where) => {
    check(handlers(element).length === 0, `${where}: no inline handler was injected (${handlers(element).join()})`);
    check(!element.querySelector('img[src="x"]'), `${where}: no element was injected`);
  };

  const [{ sessionManager }, { voiceStore: voice }, { DEFAULT_AVATAR_URL }, { ChatView }, { ServerMembersTab },
    { ServerRolesTab }, { ServerGeneralTab }, { ServerVoiceVideoTab }, { userContextMenu }, { VoiceStageView },
    { OverlayBridgeService }, { OverlayStageView }, { showIdentityImportDialog }, { stickerToken }, language,
    { settingsStore }, { ForumView }] = await Promise.all([
    import('/core/SessionManager.ts'), import('/stores/voiceStore.ts'), import('/utils/avatar.ts'), import('/views/ChatView.ts'),
    import('/views/serverSettings/tabs/ServerMembersTab.ts'), import('/views/serverSettings/tabs/ServerRolesTab.ts'),
    import('/views/serverSettings/tabs/ServerGeneralTab.ts'), import('/views/serverSettings/tabs/ServerVoiceVideoTab.ts'),
    import('/views/UserContextMenu.ts'), import('/views/VoiceStageView.ts'), import('/core/OverlayBridgeService.ts'),
    import('/views/OverlayStageView.ts'), import('/views/IdentityDialogs.ts'), import('/utils/stickers.ts'), import('/i18n/index.ts'),
    import('/stores/settingsStore.ts'), import('/views/ForumView.ts'),
  ]);
  language.setLanguage('en');
  const app = document.getElementById('app');
  const area = () => {
    const element = document.createElement('div');
    element.style.cssText = 'height:700px;width:1000px;display:flex;flex-direction:column;';
    app.replaceChildren(element);
    return element;
  };

  sessionManager.install();
  const session = sessionManager.create('hostile.example', 7001, 'Me');
  const foreground = sessionManager.create('other.example', 7002, 'Me');
  for (const entry of [session, foreground]) {
    entry.client.getStatus = () => 'CONNECTED';
    entry.client.getCurrentServerUrl = () => entry.key;
    entry.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
    entry.client.send = () => {};
    entry.client.sendRequest = async (type, payload) => type === 'ADMIN_GET_VOICE_RESTRICTIONS'
      ? { userId: payload.targetUserId, serverMuted: false, serverDeafened: false } : { selectors: [] };
  }
  // Attachments resolve against this page, the stand-in for the server that serves them.
  session.client.getHttpBaseUrl = () => location.origin;
  foreground.client.getHttpBaseUrl = () => 'http://other.example:7002';

  const me = { id: 'me', clientId: 'me-device', sessionId: 'me:device', nickname: 'Me', status: 'ONLINE', joinedAt: 1 };
  const hostileMember = { id: HOSTILE, clientId: 'hostile-device', sessionId: HOSTILE, nickname: 'Hostile <b>member</b>',
    avatarUrl: HOSTILE, status: 'ONLINE', joinedAt: 2 };
  const listener = { id: 'listener', clientId: 'listener-device', sessionId: `${HOSTILE}-listener`, nickname: 'Listener',
    avatarUrl: '/avatars/listener-1.png', status: 'ONLINE', joinedAt: 3 };
  const hostileRole = { id: HOSTILE, name: 'Hostile <i>role</i>', color: 'red;"><img src=x onerror="window.hostileRuns++">',
    position: 2, permissions: 0, isDefault: false };
  const adminRole = { id: `admin-${HOSTILE}`, name: 'Admin', color: '#ff0000', position: 3, permissions: 2147483647, isDefault: false };
  const voiceChannel = { id: HOSTILE, serverId: 'server', name: 'Hostile <i>room</i>', type: 'VOICE', position: 1, createdAt: 1,
    isPrivate: false, allowedRoleIds: [] };
  const forumChannel = { id: 'forum', serverId: 'server', name: 'Forum', type: 'FORUM', position: 2, createdAt: 1,
    isPrivate: false, allowedRoleIds: [] };
  session.serverStore.setServerDetails({
    id: HOSTILE, name: 'Hostile server', createdAt: 1, maxUsers: 10, voiceStates: {}, allowMessageEdit: true,
    maxMessageLength: HOSTILE, voiceMode: HOSTILE, recentSoundCacheLimit: HOSTILE, recentSoundCacheEnabled: true,
    allowSoundboard: true, iconUrl: HOSTILE,
    protocol: { version: 40, minimumVersion: 1, features: ['message-length-setting', 'recent-sounds'] },
    channels: [{ id: 'chat', serverId: 'server', name: 'chat', type: 'TEXT', position: 0, createdAt: 1, isPrivate: false,
      allowedRoleIds: [], botCommandsEnabled: true }, voiceChannel, forumChannel],
    members: [me, hostileMember, listener], knownMembers: [me, hostileMember, listener],
    roles: [adminRole, hostileRole], userRoles: [{ userId: HOSTILE, roleIds: [HOSTILE] }],
    // Only the owner is offered administrator changes (#397); owning it keeps the Admin role id on screen.
    ownerId: me.id, myPermissions: 2147483647,
  }, me);
  foreground.serverStore.setServerDetails({
    id: 'other', name: 'Other server', createdAt: 1, maxUsers: 10, voiceStates: {}, channels: [], members: [me],
    knownMembers: [me], roles: [], userRoles: [], ownerId: 'owner', myPermissions: 0,
  }, me);
  sessionManager.activate(session.key);
  session.participants.setUsers([me, hostileMember, listener]);
  const voiceState = (person, extra = {}) => ({
    userId: person.id, sessionId: person.sessionId, channelId: voiceChannel.id, isMuted: false, isDeafened: false,
    isSpeaking: false, isCameraOn: false, isScreenSharing: false, serverMuted: false, serverDeafened: false, ...extra,
  });
  session.participants.updateVoiceState(voiceState(me));
  session.participants.updateVoiceState(voiceState(hostileMember, {
    isCameraOn: true, isScreenSharing: true, screenShareIds: ['share-watched', 'share-locked'],
  }));
  session.participants.updateVoiceState(voiceState(listener));

  // R-CHAT-2: attachment, sticker and mention addresses come from the server.
  const chatRoot = area();
  const attachment = (id, kind, mimeType, url = HOSTILE) => ({
    id, messageId: 'hostile-message', kind, url, originalName: `Hostile ${id} <b>name</b>`, mimeType, sizeBytes: 10, createdAt: 1,
  });
  session.chatStore.setHistory('chat', [
    { id: 'hostile-message', channelId: 'chat', userId: HOSTILE, userNickname: hostileMember.nickname, userAvatarUrl: HOSTILE,
      createdAt: 1, isSystem: false, content: 'Files', attachments: [
        attachment('image', 'image', 'image/png'), attachment('video', 'video', 'video/webm'),
        attachment('audio', 'file', 'audio/wav'), attachment('file', 'file', 'application/pdf'),
      ] },
    { id: 'sticker-message', channelId: 'chat', userId: HOSTILE, userNickname: hostileMember.nickname, createdAt: 2,
      isSystem: false, content: stickerToken('hostile-sticker'),
      attachments: [{ ...attachment('hostile-sticker', 'image', 'image/png'), messageId: 'sticker-message' }] },
    { id: 'legit-message', channelId: 'chat', userId: 'me', userNickname: 'Me', createdAt: 3, isSystem: false, content: '',
      attachments: [{ ...attachment('legit', 'image', 'image/png', '/attachments/legit-1.png'), messageId: 'legit-message' }] },
  ]);
  const chat = new ChatView(chatRoot);
  chat.setChannel('chat');
  await settle();
  const hostileRow = chatRoot.querySelector('[data-message-id="hostile-message"]');
  check(hostileRow?.querySelectorAll('[data-download-url]').length === 4, 'Every hostile attachment still renders its card');
  check([...hostileRow.querySelectorAll('[data-download-url], [data-lightbox-url]')].every(node =>
    (node.getAttribute('data-download-url') ?? node.getAttribute('data-lightbox-url')) === ''),
  'A server address outside /attachments/ resolves to nothing instead of being kept');
  check([...hostileRow.querySelectorAll('.chat-attachment-image, .chat-attachment-video, .chat-attachment-audio')]
    .every(media => media.getAttribute('src') === ''), 'Hostile attachment media never load a server-chosen address');
  check(hostileRow.querySelector('.chat-attachment-file').dataset.fileName === 'Hostile file <b>name</b>',
    'Attachment names round-trip as plain attribute text');
  const sticker = chatRoot.querySelector('[data-message-id="sticker-message"] .chat-sticker-save');
  check(sticker?.dataset.stickerUrl === HOSTILE && sticker.dataset.stickerName === 'Hostile hostile-sticker <b>name</b>',
    'The sticker keeps the raw server value as text, for the resolver to refuse');
  check(chatRoot.querySelector('[data-message-id="sticker-message"] img.chat-sticker').getAttribute('src') === '',
    'A hostile sticker address is not loaded');
  const legit = chatRoot.querySelector('[data-message-id="legit-message"] .chat-attachment-download');
  check(legit?.dataset.downloadUrl === `${location.origin}/attachments/legit-1.png`,
    'The server\'s own attachment paths keep resolving against its address');
  chat.mentions.matches = [{ kind: 'user', user: hostileMember }];
  chat.mentions.activeIndex = 0;
  chat.mentions.render();
  await settle();
  const mention = chatRoot.querySelector('#mention-dropup .mention-item');
  check(mention?.querySelector('.mention-avatar').getAttribute('src') === DEFAULT_AVATAR_URL
    && mention.querySelector('.mention-nick').textContent === hostileMember.nickname,
  'The mention list shows the default picture for a hostile avatar and the nickname as text');
  inert(chatRoot, 'Chat');
  chat.destroy();

  // R-MODALS-1: members, roles, the General and Voice/Video tabs.
  const settingsRoot = area();
  settingsRoot.innerHTML = [new ServerMembersTab().renderHtml(), new ServerRolesTab().renderHtml(),
    new ServerGeneralTab().renderHtml(), new ServerVoiceVideoTab().renderHtml()].join('');
  await settle();
  inert(settingsRoot, 'Server settings');
  check([...settingsRoot.querySelectorAll('.member-actions-trigger')].some(button => button.dataset.userId === HOSTILE),
    'Member ids round-trip as attribute text');
  check([...settingsRoot.querySelectorAll('[data-member-action="toggle-role"]')].some(button => button.dataset.roleId === HOSTILE)
    && [...settingsRoot.querySelectorAll('[data-member-action="toggle-admin"]')].some(button => button.dataset.roleId === adminRole.id),
  'Role ids in the member menu round-trip as attribute text');
  check([...settingsRoot.querySelectorAll('.role-table-row')].some(row => row.dataset.roleId === HOSTILE),
    'Role rows keep hostile ids as text');
  check(![...settingsRoot.querySelectorAll('[style]')].some(node => node.getAttribute('style').includes('red;')),
    'A role color that is not hex never reaches a style');
  check(!!settingsRoot.querySelector('[data-member-action="toggle-role"] .role-option'),
    'The member menu uses the shared, escaping role option');
  check([...settingsRoot.querySelectorAll('img[data-fallback="avatar"]')].every(image =>
    image.getAttribute('src') !== HOSTILE), 'Member avatars never keep a hostile address');
  check(settingsRoot.querySelector('#server-icon-preview').getAttribute('src') === DEFAULT_AVATAR_URL,
    'A hostile server icon falls back to the default picture');
  check(settingsRoot.querySelector('#input-message-limit').getAttribute('value') === HOSTILE
    && settingsRoot.querySelector('#input-server-voice-mode').getAttribute('value') === HOSTILE
    && settingsRoot.querySelector('#input-recent-sounds-limit').getAttribute('value') === HOSTILE,
  'Hostile values in number and hidden fields stay attribute text');
  check([...settingsRoot.querySelectorAll('div')].some(node => node.textContent.trim() === `ID: ${HOSTILE}`),
    'The server id is shown as text');

  // R-MODALS-1: the member context menu.
  userContextMenu.open(30, 30, hostileMember);
  await settle();
  const menu = document.querySelector('.user-context-menu:not([data-ui-closing])');
  check(!!menu, 'The member menu opens');
  inert(menu, 'Member menu');
  check(menu.querySelector('.context-menu-avatar').getAttribute('src') === DEFAULT_AVATAR_URL,
    'The menu shows the default picture for a hostile avatar');
  check(menu.querySelector('[data-action="move-user"]')?.dataset.channelId === HOSTILE
    && menu.querySelector('[data-action="move-user"]').textContent.includes(voiceChannel.name),
  'Channel ids and names in the move menu stay text');
  check(menu.querySelector('[data-action="toggle-role"]')?.dataset.roleId === HOSTILE
    && menu.querySelector('[data-action="toggle-admin"]')?.dataset.roleId === adminRole.id,
  'Role ids in the menu round-trip as attribute text');
  userContextMenu.close();

  // Forum counters and the composer limit come from the server as well.
  const forumPost = (channelId, extra) => ({
    channelId, forumId: forumChannel.id, authorId: 'me', createdAt: 1, updatedAt: 2, pinned: false, locked: false,
    closed: false, firstMessageId: null, ...extra,
  });
  const forumPosts = [
    forumPost('hostile-post', { title: 'Hostile <b>post</b>', preview: 'Hostile <i>preview</i>', authorId: HOSTILE,
      pinned: true, locked: true, closed: true, replyCount: '<img src="https://tracker.example/pixel.png">', reactionCount: HOSTILE,
      // Glued to the base, "@host" turned the server's address into credentials for another host.
      thumbnailUrl: '@tracker.example/forum.png' }),
    forumPost('honest-post', { title: 'Honest post', preview: 'Hello', replyCount: 3, reactionCount: 2,
      thumbnailUrl: '/attachments/forum-1.png' }),
  ];
  const baseRequest = session.client.sendRequest;
  session.client.sendRequest = async (type, payload) => type === 'FORUM_LIST'
    ? { channelId: payload.channelId, posts: structuredClone(forumPosts), hasMore: false, nextOffset: 0 }
    : baseRequest(type, payload);
  const openForum = async () => {
    const root = area();
    const view = new ForumView(root, session.client, session.serverStore, forumChannel.id, () => {});
    for (let attempt = 0; attempt < 50 && root.querySelectorAll('[data-forum-id]').length < forumPosts.length; attempt++) await settle();
    return { root, view };
  };
  try {
    const { root: forumRoot, view: forum } = await openForum();
    const row = id => forumRoot.querySelector(`[data-forum-id="${id}"]`);
    const counters = id => [...row(id).querySelectorAll('.forum-post-stats > span[title]')]
      .map(counter => counter.lastChild?.textContent.trim());
    check(!!row('hostile-post') && !!row('honest-post'), 'Both forum posts render');
    inert(forumRoot, 'Forum list');
    check(!forumRoot.querySelector('img[src*="tracker.example"]'), 'A forum counter carrying markup adds no tracking image');
    check(row('honest-post').querySelector('.forum-post-thumbnail')?.getAttribute('src') === `${location.origin}/attachments/forum-1.png`
      && !row('hostile-post').querySelector('.forum-post-thumbnail'),
    'Forum thumbnails resolve against their server, and an address it never stores draws nothing (R-COMMUNITY-11)');
    check(counters('hostile-post').join() === '0,0' && counters('honest-post').join() === '3,2',
      'Forum counters render only whole numbers, and real counts are kept');
    check(row('hostile-post').querySelector('h3').textContent.includes('Hostile <b>post</b>')
      && row('hostile-post').querySelector('p').textContent === 'Hostile <i>preview</i>'
      && row('hostile-post').querySelector('.forum-post-author').textContent === hostileMember.nickname,
    'Forum titles, previews and authors stay text');
    forumRoot.querySelector('[data-forum-create]').click();
    await settle();
    const composer = forumRoot.querySelector('[data-forum-composer]');
    const message = composer?.querySelector('textarea[name="content"]');
    check(!!message && !message.hasAttribute('maxlength'), 'A message limit that is not a whole number never reaches the composer');
    inert(composer, 'Forum composer');
    forum.destroy();
    session.serverStore.serverDetails.maxMessageLength = 500;
    const { root: limitedRoot, view: limited } = await openForum();
    limitedRoot.querySelector('[data-forum-create]').click();
    await settle();
    check(limitedRoot.querySelector('[data-forum-composer] textarea[name="content"]')?.getAttribute('maxlength') === '500',
      'A whole-number message limit still reaches the composer');
    limited.destroy();
  } finally {
    session.serverStore.serverDetails.maxMessageLength = HOSTILE;
    session.client.sendRequest = baseRequest;
  }

  // R-VOICEUI-5: session ids and avatars on the voice stage.
  voice.setChannel(voiceChannel.id, session.key);
  voice.setScreenWatching(HOSTILE, 'share-watched', true);
  const stageRoot = area();
  const stage = new VoiceStageView(stageRoot);
  stage.setChannel(voiceChannel.id);
  await settle();
  inert(stageRoot, 'Voice stage');
  check([...stageRoot.querySelectorAll('[data-watch-session]')].some(button => button.dataset.watchSession === HOSTILE),
    'A locked broadcast keeps the session id as attribute text');
  check([...stageRoot.querySelectorAll('[data-kind="screen"]')].some(card => card.dataset.sessionId === HOSTILE
      && card.querySelector('.stage-volume-wrapper .stage-screen-volume-slider'))
    && [...stageRoot.querySelectorAll('[data-stopwatch-session]')].some(button => button.dataset.stopwatchSession === HOSTILE),
  'Watched broadcast controls keep the session id as attribute text');
  const cameraId = `video-${HOSTILE}-camera`;
  check(!!document.getElementById(cameraId)
    && [...stageRoot.querySelectorAll('[data-fullscreen-target]')].some(button => button.dataset.fullscreenTarget === cameraId),
  'Video ids built from the session id still pair each control with its video');
  check([...stageRoot.querySelectorAll('.stage-avatar-img')].length > 0
    && [...stageRoot.querySelectorAll('.stage-avatar-img')].every(image => image.getAttribute('src') !== HOSTILE),
  'Stage avatars never keep a hostile address');
  stage.destroy();

  // R-MEDIA-1: the overlay resolves avatars against the call's server and escapes what it receives.
  sessionManager.activate(foreground.key);
  session.client.getHttpBaseUrl = () => 'http://call.example:7001';
  const previousApi = window.api;
  const previousOverlayConfig = settingsStore.getOverlayConfig();
  settingsStore.setOverlayConfig({ ...previousOverlayConfig, hideSelf: false, hideInactiveParticipants: false, minimalistMode: false });
  const overlayCallbacks = new Map();
  let overlayState = null;
  window.api = {
    sendOverlaySyncState: async next => { overlayState = next; },
    onOverlaySyncStateReceived: callback => { overlayCallbacks.set('state', callback); return () => overlayCallbacks.delete('state'); },
    onOverlayConfigUpdated: callback => { overlayCallbacks.set('config', callback); return () => overlayCallbacks.delete('config'); },
  };
  const overlayRoot = area();
  const overlay = new OverlayStageView(overlayRoot);
  try {
    const bridge = new OverlayBridgeService();
    bridge.isOpen = true;
    bridge.syncState();
    const avatars = new Map(overlayState?.participants.map(participant => [participant.userId, participant.avatarUrl]));
    check(avatars.get(listener.id) === 'http://call.example:7001/avatars/listener-1.png',
      'Overlay avatars resolve against the call\'s server while another server is on screen');
    check(avatars.get(HOSTILE) === DEFAULT_AVATAR_URL, 'A hostile overlay avatar falls back to the default picture');
    overlay.init();
    for (const minimalistMode of [false, true]) {
      overlayCallbacks.get('state')({
        ...overlayState,
        config: { ...overlayState.config, minimalistMode, hideInactiveParticipants: false, focusActiveSpeaker: false },
        participants: overlayState.participants.map(participant => participant.userId === HOSTILE
          ? { ...participant, avatarUrl: HOSTILE, displayName: HOSTILE, isCameraOn: true, videoSlotIndex: 0 }
          : { ...participant, avatarUrl: HOSTILE, displayName: `<b>${participant.displayName}</b>` }),
      });
      await settle();
      inert(overlayRoot, `Overlay (${minimalistMode ? 'minimalist' : 'cards'})`);
      const pictures = [...overlayRoot.querySelectorAll('.overlay-avatar-img, .overlay-mini-avatar')];
      check(pictures.length > 0 && pictures.every(image => image.getAttribute('src') === HOSTILE && image.dataset.fallback === 'avatar'),
        `Overlay pictures keep even a forged address as attribute text and fall back to the avatar (${minimalistMode})`);
      if (!minimalistMode) {
        check(overlayRoot.querySelector('video')?.id === `vid-${HOSTILE}-cam`, 'Overlay video ids keep the session id as text');
      }
    }
  } finally {
    overlay.destroy();
    window.api = previousApi;
    settingsStore.setOverlayConfig(previousOverlayConfig);
    document.body.classList.remove('overlay-window-mode');
    voice.setChannel(null);
    sessionManager.activate(session.key);
  }

  await new Promise(resolve => setTimeout(resolve, 150));
  check(window.hostileRuns === 0, 'No hostile value ever ran');

  // R-MODALS-3: the QR scanner camera.
  app.replaceChildren();
  const pendingCameras = [];
  const mediaDevices = navigator.mediaDevices;
  const getUserMedia = Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia');
  Object.defineProperty(mediaDevices, 'getUserMedia', {
    configurable: true, writable: true,
    value: () => new Promise((resolve, reject) => pendingCameras.push({ resolve, reject })),
  });
  const camera = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const stream = canvas.captureStream();
    return { stream, track: stream.getVideoTracks()[0] };
  };
  const dialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing])');
  const scanButton = () => dialog().querySelector('#btn-import-identity-scan');
  try {
    let closed = showIdentityImportDialog();
    await settle();
    scanButton().click();
    await settle();
    check(pendingCameras.length === 1 && scanButton().disabled && scanButton().getAttribute('aria-busy') === 'true',
      'Starting the camera keeps the scan button busy');
    scanButton().click();
    await settle();
    check(pendingCameras.length === 1, 'A second click while the camera starts does not open another one');
    dialog().querySelector('[data-action="cancel"]').click();
    check(await closed === null, 'Closing during the camera start ends the dialog');
    const late = camera();
    pendingCameras.shift().resolve(late.stream);
    await settle();
    check(late.track.readyState === 'ended', 'A camera that answers after the dialog closed is switched off at once');

    closed = showIdentityImportDialog();
    await settle();
    scanButton().click();
    await settle();
    const running = camera();
    pendingCameras.shift().resolve(running.stream);
    await settle();
    const video = dialog().querySelector('#identity-import-video');
    check(video.srcObject === running.stream && running.track.readyState === 'live' && !scanButton().disabled
      && scanButton().textContent === language.t('identity.stopScan'), 'A started scan shows the camera and offers to stop');
    scanButton().click();
    await settle();
    check(running.track.readyState === 'ended' && video.srcObject === null && scanButton().textContent === language.t('identity.scanQr'),
      'Stopping the scan switches the camera off');
    scanButton().click();
    await settle();
    const stopped = camera();
    pendingCameras.shift().resolve(stopped.stream);
    await settle();
    dialog().querySelector('[data-action="cancel"]').click();
    await closed;
    check(stopped.track.readyState === 'ended', 'Closing the dialog switches a running camera off');

    closed = showIdentityImportDialog();
    await settle();
    scanButton().click();
    await settle();
    pendingCameras.shift().reject(new DOMException('Camera unavailable', 'NotReadableError'));
    await settle();
    const refusal = document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
    check(refusal?.getAttribute('role') === 'alert' && refusal.textContent.includes('Camera unavailable')
      && !dialog().querySelector('#identity-import-error')
      && !scanButton().disabled && scanButton().getAttribute('aria-busy') === null,
    'A refused camera reports the error in the alert toast and frees the scan button');
    dialog().querySelector('[data-action="cancel"]').click();
    await closed;
  } finally {
    if (getUserMedia) Object.defineProperty(mediaDevices, 'getUserMedia', getUserMedia);
    else delete mediaDevices.getUserMedia;
  }
  check(pendingCameras.length === 0, 'Every camera request was answered');
  return checks;
}
