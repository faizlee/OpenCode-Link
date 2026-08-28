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

function Get-OpenCodexLinkFileStamp {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Exists = $false; LastWriteTimeUtc = $null; Hash = '' }
    }
    $item = Get-Item -LiteralPath $Path
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return [pscustomobject]@{
        Exists = $true
        LastWriteTimeUtc = $item.LastWriteTimeUtc
        Hash = $hash
    }
}

function Start-OpenCodexLinkHeadlessTrayProcess {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$MutexName,
        [Parameter(Mandatory = $true)][string]$PipeName,
        [Parameter(Mandatory = $true)][string]$RunKeyPath,
        [Parameter(Mandatory = $true)][string]$StdOutPath,
        [Parameter(Mandatory = $true)][string]$StdErrPath,
        [switch]$Wait
    )
    $tray = Join-Path $here 'tray.ps1'
    $argList = @(
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $tray,
        '-InstallRoot', $InstallRoot,
        '-DataDir', $DataDir,
        '-Port', ([string]$Port),
        '-MutexName', $MutexName,
        '-PipeName', $PipeName,
        '-RunKeyPath', $RunKeyPath,
        '-Headless',
        '-NoOpen'
    )
    $previous = @{
        Isolation = $env:CODEX_PWA_TEST_ISOLATION
        Host = $env:CODEX_PWA_HOST
        DataDir = $env:CODEX_PWA_DATA_DIR
        Port = $env:CODEX_PWA_PORT
    }
    $env:CODEX_PWA_TEST_ISOLATION = '1'
    $env:CODEX_PWA_HOST = '127.0.0.1'
    $env:CODEX_PWA_DATA_DIR = $DataDir
    $env:CODEX_PWA_PORT = [string]$Port
    try {
        $start = @{
            FilePath = 'powershell.exe'
            ArgumentList = $argList
            PassThru = $true
            WindowStyle = 'Hidden'
            RedirectStandardOutput = $StdOutPath
            RedirectStandardError = $StdErrPath
        }
        if ($Wait) { $start.Wait = $true }
        return Start-Process @start
    } finally {
        $env:CODEX_PWA_TEST_ISOLATION = $previous.Isolation
        if ($null -eq $previous.Host) { Remove-Item Env:\CODEX_PWA_HOST -ErrorAction SilentlyContinue } else { $env:CODEX_PWA_HOST = $previous.Host }
        if ($null -eq $previous.DataDir) { Remove-Item Env:\CODEX_PWA_DATA_DIR -ErrorAction SilentlyContinue } else { $env:CODEX_PWA_DATA_DIR = $previous.DataDir }
        if ($null -eq $previous.Port) { Remove-Item Env:\CODEX_PWA_PORT -ErrorAction SilentlyContinue } else { $env:CODEX_PWA_PORT = $previous.Port }
    }
}

