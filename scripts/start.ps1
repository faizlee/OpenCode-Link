param(
    [string]$ListenAddress = $env:CODEX_PWA_HOST,
    [int]$Port = 0,
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

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
