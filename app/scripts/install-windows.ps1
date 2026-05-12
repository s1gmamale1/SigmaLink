<#
.SYNOPSIS
    SigmaLink — one-line installer for Windows (10/11, x64).

.DESCRIPTION
    Windows analogue of install-macos.sh. Downloads the latest SigmaLink NSIS
    installer (or a pinned tag) from GitHub Releases, unblocks it so Windows
    SmartScreen does NOT flag it as "from the internet", runs it, and cleans
    up the temp file.

    SigmaLink is currently unsigned with an EV certificate (procurement
    deferred until project funding). `Unblock-File` strips the Zone.Identifier
    Alternate Data Stream that Windows attaches to browser-downloaded EXEs,
    which is what triggers the SmartScreen "Don't run" prompt. Same trick
    used by chocolatey, scoop, and most curl-bash equivalents on Windows.

.PARAMETER Version
    Pin to a specific release tag (e.g. "v1.2.0"). If omitted, the latest
    GitHub release is used.

.PARAMETER Quiet
    Run the NSIS installer in silent mode (/S). No installer UI is shown.

.PARAMETER KeepInstaller
    Do not delete the downloaded EXE after the install completes. Useful for
    re-running offline or auditing the artefact.

.EXAMPLE
    iex (irm https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-windows.ps1)

.EXAMPLE
    # Pin a tag, silent install, keep the EXE
    .\install-windows.ps1 -Version v1.2.0 -Quiet -KeepInstaller

.NOTES
    Exit codes:
      0  install succeeded
      1  generic failure
      2  wrong PowerShell version or wrong arch
      3  GitHub API / network failure
      4  installer download / asset-not-found failure
      5  installer process failed
#>

[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Quiet,
    [switch]$KeepInstaller
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo      = 's1gmamale1/SigmaLink'
$AppName   = 'SigmaLink'
$IssuesUrl = "https://github.com/$Repo/issues"

# -- PowerShell version gate --------------------------------------------------

if ($PSVersionTable.PSVersion.Major -lt 5) {
    $detected = $PSVersionTable.PSVersion
    Write-Host "x PowerShell 5.0 or newer is required. Detected: $detected" -ForegroundColor Red
    Write-Host "  Upgrade Windows PowerShell, or install PowerShell 7+ from https://aka.ms/powershell" -ForegroundColor Yellow
    exit 2
}

# -- arch gate ----------------------------------------------------------------

$Arch = $env:PROCESSOR_ARCHITECTURE
# Windows 11 ARM64 can run x64 apps via emulation; allow it to pass the gate.
if ($Arch -ne 'AMD64' -and $Arch -ne 'ARM64') {
    Write-Host ""
    Write-Host "x Only Windows x64 (AMD64) and ARM64 are supported. Detected: $Arch" -ForegroundColor Red
    Write-Host "  x86 (32-bit) builds are not planned." -ForegroundColor Yellow
    Write-Host "  Please open or follow an issue at: $IssuesUrl" -ForegroundColor Yellow
    exit 2
}
Write-Host "-> Architecture: $Arch"

# TLS 1.2 is required for github.com on older Windows PowerShell 5.1 hosts.
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Best-effort; newer hosts already default to TLS 1.2+.
}

# -- admin check --------------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "-> Note: Installer may prompt for Administrator privileges (UAC)." -ForegroundColor Yellow
}

# -- resolve release ----------------------------------------------------------

