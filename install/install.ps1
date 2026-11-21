# SS Chromium installer for Windows. Non-interactive; safe to re-run (it upgrades).
#   irm https://raw.githubusercontent.com/LiquidLava1990/ss-chromium/main/install/install.ps1 | iex
# Options (environment variables):
#   SS_CHROMIUM_PACKAGE      npm spec to install (default: the latest GitHub release tarball)
#   SS_CHROMIUM_NO_REGISTER  1 = don't register with Claude Code / Codex
#   SS_CHROMIUM_NO_BROWSER   1 = don't download Chromium (set SS_CHROMIUM_PATH instead)
#   SS_CHROMIUM_NO_SKILL     1 = don't install the Claude skill
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$MinNodeMajor = 20
$DefaultPackage = 'https://github.com/LiquidLava1990/ss-chromium/releases/latest/download/ss-chromium.tgz'

function Get-NodeMajor {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return 0 }
    $version = (& node --version) -replace '^v', ''
    return [int]($version.Split('.')[0])
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Install-NodeIfMissing {
    if ((Get-NodeMajor) -ge $MinNodeMajor) { return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Node.js $MinNodeMajor+ is required. Install it from https://nodejs.org and run this installer again."
    }
    Write-Host "Installing Node.js LTS with winget..."
    winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Update-SessionPath
    if ((Get-NodeMajor) -lt $MinNodeMajor) {
        throw "Node.js was installed but is not on PATH yet. Open a new terminal and run this installer again."
    }
}

Install-NodeIfMissing
$package = if ($env:SS_CHROMIUM_PACKAGE) { $env:SS_CHROMIUM_PACKAGE } else { $DefaultPackage }
Write-Host "Installing ss-chromium from $package ..."
& npm install --global --no-fund --no-audit $package | Out-Host
if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE). See the npm output above." }

$installArgs = @('install')
if ($env:SS_CHROMIUM_NO_REGISTER -eq '1') { $installArgs += '--no-register' }
if ($env:SS_CHROMIUM_NO_BROWSER -eq '1') { $installArgs += '--no-browser' }
if ($env:SS_CHROMIUM_NO_SKILL -eq '1') { $installArgs += '--no-skill' }
$npmRoot = (& npm root --global).Trim()
& node (Join-Path $npmRoot 'ss-chromium\bin\ss-chromium.mjs') @installArgs
if ($LASTEXITCODE -ne 0) { throw "ss-chromium install failed (exit $LASTEXITCODE). Run 'ss-chromium doctor' for details." }
