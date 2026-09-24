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
  const denyMedia = async () => { mediaRequests++; throw new Error('The screen stage UI smoke cannot capture media.'); };
  replace(navigator.mediaDevices, 'getUserMedia', denyMedia);
  replace(navigator.mediaDevices, 'getDisplayMedia', denyMedia);

  const [{ VoiceStageView }, { voiceStore: voice }, { settingsStore: settings }, { serverStore: server },
    { participantManager: participants }, { appEvents }, { videoService }, { webRtcManager: rtc },
    { sessionManager }, language, { showInfoToast }] = await Promise.all([
    import('/views/VoiceStageView.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/stores/serverStore.ts'), import('/core/ParticipantManager.ts'), import('/core/EventBus.ts'),
    import('/core/VideoService.ts'), import('/core/WebRtcManager.ts'), import('/core/SessionManager.ts'),
    import('/i18n/index.ts'), import('/views/CopyToast.ts'),
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
  replace(rtc, 'setRemoteScreenWatching', (sessionId, shareId, watching) => {
    if (!watching) modes.delete(modeKey(sessionId, shareId));
    voice.setScreenWatching(sessionId, shareId, watching);
  });
  replace(settings, 'screenShareTelemetryEnabled', false);
  replace(settings, 'screenShareTelemetryPosition', 'top-left');
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
  };
  const start = () => {
    const stream = new MediaStream();
    streams.set(stream.id, stream);
    captures.set(stream.id, {
      desktopSourceId: `native-window:${stream.id}`, thumbnail: '',
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
      const focusedVideo = video(local.sessionId, first.id);
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
      const remoteVideo = video(remote.sessionId, remoteSource.shareId);
      const remoteStream = remoteVideo.srcObject;
      for (const receiver of ['native', 'chromium']) {
        watchState = { state: 'unavailable', reason: 'connection-failed', receiver };
        appEvents.emit('native_screen.updated');
        const error = card(remote.sessionId, remoteSource.shareId).querySelector('.stage-native-error');
        check(error?.textContent.includes(language.t('screenShare.nativeFailure.connection-failed')),
          'Receiver failures must remain visible in the selected language.');
        check(error.textContent.includes(language.t('screenShare.nativeReceiverSettingsHint')) === (receiver === 'native'),
          'Only native receiver errors suggest manually choosing Chromium in settings.');
        watchState = null;
        appEvents.emit('native_screen.updated');
        check(!card(remote.sessionId, remoteSource.shareId).querySelector('.stage-native-error'),
          'A cleared failure must remove the obsolete receiver hint.');
      }
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
      card(remote.sessionId, remoteSource.shareId).querySelector('.stage-stopwatch-btn').click();
      verifyBadge(remote.sessionId, remoteSource.shareId, null);

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
