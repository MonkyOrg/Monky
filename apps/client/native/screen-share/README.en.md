# Native screen sharing

[Português](README.md)

Monky uses libobs to capture and resize the selected source, **AMD AMF or
NVIDIA NVENC to encode H.264 in hardware**, and native WebRTC to transport
frames **without decoding and re-encoding the video at the sender**.
On Windows, the native receiver uses Media Foundation and SharedTexture.
Voice and cameras retain their own paths.

The implemented capture backend is **Windows x64**. H.264 and Automatic use
H.264; **AV1 is unavailable**, marked Coming soon. There is no automatic
fallback to Chromium capture, a software encoder, another source or another
method. Chromium reception remains available for H.264 profiles the receiving
device can decode; this does not prove sending capability.

## Sources and availability checks

The picker has two tabs: **Screens** and **Windows**. After selecting a window,
the cards offer **Window Capture (WGC)** (default) and **Game Capture (hook)**
for that same source. There is no Games tab or automatic game detection.
Changing methods preserves the window ID; choosing another window resets to WGC.
Selection does not run a probe/hook before explicit confirmation.

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
limits of 1920x1080, 120 FPS and 20000 kbps. The image is **stretched to the
requested resolution**, without bars to preserve its original aspect ratio.
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
can reserve audio at a time. When audio capture is unavailable, explicitly
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

`scripts\buildCapture.cjs` generates **schema 3**
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

The normal OBS setting `anti_cheat_hook=true` is retained; it is not permission
to disable anti-cheat, Trusted Mode or change launch arguments. Protected
games, including CS2 with its protected settings, may refuse Game Capture.
Keep protections enabled and, if you want to try WGC, manually choose
**Window Capture (WGC)** for the same window in the **Windows** tab and
confirm. Game compatibility is not promised and the method/source never
switches automatically.

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
Preview QA must validate operation without viewers, focus loss/return,
disabling background pause and uninterrupted viewers. Resolution and frame
counts alone do not prove that decoded pixels were displayed in the interface.

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
