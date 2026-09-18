# Client-side execution

Request known Monky operations on the initiating person's computer instead
of executing arbitrary code. Start with the [tutorial](/en/bots-desenvolvimento)
and declare `commands` and `local_execution` in `requestedCapabilities`.

**Reference:** [LocalExecutionClient](/en/bots-api-midia#localexecutionclient),
[LocalRequestContext](/en/bots-api-midia#localrequestcontext),
[LocalTaskSpec](/en/bots-api-midia#localtaskspec),
[LocalOpusStream](/en/bots-api-midia#localopusstream) and
[typed errors](/en/bots-api-midia#localexecutionerror).

## Example: search without starting playback

This command prepares the capability with consent, searches metadata and
replies privately. It does not join voice, create a queue or start streaming.
The query is limited to 200 characters.

```ts
bot.command({
  name: 'search-local',
  description: 'Search public video metadata using your client',
  localCapabilities: ['youtube-audio'],
  options: [{ name: 'query', description: 'Search query', type: 'string', required: true }],
  localizations: {
    'pt-BR': {
      name: 'buscar-local',
      description: 'Pesquisa metadados de vídeos públicos pelo seu cliente',
      options: { query: { description: 'Consulta de pesquisa' } },
    },
  },
  handler: async (ctx) => {
    const en = ctx.locale === 'en';
    const query = ctx.args.query;
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
      ctx.reply(en ? 'Use a query of 1–200 characters.' : 'Use uma consulta de 1 a 200 caracteres.');
      return;
    }
    const executor = bot.localExecution(ctx.serverId).executor({
      kind: 'invocation',
      invocationId: ctx.invocationId,
    });
    const result = await executor.execute(
      { operation: 'youtube.search', query: query.trim() },
      { signal: ctx.signal },
    );
    if (ctx.signal.aborted) return;
    ctx.reply(en
      ? `Found ${result.tracks.length} results. No audio has been played.`
      : `Encontrados ${result.tracks.length} resultados. Nenhum áudio foi reproduzido.`);
  },
});
```

Autocomplete uses `{ kind: 'autocomplete', requestId }`; previews use
`{ kind: 'audio-preview', requestId }`. Use IDs delivered to the callback,
not the renderer's original ID. A retained source uses
`{ kind: 'source', sourceContextId }` and has its own lifetime.

## Local capability execution

This infrastructure belongs to the SDK and client, not exclusively to MonkyBot. A command declares `localCapabilities: ['youtube-audio']` only when it needs local processing. Control commands and queue queries must not require installation just to execute.

When the person **selects the command**, by click or keyboard, Monky starts its prerequisites before argument entry, search, or execution. When needed, authorization is requested **per bot, server, installation, and public key**, on this device. The person can deny access, allow it until the server connection ends, or keep authorization until revocation. Equal names do not share permission. Merely browsing the list does not request authorization. Closing the command or changing channels cancels its preparation; a late completion cannot execute the command.

The request uses a Monky-styled, Main-owned modal. Before approval, it describes Node.js, yt-dlp, and FFmpeg, each tool's purpose, and a conservative additional-storage ceiling, distinguishing installed files from new downloads. After approval, the **same modal** tracks installation: downloads show actual bytes and a progress bar; lookup, verification, and extraction use an animation without invented percentages. Choices and progress remain visible even when the description needs scrolling. The command is released only after preparation and authorization finish.

Completed preparation is reused on the same connection, including when selecting the command again. Editing the query shows search loading, not a new installation notice. If installation fails, **Try again** repeats preparation in the same modal, preserving the chosen duration and reusing completed tools. If previous cleanup failed, this action retries cleaning retained files before installing again, only after confirming that native processes have stopped. An invalid tool or persistent lock still blocks installation; the error and attempt number remain visible. Cancelling installation waits for shutdown and cleanup; failed preparation does not save a new permission.

Tasks still verify executable integrity before use. The client reuses only the native version-check result of a generation already verified in this process; replacing files, removing a tool, or restarting the client requires a new check. For music, local streaming already resolves a fresh source and reauthorizes the requester, so the queue does not create another lookup task immediately before it. Enqueue and skip requests receive processing acknowledgements, and each track has a preparation notice before **Now playing**; the playback notice appears only after the first frame is sent to voice.

Search, preview, command startup, bot replies, form/selector submissions, downloads, and cancellation use animated waiting indicators while preserving localized text and available cancellation controls. Indicators stop on completion or failure and respect the system's reduced-motion preference.

In **Settings → Bot tools**, the person can inspect installed tools, versions, storage, cache, permissions, and tasks. **Manage local permissions and tools** in bot settings opens this personal section, not an administrative server permission.

**Remove tool** and **Clear cache** also use a Monky-styled confirmation instead of a native system dialog. The same modal shows progress, allows retrying a failed operation, and closes only after completion. The person can cancel before confirming; once confirmed, cleanup must finish stopping affected tasks. The settings tab releases other actions as soon as the operation finishes, without waiting for inventory refresh; unanswered reads show an error that allows another refresh.

- **Tools:** portable Node.js, yt-dlp, and FFmpeg come from Monky-known recipes with integrity verification. They are not global installations or changes to the person's `PATH`.
- **Sharing:** bots may reuse the same installed files; their authorizations remain separate.
- **Revocation and removal:** stop affected work. Removing a tool revokes dependent capabilities; the bot cannot silently reinstall it.
- **Clear cache:** stops local tasks but keeps tools and permissions. Displayed space is retained storage, not the total audio already transmitted.

::: warning Trust and connectivity limits
A separate process improves lifecycle isolation but **is not an operating-system sandbox**. The SDK requests fixed operations; it does not receive a shell API, executable paths, or bot-supplied scripts. Electron Main validates consent, rather than a renderer preference granting it.

Transmission requires a private WebRTC channel between client and bot, even when the room uses SFU. A working SFU call does not prove this private path is reachable. The existing server-authorized ICE configuration is reused; there is no automatic TURN activation, WebSocket audio, or replacement executor if the connection fails.
:::

### SDK contracts

`BotClient` implements `LocalExecutionProvider`: obtain the execution client with `const client = bot.localExecution(serverId)`. The public `LocalExecutionClient`, `LocalExecutor`, and `LocalOpusStream` contracts separate the authorized source, each task, and the playback clock:

| Operation | Responsibility |
|-----------|----------------|
| `bot.localExecution(serverId)` | Select the server connection without selecting another user |
| `client.executor(context)` | Use an authorized invocation, autocomplete, preview, or source reference |
| `executor.execute(spec, { signal })` | Execute `youtube.search`, `youtube.resolve`, or `youtube.preview` |
| `client.retainSource(invocationId, url, { signal })` | Retain an item's origin and canonical URL from a real invocation |
| `client.checkSourceAvailability(sourceContextId, voiceChannelId, { signal })` | Confirm the original connection's presence and access without starting a client task |
| `executor.stream(spec, { voiceChannelId, signal })` | Open a new `youtube.stream` task for the current room |
| `client.releaseSource(sourceContextId)` | Release a removed or completed item's reference |

In autocomplete and preview contexts, `requestId` is the server-remapped identifier delivered to the SDK callback. The returned preview may contain a different `requestId` from the original client request: return `LocalWirePreviewResult` without rewriting its fields. It contains references only; Ogg bytes remain on the originating client. `LocalMediaTrack` metadata has no `audioUrl`, and Main authorization tokens never belong in command messages.

A retained reference is not an active task. Do not make the invocation's `AbortSignal` the playback lifetime, or substitute another session on the same account after disconnection. Each playback opens a new task subject to current authorization and presence.

To resume entries waiting for their requester, use `checkSourceAvailability()`: the server checks the retained source, original physical connection, room, and current access. Success does not install tools, open a transport, or replace consent and the next stream's admission. Leaving and rejoining voice on the same connection can make the source available; reconnecting the client cannot revive references from the closed connection, even when reusing the same `invokerSessionId`. `voiceParticipantsChanged` events may trigger sequential, coalesced checks, but participant counts, a recent command, or another session are never authorization.

The stream provides Opus packets through `frames`. The bot maintains a 20 ms cadence and calls `markFrameAdvanced()` **once per frame consumed by its clock**, after `writeOpus()`. Prefetch, receive credit, and arriving bytes are not playback progress. Await `setPaused()` and observe `stream.signal` even while the queue is paused. `LocalExecutionError.event` distinguishes failure, voice departure, disconnection, and revocation; notifications and queue changes remain bot policy.

A rejection before task admission, or during a source-reference/control operation, uses `LocalExecutionRpcError`. Inspect `code` and, when present, `reason` or `cancellationCause`; this error does not invent a task event. Do not classify a consent refusal or transport failure as provider authentication failure.

Decoder EOF does not mean the last frame has been consumed. Preserve the tail through final acknowledgments: `stream.closed` resolves only after playback drain and server-confirmed completion, and rejects on failure or cancellation. Await `stream.close()` to cancel active work or await completion of an already-drained stream; rejection of `closed` alone does not replace teardown. Closing a stream does not automatically release its source reference. On the client, the native process may finish before playback acknowledgments without losing cancellation or revocation of the remaining task.

Using the requester's computer does not guarantee provider acceptance. The initial capability accepts eligible individual public YouTube videos only, without accounts, cookies, or bypassing restrictions. Provider refusals remain explicit errors.

### Integrated checkout validation

The modal and search feedback have dedicated regressions in `npm run test:local-execution --workspace=@monky/client`. To exercise only modal presentation, decisions, progress, and cancellation, use `npm run test:local-preparation --workspace=@monky/client`. Its preload is an isolated bundle, also generated by the normal build, preserving `sandbox: true` without exposing a generic API to the document.

After building Monky, the test below starts an isolated server, SDK, and two Electron clients in real P2P and SFU rooms. It measures decoded listener audio and checks consent, mute/PTT, pause, voice departure, final drain, and resource teardown. It does not reuse personal profiles or servers.

```powershell
$env:MONKY_WORKER_TEST_FFMPEG = 'C:\path\ffmpeg.exe'
npm run test:local-execution:e2e --workspace=@monky/client
```

To also exercise **MonkyBot's production command registration**, build the bot with the compatible SDK installed and, from the Monky root, select its checkout:

```powershell
$env:MONKY_LOCAL_E2E_MUSIC_BOT_ROOT = 'C:\path\MonkyBot'
npm run test:local-execution:e2e --workspace=@monky/client
Remove-Item Env:\MONKY_LOCAL_E2E_MUSIC_BOT_ROOT
```

This mode loads the SDK actually installed in the bot and exercises search, preview, `/play`, a mixed queue, `/pause`, requester rejoin, and `/skip` through the UI. Both modes use controlled authored audio: they do not access YouTube or prove that the provider will accept a real request.
