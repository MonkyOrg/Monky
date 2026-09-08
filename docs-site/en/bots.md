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
- Client, server, and SDK compatible with **protocol 9**
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
    // ctx.signal     — aborts on cancellation, disconnect, timeout or completion
  },
});
```

### Guided parameters in chat

Typing `/` opens a menu with frequently used commands and sections grouped by bot. Each item identifies the command, its description, and its bot. While browsing, required parameter chips and the optional parameter count help choose a command.

Selecting a command with parameters identifies **which bot and command** are selected in a compact composer with named fields, descriptions, and placeholders. Optional parameters can be added when needed. Submission uses the names declared in `options`; there is no need to join values with commas. Commands without parameters, such as `/ping` and `/enquete`, start their interaction immediately when selected.

Usage frequency stays local and is scoped by server and identity. Only counts and recency are stored, never the values entered in parameters.

| Type | Control | Value in `ctx.args` |
|------|---------|---------------------|
| `string` | Text; with `choices`, an option selector | `string` |
| `integer` | Whole number, with optional `min` and `max` bounds | `number` |
| `boolean` | Switch | `boolean` |
| `user` | Member selector | Member ID (`string`) |

`required: true` prevents submission without a value. An unfilled optional parameter is omitted; valid values such as `false` and `0` are retained. The server validates parameters again before invoking the bot. Two bots can have a command with the same name: selection in chat retains the chosen bot.

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
