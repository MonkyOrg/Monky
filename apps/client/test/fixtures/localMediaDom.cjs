async function runLocalMediaDom(sharedUrl) {
  const shared = await import(sharedUrl);
  const [{ LocalExecutionController }, { LocalAudioSender }, { NetworkClient }, { createServerStore }] = await Promise.all([
    import('/core/LocalExecutionController.ts'), import('/core/LocalAudioSender.ts'),
    import('/core/NetworkClient.ts'), import('/stores/serverStore.ts'),
  ]);
  const {
    MessageType, LOCAL_MEDIA_PROTOCOL, LOCAL_MEDIA_FORMAT,
    assertLocalMediaChannel, isLocalMediaSdp, localMediaSignalSchema, localTaskOfferSchema,
    createLocalMediaFlowState, advanceLocalMediaFlow, decodeLocalMediaRecord, encodeLocalMediaRecord,
  } = shared;
  let checks = 0;
  let failure;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const fail = error => { failure ??= error instanceof Error ? error : new Error(String(error)); };
  const waitFor = predicate => new Promise((resolve, reject) => {
    let frame;
    const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Private RTC condition did not settle')); }, 12000);
    const poll = () => {
      if (failure) { clearTimeout(timeout); reject(failure); }
      else if (predicate()) { clearTimeout(timeout); resolve(); }
      else frame = requestAnimationFrame(poll);
    };
    poll();
  });
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('Private audio must never capture microphone tracks'); };
  const client = new NetworkClient();
  const server = createServerStore();
  const user = { id: 'rtc-user', clientId: 'rtc-device', sessionId: 'rtc-physical', nickname: 'Fixture', joinedAt: 1, status: 'ONLINE' };
  const bot = { botId: 'rtc-bot', botName: 'RTC fixture', botPublicKey: 'd'.repeat(64) };
  server.setServerDetails({
    id: 'rtc-server', name: 'RTC server', createdAt: 1, maxUsers: 10, hasPassword: false,
    channels: [], members: [user], voiceStates: {}, roles: [], userRoles: [],
  }, user);
  server.setSlashCommands([{ ...bot, name: 'play', description: 'Fixture', localCapabilities: ['youtube-audio'] }]);
  client.currentServerUrl = 'wss://rtc.example.invalid';
  client.ws = { readyState: WebSocket.OPEN, close() { this.readyState = WebSocket.CLOSED; } };
  client.sessionKey = client.currentServerUrl;
  client.setStatus('CONNECTED');
  const sent = [];
  const readCounts = [];
  const acknowledgements = [];
  const pauses = [];
  const cancellations = [];
  const starts = [];
  const received = [];
  const consumed = [];
  const inbound = [];
  const peerConfigs = [];
  const pendingCandidates = [];
  const totalFrames = 30;
  const taskId = 'wire-real-rtc';
  let delivered = 0;
  let nativeConfirmed = 0;
  let nativeEof = false;
  let nativeRetired = false;
  let confirmFinalAck;
  const finalAckConfirmation = new Promise(resolve => { confirmFinalAck = resolve; });
  let flow = createLocalMediaFlowState();
  let receiverChannel;
  let senderPeer;
  let senderChannel;
  let sender;
  let nativeStarted = false;
  let executorReady = false;
  let signalQueue = Promise.resolve();
  let closing = false;
  let receiverOffer;
  const receiverPeer = new RTCPeerConnection({ iceServers: [] });
  const prepareReceiverFromOffer = payload => {
    receiverOffer = localTaskOfferSchema.parse(payload);
    if (!receiverOffer.media) throw new Error('The authoritative bot offer must include its private media generation');
    receiverPeer.setConfiguration({ iceServers: receiverOffer.media.iceServers });
  };
  const sendRecord = record => {
    flow = advanceLocalMediaFlow(flow, record, 'bot');
    receiverChannel.send(encodeLocalMediaRecord(record));
  };
  const receive = (type, payload) => client.handleIncomingMessage({ type, payload });
  const answerSignal = async signal => {
    const parsed = localMediaSignalSchema.parse(signal);
    if (!receiverOffer || parsed.taskId !== receiverOffer.taskId || parsed.mediaGeneration !== receiverOffer.media.generation) {
      throw new Error('Bot receiver must have its authoritative task offer before the first SDP/ICE signal');
    }
    if (parsed.signal.signalType === 'candidate') {
      if (receiverPeer.remoteDescription) await receiverPeer.addIceCandidate(parsed.signal.candidate);
      else pendingCandidates.push(parsed.signal.candidate);
      return;
    }
    check(parsed.signal.signalType === 'offer' && isLocalMediaSdp(parsed.signal.sdp.sdp)
      && starts.length === 0 && !sent.some(message => message.type === MessageType.BOT_LOCAL_TASK_ACCEPT),
    'the early authoritative offer lets the bot answer data-only SDP before Main starts or accepts');
    await receiverPeer.setRemoteDescription(parsed.signal.sdp);
    for (const candidate of pendingCandidates.splice(0)) await receiverPeer.addIceCandidate(candidate);
    const answer = await receiverPeer.createAnswer();
    await receiverPeer.setLocalDescription(answer);
    receive(MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
      taskId: receiverOffer.taskId, mediaGeneration: receiverOffer.media.generation, signal: {
        signalType: 'answer', sdp: { type: 'answer', sdp: receiverPeer.localDescription.sdp },
      },
    });
  };
  client.send = (type, payload) => {
    sent.push({ type, payload: structuredClone(payload) });
    if (type === MessageType.BOT_LOCAL_MEDIA_SIGNAL) {
      signalQueue = signalQueue.then(() => answerSignal(payload)).catch(fail);
    }
    if (type === MessageType.BOT_LOCAL_TASK_EVENT && payload.state === 'failed') fail(new Error(payload.reason));
  };
  receiverPeer.onicecandidate = event => {
    if (!closing && receiverOffer) receive(MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
      taskId: receiverOffer.taskId, mediaGeneration: receiverOffer.media.generation,
      signal: { signalType: 'candidate', candidate: event.candidate?.toJSON() ?? null },
    });
  };
  receiverPeer.ondatachannel = event => {
    receiverChannel = event.channel;
    receiverChannel.binaryType = 'arraybuffer';
    try { assertLocalMediaChannel(receiverChannel); } catch (error) { fail(error); }
    receiverChannel.onmessage = event => {
      try {
        const record = decodeLocalMediaRecord(new Uint8Array(event.data));
        flow = advanceLocalMediaFlow(flow, record, 'executor');
        if (record.kind === 'frame') received.push(record.sequence);
      } catch (error) { fail(error); }
    };
  };
  const api = {
    setLocalExecutionConnection: async () => ({ status: 'completed' }),
    prepareLocalExecution: async () => ({ status: 'prepared', permit: '5'.repeat(64) }),
    startLocalExecutionTask: async input => {
      check(senderPeer.connectionState === 'connected' && senderChannel.readyState === 'open',
        'Main starts only after the real private data path is connected');
      starts.push(input);
      nativeStarted = true;
      return { status: 'started', taskId: 'native-real-rtc', result: {
        operation: 'youtube.stream', track: {
          id: 'abcdefghijk', title: 'Generated Opus', url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 1,
        },
      } };
    },
    readLocalExecutionFrames: async input => {
      check(nativeStarted && executorReady && input.taskId === 'native-real-rtc' && !sender.sourceEnded,
        'frame reads require authoritative ready and use the live Main UUID');
      readCounts.push(input.count);
      const count = Math.min(input.count, totalFrames - delivered);
      delivered += count;
      nativeEof = delivered === totalFrames;
      nativeRetired = nativeEof && nativeConfirmed === delivered;
      return {
        status: 'frames', frames: Array.from({ length: count }, () => new Uint8Array([0xf8, 0xff, 0xfe])),
        done: nativeEof,
      };
    },
    acknowledgeLocalExecutionFrames: async input => {
      check(!nativeRetired && input.taskId === 'native-real-rtc'
        && input.playedFrames > nativeConfirmed && input.playedFrames <= delivered,
      'native playback ACKs remain valid through EOF and advance only confirmed delivered frames');
      acknowledgements.push(input.playedFrames);
      if (input.playedFrames === totalFrames) await finalAckConfirmation;
      nativeConfirmed = input.playedFrames;
      nativeRetired = nativeEof && nativeConfirmed === delivered;
      return { status: 'completed' };
    },
    setLocalExecutionPaused: async input => {
      check(!nativeRetired && input.taskId === 'native-real-rtc', 'native pause remains valid while the EOF tail is unplayed');
      pauses.push(input.paused);
      return { status: 'completed' };
    },
    cancelLocalExecutionRequest: async input => { cancellations.push(input); return { status: 'completed' }; },
    cancelLocalExecutionTask: async id => { cancellations.push(id); return { status: 'completed' }; },
    onLocalExecutionChanged: () => () => {},
    onLocalExecutionTaskFailed: () => () => {},
  };
  const controller = new LocalExecutionController(client, server, () => 'rtc-voice', api, {
    botIsInVoice: (id, session, channel) => id === bot.botId && session === 'rtc-bot-session' && channel === 'rtc-voice',
    createSender: options => {
      sender = new LocalAudioSender({
        ...options,
        createPeer: configuration => {
          peerConfigs.push(configuration);
          senderPeer = new RTCPeerConnection(configuration);
          const createChannel = senderPeer.createDataChannel.bind(senderPeer);
          senderPeer.createDataChannel = (label, settings) => {
            senderChannel = createChannel(label, settings);
            senderChannel.addEventListener('message', event => {
              try { inbound.push(decodeLocalMediaRecord(new Uint8Array(event.data))); }
              catch (error) { fail(error); }
            });
            return senderChannel;
          };
          return senderPeer;
        },
      });
      return sender;
    },
  });
  const owner = new AbortController();
  try {
    const grant = await controller.prepare(bot, 'youtube-audio', owner.signal);
    controller.registerRequest('invocation', 'rtc-request', grant, { channelId: 'rtc-text', commandName: 'play' });
    controller.acknowledgeRequest('rtc-request', {
      invocationId: 'rtc-invocation', botId: bot.botId, commandName: 'play', channelId: 'rtc-text',
    });
    const authoritativeOffer = {
      taskId, requestId: 'rtc-request', context: { kind: 'invocation', invocationId: 'rtc-invocation' },
      bot: { ...bot, serverId: 'rtc-server', serverName: 'RTC server' },
      botSessionId: 'rtc-bot-session', invokerId: user.id, invokerSessionId: user.sessionId,
      capability: 'youtube-audio', spec: { operation: 'youtube.stream', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
      voiceChannelId: 'rtc-voice', expiresAt: Date.now() + 45000,
      media: { protocol: LOCAL_MEDIA_PROTOCOL, generation: 1, iceServers: [] },
    };
    prepareReceiverFromOffer(structuredClone(authoritativeOffer));
    check(receiverOffer.taskId === taskId && receiverOffer.requestId === 'rtc-request'
      && !nativeStarted && starts.length === 0,
    'the bot receives task/media identity from early BOT_LOCAL_TASK_OFFER, not from Main acceptance');
    receive(MessageType.BOT_LOCAL_TASK_OFFER, authoritativeOffer);
    check(starts.length === 0, 'an offered stream cannot start Main during asynchronous negotiation');
    await waitFor(() => receiverPeer.connectionState === 'connected' && receiverChannel?.readyState === 'open'
      && sent.some(message => message.type === MessageType.BOT_LOCAL_TASK_EVENT && message.payload.state === 'ready'));
    const offerIndex = sent.findIndex(message => message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL
      && message.payload.signal.signalType === 'offer');
    const acceptIndex = sent.findIndex(message => message.type === MessageType.BOT_LOCAL_TASK_ACCEPT);
    const readyIndex = sent.findIndex(message => message.type === MessageType.BOT_LOCAL_TASK_EVENT && message.payload.state === 'ready');
    check(offerIndex >= 0 && acceptIndex > offerIndex && readyIndex > acceptIndex,
      'stream signaling precedes Main acceptance, and ready follows the real Main result');
    check(readCounts.length === 0 && received.length === 0, 'endpoint readiness alone cannot release native media');
    receive(MessageType.BOT_LOCAL_TASK_EVENT, {
      state: 'accepted', ...sent[acceptIndex].payload, media: authoritativeOffer.media,
    });
    // The bot can receive server readiness before the executor's separate WebSocket does.
    sendRecord({ kind: 'credit', consumedFrames: 0, windowEnd: LOCAL_MEDIA_FORMAT.creditWindowFrames });
    await waitFor(() => inbound.some(record => record.kind === 'credit'));
    check(readCounts.length === 0 && received.length === 0,
      'credit overtaking the authoritative ready event is retained without starting native reads');
    executorReady = true;
    receive(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'ready', taskId, mediaGeneration: 1 });
    await waitFor(() => received.length === 25);
    check(readCounts.every(count => count >= 1 && count <= 8) && delivered === 25,
      'the real channel stops at its absolute 25-frame window with batches of at most eight');
    check(acknowledgements.length === 0 && received.every((sequence, index) => sequence === index),
      'receiving buffered frames is not playback and sequences stay ordered');
    check(senderPeer.getSenders().length === 0 && senderPeer.getTransceivers().length === 0
      && receiverPeer.getSenders().length === 0 && peerConfigs.every(config => config.iceServers.length === 0),
    'the transport adds no media tracks, microphone capture or external ICE fallback');
    sendRecord({ kind: 'credit', consumedFrames: 25, windowEnd: 50 });
    await waitFor(() => inbound.some(record => record.kind === 'credit' && record.windowEnd === 50));
    check(delivered === 25 && acknowledgements.length === 0,
      'consumption-only credit cannot advance native playback or exceed the bounded unplayed tail');
    receive(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId, revision: 1, action: 'pause' });
    await waitFor(() => sent.some(message => message.type === MessageType.BOT_LOCAL_TASK_EVENT && message.payload.state === 'paused'));
    consumed.push(...received.slice(0, 5));
    sendRecord({ kind: 'played', playedFrames: consumed.length });
    await waitFor(() => sender.playedFrames === 5 && acknowledgements.includes(5));
    check(delivered === 25 && pauses.at(-1) === true, 'actual PLAYED while paused does not resume native reads');
    receive(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId, revision: 2, action: 'resume' });
    await waitFor(() => flow.finalSequence === totalFrames);
    check(sender.sourceEnded && received.length === totalFrames && pauses.at(-1) === false,
      'resume sends every frame in the final native batch before same-channel EOF');
    const mutationsAtEof = acknowledgements.length + pauses.length;
    receive(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId, mediaGeneration: 1, playedFrames: totalFrames });
    check(!sender.completed && senderPeer.connectionState === 'connected',
      'a WebSocket completion overtaking SCTP cannot truncate the remaining audio tail');
    receive(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId, revision: 3, action: 'pause' });
    receive(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId, revision: 4, action: 'resume' });
    await waitFor(() => sent.some(message => message.type === MessageType.BOT_LOCAL_TASK_EVENT
      && message.payload.state === 'resumed' && message.payload.revision === 4));
    consumed.push(...received.slice(5));
    sendRecord({ kind: 'credit', consumedFrames: totalFrames, windowEnd: totalFrames + 25 });
    sendRecord({ kind: 'played', playedFrames: consumed.length });
    sendRecord({ kind: 'drainAck', finalSequence: totalFrames });
    await waitFor(() => acknowledgements.includes(totalFrames) && inbound.some(record => record.kind === 'drainAck'));
    check(!nativeRetired && !sender.nativePlaybackComplete && !sender.completed
      && senderPeer.connectionState === 'connected'
      && !sent.some(message => message.type === MessageType.BOT_LOCAL_TASK_EVENT && message.payload.state === 'completed'),
    'real private drain keeps the peer and task open while Main has only reserved its final playback ACK');
    confirmFinalAck();
    await waitFor(() => sent.some(message => message.type === MessageType.BOT_LOCAL_TASK_EVENT && message.payload.state === 'completed'));
    const complete = sent.find(message => message.type === MessageType.BOT_LOCAL_TASK_EVENT && message.payload.state === 'completed').payload;
    check(complete.taskId === taskId && complete.mediaGeneration === 1 && complete.playedFrames === totalFrames && sender.completed,
      'only validated same-channel playback and drain produce the completed wire event');
    check(acknowledgements.length + pauses.length === mutationsAtEof + 3 && cancellations.length === 0
      && acknowledgements.at(-1) === totalFrames && nativeConfirmed === totalFrames
      && nativeRetired && sender.nativePlaybackComplete,
    'EOF tail pause/resume and final PLAYED retire Main without cancelling or truncating the stream');
    check(senderPeer.connectionState === 'closed' && senderChannel.readyState === 'closed',
      'successful draining releases the private peer and channel');
    check(sent.every(message => message.type !== MessageType.RTC_SIGNAL
      && !('frames' in message.payload) && !('opus' in message.payload)),
    'WebSocket carries only dedicated task control/signaling, never audio frames or room RTC signaling');
    return checks;
  } finally {
    closing = true;
    confirmFinalAck();
    controller.dispose();
    owner.abort();
    client.dispose();
    sender?.close();
    receiverChannel?.close();
    receiverPeer.close();
    navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    await signalQueue;
  }
}

module.exports = { runLocalMediaDom };
