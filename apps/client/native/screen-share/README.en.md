# Native screen sharing

[Português](README.md)

On Windows, Monky uses libobs to capture and resize the selected source, **AMD AMF or
NVIDIA NVENC to encode H.264/AV1 in hardware**, or x264/libaom for software
encoding, and native WebRTC to transport
frames **without decoding and re-encoding the video at the sender**.
On Windows, the native receiver uses Media Foundation for H.264 and dav1d for
AV1, with SharedTexture presentation. AV1 decoding runs on the CPU; the
Hardware/Software preference controls sender encoding.
Voice and cameras retain their own paths.

Native backends support **Windows x64 and macOS 14+ (arm64/x64)**. On Windows, **Automatic is the recommended
default** and prioritizes hardware: AV1, then H.264, then software H.264 with a
notice only when a real probe confirms no compatible hardware.
The encoding and codec fields display the effective selection as read-only.
In **Manual**, users choose Hardware/Software and H.264/AV1 in the same group;
the combination is retained and, if unavailable, blocked with an explicit reason,
without silent substitution. Software + AV1 uses libaom.
Unsupported hardware is distinct from driver, file or retirement failures.
There is no silent mid-stream CPU switch, server transcoding or Chromium capture
fallback. Intel/QSV is not implemented; on Windows, Software still uses libobs capture.
If Game Capture cannot start, one **Normal** attempt uses the same window,
only after proving the previous attempt has retired.
Chromium reception remains available for H.264/AV1 profiles the receiving
device can decode; this does not prove sending capability.
Under **Settings → Quality & sharing → Screen reception**, Windows and macOS default to
Native and uses Chromium only through explicit selection, never as a fallback.
A native failure mentions this option without switching receivers. An existing
saved Chromium preference on macOS is preserved. The saved
preference applies to the next Watch/Try again without interrupting an active
receiver, changing camera/voice or capture. The Chromium limitation warning
remains visible in settings.

AV1 uses Main, 8-bit 4:2:0, limited-range BT.709 and L1T1. AV1 profile widths
are aligned to eight pixels before probing and announcement (480p uses 848×480),
avoiding visible AMF padding; H.264 retains its existing profiles. Receivers
without the required codec/level receive an explicit error directing them to
H.264; Automatic does not promise per-viewer transcoding. Actual keyframe
sequence headers are authoritative because pre-frame AMF extradata may be stale.

## Native RTC process isolation

### macOS development status

The application sends windows and monitors through **ScreenCaptureKit → VideoToolbox
H.264 or libaom AV1 → native WebRTC**, over P2P or SFU. Core Image/Metal scales before
encoding; the publisher never decodes/re-encodes its video. VideoToolbox supports
hardware or software H.264. **Manual → Software → AV1** uses the same C++ libaom
encoder as Windows, reading native NV12 outside the Renderer; that readback uses
the CPU, not AV1 hardware encoding or a zero-copy path. Automatic prioritizes
hardware H.264 and only uses software H.264 after proving no compatible hardware
is available. AV1 is never silently replaced by H.264.
The Game Capture hook remains Windows-only. The Mac receiver uses VideoToolbox
for H.264 and software dav1d for AV1, with IOSurface/SharedTexture presentation.

Decoder hardware-use observation is optional. If VideoToolbox returns
`kVTPropertyNotSupportedErr` for this property, native decoding continues and
`hardwareExecutionObserved` remains `null`, without inferring software execution.
Other errors and invalid responses are still reported.

Enumeration, thumbnails and captures share one helper, with separate session
ownership. Selection probes prove retirement of their own session; they do not
require the helper to exit while the picker or another capture still uses it.
This proof checks the original owner's private state, not just its snapshot.
RTC runs in a `utilityProcess`; Main receives Mach rights verified
against PID/euid and keeps the IOSurface until Chromium actually releases it,
including after a child crash. The provider capability protocol still describes
enumeration/thumbnails only; RTC support comes from the compiled library manifest.

Original stereo audio is acquired by ScreenCaptureKit, timestamped with the Mach
clock and sent through Opus. Selecting a window includes the **entire application's**
audio after confirmation, not just that window. Window loss, cancellation and
shutdown retire capture; one viewer stopping does not stop other viewers.
macOS Screen Recording permission is required.

Profiles reach **3840×2160/120 FPS**, subject to source, hardware and network limits.
The probe encodes a synthetic frame and verifies the real H.264 SPS, including Main 6.0,
or the AV1 Main/8-bit/limited BT.709 sequence; this is not throughput qualification.
Software AV1 can consume substantial CPU: start at 720p30 and adjust based on
observed delivery, without expecting 4K120 on M1. Local M1 P2P/SFU audio and multi-viewer tests
passed, and a source rasterized at native 4K sustained approximately 57 FPS at
4K60. **Sustained 4K120 and Intel GPU execution were not qualified in that test**.
Building/running x64 through Rosetta is not validation on an Intel Mac.

