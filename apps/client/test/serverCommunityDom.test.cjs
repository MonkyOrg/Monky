const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('events, native actions, forums and banner cropping work in both locales', { timeout: 240000 }, async () => {
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
  const { recordFeed } = require('./fixtures/feedRecorder.cjs');
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
          // Chat attachments only resolve from the server's own `/attachments/` path.
          const forumImage = /^\/attachments\/forum-([0-9a-f]{6})\.svg$/.exec(request.url);
          if (forumImage) {
            response.setHeader('Content-Type', 'image/svg+xml');
            response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#${forumImage[1]}"/></svg>`);
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
    browser = new BrowserWindow({ show: false, width: 800, height: 600,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    browser.webContents.debugger.attach('1.3');
    timeout = setTimeout(() => { console.error('Community DOM timeout'); void finish(1); }, 210000);
    for (const locale of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__community__`);
      await browser.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false,
      });
      await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      const inviteModule = '/@fs/' + path.resolve(root, '..', '..', 'packages', 'shared', 'src', 'serverInvites.ts').replaceAll('\\', '/');
      await browser.webContents.executeJavaScript(`window.recordFeed = ${recordFeed}; void 0`);
      await browser.webContents.executeJavaScript(`window.communityRegression = (${regression.toString()})(${JSON.stringify(locale)}, ${JSON.stringify(inviteModule)}); void 0`);
      for (;;) {
        const step = await browser.webContents.executeJavaScript('window.communityRegression.next().catch(error => ({ failure: error.stack || String(error) }))', true);
        if (step.failure) throw new Error(step.failure);
        if (step.done) { console.log(`Community DOM (${locale}): ${step.value} checks`); break; }
        if (process.env.MONKY_COMMUNITY_TRACE) console.log(`Community step (${locale}): ${step.value}`);
        if (['event-step-reduced-motion', 'event-step-motion-enabled',
          'poll-step-reduced-motion', 'poll-step-motion-enabled',
          'form-step-reduced-motion', 'form-step-motion-enabled',
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
        if (step.value === 'keyboard-enter') {
          // A native Enter, as a keyboard user would press it, delivered to whatever holds focus.
          browser.focus();
          browser.webContents.focus();
          await browser.webContents.executeJavaScript(`window.communityKeyDelivery = new Promise((resolve, reject) => {
            const received = event => {
              if (!event.isTrusted || event.key !== 'Enter') return;
              clearTimeout(timer);
              window.removeEventListener('keyup', received, true);
              resolve();
            };
            const timer = setTimeout(() => {
              window.removeEventListener('keyup', received, true);
              reject(new Error('Native Enter was not delivered to ' + document.activeElement?.outerHTML));
            }, 5000);
            window.addEventListener('keyup', received, true);
          }); void 0`);
          browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          browser.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
          browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          await browser.webContents.executeJavaScript('window.communityKeyDelivery');
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value === 'keyboard-tab' || step.value === 'keyboard-shift-tab') {
          // A native Tab moves focus as the browser does; a dispatched event would not move it at all.
          const modifiers = step.value === 'keyboard-shift-tab' ? ['shift'] : [];
          browser.focus();
          browser.webContents.focus();
          await browser.webContents.executeJavaScript(`window.communityKeyDelivery = new Promise((resolve, reject) => {
            const received = event => {
              if (!event.isTrusted || event.key !== 'Tab') return;
              clearTimeout(timer);
              window.removeEventListener('keyup', received, true);
              resolve();
            };
            const timer = setTimeout(() => {
              window.removeEventListener('keyup', received, true);
              reject(new Error('Native Tab was not delivered to ' + document.activeElement?.outerHTML));
            }, 5000);
            window.addEventListener('keyup', received, true);
          }); void 0`);
          browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers });
          browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers });
          await browser.webContents.executeJavaScript('window.communityKeyDelivery');
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
          const { model } = await browser.webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId: nodeIds[0] })
            .catch(async error => {
              const state = await browser.webContents.executeJavaScript(`(() => {
                const root = document.querySelector('[data-resource-audience=poll-audience]');
                const popup = root?.querySelector('[data-audience-popup]');
                const search = root?.querySelector('[data-audience-search]');
                const box = search?.getBoundingClientRect();
                return { popupHidden: popup?.hidden, popoverOpen: popup?.matches(':popover-open'),
                  expanded: root?.querySelector('[data-audience-toggle]')?.getAttribute('aria-expanded'),
                  value: search?.value, focused: document.activeElement === search,
                  searchBox: box && [box.left, box.top, box.width, box.height].map(Math.round),
                  stepScroll: document.querySelector('[data-poll-viewport]')?.scrollTop };
              })()`).catch(stateError => String(stateError));
              throw new Error(`${error.message} ${JSON.stringify(state)}`);
            });
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
  const { renderAttachments } = await import('/views/chat/channelMessage.ts');
  const { serverRailCallIcon } = await import('/views/ServerRailView.ts');
  const { ForumView } = await import('/views/ForumView.ts');
  const { openImageCropper, openImageCropperBatch } = await import('/views/ImageCropModal.ts');
  const { uploadAttachment } = await import('/core/AttachmentUploader.ts');
  const { openFileInputPicker, setButtonLoading } = await import('/utils/buttonLoading.ts');
  const { automaticScrollBehavior } = await import('/utils/scroll.ts');
  const { ProtocolRequestError, RequestTimeoutError, getActiveNetworkClient, setActiveNetworkClient } = await import('/core/NetworkClient.ts');
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
  const { preserveViewState } = await import('/utils/preserveViewState.ts');
  const focusList = document.createElement('div');
  const focusTitle = document.createElement('h2');
  document.body.append(focusTitle, focusList);
  const drawCards = ids => {
    focusList.innerHTML = `${ids.map(id => `<article data-card="${id}"><button type="button" data-act="menu">${id}</button>
      <button type="button" data-act="join">${id}</button></article>`).join('')}<input data-note value="caret">`;
  };
  const redrawCards = ids => preserveViewState(focusList, () => drawCards(ids),
    { itemKeys: ['data-card'], fallback: () => focusTitle });
  const cardButton = (id, act) => focusList.querySelector(`[data-card="${id}"] [data-act="${act}"]`);
  drawCards(['a', 'b', 'c']);
  cardButton('b', 'join').focus();
  redrawCards(['b', 'c']);
  check(document.activeElement === cardButton('b', 'join'),
    'A rebuilt list keeps focus in the same card after one above it leaves, not in the card now in its place');
  redrawCards(['c', 'b']);
  check(document.activeElement === cardButton('b', 'join'), 'A rebuilt list keeps focus in the same card when cards swap places');
  redrawCards(['c']);
  check(document.activeElement === focusTitle && focusTitle.getAttribute('tabindex') === '-1',
    'When the focused card leaves, focus goes to the fallback instead of the same button of another card');
  const note = focusList.querySelector('[data-note]');
  note.focus();
  note.setSelectionRange(2, 2);
  redrawCards(['c', 'd']);
  const rebuiltNote = focusList.querySelector('[data-note]');
  check(rebuiltNote !== note && document.activeElement === rebuiltNote && rebuiltNote.selectionStart === 2,
    'A control outside the cards is found again in the rebuilt markup with its caret');
  // A popup opened from a card keeps focus while its opener stays; once the opener is
  // rebuilt, focus lands on the same control of the same card.
  const surface = document.createElement('button');
  document.body.append(surface);
  surface.focus();
  preserveViewState(focusList, () => { focusList.querySelector('[data-note]').value = 'kept'; },
    { itemKeys: ['data-card'], fallback: () => focusTitle, origin: cardButton('d', 'menu') });
  check(document.activeElement === surface, 'A render that keeps the opener of a popup leaves focus in the popup');
  preserveViewState(focusList, () => { surface.remove(); drawCards(['c', 'd']); },
    { itemKeys: ['data-card'], fallback: () => focusTitle, origin: cardButton('d', 'menu') });
  check(document.activeElement === cardButton('d', 'menu'),
    'A render that replaces the opener of a closed popup moves focus to the same control of the same card');
  focusList.remove();
  focusTitle.remove();
  // Keyed lists rebuild only the items whose markup changed; the others keep their element.
  const { renderKeyedList } = await import('/utils/keyedList.ts');
  const keyedList = document.createElement('div');
  keyedList.innerHTML = 'Loading…';
  document.body.append(keyedList);
  const keyedCard = (id, label = id) => ({ key: `card:${id}`, html: `<article data-card="${id}"><button type="button">${label}</button></article>` });
  const keyedElement = id => keyedList.querySelector(`[data-card="${id}"]`);
  const keyedOrder = () => [...keyedList.childNodes].map(node => node instanceof Element ? node.dataset.card : `#${node.nodeType}`).join();
  renderKeyedList(keyedList, [keyedCard('a'), keyedCard('b'), keyedCard('c')]);
  const [firstA, firstB, firstC] = ['a', 'b', 'c'].map(keyedElement);
  check(keyedOrder() === 'a,b,c', 'A keyed list replaces whatever the container held before its first render');
  renderKeyedList(keyedList, [keyedCard('a'), keyedCard('b', 'B changed'), keyedCard('c')]);
  check(keyedElement('a') === firstA && keyedElement('c') === firstC && keyedElement('b') !== firstB
    && keyedElement('b').textContent === 'B changed', 'A keyed list rebuilds only the item whose markup changed');
  const rebuiltB = keyedElement('b');
  renderKeyedList(keyedList, [keyedCard('d'), keyedCard('c'), keyedCard('b', 'B changed')]);
  check(keyedOrder() === 'd,c,b' && keyedElement('c') === firstC && keyedElement('b') === rebuiltB && !firstA.isConnected,
    'A keyed list inserts, removes and reorders items without rebuilding the unchanged ones');
  keyedList.remove();
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
      // Infinite loops and the short decorative live pulse never move layout; waiting
      // for them would only stall the test.
      const active = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity
        && !animation.effect?.target?.classList?.contains('live-pulse-dot'));
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
  // A click as a mouse gives it: `detail` counts the clicks of one gesture, 2 for the second of a double click.
  const clickWithCount = (button, detail) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
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
  // Time-based budget: slow CI runners need more than 100 short polls.
  const until = async predicate => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Condition did not become true');
  };
  // Automatic scrolls start from rAF callbacks; slow runners can exceed a fixed quiet window before the first frame.
  const settleScroll = async element => {
    let lastScroll = element.scrollTop;
    let lastChange = performance.now();
    const noteScroll = () => { lastChange = performance.now(); };
    document.addEventListener('scroll', noteScroll, { capture: true });
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const started = performance.now();
      lastChange = Math.max(lastChange, started);
      for (;;) {
        if (element.scrollTop !== lastScroll) {
          lastScroll = element.scrollTop;
          lastChange = performance.now();
        }
        if (performance.now() - lastChange >= 200) return;
        if (performance.now() - started > 5000) throw new Error(`Scrolling did not settle: ${element.className}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      document.removeEventListener('scroll', noteScroll, { capture: true });
    }
  };
  const waitForQuietValue = async (read, description, { quietMs = 650, timeoutMs = 5000, tolerance = 1 } = {}) => {
    const started = performance.now();
    let last = read();
    let quietSince = performance.now();
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 20));
      const current = read();
      if (Math.abs(current - last) > tolerance) {
        last = current;
        quietSince = performance.now();
      } else if (performance.now() - quietSince >= quietMs) {
        return current;
      }
      if (performance.now() - started > timeoutMs) {
        throw new Error(`Value did not stay quiet for ${description}: ${JSON.stringify({ last, current })}`);
      }
    }
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
      { id: 'yes', label: 'Yes', emoji: '👍', votes: 2, voters: [
        { userId: 'owner', userNickname: 'Owner', userAvatarUrl: null },
        { userId: 'member', userNickname: 'Former nickname', userAvatarUrl: null },
      ] },
      { id: 'no', label: 'No', emoji: null, votes: 0, voters: [] },
    ],
    totalVotes: 2, maxVoters: 5, closesAt: now + 60_000, revision: 0, anonymousVotes: false,
    allowMultiple: true, imageUrls: ['/avatars/cover.png', '/avatars/cover.png'], allowChange: true, liveAction: true,
    closedAt: null, createdAt: now, myVoteOptionIds: ['yes'],
  };
  let pollRevision = 0;
  let pollVoteGate = null;
  let pollEditState = 'conflict';
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
  let allowed = true, rejectSubmit = true, interestedMode = 'normal', interestedGate, namedResults = false;
  let eventGetGate = null;
  // A failure that is not a refusal, such as a timeout, for the next EVENT_GET requests.
  let eventGetFailure = null;
  const deletedEvents = new Set();
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
      protocol: { version: 33, minimumVersion: 31, features: ['native-polls', 'native-live-forms', 'poll-voters', 'poll-edit'] }, channels: [
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
  // When set, the server's forum budget: 30 requests in any 10 s, per person, all devices together.
  let forumLimiter = null;
  // When set, pages after the first fail with its error, and the time of each failure is kept.
  let forumPageFailure = null;
  const client = {
    sessionKey: 'community-test', getStatus: () => 'CONNECTED', getHttpBaseUrl: () => window.location.origin,
    send(type, payload) { calls.push({ type, payload }); },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancelRequest(id) { cancelled.push(id); return true; },
    async sendRequest(type, payload, requestId) {
      calls.push({ type, payload, requestId });
      if (forumLimiter && type.startsWith('FORUM_')) {
        const sentAt = performance.now();
        forumLimiter.times = forumLimiter.times.filter(time => sentAt - time < 10_000);
        if (forumLimiter.times.length >= 30) throw new ProtocolRequestError('Too many forum requests.', 'RATE_LIMITED');
        forumLimiter.times.push(sentAt);
      }
      if (type === 'COMMUNITY_GET') return structuredClone(snapshot);
      if (type === 'EVENT_GET') {
        if (eventGetGate) await eventGetGate;
        if (eventGetFailure) throw eventGetFailure;
        // As the server answers for an event this member can no longer see.
        if (payload.id === 'missing' || deletedEvents.has(payload.id)) throw new ProtocolRequestError('Event unavailable', 'PERMISSION_DENIED');
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
      if (type === 'NATIVE_FORM_RESULTS' && namedResults) {
        return { id: payload.id, nextCursor: null, responses: [{
          user: { id: 'member', nickname: 'Named member', avatarUrl: '/avatars/named-member.png' },
          response: { values: { name: 'Named answer' }, createdAt: now, updatedAt: now },
        }] };
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
      if (type === 'POLL_VOTE') {
        if (pollVoteGate) await pollVoteGate;
        const owner = { userId: 'owner', userNickname: 'Owner', userAvatarUrl: null };
        return {
          ...poll, revision: ++pollRevision, myVoteOptionIds: payload.optionIds,
          totalVotes: payload.optionIds.length ? 2 : 1,
          options: poll.options.map(option => {
            const others = option.voters.filter(voter => voter.userId !== 'owner');
            const voters = payload.optionIds.includes(option.id) ? [owner, ...others] : others;
            return { ...option, voters, votes: voters.length };
          }),
        };
      }
      if (type === 'POLL_VOTERS') return {
        id: payload.id,
        options: poll.options.map(option => ({ id: option.id, voters: option.voters })),
      };
      if (type === 'POLL_GET') return pollEditState === 'refreshed'
        ? { ...structuredClone(poll), revision: 7, totalVotes: 3,
          options: poll.options.map(option => option.id === 'yes' ? { ...option, votes: 3 } : option) }
        : structuredClone(poll);
      if (type === 'POLL_EDIT') {
        if (pollEditState === 'conflict') {
          pollEditState = 'refreshed';
          throw Object.assign(new Error('Votes changed while the poll was being edited.'), { code: 'COMMUNITY_CONFLICT' });
        }
        return {
          ...poll, question: payload.question, revision: 50, totalVotes: 0, myVoteOptionIds: [],
          options: payload.options.map((option, index) => ({
            id: option.id ?? `edited-${index}`, label: option.label, emoji: option.emoji, votes: 0, voters: [],
          })),
        };
      }
      if (type === 'COMMUNITY_IMAGE_UPLOAD') {
        uploadedCommunityImages++;
        return {
          ref: `00000000-0000-4000-8000-${String(uploadedCommunityImages).padStart(12, '0')}`,
          url: `/avatars/community-test-${uploadedCommunityImages}.png`,
        };
      }
      if (type === 'FORUM_LIST') {
        if (payload.offset > 0 && forumListGate) await forumListGate;
        if (payload.offset > 0 && forumPageFailure) {
          forumPageFailure.times.push(performance.now());
          throw forumPageFailure.error;
        }
        // Pinned threads first, as the server orders them.
        const posts = [...forumPosts].sort((left, right) => (right.pinned - left.pinned) || (payload.sort === 'oldest'
          ? left.createdAt - right.createdAt
          : payload.sort === 'newest'
            ? right.createdAt - left.createdAt
            : right.updatedAt - left.updatedAt));
        // With a cursor, the page starts right after that place in the order, as the server does.
        const key = payload.sort === 'latest' ? 'updatedAt' : 'createdAt';
        const later = (entry, after) => entry.pinned !== after.pinned ? entry.pinned < after.pinned
          : entry[key] !== after.at ? (payload.sort === 'oldest' ? entry[key] > after.at : entry[key] < after.at)
            : entry.channelId > after.channelId;
        const start = payload.after ? posts.findIndex(entry => later(entry, payload.after)) : payload.offset ?? 0;
        const offset = start < 0 ? posts.length : start;
        const page = posts.slice(offset, offset + 25);
        const hasMore = offset + page.length < posts.length;
        const last = page.at(-1);
        return { channelId: 'forum', posts: page, hasMore, nextOffset: offset + page.length,
          ...(hasMore ? { nextCursor: { pinned: last.pinned, at: last[key], channelId: last.channelId } } : {}) };
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
  let railSignals = 0;
  const offRailSignal = appEvents.on('community.updated', () => { railSignals++; });
  emit('message.COMMUNITY_SNAPSHOT', { ...structuredClone(snapshot), polls: [{ ...structuredClone(poll), totalVotes: 3 }] });
  check(railSignals === 0, 'A vote is not announced app-wide, so the server rail is not rebuilt for it');
  emit('message.COMMUNITY_SNAPSHOT', { ...structuredClone(snapshot), events: [] });
  check(railSignals === 1, 'An active voice event ending still reaches the server rail call icon');
  emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
  offRailSignal();
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
  const liveSubmit = document.querySelector('[data-live-submit]');
  liveSubmit.focus();
  liveSubmit.click();
  check(document.querySelector('[data-live-submit]').disabled
    && document.activeElement === actionWizard.querySelector('.live-action-step > h2'),
  'Sending disables the live action submit button and moves focus to the form title instead of losing it');
  await flush();
  check(!document.querySelector('[data-live-submit]').disabled, 'Failed form response restores controls');
  check(document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])')?.getAttribute('role') === 'alert' && !document.querySelector('[data-community-error]'),
    'Form failure is explained in the alert toast, not in the layout');
  check(document.activeElement === actionWizard.querySelector('.live-action-step > h2'),
    'After a failed send, focus stays on the form title');
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
  await settleScroll(nativeFormScroller);
  nativeFormScroller.scrollTop = nativeFormScroller.scrollHeight;
  const answeringScrollTop = nativeFormScroller.scrollTop;
  const teamChoice = nativeFormModal.querySelector('[data-field-name=team] [data-bot-select-value=a]');
  teamChoice.focus({ preventScroll: true });
  teamChoice.click();
  check(teamChoice.isConnected && nativeFormScroller.isConnected && nativeFormScroller.scrollTop === answeringScrollTop
    && document.activeElement === teamChoice && teamChoice.getAttribute('aria-pressed') === 'true'
    && nativeFormModal.querySelector('[data-field-name=team] [data-bot-select-value=b]').getAttribute('aria-pressed') === 'false'
    && !nativeFormModal.querySelector('[data-field-name=team] .bot-field-clear').hidden,
  'Choosing a single answer marks it in place, keeping the scroll position and keyboard focus');
  const typedBio = nativeFormModal.querySelector('[name=bio]');
  typedBio.focus({ preventScroll: true });
  typedBio.value = 'Half typed';
  typedBio.dispatchEvent(new Event('input', { bubbles: true }));
  typedBio.setSelectionRange(4, 4);
  nativeForm.responseCount++;
  emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
  check(typedBio.isConnected && document.activeElement === typedBio && typedBio.value === 'Half typed'
    && typedBio.selectionStart === 4 && nativeFormScroller.scrollTop === answeringScrollTop,
  'Another member\'s response does not rebuild the questions while this member is typing');
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
  const nativeSubmit = nativeFormModal.querySelector('[data-native-form-submit]');
  nativeSubmit.focus();
  nativeSubmit.click();
  check(nativeFormModal.querySelector('[data-native-form-submit]').disabled
    && document.activeElement === nativeFormModal.querySelector('.native-form-action-header h2'),
  'Sending disables the native form submit button and moves focus to the form title instead of losing it');
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
  const otherDevice = name => {
    nativeForm.myResponse = { ...nativeForm.myResponse, values: { ...nativeForm.myResponse.values, name },
      updatedAt: nativeForm.myResponse.updatedAt + 1 };
    emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
  };
  otherDevice('Sent elsewhere');
  const reopenedName = document.querySelector('.live-action-wizard [name=name]');
  check(reopenedName.value === 'Sent elsewhere', 'An answer sent from another device replaces a form left untouched here');
  reopenedName.value = 'Edited here';
  reopenedName.dispatchEvent(new Event('input', { bubbles: true }));
  otherDevice('Arrived later');
  check(reopenedName.isConnected && reopenedName.value === 'Edited here',
    'Answers edited and not yet sent survive later snapshots, including this member\'s own');
  const reopenedForm = document.querySelector('.live-action-wizard');
  reopenedForm.querySelector('[data-field-name=rating] .bot-field-clear').focus();
  emit('message.COMMUNITY_SNAPSHOT', { ...structuredClone(snapshot), nativeForms: [{
    ...structuredClone(nativeForm), revision: nativeForm.revision + 1,
    form: { ...structuredClone(nativeForm.form),
      fields: [{ name: 'intro', label: 'Intro', type: 'text' }, ...structuredClone(nativeForm.form.fields)] },
  }] });
  check(reopenedForm.querySelector('[data-field-name=intro]')
    && document.activeElement === reopenedForm.querySelector('[data-field-name=rating] .bot-field-clear')
    && reopenedForm.querySelector('[name=name]').value === 'Edited here',
  'A question added above keeps focus on the same control of the same question, and unsent answers stay');
  emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
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
  namedResults = true;
  document.querySelector('[data-live-action-menu=form]').click();
  [...document.querySelectorAll('[role=menuitem]')]
    .find(item => item.textContent.includes(t('liveForm.viewResults', { count: nativeForm.responseCount }))).click();
  await flush();
  const namedResultsModal = document.querySelector('.native-live-form-results-modal');
  namedResultsModal.querySelector('[data-native-form-results-tab=individual]').click();
  const respondentAvatar = namedResultsModal.querySelector('.native-live-form-results-person img');
  check(respondentAvatar?.getAttribute('src') === `${location.origin}/avatars/named-member.png`
    && respondentAvatar.dataset.fallback === 'avatar',
  'Named results load each respondent avatar from the server instead of an address relative to the app files');
  namedResultsModal.querySelector('[data-community-close]').click();
  namedResults = false;
  await flush();
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
  const yesVoters = livePollModal.querySelector('[data-native-poll-voters-option=yes]');
  const yesOption = livePollModal.querySelector('[data-native-poll-option=yes]');
  const noTally = livePollModal.querySelector('[data-native-poll-option=no]').nextElementSibling;
  const avatarsBox = yesVoters?.querySelector('.native-poll-voter-avatars')?.getBoundingClientRect();
  const yesCount = yesVoters?.querySelector('[data-native-poll-count]');
  check(!livePollModal.querySelector('[data-native-poll-confirm]')
    && yesVoters?.querySelectorAll('.native-poll-voter-avatar').length === 2
    && yesVoters.dataset.tooltip === `Yes\nOwner, Audience Member`
    && yesCount?.textContent === '2' && yesCount.getBoundingClientRect().left >= avatarsBox.right
    && Math.abs(yesCount.getBoundingClientRect().top + yesCount.offsetHeight / 2 - (avatarsBox.top + avatarsBox.height / 2)) <= 2
    && !livePollModal.querySelector('[data-native-poll-voters-option=no]')
    && noTally?.querySelector('[data-native-poll-count]')?.textContent === '0'
    && noTally.getBoundingClientRect().right === yesVoters.getBoundingClientRect().right
    && yesVoters.getBoundingClientRect().left >= yesOption.getBoundingClientRect().right
    && livePollModal.querySelector('[data-native-poll-option=no]').getBoundingClientRect().width
      === yesOption.getBoundingClientRect().width
    && !livePollModal.querySelector('.native-poll-options').textContent.includes('%')
    && !livePollModal.querySelector('.native-poll-option-check, .native-poll-option .material-symbols-outlined')
    && livePollModal.querySelector('.native-poll-view-votes')?.textContent.includes(t('poll.viewVotes')),
  'Like WhatsApp, each answer shows its voters\' avatars beside the vote count on the right, with no check or percentage');
  // #842: someone else's vote reaches the open live action without a new community snapshot.
  const snapshotsBeforeVote = calls.filter(call => call.type === 'COMMUNITY_GET').length;
  const otherVote = structuredClone(poll);
  otherVote.revision = 1;
  otherVote.myVoteOptionIds = null;
  otherVote.totalVotes = 3;
  otherVote.options[1] = { ...otherVote.options[1], votes: 1, voters: [{ userId: 'guest', userNickname: 'Guest', userAvatarUrl: null }] };
  emit('message.POLL_UPDATED', otherVote);
  await flush();
  check(livePollModal.querySelector('[data-native-poll-option=no]').nextElementSibling
    ?.querySelector('[data-native-poll-count]')?.textContent === '1'
    && livePollModal.querySelector('[data-native-poll-option=yes]').getAttribute('aria-pressed') === 'true'
    && feed.snapshot.polls[0].myVoteOptionIds?.join(',') === 'yes'
    && calls.filter(call => call.type === 'COMMUNITY_GET').length === snapshotsBeforeVote,
  'A vote broadcast updates the live-action poll in place, keeps this member\'s own vote and asks for no snapshot');
  emit('message.POLL_UPDATED', { ...structuredClone(poll), revision: 0, totalVotes: 9 });
  await flush();
  check(feed.snapshot.polls[0].totalVotes === 3, 'An older poll revision never replaces a newer one');
  // Back to the fixture's tally, at the revision the feed now holds.
  poll.revision = 1;
  pollRevision = 1;
  emit('message.POLL_UPDATED', structuredClone(poll));
  await flush();
  const voteCallsBefore = calls.filter(call => call.type === 'POLL_VOTE').length;
  let releaseVote;
  pollVoteGate = new Promise(resolve => { releaseVote = resolve; });
  livePollModal.querySelector('[data-native-poll-option=no]').focus();
  livePollModal.querySelector('[data-native-poll-option=no]').click();
  livePollModal.querySelector('[data-native-poll-option=yes]').click();
  check(calls.filter(call => call.type === 'POLL_VOTE').length === voteCallsBefore + 1
    && calls.filter(call => call.type === 'POLL_VOTE').at(-1).payload.optionIds.join(',') === 'yes,no'
    && livePollModal.querySelector('.native-poll').getAttribute('aria-busy') === 'true'
    && livePollModal.querySelector('[data-native-poll-option=no]').getAttribute('aria-pressed') === 'true'
    && livePollModal.querySelector('[data-native-poll-option=no]').getAttribute('aria-disabled') === 'true'
    && !livePollModal.querySelector('[data-native-poll-confirm]')
    && document.activeElement === livePollModal.querySelector('[data-native-poll-option=no]'),
  'A click immediately adds the answer to the vote and ignores further clicks until the server confirms it');
  pollVoteGate = null;
  releaseVote();
  await until(() => !livePollModal.querySelector('.native-poll').hasAttribute('aria-busy'));
  const noFill = livePollModal.querySelector('[data-native-poll-fill=no]');
  const growth = noFill.getAnimations()[0]?.effect.getKeyframes().map(frame => frame.transform);
  check(growth?.[0] === 'scaleX(0)' && growth?.[1] === 'scaleX(0.5)'
    && livePollModal.querySelector('[data-native-poll-fill=yes]').getAnimations().length === 0,
  'A new vote grows its bar from the previous fill, and unchanged bars stay still');
  await flush();
  check(!livePollModal.querySelector('.native-poll').hasAttribute('aria-busy')
    && livePollModal.querySelector('[data-native-poll-option=no]').classList.contains('native-poll-option--selected')
    && livePollModal.querySelector('[data-native-poll-voters-option=no]')
    && document.activeElement === livePollModal.querySelector('[data-native-poll-option=no]'),
  'The confirmed vote renders the personalized response and keeps keyboard focus on the answer');
  livePollModal.querySelector('[data-native-poll-option=yes]').click();
  await until(() => livePollModal.querySelector('[data-native-poll-option=yes]').getAttribute('aria-pressed') === 'false'
    && !livePollModal.querySelector('.native-poll').hasAttribute('aria-busy'));
  const shrink = livePollModal.querySelector('[data-native-poll-fill=yes]').getAnimations()[0]?.effect.getKeyframes()
    .map(frame => frame.transform);
  check(shrink?.[0] === 'scaleX(1)' && shrink?.[1] === 'scaleX(0.5)',
    'Removing a vote shrinks its bar from the previous fill');
  await flush();
  check(calls.filter(call => call.type === 'POLL_VOTE').at(-1).payload.optionIds.join(',') === 'no'
    && livePollModal.querySelector('[data-native-poll-option=yes]').getAttribute('aria-pressed') === 'false'
    && livePollModal.querySelector('[data-native-poll-voters-option=yes]')?.dataset.tooltip === 'Yes\nAudience Member',
  'Clicking a chosen answer again removes it from the vote');
  livePollModal.querySelector('[data-native-poll-option=no]').click();
  await flush();
  check(calls.filter(call => call.type === 'POLL_VOTE').at(-1).payload.optionIds.length === 0
    && livePollModal.querySelectorAll('[data-native-poll-option][aria-pressed=true]').length === 0,
  'Removing the last answer withdraws the vote');
  server.serverDetails.protocol.features = server.serverDetails.protocol.features.filter(feature => feature !== 'poll-voters');
  livePollModal.querySelector('[data-native-poll-option=yes]').click();
  await flush();
  document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
  const votesBeforeLegacyWithdraw = calls.filter(call => call.type === 'POLL_VOTE').length;
  livePollModal.querySelector('[data-native-poll-option=yes]').click();
  await flush();
  check(calls.filter(call => call.type === 'POLL_VOTE').length === votesBeforeLegacyWithdraw
    && document.querySelector('.chat-copy-toast:not([data-ui-closing]) .chat-copy-toast-label')?.textContent
      === t('poll.withdrawRequiresUpdate'),
  'Servers without vote withdrawal keep the last answer and explain why');
  server.serverDetails.protocol.features.push('poll-voters');
  document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
  livePollModal.querySelector('[data-native-poll-voters-option=yes]').click();
  await until(() => document.querySelector('.native-poll-voters-modal [data-native-poll-voter]'));
  const votersModal = document.querySelector('.native-poll-voters-modal');
  check(calls.filter(call => call.type === 'POLL_VOTERS').at(-1).payload.id === 'poll'
    && [...votersModal.querySelectorAll('[data-native-poll-voters-group=yes] [data-native-poll-voter]')]
      .map(item => item.textContent.trim()).join(',') === 'Owner,Audience Member'
    && votersModal.querySelector('[data-native-poll-voters-group=no] .native-poll-voters-empty')?.textContent === t('poll.noVotersForOption'),
  'The votes list shows every voter per answer with current member names');
  votersModal.closest('.modal-backdrop').querySelector('[data-community-close]').click();
  await flush();
  document.querySelector('.live-action-detail-modal [data-community-close]').click();
  await flush();
  document.querySelector('[data-live-poll-card=poll] [data-live-action-menu=poll]').click();
  await flush();
  pollEditState = 'conflict';
  const editPollItem = [...document.querySelectorAll('[role=menuitem]')]
    .find(item => item.textContent.includes(t('poll.edit')));
  check(editPollItem, 'The poll creator finds Edit poll in the live poll menu');
  editPollItem.click();
  await flush();
  await until(() => document.querySelector('.native-poll-wizard'));
  check(calls.filter(call => call.type === 'POLL_GET').at(-1)?.payload.id === 'poll',
    'Editing starts from the requester\'s current view of the poll');
  const editWizard = document.querySelector('.native-poll-wizard');
  const editField = (selector, value) => {
    const node = editWizard.querySelector(selector);
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const shown = key => !editWizard.querySelector(`[data-poll-warning="${key}"]`).hidden
    && !editWizard.querySelector(`[data-poll-warning="${key}"]`).hasAttribute('data-ui-closing');
  check(editWizard.querySelector('.modal-title').textContent === t('poll.editTitle')
    && editWizard.querySelector('[data-poll-question]').value === 'Native poll'
    && [...editWizard.querySelectorAll('[data-poll-option]')].map(node => node.value).join(',') === 'Yes,No'
    && editWizard.querySelector('[data-poll-multiple]').checked
    && editWizard.querySelector('.native-poll-edit-notice')?.textContent.includes(t('poll.editRules'))
    && !shown('question') && !shown('option-0'),
  'Editing opens the same steps prefilled and states up front which changes reset votes');
  editField('[data-poll-option][data-option-index="0"]', 'Yes please');
  check(shown('option-0') && !shown('option-1')
    && editWizard.querySelector('[data-poll-warning="option-0"]').textContent.includes(t('poll.editWarnOption', { count: 2 })),
  'Changing an answer warns that only its votes will be reset');
  editField('[data-poll-question]', 'Native poll, edited');
  check(shown('question') && !shown('option-0'),
    'Changing the question warns that every vote resets, which supersedes the answer warning');
  editField('[data-poll-question]', 'Native poll');
  editWizard.querySelector('[data-poll-next]').click();
  await flush();
  check(editWizard.querySelector('[data-poll-duration]').value !== ''
    && editWizard.querySelector('[data-poll-limit]').value === '5'
    && editWizard.querySelector('.native-poll-edit-duration')?.textContent.length > 0
    && editWizard.querySelectorAll('.native-poll-image-editor .image-carousel-slide').length === 2,
  'Settings, deadline and images of the running poll are prefilled');
  editWizard.querySelector('[data-poll-next]').click();
  await flush();
  const lossText = t('poll.editLossChanged', { option: 'Yes', count: 2 });
  check(editWizard.querySelector('.native-poll-edit-summary--loss')?.textContent.includes(lossText)
    && editWizard.querySelector('[data-poll-submit]')?.textContent.trim() === t('poll.saveChanges'),
  'The last step summarizes the votes that saving will reset');
  editWizard.querySelector('[data-poll-submit]').click();
  await flush();
  check(document.querySelector('.dialog-message')?.textContent.includes(lossText)
    && calls.filter(call => call.type === 'POLL_EDIT').length === 0,
  'Saving asks for confirmation before resetting votes');
  document.querySelector('[data-action=confirm]').click();
  await flush();
  const refreshedLoss = t('poll.editLossChanged', { option: 'Yes', count: 3 });
  check(calls.filter(call => call.type === 'POLL_EDIT').at(-1)?.payload.expectedRevision === poll.revision
    && document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])')?.textContent.includes(t('poll.editChanged'))
    && editWizard.querySelector('.native-poll-edit-summary--loss')?.textContent.includes(refreshedLoss)
    && editWizard.querySelector('[data-poll-option]') === null,
  'Votes cast while editing are never discarded unseen: the wizard reloads them and shows the new effects');
  editWizard.querySelector('[data-poll-submit]').click();
  await flush();
  check(document.querySelector('.dialog-message')?.textContent.includes(refreshedLoss),
    'Saving again confirms the updated loss');
  document.querySelector('[data-action=confirm]').click();
  await flush();
  const pollEdit = calls.filter(call => call.type === 'POLL_EDIT').at(-1)?.payload;
  check(pollEdit?.id === 'poll' && pollEdit.question === 'Native poll' && pollEdit.expectedRevision === 7
    && pollEdit.options.map(option => `${option.id}:${option.label}`).join(',') === 'yes:Yes please,no:No'
    && !('durationMinutes' in pollEdit) && pollEdit.maxVoters === 5 && pollEdit.liveAction === true
    && pollEdit.images.length === 2 && pollEdit.images[0] === '/avatars/cover.png'
    && !document.querySelector('.native-poll-wizard'),
  'The edit keeps answer ids, an untouched deadline and the current images');
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
  const multipleRow = document.querySelector('.native-poll-multiple-row');
  const anonymousRow = document.querySelector('.native-poll-anonymous-row');
  const multipleTitle = multipleRow.querySelector('label[for]');
  const fontOf = selector => getComputedStyle(document.querySelector(selector)).font;
  check(Math.abs(anonymousRow.getBoundingClientRect().top - multipleRow.getBoundingClientRect().bottom) <= 1
    && Math.abs(multipleTitle.getBoundingClientRect().top - multipleRow.getBoundingClientRect().top
      - parseFloat(getComputedStyle(multipleRow).paddingTop)) <= 1
    && fontOf('[data-poll-question]') === fontOf('[data-poll-option][data-option-index="0"]')
    && fontOf('.native-poll-option-editor legend') === getComputedStyle(document.querySelector('[data-poll-question]').closest('label')).font,
  'Poll switches stack as one list without extra label spacing, and answers use the same fonts as the question');
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
  const anonymous = document.querySelector('[data-poll-anonymous][role=switch]');
  check(anonymous && !anonymous.checked && anonymous.closest('.toggle-switch'),
    'Servers with poll voters offer an anonymous-votes switch that starts off');
  anonymous.checked = true;
  anonymous.dispatchEvent(new Event('change', { bubbles: true }));
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
    .querySelector('[data-number-step="1"]').click();
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
  await settleScroll(document.querySelector('[data-poll-viewport]'));
  pollAudience.querySelector('[data-audience-toggle]').click();
  // Measured where the dropdown rests, after its entrance motion.
  await flush();
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
  // The popup re-anchors on the next frames after its content shrinks; the native click must target its final position.
  const pollAudiencePopup = pollAudience.querySelector('[data-audience-popup]');
  let pollAudiencePopupTop = NaN;
  for (let stableFrames = 0, frames = 0; stableFrames < 3; frames++) {
    if (frames > 120) throw new Error('The audience dropdown did not settle before clearing its search');
    await new Promise(requestAnimationFrame);
    const top = pollAudiencePopup.getBoundingClientRect().top;
    stableFrames = top === pollAudiencePopupTop ? stableFrames + 1 : 0;
    pollAudiencePopupTop = top;
  }
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
    && document.querySelector('.native-poll-preview-surface').textContent.includes(t('poll.multipleAllowed'))
    && document.querySelector('.native-poll-preview-surface .native-poll-anonymous')?.textContent.includes(t('poll.anonymousBadge'))
    && !document.querySelector('.native-poll-preview-surface .native-poll-view-votes'),
  'The final step previews the poll with its multiple-answer and anonymous behavior');
  const pollPreviewCard = document.querySelector('.native-poll-preview-surface .native-poll').getBoundingClientRect();
  const pollPreviewImage = document.querySelector('.native-poll-preview-surface .image-carousel').getBoundingClientRect();
  check(Math.abs(pollPreviewImage.left - pollPreviewCard.left) <= 3
    && Math.abs(pollPreviewImage.right - pollPreviewCard.right) <= 3,
  'Poll preview images fill the card from edge to edge');
  check(document.querySelector('[data-poll-submit]').disabled,
    'Publish waits for the preview to slide in');
  await flush();
  // Publishing from the keyboard: a real Enter on the focused button, which the double-click guard lets through.
  const pollsBeforeEnter = calls.filter(call => call.type === 'POLL_CREATE').length;
  document.querySelector('[data-poll-submit]').focus();
  yield 'keyboard-enter';
  await flush();
  check(calls.filter(call => call.type === 'POLL_CREATE').length === pollsBeforeEnter + 1,
    'A real Enter on Publish publishes the poll');
  const creation = calls.filter(call => call.type === 'POLL_CREATE').at(-1);
  check(creation.payload.maxVoters === 2 && creation.payload.durationMinutes === undefined
    && creation.payload.liveAction && creation.payload.allowMultiple && creation.payload.options.length === 3
    && creation.payload.anonymousVotes === true
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
  // The three wizards share one frame: the stepper and the footer stay while the steps slide.
  const shellWizard = openNativePollWizard(client, server, 'text');
  const shellFooter = shellWizard.element.querySelector('.event-wizard-footer');
  const shellNext = shellWizard.element.querySelector('[data-poll-next]');
  const shellViewport = shellWizard.element.querySelector('[data-poll-viewport]');
  check(document.activeElement === shellWizard.element.querySelector('[data-poll-question]'),
    'The poll wizard opens with focus on its first field');
  input('[data-poll-question]', 'Shell poll');
  input('[data-poll-option][data-option-index="0"]', 'Yes');
  input('[data-poll-option][data-option-index="1"]', 'No');
  shellNext.click();
  const slideKeyframes = () => shellViewport.getAnimations({ subtree: true })
    .map(animation => animation.effect.getKeyframes()[0].transform);
  check(slideKeyframes().includes('translateX(100%)') && slideKeyframes().length === 2
    && shellViewport.querySelector('[data-poll-step="0"][data-ui-closing][inert][aria-hidden=true]')
    && shellViewport.firstElementChild.matches('[data-poll-step="1"]'),
  'Next slides the content step out while the appearance step comes in from the right');
  check(shellWizard.element.querySelector('.event-wizard-footer') === shellFooter && shellNext.isConnected
    && shellNext.disabled && document.activeElement === shellViewport.querySelector('[data-poll-step="1"] h2'),
  'The footer stays, Next waits for the slide and focus moves to the title of the new step');
  await flush();
  check(!shellNext.disabled && !shellViewport.querySelector('[data-ui-closing]'),
    'The slide lands without leaving the old step behind, and Next works again');
  yield 'keyboard-tab';
  check(document.activeElement === shellViewport.querySelector('[data-poll-step="1"] [data-carousel-dropzone]'),
    `Tab from the title of a new step goes on to its first field: ${document.activeElement?.outerHTML.slice(0, 120)}`);
  yield 'keyboard-shift-tab';
  check(document.activeElement === shellNext,
    `Shift+Tab from the first field wraps to the last control of the wizard: ${document.activeElement?.outerHTML.slice(0, 120)}`);
  shellNext.click();
  check(shellNext.hasAttribute('data-poll-submit') && !shellNext.hasAttribute('data-poll-next')
    && shellNext.textContent.trim() === t('poll.publish'),
  'On the last step the same button publishes');
  await flush();
  shellWizard.element.querySelector('[data-poll-back]').click();
  check(slideKeyframes().includes('translateX(-100%)'), 'Back slides the other way');
  await flush();
  yield 'poll-step-reduced-motion';
  shellWizard.element.querySelector('[data-poll-back]').click();
  check(shellViewport.getAnimations({ subtree: true }).length === 0 && shellViewport.childElementCount === 1
    && shellViewport.querySelector('[data-poll-step="0"]') && !shellNext.disabled
    && shellWizard.element.querySelector('[data-poll-question]').value === 'Shell poll',
  'With reduced motion the step changes at once, keeping the draft');
  // The footer stays put, so the second click of a double click lands on the button the first one
  // just changed. Without motion nothing holds the buttons back: that click itself must not count.
  const shellBack = shellWizard.element.querySelector('[data-poll-back]');
  const shellStep = () => Number(shellViewport.firstElementChild?.dataset.pollStep);
  const pollCreations = () => calls.filter(call => call.type === 'POLL_CREATE').length;
  const pollsBeforeDoubleClicks = pollCreations();
  clickWithCount(shellNext, 1);
  clickWithCount(shellNext, 2);
  check(shellStep() === 1 && shellNext.hasAttribute('data-poll-next') && !shellNext.disabled,
    `With reduced motion, a double click on Next moves one step, not two: step ${shellStep()}`);
  clickWithCount(shellNext, 1);
  check(shellStep() === 2 && shellNext.hasAttribute('data-poll-submit') && !shellNext.disabled,
    'With reduced motion, the preview is ready to publish as soon as it shows');
  clickWithCount(shellNext, 2);
  await flush();
  check(pollCreations() === pollsBeforeDoubleClicks && shellStep() === 2 && !shellWizard.signal.aborted,
    'With reduced motion, the second click of a double click on Next does not publish the preview it brought up');
  clickWithCount(shellBack, 1);
  clickWithCount(shellBack, 2);
  check(shellStep() === 1, `A double click on Back also moves one step: step ${shellStep()}`);
  yield 'poll-step-motion-enabled';
  clickWithCount(shellNext, 1);
  await flush();
  check(shellStep() === 2 && !shellNext.disabled && !shellViewport.querySelector('[data-ui-closing]'),
    'With motion, the preview lands and Publish works again');
  clickWithCount(shellNext, 2);
  await flush();
  check(pollCreations() === pollsBeforeDoubleClicks && !shellWizard.signal.aborted,
    'With motion, the second click of a double click slower than the slide does not publish the preview either');
  appEvents.emit('session.changed', { key: 'another-server' });
  check(shellWizard.signal.aborted && !shellWizard.element.isConnected,
    'A poll draft leaves at once when the visible server changes');
  // The form wizard publishes through the same frame: a double click stops at its preview, a new click publishes.
  const { openNativeLiveFormWizard } = await import('/views/NativeLiveFormWizard.ts');
  yield 'form-step-reduced-motion';
  const doubleClickForm = openNativeLiveFormWizard(client, server, 'text');
  const formPrimary = doubleClickForm.element.querySelector('[data-live-form-next]');
  const formCreations = () => calls.filter(call => call.type === 'NATIVE_FORM_CREATE');
  const formsBeforeDoubleClick = formCreations().length;
  input('[data-live-form-title]', 'Double click form');
  clickWithCount(formPrimary, 1);
  input('[data-live-form-field-label]', 'Name');
  clickWithCount(formPrimary, 1);
  check(formPrimary.hasAttribute('data-live-form-submit') && !formPrimary.disabled && formCreations().length === formsBeforeDoubleClick,
    'With reduced motion, the native form preview is ready to publish as soon as it shows');
  clickWithCount(formPrimary, 2);
  await flush();
  check(formCreations().length === formsBeforeDoubleClick && !doubleClickForm.signal.aborted,
    'The second click of a double click on Next does not publish the native form it brought up');
  clickWithCount(formPrimary, 1);
  await flush();
  check(formCreations().length === formsBeforeDoubleClick + 1 && formCreations().at(-1).payload.form.title === 'Double click form'
    && formCreations().at(-1).payload.form.fields[0].label === 'Name' && doubleClickForm.signal.aborted,
  'A new click on Publish creates the native form and closes its wizard');
  yield 'form-step-motion-enabled';
  const { EventBus } = await import('/core/EventBus.ts');
  const wizardServer = { ...server, bus: new EventBus(), communityEventsEnabled: true };
  const escapeWizard = openNativePollWizard(client, wizardServer, 'text');
  input('[data-poll-question]', 'Escape poll');
  input('[data-poll-option][data-option-index="0"]', 'Yes');
  input('[data-poll-option][data-option-index="1"]', 'No');
  document.querySelector('[data-poll-next]').click();
  await flush();
  const wizardDuration = escapeWizard.element.querySelector('[data-poll-duration]');
  wizardDuration.focus({ preventScroll: true });
  wizardServer.bus.emit('community.updated');
  check(wizardDuration.isConnected && document.activeElement === wizardDuration,
    'Community updates that leave live actions as they were do not rebuild the poll step being typed in');
  wizardServer.communityEventsEnabled = false;
  wizardServer.bus.emit('community.updated');
  check(escapeWizard.element.querySelector('[data-poll-live]').disabled
    && document.activeElement === escapeWizard.element.querySelector('[data-poll-duration]'),
  'Live actions being switched off updates the step without moving keyboard focus');
  const escapePrivate = escapeWizard.element.querySelector('[data-resource-audience=poll-audience] [data-audience-private]');
  escapePrivate.checked = true;
  escapePrivate.dispatchEvent(new Event('change', { bubbles: true }));
  const escapeToggle = escapeWizard.element.querySelector('[data-resource-audience=poll-audience] [data-audience-toggle]');
  escapeToggle.click();
  const escapeSearch = escapeWizard.element.querySelector('[data-resource-audience=poll-audience] [data-audience-search]');
  check(document.activeElement === escapeSearch && escapeToggle.getAttribute('aria-expanded') === 'true',
    'The audience dropdown opens with focus in its search');
  escapeSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(!escapeWizard.signal.aborted && escapeToggle.getAttribute('aria-expanded') === 'false'
    && document.activeElement === escapeToggle,
  'Escape in the audience search closes only its dropdown and keeps the poll draft open');
  escapeToggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(escapeWizard.signal.aborted, 'With the dropdown closed, Escape still closes the wizard');
  await flush();
  root.querySelector('[data-community=actions]').click();
  [...document.querySelectorAll('.live-action-list-modal [data-create-live-action]')].at(-1).click();
  await flush();
  [...document.querySelectorAll('.live-action-create-modal [data-live-action-type=form]')].at(-1).click();
  await flush();
  check(document.querySelector('.native-live-form-wizard'), 'Create live action opens the form wizard from the list');
  view.destroy();
  await flush();
  check(!document.querySelector('.community-modal'), 'All activity dialogs close on teardown, wizards opened from them included');
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
  check(!document.querySelector('[data-event-next]').disabled, 'Wizard keeps Next actionable so validation can explain missing data');
  document.querySelector('[data-event-next]').click();
  check(document.querySelector('.chat-copy-toast--danger')?.textContent.includes(t('community.locationRequired'))
    && document.querySelector('.community-location-cards').getAttribute('aria-invalid') === 'true',
  'Missing location uses a danger toast and highlights the relevant control');
  const locationOptions = [...document.querySelectorAll('[data-location]')].map(node => node.getBoundingClientRect());
  check(locationOptions[1].top >= locationOptions[0].bottom, 'Location cards are stacked like the reference');
  document.querySelector('[data-location=channel]').click();
  check(!document.querySelector('[data-event-next]').disabled, 'Channel validation remains actionable before a channel is selected');
  const channelSelect = () => document.querySelector('[data-input=channel]');
  document.querySelector('[data-channel-type=text]').click();
  check([...channelSelect().options].some(option => option.value === 'text')
    && ![...channelSelect().options].some(option => option.value === 'event-thread'),
  'Event locations include real text channels but exclude forum threads');
  document.querySelector('[data-channel-type=voice]').click();
  document.querySelector('[data-event-next]').click();
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
  document.querySelector('[data-event-next]').click();
  check(document.querySelector('.event-step-viewport').getAnimations({ subtree: true }).length >= 2,
    'Advancing runs the incoming and outgoing slides inside the fixed-height wizard');
  yield 'event-step-forward-motion';
  yield 'event-step-reduced-motion';
  // Only the step's own motion: a field the slide brought under the resting pointer still fades its hover color.
  const stillRunning = document.querySelector('.event-step-viewport').getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' && !(animation instanceof CSSTransition));
  check(!stillRunning.length,
    `Enabling reduced motion during a step transition immediately settles its final state: ${JSON.stringify(stillRunning
      .map(animation => [animation.effect.target?.outerHTML.slice(0, 100), animation.effect.getKeyframes().at(-1)]))}`);
  check(automaticScrollBehavior() === 'instant',
    'Reduced motion makes automatic scrolling settle immediately');
  check(document.querySelector('.event-wizard') === wizardShell && wizardShell.querySelector('.community-steps') === wizardStepper
    && wizardShell.querySelector('.event-wizard-footer') === wizardFooter, 'Step changes preserve the wizard shell, stepper and footer');
  const stillDurations = element => getComputedStyle(element).transitionDuration.split(',').every(value => parseFloat(value) === 0);
  const reducedCarousel = document.createElement('div');
  reducedCarousel.innerHTML = renderImageCarouselEditor(['/avatars/cover.png', '/avatars/cover.png'], {
    label: 'Images', addLabel: 'Add', removeLabel: 'Remove', moveBackLabel: 'Move back', moveForwardLabel: 'Move forward',
  });
  document.body.append(reducedCarousel);
  check(stillDurations(document.querySelector('.event-step-viewport [data-carousel-dropzone]'))
    && stillDurations(reducedCarousel.querySelector('.image-carousel-track'))
    && stillDurations(reducedCarousel.querySelector('.image-carousel-dot'))
    && stillDurations(reducedCarousel.querySelector('.image-carousel-editor-toolbar button')),
  'Reduced motion also stops the image drop zone and the carousel track, dots and toolbar');
  reducedCarousel.remove();
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
  check(!document.querySelector('[data-event-next]').disabled,
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
  // Measured where the dropdown rests, after its entrance motion.
  await flush();
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
  // A scroll event is dispatched a frame after the movement. The one of a scroll that
  // ended right before the dropdown opened must not count as the user scrolling it away.
  const viewportBox = eventStepScroller.getBoundingClientRect();
  const restingTriggerBox = eventAudienceTrigger.getBoundingClientRect();
  const restingAudienceTop = Math.max(0, Math.min(eventStepScroller.scrollHeight - eventStepScroller.clientHeight,
    eventStepScroller.scrollTop + restingTriggerBox.top - viewportBox.top - eventStepScroller.clientTop
      - Math.max(0, (eventStepScroller.clientHeight - restingTriggerBox.height) / 2)));
  eventStepScroller.scrollTo({ top: restingAudienceTop - 80, behavior: 'instant' });
  await settleScroll(eventStepScroller);
  let lateScrollEvents = 0;
  const countLateScroll = event => { if (event.target === eventStepScroller) lateScrollEvents++; };
  eventStepScroller.scrollTo({ top: restingAudienceTop, behavior: 'instant' });
  eventAudienceTrigger.click();
  document.addEventListener('scroll', countLateScroll, { capture: true });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  document.removeEventListener('scroll', countLateScroll, { capture: true });
  check(lateScrollEvents > 0 && !audiencePopup.hidden && eventAudienceTrigger.getAttribute('aria-expanded') === 'true',
    `The late event of a scroll that ended before the audience dropdown opened leaves it open: ${JSON.stringify({
      lateScrollEvents, hidden: audiencePopup.hidden, expanded: eventAudienceTrigger.getAttribute('aria-expanded'),
    })}`);
  eventStepScroller.scrollTo({ top: eventStepScroller.scrollTop - 40, behavior: 'instant' });
  await until(() => audiencePopup.hidden);
  check(eventAudienceTrigger.getAttribute('aria-expanded') === 'false',
    'Scrolling the form under the open audience dropdown still closes it');
  eventAudienceTrigger.click();
  await settleScroll(eventStepScroller);
  const eventScrollBeforeDrag = eventStepScroller.scrollTop;
  yield 'event-audience-scrollbar-modal';
  // The dismissed dropdown fades out before it is hidden.
  await until(() => audiencePopup.hidden).catch(() => {});
  check(audiencePopup.hidden && eventAudienceTrigger.getAttribute('aria-expanded') === 'false'
    && eventStepScroller.scrollTop < eventScrollBeforeDrag - 30,
  `Dragging the native modal scrollbar dismisses the audience picker: ${JSON.stringify({
    hidden: audiencePopup.hidden, before: eventScrollBeforeDrag, after: eventStepScroller.scrollTop,
  })}`);
  const eventScrollAfterDrag = eventStepScroller.scrollTop;
  const settledAfterDrag = await waitForQuietValue(() => eventStepScroller.scrollTop, 'manual audience scrollbar drag');
  check(Math.abs(settledAfterDrag - eventScrollAfterDrag) <= 1 && audiencePopup.hidden,
    'Automatic audience positioning never scrolls back after a manual scrollbar drag');
  const audienceScrollSpace = document.createElement('div');
  audienceScrollSpace.style.height = '360px';
  eventStepScroller.append(audienceScrollSpace);
  eventStepScroller.scrollTop += eventAudienceTrigger.getBoundingClientRect().bottom
    - (eventStepScroller.getBoundingClientRect().bottom - 20);
  await settleScroll(eventStepScroller);
  eventAudienceTrigger.click();
  yield 'event-audience-scrollbar-modal';
  await until(() => audiencePopup.hidden).catch(() => {});
  check(audiencePopup.hidden && eventAudienceTrigger.getAttribute('aria-expanded') === 'false',
    'A scrollbar drag also dismisses the audience picker while its opening scroll is in progress');
  const interruptedAudienceScroll = eventStepScroller.scrollTop;
  const settledInterruptedScroll = await waitForQuietValue(() => eventStepScroller.scrollTop,
    'interrupted audience opening scroll');
  check(Math.abs(settledInterruptedScroll - interruptedAudienceScroll) <= 1,
    'Interrupting the opening scroll cancels its animation and pending reposition timer');
  audienceScrollSpace.remove();
  for (let index = 0; index < 40; index++) server.knownMembers.delete(`scroll-audience-${index}`);
  eventAudienceTrigger.click();
  document.querySelector('[data-event-next]').click();
  check(document.querySelector('[data-audience-toggle]').getAttribute('aria-invalid') === 'true'
    && document.querySelector('.chat-copy-toast--danger')?.textContent.includes(t('audience.empty'))
    && getComputedStyle(document.querySelector('[data-audience-toggle]')).outlineOffset === '-2px',
  'An empty private audience uses a toast and highlights its picker');
  check(!document.querySelector('[data-date-error]')
    && !document.querySelector('.event-wizard [data-community-error]'),
  'Incomplete event details do not print an inline red error while the user is still editing');
  document.querySelector('[data-resource-audience=event-audience] [data-audience-kind=role]').click();
  check(!document.querySelector('[data-event-next]').disabled
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
  document.querySelector('[data-event-next]').click();
  await flush();
  check(document.querySelector('.community-modal:last-child') || document.querySelector('[aria-current=step]'), 'Event review is rendered');
  check(document.querySelectorAll('.event-step-body:not([data-ui-closing]) .image-carousel-dot').length === 2,
    'The event review renders every selected image');
  yield 'event-review';
  document.querySelector('[data-event-back]').click();
  const returning = document.querySelector('.event-step-body:not([data-ui-closing])').getAnimations()[0];
  check(returning?.effect.getKeyframes()[0].transform === 'translateX(-100%)', 'Going back reverses the step slide direction');
  await flush();
  check(document.querySelector('[data-input=title]').value === 'Scheduled event', 'Returning to details preserves the event draft');
  // A double click on Next whose second click comes after the review has slid in, onto Save.
  const eventSaves = () => calls.filter(call => call.type === 'EVENT_SAVE').length;
  const savesBeforeDoubleClick = eventSaves();
  const eventPrimary = document.querySelector('[data-event-next]');
  clickWithCount(eventPrimary, 1);
  await flush();
  check(eventPrimary.hasAttribute('data-event-submit') && !eventPrimary.disabled,
    'The event review lands with Save ready');
  clickWithCount(eventPrimary, 2);
  await flush();
  check(eventSaves() === savesBeforeDoubleClick && document.querySelector('.server-event-wizard'),
    'The second click of a double click on Next does not save the event it brought up for review');
  clickWithCount(eventPrimary, 1);
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
  document.querySelector('[data-event-next]').click();
  await flush();
  document.querySelector('[data-input=title]').value = 'Text event';
  document.querySelector('[data-input=title]').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('[data-event-next]').click();
  await flush();
  yield 'event-text-review';
  document.querySelector('[data-event-submit]').click();
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
  check(!document.querySelector('[data-event-next]').disabled && !channelSelect(),
    'Somewhere else accepts a URL directly without a channel dropdown');
  yield 'event-external';
  document.querySelector('[data-event-next]').click();
  await flush();
  document.querySelector('[data-input=title]').value = 'External event';
  document.querySelector('[data-input=title]').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('[data-event-next]').click();
  await flush();
  document.querySelector('[data-event-submit]').click();
  await flush();
  check(calls.some(call => call.type === 'EVENT_SAVE' && call.payload.title === 'External event' &&
    call.payload.location.kind === 'external' && call.payload.location.label === 'https://example.test/event'),
    'External URLs survive review and event creation');
  // Five detailed covers (noise, as in a sharp photo) cannot travel in one WebSocket message.
  const noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = 1000;
  noiseCanvas.height = 400;
  const noiseContext = noiseCanvas.getContext('2d');
  const noisyCovers = Array.from({ length: 5 }, () => {
    const pixels = noiseContext.createImageData(1000, 400);
    for (let index = 0; index < pixels.data.length; index += 4) {
      pixels.data[index] = Math.random() * 256;
      pixels.data[index + 1] = Math.random() * 256;
      pixels.data[index + 2] = Math.random() * 256;
      pixels.data[index + 3] = 255;
    }
    noiseContext.putImageData(pixels, 0, 0);
    return noiseCanvas.toDataURL('image/png');
  });
  const oversizedApi = window.api;
  window.api = { ...(oversizedApi ?? {}), selectImagesDialog: async maxFiles => noisyCovers.slice(0, maxFiles)
    .map((base64, index) => ({ fileName: `cover-${index}.png`, mimeType: 'image/png', base64 })) };
  document.querySelector('[data-create-event]').click();
  document.querySelector('[data-location=external]').click();
  document.querySelector('[data-input=location]').value = 'https://example.test/covers';
  document.querySelector('[data-input=location]').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('[data-event-next]').click();
  await flush();
  document.querySelector('[data-input=title]').value = 'Oversized event';
  document.querySelector('[data-input=title]').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('[data-carousel-dropzone]').click();
  for (let index = 0; index < 5; index++) {
    await until(() => activeCrop('[data-action=confirm]')?.disabled === false);
    activeCrop('[data-action=confirm]').click();
    await flush();
  }
  await until(() => document.querySelectorAll('.event-cover-field .image-carousel-slide').length === 5);
  if (oversizedApi === undefined) delete window.api; else window.api = oversizedApi;
  document.querySelector('[data-event-next]').click();
  await flush();
  const savesBeforeOversize = calls.filter(call => call.type === 'EVENT_SAVE').length;
  document.querySelector('[data-event-submit]').click();
  await flush();
  check(calls.filter(call => call.type === 'EVENT_SAVE').length === savesBeforeOversize
    && document.querySelector('.chat-copy-toast--danger')?.textContent.includes(t('community.eventImagesTooLarge'))
    && document.querySelector('.server-event-wizard') && !document.querySelector('[data-event-submit]').disabled,
  'An event too large for one WebSocket message stays open with an explanation instead of dropping the connection');
  document.querySelector('[data-event-back]').click();
  await flush();
  document.querySelector('.event-cover-field [data-carousel-edit=remove]').click();
  await flush();
  document.querySelector('[data-event-next]').click();
  await flush();
  document.querySelector('[data-event-submit]').click();
  await flush();
  check(calls.some(call => call.type === 'EVENT_SAVE' && call.payload.title === 'Oversized event'
    && call.payload.imageSources.length === 4) && !document.querySelector('.server-event-wizard'),
  'Removing a cover brings the event back under the limit and it is saved');
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
    check(document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])')?.textContent.includes(t('community.copyFailed')), 'Clipboard failure is localized and visible');
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
    check(document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])')?.textContent.includes('Fixture save failure')
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
  const historicReads = () => calls.filter(call => call.type === 'EVENT_GET' && call.payload.id === 'historic').length;
  check(detail() && historicReads() === 1,
    'Links fetch historical events by ID instead of depending on the snapshot, and do not ask again for the copy just fetched');
  const readsBeforeBurst = historicReads();
  for (let index = 0; index < 5; index++) emit('message.COMMUNITY_SNAPSHOT', snapshot);
  check(detail()?.querySelector('[data-event-id="historic"]') && !detail().textContent.includes(t('community.loadingEvent')),
    'Snapshots that never carried a historical event keep it on screen while it is confirmed again');
  await until(() => historicReads() > readsBeforeBurst);
  await flush();
  check(historicReads() === readsBeforeBurst + 1 && detail().querySelector('[data-event-id="historic"]'),
    'A burst of snapshots confirms an event outside the snapshot with a single request');
  // A check that fails without a refusal, such as a timeout, says nothing about the event:
  // what is on screen stays, with no error, until a later check.
  const eventToast = () => [...document.querySelectorAll('.chat-copy-toast--danger:not([data-ui-closing])')]
    .find(toast => [t('community.eventUnavailable'), t('community.eventLoadError'), t('community.changed')]
      .some(message => toast.textContent.includes(message)));
  eventGetFailure = new RequestTimeoutError('EVENT_GET');
  const readsBeforeTimeout = historicReads();
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  await until(() => historicReads() > readsBeforeTimeout);
  await flush();
  check(detail()?.querySelector('[data-event-id="historic"]') && detail().querySelector('.modal-title').textContent === event.title
    && !eventToast(),
  'A check that times out keeps the event on screen, with its name and no error');
  eventGetFailure = null;
  yield 'event-linked-details';
  deletedEvents.add('historic');
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  await until(() => !detail());
  check(eventToast()?.textContent.includes(t('community.eventUnavailable')) && !eventToast().textContent.includes(t('community.changed')),
    'A historical event deleted meanwhile closes its dialog at the next confirmation and says why, without sending the reader back to a list');
  deletedEvents.delete('historic');
  // Closing the dialog cancels a check already scheduled, and one already on its way.
  feed.requestOpenEvent('historic');
  await until(() => detail());
  const readsWhenReopened = historicReads();
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  await until(() => historicReads() === readsWhenReopened + 1);
  await flush();
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  detail().querySelector('[data-community-close]').click();
  await new Promise(resolve => setTimeout(resolve, 1300));
  check(historicReads() === readsWhenReopened + 1, 'Closing an event dialog cancels the check it had scheduled');
  feed.requestOpenEvent('historic');
  await until(() => detail());
  const readsBeforeInFlight = historicReads();
  let releaseCheck;
  eventGetGate = new Promise(resolve => { releaseCheck = resolve; });
  emit('message.COMMUNITY_SNAPSHOT', snapshot);
  await until(() => historicReads() === readsBeforeInFlight + 1);
  const inFlightCheck = calls.filter(call => call.type === 'EVENT_GET').at(-1);
  detail().querySelector('[data-community-close]').click();
  check(cancelled.includes(inFlightCheck.requestId), 'Closing an event dialog cancels the check on its way');
  releaseCheck();
  eventGetGate = null;
  await new Promise(resolve => setTimeout(resolve, 1300));
  check(historicReads() === readsBeforeInFlight + 1 && !detail(),
    'A cancelled check neither brings the dialog back nor asks the server again');
  document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
  feed.requestOpenEvent('missing');
  await flush();
  check(document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])'), 'Unavailable linked events show an explicit failure');
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
  const voteElsewhere = () => emit('message.COMMUNITY_SNAPSHOT',
    { ...structuredClone(snapshot), polls: [{ ...structuredClone(poll), totalVotes: poll.totalVotes + 1 }] });
  const listedEvent = document.querySelector('.event-list-modal [data-event-openable=true]');
  const listedMenu = listedEvent.querySelector('[data-event-action=menu]');
  const sidebarEvents = root.querySelector('[data-community=events]');
  listedMenu.focus();
  voteElsewhere();
  check(listedEvent.isConnected && document.activeElement === listedMenu && sidebarEvents.isConnected,
    'A vote elsewhere leaves the event list, its keyboard focus and the sidebar section untouched');
  yield 'event-active-list';
  document.querySelector('.event-list-modal [data-event-openable=true] .community-event-content').click();
  check(detail().querySelectorAll('.image-carousel-dot').length === 2,
    'Event details expose the complete image carousel');
  detail().querySelector('[data-event-tab=interested]').click();
  await flush();
  detail().querySelector('[data-interested-more]').click();
  await flush();
  const interestedRequests = calls.filter(call => call.type === 'EVENT_GET_INTERESTED').length;
  voteElsewhere();
  await flush();
  check(detail().querySelectorAll('.event-interest-list li').length === 2
    && calls.filter(call => call.type === 'EVENT_GET_INTERESTED').length === interestedRequests,
  'A vote elsewhere keeps every loaded page of interested members without asking the server again');
  detail().querySelector('[data-event-tab=details]').click();
  yield 'event-active-details';
  const detailApi = window.api;
  const calendarExports = [];
  window.api = { ...(detailApi ?? {}), saveEventCalendar: async input => { calendarExports.push(input); return { status: 'saved' }; } };
  let releaseEventGet;
  eventGetGate = new Promise(resolve => { releaseEventGet = resolve; });
  detail().querySelector('[data-event-action=menu]').click();
  const openEventMenu = () => document.querySelector('.floating-context-menu:not([data-ui-closing])');
  const staleExport = [...(openEventMenu()?.querySelectorAll('[role=menuitem]') ?? [])]
    .find(item => item.textContent.includes(t('community.exportCalendar')));
  check(staleExport && openEventMenu().contains(document.activeElement), 'The event menu opens with keyboard focus inside it');
  emit('message.COMMUNITY_SNAPSHOT', { ...structuredClone(snapshot), events: [] });
  const detailCard = detail();
  check(detailCard && !detailCard.querySelector('[data-event-id], [data-event-action], .event-interest-list, [data-community-content] img')
    && detailCard.querySelector('[data-community-content]').textContent === t('community.loadingEvent')
    && document.activeElement === detailCard.querySelector('.modal-title'),
  'An event that leaves the snapshot disappears at once, focus included, while the server is asked about it');
  check(detailCard.querySelector('.modal-title').textContent === t('community.details')
    && detailCard.getAttribute('aria-label') === t('community.details') && !detailCard.textContent.includes(event.title),
  'A hidden event leaves no trace of its name in the dialog heading or in the name read by screen readers');
  check(!openEventMenu(), 'The menu opened from the hidden event closes with it');
  staleExport.click();
  await flush();
  check(calendarExports.length === 0, 'An item of the closed menu no longer acts on the hidden event');
  releaseEventGet();
  eventGetGate = null;
  await until(() => detail().querySelector('[data-event-id="event"] [data-event-action=menu]'));
  check(!detail().textContent.includes(t('community.loadingEvent'))
    && detail().querySelector('.modal-title').textContent === event.title && detail().getAttribute('aria-label') === event.title,
  'An event the server still shows comes back after the check, with its name');
  emit('message.COMMUNITY_SNAPSHOT', { ...structuredClone(snapshot), events: [{ ...structuredClone(event), title: 'Renamed event' }] });
  check(detail().querySelector('.modal-title').textContent === 'Renamed event' && detail().getAttribute('aria-label') === 'Renamed event',
    'The dialog heading follows a rename');
  emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
  // A hidden event only comes back through the server: when its check fails for another
  // reason, such as a timeout, the dialog closes with a localized error, not the internal one.
  eventGetFailure = new RequestTimeoutError('EVENT_GET');
  emit('message.COMMUNITY_SNAPSHOT', { ...structuredClone(snapshot), events: [] });
  await until(() => !detail());
  check(eventToast()?.querySelector('.chat-copy-toast-label')?.textContent === t('community.eventLoadError'),
    'A hidden event whose check times out closes its dialog with a localized error');
  eventGetFailure = null;
  emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
  if (detailApi === undefined) delete window.api; else window.api = detailApi;
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
  // Keyboard focus stays with its own card while cards around it come and go, and goes to
  // the list title when that card leaves: Enter must never act on a neighbor.
  const focusBaseline = snapshot;
  const scheduledCard = id => ({ ...event, id, title: `Card ${id}`, status: 'scheduled', startsAt: now + 60000, startedAt: null });
  const pollCard = id => ({ ...structuredClone(poll), id, messageId: `${id}-message`, question: `Poll ${id}` });
  // Data that differs from the plain card, by card id: votes, interest, renames, revisions.
  const cardChanges = {};
  const showCards = (eventIds, pollIds) => {
    snapshot = { ...focusBaseline, events: eventIds.map(id => ({ ...scheduledCard(id), ...cardChanges[id] })),
      liveActions: [], polls: pollIds.map(id => ({ ...pollCard(id), ...cardChanges[id] })), nativeForms: [] };
    emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
  };
  showCards(['card-a', 'card-b', 'card-c'], ['poll-a', 'poll-b', 'poll-c']);
  root.querySelector('[data-community=events]').click();
  await flush();
  const eventMenu = id => document.querySelector(`.event-list-modal [data-event-id="${id}"] [data-event-action=menu]`);
  eventMenu('card-b').focus();
  showCards(['card-b', 'card-c'], ['poll-a', 'poll-b', 'poll-c']);
  check(document.activeElement === eventMenu('card-b'),
    'When an event above ends, keyboard focus stays on the same card, not on the one moving into its place');
  const listMenu = () => document.querySelector('.floating-context-menu:not([data-ui-closing])');
  const menuItem = label => [...(listMenu()?.querySelectorAll('[role=menuitem]') ?? [])].find(item => item.textContent.trim() === label);
  eventMenu('card-b').click();
  check(listMenu()?.contains(document.activeElement), 'An event card menu opens with keyboard focus inside it');
  // Only the card that changed is rebuilt: the menu of an unchanged one stays open.
  const unchangedMenu = eventMenu('card-b');
  const interestCard = document.querySelector('.event-list-modal [data-event-id="card-c"]');
  cardChanges['card-c'] = { interestedCount: 41 };
  showCards(['card-b', 'card-c'], ['poll-a', 'poll-b', 'poll-c']);
  check(listMenu()?.contains(document.activeElement) && eventMenu('card-b') === unchangedMenu
    && document.querySelector('.event-list-modal [data-event-id="card-c"]') !== interestCard,
  'Interest in another event rebuilds only that card and leaves the open menu of an unchanged card open, with focus in it');
  cardChanges['card-b'] = { revision: 7 };
  showCards(['card-b', 'card-c'], ['poll-a', 'poll-b', 'poll-c']);
  const controlsBeforeCancel = calls.filter(call => call.type === 'EVENT_CONTROL').length;
  menuItem(t('community.cancelEvent')).click();
  await until(() => document.querySelector('.modal-backdrop:not([data-ui-closing]) [data-action=confirm]'));
  document.querySelector('.modal-backdrop:not([data-ui-closing]) [data-action=confirm]').click();
  await until(() => calls.filter(call => call.type === 'EVENT_CONTROL').length > controlsBeforeCancel);
  await flush();
  const cancelControl = calls.filter(call => call.type === 'EVENT_CONTROL').at(-1).payload;
  check(cancelControl.id === 'card-b' && cancelControl.action === 'cancel' && cancelControl.expectedRevision === 7,
    'A menu left open acts on its event as it is now, not as it was when the menu opened');
  eventMenu('card-b').click();
  const changedMenu = eventMenu('card-b');
  cardChanges['card-b'] = { revision: 8, title: 'Card b renamed' };
  showCards(['card-b', 'card-c'], ['poll-a', 'poll-b', 'poll-c']);
  check(!listMenu() && eventMenu('card-b') !== changedMenu && document.activeElement === eventMenu('card-b'),
    'A change to the card of an open menu closes it and returns focus to the ⋯ of the same card');
  eventMenu('card-b').click();
  const movedMenu = eventMenu('card-b');
  showCards(['card-a', 'card-b', 'card-c'], ['poll-a', 'poll-b', 'poll-c']);
  check(!listMenu() && eventMenu('card-b') === movedMenu && document.activeElement === movedMenu,
    'A card entering the list moves the ⋯ of an open menu: the menu closes instead of floating away, and focus returns to that ⋯');
  // In a scrolled list, a card leaving above keeps what is on screen in place by scrolling
  // (scroll anchoring), and the menu closes on any scroll: focus still returns to its ⋯.
  const manyCards = ['card-a', 'card-b', 'card-c', 'card-d', 'card-e', 'card-f', 'card-g', 'card-h'];
  showCards(manyCards, ['poll-a', 'poll-b', 'poll-c']);
  const eventListScroller = document.querySelector('.event-list-modal');
  eventListScroller.scrollTop = eventListScroller.scrollHeight;
  await settleScroll(eventListScroller);
  eventMenu('card-g').click();
  const anchoredMenu = eventMenu('card-g');
  const anchoredTop = anchoredMenu.getBoundingClientRect().top;
  const scrolledFrom = eventListScroller.scrollTop;
  showCards(manyCards.filter(id => id !== 'card-a'), ['poll-a', 'poll-b', 'poll-c']);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  check(scrolledFrom > 0 && eventListScroller.scrollTop < scrolledFrom
    && Math.abs(anchoredMenu.getBoundingClientRect().top - anchoredTop) < 1
    && !listMenu() && eventMenu('card-g') === anchoredMenu && document.activeElement === anchoredMenu,
  `A card leaving above a scrolled list closes the menu of a card held in place and returns focus to its ⋯: ${JSON.stringify({
    scrolledFrom, scrollTop: eventListScroller.scrollTop, moved: anchoredMenu.getBoundingClientRect().top - anchoredTop,
    menu: !!listMenu(), focus: document.activeElement?.outerHTML.slice(0, 80),
  })}`);
  eventListScroller.scrollTop = 0;
  eventMenu('card-b').click();
  const staleStart = menuItem(t('community.start'));
  showCards(['card-c', 'card-d'], ['poll-a', 'poll-b', 'poll-c']);
  const eventListTitle = document.querySelector('.event-list-modal .modal-title');
  check(document.activeElement === eventListTitle && !listMenu(),
    'When the event of an open menu goes away, the menu closes and focus moves to the list title, not to the card now in its place');
  staleStart.click();
  check(staleStart && !document.querySelector('.event-start-modal'), 'An item of that closed menu starts nothing');
  const controlsBeforeEnter = calls.filter(call => call.type === 'EVENT_CONTROL').length;
  yield 'keyboard-enter';
  check(document.activeElement === eventListTitle && !document.querySelector('.floating-context-menu:not([data-ui-closing])')
    && calls.filter(call => call.type === 'EVENT_CONTROL').length === controlsBeforeEnter,
  'A real Enter after the focused event vanished opens nothing for another event');
  // The history only comes when asked for: the server pushes no snapshot of ended events, so
  // a deleted one is learned by asking. The server's refusal drops it from the history, and
  // nothing of it can be exported or opened again from there.
  const historyBaseline = snapshot;
  const historicCard = () => document.querySelector('.event-list-modal [data-event-id="historic"]');
  const listedEvents = () => [...document.querySelectorAll('.event-list-modal [data-event-id]')].map(card => card.dataset.eventId).join();
  const showHistory = async () => {
    const toggle = document.querySelector('.event-list-modal [data-history]');
    // What EVENT_GET answers for "historic" while it exists.
    snapshot = { ...historyBaseline, events: [...historyBaseline.events, { ...event, id: 'historic', status: 'ended' }] };
    if (toggle.checked) {
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => !historicCard());
    }
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => historicCard());
    snapshot = historyBaseline;
    emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
  };
  await showHistory();
  check(listedEvents() === 'card-c,card-d,historic',
    'With the history on, a snapshot keeps the server order: current events first, then ended ones');
  const historyApi = window.api;
  const historyExports = [];
  window.api = { ...(historyApi ?? {}), saveEventCalendar: async input => { historyExports.push(input); return { status: 'cancelled' }; } };
  const exportFromHistory = () => {
    historicCard().querySelector('[data-event-action=menu]').click();
    menuItem(t('community.exportCalendar')).click();
  };
  try {
    let readsBefore = historicReads();
    exportFromHistory();
    await until(() => historyExports.length === 1);
    check(historicReads() === readsBefore + 1 && historyExports[0].event.id === 'historic',
      'Exporting an event from the history confirms it with the server before writing anything');
    readsBefore = historicReads();
    const historicTitle = historicCard().querySelector('[data-event-action=detail]');
    historicTitle.focus();
    historicTitle.click();
    check(detail() && historicReads() === readsBefore + 1,
      'An event opened from the history is confirmed at once, even when no snapshot follows');
    await flush();
    deletedEvents.add('historic');
    emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
    await until(() => !detail());
    check(!historicCard() && listedEvents() === 'card-c,card-d'
      && eventToast()?.querySelector('.chat-copy-toast-label')?.textContent === t('community.eventUnavailable'),
    'A history event deleted while open closes its dialog, says why and leaves the history');
    check(document.activeElement === document.querySelector('.event-list-modal .modal-title'),
      'Focus falls back from the closed dialog to the list title, not to the body or another event');
    document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
    feed.requestOpenEvent('historic');
    const linkDialog = () => [...document.querySelectorAll('.modal-backdrop:not([data-ui-closing]) .community-modal')].at(-1);
    await until(() => linkDialog() && document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])'));
    check(!detail() && !linkDialog().querySelector('[data-event-id]'), 'A link to the deleted event does not bring its old copy back');
    linkDialog().querySelector('[data-community-close]').click();
    await flush();
    // Deleted while nothing showed it: the history still lists it, but opening or exporting
    // it asks the server first, and the refusal drops it.
    deletedEvents.delete('historic');
    await showHistory();
    deletedEvents.add('historic');
    historicCard().querySelector('.community-event-content > p').click();
    await until(() => !detail() && !historicCard());
    check(eventToast()?.querySelector('.chat-copy-toast-label')?.textContent === t('community.eventUnavailable'),
      'Opening a history event deleted while nobody looked closes at its first confirmation and drops it from the history');
    deletedEvents.delete('historic');
    await showHistory();
    historicCard().querySelector('.community-event-content > p').click();
    await flush();
    deletedEvents.add('historic');
    detail().querySelector('[data-event-action=menu]').click();
    menuItem(t('community.exportCalendar')).click();
    await until(() => !detail() && !historicCard());
    check(historyExports.length === 1
      && eventToast()?.querySelector('.chat-copy-toast-label')?.textContent === t('community.eventUnavailable'),
    'Exporting from the dialog of a deleted history event writes no file, closes the dialog and drops the event from the history');
    deletedEvents.delete('historic');
    await showHistory();
    deletedEvents.add('historic');
    exportFromHistory();
    await until(() => !historicCard());
    await flush();
    check(historyExports.length === 1
      && document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])')?.textContent.includes(t('community.eventUnavailable')),
    'Exporting a history event deleted meanwhile writes no file, says why and drops it from the history');
  } finally {
    if (historyApi === undefined) delete window.api; else window.api = historyApi;
    deletedEvents.delete('historic');
    snapshot = historyBaseline;
  }
  document.querySelector('.event-list-modal [data-community-close]').click();
  await flush();
  root.querySelector('[data-community=actions]').click();
  await flush();
  const pollMenu = id => document.querySelector(`.live-action-list-modal [data-live-poll-card="${id}"] [data-live-action-menu]`);
  pollMenu('poll-b').focus();
  showCards(['card-c'], ['poll-b', 'poll-c']);
  check(document.activeElement === pollMenu('poll-b'),
    'When a live action above closes, keyboard focus stays on the same card');
  // Votes rebuild the card of their poll only: a moderator's open menu elsewhere stays usable.
  pollMenu('poll-b').click();
  const openPollMenu = pollMenu('poll-b');
  const votedCard = document.querySelector('.live-action-list-modal [data-live-poll-card="poll-c"]');
  cardChanges['poll-c'] = { totalVotes: 41 };
  showCards(['card-c'], ['poll-b', 'poll-c']);
  check(listMenu()?.contains(document.activeElement) && pollMenu('poll-b') === openPollMenu
    && document.querySelector('.live-action-list-modal [data-live-poll-card="poll-c"]') !== votedCard,
  'A vote on another poll rebuilds only that card and leaves the open menu, with its focus, alone');
  cardChanges['poll-b'] = { totalVotes: 42 };
  showCards(['card-c'], ['poll-b', 'poll-c']);
  check(!listMenu() && pollMenu('poll-b') !== openPollMenu && document.activeElement === pollMenu('poll-b'),
    'A vote on the poll of the open menu closes it and returns focus to the ⋯ of the same card');
  pollMenu('poll-b').click();
  const staleClose = menuItem(t('community.closeLiveAction'));
  showCards(['card-c'], ['poll-c', 'poll-d']);
  check(document.activeElement === document.querySelector('.live-action-list-modal .modal-title') && !listMenu(),
    'When the live action of an open menu closes, the menu closes and focus moves to the list title instead of the card now in its place');
  staleClose.click();
  await flush();
  check(staleClose && !document.querySelector('.modal-backdrop:not([data-ui-closing]) [data-action=confirm]'),
    'An item of that closed menu asks nothing about another live action');
  document.querySelector('.live-action-list-modal [data-community-close]').click();
  await flush();
  snapshot = focusBaseline;
  emit('message.COMMUNITY_SNAPSHOT', structuredClone(snapshot));
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
  // A real submit, with the browser's own validation: the missing title is explained in the app's language.
  const renameField = renameForm.querySelector('input');
  const renameCalls = calls.length;
  renameField.value = '';
  renameForm.requestSubmit();
  await flush();
  const missingTitle = document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
  check(renameForm.noValidate && missingTitle?.getAttribute('role') === 'alert'
    && missingTitle.textContent.includes(t('validation.required', { field: t('forum.renameLabel') }))
    && renameField.getAttribute('aria-invalid') === 'true' && document.activeElement === renameField && calls.length === renameCalls,
  'An empty thread title is explained in the alert toast, in the app language, instead of the browser balloon');
  missingTitle.querySelector('.chat-copy-toast-close').click();
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
  // #828: a post whose time a Date cannot hold is left out; the others still show.
  forumPosts = [
    { ...post, channelId: 'bad-text', updatedAt: 'yesterday' },
    { ...post, channelId: 'bad-nan', updatedAt: Number.NaN },
    { ...post, channelId: 'bad-range', updatedAt: 1e20 },
    { ...post, channelId: 'valid-time', title: 'Valid time' },
  ];
  await forum.load();
  const validTime = () => root.querySelector('[data-forum-id="valid-time"] time');
  check([...root.querySelectorAll('[data-forum-id]')].map(row => row.dataset.forumId).join() === 'valid-time'
    && validTime()?.dateTime === new Date(now).toISOString(),
  'Posts with an invalid time are left out of the forum list instead of breaking it');
  emit('message.FORUM_POST_SAVED', { post: { ...forumPosts[3], title: 'Out of range', updatedAt: -1e20 } });
  check(root.querySelector('[data-forum-id="valid-time"] h3')?.textContent === 'Valid time' && validTime(),
    'A saved post with a time out of range leaves its card as it was');
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
  try {
    await until(() => calls.some(call => call.type === 'FORUM_LIST' && call.payload.offset === 25));
  } catch (error) {
    throw new Error('Forum lazy loading did not request its second page: ' + JSON.stringify({
      viewport: { width: innerWidth, height: innerHeight, visible: document.visibilityState },
      root: root.getBoundingClientRect(), scroller: forumScroller.getBoundingClientRect(),
      sentinel: root.querySelector('[data-forum-sentinel]').getBoundingClientRect(),
      scroll: { top: forumScroller.scrollTop, height: forumScroller.scrollHeight, client: forumScroller.clientHeight },
      more: forum.more, next: forum.next, loading: forum.loading,
      requests: calls.filter(call => call.type === 'FORUM_LIST').map(call => call.payload),
    }), { cause: error });
  }
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
  // R-CHAT-7: messages elsewhere on the server and logins leave the forum alone; activity
  // in its posts reloads the pages on screen instead of going back to the first one.
  const forumRequests = () => calls.filter(call => call.type === 'FORUM_LIST');
  const rowCount = () => root.querySelectorAll('[data-forum-id]').length;
  const requestsBefore = forumRequests().length;
  emit('message.CHAT_MESSAGE', { id: 'elsewhere', channelId: 'text', userId: 'member', userNickname: 'Member', content: 'hi', createdAt: now });
  emit('message.CHAT_REACTION_ADDED', { channelId: 'text', messageId: 'elsewhere', emoji: '👍', userId: 'member', userNickname: 'Member' });
  emit('message.ROLES_LIST', {});
  await new Promise(resolve => setTimeout(resolve, 400));
  check(forumRequests().length === requestsBefore && rowCount() === 60,
    'Messages in other channels and logins never reload the forum list');
  emit('message.FORUM_POST_SAVED', { post: { ...forumPosts[50], title: 'Renamed deep thread' } });
  emit('message.FORUM_POST_SAVED', { post: forumPosts[55], deleted: true });
  forumPosts = forumPosts.filter((_, index) => index !== 55).map(entry =>
    entry.channelId === 'lazy-post-50' ? { ...entry, title: 'Renamed deep thread' } : entry);
  check(rowCount() === 59 && root.querySelector('[data-forum-id="lazy-post-50"] h3')?.textContent === 'Renamed deep thread'
    && !root.querySelector('[data-forum-id="lazy-post-55"]'),
  'Saved and deleted threads update their cards at once, even beyond the first page');
  emit('message.CHAT_MESSAGE', { id: 'reply', channelId: 'event-thread', userId: 'member', userNickname: 'Member', content: 'reply', createdAt: now });
  await until(() => forumRequests().length >= requestsBefore + 3);
  await flush();
  check(forumRequests().slice(requestsBefore).map(call => call.payload.offset).join() === '0,25,50' && rowCount() === 59
    && root.querySelector('[data-forum-id="lazy-post-58"]') && root.querySelector('[data-forum-sentinel]').hidden,
  'Activity in threads reloads the pages on screen once, without going back to the first page');
  // R-CHAT-7: a thread that leaves the pages on screen, unpinned here, takes none of the following ones with it.
  const threadIds = () => [...root.querySelectorAll('[data-forum-id]')].map(row => row.dataset.forumId).join();
  const threads = count => Array.from({ length: count }, (_, index) => `q${index}`);
  forumPosts = threads(81).map((channelId, index) => ({ ...post, channelId, title: `Thread ${index}`,
    createdAt: now + index, updatedAt: now + index, pinned: index === 80 }));
  // Read from the top, so only the scroll below asks for a second page.
  forumScroller.scrollTop = 0;
  await forum.load();
  await flush();
  forumScroller.scrollTop = forumScroller.scrollHeight;
  await until(() => rowCount() === 50);
  forumScroller.scrollTop = 0;
  await flush();
  check(threadIds() === ['q80', ...threads(49)].join(), `The pinned thread leads the first page: ${threadIds()}`);
  const requestsBeforeUnpin = forumRequests().length;
  forumPosts = forumPosts.map(entry => entry.channelId === 'q80' ? { ...entry, pinned: false } : entry);
  emit('message.FORUM_POST_SAVED', { post: forumPosts[80] });
  await until(() => forumRequests().length >= requestsBeforeUnpin + 2);
  await flush();
  const unpinned = { threads: threadIds(), offsets: forumRequests().slice(requestsBeforeUnpin).map(call => call.payload.offset).join() };
  check(unpinned.threads === threads(50).join() && unpinned.offsets === '0,25',
    `A thread unpinned out of the pages on screen leaves them in order, and the next one moves in: ${JSON.stringify(unpinned)}`);
  forumScroller.scrollTop = forumScroller.scrollHeight;
  await until(() => rowCount() === 75);
  forumScroller.scrollTop = forumScroller.scrollHeight;
  await until(() => rowCount() === 81);
  check(threadIds() === threads(81).join(), 'Scrolling on lists every thread exactly once, in order');
  // R-CHAT-7: a refresh asks for at most 3 pages however many are on screen, and keeps its distance
  // from the previous one, so a long, busy forum stays within the server's forum budget. The rule does
  // not depend on the language, so it runs once.
  if (locale === 'pt-BR') {
    document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
    // Toasts share one slot, each closing the one before: errors are counted as they appear.
    let errorToastsShown = 0;
    const toastWatch = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.classList.contains('chat-copy-toast--danger')) errorToastsShown++;
      }
    });
    toastWatch.observe(document.body, { childList: true });
    const errorToasts = () => errorToastsShown;
    const offsetsSince = start => forumRequests().slice(start).map(call => call.payload.offset).join();
    const activity = () => emit('message.CHAT_MESSAGE', { id: crypto.randomUUID(), channelId: 'event-thread',
      userId: 'member', userNickname: 'Member', content: 'reply', createdAt: now });
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    // Spacing is checked once below; elsewhere the previous refresh is taken as long gone.
    const longAfterLastRefresh = () => { forum.lastRefreshAt = Number.NEGATIVE_INFINITY; };
    forumPosts = threads(790).map((channelId, index) => ({ ...post, channelId, title: `Thread ${index}`,
      createdAt: now + index, updatedAt: now + index }));
    forumScroller.scrollTop = 0;
    await forum.load();
    while (forum.more) await forum.load('append');
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await flush();
    const deepScroll = forumScroller.scrollTop;
    check(rowCount() === 790 && forum.pages === 32 && deepScroll > 0, 'A long forum shows its 32 pages');
    forumLimiter = { times: [] };
    const beforeDeep = forumRequests().length;
    // Long after the last refresh, nothing but the reader's place holds this one back.
    longAfterLastRefresh();
    for (let index = 0; index < 5; index++) activity();
    await pause(600);
    check(forumRequests().length === beforeDeep && rowCount() === 790 && forumScroller.scrollTop === deepScroll,
      'Past the pages a refresh keeps, activity waits: nothing is asked and nothing moves under the reader');
    longAfterLastRefresh();
    forumScroller.scrollTop = 0;
    await until(() => forumRequests().length >= beforeDeep + 3);
    await flush();
    check(offsetsSince(beforeDeep) === '0,25,50' && threadIds() === threads(75).join() && forum.more && !errorToasts(),
      `Back within its pages, the refresh it put off asks for 3 of them and drops the rest: ${offsetsSince(beforeDeep)}`);
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => rowCount() === 100);
    check(threadIds() === threads(100).join() && offsetsSince(beforeDeep) === '0,25,50,75',
      'Scrolling on after the refresh continues where the server list is, without skipping or repeating a thread');
    forumScroller.scrollTop = 0;
    await flush();
    const beforeBusy = forumRequests().length;
    activity();
    await pause(1000);
    check(forumRequests().length === beforeBusy, 'Activity right after a refresh waits for its spacing');
    await until(() => forumRequests().length >= beforeBusy + 3);
    await until(() => forum.loading === null);
    check(offsetsSince(beforeBusy) === '0,25,50' && rowCount() === 75 && !errorToasts(),
      `Then the refresh asks for 3 pages again, with 4 on screen: ${offsetsSince(beforeBusy)}`);
    const posted = await client.sendRequest('FORUM_CREATE_POST', { id: crypto.randomUUID(), channelId: 'forum', title: 'Still posting', content: 'x' });
    check(posted.post.title === 'Still posting', 'Refreshes leave room in the forum budget to post');
    // Another device spent the budget: the refresh it turns away comes back later, quietly, and the
    // list asks for no page meanwhile, which the server would turn away too at every frame the reader
    // is at its end. The server's 10 s window is shortened here.
    const Forum = forum.constructor;
    const serverWindow = Forum.REFRESH_RETRY_MS;
    Forum.REFRESH_RETRY_MS = 2500;
    forumLimiter.times = Array.from({ length: 30 }, () => performance.now());
    longAfterLastRefresh();
    const beforeLimited = forumRequests().length;
    activity();
    await until(() => forumRequests().length > beforeLimited);
    await flush();
    activity();
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await pause(800);
    check(forumRequests().length === beforeLimited + 1 && rowCount() === 75 && !errorToasts() && forum.pendingLoad === 'refresh',
      `A refresh the server turns away shows no error, keeps the list, asks for no page and waits: ${offsetsSince(beforeLimited)}`);
    forumLimiter.times = [];
    await until(() => rowCount() === 100);
    await until(() => forum.loading === null);
    check(!errorToasts(), 'After the window, the page the reader is at arrives without an error');
    // The page the reader scrolls to is turned away: one error, and it is asked for again after the window.
    forumLimiter.times = Array.from({ length: 30 }, () => performance.now());
    const beforeAppend = forumRequests().length;
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => forumRequests().length > beforeAppend);
    await pause(1000);
    check(offsetsSince(beforeAppend) === '100' && errorToasts() === 1 && rowCount() === 100,
      `A page the server turns away is asked for once, with one error, not again at every frame: ${offsetsSince(beforeAppend)}`);
    forumLimiter.times = [];
    await until(() => rowCount() === 125);
    check(offsetsSince(beforeAppend) === '100,100' && errorToasts() === 1, 'After the window the page arrives, without another error');
    // Any other failure waits too, twice as long at each one in a row, with one error each. Shortened here.
    const firstRetry = Forum.APPEND_RETRY_MS;
    Forum.APPEND_RETRY_MS = 300;
    forumPageFailure = { error: new Error('The forum is not answering'), times: [] };
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => forumPageFailure.times.length === 3);
    const failedAt = forumPageFailure.times;
    forumPageFailure = null;
    check(failedAt[1] - failedAt[0] >= 300 && failedAt[2] - failedAt[1] >= 600 && errorToasts() === 4,
      `A page that keeps failing is asked for again later each time, with one error each: ${failedAt.map(time => Math.round(time - failedAt[0]))}`);
    await until(() => rowCount() === 150);
    check(errorToasts() === 4 && forum.appendFailures === 0, 'Once the server answers, the page arrives and the wait starts over');
    Forum.APPEND_RETRY_MS = firstRetry;
    Forum.REFRESH_RETRY_MS = serverWindow;
    forumLimiter = null;
    // With the refresh put off, threads on screen that move down or out of the list (unpinned, renamed
    // out of the search, left without their newest reply) take none of the following ones with them
    // as the reader scrolls on, even while that page is on its way.
    const search = root.querySelector('[data-forum-search]');
    const range = (from, to) => Array.from({ length: to - from }, (_, index) => `m${from + index}`);
    const thread = id => forumPosts.find(entry => entry.channelId === id);
    const change = (id, update) => { forumPosts = forumPosts.map(entry => entry.channelId === id ? { ...entry, ...update } : entry); };
    const newestDeleted = (id, createdAt) => emit('message.CHAT_MESSAGE_UPDATED', { message: { id: `${id}-reply`, channelId: id,
      userId: 'member', userNickname: 'Member', content: '', createdAt, deletedAt: now } });
    forumSort.value = 'latest';
    forumSort.dispatchEvent(new Event('change', { bubbles: true }));
    search.value = 'Thread';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    forumPosts = Array.from({ length: 130 }, (_, index) => ({ ...post, channelId: `m${index}`, title: `Thread ${index}`,
      createdAt: now + index, updatedAt: now + 1_000 - index, pinned: index === 129 }));
    forumScroller.scrollTop = 0;
    await forum.load();
    for (let page = 1; page < 4; page++) await forum.load('append');
    await flush();
    check(forum.pages === 4 && threadIds() === ['m129', ...range(0, 99)].join(), `Four pages of the search, pinned first: ${threadIds()}`);
    // Past the 75 threads a refresh keeps, far from the end of the list.
    forumScroller.scrollTop += root.querySelectorAll('[data-forum-id]')[76].getBoundingClientRect().bottom
      - forumScroller.getBoundingClientRect().bottom;
    await flush();
    const beforeMoves = forumRequests().length;
    change('m129', { pinned: false });
    emit('message.FORUM_POST_SAVED', { post: thread('m129') });
    emit('message.FORUM_POST_SAVED', { post: { ...thread('m20'), title: 'Renamed' } });
    forumPosts = forumPosts.filter(entry => entry.channelId !== 'm20');
    const newestOfM10 = thread('m10').updatedAt;
    change('m10', { updatedAt: now - 5_000 });
    newestDeleted('m10', newestOfM10);
    // An older reply deleted moves nothing.
    newestDeleted('m30', now - 10_000);
    await pause(600);
    check(forumRequests().length === beforeMoves && rowCount() === 100,
      'Threads moving away while the reader is past the pages a refresh keeps ask for nothing yet');
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => rowCount() === 125);
    let ids = threadIds().split(',');
    check(offsetsSince(beforeMoves) === '97' && new Set(ids).size === ids.length && ids.slice(100).join() === range(99, 124).join(),
      `The next page starts as many threads earlier as moved away, skipping none: ${offsetsSince(beforeMoves)} ${ids.slice(100, 104)}`);
    let releasePage;
    forumListGate = new Promise(resolve => { releasePage = resolve; });
    const beforeFlight = forumRequests().length;
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => forumRequests().length > beforeFlight);
    const newestOfM50 = thread('m50').updatedAt;
    change('m50', { updatedAt: now - 6_000 });
    newestDeleted('m50', newestOfM50);
    releasePage();
    forumListGate = null;
    await until(() => !forum.more && forum.loading === null);
    ids = threadIds().split(',');
    check(offsetsSince(beforeFlight) === '122,121' && new Set(ids).size === ids.length && ids.slice(125).join() === range(124, 129).join(),
      `A page read while a thread moved away is asked for again where the next threads are: ${offsetsSince(beforeFlight)} ${ids.slice(125)}`);
    // A thread losing its newest replies one after another, as when spam is cleared, may move down at
    // each one: once the first is gone, the time on its card is no longer its own.
    const spamRange = (from, to) => Array.from({ length: to - from }, (_, index) => `d${from + index}`);
    forumPosts = Array.from({ length: 160 }, (_, index) => ({ ...post, channelId: `d${index}`, title: `Thread ${index}`,
      createdAt: now + index, updatedAt: index ? now + 1_000 - index : now + 2_000 }));
    forumScroller.scrollTop = 0;
    await forum.load();
    for (let page = 1; page < 4; page++) await forum.load('append');
    await flush();
    forumScroller.scrollTop += root.querySelectorAll('[data-forum-id]')[76].getBoundingClientRect().bottom
      - forumScroller.getBoundingClientRect().bottom;
    await flush();
    const beforeSpam = forumRequests().length;
    // Its newest reply goes, and the one before still keeps it first.
    change('d0', { updatedAt: now + 1_500 });
    newestDeleted('d0', now + 2_000);
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => rowCount() === 124);
    // Then that one goes too, older than the time on the card, and the thread falls to the end.
    change('d0', { updatedAt: now - 9_000 });
    newestDeleted('d0', now + 1_500);
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => rowCount() === 149);
    ids = threadIds().split(',');
    check(offsetsSince(beforeSpam) === '99,123' && new Set(ids).size === ids.length && ids.slice(124).join() === spamRange(124, 149).join(),
      `Every newest reply deleted from the same thread counts, so no thread is skipped: ${offsetsSince(beforeSpam)} ${ids.slice(124, 127)}`);
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    forumSort.value = 'oldest';
    forumSort.dispatchEvent(new Event('change', { bubbles: true }));
    toastWatch.disconnect();
  }
  // #847: with forum-cursor, the next page starts right after the last thread read, so threads
  // read that left the list before their events arrived take none of the following ones with them.
  if (locale === 'pt-BR') {
    const features = server.serverDetails.protocol.features;
    features.push('forum-cursor');
    forumPosts = Array.from({ length: 60 }, (_, index) => ({ ...post, channelId: `c${String(index).padStart(2, '0')}`,
      title: `Cursor ${index}`, createdAt: now + index, updatedAt: now + index }));
    forumScroller.scrollTop = 0;
    await forum.load();
    await flush();
    forumPosts = forumPosts.filter(entry => entry.channelId !== 'c03' && entry.channelId !== 'c07');
    const beforeCursor = forumRequests().length;
    forumScroller.scrollTop = forumScroller.scrollHeight;
    await until(() => rowCount() === 50);
    const cursorPage = forumRequests()[beforeCursor].payload;
    const expected = Array.from({ length: 50 }, (_, index) => `c${String(index).padStart(2, '0')}`).join();
    check(cursorPage.after?.channelId === 'c24' && !('offset' in cursorPage) && threadIds() === expected,
      `The next page is asked for after the last thread read and skips none: ${JSON.stringify(cursorPage)} ${threadIds()}`);
    features.splice(features.indexOf('forum-cursor'), 1);
  }
  forumPosts = [];
  await forum.load();
  check(root.querySelector('.forum-empty-state strong')?.textContent === t('forum.emptyTitle')
    && root.querySelector('.forum-empty-state')?.textContent.includes('#Forum')
    && !root.querySelector('[data-forum-posts] button'),
  'Empty forums show the centered first-conversation state without example actions');
  const forumChannel = server.getChannel('forum');
  forumChannel.name = '<img src=x onerror="window.forumNameExecuted=true">';
  await forum.load();
  await new Promise(resolve => setTimeout(resolve, 50));
  check(root.querySelector('.forum-empty-state p')?.textContent.includes(`#${forumChannel.name}`)
    && !root.querySelector('.forum-empty-state img') && !window.forumNameExecuted,
  'A forum name carrying markup stays literal text in the empty state');
  forumChannel.name = 'Forum';
  forumPosts = [post];
  await forum.load();
  root.querySelector('[data-forum-open]').click();
  check(opened[0] === 'post', 'Post opens its text discussion');
  const forumSearch = root.querySelector('[data-forum-search]');
  const createShell = root.querySelector('.forum-create-shell');
  const createBar = root.querySelector('.forum-create-bar');
  const createHeight = createShell.getBoundingClientRect().height;
  forumSearch.focus();
  // The focused shell grows with a transition; measure it settled instead of after a fixed delay.
  await until(() => createShell.getBoundingClientRect().height > createHeight + 20);
  await Promise.allSettled(createShell.getAnimations({ subtree: true }).map(animation => animation.finished));
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
  const composerTitle = document.querySelector('input[name=title]');
  const composerCalls = calls.length;
  composerTitle.value = '';
  root.querySelector('.forum-composer form').requestSubmit();
  await flush();
  const missingPostTitle = document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
  check(root.querySelector('.forum-composer form').noValidate
    && missingPostTitle?.textContent.includes(t('validation.required', { field: t('forum.postTitle') }))
    && composerTitle.getAttribute('aria-invalid') === 'true' && calls.length === composerCalls,
  'A new topic without a title is explained in the alert toast, in the app language, and is not published');
  missingPostTitle.querySelector('.chat-copy-toast-close').click();
  composerTitle.value = 'New topic';
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
      'Forum and discussion occupy adjacent columns with aligned headers: ' + JSON.stringify({
        viewport: innerWidth, list: listBox.toJSON(), pane: paneBox.toJSON(), header: headerBox.toJSON(),
      }));
    check(Math.abs(pane.querySelector('.chat-input-container').getBoundingClientRect().bottom - paneBox.bottom) < 2,
      'The real discussion fills its column and anchors its composer at the bottom');
    check(mainRoot.querySelector('#server-tools').getBoundingClientRect().right <= headerBox.right,
      'Search stays in the forum header instead of covering discussion controls');
    check(mainRoot.querySelector('[name=title]') === draftTitle && draftTitle.value === 'Keep this draft', 'Opening a discussion preserves the inline draft');
    check(calls.some(call => call.type === 'CHAT_LOAD_HISTORY' && call.payload.channelId === 'post'), 'Real discussion requests its own chat history');
    const forumImage = color => `/attachments/forum-${color.slice(1)}.svg`;
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
    carouselProbe.innerHTML = renderAttachments([
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
    main.chatView.composer.syncPermissionState();
    check(reply.readOnly && reply.placeholder === t('forum.closedPlaceholder')
      && getComputedStyle(pane.querySelector('#chat-send-permission-banner')).display === 'none',
    'An author-closed thread locks the composer with only a placeholder and no warning banner');
    discussionChannel.forumClosed = false;
    discussionChannel.forumLocked = true;
    main.chatView.composer.syncPermissionState();
    check(reply.readOnly && reply.placeholder === t('forum.lockedPlaceholder')
      && getComputedStyle(pane.querySelector('#chat-send-permission-banner')).display === 'none',
    'An administratively locked thread uses its distinct placeholder without a warning banner');
    discussionChannel.forumLocked = false;
    main.chatView.composer.syncPermissionState();
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
    // What the feed does from here on, for the reveal below to show if it fails.
    const revealRecord = window.recordFeed(main.chatView.feed.list);
    const previousHistory = actualChatStore.getMessages('text');
    actualChatStore.setHistory('text', Array.from({ length: 200 }, (_, index) => ({
      id: `long-history-${index}`, channelId: 'text', userId: chatServer.currentUser.id,
      userNickname: 'Author', content: `History entry ${index}\nSecond line\nThird line`, createdAt: index + 1,
    })));
    const longFeed = mainRoot.querySelector('#chat-messages-feed');
    const scrollCalls = [];
    const scrollTo = longFeed.scrollTo;
    // History hydration may already have pinned the feed; explicitly start this reveal at the top.
    scrollTo.call(longFeed, { top: 0, behavior: 'instant' });
    check(longFeed.scrollTop === 0, 'The long-history reveal starts away from its destination');
    longFeed.scrollTo = function (options) {
      const max = this.scrollHeight - this.clientHeight;
      // scrollToBottom may request scrollHeight; Chromium clamps it to the last visible viewport.
      scrollCalls.push({ ...options, requestedTop: options.top,
        top: Math.max(0, Math.min(options.top, max)), before: this.scrollTop, max });
      scrollTo.call(this, options);
    };
    main.chatView.feed.render({ forceScroll: true });
    // The composer growing mid-reveal (a toolbar wrapping in a narrow window) shrinks
    // the feed without scrolling it; the reveal must still end on the newest message.
    const revealComposer = mainRoot.querySelector('.chat-input-container');
    requestAnimationFrame(() => { revealComposer.style.paddingBottom = '24px'; });
    check(longFeed.scrollHeight > longFeed.clientHeight * 20 &&
      longFeed.scrollHeight - longFeed.clientHeight - longFeed.scrollTop <= 161 &&
      scrollCalls.some(call => call.behavior === 'smooth' && call.top > call.before),
    'A long chat begins its entry animation near the bottom, with no more than 160px left to travel: ' +
      JSON.stringify({ height: longFeed.scrollHeight, viewport: longFeed.clientHeight, top: longFeed.scrollTop, scrollCalls }));
    await new Promise((resolve, reject) => {
      const start = performance.now();
      const settle = () => {
        if (Math.abs(longFeed.scrollHeight - longFeed.clientHeight - longFeed.scrollTop) <= 1) resolve();
        else if (performance.now() - start > 2000) {
          reject(new Error(`Short chat entry did not reach the latest message: ${JSON.stringify({ feed: revealRecord.dump(), scrollCalls })}`));
        } else requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    });
    revealComposer.style.paddingBottom = '';
    // Exercise a normal bottom pin too: a clamped no-op is not another viewport of travel.
    main.chatView.feed.list.scrollToEnd();
    check(scrollCalls.filter(call => call.behavior === 'smooth').every(call => Math.abs(call.top - call.before) <= 161),
      'Every smooth leg of the history reveal stays within the distance limit, including the layout frame: ' +
        JSON.stringify(scrollCalls));
    scrollCalls.length = 0;
    main.chatView.feed.render({ forceScroll: true });
    await flush();
    check(Math.abs(longFeed.scrollHeight - longFeed.clientHeight - longFeed.scrollTop) <= 1 &&
      scrollCalls.length > 0 && scrollCalls.every(call => Math.abs(call.top - call.before) <= 1),
    'An already hydrated history remains at the bottom without introducing artificial entry movement');
    yield 'chat-entry-reduced-motion';
    scrollTo.call(longFeed, { top: 0, behavior: 'instant' });
    scrollCalls.length = 0;
    main.chatView.feed.render({ forceScroll: true });
    check(longFeed.scrollHeight - longFeed.clientHeight - longFeed.scrollTop <= 1 &&
      scrollCalls.every(call => call.behavior === 'instant'),
    'Reduced motion opens long histories directly at the destination without animation');
    yield 'chat-entry-motion-enabled';
    longFeed.scrollTo = scrollTo;
    actualChatStore.setHistory('text', previousHistory);
    main.chatView.feed.render({ forceScroll: true });
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
    const lateSend = main.chatView.composer.transmitMessage(outgoing);
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
    const deniedComposer = mainRoot.querySelector('.chat-input-container');
    const deniedState = mainRoot.querySelector('#chat-messages-feed .chat-feed-state');
    check((deniedComposer.hidden || deniedComposer.hasAttribute('data-ui-closing'))
      && deniedState?.querySelector('.chat-feed-state-icon')?.textContent === 'lock'
      && deniedState.querySelector('.chat-feed-state-title')?.textContent === t('channelPermissions.readDeniedTitle')
      && getComputedStyle(deniedState).alignItems === 'center'
      && !mainRoot.querySelector('#chat-messages-feed .bot-error'),
    'Read denial shows the themed locked state alone, without a composer or loose errors repeating it');
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
    const restoredComposer = mainRoot.querySelector('.chat-input-container');
    check(!restoredComposer.hidden && !restoredComposer.hasAttribute('data-ui-closing'),
      'Restoring reading brings the composer back');
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
    {
      // A window too small for the chosen width narrows the panel; growing again gives that width back.
      const persisted = localStorage.getItem('monky_voice_chat_width');
      main.clampVoiceChatWidth = () => 480;
      window.dispatchEvent(new Event('resize'));
      const narrowed = voicePanel.style.width;
      delete main.clampVoiceChatWidth;
      window.dispatchEvent(new Event('resize'));
      check(narrowed === '480px' && Math.abs(voicePanel.getBoundingClientRect().width - resizedVoicePanelWidth) <= 1
        && localStorage.getItem('monky_voice_chat_width') === persisted,
      'The voice chat gets its chosen width back when the window grows again, and the window never rewrites it');
    }
    mainRoot.querySelector('.voice-chat-close').click();
    check(main.voiceChatChannelId === null && voiceJoinRequests === 0,
      'Closing the panel never changes voice admission');
    main.openVoiceChannelChat('voice');
    await flush();
    const voiceIndex = chatServer.serverDetails.channels.findIndex(channel => channel.id === 'voice');
    const [deletedVoice] = chatServer.serverDetails.channels.splice(voiceIndex, 1);
    chatServer.serverDetails.channels.push({ ...deletedVoice, id: 'other-voice', name: 'Other voice' });
    // The stage moved to another room while this room's chat stayed open.
    main.viewedVoiceChannelId = 'other-voice';
    main.handleChannelDeleted({ channelId: 'voice' });
    check(main.voiceChatChannelId === null && voicePanel.hidden && !voicePanel.querySelector('.chat-feed-state'),
      'Deleting a voice room closes its open chat instead of leaving a denied conversation behind');
    chatServer.serverDetails.channels = chatServer.serverDetails.channels.filter(channel => channel.id !== 'other-voice');
    chatServer.serverDetails.channels.splice(voiceIndex, 0, deletedVoice);
    main.viewedVoiceChannelId = null;
    const sidebar = document.createElement('aside');
    check(main.clampSidebarWidth(100000) === Math.max(280, Math.floor(window.innerWidth * 0.175))
      && main.clampSidebarWidth(1) === 280, 'Sidebar halves its maximum width while preserving the readable minimum');
    {
      // The channel list's edge is a window splitter like the voice chat's: reachable and operable by
      // keyboard. The width chosen survives the window shrinking and growing again, as on a 1920 px
      // screen (17.5vw = 336 px) restored to a smaller window and maximized again.
      const channelsSidebar = mainRoot.querySelector('.channels-sidebar');
      const edge = document.createElement('div');
      edge.id = 'channels-resizer';
      edge.className = 'channels-resizer';
      channelsSidebar.prepend(edge);
      const savedWidth = localStorage.getItem('monky_channels_width');
      localStorage.removeItem('monky_channels_width');
      let widest = 336;
      main.clampSidebarWidth = width => Math.min(widest, Math.max(280, width));
      const press = key => edge.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      const resizeWindowTo = width => {
        widest = width;
        window.dispatchEvent(new Event('resize'));
      };
      const shows = width => channelsSidebar.style.width === `${width}px` && edge.getAttribute('aria-valuenow') === String(width);
      const stored = () => localStorage.getItem('monky_channels_width');
      main.setupChannelsResizer();
      try {
        check(edge.getAttribute('role') === 'separator' && edge.getAttribute('aria-orientation') === 'vertical'
          && edge.tabIndex === 0 && edge.getAttribute('aria-valuemin') === '280' && edge.getAttribute('aria-valuemax') === '336',
        'The channel list edge is a focusable separator that announces its bounds');
        press('End');
        check(shows(336) && stored() === '336', 'End widens the channel list from the keyboard and keeps that width');
        resizeWindowTo(280);
        check(shows(280) && edge.getAttribute('aria-valuemax') === '280' && stored() === '336',
          'A smaller window narrows the list within its bounds and never rewrites the width chosen');
        press('ArrowRight');
        check(shows(280) && stored() === '336', 'A key the bounds swallow changes nothing, the width chosen included');
        resizeWindowTo(336);
        check(shows(336) && edge.getAttribute('aria-valuemax') === '336' && stored() === '336',
          'Growing the window again gives the chosen width back');
        press('Home');
        check(shows(280) && stored() === '280', 'Home narrows the list from the keyboard and keeps that width');
      } finally {
        main.channelsResizeCleanup?.();
        main.channelsResizeCleanup = null;
        delete main.clampSidebarWidth;
        edge.remove();
        channelsSidebar.style.removeProperty('width');
        if (savedWidth === null) localStorage.removeItem('monky_channels_width');
        else localStorage.setItem('monky_channels_width', savedWidth);
      }
    }
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
  const keptListeners = new Set(), keptPending = [];
  const kept = new CommunityFeed({ ...client,
    onEvent: listener => { keptListeners.add(listener); return () => keptListeners.delete(listener); },
    sendRequest: () => new Promise(resolve => keptPending.push(resolve)) }, server);
  const keptLoad = kept.load();
  keptPending[0](snapshot);
  await keptLoad; await flush();
  const shownSnapshot = kept.snapshot;
  for (const type of ['ROLES_LIST', 'CATEGORIES_UPDATED', 'CHANNEL_UPDATED']) {
    for (const listener of keptListeners) listener(`message.${type}`, {});
  }
  check(shownSnapshot && kept.snapshot === shownSnapshot && keptPending.length === 1,
    'Role, category and channel changes that keep this member\'s access ask for no new community snapshot (#842)');
  allowed = !allowed;
  for (const listener of keptListeners) listener('message.ROLES_LIST', {});
  check(kept.snapshot === null, 'Losing access still clears the community snapshot at once');
  allowed = !allowed;
  kept.dispose();
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
  // Moderating the forum (Permission.MANAGE_CHANNELS, 1 << 0) is part of its access; reading it stays allowed.
  let moderates = true;
  const forumServer = { ...server, hasPermission: permission => allowed && (permission !== 1 || moderates) };
  const staleForum = new ForumView(root, forumClient, forumServer, 'forum', () => {});
  for (const listener of forumListeners) listener('message.ROLES_LIST', {});
  forumPending[0]({ channelId: 'forum', posts: [post], hasMore: false, nextOffset: 1 });
  await flush();
  check(root.querySelectorAll('.forum-post-row').length === 1 && forumPending.length === 1,
    'A role list resent by someone else logging in keeps the pending forum list and asks for nothing');
  const reloading = staleForum.load();
  moderates = false;
  for (const listener of forumListeners) listener('message.ROLES_LIST', {});
  forumPending[1]({ channelId: 'forum', posts: [post], hasMore: false, nextOffset: 1 });
  await reloading;
  await flush();
  check(root.querySelectorAll('.forum-post-row').length === 0, 'Permission invalidation rejects pending private forum results immediately');
  await until(() => forumPending.length === 3);
  forumPending[2]({ channelId: 'forum', posts: [], hasMore: false, nextOffset: 0 });
  await flush();
  staleForum.destroy();
  check(forumListeners.size === 0, 'Pending forum listeners are removed on disposal');
  return checks;
}
