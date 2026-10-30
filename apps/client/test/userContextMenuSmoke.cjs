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
    app.on('window-all-closed', () => {});
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
    { connectionStore: connection }, { gameShareRequests: shares },
    { gameShareSuggestion: suggestion, GAME_SHARE_SUGGESTION_SLOT: suggestionSlot }] = await Promise.all([
    import('/views/UserContextMenu.ts'), import('/stores/serverStore.ts'),
    import('/core/ParticipantManager.ts'), import('/stores/voiceStore.ts'),
    import('/stores/settingsStore.ts'), import('/core/NetworkClient.ts'),
    import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    import('/core/SoundEffects.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
    import('/stores/connectionStore.ts'), import('/core/GameShareRequests.ts'), import('/core/GameShareSuggestion.ts'),
  ]);
  let checks = 0;
  let lastClose;
  const originalClose = menu.close;
  menu.close = function() {
    if (document.querySelector('.user-context-menu:not([data-ui-closing])')) lastClose = new Error('Menu closed').stack;
    return originalClose.call(this);
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(`${message} (check ${checks}; actions: ${[...document.querySelectorAll('.user-context-menu [data-action]')].map(button => button.dataset.action).join(',')})\n${lastClose}`);
    checks++;
  };
  const delay = () => new Promise(resolve => setTimeout(resolve, 20));
  const find = selector => document.querySelector(`.user-context-menu:not([data-ui-closing]) ${selector}`);
  const button = action => find(`[data-action="${action}"]`);
  const click = action => { check(!!button(action), `${action} action exists`); button(action).click(); };
  const currentServer = servers.getActiveServerStore();
  const server = servers.createServerStore();
  const manager = participants.createParticipantManager();
  const user = { id: 'menu-local', sessionId: 'local-session', clientId: 'local-client', nickname: '<b>Local</b>', status: 'ONLINE', joinedAt: 1 };
  const second = { ...user, sessionId: 'second-session' };
  const remote = { ...user, id: 'menu-remote', clientId: 'remote-client', sessionId: 'remote-session', nickname: 'Remote' };
  const offline = { ...remote, id: 'menu-offline', clientId: 'offline-client', sessionId: undefined, nickname: 'Offline', status: 'DISCONNECTED' };
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
  const policies = new Map();
  const policy = id => policies.get(id) ?? { serverMuted: false, serverDeafened: false };
  network.send = (type, payload) => sent.push({ type, payload });
  const request = async (type, payload) => {
    requests.push({ type, payload });
    if (type === 'ADMIN_GET_VOICE_RESTRICTIONS') {
      return { userId: payload.targetUserId, ...policy(payload.targetUserId) };
    }
    if (type === 'ADMIN_MUTE_USER' || type === 'ADMIN_DEAFEN_USER') {
      const updated = { ...policy(payload.targetUserId),
        ...(type === 'ADMIN_MUTE_USER' ? { serverMuted: payload.muted } : { serverDeafened: payload.deafened }) };
      policies.set(payload.targetUserId, updated);
      server.updateVoiceRestrictions(payload.targetUserId, updated);
      return { userId: payload.targetUserId, ...updated };
    }
  };
  network.sendRequest = request;
  const open = async target => { menu.open(30, 30, target); await delay(); };
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
    members: [user, second, remote], knownMembers: [user, remote, offline],
    roles: [], userRoles: [], ownerId: 'owner', myPermissions: 0,
  }, user);
  for (const who of [second, user, remote]) { manager.addUser(who); manager.updateVoiceState(state(who)); }
  voice.currentVoiceChannelId = null;
  voice.voiceSessionKey = null;
  voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
  try {
    language.setLanguage('en');
    menu.open(30, 30, user);
    check(!!document.querySelector('.user-context-menu:not([data-ui-closing])'), 'Own menu opens');
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
    server.updateVoiceRestrictions(user.id, voice);
    click('self-mute');
    check(!voice.isMuted && voice.getEffectiveMuted() && voice.serverMuted && audio.isMuted, 'Manual unmute cannot bypass admin microphone block');
    voice.setServerDeafened(true);
    server.updateVoiceRestrictions(user.id, voice);
    click('self-deafen');
    click('self-deafen');
    check(!voice.isDeafened && voice.getEffectiveDeafened() && voice.serverDeafened, 'Manual undeafen cannot bypass admin deafen');
    check(button('self-deafen').title === language.t('permissions.serverDeafened'), 'Admin deafen explained by tooltip');
    voice.serverMuted = voice.serverDeafened = false;
    server.updateVoiceRestrictions(user.id, voice);
    voice.currentVoiceChannelId = 'room';
    click('self-mute');
    check(sent.length === 1 && sent[0].payload.isMuted === voice.isMuted, 'In-call manual action sends voice state');

    // "Pedir para ver a partida" (#763): only for someone else, playing, in the
    // same call, not on screen yet, on a server that negotiated the feature.
    const asks = [];
    const originalAsk = shares.ask;
    shares.ask = target => { asks.push(target); return Promise.resolve(); };
    const askActivity = { source: 'steam', appId: 606150, name: 'Moonlighter', startedAt: Date.now() };
    const playing = { ...remote, activity: askActivity };
    server.serverDetails.protocol = { version: 36, minimumVersion: 35, features: ['game-activity', 'game-share-request'] };
    await open(playing);
    check(button('ask-to-watch-game')?.closest('.context-menu-activity') !== null, 'Ask to watch sits on the game card');
    check(!find('input[type="checkbox"],input[type="radio"]'), 'Ask to watch adds no native checkbox');
    button('ask-to-watch-game').focus();
    check(document.activeElement === button('ask-to-watch-game'), 'Ask to watch is reachable by keyboard');
    click('ask-to-watch-game');
    check(asks.length === 1 && asks[0].id === remote.id && asks[0].nickname === remote.nickname, 'Ask to watch targets the player');
    await delay();
    check(!document.querySelector('.user-context-menu:not([data-ui-closing])'), 'Asking closes the menu');
    await open({ ...user, activity: askActivity });
    check(!button('ask-to-watch-game'), 'Nobody asks to watch themselves');
    manager.updateVoiceState({ ...state(remote), isScreenSharing: true });
    await open(playing);
    check(!button('ask-to-watch-game'), 'No ask while the player is already on screen');
    manager.updateVoiceState({ ...state(remote), channelId: 'other-room' });
    await open(playing);
    check(!button('ask-to-watch-game'), 'No ask across different calls');
    manager.updateVoiceState(state(remote));
    server.serverDetails.protocol = { version: 36, minimumVersion: 35, features: ['game-activity'] };
    await open(playing);
    check(!button('ask-to-watch-game'), 'No ask on a server without the feature');
    menu.close();
    server.serverDetails.protocol = undefined;
    shares.ask = originalAsk;

    // The game strip atop the voice panel (#763): in a call with a game running
    // it names the game with one written action, and turns into the live status.
    const activity = { source: 'steam', appId: 606150, name: 'Moonlighter', startedAt: Date.now() };
    const slot = document.createElement('div');
    slot.id = suggestionSlot;
    document.body.appendChild(slot);
    const shared = [];
    const originalShare = suggestion.shareGame;
    suggestion.shareGame = () => { shared.push(true); return Promise.resolve(); };
    const strip = () => slot.querySelector('.game-share-suggestion:not([data-ui-closing])');
    const cta = () => strip()?.querySelector('.game-share-suggestion-cta');
    const settle = () => new Promise(resolve => setTimeout(resolve, 300));
    const liveChanges = [];
    const offLive = appEvents.on('game_share.live_changed', live => liveChanges.push(live));
    const setShares = ids => {
      voice.screenShareIds = [...ids];
      voice.isScreenSharing = ids.length > 0;
      appEvents.emit('voice.state_updated');
    };
    try {
      voice.currentVoiceChannelId = null;
      setShares([]);
      settings.suggestGameShare = true;
      suggestion.start();
      appEvents.emit('game_presence.changed', activity);
      check(!strip(), 'No game strip outside a call');
      voice.currentVoiceChannelId = 'room';
      appEvents.emit('voice.channel_changed', 'room');
      check(strip()?.dataset.state === 'playing', 'Joining a call with a game running shows the game strip');
      check(strip().querySelector('.game-share-suggestion-name')?.textContent === 'Moonlighter', 'The strip names the game');
      check(strip().querySelector('[role="status"]')?.textContent.includes(language.t('gameShare.playing')), 'The status line says the game is being played');
      check(strip().querySelector('.game-share-suggestion-art .material-symbols-outlined'), 'A game without art gets the generic icon');
      check(cta()?.textContent === language.t('gameShare.share'), 'The action is written, not just an icon');
      check(cta()?.getAttribute('aria-label')?.includes('Moonlighter'), 'The action is labelled with the game');
      check(![...strip().querySelectorAll('.material-symbols-outlined')].some(icon => /screen_share/.test(icon.textContent)),
        'The strip does not repeat the screen share icon');
      check(!strip().querySelector('input[type="checkbox"],input[type="radio"]'), 'The strip adds no native checkbox');
      check(!strip().querySelector('[data-game-share-suggestion="dismiss"]'), 'As in Discord, there is nothing to dismiss');
      check(document.activeElement !== cta(), 'The strip does not steal focus');
      cta().focus();
      check(document.activeElement === cta(), 'The action is reachable by keyboard');
      const sameStrip = strip();
      appEvents.emit('voice.state_updated');
      check(strip() === sameStrip, 'Unrelated voice updates keep the same strip instead of rebuilding it');
      // One explicit yes before anything is captured.
      const dialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing]) .dialog-card');
      cta().click();
      await settle();
      check(dialog()?.textContent.includes(language.t('gameShare.confirmTitle', { game: 'Moonlighter' })), 'Compartilhar asks for confirmation first');
      check(dialog().querySelector('[data-action="cancel"]')?.textContent === language.t('common.cancel'), 'The way out is Cancelar');
      check(shared.length === 0, 'Nothing is shared while the question is open');
      dialog().querySelector('[data-action="cancel"]').click();
      await settle();
      check(!dialog(), 'Cancelar closes the question');
      check(shared.length === 0, `Cancelar shares nothing (${shared.length})`);
      check(strip()?.dataset.state === 'playing', `Cancelar leaves the strip as it was (${strip()?.dataset.state})`);
      cta().click();
      await settle();
      dialog().querySelector('[data-action="confirm"]').click();
      await settle();
      check(shared.length === 1, 'Confirming starts the game share');

      // Live: the strip becomes the status and the action stops the game share.
      suggestion.claimShare('game-share');
      setShares(['game-share']);
      check(strip() === sameStrip && strip().dataset.state === 'live', 'Going live keeps the same strip and only changes its state');
      check(strip().querySelector('.live-pulse-dot') && strip().textContent.includes(language.t('gameShare.live')), 'The live status shows in the strip');
      check(cta()?.textContent === language.t('gameShare.stop') && cta().dataset.gameShareSuggestion === 'stop', 'Parar takes the place of Compartilhar');
      check(suggestion.isLive() && liveChanges.at(-1) === true, 'The strip owns the "you are sharing" status while live');
      setShares(['game-share', 'manual-share']);
      await settle();
      check(!strip() && !suggestion.isLive() && liveChanges.at(-1) === false, 'A second, manual share hands the status back to the panel');
      setShares(['game-share']);
      check(strip()?.dataset.state === 'live', 'Back to the game share alone, the strip is live again');
      setShares([]);
      check(strip()?.dataset.state === 'playing' && cta()?.textContent === language.t('gameShare.share'), 'Stopping returns the strip to Compartilhar');
      setShares(['manual-share']);
      await settle();
      check(!strip(), 'Sharing something else by hand hides the strip');
      setShares([]);
      check(strip()?.dataset.state === 'playing', 'The strip comes back once the manual share stops');

      // Someone asked to watch (A3): the strip names them, counts down and answers.
      const answers = [];
      const originalCurrent = shares.current;
      const originalAnswer = shares.answer;
      let pending = { id: 'ask-1', nickname: 'lucas', expiresAt: Date.now() + 20000, durationMs: 30000 };
      shares.current = () => pending;
      shares.answer = (id, accepted) => { answers.push({ id, accepted }); pending = null; appEvents.emit('game_share.request_changed'); };
      try {
        const before = strip();
        appEvents.emit('game_share.request_changed');
        check(strip() === before && strip().dataset.state === 'request' && strip().dataset.request === 'ask-1', 'A request takes over the same strip');
        check(strip().textContent.includes(language.t('gameShare.wantsToWatch', { name: 'lucas' })), 'The strip says who wants to watch');
        check(strip().querySelector('.game-share-suggestion-avatar')?.textContent === 'L', 'The asker shows as an initial');
        const timer = strip().querySelector('.game-share-suggestion-timer');
        check(timer?.classList.contains('game-share-suggestion-timer--run') && Math.abs(parseFloat(timer.style.getPropertyValue('--game-share-timer-start')) - 2 / 3) < 0.05,
          'The timer starts from the time actually left');
        const dismiss = strip().querySelector('.game-share-suggestion-dismiss');
        check(!dismiss.hidden && dismiss.getAttribute('aria-label') === language.t('gameShare.notNow'), 'The × means Agora não');
        dismiss.focus();
        check(document.activeElement === dismiss, 'Agora não is reachable by keyboard');
        dismiss.click();
        check(answers.at(-1)?.id === 'ask-1' && answers.at(-1).accepted === false, 'Agora não declines the request');
        check(strip().dataset.state === 'playing' && strip().querySelector('.game-share-suggestion-dismiss').hidden, 'Declining returns the strip to Jogando');
        settings.suggestGameShare = false;
        appEvents.emit('game_presence.changed', activity);
        await settle();
        check(!strip(), 'With the suggestion off there is no strip while nobody asks');
        pending = { id: 'ask-2', nickname: 'lucas', expiresAt: Date.now() + 30000, durationMs: 30000 };
        appEvents.emit('game_share.request_changed');
        check(strip()?.dataset.state === 'request', 'A request still shows with the suggestion off: a person asking is not a nudge');
        const sharedBefore = shared.length;
        const answeredBefore = answers.length;
        cta().click();
        await settle();
        dialog().querySelector('[data-action="cancel"]').click();
        await settle();
        check(answers.length === answeredBefore && strip()?.dataset.state === 'request' && shared.length === sharedBefore,
          'Cancelar on a request keeps it waiting, unanswered');
        cta().click();
        await settle();
        dialog().querySelector('[data-action="confirm"]').click();
        await settle();
        check(answers.at(-1)?.id === 'ask-2' && answers.at(-1).accepted === true && shared.length === sharedBefore + 1,
          'Confirming accepts the request and starts the game share');
        settings.suggestGameShare = true;
        appEvents.emit('game_presence.changed', activity);
        pending = { id: 'ask-3', nickname: 'lucas', expiresAt: Date.now() + 30000, durationMs: 30000 };
        suggestion.claimShare('game-share');
        setShares(['game-share']);
        check(strip()?.dataset.state === 'live', 'No request state while already live');
        setShares([]);
        check(strip()?.dataset.state === 'request', 'A request still waiting shows again once the share stops');
        pending = null;
        appEvents.emit('game_share.request_changed');
        check(strip()?.dataset.state === 'playing', 'An expired or closed request leaves the strip');
      } finally {
        shares.current = originalCurrent;
        shares.answer = originalAnswer;
        settings.suggestGameShare = true;
      }

      const art = '/9j/' + 'A'.repeat(16);
      appEvents.emit('game_presence.changed', { ...activity, startedAt: activity.startedAt + 1, iconBase64: art });
      check(strip()?.querySelector('.game-share-suggestion-art img')?.getAttribute('src') === `data:image/jpeg;base64,${art}`,
        'A new launch rebuilds the strip with the game art');
      // Without a game window there is no picker to fall back to: the shared error toast says so.
      const realApi = window.api;
      window.api = { ...(realApi ?? {}), findGameWindows: () => Promise.resolve([]) };
      try {
        await originalShare.call(suggestion);
      } finally {
        window.api = realApi;
      }
      const toast = [...document.querySelectorAll('.chat-copy-toast[role="alert"]')].at(-1);
      check(toast?.textContent.includes(language.t('gameShare.windowNotFound')), 'A missing game window is reported in an error toast');
      check(!document.querySelector('.screen-share-picker-card'), 'Streaming the game never opens the picker');
      settings.suggestGameShare = false;
      appEvents.emit('game_presence.changed', activity);
      await settle();
      check(!strip(), 'Turning the suggestion off in the settings removes the strip');
      settings.suggestGameShare = true;
      appEvents.emit('game_presence.changed', activity);
      check(!!strip(), 'Turning it back on shows the strip again');
      appEvents.emit('game_presence.changed', null);
      await settle();
      check(!strip(), 'Closing the game removes the strip');
      appEvents.emit('game_presence.changed', activity);
      voice.currentVoiceChannelId = null;
      appEvents.emit('voice.channel_changed', null);
      await settle();
      check(!strip(), 'Leaving the call removes the strip');
      suggestion.dispose();
      voice.currentVoiceChannelId = 'room';
      appEvents.emit('game_presence.changed', activity);
      check(!strip() && slot.childElementCount === 0, 'Disposal stops listening');
    } finally {
      offLive();
      suggestion.dispose();
      suggestion.shareGame = originalShare;
      voice.currentVoiceChannelId = null;
      voice.screenShareIds = [];
      voice.isScreenSharing = false;
      slot.remove();
    }

    server.myPermissions = 2147483647;
    for (const action of ['server-mute', 'server-deafen', 'kick-voice', 'move-user']) {
      await open(user);
      click(action);
      await delay();
      if (action === 'server-mute' || action === 'server-deafen') {
        check(requests.at(-1).payload.targetUserId === user.id && !('targetSessionId' in requests.at(-1).payload),
          `${action} targets the identity rather than an arbitrary device`);
      } else {
        check(requests.at(-1).payload.targetSessionId === user.sessionId,
          `${action} still targets the exact voice connection`);
      }
    }
    await open({ ...user, sessionId: undefined });
    click('server-mute');
    await delay();
    check(requests.at(-1).payload.targetUserId === user.id, 'Own profile without a session still resolves the correct identity');
    await open(user);
    manager.removeVoiceState(user.sessionId);
    const count = requests.length;
    click('server-mute');
    await delay();
    check(requests.length === count + 1 && requests.at(-1).payload.targetUserId === user.id,
      'Leaving voice while the menu is open does not prevent identity moderation');
    await open({ ...user, sessionId: undefined });
    check(!!button('server-mute') && !!button('server-deafen') && !!button('self-mute')
      && !button('kick-voice') && !button('move-user'),
      'Pre-call profiles expose identity moderation but never kick or move another device');
    manager.updateVoiceState(state(user));

    for (const alias of [{ ...user, id: 'alias-id' }, { ...user, clientId: 'different-client' }]) {
      await open(alias);
      check(!!button('self-mute') && !find('#ctx-volume-slider'), 'Self resolves by either user or nonempty client ID');
      check(requests.at(-1).payload.targetUserId === user.id, 'Self aliases query the canonical authenticated identity');
    }
    connection.clientId = '';
    server.currentUser = { ...user, clientId: '' };
    await open({ ...remote, clientId: '' });
    check(!!find('#ctx-volume-slider') && !button('self-mute'), 'Empty client IDs do not classify strangers as self');
    server.currentUser = user;
    connection.clientId = user.clientId;

    await open(remote);
    check(!!find('#ctx-volume-slider') && !button('self-mute'), 'Other-user menu retains volume but not local controls');
    find('#ctx-vol-200').click();
    check(volumes.at(-1).sessionId === remote.sessionId && volumes.at(-1).volume === 200, 'Remote boost retains per-session targeting');
    click('server-deafen');
    await delay();
    check(requests.at(-1).payload.targetUserId === remote.id, 'Other-user moderation targets the member identity');

    const musicBot = {
      ...remote, id: 'menu-music-bot', clientId: 'bot-menu-music',
      sessionId: 'bot:menu-music-bot', nickname: 'Music bot', isBot: true,
    };
    manager.addUser(musicBot);
    manager.updateVoiceState(state(musicBot));
    for (const action of ['server-mute', 'server-deafen']) {
      await open(musicBot);
      check(!!button('bot-settings') && !!button('server-mute') && !!button('server-deafen'),
        'Bot settings coexist with administrative voice controls');
      click(action);
      await delay();
      check(requests.at(-1).payload.targetUserId === musicBot.id,
        'Bot voice moderation targets the bot account rather than a human or session ID');
    }
    manager.removeVoiceState(musicBot.sessionId);
    await open({ ...musicBot, sessionId: undefined, status: 'DISCONNECTED' });
    check(button('server-mute').textContent === language.t('userMenu.serverUnmute') &&
      button('server-deafen').textContent === language.t('userMenu.serverUndeafen'),
    'Bot moderation remains visible with its saved values after leaving voice');
    server.myPermissions = 0;
    await open(musicBot);
    check(!button('server-mute') && !button('server-deafen') && !!button('bot-settings'),
      'Adding bot voice support does not bypass moderator permissions');
    server.myPermissions = 2147483647;

    for (const target of [offline, { ...remote, sessionId: undefined }]) {
      manager.removeVoiceState(remote.sessionId);
      for (const enabled of [true, false]) {
        for (const [action, field, onLabel, offLabel] of [
          ['server-mute', 'muted', 'userMenu.serverUnmute', 'userMenu.serverMute'],
          ['server-deafen', 'deafened', 'userMenu.serverUndeafen', 'userMenu.serverDeafen'],
        ]) {
          policies.set(target.id, { ...policy(target.id),
            [field === 'muted' ? 'serverMuted' : 'serverDeafened']: !enabled });
          await open(target);
          check(!!button('server-mute') && !!button('server-deafen') && !button('kick-voice') && !button('move-user'),
            'Administrative apply/remove remains available for idle and offline members without voice-only actions');
          check(button(action).textContent === language.t(enabled ? offLabel : onLabel) && !button(action).disabled,
            'Administrative labels reflect the authoritative saved restriction, not a missing voice participant');
          click(action);
          await delay();
          check(requests.at(-1).payload.targetUserId === target.id && requests.at(-1).payload[field] === enabled,
            'Both applying and removing a restriction address the offline or idle identity');
        }
      }
    }
    manager.updateVoiceState(state(remote));
    const beforeBot = requests.length;
    await open({ ...remote, id: 'bot-profile', sessionId: undefined, isBot: true });
    check(!!button('server-mute') && !!button('server-deafen') && requests.length === beforeBot + 1 &&
      requests.at(-1).payload.targetUserId === 'bot-profile',
    'Bot profiles load their own restrictions even without an active voice connection');

    let resolvePolicy;
    network.sendRequest = (type, payload) => type === 'ADMIN_GET_VOICE_RESTRICTIONS'
      ? new Promise(resolve => { resolvePolicy = resolve; }) : request(type, payload);
    menu.open(30, 30, remote);
    check(button('server-mute').disabled && button('server-deafen').disabled,
      'The menu cannot submit a guessed restriction before the lookup finishes');
    network.sendRequest = request;
    await open(user);
    const ownLabel = button('server-mute').textContent;
    resolvePolicy({ userId: remote.id, serverMuted: true, serverDeafened: true });
    await delay();
    check(find('.context-menu-nickname').textContent === user.nickname && button('server-mute').textContent === ownLabel,
      'A late lookup never overwrites a newly opened member menu');

    let resolveAction;
    network.sendRequest = (type, payload) => type === 'ADMIN_MUTE_USER'
      ? new Promise(resolve => { resolveAction = resolve; }) : request(type, payload);
    await open(remote);
    click('server-mute');
    check(button('server-mute').disabled && button('server-deafen').disabled,
      'An in-flight administrative action cannot be submitted twice');
    network.sendRequest = request;
    await open(user);
    resolveAction();
    await delay();
    check(find('.context-menu-nickname').textContent === user.nickname,
      'A late administrative acknowledgement does not close a different member menu');

    network.sendRequest = async () => { throw new Error('Policy lookup failed'); };
    menu.open(30, 30, remote);
    await delay();
    const lookupFailure = document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
    check(!document.querySelector('.user-context-menu:not([data-ui-closing])') && lookupFailure?.getAttribute('role') === 'alert'
      && lookupFailure.textContent.includes('Policy lookup failed') && !document.querySelector('.modal-backdrop:not([data-ui-closing])'),
      'A failed lookup is explained in the alert toast instead of guessing an unmuted state');
    lookupFailure.querySelector('.chat-copy-toast-close').click();
    network.sendRequest = request;
    await delay();

    server.roles = [
      { id: 'custom-role', name: 'Custom', color: '#fff', permissions: 0, position: 1, isDefault: false },
      { id: 'admin-role', name: 'Admin', color: '#fff', permissions: 1 << 11, position: 2, isDefault: false },
    ];
    server.addMember(musicBot);
    await open(musicBot);
    check(!button('toggle-role') && !button('toggle-admin') && !!button('bot-settings'),
      'Bots use their capability settings and never offer human role or administrator assignment');
    const { ServerRolesTab } = await import('/views/serverSettings/tabs/ServerRolesTab.ts');
    const originalRoleMemberships = server.userRoles;
    server.userRoles = [{ userId: user.id, roleIds: ['custom-role'] }, { userId: musicBot.id, roleIds: ['custom-role'] }];
    const roleMembers = new ServerRolesTab().renderRoleMembersEditorPanel('custom-role');
    check(roleMembers.includes(`data-user-id="${user.id}"`) && !roleMembers.includes(`data-user-id="${musicBot.id}"`),
      'Role membership lists assigned humans, not bots');
    server.userRoles = originalRoleMemberships;
    const toastText = danger => document.querySelector(`.chat-copy-toast${danger ? '.chat-copy-toast--danger' : ':not(.chat-copy-toast--danger)'}:not([data-ui-closing]) .chat-copy-toast-label`)?.textContent ?? '';
    await open(user);
    click('toggle-role');
    await delay();
    check(requests.at(-1).type === 'ROLE_ASSIGN' && requests.at(-1).payload.userId === user.id,
      'Permitted self role assignment remains available');
    check(toastText(false) === language.t('roles.memberAdded', { name: user.nickname, role: 'Custom' }),
      'A role change from the member menu is confirmed like in the Members tab');
    const refuse = message => async (type, payload) => {
      if (type !== 'ROLE_ASSIGN') return request(type, payload);
      requests.push({ type, payload });
      throw new Error(message);
    };
    network.sendRequest = refuse('Role change refused');
    await open(remote);
    const roleButton = button('toggle-role');
    roleButton.click();
    check(roleButton.querySelector('.role-option-check').classList.contains('checked') && roleButton.disabled,
      'A role toggle shows the change at once and cannot be sent twice while pending');
    await delay();
    check(!roleButton.querySelector('.role-option-check').classList.contains('checked') && !roleButton.disabled,
      'A refused role change takes back the optimistic check mark');
    check(toastText(true) === 'Role change refused', 'A refused role change is reported instead of swallowed');
    check(!button('toggle-admin'), 'Members who manage roles but do not own the server are not offered administrator changes (#397)');
    network.sendRequest = request;
    server.ownerId = user.id;
    await open(remote);
    click('toggle-admin');
    await delay();
    check(requests.at(-1).type === 'ROLE_ASSIGN' && requests.at(-1).payload.userId === remote.id
      && requests.at(-1).payload.roleId === 'admin-role'
      && !document.querySelector('.user-context-menu:not([data-ui-closing])'),
    'The owner promotes a member to administrator from the menu, which then closes');
    network.sendRequest = refuse('Administrator change refused');
    await open(remote);
    click('toggle-admin');
    await delay();
    check(!!button('toggle-admin') && !button('toggle-admin').disabled && toastText(true) === 'Administrator change refused',
      'A refused administrator change keeps the menu open and reports the refusal');
    network.sendRequest = request;
    await open(user);
    check(!button('toggle-admin') && !!button('toggle-role'), 'Owner keeps roles but not redundant administrator toggle');
    const { ServerMembersTab } = await import('/views/serverSettings/tabs/ServerMembersTab.ts');
    const memberRows = () => new ServerMembersTab().renderRows();
    check(memberRows().includes('data-member-action="toggle-admin"'), 'The owner is offered administrator changes in the Members tab');
    server.ownerId = 'owner';
    check(!memberRows().includes('data-member-action="toggle-admin"') && memberRows().includes('data-member-action="toggle-role"'),
      'The Members tab follows the same owner-only administrator rule as the member menu');
    server.ownerId = user.id;

    for (const event of ['network.disconnected', 'voice.channel_changed', 'session.changed']) {
      await open(user);
      appEvents.emit(event);
      check(!document.querySelector('.user-context-menu:not([data-ui-closing])'), `${event} closes menu`);
    }
    menu.open(30, 30, user);
    menu.close();
    await delay();
    menu.open(30, 30, user);
    await delay();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    check(!document.querySelector('.user-context-menu:not([data-ui-closing])'), 'Escape works after immediate close/reopen');
    menu.open(30, 30, user);
    await delay();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check(!document.querySelector('.user-context-menu:not([data-ui-closing])'), 'Outside pointer closes menu');
    const listenerCount = () => [...appEvents.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
    const before = listenerCount();
    for (let attempt = 0; attempt < 5; attempt++) { menu.open(30, 30, user); menu.close(); }
    await delay();
    check(listenerCount() === before, 'Repeated close removes all menu EventBus subscriptions');
    return checks;
  } finally {
    menu.close();
    menu.close = originalClose;
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
