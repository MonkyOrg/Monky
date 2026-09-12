module.exports = { runMediaSettingsPopoverSmoke };

async function runMediaSettingsPopoverSmoke() {
  const [{ bindAudioDevicePopovers }, { CameraEffectsControl }, { NoiseSuppressionControl, noiseSuppressionToggleTitle },
    { settingsModal }, { videoService: video }, { audioProcessor: audio }, { cameraEffectsStore: effects },
    { settingsStore: settings }, { voiceStore: voice }, { appEvents }, language, { initTooltips }] = await Promise.all([
    import('/views/AudioDevicePopover.ts'), import('/views/settings/CameraEffectsControl.ts'),
    import('/views/settings/NoiseSuppressionControl.ts'), import('/views/SettingsModal.ts'),
    import('/core/VideoService.ts'), import('/core/AudioProcessor.ts'), import('/stores/cameraEffectsStore.ts'),
    import('/stores/settingsStore.ts'), import('/stores/voiceStore.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
    import('/core/TooltipService.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (probe, message) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (probe()) return;
      await wait();
    }
    throw new Error(message);
  };
  const listenerCount = () => [...appEvents.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  const original = {
    gum: navigator.mediaDevices.getUserMedia, enumerate: navigator.mediaDevices.enumerateDevices,
    noise: audio.setNoiseSuppression, open: settingsModal.open, save: settings.save,
    camera: settings.selectedCameraId, noiseMode: settings.noiseSuppressionMode,
    lastNoise: settings.lastNoiseSuppressionMode, quality: settings.qualityPreset,
    muted: voice.isMuted, deafened: voice.isDeafened, cameraOn: voice.isCameraOn,
    visibility: Object.getOwnPropertyDescriptor(document, 'visibilityState'), bitmap: window.createImageBitmap,
    language: language.getLanguage(), storage: localStorage.getItem('monky_settings'),
  };
  let documentVisible = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => documentVisible ? 'visible' : 'hidden' });
  const source = document.createElement('canvas');
  source.width = 320;
  source.height = 180;
  const context = source.getContext('2d');
  const draw = () => {
    context.fillStyle = '#00ff00';
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#e01010';
    context.fillRect(120, 40, 80, 110);
  };
  draw();
  const timer = setInterval(draw, 50);
  const captures = [];
  const requests = [];
  let maxLiveCaptures = 0;
  const capture = () => {
    const stream = source.captureStream(15);
    captures.push(stream);
    maxLiveCaptures = Math.max(maxLiveCaptures, captures.filter(item => item.active).length);
    return stream;
  };
  let pauseCapture = false;
  let pendingCapture = null;
  let devices = [
    { kind: 'videoinput', deviceId: 'camera-a', label: '<b>Fixture camera A</b>' },
    { kind: 'videoinput', deviceId: 'camera-b', label: 'Fixture camera B' },
  ];
  navigator.mediaDevices.enumerateDevices = async () => devices;
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints.video || constraints.audio !== false) throw new Error('This fixture permits only synthetic camera capture');
    requests.push(constraints);
    if (pauseCapture) return await new Promise(resolve => { pendingCapture = resolve; });
    return capture();
  };
  const noiseRequests = [];
  let failNoise = false;
  let pendingNoise = null;
  audio.setNoiseSuppression = async (mode, signal) => {
    noiseRequests.push(mode);
    if (failNoise) throw new Error('Synthetic engine selection failure');
    if (pendingNoise && pendingNoise.mode === mode) {
      pendingNoise.signal = signal;
      await new Promise(resolve => { pendingNoise.resolve = resolve; });
    }
  };
  const navigations = [];
  settingsModal.open = async (...args) => { navigations.push(args); };
  const initialListeners = listenerCount();
  let primaryActions = 0;
  let stopped = 0;
  const offStop = appEvents.on('local.camera_stopped', () => { stopped++; });
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px';
  root.innerHTML = '<button data-primary="camera">camera</button><button data-audio-device="camera">up</button><span data-noise-slot></span><button data-outside>outside</button>';
  root.querySelector('[data-primary]').addEventListener('click', () => { primaryActions++; });
  document.body.append(root);
  const cameraTrigger = root.querySelector('[data-audio-device="camera"]');
  const unbind = bindAudioDevicePopovers(root);
  const hidden = document.createElement('div');
  hidden.hidden = true;
  hidden.style.cssText = 'position:fixed;right:12px;top:12px;width:360px;max-height:70vh;overflow:auto;background:var(--bg-secondary)';
  const fullCamera = new CameraEffectsControl();
  const fullNoise = new NoiseSuppressionControl();
  const panel = () => document.querySelector('.audio-device-popover');
  const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const preview = () => panel()?.querySelector('video.camera-effects-preview');
  const ready = () => preview()?.srcObject && preview().readyState >= 2 && video.getCameraState().status === 'ready';
  const openCamera = async () => {
    cameraTrigger.click();
    await until(ready, 'Visible camera popover must acquire its default local preview');
  };
  const chooseDevice = async id => {
    const row = panel().querySelector('.audio-device-current');
    await until(() => !row.disabled, 'Camera device row must be available');
    row.click();
    const option = document.querySelector(`.audio-device-options button[data-device-id="${id}"]`);
    check(option && !option.disabled, `Camera ${id} is selectable in the shared-style device submenu`);
    option.click();
    await until(() => !row.disabled, 'Camera device selection must settle');
  };
  let releaseImage = null;
  const disposeTooltips = initTooltips();
  const helpKeys = {
    blurRadius: 'cameraEffects.blurStrengthHelp', personThreshold: 'cameraEffects.personThresholdHelp',
    edgeSoftness: 'cameraEffects.edgeSoftnessHelp', keyColor: 'cameraEffects.keyColorHelp',
    keyTolerance: 'cameraEffects.keyToleranceHelp', keySoftness: 'cameraEffects.keySoftnessHelp',
    spillReduction: 'cameraEffects.spillReductionHelp', backgroundSource: 'cameraEffects.chromaReplacementHelp',
    backgroundColor: 'cameraEffects.backgroundColorHelp', backgroundImage: 'cameraEffects.imageHelp',
    limitQuality: 'cameraEffects.limitQualityHelp',
  };
  const verifyHelp = scope => {
    check(scope.querySelectorAll('[data-camera-help]').length === Object.keys(helpKeys).length,
      'Every camera-effect adjustment has its own help affordance');
    for (const [setting, key] of Object.entries(helpKeys)) {
      const help = scope.querySelector(`[data-camera-help="${setting}"]`);
      const description = document.getElementById(help.getAttribute('data-tooltip-source'));
      check(help.type === 'button' && help.textContent.trim() === '?' && help.tabIndex === 0
        && Boolean(help.getAttribute('aria-label')) && !help.closest('label'),
        `${setting}: question-mark help is keyboard accessible and cannot activate a label's control`);
      check(description?.hidden && description.textContent === language.t(key),
        `${setting}: help uses the current locale and the shared text-only tooltip source`);
      const input = scope.querySelector(`[data-camera-setting="${setting}"], .color-picker-trigger[name="${setting}"]`);
      if (input) {
        check(input.getAttribute('aria-describedby')?.split(/\s+/).includes(description.id),
          `${setting}: the adjustment exposes its explanation to assistive technology`);
      }
    }
  };
  try {
    video.stopCamera();
    language.setLanguage('pt-BR');
    hidden.innerHTML = fullCamera.renderHtml() + fullNoise.renderHtml();
    document.body.append(hidden);
    fullCamera.attachEvents(hidden);
    fullNoise.attachEvents(hidden);
    fullCamera.activate();
    settings.selectedCameraId = 'camera-a';
    settings.noiseSuppressionMode = 'off';
    voice.isMuted = true;
    voice.isDeafened = true;
    voice.isCameraOn = false;
    video.setQualityPreset('NORMAL');
    await video.setCameraEffects({ mode: 'off', backgroundSource: 'color', backgroundColor: '#1122dd', limitQuality: false });
    await wait(120);
    check(requests.length === 0, 'Attaching and even activating a hidden pre-rendered camera panel never captures hardware');
    root.querySelector('[data-noise-slot]').innerHTML = '<button data-primary="noise">noise</button><button data-audio-device="noise">up</button>';
    const noiseTrigger = root.querySelector('[data-audio-device="noise"]');
    root.querySelector('[data-primary="noise"]').addEventListener('click', () => { primaryActions++; });
    noiseTrigger.click();
    check(panel()?.getAttribute('role') === 'dialog' && noiseTrigger.getAttribute('aria-expanded') === 'true',
      'Delegated quick controls also bind a noise trigger inserted after the footer was mounted');
    check(panel().getAttribute('aria-label') === language.t('audioNoise.quickOptions'), 'Noise popover follows the selected locale');
    const cards = [...panel().querySelectorAll('[data-noise-mode]')];
    check(cards.length === 5 && ['rnnoise', 'speex', 'gtcrn', 'browser', 'off'].every(mode => cards.some(card => card.dataset.noiseMode === mode)),
      'All existing noise engines and Off are available without changing the primary toggle');
    check(cards.find(card => card.dataset.noiseMode === 'browser').textContent.includes('WebRTC (nativo)')
      && hidden.querySelector('option[value="browser"]').textContent === 'WebRTC (nativo)'
      && noiseSuppressionToggleTitle('browser').includes('WebRTC (nativo)'),
    'Portuguese settings, quick choices and accessible primary titles use WebRTC while retaining the browser ID');
    check(!panel().querySelector('input[type=checkbox], input[type=radio]'), 'Quick choices use accessible buttons, not standalone native inputs');
    check(requests.length === 0 && primaryActions === 0 && !video.getCameraState().publishing,
      'Opening noise choices never starts camera, microphone or publication actions');
    const beforeKeys = noiseRequests.length;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    check(document.activeElement === cards[0], 'Noise choices support Home keyboard navigation');
    cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    check(document.activeElement === cards.at(-1) && noiseRequests.length === beforeKeys,
      'Keyboard navigation changes focus, not the running engine, until activated');
    for (const mode of ['rnnoise', 'speex', 'gtcrn', 'browser', 'off']) {
      const card = cards.find(item => item.dataset.noiseMode === mode);
      card.click();
      await until(() => !card.disabled && settings.noiseSuppressionMode === mode, `Quick ${mode} choice must persist through the existing selector`);
      check(card.getAttribute('aria-selected') === 'true' && hidden.querySelector('select').value === mode
        && cards.filter(item => item.getAttribute('aria-selected') === 'true').length === 1,
      `${mode} stays synchronized with the full settings control`);
      if (mode === 'browser') {
        const hint = language.t('audioNoise.browserDescription');
        check(hint.includes('aplicativo') && hint.includes('RNNoise')
          && panel().querySelector('[id$="-noise-suppression-description"]').textContent === hint
          && hidden.querySelector('#noise-suppression-description').textContent === hint,
        'Portuguese helper copy describes built-in app processing and distinguishes the RNNoise default');
      }
    }
    failNoise = true;
    cards.find(card => card.dataset.noiseMode === 'speex').click();
    await until(() => !cards[0].disabled, 'Failed noise choice settles');
    check(settings.noiseSuppressionMode === 'off' && panel().textContent.includes(language.t('audioNoise.selectionFailed')),
      'A failed quick engine choice retains the previous selection and reports a localized error');
    failNoise = false;
    pendingNoise = { mode: 'gtcrn' };
    cards.find(card => card.dataset.noiseMode === 'gtcrn').click();
    await until(() => pendingNoise.resolve, 'Deferred engine selection begins');
    escape();
    check(!panel() && pendingNoise.signal.aborted && document.activeElement === noiseTrigger,
      'Escape restores trigger focus and cancels only the pending noise selection');
    pendingNoise.resolve();
    pendingNoise = null;
    await wait(100);
    check(settings.noiseSuppressionMode === 'off', 'Closing a pending noise selection cannot persist stale success');
    noiseTrigger.click();
    panel().querySelector('.audio-device-settings').click();
    check(navigations.at(-1)?.join(':') === 'voice_video:noise-suppression' && !panel(),
      'Noise settings navigation requests the actual noise section, not the default settings tab');

    await openCamera();
    check(panel().getAttribute('aria-label') === language.t('cameraEffects.quickOptions'), 'Camera quick controls use the selected locale');
    verifyHelp(panel());
    verifyHelp(hidden);
    check(panel().querySelector('[data-camera-preview-toggle]').getAttribute('aria-checked') === 'true',
      'Visible camera controls open with preview enabled by default');
    check(requests.length === 1 && !video.getCameraState().publishing && video.getCameraStream() === null,
      'Default camera preview owns one local, nonpublishing capture');
    const frame = panel().querySelector('[data-camera-preview-frame]');
    const initialBox = frame.getBoundingClientRect();
    check(initialBox.width > 250 && initialBox.height > 120 && frame.getBoundingClientRect().top
      < panel().querySelector('[data-camera-mode]').getBoundingClientRect().top,
    'The preview switch and stable preview rectangle precede effects in the quick panel');
    const identifiers = [...document.querySelectorAll('[id]')].map(element => element.id);
    check(new Set(identifiers).size === identifiers.length, 'Quick and pre-rendered full settings never duplicate control IDs');
    for (const element of panel().querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls], label[for], output[for]')) {
      for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'for']) {
        check((element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean).every(id => document.getElementById(id)),
          `Camera ${attribute} references resolve to distinct existing controls`);
      }
    }
    check(!panel().querySelector('.audio-device-current b'), 'Camera device labels are rendered as text, not HTML');
    panel().querySelector('[data-camera-preview-toggle]').click();
    await until(() => video.getCameraState().status === 'idle', 'Hiding the only preview releases capture');
    const hiddenBox = frame.getBoundingClientRect();
    check(!preview().srcObject && panel().querySelector('[data-camera-preview-placeholder]').textContent === 'Visualização desligada'
      && Math.abs(hiddenBox.width - initialBox.width) < 1 && Math.abs(hiddenBox.height - initialBox.height) < 1,
    'Hiding preview preserves its rectangle and displays the requested localized placeholder');
    const beforeHidden = requests.length;
    window.dispatchEvent(new Event('resize'));
    await wait(120);
    check(requests.length === beforeHidden && captures.every(stream => !stream.active), 'A user-hidden preview cannot be restarted by layout updates');
    panel().querySelector('[data-camera-preview-toggle]').click();
    await until(ready, 'Explicitly showing preview reacquires only its own lease');
    panel().querySelector('[data-camera-mode="chroma"]').click();
    await until(() => ready() && effects.snapshot.settings.mode === 'chroma', 'Quick effects use the real local chroma processor');
    const sample = document.createElement('canvas');
    sample.width = 32;
    sample.height = 18;
    const pixels = sample.getContext('2d', { willReadFrequently: true });
    for (const [setting, color] of [['backgroundColor', '#663399'], ['keyColor', '#11ff11']]) {
      const trigger = panel().querySelector(`.color-picker-trigger[name="${setting}"]`);
      trigger.click();
      const picker = document.querySelector('.color-picker-popover:popover-open');
      check(picker && panel().contains(picker) && !panel().querySelector('input[type="color"]'),
        'Camera color selection uses the shared nested picker rather than a native dialog');
      const input = picker.querySelector('[data-color-hex]');
      input.value = color;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      frame.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
      await until(() => !trigger.disabled && ready(), 'Camera color selection must settle');
      check(effects.snapshot.settings[setting] === color && trigger.value === color
        && hidden.querySelector(`.color-picker-trigger[name="${setting}"]`).value === color,
        `${setting}: committing a chosen color must not read the old value restored by a UI refresh`);
      check(!document.querySelector('.color-picker-popover') && panel() && !video.getCameraState().publishing,
        'Outside click keeps the selected color, parent popup and local-only preview');
      if (setting === 'backgroundColor') {
        await until(() => {
          pixels.drawImage(preview(), 0, 0, 32, 18);
          const actual = pixels.getImageData(29, 16, 1, 1).data;
          return [102, 51, 153].every((value, index) => Math.abs(actual[index] - value) < 20);
        }, 'The real effect preview must display the newly selected background color');
      }
    }
    const chromaStream = video.getCameraState().stream;
    const capturesBeforeNeutralKeys = requests.length;
    const stopsBeforeNeutralKeys = stopped;
    for (const color of ['#ffffff', '#000000', '#808080', '#808182']) {
      const trigger = panel().querySelector('.color-picker-trigger[name="keyColor"]');
      trigger.click();
      const picker = panel().querySelector('.color-picker-popover');
      const input = picker.querySelector('[data-color-hex]');
      input.value = color;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      frame.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
      await until(() => !trigger.disabled && ready(), `Physical key ${color} must remain usable`);
      check(effects.snapshot.settings.keyColor === color && trigger.value === color
        && video.getCameraState().stream === chromaStream && chromaStream.active
        && stopped === stopsBeforeNeutralKeys && requests.length === capturesBeforeNeutralKeys,
      `Physical key ${color} must persist without stopping or recapturing the camera`);
      await until(() => {
        pixels.drawImage(preview(), 0, 0, 32, 18);
        const actual = pixels.getImageData(29, 16, 1, 1).data;
        return actual[0] < 20 && actual[1] > 235 && actual[2] < 20;
      }, `A neutral ${color} key must preserve the real nonmatching green background`);
    }
    await video.setCameraEffects({ backgroundColor: '#1122dd', keyColor: '#00ff00' });
    const qualityLimit = panel().querySelector('[data-camera-quality-limit]');
    check(qualityLimit.getAttribute('role') === 'switch' && qualityLimit.getAttribute('aria-checked') === 'false'
      && document.getElementById(qualityLimit.getAttribute('aria-labelledby')).textContent === language.t('cameraEffects.limitQuality')
      && !panel().querySelector('[data-camera-setting="maxFps"], [data-camera-fps-limit]'),
      'Effects expose one default-off switch labeled with both 720p and 30 FPS limits');
    check(!panel().querySelector('[data-camera-green]') && !hidden.querySelector('[data-camera-green]'),
      'Replacement color uses the picker without a separate green shortcut in either surface');
    qualityLimit.click();
    await until(() => !qualityLimit.disabled && effects.snapshot.settings.limitQuality && ready(), 'Optional quality limit must apply');
    check(qualityLimit.getAttribute('aria-checked') === 'true'
      && hidden.querySelector('[data-camera-quality-limit]').getAttribute('aria-checked') === 'true',
      'The combined quality limit remains synchronized between popup and full settings');
    qualityLimit.click();
    await until(() => !qualityLimit.disabled && !effects.snapshot.settings.limitQuality && ready(), 'Disabling the cap must restore profile quality');
    const help = panel().querySelector('[data-camera-help="keyTolerance"]');
    help.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    // Scrolling dismisses tooltip intent; hover only after queued scroll events settle.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    help.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    await until(() => document.querySelector('.monky-tooltip:not([hidden])'), 'Hovering the question mark must show its tooltip');
    check(document.querySelector('.monky-tooltip__content').textContent === language.t('cameraEffects.keyToleranceHelp'),
      'Chroma tolerance tooltip explains the actual adjustment');
    help.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: root }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    help.focus({ preventScroll: true });
    help.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await until(() => document.querySelector('.monky-tooltip:not([hidden])'), 'Keyboard focus must also expose adjustment help');
    help.click();
    check(effects.snapshot.settings.mode === 'chroma' && ready() && !video.getCameraState().publishing,
      'Using help does not change effects, stop preview or publish the camera');
    const previewToggle = panel().querySelector('[data-camera-preview-toggle]');
    previewToggle.focus({ preventScroll: true });
    previewToggle.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await until(() => {
      pixels.drawImage(preview(), 0, 0, 32, 18);
      const color = pixels.getImageData(29, 16, 1, 1).data;
      return [17, 34, 221].every((value, index) => Math.abs(color[index] - value) < 20);
    }, 'The quick preview must display processed replacement pixels, never physical raw green');
    check(preview().srcObject === video.getCameraState().stream, 'Quick effect preview is the exact outgoing processed stream');
    const beforeCall = requests.length;
    const shared = await video.startCamera();
    check(preview().srcObject === shared && requests.length === beforeCall, 'Promoting quick preview to a call never duplicates hardware capture');
    voice.isCameraOn = true;
    hidden.hidden = false;
    await until(() => hidden.querySelector('video').srcObject === shared, 'A second visible settings control shares the same stream');
    check(requests.length === beforeCall, 'Simultaneous settings and popup previews share a single hardware capture');
    documentVisible = false;
    document.dispatchEvent(new Event('visibilitychange'));
    check(!preview().srcObject && !hidden.querySelector('video').srcObject && shared.active,
      'A hidden document releases both UI previews without stopping the call');
    documentVisible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await until(() => ready() && hidden.querySelector('video').srcObject === shared, 'Restored visible controls reuse the call');
    check(requests.length === beforeCall, 'Document visibility changes cannot duplicate an active call capture');
    hidden.hidden = true;
    fullCamera.deactivate();
    escape();
    check(!panel() && shared.active && video.getCameraStream() === shared && voice.isCameraOn,
      'Dismissing all camera UI releases its leases but preserves an active call and camera flag');
    await openCamera();
    await chooseDevice('camera-b');
    await until(() => ready() && video.getCameraStream() !== shared, 'Device switching updates active camera and preview');
    check(settings.selectedCameraId === 'camera-b' && requests.at(-1).video.deviceId.exact === 'camera-b'
      && !shared.active && preview().srcObject === video.getCameraStream(),
    'Quick device selection persists and replaces the shared processed camera without touching call state');
    const stable = video.getCameraStream();
    const beforeSave = requests.length;
    settings.save = () => { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); };
    await chooseDevice('camera-a');
    check(settings.selectedCameraId === 'camera-b' && requests.length === beforeSave && video.getCameraStream() === stable && stable.active,
      'Device preference save failure preserves the active capture and previous device');
    check(panel().textContent.includes(language.t('cameraEffects.deviceSaveFailed'))
      && panel().querySelector('[data-camera-error-actions]').hidden,
    'A device save failure reports the retained selection, not a false stopped-camera claim or privacy recovery action');
    settings.save = original.save;
    devices = devices.filter(device => device.deviceId !== 'camera-b');
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await wait(100);
    check(panel().querySelector('select option[value="camera-b"]')?.disabled
      && panel().querySelector('select').value === 'camera-b', 'Quick camera hotplug preserves an explicitly unavailable choice');
    devices.push({ kind: 'videoinput', deviceId: 'camera-b', label: 'Fixture camera B' });
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));

    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = 160;
    imageCanvas.height = 90;
    const imageContext = imageCanvas.getContext('2d');
    imageContext.fillStyle = '#3344aa';
    imageContext.fillRect(0, 0, 160, 90);
    const blob = await new Promise(resolve => imageCanvas.toBlob(resolve, 'image/png'));
    await video.setCameraBackgroundImage(new File([blob], 'initial-synthetic.png', { type: 'image/png' }));
    await video.setCameraEffects({ backgroundSource: 'image' });
    await until(ready, 'Initial local image renders before the image-change lifetime regression');
    let imageEntered = false;
    window.createImageBitmap = async (source, ...options) => {
      if (source instanceof Blob && !imageEntered) {
        imageEntered = true;
        await new Promise(resolve => { releaseImage = resolve; });
      }
      return await original.bitmap.call(window, source, ...options);
    };
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'confirmed-synthetic.png', { type: 'image/png' }));
    const imageInput = panel().querySelector('input[type=file]');
    imageInput.files = transfer.files;
    imageInput.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => releaseImage, 'Image preparation is pending when its UI closes');
    const beforeImageClose = stopped;
    escape();
    check(!panel() && video.getCameraStream()?.active, 'Closing during confirmed image preparation does not stop the call');
    releaseImage();
    releaseImage = null;
    await until(() => effects.snapshot.image?.name === 'confirmed-synthetic.png'
      && video.getCameraState().status === 'ready', 'Confirmed image choice must finish after the UI was dismissed');
    check(stopped === beforeImageClose && video.getCameraStream()?.active && voice.isCameraOn,
      'A dismissed control never aborts an already confirmed shared image change or its active call');
    window.createImageBitmap = original.bitmap;

    await openCamera();
    const beforeStop = requests.length;
    video.stopCamera();
    await wait(160);
    window.dispatchEvent(new Event('resize'));
    await wait(100);
    check(requests.length === beforeStop && !preview().srcObject
      && panel().querySelector('[data-camera-preview-toggle]').getAttribute('aria-checked') === 'false',
    'Call end or external stop cannot automatically reacquire a still-open preview');
    panel().querySelector('.audio-device-settings').click();
    check(navigations.at(-1)?.join(':') === 'voice_video:camera' && !panel(),
      'Camera settings navigation targets the camera section and releases the popup lease');
    pauseCapture = true;
    cameraTrigger.click();
    await until(() => pendingCapture, 'Default preview may be waiting for permission');
    escape();
    const late = capture();
    pendingCapture(late);
    pendingCapture = null;
    pauseCapture = false;
    await video.cameraJobs;
    await wait(80);
    check(!late.active && video.getCameraState().stream === null && !panel(),
      'Dismissing a pending default preview retires late hardware tracks without reopening UI');
    language.setLanguage('en');
    await openCamera();
    check(panel().getAttribute('aria-label') === language.t('cameraEffects.quickOptions'), 'Reopened quick controls honor a changed locale');
    verifyHelp(panel());
    panel().querySelector('[data-camera-preview-toggle]').click();
    check(panel().querySelector('[data-camera-preview-placeholder]').textContent === 'Preview off',
      'The retained placeholder also uses the English catalog');
    root.querySelector('[data-outside]').focus();
    // An unfocused hidden Electron window updates activeElement without emitting focusin.
    root.querySelector('[data-outside]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await wait();
    check(!panel() && cameraTrigger.getAttribute('aria-expanded') === 'false',
      `Focus leaving the quick dialog dismisses only that dialog: ${JSON.stringify({
        panel: !!panel(), expanded: cameraTrigger.getAttribute('aria-expanded'),
        focused: document.activeElement?.outerHTML, documentFocused: document.hasFocus(),
      })}`);
    fullNoise.cleanup();
    hidden.querySelector('#noise-suppression-control').outerHTML = fullNoise.renderHtml();
    fullNoise.attachEvents(hidden);
    noiseTrigger.click();
    const nativeChoice = panel().querySelector('[data-noise-mode="browser"]');
    check(nativeChoice.textContent.includes('WebRTC (built-in)')
      && hidden.querySelector('option[value="browser"]').textContent === 'WebRTC (built-in)'
      && noiseSuppressionToggleTitle('browser').includes('WebRTC (built-in)'),
    'English settings, quick choices and accessible titles use WebRTC without changing the engine ID');
    nativeChoice.click();
    await until(() => !nativeChoice.disabled && settings.noiseSuppressionMode === 'browser', 'English native choice retains the browser mode ID');
    const nativeHint = language.t('audioNoise.browserDescription');
    check(nativeHint.includes('app') && nativeHint.includes('RNNoise')
      && panel().querySelector('[id$="-noise-suppression-description"]').textContent === nativeHint
      && hidden.querySelector('#noise-suppression-description').textContent === nativeHint,
    'English helper copy describes built-in app processing and distinguishes the RNNoise default');
    escape();
    check(primaryActions === 0 && voice.isMuted && voice.isDeafened,
      'Quick arrows, previews, settings and device choices never activate mute, deafen or camera primary toggles');
    check(maxLiveCaptures === 1, 'All preview, device, image and permission races have at most one live hardware capture');
    unbind();
    fullCamera.cleanup();
    fullNoise.cleanup();
    offStop();
    video.stopCamera();
    await video.cameraJobs;
    await wait(300);
    check(captures.every(stream => !stream.active) && !document.querySelector('.audio-device-popover, .audio-device-options'),
      'Final teardown leaves no captured tracks, popovers or submenu portals');
    check(listenerCount() === initialListeners, 'Quick and settings controls leave no EventBus listeners');
  } finally {
    disposeTooltips();
    if (pendingNoise?.resolve) { pendingNoise.resolve(); pendingNoise = null; }
    releaseImage?.();
    if (pendingCapture) { pendingCapture(capture()); pendingCapture = null; }
    unbind();
    fullCamera.cleanup();
    fullNoise.cleanup();
    offStop();
    video.stopCamera();
    await video.cameraJobs;
    clearInterval(timer);
    captures.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    root.remove();
    hidden.remove();
    window.createImageBitmap = original.bitmap;
    audio.setNoiseSuppression = original.noise;
    settingsModal.open = original.open;
    settings.save = original.save;
    navigator.mediaDevices.getUserMedia = original.gum;
    navigator.mediaDevices.enumerateDevices = original.enumerate;
    if (original.visibility) Object.defineProperty(document, 'visibilityState', original.visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    settings.selectedCameraId = original.camera;
    settings.noiseSuppressionMode = original.noiseMode;
    settings.lastNoiseSuppressionMode = original.lastNoise;
    voice.isMuted = original.muted;
    voice.isDeafened = original.deafened;
    voice.isCameraOn = original.cameraOn;
    video.setQualityPreset(original.quality);
    language.setLanguage(original.language);
    if (original.storage === null) localStorage.removeItem('monky_settings');
    else localStorage.setItem('monky_settings', original.storage);
  }
  return checks;
}
