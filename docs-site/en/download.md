---
title: Download
---

# Download

The buttons below point straight at the files from the latest release — no need to hunt for anything on GitHub.

<DownloadPanel lang="en" />

## Which file to pick

| System | File | Note |
|---|---|---|
| Windows 10/11 (x64) | `Monky-<version>-win-x64-setup.exe` | Installer — lets you pick the folder |
| Windows 10/11 (x64) | `Monky-<version>-win-x64-portable.exe` | Installs nothing, just run it |
| macOS (Intel / Apple Silicon) | `Monky-<version>-mac-<arch>.dmg` | Pick `x64` (Intel) or `arm64` (M1/M2/M3+) |

## After downloading

Windows and macOS can warn because the app does not yet have a distribution
signature recognized by those systems. A warning alone proves neither
corruption nor safety.

Before allowing execution, confirm the official source and
[verify the release](/en/verificar-releases). After checking the file:

- **Windows**: when SmartScreen offers it, use _More info › Run anyway_.
- **macOS**: try the app's context-menu Open action and consult **Privacy & Security** in System Settings. Options vary with the macOS version.

### macOS: "The application is damaged and can't be opened"

This message can result from Gatekeeper quarantine and missing notarization.
Do not rule out an incomplete or modified download: check the original
`.dmg` checksum before changing system protections.

After verifying the source, moving **Monky.app** to *Applications* and deciding
to authorize that copy, remove only this app's quarantine:

```bash
xattr -dr com.apple.quarantine /Applications/Monky.app
```

Try opening it again. If still blocked, keep the error message and check
system compatibility. Do not disable Gatekeeper globally or remove protections
from other folders to troubleshoot.

## Updates

The app tells you when a new version is out. You can also check under **Settings › About and Updates › Check for updates**.

On Windows the update applies itself: Monky downloads it, installs it and reopens.

On macOS the system will not replace an app that is running, so Monky downloads the `.dmg`, opens the install window and then **closes itself**. Drag Monky into your *Applications* folder, confirm the replacement and open the app again.

To confirm the file you downloaded is the one we published, see [Verify Releases](/en/verificar-releases) — every release ships SHA-256 checksums and a Cosign signature.

## About the beta channel

Betas ship ahead of the stable release so you can try what is coming next. They go through the same build and signing pipeline, but may carry problems that have not surfaced yet. If you just want to use Monky, stay on stable.

You can receive betas through the app itself, without downloading anything by hand, under **Settings › About and Updates**.

## About the CLI

The CLI is for hosting a server without a graphical interface, such as on a VPS. The full command reference is in [Monky CLI](/en/cli), and the hosting guide is in [Host on a VPS](/en/hospedar-em-vps).
