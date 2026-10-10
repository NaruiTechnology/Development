<#
.SYNOPSIS
  Build the manufacturing package for RPi5VacuumIO (Raspberry Pi 5 vacuum controller I/O board) with KiCad 10 (Windows).

.DESCRIPTION
  Uses kicad-cli from KiCad 10 to:
    1. run ERC on the schematic        (stops on errors)
    2. refill zones + run DRC with schematic parity, saving the board in KiCad 10 format (stops on errors)
    3. export Gerber X2, Excellon drill + maps, pick-and-place, BOM, schematic/assembly PDFs, STEP, IPC-2581
    4. zip Gerbers+drill for the board house and zip the whole package

  Output: <project>\fab\kicad10\  (the KiCad 7 outputs in fab\ are left untouched)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\make_fab_kicad10.ps1
#>
param(
  [string]$KiCadBin = "C:\Users\yingh\AppData\Local\Programs\KiCad\10.0\bin",
  [switch]$NoSaveBoard   # do not write the zone-refilled KiCad 10 board back to the project
)
$ErrorActionPreference = "Stop"
$Cli  = Join-Path $KiCadBin "kicad-cli.exe"
$Proj = Split-Path -Parent $PSScriptRoot
$N    = "RPi5VacuumIO"
$Sch  = Join-Path $Proj "$N.kicad_sch"
$Pcb  = Join-Path $Proj "$N.kicad_pcb"
$Out  = Join-Path $Proj "fab\kicad10"
$Ger  = Join-Path $Out  "gerbers"

if (-not (Test-Path $Cli)) { throw "kicad-cli not found at $Cli (pass -KiCadBin)" }
Write-Host "kicad-cli version:" (& $Cli version)

function Run([string]$Step, [string[]]$CliArgs, [switch]$AllowFail) {
  Write-Host "`n=== $Step ===" -ForegroundColor Cyan
  & $Cli @CliArgs
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFail) { throw "$Step failed (exit $code)" }
  return $code
}

Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Ger | Out-Null

# Work on a copy so the refilled/upgraded board is only written back when DRC passes.
$Tmp = Join-Path $env:TEMP "$N-kicad10"
Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Tmp | Out-Null
Copy-Item "$Proj\$N.*" $Tmp
$TSch = Join-Path $Tmp "$N.kicad_sch"; $TPcb = Join-Path $Tmp "$N.kicad_pcb"

# 1. ERC
$erc = Run "ERC" @("sch","erc","--format","report","--units","mm","--severity-all",
                   "--exit-code-violations","-o","$Out\$N-erc.rpt",$TSch) -AllowFail
$ercErrors = (Select-String -Path "$Out\$N-erc.rpt" -Pattern "Severity: error" -SimpleMatch).Count
Write-Host "ERC errors: $ercErrors (warnings are listed in $N-erc.rpt)"
if ($ercErrors -gt 0) { throw "ERC has errors - see $Out\$N-erc.rpt" }

# 2. DRC (refill zones, check schematic parity, save refilled board)
Run "DRC" @("pcb","drc","--format","report","--units","mm","--severity-all","--refill-zones",
            "--schematic-parity","--save-board","--exit-code-violations",
            "-o","$Out\$N-drc.rpt",$TPcb) -AllowFail | Out-Null
$drcErrors = (Select-String -Path "$Out\$N-drc.rpt" -Pattern "Severity: error" -SimpleMatch).Count
$unconn = Select-String -Path "$Out\$N-drc.rpt" -Pattern "Found (\d+) unconnected" | ForEach-Object { [int]$_.Matches[0].Groups[1].Value }
Write-Host "DRC errors: $drcErrors, unconnected: $unconn"
if ($drcErrors -gt 0 -or $unconn -gt 0) { throw "DRC failed - see $Out\$N-drc.rpt" }
if (-not $NoSaveBoard) {
  Copy-Item $TPcb $Pcb -Force
  Copy-Item $TSch $Sch -Force -ErrorAction SilentlyContinue
  Write-Host "Saved KiCad 10 board (zones refilled) back to the project."
}

# 3. Fabrication outputs
$layers = "F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts"
Run "Gerbers" @("pcb","export","gerbers","--layers",$layers,"--subtract-soldermask",
                "--use-drill-file-origin","--check-zones","-o","$Ger\",$TPcb) | Out-Null
Run "Drill"   @("pcb","export","drill","--format","excellon","--excellon-separate-th",
                "--drill-origin","plot","--excellon-units","mm","--generate-map","--map-format","gerberx2",
                "-o","$Ger\",$TPcb) | Out-Null
Run "Pick-and-place" @("pcb","export","pos","--format","csv","--units","mm","--side","both",
                "--smd-only","--exclude-dnp","--use-drill-file-origin","-o","$Out\$N-pos.csv",$TPcb) | Out-Null
Run "BOM" @("sch","export","bom","--fields",'Reference,Value,Footprint,MPN,Description,${QUANTITY},${DNP}',
            "--labels","Refs,Value,Footprint,MPN,Description,Qty,DNP","--group-by","Value,Footprint,MPN",
            "--exclude-dnp","-o","$Out\$N-bom.csv",$TSch) | Out-Null
Run "Schematic PDF" @("sch","export","pdf","-o","$Out\$N-schematic.pdf",$TSch) | Out-Null
Run "Assembly PDF" @("pcb","export","pdf","--layers","F.Fab,F.Silkscreen,Edge.Cuts","--include-border-title",
            "-o","$Out\$N-assembly-top.pdf",$TPcb) -AllowFail | Out-Null
Run "STEP" @("pcb","export","step","--subst-models","--force","-o","$Out\$N.step",$TPcb) -AllowFail | Out-Null
Run "IPC-2581" @("pcb","export","ipc2581","-o","$Out\$N.xml",$TPcb) -AllowFail | Out-Null

# 4. Zips
Compress-Archive -Path "$Ger\*" -DestinationPath "$Out\$N-gerbers.zip" -Force
$pkg = Join-Path $Proj "fab\$N-manufacturing-kicad10.zip"
Compress-Archive -Path "$Out\*" -DestinationPath $pkg -Force

Write-Host "`nDONE" -ForegroundColor Green
Write-Host "  Board house upload : $Out\$N-gerbers.zip"
Write-Host "  Assembly (BOM/CPL) : $Out\$N-bom.csv, $Out\$N-pos.csv"
Write-Host "  Full package       : $pkg"
