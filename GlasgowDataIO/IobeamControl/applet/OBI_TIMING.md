# Upstream OBI scan baseline

Reference: the downloaded Open-Beam-Interface checkout at
`0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f`.

The default controller now executes the upstream `elaborate` implementation
in `upstreamBusController.py`. That method is copied unchanged. Imports and
the host ADC stream container are adapted to this application (16 bits,
right-aligned raw14; full16 is retained for simulation).

At 48 MHz the reference JSON settings are:

```json
{
  "adcHalfPeriod": 3,
  "adcSettleCycles": 1,
  "adcLatchCycles": 1,
  "busTurnaroundCycles": 0,
  "dacDataSetupCycles": 1,
  "dacLatchCycles": 1
}
```

Sequence beginning at logical ADC rising / physical ADC falling:

| Tick | State | ADC LE | Logical ADC OE | FPGA data OE | DAC latch |
| --- | --- | --- | --- | --- | --- |
| 0 | ADC_Wait trigger | 1 | 1 | 0 | — |
| 1 | ADC_Read | 0 | 1 | 0 | — |
| 2 | X_DAC_Write | 0 | 0 | 1 | — |
| 3 | X_DAC_Write_2 | 0 | 0 | 1 | X |
| 4 | Y_DAC_Write | 0 | 0 | 1 | — |
| 5 | Y_DAC_Write_2 | 0 | 0 | 1 | Y |

ADC and DAC clocks remain tied together. Physical G1/F3 clocks and G3 OE
are inverted exactly once by their buffers. No logical ADC/FPGA drive overlap
occurs, but the reference has no extra high-impedance handoff cycle. Earlier
claims that a turnaround of zero was inherently invalid were not established
by measurements; it is the user's working upstream design.

The FIFO captures input at the end of ADC_Read. Acceptance and last-sample
tags pass through the upstream eight-conversion pipeline. Executor blanking
changes on the logical DAC rising edge, as upstream, rather than on every
48 MHz sync edge. The nominal conversion rate is 8 MS/s. Gateware emits
dwell_time + 1 conversions per pixel.

All six JSON parameters remain available. A non-reference window width
selects the configurable diagnostic FSM in busController.py. It is not
represented as cycle-identical to upstream. The complete transaction must
fit in the chosen period, and ADC latch plus read must fit in a half-period.
Zero turnaround is accepted by Python, the backend, and the settings UI.

Standalone ADC TEST is a different diagnostic: it keeps OE asserted while
running and leaves data pins input-only, without DAC strobes. Its default
latch/read phases are 3/4, but it is not an end-to-end OBI scan equivalence
test. Use the scan path for the hardware A/B comparison.

Timing parameters are FPGA build inputs. Editing JSON does not change an
already programmed image; the next applet build/download applies them.
The launcher records the profile, loaded implementation path, code digest
and bitstream ID.

See glasgow_service/docs/upstream-alignment-2026-09-18.md for the verified
differences, differential tests, production build, and remaining uncertainty.
