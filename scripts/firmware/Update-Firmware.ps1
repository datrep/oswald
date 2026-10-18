#requires -Version 5.1
<#
.SYNOPSIS
  Menu-driven firmware updater for Dell OptiPlex DDR3-generation PCs
  (390 / 7010 / 7020) running Windows 10 LTSC.

.DESCRIPTION
  Lets you choose WHICH "latest spec" updates to apply:
    1. BIOS/UEFI firmware
    2. Intel CPU microcode
    3. SSD firmware
    4. NIC firmware
    5. Everything
    6. Consumer / non-OEM machine (auto-discover + patch via Windows Update)

  Primary engine : Dell Command | Update CLI (dcu-cli.exe) - it resolves the
                   actual latest versions from Dell for this exact machine.
  Offline fallback:
    .\bios\*.exe        -> silent BIOS flash (/s /r)
    .\microcode\*.msu   -> microcode servicing update (wusa /quiet /norestart)
    .\ssd\   + .\nic\   -> drop vendor tools here; the script invokes them if present

.NOTES
  Run elevated (Administrator). BIOS flash is model-specific - the script
  refuses to flash unless the detected model is in models.json.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet('bios', 'microcode', 'ssd', 'nic', 'consumer', 'all', 'help')][string]$Component,
    [switch]$Reboot,
    [switch]$DiscoverOnly,
    [string]$OutputPath,
    [Alias('h')][switch]$Help,
    [switch]$InstallStartup,
    [switch]$RemoveStartup
)

