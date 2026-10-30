# Device-free PCM capture contracts

`capture_double.cpp` implements the existing `MONKY_PACKET_CAPTURE_TEST` hooks and
replaces only acquisition. It links production `packet_capture.cpp` and
`wasapi_format.cpp`, **not** `wasapi_capture.cpp`, audio devices, Electron, or the
RTC SDK. The suite preserves the original cleanup/Node-20 ordering controls and
adds bounded admission, producer-refill, cancellation and downstream-credit
regressions. It does not validate physical game capture.

## Admission contract

A packet callback may return a `Promise<void>` while retaining its capture
delivery credit. A synchronous callback releases that credit upon return.
The shared hub waits for every active subscriber's admission; detaching one
subscriber cancels only that subscriber's delivery wait.

Admission means the original packet was copied into the native RTC input, **not**
that native processing retired. The bridge still owns the processing identity
until a matching receipt or proven complete engine closure. The 32 capture slots
and eight RTC processing slots are unchanged. A full capture budget waits up to
500 ms outside the TSFN mutex. The default `overflowMode: 'fail'` still reports
`ERR_AUDIO_OVERFLOW` on sustained overload. Screen sharing explicitly selects
`overflowMode: 'discontinue'`: after the same wait, only the packet without a
delivery credit is discarded. The next admitted packet belongs to a new native
epoch and is preceded by an explicit `discontinuity` diagnostic with dropped
packet/frame counts. Existing packets and processing receipts are never revoked.
Stop/Worker teardown wake the producer and cancel delivery waits without waiting
for downstream RTC closure. Original PCM, acquired sample/packet indices, QPC
and WASAPI flags are never rewritten. Device errors remain terminal.

## Capture threads and the libuv threadpool

Each session's capture thread signals its own `uv_async_t` as its last action;
the loop then joins the already-returning thread and finishes the session in the
handle's close callback. No session holds a libuv threadpool thread while it
captures, so file, DNS, crypto and zlib work in the same process keep running
with all eight sessions live, on the main thread or in a Worker. The regression
test runs that case with `UV_THREADPOOL_SIZE=4`.

## Build and run on Windows x64

CI runs this suite in the Windows packaging job, and `npm run ci:local` runs it on Windows.
From the repository root:

```powershell
npm run test:packet-capture --workspace=apps/client
```

`buildPacketTests.cjs` compiles the double (production `packet_capture.cpp` and
`wasapi_format.cpp`, never `wasapi_capture.cpp`) and `core_controls.exe` into
`apps\client\native\screen-audio\build\packet-tests`, using the MSVC already on `PATH`
(a Developer prompt or CI) or the Visual Studio Build Tools found by `vswhere`. It builds
against the headers and import library of the Node that runs it, from the `node-gyp` cache
(downloaded only when missing; `MONKY_PCM_TEST_NODE` overrides the folder), with the installed
client `node-addon-api`, and writes `build-report.json`. No SDK rebuild or production-addon
write is needed. Without that build the suite fails instead of skipping.

For a second existing Node runtime, set `MONKY_PACKET_CAPTURE_TEST_DIR` to a separate
absolute directory and run both `buildPacketTests.cjs` and the suite with that runtime
(`<node> apps\client\native\screen-audio\test\buildPacketTests.cjs`, then
`<node> --test --test-concurrency=1 apps\client\native\screen-audio\test\packetCapture.test.cjs`). `core_controls.exe` is
independent of Node. Never run the Node-24-only post-finalizer ownership scenario
on Node 20; the suite selects it only on the verified runtime.

## Actual macOS packet acquisition

The shared Node-API lifecycle lives in `src/packet_capture.cpp`; acquisition is
provided by `src/mac/packet_source.mm` on macOS. Original timestamps are exposed
as `captureTimestampUs` with `captureClock: 'mach-host-us'`; `qpcTimestampUs` is
null on macOS. A selected window captures the entire application's audio, with
PID/process-birth checks and an independent window-loss watchdog.

With the production addon built and Screen Recording permission granted:

```sh
npm exec --no -- node-gyp rebuild --directory=apps/client/native/screen-audio
node apps/client/native/screen-audio/test/macPacketAudioSmoke.cjs --artifacts="$PWD/.qa/mac-packet-audio"
```

This creates an owned AppKit/AVAudioEngine application with synthetic stereo
tones; it never acquires a microphone or another application's audio. It checks
timestamps, channel separation, a second concurrent packet session, cancellation,
repeated start/stop, selected-window loss and application exit with active capture.
The fixture requires Electron/AppKit; bare Node capture fails explicitly.
Production capture shutdown does not depend on Main-thread UI dispatch.
The device-free check `node --test apps/client/native/screen-audio/test/macAudioRuntime.test.cjs`
loads the compiled production addon, verifies that bare Node is rejected with
`ERR_AUDIO_RUNTIME`, and waits for native worker retirement. CI builds and runs
this check separately on Apple Silicon and Intel runners.

## Electron fixture

The Electron fixture is separate from the production addon. Compile the same
acquisition-double sources against the cached Electron headers/import library,
also linking `node_modules\node-gyp\src\win_delay_load_hook.cc` with
`HOST_BINARY="node.exe"`, `/DELAYLOAD:node.exe` and `delayimp.lib`. Use
`build\packet-tests-electron44`, preserve the Node-independent `core_controls`
executable, and record the actual embedded Node version in `build-report.json`.
Do not relabel a standalone-Node binary or link `wasapi_capture.cpp` into the double.

After that build, this command waits for the real Electron test process rather
than leaving a Windows GUI executable running after PowerShell returns:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:MONKY_PACKET_CAPTURE_TEST_DIR = (Resolve-Path 'apps\client\native\screen-audio\build\packet-tests-electron44').Path
node -e 'const {spawnSync}=require("node:child_process"); const r=spawnSync(".\\node_modules\\electron\\dist\\electron.exe", ["--test","--test-concurrency=1",".\\apps\\client\\native\\screen-audio\\test\\packetCapture.test.cjs"], {stdio:"inherit",windowsHide:true,timeout:120000}); if(r.error)throw r.error; process.exit(r.status??1);'
```

Electron 44.4.3 embeds Node 24.21.0. The deliberately Node-24.19-only
post-finalizer control remains skipped; the real pending-packet cleanup,
admission-credit GC and worker-cleanup controls still run. None of these tests
proves physical WASAPI, game capture or GPU compatibility.
