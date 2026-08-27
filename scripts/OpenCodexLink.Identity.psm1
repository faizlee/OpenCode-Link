Set-StrictMode -Version Latest

function Get-OpenCodexLinkProductId {
    return 'OpenCodexLink'
}

function Get-OpenCodexLinkLiveDataRoot {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { return '' }
    return [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'OpenCodexLink'))
}

function Get-OpenCodexLinkNormalizedPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try {
        return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant()
    } catch {
        return $Path.Trim().TrimEnd('\', '/').ToLowerInvariant()
    }
}

function Test-OpenCodexLinkSamePath {
    param([string]$Left, [string]$Right)
    return (Get-OpenCodexLinkNormalizedPath $Left) -eq (Get-OpenCodexLinkNormalizedPath $Right)
}

function Test-OpenCodexLinkLiveDataRoot {
    param([string]$DataDir)
    $live = Get-OpenCodexLinkLiveDataRoot
    if ([string]::IsNullOrWhiteSpace($live) -or [string]::IsNullOrWhiteSpace($DataDir)) { return $false }
    return Test-OpenCodexLinkSamePath $DataDir $live
}

function Assert-OpenCodexLinkTestIsolation {
    param([string]$DataDir, [int]$Port)
    if ($Port -eq 8787) {
        throw 'Refusing to use live port 8787 in isolated tests.'
    }
    if (Test-OpenCodexLinkLiveDataRoot $DataDir) {
        throw 'Refusing to use live LOCALAPPDATA data directory in isolated tests.'
    }
}

function Get-OpenCodexLinkHealthRefreshIntervalMs {
    return 800
}

function Test-OpenCodexLinkHealthRefreshDue {
    param(
        [Parameter(Mandatory = $true)][datetime]$Now,
        [Parameter(Mandatory = $true)][datetime]$LastAt,
        [int]$IntervalMs = 0
    )
    if ($IntervalMs -le 0) { $IntervalMs = Get-OpenCodexLinkHealthRefreshIntervalMs }
    if ($LastAt -eq [datetime]::MinValue) { return $true }
    return (($Now - $LastAt).TotalMilliseconds -ge $IntervalMs)
}

