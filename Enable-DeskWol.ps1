<#
.SYNOPSIS
    Arms Wake-on-LAN on this machine and turns off Fast Startup.

.DESCRIPTION
    A magic packet only works if the NIC is armed for it. This script reports the
    physical Ethernet adapters (so the real MAC address can be confirmed), enables
    magic-packet wake, clears the Realtek/Intel power-saving features that block
    wake-from-S5, and disables Windows Fast Startup (hybrid S4) - the most common
    cause of "WOL works from sleep but not from shutdown".

    Nothing else is modified. Use -Report to look without changing anything.

.PARAMETER AdapterName
    Ethernet adapter to configure. Required when the machine has more than one.

.PARAMETER Report
    Print the current state and change nothing. Needs no elevation.

.PARAMETER DisableHibernation
    Also run 'powercfg /h off'. Blunter than the default: it removes hibernation
    entirely (hiberfil.sys) as well as Fast Startup. Rarely needed.

.EXAMPLE
    .\Enable-DeskWol.ps1 -Report

.EXAMPLE
    .\Enable-DeskWol.ps1
#>
[CmdletBinding()]
param(
    [string]$AdapterName,
    [switch]$Report,
    [switch]$DisableHibernation
)

$ErrorActionPreference = 'Stop'

$PowerKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WolAdapter {
    $candidates = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
        Where-Object { $_.MediaType -eq '802.3' })

    if ($AdapterName) {
        $match = $candidates | Where-Object {
            $_.Name -eq $AdapterName -or $_.InterfaceDescription -eq $AdapterName
        }
        if (-not $match) {
            throw "No Ethernet adapter named '$AdapterName'. Found: $($candidates.Name -join ', ')"
        }
        return $match
    }
    if ($candidates.Count -eq 0) {
        throw 'No physical Ethernet adapter found. Wi-Fi adapters cannot be woken, so WOL is impossible on this machine.'
    }
    if ($candidates.Count -gt 1) {
        throw "Multiple Ethernet adapters: $($candidates.Name -join ', '). Re-run with -AdapterName."
    }
    return $candidates[0]
}

function Get-FastStartupState {
    $value = (Get-ItemProperty -Path $PowerKey -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
    if ($null -eq $value) { return 'not set' }
    if ($value -eq 1) { return 'ENABLED (breaks wake-from-shutdown)' }
    return 'disabled'
}

# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------
Write-Host "Host: $env:COMPUTERNAME"
Write-Host ''
Write-Host '== Physical adapters =='
Get-NetAdapter -Physical |
    Format-Table Name, MacAddress, Status, LinkSpeed, MediaType -AutoSize

$nic = Get-WolAdapter

Write-Host '== Target adapter =='
$nic | Format-List Name, InterfaceDescription, MacAddress, Status, LinkSpeed, MediaType

if ($nic.Status -ne 'Up') {
    Write-Warning "'$($nic.Name)' is $($nic.Status). Without a link, WOL can never work - check the cable."
}

Write-Host '== Wake / power-saving properties =='
Get-NetAdapterAdvancedProperty -Name $nic.Name -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'Wake|Green|Energy|Shutdown Link|Power' } |
    Format-Table DisplayName, DisplayValue,
        @{ Name = 'Valid'; Expression = { $_.ValidDisplayValues -join ' | ' } } -Wrap

Write-Host '== Power management =='
Get-NetAdapterPowerManagement -Name $nic.Name |
    Format-List WakeOnMagicPacket, WakeOnPattern, DeviceSleepOnDisconnect, ArpOffload, NsOffload

Write-Host '== Fast Startup =='
Write-Host ("  HiberbootEnabled = {0}" -f (Get-FastStartupState))
Write-Host ''

if ($Report) {
    Write-Host '-Report specified: no changes made.'
    return
}

if (-not (Test-Admin)) {
    throw 'Run this in an elevated PowerShell - power and adapter settings need administrator rights.'
}

# --------------------------------------------------------------------------
# Apply
# --------------------------------------------------------------------------
Write-Host '== Applying =='

if ($DisableHibernation) {
    & powercfg.exe /h off
    Write-Host '  Hibernation + Fast Startup: disabled (powercfg /h off)'
}
else {
    if ((Get-FastStartupState) -ne 'disabled') {
        New-ItemProperty -Path $PowerKey -Name HiberbootEnabled -Value 0 -PropertyType DWord -Force | Out-Null
        Write-Host '  Fast Startup: disabled (HiberbootEnabled = 0, hibernation kept)'
    }
    else {
        Write-Host '  Fast Startup: already disabled'
    }
}

foreach ($setting in @(
        @{ Name = 'WakeOnMagicPacket'; Value = 'Enabled' },
        @{ Name = 'WakeOnPattern'; Value = 'Disabled' })) {
    $params = @{ Name = $nic.Name }
    $params[$setting.Name] = $setting.Value
    try {
        Set-NetAdapterPowerManagement @params -ErrorAction Stop
        Write-Host ("  {0,-20} -> {1}" -f $setting.Name, $setting.Value)
    }
    catch {
        Write-Warning ("  {0}: could not set - {1}" -f $setting.Name, $_.Exception.Message)
    }
}

$advancedRules = @(
    @{ Pattern = '^Wake on Magic Packet'; Value = 'Enabled' },
    @{ Pattern = 'Shutdown Wake[- ]?On[- ]?Lan'; Value = 'Enabled' },
    @{ Pattern = 'WOL\s*&\s*Shutdown Link Speed'; Value = '10 Mbps First' },
    @{ Pattern = 'Energy[- ]?Efficient Ethernet'; Value = 'Disabled' },
    @{ Pattern = '^Green Ethernet'; Value = 'Disabled' }
)

foreach ($rule in $advancedRules) {
    $property = Get-NetAdapterAdvancedProperty -Name $nic.Name -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match $rule.Pattern } |
        Select-Object -First 1

    if (-not $property) {
        Write-Host ("  {0,-32} n/a (driver has no such setting)" -f $rule.Pattern)
        continue
    }
    if ($property.DisplayValue -eq $rule.Value) {
        Write-Host ("  {0,-32} already '{1}'" -f $property.DisplayName, $property.DisplayValue)
        continue
    }
    if ($property.ValidDisplayValues -and ($property.ValidDisplayValues -notcontains $rule.Value)) {
        Write-Host ("  {0,-32} left as '{1}' (valid: {2})" -f
            $property.DisplayName, $property.DisplayValue, ($property.ValidDisplayValues -join ', '))
        continue
    }
    try {
        Set-NetAdapterAdvancedProperty -Name $nic.Name -DisplayName $property.DisplayName `
            -DisplayValue $rule.Value -ErrorAction Stop
        Write-Host ("  {0,-32} -> '{1}'" -f $property.DisplayName, $rule.Value)
    }
    catch {
        Write-Warning ("  {0}: could not set - {1}" -f $property.DisplayName, $_.Exception.Message)
    }
}

# --------------------------------------------------------------------------
# Verify
# --------------------------------------------------------------------------
Write-Host ''
Write-Host '== Verification =='
Get-NetAdapterPowerManagement -Name $nic.Name | Format-List WakeOnMagicPacket, WakeOnPattern
Write-Host ("  HiberbootEnabled = {0}" -f (Get-FastStartupState))
Write-Host ''
Write-Host "WOL target MAC: $($nic.MacAddress)"
Write-Host 'Next: shut the machine down, then on the NAS run'
Write-Host "  python3 /volume1/scripts/wol_and_probe.py --mac $($nic.MacAddress) --timeout 120"
