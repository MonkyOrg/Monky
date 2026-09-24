---
aside: false
pageClass: pagina-arquitetura
---

# Architecture

How Monky is built on the inside: the components, how they talk to each other,
and why the decisions were made that way.

This page describes **what exists in the code today**. If you are looking for the
project's original specification — with MVP, phases and future ideas — it lives
in [`docs/especificacao-tecnica.md`](https://github.com/MonkyOrg/Monky/blob/main/docs/especificacao-tecnica.md).

## The core idea: two separate planes

Everything in Monky starts from one split: **what the server controls** and
**what travels directly between people**.

<div class="diagrama">

![The core idea: two separate planes](../diagramas/en/01-a-ideia-central-dois-planos-separados.claro.svg){.tema-claro}
![The core idea: two separate planes](../diagramas/en/01-a-ideia-central-dois-planos-separados.escuro.svg){.tema-escuro}

</div>

The server handles login, channels, chat, roles and **signaling**. In the default
mode, it introduces participants to each other and then steps aside: voice,
video and screen travel **P2P over WebRTC**, without passing through it.

That has two consequences which explain nearly everything else in the project:

- **The server's bandwidth barely matters.** It carries no media, so a modest VPS
  is enough for the group. The bandwidth cost sits with the participants.
- **The conversation is not readable by the server.** Even the person hosting
  cannot listen in — WebRTC is encrypted end to end between the peers.

::: warning Both consequences describe the default mode
Whoever hosts can switch the media plane to [SFU mode](#topology-2-sfu-selective-forwarding-unit), and then neither statement above holds: the server starts carrying all of the channel's media and gains access to its contents. SRTP terminates at `mediasoup`, which decrypts each packet and encrypts it again for every recipient — that is how any SFU works, and it is the price of not sending the same video N times. There is still no third party involved, since the server is yours, but "not even the host can listen in" is a property of P2P Mesh, not of Monky.
:::

## The components

The repository is a monorepo with npm workspaces:

| Workspace | What it is |
|---|---|
| `apps/client` | The Electron app — the interface, and also the host when you host from the app itself |
| `apps/server` | The server: WebSocket, SQLite and the [Monky CLI](/en/cli) |
| `apps/light` | Native headless core under development; not the published desktop client covered by the user guides |
| `packages/shared` | The contract between the two: protocol types, validators, limits and quality profiles |
| `packages/bot-sdk` | SDK, bot contracts, voice connection, local execution and bot CLI packaging |

`packages/shared` is what stops client and server from drifting apart: both
import the **same** types and the **same** validators.

Light's implementation and current limitations live in its
[own README](https://github.com/MonkyOrg/Monky/blob/main/apps/light/README.en.md).
The interface sections below describe the Electron client.

## The client

### Three processes

Electron splits the app into three contexts, and Monky respects that split:

<div class="diagrama">

![Three processes](../diagramas/en/02-tres-processos.claro.svg){.tema-claro}
![Three processes](../diagramas/en/02-tres-processos.escuro.svg){.tema-escuro}

</div>

The renderer runs with `contextIsolation: true` and `nodeIntegration: false`: the
UI **has no access to Node**. Anything that needs the operating system — picking
a screen to share, reading the native audio module, touching the tray — goes
through the `window.api` bridge exposed by the preload.

### The UI uses no framework

Possibly the project's most unusual decision: **the renderer is plain TypeScript
and DOM**. There is no React, Vue or Svelte. Views build their own HTML with
template strings and re-render themselves.

`SessionManager` keeps connections, chat, members and miniapps isolated per
server session. The active session's stores emit on the UI bus (`appEvents`);
background stores update their data through a silent bus. Preferences and
the active call have global scope. Switching the viewed session does not
close the connections.

Views subscribe to relevant events; the diagram shows this logical flow,
not one store mixing every server's data:

<div class="diagrama">

![The UI uses no framework](../diagramas/en/03-a-interface-nao-usa-framework.claro.svg){.tema-claro}
![The UI uses no framework](../diagramas/en/03-a-interface-nao-usa-framework.escuro.svg){.tema-escuro}

</div>

### The services

Every large client responsibility lives in its own class, under
`src/renderer/core/`:

| Service | Responsibility |
|---|---|
| `NetworkClient` | WebSocket, authentication, heartbeat and reconnection |
| `WebRtcManager` | Shared media orchestration, local publications and P2P connections; delegates SFU transport |
| `webrtc/SfuClientEngine` | SFU transport: negotiated capabilities, producers, consumers and reconnection |
| `AudioProcessor` | Microphone, noise suppression, speech detection |
| `VideoService` | Shared camera capture, local effects and screen capture |
| `ScreenAudioService` | Bridges the native screen-audio module into WebRTC |
| `ParticipantManager` | Who is online, in which channel and in what state |
| `SoundboardService` | Soundboard clips and shortcuts |
| `KeybindService` | Global shortcuts |
| `AttachmentUploader` | Chat attachment uploads |
| `UpdateService` | Update check and banner |

### Screen sharing: shared behavior, separate transport

Sharing a screen is the same feature in both modes. A transport should not
carry a second implementation of capture, quality preferences or codec rules.

| Responsibility | Owner |
|---|---|
| Capture, preview and source shutdown | `VideoService`; audio capture belongs to `ScreenAudioService` |
| Stop/replace controls, associated audio and updating the correct session | `screenShareControls.ts`, used by the picker, views and call departure/switching |
| Intended screen publications, cancellation and cleanup on failure | The `localScreenShares` registry and screen-sharing methods in `WebRtcManager` |
| Viewing intent, independent of the view and mute preference | `VoiceStore`, owned by the call session and applied to both transports through `WebRtcManager` |
| Bitrate/FPS limits and adaptation preference | `webrtc/mediaEncodingPolicy.ts`, used by P2P and SFU |
| Codec-family selection and refusal of alternatives for explicit choices | `webrtc/codecPreferences.ts`, with capabilities supplied by each transport |
| Serialized RTP parameter changes | `webrtc/rtpSenderParameters.ts`: quality and codec do not overwrite each other's transaction |
| Receiving and associating remote media with the UI | `webrtc/RemoteMediaRouter`, shared by both modes |
| Native capture/encoding/transport and Main-process ownership | `nativeScreenSharing.ts` and `native/screen-share` |
| Native-screen subscriptions/presentation or compatible Chromium reception | `webrtc/NativeScreenController.ts` and `webrtc/BrowserScreenSubscription.ts` |

On the Chromium path, what **must** differ is the publishing mechanism. P2P has one sender per
destination, SDP/ICE negotiation and a dedicated sending m-line per screen;
the encoder is also selected through `encodings[].codec`. SFU has a producer
on the sending transport, with its codec selected from capabilities negotiated
with the server. SDP codec preferences do not replace pinning the P2P encoder,
and the local capabilities used by P2P do not replace SFU capabilities.

On this path, capture and publication have separate lifetimes: rebuilding a transport in
the same call preserves active capture, while leaving the call or stopping the
share ends the source. A mode change requiring an authorized leave/rejoin
performs the full call cleanup. SFU uses `stopTracks: false`, and screen audio and video share
protection against late producers after cancellation or replacement. Changing
the codec rebuilds publication, not capture.

The picker calls `WebRtcManager.assertScreenShareSupported()` before requesting
capture; `VideoService` does not depend on codecs or voice mode. Closing the
picker cancels pending acquisition without ending already published screens.
Audio startup can also be cancelled before native capture or during publication:
stopping the screen must not produce a late audio-sharing announcement.
The controls helper snapshots the call session instead of sending updates to
whichever server happens to be visible when an asynchronous operation finishes.

Profile values are **per-send ceilings**, not FPS guarantees or a total
upload budget. P2P may send the same screen to several destinations; SFU
normally sends it to the server once. `GAMING` prioritizes framerate; the
other profiles prioritize resolution. These ceilings do not promise sustained
1080p120.

The native path uses **libobs/WGC → AMF H.264 → native WebRTC** on qualified
Windows x64 systems, without decoding and re-encoding video at the publisher.
Stretch scaling happens before the encoder. On Windows receivers, Media
Foundation decodes and SharedTexture supplies frames to the stage and overlay.
Chromium receivers negotiate the actual H.264 profile before accepting a subscription.

Each demanded profile owns a pipeline; viewers of the same profile share
capture/encoding, but not viewing authorization. Limits are four profiles per
source and 16 viewers per profile. With no demand, the pipeline closes and only
the source descriptor remains. A new subscription creates new owners instead
of reusing retired engines. Centralized IPC, Main-process validation and
private closure receipts preserve resource ownership.

### What is stored on your machine

The client uses `localStorage` for simple preferences, IndexedDB for camera
effects and the background image, and native storage for identity.
These stores have different purposes and guarantees.

<div class="diagrama">

![What is stored on your machine](../diagramas/en/04-o-que-fica-salvo-na-sua-maquina.claro.svg){.tema-claro}
![What is stored on your machine](../diagramas/en/04-o-que-fica-salvo-na-sua-maquina.escuro.svg){.tema-escuro}

</div>

| Key | Contents |
|---|---|
| `monky_settings` | Preferences: quality, devices, volumes, shortcuts, soundboard |
| `monky_nickname` / `monky_avatar` | Your visual identity |
| `monky_saved_servers` | Servers you saved to reconnect to |
| `monky_created_servers` | Servers you created on this machine |
| `monky_favorites` | Local sound favorites by full path and server favorites by address/port |
| `monky_device_id` | Identifies **this device** (lets the same person use two machines) |
| `monky_language` | Interface language |

In the `monky-camera-effects` IndexedDB database, preferences and one normalized
image share a transactional record. Persistence failure does not change the
in-memory preference; corrupt data is not interpreted as consent to transmit
the camera without an effect.

Automatic separation uses Robust Video Matting (RVM/MobileNetv3) and TensorFlow.js
with bundled graph and weights, without a CDN or frames sent to an API.
Inference, compositing and chroma key run in an `OffscreenCanvas` worker, with
at most one frame in flight. `MediaStreamTrackProcessor` reads capture frames
directly; the video-element fallback logs a warning when that API is unavailable.
Chroma, compositing and separable blur use WebGL2 shaders without reading
or looping over full-resolution video pixels in JavaScript. Blur excludes
the person before filtering and normalizes by the available background
weight without enlarging the image. This prevents foreground colors from
bleeding into the contour or producing a second, displaced silhouette.
RVM takes full-resolution RGB and maintains four recurrent states. Its internal
ratio is `min(1, 480 / max(width, height))`; foreground RGB and alpha retain full
resolution without CPU readback. Composition shares TensorFlow's WebGL2 context
and restores its state. Native alpha is not thresholded or softened using legacy
segmentation settings; those values remain stored but the UI explains they are
not applied. AI effects fail explicitly without WebGL2. Physical chroma retains
the Canvas2D fallback with a log warning; the AI model is never silently replaced.
GPU context loss during processing stops the camera rather than publishing
raw frames or silently switching backends.
The model is loaded lazily and reused across blur, color and image modes.
Reconfiguration or resolution changes reset temporal memory; during chroma
the model stays idle without inference, retaining compiled shaders.
Configuration and the first frame each have up to 60 seconds for initialization
and cold shader compilation, which can exceed 30 seconds on Metal.
The first frame at a new resolution also receives that compilation budget.
Subsequent frames retain an 8-second watchdog. No frames are published during
preparation, and cancelling capture does not wait for these deadlines.
CI tests use SwiftShader on Windows and Metal on macOS ARM, retaining real
inference without changing the application's graphics selection.
Turning effects off or ending capture releases the reader, tensors,
textures, context and worker. Resolution and frame cadence
follow the selected profile. The optional limiter, off by default, caps both at
1280 × 720 and 30 FPS without upscaling a smaller capture or duplicating frames
to compensate for capture or processing limitations.
`CameraPublication` coordinates replacements and failures with P2P/SFU
publishers; capture belongs to `VideoService`, not to the preview or producer.

The **private key is deliberately absent from that list**. It is what proves who
you are (see [Authentication](#authentication-the-server-never-sees-a-password-of-yours))
and it never reaches the renderer: it lives in `identity.json`, inside the
`userData` folder, encrypted with Electron's `safeStorage` — the operating
system's own vault. Where the system offers no encryption the file is written in
the clear, and the record itself says which of the two happened.

## The server

### The three ways to run it

The same server code goes up in three shapes, and the difference is not
technical — it is about who looks after it:

<div class="diagrama">

![The three ways to run it](../diagramas/en/05-as-tres-formas-de-rodar.claro.svg){.tema-claro}
![The three ways to run it](../diagramas/en/05-as-tres-formas-de-rodar.escuro.svg){.tema-escuro}

</div>

Hosting **from the app** is the two-click path, and that is why the client
imports `@monky/server` directly: no separate process, no admin port. The price
is that the server lives only as long as the app does.

The **CLI** exists for the opposite case — a server that should not depend on
somebody keeping a window open. It manages several servers on the same machine,
each with its own data folder and its own PM2 process.

### Layers

There is no dependency injection container: wiring is explicit, done by hand in
`MonkyServer.create()`. You can read the file and see exactly what depends on
what.

<div class="diagrama">

![Layers](../diagramas/en/06-camadas.claro.svg){.tema-claro}
![Layers](../diagramas/en/06-camadas.escuro.svg){.tema-escuro}

</div>

Beyond the WebSocket, the server exposes a few HTTP routes: `/health`, `/preview`
and `/invite-info` (public information for the invite screen), `/avatars/*` and
the `/attachments` upload/download.

The default port is **3000**.

### The protocol

Every message has the same shape:

```ts
{
  type: MessageType,     // 'CHAT_SEND', 'VOICE_JOIN', 'RTC_SIGNAL'…
  requestId?: string,    // echoed in the response, for correlation
  payload: T
}
```

The `requestId` is what lets the client know which response belongs to which
request — the WebSocket is asynchronous and responses do not necessarily arrive
in the order they were asked for.

Payload validation uses **zod**, with the schemas in `packages/shared` — the very
same ones the client uses to validate before sending.

::: warning Negotiated compatibility, never an unrestricted downgrade
Protocol 25 negotiates independent client and bot minimum versions, initially
**24**, plus feature flags in `AUTH_CONNECT`/`AUTH_SUCCESS`. Version 24 peers
retain their existing contract. Message blocks and message-limit settings are
only enabled when negotiated. New clients and SDKs may retry authentication
once using an old server's known version-24 contract. Versions below the floor
are rejected; future versions must explicitly advertise a compatible range.

Additive features need not raise the floor. Critical fixes or incompatible
changes must raise `MIN_CLIENT_PROTOCOL` and/or `MIN_BOT_PROTOCOL` in
`protocolCompatibility.ts`, update release metadata and test rejection before
publication. The CI major-version policy for `PROTOCOL_VERSION` changes remains
in effect.
:::

### Identity authentication {#authentication-the-server-never-sees-a-password-of-yours}

Login is challenge–response with public-key cryptography. You have no account and
no sign-up: your identity **is** your key pair.

<div class="diagrama">

![Challenge-and-signature authentication: the private key stays on the client; the optional entry password is sent to the server.](../diagramas/en/07-autenticacao-o-servidor-nunca-ve-uma-sen.claro.svg){.tema-claro}
![Challenge-and-signature authentication: the private key stays on the client; the optional entry password is sent to the server.](../diagramas/en/07-autenticacao-o-servidor-nunca-ve-uma-sen.escuro.svg){.tema-escuro}

</div>

The `clientId` is derived from the public key itself, so it cannot be forged:
without the private key you cannot sign the challenge.

The server password, when present, protects *entry* and is checked by the
server before the challenge. It differs from your local identity-backup
password. The private key and that backup password are not sent during login.

### Sessions: the same person on several devices

A session is identified by `userId:deviceId`, not just by the user. That is what
lets you be on the desktop and the laptop at once while appearing as a single
person.

- Reconnecting **from the same device** replaces the old connection (avoiding
  ghosts after a network drop).
- Connecting **from another device** creates a new session, up to a cap of **3
  simultaneous sessions** per identity.

The cap exists so a single identity cannot exhaust the server's resources
(connections, audio, bandwidth) by opening endless devices. It is independent
from `maxUsers`, which counts *registrations* — several sessions of the same
person still take a single seat.

### Database

SQLite, in a `server.db` file inside the server's data directory. Migrations are
numbered `.sql` files, applied at startup and recorded in a `schema_migrations`
table — the server only runs what it has not run yet.

| Table | Holds |
|---|---|
| `server_meta` | Server configuration: name, password, owner, limits, icon |
| `users` | Members, each with their public key |
| `channels` | Voice and text channels |
| `messages` | Chat history |
| `mentions` | Mentions, for highlighting and notifying |
| `message_attachments` | Message attachments |
| `roles` / `user_roles` | Roles and who holds each one |
| `schema_migrations` | Bookkeeping of applied migrations |

### Roles and permissions

Permissions are bits combined into a mask. Two roles are special:

- **Admin** — gets every permission and cannot be deleted.
- **Member** — the default role for anyone who joins.

The check is centralised in `PermissionService.checkPermission()`. The **server
owner** is a case apart: they get admin permissions regardless of which roles
they hold.

### Abuse protection

| Protection | How |
|---|---|
| Message flood | Sliding window: 10 messages every 5 s |
| Message size | 16,000 characters by default; configurable per server, `0` disables the character limit; WebSocket packets remain limited to 8 MiB |
| Avatar | 5 MB, and the file must carry a PNG, JPEG or WebP signature |
| Attachments | Per-file limit and a total server budget, both configurable |
| Soundboard | Audio refused above ~4 MB |
| Path traversal | File names go through `basename` and the final path is checked against the allowed folder |

Note the detail on avatars: validation looks at the file's **magic bytes**, not
its extension. Renaming an executable to `.png` does not fool the check.

## The media plane

Monky supports **two voice and media topologies**: default **P2P Mesh** and **SFU (Selective Forwarding Unit)** powered by `mediasoup`.

### Topology 1: Full Mesh (Default)

Each participant opens a direct connection to **every** other one.

<div class="diagrama">

![Topology: full mesh](../diagramas/en/08-topologia-mesh-completo.claro.svg){.tema-claro}
![Topology: full mesh](../diagramas/en/08-topologia-mesh-completo.escuro.svg){.tema-escuro}

</div>

With **N** participants, each person keeps **N−1** connections and the channel has **N(N−1)/2** in total. Whoever shares a screen sends the same video N−1 times, once per peer.

::: tip When to use P2P Mesh
Excellent for small friend groups and lightweight/free VPS instances with low CPU or bandwidth, since the server does not relay audio or video packets.
:::

### Topology 2: SFU (Selective Forwarding Unit)

For the browser engine's SFU call, the client opens a pair of **WebRTC Transports** with the host server:
- **`sendTransport`:** Transmits local audio and video tracks (microphone, camera, screen and system audio).
- **`recvTransport`:** Receives forwarded tracks from all other participants routed through the `mediasoup` worker.

The server identifies this pair with purpose `call`, also used when `purpose`
is omitted. Screen engines with their own connections can use a `screen` pair,
restricted to screen video and audio. Producers and consumers record their
`transportId`: rebuilding one purpose does not discard the other's resources.
Pending creations have the same scope: late worker results are closed after
cancellation, departure or channel switching, without registering abandoned
transports or affecting a replacement connection.
Voice connection health uses the `call` pair; `screen` health is queried
separately. This prepares native-engine isolation without changing the pair
currently used by the renderer.

Explicit `SFU_CLOSE_WEBRTC_TRANSPORT` selects a `screen` transport ID, not
the entire pair, and responds with `SFU_WEBRTC_TRANSPORT_CLOSED`.
`SFU_PRODUCER_SET_PAUSED` is also restricted to screen media owned by the
session. Producer and consumer pause/resume waits for the worker response
and checks that the resource still exists. Requests with a `requestId`
receive a correlated acknowledgement or error, including producer/consumer
closure; existing controls without a `requestId` still receive no extra
acknowledgement.

The broadcaster sends each stream **only once to the server**, rather than
one copy per recipient. Fewer outgoing copies alone do not guarantee resolution,
FPS or a specific CPU/GPU cost.

::: tip Resilience & Automatic Reconnection
If the SFU process encounters errors or unexpected downtime, clients show a notice and **rebuild the SFU session automatically**, backing off between attempts until the server is back.

There is no drop to P2P: a mesh where only the side that noticed the failure switches protocol never forms, because the other side keeps answering as an SFU client and discards the incoming offer. That would leave a silent call behind a reassuring notice — so the client reconnects instead of degrading.
:::

When an administrator explicitly switches from **SFU to P2P**, participants
are notified and the client tears down its previous transport before
automatically returning to its own channel. Re-entry uses a temporary,
one-use authorization tied to that session and channel, respecting current
permissions and limits. Leaving voluntarily, being removed, or starting
another call cancels the automatic return.

### Signaling

The server only delivers envelopes. It rewrites the sender (so nobody can forge an
identity) and refuses delivery if the two peers are not in the same voice channel.

<div class="diagrama">

![Signaling](../diagramas/en/09-sinalizacao.claro.svg){.tema-claro}
![Signaling](../diagramas/en/09-sinalizacao.escuro.svg){.tema-escuro}

</div>

### Getting through NAT

Almost nobody has a direct public IP, so peers need to work out how to reach each
other. Monky uses public **STUN servers** (Google and Cloudflare) so each side can
discover its own external address.

::: tip TURN is optional, and off by default
STUN only *discovers* the path; it does not relay anything. When the network is too
restrictive — symmetric NAT, corporate firewall, some carrier CGNATs — there is no
direct path and the media connection fails.

A **TURN** server solves it by relaying the media. But TURN carries video, and
costs bandwidth proportional to usage — which reintroduces exactly the cost the
P2P architecture avoids. That is why Monky's relay is **optional** and ships
off: whoever hosts decides whether to pay that bandwidth.

When enabled, the server runs a **coturn** alongside it and hands out the
credentials at login. ICE still prefers the direct route and only uses the relay
for the pairs that genuinely cannot connect. Details in
[Media relay (TURN)](/en/turn).
:::

When a connection drops or stalls, `WebRtcManager` first tries an **ICE restart**
(renegotiating the path without tearing down the call) and, failing that, rebuilds
the connection to that peer from scratch.

### Audio

<div class="diagrama">

![Audio](../diagramas/en/10-audio.claro.svg){.tema-claro}
![Audio](../diagramas/en/10-audio.escuro.svg){.tema-escuro}

</div>

Capture already requests built-in WebRTC echo cancellation and automatic gain. The
diagram shows the default **RNNoise** engine; **Speex** and **GTCRN** occupy the
same point in the graph. All three run in `AudioWorklet`, with WASM bundled by
the existing [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor)
dependency. Selecting one **disables** built-in suppression to avoid stacking
processors. **WebRTC (built-in)** suppression and no suppression are also available.

`AudioProcessor` prepares the next engine before replacing the internal
connection, preserving the destination track sent through P2P or SFU. Local
preview shares the processed call stream when possible; when it needs its own
capture, it applies the same engine without connecting to speakers or WebRTC.

Outputs resolve general and per-category preferences. Voice and screen audio
have separate `AudioContext`s across the entire 0–200% volume range.
Chromium shares a native renderer between WebRTC tracks: audio elements stay
active at zero volume for decoding, and only the category graphs produce sound.
The shared native output follows voice to align the echo-cancellation reference;
it is never redirected to the chosen screen output. Native chat players,
including the expanded viewer, apply the media output before starting playback.

Mute and deafen disable the track (`enabled = false`) instead of removing it. That
way there is no need to renegotiate the connection on every click of the mute
button.

### Video and screen sharing

The camera follows the resolution and FPS of the selected quality profile.

Screen sharing is a track **separate** from the camera — you can transmit both at
once. The source is announced in the call without requiring reception of its
media. In P2P, negotiation and `screen-video-meta` associate the track with
the correct screen, separately from the camera.

You can share **up to 2 screens at once**. Each is identified by the id of its own
`MediaStream`, and that id is what ties together the track, the sender and the
tile on screen.

**Discovery is not subscription.** Viewing intent belongs to the call rather
than a view's lifetime. `Watch broadcast` authorizes delivery of that source
to the recipient; `Stop watching` revokes it. The choice follows the same
source through view and transport reconstruction, but a new broadcast does
not inherit it merely because it has the same owner.

In P2P, a `screen-watch` type `RTC_SIGNAL` sends intent to the publisher. On the Chromium path,
Screen senders have no attached track/active encoding until subscribed;
stopping affects only that peer. Publisher/viewer epochs and an increasing
revision protect against old commands and negotiations. The server authenticates
the sender and checks the channel and published source.

In SFU, the catalog remains available without automatically creating screen
consumers. Screen/audio consumers start paused **on the server** and are
resumed only after setup finishes and is still valid. Stopping closes the
remote and local consumer; pausing a client track alone would not stop bandwidth
usage. Late responses must not reactivate a cancelled subscription.

Screen audio is shared per publisher/recipient: it continues while that
recipient watches at least one screen from that publisher. Microphone, camera,
other viewers and mute preferences are independent. On the native path, the
last subscription to a profile closes its capture, encoder and sending
pipeline, including publisher-to-SFU upload. The Chromium path retains
capture/preview and may keep uploading to the SFU. RTCP and
signaling remain allowed; this does not promise zero bytes in the call.
The contracts require client and server to share the same `PROTOCOL_VERSION`.

Monky also tags the track with a content hint: `motion` favours smoothness (good
for games and video), `detail` favours sharpness (good for code and text).

### Screen audio: the native module

The browser does not hand over system sound together with the screen image. That
is why Monky has a native C++ module:

| Platform | How |
|---|---|
| **Windows** | WASAPI *process loopback* — captures system sound or a specific app's, excluding Monky itself so it does not echo |
| **macOS** | ScreenCaptureKit (macOS 13+), with a window filter so audio from apps you are not sharing does not leak |
| **Others** | Not supported — the app keeps working, just without screen audio |

If the module fails to load, nothing breaks: sharing keeps working without sound
and the app says so.

### Quality and bandwidth

Profiles control resolution, FPS and the bitrate ceiling. Chromium sending
parameters use `RTCRtpSender.setParameters()`; native profiles configure
the actual capture/encoder/transport pipeline:

| Profile | Audio | Camera | Screen |
|---|---|---|---|
| **Economic** | 24 kbps | 640×360 @ 24fps · 250 kbps | 854×480 @ 15fps · 900 kbps |
| **Normal** | 32 kbps | 854×480 @ 30fps · 450 kbps | 1280×720 @ 30fps · 2000 kbps |
| **High Quality** | 48 kbps | 1280×720 @ 30fps · 600 kbps | 1920×1080 @ 30fps · 3500 kbps |
| **Gaming Mode** | 28 kbps | 640×360 @ 20fps · 300 kbps | 1920×1080 @ 60fps · 6000 kbps |

**Gaming Mode** is the most telling one: it *reduces* the camera to spend
everything on the screen at 60fps. And only there does the degradation preference
become `maintain-framerate` — under tight bandwidth Monky sacrifices resolution to
hold 60fps, because in a game smoothness matters more than sharpness. In the other
profiles it is the opposite on the Chromium path. The native path requests
the chosen real profile and does not hide degradation behind an FPS setting.

The Custom profile can request up to 1080p120 on the native path.
Viewers can request Source, 1080p60, 720p60 or 480p30 (852×480); different
profiles allocate separate pipelines rather than merely resizing the player.

Remember these numbers are **per peer**. Sharing a screen in High Quality to 4
people asks for roughly 14 Mbps of uplink.

### Telemetry

During transmission, telemetry distinguishes configuration, sending,
decoding and presentation. RTP statistics use deltas from each report's own
timestamp; Media Foundation counters use the worker's observation clock,
not the time JavaScript reads a cached snapshot. Unavailable metrics stay
unavailable rather than becoming zero. External H.264 transport does not
pretend to measure AMF encoding time as if it were an internal WebRTC encoder.

## Reconnection

When the WebSocket drops, the client tries to come back on its own with growing
waits (1s, 2s, 3s, 5s — the last one repeats). The server keeps the session alive
for **20 seconds** before announcing the departure, so a quick Wi-Fi hiccup does
not throw anyone off the list.

<div class="diagrama">

![Reconnection](../diagramas/en/11-reconexao.claro.svg){.tema-claro}
![Reconnection](../diagramas/en/11-reconexao.escuro.svg){.tema-escuro}

</div>

Notice the least intuitive step: on the way back the client **tears down every
P2P connection and starts over**, including the ones that looked alive. It sounds
drastic, but it is the most reliable path — while the WebSocket was away other
people may have joined, left or switched channels, and there is no way to know
which of the old peers still hold. Rebuilding from the new state is cheaper than
finding out, peer by peer, who is left.

If the 20 seconds run out before the client is back, the session is closed and
the departure is announced normally — the reconnection becomes a fresh join.

## Where everything lives

```
apps/
  client/
    native/screen-audio/     C++ screen-audio module (Windows/macOS)
    native/screen-share/     libobs capture, native RTC, contracts, build and licenses
    src/main/                main process: window, tray, updater, IPC
    src/preload/             the window.api bridge
    src/renderer/
      core/                  services: network, WebRTC, audio, video
      stores/                state + events
      views/                 the screens
      i18n/                  PT/EN translations
  server/
    src/application/         business rules (services)
    src/infrastructure/      WebSocket, database, security, logs
    src/cli/                 the Monky CLI
packages/
  shared/                    protocol, validators, limits, profiles
```

## Known limits

Things that follow directly from the architecture, and are not bugs:

- **Mesh does not scale.** Great for a handful of friends, bad for dozens. Larger
  groups switch to [SFU mode](#topology-2-sfu-selective-forwarding-unit), paying
  with host bandwidth and CPU for what each participant's connection saves.
- **TURN is off by default.** Very restrictive networks can prevent the media
  connection even when the server is reachable. An optional relay exists, but it
  costs the host bandwidth and only runs on Linux.
- **The protocol requires an exact match.** Client and server need the same
  `PROTOCOL_VERSION`; updating only one side breaks the connection.
- **Screen audio only on Windows and macOS**, because it depends on each system's
  native API.
- **Native publishing is qualified for Windows x64, windows and AMD/AMF H.264.**
  Other paths retain Chromium. Windows loopback does not replace external
  network QA, other GPU vendors or physical macOS testing.

## Learn more

- [Monky CLI](/en/cli) — command-line administration
- [Host on a VPS](/en/hospedar-em-vps) — putting a server online
- [Features](/en/recursos) — what the app does, from a user's point of view
- [CONTRIBUTING.en.md](https://github.com/MonkyOrg/Monky/blob/main/CONTRIBUTING.en.md) — how to contribute code
