# Media relay (TURN)

By default Monky's voice and video travel **straight between participants**
(P2P). The server only handles the introductions. That is a good thing: less
latency, and almost no bandwidth for whoever hosts.

The problem can show up when members sit behind **CGNAT** — common on mobile
networks and at many residential ISPs. Depending on the NAT and firewall,
the two sides may be unable to establish a direct route, even though each
of them connects fine with everyone else.

**TURN** offers an alternative path: the server **forwards that pair's media**.
WebRTC tries direct connectivity when possible; the relay must also be
reachable with the correct ports and credentials.

::: info This page applies to P2P Mesh mode
In [SFU mode](/en/criar-seu-servidor#voice-media-modes-p2p-mesh-vs-sfu) every
participant sends media to the server rather than directly to other people.
Monky's integrated TURN is offered only for P2P: the app and CLI reject enabling
it alongside SFU. This does not remove the need for a reachable server.
If SFU media does not flow, check the announced IP, process and
[SFU ports](/en/hospedar-em-vps#opening-the-sfu-mode-ports) instead of attempting
an unsupported combination.
:::

## Requirements

- A **Linux** host with a public IP (a typical VPS). Monky manages this relay's
  installation and execution only on Linux; it does not offer that control
  on Windows or macOS.
- **Open ports** in the firewall (see below).
- Bandwidth on the host: every relayed pair uses the server's upload **and**
  download.

## Required ports

| Port | Protocol | Purpose |
|---|---|---|
| `3478` | **TCP** | TURN listening port (signaling and allocate) |
| `3478` | **UDP** | TURN listening port (signaling and allocate) |
| `49152-65535` | **UDP** | Port range for media relay |

::: warning An online process does not prove the media path
Allow the configured transports above to support differently restricted
networks. Allocation and traffic are separate stages: port 3478 can respond
while the relay range remains blocked. Check media playback, not just whether
the process is running.
:::

## Opening ports on Linux

### 1. Provider firewall (web panel)

Most VPS providers (Oracle Cloud, AWS, Azure, GCP, Hetzner) have a firewall
**outside** the machine, at the network level. This firewall must be configured
**in the provider's web panel** — changing `iptables` alone is not enough.

#### Oracle Cloud (OCI)

1. Open the Oracle Cloud console
2. Go to **Networking → Virtual Cloud Networks**
3. Click on the **VCN** of your instance
4. In the side menu, click **Security** (or Subnets → your subnet → Security List)
5. Click on the associated **Security List**
6. Click **Add Ingress Rules** and add 3 rules:

| Source CIDR | IP Protocol | Destination Port Range |
|---|---|---|
| `0.0.0.0/0` | UDP | `3478` |
| `0.0.0.0/0` | TCP | `3478` |
| `0.0.0.0/0` | UDP | `49152-65535` |

7. Save

#### AWS (EC2)

1. Open the AWS console → **EC2 → Security Groups**
2. Select your instance's Security Group
3. Tab **Inbound rules → Edit inbound rules**
4. Add the same 3 rules (Custom UDP/TCP, source `0.0.0.0/0`)

#### Other providers

Look for "Security Groups", "Firewall Rules" or "Network ACL" in your
provider's panel. The logic is the same: open ports 3478 TCP/UDP and the range
49152-65535 UDP from any source.

### 2. Linux firewall (iptables)

Even with the provider firewall open, Linux may have its own rules. Run:

```bash
# Open the ports
sudo iptables -I INPUT -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 49152:65535 -j ACCEPT

# Persist (survives reboot)
sudo netfilter-persistent save
```

This command assumes `netfilter-persistent` is installed and configured.
On other distributions, use the local firewall's persistence mechanism.

::: tip If you use `ufw` instead of `iptables`
```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
```
:::

::: tip If you use `firewalld` (CentOS/RHEL)
```bash
sudo firewall-cmd --permanent --add-port=3478/tcp
sudo firewall-cmd --permanent --add-port=3478/udp
sudo firewall-cmd --permanent --add-port=49152-65535/udp
sudo firewall-cmd --reload
```
:::

## Enabling the relay

::: warning Do not reuse another service's coturn
Monky starts its own instance. Automatic installation and the repository
helper attempt to disable the distribution's coturn service to free port
3478. If another application relies on that service, plan a separate host
before continuing; do not stop a shared relay.
:::

```bash
monky config set turn true
monky restart
```

Monky attempts to install coturn through the distribution's package manager
when needed. This requires root or previously authorized non-interactive
`sudo`; the process does not open a password prompt. You can also enable it
under **Server Settings → Voice & Video** in the app.

### Manual coturn installation

Without those privileges, prepare the host first. On **Debian/Ubuntu with
systemd**, on a host dedicated to Monky's relay:

```bash
sudo apt-get update
sudo apt-get install -y coturn
sudo systemctl disable --now coturn
command -v turnserver
```

On other distributions, use their `coturn` package and service manager.
Then return to `monky config set turn true` and `monky restart` as **the same
user who manages the server**, without running all of Monky as root.

If you cloned the repository, there is also a helper. Run it from the root
of that checkout:

```bash
sudo bash scripts/install-turn.sh
```

This file **is not included in the global CLI installation**. That path
does not work from an arbitrary directory after `npm install -g`.

## Checking that it works

### Via CLI

```bash
monky status
```

In the **TURN Relay** section, you should see:

```
turn: yes
coturn: installed
port: 3478
status: ✔ accessible
```

If you see `⚠ port blocked`, review the firewalls above.

### Via network (from another machine)

```bash
# Check if the port is responding
nc -zv YOUR_IP 3478
```

This tests only the **TCP** connection. It does not confirm UDP transport,
the relay port range or a complete call between two networks.

### On the server itself

```bash
# Check if coturn is listening
sudo ss -tlnup | grep 3478
```

### In the app

A participant connected through the relay gets an amber `swap_horiz` icon next
to their name, both on the stage and in the voice channel list. If nobody shows
the icon, either everyone is connecting directly (the ideal case) or the relay
did not start — check with `monky logs`.

## Troubleshooting

| Symptom | Likely cause | Solution |
|---|---|---|
| `monky status` shows `⚠ port blocked` | Port 3478 closed in provider or Linux firewall | Follow the port opening steps above |
| coturn starts but nobody connects via relay | Missing `external-ip` in config (NAT-based VPS) | Update to v4.13.2+ — detection is automatic |
| `monky status` shows `coturn: unavailable` | coturn is not installed | Follow [manual installation](#manual-coturn-installation) |
| The TURN switch is greyed out in the app | Server is not Linux, or old version | Update the server; TURN only works on Linux |
| Call connects but with high latency | Normal for relay — media goes through the server | Consider a VPS closer to your members |

## Disabling it

```bash
monky config set turn false
monky restart
```

coturn stays installed but is not started. No extra ports need to remain open.

## How it works under the hood

Monky uses [coturn](https://github.com/coturn/coturn), the reference TURN
server. When the relay is enabled:

1. Monky generates a random **shared secret** and persists it in the database
2. On boot, it detects the VPS **public IP** (via ipify.org) and the **local
   IP** of the NIC
3. Generates `turnserver.conf` with the `external-ip=PUBLIC/PRIVATE` directive —
   without this, on NAT-based VPS (Oracle, AWS, etc.), coturn advertises the
   private IP and relay candidates become unreachable
4. Spawns coturn as a child process
5. Verifies port 3478 is listening and, if possible, externally accessible
6. At each client login, generates **ephemeral credentials** (TURN REST API)
   valid for 12 hours
7. The client's WebRTC tries the direct route and only uses the relay if needed
