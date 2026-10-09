# Package and distribute

This guide is for authors and operators of bots using the **SDK-provided CLI**.
It is not the [Monky server CLI](/en/cli), and a bot with a custom CLI does not
automatically receive these commands.

Complete [Your first bot](/en/bots-desenvolvimento) before packaging.
**Reference:** [BotPackageDefinition](/en/bots-api-ferramentas#botpackagedefinition),
[BotRequirements](/en/bots-api-ferramentas#botrequirements),
[handleReachabilityProbe](/en/bots-api-ferramentas#handlereachabilityprobe),
[BotUpdateSource](/en/bots-api-ferramentas#botupdatesource) and
[buildBotPackage](/en/bots-api-ferramentas#buildbotpackage).

## Automatic bot CLI and packaging

The SDK provides the [development assistant](/en/bots-desenvolvimento)
`monky-bot-sdk`; its `build` command creates a self-contained
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

The packager also declares transitive dependencies placed in a higher
`node_modules` directory (hoisting), preserving versions and aliases. This allows
offline upgrades with an empty npm cache even when the dependency layout changes
between releases; a clean installation alone does not validate this scenario.

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

The CLI provides `setup`, `start`, `stop`, `restart`, `status`, `logs`, `config`,
`requirements`, `doctor` and `consent`, with a PM2 process and configuration
isolated by bot name. `start --foreground` runs without PM2 for development.
`npm run cli -- setup` uses the same CLI in a local checkout after compilation.

Run `my-bot` without a command in a terminal to open the **arrow menu**, or use
`my-bot menu`. Enter confirms and Esc cancels; **Exit menu** does not stop the
process. **Configuration > Updates** groups the source, GitHub token, version
checks/installation and scheduling. `my-bot config` opens interactive settings;
`my-bot config show` always prints the redacted configuration. Without a TTY or
in CI, running without a command still shows help without prompting. Automation
commands and flags remain available.

On the first access from an interactive terminal, the CLI asks for **Português
(Brasil)** or **English (US)** and saves the choice in `~/.<cliName>/preferences.json`.
Later, use **Configuration → Idioma / Language** or
`my-bot config language pt-BR` / `my-bot config language en-US`.
The change appears in the next menu, even without setup, without modifying
identity, connection or token. `language` remains an alias; `--locale en-US`
applies only to that invocation. `en-US` is normalized internally to `en`.
This preference is independent of the development assistant's language.
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
and bot name. At the end it shows the [access notice](#consentimento-de-quem-hospeda)
and asks for authorization before saving; declining changes nothing. It then
lists the bot's [ports and settings](#portas-configuracoes-e-verificacao).
**URL installation is the default** for bots supporting both modes;
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

After `start` and `restart`, the CLI announces success only when PM2 confirms the
process online and, in Marketplace mode, when `/manifest` answers on this
machine with a valid manifest, the registration URL for the configured host and
port, and the bot's public key (the `X-Monky-Bot-Public-Key` header sent by
`bot.serve()`). Only then is the PM2 state saved. If `start` finds the process
online with a broken manifest, it recreates only that profile's process. The
check runs on this machine: firewall and NAT can only be proven from outside,
with `my-bot doctor`.

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

## Ports, settings and checks {#portas-configuracoes-e-verificacao}

### Declare what the bot needs

Declare in `monkyBot.requirements` the inbound ports and the settings the bot
reads from its environment. The SDK already knows the Marketplace manifest port;
do not declare it. Example with an on-demand game port and an API key:

```json
{
  "monkyBot": {
    "requirements": {
      "notice": {
        "pt-BR": "Busca músicas no YouTube.",
        "en": "Searches music on YouTube."
      },
      "ports": [{
        "id": "games",
        "description": { "pt-BR": "Assets e multiplayer dos jogos", "en": "Game assets and multiplayer" },
        "protocol": "tcp",
        "portEnv": "MY_BOT_GAMES_PORT",
        "defaultPort": 7781,
        "hostEnv": "MY_BOT_GAMES_HOST",
        "publicUrlEnv": "MY_BOT_GAMES_PUBLIC_URL",
        "exposure": "public",
        "when": "on-demand"
      }],
      "settings": [{
        "env": "MY_BOT_API_KEY",
        "description": { "pt-BR": "Chave da API de músicas", "en": "Music API key" },
        "required": true,
        "secret": true
      }]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `ports[].id` | Short name (`a-z`, `0-9`, `-`); `manifest` is reserved |
| `protocol` | `tcp` (default) or `udp` |
| `portEnv` / `defaultPort` | Variable the bot reads for the port, and the value used without it |
| `hostEnv` | Variable for the listening address (default `0.0.0.0`) |
| `publicUrlEnv` | Variable holding the public origin `http(s)://host[:port]`, e.g. behind an HTTPS proxy. In Marketplace mode, without it, the CLI uses the configured public host and the port |
| `exposure` | `public` (default): other machines must reach it; `local`: only this machine uses it |
| `when` | `always` (default) or `on-demand`, when the bot opens the listener only when the feature is used |
| `modes` | Modes the port or setting applies to; default: every mode in `monkyBot.modes` |
| `settings[].required` / `secret` | Required to operate / value never displayed nor accepted as an argument |
| `notice` | The bot's own access (external services, tools), shown in the consent |

Texts have `pt-BR` and `en`. There are at most 8 ports and 32 settings; each
variable appears once, and names used by the CLI or the system
(`MONKY_SERVE_*`, `MONKY_BOT_*`, `MONKY_HOST_CONSENT`, `PATH`, `NODE_OPTIONS`,
`PM2_*`, among others) are rejected. `build` publishes the declaration in the
package.

### What the operator opens and configures

`my-bot requirements` lists the ports to allow through the firewall or router and
the settings, even before setup. The same summary appears at the end of `setup`
and in `status`. Declared settings may come from the process environment or be
saved in the profile:

```text
my-bot config env
my-bot config env set MY_BOT_GAMES_PUBLIC_URL https://games.example.com
my-bot config env set MY_BOT_API_KEY
my-bot config env set MY_BOT_API_KEY --from-env OTHER_VARIABLE
my-bot config env unset MY_BOT_API_KEY
```

Secrets are requested through hidden input (or `--from-env`) and never passed as
arguments. Values live in `~/.<cliName>/environment.json` (`600`/`700` on Linux),
outside the package, and are validated by type: port, listening address or a
public URL without a path. **The process environment wins**: the runner injects a
saved value only when the variable is absent from the environment, so Docker,
systemd and compose keep working. `doctor` warns when both values differ and
says which one is in use. On the restart performed by an update, the CLI drops
the copies of these variables kept in the updater's environment and carries over
the values the bot process was running with. Restart the bot after changing a
setting.

### Host operator consent {#consentimento-de-quem-hospeda}

Before running the bot, the host operator confirms its access: the process uses
the system account permissions (no sandbox), reads its own program, writes its
identity and links to `<botDir>/.keys`, connects to Monky servers, listens on
the declared ports and is managed by the profile's PM2. The notice includes the
bot's settings and `notice`. Each server's administrators still decide which
capabilities the bot may use.

The confirmation applies to the working directory and to a **fingerprint**
computed from the declared ports, settings, `notice` and modes. `start`,
`start --foreground`, `restart` and the runner refuse to start without it.

```text
my-bot consent
my-bot consent --accept <fingerprint>
my-bot consent --revoke
```

Interactive setup asks for confirmation; `--non-interactive` leaves the profile
pending and prints the fingerprint. For automation, review the access and set
`MONKY_HOST_CONSENT=<fingerprint>` in the service environment. Profiles created
before consent existed inherit the current access and keep running; `status` and
`doctor` remind you to review it. When a new version changes the declared
access, `update` shows the new notice and asks before installing; `update --yes`
and auto-update skip that version and keep the current bot running until it is
approved (or until `MONKY_HOST_CONSENT` matches the new fingerprint). Changing
`botDir` also requires a new confirmation.

### Check whether the bot can operate (`doctor`)

`my-bot doctor` (also in the menu) reports what is ready and what is missing,
with `[OK]`, `[WARN]`, `[FAIL]` or `[SKIPPED]`, and exits with an error when
anything fails. It checks:

- Node.js, the built entry, profile, the `.keys` identity and consent;
- the process in the profile's PM2, and a same-named process in the account's
  default PM2 (for example from a former standalone CLI) that may hold the ports;
- the manual-mode token and required settings, in the environment of the running
  process or of this terminal;
- each port: free or in use and, when in use, whether it answers **as this bot**
  to a challenge signed with its Ed25519 key; in Marketplace mode, also the
  manifest's validity;
- the public URL from this machine — routers without *hairpin NAT* may fail here
  without an actual problem;
- with the Monky server: URL reachability, token, key binding and protocol
  compatibility, plus an **external test** of the public TCP ports performed by
  the server itself.

In manual mode the test uses the configured server and token. In Marketplace
mode it uses up to three servers saved in `.keys/registrations.json`; without any
link, the external test is skipped. It uses a separate connection without a
session, so it neither disconnects the running bot nor binds the key before the
first `start`. Free ports get a temporary responder from `doctor` itself during
the test, so the firewall can be checked with the bot stopped or before anyone
uses an on-demand feature; meanwhile (a few seconds) the port is occupied.
`my-bot doctor --local` skips all server communication.

The external test tells whether **that server** can reach the port from its own
network; other networks may have different rules. So that it cannot serve as a
scanner, the server only accepts a valid token, at most 8 targets, ports 80, 443
and 1024–65535, and public addresses or the request's own source IP. It resolves
DNS once, does not follow redirects and only answers "reachable" when the
endpoint signs a fresh challenge with the bot's key; a closed, filtered or
foreign port all look the same "not reachable", always after the same delay and
with per-IP, per-bot and concurrency limits. Servers older than protocol 37 do
not offer the test, and `doctor` asks to update them.

The bot's own listeners, such as a miniapp server, must forward the challenge to
be verified while active:

```ts
import http from 'node:http';
import { handleReachabilityProbe } from '@monky/bot-sdk';

const server = http.createServer((request, response) => {
  if (handleReachabilityProbe(request, response)) return;
  // ...bot routes
});
```

`handleReachabilityProbe` only answers `GET /.well-known/monky-bot-reachability`
and signs with the identity the CLI runner registers in the process; outside the
CLI it answers 404. `bot.serve()` already does this on the manifest port.

## Optional CLI updates

`update` and enabling `autoupdate` require an explicit source. Authors can define
a default in the build's `package.json`; operators can override it after
installation without editing the package or repeating setup.
**GitHub Releases is recommended**, with version history and stable/beta
selection using the existing package format.

```text
my-bot config update-source
my-bot config update-source github https://github.com/my-org/my-bot/releases
my-bot config update-source github https://github.com/my-org/my-bot/releases --asset-name my-bot-{version}.tgz --token-env GH_TOKEN
my-bot config update-source https https://downloads.example.com/my-bot.tgz
my-bot config update-source file "C:\updates\my-bot.tgz"
my-bot config update-source reset
my-bot update --check
```

The selection lives in `~/.<cliName>/update-source.json`, outside the installed
package, and applies to `update` and subsequent `autoupdate` checks. It survives
package replacement without changing the channel, connection, keys, or registrations.
With no arguments, the command shows the effective source; `reset` removes the
override and restores the current package default. An invalid saved configuration
blocks updates rather than silently falling back to a different source.

The `file` command resolves a relative path against the terminal's working
directory when saving. Use a native path on the bot machine. HTTPS accepts
`--token-env`; GitHub also accepts `--asset-name`. Store only an environment
variable name, never its token. Changing the source validates its configuration;
`update --check` checks availability at the selected source.

### Private GitHub repositories

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
with the correct resource owner, only the required repository and
**Contents: Read-only**. An organization may require approval before it works.
Use a limited lifetime and renew the secret when needed.

`--token-env GH_TOKEN` takes the **variable's name**, not its secret.
Make the value available in the environment of the process checking/downloading
updates. For example, in PowerShell 7:

```powershell
$env:GH_TOKEN = Read-Host 'GitHub token' -MaskInput
my-bot config update-source github https://github.com/my-org/my-bot/releases --token-env GH_TOKEN
my-bot update --check
```

Do not put the token in URLs, `package.json`, code, logs or issues.
For automatic updates, configure the service environment too: a variable set
in a terminal is not, by itself, persistent service configuration. This
download token is different from the token linking a bot to a Monky server.

You can also paste the token in **Configuration > Updates > Private GitHub token
(hidden input)**, or run:

```text
my-bot config update-token
my-bot config update-token --status
my-bot config update-token --clear
my-bot config update-token --from-env GH_TOKEN
```

The CLI shows the creation link and explains the permission before asking for
the secret. Tokens are not validated as environment-variable names: PAT formats
are accepted as authentication values, while spaces, controls and line breaks
are rejected. **Saving does not confirm access**; run `update --check` to validate
the repository and permissions.

The credential lives in `~/.<cliName>/update-credentials.json`, outside the
package, with `600`/`700` permissions on Linux. It is limited to the selected
GitHub repository and is not reused after switching to another repository or an
HTTPS/file source. Explicit environment variables take precedence. Auto-update
reads the same credential on subsequent runs without copying it into the bot's
environment; `--clear` does not change external variables. Never pass a secret
as an argument.

### Package-provided default

Authors can distribute a default with:

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

In this package default, relative file paths resolve from the **installed** `package.json`, never from the
terminal or PM2 working directory. Prefer portable relative paths across platforms;
absolute paths must be native to the environment. There is no tilde/environment
expansion. The source must be a readable regular `.tgz` file, not a symbolic link;
the CLI copies a private snapshot before inspection and installation.

The package default accepts exactly one source: `releases` or `updateSource`.
Without a default or an operator override, the SDK does not infer a source from
`repository`, `git origin`, the SDK repository or the npm registry.
An invalid URL fails rather than enabling another source.

`update --check` never installs or restarts. GitHub checks query metadata only;
HTTPS/file checks fetch or copy an archive to inspect its version, then discard it.
`update` follows stable and `update --beta` includes
pre-releases. Selection uses semantic versions, without downgrades or reinstalling
the same version. Auto-update also uses stable, even on a beta installation;
pre-releases require `autoupdate on [HH:MM] --beta`. After upgrading an older CLI,
repeat `autoupdate on` with the desired schedule and channel to refresh its process.
Single-archive sources offer only the version in that file;
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

If an older package fails with `ENOTCACHED` during an upgrade despite installing
offline into an empty directory, the author must build a new release with the
corrected packager. Updating only the SDK on the operator's machine does not fix
the metadata in an already published `.tgz`. Do not remove `--offline` or enable
scripts as a workaround.

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
