$path = 'c:\Users\datrep\Desktop\oswald\scripts\firmware\Update-Firmware.ps1'
$lines = Get-Content $path
$total = $lines.Count
"Total lines: $total"

# Find function start lines
$starts = @()
for ($i = 0; $i -lt $total; $i++) {
    if ($lines[$i] -match '^(function |try \{|catch \{|# ---|# Main)') {
        $starts += $i + 1
    }
}
"Starts: $($starts -join ', ')"

# Parse each function body individually
for ($s = 0; $s -lt $starts.Count; $s++) {
    $from = $starts[$s]
    $to = if ($s + 1 -lt $starts.Count) { $starts[$s + 1] - 1 } else { $total }
    $chunk = ($lines[($from - 1)..($to - 1)] -join "`n")
    $t = $null; $e = $null
    [System.Management.Automation.Language.Parser]::ParseInput($chunk, [ref]$t, [ref]$e) | Out-Null
    if ($e.Count -eq 0) {
        "RANGE ${from}-${to}: OK"
    } else {
        "RANGE ${from}-${to}: ERRORS -> " + (($e | ForEach-Object { "L$($_.Extent.StartLineNumber): $($_.Message)" }) -join ' | ')
    }
}