With Xcode/macOS SDK, Python 3.11, Node and dependencies installed:

```sh
node apps/client/native/screen-share/scripts/prepareMacRtc.cjs
node apps/client/native/screen-share/scripts/buildMac.cjs
node apps/client/native/screen-share/scripts/buildMacRtc.cjs
node apps/client/native/screen-share/scripts/notices.cjs --mac
npm exec --no -- node-gyp rebuild --directory=apps/client/native/screen-audio
npm run build
npm run test:native-screen --workspace=apps/client
node apps/client/native/screen-share/test/macNativeHostSmoke.cjs
```

Use `--arch=x64` on both builds to produce Intel artifacts on Apple Silicon with
Rosetta. The build runs the helper's self-test and queries the actual target
library; it never fabricates capabilities from arm64. CI also builds on Intel
and Apple Silicon runners. `macNativeHostSmoke.cjs` is device-free, not media proof.
For actual media, `nativeCaptureSmoke.cjs`, `nativeAvSmoke.cjs` and
`screen-audio/test/macPacketAudioSmoke.cjs` use owned synthetic sources and require
an absolute `--artifacts` directory. The audio test also starts and stops system
capture, discarding packets without recording media, to verify process exclusion
without requiring access to protected processes. They do not test external networks.
After `npm run build`, `macSourceAdmissionSmoke.cjs --artifacts=<new-absolute-directory>`
exercises the actual Main/IPC/helper: it repeatedly admits and removes monitors
and windows, reserves/releases audio and keeps the picker alive. It captures
pixels only from its owned synthetic window to verify thumbnails and H.264/AV1
previews; monitor admission does not capture the desktop. The last owner must
close the helper. Local AV1 preview permits software decoding without compatible
hardware, including on M1; it does not change the published codec or the remote
reception preference.
H.264 (hardware/software) and AV1 previews remain active for 15 seconds each,
with concurrent enumeration and thumbnails, before removal and readmission.
`macCaptureStopSmoke.cjs --artifacts=<new-absolute-directory>` exercises a controlled
native delegate interruption of an owned capture while preserving a second real
capture; use `--arch=x64` for Rosetta. It does not induce system resource pressure.
`didStopWithError` acknowledges stream termination but does not replace draining
callbacks, removing outputs and closing the encoder. The original failure remains
visible; a second `stopCapture` must not take down the shared helper. System
interruptions (`-3821`) can also result from low disk space: check the system event
rather than attributing every failure to window identity. The software H.264
encoder completes each timestamp on the capture queue so its internal buffering
cannot exhaust input credits before delivering the first frame.
`macAv1ReceiveSmoke.cjs --artifacts=<new-absolute-directory>` encodes an owned
BT.709 I420 source with WebCodecs, sends AV1 through native RTC and checks codec,
interdependent frames, IOSurface pixels and teardown. It neither captures the
user's desktop nor claims native AV1 encoding on Mac. Use `--mode=sfu` to repeat
through the actual SFU. To test **native AV1 publishing**, use
`nativeCaptureSmoke.cjs --encoder=monky_aom_av1 --profile=480p15 --quality=source --mode=p2p --artifacts=<new-absolute-directory>`
and `nativeAvSmoke.cjs --encoder=monky_aom_av1 --profile=720p30 --mode=p2p --artifacts=<new-absolute-directory>`;
repeat with `--mode=sfu`. These paths capture owned sources with ScreenCaptureKit
and use native libaom, not WebCodecs. `macAv1Encoder.test.cjs` exercises the I420/NV12
ABI, requested keyframes, dependent frames, bitrate changes and source-free probes through 4K120.
Cadence tests require an unlocked macOS session: locking
prevents focus and can throttle composition/capture.

Packaging verifies sources, binaries and licenses from the compiled GN graph.
Signing refreshes hashes of signed binaries and reseals only the outer app;
notarization runs afterward. Without Developer ID, local builds are ad-hoc, not
notarized. Releases include `monky-native-macos-sources-<version>.tar.xz` and its
manifest alongside the matching Monky tag. The archive preserves SDK-internal
relative links; downloadable tools and compiled outputs are excluded.
The approved CI artifact includes both runtimes, licenses and sources; release
reuses them and binds provenance to the integrated commit without recompiling
the SDK when the source tree and environment match. The approved `.tar.xz` is
not recompressed: its embedded manifest still identifies the CI build.
The schema-2 external manifest records that identity in `archiveManifest` and
binds it to the release version/commit, with the same Git tree and SHA-256.

