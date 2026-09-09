const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');

if (require.main === module || process.versions.electron) {
  if (!process.versions.electron) {
    const profile = path.join(clientRoot, 'dist-test', `user-menu-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_USER_MENU_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
    const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
    child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
  } else {
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', process.env.MONKY_USER_MENU_PROFILE);
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
          name: 'user-menu-fixture',
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              if (request.url !== '/__user_menu__') return next();
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
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
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      timeout = setTimeout(() => { console.error('User menu smoke timed out'); void finish(1); }, 45_000);
      await window.loadURL(`http://127.0.0.1:${address.port}/__user_menu__`);
      const checks = await window.webContents.executeJavaScript(`(${runUserContextMenuSmoke.toString()})()`, true);
      console.log(`User context menu smoke: ${checks} checks passed`);
      await finish(0);
    }).catch(async (error) => { console.error(error); await finish(1); });
  }
}

async function runUserContextMenuSmoke() {
  const [{ userContextMenu: menu }, servers, participants, { voiceStore: voice },
    { settingsStore: settings }, { networkClient: network }, { audioProcessor: audio },
    { webRtcManager: rtc }, { soundEffects: sounds }, { appEvents }, language,
    { connectionStore: connection }] = await Promise.all([
    import('/views/UserContextMenu.ts'), import('/stores/serverStore.ts'),
    import('/core/ParticipantManager.ts'), import('/stores/voiceStore.ts'),
    import('/stores/settingsStore.ts'), import('/core/NetworkClient.ts'),
    import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    import('/core/SoundEffects.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
    import('/stores/connectionStore.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const delay = () => new Promise(resolve => setTimeout(resolve, 20));
  const find = selector => document.querySelector(`.user-context-menu ${selector}`);
  const button = action => find(`[data-action="${action}"]`);
  const click = action => { check(!!button(action), `${action} action exists`); button(action).click(); };
  const currentServer = servers.getActiveServerStore();
  const server = servers.createServerStore();
  const manager = participants.createParticipantManager();
  const user = { id: 'menu-local', sessionId: 'local-session', clientId: 'local-client', nickname: '<b>Local</b>', status: 'ONLINE', joinedAt: 1 };
  const second = { ...user, sessionId: 'second-session' };
  const remote = { ...user, id: 'menu-remote', clientId: 'remote-client', sessionId: 'remote-session', nickname: 'Remote' };
  const state = who => ({
    userId: who.id, sessionId: who.sessionId, channelId: 'room', isMuted: false, isDeafened: false,
    serverMuted: false, serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false,
  });
  const originals = {
    send: network.send, request: network.sendRequest, play: sounds.play, peerVolume: rtc.setPeerVolume,
    save: settings.save, voiceChannel: voice.currentVoiceChannelId, voiceSession: voice.voiceSessionKey,
    muted: voice.isMuted, deafened: voice.isDeafened, serverMuted: voice.serverMuted, serverDeafened: voice.serverDeafened,
    settingsMuted: settings.isMuted, settingsDeafened: settings.isDeafened, clientId: connection.clientId,
    language: language.getLanguage(), volumes: { ...settings.userVolumes },
  };
  const requests = [];
  const sent = [];
  const volumes = [];
  network.send = (type, payload) => sent.push({ type, payload });
  network.sendRequest = async (type, payload) => { requests.push({ type, payload }); };
  sounds.play = () => {};
  settings.save = () => {};
  rtc.setPeerVolume = (sessionId, volume) => volumes.push({ sessionId, volume });
  servers.setActiveServerStore(server);
  participants.setActiveParticipantManager(manager);
  connection.clientId = user.clientId;
  server.setServerDetails({
    id: 'menu-server', name: 'Menu fixture', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: ['room', 'other-room'].map((id, position) => ({
      id, serverId: 'menu-server', name: id, type: 'VOICE', position, createdAt: 1, isPrivate: false, allowedRoleIds: [],
    })),
    members: [user, second, remote], roles: [], userRoles: [], ownerId: 'owner', myPermissions: 0,
  }, user);
  for (const who of [second, user, remote]) { manager.addUser(who); manager.updateVoiceState(state(who)); }
  voice.currentVoiceChannelId = null;
  voice.voiceSessionKey = null;
  voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
  try {
    language.setLanguage('en');
    menu.open(30, 30, user);
    check(!!document.querySelector('.user-context-menu'), 'Own menu opens');
    check(find('.context-menu-nickname').textContent === user.nickname && !find('.context-menu-nickname b'), 'Own nickname is escaped');
    check(!find('#ctx-volume-slider') && !find('.context-menu-volume-section') && !find('.btn-ctx-quick'), 'Self has no volume controls');
    check(!find('input[type="checkbox"],input[type="radio"]'), 'No native checkboxes or radio buttons');
    check(!button('server-mute') && !button('toggle-role'), 'Permission-gated actions absent without permission');
    check(button('self-mute').textContent === 'Mute microphone', 'Initial manual microphone label');
    click('self-mute');
    check(voice.isMuted && settings.isMuted && button('self-mute').getAttribute('aria-pressed') === 'true', 'Pre-call mute preference persists and updates menu');
    check(sent.length === 0, 'Pre-call preferences do not send voice traffic');
    click('self-mute');
    click('self-deafen');
    check(voice.isDeafened && voice.isMuted && settings.isDeafened, 'Deafening also manually mutes');
    click('self-deafen');
    check(!voice.isMuted && !voice.isDeafened, 'Undeafen restores earlier microphone preference');
    voice.setMuted(true);
    check(button('self-mute').textContent === 'Unmute microphone', 'External mute updates open menu');
    language.setLanguage('pt-BR');
    check(button('self-mute').textContent === language.t('stage.unmuteMic'), 'Open self buttons follow language');
    voice.setServerMuted(true);
    click('self-mute');
    check(!voice.isMuted && voice.getEffectiveMuted() && voice.serverMuted && audio.isMuted, 'Manual unmute cannot bypass admin microphone block');
    voice.setServerDeafened(true);
    click('self-deafen');
    click('self-deafen');
    check(!voice.isDeafened && voice.getEffectiveDeafened() && voice.serverDeafened, 'Manual undeafen cannot bypass admin deafen');
    check(button('self-deafen').title === language.t('permissions.serverDeafened'), 'Admin deafen explained by tooltip');
    voice.serverMuted = voice.serverDeafened = false;
    voice.currentVoiceChannelId = 'room';
    click('self-mute');
    check(sent.length === 1 && sent[0].payload.isMuted === voice.isMuted, 'In-call manual action sends voice state');

    server.myPermissions = 2147483647;
    for (const action of ['server-mute', 'server-deafen', 'kick-voice', 'move-user']) {
      menu.open(30, 30, user);
      click(action);
      await delay();
      check(requests.at(-1).payload.targetSessionId === user.sessionId, `${action} targets own exact connection, never first same-user device`);
    }
    menu.open(30, 30, { ...user, sessionId: undefined });
    click('server-mute');
    await delay();
    check(requests.at(-1).payload.targetSessionId === user.sessionId, 'Own profile without session resolves this connection');
    menu.open(30, 30, user);
    manager.removeVoiceState(user.sessionId);
    const count = requests.length;
    click('server-mute');
    check(requests.length === count && !document.querySelector('.user-context-menu'), 'Departed local session never redirects moderation to another device');
    menu.open(30, 30, { ...user, sessionId: undefined });
    check(!button('server-mute') && !!button('self-mute'), 'Pre-call self profile does not expose other-device moderation');
    manager.updateVoiceState(state(user));

    for (const alias of [{ ...user, id: 'alias-id' }, { ...user, clientId: 'different-client' }]) {
      menu.open(30, 30, alias);
      check(!!button('self-mute') && !find('#ctx-volume-slider'), 'Self resolves by either user or nonempty client ID');
    }
    connection.clientId = '';
    server.currentUser = { ...user, clientId: '' };
    menu.open(30, 30, { ...remote, clientId: '' });
    check(!!find('#ctx-volume-slider') && !button('self-mute'), 'Empty client IDs do not classify strangers as self');
    server.currentUser = user;
    connection.clientId = user.clientId;

    menu.open(30, 30, remote);
    check(!!find('#ctx-volume-slider') && !button('self-mute'), 'Other-user menu retains volume but not local controls');
    find('#ctx-vol-200').click();
    check(volumes.at(-1).sessionId === remote.sessionId && volumes.at(-1).volume === 200, 'Remote boost retains per-session targeting');
    click('server-deafen');
    await delay();
    check(requests.at(-1).payload.targetSessionId === remote.sessionId, 'Other-user moderation target preserved');

    server.roles = [
      { id: 'custom-role', name: 'Custom', color: '#fff', permissions: 0, position: 1, isDefault: false },
      { id: 'admin-role', name: 'Admin', color: '#fff', permissions: 1 << 11, position: 2, isDefault: false },
    ];
    menu.open(30, 30, user);
    click('toggle-role');
    await delay();
    check(requests.at(-1).payload.userId === user.id, 'Permitted self role assignment remains available');
    menu.open(30, 30, user);
    click('toggle-admin');
    await delay();
    check(requests.at(-1).payload.userId === user.id && requests.at(-1).payload.roleId === 'admin-role',
      'Permitted self administrator assignment retains target and role');
    server.ownerId = user.id;
    menu.open(30, 30, user);
    check(!button('toggle-admin') && !!button('toggle-role'), 'Owner keeps roles but not redundant administrator toggle');

    for (const event of ['network.disconnected', 'voice.channel_changed', 'session.changed']) {
      menu.open(30, 30, user);
      appEvents.emit(event);
      check(!document.querySelector('.user-context-menu'), `${event} closes menu`);
    }
    menu.open(30, 30, user);
    menu.close();
    await delay();
    menu.open(30, 30, user);
    await delay();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    check(!document.querySelector('.user-context-menu'), 'Escape works after immediate close/reopen');
    menu.open(30, 30, user);
    await delay();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check(!document.querySelector('.user-context-menu'), 'Outside pointer closes menu');
    const listenerCount = () => [...appEvents.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
    const before = listenerCount();
    for (let attempt = 0; attempt < 5; attempt++) { menu.open(30, 30, user); menu.close(); }
    await delay();
    check(listenerCount() === before, 'Repeated close removes all menu EventBus subscriptions');
    return checks;
  } finally {
    menu.close();
    network.send = originals.send;
    network.sendRequest = originals.request;
    sounds.play = originals.play;
    rtc.setPeerVolume = originals.peerVolume;
    settings.save = originals.save;
    settings.isMuted = originals.settingsMuted;
    settings.isDeafened = originals.settingsDeafened;
    settings.userVolumes = originals.volumes;
    voice.currentVoiceChannelId = originals.voiceChannel;
    voice.voiceSessionKey = originals.voiceSession;
    voice.isMuted = originals.muted;
    voice.isDeafened = originals.deafened;
    voice.serverMuted = originals.serverMuted;
    voice.serverDeafened = originals.serverDeafened;
    audio.setMuted(voice.getEffectiveMuted());
    audio.setDeafened(voice.getEffectiveDeafened());
    rtc.setDeafened(voice.getEffectiveDeafened());
    connection.clientId = originals.clientId;
    servers.setActiveServerStore(currentServer);
    manager.clear();
    language.setLanguage(originals.language);
  }
}
