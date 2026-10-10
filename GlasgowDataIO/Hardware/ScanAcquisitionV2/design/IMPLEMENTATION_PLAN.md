# FPGA and host implementation plan

This is planned work for the new board, not changes to the running instrument.

## Hardware abstraction

Define independent ADC capture and XY output interfaces behind the existing
scan-command machinery. Implement the selected converter's actual timing and
configuration rather than retaining shared-bus ownership states. Update ADC-only,
normal acquisition and output-only modes together. Identify the board/interface
version so an incompatible pin map or gateware image cannot be selected silently.

## Sample width and framing

Current limitations found in the source tree:

- `applet/__init__.py`, `busController.py` and `supersampler.py` use 16-bit
  internal ADC words; physical acquisition is 14 bits.
- `commandExecutor.py` and `imageSerializer.py` expose 16-bit image streams.
- `supersampler.py` has 32-bit sums. Exact unsigned accumulation of 65536
  full-scale 24-bit samples requires 40 bits, plus any algorithm-specific needs.
- `transfer/adcStream.py` decodes `array('H')` and the ADC test stream uses an
  all-ones termination marker. Native full-width ADC values must never collide
  with framing; the legacy marker scheme needs explicit replacement/versioning.
- Frontend scan/ADC decoding, image stores, display normalization and CSV paths
  use Uint16Array and/or the old 0x3fff scale.

Parameterize converter width and coding through capture, accumulation and
serialization. Propose a versioned 32-bit sample container supporting up to
24 native bits, with an explicit coding convention and separate status fields.
Finalize byte order, padding/sign extension and frame headers in an interface
specification before implementation. Preserve original raw values in recording;
display contrast mapping is a separate operation. Define overflow/invalid data
independently from valid numeric maximum/minimum values.

For a native 16-bit converter, much of the numeric path fits but physical capture,
full-scale interpretation, framing and ADC-test masks still require review.
For 24 bits, coordinated FPGA, service, transport, frontend and export changes
are required; this is a larger task than splitting the existing buses alone.

## Pixel association

Implement the timing contract in ARCHITECTURE.md with matched data/tag FIFOs,
configurable settling and conversion latency, and explicit missing-sample flags.
Retain raster/vector command behavior where practical. If the XY DAC width also
changes, version the coordinate mapping and calibration separately from ADC width.

## Staged work

1. Close requirements, choose carrier/interface, and produce pin/timing/bandwidth budgets.
2. Compare ADC/DAC/reference/driver options and create a fresh schematic and BOM.
3. Simulate independent capture/output modules and tagged pixel sequencing.
4. Extend the versioned host data path and full-resolution recording/display.
5. Validate schematic, footprints and layout; produce new exports from new sources.
6. Bring up the board with calibrated sources and measured XY/ADC timing.

A bus-only refactor estimate does not cover the full 24-bit end-to-end migration
or the analog PCB design. Re-estimate after the converter and controller choices.
