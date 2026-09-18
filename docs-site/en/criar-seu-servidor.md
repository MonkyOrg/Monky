# Create Your Server

Under **My Servers › Create Server**, fill in the host nickname, server name, local port, optional password, the starting text and voice channels and, if you want, a member limit.

<AppScreenshot src="/screenshots/criar-servidor-en.png" :width="1000" :height="1640" alt="Server creation form with name, port, initial channels, member limit and voice mode." caption="The app hosts on your computer. Internet availability also depends on networking and firewall rules." />

Click **Create and Start Server**. The server starts on your machine, listens on every network interface on the chosen port, and opens for browsing. Joining a voice channel is a separate action.

Created servers are saved (up to 10). Later, use **Start**, **Stop** or **X** under *My Servers*.

Starting an offline server from Home or the server rail preserves the current
call, including camera, screen shares and mute. If this instance already hosts
another server, it will not replace it: stop that server explicitly when safe
before starting a different one.

This does not change **returning Home through the house icon**: that action
asks to disconnect from servers and end the call. To start another saved
server without leaving the call, use its entry in the server rail.

## Invite friends

Inside the server, click the **server name** › **Invite Friends**. The app shows the name, public IP and port, and copies the invite.

| Situation | IP your friends should use |
|---|---|
| Same local network | Your local IP, or the app's automatic discovery |
| Different internet connection | Your public IP + forwarded router port |
| Without touching the router | VPN IP, such as Radmin VPN, Hamachi, ZeroTier or Tailscale |

## Voice & Media Modes (P2P Mesh vs SFU)

When creating or managing a server, you choose the media topology:
- **P2P Mesh (Default):** Audio and video try a direct path between participants. Without a relay, the server does not forward this media; when TURN is needed, the relay consumes bandwidth to carry it.
- **Centralized SFU (mediasoup):** Each broadcaster sends media tracks once to the server, which forwards them to viewers. Saves CPU and upstream bandwidth when sharing 1080p60 screens. The app and CLI include a built-in **Capacity Estimator** to plan host requirements.

## Open access over the internet

- **Primary TCP Port:** Allow port `3000` (or your chosen port) in your firewall and configure router port forwarding.
- **Ports for SFU (mediasoup):** If using SFU mode, also forward/allow the `40000-49151` range — on UDP and on TCP. On a VPS, see [Opening the SFU mode ports](/en/hospedar-em-vps#opening-the-sfu-mode-ports).
- **Without touching the router:** Use a virtual network/VPN such as Radmin VPN, Hamachi, ZeroTier, or Tailscale.

## Administer

In **Server Settings**, rename the server, change/remove its password, switch
P2P/SFU and adjust limits and Soundboard. Use **+** to create channels and
the channel's **More options** menu to edit or delete.
The [administration guide](/en/administrar-servidor) covers roles, private
channels and moderation.

Edits apply immediately, with text fields applying when editing finishes.
**Done** closes the window; there is no final save step. Dismissal stays
blocked while an operation awaits the server's acknowledgement. Failures
are shown and allow correction and retry.

The limit counts **registered members**, not who is online: a person takes the seat from their first join onwards, even while disconnected. To free the seat, kick the member. With the limit off, the server accepts as many people as want to join.

## Server Monitor

Open **server name › Server Monitor** to inspect the connected server, including
one running on a VPS. Administrators have access; other members need the
**View server monitor** permission in a role. **Manage server** alone does not
grant access. The server checks authorization for every request; the client
does not need to host a local server.

For a server hosted on this device, the **monitoring** icon next to *Stop*
under *My Servers* still opens the explicitly local monitor, separate from
the remote server in focus.

The panel shows:

- **Live metrics**, refreshed every 3 seconds: uptime, people online, registered members (and the limit, when there is one), channels and messages.
- **Recent logs**, with a level filter (`INFO`, `WARN`, `ERROR`), text search, auto-scroll and copying of visible entries. **Clear view** clears only this window, without deleting server history.

In-memory history is bounded. Remote logs show protected operational summaries
without credentials, private data or system details. Full details remain
available to the server host, including through
[`monky logs`](/en/hospedar-em-vps). Switching servers closes the remote monitor.
Disconnection or permission loss stops polling and removes retained data
from the window, without disconnecting you from Monky.
