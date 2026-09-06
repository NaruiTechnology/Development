$ErrorActionPreference = 'Stop'
$cli = 'C:\Users\yingh\AppData\Local\Programs\KiCad\10.0\bin\kicad-cli.exe'
$scan = 'C:\Project\IobeamTech\Development\GlasgowDataIO\Hardware\ScanSubtargetRevA'
$conn = 'C:\Project\IobeamTech\Development\GlasgowDataIO\Hardware\OBIDataInterconnectRevA'
$sb = Join-Path $scan 'board\Open Beam Interface.kicad_pcb'
$ss = Join-Path $scan 'board\Open Beam Interface.kicad_sch'
$cb = Join-Path $conn 'board\OBI Data Interconnect.kicad_pcb'
$cs = Join-Path $conn 'board\OBI Data Interconnect.kicad_sch'
$so = Join-Path $scan 'manufacturing\kicad10'
$co = Join-Path $conn 'manufacturing\kicad10'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $so 'gerbers'),(Join-Path $co 'gerbers')
& $cli pcb export gerbers --check-zones -o (Join-Path $so 'gerbers') $sb
& $cli pcb export drill -o (Join-Path $so 'gerbers') $sb
& $cli pcb export pos --format csv --units mm -o (Join-Path $so 'scan_subtarget-pos.csv') $sb
& $cli pcb export ipc2581 -o (Join-Path $so 'scan_subtarget-ipc2581.xml') $sb
& $cli pcb export step --force -o (Join-Path $so 'scan_subtarget.step') $sb
& $cli sch export pdf -o (Join-Path $so 'scan_subtarget-schematic.pdf') $ss
& $cli pcb export pdf --mode-multipage --check-zones -o (Join-Path $so 'scan_subtarget-layers.pdf') $sb
& $cli pcb render -o (Join-Path $so 'scan_subtarget-top.png') --width 2400 --height 1600 --quality high $sb
& $cli pcb export gerbers --check-zones -o (Join-Path $co 'gerbers') $cb
& $cli pcb export drill -o (Join-Path $co 'gerbers') $cb
& $cli pcb export pos --format csv --units mm -o (Join-Path $co 'obi-interconnect-pos.csv') $cb
& $cli pcb export ipc2581 -o (Join-Path $co 'obi-interconnect-ipc2581.xml') $cb
& $cli pcb export step --force -o (Join-Path $co 'obi-interconnect.step') $cb
& $cli sch export pdf -o (Join-Path $co 'obi-interconnect-schematic.pdf') $cs
& $cli pcb export pdf --mode-multipage --check-zones -o (Join-Path $co 'obi-interconnect-layers.pdf') $cb
& $cli pcb render -o (Join-Path $co 'obi-interconnect-top.png') --width 2400 --height 1600 --quality high $cb
