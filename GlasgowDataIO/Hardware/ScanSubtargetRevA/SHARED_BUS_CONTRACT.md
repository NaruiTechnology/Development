# Glasgow shared ADC/DAC bus contract

This contract preserves the existing Glasgow applet behavior and the reference
parallel IC topology. The bus is 14 bits, LSB first in the Glasgow pin mapping
stored in `evidence/reference_audit.json`.

## Signals

| Signal | Direction at Glasgow | Reference board role |
| --- | --- | --- |
| `data[13:0]` | bidirectional | ADC D0-D13 read path and DAC D0-D13 write path |
| `adc_clk` | output | LTC2246H sample clock |
| `adc_le_clk` | output | ADC-side output-register control |
| `adc_oe` | output | ADC output-register enable; polarity follows the existing JSON |
| `dac_clk` | output | retained legacy DAC clock alias; reference design ties it to ADC clock |
| `dac_x_le_clk` | output | AD9744 X input-register/latch timing |
| `dac_y_le_clk` | output | AD9744 Y input-register/latch timing |
| `D-15` / ADC overflow | board diagnostic | routed to a test point and diagnostic location; not inserted into the current 14-bit payload |

## One pixel transaction

The existing `BusController` sequence is the timing authority:

```text
ADC_Wait -> ADC_Latch_Hold -> ADC_Enable -> ADC_Settle -> ADC_Capture
          -> ADC_Read -> Bus_Turnaround -> X_DAC_Write -> X_DAC_Write_2
          -> Y_DAC_Write -> Y_DAC_Write_2 -> ADC_Wait
```

During `ADC_Capture`, the ADC output register is enabled and the FPGA samples
the shared bus into `adc_sample`. During `Bus_Turnaround`, both board-side
drivers must be high impedance for a complete FPGA clock. During the X and Y
states, only the FPGA-to-DAC register path may drive the bus. No ADC register
output may remain enabled in either DAC state.

The applet latches the X/Y codes and `last` marker in `ADC_Read`, then pushes
the captured ADC sample through its configured `adcLatency` queue. The sample
emitted for a pixel therefore corresponds to the DAC pair latched in the same
transaction after the configured pipeline delay. A board change must not add an
unmodeled storage stage between the ADC output register and the shared bus.

## Electrical implementation rules

- U9 LTC2246H D0-D13 feed the ADC-side SN74ALVCH16374 register input.
- The ADC-side register output is the only external driver for `data[13:0]`
  during `ADC_Capture` and `ADC_Read`.
- DAC-side SN74ALVCH16374 registers are disabled during ADC states and drive
  only during their own DAC write states.
- Provide local default-disabled behavior so reset, unpowered Glasgow, or a
  disconnected cable cannot create a driven bus.
- ADC overflow is monitored independently at a test point and, if routed to an
  available diagnostic input, is sampled at the same ADC capture event.
- Keep `adc_clk` short and isolated from the analog input/reference. Keep the
  shared data bus short and series-damped at its source if signal integrity
  requires it.

## X/Y calibration association

The board outputs the logical 14-bit X/Y codes produced by the applet. A
calibration layer maps each logical code pair to world coordinates using
measured output voltage and microscope response. At minimum, store per-axis
zero, span, polarity, and rotation/cross-coupling terms. The calibration record
must identify board serial number, DAC settings, measurement instrument, load,
and firmware/configuration commit.
