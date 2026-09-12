# Bots

Monky has a complete bot system that lets you automate tasks, add custom commands, and integrate external services into your server.

## What is a bot?

A bot is an **external process** that connects to the Monky server via WebSocket, just like any other user. The difference is that bots:

- Authenticate with a **token** instead of a password
- Can register **slash commands** (`/ping`, `/dice`, etc.)
- Show a **BOT** badge in the member list
- Use their own name and photo in chat messages and forms
- Don't count toward the user limit (they have their own limit: `maxBots`)

The bot runs on **its own machine** (VPS, cloud, your PC), not on the Monky server. The server only routes messages — all processing happens on the bot side.

```
User types /ping
        ↓
Monky Server (routes)
        ↓
Bot (processes) → ctx.reply('🏓 Pong!')
        ↓
Monky Server (delivers only to the caller)
        ↓
User sees the response
```

## Two ways to add a bot

### 1. Manual (token)

Ideal for internal bots on a specific server.

1. In the client, go to **Server Settings → Bots**
2. Enter a name, optionally choose a photo, and click **Create**
3. Copy the token (shown **only once**)
4. Use the token in your bot code to connect

### 2. Via URL (Marketplace)

Ideal for distributed bots that serve multiple servers.

1. The bot developer publishes an **HTTP manifest** (name, description, registration URL)
2. In the client, go to **Server Settings → Bots**
3. Paste the manifest URL in the "Add Bot from URL" field and click **Add**
4. The server fetches the manifest, creates the bot, and sends the token automatically
5. The bot auto-connects and registers its commands

## Creating your own bot

### Permissions and channels

In **Server Settings → Roles**, **Add and manage bots** controls who can register, configure, or remove bots; **Use bot commands** controls who can use their commands and interactions. Command access is initially enabled for existing members and roles.

When creating or editing a text channel, the **Allow bot commands** switch starts enabled. Turning it off blocks commands and responses to forms and selectors in that channel, **including for administrators**. Typing `/` displays the reason. Permission changes also affect interactions that are already open; ordinary messages and reactions continue to follow their own permissions.

### Prerequisites

- **Node.js 18+**
- Client, server, and SDK compatible with **protocol 13**
- The `@monky/bot-sdk` package from the matching release

::: warning Update together
The command protocol has changed: update the **client, server, and bot** together. Different protocol versions cannot connect. In the new SDK, `ctx.args` contains typed values and `ctx.reply()` is private; use `ctx.publish()` only for results that should appear for the channel.
:::

### SDK Installation

```bash
curl -fsSL https://monkyorg.github.io/install-bot-sdk.sh | bash
```

To install a beta version:

```bash
curl -fsSL https://monkyorg.github.io/install-bot-sdk.sh | bash -s -- --beta
```

<details>
<summary>Manual installation (without the script)</summary>

