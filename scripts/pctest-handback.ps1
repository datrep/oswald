# ============================================================================
# pctest-handback.ps1 - stage a finished run (or unit) into the repo so the
# real output formats can be read and the parsers written against them.
#
# WHY A SCRIPT
#   Two reasons this is not "just copy the folder":
#
#   1. A soak OpenHardwareMonitor log can be very large (24 h at 1 s intervals
#      is ~86k rows). Dumping that into a git workspace is a bad idea, and
#      nobody can read it in a chat window either. So large files are staged as
#      a SAMPLE (head + tail + true size) and the real size is recorded. The
#      parser gets written against the header and shape, which is all it needs;
#      the whole file stays on I: as the actual evidence.
#
#   2. It writes the summary the parser work needs: what was produced, what
#      was missing, and which manifest fields are still blank.
#
# Usage:
#   .\scripts\pctest-handback.ps1 -Unit PD600-001
#   .\scripts\pctest-handback.ps1 -Unit PD600-001 -MaxKb 512
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so one non-ASCII character breaks the parser on a LATER line.
# ============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Unit,
    [string]$From,
    [string]$To,
    [int]$MaxKb = 2048,
    [int]$SampleLines = 200
)

$ErrorActionPreference = 'Stop'

if (-not $From) { $From = Join-Path $env:USERPROFILE 'Desktop\PCTEST' }
if (-not $To)   { $To   = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'temp\pctest-handback' }

$unitSrc = Join-Path $From $Unit
if (-not (Test-Path $unitSrc)) {
    Write-Host "[FAIL] no such unit folder: $unitSrc" -ForegroundColor Red
    exit 1
}

$unitDst = Join-Path $To $Unit
New-Item -ItemType Directory -Path $unitDst -Force | Out-Null

$runDirs = @(Get-ChildItem -Path $unitSrc -Directory | Sort-Object Name)
if ($runDirs.Count -eq 0) {
    Write-Host "[FAIL] no run folders under $unitSrc - run new-pctest-run.ps1 first." -ForegroundColor Red
    exit 1
}

$staged  = @()
$sampled = @()
$skipped = @()

foreach ($run in $runDirs) {
    $dst = Join-Path $unitDst $run.Name
    New-Item -ItemType Directory -Path $dst -Force | Out-Null

    foreach ($f in (Get-ChildItem -Path $run.FullName -File | Sort-Object Name)) {
        $kb = [math]::Round($f.Length / 1KB, 1)

        if ($kb -le $MaxKb) {
            Copy-Item -Path $f.FullName -Destination (Join-Path $dst $f.Name) -Force
            $staged += [pscustomobject]@{ run = $run.Name; file = $f.Name; kb = $kb; mode = 'full' }
        }
        else {
            $head = Get-Content -Path $f.FullName -TotalCount $SampleLines
            $tail = Get-Content -Path $f.FullName -Tail 20
            $lines = (Get-Content -Path $f.FullName | Measure-Object -Line).Lines

            $samplePath = Join-Path $dst ($f.BaseName + '.SAMPLE.txt')
            $lines | Out-Null
            @(
                '# SAMPLE ONLY - the full file was NOT copied.'
                ('# source : ' + $f.FullName)
                ('# size   : ' + $kb + ' KB')
                ('# lines  : ' + $lines)
                ('# reason : larger than MaxKb ' + $MaxKb + '. Staged head + tail so the')
                '#          parser can be written against the real header and shape.'
                '#'
                '# ---- first ' + $SampleLines + ' lines ----'
            ) + $head + @('#', '# ---- last 20 lines ----') + $tail |
                Set-Content -Path $samplePath -Encoding UTF8

            $sampled += [pscustomobject]@{ run = $run.Name; file = $f.Name; kb = $kb; lines = $lines; mode = 'sample' }
        }
    }
}

