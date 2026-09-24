import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_CAPABILITY_IDS, LOCAL_EXECUTION_PROTOCOL_LIMITS, LOCAL_EXECUTION_RUNTIME_LIMITS,
  LOCAL_MEDIA_CHANNEL_LABEL, LOCAL_MEDIA_CHANNEL_OPTIONS, LOCAL_MEDIA_FORMAT,
  LOCAL_MEDIA_MAX_RECORD_BYTES, LOCAL_MEDIA_PROTOCOL, LOCAL_OPERATION_CAPABILITY,
  MessageType, PROTOCOL_VERSION, advanceLocalMediaFlow, assertLocalMediaChannel,
  commandAudioPreviewExecutionSchema, commandAudioPreviewResultSchema, commandAudioPreviewSchema,
  commandAutocompleteExecutionSchema, commandAutocompleteSchema, commandCallerContextSchema,
  commandDefinitionSchema, commandExecutionSchema, commandInvokeSchema, commandLocalMetadataSchema,
  createLocalMediaFlowState, decodeLocalMediaRecord, encodeLocalMediaRecord, isLocalMediaSdp,
  isLocalOpusPacket, localCapabilitiesSchema, localCommandPreparationSchema, localMediaRecordSchema,
  localMediaSignalSchema, localOperationSchema, localRequestContextSchema, localSourceContextSchema,
  localRuntimeSourceFailureSchema, localSourceFailureSchema,
  localSourceRequestSchema, localSourceResultSchema, localTaskAcceptMatchesOffer, localTaskAcceptSchema,
  localTaskControlSchema, localTaskEventSchema, localTaskMatchesSource, localTaskOfferSchema,
  localTaskRequestSchema, localTaskResultSchema, localWireTaskResultSchema,
  toLocalCommandPreparation,
  type LocalMediaFlowState, type LocalMediaRecord,
} from '../src/index.js';

const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const otherUrl = 'https://www.youtube.com/watch?v=12345678901';
const track = { id: 'abcdefghijk', title: 'Synthetic track', url, duration: 120 };
const key = 'ab'.repeat(32);
const preparation = { capability: 'youtube-audio' } as const;
const nativePermit = '12'.repeat(32);
const caller = {
  botId: 'bot', channelId: 'chat', invokerId: 'human', invokerSessionId: 'physical-device',
  invokerNickname: 'Caller', invokerVoiceChannelId: 'voice',
};
const source = localSourceContextSchema.parse({
  sourceContextId: 'source', botId: 'bot', botPublicKey: key,
  invokerId: caller.invokerId, invokerSessionId: caller.invokerSessionId,
  originChannelId: caller.channelId, capability: 'youtube-audio', provider: 'youtube-local',
  url, expiresAt: 1_800_000_000_000,
});
const preview = { localPreviewId: 'local-preview', taskId: 'task', requestId: 'original-ui-request', executorSessionId: caller.invokerSessionId };
const media = { protocol: LOCAL_MEDIA_PROTOCOL, generation: 1, iceServers: [{ urls: ['stun:stun.example.test:3478'] }] };
const offer = localTaskOfferSchema.parse({
  taskId: 'task', requestId: preview.requestId,
  context: { kind: 'invocation', invocationId: 'invocation' },
  bot: { serverId: 'server', serverName: 'Server', botId: 'bot', botName: 'Bot', botPublicKey: key },
  botSessionId: 'bot:bot', invokerId: caller.invokerId, invokerSessionId: caller.invokerSessionId,
  capability: 'youtube-audio', spec: { operation: 'youtube.stream', url }, expiresAt: 1_800_000_000_000,
  voiceChannelId: 'voice', media,
});
const opus = Uint8Array.of(0xf8, 0xff, 0xfe);
const dataSdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n';

