# @monky/bot-sdk

## Delegated local execution

`BotClient.localExecution(serverId)` returns the reusable local-execution client
for an authenticated server connection. The current fixed capability is
`youtube-audio`, with `youtube.search`, `youtube.resolve`, `youtube.preview` and
`youtube.stream` operations. Commands declare `localCapabilities: ['youtube-audio']`.

The requesting Monky client obtains consent and runs its managed tools. The SDK
does not resolve media on the bot host, accept arbitrary programs, forward browser
credentials, or move execution to another user. The command's wire
`localPreparation: { capability: 'youtube-audio' }` is only a readiness hint.
Native authorization permits remain inside the originating renderer/Main.

### Live interaction contexts

Create an executor using the context delivered by the SDK callback, never a
user-supplied session or request identifier:

| Callback | `local.executor(...)` context |
| --- | --- |
| Command handler | `{ kind: 'invocation', invocationId: ctx.invocationId }` |
| Autocomplete | `{ kind: 'autocomplete', requestId: ctx.requestId }` |
| Audio preview | `{ kind: 'audio-preview', requestId: ctx.requestId }` |

Autocomplete and preview callback request IDs are server-remapped. The server
separately retains the original client UI correlation for task offers and local
preview handles.

```ts
const local = bot.localExecution(ctx.serverId);
const executor = local.executor({
  kind: 'invocation',
  invocationId: ctx.invocationId,
});
const result = await executor.execute(
  { operation: 'youtube.search', query: 'example' },
  { signal: ctx.signal },
);
```

Search returns public tracks only. Resolve accepts a canonical
`https://www.youtube.com/watch?v=<11-character-id>` URL and returns public track
metadata. Preview returns `LocalWirePreviewResult`; an audio-preview callback can
return that result directly. Its `localPreviewId`, `taskId`, original `requestId`
and `executorSessionId` are bound to that exact preview. There are no preview
bytes, MIME payloads, base64 audio or resolved media URLs on this path.

### Queue-item ownership

During the original command invocation, call
`local.retainSource(ctx.invocationId, canonicalUrl, { signal: ctx.signal })`.
Give the returned `LocalSourceContext` to exactly one queue item's owner. It pins
the canonical URL, authenticated bot key and original executor socket, and
outlives successful retention and the invocation's abort signal.

Later, use `local.executor({ kind: 'source', sourceContextId })` for that item's
resolve or stream operation. A retained source cannot replace its URL or perform
a new search. Call `await local.releaseSource(sourceContextId)` when its queue
item is removed; release is idempotent for an owned reference while its bounded
release record remains retained. `stream.close()` does not release a source.

Leaving or moving voice cancels active streams with `requester_left_voice`, not
future retained items. Rejoining on the same live socket permits a fresh task
and media generation. A replacement connection, even with the same account and
session ID, cannot inherit the old socket's authority; such requests fail with
`requester_disconnected`. Notification, skipping the current item and retention
of future queue items belong to the bot's queue policy.

### Private Opus streaming

```ts
const executor = local.executor({
  kind: 'source',
  sourceContextId: source.sourceContextId,
});
const stream = await executor.stream(
  { operation: 'youtube.stream', url: source.url },
  { voiceChannelId, signal },
);
```

`stream()` resolves only after the private peer and reliable ordered data channel
are connected, native execution is accepted, and the server confirms both
endpoints' readiness. Negotiation starts from the pending offer, before native
acceptance, so there is no connection/start dependency cycle.

Consume `stream.frames` in the bot's existing 20 ms playback loop. After that
loop's `await voice.writeOpus(frame)`, call `stream.markFrameAdvanced()` exactly
once. Neither `frames` nor `writeOpus` supplies the application's playback timer.
Iterator prefetch/CREDIT only acknowledges consumption; PLAYED acknowledges the
actual advancement of the bot's playback clock, not audible delivery.

The reliable private channel has a 25-frame credit window. EOF is ordered with
the final frames, and drain ACK follows the final PLAYED. `stream.closed` resolves
only after matching server completion; an early WebSocket completion cannot
truncate buffered audio. A peer may close after receiving the verified drain
ACK, but missing server completion still times out.

Await `stream.setPaused(true | false)` alongside the bot's own playback pause
state. Each control requires its matching monotonic revision and can settle
independently of a blocked iterator read. `stream.close()` cancels active work and
awaits cleanup, or awaits server completion if playback has already drained.
Observe `stream.signal` and `stream.closed` even while paused.

The private data-only peer never publishes as a human microphone or replaces the
bot's P2P/SFU room publisher. It uses recipient-authorized ICE; SFU does not enable
otherwise unauthorized TURN. If private connectivity fails, execution fails
explicitly rather than forwarding audio through the generic WebSocket.

### Failures

`LocalExecutionError.event` is an admitted task's validated `failed` or
`cancelled` event. Cancellation causes are separate from failure reasons; safe
optional `sourceFailure` details retain actual recovery counts when supplied.

`LocalExecutionRpcError` represents a rejected source, task-admission or control
RPC. It exposes `code` and optional typed `reason` or `cancellationCause` from the
server's exact machine-code rejection. It does not invent an admitted task ID.
An ordinary request aborted before admission can instead reject with an
`AbortError`. Do not implement executor transfer or bulk queue removal as an
error fallback.
