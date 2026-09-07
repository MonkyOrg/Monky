# Bots

Monky has a complete bot system that lets you automate tasks, add custom commands, and integrate external services into your server.

## What is a bot?

A bot is an **external process** that connects to the Monky server via WebSocket, just like any other user. The difference is that bots:

- Authenticate with a **token** instead of a password
- Can register **slash commands** (`/ping`, `/dice`, etc.)
- Show a **BOT** badge in the member list
- Don't count toward the user limit (they have their own limit: `maxBots`)

The bot runs on **its own machine** (VPS, cloud, your PC), not on the Monky server. The server only routes messages — all processing happens on the bot side.

```
User types /ping
        ↓
Monky Server (routes)
        ↓
Bot (processes) → ctx.reply('🏓 Pong!')
        ↓
Monky Server (delivers to channel)
        ↓
User sees the response
```

## Two ways to add a bot

### 1. Manual (token)

Ideal for internal bots on a specific server.

1. In the client, go to **Server Settings → Bots**
2. Enter a name and click **Create**
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

### Prerequisites

- **Node.js 18+**
- A Monky server running (v9.0.0+)
- The `@monky/bot-sdk` package

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
    { name: 'sides', description: 'Number of sides', type: 'string', required: false },
  ],
  handler: (ctx) => {
    const sides = parseInt(ctx.args.sides, 10) || 6;
    const result = Math.floor(Math.random() * sides) + 1;
    ctx.reply(`🎲 Result: **${result}**`);
  },
});

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
    // ctx.args       — arguments { name: value }
    // ctx.reply()    — reply in the channel (visible to all)
    // ctx.replyEphemeral() — reply only to the invoker
  },
});
```

### Ephemeral responses

Use `ctx.replyEphemeral()` for messages only the invoker can see:

```ts
bot.command({
  name: 'secret',
  description: 'Tells you a secret',
  handler: (ctx) => {
    ctx.replyEphemeral('🤫 Only you can see this!');
  },
});
```

## Marketplace mode (multi-server)

If you want to distribute your bot so any Monky server can install it, use the `serve()` mode:

```ts
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  publicKey: 'YOUR_ED25519_PUBLIC_KEY_HEX',
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
- `POST /register` — receives the token from each server that installs the bot

Each server that installs creates an **independent WebSocket connection**. The bot manages all of them automatically, with reconnection.

### Network requirements

For Monky servers to reach the manifest and register the bot, the configured port (default `7780`) must be **externally accessible**:

```bash
# Check if the port is open
curl http://YOUR-IP:7780/manifest

# If using iptables (Linux):
sudo iptables -A INPUT -p tcp --dport 7780 -j ACCEPT

# If using ufw (Ubuntu):
sudo ufw allow 7780/tcp

# If on cloud (AWS, GCP, Azure, etc.):
# Allow port 7780 TCP in your Security Group / Firewall Rules
```

Also, `publicHost` must be the machine's **public IP or domain** — `localhost` only works if bot and server run on the same machine.

### Useful properties

```ts
bot.serverCount;  // Number of connected servers
bot.serverIds;    // List of server IDs
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

> 💡 **You don't need to generate keys manually.** The [Monky Bot](https://github.com/MonkyOrg/MonkyBot) and bots built with the SDK can auto-generate the Ed25519 key pair on first run. Keys are saved to `.keys/` and reused.

## Monky Bot (official bot)

[**Monky Bot**](https://github.com/MonkyOrg/MonkyBot) is the reference bot maintained by the organization. It serves as a practical example and includes utility commands:

| Command | Description |
|---------|-------------|
| `/ping` | Bot latency |
| `/dado [sides]` | Roll a dice (2-100 sides) |
| `/moeda` | Coin flip |
| `/8ball <question>` | Magic 8-ball |
| `/enquete <question> [options]` | Quick poll |
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
| `bot.serve(options)` | Start HTTP server for marketplace |
| `bot.serverCount` | Number of connected servers |
| `bot.serverIds` | Connected server IDs |

### `BotOptions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `publicKey` | `string` | ✅ | Ed25519 public key in hex |
| `serverUrl` | `string` | Manual mode | Server WebSocket URL |
| `token` | `string` | Manual mode | Bot token |
| `autoReconnect` | `boolean` | — | Auto-reconnect (default: `true`) |

### `ServeOptions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | ✅ | Name shown in the manifest |
| `description` | `string` | — | Bot description |
| `icon` | `string` | — | Icon (URL or base64) |
| `port` | `number` | — | HTTP port (default: `7780`) |
| `host` | `string` | — | Bind address (default: `0.0.0.0`) |
| `publicHost` | `string` | — | Public hostname for registration |
