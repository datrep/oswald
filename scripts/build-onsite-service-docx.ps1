# build-onsite-service-docx.ps1
# Regenerates I:\PC_Test_Kit\LEGAL\ONSITE SERVICE.docx from the reconciled rate card,
# so the .docx stops being the last stale mirror of the service terms.
#
# Source of record: legal/standards/onsite-service-rate-card.md
# Mirror target:    I:\PC_Test_Kit\LEGAL\ONSITE SERVICE.docx
#
# WHY THIS DOES NOT USE WORD:
#   The first attempt drove Word over COM (Documents.Open on an HTML file, then
#   SaveAs2). It hung indefinitely and left orphaned WINWORD.EXE processes behind,
#   with nothing written. A .docx is just a zip of XML, so this script writes the
#   OOXML package directly. No Office, no COM, no orphaned processes, deterministic
#   output, and it verifies itself before claiming success.
#
# ASCII only (repo convention: a BOM-less .ps1 is read as ANSI, so one non-ASCII
# character breaks the parser on a LATER line with a misleading error). All typography
# is emitted as XML character references via the tokens below.

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- tokens
# Content strings are written with these tokens so the SOURCE stays ASCII.
# Esc() escapes XML first, then expands the tokens, so the entities survive.
#   ~em~  em dash      ~en~  en dash      ~md~  middle dot
#   ~rarr~ right arrow ~bul~ bullet
#   **text**  bold run

function Esc {
  param([string]$s)
  $s = $s -replace '&', '&amp;'
  $s = $s -replace '<', '&lt;'
  $s = $s -replace '>', '&gt;'
  $s = $s -replace '~em~', '&#8212;'
  $s = $s -replace '~en~', '&#8211;'
  $s = $s -replace '~md~', '&#183;'
  $s = $s -replace '~rarr~', '&#8594;'
  $s = $s -replace '~bul~', '&#8226;'
  return $s
}

# A paragraph made of runs. '**' toggles bold.
function Runs {
  param([string]$text, [bool]$allBold, [int]$size)
  $parts = $text -split '\*\*'
  $out = ''
  for ($i = 0; $i -lt $parts.Count; $i++) {
    $t = $parts[$i]
    if ($t -eq '') { continue }
    $b = $allBold
    if (($i % 2) -eq 1) { $b = $true }
    $bTag = ''
    if ($b) { $bTag = '<w:b/><w:bCs/>' }
    $out += '<w:r><w:rPr>' + $bTag + '<w:sz w:val="' + $size + '"/><w:szCs w:val="' + $size + '"/></w:rPr>'
    $out += '<w:t xml:space="preserve">' + (Esc $t) + '</w:t></w:r>'
  }
  return $out
}

function Para {
  param(
    [string]$text = '',
    [int]$size = 21,
    [bool]$bold = $false,
    [int]$after = 120,
    [int]$indent = 0,
    [bool]$keepNext = $false
  )
  $p = '<w:pPr>'
  if ($keepNext) { $p += '<w:keepNext/><w:keepLines/>' }
  if ($indent -gt 0) { $p += '<w:ind w:left="' + $indent + '" w:hanging="200"/>' }
  $p += '<w:spacing w:after="' + $after + '"/>'
  $p += '</w:pPr>'
  return '<w:p>' + $p + (Runs -text $text -allBold $bold -size $size) + '</w:p>'
}

function Bullet {
  param([string]$text, [int]$size = 21)
  return (Para -text ('~bul~ ' + $text) -size $size -after 60 -indent 340)
}

function Heading {
  param([string]$text)
  return (Para -text $text -size 26 -bold $true -after 60 -keepNext $true)
}

function Cell {
  param([string]$text, [int]$width, [bool]$header, [int]$size = 19)
  $c = '<w:tcPr><w:tcW w:w="' + $width + '" w:type="dxa"/>'
  if ($header) { $c += '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' }
  $c += '<w:vAlign w:val="top"/></w:tcPr>'
  return '<w:tc>' + $c + (Para -text $text -size $size -bold $header -after 0) + '</w:tc>'
}

function Row {
  param([string[]]$cells, [int[]]$widths, [bool]$header = $false)
  $r = '<w:tr>'
  if ($header) { $r += '<w:trPr><w:tblHeader/></w:trPr>' }
  for ($i = 0; $i -lt $cells.Count; $i++) {
    $r += (Cell -text $cells[$i] -width $widths[$i] -header $header)
  }
  return $r + '</w:tr>'
}

