#requires -Version 5.1
<#
.SYNOPSIS
  GPU detector + automatic driver download.

.DESCRIPTION
  Detects display adapters via WMI, then:
    - NVIDIA: looks up the latest driver for the card's series through NVIDIA's
      public JSON API, downloads the installer, and (with -Install) runs it
      silently with -s -noreboot.
    - AMD / Intel: no clean silent-download API, so it opens the vendor's
      auto-detect page and points to Windows Update.

.NOTES
  Detection + download work without admin; installing needs elevation.
  Downloads land in .\gpu-drivers\ next to this script.
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$DiscoverOnly,
    [Alias('h')][switch]$Help
)

$ErrorActionPreference = 'Stop'
$script:Dir     = $PSScriptRoot
$script:LogFile = Join-Path $script:Dir 'gpu-update.log'
$script:GpuMap  = $null

function Write-Log {
    param([string]$Message, [ValidateSet('Info', 'Warn', 'Error', 'Ok')][string]$Level = 'Info')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $script:LogFile -Value $line -Encoding UTF8
    switch ($Level) {
        'Error' { Write-Host $line -ForegroundColor Red }
        'Warn'  { Write-Host $line -ForegroundColor Yellow }
        'Ok'    { Write-Host $line -ForegroundColor Green }
        default { Write-Host $line }
    }
}

function Show-Help {
    Write-Host ''
    Write-Host 'Update-Gpu.ps1 - detect GPUs and auto-download drivers' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'WHAT IT DOES' -ForegroundColor Yellow
    Write-Host '  Lists every display adapter, then:'
    Write-Host '    NVIDIA - queries NVIDIA''s public driver API for the card''s series,'
    Write-Host '             downloads the installer to .\gpu-drivers\, and (with -Install)'
    Write-Host '             runs it silently.'
    Write-Host '    AMD/Intel - opens the vendor auto-detect page (no silent API) and'
    Write-Host '             points to Windows Update.'
    Write-Host ''
    Write-Host 'QUICK USAGE' -ForegroundColor Yellow
    Write-Host '  .\Update-Gpu.ps1                     # detect + download'
    Write-Host '  .\Update-Gpu.ps1 -Install           # detect + download + silent install'
    Write-Host '  .\Update-Gpu.ps1 -DiscoverOnly      # detect + report only (no download)'
    Write-Host '  .\Update-Gpu.ps1 help               # this help'
    Write-Host ''
    Write-Host 'ARGUMENTS' -ForegroundColor Yellow
    Write-Host '  -Install       After download, run the installer silently (-s -noreboot).'
    Write-Host '  -DiscoverOnly  Report current + latest versions; download nothing.'
    Write-Host '  -Help          Show this help and exit.'
    Write-Host ''
}

function Get-GpuMap {
    if ($script:GpuMap) { return $script:GpuMap }
    $path = Join-Path $script:Dir 'gpu-map.json'
    if (-not (Test-Path $path)) { $script:GpuMap = $null; return $null }
    $script:GpuMap = Get-Content $path -Raw | ConvertFrom-Json
    return $script:GpuMap
}

function Get-Gpus {
    $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
    return @($gpus | ForEach-Object {
        [pscustomobject]@{
            Name          = [string]$_.Name
            DriverVersion = [string]$_.DriverVersion
            DriverDate    = $_.DriverDate
            PnpId         = [string]$_.PNPDeviceID
        }
    })
}

function Get-GpuVendor {
    param([string]$Name)
    if ($Name -match 'nvidia|geforce|quadro|tesla') { return 'NVIDIA' }
    if ($Name -match 'amd|radeon') { return 'AMD' }
    if ($Name -match 'intel') { return 'Intel' }
    return 'Other'
}

function Find-NvidiaSeries {
    param([string]$Name)
    $map = Get-GpuMap
    if (-not $map -or -not $map.nvidia) { return $null }
    foreach ($s in @($map.nvidia)) {
        if ($Name -match $s.pattern) { return $s }
    }
    return $null
}

function Get-NvidiaDriver {
    param([int]$Psid, [int]$Pfid)
    $osID = 57   # Windows 10 64-bit
    $u = "https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=$Psid&pfid=$Pfid&osID=$osID&languageCode=1033&beta=0&isWHQL=1&dltype=-1&dch=1&upCRD=0&sort1=0&numberOfResults=1"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
    $r = Invoke-RestMethod -Uri $u -Headers @{ 'User-Agent' = $ua } -TimeoutSec 25
    if ($r.IDS -and $r.IDS[0].downloadInfo -and $r.IDS[0].downloadInfo.Version -and $r.IDS[0].downloadInfo.DownloadURL) {
        $d = $r.IDS[0].downloadInfo
        [pscustomobject]@{
            Version = [string]$d.Version
            Name    = [System.Uri]::UnescapeDataString([string]$d.Name)
            SizeMB  = [string]$d.DownloadURLFileSize
            Url     = [string]$d.DownloadURL
        }
    }
    else { $null }
}

