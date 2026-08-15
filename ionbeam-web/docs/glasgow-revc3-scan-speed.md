# Glasgow revC3 scan-speed limits

This note documents the timing implemented by the current revC3 FPGA build. It
is a theoretical acquisition-time estimate, not a guarantee of end-to-end USB
or application throughput.

## Current minimum dwell

The Glasgow revC3 interface clock is 48 MHz, so one FPGA clock is 20.833 ns.
The active `streamData.json` sets `adcHalfPeriod` to 4 and
`adcSettleCycles` to 2. `BusController` toggles the ADC clock after four FPGA
clocks, making one complete ADC/DAC period:

```text
sample period = 2 × adcHalfPeriod / FPGA clock
              = 2 × 4 / 48 MHz
              = 166.667 ns
```

Therefore the current fastest setting, `dwell = 1`, is approximately 166.7 ns
per pixel, or 6.0 MPix/s before overhead. A dwell at or below 10 ns is not
possible with this clock and bus state machine. Even one 48 MHz FPGA clock is
20.833 ns.

`BusController` requires `adcSettleCycles + 6` states in each ADC period. With
the configured two settle cycles, the required period is eight clocks, exactly
the current `2 × adcHalfPeriod`. Reducing `adcHalfPeriod` would violate the
gateware timing assertion unless the shared ADC/DAC transaction were redesigned.

## Dwell, resolution, and frame time

The UI dwell number is the number of ADC sample periods accumulated for one
logical pixel:

```text
pixel dwell       = dwell × 166.667 ns
theoretical rate  = 1 / pixel dwell
square pixel count = resolution²
frame time floor  = resolution² × pixel dwell
```

| Dwell | Pixel dwell | Theoretical pixel rate |
|---:|---:|---:|
| 1 | 166.7 ns | 6.0 MPix/s |
| 2 | 333.3 ns | 3.0 MPix/s |
| 4 | 666.7 ns | 1.5 MPix/s |
| 8 | 1.333 µs | 750 kPix/s |
| 16 | 2.667 µs | 375 kPix/s |
| 64 | 10.667 µs | 93.75 kPix/s |

At `dwell = 1`, the acquisition floors for square scans are approximately
10.9 ms at 256², 43.7 ms at 512², 174.8 ms at 1024², and 699.1 ms at
2048². Multiply these values by the dwell number.

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
- `GlasgowDataIO/.../applet/busController.py`: ADC divider and the
  `adcSettleCycles + 6` minimum-period assertion.
- `GlasgowDataIO/Json/streamData.json`: active `adcHalfPeriod = 4` and
  `adcSettleCycles = 2` configuration.
- `GlasgowDataIO/.../applet/supersampler.py`: repeats/averages ADC samples
  according to the dwell count.

Any change to the FPGA clock or ADC timing configuration must update the UI
timing constants and be verified on the analog hardware with timing analysis
and oscilloscope measurements.
