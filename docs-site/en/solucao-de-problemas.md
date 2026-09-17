# Troubleshooting

| Symptom | What usually fixes it |
|---|---|
| macOS says the app "is damaged and can't be opened" | It's the Gatekeeper quarantine (app not notarized yet). Run in Terminal: `xattr -dr com.apple.quarantine /Applications/Monky.app`. See [Download](/en/download#macos-the-application-is-damaged-and-can-t-be-opened) |
| I can't connect to my friend's server | Double-check IP and port; ask them to confirm the server is started; check firewall and port forwarding; on CGNAT, use a VPN or [TURN](/en/turn) |
| Nickname already in use | Nicknames are unique per server — pick another |
| I joined, but nobody hears me | Check microphone under Settings › Devices, watch the VAD meter, lower sensitivity and confirm the mic is not muted |
| I hear someone, but their avatar does not indicate speech | Update the client. The indicator follows each microphone's decoded audio in P2P and SFU, even when RTP statistics report zero audio level. It is hidden while you are deafened; screen audio must not trigger it |
| Everyone sounds choppy | Use the Economy profile, ask broadcasters to do the same and prefer cable over Wi-Fi |
| Shared screen has no sound | Share a whole screen and check the source app volume |
| Nothing under Servers on the Network | Discovery only works on the same LAN; click Scan again and check UDP `41234` in the firewall |
| One participant is silent only for me | Right-click them and set individual volume back to 100% |
| I can only fail to talk to **one** specific person (everyone else works) | A red `link_off` icon shows next to them. You are both likely behind CGNAT with no direct route. The host can enable the [TURN relay](/en/turn); otherwise both of you need a VPN. This only happens in P2P Mesh mode |
| In **SFU mode**, nobody hears anybody and the call never connects | The `40000-49151` range must be open in **both UDP and TCP** on the firewall and the router. Signalling uses a different port, so the server looks fine while no media gets through. See [Opening the SFU mode ports](/en/hospedar-em-vps#opening-the-sfu-mode-ports) |
| In **SFU mode**, the call drops and the app keeps saying it is reconnecting | Either the process or the media path may have failed. Creating transports and producers through signaling does not prove ICE/DTLS connectivity. Check the advertised addresses and ports in the logs, the VM firewall and the provider's rules; successfully binding a local port does not prove external reachability |
| Avast (or another antivirus) flags the installer/updater | False positive — see [Antivirus: Avast and similar](#antivirus-avast-and-similar) |
| The **TURN relay** switch is greyed out and will not budge | The host cannot run the relay. The notice under the switch says why: the server is not on Linux, the server predates the feature (update the server), or the server lacks the privileges to install coturn (run `sudo bash scripts/install-turn.sh` once) |
| TURN is enabled but nobody connects via relay | Ports may be closed. See the [full port guide](/en/turn#required-ports). Run `monky status` — it should show `✔ accessible` |
| On macOS, screen sharing keeps asking for permission even though it is already allowed | The permission is stuck on the previous version — see [macOS: screen permission stops working after an update](#macos-screen-permission-stops-working-after-an-update) |

## Antivirus: Avast and similar

Monky is **not code-signed yet**. Without that signature, reputation-based
antivirus products — Avast in particular — flag the installer, the app and the
updater as suspicious. It is a **false positive**: the code is open source and
releases are built automatically by GitHub Actions straight from this
repository.

### Monky folders to allow

Add these three folders to your antivirus exclusions:

| Folder | What it holds |
|---|---|
| `%LOCALAPPDATA%\Programs\Monky` | The installed application |
| `%LOCALAPPDATA%\@monkyclient-updater` | Update download cache |
| `%APPDATA%\@monky` | Your local data (identity, preferences) |

In Avast: **Menu › Settings › General › Exceptions › Add exception**.

::: tip
Paste the path with the variables (`%LOCALAPPDATA%`) straight into the field —
Windows expands them for you. `%APPDATA%` maps to `AppData\Roaming`.
:::

### The "Old uninstaller" warning during updates

While updating, Avast may flag a file named `old-uninstaller.exe` under
`%LOCALAPPDATA%\Temp\...`. This is expected: the installer **cannot delete an
uninstaller that is currently running**, so it copies the previous uninstaller
into the Windows temp folder and runs the copy from there. That behaviour comes
from NSIS/electron-builder and the path is hardcoded in the tooling — **it
cannot be pointed at a Monky folder**.

The recommended approach is to allow **only that specific detection** when it
shows up, instead of allowing the whole folder.

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
see a red `link_off` icon), the problem is almost certainly **CGNAT** — both
of you are behind symmetric NAT and STUN can't punch through.

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
connects to anybody: each person only talks to the server, so there is no pair
for CGNAT to break. It settles the problem for good, but it moves the cost — all
media now flows through the host, which needs the bandwidth and the
`40000-49151` ports open.

### How to know if you're behind CGNAT?

- Visit [ifconfig.me](https://ifconfig.me) and compare with your router's IP
  (in `192.168.x.x` or `10.x.x.x`). If the public IP **does not appear** on
  your router's WAN interface, you're behind CGNAT.
- Mobile data (4G/5G) is almost always CGNAT.
- Many residential ISPs use CGNAT.