function Wait-OpenCodexLinkTrayFile {
    param([string]$DataDir, [int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $path = Join-Path $DataDir 'tray.json'
    while ((Get-Date) -lt $deadline) {
        $tray = Read-OpenCodexLinkJson $path
        if ($tray -and $tray.controlPipe -and [int]$tray.trayPid -gt 0) { return $tray }
        Start-Sleep -Milliseconds 150
    }
    return $null
}

function Wait-OpenCodexLinkProcessExit {
    param($Process, [int]$TimeoutSeconds = 20)
    if (-not $Process) { return $true }
    return $Process.WaitForExit($TimeoutSeconds * 1000)
}

$installRoot = Split-Path -Parent $here
$serverJs = Join-Path (Join-Path $installRoot 'dist-server') 'index.js'
if (-not (Test-Path -LiteralPath $serverJs)) {
    throw 'dist-server/index.js is missing. Run npm run build before tray IPC tests.'
}

$identity = Get-OpenCodexLinkInstallIdentity -InstallRoot $installRoot
$tempRoot = Join-Path $env:TEMP ('ocl-ipc-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $tempRoot 'data'
$fakeRoot = Join-Path $tempRoot 'newer'
$runKeyPath = 'HKCU:\Software\OpenCodexLink\IpcTest\' + [guid]::NewGuid().ToString('N')
$mutexName = 'Local\OCL.Ipc.' + [guid]::NewGuid().ToString('N')
$pipeName = 'OCL.ipc.' + [guid]::NewGuid().ToString('N')
$replacePipe = 'OCL.ipc.r.' + [guid]::NewGuid().ToString('N')
$wakePipe = 'OCL.ipc.w.' + [guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Force -Path $dataDir, $fakeRoot | Out-Null
'{"name":"codex-pwa","version":"9.9.9"}' | Set-Content -LiteralPath (Join-Path $fakeRoot 'package.json') -Encoding ascii

$tcp = New-Object System.Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
$tcp.Start()
$testPort = ([Net.IPEndPoint]$tcp.LocalEndpoint).Port
$tcp.Stop()
if ($testPort -eq 8787) { throw 'tray IPC test port resolved to 8787' }
Assert-OpenCodexLinkTestIsolation -DataDir $dataDir -Port $testPort
Assert-True ($testPort -ne 8787) 'tray IPC uses a non-8787 port'
Assert-True (-not (Test-OpenCodexLinkLiveDataRoot $dataDir)) 'tray IPC uses a temp data dir'

$liveDevices = Join-Path (Get-OpenCodexLinkLiveDataRoot) 'trusted-devices.json'
$beforeDevices = Get-OpenCodexLinkFileStamp $liveDevices
$before8787 = Get-OpenCodexLinkPortListener -Port 8787
$before8787Pid = 0
if ($before8787) { $before8787Pid = [int]$before8787.Pid }

$trayProc = $null
$replaceProc = $null
$unknownProc = $null
try {
    $trayProc = Start-OpenCodexLinkHeadlessTrayProcess `
        -InstallRoot $installRoot `
        -DataDir $dataDir `
        -Port $testPort `
        -MutexName $mutexName `
        -PipeName $pipeName `
        -RunKeyPath $runKeyPath `
        -StdOutPath (Join-Path $tempRoot 'tray.stdout.log') `
        -StdErrPath (Join-Path $tempRoot 'tray.stderr.log')

    $record = Wait-OpenCodexLinkTrayFile -DataDir $dataDir -TimeoutSeconds 25
    Assert-True ($null -ne $record) 'headless tray wrote tray.json'
    Assert-True ($record -and [int]$record.trayPid -eq $trayProc.Id) 'tray.json pid matches the isolated child'

    $ping = $null
    $pingError = ''
    $pingDeadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $pingDeadline) {
        try {
            $ping = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'ping' } -TimeoutMs 2000
            if ($ping) { break }
        } catch {
            $pingError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 200
    }

    $pingVersion = ''
    $pingPort = 0
    if ($ping) {
        $pingVersion = [string](Get-OpenCodexLinkNote $ping 'version')
        $pingPortValue = Get-OpenCodexLinkNote $ping 'port'
        if ($pingPortValue) { $pingPort = [int]$pingPortValue }
    }
    $ipcAlive = [bool]($ping -and $ping.ok -eq $true -and $pingVersion -eq [string]$identity.Version -and $pingPort -eq $testPort)
    Assert-True ($null -ne $ping) ('headless tray ping returned a JSON response' + $(if ($pingError) { ': ' + $pingError } else { '' }))
    Assert-True ($ipcAlive) ('headless tray ping returns main-runspace version and port, got version=' + $pingVersion + ' port=' + $pingPort)

    $status = $null
    try {
        $status = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'status' } -TimeoutMs 8000
    } catch {
        $status = $null
    }
    Assert-True ($null -ne $status -and $status.ok -eq $true) 'headless tray status command is handled'

    if (-not $ipcAlive) {
        Write-Host 'SKIP start/stop/wake/replace because ping did not prove a working tray command handler.'
    } else {
        if (-not (Wait-OpenCodexLinkServiceReady -Port $testPort -TimeoutSeconds 25)) {
            throw 'Isolated tray service did not become healthy on the temp port.'
        }
        $status = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'status' } -TimeoutMs 8000
        Assert-True ($status.status -eq 'running') 'headless tray status is running after startup'

        $pingTimes = @()
        foreach ($n in 1..5) {
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $quickPing = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'ping' } -TimeoutMs 4000
            $clock.Stop()
            $pingTimes += $clock.ElapsedMilliseconds
            Assert-True ($quickPing.ok -eq $true) ('low-latency ping #' + $n + ' returns ok')
            Assert-True ($clock.ElapsedMilliseconds -lt 1000) ('low-latency ping #' + $n + ' stays under 1000ms, got ' + $clock.ElapsedMilliseconds)
        }
        $maxPing = ($pingTimes | Measure-Object -Maximum).Maximum
        Assert-True ($maxPing -lt 1000) ('headless tray ping stays low-latency after health throttle, maxMs=' + $maxPing)

        $opened = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'open' } -TimeoutMs 15000
        Assert-True ($opened.ok -eq $true -and $opened.status -eq 'running') 'headless tray open command starts or keeps the service without requiring a browser'

        $stopped = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'stop' } -TimeoutMs 20000
        Assert-True ($stopped.ok -eq $true) 'headless tray stop command returns ok'
        Assert-True (Wait-OpenCodexLinkPortFree -Port $testPort -TimeoutSeconds 12) 'isolated service port is free after tray stop'

        $started = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'start' } -TimeoutMs 25000
        Assert-True ($started.ok -eq $true -and $started.status -eq 'running') 'headless tray start command returns running'
        Assert-True (Wait-OpenCodexLinkServiceReady -Port $testPort -TimeoutSeconds 10) 'isolated service is healthy after tray start'

        $wake = Start-OpenCodexLinkHeadlessTrayProcess `
            -InstallRoot $installRoot `
            -DataDir $dataDir `
            -Port $testPort `
            -MutexName $mutexName `
            -PipeName $wakePipe `
            -RunKeyPath $runKeyPath `
            -StdOutPath (Join-Path $tempRoot 'wake.stdout.log') `
            -StdErrPath (Join-Path $tempRoot 'wake.stderr.log') `
            -Wait
        Assert-True ($wake.ExitCode -eq 0) ('same-version second launch exits 0 after ping, got ' + $wake.ExitCode)
        Assert-True (-not $trayProc.HasExited) 'original tray stays alive after same-version wake'
        $pingAfterWake = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'ping' } -TimeoutMs 4000
        Assert-True ($pingAfterWake.ok -eq $true -and [int]$pingAfterWake.port -eq $testPort) 'original tray still answers ping after wake'

        $replaceProc = Start-OpenCodexLinkHeadlessTrayProcess `
            -InstallRoot $fakeRoot `
            -DataDir $dataDir `
            -Port $testPort `
            -MutexName $mutexName `
            -PipeName $replacePipe `
            -RunKeyPath $runKeyPath `
            -StdOutPath (Join-Path $tempRoot 'replace.stdout.log') `
            -StdErrPath (Join-Path $tempRoot 'replace.stderr.log')
        Assert-True (Wait-OpenCodexLinkProcessExit -Process $trayProc -TimeoutSeconds 30) 'shutdown-for-replace causes the previous tray process to exit'
        $replaceRecord = Wait-OpenCodexLinkTrayFile -DataDir $dataDir -TimeoutSeconds 20
        Assert-True ($replaceRecord -and [int]$replaceRecord.trayPid -eq $replaceProc.Id) 'replacement tray wrote tray.json'
        Assert-True ([string]$replaceRecord.version -eq '9.9.9') 'replacement tray identity uses the newer version'
        $createdNew = $false
        $probeMutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$createdNew)
        try {
            Assert-True (-not $createdNew) 'replacement tray holds the mutex after the previous owner exited'
        } finally {
            $probeMutex.Dispose()
        }
        $null = Send-OpenCodexLinkTrayCommand -PipeName $replacePipe -Command @{ cmd = 'exit' } -TimeoutMs 8000
        Assert-True (Wait-OpenCodexLinkProcessExit -Process $replaceProc -TimeoutSeconds 20) 'replacement tray exits after ipc exit'
        $createdNew = $false
        $freeMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
        try {
            Assert-True $createdNew 'mutex is released after replacement tray exits'
        } finally {
            try { $freeMutex.ReleaseMutex() } catch { }
            $freeMutex.Dispose()
        }
        $trayProc = $null
        $replaceProc = $null
    }

    if ($trayProc -and -not $trayProc.HasExited) {
        try { $null = Send-OpenCodexLinkTrayCommand -PipeName $pipeName -Command @{ cmd = 'exit' } -TimeoutMs 8000 } catch { }
        if (-not (Wait-OpenCodexLinkProcessExit -Process $trayProc -TimeoutSeconds 15)) {
            try { $trayProc.Kill() } catch { }
        }
    }
    if ($replaceProc -and -not $replaceProc.HasExited) {
        try { $null = Send-OpenCodexLinkTrayCommand -PipeName $replacePipe -Command @{ cmd = 'exit' } -TimeoutMs 8000 } catch { }
        if (-not (Wait-OpenCodexLinkProcessExit -Process $replaceProc -TimeoutSeconds 10)) {
            try { $replaceProc.Kill() } catch { }
        }
    }

    try {
        Stop-OpenCodexLinkService -Port $testPort -DataDir $dataDir -InstallRoot $installRoot
    } catch { }
    Assert-True (Wait-OpenCodexLinkPortFree -Port $testPort -TimeoutSeconds 12) 'temporary tray service is not listening after the test'
    if ($trayProc) {
        Assert-True $trayProc.HasExited 'isolated tray child process has exited'
    }

    $unknownPortListener = New-Object System.Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    $unknownPortListener.Start()
    $unknownPort = ([Net.IPEndPoint]$unknownPortListener.LocalEndpoint).Port
    $unknownPortListener.Stop()
    if ($unknownPort -eq 8787) { throw 'unknown-process IPC port resolved to 8787' }
    $jsPath = Join-Path $tempRoot 'unknown-listener.js'
    Set-Content -LiteralPath $jsPath -Value ("require('http').createServer(function(q,s){s.end('nope')}).listen(" + $unknownPort + ",'127.0.0.1');") -Encoding ascii
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
        if (Get-OpenCodexLinkPortListener -Port $unknownPort) { $ready = $true; break }
        Start-Sleep -Milliseconds 100
    }
    Assert-True $ready 'unknown occupant is listening for the IPC suite'
    $stopFailed = $false
    $stopMessage = ''
    try {
        Stop-OpenCodexLinkService -Port $unknownPort -DataDir $dataDir -InstallRoot $installRoot
    } catch {
        $stopFailed = $true
        $stopMessage = $_.Exception.Message
    }
    Assert-True $stopFailed ('IPC suite refuses to stop an unknown occupant: ' + $stopMessage)
    Assert-True (-not $unknownProc.HasExited) 'unknown occupant is still alive after the IPC suite'
} finally {
    if ($trayProc -and -not $trayProc.HasExited) {
        try { $trayProc.Kill() } catch { }
    }
    if ($replaceProc -and -not $replaceProc.HasExited) {
        try { $replaceProc.Kill() } catch { }
    }
    if ($unknownProc -and -not $unknownProc.HasExited) {
        try { $unknownProc.Kill() } catch { }
    }
    if ($unknownProc) { $unknownProc.Dispose() }
    try { Stop-OpenCodexLinkService -Port $testPort -DataDir $dataDir -InstallRoot $installRoot } catch { }
    if (Test-Path -LiteralPath $runKeyPath) {
        Remove-Item -LiteralPath $runKeyPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$afterDevices = Get-OpenCodexLinkFileStamp $liveDevices
$after8787 = Get-OpenCodexLinkPortListener -Port 8787
$after8787Pid = 0
if ($after8787) { $after8787Pid = [int]$after8787.Pid }
Assert-True ($beforeDevices.Exists -eq $afterDevices.Exists -and $beforeDevices.Hash -eq $afterDevices.Hash -and $beforeDevices.LastWriteTimeUtc -eq $afterDevices.LastWriteTimeUtc) 'live LOCALAPPDATA trusted-devices.json was not touched'
Assert-True ($before8787Pid -eq $after8787Pid) ('live port 8787 occupant was not touched, before=' + $before8787Pid + ' after=' + $after8787Pid)

if ($failed -gt 0) {
    Write-Host ("FAILED $failed assertion(s)")
    exit 1
}
Write-Host 'All OpenCodex Link tray IPC tests passed.'
exit 0
