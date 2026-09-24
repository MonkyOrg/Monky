'use strict';

module.exports = { runQualitySettingsSmoke };

async function runQualitySettingsSmoke() {
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
  const settled = async (predicate, description) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await wait();
    }
    const tip = document.querySelector('.monky-tooltip');
    throw new Error(`Quality settings did not settle: ${description}; focused=${document.hasFocus()}; active=${document.activeElement?.id || document.activeElement?.tagName}; tooltipHidden=${tip?.hidden}`);
  };
  const settleHelpLayout = async button => {
    await document.fonts.ready;
    let previous, stableFrames = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const position = [];
      for (let element = button; element; element = element.parentElement) {
        const rect = element.getBoundingClientRect();
        position.push(rect.x, rect.y, rect.width, rect.height, element.scrollTop, element.scrollLeft);
      }
      const current = JSON.stringify(position);
      stableFrames = current === previous ? stableFrames + 1 : 0;
      if (stableFrames === 3) return;
      previous = current;
    }
    throw new Error(`Bitrate help layout did not settle: ${button.dataset.bitrateHelp}`);
  };
  let mediaRequests = 0;
  const media = navigator.mediaDevices;
  const originalUserMedia = media.getUserMedia;
  const originalDisplayMedia = media.getDisplayMedia;
  const denyMedia = async () => { mediaRequests++; throw new Error('This UI smoke must not request media.'); };
  media.getUserMedia = denyMedia;
  media.getDisplayMedia = denyMedia;
  const [{ SettingsModal }, { settingsStore }, { appEvents }, { initTooltips }, language, { videoService },
    { webRtcManager }, { ScreenSharePickerModal }] = await Promise.all([
    import('/views/SettingsModal.ts'), import('/stores/settingsStore.ts'), import('/core/EventBus.ts'),
    import('/core/TooltipService.ts'), import('/i18n/index.ts'), import('/core/VideoService.ts'),
    import('/core/WebRtcManager.ts'), import('/views/ScreenSharePickerModal.ts'),
  ]);
  const originalLanguage = language.getLanguage();
  const originalApi = window.api;
  const original = {
    qualityPreset: settingsStore.qualityPreset,
    customProfile: { ...settingsStore.customProfile },
    screenShareTelemetryEnabled: settingsStore.screenShareTelemetryEnabled,
    screenShareTelemetryPosition: settingsStore.screenShareTelemetryPosition,
    screenShareTelemetryMode: settingsStore.screenShareTelemetryMode,
    preferredVideoCodec: settingsStore.preferredVideoCodec,
    screenSharePreviewPauseWhenUnfocused: settingsStore.screenSharePreviewPauseWhenUnfocused,
    screenShareReceiver: settingsStore.screenShareReceiver,
  };
  let modal;
  const disposeTooltips = initTooltips();
  try {
    for (const [locale, platform] of [['pt-BR', 'win32'], ['en', 'win32'], ['pt-BR', 'darwin'], ['en', 'darwin']]) {
      window.api = { ...originalApi, platform };
      language.setLanguage(locale);
      settingsStore.qualityPreset = 'CUSTOM';
      settingsStore.screenShareTelemetryEnabled = false;
      settingsStore.screenShareTelemetryPosition = 'top-right';
      settingsStore.screenShareTelemetryMode = 'simple';
      settingsStore.screenSharePreviewPauseWhenUnfocused = true;
      settingsStore.preferredVideoCodec = 'auto';
      settingsStore.screenShareReceiver = settingsStore.nativeScreenReceiverComingSoon ? 'chromium' : 'native';
      modal = new SettingsModal();
      for (const tab of Object.values(modal)) {
        if (tab !== modal.qualityTab && tab && typeof tab === 'object' && typeof tab.renderHtml === 'function') {
          tab.attachEvents = async () => {};
        }
      }
      modal.voiceVideoTab.refreshDevices = async () => {};
      modal.voiceVideoTab.startVadMeter = () => {};
      modal.aboutTab.loadAppVersion = async () => {};
      await modal.open();
      const root = document.querySelector('.modal-backdrop--settings');
      root.querySelector('[data-tab="quality"]').click();
      await settled(() => !!root.querySelector('[data-section-target="video-telemetry"]'), `${locale}/telemetry navigation`);
      const quality = root.querySelector('#tab-panel-quality');
      const voice = root.querySelector('#tab-panel-voice_video');
      const nativeReceiver = quality.querySelector('#screen-receiver-native');
      const chromiumReceiver = quality.querySelector('#screen-receiver-chromium');
      const isMac = window.api.platform === 'darwin';
      check(nativeReceiver.tagName === 'BUTTON' && chromiumReceiver.tagName === 'BUTTON'
        && nativeReceiver.classList.contains('input-mode-card') && chromiumReceiver.classList.contains('input-mode-card'),
      'Receiver choices must use accessible selectable cards, not native radios.');
      check(nativeReceiver.disabled === isMac && nativeReceiver.getAttribute('aria-pressed') === String(!isMac)
        && chromiumReceiver.getAttribute('aria-pressed') === String(isMac),
      'Native must be the Windows default; macOS must disable native and select Chromium.');
      check(!isMac || nativeReceiver.textContent.includes(language.t('screenShare.comingSoon')),
        'macOS must label unavailable native reception as coming soon.');
      check(quality.querySelector('#screen-receiver-warning').textContent === language.t('settings.screenReceiverWarning')
        && quality.querySelector('#screen-receiver-apply').textContent === language.t('settings.screenReceiverApply'),
      'The receiver limitation and next-Watch application policy must be visible in the selected language.');
      check(root.querySelector('[data-section-target="screen-receiver"]')?.textContent === language.t('settings.screenReceiverSection'),
        'Receiver settings must have a localized navigation anchor.');
      chromiumReceiver.click();
      settingsStore.load(false);
      check(settingsStore.getScreenShareReceiver() === 'chromium' && chromiumReceiver.getAttribute('aria-pressed') === 'true',
        'Explicit Chromium selection must persist across settings reload.');
      nativeReceiver.click();
      check(settingsStore.getScreenShareReceiver() === (isMac ? 'chromium' : 'native'),
        'macOS cannot activate native reception; Windows can switch back explicitly.');
      const qualityTab = root.querySelector('[data-tab="quality"]');
      const menuLabel = locale === 'pt-BR' ? 'Qualidade e compartilhamento' : 'Quality & sharing';
      check(!/Verification pending|Verificação pendente/.test(quality.textContent),
        'Quality settings must not expose provisional verification notices.');
      check(qualityTab.querySelector('span:last-child').textContent === menuLabel &&
        root.querySelector('#settings-current-tab-title span:last-child').textContent === menuLabel &&
        qualityTab.classList.contains('active') && getComputedStyle(quality).display !== 'none',
      'The renamed menu and active header must describe media quality plus sharing without changing navigation IDs.');
      check(qualityTab.scrollWidth <= qualityTab.clientWidth + 1,
        'The localized menu label must remain fully available in the sidebar at small viewports.');
      const av1 = quality.querySelector('#select-video-codec option[value="av1"]');
      check(av1.disabled && av1.textContent.includes(language.t('screenShare.comingSoon')),
        'AV1 must remain disabled and localized as coming soon.');
      check([...quality.querySelectorAll('#select-video-codec option')].map(option => option.value).join(',') === 'auto,h264,av1',
        'Only Automatic, H.264 and the disabled AV1 entry belong in the screen codec chooser.');
      for (const codec of ['auto', 'h264'])
        check(!quality.querySelector(`#select-video-codec option[value="${codec}"]`).disabled,
          'The libobs H.264 choices must remain enabled.');
      check(quality.querySelectorAll('#checkbox-screen-telemetry').length === 1 &&
        !voice.querySelector('#checkbox-screen-telemetry, #select-screen-telemetry-position, #select-screen-telemetry-mode'),
      'Telemetry controls must exist once, only under Quality.');
      const section = quality.querySelector('[data-settings-section="video-telemetry"]');
      const link = root.querySelector('[data-section-target="video-telemetry"]');
      check(section.dataset.settingsLabel === language.t('settings.telemetrySection') &&
        link.textContent === language.t('settings.telemetrySection'), 'Telemetry navigation must use the selected language.');
      link.click();
      check(link.getAttribute('aria-current') === 'location', 'The telemetry shortcut must select its real section.');
      const toggle = quality.querySelector('#checkbox-screen-telemetry');
      check(!!toggle.closest('.toggle-switch'), 'Telemetry must retain the switch component.');
      const preview = quality.querySelector('#checkbox-screen-preview-focus');
      check(preview.checked && !!preview.closest('.toggle-switch') &&
        preview.getAttribute('aria-describedby') === 'screen-preview-focus-description',
      'Preview focus must default on and use the existing accessible switch.');
      const previewSection = quality.querySelector('[data-settings-section="screen-preview"]');
      const previewLink = root.querySelector('[data-section-target="screen-preview"]');
      check(previewSection.dataset.settingsLabel === language.t('settings.screenPreviewSection') &&
        previewLink?.textContent === language.t('settings.screenPreviewSection'),
      'Preview section navigation must use the selected language.');
      previewLink.click();
      check(previewLink.getAttribute('aria-current') === 'location', 'The preview shortcut must select its real section.');
      const preset = quality.querySelector('#select-preset');
      const previousHelp = quality.querySelector('[data-bitrate-help]');
      preset.value = 'NORMAL';
      preset.dispatchEvent(new Event('change', { bubbles: true }));
      await settled(() => !quality.querySelector('[data-bitrate-help]'), `${locale}/standard preset`);
      check(!previousHelp.isConnected, 'A non-custom preset must remove its obsolete help controls.');
      preset.value = 'CUSTOM';
      preset.dispatchEvent(new Event('change', { bubbles: true }));
      await settled(() => quality.querySelectorAll('[data-bitrate-help]').length === 3, `${locale}/custom preset`);
      check(quality.querySelector('#checkbox-screen-telemetry') === toggle,
        'Changing quality presets must not recreate or detach telemetry controls.');
      check(quality.querySelector('#checkbox-screen-preview-focus') === preview,
        'Changing presets must not recreate the preview focus switch.');
      const helps = [...quality.querySelectorAll('[data-bitrate-help]')];
      check(helps.length === 3, 'Audio, camera and screen bitrates must each have help.');
      const custom = JSON.stringify(settingsStore.customProfile);
      for (const button of helps) {
        button.scrollIntoView({ block: 'center', behavior: 'instant' });
        await settleHelpLayout(button);
        check(button.type === 'button' && !button.closest('label') &&
          button.querySelector('[aria-hidden="true"]')?.textContent === 'help',
        'Help must be a labeled, non-submitting keyboard button outside the field label.');
        check(button.getAttribute('aria-label').startsWith(locale === 'pt-BR' ? 'Como escolher' : 'Choosing'),
          'The help button accessible name must be translated.');
        const row = button.closest('.quality-custom-row');
        const label = row.querySelector('label[for]');
        check(label.htmlFor === row.querySelector('select').id, 'Bitrate field labels must still identify their select.');
        const caption = button.parentElement.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        check(bounds.width >= 20 && bounds.height >= 20 && bounds.right <= caption.right + 1,
          'The question icon must fit its aligned label column.');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        button.focus({ preventScroll: true });
        if (!document.hasFocus()) button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        const tip = document.querySelector('.monky-tooltip');
        await settled(() => !tip.hidden && tip.textContent === button.dataset.tooltip, `${locale}/${button.dataset.bitrateHelp}/keyboard help`);
        check(button.getAttribute('aria-describedby')?.split(/\s+/).includes(tip.id),
          'Keyboard focus must expose the existing accessible tooltip.');
        const content = tip.querySelector('.monky-tooltip__content');
        check(content.scrollHeight <= content.clientHeight + 1, `The ${locale} help must not be clipped at ${innerWidth}x${innerHeight}.`);
        const tipBounds = tip.getBoundingClientRect();
        check(tipBounds.left >= 7 && tipBounds.top >= 7 && tipBounds.right <= innerWidth - 7 &&
          tipBounds.bottom <= innerHeight - 7, 'The bitrate tooltip must stay within the viewport.');
        check(tip.textContent.includes('upload') && tip.textContent.includes('30%') &&
          tip.textContent.includes('P2P') && tip.textContent.includes('SFU'),
        'Help must explain upload headroom and recipient/transport costs.');
        if (button.dataset.bitrateHelp !== 'audio') {
          for (const recommendation of ['5 Mbps → 2000 kbps', '10 Mbps → 5000 kbps', '20 Mbps → 10000 kbps', '50+ Mbps → 20000 kbps']) {
            check(tip.textContent.includes(recommendation), 'Video help must retain conservative per-copy upload examples.');
          }
          check(tip.textContent.includes('FPS') && tip.textContent.includes('download'),
            'Video help must not confuse bitrate with FPS or download bandwidth.');
        }
        button.click();
        check(JSON.stringify(settingsStore.customProfile) === custom && settingsStore.qualityPreset === 'CUSTOM',
          'Opening help must not change the quality profile.');
        button.blur();
        if (!document.hasFocus()) button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await settled(() => tip.hidden, `${locale}/${button.dataset.bitrateHelp}/blur`);
        // Scroll events dismiss tooltips; deliver pending layout/scroll before entering again.
        await settleHelpLayout(button);
        button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
        await settled(() => !tip.hidden, `${locale}/${button.dataset.bitrateHelp}/hover`);
        check(tip.textContent === button.dataset.tooltip, 'Mouse hover must show the same help as keyboard focus.');
        button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
        await settled(() => tip.hidden, `${locale}/${button.dataset.bitrateHelp}/mouse leave`);
      }
      let changes = 0;
      const off = appEvents.on('settings.updated', () => changes++);
      try {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        const position = quality.querySelector('#select-screen-telemetry-position');
        position.value = 'bottom-left';
        position.dispatchEvent(new Event('change', { bubbles: true }));
        const mode = quality.querySelector('#select-screen-telemetry-mode');
        mode.value = 'complete';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        preview.checked = false;
        preview.dispatchEvent(new Event('change', { bubbles: true }));
        check(changes === 4, 'Every telemetry/preview control must notify the live UI exactly once.');
        const stored = JSON.parse(localStorage.getItem('monky_settings'));
        check(stored.screenShareTelemetryEnabled && stored.screenShareTelemetryPosition === 'bottom-left' &&
          stored.screenShareTelemetryMode === 'complete' && stored.screenSharePreviewPauseWhenUnfocused === false,
        'Telemetry and preview controls must preserve their persisted settings.');
        check(settingsStore.qualityPreset === 'CUSTOM' && JSON.stringify(settingsStore.customProfile) === custom,
          'Telemetry must not alter the media quality profile.');
      } finally { off(); }
      root.querySelector('[data-tab="voice_video"]').click();
      await wait();
      check(!root.querySelector('.settings-section-nav[aria-hidden="false"] [data-section-target="video-telemetry"]'),
        'Voice and Video must no longer advertise the telemetry section.');
      check(!root.querySelector('.settings-section-nav[aria-hidden="false"] [data-section-target="screen-preview"]'),
        'Voice and Video must not advertise the preview section from Quality.');
      root.querySelector('[data-tab="quality"]').click();
      check(toggle.checked && quality.querySelector('#select-screen-telemetry-mode').value === 'complete',
        'Changing tabs must preserve telemetry choices.');
      const metadataOnly = new MediaStream();
      videoService.registerNativeScreenShare(metadataOnly, {
        desktopSourceId: 'window:1:0', thumbnail: '', audioBitrateKbps: 128,
        source: { shareId: metadataOnly.id, instanceId: crypto.randomUUID(), audio: true,
          video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } },
      });
      try {
        const codec = quality.querySelector('#select-video-codec'), previousCodec = settingsStore.preferredVideoCodec;
        const previousSettings = localStorage.getItem('monky_settings');
        const dismiss = async key => {
          await settled(() => document.querySelector('.dialog-card'), `${locale}/native settings error`);
          const dialog = document.querySelector('.dialog-card');
          check(dialog.querySelector('.dialog-message').textContent === language.t(key), 'Native setting errors must use the selected language.');
          dialog.querySelector('[data-action="confirm"]').click();
          await settled(() => !document.querySelector('.dialog-card'), `${locale}/native error dismissal`);
        };
        codec.value = 'av1';
        codec.dispatchEvent(new Event('change', { bubbles: true }));
        check(settingsStore.preferredVideoCodec === previousCodec && codec.value === previousCodec,
          'An incompatible native codec change must restore the selection before persistence.');
        check(localStorage.getItem('monky_settings') === previousSettings, 'Rejected native settings must not be saved.');
        await dismiss('screenShare.codecsSoon');
        const frameRate = quality.querySelector('#custom-screenFps');
        frameRate.value = '144';
        frameRate.dispatchEvent(new Event('change', { bubbles: true }));
        check(JSON.stringify(settingsStore.customProfile) === custom, 'An unsupported native profile must restore every previous field.');
        check(Number(quality.querySelector('#custom-screenFps').value) === settingsStore.customProfile.screenFps,
          'The custom form must display the restored native frame rate.');
        check(localStorage.getItem('monky_settings') === previousSettings, 'A rejected profile must leave persisted settings unchanged.');
        await dismiss('screenShare.nativeProfileChangeBlocked');
      } finally { videoService.stopScreenShare(metadataOnly.id); }
      modal.close();
      const storedAfterClose = localStorage.getItem('monky_settings');
      chromiumReceiver.click();
      check(localStorage.getItem('monky_settings') === storedAfterClose,
        'Closing settings must remove detached receiver card listeners.');
      preview.checked = true;
      preview.dispatchEvent(new Event('change', { bubbles: true }));
      check(localStorage.getItem('monky_settings') === storedAfterClose && settingsStore.screenSharePreviewPauseWhenUnfocused === false,
        'Closing settings must retire the detached preview switch listener.');
      await settled(() => document.querySelector('.monky-tooltip').hidden, `${locale}/modal close`);
      await modal.open();
      const reopened = document.querySelector('#tab-panel-quality');
      check(reopened.querySelector('#checkbox-screen-telemetry').checked &&
        reopened.querySelector('#select-screen-telemetry-position').value === 'bottom-left' &&
        reopened.querySelector('#select-screen-telemetry-mode').value === 'complete',
      'Reopening settings must restore the same telemetry choices in Quality.');
      check(reopened.querySelector('#checkbox-screen-preview-focus').checked === false,
        'Reopening settings must restore the preview focus preference.');
      modal.close();

      const previousApi = window.api;
      const previousCapabilities = webRtcManager.getNativeScreenCapabilities;
      const picker = new ScreenSharePickerModal();
      const windowId = `window:123:${'a'.repeat(64)}`;
      const candidate = (id, type, name = 'Synthetic <application> & title') => ({ id, type, name, thumbnailDataUrl: '', appIconDataUrl: null });
      const monitors = ['a', 'b', 'c', 'd'].map((token, index) => Object.freeze({
        ...candidate(`native-monitor:${token.repeat(64)}`, 'screen', 'Generic PnP Monitor'),
        displayNumber: [3, 1, 4, 2][index],
        thumbnailDataUrl: index === 0
          ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#18a"/></svg>')}` : '',
      }));
      let sources = [{ ...candidate(windowId, 'window'), displayNumber: 1 }, candidate(`window:456:${'c'.repeat(64)}`, 'window'),
        ...monitors, candidate('screen:0:0', 'screen')];
      let nativeCommands = 0, enumerations = 0;
      const sourceOpens = [];
      let sourceOpenSuccess = true;
      let enumerateSources = async () => sources;
      const capabilities = { capture: false, captureAudio: true, receive: true, backend: null, reason: null,
        requiresSelectionProbe: true, captureKinds: ['window', 'monitor', 'game'] };
      window.api = {
        platform: 'win32',
        nativeScreenCommand: async () => { nativeCommands++; throw new Error('Picker UI must not probe or capture native media.'); },
        prepareScreenShareWindow: async () => { nativeCommands++; throw new Error('Choosing a method must not prepare its window.'); },
        getDesktopSources: async () => { enumerations++; return enumerateSources(); },
        openExternal: async url => { sourceOpens.push(url); return { success: sourceOpenSuccess }; },
      };
      webRtcManager.getNativeScreenCapabilities = async () => capabilities;
      try {
        await picker.open();
        const pickerRoot = document.querySelector('.screen-share-picker-card');
        const info = pickerRoot.querySelector('#share-capture-info');
        const tabs = [...pickerRoot.querySelectorAll('[role="tab"]')];
        check(tabs.length === 2 && !pickerRoot.querySelector('#share-tab-game') && tabs.every(tab => !tab.disabled &&
          tab.querySelector('.share-tab-status').hidden && tab.querySelector('.share-tab-status').textContent === '' &&
          !tab.title && !tab.hasAttribute('aria-describedby')),
        'Explicit selection support must show two source types, never a duplicate Games list.');
        check(info.dataset.backend === 'probe-pending' && nativeCommands === 0 &&
          info.hidden && !info.textContent && getComputedStyle(info).display === 'none' && info.getBoundingClientRect().height === 0,
        'Internal verification stays pending without probing, a provisional banner or an empty layout placeholder.');
        check(pickerRoot.querySelector('#share-window-methods').hidden,
          'Window capture methods must wait for an explicitly selected window.');
        const refresh = pickerRoot.querySelector('#btn-refresh-sources');
        const aspect = pickerRoot.querySelector('#chk-preserve-aspect-ratio');
        check(refresh instanceof HTMLButtonElement && refresh.type === 'button' && !refresh.disabled &&
          refresh.getAttribute('aria-controls') === 'share-sources-panel' &&
          refresh.getAttribute('aria-label') === language.t('screenShare.refreshSourcesLabel') &&
          refresh.textContent.includes(language.t('screenShare.refreshSources')),
        'Refresh must be an accessible native button with localized text and an explicit controlled panel.');
        check(aspect instanceof HTMLInputElement && !aspect.checked && aspect.getAttribute('role') === 'switch' &&
          aspect.closest('.toggle-switch') && aspect.getAttribute('aria-labelledby') === 'share-aspect-label' &&
          aspect.getAttribute('aria-describedby') === 'share-aspect-description' &&
          pickerRoot.querySelector('#share-aspect-label').textContent === language.t('screenShare.preserveAspectRatio'),
        'Each new picker starts with a localized, described aspect-ratio switch off, not a standalone checkbox.');
        aspect.focus();
        check(document.activeElement === aspect && aspect.tabIndex === 0,
          'The aspect-ratio switch must be reachable by keyboard.');
        aspect.click();
        check(aspect.checked, 'The existing switch component must toggle its native checked state.');
        const choose = () => pickerRoot.querySelector('.source-item')
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        choose();
        check(picker.selectedSourceId === windowId && !pickerRoot.querySelector('#btn-share').disabled &&
          info.dataset.backend === 'probe-pending' && nativeCommands === 0,
        'Selecting the opaque window ID permits confirmation but does not itself verify or capture.');
        check(!pickerRoot.querySelector('application') &&
          pickerRoot.querySelector('.source-name').textContent.includes('Synthetic <application> & title') &&
          pickerRoot.querySelector('.source-item').getAttribute('aria-label') === 'Synthetic <application> & title' &&
          pickerRoot.querySelector('#share-method-label').textContent.includes('Synthetic <application> & title'),
        'Application names remain escaped display/accessibility text even when displayNumber is present.');
        const windowMethod = pickerRoot.querySelector('#share-method-window');
        const gameMethod = pickerRoot.querySelector('#share-method-game');
        const windowCards = [...pickerRoot.querySelectorAll('.source-item')];
        check(!pickerRoot.querySelector('#share-window-methods').hidden &&
          windowMethod.getAttribute('aria-pressed') === 'true' && gameMethod.getAttribute('aria-pressed') === 'false' &&
          windowMethod.tabIndex === 0 && gameMethod.tabIndex === -1,
        'A selected window must default to the accessible Normal card, not Game Capture.');
        check(windowMethod.textContent.includes('Normal') &&
          !/\bWGC\b|\bhook\b/i.test(windowMethod.textContent + gameMethod.textContent),
        'Method cards must use the friendly Normal/Game Capture names without implementation jargon.');
        check([windowMethod, gameMethod].every(button => !button.disabled &&
          button.querySelector('.share-method-status').hidden && button.querySelector('.share-method-status').textContent === '' &&
          getComputedStyle(button.querySelector('.share-method-status')).display === 'none' &&
          !button.title && button.getAttribute('aria-describedby') === `${button.id}-description`),
        'Supported method cards keep their accessible descriptions without provisional badges or tooltips.');
        const enumerationsBeforeMethod = enumerations;
        windowMethod.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        check(gameMethod.getAttribute('aria-pressed') === 'true' && windowMethod.getAttribute('aria-pressed') === 'false' &&
          document.activeElement === gameMethod && picker.selectedSourceId === windowId &&
          [...pickerRoot.querySelectorAll('.source-item')].every((card, index) => card === windowCards[index]) &&
          enumerations === enumerationsBeforeMethod && nativeCommands === 0,
        'Keyboard method changes must keep the same opaque window and DOM list, without enumeration or native work.');
        check(!pickerRoot.querySelector('#share-game-tip').hidden &&
          pickerRoot.querySelector('#share-game-tip').textContent.includes(language.t('screenShare.gameCompatibility')) &&
          pickerRoot.querySelector('#share-game-tip').textContent.includes(language.t('screenShare.gameWindowAlternative')),
        'Game Capture must explain protections, compatibility and the same-window Normal attempt.');
        check(pickerRoot.querySelector('#btn-share').getAttribute('aria-describedby') === 'share-game-tip' &&
          pickerRoot.querySelector('#share-game-tip').textContent.includes('CS2') &&
          pickerRoot.querySelector('#share-game-tip').textContent.includes(locale === 'pt-BR' ? 'sem bordas' : 'borderless'),
        'Game confirmation must expose the compatibility/CS2 warning and Normal guidance to assistive technology.');
        check(pickerRoot.querySelector('#share-game-tip').textContent.includes(locale === 'pt-BR' ? 'mesma janela' : 'same window') &&
          !/\bWGC\b|\bhook\b/i.test(pickerRoot.querySelector('#share-game-tip').textContent),
        'Fallback help must stay limited to the same window and use friendly mode names.');
        const guideTrigger = pickerRoot.querySelector('#btn-game-capture-guide');
        const pickerBackdrop = pickerRoot.closest('.modal-backdrop');
        const beforeGuide = JSON.stringify({
          id: picker.selectedSourceId, method: picker.windowCaptureMethod,
          audio: pickerRoot.querySelector('#chk-share-audio').checked, aspect: aspect.checked,
          preset: settingsStore.qualityPreset, profile: settingsStore.customProfile,
        });
        guideTrigger.focus();
        guideTrigger.click();
        const guide = document.querySelector('#game-capture-guide');
        const guideBackdrop = guide.closest('.modal-backdrop');
        const guideSearch = guide.querySelector('#game-capture-guide-search');
        const guideClose = guide.querySelector('#game-capture-guide-close');
        const guideFirst = guide.querySelector('[data-game-guide-close]');
        check(guideTrigger.textContent.includes(language.t('screenShare.gameGuideButton')) &&
          guideTrigger.getAttribute('aria-haspopup') === 'dialog' && guideTrigger.getAttribute('aria-expanded') === 'true',
        'The localized guide must open as an explicit informational dialog.');
        check(pickerBackdrop.inert && document.activeElement === guideSearch &&
          guide.getAttribute('role') === 'dialog' && guide.getAttribute('aria-modal') === 'true' &&
          guide.getAttribute('aria-labelledby') === 'game-capture-guide-title',
        'The second modal must focus its search field and make the parent picker inert.');
        check(guide.querySelector('#game-capture-guide-intro').textContent === language.t('screenShare.gameGuideIntro') &&
          guide.querySelectorAll('[data-game-guide-entry]').length === 14 &&
          guide.querySelectorAll('[data-game-guide-group="normal"] [data-game-guide-entry]').length === 5,
        'The local catalogue must present the 14 sourced limitations, not a compatibility whitelist.');
        check(guide.querySelectorAll('[data-game-guide-entry] button, [data-game-guide-entry] input').length === 0,
          'Game entries are advice, not controls that can select a window or start capture.');
        const guideBounds = guide.getBoundingClientRect();
        const guideBody = guide.querySelector('.game-capture-guide-body');
        check(guideBounds.left >= 23 && guideBounds.top >= 23 && guideBounds.right <= innerWidth - 23 &&
          guideBounds.bottom <= innerHeight - 23 && guide.scrollWidth <= guide.clientWidth + 1,
        `The bilingual guide must fit the viewport: ${JSON.stringify(guideBounds.toJSON())}`);
        check(guideBody.clientHeight >= 48 && guideBody.scrollHeight > guideBody.clientHeight &&
          [guideSearch, guideClose, guide.querySelector('#game-capture-guide-source')].every(element => {
            const rect = element.getBoundingClientRect();
            return rect.left >= guideBounds.left && rect.right <= guideBounds.right &&
              rect.top >= guideBounds.top && rect.bottom <= guideBounds.bottom;
          }),
        'Search, close and source remain reachable while only the long reference body scrolls.');
        for (const [query, id] of [['CS 2', 'cs2'], ['GTA SA', 'gta-san-andreas'], ['sa-mp', 'samp'],
          ['LoL', 'league-of-legends'], ['Minecraft Java', 'minecraft-java'], ['osu!', 'osu'], ['Valorant', 'valorant']]) {
          guideSearch.value = query;
          guideSearch.dispatchEvent(new Event('input', { bubbles: true }));
          const entries = [...guide.querySelectorAll('[data-game-guide-entry]')];
          check(entries.length === 1 && entries[0].dataset.gameGuideEntry === id &&
            guide.querySelector('#game-capture-guide-count').textContent === language.t('screenShare.gameGuideResultsCount', { count: 1 }),
          `${query}: local aliases must find the correct sourced entry immediately.`);
        }
        guideSearch.value = 'TLOU2 <img src=x onerror=bad()>';
        guideSearch.dispatchEvent(new Event('input', { bubbles: true }));
        check(!guide.querySelector('[data-game-guide-entry], img') &&
          guide.querySelector('.game-capture-guide-empty').textContent === language.t('screenShare.gameGuideNoResults'),
        'An uncatalogued game must explain missing information, not incompatibility or unsupported HTML.');
        guideSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await picker.startSharing('replace');
        check(nativeCommands === 0 && enumerations === enumerationsBeforeMethod && sourceOpens.length === 0,
          'Opening, searching and pressing Enter in the guide must not probe, capture, enumerate or access the network.');
        guideClose.focus();
        const forwardTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        guideClose.dispatchEvent(forwardTab);
        check(forwardTab.defaultPrevented && document.activeElement === guideFirst, 'Tab must wrap inside the guide.');
        const backwardTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
        guideFirst.dispatchEvent(backwardTab);
        check(backwardTab.defaultPrevented && document.activeElement === guideClose, 'Shift+Tab must wrap inside the guide.');
        const sourceLink = guide.querySelector('#game-capture-guide-source');
        const guideSource = 'https://obsproject.com/kb/game-capture-troubleshooting';
        check(sourceLink.href === guideSource && sourceLink.textContent.includes('obsproject.com'),
          'The official OBS source must stay visible and identifiable.');
        sourceLink.click();
        await settled(() => !sourceLink.hasAttribute('aria-busy'), `${locale}/guide source`);
        check(sourceOpens.length === 1 && sourceOpens[0] === guideSource,
          'Only an explicit source-link activation may invoke the existing external-navigation bridge.');
        sourceOpenSuccess = false;
        sourceLink.click();
        await settled(() => !sourceLink.hasAttribute('aria-busy'), `${locale}/guide source error`);
        check(!guide.querySelector('#game-capture-guide-link-error').hidden &&
          guide.querySelector('#game-capture-guide-link-error').textContent === language.t('screenShare.gameGuideSourceError'),
        'A failed safe-link opening must remain an explicit localized error.');
        sourceOpenSuccess = true;
        sourceLink.click();
        await settled(() => !sourceLink.hasAttribute('aria-busy'), `${locale}/guide source retry`);
        check(guide.querySelector('#game-capture-guide-link-error').hidden, 'Source-link retry clears the obsolete error.');
        guideSearch.focus();
        const guideEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        guideSearch.dispatchEvent(guideEscape);
        check(guideEscape.defaultPrevented && !guide.isConnected && pickerBackdrop.isConnected &&
          !pickerBackdrop.inert && document.activeElement === guideTrigger && guideTrigger.getAttribute('aria-expanded') === 'false',
        'Escape closes only the guide and restores the picker opener and interactivity.');
        check(JSON.stringify({
          id: picker.selectedSourceId, method: picker.windowCaptureMethod,
          audio: pickerRoot.querySelector('#chk-share-audio').checked, aspect: aspect.checked,
          preset: settingsStore.qualityPreset, profile: settingsStore.customProfile,
        }) === beforeGuide && [...pickerRoot.querySelectorAll('.source-item')].every((card, index) => card === windowCards[index]),
        'The guide must preserve the same source, method, audio, aspect ratio, quality and source-card identities.');
        guideTrigger.click();
        const freshGuide = document.querySelector('#game-capture-guide');
        guideSearch.value = 'CS2';
        guideSearch.dispatchEvent(new Event('input', { bubbles: true }));
        guideClose.click();
        const externalCallsAfterClose = sourceOpens.length;
        sourceLink.click();
        check(freshGuide.isConnected && freshGuide.querySelectorAll('[data-game-guide-entry]').length === 14 &&
          sourceOpens.length === externalCallsAfterClose && guideBackdrop.querySelector('#game-capture-guide-results'),
        'Retired guide controls must not search, close or navigate from a replacement modal.');
        freshGuide.closest('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        check(!freshGuide.isConnected && document.activeElement === guideTrigger && !pickerBackdrop.inert,
          'Backdrop dismissal also restores the picker without changing its selection.');
        windowCards[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await wait();
        check(nativeCommands === 0 && picker.modalEl && picker.windowCaptureMethod === 'game',
          'A source-list double-click must not confirm a game hook.');
        const audio = pickerRoot.querySelector('#chk-share-audio');
        audio.checked = false;
        audio.dispatchEvent(new Event('change', { bubbles: true }));
        gameMethod.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
        check(picker.windowCaptureMethod === 'window' && picker.selectedSourceId === windowId &&
          !audio.checked && pickerRoot.querySelector('#share-audio-text').textContent === language.t('screenShare.shareAppAudio') &&
          !pickerRoot.querySelector('#btn-share').hasAttribute('aria-describedby'),
        'Returning to Normal must keep the chosen window and its app-audio preference.');
        gameMethod.click();
        const savedQuality = JSON.stringify({ preset: settingsStore.qualityPreset, profile: settingsStore.customProfile,
          codec: settingsStore.preferredVideoCodec });
        let resolveRefresh;
        const pendingRefresh = new Promise(resolve => { resolveRefresh = resolve; });
        enumerateSources = () => pendingRefresh;
        const beforeRefresh = enumerations;
        refresh.focus();
        check(document.activeElement === refresh && refresh.tabIndex === 0,
          'Refresh must be reachable by keyboard without moving to another source.');
        refresh.click();
        refresh.click();
        await settled(() => enumerations === beforeRefresh + 1, `${locale}/refresh request`);
        check(refresh.disabled && refresh.dataset.loading === '1' && refresh.getAttribute('aria-busy') === 'true' &&
          pickerRoot.querySelector('#share-sources-panel').getAttribute('aria-busy') === 'true' &&
          pickerRoot.querySelector('#btn-share').disabled && !pickerRoot.querySelector('#btn-cancel').disabled,
        'Pending refresh must block duplicate requests/confirmation while preserving cancellation.');
        const newWindow = candidate(`window:789:${'e'.repeat(64)}`, 'window', 'Opened after the picker');
        sources = [...sources, newWindow];
        resolveRefresh(sources);
        await settled(() => !refresh.disabled, `${locale}/refresh result`);
        check(document.activeElement === refresh,
          'Keyboard focus must return to Refresh after its temporary disabled state, without reopening the modal.');
        check(pickerRoot.querySelector(`[data-source-id="${newWindow.id}"]`) &&
          picker.activeTab === 'window' && picker.selectedSourceId === windowId &&
          picker.windowCaptureMethod === 'game' && gameMethod.getAttribute('aria-pressed') === 'true' &&
          pickerRoot.querySelector(`[data-source-id="${windowId}"]`).getAttribute('aria-pressed') === 'true' &&
          aspect.checked && !audio.checked && nativeCommands === 0,
        'Refresh must add newly opened windows while retaining the exact source, method, audio and aspect-ratio choice.');
        check(JSON.stringify({ preset: settingsStore.qualityPreset, profile: settingsStore.customProfile,
          codec: settingsStore.preferredVideoCodec }) === savedQuality,
        'Refreshing a source list must never change media quality or codec preferences.');
        enumerateSources = async () => { throw new Error('Expected software-only refresh failure'); };
        refresh.click();
        aspect.focus();
        await settled(() => !!pickerRoot.querySelector('#share-sources-panel [role="alert"]'), `${locale}/refresh error`);
        check(!refresh.disabled && pickerRoot.querySelector('#btn-share').disabled &&
          picker.selectedSourceId === windowId && picker.windowCaptureMethod === 'game' && aspect.checked && !audio.checked,
        'An enumeration error must be visible and retryable, never confirm an unverified stale list or discard pending choices.');
        check(document.activeElement === aspect,
          'Refresh completion must not steal focus after the user moves to another available control.');
        enumerateSources = async () => sources;
        pickerRoot.querySelector('[data-loading-retry]').click();
        await settled(() => !refresh.disabled, `${locale}/refresh retry`);
        check(picker.selectedSourceId === windowId && picker.windowCaptureMethod === 'game' &&
          !pickerRoot.querySelector('#btn-share').disabled && aspect.checked && !audio.checked,
        'Retry must recover the same valid selection without reopening the picker.');
        check(!pickerRoot.querySelector('input[type="radio"]') &&
          [...pickerRoot.querySelectorAll('input[type="checkbox"]')].every(input => input.closest('.toggle-switch')),
        'Capture methods must use cards, never standalone native radio/checkbox controls.');
        pickerRoot.querySelector('#share-tab-screen').click();
        const monitorCards = [...pickerRoot.querySelectorAll('.source-item')];
        check(monitorCards.length === 4 && monitorCards.every((card, index) => {
          const label = language.t('screenShare.screenNumber', { number: monitors[index].displayNumber });
          return card.dataset.sourceId === monitors[index].id && card.getAttribute('aria-label') === label &&
            card.querySelector('.source-name').title === label && card.querySelector('.source-name').textContent.includes(label);
        }) &&
          new Set(monitorCards.map(card => card.querySelector('.source-name').title)).size === 4,
        'Monitor labels must localize the supplied displayNumber, not infer it from a name, ID or array ordinal.');
        check(monitorCards[0].querySelector('img.source-thumbnail').alt ===
          language.t('screenShare.screenNumber', { number: monitors[0].displayNumber }) &&
          monitorCards.slice(1).every(card => card.querySelector('.source-thumbnail-label').textContent ===
            language.t('screenShare.previewUnavailable')) &&
          monitors.every(source => source.name === 'Generic PnP Monitor'),
        'Thumbnail accessibility uses the localized monitor label without modifying raw Main metadata or inventing previews.');
        check(audio.checked && pickerRoot.querySelector('#share-window-methods').hidden &&
          pickerRoot.querySelector('#share-audio-text').textContent === language.t('screenShare.shareAudio') && aspect.checked,
        'Screens keep their separate system-audio choice and do not display window capture methods.');
        choose();
        check(picker.selectedSourceId === monitors[0].id && monitorCards[0].getAttribute('aria-pressed') === 'true' && nativeCommands === 0,
          'Monitor selection must preserve the original ID without probing.');
        pickerRoot.querySelector('#share-tab-screen')
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        check(pickerRoot.querySelector('#share-tab-window').getAttribute('aria-selected') === 'true' &&
          pickerRoot.querySelector('#share-sources-panel').getAttribute('aria-labelledby') === 'share-tab-window' &&
          picker.selectedSourceId === null && !audio.checked,
        'Keyboard source-type changes require a new source selection and restore that type of audio.');
        choose();
        windowMethod.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        gameMethod.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        await wait();
        const bounds = pickerRoot.getBoundingClientRect();
        check(bounds.left >= 23 && bounds.top >= 23 && bounds.right <= innerWidth - 23 && bounds.bottom <= innerHeight - 23,
          'The picker must retain a 24px viewport margin without provisional verification guidance.');
        check(pickerRoot.scrollWidth <= pickerRoot.clientWidth + 1 &&
          [windowMethod, gameMethod, refresh, pickerRoot.querySelector('.share-aspect-option')]
            .every(element => element.scrollWidth <= element.clientWidth + 1),
        'Method cards and localized guidance must fit the small viewport without horizontal clipping.');
        const confirmation = pickerRoot.querySelector('#btn-share');
        confirmation.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        await wait();
        const confirmBounds = confirmation.getBoundingClientRect();
        check(confirmBounds.top >= bounds.top && confirmBounds.bottom <= bounds.bottom,
          'The explicit confirmation must remain reachable within the scrollable picker.');
        capabilities.captureKinds = ['window'];
        picker.updateCaptureInfo();
        check(pickerRoot.querySelector('#share-tab-screen').disabled && gameMethod.disabled &&
          !windowMethod.disabled && !pickerRoot.querySelector('#share-tab-window').disabled && gameMethod.title,
        'A pending probe must not enable methods the backend did not advertise.');
        check(picker.activeTab === 'window' && picker.windowCaptureMethod === 'game' &&
          picker.selectedSourceId === windowId && confirmation.disabled && gameMethod.getAttribute('aria-pressed') === 'true',
        'Losing Game Capture support must not silently select WGC or a different window.');
        check(!info.hidden && info.textContent === language.t('screenShare.captureMethodUnavailable', {
          method: language.t('screenShare.gameCapture'),
        }) && !gameMethod.querySelector('.share-method-status').hidden,
        'Actual capability failures must remain visible after the provisional notices are removed.');
        capabilities.captureKinds = ['window', 'monitor', 'game'];
        picker.updateCaptureInfo();
        check(info.hidden && !info.textContent && !confirmation.disabled &&
          gameMethod.querySelector('.share-method-status').hidden && capabilities.capture === false,
        'Returning to an eligible selection hides obsolete notices without marking its capture as verified.');
        sources = sources.filter(source => source.id !== windowId);
        refresh.click();
        await settled(() => !refresh.disabled, `${locale}/removed source`);
        check(picker.selectedSourceId === null && pickerRoot.querySelector('#share-window-methods').hidden &&
          !pickerRoot.querySelector(`[data-source-id="${windowId}"]`) && confirmation.disabled && !audio.checked && aspect.checked,
        'Refreshing away a closed window must clear selection/method controls without changing its audio preference.');
        picker.close();
        await picker.open();
        document.querySelector('.source-item').click();
        const reopenedEnumerations = enumerations;
        gameMethod.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        check(picker.windowCaptureMethod === 'window' && document.querySelector('#share-method-window').getAttribute('aria-pressed') === 'true',
          'Detached method-card listeners must not mutate the next picker opening.');
        check(!document.querySelector('#chk-preserve-aspect-ratio').checked && enumerations === reopenedEnumerations,
          'A new sharing picker resets aspect ratio and detached refresh handlers cannot enumerate or mutate it.');
        check(nativeCommands === 0 && capabilities.capture === false && capabilities.backend === null,
          'The picker must never manufacture hardware qualification while browsing sources.');
      } finally {
        picker.close();
        window.api = previousApi;
        webRtcManager.getNativeScreenCapabilities = previousCapabilities;
      }
    }
    check(mediaRequests === 0, 'This smoke must never request microphone, camera or display capture.');
  } finally {
    modal?.close();
    disposeTooltips();
    window.api = originalApi;
    Object.assign(settingsStore, original);
    settingsStore.save();
    language.setLanguage(originalLanguage);
    media.getUserMedia = originalUserMedia;
    media.getDisplayMedia = originalDisplayMedia;
  }
  return checks;
}