function Table {
  param([string[][]]$rows, [int[]]$widths, [int]$headerRows = 1)
  $grid = ''
  foreach ($w in $widths) { $grid += '<w:gridCol w:w="' + $w + '"/>' }
  $bd = '<w:tblBorders>'
  foreach ($e in @('top', 'left', 'bottom', 'right', 'insideH', 'insideV')) {
    $bd += '<w:' + $e + ' w:val="single" w:sz="6" w:space="0" w:color="808080"/>'
  }
  $bd += '</w:tblBorders>'
  $t = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + $bd + '</w:tblPr><w:tblGrid>' + $grid + '</w:tblGrid>'
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $isHeader = ($i -lt $headerRows)
    $t += (Row -cells $rows[$i] -widths $widths -header $isHeader)
  }
  # Word wants a paragraph after a table; keep it empty and tight.
  return $t + '</w:tbl>' + (Para -text '' -after 0 -size 12)
}

# ---------------------------------------------------------------- content
# Mirrors the rate card: service area, rates table, the charging rule, notes.
# This content lives HERE and nowhere else. The HTML intermediate used by the
# abandoned Word route was deleted, so there is no fifth copy of the terms to
# drift out of step with the other four.

$body = ''

$body += (Para -text 'ONSITE SERVICE ~em~ Rate Card' -size 34 -bold $true -after 40)
$body += (Para -text '**KaguyaSakayori PC Builds** (Carousell: KaguyaSakayori)' -size 20 -after 20)
$body += (Para -text 'Revised **2026-09-18**. Mirrors the published Carousell listing **1459963274**, which is the binding promise to the customer.' -size 20 -after 20)
$body += (Para -text 'Source of record: oswald/legal/standards/onsite-service-rate-card.md. If this document and the card disagree, the card wins.' -size 19 -after 220)

$body += (Heading 'Service area')
$body += (Para -text '**Standard rates ~em~ West Singapore:**' -size 21 -after 20)
$body += (Para -text 'Bukit Panjang ~md~ Choa Chu Kang ~md~ Bukit Batok ~md~ Bukit Gombak ~md~ Hillview ~md~ Jurong East/West ~md~ Tengah ~md~ Clementi' -size 21 -after 120)
$body += (Para -text '**Other areas:** +S$10~en~20 travel fee, quoted by location. **North Singapore (Woodlands ~md~ Marsiling ~md~ Sembawang) sits in this band, not the standard zone.**' -size 21 -after 20)
$body += (Para -text '**Bring-in:** available anywhere in Singapore.' -size 21 -after 80)
$body += (Para -text 'Warranty claims are not covered by the standard travel zone. Free onsite diagnosis applies within **5 km** of the base; beyond that, return is by courier (up to S$20 reimbursed) or onsite at service pricing.' -size 19 -after 220)

$body += (Heading 'Rates')
$rateRows = @(
  @('Service', 'Price', 'Notes'),
  @('Remote / quick diagnosis', '**Free**', ''),
  @('Onsite diagnosis', '**S$20 base, up to S$30**', 'By distance / complexity. **Credited back if the customer proceeds** with the repair or the teardown ~em~ finding the fault is not charged twice.'),
  @('**Deep fault isolation** ~em~ full teardown, disassembly, dusting and/or cross-board testing', '**S$60~en~100**', 'Includes the strip-down, the clean, the CPU repaste, the cross-board testing, the reassembly and the testing. **Parts extra.** **REPLACES the repair-labour quote** ~em~ never added on top of it. If the board has to come out for any purpose, this is the line. Where the price sits in the band is set by **difficulty, size and condition**.'),
  @('Component test / bring-in diagnosis', '**S$15~en~20**', '**Credited if I do the repair or the teardown.**'),
  @('Repair / replacement labour', '**S$40 + parts**', '**Partial access only** ~em~ PSU, RAM, drives, GPU, cooler out. **+S$15 same-visit add-on.** Anything needing the board out is Deep fault isolation, above.'),
  @('Any extra task, same visit', '**+S$15**', 'A second, separate job while the machine is already open. **Never charged for steps inside the same job.**'),
  @('Upgrade labour', '**S$35 + parts**', '**Includes the repaste** when the cooler comes off.'),
  @('Deep clean', '**S$25~en~35**', 'Dust removal, airflow restore. **No disassembly** ~em~ a full strip-down clean is the teardown line.'),
  @('Thermal repaste ~em~ **CPU + GPU**', '**S$20~en~35**, paste supplied', '**Standalone S$20~en~35.** Inside a build, upgrade or teardown the **CPU repaste is already included** in that job. A **GPU repaste is a second component coming apart**, so it is the **+S$15 same-visit add-on** ~em~ not a step inside the same job. Never charged twice for the same component.'),
  @('WiFi / Network / PCIe card install', '**S$10 + part cost**', 'Card supplied by the owner, brand new. In a build or standalone ~em~ one line, one price.')
)
$body += (Table -rows $rateRows -widths @(3100, 2000, 4538))

