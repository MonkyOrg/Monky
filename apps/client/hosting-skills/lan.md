---
name: monky-server-lan
description: Sets up a Monky voice and chat server that friends on the same Wi-Fi or wired network join through the host's local IP address. Use when the user wants to host Monky for people in the same house, office or LAN party.
---

# Monky server on the same local network (LAN)

Everyone is on the same Wi-Fi or wired network, so no VPN, router change or cloud server is needed. Your job: find the host computer's local IP, create the server in Monky, make sure the host's firewall lets friends in, and confirm a friend's computer reaches it.

<!-- include: shared/common.md -->

## Steps

### 1. Confirm everyone is on the same network

- Same router: same Wi-Fi name, or cables plugged into the same router. Wi-Fi and cable on one router count as the same network.
- **Guest Wi-Fi** and networks with **client/AP isolation** (common in hotels, dorms and some routers) stop devices from seeing each other. If friends are on one, they can't reach the host this way: suggest a VPN tutorial instead.

### 2. Find the host's local IP

- Windows (PowerShell): `Get-NetIPConfiguration | Where-Object IPv4DefaultGateway | Select-Object InterfaceAlias, IPv4Address`
- macOS: `ipconfig getifaddr en0` (Wi-Fi; try `en1` for cable)
- Linux: `ip -4 route get 1.1.1.1` (the address after `src`)

Use the adapter that has the internet connection. Ignore adapters named vEthernet, VMware, VirtualBox, WSL or any VPN. Local IPs usually look like `192.168.x.x`, `10.x.x.x` or `172.16-31.x.x`, and friends' computers share the first numbers (for example `192.168.0.x`).

If the IP changes after the router restarts, the user can reserve it in the router (look for "DHCP reservation" or "Address reservation"). This is optional.

### 3. Create the server in Monky

Follow "Hosting from the Monky app" above. P2P mode is a good fit for a local network. Then check `http://127.0.0.1:3000/health` on the host.

### 4. Let friends through the host's firewall

- **Windows**: when the server first starts, Windows may ask whether Monky can use the network: the user should allow **private networks**. Check the network profile with `Get-NetConnectionProfile`. If the home network shows `Public`, Windows blocks incoming connections. With the user's permission, either mark the trusted home network as private (admin PowerShell: `Set-NetConnectionProfile -InterfaceAlias "<alias>" -NetworkCategory Private`) or add a rule that only accepts the local network:

  ```powershell
  New-NetFirewallRule -DisplayName "Monky server (LAN)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet
  ```

  In SFU mode add a second rule with `-Protocol UDP -LocalPort 40000-49151`. Undo with `Remove-NetFirewallRule -DisplayName "Monky server (LAN)"`.
- **macOS**: if asked whether Monky may accept incoming connections, choose Allow. The setting lives in System Settings → Network → Firewall.
- **Linux with ufw**: `sudo ufw allow from 192.168.0.0/24 to any port 3000 proto tcp` (use the real local subnet).

### 5. Test from a friend's computer

On a friend's computer on the same network, open `http://<host-local-ip>:3000/health`. If it answers on the host but not on the friend's computer, go back to step 4 or check for guest/isolated Wi-Fi (step 1).

### 6. Friends join

Friends click **+** → `Join a server / Entrar em um servidor`. They can scan the local network from that screen, paste an invitation (choose the `Local network / Rede local` address in `Invite Friends / Convidar Amigos`), or type the host's local IP, the port and the password.

## Troubleshooting

- **Scan doesn't find the server** → typing the IP and port works the same; the scan can be blocked by firewalls.
- **Worked yesterday, not today** → the host's local IP changed. Send the new address or reserve the IP in the router.
- **Some friends are in another house** → the local network can't reach them. Use the VPN, port forwarding or VPS tutorial instead.
