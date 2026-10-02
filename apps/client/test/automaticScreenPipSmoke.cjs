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
  let checks = 0, mediaRequests = 0, stage, pipElement = null, pending = null, failRequest = false;
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
  replace(document, 'pictureInPictureEnabled', true);
  replace(document, 'pictureInPictureElement', () => pipElement, true);
  replace(document, 'exitPictureInPicture', async () => {
    const previous = pipElement;
    pipElement = null;
    previous?.dispatchEvent(new Event('leavepictureinpicture'));
  });
  replace(HTMLVideoElement.prototype, 'requestPictureInPicture', async function () {
    pipElement = this;
    return {};
  });
  replace(window, 'api', { ...window.api, onWindowInactive: callback => {
    inactiveListeners.add(callback);
    return () => inactiveListeners.delete(callback);
  }, onWindowActive: callback => {
    activeListeners.add(callback);
    return () => activeListeners.delete(callback);
  }, openScreenPictureInPicture: async (requestId, requireInactive) => {
    const video = document.querySelector(`video[data-monky-screen-pip="${requestId}"]`);
    requests.push({ video, requireInactive });
    if (failRequest) throw new Error('Expected automatic PiP rejection');
    const opened = pending ? await pending.promise : true;
    if (opened) pipElement = video;
    return opened;
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
      protocol: { version: 35, minimumVersion: 29, features: ['screen-viewers'] },
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
      check(requests.length === before + 1 && requests.at(-1).video === latest,
        'Concurrent navigation/blur requests choose the most recently focused screen only once');
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
      check(pipElement === latest && !latest.paused, 'Navigation retains PiP playback without new capture');
      activateWindow();
      check(pipElement === latest, 'Returning to the window while in chat must keep PiP open');
      mountStage();
      check(pipElement === null && selected() === latest && !document.querySelector('.screen-pip-host'),
        'Returning to the call stage closes PiP and reuses the original video without a retained host');
      check(stage.focusedTileKeys.join() === keys.join() && latest.srcObject === streams[1] && !latest.paused,
        'Both focused tiles and uninterrupted playback survive stage navigation');
      const frames = latest.getVideoPlaybackQuality().totalVideoFrames;
      await until(() => latest.getVideoPlaybackQuality().totalVideoFrames > frames,
        'The restored original video must continue producing frames');
      stage.openAutomaticPictureInPicture();
      await until(() => pipElement === latest, 'PiP must reopen after returning to the stage');
      stage.destroy();
      voice.setScreenWatching(remote.sessionId, 'screen-b', false);
      check(latest.srcObject === null && !document.querySelector('.screen-pip-host') && pipElement === null,
        'Stopping a background subscription immediately blanks and retires PiP');

      await setup();
      settings.screenShareAutoPictureInPicture = false;
      const disabled = requests.length;
      stage.openAutomaticPictureInPicture();
      deactivateWindow();
      check(requests.length === disabled, 'Disabled preference blocks navigation and blur');
      selected().closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
      await until(() => pipElement === selected(), 'Manual PiP must remain available when automatic PiP is disabled');
      const manualVideo = pipElement;
      activateWindow();
      stage.render();
      stage.setChannel(channel.id);
      check(pipElement === manualVideo, 'Manual PiP must not close on incidental focus or stage rerenders');
      stage.openAutomaticPictureInPicture();
      stage.destroy();
      mountStage();
      check(pipElement === null && selected() === manualVideo && selected().srcObject === streams[1],
        'Returning after leaving the stage also restores manual PiP with automatic PiP disabled');
      settings.screenShareAutoPictureInPicture = true;

      stage.setFocusedTiles([]);
      stage.openAutomaticPictureInPicture();
      check(requests.length === disabled, 'Watching a screen in the grid is not focus consent for automatic PiP');
      stage.setFocusedTiles(keys);
      await until(() => selected()?.readyState >= 2, 'Refocused screen must be ready');
      deactivateWindow();
      await until(() => pipElement === selected(), 'Window blur opens the focused screen');
      check(requests.at(-1).requireInactive === true, 'Window events require Main to verify actual app inactivity');
      const inactiveVideo = pipElement;
      stage.setChannel(channel.id);
      check(pipElement === inactiveVideo, 'An inactive stage refresh must not close PiP');
      activateWindow();
      check(pipElement === null && selected() === inactiveVideo && stage.focusedTileKeys.join() === keys.join(),
        'Native window return closes PiP and preserves the most recently focused broadcast');
      deactivateWindow();
      await until(() => pipElement === selected(), 'A second inactivity cycle must reopen PiP');
      const revoked = selected();
      session.serverStore.myPermissions = 0;
      appEvents.emit('server.roles_updated');
      check(revoked.srcObject === null && pipElement === null, 'Permission revocation immediately blanks PiP');
      activateWindow();
      check(revoked.srcObject === null && !pip.getStageReturn(session.key, channel.id),
        'Window return cannot resurrect a revoked source');

      await setup();
      deactivateWindow();
      await until(() => pipElement === selected(), 'Automatic PiP opens on the first inactive event');
      await document.exitPictureInPicture();
      const dismissedRequests = requests.length;
      stage.render();
      stage.setChannel(channel.id);
      deactivateWindow();
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(resolve => setTimeout(resolve, 20));
      check(pipElement === null && requests.length === dismissedRequests,
        'Closing automatic PiP must suppress duplicate inactive notifications until the next window visit');
      activateWindow();
      check(pipElement === null && requests.length === dismissedRequests,
        'Returning after dismissal must not flash a newly opened PiP');
      deactivateWindow();
      await until(() => pipElement === selected(), 'A new window departure may automatically open PiP again');
      activateWindow();

      await setup();
      selected().closest('[data-tile-key]').querySelector('.stage-pip-btn').click();
      await until(() => pipElement === selected(), 'A manual PiP opens before changing window focus');
      const persistentManual = pipElement;
      const manualRequests = requests.length;
      deactivateWindow();
      activateWindow();
      deactivateWindow();
      check(pipElement === persistentManual && requests.length === manualRequests,
        'Manual PiP survives focus on its window, the main window and minimization without reopening');
      activateWindow();
      check(pipElement === persistentManual && !persistentManual.paused,
        'Restoring the app does not override an explicitly opened manual PiP');
      await document.exitPictureInPicture();

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => pipElement !== null, 'PiP must open before previewing another channel');
      const previewVideo = pipElement;
      stage.setChannel('other-preview-channel');
      activateWindow();
      check(pipElement === previewVideo, 'Viewing another voice stage must not close the call PiP');
      stage.setChannel(channel.id);
      check(pipElement === null && selected() === previewVideo && stage.focusedTileKeys.join() === keys.join(),
        'Returning from another voice stage restores the original focus');

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => pipElement !== null, 'PiP must open before call departure');
      const departing = pipElement;
      voice.setChannel(null);
      check(departing.srcObject === null && pipElement === null, 'Leaving the call invalidates the presentation');

      await setup();
      stage.openAutomaticPictureInPicture();
      await until(() => pipElement !== null, 'PiP must open before background navigation');
      const backgroundVideo = pipElement;
      stage.destroy();
      const other = sessionManager.create('other-pip-ui.test', 7891, 'Other server');
      sessionManager.activate(other.key);
      mountStage();
      activateWindow();
      appEvents.emit('participants.updated');
      check(pipElement === backgroundVideo && backgroundVideo.srcObject === streams[1],
        'PiP authority follows the call session, not the foreground server');
      streams[1].getVideoTracks()[0].dispatchEvent(new Event('ended'));
      check(pipElement === null && backgroundVideo.srcObject === null && !document.querySelector('.screen-pip-host'),
        'An ended track retires background PiP without a mounted stage');
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
      check(pipElement === null && selected() === returningVideo && returningVideo.srcObject === streams[1]
        && !document.querySelector('.chat-copy-toast'),
      'A late opening after stage return cannot leave PiP open or announce a stale automatic action');

      await setup();
      let finish;
      pending = { promise: new Promise(done => { finish = done; }) };
      stage.openAutomaticPictureInPicture();
      const cancelled = selected();
      voice.setScreenWatching(remote.sessionId, 'screen-b', false);
      finish(true); pending = null;
      await until(() => pipElement === null, 'A late PiP completion after cancellation must close');
      await new Promise(resolve => setTimeout(resolve, 20));
      check(cancelled.srcObject === null && pipElement === null && !document.querySelector('.screen-pip-host'),
        'Revocation during an in-flight request cannot resurrect media');

      await setup();
      failRequest = true;
      stage.openAutomaticPictureInPicture();
      await until(() => document.querySelector('.chat-copy-toast--danger')?.textContent.includes(language.t('stage.pictureInPictureErrorMessage')),
        'Automatic PiP failures must have localized visible feedback');
      check(selected().srcObject === streams[1] && !selected().paused, 'A PiP opening failure must not interrupt stage playback');
      failRequest = false;
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
    document.body.replaceChildren();
  }
}