test('the current protocol publishes dedicated control messages without adding WebSocket audio', () => {
  assert.equal(PROTOCOL_VERSION, 25);
  for (const name of [
    'BOT_LOCAL_SOURCE_REQUEST', 'BOT_LOCAL_SOURCE_RESULT', 'BOT_LOCAL_TASK_REQUEST', 'BOT_LOCAL_TASK_OFFER',
    'BOT_LOCAL_TASK_ACCEPT', 'BOT_LOCAL_TASK_CONTROL', 'BOT_LOCAL_TASK_EVENT', 'BOT_LOCAL_MEDIA_SIGNAL',
  ]) assert.ok(Object.values(MessageType).some((value) => value === name));
  assert.deepEqual(Object.keys(LOCAL_OPERATION_CAPABILITY), localOperationSchema.options);
  assert.deepEqual(localCapabilitiesSchema.parse(LOCAL_CAPABILITY_IDS), ['youtube-audio']);
});

test('local declarations require a server key in public metadata and cannot provide one themselves', () => {
  const definition = { name: 'play', description: 'Play', localCapabilities: ['youtube-audio'] };
  assert.deepEqual(commandDefinitionSchema.parse(definition), definition);
  assert.equal(commandDefinitionSchema.safeParse({ ...definition, botPublicKey: key }).success, false);
  assert.equal(commandLocalMetadataSchema.safeParse({}).success, true);
  assert.equal(commandLocalMetadataSchema.safeParse({ localCapabilities: [] }).success, true);
  assert.equal(commandLocalMetadataSchema.safeParse({ localCapabilities: ['youtube-audio'] }).success, false);
  assert.equal(commandLocalMetadataSchema.safeParse({ localCapabilities: ['youtube-audio'], botPublicKey: key }).success, true);
  assert.equal(commandLocalMetadataSchema.safeParse({ botPublicKey: 'not-a-key' }).success, false);
  for (const localCapabilities of [['shell'], ['youtube-audio', 'youtube-audio'], [null], 'youtube-audio']) {
    assert.equal(commandDefinitionSchema.safeParse({ ...definition, localCapabilities }).success, false);
  }
});

test('preparation hints are optional while native permits and subjects stay off all three command inputs', () => {
  const invoke = { commandName: 'play', botId: 'bot', channelId: 'chat' };
  const autocomplete = { ...invoke, optionName: 'track', query: 'search' };
  const audioPreview = { ...invoke, optionName: 'track', resourceId: 'resource', autocompleteRequestId: 'autocomplete' };
  for (const [schema, input] of [
    [commandInvokeSchema, invoke],
    [commandAutocompleteSchema, autocomplete],
    [commandAudioPreviewSchema, audioPreview],
  ] as const) {
    assert.equal(schema.safeParse(input).success, true);
    assert.equal(schema.safeParse({ ...input, localPreparation: preparation }).success, true);
    assert.equal(schema.safeParse({
      ...input, localPreparation: { ...preparation, permit: nativePermit },
    }).success, false);
    assert.equal(schema.safeParse({
      ...input, localPreparation: { ...preparation, subject: { connectionId: 'private-native-connection' } },
    }).success, false);
    for (const field of ['invokerId', 'invokerSessionId', 'invokerNickname', 'botPublicKey', 'connectionId']) {
      assert.equal(schema.safeParse({ ...input, [field]: 'forged' }).success, false);
    }
  }
  for (const permit of [nativePermit, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64)]) {
    assert.equal(localCommandPreparationSchema.safeParse({ ...preparation, permit }).success, false);
  }
  const nativePreparation = {
    ...preparation, permit: nativePermit, subject: { connectionId: 'private-native-connection', botId: 'bot' },
  };
  assert.deepEqual(toLocalCommandPreparation(nativePreparation), preparation);
  assert.equal(localCommandPreparationSchema.safeParse(nativePreparation).success, false);
  assert.equal(JSON.stringify(toLocalCommandPreparation(nativePreparation)).includes(nativePermit), false);
  assert.equal(localCommandPreparationSchema.safeParse({ ...preparation, script: 'run' }).success, false);
  const executions = [
    [commandExecutionSchema, { ...caller, commandName: 'play', invocationId: 'invocation' }],
    [commandAutocompleteExecutionSchema, { ...caller, commandName: 'play', optionName: 'track', query: '', options: {}, locale: 'en' }],
    [commandAudioPreviewExecutionSchema, { ...caller, commandName: 'play', optionName: 'track', resourceId: 'resource', locale: 'en' }],
  ] as const;
  for (const [schema, execution] of executions) {
    assert.equal(schema.safeParse(execution).success, true);
    assert.equal(schema.safeParse({ ...execution, localPreparation: preparation }).success, false);
    assert.equal(schema.safeParse({ ...execution, userSettings: {} }).success, false);
    for (const field of Object.keys(commandCallerContextSchema.shape)) {
      assert.equal(schema.safeParse({ ...execution, [field]: undefined }).success, false);
    }
    assert.equal(schema.safeParse({ ...execution, invokerVoiceChannelId: null }).success, true);
  }
});

