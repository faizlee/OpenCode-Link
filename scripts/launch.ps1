param(
    [switch]$NoOpen,
    [switch]$NoBuild,
    [string]$DataDir = '',
    [int]$Port = 0,
    [string]$MutexName = 'Local\OpenCodexLink.Tray',
    [switch]$Headless
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
Import-Module -Force (Join-Path $PSScriptRoot 'OpenCodexLink.Identity.psm1')
Import-Module -Force (Join-Path $PSScriptRoot 'OpenCodexLink.Service.psm1')

function New-AccessSecret {
    $bytes = New-Object byte[] 24
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Ensure-EnvironmentFile {
    $environmentPath = Join-Path $projectRoot '.env'
    $content = @()
    if (Test-Path -LiteralPath $environmentPath) {
        $content = @(Get-Content -LiteralPath $environmentPath)
    }

    function Read-ManagedValue([string]$Name, [string]$Fallback) {
        $line = $content | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
        if ($line) { return ($line -split '=', 2)[1] }
        return $Fallback
    }

    $password = Read-ManagedValue 'CODEX_PWA_PASSWORD' (New-AccessSecret)
    $configuredPort = Read-ManagedValue 'CODEX_PWA_PORT' '8787'
    $lanName = Read-ManagedValue 'CODEX_PWA_LAN_NAME' 'opencodexlink'
    $unmanaged = @($content | Where-Object { $_ -notmatch '^CODEX_PWA_(PASSWORD|HOST|PORT|LAN_NAME)=' })

    @(
        $unmanaged
        "CODEX_PWA_PASSWORD=$password"
        'CODEX_PWA_HOST=0.0.0.0'
        "CODEX_PWA_PORT=$configuredPort"
        "CODEX_PWA_LAN_NAME=$lanName"
    ) | Set-Content -LiteralPath $environmentPath -Encoding ascii
}

Ensure-EnvironmentFile

if (-not $NoBuild -and (Test-Path -LiteralPath (Join-Path $projectRoot 'src'))) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { npm.cmd install }
    npm.cmd run build
}

$resolvedPort = Get-OpenCodexLinkResolvedPort -Port $Port -InstallRoot $projectRoot
$resolvedData = Get-OpenCodexLinkResolvedDataDir -DataDir $DataDir
$tray = Join-Path $PSScriptRoot 'tray.ps1'
$argList = @(
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $tray,
    '-InstallRoot', $projectRoot,
    '-DataDir', $resolvedData,
    '-Port', ([string]$resolvedPort),
    '-MutexName', $MutexName,
    '-NoBuild'
)
if ($NoOpen) { $argList += '-NoOpen' }
if ($Headless) { $argList += '-Headless' }

Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden | Out-Null
