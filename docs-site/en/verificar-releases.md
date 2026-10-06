# Verify Releases

The official pipeline publishes a list of SHA-256 hashes signed with
[Sigstore Cosign](https://docs.sigstore.dev/) (keyless, through GitHub Actions
OIDC). These are two different checks: the **signature** identifies who
published the list; the **hash** checks the file you downloaded.

## 1. Download files from the same release

On the [official releases page](https://github.com/MonkyOrg/Monky/releases),
download the installer, portable application or package you need and these
three files:

- `checksums-sha256.txt`
- `checksums-sha256.txt.sig`
- `checksums-sha256.txt.crt`

Keep them in the same folder. Do not mix files from different releases,
even if their names look similar.

## 2. Check the list's signature

[Install Cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
and open a terminal in that folder. This command works in PowerShell,
Bash and Zsh:

```text
cosign verify-blob --signature checksums-sha256.txt.sig --certificate checksums-sha256.txt.crt --certificate-identity "https://github.com/MonkyOrg/Monky/.github/workflows/release.yml@refs/heads/main" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" checksums-sha256.txt
```

Continue only if the process succeeds and prints **`Verified OK`**. The
identity is this repository's exact workflow, not just a generic URL prefix.

::: info Signature format
These releases use separate `.sig` and `.crt` files. Recent Cosign versions
may warn that these options are deprecated; that warning is not a successful
verification. Do not use options that bypass the transparency log,
certificate or its identity.
:::

## 3. Check the downloaded file

The names below are real examples from release `v22.1.0`. Replace them with
the exact filename from your chosen release; the tag's `v` is not part of
the installer filename.

### Windows — PowerShell

```powershell
$file = 'Monky-22.1.0-win-x64-portable.exe'
$lines = @(Get-Content .\checksums-sha256.txt | Where-Object {
  $_ -match "^[a-fA-F0-9]{64}\s+\*?(?:\./)?$([regex]::Escape($file))$"
})
if ($lines.Count -ne 1) { throw 'File is missing or duplicated in the checksum list.' }
$expected = ($lines[0] -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw 'Hash mismatch: do not install this file.' }
'SHA-256 matches.'
```

### macOS — Terminal

```bash
shasum -a 256 Monky-22.1.0-mac-arm64.dmg
```

Compare the 64-character result with the line for **that exact file** in
`checksums-sha256.txt`. For an Intel Mac, use the `mac-x64` file.

### Linux — Terminal

To verify the artifacts present in this folder without downloading all
the others:

```bash
sha256sum --check --ignore-missing checksums-sha256.txt
```

The file you intend to use must appear with **`OK`**. No verified files or
any mismatch means the check did not complete successfully.

::: warning If any step fails
Do not install the file. Check the version, filename and source, download it
again and investigate the failure. A hash matching an **unauthenticated**
list only proves consistency with that list; by itself it does not prove
where the program came from.
:::
