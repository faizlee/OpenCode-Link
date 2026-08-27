param(
    [int]$Port = 0,
    [string]$DataDir = '',
    [string]$InstallRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
Import-Module -Force (Join-Path $PSScriptRoot 'OpenCodexLink.Identity.psm1')
Import-Module -Force (Join-Path $PSScriptRoot 'OpenCodexLink.Service.psm1')

$DataDir = Get-OpenCodexLinkResolvedDataDir -DataDir $DataDir
$Port = Get-OpenCodexLinkResolvedPort -Port $Port -InstallRoot $InstallRoot

if ($env:CODEX_PWA_TEST_ISOLATION -eq '1') {
    Assert-OpenCodexLinkTestIsolation -DataDir $DataDir -Port $Port
}

$sent = Request-OpenCodexLinkTrayStop -DataDir $DataDir
if ($sent) {
    if (Wait-OpenCodexLinkPortFree -Port $Port -TimeoutSeconds 8) {
        Write-Host 'OpenCodex Link stopped.'
        exit 0
    }
}

try {
    Stop-OpenCodexLinkService -Port $Port -DataDir $DataDir -InstallRoot $InstallRoot
    Write-Host 'OpenCodex Link stopped.'
} catch {
    $message = $_.Exception.Message
    if ($message -match 'Refusing to stop unproven process' -or $message -match 'runtime.json identity') {
        throw $message
    }
    $occupant = Get-OpenCodexLinkLiveOccupant -Port $Port -DataDir $DataDir -Candidate (Get-OpenCodexLinkInstallIdentity -InstallRoot $InstallRoot)
    if ($occupant.Class -eq 'Free' -or $occupant.Class -eq 'StalePid') {
        Write-Host 'OpenCodex Link is not running.'
        exit 0
    }
    throw
}
