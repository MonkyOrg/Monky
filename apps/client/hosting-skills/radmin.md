---
name: monky-server-radmin
description: Sets up a Monky voice and chat server that friends reach through a Radmin VPN network (26.x.x.x addresses) on Windows, including the Windows firewall rule Radmin networks usually need. Use when the user wants to host Monky over Radmin VPN.
---

# Monky server over Radmin VPN

Radmin VPN is a free virtual LAN for **Windows only**. Host and friends join the same Radmin network, and friends connect to the host's Radmin IP (`26.x.x.x`). The server runs in Monky on the host's computer. Your job: set up the Radmin network, create the server, open the Windows firewall for the Radmin range and confirm a friend reaches it.

<!-- include: shared/common.md -->

## Steps

### 1. Check that Radmin fits

Everyone must use Windows. If anyone is on macOS or Linux, suggest the Tailscale or ZeroTier tutorial instead.

### 2. Install Radmin VPN

Everyone installs it from the official site, https://www.radmin-vpn.com. With a terminal you can try `winget search "Radmin VPN"` and install only a package published by Famatech; otherwise the user downloads it from the site. Never use third-party download mirrors.

### 3. Create and join the network

- Host: in Radmin VPN, `Network → Create Network / Rede → Criar rede`, with a network name and a password the user types themselves.
- The host sends the name and password to friends privately.
- Friends: `Network → Join Network / Rede → Conectar à rede`.
- Everyone should appear online in the same network in the Radmin window.

### 4. Find the host's Radmin IP

It appears under the computer name in Radmin VPN and starts with `26.`. In PowerShell: `Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -like '26.*'`.

### 5. Create the server in Monky

Follow "Hosting from the Monky app" above. Check `http://127.0.0.1:3000/health` on the host.

### 6. Open the Windows firewall for the Radmin network

Windows usually treats the Radmin network as public or unidentified, so it blocks incoming connections even when Monky was allowed on private networks. With the user's permission (admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Monky server (Radmin VPN)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress 26.0.0.0/8
```

In SFU mode add a second rule with `-Protocol UDP -LocalPort 40000-49151`. Undo with `Remove-NetFirewallRule -DisplayName "Monky server (Radmin VPN)"`.

### 7. Test from a friend's computer

The friend opens `http://<host-26.x-ip>:3000/health`. Ping is not a reliable test: Windows often blocks it.

### 8. Friends join

In `Invite Friends / Convidar Amigos`, choose the address labeled Radmin VPN and send the invitation. Or friends type the Radmin IP, the port and the password in **+** → `Join a server / Entrar em um servidor`.

## Troubleshooting

- **`/health` times out** → check that both are online in the same Radmin network, the firewall rule from step 6 exists, and the port matches the server.
- **Radmin shows the connection as relayed** → it works, with more latency.
- **The host's 26.x address changed** → send a new invitation.