$body += (Heading 'The charging rule ~em~ one job, one labour charge')
$body += (Para -text 'Published on the listing as **"EACH TASK IS CHARGED ONCE, NO OVERLAP!"**' -size 21 -after 80)
$body += (Para -text '**A job is charged by how far the machine has to come apart, not by how many things get done inside it.**' -size 21 -after 100)
$depthRows = @(
  @('Depth', 'Jobs'),
  @('**Nothing comes apart**', 'Deep clean ~md~ card install'),
  @('**Partial**', 'PSU ~md~ RAM ~md~ drives ~md~ GPU ~md~ cooler out ~rarr~ **Repair / replacement labour S$40**'),
  @('**Full strip-down**', 'Board or cooler out for any purpose ~rarr~ **Deep fault isolation S$60~en~100**')
)
$body += (Table -rows $depthRows -widths @(2600, 7038))
$body += (Para -text 'Opening it, cleaning what is exposed, the repaste if the cooler comes off, testing it and putting it back are **all inside that one charge**.' -size 21 -after 100)
$body += (Para -text '**The cap ~em~ the price does not stack past the teardown.** If small-job labour ever adds up past the teardown price, **the teardown line applies instead**. (S$40 + S$15 = S$55 stays small-job; a third task at S$15 crosses the S$60 floor and becomes a teardown.)' -size 21 -after 100)
$body += (Para -text '**Where the teardown sits in the S$60~en~100 band.** Set by **difficulty, size and condition** ~em~ not by machine class, and not by a tier table. A compact office box, cooler staying on, clean inside: near S$60. A full ATX tower with a tower cooler or AIO out and years of dust: near S$100. Quoted with the machine in front of me, or from photos ~em~ never from the model name.' -size 21 -after 100)
$body += (Para -text '**Diagnosis is credited.** The same fault is never charged twice.' -size 21 -after 220)

$body += (Heading 'Notes')
$body += (Bullet '**Repaste covers CPU and GPU** (paste supplied). **Paste is not repadding** ~em~ thermal **pad** replacement is still not offered.')
$body += (Bullet 'Test bench covers **DDR3 / DDR4** and **AM4 / LGA1151 / 1200 / 1700**. **No DDR5.**')
$body += (Bullet '**No rework station** ~em~ no GPU repadding or board-level rework.')
$body += (Bullet 'Photo / video diagnosis before any charge. The price quoted is the price charged.')
$body += (Bullet 'Parts supplied separately from a build carry a **14-day DOA warranty** only.')

$body += (Heading 'Warranty claims ~em~ on PCs I built, covered faults only')
$body += (Bullet 'Free onsite diagnosis within **5 km**.')
$body += (Bullet 'Beyond 5 km: courier return (**I reimburse up to S$20**) or onsite at service pricing.')
$body += (Bullet 'North Singapore sits outside the 5 km radius.')

$document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  $body +
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
  '</w:body></w:document>'

$contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

$rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

# ---------------------------------------------------------------- write
$legal   = 'I:\PC_Test_Kit\LEGAL'
$target  = Join-Path $legal 'ONSITE SERVICE.docx'
$archive = Join-Path $legal 'ONSITE SERVICE (pre-2026-09-18 archive).docx'
$fallback = Join-Path $legal 'ONSITE SERVICE (2026-09-18 revised).docx'

if (-not (Test-Path -LiteralPath $legal)) { throw "Shared folder not reachable: $legal" }

# Archive the original before it is ever overwritten.
if (-not (Test-Path -LiteralPath $archive)) {
  if (-not (Test-Path -LiteralPath $target)) { throw "Neither the target nor an archive exists: $target" }
  Copy-Item -LiteralPath $target -Destination $archive
  'archived: ' + $archive
} else {
  'archive already present, left alone: ' + $archive
}

