# Native screen sharing

[Português](README.md)

Monky uses libobs to capture and resize the selected source, **AMD AMF or
NVIDIA NVENC to encode H.264 in hardware**, and native WebRTC to transport
frames **without decoding and re-encoding the video at the sender**.
On Windows, the native receiver uses Media Foundation and SharedTexture.
Voice and cameras retain their own paths.

The implemented capture backend is **Windows x64**. H.264 and Automatic use
H.264; **AV1 is unavailable**, marked Coming soon. There is no automatic
fallback to Chromium capture, a software encoder or another source.
If Game Capture cannot start, one **Normal** attempt uses the same window,
only after proving the previous attempt has retired.
Chromium reception remains available for H.264 profiles the receiving
device can decode; this does not prove sending capability.
Under **Settings → Quality & sharing → Screen reception**, Windows defaults to
Native and uses Chromium only through explicit selection, never as a fallback.
A native failure mentions this option without switching receivers. On macOS,
Chromium is the default and Native remains disabled as Coming soon. The saved
preference applies to the next Watch/Try again without interrupting an active
receiver, changing camera/voice or capture. The Chromium limitation warning
remains visible in settings.

## Sources and availability checks

The picker has two tabs: **Screens** and **Windows**. After selecting a window,
the cards offer **Normal** (default, internally WGC) and **Game Capture**
for that same source. There is no Games tab or automatic game detection.
Changing methods preserves the window ID; choosing another window resets to Normal.
Selection does not run a probe/hook before explicit confirmation.
Use **Refresh** if you open an application after opening the picker. It does
not continuously poll windows/thumbnails while you play. A disappeared source
loses its selection; a failed refresh does not authorize sharing a stale list.

| Native method | libobs source | Preserved identity | Optional audio |
|---|---|---|---|
| Window (`window`) | `window_capture`, Windows Graphics Capture (WGC) | HWND, PID and process creation time | Selected application/process |
| Monitor (`monitor`) | `monitor_capture`, WGC | Device interface, GDI name and physical monitor bounds | System, excluding Monky |
| Game Capture (`game`) | `game_capture`, explicitly for the selected window | The same HWND/PID/creation identity, not just title or executable | Selected application/process |

Monitors come from native enumeration, not an Electron display ordinal.
Disconnecting the monitor or changing its identity, position or resolution
ends the source and requires explicit reselection; it never switches to the
primary display. Minimizing or hiding a window/game is treated as a pause,
not an identity loss. Restoring it allows frames to resume. Closing or
replacing the window/process withdraws its announcement even without viewers.

Availability has three distinct levels:

1. `loadCaptureRuntime()` verifies files and hashes without opening the GPU.
   `captureKinds` declares implementation, **not hardware qualification**.
   Main reports `requiresSelectionProbe: true`; the picker shows preparation
   as pending, without testing an arbitrary source in the background.
2. After user confirmation, Main resolves the selected identity and calls
   `CaptureBridge.prepare(target)`. This opens OBS graphics and checks
   identity, configuration and AMF/NVENC capability, but does not capture
   source pixels or start the production encoder. Main retires this probe
   and proves the original child's closure before releasing its reservation.
3. With local-preview or viewer demand, `start` creates the source and encoder.
   `READY` requires source attachment and real H.264 packets;
   only then can `hardwareSessionConfirmed` become true.
   `hardwareQualified` remains false: one session does not qualify every use.

SPS/PPS are required and validated on the first packet, before sending any
video, not during initialization: the OBS NVENC plugin only exposes those
headers when it produces its first packet. The stream starts with an IDR,
and each keyframe receives current parameters for late viewers.
Missing, invalid or oversized headers remain errors.

When closing the entire source, removing viewers directly retires their shared
pipelines; it does not update remaining-viewer demand on an endpoint that is
shutting down. Actual cleanup failures are still reported.
The native-preview track belongs to preload, not `VideoService`: stopping it
before the decoder closes the writer while frames are still arriving.
Its owner blocks new frames, closes the decoder and drains the writer before
stopping the track; a timeout retains resources for a subsequent retry.

