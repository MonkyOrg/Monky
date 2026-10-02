const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('events, native actions, forums and banner cropping work in both locales', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `community-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_COMMUNITY_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.MONKY_COMMUNITY_PROFILE);
  let vite, browser, timeout;
  const finish = async code => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    const fonts = ['material-symbols/outlined.css', '@fontsource/inter/400.css', '@fontsource/inter/600.css']
      .map(id => `<link rel="stylesheet" href="/@fs/${require.resolve(id).replaceAll('\\', '/')}">`).join('');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false },
      plugins: [{ name: 'community-fixture', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === '/avatars/cover.png') {
            response.setHeader('Content-Type', 'image/svg+xml');
            response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400"><rect width="1000" height="400" fill="#363586"/><circle cx="700" cy="180" r="170" fill="#6965d9"/><path d="M0 400L360 90L670 400" fill="#88b8d4"/></svg>');
            return;
          }
          if (request.url !== '/__community__') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css">${fonts}</head><body><main id="root"></main></body></html>`);
        });
      } }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 1200, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    browser.webContents.debugger.attach('1.3');
    timeout = setTimeout(() => { console.error('Community DOM timeout'); void finish(1); }, 90000);
    for (const locale of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__community__`);
      await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      const inviteModule = '/@fs/' + path.resolve(root, '..', '..', 'packages', 'shared', 'src', 'serverInvites.ts').replaceAll('\\', '/');
      await browser.webContents.executeJavaScript(`window.communityRegression = (${regression.toString()})(${JSON.stringify(locale)}, ${JSON.stringify(inviteModule)}); void 0`);
      for (;;) {
        const step = await browser.webContents.executeJavaScript('window.communityRegression.next().catch(error => ({ failure: error.stack || String(error) }))', true);
        if (step.failure) throw new Error(step.failure);
        if (step.done) { console.log(`Community DOM (${locale}): ${step.value} checks`); break; }
        if (process.env.MONKY_COMMUNITY_TRACE) console.log(`Community step (${locale}): ${step.value}`);
        if (['event-step-reduced-motion', 'event-step-motion-enabled',
          'live-action-reduced-motion', 'live-action-motion-enabled',
          'chat-entry-reduced-motion', 'chat-entry-motion-enabled'].includes(step.value)) {
          await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: step.value.endsWith('reduced-motion') ? 'reduce' : 'no-preference' }],
          });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        const pickerInput = {
          'event-frequency-dropdown': 'repeat',
          'event-channel-open': 'channel',
          'event-channel-label': 'channel',
          'event-channel-body': 'channel',
          'event-date-dropdown': 'start-date',
          'event-time-dropdown': 'start-time',
        }[step.value];
        if (pickerInput) {
          const point = await browser.webContents.executeJavaScript(`(() => {
            const select = document.querySelector('[data-input=${pickerInput}]');
            select.scrollIntoView({ block: 'center', behavior: 'instant' });
            const range = document.createRange();
            if (${step.value === 'event-channel-label'}) range.selectNodeContents(select.labels[0].firstChild);
            const box = ${step.value === 'event-channel-label'} ? range.getBoundingClientRect() : select.getBoundingClientRect();
            return { x: Math.round(${['event-channel-label', 'event-channel-body', 'event-date-dropdown', 'event-time-dropdown'].includes(step.value) ? 'box.left + box.width / 2' : 'box.right - 18'}), y: Math.round(box.top + box.height / 2) };
          })()`);
          browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value === 'sidebar-banner-hover') {
          const point = await browser.webContents.executeJavaScript(`(() => {
            const box = document.querySelector('#sidebar-layout-fixture .server-dropdown-toggle').getBoundingClientRect();
            return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
          })()`);
          browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value === 'event-confirm-start') {
          const point = await browser.webContents.executeJavaScript(`(() => {
            const box = document.querySelector('[data-event-action=confirm-start]').getBoundingClientRect();
            return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
          })()`);
          browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value.startsWith('event-audience-wheel-')) {
          const modalWheel = step.value === 'event-audience-wheel-modal';
          const point = await browser.webContents.executeJavaScript(`(() => {
            const target = document.querySelector(${JSON.stringify(modalWheel
              ? '.event-step-viewport' : '[data-resource-audience=event-audience] .share-audience-options')});
            const box = target.getBoundingClientRect();
            return { x: Math.round(${modalWheel ? 'box.left + 4' : 'box.left + box.width / 2'}),
              y: Math.round(${modalWheel ? 'box.top + 4' : 'box.top + box.height / 2'}) };
          })()`);
          await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', ...point, deltaX: 0,
            deltaY: modalWheel || step.value === 'event-audience-wheel-top' ? -160 : 160,
          });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value === 'event-audience-scrollbar-modal') {
          const drag = await browser.webContents.executeJavaScript(`(() => {
            const scroller = document.querySelector('.event-step-viewport');
            const box = scroller.getBoundingClientRect();
            const thumbHeight = scroller.clientHeight * scroller.clientHeight / scroller.scrollHeight;
            const trackHeight = scroller.clientHeight - thumbHeight;
            const thumbTop = scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) * trackHeight;
            return { x: Math.round(box.right - 4),
              y: Math.round(box.top + thumbTop + thumbHeight / 2),
              endY: Math.round(box.top + thumbHeight / 2 + trackHeight * 0.2) };
          })()`);
          browser.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y });
          browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: drag.x, y: drag.y });
          for (let index = 1; index <= 5; index++) {
            browser.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x,
              y: Math.round(drag.y + (drag.endY - drag.y) * index / 5) });
            await browser.webContents.executeJavaScript('new Promise(requestAnimationFrame)');
          }
          browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: drag.x, y: drag.endY });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value === 'audience-search-clear') {
          await browser.webContents.debugger.sendCommand('DOM.enable');
          const { root: documentNode } = await browser.webContents.debugger.sendCommand('DOM.getDocument');
          const { nodeId } = await browser.webContents.debugger.sendCommand('DOM.querySelector', {
            nodeId: documentNode.nodeId, selector: '[data-resource-audience=poll-audience] [data-audience-search]',
          });
          const { node } = await browser.webContents.debugger.sendCommand('DOM.describeNode', { nodeId, depth: -1, pierce: true });
          const findClearButton = current => {
            if (current.attributes?.some(value => value === '-webkit-search-cancel-button')) return current;
            for (const child of [...(current.children ?? []), ...(current.shadowRoots ?? [])]) {
              const found = findClearButton(child);
              if (found) return found;
            }
          };
          const clear = findClearButton(node);
          if (!clear) throw new Error('Native audience search clear button is missing');
          const { nodeIds } = await browser.webContents.debugger.sendCommand('DOM.pushNodesByBackendIdsToFrontend', {
            backendNodeIds: [clear.backendNodeId],
          });
          await browser.webContents.debugger.sendCommand('CSS.enable');
          const { computedStyle } = await browser.webContents.debugger.sendCommand('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] });
          if (computedStyle.find(property => property.name === 'cursor')?.value !== 'pointer') {
            throw new Error('The actual native audience search clear button must have a pointer cursor');
          }
          const { model } = await browser.webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId: nodeIds[0] });
          const point = { x: Math.round((model.content[0] + model.content[2]) / 2),
            y: Math.round((model.content[1] + model.content[5]) / 2) };
          browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (process.env.MONKY_COMMUNITY_SCREENSHOTS) {
          if (step.value === 'event-step-forward-motion') {
            await browser.webContents.executeJavaScript(`(() => {
              window.capturedStepAnimations = document.querySelector('.event-step-viewport').getAnimations({ subtree: true });
              for (const animation of window.capturedStepAnimations) {
                animation.pause();
                animation.currentTime = animation.effect.getTiming().duration / 2;
              }
            })()`);
          } else {
            await browser.webContents.executeJavaScript(`(async () => {
              for (let pass = 0; pass < 2; pass++) {
                const animations = document.getAnimations().filter(animation => animation.playState === 'running'
                  && animation.effect.getComputedTiming().endTime <= 1000);
                await Promise.race([
                  Promise.allSettled(animations.map(animation => animation.finished)),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot motion did not settle: ' + animations
                    .map(animation => animation.effect.target?.className + ':' + animation.playState).join(', '))), 4000)),
                ]);
              }
            })()`);
          }
          await browser.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
          fs.writeFileSync(path.join(process.env.MONKY_COMMUNITY_SCREENSHOTS, `727-${locale}-${step.value}.png`),
            (await browser.webContents.capturePage()).toPNG());
          if (step.value === 'event-step-forward-motion') {
            await browser.webContents.executeJavaScript('window.capturedStepAnimations.forEach(animation => animation.play())');
          }
        }
      }
    }
    await finish(0);
  }).catch(error => { console.error(error); void finish(1); });
}

async function* regression(locale, inviteModule) {
  const { selectEnhancer } = await import('/core/SelectEnhancer.ts');
  selectEnhancer.init();
  const { dateTimeControls } = await import('/core/DateTimeControls.ts');
  dateTimeControls.init();
  const { CommunityFeed } = await import('/core/CommunityFeed.ts');
  const { ServerCommunityView } = await import('/views/ServerCommunityView.ts');
  const { openNativePollWizard } = await import('/views/NativePollWizard.ts');
  const { imageCarouselNavigationButton, moveImageCarousel, renderImageCarouselEditor } = await import('/views/ImageCarousel.ts');
  const { serverRailCallIcon } = await import('/views/ServerRailView.ts');
  const { ForumView } = await import('/views/ForumView.ts');
  const { openImageCropper, openImageCropperBatch } = await import('/views/ImageCropModal.ts');
  const { uploadAttachment } = await import('/core/AttachmentUploader.ts');
  const { openFileInputPicker, setButtonLoading } = await import('/utils/buttonLoading.ts');
  const { automaticScrollBehavior } = await import('/utils/scroll.ts');
  const { getActiveNetworkClient, setActiveNetworkClient } = await import('/core/NetworkClient.ts');
  const { appEvents } = await import('/core/EventBus.ts');
  const { setLanguage, t } = await import('/i18n/index.ts');
  const { translateProtocolError } = await import('/i18n/protocolErrors.ts');
  const { parseServerInviteLink } = await import(inviteModule);
  setLanguage(locale);
  localStorage.clear();
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const { RecentSoundsModal } = await import('/views/RecentSoundsModal.ts');
  const { sessionManager: recentSessionManager } = await import('/core/SessionManager.ts');
  const previousRecentSession = recentSessionManager.getActive;
  const previousRecentApi = window.api;
  const recentButton = document.createElement('button');
  document.body.append(recentButton);
  try {
    for (const outcome of [
      { result: { success: true }, toast: true },
      { result: { success: false, canceled: true } },
      { result: { success: false, error: 'Save failed' }, error: true },
      { result: { success: true }, abort: true },
      { result: { success: true }, switchSession: true },
    ]) {
      document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
      const controller = new AbortController();
      const errors = [];
      let activeKey = 'recent-download';
      let resolveSave;
      recentSessionManager.getActive = () => ({ key: activeKey });
      window.api = { ...previousRecentApi, saveRecentSound: () => new Promise(resolve => { resolveSave = resolve; }) };
      const pending = new RecentSoundsModal().download('recent-download', 'sound', recentButton,
        controller.signal, message => errors.push(message),
        async () => ({ soundName: 'QA audio', mimeType: 'audio/wav', audioBase64: 'UklGRg==' }));
      await Promise.resolve();
      check(resolveSave && !document.querySelector('.chat-copy-toast') && recentButton.disabled,
        'A pending audio save shows loading but no premature success toast');
      if (outcome.abort) controller.abort();
      if (outcome.switchSession) activeKey = 'other-server';
      resolveSave(outcome.result);
      await pending;
      const toast = document.querySelector('.chat-copy-toast');
      check(outcome.toast
        ? toast?.querySelector('.chat-copy-toast-label')?.textContent === t('recentSounds.saved')
          && toast.getAttribute('role') === 'status'
        : !toast,
      'Only a successful audio save in the current open surface shows localized confirmation');
      check(errors.length === (outcome.error ? 1 : 0),
        'Save errors remain explicit while cancellation and retired surfaces have no false failure');
      setButtonLoading(recentButton, false);
    }
  } finally {
    recentSessionManager.getActive = previousRecentSession;
    window.api = previousRecentApi;
    recentButton.remove();
    document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
  }
  check(translateProtocolError('COMMUNITY_INVALID', 'Live actions are disabled.') === t('poll.liveActionsDisabled'),
    'Disabled server activities retain their exact localized protocol reason');
  check(automaticScrollBehavior() === 'smooth',
    'Automatic UI navigation uses smooth scrolling when reduced motion is not requested');
  const carouselFixture = document.createElement('div');
  carouselFixture.innerHTML = renderImageCarouselEditor([
    'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
    'data:image/gif;base64,R0lGODlhAQABAIAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
  ], {
    label: 'Images', addLabel: 'Add', removeLabel: 'Remove',
    moveBackLabel: 'Move back', moveForwardLabel: 'Move forward',
  });
  document.body.append(carouselFixture);
  const carousel = carouselFixture.querySelector('[data-image-carousel]');
  const nextCarousel = carousel.querySelector('[data-carousel-move="1"]');
  check(carousel.querySelectorAll('.image-carousel-slide').length === 2
    && carousel.querySelectorAll('.image-carousel-dot').length === 2
    && carousel.querySelector('[data-carousel-edit="add"]')
    && getComputedStyle(carousel.querySelector('.image-carousel-slide')).objectFit === 'contain',
  'The media editor presents one large Reddit-style carousel with overlay actions, arrows and dots');
  check(!imageCarouselNavigationButton(carousel.querySelector('[data-carousel-edit="remove"]'))
    && imageCarouselNavigationButton(nextCarousel) === nextCarousel,
  'Carousel edit controls cannot be swallowed by the delegated navigation handler');
  check(moveImageCarousel(nextCarousel)
    && carousel.dataset.carouselIndex === '1'
    && carousel.querySelector('.image-carousel-track').style.transform === 'translateX(-100%)'
    && carousel.querySelector('[data-carousel-index="1"]').getAttribute('aria-current') === 'true'
    && parseFloat(getComputedStyle(carousel.querySelector('.image-carousel-track')).transitionDuration) > 0,
  'Carousel navigation animates the track and updates the active accessible indicator');
  carouselFixture.remove();
  const composerFixture = document.createElement('div');
  composerFixture.className = 'chat-composer-surface';
  composerFixture.innerHTML = '<div class="chat-create-menu"><button type="button">Action</button></div>';
  document.body.append(composerFixture);
  check(getComputedStyle(composerFixture).overflow === 'visible',
    'An open composer action menu is not clipped by the composer surface');
  composerFixture.querySelector('.chat-create-menu').hidden = true;
  check(getComputedStyle(composerFixture).overflow === 'hidden',
    'The composer restores clipping after its action menu closes');
  composerFixture.remove();
  const flush = async () => {
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < 40; i++) await Promise.resolve();
      const active = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
      let timeout;
      try {
        await Promise.race([
          Promise.allSettled(active.map(animation => animation.finished)),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Animations did not settle: ${active.map(animation =>
            JSON.stringify({ state: animation.playState, target: animation.effect?.target?.className, timing: animation.effect?.getTiming() })).join('; ')}`)), 4000); }),
        ]);
      } finally { clearTimeout(timeout); }
    }
  };
  const initiallyDisabled = document.createElement('button');
  initiallyDisabled.disabled = true;
  setButtonLoading(initiallyDisabled, true);
  setButtonLoading(initiallyDisabled, false);
  check(initiallyDisabled.disabled && !initiallyDisabled.dataset.loading && !initiallyDisabled.hasAttribute('aria-busy'),
    'Shared button loading preserves a pre-existing disabled state');
  const pickerTrigger = document.createElement('button');
  const pickerInput = document.createElement('input');
  pickerInput.type = 'file';
  Object.defineProperty(pickerInput, 'click', { configurable: true, value: () => {} });
  openFileInputPicker(pickerInput, pickerTrigger);
  openFileInputPicker(pickerInput, pickerTrigger);
  check(pickerTrigger.disabled && pickerTrigger.dataset.loading === '1' && pickerTrigger.getAttribute('aria-busy') === 'true',
    'Shared native picker loading blocks a duplicate open while pending');
  window.dispatchEvent(new Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await flush();
  check(!pickerTrigger.disabled && !pickerTrigger.dataset.loading && !pickerTrigger.hasAttribute('aria-busy'),
    'Window focus fallback restores a native picker trigger when no cancel event is available');
  Object.defineProperty(pickerInput, 'click', { configurable: true, value: () => { throw new Error('picker unavailable'); } });
  let pickerError;
  try { openFileInputPicker(pickerInput, pickerTrigger); } catch (error) { pickerError = error; }
  check(pickerError?.message === 'picker unavailable' && !pickerTrigger.disabled
    && !pickerTrigger.dataset.loading && !pickerTrigger.hasAttribute('aria-busy'),
  'A synchronous native picker failure remains explicit and restores its trigger');
  const until = async predicate => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Condition did not become true');
  };
  const settleScroll = async element => {
    let lastScroll = element.scrollTop;
    let lastChange = performance.now();
    await until(() => {
      if (element.scrollTop !== lastScroll) {
        lastScroll = element.scrollTop;
        lastChange = performance.now();
      }
      return performance.now() - lastChange >= 160;
    });
  };
  const now = Date.now();
  const event = { id: 'event', creatorUserId: 'owner', title: '<img src=x onerror=alert(1)>',
    description: 'Details', location: { kind: 'voice', channelId: 'voice' }, startsAt: now - 1000,
    endsAt: now + 60000, repeat: 'none', timeZone: 'UTC', status: 'active', imageUrl: null, imageUrls: [],
    revision: 0, occurrence: 0, anchorStartsAt: now - 1000, startedAt: now - 1000, endedAt: null,
    createdAt: now - 10000, interested: false, interestedCount: 2 };
  check(serverRailCallIcon([event], 'voice') === 'calendar_month'
    && serverRailCallIcon([{ ...event, status: 'scheduled' }], 'voice') === 'volume_up'
    && serverRailCallIcon([event], 'other') === 'volume_up',
  'Server rail uses a speaker for calls and changes it to a calendar only for an active event in that voice channel');
  const action = { id: 'action', channelId: 'text', botId: 'bot', creatorUserId: 'owner',
    title: 'Native interaction', description: '', imageUrls: ['/avatars/action-1.png', '/avatars/action-2.png'],
    imagePresentation: { format: 'square', fit: 'contain', size: 'compact' },
    expiresAt: now + 60000, createdAt: now, revision: 0,
    content: { kind: 'form', form: { title: 'Choose', fields: [
      { type: 'select', name: 'answer', label: 'Answer', presentation: 'buttons', required: true, choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { type: 'boolean', name: 'enabled', label: 'Enabled', defaultValue: false },
      { type: 'image-list', name: 'gallery', label: 'Gallery', maxItems: 5,
        presentation: { format: 'landscape', fit: 'cover', size: 'regular' } },
    ] } } };
  const poll = {
    id: 'poll', messageId: 'poll-message', channelId: 'text', creatorUserId: 'owner',
    question: 'Native poll', options: [
      { id: 'yes', label: 'Yes', emoji: '👍', votes: 1 }, { id: 'no', label: 'No', emoji: null, votes: 0 },
    ],
    totalVotes: 1, maxVoters: 5, closesAt: now + 60_000, revision: 0,
    allowMultiple: true, imageUrls: ['/avatars/cover.png', '/avatars/cover.png'], allowChange: true, liveAction: true,
    closedAt: null, createdAt: now, myVoteOptionIds: ['yes'],
  };
  const nativeForm = {
    id: 'native-form', channelId: 'text', creatorUserId: 'owner',
    form: {
      title: 'Native registration', description: 'Editable response',
      submitLabel: 'Register',
      anonymous: true,
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 100 },
        { name: 'bio', label: 'Bio', type: 'text', multiline: true, maxLength: 1000 },
        { name: 'age', label: 'Age', type: 'integer' },
        { name: 'confirmed', label: 'Confirmed', type: 'boolean' },
        {
          name: 'team', label: 'Team', type: 'select', presentation: 'buttons',
          choices: [{ value: 'a', label: 'Team A' }, { value: 'b', label: 'Team B' }],
        },
        {
          name: 'topics', label: 'Topics', type: 'multi-select',
          choices: [{ value: 'news', label: 'News' }, { value: 'events', label: 'Events' }],
        },
        {
          name: 'region', label: 'Region', type: 'select', presentation: 'dropdown',
          choices: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }],
        },
        { name: 'rating', label: 'Rating', type: 'rating' },
      ],
    },
    expiresAt: now + 60000, closedAt: null, createdAt: now, revision: 0,
    responseCount: 0, myResponse: null,
  };
  let snapshot = {
    settings: { eventsEnabled: true, bannerUrl: null },
    events: [event], liveActions: [action], polls: [poll], nativeForms: [nativeForm],
  };
  let allowed = true, rejectSubmit = true, interestedMode = 'normal', interestedGate;
  let uploadedCommunityImages = 0;
  const cancelled = [];
  const calls = [], listeners = new Set();
  const server = {
    currentUser: { id: 'owner', sessionId: 'session' },
    knownMembers: new Map([['member', {
      id: 'member', nickname: 'Audience Member', avatarUrl: null, status: 'DISCONNECTED',
    }]]),
    roles: [{ id: 'audience-role', name: 'Audience Team', color: '#336699' }],
    serverDetails: { id: 'community-test', name: 'Community',
      protocol: { version: 33, minimumVersion: 31, features: ['native-polls', 'native-live-forms'] }, channels: [
      { id: 'voice', name: 'Voice', type: 'VOICE' }, { id: 'text', name: 'Text', type: 'TEXT' },
      { id: 'forum', name: 'Forum', type: 'FORUM' },
      { id: 'event-thread', name: 'Forum thread', type: 'TEXT', forumId: 'forum' },
    ] },
    hasPermission: () => allowed,
    getChannel(id) { return this.serverDetails.channels.find(channel => channel.id === id); },
  };
  const post = { channelId: 'post', forumId: 'forum', title: 'First post', authorId: 'member',
    createdAt: now, updatedAt: now, pinned: false, locked: false, closed: false,
    replyCount: 3, preview: '<script>bad()</script>', firstMessageId: 'message' };
  let forumPosts = [post];
  let forumListGate = null;
  const client = {
    sessionKey: 'community-test', getStatus: () => 'CONNECTED', getHttpBaseUrl: () => window.location.origin,
    send(type, payload) { calls.push({ type, payload }); },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancelRequest(id) { cancelled.push(id); return true; },
    async sendRequest(type, payload, requestId) {
      calls.push({ type, payload, requestId });
      if (type === 'COMMUNITY_GET') return structuredClone(snapshot);
      if (type === 'EVENT_GET') {
        if (payload.id === 'missing') throw new Error('Event unavailable');
        return { event: { ...event, id: payload.id, ...(payload.id === 'historic' ? { status: 'ended' } : {}) } };
      }
      if (type === 'EVENT_GET_INTERESTED') {
        if (interestedMode === 'fail') throw new Error('Interested list fixture failure');
        if (interestedMode === 'deferred') return await new Promise(resolve => { interestedGate = resolve; });
        if (interestedMode === 'empty') return { id: payload.id, users: [], nextCursor: null };
        return { id: payload.id, users: [{ id: payload.cursor ? 'member-b' : 'member-a',
          nickname: payload.cursor ? 'Second member' : '<img src=x onerror=alert(1)>', avatarUrl: null }],
          nextCursor: payload.cursor ? null : 'member-a' };
      }
      if (type === 'LIVE_ACTION_SUBMIT' && rejectSubmit) { rejectSubmit = false; throw new Error('Retry response'); }
      if (type === 'NATIVE_FORM_SUBMIT') {
        const form = snapshot.nativeForms.find(entry => entry.id === payload.id);
        const submittedAt = now + 1000;
        form.myResponse = { values: payload.values, createdAt: submittedAt, updatedAt: submittedAt };
        form.responseCount = 1;
        queueMicrotask(() => emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot)));
        return structuredClone(form);
      }
      if (type === 'NATIVE_FORM_RESULTS') {
        const offset = payload.cursor ? 50 : 0;
        return {
          id: payload.id,
          responses: Array.from({ length: 50 }, (_, pageIndex) => {
            const index = offset + pageIndex;
            return {
              user: null,
              response: {
                values: {
                  name: index >= 1 && index <= 3
                    ? 'Repeated short answer'
                    : `Lucas ${String(index + 1).padStart(3, '0')}`,
                  bio: index === 0 ? '=1+1' : index >= 4 && index <= 7
                    ? 'Repeated long answer'
                    : `Details ${index + 1}`,
                  age: [20, 30, 40, 50][index % 4],
                  confirmed: index % 2 === 0,
                  team: index % 2 === 0 ? 'a' : 'b',
                  topics: index % 3 === 0 ? ['news', 'events'] : ['news'],
                  region: index % 2 === 0 ? 'south' : 'north',
                  rating: (index % 5) + 1,
                },
              },
            };
          }),
          nextCursor: payload.cursor ? null : 'anonymous-page-2',
        };
      }
      if (type === 'NATIVE_FORM_CLOSE') {
        snapshot.nativeForms = snapshot.nativeForms.filter(entry => entry.id !== payload.id);
        queueMicrotask(() => emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot)));
        return {};
      }
      if (type === 'POLL_CLOSE') {
        snapshot.polls = snapshot.polls.filter(entry => entry.id !== payload.id);
        queueMicrotask(() => emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot)));
        return { ...poll, closedAt: now, liveAction: false, revision: poll.revision + 1 };
      }
      if (type === 'POLL_VOTE') return {
        ...poll, totalVotes: 2, revision: 1, myVoteOptionIds: payload.optionIds,
        options: poll.options.map(option => ({ ...option, votes: payload.optionIds.includes(option.id) ? option.votes + 1 : option.votes })),
      };
      if (type === 'COMMUNITY_IMAGE_UPLOAD') {
        uploadedCommunityImages++;
        return {
          ref: `00000000-0000-4000-8000-${String(uploadedCommunityImages).padStart(12, '0')}`,
          url: `/avatars/community-test-${uploadedCommunityImages}.png`,
        };
      }
      if (type === 'FORUM_LIST') {
        if (payload.offset > 0 && forumListGate) await forumListGate;
        const posts = [...forumPosts].sort((left, right) => payload.sort === 'oldest'
          ? left.createdAt - right.createdAt
          : payload.sort === 'newest'
            ? right.createdAt - left.createdAt
            : right.updatedAt - left.updatedAt);
        const offset = payload.offset ?? 0;
        const page = posts.slice(offset, offset + 25);
        return { channelId: 'forum', posts: page, hasMore: offset + page.length < posts.length, nextOffset: offset + page.length };
      }
      if (type === 'FORUM_CREATE_POST') return { post: { ...post, channelId: payload.id, title: payload.title } };
      if (type === 'CHAT_REQUEST_UPLOAD_TOKEN') return { token: 'forum-token' };
      return {};
    },
  };
  const emit = (type, payload, requestId) => { for (const listener of listeners) listener(type, payload, requestId); };
  const root = document.getElementById('root');
  const feed = new CommunityFeed(client, server);
  await feed.load();
  const notices = [];
  const offNotice = appEvents.on('community.event_started', notice => notices.push(notice));
  emit('message.EVENT_STARTED', { event: { ...event, interested: true } });
  emit('message.EVENT_STARTED', { event: { ...event, interested: true } });
  check(notices.length === 1 && notices[0].serverName === 'Community', 'Start notices deduplicate per occurrence and retain their server');
  offNotice();
  const view = new ServerCommunityView(root, feed, async () => {});
  check(root.querySelectorAll('.community-banner').length === 1, 'Only one banner is visible');
  check(root.querySelector('.community-navigation'), 'Simultaneous activities have navigation');
  check(!root.querySelector('img'), 'Event title is escaped');
  root.querySelector('[data-community=dismiss]').click();
  check(root.querySelector('.community-banner').inert, 'Banner dismissal immediately disables the outgoing activity');
  await flush();
  check(root.textContent.includes('Native interaction') && !root.querySelector('.community-banner .image-carousel'),
    'Dismissing moves to the next activity without rendering its media in the left sidebar');
  root.querySelector('[data-community=actions]').click();
  const actionList = document.querySelector('.live-action-list-modal');
  check(actionList?.classList.contains('event-list-modal')
    && actionList.querySelector('.modal-title .material-symbols-outlined')?.textContent === 'bolt'
    && actionList.querySelector('.live-action-card .community-event-content')
    && actionList.querySelector('.live-action-card .community-event-footer')
    && actionList.querySelectorAll('[data-live-action-menu]').length === 3,
  'Live actions reuse the event-list hierarchy and expose management from card menus');
  actionList.querySelector('[data-create-live-action]').click();
  await flush();
  const createAction = document.querySelector('.live-action-create-modal');
  check(createAction?.querySelector('[data-live-action-type=poll]')
    && createAction.querySelector('[data-live-action-type=form]')
    && createAction.querySelector('[data-live-action-channel]')
    && ![...createAction.querySelector('[data-live-action-channel]').options]
      .some(option => option.value === 'event-thread'),
  'The Live Actions hub offers permission-gated poll and form creation with an explicit channel');
  createAction.querySelector('[data-live-action-type=form]').click();
  await flush();
  const formWizard = document.querySelector('.native-live-form-wizard');
  check(formWizard?.querySelector('[data-live-form-title]')
    && formWizard.querySelector('[data-live-form-anonymous]')
    && formWizard.querySelectorAll('[data-live-form-stepper]').length === 3,
  'Native form creation opens the shared three-step wizard with immutable anonymity configuration');
  check(parseFloat(getComputedStyle(formWizard).paddingLeft) >= 32
    && parseFloat(getComputedStyle(formWizard).paddingRight) >= 32
    && parseFloat(getComputedStyle(formWizard.querySelector('.native-poll-step-viewport')).paddingLeft) >= 16
    && parseFloat(getComputedStyle(formWizard.querySelector('.native-poll-step-viewport')).paddingRight) >= 16,
  'Native form creation keeps its controls inset from both modal and scrolling edges');
  formWizard.querySelector('[data-live-form-title]').value = 'QA form';
  formWizard.querySelector('[data-live-form-title]').dispatchEvent(new Event('input', { bubbles: true }));
  formWizard.querySelector('[data-live-form-anonymous]').checked = true;
  formWizard.querySelector('[data-live-form-anonymous]').dispatchEvent(new Event('change', { bubbles: true }));
  const formPrivate = formWizard.querySelector('[data-resource-audience=live-form-audience] [data-audience-private]');
  formPrivate.checked = true;
  formPrivate.dispatchEvent(new Event('change', { bubbles: true }));
  check(formWizard.querySelector('[data-live-form-next]').disabled,
    'Private native forms block advancement until a member or role is selected');
  formWizard.querySelector('[data-resource-audience=live-form-audience] [data-audience-toggle]').click();
  formWizard.querySelector('[data-resource-audience=live-form-audience] [data-audience-kind=user]').click();
  check(formWizard.querySelectorAll('[data-resource-audience=live-form-audience] .share-audience-chip').length === 1
    && !formWizard.querySelector('[data-live-form-next]').disabled,
  'Native forms reuse the searchable member and role audience picker with selected chips');
  formWizard.querySelector('[data-live-form-next]').click();
  await flush();
  check(formWizard.querySelectorAll('[data-live-form-field-type] option').length === 8,
    'The native form builder offers text, number, switch, single, multiple, dropdown and rating fields');
  const formFieldType = formWizard.querySelector('[data-live-form-field-type]');
  check(formWizard.getBoundingClientRect().width >= 600 && formFieldType.getBoundingClientRect().width >= 180,
    'The native form wizard is wide enough to show complete response-type labels');
  formFieldType.value = 'select';
  formFieldType.dispatchEvent(new Event('change', { bubbles: true }));
  check(getComputedStyle(formWizard.querySelector('.native-live-form-choice-marker')).borderRadius === '50%',
    'Single-choice editing uses Google Forms-style circular answer markers');
  const multipleFieldType = formWizard.querySelector('[data-live-form-field-type]');
  multipleFieldType.value = 'multi_select';
  multipleFieldType.dispatchEvent(new Event('change', { bubbles: true }));
  check(formWizard.querySelectorAll('[data-live-form-field-choice]').length === 2
    && formWizard.querySelector('[data-live-form-add-choice]')
    && formWizard.textContent.includes(t('liveForm.fieldType.multi_select')),
  'Multiple-choice fields use individual Google Forms-style option rows and an add action');
  const choiceRow = formWizard.querySelector('.native-live-form-choice-row').getBoundingClientRect();
  const nextChoiceRow = formWizard.querySelectorAll('.native-live-form-choice-row')[1].getBoundingClientRect();
  const choiceInput = formWizard.querySelector('[data-live-form-field-choice]').getBoundingClientRect();
  const choiceRemove = formWizard.querySelector('[data-live-form-remove-choice]').getBoundingClientRect();
  const choiceMarker = formWizard.querySelector('.native-live-form-choice-marker').getBoundingClientRect();
  check(choiceInput.width > choiceRow.width - choiceRemove.width - choiceMarker.width - 30
    && choiceMarker.right < choiceInput.left
    && choiceRemove.left >= choiceInput.right - 1
    && Math.abs(choiceRemove.right - choiceRow.right) <= 1
    && getComputedStyle(formWizard.querySelector('.native-live-form-choice-marker')).borderRadius !== '50%',
  'Multiple-choice editing aligns square marker, underlined answer and delete action');
  check(nextChoiceRow.top - choiceRow.bottom >= 5,
    'Google Forms-style answer rows retain readable vertical spacing');
  check(getComputedStyle(formWizard.querySelector('[data-live-form-add-choice]')).backgroundColor === 'rgba(0, 0, 0, 0)'
    && formWizard.querySelector('[data-live-form-add-choice] .native-live-form-choice-marker'),
  'Adding an answer is a lightweight marker-aligned text action');
  check(getComputedStyle(formWizard.querySelector('[data-live-form-remove-field]')).backgroundColor === 'rgba(0, 0, 0, 0)',
    'Disabled field deletion remains transparent instead of inheriting a gray button surface');
  formWizard.querySelector('[data-live-form-add-choice]').click();
  check(formWizard.querySelectorAll('[data-live-form-field-choice]').length === 3,
    'Form choices can be added without editing a multiline text block');
  formWizard.querySelector('[data-live-form-remove-choice="2"]').click();
  check(formWizard.querySelectorAll('[data-live-form-field-choice]').length === 2,
    'Form choices can be removed by row');
  for (let index = 0; index < 4; index++) formWizard.querySelector('[data-live-form-add-field]').click();
  const formScroller = formWizard;
  formScroller.scrollTop = Math.min(160, formScroller.scrollHeight - formScroller.clientHeight);
  const formScrollTop = formScroller.scrollTop;
  check(formScrollTop > 0, 'The populated native form wizard has a measurable scroll position');
  formWizard.querySelector('[data-live-form-field-type]').click();
  const shortTextOption = [...document.querySelectorAll('.monky-select-option')]
    .find(option => option.textContent === t('liveForm.fieldType.short_text'));
  shortTextOption.click();
  check(Math.abs(formScroller.scrollTop - formScrollTop) <= 1
    && document.activeElement === formWizard.querySelector('[data-live-form-field-type]'),
  'Selecting a response type preserves modal scroll and restores focus without jumping to the heading');
  formWizard.querySelector('[data-live-form-cancel]').click();
  await flush();
  document.querySelector('[data-live-action]').click();
  await until(() => document.querySelector('.live-action-wizard'));
  const actionWizard = document.querySelector('.live-action-wizard');
  check(actionWizard?.querySelector('.live-action-step > h2')?.textContent.trim() === 'Native interaction'
    && actionWizard.querySelector('.live-action-footer [data-live-cancel]')
    && getComputedStyle(actionWizard).fontFamily === getComputedStyle(document.body).fontFamily,
  'Live action forms reuse the event wizard shell, fixed actions and app typography');
  const actionCarousel = actionWizard.querySelector('.image-carousel');
  const imageDropzone = actionWizard.querySelector('.image-carousel-dropzone');
  check(actionCarousel?.classList.contains('image-carousel--format-square')
    && actionCarousel.classList.contains('image-carousel--fit-contain')
    && actionCarousel.classList.contains('image-carousel--size-compact')
    && getComputedStyle(actionCarousel).maxWidth === '360px',
  'Live actions render the bot carousel format, fit and responsive size preset');
  check(imageDropzone?.classList.contains('image-carousel--format-landscape')
    && imageDropzone.classList.contains('image-carousel--size-regular')
    && getComputedStyle(imageDropzone).maxWidth === '560px',
  'Image-list fields reuse configurable carousel presentation without growing across the full chat');
  const actionSwitch = actionWizard.querySelector('.bot-switch-row .toggle-switch');
  const actionSwitchValue = actionWizard.querySelector('.bot-switch-value');
  const actionSwitchBox = actionSwitch.getBoundingClientRect();
  const actionSwitchValueBox = actionSwitchValue.getBoundingClientRect();
  check(actionSwitch && Math.abs((actionSwitchBox.top + actionSwitchBox.bottom) / 2
    - (actionSwitchValueBox.top + actionSwitchValueBox.bottom) / 2) <= 1,
  'Native form booleans align their switch and value text on the same visual center');
  check(!actionWizard.querySelector('[data-live-close]'),
    'Live Action details keep management actions out of the response footer');
  document.querySelector('[data-bot-select-value=b]').click();
  document.querySelector('[data-live-submit]').click();
  await flush();
  check(!document.querySelector('[data-live-submit]').disabled, 'Failed form response restores controls');
  check(document.querySelector('[data-community-error]:not([hidden])'), 'Form failure is visible');
  document.querySelector('[data-live-submit]').click();
  await flush();
  check(calls.filter(call => call.type === 'LIVE_ACTION_SUBMIT').at(-1).payload.values.answer === 'b', 'Native choice reaches the request');
  document.querySelector('[data-live-action]').click();
  await flush();
  check(!document.querySelector('.live-action-wizard [data-live-close]'),
    'Reopened Live Action details still omit the end action');
  document.querySelector('.live-action-wizard [data-community-close]').click();
  await flush();
  document.querySelector('[data-live-action-menu=action]').click();
  check([...document.querySelectorAll('[role=menuitem]')].some(item =>
    item.textContent.includes(t('community.closeLiveAction'))),
  'Generic Live Action cards expose their end action from the ellipsis menu');
  document.querySelector('.floating-context-menu .danger').click();
  await flush();
  check(document.querySelector('[data-action=confirm]')?.textContent === t('community.closeLiveAction'),
    'Ending a Live Action requires an explicit localized confirmation');
  document.querySelector('[data-action=confirm]').click();
  await flush();
  check(calls.filter(call => call.type === 'LIVE_ACTION_CLOSE').at(-1).payload.id === action.id
    && !document.querySelector('.live-action-list-modal'),
  'Confirming the card-menu end action sends the close request and dismisses the list');
  root.querySelector('[data-community=actions]').click();
  await flush();
  document.querySelector('[data-native-live-form]').click();
  await flush();
  const nativeFormModal = document.querySelector('.live-action-wizard');
  check(nativeFormModal.classList.contains('native-live-form-action-modal')
    && nativeFormModal.querySelectorAll('.native-form-question').length === 8,
  'Native form questions render as separate wide cards');
  const nativeFormScroller = nativeFormModal.querySelector('.live-action-step');
  const nativeFormFooter = nativeFormModal.querySelector('.live-action-footer');
  check(nativeFormModal.querySelector('.native-form-action-close')
    && nativeFormModal.getBoundingClientRect().height <= 762
    && getComputedStyle(nativeFormScroller).overflowY === 'auto'
    && nativeFormFooter.getBoundingClientRect().bottom <= nativeFormModal.getBoundingClientRect().bottom,
  'The response form has a visible close button, bounded height, scrollable questions and fixed actions');
  check(parseFloat(getComputedStyle(nativeFormModal).paddingLeft) >= 32
    && parseFloat(getComputedStyle(nativeFormModal).paddingRight) >= 32
    && parseFloat(getComputedStyle(nativeFormScroller).paddingLeft) >= 16
    && parseFloat(getComputedStyle(nativeFormScroller).paddingRight) >= 16,
  'Native form responses keep question cards away from the modal and scrollbar edges');
  check(nativeFormModal.querySelector('[data-field-name=team] .native-form-answer-marker')
    && getComputedStyle(nativeFormModal.querySelector('[data-field-name=team] .native-form-answer-marker')).borderRadius === '50%'
    && nativeFormModal.querySelector('[data-field-name=topics] .native-form-answer-marker')
    && getComputedStyle(nativeFormModal.querySelector('[data-field-name=topics] .native-form-answer-marker')).borderRadius !== '50%',
  'Single and multiple answers use radio and checkbox geometry');
  check(nativeFormModal.querySelector('[data-field-name=region] select')
    && nativeFormModal.querySelectorAll('[data-field-name=rating] [data-rating-value]').length === 5,
  'Dropdown and five-star rating controls render in the active form');
  check(nativeFormModal.querySelector('[name=age]').type === 'number'
    && getComputedStyle(nativeFormModal.querySelector('[name=bio]')).resize === 'none',
  'Number questions use native number semantics and long text cannot expose the broken resize handle');
  check(nativeFormModal.querySelector('[data-field-name=name] .bot-field-requirement')
    .classList.contains('bot-field-requirement--required'),
  'Required native-form labels use the explicit danger treatment');
  check([...nativeFormModal.querySelectorAll('.bot-field-clear')].every(button => button.hidden)
    && !nativeFormModal.textContent.includes(locale === 'pt-BR' ? 'Limpar / pular' : 'Clear / skip'),
  'Empty optional native-form questions do not show the generic clear-or-skip action');
  nativeFormScroller.scrollTop = nativeFormScroller.scrollHeight;
  const invalidScrollTop = nativeFormScroller.scrollTop;
  nativeFormModal.querySelector('[data-native-form-submit]').click();
  await until(() => nativeFormModal.querySelector('[data-field-name=name]')
    .classList.contains('native-form-question--invalid') && nativeFormScroller.scrollTop < invalidScrollTop);
  check(document.activeElement === nativeFormModal.querySelector('[name=name]')
    && nativeFormModal.querySelector('[data-field-name=name] [data-native-form-field-error]'),
  'Invalid submission highlights, describes, scrolls to and focuses the first unanswered question');
  nativeFormModal.querySelector('[name=name]').value = 'Lucas';
  nativeFormModal.querySelector('[name=name]').dispatchEvent(new Event('input', { bubbles: true }));
  check(!nativeFormModal.querySelector('[data-field-name=name]').classList.contains('native-form-question--invalid'),
    'Editing the invalid answer clears its question-level error treatment');
  nativeFormModal.querySelector('[data-bot-select-value=a]').click();
  nativeFormModal.querySelector('[data-field-name=topics] [data-choice-value=news]').click();
  nativeFormModal.querySelector('[data-field-name=topics] [data-choice-value=events]').click();
  const region = nativeFormModal.querySelector('[data-field-name=region] select');
  region.value = 'south';
  region.dispatchEvent(new Event('change', { bubbles: true }));
  nativeFormModal.querySelector('[data-field-name=rating] [data-rating-value="4"]').click();
  check(getComputedStyle(nativeFormModal.querySelector(
    '[data-field-name=rating] [data-rating-value="4"] .material-symbols-outlined',
  )).fontVariationSettings.includes('"FILL" 1'),
  'The selected rating star is visibly filled');
  check(nativeFormModal.querySelector('[data-field-name=rating] .bot-field-clear').textContent.trim()
    === (locale === 'pt-BR' ? 'Limpar' : 'Clear')
    && !nativeFormModal.querySelector('[data-field-name=rating] .bot-field-clear').hidden,
  'Answered optional native-form questions offer an unambiguous clear action');
  check(nativeFormModal.querySelectorAll('[data-field-name=topics] [aria-pressed=true]').length === 2,
    'Multiple-choice form fields visibly retain every selected option');
  nativeFormModal.querySelector('[data-native-form-submit]').click();
  await flush();
  check(calls.filter(call => call.type === 'NATIVE_FORM_SUBMIT').at(-1).payload.values.name === 'Lucas'
    && calls.filter(call => call.type === 'NATIVE_FORM_SUBMIT').at(-1).payload.values.team === 'a'
    && calls.filter(call => call.type === 'NATIVE_FORM_SUBMIT').at(-1).payload.values.topics.join(',') === 'news,events'
    && calls.filter(call => call.type === 'NATIVE_FORM_SUBMIT').at(-1).payload.values.region === 'south'
    && calls.filter(call => call.type === 'NATIVE_FORM_SUBMIT').at(-1).payload.values.rating === 4,
  'Native form submissions atomically send choices, dropdown and rating values');
  document.querySelector('[data-native-live-form]').click();
  await flush();
  check(document.querySelector('.live-action-wizard [name=name]').value === 'Lucas',
    'Reopening a native form restores the member editable response');
  check(!document.querySelector('.live-action-wizard [data-native-form-results]')
    && !document.querySelector('.live-action-wizard [data-native-form-close]'),
  'Native form details keep results and end controls out of the response footer');
  const resultsApi = window.api;
  let savedCsv = null;
  window.api = { ...(resultsApi ?? {}), saveCsvFile: async (content, fileName) => {
    savedCsv = { content, fileName };
    return { success: true };
  } };
  document.querySelector('.live-action-wizard [data-community-close]').click();
  await flush();
  document.querySelector('[data-live-action-menu=form]').click();
  const formMenuItems = [...document.querySelectorAll('[role=menuitem]')];
  check(formMenuItems.length === 2
    && formMenuItems.some(item => item.textContent.includes(t('liveForm.viewResults', { count: nativeForm.responseCount })))
    && formMenuItems.some(item => item.textContent.includes(t('community.closeLiveAction'))),
  'Native form cards group results and end controls in the ellipsis menu');
  formMenuItems.find(item => item.textContent.includes(t('liveForm.viewResults', { count: nativeForm.responseCount }))).click();
  await flush();
  const resultsModal = document.querySelector('.native-live-form-results-modal');
  check(resultsModal?.querySelector('[data-native-form-results-tab=summary][aria-selected=true]')
    && resultsModal.querySelectorAll('.native-form-result-question').length === nativeForm.form.fields.length
    && resultsModal.querySelectorAll('.native-form-result-donut').length === 3
    && resultsModal.querySelectorAll('.native-form-result-bars').length === 3
    && resultsModal.querySelector('[data-native-form-results-tab=summary]')
    && [...resultsModal.querySelectorAll('.native-form-result-question')].find(card =>
      card.querySelector('h3')?.textContent === nativeForm.form.fields.find(field => field.type === 'rating').label)
      ?.querySelector('.native-form-result-bar:last-child')?.classList.contains('rating-color-5'),
  'Native-form results open with applicable donut and bar charts in the Google Forms-style summary');
  check(parseFloat(getComputedStyle(resultsModal).paddingLeft) >= 32
    && parseFloat(getComputedStyle(resultsModal).paddingRight) >= 32,
  'Native form results preserve the same expanded lateral spacing');
  const lazyTextAnswers = resultsModal.querySelector('[data-native-summary-text="0"]');
  check(lazyTextAnswers.querySelectorAll('li:not(.native-form-more-answers)').length === 20
    && lazyTextAnswers.scrollHeight > lazyTextAnswers.clientHeight,
  'Text summaries start with one internally scrollable batch');
  lazyTextAnswers.scrollTop = lazyTextAnswers.scrollHeight;
  lazyTextAnswers.dispatchEvent(new Event('scroll'));
  check(lazyTextAnswers.querySelectorAll('li:not(.native-form-more-answers)').length === 40,
    'Scrolling a text summary lazily appends the next answer batch');
  resultsModal.querySelector('[data-native-form-results-tab=question]').click();
  check(resultsModal.querySelector('[data-native-form-results-tab=question][aria-selected=true]')
    && resultsModal.querySelectorAll('.native-form-result-question').length === 0
    && resultsModal.querySelector('.native-form-question-answers > header h3')?.textContent === 'Name'
    && resultsModal.querySelectorAll('.native-form-question-answer').length === 20
    && resultsModal.querySelector('[data-native-form-question-page-next]'),
  'Text questions render only one paginated clickable answer list without duplicated summary content');
  resultsModal.querySelector('[data-native-form-answer-group="0"]').click();
  const anonymousIndividualState = {
    tab: !!resultsModal.querySelector('[data-native-form-results-tab=individual][aria-selected=true]'),
    label: resultsModal.textContent.includes(locale === 'pt-BR' ? 'Resposta 1' : 'Response 1'),
    readonly: !!resultsModal.querySelector('.native-form-fields--readonly'),
    disabled: !!resultsModal.querySelector('[data-field-name=team] [data-bot-select-value=a]')?.disabled,
    choice: resultsModal.querySelector('[data-field-name=team] [data-bot-select-value=a]')?.getAttribute('aria-pressed') === 'true',
    rating: !!resultsModal.querySelector('[data-rating-value="1"][aria-pressed=true]'),
    private: !resultsModal.textContent.includes('QA Member'),
  };
  check(Object.values(anonymousIndividualState).every(Boolean),
    `A unique answer opens its anonymous read-only individual response without identity or timestamp: ${JSON.stringify(anonymousIndividualState)}`);
  resultsModal.querySelector('[data-native-form-results-tab=question]').click();
  resultsModal.querySelector('[data-native-form-answer-group="1"]').click();
  const repeatedTextResponses = resultsModal.querySelector('[data-native-form-answer-target]');
  check(repeatedTextResponses?.options.length === 4,
    'Repeated text answers open a dropdown containing every matching response');
  repeatedTextResponses.value = '2';
  repeatedTextResponses.dispatchEvent(new Event('change', { bubbles: true }));
  check(resultsModal.querySelector('[data-native-form-results-tab=individual][aria-selected=true]')
    && resultsModal.textContent.includes(locale === 'pt-BR' ? 'Resposta 3' : 'Response 3'),
  'Choosing a repeated text answer redirects to the selected individual response');
  resultsModal.querySelector('[data-native-form-results-tab=question]').click();
  for (let index = 0; index < 4; index++) {
    resultsModal.querySelector('[data-native-form-question-next]').click();
  }
  resultsModal.querySelector('[data-native-form-answer-group="0"]').click();
  const duplicateResponses = resultsModal.querySelector('[data-native-form-answer-target]');
  check(duplicateResponses?.options.length === 51,
    'Repeated answers open a dropdown listing every matching anonymous response');
  duplicateResponses.value = '2';
  duplicateResponses.dispatchEvent(new Event('change', { bubbles: true }));
  check(resultsModal.querySelector('[data-native-form-results-tab=individual][aria-selected=true]')
    && resultsModal.textContent.includes(locale === 'pt-BR' ? 'Resposta 3' : 'Response 3'),
  'Choosing a repeated answer redirects to the selected individual response');
  resultsModal.querySelector('[data-native-form-export]').click();
  await flush();
  check(savedCsv?.content.startsWith('\uFEFF')
    && savedCsv.content.includes('"Team A"')
    && savedCsv.content.includes('"News, Events"')
    && savedCsv.content.includes('"\'=1+1"')
    && !savedCsv.content.includes('QA Member')
    && !savedCsv.content.match(/\d{4}-\d{2}-\d{2}T/)
    && savedCsv.fileName.endsWith('.csv'),
  'Anonymous CSV includes all answers but no respondent identity or timestamp');
  document.querySelector('.native-live-form-results-modal [data-community-close]').click();
  await flush();
  if (resultsApi === undefined) delete window.api; else window.api = resultsApi;
  document.querySelector('[data-live-action-menu=form]').click();
  [...document.querySelectorAll('[role=menuitem]')]
    .find(item => item.textContent.includes(t('community.closeLiveAction'))).click();
  await flush();
  document.querySelector('[data-action=confirm]').click();
  await flush();
  check(calls.filter(call => call.type === 'NATIVE_FORM_CLOSE').at(-1).payload.id === nativeForm.id,
    'Native forms can be ended from their card menu');
  root.querySelector('[data-community=actions]').click();
  await flush();
  document.querySelector('[data-live-poll]').click();
  await flush();
  check(document.querySelector('.native-poll')?.textContent.includes('Native poll')
    && document.querySelector('.native-poll')?.textContent.includes('👍')
    && document.querySelectorAll('[data-native-poll-option]').length === 2,
  'Native polls open from the shared live-action list and render response emojis in the shared poll card');
  const livePollModal = document.querySelector('.live-action-detail-modal');
  const livePollContent = livePollModal.querySelector('[data-community-content]').getBoundingClientRect();
  const livePollCard = livePollModal.querySelector('.native-poll').getBoundingClientRect();
  check(livePollModal.querySelector('.modal-title').textContent === t('poll.liveAction')
    && Math.abs(livePollCard.width - livePollContent.width) <= 1
    && livePollModal.querySelectorAll('.image-carousel-dot').length === 2
    && !livePollModal.querySelector('[data-live-poll-close]'),
  'Live-action poll details fill the modal without duplicating management controls');
  document.querySelector('[data-native-poll-option=no]').click();
  check(calls.filter(call => call.type === 'POLL_VOTE').length === 0
    && !document.querySelector('[data-native-poll-confirm]').disabled,
  'Multiple answers are staged locally until the person confirms the set');
  document.querySelector('[data-native-poll-confirm]').click();
  await flush();
  check(calls.filter(call => call.type === 'POLL_VOTE').at(-1).payload.optionIds.join(',') === 'yes,no'
    && document.querySelector('[data-native-poll-option=no]').classList.contains('native-poll-option--selected'),
  'A live-action vote atomically sends every selected answer and renders the personalized response');
  document.querySelector('.live-action-detail-modal [data-community-close]').click();
  await flush();
  const wizard = openNativePollWizard(client, server, 'text');
  check(wizard && document.querySelectorAll('[data-poll-option]').length === 2
    && document.querySelectorAll('[data-poll-stepper]').length === 3
    && document.querySelector('[data-poll-multiple][role=switch]'),
  'The native poll wizard starts with two answers, multiple-choice switch and three stable steps');
  const pollStepper = document.querySelector('.native-poll-stepper');
  const pollStepBoxes = [...pollStepper.children].map(item => item.getBoundingClientRect());
  check(pollStepper.tagName === 'NAV' && getComputedStyle(pollStepper).display === 'grid'
    && pollStepBoxes[1].left >= pollStepBoxes[0].right
    && pollStepBoxes[2].left >= pollStepBoxes[1].right,
  'Poll steps use the themed three-column wizard indicator without native list markers');
  check(getComputedStyle(document.querySelector('.native-poll-option-row')).gridTemplateColumns.split(' ').length === 3
    && getComputedStyle(document.querySelector('[data-add-poll-option]')).justifySelf === 'end',
  'Poll answers keep emoji, text and removal in one compact row with the add action aligned at the end');
  const firstEmojiButton = document.querySelector('[data-poll-emoji="0"]');
  firstEmojiButton.click();
  yield 'native-poll-emoji-picker';
  const pollEmojiPicker = document.querySelector('body > .emoji-picker:not([data-ui-closing])');
  check(pollEmojiPicker && pollEmojiPicker.querySelector('[data-emoji]'),
    'Each poll answer opens the shared portaled emoji picker');
  const selectedPollEmoji = pollEmojiPicker.querySelector('[data-emoji]').dataset.emoji;
  pollEmojiPicker.querySelector('[data-emoji]').click();
  check(firstEmojiButton.textContent.includes(selectedPollEmoji)
    && firstEmojiButton.classList.contains('native-poll-option-emoji-button--selected'),
  'Selecting an emoji updates the compact answer row');
  firstEmojiButton.click();
  yield 'native-poll-emoji-menu';
  check([...document.querySelectorAll('.floating-context-menu:not([data-ui-closing]) button')]
    .some(button => button.textContent.includes(t('poll.removeEmoji'))),
  'A selected answer emoji exposes replace and remove actions');
  document.querySelector('.floating-context-menu:not([data-ui-closing]) .danger').click();
  check(!firstEmojiButton.classList.contains('native-poll-option-emoji-button--selected'),
    'An answer emoji can be removed without changing its text');
  await flush();
  firstEmojiButton.click();
  const replacementPicker = document.querySelector('body > .emoji-picker:not([data-ui-closing])');
  check(replacementPicker, 'The emoji picker can be reopened after removing an answer emoji');
  const replacementEmoji = replacementPicker.querySelector('[data-emoji]');
  check(replacementEmoji, `The reopened emoji picker renders its catalog: ${replacementPicker.innerHTML.slice(0, 200)}`);
  replacementEmoji.click();
  for (const [selector, value] of [
    ['[data-poll-question]', locale === 'pt-BR' ? 'Qual opção você prefere?' : 'Which option do you prefer?'],
    ['[data-poll-option][data-option-index="0"]', locale === 'pt-BR' ? 'Primeira resposta' : 'First answer'],
    ['[data-poll-option][data-option-index="1"]', locale === 'pt-BR' ? 'Segunda resposta' : 'Second answer'],
  ]) {
    const field = document.querySelector(selector);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  yield 'native-poll-wizard';
  const input = (selector, value) => {
    const node = document.querySelector(selector);
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  input('[data-poll-question]', 'Which option?');
  input('[data-poll-option][data-option-index="0"]', 'First');
  input('[data-poll-option][data-option-index="1"]', 'First');
  check(document.querySelector('[data-poll-next]').disabled, 'Duplicate poll options cannot advance');
  input('[data-poll-option][data-option-index="1"]', 'Second');
  document.querySelector('[data-add-poll-option]').click();
  check(document.querySelectorAll('[data-poll-option]').length === 3
    && document.activeElement.matches('[data-option-index="2"]'),
  'Poll options can be added without losing the draft or focus');
  input('[data-poll-option][data-option-index="2"]', 'Third');
  const multiple = document.querySelector('[data-poll-multiple]');
  multiple.checked = true;
  multiple.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('[data-poll-next]').click();
  check(document.querySelectorAll('.native-poll-number-control > button').length === 4
    && getComputedStyle(document.querySelector('[data-poll-duration]')).appearance === 'textfield'
    && document.querySelector('[data-carousel-dropzone]')
    && getComputedStyle(document.querySelector('[data-carousel-dropzone]')).cursor === 'pointer',
  'The appearance step has themed limits and a clickable multi-image drop zone');
  const pollSettingTops = [...document.querySelectorAll('.native-poll-settings-grid > label')]
    .map(label => label.lastElementChild.getBoundingClientRect().top);
  check(Math.max(...pollSettingTops) - Math.min(...pollSettingTops) <= 1,
    'Duration, unit and voter-limit controls share the same vertical position');
  const imageApi = window.api;
  window.api = { ...(imageApi ?? {}), selectImagesDialog: async maxFiles =>
    Array.from({ length: Math.min(2, maxFiles) }, (_, index) => ({
      fileName: `poll-${index}.png`, mimeType: 'image/png',
      base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    })) };
  document.querySelector('[data-carousel-dropzone]').click();
  const activeCrop = selector => document.querySelector('.modal-backdrop:not([data-ui-closing]) .crop-modal-card')?.querySelector(selector);
  await until(() => activeCrop('[data-action=confirm]')?.disabled === false);
  const pollBatchModal = document.querySelector('.modal-backdrop:not([data-ui-closing]) .crop-modal-card');
  const firstPollZoom = activeCrop('.crop-zoom-slider');
  firstPollZoom.value = '1.5';
  firstPollZoom.dispatchEvent(new Event('input'));
  activeCrop('[data-action=confirm]').click();
  await until(() => activeCrop('.crop-counter')?.textContent.includes('2'));
  check(document.querySelector('.modal-backdrop:not([data-ui-closing]) .crop-modal-card') === pollBatchModal,
    'Selecting multiple poll images keeps one crop modal open while advancing to the next image');
  await until(() => activeCrop('[data-action=previous]')?.disabled === false);
  activeCrop('[data-action=previous]').click();
  await until(() => activeCrop('.crop-counter')?.textContent.includes('1')
    && activeCrop('.crop-zoom-slider')?.value === '1.5');
  check(activeCrop('.crop-zoom-slider').value === '1.5',
    'Returning to an earlier image preserves its crop adjustment in the batch session');
  activeCrop('[data-action=confirm]').click();
  await until(() => activeCrop('.crop-counter')?.textContent.includes('2')
    && activeCrop('[data-action=confirm]')?.disabled === false);
  activeCrop('[data-action=confirm]').click();
  await flush();
  await until(() => document.querySelectorAll('.native-poll-image-editor .image-carousel-slide').length === 2);
  if (imageApi === undefined) delete window.api; else window.api = imageApi;
  const pollCarousel = document.querySelector('.native-poll-image-editor [data-image-carousel]');
  check(pollCarousel.dataset.carouselIndex === '1'
    && pollCarousel.querySelectorAll('.image-carousel-dot').length === 2
    && !pollCarousel.querySelector('[data-carousel-edit="back"]').disabled,
  'Selecting multiple images at once opens the large carousel on the latest image');
  await until(() => !pollCarousel.closest('.modal-backdrop').inert);
  const reorderButton = pollCarousel.querySelector('[data-carousel-edit="back"]');
  reorderButton.click();
  const reorderedCarousel = document.querySelector('.native-poll-image-editor [data-image-carousel]');
  check(document.querySelectorAll('.native-poll-image-editor .image-carousel-slide').length === 2
    && reorderedCarousel.dataset.carouselIndex === '0',
  'The overlay reorder control moves the visible image and keeps it active');
  document.querySelector('.native-poll-image-editor [data-carousel-edit="remove"]').click();
  check(document.querySelectorAll('.native-poll-image-editor .image-carousel-slide').length === 1,
    'The overlay delete control removes the visible image');
  document.querySelector('.native-poll-image-editor [data-carousel-edit="remove"]').click();
  const pollDropzone = document.querySelector('[data-carousel-dropzone]');
  const transfer = new DataTransfer();
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), char => char.charCodeAt(0));
  transfer.items.add(new File([png], 'dropped-first.png', { type: 'image/png' }));
  transfer.items.add(new File([png], 'dropped-second.png', { type: 'image/png' }));
  const dragover = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
  pollDropzone.dispatchEvent(dragover);
  check(dragover.defaultPrevented && pollDropzone.classList.contains('is-dragging'),
    'Dragging images over the empty editor prevents browser navigation and highlights the drop zone');
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
  pollDropzone.dispatchEvent(drop);
  check(drop.defaultPrevented && !pollDropzone.classList.contains('is-dragging'),
    'Dropping multiple files starts the image flow and clears the drag state');
  for (let index = 0; index < 2; index++) {
    await until(() => activeCrop('[data-action=confirm]')?.disabled === false);
    activeCrop('[data-action=confirm]').click();
    if (index === 0) {
      await until(() => activeCrop('.crop-counter')?.textContent.includes('2')
        && activeCrop('[data-action=previous]')?.disabled === false);
      check(!!activeCrop('[data-action=previous]') && !activeCrop('[data-action=previous]').disabled,
        'Dropped images are adjusted in one crop modal with backward navigation');
    }
    await flush();
  }
  await until(() => document.querySelectorAll('.native-poll-image-editor .image-carousel-slide').length === 2);
  check(document.querySelectorAll('.native-poll-image-editor .image-carousel-dot').length === 2,
    'Dropping multiple images crops and adds every supported file to the carousel');
  document.querySelector('[data-poll-duration]').closest('.native-poll-number-control')
    .querySelector('[data-poll-number-step="1"]').click();
  check(document.querySelector('[data-poll-duration]').value === '25',
    'The custom duration increment control updates the numeric value');
  input('[data-poll-duration]', '');
  input('[data-poll-limit]', '2');
  const liveSwitch = document.querySelector('[data-poll-live]');
  liveSwitch.checked = true;
  liveSwitch.dispatchEvent(new Event('change', { bubbles: true }));
  const pollPrivate = document.querySelector('[data-resource-audience=poll-audience] [data-audience-private]');
  pollPrivate.checked = true;
  pollPrivate.dispatchEvent(new Event('change', { bubbles: true }));
  const pollAudience = document.querySelector('[data-resource-audience=poll-audience]');
  check(pollAudience.querySelector('[data-audience-toggle]').getAttribute('aria-expanded') === 'false'
    && pollAudience.querySelector('[data-audience-popup]').hidden,
  'Enabling private poll visibility reveals the audience field without opening its dropdown');
  await settleScroll(document.querySelector('[data-poll-step-viewport]'));
  pollAudience.querySelector('[data-audience-toggle]').click();
  const liveRowBox = document.querySelector('.native-poll-live-row').getBoundingClientRect();
  const audienceBox = pollAudience.getBoundingClientRect();
  const audienceLabelBox = pollAudience.querySelector('.share-audience-label').getBoundingClientRect();
  const audienceTriggerBox = pollAudience.querySelector('[data-audience-toggle]').getBoundingClientRect();
  const audiencePopupBox = pollAudience.querySelector('[data-audience-popup]').getBoundingClientRect();
  check(audienceBox.top - liveRowBox.bottom <= 1,
    'Consecutive Live Action and private-audience rows do not accumulate redundant vertical spacing');
  check(audienceTriggerBox.top - audienceLabelBox.bottom >= 8,
    'The private-audience label keeps a readable gap before its field');
  check(audiencePopupBox.top >= 12 && audiencePopupBox.bottom <= innerHeight - 12
    && (audiencePopupBox.top >= audienceTriggerBox.bottom + 7
      || audiencePopupBox.bottom <= audienceTriggerBox.top - 7),
  'The private-audience dropdown chooses a visible side of its field');
  const pollModal = pollAudience.closest('.community-modal');
  const openAudienceScrollHeight = pollModal.scrollHeight;
  pollAudience.querySelector('[data-audience-toggle]').click();
  const closedAudienceScrollHeight = pollModal.scrollHeight;
  check(openAudienceScrollHeight <= closedAudienceScrollHeight + 1,
    'Opening the private-audience dropdown does not increase the modal scroll area');
  pollAudience.querySelector('[data-audience-toggle]').click();
  check(document.querySelector('[data-poll-next]').disabled,
    'Private polls cannot advance with an empty audience');
  const audienceSearch = document.querySelector('[data-resource-audience=poll-audience] [data-audience-search]');
  const audienceSearchRow = audienceSearch.closest('.share-audience-search');
  audienceSearch.blur();
  const unfocusedSeparator = getComputedStyle(audienceSearchRow).borderBottomColor;
  audienceSearch.focus({ preventScroll: true });
  check(audienceSearchRow.matches(':focus-within')
    && getComputedStyle(audienceSearchRow).borderBottomColor === unfocusedSeparator,
  'Focusing audience search keeps its separator neutral instead of adding a second accent highlight');
  audienceSearch.value = 'missing member or role';
  audienceSearch.dispatchEvent(new Event('input', { bubbles: true }));
  const audienceEmpty = pollAudience.querySelector('[data-audience-no-results]');
  const audienceEmptyStyle = getComputedStyle(audienceEmpty);
  check(!audienceEmpty.hidden && audienceEmpty.textContent === t('audience.noResults')
    && parseFloat(audienceEmptyStyle.fontSize) <= 14
    && parseFloat(audienceEmptyStyle.paddingTop) >= 12
    && parseFloat(audienceEmptyStyle.paddingBottom) >= 12
    && audienceEmptyStyle.textAlign === 'center'
    && audienceEmptyStyle.marginTop === '0px',
  'An empty audience search has compact localized text, centered alignment and breathing room');
  yield 'audience-search-clear';
  check(audienceSearch.value === '' && audienceEmpty.hidden
    && !pollAudience.querySelector('[data-audience-popup]').hidden
    && [...pollAudience.querySelectorAll('[data-audience-id]')].every(option => !option.hidden)
    && document.activeElement === audienceSearch,
  `Clicking the real search clear button restores roles and members without closing the dropdown or losing focus: ${JSON.stringify({
    value: audienceSearch.value, empty: audienceEmpty.hidden,
    popup: pollAudience.querySelector('[data-audience-popup]').hidden,
    options: [...pollAudience.querySelectorAll('[data-audience-id]')].map(option => option.hidden),
    focus: document.activeElement?.outerHTML,
  })}`);
  audienceSearch.value = 'team';
  audienceSearch.dispatchEvent(new Event('input', { bubbles: true }));
  check(!document.querySelector('[data-resource-audience=poll-audience] [data-audience-kind=role]').hidden
    && document.querySelector('[data-resource-audience=poll-audience] [data-audience-kind=user]').hidden,
  'Audience search filters roles and members without losing checked state');
  document.querySelector('[data-resource-audience=poll-audience] [data-audience-kind=role]').click();
  check(!document.querySelector('[data-poll-next]').disabled,
    'A voter limit can replace duration and a selected private audience satisfies publication');
  document.querySelector('[data-poll-next]').click();
  check(document.querySelector('.native-poll-preview-surface .native-poll')
    && document.querySelector('.native-poll-preview-surface').textContent.includes(t('poll.multipleAllowed')),
  'The final step previews the poll and its multiple-answer behavior');
  const pollPreviewCard = document.querySelector('.native-poll-preview-surface .native-poll').getBoundingClientRect();
  const pollPreviewImage = document.querySelector('.native-poll-preview-surface .image-carousel').getBoundingClientRect();
  check(Math.abs(pollPreviewImage.left - pollPreviewCard.left) <= 3
    && Math.abs(pollPreviewImage.right - pollPreviewCard.right) <= 3,
  'Poll preview images fill the card from edge to edge');
  document.querySelector('[data-poll-submit]').click();
  await flush();
  const creation = calls.filter(call => call.type === 'POLL_CREATE').at(-1);
  check(creation.payload.maxVoters === 2 && creation.payload.durationMinutes === undefined
    && creation.payload.liveAction && creation.payload.allowMultiple && creation.payload.options.length === 3
    && creation.payload.imageAssetRefs.length === 2
    && creation.payload.audience.visibility === 'private'
    && creation.payload.audience.roleIds[0] === 'audience-role'
    && creation.payload.options[0].emoji
    && creation.payload.options[0].label === 'First',
  'The poll wizard sends response labels and emojis in one native resource with the selected limits and live-action projection');
  let permissionChecks = 0;
  const restrictedServer = {
    ...server,
    hasPermission: () => permissionChecks++ === 0,
  };
  const restrictedWizard = openNativePollWizard(client, restrictedServer, 'text');
  input('[data-poll-question]', 'Restricted poll');
  input('[data-poll-option][data-option-index="0"]', 'Yes');
  input('[data-poll-option][data-option-index="1"]', 'No');
  document.querySelector('[data-poll-next]').click();
  check(restrictedWizard && document.querySelector('[data-poll-live]').disabled
    && restrictedWizard.element.textContent.includes(t('poll.liveActionPermission')),
  'The live-action switch remains visible with an explanation when permission is missing');
  restrictedWizard.close(true);
  server.communityEventsEnabled = false;
  const disabledLiveWizard = openNativePollWizard(client, server, 'text');
  input('[data-poll-question]', 'Ordinary poll');
  input('[data-poll-option][data-option-index="0"]', 'Yes');
  input('[data-poll-option][data-option-index="1"]', 'No');
  document.querySelector('[data-poll-next]').click();
  check(disabledLiveWizard && document.querySelector('[data-poll-live]').disabled
    && !document.querySelector('[data-poll-live]').checked
    && disabledLiveWizard.element.textContent.includes(t('poll.liveActionsDisabled')),
  'The live-action switch is unavailable with the exact reason when server activities are disabled');
  disabledLiveWizard.close(true);
  server.communityEventsEnabled = true;
  view.destroy();
  await flush();
  check(!document.querySelector('.community-modal'), 'All activity dialogs close on teardown');
  const openedTextChannels = [];
  const restored = new ServerCommunityView(root, feed, async () => {}, undefined, channelId => openedTextChannels.push(channelId));
  check(!root.textContent.includes(event.title), 'Banner dismissal persists for the occurrence');
  root.querySelector('[data-community=events]').click();
  for (let index = 0; index < 40; index++) {
    const id = `scroll-audience-${index}`;
    server.knownMembers.set(id, { id, nickname: `Scroll Member ${index}`, avatarUrl: null, status: 'DISCONNECTED' });
  }
  document.querySelector('[data-create-event]').click();
  const eventListBackdrop = document.querySelector('.event-list-modal').closest('.modal-backdrop');
  const eventListCard = eventListBackdrop.querySelector('.modal-card');
  check(eventListBackdrop.inert && (eventListBackdrop.hidden || eventListCard.hidden || eventListCard.hasAttribute('data-ui-closing')),
    'Opening the wizard immediately suspends the outgoing event list');
  await flush();
  check(eventListBackdrop.hidden || eventListCard.hidden, 'The parent event list is hidden when the modal transition finishes');
  yield 'event-location';
  check(!document.querySelector('[data-action=next]').disabled, 'Wizard keeps Next actionable so validation can explain missing data');
  document.querySelector('[data-action=next]').click();
  check(document.querySelector('.chat-copy-toast--danger')?.textContent.includes(t('community.locationRequired'))
    && document.querySelector('.community-location-cards').getAttribute('aria-invalid') === 'true',
  'Missing location uses a danger toast and highlights the relevant control');
  const locationOptions = [...document.querySelectorAll('[data-location]')].map(node => node.getBoundingClientRect());
  check(locationOptions[1].top >= locationOptions[0].bottom, 'Location cards are stacked like the reference');
  document.querySelector('[data-location=channel]').click();
  check(!document.querySelector('[data-action=next]').disabled, 'Channel validation remains actionable before a channel is selected');
  const channelSelect = () => document.querySelector('[data-input=channel]');
  document.querySelector('[data-channel-type=text]').click();
  check([...channelSelect().options].some(option => option.value === 'text')
    && ![...channelSelect().options].some(option => option.value === 'event-thread'),
  'Event locations include real text channels but exclude forum threads');
  document.querySelector('[data-channel-type=voice]').click();
  document.querySelector('[data-action=next]').click();
  check(channelSelect().getAttribute('aria-invalid') === 'true'
    && document.querySelector('.chat-copy-toast--danger')?.textContent.includes(t('community.selectChannel')),
  'Missing channel uses a toast and highlights its selector');
  const openChannel = () => channelSelect().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const picker = () => document.querySelector('.monky-select-popup:not([data-ui-closing])');
  check(channelSelect().closest('label') === channelSelect().labels[0]
    && getComputedStyle(channelSelect()).marginTop === '6px', 'Channel label and control use the compact shared field spacing');
  for (const area of ['label', 'body']) {
    yield `event-channel-${area}`;
    check(picker() && document.activeElement === picker().querySelector('.monky-select-search'),
      `Trusted channel ${area} click opens the dropdown and focuses search`);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
  }
  yield 'event-channel-open';
  check(picker() && !document.querySelector('.event-wizard').closest('.modal-backdrop').inert,
    'The searchable channel dropdown stays inside the same active wizard');
  check(picker().querySelectorAll('[role=option][aria-disabled=false]').length === 1 && !picker().textContent.includes('Forum'),
    'Voice selection lists voice channels only, not text or forum containers');
  yield 'event-channel-picker';
  const search = picker().querySelector('.monky-select-search');
  search.value = 'missing channel';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  check(picker().querySelector('[role=status]')?.textContent === t('community.noChannels'), 'Channel search has a localized empty state');
  search.value = 'VOICE';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  check(picker().querySelectorAll('[role=option][aria-disabled=false]').length === 1,
    'Channel search filters case-insensitively');
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  check(search.getAttribute('aria-activedescendant') === picker().querySelector('[role=option][aria-disabled=false]').id, 'Search results are reachable with the keyboard');
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check(!picker() && !document.querySelector('.event-wizard').closest('.modal-backdrop').hidden &&
    document.activeElement === channelSelect(), 'Selecting a channel keeps the wizard and restores focus');
  await flush();
  yield 'event-voice';
  const wizardShell = document.querySelector('.event-wizard');
  const wizardStepper = wizardShell.querySelector('.community-steps');
  const wizardFooter = wizardShell.querySelector('.event-wizard-footer');
  check(wizardShell.classList.contains('server-event-wizard')
    && wizardShell.getBoundingClientRect().width >= 620
    && wizardShell.getBoundingClientRect().height <= 762
    && parseFloat(getComputedStyle(wizardShell).paddingLeft) >= 32
    && parseFloat(getComputedStyle(wizardShell).paddingRight) >= 32
    && parseFloat(getComputedStyle(wizardShell.querySelector('.event-step-body')).paddingLeft) >= 16
    && parseFloat(getComputedStyle(wizardShell.querySelector('.event-step-body')).paddingRight) >= 16
    && getComputedStyle(wizardShell.querySelector('.event-step-viewport')).overflowY === 'auto',
  'The event wizard keeps its fields inset from the scrolling edges while preserving its width and bounded height');
  document.querySelector('[data-action=next]').click();
  check(document.querySelector('.event-step-viewport').getAnimations({ subtree: true }).length >= 2,
    'Advancing runs the incoming and outgoing slides inside the fixed-height wizard');
  yield 'event-step-forward-motion';
  yield 'event-step-reduced-motion';
  check(!document.querySelector('.event-step-viewport').getAnimations({ subtree: true }).some(animation => animation.playState === 'running'),
    'Enabling reduced motion during a step transition immediately settles its final state');
  check(automaticScrollBehavior() === 'instant',
    'Reduced motion makes automatic scrolling settle immediately');
  check(document.querySelector('.event-wizard') === wizardShell && wizardShell.querySelector('.community-steps') === wizardStepper
    && wizardShell.querySelector('.event-wizard-footer') === wizardFooter, 'Step changes preserve the wizard shell, stepper and footer');
  yield 'event-step-motion-enabled';
  check(automaticScrollBehavior() === 'smooth',
    'Automatic scrolling resumes smooth movement when reduced motion is disabled');
  await flush();
  const dateBox = document.querySelector('[data-input=start-date]').getBoundingClientRect();
  const timeBox = document.querySelector('[data-input=start-time]').getBoundingClientRect();
  check(Math.abs(dateBox.top - timeBox.top) < 2 && timeBox.left >= dateBox.right, 'Start date and time share one row');
  const title = document.querySelector('[data-input=title]');
  title.value = 'Scheduled event';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  const eventPrivate = document.querySelector('[data-resource-audience=event-audience] [data-audience-private]');
  const eventStepBeforeAudience = document.querySelector('.event-step-viewport').scrollTop;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  let privateAudienceScroll;
  HTMLElement.prototype.scrollIntoView = function (options) {
    if (this.matches('[data-resource-audience=event-audience] [data-audience-toggle]')) {
      privateAudienceScroll = options;
    }
    return originalScrollIntoView.call(this, options);
  };
  eventPrivate.checked = true;
  eventPrivate.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  check(!document.querySelector('[data-action=next]').disabled,
    'Private audience validation leaves Next actionable');
  const eventAudienceTrigger = document.querySelector(
    '[data-resource-audience=event-audience] [data-audience-toggle]',
  );
  check(eventAudienceTrigger.getAttribute('aria-expanded') === 'false'
    && document.querySelector('[data-resource-audience=event-audience] [data-audience-popup]').hidden
    && document.querySelector('.event-step-viewport').scrollTop > eventStepBeforeAudience
    && privateAudienceScroll?.behavior === 'smooth',
  'Enabling private event visibility smoothly scrolls to its audience field without opening the dropdown');
  eventAudienceTrigger.click();
  const audiencePopupBounds = document.querySelector(
    '[data-resource-audience=event-audience] [data-audience-popup]',
  ).getBoundingClientRect();
  const eventAudienceTriggerBounds = eventAudienceTrigger.getBoundingClientRect();
  check(audiencePopupBounds.top >= eventAudienceTriggerBounds.bottom + 7
    && audiencePopupBounds.bottom <= innerHeight - 12,
    `The audience dropdown flips or shrinks to remain fully inside the viewport: ${JSON.stringify({
      top: audiencePopupBounds.top, bottom: audiencePopupBounds.bottom, innerHeight,
      triggerTop: eventAudienceTriggerBounds.top, triggerBottom: eventAudienceTriggerBounds.bottom,
      placement: document.querySelector('[data-resource-audience=event-audience] [data-audience-popup]').dataset.placement,
      inlineTop: document.querySelector('[data-resource-audience=event-audience] [data-audience-popup]').style.top,
    })}`);
  eventAudienceTrigger.click();
  eventAudienceTrigger.click();
  const reopenedAudiencePopupBounds = document.querySelector(
    '[data-resource-audience=event-audience] [data-audience-popup]',
  ).getBoundingClientRect();
  check(reopenedAudiencePopupBounds.top >= eventAudienceTrigger.getBoundingClientRect().bottom + 7
    && reopenedAudiencePopupBounds.left >= wizardShell.getBoundingClientRect().left,
  `Closing and reopening the event audience dropdown keeps it anchored below its field: ${JSON.stringify({
    popup: {
      top: reopenedAudiencePopupBounds.top,
      left: reopenedAudiencePopupBounds.left,
      bottom: reopenedAudiencePopupBounds.bottom,
    },
    trigger: eventAudienceTrigger.getBoundingClientRect().toJSON(),
    expanded: eventAudienceTrigger.getAttribute('aria-expanded'),
  })}`);
  const eventStepScroller = document.querySelector('.event-step-viewport');
  const audiencePopup = document.querySelector('[data-resource-audience=event-audience] [data-audience-popup]');
  const audienceOptions = audiencePopup.querySelector('.share-audience-options');
  check(audienceOptions.scrollHeight > audienceOptions.clientHeight
    && getComputedStyle(audienceOptions).overscrollBehaviorY === 'contain',
  'A large private audience has its own bounded scroll area without scroll chaining');
  await flush();
  await settleScroll(eventStepScroller);
  const eventScrollBeforeWheel = eventStepScroller.scrollTop;
  yield 'event-audience-wheel-down';
  await until(() => audienceOptions.scrollTop > 0 || audiencePopup.hidden);
  check(!audiencePopup.hidden && eventAudienceTrigger.getAttribute('aria-expanded') === 'true'
    && audienceOptions.scrollTop > 0 && eventStepScroller.scrollTop === eventScrollBeforeWheel,
  `A real wheel gesture scrolls the audience options without closing the dropdown or moving the modal: ${JSON.stringify({
    hidden: audiencePopup.hidden, expanded: eventAudienceTrigger.getAttribute('aria-expanded'),
    optionsScroll: audienceOptions.scrollTop, optionsHeight: audienceOptions.clientHeight,
    modalBefore: eventScrollBeforeWheel, modalAfter: eventStepScroller.scrollTop,
    popup: audiencePopup.getBoundingClientRect().toJSON(),
  })}`);
  audienceOptions.scrollTop = audienceOptions.scrollHeight;
  await flush();
  yield 'event-audience-wheel-end';
  check(!audiencePopup.hidden && eventStepScroller.scrollTop === eventScrollBeforeWheel,
    'Wheeling at the bottom of the audience list does not leak scroll into the event modal');
  audienceOptions.scrollTop = 0;
  await flush();
  yield 'event-audience-wheel-top';
  check(!audiencePopup.hidden && eventStepScroller.scrollTop === eventScrollBeforeWheel,
    'Wheeling at the top of the audience list keeps the dropdown open');
  audienceOptions.scrollTop = audienceOptions.scrollHeight;
  await flush();
  audienceOptions.querySelector('[data-audience-id=scroll-audience-9]').click();
  check(!audiencePopup.hidden
    && audienceOptions.querySelector('[data-audience-id=scroll-audience-9]').getAttribute('aria-selected') === 'true',
  'A member reached by scrolling can be selected without dismissing the audience dropdown');
  audienceOptions.querySelector('[data-audience-id=scroll-audience-9]').click();
  yield 'event-audience-wheel-modal';
  await until(() => audiencePopup.hidden && eventStepScroller.scrollTop < eventScrollBeforeWheel);
  check(eventAudienceTrigger.getAttribute('aria-expanded') === 'false'
    && audiencePopup.hidden,
  'Scrolling the event modal outside the dropdown closes the audience picker and scrolls the form');
  eventAudienceTrigger.click();
  await settleScroll(eventStepScroller);
  const eventScrollBeforeDrag = eventStepScroller.scrollTop;
  yield 'event-audience-scrollbar-modal';
  check(audiencePopup.hidden && eventAudienceTrigger.getAttribute('aria-expanded') === 'false'
    && eventStepScroller.scrollTop < eventScrollBeforeDrag - 30,
  `Dragging the native modal scrollbar dismisses the audience picker: ${JSON.stringify({
    hidden: audiencePopup.hidden, before: eventScrollBeforeDrag, after: eventStepScroller.scrollTop,
  })}`);
  const eventScrollAfterDrag = eventStepScroller.scrollTop;
  await new Promise(resolve => setTimeout(resolve, 650));
  check(Math.abs(eventStepScroller.scrollTop - eventScrollAfterDrag) <= 1 && audiencePopup.hidden,
    'Automatic audience positioning never scrolls back after a manual scrollbar drag');
  const audienceScrollSpace = document.createElement('div');
  audienceScrollSpace.style.height = '360px';
  eventStepScroller.append(audienceScrollSpace);
  eventStepScroller.scrollTop += eventAudienceTrigger.getBoundingClientRect().bottom
    - (eventStepScroller.getBoundingClientRect().bottom - 20);
  await settleScroll(eventStepScroller);
  eventAudienceTrigger.click();
  yield 'event-audience-scrollbar-modal';
  check(audiencePopup.hidden && eventAudienceTrigger.getAttribute('aria-expanded') === 'false',
    'A scrollbar drag also dismisses the audience picker while its opening scroll is in progress');
  const interruptedAudienceScroll = eventStepScroller.scrollTop;
  await new Promise(resolve => setTimeout(resolve, 650));
  check(Math.abs(eventStepScroller.scrollTop - interruptedAudienceScroll) <= 1,
    'Interrupting the opening scroll cancels its animation and pending reposition timer');
  audienceScrollSpace.remove();
  for (let index = 0; index < 40; index++) server.knownMembers.delete(`scroll-audience-${index}`);
  eventAudienceTrigger.click();
  document.querySelector('[data-action=next]').click();
  check(document.querySelector('[data-audience-toggle]').getAttribute('aria-invalid') === 'true'
    && document.querySelector('.chat-copy-toast--danger')?.textContent.includes(t('audience.empty'))
    && getComputedStyle(document.querySelector('[data-audience-toggle]')).outlineOffset === '-2px',
  'An empty private audience uses a toast and highlights its picker');
  check(!document.querySelector('[data-date-error]')
    && !document.querySelector('.event-wizard [data-community-error]:not([hidden])'),
  'Incomplete event details do not print an inline red error while the user is still editing');
  document.querySelector('[data-resource-audience=event-audience] [data-audience-kind=role]').click();
  check(!document.querySelector('[data-action=next]').disabled
    && document.querySelector('[data-resource-audience=event-audience] .share-audience-chip'),
  'Event creation reuses the audience picker and restores validity after a role is selected');
  check(document.querySelector('[data-carousel-dropzone]')
    && getComputedStyle(document.querySelector('[data-carousel-dropzone]')).cursor === 'pointer',
  'Event media starts as the same clickable multi-image drop zone');
  const eventImageApi = window.api;
  let resolveEventImages;
  let eventPickerCalls = 0;
  window.api = { ...(eventImageApi ?? {}), selectImagesDialog: maxFiles => new Promise(resolve => {
    eventPickerCalls++;
    resolveEventImages = () => resolve(Array.from({ length: Math.min(2, maxFiles) }, (_, index) => ({
      fileName: `event-${index}.png`, mimeType: 'image/png',
      base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    })));
  }) };
  const eventImageTrigger = document.querySelector('[data-carousel-dropzone]');
  eventImageTrigger.click();
  eventImageTrigger.click();
  check(eventImageTrigger.disabled && eventImageTrigger.dataset.loading === '1'
    && eventImageTrigger.getAttribute('aria-busy') === 'true' && eventPickerCalls === 1,
  'The event image trigger shows loading and blocks duplicate native picker requests');
  resolveEventImages();
  await until(() => activeCrop('[data-action=confirm]')?.disabled === false);
  const eventBatchModal = document.querySelector('.modal-backdrop:not([data-ui-closing]) .crop-modal-card');
  for (let index = 0; index < 2; index++) {
    await until(() => activeCrop('[data-action=confirm]')?.disabled === false);
    activeCrop('[data-action=confirm]').click();
    if (index === 0) {
      await until(() => activeCrop('.crop-counter')?.textContent.includes('2'));
      check(document.querySelector('.modal-backdrop:not([data-ui-closing]) .crop-modal-card') === eventBatchModal,
        'Selecting multiple event images advances inside one crop modal instead of reopening it');
    }
    await flush();
  }
  await until(() => document.querySelectorAll('.event-cover-field .image-carousel-slide').length === 2);
  if (eventImageApi === undefined) delete window.api; else window.api = eventImageApi;
  check(document.querySelectorAll('.event-cover-field .image-carousel-dot').length === 2,
    'Selecting multiple event images opens the shared reorderable carousel');
  const eventAdjust = document.querySelector('.event-cover-field [data-carousel-edit=adjust]');
  check(!!eventAdjust, 'Event image editor exposes a later framing adjustment for the active image');
  eventAdjust.click();
  await until(() => activeCrop('[data-action=confirm]')?.disabled === false);
  check(document.querySelectorAll('.modal-backdrop:not([data-ui-closing]) .crop-modal-card').length === 1,
    'Readjusting an event image opens one crop surface over the existing wizard');
  activeCrop('[data-action=confirm]').click();
  await until(() => !document.querySelector('.crop-modal-card'));
  check(document.querySelectorAll('.event-cover-field .image-carousel-slide').length === 2,
    'Applying a later event-image adjustment returns to the same event draft');
  yield 'event-frequency-dropdown';
  check(!!document.querySelector('.monky-select-popup:popover-open'), 'Trusted pointer opens frequency dropdown inside the actual event wizard');
  document.querySelector('[data-input=repeat]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(!picker() && !!document.querySelector('.event-wizard'), 'Escape closes only the frequency dropdown, not its wizard');
  await flush();
  const timeInput = document.querySelector('[data-input=start-time]');
  yield 'event-time-dropdown';
  check(document.querySelectorAll('.time-popup:not([data-ui-closing]) [role=option]').length === 96,
    'Time dropdown offers every quarter hour using themed options');
  check(timeInput.readOnly && timeInput.dataset.pickerOnly === '' && getComputedStyle(timeInput).cursor === 'pointer',
    'Event time is picker-only and communicates pointer interaction');
  timeInput.value = '17:07';
  timeInput.dispatchEvent(new Event('input', { bubbles: true }));
  timeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  check(document.activeElement.dataset.value === '17:15', 'Keyboard navigation starts near the canonical value without making the field editable');
  timeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const dateInput = document.querySelector('[data-input=start-date]');
  yield 'event-date-dropdown';
  const calendar = document.querySelector('.calendar-popup:not([data-ui-closing])');
  check(calendar?.querySelectorAll('[role=gridcell]').length === 42, 'The themed calendar renders six complete accessible weeks');
  const calendarBounds = calendar.getBoundingClientRect();
  check(calendarBounds.top >= 8 && calendarBounds.bottom <= document.documentElement.clientHeight - 8
    && calendar.scrollHeight <= calendar.clientHeight + 1,
  'Event calendar chooses an unclipped side of the field and keeps all controls visible');
  check(dateInput.readOnly && dateInput.dataset.pickerOnly === '' && getComputedStyle(dateInput).cursor === 'pointer',
    'Event date is picker-only and the whole field is visibly interactive');
  check(!CSS.supports('selector(:open)') || !dateInput.matches(':open'),
    'Trusted calendar click does not open the native Chromium date picker');
  check(getComputedStyle(calendar).backgroundColor === getComputedStyle(document.querySelector('.modal-card')).backgroundColor,
    'Calendar uses the app panel color rather than a white native popup');
  const tomorrow = [...calendar.querySelectorAll('[role=gridcell]')].find(button => button.dataset.value > dateInput.dataset.dateValue && !button.disabled);
  const chosenDate = tomorrow.dataset.value;
  tomorrow.click();
  check(dateInput.dataset.dateValue === chosenDate && dateInput.value !== chosenDate && document.activeElement === dateInput,
    'Calendar commits a canonical date, presents it in the app language and restores field focus');
  await flush();
  dateInput.min = chosenDate;
  dateInput.max = chosenDate;
  dateInput.click();
  const boundedCalendar = document.querySelector('.date-time-popup:not([data-ui-closing])');
  check(boundedCalendar.querySelectorAll('[role=gridcell]:not(:disabled)').length === 1,
    'Calendar enforces both inclusive date boundaries');
  const onlyDay = boundedCalendar.querySelector('[role=gridcell]:not(:disabled)');
  onlyDay.focus();
  onlyDay.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  check(document.activeElement === onlyDay, 'Calendar keyboard navigation cannot cross the maximum date');
  onlyDay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  dateInput.removeAttribute('min');
  dateInput.removeAttribute('max');
  await flush();
  const endDate = document.querySelector('[data-input=end-date]');
  const endTime = document.querySelector('[data-input=end-time]');
  check(endDate.required && endTime.required
    && endDate.closest('.event-date-time').previousElementSibling.contains(dateInput),
  'Required end date and time sit immediately below the required start fields');
  endDate.dataset.dateValue = chosenDate;
  endDate.value = dateInput.value;
  endDate.dispatchEvent(new Event('input', { bubbles: true }));
  endTime.value = '18:07';
  endTime.dispatchEvent(new Event('input', { bubbles: true }));
  endDate.click();
  check(!document.querySelector('.calendar-popup:not([data-ui-closing]) [data-value=""]'),
    'Required event end dates cannot be cleared');
  document.querySelector('.calendar-popup:not([data-ui-closing])')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const schedule = document.querySelector('.event-schedule-options');
  const scheduleBody = schedule.querySelector('.event-schedule-body');
  schedule.querySelector('summary').click();
  check(schedule.open && scheduleBody.getAnimations().some(animation => animation.effect.getKeyframes()[0].height === '0px'),
    'The secondary time-zone field expands with a measured height transition');
  await flush();
  check(schedule.querySelector('[data-input=zone]') && !schedule.querySelector('[data-input=end-date]'),
    'Only the time zone stays inside the secondary disclosure');
  schedule.querySelector('summary').click();
  check(schedule.open && scheduleBody.inert, 'Closing the time-zone field keeps its visual exit but disables interaction immediately');
  await flush();
  check(!schedule.open, 'Scheduling disclosure closes after its height transition');
  yield 'event-details';
  wizardShell.style.width = '320px';
  const narrowDate = document.querySelector('[data-input=start-date]').getBoundingClientRect();
  const narrowTime = document.querySelector('[data-input=start-time]').getBoundingClientRect();
  check(narrowTime.top >= narrowDate.bottom, 'Narrow event forms stack date and time instead of clipping their values');
  check(wizardShell.scrollWidth <= wizardShell.clientWidth
    && wizardFooter.scrollWidth <= wizardFooter.clientWidth, 'Narrow event fields and footer do not overflow horizontally');
  yield 'event-details-narrow';
  wizardShell.style.width = '';
  document.querySelector('[data-action=next]').click();
  await flush();
  check(document.querySelector('.community-modal:last-child') || document.querySelector('[aria-current=step]'), 'Event review is rendered');
  check(document.querySelectorAll('.event-step-body:not(.event-step-outgoing) .image-carousel-dot').length === 2,
    'The event review renders every selected image');
  yield 'event-review';
  document.querySelector('[data-action=back]').click();
  const returning = document.querySelector('.event-step-body:not(.event-step-outgoing)').getAnimations()[0];
  check(returning?.effect.getKeyframes()[0].transform === 'translateX(-100%)', 'Going back reverses the step slide direction');
  await flush();
  check(document.querySelector('[data-input=title]').value === 'Scheduled event', 'Returning to details preserves the event draft');
  document.querySelector('[data-action=next]').click();
  await flush();
  document.querySelector('[data-action=next]').click();
  await flush();
  check(calls.some(call => call.type === 'EVENT_SAVE' && call.payload.title === 'Scheduled event'
    && call.payload.imageSources.length === 2
    && call.payload.audience.visibility === 'private'
    && call.payload.audience.roleIds[0] === 'audience-role'),
  'Wizard saves the event definition, private audience and ordered image carousel');
  const savedTime = calls.find(call => call.type === 'EVENT_SAVE' && call.payload.title === 'Scheduled event').payload;
  check(new Intl.DateTimeFormat('en-GB', { timeZone: savedTime.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(savedTime.startsAt)) === '17:07', 'Saving preserves freely typed minutes through the selected timezone conversion');
  check(!eventListBackdrop.hidden && !eventListBackdrop.inert, 'Saving restores the event list');
  document.querySelector('[data-create-event]').click();
  document.querySelector('[data-location=channel]').click();
  document.querySelector('[data-channel-type=text]').click();
  openChannel();
  check(picker().querySelectorAll('[role=option][aria-disabled=false]').length === 1 && picker().textContent.includes('Text'),
    'Text selection filters out voice channels');
  picker().querySelector('[role=option][aria-disabled=false]').click();
  await flush();
  document.querySelector('[data-action=next]').click();
  await flush();
  document.querySelector('[data-input=title]').value = 'Text event';
  document.querySelector('[data-input=title]').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('[data-action=next]').click();
  await flush();
  yield 'event-text-review';
  document.querySelector('[data-action=next]').click();
  await flush();
  check(calls.some(call => call.type === 'EVENT_SAVE' && call.payload.title === 'Text event' &&
    call.payload.location.kind === 'text' && call.payload.location.channelId === 'text'), 'Text events persist a channel identity, not a free-text label');
  const { openServerEventWizard } = await import('/views/ServerEventWizard.ts');
  const editing = openServerEventWizard(feed, { ...event, location: { kind: 'text', channelId: 'text' } });
  check(editing.content.querySelector('[data-input=channel]').selectedOptions[0].textContent.includes('Text') &&
    editing.content.querySelector('[data-location=channel]').getAttribute('aria-pressed') === 'true',
    'Editing a text-channel event restores the selected channel');
  editing.close();
  await flush();
  document.querySelector('[data-create-event]').click();
  document.querySelector('[data-location=external]').click();
  const external = document.querySelector('[data-input=location]');
  check(external.placeholder === t('community.externalPlaceholder') && external.placeholder.length > 20,
    'External location has a localized example placeholder');
  yield 'event-external-placeholder';
  external.value = 'https://example.test/event';
  external.dispatchEvent(new Event('input', { bubbles: true }));
  check(!document.querySelector('[data-action=next]').disabled && !channelSelect(),
    'Somewhere else accepts a URL directly without a channel dropdown');
  yield 'event-external';
  document.querySelector('[data-action=next]').click();
  await flush();
  document.querySelector('[data-input=title]').value = 'External event';
  document.querySelector('[data-input=title]').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('[data-action=next]').click();
  await flush();
  document.querySelector('[data-action=next]').click();
  await flush();
  check(calls.some(call => call.type === 'EVENT_SAVE' && call.payload.title === 'External event' &&
    call.payload.location.kind === 'external' && call.payload.location.label === 'https://example.test/event'),
    'External URLs survive review and event creation');
  document.querySelector('[data-create-event]').click();
  document.querySelector('[data-location=channel]').click();
  openChannel();
  picker().querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(!picker() && !document.querySelector('.event-wizard').closest('.modal-backdrop').hidden, 'Escape returns from the picker to the wizard');
  await flush();
  openChannel();
  emit('message.COMMUNITY_SNAPSHOT', { ...snapshot, events: [] }, 'history-request');
  check(feed.snapshot.events.length === 1, 'Correlated history does not overwrite the live feed');
  const revokedPicker = picker();
  channelSelect().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(revokedPicker?.isConnected && revokedPicker.inert, 'A closing channel picker retains only its noninteractive visual exit');
  allowed = false;
  emit('message.ROLES_LIST', {});
  check(!document.querySelector('.community-modal'), 'Access invalidation closes event dialogs immediately');
  check(!revokedPicker.isConnected, 'Revocation also removes an owned picker whose exit animation was already running');
  allowed = true;
  await flush();
  emit('message.COMMUNITY_SNAPSHOT', { settings: { eventsEnabled: false, bannerUrl: null }, events: [], liveActions: [] });
  check(root.hidden && root.getBoundingClientRect().height === 0 && !root.querySelector('.community-toolbar'),
    'The master switch hides Events and Live Actions even from authorized creators');
  allowed = false;
  emit('message.COMMUNITY_SNAPSHOT', { settings: { eventsEnabled: false, bannerUrl: null }, events: [], liveActions: [] });
  check(root.hidden && root.getBoundingClientRect().height === 0 && !root.querySelector('.community-toolbar'),
    'Participants without management permission do not receive an empty Live Actions shortcut');
  allowed = true;
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  check(!root.hidden && root.getBoundingClientRect().height > 0, 'Community content restores its sidebar section');
  server.currentUser = { id: 'member', sessionId: 'member-session' };
  allowed = false;
  root.querySelector('[data-community=events]').click();
  const eventCard = document.querySelector('.event-list-modal [data-event-openable=true]');
  check(eventCard && !eventCard.querySelector('.community-event-footer [data-event-action=detail]')
    && getComputedStyle(eventCard).cursor === 'pointer',
  'Event cards are directly clickable without a redundant View details button');
  eventCard.querySelector('.community-event-content > p').click();
  const detail = () => document.querySelector('.event-detail-modal');
  detail().querySelector('[data-event-tab=interested]').click();
  await flush();
  check(detail().querySelectorAll('.event-interest-list li').length === 1, 'Interested tab loads actual member names');
  check(!detail().querySelector('img[onerror]'), 'Interested member names remain text');
  detail().querySelector('[data-interested-more]').click();
  await flush();
  check(detail().querySelectorAll('.event-interest-list li').length === 2 && !detail().querySelector('[data-interested-more]'), 'Interested members paginate without duplicates');
  yield 'event-interested';
  detail().querySelector('[data-event-tab=interested]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  check(detail().querySelector('[data-event-tab=details]').getAttribute('aria-selected') === 'true', 'Event tabs support keyboard navigation');
  interestedMode = 'deferred';
  detail().querySelector('[data-event-tab=interested]').click();
  const pendingMembers = calls.at(-1).requestId;
  detail().querySelector('[data-event-tab=details]').click();
  check(cancelled.includes(pendingMembers), 'Leaving interested tab cancels the pending network request');
  interestedGate({ id: event.id, users: [{ id: 'late', nickname: 'Stale member', avatarUrl: null }], nextCursor: null });
  await flush();
  check(!detail().textContent.includes('Stale member'), 'Cancelled participant replies cannot replace the active tab');
  interestedMode = 'fail';
  detail().querySelector('[data-event-tab=interested]').click();
  await flush();
  check(detail().querySelector('.event-interest-list [role=alert]'), 'Interested-list failures are explicit');
  interestedMode = 'empty';
  detail().querySelector('[data-interested-more]').click();
  await flush();
  check(detail().querySelector('.event-interest-list').textContent.includes(t('community.noInterested')), 'Interested retry reaches the localized empty state');
  const originalApi = window.api, clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let copied, copyFailure = false, calendarResult = { status: 'cancelled' }, calendarInput;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
    if (copyFailure) throw new Error('Clipboard denied');
    copied = value;
  } } });
  window.api = { ...originalApi, saveEventCalendar: async input => { calendarInput = input; return calendarResult; } };
  const chooseEventAction = key => {
    detail().querySelector('[data-event-action=menu]').click();
    const items = [...document.querySelectorAll('[role=menuitem]')];
    check(items.length === 3, 'Members can share/export and change interest but cannot access event management');
    items.find(item => item.textContent.includes(t(key))).click();
  };
  try {
    chooseEventAction('community.copyLink');
    await flush();
    const parsed = parseServerInviteLink(copied);
    check(parsed.ok && parsed.invite.eventId === event.id && parsed.invite.host === '127.0.0.1'
      && !Object.hasOwn(parsed.invite, 'password'), 'Copied links target the exact event and never include server passwords');
    check(document.querySelector('.chat-copy-toast-label')?.textContent === t('community.linkCopied')
      && !detail().querySelector('[data-event-feedback]'),
    'Successful event-link copying uses the shared transient toast instead of inline modal feedback');
    copyFailure = true;
    chooseEventAction('community.copyLink');
    await flush();
    check(detail().querySelector('[data-community-error]').textContent === t('community.copyFailed'), 'Clipboard failure is localized and visible');
    chooseEventAction('community.exportCalendar');
    await flush();
    check(calendarInput.event.id === event.id && !detail().querySelector('[data-event-feedback]'), 'Calendar cancel sends no success notice');
    calendarResult = { status: 'saved' };
    chooseEventAction('community.exportCalendar');
    await flush();
    check(detail().querySelector('[data-event-feedback]').textContent === t('community.calendarSaved'), 'Calendar success explains recurring series and snapshot semantics');
    calendarResult = { status: 'failed', error: 'Fixture save failure' };
    chooseEventAction('community.exportCalendar');
    await flush();
    check(detail().querySelector('[data-community-error]').textContent === 'Fixture save failure'
      && !detail().querySelector('[data-event-feedback]'), 'Calendar write failures never report success');
  } finally {
    if (originalApi === undefined) delete window.api; else window.api = originalApi;
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else delete navigator.clipboard;
  }
  interestedMode = 'deferred';
  detail().querySelector('[data-event-tab=details]').click();
  detail().querySelector('[data-event-tab=interested]').click();
  const revokedRequest = calls.at(-1).requestId;
  emit('message.ROLES_LIST', {});
  check(!detail() && cancelled.includes(revokedRequest), 'ACL invalidation cancels requests and closes interested-member data immediately');
  interestedGate({ id: event.id, users: [], nextCursor: null });
  await flush();
  interestedMode = 'normal';
  feed.requestOpenEvent('historic');
  await flush();
  check(detail() && calls.some(call => call.type === 'EVENT_GET' && call.payload.id === 'historic'), 'Links fetch historical events by ID instead of depending on the snapshot');
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  await flush();
  check(detail(), 'Historical detail survives unrelated snapshot refreshes');
  yield 'event-linked-details';
  detail().querySelector('[data-community-close]').click();
  feed.requestOpenEvent('missing');
  await flush();
  check(document.querySelector('[data-community-error]:not([hidden])'), 'Unavailable linked events show an explicit failure');
  allowed = true;
  document.querySelector('[data-community-close]').click();
  event.imageUrl = '/avatars/cover.png';
  event.imageUrls = ['/avatars/cover.png', '/avatars/cover.png'];
  event.occurrence++;
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  check(!root.querySelector('.community-banner .image-carousel'),
    'Active event media stays out of the left sidebar community surface');
  root.querySelector('[data-community=events]').click();
  check(document.querySelector('.event-list-modal [data-event-action=copyLink]')
    && !document.querySelector('.event-list-modal .image-carousel'),
  'Active event lists use the first image as a compact cover');
  yield 'event-active-list';
  document.querySelector('.event-list-modal [data-event-openable=true] .community-event-content').click();
  check(detail().querySelectorAll('.image-carousel-dot').length === 2,
    'Event details expose the complete image carousel');
  yield 'event-active-details';
  detail().querySelector('[data-community-close]').click();
  snapshot = { ...snapshot, events: [{ ...event, status: 'scheduled', startsAt: now + 60000, startedAt: null }] };
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  yield 'event-scheduled-list';
  const historyRow = document.querySelector('.community-history');
  check(Math.abs(historyRow.querySelector('.toggle-switch').getBoundingClientRect().right - historyRow.getBoundingClientRect().right) < 2,
    'Event history keeps its label on the left and switch at the right edge');
  const controlsBefore = calls.filter(call => call.type === 'EVENT_CONTROL').length;
  document.querySelector('[data-event-action=start]').click();
  check(calls.filter(call => call.type === 'EVENT_CONTROL').length === controlsBefore, 'Manual starts require confirmation');
  const startConfirm = document.querySelector('[data-event-action=confirm-start]');
  const startBackground = getComputedStyle(startConfirm).backgroundColor;
  yield 'event-confirm-start';
  const accentProbe = document.body.appendChild(document.createElement('span'));
  accentProbe.style.background = 'var(--accent-hover)';
  const accentHover = getComputedStyle(accentProbe).backgroundColor;
  accentProbe.remove();
  const startHoverBackground = getComputedStyle(startConfirm).backgroundColor;
  check(startHoverBackground !== startBackground && startHoverBackground !== accentHover,
    'The Start now hover darkens its success color instead of switching to the primary blue');
  startConfirm.click();
  await flush();
  check(calls.some(call => call.type === 'EVENT_CONTROL' && call.payload.action === 'start'), 'Confirmed starts reach the event control request');
  emit('message.COMMUNITY_SNAPSHOT', { ...snapshot, events: [{ ...event, location: { kind: 'text', channelId: 'text' } }] });
  document.querySelector('.event-list-modal [data-event-action=join]').click();
  await flush();
  check(openedTextChannels.join() === 'text' && !document.querySelector('.community-modal'),
    'Active text events open the correct conversation and dismiss event dialogs');
  restored.destroy();
  feed.dispose();
  const pendingFeed = new CommunityFeed(client, server);
  pendingFeed.requestOpenEvent('historic');
  const pendingView = new ServerCommunityView(root, pendingFeed, async () => {});
  await flush();
  check(document.querySelector('.event-detail-modal') && pendingFeed.takeEventRequest() === null,
    'Event links queued before view mounting wait for the session snapshot and open exactly once');
  pendingView.destroy();
  pendingFeed.dispose();
  const opened = [];
  const forum = new ForumView(root, client, server, 'forum', id => opened.push(id));
  await flush();
  root.style.cssText = 'height:700px;width:1000px;max-width:100%';
  yield 'forum-list';
  check(root.querySelectorAll('.forum-post-row').length === 1, 'Forum post list renders');
  check(!root.querySelector('script'), 'Forum previews remain text');
  const forumSort = root.querySelector('[data-forum-sort]');
  const forumFilters = root.querySelector('.forum-filters');
  check(getComputedStyle(forumFilters.querySelector('.material-symbols-outlined')).position === 'absolute'
    && parseFloat(getComputedStyle(forumSort).paddingLeft) >= 36
    && getComputedStyle(forumSort).borderTopWidth !== '0px',
  'Forum sorting uses one themed control with a reserved icon area instead of overlapping surfaces');
  forumPosts = [
    { ...post, channelId: 'post-new', title: 'Newer post', createdAt: now + 2_000, updatedAt: now + 2_000 },
    { ...post, channelId: 'post-old', title: 'Older post', createdAt: now - 2_000, updatedAt: now - 2_000 },
  ];
  await forum.load();
  forumSort.value = 'oldest';
  forumSort.dispatchEvent(new Event('change', { bubbles: true }));
  for (let index = 0; index < 80; index++) await Promise.resolve();
  const reorderAnimated = [...root.querySelectorAll('[data-forum-id]')].some(row =>
    row.getAnimations().some(animation => animation.id === 'forum-thread-reorder'));
  await flush();
  check(calls.some(call => call.type === 'FORUM_LIST' && call.payload.sort === 'oldest'),
    'Forum threads can be ordered by the selected criterion');
  check([...root.querySelectorAll('[data-forum-id]')].map(row => row.dataset.forumId).join(',') === 'post-old,post-new'
    && reorderAnimated,
  'Changing the forum order moves existing thread cards with a FLIP animation');
  root.querySelector('[data-forum-menu]').click();
  const threadActions = [...document.querySelectorAll('[role=menuitem]')].map(item => item.textContent);
  check(threadActions.some(label => label.includes(t('forum.rename')))
    && threadActions.some(label => label.includes(t('forum.lock')))
    && threadActions.some(label => label.includes(t('forum.close')))
    && threadActions.some(label => label.includes(t('forum.delete'))),
  `Thread menu separates rename, administrative lock, author close and deletion: ${JSON.stringify(threadActions)}`);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  forum.rename(post);
  const renameForm = document.querySelector('.forum-rename-form');
  check(renameForm && renameForm.querySelectorAll('input').length === 1
    && !renameForm.querySelector('textarea, [data-post-emoji], [data-post-file]'),
  'Editing a thread opens a standard rename-only modal');
  renameForm.querySelector('input').value = 'Renamed topic';
  renameForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(calls.some(call => call.type === 'FORUM_UPDATE_POST'
    && call.payload.channelId === 'post' && call.payload.title === 'Renamed topic'),
  'Rename modal changes only the thread title');
  const deletingThread = forum.delete(post);
  await flush();
  document.querySelector('.dialog-card [data-action=confirm]').click();
  await deletingThread;
  check(calls.some(call => call.type === 'FORUM_DELETE_POST' && call.payload.channelId === 'post'),
    'Deleting a thread requires confirmation and uses its dedicated protocol action');
  forumPosts = [{ ...post, locked: true, closed: true }];
  await forum.load();
  check(root.querySelector('.forum-post-stats').textContent.includes(t('forum.locked'))
    && root.querySelector('.forum-post-stats').textContent.includes(t('forum.closed')),
  'Thread cards distinguish administrative locks from author closures');
  forumPosts = Array.from({ length: 60 }, (_, index) => ({
    ...post,
    channelId: `lazy-post-${index}`,
    title: `Lazy post ${index}`,
    createdAt: now + index,
    updatedAt: now + index,
  }));
  await forum.load();
  check(root.querySelectorAll('[data-forum-id]').length === 25
    && !root.querySelector('[data-forum-sentinel]').hidden
    && !root.querySelector('[data-forum-more]'),
  'Large forums render only the first page and expose an automatic lazy-loading sentinel');
  forumSort.value = 'newest';
  forumSort.dispatchEvent(new Event('change', { bubbles: true }));
  for (let index = 0; index < 80; index++) await Promise.resolve();
  const replacementPageAnimated = [...root.querySelectorAll('[data-forum-id]')].some(row =>
    row.getAnimations().some(animation => animation.id === 'forum-thread-reorder-enter'));
  await flush();
  check(root.querySelector('[data-forum-id]')?.dataset.forumId === 'lazy-post-59' && replacementPageAnimated,
  'Sorting to a page with different thread IDs animates the replacement cards into place');
  forumSort.value = 'oldest';
  forumSort.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  let releaseForumPage;
  forumListGate = new Promise(resolve => { releaseForumPage = resolve; });
  const forumScroller = root.querySelector('.forum-list-content');
  forumScroller.scrollTop = forumScroller.scrollHeight;
  await until(() => calls.some(call => call.type === 'FORUM_LIST' && call.payload.offset === 25));
  check(!root.querySelector('[data-forum-loading]').hidden
    && root.querySelectorAll('.forum-thread-skeleton').length === 3
    && root.querySelector('[data-forum-posts]').getAttribute('aria-busy') === 'true',
  'Incremental forum loading keeps existing threads visible and adds card-shaped skeletons');
  releaseForumPage();
  forumListGate = null;
  await until(() => root.querySelectorAll('[data-forum-id]').length === 50);
  forumScroller.scrollTop = forumScroller.scrollHeight;
  await until(() => root.querySelectorAll('[data-forum-id]').length === 60);
  check(root.querySelector('[data-forum-loading]').hidden
    && root.querySelector('[data-forum-sentinel]').hidden,
  'Lazy loading appends every remaining thread and removes the sentinel at the end');
  forumPosts = [];
  await forum.load();
  check(root.querySelector('.forum-empty-state strong')?.textContent === t('forum.emptyTitle')
    && root.querySelector('.forum-empty-state')?.textContent.includes('#Forum')
    && !root.querySelector('[data-forum-posts] button'),
  'Empty forums show the centered first-conversation state without example actions');
  forumPosts = [post];
  await forum.load();
  root.querySelector('[data-forum-open]').click();
  check(opened[0] === 'post', 'Post opens its text discussion');
  const forumSearch = root.querySelector('[data-forum-search]');
  const createShell = root.querySelector('.forum-create-shell');
  const createBar = root.querySelector('.forum-create-bar');
  const createHeight = createShell.getBoundingClientRect().height;
  forumSearch.focus();
  await new Promise(resolve => setTimeout(resolve, 180));
  const shortcutRect = root.querySelector('.forum-create-shortcut').getBoundingClientRect();
  const shellRect = createShell.getBoundingClientRect();
  check(root.querySelector('.forum-create-shortcut').textContent.includes('Shift')
    && root.querySelector('.forum-create-shortcut').textContent.includes('Enter')
    && root.querySelector('[data-forum-create]').closest('.forum-create-bar') === createBar
    && forumSearch.closest('.forum-create-bar') === createBar
    && parseFloat(getComputedStyle(forumSearch).borderTopWidth) === 0
    && getComputedStyle(forumSearch).boxShadow === 'none'
    && getComputedStyle(root.querySelector('.forum-create-shortcut')).position === 'static'
    && shellRect.height > createHeight + 20
    && shortcutRect.top >= createBar.getBoundingClientRect().bottom - 1
    && shortcutRect.right <= shellRect.right + 1,
  'Forum search, icon and create button share one surface with the shortcut in its internal footer');
  yield 'forum-create-shortcut';
  forumSearch.value = 'New topic';
  forumSearch.dispatchEvent(new Event('input', { bubbles: true }));
  forumSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  check(root.querySelector('.forum-composer form') && !document.querySelector('.community-modal'),
    'Shift+Enter expands the new forum post inline rather than opening a modal');
  check(document.querySelector('input[name=title]').value === 'New topic',
    'The search text becomes the initial thread title');
  check(document.activeElement === document.querySelector('textarea[name=content]'),
    'Shift+Enter moves focus directly from the title to the thread body');
  const composerSecondaryButtons = [...root.querySelectorAll('.forum-composer-footer .btn-secondary')];
  check(composerSecondaryButtons.length === 3
    && composerSecondaryButtons.every(button => button.getBoundingClientRect().height <= 34)
    && root.querySelector('[data-post-emoji]').getBoundingClientRect().width <= 34,
  'Forum attachment actions use the compact toolbar geometry shared by the app');
  document.querySelector('textarea[name=content]').value = 'Initial message';
  yield 'forum-composer';
  root.querySelector('.forum-composer form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(calls.some(call => call.type === 'FORUM_CREATE_POST' && call.payload.content === 'Initial message')
    && forumSearch.value === '',
  'New topic includes its initial message and clears the reused search title after publishing');
  const OriginalXHR = window.XMLHttpRequest;
  const uploadUrls = [];
  class UploadXHR {
    upload = {};
    status = 200;
    response = { id: 'uploaded-image', url: '/attachments/image.png', kind: 'image', filename: 'image.png',
      originalName: 'image.png', mimeType: 'image/png', sizeBytes: 5, evicted: false };
    open(method, url) { uploadUrls.push(url); }
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onload?.()); }
    abort() { this.onabort?.(); }
  }
  window.XMLHttpRequest = UploadXHR;
  const originalClient = getActiveNetworkClient();
  try {
    root.querySelector('[data-forum-create]').click();
    document.querySelector('input[name=title]').value = 'Image-only topic';
    const mediaFiles = new DataTransfer();
    mediaFiles.items.add(new File([png], 'image.png', { type: 'image/png' }));
    mediaFiles.items.add(new File(['video'], 'clip.webm', { type: 'video/webm' }));
    const uploadedImage = mediaFiles.files[0];
    const mediaInput = document.querySelector('[data-post-media-input]');
    const fileInput = document.querySelector('[data-post-file-input]');
    const mediaButton = document.querySelector('[data-post-media]');
    const fileButton = document.querySelector('[data-post-file]');
    check(mediaInput && fileInput && mediaInput !== fileInput
      && mediaInput.accept.includes('image') && !fileInput.accept.includes('image'),
    'Forum creation exposes separate media and file pickers');
    Object.defineProperty(mediaInput, 'click', { configurable: true, value: () => {} });
    Object.defineProperty(fileInput, 'click', { configurable: true, value: () => {} });
    mediaButton.click();
    mediaButton.click();
    check(mediaButton.disabled && mediaButton.dataset.loading === '1'
      && mediaButton.getAttribute('aria-busy') === 'true',
    'Forum media selection shows loading and blocks repeated native-picker clicks');
    mediaInput.dispatchEvent(new Event('cancel'));
    check(!mediaButton.disabled && !mediaButton.dataset.loading && !mediaButton.hasAttribute('aria-busy'),
      'Cancelling the forum media picker restores its trigger');
    const invalidMedia = new DataTransfer();
    invalidMedia.items.add(new File(['report'], 'not-media.pdf', { type: 'application/pdf' }));
    mediaInput.files = invalidMedia.files;
    mediaInput.dispatchEvent(new Event('change'));
    check(document.querySelectorAll('.forum-media-slide').length === 0
      && document.querySelector('.chat-copy-toast--danger'),
    'The photos and videos picker rejects every non-media file even when the platform bypasses accept');
    mediaInput.files = mediaFiles.files;
    mediaInput.dispatchEvent(new Event('change'));
    const remainingMedia = new DataTransfer();
    remainingMedia.items.add(new File([png], 'image-2.png', { type: 'image/png' }));
    remainingMedia.items.add(new File([png], 'image-3.png', { type: 'image/png' }));
    remainingMedia.items.add(new File([png], 'image-4.png', { type: 'image/png' }));
    mediaInput.files = remainingMedia.files;
    mediaInput.dispatchEvent(new Event('change'));
    const overflowMedia = new DataTransfer();
    overflowMedia.items.add(new File(['overflow'], 'overflow.png', { type: 'image/png' }));
    mediaInput.files = overflowMedia.files;
    mediaInput.dispatchEvent(new Event('change'));
    check(document.querySelectorAll('.forum-media-slide').length === 5
      && document.querySelector('.chat-copy-toast--danger')?.textContent.includes('5')
      && !document.querySelector('[data-composer-error]'),
    'Forum media limits use an error toast instead of inserting loose text into the composer');
    const documentFiles = new DataTransfer();
    documentFiles.items.add(new File(['report'], 'report.pdf', { type: 'application/pdf' }));
    documentFiles.items.add(new File([png], 'photo-as-file.png', { type: 'image/png' }));
    fileButton.click();
    fileInput.files = documentFiles.files;
    fileInput.dispatchEvent(new Event('change'));
    check(!fileButton.disabled && !fileButton.dataset.loading && !fileButton.hasAttribute('aria-busy'),
      'Selecting forum files clears the shared native-picker loading state');
    check(document.querySelector('.forum-media-carousel img')
      && document.querySelector('.forum-media-carousel video')
      && document.querySelector('.forum-media-carousel [data-carousel-move]')
      && document.querySelectorAll('.forum-file-card').length === 2
      && document.querySelector('.forum-file-preview').textContent.includes('report.pdf')
      && document.querySelector('.forum-file-preview').textContent.includes('photo-as-file.png')
      && document.querySelectorAll('.forum-media-slide').length === 5,
    'The media picker creates the carousel while the file picker also accepts photos as file selections');
    check(document.querySelector('.forum-file-card .forum-file-icon').textContent === 'picture_as_pdf',
      'File preview cards use a format-specific icon and metadata');
    const composerWidth = document.querySelector('.forum-composer').getBoundingClientRect().width;
    check(document.querySelector('[data-forum-media-preview]').getBoundingClientRect().width <= 642
      && document.querySelector('[data-forum-file-preview]').getBoundingClientRect().width <= 642
      && document.querySelector('[data-forum-media-preview]').getBoundingClientRect().width < composerWidth,
    'Media and file previews stay compact instead of spanning the full forum composer');
    yield 'forum-composer-attachments';
    while (document.querySelector('.forum-file-card [data-remove-attachment]')) {
      document.querySelector('.forum-file-card [data-remove-attachment]').click();
    }
    while (document.querySelectorAll('.forum-media-slide').length > 1) {
      [...document.querySelectorAll('.forum-media-slide')].at(-1).querySelector('[data-remove-attachment]').click();
    }
    check(!document.querySelector('.forum-file-card'), 'Each file preview can be removed independently');
    check(!document.querySelector('textarea').required, 'Image-only topics do not require text');
    root.querySelector('.forum-composer form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    check(calls.some(call => call.type === 'FORUM_CREATE_POST' && call.payload.title === 'Image-only topic'
      && call.payload.attachmentIds[0] === 'uploaded-image'), 'Forum creation submits uploaded attachment IDs');
    let releaseToken;
    const origin = { ...client, getHttpBaseUrl: () => 'http://original-server',
      sendRequest: () => new Promise(resolve => { releaseToken = resolve; }) };
    setActiveNetworkClient(origin);
    const upload = uploadAttachment('forum', uploadedImage);
    setActiveNetworkClient({ ...client, getHttpBaseUrl: () => 'http://another-server' });
    releaseToken({ token: 'original-token' });
    await upload.promise;
    check(uploadUrls.at(-1).startsWith('http://original-server/attachments?token=original-token'),
      'Pending uploads keep the original session after switching servers');
  } finally {
    window.XMLHttpRequest = OriginalXHR;
    setActiveNetworkClient(originalClient);
  }
  forum.destroy();
  check(listeners.size === 0, 'Session listeners are disposed');
  const [{ MainView }, { VoiceStageView }, { sessionManager }, stores, chatStores] = await Promise.all([
    import('/views/MainView.ts'), import('/views/VoiceStageView.ts'), import('/core/SessionManager.ts'),
    import('/stores/serverStore.ts'), import('/stores/chatStore.ts'),
  ]);
  const originalSession = sessionManager.getActive;
  const originalStore = stores.getActiveServerStore();
  const originalChatStore = chatStores.getActiveChatStore();
  const actualChatStore = chatStores.createChatStore();
  const mainRoot = document.createElement('div');
  root.hidden = true;
  mainRoot.style.cssText = 'height:700px;width:1100px;max-width:100%;';
  mainRoot.innerHTML = `<div class="main-layout">
    <aside class="channels-sidebar"><div class="channels-list-container"><div id="channel-categories-list"></div></div></aside>
    <div class="main-center-column"><div id="server-tools" class="server-tools"></div><div id="main-center-stage" class="main-content-area"></div></div>
    <aside id="voice-channel-chat-panel" class="voice-channel-chat-panel" hidden></aside>
    <aside class="members-sidebar"></aside>
  </div>`;
  document.body.append(mainRoot);
  const main = new MainView(mainRoot);
  server.serverDetails.channels.push({ id: 'post', name: 'First post', type: 'TEXT', forumId: 'forum' });
  const chatServer = stores.createServerStore();
  chatServer.setServerDetails({ ...server.serverDetails, members: [], ownerId: 'owner', myPermissions: 0xFFFFFFFF },
    { ...server.currentUser, nickname: 'Owner' });
  try {
    stores.setActiveServerStore(chatServer);
    chatStores.setActiveChatStore(actualChatStore);
    setActiveNetworkClient(client);
    sessionManager.getActive = () => ({ client, serverStore: chatServer });
    main.showSelectedChannel('forum');
    await flush();
    mainRoot.querySelector('[data-forum-create]').click();
    const draftTitle = mainRoot.querySelector('[name=title]');
    check(draftTitle, 'The real server store permits the forum composer');
    draftTitle.value = 'Keep this draft';
    const listNode = mainRoot.querySelector('.forum-list-pane');
    main.showSelectedChannel('post');
    await flush();
    const pane = mainRoot.querySelector('.forum-discussion-pane');
    check(pane && !pane.hidden && pane.querySelector('.channel-title')?.textContent === 'First post' && mainRoot.querySelector('.forum-list-pane') === listNode,
      'Discussion opens beside the same forum list');
    check(pane.querySelector('[data-chat-create=poll]').hidden,
      'Forum threads keep message attachments but do not expose channel-only poll creation');
    const chatAttach = pane.querySelector('#btn-attach');
    const chatFileInput = pane.querySelector('#chat-file-input');
    Object.defineProperty(chatFileInput, 'click', { configurable: true, value: () => {} });
    chatAttach.click();
    pane.querySelector('[data-chat-create=attachment]').click();
    check(chatAttach.disabled && chatAttach.dataset.loading === '1' && chatAttach.getAttribute('aria-busy') === 'true',
      'Chat attachments show loading on the persistent composer trigger while the native picker is open');
    chatFileInput.dispatchEvent(new Event('cancel'));
    check(!chatAttach.disabled && !chatAttach.dataset.loading && !chatAttach.hasAttribute('aria-busy'),
      'Cancelling the chat attachment picker restores the composer trigger');
    const listBox = listNode.getBoundingClientRect(), paneBox = pane.getBoundingClientRect();
    const headerBox = mainRoot.querySelector('.forum-header').getBoundingClientRect();
    check(paneBox.left >= listBox.right && Math.abs(paneBox.top - headerBox.top) < 2 && listBox.width >= 240,
      'Forum and discussion occupy adjacent columns with aligned headers');
    check(Math.abs(pane.querySelector('.chat-input-container').getBoundingClientRect().bottom - paneBox.bottom) < 2,
      'The real discussion fills its column and anchors its composer at the bottom');
    check(mainRoot.querySelector('#server-tools').getBoundingClientRect().right <= headerBox.right,
      'Search stays in the forum header instead of covering discussion controls');
    check(mainRoot.querySelector('[name=title]') === draftTitle && draftTitle.value === 'Keep this draft', 'Opening a discussion preserves the inline draft');
    check(calls.some(call => call.type === 'CHAT_LOAD_HISTORY' && call.payload.channelId === 'post'), 'Real discussion requests its own chat history');
    const forumImage = color => `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${color}"/></svg>`,
    )}`;
    actualChatStore.setHistory('post', [{
      id: 'forum-media-message', channelId: 'post', userId: 'member', userNickname: 'Audience Member',
      content: 'Carousel topic', createdAt: Date.now(), updatedAt: Date.now(), isSystem: false,
      attachments: [
        ...['#d04444', '#44a35c', '#466fd1', '#d5a23d'].map((color, index) => ({
          id: `forum-image-${index}`, kind: 'image', url: forumImage(color), originalName: `${index + 1}.svg`,
          mimeType: 'image/svg+xml', sizeBytes: 1,
        })),
      ],
    }]);
    appEvents.emit('chat.history_loaded', { channelId: 'post' });
    await flush();
    const actualCarousel = pane.querySelector('.chat-attachment-carousel');
    const actualCarouselRect = actualCarousel.getBoundingClientRect();
    check(pane.querySelectorAll('.chat-attachment-carousel-slide').length === 4
      && pane.querySelectorAll('.chat-message-row .chat-attachment-image').length === 4
      && actualCarouselRect.right <= pane.getBoundingClientRect().right + 1
      && Math.abs((actualCarouselRect.width / actualCarouselRect.height) - (4 / 3)) < 0.03,
    'The actual forum discussion renders the published media as one carousel contained by its narrow column');
    const actualNext = actualCarousel.querySelector('[data-carousel-move="1"]');
    const visitedMedia = [];
    for (let index = 0; index < 4; index++) {
      actualNext.click();
      visitedMedia.push(actualCarousel.dataset.carouselIndex);
    }
    check(visitedMedia.join(',') === '1,2,3,0',
      `Each real click visits all four media in sequence without double advancement: ${visitedMedia.join(',')}`);
    check(mainRoot.querySelector('.forum-list-pane .forum-composer [type=submit]').getBoundingClientRect().right
      <= mainRoot.querySelector('.forum-list-pane').getBoundingClientRect().right,
    'Opening the narrow discussion does not clip the draft composer actions');
    yield 'forum-chat-carousel';
    const carouselProbe = document.createElement('div');
    carouselProbe.innerHTML = main.chatView.renderAttachments([
      { id: 'image-a', kind: 'image', url: '/attachments/a.png', originalName: 'a.png', mimeType: 'image/png', sizeBytes: 1 },
      { id: 'video-b', kind: 'video', url: '/attachments/b.webm', originalName: 'b.webm', mimeType: 'video/webm', sizeBytes: 2 },
      { id: 'file-c', kind: 'file', url: '/attachments/c.pdf', originalName: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
    ]);
    check(carouselProbe.querySelectorAll('.chat-attachment-carousel-slide').length === 2
      && carouselProbe.querySelector('.chat-attachment-file')
      && carouselProbe.querySelectorAll('.chat-inline-media').length === 2,
    'Published thread media remains grouped in a chat carousel while files stay separate');
    const chatCarouselNext = carouselProbe.querySelector('[data-carousel-move="1"]');
    check(moveImageCarousel(chatCarouselNext)
      && chatCarouselNext.closest('[data-image-carousel]').dataset.carouselIndex === '1'
      && carouselProbe.querySelectorAll('.image-carousel-dot')[1].getAttribute('aria-current') === 'true',
    'The published chat carousel keeps working navigation and active indicators');
    const reply = pane.querySelector('#chat-message-input');
    check(reply, 'The real discussion includes its message composer');
    check(reply.getBoundingClientRect().width >= paneBox.width - 100,
      'The narrow discussion gives the editor a full row instead of squeezing it between tools');
    reply.value = 'A real forum reply';
    reply.dispatchEvent(new Event('input', { bubbles: true }));
    pane.querySelector('#btn-send-message').click();
    await flush();
    check(calls.some(call => call.type === 'CHAT_SEND' && call.payload.channelId === 'post' && call.payload.content === 'A real forum reply'),
      'The real chat composer sends replies to the post channel');
    const discussionChannel = chatServer.getChannel('post');
    discussionChannel.forumClosed = true;
    main.chatView.syncComposerPermissionState();
    check(reply.readOnly && reply.placeholder === t('forum.closedPlaceholder')
      && getComputedStyle(pane.querySelector('#chat-send-permission-banner')).display === 'none',
    'An author-closed thread locks the composer with only a placeholder and no warning banner');
    discussionChannel.forumClosed = false;
    discussionChannel.forumLocked = true;
    main.chatView.syncComposerPermissionState();
    check(reply.readOnly && reply.placeholder === t('forum.lockedPlaceholder')
      && getComputedStyle(pane.querySelector('#chat-send-permission-banner')).display === 'none',
    'An administratively locked thread uses its distinct placeholder without a warning banner');
    discussionChannel.forumLocked = false;
    main.chatView.syncComposerPermissionState();
    yield 'forum-discussion';
    pane.querySelector('#chat-forum-back').click();
    check(pane.inert, 'Closing a discussion immediately disables its outgoing controls');
    await flush();
    check(pane.hidden && mainRoot.querySelector('[name=title]') === draftTitle, 'Closing a discussion preserves its forum and draft');
    chatServer.addChannel({ id: 'delete-post', name: 'Delete me', type: 'TEXT', forumId: 'forum' });
    main.showSelectedChannel('delete-post');
    await flush();
    chatServer.removeChannel('delete-post');
    main.handleChannelDeleted({ channelId: 'delete-post' });
    await flush();
    check(mainRoot.querySelector('.forum-layout') && mainRoot.querySelector('.forum-discussion-pane').hidden
      && mainRoot.querySelector('.forum-list-pane') === listNode,
    'Deleting the open thread closes only its discussion and keeps the forum list active');
    main.showSelectedChannel('text');
    check(!mainRoot.querySelector('.forum-layout') && mainRoot.querySelector('.channel-title')?.textContent === 'Text',
      'Switching to a regular channel restores a full-width chat');
    const previousHistory = actualChatStore.getMessages('text');
    actualChatStore.setHistory('text', Array.from({ length: 200 }, (_, index) => ({
      id: `long-history-${index}`, channelId: 'text', userId: chatServer.currentUser.id,
      userNickname: 'Author', content: `History entry ${index}\nSecond line\nThird line`, createdAt: index + 1,
    })));
    const longFeed = mainRoot.querySelector('#chat-messages-feed');
    const scrollCalls = [];
    const scrollTo = longFeed.scrollTo;
    longFeed.scrollTo = function (options) {
      scrollCalls.push({ ...options, before: this.scrollTop, max: this.scrollHeight - this.clientHeight });
      scrollTo.call(this, options);
    };
    main.chatView.renderMessages({ forceScroll: true });
    check(longFeed.scrollHeight > longFeed.clientHeight * 20 &&
      longFeed.scrollHeight - longFeed.clientHeight - longFeed.scrollTop <= 161 &&
      scrollCalls.some(call => call.behavior === 'smooth' && call.top > call.before),
    'A long chat begins its entry animation near the bottom, with no more than 160px left to travel');
    await new Promise((resolve, reject) => {
      const start = performance.now();
      const settle = () => {
        if (Math.abs(longFeed.scrollHeight - longFeed.clientHeight - longFeed.scrollTop) <= 1) resolve();
        else if (performance.now() - start > 2000) reject(new Error('Short chat entry did not reach the latest message'));
        else requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    });
    check(scrollCalls.filter(call => call.behavior === 'smooth').every(call => Math.abs(call.top - call.before) <= 161),
      'Every smooth leg of the history reveal stays within the distance limit, including the layout frame');
    yield 'chat-entry-reduced-motion';
    scrollTo.call(longFeed, { top: 0, behavior: 'instant' });
    scrollCalls.length = 0;
    main.chatView.renderMessages({ forceScroll: true });
    check(longFeed.scrollHeight - longFeed.clientHeight - longFeed.scrollTop <= 1 &&
      scrollCalls.every(call => call.behavior === 'instant'),
    'Reduced motion opens long histories directly at the destination without animation');
    yield 'chat-entry-motion-enabled';
    longFeed.scrollTo = scrollTo;
    actualChatStore.setHistory('text', previousHistory);
    main.chatView.renderMessages({ forceScroll: true });
    const oldPermissions = chatServer.myPermissions;
    const oldOwner = chatServer.ownerId;
    const readableChannel = chatServer.getChannel('text');
    chatServer.ownerId = 'another-owner';
    chatServer.myPermissions = 546576;
    const revokedMessage = { id: 'read-revoked', channelId: 'text', userId: chatServer.currentUser.id,
      userNickname: 'Author', content: 'Cached private content', createdAt: 1 };
    actualChatStore.addMessage(revokedMessage);
    actualChatStore.setReplyDraft('text', revokedMessage);
    actualChatStore.setBlockDraft('text', [{ type: 'text', text: 'Cached block' }]);
    actualChatStore.beginMessageEdit(revokedMessage);
    const outgoingMessage = { ...revokedMessage, id: 'late-permission-ack' };
    const outgoing = actualChatStore.enqueueMessage(
      { clientMessageId: outgoingMessage.id, channelId: 'text', content: outgoingMessage.content }, outgoingMessage);
    const originalSendRequest = client.sendRequest;
    let acknowledgeRetiredSend;
    client.sendRequest = (type, ...args) => type === 'CHAT_SEND'
      ? new Promise(resolve => { acknowledgeRetiredSend = resolve; }) : originalSendRequest.call(client, type, ...args);
    const lateSend = main.chatView.transmitMessage(outgoing);
    chatServer.updateChannel({ ...readableChannel, categoryId: null, inheritCategoryPermissions: false,
      permissionOverwrites: [{ roleId: null, allow: 0, deny: 512 }] });
    check(actualChatStore.getMessages('text').length === 0 &&
      !actualChatStore.getReplyDraft('text') && !actualChatStore.getMessageEdit('text') &&
      actualChatStore.getBlockDraft('text').length === 0,
    'Read revocation clears the real chat cache, reply, edit and block draft immediately');
    check(mainRoot.querySelector('#chat-message-input').value === '' &&
      mainRoot.querySelector('#chat-edit-composer').hidden &&
      mainRoot.querySelector('#chat-messages-feed').textContent.includes(t('channelPermissions.readDenied')),
    'Read revocation clears the visible compositor as well as the message feed');
    acknowledgeRetiredSend(outgoingMessage);
    await lateSend;
    client.sendRequest = originalSendRequest;
    check(actualChatStore.getMessages('text').length === 0 &&
      !mainRoot.querySelector('[data-message-id="late-permission-ack"]'),
    'A late direct send acknowledgement cannot revive a revoked cache or message row');
    chatServer.updateChannel(readableChannel);
    chatServer.ownerId = oldOwner;
    chatServer.myPermissions = oldPermissions;
    check(!mainRoot.querySelector('#chat-messages-feed').textContent.includes(t('channelPermissions.readDenied')),
      'Restoring reading removes the denied state and resumes the normal chat');
    const stage = mainRoot.querySelector('#main-center-stage');
    main.voiceStageView = new VoiceStageView(stage);
    let voiceJoinRequests = 0;
    main.voiceStageView.onToggleChat = channelId => main.toggleVoiceChannelChat(channelId);
    main.voiceStageView.onJoinChannel = async () => { voiceJoinRequests++; };
    main.renderChannels();
    const voiceChatButton = mainRoot.querySelector('[data-voice-chat-channel="voice"]');
    check(voiceChatButton && voiceChatButton.getAttribute('aria-label') === t('voiceChat.open'),
      'Every readable voice channel exposes a localized chat button in the channel list');
    const voiceChannelRow = voiceChatButton.closest('.channel-item');
    const voiceMenuButton = voiceChannelRow.querySelector('.channel-menu-btn');
    const voiceChatStyle = getComputedStyle(voiceChatButton);
    const voiceMenuStyle = getComputedStyle(voiceMenuButton);
    const voiceChatRect = voiceChatButton.getBoundingClientRect();
    const voiceMenuRect = voiceMenuButton.getBoundingClientRect();
    check(voiceChatStyle.opacity === '0' && voiceChatStyle.pointerEvents === 'none'
      && voiceMenuStyle.opacity === '0' && voiceMenuStyle.pointerEvents === 'none',
    'Voice chat and channel menu actions stay hidden and inert outside row hover or focus');
    check(voiceChatRect.width === 20 && voiceChatRect.height === 20
      && voiceChatStyle.borderRadius === '50%'
      && voiceMenuRect.left >= voiceChatRect.right && voiceMenuRect.left - voiceChatRect.right <= 2.5,
    'Voice chat uses a round bubble button immediately beside the channel menu');
    check(/["']FILL["'] 1/.test(getComputedStyle(
      voiceChatButton.querySelector('.material-symbols-outlined')).fontVariationSettings),
    'Voice chat uses the filled speech-bubble icon');
    const voiceActionRule = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(rule =>
      rule.selectorText?.includes('.channel-item:hover .voice-chat-btn'));
    check(voiceActionRule?.style.opacity === '1' && voiceActionRule?.style.pointerEvents === 'auto',
      'Channel hover reveals the compact round voice chat action');
    voiceChatButton.click();
    await flush();
    const voicePanel = mainRoot.querySelector('#voice-channel-chat-panel');
    check(!voicePanel.hidden && mainRoot.querySelector('.main-layout').classList.contains('main-layout--voice-chat-open')
      && getComputedStyle(mainRoot.querySelector('.members-sidebar')).display === 'none',
    'Opening voice chat replaces the members sidebar with the dedicated chat panel');
    const voicePanelWidth = voicePanel.getBoundingClientRect().width;
    const voiceResizer = voicePanel.querySelector('.voice-chat-resizer');
    check(voicePanelWidth >= 480 && getComputedStyle(voicePanel).minWidth === '480px'
      && voiceResizer.getAttribute('aria-valuemin') === '480'
      && getComputedStyle(voiceResizer).cursor === 'col-resize',
      'Voice chat opens wider by default and exposes a resize handle');
    const resizeX = Math.round(voiceResizer.getBoundingClientRect().left + 3);
    voiceResizer.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, clientX: resizeX,
    }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: resizeX - 48 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: resizeX - 48 }));
    const resizedVoicePanelWidth = voicePanel.getBoundingClientRect().width;
    const expectedVoicePanelWidth = Math.min(
      voicePanelWidth + 48,
      Number.parseInt(voiceResizer.getAttribute('aria-valuemax'), 10),
    );
    check(Math.abs(resizedVoicePanelWidth - expectedVoicePanelWidth) <= 1
      && resizedVoicePanelWidth > voicePanelWidth
      && Number.parseInt(localStorage.getItem('monky_voice_chat_width'), 10) === Math.round(resizedVoicePanelWidth),
    'Dragging the left edge widens and persists the voice chat panel');
    check(mainRoot.querySelector('#stage-btn-chat')?.getAttribute('aria-pressed') === 'true'
      && mainRoot.querySelector('#stage-btn-join') && voiceJoinRequests === 0,
    'Opening chat from the channel list shows the stage controls without joining voice');
    check(/["']FILL["'] 1/.test(getComputedStyle(
      mainRoot.querySelector('#stage-btn-chat .material-symbols-outlined')).fontVariationSettings),
    'The stage uses the same filled voice-chat icon');
    check(voicePanel.querySelector('.channel-title')?.textContent === 'Voice'
      && voicePanel.querySelector('.channel-title-container .material-symbols-outlined')?.textContent.trim() === 'volume_up'
      && calls.some(call => call.type === 'CHAT_LOAD_HISTORY' && call.payload.channelId === 'voice'),
    'The side panel reuses the persistent chat and loads the selected voice channel history');
    mainRoot.querySelector('#stage-btn-chat').click();
    check(main.voiceChatChannelId === null && mainRoot.querySelector('#stage-btn-chat')?.getAttribute('aria-pressed') === 'false',
      'The stage header button toggles the same voice chat panel');
    main.openVoiceChannelChat('voice');
    await flush();
    check(Math.abs(voicePanel.getBoundingClientRect().width - resizedVoicePanelWidth) <= 1,
      'Reopening voice chat restores its persisted width');
    mainRoot.querySelector('.voice-chat-close').click();
    check(main.voiceChatChannelId === null && voiceJoinRequests === 0,
      'Closing the panel never changes voice admission');
    const sidebar = document.createElement('aside');
    check(main.clampSidebarWidth(100000) === Math.max(280, Math.floor(window.innerWidth * 0.175))
      && main.clampSidebarWidth(1) === 280, 'Sidebar halves its maximum width while preserving the readable minimum');
    sidebar.id = 'sidebar-layout-fixture';
    sidebar.style.cssText = 'width:280px;height:700px;display:flex;flex-direction:column;background:var(--bg-panel)';
    sidebar.innerHTML = `<div class="server-header"><button id="server-dropdown-toggle" class="server-dropdown-toggle" type="button"><span>Monky QA</span><span class="material-symbols-outlined server-dropdown-caret">expand_more</span></button>
      <div id="server-dropdown-menu" class="server-dropdown-menu" hidden>
        <button class="server-dropdown-item" hidden>Hidden</button>
        <button class="server-dropdown-item">First</button><button class="server-dropdown-item">Last</button>
      </div></div>
      <div class="channels-list-container"><div id="server-community"></div><div id="channel-categories-list"></div></div>`;
    mainRoot.hidden = true;
    document.body.append(sidebar);
    chatServer.serverDetails.categories = [
      { id: 'qa-text', name: t('main.textChannels'), position: 0, isPrivate: false, allowedRoleIds: [] },
      { id: 'qa-voice', name: t('main.voiceChannels'), position: 1, isPrivate: false, allowedRoleIds: [] },
    ];
    for (const channel of chatServer.serverDetails.channels) channel.categoryId = channel.type === 'VOICE' ? 'qa-voice' : 'qa-text';
    const sidebarMain = new MainView(sidebar);
    sidebarMain.renderChannels();
    sidebarMain.attachEvents();
    const sidebarFeed = new CommunityFeed(client, chatServer);
    sidebarFeed.snapshot = {
      settings: { eventsEnabled: true, bannerUrl: '/avatars/cover.png' },
      events: [], liveActions: [action],
    };
    const header = sidebar.querySelector('.server-header');
    const sidebarCommunity = new ServerCommunityView(sidebar.querySelector('#server-community'), sidebarFeed, async () => {}, header);
    try {
      const liveDot = sidebar.querySelector('.community-sidebar-live-dot');
      check(header.style.backgroundImage.includes('/avatars/cover.png')
        && !header.style.backgroundImage.includes('/avatars/action-1.png'),
      'Live Action media stays in its own surface instead of replacing the configured server banner');
      check(liveDot && getComputedStyle(liveDot).animationName === 'pulseLive',
        'The Live Actions shortcut pulses while an action is active');
      yield 'live-action-reduced-motion';
      check(getComputedStyle(liveDot).animationName === 'none',
        'The active Live Action indicator stops pulsing when reduced motion is enabled');
      yield 'live-action-motion-enabled';
      check(getComputedStyle(liveDot).animationName === 'pulseLive',
        'The active Live Action indicator resumes when motion is enabled');
      sidebarFeed.snapshot = {
        settings: { eventsEnabled: true, bannerUrl: '/avatars/cover.png' },
        events: [event], liveActions: [],
      };
      sidebarCommunity.render();
      check(sidebar.querySelector('[data-community=events] .community-sidebar-live-dot')
        && sidebar.querySelector('[data-community=actions]')
        && !sidebar.querySelector('[data-community=actions] .community-sidebar-live-dot'),
      'Only the Events shortcut pulses while an event is active and Live Actions is idle');
      sidebarFeed.snapshot = { settings: { eventsEnabled: true, bannerUrl: null }, events: [], liveActions: [] };
      sidebarCommunity.render();
      let eventButton = sidebar.querySelector('[data-community=events]');
      check(eventButton.textContent.trim() === `event${t('community.events')}`, 'Zero events keeps the shortcut without a count suffix');
      sidebarFeed.snapshot.events = [{ ...event, status: 'scheduled' }];
      sidebarCommunity.render();
      check(sidebar.querySelector('[data-community=events]').textContent.includes(t('community.sidebarOneEvent'))
        && !sidebar.querySelector('[data-community=events] .community-sidebar-live-dot'),
      'One scheduled event uses the singular sidebar label without an active pulse');
      sidebarFeed.snapshot.events.push({ ...event, id: 'second', status: 'scheduled' });
      sidebarCommunity.render();
      check(sidebar.querySelector('[data-community=events]').textContent.includes(t('community.sidebarEventCount', { count: 2 })),
        'Multiple events use a localized count without parentheses');
      sidebarFeed.snapshot.events = [];
      sidebarCommunity.render();
      eventButton = sidebar.querySelector('[data-community=events]');
      const menu = sidebar.querySelector('#server-dropdown-menu');
      const toggle = sidebar.querySelector('#server-dropdown-toggle');
      toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await flush();
      check(document.activeElement.textContent === 'First', 'Server menu keyboard opening skips hidden permission-gated actions');
      const plainGap = menu.getBoundingClientRect().top - toggle.getBoundingClientRect().bottom;
      check(Math.abs(plainGap - 6) <= 1, 'Server menu has a six-pixel anchor gap without a banner');
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      check(document.activeElement.textContent === 'Last', 'Server menu supports keyboard navigation to its last action');
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      check(toggle.getAttribute('aria-expanded') === 'false' && document.activeElement === toggle,
        'Server menu Escape closes logically and restores its trigger');
      await flush();
      const toolbar = sidebar.querySelector('.community-toolbar');
      const heading = sidebar.querySelector('.category-title');
      check(eventButton.getBoundingClientRect().top - header.getBoundingClientRect().bottom <= 10,
        'Events begins within ten pixels of the server header');
      const headingGap = heading.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
      check(headingGap >= 0 && headingGap <= 16,
        `The first category stays close to the events divider (gap: ${headingGap}px)`);
      const headingStyle = getComputedStyle(heading.querySelector('.category-collapse-btn'));
      check(headingStyle.textTransform === 'uppercase' && headingStyle.fontSize === '11px' &&
        headingStyle.fontWeight === '700' && headingStyle.letterSpacing === '0.5px',
        'Collapsible headings retain the original channel title typography');
      yield 'sidebar-spacing';
      sidebarCommunity.setHeaderImage('/avatars/cover.png');
      toggle.click();
      await flush();
      check(Math.abs(menu.getBoundingClientRect().top - toggle.getBoundingClientRect().bottom - plainGap) <= 1,
        'Server menu keeps the same anchor gap after enabling the banner');
      sidebar.style.width = '320px';
      window.dispatchEvent(new Event('resize'));
      check(Math.abs(menu.getBoundingClientRect().width - toggle.getBoundingClientRect().width) <= 1,
        'Server menu follows its anchor width on resize');
      toggle.click();
      await flush();
      sidebar.style.width = '280px';
      check(Math.abs(header.querySelector('.server-dropdown-toggle').getBoundingClientRect().top - header.getBoundingClientRect().top - 8) < 1 &&
        header.getBoundingClientRect().height === 144,
        'The banner header gives its menu eight pixels of top breathing room without growing the banner');
      yield 'sidebar-banner-hover';
      const hover = getComputedStyle(header.querySelector('.server-dropdown-toggle'));
      check(hover.backdropFilter.includes('blur(') && /rgba\(.+,\s*0\.2\)/.test(hover.backgroundColor),
        'A real pointer hover over a banner uses blur and translucent background');
      sidebarCommunity.setHeaderImage(null);
      check(getComputedStyle(header.querySelector('.server-dropdown-toggle')).backdropFilter === 'none',
        'Removing the banner restores the normal server-menu hover');
    } finally {
      sidebarMain.unbindEvents.forEach(unbind => unbind());
      sidebarCommunity.destroy();
      sidebarFeed.dispose();
      sidebar.remove();
      mainRoot.hidden = false;
    }
  } finally {
    main.forumView?.destroy();
    main.chatView?.destroy();
    mainRoot.remove();
    root.hidden = false;
    sessionManager.getActive = originalSession;
    stores.setActiveServerStore(originalStore);
    chatStores.setActiveChatStore(originalChatStore);
    setActiveNetworkClient(originalClient);
    actualChatStore.clear();
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 600;
  const pixels = canvas.getContext('2d');
  pixels.fillStyle = 'red'; pixels.fillRect(0, 0, 600, 600);
  pixels.fillStyle = 'blue'; pixels.fillRect(600, 0, 600, 600);
  const cropControl = selector => document.querySelector('.modal-backdrop:not([data-ui-closing]) .crop-modal-card')?.querySelector(selector);
  for (const [shape, width, height] of [['banner', 1000, 400], ['avatar', 512, 512]]) {
    const crop = openImageCropper(canvas.toDataURL(), shape);
    await until(() => cropControl('[data-action=confirm]')?.disabled === false);
    if (shape === 'banner') {
      const mask = cropControl('.crop-mask').getBoundingClientRect();
      const viewport = cropControl('.crop-viewport').getBoundingClientRect();
      check(mask.top > viewport.top && mask.bottom < viewport.bottom && Math.abs(mask.width / mask.height - 2.5) < .01,
        'Banner crop has a centered 5:2 frame with visible image context');
      yield 'banner-crop';
      cropControl('[data-action=rotate]').click();
      await until(() => cropControl('[data-action=confirm]')?.disabled === false);
    }
    cropControl('[data-action=confirm]').click();
    const image = new Image();
    image.src = await crop;
    await image.decode();
    check(image.naturalWidth === width && image.naturalHeight === height, `${shape} crop has exact dimensions`);
    if (shape === 'banner') {
      const result = document.createElement('canvas'); result.width = width; result.height = height;
      const context = result.getContext('2d'); context.drawImage(image, 0, 0);
      check(context.getImageData(500, 20, 1, 1).data[0] === 255 && context.getImageData(500, 380, 1, 1).data[2] === 255,
        'Rotation changes the exported image, not only the preview');
    }
  }
  const resetCrop = openImageCropper(canvas.toDataURL(), 'banner');
  await until(() => cropControl('[data-action=rotate]')?.disabled === false);
  cropControl('[data-action=rotate]').click();
  await until(() => cropControl('[data-action=reset]')?.disabled === false);
  const zoom = cropControl('.crop-zoom-slider');
  zoom.value = '2'; zoom.dispatchEvent(new Event('input'));
  cropControl('[data-action=reset]').click();
  await until(() => cropControl('[data-action=confirm]')?.disabled === false);
  check(zoom.value === '1', 'Reset restores the initial zoom');
  cropControl('[data-action=confirm]').click();
  const resetImage = new Image(); resetImage.src = await resetCrop; await resetImage.decode();
  const resetCanvas = document.createElement('canvas'); resetCanvas.width = 1000; resetCanvas.height = 400;
  const resetContext = resetCanvas.getContext('2d'); resetContext.drawImage(resetImage, 0, 0);
  check(resetContext.getImageData(20, 200, 1, 1).data[0] === 255 && resetContext.getImageData(980, 200, 1, 1).data[2] === 255,
    'Reset restores the original rotation and crop');
  const cancelledBatch = openImageCropperBatch([canvas.toDataURL(), canvas.toDataURL()], 'banner');
  await until(() => cropControl('[data-action=confirm]')?.disabled === false);
  cropControl('[data-action=confirm]').click();
  await until(() => cropControl('.crop-counter')?.textContent.includes('2'));
  cropControl('[data-action=cancel]').click();
  check(await cancelledBatch === null
    && !document.querySelector('.modal-backdrop:not([data-ui-closing]) .crop-modal-card'),
    'Cancelling one batch image cancels the complete crop session without partial results');
  const pending = [];
  const raceListeners = new Set();
  const delayed = { ...client, onEvent: listener => { raceListeners.add(listener); return () => raceListeners.delete(listener); },
    sendRequest: () => new Promise(resolve => pending.push(resolve)) };
  const racing = new CommunityFeed(delayed, server);
  const first = racing.load();
  for (const listener of raceListeners) listener('message.CHANNEL_UPDATED', {});
  pending[0](snapshot);
  await first; await flush();
  check(pending.length === 2, 'Access changes queue a replacement load');
  pending[1]({ settings: snapshot.settings, events: [], liveActions: [] });
  await flush();
  check(racing.snapshot.events.length === 0, 'Stale private snapshots are not restored');
  racing.dispose();
  const searchRequests = [];
  const searchClient = { ...client,
    onEvent: () => () => {},
    sendRequest: (type, payload) => new Promise((resolve, reject) => searchRequests.push({ payload, resolve, reject })),
  };
  const searchForum = new ForumView(root, searchClient, server, 'forum', () => {});
  const searchInput = root.querySelector('[data-forum-search]');
  const searchLoading = root.querySelector('[data-forum-loading]');
  const searchPosts = root.querySelector('[data-forum-posts]');
  const searchResult = posts => ({ channelId: 'forum', posts, hasMore: false, nextOffset: posts.length });
  check(!searchLoading.hidden && !root.querySelector('.forum-empty-state'),
    'The first forum request shows skeletons without a premature empty result');
  searchRequests[0].resolve(searchResult([]));
  await flush();
  check(searchLoading.hidden && root.querySelector('.forum-empty-state strong')?.textContent === t('forum.emptyTitle'),
    'A loaded empty forum removes its initial skeletons');
  for (const query of ['F', 'Fo', 'Forum']) {
    const before = searchRequests.length;
    const retained = searchPosts.firstElementChild;
    searchInput.value = query;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    check(searchLoading.hidden && searchPosts.firstElementChild === retained,
      'Typing preserves the empty forum while the search debounce is pending');
    await until(() => searchRequests.length === before + 1);
    check(searchLoading.hidden && searchPosts.firstElementChild === retained
      && searchPosts.getAttribute('aria-busy') === 'true'
      && searchRequests.at(-1).payload.query === query,
    'Searching a loaded empty forum never appends fictitious thread skeletons');
    yield 'forum-empty-search-pending';
    searchRequests.at(-1).resolve(searchResult([]));
    await flush();
    check(searchLoading.hidden && searchPosts.getAttribute('aria-busy') === 'false'
      && root.querySelector('.forum-empty-state--search p')?.textContent === t('forum.noResults'),
    'An empty search remains stable after its response');
  }
  const populatedRefresh = searchForum.load();
  searchRequests.at(-1).resolve(searchResult([post]));
  await populatedRefresh;
  const retainedPost = searchPosts.firstElementChild;
  const refreshing = searchForum.load();
  check(searchLoading.hidden && searchPosts.firstElementChild === retainedPost
    && searchPosts.getAttribute('aria-busy') === 'true',
  'Refreshing loaded threads retains their cards without adding skeleton placeholders');
  searchRequests.at(-1).resolve(searchResult([]));
  await refreshing;
  const failedRefresh = searchForum.load();
  searchRequests.at(-1).reject(new Error('Controlled forum search failure'));
  await failedRefresh;
  check(searchLoading.hidden && searchPosts.getAttribute('aria-busy') === 'false'
    && root.querySelector('.forum-empty-state--search')
    && document.querySelector('.chat-copy-toast:not([data-ui-closing])'),
  'Search errors settle loading, retain the empty result and surface a shared error toast');
  searchForum.destroy();
  const forumPending = [], forumListeners = new Set();
  const forumClient = { ...client,
    onEvent: listener => { forumListeners.add(listener); return () => forumListeners.delete(listener); },
    sendRequest: () => new Promise(resolve => forumPending.push(resolve)),
  };
  const staleForum = new ForumView(root, forumClient, server, 'forum', () => {});
  for (const listener of forumListeners) listener('message.ROLES_LIST', {});
  forumPending[0]({ channelId: 'forum', posts: [post], hasMore: false, nextOffset: 1 });
  await flush();
  check(root.querySelectorAll('.forum-post-row').length === 0, 'Permission invalidation rejects pending private forum results immediately');
  await until(() => forumPending.length === 2);
  forumPending[1]({ channelId: 'forum', posts: [], hasMore: false, nextOffset: 0 });
  await flush();
  staleForum.destroy();
  check(forumListeners.size === 0, 'Pending forum listeners are removed on disposal');
  return checks;
}
