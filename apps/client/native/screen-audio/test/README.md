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
500 ms outside the TSFN mutex; sustained overload still reports
`ERR_AUDIO_OVERFLOW`. Stop/Worker teardown wake the producer and cancel delivery
waits without waiting for downstream RTC closure. Original PCM, sample indices,
QPC, flags and capture epochs are never rewritten.

## Build and run on Windows x64

Run from the repository root with the existing Visual Studio 2022 Build Tools,
Node headers/import library in the `node-gyp` cache, and installed client
`node-addon-api`. No download, SDK rebuild or production-addon write is needed.
Use a separate checkout when an installed/development build is in use.

```powershell
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$out = 'apps\client\native\screen-audio\build\packet-tests'
New-Item -ItemType Directory -Force "$out\capture_double\obj", "$out\core_controls\obj" | Out-Null
$env:MONKY_PCM_TEST_NODE = Join-Path $env:LOCALAPPDATA "node-gyp\Cache\$(node -p 'process.versions.node')"

& $env:ComSpec /d /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul && cl /nologo /EHsc /std:c++17 /MD /O1 /DNAPI_DISABLE_CPP_EXCEPTIONS /DNAPI_VERSION=8 /D_HAS_EXCEPTIONS=1 /DNOMINMAX /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DMONKY_PACKET_CAPTURE_TEST /I"%MONKY_PCM_TEST_NODE%\include\node" /I"apps\client\node_modules\node-addon-api" /LD "apps\client\native\screen-audio\test\capture_double.cpp" "apps\client\native\screen-audio\src\win\packet_capture.cpp" "apps\client\native\screen-audio\src\win\wasapi_format.cpp" /Fo"apps\client\native\screen-audio\build\packet-tests\capture_double\obj\\" /Fe"apps\client\native\screen-audio\build\packet-tests\capture_double\capture_double.node" /link /INCREMENTAL:NO "%MONKY_PCM_TEST_NODE%\x64\node.lib" ksuser.lib'
if ($LASTEXITCODE -ne 0) { throw 'Packet capture test build failed.' }

& $env:ComSpec /d /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul && cl /nologo /EHsc /std:c++17 /MD /O1 /DNOMINMAX /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 "apps\client\native\screen-audio\test\core_controls.cpp" "apps\client\native\screen-audio\src\win\wasapi_format.cpp" /Fo"apps\client\native\screen-audio\build\packet-tests\core_controls\obj\\" /Fe"apps\client\native\screen-audio\build\packet-tests\core_controls\core_controls.exe" /link /INCREMENTAL:NO ksuser.lib'
if ($LASTEXITCODE -ne 0) { throw 'PCM core test build failed.' }

@{
  nodeVersion = (node -p 'process.versions.node')
  hardwareUsed = $false
  functionalAddonLoaded = $false
  productionAddonUnchanged = $true
} | ConvertTo-Json | Set-Content "$out\build-report.json"

node --test --test-concurrency=1 apps\client\native\screen-audio\test\packetCapture.test.cjs
node --test --test-concurrency=1 apps\client\native\screen-share\test\nativePcmCaptureBridge.test.cjs apps\client\native\screen-share\test\nativePcmCaptureHub.test.cjs
```

For a second existing Node runtime, build against its matching headers/library
into a separate directory, set `MONKY_PACKET_CAPTURE_TEST_DIR` to that absolute
directory, and run the same suite using that runtime. `core_controls.exe` is
independent of Node. Never run the Node-24-only post-finalizer ownership scenario
on Node 20; the suite selects it only on the verified runtime.

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
