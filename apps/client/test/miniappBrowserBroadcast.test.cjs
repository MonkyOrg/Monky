const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const clientRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const { spawn } = require('node:child_process');
  const { createApprovedBotFixture, identity } = require(path.join(repoRoot, 'apps', 'server', 'dist', 'testFixtures', 'bots.js'));
  const { configureRealSfu } = require('./localExecutionE2e/sfuFixture.cjs');
  const shared = require('@monky/shared');
  for (const mode of ['p2p', 'sfu']) for (const viewerPlatform of ['web', 'desktop']) {
    test(`embedded browser sends only site pixels through real ${mode} signaling to a ${viewerPlatform} viewer`, { timeout: 160000 }, async t => {
      const profile = path.join(clientRoot, 'dist-test', `browser-broadcast-${mode}-${viewerPlatform}-${process.pid}`);
      fs.mkdirSync(profile, { recursive: true });
      let fixture, child;
      const failures = [];
      try {
        if (mode === 'sfu') await configureRealSfu(t, path.join(repoRoot, 'apps', 'server', 'dist', 'infrastructure', 'sfu', 'SfuManager.js'));
        fixture = await createApprovedBotFixture();
        const admin = await fixture.human('Browser admin');
        const channels = admin.auth.payload.server.channels;
        const voiceId = channels.find(channel => channel.type === 'VOICE').id;
        const textId = channels.find(channel => channel.type === 'TEXT').id;
        await fixture.serverRepo.updateServer({ voiceMode: mode });
        const created = await admin.peer.request(shared.MessageType.BOT_CREATE, {});
        const botId = created.payload.bot.id;
        const approved = await fixture.bot(created.payload.token);
        await approved.peer.close();
        const bot = await fixture.connect();
        let authenticated = await bot.request(shared.MessageType.AUTH_CONNECT, {
          protocolVersion: shared.PROTOCOL_VERSION, protocolOffer: shared.createProtocolOffer('bot'),
          nickname: 'Browser producer', publicKey: approved.keys.publicKey, botToken: created.payload.token,
        });
        if (authenticated.type === shared.MessageType.AUTH_CHALLENGE) {
          authenticated = await bot.request(shared.MessageType.AUTH_CHALLENGE_RESPONSE, {
            signature: sign(null, Buffer.from(shared.botAuthChallenge(authenticated.payload.nonce, created.payload.token), 'utf8'),
              approved.keys.privateKey).toString('hex'),
          });
        }
        assert.equal(authenticated.type, shared.MessageType.AUTH_SUCCESS);
        assert.equal((await bot.request(shared.MessageType.COMMAND_REGISTER, {
          commands: [{ name: 'browser', description: 'Browser', voiceRequirement: 'joined' }],
        })).type, shared.MessageType.COMMAND_REGISTERED);
        const oldOffer = shared.createProtocolOffer('client');
        oldOffer.version = 40;
        oldOffer.features = oldOffer.features.filter(feature => !['miniapp-browser-host', 'miniapp-browser-broadcast'].includes(feature));
        const old = await fixture.human('Protocol 40', identity(), randomUUID(), false, 40, oldOffer);
        await old.peer.request(shared.MessageType.VOICE_JOIN, { channelId: voiceId });
        const publicationChecks = [];
        old.peer.ws.on('message', bytes => {
          const event = JSON.parse(bytes.toString());
          if (publicationChecks.length || event.type !== shared.MessageType.VOICE_STATE_CHANGED ||
            !event.payload.voiceState.nativeScreenShares?.some(source => source.shareId.startsWith('browser-'))) return;
          publicationChecks.push((async () => {
            const listing = await old.peer.request(shared.MessageType.BOT_SCREEN_LIST, { channelId: voiceId });
            assert.deepEqual(listing.payload.screens.map(screen => screen.id), ['html-alongside-browser']);
            shared.botScreenListResultSchema.parse(listing.payload);
            await old.peer.barrier();
          })().catch(error => { failures.push(error); }));
        });
        bot.ws.on('message', bytes => {
          const event = JSON.parse(bytes.toString());
          if (event.type !== shared.MessageType.COMMAND_INVOKE) return;
          void (async () => {
            const scope = { channelId: voiceId, invocationId: event.payload.invocationId };
            const html = await bot.request(shared.MessageType.BOT_SCREEN_CREATE, {
              ...scope, id: 'html-alongside-browser', title: 'HTML remains usable', html: '<h1>Still connected</h1>', state: null,
            });
            assert.equal(html.type, shared.MessageType.BOT_SCREEN_SNAPSHOT);
            const browser = await bot.request(shared.MessageType.BOT_SCREEN_CREATE, {
              ...scope, id: 'browser', title: 'Browser', kind: 'browser', html: '', state: null,
            });
            assert.equal(browser.type, shared.MessageType.BOT_SCREEN_SNAPSHOT, JSON.stringify(browser));
            assert.equal(browser.payload.hostSessionId, event.payload.invokerSessionId);
            const listing = await old.peer.request(shared.MessageType.BOT_SCREEN_LIST, { channelId: voiceId });
            assert.deepEqual(listing.payload.screens.map(screen => screen.id), ['html-alongside-browser']);
            shared.botScreenListResultSchema.parse(listing.payload);
            await old.peer.barrier();
            assert.equal(old.peer.messages.some(message => message.type === shared.MessageType.BOT_SCREEN_SNAPSHOT
              && message.payload.kind === 'browser'), false);
          })().catch(error => failures.push(error));
        });
        const env = { ...process.env, MONKY_BROWSER_BROADCAST: JSON.stringify({
          profile, mode, viewerPlatform, url: fixture.url, botId, voiceId, textId,
        }) };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, `Production browser broadcast failed in ${mode}`);
        assert.equal(publicationChecks.length, 1, 'The protocol40 peer was tested during actual browser publication');
        await Promise.all(publicationChecks);
        assert.equal(old.peer.messages.some(message => message.type === shared.MessageType.BOT_SCREEN_SNAPSHOT
          && message.payload.kind === 'browser'), false);
        assert.deepEqual(failures, []);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill(); await once(child, 'exit');
        }
        await fixture?.dispose();
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
  }
} else {
  void runElectron().catch(error => { console.error(error); require('electron').app.exit(1); });
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { MessageType, memberAuthChallenge } = require('@monky/shared');
  const { registerMiniappBrowserIpc } = require('../dist-electron/main/ipc/miniappBrowserIpc.js');
  const config = JSON.parse(process.env.MONKY_BROWSER_BROADCAST);
  app.setPath('userData', config.profile);
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  let vite, siteServer, manager, phase = 'startup';
  const windows = [], identities = new Map();
  const run = (window, code) => window.webContents.executeJavaScript(
    `(async()=>{try{return await (${code});}catch(error){throw new Error(error.name+': '+error.message);}})()`, true);
  ipcMain.handle('identity:sign-challenge', (event, nonce, binding) => {
    const keys = identities.get(event.sender.id);
    assert.ok(keys && event.senderFrame === event.sender.mainFrame);
    return { signature: sign(null, binding ? Buffer.from(memberAuthChallenge(nonce, binding.serverKey), 'utf8') : Buffer.from(nonce, 'hex'),
      keys.privateKey).toString('hex') };
  });
  ipcMain.handle('client-log:write', () => {});
  ipcMain.handle('media-folders:adopt-configured', () => undefined);
  const deadline = setTimeout(() => { console.error(`Browser broadcast timeout: ${phase}`); app.exit(1); }, 140000);
  let code = 0;
  try {
    siteServer = require('node:http').createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
      response.end('<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:rgb(0,0,255)}</style><title>Site pixels</title>');
    });
    siteServer.listen(0, '127.0.0.1'); await once(siteServer, 'listening');
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(config.profile, 'vite-cache'),
      define: { __MONKY_MINIAPPS_URL__: JSON.stringify('https://miniapps.invalid') },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{ name: 'browser-broadcast-test', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__broadcast') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body style="margin:0;background:rgb(255,0,0)"><div id="app"></div><video autoplay muted playsinline></video></body></html>');
        });
      } }],
    });
    await new Promise(resolve => vite.httpServer.listen(0, '127.0.0.1', resolve));
    for (const label of ['host', 'viewer']) {
      const window = new BrowserWindow({ show: label === 'host', width: 820, height: 680, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        partition: `browser-broadcast-${label}`, preload: label === 'host' || config.viewerPlatform === 'desktop'
          ? path.join(clientRoot, 'dist-electron', 'preload', 'preload.cjs') : path.join(__dirname, 'voiceActivityPreload.cjs'),
      } });
      windows.push(window);
      const keys = generateKeyPairSync('ed25519'); identities.set(window.webContents.id, keys);
      window.webContents.on('console-message', details => {
        if (details.level === 'error') console.error(`[${label}] ${details.message}`);
      });
      if (label === 'host') manager = registerMiniappBrowserIpc(window);
      await window.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__broadcast`);
      await run(window, `(${prepareBroadcastRenderer.toString()})(${JSON.stringify(config)},${JSON.stringify(label)},${JSON.stringify(
        keys.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'))},${JSON.stringify(MessageType)})`);
    }
    const [host, viewer] = windows;
    if (config.mode === 'sfu' && config.viewerPlatform === 'web') host.minimize();
    phase = 'command, real captured frame and publication ACK';
    await run(host, 'window.browserTest.invoke()');
    const published = await run(host, 'window.browserTest.published()');
    assert.equal(published.kind, 'browser');
    assert.equal(published.hostSessionId, await run(host, 'window.browserTest.sessionId'));
    await run(viewer, `window.browserTest.watch(${JSON.stringify(published)})`);
    const entry = [...manager.entries.values()][0];
    assert.ok(entry.broadcasting && entry.captureGranted);
    if (config.viewerPlatform === 'web') assert.equal(entry.container.getVisible(), false, 'Publication starts even before the host displays the stage');
    assert.equal(entry.site.root.isVisible(), false, 'The independent capture root is never a separate visible browser');
    const site = entry.view.webContents;
    assert.equal(site.getLastWebPreferences().preload, undefined);
    assert.deepEqual(await run(host, 'window.browserTest.trackKinds()'), ['video']);
    phase = 'top-level DENY site reaches the actual production receiver';
    await manager.control(entry.toolbar.webContents, { action: 'navigate', url: `http://127.0.0.1:${siteServer.address().port}/site` });
    assert.equal(await site.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(0, 0, 255)');
    const bluePixels = await run(host, 'window.browserTest.pixel([0,0,255],true)');
    await run(viewer, `window.browserTest.pixel(${JSON.stringify(bluePixels)})`);
    await run(host, `window.browserTest.pixel(${JSON.stringify(bluePixels)},"pipeline")`);
    for (const window of windows) {
      const stats = await run(window, 'window.browserTest.mediaStats()');
      assert.ok(stats.reports.some(report => report.type === 'codec' && report.mimeType === 'video/H264'
        && /profile-level-id=42e0/i.test(report.sdpFmtpLine)), 'Production uses its negotiated H264 codec');
      assert.ok(stats.reports.some(report => report.type === 'outbound-rtp' && report.framesEncoded > 0
        || report.type === 'inbound-rtp' && report.framesDecoded > 0), 'Actual media frames were encoded or decoded');
    }
    const sent = await run(host, 'window.browserTest.sampleFinalTrack()');
    assert.equal(sent.sentTrackId, sent.pipelineTrackId, 'The verified rendition is the actual sender/producer track');
    assert.ok(sent.pixels.every(({ rgba }, index) => rgba.slice(0,3).every((value, channel) =>
      Math.abs(value - bluePixels[index][channel]) <= 12)));
    phase = 'green site frame after navigation';
    await site.executeJavaScript('document.cookie="temporary-login=secret;path=/";document.body.style.background="rgb(0,255,0)";true');
    const greenPixels = await run(host, 'window.browserTest.pixel([0,255,0],true)');
    await run(viewer, `window.browserTest.pixel(${JSON.stringify(greenPixels)})`);
    assert.equal(await run(viewer, 'window.api.capabilities.miniappBrowser'), config.viewerPlatform === 'desktop');
    assert.equal(await run(viewer, 'window.browserTest.viewerSurface()'), true, 'The actual viewer surface presents video, not an iframe or native site');
    assert.equal(await run(viewer, 'window.browserTest.hasSiteControls()'), false);
    phase = 'hidden and minimized host continues site-only moving pixels';
    manager.visibility(entry.input.requestId, false);
    await site.executeJavaScript('document.body.style.background="rgb(0,0,255)";true');
    await run(viewer, `window.browserTest.pixel(${JSON.stringify(bluePixels)})`);
    assert.equal(await run(host, 'window.browserTest.trackLive()'), true);
    assert.deepEqual(await entry.session.cookies.get({ url: site.getURL() }).then(cookies => cookies.map(cookie => cookie.value)), ['secret']);
    host.minimize();
    await site.executeJavaScript('document.body.style.background="rgb(0,255,0)";true');
    await run(viewer, `window.browserTest.pixel(${JSON.stringify(greenPixels)})`);
    host.restore();
    phase = 'host leaves: live tracks, native contents and temporary logins retire';
    const destroyed = once(site, 'destroyed');
    if (config.mode === 'sfu' && config.viewerPlatform === 'desktop') {
      await manager.control(entry.toolbar.webContents, { action: 'close' });
      await run(host, 'window.browserTest.stopped()');
    } else await run(host, 'window.browserTest.leave()');
    await destroyed;
    await manager.closeAll();
    assert.equal(await run(host, 'window.browserTest.trackLive()'), false);
    assert.deepEqual(await entry.session.cookies.get({}), []);
    assert.equal(await run(viewer, 'window.browserTest.retired()'), true);
    console.log(`Browser ${config.mode}/${config.viewerPlatform}: site-only H264 pixels, hidden/minimized host, protocol40 coexistence and teardown passed`);
  } catch (error) {
    code = 1; console.error(`Browser broadcast failed during ${phase}:`, error);
    for (const window of windows) if (!window.isDestroyed()) {
      try { console.error(JSON.stringify(await run(window, 'window.browserTest?.mediaStats()'))); } catch (diagnosticError) { console.error(diagnosticError); }
    }
  } finally {
    clearTimeout(deadline);
    for (const window of windows) if (!window.isDestroyed()) {
      try { await run(window, 'window.browserTest?.cleanup()'); } catch (error) { code = 1; console.error(error); }
    }
    await manager?.dispose();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await vite?.close();
    if (siteServer) { siteServer.closeAllConnections(); await new Promise(resolve => siteServer.close(resolve)); }
    app.exit(code);
  }
}

async function prepareBroadcastRenderer(config, label, publicKey, MessageType) {
  if (label === 'viewer' && config.viewerPlatform === 'web') {
    const { createWebPlatformApi } = await import('/platform/web/webPlatform.ts');
    window.api = { ...createWebPlatformApi(), signChallenge: window.voiceActivityIdentity.signChallenge };
  }
  const [{ NetworkClient }, { ParticipantManager }, { BrowserMiniappMedia }, { BotBrowserView }] = await Promise.all([
    import('/core/NetworkClient.ts'), import('/core/ParticipantManager.ts'),
    import('/core/webrtc/BrowserMiniappMedia.ts'), import('/views/BotBrowserView.ts'),
  ]);
  const client = new NetworkClient(), participants = new ParticipantManager(), failures = [];
  const screens = new Map();
  let active = false, native, stream, media, sourceScreen, publication, browserViewer;
  let video = document.querySelector('video');
  const cleanupFailed = error => { failures.push(String(error)); };
  const fail = error => { failures.push(String(error)); native?.retire('revoked'); void media?.closeAll().catch(cleanupFailed); };
  client.onEvent((event, payload) => {
    if (event === `message.${MessageType.USER_JOINED}`) participants.addUser(payload.user ?? payload);
    if (event === `message.${MessageType.VOICE_USER_JOINED}`) {
      if (payload.user) participants.addUser(payload.user);
      participants.updateVoiceState(payload.voiceState);
    }
    if (event === `message.${MessageType.VOICE_USER_LEFT}`) {
      participants.removeVoiceState(payload.sessionId);
      if (payload.sessionId === auth.currentUser.sessionId) { active = false; native?.retire('revoked'); void media?.closeAll().catch(cleanupFailed); }
    }
    if (event === `message.${MessageType.BOT_SCREEN_SNAPSHOT}`) screens.set(payload.id, payload);
    if (event === `message.${MessageType.BOT_SCREEN_REMOVED}` && payload.instanceId === sourceScreen?.instanceId) {
      media?.retire(sourceScreen); native?.retire('revoked'); void media?.closeAll().catch(cleanupFailed); video.srcObject = null;
    }
  });
  const address = new URL(config.url);
  const auth = await client.connect(address.hostname, Number(address.port), { clientId: crypto.randomUUID(), publicKey }, label);
  participants.setUsers(auth.server.members);
  const joined = await client.sendRequest(MessageType.VOICE_JOIN, { channelId: config.voiceId });
  for (const peer of joined.participants ?? []) {
    participants.addUser(peer.user); participants.updateVoiceState(peer.voiceState);
  }
  participants.addUser(auth.currentUser); participants.updateVoiceState(joined.voiceState);
  active = true;
  media = new BrowserMiniappMedia(() => ({
    client, participants, sessionId: auth.currentUser.sessionId, channelId: config.voiceId, mode: config.mode,
    isCurrent: () => active && client.getStatus() === 'CONNECTED', announceSources: () => {},
  }));
  video.addEventListener('playing', () => { if (sourceScreen) media.playing(sourceScreen); });
  async function screenSnapshot() {
    const result = await client.sendRequest(MessageType.BOT_SCREEN_LIST, { channelId: config.voiceId });
    for (const screen of result.screens) screens.set(screen.id, screen);
    return screens.get('browser');
  }
  window.browserTest = {
    sessionId: auth.currentUser.sessionId,
    async invoke() {
      await client.sendRequest(MessageType.COMMAND_INVOKE, { botId: config.botId, channelId: config.textId, commandName: 'browser' });
      while (!screens.has('browser')) await new Promise(resolve => requestAnimationFrame(resolve));
      sourceScreen = screens.get('browser');
      native = new BotBrowserView({
        requestId: crypto.randomUUID(), serverKey: config.url, channelId: config.voiceId, screenId: sourceScreen.id,
        instanceId: sourceScreen.instanceId, botId: config.botId, viewerId: auth.currentUser.id,
        viewerSessionId: auth.currentUser.sessionId, title: 'Browser', locale: 'en', policyVersion: 1,
      }, () => { void media.closeAll().catch(cleanupFailed); }, fail, config.viewerPlatform === 'desktop');
      native.element.style.cssText = 'position:absolute;left:30px;top:80px;width:700px;height:480px;';
      document.querySelector('#app').append(native.element);
      stream = await native.capture();
      const presentation = HTMLVideoElement.prototype.requestVideoFrameCallback;
      if (config.mode === 'sfu' && config.viewerPlatform === 'desktop') {
        HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
          return presentation.call(this, () => {});
        };
      }
      try { publication = await media.host(sourceScreen, stream, fail, native.signal); }
      finally { HTMLVideoElement.prototype.requestVideoFrameCallback = presentation; }
      native.broadcasting();
    },
    published: screenSnapshot,
    async watch(screen) {
      sourceScreen = screen;
      const [{ webRtcManager }, { BotBrowserViewer }] = await Promise.all([
        import('/core/WebRtcManager.ts'), import('/views/BotBrowserViewer.ts'),
      ]);
      await webRtcManager.browserMiniappMedia.closeAll();
      webRtcManager.browserMiniappMedia = media;
      browserViewer = new BotBrowserViewer(screen, fail, () => browserViewer.retire('ended'));
      video.remove(); video = browserViewer.element;
      document.querySelector('#app').append(video);
    },
    async pixel(expected, captured = false) {
      const sampledVideo = captured ? document.createElement('video') : video;
      if (captured) {
        sampledVideo.muted = true;
        const entry = [...media.entries][0];
        sampledVideo.srcObject = captured === 'pipeline' ? new MediaStream([[...entry.publisher.pipelines.values()][0].video]) : stream;
        await sampledVideo.play();
      }
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'), deadline = performance.now() + 25000;
      let sampled;
      try {
        while (performance.now() < deadline) {
          if (failures.length) throw new Error(failures.join('\n'));
          if (sampledVideo.readyState >= 2) {
            sampled = [];
            // Compare actual capture coordinates without resampling the whole frame.
            for (const y of [0.05,0.25,0.5,0.75,0.95]) for (const x of [0.05,0.25,0.5,0.75,0.95]) {
              context.drawImage(sampledVideo, Math.floor(sampledVideo.videoWidth*x), Math.floor(sampledVideo.videoHeight*y),
                1,1,0,0,1,1);
              sampled.push(Array.from(context.getImageData(0,0,1,1).data));
            }
            const matches = Array.isArray(expected[0])
              ? sampled.every((pixel, point) => pixel.slice(0,3).every((value, channel) => Math.abs(value - expected[point][channel]) <= 12))
              : sampled.every((pixel, point) => {
                const content = expected.every((channel, index) => channel === 255 ? pixel[index] >= 180 : pixel[index] < 35);
                const row = Math.floor(point / 5), column = point % 5;
                // A tab can be letterboxed; its center must show the site, and its edges may only show that site or black.
                return content || (row === 0 || row === 4 || column === 0 || column === 4) && pixel.slice(0,3).every(value => value < 35);
              });
            if (matches) return sampled;
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        throw new Error(`No expected ${expected} ${captured ? 'captured' : 'received'} site pixels: ${sampled}; ${JSON.stringify(this.diagnostics())}`);
      } finally {
        if (captured) { sampledVideo.pause(); sampledVideo.srcObject = null; }
      }
    },
    trackKinds: () => stream.getTracks().map(track => track.kind),
    trackLive: () => stream?.getTracks().some(track => track.readyState === 'live') ?? false,
    hasSiteControls: () => !!document.querySelector('.miniapp-browser-tile'),
    viewerSurface: () => !!document.querySelector('video.miniapp-browser-viewer'),
    retired: () => !video.srcObject && !media.localSources().length,
    async leave() {
      active = false; native?.retire('revoked');
      const retirement = media.closeAll();
      await client.sendRequest(MessageType.VOICE_LEAVE, { channelId: config.voiceId });
      await retirement;
    },
    async stopped() {
      while (stream.getTracks().some(track => track.readyState === 'live')) await new Promise(resolve => requestAnimationFrame(resolve));
      await media.closeAll();
    },
    diagnostics: () => ({ label, active, failures, sourceScreen, sources: media.localSources(), screens: [...screens.values()],
      tracks: stream?.getTracks().map(track => ({ kind: track.kind, enabled: track.enabled, settings: track.getSettings() })),
      entries: [...media.entries].map(entry => ({ source: entry.source, retired: entry.retired,
        publisher: !!entry.publisher, receiver: !!entry.receiver })), video: { ready: video.readyState, width: video.videoWidth, height: video.videoHeight } }),
    async mediaStats() {
      const reports = [];
      for (const entry of media.entries) {
        if (entry.receiver) {
          const stats = await entry.receiver.stats();
          reports.push(...[...(stats?.values() ?? [])].filter(report => ['codec','inbound-rtp'].includes(report.type)));
        }
        if (entry.publisher) for (const viewer of entry.publisher.viewers.values()) {
          const stats = await viewer.peer?.options.port.stats();
          reports.push(...[...(stats?.values() ?? [])].filter(report => ['codec','outbound-rtp'].includes(report.type)));
        }
        if (entry.publisher) for (const pipeline of entry.publisher.pipelines.values()) {
          for (const producer of pipeline.sfu?.producers ?? []) {
            const stats = await producer.getStats();
            reports.push(...[...stats.values()].filter(report => ['codec','outbound-rtp'].includes(report.type)));
          }
        }
      }
      return { label, tracks: this.diagnostics().tracks, reports };
    },
    async sampleFinalTrack() {
      const entry = [...media.entries][0];
      const pipeline = entry.publisher && [...entry.publisher.pipelines.values()][0];
      const peer = entry.publisher && [...entry.publisher.viewers.values()][0]?.peer;
      const sender = peer?.options.port.peer.getSenders().find(value => value.track?.kind === 'video');
      const producer = pipeline?.sfu?.producers.find(value => value.kind === 'video');
      const sent = sender?.track ?? producer?.track;
      if (!sent || sent !== pipeline.video) throw new Error('The actual sender does not own the verified rendition track.');
      const sampled = document.createElement('video');
      sampled.muted = true; sampled.srcObject = new MediaStream([sent]); await sampled.play();
      await new Promise(resolve => sampled.requestVideoFrameCallback(resolve));
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'), pixels = [];
      for (const y of [0.05,0.25,0.5,0.75,0.95]) for (const x of [0.05,0.25,0.5,0.75,0.95]) {
        context.drawImage(sampled, Math.floor(sampled.videoWidth*x), Math.floor(sampled.videoHeight*y), 1,1,0,0,1,1);
        pixels.push({ x,y,rgba:Array.from(context.getImageData(0,0,1,1).data) });
      }
      const result = { label, sentTrackId:sent?.id, pipelineTrackId:pipeline?.video.id,
        width:sampled.videoWidth,height:sampled.videoHeight,pixels };
      sampled.pause(); sampled.srcObject = null;
      return result;
    },
    async cleanup() {
      native?.retire('revoked'); browserViewer?.retire('revoked'); await media.closeAll();
      active = false; video.srcObject = null; client.dispose();
      if (failures.length) throw new Error(failures.join('\n'));
    },
  };
}
