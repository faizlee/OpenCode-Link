Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
Import-Module -Force (Join-Path $here 'OpenCodexLink.Identity.psm1')
Import-Module -Force (Join-Path $here 'OpenCodexLink.Service.psm1')

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

$scripts = @(
    (Join-Path $here 'OpenCodexLink.Identity.psm1'),
    (Join-Path $here 'OpenCodexLink.Service.psm1'),
    (Join-Path $here 'tray.ps1'),
    (Join-Path $here 'launch.ps1'),
    (Join-Path $here 'stop.ps1'),
    (Join-Path $here 'start.ps1'),
    (Join-Path $here 'package-windows.ps1'),
    (Join-Path $here 'OpenCodexLink.Tests.ps1'),
    (Join-Path $here 'OpenCodexLink.Package.Tests.ps1'),
    (Join-Path $here 'OpenCodexLink.TrayIpc.Tests.ps1')
)
foreach ($scriptPath in $scripts) {
    Test-OpenCodexLinkPowerShellSyntax -Path $scriptPath
    Write-Host ("PASS syntax {0}" -f (Split-Path -Leaf $scriptPath))
}

$required = Get-OpenCodexLinkPortableRequiredRelativePaths
$forbidden = Get-OpenCodexLinkPortableForbiddenRelativePaths
Assert-True ($required -contains 'scripts\tray.ps1') 'package plan includes tray.ps1'
Assert-True ($required -contains 'scripts\OpenCodexLink.Identity.psm1') 'package plan includes identity module'
Assert-True ($required -contains 'assets\tray.png') 'package plan includes tray icon'
Assert-True ($required -contains 'build-info.json') 'package plan includes build identity'
Assert-True ($required -contains 'node_modules\express\package.json') 'package plan includes production runtime modules'
Assert-True ($forbidden -contains '.env') 'package plan forbids .env'
Assert-True ($forbidden -contains 'src') 'package plan forbids src'
Assert-True ($forbidden -contains 'server') 'package plan forbids server source'
Assert-True ($forbidden -contains 'trusted-devices.json') 'package plan forbids device credentials'
Assert-True ($forbidden -contains 'scripts\OpenCodexLink.TrayIpc.Tests.ps1') 'package plan forbids tray IPC tests'

$sampleZipEntries = @(
    'OpenCodexLink/dist/index.html',
    'OpenCodexLink/dist-server/index.js',
    'OpenCodexLink/runtime/node.exe',
    'OpenCodexLink/scripts/tray.ps1',
    'OpenCodexLink/scripts/launch.ps1',
    'OpenCodexLink/scripts/stop.ps1',
    'OpenCodexLink/scripts/OpenCodexLink.Identity.psm1',
    'OpenCodexLink/scripts/OpenCodexLink.Service.psm1',
    'OpenCodexLink/assets/tray.png',
    'OpenCodexLink/OpenCodex Link.cmd',
    'OpenCodexLink/Stop OpenCodex Link.cmd',
    'OpenCodexLink/README.md',
    'OpenCodexLink/package.json',
    'OpenCodexLink/package-lock.json',
    'OpenCodexLink/build-info.json',
    'OpenCodexLink/node_modules/express/package.json',
    'OpenCodexLink/node_modules/debug/src/index.js'
)
Test-OpenCodexLinkPortableZipEntries -Names $sampleZipEntries
Write-Host 'PASS zip allows dependency src folders'

$rejectedSrc = $false
try {
    Test-OpenCodexLinkPortableZipEntries -Names ($sampleZipEntries + 'OpenCodexLink/src/App.tsx')
} catch {
    $rejectedSrc = $_.Exception.Message -match 'src'
}
Assert-True $rejectedSrc 'package-root src is rejected in zip entries'

$rejectedEnv = $false
try {
    Test-OpenCodexLinkPortableZipEntries -Names ($sampleZipEntries + 'OpenCodexLink/.env')
} catch {
    $rejectedEnv = $_.Exception.Message -match '\.env'
}
Assert-True $rejectedEnv 'package-root .env is rejected in zip entries'

$healthMs = Get-OpenCodexLinkHealthRefreshIntervalMs
Assert-True ($healthMs -ge 800 -and $healthMs -le 1000) ('health refresh interval is 800-1000ms, got ' + $healthMs)
$dueAt = [datetime]::UtcNow
Assert-True (Test-OpenCodexLinkHealthRefreshDue -Now $dueAt -LastAt ([datetime]::MinValue) -IntervalMs $healthMs) 'first health refresh is due immediately'
Assert-True (-not (Test-OpenCodexLinkHealthRefreshDue -Now $dueAt.AddMilliseconds($healthMs - 1) -LastAt $dueAt -IntervalMs $healthMs)) 'health refresh is not due before the interval'
Assert-True (Test-OpenCodexLinkHealthRefreshDue -Now $dueAt.AddMilliseconds($healthMs) -LastAt $dueAt -IntervalMs $healthMs) 'health refresh is due at the interval'

