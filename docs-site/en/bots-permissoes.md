# Capabilities and lifecycle

Read this before adding a feature to an existing bot. Declaring, approving
and using a capability are separate steps; reconnecting is not implicit
authorization.

**Reference:** [BotCapability](/en/bots-api-cliente#botcapability),
[BotPermissions](/en/bots-api-cliente#botpermissions) and
[events and cleanup](/en/bots-api#lifetimes-and-cleanup).

## Permissions and channels

In **Server Settings → Roles**, **Add and manage bots** (`MANAGE_BOTS`) controls linking, unlinking, and capability reviews; **Configure bot behavior** (`CONFIGURE_BOTS`) controls shared behavior settings only. Neither permission allows changing a bot's name or avatar. **Use bot commands** controls who can use commands and interactions, and is initially enabled for existing members and roles.

When creating or editing a text channel, the **Allow bot commands** switch starts enabled. Turning it off blocks commands and responses to forms and selectors in that channel, **including for administrators**. Typing `/` displays the reason. Permission changes also affect interactions that are already open; ordinary messages and reactions continue to follow their own permissions.

## Requested capabilities and consent

`BotOptions.requestedCapabilities` is required. Declare only categories the bot actually uses; the SDK publishes the same list in its manifest and `COMMAND_REGISTER`. A declaration is a request, never an authorization:

| Capability | Server-enforced access |
|------------|------------------------|
| `commands` | Explicit command inputs, autocomplete, previews, private replies, and forms |
| `read_messages` | Messages, history, and reactions in accessible channels; also required to quote another message |
| `send_messages` | Messages, replies, reactions, and public command results |
| `publish_voice` | Publishing audio in permitted rooms, without receiving participant media |
| `receive_voice` | Receiving human microphones in an authorized room, only after opting in on the voice connection |
| `local_execution` | Requesting tasks and tool preparation on the client; may receive media produced by an authorized task |
| `sound_download` | Requesting a Soundboard audio save on the caller's device, without general filesystem access |
| `selectors` | Persistent public choice controls and their responses; publication also requires `send_messages` |
| `miniapps` | Shared voice-room miniapps, including authorized participant actions |

Registering commands requires `commands`; commands with `downloadsSound` also declare `sound_download`, and those with `localCapabilities` declare `local_execution`. Public replies require `send_messages`; default private replies require only `commands`. Role, channel, and initiating-user permissions still apply.

**Reception is an independent authorization.** Declaring `receive_voice` does not grant access: the new capability starts switched off during review. Even after approval, the bot must join with `receiveAudio: true`. Without this opt-in, the connection still receives no voice. Reception, publication or both may be approved independently. The server limits reception to human microphones in the same room; it excludes other bots, cameras, screen sharing, Soundboard and private previews. Media from consented local tasks is a separate route.

While reception is active, the participant list shows **Listening to voices**. The block badge appears when the bot requested publication or reception but that permission was not granted; unrequested capabilities do not appear denied. Administrative mute/deafen also shows the block independently of granted permissions, without revoking them. Personal/administrative deafen stops reception and clears buffers; mute controls transmission. Muting a bot's playback only on your device does not revoke listening permission. The app and SDK respect source microphone mute; in SFU mode, the server also pauses these producers so a consumer cannot bypass the restriction.

The SDK does not record, transcribe or send audio to AI services. Bot operators must disclose their processing and retention and comply with applicable consent and privacy rules. Read [format, example and cleanup](/en/bots-voz#receive-microphones) before enabling the capability.

**Device consent is separate.** Granting `local_execution` or `sound_download` on the server neither installs tools nor authorizes a computer. The person still controls local requests and can deny or revoke them in local tool settings. Personal preferences, bot language, and file-name confirmation do not become administrator-controlled permissions.

In the tool request, **Always allow and prepare** remembers authorization for this bot and capability on this server. On reconnect, Monky checks tools in the background without reopening the request. **Allow until disconnect and prepare** remains available as a temporary choice; previous temporary grants are not automatically promoted. Tools are kept in Monky's local installation and reused by other servers, but each server/bot still needs its own consent.

**Editing and safe migration.** Bot settings use the same sidebar and section navigation as app/server settings. Under **Server permissions**, users with `MANAGE_BOTS` may review switches at any time. Saving invalidates the previous connection, ends voice, local tasks, source references, previews, interactions, and miniapps, and closes persistent selectors; the SDK may reconnect. Old asynchronous work cannot regain authority after a quick revoke/regrant.

Migration `026_bot_capability_consent.sql` preserves bots, tokens, identities, and settings, but **does not invent approval for existing bots**: they start with no grants and must declare capabilities with the updated SDK and undergo review. A changed declaration retains only previously granted capabilities that remain requested; new capabilities stay off. Optimistic revisions require reloading after concurrent edits.

**Online bot with no commands.** Being connected does not imply permission to execute commands. Typing `/` distinguishes disconnected bots, undeclared capabilities, pending review, and commands without authorization. People who manage bots also get **Configure** in the notice, opening that bot's settings; review **Server permissions** without reinstalling or granting access automatically. Installing tools on a computer does not replace this approval. If permissions are already correct, check the bot's version and command registration.

**Bots do not receive human roles.** Approved capabilities control their operations. For commands, replies, and private voice admission, the server validates the invoking person's access; approving `publish_voice` does not bypass that person's restrictions or authorize arbitrary private rooms. Removing the caller's access invalidates the voice grant. Outside an authorized context, bot visibility remains limited to public channels.

**Unlinking and installing again.** The server notifies the bot of revocation before closing its connection. The SDK removes only that registration, preserving its identity and other servers. If an old revoked registration is restored, an explicit authentication rejection also releases the link for reinstallation; network failures and protocol incompatibility do not erase registrations. A new installation still requires capability review, and an active link cannot be replaced by sending another token to the manifest service.

For URL installation, a preview lasts five minutes, belongs to the administrator's session/device, and can be consumed once. `BOT_INSTALL_PREVIEW { manifestUrl }` returns `{ previewId, expiresAt, manifest }`; `BOT_INSTALL { previewId, grantedCapabilities }` refetches the content. Changes to the manifest, a runtime declaration during registration, or the installer's authority cancel installation without leaving an approved account. Provisional registrations may publish identity and declarations, not perform actions.

The SDK exposes `bot.getPermissions(serverId)` and `permissionsChanged(permissions, { serverId })`, containing `requested`, `granted`, `revision`, `reviewRequired`, `reviewedBy`, and `reviewedAt`. These are informational per-server snapshots, not a way to grant permissions; the server remains authoritative.
