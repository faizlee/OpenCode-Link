param(
    [string]$InstallRoot = '',
    [string]$DataDir = '',
    [int]$Port = 0,
    [string]$MutexName = 'Local\OpenCodexLink.Tray',
    [string]$PipeName = '',
    [string]$RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    [switch]$NoBuild,
    [switch]$NoOpen,
    [switch]$Headless
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
$identity = Get-OpenCodexLinkInstallIdentity -InstallRoot $InstallRoot
if ([string]::IsNullOrWhiteSpace($PipeName)) {
    $PipeName = 'OpenCodexLink.tray.' + $PID
}

if ($env:CODEX_PWA_TEST_ISOLATION -eq '1') {
    Assert-OpenCodexLinkTestIsolation -DataDir $DataDir -Port $Port
}

$apartment = [Threading.Thread]::CurrentThread.GetApartmentState()
if (-not $Headless -and $apartment -ne 'STA') {
    $relaunch = @(
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
        '-InstallRoot', $InstallRoot,
        '-DataDir', $DataDir,
        '-Port', ([string]$Port),
        '-MutexName', $MutexName,
        '-PipeName', $PipeName,
        '-RunKeyPath', $RunKeyPath
    )
    if ($NoBuild) { $relaunch += '-NoBuild' }
    if ($NoOpen) { $relaunch += '-NoOpen' }
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $relaunch -Wait -PassThru
    if ($proc.ExitCode) { exit $proc.ExitCode }
    exit 0
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
    $existing = Read-OpenCodexLinkJson (Join-Path $DataDir 'tray.json')
    if ($existing -and $existing.controlPipe) {
        $sameRoot = Test-OpenCodexLinkSamePath ([string]$existing.installRoot) $identity.InstallRoot
        $sameVersion = [string]$existing.version -eq [string]$identity.Version
        if ($sameRoot -and $sameVersion) {
            try {
                if (-not $NoOpen) {
                    $null = Send-OpenCodexLinkTrayCommand -PipeName ([string]$existing.controlPipe) -Command @{ cmd = 'open' }
                } else {
                    $null = Send-OpenCodexLinkTrayCommand -PipeName ([string]$existing.controlPipe) -Command @{ cmd = 'ping' }
                }
            } catch {
                throw 'OpenCodex Link tray is already running but did not respond.'
            }
            exit 0
        }
        try {
            $null = Send-OpenCodexLinkTrayCommand -PipeName ([string]$existing.controlPipe) -Command @{
                cmd = 'shutdown-for-replace'
                version = $identity.Version
                installRoot = $identity.InstallRoot
            }
        } catch {
            throw 'A different OpenCodex Link tray is running and could not be replaced safely.'
        }
        $deadline = (Get-Date).AddSeconds(20)
        $acquired = $false
        while ((Get-Date) -lt $deadline) {
            try {
                if ($mutex.WaitOne(250)) { $acquired = $true; break }
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }
        if (-not $acquired) {
            throw 'Timed out waiting for the previous OpenCodex Link tray to exit.'
        }
    } else {
        throw 'Another OpenCodex Link tray is running but its identity could not be proven.'
    }
}

if (-not (Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

$script:state = [hashtable]::Synchronized(@{
    ExitRequested = $false
    InstallRoot = $InstallRoot
    DataDir = $DataDir
    Port = $Port
    NoOpen = [bool]$NoOpen
    RunKeyPath = $RunKeyPath
    Identity = $identity
    LastError = ''
    StatusText = 'stopped'
})
$script:ipcQueue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[object]'

function Get-OpenCodexLinkConsoleUrl {
    param([string]$Hash = '')
    $url = 'http://127.0.0.1:' + $script:state.Port + '/setup'
    if ($Hash) { $url = $url + $Hash }
    return $url
}

function Update-OpenCodexLinkTrayStatus {
    try {
        $health = Get-OpenCodexLinkHttpJson ('http://127.0.0.1:{0}/api/health' -f $script:state.Port)
        if ($health -and $health.ok) { $script:state.StatusText = 'running' } else { $script:state.StatusText = 'stopped' }
    } catch {
        $script:state.StatusText = 'stopped'
    }
}

function Start-OpenCodexLinkOwnedService {
    $null = Start-OpenCodexLinkService -InstallRoot $script:state.InstallRoot -DataDir $script:state.DataDir -Port $script:state.Port
    Update-OpenCodexLinkTrayStatus
}

function Stop-OpenCodexLinkOwnedService {
    Stop-OpenCodexLinkService -InstallRoot $script:state.InstallRoot -DataDir $script:state.DataDir -Port $script:state.Port
    Update-OpenCodexLinkTrayStatus
}

function Open-OpenCodexLinkConsole {
    param([string]$Hash = '')
    Update-OpenCodexLinkTrayStatus
    if ($script:state.StatusText -ne 'running') {
        Start-OpenCodexLinkOwnedService
    }
    if ($env:CODEX_PWA_TEST_ISOLATION -eq '1') { return }
    Start-Process (Get-OpenCodexLinkConsoleUrl -Hash $Hash) | Out-Null
}

function Invoke-OpenCodexLinkTrayCommand {
    param($Command)
    $cmd = [string]$Command.cmd
    $ok = @{ ok = $true; status = $script:state.StatusText; version = $script:state.Identity.Version; port = $script:state.Port }
    switch ($cmd) {
        'ping' { return $ok }
        'status' { Update-OpenCodexLinkTrayStatus; $ok.status = $script:state.StatusText; return $ok }
        'open' { Open-OpenCodexLinkConsole; return $ok }
        'add-phone' { Open-OpenCodexLinkConsole -Hash '#add-phone'; return $ok }
        'connection' { Start-Process ('http://127.0.0.1:{0}/setup/connection' -f $script:state.Port) | Out-Null; return $ok }
        'start' { Start-OpenCodexLinkOwnedService; $ok.status = $script:state.StatusText; return $ok }
        'stop' { Stop-OpenCodexLinkOwnedService; $ok.status = $script:state.StatusText; return $ok }
        'autostart' {
            $enabled = [bool]$Command.enabled
            Set-OpenCodexLinkAutoStart -Enabled $enabled -InstallRoot $script:state.InstallRoot -RunKeyPath $script:state.RunKeyPath
            Write-OpenCodexLinkJson -Path (Join-Path $script:state.DataDir 'settings.json') -Object ([pscustomobject]@{
                schema = 1
                autoStart = $enabled
                openConsoleOnStart = $true
                keepRunningWhenBrowserCloses = $true
            })
            return $ok
        }
        'shutdown-for-replace' {
            try { Stop-OpenCodexLinkOwnedService } catch { }
            $script:state.ExitRequested = $true
            return $ok
        }
        'exit' {
            $script:state.ExitRequested = $true
            return $ok
        }
        default { return @{ ok = $false; error = 'unknown command' } }
    }
}

function Receive-OpenCodexLinkTrayIpc {
    $item = $null
    while ($script:ipcQueue.TryDequeue([ref]$item)) {
        try {
            $item.Response = Invoke-OpenCodexLinkTrayCommand -Command $item.Command
        } catch {
            $item.Response = @{ ok = $false; error = $_.Exception.Message }
        }
        try { [void]$item.Done.Set() } catch { }
        $item = $null
    }
}

function Wait-OpenCodexLinkOwnedServiceReady {
    param([int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline -and -not $script:state.ExitRequested) {
        Receive-OpenCodexLinkTrayIpc
        Update-OpenCodexLinkTrayStatus
        if ($script:state.StatusText -eq 'running') { return $true }
        Start-Sleep -Milliseconds 40
    }
    return $script:state.StatusText -eq 'running'
}

$null = New-OpenCodexLinkTrayRecord -DataDir $DataDir -Identity $identity -PipeName $PipeName

$pipeRunspace = [runspacefactory]::CreateRunspace()
$pipeRunspace.ApartmentState = 'MTA'
$pipeRunspace.Open()
$pipeWorker = [powershell]::Create()
$pipeWorker.Runspace = $pipeRunspace
$null = $pipeWorker.AddScript({
    param($State, $Name, $Queue)
    while (-not $State.ExitRequested) {
        $pipe = $null
        try {
            $pipe = New-Object System.IO.Pipes.NamedPipeServerStream(
                $Name,
                [System.IO.Pipes.PipeDirection]::InOut,
                1,
                [System.IO.Pipes.PipeTransmissionMode]::Byte,
                [System.IO.Pipes.PipeOptions]::Asynchronous
            )
            $async = $pipe.BeginWaitForConnection($null, $null)
            while (-not $async.IsCompleted -and -not $State.ExitRequested) {
                Start-Sleep -Milliseconds 80
            }
            if ($State.ExitRequested) { break }
            $pipe.EndWaitForConnection($async)
            $reader = New-Object System.IO.StreamReader($pipe)
            $writer = New-Object System.IO.StreamWriter($pipe)
            $writer.AutoFlush = $true
            $line = $reader.ReadLine()
            if (-not [string]::IsNullOrWhiteSpace($line)) {
                $command = $line | ConvertFrom-Json
                $done = New-Object System.Threading.ManualResetEventSlim $false
                $work = [hashtable]::Synchronized(@{
                    Command = $command
                    Response = $null
                    Done = $done
                })
                $Queue.Enqueue($work)
                if ($done.Wait(30000) -and $work.Response) {
                    $writer.WriteLine(($work.Response | ConvertTo-Json -Compress -Depth 5))
                } else {
                    $writer.WriteLine((@{ ok = $false; error = 'tray ipc timeout' } | ConvertTo-Json -Compress))
                }
            }
        } catch {
            $State.LastError = $_.Exception.Message
        } finally {
            if ($pipe) { $pipe.Dispose() }
        }
    }
}).AddArgument($script:state).AddArgument($PipeName).AddArgument($script:ipcQueue)
$null = $pipeWorker.BeginInvoke()

try {
    $null = Start-OpenCodexLinkService -InstallRoot $script:state.InstallRoot -DataDir $script:state.DataDir -Port $script:state.Port -NoWait
} catch {
    $script:state.LastError = $_.Exception.Message
    $script:state.StatusText = 'error'
}

$null = Wait-OpenCodexLinkOwnedServiceReady -TimeoutSeconds 20

if (-not $NoOpen -and $script:state.StatusText -eq 'running' -and $env:CODEX_PWA_TEST_ISOLATION -ne '1') {
    Start-Process (Get-OpenCodexLinkConsoleUrl) | Out-Null
}

if ($Headless) {
    while (-not $script:state.ExitRequested) {
        Receive-OpenCodexLinkTrayIpc
        Start-Sleep -Milliseconds 40
    }
    Receive-OpenCodexLinkTrayIpc
} else {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $icon = [System.Drawing.SystemIcons]::Application
    $iconPaths = @(
        (Join-Path (Join-Path $InstallRoot 'assets') 'tray.png'),
        (Join-Path (Join-Path $InstallRoot 'public') 'opencodex-link-tray.png')
    )
    $bitmap = $null
    foreach ($iconPath in $iconPaths) {
        if (Test-Path -LiteralPath $iconPath) {
            $bitmap = New-Object System.Drawing.Bitmap $iconPath
            $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
            break
        }
    }

    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = $icon
    $notify.Visible = $true
    $notify.Text = 'OpenCodex Link'
    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $openItem = $menu.Items.Add('打开管理台')
    $addItem = $menu.Items.Add('添加手机')
    $connItem = $menu.Items.Add('查看连接信息')
    $null = $menu.Items.Add('-')
    $startItem = $menu.Items.Add('启动服务')
    $stopItem = $menu.Items.Add('停止服务')
    $autoItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $autoItem.Text = '开机自启动'
    $autoItem.CheckOnClick = $true
    $autoItem.Checked = Get-OpenCodexLinkAutoStart -RunKeyPath $RunKeyPath
    [void]$menu.Items.Add($autoItem)
    $null = $menu.Items.Add('-')
    $exitItem = $menu.Items.Add('退出')

    function Refresh-OpenCodexLinkMenu {
        Update-OpenCodexLinkTrayStatus
        $running = $script:state.StatusText -eq 'running'
        if ($running) { $notify.Text = 'OpenCodex Link - 运行中' } else { $notify.Text = 'OpenCodex Link - 已停止' }
        if ($script:state.StatusText -eq 'error') { $notify.Text = 'OpenCodex Link - 异常' }
        $startItem.Enabled = -not $running
        $stopItem.Enabled = $running
    }

    $openItem.add_Click({ Open-OpenCodexLinkConsole })
    $addItem.add_Click({ Open-OpenCodexLinkConsole -Hash '#add-phone' })
    $connItem.add_Click({ Start-Process ('http://127.0.0.1:{0}/setup/connection' -f $script:state.Port) | Out-Null })
    $startItem.add_Click({ Start-OpenCodexLinkOwnedService; Refresh-OpenCodexLinkMenu })
    $stopItem.add_Click({ Stop-OpenCodexLinkOwnedService; Refresh-OpenCodexLinkMenu })
    $autoItem.add_CheckedChanged({
        Set-OpenCodexLinkAutoStart -Enabled $autoItem.Checked -InstallRoot $script:state.InstallRoot -RunKeyPath $script:state.RunKeyPath
        Write-OpenCodexLinkJson -Path (Join-Path $script:state.DataDir 'settings.json') -Object ([pscustomobject]@{
            schema = 1
            autoStart = [bool]$autoItem.Checked
            openConsoleOnStart = $true
            keepRunningWhenBrowserCloses = $true
        })
    })
    $exitItem.add_Click({
        $answer = [System.Windows.Forms.MessageBox]::Show(
            '退出托盘时是否同时停止后台服务？',
            'OpenCodex Link',
            [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )
        if ($answer -eq [System.Windows.Forms.DialogResult]::Cancel) { return }
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            try { Stop-OpenCodexLinkOwnedService } catch { }
        }
        $script:state.ExitRequested = $true
        [System.Windows.Forms.Application]::Exit()
    })
    $notify.add_DoubleClick({ Open-OpenCodexLinkConsole })
    $notify.ContextMenuStrip = $menu

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 50
    $timer.add_Tick({
        Receive-OpenCodexLinkTrayIpc
        if ($script:state.ExitRequested) { [System.Windows.Forms.Application]::Exit() }
        Refresh-OpenCodexLinkMenu
    })
    $timer.Start()
    Refresh-OpenCodexLinkMenu
    [System.Windows.Forms.Application]::Run()
    $timer.Stop()
    $notify.Visible = $false
    $notify.Dispose()
    if ($bitmap) { $bitmap.Dispose() }
}

$script:state.ExitRequested = $true
Receive-OpenCodexLinkTrayIpc
if ($Headless) {
    try { Stop-OpenCodexLinkOwnedService } catch { }
}
Start-Sleep -Milliseconds 400
try { $pipeWorker.Stop() } catch { }
try { $pipeWorker.Dispose() } catch { }
try { $pipeRunspace.Close() } catch { }
$trayPath = Join-Path $DataDir 'tray.json'
$currentTray = Read-OpenCodexLinkJson $trayPath
if ($currentTray -and [int]$currentTray.trayPid -eq $PID) {
    Remove-Item -LiteralPath $trayPath -Force -ErrorAction SilentlyContinue
}
try { $mutex.ReleaseMutex() } catch { }
$mutex.Dispose()
