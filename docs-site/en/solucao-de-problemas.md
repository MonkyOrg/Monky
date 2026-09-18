# Troubleshooting

First identify the failing stage: **server connection**, **call media** or
**a bot action**. An accessible chat port does not prove that voice and video
are passing; TURN does not fix the login address.

| Symptom | What usually fixes it |
|---|---|
| macOS says the app "is damaged and can't be opened" | Check the source and checksum before changing quarantine. See [Download](/en/download#macos-the-application-is-damaged-and-can-t-be-opened) |
| I can't connect to my friend's server | Check the process, address, TCP port and firewall. Behind CGNAT, use a VPN reachable by participants or publicly reachable hosting. TURN only helps media after connecting |
| Nickname already in use | Nicknames are unique per server — pick another |
| I joined, but nobody hears me | Check Settings › Voice and Video, the meter, detection threshold, PTT, personal mute and any administrative restriction |
| I hear someone, but their avatar does not indicate speech | Update the client. The indicator follows each microphone's decoded audio in P2P and SFU, even when RTP statistics report zero audio level. It is hidden while you are deafened; screen audio must not trigger it |
| Everyone sounds choppy | Use the Economy profile, ask broadcasters to do the same and prefer cable over Wi-Fi |
| Shared screen has no sound | Check whether the source/platform supports screen audio, the selected option and sender/receiver volumes |
| Nothing under Servers on the Network | Discovery only works on the same LAN; click Scan again and check UDP `41234` in the firewall |
| One participant is silent only for me | Right-click them and set individual volume back to 100% |
| I can only fail to talk to **one** specific person (everyone else works) | A red `link_off` icon shows next to them. You are both likely behind CGNAT with no direct route. The host can enable the [TURN relay](/en/turn); otherwise both of you need a VPN. This only happens in P2P Mesh mode |
| In **SFU mode**, nobody hears anybody and the call never connects | The `40000-49151` range must be open in **both UDP and TCP** on the firewall and the router. Signalling uses a different port, so the server looks fine while no media gets through. See [Opening the SFU mode ports](/en/hospedar-em-vps#opening-the-sfu-mode-ports) |
| In **SFU mode**, the call drops and the app keeps saying it is reconnecting | Either the process or the media path may have failed. Creating transports and producers through signaling does not prove ICE/DTLS connectivity. Check the advertised addresses and ports in the logs, the VM firewall and the provider's rules; successfully binding a local port does not prove external reachability |
| Avast (or another antivirus) flags the installer/updater | Check the detection, source and integrity; do not assume a false positive. See [Antivirus: Avast and similar](#antivirus-avast-and-similar) |
| The **TURN relay** switch is greyed out and will not budge | Read the displayed reason: unsupported platform, SFU mode, an old version or missing privileges to install coturn. For the last case, follow [manual installation](/en/turn#manual-coturn-installation) without disrupting other services on the host |
| TURN is enabled but nobody connects via relay | Ports may be closed. See the [full port guide](/en/turn#required-ports). Run `monky status` — it should show `✔ accessible` |
| On macOS, screen sharing keeps asking for permission even though it is already allowed | The permission is stuck on the previous version — see [macOS: screen permission stops working after an update](#macos-screen-permission-stops-working-after-an-update) |
| Bot online, but no commands | Check approved capabilities, your role and the channel switch. See [Bot troubleshooting](/en/bots#when-something-goes-wrong) |

## Antivirus: Avast and similar

Without a recognized distribution signature, reputation-based antivirus tools
can flag the app or updater. This can be a false positive, but open source
and automated builds do not prove that any file on your computer is safe.
[Verify the release](/en/verificar-releases) and inspect the detection's exact
name and path.

### Monky folders to allow

Do not preemptively exclude entire folders. In the antivirus history, identify
the blocked file, compare it with the official artifact and consult the
vendor's guidance. If you confirm a false positive, prefer the narrowest
exception for that detection. Do not disable real-time protection or exclude
your personal data directory.

### The "Old uninstaller" warning during updates

The NSIS installer can run a temporary copy of the previous uninstaller
under `%LOCALAPPDATA%\Temp\...`. That explains a name such as
`old-uninstaller.exe`, but its name alone does not prove legitimacy. Verify
the update's origin and the detection before allowing any file; do not
exclude the whole folder.

::: danger Warning
`%LOCALAPPDATA%\Temp` is **not a Monky folder**. It is the temporary folder
shared by all of Windows and every program on the machine. Excluding it entirely
weakens your antivirus protection against any other software, not just Monky.

We do not recommend that exclusion and it is **not the project's
responsibility**: if you choose to do it, you do so **at your own risk**.
:::

## macOS: screen permission stops working after an update

You already allowed Monky under **System Settings › Privacy & Security › Screen
Recording**, the toggle is still on, yet the app insists the permission is
missing when you try to share your screen. Turning the toggle off and on again
does not help.

The reason: macOS **does not store that permission by app name**, it stores it
against the binary's **code signature**. Since Monky is not signed with an Apple
Developer ID certificate yet, the system ends up identifying the app by the
contents of the binary itself — which change with every version. After an update
macOS sees an app with a new identity, and the permission granted to the
previous version no longer applies to it. Because the name and the path stay
identical, the old entry remains listed and checked — hence the impression that
everything is already allowed.

### How to share your screen again

Since version `3.0.0-beta007` Monky detects this state on its own. When you click
**Share Screen**, if macOS is denying the capture you get a warning with a
**Re-request permission** button: it clears the stale authorization and restarts
the app, and macOS asks again on the next attempt. Just grant it.

If you prefer doing it by hand (or you are on an older version):

1. Quit Monky completely (including the menu bar icon).
2. In **Terminal**, run:

   ```bash
   tccutil reset ScreenCapture com.monky.app
   ```

3. Open Monky and try sharing your screen.
4. When macOS asks for the permission, grant it again.

If the command does not help, remove the entry by hand: **System Settings ›
Privacy & Security › Screen Recording**, select Monky, click **−** to remove it,
then repeat step 3 so it gets added again.

::: tip Definitive fix
The real solution is signing the app with an **Apple Developer ID** certificate,
which keeps the same identity across versions and makes the permission survive
updates. That depends on a paid Apple Developer Program account; the project is
already wired to use one as soon as it is available.
:::

## I can't connect with a specific person (CGNAT)

If you can talk to most people but **one specific person** can't connect (you
see a red `link_off` icon), **CGNAT/restrictive NAT** is one possible cause.
Blocked UDP, a firewall, VPN or an invalid ICE route can also prevent the
connection. The icon identifies the failing pair, not the network type.

### Option 1: TURN relay (recommended if the server is Linux)

The server admin can enable the TURN relay, which makes the server forward media
between the two of you. It's transparent: the app uses it automatically when
needed.

See the [full TURN guide](/en/turn) — includes how to open ports, verify and
troubleshoot.

### Option 2: VPN

If the server is not Linux (TURN unavailable) or the admin can't open the
ports, both members can join a **VPN** (such as Tailscale, ZeroTier or
WireGuard). The VPN creates a virtual network that bypasses CGNAT.

### Option 3: SFU mode (if the host is willing to carry the media)

In [SFU mode](/en/criar-seu-servidor#voice-media-modes-p2p-mesh-vs-sfu) nobody
connects directly to the other participants: each person talks to the server.
This removes dependence on that direct peer-to-peer path, but still requires
a reachable host, correct announced IP and open `40000-49151` ports.
Media flows through the host, which needs the corresponding bandwidth.

### How to know if you're behind CGNAT?

- Compare the public IP from [ifconfig.me](https://ifconfig.me) with the
  router's **WAN** address, not its local administration-page address.
  A difference suggests additional NAT, which may be CGNAT or another
  router; confirm with the ISP. VPNs and proxies can also affect the comparison.
- Mobile data (4G/5G) is almost always CGNAT.
- Many residential ISPs use CGNAT.
