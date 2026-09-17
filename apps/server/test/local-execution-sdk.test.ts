import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'werift';
import {
  BotClient,
  LocalExecutionError,
  LocalExecutionRpcError,
  type CommandContext,
  type CommandAutocompleteContext,
  type CommandAudioPreviewContext,
} from '@monky/bot-sdk';
import {
  LOCAL_MEDIA_CHANNEL_LABEL,
  BOT_CAPABILITIES,
  LOCAL_MEDIA_CHANNEL_OPTIONS,
  LOCAL_MEDIA_FORMAT,
  MessageType,
  ProtocolErrorCode,
  commandAutocompleteResultSchema,
  commandAudioPreviewResultSchema,
  commandFinishedSchema,
  localTaskOfferSchema,
  localTaskEventSchema,
  localTaskControlSchema,
  localMediaSignalSchema,
  advanceLocalMediaFlow,
  createLocalMediaFlowState,
  decodeLocalMediaRecord,
  encodeLocalMediaRecord,
  type LocalMediaRecord,
  type LocalSourceContext,
  type LocalTaskOffer,
  type LocalTaskSpec,
} from '@monky/shared';
import { createFixture, identity, isRecord, record, records, text } from '../dist/testFixtures/bots';

const LOCAL_TEST_URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const LOCAL_TEST_TRACK = { id: 'abcdefghijk', title: 'Authored local fixture', url: LOCAL_TEST_URL, duration: 1 };

