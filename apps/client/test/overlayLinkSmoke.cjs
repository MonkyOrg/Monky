'use strict';
module.exports = { runOverlayLinkSmoke };

// The overlay's video link with real RTCPeerConnections: the main window's
// OverlayBridgeService and the overlay's OverlayStageView live in this page and
// talk through a relay that behaves like the main process (asynchronous,
// structured-cloned). Covers R-MEDIA-2: the session in every signal, answers of
// another session dropped, renegotiation when either side starts over, and the
// frame cap that keeps the encoder from sending more than a card shows in the
// overlay's own device pixels.
async function runOverlayLinkSmoke() {
  const [{ OverlayBridgeService }, { OverlayStageView }, { voiceStore }, { settingsStore }, { sessionManager }] = await Promise.all([
    import('/core/OverlayBridgeService.ts'), import('/views/OverlayStageView.ts'), import('/stores/voiceStore.ts'),
    import('/stores/settingsStore.ts'), import('/core/SessionManager.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (probe, message, timeout = 15_000) => {
    const deadline = performance.now() + timeout;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (performance.now() > deadline) throw new Error(`Timed out: ${message}`);
      await delay(25);
    }
  };
  const previousApi = window.api, previousSettings = settingsStore.getOverlayConfig();
  const timers = [], tracks = [], bridges = [];
  const camera = (width, height, hue) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      context.fillStyle = `hsl(${hue}, 45%, 30%)`; context.fillRect(0, 0, width, height);
      context.fillStyle = '#fff'; context.fillRect((frame++ * 7) % (width - 40), height / 3, 40, 40);
    };
    draw();
    timers.push(setInterval(draw, 33));
    const track = canvas.captureStream(30).getVideoTracks()[0];
    tracks.push(track);
    return track;
  };

  // The main process relays every signal to the other window, asynchronously.
  const listeners = { main: new Set(), overlay: new Set() };
  let subscribing = 'main';
  const seen = [];
  const answers = [];
  let holdAnswers = false;
  const held = [];
  const deliver = (side, signal) => setTimeout(() => {
    for (const listener of [...listeners[side]]) listener(structuredClone(signal));
  }, 0);
  let overlayOpen = false, syncListener = null;
  window.api = {
    openOverlay: async () => { overlayOpen = true; return { success: true }; },
    closeOverlay: async () => { overlayOpen = false; return { success: true }; },
    isOverlayOpen: async () => overlayOpen,
    setOverlayConfig: async () => {},
    onOverlayStateChanged: () => () => {},
    onOverlayConfigUpdated: () => () => {},
    sendOverlaySyncState: async state => { setTimeout(() => syncListener?.(structuredClone(state)), 0); },
    onOverlaySyncStateReceived: callback => { syncListener = callback; return () => { if (syncListener === callback) syncListener = null; }; },
    layoutOverlayCards: async layout => ({ x: 0, y: 0, width: layout.width, height: layout.height }),
    sendOverlaySignal: async ({ target, signal }) => {
      seen.push(`${target === 'overlay' ? 'main' : 'overlay'}:${signal.kind}`);
      if (signal.kind === 'answer') {
        answers.push(structuredClone(signal));
        if (holdAnswers) { held.push(signal); return; }
      }
      deliver(target, signal);
    },
    onOverlaySignalReceived: callback => {
      const side = listeners[subscribing];
      side.add(callback);
      return () => side.delete(callback);
    },
  };
  const toMain = signal => { for (const listener of [...listeners.main]) listener(structuredClone(signal)); };
  const startBridge = () => {
    subscribing = 'main';
    const bridge = new OverlayBridgeService();
    bridges.push(bridge);
    bridge.init(() => 'normal');
    return bridge;
  };
  // A window that goes away takes its listeners and its connection with it.
  const retireBridge = bridge => {
    bridge.unbindListeners.forEach(unbind => unbind());
    bridge.unbindListeners = [];
    bridge.isOpen = false;
    bridge.teardownLocalPeerConnection();
  };
  const container = document.createElement('div');
  container.style.cssText = 'position: fixed; left: 0; top: 0; width: 360px; height: 200px;';
  document.body.appendChild(container);
  const startView = () => {
    subscribing = 'overlay';
    const view = new OverlayStageView(container);
    view.init();
    return view;
  };
  const cap = { width: Math.ceil(160 * devicePixelRatio), height: Math.ceil(90 * devicePixelRatio) };
  const videos = () => [...container.querySelectorAll('.overlay-card video')];
  const playingFrom = connection => videos().filter(video => {
    const track = video.srcObject?.getVideoTracks()[0];
    return video.videoWidth > 0 && !video.paused && track?.readyState === 'live'
      && connection.getReceivers().some(receiver => receiver.track === track);
  }).length;

  const session = sessionManager.create('overlay-link.test', 7891, 'Overlay link fixture');
  session.client.send = () => {};
  sessionManager.activate(session.key);
  const users = ['local', 'cam-a', 'cam-b'].map((name, i) => ({
    id: name, sessionId: name, clientId: name, nickname: name, status: 'ONLINE', joinedAt: i,
  }));
  const channel = { id: 'link-channel', type: 'VOICE', name: 'Link fixture', position: 0 };
  let view = null;
  try {
    session.serverStore.setServerDetails({ id: 'link', name: 'Link', channels: [channel], members: users,
      knownMembers: users, roles: [], userRoles: [], ownerId: 'local', myPermissions: 2147483647, voiceStates: {} }, users[0]);
    session.participants.setUsers(users);
    for (const user of users) session.participants.updateVoiceState({
      userId: user.id, sessionId: user.sessionId, channelId: channel.id, isMuted: false, isDeafened: false,
      isSpeaking: false, isCameraOn: user.id !== 'local', isScreenSharing: false, screenShareIds: [],
    });
    voiceStore.setChannel(channel.id, session.key);
    session.participants.setRemoteStream('cam-a', new MediaStream([camera(1280, 720, 20)]));
    session.participants.setRemoteStream('cam-b', new MediaStream([camera(640, 360, 200)]));
    settingsStore.setOverlayConfig({ ...previousSettings, mode: 'cameras-only', layout: 'horizontal', minimalistMode: false,
      hideSelf: true, hideInactiveParticipants: false, focusActiveSpeaker: false, autoOpenOnLeaveStage: false,
      preserveAspectRatio: true, cardSize: { width: 160, height: 90 } });

    // Opening: the hello is lost while the overlay loads; the overlay's own ready gets the offer.
    const negotiation = () => seen.filter(entry => entry !== 'overlay:scale').join();
    const first = startBridge();
    check(await first.open(settingsStore.getOverlayConfig()), 'The overlay opens');
    await delay(30);
    view = startView();
    await until(() => playingFrom(view.localPeerConnection) === 2 && seen.includes('overlay:scale'),
      'both cameras play in the overlay, which reports its pixel ratio');
    check(negotiation() === 'main:hello,overlay:ready,main:offer,overlay:answer', `One offer answers the starting overlay: ${seen}`);
    check(answers[0].session === first.linkSession && view.linkSession === first.linkSession,
      'Both sides name the same connection');
    const stats = await until(async () => {
      const report = await first.localPeerConnection.getStats();
      const codecs = new Map();
      report.forEach(entry => { if (entry.type === 'codec') codecs.set(entry.id, entry.mimeType); });
      const outbound = [];
      report.forEach(entry => { if (entry.type === 'outbound-rtp' && entry.framesEncoded > 0) outbound.push({ ...entry, codec: codecs.get(entry.codecId) }); });
      return outbound.length === 2 ? outbound : null;
    }, 'two encoding slots');
    check(stats.every(entry => entry.codec === 'video/VP8'), `The loopback link encodes with VP8: ${stats.map(entry => entry.codec)}`);
    const capped = sender => {
      const [encoding] = sender.getParameters().encodings;
      return encoding.maxFramerate === 30 && encoding.scaleResolutionDownTo?.maxWidth === cap.width
        && encoding.scaleResolutionDownTo?.maxHeight === cap.height;
    };
    await until(() => first.videoSenders.slice(0, 2).every(capped),
      `each used slot is capped at its card and 30 fps: ${JSON.stringify(first.videoSenders[0].getParameters().encodings)}`);
    check(true, 'Each used slot is capped at its card and 30 fps');
    await until(() => videos().every(video => video.videoWidth > 0 && video.videoWidth <= cap.width && video.videoHeight <= cap.height),
      `the overlay receives at most ${cap.width}x${cap.height}`);
    check(true, 'A 1280x720 camera reaches a 160x90 card scaled down by the encoder, not by the overlay');
    // An overlay on a display with another scale than the main window reports it, and the cap follows.
    const scaled = { width: Math.ceil(160 * devicePixelRatio * 2), height: Math.ceil(90 * devicePixelRatio * 2) };
    const cappedAt = size => sender => {
      const [encoding] = sender.getParameters().encodings;
      return encoding.scaleResolutionDownTo?.maxWidth === size.width && encoding.scaleResolutionDownTo?.maxHeight === size.height;
    };
    toMain({ kind: 'scale', session: 'unrelated-session', pixelRatio: devicePixelRatio * 2 });
    await delay(150);
    check(first.videoSenders.slice(0, 2).every(capped), 'The pixel ratio of another session changes nothing');
    toMain({ kind: 'scale', session: first.linkSession, pixelRatio: devicePixelRatio * 2 });
    await until(() => first.videoSenders.slice(0, 2).every(cappedAt(scaled)), 'the cap follows the overlay pixel ratio');
    check(true, 'The cap follows the pixel ratio the overlay reports, not the main window\'s');

    // The main window reloads with the overlay open: its new connection must pair again,
    // and an answer that belongs to the old connection must not be taken for the new one.
    const firstAnswer = answers.at(-1);
    const firstViewConnection = view.localPeerConnection;
    retireBridge(first);
    seen.length = 0;
    holdAnswers = true;
    const second = startBridge();
    await until(() => held.length === 1, 'the overlay answers the new connection');
    check(negotiation() === 'main:hello,overlay:ready,main:offer,overlay:answer',
      `A reloaded window says hello and negotiates once: ${seen}`);
    check(second.linkSession && second.linkSession !== firstAnswer.session && held[0].session === second.linkSession,
      'The new connection has its own session');
    check(firstViewConnection.connectionState === 'closed' && view.localPeerConnection !== firstViewConnection,
      'The overlay replaced its connection for the new session');
    toMain(firstAnswer);
    toMain({ kind: 'answer', session: 'unrelated-session', sdp: held[0].sdp });
    toMain('{"type":"answer"}');
    await delay(150);
    check(second.localPeerConnection.signalingState === 'have-local-offer' && !second.localPeerConnection.remoteDescription,
      'Answers of another session, and malformed ones, are dropped');
    holdAnswers = false;
    for (const signal of held.splice(0)) deliver('main', signal);
    await until(() => playingFrom(view.localPeerConnection) === 2, 'both cameras play again after the reload');
    check(second.localPeerConnection.remoteDescription?.sdp === answers.at(-1).sdp, 'Only the answer of the current session was applied');
    const offers = seen.filter(entry => entry === 'main:offer').length;
    toMain({ kind: 'ready', session: second.linkSession });
    await delay(150);
    check(seen.filter(entry => entry === 'main:offer').length === offers, 'A repeated ready does not offer the same connection twice');

    // The overlay starts over (a new document): its first ready pairs it with a new connection.
    const secondSession = second.linkSession;
    view.destroy();
    seen.length = 0;
    view = startView();
    await until(() => view.localPeerConnection && playingFrom(view.localPeerConnection) === 2, 'both cameras play in the restarted overlay');
    check(second.linkSession !== secondSession && view.linkSession === second.linkSession,
      `A restarted overlay gets a new connection: ${seen}`);
    check(negotiation() === 'overlay:ready,main:hello,overlay:ready,main:offer,overlay:answer', `Restart sequence: ${seen}`);
    return checks;
  } finally {
    holdAnswers = false;
    view?.destroy();
    for (const bridge of bridges) retireBridge(bridge);
    for (const timer of timers) clearInterval(timer);
    for (const track of tracks) track.stop();
    voiceStore.setChannel(null);
    settingsStore.setOverlayConfig(previousSettings);
    window.api = previousApi;
    sessionManager.remove(session.key);
    document.body.classList.remove('overlay-window-mode');
    container.remove();
  }
}
