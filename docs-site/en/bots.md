# Bots

Monky has a complete bot system that lets you automate tasks, add custom commands, and integrate external services into your server.

## What is a bot?

A bot is an **external process** that connects to the Monky server via WebSocket, just like any other user. The difference is that bots:

- Authenticate with a **token** instead of a password
- Can register **slash commands** (`/ping`, `/dice`, etc.)
- Show a **BOT** badge in the member list
- Use their own name and photo in chat messages and forms
- Don't count toward the user limit (they have their own limit: `maxBots`)

The bot runs on **its own machine** (VPS, cloud, your PC), not on the Monky server. By default, it processes commands and the server routes messages. Local execution capabilities allow specific operations on the caller's client with that person's authorization; they do not allow arbitrary programs or scripts.

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

### 1. Via URL (recommended)

This is the default flow, including for private bots. The endpoint must be
reachable by the Monky server; it does not need a public catalogue listing.

1. The bot serves an **HTTP manifest** containing its identity, description, requested capabilities, and registration URL
2. In the client, go to **Server Settings → Bots**
3. Paste the manifest URL under **Link bot by URL** and open the review
4. Review every switch; all start off. **Allow all requested capabilities** selects only what the bot requested
5. Confirm installation. The server refetches the manifest and registers the link; the approved subset is enabled only after registration is verified

### 2. Manual token connection (advanced)

Use this when the bot can only make outbound connections and has no HTTP
endpoint reachable by the Monky server.

1. In the client, open **Server Settings → Bots → Show advanced option**
2. Generate a manual link without entering a name or avatar, confirming that the token does not authorize actions
3. Copy the token (shown **only once**) into the bot's setup/code
4. The link waits for the bot to connect; it publishes its identity and declares capabilities through the SDK, still without authority to perform actions
5. Open **Bot settings → Server permissions**, select the switches and save. The bot may reconnect after the review

**Only the bot controls its name and avatar.** The client links bots, configures
their behavior, and unlinks them; it does not edit their identity. Existing
profiles, links, tokens, and keys are preserved when upgrading.

## Creating your own bot

### Permissions and channels

In **Server Settings → Roles**, **Add and manage bots** (`MANAGE_BOTS`) controls linking, unlinking, and capability reviews; **Configure bots** (`CONFIGURE_BOTS`) controls shared behavior settings only. Neither permission allows changing a bot's name or avatar. **Use bot commands** controls who can use commands and interactions, and is initially enabled for existing members and roles.

When creating or editing a text channel, the **Allow bot commands** switch starts enabled. Turning it off blocks commands and responses to forms and selectors in that channel, **including for administrators**. Typing `/` displays the reason. Permission changes also affect interactions that are already open; ordinary messages and reactions continue to follow their own permissions.

### Requested capabilities and consent

`BotOptions.requestedCapabilities` is required. Declare only categories the bot actually uses; the SDK publishes the same list in its manifest and `COMMAND_REGISTER`. A declaration is a request, never an authorization:

| Capability | Server-enforced access |
|------------|------------------------|
| `commands` | Explicit command inputs, autocomplete, previews, private replies, and forms |
| `read_messages` | Messages, history, and reactions in accessible channels; also required to quote another message |
| `send_messages` | Messages, replies, reactions, and public command results |
| `publish_voice` | Publishing audio in permitted rooms, without receiving participant media |
| `local_execution` | Requesting tasks and tool preparation on the client; may receive media produced by an authorized task |
| `sound_download` | Requesting a Soundboard audio save on the caller's device, without general filesystem access |
| `selectors` | Persistent public choice controls and their responses; publication also requires `send_messages` |
| `miniapps` | Shared voice-room miniapps, including authorized participant actions |

Registering commands requires `commands`; commands with `downloadsSound` also declare `sound_download`, and those with `localCapabilities` declare `local_execution`. Public replies require `send_messages`; default private replies require only `commands`. Role, channel, and initiating-user permissions still apply.

**Voice reception is unavailable.** Requests such as `receive_voice` are rejected. The server refuses bot SFU consumption and P2P negotiations that would receive microphone, camera, or screen sharing; clients do not publish those tracks to bots. Media from consented local tasks is a separate route, not channel listening.

**Device consent is separate.** Granting `local_execution` or `sound_download` on the server neither installs tools nor authorizes a computer. The person still controls local requests and can deny or revoke them in local tool settings. Personal preferences, bot language, and file-name confirmation do not become administrator-controlled permissions.

**Editing and safe migration.** Bot settings use the same sidebar and section navigation as app/server settings. Under **Server permissions**, users with `MANAGE_BOTS` may review switches at any time. Saving invalidates the previous connection, ends voice, local tasks, source references, previews, interactions, and miniapps, and closes persistent selectors; the SDK may reconnect. Old asynchronous work cannot regain authority after a quick revoke/regrant.

Migration `026_bot_capability_consent.sql` preserves bots, tokens, identities, and settings, but **does not invent approval for existing bots**: they start with no grants and must declare capabilities with the updated SDK and undergo review. A changed declaration retains only previously granted capabilities that remain requested; new capabilities stay off. Optimistic revisions require reloading after concurrent edits.

