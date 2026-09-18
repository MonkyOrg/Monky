# Manage a server

This guide covers what is **shared by a server**: channels, roles,
moderation, bots and limits. Microphone, camera, language and personal
preferences belong in [App settings](/en/configuracoes).

## Open server settings

Click **server name → Server Settings**. You must be the owner, an
administrator or have the corresponding permissions. Available controls
depend on your access.

<AppScreenshot src="/screenshots/administrar-servidor-en.png" alt="The General server settings tab, showing the name, member limit and P2P/SFU voice-mode cards." caption="These choices affect the server, not just the computer that opened the window." />

| Tab | Purpose |
| --- | --- |
| General | Name and image, member limit, voice mode and server process information |
| Security | Entry password |
| Voice & Video | Soundboard access and the integrated TURN relay |
| Storage | Attachment limits and usage |
| Notifications | Mentions, message editing and notices published in chat |
| Members | Inspect members and manage access according to your permissions |
| Roles | Organize permissions, hierarchy and membership |
| Bots | Link bots, review capabilities and unlink registrations |

### Immediate application

Switches and selections apply immediately. Names, passwords and limits
apply when you finish editing, leave the field or press `Enter`. **Done**
only closes the window; it does not undo confirmed changes.

Closing is blocked while an operation is pending. A TURN download at 100%
still needs startup confirmation. Errors identify what was not applied
and let you correct it and try again.

Creating, installing, deleting and revoking still require explicit actions.
If the connection or session changes, reopen the window to check current state.

### Version and information

Under **General → Server Information**, the version belongs to the hosting
server process, not the client you are using. Click to copy it. If unavailable,
do not assume that it matches your app.

When a server restarts for an update, clients receive a specific notice,
including when viewing another server. Wait, then reconnect. An update
notice does not mean the new version has already finished starting.

## Channels

Use the **+** beside **Text Channels** or **Voice Channels**. Choose a type,
enter a name and review the switches before creating it.

To edit or delete, open the channel's **More options** menu. Deletion is
destructive: check the name and its effect on history before confirming.

### Private channel

A private channel is visible only to the selected roles and people with
applicable management access. It is not a separate server password.
Review roles before sharing sensitive content.

### Bot commands in a channel

**Allow bot commands** controls commands, forms and buttons in that channel.
When off, it also blocks administrators. This does not replace
[each bot's capability approval](/en/bots#preferences-and-permissions).

## Roles and permissions

Open **Roles → Create role**, enter a name and choose a color. Use the
editor's **Permissions** and **Members** tabs to review access. A role can
be automatically assigned to new members when that option is enabled.

<AppScreenshot src="/screenshots/cargos-en.png" alt="A demo server's role list, showing the default roles and a facilitators role." caption="Separate ordinary use from administration. Avoid granting Administrator when a specific permission is enough." />

Drag to reorder roles. Hierarchy limits who may manage roles and members;
do not treat a color or visual position as proof of permission. A member
can have more than one role.

Bot-related permissions are separate:

- **Use bot commands**: allows commands and interactions.
- **Add and manage bots**: allows management of registrations and capabilities.
- **Configure bot behavior**: allows shared behavior changes.

Human member permissions are not assigned to bots as roles. Use their
dedicated capability review instead.

## Voice moderation

A member's right-click menu shows actions you are allowed to perform.
Kicking from voice or moving to another channel requires an active voice
connection. Restricting microphone/audio can also be done outside a call,
with the corresponding permission.

An **administrative restriction** applies to that identity on the server,
including its other devices. Reconnecting, changing channels or restarting
does not remove it: an administrator must lift the restriction.

Personal mute and administrative restrictions are different. The former
does not override the latter. Red restriction icons indicate administrative
blocks; a person may still keep their own microphone muted after being
unblocked.

## Choose P2P or SFU

| Mode | Media path | Main consideration |
| --- | --- | --- |
| P2P | Each participant sends directly to others, or through TURN when needed | Participants' upload bandwidth and connectivity between networks |
| SFU | Participants publish to the server, which forwards to viewers | Server CPU, bandwidth, announced IP and media ports |

Choose under **General → Voice and Video Mode**. Changing mode during a
call reconfigures media; notify participants and check network conditions
beforehand.

TURN relays P2P connections that cannot establish a direct path.
SFU centralizes call forwarding. Neither replaces opening the server's
connection port or makes a computer behind CGNAT publicly reachable
without a suitable network route.

See [TURN](/en/turn) and [VPS hosting](/en/hospedar-em-vps) for ports, limits
and preparation. The capacity estimator is guidance, not a performance
guarantee for every network or machine.

## Operation and continuity

- Keep clients, servers and bots on compatible protocol versions.
- Preserve the database and bot identities; do not delete registrations
  as your first troubleshooting step.
- Check backups before migrations, deletions and hosting changes.
- When hosting through the app, closing/stopping that process affects all
  participants. For continuous operation, see the [CLI](/en/cli) and
  [VPS guide](/en/hospedar-em-vps).

To manage a bot's access and understand why it can be online without commands,
continue with [Use bots](/en/bots).
