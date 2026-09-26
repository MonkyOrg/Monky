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
    { webRtcManager }, { ScreenSharePickerModal }, { SelectEnhancer }] = await Promise.all([
    import('/views/SettingsModal.ts'), import('/stores/settingsStore.ts'), import('/core/EventBus.ts'),
    import('/core/TooltipService.ts'), import('/i18n/index.ts'), import('/core/VideoService.ts'),
    import('/core/WebRtcManager.ts'), import('/views/ScreenSharePickerModal.ts'), import('/core/SelectEnhancer.ts'),
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
    preferredScreenCodec: settingsStore.preferredScreenCodec,
    screenEncodingMode: settingsStore.screenEncodingMode,
    screenEncodingStrategy: settingsStore.screenEncodingStrategy,
    screenSharePreviewPauseWhenUnfocused: settingsStore.screenSharePreviewPauseWhenUnfocused,
    screenShareReceiver: settingsStore.screenShareReceiver,
  };
  let modal;
  check(settingsStore.screenEncodingMode === 'hardware', 'A fresh settings profile must default to Hardware encoding.');
  check(settingsStore.screenEncodingStrategy === 'automatic', 'A fresh settings profile must default to Automatic selection.');
  const encodingRequests = [];
  let hardwareAvailable = true;
  let limitFourKH264 = false;
  const encodingCommand = async command => {
    if (command.action === 'cancel-encoding-probe') return { kind: 'ok' };
    check(command.action === 'probe-encoding' && !('desktopSourceId' in command),
      'Encoding controls may only request source-free capability discovery, never source preparation or capture.');
    encodingRequests.push(command);
    const automatic = command.encodingStrategy === 'automatic';
    const mode = automatic ? hardwareAvailable ? 'hardware' : 'software' : command.encodingMode;
    const codec = automatic ? mode === 'hardware' ? 'av1' : 'h264' : command.codec;
    const hardwareSupported = hardwareAvailable && !(limitFourKH264 && codec === 'h264'
      && (command.video.width >= 3840 || command.video.height >= 2160) && command.video.fps > 60);
    const unavailable = !automatic && mode === 'hardware' && !hardwareSupported;
    return { kind: 'encoding', availability: {
      selection: unavailable ? null : { mode, codec, encoder: mode === 'hardware'
        ? codec === 'av1' ? 'av1_texture_amf' : 'h264_texture_amf'
        : codec === 'av1' ? 'monky_aom_av1' : 'obs_x264' },
      hardware: { available: hardwareSupported, reason: hardwareSupported ? null : 'Fixture encoder unsupported for this profile.' },
      fallback: automatic && mode === 'software',
      ...(unavailable ? { reason: 'Fixture encoder unsupported for this profile.' } : {}),
    } };
  };
  const disposeTooltips = initTooltips();
  const selects = new SelectEnhancer();
  selects.init();
  try {
    for (const [locale, platform] of [['pt-BR', 'win32'], ['en', 'win32'], ['pt-BR', 'darwin'], ['en', 'darwin']]) {
      hardwareAvailable = true;
      let completeInitialProbe;
      const initialProbe = new Promise(resolve => { completeInitialProbe = resolve; });
      window.api = { ...originalApi, platform, nativeScreenCommand: async command => {
        if (command.action === 'probe-encoding') await initialProbe;
        return encodingCommand(command);
      } };
      language.setLanguage(locale);
      settingsStore.qualityPreset = 'CUSTOM';
      settingsStore.screenShareTelemetryEnabled = false;
      settingsStore.screenShareTelemetryPosition = 'top-right';
      settingsStore.screenShareTelemetryMode = 'simple';
      settingsStore.screenSharePreviewPauseWhenUnfocused = true;
      settingsStore.preferredVideoCodec = 'vp9';
      settingsStore.preferredScreenCodec = 'h264';
      settingsStore.screenEncodingMode = 'hardware';
      settingsStore.screenEncodingStrategy = 'automatic';
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
      check(!av1.disabled && av1.textContent === language.t('settings.codecAv1')
        && !av1.textContent.includes(language.t('screenShare.comingSoon')),
      'AV1 must be enabled and localized as an implemented screen codec.');
      check([...quality.querySelectorAll('#select-video-codec option')].map(option => option.value).join(',') === 'h264,av1',
        'Manual codec selection must offer exact H.264 and AV1 only.');
      for (const codec of ['h264', 'av1'])
        check(!quality.querySelector(`#select-video-codec option[value="${codec}"]`).disabled,
          'Both libobs modes must expose the implemented screen codec choices.');
      const hardware = quality.querySelector('#screen-encoding-hardware');
      const software = quality.querySelector('#screen-encoding-software');
      const automatic = quality.querySelector('#screen-encoding-automatic');
      const manual = quality.querySelector('#screen-encoding-manual');
      const screenCodec = quality.querySelector('#select-video-codec');
      const encodingStatus = quality.querySelector('#screen-encoding-status');
      check(automatic.getAttribute('aria-pressed') === 'true' && manual.getAttribute('aria-pressed') === 'false'
        && quality.querySelectorAll('[data-settings-section="screen-encoding"]').length === 1
        && quality.querySelectorAll('#select-video-codec').length === 1
        && screenCodec.closest('[data-settings-section="screen-encoding"]') === automatic.closest('[data-settings-section="screen-encoding"]'),
      'Automatic/Manual, encoding and codec must be grouped exactly once.');
      const helperStyle = getComputedStyle(quality.querySelector('#screen-receiver-apply'));
      const standardHelperStyle = { fontSize: helperStyle.fontSize, color: helperStyle.color, marginTop: helperStyle.marginTop };
      for (const selector of ['#screen-codec-description', '#screen-encoding-status', '#screen-encoding-choices', '#screen-encoding-apply']) {
        const helper = quality.querySelector(selector);
        const style = getComputedStyle(helper);
        check(helper.classList.contains('audio-device-status')
          && style.fontSize === helperStyle.fontSize && style.color === helperStyle.color
          && style.marginTop === helperStyle.marginTop && style.overflowWrap === helperStyle.overflowWrap,
        'Encoding status and help must use the same muted helper typography and spacing as receiver settings.');
      }
      check(hardware instanceof HTMLButtonElement && software instanceof HTMLButtonElement
        && hardware.classList.contains('input-mode-card') && software.classList.contains('input-mode-card')
        && hardware.getAttribute('aria-pressed') === 'false' && software.getAttribute('aria-pressed') === 'false',
      'Automatic must not claim an encoding selection before discovery finishes.');
      check(hardware.textContent.includes(language.t('settings.screenEncodingHardware'))
        && hardware.textContent.includes(locale === 'pt-BR' ? 'Recomendado' : 'Recommended'),
      'Hardware must visibly retain its localized recommended label.');
      check(hardware.disabled && software.disabled && screenCodec.disabled && screenCodec.value === ''
        && encodingStatus.getAttribute('aria-busy') === 'true' && !manual.disabled,
        'Mode controls must expose source-free discovery loading rather than claim unverified availability.');
      completeInitialProbe();
      await settled(() => encodingStatus.getAttribute('aria-busy') === 'false', `${locale}/encoder discovery`);
      check(hardware.disabled && software.disabled && screenCodec.disabled && screenCodec.value === 'av1'
        && hardware.getAttribute('aria-pressed') === 'true' && settingsStore.preferredScreenCodec === 'h264',
      'Automatic fields must be read-only and show resolved Hardware/AV1 without overwriting manual choices.');
      check(encodingStatus.textContent === language.t('settings.screenEncodingReady', { codec: 'AV1' }),
        'Available encoding must show the concise localized status.');
      automatic.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      const choicesStatus = quality.querySelector('#screen-encoding-choices');
      const encodingSettled = () => encodingStatus.getAttribute('aria-busy') === 'false'
        && choicesStatus.getAttribute('aria-busy') === 'false';
      await settled(() => settingsStore.screenEncodingStrategy === 'manual' && encodingSettled(), `${locale}/manual selection`);
      check(settingsStore.screenEncodingStrategy === 'manual' && screenCodec.value === 'h264',
        'Manual restores the saved exact choices and unlocks the encoding and codec controls.');
      hardwareAvailable = false;
      screenCodec.value = 'av1';
      screenCodec.dispatchEvent(new Event('change', { bubbles: true }));
      await settled(encodingSettled, `${locale}/manual unavailable combination`);
      check(!hardware.disabled && hardware.getAttribute('aria-pressed') === 'true'
        && software.getAttribute('aria-pressed') === 'false' && screenCodec.value === 'h264'
        && settingsStore.preferredScreenCodec === 'h264' && screenCodec.querySelector('[value="av1"]').disabled
        && settingsStore.screenEncodingMode === 'hardware' && settingsStore.screenEncodingStrategy === 'manual'
        && encodingStatus.textContent === language.t('settings.screenEncodingProfileUnavailable', {
          codec: 'AV1', mode: language.t('settings.screenEncodingHardwareShort'),
        }),
      `An unavailable Manual change must roll back, disable the rejected codec and show a friendly localized explanation: ${JSON.stringify({
        disabled: hardware.disabled, hardware: hardware.getAttribute('aria-pressed'),
        software: software.getAttribute('aria-pressed'), codec: screenCodec.value,
        savedCodec: settingsStore.preferredScreenCodec, mode: settingsStore.screenEncodingMode,
        strategy: settingsStore.screenEncodingStrategy, status: encodingStatus.textContent,
      })}`);
      const savedEncoding = localStorage.getItem('monky_settings');
      const rejectedProbeCount = encodingRequests.length;
      screenCodec.scrollIntoView({ block: 'center' });
      screenCodec.focus();
      screenCodec.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settled(() => !!document.querySelector('.monky-select-popup'), `${locale}/codec dropdown`);
      const disabledAv1 = [...document.querySelectorAll('.monky-select-popup [role="option"]')]
        .find(row => row.textContent.startsWith(language.t('settings.codecAv1')));
      check(disabledAv1?.getAttribute('aria-disabled') === 'true'
        && disabledAv1.textContent.includes(language.t('screenShare.unavailable'))
        && choicesStatus.textContent.includes(language.t('settings.screenEncodingProfileUnavailable', {
          codec: 'AV1', mode: language.t('settings.screenEncodingHardwareShort'),
        })),
      'The custom dropdown must retain unavailable AV1 with disabled semantics and a visible localized Hardware reason.');
      disabledAv1.click();
      check(screenCodec.value === 'h264' && localStorage.getItem('monky_settings') === savedEncoding
        && encodingRequests.length === rejectedProbeCount, 'Pointer activation cannot save or probe a disabled codec.');
      screenCodec.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      const activeCodec = document.getElementById(screenCodec.getAttribute('aria-activedescendant'));
      check(activeCodec?.textContent.startsWith(language.t('settings.codecH264')),
        'Keyboard navigation must skip unavailable AV1 rather than focus a forbidden Manual choice.');
      screenCodec.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settled(encodingSettled, `${locale}/codec keyboard confirmation`);
      check(screenCodec.value === 'h264' && localStorage.getItem('monky_settings') === savedEncoding,
        'Keyboard confirmation must preserve the verified codec without saving a rejected draft.');
      hardwareAvailable = true;
      screenCodec.value = 'h264';
      screenCodec.dispatchEvent(new Event('change', { bubbles: true }));
      await settled(encodingSettled, `${locale}/manual supported combination`);
      hardware.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await settled(() => settingsStore.screenEncodingMode === 'software' && encodingSettled(), `${locale}/software encoding`);
      settingsStore.load(false);
      check(settingsStore.screenEncodingMode === 'software' && settingsStore.screenEncodingStrategy === 'manual'
        && hardware.getAttribute('aria-pressed') === 'false'
        && JSON.parse(localStorage.getItem('monky_settings')).screenEncodingMode === 'software',
      'Explicit Software selection must persist despite available hardware.');
      hardwareAvailable = false;
      screenCodec.value = 'av1';
      screenCodec.dispatchEvent(new Event('change', { bubbles: true }));
      await settled(encodingSettled, `${locale}/unsupported hardware`);
      check(!hardware.disabled && hardware.isConnected && getComputedStyle(hardware).display !== 'none'
        && encodingStatus.textContent === language.t('settings.screenEncodingHardwareUnavailable')
        && software.getAttribute('aria-pressed') === 'true' && !av1.disabled
        && settingsStore.preferredScreenCodec === 'av1'
        && JSON.parse(localStorage.getItem('monky_settings')).preferredScreenCodec === 'av1',
      'A verified Hardware H264 alternative remains available while Software AV1 stays selected with a friendly explanation.');
      automatic.click();
      await settled(() => encodingStatus.getAttribute('aria-busy') === 'false', `${locale}/automatic fallback`);
      settingsStore.load(false);
      check(settingsStore.screenEncodingStrategy === 'automatic' && settingsStore.screenEncodingMode === 'software'
        && settingsStore.preferredScreenCodec === 'av1' && screenCodec.value === 'h264'
        && hardware.disabled && software.disabled && screenCodec.disabled,
      'Automatic fallback must show Software/H.264 without persisting its resolved choices or switching to Manual.');
      manual.click();
      await settled(encodingSettled, `${locale}/manual restore`);
      check(screenCodec.value === 'av1' && !screenCodec.disabled && software.getAttribute('aria-pressed') === 'true',
        'Returning to Manual must restore the exact previous Software/AV1 choice.');
      screenCodec.value = 'h264';
      screenCodec.dispatchEvent(new Event('change', { bubbles: true }));
      await settled(encodingSettled, `${locale}/manual H264`);
      hardwareAvailable = true;
      const changeQuality = async (id, value) => {
        const field = quality.querySelector(`#${id}`);
        field.value = value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        await wait();
        await settled(encodingSettled, `${locale}/${id} compatibility`);
      };
      const nonScreenQuality = () => Object.fromEntries(Object.entries(settingsStore.customProfile)
        .filter(([key]) => !key.startsWith('screen')));
      const unchangedQuality = JSON.stringify(nonScreenQuality());
      await changeQuality('select-video-codec', 'av1');
      await changeQuality('q-res-screen', '3840x2160');
      await changeQuality('q-select-screenFps', '120');
      hardware.click();
      await settled(encodingSettled, `${locale}/hardware AV1 4K120`);
      check(settingsStore.customProfile.screenFps === 120 && screenCodec.value === 'av1'
        && hardware.getAttribute('aria-pressed') === 'true',
      'A supported Hardware AV1 4K120 profile must retain its requested FPS.');
      limitFourKH264 = true;
      const previousBitrate = settingsStore.customProfile.screenBitrateKbps;
      const checkAdjustedProfile = description => {
        check(settingsStore.customProfile.screenWidth === 3840 && settingsStore.customProfile.screenHeight === 2160
          && settingsStore.customProfile.screenFps === 60 && settingsStore.customProfile.screenBitrateKbps === previousBitrate
          && quality.querySelector('#q-select-screenFps').value === '60'
          && settingsStore.preferredScreenCodec === 'h264' && settingsStore.screenEncodingMode === 'hardware'
          && settingsStore.screenEncodingStrategy === 'manual',
        `${description} must show the confirmed 60 FPS without changing the selected codec, mode, resolution or bitrate.`);
        check(document.querySelector('.chat-copy-toast-label')?.textContent === language.t('settings.screenEncodingFpsAdjusted', {
          codec: 'H264', mode: language.t('settings.screenEncodingHardwareShort'), previous: 120, fps: 60,
        }), `${description} must explain the automatic change using the selected language: ${document.querySelector('.chat-copy-toast-label')?.textContent}`);
        check(JSON.stringify(nonScreenQuality()) === unchangedQuality,
          `${description} must preserve camera and audio settings.`);
      };
      const firstAdjustmentProbe = encodingRequests.length;
      await changeQuality('select-video-codec', 'h264');
      checkAdjustedProfile('Changing the codec at 4K120');
      const probedFrameRates = encodingRequests.slice(firstAdjustmentProbe)
        .filter(command => command.codec === 'h264').map(command => command.video.fps);
      check([120, 90, 60].every(fps => probedFrameRates.includes(fps)),
        'A lower FPS must be confirmed through real capability requests, not guessed from codec or GPU labels.');
      await changeQuality('q-select-screenFps', '120');
      checkAdjustedProfile('Changing FPS back to an unsupported 120');
      await changeQuality('q-res-screen', '1920x1080');
      await changeQuality('q-select-screenFps', '120');
      check(settingsStore.customProfile.screenFps === 120,
        'Supported 1080p120 must not be reduced by the 4K-only fixture restriction.');
      await changeQuality('q-res-screen', '3840x2160');
      checkAdjustedProfile('Changing resolution from 1080p120 to 4K');
      limitFourKH264 = false;
      software.click();
      await settled(() => encodingStatus.getAttribute('aria-busy') === 'false', `${locale}/restore Software preference`);
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
      const cameraBitrates = [...quality.querySelector('#q-select-cameraBitrate').options].map(option => option.value);
      const screenBitrates = [...quality.querySelector('#q-select-screenBitrate').options].map(option => option.value);
      check(JSON.stringify(cameraBitrates) === JSON.stringify(screenBitrates) && cameraBitrates.includes('80000'),
        'Camera and screen must offer the same video bitrate choices through 80000 kbps plus custom.');
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
        const activeSource = videoService.getNativeScreenCapture(metadataOnly.id).source;
        codec.value = 'av1';
        codec.dispatchEvent(new Event('change', { bubbles: true }));
        await settled(() => encodingStatus.getAttribute('aria-busy') === 'false', `${locale}/software AV1 preference`);
        settingsStore.load(false);
        check(settingsStore.preferredScreenCodec === 'av1' && codec.value === 'av1'
          && settingsStore.preferredVideoCodec === previousCodec && settingsStore.screenEncodingMode === 'software',
        'Software AV1 must persist independently of the existing camera codec preference.');
        check(videoService.getNativeScreenCapture(metadataOnly.id).source === activeSource
          && !document.querySelector('.dialog-card'),
        'A supported next-share codec preference must not replace active source metadata or report coming soon.');
        const frameRate = quality.querySelector('#custom-screenFps');
        frameRate.value = '241';
        frameRate.dispatchEvent(new Event('change', { bubbles: true }));
        await settled(() => settingsStore.customProfile.screenFps === Number(frameRate.max), `${locale}/normalized FPS commit`);
        check(settingsStore.customProfile.screenFps === Number(frameRate.max) && Number(frameRate.value) === Number(frameRate.max),
          'Typed FPS above the ceiling must clamp both the saved profile and visible value.');
        check(!quality.querySelector('#quality-custom-status')
          && document.querySelector('.chat-copy-toast[role="status"] .chat-copy-toast-label')?.textContent === language.t('settings.qualityValueAdjusted'),
          'The adjusted limit must use the localized accessible toast, not a persistent paragraph.');
        const helpStyle = getComputedStyle(quality.querySelector('.quality-custom-help'));
        check(helpStyle.fontSize === '11px' && helpStyle.fontWeight === '400',
          'Permanent limit guidance must remain small and regular-weight rather than dominate the form.');
        const change = async (id, value) => {
          const field = quality.querySelector(`#${id}`);
          field.value = value;
          field.dispatchEvent(new Event('change', { bubbles: true }));
          await wait();
          await settled(() => encodingStatus.getAttribute('aria-busy') === 'false', `${locale}/${id} commit`);
          return quality.querySelector(`#${id}`);
        };
        for (const kind of ['camera', 'screen']) {
          const fourKLimit = kind === 'camera' ? 60 : 120;
          const fullHdLimit = kind === 'camera' ? 120 : 240;
          for (const aspect of ['16:9', '16:10', '4:3', '21:9']) {
            await change(`q-aspect-${kind}`, aspect);
            for (const option of quality.querySelector(`#q-res-${kind}`).options) {
              if (option.value === '__custom__') continue;
              const [width, height] = option.value.split('x').map(Number);
              check(width <= 3840 && height <= 2160, 'Resolution dropdowns must obey the same custom ceilings.');
            }
          }
          await change(`q-aspect-${kind}`, '16:9');
          await change(`q-res-${kind}`, '1920x1080');
          await change(`q-select-${kind}Fps`, String(fullHdLimit));
          await change(`q-res-${kind}`, '3840x2160');
          check(settingsStore.customProfile[`${kind}Fps`] === fourKLimit &&
            quality.querySelector(`#q-select-${kind}Fps`).value === String(fourKLimit), 'Selecting 4K must apply its media-specific FPS ceiling.');
          check([...quality.querySelector(`#q-select-${kind}Fps`).options]
            .every(option => option.value === '__custom__' || Number(option.value) <= fourKLimit), '4K dropdown cannot exceed its FPS ceiling.');
          await change(`q-res-${kind}`, '__custom__');
          const width = await change(`custom-${kind}Width`, '9999');
          const height = await change(`custom-${kind}Height`, '9999');
          await change(`q-select-${kind}Fps`, '__custom__');
          const fps = await change(`custom-${kind}Fps`, '9999');
          await change(`q-select-${kind}Bitrate`, '__custom__');
          const bitrate = await change(`custom-${kind}Bitrate`, '1e6');
          check(width.value === '3840' && height.value === '2160' && fps.value === String(fourKLimit) && bitrate.value === '80000',
            'Typing or pasting custom/exponential values cannot bypass resolution, FPS or bitrate limits.');
          for (const input of [width, height, fps, bitrate]) {
            check(input.validity.valid && getComputedStyle(input).appearance === 'textfield',
              'Custom fields keep native numeric validity and keyboard access without visible number spinners.');
          }
          await change(`custom-${kind}Fps`, '');
          check(fps.value === String(fourKLimit) && document.querySelector('.chat-copy-toast-label')?.textContent === language.t('settings.qualityValueInvalid')
            && document.querySelectorAll('.chat-copy-toast').length === 1,
            'An empty custom value must restore the previous value and replace, not stack, feedback toasts.');
          await change(`custom-${kind}Width`, '1920');
          await change(`custom-${kind}Height`, '1080');
          await change(`custom-${kind}Fps`, String(fullHdLimit + 1));
          check(fps.max === String(fullHdLimit) && fps.value === String(fullHdLimit), 'Leaving 4K must restore the media-specific FPS ceiling without exceeding it.');
        }
        settingsStore.load(false);
        check(settingsStore.customProfile.screenBitrateKbps === 80000 && settingsStore.customProfile.cameraBitrateKbps === 80000
          && settingsStore.customProfile.screenFps === 240, 'Normalized custom values must persist across reloads.');
      } finally { videoService.stopScreenShare(metadataOnly.id); }
      modal.close();
      check(!document.querySelector('.chat-copy-toast'), 'Closing quality settings must retire its toast and timer.');
      const storedAfterClose = localStorage.getItem('monky_settings');
      chromiumReceiver.click();
      hardware.click();
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
      check(reopened.querySelector('#screen-encoding-software').getAttribute('aria-pressed') === 'true'
        && reopened.querySelector('#screen-encoding-hardware').getAttribute('aria-pressed') === 'false'
        && reopened.querySelector('#select-video-codec').value === 'av1',
      'Reopening settings must retain explicit Software and AV1 rather than reselect recommended Hardware.');
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
        nativeScreenCommand: async command => {
          if (command.action === 'probe-encoding' || command.action === 'cancel-encoding-probe') return encodingCommand(command);
          nativeCommands++;
          throw new Error('Picker UI must not prepare a source or capture native media.');
        },
        prepareScreenShareWindow: async () => { nativeCommands++; throw new Error('Choosing a method must not prepare its window.'); },
        getDesktopSources: async () => { enumerations++; return enumerateSources(); },
        openExternal: async url => { sourceOpens.push(url); return { success: sourceOpenSuccess }; },
      };
      webRtcManager.getNativeScreenCapabilities = async () => capabilities;
      try {
        const previousEncodingRequests = encodingRequests.length;
        await picker.open();
        const pickerRoot = document.querySelector('.screen-share-picker-card');
        check(encodingRequests.length === previousEncodingRequests && nativeCommands === 0
          && !pickerRoot.querySelector('[data-settings-section="screen-encoding"], #select-video-codec'),
        'The picker does not duplicate encoding settings or probe encoders before source admission.');
        const info = pickerRoot.querySelector('#share-capture-info');
        const tabs = [...pickerRoot.querySelectorAll('[role="tab"]')];
        check(tabs.length === 2 && !pickerRoot.querySelector('#share-tab-game') && tabs.every(tab => !tab.disabled &&
          tab.querySelector('.share-tab-status').hidden && tab.querySelector('.share-tab-status').textContent === '' &&
          !tab.title && !tab.hasAttribute('aria-describedby')),
        'Explicit selection support must show two source types, never a duplicate Games list.');
        check(info.dataset.backend === 'probe-pending' && nativeCommands === 0 &&
          info.hidden && !info.textContent && getComputedStyle(info).display === 'none' && info.getBoundingClientRect().height === 0,
        'Source verification stays pending without capturing, a provisional banner or an empty layout placeholder.');
        check(pickerRoot.querySelector('#share-window-methods').hidden,
          'Window capture methods must wait for an explicitly selected window.');
        const refresh = pickerRoot.querySelector('#btn-refresh-sources');
        const aspect = pickerRoot.querySelector('#chk-preserve-aspect-ratio');
        check(refresh instanceof HTMLButtonElement && refresh.type === 'button' && !refresh.disabled &&
          refresh.getAttribute('aria-controls') === 'share-sources-panel' &&
          refresh.getAttribute('aria-label') === language.t('screenShare.refreshSourcesLabel') &&
          refresh.textContent.includes(language.t('screenShare.refreshSources')),
        'Refresh must be an accessible native button with localized text and an explicit controlled panel.');
        check(aspect instanceof HTMLInputElement && aspect.checked && aspect.getAttribute('role') === 'switch' &&
          aspect.closest('.toggle-switch') && aspect.getAttribute('aria-labelledby') === 'share-aspect-label' &&
          aspect.getAttribute('aria-describedby') === 'share-aspect-description' &&
          pickerRoot.querySelector('#share-aspect-label').textContent === language.t('screenShare.preserveAspectRatio'),
        'Each new picker starts with a localized, described aspect-ratio switch on, not a standalone checkbox.');
        const aspectLabel = pickerRoot.querySelector('#share-aspect-label');
        const aspectHelp = pickerRoot.querySelector('#share-aspect-description');
        const aspectSwitch = aspect.closest('.toggle-switch');
        const audioSwitch = pickerRoot.querySelector('#chk-share-audio').closest('.toggle-switch');
        const labelStyle = getComputedStyle(aspectLabel), helpStyle = getComputedStyle(aspectHelp);
        const audioLabelStyle = getComputedStyle(pickerRoot.querySelector('#share-audio-text'));
        check(labelStyle.fontSize === audioLabelStyle.fontSize && labelStyle.color === audioLabelStyle.color
          && aspectSwitch.parentElement === aspectLabel.parentElement
          && aspectSwitch.getBoundingClientRect().width === audioSwitch.getBoundingClientRect().width
          && aspectSwitch.getBoundingClientRect().height === audioSwitch.getBoundingClientRect().height
          && getComputedStyle(aspectSwitch.parentElement).gap === '12px',
        'Aspect ratio must use the same compact label typography and standard switch as picker audio, beside its label.');
        check(aspectHelp.classList.contains('audio-device-status')
          && helpStyle.fontSize === standardHelperStyle.fontSize && helpStyle.color === standardHelperStyle.color
          && helpStyle.marginTop === standardHelperStyle.marginTop
          && aspectHelp.textContent === language.t('screenShare.preserveAspectRatioDescription')
          && aspectHelp.scrollWidth <= aspectHelp.clientWidth + 1
          && aspectHelp.parentElement.getBoundingClientRect().height <= 100,
        'The complete ON/OFF explanation must use standard muted helper spacing and stay compact without horizontal overflow.');
        aspect.focus();
        check(document.activeElement === aspect && aspect.tabIndex === 0,
          'The aspect-ratio switch must be reachable by keyboard.');
        aspect.click();
        check(!aspect.checked, 'The existing switch component must allow explicit OFF.');
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
        const encodingRequestsBeforeMethod = encodingRequests.length;
        windowMethod.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        check(gameMethod.getAttribute('aria-pressed') === 'true' && windowMethod.getAttribute('aria-pressed') === 'false' &&
          document.activeElement === gameMethod && picker.selectedSourceId === windowId &&
          [...pickerRoot.querySelectorAll('.source-item')].every((card, index) => card === windowCards[index]) &&
          enumerations === enumerationsBeforeMethod && nativeCommands === 0 && encodingRequests.length === encodingRequestsBeforeMethod,
        'Keyboard method changes must keep the same opaque window and DOM list without enumeration, repeated encoding probes or capture.');
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
          codec: settingsStore.preferredScreenCodec, encodingMode: settingsStore.screenEncodingMode,
          cameraCodec: settingsStore.preferredVideoCodec });
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
          !aspect.checked && !audio.checked && nativeCommands === 0,
        'Refresh must add newly opened windows while retaining the exact source, method, audio and aspect-ratio choice.');
        check(JSON.stringify({ preset: settingsStore.qualityPreset, profile: settingsStore.customProfile,
          codec: settingsStore.preferredScreenCodec, encodingMode: settingsStore.screenEncodingMode,
          cameraCodec: settingsStore.preferredVideoCodec }) === savedQuality,
        'Refreshing a source list must never change media quality or codec preferences.');
        enumerateSources = async () => { throw new Error('Expected software-only refresh failure'); };
        refresh.click();
        aspect.focus();
        await settled(() => !!pickerRoot.querySelector('#share-sources-panel [role="alert"]'), `${locale}/refresh error`);
        check(!refresh.disabled && pickerRoot.querySelector('#btn-share').disabled &&
          picker.selectedSourceId === windowId && picker.windowCaptureMethod === 'game' && !aspect.checked && !audio.checked,
        'An enumeration error must be visible and retryable, never confirm an unverified stale list or discard pending choices.');
        check(document.activeElement === aspect,
          'Refresh completion must not steal focus after the user moves to another available control.');
        enumerateSources = async () => sources;
        pickerRoot.querySelector('[data-loading-retry]').click();
        await settled(() => !refresh.disabled, `${locale}/refresh retry`);
        check(picker.selectedSourceId === windowId && picker.windowCaptureMethod === 'game' &&
          !pickerRoot.querySelector('#btn-share').disabled && !aspect.checked && !audio.checked,
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
          pickerRoot.querySelector('#share-audio-text').textContent === language.t('screenShare.shareAudio') && !aspect.checked,
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
        const ownWindow = { ...candidate(`window:999:${'f'.repeat(64)}`, 'window', 'Monky Dev'), isOwnWindow: true };
        sources.push(ownWindow);
        refresh.click();
        await settled(() => !refresh.disabled, `${locale}/own window`);
        audio.checked = true;
        audio.dispatchEvent(new Event('change', { bubbles: true }));
        pickerRoot.querySelector(`[data-source-id="${ownWindow.id}"]`)
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const audioWarning = pickerRoot.querySelector('#share-audio-warning');
        check(!audio.checked && audio.disabled && !confirmation.disabled && !audioWarning.hidden &&
          audioWarning.textContent === language.t('screenShare.ownWindowAudioUnavailable') &&
          audioWarning.getAttribute('role') === 'status' && audio.getAttribute('aria-describedby') === audioWarning.id,
        'Monky windows remain shareable without audio, with a disabled switch and a localized, accessible reason.');
        gameMethod.click();
        check(!audio.checked && audio.disabled && !confirmation.disabled,
          'Changing capture method cannot enable Monky window audio.');
        check(audioWarning.scrollWidth <= audioWarning.clientWidth + 1 && pickerRoot.scrollWidth <= pickerRoot.clientWidth + 1,
          'The own-window audio warning fits narrow viewports in both languages.');
        pickerRoot.querySelector('#share-tab-screen').click();
        check(audio.checked && !audio.disabled && audioWarning.hidden, 'Monitor audio is not blocked by visiting a Monky window.');
        pickerRoot.querySelector('#share-tab-window').click();
        choose();
        check(audio.checked && !audio.disabled && audioWarning.hidden && !audio.hasAttribute('aria-describedby'),
          'Returning to another application restores its prior audio choice without reconnecting.');
        audio.checked = false;
        audio.dispatchEvent(new Event('change', { bubbles: true }));
        sources = sources.filter(source => source.id !== windowId);
        refresh.click();
        await settled(() => !refresh.disabled, `${locale}/removed source`);
        check(picker.selectedSourceId === null && pickerRoot.querySelector('#share-window-methods').hidden &&
          !pickerRoot.querySelector(`[data-source-id="${windowId}"]`) && confirmation.disabled && !audio.checked && !aspect.checked,
        'Refreshing away a closed window must clear selection/method controls without changing its audio preference.');
        picker.close();
        await picker.open();
        document.querySelector('.source-item').click();
        const reopenedEnumerations = enumerations;
        gameMethod.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        check(picker.windowCaptureMethod === 'window' && document.querySelector('#share-method-window').getAttribute('aria-pressed') === 'true',
          'Detached method-card listeners must not mutate the next picker opening.');
        check(document.querySelector('#chk-preserve-aspect-ratio').checked && enumerations === reopenedEnumerations,
          'A new sharing picker resets aspect ratio to ON and detached refresh handlers cannot enumerate or mutate it.');
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
    selects.dispose();
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