### Windows backend

Before initializing windows and the GPU process, the client disables
DirectComposition video-overlay promotion through Chromium's
`disable_direct_composition_video_overlays` workaround. This compatibility policy
avoids the presentation stalls reproduced when starting a screen publication
while H.264 reception remains active. It does not disable GPU acceleration,
change codecs, resolution, FPS or bitrate, or remove Monky's overlay window.
Video composition may require more GPU work without this optimization. The
policy applies to the Windows client; macOS and other platforms retain their
existing presentation configuration.

Each publishing/receiving endpoint owns a separate Electron `utilityProcess`
named **Monky native screen RTC**. Only that child loads `monky_screen_rtc.node`,
WebRTC and native decoders. An abort, access violation or timeout terminates
only the owned media child, rejects its pending operations and reports
`ERR_RTC_HOST_EXIT` to the source/subscription. A new Share/Watch creates a new
process without switching codecs or falling back to Chromium. Node tests use
`child_process.fork`; the implemented backend remains Windows x64.

After confirmed host exit, persistent diagnostics retain its numeric and
hexadecimal exit code and known OS signals, without copying arbitrary messages,
paths or fields. Containment of an induced fault does not by itself identify
the cause of a crash on another GPU.

Main loads only `monky_native_handles.node`: a kernel HANDLE ownership helper
using `OpenProcess`, `DuplicateHandle` and `CloseHandle`, with no RTC, codec,
COM or D3D dependency. Textures receive a **Main-owned NT HANDLE** before import;
a child's numeric handle is never imported directly. That duplicate remains
owned until Chromium's `allReferencesReleased` (or proof it was never imported).
Child death proves process exit, **not GPU/fence completion**; it does not
retire external references, clear ownership guards on timeout or reuse an old
endpoint.

Texture delivery uses Electron's documented `sharedTexture.subtle` transfer API
over a private, typed, reusable MessagePort per destination, rather than creating
a port pair per frame or using the convenience `sendSharedTexture` API's fixed
one-second timeout. Each frame has its own sequence and a channel admits at most
16 pending transfers. This avoids native-wrapper finalization backlogs from
thousands of ports that can delay Node's event loop and audio delivery in Main.
The renderer returns its real
creation sync token and, separately, a receipt from the native GPU-release
callback. Only then can Main release its imported wrapper and await
`allReferencesReleased` plus the RTC retirement ACK. Acquisition still has the
endpoint's existing deadline; a timeout, malformed receipt or closed port reports
an error but never authorizes GPU reuse. Late real receipts can finish cleanup.
`delivered` counts acquisition; pending transfers include GPU retirement.
No Electron internals or global timers are patched, and the native decoded-pool
limits continue to bound outstanding textures. Destination changes drain the
previous channel; renderer detach requests draining without discarding already
sent frames. A channel closes only after every pending frame's GPU receipt,
without indefinitely retaining closed wrappers.
A responsive JS host does not hide a stuck native worker: decoder operations
observed in progress for eight seconds on the existing native diagnostic clock
also terminate only that child, retaining the Main-owned duplicates.
The raw native snapshot distinguishes MFT input/output, GPU copy/fence calls,
and `IMFSample` return using bounded enums/counters without media contents.
These scopes remain readable while a call is blocked; the diagnostic mutex
does not cover foreign calls or change their ordering or fences.
Persistent `receive-health` records the first diagnostic and first terminal
failure separately, so an earlier warning cannot hide a later stall.
Each cached observation contains at most four decoders and 61 records.
Up to four native operations per decoder prioritize blocked calls over recent
completed calls and report truncation; arbitrary native payloads are excluded.
The pump returns original `IMFSample` objects only after their copy fences and
before another MFT processing/shutdown call. Pending reads yield to the existing fence event,
including abort/shutdown: the private presentation budget does not guarantee
decoder-internal pool capacity. `sampleRetirementDeferrals` counts these waits
without imposing FPS, sleeps, or an arbitrary new surface budget.
Screen publication uses compressed AUs, not texture loans. For legacy NV12
`submitFrame`, child death without the input reader/fence receipt does **not**
authorize producer texture reuse: that guard is retained and full-close proof
is rejected rather than inventing GPU retirement.

IPC has count/byte budgets and correlated acknowledgements. Video awaits the
real native-copy ACK with one AU retained by the bounded capture pipe, never a
synthetic `copied:true`. PCM retains its credit and processing identity separately
from the serialized byte copy. Audio probes/calibration run in the child using
the original RTC clock; QPC/renderer timestamps and uncertainty limits are not
modified. Synchronous capabilities describe the verified build and are checked
against the real child DLL before `ready`. Synchronous snapshots are cached;
diagnostics request a fresh native observation.

