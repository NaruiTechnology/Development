# Scan Acquisition V2

Status: requirements and architecture draft, started 2026-09-10.
This is a fresh detector-acquisition and synchronous XY-output design. V2 is an
architecture/workspace name, not a fabricated board revision.

## Design basis

- Independent ADC input and DAC output paths; no shared bidirectional ADC/DAC
  data bus and no runtime tri-state arbitration between the two.
- Evaluate native 16–24-bit conversion against sample rate and measured noise.
- Preserve explicit association between detector samples and commanded XY pixels.
- Select components, carrier, connectors, power and layout from the new
  requirements rather than inheriting the OBI board.

## Working documents

- [Requirements and open decisions](design/REQUIREMENTS.md)
- [Architecture and pixel timing](design/ARCHITECTURE.md)
- [Converter tradeoffs and sources](design/ADC_OPTIONS.md)
- [FPGA and software migration](design/IMPLEMENTATION_PLAN.md)
- [Verification plan](verification/PLAN.md)
- [CAD starting point](board/README.md)
- [Manufacturing status](manufacturing/README.md)

The old design remains available in the [dated archive](../archive/obi-shared-bus-20260910/README.md).
No converter, FPGA/carrier, connector or analog circuit has been selected.
No new schematic, routed PCB or manufacturing package is claimed complete.
Existing runtime software and hardware operation were not changed by this cleanup.