A QPC/RTC observation exceeding 2 ms drops its frame and fences dependent
pictures, requesting a real IDR through the existing bounded recovery (1.5 s).
It neither widens clock tolerance nor invents timestamps or treats clock
discontinuities as success. Connection notices use an 8-second toast instead
of leaving a modal over the game after recovery.

If AMF diagnostics show `primaries=0`, with `transfer=1`, `matrix=1` and limited
range, check the driver: [AMF #354](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/issues/354)
documents this reserved metadata even when OBS requests BT.709.
On 2026-07-20 AMD reported that the fix was in the public driver; this does not
establish availability for every model. The same error was reported on a 5600G
after updating, so updating is not a guaranteed solution.
Setting `InColorPrimaries=1` also failed to resolve this on the tested 5600G.
The host now corrects only the SPS primaries metadata produced by AMF when its
own pipeline was verified as NV12/BT.709/limited range and the SPS declares
exactly `primaries=0`, `transfer=1`, `matrix=1`, `fullRange=false`. The bounded
RBSP/EBSP parser corrects both extra data and in-band SPS before preview and
network output, without re-encoding or changing VCL, dimensions, profile or
timestamps. It records the correction once per host. Other metadata, third-party
streams and RTC colour validation do not receive this exception. Physical
publication on the 5600G still needs confirmation.

On reception, a clock observation that expires during IPC transport is
unavailable, not a failure of the entire audio output. The structured
`ERR_RTC_AUDIO_CLOCK_OBSERVATION` code withdraws the measurement and permits
recalibration under the same epoch, preserving the 200 ms and uncertainty
bounds. `rejectedClockObservations` and `lastClockRejection` retain diagnostics.
Impossible values, unconfirmed PCM and real regressions remain errors.

Quality changes preflight while the original source remains active. Only after
admission do they retire the old instance and publish its replacement with the
same share ID. Stop blocks new demand immediately but drains already admitted
SFU/PCM transactions before invalidating their callbacks; timeouts retain
ownership for retry. Diagnostic queries during retirement return unavailability,
not fabricated zero FPS.

The configurable ceiling is 3840x2160/120 FPS/80 Mbps, without changing existing
presets, with **a maximum of 60 FPS at 3840 px wide or 2160 px high**.
The client applies the same limit to dropdowns, typed values and saved
preferences. The receiving contract and runtime remain compatible with profiles
from older clients; the selection policy does not change the protocol.
Each profile negotiates its required H.264 level: at least 5.1 for
1080p120, 5.2 for 4K60 and 6 for 4K120. The versioned WebRTC overlay and
`h264-profile-level-id` patch add actual Level 6 support; their patches and
licenses accompany corresponding sources. Client and server require protocol
26. The bitrate ceiling is not a floor: congestion control stays active and
different profiles may consume additional upload bandwidth.

This does not make every encoder 4K120-capable. The AMF installed on the tested
RX 9070 XT reports `MaxLevel=52` and rejects `ProfileLevel=60`; 4K60/80 Mbps
initializes at Level 5.2. Preflight queries that capability on the selected
adapter without capturing pixels and rejects an incompatible profile before
retiring the old source. It neither silently changes to 60 FPS nor falsifies the
level. NVENC must also admit the requested level. Initialization is not proof of
physical frame cadence.

The separate `probeCaptureCapabilities()` export initializes the encoder on
the GPU without capturing a source, but **is not Main's global discovery
flow**. Its API does not expose a PID/nonce-bound retirement receipt or an
owner for retrying cleanup after rejection/cancellation. Do not use it to
infer permission to remove the directory or release a reservation; the
selected-source flow retains those ownership and retirement controls.

The encoders are `h264_texture_amf` and `obs_nvenc_h264_tex`. The NVIDIA probe
opens an NVENC session on the actual selected D3D11 device; a vendor/brand
label alone does not prove support. Both pinned texture paths use **DXGI
adapter 0**. A secondary AMD/NVIDIA GPU, especially in hybrid laptops with
Intel on adapter 0, is not automatically selected or guaranteed cross-adapter
compatibility. Model, driver, available resources and encoder session limits
can prevent preparation or capture.

## Video, audio and preview demand

Video uses NV12, H.264 Main profile, zero B-frames and a one-second GOP, with
limits of 3840x2160, 120 FPS (60 FPS at 4K) and 80000 kbps, subject to encoder support. The **Keep aspect ratio** switch
in the picker applies only to the share being created. Off (default), it
stretches the image to the requested resolution. On, it centers the entire
image and adds black bars when aspect ratios differ, without cropping or
distorting the source. The choice applies to preview and every viewer profile,
including after a quality change; it does not change the configured resolution
or FPS and is not a global preference.
Different profiles may require additional encoders and upload bandwidth.
These are configuration limits, not guaranteed FPS, delivered bitrate or
performance. Bitrate feedback confirms settings, not measured hardware
application (`hardwareApplicationConfirmed: false`, `fpsApplied: null`).

Capture starts only after source selection and **local-preview or viewer
demand**. Preview works without viewers: it then uses a local pipeline at
the source profile, without publishing network media. When viewers exist,
it reuses a watched profile and decodes its same H.264 frames, without a
second capture/encoder just for display. The bounded preview queue never
backpressures remote transmission.
A new share opens its preview in focus mode; quality updates and recovery do
not override a later choice to leave focus. The **Normal / Game Capture**
indicator only appears after frames are observed and follows the preview's
or viewer's actual pipeline, not merely the requested method. Signaling this
state requires both client and server to support protocol 26.

**Pause preview when Monky is not focused**, enabled by default, controls
only local preview; losing focus does not interrupt viewers. Turning it off
allows preview to remain active on another monitor. When the last viewer
leaves, remote publication is retired; if preview still has demand, a local
pipeline can continue/restart. Without viewers or preview demand, capture
and encoder resources are retired. This also applies to Game Capture, which
does not need a remote viewer for local preview.

Audio uses the timestamped native PCM path: window/game captures the selected
application; monitor captures the system **excluding Monky**, not just apps
visible on that monitor. It does not capture the microphone. Only one source
can capture audio at a time. When replacing an audible share, the picker keeps
the audio option enabled: Main prepares the new source without acquiring PCM,
and the renderer waits for the previous source to retire before activating
preview and the new audio selector. Preparation failure preserves the old share;
retirement failure prevents replacement activation. Adding another audible
share remains blocked while the first owns audio. When audio capture is unavailable, explicitly
disable it to send video only; there is no silent change of scope. Module
support and device-free tests do not replace physical audio validation on
the target Windows machine.

For playout, `currentFrame` observes the graph clock, not the speaker clock.
Chromium 152.0.7977.130 [advances the graph before updating the
worklet](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/third_party/blink/renderer/modules/webaudio/realtime_audio_destination_handler.cc);
that [update can be skipped by a try-lock](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/third_party/blink/renderer/modules/webaudio/base_audio_context.cc),
repeating the timestamp despite new callbacks. The receiver immediately
withdraws the synchronization anchor and increments only `clockEpoch`, without
replacing the output epoch, device or owner. Unplayed PCM is accounted for in
`discardedFrames`; in-flight credits remain valid and bounded. While the clock
is frozen, output stays buffering/silent, counted in `repeatedContextFrames`.
Only an actually observed advance and the required buffer depth allow a new
anchor; timestamps are never fabricated. A genuinely backward or partially
overlapping clock remains an explicit error.

## OBS dependencies and Game Capture

`scripts\buildCapture.cjs` generates **schema 4**
`bin\win32-x64\capture-build.json`. It keeps OBS **32.1.1**, revision
`7272af1375b38bc3cf4e0f98a5d999e8b76e9309`, with SHA-256-verified files.
Alongside libobs/D3D11/WinRT, `obs-ffmpeg` and the specialized `win-capture`
module, the package includes `obs-nvenc.dll`, locale data,
`obs-amf-test.exe`/`obs-nvenc-test.exe` probes and pinned dependencies.
The probes are also placed beside `monky-screen-capture.exe`.
The dependency package's NVENC header `include\ffnvcodec\nvEncodeAPI.h` is
verified through `src\capture\runtime-additions.json`.

OBS helpers `graphics-hook32.dll`/`graphics-hook64.dll`,
`inject-helper32.exe`/`inject-helper64.exe` and
`get-graphics-offsets32.exe`/`get-graphics-offsets64.exe` ship in
`obs\data\obs-plugins\win-capture` inside the private runtime. Preparing a
`game` selection initializes offset helpers; capture/injection begins only
with demand for that selection. There is no autonomous compatibility
updater/download, global hook installation or global Vulkan layer
registration. These hooks are distinct from **`gclient` build hooks**, which
remain disabled.

Immutable `win-capture` data is copied, with each SHA-256 verified, to
`native-screen-capture\hooks-<hash>\data\obs-plugins\win-capture` inside the
selected profile. The key derives from the complete pinned file set. Each
file is published atomically without replacing an existing copy, which must
also pass path, size and hash verification. Configuration and ownership
remain private to each run.
An injected DLL can remain mapped in the game after sharing ends: this cache
is therefore not deleted on Stop, preview pause or quality changes. Retirement
still requires capture, encoder, transport and helper process closure; it
neither kills the game nor forces its DLL to unload.
An older runtime must be rebuilt to use this storage and both scaling modes.

The normal OBS setting `anti_cheat_hook=true` is retained; it is not permission
to disable anti-cheat, Trusted Mode or change launch arguments. Game Capture
requires rendering compatible with the hook: it is not a universal method for
every enumerated application. The [official OBS
guide](https://obsproject.com/kb/game-capture-troubleshooting) lists CS2 among
games with known issues and recommends windowed/borderless mode with Window
Capture. Missing frames alone do not establish which protection is active.
A Game source initialization failure or first-frame deadline starts a
fallback to **Normal**, with a small localized notification, without disabling
protections. The previous host must prove retirement; HWND, PID and process
creation time are revalidated before the single alternative attempt.
Transport, viewers, audio, aspect ratio and profile stay unchanged.
Window loss, cancellation, encoder failure or a failure after emitting video
do not authorize a method switch. If Normal also fails, the error is explicit.
For these games, Normal may require windowed/borderless mode; compatibility
is not guaranteed. The picker's searchable guide summarizes OBS-documented
limitations, not a complete list of games certified for Monky.

## Building from a checkout

Requirements: Windows x64, Node.js 22+ x64, npm, Git, **CPython 3.11.8+ from
the 3.11 series, x64**, Visual Studio **2022 (17.x)** C++ with **v143/MSVC 14.30–14.44**,
ATL/MFC and the release redistributable CRT, Windows
SDK **10.0.26100.0** serviced to **10.0.26100.3323 or newer**, and x64 Debugging
Tools. Allow several GB for sources, tools and builds.
Python must be an installed executable, not the Microsoft Store launcher.

The shared selector in `scripts\windowsToolchain.cjs` considers only complete,
non-preview VS2022 installations, even with VS2026 installed. It selects the
newest compatible installation within that range, reports versions/paths and
rejections, and checks tools, v143 integration, SDK and servicing before creating
a venv, downloading sources or compiling. **17.13.4 is the pins' upstream
reference, not an exact required patch**; it does not imply VS2026 or MSVC 14.5x
support. SDK 28000 alone cannot replace the 26100 directory: `rc.exe` must remain
in the 26100 family; shared Debugging Tools DLLs may be newer.

`--vs-install=<absolute path>`, `--sdk-root=<absolute path>` and
`--vswhere=<absolute executable>` are available in the selector, preparation,
bootstrap and builders. An invalid explicit selection fails instead of choosing
another installation. Builds do not inherit another Developer Prompt's toolchain:
`vcvars`, GN, node-gyp and MSBuild receive the verified installation and versions.
None of these steps installs or upgrades Visual Studio, MSVC or the SDK.

From the already-updated checkout root in ordinary PowerShell, adjust the Python path
and run each step separately, stopping at the first error. Before rebuilding,
close only this checkout's Monky Dev, not the installed application:

```powershell
$Python = "C:\Python311\python.exe"
$env:PYTHON = $Python
$env:NODE_GYP_FORCE_PYTHON = $Python
$Git = (Get-Command git -CommandType Application | Select-Object -First 1).Source
node apps\client\native\screen-share\scripts\windowsToolchain.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'Windows toolchain preflight failed.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
npm run prepare:native-screen -- --python="$Python" --git="$Git" --jobs=4
if ($LASTEXITCODE -ne 0) { throw 'Native screen preparation failed.' }
node apps\client\native\screen-share\scripts\buildScreenAudio.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'screen-audio rebuild failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Monky build failed.' }
npm start
```

`npm ci` uses the lockfile, but `screen-audio`'s install script defers its build.
`buildScreenAudio.cjs` uses the repository's already-installed `node-gyp` to
configure headers for the installed Electron **after `npm ci`**, not the terminal's
Node version. It then rebuilds
`apps\client\native\screen-audio\build\Release\screen_audio.node` through MSBuild,
fixing the installation/MSVC/SDK and using the private job produced by RTC preparation.
That is why this command comes **after `prepare:native-screen`**.
Run it on first setup or when the addon sources or Electron change; an addon
predating the monitor/identity exports and PCM ACKs must be updated.
If the addon already matches those sources and the installed Electron, a
scripts/TypeScript-only update does not require another `screen-audio` rebuild.
The `screen-audio\test` fixtures do not replace the production addon.
Do not install another Electron or a global `node-gyp`, or reuse an old `.node`
to work around a failure.

The first command is a read-only preflight, with no build, download or GPU use,
and works before `npm ci`. It does not change the global environment or other
packages' install hooks that `npm ci` may run; use ordinary PowerShell,
not another VS version's Developer Prompt.

`prepare:native-screen` uses the Git-ignored `.native-screen` directory. After preflight, it
creates a private venv, acquires pinned revisions, verifies OBS files by SHA-256,
builds `screen-share` RTC and capture, and collects licenses; **it does not
build `screen-audio`**. It does not use experimental directories or execute
`gclient` build hooks. Modified or incomplete source checkouts stop preparation;
they are not silently reset or replaced.

Archive downloads allow up to three attempts for transient network/server
failures, with backoff and partial-file cleanup. Every completed attempt must
validate its pinned SHA-256 and any declared size. Integrity, certificate, unsafe-redirect
or permanent HTTP failures stop preparation without retrying or replacing
the cache.

This sequence does not install system prerequisites or promise a complete
one-command setup on any machine. `nativeScreenReady: true` confirms the
build/runtime, not capture, driver support or NVIDIA sending. A clean-machine
setup and each GPU/driver combination still need their own validation.

The build includes the Visual Studio release redistributable CRT app-local.
End users do not need Visual Studio or a previously installed CRT.
Use a short installation directory: the host accepts paths up to 240
characters, including internal filenames, and rejects aliases.

```powershell
npm run package
```

This uses the same electron-builder pipeline as releases, without terminating
unrelated applications. It produces `release\win-unpacked\Monky.exe` and
`release\Monky-Windows.zip`. Packaging fails when binaries, compiled sources,
runtime, CRT or third-party notices are inconsistent.

## Windows CI and release reuse

CI runs the Windows DOM suite on a separate `windows-2022` runner, concurrently
with native preparation and packaging. Tests remain sequential within that
runner to avoid competing desktop/audio fixtures. Both existing `Build check`
checks wait for packaging on both platforms and the Windows DOM lane; failure,
cancellation or a skipped lane cannot pass those gates. The macOS DOM suite
still runs in its packaging job.

CI and release cache only `.native-screen\downloads`: content-addressed OBS
runtime/dependency archives and the source archives selected by the pinned
OBS recipes. The key includes Windows x64, the archive manifests and the
download/verification recipes, without prefix fallback. CI and release use
separate cache namespaces. Before use, every restored archive is checked
against its trusted SHA-256 and any pinned size; corruption fails explicitly,
not by silently downloading a replacement. A cache miss downloads and verifies
the inputs normally.

This is **not a native binary cache**: Electron ABI, compiler and source changes
still compile afresh. No WebRTC tree, checkout ownership markers, Python venv,
extracted tools or native build outputs are restored. Python 3.11, VS2022 v143
and SDK 10.0.26100.0 selection, native contracts, package checks, licenses and
Corresponding Source generation/publication gates remain in place.

Cold runs gain only the opportunity to overlap Windows DOM with native work,
at the cost of another runner's installation and workspace build. Warm runs
can additionally avoid those OBS archive downloads, but still extract,
validate, compile WebRTC and create the release source archive. This does not
promise a duration or remove the main native compilation cost; measure actual
CI/release runs before claiming a speedup.

## License and Corresponding Source

Monky is **GPL-3.0-or-later**. `LICENSE-MIT` preserves the project's historical
notice. Dependencies retain their own rights and licenses; see
`THIRD_PARTY_NOTICES` and `licenses`. WebRTC notices are derived from the GN
graph actually compiled. The distributed FFmpeg build uses GPL version 3 or
later. H.264 patent rights are separate from software copyright licenses.

Corresponding Source consists of the Monky code for the **same release tag**
and `monky-native-sources-<version>.tar.xz`, with its JSON manifest, on the
[same release page](https://github.com/MonkyOrg/Monky/releases).
The archive includes SDK sources, OBS/FFmpeg libraries and dependency recipes,
including those used by NVENC and the Game Capture helpers. The host,
source-binding changes and Monky build recipes come from the same-tag checkout;
the source archive alone is not a ready runtime. It includes
`SOURCE-MANIFEST.json` and copies of this guide as `SOURCE-README.md` and
`SOURCE-README.en.md`. Upstream source archives retain their original
checksums, including archives containing Unix symbolic links.

After preparing the runtime, generate the source archive with:

```powershell
$Version = (Get-Content apps\client\package.json | ConvertFrom-Json).version
npm run pack:native-sources -- --version=$Version
```

The default outputs are `release\monky-native-sources-<version>.tar.xz` and
`release\monky-native-sources-<version>.json`. The script requires sources and
notices consistent with the build and refuses to overwrite an existing pair.
Do not publish a manifest with `publicationReady: false`: it was produced from
a worktree with local changes. Releases verify the source commit, size and
SHA-256 and only become public after all uploads have been confirmed.

## Rebuilding with the source archive

Obtain the Monky checkout for the same tag, verify the release checksums and
install the same Python 3.11/MSVC/SDK prerequisites listed above. In a fresh
checkout without `.native-screen`, replace `<version>` with the downloaded
archive's version and run each step, stopping on any error:

```powershell
$Python = "C:\Python311\python.exe"
$env:PYTHON = $Python
$env:NODE_GYP_FORCE_PYTHON = $Python
node apps\client\native\screen-share\scripts\windowsToolchain.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'Windows toolchain preflight failed.' }
New-Item -ItemType Directory .native-screen -ErrorAction Stop
& $Python -c "import tarfile; tarfile.open('monky-native-sources-<version>.tar.xz', 'r|xz').extractall('.native-screen', filter='data')"
if ($LASTEXITCODE -ne 0) { throw 'Source extraction failed.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
node apps\client\native\screen-share\scripts\buildRtc.cjs --webrtc-root="$PWD\.native-screen\rtc\webrtc\src" --python="$Python" --jobs=4
if ($LASTEXITCODE -ne 0) { throw 'RTC build failed.' }
node apps\client\native\screen-share\scripts\fetchObs.cjs --runtime-only
if ($LASTEXITCODE -ne 0) { throw 'Pinned OBS acquisition failed.' }
node apps\client\native\screen-share\scripts\buildCapture.cjs --obs-root="$PWD\.native-screen\obs-runtime" --deps-root="$PWD\.native-screen\obs-dependencies" --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'Capture build failed.' }
node apps\client\native\screen-share\scripts\buildScreenAudio.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'screen-audio rebuild failed.' }
node apps\client\native\screen-share\scripts\notices.cjs
if ($LASTEXITCODE -ne 0) { throw 'Native notices failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Monky build failed.' }
```

Use these direct commands, not the acquisition bootstrap, on the snapshot:
it does not carry the build machine's checkout ownership or locks.
Python extraction preserves Unicode source filenames on Windows.
Generic tools still require installed Node/Python/MSVC/SDK; `--runtime-only`
downloads pinned OBS binaries and dependencies for the standard build,
including NVENC and hooks; this is not a fully offline rebuild.
`buildRtc.cjs` must precede `buildCapture.cjs` and `buildScreenAudio.cjs`: it also generates
`build\tools\monky_msvc_job.exe` inside this module. To modify OBS/FFmpeg, use
their sources, recipes and Monky changes and update the runtime pins for
your newly built binaries; do not mix helpers/hooks from another OBS version.

The build checks revisions, ABI, sources and resources, but does not promise
bit-identical binaries across different toolchain versions.

## Validation

`npm run test:native-screen --workspace=@monky/client` covers contracts and
lifecycle without requiring hardware capture. The C++ build also runs
device-free contracts. This module's `test\nativeCaptureSmoke.cjs` and
`apps\client\test\nativeScreenAppSmoke.cjs` exercise real media using their own
synthetic windows; they require qualified hardware and a new artifact directory
provided through `--artifacts=<absolute_path>`.

Application scenarios cover P2P/SFU, Chromium reception, audio, quality,
local preview, Watch/Stop, fullscreen, overlay, server navigation and connection
loss. `--window-lifecycle` adds minimize/restore coverage;
`--idle-source-close` checks closing an unwatched source.
`--publisher-stop` checks two publisher Stop cycles while another participant
is watching, followed by restarting with audio in the same call.
`--source-resize` resizes the synthetic window while preserving its source and
output profile; it does not change monitor resolution or simulate exclusive fullscreen.
Preview QA must validate operation without viewers, focus loss/return,
disabling background pause and uninterrupted viewers. Resolution and frame
counts alone do not prove that decoded pixels were displayed in the interface.

### Known limitation of Chromium reception on Windows

The integrated RX 9070 XT scenario qualified 4K60 with native reception, but
**did not qualify Chromium receiver cadence**. Even at 1080p60, periodic
freezes and results below 50 FPS occurred. During an interval without QA
actions, the `DXGISwapChainImageBacking::Present` scope blocked the GPU thread
for 262–285 ms; decode dispatch was delayed, the adapter queue filled and new
keyframes were requested. The trace does not distinguish `Present1` from the
swap-chain initialization wait or attribute the cause to the driver or DWM.

Analysis of 1,166 slices found no `frame_num` or POC discontinuity. Disabling
only video overlays retained hardware D3D11 decode but did not resolve the
stalls; that workaround was not applied to the application. Queues were not
enlarged, IDR guards were not relaxed and acceptance criteria were not lowered.
This failure remains open and must not be described as fixed based on native
path qualification. The local scenario also does not establish whether a
regression occurred between betas.

These window scripts do not qualify monitors, Game Capture, NVIDIA or
exclusive fullscreen. Local evidence for this integration covers AMF and
WGC/Game on an owned synthetic D3D11 source, including minimize/restore.
Physical monitor capture also passed in a privacy-guarded scenario:
212 decoded frames, 211 distinct, with verified EOF and GPU resource
retirement. This is not performance measurement. Disconnect/resolution
changes, NVIDIA hardware, protected games and physical audio still require
dedicated QA; NVIDIA requires external validation. Windows loopback does not
replace two-computer QA, physical macOS or external network testing.
To verify an already packaged module, `nativeCaptureSmoke.cjs` also accepts
`--module=<absolute_module_path>`; it loads the runtime and binaries from that
directory rather than the checkout.