$Tag = $Version
if ([string]::IsNullOrWhiteSpace($Tag)) {
    Write-Host "-> Resolving latest release from GitHub..."
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
            -UseBasicParsing `
            -Headers @{ 'User-Agent' = 'SigmaLink-Installer' }
    } catch {
        $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($statusCode -eq 403) {
            Write-Host "x GitHub API rate limit exceeded (anonymous quota is 60/hr/IP)." -ForegroundColor Red
            Write-Host "  Please try again in an hour, or pass a specific version if you have the tag." -ForegroundColor Yellow
        } else {
            Write-Host "x Failed to fetch latest release from GitHub API: $($_.Exception.Message)" -ForegroundColor Red
        }
        Write-Host "  Workaround: pass -Version <tag>, e.g. -Version v1.2.1" -ForegroundColor Yellow
        exit 3
    }
    $Tag = $release.tag_name
} else {
    Write-Host "-> Resolving pinned release $Tag from GitHub..."
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" `
            -UseBasicParsing `
            -Headers @{ 'User-Agent' = 'SigmaLink-Installer' }
    } catch {
        Write-Host "x Could not find release $Tag on $Repo." -ForegroundColor Red
        Write-Host "  Browse https://github.com/$Repo/releases to confirm the tag." -ForegroundColor Yellow
        exit 3
    }
}

if ([string]::IsNullOrWhiteSpace($Tag)) {
    Write-Host "x Could not determine a release tag." -ForegroundColor Red
    exit 3
}

Write-Host "-> Target release: $Tag"

# -- pick asset ---------------------------------------------------------------

# electron-builder NSIS default artefact name can vary between:
#   SigmaLink-Setup-<version>.exe
#   SigmaLink.Setup.<version>.exe
$asset = $null
foreach ($candidate in $release.assets) {
    # Match various separators and ensure we skip blockmaps. 
    # Use -match (regex) for robustness against . or - separators.
    if ($candidate.name -match "^SigmaLink[-.]Setup[-.](.*)\.exe$" -and $candidate.name -notlike "*.blockmap") {
        $asset = $candidate
        break
    }
}

# Fallback: find any .exe that looks like an installer if "Setup" is missing
if (-not $asset) {
    foreach ($candidate in $release.assets) {
        if ($candidate.name -match "^SigmaLink[-.](.*)\.exe$" -and $candidate.name -notlike "*.blockmap") {
            $asset = $candidate
            break
        }
    }
}

if (-not $asset) {
    Write-Host "x No matching Windows installer asset found on release $Tag." -ForegroundColor Red
    Write-Host "  Expected an asset named like 'SigmaLink-Setup-<version>.exe'." -ForegroundColor Yellow
    Write-Host "  Browse release assets: https://github.com/$Repo/releases/tag/$Tag" -ForegroundColor Yellow
    exit 4
}

$ExeUrl  = $asset.browser_download_url
$ExeSize = [math]::Round($asset.size / 1MB, 1)
Write-Host "-> Installer asset: $($asset.name) ($ExeSize MB)"

# -- download -----------------------------------------------------------------

$ExePath = Join-Path $env:TEMP 'SigmaLink-Setup.exe'
if (Test-Path $ExePath) {
    Remove-Item $ExePath -Force
}

Write-Host "-> Downloading to $ExePath ..."
# On PS 5.1 Invoke-WebRequest is dramatically faster when progress is suppressed.
# We'll show a simple "..." message instead of the heavy progress bar.
$progressBefore = $ProgressPreference
if ($PSVersionTable.PSVersion.Major -le 5) {
    $ProgressPreference = 'SilentlyContinue'
} else {
    $ProgressPreference = 'Continue'
}

try {
    Invoke-WebRequest -Uri $ExeUrl -OutFile $ExePath -UseBasicParsing `
        -Headers @{ 'User-Agent' = 'SigmaLink-Installer' }
} catch {
    $ProgressPreference = $progressBefore
    Write-Host "x Download failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 4
}
$ProgressPreference = $progressBefore

if (-not (Test-Path $ExePath) -or (Get-Item $ExePath).Length -eq 0) {
    Write-Host "x Downloaded installer is empty or missing." -ForegroundColor Red
    exit 4
}
Write-Host "-> Download complete."

# -- unblock (strip Zone.Identifier, dodge SmartScreen prompt) ----------------

try {
    Unblock-File -Path $ExePath
    Write-Host "-> Unblock-File: Zone.Identifier stripped (no SmartScreen warning)."
} catch {
    Write-Host "! Unblock-File failed; SmartScreen may still warn. Continuing." -ForegroundColor Yellow
}

# -- run installer ------------------------------------------------------------

$argList = @()
if ($Quiet) {
    # NSIS silent install flag. /S must be uppercase.
    $argList += '/S'
    Write-Host "-> Launching installer in silent mode (/S)..."
} else {
    Write-Host "-> Launching installer (interactive UI)..."
}

try {
    if ($argList.Count -gt 0) {
        $proc = Start-Process -FilePath $ExePath -ArgumentList $argList -Wait -PassThru
    } else {
        $proc = Start-Process -FilePath $ExePath -Wait -PassThru
    }
} catch {
    Write-Host "x Installer process failed to start: $($_.Exception.Message)" -ForegroundColor Red
    exit 5
}

if ($null -ne $proc -and $proc.ExitCode -ne 0) {
    Write-Host "x Installer exited with code $($proc.ExitCode)." -ForegroundColor Red
    exit 5
}

Write-Host ""
Write-Host "OK $AppName $Tag installed." -ForegroundColor Green
Write-Host ""

# -- cleanup ------------------------------------------------------------------

if ($KeepInstaller) {
    Write-Host "-> Keeping installer at: $ExePath"
} else {
    try {
        Remove-Item $ExePath -Force -ErrorAction Stop
        Write-Host "-> Cleaned up temp installer."
    } catch {
        Write-Host "! Could not remove $ExePath ($($_.Exception.Message)). Safe to delete manually." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Launch $AppName from the Start menu, or from the desktop shortcut."