test('source retention derives identity from an invocation and fixed sources cannot replace URLs', () => {
  assert.deepEqual(localSourceRequestSchema.parse({ action: 'retain', invocationId: 'invocation', url }),
    { action: 'retain', invocationId: 'invocation', url });
  for (const injected of [{ invokerId: 'other' }, { invokerSessionId: 'another-device' }, { permit: nativePermit }]) {
    assert.equal(localSourceRequestSchema.safeParse({ action: 'retain', invocationId: 'invocation', url, ...injected }).success, false);
  }
  assert.equal(localSourceRequestSchema.safeParse({ action: 'retain', context: { kind: 'autocomplete', requestId: 'query' }, url }).success, false);
  assert.deepEqual(localSourceResultSchema.parse({ status: 'retained', source }), { status: 'retained', source });
  assert.equal('voiceChannelId' in source, false, 'Leaving voice is not deletion of retained future sources');
  for (const operation of ['youtube.resolve', 'youtube.preview', 'youtube.stream'] as const) {
    assert.equal(localTaskMatchesSource(source, { operation, url }), true);
    assert.equal(localTaskMatchesSource(source, { operation, url: otherUrl }), false);
  }
  assert.equal(localTaskMatchesSource(source, { operation: 'youtube.search', query: 'replacement' }), false);
  assert.equal(localSourceContextSchema.safeParse({ ...source, permit: nativePermit }).success, false);
  assert.equal(localSourceContextSchema.safeParse({ ...source, expiresAt: Infinity }).success, false);
  assert.equal(localSourceRequestSchema.safeParse({ action: 'release', sourceContextId: 'source' }).success, true);
  assert.equal(localSourceResultSchema.safeParse({ status: 'released', sourceContextId: 'source' }).success, true);
});

test('task contexts accept only exact server-owned references and canonical, bounded operations', () => {
  for (const context of [
    { kind: 'invocation', invocationId: 'invocation' }, { kind: 'autocomplete', requestId: 'remapped' },
    { kind: 'audio-preview', requestId: 'remapped-preview' }, { kind: 'source', sourceContextId: 'source' },
  ]) assert.equal(localRequestContextSchema.safeParse(context).success, true);
  assert.equal(localRequestContextSchema.safeParse({ kind: 'invocation', invocationId: 'id', invokerId: 'forged' }).success, false);
  assert.equal(localRequestContextSchema.safeParse({ kind: 'source', sourceContextId: 'x'.repeat(129) }).success, false);
  const request = { context: { kind: 'source', sourceContextId: 'source' }, spec: offer.spec, voiceChannelId: 'voice' };
  assert.equal(localTaskRequestSchema.safeParse(request).success, true);
  assert.equal(localTaskRequestSchema.safeParse({ ...request, voiceChannelId: undefined }).success, false);
  assert.equal(localTaskRequestSchema.safeParse({ ...request, spec: { operation: 'youtube.resolve', url } }).success, false);
  for (const spec of [
    { operation: 'youtube.stream', url: `${url}&cookies=browser` },
    { operation: 'youtube.stream', url: 'https://media.example.test/raw.opus' },
    { operation: 'youtube.stream', url, shell: 'ffmpeg' },
    { operation: 'youtube.stream', url, cookies: 'browser' },
    { operation: 'youtube.stream', url, audioBase64: 'AA==' },
  ]) assert.equal(localTaskRequestSchema.safeParse({ ...request, spec }).success, false);
  for (const field of ['invokerId', 'executorSessionId', 'iceServers', 'botPublicKey', 'isMuted']) {
    assert.equal(localTaskRequestSchema.safeParse({ ...request, [field]: 'injected' }).success, false);
  }
});