For URL installation, a preview lasts five minutes, belongs to the administrator's session/device, and can be consumed once. `BOT_INSTALL_PREVIEW { manifestUrl }` returns `{ previewId, expiresAt, manifest }`; `BOT_INSTALL { previewId, grantedCapabilities }` refetches the content. Changes to the manifest, a runtime declaration during registration, or the installer's authority cancel installation without leaving an approved account. Provisional registrations may publish identity and declarations, not perform actions.

The SDK exposes `bot.getPermissions(serverId)` and `permissionsChanged(permissions, { serverId })`, containing `requested`, `granted`, `revision`, `reviewRequired`, `reviewedBy`, and `reviewedAt`. These are informational per-server snapshots, not a way to grant permissions; the server remains authoritative.

### Prerequisites

- **Node.js 18+**
- Client, server, and SDK compatible with **protocol 20**
- The `@monky/bot-sdk` package from the matching release

::: warning Update together
Protocol 20 requires explicit declarations and per-bot administrator consent, including installation previews. It preserves local execution, private signaling, previews, pagination, and localized command names. Update the **client, server, and bot** together; different protocol versions cannot connect. This requires a major release, including on the beta track. Updating the SDK does not automatically approve existing bots.

Protocol 14's linking rules are preserved: `BOT_CREATE` accepts only `{}`, and management receives `profilePending` while a bot has not announced its identity. The database preserves existing identities, and only the authenticated bot may publish profile changes. `ctx.args` contains typed values and `ctx.reply()` is private; use `ctx.publish()` only for channel-visible results.
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

On the first access from an interactive terminal, the CLI asks for **Português
(Brasil)** or **English** and saves the choice in `~/.<cliName>/preferences.json`.
`language en` or `language pt-BR` changes that preference; `--locale en` applies
only to that invocation. `en-US` is accepted and normalized to `en`.
`--version`, `--help`, redirected input/output, `--non-interactive`, `--yes`,
`--check`, and CI environments never open that prompt or create a preference
automatically. `MONKY_BOT_LOCALE` can specify an automation's language; when it
is absent, the CLI accepts `MONKY_LANG`, like the server CLI. `--locale` takes
precedence over both without reading or changing the saved preference.
Regional/POSIX tags such as `en_GB.UTF-8` and `pt_PT` normalize to `en` and
`pt-BR`. Saving is atomic; invalid preferences produce a diagnostic without
blocking help or automation and can be replaced with `language en` or
`language pt-BR`. `--version` does not even read that file.
The CLI passes the effective language to the bot process through that same
variable, without translating identifiers such as `setup`, `start`, `mode`, or
environment-variable names.

Setup follows MonkyBot's flow: mode, working directory, mode-specific settings,
and bot name. **URL installation is the default** for bots supporting both modes;
manual token connection is advanced. Reconfiguration preserves the existing
mode and working directory instead of migrating existing installations.

Manual setup asks for the server and **bot token**. Bare `IP:port` addresses use
`ws://`; explicit `ws://` and `wss://` URLs are supported. Invalid fields are
requested again without restarting the wizard. Token input is hidden, excluded
from prompt history, and stored only in the local configuration (file mode `600`,
directory mode `700` on Linux). `config` and `status` redact its value.

Automation can still use
`setup --non-interactive --mode manual --server-url localhost:3000 --token-env MONKY_BOT_TOKEN`.
This stores only the environment variable name; provide its value before
`start` and `restart`. Existing `tokenEnv` profiles remain compatible.
`config set botToken` and `config set tokenEnv` switch credential sources rather
than retaining both. Prefer setup to avoid putting a token in shell history.

Marketplace setup asks for a manifest port and public hostname/IP, without a
manual token. For automation:
`setup --non-interactive --mode marketplace --public-host bot.example.com --serve-port 7781`.
The endpoint must be reachable by installing Monky servers; `localhost` only
works for servers on the same machine.

Each bot on the same machine needs a **separate port**, for example `7780` and
`7781`. `/manifest` is an endpoint served by each process, not a shared file.
The CLI checks whether it can bind the local port before saving. If another bot
or service occupies it, interactive setup explains the conflict and asks for
another port instead of changing it automatically. Non-interactive setup and
port changes through `config set` fail without overwriting the previous config.

If the bot itself is using the port, run `my-bot stop` before repeating setup;
its configuration and keys are preserved. `start` also checks the port before
launching a stopped bot; `restart` stops only its own managed process before
checking, including after updates. This local check does not validate firewall
rules or reserve the port until the next `start`.

Configuration and identity live in `~/.<cliName>`, outside the package;
`MONKY_BOT_CLI_HOME` changes the base directory while keeping each bot's subdirectory.
The `botName`, `botDir`, `serverUrl`, `botToken`, `servePort`, and `publicHost`
configuration aliases follow MonkyBot; `restart --fresh` recreates the managed
process without deleting its profile.

The CLI generates/reuses the identity and supplies `MONKY_BOT_PUBLIC_KEY`,
`MONKY_SERVER_URL`, `MONKY_BOT_TOKEN` and `MONKY_BOT_NAME` to the process. The bot
entry must consume these variables. Declare `marketplace` in `modes` only if that
entry also implements the `MONKY_SERVE`/`bot.serve()` flow. In that mode, the runner
also supplies `MONKY_SERVE_PORT`, `MONKY_SERVE_PUBLIC_HOST`, and
`MONKY_BOT_REGISTRATION_FILE`. Pass the latter as `registrationFile` to `BotClient`
to restore authenticated links after restarting. Preserve the entire `.keys`
directory; it contains identity keys and linked-server tokens.
The SDK exports `validateBotServerUrl`, `validateBotServePort`, and
`validateBotPublicHost` so bot entries can reuse the CLI validators.

