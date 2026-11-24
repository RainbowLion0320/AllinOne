$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ServerUrl = if ($env:ALLINONE_SERVER) { $env:ALLINONE_SERVER.TrimEnd('/') } else { 'https://your-relay.example.com' }
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$InstallDir = Join-Path $HomeDir '.allinone-bridge'
$BridgeFile = Join-Path $InstallDir 'allinone-bridge.mjs'
$DownloadUrl = "$ServerUrl/downloads/allinone-bridge.mjs"

Write-Host ''
Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host '  All in One - PC Bridge Quick Setup (Windows)' -ForegroundColor Cyan
Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host "  Server: $ServerUrl" -ForegroundColor Gray
Write-Host ''

function Find-NodeExe {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
        return $cmd.Source
    }
    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    }
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    }
    if ($env:USERPROFILE) {
        $candidates += (Join-Path $env:USERPROFILE '.dsh\runtime\node\node.exe')
    }
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

$NodeExe = Find-NodeExe
if (-not $NodeExe) {
    Write-Host '[!] Node.js v20+ (Node 22 LTS recommended) was not found on this PC.' -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host '    You can install Node.js LTS automatically with:' -ForegroundColor White
        Write-Host '    winget install OpenJS.NodeJS.LTS' -ForegroundColor Green
        $ans = Read-Host 'Install Node.js LTS now via winget? [Y/n]'
        if (-not $ans -or $ans -match '^[Yy]') {
            & winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
            $NodeExe = Find-NodeExe
        }
    }
    if (-not $NodeExe) {
        Write-Host ''
        Write-Host 'Please install Node.js LTS (v20+, Node 22 LTS recommended) from https://nodejs.org/ and re-run this command.' -ForegroundColor Red
        return
    }
}

$nodeVerText = (& $NodeExe -v).Trim()
$nodeMajor = 0
if ($nodeVerText -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 20) {
    Write-Host "[!] Found Node.js $nodeVerText, but Node.js v20+ (Node 22 LTS recommended) is required. Please upgrade at https://nodejs.org/" -ForegroundColor Red
    return
}
Write-Host "[1/3] Node.js ready: $nodeVerText ($NodeExe)" -ForegroundColor Green

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "[2/3] Downloading portable bridge bundle..." -ForegroundColor Cyan
Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $BridgeFile

$DesktopDir = [Environment]::GetFolderPath('Desktop')
if ($DesktopDir -and (Test-Path $DesktopDir)) {
    $LauncherPath = Join-Path $DesktopDir 'All in One Bridge.cmd'
    $LauncherContent = @(
        '@echo off',
        'chcp 65001 >nul',
        'title All in One PC Bridge',
        "`"$NodeExe`" `"$BridgeFile`" --server `"$ServerUrl`"",
        'pause'
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($LauncherPath, $LauncherContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[3/3] Created Desktop shortcut: $LauncherPath" -ForegroundColor Green
} else {
    Write-Host '[3/3] Setup files saved.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Starting All in One PC Bridge (sign in with your account to bind this PC)...' -ForegroundColor Cyan
Write-Host ''
& $NodeExe $BridgeFile --server $ServerUrl