test('source availability checks carry only the owned source and target voice room, never execution authority', () => {
  const request = { action: 'check', sourceContextId: 'source', voiceChannelId: 'voice' };
  assert.deepEqual(localSourceRequestSchema.parse(request), request);
  const result = { status: 'available', sourceContextId: 'source', voiceChannelId: 'voice' };
  assert.deepEqual(localSourceResultSchema.parse(result), result);
  for (const injected of [
    { permit: nativePermit }, { invokerSessionId: 'replacement' }, { url }, { available: true },
    { voiceChannelId: '' }, { sourceContextId: '' },
  ]) {
    assert.equal(localSourceRequestSchema.safeParse({ ...request, ...injected }).success, false);
    assert.equal(localSourceResultSchema.safeParse({ ...result, ...injected }).success, false);
  }
  assert.equal(localSourceResultSchema.safeParse({ ...result, status: 'unavailable' }).success, false);
});

test('offers require stream voice/media scope and never carry bot credentials or a Main permit', () => {
  assert.equal(localTaskOfferSchema.safeParse(offer).success, true);
  for (const injected of [
    { media: undefined }, { voiceChannelId: undefined },
    { media: { ...media, protocol: 'websocket-opus' } },
    { media: { ...media, generation: 0 } },
    { spec: { operation: 'youtube.resolve', url } },
    { bot: { ...offer.bot, token: 'bot-token' } },
    { permit: nativePermit },
  ]) assert.equal(localTaskOfferSchema.safeParse({ ...offer, ...injected }).success, false);
  assert.equal(localTaskOfferSchema.safeParse({
    ...offer, media: { ...media, iceServers: [{ urls: ['turn:turn.example.test:3478'], username: 'authorized', credential: 'short-lived' }] },
  }).success, true);
});

test('preview bytes stay in IPC; wire handles bind task, original request and physical executor', () => {
  const ipcPreview = { operation: 'youtube.preview', mimeType: 'audio/ogg', audioBase64: 'AA==' };
  assert.equal(localTaskResultSchema.safeParse(ipcPreview).success, true);
  assert.equal(localWireTaskResultSchema.safeParse(ipcPreview).success, false);
  const result = localWireTaskResultSchema.parse({ operation: 'youtube.preview', ...preview });
  const previewOffer = localTaskOfferSchema.parse({
    ...offer, spec: { operation: 'youtube.preview', url }, media: undefined, voiceChannelId: undefined,
  });
  const accept = localTaskAcceptSchema.parse({ taskId: 'task', result });
  assert.equal(localTaskAcceptMatchesOffer(previewOffer, accept), true);
  for (const changed of [{ taskId: 'other' }, { requestId: 'another-ui-request' }, { executorSessionId: 'other-device' }]) {
    assert.equal(localTaskAcceptMatchesOffer(previewOffer, { ...accept, result: { ...result, ...changed } }), false);
  }
  assert.equal(localTaskAcceptSchema.safeParse({ ...accept, taskId: 'other' }).success, false);
  assert.equal(localWireTaskResultSchema.safeParse({ ...result, audioBase64: 'AA==' }).success, false);
  assert.deepEqual(commandAudioPreviewResultSchema.parse({ status: 'local', ...preview }), { status: 'local', ...preview });
  assert.equal(commandAudioPreviewResultSchema.safeParse({ status: 'local', ...preview, audioBase64: 'AA==' }).success, false);
  assert.equal(commandAudioPreviewResultSchema.safeParse({ status: 'ok', mimeType: 'audio/ogg', audioBase64: 'AA==' }).success, true);
});