### Optional CLI updates

`update` and enabling `autoupdate` **only work when the bot author explicitly
configures an update source** in the build's `package.json`, not through operator
setup. **GitHub Releases is recommended**, with version history and stable/beta
selection using the existing package format:

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

As alternatives, replace `releases` with one of these definitions inside `monkyBot`:

```json
{
  "updateSource": {
    "type": "https",
    "url": "https://downloads.example.com/my-bot.tgz",
    "tokenEnv": "BOT_UPDATE_TOKEN"
  }
}
```

```json
{
  "updateSource": {
    "type": "file",
    "path": "../bot-updates/my-bot.tgz"
  }
}
```

For HTTPS, `tokenEnv` is optional. When declared, its environment value is required
and sent as a Bearer token. Configured URLs cannot embed credentials, query strings,
or fragments; redirects stay on the same HTTPS origin, including its port.
The author must keep the archive at that URL up to date.

Relative file paths resolve from the **installed** `package.json`, never from the
terminal or PM2 working directory. Prefer portable relative paths across platforms;
absolute paths must be native to the environment. There is no tilde/environment
expansion. The source must be a readable regular `.tgz` file, not a symbolic link;
the CLI copies a private snapshot before inspection and installation.

Configure exactly one source: `releases` or `updateSource`. Without either, the SDK
does not infer a source from `repository`, `git origin`, the SDK repository or
the npm registry. An invalid URL fails rather than enabling another source.

`update --check` never installs or restarts. GitHub checks query metadata only;
HTTPS/file checks fetch or copy an archive to inspect its version, then discard it.
`update` follows stable and `update --beta` includes
pre-releases. Selection uses semantic versions, without downgrades or reinstalling
the same version. Auto-update follows the installed channel unless `--beta` is
explicitly enabled. Single-archive sources offer only the version in that file;
stable mode does not install it if it is a beta. Use the self-contained `.tgz`
generated by the SDK, not a GitHub source ZIP. None of these commands publishes
or promotes releases.

Installing an update requires the globally installed CLI in the current npm
prefix; source checkouts and local installations only support `--check`.
The SDK verifies the downloaded package name, version and CLI, then installs the
self-contained archive offline without running installation scripts. Use
`update --yes` without an interactive terminal. Configuration and identity files
remain outside the installation. Installation is refused if configuration/runtime
data is inside the installed package, to avoid deleting it during replacement.
Transfers are bounded to 200 MiB and 60 seconds.

The CLI shows actual transferred bytes and a percentage when the source provides
a valid total. Without a total it reports received bytes without inventing a
percentage. Checking, verification, installation, and restart are indeterminate
stages; redirected logs use readable lines. If the bot was running, restart uses
the **newly installed CLI**, rather than the old SDK still cached in the updater.
The profile, keys, and update schedule are preserved.
In manual mode with `tokenEnv`, if the variable is absent from the current shell,
only that credential is recovered from the managed PM2 process environment.
An explicit shell value takes precedence; the token is not written to config,
arguments, or logs.

For a private repository, supply the read token through the indicated environment
variable, never through the package or URL. `autoupdate off` and `status` remain
available to administer an old schedule even if a later version removes its
update source.

### Basic example

```ts
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  requestedCapabilities: ['commands'],
  serverUrl: 'ws://your-server:3000',
  token: 'YOUR_BOT_TOKEN',
  publicKey: 'YOUR_ED25519_PUBLIC_KEY_HEX',
  name: 'My Bot',
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
    // ctx.invokerSessionId — connection/device that started the command
    // ctx.invokerVoiceChannelId — initial voice room, not live state
    // ctx.getVoiceChannel() — query the original connection's current room from the server
    // ctx.serverId   — server ID (useful in multi-server mode)
    // ctx.args       — arguments { name: string | number | boolean }
    // ctx.locale     — preferred language for this bot ('pt-BR' or 'en')
    // ctx.reply()    — reply only to the caller, within the chat
    // ctx.publish()  — explicitly publish a result in the channel
    // ctx.prompt()   — await a private form; may be called in multiple steps
    // ctx.choose()   — await a private choice through buttons or a dropdown
    // ctx.createScreen() — create a shared screen independent of the handler
    // ctx.downloadSound() — await an authorized local soundboard download
    // ctx.signal     — aborts on cancellation, disconnect, timeout or completion
  },
});
```

### Command language and individual preferences

Each person can use the **Bot settings > My preferences > Bot language**
dropdown and confirm with **Save**, even for bots without their own settings form.
**Follow Monky** uses the app's
language; an explicit choice applies only to that bot, server/address, and
identity in the local profile. Restoring defaults follows Monky again.
The effective language arrives in `ctx.locale`, including autocomplete and
audio previews. Existing interactions retain their captured language; old
message bodies are not translated retroactively. A response's command attribution
follows each reader's language using the available metadata; without that
metadata, it falls back to the canonical name.

Declare `localizations` for private names, aliases, command discovery, and input labels:

