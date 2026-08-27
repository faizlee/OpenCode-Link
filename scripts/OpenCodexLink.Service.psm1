Set-StrictMode -Version Latest
Import-Module -Force -Global (Join-Path $PSScriptRoot 'OpenCodexLink.Identity.psm1')

function Get-OpenCodexLinkNodeExe {
    param([string]$InstallRoot)
    $bundled = Join-Path (Join-Path $InstallRoot 'runtime') 'node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    return (Get-Command node.exe -ErrorAction Stop).Source
}

function Get-OpenCodexLinkResolvedPort {
    param([int]$Port, [string]$InstallRoot)
    if ($Port -gt 0) { return $Port }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PWA_PORT)) {
        return [int]$env:CODEX_PWA_PORT
    }
    $envPath = Join-Path $InstallRoot '.env'
    if (Test-Path -LiteralPath $envPath) {
        $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*CODEX_PWA_PORT\s*=' } | Select-Object -First 1
        if ($line) {
            $value = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
            if ($value) { return [int]$value }
        }
    }
    return 8787
}

function Get-OpenCodexLinkResolvedDataDir {
    param([string]$DataDir)
    if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
        return [IO.Path]::GetFullPath($DataDir)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PWA_DATA_DIR)) {
        return [IO.Path]::GetFullPath($env:CODEX_PWA_DATA_DIR)
    }
    return Get-OpenCodexLinkLiveDataRoot
}

