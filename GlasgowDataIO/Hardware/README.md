# Hardware workspace

The active scan/acquisition redesign starts at
[ScanAcquisitionV2](ScanAcquisitionV2/README.md). It is a new architecture with
independent ADC and DAC data paths, started on 2026-09-10. Component selection,
schematic and layout are not yet complete.

| Location | Purpose |
| --- | --- |
| `ScanAcquisitionV2/` | Active scan/acquisition design from a fresh requirements baseline |
| `archive/obi-shared-bus-20260910/` | Preserved OBI-derived scan/interconnect source, libraries, evidence and manufacturing packages |
| `kitcard/` | Existing motion/stage-control projects; outside this redesign |

The old top-level `ScanSubtargetRevA`, `OBIDataInterconnectRevA`, and `tools`
directories moved together into the dated archive. Its `MANIFEST.json` records
SHA256 and size for all 307 original files; every file was checked after moving.
No old PCB copper, schematic circuitry, BOM, footprints, pinout, or fabrication
exports have been copied into the active project. Retained archive documents
are historical; their prior release claims do not apply to the new design.
