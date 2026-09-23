$ErrorActionPreference = 'Stop'
$forward = [System.Collections.Generic.List[string]]::new()
$bootstrap = $null
$bootstrapHash = $null
$locale = [System.Globalization.CultureInfo]::CurrentCulture.Name
for ($i = 0; $i -lt $args.Count; $i++) {
    $argument = [string]$args[$i]
    if ($argument -eq '--bootstrap-file' -or $argument -eq '--bootstrap-sha256') {
        if ($i + 1 -ge $args.Count) { throw 'Missing bootstrap argument / Argumento do bootstrap ausente.' }
        $i++
        if ($argument -eq '--bootstrap-file') { $bootstrap = [string]$args[$i] }
        else { $bootstrapHash = [string]$args[$i] }
    } else {
        $forward.Add($argument)
        if ($argument -eq '--locale' -and $i + 1 -lt $args.Count) { $locale = [string]$args[$i + 1] }
    }
}
function Installer-Text([string]$Portuguese, [string]$English) {
    if ($locale -match '^en([_-]|$)') { return $English }
    return $Portuguese
}
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) {
    throw (Installer-Text 'Instale Node.js 22 ou superior com npm: https://nodejs.org/' 'Install Node.js 22 or newer with npm: https://nodejs.org/')
}
& $node.Source -e 'if (Number.parseInt(process.versions.node, 10) < 22) process.exit(1)'
if ($LASTEXITCODE -ne 0) {
    throw (Installer-Text 'Este instalador exige Node.js 22 ou superior.' 'This installer requires Node.js 22 or newer.')
}
$temporary = $null
try {
    if (-not $bootstrap) {
        if ($bootstrapHash) { throw '--bootstrap-sha256 requires --bootstrap-file.' }
        $temporary = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('monky-sdk-bootstrap-' + [guid]::NewGuid().ToString('N')))
        $null = [System.IO.Directory]::CreateDirectory($temporary)
        $bootstrap = [System.IO.Path]::Combine($temporary, 'installer.cjs')
        $checksum = [System.IO.Path]::Combine($temporary, 'installer.sha256')
        $base = 'https://monkyorg.github.io/Monky/install-bot-sdk.cjs'
        $client = [System.Net.WebClient]::new()
        $previousTls = [System.Net.ServicePointManager]::SecurityProtocol
        try {
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
            $client.DownloadFile($base, $bootstrap)
            $client.DownloadFile(($base + '.sha256'), $checksum)
        } finally {
            $client.Dispose()
            [System.Net.ServicePointManager]::SecurityProtocol = $previousTls
        }
        $bootstrapHash = [System.IO.File]::ReadAllText($checksum).Trim()
    }
    if ($bootstrapHash -notmatch '^[a-fA-F0-9]{64}$') {
        throw (Installer-Text 'SHA-256 do instalador incorreto. Nada foi executado.' 'Installer SHA-256 mismatch. Nothing was executed.')
    }
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead([System.IO.Path]::GetFullPath($bootstrap))
    try { $actualHash = [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $algorithm.Dispose() }
    if ($actualHash -ine $bootstrapHash) {
        throw (Installer-Text 'SHA-256 do instalador incorreto. Nada foi executado.' 'Installer SHA-256 mismatch. Nothing was executed.')
    }
    & $node.Source $bootstrap @forward
    if ($LASTEXITCODE -ne 0) {
        throw (Installer-Text 'A instalacao falhou; confira o erro acima.' 'Installation failed; check the error above.')
    }
} finally {
    if ($temporary) {
        foreach ($name in @('installer.cjs', 'installer.sha256')) {
            $file = [System.IO.Path]::Combine($temporary, $name)
            if ([System.IO.File]::Exists($file)) { [System.IO.File]::Delete($file) }
        }
        [System.IO.Directory]::Delete($temporary)
    }
}