$ErrorActionPreference = 'Stop'
$script:Dir         = $PSScriptRoot
$script:LogFile     = Join-Path $script:Dir 'firmware-update.log'
$script:Models      = @{}
$script:OutputPath  = $OutputPath
$script:VendorTools = $null

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

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]::new($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Show-Help {
    Write-Host ''
    Write-Host 'Update-Firmware.ps1 - PC firmware updater (Dell DDR3 fleet + consumer machines)' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'WHAT IT DOES' -ForegroundColor Yellow
    Write-Host '  Menu-driven firmware updater for Dell OptiPlex 390 / 7010 / 7020 (DDR3) and'
    Write-Host '  generic consumer builds. Pick which "latest spec" to apply: BIOS/UEFI, Intel'
    Write-Host '  CPU microcode, SSD firmware, NIC firmware, or everything. Consumer mode'
    Write-Host '  auto-discovers hardware (board, CPU, GPU, disks, NICs) and patches through'
    Write-Host '  Windows Update / PnP - no manual component list to maintain.'
    Write-Host ''
    Write-Host 'QUICK USAGE' -ForegroundColor Yellow
    Write-Host '  .\Update-Firmware.ps1                        # interactive menu'
    Write-Host '  .\Update-Firmware.ps1 all                    # apply everything (Dell machines)'
    Write-Host '  .\Update-Firmware.ps1 bios                   # BIOS/UEFI only'
    Write-Host '  .\Update-Firmware.ps1 consumer               # discover + patch any machine'
    Write-Host '  .\Update-Firmware.ps1 consumer -DiscoverOnly # inventory only, no changes'
    Write-Host '  .\Update-Firmware.ps1 help                   # show this help'
    Write-Host '  .\Update-Firmware.ps1 -InstallStartup       # auto-run at every login (self-removing)'
    Write-Host '  .\Update-Firmware.ps1 -RemoveStartup        # remove the auto-run entry'
    Write-Host ''
    Write-Host 'ARGUMENTS' -ForegroundColor Yellow
    Write-Host '  -Component <value>  Which update category to run (can be passed positionally).'
    Write-Host '    Values: bios | microcode | ssd | nic | consumer | all | help'
    Write-Host '      bios       = motherboard BIOS/UEFI firmware (Dell Command Update / offline exe)'
    Write-Host '      microcode  = Intel CPU microcode via BIOS + Windows servicing update'
    Write-Host '      ssd        = SSD firmware (Dell Command Update / vendor tool in .\ssd\)'
    Write-Host '      nic        = network adapter firmware/driver (Dell Command Update / vendor tool)'
    Write-Host '      consumer   = auto-discover + patch ANY (non-OEM) machine via Windows Update'
    Write-Host '      all        = bios + microcode + ssd + nic (Dell machines)'
    Write-Host '      help       = show this help and exit'
    Write-Host '  -DiscoverOnly       Inventory only: print + write JSON, do not patch anything.'
    Write-Host '                      Use with -Component consumer. Does not require admin rights.'
    Write-Host '  -OutputPath <path>  Write the discovered inventory JSON to this exact file path'
    Write-Host '                      instead of the default inventory-<make>.json next to the script.'
    Write-Host '  -Reboot             Reboot automatically when updates finish (5s cancellable countdown).'
    Write-Host '  -InstallStartup     Register an elevated auto-run at every login; removes itself'
    Write-Host '                      once the BIOS is at the latest version.'
    Write-Host '  -RemoveStartup      Remove the auto-run entry.'
    Write-Host '  -Help               Show this help and exit (same as passing: help).'
    Write-Host ''
    Write-Host 'NOTES' -ForegroundColor Yellow
    Write-Host '  Run elevated for BIOS/SSD/NIC flashing. Discover-only runs without admin.'
    Write-Host '  Dell machines: install Dell Command | Update once per machine for automatic'
    Write-Host '  latest-version resolution. Offline packages go in .\bios\, .\microcode\,'
    Write-Host '  .\ssd\, .\nic\ next to the script.'
    Write-Host '  Non-DCU models (e.g. OptiPlex 390): BIOS is flashed one step at a time.'
    Write-Host '  The script reports the path; re-run after each reboot to advance a step.'
    Write-Host '  Models with a biosUrls entry auto-download the BIOS .exe from Dell when missing.'
    Write-Host '  A successful BIOS flash shows a 5-second cancellable countdown before rebooting.'
    Write-Host ''
}

function Load-Models {
    $path = Join-Path $script:Dir 'models.json'
    if (-not (Test-Path $path)) {
        throw "models.json not found at $path"
    }
    $json = Get-Content $path -Raw | ConvertFrom-Json
    $script:Models = @{}
    foreach ($p in $json.models.PSObject.Properties) {
        $script:Models[$p.Name] = $p.Value
    }
}

function Get-Hardware {
    $prod = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
    $cs   = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
    $cpu  = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1

    # Dell OptiPlexes report the friendly name in Win32_ComputerSystem.Model
    # (e.g. "OptiPlex 390"); Win32_ComputerSystemProduct.Version is often just "01".
    # Skip BIOS placeholder strings used by ASUS/Gigabyte/MSI/ASRock boards.
    $placeholder = '^(System Product Name|To Be Filled By O\.E\.M\.|Default string|All Series|System Version|Version)$'
    $model = ''
    if ($cs -and $cs.Model -and $cs.Model -notmatch $placeholder)          { $model = $cs.Model }
    elseif ($prod -and $prod.Name -and $prod.Name -notmatch $placeholder)  { $model = $prod.Name }
    elseif ($prod -and $prod.Version -and $prod.Version -notmatch $placeholder) { $model = $prod.Version }
    else { $model = 'Unknown' }

    [pscustomobject]@{
        Manufacturer = if ($cs)   { $cs.Manufacturer } else { '' }
        Model      = $model
        Serial     = if ($prod) { $prod.IdentifyingNumber } else { '' }
        BiosVer    = if ($bios) { $bios.SMBIOSBIOSVersion } else { '' }
        BiosDate   = if ($bios) { $bios.ReleaseDate } else { '' }
        Cpu        = if ($cpu)  { $cpu.Name } else { '' }
    }
}

function Find-DcuCli {
    foreach ($p in @(
        "$env:ProgramFiles\Dell\CommandUpdate\dcu-cli.exe",
        "${env:ProgramFiles(x86)}\Dell\CommandUpdate\dcu-cli.exe"
    )) { if (Test-Path $p) { return $p } }
    return $null
}

function Test-DcuSupported {
    # Old models (e.g. OptiPlex 390) predate Dell Command Update; their manifest
    # entry sets "dcu": false. Unknown models default to "try DCU" (model-safe).
    $m = $script:Models[$script:DetectedModel]
    return -not ($m -and $m.dcu -eq $false)
}

function Show-BiosState {
    param($Hw)
    if (-not $Hw) { $Hw = Get-Hardware }
    $m = $script:Models[$Hw.Model]
    if (-not $m) { return }
    $latest = if ($m.latestBios) { $m.latestBios } else { $null }
    $chain  = if ($m.biosChain) { @($m.biosChain) } else { @() }
    if (-not $latest -and $chain.Count -eq 0) { return }

    $current = $Hw.BiosVer
    $next = $null
    if ($chain.Count -gt 0) {
        $idx = [array]::IndexOf($chain, $current)
        if ($idx -ge 0 -and $idx -lt ($chain.Count - 1)) { $next = $chain[$idx + 1] }
        elseif ($idx -lt 0 -and $latest) { $next = $latest }
    } elseif ($latest -and $current -ne $latest) { $next = $latest }

    if ($chain.Count -gt 0) { Write-Log "BIOS path : $($chain -join ' -> ')" 'Info' }
    if ($next) {
        Write-Log "BIOS      : installed $current, next step $next" 'Warn'
    } elseif ($latest -and $current -eq $latest) {
        Write-Log "BIOS      : $current is the latest" 'Ok'
    } else {
        Write-Log "BIOS      : installed $current, latest $latest" 'Info'
    }
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

function Get-StartupCmd {
    return Join-Path ([Environment]::GetFolderPath('Startup')) 'Oswald-Firmware-Update.cmd'
}

function Test-StartupInstalled {
    return (Test-Path (Get-StartupCmd))
}

function Install-Startup {
    $dest = Get-StartupCmd
    $ps1  = Join-Path $script:Dir 'Update-Firmware.ps1'
    # Self-elevating batch: re-launches itself with a UAC prompt if not already admin.
    $content = @"
@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ps1" all
"@
    Set-Content -Path $dest -Value $content -Encoding ASCII
    Write-Log "Installed startup auto-run: $dest" 'Ok'
    Write-Log 'It runs elevated at every login and removes itself once the BIOS is current.' 'Info'
}

function Remove-Startup {
    $dest = Get-StartupCmd
    if (Test-Path $dest) {
        Remove-Item $dest -Force
        Write-Log 'Removed startup auto-run.' 'Ok'
    }
}

# Convert a chosen category to the dcu-cli -updateType token.
function Get-DcuUpdateType {
    param([string[]]$Selected) # 'bios','microcode','ssd','nic'
    $types = @()
    if ($Selected -contains 'bios')      { $types += 'bios' }
    if ($Selected -contains 'ssd' -or $Selected -contains 'nic') { $types += 'firmware' }
    if ($Selected -contains 'microcode') { $types += 'driver' } # microcode ships as a driver/servicing update
    $types = $types | Select-Object -Unique
    if ($types.Count -eq 0 -or $Selected -contains 'all') { return 'all' }
    return ($types -join ',')
}

function Invoke-DellCommandUpdate {
    param([string[]]$Selected)
    if (-not (Test-DcuSupported)) {
        Write-Log 'Dell Command Update does not support this model - skipped (use offline packages).' 'Warn'
        return $false
    }
    $dcu = Find-DcuCli
    if (-not $dcu) {
        Write-Log 'Dell Command | Update CLI (dcu-cli.exe) not found.' 'Warn'
        Write-Log 'Install it once: https://www.dell.com/support/kbdoc/000177325' 'Warn'
        return $false
    }
    Write-Log "Using: $dcu" 'Info'
    $type = Get-DcuUpdateType -Selected $Selected

    Write-Log "Scanning for updates (updateType=$type)..." 'Info'
    & $dcu /scan -updateType=$type 2>&1 | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -ne 0) { Write-Log 'Scan finished with warnings (continuing).' 'Warn' }

    Write-Log 'Applying updates...' 'Info'
    & $dcu /applyUpdates -updateType=$type -reboot=disable -autoSuspendBitLocker=enable 2>&1 |
        ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Log "applyUpdates exit code $LASTEXITCODE (some items may need a reboot)." 'Warn'
    } else {
        Write-Log 'Dell Command Update completed.' 'Ok'
    }
    return $true
}

