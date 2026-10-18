# ============================================================================
# pctest-verify-run.ps1 - check a collected run folder against its manifest.
#
# Implements docs/pc-inspection-automation.md section 3.8: a run folder carries
# manifest-<pass>.json listing what the pass was EXPECTED to produce, and this
# script says which of those files actually landed.
#
# WHY THIS EXISTS
#   Section 2.6 risk 7 / section 2.4: a missing file must surface AT COLLECTION,
#   not after the machine is sold. Four phases (P0, P2, P3, P5) depend on the
#   same telemetry tool, so "it did not log" is the failure that matters most.
#
# MATCHING IS BY STEM, NOT FULL NAME
#   Step 1 discovers the real file extensions. So each expectation records a
#   stem ("bench-P2-prime95") and this script matches <stem>.* -- a wrong guess
#   at the extension can never produce a false "missing".
#
# Usage:
#   .\scripts\pctest-verify-run.ps1 -Path C:\...\PCTEST\PD600-008\2026-09-15_1042
#   .\scripts\pctest-verify-run.ps1 -Unit PD600-008
#   .\scripts\pctest-verify-run.ps1 -Unit PD600-008 -Update
#
# -Update writes produced/actualFile back into the manifest. Without it this
# script reads only and changes nothing.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so one non-ASCII character breaks the parser on a LATER line.
# ============================================================================

[CmdletBinding(DefaultParameterSetName = 'ByUnit')]
param(
    [Parameter(ParameterSetName = 'ByPath', Mandatory = $true)][string]$Path,
    [Parameter(ParameterSetName = 'ByUnit', Mandatory = $true)][string]$Unit,
    [Parameter(ParameterSetName = 'ByUnit')][string]$Root,
    [switch]$Update
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Join-Path $env:USERPROFILE 'Desktop\PCTEST' }

# --- collect the run folders to check ----------------------------------------
$runDirs = @()
if ($PSCmdlet.ParameterSetName -eq 'ByPath') {
    if (-not (Test-Path $Path)) { Write-Host "[FAIL] no such folder: $Path" -ForegroundColor Red; exit 1 }
    $runDirs = @((Resolve-Path $Path).Path)
}
else {
    $unitDir = Join-Path $Root $Unit
    if (-not (Test-Path $unitDir)) { Write-Host "[FAIL] no such unit folder: $unitDir" -ForegroundColor Red; exit 1 }
    $runDirs = @(Get-ChildItem -Path $unitDir -Directory | Sort-Object Name | ForEach-Object { $_.FullName })
    if ($runDirs.Count -eq 0) { Write-Host "[FAIL] no run folders under $unitDir" -ForegroundColor Red; exit 1 }
}

$anyMissing = 0

foreach ($runDir in $runDirs) {
    $manifests = @(Get-ChildItem -Path $runDir -Filter 'manifest-*.json' -File)
    Write-Host ''
    Write-Host ('=== ' + $runDir + ' ===')

    if ($manifests.Count -eq 0) {
        Write-Host '  [FAIL] no manifest-*.json here - this folder was not made by new-pctest-run.ps1' -ForegroundColor Red
        $anyMissing = 1
        continue
    }

    foreach ($mf in $manifests) {
        $m = Get-Content -Path $mf.FullName -Raw | ConvertFrom-Json

        Write-Host ('  pass: {0}   manifest: {1}' -f $m.pass, $mf.Name)
        Write-Host ''

        $missingHere = @()
        $foundAnyOhm = $null

        for ($i = 0; $i -lt $m.expected.Count; $i++) {
            $e = $m.expected[$i]

            # OHM can be written once per phase, or once for the whole pass.
            # Either satisfies every OHM expectation (doc section 3.8).
            $pattern = if ($e.tool -eq 'ohm') { '{0}-P*-ohm.*' -f $m.pass } else { $e.stem + '.*' }

            $hit = @(Get-ChildItem -Path $runDir -Filter $pattern -File | Sort-Object Name | Select-Object -First 1)

            if ($hit.Count -gt 0) {
                Write-Host ('  [OK  ] {0,-26} {1}' -f $hit[0].Name, $e.note) -ForegroundColor Green
                if ($e.tool -eq 'ohm' -and $hit[0].BaseName -ne $e.stem) { $foundAnyOhm = $hit[0].Name }
                if ($Update) {
                    $m.expected[$i].produced = $true
                    $m.expected[$i].actualFile = $hit[0].Name
                }
            }
            else {
                Write-Host ('  [MISS] {0,-26} {1}' -f $pattern, $e.note) -ForegroundColor Red
                $missingHere += $pattern
                if ($Update) {
                    $m.expected[$i].produced = $false
                    $m.expected[$i].actualFile = $null
                }
            }
        }

        if ($foundAnyOhm) {
            Write-Host ''
            Write-Host ('  note: OHM was satisfied by ' + $foundAnyOhm + ' - a SPANNING log.')
            Write-Host '        Record discoveries.ohmCadence = "spanning" and its ohmSpanPhases by hand.'
        }

        # --- Step 1 discovery progress ---------------------------------------
        $d = $m.discoveries
        $checks = [ordered]@{
            ramConfig        = $d.ramConfig
            systemTimeAtBoot = $d.systemTimeAtBoot
            memtestPassCount = $d.memtestPassCount
            memtestSeconds   = $d.memtestSeconds
            ohmCadence       = $d.ohmCadence
            furmarkBuild     = $d.furmarkBuild
            memtestTier      = $d.memtestTier
            osAndDriverState = $d.osAndDriverState
        }
        $filled = 0
        $blank  = @()
        foreach ($k in $checks.Keys) {
            if ($null -ne $checks[$k] -and "$($checks[$k])" -ne '') { $filled++ } else { $blank += $k }
        }

        # --- timing progress --------------------------------------------------
        $tFilled = 0
        $tTotal  = 0
        foreach ($p in $m.timing.PSObject.Properties) {
            if ($p.Name -eq 'total') { continue }
            $tTotal++
            if ($null -ne $p.Value.wallClockSec -or $null -ne $p.Value.handsOnSec) { $tFilled++ }
        }

        Write-Host ''
        Write-Host ('  discoveries : {0}/{1} filled' -f $filled, $checks.Count)
        if ($blank.Count -gt 0) { Write-Host ('    still blank: ' + ($blank -join ', ')) -ForegroundColor Yellow }
        Write-Host ('  timing      : {0}/{1} phases logged' -f $tFilled, $tTotal)
        Write-Host ('  files       : {0} missing' -f $missingHere.Count)

        if ($missingHere.Count -gt 0) {
            $anyMissing = 1
            Write-Host ''
            Write-Host '  A missing file is the failure this manifest exists to catch.' -ForegroundColor Yellow
            Write-Host '  If a tool genuinely writes nothing, swap it (section 3.11) rather than' -ForegroundColor Yellow
            Write-Host '  deleting the expectation.' -ForegroundColor Yellow
        }

        if ($Update) {
            $m | ConvertTo-Json -Depth 8 | Set-Content -Path $mf.FullName -Encoding UTF8
            Write-Host ''
            Write-Host ('  manifest updated: ' + $mf.FullName)
        }
    }
}

Write-Host ''
if ($anyMissing -eq 0) {
    Write-Host '=== all expected files present ===' -ForegroundColor Green
    exit 0
}
Write-Host '=== incomplete run(s) ===' -ForegroundColor Red
exit 1
