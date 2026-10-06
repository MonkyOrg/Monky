'use strict';
module.exports = { runOverlayParticipantSmoke };

async function runOverlayParticipantSmoke() {
  const [{ OverlayBridgeService }, { voiceStore }, { settingsStore }, { sessionManager }, { videoService },
    { OverlayStageView }, language] = await Promise.all([
    import('/core/OverlayBridgeService.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/SessionManager.ts'), import('/core/VideoService.ts'), import('/views/OverlayStageView.ts'), import('/i18n/index.ts'),
  ]);
  let checks = 0, state;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const previousApi = window.api, previousSettings = settingsStore.getOverlayConfig();
  const previousCamera = videoService.getCameraState;
  const session = sessionManager.create('overlay-participants.test', 7890, 'Owned overlay filter fixture');
  session.client.send = () => {};
  sessionManager.activate(session.key);
  const users = ['local', 'inactive', 'camera', 'screen', 'both', 'legacy'].map((name, i) => ({
    id: name, sessionId: name, clientId: name, nickname: name, status: 'ONLINE', joinedAt: i,
  }));
  const channel = { id: 'filter-channel', type: 'VOICE', name: 'Filter fixture', position: 0 };
  const bridge = new OverlayBridgeService();
  bridge.isOpen = true;
  const callbacks = new Map();
  const subscribe = key => listener => { callbacks.set(key, listener); return () => callbacks.delete(key); };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new OverlayStageView(container);
  try {
    session.serverStore.setServerDetails({ id: 'fixture', name: 'Fixture', channels: [channel], members: users,
      knownMembers: users, roles: [], userRoles: [], ownerId: 'local', myPermissions: 2147483647, voiceStates: {} }, users[0]);
    session.participants.setUsers(users);
    for (const user of users) session.participants.updateVoiceState({
      userId: user.id, sessionId: user.sessionId, channelId: channel.id, isMuted: false, isDeafened: false,
      isSpeaking: false, isCameraOn: ['camera', 'both'].includes(user.id),
      isScreenSharing: ['screen', 'both', 'legacy'].includes(user.id),
      screenShareIds: ['screen', 'both'].includes(user.id) ? ['share'] : [],
    });
    voiceStore.setChannel(channel.id, session.key);
    voiceStore.isCameraOn = false;
    voiceStore.setScreenSharing(false);
    videoService.getCameraState = () => ({ status: 'ready', stream: null });
    window.api = {
      sendOverlaySyncState: async next => { state = next; callbacks.get('state')?.(next); },
      onOverlaySyncStateReceived: subscribe('state'),
      onOverlayConfigUpdated: subscribe('config'),
    };
    view.init();
    for (const minimalistMode of [false, true]) {
      for (const mode of ['cameras-only', 'cameras-and-screens']) {
        for (const enabled of [false, true]) {
          settingsStore.setOverlayConfig({ ...previousSettings, mode, minimalistMode, hideSelf: true,
            hideInactiveParticipants: enabled, focusActiveSpeaker: false });
          bridge.syncState();
          const expected = !enabled ? ['inactive', 'camera', 'screen', 'both', 'legacy']
            : mode === 'cameras-only' ? ['camera', 'both'] : ['camera', 'screen', 'both', 'legacy'];
          check(state.participants.map(p => p.sessionId).join() === expected.join(),
            `${mode}/${minimalistMode}/${enabled}: filter uses actual camera/screen state, including legacy shares.`);
          check(!state.participants.some(p => p.isLocal), 'Hide myself composes with the media filter.');
        }
      }
    }
    settingsStore.setOverlayConfig({ mode: 'cameras-only', minimalistMode: false, hideInactiveParticipants: true,
      focusActiveSpeaker: true });
    bridge.lastActiveSpeakerSessionId = 'inactive';
    bridge.syncState();
    check(state.activeSpeakerSessionId === 'camera', 'Focus never selects an excluded last speaker.');
    check(container.querySelectorAll('.overlay-card:not(.leaving)').length === 1, 'Focus renders one eligible camera.');
    for (const user of users) session.participants.updateVoiceState({
      userId: user.id, sessionId: user.sessionId, channelId: channel.id, isCameraOn: false,
      isScreenSharing: false, screenShareIds: [], isMuted: false, isDeafened: false,
    });
    bridge.syncState();
    check(state.participants.length === 0 && state.activeSpeakerSessionId === null, 'Stopping every camera clears the roster and focus.');
    check(container.querySelector('.overlay-empty-state').textContent.includes(language.t('overlay.noActiveVideo')),
      'An empty filtered roster has a localized explanation rather than claiming nobody is in the call.');
    settingsStore.setOverlayConfig({ hideSelf: false });
    voiceStore.isCameraOn = true;
    bridge.syncState();
    check(state.participants.length === 1 && state.participants[0].isLocal,
      'The local camera follows the ready camera state rather than stale server flags.');
    return checks;
  } finally {
    view.destroy();
    videoService.getCameraState = previousCamera;
    voiceStore.isCameraOn = false;
    voiceStore.setChannel(null);
    settingsStore.setOverlayConfig(previousSettings);
    window.api = previousApi;
    sessionManager.remove(session.key);
    document.body.classList.remove('overlay-window-mode');
    container.remove();
  }
}