function Get-BiosExe {
    param([string]$Model, [string]$Version)
    $dir = Join-Path $script:Dir 'bios'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $modelNo = ([regex]::Match($Model, '\d+')).Value
    $exes = @(Get-ChildItem -Path $dir -Filter '*.exe' -ErrorAction SilentlyContinue)

    # A specific target version requires an exact model+version match - never
    # fall back to a different version's exe, or we'd re-flash the wrong BIOS.
    if ($Version -and $modelNo) {
        $hit = $exes | Where-Object { $_.BaseName -match [regex]::Escape($modelNo) -and $_.BaseName -match [regex]::Escape($Version) } | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    elseif ($modelNo) {
        $hit = $exes | Where-Object { $_.BaseName -match [regex]::Escape($modelNo) } | Select-Object -First 1
        if ($hit) { return $hit.FullName }
        if ($exes.Count -gt 0) { return $exes[0].FullName }
    }

    # Auto-download from the manifest if a direct URL is known.
    $m = $script:Models[$Model]
    if ($Version -and $m -and $m.biosUrls -and $m.biosUrls.$Version) {
        $url  = $m.biosUrls.$Version
        $dest = Join-Path $dir ([System.IO.Path]::GetFileName($url))
        Write-Log "Downloading BIOS $Version from $url" 'Info'
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            # dl.dell.com blocks non-browser agents; send a normal UA + referer.
            $headers = @{
                'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
                'Referer'    = 'https://www.dell.com/support/'
            }
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers $headers
            Write-Log "Downloaded to $dest" 'Ok'
            return $dest
        } catch {
            Write-Log "Download failed: $($_.Exception.Message)" 'Warn'
            Write-Log "Download it manually from dell.com/support and put it in $dir" 'Warn'
            return $null
        }
    }
    return $null
}

