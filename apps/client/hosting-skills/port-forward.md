---
name: monky-server-port-forward
description: Makes a Monky voice and chat server hosted on a home computer reachable from the internet by forwarding its port on the router, after checking that the connection is not behind CGNAT. Use when the user wants friends on other networks to join by public IP, without a VPN or a VPS.
---

# Monky server through router port forwarding

The server runs in Monky on the user's home computer. The router forwards Monky's port from the internet to that computer, and friends connect to the home's public IP. Your job: check this is possible (no CGNAT), give the computer a stable local IP, create the forwarding rule and the firewall rule, and test from outside the house.

<!-- include: shared/common.md -->

## Steps

### 1. Check for CGNAT first

Port forwarding only works when the router itself has the public IP.

1. Public IP: `curl -4 https://ifconfig.me` (or search "what is my IP" in a browser).
2. Router's internet (WAN) IP: the user reads it on the router's status page (look for Status, Internet or WAN).
3. Compare:
   - **Same address** → good, continue.
   - **Different**, or the WAN IP starts with `100.64`-`100.127`, `10.`, `172.16`-`172.31` or `192.168.` → the ISP uses **CGNAT**, or there are two routers in a row (double NAT). CGNAT is common on mobile/5G home internet and many ISPs. Forwarding at home won't work. Options: ask the ISP for a public IPv4 address, put the ISP modem in bridge mode when the user has their own router behind it, or use the Tailscale or VPS tutorial instead. Stop here until one of these is chosen.

### 2. Find the host's local IP and the router address

- Windows (PowerShell): `Get-NetIPConfiguration | Where-Object IPv4DefaultGateway | Select-Object InterfaceAlias, IPv4Address, IPv4DefaultGateway`
- macOS: `ipconfig getifaddr en0` and `route -n get default`
- Linux: `ip -4 route get 1.1.1.1` (local IP after `src`) and `ip -4 route show default` (router after `via`)

Ignore virtual and VPN adapters.

### 3. Give the host a stable local IP

The forwarding rule points at one local IP, so it breaks if the router hands the computer a new one. In the router, reserve the current IP for this computer (look for "DHCP reservation", "Address reservation" or "Static lease").

### 4. Create the server in Monky

Follow "Hosting from the Monky app" above. The server will be reachable from the internet, so **strongly recommend an `Access password / Senha de Acesso`**. Note the port and the voice mode. Check `http://127.0.0.1:3000/health` on the host.

### 5. Create the forwarding rule on the router

The user opens `http://<router-address>` in a browser and signs in (they type the password). The option is usually called Port Forwarding, Virtual Server, NAT, "Redirecionamento de portas" or "Servidor virtual". Create:

| Protocol | External port | Internal IP | Internal port | When |
|---|---|---|---|---|
| TCP | 3000 | host's local IP | 3000 | always |
| UDP | 40000-49151 | host's local IP | 40000-49151 | only in SFU mode |

Use the real port if it isn't 3000. Don't use DMZ instead of a rule.

### 6. Allow the port in the host's firewall

- **Windows** (admin PowerShell):

  ```powershell
  New-NetFirewallRule -DisplayName "Monky server (internet)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000
  ```

  In SFU mode add `-Protocol UDP -LocalPort 40000-49151` in a second rule. Undo with `Remove-NetFirewallRule -DisplayName "Monky server (internet)"`.
- **macOS**: allow Monky to accept incoming connections (System Settings → Network → Firewall).
- **Linux with ufw**: `sudo ufw allow 3000/tcp` (and `sudo ufw allow 40000:49151/udp` in SFU mode).

### 7. Test from outside the house

Many routers can't loop back to their own public IP, so a test from inside the house can fail even when everything is right. Test from a phone **with Wi-Fi turned off** (mobile data): open `http://<public-ip>:3000/health`. Or ask a friend to open it.

### 8. Share the address

Friends use the **public IP** and the port. In `Invite Friends / Convidar Amigos` choose `Public IP (over the internet) / IP público (pela internet)`. Home public IPs usually change from time to time: for a stable address, set up dynamic DNS (many routers have a DDNS option; DuckDNS and No-IP are free) and share that name instead.

## Troubleshooting

- **Works on the host, times out from mobile data** → check, in order: CGNAT (step 1), the forwarding rule's internal IP matches the host now (step 3), the host firewall (step 6), Monky is open and the server is running.
- **Joins, but voice fails in SFU mode** → the UDP range is missing in the router or the firewall.
- **Stopped working days later** → the public IP or the host's local IP changed (steps 3 and 8).
- **Undo** → delete the router rule and the firewall rule(s) created above.
