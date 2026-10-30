const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dispatchKey } = require('./fixtures/nativeKeyboard.cjs');
const root = path.resolve(__dirname, '..');

// The channel feed mirrors the store: it holds the same newest messages the
// store keeps (R-CHAT-6), and marks as "mentions me" exactly what the sound and
// the @ badge treat as a mention (R-SHELL-6). Channels and direct messages keep
// following the newest message while their view scrolls to it, and revealing
// the conversation scrolls once and moves no more than the reveal allows, even
// with a scroll to the end still pending or the viewport resizing under it, on
// the way or once the view came to rest. The reader scrolling up during such a
// scroll, or in the same frame as an instant one, stops following however they
// scroll; nothing else does, not content growing under the view, nor that scroll
// running out of time short of the end (#490). What must happen while a scroll is
// on its way happens at a frame the test chooses, never at one the machine's speed
// allows. A failing check shows what each feed did (fixtures/feedRecorder.cjs).
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('the chat feed follows the store window, the shared mention rule and the newest message', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `chat-feed-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_CHAT_FEED_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(result, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const { recordFeed } = require('./fixtures/feedRecorder.cjs');
  app.setPath('userData', process.env.MONKY_CHAT_FEED_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Chat feed DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'chat-feed-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__chat_feed__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head>'
              + '<body><div id="app" style="height:100vh;display:flex;flex-direction:column"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, true);
    // A failing check also shows what each feed did: its state and its last steps.
    const check = async (condition, message) => {
      if (condition) return;
      const state = await evaluate('window.fixture.state()');
      const feeds = await evaluate('window.fixture.feeds()').catch(error => String(error));
      throw new Error(`${message}: ${JSON.stringify(state)}\nFeeds: ${JSON.stringify(feeds)}`);
    };
    const mouse = (params) => browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', params);
    const click = async (point) => {
      await mouse({ type: 'mouseMoved', x: point.x, y: point.y });
      await mouse({ type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await mouse({ type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    };
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__chat_feed__`);
      // Instant scrolling keeps the reading-position check free of animations in flight.
      browser.webContents.debugger.attach('1.3');
      await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await evaluate(`window.recordFeed = ${recordFeed}; void 0`);
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // 240 messages of history, then 60 live ones: the store keeps the newest 250.
      await evaluate('window.fixture.open(240)');
      await check((await evaluate('window.fixture.state()')).rows === 240, 'the history is drawn');
      await evaluate('window.fixture.live(240, 60)');
      let state = await evaluate('window.fixture.state()');
      await check(state.rows === 250 && state.stored === 250 && state.first === 'busy-50' && state.orphans === 0
        && state.dividers === 1 && state.unknown === 0,
      'the feed drops the rows the store let go of, with the divider of a day left empty');
      await check(await evaluate('window.fixture.firstRowMenu()') >= 2, 'the oldest row left keeps its message actions');

      // Someone reading further up keeps the same messages in view while rows above leave.
      const before = await evaluate('window.fixture.readMiddle()');
      await evaluate('window.fixture.live(300, 1)');
      const after = await evaluate(`window.fixture.rowTop(${JSON.stringify(before.id)})`);
      state = await evaluate('window.fixture.state()');
      await check(state.rows === 250 && state.first === 'busy-51' && Math.abs(after - before.top) <= 1,
        `the reading position stays put (${before.top} → ${after})`);

      // The row highlight follows the rule of the sound and the @ badge.
      await evaluate(`window.fixture.say([
        ['prefix', 'oi @Lucas, tudo bem?'], ['bold', '**@lu** vem ver'], ['everyone', 'bom dia @todos'],
        ['code', 'use \`@Lu\` no código'], ['mail', 'escreva para lu@exemplo.com'],
      ])`);
      const marked = () => evaluate('window.fixture.mentioned()');
      const expected = JSON.stringify({ prefix: false, bold: true, everyone: true, code: false, mail: false });
      await check(JSON.stringify(await marked()) === expected, 'only whole mentions of the reader highlight live rows');
      await evaluate('window.fixture.redraw()');
      await check(JSON.stringify(await marked()) === expected, 'a full redraw highlights the same rows');

      // A second message arriving while the scroll to the first one is still on
      // its way is followed too: the frames of that scroll are not the reader
      // leaving the end (#490). Scrolling up by hand still stops following.
      // The direct conversation shares the window from here on, so both feeds
      // keep the same short height in every pass.
      await evaluate('window.fixture.ensureDm()');
      // Real keys need a focused page.
      await browser.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      browser.webContents.focus();
      for (const motion of ['no-preference', 'reduce']) {
        await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: motion }],
        });
        for (const view of ['channel', 'dm']) {
          const label = `${view}, ${motion} motion`;
          const race = await evaluate(`window.fixture.arriveWhileScrolling(${JSON.stringify(view)})`);
          await check(race.reproduced, `${label}: the second message arrives before the scroll to the first one ends (${JSON.stringify(race)})`);
          await check(race.distance <= 1 && race.lastVisible && race.following,
            `${label}: two arrivals in consecutive frames end at the newest message, still following (${JSON.stringify(race)})`);
          const next = await evaluate(`window.fixture.arrive(${JSON.stringify(view)})`);
          await check(next.distance <= 1 && next.following, `${label}: the next message is followed as well (${JSON.stringify(next)})`);
          const point = await evaluate(`window.fixture.feedPoint(${JSON.stringify(view)})`);
          browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          browser.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: 480 });
          const away = await evaluate(`window.fixture.settle(${JSON.stringify(view)})`);
          await check(!away.following && away.distance > 48, `${label}: scrolling up by hand stops following (${JSON.stringify(away)})`);
          const after = await evaluate(`window.fixture.arrive(${JSON.stringify(view)})`);
          await check(!after.following && after.shift !== null && Math.abs(after.shift) <= 1,
            `${label}: a message arriving after that leaves the reader where they are (${JSON.stringify(after)})`);
          if (view === 'dm') {
            const sent = await evaluate('window.fixture.sendDm()');
            await check(sent.sent && sent.distance <= 1 && sent.lastVisible && sent.following,
              `${label}: sending brings the author back to their message, as in channels (${JSON.stringify(sent)})`);
          }
          const revealed = await evaluate(`window.fixture.revealOnce(${JSON.stringify(view)})`);
          await check(revealed.followUp === 0 && revealed.distance <= 1 && revealed.lastVisible && revealed.following,
            `${label}: a reveal scrolls once and ends at the newest message (${JSON.stringify(revealed)})`);
          const pending = await evaluate(`window.fixture.pinPendingAtReveal(${JSON.stringify(view)})`);
          await check(pending.longest <= pending.limit + 1 && pending.distance <= 1 && pending.lastVisible && pending.following,
            `${label}: a scroll to the end asked just before the reveal keeps the reveal's short movement (${JSON.stringify(pending)})`);
          const resized = await evaluate(`window.fixture.revealAcrossResize(${JSON.stringify(view)})`);
          await check(resized.net > 0 && resized.distance <= 1 && resized.lastVisible && resized.following,
            `${label}: a reveal ends on the newest message when one frame grows the viewport and shrinks it again (${JSON.stringify(resized)})`);
          const late = await evaluate(`window.fixture.growAfterReveal(${JSON.stringify(view)})`);
          await check(late.grown.length === 2 && late.distance <= 1 && late.lastVisible && late.following,
            `${label}: the composer growing after the reveal came to rest, twice in its moment, keeps the newest message in view (${JSON.stringify(late)})`);

          // While a scroll to the end is on its way, the reader also scrolls up in
          // ways the feed's own events never see: keys with the focus on the body,
          // a selection dragged past the top. That stops following all the same,
          // and nothing pulls the view back afterwards (#490). Without motion the
          // scroll is instant: there is nothing on its way to interrupt.
          const moving = motion === 'no-preference';
          await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
          const quiet = await evaluate(`window.fixture.quietPoint(${JSON.stringify(view)})`);
          await check(quiet, `${label}: the feed has a spot beside the messages`);
          await click(quiet);
          await check(await evaluate('window.fixture.focusOnBody()'), `${label}: a click beside the messages leaves the focus on the body`);
          await evaluate(`window.fixture.arriveAndWatch(${JSON.stringify(view)}, 'keydown')`);
          await dispatchKey(browser, 'PageUp', 'PageUp', 33);
          const keyed = await evaluate(`window.fixture.landed(${JSON.stringify(view)})`);
          await check(keyed.rose > 1, `${label}: Page Up moved the feed, as this case needs: this window does not scroll with the keyboard (${JSON.stringify(keyed)})`);
          await check((!moving || keyed.during) && !keyed.following && keyed.distance > 48,
            `${label}: Page Up with the focus on the body, during the scroll to a new message, stops following (${JSON.stringify(keyed)})`);
          const afterKey = await evaluate(`window.fixture.arrive(${JSON.stringify(view)})`);
          await check(!afterKey.following && afterKey.shift !== null && Math.abs(afterKey.shift) <= 1,
            `${label}: the next message leaves the reader where the key took them (${JSON.stringify(afterKey)})`);

          await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
          await evaluate(`window.fixture.arriveAndWatch(${JSON.stringify(view)}, 'mousedown')`);
          const from = await evaluate(`window.fixture.textPoint(${JSON.stringify(view)})`);
          await check(from, `${label}: a message's text is in view`);
          await mouse({ type: 'mouseMoved', x: from.x, y: from.y });
          await mouse({ type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
          await evaluate(`window.fixture.autoscrollUp(${JSON.stringify(view)})`);
          await mouse({ type: 'mouseReleased', x: from.x, y: from.y, button: 'left', buttons: 0, clickCount: 1 });
          const dragged = await evaluate(`window.fixture.landed(${JSON.stringify(view)})`);
          await check((!moving || dragged.during) && !dragged.following && dragged.distance > 48,
            `${label}: a selection autoscrolled past the top, during the scroll to a new message, stops following (${JSON.stringify(dragged)})`);
          const afterDrag = await evaluate(`window.fixture.arrive(${JSON.stringify(view)})`);
          await check(!afterDrag.following && afterDrag.shift !== null && Math.abs(afterDrag.shift) <= 1,
            `${label}: the next message leaves the reader where the selection took them (${JSON.stringify(afterDrag)})`);

          // Images of the newest message loading one after the other: each pins the
          // end again while the reader follows, and none once they scrolled away.
          await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
          await evaluate(`window.fixture.pendImages(${JSON.stringify(view)}, 3)`);
          await click(await evaluate(`window.fixture.quietPoint(${JSON.stringify(view)})`));
          await evaluate(`window.fixture.loadImage(${JSON.stringify(view)}, 'keydown')`);
          await dispatchKey(browser, 'PageUp', 'PageUp', 33);
          const loading = await evaluate(`window.fixture.landed(${JSON.stringify(view)})`);
          await check(loading.rose > 1, `${label}: Page Up moved the feed, as this case needs: this window does not scroll with the keyboard (${JSON.stringify(loading)})`);
          await check((!moving || loading.during) && !loading.following && loading.distance > 48,
            `${label}: Page Up while the view follows a loaded image stops following (${JSON.stringify(loading)})`);
          for (const image of [2, 3]) {
            const later = await evaluate(`window.fixture.loadImageAndSettle(${JSON.stringify(view)})`);
            await check(!later.following && later.shift !== null && Math.abs(later.shift) <= 1,
              `${label}: image ${image} loading afterwards does not pull the view back (${JSON.stringify(later)})`);
          }
          await evaluate(`window.fixture.dropImages(${JSON.stringify(view)})`);

          // Where scrolling is instant (smooth scrolling turned off in Windows), a Page
          // Up moves the view in a single step, and that step can come before the scroll
          // event of a pin to an image that just loaded: after the pin, or ahead of it.
          // Either way the reader stops following and stays where the key took them, and
          // the next image does not pull the view back (#490).
          for (const when of ['after', 'before']) {
            await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
            await evaluate(`window.fixture.pendImages(${JSON.stringify(view)}, 2)`);
            const climbed = await evaluate(`window.fixture.loadImageAndClimb(${JSON.stringify(view)}, '${when}')`);
            await check(!climbed.following && climbed.distance > 48 && climbed.shift !== null && Math.abs(climbed.shift) <= 1,
              `${label}: the view moving up ${when} the pin to a loaded image, before its scroll event, stops following (${JSON.stringify(climbed)})`);
            const next = await evaluate(`window.fixture.loadImageAndSettle(${JSON.stringify(view)})`);
            await check(!next.following && next.shift !== null && Math.abs(next.shift) <= 1,
              `${label}: the next image loading afterwards does not pull the view back (${JSON.stringify(next)})`);
            await evaluate(`window.fixture.dropImages(${JSON.stringify(view)})`);
          }
          // A message far above shrinking and an image of the newest message loading in
          // the same task is no climb: the reader still follows and sees the image (#490).
          await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
          await evaluate(`window.fixture.pendImages(${JSON.stringify(view)}, 1)`);
          const kept = await evaluate(`window.fixture.shrinkAboveAndLoad(${JSON.stringify(view)})`);
          await check(kept.shrunk > 20 && kept.following && kept.distance <= 1 && kept.lastVisible,
            `${label}: a row above shrinking as an image of the newest message loads, in the same task, keeps following to the image (${JSON.stringify(kept)})`);
          await evaluate(`window.fixture.dropImages(${JSON.stringify(view)})`);

          // The newest message grows under the view while the scroll to it is on
          // its way (an image whose size arrives before it loads), so the scroll
          // ends short of the end. The reader did not move: they still follow once
          // its time is up, and the image loading later brings the view down.
          // Growth in the last stretch of the scroll is followed the same way.
          // Moving the view up before that time stops following, even as the time
          // runs out; after it, scrolls are the reader's own again.
          if (moving) {
            await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
            let cut = await evaluate(`window.fixture.growShort(${JSON.stringify(view)}, 'midway')`);
            await check(cut.grownAt !== null && cut.distance > 88 && cut.following,
              `${label}: the newest message growing under the view midway leaves the scroll to it short, still following (${JSON.stringify(cut)})`);
            const kept = await evaluate(`window.fixture.outlast(${JSON.stringify(view)})`);
            await check(kept.following && kept.distance > 48,
              `${label}: a reader who did not move still follows once the time of the cut-short scroll is up (${JSON.stringify(kept)})`);
            const repinned = await evaluate(`window.fixture.loadImageAndSettle(${JSON.stringify(view)})`);
            await check(repinned.following && repinned.distance <= 1 && repinned.lastVisible,
              `${label}: the image of that message loading afterwards brings the view down to it (${JSON.stringify(repinned)})`);

            await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
            const tail = await evaluate(`window.fixture.growShort(${JSON.stringify(view)}, 'tail')`);
            await check(tail.grownAt !== null && tail.distance > 88 && tail.following,
              `${label}: the newest message growing under the view in the last stretch of the scroll to it keeps following (${JSON.stringify(tail)})`);
            const caught = await evaluate(`window.fixture.arrive(${JSON.stringify(view)})`);
            await check(caught.following && caught.distance <= 1 && caught.lastVisible,
              `${label}: the next message then brings the view down to it (${JSON.stringify(caught)})`);

            for (const withMessage of [false, true]) {
              await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
              cut = await evaluate(`window.fixture.growShort(${JSON.stringify(view)}, 'midway')`);
              const climbed = await evaluate(`window.fixture.jumpUp(${JSON.stringify(view)}, ${withMessage})`);
              await check(cut.grownAt !== null && cut.distance > 88 && !climbed.following && climbed.distance > 48
                && climbed.shift !== null && Math.abs(climbed.shift) <= 1,
                `${label}: jumping up after the cut, before its time is up, stops following${withMessage
                  ? ', even with a message arriving before the jump\'s scroll event' : ''} (${JSON.stringify({ cut, climbed })})`);
            }

            await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
            const landing = await evaluate(`window.fixture.climbAtLanding(${JSON.stringify(view)})`);
            await check(landing.cut.grownAt !== null && landing.cut.distance > 88 && landing.followingAtLanding === false
              && !landing.following && landing.distance > 48 && landing.shift !== null && Math.abs(landing.shift) <= 1,
              `${label}: a jump up as the time of the cut-short scroll runs out, before its scroll event, stops following, and a message then leaves the view where it went (${JSON.stringify(landing)})`);

            await evaluate(`window.fixture.rest(${JSON.stringify(view)})`);
            cut = await evaluate(`window.fixture.growShort(${JSON.stringify(view)}, 'midway')`);
            await evaluate(`window.fixture.outlast(${JSON.stringify(view)})`);
            const nudged = await evaluate(`window.fixture.nudgeDown(${JSON.stringify(view)})`);
            await check(cut.grownAt !== null && cut.distance > 88 && !nudged.following && nudged.distance > 48,
              `${label}: once that time is up, a scroll short of the end stops following, as any scroll does (${JSON.stringify({ cut, nudged })})`);
            await evaluate(`window.fixture.dropImages(${JSON.stringify(view)})`);
          }
        }
      }
      console.log('Chat feed DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupFixture() {
  localStorage.clear();
  const [{ ChatView }, { sessionManager }, language, { contextMenu }, { dmStore }, { DmConversationView }] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/i18n/index.ts'), import('/views/ContextMenu.ts'),
    import('/stores/dmStore.ts'), import('/views/home/DmConversationView.ts'),
  ]);
  language.setLanguage('en');
  const root = document.getElementById('app');
  const me = { id: 'feed-me', clientId: 'feed-device', nickname: 'Lu', status: 'ONLINE', joinedAt: 1 };
  const lucas = { id: 'feed-lucas', clientId: 'feed-lucas-device', nickname: 'Lucas', status: 'ONLINE', joinedAt: 1 };
  sessionManager.install();
  const session = sessionManager.create('chat-feed.local', 49312, me.nickname);
  session.serverStore.setServerDetails({
    id: 'feed-server', name: 'Feed', createdAt: 1, maxUsers: 10, voiceStates: {}, allowEveryoneMention: true,
    channels: [{ id: 'busy', name: 'busy', serverId: 'feed-server', type: 'TEXT', position: 0, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true }],
    members: [me, lucas], knownMembers: [me, lucas], roles: [], userRoles: [],
    myPermissions: 2147483647 & ~(1 << 11), ownerId: 'someone-else',
  }, me);
  session.client.getStatus = () => 'CONNECTED';
  session.client.getCurrentServerUrl = () => session.key;
  session.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  session.client.send = () => {};
  session.client.sendRequest = () => Promise.resolve({ selectors: [] });
  sessionManager.activate(session.key);
  // The ten oldest messages belong to an earlier day than the rest.
  const message = (index, content = `Message ${index}`) => ({
    id: `busy-${index}`, channelId: 'busy', userId: lucas.id, userNickname: lucas.nickname, isSystem: false, content,
    createdAt: index < 10 ? Date.UTC(2026, 9, 14, 12) + index * 60_000 : Date.UTC(2026, 9, 16, 8) + index * 60_000,
  });
  const chatRoot = document.createElement('div');
  chatRoot.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
  root.appendChild(chatRoot);
  const chat = new ChatView(chatRoot);
  const feed = () => document.getElementById('chat-messages-feed');
  const rows = () => [...feed().querySelectorAll(':scope > .chat-message-row')];
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  let spoken = 0;
  const said = new Map();

  // A direct conversation beside the channel, mounted for the follow checks only.
  const peer = 'a'.repeat(64);
  let deliverDm = () => {};
  let dmView = null;
  let dmMessages = 0;
  const dmMessage = (content) => {
    const index = dmMessages++;
    return { id: `dm-${index}`, peer, author: peer, content, createdAt: Date.UTC(2026, 9, 16, 9) + index * 60_000,
      editedAt: null, deleted: false, replyTo: null, reactions: [], attachments: [], forwarded: null, delivery: null };
  };
  const ensureDm = async () => {
    if (dmView) return;
    const ok = value => Promise.resolve({ ok: true, value });
    const history = Array.from({ length: 40 }, (_, index) => dmMessage(`Hello ${index}`));
    const handlers = {
      snapshot: () => ok({ me: { publicKey: 'f'.repeat(64) }, settings: { maxFileBytes: 1024 },
        peers: [{ publicKey: peer, nickname: 'Friend', avatar: null, relation: 'friend', blocked: false,
          friendSince: 1, requestedAt: null, maxFileBytes: 1024 }],
        conversations: [{ peer, lastMessageAt: 2, lastMessagePreview: '', lastMessageAuthor: peer, unread: 0,
          hidden: false, readOnly: false }] }),
      conversation: () => ok({ peer, hasMore: false, peerReadAt: 0, messages: history }),
      pendingPeers: () => ok([]),
      // The own message shows up first; the send completes a moment later, as when
      // the ledger is still being written.
      sendMessage: async (request) => {
        deliverDm({ ...dmMessage(request.content), author: 'f'.repeat(64), delivery: 'pending' });
        await frames();
        return { ok: true, value: {} };
      },
      onEvent: (listener) => {
        deliverDm = (message) => listener({ type: 'messages', peer, peerReadAt: 0, messages: [message] });
        return () => {};
      },
    };
    window.api = { dm: new Proxy({}, { get: (_target, name) => handlers[name] ?? (() => ok({})) }),
      openExternal: async () => ({ success: true }) };
    await dmStore.init();
    const dmRoot = document.createElement('div');
    dmRoot.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
    root.appendChild(dmRoot);
    dmView = new DmConversationView(peer);
    dmView.mount(dmRoot);
    for (let frame = 0; frame < 120 && dmRoot.querySelectorAll('[data-dm-feed] .chat-message-row').length < 40; frame++) await frames();
    recorded('channel');
    recorded('dm');
  };
  let arrivals = 0;
  const tall = (label) => [label, ...Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)].join('\n');
  const views = {
    channel: {
      feed,
      list: () => chat.feed.list,
      deliver: (content) => session.chatStore.addMessage(message(5000 + arrivals++, content)),
    },
    dm: {
      feed: () => document.querySelector('[data-dm-feed]'),
      list: () => dmView.feed,
      deliver: (content) => deliverDm(dmMessage(content)),
    },
  };
  // What each feed did, for a failing check to show (fixtures/feedRecorder.cjs).
  const recorded = (view) => {
    const list = view === 'dm' && !dmView ? null : views[view].list();
    return list ? window.recordFeed(list) : null;
  };
  // Where the feed rests now.
  const measure = (view) => {
    const element = views[view].feed();
    const lastRow = [...element.querySelectorAll('.chat-message-row')].at(-1);
    return {
      scrollTop: element.scrollTop,
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      following: views[view].list().following,
      lastVisible: !!lastRow && lastRow.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1,
    };
  };
  // Waits for the feed to stop moving, then says where it rests.
  const settle = async (view) => {
    const element = views[view].feed();
    let last = -1;
    let still = 0;
    for (let frame = 0; frame < 300 && still < 8; frame++) {
      await new Promise(requestAnimationFrame);
      still = Math.abs(element.scrollTop - last) < 0.5 ? still + 1 : 0;
      last = element.scrollTop;
    }
    return measure(view);
  };
  // The first row in view and where it sits.
  const place = (view) => {
    const element = views[view].feed();
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll('.chat-message-row')].find(entry => entry.getBoundingClientRect().bottom > top + 4);
    return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
  };
  // Whether the reader's next input came while a scroll to the end was still on its
  // way, and where the view was then.
  let flight = { during: null, top: null };
  const watchInput = (view, type) => {
    const element = views[view].feed();
    const watched = { during: null, top: null };
    flight = watched;
    window.addEventListener(type, () => {
      watched.during = element.scrollHeight - element.scrollTop - element.clientHeight > 1;
      watched.top = element.scrollTop;
    }, { capture: true, once: true });
  };
  const testImages = (view) => views[view].feed().querySelectorAll('img.chat-feed-test-image');
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Holds the feed's smooth scroll to the newest message (#490). Chromium runs it on
  // the compositor, and a slow runner may only see it once it is over, so anything that
  // must happen while it is on its way would race the machine's speed. Held, the feed
  // still asks to scroll, the test puts the view where a frame of that scroll would be,
  // and then the browser finishes it (release) or it stops there, as when the reader
  // takes over (drop). A real smooth scroll ends once, so the scrollend of each held
  // frame is kept from the feed.
  let holding = null;
  // When the time of the feed's last scroll to the newest message runs out, as the feed set it.
  const deadlines = new Map();
  const holdScroll = (view, unasked) => {
    const element = views[view].feed();
    const held = { target: null, scrolls: 0, ends: 0 };
    element.scrollTo = function (options) {
      if (options?.behavior === 'smooth') {
        // Chromium keeps the destination as it was when the scroll began, clamped to the end.
        held.target = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
        deadlines.set(view, views[view].list().autoScrollUntil);
        return;
      }
      // An instant scroll ends a smooth one, as in Chromium.
      held.target = null;
      Element.prototype.scrollTo.call(this, options);
    };
    const counted = () => { held.scrolls++; };
    const kept = (event) => {
      if (event.target !== element) return;
      held.ends++;
      event.stopImmediatePropagation();
    };
    element.addEventListener('scroll', counted, { passive: true });
    document.addEventListener('scrollend', kept, true);
    const until = async (done, failure) => {
      for (let frame = 0; frame < 30 && !done(); frame++) await new Promise(requestAnimationFrame);
      if (!done()) throw new Error(`${view}: ${failure}`);
    };
    const destination = () => held.target;
    const hold = {
      // A direct conversation draws a new message, and asks to scroll to it, in the next frame.
      requested: () => until(() => held.target !== null, unasked),
      // How far the view still is from where the held scroll goes.
      left: () => destination() - element.scrollTop,
      // Puts the view where a frame of the held scroll would be, `left` px before it gets there.
      async frameAt(left) {
        const { scrolls, ends } = held;
        element.scrollTop = destination() - left;
        await until(() => held.scrolls > scrolls && held.ends > ends, 'a held frame of the scroll was not delivered');
      },
      drop() {
        delete element.scrollTo;
        element.removeEventListener('scroll', counted);
        document.removeEventListener('scrollend', kept, true);
        if (holding === hold) holding = null;
      },
      release() {
        hold.drop();
        if (held.target !== null) element.scrollTo({ top: held.target, behavior: 'smooth' });
      },
    };
    holding = hold;
    return hold;
  };
  // A held scroll stays the feed's scroll to the newest message for its 2 s, and a case
  // takes a few frames to build. A runner too slow even for that fails here, saying so,
  // rather than in a check about the feed. A scroll the feed itself ended before its
  // time, short of the end, is the feed's failure, and says so too.
  const onItsWay = (view, moment) => {
    const now = performance.now();
    if (views[view].list().autoScrollUntil > now) return;
    const element = views[view].feed();
    const left = Math.round(element.scrollHeight - element.clientHeight - element.scrollTop);
    const remaining = Math.round((deadlines.get(view) ?? 0) - now);
    if (remaining > 0) {
      throw new Error(`${view}: the feed ended its scroll to the newest message ${left} px short of the end, with ${remaining} ms of its time left, before ${moment}`);
    }
    throw new Error(`${view}: the scroll to the newest message was over before ${moment}: the runner was too slow to build this case`);
  };
  // Holds the scroll to what just arrived (a message, a loaded image) halfway there.
  const holdHalfway = async (view, arrive) => {
    const hold = holdScroll(view, 'the feed did not scroll to what arrived');
    try {
      await arrive();
      await hold.requested();
      // The feed's own follow-up frame goes first: it pins again an end that moved.
      await frames();
      if (hold.left() < 100) throw new Error(`${view}: the scroll to the new message is too short to stop it halfway (${hold.left()} px)`);
      await hold.frameAt(Math.round(hold.left() / 2));
      return hold;
    } catch (error) {
      hold.drop();
      throw error;
    }
  };

  window.fixture = {
    open: (count) => {
      chat.setChannel('busy');
      session.chatStore.setHistory('busy', Array.from({ length: count }, (_, index) => message(index)));
    },
    live: (from, count) => {
      for (let index = from; index < from + count; index++) session.chatStore.addMessage(message(index));
    },
    state: () => {
      const stored = new Set(session.chatStore.getMessages('busy').map(entry => entry.id));
      const children = [...feed().children];
      return {
        rows: rows().length,
        stored: stored.size,
        first: rows()[0]?.dataset.messageId,
        unknown: rows().filter(row => !stored.has(row.dataset.messageId)).length,
        dividers: children.filter(child => child.classList.contains('chat-date-divider')).length,
        orphans: children.filter((child, index) => child.classList.contains('chat-date-divider')
          && (!children[index + 1] || children[index + 1].classList.contains('chat-date-divider'))).length,
      };
    },
    firstRowMenu: async () => {
      // The menu closes on any scroll: the scrolls of the messages just added must land first.
      await frames();
      const more = rows()[0].querySelector('[data-message-action="more"]');
      more.click();
      await frames();
      const items = document.querySelectorAll('.floating-context-menu [role^="menuitem"]').length;
      contextMenu.close();
      return items;
    },
    readMiddle: async () => {
      await frames();
      const target = rows()[120];
      feed().scrollTop += target.getBoundingClientRect().top - feed().getBoundingClientRect().top - 200;
      await frames();
      return { id: target.dataset.messageId, top: target.getBoundingClientRect().top };
    },
    rowTop: async (id) => {
      await frames();
      return feed().querySelector(`.chat-message-row[data-message-id="${id}"]`).getBoundingClientRect().top;
    },
    say: (entries) => {
      for (const [key, content] of entries) {
        const entry = message(1000 + spoken++, content);
        said.set(key, entry.id);
        session.chatStore.addMessage(entry);
      }
    },
    mentioned: () => Object.fromEntries([...said].map(([key, id]) => [key,
      !!feed().querySelector(`.chat-message-row.chat-message-mentioned[data-message-id="${id}"]`)])),
    feeds: () => ({ channel: recorded('channel')?.dump() ?? null, dm: recorded('dm')?.dump() ?? null }),
    redraw: () => chat.render(),
    ensureDm,
    settle,
    feedPoint: (view) => {
      const box = views[view].feed().getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    },
    // A arrives, and B arrives while the scroll to A has moved but is still short of the end.
    arriveWhileScrolling: async (view) => {
      if (view === 'dm') await ensureDm();
      const target = views[view];
      const element = target.feed();
      target.list().scrollToEnd();
      const ready = await settle(view);
      if (ready.distance > 1 || !ready.following) return { reproduced: false, ready };
      if (reducedMotion()) {
        // Without motion the scroll to A is instant: B arrives in the next frame.
        target.deliver(tall(`A${arrivals}`));
        await new Promise(requestAnimationFrame);
        target.deliver(tall(`B${arrivals}`));
        return { reproduced: true, ...(await settle(view)) };
      }
      const hold = await holdHalfway(view, () => target.deliver(tall(`A${arrivals}`)));
      const midway = element.scrollHeight - element.scrollTop - element.clientHeight;
      try {
        onItsWay(view, 'the second message');
        target.deliver(tall(`B${arrivals}`));
        // A direct conversation draws it in the next frame.
        await frames();
      } finally {
        hold.release();
      }
      return { reproduced: midway > 48, midway: Math.round(midway), ...(await settle(view)) };
    },
    arrive: async (view) => {
      const before = place(view);
      views[view].deliver(tall(`C${arrivals}`));
      const state = await settle(view);
      const row = views[view].feed().querySelector(`.chat-message-row[data-message-id="${CSS.escape(before.id)}"]`);
      return { ...state, shift: row ? row.getBoundingClientRect().top - before.top : null };
    },
    // Revealing the conversation from far above scrolls once: its follow-up frame
    // pins the end again only when it moved, since pinning the same end in the
    // next frame can stop the reveal short of the newest message (#490).
    revealOnce: async (view) => {
      const target = views[view];
      const element = target.feed();
      element.scrollTo({ top: 0, behavior: 'instant' });
      await frames();
      const calls = [];
      element.scrollTo = function (options) {
        calls.push(options.behavior);
        Element.prototype.scrollTo.call(this, options);
      };
      try {
        target.list().scrollToEnd({ reveal: true });
        const first = calls.length;
        await frames();
        return { ...(await settle(view)), first, followUp: calls.length - first };
      } finally {
        delete element.scrollTo;
      }
    },
    // A scroll to the end asked just before the conversation is revealed (the
    // composer settling as the channel opens) has its follow-up frame run during
    // the reveal, after the layout moved the end: it moves no more than the
    // reveal does (#490).
    pinPendingAtReveal: async (view) => {
      const target = views[view];
      const element = target.feed();
      element.scrollTo({ top: 0, behavior: 'instant' });
      await frames();
      const legs = [];
      const last = element.lastElementChild;
      const limit = Math.min(160, element.clientHeight / 3);
      try {
        target.list().scrollToEnd();
        element.scrollTo({ top: 0, behavior: 'instant' });
        element.scrollTo = function (options) {
          const destination = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
          if (options.behavior === 'smooth') legs.push(Math.round(Math.abs(destination - this.scrollTop)));
          Element.prototype.scrollTo.call(this, options);
        };
        target.list().scrollToEnd({ reveal: true });
        last.style.paddingBottom = '40px';
        return { ...(await settle(view)), limit: Math.round(limit), longest: Math.max(0, ...legs), legs };
      } finally {
        delete element.scrollTo;
        last.style.paddingBottom = '';
      }
    },
    // The conversation opens, and one frame grows its viewport (the layout settling)
    // and shrinks it again (the composer growing), with the feed pinning the end in
    // between: a slow machine can put all of it in one frame. The viewport grew
    // overall, yet the end moved below where the scroll goes, and the reveal must
    // still end on the newest message (#490). The order is fixed, whatever the
    // machine: the frame runs its callbacks as they were asked for.
    revealAcrossResize: async (view) => {
      const target = views[view];
      const element = target.feed();
      const composer = element.parentElement.querySelector(':scope > .chat-input-container');
      const base = parseFloat(getComputedStyle(composer).paddingBottom) || 0;
      composer.style.paddingBottom = `${base + 19}px`;
      element.scrollTo({ top: 0, behavior: 'instant' });
      await frames();
      const before = element.clientHeight;
      try {
        requestAnimationFrame(() => { composer.style.paddingBottom = `${base}px`; });
        // Its follow-up frame pins the end the larger viewport moved.
        target.list().scrollToEnd({ reveal: true });
        requestAnimationFrame(() => { composer.style.paddingBottom = `${base + 8}px`; });
        const state = await settle(view);
        return { ...state, net: element.clientHeight - before };
      } finally {
        composer.style.paddingBottom = '';
        await settle(view);
      }
    },
    // The conversation opens, and the reveal comes to rest on the newest message before
    // the composer is done settling: where scrolling is instant (smooth scrolling turned
    // off in Windows), the view gets there a frame before the composer grows (#490).
    // Here the composer grows a frame after the view came to rest at the end, and grows
    // again a frame after the feed brought it back there, all within the moment of the
    // reveal: the newest message stays in view. The order is fixed, whatever the
    // machine: each growth waits for the view to come to rest.
    growAfterReveal: async (view) => {
      const target = views[view];
      const element = target.feed();
      const composer = element.parentElement.querySelector(':scope > .chat-input-container');
      const base = parseFloat(getComputedStyle(composer).paddingBottom) || 0;
      element.scrollTo({ top: 0, behavior: 'instant' });
      await frames();
      // Whether the view comes to rest at the very end within `ms`.
      const restsAtEnd = (ms) => new Promise(resolve => {
        const done = (value) => { clearTimeout(timer); element.removeEventListener('scrollend', ended); resolve(value); };
        const ended = () => { if (element.scrollHeight - element.clientHeight - element.scrollTop <= 1) done(true); };
        const timer = setTimeout(() => done(false), ms);
        element.addEventListener('scrollend', ended);
      });
      const grown = [];
      try {
        let rested = restsAtEnd(3000);
        target.list().scrollToEnd({ reveal: true });
        // The moment of the reveal, by the clock: the feed may end it before, not the runner.
        const moment = target.list().revealingUntil;
        for (const grow of [8, 16]) {
          if (!(await rested)) return { grown, ...(await settle(view)) };
          await new Promise(requestAnimationFrame);
          if (performance.now() >= moment) {
            throw new Error(`${view}: the moment of the reveal was over before the composer grew: the runner was too slow to build this case`);
          }
          rested = restsAtEnd(1500);
          composer.style.paddingBottom = `${base + grow}px`;
          grown.push(grow);
        }
        await rested;
        return { grown, ...(await settle(view)) };
      } finally {
        composer.style.paddingBottom = '';
        await settle(view);
      }
    },
    // Writes and sends a direct message from wherever the reader is in the conversation.
    sendDm: async () => {
      const composer = document.querySelector('[data-dm-feed]').closest('.dm-conversation') ?? document;
      const input = composer.querySelector('#chat-message-input');
      input.focus();
      input.value = tall(`Mine ${arrivals++}`);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      composer.querySelector('#btn-send-message').click();
      const state = await settle('dm');
      return { ...state, sent: input.value === '' };
    },
    // Back at the newest message, following it, with nothing selected.
    rest: async (view) => {
      getSelection().removeAllRanges();
      views[view].list().scrollToEnd();
      return settle(view);
    },
    // A spot of the feed that takes no focus: its padding beside the messages.
    // After a click there the focus is on the body, and keys scroll this feed.
    quietPoint: (view) => {
      const element = views[view].feed();
      const box = element.getBoundingClientRect();
      const x = Math.round(box.left + 6);
      for (let y = Math.round(box.top + box.height / 2); y < box.bottom - 4; y += 4) {
        if (document.elementFromPoint(x, y) === element) return { x, y };
      }
      return null;
    },
    focusOnBody: () => document.activeElement === document.body,
    // A message arrives at the end, and the scroll to it is held halfway there, for
    // the reader's input to come while it is on its way. Without motion it is instant.
    arriveAndWatch: async (view, type) => {
      watchInput(view, type);
      if (reducedMotion()) {
        views[view].deliver(tall(`F${arrivals}`));
        // A direct conversation draws it in the next frame.
        await new Promise(requestAnimationFrame);
        return;
      }
      await holdHalfway(view, () => views[view].deliver(tall(`F${arrivals}`)));
      onItsWay(view, 'the reader acted');
    },
    // Where to press to start a selection: the text of a message in view.
    textPoint: (view) => {
      const element = views[view].feed();
      const box = element.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      for (let y = Math.round(box.top + 10); y < box.bottom - 10; y += 4) {
        const hit = document.elementFromPoint(x, y);
        if (hit && element.contains(hit) && hit.closest('.chat-message-text')) return { x, y };
      }
      return null;
    },
    // Chromium autoscrolls a selection dragged past the top without any input
    // reaching the feed, frame after frame. It does not in the offscreen window
    // of this test, so the view goes up the way that autoscroll moves it.
    autoscrollUp: async (view) => {
      const element = views[view].feed();
      for (let frame = 0; frame < 8; frame++) {
        await new Promise(requestAnimationFrame);
        element.scrollTop -= 30;
      }
    },
    // The reader took over: a scroll still held stops where it is, as Chromium stops it.
    // `rose` says how far the reader's input took the view up.
    landed: async (view) => {
      holding?.drop();
      const state = await settle(view);
      return { ...state, during: flight.during, rose: flight.top === null ? null : Math.round(flight.top - state.scrollTop) };
    },
    // Images of the newest message still loading, as the views wire them: each one
    // pins the end again when it loads, while the reader follows it.
    pendImages: (view, count) => {
      const last = [...views[view].feed().querySelectorAll('.chat-message-row')].at(-1);
      const body = last.querySelector('.chat-message-body');
      for (let index = 0; index < count; index++) {
        const image = document.createElement('img');
        image.className = 'chat-feed-test-image';
        image.style.cssText = 'display:block;width:40px';
        body.append(image);
      }
      views[view].list().repinWhileMediaLoads(last);
    },
    // The next image finishes loading, which moves the end below it. With `type`,
    // the scroll it brings is held halfway for the reader's input to come during it.
    loadImage: async (view, type) => {
      const image = [...testImages(view)].find(entry => !entry.hasAttribute('src'));
      const load = async () => {
        const loaded = new Promise(resolve => image.addEventListener('load', resolve, { once: true }));
        image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="200"/>')}`;
        await loaded;
      };
      if (!type) return load();
      watchInput(view, type);
      if (reducedMotion()) return load();
      await holdHalfway(view, load);
      onItsWay(view, 'the reader acted');
    },
    loadImageAndSettle: async (view) => {
      const before = place(view);
      await window.fixture.loadImage(view);
      const state = await settle(view);
      const row = views[view].feed().querySelector(`.chat-message-row[data-message-id="${CSS.escape(before.id)}"]`);
      return { ...state, shift: row ? row.getBoundingClientRect().top - before.top : null };
    },
    // The next image finishes loading and the view moves up 188 px in that same task,
    // ahead of any scroll event: a Page Up where scrolling is instant (smooth scrolling
    // turned off in Windows). With `after`, the move comes once the feed pinned the end
    // to the loaded image, instantly without motion; with `before`, before the feed
    // handles the load: listeners capturing at the image run ahead of the feed's own.
    loadImageAndClimb: async (view, when) => {
      const element = views[view].feed();
      const image = [...testImages(view)].find(entry => !entry.hasAttribute('src'));
      let before = null;
      image.addEventListener('load', () => {
        element.scrollTop -= 188;
        before = place(view);
      }, { once: true, capture: when === 'before' });
      const loaded = new Promise(resolve => image.addEventListener('load', resolve, { once: true }));
      image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="200"/>')}`;
      await loaded;
      const state = await settle(view);
      const row = element.querySelector(`.chat-message-row[data-message-id="${CSS.escape(before.id)}"]`);
      return { ...state, shift: row ? row.getBoundingClientRect().top - before.top : null };
    },
    // Someone shortens a message far above the view while the reader follows the end,
    // and an image of the newest message loads in that same task, before the feed handles
    // the load (#490). The view never moved over the content: the reader still follows,
    // and the feed brings the image into view. The row comes back afterwards.
    shrinkAboveAndLoad: async (view) => {
      const list = views[view].list();
      const element = views[view].feed();
      const image = [...testImages(view)].find(entry => !entry.hasAttribute('src'));
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll('.chat-message-row')]
        .find(entry => entry.getBoundingClientRect().bottom < top - 200 && entry.offsetHeight > 20);
      const key = list.keyOf(row);
      const markup = list.built.get(row).html;
      const height = row.offsetHeight;
      image.addEventListener('load', () => { list.replace(key, '<div class="chat-feed-test-shrunk"></div>'); },
        { once: true, capture: true });
      const loaded = new Promise(resolve => image.addEventListener('load', resolve, { once: true }));
      image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="200"/>')}`;
      await loaded;
      try {
        return { shrunk: height, ...(await settle(view)) };
      } finally {
        list.replace(key, markup);
        await settle(view);
      }
    },
    dropImages: (view) => views[view].feed().querySelectorAll('img.chat-feed-test-image, .chat-feed-test-spacer')
      .forEach(part => part.remove()),
    // The newest message grows under the view while the scroll to it is on its
    // way, as an image does once the size in its header arrives, long before it
    // loads: the scroll ends short of the end. `phase` says when: midway, or in
    // the last stretch of the scroll. The image loads later, on request. The
    // scroll is held, so the growth comes at that point whatever the machine.
    growShort: async (view, phase) => {
      const target = views[view];
      const element = target.feed();
      const hold = holdScroll(view, 'the feed did not scroll to the new message');
      let grownAt = null;
      try {
        target.deliver(tall(`G${arrivals}`));
        await hold.requested();
        const row = [...element.querySelectorAll('.chat-message-row')].at(-1);
        const spacer = document.createElement('div');
        spacer.className = 'chat-feed-test-spacer';
        const image = document.createElement('img');
        image.className = 'chat-feed-test-image';
        image.style.cssText = 'display:block;width:40px';
        row.querySelector('.chat-message-body').append(spacer, image);
        target.list().repinWhileMediaLoads(row);
        // The feed's own follow-up frame goes first: it pins again an end that moved.
        await frames();
        // Midway: halfway there, more than 60 px to go. Tail: inside the last 48 px.
        const at = phase === 'midway' ? Math.max(61, Math.round(hold.left() / 2)) : 30;
        if (hold.left() <= at) throw new Error(`${view}: the scroll to the new message is too short for the ${phase} case (${hold.left()} px)`);
        await hold.frameAt(at);
        onItsWay(view, 'the message grew');
        spacer.style.height = '150px';
        grownAt = at;
        // The scroll goes on to where it was going, now short of the end.
        await hold.frameAt(0);
      } finally {
        hold.drop();
      }
      return { grownAt, ...measure(view) };
    },
    // Waits until the time of that scroll is over, then says where the view rests.
    outlast: async (view) => {
      await new Promise(resolve => setTimeout(resolve, 2200));
      return settle(view);
    },
    // As the time of a scroll cut short runs out, the view jumps up in that same
    // task, before the jump's scroll event, and a message arrives: the landing
    // sees the jump, and the message leaves the view where it went.
    climbAtLanding: async (view) => {
      const target = views[view];
      const element = target.feed();
      const timers = window.setTimeout;
      const seen = {};
      // The feed's landing timer: the one set for the time of its scroll to the end.
      window.setTimeout = function (callback, delay, ...rest) {
        if (delay === 2000 && typeof callback === 'function' && new Error().stack.includes('pinToEnd')) {
          const landing = callback;
          callback = (...args) => {
            element.scrollTop -= 200;
            seen.before = place(view);
            landing(...args);
            seen.followingAtLanding = target.list().following;
            target.deliver(tall(`L${arrivals}`));
          };
        }
        return timers.call(this, callback, delay, ...rest);
      };
      let cut;
      try {
        cut = await window.fixture.growShort(view, 'midway');
      } finally {
        window.setTimeout = timers;
      }
      await new Promise(resolve => setTimeout(resolve, 2200));
      const state = await settle(view);
      const row = seen.before && element.querySelector(`.chat-message-row[data-message-id="${CSS.escape(seen.before.id)}"]`);
      return { cut, followingAtLanding: seen.followingAtLanding ?? null, ...state,
        shift: row ? row.getBoundingClientRect().top - seen.before.top : null };
    },
    // The view moves down a little, still short of the end.
    nudgeDown: async (view) => {
      views[view].feed().scrollTop += 40;
      return settle(view);
    },
    // The view jumps up in a single scroll (a wheel notch without smooth
    // scrolling, the Home key), and optionally a message arrives in that same
    // task, before the jump's scroll event: it must not undo the jump.
    jumpUp: async (view, withMessage) => {
      onItsWay(view, 'the jump');
      const element = views[view].feed();
      element.scrollTop -= 200;
      const before = place(view);
      if (withMessage) views[view].deliver(tall(`J${arrivals}`));
      const state = await settle(view);
      const row = element.querySelector(`.chat-message-row[data-message-id="${CSS.escape(before.id)}"]`);
      return { ...state, shift: row ? row.getBoundingClientRect().top - before.top : null };
    },
  };
}
