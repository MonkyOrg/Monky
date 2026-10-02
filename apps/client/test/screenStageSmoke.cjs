'use strict';

module.exports = { runScreenStageSmoke };

async function runScreenStageSmoke(fallbackHandlerSource) {
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const restore = [];
  const replace = (object, key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restore.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : Reflect.deleteProperty(object, key));
  };
  let mediaRequests = 0;
  let copiedTelemetry = '';
  replace(navigator.clipboard, 'writeText', async text => { copiedTelemetry = text; });
  replace(window, 'api', {
    ...window.api,
    onWindowInactive: () => () => {},
    onWindowActive: () => () => {},
  });
  const denyMedia = async () => { mediaRequests++; throw new Error('The screen stage UI smoke cannot capture media.'); };
  replace(navigator.mediaDevices, 'getUserMedia', denyMedia);
  replace(navigator.mediaDevices, 'getDisplayMedia', denyMedia);
  const pipRequests = [];
  let rejectPip = false;
  replace(document, 'pictureInPictureEnabled', true);
  replace(HTMLVideoElement.prototype, 'requestPictureInPicture', async function requestPictureInPicture() {
    if (rejectPip) throw new DOMException('Expected Picture-in-Picture rejection', 'NotAllowedError');
    pipRequests.push(this);
    return {};
  });

  const [{ VoiceStageView }, { MainView }, { voiceStore: voice }, { settingsStore: settings }, { serverStore: server },
    { participantManager: participants }, { appEvents }, { videoService }, { webRtcManager: rtc },
    { sessionManager }, language, { showInfoToast }, { overlayBridgeService }] = await Promise.all([
    import('/views/VoiceStageView.ts'), import('/views/MainView.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/stores/serverStore.ts'), import('/core/ParticipantManager.ts'), import('/core/EventBus.ts'),
    import('/core/VideoService.ts'), import('/core/WebRtcManager.ts'), import('/core/SessionManager.ts'),
    import('/i18n/index.ts'), import('/views/CopyToast.ts'), import('/core/OverlayBridgeService.ts'),
  ]);
  const originalLanguage = language.getLanguage();
  const session = sessionManager.create('screen-stage-ui.test', 7890, 'UI fixture');
  replace(session.client, 'send', () => {});
  sessionManager.activate(session.key);
  const local = { id: 'local-user', sessionId: 'local-session', clientId: 'local-client',
    nickname: 'Local <UI>', status: 'ONLINE', joinedAt: 1 };
  const remote = { ...local, id: 'remote-user', sessionId: 'remote-session', clientId: 'remote-client', nickname: 'Remote <UI>' };
  const channel = { id: 'stage-ui-channel', name: 'Screen controls', type: 'VOICE', position: 0 };
  const profile = { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 6000 };
  const remoteSource = { shareId: 'remote-native', instanceId: crypto.randomUUID(), video: profile, audio: false };
  const streams = new Map();
  const captures = new Map();
  const modes = new Map();
  const previewStates = new Map();
  const modeKey = (sessionId, shareId) => `${sessionId}/${shareId}`;
  const modeCalls = [];
  replace(videoService, 'getScreenStream', id => streams.get(id) ?? null);
  replace(videoService, 'getScreenShareIds', () => [...streams.keys()]);
  replace(videoService, 'getScreenShareCount', () => streams.size);
  replace(videoService, 'getNativeScreenCapture', id => captures.get(id) ?? null);
  replace(rtc, 'getScreenCaptureMode', (sessionId, shareId) => {
    modeCalls.push([sessionId, shareId]);
    return modes.get(modeKey(sessionId, shareId)) ?? null;
  });
  replace(rtc, 'getNativeScreenSource', (sessionId, shareId) =>
    sessionId === remote.sessionId && shareId === remoteSource.shareId ? remoteSource : null);
  replace(rtc, 'getLocalScreenPreviewState', id => previewStates.get(id) ?? 'waiting');
  let watchState = null;
  replace(rtc, 'getNativeScreenWatchState', (sessionId, shareId) =>
    sessionId === remote.sessionId && shareId === remoteSource.shareId ? watchState : null);
  replace(rtc, 'getAverageP2pPing', async () => 0);
  replace(rtc, 'getScreenViewers', async () => []);
  const screenWatchCalls = [];
  replace(rtc, 'setRemoteScreenWatching', (sessionId, shareId, watching) => {
    screenWatchCalls.push({ sessionId, shareId, watching });
    if (!watching) modes.delete(modeKey(sessionId, shareId));
    voice.setScreenWatching(sessionId, shareId, watching);
  });
  replace(settings, 'screenShareTelemetryEnabled', false);
  replace(settings, 'screenShareTelemetryPosition', 'top-left');
  replace(settings, 'overlayHideStagePreviews', false);
  replace(settings, 'overlayAutoOpenOnLeaveStage', true);
  let overlayOpen = false;
  replace(overlayBridgeService, 'getIsOpen', () => overlayOpen);
  let stage;
  let fullscreen = null;
  let exitGate = null;
  let exitCalls = 0;
  const fullscreenDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  restore.push(() => fullscreenDescriptor ? Object.defineProperty(document, 'fullscreenElement', fullscreenDescriptor)
    : Reflect.deleteProperty(document, 'fullscreenElement'));
  replace(document, 'exitFullscreen', () => {
    exitCalls++;
    if (!exitGate) return Promise.reject(new Error('Unexpected fullscreen exit'));
    return exitGate.promise;
  });
  const clearToasts = [];
  const notifyExports = {};
  new Function('exports', 't', 'showInfoToast', fallbackHandlerSource)(notifyExports, language.t, (message, durationMs) => {
    const clear = showInfoToast(message, durationMs);
    clearToasts.push(clear);
    return clear;
  });
  const watchedEvents = ['local.screen_started', 'local.screen_stopped', 'native_screen.updated', 'voice.state_updated'];
  const listenerCounts = () => watchedEvents.map(name => appEvents.listeners.get(name)?.size ?? 0).join(',');
  const baselineListeners = listenerCounts();
  const card = (sessionId, shareId) => document.querySelector(`[data-tile-key="${sessionId}:screen:${shareId}"]`);
  const badge = (sessionId, shareId) => card(sessionId, shareId)?.querySelector('.stage-capture-mode-badge');
  const video = (sessionId, shareId) => card(sessionId, shareId)?.querySelector('video');
  const focused = () => [...document.querySelectorAll('.stage-focused-main')].map(element => element.dataset.tileKey);
  const focusKey = shareId => `${local.sessionId}:screen:${shareId}`;
  const verifyBadge = (sessionId, shareId, mode) => {
    const element = badge(sessionId, shareId);
    if (mode === null) {
      check(element?.hidden && getComputedStyle(element).display === 'none',
        'An unconfirmed native mode must be hidden, not labelled Normal or pending');
      check(!element.hasAttribute('data-capture-mode') && element.textContent === '' && !element.getAttribute('aria-label'),
        'Unknown mode must not retain an old confirmation or provisional diagnostic label');
      return;
    }
    const label = language.t(mode === 'game' ? 'stage.captureModeGame' : 'stage.captureModeNormal');
    check(element?.dataset.captureMode === mode && element.textContent === label, `Wrong ${mode} badge for ${shareId}`);
    check(!element.hidden, 'A frame-confirmed mode must reveal its badge');
    check(element.getAttribute('role') === 'status' && element.getAttribute('aria-live') === 'polite'
      && element.getAttribute('aria-atomic') === 'true', 'Capture mode must be an accessible noninteractive status');
    check(element.getAttribute('aria-label') === language.t('stage.captureModeLabel', { mode: label }),
      'Mode status must expose a localized accessible name');
  };
  const checkBadgeLayout = () => {
    for (const element of document.querySelectorAll('.stage-capture-mode-badge')) {
      if (element.hidden) {
        check(element.getBoundingClientRect().width === 0 && element.getBoundingClientRect().height === 0,
          'An unconfirmed badge must not occupy layout space');
        continue;
      }
      const bounds = element.getBoundingClientRect();
      const parent = element.closest('[data-kind="screen"]').getBoundingClientRect();
      check(bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility === 'visible',
        'Capture mode remains visible in grid, focus and mini layouts');
      check(bounds.left >= parent.left && bounds.right <= parent.right + 1
        && bounds.top >= parent.top && bounds.bottom <= parent.bottom + 1,
      `Capture mode must fit its card: ${JSON.stringify({ viewport: [innerWidth, innerHeight],
        mode: element.dataset.captureMode, badge: bounds.toJSON(), card: parent.toJSON() })}`);
      check(element.scrollWidth <= element.clientWidth + 1, 'Localized mode text must fit without truncation');
    }
    for (const hint of document.querySelectorAll('.stage-focused-main .stage-focus-hint-badge')) {
      const viewers = hint.parentElement.querySelector('.stage-viewers');
      if (!viewers) continue;
      const hintBounds = hint.getBoundingClientRect(), viewerBounds = viewers.getBoundingClientRect();
      check(hintBounds.bottom <= viewerBounds.top || hintBounds.top >= viewerBounds.bottom
        || hintBounds.right <= viewerBounds.left || hintBounds.left >= viewerBounds.right,
      'The focus hint and viewer badge must not overlap');
    }
  };
  const start = () => {
    const stream = new MediaStream();
    streams.set(stream.id, stream);
    captures.set(stream.id, {
      desktopSourceId: `native-window:${stream.id}`,
      thumbnail: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><path fill="magenta" d="M0 0h4v4H0z"/></svg>'),
      source: { shareId: stream.id, instanceId: crypto.randomUUID(), video: profile, audio: false },
    });
    appEvents.emit('local.screen_started', { shareId: stream.id, stream });
    return stream;
  };
  const stop = stream => {
    streams.delete(stream.id);
    captures.delete(stream.id);
    modes.delete(modeKey(local.sessionId, stream.id));
    appEvents.emit('local.screen_stopped', stream.id);
    voice.removeScreenShare(stream.id);
  };
  const clearShares = () => {
    for (const stream of streams.values()) stop(stream);
    voice.setScreenSharing(false);
    appEvents.emit('participants.updated');
    stage?.setFocusedTiles([]);
  };
  const announceParticipants = () => {
    participants.setUsers([local, remote]);
    for (const user of [local, remote]) {
      participants.updateVoiceState({
        userId: user.id, sessionId: user.sessionId, channelId: channel.id,
        isSpeaking: false, isMuted: false, isDeafened: false, isCameraOn: user === remote,
        isScreenSharing: user === remote, screenShareIds: user === remote ? [remoteSource.shareId, 'remote-browser'] : [],
        nativeScreenShares: user === remote ? [remoteSource] : [],
      });
    }
    participants.get(remote.sessionId).remoteScreenStreams.set(remoteSource.shareId, new MediaStream());
  };

  try {
    for (const locale of ['pt-BR', 'en']) {
      language.setLanguage(locale);
      document.body.innerHTML = '<div id="screen-stage-fixture" style="height:100vh;width:100vw;display:flex;flex-direction:column;min-height:0"></div>';
      server.setServerDetails({
        id: 'stage-ui-server', name: 'UI fixture', createdAt: 1, maxUsers: 10, voiceStates: {},
        protocol: { version: 30, minimumVersion: 29, features: ['screen-viewers'] },
        channels: [channel, { ...channel, id: 'other-channel' }], members: [local, remote], knownMembers: [local, remote],
        roles: [], userRoles: [], myPermissions: 2147483647, ownerId: local.id,
      }, local);
      voice.setChannel(channel.id, session.key);
      voice.isCameraOn = false;
      voice.setScreenSharing(false);
      announceParticipants();
      const root = document.getElementById('screen-stage-fixture');
      stage = new VoiceStageView(root);
      stage.setChannel(channel.id);
      await document.fonts.ready;
      await frame();
      verifyBadge(remote.sessionId, remoteSource.shareId, null);
      verifyBadge(remote.sessionId, 'remote-browser', 'normal');
      check(!root.querySelector('[data-kind="camera"] .stage-capture-mode-badge'), 'Camera tiles must not inherit a screen capture mode');
      check(!root.querySelector('.stage-pip-btn'), 'Locked broadcasts and ordinary camera tiles do not expose Picture-in-Picture');
      check(card(remote.sessionId, remoteSource.shareId).querySelector('.stage-viewers'),
        'Allowed non-watchers can see a remote screen audience');
      check(!root.querySelector('[data-kind="camera"] .stage-viewers'), 'Cameras do not acquire screen viewer badges');
      check(!modeCalls.some(([, id]) => id === 'remote-browser'), 'A legacy/browser share must not invent a native confirmation');

      const first = start();
      check(!card(local.sessionId, first.id) && focused().length === 0,
        'The early start event must wait for the local source to enter the roster');
      voice.addScreenShare(first.id);
      check(focused().join() === focusKey(first.id), 'The newly announced local preview must enter focus exactly once');
      verifyBadge(local.sessionId, first.id, null);
      check(card(remote.sessionId, remoteSource.shareId).classList.contains('stage-mini-card'), 'Remote status must also render in the mini strip');
      checkBadgeLayout();
      const focusedCard = card(local.sessionId, first.id);
      check(!focusedCard.querySelector('.stage-pip-btn'), 'The broadcaster preview never exposes viewer Picture-in-Picture');
      check(focusedCard.querySelector('.stage-viewers') && root.querySelector('.stage-mini-card .stage-viewers'),
        'Viewer lists are present on local, focused and mini screen cards');
      const focusedVideo = video(local.sessionId, first.id);
      const mountedVideos = [...root.querySelectorAll('video')].map(element => ({ element, stream: element.srcObject }));
      const previews = root.querySelector('#stage-participants-area');
      const previewNotice = root.querySelector('#stage-overlay-preview-notice');
      for (const [option, open] of [[false, false], [false, true], [true, false], [true, true], [false, true], [true, true], [true, false]]) {
        settings.overlayHideStagePreviews = option;
        overlayOpen = open;
        appEvents.emit('overlay_settings.updated');
        appEvents.emit('overlay.state_changed', open);
        const hidden = option && open;
        check((getComputedStyle(focusedVideo).visibility === 'hidden') === hidden && previews.inert === hidden,
          'Stage previews hide only for an actual open overlay, not an armed automatic overlay.');
        check(previewNotice.hidden !== hidden && previewNotice.textContent === language.t('overlay.stagePreviewsHidden'),
          'The hidden-preview explanation follows the selected language and visibility.');
        check(mountedVideos.every(({ element, stream }) => element.isConnected && element.srcObject === stream),
          'Toggling stage visibility never tears down or rebinds video streams.');
        check(getComputedStyle(root.querySelector('#stage-btn-mic')).visibility === 'visible'
          && !root.querySelector('.stage-call-controls').closest('[inert]'),
          'Call controls remain visible and interactive.');
      }
      settings.overlayHideStagePreviews = false;
      appEvents.emit('overlay_settings.updated');
      const bounds = focusedCard.getBoundingClientRect();
      const scroll = (target, deltaY, ctrlKey = false) => {
        const event = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true,
          clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 });
        target.dispatchEvent(event);
        return event;
      };
      check(scroll(focusedVideo, -100).defaultPrevented && stage.focusZoom.scale > 1
        && focusedVideo.style.transform.includes('scale('), 'Ordinary scroll zooms the focused screen without Ctrl');
      scroll(focusedVideo, 100);
      check(stage.focusZoom.scale === 1 && focusedVideo.style.transform === '', 'Ordinary scroll restores the unzoomed image');
      scroll(focusedVideo, -100, true);
      check(stage.focusZoom.scale > 1, 'Ctrl+scroll remains compatible');
      scroll(focusedVideo, 100);
      const controls = focusedCard.querySelector('.stage-card-controls');
      check(controls && !scroll(controls, -100).defaultPrevented && stage.focusZoom.scale === 1,
        'Scrolling focused card controls must not zoom the picture');
      card(local.sessionId, first.id).click();
      check(focused().length === 0, 'The publisher can unfocus the automatic preview');
      const localVideo = video(local.sessionId, first.id);
      const localBadge = badge(local.sessionId, first.id);
      const localStream = localVideo.srcObject;
      const placeholder = card(local.sessionId, first.id).querySelector('.stage-native-thumbnail');
      const thumbnail = placeholder.querySelector('img');
      for (const state of ['paused', 'waiting', 'paused', 'playing']) {
        previewStates.set(first.id, state);
        appEvents.emit('native_screen.updated');
        check(video(local.sessionId, first.id) === localVideo && localVideo.srcObject === localStream,
          'Changing the paused preview background must not replace its video or stream');
        check(placeholder.hidden === (state === 'playing'), 'Resuming preview must reveal the live video');
        check((getComputedStyle(thumbnail).display === 'none') === (state === 'paused'),
          'Only paused previews must hide the frozen thumbnail');
        if (state === 'paused') {
          check(getComputedStyle(placeholder).backgroundColor === 'rgb(0, 0, 0)',
            'Paused preview must have a fully opaque black background');
          check(placeholder.querySelector('span').textContent === language.t('stage.nativePreviewPaused'),
            'The pause message must remain visible in the selected language');
        }
      }
      modes.set(modeKey(local.sessionId, first.id), 'game');
      previewStates.set(first.id, 'playing');
      for (let i = 0; i < 5; i++) appEvents.emit('native_screen.updated');
      verifyBadge(local.sessionId, first.id, 'game');
      check(video(local.sessionId, first.id) === localVideo && localVideo.srcObject === localStream
        && badge(local.sessionId, first.id) === localBadge, 'Mode updates must preserve the video, stream and badge node identities');
      check(focused().length === 0 && card(local.sessionId, first.id).querySelector('.stage-native-thumbnail').hidden,
        'Frames becoming ready must update the placeholder without refocusing the preview');
      modes.set(modeKey(local.sessionId, first.id), 'normal');
      appEvents.emit('native_screen.updated');
      verifyBadge(local.sessionId, first.id, 'normal');
      check(focused().length === 0 && video(local.sessionId, first.id) === localVideo,
        'Game to Normal fallback must neither recreate the video nor override manual unfocus');
      modes.delete(modeKey(local.sessionId, first.id));
      appEvents.emit('native_screen.updated');
      verifyBadge(local.sessionId, first.id, null);
      modes.set(modeKey(local.sessionId, first.id), 'game');
      modes.set(modeKey(remote.sessionId, remoteSource.shareId), 'game');
      card(remote.sessionId, remoteSource.shareId).querySelector('.stage-watch-btn').click();
      verifyBadge(local.sessionId, first.id, 'game');
      verifyBadge(remote.sessionId, remoteSource.shareId, 'game');
      check(card(remote.sessionId, remoteSource.shareId).querySelector('.stage-pip-btn')
        && !document.querySelector('[data-kind="camera"] .stage-pip-btn')
        && !card(local.sessionId, first.id).querySelector('.stage-pip-btn'),
      'Picture-in-Picture is limited to viewers of live screen broadcasts');
      document.pictureInPictureEnabled = false;
      stage.renderParticipants();
      check(!root.querySelector('.stage-pip-btn'), 'Picture-in-Picture stays hidden when Chromium reports it unavailable');
      document.pictureInPictureEnabled = true;
      stage.renderParticipants();
      const remoteVideo = video(remote.sessionId, remoteSource.shareId);
      const remoteStream = remoteVideo.srcObject;
      const remoteCard = card(remote.sessionId, remoteSource.shareId);
      const pipButton = remoteCard.querySelector('.stage-pip-btn');
      const pipStyle = getComputedStyle(pipButton);
      const fullscreenButton = remoteCard.querySelector('.stage-fullscreen-btn');
      const fullscreenStyle = getComputedStyle(fullscreenButton);
      check(['width', 'height', 'backgroundColor', 'color', 'borderRadius', 'borderWidth', 'cursor', 'backdropFilter']
        .every(property => pipStyle[property] === fullscreenStyle[property])
        && pipStyle.width === '32px' && pipStyle.height === '32px' && pipStyle.cursor === 'pointer',
      'Picture-in-Picture matches the size, dark background and clickable cursor of the other screen controls');
      const pipIcon = pipButton.querySelector('.material-symbols-outlined');
      const pipBounds = pipButton.getBoundingClientRect();
      const iconBounds = pipIcon.getBoundingClientRect();
      check(getComputedStyle(pipIcon).fontSize === getComputedStyle(fullscreenButton.querySelector('.material-symbols-outlined')).fontSize
        && getComputedStyle(pipIcon).cursor === 'pointer'
        && Math.abs(pipBounds.x + pipBounds.width / 2 - iconBounds.x - iconBounds.width / 2) < 1
        && Math.abs(pipBounds.y + pipBounds.height / 2 - iconBounds.y - iconBounds.height / 2) < 1,
      'The Picture-in-Picture glyph is centered, full-sized and retains the clickable cursor');
      pipButton.click();
      await settle();
      check(pipRequests.at(-1) === remoteVideo && remoteVideo.srcObject === remoteStream
        && !pipButton.disabled && !pipButton.hasAttribute('aria-busy'),
      'Manual Picture-in-Picture targets the watched broadcast without disturbing playback');
      rejectPip = true;
      pipButton.click();
      await settle();
      check(document.querySelector('.dialog-card')?.textContent.includes(language.t('stage.pictureInPictureErrorMessage')),
        'A rejected Picture-in-Picture request reports a localized error instead of failing silently');
      document.querySelector('.dialog-card [data-action="confirm"]').click();
      await new Promise(resolve => setTimeout(resolve, 400));
      rejectPip = false;
      fullscreen = remoteCard;
      for (const muted of [true, false, true, false]) {
        const state = participants.get(remote.sessionId).voiceState;
        participants.updateVoiceState({ ...state, isMuted: muted, isDeafened: muted, isSpeaking: !muted });
        appEvents.emit('participants.updated');
        voice.setMuted(muted);
        stage.renderParticipants();
        check(video(remote.sessionId, remoteSource.shareId) === remoteVideo && remoteVideo.srcObject === remoteStream,
          'Microphone/deafen metadata must not recreate or reattach a playing screen video');
        check(card(remote.sessionId, remoteSource.shareId) === remoteCard && remoteCard.isConnected
          && document.fullscreenElement === remoteCard, 'Audio metadata must preserve the fullscreen card');
        check(remoteCard.querySelector('.stage-badges-overlay').textContent.includes('mic_off') === muted,
          'Remote mute indicators must update without replacing the video');
      }
      fullscreen = null;
      for (const receiver of ['native', 'chromium']) {
        watchState = { state: 'unavailable', reason: 'connection-failed', receiver };
        appEvents.emit('native_screen.updated');
        const error = card(remote.sessionId, remoteSource.shareId).querySelector('.stage-native-error:not([data-ui-closing])');
        check(error?.textContent.includes(language.t('screenShare.nativeFailure.connection-failed')),
          'Receiver failures must remain visible in the selected language.');
        check(error.textContent.includes(language.t('screenShare.nativeReceiverSettingsHint')) === (receiver === 'native'),
          'Only native receiver errors suggest manually choosing Chromium in settings.');
        watchState = null;
        appEvents.emit('native_screen.updated');
        check(!card(remote.sessionId, remoteSource.shareId).querySelector('.stage-native-error:not([data-ui-closing])'),
          'A cleared failure must remove the obsolete receiver hint.');
      }
      watchState = { state: 'unavailable', reason: 'unsupported', receiver: 'chromium' };
      appEvents.emit('native_screen.updated');
      const unsupported = card(remote.sessionId, remoteSource.shareId).querySelector('.stage-native-error:not([data-ui-closing])');
      check(unsupported?.textContent.includes(language.t('screenShare.chromiumReceiverSettingsHint')),
        'Chromium codec rejections must point the viewer at the native receiver, not only the publisher.');
      check(!unsupported.textContent.includes(language.t('screenShare.nativeReceiverSettingsHint')),
        'The Chromium hint must not also suggest switching to Chromium.');
      watchState = null;
      appEvents.emit('native_screen.updated');
      card(remote.sessionId, remoteSource.shareId).querySelector('.stage-quality-button').click();
      card(remote.sessionId, remoteSource.shareId).querySelector('[data-screen-quality="480p30"]').click();
      modes.set(modeKey(remote.sessionId, remoteSource.shareId), 'normal');
      appEvents.emit('native_screen.updated');
      check(voice.getScreenQuality(remote.sessionId, remoteSource.shareId) === '480p30', 'Exercise the real viewer quality control');
      verifyBadge(remote.sessionId, remoteSource.shareId, 'normal');
      verifyBadge(local.sessionId, first.id, 'game');
      check(video(remote.sessionId, remoteSource.shareId) === remoteVideo && remoteVideo.srcObject === remoteStream,
        'A different confirmed receiver pipeline mode must not replace its video element');
      checkBadgeLayout();
      const overlay = card(remote.sessionId, remoteSource.shareId).querySelector('.telemetry-overlay');
      overlay.classList.remove('is-hidden');
      check(overlay.getBoundingClientRect().top >= badge(remote.sessionId, remoteSource.shareId).getBoundingClientRect().bottom,
        'Top-left telemetry must not cover the mode badge');
      overlay.classList.add('is-hidden');
      const callsBeforeNavigation = screenWatchCalls.length;
      stage.destroy();
      root.replaceChildren();
      check(voice.isWatchingScreen(remote.sessionId, remoteSource.shareId)
        && screenWatchCalls.length === callsBeforeNavigation && listenerCounts() === baselineListeners,
      'Leaving the stage preserves watching without adding subscriptions or listeners');

      const noticeHost = document.createElement('div');
      noticeHost.innerHTML = '<div id="screenshare-notice-slot"></div>';
      document.body.append(noticeHost);
      const mainView = new MainView(noticeHost);
      mainView.activeContentView = 'chat';
      mainView.updateScreenShareNotice();
      const notice = noticeHost.querySelector('#screenshare-viewer-stop-btn')?.closest('.screenshare-notice');
      check(notice?.querySelector('.screenshare-notice-text')?.textContent
        === (locale === 'pt-BR' ? 'Você está assistindo' : 'You are watching')
        && noticeHost.querySelector('#screenshare-viewer-stop-btn')?.textContent
        === (locale === 'pt-BR' ? 'Parar de assistir' : 'Stop watching'),
      'Navigating away shows the localized viewer status and stop affordance');

      stage = new VoiceStageView(root);
      stage.setChannel(channel.id);
      check(voice.isWatchingScreen(remote.sessionId, remoteSource.shareId)
        && !card(remote.sessionId, remoteSource.shareId).querySelector('.screen-locked')
        && screenWatchCalls.length === callsBeforeNavigation,
      'Re-entering the stage restores the viewer state without a duplicate subscription');
      stage.destroy();
      root.replaceChildren();
      noticeHost.querySelector('#screenshare-viewer-stop-btn').click();
      check(!voice.isWatchingScreen(remote.sessionId, remoteSource.shareId)
        && participants.get(remote.sessionId).voiceState.isScreenSharing
        && screenWatchCalls.at(-1)?.watching === false,
      'Stopping from the status affordance ends only the viewer subscription');
      noticeHost.remove();

      stage = new VoiceStageView(root);
      stage.setChannel(channel.id);
      check(card(remote.sessionId, remoteSource.shareId).querySelector('.screen-locked'),
        'Returning after stopping keeps the publisher live behind the viewer gate');
      verifyBadge(remote.sessionId, remoteSource.shareId, null);

      const camera = document.querySelector(`[data-tile-key="${remote.sessionId}:camera"] video`);
      const cameraStream = new MediaStream();
      participants.get(remote.sessionId).remoteStream = cameraStream;
      stage.renderParticipants();
      check(document.querySelector(`[data-tile-key="${remote.sessionId}:camera"] video`).srcObject === cameraStream
        && camera.srcObject === null, 'A real camera stream replacement must still retire the previous attachment');
      participants.get(remote.sessionId).remoteStream = undefined;
      stage.renderParticipants();
      check(document.querySelector(`[data-tile-key="${remote.sessionId}:camera"] video`).srcObject === null,
        'Removing a camera stream must not retain its obsolete media');

      notifyExports.notify({ shareId: '<img src=x onerror=bad()>' });
      const toast = document.querySelector('.chat-copy-toast');
      check(toast?.getAttribute('role') === 'status' && toast.getAttribute('aria-atomic') === 'true',
        'The actual fallback callback must use the accessible informational toast');
      check(toast.querySelector('.chat-copy-toast-label').textContent === language.t('screenShare.gameFallback')
        && toast.querySelector('.material-symbols-outlined').textContent === 'info',
      'Fallback announces a same-window attempt, not successful recovery');
      check(!document.querySelector('.dialog-card') && !toast.querySelector('img'), 'Fallback must not show a terminal modal or interpolate opaque source metadata');
      const toastBounds = toast.getBoundingClientRect();
      check(toastBounds.left >= 0 && toastBounds.right <= innerWidth + 1, 'The localized notice must fit the small viewport');
      notifyExports.notify({ shareId: first.id });
      check(document.querySelectorAll('.chat-copy-toast').length === 1, 'The shared toast helper must not stack duplicate notices');
      for (const clear of clearToasts.splice(0)) clear();

      clearShares();
      const a = start(), b = start();
      voice.addScreenShare(a.id);
      voice.addScreenShare(b.id);
      check(focused().join() === [focusKey(a.id), focusKey(b.id)].join(), 'Two early start intents must focus both sources, not lose the second intent');
      card(local.sessionId, a.id).click();
      appEvents.emit('local.screen_started', { shareId: a.id, stream: a });
      appEvents.emit('native_screen.updated');
      appEvents.emit('participants.updated');
      check(focused().join() === focusKey(b.id), 'Duplicate starts and roster/native updates must not rearm a consumed intent');
      const cancelled = start();
      stop(cancelled);
      voice.addScreenShare(cancelled.id);
      appEvents.emit('participants.updated');
      check(focused().join() === focusKey(b.id), 'A stopped source cannot acquire focus through a late roster update');
      voice.removeScreenShare(cancelled.id);
      const declined = start();
      card(local.sessionId, b.id).click();
      voice.addScreenShare(declined.id);
      appEvents.emit('participants.updated');
      check(focused().length === 0, 'A deliberate focus change must cancel a still-pending automatic intent');
      clearShares();

      participants.removeUser(local.sessionId);
      appEvents.emit('participants.updated');
      check(!participants.get(local.sessionId), 'The delayed-roster fixture must actually remove the local participant');
      const delayed = start();
      voice.addScreenShare(delayed.id);
      check(focused().length === 0, 'A valid share ID alone cannot focus a participant that has not appeared yet');
      announceParticipants();
      appEvents.emit('participants.updated');
      check(focused().join() === focusKey(delayed.id), 'The pending start must complete when its actual participant tile arrives');
      stage.destroy();
      check(listenerCounts() === baselineListeners, 'Destroy must remove the new start/stop/update listeners');
      stage = new VoiceStageView(root);
      stage.setChannel(channel.id);
      appEvents.emit('local.screen_started', { shareId: delayed.id, stream: delayed });
      appEvents.emit('native_screen.updated');
      check(focused().length === 0, 'Remounting or replaying an existing share must not refocus it');
      clearShares();

      const fullscreenA = start();
      voice.addScreenShare(fullscreenA.id);
      const beforeFullscreen = video(local.sessionId, fullscreenA.id);
      const beforeFullscreenStream = beforeFullscreen.srcObject;
      fullscreen = card(local.sessionId, fullscreenA.id);
      exitGate = deferred();
      const beforeExits = exitCalls;
      const fullscreenB = start();
      voice.addScreenShare(fullscreenB.id);
      await settle();
      check(exitCalls === beforeExits + 1 && focused().join() === focusKey(fullscreenA.id),
        'Adding a second focused preview must wait for native fullscreen exit even when the old key is retained');
      check(video(local.sessionId, fullscreenA.id) === beforeFullscreen && beforeFullscreen.srcObject === beforeFullscreenStream,
        'Fullscreen exit must retain the live video until its promise resolves');
      fullscreen = null;
      exitGate.resolve();
      await settle();
      check(focused().join() === [focusKey(fullscreenA.id), focusKey(fullscreenB.id)].join(),
        'Successful fullscreen exit commits both focused previews');

      fullscreen = card(local.sessionId, fullscreenA.id);
      exitGate = deferred();
      const cancelledFullscreen = start();
      voice.addScreenShare(cancelledFullscreen.id);
      await settle();
      stop(cancelledFullscreen);
      fullscreen = null;
      exitGate.resolve();
      await settle();
      check(!focused().includes(focusKey(cancelledFullscreen.id)), 'Stopping a source during fullscreen exit cancels its pending focus commit');
      appEvents.emit('participants.updated');

      fullscreen = card(local.sessionId, fullscreenA.id);
      exitGate = deferred();
      const staleFullscreen = start();
      voice.addScreenShare(staleFullscreen.id);
      await settle();
      stage.setFocusedTiles([]);
      fullscreen = null;
      exitGate.resolve();
      await settle();
      check(focused().length === 0, 'A later manual unfocus wins over an in-flight automatic fullscreen transition');
      clearShares();

      const protectedVideo = start();
      voice.addScreenShare(protectedVideo.id);
      fullscreen = card(local.sessionId, protectedVideo.id);
      const protectedElement = video(local.sessionId, protectedVideo.id);
      exitGate = deferred();
      const deniedFullscreen = start();
      voice.addScreenShare(deniedFullscreen.id);
      await settle();
      exitGate.reject(new Error('Expected device-free fullscreen refusal'));
      await settle();
      check(document.querySelector('.stage-focus-error[role="alert"]')?.textContent === language.t('stage.fullscreenExitError'),
        'A refused fullscreen exit must report the localized error');
      check(video(local.sessionId, protectedVideo.id) === protectedElement
        && focused().join() === focusKey(protectedVideo.id), 'Refused fullscreen exit must preserve the current preview and layout');
      check(stage.pendingScreenFocus.size === 0, 'A failed automatic focus attempt must not remain armed');
      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      appEvents.emit('voice.state_updated');
      appEvents.emit('native_screen.updated');
      appEvents.emit('participants.updated');
      check(focused().join() === focusKey(protectedVideo.id),
        'Later updates must not retry a previously refused automatic focus');
      stage.setFocusedTiles([]);
      clearShares();

      const telemetrySource = start();
      voice.addScreenShare(telemetrySource.id);
      const telemetryKey = focusKey(telemetrySource.id);
      const originalDiagnostics = rtc.getScreenVideoDiagnostics;
      const originalTelemetryTrack = stage.getTelemetryTrack;
      let telemetryTime = 0;
      let replacePreview = false;
      rtc.getScreenVideoDiagnostics = async (sessionId, shareId) => {
        if (sessionId !== local.sessionId || shareId !== telemetrySource.id) return null;
        if (replacePreview) {
          const preview = { id: crypto.randomUUID(), readyState: 'live' };
          stage.getTelemetryTrack = tile => tile.key === telemetryKey ? preview
            : originalTelemetryTrack.call(stage, tile);
          replacePreview = false;
        }
        telemetryTime += 1500;
        return { backend: 'native', source: captures.get(shareId).source, viewers: 1, endpoints: [{
          pipelineId: 'stable-native-publisher', profile, readErrors: 0, decoders: [], rtp: [{
            id: 'publisher', reports: [
              { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: telemetryTime,
                bytesSent: telemetryTime * 250, framesEncoded: telemetryTime * .06,
                framesSent: telemetryTime * .06, frameWidth: profile.width, frameHeight: profile.height,
                framesPerSecond: profile.fps, codecId: 'codec' },
              { id: 'codec', type: 'codec', mimeType: 'video/H264' },
            ],
          }],
        }] };
      };
      try {
        settings.screenShareTelemetryEnabled = true;
        stage.syncTelemetryMonitor();
        await settle();
        await stage.refreshTelemetry();
        const samplesBeforeRender = stage.telemetryHistory.get(telemetryKey)?.length;
        check(samplesBeforeRender >= 2, 'The native sender must collect multiple actual diagnostic samples');
        stage.render();
        await settle();
        check(stage.telemetryHistory.get(telemetryKey)?.length > samplesBeforeRender,
          'Repainting the same stage must not reset native sender telemetry to a single sample');
        const sample = stage.telemetrySnapshots.get(telemetryKey)?.streams[0]?.data;
        check(sample?.intervalMs === 1500 && sample.bitrateKbps === 2000,
          'Native RTP deltas must survive a DOM repaint of the unchanged publisher');
        replacePreview = true;
        await stage.refreshTelemetry();
        check(stage.telemetryHistory.get(telemetryKey)?.length > samplesBeforeRender + 1,
          'Replacing only the native local preview during an RTP read must not erase sender diagnostics');
        stage.getTelemetryTrack = originalTelemetryTrack;
        for (let i = 0; i < 22; i++) await stage.refreshTelemetry();
        await stage.copyTelemetry(telemetryKey, card(local.sessionId, telemetrySource.id).querySelector('.stage-diagnostics-btn'));
        const report = JSON.parse(copiedTelemetry);
        check(report.history.length === 20 && report.history.every(entry => entry.streams[0].data.bitrateKbps === 2000),
          'Copy must export the bounded 20-sample history with real RTP deltas, not only the last reading');
        const capture = captures.get(telemetrySource.id);
        capture.source = { ...capture.source, instanceId: crypto.randomUUID() };
        await stage.refreshTelemetry();
        check(stage.telemetryHistory.get(telemetryKey)?.length === 1,
          'A replaced native source must not inherit the previous source telemetry history');
        stage.setChannel('other-channel');
        check(stage.telemetryHistory.size === 0, 'Changing the displayed channel must clear diagnostic history');
        stage.setChannel(channel.id);
      } finally {
        settings.screenShareTelemetryEnabled = false;
        stage.syncTelemetryMonitor();
        check(stage.telemetryHistory.size === 0, 'Disabling telemetry must discard its diagnostic history');
        stage.getTelemetryTrack = originalTelemetryTrack;
        rtc.getScreenVideoDiagnostics = originalDiagnostics;
        clearShares();
      }

      const oldChannel = start();
      stage.setChannel('other-channel');
      voice.addScreenShare(oldChannel.id);
      stage.setChannel(channel.id);
      check(focused().length === 0 && stage.pendingScreenFocus.size === 0, 'Changing the displayed channel invalidates a pending start');
      clearShares();
      const endedCall = start();
      voice.setChannel(null);
      voice.addScreenShare(endedCall.id);
      appEvents.emit('participants.updated');
      check(focused().length === 0 && stage.pendingScreenFocus.size === 0, 'Leaving the call invalidates a start before any late state arrives');
      clearShares();
      voice.setChannel(channel.id, session.key);
      const destroyed = start();
      stage.destroy();
      voice.addScreenShare(destroyed.id);
      appEvents.emit('native_screen.updated');
      check(stage.pendingScreenFocus.size === 0 && listenerCounts() === baselineListeners, 'Destroy must retire pending intentions and event handlers');
      stage = null;
      for (const stream of [...streams.values()]) stop(stream);
      modes.clear();
      previewStates.clear();
      voice.setScreenSharing(false);
      voice.setChannel(null);
      document.body.replaceChildren();
    }
    check(mediaRequests === 0, 'The stage and toast regression must never request microphone, camera or screen capture');
    return checks;
  } finally {
    fullscreen = null;
    exitGate?.resolve();
    stage?.destroy();
    for (const clear of clearToasts) clear();
    voice.setScreenSharing(false);
    voice.setChannel(null);
    for (const reset of restore.reverse()) reset();
    language.setLanguage(originalLanguage);
    sessionManager.remove(session.key);
    document.body.replaceChildren();
  }
}
