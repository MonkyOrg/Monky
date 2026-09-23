# Settings

Open the **gear icon** on Home or the bottom bar. These are your app's
preferences. To change something shared with participants, use
[Server Settings](/en/administrar-servidor).

| Tab | What you will find |
| --- | --- |
| My Profile | Nickname, picture, visibility, language, identity and backups |
| Voice and Video | Devices, microphone, PTT, outputs, noise suppression and camera |
| Soundboard / Stickers | Local folders and library controls |
| Keybinds | Key combinations for quick actions |
| Notifications and Sounds | Personal sounds and notices |
| Quality & sharing | Voice, camera and screen profiles, codec, local preview and telemetry |
| Bot tools | Local installations, permissions, cache and tasks |
| Logs | Local events and client diagnostics |
| About and Updates | Version, updates, window behavior and community |

## My Profile

Change your nickname and picture here. **Language** immediately applies
Português (Brasil) or English and saves the preference on this computer.

Under **Identity**, export/import your cryptographic identity to keep being
recognized on servers. See the precautions in
[Getting started](/en/primeiros-passos#keep-an-identity-backup).

**Servers and settings** exports a `.monkybackup` protected by your chosen
password. Select what to include/restore; this data can also accompany an
identity export. Saved servers can include passwords and are not written
in plain text in this backup. Without the chosen password, the file cannot
be recovered.

### Quality, bitrate and telemetry

Under **Quality & sharing**, presets, codec and custom values are grouped with
**Video telemetry**. **Voice and Video** contains devices, audio processing
and previews. To show FPS, resolution and bitrate over camera/screen video,
use **Quality & sharing → Video telemetry**: the switch, position and mode are saved
and applied without restarting the stream.

In the **Custom** profile, hover or use `Tab` to reach the question icon next to
each **Bitrate**. The tooltip explains the effect and cost: higher bitrate can
preserve detail; lower bitrate saves bandwidth but may reduce fidelity or produce
video blocks. It does not increase resolution or FPS by itself.

As a starting point for **one outgoing video copy**, use measured upload,
not the advertised download speed:

| Upload | Initial bitrate ceiling |
| --- | --- |
| 5 Mbps | 2000 kbps |
| 10 Mbps | 5000 kbps |
| 20 Mbps | 10000 kbps |
| 50 Mbps or more | 20000 kbps |

Leave at least **30% headroom** and subtract other traffic, including audio,
camera and simultaneous screen shares. In P2P, each recipient gets a copy;
in SFU, count the outgoing stream to the server. These are starting points,
not quality guarantees: codec, content, resolution and FPS also affect bandwidth
needs. For voice, start at 24–32 kbps per copy; 48–64 kbps provides higher
fidelity. With 1 Mbps upload, 64 kbps uses 6.4% per copy before other costs.

### Watching shared screens

In the voice channel, click **Watch broadcast** on the screen you want to open.
The announcement that someone is sharing does not start receiving its video
and audio on its own. **Stop watching** stops delivery of that screen only to
you, without turning off your microphone, camera or the stream for other
viewers. This applies to both P2P and SFU.

Shared audio belongs to the publisher: if you are watching two of their screens,
stopping one keeps the audio needed by the other. Stopping the last one also
ends that audio reception. Muting is a separate playback preference; it does
not replace **Stop watching** when you want to save bandwidth.

Changing pages, using a pop-out window or enabling the overlay does not change
the screens you chose to watch in the call. Leaving the call or ending the
source clears that choice; a new broadcast must be selected again. A transport
reconnection preserves the choice while the same source remains valid.

On the native path, the last viewer to stop also closes that profile's capture,
encoder and sending pipeline, including the upload to the SFU.
The source announcement remains available to watch again. The Chromium path
preserves capture/preview and may continue uploading to the SFU.
Signaling, connection control, voice and camera can still use the network.

### Native sharing and viewer quality

The picker shows the capture methods and H.264 encoder available in this
device's native backend. Unavailable options are disabled with a reason;
the GPU brand does not guarantee support. There is no automatic switch to
Chromium or another source. The automatic **Game Capture** to **Normal**
attempt, when needed, uses only the same window and displays a notice.

For up to **1920×1080 at 120 FPS**, select **Custom** under **Quality & sharing**;
existing presets were not automatically changed to 120 FPS. In the picker,
**Keep aspect ratio** fits the image into the selected dimensions, adding
borders when needed without distortion. Off retains the current stretch-to-fill
behavior. The switch starts off for each new screen share and is not a global
preference.

A new screen share's preview enters focus as soon as its tile is available.
You can unfocus it: quality changes, reconnections and capture-method retries
do not refocus it. The preview and each viewer show a **Normal** or **Game**
badge for the confirmed mode of that stream, including in thumbnails.
Until an image confirms the mode, the badge stays hidden; selecting Game
Capture alone does not establish that Game is in use.

When watching a native screen, **Received quality** requests a real sender
profile: **Source maximum** or profiles capped at **1080p/60**,
**720p/60** and **480p/30**. All respect the publisher's configured limit;
equivalent choices are not repeated. The 480p ceiling uses 852×480 for encoder
compatibility. This changes transmitted media, not just the player's size.
Different profiles can require additional encoders and upload bandwidth.
Configured resolution, FPS and bitrate are limits, not performance guarantees.
Update both client and server together to use this behavior.

### Appear offline

Under **My Profile → Visibility → Appear offline**, the switch changes your
presence on every connected server, including background connections. You
move to the offline section of the member list and see **Invisible**, with
a high-contrast hollow circular indicator in the bottom bar.
Other members see your presence as offline; changing your nickname or picture
does not make you appear online again.

This does not disconnect the client or interrupt an ongoing call. Your
participation in a voice channel remains visible in that channel.

## Voice and Video

Choose the microphone and watch its meter before joining a call. Set voice
detection above the room's level when quiet. Check the audio output and use
headphones for the local test.

<AppScreenshot src="/screenshots/configuracoes-voz-en.png" alt="The Voice and Video tab showing the microphone, local test and input options." caption="Previews are local. Opening these settings does not unmute or authorize transmission on its own." />

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

### Microphone test

Under **Voice and Video**, the test lets you start and stop local playback
of your voice while watching the segmented bar. Use headphones to avoid
feedback between your speakers and microphone. Playback only begins when
you start the test; this preview is not sent to the voice channel and does
not change your mute or Push-to-Talk state. If you are already unmuted in a
call, that call continues transmitting your voice normally. Leaving the tab
or closing settings stops the test.

### Noise suppression engines

Under **Voice and Video → Noise suppression**, choose an engine and compare
the result using **Test microphone**. The preview uses the same processing
selected for calls without transmitting the test to other people.

| Option | Use and limitations |
| --- | --- |
| RNNoise | Monky's default neural engine. |
| Speex | A lightweight classic filter suited to steady noise. |
| GTCRN | An alternative speech-focused neural network; it runs internally at 16 kHz, limiting music and high-frequency fidelity. |
| WebRTC (built-in) | Suppression integrated into the application's WebRTC audio processing. |
| Off | No noise suppression; echo cancellation and automatic gain control remain active. |

All engines run locally and ship their assets with the application. Perceived
strength depends on the microphone and environment; no engine is best in every
situation. Built-in suppression is not stacked with RNNoise, Speex or GTCRN.

Switching preserves the outgoing call track and respects mute and PTT. The
quick suppression button turns processing off or restores the last selected
engine. Its adjacent arrow lets you choose an engine without leaving the
current view or open its settings directly. Failures are reported instead of
silently switching to unfiltered audio.

### Audio outputs by category

Under **Voice and Video → General output**, choose the application's default
device. This also applies to chat videos, including the expanded media viewer.
The headphone arrow in quick controls changes this same general output.

The **Advanced outputs** switch reveals selectors for **Voice channel**,
**Screen share audio** and **Chat media**. **Use general output** follows the
main selection; **System default** explicitly selects the operating-system
device even when the general output is different.

Alerts and soundboard playback still use the general output. Turning advanced
mode off returns every category to general routing without deleting individual
choices. Preferences are saved and also apply to amplified volumes above 100%.
Device identifiers are not imported from another computer's backup.

If saved devices disconnect and prevent changes from applying, use
**Use system default for all outputs**. This explicit action resets the general
output, clears category choices and turns advanced mode off. It remains
accessible while advanced selectors are collapsed, allowing recovery even
when several devices disappear together.

### Camera effects and preview

Under **Voice and Video → Camera**, preview is on by default when these controls
open. Its visibility control sits above the effects: turning it off retains the
preview rectangle with a **Preview off** message. This capture stays local and
does not turn on camera transmission in the call. The visibility choice lasts
for the current opening; reopening the controls enables preview again.
If the call camera is already
on, both share one capture; hiding or closing the preview does not stop it.
Changing the device also updates the call, even with the preview closed.

In quick controls, the arrow beside the camera opens device selection, preview
and effect controls, with a button that opens the corresponding settings section.

| Mode | Result |
| --- | --- |
| Off | Video without a background effect. |
| Blur | Person segmentation with a blurred background. |
| Color | A solid virtual background, including green, without a physical green screen. |
| Image | A local image used as a virtual background. |
| Chroma key | Removes a color from the physical scene, usually a green screen, replacing it with a color or image. |

Chroma key differs from a green virtual background: it removes the selected
color throughout the image, including clothing and objects of that color.
Call video does not carry transparency; the cutout receives the selected
replacement background. Tolerance, edge and spill-reduction controls help
with physical screens. White, black and gray are also valid key colors;
brightness participates in matching these shades so that all grays are not
treated as the same color. Automatic segmentation is approximate and can fail
around hair, edges and difficult lighting; do not treat it as a guarantee
that sensitive information in the background is hidden.
Each adjustment has a **?** button with an explanation: hover over it or
focus it with the keyboard to read the help without changing the setting.

PNG, JPEG and WebP images up to **8 MiB** are accepted, with additional
dimension limits to prevent excessive resource use. The image is normalized
and saved locally with the preferences, outside the general settings backup.
With **Limit to 720p / 30 FPS** off by default, effects follow both the selected
quality profile's **resolution and FPS**. Enable the switch to reduce processing,
capping both at **1280 × 720 and 30 FPS**. It never raises a lower resolution or
frame rate, or upscales a smaller capture. Camera capabilities and processing
capacity can also reduce the actual frame rate. Turning effects off preserves
normal camera quality.

The model and processing ship with the application and need no external API:
frames are processed locally before being sent through the P2P or SFU call.
If processing fails, the camera stops and reports the error rather than
silently reverting to unprocessed video. Turning the effect off requires an
explicit choice.

### Color picker

The physical chroma-key screen color, virtual background color and role
colors share Monky's color picker. Click the color swatch to open hue,
saturation and brightness controls, presets and a **HEX** field that accepts
three or six digits.

Releasing a dragged control or choosing a preset applies the selection.
After entering a valid HEX code, `Enter`, the close button or an outside
click confirms it; closing the picker does not undo the chosen color.
Invalid input is explained in the panel. `Escape` cancels only unfinished
input and closes the picker without closing the surrounding settings.

The **Eyedropper** lets you choose a screen color. During sampling, `Escape`
cancels only the eyedropper, retaining the previous color and keeping the
panel open. Permission and capture failures are reported without replacing
the color with a default. Sampling does not disable effects or transmit an
unprocessed camera to the call.

## Soundboard and stickers

The soundboard automatically creates a default folder in your local Monky
profile. You can change it under **Settings → Soundboard**; an existing folder
selection is never replaced. For stickers, choose a folder in the corresponding
tab. These are local libraries, not server folders. Configuring a folder does
not upload all its files. See
[Everyday Soundboard and sticker use](/en/usando-o-app#soundboard) for formats,
sending and permissions.

### Local soundboard limit

**Control overly loud sounds** is off by default. Even while off, set the
**Loudness ceiling** from **1 to 10**; the initial value is **6**.
Enable the switch to apply the selected ceiling.
A lower ceiling reduces excessively loud sounds more.
Sounds below the ceiling keep their volume; quieter sounds are never boosted.
The same switch and ceiling control are available directly in the **Soundboard
modal**, below the volume controls, without opening settings. Both views share
the preference and support keyboard operation.
During playback, a marker on the bar shows loudness **before reduction**, on
the same scale as the ceiling. The round slider thumb sets the ceiling;
the moving marker and “Before limiting” value show the actual audio.
Green means below the ceiling, yellow means within one level below it, and
red means above it. The bands follow your chosen ceiling. Values above 10
remain visible in the text even when the marker reaches the end of the bar.
The colors help choose the cutoff; they do not diagnose distortion in a file.

The ceiling applies after mixing soundboard clips, including local library
previews, and after your selected volume: simultaneous sounds also respect
the limit. Voice, music and what other participants hear do not change.

The decision considers frequency-weighted audio energy over time, rather
than just the highest peak. Separate protection prevents excessive digital
peaks. Processing looks ahead by approximately 100 ms to reduce loud sounds
from the start, including short effects.

The scale is relative: it neither measures nor guarantees physical headphone
or speaker loudness, which also depends on the system and device. It cannot
restore an already distorted recording. Both settings persist across restarts.

### Sound and server favorites

Use stars to mark sounds in the soundboard grid/list and under
**Settings → Soundboard**, or servers in Home's **Saved** list.
The **All/Favorites** filter combines with search without duplicating items.
Favorites appear first in alphabetical order, followed by nonfavorites in
alphabetical order. Starring or unstarring moves items with a smooth
transition; switching **All/Favorites** also animates the list change.
Animations respect the system's reduced-motion preference.
Stars support `Enter` and space without playing a sound or opening a server.

Sound favorites identify the complete file path: matching names in different
folders are distinct. Returning to a previous folder restores its stars.
Server favorites follow address and port; renaming preserves the star and
editing the address transfers it. Deleting a server removes its favorite.

These preferences stay local and do not travel in the general backup.
Importing servers preserves stars for retained addresses and removes those
for removed addresses. Sorting preserves each sound's assigned shortcuts and
does not change the server rail.

## Keybinds

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

## Quality & sharing {#quality}

The profile controls what **you transmit**; it does not increase someone
else's camera or screen resolution. This tab also groups codec, local sharing
preview and telemetry; profiles still include voice and camera settings.

### Quality profiles

| Profile | Audio | Camera | Screen | When to use |
|---|---|---|---|---|
| Economy | 24 kbps | 360p | 480p | Slow or unstable internet |
| Normal | 32 kbps | 480p | 720p | General use |
| High Quality | 48 kbps | 720p | 1080p | Fast internet and a PC to spare |
| Gaming | 28 kbps | reduced | smooth (60 FPS) | Gaming: prioritises voice and fluid screen |
| Ultra | 64 kbps | 1080p / 60 FPS | 1080p / 60 FPS | Sufficient bandwidth and hardware for higher rates |

These are configuration targets, not guaranteed observed FPS or bitrate.
Devices, codecs, networks, participant count and content affect the result.

The **Custom** profile offers dropdowns with the most common values — aspect
ratio (16:9, 16:10, 4:3 and 21:9), resolution (from the lowest up to 4K), FPS
and bitrate. Every dropdown keeps a **Custom...** entry that reveals the plain
number box for anything outside the list. Changing the aspect ratio keeps the
resolution closest to the one you were already using.

### Sharing your screen while gaming

Encoding video consumes resources. Acceleration depends on the hardware, driver
and support confirmed by the backend. For screen sharing, **Automatic** uses
**H.264 / AVC** today; **AV1** remains disabled as **Coming soon**.
Hardware encoder selection is separate from the codec. If support is
unavailable, the client explains why instead of silently changing codecs.

The picker separates **Screens** and **Windows**. Each window appears only
once in the window list; there is no list of detected games. After selecting a
window, the method cards offer **Normal** by default and
**Game Capture** as an explicit choice. Changing the method keeps the
same window and its audio choice. Selecting another window resets the method
to Normal rather than carrying over the previous window's Game Capture choice.

Choosing the Game Capture card does not start capture or test the application:
you must confirm with **Share**, **Switch Source** or **Add screen**. Only
methods advertised by the backend are available; compatibility with the
selected window still needs to be checked. If Game Capture becomes
unavailable, Monky closes that attempt and notifies you that it is trying
**Normal for the same window**. The notice stays visible for 8 seconds to give
you time to read it and reports an attempt, not an already
confirmed image. It never chooses another monitor or window, uses Chromium,
or disables anti-cheat, Trusted Mode or other protections. If Normal also
fails, the error remains visible; there is no switch to another source.

A closed or disconnected source notice appears for 8 seconds without requiring
dialog confirmation. Repeated failures from the same source are grouped until
it recovers; their details remain in the logs. Once the preview displays video
again, a new failure can trigger another notification.

For games, try **Game Capture** first, following the
[OBS recommendation](https://obsproject.com/kb/game-capture-source).
It is not intended for every window; games such as CS2 may prevent this method.
**Normal** mode may require the game to run in
windowed or borderless fullscreen mode, without changing protections.
This also follows the
[official OBS guidance](https://obsproject.com/kb/game-capture-troubleshooting);
the window name or title is not used to promise game detection or compatibility.

Under **Windows**, **Does my game work with Game Capture?** opens a local guide
searchable by title or alias, such as CS2, GTA SA and LoL. Its 14 references to
OBS limitations and guidance are grouped into **Use Normal** (the recommended
alternative for those cases) and **Needs attention** (specific precautions).
This is not a complete compatibility list or a guarantee for Monky.
An absent game means only **no catalogued information**, not incompatibility;
try Game Capture first.
The guide does not access the network, test games, start capture or change
your selection; its official-source link opens the browser only when activated.

The guidance covers DirectX 12 in Fortnite, separate League of Legends client
and match windows, and permission or multi-GPU limitations. The match window
must be selected explicitly. There is no automatic GPU selection or permission
elevation, and no recommendation to disable protections.

Opened a game or another window after the picker? Use **Refresh**. There is
no background polling. If the source remains available, its tab, selected
ID, method, quality, audio and **Keep aspect ratio** choice are preserved.
A source that disappears loses selection and is never replaced automatically.
Confirmation is disabled while refreshing; failures remain visible and can
be retried in the same modal.

One last tip that holds for any capture software: sharing **the game window**
usually costs less than sharing the whole monitor, and playing in *borderless
fullscreen* avoids the mode switches that make a game hitch.

## Notifications and Sounds

Adjust personal sounds and notices here. This does not change mention
permissions or events published by the server; those belong to
[server administration](/en/administrar-servidor).

Under **Custom sounds**, every app effect has preview, file selection and reset
controls: microphone, received audio, joining/leaving calls, starting/stopping
screen sharing, chat notifications, pressing/releasing push-to-talk and
reconnection. Selected files survive restarts, including effects with
synthesized defaults. Resetting an effect restores its original file or tone;
**Reset all** removes every override. This does not enable chat notifications
or PTT cues that you disabled in their respective options.

## Bot tools

Inspect installed tools, storage, cache, authorizations and local tasks.
A server grant does not authorize a bot to run tasks on your computer
without consent.

<AppScreenshot src="/screenshots/ferramentas-en.png" alt="The Bot tools tab with storage, tools, permissions and task sections." caption="The client centralizes management; consent is specific to each bot and device." />

Revoking authorization or removing a tool ends affected work. Read
[Tools on your computer](/en/bots#tools-on-your-computer) before approving
a request.

## Logs

Inspect client events to identify the failing stage of an operation. Review
and remove sensitive content before sharing logs.
The [Server Monitor](/en/criar-seu-servidor#server-monitor) is a separate query,
subject to that server's permissions.

### Diagnose screen sharing

1. Under **Settings → Logs**, enable **Record logs** before reproducing.
2. Share the window, game or monitor and note the time, mode and selected
   quality. If possible, ask another participant to watch, change quality and
   stop watching. Also test pausing the preview when the app loses focus.
3. Stop sharing and use **Export logs** in the same tab. For receiving problems,
   also export the logs from the participant who was watching.

`SCREEN_SHARE` entries prefixed with `Native screen` show source admission,
encoder preflight (including failures before a source exists), backend,
resolution/FPS/bitrate, per-quality pipelines, watch/stop, Game-to-Normal
fallback, preview states and resource retirement. `retained: true` means cleanup
still retains resources; it is not confirmation of shutdown. Correlation
identifiers are hashes, not window titles.

These diagnostics do not record pixels, individual frames, SDP/ICE,
credentials, complete payloads or free-form error messages/stacks. Failures
record their stage and available native codes. In `nativeDiagnostics`, NVENC
diagnostics preserve known operations/capabilities, API version, numeric status,
enumeration counts and observed/required values. H264 color failures preserve
the observed `fullRange`, `primaries`, `transfer` and `matrix` (`null` means
absent), including nested errors. Other text remains omitted.
Identical repeats are limited.
Polling metrics does not add a line per update. Entries use the existing local
log storage and rotation; while **Record logs** is disabled, new events are
neither persisted nor recovered retroactively. Logging continues while the
export dialog is open; the exported file includes events written up to
confirmation.

## About and Updates

Check the version, look for updates and revisit the installed release's notes.
Betas are prereleases and require opting in; prefer stable for everyday use.
See [Updates](/en/download#updates).

Window behavior and community links are also here. When hosting a server
on this computer, distinguish **closing the window**, **keeping the app in
the tray** and **stopping the server**: stopping the process affects connected
participants.

## Connection and interface

### Enter the server when Monky opens

On Home, select or enter the server and enable **Enter when Monky opens**,
next to **Join Server**. The choice is saved only after a successful connection.
There is a single destination: connecting to another server with the switch
enabled replaces the previous one. A failed attempt leaves the saved destination unchanged.

The preference applies to future launches until you turn that same switch off;
turning it off disables automatic entry immediately, without having to connect.
It never starts stopped servers or joins voice. When migrating older settings
with multiple destinations, only the most recent choice is kept. A short
animation accompanies the transition from Home to the server, unless reduced
motion is enabled.

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

### Starting another server during a call

Starting and viewing an owned offline server from Home or the server rail
does not join voice automatically or interrupt the current call, microphone,
camera or screen shares. Joining a different voice channel remains a
separate action.

If this application instance already hosts another server, it will not stop
it implicitly. Use the hosting controls to stop it explicitly when safe before
starting a different server.

## Server settings: immediate application

These settings are shared and live in the **server name** menu, not your
personal gear icon. [Manage a server](/en/administrar-servidor) explains
immediate application, roles, channels, limits, voice mode and process
version. For bot permissions and compatibility warnings, see [Use bots](/en/bots).
