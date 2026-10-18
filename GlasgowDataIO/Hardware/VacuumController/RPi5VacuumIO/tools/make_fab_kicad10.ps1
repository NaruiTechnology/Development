<#
.SYNOPSIS
  Build the RPi5VacuumIO manufacturing package with KiCad 10 (Windows).
  Same steps, gates and output as tools/make_fab_kicad10.sh (Linux / macOS).

.DESCRIPTION
  1. adds the title block (revision, date) and the fabrication stackup (tools/prodprep.py)
  2. ERC (0 errors) and DRC with zone refill + schematic parity (0 errors, 0 unconnected,
     0 parity issues) - the package is not written unless these pass
  3. Gerber X2 + job file, Excellon (mm) + maps, IPC-D-356, IPC-2581, ODB++, BOM,
     pick-and-place, assembly + schematic PDFs, STEP, renders, fab notes, SHA256SUMS
  4. replaces fab\ with the new package and writes the checked board back

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\make_fab_kicad10.ps1
  powershell -ExecutionPolicy Bypass -File .\tools\make_fab_kicad10.ps1 -Rev A.2
#>
param(
  [string]$KiCadBin = "C:\Users\yingh\AppData\Local\Programs\KiCad\10.0\bin",
  [string]$Rev = "",
  [string]$Date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"),
  [switch]$NoSaveBoard
)
$ErrorActionPreference = "Stop"
$Cli  = Join-Path $KiCadBin "kicad-cli.exe"
$Py   = Join-Path $KiCadBin "python.exe"
if (-not (Test-Path $Py)) { $Py = "python" }
$Here = $PSScriptRoot
$Proj = Split-Path -Parent $Here
$N    = "RPi5VacuumIO"
$Fab  = Join-Path $Proj "fab"

if (-not (Test-Path $Cli)) { throw "kicad-cli not found at $Cli (pass -KiCadBin)" }
$ver = (& $Cli version).Trim()
if (-not $ver.StartsWith("10.")) { throw "need KiCad 10.x, found $ver" }
Write-Host "kicad-cli $ver"
if (-not $Rev) {
  $m = Select-String -Path "$Proj\$N.kicad_pcb" -Pattern '\(rev "([^"]*)"\)' | Select-Object -First 1
  $Rev = if ($m) { $m.Matches[0].Groups[1].Value } else { "A.1" }
}

function Cli([string]$Step, [string[]]$CliArgs, [switch]$AllowFail) {
  Write-Host "`n=== $Step ===" -ForegroundColor Cyan
  & $Cli @CliArgs | Out-Null
  if ($LASTEXITCODE -ne 0 -and -not $AllowFail) { throw "$Step failed (exit $LASTEXITCODE)" }
}

$W = Join-Path $env:TEMP "$N-kicad10-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force $W | Out-Null
Copy-Item "$Proj\$N.kicad_pcb","$Proj\$N.kicad_sch","$Proj\$N.kicad_pro" $W
$Pcb = Join-Path $W "$N.kicad_pcb"; $Sch = Join-Path $W "$N.kicad_sch"
& $Py "$Here\prodprep.py" $Pcb --rev $Rev --date $Date
if ($LASTEXITCODE -ne 0) { throw "prodprep failed" }

$Out = Join-Path $W "fab"; $Ger = Join-Path $Out "gerbers"; $Rep = Join-Path $Out "reports"; $Asm = Join-Path $Out "assembly"
New-Item -ItemType Directory -Force $Ger,$Rep,$Asm | Out-Null

Cli "ERC" @("sch","erc","--format","json","--units","mm","--severity-all","-o","$Rep\$N-erc.json",$Sch) -AllowFail
Cli "ERC report" @("sch","erc","--format","report","--units","mm","--severity-all","-o","$Rep\$N-erc.rpt",$Sch) -AllowFail
Cli "DRC" @("pcb","drc","--format","json","--units","mm","--severity-all","--refill-zones","--schematic-parity",
            "--save-board","-o","$Rep\$N-drc.json",$Pcb) -AllowFail
Cli "DRC report" @("pcb","drc","--format","report","--units","mm","--severity-all","--schematic-parity",
            "-o","$Rep\$N-drc.rpt",$Pcb) -AllowFail
$Adv = Join-Path $W "adv"; New-Item -ItemType Directory -Force $Adv | Out-Null
Copy-Item $Pcb,$Sch,"$W\$N.kicad_pro" $Adv
& $Py "$Here\fabnotes.py" advisory-project "$Adv\$N.kicad_pro"
Cli "DRC advisory" @("pcb","drc","--format","json","--units","mm","--severity-all","-o","$Rep\$N-drc-advisory.json","$Adv\$N.kicad_pcb") -AllowFail
& $Py "$Here\fabnotes.py" gate --erc "$Rep\$N-erc.json" --drc "$Rep\$N-drc.json" --summary "$Rep\summary.json"
if ($LASTEXITCODE -ne 0) { throw "release gate failed - see $Rep (fab\ was not changed)" }

