# OBI Data Interconnect Rev A

Redesigned companion interconnect for the Glasgow Interface Explorer rev C3 and the OBI scan subtarget. This board is passive: it carries the Glasgow expansion signals to three 2x10 field headers and provides mutually exclusive Glasgow/external 3.3 V selection.

The electrical baseline is the KiCad 9 source from `/home/vboxuser/Downloads/rawData/硬件文档/OBI Data Interconnect.kicad_pcb`. The board keeps the proven connector, resistor-array, jumper, capacitor, and mounting hardware population. The redesign makes the shared-bus contract explicit on the board and in the release documentation:

- J3: D-1 through D-8
- J4: D-9 through D-16
- J2: D-17 through D-24
- D-1 through D-14 are the active 14-bit ADC/DAC bus for the scan subtarget; D-15 through D-24 remain reserved.
- Glasgow `+3.3V` and external `+3.3V` are selected by JP1/JP2; both jumpers must never be fitted together.
- GNDD is the digital return used by this interconnect. It is not silently merged with the analog return on the scan board.

## Source

- `board/OBI Data Interconnect.kicad_pcb`
- `board/OBI Data Interconnect.kicad_sch`
- `board/OBI Data Interconnect.kicad_pro`
- `board/OBI Data Interconnect.pretty/`
- `board/Scan Generator.pretty/`
- `board/3D Models/`

## Companion contract

See [SHARED_BUS_CONTRACT.md](../ScanSubtargetRevA/SHARED_BUS_CONTRACT.md) and [PINOUT.md](PINOUT.md). The interconnect does not perform ADC/DAC arbitration; the Glasgow applet owns the cycle timing. The board only preserves the one-bus physical mapping and supplies controlled connector/power access.

## Release caveat

The source is KiCad 9 format. The container currently has KiCad 8 CLI, which cannot parse this source. Therefore the package includes the complete source and audit evidence, but the revised board has not been fabrication-cleared by a local KiCad 9 DRC/ERC run in this session. Run KiCad 9 DRC/ERC and regenerate Gerbers, drill, position, STEP, and IPC-2581 before ordering.
