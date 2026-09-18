# Host on a VPS

To keep the server up 24/7, run the server alone on a Linux machine — no
graphical interface and no repository clone. Everything is done by the **Monky
CLI**, shipped ready to use in every release.

Use **Node.js 22 or 24**. SFU mode depends on the native mediasoup worker;
check the [CLI installation prerequisites](/en/cli#installation).

## Step by step

```bash
# 1. Install the CLI from the release
#    The ready-to-paste command, already on the latest version, is on the
#    download page: https://monkyorg.github.io/Monky/en/download
npm install -g --allow-scripts=mediasoup https://github.com/MonkyOrg/Monky/releases/download/vX.Y.Z/monky-cli-X.Y.Z.tgz

# 2. Create the server (interactive)
monky create

# 3. Check that it is up
monky status
```

`monky create` asks where to store the data, asks for the owner identity code
and offers to start the server at the end. On a VPS, prefer a path outside your
home directory, such as `/srv/monky`.

The server runs as a PM2-managed process. **Returning after a reboot requires
configuring the startup service**, not merely an `online` status:

```bash
pm2 save
pm2 startup
```

Run the privileged command printed by `pm2 startup` for the correct user.
If that user already has a startup service, inspect it instead of creating
another. `pm2 save` saves the managed process list, including that user's
other apps. Check the service, process and listening port after rebooting.
The full reference is in [Monky CLI](/en/cli).

## Ports used

| Port | Protocol | What for | Needs opening? |
|---|---|---|---|
| `3000` (or the chosen one) | TCP | Login, chat, channels and signalling | Yes, in the VPS firewall |
| `41234` | UDP | Local network discovery | No, on a VPS |
| High dynamic ports on participants | UDP | P2P voice, video and screen | These are client connections, not an extra range to open on a VPS without a relay |
| `40000-49151` | UDP and TCP | WebRTC media in SFU mode (mediasoup) | Only with SFU mode enabled |
| `3478` | TCP and UDP | TURN relay, if you enable it | Only with the relay on |
| `49152-65535` | UDP | Media forwarded by the relay | Only with the relay on |

When two members are behind CGNAT they may fail to connect directly. Monky ships
an **optional TURN relay** (off by default) that forwards that pair's media
through the server — see [Media relay (TURN)](/en/turn). Without
it, the way out for very restricted networks is still a VPN.

### Opening the SFU mode ports

In SFU mode media no longer goes straight between people: it comes into the
server through that range. Because it is UDP traffic arriving without anyone
having asked for it first, the `RELATED,ESTABLISHED` rule most distributions
ship **does not cover it** — the range has to be opened explicitly, and the same
goes for TCP, which is the way in for anyone on a network that blocks UDP.

```bash
# Open the SFU media range
sudo iptables -I INPUT -p udp --dport 40000:49151 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 40000:49151 -j ACCEPT

# Persist (survives a reboot)
sudo netfilter-persistent save
```

The persistence command assumes `netfilter-persistent` is installed and
configured, commonly on Debian/Ubuntu. On other distributions, use the
existing firewall's mechanism. Do not mix firewall managers without reviewing
their rules.

::: tip If you use `ufw` instead of `iptables`
```bash
sudo ufw allow 40000:49151/udp
sudo ufw allow 40000:49151/tcp
```
:::

::: warning The provider's firewall is a separate one
Oracle Cloud, AWS, Azure, GCP and Hetzner have a firewall outside the machine
that `iptables` cannot reach. The range has to be allowed in the web panel too,
the same way described in
[Media relay (TURN)](/en/turn#opening-ports-on-linux) — the examples there are
for the relay ports, but the path through the panel is the same.
:::

To check it is in effect, join a voice channel and watch the media arrive:

```bash
sudo tcpdump -n -i any udp portrange 40000-49151 -c 20
```

Test with participants on different networks and confirm playback in both
directions. Captured packets prove arrival at the interface, not acceptance
by the firewall or service. Missing UDP can also mean an incorrect announced
IP, no transmission or use of TCP; do not diagnose from this capture alone.

Check rule order with `sudo iptables -L INPUT -n -v --line-numbers` and the
addresses/ports advertised in the server logs.

## Maintenance

```bash
monky logs --level WARN           # what needs attention
monky config set port 3010        # changes the port and offers to restart
monky update --check              # is there a new version?
monky config set autoUpdate true  # configures the automatic update schedule
```

### Upgrading the Node version

PM2 is a long-lived daemon and keeps using the Node it was started with.
Changing the Node version — especially moving from apt to `nvm` — can leave the
server in a state where `pm2 status` says `online` but nothing listens on the
port.

After touching Node, always run:

```bash
monky update     # rebuilds native modules for the new ABI
monky restart    # re-pins the interpreter PM2 uses
pm2 save         # writes the good state to the PM2 dump
```

If the server still does not come back, `monky restart --fresh` recreates the
PM2 process registration. Details and diagnostics are in
[Changing the Node version](/en/cli#changing-the-node-version).

::: tip More than one server on the same VPS
Just run `monky create` again with another folder and another port. The CLI
starts asking which server each command refers to — or you point at it directly
with `--data`. See [Multiple servers](/en/cli#multiple-servers).
:::
