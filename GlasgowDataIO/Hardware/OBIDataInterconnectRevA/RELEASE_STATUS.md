# Release status

Status: engineering release candidate, not yet fabrication-cleared.

The KiCad source, custom libraries, schematic, and assembly references are
included. KiCad 10.0.3 was run on the source on 2026-09-06. ERC reports 2
violations and PCB DRC reports 48 warnings with 31 schematic-parity warnings;
the reports are saved under `evidence/`. Fresh KiCad 10 exports are under
`manufacturing/kicad10/`: Gerbers and drills, placement CSV, IPC-2581 XML,
STEP, schematic PDF, layer PDF, and a top-side PNG render. The warnings remain
fabrication review items, especially the parity/net-name warnings.
The consolidated handoff archive is
`manufacturing/OBIDataInterconnectRevA-KiCad10-fabrication-package.zip`; the
individual Gerbers are in `manufacturing/kicad10/gerbers/`.

Acceptance checks:

- DRC: zero unconnected items and zero clearance/edge violations.
- ERC: no power-input or connector no-connect errors introduced by the interconnect.
- Net audit: D-1..D-24 each appears once at its intended field-header signal pin and remains isolated from all other D nets.
- Power audit: JP1 and JP2 cannot be assembled together; external and Glasgow source nets remain distinct until the selected jumper.
- Bench: verify all 14 active bus bits and the six timing/control nets with the Glasgow applet at the intended pixel rate.
