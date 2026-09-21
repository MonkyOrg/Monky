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
  const original = {
    qualityPreset: settingsStore.qualityPreset,
    customProfile: { ...settingsStore.customProfile },
    screenShareTelemetryEnabled: settingsStore.screenShareTelemetryEnabled,
    screenShareTelemetryPosition: settingsStore.screenShareTelemetryPosition,
    screenShareTelemetryMode: settingsStore.screenShareTelemetryMode,
    preferredVideoCodec: settingsStore.preferredVideoCodec,
    screenSharePreviewPauseWhenUnfocused: settingsStore.screenSharePreviewPauseWhenUnfocused,
  };
  let modal;
  const disposeTooltips = initTooltips();
  try {
    for (const locale of ['pt-BR', 'en']) {
      language.setLanguage(locale);
      settingsStore.qualityPreset = 'CUSTOM';
      settingsStore.screenShareTelemetryEnabled = false;
      settingsStore.screenShareTelemetryPosition = 'top-right';
      settingsStore.screenShareTelemetryMode = 'simple';
      settingsStore.screenSharePreviewPauseWhenUnfocused = true;
      settingsStore.preferredVideoCodec = 'auto';
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
        await wait();
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
        button.focus();
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
      const monitorId = `native-monitor:${'b'.repeat(64)}`;
      const candidate = (id, type) => ({ id, type, name: 'Synthetic <application> & title', thumbnailDataUrl: '', appIconDataUrl: null });
      let nativeCommands = 0;
      const capabilities = { capture: false, captureAudio: true, receive: true, backend: null, reason: null,
        requiresSelectionProbe: true, captureKinds: ['window', 'monitor', 'game'] };
      window.api = {
        platform: 'win32',
        nativeScreenCommand: async () => { nativeCommands++; throw new Error('Picker UI must not probe or capture native media.'); },
        getDesktopSources: async () => [candidate(windowId, 'window'), candidate(monitorId, 'screen'), candidate('screen:0:0', 'screen')],
      };
      webRtcManager.getNativeScreenCapabilities = async () => capabilities;
      try {
        await picker.open();
        const pickerRoot = document.querySelector('.screen-share-picker-card');
        const info = pickerRoot.querySelector('#share-capture-info');
        const tabs = [...pickerRoot.querySelectorAll('[role="tab"]')];
        check(tabs.length === 3 && tabs.every(tab => !tab.disabled &&
          tab.querySelector('.share-tab-status').textContent === language.t('screenShare.probePending')),
        'Explicit selection support must show three selectable methods with a pending-probe label.');
        check(info.dataset.backend === 'probe-pending' && nativeCommands === 0,
          'Opening the picker must not probe hardware or present an unverified encoder as available.');
        const choose = () => pickerRoot.querySelector('.source-item')
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        choose();
        check(picker.selectedSourceId === windowId && !pickerRoot.querySelector('#btn-share').disabled &&
          info.dataset.backend === 'probe-pending' && nativeCommands === 0,
        'Selecting the opaque window ID permits confirmation but does not itself verify or capture.');
        check(!pickerRoot.querySelector('application') &&
          pickerRoot.querySelector('.source-name').textContent.includes('Synthetic <application> & title'),
        'Source names must be painted as escaped text.');
        pickerRoot.querySelector('#share-tab-screen').click();
        const monitorCards = [...pickerRoot.querySelectorAll('.source-item')];
        check(monitorCards.length === 1 && monitorCards[0].dataset.sourceId === monitorId,
          'Native monitors must use their opaque identity, never an Electron ordinal.');
        choose();
        check(picker.selectedSourceId === monitorId && nativeCommands === 0,
          'Monitor selection must preserve the original ID without probing.');
        pickerRoot.querySelector('#share-tab-screen')
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        check(pickerRoot.querySelector('#share-tab-game').getAttribute('aria-selected') === 'true' &&
          pickerRoot.querySelector('#share-sources-panel').getAttribute('aria-labelledby') === 'share-tab-game' &&
          picker.selectedSourceId === null, 'Keyboard method changes must update the panel and require a new explicit selection.');
        check(pickerRoot.textContent.includes(language.t('screenShare.gameCompatibility')) &&
          pickerRoot.textContent.includes(language.t('screenShare.gameWindowAlternative')),
        'Game Capture must explain candidate compatibility and its manual same-window alternative.');
        const bounds = pickerRoot.getBoundingClientRect();
        check(bounds.left >= 23 && bounds.top >= 23 && bounds.right <= innerWidth - 23 && bounds.bottom <= innerHeight - 23,
          'The picker, including pending-probe guidance, must retain a 24px viewport margin.');
        picker.close();
        capabilities.captureKinds = ['window'];
        await picker.open();
        check(document.querySelector('#share-tab-screen').disabled && document.querySelector('#share-tab-game').disabled &&
          !document.querySelector('#share-tab-window').disabled && document.querySelector('#share-tab-game').title,
        'A pending probe must not enable methods the backend did not advertise.');
        check(picker.activeTab === 'game' && picker.selectedSourceId === null && document.querySelector('#btn-share').disabled,
          'Losing Game Capture selection support must not switch to another method or source.');
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
    Object.assign(settingsStore, original);
    settingsStore.save();
    language.setLanguage(originalLanguage);
    media.getUserMedia = originalUserMedia;
    media.getDisplayMedia = originalDisplayMedia;
  }
  return checks;
}
