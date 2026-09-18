# Your first bot

Create a TypeScript bot that appears in Monky and responds to `/ping`. This
path is for **developers**; if you only want to add or use an existing bot,
go to [Use bots](/en/bots).

The **Monky bot SDK** (`@monky/bot-sdk`) connects your bot's process to the
server. You write the logic; Monky
renders native commands, forms and controls, validates permissions and routes
responses.

## Before you start

- Use **Node.js 22 or 24** and npm.
- Have a test Monky server and permission to manage its bots.
- Client, server and bot SDK must use the same `PROTOCOL_VERSION`.
- This example was prepared with **bot SDK 22.1.0, protocol 20**.
  The installer selects the latest stable release; if it differs, check that
  release's `monky-compatibility-<version>.json` file before connecting.

::: info Why does the first example use a token?
Manual mode lets you test without exposing an HTTP port for the bot. It does
not automatically approve permissions. To distribute your bot through a
manifest URL, continue with [Connection and identity](/en/bots-conexao).
:::

## 1. Prepare the project

Create an empty directory and save this `package.json` in it. It describes
**your bot** and its development commands. The installer will add the bot
SDK dependency; you do not need to copy a release URL into this file.

```json
{
  "name": "my-bot",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "cli": "monky-bot-sdk cli",
    "package": "monky-bot-sdk build"
  },
  "monkyBot": {
    "cliName": "my-bot",
    "displayName": "My Bot",
    "entry": "dist/index.js",
    "files": ["dist"],
    "modes": ["manual"]
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3"
  }
}
```

Create `tsconfig.json` in the same directory:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmitOnError": true
  },
  "include": ["src/**/*.ts"]
}
```

### Install the bot SDK

In the project directory, choose your terminal. On Linux, the command uses
the [official installer](https://monkyorg.github.io/install-bot-sdk.sh);
PowerShell queries the release directly, without requiring Bash:

::: code-group

```powershell [Windows — PowerShell]
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/MonkyOrg/Monky/releases/latest' -ErrorAction Stop
$version = $release.tag_name.TrimStart('v')
$asset = @($release.assets | Where-Object { $_.name -eq "monky-bot-sdk-$version.tgz" })
if ($asset.Count -ne 1) { throw 'Bot SDK not found in the stable release.' }
npm install $asset[0].browser_download_url
```

```bash [Linux — Bash]
curl -fsSL https://monkyorg.github.io/install-bot-sdk.sh | bash
```

:::

Both options query the latest stable Monky release, find its
`monky-bot-sdk-*.tgz` artifact and run `npm install` in the project. This
also installs the dependencies declared above and updates `package.json`
and `package-lock.json`. Commit both files to reproduce the installation.
This installs the bot library, **not the Monky app**. It does not generate
your bot's code or create a server registration.

With the Bash script, to include beta releases when choosing a version,
replace `bash` with `bash -s -- --beta`. First check that your client and
server use a compatible protocol.

::: info Continue with this page's example
The Bash installer's final message still prints an outdated code example.
Use the next step in this guide, which declares capabilities and correctly
receives the identity created by the CLI.
:::

<details>
<summary>macOS, Bash script limitations or a specific version</summary>

The current Bash script requires `curl` and GNU `grep` with `-P` support.
That option is unavailable in the default macOS `grep` and may fail in
Windows Git Bash; on Windows, prefer the PowerShell command above.

On macOS, or to choose a specific version, copy the URL
of the `monky-bot-sdk-<version>.tgz` artifact from the
[official release](https://github.com/MonkyOrg/Monky/releases) and pass it to
`npm install`. For example, for the version used in this guide:

```text
npm install https://github.com/MonkyOrg/Monky/releases/download/v22.1.0/monky-bot-sdk-22.1.0.tgz
```

Run it in the project directory, without `-g`. npm writes the dependency
to `package.json`; there is no need to edit that field manually.

</details>

## 2. Write the command

Create `src/index.ts`:

```ts
import {
  BotClient,
  validateBotServerUrl,
  validateBotToken,
} from '@monky/bot-sdk';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const bot = new BotClient({
  requestedCapabilities: ['commands'],
  publicKey: requiredEnvironment('MONKY_BOT_PUBLIC_KEY'),
  name: process.env.MONKY_BOT_NAME ?? 'My Bot',
});