function Wait-OpenCodexLinkPortFree {
    param([int]$Port, [int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $listener = Get-OpenCodexLinkPortListener -Port $Port
        if (-not $listener) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

function Wait-OpenCodexLinkServiceReady {
    param([int]$Port, [int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = Get-OpenCodexLinkHttpJson ("http://127.0.0.1:{0}/api/health" -f $Port)
        if ($health -and $health.ok) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Stop-OpenCodexLinkService {
    param(
        [int]$Port,
        [string]$DataDir,
        [string]$InstallRoot,
        $Occupant
    )

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = (Get-Location).Path }
    $DataDir = Get-OpenCodexLinkResolvedDataDir -DataDir $DataDir
    $Port = Get-OpenCodexLinkResolvedPort -Port $Port -InstallRoot $InstallRoot

    if ($env:CODEX_PWA_TEST_ISOLATION -eq '1') {
        Assert-OpenCodexLinkTestIsolation -DataDir $DataDir -Port $Port
    }

    if (-not $Occupant) {
        $candidate = Get-OpenCodexLinkInstallIdentity -InstallRoot $InstallRoot
        $Occupant = Get-OpenCodexLinkLiveOccupant -Port $Port -DataDir $DataDir -Candidate $candidate
    }

    if (-not (Test-OpenCodexLinkSafeToStop -Class $Occupant.Class)) {
        throw ('Refusing to stop unproven process on port {0}. Class={1} PID={2}' -f $Occupant.Port, $Occupant.Class, $Occupant.Pid)
    }

    if ($Occupant.RuntimeFile) {
        if (-not (Test-OpenCodexLinkRuntimeProof -Occupant $Occupant)) {
            throw 'runtime.json identity did not match productId, PID, and installRoot. Refusing to stop the process.'
        }
        $token = [string]$Occupant.RuntimeFile.controlToken
        if (-not [string]::IsNullOrWhiteSpace($token)) {
            try {
                $headers = @{ 'X-OpenCodexLink-Control-Token' = $token }
                Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/runtime/shutdown" -f $Occupant.Port) -Method POST -Headers $headers -TimeoutSec 4 | Out-Null
                if (Wait-OpenCodexLinkPortFree -Port $Occupant.Port -TimeoutSeconds 12) { return }
            } catch {
                # Fall through to a proven-PID stop only.
            }
        }
    }

    if ($Occupant.Pid -gt 0) {
        Stop-Process -Id $Occupant.Pid -ErrorAction Stop
    }
    if (-not (Wait-OpenCodexLinkPortFree -Port $Occupant.Port -TimeoutSeconds 12)) {
        throw 'Timed out waiting for the proven OpenCodex Link port to be released.'
    }
}

function Start-OpenCodexLinkService {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [string]$DataDir,
        [int]$Port = 0
    )

    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $DataDir = Get-OpenCodexLinkResolvedDataDir -DataDir $DataDir
    $Port = Get-OpenCodexLinkResolvedPort -Port $Port -InstallRoot $InstallRoot
    $candidate = Get-OpenCodexLinkInstallIdentity -InstallRoot $InstallRoot

    if ($env:CODEX_PWA_TEST_ISOLATION -eq '1') {
        Assert-OpenCodexLinkTestIsolation -DataDir $DataDir -Port $Port
    }

    $occupant = Get-OpenCodexLinkLiveOccupant -Port $Port -DataDir $DataDir -Candidate $candidate
    if ($occupant.Class -eq 'Unknown' -or $occupant.Class -eq 'Unproven') {
        throw ('Port {0} is in use by another program. OpenCodex Link will not stop it. Class={1} PID={2}' -f $Port, $occupant.Class, $occupant.Pid)
    }
    if ($occupant.Class -eq 'Current') {
        return $occupant
    }
    if ($occupant.Class -eq 'Predecessor') {
        Stop-OpenCodexLinkService -Port $Port -DataDir $DataDir -InstallRoot $InstallRoot -Occupant $occupant
    }

    $serverJs = Join-Path (Join-Path $InstallRoot 'dist-server') 'index.js'
    if (-not (Test-Path -LiteralPath $serverJs)) {
        throw "OpenCodex Link service is missing: $serverJs"
    }

    $logDir = Join-Path $DataDir 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }
    $stdoutPath = Join-Path $logDir 'service.stdout.log'
    $stderrPath = Join-Path $logDir 'service.stderr.log'
    $nodeExe = Get-OpenCodexLinkNodeExe -InstallRoot $InstallRoot

    $previousData = $env:CODEX_PWA_DATA_DIR
    $previousPort = $env:CODEX_PWA_PORT
    $previousHost = $env:CODEX_PWA_HOST
    $env:CODEX_PWA_DATA_DIR = $DataDir
    $env:CODEX_PWA_PORT = [string]$Port
    if ($env:CODEX_PWA_TEST_ISOLATION -eq '1') {
        $env:CODEX_PWA_HOST = '127.0.0.1'
    } elseif ([string]::IsNullOrWhiteSpace($env:CODEX_PWA_HOST)) {
        $env:CODEX_PWA_HOST = '0.0.0.0'
    }
    try {
        Start-Process -FilePath $nodeExe `
            -ArgumentList @('--env-file-if-exists=.env', 'dist-server/index.js') `
            -WorkingDirectory $InstallRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath | Out-Null
    } finally {
        if ([string]::IsNullOrWhiteSpace($previousData)) { Remove-Item Env:\CODEX_PWA_DATA_DIR -ErrorAction SilentlyContinue } else { $env:CODEX_PWA_DATA_DIR = $previousData }
        if ([string]::IsNullOrWhiteSpace($previousPort)) { Remove-Item Env:\CODEX_PWA_PORT -ErrorAction SilentlyContinue } else { $env:CODEX_PWA_PORT = $previousPort }
        if ([string]::IsNullOrWhiteSpace($previousHost)) { Remove-Item Env:\CODEX_PWA_HOST -ErrorAction SilentlyContinue } else { $env:CODEX_PWA_HOST = $previousHost }
    }

    if (-not (Wait-OpenCodexLinkServiceReady -Port $Port -TimeoutSeconds 20)) {
        throw ("OpenCodex Link failed to start. See $stderrPath")
    }
    return Get-OpenCodexLinkLiveOccupant -Port $Port -DataDir $DataDir -Candidate $candidate
}

function Request-OpenCodexLinkTrayStop {
    param([string]$DataDir)
    $DataDir = Get-OpenCodexLinkResolvedDataDir -DataDir $DataDir
    $tray = Read-OpenCodexLinkJson (Join-Path $DataDir 'tray.json')
    if (-not $tray -or [string]::IsNullOrWhiteSpace([string]$tray.controlPipe)) { return $false }
    $info = Get-OpenCodexLinkProcessInfo -ProcessId ([int]$tray.trayPid)
    if (-not $info) { return $false }
    try {
        $null = Send-OpenCodexLinkTrayCommand -PipeName ([string]$tray.controlPipe) -Command @{ cmd = 'stop' }
        return $true
    } catch {
        return $false
    }
}

Export-ModuleMember -Function @(
    'Get-OpenCodexLinkNodeExe',
    'Get-OpenCodexLinkResolvedPort',
    'Get-OpenCodexLinkResolvedDataDir',
    'Wait-OpenCodexLinkPortFree',
    'Wait-OpenCodexLinkServiceReady',
    'Stop-OpenCodexLinkService',
    'Start-OpenCodexLinkService',
    'Request-OpenCodexLinkTrayStop'
)