$traySource = Get-Content -LiteralPath (Join-Path $here 'tray.ps1') -Raw
Assert-True ($traySource -match '\$ipcTimer\.Interval\s*=\s*50') 'tray IPC timer stays at 50ms'
Assert-True ($traySource -match '\$statusTimer\.Interval\s*=\s*Get-OpenCodexLinkHealthRefreshIntervalMs') 'menu/health timer uses the throttled interval'
$ipcTick = [regex]::Match($traySource, '(?s)\$ipcTimer\.add_Tick\(\{(.*?)\}\s*\)')
Assert-True $ipcTick.Success 'tray IPC tick handler is present'
Assert-True ($ipcTick.Groups[1].Value -match 'Receive-OpenCodexLinkTrayIpc') 'IPC tick still pumps the command queue'
Assert-True ($ipcTick.Groups[1].Value -notmatch 'Refresh-OpenCodexLinkMenu') 'IPC tick does not refresh the menu'
Assert-True ($ipcTick.Groups[1].Value -notmatch 'Update-OpenCodexLinkTrayStatus') 'IPC tick does not poll /api/health'

$autoKey = 'HKCU:\Software\OpenCodexLink\AutoStartTest\' + [guid]::NewGuid().ToString('N')
try {
    New-Item -Path $autoKey -Force | Out-Null
    $missingThrew = $false
    $missingResult = $true
    try {
        $missingResult = Get-OpenCodexLinkAutoStart -RunKeyPath $autoKey
    } catch {
        $missingThrew = $true
        $missingResult = $true
    }
    Assert-True (-not $missingThrew) 'Get-OpenCodexLinkAutoStart does not throw when the Run key exists without OpenCodexLink'
    Assert-True ($missingResult -eq $false) 'Get-OpenCodexLinkAutoStart returns false when OpenCodexLink is absent'

    Set-OpenCodexLinkAutoStart -Enabled $true -InstallRoot 'C:\apps\OpenCodexLink' -RunKeyPath $autoKey
    $presentThrew = $false
    $presentResult = $false
    try {
        $presentResult = Get-OpenCodexLinkAutoStart -RunKeyPath $autoKey
    } catch {
        $presentThrew = $true
    }
    Assert-True (-not $presentThrew) 'Get-OpenCodexLinkAutoStart does not throw when OpenCodexLink exists'
    Assert-True ($presentResult -eq $true) 'Get-OpenCodexLinkAutoStart returns true when OpenCodexLink exists'
} finally {
    if (Test-Path -LiteralPath $autoKey) {
        Remove-Item -LiteralPath $autoKey -Recurse -Force
    }
}