# ZipArchiveMode lives in System.IO.Compression; ZipFile lives in ...FileSystem.
# Both must be loaded or the type resolution fails at the Open() call.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Write-Package {
  param([string]$path)
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($path, [System.IO.Compression.ZipArchiveMode]::Create)
  # NOTE: the delete above is why this function only ever writes to the staging
  # file. An earlier version wrote straight to the target, so a failure after the
  # delete left the shared folder with no rate card at all.
  try {
    $map = @(
      @('[Content_Types].xml', $contentTypes),
      @('_rels/.rels', $rels),
      @('word/document.xml', $document)
    )
    foreach ($pair in $map) {
      $entry = $zip.CreateEntry($pair[0], [System.IO.Compression.CompressionLevel]::Optimal)
      $stream = $entry.Open()
      try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($pair[1])
        $stream.Write($bytes, 0, $bytes.Length)
      } finally {
        $stream.Dispose()
      }
    }
  } finally {
    $zip.Dispose()
  }
}

# Build and verify in staging first. The shared folder is only touched once a
# complete, checked document exists, so a failed build cannot cost the owner his
# rate card.
$staging = Join-Path $env:TEMP ('onsite-service-' + [Guid]::NewGuid().ToString('N') + '.docx')
Write-Package -path $staging

# ---------------------------------------------------------------- verify
# Re-open the package and prove the content is really in there before claiming success.
$verify = [System.IO.Compression.ZipFile]::OpenRead($staging)
try {
  $names = @()
  foreach ($e in $verify.Entries) { $names += $e.FullName }
  $docEntry = $verify.GetEntry('word/document.xml')
  if (-not $docEntry) { throw 'word/document.xml missing from the package' }
  $reader = New-Object System.IO.StreamReader($docEntry.Open())
  try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally {
  $verify.Dispose()
}

# Decode the character references back to real characters so the checks below test
# what a reader actually sees, not the entity spelling. [char] codes keep this
# source ASCII-only.
$en  = [char]0x2013   # en dash
$em  = [char]0x2014   # em dash
$md  = [char]0x00B7   # middle dot
$cup = [char]0x2192   # right arrow
$bul = [char]0x2022   # bullet

$plain = $xml
$plain = $plain -replace '&#8211;', $en
$plain = $plain -replace '&#8212;', $em
$plain = $plain -replace '&#183;',  $md
$plain = $plain -replace '&#8594;', $cup
$plain = $plain -replace '&#8226;', $bul
$plain = $plain -replace '&lt;', '<'
$plain = $plain -replace '&gt;', '>'
$plain = $plain -replace '&amp;', '&'

$expected = @(
  'ONSITE SERVICE',
  'KaguyaSakayori PC Builds',
  '1459963274',
  ('S$10' + $en + '20'),
  ('S$60' + $en + '100'),
  ('S$15' + $en + '20'),
  'S$40 + parts',
  'S$20 base, up to S$30',
  'EACH TASK IS CHARGED ONCE, NO OVERLAP!',
  'Full strip-down',
  'sits in this band, not the standard zone',
  'difficulty, size and condition',
  'CPU + GPU',
  '14-day DOA warranty'
)
# .Contains is used rather than -like: -like treats '*' as a wildcard, so the
# '**' assertion below would have matched any string and always failed.
$missing = @()
foreach ($needle in $expected) {
  if (-not $plain.Contains($needle)) { $missing += $needle }
}

$badEntities = @()
foreach ($bad in @('~em~', '~en~', '~md~', '~rarr~', '~bul~', '**', '&#')) {
  if ($plain.Contains($bad)) { $badEntities += $bad }
}

if ($missing.Count -gt 0)      { throw ('VERIFY FAILED - missing content: ' + ($missing -join ' | ')) }
if ($badEntities.Count -gt 0)  { throw ('VERIFY FAILED - unexpanded tokens left in output: ' + ($badEntities -join ' | ')) }
'verify  : OK - all ' + $expected.Count + ' markers present, no unexpanded tokens'
'entries : ' + ($names -join ', ')
'doc xml : ' + $xml.Length + ' chars'

# ---------------------------------------------------------------- swap into place
$savePath = $target
try {
  Move-Item -LiteralPath $staging -Destination $target -Force
} catch {
  $savePath = $fallback
  Move-Item -LiteralPath $staging -Destination $fallback -Force
  'target was locked - wrote to: ' + $savePath
}
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force }

$fi = Get-Item -LiteralPath $savePath
'written : ' + $savePath
'size    : ' + $fi.Length + ' bytes'
'modified: ' + $fi.LastWriteTime
