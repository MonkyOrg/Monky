const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `footer-controls-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_FOOTER_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_FOOTER_TEST_PROFILE);
  let vite, window, timeout;
  let phase = 'startup';
  const finish = async (code) => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    await vite?.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error(`Footer controls smoke timed out: ${phase}`); void finish(1); }, 60_000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{ name: 'footer-controls-fixture', configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__footer_controls__') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head>
            <link rel="stylesheet" href="/styles/fonts.css">
            <link rel="stylesheet" href="/styles/theme.css">
            <link rel="stylesheet" href="/styles/footerControls.css">
            </head><body><div id="app"></div></body></html>`);
        });
      } }],
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
      show: false, width: 1100, height: 760, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) console.error(`[renderer:${phase}] ${message}`);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.debugger.attach('1.3');
    const motion = (value) => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }],
    });
    phase = 'loading fixture';
    await window.loadURL(`http://127.0.0.1:${address.port}/__footer_controls__`);
    await motion('no-preference');
    phase = 'setup';
    await window.webContents.executeJavaScript(`(${setupFooterSmoke.toString()})()`, true);
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 1050, y: 400 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hoverSamples = [];
    phase = 'distinct trusted hover';
    const sampleHovers = async (selectors) => {
      for (const selector of selectors) {
        window.focus();
        window.webContents.focus();
        const cardPoint = await window.webContents.executeJavaScript(`window.footerSmoke.cardHoverTarget(${JSON.stringify(selector)})`);
        if (cardPoint) {
          window.webContents.sendInputEvent({ type: 'mouseMove', ...cardPoint });
          await window.webContents.executeJavaScript(`window.footerSmoke.waitForCard(${JSON.stringify(selector)})`, true);
        }
        const point = await window.webContents.executeJavaScript(`window.footerSmoke.hoverTarget(${JSON.stringify(selector)})`);
        window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        await window.webContents.executeJavaScript('window.footerSmoke.waitForHover()', true);
        const images = [];
        for (const time of [200, 460]) {
          const crop = await window.webContents.executeJavaScript(`window.footerSmoke.sampleHover(${time})`, true);
          images.push((await window.webContents.capturePage(crop)).toDataURL());
        }
        hoverSamples.push({ id: selector, images });
        await window.webContents.executeJavaScript('window.footerSmoke.smoothHoverReturn()', true);
        window.webContents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 });
        await window.webContents.executeJavaScript('window.footerSmoke.hoverLeft()');
      }
    };
    await sampleHovers(['#bar-btn-mic', '#bar-btn-deafen', '#bar-btn-settings', '#media-btn-camera',
      '#media-btn-screen', '#media-btn-soundboard', '#btn-attach', '#btn-emoji', '#btn-code']);
    phase = 'native pointer';
    const point = await window.webContents.executeJavaScript('window.footerSmoke.pointerTarget()');
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await window.webContents.executeJavaScript('window.footerSmoke.waitForHover()', true);
    await window.webContents.executeJavaScript('window.footerSmoke.pointerHover()');
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await window.webContents.executeJavaScript('window.footerSmoke.pointerDown()');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 1050, y: 50 });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 1050, y: 50 });
    phase = 'normal motion';
    await window.webContents.executeJavaScript('window.footerSmoke.normal()', true);
    phase = 'reduced motion';
    await motion('reduce');
    await window.webContents.executeJavaScript('window.footerSmoke.reduced()', true);
    for (const id of ['media-btn-camera', 'btn-emoji']) {
      const point = await window.webContents.executeJavaScript(`window.footerSmoke.hoverTarget(${JSON.stringify(`#${id}`)})`);
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      await window.webContents.executeJavaScript('window.footerSmoke.waitForHover()', true);
      await window.webContents.executeJavaScript('window.footerSmoke.reducedHovered()');
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 1050, y: 400 });
      await window.webContents.executeJavaScript('window.footerSmoke.hoverLeft()');
    }
    await motion('no-preference');
    phase = 'cleanup';
    await window.webContents.executeJavaScript('window.footerSmoke.cleanup()', true);
    phase = 'stage setup';
    await window.webContents.executeJavaScript(`(${setupStageSmoke.toString()})()`, true);
    phase = 'stage trusted hover';
    await sampleHovers(['#stage-btn-mic', '#stage-btn-deafen', '#stage-btn-camera', '#stage-btn-screen',
      '#stage-btn-overlay', '#stage-btn-soundboard', '#stage-btn-leave', '.stage-watch-btn']);
    phase = 'stage keyboard';
    await window.webContents.executeJavaScript('window.stageSmoke.keyboardTarget()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await window.webContents.executeJavaScript('window.stageSmoke.keyboardFocused()', true);
    phase = 'stage broadcasting';
    window.webContents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 });
    await window.webContents.executeJavaScript('window.stageSmoke.shareAndWatch()', true);
    await sampleHovers(['#stage-btn-screen', '#stage-btn-overlay', '#stage-btn-stop-share', '#btn-stage-quick-stop',
      '.stage-volume-btn', '.stage-stopwatch-btn', '.stage-fullscreen-btn']);
    phase = 'stage normal motion';
    await window.webContents.executeJavaScript('window.stageSmoke.normal()', true);
    phase = 'stage reduced motion';
    await motion('reduce');
    await window.webContents.executeJavaScript('window.stageSmoke.reduced()', true);
    await motion('no-preference');
    phase = 'stage cleanup';
    const stageChecks = await window.webContents.executeJavaScript('window.stageSmoke.cleanup()', true);
    const checks = await window.webContents.executeJavaScript('window.footerSmoke.checkCount()');
    console.log(`Footer/composer/stage controls smoke: ${checks + stageChecks} checks passed (motion, layout, PTT, reduced motion, lifecycle)`);
    window.setContentSize(1100, Math.ceil(hoverSamples.length / 3) * 170 + 40);
    await window.webContents.executeJavaScript(`document.body.innerHTML = '<main id="motion-samples"></main>';
      document.body.style.cssText = 'margin:0;padding:20px;background:#18191d;color:white;overflow:auto';
      document.querySelector('#motion-samples').style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:18px';
      for (const row of ${JSON.stringify(hoverSamples)}) {
        const tile = document.createElement('section');
        tile.innerHTML = '<h3 style="font-size:14px;margin:0 0 8px">' + row.id + '</h3>'
          + row.images.map((image, index) => '<div style="display:inline-block;margin-right:8px"><div style="font-size:11px">'
            + [200,460][index] + 'ms</div><img style="max-width:145px;height:105px;object-fit:contain" src="' + image + '"></div>').join('');
        document.querySelector('#motion-samples').append(tile);
      }
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(clientRoot, 'dist-test', 'control-motion-samples.png'), (await window.webContents.capturePage()).toPNG());
    await finish(0);
  }).catch(async (error) => { console.error(`Footer/composer smoke failed during ${phase}`, error); await finish(1); });
}

async function setupFooterSmoke() {
  const [{ MainView }, { voiceStore: voice }, { settingsStore: settings }, { serverStore: server },
    { appEvents }, { networkClient }, { soundEffects }, { bindChatComposerMotion }] = await Promise.all([
    import('/views/MainView.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/stores/serverStore.ts'), import('/core/EventBus.ts'),
    import('/core/NetworkClient.ts'), import('/core/SoundEffects.ts'), import('/views/FooterControlsMotion.ts'),
  ]);
  networkClient.send = () => {};
  soundEffects.play = () => {};
  navigator.mediaDevices.enumerateDevices = async () => [
    { deviceId: 'default', kind: 'audiooutput', label: 'System output', groupId: 'audio' },
  ];
  const user = { id: 'footer-user', sessionId: 'footer-session', clientId: 'footer-client',
    nickname: 'Footer', status: 'ONLINE', joinedAt: 1 };
  server.setServerDetails({
    id: 'footer-server', name: 'Footer fixture', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: [], members: [user], knownMembers: [user], roles: [], userRoles: [],
    myPermissions: 2147483647, ownerId: user.id,
  }, user);
  settings.inputMode = 'push_to_talk';
  voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
  voice.currentVoiceChannelId = 'footer-voice';
  voice.setMicrophoneState(false, false);
  const root = document.getElementById('app');
  const view = new MainView(root);
  view.render();
  // The composer binder is wired separately by ChatView; keep this fixture independent
  // of message-toolbar behavior and native file dialogs.
  const composer = document.createElement('section');
  composer.style.cssText = 'position:fixed;right:10px;top:10px;width:500px';
  composer.innerHTML = `<div class="chat-input-container"><div class="chat-input-wrapper">
    <button id="btn-attach" class="chat-attach-btn"><span class="material-symbols-outlined">add_circle</span></button>
    <button id="btn-emoji" class="chat-attach-btn"><span class="material-symbols-outlined">mood</span></button>
    <button id="btn-code" class="chat-attach-btn"><span class="material-symbols-outlined">code</span></button>
    <textarea class="chat-input-field"></textarea>
    <button id="btn-send-message" class="btn"><span class="material-symbols-outlined">send</span></button>
    </div></div>
    <div class="chat-message-actions">
      <button class="chat-attach-btn" data-message-action="emoji"><span class="material-symbols-outlined">add_reaction</span></button>
      <button data-message-action="reply"><span class="material-symbols-outlined">reply</span></button>
    </div>`;
  document.body.append(composer);
  let offComposer = bindChatComposerMotion(composer);
  await document.fonts.ready;
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const mic = () => root.querySelector('#bar-btn-mic');
  const glyph = (button) => button.querySelector(':scope > .audio-state-icon, :scope > .material-symbols-outlined');
  const animations = (button) => glyph(button).getAnimations();
  const enter = (button) => button.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
  const rect = (element) => JSON.stringify(element.getBoundingClientRect().toJSON());
  const motionCount = () => [...root.querySelectorAll('.user-quick-actions button, .user-media-bar button')]
    .reduce((count, button) => count + animations(button).length, 0);
  const composerButtons = () => [...composer.querySelectorAll('#btn-attach, #btn-emoji, #btn-code')];
  const composerMotionCount = () => composerButtons().reduce((count, button) => count + animations(button).length, 0);
  let pointerBounds;
  let selectedHover;
  let trustedHover = false;
  let hoverBounds;
  let hoverText;
  let previousSample;
  let cardPointerTarget;

  window.footerSmoke = {
    checkCount: () => checks,
    async cardHoverTarget(selector) {
      const control = document.querySelector(selector);
      const card = control?.closest('.stage-card, .stage-mini-card, .stage-focused-main');
      if (!card) return null;
      control.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await frame();
      const bounds = card.getBoundingClientRect();
      const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
      const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      for (const xFraction of [0.1, 0.9, 0.5]) {
        for (const yFraction of [0.1, 0.9, 0.5]) {
          const x = Math.round(left + (right - left) * xFraction);
          const y = Math.round(top + (bottom - top) * yFraction);
          const hit = document.elementFromPoint(x, y);
          if (hit && card.contains(hit) && !hit.closest('button')) {
            cardPointerTarget = { x, y };
            return cardPointerTarget;
          }
        }
      }
      throw new Error(`${selector}: no visible card surface for native hover: ${JSON.stringify({
        bounds: bounds.toJSON(), viewport: { width: innerWidth, height: innerHeight },
      })}`);
    },
    async waitForCard(selector) {
      const card = document.querySelector(selector).closest('.stage-card, .stage-mini-card, .stage-focused-main');
      for (let attempt = 0; attempt < 100 && !card.matches(':hover'); attempt++) await delay(20);
      check(card.matches(':hover'), `${selector}: native pointer reached its card: ${JSON.stringify({
        point: cardPointerTarget, bounds: card.getBoundingClientRect().toJSON(),
        hit: document.elementFromPoint(cardPointerTarget.x, cardPointerTarget.y)?.outerHTML.slice(0, 250),
        viewport: { width: innerWidth, height: innerHeight },
      })}`);
      // Preserve existing card lift/scale; measure the button only once its parent settles.
      await Promise.all(card.getAnimations().map((animation) => animation.finished));
      await frame();
    },
    hoverTarget(selector) {
      selectedHover = document.querySelector(selector);
      check(!!selectedHover, `${selector}: control exists`);
      trustedHover = false;
      selectedHover.addEventListener('pointerenter', (event) => { trustedHover = event.isTrusted; }, { once: true });
      hoverBounds = rect(selectedHover);
      hoverText = glyph(selectedHover).textContent;
      previousSample = null;
      const bounds = selectedHover.getBoundingClientRect();
      return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
    },
    async waitForHover() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (trustedHover && selectedHover.matches(':hover')) return;
        await delay(20);
      }
      throw new Error(`${selectedHover.id}: missing trusted hover (trusted=${trustedHover}, hovered=${selectedHover.matches(':hover')})`);
    },
    async sampleHover(time) {
      const button = selectedHover;
      check(trustedHover && button.matches(':hover'), `${button.id}: trusted Electron hover reached the button`);
      const effects = button.getAnimations({ subtree: true });
      check(effects.length > 0, `${button.id}: hover starts a visible effect`);
      for (const effect of effects) {
        effect.pause();
        effect.currentTime = time;
      }
      await frame();
      check(rect(button) === hoverBounds, `${button.id || button.className}: trusted hover keeps the target stationary`);
      check(glyph(button).textContent === hoverText, `${button.id}: hover does not change real state glyph`);
      const layer = button.querySelector('.control-motion-decoration');
      if (layer) {
        check(layer.getAttribute('aria-hidden') === 'true' && getComputedStyle(layer).pointerEvents === 'none',
          `${button.id}: decoration is inaccessible and cannot intercept pointer events`);
        const artwork = layer.getBoundingClientRect();
        const icon = glyph(button).getBoundingClientRect();
        check(Math.abs(artwork.x + artwork.width / 2 - icon.x - icon.width / 2) < 1.25
          && Math.abs(artwork.y + artwork.height / 2 - icon.y - icon.height / 2) < 1.25,
        `${button.id || button.className}: artwork stays centered on the glyph, including text buttons`);
      }
      const expected = {
        'media-btn-camera': 'camera', 'media-btn-screen': 'screen', 'media-btn-soundboard': 'music',
        'btn-attach': 'attachment', 'btn-emoji': 'laugh', 'btn-code': 'code',
        'stage-btn-camera': 'camera', 'stage-btn-screen': 'screen', 'stage-btn-soundboard': 'music',
        'stage-btn-overlay': 'overlay', 'stage-btn-stop-share': 'screen', 'btn-stage-quick-stop': 'stop',
        'stage-watch-btn': 'watch', 'stage-volume-btn': 'volume', 'stage-fullscreen-btn': 'fullscreen',
      }[button.id || button.classList[0]];
      if (expected) check(layer?.dataset.motion === expected, `${button.id}: its own function-specific artwork is present`);
      const sample = JSON.stringify([glyph(button), ...button.querySelectorAll('.control-motion-decoration svg *')]
        .map((element) => [getComputedStyle(element).transform, getComputedStyle(element).opacity]));
      if (previousSample) check(sample !== previousSample, `${button.id}: sampled frames show meaningful progression`);
      previousSample = sample;
      const bounds = button.getBoundingClientRect();
      return { x: Math.floor(bounds.x) - 4, y: Math.floor(bounds.y) - 4,
        width: Math.ceil(bounds.width) + 8, height: Math.ceil(bounds.height) + 8 };
    },
    async hoverLeft() {
      for (let attempt = 0; attempt < 100 && selectedHover.matches(':hover'); attempt++) await delay(20);
      check(!selectedHover.matches(':hover'), 'Native pointer leave reached the renderer');
      check(animations(selectedHover).length === 0, 'Trusted pointer leave cancels glyph motion');
      check(!selectedHover.querySelector('.control-motion-decoration'), 'Trusted pointer leave removes decoration');
      check(getComputedStyle(glyph(selectedHover)).opacity === '1', 'Trusted pointer leave restores base glyph');
    },
    async smoothHoverReturn(button = selectedHover) {
      const layer = button.querySelector('.control-motion-decoration');
      if (!layer || !['screen', 'overlay'].includes(layer.dataset.motion)) return;
      const effects = button.getAnimations({ subtree: true });
      const sample = async (time) => {
        for (const effect of effects) {
          effect.pause();
          effect.currentTime = time;
        }
        await frame();
        return [Number(getComputedStyle(glyph(button)).opacity), Number(getComputedStyle(layer).opacity)];
      };
      const start = await sample(0);
      check(start[0] === 1 && start[1] === 0, `${button.id}: animation starts on the exact original icon`);
      const middle = await sample(380);
      check(middle[0] === 0 && middle[1] === 1, `${button.id}: function-specific artwork remains clear mid-animation`);
      const returning = await sample(620);
      check(returning.every((opacity) => opacity > 0 && opacity < 1)
        && Math.abs(returning[0] + returning[1] - 1) < 0.001, `${button.id}: artwork blends back instead of cutting`);
      const end = await sample(759);
      check(end[0] > 0.999 && end[1] < 0.001, `${button.id}: original icon is restored before animation cleanup`);
      for (const part of layer.querySelectorAll('[data-arrow], [data-window], [data-stop]')) {
        const frames = part.getAnimations()[0].effect.getKeyframes();
        check(frames[0].transform === frames.at(-1).transform && frames[0].opacity === frames.at(-1).opacity,
          `${button.id}: animated parts return to their starting pose`);
      }
      const finished = new Promise((resolve) => animations(button)[0].addEventListener('finish', resolve, { once: true }));
      for (const effect of effects) effect.finish();
      await finished;
      check(!button.querySelector('.control-motion-decoration') && animations(button).length === 0
        && getComputedStyle(glyph(button)).opacity === '1', `${button.id}: completion leaves only the unchanged real icon`);
    },
    reducedHovered() {
      check(trustedHover && selectedHover.matches(':hover'), 'Reduced-motion test uses trusted pointer entry');
      check(animations(selectedHover).length === 0 && !selectedHover.querySelector('.control-motion-decoration'),
        'Trusted hover respects reduced motion, including decorative parts');
    },
    pointerTarget() {
      const button = root.querySelector('#bar-btn-settings');
      pointerBounds = rect(button);
      return window.footerSmoke.hoverTarget('#bar-btn-settings');
    },
    pointerHover() {
      const button = root.querySelector('#bar-btn-settings');
      check(button.matches(':hover') && animations(button).length === 1, 'Native pointer entry triggers actual hover motion');
    },
    async pointerDown() {
      const button = root.querySelector('#bar-btn-settings');
      for (let attempt = 0; attempt < 100 && !button.matches(':active'); attempt++) await delay(20);
      check(button.matches(':active'), 'Native mouse down exercises pressed CSS');
      check(rect(button) === pointerBounds && getComputedStyle(button).transform === 'none',
        'Native press does not shrink or move the hit box');
    },
    async normal() {
      await delay(350);
      check(motionCount() === 0, 'No autoplay motion on initial render');
      check(composerMotionCount() === 0, 'Composer buttons do not animate at rest');
      const camera = root.querySelector('#media-btn-camera');
      const screen = root.querySelector('#media-btn-screen');
      const cameraGlyph = glyph(camera);
      enter(camera);
      const cameraHover = animations(camera)[0];
      const viewfinder = camera.querySelector('.control-motion-decoration');
      appEvents.emit('voice.state_updated');
      await delay();
      check(glyph(camera) === cameraGlyph && animations(camera)[0] === cameraHover
        && camera.querySelector('.control-motion-decoration') === viewfinder,
      'Unchanged voice events preserve media glyphs and running hover');
      voice.isCameraOn = voice.isScreenSharing = true;
      appEvents.emit('voice.state_updated');
      await delay();
      check(glyph(camera).textContent === 'videocam_off' && glyph(screen).textContent === 'stop_screen_share',
        'Media state updates preserve stop-camera/stop-share meanings');
      check(!camera.querySelector('.control-motion-decoration') && animations(camera).length === 1,
        'State change replaces camera hover with short feedback');
      await delay(200);
      check(camera.getAnimations().length === 0 && screen.getAnimations().length === 0,
        'Active media retains static status styling without perpetual button pulses');
      enter(camera);
      check(getComputedStyle(glyph(camera)).opacity === '1'
        && glyph(camera).textContent === 'videocam_off', 'Camera hover never hides the stop-camera glyph');
      enter(screen);
      check(!!screen.querySelector('[data-stop]') && !screen.querySelector('[data-arrow]'),
        'Active screen hover keeps a stop symbol, not a misleading share arrow');
      await window.footerSmoke.smoothHoverReturn(screen);
      camera.disabled = true;
      await delay();
      check(animations(camera).length === 0 && !camera.querySelector('.control-motion-decoration'),
        'Disabling a control cancels in-flight artwork');
      camera.disabled = false;
      voice.isCameraOn = voice.isScreenSharing = false;
      appEvents.emit('voice.state_updated');
      await delay(200);
      for (const button of composerButtons()) {
        const bounds = rect(button);
        const inputBounds = rect(composer.querySelector('textarea'));
        enter(button);
        const hover = animations(button)[0];
        check(hover?.effect.getTiming().duration === 760, `${button.id} has an expressive, finite hover`);
        hover.pause();
        hover.currentTime = 80;
        check(getComputedStyle(glyph(button)).opacity === '0' && !!button.querySelector('.control-motion-decoration'),
          `${button.id} shows its animated icon parts`);
        check(rect(button) === bounds && rect(composer.querySelector('textarea')) === inputBounds,
          `${button.id} hover preserves hit box and composer layout`);
        let clicks = 0;
        button.addEventListener('click', () => { clicks++; }, { once: true });
        button.click();
        check(clicks === 1 && animations(button).length === 1 && hover.playState === 'idle',
          `${button.id} click preserves action and replaces hover`);
        check(animations(button)[0].effect.getTiming().duration === 140, `${button.id} click feedback is short`);
        button.setAttribute('aria-expanded', 'true');
        await delay();
        check(animations(button).length === 1, `${button.id} state transitions do not queue`);
      }
      for (const button of composer.querySelectorAll('#btn-send-message, [data-message-action]')) {
        enter(button);
        button.click();
        button.classList.add('active');
        await delay();
        check(animations(button).length === 0, 'Send and floating message actions are outside composer motion scope');
      }
      await delay(350);
      const disabled = composer.querySelector('#btn-code');
      disabled.disabled = true;
      enter(disabled);
      disabled.click();
      check(animations(disabled).length === 0, 'Disabled composer controls stay motionless');
      disabled.disabled = false;
      check(root.querySelectorAll('.user-quick-actions button').length === 6, 'Actual six footer controls rendered');
      const button = mic();
      const bounds = rect(button);
      const footerBounds = rect(root.querySelector('.user-control-bar'));
      const labelBounds = rect(button.querySelector('[data-ptt-mode]'));
      const offset = getComputedStyle(button.querySelector('[data-audio-icon]')).transform;
      enter(button);
      let animation = animations(button)[0];
      check(!!animation, 'Hover starts a glyph animation');
      animation.pause();
      animation.currentTime = 80;
      check(getComputedStyle(glyph(button)).transform !== 'none', 'Actual hover transform is applied');
      check(rect(button) === bounds && rect(root.querySelector('.user-control-bar')) === footerBounds,
        'Hover does not move button hit box or footer layout');
      check(rect(button.querySelector('[data-ptt-mode]')) === labelBounds, 'PTT label does not sway');
      check(getComputedStyle(button.querySelector('[data-audio-icon]')).transform === offset,
        'PTT icon vertical offset is preserved');
      check(animation.effect.getTiming().iterations === 1, 'Hover is one-shot');

      voice.setMicrophoneState(true, true);
      await delay();
      const changed = animations(button)[0];
      check(changed && changed !== animation && animation.playState === 'idle', 'PTT transition replaces hover instead of queuing');
      check(changed.effect.getTiming().duration === 140, 'PTT state feedback is short');
      changed.pause();
      changed.currentTime = 30;
      check(getComputedStyle(glyph(button)).transform !== 'none', 'State transition has a real visual transform');
      check(rect(button) === bounds, 'State transition keeps the target stationary');
      check(button.dataset.state === 'open' && button.querySelector('[data-audio-icon]').textContent === 'mic',
        'PTT open state stays correct');
      for (let i = 0; i < 12; i++) {
        voice.setMicrophoneState(i % 2 === 0, i % 2 === 0);
        await delay();
        check(animations(button).length <= 1, 'Rapid PTT never accumulates animations');
      }
      await delay(350);
      check(motionCount() === 0, 'Rapid PTT settles without lingering motion');
      appEvents.emit('voice.state_updated');
      appEvents.emit('voice.microphone_updated');
      await delay();
      check(motionCount() === 0, 'Unchanged voice events do not retrigger animation');

      button.click();
      await delay();
      check(voice.isMuted && button.dataset.ptt === 'false' && button.querySelector('[data-ptt-mode]').hidden,
        'Manual mute still hides PTT text');
      check(animations(button).length === 1, 'Mute click and state update share one animation');
      voice.serverMuted = true;
      appEvents.emit('voice.state_updated');
      await delay();
      const badge = button.querySelector('[data-audio-block]');
      check(!badge.hidden && button.querySelector('[data-audio-icon]').textContent === 'mic',
        'Admin mute keeps the microphone and prohibition badge');
      check(getComputedStyle(badge).backgroundColor === getComputedStyle(root.querySelector('.user-control-bar')).backgroundColor,
        'Prohibition badge keeps contrasting panel background');
      check(getComputedStyle(glyph(button)).opacity === '1', 'State feedback does not fade the prohibition badge');
      voice.serverMuted = false;
      voice.isMuted = false;
      appEvents.emit('voice.state_updated');
      const deafen = root.querySelector('#bar-btn-deafen');
      deafen.click();
      await delay();
      check(voice.isDeafened && animations(deafen).length === 1, 'Deafen click animates and still changes state');
      deafen.click();
      await delay(350);

      const arrow = root.querySelector('[data-audio-device="output"]');
      const arrowBounds = rect(arrow);
      arrow.click();
      await delay();
      check(arrow.getAttribute('aria-expanded') === 'true' && !!document.querySelector('.audio-device-popover'),
        'Animated output arrow still opens device panel');
      check(animations(arrow).length === 1 && rect(arrow) === arrowBounds, 'Arrow click animates glyph without target drift');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay();
      check(arrow.getAttribute('aria-expanded') === 'false', 'Device panel still closes via keyboard');
      check(animations(arrow).length === 1, 'External expanded-state change animates the arrow');
      const unrelated = root.querySelector('#btn-invite-friends');
      enter(unrelated);
      check(glyph(unrelated).getAnimations().length === 0, 'Buttons outside lower-left quick controls do not wiggle');
      const settingsButton = root.querySelector('#bar-btn-settings');
      enter(settingsButton);
      check(animations(settingsButton).length === 1, 'Settings icon also sways');
      enter(root.querySelector('#bar-btn-disconnect'));
      check(animations(root.querySelector('#bar-btn-disconnect')).length === 1, 'Disconnect icon also sways');
      check(getComputedStyle(button).transitionDuration.includes('0.12s'), 'Color state feedback is animated');
      for (const control of [...root.querySelectorAll('.user-quick-actions button, .user-media-bar button'), ...composerButtons()]) {
        enter(control);
      }
      await delay(950);
      check(motionCount() === 0 && composerMotionCount() === 0, 'Every function-specific hover ends without looping');
      check(!document.querySelector('.control-motion-decoration'), 'Completed hover artwork is removed automatically');
      // Keep real active motion alive while the host changes the OS media feature.
      enter(settingsButton);
      animations(settingsButton)[0].pause();
      enter(composer.querySelector('#btn-emoji'));
      animations(composer.querySelector('#btn-emoji'))[0].pause();
      enter(camera);
      animations(camera)[0].pause();
    },
    async reduced() {
      await frame();
      await delay(30);
      check(matchMedia('(prefers-reduced-motion: reduce)').matches, 'Real reduced-motion media feature updated at runtime');
      check(motionCount() === 0, 'Runtime reduced motion cancels in-flight glyph animations');
      check(composerMotionCount() === 0, 'Runtime reduced motion cancels composer animations too');
      check(!document.querySelector('.control-motion-decoration'), 'Runtime reduced motion removes all decorative layers');
      for (const button of composerButtons()) {
        enter(button);
        button.click();
        button.setAttribute('aria-expanded', 'false');
        await delay();
        check(animations(button).length === 0, 'Reduced motion suppresses composer hover, click and state feedback');
        check(getComputedStyle(button).transitionDuration === '0s', 'Reduced motion disables composer CSS transitions');
      }
      enter(mic());
      mic().click();
      voice.setMicrophoneState(true, true);
      await delay();
      check(motionCount() === 0, 'Reduced motion suppresses hover, click and PTT transitions');
      check(getComputedStyle(mic()).transitionDuration === '0s', 'Reduced motion also removes CSS color transitions');
    },
    async cleanup() {
      await frame();
      check(!matchMedia('(prefers-reduced-motion: reduce)').matches, 'Motion preference re-enabled');
      check(motionCount() === 0, 'Re-enabling motion does not autoplay');
      check(composerMotionCount() === 0, 'Re-enabling motion does not autoplay composer animations');
      for (let i = 0; i < 3; i++) {
        const button = composer.querySelector('#btn-code');
        enter(button);
        check(animations(button).length === 1, 'Composer motion resumes after preference change/rebinding');
        offComposer();
        check(animations(button).length === 0, 'Composer cleanup cancels active animation');
        enter(button);
        button.click();
        button.setAttribute('aria-expanded', String(i % 2 === 0));
        await delay();
        check(animations(button).length === 0, 'Composer cleanup removes listeners and observer on connected DOM');
        offComposer = bindChatComposerMotion(composer);
      }
      offComposer();
      composer.remove();
      enter(mic());
      check(animations(mic()).length === 1, 'Hover resumes after preference change');
      for (let i = 0; i < 3; i++) {
        const oldFooter = root.querySelector('.user-control-bar');
        const oldButton = mic();
        view.render();
        check(animations(oldButton).length === 0, 'Re-render cancels previous animations');
        // Keep old nodes connected to detect forgotten listeners/observers, not just isConnected guards.
        document.body.append(oldFooter);
        enter(oldButton);
        oldButton.dataset.state = 'obsolete';
        await delay();
        check(animations(oldButton).length === 0, 'Re-render removes old listeners and observer');
        oldFooter.remove();
        enter(mic());
        check(animations(mic()).length === 1, 'Re-render binds exactly one new animation');
      }
      const button = mic();
      view.destroy();
      check(animations(button).length === 0, 'Destroy cancels running motion');
      enter(button);
      button.click();
      button.dataset.state = 'destroyed';
      await delay();
      check(animations(button).length === 0, 'Destroy removes motion listeners and observer on connected DOM');
      return checks;
    },
  };
}

async function setupStageSmoke() {
  const [{ VoiceStageView }, { voiceStore: voice }, { settingsStore: settings }, { serverStore: server },
    { participantManager: participants }, { appEvents }, { screenAudioService },
    { overlayBridgeService }, { overlayConfigModal }, { soundboardModal }] = await Promise.all([
    import('/views/VoiceStageView.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/stores/serverStore.ts'), import('/core/ParticipantManager.ts'), import('/core/EventBus.ts'),
    import('/core/ScreenAudioService.ts'), import('/core/OverlayBridgeService.ts'),
    import('/views/OverlayConfigModal.ts'), import('/views/SoundboardModal.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = document.getElementById('app');
  const local = { id: 'stage-local', sessionId: 'stage-local-session', clientId: 'stage-local-client',
    nickname: 'Local', status: 'ONLINE', joinedAt: 1 };
  const remote = { ...local, id: 'stage-remote', sessionId: 'stage-remote-session', nickname: 'Remote' };
  const channel = { id: 'stage-channel', name: 'Stage motion', type: 'VOICE', position: 0, botCommandsEnabled: true };
  server.setServerDetails({
    id: 'stage-server', name: 'Stage fixture', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: [channel], members: [local, remote], knownMembers: [local, remote], roles: [], userRoles: [],
    myPermissions: 2147483647, ownerId: local.id,
  }, local);
  settings.screenShareTelemetryEnabled = false;
  voice.currentVoiceChannelId = channel.id;
  voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
  voice.isCameraOn = false;
  voice.setScreenSharing(false);
  participants.setUsers([local, remote]);
  for (const user of [local, remote]) {
    participants.updateVoiceState({
      userId: user.id, sessionId: user.sessionId, channelId: channel.id, isSpeaking: false,
      isMuted: false, isDeafened: false, isCameraOn: user === remote, isScreenSharing: user === remote,
      screenShareIds: user === remote ? ['remote-share', 'remote-share-two'] : [],
    });
  }
  let capturing = false;
  let overlayActive = false;
  const originalCapturing = screenAudioService.getIsCapturing;
  const originalOverlayActive = overlayBridgeService.isActive;
  const originalOverlayOpen = overlayConfigModal.open;
  const originalSoundboardOpen = soundboardModal.open;
  const actions = { camera: 0, picker: 0, overlay: 0, soundboard: 0, stop: 0, leave: 0, fullscreen: 0 };
  screenAudioService.getIsCapturing = () => capturing;
  overlayBridgeService.isActive = () => overlayActive;
  overlayConfigModal.open = () => { actions.overlay++; };
  soundboardModal.open = () => { actions.soundboard++; };
  const offPicker = appEvents.on('modal.open_screenshare_picker', () => {
    actions.picker++;
    appEvents.emit('modal.screenshare_picker_opened');
  });
  const stage = new VoiceStageView(root);
  const codecStats = new Map([
    ['first-capability', { type: 'codec', mimeType: 'video/AV1' }],
    ['actual-video', { type: 'codec', mimeType: 'video/H264' }],
    ['audio', { type: 'codec', mimeType: 'audio/opus' }],
    ['repair', { type: 'codec', mimeType: 'video/rtx' }],
    ['invalid', { type: 'codec', mimeType: 42 }],
  ]);
  check(stage.getCodecName(codecStats) === null, 'Absent RTP codecId must not turn the first capability into a reported codec');
  check(stage.getCodecName(codecStats, 'missing') === null, 'Missing codec reports stay unknown instead of guessing AV1');
  check(stage.getCodecName(codecStats, 'actual-video') === 'H264', 'Stage codec comes from the exact RTP reference');
  check(stage.getCodecName(codecStats, 'first-capability') === 'AV1', 'Referenced AV1 remains visible when it is the actual RTP codec');
  for (const id of ['audio', 'repair', 'invalid']) {
    check(stage.getCodecName(codecStats, id) === null, `${id}: non-video, repair and malformed codecs are not reported as screen encoding`);
  }
  // Exercise the actual button wiring without physical media, native windows or leaving a real call.
  stage.toggleCamera = async () => { actions.camera++; };
  stage.handleStopStreaming = async () => { actions.stop++; };
  stage.leaveVoice = () => { actions.leave++; };
  stage.toggleVideoFullscreen = async () => { actions.fullscreen++; };
  stage.setChannel(channel.id);
  await document.fonts.ready;
  await delay(200);
  const button = (selector) => root.querySelector(selector);
  const glyph = (control) => control.querySelector(':scope > .audio-state-icon, :scope > .material-symbols-outlined');
  const animations = (control) => glyph(control).getAnimations();
  const enter = (control) => control.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
  const leave = (control) => control.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
  const buttons = () => [...root.querySelectorAll('.voice-stage-container button')];
  const motionCount = () => buttons().reduce((count, control) => count + animations(control).length, 0);
  const rect = (element) => JSON.stringify(element.getBoundingClientRect().toJSON());
  check(motionCount() === 0, 'Actual stage has no autoplay motion');
  check(button('.stage-watch-btn') && button('.stage-fullscreen-btn'), 'Actual participant media controls render');
  check(getComputedStyle(button('.screen-audio-badge')).display === 'none', 'Inactive audio badge is hidden');

  window.stageSmoke = {
    keyboardTarget() {
      button('#stage-btn-mic').focus();
    },
    async keyboardFocused() {
      const control = button('#stage-btn-deafen');
      for (let attempt = 0; attempt < 100 && document.activeElement !== control; attempt++) await delay(20);
      check(document.activeElement === control && control.matches(':focus-visible'), 'Native Tab reaches stage controls');
      check(animations(control).length === 1, 'Keyboard focus receives semantic stage motion');
      control.blur();
      check(animations(control).length === 0, 'Keyboard blur cancels motion');
    },
    async shareAndWatch() {
      voice.isCameraOn = true;
      capturing = true;
      overlayActive = true;
      voice.addScreenShare('local-share');
      await delay(200);
      check(button('#stage-btn-stop-share').style.display === 'inline-flex'
        && button('#btn-stage-quick-stop'), 'Sharing exposes both real stop actions');
      check(!button('.screen-audio-badge').hidden, 'Active screen audio badge is retained');
      const watch = button('.stage-watch-btn');
      watch.click();
      // The deliberate click can outlive a fixed delay on a slow compositor.
      await Promise.all((glyph(watch)?.getAnimations() ?? []).map(animation =>
        animation.finished.catch(error => { if (error.name !== 'AbortError') throw error; })));
      await delay();
      check(!!button('.stage-focused-main .stage-volume-btn')
        && !!button('.stage-mini-card .stage-watch-btn'), 'Watching binds focused controls and remaining mini-card actions');
      check(motionCount() === 0, 'New participant and banner buttons do not autoplay: ' + JSON.stringify(
        buttons().filter(control => animations(control).length).map(control => ({
          id: control.id, classes: control.className, hovered: control.matches(':hover'),
          focused: control.matches(':focus-visible'),
          animations: animations(control).map(animation => ({ state: animation.playState, time: animation.currentTime })),
        }))));
    },
    async normal() {
      for (const selector of ['#stage-btn-camera', '#stage-btn-screen', '#stage-btn-overlay']) {
        const control = button(selector);
        const icon = glyph(control);
        enter(control);
        const hover = animations(control)[0];
        const decoration = control.querySelector('.control-motion-decoration');
        appEvents.emit('voice.state_updated');
        appEvents.emit('overlay.state_changed');
        await delay();
        check(glyph(control) === icon && animations(control)[0] === hover
          && control.querySelector('.control-motion-decoration') === decoration,
        `${selector}: unchanged state preserves the glyph and live hover`);
        leave(control);
      }
      const screen = button('#stage-btn-screen');
      const badge = screen.querySelector('.screen-audio-badge');
      const badgeBounds = rect(badge);
      enter(screen);
      check(!!screen.querySelector('[data-stop]') && !screen.querySelector('[data-arrow]'),
        'Active stage screen motion uses a stop symbol, never a start-share arrow');
      check(rect(badge) === badgeBounds && badge.getAnimations().length === 0,
        'Screen-audio status badge stays stationary');
      leave(screen);
      enter(button('#stage-btn-camera'));
      check(glyph(button('#stage-btn-camera')).textContent === 'videocam_off'
        && getComputedStyle(glyph(button('#stage-btn-camera'))).opacity === '1',
      'Camera artwork preserves the visible stop-camera symbol');

      for (const [flag, selector] of [['serverMuted', '#stage-btn-mic'], ['serverDeafened', '#stage-btn-deafen']]) {
        voice[flag] = true;
        appEvents.emit('voice.state_updated');
        await delay();
        const control = button(selector);
        enter(control);
        check(!control.querySelector('[data-audio-block]').hidden
          && getComputedStyle(glyph(control)).opacity === '1', `${flag}: hover keeps the administrative restriction visible`);
        voice[flag] = false;
        appEvents.emit('voice.state_updated');
        await delay();
      }
      for (const [selector, flag] of [['#stage-btn-mic', 'isMuted'], ['#stage-btn-deafen', 'isDeafened']]) {
        const before = voice[flag];
        button(selector).click();
        await delay();
        check(voice[flag] !== before && animations(button(selector)).length === 1,
          `${selector}: real toggle still works with a single feedback animation`);
        button(selector).click();
        await delay();
      }
      for (const [selector, action] of [
        ['#stage-btn-camera', 'camera'], ['#stage-btn-screen', 'picker'], ['#stage-btn-overlay', 'overlay'],
        ['#stage-btn-soundboard', 'soundboard'], ['#stage-btn-leave', 'leave'],
        ['#stage-btn-stop-share', 'stop'], ['#btn-stage-quick-stop', 'stop'], ['.stage-fullscreen-btn', 'fullscreen'],
      ]) {
        const control = button(selector);
        const before = actions[action];
        const bounds = rect(control);
        enter(control);
        control.click();
        await delay();
        check(actions[action] === before + 1 && animations(control).length <= 1, `${selector}: dispatches the original action once`);
        check(rect(control) === bounds, `${selector}: clicking keeps the hit box stationary`);
      }
      const volume = button('.stage-volume-btn');
      volume.click();
      await delay();
      enter(volume);
      check(glyph(volume).textContent === 'volume_off' && volume.querySelector('[data-mute]')
        && !volume.querySelector('[data-wave-inner]'), 'Muted screen audio animates a mute cross, never sound waves');
      check(!!button('.stage-focused-main'), 'Volume and fullscreen actions do not toggle tile focus');
      volume.click();
      await delay();
      enter(volume);
      check(!!volume.querySelector('[data-wave-inner]'), 'Unmuting restores animated sound waves');

      const camera = button('#stage-btn-camera');
      camera.disabled = true;
      await delay();
      enter(camera);
      check(animations(camera).length === 0 && !camera.querySelector('.control-motion-decoration'),
        'Loading or disabled stage controls do not animate');
      camera.disabled = false;
      const stop = button('#stage-btn-stop-share');
      enter(stop);
      voice.isCameraOn = false;
      capturing = false;
      voice.setScreenSharing(false);
      await delay();
      check(animations(stop).length === 0 && !stop.querySelector('.control-motion-decoration'),
        'Hiding the stop button cancels its motion');
      check(!button('#btn-stage-quick-stop'), 'Broadcast banner is removed when sharing stops');
      check(getComputedStyle(badge).display === 'none', 'Screen-audio badge hides without replacing the main glyph');

      button('.stage-stopwatch-btn').click();
      await delay();
      check(!!button('.stage-watch-btn') && !button('.stage-volume-btn'), 'Stop watching restores the gated grid');
      button('.stage-watch-btn').click();
      await delay();
      for (let iteration = 0; iteration < 3; iteration++) {
        const oldCard = button('.stage-focused-main');
        const oldButton = oldCard.querySelector('.stage-volume-btn');
        enter(oldButton);
        const oldHover = animations(oldButton)[0];
        stage.renderParticipants();
        await delay();
        check(oldHover.playState === 'idle' && !oldButton.querySelector('.control-motion-decoration'),
          'Replacing participant cards cancels their animations');
        document.body.append(oldCard);
        enter(oldButton);
        oldButton.classList.toggle('active');
        await delay();
        check(animations(oldButton).length === 0, 'Removed card listeners and observers stay detached on connected DOM');
        oldCard.remove();
        enter(button('.stage-volume-btn'));
        check(animations(button('.stage-volume-btn')).length === 1, 'Replacement cards bind exactly once');
      }
      for (const control of buttons().filter((control) => control.style.display !== 'none')) {
        enter(control);
        const animation = animations(control)[0];
        check(animation && animation.effect.getTiming().iterations === 1
          && animation.effect.getTiming().duration > 480, 'Every visible stage control has a finite, semantic hover');
      }
      await delay(950);
      check(motionCount() === 0 && !root.querySelector('.control-motion-decoration'), 'All stage hovers finish and remove artwork');
      for (const selector of ['#stage-btn-overlay', '.stage-volume-btn']) {
        const control = button(selector);
        enter(control);
        animations(control)[0].pause();
      }
    },
    async reduced() {
      await delay(50);
      check(matchMedia('(prefers-reduced-motion: reduce)').matches && motionCount() === 0,
        'Runtime reduced motion cancels stage and participant animations');
      check(!root.querySelector('.control-motion-decoration'), 'Reduced motion removes stage artwork');
      for (const control of buttons()) {
        enter(control);
        control.focus();
        control.classList.toggle('active');
        await delay();
        check(animations(control).length === 0 && getComputedStyle(control).transitionDuration === '0s',
          'Reduced motion suppresses stage hover, focus, state and CSS feedback');
        control.blur();
      }
      button('#stage-btn-overlay').click();
      await delay();
      check(motionCount() === 0 && actions.overlay === 2, 'Reduced motion preserves actions without click animation');
    },
    async cleanup() {
      await delay(50);
      check(!matchMedia('(prefers-reduced-motion: reduce)').matches && motionCount() === 0,
        'Re-enabling motion does not autoplay the stage');
      for (let iteration = 0; iteration < 3; iteration++) {
        const oldStage = button('.voice-stage-container');
        const oldButton = button('#stage-btn-overlay');
        enter(oldButton);
        stage.render();
        check(animations(oldButton).length === 0, 'Stage re-render cancels old motion synchronously');
        document.body.append(oldStage);
        enter(oldButton);
        oldButton.classList.toggle('active');
        await delay();
        check(animations(oldButton).length === 0, 'Stage re-render removes old listeners and observer');
        oldStage.remove();
        enter(button('#stage-btn-overlay'));
        check(animations(button('#stage-btn-overlay')).length === 1, 'Stage re-render binds one fresh motion controller');
      }
      const control = button('#stage-btn-overlay');
      stage.destroy();
      check(animations(control).length === 0 && !root.querySelector('.control-motion-decoration'),
        'Destroy cancels all stage artwork');
      enter(control);
      control.classList.toggle('active');
      await delay();
      check(animations(control).length === 0, 'Destroy removes motion listeners and state observer');
      offPicker();
      screenAudioService.getIsCapturing = originalCapturing;
      overlayBridgeService.isActive = originalOverlayActive;
      overlayConfigModal.open = originalOverlayOpen;
      soundboardModal.open = originalSoundboardOpen;
      return checks;
    },
  };
}