Ordinary calls have 128 credits/32 MiB. Retirement has a separate reserve of
64 credits/64 KiB for `releaseFrame`, `close`, `resource.close` and
`audio.stopOutput`, within the host's existing 192-call ceiling. Ordinary
saturation must not prevent release of an already-owned texture. Credits return
only on actual completion or process exit.

Audio clock observations keep at most one call in flight and the latest pending
observation. Replacing an observation resolves its promise as `false`, not as
native application. Stop and epoch replacement cancel pending work; superseded
calibrations are not reapplied. `coalescedFeedback` and
`supersededCalibrationFeedback` record these cases. PCM credits and their
processing receipts are not coalesced.

Compressed capture-pipe copies remain bounded to 16 items/8 MiB, including the
item being written. Admission now uses the native owner's existing 15-second
deadline instead of confusing local delivery with media freshness. RTC still
rejects AUs older than 500 ms and recovers through a real IDR: waiting for a copy
does not authorize presenting stale media. Timestamps, sequence, feedback ACKs
and closure proofs are unchanged; retirement deadlines have not increased.
`maxBackpressureMs` reports the observed wait, not a latency ceiling. The native
build requires the device-free pipe regression with parent reads delayed 1200 ms.

`nativeRtcProcess.test.cjs` covers a real abort, timeout, pending-operation
rejection, credits and recovery. `nativeCaptureSmoke.cjs --rtc-fault=receive`
(or `publish`, with `--quality`) terminates the host during real presentation,
checks Main survival and lease retirement, then creates new endpoints in the
same application.
`nativeAvSmoke.cjs --rtc-fault` additionally covers real PCM/Opus, audio
retirement and a fresh Watch after failure, over P2P or SFU.

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

On Windows, both monitors and windows come exclusively from Win32 enumeration,
without `desktopCapturer` or Electron ordinal/DPI matching. Initial listing
does not capture pixels. An enumeration failure is a loading error, not a
successful response with an empty tab.

Thumbnails use `monky-screen-thumbnail.exe`, an independent WGC process per
image, without an encoder, libobs or game hook. The original target is checked
before and after capture. Its result is an in-memory PNG limited to 1 MiB,
published after native cleanup and accepted by Main only after normal child
exit. Forced exit discards the image; it is not fence proof. At most four
processes run, with 32 active/queued requests. The helper has a 4.5-second
lifetime limit; Main also bounds the wait and observes exit before reusing
the slot. The helper exports no GPU handles.

Before starting a preview, the helper checks borderless API support, requests
`GraphicsCaptureAccessKind.Borderless` and requires Windows authorization.
Only then does it set `IsBorderRequired(false)` and start the session. Setting
the property without authorization is insufficient: Windows may ignore it.
Without support or authorization, the preview is unavailable but the source
remains selectable; there is no bordered retry or system privacy-setting change.
Borders requested by other applications are not changed.

The picker requests batches of four sources per type, updates images
progressively and keeps the list selectable. Refreshing, closing or starting
sharing cancels thumbnails; application shutdown awaits the original children.
Minimized/protected sources or unavailable images retain their option without
a substituted image. Errors are logged, and the cache remains bounded to ten
seconds, 256 entries and 8 MiB. Icons use the system file-icon API.

Disconnecting the monitor or changing its identity, position or resolution
ends the source and requires explicit reselection; it never switches to the
primary display. Minimizing or hiding a window/game is treated as a pause,
not an identity loss. Restoring it allows frames to resume. The title is not
part of the identity either: browsers, editors and players rename their window
for every page or file, and sharing continues. A changed window class or
executable ends the source. Closing or
replacing the window/process withdraws its announcement even without viewers.

WinUI windows (for example, WhatsApp) are not blocked solely because their class
is `WinUIDesktopWin32WindowClass`/`ApplicationFrameWindow`. Admission requires
an admissible OBS property and an exact HWND/PID/creation/thread binding.
The generated WGC source uses that binding rather than the stock title finder,
so identically titled windows remain distinguishable. If enumeration redirects
to a child in another process, selection is rejected rather than implicitly
sharing that child.

Availability distinguishes files, encoders and sources:

1. `loadCaptureRuntime()` verifies files and hashes without opening the GPU.
   `captureKinds` declares implementation, **not hardware qualification**.
   Main reports `requiresSelectionProbe: true`; the picker shows preparation
   as pending, without testing an arbitrary source in the background.
2. `probeCaptureCapabilities()` initializes the selected encoder for the requested
   profile without selecting a source or capturing pixels. It proves retirement
   before enabling Hardware/Software; plugin registration alone is not support.
