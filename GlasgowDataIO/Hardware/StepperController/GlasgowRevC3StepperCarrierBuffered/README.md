# Glasgow Rev C3 Buffered Stepper Carrier

This is the buffered revision of the generic Glasgow rev C3 stepper carrier.

Differences from the passive carrier:
- Adds a real buffer IC
- Adds local decoupling
- Adds a dedicated 3.3V supply pin on the Glasgow-side connector

## Function

The board converts the Glasgow rev C3 control lines into buffered step/dir/enable
outputs for an external stepper driver.

## Connectors

- `J1`: Glasgow-side 1x05 header
  - `STEP_IN`
  - `DIR_IN`
  - `EN_IN`
  - `GND`
  - `+3V3`
- `J2`: driver-side 1x04 header
  - `STEP_OUT`
  - `DIR_OUT`
  - `EN_OUT`
  - `GND`

## Active parts

- `U1`: triple buffer, `74LVC3G17` class device
- `C1`: 100 nF decoupling capacitor

## Why buffered

This revision is useful when you want:
- cleaner edges on long cables
- better isolation between the Glasgow board and the driver header
- a more realistic fabrication-ready board with at least one active IC

## Notes

- The design is still generic and driver-agnostic.
- It does not drive motor coils directly.
- It only conditions the STEP/DIR/EN control lines.
- KiCad schematic and PCB files are stored in this directory.

