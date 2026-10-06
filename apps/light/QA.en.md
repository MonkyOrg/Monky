# Monky Light: manual QA plan

[Português](QA.md)

This plan covers what automated tests cannot replace: people listening, physical
devices, real networks, and resource comparison with the full Monky client.
Record results in the Light continuity issue, keeping **build**, **synthetic
audio**, **real hardware**, and **human use** separate.

## Safety rules

- Always use a **disposable server from the same branch** and protocol; never a
  production server to work around incompatibility.
- Each participant uses a dedicated profile: an absolute `--profile` for Light and
  `--user-data-dir` for the development client. Never point them at the installed
  Monky profiles.
- Do not close the installed version to test; stop only processes the test started.

## Preparation

1. `npm ci`, `npm run build:light`, and `npm run build --workspace=apps/server`.
2. Start the disposable server with its own `MONKY_HOME` and port.
3. Record for each round: commit, operating system and version, CPU, audio
   devices, network (LAN, internet, NAT), and topology (P2P or SFU).

## 1. Audible calls between people

Participants: at least one person on Light and one on the full Monky client;
repeat with three or more people. Run everything in **both P2P and SFU**.

| # | Step | Expected | P2P | SFU |
|---|---|---|---|---|
| 1.1 | Light and the full client join the same channel | Both hear each other clearly, with no noticeable echo | | |
| 1.2 | A third participant joins | Everyone hears everyone | | |
| 1.3 | Light uses `mute`, then undoes it | Others stop and resume hearing it; Light keeps hearing | | |
| 1.4 | Light uses `deafen`, then undoes it | Light stops hearing and sending; both resume when undone | | |
| 1.5 | A moderator applies server mute and deafen to Light | Light honors the restriction even when undoing locally | | |
| 1.6 | Light switches rooms | Leaves the previous room (no ghost participant) and hears the new one | | |
| 1.7 | `reconnect` on Light during a call | Returns to the same room and audio resumes | | |
| 1.8 | A moderator kicks Light from the call | Light leaves and does not rejoin by itself after `reconnect` | | |
| 1.9 | An administrator switches P2P ↔ SFU during the call | The call continues both ways, preserving moderation | | |
| 1.10 | A call of at least 30 minutes | No dropouts, growing delay, or robotic audio | | |

## 2. Physical devices

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | `npm run test:light:hardware` | Passes with the physical microphone | |
| 2.2 | USB or Bluetooth headset as input and output | Audio goes in and out through the headset | |
| 2.3 | Change the system default device during a call | Behavior documented in the README; the call does not drop | |
| 2.4 | Disconnect and reconnect the headset during a call | The call does not drop; audio returns on reconnection | |
| 2.5 | Microphone blocked in privacy settings | Explicit error; Light keeps receiving audio | |

## 3. Real networks

| # | Scenario | Expected | P2P | SFU |
|---|---|---|---|---|
| 3.1 | Same LAN | Audio both ways | | |
| 3.2 | Participants on different networks over the internet | Audio both ways | | |
| 3.3 | One participant behind restrictive NAT (e.g. 4G) | Connects via TURN when needed | | |
| 3.4 | Forced TURN (host/srflx candidates blocked) | Connects through relay only | | |
| 3.5 | 5% and 15% packet loss and 150 ms latency (e.g. clumsy on Windows) | Intelligible audio; recovers when the network normalizes | | |
| 3.6 | 10 s and 60 s network outage | Reconnects and returns to the room without intervention | | |

## 4. Resource use: Light × full Monky client

Same computer, server, channel, topology, participants, devices, and audio
policy. Measure **one edition at a time**, with the other closed, each phase for
at least 5 minutes, with the full client window minimized and then visible.

```powershell
npm run measure:client -- --name monky-light --label light-sfu --seconds 300 --output measurements.jsonl
npm run measure:client -- --name Monky --label full-sfu --seconds 300 --output measurements.jsonl
```

| Phase | Light CPU (1 core) | Light RAM (MiB) | Full CPU (1 core) | Full RAM (MiB) |
|---|---|---|---|---|
| Connected without a call | | | | |
| P2P call (2 people) | | | | |
| SFU call (3 people) | | | | |
| Deafened | | | | |
| After leaving the call | | | | |

Also record `peakIntervalOneCoreCpuPercent`, `peakWorkingSetMiB`, the process
count and, for long-running use, `npm run measure:light` with
`MONKY_LIGHT_MEASURE_SECONDS=60` and `MONKY_LIGHT_MEASURE_CYCLES=20`.

## 5. macOS (real hardware)

Run on Intel and Apple Silicon and, if possible, on macOS 12.

| # | Step | Expected | Intel | Apple Silicon |
|---|---|---|---|---|
| 5.1 | `npm run build:light` and the `test:light:*` scenarios | Pass | | |
| 5.2 | Microphone permission granted, denied, and pending | Requested only when sending; denial keeps mute and receiving | | |
| 5.3 | Join already muted | No permission request until unmuting | | |
| 5.4 | Locked Keychain | Explicit error, without generating another identity | | |
| 5.5 | Reopen the same profile | Same identity (same user on the server) | | |
| 5.6 | Rebuild and reopen the same profile | Identity preserved or explicit recovery | | |
| 5.7 | `ws://` on the LAN and `wss://` with a valid certificate | Connect | | |
| 5.8 | `wss://` with an untrusted certificate | Refused | | |
| 5.9 | Audible call with the full client (section 1) | Same as Windows | | |
