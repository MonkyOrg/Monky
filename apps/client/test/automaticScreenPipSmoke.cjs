'use strict';

module.exports = { runAutomaticScreenPipSmoke };

async function runAutomaticScreenPipSmoke() {
  const [{ VoiceStageView }, { MainView }, { QualityTab }, { screenPictureInPicture: pip }, { sessionManager },
    { voiceStore: voice }, { settingsStore: settings }, { appEvents }, { webRtcManager: rtc }, language] =
    await Promise.all([
      import('/views/VoiceStageView.ts'), import('/views/MainView.ts'),
      import('/views/settings/tabs/QualityTab.ts'),
      import('/core/ScreenPictureInPicture.ts'), import('/core/SessionManager.ts'),
      import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
      import('/core/EventBus.ts'), import('/core/WebRtcManager.ts'), import('/i18n/index.ts'),
    ]);
  let checks = 0, mediaRequests = 0, nativePipRequests = 0, stage, pending = null, failRequest = false, openFails = false;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const until = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  };
  const restore = [];
  const replace = (object, key, value, getter = false) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, ...(getter ? { get: value } : { writable: true, value }) });
    restore.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : Reflect.deleteProperty(object, key));
  };
  const originalLanguage = language.getLanguage();
  const originalAutoPip = settings.screenShareAutoPictureInPicture;
  const originalSettings = localStorage.getItem('monky_settings');
  const requests = [];
  const popups = [];
  const mediaHandlers = new Map();
  let returns = 0;
  replace(navigator.mediaSession, 'setActionHandler', (action, handler) => {
    if (handler) mediaHandlers.set(action, handler);
    else mediaHandlers.delete(action);
  });
  replace(HTMLVideoElement.prototype, 'requestPictureInPicture', async () => {
    nativePipRequests++;
    throw new Error('Chromium Picture-in-Picture is not used');
  });
  // A same-origin frame stands in for the popup Main allows for the request.
  replace(window, 'open', (url, name, features) => {
    if (openFails) return null;
    const frame = document.createElement('iframe');
    document.documentElement.append(frame);
    const pagehide = [];
    const popup = {
      url, name, features, closed: false, document: frame.contentDocument,
      addEventListener: (type, listener) => { if (type === 'pagehide') pagehide.push(listener); },
      close() { popup.closed = true; frame.remove(); },
      // Alt+F4 or Windows closing the popup without its buttons.
      systemClose() { popup.close(); pagehide.forEach(listener => listener(new Event('pagehide'))); },
    };
    popups.push(popup);
    return popup;
  });
  const popup = () => popups.find(candidate => !candidate.closed) ?? null;
  const pipVideo = () => popup()?.document.querySelector('video') ?? null;
  const presenting = video => pip.isPresenting(video) && !!video.srcObject && pipVideo()?.srcObject === video.srcObject;
  const pipButton = action => popup().document.querySelector(`[data-action="${action}"]`);
  const closeFromPip = () => pipButton('close').click();
  const backToMonky = () => pipButton('back').click();
  const inactiveListeners = new Set();
  const activeListeners = new Set();
  const deactivateWindow = () => [...inactiveListeners].forEach(callback => callback());
  const activateWindow = () => [...activeListeners].forEach(callback => callback());
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 90;
  const context = canvas.getContext('2d');
  let frame = 0;
  const draw = setInterval(() => {
    context.fillStyle = ++frame % 2 ? 'blue' : 'orange';
    context.fillRect(0, 0, 160, 90);
  }, 50);
  const streams = [canvas.captureStream(20), canvas.captureStream(20)];
  replace(navigator.mediaDevices, 'getUserMedia', async () => { mediaRequests++; throw new Error('No device capture allowed'); });
  replace(navigator.mediaDevices, 'getDisplayMedia', async () => { mediaRequests++; throw new Error('No screen capture allowed'); });
  replace(window, 'api', { ...window.api, onWindowInactive: callback => {
    inactiveListeners.add(callback);
    return () => inactiveListeners.delete(callback);
  }, onWindowActive: callback => {
    activeListeners.add(callback);
    return () => activeListeners.delete(callback);
  }, returnFromScreenPictureInPicture: async () => { returns++; },
  openScreenPictureInPicture: async (requestId, requireInactive, aspectRatio) => {
    requests.push({ requestId, requireInactive, aspectRatio });
    if (failRequest) throw new Error('Expected automatic PiP rejection');
    return pending ? await pending.promise : true;
  } });
  replace(rtc, 'getScreenViewers', async () => []);
  replace(rtc, 'getAverageP2pPing', async () => 0);
  const session = sessionManager.create('automatic-pip-ui.test', 7890, 'PiP fixture');
  replace(session.client, 'send', () => {});
  sessionManager.activate(session.key);
  const local = { id: 'pip-local', sessionId: 'pip-local-session', nickname: 'Local', status: 'ONLINE', joinedAt: 1 };
  const remote = { ...local, id: 'pip-remote', sessionId: 'pip-remote-session', nickname: 'Remote' };
  const channel = { id: 'pip-channel', name: 'PiP channel', type: 'VOICE', position: 0, permissionOverwrites: [] };
  const keys = ['screen-a', 'screen-b'].map(id => `${remote.sessionId}:screen:${id}`);
  const setup = async () => {
    session.serverStore.setServerDetails({
      id: 'pip-server', name: 'PiP fixture', createdAt: 1, maxUsers: 10, voiceStates: {},
      protocol: { version: 36, minimumVersion: 29, features: ['screen-viewers'] },
      channels: [channel], members: [local, remote], knownMembers: [local, remote],
      roles: [], userRoles: [], myPermissions: 2147483647, ownerId: local.id,
    }, local);
    voice.setChannel(channel.id, session.key);
    session.participants.setUsers([local, remote]);
    for (const user of [local, remote]) session.participants.updateVoiceState({
      userId: user.id, sessionId: user.sessionId, channelId: channel.id,
      isSpeaking: false, isMuted: false, isDeafened: false, isCameraOn: false,
      isScreenSharing: user === remote, screenShareIds: user === remote ? ['screen-a', 'screen-b'] : [],
    });
    for (const [index, id] of ['screen-a', 'screen-b'].entries()) {
      session.participants.get(remote.sessionId).remoteScreenStreams.set(id, streams[index]);
      voice.setScreenWatching(remote.sessionId, id, true);
    }
    stage?.destroy();
    document.body.innerHTML = '<div id="pip-fixture" style="height:700px;width:1000px"></div>';
    stage = new VoiceStageView(document.getElementById('pip-fixture'));
    stage.setChannel(channel.id);
    stage.setFocusedTiles(keys);
    await until(() => [...document.querySelectorAll('video.screen-share')].length === 2
      && [...document.querySelectorAll('video.screen-share')].every(video => video.readyState >= 2), 'Synthetic screens must play');
  };
  const selected = () => document.querySelector(`[data-tile-key="${keys[1]}"] video`);
  const placeholderFor = key => document.querySelector(`[data-tile-key="${key}"] .stage-pip-placeholder`);
  const placeholder = () => placeholderFor(keys[1]);
  const mountStage = (channelId = channel.id) => {
    stage = new VoiceStageView(document.getElementById('pip-fixture'));
    stage.setChannel(channelId);
  };
  try {
    for (const locale of ['pt-BR', 'en']) {
      language.setLanguage(locale);
      settings.screenShareAutoPictureInPicture = true;
      const tab = new QualityTab();
      // Encoder discovery is independent of this preference and must not access hardware.
      replace(tab.encoding, 'attach', () => {});
      const settingsRoot = document.createElement('div');
      settingsRoot.innerHTML = tab.renderHtml();
      document.body.append(settingsRoot);
      tab.attachEvents(settingsRoot);
      const toggle = settingsRoot.querySelector('#checkbox-screen-auto-pip');
      check(toggle.checked && toggle.closest('.toggle-switch')
        && settingsRoot.querySelector('[data-settings-section="screen-pip"]').dataset.settingsLabel === language.t('settings.screenAutoPipLabel'),
      'Automatic PiP defaults on in the localized standard switch');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      check(settings.screenShareAutoPictureInPicture === false
        && JSON.parse(localStorage.getItem('monky_settings')).screenShareAutoPictureInPicture === false,
      'The actual quality settings listener persists the disabled preference');
      settings.load();
      check(settings.screenShareAutoPictureInPicture === false, 'Preference hydration preserves explicit false');
      const stored = JSON.parse(localStorage.getItem('monky_settings'));
      delete stored.screenShareAutoPictureInPicture;
      localStorage.setItem('monky_settings', JSON.stringify(stored));
      settings.load();
      check(settings.screenShareAutoPictureInPicture === true, 'Existing profiles without the preference opt in by default');
      tab.cleanup();
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      check(settings.screenShareAutoPictureInPicture === true, 'Detached switches cannot mutate preferences');
      settingsRoot.remove();
      await setup();
      const latest = selected();
      const before = requests.length;
      let resolve;
      pending = { promise: new Promise(done => { resolve = done; }) };
      stage.openAutomaticPictureInPicture();
      deactivateWindow();
      stage.openAutomaticPictureInPicture();
      check(requests.length === before + 1 && requests.at(-1).requireInactive === false
        && Math.abs(requests.at(-1).aspectRatio - 160 / 90) < 1e-9 && popups.every(candidate => candidate.closed),
      'Concurrent navigation/minimize requests ask Main once, with the broadcast aspect, before any window exists');
      const main = new MainView(document.getElementById('pip-fixture'));
      main.voiceStageView = stage;
      main.activeContentView = 'stage';
      main.setActiveContentView('chat');
      check(latest.isConnected && latest.closest('.screen-pip-host') && latest.srcObject === streams[1],
        'Leaving the stage preserves the original playing video even while PiP is opening');
      check(!latest.id && document.querySelectorAll('.screen-pip-host').length === 1,
        'Retained video cannot collide with the next stage DOM IDs');
      resolve(true); pending = null;
      await until(() => document.querySelector('.chat-copy-toast')?.textContent.includes(language.t('stage.automaticPictureInPicture')),
        'Successful automatic PiP must announce the localized action and settings path');
      check(presenting(latest) && !latest.paused, 'Navigation shows the most recently focused broadcast without new capture');
      const shown = popup();
      check(shown.name === `monky-screen-pip-${requests.at(-1).requestId}` && shown.url === '' && shown.features === 'popup'
        && shown.document.title === language.t('stage.pictureInPictureWindowTitle', { name: remote.nickname })
        && shown.document.documentElement.lang === document.documentElement.lang
        && pipButton('back').getAttribute('aria-label') === language.t('stage.pictureInPictureReturn')
        && pipButton('back').title === language.t('stage.pictureInPictureReturn')
        && pipButton('close').getAttribute('aria-label') === language.t('common.close')
        && pipVideo().muted && pipVideo().disablePictureInPicture,
      'The PiP window is the authorized popup, titled after the broadcaster, with localized controls');
      await until(() => pipVideo()?.getVideoPlaybackQuality().totalVideoFrames > 2, 'The PiP window must render broadcast frames');
      activateWindow();
      check(presenting(latest), 'Returning to the window while in chat must keep PiP open');
      mountStage();
      check(!popup() && shown.closed && selected() === latest && !document.querySelector('.screen-pip-host'),
        'Returning to the call stage closes PiP and reuses the original video without a retained host');
      check(stage.focusedTileKeys.join() === keys.join() && latest.srcObject === streams[1] && !latest.paused,
        'Both focused tiles and uninterrupted playback survive stage navigation');
      const frames = latest.getVideoPlaybackQuality().totalVideoFrames;
      await until(() => latest.getVideoPlaybackQuality().totalVideoFrames > frames,
        'The restored original video must continue producing frames');
      stage.openAutomaticPictureInPicture();
      await until(() => presenting(latest), 'PiP must reopen after returning to the stage');
      const reopened = pipVideo();
      stage.destroy();
      voice.setScreenWatching(remote.sessionId, 'screen-b', false);
      check(latest.srcObject === null && reopened.srcObject === null && !document.querySelector('.screen-pip-host') && !popup(),
        'Stopping a background subscription immediately blanks and closes PiP');

      await setup();
      settings.screenShareAutoPictureInPicture = false;
      const disabled = requests.length;
      stage.openAutomaticPictureInPicture();
      deactivateWindow();
      check(requests.length === disabled, 'Disabled preference blocks navigation and minimize');
      const manualVideo = selected();
      manualVideo.closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
      await until(() => presenting(manualVideo), 'Manual PiP must remain available when automatic PiP is disabled');
      check(requests.at(-1).requireInactive === false, 'Manual PiP opens while Monky is on screen');
      const miniTile = placeholder()?.closest('[data-tile-key]');
      check(!selected() && miniTile?.classList.contains('stage-mini-card')
        && placeholder().classList.contains('stage-pip-placeholder--mini')
        && miniTile.querySelector('.stage-pip-return-btn')?.getAttribute('aria-label') === language.t('stage.pictureInPictureBringBackLabel')
        && !miniTile.querySelector('.stage-pip-btn, .stage-fullscreen-btn, .stage-loading-overlay')
        && miniTile.querySelector('.stage-stopwatch-btn') && stage.focusedTileKeys.join() === keys[0],
      'Manual PiP takes the broadcast off the stage and out of focus, leaving a localized bring-back placeholder');
      check(manualVideo.closest('.screen-pip-host') && !manualVideo.paused && manualVideo.srcObject === streams[1],
        'The stage video keeps playing hidden while the manual PiP shows it');
      placeholder().click();
      miniTile.querySelector('.stage-badges-overlay').click();
      check(stage.focusedTileKeys.join() === keys[0], 'The PiP placeholder cannot be focused back onto the stage');
      activateWindow();
      stage.render();
      stage.setChannel(channel.id);
      check(presenting(manualVideo) && !selected() && placeholder(), 'Manual PiP must not close on incidental focus or stage rerenders');
      stage.openAutomaticPictureInPicture();
      stage.destroy();
      mountStage();
      check(presenting(manualVideo) && !selected()
        && placeholder()?.querySelector('.stage-pip-placeholder-text')?.textContent === language.t('stage.pictureInPictureShowing')
        && placeholder().querySelector('.stage-pip-return-btn').textContent.includes(language.t('stage.pictureInPictureBringBack')),
      'Manual PiP persists through stage navigation and the grid shows its localized placeholder');
      placeholder().querySelector('.stage-pip-return-btn').click();
      check(!popup() && selected() === manualVideo && !manualVideo.paused && manualVideo.srcObject === streams[1]
        && !document.querySelector('.screen-pip-host') && stage.focusedTileKeys.join() === keys[1],
      'Bring back returns the same live video to the stage, focused as when PiP opened');
      const manualBack = selected();
      manualBack.closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
      await until(() => presenting(manualBack) && placeholder(), 'Manual PiP reopens from the restored tile');
      const manualReturns = returns;
      const offManualReturn = appEvents.on('screen_pip.return_to_call', call => stage.setChannel(call.channelId));
      backToMonky();
      offManualReturn();
      check(returns === manualReturns + 1 && !popup() && selected() === manualBack && !manualBack.paused
        && stage.focusedTileKeys.join() === keys[1],
      'Back to Monky also returns a manual PiP broadcast to the stage');
      settings.screenShareAutoPictureInPicture = true;

      const gridRequests = requests.length;
      stage.setFocusedTiles([]);
      stage.openAutomaticPictureInPicture();
      check(requests.length === gridRequests, 'Watching a screen in the grid is not focus consent for automatic PiP');
      stage.setFocusedTiles(keys);
      await until(() => selected()?.readyState >= 2, 'Refocused screen must be ready');
      deactivateWindow();
      await until(() => presenting(selected()), 'Minimizing the window opens the focused screen');
      check(requests.at(-1).requireInactive === true, 'Window events require Main to verify the window actually left the screen');
      const inactiveVideo = selected();
      stage.setChannel(channel.id);
      check(presenting(inactiveVideo), 'An inactive stage refresh must not close PiP');
      activateWindow();
      check(!popup() && selected() === inactiveVideo && stage.focusedTileKeys.join() === keys.join(),
        'Native window return closes PiP and preserves the most recently focused broadcast');
      deactivateWindow();
      await until(() => presenting(selected()), 'A second inactivity cycle must reopen PiP');
      const revoked = selected();
      const revokedPip = pipVideo();
      session.serverStore.myPermissions = 0;
      appEvents.emit('server.roles_updated');
      check(revoked.srcObject === null && revokedPip.srcObject === null && !popup(), 'Permission revocation immediately blanks PiP');
      activateWindow();
      check(revoked.srcObject === null && !pip.getStageReturn(session.key, channel.id),
        'Window return cannot resurrect a revoked source');

      await setup();
      deactivateWindow();
      await until(() => presenting(selected()), 'Automatic PiP opens on the first inactive event');
      const dismissedReturns = returns;
      closeFromPip();
      check(returns === dismissedReturns && !popup() && !selected().paused && selected().srcObject === streams[1],
        'The PiP close button keeps Monky away and the stage broadcast stays live');
      const dismissedRequests = requests.length;
      stage.render();
      stage.setChannel(channel.id);
      // Re-rendering rebuilds the video, and automatic PiP skips a video with no
      // frame yet (#766). Without this wait, "no popup" below could pass because
      // the video was not ready rather than because the dismissal suppressed it,
      // and a slow runner would make the next departure skip PiP for good.
      await until(() => selected()?.readyState >= 2, 'The re-rendered screen must be ready before testing suppression');
      deactivateWindow();
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(resolve => setTimeout(resolve, 20));
      check(!popup() && requests.length === dismissedRequests,
        'Closing automatic PiP must suppress duplicate inactive notifications until the next window visit');
      activateWindow();
      check(!popup() && requests.length === dismissedRequests,
        'Returning after dismissal must not flash a newly opened PiP');
      deactivateWindow();
      await until(() => presenting(selected()), 'A new window departure may automatically open PiP again');
      activateWindow();

      await setup();
      const persistentManual = selected();
      persistentManual.closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
      await until(() => presenting(persistentManual), 'A manual PiP opens before changing window focus');
      const persistentPopup = popup();
      const manualRequests = requests.length;
      deactivateWindow();
      activateWindow();
      deactivateWindow();
      check(presenting(persistentManual) && popup() === persistentPopup && requests.length === manualRequests,
        'Manual PiP survives focus on its window, the main window and minimization without reopening');
      activateWindow();
      check(presenting(persistentManual) && !persistentManual.paused && placeholder()
        && stage.focusedTileKeys.join() === keys[0],
      'Restoring the app does not override an explicitly opened manual PiP');
      check(mediaHandlers.size === 0 && nativePipRequests === 0,
        'Monky PiP owns its buttons: no Chromium PiP or media session play/pause controls');
      persistentPopup.systemClose();
      check(!popup() && !pip.isPresenting(persistentManual) && !persistentManual.paused
        && persistentManual.srcObject === streams[1] && !pip.getStageReturn(session.key, channel.id),
      'Closing the PiP window from the system dismisses it and keeps the stage broadcast');
      check(selected() === persistentManual && !placeholder() && !document.querySelector('.screen-pip-host')
        && stage.focusedTileKeys.join() === keys.join(),
      'Closing a manual PiP returns its broadcast to the stage and restores its focus');

      const switchedKey = `${remote.sessionId}:screen:screen-c`;
      const switchedTile = () => document.querySelector(`[data-tile-key="${switchedKey}"]`);
      for (const mode of ['none', 'automatic', 'manual']) {
        await setup();
        voice.reconcileScreenShares(new Map([[remote.sessionId, ['screen-a', 'screen-b']]]));
        const switching = selected();
        if (mode === 'manual') {
          switching.closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
          await until(() => presenting(switching) && placeholder() && stage.focusedTileKeys.join() === keys[0],
            'A manual PiP takes the focused broadcast off the stage before the source switch');
        } else if (mode === 'automatic') {
          deactivateWindow();
          await until(() => presenting(switching), 'Automatic PiP opens before the source switch');
        }
        // The publisher replaces the source: screen-b retires and screen-c is new.
        const switched = canvas.captureStream(20);
        const participant = session.participants.get(remote.sessionId);
        participant.remoteScreenStreams.delete('screen-b');
        participant.remoteScreenStreams.set('screen-c', switched);
        session.participants.updateVoiceState({ ...participant.voiceState, screenShareIds: ['screen-a', 'screen-c'] });
        voice.reconcileScreenShares(new Map([[remote.sessionId, ['screen-a', 'screen-c']]]));
        stage.renderParticipants();
        await until(() => switchedTile()?.querySelector('video')?.readyState >= 2, `${mode}: switched source plays`);
        const switchedVideo = switchedTile().querySelector('video');
        check(voice.isWatchingScreen(remote.sessionId, 'screen-c') && !voice.isWatchingScreen(remote.sessionId, 'screen-b')
          && switchedVideo.srcObject === switched && !switchedVideo.paused && !switchedTile().querySelector('.stage-pip-placeholder'),
        `${mode}: a source switch keeps the viewer watching the new source without a click`);
        check(!popup() && stage.focusedTileKeys.join() === `${keys[0]},${switchedKey}`,
          `${mode}: the new source takes over the focus of the switched one`);
        activateWindow();
        voice.setScreenWatching(remote.sessionId, 'screen-c', false);
        switched.getTracks().forEach(track => track.stop());
      }

      await setup();
      const replaced = selected();
      replaced.closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
      await until(() => presenting(replaced) && stage.focusedTileKeys.join() === keys[0], 'First manual PiP opens');
      const replacing = document.querySelector(`[data-tile-key="${keys[0]}"] video`);
      replacing.closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
      await until(() => presenting(replacing) && placeholderFor(keys[0]), 'A second manual PiP replaces the first');
      check(selected() && !selected().paused && selected().srcObject === streams[1] && !placeholder()
        && replaced.srcObject === null && document.querySelectorAll('.screen-pip-host').length === 1
        && stage.focusedTileKeys.join() === keys[1],
      'The broadcast a new manual PiP replaced returns to the stage in its previous focus');
      closeFromPip();
      check(!popup() && stage.focusedTileKeys.join() === keys.slice().reverse().join(),
        'Closing the replacing PiP returns its broadcast to focus as well');

      await setup();
      deactivateWindow();
      await until(() => presenting(selected()), 'Minimizing opens PiP before back to Monky');
      const backVideo = selected();
      const returnedBefore = returns;
      const destinations = [];
      const offReturn = appEvents.on('screen_pip.return_to_call', call => {
        destinations.push(`${call.sessionKey}/${call.channelId}`);
        stage.setChannel(call.channelId);
      });
      backToMonky();
      offReturn();
      check(returns === returnedBefore + 1 && destinations.join() === `${session.key}/${channel.id}`,
        'Back to Monky brings the minimized Monky window forward on the call');
      check(!popup() && selected() === backVideo && !backVideo.paused && stage.focusedTileKeys.join() === keys.join()
        && !pip.getStageReturn(session.key, channel.id),
      'Back to Monky keeps the same live broadcast focused on the stage');
      activateWindow();

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => presenting(selected()), 'Leaving the stage opens PiP before back to Monky');
      const awayVideo = selected();
      stage.destroy();
      check(awayVideo.closest('.screen-pip-host'), 'The away presentation is retained outside the stage');
      const offAway = appEvents.on('screen_pip.return_to_call', () => mountStage());
      backToMonky();
      offAway();
      check(returns === returnedBefore + 2 && !popup() && selected() === awayVideo && !awayVideo.paused
        && awayVideo.srcObject === streams[1] && !document.querySelector('.screen-pip-host'),
      'Back to Monky from another view returns to the call stage without restarting playback');

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => presenting(selected()), 'Leaving the stage opens PiP before closing it');
      const closedAway = selected();
      stage.destroy();
      closeFromPip();
      check(returns === returnedBefore + 2 && closedAway.srcObject === null && !document.querySelector('.screen-pip-host') && !popup(),
        'Closing away PiP neither navigates nor keeps background media');
      mountStage();

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => !!popup(), 'PiP must open before previewing another channel');
      const previewVideo = selected();
      stage.setChannel('other-preview-channel');
      activateWindow();
      check(presenting(previewVideo), 'Viewing another voice stage must not close the call PiP');
      stage.setChannel(channel.id);
      check(!popup() && selected() === previewVideo && stage.focusedTileKeys.join() === keys.join(),
        'Returning from another voice stage restores the original focus');

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => !!popup(), 'PiP must open before call departure');
      const departing = selected();
      voice.setChannel(null);
      check(departing.srcObject === null && !popup(), 'Leaving the call invalidates the presentation');

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => !!popup(), 'PiP must open before background navigation');
      const backgroundVideo = selected();
      stage.destroy();
      const other = sessionManager.create('other-pip-ui.test', 7891, 'Other server');
      sessionManager.activate(other.key);
      mountStage();
      activateWindow();
      appEvents.emit('participants.updated');
      check(presenting(backgroundVideo) && backgroundVideo.srcObject === streams[1],
        'PiP authority follows the call session, not the foreground server');
      streams[1].getVideoTracks()[0].dispatchEvent(new Event('ended'));
      check(!popup() && backgroundVideo.srcObject === null && !document.querySelector('.screen-pip-host'),
        'An ended track closes background PiP without a mounted stage');
      sessionManager.activate(session.key);
      sessionManager.remove(other.key);

      await setup();
      let finishReturn;
      pending = { promise: new Promise(done => { finishReturn = done; }) };
      stage.openAutomaticPictureInPicture();
      const returningVideo = selected();
      stage.destroy();
      mountStage();
      check(selected() === returningVideo && !returningVideo.paused && !document.querySelector('.screen-pip-host'),
        'Returning during opening immediately restores the original focused video');
      finishReturn(true); pending = null;
      await new Promise(resolve => setTimeout(resolve, 20));
      check(!popup() && selected() === returningVideo && returningVideo.srcObject === streams[1]
        && !document.querySelector('.chat-copy-toast'),
      'A late opening after stage return cannot leave PiP open or announce a stale automatic action');

      await setup();
      let finish;
      pending = { promise: new Promise(done => { finish = done; }) };
      stage.openAutomaticPictureInPicture();
      const cancelled = selected();
      voice.setScreenWatching(remote.sessionId, 'screen-b', false);
      finish(true); pending = null;
      await new Promise(resolve => setTimeout(resolve, 20));
      check(cancelled.srcObject === null && !popup() && !document.querySelector('.screen-pip-host'),
        'Revocation during an in-flight request cannot resurrect media');

      await setup();
      failRequest = true;
      stage.openAutomaticPictureInPicture();
      await until(() => document.querySelector('.chat-copy-toast--danger')?.textContent.includes(language.t('stage.pictureInPictureErrorMessage')),
        'Automatic PiP failures must have localized visible feedback');
      check(selected().srcObject === streams[1] && !selected().paused, 'A PiP opening failure must not interrupt stage playback');
      failRequest = false;

      await setup();
      openFails = true;
      const previousToast = document.querySelector('.chat-copy-toast--danger');
      stage.openAutomaticPictureInPicture();
      await until(() => {
        const toast = document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
        return toast && toast !== previousToast && toast.textContent.includes(language.t('stage.pictureInPictureErrorMessage'));
      }, 'A popup Main refuses must be reported like any other PiP failure');
      check(!popup() && !pip.isPresenting(selected()) && selected().srcObject === streams[1] && !selected().paused,
        'A refused popup leaves no presentation behind and keeps the stage playing');
      openFails = false;
      pip.close();
      stage.destroy();
      check(activeListeners.size === 0 && inactiveListeners.size === 0,
        'Retiring PiP and destroying the stage must release all native activity listeners');
      voice.setChannel(null);
    }
    check(mediaRequests === 0, 'Automatic PiP never captures the desktop, camera or microphone');
    return checks;
  } finally {
    pip.close();
    stage?.destroy();
    voice.setChannel(null);
    sessionManager.remove(session.key);
    clearInterval(draw);
    streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    settings.screenShareAutoPictureInPicture = originalAutoPip;
    if (originalSettings === null) localStorage.removeItem('monky_settings');
    else localStorage.setItem('monky_settings', originalSettings);
    language.setLanguage(originalLanguage);
    restore.reverse().forEach(undo => undo());
    popups.forEach(candidate => candidate.close());
    document.body.replaceChildren();
  }
}