function Invoke-OfflineBios {
    if ($script:SkipOfflineBios) {
        Write-Log 'Offline BIOS flash skipped (model not in models.json).' 'Warn'
        return
    }
    $hw = Get-Hardware
    if (Test-DcuSupported) {
        Write-Log 'Dell Command Update handles this model - offline BIOS flash skipped.' 'Info'
        return
    }

    $m       = $script:Models[$hw.Model]
    $current = $hw.BiosVer
    $latest  = if ($m -and $m.latestBios) { $m.latestBios } else { $null }
    $chain   = if ($m -and $m.biosChain) { @($m.biosChain) } else { @() }

    # Pick the next step: follow biosChain, otherwise jump straight to latest.
    $target = $null
    if ($chain.Count -gt 0) {
        $idx = [array]::IndexOf($chain, $current)
        if ($idx -ge 0 -and $idx -lt ($chain.Count - 1)) { $target = $chain[$idx + 1] }
        elseif ($idx -lt 0 -and $latest) { $target = $latest }
    } elseif ($latest -and $current -ne $latest) { $target = $latest }

    $stateMsg = "BIOS state: installed=$current"
    if ($latest) { $stateMsg += ", latest=$latest" }
    if ($target) { $stateMsg += ", next=$target" }
    Write-Log $stateMsg 'Info'
    if ($chain.Count -gt 0) { Write-Log "Version path: $($chain -join ' -> ')" 'Info' }

    if (-not $target) {
        Write-Log 'BIOS is already current - nothing to flash.' 'Ok'
        return
    }

    $exe = Get-BiosExe -Model $hw.Model -Version $target
    if (-not $exe) {
        if ($target) {
            Write-Log "No BIOS package for '$($hw.Model)' $target. Download it from dell.com/support and put it in $(Join-Path $script:Dir 'bios'), then re-run." 'Warn'
        } else {
            Write-Log 'No BIOS package found and no update target (BIOS current or unknown).' 'Info'
        }
        return
    }

    $flashMsg = "Flashing $(Split-Path $exe -Leaf)"
    if ($current -and $target) { $flashMsg += " ($current -> $target)" }
    Write-Log $flashMsg 'Info'
    $log = Join-Path $script:Dir ("bios-flash-" + [System.IO.Path]::GetFileNameWithoutExtension($exe) + ".log")
    # Dell BIOS packages accept: /s (silent) /r (reboot) /f (force) /l=log
    $p = Start-Process -FilePath $exe -ArgumentList '/s', "/l=`"$log`"" -Wait -PassThru
    $code = $p.ExitCode
    if ($code -eq 0) {
        Write-Log 'BIOS flash completed (exit 0).' 'Ok'
        if (Wait-Reboot -Seconds 5) {
            Write-Log 'Rebooting to apply the BIOS...' 'Info'
            Restart-Computer -Force
        } else {
            Write-Log 'Reboot cancelled - reboot manually to apply the BIOS.' 'Warn'
        }
    }
    elseif ($code -eq 3) { Write-Log 'BIOS already at this version - nothing flashed (exit 3).' 'Warn' }
    else                 { Write-Log "BIOS flash exit code $code - see $log" 'Warn' }
    Write-Log 'After reboot, re-run this script to apply the next BIOS step (state-aware).' 'Info'
}

function Invoke-Microcode {
    Write-Log 'Intel microcode for DDR3 platforms is delivered via (1) the BIOS and (2) Windows servicing.' 'Info'
    $hw = Get-Hardware
    Write-Log "CPU  : $($hw.Cpu)" 'Info'
    Write-Log "BIOS : $($hw.BiosVer) ($($hw.BiosDate))" 'Info'

    # Offline: local microcode .msu packages.
    $dir = Join-Path $script:Dir 'microcode'
    if (Test-Path $dir) {
        $msus = Get-ChildItem -Path $dir -Filter '*.msu' -ErrorAction SilentlyContinue
        foreach ($m in $msus) {
            Write-Log "Installing microcode servicing update: $($m.Name)" 'Info'
            $p = Start-Process -FilePath 'wusa.exe' -ArgumentList "`"$($m.FullName)`"", '/quiet', '/norestart' -Wait -PassThru
            Write-Log "wusa exit code: $($p.ExitCode)" 'Info'
        }
    }

    # Online: trigger Windows Update scan (LTSC 2019+ has UsoClient).
    Write-Log 'Triggering Windows Update scan for microcode servicing...' 'Info'
    if (Get-Command 'UsoClient' -ErrorAction SilentlyContinue) {
        & UsoClient StartScan
    } else {
        & wuauclt /detectnow
    }
    Write-Log 'Check Settings > Windows Update for the microcode update; install and reboot.' 'Ok'
}

