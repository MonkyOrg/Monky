# Monky CLI

This is the **server CLI**, not the CLI generated for a bot. To package
and operate your own bot, see [Bot distribution](/en/bots-distribuicao).

Command line tool to create and administer Monky servers.

```
monky <command> [subcommand] [options]
```

The CLI is installed globally and does not depend on the directory you are in:
it keeps a registry of this machine's servers in `~/.monky/servers.json` and
uses it to know which server each command applies to.

## Installation

Requires **Node.js 22 or newer** (required by mediasoup, used in SFU mode).

```bash
curl -fsSL https://monkyorg.github.io/install.sh | bash
```

To install a beta version:

```bash
curl -fsSL https://monkyorg.github.io/install.sh | bash -s -- --beta
```

<details>
<summary>Manual installation (without the script)</summary>

Download the `.tgz` for the desired version from
[Releases](https://github.com/MonkyOrg/Monky/releases) and install with:

```bash
npm install -g --allow-scripts=mediasoup https://github.com/MonkyOrg/Monky/releases/download/vX.Y.Z/monky-cli-X.Y.Z.tgz
```

`--allow-scripts=mediasoup` permits mediasoup's `postinstall`, which builds the
SFU worker. From npm 12 on, install scripts are blocked by default, and without
that binary the server still starts but SFU mode does not work: calls carry no
media and the client keeps retrying until the worker comes up. On npm older
than 11.16 the flag is unnecessary and can be omitted.

</details>

To run the server as a daemon (`monky start`) the CLI uses
[PM2](https://pm2.keymetrics.io/). If it is missing, `monky start` installs it
automatically. Every other command only warns about it:

```bash
npm install -g pm2
```

## Quick start

```bash
monky create     # creates the server and offers to start it
monky status     # check that it is up
monky logs       # follow the logs
```

## Multiple servers

A single machine can host as many servers as you want — each with its own data
directory, port and PM2 process.

When there is **one** server, commands act on it directly. When there is **more
than one**, the CLI asks which one you mean:

```
There are 2 Monky servers on this machine.
Which server would you like to restart?
❯ Friends — port 3000 — /srv/monky-friends
  Work — port 3100 — /srv/monky-work
```

Scripts and cron jobs have no interactive terminal, so pass `--data` explicitly:

```bash
monky --data /srv/monky-friends restart
```

## CLI language

The first command run in an interactive terminal asks for **English (US)** or
**Português (Brasil)** and saves the choice in `~/.monky/cli-config.json`.
`monky`, `--help` and `--version` neither ask this question nor save a
preference. Commands in scripts or with redirected input/output do not ask
or change the saved language either.

To change it later, open `monky config` and choose **Idioma / Language**, or run:

```bash
monky config language en-US
monky config language pt-BR
```

This setting works without creating or selecting a server. The next menu already
uses the new language; identity, database and server configuration are unchanged.
`monky config language` without a code opens the picker in a terminal; in scripts,
it only queries the preference. The `monky --lang pt-BR|en-US` shortcut remains available.

`en-US` is normalized to `en`; English and Portuguese variants, including
`pt_BR.UTF-8`, use the `en` and `pt-BR` catalogs. An unsupported code, a
missing `--lang` value or an invalid configuration produces an error instead
of silently overwriting the preference with a default.

Precedence is **`--lang` → `MONKY_LANG` → saved preference → terminal locale
→ English**. For terminal detection, the CLI checks `LC_ALL`, `LC_MESSAGES`,
`LANG` and `LANGUAGE`, in that order. `MONKY_LANG` lets an app or script pass
its selected language without reading or changing the CLI preference; the
CLI does not read Electron profiles.

`--lang` alongside an interactive command saves the choice. With help,
version or non-interactive commands, it applies only to that invocation.
Standalone `monky --lang <code>` explicitly edits the preference and saves
it even in scripts.

**QA isolation:** `MONKY_HOME` changes the directory of both the server
registry and the language preference. For example, in PowerShell:

```powershell
$env:MONKY_HOME = Join-Path $PWD '.monky-qa'
monky --lang en-US
monky --help
```

The preference then lives in `.monky-qa\cli-config.json`; `--data` still
selects a server's data, not its language. Command names, keys such as
`maxUsers` and `voiceMode`, permissions such as `MANAGE_ROLES`, and values
such as `true`, `false`, `p2p` and `sfu` are not translated.

## Global options

| Option | Description |
|---|---|
| `--data <folder>` | Data directory of the target server. Required when there are several servers and the terminal is not interactive. |
| `--help`, `-h` | Show the help. |
| `--version`, `-v` | Show the installed version. |
| `--lang <code>` | Select `en`/`en-US` or `pt-BR`; used alone, save the preference. |

## Data directory layout

| Path | Contents |
|---|---|
| `server.db` | SQLite database: members, roles, channels and messages. |
| `monky.json` | Server port. |
| `ecosystem.config.cjs` | PM2 configuration, rewritten on every `start`/`restart`. |
| `attachments/`, `avatars/`, `icons/` | Uploaded files. |
| `auto-update.cjs` | Only created when auto-update is enabled. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Failure. The message is printed to `stderr`. |

---

## Command reference

## `monky create`

Creates a new server: prepares the database, sets the owner and saves the port.
It replaces the former `monky bootstrap`, which still works as an alias.

```bash
monky create [options]
```

After the initial language choice, when needed, the command asks:

1. **Where to store the data** — suggests `./data`, but any path works. If the
   chosen folder already holds a server, it asks for another one.
2. **Owner identity code** (`MONKY-ID:...`) — export it from the Monky app under
   *Settings → My Profile → Identity*. Treat the backup and password as
   credentials: use them only on a trusted administration machine.
3. **Identity password** — the one you set when exporting.
4. **Server name**
5. **Server port** (default: `3000`)
6. **Server password** — leave empty for an open server.
7. **Member limit** — asks whether you want a cap on registrations. The default
   is no limit.
8. **Voice/video mode** — `p2p` or `sfu`. In SFU mode, it checks ports and
   dependencies and asks for available upload bandwidth to estimate capacity.

It then prints a summary, asks for confirmation and offers to start the server.

### Options

| Option | Description | Default |
|---|---|---|
| `--identity <code>` | Owner identity code | asked |
| `--name <name>` | Server name | `Friends Server` |
| `--port <n>` | Server port | `3000` |
| `--password <password>` | Server password (empty = no password) | asked |
| `--max-users <n>` | Registered member limit (`0` = no limit) | asked |
| `--voice-mode <p2p|sfu>` | Voice and media mode (`p2p` or `sfu`) | `p2p` |

The identity password is never accepted as an option: it is always typed
hidden in the terminal.

### Examples

```bash
# Fully interactive
monky create

# Folder given as an option, everything else asked
monky create --data /srv/monky-friends

# Non-interactive, except for the identity password
monky create --data /srv/monky-friends \
  --identity "MONKY-ID:..." \
  --name "Friends Server" --port 3000 --password "serverPassword"
```

---

## `monky list`

Lists this machine's servers and the state of each one. Also accepted as
`monky ls`.

```bash
monky list
```

```
NAME       STATUS   PORT   DATA DIRECTORY
Friends    online   3000   /srv/monky-friends
Work       stopped  3100   /srv/monky-work
```

---

## `monky start`

Starts an **existing** server as a PM2 daemon.

```bash
monky start [--port <n>] [--fresh]
```

If the machine has no server, the command fails and points at `monky create` —
it never creates a server on its own.

The `ecosystem.config.cjs` file is rewritten before starting, so the current
port and name take effect from then on. It also pins the absolute path of the
Node that ran the command (see [Changing the Node version](#changing-the-node-version)).

### Options

| Option | Description | Default |
|---|---|---|
| `--port <n>` | Port for this run only | value in `monky.json`, or `3000` |
| `--fresh` | Drops the PM2 process registration and recreates it from scratch | off |

To change the port permanently use `monky config set port`.

`--fresh` is rarely needed: the CLI detects a stale registration on its own and
recreates the process. It exists to force that by hand. Logs under
`~/.pm2/logs` are **not** deleted.

::: warning Removed options
`--password`, `--max-users`, `--name`, `--voice-channel` and `--text-channel`
are no longer accepted here. They only had an effect while creating the
database and were silently ignored for existing servers. The command now fails
pointing at the alternative: `monky create` or `monky config set`.
:::

---

## `monky stop`

Stops the server, keeping it registered in PM2.

```bash
monky stop
```

The process stays listed in PM2 on purpose: removing it would discard the logs
exactly when they matter most, right after a crash or a manual stop. `monky
logs` keeps working with the server stopped.

Online people counters (including the home page and monitor) exclude bots and
count each identity only once, even when connected from multiple devices.
Invisible people still count toward the shutdown warning: they remain connected
and will also be disconnected.

If anyone is connected at that moment, the CLI reports how many people will be
disconnected and asks for confirmation before stopping. On a non-interactive
terminal (scripts, cron) the warning is printed and the stop goes ahead.

---

## `monky restart`

Restarts the server applying the current configuration.

```bash
monky restart [--port <n>] [--fresh]
```

`ecosystem.config.cjs` is rewritten before the restart, so a port or name
changed since the last `start` takes effect.

Just like `stop`, if anyone is connected the CLI warns and asks for confirmation
before restarting.

`--fresh` works the same as in `monky start`: it drops the PM2 process
registration before bringing the server back up.

If PM2 still executes a file from another CLI installation, `start` and
`restart` automatically recreate only that server's registration. Rewriting
`ecosystem.config.cjs` is not enough in this case: PM2 may retain the previous
executable path. The data directory and logs are preserved; a change only to
the Node interpreter still uses the normal restart.

Database reads performed by `start`, `restart` and `status` (including
`--watch`) do not write data or apply migrations. The server owns migrations
at startup, after the previous instance exits, so its in-memory snapshot
cannot overwrite a schema upgraded by the CLI.

---

## `monky status`

Shows the state of the server.

```bash
monky status [--data <folder>]
```

With a single server (or with `--data`), it shows the details:

```
Server state: Friends
State: online
Data directory: /srv/monky-friends
port 3000
PM2 process: monky-server-a1b2c3d4
PID: 21877
Started at: 2026-08-27T18:02:11.000Z
Restarts: 0
Memory: 88 MB
CPU: 0%
Node.js: 24.20.0
```

`status` does not just echo what PM2 says: the port is actually probed. PM2
reports the state it *intends* to keep, not one it verified — a process that
failed to start still shows up as `online`. When PM2's claim does not match
reality, a diagnostics block appears:

```
Diagnostics
⚠ PM2 is running the server on Node 20.20.2, but Monky requires Node 22+.
  Upgrade Node, then run "monky update" to rebuild native modules and "monky restart" to apply it.
⚠ PM2 reports the process as "online", but it has no PID — it never actually started.
  This usually means PM2 is trying to use a Node that no longer exists. Run "monky restart --fresh" to re-register the process.
```

With several servers and no `--data`, it prints the same table as `monky list` —
a read-only query has no side effects, so asking would be busywork.

Detailed status for a running server also reports bots with an incompatible
or unchecked protocol. These warnings appear after `monky start` and
`monky restart` and explain when to update or check the bots' SDK. If the
server is still starting or `/preview` does not respond, the CLI reports that
compatibility could not be retrieved; check again with
`monky status --data <folder>`.

`monky list` and multi-server tables keep these warnings next to the relevant
server. In `monky status --watch`, the warning refreshes each cycle and clears
when bots reconnect with a compatible SDK. Stopped servers are not queried or
reported as incompatible.

---

## Changing the Node version {#changing-the-node-version}

PM2 runs as a **long-lived daemon** and holds on to the Node it was started
with. Upgrading Node does not upgrade PM2 along with it, and that is where most
post-upgrade trouble comes from.

What breaks is not upgrading Node itself, but the **binary path changing or
disappearing**:

| Situation | What happens |
|---|---|
| In-place upgrade (apt/NodeSource, stays at `/usr/bin/node`) | Keeps working: the path exists and now points at the new Node |
| Switching package manager (apt → nvm) and removing the old one | **Breaks**: PM2 points at a binary that no longer exists and cannot start the process |
| `nvm use` another version, without removing the old one | **Silent**: the server keeps running on the **old** Node |

In the second case PM2 shows `status: online` with `pid: N/A`, and nothing
listens on the port — the client complains that "the computer is online, but no
Monky server is active on the port". `monky status` calls this out in the
diagnostics block.

Since version 8.1 `ecosystem.config.cjs` pins the **absolute path** of the Node
that ran `monky start`, instead of letting PM2 resolve `node` from the daemon's
environment. Because the file is rewritten on every `start` and `restart`, it
re-adjusts itself.

### Recommended procedure

After changing the Node version:

```bash
monky update     # rebuilds native modules for the new ABI
monky restart    # re-pins the interpreter in the ecosystem file
pm2 save         # writes the good state to the PM2 dump
```

::: tip Use `monky restart`, not `pm2 restart`
Only `monky` rewrites `ecosystem.config.cjs`. `pm2 restart` reuses the previous
registration, with the stale interpreter.
:::

::: warning `pm2 update` alone does not fix it
`pm2 update` restores processes from `~/.pm2/dump.pm2`, and the dump carries the
old interpreter. If the server does not come back, recreate the registration:

```bash
monky restart --fresh
```

That drops the PM2 process and registers it again. Files under `~/.pm2/logs` are
preserved.
:::

If the updated CLI shows the new version but connections still report an old
protocol, check `monky status --data <folder>`. Diagnostics compare the file
actually executed by PM2 with the current CLI installation's file, showing
both when they differ. On versions without this automatic recovery,
`monky restart --fresh --data <folder>` recreates only the selected registration
without deleting the database. Run it as the user managing that instance;
if the mismatch persists, check which process is listening on the server port.

Native modules are a **separate** concern: `better-sqlite3` and the mediasoup
worker are compiled against the Node ABI (20 = 115, 22 = 127, 24 = 137). Any
major version change requires reinstalling the CLI, which is what
`monky update` does.

---

## `monky logs`

Shows the logs of the server started with `monky start`.

```bash
monky logs [--lines <n>] [--level <level>] [--no-follow]
```

### Options

| Option | Description | Default |
|---|---|---|
| `--lines <n>` | How many previous lines to show | `100` |
| `--level <level>` | Minimum level: `INFO`, `WARN` or `ERROR` | no filter |
| `--no-follow` | Print and exit instead of following live | follows |

`--level` filters by minimum level: `INFO` shows everything, `WARN` shows
warnings and errors, `ERROR` shows errors only. Continuation lines (stack
traces, for instance) inherit the level of the line above them.

### Examples

```bash
monky logs                              # follows live (Ctrl+C to exit)
monky logs --lines 500                  # starts with the last 500 lines
monky logs --level WARN                 # warnings and errors only
monky logs --level ERROR --no-follow    # prints recent errors and exits
```

::: tip
`monky logs` reads PM2's logs. If the server is running inside the Monky app,
use the **Server Monitor** in the app itself (server menu → Server Monitor).
:::

---

## `monky members`

Lists the server members and their roles.

```bash
monky members
monky members info <nickname|clientId>
```

`members info` shows the id, clientId, public key, creation and last-seen dates,
whether they own the server and their roles.

---

## `monky admin`

Grants or revokes the Admin role.

```bash
monky admin add [nickname|clientId]
monky admin remove [nickname|clientId]
```

Without an argument, the command lists the members for you to pick from.

---

## `monky roles`

Administers the server roles.

```bash
monky roles                       # list
monky roles create [name] [color] [permissions]
monky roles assign [member] [role]
monky roles unassign [member] [role]
monky roles delete [role]
```

Without arguments, each subcommand is interactive. Permissions can be passed by
name, comma separated. Colors use the `#RRGGBB` format. The server's default
role cannot be removed from a member.

---

## `monky config`

In a terminal, opens CLI settings, including language and access to the server
configuration. Without a TTY or in CI, it keeps the direct server query.

```bash
monky config                       # settings menu in a terminal
monky config show                  # show server data directly
monky config language en-US        # CLI language, even without a server
monky config set                   # pick the key interactively
monky config set <key> [value]     # change it directly
```

### Keys

| Key | Description | Default |
|---|---|---|
| `name` | Server name (at least 2 characters) | `Servidor dos Amigos` |
| `password` | Join password. Empty, `none` or `clear` removes it | no password |
| `port` | TCP port | `3000` |
| `icon` | Path to an image, copied into the data directory. Empty or `clear` removes it | no icon |
| `maxUsers` | Maximum registered members. `0` removes the limit | `20` |
| `allowSoundboard` | Allows the soundboard (`true`/`false`) | `true` |
| `allowEveryoneMention` | Allows `@everyone`/`@todos` in chat (`true`/`false`) | `true` |
| `maxAttachmentFileBytes` | Maximum size per attachment, in bytes | no limit |
| `maxAttachmentStorageBytes` | Total attachment storage, in bytes | no limit |
| `voiceMode` | Voice mode: `p2p` (direct mesh) or `sfu` (Selective Forwarding Unit) | `p2p` |
| `autoUpdate` | Enables the daily automatic update (`true`/`false`) | `false` |
| `turn` | Enables the TURN media relay (`true`/`false`). Linux only, requires coturn installed | `false` |

Changing `port` with the server running offers to restart right away.
Changing `turn` requires a manual `monky restart`.
Changing `voiceMode` applies dynamically and notifies all connected clients.

### Examples

```bash
monky config show
monky config set name "Friends Server"
monky config set password           # typed hidden
monky config set password clear     # removes the password
monky config set maxUsers 50
monky config set autoUpdate true
monky config set turn true          # see "Media relay (TURN)" below
```

---

## Media relay (TURN)

By default Monky's voice and video travel **straight between participants**
(P2P). When two members sit behind **CGNAT**, they cannot see each other and the
call does not connect. TURN fixes it by having the server **forward the media**
for that pair.

::: tip Full guide
See the [dedicated TURN Relay page](/en/turn) with detailed instructions on
ports, firewalls (Oracle Cloud, AWS, iptables, ufw), verification and
troubleshooting.
:::

### Enabling it

```bash
monky config set turn true
monky restart
```

coturn is installed **automatically** from your distro. If the server does not
run as root, run once: `sudo bash scripts/install-turn.sh`

### Required ports

| Port | Protocol | Purpose |
|---|---|---|
| `3478` | TCP and UDP | TURN signaling |
| `49152-65535` | UDP | Media relay |

Must be open **both in the Linux firewall and the provider's panel** (Oracle
Cloud, AWS, etc.).

### Checking

```bash
monky status    # should show ✔ accessible
```

### Disabling it

```bash
monky config set turn false
monky restart
```

---

## SFU Mode (Selective Forwarding Unit)

By default, Monky operates in **P2P Mesh**: each participant broadcasts audio and video directly to all other peers. However, streaming 1080p 60fps screen share to 20 users would require ~120 Mbps continuous upstream bandwidth from the host.

**SFU mode** centralizes media forwarding via `mediasoup`. The broadcaster uploads streams **once** to the host server, which forwards them to subscribers.

### Enabling via CLI

```bash
monky config set voiceMode sfu
```

The CLI automatically computes and displays a **capacity estimate** based on available CPU cores, RAM, and upload speed.

### Required ports for SFU

| Port | Protocol | Purpose |
|---|---|---|
| `40000-49151` | UDP and TCP | mediasoup worker WebRTC media ports |

The range must be open in your server firewall (Oracle Cloud Security List, AWS Security Group, iptables/ufw) — on UDP and on TCP too, which is the way in for anyone on a network that blocks UDP. Ready-to-run commands and how to check them are in [Opening the SFU mode ports](/en/hospedar-em-vps#opening-the-sfu-mode-ports).

---

## `monky update`

Updates Monky to the latest published version.

```bash
monky update [--beta] [--check] [--yes]
```

### Options

| Option | Description |
|---|---|
| `--beta`, `-b` | Also considers prereleases |
| `--check` | Only checks and exits, without updating |
| `--yes`, `-y` | Asks nothing — for scripts and the auto-updater |

The command downloads and installs the new package with `npm install -g` from
the GitHub release artifacts.

At the end the server is restarted (with confirmation, except with `--yes`).

Before disconnecting participants for that restart, the server reports that
it is updating. Clients show a dedicated notice in their selected language
and ask them to reconnect in a few seconds. This requires a running server
process that already supports the notice; an older process still running
during its first upgrade may send only the generic shutdown notice.
Declining the restart neither disconnects participants nor sends an update notice.

### Examples

```bash
monky update --check           # is there a stable update?
monky update --check --beta    # and considering betas?
monky update                   # updates to the latest stable
monky update --beta            # updates to the latest, betas included
```

### Automatic updates

```bash
monky config set autoUpdate true
```

Registers a daily PM2 task, at 4am, running `monky update --yes` for that
server. The channel follows the installed version: if you are on a beta, the
auto-updater follows the beta channel.

It works on Linux, macOS and Windows. To turn it off:

```bash
monky config set autoUpdate false
```

---

## `monky destroy`

**Permanently** deletes all data of a server.

```bash
monky destroy [--data <folder>]
```

Removes the database, attachments, avatars and configuration, kills the PM2
process and drops the server from the registry. It asks for two confirmations:
typing `DESTROY` and a final "yes". It only accepts folders that actually hold a
Monky server.

If anyone is connected, the warning shows up before the confirmations, saying
how many people will be disconnected.

---

## See also

- [Host on a VPS](/en/hospedar-em-vps) — keeping the server up 24/7
- [Verify Releases](/en/verificar-releases) — checking that downloads are authentic
