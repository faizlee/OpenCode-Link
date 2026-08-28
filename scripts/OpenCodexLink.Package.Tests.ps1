param(
    [string]$ZipPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
Import-Module -Force -Global (Join-Path $here 'OpenCodexLink.Identity.psm1')
Import-Module -Force -Global (Join-Path $here 'OpenCodexLink.Service.psm1')

$env:CODEX_PWA_TEST_ISOLATION = '1'
$failed = 0
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) {
        Write-Host ("PASS {0}" -f $Message)
    } else {
        Write-Host ("FAIL {0}" -f $Message)
        $script:failed++
    }
}

if ([string]::IsNullOrWhiteSpace($ZipPath)) {
    $ZipPath = Join-Path (Join-Path (Split-Path -Parent $here) 'release') 'OpenCodexLink-Windows.zip'
}
Test-OpenCodexLinkPowerShellSyntax -Path $PSCommandPath
Test-OpenCodexLinkPortableZip -ZipPath $ZipPath
Write-Host 'PASS zip manifest'

$extractRoot = Join-Path $env:TEMP ('ocl-pkg-' + [guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $extractRoot 'data'
$proc = $null
try {
    New-Item -ItemType Directory -Force -Path $extractRoot, $dataRoot | Out-Null
    Assert-OpenCodexLinkTestIsolation -DataDir $dataRoot -Port 18941
    & tar.exe -xf $ZipPath -C $extractRoot
    if ($LASTEXITCODE -ne 0) { throw 'Failed to extract portable zip into a temp directory.' }
    $packageRoot = Join-Path $extractRoot 'OpenCodexLink'
    Test-OpenCodexLinkPortablePackageRoot -PackageRoot $packageRoot
    Write-Host 'PASS extracted package root'

    $tcp = New-Object System.Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    $tcp.Start()
    $testPort = ([Net.IPEndPoint]$tcp.LocalEndpoint).Port
    $tcp.Stop()
    if ($testPort -eq 8787) { throw 'package smoke port resolved to 8787' }
    Assert-OpenCodexLinkTestIsolation -DataDir $dataRoot -Port $testPort
    Assert-True ($testPort -ne 8787) 'package smoke uses a non-8787 port'

    $nodeExe = Join-Path (Join-Path $packageRoot 'runtime') 'node.exe'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = 'dist-server/index.js'
    $psi.WorkingDirectory = $packageRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['CODEX_PWA_TEST_ISOLATION'] = '1'
    $psi.EnvironmentVariables['CODEX_PWA_DATA_DIR'] = $dataRoot
    $psi.EnvironmentVariables['CODEX_PWA_PORT'] = [string]$testPort
    $psi.EnvironmentVariables['CODEX_PWA_HOST'] = '127.0.0.1'
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    if (-not (Wait-OpenCodexLinkServiceReady -Port $testPort -TimeoutSeconds 20)) {
        throw 'Packaged service did not become healthy on the isolated temp port.'
    }

    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/api/health' -f $testPort) -TimeoutSec 3
    Assert-True ($health.ok -eq $true) 'packaged /api/health is ok'
    Assert-True ($health.productId -eq 'OpenCodexLink') 'packaged health has productId'

    $runtime = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/api/runtime' -f $testPort) -TimeoutSec 3
    $runtimeJson = $runtime | ConvertTo-Json -Compress
    Assert-True ($runtime.ok -eq $true) 'packaged /api/runtime is ok'
    Assert-True ($runtime.productId -eq 'OpenCodexLink') 'packaged runtime has productId'
    Assert-True ($runtimeJson -notmatch 'controlToken') 'packaged runtime hides controlToken'
    Assert-True (Test-OpenCodexLinkSamePath ([string]$runtime.dataRoot) $dataRoot) 'packaged runtime uses temp data dir'
    Assert-True (-not (Test-OpenCodexLinkLiveDataRoot $dataRoot)) 'package smoke did not use live LOCALAPPDATA'

    $setup = Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/setup' -f $testPort) -UseBasicParsing -TimeoutSec 5
    Assert-True ($setup.StatusCode -eq 200) 'packaged /setup returns 200'
    Assert-True ($setup.Content -match 'OpenCodex Link') 'packaged /setup serves the app shell'
} finally {
    if ($proc -and -not $proc.HasExited) {
        try { $proc.Kill() } catch { }
    }
    if ($proc) { $proc.Dispose() }
    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($failed -gt 0) {
    Write-Host ("FAILED $failed assertion(s)")
    exit 1
}
Write-Host 'All OpenCodex Link portable package tests passed.'
exit 0