test('task acceptance cannot replace the requested media or claim a different operation', () => {
  const accept = localTaskAcceptSchema.parse({ taskId: 'task', result: { operation: 'youtube.stream', track } });
  assert.equal(localTaskAcceptMatchesOffer(offer, accept), true);
  const otherTrack = { ...track, id: '12345678901', url: otherUrl };
  assert.equal(localTaskAcceptMatchesOffer(offer, { taskId: 'task', result: { operation: 'youtube.stream', track: otherTrack } }), false);
  assert.equal(localTaskAcceptMatchesOffer(offer, { taskId: 'task', result: { operation: 'youtube.resolve', track } }), false);
  assert.equal(localWireTaskResultSchema.safeParse({ operation: 'youtube.search', tracks: Array(21).fill(track) }).success, false);
});

test('wire source failures reuse the canonical runtime schema and recovery bound without diagnostics', () => {
  assert.equal(localSourceFailureSchema, localRuntimeSourceFailureSchema, 'Main and wire share one source-failure contract');
  assert.equal(LOCAL_EXECUTION_PROTOCOL_LIMITS.recoveryAttempts, LOCAL_EXECUTION_RUNTIME_LIMITS.sourceRecoveryAttempts);
  const maximum = LOCAL_EXECUTION_RUNTIME_LIMITS.sourceRecoveryAttempts;
  assert.deepEqual(localSourceFailureSchema.parse({ code: 'recovery_failed', attempts: maximum }),
    { code: 'recovery_failed', attempts: maximum });
  for (const failure of [
    { code: 'recovery_failed' },
    { code: 'recovery_failed', attempts: 0 },
    { code: 'recovery_failed', attempts: maximum + 1 },
    { code: 'recovery_failed', attempts: 1, stderr: 'Native diagnostic output' },
    { code: 'recovery_failed', attempts: 1, url: 'https://example.invalid/media' },
  ]) assert.equal(localSourceFailureSchema.safeParse(failure).success, false);
});

test('acceptance is separate from connected readiness, cancellation and fully played completion', () => {
  assert.equal(localTaskEventSchema.safeParse({ state: 'accepted', taskId: 'task', result: { operation: 'youtube.stream', track }, media }).success, true);
  assert.equal(localTaskEventSchema.safeParse({ state: 'accepted', taskId: 'task', result: { operation: 'youtube.stream', track } }).success, false);
  assert.equal(localTaskEventSchema.safeParse({ state: 'ready', taskId: 'task', mediaGeneration: 1 }).success, true);
  assert.equal(localTaskEventSchema.safeParse({ state: 'ready', taskId: 'task' }).success, false);
  assert.equal(localTaskEventSchema.safeParse({ state: 'completed', taskId: 'task' }).success, true);
  assert.equal(localTaskEventSchema.safeParse({ state: 'completed', taskId: 'task', mediaGeneration: 1, playedFrames: 2 }).success, true);
  assert.equal(localTaskEventSchema.safeParse({ state: 'completed', taskId: 'task', mediaGeneration: 1 }).success, false);
  assert.equal(localTaskEventSchema.safeParse({ state: 'completed', taskId: 'task', playedFrames: 2 }).success, false);
  for (const cause of ['requester_left_voice', 'requester_disconnected', 'bot_left_voice', 'permission_revoked', 'requested']) {
    assert.equal(localTaskEventSchema.safeParse({ state: 'cancelled', taskId: 'task', cause }).success, true);
    assert.equal(localTaskEventSchema.safeParse({ state: 'failed', taskId: 'task', reason: cause }).success, false);
  }
  assert.equal(localTaskEventSchema.safeParse({
    state: 'failed', taskId: 'task', reason: 'provider_unavailable', sourceFailure: { code: 'recovery_failed', attempts: 5 },
  }).success, true);
  assert.equal(localTaskEventSchema.safeParse({
    state: 'failed', taskId: 'task', reason: 'provider_unavailable', sourceFailure: { code: 'recovery_failed', attempts: 101 },
  }).success, false);
  for (const action of ['pause', 'resume', 'cancel']) {
    assert.equal(localTaskControlSchema.safeParse({ taskId: 'task', action, revision: 1 }).success, true);
  }
  assert.equal(localTaskControlSchema.safeParse({ taskId: 'task', action: 'cancel', revision: 1, cause: 'requester_left_voice' }).success, false);
});

