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

### Section navigation

In app and server settings, selecting a category expands its section shortcuts
in the sidebar. Submenus expand and collapse smoothly, including when switching
quickly between categories. Click one to scroll smoothly to that part of the page.
The current section is also highlighted while scrolling manually, without
recreating the form or losing unsaved changes. Hidden or unavailable sections
are not included in the navigation.

Submenu expansion and collapse, as well as scrolling through settings sections
and emoji-picker categories, respect the
system's reduced-motion preference: when enabled, navigation is immediate,
without animation.

### Appear offline

Under **My Profile → Visibility → Appear offline**, the switch changes your
presence on every connected server, including background connections. You
move to the offline section of the member list and see **Invisible**, with
a high-contrast hollow circular indicator in the bottom bar.
Other members see your presence as offline; changing your nickname or picture
does not make you appear online again.

This does not disconnect the client or interrupt an ongoing call. Your
participation in a voice channel remains visible in that channel.

### Quick audio controls

The microphone/headphone icons and their arrows share the same style in the
bottom bar. The arrows open an upward panel showing the current device.
Hover over that information or click it to open the side list of devices.
Use the arrow keys to navigate; `Esc` closes the side list first, then the
panel.

The microphone panel also shows **Input level** as a segmented bar.
Selections use the same **Voice and Video** settings and are saved.
The meter is a local preview: it does not unmute your microphone or transmit
your voice. Closing the panel stops the preview. The **Voice settings**
button opens the corresponding tab directly.

The green speaking border on your avatar and in the channel list only lights
up during a call with an active, unmuted microphone, respecting PTT. Outside
a call, only the local meters in open microphone settings keep working.
These previews do not activate the call's speaking indicator, and pressing
the PTT shortcut outside a call does not activate it either.

Right-clicking your own name also opens the user menu, both in the lists and
on your bottom-bar profile. This menu lets you toggle manual microphone
mute and deafen, including before joining a call. The voice-volume control
only appears for other users; all other actions still respect server
permissions. Manual mute never removes an administrator restriction.

Administrative microphone and audio restrictions apply to **the identity on
that server**, including its other devices. Leaving and rejoining the call,
switching servers, or restarting the app or server does not remove the
restriction: an administrator must lift it.

Members with mute or deafen permissions can apply and remove these restrictions
from the member list's right-click menu, even while the person is outside voice
or disconnected. The menu fetches the current restriction before enabling the
action. Kicking from voice and moving channels still require a voice connection.

On the controls, the icon and its color show your personal mute; an administrator
restriction appears separately as a red prohibition badge, only while viewing
the corresponding server, even without joining a voice channel. The server sends
this restriction on connection, including after reopening the app.
When switching servers, the badge and tooltip reflect only the restrictions of
the server being viewed. The actual restrictions of a call on another server
remain enforced.
In participant lists, personal mute is gray and administrator restrictions remain
red. The overlay continues to show the active call's participants.

Both client and server must be updated to exchange this information before
joining voice.

### Tooltips and menus

Client tooltips use a compact dark design, appear after approximately
**150 ms** with the mouse and immediately during keyboard navigation.
`Esc` dismisses the tooltip. Menus and selection lists share the same theme;
use the arrow keys, type to find an option and confirm with `Enter`.
`Esc` closes a selection list without changing its value.

The bottom-bar controls and the composer's **attachment, emoji and code**
buttons have their own hover motions: the gear rotates, the screen-sharing
arrow moves, the soundboard releases musical notes and the emoji laughs.
The camera effect is an animated viewfinder, not a recording indicator.
Clicks and state changes also receive brief visual feedback. The floating
message-action toolbar does not receive these animations. The reduced-motion
preference disables these effects.

In the **Code block** dialog, drag the bottom-right corner to adjust its width
and height; the editor follows the dialog size. Size limits preserve at least
**24 px** of space between the dialog and the application window edges.

This styling covers the client interface. File dialogs and system-tray
menus are still drawn by the operating system.

### Microphone test

Under **Voice and Video**, the test lets you start and stop local playback
of your voice while watching the segmented bar. Use headphones to avoid
feedback between your speakers and microphone. Playback only begins when
you start the test; this preview is not sent to the voice channel and does
not change your mute or Push-to-Talk state. If you are already unmuted in a
call, that call continues transmitting your voice normally. Leaving the tab
or closing settings stops the test.

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

Shortcuts work while Monky is focused, minimized or in the background,
including during calls with an active microphone. On Windows, shortcut
capture runs in a separate process to avoid interference from WebRTC.

**Mute microphone**, **deafen** and **mute soundboard** also work outside a
call. Your choice is saved and respected when joining a voice channel, so you
can join already muted. Outside a call, these actions only change your local
preferences without sending voice-state updates to the server.
Camera, screen-sharing and stop-soundboard shortcuts only act while you are
in a voice channel.

New shortcuts store physical key positions and display layout-specific labels,
including `º` and `ñ` on Spanish keyboards where supported by the system.
On Windows, conversion uses the focused window's actual layout, not a fixed
US table. After switching input language/layout, release and press the chord
again. If the system cannot distinguish two keys in a chord, that chord is not
registered, preventing an incorrect action.
Older shortcuts remain readable; re-record an unrecognized combination from
another layout. Global capture may require input/accessibility permissions.
Push-to-Talk keeps its separately configured keyboard key or mouse button.

### Input mode and Push to Talk

Under **Voice and Video → Input Mode**, choose one of the two cards: **Voice
Activity (VAD)** or **Push to Talk**. The cards also support keyboard
activation, without radio buttons.

With PTT enabled, the **microphone button in the bottom-left corner** gains a
borderless **PTT** label below the icon: yellow with a voice-input icon while
waiting for the key and green with an open microphone while transmitting.
Manual mute or deafen shows only a red crossed-out microphone, without the PTT
label. An administrator restriction adds the red prohibition badge without
replacing your personal icon or hiding the PTT label. The restriction prevents
transmission even when your personal mute is off. Outside a call, the waiting
state is gray.

Clicking the button still toggles **manual mute**. Holding the PTT key does
not undo that mute: it only opens the microphone when allowed. The state
follows the actual microphone gate, including the release delay after letting
go of the key. The configured key and state description appear in the tooltip
and settings; there is no longer a separate indicator on the call stage.

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

**Automatic** can negotiate another compatible codec. An explicit choice is
required for your screen in both P2P and SFU, including when replacing a screen
or switching voice modes. If it cannot be used, the client explains why rather
than sending your screen with a different codec.

On Windows, Monky also captures the screen through the **Windows Graphics
Capture** API, which composites on the GPU and stops delivering frames when
nothing on screen changes. It needs Windows 10 1809 or newer and does not work
inside Remote Desktop sessions — in those cases Monky falls back to the old
method on its own. To force the old method, start the app with
`MONKY_DISABLE_WGC=1`.

One last tip that holds for any capture software: sharing **the game window**
usually costs less than sharing the whole monitor, and playing in *borderless
fullscreen* avoids the mode switches that make a game hitch.
