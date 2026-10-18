$tests = @(
    'Write-Log "Non-Dell machine (''$($hw.Manufacturer)'') - Dell BIOS flash is unavailable." ''Error'''
    ,
    'Write-Log "Detected model ''$($hw.Model)'' is NOT in models.json. Refusing to flash." ''Error'''
)
$i = 0
foreach ($s in $tests) {
    $i++
    $t = $null; $e = $null
    [System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$t, [ref]$e) | Out-Null
    "TEST $i : " + $(if ($e.Count -eq 0) { 'OK' } else { ($e | ForEach-Object { $_.Message }) -join ' | ' })
}
