# OBI pin/configuration alignment implemented

This follow-up addresses the software gaps in the
[pin audit](obi-pin-configuration-audit-2026-09-09.md). Changes are in the source
checkout; no service restart, FPGA download, or physical voltage change was
performed during this work.

## Voltage-map question

The current vendored `GlasgowHardwareTarget` and `DataStreamApplet` do not read
`args.voltage_map`. Before changing the implementation, real scan and ADC
build plans were generated both with and without that attribute:

| Original design | Image ID with map | Image ID without map |
| --- | --- | --- |
| Scan | `b48242c18728a8ac1eb8fd03b3aaa05a` | `b48242c18728a8ac1eb8fd03b3aaa05a` |
| ADC | `2905753d5619d5c933f6c6ebb1a5b63b` | `2905753d5619d5c933f6c6ebb1a5b63b` |

The new regression also compares every generated build file for equality with
and without the map. The final designs were fully synthesized, placed, routed
and packed without it. Removing **this unused attribute** therefore does not
break this build path. This does not imply a powered physical I/O interface
can work without its required supply. Glasgow's CLI also has required voltage
argument validation, which is distinct from the direct launcher's build path.

The obsolete map was removed from the scan launcher, ADC launcher and FPGA RAM
programming helper. Runtime supply configuration now uses `args.voltage` and
`args.port_spec`, which the vendored demultiplexer actually consumes. The scan
sets the configured voltage on its named beam ports (A for the current file);
ADC TEST sets the configured voltage on A/B while instantiating no beam or DAC
outputs. The active stream JSON retains 3.3 V and the default JSON retains
2.5 V; those values were not silently made equal.

## Implemented changes

- Both main stream JSON files explicitly reference `../../microscope.toml`,
  resolved relative to the JSON file, independent of process working directory.
  A missing configured file fails rather than silently dropping beam wiring.
- The instrument TOML was migrated to explicit strings, retaining its existing
  assignments: electron scan enable A0/A1, ion blank enable A4/A5, and ion
  blank A2 inverted / A3 normal. It retains y-flip, 90-degree rotation, and
  20 ms switch delay. No upstream example's different pinout was substituted.
- `scanConfiguration.py` translates these roles to the legacy multiplexer
  indices. It checks duplicate pins, range, pair width, transform types and
  delay bounds. B-only maps use B-relative indices, not global A/B indices.
- The scan applet creates the six named optional beam port groups, forwards
  transforms and the delay (960,000 cycles at 48 MHz), and forwards `out_only`.
  Undeclared roles stay unassigned; enableEbeam/enableIbeam are not physical
  pin maps. `enableEbeam` retains its existing service selection behavior.
- The target adapts the platform's already-reserved A/B ports instead of
  requesting them twice. Explicitly unused A/B output-enable pins are held
  disabled. This closes the real ResourceError found when wiring beam ports.
- Logical high pulls are applied before FIFO activation, translating inverted
  A2 to a physical pull-down. These are separate from FPGA pad pull-ups.
- Beam logic matches the referenced OBI truth table: electron scan enable is
  always logically asserted; ion scan and blank-enable follow external
  control; both beams release blanking when external control is disabled;
  while enabled, NoBeam blanks both and the unselected beam remains blanked.
- Every pad in a control pair receives the same logical enable. The old code
  split a two-bit internal field across pads and left the second pad low.
  Resource inversion supplies complementary physical levels where configured.
- K1/D17 is configured as an input in scan and ADC TEST. Its synchronized
  value is exported through the applet's `addr_power_good` register:
  bit 1 = input configured, bit 0 = sampled level. An unconfigured input, or
  ADC TEST's simulated input, reports zero. Launchers expose
  `iface.iobeam_power_good_addr`. This is
  diagnostic status, not an automatic beam or data-bus interlock; OBI's
  corresponding interlock code was commented out.
- The unit-test JSON's legacy `d_clock` spelling is corrected to `dac_clk`.
  Its other deliberately empty strobes still make it a test configuration,
  not an equivalent production wiring file.

## Validation

22 distinct targeted tests passed across pin/resource contracts, source JSON
resolution, build-file equality, runtime voltage/pull ordering, command-to-pad
beam logic and inverted pairs, delayed disable, synchronized power-good,
physical scan data flow, ADC-only behavior, ADC launcher startup and stepper
regressions. The scan data test includes 16 VECTOR/RASTER/output-mode/value
combinations with backpressure.

The initial stepper test invocation lacked its legacy `IobeamControl` import
path; rerunning with both Development and Development/GlasgowDataIO on
PYTHONPATH passed. Remaining warnings are Amaranth API deprecations.

Final offline FPGA build artifacts:

| Design | Image ID | Size | Post-route clock result |
| --- | --- | --- | --- |
| Scan | `e5c97aae103a65dbc103f4b91bf43a52` | 135,100 bytes | 76.91 MHz; passes 48 MHz |
| ADC TEST | `182c106326a4ba65a95a03a8d26cf679` | 135,100 bytes | 92.60 MHz; passes 48 MHz |

Builds and logs are in `/tmp/iobeam-pin-alignment-20260909/{scan,adc}`. No
hardware download was performed. The physical OE voltage/saturation diagnosis
still requires measurements; source and timing closure do not certify analog
levels or actual connector wiring. The previously documented raw14/OBI sample
scaling difference is outside this pin/configuration change.