function Invoke-SsdFirmware {
    Write-Log '--- Physical disks (current firmware) ---' 'Info'
    $disks = Invoke-SafeEnum 'Get-PhysicalDisk'
    foreach ($d in $disks) {
        Write-Log "$($d.FriendlyName) | $($d.MediaType) | fw=$($d.FirmwareVersion) | $($d.HealthStatus)"
    }
    Invoke-VendorTool -Category 'ssd' -Haystack @($disks | ForEach-Object { $_.FriendlyName }) -OpenBrowser

    # Vendor tools dropped in .\ssd\ get run if present.
    $dir = Join-Path $script:Dir 'ssd'
    if (Test-Path $dir) {
        $tools = Get-ChildItem -Path $dir -Include '*.exe', '*.bat', '*.cmd' -Recurse -ErrorAction SilentlyContinue
        foreach ($t in $tools) {
            Write-Log "Running vendor SSD tool: $($t.Name)" 'Info'
            $p = Start-Process -FilePath $t.FullName -Wait -PassThru
            Write-Log "exit code: $($p.ExitCode)" 'Info'
        }
    }
    # Dell-branded SSD firmware is covered by Dell Command Update (firmware category),
    # which is called from Invoke-DellCommandUpdate when 'ssd' is selected.
}

function Invoke-NicFirmware {
    Write-Log '--- Network adapters ---' 'Info'
    $nics = Invoke-SafeEnum 'Get-NetAdapter'
    foreach ($n in $nics) {
        Write-Log "$($n.Name) | $($n.InterfaceDescription) | drv=$($n.DriverVersion) | $($n.Status)"
    }
    Invoke-VendorTool -Category 'nic' -Haystack @($nics | ForEach-Object { $_.InterfaceDescription }) -OpenBrowser

    $dir = Join-Path $script:Dir 'nic'
    if (Test-Path $dir) {
        $tools = Get-ChildItem -Path $dir -Include '*.exe', '*.bat', '*.cmd' -Recurse -ErrorAction SilentlyContinue
        foreach ($t in $tools) {
            Write-Log "Running vendor NIC tool: $($t.Name)" 'Info'
            $p = Start-Process -FilePath $t.FullName -Wait -PassThru
            Write-Log "exit code: $($p.ExitCode)" 'Info'
        }
    }
}

# ---------------------------------------------------------------------------
# Consumer / non-OEM machines - auto-discovery, zero maintained lists.
# ---------------------------------------------------------------------------
function Invoke-SafeEnum {
    # Run an enumeration cmdlet if it exists; return an empty array otherwise.
    # A missing command is a terminating error that -ErrorAction cannot suppress.
    param([string]$Command)
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return @() }
    return @(& $Command -ErrorAction SilentlyContinue)
}

function Get-ConsumerInventory {
    $board = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue
    $cs    = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $cpu   = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    $bios  = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
    $gpus  = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
    $disks = Invoke-SafeEnum 'Get-PhysicalDisk'
    $nics  = Invoke-SafeEnum 'Get-NetAdapter'

    [pscustomobject]@{
        Manufacturer = if ($cs) { $cs.Manufacturer } else { '' }
        Model        = if ($cs) { $cs.Model } else { '' }
        Board        = if ($board) { "$($board.Manufacturer) $($board.Product)" } else { '' }
        BoardVersion = if ($board) { $board.Version } else { '' }
        BiosVersion  = if ($bios) { $bios.SMBIOSBIOSVersion } else { '' }
        Cpu          = if ($cpu) { $cpu.Name } else { '' }
        Gpus         = @($gpus | ForEach-Object { [pscustomobject]@{ Name = $_.Name; DriverVersion = $_.DriverVersion; DriverDate = $_.DriverDate } })
        Disks        = @($disks | ForEach-Object { [pscustomobject]@{ FriendlyName = $_.FriendlyName; MediaType = $_.MediaType; FirmwareVersion = $_.FirmwareVersion; HealthStatus = $_.HealthStatus } })
        Nics         = @($nics | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Description = $_.InterfaceDescription; DriverVersion = $_.DriverVersion } })
    }
}

