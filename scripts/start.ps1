param(
    [string]$Password = $env:CODEX_PWA_PASSWORD,
    [string]$ListenAddress = $env:CODEX_PWA_HOST,
    [int]$Port = 0,
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not $Password -and (Test-Path -LiteralPath '.env')) {
    $passwordLine = Get-Content -LiteralPath '.env' |
        Where-Object { $_ -match '^\s*CODEX_PWA_PASSWORD\s*=' } |
        Select-Object -First 1
    if ($passwordLine) {
        $Password = ($passwordLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
    }
}

if (-not $Password) {
    throw 'Set CODEX_PWA_PASSWORD or pass -Password.'
}

$env:CODEX_PWA_PASSWORD = $Password
if ($ListenAddress) {
    $env:CODEX_PWA_HOST = $ListenAddress
}
if ($Port -gt 0) {
    $env:CODEX_PWA_PORT = [string]$Port
}
if (-not (Test-Path -LiteralPath 'node_modules')) {
    npm install
}
npm run build

$launch = Join-Path $PSScriptRoot 'launch.ps1'
$launchArgs = @{ NoBuild = $true }
if ($DataDir) { $launchArgs.DataDir = $DataDir }
if ($Port -gt 0) { $launchArgs.Port = $Port }
& $launch @launchArgs