```ts
bot.command({
  name: 'play',
  description: 'Choose playback order',
  options: [{
    name: 'mode', label: 'Mode', description: 'Playback order', type: 'string',
    choices: [{ label: 'Shuffle', value: 'shuffle' }],
  }],
  localizations: {
    'pt-BR': {
      name: 'tocar',
      aliases: ['musica'],
      description: 'Escolha a ordem de reprodução',
      options: {
        mode: {
          label: 'Modo', description: 'Ordem de reprodução', placeholder: 'Escolha',
          choices: { shuffle: { label: 'Aleatório' } },
        },
      },
    },
  },
  handler: (ctx) => { ctx.reply(ctx.locale === 'en' ? 'Ready.' : 'Pronto.'); },
});
```

The top-level `name` remains canonical: a Portuguese user sees `/tocar` and
can type `/tocar`, `/musica`, or `/play`, but the server and `ctx.commandName`
receive `play`. This preference is **only for that person**, never a global
rename. Argument names, `ctx.args.mode`, and `choices[].value` are not translated.
Descriptions, `label`, `placeholder`, and choice labels/descriptions remain
localizable; undeclared fields or choices are rejected. Missing text falls back
to the original declaration.

Local names and aliases are lowercase ASCII slugs of 1–32 characters: they
start with a letter or digit and allow letters, digits, `_`, and `-`. Each locale
allows up to eight unique aliases. Bot registration rejects collisions between
commands, including aliases that shadow another command's canonical name.
Cross-bot collisions still require selecting the bot, rather than executing the
first match. Only the effective locale's aliases and canonical names are
accepted. Changing language while composing refreshes names and labels without
losing the selected bot, canonical command, values, or caret.

The SDK exports `BotLocale`, `normalizeBotLocale`, `resolveBotLocale`, and
`localizeCommand`, plus `getCommandPresentation` and the `CommandPresentation`
type. `normalizeBotLocale('en-US')` returns `en`; use `pt-BR` and
`en` as `localizations` keys. `resolveBotLocale` can receive the bot's supported
languages and its default. `localizeCommand` produces display metadata without
mutating the original declaration or identifiers.
`getCommandPresentation(definition, ctx.locale)` returns
`{ canonicalName, displayName, inputNames }`. Use `displayName` in private help;
never send it as the protocol's `commandName`. For example, using the same
`commandDefinitions` array registered with `bot.command()`:

```ts
import { getCommandPresentation, localizeCommand } from '@monky/bot-sdk';

bot.command({
  name: 'help',
  description: 'Help',
  localizations: { 'pt-BR': { name: 'ajuda' } },
  handler: (ctx) => ctx.reply(commandDefinitions.map(command =>
    `/${getCommandPresentation(command, ctx.locale).displayName} — ${
      localizeCommand(command, ctx.locale).description
    }`
  ).join('\n')),
});
```

Handlers still own forms and response bodies: use `ctx.locale`, not
`ctx.settings.user.locale`. `ctx.reply()` keeps help private; publishing
translated help to a channel does not make it individual.

### Guided parameters in chat

Typing `/` opens a menu with frequently used commands and sections grouped by bot. Each item identifies the command, its description, and its bot. While browsing, required parameter chips and the optional parameter count help choose a command. Pressing **Space** selects the highlighted command and opens its composer without executing it. Spaces in ordinary messages or parameter fields remain text.

Selecting a command with parameters identifies **which bot and command** are selected in a compact composer with named fields, descriptions, and placeholders. Optional parameters can be added when needed. Submission uses the names declared in `options`; there is no need to join values with commas. Commands without parameters that do not request local downloads, such as `/ping` and `/enquete`, start their interaction immediately when selected with a click, Enter or Tab; selecting with Space waits for an explicit submission.

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

The callback receives `{ query, page, cursor, optionName, args, locale, serverId, signal, settings }` and may return a list of `SelectionChoice` (`{ label, value, description?, audio? }`) or a page `{ choices, hasMore?, nextCursor? }`, directly or through a `Promise`. `page` starts at zero; `cursor` is optional. `args` contains only the other filled, valid options; missing required options are allowed at this stage. `query` contains the text of the option being edited. `settings` is an immutable snapshot of server settings and this person's preferences.

This example keeps the catalog in the bot. For an external source, replace filtering with a **metadata** search, pass `signal` to `fetch`, and validate the response. The callback receives neither an invocation nor reply/download methods. Queries are sent to the selected bot while the person types; they are not published in the channel or persisted in history.

The client waits for **700 ms without typing** and spaces actual sends by at least **1 second** per connection, including between pages and after reopening the menu. Local preparation happens before reserving that interval and before starting the response deadline. The server still allows one request per user every 500 ms, combining their devices, with a 15-second deadline per page. Return at most **20 choices per response**, with unique values: `label` up to 100 characters, `value` up to 2,000, and `description` up to 500. **The accumulated menu has no total result cap.** `query` accepts up to 200 characters; a bot may impose a smaller limit.

To enable on-demand scrolling, return `hasMore: true` while another page exists. The client increments `page` near the end of the list, keeps earlier choices, and deduplicates by `value`. If the source uses cursors or a source page needs to be split into batches, also return `nextCursor` (an opaque string of up to 512 characters); the client passes it back as `cursor`. Validate cursors in the provider: they are not authorization and must not be treated as trusted URLs. Do not fetch every page in advance.

