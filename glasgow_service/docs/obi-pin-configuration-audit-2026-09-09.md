# OBI pin and configuration audit

**Follow-up:** the software corrections and validation are recorded in
[OBI pin alignment implemented](obi-pin-alignment-2026-09-09.md). The findings
below describe the state before those corrections.

Resumed the audit interrupted on September 8. The ADC/DAC bus mapping matches
OBI; the complete applet configuration does not. No physical wiring change,
voltage change, service restart, or FPGA download was made during this audit.

## Reference and scope

Compared the local OBI checkout at commit
`0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f`, specifically
`software/obi/applet/open_beam_interface/__init__.py` and the `fei_db.toml` and
`fib_200.toml` examples. [Pinned upstream source](https://github.com/nanographs/Open-Beam-Interface/blob/0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f/software/obi/applet/open_beam_interface/__init__.py).
Web retrieval failed; the comparison uses local source, not a claim about the
latest upstream revision. The checkout's modified frame-buffer files are outside
this audit.

Local paths below are relative to `Operations/Development`. Audited the scan
and ADC applets, both launchers, three `GlasgowDataIO/Json/streamData*.json`
variants, `microscope.toml`, and the vendored Glasgow resource, multiplexer and
demultiplexer implementations. Existing working-tree changes were preserved.

## Expansion bus: matching pins, directions and inversion

| Local signal | OBI signal | FPGA ball | OBI D label | Direction | Inverted at pad |
| --- | --- | --- | --- | --- | --- |
| `adc_clk` | `a_clock` | G1 | D24 | output | yes |
| `adc_le_clk` | `a_latch` | H2 | D22 | output | no |
| `adc_oe` | `a_enable` | G3 | D21 | output | yes |
| `dac_clk` | `d_clock` | F3 | D23 | output | yes |
| `dac_x_le_clk` | `x_latch` | H3 | D19 | output | no |
| `dac_y_le_clk` | `y_latch` | H1 | D20 | output | no |

Every data bit matches, in least-significant-bit-first order:

| Bit | FPGA ball | Bit | FPGA ball |
| --- | --- | --- | --- |
| 0 | B2 | 7 | D1 |
| 1 | C4 | 8 | F4 |
| 2 | B1 | 9 | G2 |
| 3 | C3 | 10 | E3 |
| 4 | C2 | 11 | F1 |
| 5 | C1 | 12 | E2 |
| 6 | D3 | 13 | F2 |

Both scan resource sets use `SB_LVCMOS33`; the data bus is bidirectional and
not inverted. Neither declares expansion-bus pull resistors or extra drive/
slew attributes. All 20 assigned balls are distinct and do not overlap the
vendored C3 platform resources for USB, clocks, I2C, LEDs, A/B I/O, or auxiliary
pins. This checks source constraints, not a routed image or board continuity.

Both scan implementations use an explicit bidirectional data buffer and apply
inversion at the control-buffer boundary. The former local `dir="o"` request
also inserted a buffer. Explicit buffers are not evidence of an electrical OE
repair. Timing and sample scaling differ as described in the
[data-path comparison](obi-data-path-comparison-2026-09-08.md).

## Missing and inactive configuration

| Area | Local behavior | OBI behavior / consequence |
| --- | --- | --- |
| Power-good | No K1 / D17 resource in the shipped stream pin configs | OBI declares `power_good` input, but does not buffer/read it; its proposed OE gating is commented out. Neither implementation establishes a working power-good interlock. Adding the declaration alone would not detect a missing board. |
| D18 / J1 | Unassigned | Also commented out in OBI. |
| Beam ports | `DataStreamApplet.build()` calls `iface.get_port_group()` with no keyword arguments, creating an empty group | OBI passes six named beam pin groups to its assembly. The local blanking/scan-enable logic therefore has no named physical ports in this build. |
| Launcher pin arguments | Flat `args.pins` list; no `port_spec` or named beam mapping | Vendored `DirectMultiplexer.claim_interface()` uses `port_spec` to populate A/B pins, and `get_port_group(**kwargs)` needs named arguments. A flat list alone does not route beam signals. |
| A/B voltage | Both launchers supply `voltage_map` | Vendored `DirectDemultiplexer.claim_interface()` reads `voltage`, `mirror_voltage`, or `keep_voltage`, not `voltage_map`. The supplied JSON voltage is not applied through this path. Actual hardware voltage is unverified. |
| Beam pulls | Neither launcher supplies requested beam pulls | OBI requests logical high pulls for configured beam pins. Pin inversion must be considered when translating this to physical pulls. Platform FPGA-side `PULLUP=1` on A/B resources is separate from connector-side configurable pulls. |
| Microscope config | No reader of `microscope.toml` found in the audited Python tree | Its pinout, transforms and timings are inactive for these launchers. |
| Axis transforms | CLI flags exist, but `DataStreamApplet.build()` does not pass transforms; subtarget receives `None` | OBI passes x/y flip and rotation values to its component. The local bus controller skips transforms when `None`. |
| Switch delay | CLI argument exists but is not forwarded; subtarget passes default 0 cycles to executor | OBI converts configured milliseconds to 48 MHz cycles. The local TOML's 20 ms is not applied; executor's own default does not rescue this because the subtarget explicitly passes 0. |
| Electron scan enable | Local gateware uses `ext_ctrl_enable` | OBI drives electron scan enable constantly 1. This difference is currently dormant because the local beam group is empty. |
| Blanking without external control | Local logic holds both beam blank signals at 1 | OBI sets both to 0 when external control is disabled. This is a behavioral difference requiring instrument-specific validation before wiring/enabling ports. |
| Beam selection flags | `enableEbeam` influences the service's default beam selection; `enableIbeam` has no Python consumer found | These flags do not instantiate physical beam ports. A software Ion selection is not proof of a physical enable output. |

The configured A/B voltage does not determine the voltage of the directly
assigned G3 expansion pad. Do not infer the reported OE voltage from the
ignored `voltage_map` alone.

## Config variants and instrument pinouts

- `streamData.json`: the matching six strobes and 14-bit bus; voltage 3.3;
  no `ports` list; no beam-role mapping; ADC half-period 6 and settling 2.
- `streamData_default.json`: same matching bus; voltage 2.5; same timing;
  no beam-role mapping. The voltage difference is currently inactive in this
  launcher path and must not be silently activated by a driver migration.
- `streamData unit_test.json`: six empty control pins, plus legacy `d_clock`
  at F3; the subtarget only connects recognized names such as `dac_clk`, so
  `d_clock` is requested without a control buffer. The real 14-bit bus is still
  assigned. The flat ports list A4..A7 and B0..B7 supplies no beam roles.
  This variant is not a production-equivalent pin configuration.

The local `microscope.toml` uses legacy numeric lists: electron scan enable
`[0,1]`, ion blank enable `[4,5]`, ion blank `[-2,3]`; it sets `yflip=true`,
`rotate90=true`, and 20 ms delay. Current OBI's FIB 200 example instead names
**ion** scan enable `A0:1`, blank enable `A4:4` (one pin), and blank `A2#,A3`;
it sets yflip but no rotate90. OBI's FEI DB example uses another mapping again.
These examples do not establish which wiring is present on this instrument.
The old negative-number syntax must not be interpreted as a verified modern
Glasgow pin inversion mapping without a migration and wiring check.

## ADC TEST

The ADC resource builder preserves G1/H2/G3 and their inversion, filters out
all DAC strobes, and forces the same 14 data balls to **input-only**. Its control
`platform.request(dir="o")` installs output buffers and preserves inversion.
That is electrically equivalent in buffer direction/polarity to an explicit
output buffer, not a missing-buffer bug.

ADC TEST intentionally has no scan-enable/blanking outputs and no DAC data
driver. It shares the launcher's ignored voltage-map issue but has separate
capture timing and serialization. Scan pin equivalence does not validate its
analog capture. No new physical ADC measurement was made here.

## Validation and next implementation boundary

Added `GlasgowDataIO/IobeamControl/unittest/applet/test_obiPinMapping.py` to check
the actual scan/ADC resource builders against the pinned OBI bus contract:
both shipped scan configs, every data bit, directions, inversion, attributes,
ADC-only isolation and platform pin collisions.

Run from `Operations/Development`:

```sh
rtk proxy ../.venv/bin/python -m unittest \
  GlasgowDataIO.IobeamControl.unittest.applet.test_obiPinMapping \
  GlasgowDataIO.IobeamControl.unittest.applet.test_physicalDataPath \
  GlasgowDataIO.IobeamControl.unittest.test_adc_launcher
```

Result: **7 tests passed**. The physical-data-path test covers 16 combinations
of VECTOR/RASTER, output mode and ADC value with backpressure. These are
software/digital checks; they do not certify analog levels. `git diff --check`
also passed for the existing tracked changes.

The bus already matches; no bus pin correction is warranted. Completing full
instrument alignment needs a confirmed beam connector pinout and voltage,
then explicit named-port/driver argument wiring, pull handling, and forwarding
of transforms/delay, with digital tests of blanking and switch sequencing.
Copying an OBI instrument example into active outputs would assume wiring not
established by this audit. Power-good monitoring would be an additional feature,
not an existing OBI behavior recovered by copying its declaration.
