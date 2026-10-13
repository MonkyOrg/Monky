---
name: monky-server-hamachi
description: Sets up a Monky voice and chat server that friends reach through a LogMeIn Hamachi network (25.x.x.x addresses), including the Windows firewall rule Hamachi networks usually need. Use when the user wants to host Monky over Hamachi.
---

# Monky server over Hamachi

LogMeIn Hamachi creates a virtual LAN between computers in different places (Windows and macOS). Host and friends join the same Hamachi network, and friends connect to the host's Hamachi IP (`25.x.x.x`). The server runs in Monky on the host's computer. Your job: set up the Hamachi network, create the server, open the host's firewall for the Hamachi range and confirm a friend reaches it.

<!-- include: shared/common.md -->

## Steps

### 1. Check that Hamachi fits

The free plan limits how many members a network can have (5 at the time of writing; check https://vpn.net for current limits). For bigger groups, suggest the Tailscale or ZeroTier tutorial.

### 2. Install Hamachi

Everyone downloads LogMeIn Hamachi from https://vpn.net and signs in with a free LogMeIn account (the user types their own credentials).

### 3. Create and join the network

- Host: in Hamachi, create a new network with a network ID and a password the user types themselves.
- The host sends the ID and password to friends privately.
- Friends choose to join an existing network and enter them.
- Everyone should appear online in the same network in the Hamachi window.

### 4. Find the host's Hamachi IP

It appears at the top of the Hamachi window and starts with `25.`. In PowerShell: `Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -like '25.*'`.

### 5. Create the server in Monky

Follow "Hosting from the Monky app" above. Check `http://127.0.0.1:3000/health` on the host.

### 6. Open the host's firewall for the Hamachi network

- **Windows** usually treats the Hamachi network as public, so it blocks incoming connections even when Monky was allowed on private networks. With the user's permission (admin PowerShell):

  ```powershell
  New-NetFirewallRule -DisplayName "Monky server (Hamachi)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress 25.0.0.0/8
  ```

  In SFU mode add a second rule with `-Protocol UDP -LocalPort 40000-49151`. Undo with `Remove-NetFirewallRule -DisplayName "Monky server (Hamachi)"`.
- **macOS**: allow Monky to accept incoming connections (System Settings → Network → Firewall).

### 7. Test from a friend's computer

The friend opens `http://<host-25.x-ip>:3000/health`. Ping is not a reliable test: Windows often blocks it.

### 8. Friends join

In `Invite Friends / Convidar Amigos`, choose the address labeled Hamachi and send the invitation. Or friends type the Hamachi IP, the port and the password in **+** → `Join a server / Entrar em um servidor`.

## Troubleshooting

- **`/health` times out** → check that both are online in the same Hamachi network, the firewall rule from step 6 exists, and the port matches the server. Never disable the firewall to test.
- **Hamachi marks a member as relayed or shows a warning** → the connection goes through Hamachi's relays or is failing; relayed works, with more latency.