function Save-Driver {
    param([string]$Url, [string]$DestDir)
    if (-not (Test-Path $DestDir)) { New-Item -ItemType Directory -Path $DestDir | Out-Null }
    $file = [System.IO.Path]::GetFileName(([System.Uri]$Url).AbsolutePath)
    $dest = Join-Path $DestDir $file
    if (Test-Path $dest) { Write-Log "Already downloaded: $dest" 'Info'; return $dest }
    Write-Log "Downloading $file ..." 'Info'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
    Invoke-WebRequest -Uri $Url -OutFile $dest -UseBasicParsing -Headers @{ 'User-Agent' = $ua }
    Write-Log "Downloaded: $dest" 'Ok'
    return $dest
}

function Wait-Reboot {
    param([int]$Seconds = 5)
    if ($Seconds -le 0) { return $true }
    Write-Host ''
    Write-Host "Rebooting in $Seconds seconds. Press any key to CANCEL." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            if ([Console]::KeyAvailable) {
                [void][Console]::ReadKey($true)
                Write-Host ''
                Write-Host 'Reboot cancelled.' -ForegroundColor Green
                return $false
            }
        } catch { }
        Start-Sleep -Milliseconds 150
    }
    return $true
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
try {
    if ($Help) { Show-Help; exit 0 }

    $gpus = Get-Gpus
    if ($gpus.Count -eq 0) { Write-Log 'No display adapters detected.' 'Warn'; exit 1 }

    $destDir = Join-Path $script:Dir 'gpu-drivers'

    foreach ($gpu in $gpus) {
        $vendor = Get-GpuVendor -Name $gpu.Name
        Write-Log "GPU: $($gpu.Name) | vendor=$vendor | driver $($gpu.DriverVersion) ($($gpu.DriverDate))" 'Info'

        if ($vendor -eq 'NVIDIA') {
            $series = Find-NvidiaSeries -Name $gpu.Name
            if (-not $series) {
                Write-Log 'No series mapping for this NVIDIA GPU - open the manual page.' 'Warn'
                if (-not $DiscoverOnly) { Start-Process 'https://www.nvidia.com/en-us/drivers/' }
                continue
            }
            Write-Log "NVIDIA series: $($series.note)" 'Info'
            $d = Get-NvidiaDriver -Psid ([int]$series.psid) -Pfid ([int]$series.pfid)
            if (-not $d) {
                Write-Log 'NVIDIA lookup returned nothing (old card or API issue).' 'Warn'
                if (-not $DiscoverOnly) { Start-Process 'https://www.nvidia.com/en-us/drivers/' }
                continue
            }
            Write-Log "Latest available: $($d.Version) ($($d.Name), $($d.SizeMB))" 'Ok'
            if ($gpu.DriverVersion -eq $d.Version) { Write-Log 'Current driver is already the latest.' 'Ok' }
            if ($DiscoverOnly) { continue }

            $exe = Save-Driver -Url $d.Url -DestDir $destDir
            if ($Install -and $exe) {
                Write-Log 'Installing silently (this can take several minutes)...' 'Info'
                $p = Start-Process -FilePath $exe -ArgumentList '-s', '-noreboot' -Wait -PassThru
                Write-Log "NVIDIA installer exit code: $($p.ExitCode)" 'Info'
                if (Wait-Reboot -Seconds 5) { Write-Log 'Rebooting...' 'Info'; Restart-Computer -Force }
                else { Write-Log 'Reboot manually to finish the driver install.' 'Warn' }
            }
            else {
                Write-Log 'Driver saved. Re-run with -Install to install it.' 'Info'
            }
        }
        elseif ($vendor -eq 'AMD') {
            Write-Log 'AMD has no clean silent-download API - use the auto-detect tool or Windows Update.' 'Warn'
            if (-not $DiscoverOnly) { Start-Process 'https://www.amd.com/en/support' }
        }
        elseif ($vendor -eq 'Intel') {
            Write-Log 'Intel: use Driver & Support Assistant (auto-detect) or Windows Update.' 'Warn'
            if (-not $DiscoverOnly) { Start-Process 'https://www.intel.com/content/www/us/en/support/detect.html' }
        }
        else {
            Write-Log 'Unknown GPU vendor - use Windows Update / device manager.' 'Warn'
        }
    }
    Write-Log 'Done.' 'Ok'
}
catch {
    Write-Log "FATAL: $($_.Exception.Message)" 'Error'
    Write-Log ($_.ScriptStackTrace) 'Error'
    exit 1
}
