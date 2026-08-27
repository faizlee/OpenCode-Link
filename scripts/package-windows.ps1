$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Import-Module -Force -Global (Join-Path $PSScriptRoot 'OpenCodexLink.Identity.psm1')

$releaseRoot = Join-Path $projectRoot 'release'
$overlayRoot = Join-Path $releaseRoot 'OpenCodexLink'
$stageRoot = Join-Path $releaseRoot 'stage'
$packageRoot = Join-Path $stageRoot 'OpenCodexLink'
$zipPath = Join-Path $releaseRoot 'OpenCodexLink-Windows.zip'

$resolvedProject = [IO.Path]::GetFullPath($projectRoot)
$resolvedStage = [IO.Path]::GetFullPath($stageRoot)
if (-not $resolvedStage.StartsWith($resolvedProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a package path outside the project.'
}

$environmentPath = Join-Path $overlayRoot '.env'
$environmentContent = $null
if (Test-Path -LiteralPath $environmentPath) {
    $environmentContent = Get-Content -LiteralPath $environmentPath -Raw
}

Set-Location -LiteralPath $projectRoot
npm.cmd run build
node.exe (Join-Path $PSScriptRoot 'generate-icons.mjs')

if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$scriptsDest = Join-Path $packageRoot 'scripts'
$runtimeDest = Join-Path $packageRoot 'runtime'
$assetsDest = Join-Path $packageRoot 'assets'
New-Item -ItemType Directory -Force -Path $packageRoot, $scriptsDest, $runtimeDest, $assetsDest | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination $packageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist-server') -Destination $packageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'OpenCodex Link.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'Stop OpenCodex Link.cmd') -Destination $packageRoot

foreach ($name in @('launch.ps1', 'stop.ps1', 'tray.ps1', 'OpenCodexLink.Identity.psm1', 'OpenCodexLink.Service.psm1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $scriptsDest
}

$trayPng = Join-Path (Join-Path $projectRoot 'public') 'opencodex-link-tray.png'
if (-not (Test-Path -LiteralPath $trayPng)) {
    throw 'Tray icon was not generated.'
}
Copy-Item -LiteralPath $trayPng -Destination (Join-Path $assetsDest 'tray.png')

$pkg = Read-OpenCodexLinkJson (Join-Path $projectRoot 'package.json')
$version = '0.0.0'
if ($pkg -and $pkg.version) { $version = [string]$pkg.version }
$buildId = $version + '+' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
Write-OpenCodexLinkJson -Path (Join-Path $packageRoot 'build-info.json') -Object ([pscustomobject]@{
    productId = Get-OpenCodexLinkProductId
    version = $version
    buildId = $buildId
})

$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $runtimeDest 'node.exe')

Push-Location $packageRoot
try { npm.cmd ci --omit=dev --ignore-scripts } finally { Pop-Location }

try {
    Test-OpenCodexLinkPortablePackageRoot -PackageRoot $packageRoot

    & tar.exe -a -c -f $zipPath -C $stageRoot 'OpenCodexLink'
    if ($LASTEXITCODE -ne 0) { throw "Archive creation failed with exit code $LASTEXITCODE" }

    Test-OpenCodexLinkPortableZip -ZipPath $zipPath
    Write-Host "Created: $zipPath"
} finally {
    if ($null -ne $environmentContent) {
        if (-not (Test-Path -LiteralPath $overlayRoot)) {
            New-Item -ItemType Directory -Force -Path $overlayRoot | Out-Null
        }
        Set-Content -LiteralPath $environmentPath -Value $environmentContent -NoNewline -Encoding ascii
    }
}