function Write-ConsumerInventory {
    $inv = Get-ConsumerInventory
    Write-Log '--- Discovered hardware (auto-enumerated, no manual list) ---' 'Info'
    Write-Log "Manufacturer : $($inv.Manufacturer)" 'Info'
    Write-Log "Model        : $($inv.Model)" 'Info'
    Write-Log "Board        : $($inv.Board) (rev $($inv.BoardVersion))" 'Info'
    Write-Log "BIOS         : $($inv.BiosVersion)" 'Info'
    Write-Log "CPU          : $($inv.Cpu)" 'Info'
    foreach ($g in $inv.Gpus)  { Write-Log "GPU          : $($g.Name) | driver $($g.DriverVersion)" 'Info' }
    foreach ($d in $inv.Disks) { Write-Log "Disk         : $($d.FriendlyName) | $($d.MediaType) | fw=$($d.FirmwareVersion) | $($d.HealthStatus)" 'Info' }
    foreach ($n in $inv.Nics)  { Write-Log "NIC          : $($n.Name) | $($n.Description) | drv=$($n.DriverVersion)" 'Info' }

    $json = $inv | ConvertTo-Json -Depth 5
    if ($script:OutputPath) {
        # Caller (e.g. the Listing Workbench) wants the JSON at a specific path.
        try {
            Set-Content -Path $script:OutputPath -Value $json -Encoding UTF8
            Write-Log "Inventory snapshot written to $($script:OutputPath)" 'Ok'
        } catch {
            Write-Log "Could not write inventory to $($script:OutputPath): $($_.Exception.Message)" 'Warn'
        }
        return
    }
    $safe = ($inv.Manufacturer -replace '[^A-Za-z0-9]', '')
    $out  = Join-Path $script:Dir "inventory-$safe.json"
    try {
        Set-Content -Path $out -Value $json -Encoding UTF8
        Write-Log "Inventory snapshot written to $out" 'Ok'
    } catch {
        Write-Log "Could not write inventory: $($_.Exception.Message)" 'Warn'
    }
}

function Get-VendorManifest {
    if ($script:VendorTools) { return $script:VendorTools }
    $path = Join-Path $script:Dir 'vendor-tools.json'
    if (-not (Test-Path $path)) { $script:VendorTools = $null; return $null }
    $script:VendorTools = Get-Content $path -Raw | ConvertFrom-Json
    return $script:VendorTools
}

function Resolve-ManifestPath {
    param([string]$Path)
    if (-not $Path) { return $null }
    try { return $ExecutionContext.InvokeCommand.ExpandString($Path) } catch { return $Path }
}