3. After user confirmation, Main resolves the selected identity and calls
   `CaptureBridge.prepare(target)`. This opens OBS graphics and checks
   identity, configuration and AMF/NVENC capability, but does not capture
   source pixels or start the production encoder. Main retires this probe
   and proves the original child's closure before releasing its reservation.
4. With local-preview or viewer demand, `start` creates the source and encoder.
   `READY` requires source attachment and real packets of the selected codec;
   only then can `hardwareSessionConfirmed` become true, in Hardware mode.
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

Stopping a source or receiver may return `retired-with-errors` when the original
owners prove retirement but report a cleanup error. The renderer logs the warning
and releases only that instance's state, allowing a fresh share or Watch in the
same call. Application shutdown also proceeds after that proof; a historical
error is not retained ownership. Without proof, the operation still fails and
preserves its owners for retry.

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

A receiver PLI requests a new keyframe without invalidating the publisher's
still-valid encoded chain. Dependent frames continue to existing viewers, and
repeated requests are coalesced until a real keyframe arrives. Bootstrap and
actual dependency loss still require an independent frame under the same
recovery bounds.

On reception, a clock observation that expires during IPC transport is
unavailable, not a failure of the entire audio output. The structured
`ERR_RTC_AUDIO_CLOCK_OBSERVATION` code withdraws the measurement and permits
recalibration under the same epoch, preserving the 200 ms and uncertainty
bounds. `rejectedClockObservations` and `lastClockRejection` retain diagnostics.
Impossible values, unconfirmed PCM and real regressions remain errors.
Pending or expired recalibration does not change a previously calibrated
output's identity: volume/mute controls and SFU/P2P reception retain their
bindings. Initial calibration is still mandatory, and stopping or replacing the
output invalidates old bindings; expired measurements never become valid feedback.

Output selection uses `AudioContext.setSinkId()` on the existing context/worklet,
through private epoch-validated IPC. It retains the presentation, transport,
PCM and output epoch; only physical clock measurement is withdrawn until a valid,
non-regressing anchor is available. Selections are serialized; a rejection is
reported to the selector and restores the previous selection without closing
video. Stopping the output drains pending selections before closing the context.
Mute, deafen and volume do not recreate reception. On the stage, participant
indicator-only updates also preserve video elements and fullscreen.

Minimizing or hiding the window also pauses native encoded input, not just
JavaScript packet admission. The source monitor applies this pause even when
exclusive fullscreen stops producing frames. On restoration, the same session
waits for native acknowledgement and a real keyframe before sending again,
without counting minimized time as a recovery failure or widening its bounds.
Closing or replacing the window still requires explicit selection.
The `nativeScreenAppSmoke.cjs --sfu --screen-codec=av1 --native-1080p60
--window-lifecycle --windowed --sample-seconds=8 --artifacts=<new absolute directory>`
regression exercises minimize/restore, preview and audio using a synthetic window.
`--windowed` keeps the viewer inside the QA display's work area; it neither
qualifies a real exclusive-fullscreen game nor disables placement protection.

Quality changes preflight while the original source remains active. Only after
admission do they retire the old instance and publish its replacement with the
same share ID. Stop blocks new demand immediately but drains already admitted
SFU/PCM transactions before invalidating their callbacks; timeouts retain
ownership for retry. Diagnostic queries during retirement return unavailability,
not fabricated zero FPS.

The configurable screen ceiling is 3840x2160/80 Mbps, without changing existing
presets: **up to 240 FPS below 4K and 120 FPS at 3840 px wide or 2160 px high**.
The client applies the same limit to dropdowns, typed values and saved
preferences. Camera keeps its existing 120 FPS limit, or 60 FPS at 4K.
The shared contract, capture host, timebase and RTC accept the new profiles;
client and server must use compatible versions of that contract.
Each profile negotiates its required H.264 level: at least 5.1 for
1080p120, 5.2 for 1080p240/4K60 and 6 for 4K120. The versioned WebRTC overlay and
`h264-profile-level-id` patch add actual Level 6 support; their patches and
licenses accompany corresponding sources. The bitrate ceiling is not a floor: congestion control stays active and
different profiles may consume additional upload bandwidth.

For SFU, both H.264 and AV1 SDP retain the initial estimate of up to 5 Mbps and
the profile ceiling. The adapter includes AV1 when serializing those options,
avoiding an unintended 300 kbps start and accumulated packets in the pacer.
No bitrate minimum is imposed; congestion control can still lower the estimate.
The encoder's minimum configurable rate (50 kbps) does not pause a positive RTC
allocation: real frames keep reaching the pacer, which controls network egress.
Only a zero allocation or an explicit RTC pause suspends admission. Periodic
application-limited probes help detect network recovery without turning the
startup estimate into a mandatory bandwidth floor.

