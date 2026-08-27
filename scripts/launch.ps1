param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function New-AccessSecret {
    $bytes = New-Object byte[] 24
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Ensure-EnvironmentFile {
    $environmentPath = Join-Path $projectRoot '.env'
    $content = if (Test-Path -LiteralPath $environmentPath) {
        @(Get-Content -LiteralPath $environmentPath)
    } else {
        @()
    }

    function Read-ManagedValue([string]$Name, [string]$Fallback) {
        $line = $content | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
        if ($line) { return ($line -split '=', 2)[1] }
        return $Fallback
    }

    $password = Read-ManagedValue 'CODEX_PWA_PASSWORD' (New-AccessSecret)
    $port = Read-ManagedValue 'CODEX_PWA_PORT' '8787'
    $lanName = Read-ManagedValue 'CODEX_PWA_LAN_NAME' 'opencodexlink'
    $unmanaged = @($content | Where-Object { $_ -notmatch '^CODEX_PWA_(PASSWORD|HOST|PORT|LAN_NAME)=' })

    @(
        $unmanaged
        "CODEX_PWA_PASSWORD=$password"
        'CODEX_PWA_HOST=0.0.0.0'
        "CODEX_PWA_PORT=$port"
        "CODEX_PWA_LAN_NAME=$lanName"
    ) | Set-Content -LiteralPath $environmentPath -Encoding ascii
}

function Test-Bridge {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2
        return $health.ok -eq $true
    } catch {
        return $false
    }
}

Ensure-EnvironmentFile

$bundledNode = Join-Path $projectRoot 'runtime\node.exe'
$nodeExecutable = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$rebuilt = $false

if (Test-Path -LiteralPath (Join-Path $projectRoot 'src')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { npm.cmd install }
    npm.cmd run build
    $rebuilt = $true
}

# A healthy listener may still be an older build. Development/source launches
# must replace it after rebuilding so phones never stay connected to stale code.
if ($rebuilt -and (Test-Bridge)) {
    & (Join-Path $PSScriptRoot 'stop.ps1')
}

if (-not (Test-Bridge)) {
    $workRoot = Join-Path $projectRoot 'work'
    New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
    $stdoutPath = Join-Path $workRoot 'runtime.stdout.log'
    $stderrPath = Join-Path $workRoot 'runtime.stderr.log'
    Start-Process -FilePath $nodeExecutable `
        -ArgumentList '--env-file-if-exists=.env', 'dist-server/index.js' `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and -not (Test-Bridge)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Bridge)) { throw "OpenCodex Link failed to start. See $stderrPath" }
}

if (-not $NoOpen) { Start-Process 'http://127.0.0.1:8787/setup' }
