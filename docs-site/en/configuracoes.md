# Settings

Open from the gear icon on the connection screen or bottom bar.

- **Profile** — nickname and picture.
- **Servers and settings** — export your saved servers and app settings to a
  `.monkybackup` file and restore them on another computer. You pick what goes in
  and what comes out each time, and the data can also ride along with the
  identity backup. The file is protected by the password you set when exporting:
  the saved server list may contain server passwords, so it never reaches the
  disk in the clear. Without that password the backup cannot be recovered.
- **Devices** — microphone, speaker/headphones and camera, with preview and list refresh.
- **Voice sensitivity (VAD)** — adjust while watching the meter; leave the marker above the silent level.
- **Noise suppression (RNNoise)** — reduces keyboard, clicks and room noise.
- **Quality and performance profile** — affects only what you transmit.
- **Behaviour** — keep Monky in the system tray when the window is closed, and
  ask before shutting down a server hosted on this machine when you are the last
  person to leave it.
- **Updates** — current version and manual check.
- **Community** — shortcuts for ideas, voting and bugs.

### Appear offline

Under **My Profile → Visibility → Appear offline**, the switch changes your
presence on every connected server, including background connections. You
move to the offline section of the member list and see **Invisible**, with
a high-contrast hollow circular indicator in the bottom bar.
Other members see your presence as offline; changing your nickname or picture
does not make you appear online again.

This does not disconnect the client or interrupt an ongoing call. Your
participation in a voice channel remains visible in that channel.

### Keyboard shortcuts

Under **Keybinds**, choose **Record shortcut** (or **Change shortcut**).
Hold every key in the combination together, then release all keys to save.
For example, `Ctrl + Q + W + E` contains three ordinary keys, not just modifiers
and one key. **Soundboard** shortcuts use the same recorder. `Esc` cancels;
closing the window or switching away also cancels recording.

Monky imposes no key-count limit, but keyboard rollover and operating-system
restrictions still apply. Shortcuts are observed passively without reserving
keys: `Q` remains available to the focused application. This does not bypass
anti-cheat or security restrictions. Holding a chord does not repeat the
action; release a required key before triggering it again. Extra modifiers
prevent activation.

New shortcuts store physical key positions and display layout-specific labels,
including `º` and `ñ` on Spanish keyboards where supported by the system.
On Windows, conversion uses the focused window's actual layout, not a fixed
US table. After switching input language/layout, release and press the chord
again. If the system cannot distinguish two keys in a chord, that chord is not
registered, preventing an incorrect action.
Older shortcuts remain readable; re-record an unrecognized combination from
another layout. Global capture may require input/accessibility permissions.
Push-to-Talk keeps its separately configured keyboard key or mouse button.

### Quality profiles

| Profile | Audio | Camera | Screen | When to use |
|---|---|---|---|---|
| Economy | 24 kbps | 360p | 480p | Slow or unstable internet |
| Normal | 32 kbps | 480p | 720p | General use |
| High Quality | 48 kbps | 720p | 1080p | Fast internet and a PC to spare |
| Gaming | 28 kbps | reduced | smooth (60 FPS) | Gaming: prioritises voice and fluid screen |

The **Custom** profile offers dropdowns with the most common values — aspect
ratio (16:9, 16:10, 4:3 and 21:9), resolution (from the lowest up to 4K), FPS
and bitrate. Every dropdown keeps a **Custom...** entry that reveals the plain
number box for anything outside the list. Changing the aspect ratio keeps the
resolution closest to the one you were already using.

### Sharing your screen while gaming

Encoding video is expensive, and the codec decides whether that cost lands on
the CPU or the GPU. AV1 and VP9 compress better, but almost no PC has a hardware
encoder for them — at 1080p60 the work falls entirely on the CPU and the game
loses frames. H.264 is hardware accelerated on practically every graphics card
(NVENC, QuickSync, AMF).

That is why, on the **Gaming** profile, the **Automatic** codec puts H.264
first. If you use another profile and the game stutters while sharing, pick
**H.264 / AVC** under *Preferred Video Codec*.

On Windows, Monky also captures the screen through the **Windows Graphics
Capture** API, which composites on the GPU and stops delivering frames when
nothing on screen changes. It needs Windows 10 1809 or newer and does not work
inside Remote Desktop sessions — in those cases Monky falls back to the old
method on its own. To force the old method, start the app with
`MONKY_DISABLE_WGC=1`.

One last tip that holds for any capture software: sharing **the game window**
usually costs less than sharing the whole monitor, and playing in *borderless
fullscreen* avoids the mode switches that make a game hitch.
