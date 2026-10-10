---
name: monky-server-zerotier
description: Sets up a Monky voice and chat server that friends reach through a ZeroTier network, including authorizing members and opening the host firewall for the network's address range. Use when the user wants to host Monky over ZeroTier.
---

# Monky server over ZeroTier

ZeroTier creates a private virtual network between computers anywhere (Windows, macOS and Linux). Everyone joins the same network, the host authorizes each member, and friends connect to the host's ZeroTier IP. The server runs in Monky on the host's computer. Your job: set up the network, authorize the right members, create the server, open the host's firewall for the network range and confirm a friend reaches it.

<!-- include: shared/common.md -->

## Steps

### 1. Create the network

The user creates a free account at https://www.zerotier.com and, in the ZeroTier web dashboard, creates a network. Note the **Network ID** (16 characters) and the network's **IPv4 range** (shown in the network settings, for example `10.147.17.0/24`). Keep the network **private**, so every member must be authorized. Free plan limits change: check zerotier.com if the group is large.

### 2. Install ZeroTier and join

Everyone installs ZeroTier One from https://www.zerotier.com/download/ and joins the Network ID: from the tray icon ("Join New Network…"), or on Linux/macOS with `sudo zerotier-cli join <network-id>`.

### 3. Authorize the members

In the dashboard's member list, the host authorizes each device. Only authorize devices the user recognizes: each one shows a node ID, which a friend can read in their tray menu or with `zerotier-cli info`.

### 4. Find the host's ZeroTier IP

The dashboard's member list shows each device's managed IP. On the host: `zerotier-cli listnetworks` (Linux/macOS), or in PowerShell `Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "ZeroTier*"`.

### 5. Create the server in Monky

Follow "Hosting from the Monky app" above. Check `http://127.0.0.1:3000/health` on the host.

### 6. Open the host's firewall for the ZeroTier network

- **Windows** usually treats the ZeroTier network as public, so it blocks incoming connections. With the user's permission (admin PowerShell), using the network's real range:

  ```powershell
  New-NetFirewallRule -DisplayName "Monky server (ZeroTier)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress 10.147.17.0/24
  ```

  In SFU mode add a second rule with `-Protocol UDP -LocalPort 40000-49151`. Undo with `Remove-NetFirewallRule -DisplayName "Monky server (ZeroTier)"`.
- **macOS**: allow Monky to accept incoming connections (System Settings → Network → Firewall).
- **Linux with ufw**: `sudo ufw allow from <network-range> to any port 3000 proto tcp`.

### 7. Test from a friend's computer

The friend opens `http://<host-zerotier-ip>:3000/health`.

### 8. Friends join

In `Invite Friends / Convidar Amigos`, choose the VPN address in the ZeroTier range and send the invitation. Or friends type the ZeroTier IP, the port and the password in **+** → `Join a server / Entrar em um servidor`.

## Troubleshooting

- **A friend has no ZeroTier IP** → they weren't authorized yet (step 3), or joined a different Network ID.
- **`/health` times out** → check the firewall rule from step 6 uses the network's real range and port.
- **`zerotier-cli` not found on Windows** → use the tray menu and the dashboard instead.