test('dedicated signaling is generation-scoped and strictly data-only', () => {
  const signal = { taskId: 'task', mediaGeneration: 1, signal: { signalType: 'offer', sdp: { type: 'offer', sdp: dataSdp } } };
  assert.equal(localMediaSignalSchema.safeParse(signal).success, true);
  assert.equal(localMediaSignalSchema.safeParse({ ...signal, fromSessionId: 'forged' }).success, false);
  assert.equal(localMediaSignalSchema.safeParse({ ...signal, targetSessionId: 'another-device' }).success, false);
  assert.equal(localMediaSignalSchema.safeParse({ ...signal, mediaGeneration: 0 }).success, false);
  assert.equal(localMediaSignalSchema.safeParse({ ...signal, signal: { ...signal.signal, sdp: { type: 'answer', sdp: dataSdp } } }).success, false);
  for (const sdp of [
    '', 'v=0\r\n', dataSdp + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    dataSdp + ' m=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
    dataSdp + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
    dataSdp.replace('9 UDP', '65536 UDP'), dataSdp.replace('webrtc-datachannel', 'audio'),
  ]) {
    assert.equal(isLocalMediaSdp(sdp), false);
    assert.equal(localMediaSignalSchema.safeParse({ ...signal, signal: { signalType: 'offer', sdp: { type: 'offer', sdp } } }).success, false);
  }
  assert.equal(localMediaSignalSchema.safeParse({
    ...signal, signal: { signalType: 'candidate', candidate: null },
  }).success, true);
  assert.equal(localMediaSignalSchema.safeParse({
    ...signal, signal: { signalType: 'candidate', candidate: { candidate: 'candidate:opaque', sdpMid: '0', sdpMLineIndex: 0 } },
  }).success, true);
  assert.equal(localMediaSignalSchema.safeParse({
    ...signal, signal: { signalType: 'candidate', candidate: { candidate: 'x'.repeat(4097) } },
  }).success, false);
});

test('the channel contract rejects unordered, lossy and wrong-identity channels independently of microphone state', () => {
  const channel = { label: LOCAL_MEDIA_CHANNEL_LABEL, ...LOCAL_MEDIA_CHANNEL_OPTIONS, maxPacketLifeTime: null, maxRetransmits: null };
  assert.doesNotThrow(() => assertLocalMediaChannel(channel));
  for (const changed of [
    { ordered: false }, { protocol: 'other' }, { label: 'other' }, { maxPacketLifeTime: 1 }, { maxRetransmits: 0 },
  ]) assert.throws(() => assertLocalMediaChannel({ ...channel, ...changed }));
  assert.equal(LOCAL_MEDIA_FORMAT.creditWindowFrames * LOCAL_MEDIA_FORMAT.frameDurationMs, 500);
  assert.equal(LOCAL_MEDIA_FORMAT.sampleRate * LOCAL_MEDIA_FORMAT.frameDurationMs / 1000, 960);
  assert.equal(LOCAL_MEDIA_FORMAT.channels, 2);
});

