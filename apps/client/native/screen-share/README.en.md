# Native screen sharing

[Português](README.md)

Monky uses libobs to capture and resize a window, AMF to encode H.264, and native
WebRTC to transport frames **without decoding and re-encoding the video at the
sender**. On Windows, the receiver uses Media Foundation and SharedTexture.
Voice and cameras retain their own paths.

The qualified sending path is **Windows x64, a Windows Graphics Capture window,
and AMD/AMF H.264**. Monitors, other encoders and other systems retain the
Chromium path, identified in the picker. A Chromium receiver only accepts an
H.264 profile supported by its decoding capabilities.

The image is **stretched to the requested resolution**, without introducing
bars to preserve its original aspect ratio. No native transmission pipeline
exists before someone watches. Ending the last subscription releases the
actual pipeline. Different quality profiles may require additional encoders
and upload bandwidth; selecting 120 FPS does not guarantee 120 distinct images
per second or remove capture, GPU, presentation or network limits.

## Building from a checkout

Requirements: Node.js 22+, Git, **CPython 3.11.8+ from the 3.11 series, x64**, Visual Studio 2022 C++
with ATL/MFC, Windows SDK **10.0.26100.0** serviced to **10.0.26100.3323 or newer**,
and x64 Debugging Tools. Allow several GB for sources, tools and builds.
Python must be an installed executable, not the Microsoft Store launcher.

From the repository root in PowerShell, adjust the Python path:

```powershell
$Python = "C:\Python311\python.exe"
$Git = (Get-Command git -CommandType Application).Source
npm ci
npm run prepare:native-screen -- --python="$Python" --git="$Git" --jobs=4
npm run build
npm start
```

`prepare:native-screen` uses the Git-ignored `.native-screen` directory. It
creates a private venv, acquires pinned revisions, verifies OBS files by SHA-256,
builds RTC and capture, and collects licenses. It does not use experimental
directories or execute `gclient` build hooks. Modified or incomplete source
checkouts stop preparation; they are not silently reset or replaced.

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
The archive includes SDK sources, OBS/FFmpeg libraries, recipes and patches.
Upstream source archives retain their original checksums, including archives
containing Unix symbolic links.

After preparing the runtime, generate the source archive with:

```powershell
$Version = (Get-Content apps\client\package.json | ConvertFrom-Json).version
npm run pack:native-sources -- --version=$Version
```

Do not publish a manifest with `publicationReady: false`: it was produced from
a worktree with local changes. Releases verify the source commit, size and
SHA-256 and only become public after all uploads have been confirmed.

## Rebuilding with the source archive

Obtain the Monky checkout for the same tag and verify the release checksums.
In a fresh checkout, extract the archive into `.native-screen`:

```powershell
New-Item -ItemType Directory .native-screen
$Python = "C:\Python311\python.exe"
& $Python -c "import tarfile; tarfile.open('monky-native-sources-<version>.tar.xz', 'r|xz').extractall('.native-screen', filter='data')"
npm ci
node apps\client\native\screen-share\scripts\buildRtc.cjs --webrtc-root="$PWD\.native-screen\rtc\webrtc\src" --python="$Python" --jobs=4
node apps\client\native\screen-share\scripts\fetchObs.cjs --runtime-only
node apps\client\native\screen-share\scripts\buildCapture.cjs --obs-root="$PWD\.native-screen\obs-runtime" --deps-root="$PWD\.native-screen\obs-dependencies"
node apps\client\native\screen-share\scripts\notices.cjs
npm run build
```

Use these direct commands, not the acquisition bootstrap, on the snapshot:
it does not carry the build machine's checkout ownership or locks.
Python extraction preserves Unicode source filenames on Windows.
Generic tools still require installed Node/Python/MSVC/SDK; `--runtime-only`
downloads pinned OBS binaries for the standard build. To modify OBS/FFmpeg,
use the included sources, recipes and patches and update the runtime pins
for your newly built binaries.

The build checks revisions, ABI, sources and resources, but does not promise
bit-identical binaries across different toolchain versions.

## Validation

`npm run test:native-screen --workspace=apps/client` covers contracts and
lifecycle without requiring hardware capture. The C++ build also runs
device-free contracts. This module's `test\nativeCaptureSmoke.cjs` and
`apps\client\test\nativeScreenAppSmoke.cjs` exercise real media using their own
synthetic windows; they require qualified hardware and a new artifact directory
provided through `--artifacts=<absolute_path>`.

Application scenarios cover P2P/SFU, Chromium reception, audio, quality,
Watch/Stop, fullscreen, overlay, server navigation and connection loss.
Windows loopback does not replace two-computer QA, physical macOS or external
network testing.
To verify an already packaged module, `nativeCaptureSmoke.cjs` also accepts
`--module=<absolute_module_path>`; it loads the runtime and binaries from that
directory rather than the checkout.
