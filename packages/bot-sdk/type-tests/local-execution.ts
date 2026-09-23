import {
  BotClient,
  LocalExecutionError,
  LocalExecutionRpcError,
  ProtocolErrorCode,
  type CommandDefinition,
  type LocalExecutionClient,
  type LocalExecutionProvider,
  type LocalExecutor,
  type LocalMediaTrack,
  type LocalMetadataTaskSpec,
  type LocalOpusStream,
  type LocalSourceContext,
  type LocalTaskCancellationCause,
  type LocalTaskFailureReason,
  type LocalWirePreviewResult,
} from '../dist/index.js';

export async function adapterContracts(
  provider: LocalExecutionProvider, executor: LocalExecutor, stream: LocalOpusStream,
  playFrame: (packet: Uint8Array) => Promise<void>,
): Promise<LocalMediaTrack[]> {
  const client: LocalExecutionClient = provider.localExecution('server');
  const source: LocalSourceContext = await client.retainSource('invocation', 'https://www.youtube.com/watch?v=abcdefghijk');
  const retained: LocalExecutor = client.executor({ kind: 'source', sourceContextId: source.sourceContextId });
  await client.checkSourceAvailability(source.sourceContextId, 'voice', { signal: stream.signal });
  const search = await executor.execute({ operation: 'youtube.search', query: 'query' });
  const resolved = await retained.execute({ operation: 'youtube.resolve', url: source.url });
  const track: LocalMediaTrack = resolved.track;
  const preview: LocalWirePreviewResult = await executor.execute({ operation: 'youtube.preview', url: track.url });
  const opened: LocalOpusStream = await retained.stream(
    { operation: 'youtube.stream', url: source.url }, { voiceChannelId: 'voice', signal: stream.signal },
  );
  const spec: LocalMetadataTaskSpec = { operation: 'youtube.resolve', url: track.url };
  await executor.execute(spec);
  const definition: CommandDefinition = {
    name: 'search', description: 'Search', localCapabilities: ['youtube-audio'],
    audioPreview: () => preview,
    handler(ctx) {
      client.executor({ kind: 'invocation', invocationId: ctx.invocationId });
    },
  };
  for await (const packet of opened.frames) {
    await playFrame(packet);
    opened.markFrameAdvanced();
  }
  await opened.setPaused(false);
  await opened.close();
  await opened.closed;
  await client.releaseSource(source.sourceContextId);
  void definition;

  // @ts-expect-error Streams must use the readiness-gated stream method.
  executor.execute({ operation: 'youtube.stream', url: source.url });
  // @ts-expect-error Source availability requires a target voice channel.
  client.checkSourceAvailability(source.sourceContextId);
  // @ts-expect-error A stream requires explicit current voice scope.
  executor.stream({ operation: 'youtube.stream', url: source.url }, {});
  // @ts-expect-error Stream options cannot be omitted.
  executor.stream({ operation: 'youtube.stream', url: source.url });
  // @ts-expect-error The terminal completion promise is readonly.
  opened.closed = Promise.resolve();
  // @ts-expect-error Delegated previews have no bot-visible audio bytes.
  preview.audioBase64;
  // @ts-expect-error Client-local metadata has no IP-bound media URL.
  track.audioUrl;
  return search.tracks;
}

export function terminalCause(error: LocalExecutionError): LocalTaskCancellationCause | LocalTaskFailureReason {
  return error.event.state === 'cancelled' ? error.event.cause : error.event.reason;
}

export function actualBotClient(bot: BotClient, error: LocalExecutionRpcError): LocalExecutionClient {
  const provider: LocalExecutionProvider = bot;
  const code: ProtocolErrorCode = error.code;
  void code;
  // @ts-expect-error An admission rejection is not a fabricated task event.
  error.event;
  return provider.localExecution('server');
}
