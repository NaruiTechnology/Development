# Reference ADC failure evidence

## Capture comparison

Analyzed the top-level `GlasgowService.log` in each supplied capture folder.
The `tmp/glasgow.log` files contain service HTTP traffic; their names alone do
not identify them as ADC sample captures. The current image serializer emits
the high byte first, consistent with the recorded `3fff` sample words.

| Capture | Data-read records | Visible complete words | Visible values |
| --- | ---: | ---: | --- |
| Production, `生产模式_矢量` | 8,177 | 261,648 | Only `0x3FFF` |
| Simulation, `仿真模式_矢量` | 8,177 | 261,648 | Eight values, `0x0000` through `0xE000` in `0x2000` steps |
| X/Y, `X_and_Y_矢量` | 8,177 | 261,648 | Only `0x3FFF` |

For each capture, 8,176 of the data-read records contain truncated payloads.
Each also contains one four-byte synchronization reply, excluded from the
sample counts. These are statistics of the visible excerpts, not all samples
transferred and not unique conversion events. Source hashes and line locations
are in `evidence/reference_audit.json`.

Production evidence locations:

- Line 45: synchronization reply `ffff007b`.
- Line 54: first visible all-`3fff` data read.
- Final read: also all `3fff`.
- End of log: `scan end kind=vector ok=True` despite the constant signal.

The scope photograph `生产模式_矢量/探测器信号.jpg` displays approximately
Vmin = -0.18 V, Vmax = +0.35 V and Vpp = 0.53 V. It indicates a changing signal
at the probed point. The exact probe location, scale calibration, termination,
and simultaneous relationship to ADC sampling are not established.

The simulation exercises a synthetic source, including values above a 14-bit
raw ADC's maximum. It is evidence that this logged software path can carry
changing words, not proof of the physical ADC path or identical scaling.

## Reference circuit and current platform

The reference schematic was read and visually inspected. Pad net assignments
were independently extracted from the supplied KiCad PCB. They do not establish
the actual soldered population or measured continuity.

- U9 is labeled `LTC2246HLX#PBF`, a 48-pin LQFP part. Use the **LTC2246H**
  documentation for this package, not the different LTC2246 QFN pinout.
- U9 CLK, pin 14, is `/S.CLK_A`. OE, pin 17, and shutdown, pin 16, are assigned
  to ground. Thus the gateware's `adc_oe` controls U6, not U9's own OE pin.
- U9 data D0-D13 feeds U6. U6 is labeled `SN74ALVCH16374DGGR`; its OE pins 1/24
  connect to `/S.WRITE_A` and clock pins 25/48 to `/S.LATCH_A`.
- The symbol labels these clock pins `LE`, but the specified 16374 is an
  edge-triggered register, not a transparent latch. New symbols and timing
  models must match the selected manufacturer's device.
- U9 overflow, pin 41, goes to `/A-15`, U6 input 27, U6 output 22, `/D-15`,
  and main-board J4 pin 15. The interconnect routes that bit toward FPGA E1.
  The checked-out configuration reads only D0-D13 and the subtarget pads the
  upper two input bits with zero. Overflow is therefore absent from that raw
  acquisition path.
- U9 MODE pin 42 connects to a jumper net. The physical jumper position is
  unknown. The new design must define and verify its output coding explicitly.
- Rev-C target code specifies a 48 MHz synchronous clock. Current configuration
  `adcHalfPeriod=6` implies a nominal 4 MHz ADC clock. This calculation does
  not prove the clock or firmware present during the July captures, or prove
  one accepted scan point per ADC period.

Primary device sources, accessed 2026-09-06:

- [ADI LTC2246H, package and device documentation](https://www.analog.com/en/products/ltc2246h.html)
- [TI SN74ALVCH16374, edge-triggered register](https://www.ti.com/product/SN74ALVCH16374)

## Conclusions and design consequences

Confirmed: the visible production data is constant at the 14-bit maximum and
the recorded scan is nevertheless reported successful. A varying upstream
signal does not appear in those visible sample words. The checked-out acquisition
interface discards a physically routed overflow signal.

Not established: that the ADC silicon is defective, that an analog input is
saturating, that the bus floats, or that output-enable/clock timing is the root
cause. The logs cannot distinguish these. The new-board request does not
depend on repairing the old board.

For the new design, preserve the existing shared ADC/DAC bus while making bus
ownership, register output-enable timing, and overflow visibility measurable.
Define analog gain and common mode by calculation, and provide accessible
measurements at the connector, amplifier output, ADC pins, reference, supply
rails, and digital interface. Validate conversion independently of beam scanning
before closing the full system loop, then verify that each accepted sample remains
associated with the XY pixel that initiated it.