This does not make every encoder 4K120-capable. The AMF installed on the tested
RX 9070 XT reports `MaxLevel=52` and rejects `ProfileLevel=60`; 4K60/80 Mbps
initializes at Level 5.2. Preflight queries that capability on the selected
adapter without capturing pixels and rejects an incompatible profile before
retiring the old source. It neither silently changes to 60 FPS nor falsifies the
level. NVENC must also admit the requested level. Initialization is not proof of
physical frame cadence.

For NVENC AV1, the host pins `tier=0` and the Main Tier level that accommodates
the resolution, FPS and **entire bitrate ceiling**, not just the initial 5 Mbps.
The level remains unchanged during congestion adjustments; 4K/80 Mbps requires
index 17 (6.1). Feedback exceeding the ceiling is rejected. Bitstream validation
still rejects High Tier, and diagnostics include the encoder, requested bitrate
and ceiling. This avoids relying on the driver's automatic level choice as
bitrate increases.

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
limits of 3840x2160, 240 FPS (120 FPS at 4K) and 80000 kbps, subject to encoder support. The **Keep aspect ratio** switch
in the picker applies only to the share being created. Off, it
stretches the image to the requested resolution. On (default), it centers the entire
image and adds black bars when aspect ratios differ, without cropping or
distorting the source. The choice applies to preview and every viewer profile,
including after a quality change; it does not change the configured resolution
or FPS and is not a global preference.
Different profiles may require additional encoders and upload bandwidth.
These are configuration limits, not guaranteed FPS, delivered bitrate or
performance. Bitrate feedback confirms settings, not measured hardware
application (`hardwareApplicationConfirmed: false`, `fpsApplied: null`).

Every encoder uses CBR rate control, including AMF H.264. The pinned AMF plugin
applies each live bitrate through `Flush()` + `ReInit()`, which restarts rate
control and emits an IDR. Under `VBR_LAT`, its ~1-frame VBV produced a small,
blocky IDR that took many frames to sharpen again. On unstable networks the
picture pulsed on every bitrate adjustment. CBR restarts with a full IDR, as AV1
AMF already did. In exchange, AMF pads frames below the target bitrate with
filler, as x264 and AV1 AMF already did.

Even under CBR, every adjustment restarts the Windows hardware encoders: after
`ReInit()`, AV1 AMF still emits a keyframe about half the usual size and takes
10 to 20 frames to sharpen again. NVENC restarts with `resetEncoder` and a forced
IDR. The sender therefore keeps 10% headroom below the RTC allocation and raises
the bitrate only when the new target exceeds the current one by **25%**.
Reductions still apply as soon as the allocation falls below the applied value.
On the recorded bandwidth of an unstable connection, changes dropped from eight
to five in 30 seconds. x264, libaom and VideoToolbox adjust bitrate without
restarting and follow the same rule.

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
only local preview; losing focus does not interrupt viewers. While paused, the
preview shows a black background and the pause message, without the frozen
thumbnail. Returning focus restores the live image. Turning the option off
allows preview to remain active on another monitor. When the last viewer
leaves, remote publication is retired; if preview still has demand, a local
pipeline can continue/restart. Without viewers or preview demand, capture
and encoder resources are retired. This also applies to Game Capture, which
does not need a remote viewer for local preview.

Audio uses the timestamped native PCM path: window/game captures the selected
application; monitor captures the system **excluding Monky**, not just apps
visible on that monitor. It does not capture the microphone. On macOS, exclusion
enumerates our own descendants without inspecting protected data from unrelated
applications. The selected window's identity must still be verified.
Only one source can capture audio at a time. When replacing an audible share, the picker keeps
the audio option enabled: Main prepares the new source without acquiring PCM,
and the renderer waits for the previous source to retire before activating
preview and the new audio selector. Preparation failure preserves the old share;
retirement failure prevents replacement activation. Adding another audible
share remains blocked while the first owns audio. When audio capture is unavailable, explicitly
disable it to send video only; there is no silent change of scope. Module
support and device-free tests do not replace physical audio validation on
the target Windows machine.

Screen sharing selects `overflowMode: 'discontinue'` for PCM capture. The queue
remains bounded to 32 credits with a 500 ms admission wait. If that wait expires,
only the packet without a credit is discarded; the next admitted packet starts
a new native epoch and reports the loss. Acquired indices, PCM, QPC and WASAPI
flags remain original. The bridge waits for previous processing receipts before
activating the new epoch; in-flight credits are never revoked. Device failures
remain explicit and terminal. The RTC diagnostic timer stops before native
close begins, so it cannot inspect dismantled state while resources still drain.

