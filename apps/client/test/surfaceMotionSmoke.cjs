const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('surfaces enter, exit, reopen and preserve modal ownership and trusted consent', { timeout: 90000 }, async () => {
    const profile = path.join(root, 'dist-test', `surface-motion-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SURFACE_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
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
  app.setPath('userData', process.env.MONKY_SURFACE_PROFILE);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  let vite, browser, timer;
  const finish = async code => {
    clearTimeout(timer);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{ name: 'surface-motion-fixture', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__surfaces__') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"></head><body><button id="origin">Origin</button></body></html>');
        });
      } }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 1200, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    timer = setTimeout(() => { console.error('Surface motion timeout'); void finish(1); }, 75000);
    await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__surfaces__`);
    browser.webContents.debugger.attach('1.3');
    await browser.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const evaluate = source => browser.webContents.executeJavaScript(source, true);
    if (process.argv.includes('--stage-only')) {
      const { runScreenStageSmoke } = require('./screenStageSmoke.cjs');
      const { runScreenViewersSmoke } = require('./screenViewersSmoke.cjs');
      const { runAutomaticScreenPipSmoke } = require('./automaticScreenPipSmoke.cjs');
      const { appEventHandlerSource } = require('./fixtures/screenSharingUiModel.cjs');
      const source = appEventHandlerSource('native_screen.capture_fallback');
      const stage = await evaluate(`(${runScreenStageSmoke.toString()})(${JSON.stringify(source)})`);
      const viewers = await evaluate(`(${runScreenViewersSmoke.toString()})()`);
      const pip = await evaluate(`(${runAutomaticScreenPipSmoke.toString()})()`);
      console.log(`Hidden stage surfaces: ${stage} stage, ${viewers} viewer and ${pip} automatic PiP checks passed`);
      await finish(0);
      return;
    }
    await evaluate(`window.surfaceRegression = (${regression.toString()})(); void 0`);
    for (;;) {
      const step = await evaluate('window.surfaceRegression.next().catch(error => ({failure: error.stack || String(error)}))');
      if (step.failure) throw new Error(step.failure);
      if (step.done) { console.log(`Surface motion: ${step.value} checks passed`); break; }
      if (step.value === 'reduce' || step.value === 'motion') {
        await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: step.value === 'reduce' ? 'reduce' : 'no-preference' }],
        });
      } else if (step.value === 'nested-aria') {
        const { nodes } = await browser.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
        const dialogs = nodes.filter(node => !node.ignored && node.role?.value === 'dialog').map(node => node.name?.value);
        await evaluate(`window.surfaceVisibleDialogs = ${JSON.stringify(dialogs)}`);
      } else if (step.value === 'trusted-confirm') {
        const point = await evaluate(`(() => {
          const rect = document.querySelector('.modal-backdrop:not([data-ui-closing]) [data-action="confirm"]').getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        })()`);
        await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      }
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    }
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function* regression() {
  const [motion, { openCommunityModal }, dialog, { ContextMenu }, { CodeBlockModal },
    { EmojiPicker }, { ColorPicker }, { selectEnhancer }, { OnboardingWizard },
    { TutorialViewer }, { setSurfaceVisible }] = await Promise.all([
    import('/utils/surfaceMotion.ts'), import('/views/CommunityModal.ts'), import('/views/Dialog.ts'),
    import('/views/ContextMenu.ts'), import('/views/CodeBlockModal.ts'), import('/views/EmojiPicker.ts'),
    import('/views/ColorPicker.ts'), import('/core/SelectEnhancer.ts'), import('/views/OnboardingWizard.ts'),
    import('/tutorials/TutorialViewer.ts'), import('/utils/surfaceVisibility.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const settle = async element => {
    await Promise.allSettled(element.getAnimations({ subtree: true }).filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
    await frame();
  };
  const key = (element, value, extra = {}) => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: value, bubbles: true, cancelable: true, ...extra,
  }));
  yield 'motion';
  for (const [token, expected] of [['.2s', 200], ['140ms', 140], ['0s', 0]]) {
    document.documentElement.style.setProperty('--motion-modal-duration', token);
    check(motion.motionDuration('modal') === expected, `Motion duration handles CSS time ${token}, including production minification`);
  }
  document.documentElement.style.removeProperty('--motion-modal-duration');
  const origin = document.querySelector('#origin');
  origin.focus();
  const parent = openCommunityModal('Parent');
  parent.content.innerHTML = '<button id="child-trigger">Child</button><select data-search-placeholder="Find" id="parent-select"><option>A</option><option>B</option></select>';
  check(parent.element.getAnimations().length > 0, 'Community modal has a real entrance');
  await settle(parent.element);
  const trigger = parent.content.querySelector('button');
  trigger.focus();
  const child = openCommunityModal('Child');
  check(parent.element.inert && parent.element.querySelector('.modal-card').hasAttribute('data-ui-closing'),
    'Parent becomes inert immediately while its real card transitions out');
  check(!parent.element.hidden && getComputedStyle(child.element).backgroundColor === 'rgba(0, 0, 0, 0)', 'Only one dark scrim while child enters');
  await settle(child.element);
  check(parent.element.querySelector('.modal-card').hidden, 'Suspended parent finishes its visual exit behind the child');
  child.close();
  check(child.signal.aborted && child.element.inert && child.element.hasAttribute('data-ui-closing'), 'Cleanup and inert state are immediate on exit');
  check(child.element.isConnected && child.element.getAnimations().length > 0, 'Child retains real DOM during exit');
  check(motion.topModal() === parent.element && !parent.element.inert, 'Exiting child never masks active parent');
  check(document.activeElement === trigger, 'Parent trigger regains focus synchronously');
  await settle(child.element);
  check(!child.element.isConnected, 'Child is removed after exit');

  const middle = openCommunityModal('Nested middle');
  middle.content.innerHTML = '<button>Nested trigger</button>';
  const middleTrigger = middle.content.querySelector('button');
  middleTrigger.focus();
  const leaf = openCommunityModal('Nested leaf');
  check(parent.element.inert && middle.element.inert && motion.topModal() === leaf.element,
    'Three nested modals retain only the leaf as the interactive top modal');
  yield 'nested-aria';
  check(JSON.stringify(window.surfaceVisibleDialogs) === '["Nested leaf"]',
    'Chromium accessibility tree exposes only the active dialog, not suspended parents');
  delete window.surfaceVisibleDialogs;
  leaf.close();
  check(motion.topModal() === middle.element && !middle.element.inert && parent.element.inert,
    'Closing a leaf restores only its immediate parent');
  check(document.activeElement === middleTrigger, 'Nested close restores its own trigger focus');
  await settle(leaf.element);
  const replacementLeaf = openCommunityModal('Nested replacement');
  middle.close();
  check(replacementLeaf.signal.aborted && !replacementLeaf.element.isConnected,
    'Reopened leaf belongs to the unsuspended middle parent and aborts synchronously with it');
  check(motion.topModal() === parent.element && !parent.element.inert,
    'Parent abort through multiple nested levels restores the surviving root');
  await settle(middle.element);

  selectEnhancer.init();
  const select = parent.content.querySelector('select');
  key(select, 'Enter');
  const popup = document.querySelector('.monky-select-popup:not([data-ui-closing])');
  check(popup && motion.ownsSurface(parent.element, popup), 'Portaled select belongs to the modal');
  const search = popup.querySelector('input');
  search?.focus();
  key(search ?? select, 'Tab');
  check(!parent.signal.aborted, 'Tab in a child popup does not close the parent');
  if (!document.querySelector('.monky-select-popup:not([data-ui-closing])')) key(select, 'Enter');
  key(document.activeElement, 'Escape');
  check(!parent.signal.aborted && motion.topModal() === parent.element, 'First Escape closes just the popup');
  selectEnhancer.dispose();

  const menu = new ContextMenu();
  menu.open(100, 100, [{ label: 'Nested', submenu: [{ label: 'Action', onClick() {} }] }], trigger);
  const menuRoot = document.querySelector('.floating-context-menu:not([data-ui-closing])');
  check(menuRoot.getAnimations().length > 0 && motion.hasOwnedSurface(parent.element), 'Context menu enters and owns modal focus');
  key(menuRoot.querySelector('button'), 'ArrowRight');
  const submenu = document.querySelector('.floating-context-submenu:not([data-ui-closing])');
  check(submenu?.getAnimations().length > 0, 'Submenu enters');
  key(document.activeElement, 'Escape');
  check(submenu.hasAttribute('data-ui-closing') && !parent.signal.aborted && menu.isOpenFor(trigger), 'Escape dismisses only the submenu');
  menu.close();
  check(!menu.isOpenFor(trigger) && menuRoot.hasAttribute('data-ui-closing'), 'Context menu logical close precedes exit');
  menu.open(100, 100, [{ label: 'New', onClick() {} }], trigger);
  const reopenedMenu = document.querySelector('.floating-context-menu:not([data-ui-closing])');
  await settle(menuRoot);
  check(reopenedMenu.isConnected && reopenedMenu.textContent === 'New', 'Old menu exit cannot remove new menu');
  menu.close();
  await settle(reopenedMenu);

  const picker = new EmojiPicker({ container: document.body, anchor: trigger, emojiOnly: true, floating: true, onSelectEmoji() {} });
  await picker.open();
  const emoji = document.querySelector('.emoji-picker:not([data-ui-closing])');
  check(emoji.getAnimations().length > 0, 'Emoji picker enters');
  key(emoji.querySelector('input'), 'Escape');
  check(!picker.isOpen() && !parent.signal.aborted && emoji.hasAttribute('data-ui-closing'), 'Emoji Escape leaves modal intact');
  await settle(emoji);

  const color = new ColorPicker({ id: 'motion-color', label: 'roles.color' });
  const colorHost = document.createElement('div');
  colorHost.innerHTML = color.renderHtml('#123456');
  parent.content.append(colorHost);
  color.attachEvents(colorHost, () => {});
  colorHost.querySelector('button').click();
  const colorPanel = document.querySelector('.color-picker-popover:not([data-ui-closing])');
  check(colorPanel?.matches(':popover-open') && colorPanel.getAnimations().length > 0, 'Color popover animates in top layer');
  color.close(true);
  check(!color.isOpen && colorPanel.matches(':popover-open') && colorPanel.hasAttribute('data-ui-closing'), 'Top-layer color exit is visible but logically closed');
  await settle(colorPanel);
  color.cleanup();
  parent.close();
  await settle(parent.element);

  const clicked = openCommunityModal('User close');
  await settle(clicked.element);
  clicked.element.querySelector('[data-community-close]').click();
  check(clicked.signal.aborted && clicked.element.isConnected && clicked.element.hasAttribute('data-ui-closing'),
    'Click wrapper preserves ordinary animated close instead of passing Event as immediate');
  const unrelated = openCommunityModal('Unrelated successor');
  check(clicked.element.isConnected && clicked.element.getAnimations().length > 0 && motion.topModal() === unrelated.element,
    'Opening an unrelated modal preserves nonconflicting visual exits');
  unrelated.close(true);
  await settle(clicked.element);
  check(!clicked.element.isConnected, 'Ordinary user close removes DOM only after exit completion');

  const revoked = openCommunityModal('Revoked');
  revoked.close(true);
  check(revoked.signal.aborted && !revoked.element.isConnected && revoked.element.getAnimations({ subtree: true }).length === 0,
    'Immediate close removes sensitive content and cancels an active entrance synchronously');
  const exiting = openCommunityModal('Revoked during exit');
  exiting.close();
  check(exiting.element.isConnected, 'Ordinary exit still retains its own DOM');
  exiting.close(true);
  check(!exiting.element.isConnected && exiting.element.getAnimations({ subtree: true }).length === 0,
    'Immediate revocation upgrades an already-started ordinary exit without waiting');

  const code = new CodeBlockModal();
  code.open({ onSubmit() {} });
  const oldCode = motion.topModal();
  await settle(oldCode);
  code.close();
  code.open({ onSubmit() {} });
  const newCode = motion.topModal();
  check(newCode !== oldCode && !oldCode.isConnected, 'Modal quick reopen retires obsolete fixed form IDs');
  check(newCode.querySelector('label[for="code-body"]').control === newCode.querySelector('#code-body'),
    'Reopened form labels resolve to the current field, not an outgoing duplicate ID');
  key(newCode.querySelector('textarea'), 'Escape');
  check(newCode.hasAttribute('data-ui-closing'), 'Escape closes reopened modal, not stale backdrop');
  await settle(oldCode); await settle(newCode);

  const wizard = new OnboardingWizard();
  let wizardFinished = 'pending';
  wizard.open(action => { wizardFinished = action; });
  const onboarding = motion.topModal();
  check(onboarding.getAnimations().length > 0, 'Onboarding enters');
  await settle(onboarding);
  const stableCard = onboarding.querySelector('.modal-card');
  check(!!onboarding.querySelector('#onboarding-next') && !onboarding.querySelector('#onboarding-host'),
    'Onboarding starts by showing Home before asking for a path');
  onboarding.querySelector('#onboarding-next').click();
  await settle(stableCard);
  check(!!onboarding.querySelector('#onboarding-join') && !!onboarding.querySelector('#onboarding-host'),
    'Second onboarding step offers joining or creating a server');
  onboarding.querySelector('#onboarding-host').click();
  check(onboarding.querySelector('.modal-card') === stableCard && stableCard.querySelector('[data-ui-closing]')?.inert,
    'Onboarding retains its card and animates actual outgoing content');
  const forward = stableCard.getAnimations({ subtree: true }).some(animation =>
    animation.effect.getKeyframes()[0].translate === '20px');
  check(forward, 'Forward step enters from the right');
  await settle(stableCard);
  onboarding.querySelector('#onboarding-back').click();
  check(stableCard.getAnimations({ subtree: true }).some(animation =>
    animation.effect.getKeyframes()[0].translate === '-20px'), 'Back step reverses direction');
  await settle(stableCard);
  check(!stableCard.querySelector('[data-ui-closing]') && !!onboarding.querySelector('#onboarding-host'),
    'Step completion removes old content without replacing the card');
  wizard.close();
  check(onboarding.hasAttribute('data-ui-closing'), 'Onboarding exits');
  check(wizardFinished === null, 'Closing the guide without a choice reports no action');
  await settle(onboarding);
  wizardFinished = 'pending';
  wizard.openHostTutorials(action => { wizardFinished = action; });
  const hostTutorials = motion.topModal();
  await settle(hostTutorials);
  check(!hostTutorials.querySelector('.onboarding-step-dots') && !hostTutorials.querySelector('#onboarding-create-now'),
    'Hosting tutorials opened from the create form skip the guide-only controls');
  hostTutorials.querySelector('#onboarding-back').click();
  check(hostTutorials.hasAttribute('data-ui-closing') && wizardFinished === null,
    'Back from hosting tutorials closes them instead of jumping to the guide start');
  await settle(hostTutorials);
  const tutorial = new TutorialViewer();
  tutorial.open({ id: 'motion', name: 'common.close', icon: 'info', steps: [
    { title: 'common.close', content: 'common.close' }, { title: 'common.close', content: 'common.close' },
  ] });
  const tutorialRoot = motion.topModal();
  check(tutorialRoot.getAnimations().length > 0, 'Tutorial enters');
  await settle(tutorialRoot);
  tutorialRoot.querySelector('#tutorial-next').click();
  check(tutorialRoot.querySelector('[data-ui-closing]')?.inert, 'Tutorial steps retain outgoing real content during motion');
  tutorial.close();
  await settle(tutorialRoot);

  const [{ ScreenViewersView }, { webRtcManager }, { LightboxModal }] = await Promise.all([
    import('/views/ScreenViewersView.ts'), import('/core/WebRtcManager.ts'), import('/views/LightboxModal.ts'),
  ]);
  const readViewers = webRtcManager.getScreenViewers;
  webRtcManager.getScreenViewers = async () => [];
  const viewersRoot = document.createElement('div');
  viewersRoot.className = 'stage-viewers';
  viewersRoot.dataset.publisher = 'fixture'; viewersRoot.dataset.share = 'fixture';
  document.body.append(viewersRoot);
  const viewers = new ScreenViewersView(viewersRoot);
  const viewerButton = viewersRoot.querySelector('button');
  const viewerPopup = viewersRoot.querySelector('.stage-viewers-popup');
  viewerButton.click();
  check(viewerPopup.matches(':popover-open') && viewerPopup.getAnimations().length > 0, 'Screen viewer popup enters in top layer');
  await settle(viewerPopup);
  viewerButton.click();
  check(viewerPopup.matches(':popover-open') && viewerPopup.hasAttribute('data-ui-closing'),
    'Screen viewer popup keeps top layer only for visual exit');
  viewerButton.click();
  await settle(viewerPopup);
  check(viewerPopup.matches(':popover-open') && !viewerPopup.hidden, 'Reopening viewer popup cancels late hidePopover');
  viewerButton.click();
  await settle(viewerPopup);
  check(!viewerPopup.matches(':popover-open'), 'Viewer exit releases the top layer');
  viewers.destroy(); viewersRoot.remove(); webRtcManager.getScreenViewers = readViewers;
  const lightbox = new LightboxModal();
  lightbox.open([{ kind: 'image', url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/%3E',
    fileName: 'fixture.svg', senderName: 'Fixture', timestamp: '', source: origin }], 0, async () => {});
  const media = document.querySelector('.attachment-lightbox');
  check(media.getAnimations().length > 0, 'Lightbox enters without affecting its media source');
  await settle(media);
  lightbox.close();
  check(media.hasAttribute('data-ui-closing') && media.inert, 'Lightbox closes logically before visual removal');
  await settle(media);
  check(!media.isConnected, 'Lightbox teardown finishes without a ghost overlay');

  const { renderCodeComposer, bindCodeComposer } = await import('/views/CodeComposer.ts');
  const codeRoot = document.createElement('div');
  codeRoot.innerHTML = renderCodeComposer({ code: 'const answer = 42;', language: 'javascript' });
  document.body.append(codeRoot);
  const boundCode = bindCodeComposer(codeRoot, { code: 'const answer = 42;', language: 'javascript' }, () => {});
  const disclosure = codeRoot.querySelector('details');
  const summary = codeRoot.querySelector('summary');
  const codeEditor = codeRoot.querySelector('.chat-code-editor');
  summary.click();
  check(disclosure.open && codeEditor.inert && codeEditor.getAnimations().length > 0,
    'Code disclosure closes logically while its height contracts');
  summary.click();
  await settle(codeEditor);
  check(disclosure.open && !codeEditor.inert && !codeEditor.hidden, 'Code disclosure reverses without losing the editor');
  summary.click();
  await settle(codeEditor);
  check(!disclosure.open && codeEditor.hidden, 'Code disclosure commits collapsed native state after exit');
  summary.click();
  await settle(codeEditor);
  check(disclosure.open && !codeEditor.hidden, 'Code disclosure reopens its real content');
  boundCode.destroy(); codeRoot.remove();

  const { showInfoToast } = await import('/views/CopyToast.ts');
  const firstToastClear = showInfoToast('First');
  const clearToast = showInfoToast('Second');
  const toast = document.querySelector('.chat-copy-toast');
  firstToastClear();
  check(document.querySelectorAll('.chat-copy-toast').length === 1 && toast.textContent.includes('Second'),
    'Replacing a notice retires the obsolete exit without clearing the new notice');
  await settle(toast);
  clearToast();
  check(toast.hasAttribute('data-ui-closing') && toast.getAnimations().length > 0, 'Notice performs an actual exit');
  await settle(toast);
  check(!toast.isConnected, 'Notice exit removes retained DOM');

  const panel = document.createElement('div');
  panel.textContent = 'Reusable'; panel.hidden = true; document.body.append(panel);
  setSurfaceVisible(panel, true);
  await settle(panel);
  setSurfaceVisible(panel, false);
  for (const animation of panel.getAnimations()) {
    animation.pause();
    animation.currentTime = Number(animation.effect.getTiming().duration) * 0.37;
  }
  const panelSnapshot = () => {
    const style = getComputedStyle(panel);
    return { opacity: Number(style.opacity), x: parseFloat(style.translate),
      height: panel.getBoundingClientRect().height };
  };
  const beforeReverse = panelSnapshot();
  check(beforeReverse.opacity > 0 && beforeReverse.opacity < 1 && beforeReverse.x > 0 && beforeReverse.x < 10,
    'Reversal starts from an actual intermediate rendered exit frame');
  setSurfaceVisible(panel, true);
  const afterReverse = panelSnapshot();
  check(Math.abs(afterReverse.opacity - beforeReverse.opacity) < 0.005,
    'Rapid reopen preserves the current rendered opacity instead of flashing back to zero');
  check(Math.abs(afterReverse.x - beforeReverse.x) < 0.05,
    'Rapid reopen preserves the current rendered translation instead of restarting its offset');
  check(Math.abs(afterReverse.height - beforeReverse.height) < 0.1,
    'Rapid reopen preserves the current disclosure height instead of jumping to its endpoint');
  await settle(panel);
  check(!panel.hidden && !panel.inert && !panel.hasAttribute('data-ui-closing'), 'Reversing a hide never hides the reopened panel');
  let hiddenCallbacks = 0;
  let callbackState;
  motion.hideWithMotion(panel, 'panel', () => {
    hiddenCallbacks++;
    callbackState = { inert: panel.inert, ariaHidden: panel.getAttribute('aria-hidden'),
      closing: panel.hasAttribute('data-ui-closing') };
    motion.showWithMotion(panel, 'panel');
  });
  await settle(panel);
  check(callbackState && !callbackState.inert && callbackState.ariaHidden === null && !callbackState.closing,
    'Completed hide restores interaction and ARIA before invoking its callback');
  check(!panel.hidden && panel.getAnimations().length > 0,
    'A hide callback can reopen the same node with a new real entrance');
  await settle(panel);
  check(hiddenCallbacks === 1 && !panel.hidden && !panel.inert && !panel.hasAttribute('aria-hidden')
    && !panel.hasAttribute('data-ui-closing'),
    'Reentrant entrance completes without restoring stale inert or ARIA state');
  setSurfaceVisible(panel, false);
  yield 'reduce';
  check(panel.hidden && panel.getAnimations().length === 0, 'Reduced-motion change settles active exit immediately');
  const reduced = openCommunityModal('Reduced');
  check(reduced.element.getAnimations().length === 0, 'Reduced-motion modal entry has no animation');
  reduced.close();
  check(!reduced.element.isConnected, 'Reduced-motion modal exits synchronously');
  panel.remove();
  yield 'motion';
  let resolution;
  const confirmation = dialog.showConfirm({ message: 'Trusted consent', requireUserGesture: true }).then(value => { resolution = value; });
  const consent = motion.topModal();
  await settle(consent);
  consent.querySelector('[data-action="confirm"]').click();
  await Promise.resolve();
  check(resolution === undefined && !consent.hasAttribute('data-ui-closing'), 'Synthetic click cannot grant consent');
  yield 'trusted-confirm';
  await confirmation;
  check(resolution === true && consent.hasAttribute('data-ui-closing'), 'Trusted consent resolves before visual exit completes');
  await settle(consent);
  check(!document.querySelector(motion.ACTIVE_MODAL_SELECTOR), 'No active modal or delayed cleanup remains');
  return checks;
}
