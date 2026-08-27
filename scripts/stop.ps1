$ErrorActionPreference = 'Stop'
$listener = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
    Write-Host 'OpenCodex Link is not running.'
    exit 0
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if (-not $process -or $process.CommandLine -notmatch 'dist-server[/\\]index\.js') {
    throw "Port 8787 belongs to another program. Nothing was stopped. PID: $($listener.OwningProcess)"
}

Stop-Process -Id $listener.OwningProcess
Write-Host 'OpenCodex Link stopped.'
