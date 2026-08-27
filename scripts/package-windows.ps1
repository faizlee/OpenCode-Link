$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$packageRoot = Join-Path $releaseRoot 'OpenCodexLink'
$zipPath = Join-Path $releaseRoot 'OpenCodexLink-Windows.zip'

$resolvedProject = [IO.Path]::GetFullPath($projectRoot)
$resolvedPackage = [IO.Path]::GetFullPath($packageRoot)
if (-not $resolvedPackage.StartsWith($resolvedProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a package path outside the project.'
}

$environmentPath = Join-Path $packageRoot '.env'
$environmentContent = if (Test-Path -LiteralPath $environmentPath) {
    Get-Content -LiteralPath $environmentPath -Raw
} else {
    $null
}

Set-Location -LiteralPath $projectRoot
npm.cmd run build

if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Force -Path $packageRoot, (Join-Path $packageRoot 'scripts'), (Join-Path $packageRoot 'runtime') | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination $packageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist-server') -Destination $packageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json'), (Join-Path $projectRoot 'package-lock.json') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\launch.ps1'), (Join-Path $projectRoot 'scripts\stop.ps1') -Destination (Join-Path $packageRoot 'scripts')
Copy-Item -LiteralPath (Join-Path $projectRoot 'OpenCodex Link.cmd'), (Join-Path $projectRoot 'Stop OpenCodex Link.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $packageRoot

$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $packageRoot 'runtime\node.exe')

Push-Location $packageRoot
try { npm.cmd ci --omit=dev --ignore-scripts } finally { Pop-Location }

& tar.exe -a -c -f $zipPath -C $releaseRoot 'OpenCodexLink'
if ($LASTEXITCODE -ne 0) { throw "Archive creation failed with exit code $LASTEXITCODE" }
if ($null -ne $environmentContent) {
    Set-Content -LiteralPath $environmentPath -Value $environmentContent -NoNewline -Encoding ascii
}
Write-Host "Created: $zipPath"