test('local execution SDK and real server pair private Opus with retained sources and physical-session cancellation',
  { timeout: 45000 }, async (t) => {
    const f = await createFixture();
    let sdk: BotClient | undefined;
    const privatePeers: RTCPeerConnection[] = [];
    const unsubscribe: (() => void)[] = [];
    const unexpected: unknown[] = [];
    t.after(async () => {
      try { await sdk?.close(); }
      finally {
        for (const dispose of unsubscribe) dispose();
        try { await Promise.all(privatePeers.map((pc) => pc.close())); }
        finally { await f.dispose(); }
      }
      assert.deepEqual(unexpected, [], 'SDK and private channel handlers must not fail');
    });
    t.mock.method(f.coturnManager, 'buildIceServers', () => []);
    await f.serverRepo.updateServer({ voiceMode: 'p2p' });

    function observe<T>(promise: Promise<T>): Promise<T> {
      void promise.catch(() => undefined);
      return promise;
    }
    async function within<T>(promise: Promise<T>, description: string, timeout = 5000): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeout);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }
    async function until(predicate: () => boolean, description: string): Promise<void> {
      const deadline = Date.now() + 5000;
      while (!predicate() && Date.now() < deadline) {
        assert.deepEqual(unexpected, [], description);
        await delay(10, undefined, { signal: t.signal });
      }
      assert.deepEqual(unexpected, [], description);
      assert.ok(predicate(), description);
    }
    async function remainsPending(promise: Promise<unknown>, description: string): Promise<void> {
      let settled = false;
      void promise.then(() => { settled = true; }, () => { settled = true; });
      await delay(25, undefined, { signal: t.signal });
      assert.equal(settled, false, description);
    }

    const owner = await f.human('Combined SDK owner');
    const caller = await f.human('Combined SDK caller');
    const server = record(owner.auth.payload.server);
    const serverId = text(server.id);
    const channels = records(server.channels);
    const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
    const voiceId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
    const callerSessionId = text(record(caller.auth.payload.currentUser).sessionId);
    const created = await owner.peer.request(MessageType.BOT_CREATE, {});
    assert.equal(created.type, MessageType.BOT_CREATED);
    const botId = text(record(created.payload.bot).id);
    const declaration = f.botPermissions.declare(botId, [...BOT_CAPABILITIES]);
    f.botPermissions.approve(owner.id, {
      botId, expectedRevision: declaration.permissions.revision, granted: [...BOT_CAPABILITIES],
    });
    const botKeys = identity();
    const bot = new BotClient({
      requestedCapabilities: [...BOT_CAPABILITIES],
      serverUrl: f.url, token: text(created.payload.token), publicKey: botKeys.publicKey,
      name: 'Combined SDK fixture', autoReconnect: false,
    });
    sdk = bot;
    const onError = (error: unknown) => { unexpected.push(error); };
    bot.on('error', onError);
    unsubscribe.push(() => bot.off('error', onError));
    const queuedUrl = 'https://www.youtube.com/watch?v=lmnopqrstuv';
    const queuedTrack = { ...LOCAL_TEST_TRACK, id: 'lmnopqrstuv', url: queuedUrl };
    const captured: {
      invocation?: CommandContext;
      source?: LocalSourceContext;
      queuedSource?: LocalSourceContext;
      autocomplete?: CommandAutocompleteContext;
      preview?: CommandAudioPreviewContext;
    } = {};
    bot.command({
      name: 'combined-local', description: 'Real SDK local execution fixture', localCapabilities: ['youtube-audio'],
      options: [{ name: 'query', description: 'Local search', type: 'string', autocomplete: true }],
      handler: async (ctx) => {
        captured.invocation = ctx;
        const client = bot.localExecution(ctx.serverId);
        captured.source = await client.retainSource(ctx.invocationId, LOCAL_TEST_URL);
        captured.queuedSource = await client.retainSource(ctx.invocationId, queuedUrl);
      },
      autocomplete: async (ctx) => {
        captured.autocomplete = ctx;
        const result = await bot.localExecution(ctx.serverId)
          .executor({ kind: 'autocomplete', requestId: ctx.requestId })
          .execute({ operation: 'youtube.search', query: ctx.query });
        return result.tracks.map((track) => ({
          label: track.title, value: track.url, audio: { resourceId: track.url, fileName: 'authored-silence.ogg' },
        }));
      },
      audioPreview: async (ctx) => {
        captured.preview = ctx;
        return bot.localExecution(ctx.serverId)
          .executor({ kind: 'audio-preview', requestId: ctx.requestId })
          .execute({ operation: 'youtube.preview', url: ctx.resourceId });
      },
    });
    const registrationSince = caller.peer.messages.length;
    bot.connect({ serverId });
    const registered = await caller.peer.wait((message) =>
      message.type === MessageType.COMMANDS_LIST_RESPONSE && Array.isArray(message.payload.commands) &&
      message.payload.commands.some((command: unknown) =>
        isRecord(command) && command.botId === botId && command.name === 'combined-local'), registrationSince);
    const command = records(registered.payload.commands).find((entry) => entry.botId === botId);
    assert.ok(command);
    assert.equal(command.botPublicKey, botKeys.publicKey);
    assert.deepEqual(command.localCapabilities, ['youtube-audio']);
    const client = bot.localExecution(serverId);
    assert.equal(bot.localExecution(serverId), client);

    // Admit the publisher while the room is empty: the later human's passive room peer needs no fabricated SDP.
    const publisher = await within(bot.joinVoice(serverId, voiceId), 'SDK public-room admission');
    assert.equal(publisher.humanParticipantCount, 0);
    const joined = await caller.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId, isMuted: true });
    assert.equal(joined.type, MessageType.VOICE_USER_JOINED);
    assert.equal(f.signalingService.getVoiceState(callerSessionId)?.isMuted, true);
    await until(() => publisher.humanParticipantCount === 1, 'SDK observes the real caller voice session');

    const invocationRequestId = randomUUID();
    caller.peer.send(MessageType.COMMAND_INVOKE, {
      botId, channelId: textId, commandName: 'combined-local', localPreparation: { capability: 'youtube-audio' },
    }, invocationRequestId);
    const invoked = await caller.peer.wait((message) => message.requestId === invocationRequestId);
    assert.equal(invoked.type, MessageType.COMMAND_INVOKED);
    const invocationId = text(invoked.payload.invocationId);
    assert.notEqual(invocationId, invocationRequestId);
    const finished = commandFinishedSchema.parse((await caller.peer.wait((message) =>
      message.type === MessageType.COMMAND_FINISHED && message.payload.invocationId === invocationId)).payload);
    assert.equal(finished.reason, 'completed');
    const { invocation, source, queuedSource } = captured;
    assert.ok(invocation && source && queuedSource);
    assert.equal(invocation.invocationId, invocationId);
    assert.equal(invocation.signal.aborted, true);
    assert.notEqual(source.sourceContextId, queuedSource.sourceContextId);
    for (const retained of [source, queuedSource]) {
      assert.equal(retained.botPublicKey, botKeys.publicKey);
      assert.equal(retained.invokerId, caller.id);
      assert.equal(retained.invokerSessionId, callerSessionId);
      assert.equal(retained.originChannelId, textId);
      assert.equal(Object.isFrozen(retained), true);
    }

    async function taskOffer(operation: LocalTaskSpec['operation'], since: number): Promise<LocalTaskOffer> {
      const message = await caller.peer.wait((entry) => entry.type === MessageType.BOT_LOCAL_TASK_OFFER &&
        isRecord(entry.payload.spec) && entry.payload.spec.operation === operation, since);
      assert.equal(message.requestId, undefined, 'Delegation must not settle the caller UI RPC');
      const offer = localTaskOfferSchema.parse(message.payload);
      assert.equal(offer.bot.botId, botId);
      assert.equal(offer.bot.botPublicKey, botKeys.publicKey);
      assert.equal(offer.invokerSessionId, callerSessionId);
      return offer;
    }
    const executor = client.executor({ kind: 'source', sourceContextId: source.sourceContextId });
    const resolveSince = caller.peer.messages.length;
    const resolving = observe(executor.execute({ operation: 'youtube.resolve', url: source.url }));
    const resolution = await taskOffer('youtube.resolve', resolveSince);
    assert.deepEqual(resolution.context, { kind: 'source', sourceContextId: source.sourceContextId });
    assert.notEqual(resolution.requestId, invocationRequestId);
    caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
      taskId: resolution.taskId, result: { operation: 'youtube.resolve', track: LOCAL_TEST_TRACK },
    });
    assert.deepEqual(await within(resolving, 'retained source resolution after invocation completion'),
      { operation: 'youtube.resolve', track: LOCAL_TEST_TRACK });

    const autocompleteRequestId = randomUUID();
    const searchSince = caller.peer.messages.length;
    caller.peer.send(MessageType.COMMAND_AUTOCOMPLETE, {
      botId, channelId: textId, commandName: 'combined-local', optionName: 'query', query: 'authored silence',
      localPreparation: { capability: 'youtube-audio' },
    }, autocompleteRequestId);
    const search = await taskOffer('youtube.search', searchSince);
    assert.ok(captured.autocomplete);
    assert.deepEqual(search.context, { kind: 'autocomplete', requestId: captured.autocomplete.requestId });
    assert.notEqual(captured.autocomplete.requestId, autocompleteRequestId);
    assert.equal(search.requestId, autocompleteRequestId);
    caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
      taskId: search.taskId, result: { operation: 'youtube.search', tracks: [LOCAL_TEST_TRACK] },
    });
    const choices = commandAutocompleteResultSchema.parse((await caller.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === autocompleteRequestId)).payload);
    assert.ok(choices.status === 'ok');
    assert.equal(choices.choices[0].value, LOCAL_TEST_URL);
    const audio = choices.choices[0].audio;
    assert.ok(audio && 'resourceId' in audio);
    assert.notEqual(audio.resourceId, LOCAL_TEST_URL, 'The server remaps lazy preview resource IDs');
    assert.equal(captured.autocomplete.signal.aborted, true);

    const previewRequestId = randomUUID();
    const previewSince = caller.peer.messages.length;
    caller.peer.send(MessageType.COMMAND_AUDIO_PREVIEW, {
      botId, channelId: textId, commandName: 'combined-local', optionName: 'query',
      autocompleteRequestId, resourceId: audio.resourceId, localPreparation: { capability: 'youtube-audio' },
    }, previewRequestId);
    const previewOffer = await taskOffer('youtube.preview', previewSince);
    assert.ok(captured.preview);
    assert.equal(captured.preview.resourceId, LOCAL_TEST_URL);
    assert.deepEqual(previewOffer.context, { kind: 'audio-preview', requestId: captured.preview.requestId });
    assert.notEqual(captured.preview.requestId, previewRequestId);
    assert.equal(previewOffer.requestId, previewRequestId);
    const previewReference = {
      localPreviewId: 'renderer-only-authored-preview', taskId: previewOffer.taskId,
      requestId: previewRequestId, executorSessionId: callerSessionId,
    };
    caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
      taskId: previewOffer.taskId, result: { operation: 'youtube.preview', ...previewReference },
    });
    const preview = commandAudioPreviewResultSchema.parse((await caller.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === previewRequestId)).payload);
    assert.deepEqual(preview, { status: 'local', ...previewReference });
    assert.equal(captured.preview.signal.aborted, true);

    async function pairStream(retained: LocalSourceContext) {
      const since = caller.peer.messages.length;
      const pending = observe(client.executor({ kind: 'source', sourceContextId: retained.sourceContextId })
        .stream({ operation: 'youtube.stream', url: retained.url }, { voiceChannelId: voiceId }));
      const offer = await taskOffer('youtube.stream', since);
      const media = offer.media;
      assert.ok(media);
      assert.deepEqual(media.iceServers, []);
      assert.deepEqual(offer.context, { kind: 'source', sourceContextId: retained.sourceContextId });
      assert.notEqual(offer.requestId, invocationId);
      assert.notEqual(offer.requestId, invocationRequestId);
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', codecs: { audio: [], video: [] } });
      privatePeers.push(pc);
      const channel = pc.createDataChannel(LOCAL_MEDIA_CHANNEL_LABEL, LOCAL_MEDIA_CHANNEL_OPTIONS);
      const received: LocalMediaRecord[] = [];
      let flow = createLocalMediaFlowState();
      const subscription = channel.onMessage.subscribe((bytes) => {
        try {
          if (!(bytes instanceof Uint8Array)) throw new TypeError('Private media controls must be binary');
          const entry = decodeLocalMediaRecord(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          flow = advanceLocalMediaFlow(flow, entry, 'bot');
          received.push(entry);
        } catch (error) { unexpected.push(error); }
      });
      unsubscribe.push(() => { subscription.unSubscribe(); channel.close(); });
      for (const transport of pc.iceTransports) {
        transport.connection.stunServer = transport.connection.options.stunServer;
      }
      await within(pc.setLocalDescription(await pc.createOffer()), 'private sender host ICE gathering');
      const description = pc.localDescription;
      assert.ok(description);
      assert.match(description.sdp, /^a=candidate:.* typ host/m);
      assert.deepEqual(pc.getTransceivers(), []);
      assert.ok(pc.iceTransports.every((transport) => transport.connection.stunServer === undefined));
      caller.peer.send(MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
        taskId: offer.taskId, mediaGeneration: media.generation,
        signal: { signalType: 'offer', sdp: { type: 'offer', sdp: description.sdp } },
      });
      const answer = localMediaSignalSchema.parse((await caller.peer.wait((message) =>
        message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL && message.payload.taskId === offer.taskId &&
        isRecord(message.payload.signal) && message.payload.signal.signalType === 'answer', since)).payload);
      assert.equal(answer.mediaGeneration, media.generation);
      assert.ok(answer.signal.signalType === 'answer');
      assert.match(answer.signal.sdp.sdp, /^a=candidate:.* typ host/m);
      await pc.setRemoteDescription(answer.signal.sdp);
      // Both descriptions contain all gathered host ICE; relayed trickle records are redundant here.
      for (const message of caller.peer.messages.slice(since)) {
        if (message.type !== MessageType.BOT_LOCAL_MEDIA_SIGNAL || message.payload.taskId !== offer.taskId) continue;
        assert.equal(localMediaSignalSchema.parse(message.payload).mediaGeneration, media.generation);
      }
      await until(() => pc.connectionState === 'connected' && channel.readyState === 'open',
        'real private executor and SDK PC/DC connect before Main acceptance');
      await remainsPending(pending, 'Connected private media must not bypass Main acceptance');
      assert.equal(received.length, 0, 'No CREDIT before Main acceptance');
      caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
        taskId: offer.taskId, result: { operation: 'youtube.stream', track: LOCAL_TEST_TRACK },
      });
      await caller.peer.wait((message) => message.type === MessageType.BOT_LOCAL_TASK_EVENT &&
        message.payload.taskId === offer.taskId && message.payload.state === 'accepted', since);
      await remainsPending(pending, 'Main acceptance alone must not bypass the caller readiness report');
      assert.equal(received.length, 0, 'No CREDIT until both endpoints and Main are ready');
      caller.peer.send(MessageType.BOT_LOCAL_TASK_EVENT, {
        state: 'ready', taskId: offer.taskId, mediaGeneration: media.generation,
      });
      const stream = await within(pending, 'SDK stream after server-authorized readiness');
      observe(stream.closed);
      const ready = localTaskEventSchema.parse((await caller.peer.wait((message) =>
        message.type === MessageType.BOT_LOCAL_TASK_EVENT && message.payload.taskId === offer.taskId &&
        message.payload.state === 'ready', since)).payload);
      assert.deepEqual(ready, { state: 'ready', taskId: offer.taskId, mediaGeneration: media.generation });
      assert.equal(stream.taskId, offer.taskId);
      assert.deepEqual(stream.track, LOCAL_TEST_TRACK);
      await until(() => received.length > 0, 'initial SDK CREDIT on the private data channel');
      assert.equal(received.length, 1);
      assert.deepEqual(received[0], { kind: 'credit', consumedFrames: 0, windowEnd: LOCAL_MEDIA_FORMAT.creditWindowFrames });
      return {
        stream, offer, media, pc, channel, received,
        get flow() { return flow; },
        send(entry: LocalMediaRecord) {
          flow = advanceLocalMediaFlow(flow, entry, 'executor');
          channel.send(Buffer.from(encodeLocalMediaRecord(entry)));
        },
      };
    }

    const silence = Uint8Array.from([0xf8, 0xff, 0xfe]);
    const paired = await pairStream(source);
    const iterator = paired.stream.frames[Symbol.asyncIterator]();
    const totalFrames = 3;
    for (let sequence = 0; sequence < totalFrames; sequence++) paired.send({ kind: 'frame', sequence, opus: silence });
    paired.send({ kind: 'end', finalSequence: totalFrames });
    for (let sequence = 0; sequence < totalFrames; sequence++) {
      const frame = await within(iterator.next(), 'single SDK playback consumer');
      assert.ok(!frame.done);
      assert.deepEqual(frame.value, silence);
      await until(() => paired.flow.consumedFrames === sequence + 1, 'consumption CREDIT reaches the executor');
      assert.equal(paired.flow.playedFrames, sequence, 'Consumption CREDIT must not advance the playback checkpoint');
      assert.equal(paired.flow.drained, false, 'Buffered EOF must not acknowledge unplayed frames');
      await publisher.writeOpus(frame.value);
      assert.equal(paired.flow.playedFrames, sequence);
      assert.equal(paired.received.some((entry) => entry.kind === 'drainAck'), false);
      paired.stream.markFrameAdvanced();
      await until(() => paired.flow.playedFrames === sequence + 1, 'PLAYED follows publisher consumption');
    }
    await until(() => paired.flow.drained, 'final private drain acknowledgement');
    assert.deepEqual(paired.received.slice(-2), [
      { kind: 'played', playedFrames: totalFrames }, { kind: 'drainAck', finalSequence: totalFrames },
    ]);
    const eof = observe(iterator.next());
    await remainsPending(eof, 'Iterator EOF must await genuine server completion after the private drain');
    await remainsPending(paired.stream.closed, 'Drain alone must not close the SDK stream');
    // Renderer teardown closes drained media before reporting completion over its WebSocket.
    paired.channel.close();
    await until(() => paired.channel.readyState === 'closed', 'executor channel closes before WebSocket completion');
    await remainsPending(eof, 'Graceful private channel closure must still await server-confirmed EOF');
    await remainsPending(paired.stream.closed, 'Closed private media must still await matching server completion');
    caller.peer.send(MessageType.BOT_LOCAL_TASK_EVENT, {
      state: 'completed', taskId: paired.offer.taskId, mediaGeneration: paired.media.generation, playedFrames: totalFrames,
    });
    await within(paired.stream.closed, 'drained stream server confirmation');
    assert.deepEqual(await within(eof, 'confirmed iterator EOF'), { done: true, value: undefined });
    assert.equal(paired.stream.signal.aborted, false);
    assert.equal(f.signalingService.getVoiceState(callerSessionId)?.isMuted, true);

    const active = await pairStream(source);
    assert.notEqual(active.offer.taskId, paired.offer.taskId);
    assert.notEqual(active.media.generation, paired.media.generation);
    const activeIterator = active.stream.frames[Symbol.asyncIterator]();
    const pendingRead = observe(activeIterator.next());
    let lastRevision = 0;
    for (const paused of [true, false, true]) {
      const since = caller.peer.messages.length;
      const controlling = observe(active.stream.setPaused(paused));
      const control = localTaskControlSchema.parse((await caller.peer.wait((message) =>
        message.type === MessageType.BOT_LOCAL_TASK_CONTROL && message.payload.taskId === active.offer.taskId, since)).payload);
      assert.equal(control.action, paused ? 'pause' : 'resume');
      assert.ok(control.revision > lastRevision);
      lastRevision = control.revision;
      caller.peer.send(MessageType.BOT_LOCAL_TASK_EVENT, {
        state: paused ? 'paused' : 'resumed', taskId: active.offer.taskId, revision: control.revision,
      });
      await within(controlling, 'pause/resume settles independently of a pending frame read');
      await remainsPending(pendingRead, 'Control acknowledgements must not fabricate an Opus frame');
    }
    const controlSince = caller.peer.messages.length;
    const unacknowledgedResume = observe(active.stream.setPaused(false));
    await caller.peer.wait((message) => message.type === MessageType.BOT_LOCAL_TASK_CONTROL &&
      message.payload.taskId === active.offer.taskId && message.payload.action === 'resume', controlSince);
    // Main is still paused: leave before it acknowledges the newest resume revision.
    assert.equal(f.signalingService.getVoiceState(callerSessionId)?.isMuted, true);
    const left = await caller.peer.request(MessageType.VOICE_LEAVE, { channelId: voiceId });
    assert.equal(left.type, MessageType.VOICE_USER_LEFT);
    await assert.rejects(within(active.stream.closed, 'paused requester cancellation', 1000), (error: unknown) => {
      assert.ok(error instanceof LocalExecutionError);
      assert.deepEqual(error.event, { state: 'cancelled', taskId: active.offer.taskId, cause: 'requester_left_voice' });
      return true;
    });
    assert.equal(active.stream.signal.aborted, true);
    const cancellation: unknown = active.stream.signal.reason;
    assert.ok(cancellation instanceof LocalExecutionError);
    await assert.rejects(within(pendingRead, 'cancelled pending read', 1000), (error: unknown) => error === cancellation);
    await assert.rejects(within(unacknowledgedResume, 'cancelled pending control', 1000), (error: unknown) => error === cancellation);
    await assert.rejects(activeIterator.next(), (error: unknown) => error === cancellation);
    await active.stream.close();
    await until(() => active.channel.readyState === 'closed', 'cancelled private channel releases media and cannot yield queued bytes');
    assert.deepEqual(active.received, [
      { kind: 'credit', consumedFrames: 0, windowEnd: LOCAL_MEDIA_FORMAT.creditWindowFrames },
    ]);
    await assert.rejects(client.checkSourceAvailability(queuedSource.sourceContextId, voiceId), (error: unknown) =>
      error instanceof LocalExecutionRpcError && error.cancellationCause === 'requester_left_voice');
    assert.equal((await caller.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId, isMuted: true })).type,
      MessageType.VOICE_USER_JOINED);
    const availabilitySince = caller.peer.messages.length;
    await client.checkSourceAvailability(queuedSource.sourceContextId, voiceId);
    await caller.peer.barrier();
    assert.equal(caller.peer.messages.slice(availabilitySince).some((message) => message.type.startsWith('BOT_LOCAL_')), false,
      'Checking the original source after voice rejoin never starts client work or asks for tools again');
    await caller.peer.request(MessageType.VOICE_LEAVE, { channelId: voiceId });

    const queuedSince = caller.peer.messages.length;
    const queuedExecutor = client.executor({ kind: 'source', sourceContextId: queuedSource.sourceContextId });
    const queuedResolution = observe(queuedExecutor.execute({ operation: 'youtube.resolve', url: queuedSource.url }));
    const fresh = await taskOffer('youtube.resolve', queuedSince);
    assert.deepEqual(fresh.context, { kind: 'source', sourceContextId: queuedSource.sourceContextId });
    assert.notEqual(fresh.taskId, active.offer.taskId);
    assert.equal(fresh.voiceChannelId, undefined);
    caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
      taskId: fresh.taskId, result: { operation: 'youtube.resolve', track: queuedTrack },
    });
    assert.deepEqual(await within(queuedResolution, 'different queued source survives requester voice leave'),
      { operation: 'youtube.resolve', track: queuedTrack });

    const replacement = await f.human('Combined SDK caller', caller.keys, caller.deviceId);
    assert.equal(record(replacement.auth.payload.currentUser).sessionId, callerSessionId);
    await until(() => caller.peer.ws.readyState === WebSocket.CLOSED, 'old physical requester socket is replaced');
    for (const retained of [source, queuedSource]) {
      await assert.rejects(client.checkSourceAvailability(retained.sourceContextId, voiceId), (error: unknown) =>
        error instanceof LocalExecutionRpcError && error.cancellationCause === 'requester_disconnected');
      await assert.rejects(client.executor({ kind: 'source', sourceContextId: retained.sourceContextId })
        .execute({ operation: 'youtube.resolve', url: retained.url }), (error: unknown) => {
          assert.ok(error instanceof LocalExecutionRpcError);
          assert.equal(error.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
          assert.equal(error.cancellationCause, 'requester_disconnected');
          assert.equal(error.reason, undefined);
          assert.equal('event' in error, false);
          return true;
        });
      await client.releaseSource(retained.sourceContextId);
    }
    await replacement.peer.barrier();
    assert.equal(replacement.peer.messages.some((message) => message.type === MessageType.BOT_LOCAL_TASK_OFFER), false);
    const localWire = f.peers.flatMap((peer) => peer.messages).filter((message) =>
      message.type.startsWith('BOT_LOCAL_') || message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT);
    assert.equal(localWire.some((message) => /"(?:audioBase64|audioUrl|bytes|opus|permit|mediaUrl)"/.test(JSON.stringify(message.payload))),
      false, 'WebSockets carry public metadata and authorized signaling, never private media bytes or Main permits');
    assert.equal(caller.peer.messages.some((message) => message.type === MessageType.RTC_SIGNAL), false,
      'Private media did not use or fabricate the room audio signaling path');
    assert.deepEqual(unexpected, []);
  });