Download the `.tgz` from the desired version at [Releases](https://github.com/MonkyOrg/Monky/releases) and install with:

```bash
npm install https://github.com/MonkyOrg/Monky/releases/download/vX.Y.Z/monky-bot-sdk-X.Y.Z.tgz
```

</details>

### Automatic bot CLI and packaging

The SDK also provides `monky-bot-sdk`, a build tool that creates a self-contained
`.tgz` with its **management CLI already generated**. Do not copy the MonkyBot CLI
into every bot: declare the entry and options in `package.json`.

```json
{
  "name": "@my-org/my-bot",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "package": "monky-bot-sdk build",
    "cli": "monky-bot-sdk cli"
  },
  "monkyBot": {
    "cliName": "my-bot",
    "displayName": "My Bot",
    "entry": "dist/index.js",
    "files": ["dist", "assets"],
    "modes": ["manual"]
  }
}
```

`npm run package` runs the compiler script and produces
`release/my-bot-1.0.0.tgz`, including the compiled entry, declared resources, SDK
and the production dependency tree actually installed. `files` accepts relative
files and directories, not globs; remove `assets` if it does not exist.
Runtime data, real `.env` files, `.keys` and authenticated registrations are not
release material. Local dependencies other than SDK/shared must declare their
own publication files in `package.files`.

Use `monky-bot-sdk build --version 1.1.0-beta --out release` to override the
artifact version. `--skip-build` packages an existing compilation but still
validates the entry and SDK. Do not put the tool in the compiler's own `build`
script: keep compilation and `package` separate to prevent recursion.

On the server, install the `.tgz` with npm:

```text
npm install -g --offline --ignore-scripts my-bot-1.0.0.tgz
my-bot setup
my-bot start
my-bot status
my-bot logs
```

The CLI provides `setup`, `start`, `stop`, `restart`, `status`, `logs` and `config`,
with a PM2 process and configuration isolated by bot name. `start --foreground`
runs without PM2 for development. `npm run cli -- setup` uses the same CLI in a
local checkout after compilation.

In manual mode, `setup` asks for the server and the **token environment variable
name**, not a token value to save in the configuration. Provide `MONKY_BOT_TOKEN`
(or the selected variable) in the operator/service environment before `start`
and `restart`. For automation, use
`setup --non-interactive --server-url ws://localhost:3000 --token-env MONKY_BOT_TOKEN`.
Configuration and identity live in `~/.<cliName>`, outside the package;
`MONKY_BOT_CLI_HOME` changes the base directory while keeping each bot's subdirectory.

The CLI generates/reuses the identity and supplies `MONKY_BOT_PUBLIC_KEY`,
`MONKY_SERVER_URL`, `MONKY_BOT_TOKEN` and `MONKY_BOT_NAME` to the process. The bot
entry must consume these variables. Declare `marketplace` in `modes` only if that
entry also implements the `MONKY_SERVE`/`bot.serve()` flow.

### Optional CLI updates

`update` and enabling `autoupdate` **only work when the author explicitly
configures GitHub Releases** in the build definition:

```json
{
  "monkyBot": {
    "releases": {
      "url": "https://github.com/my-org/my-bot/releases",
      "assetName": "my-bot-{version}.tgz",
      "tokenEnv": "GH_TOKEN"
    }
  }
}
```

This snippet extends the previous configuration. Without `releases`, the SDK
does not infer a source from `repository`, `git origin`, the SDK repository or
the npm registry. An invalid URL fails rather than enabling another source.

`update --check` only queries; `update` follows stable and `update --beta` includes
pre-releases. Selection uses semantic versions, without downgrades or reinstalling
the same version. Auto-update follows the installed channel unless `--beta` is
explicitly enabled. None of these commands publishes or promotes releases.

Installing an update requires the globally installed CLI in the current npm
prefix; source checkouts and local installations only support `--check`.
The SDK verifies the downloaded package name, version and CLI, then installs the
self-contained archive offline without running installation scripts. Use
`update --yes` without an interactive terminal. Configuration and identity files
remain outside the installation.

For a private repository, supply the read token through the indicated environment
variable, never through the package or URL. `autoupdate off` and `status` remain
available to administer an old schedule even if a later version removes its
update source.

### Basic example

```ts
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  serverUrl: 'ws://your-server:3000',
  token: 'YOUR_BOT_TOKEN',
  publicKey: 'YOUR_ED25519_PUBLIC_KEY_HEX',
});

bot.command({
  name: 'ping',
  description: 'Replies with pong!',
  handler: (ctx) => ctx.reply('🏓 Pong!'),
});

bot.command({
  name: 'dice',
  description: 'Roll a dice',
  options: [
    { name: 'sides', description: 'Number of sides', type: 'integer', min: 2, max: 100, placeholder: 'E.g. 20' },
  ],
  handler: (ctx) => {
    const sides = typeof ctx.args.sides === 'number' ? ctx.args.sides : 6;
    const result = Math.floor(Math.random() * sides) + 1;
    ctx.reply(`🎲 Result: **${result}**`);
  },
});

bot.on('error', (error) => console.error(error));
bot.connect();
```

### Anatomy of a command

```ts
bot.command({
  name: 'name',               // Slash command name (without the /)
  description: 'Description',  // Shown in the command dropup
  options: [                   // Parameters (optional)
    {
      name: 'param',
      description: 'Parameter description',
      type: 'string',         // Parameter type
      required: true,          // Required?
    },
  ],
  handler: (ctx) => {
    // ctx.channelId  — channel where it was invoked
    // ctx.invokerId  — user ID
    // ctx.invokerNickname — nickname
    // ctx.serverId   — server ID (useful in multi-server mode)
    // ctx.args       — arguments { name: string | number | boolean }
    // ctx.locale     — caller's language ('pt-BR' or 'en')
    // ctx.reply()    — reply only to the caller, within the chat
    // ctx.publish()  — explicitly publish a result in the channel
    // ctx.prompt()   — await a private form; may be called in multiple steps
    // ctx.choose()   — await a private choice through buttons or a dropdown
    // ctx.downloadSound() — await an authorized local soundboard download
    // ctx.signal     — aborts on cancellation, disconnect, timeout or completion
  },
});
```

### Guided parameters in chat

Typing `/` opens a menu with frequently used commands and sections grouped by bot. Each item identifies the command, its description, and its bot. While browsing, required parameter chips and the optional parameter count help choose a command.

Selecting a command with parameters identifies **which bot and command** are selected in a compact composer with named fields, descriptions, and placeholders. Optional parameters can be added when needed. Submission uses the names declared in `options`; there is no need to join values with commas. Commands without parameters that do not request local downloads, such as `/ping` and `/enquete`, start their interaction immediately when selected.

Usage frequency stays local and is scoped by server and identity. Only counts and recency are stored, never the values entered in parameters.

| Type | Control | Value in `ctx.args` |
|------|---------|---------------------|
| `string` | Text; `choices` for fixed selection or `autocomplete: true` for dynamic suggestions | `string` |
| `integer` | Whole number, with optional `min` and `max` bounds | `number` |
| `boolean` | Switch | `boolean` |
| `user` | Member selector | Member ID (`string`) |

`required: true` prevents submission without a value. An unfilled optional parameter is omitted; valid values such as `false` and `0` are retained. The server validates parameters again before invoking the bot. Two bots can have a command with the same name: selection in chat retains the chosen bot.

Required parameters appear when selecting the command; all must be valid before execution is enabled. Remaining optional parameters appear under `+N`: click it or press **Right arrow at the end of the last field** to list parameters you can add. Selecting one opens its input without executing the command. Inside text, the arrow still moves the caret normally.

### Autocomplete before execution

A `string` option can declare `autocomplete: true`. The command then requires an `autocomplete` callback; do not combine this option with static `choices`.

```ts
const catalog = [
  { label: 'Bell', value: 'bell', description: 'Short bell sound' },
  { label: 'Drum', value: 'drum', description: 'Single drum hit' },
];

bot.command({
  name: 'findsound',
  description: 'Find a sound',
  options: [
    { name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true },
  ],
  autocomplete: ({ query }) =>
    catalog.filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase())),
  handler: (ctx) => {
    ctx.reply(ctx.locale === 'en' ? `Selected: ${ctx.args.sound}` : `Selecionado: ${ctx.args.sound}`);
  },
});
```

The callback receives `{ query, optionName, args, locale, serverId, signal }` and may return a list or a `Promise` of `SelectionChoice` (`{ label, value, description?, audio? }`). `args` contains only the other filled, valid options; missing required options are allowed at this stage. `query` contains the text of the option being edited.

This example keeps the catalog in the bot. For an external source, replace filtering with a **metadata** search, pass `signal` to `fetch`, and validate the response. The callback receives neither an invocation nor reply/download methods. Queries are sent to the selected bot while the person types; they are not published in the channel or persisted in history.

The client debounces for 250 ms; the server allows one search per user every 500 ms, combining their devices. Only the originating connection's latest search remains valid, with a 15-second deadline. Closing the composer, cancellation, losing access, or disconnection aborts the search; stale responses are discarded. Return at most 20 choices with unique values: `label` up to 100 characters, `value` up to 2,000, and `description` up to 500. `query` accepts up to 200 characters; a bot may impose a smaller limit. An empty list means no results.

Arrow keys only navigate. Enter or a click confirms a suggestion. **Without optional parameters, if every required parameter is valid, the same gesture executes the command exactly once.** If optional parameters exist, selection only fills the field: the composer stays open to use `+N`, and a later Enter or the execute button submits. Missing required parameters must be filled before execution. Typing text without a valid choice does not execute the command. Editing the text invalidates the previous selection. `value` is an opaque identifier, not authorization: the handler must validate it again before resolving the result's metadata.

### Selections with audio previews

Any plugin can add `audio` to a `SelectionChoice`. The same contract works for static command choices, autocomplete responses, `select` fields in `ctx.prompt()`, `ctx.choose()`, and persistent `createSelector()` choices. Without `audio`, the option remains a plain selection; no bot-specific component is needed.

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

`audio.url` is required; `fileName` and `durationMs` are optional. Previews use public HTTPS and the same formats and 3 MiB limit as downloads. The client loads bytes into memory through the native process, validating DNS, redirects, MIME, and audio structure; it never assigns the external URL directly to a renderer player.

Options can have a description, preview button, and a playback progress bar with elapsed/total time. There is **one shared volume control (0–100%) per command**, retained across results and parameters, with a visible percentage. Forms with multiple audio fields also share one control; persistent selectors have their own volume. Listening or adjusting volume **does not select, submit, or save the file to the library**. Only one preview plays at a time, locally through the chat-media output (or the shared output when no category-specific advanced setting is configured); output changes also apply to the active preview, and nothing is broadcast to voice. Closing or changing the selector stops loading/playback and releases resources. Previews do not require a configured folder. Suggestions appear in a scrollable panel above the composer; the fields below fit their placeholder/content, respect available width, and highlight focus or invalid values. Optional parameters can be removed with **×** without losing their draft.

### Authorized local downloads

Declare `downloadsSound: true` when a command may request **one** soundboard download. The composer explains this capability, requires authorization for each execution, and blocks activation with a notice if the folder is not configured or authorized. **Selecting/executing a command never opens a folder picker.** Configure the folder beforehand in soundboard settings; a previously confirmed folder is reused. This does not grant the bot general filesystem access.

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

### Private replies and publishing

`ctx.reply()` and `ctx.replyEphemeral()` are private: only the calling connection sees the response in the same chat where the command started. This is neither a direct message nor a message published to other members.

Replies appear in cards with the bot's name, photo, and badge, plus **“Nickname used /command”** context. The server supplies the caller's identity and the command name; bots cannot impersonate another caller. This reference does not expose parameter values, including when a result is published to the channel.

```ts
bot.command({
  name: 'secret',
  description: 'Tells you a secret',
  handler: (ctx) => {
    ctx.replyEphemeral('🤫 Only you can see this!');
  },
});
```

To deliberately share a result, use `ctx.publish('Result for the channel')`. Publishing respects channel visibility, is persisted in history, and supports reactions; forms and their answers remain private. Private command replies are temporary and are not part of the channel's persisted history.

### Forms and multi-step conversations

A bot can wait for user input without opening a modal or requesting manually formatted messages. Each `await ctx.prompt(...)` creates a form **inside the caller's chat**. Answers from different users, devices, and servers stay isolated.

```ts
bot.command({
  name: 'list',
  description: 'Publish a list using a form',
  handler: async (ctx) => {
    const result = await ctx.prompt({
      title: 'New list',
      fields: [
        { name: 'question', label: 'Question', type: 'text', required: true, maxLength: 200 },
        {
          name: 'options', label: 'Options', type: 'string-list',
          required: true, minItems: 2, maxItems: 10, maxLength: 80,
          placeholder: 'One option per field',
        },
      ],
    });
    if (!result) return;
    if (typeof result.question !== 'string' || !Array.isArray(result.options)) {
      throw new Error('Unexpected form answer');
    }
    const text = `**${result.question}**\n${result.options.map((option, i) => `${i + 1}. ${option}`).join('\n')}`;
    ctx.publish(text);
  },
});
```

Available field types are `text` (with optional `multiline`), `integer`, `select`, `boolean`, and `string-list`. All accept `name`, `label`, `description`, `required`, and a type-compatible `defaultValue`. Use `defaultValue` to edit a previous step, and the form's `submitLabel` to customize its submit button.

Once the server accepts a submission, the form disappears from chat and its values are discarded in the client. If submission fails, the form retains the entered values and displays the error so the caller can try again.

`prompt()` returns `null` if the conversation is cancelled, expires, or loses its connection. Return from the handler in that case; use `ctx.signal` to cancel external operations. Only one form may be pending per invocation: await it before opening the next. Limits are 10 fields, 20 choices/list items, and five simultaneous commands per connection. Each invocation lasts at most five minutes and 100 steps; opening another form does not reset that deadline. A bot cannot send replies after its handler has finished.

### Private selectors

`ctx.choose()` simplifies questions with one choice. With `presentation: 'buttons'`, clicking responds immediately; with `'dropdown'` (the default), the caller selects and confirms. The response is the declared `value`, or `null` when the interaction ends. Each step is visible only to the caller.

```ts
bot.command({
  name: 'activity',
  description: 'Choose an activity in two steps',
  handler: async (ctx) => {
    const activity = await ctx.choose({
      title: 'What should we do?',
      presentation: 'buttons',
      choices: [
        { label: 'Play', value: 'game' },
        { label: 'Chat', value: 'chat' },
      ],
    });
    if (activity === null) return;
    const time = await ctx.choose({
      title: 'When?',
      submitLabel: 'Confirm time',
      choices: [
        { label: 'Now', value: 'now' },
        { label: 'Later', value: 'later' },
      ],
    });
    if (time !== null) ctx.reply(`Choice: ${activity}, ${time}`);
  },
});
```

You can also use `presentation: 'buttons'` on a `select` field in `ctx.prompt()`. Clicking validates and submits the entire form, so other required fields must be filled first.

### Public selectors and voting

For questions that should remain in the channel, use `bot.createSelector(serverId, definition)`. Unlike a private invocation, the selector is persisted on the server and remains available after disconnections. Buttons respond on click; dropdowns require confirmation.

```ts
const selector = await bot.createSelector(serverId, {
  channelId,
  title: 'Which activity should we organize?',
  choices: [
    { label: 'Tournament', value: 'tournament' },
    { label: 'Chat session', value: 'chat' },
  ],
  presentation: 'buttons',
  responder: 'any',
  allowChange: true,
  expiresAt: Date.now() + 60 * 60 * 1000,
  maxResponders: 50,
});
```

`responder: 'any'` accepts human members with channel access and permission. To restrict responses to one person, use `'invoker'` with their `invokerId`. Each person has one response; `allowChange` lets them replace it without increasing the participant count. `maxResponders: 1` closes on the first valid response. Provide a deadline (`expiresAt`), a participant limit (`maxResponders`), or both; the first limit reached closes the interaction. The maximum duration is 30 days and the maximum participant limit is 10,000.

The `selectorUpdate` event delivers `{ serverId, selector }` to the owning bot, including responses by user ID. Other clients receive only totals and their own choice. Register the listener once for the bot's lifecycle and remove it on shutdown. Use `bot.listSelectors(serverId)` after connecting to recover states, `updateSelector(serverId, id, patch)` to adjust title/limits, and `closeSelector(serverId, id)` to close manually.

Inside a command, prefer `ctx.createSelector(definition)` — `channelId` and `invokerId` are supplied automatically. The server binds creation to the real invocation, allowing polls in private channels the caller can access. This authorization applies only to that selector and channel; it does not grant the bot general access to private messages or reactions. Later operations and recovery revalidate the creator's current permissions. If that person loses access, the bot stops receiving responses and cannot publish results until authorization is restored. Standalone `bot.createSelector()` still requires the bot's own channel access.

After closure, `await bot.finalizeSelector(serverId, id, content)` publishes the result to the channel idempotently: repeating finalization does not create another message. This lets processing recover after a bot crash. Do not keep a private handler open while waiting for a long-running vote.

MonkyBot's `/enquete` uses this mechanism: it requires 2–10 options and at least one closing condition (1 minute to 30 days, using minutes/hours/days; or 1–10,000 voters). It publishes immediately after the form, allows vote changes, and closes at the first limit reached. Results show counts, percentages, the winner/tie, or no votes. Polls and pending results are recovered after restarts.

### Reactions and emoji responses

Persisted text-channel messages support reactions through the emoji picker. Each person may add different emojis, but only one reaction per emoji; clicking again removes their own reaction. Totals and the names of people who reacted are available in chat and survive history loading. Temporary private command replies do not receive public reactions.

In the SDK, `bot.sendMessage(serverId, channelId, text)` awaits publication and returns the message with its `id`. `addReaction(serverId, channelId, messageId, emoji)` and `removeReaction(...)` change only the bot's own reaction. The `reactionAdded` and `reactionRemoved` events provide channel, message and user IDs, the user's nickname, and the emoji, with `{ serverId }` as the second argument. Typed helpers `onReactionAdded` and `onReactionRemoved` return an unsubscribe function.

To publicly reply to a persisted message, use `bot.sendMessage(serverId, channelId, text, { replyToMessageId: id })`. The fourth argument is optional; existing calls keep working. The server requires a non-deleted original in the same accessible channel and returns its resolved reference in `message.reply`. This differs from `ctx.reply()`, which remains a private command response.

A question can continue the command after a valid reaction without mixing responses from other channels or users:

```ts
bot.command({
  name: 'confirm',
  description: 'Answer a question with an emoji',
  handler: async (ctx) => {
    const message = await bot.sendMessage(ctx.serverId, ctx.channelId, 'Continue? React with 👍 or 👎.');
    const answer = await new Promise<string | null>((resolve) => {
      const finish = (value: string | null) => {
        detach();
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(null);
      const detach = bot.onReactionAdded((reaction, { serverId }) => {
        if (serverId === ctx.serverId && reaction.channelId === ctx.channelId &&
            reaction.messageId === message.id && reaction.userId === ctx.invokerId &&
            ['👍', '👎'].includes(reaction.emoji)) finish(reaction.emoji);
      });
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) finish(null);
    });
    if (answer !== null) ctx.reply(answer === '👍' ? "Let's continue!" : "Okay, we'll stop here.");
  },
});
```

The example accepts only the caller's first valid reaction and removes the listener on response, cancellation, disconnection, or expiry. Ordinary reactions remain independent of this flow.

### Per-bot settings on each server

**Right-click a bot → Bot settings**, including its name/avatar in messages and private cards. The server menu also provides **Bots on this server**, available to every member and including offline bots. The server must be connected; disconnecting a bot does not remove its declarations or saved configuration.

| Scope | Who can change it | Storage |
|---|---|---|
| **Behavior on this server** | Administrators/owner or roles with **Configure bot behavior** (`CONFIGURE_BOTS`) | This server's database; affects everyone using that bot there |
| **My preferences** | The individual user | Local profile, separated by endpoint, server, identity, and bot; not synchronized across devices |

`CONFIGURE_BOTS` is independent of `MANAGE_BOTS`, which still controls registration, profiles, and removal. Unauthorized readers receive neither the shared values nor the shared form. The SDK declares reusable fields; it does not inject HTML or create a global app-settings tab. Bots without shared settings do not show that section.

Declare settings before connecting/serving, using the existing `BotForm` field types:

```ts
bot.settings({
  server: {
    title: 'Behavior',
    fields: [
      { name: 'enabled', label: 'Enabled on this server', type: 'boolean', required: true, defaultValue: true },
      { name: 'limit', label: 'Maximum results', type: 'integer', required: true, min: 1, max: 10, defaultValue: 5 },
    ],
  },
  user: {
    title: 'My preferences',
    fields: [
      { name: 'compact', label: 'Compact replies', type: 'boolean', required: true, defaultValue: false },
    ],
  },
});

bot.command({
  name: 'preferences',
  description: 'Show settings for this interaction',
  handler: async (ctx) => {
    const { server, user } = ctx.settings;
    if (server.enabled === false) {
      ctx.reply('This feature is disabled on this server.');
      return;
    }
    ctx.reply(user.compact === true ? 'Compact mode.' : `Server limit: ${server.limit}.`);
  },
});

const detach = bot.onSettingsChanged((settings, { serverId }) => {
  console.log(serverId, settings.revision);
});
const current = bot.getServerSettings('my-server'); // undefined before registration or after disconnect
// Call detach() when the listener is no longer needed.
```

Required settings fields need valid defaults; this does not change ordinary command prompt forms. `false` and `0` are preserved. Text, integers, switches, lists, choices, and audio choices reuse the same controls, with an explicit **Save** even for button-style choices. **Restore defaults** prepares a change but does not persist it until saving.

`ctx.settings` is a server-validated snapshot with `server`, `user`, `schemaRevision`, and `serverRevision`. Invocations, autocomplete, and independent selector responses receive the initiating user's preferences. Private continuations keep the original invocation snapshot; later changes apply to new actions. `onSelectorResponse` delivers preferences privately to the owning bot, never in public selector history. Generic messages and reactions do not distribute preferences to every bot.

`getServerSettings()` caches and settings events are isolated by SDK connection/server. Identical reconnects preserve overrides. Shared writes use optimistic revisions: concurrent changes and outdated declarations require a reload instead of silently overwriting another edit. Incompatible shared overrides reject a replacement declaration; reset those fields through the old settings before registering the new version. Incompatible individual preferences are surfaced for review/reset rather than silently discarded. Declarations have an aggregate 64 KiB limit, and values a 16 KiB limit per scope, in addition to existing form limits.

**Local host decisions are not bot configuration.** Download confirmation/renaming is a local preference automatically provided for bots with `downloadsSound` commands. It never appears in `ctx.settings`, cannot be changed by administrators or bots, and does not grant general filesystem access. Folder selection remains in Soundboard. A bot such as Myinstants does not need a `settings()` declaration to offer this preference.

### Bot photos

Bot management lets you choose or replace a photo. A bot can also synchronize its own profile through the SDK:

```ts
import { readFileSync } from 'node:fs';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  publicKey: 'YOUR_ED25519_PUBLIC_KEY_HEX',
  name: 'My Bot',
  avatarBase64: `data:image/png;base64,${readFileSync('bot.png').toString('base64')}`,
});
```

In marketplace mode, `serve({ name, icon, ... })` accepts the same image in `icon`. Supply **base64 or a data URI**, not an image URL. The server validates the format and size and hosts the photo. The SDK profile is reapplied on connection, including already-added bots; if it specifies a photo, that photo replaces a manual edit on the next reconnect. The official MonkyBot includes the Monky logo in its package.

## Marketplace mode (multi-server)

If you want to distribute your bot so any Monky server can add it, use the `serve()` mode:

```ts
import path from 'node:path';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  publicKey: 'YOUR_ED25519_PUBLIC_KEY_HEX',
  registrationFile: path.join(process.cwd(), '.keys', 'registrations.json'),
});

bot.command({
  name: 'ping',
  description: 'Pong!',
  handler: (ctx) => ctx.reply('🏓'),
});

// Start the manifest HTTP server
bot.serve({
  name: 'My Bot',
  description: 'An awesome bot',
  port: 7780,
  publicHost: 'mybot.example.com', // Publicly accessible IP/domain
});
```

This exposes:
- `GET /manifest` — returns the bot manifest (name, description, registration URL)
- `POST /register` — receives the token from each server that adds the bot

Each server that adds the bot creates an **independent WebSocket connection**. The bot manages all of them automatically, with reconnection.

### Persistent registrations

Set `registrationFile` to recover connections after restarting the process.
Without it, registrations only exist during the current run. When registration
includes `serverUrl`, the SDK confirms `POST /register` after authenticating to
the server and saving the registration; rejected credentials cannot replace a
valid registration. The server rolls back account creation if the callback
rejects registration or fails to confirm a valid key.
A known `serverId` only accepts the same token and URL; a public callback cannot
redirect that registration to another destination.

The file contains tokens and must remain outside source control with restricted
access. Writes are atomic and use `0600` permissions on POSIX systems. Back it up
together with the Ed25519 identity; do not generate new keys when updating.
The limits are 1,000 registrations and 4 MiB per file. Do not share the same file
between simultaneous bot processes. Invalid files stop startup without being
overwritten. `disconnect()` and `close()` do not erase saved registrations.

Registrations lost by versions that only kept them in memory need authorization
again: the server cannot recover a token from its hash. After updating MonkyBot,
revoke the old entry and add it by URL once, reapplying any account-specific
settings. Do not delete the identity keys.

Authentication errors are emitted through `error` as well as `auth_failed`.
A protocol mismatch permits further attempts with `autoReconnect`; invalid
tokens do not enter a retry loop. A rejected photo update does not disconnect
the bot or prevent command registration.

### Network requirements

For Monky servers to reach the manifest and register the bot, the configured port (default `7780`) must be **externally accessible**:

```bash
# Run from the Monky server's machine, not just from the bot's machine
curl --fail --max-time 10 http://YOUR-IP:7780/manifest

# If using iptables (Linux):
sudo iptables -A INPUT -p tcp --dport 7780 -j ACCEPT

# If using ufw (Ubuntu):
sudo ufw allow 7780/tcp

# If on cloud (AWS, GCP, Azure, etc.):
# Allow port 7780 TCP in your Security Group / Firewall Rules
```

Also, `publicHost` must be the machine's **public IP or domain** — `localhost` only works if bot and server run on the same machine.

The request must return the manifest JSON. If `monkybot status` reports `errored`, fix the error in `monkybot logs` first: opening ports cannot start a failing process. `iptables` rules must precede blocking rules and be persisted according to your distribution; behind NAT, also configure port forwarding.

### Useful properties

```ts
bot.serverCount;  // Number of connected servers
bot.serverIds;    // List of server IDs
bot.registeredServerCount; // Known authenticated registrations, including offline
```

### Events

```ts
bot.on('connected', ({ serverId }) => console.log(`Connected to ${serverId}`));
bot.on('disconnected', ({ serverId }) => console.log(`Disconnected from ${serverId}`));
bot.on('registered', ({ serverId, serverName }) => console.log(`Registered on ${serverName}`));
bot.on('error', (err) => console.error(err));
bot.on('serving', ({ port, manifest }) => console.log(`Manifest at :${port}/manifest`));
```

## Security: TOFU (Trust On First Use)

On the first connection, the bot presents its **Ed25519 public key**. The server permanently binds it to the bot (TOFU binding). Future connections require the same key — if someone tries to use the token with a different key, it's rejected.

In marketplace mode, TOFU binding happens automatically during installation.

> 💡 The [Monky Bot](https://github.com/MonkyOrg/MonkyBot) automatically generates and reuses its Ed25519 key pair. When building your own bot with the SDK, generate and persist your key using Node.js cryptography APIs and pass the public key in `publicKey`; do not generate a new identity on every restart.

## Monky Bot (official bot)

[**Monky Bot**](https://github.com/MonkyOrg/MonkyBot) is the reference bot maintained by the organization. It serves as a practical example and includes utility commands:

| Command | Description |
|---------|-------------|
| `/ping` | Bot latency |
| `/dado [sides]` | Roll a dice (2-100 sides) |
| `/moeda` | Coin flip |
| `/8ball <question>` | Magic 8-ball; the question is required |
| `/enquete` | Private form; publishes voting to the channel without review and closes by time and/or voter count |
| `/ajuda` | List all commands |

See the [Monky Bot repository](https://github.com/MonkyOrg/MonkyBot) for installation and usage instructions.

## Quick API reference

### `BotClient`

| Method | Description |
|--------|-------------|
| `new BotClient(options)` | Create a bot instance |
| `bot.command(def)` | Register a slash command |
| `bot.connect(overrides?)` | Connect to a server (manual mode) |
| `bot.disconnect(serverId?)` | Disconnect from one or all servers |
| `bot.close()` | Close the bot's connections and HTTP servers |
| `bot.serve(options)` | Start HTTP server for marketplace |
| `bot.serverCount` | Number of connected servers |
| `bot.serverIds` | Connected server IDs |
| `bot.registeredServerCount` | Number of known authenticated registrations, including offline |

### `BotOptions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `publicKey` | `string` | ✅ | Ed25519 public key in hex |
| `serverUrl` | `string` | Manual mode | Server WebSocket URL |
| `token` | `string` | Manual mode | Bot token |
| `autoReconnect` | `boolean` | — | Auto-reconnect (default: `true`) |
| `name` | `string` | — | Name to synchronize in the profile |
| `avatarBase64` | `string` | — | Base64 or data URI photo, synchronized on connection |
| `registrationFile` | `string` | — | Private marketplace registration file, restored by `serve()` |

### `ServeOptions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | ✅ | Name shown in the manifest |
| `description` | `string` | — | Bot description |
| `icon` | `string` | — | Base64 or data URI photo (URLs are not accepted) |
| `port` | `number` | — | HTTP port (default: `7780`) |
| `host` | `string` | — | Bind address (default: `0.0.0.0`) |
| `publicHost` | `string` | — | Public hostname for registration |