A paired QPC/RTC sample that takes longer than 2 ms does not, by itself,
invalidate continuous PCM. Only in this case, the block continues without an
absolute timestamp and increments the source's `clockObservationsUnavailable`
diagnostic. The next valid observation resumes timestamps without restarting
the epoch. Clock limits are not widened, timestamps are not invented and PCM
is not discarded; discontinuities, regressions and other errors remain explicit.

For playout, `currentFrame` observes the graph clock, not the speaker clock.
Chromium 152.0.7977.130 [advances the graph before updating the
worklet](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/third_party/blink/renderer/modules/webaudio/realtime_audio_destination_handler.cc);
that [update can be skipped by a try-lock](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/third_party/blink/renderer/modules/webaudio/base_audio_context.cc),
repeating the timestamp despite new callbacks. The receiver immediately
withdraws the synchronization anchor and increments only `clockEpoch`, without
replacing the output epoch, device or owner. Valid queued PCM keeps playing:
an unavailable graph timestamp is not evidence of missing audio. Repeated or
skipped observations are counted, but neither discard samples nor manufacture
an underrun. `clockAvailable` explicitly withdraws the speaker-clock relation
until a continuous graph observation returns; timestamps are never fabricated.
A genuinely backward or partially overlapping clock remains an explicit error.

The output primes 60 ms of PCM within a bounded 80 ms ring. A 10 ms hardware
callback can render several worklet quanta before its credit messages leave
the audio thread. The remaining 50 ms provides refill headroom for measured
IPC jitter of about 40 ms; the previous 20 ms target left only about 10 ms.
This adds 40 ms of buffering and 15 KiB of stereo float ring storage, without
timer-based pacing or relaxed clock tolerance. At most 20 ms of native credits may remain outstanding,
including during startup. A real shortage still reports an underrun; this is
not a guarantee against arbitrary process stalls or network interruptions.

## OBS dependencies and Game Capture

`scripts\buildCapture.cjs` generates **schema 5**
`bin\win32-x64\capture-build.json`. It keeps OBS **32.1.1**, revision
`7272af1375b38bc3cf4e0f98a5d999e8b76e9309`, with SHA-256-verified files.
Alongside libobs/D3D11/WinRT, `obs-ffmpeg` and the specialized `win-capture`
module, the package includes `obs-nvenc.dll`, locale data,
`obs-amf-test.exe`/`obs-nvenc-test.exe` probes and pinned dependencies.
The probes are also placed beside `monky-screen-capture.exe`.
The dependency package's NVENC header `include\ffnvcodec\nvEncodeAPI.h` is
verified through `src\capture\runtime-additions.json`.

The build also recompiles `libobs-winrt.dll` from the same OBS revision.
The specialization in `src\capture\wgcCadence.h` configures WGC cadence on
session creation and device recovery, only when Windows exposes
`GraphicsCaptureSession.MinUpdateInterval`. Otherwise Windows retains control
over frame delivery and the limitation is logged. Vendored sources remain
unaltered and hash-verified; `scripts\captureSourceBindings.cjs`, the
specialization and OBS sources are included in the release's corresponding
source. The manifest and host verify the rebuilt DLL's hash, not the original
OBS package DLL's hash.

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
failures, including aborted Windows connections (`ECONNABORTED`), with backoff
and partial-file cleanup. Every completed attempt must
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

Before refreshing licenses or signing, packaging detaches the hard links created
by electron-builder on CI. Application files become independent of the checkout,
avoiding license-copy collisions and changes to the original binaries or
manifests during signing.

Monky is **GPL-3.0-or-later**. Dependencies retain their own rights and licenses; see
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