$tempRoot = Join-Path $env:TEMP ('ocl-tray-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$listener = $null
$unknownProc = $null
try {
    Assert-OpenCodexLinkTestIsolation -DataDir $tempRoot -Port 18931
    $liveBlocked = $false
    try { Assert-OpenCodexLinkTestIsolation -DataDir $tempRoot -Port 8787 } catch { $liveBlocked = $true }
    Assert-True $liveBlocked 'isolation blocks port 8787'

    $candidate = [pscustomobject]@{ Version = '0.1.0'; InstallRoot = 'C:\apps\OpenCodexLink-new' }
    $now = [DateTime]::UtcNow.ToString('o')

    $currentClass = Get-OpenCodexLinkOccupantClass -Evidence ([pscustomobject]@{
        HasListener = $true
        ListenerPid = 4242
        ProcessExists = $true
        ProcessStartTime = [DateTime]::UtcNow.AddSeconds(-2)
        CommandLine = '"C:\nodejs\node.exe" --env-file-if-exists=.env dist-server\index.js'
        WorkingDirectory = 'C:\apps\OpenCodexLink-new'
        HasProductFiles = $true
        Health = [pscustomobject]@{ ok = $true; productId = 'OpenCodexLink'; version = '0.1.0' }
        RuntimeHttp = [pscustomobject]@{ productId = 'OpenCodexLink'; version = '0.1.0'; installRoot = 'C:\apps\OpenCodexLink-new'; instanceId = 'inst-current' }
        RuntimeFile = [pscustomobject]@{ productId = 'OpenCodexLink'; version = '0.1.0'; installRoot = 'C:\apps\OpenCodexLink-new'; instanceId = 'inst-current'; servicePid = 4242; startedAt = $now; controlToken = 'token-current' }
        TrayFile = $null
    }) -Candidate $candidate
    Assert-True ($currentClass -eq 'Current') ('current class is Current, got ' + $currentClass)
    Assert-True (Test-OpenCodexLinkSafeToStop $currentClass) 'current is safe to stop for restart'

    $predecessorClass = Get-OpenCodexLinkOccupantClass -Evidence ([pscustomobject]@{
        HasListener = $true
        ListenerPid = 4343
        ProcessExists = $true
        ProcessStartTime = [DateTime]::UtcNow.AddSeconds(-2)
        CommandLine = '"C:\nodejs\node.exe" dist-server/index.js'
        WorkingDirectory = 'C:\apps\OpenCodexLink-old'
        HasProductFiles = $true
        Health = [pscustomobject]@{ ok = $true; productId = 'OpenCodexLink'; version = '0.0.9' }
        RuntimeHttp = [pscustomobject]@{ productId = 'OpenCodexLink'; version = '0.0.9'; installRoot = 'C:\apps\OpenCodexLink-old'; instanceId = 'inst-old' }
        RuntimeFile = [pscustomobject]@{ productId = 'OpenCodexLink'; version = '0.0.9'; installRoot = 'C:\apps\OpenCodexLink-old'; instanceId = 'inst-old'; servicePid = 4343; startedAt = $now; controlToken = 'token-old' }
        TrayFile = $null
    }) -Candidate $candidate
    Assert-True ($predecessorClass -eq 'Predecessor') ('predecessor class is Predecessor, got ' + $predecessorClass)
    Assert-True (Test-OpenCodexLinkSafeToStop $predecessorClass) 'predecessor is replaceable'

    $staleClass = Get-OpenCodexLinkOccupantClass -Evidence ([pscustomobject]@{
        HasListener = $false
        ListenerPid = 0
        ProcessExists = $false
        ProcessStartTime = $null
        CommandLine = ''
        WorkingDirectory = ''
        HasProductFiles = $false
        Health = $null
        RuntimeHttp = $null
        RuntimeFile = [pscustomobject]@{ productId = 'OpenCodexLink'; version = '0.1.0'; installRoot = 'C:\apps\OpenCodexLink-new'; instanceId = 'inst-stale'; servicePid = 999001; startedAt = $now }
        TrayFile = $null
    }) -Candidate $candidate
    Assert-True ($staleClass -eq 'StalePid') ('stale class is StalePid, got ' + $staleClass)
    Assert-True (-not (Test-OpenCodexLinkSafeToStop $staleClass)) 'stale pid is not killed'

    $unknownClass = Get-OpenCodexLinkOccupantClass -Evidence ([pscustomobject]@{
        HasListener = $true
        ListenerPid = 5151
        ProcessExists = $true
        ProcessStartTime = [DateTime]::UtcNow
        CommandLine = '"C:\Python\python.exe" -m http.server 18999'
        WorkingDirectory = 'C:\scratch'
        HasProductFiles = $false
        Health = [pscustomobject]@{ ok = $true }
        RuntimeHttp = $null
        RuntimeFile = $null
        TrayFile = $null
    }) -Candidate $candidate
    Assert-True ($unknownClass -eq 'Unknown') ('unknown class is Unknown, got ' + $unknownClass)
    Assert-True (-not (Test-OpenCodexLinkSafeToStop $unknownClass)) 'unknown is not safe to stop'

    $tcp = New-Object System.Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    $tcp.Start()
    $testPort = ([Net.IPEndPoint]$tcp.LocalEndpoint).Port
    $tcp.Stop()
    if ($testPort -eq 8787) { throw 'test port resolved to 8787' }
    Assert-True ($testPort -ne 8787) 'unknown-process test uses a non-8787 port'

    $jsPath = Join-Path $tempRoot 'unknown-listener.js'
    Set-Content -LiteralPath $jsPath -Value ("require('http').createServer(function(q,s){s.end('nope')}).listen(" + $testPort + ",'127.0.0.1');") -Encoding ascii
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = ('"{0}"' -f $jsPath)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $unknownProc = New-Object System.Diagnostics.Process
    $unknownProc.StartInfo = $psi
    [void]$unknownProc.Start()

    $ready = $false
    $readyDeadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $readyDeadline) {
        $found = Get-OpenCodexLinkPortListener -Port $testPort
        if ($found) { $ready = $true; break }
        Start-Sleep -Milliseconds 100
    }
    Assert-True $ready 'unknown occupant is listening'

    $stopFailed = $false
    $stopMessage = ''
    try {
        Stop-OpenCodexLinkService -Port $testPort -DataDir $tempRoot -InstallRoot $tempRoot
    } catch {
        $stopFailed = $true
        $stopMessage = $_.Exception.Message
    }
    Assert-True $stopFailed ('unknown occupant stop is refused: ' + $stopMessage)
    Assert-True ($stopMessage -match 'Refusing to stop unproven process') 'unknown occupant error names fail-closed refusal'
    Start-Sleep -Milliseconds 200
    Assert-True (-not $unknownProc.HasExited) 'unknown occupant process is still alive'
} finally {
    if ($unknownProc -and -not $unknownProc.HasExited) {
        try { $unknownProc.Kill() } catch { }
    }
    if ($unknownProc) { $unknownProc.Dispose() }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

if ($failed -gt 0) {
    Write-Host ("FAILED $failed assertion(s)")
    exit 1
}
Write-Host 'All OpenCodex Link tray identity tests passed.'
$ipcTests = Join-Path $here 'OpenCodexLink.TrayIpc.Tests.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ipcTests
exit $LASTEXITCODE
