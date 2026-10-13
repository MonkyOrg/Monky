---
name: monky-server-tailscale
description: Sets up a Monky voice and chat server that friends reach through Tailscale (100.x.y.z addresses), including sharing the host machine with friends and checking the connection. Use when the user wants to host Monky over Tailscale for friends in other places.
---

# Monky server over Tailscale

Tailscale builds a private network between computers anywhere, without opening router ports, and works on Windows, macOS and Linux. The server runs in Monky on the user's computer; friends reach it through its Tailscale IP (`100.x.y.z`). Your job: install Tailscale, give friends access to the host machine, create the server and confirm a friend reaches it.

<!-- include: shared/common.md -->

## Steps

### 1. Install Tailscale on the host

- The user creates a free account at https://tailscale.com (Google, Microsoft or GitHub sign-in works) and signs in to the app.
- Download from https://tailscale.com/download. With a terminal: on Windows `winget search Tailscale` (install only the package published by Tailscale Inc.); on Linux `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.
- Confirm: `tailscale status` lists the computer, and `tailscale ip -4` prints its address (`100.x.y.z`).

### 2. Give friends access

Each friend installs Tailscale and signs in. Then pick one way:

- **Share only the host machine (recommended)**: in the admin console (https://login.tailscale.com), on the Machines page, open the host's menu and choose Share. Friends accept the link with their own Tailscale account and can reach only this computer.
- **Invite them to the tailnet**: they can reach every device in it unless access rules say otherwise.
- **Auth key** (the path in Monky's tutorial): Settings → Keys → Generate auth key. Treat it like a password: send it privately, prefer single-use keys, and revoke it when everyone joined.

Ask the user what they see in the console and adapt: Tailscale's pages change.

### 3. Create the server in Monky

Follow "Hosting from the Monky app" above. P2P mode works well for small groups. Check `http://127.0.0.1:3000/health` on the host.

### 4. Test from a friend's computer

On the friend's computer: `tailscale ping <host-100.x-ip>`, then open `http://<host-100.x-ip>:3000/health`.

If the ping works but `/health` doesn't, the host's firewall blocks the port. On Windows, with the user's permission (admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Monky server (Tailscale)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress 100.64.0.0/10
```

In SFU mode add a second rule with `-Protocol UDP -LocalPort 40000-49151`. Undo with `Remove-NetFirewallRule -DisplayName "Monky server (Tailscale)"`.

### 5. Friends join

In `Invite Friends / Convidar Amigos`, choose the VPN address that starts with `100.` and send the invitation. Or friends type the Tailscale IP, the port and the password in **+** → `Join a server / Entrar em um servidor`.

## Troubleshooting

- **`tailscale status` shows "relay"** for a friend → traffic goes through Tailscale's relays: it works, with a bit more latency.
- **The host drops off weeks later** → its Tailscale key expired. In the admin console, disable key expiry for the host machine.
- **Friend sees "no route" or can't ping** → they aren't signed in, didn't accept the share, or the share was for a different machine.