```ts
autocomplete: ({ query, page }) => {
  const matches = catalog.filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase()));
  const offset = page * 20;
  return { choices: matches.slice(offset, offset + 20), hasMore: offset + 20 < matches.length };
},
```

Omitting `hasMore` (including legacy array returns) keeps the response a single list. Return `hasMore: false` on the final page and omit `nextCursor`; an empty list ends a search without continuation. Loading failures keep existing results and allow retrying the same page. Closing the composer, changing the search, cancellation, access loss, or disconnection invalidates the context; late responses are discarded. On-demand previews retain each page's own authorization and expiry rather than becoming invalid just because the next page loads. The SDK, server, and client must use protocol 20; existing array callbacks do not need changes after updating the SDK and declaring the capabilities in use.

Arrow keys only navigate. Enter or a click confirms a suggestion. **Without optional parameters, if every required parameter is valid, the same gesture executes the command exactly once.** If optional parameters exist, selection only fills the field: the composer stays open to use `+N`, and a later Enter or the execute button submits. Missing required parameters must be filled before execution. Typing text without a valid choice does not execute the command. Editing the text invalidates the previous selection. `value` is an opaque identifier, not authorization: the handler must validate it again before resolving the result's metadata.

### Selections with audio previews

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

#### Generate audio only when listening

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

**Right-click a bot → Bot settings**, including its name/avatar in messages and private cards. People with access to **Server Settings → Bots** can also open each bot's preferences there, including offline bots. Personal preferences remain available through the bot's own entrypoints, without a duplicate server-dropdown item. The server must be connected; disconnecting a bot does not remove its declarations or saved configuration.

Manual reservations still awaiting their first identity appear only in bot
management; their settings remain unavailable until the bot announces its
own identity.

| Scope | Who can change it | Storage |
|---|---|---|
| **Behavior on this server** | Administrators/owner or roles with **Configure bot behavior** (`CONFIGURE_BOTS`) | This server's database; affects everyone using that bot there |
| **My preferences** | The individual user | Local profile, separated by endpoint, server, identity, and bot; not synchronized across devices |

`CONFIGURE_BOTS` is independent of `MANAGE_BOTS`, which controls linking and unlinking, not identity. Only the authenticated bot can change its name and avatar. Unauthorized readers receive neither the shared values nor the shared form. The SDK declares reusable fields; it does not inject HTML or create a global app-settings tab. Bots without shared settings do not show that section.

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
  localizations: {
    'pt-BR': {
      server: {
        title: 'Comportamento',
        fields: { enabled: { label: 'Ativado neste servidor' }, limit: { label: 'Quantidade máxima' } },
      },
      user: { title: 'Minhas preferências', fields: { compact: { label: 'Respostas compactas' } } },
    },
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

Optional `localizations` supports `pt-BR` and `en`, following the person's preferred bot language (Monky's language by default). Each scope may translate `title`, `description`, `submitLabel`, and, under `fields`, `label`, `description`, `placeholder`, and `choices: { value: { label, description } }` for already-declared fields/choices. Translations never change names, types, defaults, or validation; missing text falls back to the original declaration. Shared forms and their translations are only sent to people authorized to configure them.

In MonkyBot, **Behavior on this server → Music → Idle timeout (seconds)** controls departure after an idle queue or an empty room: 60 seconds by default, from 1 to 600, saved per server. Changing it during a pending timeout preserves elapsed inactivity. The `MONKY_MUSIC_GRACE_SECONDS` environment variable only supplies the host default, not a replacement for shared configuration.

`ctx.settings` is a server-validated snapshot with `server`, `user`, `schemaRevision`, and `serverRevision`. Invocations, autocomplete, and independent selector responses receive the initiating user's preferences. Private continuations keep the original invocation snapshot; later changes apply to new actions. `onSelectorResponse` delivers preferences privately to the owning bot, never in public selector history. Generic messages and reactions do not distribute preferences to every bot.

`getServerSettings()` caches and settings events are isolated by SDK connection/server. Identical reconnects preserve overrides. Shared writes use optimistic revisions: concurrent changes and outdated declarations require a reload instead of silently overwriting another edit. Incompatible shared overrides reject a replacement declaration; reset those fields through the old settings before registering the new version. Incompatible individual preferences are surfaced for review/reset rather than silently discarded. Declarations have an aggregate 64 KiB limit, and values a 16 KiB limit per scope, in addition to existing form limits.

**Local host decisions are not bot configuration.** Download confirmation/renaming is a local preference automatically provided for bots with `downloadsSound` commands. It never appears in `ctx.settings`, cannot be changed by administrators or bots, and does not grant general filesystem access. Folder selection remains in Soundboard. A bot such as Myinstants does not need a `settings()` declaration to offer this preference.

### Bot photos

The bot process owns its name and photo, not client-side management. Its operator
can configure the CLI's `botName`; bot code publishes the identity through the SDK:

```ts
import { readFileSync } from 'node:fs';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  requestedCapabilities: [],
  publicKey: 'YOUR_ED25519_PUBLIC_KEY_HEX',
  name: 'My Bot',
  avatarBase64: `data:image/png;base64,${readFileSync('bot.png').toString('base64')}`,
});
```

