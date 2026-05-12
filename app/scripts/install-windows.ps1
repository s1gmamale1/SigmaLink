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
if ($Arch -ne 'AMD64') {
    Write-Host ""
    Write-Host "x Only Windows x64 (AMD64) is supported in v1.2.0. Detected: $Arch" -ForegroundColor Red
    Write-Host "  ARM64 and x86 builds are tracked for a future release." -ForegroundColor Yellow
    Write-Host "  Please open or follow an issue at: $IssuesUrl" -ForegroundColor Yellow
    exit 2
}
Write-Host "-> Architecture: $Arch (x64)"

# TLS 1.2 is required for github.com on older Windows PowerShell 5.1 hosts.
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Best-effort; newer hosts already default to TLS 1.2+.
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
        Write-Host "x Failed to fetch latest release from GitHub API." -ForegroundColor Red
        Write-Host "  Possible cause: rate-limit (anonymous quota is 60/hr/IP) or no network." -ForegroundColor Yellow
        Write-Host "  Workaround: pass -Version <tag>, e.g. -Version v1.2.0" -ForegroundColor Yellow
        Write-Host "  Underlying error: $($_.Exception.Message)" -ForegroundColor Yellow
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

# electron-builder NSIS default artefact name is SigmaLink-Setup-<version>.exe.
# electron-builder.yml does not override `artifactName`, so we match that
# pattern. Reject any .blockmap or unrelated assets.
$asset = $null
foreach ($candidate in $release.assets) {
    if ($candidate.name -like 'SigmaLink-Setup-*.exe' -and $candidate.name -notlike '*.blockmap') {
        $asset = $candidate
        break
    }
}

if (-not $asset) {
    Write-Host "x No matching Windows installer asset found on release $Tag." -ForegroundColor Red
    Write-Host "  Expected an asset named like 'SigmaLink-Setup-<version>.exe'." -ForegroundColor Yellow
    Write-Host "  If this is the first Windows release, it may not be uploaded yet." -ForegroundColor Yellow
    Write-Host "  Browse: https://github.com/$Repo/releases/tag/$Tag" -ForegroundColor Yellow
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
# ProgressPreference = 'Continue' keeps the built-in PowerShell progress bar
# visible. On PS 5.1 Invoke-WebRequest is dramatically faster when progress
# is suppressed, but we leave it on so the user sees a download signal.
$progressBefore = $ProgressPreference
$ProgressPreference = 'Continue'
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