function Get-OpenCodexLinkNote {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Read-OpenCodexLinkJson {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Write-OpenCodexLinkJson {
    param([string]$Path, $Object)
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    $json = $Object | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function Get-OpenCodexLinkInstallIdentity {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $root = [IO.Path]::GetFullPath($InstallRoot)
    $version = '0.0.0'
    $pkg = Read-OpenCodexLinkJson (Join-Path $root 'package.json')
    if ($pkg -and $pkg.version) { $version = [string]$pkg.version }
    $buildId = $version + '-dev'
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PWA_BUILD_ID)) {
        $buildId = $env:CODEX_PWA_BUILD_ID
    } else {
        $build = Read-OpenCodexLinkJson (Join-Path $root 'build-info.json')
        if ($build -and $build.buildId) { $buildId = [string]$build.buildId }
    }
    return [pscustomobject]@{
        ProductId = Get-OpenCodexLinkProductId
        Version = $version
        BuildId = $buildId
        InstallRoot = $root
    }
}

function Test-OpenCodexLinkServiceCommandLine {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    if ($CommandLine -match 'dist-server[/\\]index\.js') { return $true }
    if ($CommandLine -match 'tsx[^\\r\\n]*server[/\\]index\.ts') { return $true }
    return $false
}

function Test-OpenCodexLinkProductFiles {
    param([string]$InstallRoot)
    if ([string]::IsNullOrWhiteSpace($InstallRoot) -or -not (Test-Path -LiteralPath $InstallRoot)) { return $false }
    $pkgPath = Join-Path $InstallRoot 'package.json'
    $cmdPath = Join-Path $InstallRoot 'OpenCodex Link.cmd'
    $serverPath = Join-Path (Join-Path $InstallRoot 'dist-server') 'index.js'
    $hasPkg = $false
    $pkg = Read-OpenCodexLinkJson $pkgPath
    if ($pkg -and $pkg.name -eq 'codex-pwa') { $hasPkg = $true }
    return [bool]($hasPkg -and (Test-Path -LiteralPath $cmdPath) -and (Test-Path -LiteralPath $serverPath))
}

function Test-OpenCodexLinkProcessStartTime {
    param($ProcessStartTime, $ReceiptStartedAt)
    if ($null -eq $ProcessStartTime -or [string]::IsNullOrWhiteSpace([string]$ReceiptStartedAt)) { return $true }
    try {
        $created = [datetime]$ProcessStartTime
        $started = [datetime]$ReceiptStartedAt
        return $created -le $started.ToUniversalTime().AddSeconds(30).ToLocalTime() -or $created -le $started.AddSeconds(30)
    } catch {
        return $false
    }
}

function Get-OpenCodexLinkOccupantClass {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)]$Candidate
    )

    $productId = Get-OpenCodexLinkProductId
    $hasListener = [bool](Get-OpenCodexLinkNote $Evidence 'HasListener')
    $processExists = [bool](Get-OpenCodexLinkNote $Evidence 'ProcessExists')
    $commandLine = [string](Get-OpenCodexLinkNote $Evidence 'CommandLine')
    $hasProductFiles = [bool](Get-OpenCodexLinkNote $Evidence 'HasProductFiles')
    $health = Get-OpenCodexLinkNote $Evidence 'Health'
    $runtimeHttp = Get-OpenCodexLinkNote $Evidence 'RuntimeHttp'
    $runtimeFile = Get-OpenCodexLinkNote $Evidence 'RuntimeFile'
    $healthOk = $false
    $healthOkValue = Get-OpenCodexLinkNote $health 'ok'
    if ($healthOkValue) { $healthOk = [bool]$healthOkValue }

    if (-not $hasListener) {
        $stalePid = Get-OpenCodexLinkNote $runtimeFile 'servicePid'
        if ($stalePid -and -not $processExists) {
            return 'StalePid'
        }
        return 'Free'
    }

    $httpProduct = $false
    if ((Get-OpenCodexLinkNote $runtimeHttp 'productId') -eq $productId) { $httpProduct = $true }
    if ((Get-OpenCodexLinkNote $health 'productId') -eq $productId) { $httpProduct = $true }

    $legacyProduct = $false
    if ($healthOk -and (Test-OpenCodexLinkServiceCommandLine $commandLine) -and $hasProductFiles -and -not $runtimeHttp) {
        $legacyProduct = $true
    }

    if ($runtimeFile -and $runtimeHttp) {
        $fileInstance = [string](Get-OpenCodexLinkNote $runtimeFile 'instanceId')
        $httpInstance = [string](Get-OpenCodexLinkNote $runtimeHttp 'instanceId')
        $fileRoot = Get-OpenCodexLinkNormalizedPath ([string](Get-OpenCodexLinkNote $runtimeFile 'installRoot'))
        $httpRoot = Get-OpenCodexLinkNormalizedPath ([string](Get-OpenCodexLinkNote $runtimeHttp 'installRoot'))
        if ($fileInstance -and $httpInstance -and $fileInstance -ne $httpInstance) { return 'Unproven' }
        if ($fileRoot -and $httpRoot -and $fileRoot -ne $httpRoot) { return 'Unproven' }
    }

    if ($runtimeFile -and $processExists) {
        if (-not (Test-OpenCodexLinkProcessStartTime (Get-OpenCodexLinkNote $Evidence 'ProcessStartTime') (Get-OpenCodexLinkNote $runtimeFile 'startedAt'))) {
            return 'Unproven'
        }
    }

    $proven = $false
    if ($processExists -and (Test-OpenCodexLinkServiceCommandLine $commandLine) -and ($httpProduct -or $legacyProduct)) {
        $proven = $true
    }

    if (-not $proven) { return 'Unknown' }

    $occupantRoot = ''
    $httpRootValue = Get-OpenCodexLinkNote $runtimeHttp 'installRoot'
    $fileRootValue = Get-OpenCodexLinkNote $runtimeFile 'installRoot'
    $workingDirectory = Get-OpenCodexLinkNote $Evidence 'WorkingDirectory'
    if ($httpRootValue) { $occupantRoot = [string]$httpRootValue }
    elseif ($fileRootValue) { $occupantRoot = [string]$fileRootValue }
    elseif ($workingDirectory) { $occupantRoot = [string]$workingDirectory }

    $occupantVersion = ''
    $httpVersion = Get-OpenCodexLinkNote $runtimeHttp 'version'
    $fileVersion = Get-OpenCodexLinkNote $runtimeFile 'version'
    $healthVersion = Get-OpenCodexLinkNote $health 'version'
    if ($httpVersion) { $occupantVersion = [string]$httpVersion }
    elseif ($fileVersion) { $occupantVersion = [string]$fileVersion }
    elseif ($healthVersion) { $occupantVersion = [string]$healthVersion }

    $sameRoot = Test-OpenCodexLinkSamePath $occupantRoot $Candidate.InstallRoot
    $sameVersion = [string]$Candidate.Version -eq $occupantVersion
    if (-not $occupantVersion) { $sameVersion = $sameRoot }

    if ($sameRoot -and $sameVersion) { return 'Current' }
    return 'Predecessor'
}