On Windows, set `$env:MONKY_TEST_DISPLAY='2'` in the same command that launches
the capture, A/V or application smoke to select `\\.\DISPLAY2`
(not Electron's display-array index). Windows receive their coordinates before
construction, start hidden and are shown only after placement validation.
A missing monitor or a window larger than its work area fails the smoke;
there is no primary-monitor fallback or silent source resizing.
To retain this preference when a launcher omits the environment variable,
put `{"display":2}` in the repository-root `.native-screen\test-display.json`.
This file is local and Git-ignored; the environment variable takes precedence.
The target must be non-primary and to the left of the primary display.
Without this optional configuration, other environments retain their previous
default placement. An invalid configured target never falls back to that path.

`nativeCaptureSmoke.cjs` accepts `--encoder=h264_texture_amf`,
`obs_nvenc_h264_tex`, `obs_x264`, `av1_texture_amf`, `obs_nvenc_av1_tex`
or `monky_aom_av1`; the `auto` default preserves the hardware H.264 scenario.
Use `--quality=480p30`, `720p60` or `1080p60` for a single profile,
`--mode=sfu` for real mediasoup forwarding, or `--preview-only`
to validate capture and WebCodecs preview without network admission.
Software still uses libobs/D3D11 capture but does not require a GPU encoder.
Scenarios verify pixels, cadence and resource retirement.

For interruption diagnosis, `nativeCaptureSmoke.cjs` accepts
`--mode=sfu --quality=source --profile=480p15` and
`--congestion=moderate` (500/250 kbps) or `--congestion=severe` (150/50 kbps),
then restores the profile ceiling on the smoke's own transport.
Alternatively, `--main-stall-ms=1700` delays Main after a real PLI.
The report preserves the first failure and counters before cleanup.
These modes inject adverse conditions and may fail; they neither disable
production guards nor independently establish the cause of an external incident.

`nativeAvSmoke.cjs` accepts explicit AMD/NVIDIA H.264/AV1 encoder selection,
`--profile=720p30` (the default remains 1080p120),
`--main-stall-ms=1200` and `--soak-ms=900000` for a 15-minute run
(20-minute maximum). The extended run records event-loop delay and presented
frames, updating `progress.json` every five samples.
Only its owned synthetic window supplies audio/video; no media is recorded.

`--single-receiver-soak-ms=180000` instead measures one continuous receiver,
including worklet silence/underruns, native PCM, source drops and credit/PCM IPC
timing. It writes bounded progress snapshots and incremental `audio-samples.jsonl`
records, retaining only the first and last sample in memory and in the final
report, with the total in `sampleCount`. This avoids accumulating or repeatedly
serializing the full history during playback.
Add `--require-audio-continuity` to reject any added silence, underrun or discard
after source startup, stalled output counters or a discontinuous received tone.
This strict mode requires at least 30 seconds and cannot be combined with the
other soak, fault-injection, mute or lifecycle scenarios.
With `--mode=sfu`, `--sfu-listen-ip=<local IPv4>` binds and announces only that
validated local adapter instead of listening on all interfaces.

`--silent-source` does not start the tone and requires real silent PCM with
advancing counters, allowing continuity/backpressure checks without changing
the mixer. It explicitly reports audible gain/stereo as untested. The normal
run first checks the original signal, so an already-muted source is not blamed
on volume control. `--audio-addon=<absolute_path.node>` selects a separately
built candidate in this fixture only, without replacing an in-use DLL. After a
Main stall, video and PCM must resume on all three receivers; stalls of at least
1200 ms must also produce a diagnosed PCM loss.
The stall starts immediately after posting a real texture transfer, before its
receipt can be dispatched in Main, rather than depending on accidental timing.
`textureTransfer.test.cjs` verifies GPU-before-Main-before-RTC retirement, late
receipts, invalid tokens and document cleanup independently of hardware.
During source loss, the owner process must confirm destruction of its window.
Only in that scenario does the fixture accept either source loss or ambiguity
observed during destruction; production identity guards and full-retirement
requirements remain unchanged.

`--quality=source --profile=1080p240` and
`--quality=source --profile=4k120` exercise the new profiles without reducing
receiver quality. `--cadence-ffmpeg=<absolute_executable_path>` adds an
independent audit of the synthetic window's visual counter: it decodes a
bounded in-memory sample and requires distinct frames at no less than 85%
of the requested FPS, alongside native presentation checks. Packet counts,
encoded frames or repeated presentations alone do not prove actual capture
cadence. The audit does not record video.

For 240 FPS qualification, also use `--disable-frame-rate-limit
--disable-gpu-vsync` **only in the test process**: the synthetic window's
compositor can limit new frames even when JavaScript paints faster.
The fixture produces bounded-work updates independently of RAF.
These flags are not applied to the distributed application. Actual delivery
still depends on the source cadence and system load.

`test\nativeWindowIdentitySmoke.cjs --artifacts=<absolute_path>` uses the
build-generated `capture-contract-test.exe` to create owned
WinUI/ApplicationFrameWindow windows. It verifies real WGC capture with
same-process children and distinguishes both windows with duplicate titles,
while rejecting remapping to another process's child and changed process
identity. It also renames the window while it is captured (a new title, one
over 512 characters and an empty one) and requires frames to keep flowing. It does not capture personal
windows or record video; `--contracts=<absolute_executable>` allows a different
build directory.

New shares preserve aspect ratio by default, including the
`NativeScreenEndpoint` API; `preserveAspectRatio: false` explicitly selects
stretching. The low-level protocol retains its historical
`scaleMode: stretch` default. The application scenario checks the default fit
with borders; `--stretch` exercises the disabled option. `nativeCaptureSmoke.cjs`
explicitly selects stretching for its edge-pixel assertions.

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