test('browser-safe frame and control codecs round-trip and use big-endian counters', () => {
  const records: LocalMediaRecord[] = [
    { kind: 'frame', sequence: 0x01020304, opus },
    { kind: 'credit', consumedFrames: 100, windowEnd: 125 },
    { kind: 'played', playedFrames: 100 },
    { kind: 'end', finalSequence: 103 },
    { kind: 'drainAck', finalSequence: 103 },
  ];
  for (const record of records) assert.deepEqual(decodeLocalMediaRecord(encodeLocalMediaRecord(record)), record);
  assert.deepEqual([...encodeLocalMediaRecord(records[0]).subarray(0, 5)], [1, 1, 2, 3, 4]);
  const encoded = encodeLocalMediaRecord(records[0]);
  const outer = new Uint8Array(encoded.length + 11);
  outer.set(encoded, 7);
  const decoded = decodeLocalMediaRecord(outer.subarray(7, 7 + encoded.length));
  assert.deepEqual(decoded, records[0], 'A subarray must not read its containing buffer at offset zero');
  outer.fill(0);
  assert.deepEqual(decoded, records[0], 'Decoded Opus owns its bytes after receipt');
});

test('the Opus validator preserves 1..1275-byte and exactly 20 ms publisher limits', () => {
  const largest = new Uint8Array(1275);
  largest[0] = 0xf8;
  for (const packet of [opus, Uint8Array.of(0xf8), Uint8Array.of(0x01, 0), Uint8Array.of(0x83, 8), largest]) {
    assert.equal(isLocalOpusPacket(packet), true);
    assert.deepEqual(decodeLocalMediaRecord(encodeLocalMediaRecord({ kind: 'frame', sequence: 0, opus: packet })),
      { kind: 'frame', sequence: 0, opus: packet });
  }
  for (const packet of [new Uint8Array(), new Uint8Array(1276), Uint8Array.of(0x80), Uint8Array.of(0xf9), Uint8Array.of(0xfb), Uint8Array.of(0xfb, 0)]) {
    assert.equal(isLocalOpusPacket(packet), false);
    assert.throws(() => encodeLocalMediaRecord({ kind: 'frame', sequence: 0, opus: packet }));
  }
  assert.equal(localMediaRecordSchema.safeParse({ kind: 'frame', sequence: 0, opus: [0xf8] }).success, false);
});

test('binary decoding rejects unknown kinds, truncation, trailing controls and oversized packets', () => {
  for (const bytes of [
    new Uint8Array(0), new Uint8Array(4), new Uint8Array(LOCAL_MEDIA_MAX_RECORD_BYTES + 1),
    Uint8Array.of(1, 0, 0, 0, 0), Uint8Array.of(99, 0, 0, 0, 0),
    Uint8Array.of(2, 0, 0, 0, 0), Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0),
    Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0, 26),
    Uint8Array.of(3, 0, 0, 0, 0, 0), Uint8Array.of(4, 0, 0, 0, 0, 0), Uint8Array.of(5, 0, 0, 0, 0, 0),
    Uint8Array.of(1, 255, 255, 255, 255, 0xf8),
  ]) assert.throws(() => decodeLocalMediaRecord(bytes));
  for (const sequence of [-1, 0.5, NaN, Infinity, 0xffffffff, 0x100000000]) {
    assert.throws(() => encodeLocalMediaRecord({ kind: 'frame', sequence, opus }));
  }
  for (const count of [-1, 0.5, NaN, Infinity, 0x100000000]) {
    assert.throws(() => encodeLocalMediaRecord({ kind: 'played', playedFrames: count }));
    assert.throws(() => encodeLocalMediaRecord({ kind: 'end', finalSequence: count }));
    assert.throws(() => encodeLocalMediaRecord({ kind: 'credit', consumedFrames: count, windowEnd: count }));
  }
});