bot.command({
  name: 'ping',
  description: 'Check whether the bot is online',
  localizations: {
    'pt-BR': { description: 'Verifica se o bot está respondendo' },
  },
  handler: (ctx) => {
    ctx.reply(ctx.locale === 'en' ? 'Pong! I am online.' : 'Pong! Estou online.');
  },
});

bot.on('error', (error: Error) => {
  console.error('[bot]', error.message);
});

const shutdown = () => {
  void bot.close().catch((error: unknown) => {
    console.error('[shutdown]', error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

bot.connect({
  serverUrl: validateBotServerUrl(requiredEnvironment('MONKY_SERVER_URL')),
  token: validateBotToken(requiredEnvironment('MONKY_BOT_TOKEN')),
});
```

The bot SDK CLI creates/reuses the identity and provides these environment
variables to the process. Do not put a token in source code, generate a new
key on every launch or run `node dist/index.js` without preparing this
environment.

## 3. Link and start

1. In Monky, open **server name → Server Settings → Bots**.
2. Open **Show advanced option** and generate a manual link.
3. Copy the token shown only once.

In the project terminal:

```text
npm run build
npm run cli -- setup
npm run cli -- start --foreground
```

In setup, enter the server address, token and bot name. For a server on the
same computer, `localhost:3000` is an example; use the actual port. Enter the
token in the assistant's hidden input, not as a shell argument.
`--foreground` keeps the process in that terminal without creating a PM2
daemon.

## 4. Approve and run

In the client, open **Bot settings → Server permissions**, enable the
requested **commands** capability and save. Being online does not replace
this approval.

In a text channel that allows bots, type `/`, select the bot and run `/ping`.
The response should appear **only for the caller**.

<AppScreenshot src="/screenshots/comandos-en.png" alt="The command menu showing the responsible bot and descriptions of available commands." caption="The client presents the catalogue. The minimal example registers only /ping; GuiaBot in the screenshot demonstrates additional SDK features." />

::: tip If the bot is online but /ping is missing
Check capability approval, your role's permission and the channel's
**Allow bot commands** switch. The [diagnostic guide](/en/bots#when-something-goes-wrong)
separates these cases from connection and protocol failures.
:::

## What you can build

| Feature | Guide with examples | Main capability |
| --- | --- | --- |
| Typed parameters, translations and paginated autocomplete | [Commands](/en/bots-comandos) | `commands` |
| Private forms and multi-step questions | [Interactions](/en/bots-interacoes) | `commands` |
| Public messages, reactions and persistent polls | [Interactions](/en/bots-interacoes) | `send_messages`, `read_messages` and/or `selectors`, depending on the operation |
| Personal preferences and per-server behavior | [Settings](/en/bots-configuracao) | Server scopes and permissions |
| Audio previews and Soundboard downloads | [Audio](/en/bots-audio) | `commands`; downloads also require `sound_download` |
| Publish P2P or SFU audio | [Voice](/en/bots-voz) | `publish_voice` |
| Authorized tasks on the user's computer | [Local execution](/en/bots-execucao-local) | `local_execution` |
| Shared HTML screens in voice rooms | [Miniapps](/en/bots-miniapps) | `miniapps` |
| CLI, installable package and updates | [Distribution](/en/bots-distribuicao) | Package configuration |

Add only the capabilities you need to `requestedCapabilities`. Grants require
administrator approval; adding a feature does not silently authorize an
already installed bot.

## How to use the documentation

The guides explain **when and how to use** each feature. The
[bot SDK reference](/en/bots-api) covers return values, events and lifecycle, with
links to the complete signatures of every public export.

Feature-guide examples extend the `bot` instance from this tutorial. Declare
commands and settings **before connecting**. When an example uses a variable
such as `serverId`, obtain it from SDK contexts or events — do not invent an
ID or use the server's name.