In marketplace mode, `serve({ name, icon, ... })` accepts the same image in `icon`.
Supply **base64 or a data URI**, not an image URL. The server validates format/size
and hosts the photo. `avatarBase64: null` explicitly removes a previous photo;
omitting the field preserves it. The SDK announces its name during initial
authentication and reapplies its profile on connection, including existing links.
Photo failures are reported without hiding the bot's commands. Administrators
cannot override identity through the client or profile API. The official MonkyBot
includes the Monky logo in its package.

## Marketplace mode (multi-server)

If you want to distribute your bot so any Monky server can add it, use the `serve()` mode:

```ts
import path from 'node:path';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  requestedCapabilities: ['commands'],
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
- `GET /manifest` — returns the bot manifest (name, description, requested capabilities, registration URL)
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

[**Monky Bot**](https://github.com/MonkyOrg/MonkyBot) is the reference bot maintained by the organization. It serves as a practical example and includes utility and music commands:

| Command | Description |
|---------|-------------|
| `/ping` | Bot latency |
| `/dado [sides]` | Roll a dice (2-100 sides) |
| `/moeda` | Coin flip |
| `/8ball <question>` | Magic 8-ball; the question is required |
| `/enquete` | Private form; publishes voting to the channel without review and closes by time and/or voter count |
| `/play <name or URL>` | Autocomplete tracks by name or individual YouTube video link, with on-demand local previews and selection to enqueue |
| `/queue` | Show the queue |
| `/nowplaying` | Show the current track |
| `/pause` and `/resume` | Pause and continue playback without restarting the track |
| `/skip` | Advance to the next track |
| `/remove <position>` | Remove a queued track |
| `/clear` | Clear upcoming tracks without interrupting the current one |
| `/stop` | Stop playback and clear the queue |
| `/leave` | Stop, clear the queue, and disconnect from voice |
| `/jogo-da-velha` | Open a shared tic-tac-toe game with two players and spectators |
| `/ajuda` | List all commands |

Each server has an independent queue and one active voice channel for that queue. All music commands, searches and private previews require voice membership, including `/queue` and `/nowplaying`. The first `/play` brings the bot to the caller's room; if it is already in another room, the request is rejected with instructions to join it. No DJ role is required, but Monky's general command permissions still apply. Playback does not belong to the `/play` handler: finishing or expiring that invocation does not end tracks that are already queued.

Music uses only `/play`, not a separate `/query`. Search waits for 700 ms without typing and reuses autocomplete request pacing; local preparation and authorization happen before starting the search deadline. Listening generates up to 10 seconds for that person only, without adding to the queue. Selecting a result and executing `/play` is what adds the track.

In `youtube-local` mode, search, source resolution, and audio conversion belong to **the requesting person's client**, in an isolated Node process with Monky-managed tools. MonkyBot retains the queue, controls, and room publication, so it can remain hosted on a VPS. There is no alternative VPS execution or automatic transfer to another participant or device. `ctx.downloadSound()` remains a different operation: an authorized soundboard download, not a continuous music source.

If the current track's requester leaves the room or disconnects their client, the bot stops that track, announces it in chat, and skips it. That session's upcoming tracks remain queued while it is unavailable; eligible requests from other people may continue. Another session on the same account does not replace the original one. A queue with no eligible tracks still follows the configured idle departure policy, and closing the queue releases its references.

This first version does not support Spotify, playlists, albums, or live streams. Extracting YouTube media is not an official audio API for bots and may stop working because of platform restrictions or changes. Only play content you are authorized to use and respect [YouTube's terms and policies](https://developers.google.com/youtube/terms/developer-policies). The bot repository documents media prerequisites and unavailability messages.

See the [Monky Bot repository](https://github.com/MonkyOrg/MonkyBot) for installation and usage instructions.

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

## Bot voice

The SDK separates the voice connection from the audio source. `bot.joinVoice(serverId, channelId, options?)` creates the server's appropriate P2P or SFU connection; the bot maintains the queue and publication clock. Decoding may belong to its own local source or an authorized capability on a participant's client. Text-only bots do not need to start media connections.

The bot joins with its personal mute and deafen states off; existing administrative restrictions still apply. The current SDK transmits audio but does not yet offer an API to receive participants' voices ([#642](https://github.com/MonkyOrg/Monky/issues/642)). That limitation is not represented as the bot choosing to deafen itself.

Declare `voiceRequirement: 'joined'` for commands that require voice, or `'same-bot-channel'` when callers must also share the bot's room if it has already joined voice. Omitting this field preserves ordinary command behavior. Client and server apply the rule to execution, autocomplete and previews; the server checks that exact person's connection, not another device on the same account. Leaving or moving cancels pending work and invalidates choices/previews without retargeting the request to another room. An independent bot-hosted source does not belong to the invocation lifetime; a client-delegated stream, however, depends on its executor's voice presence.

Command contexts contain server-authenticated `invokerSessionId` and `invokerVoiceChannelId`. They describe the initial execution; the latter is `null` when the connection invoking the command is not in voice. **The field is not a live getter.** After a search, form, or other wait, use `await ctx.getVoiceChannel()` to query the original connection's current room from the server. Do not look up the room by `invokerId` alone: the same person may be connected on two devices in different rooms.

```ts
bot.command({
  name: 'join',
  description: 'Join your voice room',
  voiceRequirement: 'same-bot-channel',
  handler: async (ctx) => {
    const channelId = await ctx.getVoiceChannel();
    if (channelId === null) {
      ctx.reply(ctx.locale === 'en' ? 'Join a voice room first.' : 'Entre em uma sala de voz primeiro.');
      return;
    }
    await bot.joinVoice(ctx.serverId, channelId, { invocationId: ctx.invocationId });
    ctx.reply(ctx.locale === 'en' ? 'Connected to voice.' : 'Conectado à voz.');
  },
});
```

Pass `invocationId` when joining at a person's request: the server rechecks the connection, current room, and authorization, including private rooms. Moving or leaving between the query and join invalidates the request. This capability is voice-specific and does not grant general private-chat access. Joining without an invocation still requires the bot's own channel access. Before changing an existing queue, also revalidate the requesting person's room; finishing the command that started playback does not close the voice connection.

Use `bot.getVoiceConnection(serverId)` to obtain that server's connection and `await bot.leaveVoice(serverId)` to close it. Each connection exposes `channelId` and `humanParticipantCount`. The `voiceParticipantsChanged` event provides `{ serverId, channelId, humanParticipantCount }`; `voiceDisconnected` also includes a `reason`. Register listeners once and remove them when shutting down the bot.

`await connection.writeOpus(frame)` sends **one raw 20 ms Opus packet with a 48 kHz clock**, not an Ogg file, MP3, or PCM bytes. The source must extract packets and pace them instead of sending an entire file at once. Keep playback in a session independent of the command invocation and stop the source when leaving voice or losing the connection. `/pause` must suspend the source's progress; stopping transmission while it keeps reading would lose the playback position.

Transmission uses the same speaking indicator as other participants. The SDK publishes activity transitions, not one event per packet, and clears the indicator when transmission becomes idle, is suppressed, or ends. Each person may also mute the bot only for themselves: this does not change anyone else's audio, playback, or the queue.

When the source is paused or stopped, `connection.stopSpeaking()` clears the indicator immediately without closing the connection or changing mute preferences. This method does not replace pausing or stopping the audio source itself.

Administrative mute/deafen has different semantics: while the connection is restricted, `writeOpus()` validates and discards packets without transmitting them or raising a media failure. Continue pacing at 20 ms. In MonkyBot, the track and queue advance normally in silence; lifting the restriction restores sound at the current position. This does not undo a manual pause. Invalid packets, closed connections, and actual transport failures still produce errors.

## Shared programmable screens

A screen is an HTML/CSS/JavaScript miniapp displayed **on the voice stage**. People in the room receive an invitation in the same corner as screen-sharing notices and choose whether to view it. There is no miniapp chat card or automatic opening. Unlike private `ctx.prompt()` forms, it accepts multiple participants and remains active after its command handler finishes. MonkyBot's `/jogo-da-velha` demonstrates two players and spectators; its rules remain in the bot, not in a viewer's JavaScript.

The tile stays on the stage alongside cameras and screen shares, even when its view is closed. **Open miniapp** starts local viewing; **Leave miniapp** ends it and returns the tile to its closed state without closing the miniapp for anyone else. Focusing or returning to the grid only changes the layout: it does not reload the screen or change player seats. Opening a screen to watch is not the same as joining its game.

**End miniapp** is a separate action: it removes the instance, tile, and
invitations for everyone and closes all open views. It is available only to the
person who invoked the creating command or an administrator (`ADMINISTRATOR`,
including the server owner). The server enforces the same authorization and
this connection's presence in the room; hiding a button is not the protection.
The creator is the authenticated `creatorUserId`, preserved when rejoining or
using another device, not the bot's identity or a caller-supplied field.
Screens created without an invocation have no human creator; only
administrators can end them from the client.

Other open views display a temporary notice with the miniapp's name, in the
client's language. People who only received an invitation or already left
the view do not receive this notice.

Inside a command, `ctx.createScreen()` queries the caller's current voice room and binds the miniapp to that room and invocation, including authorized private rooms. `screen.channelId` always identifies a **voice channel**, not `ctx.channelId` (the command's text channel). Creation without voice membership is rejected. The bot does not need an audio connection to host a miniapp. Standalone `bot.createScreen(serverId, input)` requires the bot's own access; supplying `invocationId` enables invocation-scoped authorization. This does not grant general access to private messages.

```ts
bot.command({
  name: 'screen',
  description: 'Open a shared screen',
  voiceRequirement: 'joined',
  handler: async (ctx) => {
    await ctx.createScreen({
      title: ctx.locale === 'en' ? 'Shared screen' : 'Tela compartilhada',
      html: `<main id="message"></main><script>
        window.monkyScreen.onState(state => {
          document.getElementById('message').textContent = state.message;
        });
      </script>`,
      state: { message: ctx.locale === 'en' ? 'Hello, everyone!' : 'Olá, pessoal!' },
    });
  },
});
```

Inside the isolated document, the `window.monkyScreen` bridge provides:

| Screen API | Behavior |
|------------|----------|
| `viewer` | Frozen local context with `id`, `nickname`, and `locale` (`pt-BR` or `en`) for the person opening the screen |
| `onState((state, revision) => ...)` | Delivers initial state and updates; returns an unsubscribe function |
| `sendAction(action, payload)` | Sends an intent bound to the current revision; returns whether the bridge accepted sending it, not whether the bot accepted the action |

Read `window.monkyScreen.viewer.locale` inside the `onState()` callback to translate each person's controls. Changing the app language also triggers this callback without changing shared state/revision or recreating the iframe. Do not derive the controls' language from public state or the screen creator's language.

The SDK's `screenAction` event delivers `{ serverId, screenId, instanceId, channelId, userId, userNickname, action, payload, revision, actionId }`. Use the authenticated identity in this envelope, never a player/user supplied in `payload`. Validate the action and game rules in the bot before calling `await bot.updateScreen(serverId, screen, { state, expectedRevision })`. Pass the returned snapshot, or a `BotScreenRef` containing `{ id, instanceId }`, not just a string ID. An accepted update increments `revision` and reaches participants; an old revision is rejected rather than overwriting a concurrent change. HTML remains unchanged during state updates.

Use `listScreens(serverId, channelId)` with the voice room's ID to obtain current
snapshots and `closeScreen(serverId, screen)` for bot-initiated termination.
The server generates `instanceId`: even if `id` is reused, the replacement gets
a different instance. Old updates, actions, terminations, and events cannot
affect it. Human END is independent of the latest state revision; a concurrent
update cannot prevent ending the correct instance.

The `screenRemoved` event delivers `{ serverId, id, instanceId, channelId, reason }`.
For `reason === 'ended'`, it also includes the server-authenticated
`endedByUserId`. Other reasons are `closed`, `access_revoked`, `bot_disconnected`,
and `view_revoked` (revocation of one local view, not global termination).
Delete the corresponding bot state after comparing **server, ID, and instance**:
cancel timers/expiry, abort pending work, and release game seats. If the
instance owns music playback, stop its source/queue and release its resources
too; the SDK cannot infer a bot's domain rules. Never treat an instance-not-found
error as an instruction to recreate it.

After END, the still-running creating invocation is cancelled, including its
prompts and pending work; it cannot create another screen. A fresh command is
required. Completed/expired invocations remain invalid for
creation. The SDK rejects reads/updates whose responses were overtaken by a
removal rather than returning an apparently live snapshot. After every
`await`, check that the game session is still the same before storing results.
`ctx.signal` is aborted if the invocation is still active, but does not follow
the screen after its handler finishes: use `screenRemoved` for miniapp teardown.

Register listeners once and remove them on shutdown. The client restores
active miniapps when joining their room; leaving, moving or disconnecting
closes local viewing and revokes actions. **Leave miniapp** does not send END,
erase shared state, or automatically release a player seat.

**Shared state, no secrets:** authorized participants currently in that voice room receive the HTML and JSON state. The server also checks room membership when listing screens or acting; another channel or another device in voice does not authorize this connection. Actions require `USE_BOT_COMMANDS`. Never include tokens, local paths, or a player's secret information. Screens receive no Node.js, preload, IPC, access to the client's DOM, or permission for networking, navigation, popups, and downloads. Embed visual resources in the document instead of relying on CDNs or external requests.

Limits are 128 KiB of HTML, 64 KiB of state, and 8 KiB per action; JSON allows up to 12 levels and 8,192 nodes. There may be up to four miniapps per voice room, 16 per bot, and 64 per server, with rate limits and action deduplication. They live in memory and are removed on bot restart/disconnection, loss of room authorization, or authorized termination. Leaving the room, even emptying it, does not automatically delete state. Game expiry belongs to the bot. If you persist games, persist their terminal status too: a bot restart must not restore an explicitly ended game.

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
| `bot.getPermissions(serverId)` | Read requested/granted capabilities and review status; unavailable before acknowledgement or after disconnection |
| `bot.localExecution(serverId)` | Obtain local executors and manage authorized source references |
| `bot.joinVoice(serverId, channelId, { invocationId }?)` | Join voice, using invocation authorization when supplied |
| `bot.getVoiceConnection(serverId)` | Obtain that server's active voice connection |
| `bot.leaveVoice(serverId)` | Close the connection and release media resources |
| `bot.createScreen(serverId, input)` | Create an HTML and JSON-state miniapp in a voice room |
| `bot.updateScreen(serverId, screenRef, { state, expectedRevision })` | Update the `{ id, instanceId }` instance without losing concurrent changes |
| `bot.listScreens(serverId, channelId)` | Obtain that voice room's authorized active miniapps |
| `bot.closeScreen(serverId, screenRef)` | Close the `{ id, instanceId }` instance for all participants |
| `bot.serverCount` | Number of connected servers |
| `bot.serverIds` | Connected server IDs |
| `bot.registeredServerCount` | Number of known authenticated registrations, including offline |

### `BotOptions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `publicKey` | `string` | ✅ | Ed25519 public key in hex |
| `requestedCapabilities` | `BotCapability[]` | ✅ | Explicit requested categories, never automatic grants; `[]` permits identity/metadata only |
| `serverUrl` | `string` | Manual mode | Server WebSocket URL |
| `token` | `string` | Manual mode | Bot token |
| `autoReconnect` | `boolean` | — | Auto-reconnect (default: `true`) |
| `name` | `string` | — | Bot-published name, including initial authentication |
| `avatarBase64` | `string \| null` | — | Base64/data URI photo; `null` removes the previous photo |
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