function Test-OpenCodexLinkSafeToStop {
    param([string]$Class)
    return @('Current', 'Predecessor') -contains $Class
}

function Test-OpenCodexLinkRuntimeProof {
    param($Occupant)
    if (-not $Occupant) { return $false }
    $file = $Occupant.RuntimeFile
    if (-not $file) { return $false }
    if ([string]$file.productId -ne (Get-OpenCodexLinkProductId)) { return $false }
    if ($Occupant.Pid -le 0) { return $false }
    if ([int]$file.servicePid -ne [int]$Occupant.Pid) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$file.installRoot)) { return $false }
    $http = $null
    if ($Occupant.Evidence) { $http = $Occupant.Evidence.RuntimeHttp }
    if ($http) {
        if ([string]$http.productId -ne (Get-OpenCodexLinkProductId)) { return $false }
        if (-not (Test-OpenCodexLinkSamePath ([string]$http.installRoot) ([string]$file.installRoot))) { return $false }
        if ([string]$http.instanceId -and [string]$file.instanceId -and [string]$http.instanceId -ne [string]$file.instanceId) { return $false }
    }
    return $true
}

function New-OpenCodexLinkTrayRecord {
    param(
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)]$Identity,
        [Parameter(Mandatory = $true)][string]$PipeName
    )
    $record = [pscustomobject]@{
        schema = 1
        productId = Get-OpenCodexLinkProductId
        trayPid = $PID
        version = [string]$Identity.Version
        buildId = [string]$Identity.BuildId
        installRoot = [string]$Identity.InstallRoot
        startedAt = [DateTime]::UtcNow.ToString('o')
        controlPipe = $PipeName
    }
    $path = Join-Path $DataDir 'tray.json'
    Write-OpenCodexLinkJson -Path $path -Object $record
    return $path
}

function Get-OpenCodexLinkPortListener {
    param([int]$Port)
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $connection) { return $null }
    return [pscustomobject]@{
        Port = $Port
        Pid = [int]$connection.OwningProcess
    }
}

function Get-OpenCodexLinkProcessInfo {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $created = $null
    try { $created = $process.ConvertToDateTime($process.CreationDate) } catch { $created = $null }
    return [pscustomobject]@{
        Pid = $ProcessId
        CommandLine = [string]$process.CommandLine
        ExecutablePath = [string]$process.ExecutablePath
        ProcessStartTime = $created
    }
}

function Get-OpenCodexLinkHttpJson {
    param([string]$Uri, [int]$TimeoutSec = 2)
    try {
        $result = Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec
        if ($null -eq $result -or $result -is [string]) { return $null }
        return $result
    } catch {
        return $null
    }
}

