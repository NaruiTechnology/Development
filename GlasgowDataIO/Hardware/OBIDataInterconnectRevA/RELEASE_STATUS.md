# Release status

Status: engineering release candidate, not yet fabrication-cleared.

The KiCad 9 source, custom libraries, schematic, and assembly references are included. The local KiCad CLI is version 8 and rejects the source format, so this package intentionally does not claim a passing local DRC/ERC. Before fabrication, run KiCad 9 or newer on `board/OBI Data Interconnect.kicad_pcb` and `board/OBI Data Interconnect.kicad_sch`, then export fresh manufacturing outputs from that same source revision. The repeatable export command is `tools/export_manufacturing.sh`; the release gate is listed in `manufacturing/RELEASE_CHECKLIST.md`.

Acceptance checks:

- DRC: zero unconnected items and zero clearance/edge violations.
- ERC: no power-input or connector no-connect errors introduced by the interconnect.
- Net audit: D-1..D-24 each appears once at its intended field-header signal pin and remains isolated from all other D nets.
- Power audit: JP1 and JP2 cannot be assembled together; external and Glasgow source nets remain distinct until the selected jumper.
- Bench: verify all 14 active bus bits and the six timing/control nets with the Glasgow applet at the intended pixel rate.