$layers = "F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts"
Cli "Gerbers" @("pcb","export","gerbers","--layers",$layers,"--subtract-soldermask","--use-drill-file-origin","-o","$Ger\",$Pcb)
Cli "Drill" @("pcb","export","drill","--format","excellon","--excellon-separate-th","--excellon-units","mm",
              "--drill-origin","plot","--generate-map","--map-format","gerberx2","--generate-report",
              "--report-path","$Rep\$N-drill-report.txt","-o","$Ger\",$Pcb)
$Map = Join-Path $W "map"; New-Item -ItemType Directory -Force $Map | Out-Null
Cli "Drill map PDF" @("pcb","export","drill","--format","excellon","--excellon-separate-th","--drill-origin","plot",
              "--generate-map","--map-format","pdf","-o","$Map\",$Pcb)
Copy-Item "$Map\*-drl_map.pdf" $Out
Cli "IPC-D-356" @("pcb","export","ipcd356","-o","$Out\$N-ipcd356.ipc",$Pcb)
Cli "IPC-2581" @("pcb","export","ipc2581","--units","mm","--bom-col-mfg-pn","MPN","-o","$Out\$N-ipc2581.xml",$Pcb)
Cli "ODB++" @("pcb","export","odb","--units","mm","--compression","zip","-o","$Out\$N-odb.zip",$Pcb)
Cli "BOM" @("sch","export","bom","--fields",'Reference,${QUANTITY},Value,Footprint,MPN',
            "--labels","Refs,Qty,Value,Footprint,MPN / specification","--group-by","Value,Footprint,MPN",
            "--exclude-dnp","-o","$Asm\$N-bom.csv",$Sch)
Cli "Pick-and-place (SMD)" @("pcb","export","pos","--format","csv","--units","mm","--side","both","--smd-only",
            "--exclude-dnp","--use-drill-file-origin","-o","$Asm\$N-pos.csv",$Pcb)
Cli "Pick-and-place (all)" @("pcb","export","pos","--format","csv","--units","mm","--side","both",
            "--exclude-dnp","--use-drill-file-origin","-o","$Asm\$N-pos-all.csv",$Pcb)
Cli "Assembly PDF" @("pcb","export","pdf","--layers","F.Fab,Edge.Cuts","--common-layers","F.Silkscreen",
            "--include-border-title","--mode-single","-o","$Asm\$N-assembly-top.pdf",$Pcb)
Cli "Schematic PDF" @("sch","export","pdf","-o","$Out\$N-schematic.pdf",$Sch)
Cli "STEP" @("pcb","export","step","--subst-models","--force","-o","$Out\$N.step",$Pcb) -AllowFail
foreach ($side in "top","bottom") {
  Cli "Render $side" @("pcb","render","--side",$side,"--quality","basic","--width","1600","--height","1300",
                      "-o","$Out\$N-render-$side.png",$Pcb) -AllowFail
}
Cli "Stats" @("pcb","export","stats","--format","json","-o","$Rep\$N-stats.json",$Pcb) -AllowFail

& $Py "$Here\fabnotes.py" notes --board $Pcb --summary "$Rep\summary.json" --stats "$Rep\$N-stats.json" --advisory "$Rep\$N-drc-advisory.json" `
      --rev $Rev --date $Date --kicad $ver --out "$Out\README.md"
Compress-Archive -Path "$Ger\*" -DestinationPath "$Out\$N-gerbers-$Rev.zip" -Force
$sums = Get-ChildItem -Recurse -File $Out | Sort-Object FullName | ForEach-Object {
  $rel = $_.FullName.Substring($Out.Length + 1).Replace('\','/')
  "{0}  ./{1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $rel
}
$sums | Set-Content -Encoding ascii "$Out\SHA256SUMS"
Compress-Archive -Path "$Out\*" -DestinationPath "$W\$N-manufacturing-$Rev.zip" -Force
Move-Item "$W\$N-manufacturing-$Rev.zip" $Out

Remove-Item -Recurse -Force $Fab -ErrorAction SilentlyContinue
Copy-Item -Recurse $Out $Fab
if (-not $NoSaveBoard) { Copy-Item $Pcb "$Proj\$N.kicad_pcb" -Force; Write-Host "board written back (rev $Rev)" }
Remove-Item -Recurse -Force $W

Write-Host "`nDONE  rev $Rev" -ForegroundColor Green
Write-Host "  board house : fab\$N-gerbers-$Rev.zip"
Write-Host "  assembly    : fab\assembly\"
Write-Host "  everything  : fab\$N-manufacturing-$Rev.zip"
