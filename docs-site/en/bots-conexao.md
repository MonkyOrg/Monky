# Connection and identity

Use a manual connection for development and Marketplace mode for URL-based
registrations. The identity must survive updates independently of the chosen
mode.

**Reference:** [BotOptions](/en/bots-api-cliente#botoptions),
[ServeOptions](/en/bots-api-cliente#serveoptions) and
[methods and events](/en/bots-api#construction-and-connection).

## Marketplace mode (multi-server)

To distribute a bot through a manifest, use `serve()`. In the
[tutorial project](/en/bots-desenvolvimento), change `monkyBot.modes` to
`["manual", "marketplace"]`, use the entry point below, build and run
`npm run cli -- setup` again in that mode. The CLI supplies the identity,
registration path, configured port and host. Choose URL installation in
the wizard; the entry point also preserves manual mode.

```ts
import {
  BotClient, validateBotPublicHost, validateBotServePort,
  validateBotServerUrl, validateBotToken,
} from '@monky/bot-sdk';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const marketplace = process.env.MONKY_SERVE === 'true';
const bot = new BotClient({
  requestedCapabilities: ['commands'],
  publicKey: requiredEnvironment('MONKY_BOT_PUBLIC_KEY'),
  registrationFile: marketplace ? requiredEnvironment('MONKY_BOT_REGISTRATION_FILE') : undefined,
  name: process.env.MONKY_BOT_NAME ?? 'My Bot',
});

bot.command({
  name: 'ping',
  description: 'Check whether the bot is online',
  localizations: { 'pt-BR': { description: 'Verifica se o bot está respondendo' } },
  handler: (ctx) => ctx.reply(ctx.locale === 'en' ? 'Pong! I am online.' : 'Pong! Estou online.'),
});
bot.on('error', (error: Error) => console.error('[bot]', error.message));
const shutdown = () => {
  void bot.close().catch((error: unknown) => {
    console.error('[shutdown]', error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

if (marketplace) {
  await bot.serve({
    name: process.env.MONKY_BOT_NAME ?? 'My Bot',
    description: 'Example bot / Bot de exemplo',
    port: validateBotServePort(requiredEnvironment('MONKY_SERVE_PORT')),
    publicHost: validateBotPublicHost(requiredEnvironment('MONKY_SERVE_PUBLIC_HOST')),
  });
} else {
  bot.connect({
    serverUrl: validateBotServerUrl(requiredEnvironment('MONKY_SERVER_URL')),
    token: validateBotToken(requiredEnvironment('MONKY_BOT_TOKEN')),
  });
}
```

After setup, run `npm run cli -- start --foreground`. The
`process.env.MONKY_SERVE === 'true'` comparison is explicit: the string
`'false'` is also truthy in JavaScript. Only declare implemented modes.

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
sudo iptables -I INPUT 1 -p tcp --dport 7780 -j ACCEPT

# If using ufw (Ubuntu):
sudo ufw allow 7780/tcp

# If on cloud (AWS, GCP, Azure, etc.):
# Allow port 7780 TCP in your Security Group / Firewall Rules
```

Also, `publicHost` must be the machine's **public IP or domain** — `localhost` only works if bot and server run on the same machine.

Connectivity must also work **from the bot to the Monky server**. Registration
sends the WebSocket URL the client used to reach the server, preserving its
host, port and path; it does not turn a `0.0.0.0` listener into `localhost`.
If the bot runs on a VPS and the server on your computer, connect to Monky using
an IP or domain reachable from that VPS. Firewall rules, port forwarding or a
proxy must allow the return connection; reaching the bot manifest does not
prove that this second path works.

A server advertised through loopback only accepts installation when both the
manifest and registration URLs also use loopback. Otherwise, the preview is
rejected before creating an account or sending a token, with guidance about
the required address. For a bot and server on the same machine, use local URLs
on both sides, or connect to the server through its external address. Proxies
must preserve the original `Host` and set `X-Forwarded-Proto: https` when
terminating TLS; the callback then uses `wss`. This adjustment does not require
deleting identities or valid registrations.

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

## Bot photos

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
