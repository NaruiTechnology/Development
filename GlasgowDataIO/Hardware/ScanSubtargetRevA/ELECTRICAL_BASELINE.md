# Rev-A electrical baseline

This baseline aligns the new package to the supplied reference design instead
of introducing a new converter family. Exact passive values and manufacturer
part numbers remain in `Open Beam Interface-bom.csv` and the editable KiCad
source under `board/`.

| Function | Reference device / network | Rev-A treatment |
| --- | --- | --- |
| Detector ADC | `U9 LTC2246HLX#PBF`, 14-bit, 25 MSPS, 48-pin LQFP | Retain; use its documented 1-2 Vpp differential input range and 3 V analog supply |
| ADC driver | `U10 AD8137YRZ` | Retain differential ADC-driver topology and reference common-mode network |
| ADC input conditioning | `LT1363`, clamp diode, input resistor/capacitor network | Retain population and test points; validate detector range against measured source impedance |
| ADC output register | `SN74ALVCH16374DGGR` | Retain shared-bus register and OE control; verify both halves against the selected datasheet |
| X/Y DACs | `U7/U8 AD9744ARUZ`, 14-bit current-output DACs | Retain two-device architecture and individual X/Y latch strobes |
| X/Y output drivers | `U11/U12 THS4151` | Retain differential driver/output-conditioning topology |
| DAC input registers | `U4/U5/U6 SN74ALVCH16374DGGR` | Retain shared-bus write register population and `S.WRITE_A`/latch timing |
| Controller | Glasgow Interface Explorer rev C3 | Sole digital controller; use existing applet resource pins and polarity |
| Glasgow logic rail | +3.3 V | Retain connector supply arrangement; verify source/load before assembly |
| Analog rails | +3 V, +5 V, +/-14 V, +/-15 V as populated in reference | Retain reference power partition; verify external supply tolerance and sequencing |
| Digital interconnect | Glasgow 2x22 1.27 mm and 2x10 2.54 mm adapter path | Retain existing pin order and LSB-first data mapping |
| Detector/output connectors | M8 detector connector and BNC X/Y outputs | Retain reference footprints and shield/chassis treatment |

## XY calibration

The electrical board produces the same logical code domain expected by the
applet. The world-system calibration is a separate per-board record:

```text
Vx = offset_x + gain_x * f(code_x, code_y)
Vy = offset_y + gain_y * f(code_x, code_y)

world = origin + scale * R(rotation) * [Vx, Vy]
```

`f` may include measured axis cross-coupling. The final calibration procedure
must measure the actual BNC output under the real load, fit the coefficients, and
store them with the board serial number and applet/configuration commit. The
board does not infer microscope travel from ADC data.

## Shared-bus correction targets

The old board's visible production failure is handled at the board review level
by these explicit checks:

- verify U9 D0-D13 to the ADC-side register inputs and register outputs to the
  Glasgow data bus with a netlist and continuity check;
- verify `adc_oe` disables the ADC-side bus driver before the FPGA drives DAC
  data;
- maintain one complete high-impedance turnaround cycle;
- expose U9 overflow and both bus OEs at test points;
- verify U9 MODE coding and U9 CLK polarity against the actual assembly;
- run ground, midscale, and near-full-scale ADC inputs before connecting the
  detector; and
- correlate captured words to the XY DAC pixel sequence using the existing
  `adcLatency` setting.
