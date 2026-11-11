const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  test('real embedded browser: top-level navigation, local controls, disposable sessions and stage revocation', { timeout: 180000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `browser-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_BROWSER_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, '--use-fake-device-for-media-stream'], { cwd: clientRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const http = require('node:http');
  const { randomUUID } = require('node:crypto');
  const { app, BaseWindow, BrowserWindow, ipcMain } = require('electron');
  const { Permission } = require('@monky/shared');
  const { registerMiniappBrowserIpc } = require('../dist-electron/main/ipc/miniappBrowserIpc.js');
  const { installWebContentsPolicy } = require('../dist-electron/main/webContentsPolicy.js');
  installWebContentsPolicy(app);
  ipcMain.handle('media-folders:adopt-configured', () => undefined);
  ipcMain.handle('app:set-language', () => undefined);
  ipcMain.handle('client-log:write', () => undefined);
  app.setPath('userData', process.env.MONKY_BROWSER_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  let owner, webOwner, manager, fixture, vite;
  let step = 'startup';
  const timer = setTimeout(() => { console.error(`Timed out during ${step}`); app.exit(1); }, 150000);
  const run = (contents, script) => contents.executeJavaScript(script, true);
  const loadedAction = async (contents, action) => {
    const loaded = once(contents, 'did-stop-loading');
    await action();
    await loaded;
  };
  const input = (changes = {}) => ({
    requestId: randomUUID(), policyVersion: 1, serverKey: 'server', channelId: 'voice', botId: 'bot',
    screenId: 'browser', instanceId: randomUUID(), viewerId: 'alice', viewerSessionId: 'alice-device',
    title: 'Browser', locale: 'en', ...changes,
  });
  const entry = requestId => manager.entries.get(requestId);
  const placed = (browser, predicate) => {
    if (predicate(browser)) return Promise.resolve();
    const previous = manager.placement.bind(manager), pending = Promise.withResolvers();
    manager.placement = (...args) => {
      previous(...args);
      if (args[0] === browser.input.requestId && predicate(browser)) {
        manager.placement = previous;
        pending.resolve();
      }
    };
    return pending.promise;
  };
  const finish = async code => {
    clearTimeout(timer);
    if (manager) await manager.dispose();
    if (owner && !owner.isDestroyed()) owner.destroy();
    if (webOwner && !webOwner.isDestroyed()) webOwner.destroy();
    if (vite) await vite.close();
    if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const slowRequest = Promise.withResolvers();
    fixture = http.createServer((request, response) => {
      if (request.url === '/slow') { slowRequest.resolve(response); return; }
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: 'file:///C:/Windows/win.ini' }); response.end(); return;
      }
      if (request.url === '/download') {
        response.writeHead(200, { 'Content-Disposition': 'attachment; filename="blocked.txt"', 'Content-Type': 'text/plain' });
        response.end('must not be saved'); return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      response.end(`<!doctype html><title>Top level only</title><h1 id="page">${request.url === '/b' ? 'B' : 'A'}</h1>
        <a id="next" href="/b">Next</a><a id="download" href="/download">Download</a>`);
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const base = `http://127.0.0.1:${fixture.address().port}`;
    owner = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(clientRoot, 'dist-electron', 'preload', 'preload.cjs'),
    } });
    owner.webContents.on('console-message', details => {
      if (details.level === 'error') console.error(`[Stage renderer] ${details.message}`);
    });
    await owner.loadURL('data:text/html,<html><body><div id="app"></div></body></html>');
    manager = registerMiniappBrowserIpc(owner);
    const first = input();
    step = 'opening trusted toolbar';
    await manager.open(first);
    const a = entry(first.requestId), site = a.view.webContents, toolbar = a.toolbar.webContents;
    step = 'opaque localized home belongs to the isolated site, not a host overlay';
    const home = await run(site, `(async()=>{await document.fonts.ready;return {
      title:document.title,heading:document.querySelector('[data-miniapp-browser-home] h1')?.textContent,
      hint:document.querySelector('#browser-home-hint')?.textContent,
      background:getComputedStyle(document.body).backgroundColor,
      base:getComputedStyle(document.documentElement).backgroundColor,
      fontLoaded:[...document.fonts].some(font=>font.family==='Inter'&&font.status==='loaded'),
      bridge:[typeof require,typeof process,typeof window.api,typeof window.miniappBrowser],
      policy:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content
    }})()`);
    assert.equal(home.title, 'Your Monky browser');
    assert.equal(home.heading, 'Your Monky browser');
    assert.equal(home.hint, 'Enter an address in the bar above to start browsing.');
    assert.equal(home.background, 'rgb(17, 21, 28)');
    assert.equal(home.base, 'rgb(11, 14, 20)');
    assert.equal(home.fontLoaded, true, 'The same packaged Inter font is available without privileged file access');
    assert.deepEqual(home.bridge, ['undefined','undefined','undefined','undefined']);
    assert.match(home.policy, /default-src 'none'; script-src 'none'/);
    assert.equal((await manager.control(toolbar, { action: 'state' })).url, '');
    manager.locale(first.requestId, 'pt-BR');
    manager.appearance(first.requestId, { fontFamily: 'Inter', colors: { '--bg-sidebar': '#263244' } });
    assert.deepEqual(await run(site, `({lang:document.documentElement.lang,
      title:document.querySelector('h1').textContent,background:getComputedStyle(document.body).backgroundColor})`),
      { lang: 'pt-BR', title: 'Seu navegador no Monky', background: 'rgb(38, 50, 68)' });
    manager.locale(first.requestId, 'en');
    const bounds = { x: 30, y: 50, width: 700, height: 480 };
    manager.placement(first.requestId, bounds, bounds, true);
    assert.equal(BaseWindow.getAllWindows().length, 2, 'The site has one independent, never-shown capture root');
    assert.equal(a.site.root.isVisible(), false);
    assert.ok(owner.contentView.children.includes(a.container));
    assert.deepEqual(a.container.getBounds(), bounds);
    assert.equal(a.session.getStoragePath(), null);
    assert.notEqual(a.session, owner.webContents.session);
    assert.equal(await run(toolbar, 'typeof window.api'), 'undefined', 'Toolbar has no Monky privileged bridge');
    assert.equal(await run(toolbar, 'typeof window.miniappBrowser.control'), 'function');
    assert.equal((await manager.control(toolbar, { action: 'navigate', url: `${base}/a` })).failure, 'broadcast-unavailable');
    assert.throws(() => manager.broadcasting(first.requestId, true), /capture/i);
    assert.equal(typeof manager.captureSourceId(first.requestId), 'string');
    assert.throws(() => manager.captureSourceId(first.requestId));
    manager.broadcasting(first.requestId, true);
    step = 'top-level site with DENY and frame-ancestors none';
    await manager.control(toolbar, { action: 'navigate', url: `${base}/a` });
    assert.equal(await run(site, 'window.top === window && document.querySelector("#page").textContent'), 'A');
    assert.equal(await run(site, 'document.querySelector("[data-miniapp-browser-home]")'), null);
    manager.locale(first.requestId, 'pt-BR');
    manager.appearance(first.requestId, { fontFamily: 'monospace', colors: { '--bg-sidebar': '#ffffff' } });
    assert.equal(await run(site, 'document.querySelector("[data-miniapp-browser-home]")'), null,
      'Home updates cannot cover a visited page');
    const { renderMiniappBrowserHome } = require('../dist-electron/main/miniappBrowserHome.js');
    await renderMiniappBrowserHome(site, 'pt-BR', { fontFamily: 'monospace', colors: { '--bg-sidebar': '#ffffff' } });
    assert.equal(await run(site, 'document.querySelector("#page").textContent'), 'A',
      'Even an already-queued home script checks the current document before touching it');
    assert.equal(await run(site, 'document.querySelector("[data-miniapp-browser-home]")'), null);
    manager.locale(first.requestId, 'en');
    assert.deepEqual(await run(site, '[typeof require,typeof process,typeof window.api,typeof window.miniappBrowser,typeof window.monkyScreen]'),
      ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    const headers = await new Promise((resolve, reject) => http.get(`${base}/a`, response => {
      response.resume(); response.once('end', () => resolve(response.headers));
    }).once('error', reject));
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['content-security-policy'], "frame-ancestors 'none'");
    step = 'normal link navigation with global guards still installed';
    const linkRequested = once(site, 'will-navigate');
    const linkLoaded = once(site, 'did-stop-loading');
    await run(site, 'document.querySelector("#next").click()');
    const [linkEvent] = await linkRequested;
    assert.equal(linkEvent.defaultPrevented, false, 'Only the isolated browser opts into normal link navigation');
    await linkLoaded;
    assert.equal(await run(site, 'document.querySelector("#page").textContent'), 'B');
    await loadedAction(site, () => manager.control(toolbar, { action: 'back' }));
    assert.equal(site.getURL(), `${base}/a`);
    await loadedAction(site, () => manager.control(toolbar, { action: 'forward' }));
    assert.equal(site.getURL(), `${base}/b`);
    await loadedAction(site, () => manager.control(toolbar, { action: 'reload' }));
    step = 'bare domain address entry without requiring a scheme';
    await a.session.protocol.handle('https', () => new Response('<!doctype html><title>Address fixture</title><h1>HTTPS address accepted</h1>', {
      headers: { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
    }));
    await loadedAction(site, () => run(toolbar, 'document.querySelector("input").value="google.com";document.querySelector("form").requestSubmit()'));
    assert.equal(site.getURL(), 'https://google.com/', 'A bare domain really navigates to its HTTPS URL');
    assert.equal(await run(site, 'document.querySelector("h1").textContent'), 'HTTPS address accepted');
    await a.session.protocol.unhandle('https');
    await manager.control(toolbar, { action: 'navigate', url: `${base}/b` });
    const slowNavigation = manager.control(toolbar, { action: 'navigate', url: `${base}/slow` });
    const slowResponse = await slowRequest.promise;
    await manager.control(toolbar, { action: 'navigate', url: `${base}/b` });
    slowResponse.end('Obsolete navigation');
    await slowNavigation;
    assert.equal((await manager.control(toolbar, { action: 'state' })).failure, null, 'An obsolete failure cannot overwrite the new navigation');
    for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,no', 'chrome://settings', 'https://u:p@example.com']) {
      assert.equal((await manager.control(toolbar, { action: 'navigate', url })).failure, 'invalid-url');
      assert.equal(site.getURL(), `${base}/b`);
    }
    step = 'toolbar URL entry, localized denial and keyboard';
    assert.equal((await manager.control(toolbar, { action: 'navigate', url: '' })).failure, 'invalid-url');
    await run(toolbar, `document.querySelector('input').value='file:///secret';document.querySelector('form').requestSubmit()`);
    assert.match(await run(toolbar, 'document.querySelector("[role=alert]")?.textContent'), /valid address/);
    assert.ok(await run(toolbar, `document.querySelector('[role=alert]').getBoundingClientRect().bottom`) <= a.toolbar.getBounds().height,
      'Feedback stays in the trusted chrome, never behind the native website');
    const failureId = (await manager.control(toolbar, { action: 'state' })).failureId;
    await manager.control(toolbar, { action: 'navigate', url: 'file:///secret' });
    assert.ok((await manager.control(toolbar, { action: 'state' })).failureId > failureId, 'Repeated denials have distinct feedback');
    manager.locale(first.requestId, 'pt-BR');
    assert.equal((await manager.control(toolbar, { action: 'state' })).locale, 'pt-BR');
    assert.equal(await run(toolbar, 'document.querySelector("input").getAttribute("aria-label")'), 'Endereço do site (ex.: google.com)');
    await run(toolbar, 'document.querySelector("input").blur();true');
    owner.show();
    manager.visibility(first.requestId, true);
    assert.equal(a.container.getVisible(), true);
    owner.focus();
    owner.webContents.setZoomFactor(1.25);
    manager.placement(first.requestId, bounds, bounds, true);
    assert.equal(a.toolbar.webContents.getZoomFactor(), 1.25);
    assert.equal(a.container.getBounds().x, Math.ceil(bounds.x * 1.25), 'Native placement uses owner DIP zoom, not physical pixels');
    owner.webContents.setZoomFactor(1);
    const clip = { x: 80, y: 100, width: 300, height: 200 };
    manager.placement(first.requestId, bounds, clip, true);
    assert.deepEqual(a.container.getBounds(), clip, 'Only the visible miniapp rectangle can be painted');
    assert.equal(a.toolbar.getBounds().x, bounds.x - clip.x, 'Clipping never resizes or shifts the actual website layout');
    manager.placement(first.requestId, bounds, bounds, true);
    manager.visibility(first.requestId, false);
    assert.equal(a.container.getVisible(), false);
    assert.equal(site.isAudioMuted(), true);
    manager.visibility(first.requestId, true);
    site.focus();
    await run(toolbar, 'window.addressFocused=new Promise(resolve=>document.querySelector("input").addEventListener("focus",()=>resolve(true),{once:true}));true');
    site.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await run(toolbar, 'window.addressFocused');
    assert.equal(await run(toolbar, 'document.activeElement === document.querySelector("input")'), true, 'The address shortcut works while a website has focus');
    step = 'credential isolation between participants and miniapp instances';
    await run(site, 'document.cookie="login=alice; path=/"; localStorage.setItem("login","alice");sessionStorage.setItem("tab","alice")');
    const second = input({ viewerId: 'bob', viewerSessionId: 'bob-device', instanceId: first.instanceId });
    await manager.open(second);
    const b = entry(second.requestId);
    assert.equal(await run(b.view.webContents, 'document.querySelector("[data-miniapp-browser-home] h1")?.textContent'),
      'Your Monky browser', 'A new isolated instance starts at its own opaque home');
    manager.captureSourceId(second.requestId); manager.broadcasting(second.requestId, true);
    await manager.control(b.toolbar.webContents, { action: 'navigate', url: `${base}/a` });
    assert.deepEqual(await run(b.view.webContents, '[document.cookie,localStorage.getItem("login"),sessionStorage.getItem("tab")]'), ['', null, null]);
    assert.notEqual(a.session, b.session);
    assert.equal(await run(site, 'localStorage.getItem("login")'), 'alice');
    step = 'denied permissions, popups and downloads';
    assert.equal(await run(site, 'new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve("allowed"),()=>resolve("denied")))'), 'denied');
    assert.equal(await run(site, 'navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(stream=>{stream.getTracks().forEach(t=>t.stop());return "allowed"},()=> "denied")'), 'denied');
    const windows = BrowserWindow.getAllWindows().length;
    await run(site, 'window.open("https://example.com");true');
    assert.equal(BrowserWindow.getAllWindows().length, windows);
    assert.equal((await manager.control(toolbar, { action: 'state' })).failure, 'popup-denied');
    const download = once(a.session, 'will-download');
    await run(site, 'document.querySelector("#download").click()');
    await download;
    assert.equal((await manager.control(toolbar, { action: 'state' })).failure, 'download-denied');
    step = 'redirect to privileged protocol';
    await manager.control(toolbar, { action: 'navigate', url: `${base}/redirect` });
    assert.notEqual(site.getURL().split(':')[0], 'file');
    step = 'immediate close and complete temporary storage teardown';
    const siteDestroyed = once(site, 'destroyed');
    manager.close(first.requestId);
    assert.ok(a.closed && !a.container.getVisible(), 'The view disappears synchronously, without waiting for hooks');
    await siteDestroyed;
    assert.ok(site.isDestroyed(), 'The WebContents is closed without asking the visited site');
    await manager.closeAll();
    assert.deepEqual(await a.session.cookies.get({ url: base }), []);
    const third = input({ instanceId: first.instanceId });
    await manager.open(third);
    const c = entry(third.requestId);
    manager.captureSourceId(third.requestId); manager.broadcasting(third.requestId, true);
    await manager.control(c.toolbar.webContents, { action: 'navigate', url: `${base}/a` });
    assert.deepEqual(await run(c.view.webContents, '[document.cookie,localStorage.getItem("login")]'), ['', null]);
    manager.close(first.requestId);
    assert.ok(!c.view.webContents.isDestroyed(), 'A stale close cannot affect a new instance');
    const nativeClosed = once(c.view.webContents, 'destroyed');
    await manager.control(c.toolbar.webContents, { action: 'close' });
    await nativeClosed;
    await manager.closeAll();

    step = 'stage automatic host opening, instance lifecycle and web host unavailability';
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      define: { __MONKY_MINIAPPS_URL__: JSON.stringify('https://miniapps.invalid') },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{ name: 'browser-stage-fixture', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__browser_stage') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<html><head><script type="module" src="/@vite/client"></script><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
        });
      } }],
    });
    await new Promise(resolve => vite.httpServer.listen(0, '127.0.0.1', resolve));
    const viteBase = `http://127.0.0.1:${vite.httpServer.address().port}/`;
    process.env.VITE_DEV_SERVER_URL = viteBase;
    await owner.loadURL(new URL('__browser_stage', viteBase).href);
    step = 'stage fixture imports and voice context';
    const setup = `(async()=>{window.setup=async()=>{window.fixtureStage='imports';
      const [{BotScreenView},{sessionManager},{voiceStore},language,{getBotVoiceContext},{webCapabilities}]=await Promise.all([
        import('/views/BotScreenView.ts'),import('/core/SessionManager.ts'),import('/stores/voiceStore.ts'),
        import('/i18n/index.ts'),import('/utils/botVoice.ts'),import('/platform/web/webPlatform.ts')]);
      window.fixtureStage='session';language.setLanguage('en');sessionManager.install();
      const s=sessionManager.create('browser-test',7890,'alice');
      const user={id:'alice',clientId:'alice',sessionId:'alice-device',nickname:'Alice',status:'ONLINE',joinedAt:1};
      const channel={id:'voice',serverId:'server',name:'Voice',type:'VOICE',position:0,createdAt:1};
      s.serverStore.setServerDetails({id:s.key,name:'Test',createdAt:1,maxUsers:10,channels:[channel],members:[user],
        knownMembers:[user],voiceStates:{},roles:[],userRoles:[],ownerId:'alice',myPermissions:${Permission.ADMINISTRATOR}},user);
      s.participants.setUsers([user]);s.participants.updateVoiceState({sessionId:user.sessionId,userId:user.id,
        channelId:'voice',isMuted:false,isDeafened:false,isSpeaking:false,isCameraOn:false,isScreenSharing:false,
        isSharingScreenAudio:false,serverMuted:false,serverDeafened:false});
      s.client.getStatus=()=> 'CONNECTED';voiceStore.voiceSessionKey=s.key;voiceStore.currentVoiceChannelId='voice';
      window.fixtureStage='manager';const {webRtcManager}=await import('/core/WebRtcManager.ts');
      webRtcManager.browserMiniappMedia.host=async (_screen,stream)=>({close:()=>stream.getTracks().forEach(track=>track.stop())});
      const screen={id:'browser',instanceId:'stage-instance',botId:'bot',channelId:'voice',title:'Browser',kind:'browser',
        hostSessionId:user.sessionId,broadcastSource:null,html:'',state:null,revision:0,createdAt:1};
      window.fixtureStage='tile';window.tile=new BotScreenView(screen,getBotVoiceContext(),()=>{},()=>window.tile.leave('leave'),()=>{},()=>{});
      const layer=document.createElement('div');layer.className='stage-bot-screen-layer';
      layer.style.cssText='position:relative;width:740px;height:500px;';
      window.tile.element.style.cssText='left:10px;top:10px;width:720px;height:480px;';
      layer.append(window.tile.element);document.querySelector('#app').append(layer);window.tile.setStageVisible(true);
      window.webCapabilities=webCapabilities;window.stageSession=s;window.fixtureStage='ready';
    };await window.setup();})()`;
    const originalBroadcasting = manager.broadcasting.bind(manager), stageBroadcasting = Promise.withResolvers();
    manager.broadcasting = (...args) => { originalBroadcasting(...args); stageBroadcasting.resolve(); };
    const stageDeadline = setTimeout(async () => {
      const status = await run(owner.webContents, `({phase:window.fixtureStage,failure:window.fixtureFailure,watching:window.tile?.isWatching,
        frame:window.tile?.frame?.constructor.name,context:window.stageSession?.serverStore.currentUser,
        text:document.body.textContent})`);
      stageBroadcasting.reject(new Error(`No automatic stage capture: ${JSON.stringify(status)}`));
    }, 30000);
    try { await Promise.all([run(owner.webContents, setup), stageBroadcasting.promise]); }
    finally { clearTimeout(stageDeadline); }
    manager.broadcasting = originalBroadcasting;
    assert.equal(manager.entries.size, 1);
    const stageEntry = [...manager.entries.values()][0];
    const stageContents = stageEntry.view.webContents;
    step = 'real native surface aligned inside the visible stage card';
    await placed(stageEntry, browser => browser.container.getVisible());
    assert.equal(await run(owner.webContents, `(()=>{for(const [focused,miniature] of [[true,false],[false,true],[false,false]]) {
      tile.setLayout(focused,miniature);if(!tile.element.classList.contains('stage-bot-browser-card'))return false;
    }return true;})()`), true, 'Every stage layout retains the trusted browser chrome styling');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    const cardBounds = await run(owner.webContents, `(()=>{const r=document.querySelector('.miniapp-browser-tile').getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    assert.deepEqual(stageEntry.bounds, cardBounds, 'The site lives in the miniapp body, not a detached window');
    assert.equal(await run(owner.webContents, '!!window.tile.element.querySelector(".bot-screen-header .stage-card-controls")'), true,
      'Mute stays in Monky chrome above the native website');
    step = 'embedded toolbar follows Monky theme and typography';
    const previousAppearance = manager.appearance.bind(manager), appearanceChanged = Promise.withResolvers();
    manager.appearance = (id, appearance) => {
      previousAppearance(id, appearance);
      if (id === stageEntry.input.requestId && appearance.colors['--bg-sidebar'] === '#123456') {
        manager.appearance = previousAppearance;
        appearanceChanged.resolve();
      }
    };
    await run(owner.webContents, `document.documentElement.style.setProperty('--bg-sidebar','#123456');
      document.documentElement.style.setProperty('--font-main','Arial, sans-serif');true`);
    await appearanceChanged.promise;
    assert.equal(await run(stageEntry.toolbar.webContents, 'getComputedStyle(document.querySelector("form")).backgroundColor'), 'rgb(18, 52, 86)');
    assert.equal(await run(stageEntry.toolbar.webContents, 'document.querySelector("input").classList.contains("input-field")'), true);
    assert.match(await run(stageEntry.toolbar.webContents, 'getComputedStyle(document.querySelector("input")).fontFamily'), /Arial/);
    assert.equal((await manager.control(stageEntry.toolbar.webContents, { action: 'navigate', url: viteBase })).failure, 'invalid-url');
    await manager.control(stageEntry.toolbar.webContents, { action: 'navigate', url: `${base}/a` });
    await run(stageContents, 'document.cookie="login=stage; path=/"');
    assert.equal(await run(owner.webContents, 'document.querySelectorAll(".stage-bot-screen-card iframe").length'), 0);
    step = 'DOM dialogs remain accessible above the native browser';
    stageContents.focus();
    const modalHidden = placed(stageEntry, browser => !browser.container.getVisible());
    await run(owner.webContents, `(async()=>{const {openModal}=await import('/utils/modalShell.ts');
      window.browserDialog=openModal({card:'<div class="modal-card"><input autofocus id="overlay-focus"><button data-modal-close>Close</button></div>'});})()`);
    await modalHidden;
    assert.equal(stageContents.isAudioMuted(), true);
    assert.equal(owner.webContents.isFocused(), true);
    const modalRestored = placed(stageEntry, browser => browser.container.getVisible());
    await run(owner.webContents, 'window.browserDialog.close();true');
    await modalRestored;
    step = 'top-layer context menus never disappear behind native content';
    const menuHidden = placed(stageEntry, browser => !browser.container.getVisible());
    await run(owner.webContents, `(()=>{const r=document.querySelector('.miniapp-browser-tile').getBoundingClientRect();
      window.browserMenu=document.createElement('div');browserMenu.setAttribute('popover','manual');browserMenu.setAttribute('role','menu');
      browserMenu.style.cssText='position:fixed;inset:auto;margin:0;width:200px;height:80px;background:white;';
      browserMenu.style.left=(r.left+10)+'px';browserMenu.style.top=(r.top+10)+'px';document.body.append(browserMenu);browserMenu.showPopover();})()`);
    await menuHidden;
    const menuRestored = placed(stageEntry, browser => browser.container.getVisible());
    await run(owner.webContents, 'browserMenu.hidePopover();browserMenu.remove();true');
    await menuRestored;
    step = 'native viewport follows stage clipping and scrolling';
    const clipped = placed(stageEntry, browser => browser.clip.height < browser.bounds.height);
    await run(owner.webContents, `document.querySelector('.stage-bot-screen-layer').style.height='180px';true`);
    await clipped;
    assert.ok(stageEntry.container.getBounds().height < stageEntry.view.getBounds().height);
    const scrollY = stageEntry.bounds.y;
    const scrolled = placed(stageEntry, browser => browser.bounds.y < scrollY);
    await run(owner.webContents, `const layer=document.querySelector('.stage-bot-screen-layer');layer.style.overflowY='auto';layer.scrollTop=50;true`);
    await scrolled;
    const unclipped = placed(stageEntry, browser => browser.clip.height >= browser.bounds.height - 1);
    await run(owner.webContents, `(()=>{const layer=document.querySelector('.stage-bot-screen-layer');layer.scrollTop=0;layer.style.height='500px';layer.style.overflowY='hidden';})()`);
    await unclipped;
    step = 'miniapp fullscreen placement and Escape from the focused website';
    const enteredFullscreen = once(owner.webContents, 'enter-html-full-screen');
    await run(owner.webContents, 'window.tile.element.requestFullscreen()');
    await enteredFullscreen;
    const fullPlaced = placed(stageEntry, browser => browser.bounds.width > 720 && browser.container.getVisible());
    await fullPlaced;
    const exitedFullscreen = once(owner.webContents, 'leave-html-full-screen');
    await run(owner.webContents, `window.browserFullscreenExited=new Promise(resolve=>document.addEventListener('fullscreenchange',()=>{
      if(!document.fullscreenElement)resolve(true);
    }));true`);
    stageContents.focus();
    stageContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await exitedFullscreen;
    await run(owner.webContents, 'window.browserFullscreenExited');
    assert.equal(await run(owner.webContents, 'document.fullscreenElement === null'), true);
    await placed(stageEntry, browser => browser.container.getVisible());
    assert.equal(await run(stageContents, 'document.cookie'), 'login=stage', 'Layout and occlusion preserve the temporary host session');
    step = 'stage revocation closes the native WebContents';
    const stageDestroyed = once(stageContents, 'destroyed');
    await run(owner.webContents, 'window.tile.destroy("revoked");true');
    await stageDestroyed;
    assert.equal(manager.entries.size, 0);
    await manager.closeAll();
    assert.ok(stageContents.isDestroyed());
    assert.deepEqual(await stageEntry.session.cookies.get({ url: base }), []);
    step = 'web browser invitation stays visibly unavailable';
    webOwner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await webOwner.loadURL(new URL('__browser_stage', viteBase).href);
    await run(webOwner.webContents, `(async()=>{window.api=(await import('/platform/web/webPlatform.ts')).createWebPlatformApi();})()`);
    await run(webOwner.webContents, setup);
    await run(webOwner.webContents, 'window.tile.open()');
    assert.equal(manager.entries.size, 0);
    assert.ok(await run(webOwner.webContents, '!!document.querySelector(".desktop-only-dialog")'));
    assert.equal(await run(webOwner.webContents, 'window.webCapabilities().miniappBrowser'), false);
    assert.equal(await run(webOwner.webContents, 'window.tile.element.querySelector("[data-bot-screen-action=open]").getAttribute("aria-disabled")'), 'true');
    await run(webOwner.webContents, 'window.tile.destroy("revoked");true');
    step = 'unexpected capture-root destruction closes only its own site';
    const rootRequest = input();
    await manager.open(rootRequest);
    const rootEntry = entry(rootRequest.requestId), rootContents = rootEntry.view.webContents;
    const rootSiteDestroyed = once(rootContents, 'destroyed');
    rootEntry.site.root.destroy();
    await rootSiteDestroyed;
    await manager.closeAll();
    assert.equal(manager.entries.size, 0);
    assert.equal(rootContents.isDestroyed(), true);
    step = 'destroying the logical owner retires every independent site and temporary session';
    const remaining = [];
    for (let index = 0; index < 2; index++) {
      const request = input();
      await manager.open(request);
      const browser = entry(request.requestId);
      manager.captureSourceId(request.requestId); manager.broadcasting(request.requestId, true);
      await manager.control(browser.toolbar.webContents, { action: 'navigate', url: `${base}/a` });
      await run(browser.view.webContents, 'document.cookie="owner=temporary; path=/"');
      remaining.push({ ...browser, toolbarContents: browser.toolbar.webContents });
    }
    assert.notEqual(remaining[0].session, remaining[1].session);
    const ownerSitesDestroyed = Promise.all(remaining.map(browser => once(browser.view.webContents, 'destroyed')));
    owner.destroy();
    await ownerSitesDestroyed;
    await manager.closeAll();
    assert.equal(manager.entries.size, 0);
    for (const browser of remaining) {
      assert.equal(browser.site.root.isDestroyed(), true);
      assert.equal(browser.toolbarContents.isDestroyed(), true);
      assert.deepEqual(await browser.session.cookies.get({ url: base }), []);
    }
    console.log('Native browser regression passed: DENY top-level navigation, history, privacy, permissions, teardown, broadcast gating and web host denial.');
    await finish(0);
  }).catch(async error => {
    console.error(`Failed during ${step}:`, error);
    await finish(1);
  });
}
