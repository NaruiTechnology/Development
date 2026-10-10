# Glasgow revC3 scan-speed limits

This note documents the timing implemented by the current revC3 FPGA build. It
is a theoretical acquisition-time estimate, not a guarantee of end-to-end USB
or application throughput.

## Current minimum dwell

The Glasgow revC3 interface clock is 48 MHz, so one FPGA clock is 20.833 ns.
The active `streamData.json` uses the upstream OBI profile: `adcHalfPeriod = 3`,
`adcSettleCycles = 1`, `adcLatchCycles = 1`, `busTurnaroundCycles = 0`,
`dacDataSetupCycles = 1`, `dacLatchCycles = 1`. With this profile
`BusController` runs the unmodified upstream FSM (`UpstreamBusController`) and
toggles the ADC clock every three FPGA clocks, making one complete ADC/DAC
period:

```text
sample period = 2 × adcHalfPeriod / FPGA clock
              = 2 × 3 / 48 MHz
              = 125 ns
```

Therefore the current fastest setting, `dwell = 1`, is approximately 125 ns
per pixel, or 8.0 MPix/s before overhead. A dwell at or below 10 ns is not
possible with this clock and bus state machine. Even one 48 MHz FPGA clock is
20.833 ns.

The shared ADC/DAC transaction needs six FSM states in each ADC period
(`ADC_Wait`, `ADC_Read`, `X_DAC_Write`, `X_DAC_Write_2`, `Y_DAC_Write`,
`Y_DAC_Write_2`), which is exactly `2 × adcHalfPeriod` at `adcHalfPeriod = 3`.
Reducing `adcHalfPeriod` would violate the gateware timing assertion unless the
shared ADC/DAC transaction were redesigned. Non-default settings (extra settle,
latch, turnaround or DAC cycles) select the diagnostic-extended FSM in
`busController.py`, which requires
`adcLatchCycles + adcSettleCycles + busTurnaroundCycles + 2 × (dacDataSetupCycles + dacLatchCycles)`
states per period. That profile exists for bring-up experiments only and is not
the upstream-verified reference path.

## Dwell, resolution, and frame time

The gateware emits `dwell_time + 1` ADC conversions per pixel, and the UI sends
the dwell number unchanged (upstream OBI's GUI sends `dwell - 1`; this one does
not). A dwell of N therefore averages **N + 1** samples of 125 ns each:

```text
samples per pixel  = dwell + 1
pixel dwell        = (dwell + 1) × 125 ns
theoretical rate   = 1 / pixel dwell
square pixel count = resolution²
frame time floor   = resolution² × pixel dwell
```

The supersampler averages only the largest power-of-two prefix of those
samples, so the efficient dwell values are 2^k − 1 (1, 3, 7, 15, 31, 63…).

| Dwell | Samples / pixel | Pixel dwell | Theoretical pixel rate |
|---:|---:|---:|---:|
| 1 | 2 | 250 ns | 4.0 MPix/s |
| 3 | 4 | 500 ns | 2.0 MPix/s |
| 7 | 8 | 1.0 µs | 1.0 MPix/s |
| 15 | 16 | 2.0 µs | 500 kPix/s |
| 31 | 32 | 4.0 µs | 250 kPix/s |
| 63 | 64 | 8.0 µs | 125 kPix/s |

Dwell 0 would take a single sample (125 ns, 8.0 MPix/s) but the UI and API
require a dwell of at least 1.

At `dwell = 1`, the acquisition floors for square scans are approximately
16.4 ms at 256², 65.5 ms at 512², 262.1 ms at 1024², and 1.05 s at 2048².
For other dwell values multiply by `(dwell + 1) / 2`.

## Why measured scans are slower

The formula above covers the FPGA ADC/DAC cadence. Actual elapsed time also
includes command parsing, pipeline fill/drain, frame blanking and relay delays,
USB FIFO backpressure, chunking, host scheduling, and rendering. Raster runs
encode repeated pixels compactly and are normally closer to the acquisition
floor. Vector runs send explicit coordinate/dwell commands and can become USB
or host limited, especially without pre-processing.

Output mode changes return bandwidth (one byte versus two bytes per pixel), not
the ADC/DAC sample period. Latency changes batching and throughput stability,
not requested dwell. Resolution changes pixel count, not dwell per pixel.

## Source of truth

- `GlasgowDataIO/.../hardware/platform/rev_c.py`: 48 MHz revC clock.
- `GlasgowDataIO/.../applet/upstreamBusController.py`: the OBI reference FSM
  (commit 0f6e62c), including its six-cycle minimum-period assertion.
- `GlasgowDataIO/.../applet/busController.py`: selects the reference FSM for
  the upstream profile, otherwise the diagnostic-extended FSM.
- `GlasgowDataIO/Json/streamData.json`: active `adcHalfPeriod = 3`,
  `adcSettleCycles = 1` (upstream profile).
- `GlasgowDataIO/.../applet/supersampler.py`: repeats/averages ADC samples
  according to the dwell count.

Any change to the FPGA clock or ADC timing configuration must update the UI
timing constants and be verified on the analog hardware with timing analysis
and oscilloscope measurements.