function Get-OpenCodexLinkLiveOccupant {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)]$Candidate
    )

    $listener = Get-OpenCodexLinkPortListener $Port
    $runtimeFile = Read-OpenCodexLinkJson (Join-Path $DataDir 'runtime.json')
    $trayFile = Read-OpenCodexLinkJson (Join-Path $DataDir 'tray.json')
    $pidToInspect = 0
    if ($listener) { $pidToInspect = [int]$listener.Pid }
    elseif ($runtimeFile -and $runtimeFile.servicePid) { $pidToInspect = [int]$runtimeFile.servicePid }

    $processInfo = $null
    if ($pidToInspect -gt 0) { $processInfo = Get-OpenCodexLinkProcessInfo $pidToInspect }

    $health = Get-OpenCodexLinkHttpJson ("http://127.0.0.1:{0}/api/health" -f $Port)
    $runtimeHttp = Get-OpenCodexLinkHttpJson ("http://127.0.0.1:{0}/api/runtime" -f $Port)

    $workingDirectory = ''
    $hasProductFiles = $false
    if ($runtimeHttp -and $runtimeHttp.installRoot) {
        $workingDirectory = [string]$runtimeHttp.installRoot
        $hasProductFiles = Test-OpenCodexLinkProductFiles $workingDirectory
    } elseif ($runtimeFile -and $runtimeFile.installRoot) {
        $workingDirectory = [string]$runtimeFile.installRoot
        $hasProductFiles = Test-OpenCodexLinkProductFiles $workingDirectory
    } elseif ($Candidate.InstallRoot) {
        $hasProductFiles = Test-OpenCodexLinkProductFiles $Candidate.InstallRoot
    }

    $commandLine = ''
    $exists = $false
    $startTime = $null
    if ($processInfo) {
        $commandLine = $processInfo.CommandLine
        $exists = $true
        $startTime = $processInfo.ProcessStartTime
    }

    $evidence = [pscustomobject]@{
        HasListener = [bool]$listener
        ListenerPid = $(if ($listener) { [int]$listener.Pid } else { 0 })
        ProcessExists = $exists
        ProcessStartTime = $startTime
        CommandLine = $commandLine
        WorkingDirectory = $workingDirectory
        HasProductFiles = $hasProductFiles
        Health = $health
        RuntimeHttp = $runtimeHttp
        RuntimeFile = $runtimeFile
        TrayFile = $trayFile
    }

    $class = Get-OpenCodexLinkOccupantClass -Evidence $evidence -Candidate $Candidate
    return [pscustomobject]@{
        Class = $class
        Port = $Port
        Pid = $(if ($listener) { [int]$listener.Pid } else { 0 })
        Evidence = $evidence
        RuntimeFile = $runtimeFile
        TrayFile = $trayFile
        SafeToStop = (Test-OpenCodexLinkSafeToStop $class)
    }
}

function Send-OpenCodexLinkTrayCommand {
    param(
        [Parameter(Mandatory = $true)][string]$PipeName,
        $Command,
        [int]$TimeoutMs = 4000
    )
    $client = $null
    try {
        $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None)
        $client.Connect($TimeoutMs)
        $writer = New-Object System.IO.StreamWriter($client)
        $writer.AutoFlush = $true
        $reader = New-Object System.IO.StreamReader($client)
        $payload = $Command
        if ($Command -isnot [string]) { $payload = ($Command | ConvertTo-Json -Compress -Depth 6) }
        $writer.WriteLine([string]$payload)
        $line = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) { return $null }
        return $line | ConvertFrom-Json
    } finally {
        if ($client) { $client.Dispose() }
    }
}

