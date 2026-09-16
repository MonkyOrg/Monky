import {
  MessageType, LOCAL_MEDIA_CHANNEL_LABEL, assertLocalMediaChannel, decodeLocalMediaRecord, isLocalMediaSdp,
} from '@monky/shared';

export async function startRenderer({ port, nickname }) {
  const failures = [];
  const onError = event => failures.push(event.error?.message ?? event.message);
  const onRejection = event => failures.push(event.reason?.message ?? String(event.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const record = (event, details = {}) => console.debug('LOCAL_E2E ' + JSON.stringify({
    event, at: Date.now(), ...details,
  }));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, description) => {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      if (failures.length) throw new Error(failures.join('\n'));
      if (await condition()) return;
      await wait(25);
    }
    throw new Error(`Renderer timed out: ${typeof description === 'function' ? description() : description}`);
  };
  const privatePeers = [];
  const originals = [];
  const inspectRecord = (entry, direction, data) => {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new Error('Private media must be binary, not JSON or a Blob.');
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const message = decodeLocalMediaRecord(bytes);
    const { opus, ...fields } = message;
    record('private.record', { peer: entry.id, direction, ...fields, bytes: opus?.byteLength });
  };
  const observeRecord = (...args) => {
    try { inspectRecord(...args); }
    catch (error) {
      if (!(error instanceof Error) || !['TypeError', 'RangeError', 'ZodError'].includes(error.name)) throw error;
      failures.push(error.message);
    }
  };
  const wrap = (prototype, name, replacement) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') throw new Error(`Missing native ${name}`);
    Object.defineProperty(prototype, name, { ...descriptor, value: replacement(descriptor.value) });
    originals.push(() => Object.defineProperty(prototype, name, descriptor));
  };
  // Observe actual native instances; never replace a PC/channel constructor.
  wrap(RTCPeerConnection.prototype, 'createDataChannel', original => function(label, options) {
    const dataChannel = Reflect.apply(original, this, [label, options]);
    if (label !== LOCAL_MEDIA_CHANNEL_LABEL) return dataChannel;
    assertLocalMediaChannel(dataChannel);
    const entry = { id: privatePeers.length + 1, pc: this, channel: dataChannel };
    privatePeers.push(entry);
    record('private.created', { peer: entry.id });
    dataChannel.addEventListener('open', () => {
      if (this.getSenders().length || this.getReceivers().length || this.getTransceivers().length) {
        failures.push('The private PC acquired a media track.');
      }
      if (!isLocalMediaSdp(this.localDescription?.sdp ?? '') ||
          !isLocalMediaSdp(this.remoteDescription?.sdp ?? '')) {
        failures.push('The private connection is not exclusively a data channel.');
      }
      record('private.open', { peer: entry.id, connected: this.connectionState === 'connected' });
    });
    dataChannel.addEventListener('message', event => observeRecord(entry, 'in', event.data));
    dataChannel.addEventListener('close', () => record('private.closed', { peer: entry.id }));
    return dataChannel;
  });
  wrap(RTCDataChannel.prototype, 'send', original => function(data) {
    const entry = privatePeers.find(peer => peer.channel === this);
    if (entry) observeRecord(entry, 'out', data);
    return Reflect.apply(original, this, [data]);
  });

  const [
    { LocalExecutionE2eApp }, { audioProcessor }, { webRtcManager }, { voiceStore },
    { settingsStore }, { sessionManager }, { openServerSession }, { toggleMicrophoneMute },
  ] = await Promise.all([
    import('/main.ts'), import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/SessionManager.ts'), import('/core/serverConnection.ts'), import('/core/voiceControls.ts'),
  ]);
  // Same startup seam as botVoiceRejoinSmoke: skip updates/onboarding/global
  // shortcuts, not the App, session routing, local execution, voice or UI.
  LocalExecutionE2eApp.prototype.init = async () => {};
  const app = new LocalExecutionE2eApp();
  app.setupGlobalEventListeners();
  settingsStore.noiseSuppressionMode = 'rnnoise';
  const identity = await window.api.getIdentity();
  const auth = await openServerSession('127.0.0.1', port, identity, nickname);
  const session = sessionManager.getActive();
  if (!session) throw new Error('Authentication did not create an actual renderer session.');
  const channels = auth.server.channels;
  if (!Array.isArray(channels)) throw new Error('The real server did not supply its channel roster.');
  const voiceChannel = channels.find(channel => channel.type === 'VOICE');
  const textChannel = channels.find(channel => channel.type === 'TEXT');
  if (!voiceChannel || !textChannel) throw new Error('The isolated server is missing its seeded channels.');
  const invocations = new Map();
  const unbindInvocation = session.client.onEvent((event, payload) => {
    if (event === `message.${MessageType.COMMAND_INVOKED}` && payload.channelId === textChannel.id) {
      invocations.set(payload.commandName, (invocations.get(payload.commandName) ?? 0) + 1);
    }
  });
  let probe;
  const disposeProbe = () => {
    if (!probe) return;
    const { pipeline, analyser, silentSink, sessionId } = probe;
    probe = undefined;
    if (webRtcManager.mediaRouter.voicePipelines.get(sessionId) === pipeline &&
        pipeline.gain.context.state !== 'closed') pipeline.gain.disconnect(analyser);
    analyser.disconnect();
    silentSink.disconnect();
  };
  const botParticipant = () => session.participants.getAll().find(participant => participant.user.isBot);
  const sample = async () => {
    const bot = botParticipant();
    const sessionId = bot?.user.sessionId;
    const pipeline = sessionId ? webRtcManager.mediaRouter.voicePipelines.get(sessionId) : undefined;
    if (pipeline !== probe?.pipeline) {
      disposeProbe();
      if (pipeline?.gain.context.state === 'running') {
        const analyser = pipeline.gain.context.createAnalyser();
        analyser.fftSize = 4096;
        const silentSink = pipeline.gain.context.createGain();
        silentSink.gain.value = 0;
        pipeline.gain.connect(analyser);
        analyser.connect(silentSink);
        silentSink.connect(pipeline.gain.context.destination);
        probe = { pipeline, analyser, silentSink, sessionId, samples: new Float32Array(analyser.fftSize) };
      }
    }
    let rms = 0, frequency = 0;
    if (probe) {
      probe.analyser.getFloatTimeDomainData(probe.samples);
      let energy = 0, crossings = 0;
      for (let index = 0; index < probe.samples.length; index++) {
        const value = probe.samples[index];
        energy += value * value;
        if (index && probe.samples[index - 1] <= 0 && value > 0) crossings++;
      }
      rms = Math.sqrt(energy / probe.samples.length);
      frequency = crossings * probe.pipeline.gain.context.sampleRate / probe.samples.length;
    }
    const peer = sessionId ? webRtcManager.peers.get(sessionId) : undefined;
    const receiver = sessionId && pipeline ? webRtcManager.getReceiverForTrack(sessionId, pipeline.trackId) : null;
    const reports = receiver ? await receiver.getStats() : peer ? await peer.pc.getStats() : new Map();
    const isSfu = auth.server.voiceMode === 'sfu';
    const connection = isSfu
      ? webRtcManager.getVoiceStatus().isSfuConnected ? 'connected' : undefined
      : peer?.pc.connectionState;
    const inbound = [...reports.values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio');
    return {
      botSessionId: sessionId, connection, mode: isSfu ? 'sfu' : 'p2p', rms, frequency,
      packets: inbound.reduce((sum, row) => sum + row.packetsReceived, 0),
      samples: inbound.reduce((sum, row) => sum + (row.totalSamplesReceived ?? 0), 0),
      speaking: bot?.isSpeaking === true,
      botServerMuted: bot?.voiceState?.serverMuted,
    };
  };

  const actions = {
    identity: () => ({
      serverId: auth.server.id, userId: auth.currentUser.id, sessionId: auth.currentUser.sessionId,
      voiceChannelId: voiceChannel.id, textChannelId: textChannel.id, mode: auth.server.voiceMode,
    }),
    async createBot() {
      const response = await session.client.sendRequest(MessageType.BOT_CREATE, {});
      if (typeof response?.token !== 'string' || typeof response.bot?.id !== 'string') {
        throw new Error('Real authenticated BOT_CREATE failed.');
      }
      return response;
    },
    async join() {
      const control = document.querySelector(
        `[data-channel-id="${voiceChannel.id}"][data-channel-type="VOICE"]`,
      );
      if (!control) throw new Error('Actual join-voice control is missing.');
      control.click();
      await until(() => voiceStore.currentVoiceChannelId === voiceChannel.id && !voiceStore.isConnecting,
        'real voice join');
    },
    async invoke(commandName = 'local-smoke', values = {}, preview = false) {
      const count = () => invocations.get(commandName) ?? 0;
      const before = count();
      const selector = `[data-command-form][data-command-name="${CSS.escape(commandName)}"]`;
      const text = document.querySelector(`[data-channel-id="${textChannel.id}"][data-channel-type="TEXT"]`);
      if (!text) throw new Error('Actual text channel control is missing.');
      text.click();
      await until(() => document.querySelector('#chat-message-input'), 'chat composer');
      if (document.querySelector('[data-command-form]')) {
        await until(() => {
          const cancel = document.querySelector('[data-command-form] [data-bot-action="cancel-command"]');
          if (!cancel || cancel.disabled) return false;
          cancel.click();
          return true;
        }, 'closing the previous command draft');
        await until(() => !document.querySelector('[data-command-form]'), 'fresh command draft');
      }
      let form = document.querySelector(selector);
      if (!form) {
        const input = document.querySelector('#chat-message-input');
        input.value = `/${commandName}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await until(() => document.querySelector('#command-dropup [role="option"]'), 'registered bot command');
        const choice = [...document.querySelectorAll('#command-dropup [role="option"]')]
          .find(option => option.dataset.commandName === commandName);
        if (!choice) throw new Error('The real command list does not contain the registered smoke bot.');
        choice.click();
        await until(() => count() > before || document.querySelector(selector),
          'selected command');
        form = document.querySelector(selector);
      }
      for (const [name, value] of Object.entries(values)) {
        let field, preparationDenied = false;
        await until(async () => {
          const state = await window.api.getLocalExecutionState();
          preparationDenied = state.permissions.some(permission => permission.decision === 'deny');
          if (preparationDenied) return true;
          const current = document.querySelector(`${selector} [data-bot-input][name="${CSS.escape(name)}"]`);
          if (!(current instanceof HTMLInputElement) && !(current instanceof HTMLTextAreaElement)) return false;
          if (current.disabled || !current.isConnected) return false;
          field = current;
          return true;
        }, `editable command field after prerequisite preparation: ${commandName}.${name}`);
        if (preparationDenied) return 'denied';
        field.focus();
        field.value = String(value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        if (field.hasAttribute('data-bot-autocomplete')) {
          let choice, denied = false;
          await until(async () => {
            choice = document.querySelector(`${selector} [data-parameter-option]`);
            if (choice) return true;
            const state = await window.api.getLocalExecutionState();
            denied = state.permissions.some(permission => permission.decision === 'deny');
            return denied;
          }, () => `actual autocomplete ${commandName}.${name}: ${document.querySelector(selector)?.textContent}`);
          if (denied) return 'denied';
          if (preview) {
            const play = choice.querySelector('[data-audio-preview-action="toggle"]');
            if (!play) throw new Error('Actual local preview control is missing.');
            play.click();
            await until(() => {
              const controls = document.querySelector(`${selector} [data-audio-choice-controls]`);
              if (controls?.dataset.audioPreviewState === 'failed') {
                throw new Error(`Local preview failed: ${controls.textContent}`);
              }
              return controls?.dataset.audioPreviewState === 'playing';
            }, 'actual local opaque preview playback');
            record('preview.playing');
            choice = document.querySelector(`${selector} [data-parameter-option]`);
          }
          choice.click();
        }
      }
      let outcome;
      await until(async () => {
        if (count() > before) {
          outcome = 'submitted';
          return true;
        }
        const submit = document.querySelector(
          `${selector} button[type="submit"]`,
        );
        if (submit && !submit.disabled) {
          submit.click();
          outcome = 'submitted';
          return true;
        }
        const state = await window.api.getLocalExecutionState();
        if (state.permissions.some(permission => permission.decision === 'deny')) {
          outcome = 'denied';
          return true;
        }
        return false;
      }, () => 'actual command submit: ' + JSON.stringify({
        composer: document.querySelector('[data-command-form]')?.textContent?.trim(),
        voiceChannelId: voiceStore.currentVoiceChannelId, connecting: voiceStore.isConnecting,
      }));
      return outcome;
    },
    sample,
    chat: () => session.chatStore.getMessages(textChannel.id).map(message => message.content),
    async mute() {
      if (!voiceStore.isMuted) toggleMicrophoneMute();
      settingsStore.inputMode = 'push_to_talk';
      audioProcessor.handlePttState(false);
      audioProcessor.applyTrackEnabled();
      await wait(300);
      return {
        muted: voiceStore.isMuted, inputMode: settingsStore.inputMode,
        tracksEnabled: audioProcessor.getLocalAudioStream()?.getAudioTracks().some(track => track.enabled) ?? false,
      };
    },
    async enablePermission() {
      const state = await window.api.getLocalExecutionState();
      if (state.permissions.length !== 1) throw new Error('Expected exactly one denied bot capability.');
      return window.api.setLocalExecutionPermission({ permissionId: state.permissions[0].id, enabled: true });
    },
    async leave() {
      disposeProbe();
      const control = document.getElementById('sidebar-btn-leave-voice');
      if (!control) throw new Error('Actual leave-voice control is missing.');
      control.click();
      await until(() => voiceStore.currentVoiceChannelId === null, 'actual requester voice departure');
    },
    privateReady: () => privatePeers.some(({ pc, channel }) =>
      pc.connectionState === 'connected' && channel.readyState === 'open' &&
      pc.getSenders().length === 0 && pc.getReceivers().length === 0 && pc.getTransceivers().length === 0),
    privateClosed: () => privatePeers.every(({ pc, channel }) =>
      pc.connectionState === 'closed' && channel.readyState === 'closed'),
    failures: () => [...failures],
    async cleanup() {
      disposeProbe();
      if (voiceStore.currentVoiceChannelId) await actions.leave();
      app.mainView.destroy();
      unbindInvocation();
      sessionManager.remove(session.key);
      audioProcessor.destroy();
      webRtcManager.closeAllPeers();
      for (const restore of originals.reverse()) restore();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      if (failures.length) throw new Error(failures.join('\n'));
    },
  };
  window.localE2e = actions;
  return actions.identity();
}
