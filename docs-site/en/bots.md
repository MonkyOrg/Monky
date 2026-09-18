# Use bots {#bots}

Bots add commands, polls, music and miniapps to your server. This guide is
for **Monky users and administrators**. You do not need to program anything
to follow these instructions.

::: tip Want to create a bot?
Start with [Your first bot](/en/bots-desenvolvimento). The bot SDK documentation
has feature guides, examples and a [complete API reference](/en/bots-api).
:::

## What is a bot?

A bot is an external program that connects to the server and appears in the
member list with a **BOT** badge. Its operator keeps that process running;
linking a bot in Monky does not automatically install or host its program.

The bot publishes its own name and avatar. Server administrators control
its registration and permissions, not its visual identity.

## Two ways to add a bot

You must be the owner/an administrator or have **Add and manage bots**.
Open **server name → Server Settings → Bots**.

### 1. Via URL (recommended)

Ask the operator for the **manifest** URL, not the GitHub page or the program's
download URL.

1. Paste it under **Link bot by URL** and click **Link**.
2. Check the name, description and requested capabilities.
3. Enable only the access you intend to grant. Switches start off.
4. Click **Confirm and link bot** and wait for completion.

<AppScreenshot src="/screenshots/bots-vincular-en.png" alt="Server settings on the Bots tab, showing the manifest URL input and collapsed advanced manual linking." caption="The local address shown here belongs to the demo environment. A remote bot needs an address reachable by your server." />

<AppScreenshot src="/screenshots/bots-permissoes-en.png" alt="GuiaBot's capability review, with switches for commands, messages, selectors and miniapps." caption="The review shows only what this bot requested. Linking does not grant unrestricted access." />