function Get-OpenCodexLinkAutoStartCommand {
    param([string]$InstallRoot)
    $tray = Join-Path (Join-Path $InstallRoot 'scripts') 'tray.ps1'
    return "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File `"$tray`" -NoBuild"
}

function Get-OpenCodexLinkAutoStart {
    param([string]$RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run')
    if (-not (Test-Path -LiteralPath $RunKeyPath)) { return $false }
    $item = Get-ItemProperty -LiteralPath $RunKeyPath
    $value = Get-OpenCodexLinkNote $item 'OpenCodexLink'
    return -not [string]::IsNullOrWhiteSpace([string]$value)
}

function Set-OpenCodexLinkAutoStart {
    param(
        [bool]$Enabled,
        [string]$InstallRoot,
        [string]$RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    )
    $name = 'OpenCodexLink'
    if ($Enabled) {
        if (-not (Test-Path -LiteralPath $RunKeyPath)) {
            New-Item -Path $RunKeyPath -Force | Out-Null
        }
        New-ItemProperty -LiteralPath $RunKeyPath -Name $name -Value (Get-OpenCodexLinkAutoStartCommand $InstallRoot) -PropertyType String -Force | Out-Null
    } else {
        if (Test-Path -LiteralPath $RunKeyPath) {
            Remove-ItemProperty -LiteralPath $RunKeyPath -Name $name -ErrorAction SilentlyContinue
        }
    }
}

function Get-OpenCodexLinkPortableRequiredRelativePaths {
    return @(
        'dist\index.html',
        'dist-server\index.js',
        'runtime\node.exe',
        'scripts\tray.ps1',
        'scripts\launch.ps1',
        'scripts\stop.ps1',
        'scripts\OpenCodexLink.Identity.psm1',
        'scripts\OpenCodexLink.Service.psm1',
        'assets\tray.png',
        'OpenCodex Link.cmd',
        'Stop OpenCodex Link.cmd',
        'README.md',
        'package.json',
        'package-lock.json',
        'build-info.json',
        'node_modules\express\package.json'
    )
}

function Get-OpenCodexLinkPortableForbiddenRelativePaths {
    return @(
        '.env',
        'src',
        'server',
        'trusted-devices.json',
        'scripts\OpenCodexLink.Tests.ps1',
        'scripts\OpenCodexLink.Package.Tests.ps1',
        'scripts\OpenCodexLink.TrayIpc.Tests.ps1'
    )
}

function Test-OpenCodexLinkPortablePackageRoot {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)
    foreach ($rel in Get-OpenCodexLinkPortableRequiredRelativePaths) {
        $path = Join-Path $PackageRoot $rel
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Portable package is missing $rel"
        }
    }
    foreach ($rel in Get-OpenCodexLinkPortableForbiddenRelativePaths) {
        $path = Join-Path $PackageRoot $rel
        if (Test-Path -LiteralPath $path) {
            throw "Portable package must not contain $rel"
        }
    }
    $build = Read-OpenCodexLinkJson (Join-Path $PackageRoot 'build-info.json')
    if (-not $build) { throw 'build-info.json is missing or unreadable.' }
    if ((Get-OpenCodexLinkNote $build 'productId') -ne (Get-OpenCodexLinkProductId)) {
        throw 'build-info.json productId is missing.'
    }
    if ([string]::IsNullOrWhiteSpace([string](Get-OpenCodexLinkNote $build 'version'))) {
        throw 'build-info.json version is missing.'
    }
    if ([string]::IsNullOrWhiteSpace([string](Get-OpenCodexLinkNote $build 'buildId'))) {
        throw 'build-info.json buildId is missing.'
    }
}

function Get-OpenCodexLinkPortableZipEntryNames {
    param([Parameter(Mandatory = $true)][string[]]$Names)
    return @(
        $Names |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { (($_ -replace '\\', '/').Trim() -replace '^\./', '').TrimEnd('/') }
    )
}

function Test-OpenCodexLinkPortableZipHasPackagePath {
    param(
        [Parameter(Mandatory = $true)][string[]]$Entries,
        [Parameter(Mandatory = $true)][string]$RelativeUnix
    )
    $relativeUnix = $RelativeUnix.Trim().TrimStart('/').TrimEnd('/')
    foreach ($entry in $Entries) {
        if ($entry -eq $relativeUnix -or $entry.StartsWith("$relativeUnix/")) { return $true }
        if ($entry -eq "OpenCodexLink/$relativeUnix" -or $entry.StartsWith("OpenCodexLink/$relativeUnix/")) { return $true }
    }
    return $false
}

function Test-OpenCodexLinkPortableZipEntries {
    param([Parameter(Mandatory = $true)][string[]]$Names)
    $entries = Get-OpenCodexLinkPortableZipEntryNames -Names $Names
    if ($entries | Where-Object { $_ -eq '.env' -or $_ -eq 'OpenCodexLink/.env' -or $_ -match '(^|/)\.env$' }) {
        throw 'Portable zip must not contain .env.'
    }
    foreach ($forbidden in @('src', 'server')) {
        if (Test-OpenCodexLinkPortableZipHasPackagePath -Entries $entries -RelativeUnix $forbidden) {
            throw "Portable zip must not contain $forbidden."
        }
    }
    if ($entries | Where-Object { $_ -match '(^|/)trusted-devices\.json$' }) {
        throw 'Portable zip must not contain trusted-devices.json.'
    }
    foreach ($rel in @('scripts/OpenCodexLink.Tests.ps1', 'scripts/OpenCodexLink.Package.Tests.ps1', 'scripts/OpenCodexLink.TrayIpc.Tests.ps1')) {
        if (Test-OpenCodexLinkPortableZipHasPackagePath -Entries $entries -RelativeUnix $rel) {
            throw "Portable zip must not contain $rel."
        }
    }
    $required = @(
        'dist/index.html',
        'dist-server/index.js',
        'runtime/node.exe',
        'scripts/tray.ps1',
        'scripts/launch.ps1',
        'scripts/stop.ps1',
        'scripts/OpenCodexLink.Identity.psm1',
        'scripts/OpenCodexLink.Service.psm1',
        'assets/tray.png',
        'OpenCodex Link.cmd',
        'Stop OpenCodex Link.cmd',
        'README.md',
        'package.json',
        'package-lock.json',
        'build-info.json',
        'node_modules/express/package.json'
    )
    foreach ($rel in $required) {
        if (-not (Test-OpenCodexLinkPortableZipHasPackagePath -Entries $entries -RelativeUnix $rel)) {
            throw "Portable zip must contain $rel."
        }
    }
}

function Test-OpenCodexLinkPortableZip {
    param([Parameter(Mandatory = $true)][string]$ZipPath)
    if (-not (Test-Path -LiteralPath $ZipPath)) { throw "Zip not found: $ZipPath" }
    $names = & tar.exe -tf $ZipPath
    if ($LASTEXITCODE -ne 0) { throw 'Unable to list portable zip contents.' }
    Test-OpenCodexLinkPortableZipEntries -Names @($names)
}

function Test-OpenCodexLinkPowerShellSyntax {
    param([Parameter(Mandatory = $true)][string]$Path)
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $first = $errors[0]
        throw ("PowerShell 5.1 syntax error in {0}: {1}" -f $Path, $first.Message)
    }
}

Export-ModuleMember -Function @(
    'Get-OpenCodexLinkProductId',
    'Get-OpenCodexLinkLiveDataRoot',
    'Get-OpenCodexLinkNormalizedPath',
    'Test-OpenCodexLinkSamePath',
    'Test-OpenCodexLinkLiveDataRoot',
    'Assert-OpenCodexLinkTestIsolation',
    'Get-OpenCodexLinkHealthRefreshIntervalMs',
    'Test-OpenCodexLinkHealthRefreshDue',
    'Get-OpenCodexLinkNote',
    'Read-OpenCodexLinkJson',
    'Write-OpenCodexLinkJson',
    'Get-OpenCodexLinkInstallIdentity',
    'Test-OpenCodexLinkServiceCommandLine',
    'Test-OpenCodexLinkProductFiles',
    'Get-OpenCodexLinkOccupantClass',
    'Test-OpenCodexLinkSafeToStop',
    'Test-OpenCodexLinkRuntimeProof',
    'New-OpenCodexLinkTrayRecord',
    'Get-OpenCodexLinkPortListener',
    'Get-OpenCodexLinkProcessInfo',
    'Get-OpenCodexLinkHttpJson',
    'Get-OpenCodexLinkLiveOccupant',
    'Send-OpenCodexLinkTrayCommand',
    'Get-OpenCodexLinkAutoStartCommand',
    'Get-OpenCodexLinkAutoStart',
    'Set-OpenCodexLinkAutoStart',
    'Get-OpenCodexLinkPortableRequiredRelativePaths',
    'Get-OpenCodexLinkPortableForbiddenRelativePaths',
    'Test-OpenCodexLinkPortablePackageRoot',
    'Get-OpenCodexLinkPortableZipEntryNames',
    'Test-OpenCodexLinkPortableZipHasPackagePath',
    'Test-OpenCodexLinkPortableZipEntries',
    'Test-OpenCodexLinkPortableZip',
    'Test-OpenCodexLinkPowerShellSyntax'
)
