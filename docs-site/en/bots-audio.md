# Audio previews and downloads

Previewing, downloading and publishing to voice are different operations.
These examples extend [Your first bot](/en/bots-desenvolvimento): declare
`commands`, and also `sound_download` for commands using `downloadsSound`.
For call transmission, use the [voice guide](/en/bots-voz).

**Reference:** [AudioPreviewSource](/en/bots-api-interacoes#audiopreviewsource),
[CommandAudioPreviewContext](/en/bots-api-cliente#commandaudiopreviewcontext),
[SoundDownloadRequest](/en/bots-api-interacoes#sounddownloadrequest) and
[SoundDownloadResult](/en/bots-api-interacoes#sounddownloadresult).

## Selections with audio previews

Any plugin can add `audio` to a `SelectionChoice`. The `audio.url` variant works for static command choices, autocomplete responses, `select` fields in `ctx.prompt()`, `ctx.choose()`, and persistent `createSelector()` choices. The on-demand `audio.resourceId` variant is intended for current autocomplete choices. Without `audio`, the option remains a plain selection; no bot-specific component is needed.

```ts
import type { SelectionChoice } from '@monky/bot-sdk';

const choices: SelectionChoice[] = [
  {
    label: 'Bell',
    value: 'bell',
    description: 'Short bell sound',
    audio: {
      url: 'https://cdn.example.com/sounds/bell.mp3',
      fileName: 'bell.mp3',
      durationMs: 1200,
    },
  },
];
```

In the variant above, `audio.url` is required; `fileName` and `durationMs` are optional. Previews use public HTTPS and the same formats and 3 MiB limit as downloads. The client loads bytes into memory through the native process, validating DNS, redirects, MIME, and audio structure; it never assigns the external URL directly to a renderer player. This variant continues to work unchanged, including sources such as MyInstants.

Options can have a description, preview button, and a playback progress bar with elapsed/total time. There is **one shared volume control (0–100%) per command**, retained across results and parameters, with a visible percentage. Forms with multiple audio fields also share one control; persistent selectors have their own volume. Listening or adjusting volume **does not select, submit, or save the file to the library**. Only one preview plays at a time, locally through the chat-media output (or the shared output when no category-specific advanced setting is configured); output changes also apply to the active preview, and nothing is broadcast to voice. Closing or changing the selector stops loading/playback and releases resources. Previews do not require a configured folder. Suggestions appear in a scrollable panel above the composer; the fields below fit their placeholder/content, respect available width, and highlight focus or invalid values. Optional parameters can be removed with **×** without losing their draft.

### Generate audio only when listening

When a source does not provide a small public HTTPS audio file, return `audio: { resourceId, fileName?, durationMs? }` from autocomplete and declare `audioPreview` on the command. **Never combine `url` and `resourceId`.** `resourceId` is up to 128 characters; it identifies a provider resource, not a URL for the client to fetch.

This example reads an **authored file, at most 10 seconds and 256 KiB**, which you must provide at `audio/bell.ogg` alongside the module. To generate clips dynamically, replace only the body of `loadPreview`: media fetching, source resolution, and conversion belong in the bot process, respecting `signal`, never in autocomplete. Metadata search remains in the `autocomplete` callback.

```ts
import { readFile } from 'node:fs/promises';
import type { CommandAudioPreviewContext, CommandAudioPreviewData } from '@monky/bot-sdk';

const previews = new Map([
  ['bell', { label: 'Bell', file: new URL('./audio/bell.ogg', import.meta.url) }],
]);

async function loadPreview(ctx: CommandAudioPreviewContext): Promise<CommandAudioPreviewData> {
  const source = previews.get(ctx.resourceId);
  if (!source) throw new Error('Unknown preview resource');
  return { bytes: await readFile(source.file, { signal: ctx.signal }), mimeType: 'audio/ogg' };
}

bot.command({
  name: 'preview-sample',
  description: 'Choose an audio sample',
  options: [{ name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true }],
  autocomplete: ({ query }) => [...previews].filter(([, source]) =>
    source.label.toLowerCase().includes(query.toLowerCase())
  ).map(([id, source]) => ({
    label: source.label, value: id,
    audio: { resourceId: id, fileName: `${id}.ogg`, durationMs: 10_000 },
  })),
  audioPreview: loadPreview,
  handler: (ctx) => {
    if (typeof ctx.args.sound !== 'string' || !previews.has(ctx.args.sound)) throw new Error('Unknown sample');
    ctx.reply(`Selected: ${ctx.args.sound}`);
  },
});
```

`CommandDefinition.audioPreview` accepts a direct value or a `Promise<CommandAudioPreviewData>`. The exported `CommandAudioPreviewContext` contains `resourceId`, `serverId`, `optionName`, `locale` (`'pt-BR' | 'en'`), `signal`, and immutable `settings` captured in the same search. It has no invocation, queue, publish, or download methods. `CommandAudioPreviewData` contains only `bytes: Uint8Array` (a `Buffer` also works) and `mimeType: 'audio/ogg' | 'audio/mpeg' | 'audio/wav'`.

- Only the listen button calls the provider. Typing, navigating, or selecting does not generate the clip; listening neither executes a command nor changes the queue.
- Transport uses the **existing authenticated WebSocket**, person → server → bot → person. It requires no `serve()`, public hosting, signed URL, or additional port. The server replaces provider IDs with ephemeral tokens tied to the same person, device, channel, bot, command, option, and search; only advertised, still-valid choices can be previewed.
- Generation has a **30-second** deadline; limits are **256 KiB of bytes** (base64 only on the wire) and **10 seconds of playback**. The native process validates MIME, size, and structure before creating the player's local source. This does not relax the URL variant's HTTPS/DNS/redirect protections.
- Lazy choices expire after **60 seconds**, or sooner when the query/option/command changes, the menu closes, access is lost, settings change, or a connection disconnects. Switching previews cancels the previous one. Pass `signal` to subprocesses too and release their resources.
- Up to **4 providers run concurrently per `BotClient`**, with 100 pending requests per server. A provider that ignores abort retains its slot until it settles. Errors, timeout, empty bytes, invalid MIME, and size overflow return explicit failures; exceptions thrown by providers also reach the SDK's `error` event.

## Authorized local downloads

Declare `downloadsSound: true` when a command may request **one** soundboard download. The composer explains this capability, requires authorization for each execution, and blocks activation with a notice if the folder is unavailable or unauthorized. **Selecting/executing a command never opens a folder picker.** Monky prepares a default folder in the local profile when none has been chosen; a previously confirmed folder is reused. Users can change it in soundboard settings. This does not grant the bot general filesystem access.

```ts
bot.command({
  name: 'download-sample',
  description: 'Download a soundboard sample',
  downloadsSound: true,
  handler: async (ctx) => {
    const result = await ctx.downloadSound({
      url: 'https://cdn.example.com/sounds/bell.mp3',
      fileName: 'bell.mp3',
      title: 'Bell',
    });
    if (result === null) return;
    const en = ctx.locale === 'en';
    switch (result.status) {
      case 'downloaded':
        ctx.reply(en ? 'Sound saved to your soundboard.' : 'Áudio salvo na sua soundboard.');
        break;
      case 'exists':
        ctx.reply(en ? 'That file already exists; nothing was replaced.' : 'O arquivo já existe; nada foi substituído.');
        break;
      case 'failed':
        ctx.reply(en ? `Download failed (${result.reason}).` : `Falha no download (${result.reason}).`);
        break;
      case 'cancelled':
        ctx.reply(en ? 'Download cancelled.' : 'Download cancelado.');
        break;
    }
  },
});
```

Replace the example URL with valid public audio. In a catalog bot, resolve the selected `value` into URL, filename, and title only; **do not download audio on the bot**. `ctx.downloadSound()` routes the request to the computer of the connection that initiated the command. Neither server nor bot/VPS receives the file or its local path, and another device belonging to the same user does not inherit the request.

Before starting the transfer, the client confirms the actual request, showing the bot, title, filename, folder, and source. In the same dialog, users can **rename the file**, starting from the original name and preserving its extension. Invalid names block confirmation; existing files are never overwritten. The chosen name appears on the local card but is not sent to the bot/server. The **“Don't ask again”** switch applies only to this bot, server/endpoint, and identity in this local profile; it does not authorize other plugins. When enabled, future downloads use the name suggested by the bot without repeating the confirmation or reusing a previous custom name. To ask again, **right-click the bot → Bot settings → My preferences → Ask for a file name before downloading** and save. This does not reset or change other bots' confirmations. Declining returns `cancelled` without writing or opening a folder picker. Cancellation, disconnection, and expiry also close a pending confirmation.

Chat displays a private card with server-authenticated bot/command/caller attribution, a waiting-for-confirmation state, and then actual client progress. Bytes and percentages stay local; you do not need to send progress messages. Completion is based on the file being written, not the handler ending.

The result, exported as `SoundDownloadResult`, is discriminated by `status`:

| Status | Meaning |
|--------|---------|
| `downloaded` | The new file was written |
| `exists` | The destination already existed and was not changed |
| `failed` | A typed failure in `reason` |
| `cancelled` | The local download was cancelled while its invocation still existed |

`failed.reason` can be `no_folder`, `invalid_request`, `invalid_url`, `blocked_url`, `invalid_file_name`, `unsupported_audio`, `too_large`, `http_error`, `network_error`, `write_failed`, or `timeout`. Results contain no path, bytes, or raw system error. `null` means the invocation itself ended, expired, or lost its connection; return from the handler in that case.

Public HTTPS without credentials or fragments and plain filenames up to 128 characters are accepted (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, or `.webm`); `title` allows up to 100 characters and the URL up to 2,048. The client validates destinations/redirects, content, and size, and never overwrites existing files. The limit is **3 MiB (3,145,728 bytes)**, matching playback, available as `LIMITS.MAX_SOUNDBOARD_FILE_SIZE` in shared and the SDK.

Always `await` the result. Only one request is allowed per invocation, even after `exists`, failure, or cancellation; retrying requires a new authorized execution. The request deadline is two minutes, including the confirmation wait and bounded by the invocation's remaining lifetime. Cancellation, disconnection, or ending the handler interrupts pending work. Ended contexts, commands without authorization, and repeated calls raise an SDK error without initiating another download.