# --- summary -----------------------------------------------------------------
$blankByRun = @()
foreach ($run in $runDirs) {
    $mf = @(Get-ChildItem -Path $run.FullName -Filter 'manifest-*.json' -File)[0]
    if (-not $mf) { continue }
    $m = Get-Content -Path $mf.FullName -Raw | ConvertFrom-Json

    $blank = @()
    foreach ($p in $m.discoveries.PSObject.Properties) {
        if ($null -eq $p.Value -or "$($p.Value)" -eq '') { $blank += $p.Name }
    }
    $tBlank = @()
    foreach ($p in $m.timing.PSObject.Properties) {
        if ($p.Name -eq 'total') { continue }
        if ($null -eq $p.Value.wallClockSec -and $null -eq $p.Value.handsOnSec) { $tBlank += $p.Name }
    }
    $notProduced = @($m.expected | Where-Object { -not $_.produced } | ForEach-Object { $_.stem })

    $blankByRun += [pscustomobject]@{
        run          = $run.Name
        pass         = $m.pass
        missingFiles = $notProduced
        blankDiscovery = $blank
        blankTiming  = $tBlank
    }
}

$sum = Join-Path $unitDst 'handback-summary.md'
$o = @()
$o += '# PC test handback - ' + $Unit
$o += ''
$o += 'Generated ' + (Get-Date).ToString('yyyy-MM-dd HH:mm') + ' by scripts/pctest-handback.ps1'
$o += ''
$o += 'Source: ' + $unitSrc
$o += ''
$o += '## Files staged'
$o += ''
$o += '| run | file | KB | mode |'
$o += '|---|---|---|---|'
foreach ($s in ($staged + $sampled | Sort-Object run, file)) {
    $o += ('| {0} | {1} | {2} | {3} |' -f $s.run, $s.file, $s.kb, $s.mode)
}
$o += ''
if ($sampled.Count -gt 0) {
    $o += '## Sampled (too large to copy whole)'
    $o += ''
    $o += '| run | file | KB | lines |'
    $o += '|---|---|---|---|'
    foreach ($s in $sampled) { $o += ('| {0} | {1} | {2} | {3} |' -f $s.run, $s.file, $s.kb, $s.lines) }
    $o += ''
    $o += 'The full files stay on disk - they are the warranty evidence. Only the head and tail are here.'
    $o += ''
}
$o += '## Still blank'
$o += ''
foreach ($b in $blankByRun) {
    $o += '### ' + $b.pass + '  (' + $b.run + ')'
    $o += ''
    if ($b.missingFiles.Count -gt 0) { $o += '- missing files: ' + ($b.missingFiles -join ', ') } else { $o += '- missing files: none' }
    if ($b.blankDiscovery.Count -gt 0) { $o += '- unfilled discoveries: ' + ($b.blankDiscovery -join ', ') } else { $o += '- unfilled discoveries: none' }
    if ($b.blankTiming.Count -gt 0) { $o += '- timing not logged: ' + ($b.blankTiming -join ', ') } else { $o += '- timing: complete' }
    $o += ''
}
$o += '## And by hand'
$o += ''
$o += 'These two do not live in the manifest. Paste them, or drop a text file here:'
$o += ''
$o += '1. the FLAGS LOG - every exact command line that worked (docs/pc-inspection-step1-capture.md)'
$o += '2. anything that BROKE, surprised you, or needed two attempts'
$o += ''
$o | Set-Content -Path $sum -Encoding UTF8

# --- console -----------------------------------------------------------------
Write-Host ''
Write-Host '=== PC test handback ==='
Write-Host ('  unit    : {0}' -f $Unit)
Write-Host ('  staged  : {0}' -f $unitDst)
Write-Host ('  runs    : {0}' -f ($runDirs.Name -join ', '))
Write-Host ''
Write-Host ('  files copied whole : {0}' -f $staged.Count)
Write-Host ('  files sampled      : {0}' -f $sampled.Count) -ForegroundColor $(if ($sampled.Count) { 'Yellow' } else { 'Gray' })
if ($sampled.Count -gt 0) {
    foreach ($s in $sampled) {
        Write-Host ('    {0}  ({1} KB, {2} lines)' -f $s.file, $s.kb, $s.lines) -ForegroundColor Yellow
    }
}
Write-Host ''
foreach ($b in $blankByRun) {
    Write-Host ('  ' + $b.pass + ': ' + $b.missingFiles.Count + ' missing, ' + $b.blankDiscovery.Count + ' discoveries blank, ' + $b.blankTiming.Count + ' timing blank')
}
Write-Host ''
Write-Host ('  summary : {0}' -f $sum)
Write-Host ''
Write-Host '  Next: hand the summary back, plus the flags log and anything that broke.'

exit 0
