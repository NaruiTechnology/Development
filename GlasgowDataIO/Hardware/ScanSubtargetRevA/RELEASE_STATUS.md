# Release status

Package location: `Hardware/ScanSubtargetRevA/`.

Included:

- Rev-A4 KiCad schematic, PCB, project, symbols, footprints, netlist, schematic
  PDF, BOM, and interactive BOM under `board/`.
- Shared ADC/DAC bus and pixel timing contract.
- Production/simulation capture audit and source hashes.
- Existing Glasgow pin mapping and applet timing references.
- Generated manufacturing exports under `manufacturing/`: four-layer Gerbers,
  drill file, position file, and IPC-2581 XML.

Verified in this workspace:

- Reference files copied without source modification.
- Evidence audit regenerated and matched `evidence/reference_audit.json`.
- Audit regression tests pass.
- Reference PCB was parsed for footprint, track, via, zone, and selected pad-net
  counts.
- Reference device sources were checked for LTC2246H package/range and the
  SN74ALVCH16374 register function.

KiCad 10.0.3 validation and export results (2026-09-06):

- Schematic ERC reports zero errors. The all-message report is
  `evidence/kicad10/schematic_erc_final.txt`; the error-only gate is
  `evidence/kicad10/erc_errors_only.txt`.
- PCB DRC reports zero unconnected pads and 18 rule warnings. With schematic
  parity enabled, the report contains 50 footprint/net parity warnings; it is
  saved as `evidence/kicad10/pcb_drc_final.txt`.
- Fresh KiCad 10 exports are under `manufacturing/kicad10/`: Gerbers and
  drills, placement CSV, IPC-2581 XML, STEP, schematic PDF, layer PDF, and a
  top-side PNG render.
- A consolidated handoff archive is available at
  `manufacturing/ScanSubtargetRevA-KiCad10-fabrication-package.zip`. The
  individual Gerbers are in `manufacturing/kicad10/gerbers/`.

Previous validation results:

- KiCad 8.0.8 DRC runs successfully, reports 212 violations, and reports zero
  unconnected items after adding the four missing power-pad/track joins on
  U1/U2/U3/U19. The remaining violations are 199 library-table warnings and
  9 silk-over-copper plus 4 silk-text-size warnings; the report is saved as
  `evidence/pcb_drc.txt`.
- KiCad 8.0.8 ERC runs successfully, but reports 13 violations: 12 errors and
  1 warning. The report is saved as `evidence/schematic_erc.txt`.

Remaining release checks:

- Fabricator stackup, impedance, copper weight, and manufacturing constraints.
- Schematic-to-PCB netlist agreement after any Rev-A edits.
- Electrical/bench validation and sign-off of the inherited parity warnings.
- Physical ADC/DAC timing, bus contention, analog range, or X/Y calibration.

KiCad CLI was supplied through a temporary extracted runtime so the checks and
exports could run. The exported files are therefore useful review artifacts, but
the package remains blocked from fabrication by the reported ERC/DRC findings
and by the absence of electrical/bench validation.

The package becomes manufacturing-ready only after the Rev-A4 source is revised
under `SHARED_BUS_CONTRACT.md`, then ERC/DRC, netlist, export, and bench
acceptance checks are signed.
