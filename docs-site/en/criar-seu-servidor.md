# Create Your Server

Under **My Servers › Create Server**, fill in the host nickname, server name, local port, optional password, the starting text and voice channels and, if you want, a member limit.

Click **Create and Start Server**. The server starts on your machine, listens on every network interface on the chosen port, and opens for browsing. Joining a voice channel is a separate action.

Created servers are saved (up to 10). Later, use **Start**, **Stop** or **X** under *My Servers*.

Starting an offline server from Home or the server rail preserves the current
call, including camera, screen shares and mute. If this instance already hosts
another server, it will not replace it: stop that server explicitly when safe
before starting a different one.

## Invite friends

Inside the server, click the **server name** › **Invite Friends**. The app shows the name, public IP and port, and copies the invite.

| Situation | IP your friends should use |
|---|---|
| Same local network | Your local IP, or the app's automatic discovery |
| Different internet connection | Your public IP + forwarded router port |
| Without touching the router | VPN IP, such as Radmin VPN, Hamachi, ZeroTier or Tailscale |

## Voice & Media Modes (P2P Mesh vs SFU)

When creating or managing a server, you choose the media topology:
- **P2P Mesh (Default):** Audio and video travel directly between participants. The server only handles signaling, without consuming transcoding CPU or media bandwidth.
- **Centralized SFU (mediasoup):** Each broadcaster sends media tracks once to the server, which forwards them to viewers. Saves CPU and upstream bandwidth when sharing 1080p60 screens. The app and CLI include a built-in **Capacity Estimator** to plan host requirements.

## Open access over the internet

- **Primary TCP Port:** Allow port `3000` (or your chosen port) in your firewall and configure router port forwarding.
- **Ports for SFU (mediasoup):** If using SFU mode, also forward/allow the `40000-49151` range — on UDP and on TCP. On a VPS, see [Opening the SFU mode ports](/en/hospedar-em-vps#opening-the-sfu-mode-ports).
- **Without touching the router:** Use a virtual network/VPN such as Radmin VPN, Hamachi, ZeroTier, or Tailscale.

## Administer

Under **Server Settings** you can rename the server, change/remove the password, toggle voice mode (P2P / SFU), set or remove the member limit and allow or block the soundboard. Channel headers have **+** to create and a bin icon to delete.

Edits apply immediately, with text fields applying when editing finishes.
**Done** closes the window; there is no final save step. Dismissal stays
blocked while an operation awaits the server's acknowledgement. Failures
are shown and allow correction and retry.

The limit counts **registered members**, not who is online: a person takes the seat from their first join onwards, even while disconnected. To free the seat, kick the member. With the limit off, the server accepts as many people as want to join.

## Server Monitor

While the server is running on your machine, the app shows what is going on inside it. Open it from the **monitoring** icon next to the *Stop* button under *My Servers*, or from the **server name › Server Monitor** once you are connected.

The panel shows:

- **Live metrics**, refreshed every 3 seconds: uptime, people online, registered members (and the limit, when there is one), channels and messages.
- **Live logs**, with a level filter (`INFO`, `WARN`, `ERROR`), text search, auto-scroll, a button to copy what is visible and a button to clear.

The app keeps the most recent entries in memory — restarting the server starts the list over. For servers running on a VPS, use [`monky logs`](/en/hospedar-em-vps).
