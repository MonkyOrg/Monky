# Package and distribute

This guide is for authors and operators of bots using the **SDK-provided CLI**.
It is not the [Monky server CLI](/en/cli), and a bot with a custom CLI does not
automatically receive these commands.

Complete [Your first bot](/en/bots-desenvolvimento) before packaging.
**Reference:** [BotPackageDefinition](/en/bots-api-ferramentas#botpackagedefinition),
[BotUpdateSource](/en/bots-api-ferramentas#botupdatesource) and
[buildBotPackage](/en/bots-api-ferramentas#buildbotpackage).

## Automatic bot CLI and packaging

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