test('absolute credit bounds exactly 25 in-flight frames without confusing buffering with PLAYED', () => {
  let state = createLocalMediaFlowState();
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'frame', sequence: 0, opus }, 'executor'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 10, windowEnd: 35 }, 'bot'));
  state = advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 0, windowEnd: 25 }, 'bot');
  for (let sequence = 0; sequence < 25; sequence++) {
    state = advanceLocalMediaFlow(state, { kind: 'frame', sequence, opus }, 'executor');
  }
  assert.equal(state.playedFrames, 0);
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'frame', sequence: 25, opus }, 'executor'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 0, windowEnd: 26 }, 'bot'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'played', playedFrames: 1 }, 'bot'));
  state = advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 1, windowEnd: 26 }, 'bot');
  assert.equal(state.playedFrames, 0, 'Consumption/prefetch is not actual playback');
  state = advanceLocalMediaFlow(state, { kind: 'frame', sequence: 25, opus }, 'executor');
  state = advanceLocalMediaFlow(state, { kind: 'played', playedFrames: 1 }, 'bot');
  assert.deepEqual(advanceLocalMediaFlow(state, { kind: 'played', playedFrames: 1 }, 'bot'), state, 'Cumulative ACKs are idempotent');
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'played', playedFrames: 0 }, 'bot'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 0, windowEnd: 25 }, 'bot'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'frame', sequence: 25, opus }, 'executor'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'end', finalSequence: 25 }, 'executor'));
  state = advanceLocalMediaFlow(state, { kind: 'end', finalSequence: 26 }, 'executor');
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'drainAck', finalSequence: 26 }, 'bot'));
  state = advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 26, windowEnd: 51 }, 'bot');
  state = advanceLocalMediaFlow(state, { kind: 'played', playedFrames: 26 }, 'bot');
  state = advanceLocalMediaFlow(state, { kind: 'drainAck', finalSequence: 26 }, 'bot');
  assert.equal(state.drained, true);
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'played', playedFrames: 26 }, 'bot'));
});

test('flow guards reject wrong directions, skipped sequences, premature drain and frames after EOF', () => {
  let state = createLocalMediaFlowState();
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 0, windowEnd: 25 }, 'executor'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'frame', sequence: 0, opus }, 'bot'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'drainAck', finalSequence: 0 }, 'bot'));
  state = advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 0, windowEnd: 25 }, 'bot');
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'frame', sequence: 1, opus }, 'executor'));
  state = advanceLocalMediaFlow(state, { kind: 'end', finalSequence: 0 }, 'executor');
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'frame', sequence: 0, opus }, 'executor'));
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'end', finalSequence: 0 }, 'executor'));
  assert.equal(advanceLocalMediaFlow(state, { kind: 'drainAck', finalSequence: 0 }, 'bot').drained, true);
});

test('uint32 sequence exhaustion requires a fresh generation, never counter wraparound', () => {
  let state: LocalMediaFlowState = {
    nextSequence: 0xfffffffe, consumedFrames: 0xfffffffe, windowEnd: 0xffffffff,
    playedFrames: 0xfffffffe, finalSequence: null, drained: false,
  };
  state = advanceLocalMediaFlow(state, { kind: 'frame', sequence: 0xfffffffe, opus }, 'executor');
  assert.equal(state.nextSequence, 0xffffffff);
  assert.throws(() => advanceLocalMediaFlow(state, { kind: 'frame', sequence: 0xffffffff, opus }, 'executor'));
  state = advanceLocalMediaFlow(state, { kind: 'end', finalSequence: 0xffffffff }, 'executor');
  state = advanceLocalMediaFlow(state, { kind: 'credit', consumedFrames: 0xffffffff, windowEnd: 0xffffffff }, 'bot');
  state = advanceLocalMediaFlow(state, { kind: 'played', playedFrames: 0xffffffff }, 'bot');
  assert.equal(advanceLocalMediaFlow(state, { kind: 'drainAck', finalSequence: 0xffffffff }, 'bot').drained, true);
});