function Find-InstalledTool {
    param($Entry)
    # 1) Manifest install paths (fast, exact).
    if ($Entry.installPaths) {
        foreach ($p in @($Entry.installPaths)) {
            $expanded = Resolve-ManifestPath ([string]$p)
            if ($expanded -and (Test-Path $expanded)) { return $expanded }
        }
    }
    # 2) Registry uninstall entries (self-heals when the default path drifts).
    # Try the specific displayName first, then fall back to the vendor name.
    $kwSets = @()
    if ($Entry.displayName) { $kwSets += ,@([string]$Entry.displayName) }
    if ($Entry.vendor)      { $kwSets += ,@([string]$Entry.vendor) }
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($kwSet in $kwSets) {
        foreach ($key in $keys) {
            foreach ($item in (Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
                $name = [string]$item.DisplayName
                if (-not $name) { continue }
                $matched = $false
                foreach ($k in $kwSet) { if ($name -match [regex]::Escape($k)) { $matched = $true; break } }
                if (-not $matched) { continue }
                $icon = [string]$item.DisplayIcon
                if ($icon -match '(?i)^"?([^"]+?\.exe)') {
                    $exe = $matches[1]
                    if (Test-Path $exe) { return $exe }
                }
                $loc = [string]$item.InstallLocation
                if ($loc -and (Test-Path $loc)) {
                    $exes = Get-ChildItem -Path $loc -Filter '*.exe' -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1
                    if ($exes) { return $exes.FullName }
                }
            }
        }
    }
    return $null
}

function Invoke-VendorTool {
    param(
        [Parameter(Mandatory)][string]$Category,
        [Parameter(Mandatory)][string[]]$Haystack,
        [switch]$OpenBrowser
    )
    $manifest = Get-VendorManifest
    if (-not $manifest -or -not $manifest.$Category) {
        Write-Log "No vendor-tools manifest entry for '$Category'." 'Info'
        return
    }
    foreach ($entry in @($manifest.$Category)) {
        $hit = $false
        foreach ($kw in @($entry.match)) {
            foreach ($h in $Haystack) {
                if ($h -and ($h -match [regex]::Escape([string]$kw))) { $hit = $true; break }
            }
            if ($hit) { break }
        }
        if (-not $hit) { continue }

        Write-Log "Detected vendor: $($entry.vendor) - $($entry.tool)" 'Info'
        $exe = Find-InstalledTool -Entry $entry
        if ($exe) {
            Write-Log "Launching: $exe" 'Ok'
            Start-Process -FilePath $exe
            return
        }
        Write-Log 'Tool not installed.' 'Warn'
        if ($entry.note) { Write-Log $entry.note 'Info' }
        if ($entry.infoUrl) {
            Write-Log "Download/support: $($entry.infoUrl)" 'Info'
            if ($OpenBrowser) { Start-Process $entry.infoUrl }
        }
        return
    }
    Write-Log "No known vendor tool matched ($Category)." 'Info'
}

function Invoke-BoardVendorTool {
    $inv = Get-ConsumerInventory
    Invoke-VendorTool -Category 'board' -Haystack @($inv.Board, $inv.Manufacturer, $inv.Model) -OpenBrowser
}

function Invoke-GpuVendorTool {
    $inv = Get-ConsumerInventory
    Invoke-VendorTool -Category 'gpu' -Haystack @($inv.Gpus | ForEach-Object { $_.Name }) -OpenBrowser
}

function Invoke-WindowsUpdateDrivers {
    $mod = Get-Module -ListAvailable -Name PSWindowsUpdate -ErrorAction SilentlyContinue
    if ($mod) {
        Write-Log 'PSWindowsUpdate module found - applying driver/firmware updates from Microsoft Update.' 'Info'
        Import-Module PSWindowsUpdate -Force -ErrorAction SilentlyContinue
        try {
            Install-WindowsUpdate -MicrosoftUpdate -AcceptAll -AutoReboot:$false -Category 'Drivers' -ErrorAction Stop |
                ForEach-Object { Write-Log ($_ | Out-String) }
        } catch {
            Write-Log "PSWindowsUpdate install failed: $($_.Exception.Message)" 'Warn'
        }
    } else {
        Write-Log 'PSWindowsUpdate not installed - using built-in Windows Update + PnP scan.' 'Warn'
        Write-Log 'Tip: Install-Module PSWindowsUpdate -Scope CurrentUser -Force  (enables headless patching)' 'Info'
        & pnputil /scan-devices 2>&1 | ForEach-Object { Write-Log $_ }
        if (Get-Command UsoClient -ErrorAction SilentlyContinue) { & UsoClient StartScan }
        else { & wuauclt /detectnow }
        Write-Log 'Check Settings > Windows Update for driver/firmware updates.' 'Ok'
    }
}

function Invoke-ConsumerUpdates {
    Write-ConsumerInventory
    if ($DiscoverOnly) {
        Write-Log 'Discover-only mode: hardware enumerated, no patching performed.' 'Ok'
        return
    }
    Invoke-BoardVendorTool
    Invoke-GpuVendorTool
    Write-Log 'Patching via Windows Update / PnP (universal, zero-maintenance path).' 'Info'
    Invoke-WindowsUpdateDrivers
}

function Show-Menu {
    Write-Host ''
    Write-Host '================================================' -ForegroundColor Cyan
    Write-Host '  PC fleet - firmware updater' -ForegroundColor Cyan
    Write-Host '================================================' -ForegroundColor Cyan
    Write-Host '  [1] BIOS/UEFI firmware only'
    Write-Host '  [2] Intel CPU microcode only'
    Write-Host '  [3] SSD firmware only'
    Write-Host '  [4] NIC firmware only'
    Write-Host '  [5] EVERYTHING (all of the above)'
    Write-Host '  [6] Consumer / non-OEM machine (auto-discover + patch)'
    Write-Host '  [q] Quit'
    Write-Host ''
}

function Resolve-Selection {
    param([string]$Answer)
    switch ($Answer) {
        '1' { return @('bios') }
        '2' { return @('microcode') }
        '3' { return @('ssd') }
        '4' { return @('nic') }
        '5' { return @('all') }
        '6' { return @('consumer') }
        default { return $null }
    }
}

function Start-Updates {
    param([string[]]$Selected)
    if ($Selected -contains 'all') {
        $Selected = @('bios', 'microcode', 'ssd', 'nic')
    }

    if ($Selected -contains 'consumer') {
        Write-Log '>>> Consumer / non-OEM machine (auto-discover + patch)' 'Info'
        Invoke-ConsumerUpdates
        return
    }

    # BIOS/UEFI first (microcode depends on it).
    if ($Selected -contains 'bios') {
        Write-Log '>>> BIOS/UEFI firmware' 'Info'
        Invoke-OfflineBios
        Invoke-DellCommandUpdate -Selected @('bios') | Out-Null
    }
    if ($Selected -contains 'microcode') {
        Write-Log '>>> Intel CPU microcode' 'Info'
        Invoke-Microcode
        Invoke-DellCommandUpdate -Selected @('microcode') | Out-Null
    }
    if ($Selected -contains 'ssd') {
        Write-Log '>>> SSD firmware' 'Info'
        Invoke-SsdFirmware
        Invoke-DellCommandUpdate -Selected @('ssd') | Out-Null
    }
    if ($Selected -contains 'nic') {
        Write-Log '>>> NIC firmware' 'Info'
        Invoke-NicFirmware
        Invoke-DellCommandUpdate -Selected @('nic') | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
try {
    if ($Help -or $Component -eq 'help') { Show-Help; exit 0 }

    if ($InstallStartup) { Install-Startup; exit 0 }
    if ($RemoveStartup)  { Remove-Startup;  exit 0 }

    # Discover-only inventory needs no elevation (CIM reads work as a normal user).
    if (-not (Test-Admin) -and -not $DiscoverOnly) {
        Write-Host 'Run this script as Administrator (BIOS/SSD/NIC flashing requires elevation).' -ForegroundColor Red
        exit 1
    }

    Load-Models

    $hw = Get-Hardware
    $script:IsDell = $hw.Manufacturer -eq 'Dell Inc.'
    $script:SkipOfflineBios = $false
    $script:DetectedModel = $hw.Model
    Write-Log "Machine : $($hw.Model) (SN $($hw.Serial))" 'Info'
    Write-Log "Mfr     : $($hw.Manufacturer)" 'Info'
    Write-Log "BIOS    : $($hw.BiosVer) ($($hw.BiosDate))" 'Info'
    Write-Log "CPU     : $($hw.Cpu)" 'Info'
    Show-BiosState -Hw $hw

    if ($Component) {
        $selected = @($Component)
    } else {
        do {
            Show-Menu
            $answer = Read-Host 'Which updates do you want to run?'
            if ($answer -eq 'q') { exit 0 }
            $selected = Resolve-Selection -Answer $answer
            if (-not $selected) { Write-Host 'Invalid choice. Enter 1-6 or q.' -ForegroundColor Yellow }
        } while (-not $selected)
    }

    Write-Log "Selected: $($selected -join ', ')" 'Info'

    $willFlashBios = ($selected -contains 'bios' -or $selected -contains 'all')
    if ($willFlashBios -and -not $script:IsDell) {
        Write-Log "Non-Dell machine ('$($hw.Manufacturer)') - Dell BIOS flash is unavailable." 'Error'
        Write-Log 'Use [6] consumer path (Windows Update) for this machine instead.' 'Error'
        exit 1
    }
    if ($willFlashBios -and -not $script:Models.ContainsKey($hw.Model)) {
        # Model not in the manifest: skip the OFFLINE .exe flash (which needs an
        # exact package) but still try Dell Command Update, which resolves the
        # correct BIOS for this exact machine by service tag (model-safe).
        Write-Log "Detected model '$($hw.Model)' is not in models.json." 'Warn'
        Write-Log 'Offline BIOS .exe flash skipped; Dell Command Update will resolve the correct BIOS online.' 'Warn'
        $script:SkipOfflineBios = $true
    }

    if ($willFlashBios) {
        $ok = Read-Host 'BIOS/UEFI flash will be applied - make sure AC power is stable. Continue? (y/N)'
        if ($ok -ne 'y') { Write-Log 'Aborted by user.' 'Warn'; exit 0 }
    }

    Start-Updates -Selected $selected

    # Auto-run cleanup: once this model's BIOS is at the latest, remove the startup entry.
    if (Test-StartupInstalled) {
        $m = $script:Models[$hw.Model]
        if ($m -and $m.latestBios -and $hw.BiosVer -eq $m.latestBios) {
            Remove-Startup
            Write-Log 'Firmware is current - startup auto-run removed.' 'Ok'
        }
    }

    if ($Reboot) {
        if (Wait-Reboot -Seconds 5) {
            Write-Log 'Rebooting...' 'Ok'
            Restart-Computer -Force
        } else {
            Write-Log 'Reboot cancelled.' 'Warn'
        }
    } else {
        Write-Log 'Done. Reboot manually if any update requested it.' 'Ok'
    }
}
catch {
    Write-Log "FATAL: $($_.Exception.Message)" 'Error'
    Write-Log ($_.ScriptStackTrace) 'Error'
    exit 1
}
