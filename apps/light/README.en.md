# Monky Light

[Português (Brasil)](README.md)

Native **headless** Monky Light core, under development. It connects to a Monky
server and participates in P2P and SFU voice calls without a resident window
or browser. It is not yet the final tray application or a published installer.

The core does not depend on Electron, Node, or a webview at runtime. Node is a
build tool: it compiles `@monky/shared` and generates the C++ contracts before
native compilation. Targets are Windows x64 and macOS 12+ Intel/Apple Silicon.
Local execution was available on Windows; the macOS CI matrix is prepared,
but does not replace actual platform qualification.

## Building

Development prerequisites:

- Node.js 22 or newer and the monorepo's npm dependencies.
- CMake 3.28 through 3.31. The pinned SDP dependency does not yet support CMake 4.
- Windows x64: Visual Studio 2022/Build Tools with C++ tools and the Windows SDK.
  The script also discovers Visual Studio's bundled CMake.
- macOS 12 or newer: Xcode development tools and CMake. Intel and Apple Silicon use separate
  build directories.

Run from the repository root:

```powershell
npm run build:light
```

On macOS, select an architecture when needed:

```text
npm run build:light -- --arch x64
npm run build:light -- --arch arm64
```

Outputs go to `apps\light\build\windows-x64`, `macos-x64`, or `macos-arm64`.
The script builds the `Release` configuration. To use CMake outside `PATH`,
set `MONKY_LIGHT_CMAKE` to the executable's path.

## Running the core

Use a disposable server from the same branch/protocol version and a dedicated
Light profile, never the installed Monky profile. The profile's parent must
exist; the program creates the final directory. Windows example (adjust the
address to the local server you started):

```powershell
& .\apps\light\build\windows-x64\bin\monky-light.exe `
  --profile "$env:LOCALAPPDATA\Monky-Light-development" `
  --server ws://127.0.0.1:8080 --nickname Light
```

The macOS executable is inside the `monky-light.app` bundle under `bin` in the
architecture's build directory. Run the bundle's executable from a terminal to
keep stdin and stdout available. The bundle declares its microphone usage purpose.

`--help` lists the options. `--channel` takes a voice channel ID;
`--muted`/`--deafened` apply preferences from entry. If the server requires a
password, supply `MONKY_LIGHT_PASSWORD` in the process environment, not on the
command line. It is not saved in the profile.

Output consists of JSON events, including `authenticated` with the channel list.
Enter one JSON object per line in the terminal, using the received channel ID:

```json
{"command":"channels"}
{"command":"join","channelId":"CHANNEL-ID"}
{"command":"mute","enabled":true}
{"command":"deafen","enabled":false}
{"command":"stats","id":"my-query"}
{"command":"leave"}
{"command":"reconnect"}
{"command":"quit"}
```

`enabled:false` undoes mute/deafen. Server restrictions still apply. `stats`
queries devices and RTP on demand; the core does not periodically collect
telemetry. EOF, Ctrl+C, and `quit` close the connection and media.

On macOS, microphone authorization is requested only when a call needs to send
audio. While permission is pending, receiving audio, leaving the call, and
quitting remain available. Denial keeps the microphone muted and emits
`microphone-error`; it does not try to bypass system settings. The macOS
permission flow still requires execution on a Mac.

## Shared contracts

`scripts\generate-light-contracts.js` generates `generated\protocol.hpp` in each
build directory directly from the compiled `@monky/shared` exports. The header
contains the protocol version, message types, error codes, limits, and
reconnection intervals.

Do not edit the generated header or copy protocol version numbers or message
types into native code. Generation does not replace payload validation or the
client state machine.

```powershell
npm run test:light:scripts
```

CI prepares native runs on Windows, Intel macOS, and Apple Silicon macOS.
Tool versions come from `buildTools` in `dependencies.json`; the cache contains
downloaded archives, which remain subject to hash validation.

## Identity and profile isolation

`ProfileIdentity` owns the installation identity. It takes an absolute path,
creates only the final directory when needed, and requires its parent to exist.
It holds the signing key and profile lock for its entire lifetime.

The public `monky-light.json` file stores the format version, public key, and a
random `deviceId` independent of the key. It contains no seed, private key, or
password. Inconsistent metadata, pending files, or a missing identity component
require explicit recovery, never silent replacement. Directories containing
another application's files are rejected.

`IdentityStore` requires an existing absolute profile directory. It holds an
exclusive lock for its lifetime and stores a 32-byte Ed25519 seed with
user-scoped DPAPI on Windows or Keychain on macOS. Calls must be serialized,
and callers must wipe the seed buffers they own.

A missing identity is different from an invalid, locked, or inaccessible one:
the latter conditions fail explicitly, never silently replacing the identity.
`save()` creates a new identity and does not overwrite an existing one.
Recovery, import, and migration are outside this API.

On Windows, `identity.dpapi.pending` indicates an interrupted write requiring
explicit recovery. On macOS, queries are noninteractive; locked or inaccessible
Keychains stop the operation. The account is scoped to the canonical profile
path, so moving the directory requires migration handling.