The server must reach the manifest, and the bot must connect back to the
server. If one is on a VPS and the other on your computer, `localhost` does
not connect those two machines. Operators can find details under
[Bot network requirements](/en/bots-conexao#network-requirements).

### 2. Manual token connection (advanced)

Use this when the bot does not expose a reachable manifest:

1. Open **Show advanced option** and generate a registration/token.
2. Copy the token displayed **only once** into the bot's setup.
3. Wait for the process to connect and announce its identity and capabilities.
4. Open that bot's settings, review **Server permissions** and save.

The token authenticates the registration; it **does not approve actions**.
A reservation without an identity waits for the connection in bot
administration. Do not share the token or confuse it with the GitHub token
used to download private releases.

## Run a command

In a text channel, type `/`. The catalogue shows the responsible bot, command
name and description. Command names can be localized to your preferred
language.

<AppScreenshot src="/screenshots/comandos-en.png" alt="The demo bot's slash-command catalogue, open above the message input." caption="Choose commands from the catalogue to keep the correct bot, including when two bots use the same command name." />

- Navigate with the arrow keys and confirm with a click or `Enter`.
- **Space** selects the highlighted command without immediately running it.
- Fill required fields; optional ones appear under **+N**.
- For searches with suggestions, select a valid result. Typing text alone
  does not confirm an autocomplete choice.
- Use the cancellation controls when you do not want to continue.

Commands without parameters or downloads can start as soon as you select
them. In autocomplete, confirming the last required field can immediately
run the command when there are no optional fields. With optional fields,
the composer stays open so you can review and send.

## Replies, forms and polls

A command's default reply is **private**: only the connection that ran the
command sees it inside the chat. It does not enter public history.
The bot can explicitly publish a result if it has permission.

<AppScreenshot src="/screenshots/formulario-en.png" alt="A private GuiaBot form with activity, time selection and a reminder switch." caption="Forms are filled in directly in the chat. This is a demo; each bot defines its own questions." />

A public poll is different: it remains in the channel for authorized members
to respond and can continue after you close the conversation. Its controls
show the choices and state; duration, participant limits and vote changes
depend on the poll's configuration.

## Preferences and permissions

Right-click the bot in the member list or on its message, then open
**Bot settings**. You can also access it from the server's bot list.

| Section | Who controls it | What changes |
| --- | --- | --- |
| **My preferences** | You | This bot's language and personal preferences on this device |
| **Behavior on this server** | Administrators or a role allowed to configure bots | Shared options provided by the bot itself |
| **Server permissions** | People allowed to manage bots | Capabilities the bot may perform on this server |

**Follow Monky** uses the app's language. An explicit choice applies only to
this bot/server/identity in the current profile; it does not translate old
messages or rename commands for everyone.

Reviewing capabilities ends that bot's previous work, including interactions
and media. It may reconnect; do not use permission changes as an attempt to
"restart" an ongoing song.

### Who can use bots

Besides the bot's authorization, the person needs the role permission
**Use bot commands**. The channel must keep **Allow bot commands** enabled.
Turning it off blocks commands and interactions in that channel,
**including for administrators**.

Bots do not receive human roles. Permission to publish audio or open a
miniapp does not provide unrestricted access to private channels.

### Tools on your computer

Server permission **does not authorize your device**. Some commands ask Monky
to prepare local tools. The request explains their purpose, tools and space
requirements; you can deny it, allow until disconnecting or remember
authorization until you revoke it.

In **Settings → Bot tools**, inspect installed tools, storage, cache,
permissions and tasks. Removing a tool or revoking access stops affected
work. Monky manages these installations; they do not authorize a bot to send
arbitrary scripts.

### Download to the Soundboard

First configure a directory in **Settings → Soundboard**. An authorized
download shows its name, destination and source and never replaces an
existing file. Listening to a preview does not save it to that directory or
transmit audio to the call.

To confirm filenames again, open **Bot settings → My preferences →
Ask for a file name before downloading** and save.

## Miniapps in voice rooms

A bot can open a shared interactive screen in the room. The invitation and
card appear in the **voice stage**, not as an external site opening by itself.

<AppScreenshot src="/screenshots/miniapp-en.png" alt="A demo miniapp open in the voice stage, showing shared activity choices." caption="A bot screen uses the call stage but is not someone's camera or screen share." />

**Open miniapp** starts your local view. **Leave miniapp** closes only your
view. **End miniapp**, available to its creator or an authorized
administrator, ends that instance for everyone.

The current SDK lets bots **publish audio**, but not receive participants'
microphones, cameras or screen shares. There is no switch that grants
listening permission.

## Monky Bot (official bot)

[MonkyBot](https://github.com/MonkyOrg/MonkyBot) provides utilities, polls,
music and tic-tac-toe. Its repository explains how to install the process;
then link it and review permissions in Monky.

| Goal | Commands |
| --- | --- |
| Check availability and help | `/ping`, `/ajuda` |
| Utilities | `/dado`, `/moeda`, `/8ball` |
| Create a poll | `/enquete` |
| Search and queue music | `/play` |
| Inspect playback | `/queue`, `/nowplaying` |
| Control the queue | `/pause`, `/resume`, `/skip`, `/remove`, `/clear` |
| Stop or leave | `/stop`, `/leave` |
| Start a shared game | `/jogo-da-velha` |

Displayed names can vary by language. Use the catalogue to see localized
names, parameters and descriptions for the installed version.

Join voice before using music commands. Each server has one queue; if the
bot is already in another room, join that room to control playback. Searching,
resolving and converting audio use the requester's client with consent; the
bot's VPS does not automatically replace that device.

Spotify, playlists, albums and live streams are not supported by this
integration. Only play content you are authorized to use and respect the
[provider's terms](https://developers.google.com/youtube/terms/developer-policies).
Provider changes can prevent playback even when the call itself works.

## When something goes wrong

| Symptom | What to check |
| --- | --- |
| Bot online, no commands | Declared/approved capabilities, your role and the channel switch. Do not reinstall or delete keys to resolve pending approval |
| Manifest cannot be opened | Running bot process, correct URL, port and firewalls in both directions |
| Invalid token or different identity | The operator must check the registration and preserve the original identity; do not regenerate keys on every restart |
| Command asks for tools again | Check whether authorization was temporary or revoked and whether preparation completed |
| Preview works, but music does not | Check voice membership, tools, provider access and the private media transport |
| Bot stops after an update | Check protocol compatibility, process logs and newly requested capabilities |

Unlinking revokes that registration's access. Linking again requires a new
review. Updating a bot should not require deleting its identity or valid
registrations for other servers.

<LegacyBotLinks />
