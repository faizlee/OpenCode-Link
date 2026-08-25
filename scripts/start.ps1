param(
    [string]$Password = $env:CODEX_PWA_PASSWORD
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not $Password) {
    throw '请先设置 CODEX_PWA_PASSWORD，或用 -Password 参数传入访问密码。'
}

$env:CODEX_PWA_PASSWORD = $Password
if (-not (Test-Path -LiteralPath 'node_modules')) {
    npm install
}
if (-not (Test-Path -LiteralPath 'dist') -or -not (Test-Path -LiteralPath 'dist-server')) {
    npm run build
}
npm start