The platform scenario executable creates disposable subdirectories and removes
only their owned files and Keychain records. On Windows:

```powershell
npm run build:light -- --target monky-light-platform-test
& .\apps\light\build\windows-x64\bin\monky-light-platform-test.exe .\apps\light\build\windows-x64
```

On macOS, the executable is under `bin` in the selected architecture's build
directory. Pass that existing build directory as its argument; do not use an
installed Monky profile or production servers/data.

For the available native scenarios, including signature compatibility with the
verifier used by the server:

```powershell
npm run test:light:native
```

## Connection, voice, and lifecycle

The transport uses WinHTTP on Windows and Foundation on macOS, preserving
system TLS validation and rejecting redirects. Incoming messages are bounded
across the complete message, including fragments; the initial 8 MiB limit
accommodates optional soundboard broadcasts without treating them as voice.
On macOS, the bundle's ATS exception permits `ws://` for user-supplied addresses
that cannot be listed in advance. This does not disable certificate/hostname
validation for `wss://`; prefer encrypted connections outside a trusted local
network. The transport fixture uses the same bundle policy with a separate
identifier.

`ApplicationLoop` serializes events and deadlines on one thread with a bounded
queue. With no work or deadline, it waits for notification rather than polling.
`ConsoleControl` delivers input lines and shutdown signals; its destruction
cancels blocked reads before releasing callbacks.

`ProtocolSession` confirms admission before creating media, reconciles the
participant roster, and correlates replies by connection, generation, ID, and
type. Reconnecting preserves identity; kicks cancel the intent to rejoin.
P2P/SFU transitions follow the server protocol without hidden fallback.

`VoiceEngine` retains the ADM, audio processing, and WebRTC factory only during
a call. Mute stops actual capture; deafen stops capture and playback. A P2P
participant's SDP/ICE failures are isolated to that participant. Screen audio
is not mistaken for microphone audio, and another session of the same user's
audio is not played.

Full-client offers may include video even when Light only wants voice. The
pinned SDK requires nonempty video capabilities during this negotiation:
lazy VP8 factories avoid instantiating codecs, and video transceivers are
stopped before answering. Interoperability scenarios assert zero created video
encoders/decoders; this milestone has no camera, screen sharing, or video rendering.

The synthetic audio device exists only under `test`: it supplies 48 kHz mono
PCM in 10 ms frames and measures received audio energy. It never selects
hardware, even when the SDK requests a default device. On Windows, only this
test device temporarily requests 1 ms timer resolution, released when its
worker stops; it does not change the production client's timer.

The disposable server fixture uses the real server, restricted to loopback,
without LAN advertising or external STUN servers:

```powershell
npm run test:light:server
```

## Exercising voice and measuring resource use

```powershell
npm run test:light:voice
```

This builds the core/server and exercises decoded PCM between native clients
and between native/Chromium over P2P and SFU. It includes three participants,
voice policies, room switching, reconnects, kicks, topology changes, invalid
signaling, and pending/denied microphone permission. Chromium belongs only to
the interoperability scenario and uses synthetic sources and fake devices.

To **explicitly exercise the physical microphone** on Windows or Mac:

```powershell
npm run test:light:hardware
```

The scenario uses the production executable and a synthetic receiver on
loopback. The other participant transmits no sound. It checks PCM delivery
and capture stopping; it neither saves audio nor sends data to an external
server. An available device and system permission are required; this does not
replace listening with two people, different devices, or real networks.

For a reproducible resource sample **on Windows**:

```powershell
npm run measure:light
```

It samples approximately 10-second intervals while connected idle, in P2P,
in SFU, deafened, and after leaving. The source is synthetic, but AEC, automatic
gain, and noise suppression use the default policy. Only the native client's
PID is measured, excluding the server and driver. `oneCoreCpuPercent` uses
**100% = one logical processor**; `workingSetMiB` and `privateMiB` are distinct
Windows measurements, not additive. There is no pass threshold or automatic
Electron comparison. Drivers, other computers, and long-running usage still
need measurement; resident memory can retain allocator pages after teardown.

Chat, soundboard, miniapps, watching streams, tray UI, and CLI-based hosting are
later milestones, with optional resources loaded on demand.

## Distribution

`dependencies.json` pins the WebRTC M140/libmediasoupclient combination for local
qualification, including SDK hashes for each architecture. This older version
is not automatically approved for public distribution.
The package omits the `FieldTrials` API object; the build includes the original
implementation from the same revision with verified hashes, without changing
the library.

There is also a narrowly scoped `libmediasoupclient` correction: codec-less SDP
sections may omit `rtcpFb` and `ext`. Const lookups of those missing keys caused
undefined behavior in the library. CMake verifies before/after hashes and
compiles a corrected copy that treats these two optional lists as empty,
without modifying the downloaded checkout. `sdk_check.cpp` covers this case.

The intended distribution is a separate asset in the same Monky release, using
the version resolved by the existing pipeline. Light's application identity,
profile, installation, and updates remain separate from the full client.
The publication pipeline does not yet include these development components.
Signing, installers, updates, an SDK maintenance policy, and macOS qualification
are prerequisites still outstanding before public distribution.
