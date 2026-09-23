#!/usr/bin/env bash
set -eo pipefail

locale="${LC_ALL:-${LC_MESSAGES:-${LANG:-pt_BR}}}"
bootstrap=''
checksum=''
forward=()
say() {
  case "$locale" in en*|EN*) printf '%s\n' "$2" ;; *) printf '%s\n' "$1" ;; esac
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bootstrap-file|--bootstrap-sha256)
      if [ "$#" -lt 2 ]; then say 'Argumento do bootstrap ausente.' 'Missing bootstrap argument.' >&2; exit 1; fi
      if [ "$1" = '--bootstrap-file' ]; then bootstrap="$2"; else checksum="$2"; fi
      shift 2
      ;;
    --locale)
      if [ "$#" -lt 2 ]; then say 'Informe pt-BR ou en-US.' 'Specify pt-BR or en-US.' >&2; exit 1; fi
      locale="$2"
      forward+=("$1" "$2")
      shift 2
      ;;
    *) forward+=("$1"); shift ;;
  esac
done
if ! command -v node >/dev/null 2>&1; then
  say 'Instale Node.js 22 ou superior com npm: https://nodejs.org/' 'Install Node.js 22 or newer with npm: https://nodejs.org/' >&2
  exit 1
fi
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
  say 'Este instalador exige Node.js 22 ou superior.' 'This installer requires Node.js 22 or newer.' >&2
  exit 1
fi
temporary=''
cleanup() {
  if [ -n "$temporary" ]; then
    rm -f -- "$temporary/installer.cjs" "$temporary/installer.sha256"
    rmdir -- "$temporary"
  fi
}
trap cleanup EXIT
if [ -z "$bootstrap" ]; then
  if [ -n "$checksum" ]; then printf '%s\n' '--bootstrap-sha256 requires --bootstrap-file.' >&2; exit 1; fi
  if ! command -v curl >/dev/null 2>&1; then
    say 'Instale curl antes de continuar.' 'Install curl before continuing.' >&2
    exit 1
  fi
  temporary="$(mktemp -d "${TMPDIR:-/tmp}/monky-sdk-bootstrap.XXXXXXXX")"
  bootstrap="$temporary/installer.cjs"
  base='https://monkyorg.github.io/Monky/install-bot-sdk.cjs'
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 "$base" -o "$bootstrap"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 "$base.sha256" -o "$temporary/installer.sha256"
  checksum="$(tr -d '\r\n' < "$temporary/installer.sha256")"
fi
if ! node -e '
  const fs = require("node:fs"), crypto = require("node:crypto");
  const [file, expected] = process.argv.slice(1);
  if (!/^[a-f0-9]{64}$/i.test(expected) ||
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected.toLowerCase()) process.exit(1);
' "$bootstrap" "$checksum"; then
  say 'SHA-256 do instalador incorreto. Nada foi executado.' 'Installer SHA-256 mismatch. Nothing was executed.' >&2
  exit 1
fi
node "$bootstrap" "${forward[@]}"
