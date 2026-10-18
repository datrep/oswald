# ============================================================================
# new-pctest-run.ps1 - scaffold ONE run folder for the PC inspection pipeline.
#
# Implements docs/pc-inspection-automation.md section 3.8:
#
#   <root>\<unit>\<YYYY-MM-DD_HHMM>\<pass>-P<n>-<tool>.<ext>
#
# and writes manifest-<pass>.json listing everything the pass is EXPECTED to
# produce, so a missing file shows up at collection instead of after a sale.
#
# ONE FOLDER PER PASS. A machine produces a "bench" run and a "soak" run, plus
# one more of either for every re-test. The pass lives in the FILENAME, not the
# folder path -- filenames travel, paths do not.
#
# Usage:
#   .\scripts\new-pctest-run.ps1 -Unit PD600-008 -Pass bench
#   .\scripts\new-pctest-run.ps1 -Unit PD600-008 -Pass soak -Root D:\PCTEST
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so one non-ASCII character breaks the parser on a LATER line with a
# misleading error. Keep this file ASCII.
# ============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Unit,
    [Parameter(Mandatory = $true)][ValidateSet('bench', 'soak')][string]$Pass,
    [string]$Root,
    [string]$Notes = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Join-Path $env:USERPROFILE 'Desktop\PCTEST' }

# --- what each pass is expected to produce -----------------------------------
# 'stem' is the filename with no extension. Step 1 confirms the real extension,
# which is why the verifier matches on the stem and not the full name.
$expectedByPass = @{
    bench = @(
        @{ phase = 'P0'; tool = 'cpuz';     stem = 'bench-P0-cpuz';     note = 'CPU identity' }
        @{ phase = 'P0'; tool = 'gpuz';     stem = 'bench-P0-gpuz';     note = 'GPU identity + dump' }
        @{ phase = 'P0'; tool = 'ohm';      stem = 'bench-P0-ohm';      note = 'telemetry; may span P0-P3 (see below)' }
        @{ phase = 'P1'; tool = 'cdi';      stem = 'bench-P1-cdi';      note = 'storage health / SMART' }
        @{ phase = 'P1'; tool = 'cdm';      stem = 'bench-P1-cdm';      note = 'storage throughput' }
        @{ phase = 'P2'; tool = 'prime95';  stem = 'bench-P2-prime95';  note = 'SHORT gate run, minutes not hours' }
        @{ phase = 'P2'; tool = 'ohm';      stem = 'bench-P2-ohm';      note = 'omit if OHM ran continuously from P0' }
        @{ phase = 'P3'; tool = 'furmark';  stem = 'bench-P3-furmark';  note = 'SHORT gate run' }
        @{ phase = 'P3'; tool = 'gpuz';     stem = 'bench-P3-gpuz';     note = 'sensor log' }
    )
    soak = @(
        @{ phase = 'P4'; tool = 'memtest';  stem = 'soak-P4-memtest';   note = 'boot phase, 5.5 h est; soak leg 1' }
        @{ phase = 'P2'; tool = 'prime95';  stem = 'soak-P2-prime95';   note = '4 h' }
        @{ phase = 'P3'; tool = 'furmark';  stem = 'soak-P3-furmark';   note = '2 h' }
        @{ phase = 'P5'; tool = 'ohm';      stem = 'soak-P5-ohm';       note = 'spans all 23.5 h including the boot transition' }
    )
}

$timingPhasesByPass = @{
    bench = @('P0', 'P1', 'P2', 'P3')
    soak  = @('P4', 'P2', 'P3', 'P5')
}

# --- target folder -----------------------------------------------------------
$stamp  = Get-Date -Format 'yyyy-MM-dd_HHmm'
$runDir = Join-Path (Join-Path $Root $Unit) $stamp

if (Test-Path $runDir) {
    if (-not $Force) {
        Write-Host "[FAIL] $runDir already exists." -ForegroundColor Red
        Write-Host '       A run folder is a unique event. Wait a minute, or pass -Force'
        Write-Host '       if you really mean to reuse this timestamp.'
        exit 1
    }
    Write-Host "[warn] reusing existing folder: $runDir" -ForegroundColor Yellow
}
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

# --- manifest ----------------------------------------------------------------
$nowUtc = (Get-Date).ToUniversalTime()

$expected = @()
foreach ($e in $expectedByPass[$Pass]) {
    $expected += [ordered]@{
        phase       = $e.phase
        tool        = $e.tool
        stem        = $e.stem
        note        = $e.note
        produced    = $false
        actualFile  = $null
    }
}

$timing = [ordered]@{}
foreach ($p in $timingPhasesByPass[$Pass]) {
    $timing[$p] = [ordered]@{ wallClockSec = $null; handsOnSec = $null }
}
$timing['total'] = [ordered]@{ wallClockSec = $null; handsOnSec = $null }

# These are STEP 1 DISCOVERIES, not decisions. Fill them in from real runs.
$discoveries = [ordered]@{
    ramConfig        = $null   # P0: e.g. "4x4GB DDR3-1333". If it varies per unit, record per unit.
    systemTimeAtBoot = $null   # P0: if wrong, replace the CMOS cell BEFORE the soak
    memtestPassCount = $null   # P4: read it out of MemTest86's own output
    memtestSeconds   = $null   # P4: measured, not estimated
    ohmCadence       = $null   # "per-phase" or "spanning"
    ohmSpanPhases    = @()     # for a spanning bench log, e.g. @("P0","P2","P3")
    furmarkBuild     = $null   # "free" or "pro"
    memtestTier      = $null
    cliFlagsUsed     = [ordered]@{}  # tool -> exact command line that worked
    osAndDriverState = $null   # the state you intend to SHIP, so the test matches it
}

$manifest = [ordered]@{
    schemaVersion = 1
    unit          = $Unit
    pass          = $Pass
    notes         = $Notes
    startedAtUtc  = $nowUtc.ToString('yyyy-MM-ddTHH:mm:ssZ')
    startedAtLocal= (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    machineTag    = $null      # fill to match MachineTests.machineTag
    batchId       = $null      # fill to match MachineTests.batchId
    expected      = $expected
    timing        = $timing
    discoveries   = $discoveries
}

$manifestPath = Join-Path $runDir ("manifest-$Pass.json")
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8

# --- report ------------------------------------------------------------------
Write-Host ''
Write-Host '=== new PC test run ==='
Write-Host ("  unit      : {0}" -f $Unit)
Write-Host ("  pass      : {0}" -f $Pass)
Write-Host ("  folder    : {0}" -f $runDir)
Write-Host ("  manifest  : {0}" -f $manifestPath)
Write-Host ''
Write-Host ("  expecting {0} files:" -f $expected.Count)
foreach ($e in $expected) {
    Write-Host ("    {0,-24} {1}" -f ($e.stem + '.*'), $e.note)
}
Write-Host ''
Write-Host '  Write outputs into THIS folder, using the stems above.'
Write-Host '  When the pass is done:'
Write-Host ("    .\scripts\pctest-verify-run.ps1 -Path `"{0}`" -Update" -f $runDir)
Write-Host ''
if ($Pass -eq 'bench') {
    Write-Host '  Remember: the bench pass is the GATE. It is short on purpose.'
    Write-Host '  Do not commit 23.5 hours to a machine that fails in ten minutes.'
    Write-Host ''
}
Write-Host '  Timing: log wallClockSec AND handsOnSec separately per phase.'
Write-Host '  Most of the stress phases are wall clock you are not present for.'

exit 0
